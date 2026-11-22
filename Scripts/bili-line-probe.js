/*
 * BiliBili Accelerator for Loon — 线路探测脚本
 * ------------------------------------------------------------------
 * 类型：Cron Script（定时执行，不进播放链路，因此可以放心发请求）
 *
 * 职责：
 *   1. 从远端同步 B 站媒体 CDN host 清单（GitHub Actions 每天从上游仓库重建）。
 *   2. 拿改写脚本顺手记录下来的真实媒体地址样本，逐条线路实测吞吐。
 *   3. 把最优线路写入持久化存储，供 bili-playurl-rewrite.js 直接读取。
 *
 * 之所以单独拆一个 Cron 脚本：Response Script 的默认超时只有 20 秒且卡在播放请求上，
 * 在那里测速会直接拖慢起播。上游用户脚本是在页面里异步测速的，这里等价地搬到定时任务里。
 */

(function () {
  "use strict";

  var STORE_HOSTS = "biliAccel.hosts";
  var STORE_HOSTS_TS = "biliAccel.hostsTs";
  var STORE_BEST = "biliAccel.best";
  var STORE_BEST_TS = "biliAccel.bestTs";
  var STORE_SAMPLE = "biliAccel.samples";
  var STORE_REPORT = "biliAccel.report";

  var HOSTS_TTL = 12 * 60 * 60 * 1000;
  var SAMPLE_TTL = 12 * 60 * 60 * 1000;
  var PER_HOST_TIMEOUT = 5000;
  var RANGE_BYTES = 262144; // 256KB 足够区分线路快慢
  var MAX_HOSTS = 6;

  var arg = (typeof $argument === "object" && $argument) ? $argument : {};
  var rulesetUrl = String(arg.ruleset_url || "").trim();
  var probeNode = String(arg.probe_node || "").trim();
  var wantNotify = arg.probe_notify === true || String(arg.probe_notify).toLowerCase() === "true";
  var debug = arg.probe_debug === true || String(arg.probe_debug).toLowerCase() === "true";

  function read(key) {
    try {
      return $persistentStore.read(key) || "";
    } catch (e) {
      return "";
    }
  }

  function save(key, value) {
    try {
      $persistentStore.write(value, key);
    } catch (e) {}
  }

  function log(obj) {
    if (debug) console.log(obj);
  }

  function httpGet(options, callback) {
    if (probeNode) options.node = probeNode;
    $httpClient.get(options, function (error, response, data) {
      var result = {
        ok: !error && response && response.status >= 200 && response.status < 400,
        status: response ? response.status : 0,
        bytes: data ? data.length : 0,
        text: typeof data === "string" ? data : "",
        error: error ? String(error) : ""
      };
      callback(result);
    });
  }

  // ---------------------------------------------------------- 1. 同步线路清单

  function syncHosts(done) {
    var cachedTs = parseInt(read(STORE_HOSTS_TS), 10) || 0;
    if (!rulesetUrl || (cachedTs && Date.now() - cachedTs < HOSTS_TTL)) {
      return done("cached");
    }
    httpGet({ url: rulesetUrl, timeout: 8000 }, function (r) {
      if (!r.ok) {
        log({ step: "syncHosts", result: "failed", status: r.status, error: r.error });
        return done("failed:" + (r.error || r.status));
      }
      var json = null;
      try {
        json = JSON.parse(r.text || "");
      } catch (e) {
        json = null;
      }
      var list = json && (json.mediaHosts || json.hosts);
      if (!Array.isArray(list) || !list.length) {
        log({ step: "syncHosts", result: "bad payload", type: typeof list });
        return done("bad payload");
      }
      save(STORE_HOSTS, JSON.stringify({ mediaHosts: list.slice(0, 200) }));
      save(STORE_HOSTS_TS, String(Date.now()));
      done("ok:" + list.length);
    });
  }

  // ---------------------------------------------------------- 2. 逐线路测速

  function probeOne(item, next) {
    var started = Date.now();
    var url = "https://" + item.host + (item.path || "/");
    httpGet({
      url: url,
      timeout: PER_HOST_TIMEOUT,
      headers: {
        "Range": "bytes=0-" + (RANGE_BYTES - 1),
        "Referer": "https://www.bilibili.com/",
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148"
      },
      "auto-redirect": false
    }, function (r) {
      var elapsed = Date.now() - started;
      var entry = { host: item.host, elapsedMs: elapsed, bytes: r.bytes, status: r.status };

      // 签名过期或被 CDN 拒绝：退化为纯 RTT 探测，至少能量出线路延迟。
      var signatureExpired = r.status === 403 || r.status === 404 || r.status === 453;
      if (!r.ok && !signatureExpired) {
        entry.error = r.error || "http " + r.status;
        entry.score = -1;
        return next(entry);
      }
      if (r.bytes > 0 && elapsed > 0) {
        entry.mode = "throughput";
        entry.kbps = Math.round((r.bytes * 8) / (elapsed / 1000) / 1024);
        entry.score = entry.kbps;
      } else {
        entry.mode = "rtt";
        entry.score = 1000 / Math.max(elapsed, 1); // 延迟越低分越高
      }
      next(entry);
    });
  }

  function probeAll(samples, done) {
    var results = [];
    var index = 0;
    function step() {
      if (index >= samples.length) return done(results);
      var item = samples[index++];
      probeOne(item, function (entry) {
        results.push(entry);
        setTimeout(step, 120);
      });
    }
    step();
  }

  // ---------------------------------------------------------- 3. 汇总与落库

  function pickBest(results) {
    var ranked = results.slice().sort(function (a, b) {
      if (a.score < 0 && b.score >= 0) return 1;
      if (b.score < 0 && a.score >= 0) return -1;
      return b.score - a.score;
    });
    return ranked.length && ranked[0].score > 0 ? ranked[0] : null;
  }

  function notify(best, results) {
    var last = read(STORE_REPORT);
    var fingerprint = best.host + "|" + best.mode + "|" + Math.round(best.score / 10);
    if (last === fingerprint) return;
    save(STORE_REPORT, fingerprint);
    var lines = [];
    for (var i = 0; i < results.length && i < 6; i++) {
      var r = results[i];
      lines.push(r.host + " → " + (r.error ? r.error : (r.mode === "throughput" ? r.kbps + " kbps" : r.elapsedMs + " ms")));
    }
    $notification.post("B站线路探测", "最优：" + best.host, lines.join("\n"));
  }

  function finish(reason, extra) {
    if (extra) log({ step: "done", reason: reason, extra: extra });
    else log({ step: "done", reason: reason });
    $done({});
  }

  function run() {
    syncHosts(function (syncResult) {
      var raw = read(STORE_SAMPLE);
      if (!raw) return finish("no sample yet");
      var payload = null;
      try {
        payload = JSON.parse(raw);
      } catch (e) {
        return finish("sample unreadable");
      }
      if (!payload || !payload.items || !payload.items.length) return finish("sample empty");
      if (!payload.ts || Date.now() - payload.ts > SAMPLE_TTL) return finish("sample stale");

      var seen = {};
      var samples = [];
      for (var i = 0; i < payload.items.length; i++) {
        var item = payload.items[i];
        if (!item || !item.host || seen[item.host]) continue;
        seen[item.host] = true;
        samples.push(item);
        if (samples.length >= MAX_HOSTS) break;
      }
      if (!samples.length) return finish("no candidate");

      probeAll(samples, function (results) {
        var best = pickBest(results);
        if (!best) {
          log({ step: "probe", result: "all failed", detail: results });
          return finish("all failed");
        }
        save(STORE_BEST, best.host);
        save(STORE_BEST_TS, String(Date.now()));
        if (wantNotify) notify(best, results);
        finish("ok", { best: best.host, sync: syncResult, detail: results });
      });
    });
  }

  try {
    run();
  } catch (err) {
    console.log({ tag: "biliAccel.probe", error: String(err && err.message || err) });
    $done({});
  }
})();
