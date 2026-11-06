#!/usr/bin/env node
'use strict';
//
// read-agent-token.js — 从 agent 的 appsettings.json 里读出 agentToken，打到 stdout。
//
// ── 为什么需要这个助手 ────────────────────────────────────────────────────────
// 两个 make-release.ps1（ADAgent / MemberAgent）都要在**打包前**做一次
// "token 泄漏扫描"：把整个待发布目录读一遍，看有没有哪个文件里出现了
// agentToken 的明文。
//
// 旧实现没有这个助手 —— 两个 make-release.ps1 里的
//     & node (Join-Path $PSScriptRoot 'read-agent-token.js') ...
// 指向一个**全仓不存在**的文件（`find` 与 `git ls-files` 都是 0 命中）⇒
// `node` 打印 "Cannot find module" 到 stderr（被 `2>$null` 吞掉）⇒
// $token 为空 ⇒ 脚本 `throw 'failed to load AGENT_AUTH_TOKEN from appsettings.json'`
// ⇒ **绿色包发布链 100% 不可执行**。
//
// ── 契约（由两个 make-release.ps1 约定，不得单方面改）──────────────────────
//   用法:   node read-agent-token.js <appsettings.json 的路径>
//   stdout: 只输出 token 本身（**不带换行**，不带任何其它字符）
//   stderr: 诊断信息（PowerShell 侧 `2>$null` 会吞掉）
//   退出码: 0 = 读到了; 1 = 没读到（**此时 stdout 必须是空的**）
//
// ★ 安全约定：
//   1. token 只经过 stdout，不写任何文件、不进任何临时文件、不进环境变量。
//   2. 失败时**绝不在 stdout 输出任何东西** —— 调用方靠"$token 为空"判断失败，
//      stdout 里哪怕多一个字符都会让"泄漏扫描"拿着垃圾串去比对。
//   3. 错误信息里**绝不回显 token**（哪怕长度也不回显）—— stderr 会被重定向到
//      宿主机的日志文件里。
//
// ── 用 CommonJS 而不是 ESM ────────────────────────────────────────────────────
// 本文件位于 `ADAgent/scripts/`（发布脚本自己旁边），**不在**任何带
// "type": "module" 的 package.json 作用域内（ADAgent/ 与仓库根都没有
// package.json）⇒ Node 按 CommonJS 解析 ⇒ 用 require。
// 写成 ESM 的话，一旦将来有人往 ADAgent/ 放一个 "type":"module" 的
// package.json，这个助手就会以 ERR_REQUIRE_ESM 崩掉 —— 而它崩掉的方式是
// "发布链静默失败"，那是最坏的一种。
//
const fs = require('node:fs');
const path = require('node:path');

// appsettings.json 里 agentToken 的键名。`agentToken` 是真源
// （ADAgent/agent/src/config.js 的 REQUIRED = ['centerUrl','agentId','agentToken']，
// appsettings.example.json 里也是这个键）；`AGENT_AUTH_TOKEN` 是环境变量侧的
// 名字（package-runner.js 把它注入到子进程环境），有些老配置里也用这个名字。
// 两个都认，取先命中的那个。
const TOKEN_KEYS = ['agentToken', 'AGENT_AUTH_TOKEN'];

// 示例模板里的占位符 —— 它不是真 token。带着它去跑"泄漏扫描"毫无意义
// （扫的是 "REPLACE_WITH_TOKEN_FROM_CENTER" 这个字符串）⇒ 直接判失败。
const PLACEHOLDER_TOKEN = 'REPLACE_WITH_TOKEN_FROM_CENTER';

function fail(reason) {
  // 诊断只进 stderr；stdout 必须保持干净。
  process.stderr.write(`read-agent-token: ${reason}\n`);
  process.exit(1);
}

const configPath = process.argv[2];
if (!configPath) {
  fail('missing argument: <appsettings.json path>');
}

let raw;
try {
  raw = fs.readFileSync(path.resolve(configPath), 'utf8');
} catch (err) {
  fail(`cannot read ${configPath}: ${err.code || err.message}`);
}

// UTF-8 BOM 会让 JSON.parse 直接抛 "Unexpected token"。agent 侧的
// appsettings-writer.js 写出去的文件就可能带 BOM（Windows PowerShell 的
// Out-File 默认行为），所以这里必须先剥掉。
if (raw.charCodeAt(0) === 0xfeff) {
  raw = raw.slice(1);
}

let config;
try {
  config = JSON.parse(raw);
} catch (err) {
  fail(`cannot parse ${configPath}: ${err.message}`);
}

if (!config || typeof config !== 'object' || Array.isArray(config)) {
  fail(`${configPath} does not contain a JSON object`);
}

let token = null;
let usedKey = null;
for (const key of TOKEN_KEYS) {
  const value = config[key];
  if (typeof value === 'string' && value.trim() !== '') {
    token = value.trim();
    usedKey = key;
    break;
  }
}

if (!token) {
  fail(`${configPath} has no non-empty "${TOKEN_KEYS[0]}" / "${TOKEN_KEYS[1]}" field`);
}

if (token === PLACEHOLDER_TOKEN) {
  fail(`${configPath} still carries the placeholder "${PLACEHOLDER_TOKEN}" — there is no real token to scan for`);
}

// 只输出 token 本身。没有换行、没有引号、没有 "key=" 前缀 —— 调用方
// `& node ... ` 捕获到的必须正好是 token 字符串。
process.stdout.write(token);
process.stderr.write(`read-agent-token: ok (key=${usedKey}, len=${token.length})\n`);
process.exit(0);
