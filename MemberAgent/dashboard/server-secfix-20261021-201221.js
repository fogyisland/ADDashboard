// dashboard/server.js — AD Agent 本地监控面板
//
// 单文件、零依赖、本地只读。
// 启动时从 agent/appsettings.json 读取 username/password(base64)/port。
// 第一次访问任意页面 → 登录页;凭证正确 → 主页(全部数据 inline 在 HTML 里)。
// 数据来源: agent/data/packages/ (包定义) + agent/data/last-collect/ (最近报表) +
//           Logs/ + agent/Logs/ (运行日志) + Get-Service ADReplicationAgent (服务状态)
//
// 这是一个"打开就能看"的工具,不是 REST API。没有 /api/* 一组端点,只有:
//   GET  /              主页(数据 inline)
//   GET  /login         登录页
//   POST /login         校验凭证、签发 cookie
//   GET  /logout        清 cookie
//   GET  /script?pkg=&v=&file=  返回脚本原文
//   GET  /log?name=&dir=        返回日志尾部
//
// 2026-10-02 — 可作为模块被 agent.js 集成调用,导出 startDashboard()。模块被
// import 时,只定义函数和常量,不启动 HTTP 服务。仅当 `node dashboard/server.js`
// 直接运行时(主模块判断),走 CLI 自启分支 — 这样保持 CLI 用法不破坏,同时
// 让 agent 进程能把 dashboard 嵌在同一个 Node.js 进程里复用 event loop 与
// 日志输出。

import http from 'node:http';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';
import { pathToFileURL, fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// 路径常量(模块作用域)
// ---------------------------------------------------------------------------

const _here = path.dirname(fileURLToPath(import.meta.url));
const INSTALL_ROOT = path.resolve(_here, '..');
const AGENT_DIR    = path.join(INSTALL_ROOT, 'agent');
const APPSETTINGS  = path.join(AGENT_DIR, 'appsettings.json');
const EXAMPLE      = path.join(AGENT_DIR, 'appsettings.example.json');
const VERSION_INF  = path.join(INSTALL_ROOT, 'version.inf');

// ---------------------------------------------------------------------------
// version.inf 读取 — 单一版本源
// ---------------------------------------------------------------------------
//
// R0.1.1+ 之前从 dashboard/package.json 读 version,现在统一从项目根
// version.inf 的 [components] dashboard 段读。读取失败返回 '0.0.0-dev',
// 与 agent 的 DEFAULTS 行为一致(永远不返回空字符串,UI 渲染不会空白)。
//
// INI 解析逻辑与 common/Version.psm1 同步 — 保持简单,避免 dashboard 引入
// 跨语言的 readVersion utility。如果未来 PS 和 Node 的解析逻辑分叉,
// 再考虑把 version.inf 升级为 JSON。
function readVersionInf(infPath = VERSION_INF) {
  try {
    const raw = fsSync.readFileSync(infPath, 'utf8');
    let section = null;
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith(';') || t.startsWith('#')) continue;
      const sec = t.match(/^\[(.+)\]$/);
      if (sec) { section = sec[1].trim().toLowerCase(); continue; }
      const kv = t.match(/^([^=]+)=(.*)$/);
      if (kv && section) {
        const k = kv[1].trim().toLowerCase();
        const v = kv[2].trim();
        if (section === 'components' && k === 'dashboard') return v;
      }
    }
  } catch (_) { /* missing or unreadable — fall through */ }
  return '0.0.0-dev';
}
const DASHBOARD_VERSION = readVersionInf();

// ---------------------------------------------------------------------------
// appsettings.json 解析 — 既支持 CLI 自启,也支持 import() 调用
// ---------------------------------------------------------------------------

function defaultAppsettings() {
  return {
    username: 'admin',
    password: Buffer.from('admin').toString('base64'),
    port: 8080,
    centerUrl: '',
    agentId: '',
    agentToken: ''
  };
}

