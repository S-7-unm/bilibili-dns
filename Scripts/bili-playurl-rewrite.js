/*
 * BiliBili Accelerator for Loon — playurl 改写脚本
 * ------------------------------------------------------------------
 * 类型：Response Script（需开启 MitM，且规则带 requires_body=true）
 * 原理：与上游 bilibili-accelerator 用户脚本同思路 —— 在播放器开始缓冲之前，
 *       把播放接口 JSON 响应里的媒体地址换成另一条可用线路。
 *       区别只在于执行位置：上游在页面里劫持 JSON.parse，本脚本在代理层改写响应体。
 *
 * 设计约束：
 *   1. 只替换 URL 的 host 部分，path 与 query（含签名参数）原样保留。
 *   2. 源 host 必须命中 B 站自有媒体 CDN 白名单，否则一律不动。
 *   3. 任何解析异常一律原样放行，绝不因为加速逻辑把播放搞挂。
 *   4. 不在本脚本内发起任何网络请求；远端线路清单与测速结果由 bili-line-probe.js
 *      （Cron 脚本）写入持久化存储，本脚本只读缓存，保证零额外延迟。
 *
 * $argument 由插件 [Argument] 注入：
 *   rewrite_mode : "backup" | "probe" | "fixed" | "off"
 *   prefer_host  : 固定线路 host（rewrite_mode=fixed 时生效）
 *   rewrite_debug: 是否输出诊断日志
 */

