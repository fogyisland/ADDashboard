// R161.25 (2026-10-29 部署审计) — appsettings.json 的落盘权限必须是 0600。
//
// ★ 要钉住的事实: appsettings.json 里是 **DB 口令 + jwtSecret + agentToken**。
//   旧实现 `writeFileSync(tmp, ..., 'utf8')` 让文件按 umask 落地
//   (POSIX 上典型 0644 = 同机任何用户可读) ⇒ 目标机上 `cat appsettings.json`
//   就把全部凭据交出去。
//
// ★ 为什么在**写的时候**定死权限, 而不是写完再 chmod:
//   "先 0644 落地、再 chmod 0600" 中间有一个任何人都能读的窗口;
//   writeFileSync 的 mode 只在**新建**时生效 ⇒ 临时文件可能是上一轮留下的
//   (0644) ⇒ 落盘后再显式 chmod 一次, 保证结果与"新建"一致;
//   rename 保留 inode 权限 ⇒ 最终文件就是 0600。
//
// ⚠ Windows 上 chmod 只映射到"只读属性", **不是** NTFS ACL ⇒ 这条断言在
//   Windows 上**不成立** (Node 会把 mode 报成 0666 / 0444)。所以:
//   · POSIX (Linux 交付包) ⇒ 必须 0600, 硬断言;
//   · Windows ⇒ 只断言"文件内容与配置正确", 权限由安装脚本/ACL 负责。
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeConfig, patchConfigAtomic, patchListenPortAtomic } from '../src/init/config-writer.js';

const IS_POSIX = process.platform !== 'win32';

function sampleConfig(overrides = {}) {
  return {
    path: overrides.path,
    dialect: 'mysql',
    connParams: { host: 'db.example.internal', database: 'addashboard', user: 'addash', password: 'S3cret-Passw0rd' },
    listenPort: 8080,
    agentToken: 'agent-token-abcdef0123456789',
    jwtSecret: 'jwt-secret-abcdef0123456789',
    logLevel: 'info',
    env: 'prod',
    staticDir: './dist'
  };
}

describe('R161.25: appsettings.json 的落盘权限必须是 0600', () => {
  let dir = null;
  let cfgPath = null;

  test('writeConfig 写出的文件权限', () => {
    dir = mkdtempSync(join(tmpdir(), 'addashboard-cfgperm-'));
    cfgPath = join(dir, 'appsettings.json');
    writeConfig(sampleConfig({ path: cfgPath }));

    const st = statSync(cfgPath);
    if (IS_POSIX) {
      assert.equal(
        st.mode & 0o777,
        0o600,
        `appsettings.json 的权限必须是 0600 (含 DB 口令/jwtSecret/agentToken), 实际是 ${(st.mode & 0o777).toString(8)}`
      );
    } else {
      // Windows: chmod 只映射只读属性 ⇒ 只断言"文件确实写出来了且内容完整"。
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
      assert.equal(cfg.db.dialect, 'mysql');
      assert.equal(cfg.db.mysql.password, 'S3cret-Passw0rd');
    }
  });

  test('临时文件不能以宽权限留在磁盘上 (tmp 残留 = 凭据泄漏)', () => {
    if (!IS_POSIX) return;
    const leftovers = readdirSync(dir).filter((n) => n.startsWith('.appsettings.json'));
    assert.deepEqual(leftovers, [], `写完必须不留临时文件: ${leftovers.join(', ')}`);
  });

  test('patchConfigAtomic 不放宽权限 (懒写 signature/installedAt 的路径)', () => {
    if (!IS_POSIX) return;
    const out = patchConfigAtomic({ path: cfgPath, patch: { signature: 'sig-1234', installedAt: '2026-10-29T00:00:00.000Z' } });
    assert.equal(out.changed, true);
    const st = statSync(cfgPath);
    assert.equal(
      st.mode & 0o777,
      0o600,
      `patch 之后权限必须仍是 0600, 实际是 ${(st.mode & 0o777).toString(8)}`
    );
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    assert.equal(cfg.signature, 'sig-1234');
    assert.equal(cfg.db.mysql.password, 'S3cret-Passw0rd', 'patch 不得丢掉原有凭据');
  });

  test('清理临时目录', () => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });
});

// R161.25 (2026-10-29 部署审计) — 改端口的那条写路径必须是**安全**的。
//
// ★ 为什么单独拎出来: patchConfigAtomic 的契约是"写完复验, 校验不过就把
//   文件 unlink 掉" (设计意图: 启动期补字段写坏了就退回初始化向导重来)。
//   但端口是**运行期**改的 —— 一次手滑的端口值就会把**装着 DB 口令 +
//   jwtSecret + agentToken 的生产凭据文件删掉**, 服务随即掉进"配置没了"
//   的状态 (marker 已锁 ⇒ 直接 exit 2, 中心起不来)。
//   ⇒ patchListenPortAtomic 的契约: 落盘**前**校验合并后的对象, 不合格就
//   throw, **磁盘上什么都不动** (没有临时文件, 没有 unlink)。
describe('R161.25: 改端口的写路径不许毁掉凭据文件', () => {
  let dir = null;
  let cfgPath = null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'addashboard-cfgport-'));
    cfgPath = join(dir, 'appsettings.json');
    writeConfig(sampleConfig({ path: cfgPath }));
  });

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  test('非法端口 ⇒ throw, 文件原封不动, 且不留临时文件', () => {
    const before = readFileSync(cfgPath, 'utf8');
    assert.throws(() => patchListenPortAtomic({ path: cfgPath, listenPort: 'abc' }));
    assert.throws(() => patchListenPortAtomic({ path: cfgPath, listenPort: 80 }));
    assert.throws(() => patchListenPortAtomic({ path: cfgPath, listenPort: 70000 }));
    assert.equal(readFileSync(cfgPath, 'utf8'), before, '凭据文件必须一个字节都没变');
    assert.deepEqual(
      readdirSync(dir).filter(n => n.startsWith('.appsettings.json')),
      [],
      '不许留临时文件'
    );
  });

  test('合法端口 ⇒ 只改 listenPort, 凭据原样保留, 权限仍是 0600', () => {
    const out = patchListenPortAtomic({ path: cfgPath, listenPort: 8090 });
    assert.equal(out.changed, true);
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    assert.equal(cfg.listenPort, 8090);
    assert.equal(cfg.db.mysql.password, 'S3cret-Passw0rd', '凭据不得丢');
    assert.equal(cfg.jwtSecret, 'jwt-secret-abcdef0123456789');
    if (IS_POSIX) {
      assert.equal(statSync(cfgPath).mode & 0o777, 0o600, '改完权限必须仍是 0600');
    }
  });
});
