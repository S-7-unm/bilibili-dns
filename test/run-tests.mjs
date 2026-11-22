#!/usr/bin/env node
/*
 * 本地回归测试：用 mock 的 Loon 脚本运行时跑一遍两个脚本。
 * 真机上跑不了，所以在这里把 Loon 提供的全局对象仿真出来，
 * 覆盖：dash / durl / 直播结构、非媒体域名、接口报错、四种模式、探测择优。
 *   node test/run-tests.mjs
 */

import vm from "node:vm";
import { readFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ✓", name);
  } catch (err) {
    failures.push(name + " → " + err.message);
    console.log("  ✗", name, "\n     ", err.message);
  }
}

function makeStore(initial = {}) {
  const data = { ...initial };
  return {
    data,
    read: (k) => (data[k] === undefined ? "" : data[k]),
    write: (v, k) => {
      const key = k || "_default";
      if (v === undefined || v === null) delete data[key];
      else data[key] = String(v);
      return true;
    }
  };
}

// Loon 沙箱里 setTimeout 是宏任务；同步退出分支不会触发任何定时器，
// 因此用微任务让出即可覆盖 syncHosts 走 cached 的路径。
function waitTurn() {
  return new Promise((resolve) => Promise.resolve().then(resolve));
}

// 延时统一按 1% 缩放：保留线路间快慢差异，同时避免测试真等十几秒。
const scaled = (ms) => Math.max(1, Math.round((ms || 0) / 100));

function hostOf(url) {
  const m = /^https?:\/\/([^/]+)/i.exec(url);
  return m ? m[1] : "";
}
function queryOf(url) {
  const i = url.indexOf("?");
  return i < 0 ? "" : url.slice(i);
}

// ---------------------------------------------------------------- 改写脚本

async function runRewrite({ body, status = 200, contentType = "application/json", argument = {}, store = {} }) {
  const source = await readFile(path.join(ROOT, "Scripts", "bili-playurl-rewrite.js"), "utf8");
  const storeObj = makeStore(store);
  const logs = [];
  let done = null;
  const sandbox = {
    console: { log: (v) => logs.push(v) },
    setTimeout: (fn) => fn(),
    setInterval: () => {},
    Date,
    $argument: argument,
    $request: { url: "https://api.bilibili.com/x/player/wbi/playurl?bvid=BV1xx&cid=1", method: "GET", headers: {} },
    $response: { status, headers: { "Content-Type": contentType, "Content-Length": String(body.length) }, body },
    $persistentStore: storeObj,
    $done: (out) => { done = out; }
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { timeout: 5000, filename: "bili-playurl-rewrite.js" });
  assert.ok(done, "脚本没有调用 $done()");
  return { body: done.body, headers: done.headers, logs, store: storeObj.data };
}

const DASH_BODY = JSON.stringify({
  code: 0, message: "0", ttl: 1,
  data: {
    quality: 80,
    cover: "https://i0.hdslb.com/bfs/cover/keepme.jpg",
    support_formats: [{ format_name: "1080P", url: "https://example.com/not-media" }],
    dash: {
      duration: 600,
      video: [{
        id: 32,
        baseUrl: "https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/11/22/999/999-1-30080.m4s?e=ig8eux&t=trial&us=pogenoa&mid=7&upsig=abc123",
        backupUrl: [
          "https://upos-sz-mirrorali.bilivideo.com/upgcxcode/11/22/999/999-1-30080.m4s?us=pogenoa&upsig=abc123",
          "https://upos-sz-mirrorbos.bilivideo.com/upgcxcode/11/22/999/999-1-30080.m4s?us=pogenoa"
        ]
      }],
      audio: [{
        id: 30280,
        baseUrl: "https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/11/22/999/999-1-30280.m4s?us=pogenoa&upsig=abc123",
        backupUrl: ["https://upos-sz-mirrorali.bilivideo.com/upgcxcode/11/22/999/999-1-30280.m4s?us=pogenoa"]
      }]
    }
  }
});