async function loadAppsettings({ argv = process.argv, appsettingsPath = APPSETTINGS, examplePath = EXAMPLE, logger = console } = {}) {
  const cli = parseArgs(argv);
  if (cli.help) {
    process.stdout.write(
      'dashboard — local read-only UI for the AD Replication Agent\n' +
      'Usage: node dashboard/server.js [--port N]\n' +
      'Reads username/password/port from agent/appsettings.json\n' +
      'Default: 127.0.0.1:8080 (override with appsettings.json port or --port)\n'
    );
    process.exit(0);
  }

  let cfg;
  try {
    const raw = await fs.readFile(appsettingsPath, 'utf8');
    cfg = JSON.parse(raw.replace(/^﻿/, ''));
  } catch (e) {
    try {
      const raw = await fs.readFile(examplePath, 'utf8');
      cfg = JSON.parse(raw.replace(/^﻿/, ''));
    } catch (e2) {
      cfg = {};
    }
    logger.warn?.(`[dashboard] appsettings.json missing or invalid (${e.message}); using defaults`);
  }

  const merged = { ...defaultAppsettings(), ...cfg };
  if (cli.port) merged.port = cli.port;

  if (!merged.username || !merged.password) {
    throw new Error('appsettings.json must define username and password');
  }
  let plainPassword;
  try {
    plainPassword = Buffer.from(merged.password, 'base64').toString('utf8');
  } catch (e) {
    throw new Error(`appsettings.json password is not valid base64: ${e.message}`);
  }
  return {
    username: String(merged.username),
    plainPassword,
    port: Number(merged.port) || 8080,
    centerUrl: merged.centerUrl || '',
    agentId: merged.agentId || ''
  };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--port' && argv[i + 1]) out.port = Number(argv[++i]);
    else if (argv[i] === '--help' || argv[i] === '-h') out.help = true;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 数据采集 — 启动时一次读完,30 秒 polling 后台更新 last-collect
// ---------------------------------------------------------------------------

const PACKAGES_DIR = path.join(AGENT_DIR, 'data', 'packages');
const LAST_COLLECT_DIR = path.join(AGENT_DIR, 'data', 'last-collect');

// 可被 startDashboard() 覆盖的运行时路径(默认与上面的常量一致)
const _paths = {
  installRoot: INSTALL_ROOT,
  agentDir: AGENT_DIR
};
function _packagesDir()     { return path.join(_paths.agentDir, 'data', 'packages'); }
function _lastCollectDir()  { return path.join(_paths.agentDir, 'data', 'last-collect'); }
function _rootLogsDir()     { return path.join(_paths.installRoot, 'Logs'); }
function _agentLogsDir()    { return path.join(_paths.agentDir, 'Logs'); }

async function loadPackages() {
  const packagesDir = _packagesDir();
  const out = [];
  let entries = [];
  try {
    entries = await fs.readdir(packagesDir, { withFileTypes: true });
  } catch (e) { return out; }

  for (const dirent of entries) {
    if (!dirent.isDirectory()) continue;
    const name = dirent.name;
    const pkgDir = path.join(packagesDir, name);
    let activeVersion = null;
    try {
      const cur = JSON.parse(await fs.readFile(path.join(pkgDir, 'current.json'), 'utf8'));
      activeVersion = cur.version || null;
    } catch (e) { /* no current.json */ }

    const versions = [];
    let sub = [];
    try { sub = await fs.readdir(pkgDir, { withFileTypes: true }); } catch (e) {}
    for (const s of sub) {
      if (!s.isDirectory()) continue;
      const manifestPath = path.join(pkgDir, s.name, 'manifest.json');
      let manifest = null;
      let manifestError = null;
      try { manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')); }
      catch (e) { manifestError = e.message; }

      const files = [];
      let fs2 = [];
      try { fs2 = await fs.readdir(path.join(pkgDir, s.name), { withFileTypes: true }); } catch (e) {}
      for (const f of fs2) {
        if (!f.isFile() || f.name === 'manifest.json') continue;
        try {
          const st = await fs.stat(path.join(pkgDir, s.name, f.name));
          files.push({ name: f.name, size: st.size });
        } catch (e) {}
      }
      versions.push({ version: s.name, manifest, manifestError, files });
    }
    versions.sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true }));
    out.push({ name, activeVersion, versions });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

async function loadLastCollect() {
  const lastCollectDir = _lastCollectDir();
  const out = {};
  let entries = [];
  try { entries = await fs.readdir(lastCollectDir, { withFileTypes: true }); } catch (e) { return out; }
  for (const dirent of entries) {
    if (!dirent.isFile() || !dirent.name.endsWith('.json')) continue;
    const name = dirent.name.slice(0, -5);
    try {
      const stat = await fs.stat(path.join(lastCollectDir, dirent.name));
      const data = JSON.parse(await fs.readFile(path.join(lastCollectDir, dirent.name), 'utf8'));
      out[name] = { mtime: stat.mtime.toISOString(), size: stat.size, data };
    } catch (e) { /* skip unreadable */ }
  }
  return out;
}

async function loadLogs() {
  const out = [];
  const dirs = [
    { key: 'root', dir: _rootLogsDir() },
    { key: 'agent', dir: _agentLogsDir() }
  ];
  for (const d of dirs) {
    let entries = [];
    try { entries = await fs.readdir(d.dir, { withFileTypes: true }); } catch (e) { continue; }
    const files = [];
    for (const e of entries) {
      if (!e.isFile()) continue;
      const lower = e.name.toLowerCase();
      if (!(lower.endsWith('.log') || lower.endsWith('.err') || lower.endsWith('.out'))) continue;
      try {
        const st = await fs.stat(path.join(d.dir, e.name));
        files.push({ name: e.name, size: st.size, mtime: st.mtime.toISOString() });
      } catch (e) {}
    }
    files.sort((a, b) => b.mtime.localeCompare(a.mtime));
    out.push({ key: d.key, dir: d.dir, files });
  }
  return out;
}

async function loadService() {
  return new Promise((resolve) => {
    const ps = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command',
      '$ErrorActionPreference="SilentlyContinue";' +
      '$s = Get-Service ADReplicationAgent -ErrorAction SilentlyContinue;' +
      'if ($null -eq $s) { @{ installed=$false } | ConvertTo-Json -Compress }' +
      'else { [PSCustomObject]@{ installed=$true; name=$s.Name; status=$s.Status.ToString(); startType=$s.StartType.ToString() } | ConvertTo-Json -Compress }'
    ], { windowsHide: true });
    let stdout = '';
    const t = setTimeout(() => { try { ps.kill(); } catch (e) {} resolve({ installed: false, error: 'timeout' }); }, 5000);
    ps.stdout.on('data', d => stdout += d.toString());
    ps.on('error', e => { clearTimeout(t); resolve({ installed: false, error: e.message }); });
    ps.on('close', () => {
      clearTimeout(t);
      try {
        const data = JSON.parse(stdout.trim() || '{"installed":false}');
        resolve(data);
      } catch (e) {
        resolve({ installed: false, error: 'parse failed: ' + e.message });
      }
    });
  });
}

const data = {
  packages: [],
  lastCollect: {},
  logs: [],
  service: { installed: false },
  startedAt: new Date().toISOString()
};

async function refreshAll() {
  data.packages = await loadPackages();
  data.lastCollect = await loadLastCollect();
  data.logs = await loadLogs();
  data.service = await loadService();
}

// ---------------------------------------------------------------------------
// 认证: 简单的 cookie-based session
// ---------------------------------------------------------------------------