(function () {
  "use strict";

  var ORIGINAL_BODY = ($response && typeof $response.body === "string") ? $response.body : "";

  // ---------------------------------------------------------------- 常量

  // B 站自有「媒体」CDN 后缀。只有落在这里的 host 才会被改写。
  // 域名族取自 blackmatrix7/ios_rule_script 的 BiliBili 规则集（2025-06-06 版），
  // 刻意排除 hdslb / bilibili.com 这类页面与静态资源域，避免误伤封面图和接口。
  var MEDIA_CDN_SUFFIXES = [
    "bilivideo.com",
    "bilivideo.cn",
    "bilivideo.net",
    "acgvideo.com",
    "ourdvsss.com",
    "ksyungslb.com",
    "smtcdns.net",
    "smtcdns.com",
    "mincdn.com",
    "maoercdn.com",
    "yfcdn.net",
    "bilicdn1.com",
    "bilicdn2.com",
    "bilicdn3.com",
    "bilicdn4.com",
    "bilicdn5.com",
    "akamaized.net",
    "bstarstatic.com",
    "00cdn.com"
  ];

  // akamaized.net 是共享大域，只有 upos 前缀的才是 B 站播放线路，单独收紧。
  var RESTRICTED_SUFFIX_HOST_PREFIX = {
    "akamaized.net": ["upos-", "p-bstarstatic", "upos-bstar"],
    "bstarstatic.com": ["p.bstarstatic.com", "p-bstarstatic"]
  };

  // 播放接口里承载媒体地址的字段名（大小写与下划线两种风格都覆盖）。
  var URL_KEYS = {
    url: true,
    backup_url: true,
    base_url: true,
    baseUrl: true,
    backupUrl: true,
    backup_urls: true,
    current_url: true,
    curr_url: true,
    cdm_src_url: false // 加密流地址不参与改写
  };

  var STORE_HOSTS = "biliAccel.hosts";
  var STORE_HOSTS_TS = "biliAccel.hostsTs";
  var STORE_BEST = "biliAccel.best";
  var STORE_BEST_TS = "biliAccel.bestTs";
  var STORE_SAMPLE = "biliAccel.samples";

  var HOSTS_TTL = 12 * 60 * 60 * 1000; // 远端线路清单缓存 12 小时
  var BEST_TTL = 3 * 60 * 60 * 1000; // 测速结果 3 小时内有效
  var SAMPLE_TTL = 12 * 60 * 60 * 1000;

  // ---------------------------------------------------------------- 工具

  function readStore(key) {
    try {
      return $persistentStore.read(key) || "";
    } catch (e) {
      return "";
    }
  }

  function writeStore(key, value) {
    try {
      $persistentStore.write(value, key);
    } catch (e) {
      /* 存储不可用时静默降级 */
    }
  }

  function parseJson(text) {
    try {
      return JSON.parse(text);
    } catch (e) {
      return null;
    }
  }

  // 必须用 Array.isArray：B 站 durl 分段对象自带 length 字段（该段时长，单位毫秒），
  // 任何基于 .length 的鸭子类型判断都会把它错认成数组，导致整个播放地址被漏读。
  function isArr(value) {
    return Array.isArray(value);
  }

  // Loon 脚本沙箱不保证有 URL 构造器，手工解析。
  function splitUrl(raw) {
    if (typeof raw !== "string") return null;
    var m = raw.match(/^(https?):\/\/([^/?#]+)([^]*)$/i);
    if (!m) return null;
    var hostport = m[2].toLowerCase();
    var host = hostport;
    var port = "";
    var ci = hostport.lastIndexOf(":");
    if (ci > 0 && hostport.indexOf("]") < ci) {
      host = hostport.slice(0, ci);
      port = hostport.slice(ci);
    }
    return { scheme: m[1].toLowerCase(), host: host, rest: m[3] || "/" };
  }

  function endsWith(host, suffix) {
    return host === suffix || host.length > suffix.length &&
      host.slice(host.length - suffix.length - 1) === "." + suffix;
  }

  function isMediaCdnHost(host, suffixes) {
    var list = suffixes || MEDIA_CDN_SUFFIXES;
    if (!host) return false;
    for (var i = 0; i < list.length; i++) {
      var suffix = list[i];
      if (!endsWith(host, suffix)) continue;
      var prefix = RESTRICTED_SUFFIX_HOST_PREFIX[suffix];
      if (prefix) {
        for (var j = 0; j < prefix.length; j++) {
          if (host.indexOf(prefix[j]) === 0) return true;
        }
        continue;
      }
      return true;
    }
    return false;
  }

  function mergeExtraHosts() {
    // 远端清单（由 probe 脚本同步）只用于放宽白名单，不用于生成目标地址。
    var extra = parseJson(readStore(STORE_HOSTS));
    var remote = extra && (extra.mediaHosts || extra.hosts);
    if (!remote || !remote.length) return MEDIA_CDN_SUFFIXES;
    var ts = parseInt(readStore(STORE_HOSTS_TS), 10) || 0;
    if (!ts || Date.now() - ts > HOSTS_TTL) return MEDIA_CDN_SUFFIXES;
    var list = MEDIA_CDN_SUFFIXES.slice();
    for (var i = 0; i < remote.length; i++) {
      var h = String(remote[i] || "").toLowerCase();
      // 只接受带点的完整 host 或二级域后缀，拒绝奇怪的单段值。
      if (h.indexOf(".") > 0 && h.length < 120 && list.indexOf(h) < 0) list.push(h);
    }
    return list;
  }

  // ---------------------------------------------------------------- 收集与改写

  var mediaSuffixes = MEDIA_CDN_SUFFIXES;

  function collectTargets(node, out, depth) {
    if (!node || depth > 12) return;
    if (isArr(node)) {
      for (var i = 0; i < node.length; i++) collectTargets(node[i], out, depth + 1);
      return;
    }
    if (typeof node !== "object") return;
    for (var key in node) {
      if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
      var val = node[key];
      if (!URL_KEYS[key]) {
        if (typeof val === "object") collectTargets(val, out, depth + 1);
        continue;
      }
      if (typeof val === "string") {
        var parts = splitUrl(val);
        if (parts && isMediaCdnHost(parts.host, mediaSuffixes)) {
          out.push({ holder: node, key: key, parts: parts });
        }
      } else if (isArr(val)) {
        for (var k = 0; k < val.length; k++) {
          var p = splitUrl(val[k]);
          if (p && isMediaCdnHost(p.host, mediaSuffixes)) {
            out.push({ holder: val, key: k, parts: p });
          }
        }
      }
    }
  }

  function countHosts(targets) {
    var tally = {};
    for (var i = 0; i < targets.length; i++) {
      var h = targets[i].parts.host;
      tally[h] = (tally[h] || 0) + 1;
    }
    return tally;
  }

  function pickBackupHost(targets, tally) {
    var primary = null;
    var max = -1;
    for (var h in tally) {
      if (tally[h] > max) {
        max = tally[h];
        primary = h;
      }
    }
    for (var i = 0; i < targets.length; i++) {
      var cand = targets[i].parts.host;
      // backup 地址本身通常只出现一两次，正好是官方给出的另一条线路。
      if (cand !== primary && tally[cand] <= 3) return cand;
    }
    return "";
  }

  function readBestHost() {
    var ts = parseInt(readStore(STORE_BEST_TS), 10) || 0;
    if (!ts || Date.now() - ts > BEST_TTL) return "";
    var host = String(readStore(STORE_BEST) || "").toLowerCase();
    return host && isMediaCdnHost(host, mediaSuffixes) ? host : "";
  }

  function saveSamples(targets) {
    var tally = countHosts(targets);
    var samples = [];
    var seen = {};
    for (var i = 0; i < targets.length; i++) {
      var parts = targets[i].parts;
      if (seen[parts.host]) continue;
      seen[parts.host] = true;
      // 截断 query，只留够定位文件的路径，避免把长签名整段写进存储。
      samples.push({ host: parts.host, path: parts.rest.slice(0, 180) });
    }
    writeStore(STORE_SAMPLE, JSON.stringify({ ts: Date.now(), items: samples, hosts: Object.keys(tally) }));
  }

  function resolveArguments() {
    var a = (typeof $argument === "object" && $argument) ? $argument : {};
    var mode = String(a.rewrite_mode || "backup").toLowerCase();
    if (["backup", "probe", "fixed", "off"].indexOf(mode) < 0) mode = "backup";
    return {
      mode: mode,
      preferHost: String(a.prefer_host || "").trim().toLowerCase(),
      debug: a.rewrite_debug === true || String(a.rewrite_debug).toLowerCase() === "true"
    };
  }

  // ---------------------------------------------------------------- 主流程

  function finish(body, headers) {
    var out = { body: body };
    if (headers) out.headers = headers;
    $done(out);
  }

  function main() {
    var cfg = resolveArguments();

    if (cfg.mode === "off") return finish(ORIGINAL_BODY);
    if (!ORIGINAL_BODY || ORIGINAL_BODY.length > 3000000) return finish(ORIGINAL_BODY);

    var json = parseJson(ORIGINAL_BODY);
    if (!json || typeof json !== "object") return finish(ORIGINAL_BODY);
    // 接口报错、付费试看、地区限制等场景不做改写，交回给播放器原始响应。
    if (json.code && json.code !== 0) return finish(ORIGINAL_BODY);

    mediaSuffixes = mergeExtraHosts();

    var targets = [];
    collectTargets(json.data || json.result || json, targets, 0);
    if (!targets.length) return finish(ORIGINAL_BODY);

    var tally = countHosts(targets);
    var current = Object.keys(tally);
    var target = "";

    if (cfg.mode === "fixed") {
      if (isMediaCdnHost(cfg.preferHost, mediaSuffixes)) target = cfg.preferHost;
    } else if (cfg.mode === "probe") {
      target = readBestHost();
      if (!target) target = pickBackupHost(targets, tally);
    } else {
      target = pickBackupHost(targets, tally);
    }

    // 目标线路缺失，或本来就只有一条线路可选 —— 保持原样。
    if (!target || (current.length === 1 && current[0] === target)) {
      if (cfg.debug) console.log({ tag: "biliAccel", result: "skip", hosts: current });
      return finish(ORIGINAL_BODY);
    }

    saveSamples(targets);

    var changed = 0;
    for (var i = 0; i < targets.length; i++) {
      var t = targets[i];
      if (t.parts.host === target) continue;
      t.holder[t.key] = t.parts.scheme + "://" + target + t.parts.rest;
      changed++;
    }
    if (!changed) return finish(ORIGINAL_BODY);

    if (cfg.debug) {
      console.log({
        tag: "biliAccel",
        mode: cfg.mode,
        from: tally,
        to: target,
        rewritten: changed,
        url: ($request && $request.url ? $request.url.split("?")[0] : "")
      });
    }

    var headers = null;
    if ($response && $response.headers) {
      headers = {};
      for (var k in $response.headers) {
        if (!Object.prototype.hasOwnProperty.call($response.headers, k)) continue;
        if (k.toLowerCase() === "content-length" || k.toLowerCase() === "content-encoding") continue;
        headers[k] = $response.headers[k];
      }
    }

    var newBody = "";
    try {
      newBody = JSON.stringify(json);
    } catch (e) {
      return finish(ORIGINAL_BODY);
    }
    finish(newBody, headers);
  }

  try {
    main();
  } catch (err) {
    console.log({ tag: "biliAccel", error: String(err && err.message || err) });
    finish(ORIGINAL_BODY);
  }
})();