const DURL_BODY = JSON.stringify({
  code: 0,
  data: {
    is_preview: false,
    durl: [
      { order: 1, length: 300000, size: 9000, url: "https://upos-hz-mirrorakam.akamaized.net/upgcxcode/a/b/1/1-1.mp4?sign=zz&tail=50", backup_url: ["https://upos-sz-mirrorali.bilivideo.com/upgcxcode/a/b/1/1-1.mp4?sign=zz"] },
      { order: 2, length: 300000, size: 9000, url: "https://upos-hz-mirrorakam.akamaized.net/upgcxcode/a/b/1/1-2.mp4?sign=zz&tail=100", backup_url: ["https://upos-sz-mirrorali.bilivideo.com/upgcxcode/a/b/1/1-2.mp4?sign=zz"] }
    ]
  }
});

const LIVE_BODY = JSON.stringify({
  code: 0,
  data: {
    playurl_info: {
      playurl: {
        format: [{
          format_name: "高清",
          codec: [{
            codec_name: "av1",
            base_url: "https://d1--gecc-dua.bilivideo.com/live-bvc/111/stream_999_1.av1.flv?txId=429&suite=av1",
            backup_url: ["https://d2--gecc-dua.bilivideo.com/live-bvc/111/stream_999_1.av1.flv?txId=429"]
          }]
        }]
      }
    }
  }
});

async function testRewrite() {
  console.log("\n[bili-playurl-rewrite.js]");

  const backup = await runRewrite({ body: DASH_BODY, argument: { rewrite_mode: "backup", rewrite_debug: true } });
  const out = JSON.parse(backup.body);
  check("dash 模式 backup：baseUrl 切到备用线路", () =>
    assert.equal(hostOf(out.data.dash.video[0].baseUrl), "upos-sz-mirrorali.bilivideo.com"));
  check("dash 模式 backup：音频同步切线，避免音画分离", () =>
    assert.equal(hostOf(out.data.dash.audio[0].baseUrl), "upos-sz-mirrorali.bilivideo.com"));
  check("签名参数原样保留", () =>
    assert.ok(queryOf(out.data.dash.video[0].baseUrl).includes("upsig=abc123")));
  check("path 原样保留", () =>
    assert.ok(out.data.dash.video[0].baseUrl.includes("/upgcxcode/11/22/999/999-1-30080.m4s")));
  check("非媒体域名（example.com）不动", () =>
    assert.equal(out.data.support_formats[0].url, "https://example.com/not-media"));
  check("封面图 hdslb 不动", () =>
    assert.equal(out.data.cover, "https://i0.hdslb.com/bfs/cover/keepme.jpg"));
  check("写入测速样本供 Cron 脚本使用", () =>
    assert.ok(backup.store["biliAccel.samples"] && JSON.parse(backup.store["biliAccel.samples"]).items.length >= 2));
  check("去掉 Content-Length 避免长度不匹配", () =>
    assert.ok(backup.headers && backup.headers["Content-Length"] === undefined));
  check("Content-Type 保留", () =>
    assert.equal(backup.headers["Content-Type"], "application/json"));

  const durl = await runRewrite({ body: DURL_BODY, argument: { rewrite_mode: "backup" } });
  const d = JSON.parse(durl.body);
  check("durl 多段统一切到同一条线路", () => {
    const hosts = d.data.durl.map((s) => hostOf(s.url));
    assert.equal(new Set(hosts).size, 1);
    assert.equal(hosts[0], "upos-sz-mirrorali.bilivideo.com");
  });
  check("durl 的 tail 参数保留", () =>
    assert.ok(d.data.durl[1].url.includes("tail=100")));

  const live = await runRewrite({ body: LIVE_BODY, argument: { rewrite_mode: "backup" } });
  const lv = JSON.parse(live.body);
  check("直播 getRoomPlayInfo 的 base_url 可改写", () =>
    assert.equal(hostOf(lv.data.playurl_info.playurl.format[0].codec[0].base_url), "d2--gecc-dua.bilivideo.com"));

  const fixed = await runRewrite({
    body: DASH_BODY,
    argument: { rewrite_mode: "fixed", prefer_host: "upos-sz-mirror08c.bilivideo.com" }
  });
  check("fixed 模式按用户指定 host", () =>
    assert.equal(hostOf(JSON.parse(fixed.body).data.dash.video[0].baseUrl), "upos-sz-mirror08c.bilivideo.com"));

  const evil = await runRewrite({
    body: DASH_BODY,
    argument: { rewrite_mode: "fixed", prefer_host: "evil.example.com" }
  });
  check("fixed 模式拒绝白名单外的 host", () => assert.equal(evil.body, DASH_BODY));

  const probe = await runRewrite({
    body: DASH_BODY,
    argument: { rewrite_mode: "probe" },
    store: {
      "biliAccel.best": "upos-sz-mirrorbos.bilivideo.com",
      "biliAccel.bestTs": String(Date.now() - 1000)
    }
  });
  check("probe 模式采用探测结果", () =>
    assert.equal(hostOf(JSON.parse(probe.body).data.dash.video[0].baseUrl), "upos-sz-mirrorbos.bilivideo.com"));

  const stale = await runRewrite({
    body: DASH_BODY,
    argument: { rewrite_mode: "probe" },
    store: {
      "biliAccel.best": "upos-sz-mirrorbos.bilivideo.com",
      "biliAccel.bestTs": String(Date.now() - 8 * 60 * 60 * 1000)
    }
  });
  check("探测结果过期后退回 backup，不用陈旧数据", () =>
    assert.equal(hostOf(JSON.parse(stale.body).data.dash.video[0].baseUrl), "upos-sz-mirrorali.bilivideo.com"));

  const off = await runRewrite({ body: DASH_BODY, argument: { rewrite_mode: "off" } });
  check("off 模式完全不改写", () => assert.equal(off.body, DASH_BODY));

  const err = await runRewrite({ body: JSON.stringify({ code: -403, message: "请求过于频繁" }), argument: {} });
  check("接口返回错误码时原样放行", () => assert.equal(err.body, JSON.stringify({ code: -403, message: "请求过于频繁" })));

  const html = await runRewrite({ body: "<html>not json</html>", argument: {} });
  check("非 JSON 响应原样放行", () => assert.equal(html.body, "<html>not json</html>"));

  const onlyOne = await runRewrite({
    body: JSON.stringify({ code: 0, data: { durl: [{ url: "https://upos-sz-mirrorcos.bilivideo.com/x.mp4?sign=1" }] } }),
    argument: { rewrite_mode: "backup" }
  });
  check("响应里只有一条线路时不乱改", () => assert.ok(onlyOne.body.includes("upos-sz-mirrorcos.bilivideo.com")));

  const badHost = await runRewrite({
    body: JSON.stringify({ code: 0, data: { durl: [{ url: "https://cdn.thirdparty.test/v.mp4?a=1", backup_url: ["https://evil.test/v.mp4"] }] } }),
    argument: { rewrite_mode: "backup" }
  });
  check("第三方域名一律不动", () => assert.ok(badHost.body.includes("cdn.thirdparty.test")));

  const defaults = await runRewrite({ body: DASH_BODY, argument: {} });
  check("参数缺省时按 backup 运行", () =>
    assert.equal(hostOf(JSON.parse(defaults.body).data.dash.video[0].baseUrl), "upos-sz-mirrorali.bilivideo.com"));
}

