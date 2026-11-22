// R161.35 第 4 步 — 升级包 Ed25519 签名的回归网。
//
// 覆盖三组:
//   A. 纯逻辑 (canonicalize / sign / verify)
//   B. agent 侧双轨判定 (带签名必验 / 无签名放行 / 验签失败拒收)
//   C. 中心侧 source loader (预签名转发 / 错配拒绝 / 无签名降级)
//   D. 端到端 (构建脚本 → 中心转发 → agent 验签)
//   E. 源码级不变量 (四棵 agent 树都有验签闸门)
//
// ★ 为什么必须有 E (源码级): 本次改动横跨 4 棵 agent 树 + 中心 2 棵
//   镜像树 (Server/ 与 LinuxServer/center/)。任何一棵漏改 = 该血统的
//   agent 完全没有验签能力, 而**功能测试发现不了** (因为它测的是
//   被改过的那棵)。源码级断言把"每一棵都必须有"钉死。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CENTER_ROOT = resolve(__dirname, '..', '..');
const REPO_ROOT = resolve(CENTER_ROOT, '..');

const centerSig = await import(pathToFileURL(join(CENTER_ROOT, 'src', 'services', 'agent-bundle-signature.js')).href);
const agentSig = await import(pathToFileURL(join(REPO_ROOT, 'agent', 'src', 'lib', 'bundle-signature.js')).href);
const centerSource = await import(pathToFileURL(join(CENTER_ROOT, 'src', 'services', 'agent-upgrade-source.js')).href);
const centerKeySvc = await import(pathToFileURL(join(CENTER_ROOT, 'src', 'services', 'release-signing-key.js')).href);

const noopLogger = { info() {}, warn() {}, error() {} };

// ------------------------------------------------------------------
// A. 纯逻辑
// ------------------------------------------------------------------

describe('R161.35 第 4 步 A — 签名纯逻辑', () => {
  test('A1. 签名 → 验签 通过', () => {
    const pair = centerSig.generateKeyPair({ keyId: 'k1' });
    const files = [
      { path: 'agent.js', sha256: 'aa'.repeat(32) },
      { path: 'src/x.js', sha256: 'bb'.repeat(32) }
    ];
    const payload = centerSig.buildSignaturePayload({
      version: '0.1.5', gitCommit: 'abc', keyId: pair.keyId, files
    });
    const signed = centerSig.signPayload({ privateKeyPem: pair.privateKeyPem, payload });
    const verdict = centerSig.verifyPayload({
      payload, signature: signed.signature, publicKeyBase64: pair.publicKeyBase64
    });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.reason, null);
  });

  test('A2. 文件清单顺序不影响验签 (两侧各自排序)', () => {
    // ★ 这是最容易踩的坑: 签名方按自己的顺序算载荷, 验签方按**收到的**
    //   顺序算载荷 ⇒ 不排序就必然不一致。
    const pair = centerSig.generateKeyPair({ keyId: 'k1' });
    const files = [
      { path: 'agent.js', sha256: 'aa'.repeat(32) },
      { path: 'src/x.js', sha256: 'bb'.repeat(32) }
    ];
    const payload = centerSig.buildSignaturePayload({
      version: '0.1.5', gitCommit: 'abc', keyId: pair.keyId, files
    });
    const signed = centerSig.signPayload({ privateKeyPem: pair.privateKeyPem, payload });
    const shuffled = { ...payload, files: [payload.files[1], payload.files[0]] };
    const verdict = centerSig.verifyPayload({
      payload: shuffled, signature: signed.signature, publicKeyBase64: pair.publicKeyBase64
    });
    assert.equal(verdict.ok, true, '顺序不同也必须验签通过');
  });

  test('A3. 篡改任一字段 ⇒ 验签失败 (逐项)', () => {
    const pair = centerSig.generateKeyPair({ keyId: 'k1' });
    const files = [{ path: 'agent.js', sha256: 'aa'.repeat(32) }];
    const payload = centerSig.buildSignaturePayload({
      version: '0.1.5', gitCommit: 'abc', keyId: pair.keyId, files
    });
    const signed = centerSig.signPayload({ privateKeyPem: pair.privateKeyPem, payload });
    const base = { signature: signed.signature, publicKeyBase64: pair.publicKeyBase64 };
    const mutations = [
      ['version', { ...payload, version: '9.9.9' }],
      ['gitCommit', { ...payload, gitCommit: 'evil' }],
      ['keyId', { ...payload, keyId: 'other' }],
      ['file sha256', { ...payload, files: [{ path: 'agent.js', sha256: 'cc'.repeat(32) }] }],
      ['file 少一个', { ...payload, files: [], fileCount: 0 }],
      ['payloadVersion', { ...payload, payloadVersion: 99 }],
      ['algorithm', { ...payload, algorithm: 'rsa' }]
    ];
    for (const [label, mutated] of mutations) {
      const verdict = centerSig.verifyPayload({ payload: mutated, ...base });
      assert.equal(verdict.ok, false, `${label} 被篡改后必须验签失败`);
    }
  });

  test('A4. 中心侧与 agent 侧的 canonicalize 逐字一致 (跨树契约)', () => {
    // ★ 两棵树各有一份实现 (agent 包必须自包含) ⇒ 必须锁住"逐字一致",
    //   否则中心签出来的包 agent 验不过 ⇒ 整队 agent 拒收升级。
    const files = [
      { path: 'src/b.js', sha256: 'AA'.repeat(32) },
      { path: 'agent.js', sha256: 'BB'.repeat(32) }
    ];
    const payload = centerSig.buildSignaturePayload({
      version: '1.2.3', gitCommit: 'deadbeef', keyId: 'k', files
    });
    const a = centerSig.canonicalizePayload(payload).toString('utf8');
    const b = agentSig.canonicalizePayload(payload).toString('utf8');
    assert.equal(a, b, '中心侧与 agent 侧的 canonicalize 必须逐字一致');
  });
});

