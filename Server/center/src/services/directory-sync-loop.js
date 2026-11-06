// R158.35 (2026-10-03) — directory sync scheduler.
// R158.38.2 (2026-10-03) — tick() 拆为 _defaultForestTick + _legacyTick fallback.
//
// Operator directive 2026-10-03 (R158.38.2): 「这个不需要绑定啊, 这里注册的
// 是后续我们 DC 用来设定属于哪个域」— 中心端不维护 binding 单行表. tick 时
// 直接读 ad_forest.is_default=1 的森林, 遍历其下 ad_forest_domain, 每个
// domain 一个独立 run 行. 凭据来自 forest 行, baseDn 来自 domain 行. 无
// is_default=1 森林 → 走 _legacyTick fallback (R158.35 system_config 5 key).
//
// R158.46.1 (2026-10-06) — operator 改同步周期单位 小时→分钟. 旧 4h default
// 现在是 240min default; 操作员接受新默认 60min (1h). 1min floor 允许高频
// 同步场景 (操作员自负责任). 1440min ceiling (24h).

import { getDb } from '../db/index.js';
import {
  syncDirectory,
  resolveBindPassword,
  resolveBindPasswordFromForest,
  deriveSecretKey
} from './ad-directory-sync.js';
import {
  listForests,
  listEnabledDomains,
  getForestRawRow,
  getDomainBindPassword,
  getEffectiveDomainConfig
} from './ad-forest-registry.js';
import { toMysqlDatetime } from '../utils/datetime.js';

const DEFAULT_INTERVAL_MINUTES = 60;
const MIN_INTERVAL_MINUTES = 1;
const MAX_INTERVAL_MINUTES = 1440; // 24h ceiling

