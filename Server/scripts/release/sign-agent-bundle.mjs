#!/usr/bin/env node
// R161.35 第 4 步 (2026-11-22) — 构建侧升级包签名脚本。
//
// ★ 它做什么:
//   扫一棵 agent 树 (agent.js + src/**/*.js + build-manifest.json),
//   按**与中心完全相同**的规则算每个文件的 sha256, 对
//   (version, gitCommit, 文件清单) 做 Ed25519 签名, 把签名块写成
//   <agentRoot>/bundle-signature.json。
//
// ★ 为什么签名在**构建侧**做, 而不是中心侧:
//   验签用的是**公钥** (放在 agent 侧)。如果中心也持有**私钥**, 那么
//   "中心被拿下" ⇒ 攻击者可以给任意包签名 ⇒ agent 验签失去意义。
//   ⇒ 私钥只存在于构建机; 中心只**转发**已经签好的包。
//   ⇒ 这就是本脚本存在的理由。
//
// ★ 用法:
//   node scripts/release/sign-agent-bundle.mjs --agent-root <agent树根> \
//        [--key <私钥PEM路径>] [--key-id <标识>] [--out <签名文件路径>]
//
//   默认:
//     --agent-root  = <repoRoot>/agent          (或 <repoRoot>/noadagent)
//     --key         = <repoRoot>/.secrets/release-signing-key.pem
//     --key-id      = 从文件名派生
//     --out         = <agentRoot>/bundle-signature.json
//
// ★ 生成密钥对 (只需一次, 之后把私钥**妥善保管**):
//   node scripts/release/sign-agent-bundle.mjs --generate-key \
//        [--key <私钥路径>] [--pub-out <公钥路径>]
//   ⇒ 私钥 PEM 写到 --key; 公钥 (base64 SPKI DER) 写到 --pub-out。
//   ⇒ 公钥要被放进 agent 树的 appsettings.json 的 releasePublicKey,
//     或者预置到 agent 的 config.js DEFAULTS 里 (随包分发)。
//
// ★ 幂等: 重复跑同一个 agent 树 ⇒ 同一个文件清单 ⇒ 同一个签名
//   (Ed25519 是确定性签名, 同样的载荷 ⇒ 同样的签名字节)。
//   ⇒ 除非文件内容变了, 否则 bundle-signature.json 的内容不变。
//
// ★ 失败语义: 任何一步失败 ⇒ **非零退出码** + stderr 明确原因。
//   (发布链脚本必须响亮失败 —— R161.23 的纪律: 缺失即中止, 绝不静默。)

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join, relative, sep, dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// scripts/release/ → 树根 (Server/)
const REPO_ROOT = resolve(__dirname, '..', '..');

// ★★★ "哪些文件进包"的规则**只有一份** —— 中心侧
//   agent-upgrade-source.js 导出的 shouldIncludeAgentFile。
//   本脚本 import 它, 而不是自己抄一份:
//     · 两边规则若不一致 ⇒ 签名覆盖的文件集合 ≠ 实际下发的文件集合
//       ⇒ 中心把预签名当成"描述的是另一个包"而丢弃 ⇒ 签名静默降级
//         为无签名 ⇒ 漏洞静默敞开 (日志里只有一行 warn, 极难发现)。
//     · 抄一份 = 把这个坑埋进代码里, 等某天有人改一边忘了另一边。
const { shouldIncludeAgentFile } = await import(
  new URL('../../center/src/services/agent-upgrade-source.js', import.meta.url).href
);

const EXCLUDED_DIRS = new Set([
  'node_modules', 'data', 'logs', 'publish', '.git',
  '.upgrade-staging', 'dist', 'coverage'
]);

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function walkAgentTree(rootDir) {
  const out = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      // 目录读不了 (权限/断链) —— 与中心侧同样**跳过**并继续, 但这里
      // 记到 stderr: 签名脚本是构建侧, 有权让操作员知道漏了东西。
      process.stderr.write(`[sign-agent-bundle] WARN cannot read dir ${dir}: ${err.message}\n`);
      continue;
    }
    for (const ent of entries) {
      const abs = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (EXCLUDED_DIRS.has(ent.name)) continue;
        stack.push(abs);
      } else if (ent.isFile()) {
        const rel = relative(rootDir, abs);
        if (shouldIncludeAgentFile(rel)) out.push(abs);
      }
    }
  }
  return out;
}

function readVersionFromMeta(rootDir) {
  const manifestPath = join(rootDir, 'build-manifest.json');
  if (existsSync(manifestPath)) {
    try {
      const parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (parsed && typeof parsed.version === 'string') {
        return {
          version: parsed.version,
          buildTime: parsed.buildTime ?? null,
          gitCommit: parsed.gitCommit ?? null
        };
      }
    } catch (err) {
      process.stderr.write(`[sign-agent-bundle] WARN build-manifest.json parse failed: ${err.message}\n`);
    }
  }
  const packageJsonPath = join(rootDir, 'package.json');
  if (existsSync(packageJsonPath)) {
    try {
      const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
      if (parsed && typeof parsed.version === 'string') {
        return { version: parsed.version, buildTime: null, gitCommit: null };
      }
    } catch (err) {
      process.stderr.write(`[sign-agent-bundle] WARN package.json parse failed: ${err.message}\n`);
    }
  }
  return null;
}