// ------------------------------------------------------------------
// B. agent 侧双轨判定
// ------------------------------------------------------------------

describe('R161.35 第 4 步 B — agent 双轨判定', () => {
  const pair = centerSig.generateKeyPair({ keyId: 'k1' });
  const files = [{ path: 'agent.js', sha256: 'aa'.repeat(32) }];
  const block = centerSig.encodeBundleSignature({
    version: '0.1.5', gitCommit: 'abc', keyId: pair.keyId, files,
    privateKeyPem: pair.privateKeyPem
  });

  test('B1. 带签名 + 验签通过 ⇒ signed-verified', () => {
    const v = agentSig.evaluateBundleSignature({
      bundle: { files, signature: block }, publicKeyBase64: pair.publicKeyBase64
    });
    assert.equal(v.mode, 'signed-verified');
  });

  test('B2. 不带签名 ⇒ unsigned (双轨放行)', () => {
    const v = agentSig.evaluateBundleSignature({
      bundle: { files }, publicKeyBase64: pair.publicKeyBase64
    });
    assert.equal(v.mode, 'unsigned');
  });

  test('B3. 带签名 + 内容被改 ⇒ rejected (拒收)', () => {
    const tampered = [{ path: 'agent.js', sha256: 'cc'.repeat(32) }];
    const v = agentSig.evaluateBundleSignature({
      bundle: { files: tampered, signature: block }, publicKeyBase64: pair.publicKeyBase64
    });
    assert.equal(v.mode, 'rejected');
    assert.equal(v.reason, 'signature-mismatch');
  });

  test('B4. 带签名 + 没有公钥 ⇒ rejected (fail-closed)', () => {
    // ★ 关键: 若"没公钥就放行", 攻击者只要**删掉签名字段**就能绕过
    //   验签 ⇒ 验签形同虚设。
    const v = agentSig.evaluateBundleSignature({
      bundle: { files, signature: block }, publicKeyBase64: ''
    });
    assert.equal(v.mode, 'rejected');
    assert.equal(v.reason, 'missing-public-key');
  });

  test('B5. 带签名 + 错误公钥 ⇒ rejected', () => {
    const other = centerSig.generateKeyPair({ keyId: 'other' });
    const v = agentSig.evaluateBundleSignature({
      bundle: { files, signature: block }, publicKeyBase64: other.publicKeyBase64
    });
    assert.equal(v.mode, 'rejected');
    assert.equal(v.reason, 'signature-mismatch');
  });

  test('B6. 畸形公钥 / 畸形签名 / 签名长度不对 ⇒ rejected', () => {
    const cases = [
      [{ files, signature: block }, 'not-a-key', 'malformed-public-key'],
      [{ files, signature: { ...block, signature: 'AAAA' } }, pair.publicKeyBase64, 'malformed-signature'],
      [{ files, signature: { ...block, signature: '' } }, pair.publicKeyBase64, 'missing-signature']
    ];
    for (const [bundle, pk, expectedReason] of cases) {
      const v = agentSig.evaluateBundleSignature({ bundle, publicKeyBase64: pk });
      assert.equal(v.mode, 'rejected');
      assert.equal(v.reason, expectedReason);
    }
  });

  test('B7. 文件数与签名块声明不符 ⇒ rejected', () => {
    const v = agentSig.evaluateBundleSignature({
      bundle: { files: files.slice(0, 0), signature: block },
      publicKeyBase64: pair.publicKeyBase64
    });
    assert.equal(v.mode, 'rejected');
    assert.equal(v.reason, 'file-count-mismatch');
  });
});