export function createDirectorySyncLoop({ getSystemConfig, logger }) {
  let intervalHandle = null;
  let inFlight = null;
  let lastTickAt = null;
  let lastIntervalMinutes = DEFAULT_INTERVAL_MINUTES;
  // R158.46 (2026-10-06) — scheduler 实际用的 interval, 跟 lastIntervalMinutes
  //   (cfg 读出的最新值) 分离. tick() 末尾若两者不等 → clearInterval + 重建.
  // R158.46.1 (2026-10-06) — 同步周期单位 小时→分钟.
  let _scheduledIntervalMinutes = DEFAULT_INTERVAL_MINUTES;

  // Top-level dispatcher. Try default-forest-first; fall back to system_config.
  async function tick() {
    let cfg;
    try {
      cfg = (await getSystemConfig?.()) || {};
    } catch (e) {
      logger?.warn?.({ component: 'directory-sync', err: e?.message },
        'directory sync tick: getSystemConfig failed');
      return { skipped: true, reason: `getSystemConfig failed: ${e.message}` };
    }
    const minutes = clampIntervalMinutes(cfg.ad_sync_interval_minutes);
    lastIntervalMinutes = minutes;

    // R158.38.2 — try default forest path.
    let forest = null;
    try {
      const forests = await listForests({ db: getDb() });
      forest = forests.find(f => f.isDefault) || null;
    } catch (e) {
      logger?.warn?.({ component: 'directory-sync', err: e?.message },
        'listForests failed; falling back to system_config');
    }
    if (forest) {
      // R158.5.4 fix (2026-10-04) — listForests/getForest 都过 rowToForestWire
      // 把 bind_password mask 掉; tick 必须走 getForestRawRow 取真值.
      let forestFull = forest;
      try {
        forestFull = await getForestRawRow(forest.id, { db: getDb() }) || forest;
      } catch (e) {
        logger?.warn?.({ component: 'directory-sync', err: e?.message, forestId: forest.id },
          'getForestRawRow failed in _defaultForestTick; bind_password will be empty');
      }
      return await _defaultForestTick(forestFull, cfg);
    }

    // 无默认森林 — 走 R158.35 fallback 路径.
    return await _legacyTick(cfg);
  }

  // R158.38.2 — default-forest-driven: tick 时遍历 default forest 下的所有 domain,
  // 每个 domain 顺序 sync, 失败 catch 继续. bind 凭据来自 forest 行,
  // baseDn 来自 domain 行, ldapUrl 来自 forest.ad_url.
  async function _defaultForestTick(forest, cfg) {
    const db = getDb();
    let domains;
    try {
      domains = await listEnabledDomains(forest.id, { db });
    } catch (e) {
      logger?.warn?.({ component: 'directory-sync', err: e?.message, forestId: forest.id },
        'listDomains failed; falling back to system_config');
      return await _legacyTick(cfg);
    }
    if (!domains || domains.length === 0) {
      logger?.warn?.({ component: 'directory-sync', forestId: forest.id },
        'default forest has no domains; skip');
      return { skipped: true, reason: 'no_domains', forestId: forest.id };
    }

    // 解密 forest 行的 bind password. R158.37 lesson 9: forestRow.bind_password
    // 是 Buffer/VarBinary, Buffer.from(row).toString('base64') 转 base64 再 decryptBindPassword.
    const secretKey = deriveSecretKey(process.env, cfg?.jwt_secret_current || '');
    let bindPassword = '';
    try {
      bindPassword = await resolveBindPasswordFromForest({ forestRow: forest, secretKey, logger });
    } catch (e) {
      logger?.warn?.({ component: 'directory-sync', forestId: forest.id, err: e?.message },
        'forest bind_password decrypt failed; per-domain sync will surface LDAP bind error');
    }
    if (!bindPassword) {
      logger?.warn?.({ component: 'directory-sync', forestId: forest.id },
        'forest bind_password empty after decrypt; skip all domains');
      return { skipped: true, reason: 'forest_bind_password_empty', forestId: forest.id };
    }

    lastTickAt = Date.now();
    const results = [];
    for (const domain of domains) {
      const dcName = await _pickDcForDomain({ db, domain });
      if (!dcName) {
        logger?.warn?.({ component: 'directory-sync', domainId: domain.id, domainName: domain.domainName },
          'no DC for domain; skip');
        results.push({ domainId: domain.id, domainName: domain.domainName, skipped: true, reason: 'no_dc' });
        continue;
      }
      let runId = 0;
      try {
        // R158.44.7 (2026-10-04) — same fix as ad-directory-sync.js:218-223.
        // db.sql.directorySync.insertRunWithForest is a flat string PER DIALECT
        // (sql.js exports one key per helper, not a nested dict). The
        // `[db.dialect]` index was producing undefined, so db.execute would
        // throw "Cannot read properties of undefined (reading 'replace')"
        // from the mssql driver wrapper's rewritePlaceholders. Read the SQL
        // string directly without the index.
        const insertResult = await db.execute(
          db.sql.directorySync.insertRunWithForest,
          [dcName, 'cron', forest.id, domain.id]
        );
        runId = Number(insertResult?.insertId ?? insertResult?.rows?.[0]?.id ?? 0);
        if (!runId) throw new Error('insertRunWithForest returned no id');
      } catch (e) {
        logger?.warn?.({ component: 'directory-sync', domainId: domain.id, err: e?.message },
          'insertRunWithForest failed; continue to next domain');
        results.push({ domainId: domain.id, domainName: domain.domainName, ok: false, error: e.message });
        continue;
      }
      try {
        // R158.5.4 (2026-10-04) — domain-config 三件套: base_dn / sync_mode /
        // bind_password KV 覆盖. base_dn 优先, 否则 domain.domainDn. bindPassword:
        // syncMode=independent 且 KV 存在 → 用域; 否则继承 forest.
        // R158.44.2 (2026-10-04) — 加 ldapUrl 覆盖: priority domain setting > forest.adUrl.
        // R158.44.3 (2026-10-04) — 加 bindDn 覆盖: priority domain setting > forest.bindDn.
        //   5→6 件套齐全 (ldapUrl/bindDn/baseDn/syncMode/bindPassword/autoSync).
        let effective = {
          baseDn: domain.domainDn, syncMode: 'inherit',
          hasDomainPassword: false, ldapUrl: null, hasDomainLdapUrl: false,
          bindDn: null, hasDomainBindDn: false
        };
        try {
          effective = await getEffectiveDomainConfig(domain, { db, logger });
        } catch (e) {
          logger?.warn?.({
            component: 'directory-sync',
            domainId: domain.id, err: e?.message
          }, 'getEffectiveDomainConfig threw; using defaults');
        }
        let effectiveBindPassword = bindPassword;
        let usedDomainPassword = false;
        if (effective.syncMode === 'independent' && effective.hasDomainPassword) {
          try {
            const dp = await getDomainBindPassword(domain.id, {
              db,
              jwtSecret: cfg?.jwt_secret_current || process.env.JWT_SECRET || '',
              logger
            });
            if (dp) {
              effectiveBindPassword = dp;
              usedDomainPassword = true;
            }
          } catch (e) {
            logger?.warn?.({
              component: 'directory-sync',
              domainId: domain.id, err: e?.message
            }, 'getDomainBindPassword threw; using forest password');
          }
        }
        // R158.44.2 — domain-level ldapUrl 覆盖 forest.adUrl. 空 → 继承.
        const effectiveLdapUrl = effective.ldapUrl || forest.adUrl;
        // R158.44.3 — domain-level bindDn 覆盖 forest.bindDn. 空 → 继承.
        const effectiveBindDn = effective.bindDn || forest.bindDn || '';
        // R158.44.7.7 (2026-10-05) — syncDirectory writes the domain FQDN
        // into the snapshot tables' `domain_name` column. dcName stays as
        // the DC hostname (audit only, used in runs.dc_name and log lines).
        const domainName = domain.domainName;
        const r = await syncDirectory({
          db, logger, domainName, runId,
          forestId: forest.id, domainId: domain.id,
          config: {
            ldapUrl: effectiveLdapUrl,
            bindDn: effectiveBindDn,
            bindPassword: effectiveBindPassword,
            baseDn: effective.baseDn,
            pageSize: 500
          }
        });
        logger?.info?.({
          component: 'directory-sync',
          event: 'cron_sync_succeeded',
          runId, dcName,
          forestId: forest.id, forestName: forest.forestName,
          domainId: domain.id, domainName: domain.domainName,
          syncMode: effective.syncMode, baseDn: effective.baseDn,
          usedDomainPassword, usedDomainLdapUrl: effective.hasDomainLdapUrl,
          usedDomainBindDn: effective.hasDomainBindDn,
          ldapUrl: effectiveLdapUrl, bindDn: effectiveBindDn,
          userCount: r.userCount, groupCount: r.groupCount, ouCount: r.ouCount,
          orphanDeleted: r.orphanDeleted,
          durationMs: r.durationMs
        }, 'per-domain sync complete');
        results.push({
          domainId: domain.id, domainName: domain.domainName, dcName, runId, ok: true,
          syncMode: effective.syncMode, baseDn: effective.baseDn,
          usedDomainPassword, usedDomainLdapUrl: effective.hasDomainLdapUrl,
          usedDomainBindDn: effective.hasDomainBindDn,
          ldapUrl: effectiveLdapUrl, bindDn: effectiveBindDn, ...r
        });
      } catch (e) {
        const isPreflight = /^syncDirectory preflight:/.test(e?.message || '');
        logger?.warn?.({
          component: 'directory-sync',
          event: isPreflight ? 'cron_sync_failed_preflight' : 'cron_sync_failed_sync',
          runId, dcName,
          forestId: forest.id, forestName: forest.forestName,
          domainId: domain.id, domainName: domain.domainName,
          errorMessage: e?.message || String(e),
          stack: e?.stack ? String(e.stack).split('\n').slice(0, 3).join('\n') : null
        }, 'per-domain sync failed; continuing');
        results.push({ domainId: domain.id, domainName: domain.domainName, dcName, runId, ok: false, error: e.message });
      }
    }
    const okCount = results.filter(r => r.ok).length;
    const failCount = results.filter(r => r.ok === false).length;
    logger?.info?.({
      component: 'directory-sync',
      forestId: forest.id, forestName: forest.forestName,
      okCount, failCount, totalDomains: domains.length, intervalMinutes: lastIntervalMinutes
    }, 'default-forest directory sync tick complete');
    return {
      ok: true, multiDomain: true,
      forestId: forest.id, forestName: forest.forestName,
      okCount, failCount, totalDomains: domains.length,
      results, intervalMinutes: lastIntervalMinutes
    };
  }

  // R158.35 原 tick() — system_config 5 key 路径, R158.38.2 仍保留做 fallback.
  async function _legacyTick(cfg) {
    if (!cfg.ad_ldap_url) {
      logger?.debug?.({ component: 'directory-sync' },
        'skip: ad_ldap_url empty (sync disabled)');
      return { skipped: true, reason: 'ad_ldap_url empty' };
    }
    const db = getDb();
    let dcName;
    let domainName;
    try {
      // R161.20 — 方言分叉。`SELECT TOP 1` 是 T-SQL 语法, MySQL 报 1064 ⇒
      //   legacy fallback 路径在 MySQL 上**永远走不下去**(catch 只 warn 一句
      //   "ad_dcs read failed" 就 skipped)。与本文件 _pickDcForDomain
      //   (第 369-375 行) 同模式。
      const pickSql = db.dialect === 'mssql'
        ? `SELECT TOP 1 fd.domain_name, d.dc_name
           FROM ad_dcs d
           LEFT JOIN ad_forest_dc_assignment a ON a.dc_hostname = d.dc_name
           LEFT JOIN ad_forest_domain fd ON fd.id = a.domain_id
          -- R158.X.115 (2026-10-20) — 排除退役/暂停管控的 DC。凭据主机必须是
          --   真正还在域里的机器: 退役 DC 已经 dcpromo 降级, 用它 bind 必然失败,
          --   选它会让整个目录同步卡死。
          WHERE d.decommissioned_at IS NULL AND d.monitoring_paused_at IS NULL
          ORDER BY d.is_pdc DESC, d.dc_name`
        : `SELECT fd.domain_name, d.dc_name
           FROM ad_dcs d
           LEFT JOIN ad_forest_dc_assignment a ON a.dc_hostname = d.dc_name
           LEFT JOIN ad_forest_domain fd ON fd.id = a.domain_id
          -- R158.X.115 (2026-10-20) — 排除退役/暂停管控的 DC。凭据主机必须是
          --   真正还在域里的机器: 退役 DC 已经 dcpromo 降级, 用它 bind 必然失败,
          --   选它会让整个目录同步卡死。
          WHERE d.decommissioned_at IS NULL AND d.monitoring_paused_at IS NULL
          ORDER BY d.is_pdc DESC, d.dc_name
          LIMIT 1`;
      const { rows } = await db.query(pickSql);
      dcName = rows[0]?.dc_name;
      domainName = rows[0]?.domain_name || dcName;
    } catch (e) {
      logger?.warn?.({ component: 'directory-sync', err: e?.message },
        'directory sync tick: ad_dcs read failed');
      return { skipped: true, reason: `ad_dcs read failed: ${e.message}` };
    }
    if (!dcName) {
      logger?.warn?.({ component: 'directory-sync' },
        'skip: no ad_dcs rows (register at least one DC)');
      return { skipped: true, reason: 'no ad_dcs rows' };
    }
    let runId;
    try {
      const insertResult = await db.execute(db.sql.directorySync.insertRun, [dcName, 'cron']);
      runId = Number(insertResult?.insertId ?? insertResult?.rows?.[0]?.id ?? 0);
      if (!runId) throw new Error('insertRun returned no id');
    } catch (e) {
      logger?.warn?.({ component: 'directory-sync', err: e?.message },
        'directory sync tick: insertRun failed');
      return { skipped: true, reason: `insertRun failed: ${e.message}` };
    }
    const secretKey = deriveSecretKey(process.env, cfg.jwt_secret_current || '');
    let bindPassword = '';
    try {
      bindPassword = await resolveBindPassword({ cfg, secretKey, logger });
    } catch (e) {
      logger?.warn?.({ component: 'directory-sync', err: e?.message },
        'resolveBindPassword failed; sync will surface bind error');
    }
    if (!bindPassword) {
      logger?.warn?.({ component: 'directory-sync', dcName, runId },
        'skip: ad_bind_password empty (sync disabled)');
      try {
        // finalizeRun 7 槽位, 两方言同序 (sql.js mysql/mssql 皆为):
        //   [status, user_count, group_count, ou_count, computer_count,
        //    error_message, run_id]
        // 之前只传 6 个 (漏 ou_count) → 末位 runId 落到 error_message,
        // 且 WHERE id 拿不到值 → **UPDATE 匹配 0 行, run 永久卡 status='running'**.
        await db.execute(db.sql.directorySync.finalizeRun,
          ['failed', 0, 0, 0, 0, 'ad_bind_password not configured', runId]);
      } catch (e) {
        // 不再裸吞: 这条失败正是"同步卡 running"的根因, 必须留痕
        logger?.warn?.({ component: 'directory-sync', runId, err: e?.message },
          'finalizeRun(failed) failed — run row may stay status=running');
      }
      return { skipped: true, reason: 'ad_bind_password empty' };
    }
    lastTickAt = Date.now();
    try {
      const result = await syncDirectory({
        db, logger, domainName, runId,
        config: {
          ldapUrl: cfg.ad_ldap_url,
          bindDn: cfg.ad_bind_dn || '',
          bindPassword,
          baseDn: cfg.ad_base_dn || '',
          pageSize: 500
        }
      });
      logger?.info?.({
        component: 'directory-sync',
        dcName, runId,
        userCount: result.userCount, groupCount: result.groupCount, ouCount: result.ouCount,
        intervalMinutes: lastIntervalMinutes
      }, 'directory sync tick complete (legacy fallback)');
      return { ok: true, ...result, dcName, runId, intervalMinutes: lastIntervalMinutes };
    } catch (e) {
      logger?.warn?.({
        component: 'directory-sync',
        dcName, runId,
        err: e?.message || String(e)
      }, 'directory sync tick failed (legacy fallback)');
      return { ok: false, error: e?.message, dcName, runId };
    }
  }

  // 三段 DC 选择: 1. ad_forest_dc_assignment domain 绑定; 2. ad_dcs WHERE
  // domain.dc_hostname; 3. PDC emulator fallback (R158.35 兼容).
  //
  // R158.X.115 (2026-10-20) — 三段全部排除退役/暂停管控的 DC。凭据主机必须
//   是真正还在域里的机器 (退役 DC 已 dcpromo 降级, bind 必然失败)。跟上面
//   pickDcName 的 WHERE 同一口径。
// R158.46 (2026-10-06) — dialect-aware:
  //   之前三段全写死 MySQL `LIMIT 1`, MSSQL 部署下报 "Incorrect syntax
  //   near 'LIMIT'" 三段都被 catch 静默吞掉, 函数返 null → tick 走 skip
  //   不写 ad_directory_sync_runs → "没有自动同步记录".
  //   修: 走 isMssql ? TOP 1 : LIMIT 1, 跟 routes/admin.js:2425-2455
  //   manual 触发路径同模式.
  async function _pickDcForDomain({ db, domain }) {
    const isMssql = db.dialect === 'mssql';
    try {
      const { rows: aRows } = await db.execute(
        isMssql
          ? `SELECT TOP 1 dc_hostname FROM ad_forest_dc_assignment WHERE domain_id = ?`
          : `SELECT dc_hostname FROM ad_forest_dc_assignment WHERE domain_id = ? LIMIT 1`,
        [domain.id]
      );
      if (aRows && aRows[0]?.dc_hostname) return aRows[0].dc_hostname;
    } catch (e) { /* ignore — fall through */ }
    if (domain.dcHostname) {
      try {
        const { rows: dRows } = await db.execute(
          isMssql
            ? `SELECT TOP 1 dc_name FROM ad_dcs WHERE dc_name = ? AND decommissioned_at IS NULL AND monitoring_paused_at IS NULL`
            : `SELECT dc_name FROM ad_dcs WHERE dc_name = ? AND decommissioned_at IS NULL AND monitoring_paused_at IS NULL LIMIT 1`,
          [domain.dcHostname]
        );
        if (dRows && dRows[0]?.dc_name) return dRows[0].dc_name;
      } catch (e) { /* ignore */ }
    }
    try {
      const { rows: pRows } = await db.query(
        isMssql
          ? `SELECT TOP 1 dc_name FROM ad_dcs WHERE decommissioned_at IS NULL AND monitoring_paused_at IS NULL ORDER BY is_pdc DESC, dc_name`
          : `SELECT dc_name FROM ad_dcs WHERE decommissioned_at IS NULL AND monitoring_paused_at IS NULL ORDER BY is_pdc DESC, dc_name LIMIT 1`
      );
      return pRows?.[0]?.dc_name || null;
    } catch {
      return null;
    }
  }

  function start() {
    if (intervalHandle) return;
    // R158.5.4 (2026-10-04) — startup sweep: finalize stuck 'running' runs that
    // predate the preflight fix (syncDirectory threw above the try/catch, so
    // finalizeRun was never called). Threshold = 2× DEFAULT tick interval
    // (>=8h); any 'running' older than that is definitively orphan. Without
    // this, the matrix UI keeps showing the row as 同步中… and the [Sync now]
    // button stays disabled forever (R158.5.4 operator feedback).
    _sweepStuckRuns().catch(e =>
      logger?.warn?.({ component: 'directory-sync', err: e?.message },
        'startup sweep stuck runs threw')
    );
    // R158.60.23 (2026-10-09) — read cfg.ad_sync_interval_minutes at startup
    //   instead of using hardcoded DEFAULT 60. Without this, after every
    //   NSSM restart the loop registers setInterval(60min) and the operator's
    //   configured 30min cadence is only picked up by the next tick (which
    //   fires after 60min). During that 60min gap the loop appears "dead"
    //   (operator feedback 2026-10-09 "为何自动同步这么久没同步了?").
    //   Same fix is in tick() at line 47-54 — the tick-time read was correct
    //   but start-time read was missing.
    //
    // R158.60.23.1 (2026-10-10) — fix SyntaxError. start() is sync, but the
    //   R158.60.23 patch added `await` inline, which is a parse error. Node
    //   crashes on first call, NSSM restarts it, and the cycle repeats —
    //   service stuck in PAUSED. Wrap cfg-read in an IIFE so the await sits
    //   inside its own async context.
    (async () => {
    try {
      const cfg0 = (getSystemConfig && (await getSystemConfig())) || {};
      const cfgMinutes = clampIntervalMinutes(cfg0.ad_sync_interval_minutes);
      if (cfgMinutes !== lastIntervalMinutes) {
        logger?.info?.({ component: 'directory-sync', from: lastIntervalMinutes, to: cfgMinutes },
          'R158.60.23: adopting cfg.ad_sync_interval_minutes at startup');
        lastIntervalMinutes = cfgMinutes;
      }
    } catch (e) {
      logger?.warn?.({ component: 'directory-sync', err: e?.message },
        'R158.60.23: startup getSystemConfig failed; using DEFAULT');
    }
    // R158.60.23 (2026-10-09) — fire first tick immediately on start, do NOT
    //   wait one full interval. The original "First tick after one interval"
    //   comment gave the operator time to configure LDAP via the admin UI
    //   before we hit the DC, but in practice every NSSM restart reset the
    //   60min timer, so cron sync appeared dead for 60min after any service
    //   bounce (operator feedback 2026-10-09). Fire immediately so a freshly
    //   restarted centre syncs within seconds, then settle into the normal
    //   cadence.
    logger?.info?.({ component: 'directory-sync', intervalMinutes: lastIntervalMinutes },
      'R158.60.23: directory sync loop starting; firing first tick immediately');
    _onTick();
    // First tick after one interval — give the operator time to configure
    // LDAP via /admin/directory-sync before we start hammering the DC.
    //
    // R158.46 (2026-10-06) — operator 改 /admin/directory-sync intervalMinutes
    //   后要能即时生效 (否则改了等于没改). tick() 末尾检测 lastIntervalMinutes
    //   变化 → clearInterval + 重启新周期. 最长延迟 = 1 个当前 interval.
    // R158.46.1 (2026-10-06) — 单位 60*60*1000 (hours) → 60*1000 (minutes).
    intervalHandle = setInterval(_onTick, lastIntervalMinutes * 60 * 1000);
    _scheduledIntervalMinutes = lastIntervalMinutes;
    function _onTick() {
      inFlight = tick().then(() => {
        if (lastIntervalMinutes !== _scheduledIntervalMinutes) {
          logger?.info?.({ component: 'directory-sync', from: _scheduledIntervalMinutes, to: lastIntervalMinutes },
            'intervalMinutes changed; restarting setInterval');
          if (intervalHandle) { clearInterval(intervalHandle); intervalHandle = null; }
          _scheduledIntervalMinutes = lastIntervalMinutes;
          intervalHandle = setInterval(_onTick, lastIntervalMinutes * 60 * 1000);
        }
      }).catch((e) =>
        logger?.warn?.({ component: 'directory-sync', err: e.message },
          'directory sync tick threw (best-effort)')
      );
    }
    })(); // R158.60.23.1 — close IIFE wrapping cfg-read + tick + interval
  }

  async function _sweepStuckRuns() {
    const db = getDb();
    const isMssql = db.dialect === 'mssql';
    // Threshold = 30 min. A normal LDAP sync (3 paged searches + UPSERT +
    // orphan DELETE) should finish in <5 min even on a 100k-user forest.
    // Anything older than 30 min is orphan (either preflight-fix predecessor
    // stuck running, or syncDirectory Promise never resolved for any other
    // reason). Operator feedback 2026-10-04: 「上次没有同步完成, 同步按钮就
    // 不可用」 — without this sweep the matrix UI keeps [Sync now] disabled
    // for an operator-visible row forever.
    // R161.5 (2026-10-26) — MySQL 5.7 的 DATETIME 列拒绝 ISO 8601 字符串。
    //   ad_directory_sync_runs.started_at 是 DATETIME NOT NULL (MySQL 基线),
    //   之前把 `2026-10-25T14:57:13.910Z` 直接绑进去 ⇒
    //   ER 1292 "Incorrect datetime value" ⇒ **整条 UPDATE 回滚**
    //   ⇒ status 永远停在 'running' ⇒ 前台「同步」按钮一直不可用
    //   (生产日志 center.2026-10-25.1.log:58 已复现)。
    //   MSSQL 侧 datetime2 接受 ISO, 所以这个缺陷在 MSSQL 上完全看不出来。
    //   ⇒ 绑定参数按方言转换; 日志仍用 ISO (可读性)。
    const cutoffIso = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const cutoffParam = isMssql ? cutoffIso : toMysqlDatetime(cutoffIso);
    const sql = isMssql
      ? `UPDATE ad_directory_sync_runs
         SET status = 'failed', finished_at = SYSUTCDATETIME(),
             error_message = LEFT(ISNULL(error_message, '') +
               '; [startup-sweep] forced finalize; preflight-fix predecessor stuck running', 1900)
         WHERE status = 'running' AND started_at < ?`
      : `UPDATE ad_directory_sync_runs
         SET status = 'failed', finished_at = UTC_TIMESTAMP(),
             error_message = LEFT(IFNULL(error_message, '') +
               '; [startup-sweep] forced finalize; preflight-fix predecessor stuck running', 1900)
         WHERE status = 'running' AND started_at < ?`;
    try {
      const r = await db.execute(sql, [cutoffParam]);
      const swept = r?.affectedRows ?? r?.rowsAffected?.[0] ?? 0;
      if (swept > 0) {
        logger?.info?.({ component: 'directory-sync', swept, cutoffIso },
          'startup sweep: finalized orphan running runs');
      } else {
        logger?.debug?.({ component: 'directory-sync', cutoffIso },
          'startup sweep: no orphan runs');
      }
    } catch (e) {
      logger?.warn?.({ component: 'directory-sync', err: e?.message },
        'startup sweep UPDATE failed; stuck runs will remain until manual cleanup');
    }
  }

  async function stop() {
    if (intervalHandle) clearInterval(intervalHandle);
    intervalHandle = null;
    if (inFlight) {
      try { await inFlight; } catch { /* swallow */ }
      inFlight = null;
    }
  }

  function nextRunEstimateIso() {
    if (!lastTickAt) return null;
    // R158.46.1 (2026-10-06) — 单位 hours → minutes: * 60 * 60 * 1000 → * 60 * 1000.
    return new Date(lastTickAt + lastIntervalMinutes * 60 * 1000).toISOString();
  }

  return {
    start,
    stop,
    tick,
    isRunning: () => intervalHandle !== null,
    nextRunEstimateIso
  };
}

function clampIntervalMinutes(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_INTERVAL_MINUTES;
  return Math.max(MIN_INTERVAL_MINUTES, Math.min(MAX_INTERVAL_MINUTES, Math.round(n)));
}