// 已签发的 token 集合(进程内存)。重启 dashboard 后所有 session 失效,这是预期的。
const sessions = new Set();

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function checkAuth(req) {
  const cookies = parseCookies(req.headers.cookie);
  return cookies.dash_auth && sessions.has(cookies.dash_auth);
}

// ---------------------------------------------------------------------------
// HTML 模板(单文件、内嵌,避免 public/ 目录)
// ---------------------------------------------------------------------------

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // 单引号必须转义:包名/文件名会被插进 onclick="openPkg('...')" 这类
    // 单引号 JS 字符串上下文,不转义则值含 ' 即可闭合字符串注入 JS。
    // 注意这只是第二层防御 —— 真正的修复是下面把内联 handler 改成事件委托,
    // 因为浏览器解码 &#39; 后仍会把裸单引号交给 JS 求值。
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// 路径段校验 — 挡目录穿越
// ---------------------------------------------------------------------------
//
// 白名单 /^[A-Za-z0-9._-]+$/ 本身放过 ".."(. 在字符类里),而调用方把
// pkg / v / file 当作 path.join 的独立片段拼接,于是
//   /script?pkg=..&v=..&file=appsettings.json
// 会逃出 packages 目录读到 agent/appsettings.json(内含明文 agentToken)。
// 所以在字符白名单之外,额外显式拒绝 "." 与 ".." 两段。
//
// 这只挡相对穿越。belt-and-braces 的第二道防线在 resolveSafeJoin:拼接后
// resolve() 再校验结果仍位于 root 之内,这样即使将来有人放宽了上面的白名单,
// 也不会重新打开任意文件读。
const PATH_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

function isSafePathSegment(seg) {
  if (typeof seg !== 'string' || seg.length === 0) return false;
  if (!PATH_SEGMENT_RE.test(seg)) return false;
  if (seg === '.' || seg === '..') return false;
  return true;
}

// 把若干路径段安全拼到 root 之下。任一段不安全、或结果逃出 root,返回 null。
function resolveSafeJoin(root, ...segments) {
  if (!segments.every(isSafePathSegment)) return null;
  const rootResolved = path.resolve(root);
  const full = path.resolve(rootResolved, ...segments);
  // 末尾分隔符是必需的,否则 "C:\\logsd" 这类同前缀目录会被误判为在 root 内。
  if (full !== rootResolved && !full.startsWith(rootResolved + path.sep)) return null;
  return full;
}

function fmtBytes(n) {
  if (n == null) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KiB';
  return (n / 1024 / 1024).toFixed(2) + ' MiB';
}

function fmtInterval(sec) {
  if (sec == null) return '—';
  if (sec < 60) return sec + ' 秒';
  if (sec < 3600) return (sec / 60) + ' 分钟';
  return (sec / 3600) + ' 小时';
}