// ------------------------------------------------------------------
// C. 中心侧 source loader
// ------------------------------------------------------------------

describe('R161.35 第 4 步 C — 中心 source loader', () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'ad-sign-'));
  const agentRoot = join(tmpRoot, 'agent');
  mkdirSync(join(agentRoot, 'src'), { recursive: true });
  writeFileSync(join(agentRoot, 'agent.js'), 'export const VERSION = "0.1.5";\n', 'utf8');
  writeFileSync(join(agentRoot, 'src', 'a.js'), 'export const A = 1;\n', 'utf8');
  writeFileSync(join(agentRoot, 'build-manifest.json'),
    JSON.stringify({ version: '0.1.5', buildTime: '2026-11-22T00:00:00Z', gitCommit: 'abc123' }), 'utf8');
  writeFileSync(join(agentRoot, 'notes.md'), 'should not be included\n', 'utf8');

  const pair = centerSig.generateKeyPair({ keyId: 'k1' });
  const realFiles = [
    { path: 'agent.js', sha256: null },
    { path: 'build-manifest.json', sha256: null },
    { path: 'src/a.js', sha256: null }
  ];
  // 用中心自己的 loader 算一遍 sha256 (保证与 loader 的 include 规则一致)。
  for (const f of realFiles) {
    f.sha256 = createHash('sha256')
      .update(readFileSync(join(agentRoot, f.path)))
      .digest('hex');
  }
  const presigned = centerSig.encodeBundleSignature({
    version: '0.1.5', gitCommit: 'abc123', keyId: pair.keyId, files: realFiles,
    privateKeyPem: pair.privateKeyPem
  });

  test('C1. 预签名与实际包匹配 ⇒ 原样转发', async () => {
    const source = await centerSource.getAgentUpgradeSource(agentRoot, noopLogger, { presigned });
    assert.ok(source, 'source 必须可用');
    assert.ok(source.signature, '签名必须被带上');
    assert.equal(source.signature.signature, presigned.signature);
    assert.equal(source.fileCount, 3, '.md 不该被算进来 (include 规则)');
  });

  test('C2. 预签名与实际包**不匹配** ⇒ 拒绝转发 (降级为无签名)', async () => {
    // ★ 绝不转发一个"描述的是另一个包"的签名 —— 那等于把验签变成
    //   摆设 (攻击者可以拿旧包的签名配新包)。
    const stale = centerSig.encodeBundleSignature({
      version: '0.1.4', gitCommit: 'old', keyId: pair.keyId, files: realFiles,
      privateKeyPem: pair.privateKeyPem
    });
    const source = await centerSource.getAgentUpgradeSource(agentRoot, noopLogger, { presigned: stale });
    assert.equal(source.signature, null, '版本不匹配的预签名必须被丢弃');
    // fileCount 也不匹配的情况
    const wrongCount = { ...presigned, fileCount: 99 };
    const source2 = await centerSource.getAgentUpgradeSource(agentRoot, noopLogger, { presigned: wrongCount });
    assert.equal(source2.signature, null, '文件数不匹配的预签名必须被丢弃');
  });

  test('C3. 没有签名材料 ⇒ 无签名降级 (但**不**让升级源作废)', async () => {
    const source = await centerSource.getAgentUpgradeSource(agentRoot, noopLogger, {});
    assert.ok(source, '升级源必须仍然可用 —— 签名是加固, 不是功能前提');
    assert.equal(source.signature, null);
  });

  test('C4. 签名失败 ⇒ 降级为无签名, 不抛', async () => {
    const source = await centerSource.getAgentUpgradeSource(agentRoot, noopLogger, {
      privateKeyPem: '-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n',
      keyId: 'broken'
    });
    assert.ok(source, '签名失败不得让升级源作废');
    assert.equal(source.signature, null);
  });

  test('C5. 签名策略解析: 预签名优先 / 中心签名需显式开关', () => {
    // 预签名文件存在 ⇒ mode='presigned'
    const sigPath = join(agentRoot, 'bundle-signature.json');
    writeFileSync(sigPath, JSON.stringify(presigned), 'utf8');
    const s1 = centerKeySvc.resolveSigningStrategy({ agentRoot, repoRoot: tmpRoot, logger: noopLogger });
    assert.equal(s1.mode, 'presigned');
    assert.equal(s1.signing, null, '预签名模式下中心**不**持有私钥');

    // 没有预签名文件 + 中心签名开关关闭 ⇒ mode='none'
    rmSync(sigPath, { force: true });
    const prev = process.env[centerKeySvc.ENV_CENTER_SIGNING];
    delete process.env[centerKeySvc.ENV_CENTER_SIGNING];
    const s2 = centerKeySvc.resolveSigningStrategy({ agentRoot, repoRoot: tmpRoot, logger: noopLogger });
    assert.equal(s2.mode, 'none');
    if (prev !== undefined) process.env[centerKeySvc.ENV_CENTER_SIGNING] = prev;
  });

  test('C6. 中心签名开关打开但没有私钥 ⇒ 降级为 none (不假装能签)', () => {
    const prev = process.env[centerKeySvc.ENV_CENTER_SIGNING];
    const prevKey = process.env[centerKeySvc.ENV_KEY_FILE];
    process.env[centerKeySvc.ENV_CENTER_SIGNING] = '1';
    process.env[centerKeySvc.ENV_KEY_FILE] = join(tmpRoot, 'nonexistent.pem');
    const s = centerKeySvc.resolveSigningStrategy({ agentRoot, repoRoot: tmpRoot, logger: noopLogger });
    assert.equal(s.mode, 'none');
    if (prev === undefined) delete process.env[centerKeySvc.ENV_CENTER_SIGNING];
    else process.env[centerKeySvc.ENV_CENTER_SIGNING] = prev;
    if (prevKey === undefined) delete process.env[centerKeySvc.ENV_KEY_FILE];
    else process.env[centerKeySvc.ENV_KEY_FILE] = prevKey;
  });
});

