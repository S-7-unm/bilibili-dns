#!/usr/bin/env node
/*
 * sync-upstream.mjs —— 每天从上游 bilibili-accelerator 拉取脚本，抽取真实出现的
 * B 站媒体 CDN 线路 host，生成 Loon 侧使用的清单文件。
 *
 * 产物：
 *   build/cdn-hosts.json  —— 探测脚本与改写脚本运行时读取
 *   rules/bili-cdn.list   —— 可选的 Loon Remote Rule 订阅源
 *   .plugin 里的 #!date=  —— 让 Loon 判断插件有新版可更新
 *
 * 上游抓取失败时不会清空既有清单（只在全部来源都不可用时报错退出）。
 */

import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = "realzza/bilibili-accelerator";
const SOURCES = [
  `https://raw.githubusercontent.com/${REPO}/main/dist/bilibili-accelerator.user.js`,
  `https://cdn.jsdelivr.net/gh/${REPO}@main/dist/bilibili-accelerator.user.js`,
  `https://cdn.statically.io/gh/${REPO}/main/dist/bilibili-accelerator.user.js`
];
const VERSION_SOURCES = [
  `https://raw.githubusercontent.com/${REPO}/main/package.json`,
  `https://cdn.jsdelivr.net/gh/${REPO}@main/package.json`
];

// 允许被收录的域名后缀，白名单外的 host 一律丢弃，防止抓到无关地址。
const MEDIA_SUFFIXES = [
  "bilivideo.com", "bilivideo.cn", "bilivideo.net", "acgvideo.com",
  "ourdvsss.com", "ksyungslb.com", "smtcdns.net", "mincdn.com",
  "maoercdn.com", "yfcdn.net", "bilivideo.akamaized.net",
  "upos-hz-mirrorakam.akamaized.net", "upos-bstar-mirrorakam.akamaized.net",
  "upos-bstar1-mirrorakam.akamaized.net"
];
// 页面与静态域：用于分流清单，不参与播放地址改写。
const STATIC_SUFFIXES = ["hdslb.com", "hdslb.net", "bstarstatic.com", "biliapi.com", "biliapi.net"];

const HOST_RE = /(?:https?:\/\/)?((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]{1,20}(?:\.[a-z]{2,4}){1,2})/gi;

function fetch(url, timeout = 25000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "user-agent": "loon-bili-accel-sync/1.0" }, timeout }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(fetch(new URL(res.headers.location, url).toString(), timeout));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`${res.statusCode} ${url}`));
      }
      let size = 0;
      const chunks = [];
      res.on("data", (c) => {
        size += c.length;
        if (size > 4 * 1024 * 1024) { req.destroy(); reject(new Error("too large")); }
        else chunks.push(c);
      });
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      res.on("error", reject);
    });
    req.on("timeout", () => { req.destroy(new Error("timeout")); });
    req.on("error", reject);
  });
}

async function tryAll(list) {
  const errors = [];
  for (const url of list) {
    try {
      const text = await fetch(url);
      if (text && text.length > 200) return { text, from: url };
    } catch (e) {
      errors.push(`${url} → ${e.message}`);
    }
  }
  throw new Error(errors.join(" | ") || "all sources empty");
}

function matchesSuffix(host, suffixes) {
  return suffixes.some((s) => host === s || host.endsWith("." + s));
}

function extractHosts(text) {
  const found = new Set();
  const statics = new Set();
  let m;
  HOST_RE.lastIndex = 0;
  while ((m = HOST_RE.exec(text)) !== null) {
    const host = m[1].toLowerCase();
    if (host.length > 80 || /^\d+\.\d+\.\d+\.\d+$/.test(host)) continue;
    if (matchesSuffix(host, MEDIA_SUFFIXES)) found.add(host);
    else if (matchesSuffix(host, STATIC_SUFFIXES)) statics.add(host);
  }
  return { media: [...found].sort(), statics: [...statics].sort() };
}

function readExisting() {
  const p = path.join(ROOT, "build", "cdn-hosts.json");
  if (!fs.existsSync(p)) return { mediaHosts: [], ruleHosts: [] };
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    return { mediaHosts: [], ruleHosts: [] };
  }
}

