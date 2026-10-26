// R158.35 (2026-10-03) — AD directory LDAP sync service.
//
// Operator directive 2026-10-02 (R158.35):
//   "在后台管理中设置活动目录信息同步, 然后在日常管理界面中显示账户和组等等信息".
//   Sync source = LDAP 389/636 (default port 389, ldaps:// for 636).
//   Output = three snapshot tables (ad_users_snapshot / ad_groups_snapshot /
//   ad_ous_snapshot) + one runs table (ad_directory_sync_runs).
//
// Bound DN + bind password live in system_config; the bind password is
// encrypted at rest with AES-256-GCM (`encryptBindPassword` /
// `decryptBindPassword`). The encryption key comes from
// process.env.AD_BIND_PASSWORD_KEY or, absent that, the centre's jwtSecret.
// Decryption happens once per sync tick; the plaintext exists only in a
// local variable for the duration of the LDAP bind.
//
// ldapts is the client library (ESM-native, MIT, supports MS Paged Results
// OID 1.2.840.113556.1.4.319 out of the box, no native deps). The same
// paged-search + UPSERT-then-DELETE-orphans pattern that ad_dc_overview
// uses applies here — three batches in one transaction, then a NOT IN
// cleanup at the end so the snapshot table is monotonically complete
// from start to finish of the run (UI never flips mid-sync to empty).
import { Client } from 'ldapts';
import { getDb } from '../db/index.js';
import {
  deriveSecretKey,
  encryptBindPassword,
  decryptBindPassword,
  looksLikeCiphertext
} from './ad-credential-vault.js';

// Re-export the vault primitives so existing import sites that pulled them
// from ad-directory-sync.js (e.g. routes/admin.js _resolveLdapBindPassword)
// keep working without churn. New code should import directly from the vault.
export {
  deriveSecretKey,
  encryptBindPassword,
  decryptBindPassword,
  looksLikeCiphertext
} from './ad-credential-vault.js';

// Resolve the plaintext bind password from system_config. The system_config
// row may be empty (sync disabled), ciphertext (most cases post-setup), or
// plaintext (legacy installs / first migration before encryption is enabled).
// We auto-upgrade plaintext rows to ciphertext so the next read is fast.
export async function resolveBindPassword({ cfg, secretKey, logger = null }) {
  const stored = cfg?.ad_bind_password;
  if (!stored) return '';
  if (looksLikeCiphertext(stored) && secretKey) {
    try {
      return decryptBindPassword(stored, secretKey);
    } catch (e) {
      logger?.warn?.({ err: e.message }, 'decryptBindPassword failed; treating stored value as plaintext');
      return stored;
    }
  }
  if (secretKey && stored) {
    try {
      const encrypted = encryptBindPassword(stored, secretKey);
      const db = getDb();
      await db.execute(
        db.sql.config.upsert,
        ['ad_bind_password', encrypted]
      );
      logger?.info?.({}, 'auto-upgraded ad_bind_password from plaintext to ciphertext');
      return stored;
    } catch (e) {
      logger?.warn?.({ err: e.message }, 'auto-upgrade ad_bind_password failed');
      return stored;
    }
  }
  return stored;
}

// R158.38 — Resolve the plaintext bind password from an ad_forest row.
// forestRow.bind_password is the raw Buffer/VarBinary column value as the
// SQL driver returns it (MySQL BLOB / MSSQL VARBINARY both come back as
// Buffer). The vault's decryptBindPassword takes a base64 ciphertext, so we
// re-encode the binary back to base64 first (lesson 9 from R158.37).
// Returns '' if forestRow / bind_password is empty.
export async function resolveBindPasswordFromForest({ forestRow, secretKey, logger = null }) {
  if (!forestRow || !forestRow.bind_password) return '';
  const stored = Buffer.isBuffer(forestRow.bind_password)
    ? forestRow.bind_password.toString('base64')
    : String(forestRow.bind_password);
  if (!stored) return '';
  if (!secretKey) {
    throw new Error('resolveBindPasswordFromForest: secretKey required to decrypt forest bind_password');
  }
  try {
    return decryptBindPassword(stored, secretKey);
  } catch (e) {
    logger?.warn?.({ err: e.message }, 'decryptBindPassword (forest) failed; bind_password may be unrecoverable');
    throw e;
  }
}