// ------------------------------------------------------------------
// D. 端到端: 构建脚本 → 中心转发 → agent 验签
// ------------------------------------------------------------------

describe('R161.35 第 4 步 D — 端到端 (构建脚本 → 中心 → agent)', () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'ad-e2e-'));
  const agentRoot = join(tmpRoot, 'agent');
  mkdirSync(join(agentRoot, 'src'), { recursive: true });
  writeFileSync(join(agentRoot, 'agent.js'), 'export const VERSION = "0.1.5";\n', 'utf8');
  writeFileSync(join(agentRoot, 'src', 'a.js'), 'export const A = 1;\n', 'utf8');
  writeFileSync(join(agentRoot, 'build-manifest.json'),
    JSON.stringify({ version: '0.1.5', buildTime: '2026-11-22T00:00:00Z', gitCommit: 'e2e' }), 'utf8');

  const keyPath = join(tmpRoot, 'release.pem');
  const pubPath = join(tmpRoot, 'release.pub.txt');
  const scriptPath = join(REPO_ROOT, 'scripts', 'release', 'sign-agent-bundle.mjs');

  test('D1. 生成密钥 → 签名 → 中心转发 → agent 验签通过', () => {
    execFileSync(process.execPath, [scriptPath, '--generate-key', '--key', keyPath, '--pub-out', pubPath], {
      stdio: 'pipe', encoding: 'utf8'
    });
    assert.ok(existsSync(keyPath), '私钥文件必须被生成');
    const pub = readFileSync(pubPath, 'utf8').trim();
    assert.ok(pub.length > 0, '公钥必须被生成');

    execFileSync(process.execPath, [scriptPath, '--agent-root', agentRoot, '--key', keyPath], {
      stdio: 'pipe', encoding: 'utf8'
    });
    const sigPath = join(agentRoot, 'bundle-signature.json');
    assert.ok(existsSync(sigPath), '签名文件必须被生成');

    // 中心侧 loader 转发它
    const presigned = JSON.parse(readFileSync(sigPath, 'utf8'));
    return centerSource.getAgentUpgradeSource(agentRoot, noopLogger, { presigned })
      .then((source) => {
        assert.ok(source.signature, '中心必须转发签名');
        // agent 侧验签
        const files = source.files.map((f) => ({ path: f.path, sha256: f.sha256 }));
        const v = agentSig.evaluateBundleSignature({
          bundle: { files, signature: source.signature }, publicKeyBase64: pub
        });
        assert.equal(v.mode, 'signed-verified', '端到端必须验签通过');
      });
  });

  test('D2. 构建脚本对不存在的私钥 ⇒ 非零退出码 (响亮失败)', () => {
    let code = 0;
    try {
      execFileSync(process.execPath,
        [scriptPath, '--agent-root', agentRoot, '--key', join(tmpRoot, 'nope.pem')],
        { stdio: 'pipe', encoding: 'utf8' });
    } catch (e) {
      code = e.status;
    }
    assert.notEqual(code, 0, '缺私钥必须非零退出 (发布链不能静默放过)');
  });
});