// ---------------------------------------------------------------- 探测脚本

async function runProbe({ argument, store, probeResults }) {
  const source = await readFile(path.join(ROOT, "Scripts", "bili-line-probe.js"), "utf8");
  const storeObj = makeStore(store);
  const logs = [];
  const notifications = [];
  let done = null;
  let finished = null;
  const settled = new Promise((resolve) => { finished = resolve; });
  const sandbox = {
    console: { log: (v) => logs.push(v) },
    // 真实延时按 1% 缩放，既保留线路间的快慢差异，又不用真等几秒。
    setTimeout: (fn, ms) => setTimeout(fn, scaled(ms)),
    setInterval: (fn) => setTimeout(fn, 5),
    clearTimeout,
    $argument: argument,
    $persistentStore: storeObj,
    $notification: { post: (t, s, c) => notifications.push({ title: t, subtitle: s, content: c }) },
    $httpClient: {
      get(options, cb) {
        setTimeout(() => {
          if (String(options.url).endsWith("cdn-hosts.json")) {
            cb(null, { status: 200 }, JSON.stringify({ schema: 1, mediaHosts: ["upos-sz-mirror08c.bilivideo.com", "upos-sz-mirrorzyy.bilivideo.com"] }));
            return;
          }
          const host = hostOf(options.url);
          const preset = probeResults[host] || { bytes: 4096, ms: 400 };
          setTimeout(() => cb(null, { status: preset.status === undefined ? 200 : preset.status }, "x".repeat(preset.bytes)), scaled(preset.ms));
        }, 1);
      }
    },
    $done: (out) => { done = out; finished(); }
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { timeout: 15000, filename: "bili-line-probe.js" });
  // 同步退出分支不需要定时器，异步分支要跑完串行测速；轮询等待可以同时覆盖两种。
  for (let waited = 0; waited < 8000 && !done; waited += 10) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(done, "探测脚本没有调用 $done()");
  return { store: storeObj.data, logs, notifications };
}

