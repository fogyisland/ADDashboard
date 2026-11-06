// R161.5 — seedBuiltinPackages 的回归网
//
// 背景 (操作员 2026-10-26 报 "seeds 的包不对" + "GET /api/os-baseline 500"):
//   5 个包的 manifest.json 里 name 写成连字符 (ad-os-baseline), 与包目录名
//   / DB 名 (ad_os_baseline) 不一致 ⇒ script-service.validateManifest 抛
//   INVALID_MANIFEST ⇒ seeder 在 installScript 之前就把整包跳过 ⇒ 包从未
//   注册 ⇒ pkg_* schema 从未创建 ⇒ API 500。
//   而这个失败是**静默**的: per-package catch 只 console.warn, 而 center
//   的 pino stdout 是空的 (日志只进 center/Logs/center.<date>.<n>.log)
//   ⇒ 操作员在日志文件里永远看不到失败原因 ⇒ 半年没人发现。
//   另有一个同族缺陷: ad_admin_members/1.0.2 的 collect.ps1 丢了
//   ⇒ readFileSync ENOENT ⇒ 整包跳过。
//
// 本文件锁定 6 件事:
//   1. 正常路径: 14 个内置包全部被复制到 dataDir (manifest + 脚本都在)
//   2. manifest 身份不符 ⇒ 用内置源覆盖修复 (不是静默跳过)
//   3. 脚本文件缺失 ⇒ 从内置源补回
//   4. sourceDir === dataDir (operator 的实际布局: server.js 的
//      dataDir = cwd + '/data/packages', cwd=Server/center 时 cwd 就是
//      sourceDir) ⇒ 不自拷贝、不截断文件
//   5. 同树 + manifest 身份错 ⇒ 报**人话**错误 (不是玄学 ENOENT/EINVAL)
//   6. per-package 失败 ⇒ 落 logger.error (而不是只 console.warn)
//
// 不传 db ⇒ seeder 只跑文件层逻辑 (DB 注册 / DDL apply 都在 `if (db)` 里),
// 测试不碰真库。
//
// 用法: cd Server/center && node --test tests/builtin-packages-seed.test.js

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, cpSync, mkdirSync, writeFileSync,
  readFileSync, existsSync, readdirSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { seedBuiltinPackages, BUILTIN_PACKAGES } from '../src/services/builtin-packages.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CENTER_ROOT = path.resolve(HERE, '..');
const REAL_PACKAGES = path.join(CENTER_ROOT, 'data', 'packages');

/** 记录 warn/error 的 logger 桩 (production 传的是 pino logger)。 */
function makeLogger() {
  const warns = [];
  const errors = [];
  const infos = [];
  return {
    warns,
    errors,
    infos,
    warn: (obj, msg) => { warns.push({ obj, msg }); },
    error: (obj, msg) => { errors.push({ obj, msg }); },
    info: (obj, msg) => { infos.push({ obj, msg }); }
  };
}

/**
 * 造一个 fixture:
 *   src = 内置源的一份拷贝 (模拟 publish 镜像 / 交付包)
 *   dst = runtime dataDir (操作员那边被污染的树)
 * sameTree=true 时 src === dst (operator 的实际布局)。
 */
function makeFixture({ sameTree = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'r161-5-seed-'));
  const src = path.join(root, 'src');
  cpSync(REAL_PACKAGES, src, { recursive: true });
  const dst = sameTree ? src : path.join(root, 'dst');
  if (!sameTree) mkdirSync(dst, { recursive: true });
  return { root, src, dst };
}

function cleanup(fixture) {
  rmSync(fixture.root, { recursive: true, force: true });
}

/** 递归列出相对路径 + 内容 sha, 用于"文件没被改坏"的断言。 */
function snapshotTree(dir) {
  const out = new Map();
  const walk = (rel) => {
    const abs = path.join(dir, rel);
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) walk(childRel);
      else {
        const buf = readFileSync(path.join(abs, entry.name));
        // sha256 —— 不引入 crypto 依赖, 用长度 + 简单 hash 足够
        // (断言的是"内容没变", 不是密码学强度)。
        let h = 0;
        for (let i = 0; i < buf.length; i++) h = (h * 31 + buf[i]) | 0;
        out.set(childRel, `${buf.length}:${h}`);
      }
    }
  };
  walk('');
  return out;
}