function loginPage(error) {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><title>登录 · AD Agent 监控面板</title>
<style>
  body { background:#0f1115; color:#e6e9ef; font-family: -apple-system, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; }
  .box { background:#161a22; border:1px solid #2a3142; border-radius:10px; padding:32px; width:340px; }
  h1 { margin:0 0 4px; font-size:18px; }
  .sub { color:#8a93a6; font-size:12px; margin-bottom:24px; }
  label { display:block; font-size:12px; color:#8a93a6; margin-top:12px; }
  input { width:100%; box-sizing:border-box; background:#0a0c11; color:#e6e9ef; border:1px solid #2a3142; border-radius:6px; padding:8px 10px; font-size:14px; margin-top:4px; }
  input:focus { outline:none; border-color:#4ea1ff; }
  button { width:100%; margin-top:20px; background:#4ea1ff; color:#0b1118; border:0; border-radius:6px; padding:10px; font-size:14px; font-weight:600; cursor:pointer; }
  .err { color:#f06464; font-size:12px; margin-top:12px; }
</style></head><body>
<div class="box">
  <h1>AD Agent · 本地监控面板</h1>
  <div class="sub">请输入 appsettings.json 中配置的凭证</div>
  <form method="post" action="/login">
    <label>用户名</label><input name="username" autofocus required>
    <label>密码</label><input name="password" type="password" required>
    <button type="submit">登录</button>
    ${error ? `<div class="err">${escapeHtml(error)}</div>` : ''}
  </form>
</div>
</body></html>`;
}

function renderPackages() {
  if (!data.packages.length) {
    return '<div class="hint">未发现任何采集包。</div>';
  }
  let html = '';
  for (const p of data.packages) {
    const active = p.versions.find(v => v.version === p.activeVersion);
    const m = active ? active.manifest : {};
    const agent = (m && m.agent) || {};
    const interval = agent.intervalSec || (agent.policy && agent.policy.intervalSec);
    const lc = data.lastCollect[p.name];

    html += `
      <div class="pkg" onclick="openPkg('${escapeHtml(p.name)}')">
        <h4>${escapeHtml(p.name)} <span class="pill mute">${escapeHtml(m.type || '?')}</span></h4>
        <div class="desc">${escapeHtml(m.description || '(无描述)')}</div>
        <dl>
          <dt>当前版本</dt><dd><span class="pill good">${escapeHtml(p.activeVersion || '—')}</span></dd>
          <dt>所有版本</dt><dd>${p.versions.map(v => v.version).join(', ')}</dd>
          <dt>调度</dt><dd>${fmtInterval(interval)}</dd>
          <dt>脚本</dt><dd>${escapeHtml(agent.script || '—')}</dd>
          <dt>最近报表</dt><dd>${lc ? fmtBytes(lc.size) : '<span class="hint">无</span>'}</dd>
        </dl>
      </div>`;
  }
  return html;
}

function renderLogs() {
  if (!data.logs.length) return '<div class="hint">未发现日志目录。</div>';
  let html = '';
  for (const d of data.logs) {
    html += `<div class="group"><h3>${escapeHtml(d.dir)} ${d.files.length ? '' : '<span class="hint">(空)</span>'}</h3>`;
    if (d.files.length) {
      html += '<div class="row-list">';
      for (const f of d.files) {
        html += `<div class="row" onclick="openLog('${escapeHtml(d.key)}','${escapeHtml(f.name)}')">
          <span class="name">${escapeHtml(f.name)}</span>
          <span class="meta">${fmtBytes(f.size)} · ${escapeHtml(f.mtime)}</span>
        </div>`;
      }
      html += '</div>';
    }
    html += '</div>';
  }
  return html;
}

function renderOverview() {
  const svc = data.service;
  const svcCls = svc.installed ? (String(svc.status).toLowerCase() === 'running' ? 'good' : 'warn') : 'bad';
  const svcLabel = svc.installed ? svc.status : (svc.error ? '未安装' : '未知');
  const lastWithTs = Object.entries(data.lastCollect).sort((a, b) => (b[1].mtime || '').localeCompare(a[1].mtime || ''))[0];
  return `
    <div class="cards">
      <div class="card"><h3>服务</h3><div class="body">
        <div class="stat ${svcCls}">${escapeHtml(svcLabel)}</div>
        <dl>
          <dt>名称</dt><dd>${escapeHtml(svc.name || 'ADReplicationAgent')}</dd>
          <dt>启动类型</dt><dd>${escapeHtml(svc.startType || '—')}</dd>
        </dl>
      </div></div>
      <div class="card"><h3>采集包</h3><div class="body">
        <div class="stat">${data.packages.length}</div>
        <dl><dt>已激活</dt><dd>${data.packages.filter(p => p.activeVersion).length}</dd></dl>
      </div></div>
      <div class="card"><h3>最近报表</h3><div class="body">
        <div class="stat">${Object.keys(data.lastCollect).length}</div>
        <dl>
          <dt>最新</dt><dd>${lastWithTs ? escapeHtml(lastWithTs[0]) : '<span class="hint">无</span>'}</dd>
          <dt>时间</dt><dd>${lastWithTs ? escapeHtml(lastWithTs[1].mtime) : '—'}</dd>
        </dl>
      </div></div>
      <div class="card"><h3>配置</h3><div class="body">
        <dl>
          <dt>centerUrl</dt><dd>${escapeHtml(data.centerUrl || '(未配置)')}</dd>
          <dt>agentId</dt><dd>${escapeHtml(data.agentId || '(未配置)')}</dd>
          <dt>登录用户</dt><dd>${escapeHtml(data.username)}</dd>
          <dt>启动时间</dt><dd>${escapeHtml(data.startedAt)}</dd>
        </dl>
      </div></div>
    </div>`;
}

function mainPage() {
  const pkgHtml = renderPackages();
  const logHtml = renderLogs();
  const overviewHtml = renderOverview();
  // 把所有数据 inline 在页面里,前端用 data-attribute 切换 tab,不调任何 API。
  const initialJson = JSON.stringify({
    packages: data.packages,
    lastCollect: data.lastCollect
  }).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><title>AD Agent · 本地监控面板</title>
<style>
  :root { --bg:#0f1115; --bg-card:#161a22; --bg-soft:#1d2230; --fg:#e6e9ef; --mute:#8a93a6; --accent:#4ea1ff; --good:#4ad395; --warn:#f0b85b; --bad:#f06464; --border:#2a3142; --mono: ui-monospace, "Cascadia Mono", "Consolas", monospace; }
  * { box-sizing: border-box; }
  html, body { margin:0; background:var(--bg); color:var(--fg); font-family: -apple-system, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; font-size:14px; line-height:1.5; }
  header { display:flex; justify-content:space-between; align-items:center; padding:10px 20px; background:var(--bg-soft); border-bottom:1px solid var(--border); }
  h1 { margin:0; font-size:15px; }
  nav a { color:var(--mute); text-decoration:none; padding:6px 12px; border-radius:6px; margin-left:2px; font-size:13px; }
  nav a:hover { background:var(--bg-card); color:var(--fg); }
  nav a.active { background:var(--accent); color:#0b1118; font-weight:600; }
  main { padding:18px 20px; max-width:1280px; margin:0 auto; }
  .view { display:none; } .view.active { display:block; }
  .cards { display:grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap:14px; }
  .card { background:var(--bg-card); border:1px solid var(--border); border-radius:8px; padding:14px; }
  .card h3 { margin:0 0 6px; font-size:11px; color:var(--mute); font-weight:500; text-transform:uppercase; letter-spacing:0.04em; }
  .stat { font-size:22px; font-weight:600; }
  .stat.good { color:var(--good); } .stat.bad { color:var(--bad); } .stat.warn { color:var(--warn); }
  dl { margin:8px 0 0; display:grid; grid-template-columns: auto 1fr; gap:3px 10px; font-size:12px; }
  dt { color:var(--mute); } dd { margin:0; word-break:break-all; font-family:var(--mono); }
  .grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap:12px; margin-top:12px; }
  .pkg { background:var(--bg-card); border:1px solid var(--border); border-radius:8px; padding:12px; cursor:pointer; }
  .pkg:hover { border-color:var(--accent); }
  .pkg h4 { margin:0 0 6px; font-size:13px; font-family:var(--mono); color:var(--accent); }
  .pkg .desc { font-size:12px; color:var(--mute); min-height:32px; margin-bottom:8px; }
  .pkg dl { font-size:11.5px; }
  .pill { display:inline-block; padding:1px 7px; border-radius:4px; font-size:10.5px; font-family:var(--mono); }
  .pill.good { background:rgba(74,211,149,0.15); color:var(--good); }
  .pill.mute { background:var(--bg-soft); color:var(--mute); }
  .hint { color:var(--mute); font-size:12px; }
  .group { margin-top:16px; border:1px solid var(--border); border-radius:8px; overflow:hidden; }
  .group h3 { margin:0; padding:8px 14px; background:var(--bg-soft); font-size:12px; color:var(--mute); font-weight:500; text-transform:uppercase; }
  .row { display:flex; justify-content:space-between; padding:6px 14px; border-bottom:1px solid var(--border); cursor:pointer; font-family:var(--mono); font-size:12px; }
  .row:hover { background:var(--bg-soft); }
  .row .name { color:var(--accent); }
  .row .meta { color:var(--mute); }
  .detail { background:var(--bg-card); border:1px solid var(--border); border-radius:8px; padding:16px; margin-top:14px; }
  .detail h3 { margin:0 0 8px; font-size:14px; }
  .detail .close { float:right; background:none; border:0; color:var(--mute); font-size:18px; cursor:pointer; }
  pre { background:#0a0c11; border:1px solid var(--border); border-radius:6px; padding:12px; overflow:auto; max-height:480px; font-family:var(--mono); font-size:12px; line-height:1.5; }
  footer { display:flex; justify-content:space-between; padding:10px 20px; border-top:1px solid var(--border); color:var(--mute); font-size:12px; margin-top:30px; }
</style></head>
<body>
<header>
  <h1>AD Agent · 本地监控面板 <span style="color:var(--mute);font-size:11px;font-weight:400;margin-left:6px">v${DASHBOARD_VERSION}</span></h1>
  <nav>
    <a href="#overview" data-tab="overview" class="active">概览</a>
    <a href="#plans" data-tab="plans">采集计划</a>
    <a href="#reports" data-tab="reports">最近报表</a>
    <a href="#logs" data-tab="logs">日志</a>
    <a href="#password" data-tab="password">更改密码</a>
    <a href="#logout" data-tab="logout">退出</a>
  </nav>
</header>
<main>
  <section id="view-overview" class="view active">${overviewHtml}</section>
  <section id="view-plans" class="view"><p class="hint">点击任一包查看 manifest + collect.ps1 脚本内容。</p><div class="grid">${pkgHtml}</div><div id="plan-detail" class="detail" hidden></div></section>
  <section id="view-reports" class="view"><p class="hint">每个采集包最近一次 collect.ps1 的输出(由 agent 落盘到 <code>agent/data/last-collect/</code>)。</p><div id="reports-list"></div></section>
  <section id="view-logs" class="view">${logHtml}</section>
  <section id="view-password" class="view">
    <div class="detail" style="max-width:480px; margin:14px auto;">
      <h3>更改登录密码</h3>
      <p class="hint">修改后写入 <code>agent/appsettings.json</code> 的 <code>password</code> 字段(base64 编码),其它配置不变。新密码立即生效,无需重新登录。</p>
      <form id="password-form" style="margin-top:14px;">
        <label style="display:block; font-size:12px; color:var(--mute); margin-top:12px;">当前密码</label>
        <input name="oldPassword" type="password" required style="width:100%; box-sizing:border-box; background:#0a0c11; color:var(--fg); border:1px solid var(--border); border-radius:6px; padding:8px 10px; font-size:14px; margin-top:4px;">
        <label style="display:block; font-size:12px; color:var(--mute); margin-top:12px;">新密码 (4-128 字符)</label>
        <input name="newPassword" type="password" required minlength="4" maxlength="128" style="width:100%; box-sizing:border-box; background:#0a0c11; color:var(--fg); border:1px solid var(--border); border-radius:6px; padding:8px 10px; font-size:14px; margin-top:4px;">
        <label style="display:block; font-size:12px; color:var(--mute); margin-top:12px;">确认新密码</label>
        <input name="confirmPassword" type="password" required minlength="4" maxlength="128" style="width:100%; box-sizing:border-box; background:#0a0c11; color:var(--fg); border:1px solid var(--border); border-radius:6px; padding:8px 10px; font-size:14px; margin-top:4px;">
        <button type="submit" style="margin-top:18px; background:var(--accent); color:#0b1118; border:0; border-radius:6px; padding:10px 18px; font-size:14px; font-weight:600; cursor:pointer;">提交</button>
        <span id="password-result" style="margin-left:12px; font-size:13px;"></span>
      </form>
    </div>
  </section>
  <section id="view-logout" class="view"></section>
</main>
<div id="modal" class="detail" hidden style="position:fixed; top:60px; left:50%; transform:translateX(-50%); width:90%; max-width:1100px; z-index:10;"></div>
<footer>
  <span>read-only · loopback · 数据每 30 秒刷新</span>
  <span id="footer-ts">启动于 ${escapeHtml(data.startedAt)}</span>
</footer>
<script type="application/json" id="initial">${initialJson}</script>
<script>
  const INITIAL = JSON.parse(document.getElementById('initial').textContent);

  function showTab(name) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    const v = document.getElementById('view-' + name);
    if (v) v.classList.add('active');
    document.querySelectorAll('nav a').forEach(a => a.classList.toggle('active', a.dataset.tab === name));
    if (name === 'reports') renderReports();
    if (name === 'logout') { setTimeout(() => location.href = '/logout', 100); }
  }
  window.addEventListener('hashchange', () => showTab(location.hash.replace('#','') || 'overview'));

  function modal(html) {
    const m = document.getElementById('modal');
    m.innerHTML = '<button class="close" onclick="document.getElementById(\\'modal\\').hidden=true">×</button>' + html;
    m.hidden = false;
  }

  async function openPkg(name) {
    const pkg = INITIAL.packages.find(p => p.name === name);
    if (!pkg) return;
    const active = pkg.versions.find(v => v.version === pkg.activeVersion);
    const files = active ? active.files : [];
    let html = '<h3>' + esc(name) + ' <span class="pill mute">' + esc(pkg.activeVersion || '—') + '</span></h3>';
    html += '<div class="hint">所有版本: ' + pkg.versions.map(v => v.version).join(', ') + '</div>';
    for (const v of pkg.versions) {
      html += '<details' + (v === active ? ' open' : '') + '><summary>' + esc(v.version) + (v === active ? ' (active)' : '') + '</summary>';
      html += '<pre style="margin-top:8px;">' + esc(JSON.stringify(v.manifest, null, 2)) + '</pre>';
      for (const f of v.files) {
        html += '<div style="margin:6px 0 2px;"><a href="/script?pkg=' + encodeURIComponent(name) + '&v=' + encodeURIComponent(v.version) + '&file=' + encodeURIComponent(f.name) + '" target="_blank">' + esc(f.name) + '</a> (' + f.size + ' bytes)</div>';
      }
      html += '</details>';
    }
    modal(html);
  }

  function renderReports() {
    const root = document.getElementById('reports-list');
    const names = Object.keys(INITIAL.lastCollect).sort();
    if (!names.length) { root.innerHTML = '<p class="hint">agent 暂未落盘任何报表。运行一次 collect 后,文件会出现在 <code>agent/data/last-collect/&lt;name&gt;.json</code>。</p>'; return; }
    let html = '<div class="grid">';
    for (const n of names) {
      const lc = INITIAL.lastCollect[n];
      html += '<div class="pkg" onclick="openReport(\\'' + esc(n) + '\\')"><h4>' + esc(n) + '</h4><dl><dt>时间</dt><dd>' + esc(lc.mtime) + '</dd><dt>大小</dt><dd>' + lc.size + ' B</dd></dl></div>';
    }
    html += '</div>';
    root.innerHTML = html;
  }

  function openReport(name) {
    const lc = INITIAL.lastCollect[name];
    if (!lc) return;
    modal('<h3>' + esc(name) + ' <span class="pill mute">' + esc(lc.mtime) + '</span></h3><pre>' + esc(JSON.stringify(lc.data, null, 2)) + '</pre>');
  }

  async function openLog(dir, name) {
    const r = await fetch('/log?dir=' + encodeURIComponent(dir) + '&name=' + encodeURIComponent(name));
    if (!r.ok) { modal('<h3>错误</h3><pre>HTTP ' + r.status + '</pre>'); return; }
    const text = await r.text();
    modal('<h3>' + esc(dir) + '/' + esc(name) + '</h3><pre>' + esc(text) + '</pre>');
  }

  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // 30 秒自动刷新整页(简单粗暴,数据量小)
  setTimeout(() => location.reload(), 30000);

  // 更改密码表单 — fetch 而不是 form 的 GET 提交,以便处理 JSON 响应
  const pwForm = document.getElementById('password-form');
  if (pwForm) {
    pwForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const result = document.getElementById('password-result');
      result.textContent = '提交中…';
      result.style.color = 'var(--mute)';
      const fd = new FormData(pwForm);
      try {
        const r = await fetch('/password', {
          method: 'POST',
          body: new URLSearchParams({
            oldPassword: fd.get('oldPassword') || '',
            newPassword: fd.get('newPassword') || '',
            confirmPassword: fd.get('confirmPassword') || ''
          }),
          credentials: 'same-origin'
        });
        const body = await r.json();
        if (body.ok) {
          result.textContent = '✓ ' + body.message;
          result.style.color = 'var(--good)';
          pwForm.reset();
        } else {
          result.textContent = '✗ ' + body.message;
          result.style.color = 'var(--bad)';
        }
      } catch (err) {
        result.textContent = '✗ 网络错误: ' + err.message;
        result.style.color = 'var(--bad)';
      }
    });
  }

  showTab(location.hash.replace('#','') || 'overview');
</script>
</body></html>`;
}

// ---------------------------------------------------------------------------
// HTTP 路由
// ---------------------------------------------------------------------------

async function readBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', c => buf += c);
    req.on('end', () => resolve(buf));
  });
}

async function handleScript(req, res, url) {
  if (!checkAuth(req)) return redirectToLogin(res);
  const pkg = url.searchParams.get('pkg');
  const v = url.searchParams.get('v');
  const file = url.searchParams.get('file');
  if (!pkg || !v || !file) {
    res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('bad params'); return;
  }
  // 三段各自校验 + join 后确认仍在 packages 目录内(挡 pkg/v/file 任一段为 ..)。
  //
  // 用 _packagesDir() 而非模块级 PACKAGES_DIR const:后者在模块加载时就固定了
  // 默认 AGENT_DIR,startDashboard({agentDir}) 覆盖 _paths.agentDir 后不会跟着变,
  // 会导致非默认安装路径下读错目录(既有 bug,本次顺带修正)。
  const filePath = resolveSafeJoin(_packagesDir(), pkg, v, file);
  if (!filePath) {
    res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('bad params'); return;
  }
  try {
    const content = await fs.readFile(filePath, 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(content);
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  }
}

async function handleLog(req, res, url) {
  if (!checkAuth(req)) return redirectToLogin(res);
  const dir = url.searchParams.get('dir');
  const name = url.searchParams.get('name');
  const baseDir = dir === 'agent' ? _agentLogsDir() : _rootLogsDir();
  // 同 /script:name=.. 会逃出日志目录读到任意文件。
  const filePath = name ? resolveSafeJoin(baseDir, name) : null;
  if (!filePath) {
    res.writeHead(400); res.end('bad'); return;
  }
  try {
    const stat = await fs.stat(filePath);
    if (stat.size > 2 * 1024 * 1024) {
      res.writeHead(413); res.end('too large'); return;
    }
    const text = await fs.readFile(filePath, 'utf8');
    // tail last 500 lines
    const lines = text.split(/\r?\n/);
    const tail = lines.slice(-500).join('\n');
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(tail);
  } catch (e) {
    res.writeHead(404); res.end('not found');
  }
}

function redirectToLogin(res) {
  res.writeHead(302, { 'Location': '/login' });
  res.end();
}

async function handleLogin(req, res) {
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(loginPage(null));
    return;
  }
  if (req.method === 'POST') {
    const body = await readBody(req);
    const params = new URLSearchParams(body);
    const u = params.get('username') || '';
    const p = params.get('password') || '';
    if (u === data.username && p === data.plainPassword) {
      const token = newToken();
      sessions.add(token);
      res.writeHead(302, {
        'Location': '/',
        'Set-Cookie': 'dash_auth=' + token + '; HttpOnly; SameSite=Strict; Path=/'
      });
      res.end();
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(loginPage('用户名或密码错误'));
    }
    return;
  }
  res.writeHead(405); res.end();
}

function handleLogout(req, res) {
  const cookies = parseCookies(req.headers.cookie);
  if (cookies.dash_auth) sessions.delete(cookies.dash_auth);
  res.writeHead(302, {
    'Location': '/login',
    'Set-Cookie': 'dash_auth=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'
  });
  res.end();
}

// ---------------------------------------------------------------------------
// 改密码 — POST /password
//
// 接收 { oldPassword, newPassword },校验旧密码后,把新密码以 base64 编码覆写
// 写入 agent/appsettings.json 的 password 字段(其它字段保留)。写盘用 tmp
// + rename 原子写,失败要明确报错。
//
// 安全约束:
//   - 必须已登录(checkAuth 在 handlePasswordChange 入口校验)
//   - 必须验证旧密码(防 stolen cookie 改密码)
//   - 新密码长度 4-128(防过短易猜 / 过长可能误填)
//   - 写盘后立即同步 in-memory data.plainPassword,这样不需要重启 dashboard
//     也不需要重新登录就能继续用
// ---------------------------------------------------------------------------

const APPSETTINGS_PATH = path.join(_paths.agentDir, 'appsettings.json');

async function writePasswordAtomic(appsettingsPath, newPlainPassword) {
  // 1. 读当前文件(可能不存在 → 用空对象,等同于只有 password 一行)
  let current;
  try {
    const raw = await fs.readFile(appsettingsPath, 'utf8');
    current = JSON.parse(raw.replace(/^﻿/, ''));
  } catch (e) {
    if (e.code === 'ENOENT') {
      current = {};
    } else {
      throw new Error(`read appsettings.json failed: ${e.message}`);
    }
  }
  if (!current || typeof current !== 'object' || Array.isArray(current)) {
    throw new Error('appsettings.json is not a JSON object');
  }

  // 2. 计算新 password (base64)
  const newB64 = Buffer.from(newPlainPassword, 'utf8').toString('base64');

  // 3. 构造新对象(保留现有所有字段,只覆盖 password)
  //    用 Object.assign 避免 V8 切换隐藏类 — 对一个 JSON 文件没必要,直接浅拷:
  const next = { ...current, password: newB64 };

  // 4. 写 tmp + rename 原子写 — 防止写一半崩溃把原文件弄坏
  const json = JSON.stringify(next, null, 2);
  const tmpPath = appsettingsPath + '.tmp.' + process.pid + '.' + Date.now();
  // UTF-8 no-BOM — Node JSON.parse 拒绝带 BOM 的文件
  const utf8NoBom = new TextEncoder();  // 内部 UTF-8 不带 BOM
  await fs.writeFile(tmpPath, utf8NoBom.encode(json));
  try {
    await fs.rename(tmpPath, appsettingsPath);
  } catch (e) {
    // 清理残余 tmp
    try { await fs.unlink(tmpPath); } catch (_) {}
    throw new Error(`rename appsettings.json failed: ${e.message}`);
  }
  return newB64;
}

async function handlePasswordChange(req, res) {
  if (!checkAuth(req)) return redirectToLogin(res);
  if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
  const body = await readBody(req);
  // 同时支持表单编码(URLSearchParams)和 JSON(application/json)。
  // 前端默认 fetch 默认走表单;curl/Postman/API 用户偏好 JSON;两个都允许。
  let oldP = '', newP = '', confirmP = '';
  const ct = (req.headers['content-type'] || '').toLowerCase();
  if (ct.includes('application/json')) {
    try {
      // 容错 BOM:某些 HTTP 客户端会发 UTF-8 BOM 前缀(尤其 PowerShell [IO.File]::WriteAllText 默认)
      const clean = (body || '').replace(/^﻿/, '');
      const obj = JSON.parse(clean || '{}');
      oldP      = String(obj.oldPassword || '');
      newP      = String(obj.newPassword || '');
      confirmP  = String(obj.confirmPassword || '');
    } catch (e) {
      console.log(`[password] JSON parse error: ${e.message}`);
      respondPasswordResult(res, false, 'JSON 解析失败');
      return;
    }
  } else {
    const params = new URLSearchParams(body);
    oldP      = params.get('oldPassword') || '';
    newP      = params.get('newPassword') || '';
    confirmP  = params.get('confirmPassword') || '';
  }

  // 校验
  if (oldP !== data.plainPassword) {
    respondPasswordResult(res, false, '旧密码错误');
    return;
  }
  if (newP.length < 4 || newP.length > 128) {
    respondPasswordResult(res, false, '新密码长度必须在 4-128 字符之间');
    return;
  }
  if (newP !== confirmP) {
    respondPasswordResult(res, false, '两次输入的新密码不一致');
    return;
  }
  if (newP === oldP) {
    respondPasswordResult(res, false, '新密码不能与旧密码相同');
    return;
  }

  // 写盘
  try {
    await writePasswordAtomic(APPSETTINGS_PATH, newP);
  } catch (e) {
    respondPasswordResult(res, false, `写入失败: ${e.message}`);
    return;
  }

  // 同步 in-memory — 用户无需重新登录
  data.plainPassword = newP;
  // 顶替当前 session 不被破坏 — 用户体验上"刚刚改的密码"即生效
  respondPasswordResult(res, true, '密码已更新,新密码即时生效');
}

function respondPasswordResult(res, ok, message) {
  // JSON 响应,前端 fetch 用
  res.writeHead(ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ ok, message }));
}

async function handleRoot(req, res) {
  if (!checkAuth(req)) return redirectToLogin(res);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(mainPage());
}

// ---------------------------------------------------------------------------
// 启动 — 导出 startDashboard()
// ---------------------------------------------------------------------------

// startDashboard({ config, installRoot, agentDir, logger, bindAddress })
//   - config:        { username, plainPassword, port, centerUrl, agentId }
//                    (plainPassword 是 base64 解码后的明文;与登录表单比对)
//   - installRoot:   安装根(可选,默认 = INSTALL_ROOT)
//   - agentDir:      agent 子目录(可选,默认 = AGENT_DIR)
//   - logger:        { info(...), error(...) }  — 可选,默认 console
//   - bindAddress:   '127.0.0.1'(默认,只 loopback)或 '0.0.0.0'
// 返回: { server, port, stop() }
export async function startDashboard({
  config,
  installRoot = INSTALL_ROOT,
  agentDir = AGENT_DIR,
  logger = console,
  bindAddress = '127.0.0.1'
} = {}) {
  if (!config) throw new Error('startDashboard: config required');
  if (!config.username || !config.plainPassword) {
    throw new Error('startDashboard: config.username and plainPassword required');
  }

  // 把模块级常量在调用时覆盖到自定义路径 — 让 agent 可以从任意位置启 dashboard
  // (INSTALL_ROOT/AGENT_DIR 是模块加载时计算的,这里仅做指针覆盖):
  //   data / PACKAGES_DIR 等都用 path.join 重算,无需 mutable 全局。

  // 模块级 data 对象上注入本次启动的凭证与路径:
  data.username = config.username;
  data.plainPassword = config.plainPassword;
  data.centerUrl = config.centerUrl || '';
  data.agentId = config.agentId || '';
  data.startedAt = new Date().toISOString();

  // 路径依赖覆盖(影响 PACKAGES_DIR / LAST_COLLECT_DIR / INSTALL_ROOT / AGENT_DIR
  // 这四个常量在 loadPackages/loadLastCollect/loadLogs/handleLog 中的拼接基准)
  _paths.installRoot = installRoot;
  _paths.agentDir = agentDir;

  await refreshAll();

  // 后台 30 秒刷新 lastCollect + service + logs
  const refreshTimer = setInterval(async () => {
    try {
      data.lastCollect = await loadLastCollect();
      data.service = await loadService();
      data.logs = await loadLogs();
    } catch (e) {
      logger.warn?.(`[dashboard] refresh: ${e.message}`);
    }
  }, 30000);
  refreshTimer.unref();

  const server = http.createServer(async (req, res) => {
    let url;
    try { url = new URL(req.url, 'http://x'); } catch (e) { res.writeHead(400); res.end(); return; }
    try {
      if (url.pathname === '/login')   return await handleLogin(req, res);
      if (url.pathname === '/logout')  return handleLogout(req, res);
      if (url.pathname === '/password') return await handlePasswordChange(req, res);
      if (url.pathname === '/script')  return await handleScript(req, res, url);
      if (url.pathname === '/log')     return await handleLog(req, res, url);
      if (url.pathname === '/' || url.pathname === '/index.html') return await handleRoot(req, res);
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    } catch (e) {
      logger.error?.(`[dashboard] ${req.method} ${url.pathname}: ${e.stack || e.message}`);
      if (!res.headersSent) { res.writeHead(500); res.end('server error'); } else try { res.end(); } catch (_) {}
    }
  });

  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port || 8080, bindAddress, () => {
      server.off('error', reject);
      resolve();
    });
  });
  logger.info?.(`dashboard listening on http://${bindAddress}:${config.port}/  (user=${config.username}, install=${installRoot})`);

  return {
    server,
    port: config.port,
    stop: () => new Promise((resolve) => {
      clearInterval(refreshTimer);
      server.close(() => resolve());
      setTimeout(() => resolve(), 2000).unref();
    })
  };
}

// ---------------------------------------------------------------------------
// CLI 自启分支 — 仅当 `node dashboard/server.js` 直接运行时触发
// ---------------------------------------------------------------------------

function _isMain() {
  if (!process.argv[1]) return false;
  try {
    return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
  } catch (e) {
    return false;
  }
}

if (_isMain()) {
  // CLI 自启:读 appsettings.json + 启动 dashboard
  (async () => {
    const cfg = await loadAppsettings();
    const handle = await startDashboard({
      config: cfg,
      installRoot: INSTALL_ROOT,
      agentDir: AGENT_DIR,
      logger: console,
      bindAddress: '127.0.0.1'
    });

    function shutdown(s) {
      console.log(`received ${s}, shutting down`);
      handle.stop().then(() => process.exit(0));
      setTimeout(() => process.exit(0), 2000).unref();
    }
    process.on('SIGINT',  () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  })().catch((e) => {
    process.stderr.write(`[dashboard] start failed: ${e.stack || e.message}\n`);
    process.exit(1);
  });
}