async function testProbe() {
  console.log("\n[bili-line-probe.js]");
  const samples = JSON.stringify({
    ts: Date.now(),
    items: [
      { host: "upos-sz-mirrorcos.bilivideo.com", path: "/upgcxcode/a/b/1/1-1.mp4?sign=1" },
      { host: "upos-sz-mirrorali.bilivideo.com", path: "/upgcxcode/a/b/1/1-1.mp4?sign=1" },
      { host: "upos-sz-mirrorbos.bilivideo.com", path: "/upgcxcode/a/b/1/1-1.mp4?sign=1" }
    ],
    hosts: ["upos-sz-mirrorcos.bilivideo.com", "upos-sz-mirrorali.bilivideo.com", "upos-sz-mirrorbos.bilivideo.com"]
  });

  const fast = await runProbe({
    argument: { ruleset_url: "https://cdn.jsdelivr.net/gh/me/repo@main/build/cdn-hosts.json", probe_debug: true },
    store: { "biliAccel.samples": samples },
    probeResults: {
      "upos-sz-mirrorcos.bilivideo.com": { bytes: 20000, ms: 500 },
      "upos-sz-mirrorali.bilivideo.com": { bytes: 262144, ms: 600 },
      "upos-sz-mirrorbos.bilivideo.com": { bytes: 30000, ms: 300 }
    }
  });
  check("按实测吞吐选出最快线路", () =>
    assert.equal(fast.store["biliAccel.best"], "upos-sz-mirrorali.bilivideo.com"));
  check("测速结果带时间戳落库", () => assert.ok(Number(fast.store["biliAccel.bestTs"]) > 0));
  check("从远端同步到新增 host", () =>
    assert.ok(String(fast.store["biliAccel.hosts"]).includes("upos-sz-mirror08c.bilivideo.com")));

  const expired = await runProbe({
    argument: {},
    store: { "biliAccel.samples": samples },
    probeResults: {
      "upos-sz-mirrorcos.bilivideo.com": { bytes: 0, ms: 900, status: 403 },
      "upos-sz-mirrorali.bilivideo.com": { bytes: 0, ms: 100, status: 403 },
      "upos-sz-mirrorbos.bilivideo.com": { bytes: 0, ms: 700, status: 403 }
    }
  });
  check("签名过期时退化为 RTT 排序", () =>
    assert.equal(expired.store["biliAccel.best"], "upos-sz-mirrorali.bilivideo.com"));

  const noSample = await runProbe({ argument: { probe_debug: true }, store: {}, probeResults: {} });
  check("没有播放样本时安全退出", () =>
    assert.ok(noSample.logs.some((l) => typeof l === "object" && l.reason === "no sample yet")));

  const allDead = await runProbe({
    argument: { probe_debug: true },
    store: { "biliAccel.samples": samples },
    probeResults: {
      "upos-sz-mirrorcos.bilivideo.com": { bytes: 0, ms: 5000, status: 0 },
      "upos-sz-mirrorali.bilivideo.com": { bytes: 0, ms: 5000, status: 0 },
      "upos-sz-mirrorbos.bilivideo.com": { bytes: 0, ms: 5000, status: 0 }
    }
  });
  check("全部线路探测失败时不覆盖旧结果", () =>
    assert.equal(allDead.store["biliAccel.best"], undefined));

  const stale = await runProbe({
    argument: { probe_debug: true },
    store: { "biliAccel.samples": JSON.stringify({ ts: Date.now() - 13 * 3600 * 1000, items: [{ host: "upos-sz-mirrorcos.bilivideo.com", path: "/" }] }) },
    probeResults: {}
  });
  check("样本超过 12 小时判为过期", () =>
    assert.ok(stale.logs.some((l) => typeof l === "object" && l.reason === "sample stale")));
}

await testRewrite();
await testProbe();

console.log(`\n结果：通过 ${passed} 项，失败 ${failures.length} 项`);
if (failures.length) {
  failures.forEach((f) => console.log("  - " + f));
  process.exit(1);
}