function readManifest(dir, pkg, version) {
  const raw = readFileSync(path.join(dir, pkg, version, 'manifest.json'), 'utf8');
  return JSON.parse(raw.replace(/^﻿/, ''));
}

/** 内置包声明的版本 (seeder 只处理这些版本 —— 源树里的历史版本目录不参与)。 */
function declaredVersionOf(pkg) {
  const entry = BUILTIN_PACKAGES.find(p => p.name === pkg);
  assert.ok(entry, `内置包里没有 ${pkg}`);
  return entry.version;
}

describe('seedBuiltinPackages — R161.5 manifest 身份 / 脚本缺失 / 同路径 / 失败可见性', () => {
  test('1. 正常路径: 全部内置包被复制到 dataDir (manifest + 脚本齐备)', async () => {
    const fx = makeFixture();
    try {
      const logger = makeLogger();
      await seedBuiltinPackages({
        dataDir: fx.dst, sourceDir: fx.src, writeAudit: () => {}, logger
      });

      assert.deepEqual(logger.errors, [], '正常路径不应有 per-package 失败');

      // 注意: 源树里还有几个**不在** BUILTIN_PACKAGES 里的包
      // (ad_ad_account_quickfix / ad_ad_groups_write / ad_ad_users_write /
      //  ad_dc_probe_outbound / ad_partner_ports_probe) —— seeder 只处理
      // 14 个内置包, 那些不在范围内。
      const expectedPkgs = BUILTIN_PACKAGES.map(p => p.name).sort();
      const dstPkgs = readdirSync(fx.dst, { withFileTypes: true })
        .filter(e => e.isDirectory()).map(e => e.name).sort();
      assert.deepEqual(dstPkgs, expectedPkgs, 'dataDir 里的包集合应与内置包声明一致');
      assert.ok(dstPkgs.length >= 14, `内置包数量异常: ${dstPkgs.length}`);

      for (const pkg of dstPkgs) {
        const versions = readdirSync(path.join(fx.dst, pkg));
        for (const version of versions) {
          const manifest = readManifest(fx.dst, pkg, version);
          assert.equal(manifest.name, pkg,
            `${pkg}/${version} 的 manifest.name 必须是下划线形式 (目录名)`);
          // R161.5 — 身份三件套: name / version / schemaName 必须自洽。
          //   name 对不上 ⇒ validateManifest 抛 INVALID_MANIFEST ⇒ 整包跳过。
          //   version 对不上 ⇒ 缓存/升级路径按版本找目录 ⇒ 找不到。
          //   schemaName 对不上 ⇒ 数据落进另一个库, 读端看不见。
          assert.equal(manifest.version, version,
            `${pkg}/${version} 的 manifest.version 必须是目录版本号`);
          if (manifest.database) {
            // 有 database 段的包 = 自建 pkg_* schema 的包, schemaName 必须
            // 是 pkg_<name>。没有 database 段的包走"公共表 pattern"
            // (R110.A architectural pivot) —— 数据落中心端公共表, 不建
            // 独立 schema, 那时候没有 schemaName 是**设计**不是缺陷。
            assert.equal(manifest.database.schemaName, `pkg_${pkg}`,
              `${pkg}/${version} 的 database.schemaName 必须是 pkg_${pkg}`);
            // R161.5 — manifest 声明的迁移文件必须在磁盘上存在。
            //   历史缺陷: ad_os_baseline 1.0.8 声明 001/002/003, 磁盘只有
            //   004 ⇒ 缺的那两张表从来没建出来 ⇒ /api/os-baseline 500。
            for (const migration of manifest.database.migrations || []) {
              assert.ok(existsSync(path.join(fx.dst, pkg, version, migration)),
                `${pkg}/${version} 声明了迁移 ${migration} 但文件不存在`);
            }
          }
          const script = manifest.agent?.script || 'collect.ps1';
          assert.ok(existsSync(path.join(fx.dst, pkg, version, script)),
            `${pkg}/${version} 缺脚本文件 ${script}`);
        }
      }
    } finally {
      cleanup(fx);
    }
  });

  test('2. manifest.name 身份不符 ⇒ 用内置源覆盖修复 (不静默跳过)', async () => {
    const fx = makeFixture();
    try {
      await seedBuiltinPackages({
        dataDir: fx.dst, sourceDir: fx.src, writeAudit: () => {}, logger: makeLogger()
      });

      // 模拟历史污染: 已装好的包里 manifest.name 是连字符形式。
      const victim = 'ad_lockout_summary';
      const victimVersion = declaredVersionOf(victim);
      const victimManifestPath = path.join(fx.dst, victim, victimVersion, 'manifest.json');
      const broken = readFileSync(victimManifestPath, 'utf8');
      writeFileSync(victimManifestPath, broken.replace(`"name": "${victim}"`, `"name": "${victim.replace(/_/g, '-')}"`), 'utf8');
      assert.equal(readManifest(fx.dst, victim, victimVersion).name, victim.replace(/_/g, '-'),
        '前置条件: manifest 应已被污染成连字符形式');

      const logger = makeLogger();
      await seedBuiltinPackages({
        dataDir: fx.dst, sourceDir: fx.src, writeAudit: () => {}, logger
      });

      assert.equal(readManifest(fx.dst, victim, victimVersion).name, victim,
        '污染的 manifest 应被内置源覆盖修复');
      assert.ok(
        logger.warns.some(w => String(w.msg || '').includes('repaired invalid manifest')),
        `应有自愈告警, 实际: ${JSON.stringify(logger.warns)}`);
      assert.ok(
        !logger.errors.some(e => e.obj?.pkg === victim),
        '自愈后该包不应再被记为失败');
    } finally {
      cleanup(fx);
    }
  });

  test('3. 脚本文件缺失 ⇒ 从内置源补回 (不是 ENOENT 整包跳过)', async () => {
    const fx = makeFixture();
    try {
      await seedBuiltinPackages({
        dataDir: fx.dst, sourceDir: fx.src, writeAudit: () => {}, logger: makeLogger()
      });

      const victim = 'ad_lockout_list';
      const victimVersion = declaredVersionOf(victim);
      const scriptPath = path.join(fx.dst, victim, victimVersion, 'collect.ps1');
      rmSync(scriptPath);
      assert.ok(!existsSync(scriptPath), '前置条件: 脚本应已被删掉');

      const logger = makeLogger();
      await seedBuiltinPackages({
        dataDir: fx.dst, sourceDir: fx.src, writeAudit: () => {}, logger
      });

      assert.ok(existsSync(scriptPath), '缺失的脚本应从内置源补回');
      assert.ok(
        logger.warns.some(w => String(w.msg || '').includes('restored missing script file')),
        `应有补回告警, 实际: ${JSON.stringify(logger.warns)}`);
      assert.ok(
        !logger.errors.some(e => e.obj?.pkg === victim),
        '补回后该包不应再被记为失败');
    } finally {
      cleanup(fx);
    }
  });

  test('4. sourceDir === dataDir (operator 实际布局) ⇒ 不自拷贝、不截断文件', async () => {
    const fx = makeFixture({ sameTree: true });
    try {
      const before = snapshotTree(fx.src);

      const logger = makeLogger();
      await seedBuiltinPackages({
        dataDir: fx.src, sourceDir: fx.src, writeAudit: () => {}, logger
      });

      assert.deepEqual(logger.errors, [], '同树布局不应产生 per-package 失败');
      const after = snapshotTree(fx.src);
      assert.equal(after.size, before.size, '同树布局不应增删文件');
      for (const [rel, sig] of before) {
        assert.equal(after.get(rel), sig, `同树布局不应改写文件内容: ${rel}`);
      }
    } finally {
      cleanup(fx);
    }
  });

  test('5. 同树 + manifest 身份错 ⇒ 报人话错误 (不是玄学 ENOENT/EINVAL)', async () => {
    const fx = makeFixture({ sameTree: true });
    try {
      const victim = 'ad_dc_overview';
      const victimVersion = declaredVersionOf(victim);
      const manifestPath = path.join(fx.src, victim, victimVersion, 'manifest.json');
      const broken = readFileSync(manifestPath, 'utf8');
      writeFileSync(manifestPath, broken.replace(`"name": "${victim}"`, `"name": "${victim.replace(/_/g, '-')}"`), 'utf8');

      const logger = makeLogger();
      await seedBuiltinPackages({
        dataDir: fx.src, sourceDir: fx.src, writeAudit: () => {}, logger
      });

      const failure = logger.errors.find(e => e.obj?.pkg === victim);
      assert.ok(failure, `该包应被记为失败, 实际 errors: ${JSON.stringify(logger.errors)}`);
      assert.match(failure.obj.err, /manifest\.name mismatch/,
        '错误信息应直指 manifest.name 不匹配');
      assert.match(failure.obj.err, /cannot self-repair/,
        '错误信息应说明同树无法自愈');
    } finally {
      cleanup(fx);
    }
  });

  test('6. per-package 失败落 logger.error (不再只 console.warn)', async () => {
    const fx = makeFixture();
    try {
      await seedBuiltinPackages({
        dataDir: fx.dst, sourceDir: fx.src, writeAudit: () => {}, logger: makeLogger()
      });

      // 源和目标都缺脚本 ⇒ 补不回来 ⇒ 该包必须失败, 且失败要进 logger。
      const victim = 'ad_admin_members';
      const victimVersion = declaredVersionOf(victim);
      rmSync(path.join(fx.dst, victim, victimVersion, 'collect.ps1'), { force: true });
      rmSync(path.join(fx.src, victim, victimVersion, 'collect.ps1'), { force: true });

      const logger = makeLogger();
      await seedBuiltinPackages({
        dataDir: fx.dst, sourceDir: fx.src, writeAudit: () => {}, logger
      });

      const failure = logger.errors.find(e => e.obj?.pkg === victim);
      assert.ok(failure, `该包应被记为失败, 实际 errors: ${JSON.stringify(logger.errors)}`);
      assert.match(failure.obj.err, /script file missing/,
        '错误信息应直指脚本文件缺失');
      assert.equal(failure.obj.version, victimVersion, '失败日志应带包名与版本');
    } finally {
      cleanup(fx);
    }
  });

  test('7. 源树里只能有一份内置包源 (center/data/packages) —— 重复副本会静默漂移', () => {
    // R161.5 续 (2026-10-26) —— 源树里曾存在**第二份**内置包副本
    // center/web/data/packages: 2026-10-25 13:29 一次批量拷贝留下的
    // (14 个包, 其中 4 个的 manifest.name 还是连字符坏名, 另有 2 个包
    // 停在旧版本号)。
    //
    // 它**没有任何消费者**:
    //   · vite 只打包 web/src (build.outDir = '../dist'), web/data 不进产物
    //   · publish-sync.mjs 的 EXCLUDE_DIR 排除 data
    //   · ship-publish-to-prod.ps1 的 $alwaysXD 排除 data
    //   · 本检查器的 SKIP_DEFAULT 同样排除 data
    // ⇒ 这份副本既发不出去、也读不到, 只会**静默漂移**;
    //   而它正是 R161.5「seeds 的包不对」那族缺陷的第二份藏身处 ——
    //   谁按目录名去找 manifest.json, 找到的可能是这份坏的。
    //
    // ⇒ 断言: 源树里有且只有 center/data/packages 一份包源。
    const found = [];
    const walk = (dir, depth) => {
      if (depth > 4) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'tests') continue;
        const full = path.join(dir, entry.name);
        // 只认 <...>/data/packages 这种形态 —— 那才是内置包源的目录约定。
        if (entry.name === 'packages' && path.basename(path.dirname(full)) === 'data') {
          found.push(path.relative(CENTER_ROOT, full).split(path.sep).join('/'));
          continue;
        }
        walk(full, depth + 1);
      }
    };
    walk(CENTER_ROOT, 0);
    found.sort();
    assert.deepEqual(found, ['data/packages'],
      `源树里有多份内置包源: ${found.join(', ')} —— 只有 center/data/packages 是真的, ` +
      '重复副本既发不出去也读不到, 只会静默漂移 (R161.5 续)');
  });
});
