#!/usr/bin/env node
// R161.35 第 2 步 (2026-11-22) — member 动作清单一致性守卫.
//
// ★ 它守的是什么 (也是这个方案唯一的"信任边界"):
//
//   去掉自由 PowerShell 之后, 中心能下发的只有 { scriptId, args }。
//   "中心被拿下 ⇒ 成员机被拿下" 的路径之所以被切断, 靠的是三件事:
//     1. scriptId 必须落在**密封清单**里 ⇒ 攻击者不能凭空发明一个动作
//     2. 每个动作对应的 .ps1 的 sha256 必须与清单一致 ⇒ 不能在成员机上
//        改脚本 (agent 每次执行前对比)
//     3. 中心与 agent 的清单必须**逐项一致** ⇒ 中心校验过的参数, agent
//        一定认得; agent 认得的动作, 中心一定能校验
//
//   这个脚本守第 3 条 + 第 2 条。没有它, 两棵树会慢慢漂移:
//   中心多一个动作 (UI 能选) 而 agent 没有 ⇒ 每次选中都是静默失败;
//   agent 多一个动作而中心不知道 ⇒ 那个动作**没有任何中心侧校验**,
//   谁往库里写一条行就能直接触发它。
//
// ★ 检查项 (全部必须通过, 否则 exit 1):
//   1. 四方清单存在
//   2. 中心清单的 scriptId 集合 == agent 清单的 scriptId 集合
//   3. 每个 scriptId 的 args schema (type/optional/pattern/values/min/max/
//      maxLen) 完全一致 —— label 是纯显示, 允许不同
//   4. 每个 scriptId 的 timeoutSec 一致
//   5. agent 与 noadagent 两棵树逐字节一致 (清单 + 脚本 + dispatcher)
//   6. 每个 .ps1 存在, 且 sha256 == agent 清单里封印的摘要
//   7. agent 清单里的每个 `file` 没有多余项 (scripts/ 下不许有未入册的
//      member-*.ps1 —— 未入册的脚本不可达, 但它会让审计"看起来有"动作)
//
// ★ 为什么不用 spawn 跑 refresh-member-script-hashes.mjs: 那个脚本是
//   "写"工具, 守卫只读。两边都读同一份磁盘 → 不会互相掩盖 (守卫读的是
//   真实字节, 不是封印工具的输出)。
//
// Usage: node Server/scripts/audit/check-member-script-manifest.mjs
// Exit:  0 = 一致; 1 = 有不一致 (逐条打印); 2 = 文件缺失 (环境问题)

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = resolve(HERE, '..', '..');

const CENTER_MANIFEST = join(SERVER_ROOT, 'center', 'src', 'services', 'member-scripts-manifest.js');
const AGENT_TREES = [
  { name: 'agent', root: join(SERVER_ROOT, 'agent') },
  { name: 'noadagent', root: join(SERVER_ROOT, 'noadagent') }
];

const problems = [];
const notes = [];
function fail(msg) { problems.push(msg); }
function ok(msg) { notes.push(msg); }

// ── 0. 四方文件存在性 ──────────────────────────────────────────────────
if (!existsSync(CENTER_MANIFEST)) {
  console.error(`FATAL: center manifest missing: ${CENTER_MANIFEST}`);
  process.exit(2);
}
for (const t of AGENT_TREES) {
  const p = join(t.root, 'src', 'member-scripts.js');
  if (!existsSync(p)) {
    console.error(`FATAL: ${t.name} manifest missing: ${p} (第 2 步必须随 agent 发版)`);
    process.exit(2);
  }
}

// ── 1. 载入 ────────────────────────────────────────────────────────────
const { MEMBER_SCRIPTS: centerScripts, SCRIPT_IDS: centerIds } =
  await import(pathToFileURL(CENTER_MANIFEST).href);

const agentManifests = {};
for (const t of AGENT_TREES) {
  const p = join(t.root, 'src', 'member-scripts.js');
  const mod = await import(pathToFileURL(p).href);
  agentManifests[t.name] = { mod, path: p, root: t.root };
}

// ── 2. scriptId 集合一致 ───────────────────────────────────────────────
const centerSet = new Set(centerIds);
for (const [name, { mod }] of Object.entries(agentManifests)) {
  const agentSet = new Set(Object.keys(mod.MEMBER_SCRIPTS));
  for (const id of centerSet) {
    if (!agentSet.has(id)) fail(`${name}: 缺少动作 "${id}" (中心 UI 能选, agent 不认 ⇒ 选中即静默失败)`);
  }
  for (const id of agentSet) {
    if (!centerSet.has(id)) fail(`${name}: 多出动作 "${id}" (中心没有 schema ⇒ 该动作绕过全部中心侧校验)`);
  }
}

// ── 3/4. 逐项比较 schema 与 timeout ────────────────────────────────────
const SCHEMA_FIELDS = ['type', 'optional', 'maxLen', 'pattern', 'values', 'min', 'max'];
function sameJson(a, b) { return JSON.stringify(a ?? null) === JSON.stringify(b ?? null); }