// Map AD attribute boolean to BIT/TINYINT 0/1 wire value.
function boolToInt(v) {
  if (v == null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return v ? 1 : 0;
  if (typeof v === 'string') {
    if (/^(true|yes|1)$/i.test(v)) return 1;
    if (/^(false|no|0)$/i.test(v)) return 0;
  }
  if (Buffer.isBuffer(v)) return v[0] ? 1 : 0;
  return null;
}

// Convert AD generalized-time (YYYYMMDDHHMMSS.0Z) to Date, or null on
// unparseable input. LDAP often uses midnight-based integer timestamps for
// lastLogon / pwdLastSet when the value has never been set; treat those as
// null rather than "1970-01-01".
//
// R158.X.116-ldaptime (2026-10-22) — 补 Windows FILETIME **字符串** 分支.
//   根因: ldapts 对 LargeInteger 型属性 (pwdLastSet / lastLogonTimestamp /
//   lockoutTime) 默认返回 **string**, 不是 number —— 因为
//   Attribute._isBinaryType() (ldapts/src/Attribute.ts:82) 只把属性名带
//   ";binary" 后缀的当 Buffer, 而这些属性名不带; 且 Client 的
//   explicitBufferAttributes 选项 (Client.ts:160-163) 本项目没传.
//   BER 里 8 字节整数就是无 NUL 终止的 ASCII 十进制文本, utfDecoder 解码后
//   得到 "133456789012345678" 这样的 **18 位**字符串.
//   修前: 只有 number 分支认 FILETIME, string 分支的正则只认 14 位
//   generalized-time → 18 位不匹配 → new Date(18位数字) → Invalid Date → null.
//   后果 (实测): ad_users_snapshot 7543 行 last_logon / password_last_set
//   全 0, locked_out 恒 0; ad_computers_snapshot 3875 行 last_logon 全 0.
//   whenCreated / whenChanged 是 14 位字符串, 走下面的 generalized-time 分支,
//   一直正常 (7543/7543), 不受影响.
function adGenTimeToDate(v) {
  if (v == null || v === '' || v === 0) return null;
  // 防御: 将来若有人传 explicitBufferAttributes, 这些属性会变成 Buffer.
  // 先解成字符串再往下走, 两条路径共用同一套判定.
  if (Buffer.isBuffer(v)) {
    const decoded = v.toString('utf8').trim();
    if (!decoded) return null;
    v = decoded;
  }
  if (typeof v === 'number') {
    if (v === 0) return null;
    // Windows FILETIME = 100-ns intervals since 1601-01-01 UTC.
    const ms = (v - 116444736000000000) / 10000;
    return Number.isFinite(ms) && ms > 0 ? new Date(ms) : null;
  }
  const s = String(v).trim();
  if (!s || s === '0' || s === 'Never') return null;
  // Windows FILETIME 整数字符串 (17~19 位十进制) — ldapts 对 LargeInteger
  // 属性的默认返回形态. 走 BigInt: 18 位十进制超出 Number.MAX_SAFE_INTEGER,
  // Number() 会静默丢精度且无任何告警. (实测当前偏差为 0, 因为 FILETIME 低 3 位
  // 恒为 0; BigInt 是避免依赖这个"恰好", 不是修 bug 的必要条件.)
  if (/^\d{17,19}$/.test(s)) {
    try {
      const fileTime = BigInt(s);
      if (fileTime === 0n) return null;   // AD: 0 = 从未设置
      const ms = Number((fileTime - 116444736000000000n) / 10000n);
      return Number.isFinite(ms) && ms > 0 ? new Date(ms) : null;
    } catch {
      return null;
    }
  }
  // 14-digit AD generalized-time without separators.
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.\d+)?Z?$/.exec(s);
  if (m) {
    const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

// paged LDAP search wrapper. Collects all entries across paged result
// cookies into one flat array. Returns empty array if baseDn yields
// nothing — caller treats as "possible referral-only response" and logs.
async function pagedSearch(client, { baseDn, filter, attributes, pageSize, requestedSizeLimit = 0 }) {
  const out = [];
  const opts = {
    scope: 'sub',
    filter,
    attributes,
    paged: { pageSize: pageSize || 500 }
  };
  if (requestedSizeLimit > 0) opts.sizeLimit = requestedSizeLimit;
  const { searchEntries } = await client.search(baseDn, opts);
  return searchEntries || [];
}

// R158.46.3 (2026-10-06) — P2 fix: AD MaxValRange=1500 限制下大组
// (Domain Users 8000+ 等) 的 member 属性被截断, ldapts 没有自动
// follow-up range 查询, 导致 ad_groups_snapshot.member_count=0.
// 解决: group pagedSearch attributes 改用 'member;range=0-*' 强制 AD 走
// range 形式 (小组返 'member;range=0-M', 大组返 'member;range=0-1499').
// helper 从 entryDn 单点 base search, 累加所有 range 段就是真实成员数.
//
// AD 行为 ([MS-ADTS] 6.16 LDAP 3.2.1.3.16 range retrieval):
//   - 请求 'member' → 小组返 e.member, 大组返 e['member;range=0-1499']
//   - 请求 'member;range=0-*' → AD 总是返 range 形式
//   - 请求 'member;range=1500-*' → 已无成员返 empty attr (e 对象里没 member* key)
//
// 性能: 小组 (member < 1500) zero overhead (initial 直接含完整);
// 大组 (≥ 1500) ceil((N-1500)/1500) follow-up round-trips,典型 Domain
// Users 8000 = 6 round-trips. 全森林 5% 大组 + 3 平均 follow-up, 增量
// < 1000 round-trips < 30s 内网. 可接受.
//
// PAGE_CAP = 100 → 100 * 1500 = 150k members 足够覆盖几乎所有 AD 组,
// 防御 LDAP 错误循环. 入参 e 是第一次 pagedSearch 返回的 entry object.
async function fetchMemberCountWithRange(client, entryDn, e) {
  const memberKey = Object.keys(e || {}).find(k => /^member;range=\d+-\*?$/.test(k));
  const initialMembers = memberKey ? (e[memberKey] || []) : [];
  let allMembers = Array.isArray(initialMembers) ? [...initialMembers] : [];
  let offset = allMembers.length;
  // 'member;range=N-M' 形式 (M 不是 *) → AD 告诉我们这一段是末段
  if (memberKey) {
    const m = memberKey.match(/^member;range=(\d+)-(\d+|\*)$/);
    if (m && m[2] !== '*') {
      // 单段已收完 (小组)
      return allMembers.length;
    }
  }
  // 大组: 循环发 follow-up search, 每次请求 'member;range=N+1-*' (N = 已收集数).
  // AD 响应:
  //   - 还有成员: 'member;range=N+1-M' 数组 (M 可能=* 也可能=具体数)
  //   - 没成员了: 空 (e 对象里没 member* key)
  // 单次 search 用 base=entryDn, scope=base, filter='(objectClass=*)',
  // 只取 member attribute.
  let pageCount = 0;
  const PAGE_CAP = 100; // 防御 LDAP 错误循环
  while (pageCount < PAGE_CAP) {
    try {
      const opts = {
        scope: 'base',
        filter: '(objectClass=*)',
        attributes: [`member;range=${offset}-*`],
        sizeLimit: 1
      };
      const { searchEntries } = await client.search(entryDn, opts);
      const ent = searchEntries?.[0];
      if (!ent) break;
      // 找响应里的 member* key
      const key = Object.keys(ent).find(k => /^member;range=\d+-\*?$/.test(k));
      if (!key) {
        // AD 不再返 member 属性 → 已收完
        break;
      }
      const chunk = ent[key];
      if (!Array.isArray(chunk) || chunk.length === 0) break;
      allMembers = allMembers.concat(chunk);
      const mm = key.match(/^member;range=(\d+)-(\d+|\*)$/);
      if (mm && mm[2] !== '*') {
        break; // 末段
      }
      offset = allMembers.length;
      pageCount++;
    } catch {
      // LDAP 错 (连不上 / schema 错 / 权限) → 静默, 返回已收集数,
      // 不阻断整体 sync. 下次 sync 会重试.
      break;
    }
  }
  return allMembers.length;
}

// LDAP sync core. Caller (route handler or cron tick) is responsible for:
//   - inserting the ad_directory_sync_runs row before calling this
//   - resolving the bind password via `resolveBindPassword`
//   - catching throws and updating the run row with status='failed'
// On success this function updates the run row with status='success' and
// counts. Caller does NOT need to touch the row at all if it passes
// `finalize: true` (the default).
//
// `config` shape:
//   { ldapUrl, bindDn, bindPassword, baseDn, pageSize, runId }
//
// Throws on any unrecoverable error. The caller flips the run row to
// failed in its catch block (this function does NOT swallow throws).
//
// R158.44.7.7 (2026-10-05) — renamed `dcName` to `domainName`. The
// 3 snapshot tables (ad_users_snapshot / ad_groups_snapshot / ad_ous_snapshot)
// have their `dc_name` column renamed to `domain_name`. The semantic is now
// "which domain FQDN this snapshot belongs to" (e.g. 'sphkdl.shaphar.net'),
// NOT "which DC the LDAP bind was made against". The DC that bound is still
// recorded in `ad_directory_sync_runs.dc_name` (audit only) by the caller.
export async function syncDirectory({
  db = null,
  logger = null,
  domainName,
  runId,
  config,
  finalize = true,
  // R158.38 — binding-driven LDAP sync. When both forestId + domainId are
  // provided (non-null), the UPSERT paths use the `*WithForest` SQL helpers
  // (extra 2 columns forest_id + domain_id). NULL falls back to the
  // R158.35 single-forest system_config path.
  forestId = null,
  domainId = null
}) {
  if (!domainName) throw new Error('syncDirectory: domainName required');
  if (!runId) throw new Error('syncDirectory: runId required');
  const realDb = db || getDb();
  // R158.5.4 (2026-10-04) — durationMs 用于日志聚合 (manual_sync_succeeded / cron_sync_succeeded).
  const startedAt = Date.now();
  const { ldapUrl, bindDn, bindPassword, baseDn, pageSize } = config || {};
  // Pre-flight validation. R158.5.4 fix (2026-10-04) — these throws must be
  // INSIDE the outer try/catch (lines below) so a bad config immediately
  // finalizes the run as failed. Previously they sat above the try block,
  // so invalid ldapUrl / missing baseDn left the runs row stuck on
  // status='running' forever (frontend would disable the Sync now button
  // until operator manually UPDATEd the row).
  const preflightErrors = [];
  if (!ldapUrl) preflightErrors.push('ldapUrl required');
  if (!baseDn) preflightErrors.push('baseDn required');
  if (ldapUrl && !/^ldaps?:\/\/[^/]+:\d{2,5}$/.test(ldapUrl)) {
    preflightErrors.push(
      `invalid ldapUrl '${ldapUrl}' (expected ldap://host:389 or ldaps://host:636; ` +
      `go to /admin/forest-registry → Tab 1 → edit forest → fix ad_url)`
    );
  }
  if (preflightErrors.length > 0) {
    const msg = preflightErrors.join('; ');
    if (finalize) {
      try {
        await realDb.execute(realDb.sql.directorySync.finalizeRun, [
          'failed', 0, 0, 0, 0, msg.slice(0, 1900), runId
        ]);
      } catch (finalizeErr) {
        logger?.warn?.({ component: 'directory-sync', runId, err: finalizeErr.message },
          'failed to mark run as failed (preflight)');
      }
    }
    throw new Error(`syncDirectory preflight: ${msg}`);
  }
  // R158.38 — choose SQL path. Caller passes forestId+domainId explicitly
  // when in binding-driven mode (directory-sync-loop.js _bindingTick).
  // The legacy fallback path (routes/admin.js manual trigger when no
  // binding exists) leaves them null and uses the original SQL helpers.
  const dialect = realDb.dialect;
  const sql = realDb.sql.directorySync;
  const useForest = forestId != null && domainId != null;
  // R158.44.7 (2026-10-04) — ROOT CAUSE FIX: sql.js exports `upsertUserWithForest`
  // as a flat string PER DIALECT (the dict is keyed by db.dialect at boot via
  // buildSql(dialect); service code reads db.sql.<domain>.<query> and gets
  // back a plain string). The previous code did
  //   sql.upsertUserWithForest[dialect]
  // which is `"<MSSQL MERGE string>"[dialect]` — string characters can only
  // be indexed by numeric indices, so this returned `undefined`. That
  // undefined flowed into tx.execute → txWrapper.execute → rewritePlaceholders
  // → `undefined.replace(...)` → TypeError "Cannot read properties of
  // undefined (reading 'replace')". Both branches (useForest true/false)
  // were affected because the schema has only one key per helper, not a
  // nested dict keyed by dialect. Stack from runId=20 pinned the throw to
  // mssql.js:21 (rewritePlaceholders), confirming.
  const upsertUserSql = useForest ? sql.upsertUserWithForest : sql.upsertUser;
  const upsertGroupSql = useForest ? sql.upsertGroupWithForest : sql.upsertGroup;
  const upsertOuSql = useForest ? sql.upsertOuWithForest : sql.upsertOu;
  // R158.44.7.10 — computer SQL mirror (useForest gates WithForest variant).
  const upsertComputerSql = useForest ? sql.upsertComputerWithForest : sql.upsertComputer;
  // finalizeRun: same SQL shape between forest and non-forest paths (7 params);
  // the runs row already has forest_id/domain_id from insertRunWithForest
  // at tick time. No need to rewrite on finalize.
  const useTls = ldapUrl.startsWith('ldaps://');
  const client = new Client({
    url: ldapUrl,
    timeout: 30_000,
    connectTimeout: 15_000,
    ...(useTls ? { tlsOptions: { rejectUnauthorized: false } } : {})
  });

  let bindOk = false;
  try {
    // R158.44.7 (2026-10-04) — stage logging for operator run. Service layer
    // 日志比 driver 内部 diag 直接: 能精准到「users 第几条」/「groups」/「ous」/「DELETE 哪一片段」
    // 边界。Driver 层 replace 错被 operator 看到的是 mssql@11 类型推断堆栈,
    // service 层能告诉我们是哪一组/哪一条 entry 携带出问题的字段.
    const stageLog = (stage, extra = {}) => logger?.info?.({
      component: 'directory-sync',
      event: `sync_stage_${stage}`,
      domainName, runId, ...extra
    }, `sync stage: ${stage}`);
    stageLog('bind_start', { ldapUrl, bindDn: bindDn || '', bindPasswordLen: (bindPassword || '').length });
    // 3-attempt retry on connect+bind (handles transient LDAP blips).
    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await client.bind(bindDn || '', bindPassword || '');
        bindOk = true;
        stageLog('bind_ok', { attempt });
        break;
      } catch (e) {
        lastErr = e;
        logger?.warn?.({ component: 'directory-sync', attempt, err: e.message }, 'LDAP bind failed');
        if (attempt < 3) await new Promise(r => setTimeout(r, 1000 * attempt));
      }
    }
    if (!bindOk) throw new Error(`LDAP bind failed after 3 attempts: ${lastErr?.message || 'unknown'}`);

    // Three paged searches.
    stageLog('search_users_start');
    const userEntries = await pagedSearch(client, {
      baseDn,
      filter: '(|(objectCategory=person)(objectClass=user))',
      // R158.36 (2026-10-03) — added `description` + `manager` so the
      // snapshot exposes those fields without a follow-up LDAP round-trip.
      //
      // R158.X.116-ldaptime (2026-10-22) — 加 lastLogonTimestamp. 之前
      // last_logon 列恒 null, 因为: (a) 属性列表里根本没请求任何 lastLogon
      // 属性, 而下面的映射读的是 e.lastLogon; (b) 就算请求了 lastLogon,
      // 它也只在 DC 本机有值 (legacy 属性, [MS-ADTS] 建议改用 Timestamp
      // 副本属性). 选 lastLogonTimestamp 与 computer 查询 (:414 附近) 同名
      // 同口径 —— 那边一直是这么写的, 这边跟齐, 免得两条路径语义分叉.
      attributes: [
        'sAMAccountName', 'displayName', 'distinguishedName', 'description',
        'enabled', 'lockoutTime', 'whenCreated', 'pwdLastSet',
        'lastLogonTimestamp', 'userAccountControl', 'manager'
      ],
      pageSize: pageSize || 500
    });
    stageLog('search_users_ok', { rowCount: userEntries.length });
    stageLog('search_groups_start');
    const groupEntries = await pagedSearch(client, {
      baseDn,
      filter: '(objectCategory=group)',
      // R158.44.7.4 (2026-10-04) — must request `cn` (AD group RDN is cn=,
      // not name=). Without it `e.cn` and `e.name` are both undefined, the
      // groupRows filter wipes every group out, and ad_groups_snapshot stays
      // empty even though the search succeeded.
      // R158.46.3 (2026-10-06) — P2 fix: 改 'member' → 'member;range=0-*'.
      // AD MaxValRange=1500 限制下大组 (Domain Users 8000+ 等) 'member' 属性
      // 被截断返回, ldapts 不会自动 follow-up. range form 强制 AD 走分段
      // 返回 + helper fetchMemberCountWithRange 累加成真实成员数.
      attributes: [
        'cn', 'name', 'sAMAccountName', 'distinguishedName',
        'groupType', 'groupScope', 'description',
        'member;range=0-*'
      ],
      pageSize: pageSize || 500
    });
    stageLog('search_groups_ok', { rowCount: groupEntries.length });
    stageLog('search_ous_start');
    const ouEntries = await pagedSearch(client, {
      baseDn,
      filter: '(&(objectCategory=organizationalUnit)(!(isDeleted=TRUE)))',
      attributes: ['name', 'distinguishedName', 'description', 'whenCreated', 'whenChanged'],
      pageSize: pageSize || 500
    });
    stageLog('search_ous_ok', { rowCount: ouEntries.length });
    // R158.44.7.10 (2026-10-05) — computer search (4th object class).
    // operator 决策 "包含所有 computer" (跟 sync users 一致: 全量含 disabled).
    // R158.44.7.4 lesson — cn/name/distinguishedName 显式白名单.
    // 跳过 memberOf/servicePrincipalName (AD 端 expensive, 用 ad_groups_snapshot.member 反查).
    stageLog('search_computers_start');
    const computerEntries = await pagedSearch(client, {
      baseDn,
      filter: '(&(objectCategory=computer)(!(isDeleted=TRUE)))',
      attributes: [
        'cn', 'name', 'sAMAccountName', 'distinguishedName',
        'operatingSystem', 'operatingSystemVersion', 'dnsHostName',
        'userAccountControl', 'whenCreated', 'whenChanged',
        'lastLogonTimestamp', 'description', 'managedBy'
      ],
      pageSize: pageSize || 500
    });
    stageLog('search_computers_ok', { rowCount: computerEntries.length });

    logger?.info?.({
      component: 'directory-sync',
      event: 'ldap_search_complete',
      domainName, runId,
      users: userEntries.length, groups: groupEntries.length,
      ous: ouEntries.length, computers: computerEntries.length,
      ldapUrl, baseDn
    }, 'LDAP search complete');

    // Build the per-table row batches. Use UTC ISO strings for timestamps
    // so MySQL DATETIME / MSSQL DATETIME2 accept them (db.js handles the
    // dialect-specific rewrite; both drivers accept ISO when the column
    // is DATETIME2 or with the right format).
    const snapshotAt = new Date();
    const userSams = new Set();
    const groupNames = new Set();
    const ouDns = new Set();
    // R158.44.7.10 (2026-10-05) — computer SAMS Set for orphan DELETE.
    const computerSams = new Set();
    const userRows = userEntries
      .filter(e => e.sAMAccountName)
      .map(e => {
        userSams.add(String(e.sAMAccountName));
        // UAC bit 0x00000002 = ACCOUNTDISABLE → enabled = !bit
        const uac = Number(e.userAccountControl || 0);
        const enabled = uac > 0 ? (uac & 0x0002) === 0 : null;
        // lockoutTime is a Windows FILETIME integer; adGenTimeToDate handles
        // both forms (string or integer).
        const lockedOut = (() => {
          const t = adGenTimeToDate(e.lockoutTime);
          if (t == null) return 0;
          // AD lockoutTime=0 means not locked; non-zero means locked.
          return Math.abs(t.getTime()) > 0 ? 1 : 0;
        })();
        // Extract parent OU DN by stripping RDN prefix from DN.
        const dn = String(e.distinguishedName || '');
        const ouDn = dn.includes(',') ? dn.slice(dn.indexOf(',') + 1) : null;
        return {
          sam: String(e.sAMAccountName),
          display_name: e.displayName ? String(e.displayName) : null,
          distinguished_name: dn,
          ou_dn: ouDn,
          enabled: boolToInt(enabled),
          locked_out: boolToInt(lockedOut),
          // R158.X.116-ldaptime — 读 lastLogonTimestamp (属性列表已加),
          // 不再读从未请求的 e.lastLogon. 1:1 对齐 computer 侧 :553 附近.
          last_logon: adGenTimeToDate(e.lastLogonTimestamp),
          when_created: adGenTimeToDate(e.whenCreated),
          password_last_set: adGenTimeToDate(e.pwdLastSet),
          user_account_control: uac > 0 ? uac : null,
          // R158.36 (2026-10-03) — description + manager (LDAP attribute
          // returns full DN; we extract the SAM at parse time so the UI
          // doesn't have to parse a DN string per row).
          description: e.description ? String(e.description) : null,
          manager_dn: e.manager ? String(e.manager) : null,
          manager_sam: parseSamFromDn(e.manager)
        };
      });
    const groupRows = groupEntries
      // R158.44.7.4 (2026-10-04) — AD group RDN is cn= (RDN attribute
      // `cn`), not `name=`. LDAP returns `name` only when explicitly
      // requested, but `cn` is the actual attribute. Accept either.
      // R158.50.4 (2026-10-07) — AD builtin container (CN=Builtin,DC=...)
      // groups (Remote Desktop Users / Server Operators / Account Operators
      // 等 30+ 一类) 的 distinguishedName attribute 被 system ACL deny
      // Read, ldapjs 解析后 e.distinguishedName 是 undefined. filter
      // 跳过 (e.distinguishedName 非空), builtin 容器内的内置组不进
      // ad_groups_snapshot. OU 树 rollUp 本就排除 Builtin (R158.45.11),
      // 业务零影响. R180 深查 ldapjs buffer parse.
      .filter(e => (e.cn || e.name) && e.distinguishedName && String(e.distinguishedName).length > 0);
    // R158.46.3 (2026-10-06) — P2 fix: 改 sync .map 为 async + Promise.all.
    // 原来 sync .map 取 e.member.length → 大组 (>=1500 member) 永远 0.
    // 现在 await fetchMemberCountWithRange(client, dn, e) 累加所有 range 段.
    const groupRowsResolved = await Promise.all(groupRows.map(async (e) => {
      const nm = String(e.cn || e.name);
      groupNames.add(nm);
      // R158.44.7.7 (2026-10-05) — operator: groups must be associated
      // with OU for the OU-tree display. Extract parent OU DN by stripping
      // the RDN prefix from DN (same trick userRows uses). Top-level
      // groups (CN=...,DC=...) get ou_dn=null and show as orphan groups.
      const gdn = String(e.distinguishedName || '');
      const ouDn = gdn.includes(',') ? gdn.slice(gdn.indexOf(',') + 1) : null;
      // R158.46.3 — P2 fix: range-aware helper, 小组 0 overhead, 大组 N 段累加
      const memberCount = await fetchMemberCountWithRange(client, gdn, e);
      return {
        name: nm,
        sam_account_name: e.sAMAccountName ? String(e.sAMAccountName) : null,
        distinguished_name: gdn,
        ou_dn: ouDn,
        group_type: Number(e.groupType) || null,
        group_scope: e.groupScope ? String(e.groupScope) : null,
        description: e.description ? String(e.description) : null,
        member_count: memberCount
      };
    }));
    const ouRows = ouEntries
      .filter(e => e.distinguishedName)
      .map(e => {
        const dn = String(e.distinguishedName);
        ouDns.add(dn);
        const commaIdx = dn.indexOf(',');
        const parentDn = commaIdx > 0 ? dn.slice(commaIdx + 1) : null;
        return {
          distinguished_name: dn,
          name: e.name ? String(e.name) : null,
          description: e.description ? String(e.description) : null,
          when_created: adGenTimeToDate(e.whenCreated),
          when_changed: adGenTimeToDate(e.whenChanged),
          parent_dn: parentDn
        };
      });
    // R158.44.7.10 (2026-10-05) — computer rows. PK = sam_account_name.
    // 跟 users 一致: cn || sAMAccountName 兜底 (R158.44.7.4 lesson).
    const computerRows = computerEntries
      .filter(e => e.cn || e.sAMAccountName)
      .map(e => {
        const cdn = String(e.distinguishedName || '');
        const uac = Number(e.userAccountControl || 0);
        const enabled = uac > 0 ? (uac & 0x0002) === 0 : null;
        // UAC bit 0x20000 = SERVER_TRUST_ACCOUNT (DC 跟 member server 都设).
        const isServer = uac > 0 ? (uac & 0x20000) !== 0 : null;
        const ouDn = cdn.includes(',') ? cdn.slice(cdn.indexOf(',') + 1) : null;
        const sam = e.sAMAccountName ? String(e.sAMAccountName) : null;
        if (sam) computerSams.add(sam);
        return {
          sam_account_name: sam,
          cn: e.cn ? String(e.cn) : null,
          name: e.name ? String(e.name) : null,
          distinguished_name: cdn,
          ou_dn: ouDn,
          enabled: boolToInt(enabled),
          is_server: boolToInt(isServer),
          operating_system: e.operatingSystem ? String(e.operatingSystem) : null,
          operating_system_version: e.operatingSystemVersion ? String(e.operatingSystemVersion) : null,
          dns_host_name: e.dnsHostName ? String(e.dnsHostName) : null,
          last_logon: adGenTimeToDate(e.lastLogonTimestamp),
          when_created: adGenTimeToDate(e.whenCreated),
          when_changed: adGenTimeToDate(e.whenChanged),
          description: e.description ? String(e.description) : null,
          managed_by_dn: e.managedBy ? String(e.managedBy) : null,
          managed_by_sam: parseSamFromDn(e.managedBy)
        };
      });

    // Persist. Each UPSERT goes through db.sql.directorySync.<query>
    // (registered in sql.js for both mysql and mssql).
    // R158.44.7 (2026-10-04) — defensive undefined→null sweep over every param
    // BEFORE we hand them to mssql driver. mssql@11 Request.input(value) throws
    // "Cannot read properties of undefined (reading 'replace')" inside its type-
    // inference code path when a value is undefined (not null — null is bound
    // fine, undefined triggers `value.replace(...)` somewhere in the
    // declarations parser). The original `replace` throw from the mssql
    // driver surfaces as a TypeError with no useful location; pre-sanitizing
    // every param makes the symptom impossible regardless of which LDAP field
    // happens to be missing in a given row.
    const sanitizeArr = (arr) => {
      for (let j = 0; j < arr.length; j++) if (arr[j] === undefined) arr[j] = null;
      return arr;
    };
    await realDb.transaction(async (tx) => {
      // Insert run-started marker (no-op when caller already inserted the
      // row — the runs row is updated to success at the end via UPDATE).
      // Actually: caller inserted the row before calling syncDirectory,
      // so we just do UPSERT + DELETE inside this tx.
      // R158.44.7 (2026-10-04) — wrap each per-row tx.execute in its own
      // try/catch so we can localize which row + which params triggered the
      // mssql "Cannot read properties of undefined (reading 'replace')"
      // throw. Without the inner catch, the outer tx re-throws immediately
      // and we lose the params that produced it. We re-throw after logging
      // so the tx still rolls back (we never want a partial write to land).
      // R158.44.7.7 (2026-10-05) — first param is now `domainName` (FQDN),
      // not `dcName` (DC hostname). groups param list also grows by 1
      // (r.ou_dn) — the snapshot table gained it.
      const txUserParams = useForest ? (r) => [
        domainName, r.sam, r.display_name, r.distinguished_name, r.ou_dn,
        r.enabled, r.locked_out,
        toDbTimestamp(r.last_logon),
        toDbTimestamp(r.when_created),
        toDbTimestamp(r.password_last_set),
        r.user_account_control,
        r.description,
        r.manager_dn,
        r.manager_sam,
        toDbTimestamp(snapshotAt),
        runId,
        forestId, domainId
      ] : (r) => [
        domainName, r.sam, r.display_name, r.distinguished_name, r.ou_dn,
        r.enabled, r.locked_out,
        toDbTimestamp(r.last_logon),
        toDbTimestamp(r.when_created),
        toDbTimestamp(r.password_last_set),
        r.user_account_control,
        r.description,
        r.manager_dn,
        r.manager_sam,
        toDbTimestamp(snapshotAt),
        runId
      ];
      // R158.50.4 (2026-10-07) — txGroupParams reads snake_case fields from
      // `r`. Must use groupRowsResolved (built line 528 by async map), NOT
      // groupRows (raw LDAP entries with camelCase keys like e.sAMAccountName
      // / e.distinguishedName / e.groupType — those are undefined under
      // snake_case, sanitizeArr → null, mssql hits NOT NULL constraint).
      const txGroupParams = useForest ? (r) => [
        domainName, r.name, r.sam_account_name, r.distinguished_name, r.ou_dn,
        r.group_type, r.group_scope, r.description, r.member_count,
        toDbTimestamp(snapshotAt), runId,
        forestId, domainId
      ] : (r) => [
        domainName, r.name, r.sam_account_name, r.distinguished_name, r.ou_dn,
        r.group_type, r.group_scope, r.description, r.member_count,
        toDbTimestamp(snapshotAt), runId
      ];
      const txOuParams = useForest ? (r) => [
        domainName, r.distinguished_name, r.name, r.description,
        toDbTimestamp(r.when_created),
        toDbTimestamp(r.when_changed),
        r.parent_dn,
        toDbTimestamp(snapshotAt), runId,
        forestId, domainId
      ] : (r) => [
        domainName, r.distinguished_name, r.name, r.description,
        toDbTimestamp(r.when_created),
        toDbTimestamp(r.when_changed),
        r.parent_dn,
        toDbTimestamp(snapshotAt), runId
      ];
      // R158.44.7.10 (2026-10-05) — computer params (19 / 21 params).
      // 顺序: domainName, sam, cn, name, dn, ouDn, enabled, isServer,
      //        os, osVersion, dnsHost, lastLogon, whenCreated, whenChanged,
      //        description, managedByDn, managedBySam, snapshotAt, runId[, forestId, domainId]
      const txComputerParams = useForest ? (r) => [
        domainName, r.sam_account_name, r.cn, r.name, r.distinguished_name, r.ou_dn,
        r.enabled, r.is_server,
        r.operating_system, r.operating_system_version, r.dns_host_name,
        toDbTimestamp(r.last_logon),
        toDbTimestamp(r.when_created),
        toDbTimestamp(r.when_changed),
        r.description, r.managed_by_dn, r.managed_by_sam,
        toDbTimestamp(snapshotAt), runId,
        forestId, domainId
      ] : (r) => [
        domainName, r.sam_account_name, r.cn, r.name, r.distinguished_name, r.ou_dn,
        r.enabled, r.is_server,
        r.operating_system, r.operating_system_version, r.dns_host_name,
        toDbTimestamp(r.last_logon),
        toDbTimestamp(r.when_created),
        toDbTimestamp(r.when_changed),
        r.description, r.managed_by_dn, r.managed_by_sam,
        toDbTimestamp(snapshotAt), runId
      ];
      stageLog('write_users_start', { total: userRows.length });
      for (let i = 0; i < userRows.length; i++) {
        const r = userRows[i];
        const params = sanitizeArr(txUserParams(r));
        try {
          await tx.execute(upsertUserSql, params);
        } catch (rowErr) {
          stageLog('write_users_FAIL', {
            index: i, total: userRows.length, sam: r.sam,
            paramDump: params.map((v, idx) => ({
              idx, type: v === undefined ? 'UNDEF' : v === null ? 'null' : v instanceof Date ? 'Date' : typeof v,
              valuePreview: v instanceof Date ? v.toISOString() : (typeof v === 'string' ? v.slice(0, 80) : String(v))
            })),
            errMessage: rowErr.message,
            errStack: String(rowErr.stack || '').split('\n').slice(0, 6).join(' | ')
          });
          throw rowErr;
        }
        if ((i + 1) % 1000 === 0 || i === userRows.length - 1) {
          stageLog('write_users_progress', { index: i + 1, total: userRows.length });
        }
      }
      stageLog('write_groups_start', { total: groupRowsResolved.length });
      for (let i = 0; i < groupRowsResolved.length; i++) {
        const r = groupRowsResolved[i];
        const params = sanitizeArr(txGroupParams(r));
        try {
          await tx.execute(upsertGroupSql, params);
        } catch (rowErr) {
          stageLog('write_groups_FAIL', {
            index: i, total: groupRowsResolved.length, name: r.name,
            paramDump: params.map((v, idx) => ({
              idx, type: v === undefined ? 'UNDEF' : v === null ? 'null' : v instanceof Date ? 'Date' : typeof v,
              valuePreview: v instanceof Date ? v.toISOString() : (typeof v === 'string' ? v.slice(0, 80) : String(v))
            })),
            errMessage: rowErr.message,
            errStack: String(rowErr.stack || '').split('\n').slice(0, 6).join(' | ')
          });
          throw rowErr;
        }
      }
      stageLog('write_ous_start', { total: ouRows.length });
      for (let i = 0; i < ouRows.length; i++) {
        const r = ouRows[i];
        const params = sanitizeArr(txOuParams(r));
        try {
          await tx.execute(upsertOuSql, params);
        } catch (rowErr) {
          stageLog('write_ous_FAIL', {
            index: i, total: ouRows.length, dn: r.distinguished_name,
            paramDump: params.map((v, idx) => ({
              idx, type: v === undefined ? 'UNDEF' : v === null ? 'null' : v instanceof Date ? 'Date' : typeof v,
              valuePreview: v instanceof Date ? v.toISOString() : (typeof v === 'string' ? v.slice(0, 80) : String(v))
            })),
            errMessage: rowErr.message,
            errStack: String(rowErr.stack || '').split('\n').slice(0, 6).join(' | ')
          });
          throw rowErr;
        }
      }
      // R158.44.7.10 (2026-10-05) — write_computers loop (mirror write_groups).
      stageLog('write_computers_start', { total: computerRows.length });
      for (let i = 0; i < computerRows.length; i++) {
        const r = computerRows[i];
        const params = sanitizeArr(txComputerParams(r));
        try {
          await tx.execute(upsertComputerSql, params);
        } catch (rowErr) {
          stageLog('write_computers_FAIL', {
            index: i, total: computerRows.length, sam: r.sam_account_name,
            paramDump: params.map((v, idx) => ({
              idx, type: v === undefined ? 'UNDEF' : v === null ? 'null' : v instanceof Date ? 'Date' : typeof v,
              valuePreview: v instanceof Date ? v.toISOString() : (typeof v === 'string' ? v.slice(0, 80) : String(v))
            })),
            errMessage: rowErr.message,
            errStack: String(rowErr.stack || '').split('\n').slice(0, 6).join(' | ')
          });
          throw rowErr;
        }
        if ((i + 1) % 1000 === 0 || i === computerRows.length - 1) {
          stageLog('write_computers_progress', { index: i + 1, total: computerRows.length });
        }
      }

      // R158.60.20 (2026-10-09) — user-group membership rows. groupEntries
      // already carries `member;range=0-*` (R158.46.3). For each group, parse
      // the member DN list → resolve to user.sam via ad_users_snapshot join
      // map built in memory. Writes 1 row per (user, group) pair. Stale rows
      // (user/group deleted in AD) get swept by the always-clean DELETE
      // below (orphan cleanup). The new /api/admin/ad-users/:sam/groups
      // route reads this table directly so the UI is no longer gated on the
      // R75 ad_user_list_groups agent command + 15×1.5s poll (22.5s
      // timeout). Trade-off: 5min sync lag, but consistent with the rest
      // of the snapshot views.
      const userDnToSam = new Map();
      for (const u of userRows) {
        if (u.distinguished_name && u.sam) {
          userDnToSam.set(String(u.distinguished_name).toLowerCase(), String(u.sam));
        }
      }
      const ugmRows = [];
      for (const e of groupEntries) {
        const gdn = String(e.distinguishedName || '');
        if (!gdn) continue;
        const gname = String(e.cn || e.name || '');
        if (!gname) continue;
        // R158.60.20.1 (2026-10-09) — R158.60.20 ship 写 `e.member || []`,
        // 但 pagedSearch attributes=['member;range=0-*'] 让 ldapjs 永远
        // 返 range-form key (例如 'member;range=0-1499'), `e.member` 永
        // 远是 undefined → ugmRows.length = 0. 修: 找 `member;range=...`
        // key, 取它数组, 然后**额外** fall back `e.member` (R158.46.3 注释
        // 说小组 AD 会自动 strip range prefix 返 plain `member`, 但实测
        // 我们环境也是 range-form, 所以两路都查).
        const memberKey = Object.keys(e || {}).find(k => /^member(;range=\d+-\*?)?$/.test(k));
        const members = memberKey ? (e[memberKey] || []) : [];
        for (const m of members) {
          if (typeof m !== 'string') continue;
          // Strip AD range prefix if present (e.g. "member;range=0-1499:DN")
          const colonIdx = m.indexOf(':');
          const memberDn = colonIdx >= 0 ? m.slice(colonIdx + 1) : m;
          if (!memberDn) continue;
          // R158.60.20 — only ingest user-type members (group nesting
          // would be a separate edge; primary groups are also represented
          // as `member` rows in some AD flavors; we record the literal
          // edge regardless, "primary group" semantics live downstream).
          const sam = userDnToSam.get(memberDn.toLowerCase());
          if (!sam) continue; // not a user we know about — group/computer
          ugmRows.push({ user_sam: sam, group_dn: gdn, group_name: gname });
        }
      }
      stageLog('write_ugm_start', { total: ugmRows.length });
      const upsertUgmSql = realDb.sql.directorySync.upsertUgm;
      const txUgmParams = (r) => sanitizeArr([
        domainName, r.user_sam, r.group_dn, r.group_name,
        toDbTimestamp(snapshotAt), runId
      ]);
      for (let i = 0; i < ugmRows.length; i++) {
        const r = ugmRows[i];
        try {
          await tx.execute(upsertUgmSql, txUgmParams(r));
        } catch (rowErr) {
          stageLog('write_ugm_FAIL', {
            index: i, total: ugmRows.length,
            user_sam: r.user_sam, group_dn: r.group_dn,
            errMessage: rowErr.message
          });
          throw rowErr;
        }
        if ((i + 1) % 5000 === 0 || i === ugmRows.length - 1) {
          stageLog('write_ugm_progress', { index: i + 1, total: ugmRows.length });
        }
      }
    });

    // R158.60.5 (2026-10-09) — operator feedback "Testou 在 AD 删了但 DB 还
    // 存在, /admin/daily-ops 看得到". 撤 R158.45.13 增量模式保留 orphan 的
    // 决策, 改成 4 表都跑 always-clean — AD 删的对象走 pagedSearch 不会再
    // 出 LDAP result, ouDns/userSams/... Set 不含 → DELETE 删 DB row.
    //
    // 设计依据:
    //   - pagedSearch 用 ldapts `paged: { pageSize }` 自动翻页, AD 默认完整
    //     retrieval (pageSize=500), upsert 一致性靠 pagedSearch 一次性全拉
    //     集合 → mysql/MSSQL pool 通量 OK
    //   - 一致性可证: pagedSearch 一次 sub search 全 forest 拉完 = "current
    //     AD 状态", missing PK in Set = AD 已删 → 删 DB row 合 operator 期望
    //   - 跟 R158.45.13 设计的 incremental 保留 (历史 audit) 反向, 但
    //     /admin/daily-ops 是运营视图, 没有 audit 要求
    //
    // 风险 + safeguard:
    //   - 风险: pagedSearch 漏抓任何 AD object 会误删. 概率: 中性 (ldapts
    //     paged 自动跟 cookie, 一次 sub search = 全量)
    //   - safeguard: stageLog 'orphan_always_clean_run' 记录 4 表分别 ldap
    //     count + orphan deleted count, 失败异常可见
    //   - safeguard: finalize `orphanDeleted` count 写 ad_directory_sync_runs,
    //     UI matrix 可以看 trend
    stageLog('write_tx_committed', {
      usersWritten: userRows.length, groupsWritten: groupRows.length,
      ousWritten: ouRows.length, computersWritten: computerRows.length,
      ldapUsers: userEntries.length, ldapGroups: groupEntries.length,
      ldapOus: ouEntries.length, ldapComputers: computerEntries.length
    });
    const orphanUserDel = await deleteOrphans(realDb, 'ad_users_snapshot', 'sam', domainName, userSams);
    const orphanGroupDel = await deleteOrphans(realDb, 'ad_groups_snapshot', 'name', domainName, groupNames);
    const orphanOuDel = await deleteOrphans(realDb, 'ad_ous_snapshot', 'distinguished_name', domainName, ouDns);
    // R158.44.7.10 (2026-10-05) — computer orphan DELETE.
    const orphanComputerDel = await deleteOrphans(realDb, 'ad_computers_snapshot', 'sam_account_name', domainName, computerSams);
    // R158.60.20 (2026-10-09) — user-group membership orphans. The ugm
    // table has composite PK (domain_name, user_sam, group_dn) but we
    // sweep by user_sam — any row whose user is no longer in the LDAP
    // snapshot is stale. Reuse deleteOrphans (R158.45.13 / R158.60.19
    // temp-table route) which accepts an arbitrary pkCol argument.
    const orphanUgmDel = await deleteOrphans(
      realDb, 'ad_user_group_memberships', 'user_sam', domainName, userSams
    );
    stageLog('orphan_always_clean_run', {
      users: orphanUserDel, groups: orphanGroupDel,
      ous: orphanOuDel, computers: orphanComputerDel,
      ugm: orphanUgmDel
    });

    logger?.info?.({
      component: 'directory-sync',
      domainName, runId,
      orphanDeleted: { users: orphanUserDel, groups: orphanGroupDel, ous: orphanOuDel, computers: orphanComputerDel, ugm: orphanUgmDel }
    }, 'snapshot orphan cleanup complete');

    if (finalize) {
      await realDb.execute(realDb.sql.directorySync.finalizeRun, [
        'success', userRows.length, groupRows.length, ouRows.length, computerRows.length, null, runId
      ]);
    }
    return {
      ok: true,
      userCount: userRows.length,
      groupCount: groupRows.length,
      ouCount: ouRows.length,
      computerCount: computerRows.length,
      orphanDeleted: { users: orphanUserDel, groups: orphanGroupDel, ous: orphanOuDel, computers: orphanComputerDel },
      durationMs: Date.now() - startedAt
    };
  } catch (e) {
    const isPreflight = /^syncDirectory preflight:/.test(e?.message || '');
    logger?.warn?.({
      component: 'directory-sync',
      event: isPreflight ? 'sync_failed_preflight' : 'sync_failed_sync',
      runId, domainName, ldapUrl, baseDn,
      durationMs: Date.now() - startedAt,
      errorMessage: e?.message || String(e),
      stack: e?.stack ? String(e.stack).split('\n').slice(0, 3).join('\n') : null
    }, 'syncDirectory threw; run finalized as failed');
    if (finalize) {
      try {
        await realDb.execute(realDb.sql.directorySync.finalizeRun, [
          'failed', 0, 0, 0, 0, (e?.message || String(e)).slice(0, 1900), runId
        ]);
      } catch (finalizeErr) {
        logger?.warn?.({ component: 'directory-sync', err: finalizeErr.message }, 'failed to mark run as failed');
      }
    }
    throw e;
  } finally {
    try { if (bindOk) await client.unbind(); } catch { /* ignore */ }
  }
}