// ------------------------------------------------------------------
// E. 源码级不变量: 每棵 agent 树都必须有验签闸门
// ------------------------------------------------------------------

describe('R161.35 第 4 步 E — 四棵 agent 树都有验签闸门', () => {
  const AGENT_TREES = [
    join(REPO_ROOT, 'agent'),
    join(REPO_ROOT, 'noadagent'),
    join(REPO_ROOT, '..', 'ADAgent', 'agent'),
    join(REPO_ROOT, '..', 'MemberAgent', 'agent')
  ];

  test('E1. 每棵树的 upgrade-delivery.js 都做验签判定', () => {
    for (const tree of AGENT_TREES) {
      const p = join(tree, 'src', 'upgrade-delivery.js');
      assert.ok(existsSync(p), `agent 树缺失: ${p}`);
      const src = readFileSync(p, 'utf8');
      assert.match(src, /evaluateBundleSignature/, `${p} 缺少验签调用`);
      assert.match(src, /signature-invalid/, `${p} 缺少拒收分支`);
      // 拒收必须在写盘之前 —— 判据: 验签调用出现在 Stage 3 (writeFileSync
      // 所在的 Stage 3 注释) 之前。
      const sigAt = src.indexOf('evaluateBundleSignature');
      const writeAt = src.indexOf('writeFileSync(stagingPath');
      assert.ok(sigAt > 0, `${p} 找不到验签调用`);
      assert.ok(writeAt > 0, `${p} 找不到 staging 写盘`);
      assert.ok(sigAt < writeAt, `${p} 验签必须在写盘之前 (否则拒收时磁盘已被污染)`);
    }
  });

  test('E2. 每棵树都有 bundle-signature.js 且四份逐字一致', () => {
    const contents = [];
    for (const tree of AGENT_TREES) {
      const p = join(tree, 'src', 'lib', 'bundle-signature.js');
      assert.ok(existsSync(p), `agent 树缺失: ${p}`);
      contents.push(readFileSync(p, 'utf8'));
    }
    for (const c of contents) {
      assert.equal(c, contents[0], '四棵树的 bundle-signature.js 必须逐字一致');
    }
  });

  test('E3. 每棵树的 config.js 都有 releasePublicKey 默认值', () => {
    for (const tree of AGENT_TREES) {
      const p = join(tree, 'src', 'config.js');
      assert.ok(existsSync(p), `agent 树缺失: ${p}`);
      const src = readFileSync(p, 'utf8');
      assert.match(src, /releasePublicKey/, `${p} 缺少 releasePublicKey 默认值`);
    }
  });

  test('E4. 中心的两个镜像树 (Server/ 与 LinuxServer/) 都有签名转发', () => {
    for (const root of [CENTER_ROOT, join(REPO_ROOT, '..', 'LinuxServer', 'center')]) {
      const p = join(root, 'src', 'routes', 'agent-upgrade.js');
      assert.ok(existsSync(p), `中心镜像树缺失: ${p}`);
      const src = readFileSync(p, 'utf8');
      assert.match(src, /signature/, `${p} 缺少签名转发`);
    }
  });
});
