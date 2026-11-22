#!/usr/bin/env node
/*
 * lint-plugin.mjs —— 检查 .plugin 是否符合 Loon 插件语法。
 * 目的是在推送之前挡住「装不上 / 装了不生效」的插件，而不是等真机报错。
 *   node build/lint-plugin.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN = path.join(ROOT, "BiliBili-Accelerator.plugin");

const errors = [];
const warnings = [];

if (!fs.existsSync(PLUGIN)) {
  console.error("找不到插件文件：" + PLUGIN);
  process.exit(1);
}

const src = fs.readFileSync(PLUGIN, "utf8");
const lines = src.split(/\r?\n/);

// ---------------------------------------------------- 元信息
const meta = {};
for (const line of lines) {
  const m = /^#!\s*([a-zA-Z_]+)\s*=\s*(.*)$/.exec(line.trim());
  if (m) meta[m[1].toLowerCase()] = m[2].trim();
}
for (const key of ["name", "desc"]) {
  if (!meta[key]) errors.push(`缺少必填元信息 #!${key}`);
}
if (meta.loon_version && !/^[\d.]+\(\d+\)$/.test(meta.loon_version)) {
  warnings.push(`#!loon_version 格式建议写成 3.5.1(983)，当前为 "${meta.loon_version}"`);
}
if (meta.date && !/^\d{4}-\d{2}-\d{2}([ T].*)?$/.test(meta.date)) {
  warnings.push(`#!date 建议用 yyyy-MM-dd，当前为 "${meta.date}"`);
}
if (!meta.source) {
  warnings.push("未声明 #!source：Loon 不会校验下载地址哈希（便于自动更新换域名，属有意为之）");
}

// ---------------------------------------------------- 分段
const sections = {};
let current = "";
let lineNo = 0;
for (const raw of lines) {
  lineNo++;
  const s = raw.trim();
  if (!s || s.startsWith("#") || s.startsWith("//")) continue;
  const header = /^\[([^\]]+)\]$/.exec(s);
  if (header) {
    current = header[1].toLowerCase();
    sections[current] = sections[current] || [];
    continue;
  }
  if (!current) {
    errors.push(`第 ${lineNo} 行内容不在任何 [Section] 下：${s.slice(0, 60)}`);
    continue;
  }
  sections[current].push({ text: s, line: lineNo });
}

const KNOWN = ["argument", "general", "rule", "rewrite", "script", "mitm", "host", "ip rewrite", "remote rule"];
for (const key of Object.keys(sections)) {
  if (!KNOWN.includes(key)) warnings.push(`未知模块 [${key}]，Loon 可能忽略`);
}

// ---------------------------------------------------- [Argument]
const declared = {};
for (const item of sections.argument || []) {
  const m = /^([A-Za-z0-9_]+)\s*=\s*(input|select|switch)\s*(?:,(.*))?$/.exec(item.text);
  if (!m) {
    errors.push(`第 ${item.line} 行 [Argument] 无法解析：${item.text.slice(0, 70)}`);
    continue;
  }
  const [, name, control, rest = ""] = m;
  const typeMatch = /type\s*=\s*(string|number|boolean)/i.exec(rest);
  const type = typeMatch ? typeMatch[1].toLowerCase() : (control === "switch" ? "boolean" : "string");
  if (control === "switch") {
    const body = rest.split(",")[0].trim();
    if (body && body !== "true" && body !== "false") {
      errors.push(`第 ${item.line} 行 switch 默认值只能是 true/false，当前 "${body}"`);
    }
  }
  if (declared[name]) errors.push(`参数名重复：${name}`);
  declared[name] = { type, control, line: item.line };
}

// ---------------------------------------------------- [Rule]
const RULE_POLICIES = ["DIRECT", "REJECT", "REJECT-IMG", "REJECT-DICT", "REJECT-ARRY", "REJECT-DROP", "PROXY"];
for (const item of sections.rule || []) {
  const parts = item.text.split(",");
  if (parts.length < 2) {
    errors.push(`第 ${item.line} 行规则格式不对：${item.text.slice(0, 60)}`);
    continue;
  }
  const type = parts[0].trim().toUpperCase();
  const policy = parts[parts.length - 1].trim().toUpperCase();
  if (!["DOMAIN", "DOMAIN-SUFFIX", "DOMAIN-KEYWORD", "USER-AGENT", "URL-REGEX", "IP-CIDR", "GEOIP"].includes(type)) {
    warnings.push(`第 ${item.line} 行规则类型少见：${type}`);
  }
  if (!RULE_POLICIES.includes(policy)) {
    errors.push(`第 ${item.line} 行策略 "${policy}" 不在插件允许范围内（插件规则只能用 ${RULE_POLICIES.join("/")}）`);
  }
}

// ---------------------------------------------------- [Script]
let hasResponse = false;
const BUILTIN_VARS = new Set([
  "url", "request.method", "request.body", "request.body.json", "request.body.form",
  "response.status", "response.body", "response.body.json", "response.body.text"
]);
function isBuiltinVar(name) {
  if (BUILTIN_VARS.has(name)) return true;
  return /^(request|response)\.header\[/.test(name);
}

for (const item of sections.script || []) {
  const rule = item.text;
  for (const v of rule.matchAll(/\$\{([A-Za-z0-9_.\[\]'"`]+)\}/g)) {
    if (!declared[v[1]] && !isBuiltinVar(v[1])) {
      errors.push(`第 ${item.line} 行引用了未在 [Argument] 声明的参数 \${${v[1]}}`);
    }
  }

  const isResponse = /^response\s+if\b/i.test(rule);
  const isCron = /^cron\s/i.test(rule);
  if (!isResponse && !isCron && !/^request\s+if\b/i.test(rule) && !/^generic\b/i.test(rule) && !/^network-changed\b/i.test(rule)) {
    errors.push(`第 ${item.line} 行不是可识别的 Script 触发器：${rule.slice(0, 60)}`);
    continue;
  }

  const scriptMatch = /script\(\s*"([^"]+)"/.exec(rule);
  if (!scriptMatch) {
    errors.push(`第 ${item.line} 行缺少 script("路径") 部分`);
  } else {
    const p = scriptMatch[1];
    if (/CHANGE_ME|YOUR_|REPLACE_ME/i.test(p)) warnings.push(`第 ${item.line} 行脚本地址仍是占位符：${p.slice(0, 60)}`);
    if (/\.js$/i.test(p) && !/^https?:\/\//i.test(p) && !/\//.test(p)) {
      warnings.push(`第 ${item.line} 行引用本地脚本 ${p}，需保证已放进 Loon 脚本目录`);
    }
  }

  if (isResponse) {
    hasResponse = true;
    if (!/\$\{url\}\s*~=\s*\//.test(rule)) {
      errors.push(`第 ${item.line} 行 Response Script 缺少 URL Guard（Loon 强制要求）`);
    } else {
      // URL 条件必须处于 && 链上，不能只挂在 || 分支里
      const urlAt = rule.search(/\$\{url\}\s*~/);
      const before = rule.slice(0, urlAt);
      const orAfterLastAnd = before.lastIndexOf("||") > before.lastIndexOf("&&");
      const orBeforeUrl = before.lastIndexOf("||") > -1 && orAfterLastAnd;
      if (orBeforeUrl) errors.push(`第 ${item.line} 行 URL 条件不是必要条件（被 || 短路）`);
    }
    if (!/requires_body\s*=\s*true/.test(rule)) {
      errors.push(`第 ${item.line} 行 Response Script 没有 requires_body=true，脚本读 \$response.body 会是空`);
    }
    const enable = /enable\s*=\s*\$\{([A-Za-z0-9_]+)\}/.exec(rule);
    if (enable && declared[enable[1]] && declared[enable[1]].type !== "boolean") {
      errors.push(`第 ${item.line} 行 enable=\${${enable[1]}} 需要 boolean，实际是 ${declared[enable[1]].type}`);
    }
    if (/timeout\s*=\s*(\d+)/.test(rule)) {
      const t = Number(/timeout\s*=\s*(\d+)/.exec(rule)[1]);
      if (t <= 0 || t > 60) warnings.push(`第 ${item.line} 行 timeout=${t} 偏大，Response Script 会卡住播放请求`);
    }
  }

  if (isCron) {
    const m = /^cron\s+\$\{([A-Za-z0-9_]+)\}/i.exec(rule);
    if (m && !declared[m[1]]) errors.push(`第 ${item.line} 行 cron 引用了未声明的 \${${m[1]}}`);
    if (/timeout\s*=\s*(\d+)/.test(rule) && Number(/timeout\s*=\s*(\d+)/.exec(rule)[1]) < 60) {
      warnings.push(`第 ${item.line} 行 cron timeout 小于 60 秒，串行测速可能来不及`);
    }
  }
}

// ---------------------------------------------------- [MitM]
const mitmLines = (sections.mitm || []).map((x) => x.text).join(" ");
if (hasResponse) {
  if (!/hostname\s*=/.test(mitmLines)) {
    errors.push("有 Response Script 但 [MitM] 没声明 hostname，HTTPS 响应根本不会被解密，改写不生效");
  } else {
    const hosts = mitmLines.split("=")[1].split(",").map((x) => x.trim()).filter(Boolean);
    if (!hosts.length) errors.push("[MitM] hostname 为空");
    for (const h of hosts) {
      if (/^\*\./.test(h)) warnings.push(`[MitM] hostname "${h}" 建议写成裸域名，Loon 会按后缀匹配`);
      if (/\*$|\/|^https?:/.test(h)) errors.push(`[MitM] hostname "${h}" 含非法字符`);
    }
  }
}

// ---------------------------------------------------- 参数闭环
for (const [name, info] of Object.entries(declared)) {
  const used = new RegExp(`\\$\\{${name}\\}`).test(src);
  if (!used) warnings.push(`参数 ${name}（第 ${info.line} 行）声明了但没被任何规则引用`);
}

// ---------------------------------------------------- 输出
for (const w of warnings) console.log("⚠️  " + w);
for (const e of errors) console.log("❌ " + e);
console.log(`\n检查完成：${errors.length} 个错误，${warnings.length} 个提示`);
process.exit(errors.length ? 1 : 0);