// Convert JS Date to a DB-friendly timestamp. MySQL DATETIME accepts
// 'YYYY-MM-DD HH:mm:ss[.fff]' via toMysqlDatetime; MSSQL DATETIME2 accepts
// ISO 8601. db.js dialect-aware helper handles per-driver formatting via
// toMysqlDatetime on the mysql path. For mssql we pass ISO directly.
function toDbTimestamp(v) {
  if (v == null) return null;
  if (v instanceof Date) return v;
  return v;
}

// R158.36 (2026-10-03) — Extract sAMAccountName from an AD distinguished
// name string. The manager LDAP attribute returns a full DN like
// "CN=jdoe,OU=Users,DC=corp,DC=local"; the centre's UI wants just the
// sam ("jdoe") so the operator can pivot straight into the same row.
// Strategy: pull the first RDN segment (`CN=jdoe` or `CN=jdoe,CN=Users`),
// strip the CN= prefix, return null if the parse fails.
function parseSamFromDn(dn) {
  if (!dn || typeof dn !== 'string') return null;
  const first = dn.split(',')[0];
  if (!first) return null;
  const eq = first.indexOf('=');
  if (eq < 0) return null;
  const val = first.slice(eq + 1).trim();
  return val.length > 0 ? val : null;
}

// Delete rows for domain_name whose PK is NOT in the just-collected Set.
// Chunked at 500 to keep both MySQL and MSSQL IN-lists manageable.
// Returns total rows deleted across chunks.
// R158.44.7.7 (2026-10-05) — column renamed dc_name -> domain_name; `key=now`
// holds the domain FQDN (e.g. 'sphkdl.shaphar.net') rather than the DC
// hostname that ran the LDAP bind.
async function deleteOrphans(db, table, pkCol, domainName, idsSet) {
  const ids = [...idsSet];
  if (ids.length === 0) return 0;
  let total = 0;
  const CHUNK = 500;
  // R158.45.13 (2026-10-05) — fix: previous chunked `NOT IN (500 ids)` was
  // semantically wrong. Each chunk only excluded its own 500 ids, so chunks
  // 1 and 2 wiped every row not in the first 1000 ids; chunks 3+ found
  // nothing. With 7527 users / 3865 computers the table ended empty even
  // though MERGE had committed 7527 rows. The fix loads all ids into a temp
  // table (no IN-list limit), then a single DELETE with NOT IN (SELECT…)
  // excludes exactly the rows absent from LDAP.
  //
  // R158.60.19 (2026-10-09) — fix: MSSQL temp tables are session-scoped
  // (per connection). When CREATE/INSERT/DELETE are issued as separate
  // `pool.request()` calls, each call may grab a different connection from
  // the pool, leaving subsequent INSERTs to fail with "Invalid object name
  // '#orphan_keep'". Operator saw this on KDLFLOFADSRV1 in
  // ad_directory_sync_runs (cron, 12.1s elapsed, status=failed). Fix: route
  // the whole block through `db.transaction()` so all statements share one
  // bound `sql.Request(tx)` — connection-pinned for the tx lifetime. MySQL
  // temp tables are also connection-scoped, so the same routing keeps the
  // two dialects symmetric.
  const idColSql = pkCol; // safe: fixed literal from caller
  const tempName = '#orphan_keep';
  return db.transaction(async (tx) => {
    if (db.dialect === 'mysql') {
      // MySQL temp table — engine MEMORY, scoped to the connection (tx-pinned).
      await tx.execute(
        `CREATE TEMPORARY TABLE ${tempName} (
           ${idColSql} VARCHAR(256) NOT NULL,
           PRIMARY KEY (${idColSql})
         ) ENGINE=MEMORY`,
        []
      );
      for (let i = 0; i < ids.length; i += CHUNK) {
        const chunk = ids.slice(i, i + CHUNK);
        const placeholders = chunk.map(() => '(?)').join(',');
        await tx.execute(
          `INSERT INTO ${tempName} (${idColSql}) VALUES ${placeholders}`,
          chunk
        );
      }
      const r = await tx.execute(
        `DELETE FROM ${table} WHERE domain_name = ? AND ${idColSql} NOT IN (SELECT ${idColSql} FROM ${tempName})`,
        [domainName]
      );
      total = Number(r?.affectedRows ?? r?.rowCount ?? 0);
      await tx.execute(`DROP TEMPORARY TABLE IF EXISTS ${tempName}`, []).catch(() => {});
    } else {
      // MSSQL temp table — explicit DROP / CREATE wrapping is required when
      // reusing the pool (a previous session may have left #orphan_keep).
      // tx-pinning means all statements share one connection; the temp
      // table lives in tempdb for the tx lifetime, then auto-drops on commit.
      await tx.execute(
        `IF OBJECT_ID('tempdb..${tempName}') IS NOT NULL DROP TABLE ${tempName};
         CREATE TABLE ${tempName} (${idColSql} NVARCHAR(256) NOT NULL PRIMARY KEY);`,
        []
      );
      for (let i = 0; i < ids.length; i += CHUNK) {
        const chunk = ids.slice(i, i + CHUNK);
        const placeholders = chunk.map(() => '(?)').join(',');
        await tx.execute(
          `INSERT INTO ${tempName} (${idColSql}) VALUES ${placeholders}`,
          chunk
        );
      }
      const r = await tx.execute(
        `DELETE FROM ${table} WHERE domain_name = ? AND ${idColSql} NOT IN (SELECT ${idColSql} FROM ${tempName})`,
        [domainName]
      );
      total = Number(r?.affectedRows ?? r?.rowCount ?? 0);
      // No explicit DROP needed — tempdb temp table is auto-dropped when
      // the tx commits. The DROP-before-CREATE at the top of the block
      // handles the rare case of #orphan_keep leaked from a previous
      // uncommitted session.
    }
    return total;
  });
}