for (const [name, { mod }] of Object.entries(agentManifests)) {
  for (const id of Object.keys(mod.MEMBER_SCRIPTS)) {
    const c = centerScripts[id];
    const a = mod.MEMBER_SCRIPTS[id];
    if (!c || !a) continue; // 上面已经报过

    if (c.timeoutSec !== a.timeoutSec) {
      fail(`${name}/${id}: timeoutSec 不一致 (center=${c.timeoutSec}, agent=${a.timeoutSec})`);
    }
    const cArgs = c.args || {};
    const aArgs = a.args || {};
    const names = new Set([...Object.keys(cArgs), ...Object.keys(aArgs)]);
    for (const arg of names) {
      if (!(arg in cArgs)) { fail(`${name}/${id}: 参数 "${arg}" 只在 agent 侧存在`); continue; }
      if (!(arg in aArgs)) { fail(`${name}/${id}: 参数 "${arg}" 只在中心侧存在`); continue; }
      for (const f of SCHEMA_FIELDS) {
        if (!sameJson(cArgs[arg][f], aArgs[arg][f])) {
          fail(`${name}/${id}.${arg}: 字段 ${f} 不一致 (center=${JSON.stringify(cArgs[arg][f])}, agent=${JSON.stringify(aArgs[arg][f])})`);
        }
      }
    }
  }
}

// ── 5. 两棵 agent 源树逐字节一致 ───────────────────────────────────────
// agent/ 与 noadagent/ 是同一份 dispatcher 的两个部署变体 —— 任何一边
// 单独改都会造成行为漂移 (B2 测试守 agent vs noadagent 的 dispatcher,
// 这里把清单 + 脚本也一起守住)。
const AGENT = join(SERVER_ROOT, 'agent');
const NOAD = join(SERVER_ROOT, 'noadagent');
const mirrorPairs = [
  ['src/member-scripts.js', 'src/member-scripts.js'],
  ['src/dispatchers/member-commands.js', 'src/dispatchers/member-commands.js']
];
const { MEMBER_SCRIPTS: agentScripts } = agentManifests.agent.mod;
for (const id of Object.keys(agentScripts)) {
  const f = agentScripts[id].file;
  mirrorPairs.push([`scripts/${f}`, `scripts/${f}`]);
}
for (const [a, b] of mirrorPairs) {
  const pa = join(AGENT, a);
  const pb = join(NOAD, b);
  if (!existsSync(pa)) { fail(`agent/${a} 不存在`); continue; }
  if (!existsSync(pb)) { fail(`noadagent/${b} 不存在`); continue; }
  if (!readFileSync(pa).equals(readFileSync(pb))) {
    fail(`Server/agent/${a} 与 Server/noadagent/${b} 不一致 (两棵 agent 树必须逐字节相同)`);
  }
}

// ── 6. sha256 封印 + 文件存在 ──────────────────────────────────────────
for (const [name, { mod, root }] of Object.entries(agentManifests)) {
  const scriptsDir = join(root, 'scripts');
  for (const [id, entry] of Object.entries(mod.MEMBER_SCRIPTS)) {
    if (!entry.file || typeof entry.file !== 'string') { fail(`${name}/${id}: 缺少 file`); continue; }
    if (!/^[a-z0-9][a-z0-9._-]*\.ps1$/.test(entry.file)) {
      fail(`${name}/${id}: file 必须是小写文件名 (${entry.file})`);
      continue;
    }
    const p = join(scriptsDir, entry.file);
    if (!existsSync(p)) { fail(`${name}/${id}: 脚本不存在 ${p}`); continue; }
    const digest = createHash('sha256').update(readFileSync(p)).digest('hex');
    if (!/^[0-9a-f]{64}$/.test(String(entry.sha256))) {
      fail(`${name}/${id}: sha256 未封印 (应运行 refresh-member-script-hashes.mjs)`);
    } else if (digest !== entry.sha256) {
      fail(`${name}/${id}: ${entry.file} 的 sha256 与封印不一致\n      disk  = ${digest}\n      sealed= ${entry.sha256}\n      ⇒ 文件被改动过; 若是有意修改, 请重新封印并随 agent 发版`);
    }
  }
}

// ── 7. scripts/ 下不许有未入册的 member-*.ps1 ──────────────────────────
// 未入册 = 不可达 (dispatcher 只认清单), 但一个躺在 scripts/ 里的
// "member-*.ps1" 会让人以为它是一个可用动作。宁可让它响亮失败。
for (const [name, { mod, root }] of Object.entries(agentManifests)) {
  const scriptsDir = join(root, 'scripts');
  if (!existsSync(scriptsDir)) { fail(`${name}: scripts/ 目录不存在`); continue; }
  const registered = new Set(Object.values(mod.MEMBER_SCRIPTS).map((e) => e.file));
  for (const f of readdirSync(scriptsDir)) {
    if (/^member-.*\.ps1$/i.test(f) && !registered.has(f)) {
      fail(`${name}: scripts/${f} 未登记在清单里 (不可达, 但会误导运维; 要么入册要么删除)`);
    }
  }
}

// ── 报告 ───────────────────────────────────────────────────────────────
const totalActions = centerSet.size;
if (problems.length > 0) {
  console.error(`\n✗ member 动作清单守卫失败: ${problems.length} 个问题 (${totalActions} 个动作)\n`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error('');
  process.exit(1);
}

console.log(`✓ member 动作清单一致 (${totalActions} 个动作 · ${AGENT_TREES.length} 棵 agent 树)`);
for (const id of centerIds) console.log(`    ${id.padEnd(20)} ${MEMBER_SCRIPTS_line(id)}`);
process.exit(0);

function MEMBER_SCRIPTS_line(id) {
  const e = centerScripts[id];
  const args = Object.keys(e.args || {}).join(', ') || '(无参数)';
  return `timeout ${String(e.timeoutSec).padStart(2)}s  args: ${args}`;
}