function parseArgs(argv) {
  const args = { generateKey: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--generate-key') { args.generateKey = true; continue; }
    if (a === '--agent-root') { args.agentRoot = argv[++i]; continue; }
    if (a === '--key') { args.key = argv[++i]; continue; }
    if (a === '--key-id') { args.keyId = argv[++i]; continue; }
    if (a === '--out') { args.out = argv[++i]; continue; }
    if (a === '--pub-out') { args.pubOut = argv[++i]; continue; }
    if (a === '--help' || a === '-h') { args.help = true; continue; }
    throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

function usage() {
  return [
    'usage:',
    '  node scripts/release/sign-agent-bundle.mjs --agent-root <dir> [--key <pem>] [--key-id <id>] [--out <json>]',
    '  node scripts/release/sign-agent-bundle.mjs --generate-key [--key <pem>] [--pub-out <txt>]',
    '',
    'notes:',
    `  default --agent-root : ${join(REPO_ROOT, 'agent')}`,
    `  default --key        : ${join(REPO_ROOT, '.secrets', 'release-signing-key.pem')}`,
    '  default --out        : <agent-root>/bundle-signature.json',
    '  the private key must NEVER be committed (.gitignore covers .secrets/).',
  ].join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  // 动态 import 中心的纯逻辑模块 —— 两边共用同一份实现, 避免
  // "签名脚本自己抄一份 canonicalize" 导致的不一致。
  const sigModule = await import('../../center/src/services/agent-bundle-signature.js');

  const keyPath = args.key || join(REPO_ROOT, '.secrets', 'release-signing-key.pem');

  if (args.generateKey) {
    if (!existsSync(keyPath)) {
      const pair = sigModule.generateKeyPair({
        keyId: args.keyId || 'release-signing-key'
      });
      mkdirSync(dirname(keyPath), { recursive: true });
      writeFileSync(keyPath, pair.privateKeyPem, { mode: 0o600 });
      process.stdout.write(`[sign-agent-bundle] private key written to ${keyPath}\n`);
      process.stdout.write('[sign-agent-bundle] KEY ID: ' + pair.keyId + '\n');
      const pubOut = args.pubOut || (keyPath.replace(/\.pem$/i, '') + '.pub.txt');
      writeFileSync(pubOut, pair.publicKeyBase64 + '\n', 'utf8');
      process.stdout.write(`[sign-agent-bundle] public key written to ${pubOut}\n`);
      process.stdout.write('[sign-agent-bundle] put the public key into the agent appsettings.json as releasePublicKey\n');
    } else {
      process.stderr.write(`[sign-agent-bundle] private key already exists at ${keyPath} — refusing to overwrite\n`);
      return 2;
    }
    return 0;
  }

  const agentRoot = args.agentRoot || join(REPO_ROOT, 'agent');
  if (!existsSync(agentRoot)) {
    process.stderr.write(`[sign-agent-bundle] agent tree not found: ${agentRoot}\n`);
    return 2;
  }
  if (!existsSync(keyPath)) {
    process.stderr.write(`[sign-agent-bundle] private key not found: ${keyPath}\n`);
    process.stderr.write('[sign-agent-bundle] generate one with: node scripts/release/sign-agent-bundle.mjs --generate-key\n');
    return 2;
  }
  const privateKeyPem = readFileSync(keyPath, 'utf8');
  const keyId = args.keyId
    || keyPath.split(/[\\/]/).pop().replace(/\.pem$/i, '')
    || 'release';

  const meta = readVersionFromMeta(agentRoot);
  if (!meta) {
    process.stderr.write(`[sign-agent-bundle] version unreadable under ${agentRoot} (no build-manifest.json / package.json)\n`);
    return 2;
  }

  const filePaths = walkAgentTree(agentRoot);
  if (filePaths.length === 0) {
    process.stderr.write(`[sign-agent-bundle] no files matched include rules under ${agentRoot}\n`);
    return 2;
  }
  const files = [];
  for (const absPath of filePaths) {
    let bytes;
    try {
      bytes = readFileSync(absPath);
    } catch (err) {
      process.stderr.write(`[sign-agent-bundle] read failed: ${absPath}: ${err.message}\n`);
      return 2;
    }
    const rel = relative(agentRoot, absPath).split(sep).join('/');
    files.push({ path: rel, sha256: sha256Hex(bytes) });
  }

  const block = sigModule.encodeBundleSignature({
    version: meta.version,
    gitCommit: meta.gitCommit,
    keyId,
    files,
    privateKeyPem
  });

  const outPath = args.out || join(agentRoot, 'bundle-signature.json');
  const payload = {
    ...block,
    // 附两个便于运维核对的字段 (不进签名载荷, 但便于人眼比对)。
    signedAt: new Date().toISOString(),
    fingerprint: sigModule.bundleFingerprint(files)
  };
  writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  process.stdout.write(`[sign-agent-bundle] signed ${files.length} files @ version ${meta.version} (keyId=${keyId})`);
  process.stdout.write(`\n[sign-agent-bundle] -> ${outPath}\n`);
  process.stdout.write(`[sign-agent-bundle] fingerprint ${payload.fingerprint}\n`);
  return 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    process.stderr.write(`[sign-agent-bundle] FATAL: ${err?.stack || err?.message || String(err)}\n`);
    process.exitCode = 1;
  });