// Remote Rule 用「注册域 + 精确 host」两层：既覆盖新 mirror 子域，也保留已知具体线路。
const RULE_BASE = [
  "DOMAIN-SUFFIX,bilivideo.com", "DOMAIN-SUFFIX,bilivideo.cn", "DOMAIN-SUFFIX,bilivideo.net",
  "DOMAIN-SUFFIX,acgvideo.com", "DOMAIN-SUFFIX,ourdvsss.com", "DOMAIN-SUFFIX,ksyungslb.com",
  "DOMAIN-SUFFIX,smtcdns.net", "DOMAIN-SUFFIX,mincdn.com", "DOMAIN-SUFFIX,maoercdn.com",
  "DOMAIN-SUFFIX,bilicdn1.com", "DOMAIN-SUFFIX,bilicdn2.com", "DOMAIN-SUFFIX,bilicdn3.com",
  "DOMAIN-SUFFIX,bilicdn4.com", "DOMAIN-SUFFIX,bilicdn5.com",
  "DOMAIN,upos-hz-mirrorakam.akamaized.net", "DOMAIN,upos-bstar-mirrorakam.akamaized.net",
  "DOMAIN,upos-bstar1-mirrorakam.akamaized.net"
];

function writePluginDate() {
  const plugin = path.join(ROOT, "BiliBili-Accelerator.plugin");
  if (!fs.existsSync(plugin)) return false;
  const src = fs.readFileSync(plugin, "utf8");
  const stamp = new Date().toISOString().slice(0, 10);
  const out = src.replace(/^#!date=.*$/m, `#!date=${stamp}`);
  if (out !== src) fs.writeFileSync(plugin, out);
  return out !== src;
}

async function main() {
  const existing = readExisting();
  let version = "unknown";
  let upstreamHosts = { media: [], statics: [] };
  let ok = false;
  const notes = [];

  try {
    const v = JSON.parse((await tryAll(VERSION_SOURCES)).text);
    version = v.version || "unknown";
  } catch (e) {
    notes.push("版本号抓取失败：" + e.message);
  }

  try {
    const res = await tryAll(SOURCES);
    upstreamHosts = extractHosts(res.text);
    ok = true;
    notes.push("来源 " + res.from);
    if (!upstreamHosts.media.length) notes.push("警告：上游脚本里没有解析到媒体 CDN host，已保留原清单");
  } catch (e) {
    notes.push("上游脚本抓取失败：" + e.message);
  }

  const mediaHosts = [...new Set([
    ...(Array.isArray(existing.mediaHosts) ? existing.mediaHosts : []),
    ...upstreamHosts.media
  ])].sort();
  const ruleHosts = [...new Set([
    ...(Array.isArray(existing.ruleHosts) ? existing.ruleHosts : []),
    ...upstreamHosts.statics
  ])].sort();

  if (!ok && !mediaHosts.length) {
    console.error("上游全部不可用且本地清单为空，放弃本次同步。");
    process.exit(1);
  }

  const manifest = {
    schema: 1,
    upstream: { repo: REPO, version },
    updatedAt: new Date().toISOString(),
    mediaHosts,
    ruleHosts,
    notes
  };
  fs.writeFileSync(path.join(ROOT, "build", "cdn-hosts.json"), JSON.stringify(manifest, null, 2) + "\n");

  const list = [
    "# B 站媒体 CDN 线路清单（自动生成，请勿手改）",
    `# 上游 ${REPO} v${version}`,
    `# 更新时间 ${manifest.updatedAt}`,
    "# 用法：Loon 配置里 [Remote Rule] 添加本文件地址，策略填 PROXY",
    ...RULE_BASE,
    ...mediaHosts.filter((h) => h.split(".").length > 3).map((h) => `DOMAIN,${h}`)
  ].join("\n") + "\n";
  fs.writeFileSync(path.join(ROOT, "rules", "bili-cdn.list"), list);

  const bumped = writePluginDate();
  console.log(`同步完成：媒体线路 ${mediaHosts.length} 条，静态域 ${ruleHosts.length} 条，插件日期${bumped ? "已更新" : "未变"}`);
  notes.forEach((n) => console.log("  · " + n));
}

main().catch((e) => {
  console.error("同步失败：", e.message);
  process.exit(1);
});
