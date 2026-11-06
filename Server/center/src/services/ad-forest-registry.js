// R158.37 (2026-10-03) - AD Forest Registry service.
//
// Backend "Forest Registry" CRUD over 4 physical tables:
//   ad_forest / ad_forest_domain / ad_forest_dc_assignment / ad_forest_setting
//
// bind_password goes through ad-credential-vault.js AES-256-GCM (extracted
// from R158.35 ad-directory-sync.js). Reads always mask to '********'.
// Writes take plaintext, service encrypts before INSERT/UPDATE.
// setDefaultForest uses tx with clear-then-set to keep is_default unique.
//
// R158.38.2 (2026-10-03) — 中心端 LDAP sync 改读 is_default=1 森林, 不再依赖
// binding 单行表. deleteForest / deleteDomain 移除 binding check (FK RESTRICT
// 仍挡级联, 但 UI 允许用户先解绑默认再删).
//
// SQL access uses dict.<method>[db.dialect] pattern - do NOT spread dict
// (R158.32 lesson: spread of helper dict turns function refs into {}).
//
// R158.37.2 i18n: error messages are Chinese (operator "功能用中文,
// 注释用英文"). R158.37.2 root cause: prior Edit pass corrupted mixed
// encoding on disk; this Write is a clean UTF-8 rewrite.

import { getDb } from '../db/index.js';
import { encryptBindPassword, decryptBindPassword, deriveSecretKey } from './ad-credential-vault.js';

const PASSWORD_MASK = '********';
const VALID_ROLES = new Set(['root', 'child', 'external_trust']);
const VALID_TRUST = new Set(['bidirectional', 'inbound', 'outbound']);

function boolToInt(v) {
  if (v == null) return 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return v ? 1 : 0;
  if (typeof v === 'string') return /^(true|yes|1)$/i.test(v) ? 1 : 0;
  return 0;
}

function rowToForestWire(row) {
  if (!row) return null;
  return {
    id: row.id,
    forestName: row.forest_name,
    rootDn: row.root_dn,
    adUrl: row.ad_url,
    bindDn: row.bind_dn,
    bindPassword: PASSWORD_MASK,
    description: row.description || '',
    isDefault: boolToInt(row.is_default) === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function rowToDomainWire(row) {
  if (!row) return null;
  return {
    id: row.id,
    forestId: row.forest_id,
    domainDn: row.domain_dn,
    domainName: row.domain_name,
    role: row.role,
    trustDirection: row.trust_direction || null,
    dcHostname: row.dc_hostname || null,
    isPdc: boolToInt(row.is_pdc) === 1,
    // R158.39 (2026-10-03) — 每域自动同步开关. 老 row 无此列时, 默认 true
    // (UI 显示开 + tick 同步).
    syncEnabled: row.sync_enabled == null ? true : boolToInt(row.sync_enabled) === 1,
    createdAt: row.created_at
  };
}

function rowToAssignmentWire(row) {
  if (!row) return null;
  return {
    id: row.id,
    forestId: row.forest_id,
    domainId: row.domain_id,
    dcHostname: row.dc_hostname,
    siteId: row.site_id || null,
    assignedAt: row.assigned_at
  };
}

function rowToSettingWire(row) {
  if (!row) return null;
  return {
    id: row.id,
    forestId: row.forest_id,
    settingKey: row.setting_key,
    settingValue: row.setting_value,
    updatedAt: row.updated_at
  };
}

function rowToDomainSettingWire(row) {
  if (!row) return null;
  return {
    id: row.id,
    domainId: row.domain_id,
    settingKey: row.setting_key,
    settingValue: row.setting_value,
    updatedAt: row.updated_at
  };
}

// ---- forest CRUD ----

export async function listForests({ db, logger } = {}) {
  const dbi = db || getDb();
  const dict = dbi.sql.forestRegistry;
  const { rows } = await dbi.execute(dict.listForests[dbi.dialect]);
  return (rows || []).map(rowToForestWire);
}

export async function getForest(id, { db, logger } = {}) {
  const dbi = db || getDb();
  const dict = dbi.sql.forestRegistry;
  const { rows } = await dbi.execute(dict.getForest[dbi.dialect], [id]);
  return rowToForestWire((rows || [])[0]);
}

// R158.5.4 fix (2026-10-04) — getForest 走 rowToForestWire 把 bind_password 强制
// mask 成 PASSWORD_MASK, 但 sync tick / manual trigger 需要真密码喂
// resolveBindPasswordFromForest. UI/前端一律继续走 getForest (安全); 仅 service
// tick + manual trigger 调本函数, db row 直接返 (snake_case + bind_password
// Buffer/VarBinary).
export async function getForestRawRow(id, { db } = {}) {
  const dbi = db || getDb();
  const dict = dbi.sql.forestRegistry;
  const { rows } = await dbi.execute(dict.getForest[dbi.dialect], [id]);
  return (rows || [])[0] || null;
}

export async function createForest(input, { db, logger, jwtSecret } = {}) {
  const dbi = db || getDb();
  const errors = validateForestInput(input);
  if (errors.length) throw Object.assign(new Error(errors.join('; ')), { http: 400 });

  const sk = deriveSecretKey(process.env, jwtSecret || '');
  if (!sk) throw Object.assign(new Error('凭据保险库密钥未配置 (AD_BIND_PASSWORD_KEY 或 jwtSecret)'), { http: 500 });
  // bind_password 列在双方言都是 VARBINARY(1024) (R161.6: MSSQL 侧已从
  // VARCHAR 改成 VARBINARY, 存量库由基线里的守卫 ALTER 改型)。
  // 我们必须把 AES-GCM 的 base64 密文**解回 Buffer** 再写:
  //   - MSSQL: 驱动 (R161.6 起) 对 Buffer 显式绑 sql.VarBinary。绑成
  //     nvarchar 的话, tedious 会抛 'Invalid string.' (Buffer 不是字符串),
  //     而写进 VARCHAR 列则会被 SQL Server 拒 (4133: Implicit conversion
  //     from data type varbinary to varchar is not allowed)。
  //   - MySQL: mysql2 把 Buffer 当 BLOB/VARBINARY。
  // ⇒ 一律传 Buffer, 绝不让密文以字符串形态进库。
  const encrypted = Buffer.from(encryptBindPassword(input.bindPassword, sk), 'base64');

  const dict = dbi.sql.forestRegistry;
  const isDefault = input.isDefault ? 1 : 0;

  // tx: clear defaults first if setting new default, then INSERT. Using
  // dbi.transaction() (driver-portable) instead of dbi.pool which is not
  // exposed by the MSSQL/MySQL wrappers (only dialect.execute/query).
  let newId;
  try {
    await dbi.transaction(async (tx) => {
      if (isDefault) await tx.execute(dict.clearDefault[dbi.dialect]);
      const r = await tx.execute(dict.insertForest[dbi.dialect], [
        input.forestName.trim(),
        input.rootDn.trim(),
        input.adUrl.trim(),
        input.bindDn.trim(),
        encrypted,
        input.description || null,
        isDefault
      ]);
      newId = r.insertId;
      // R158.38.4 (2026-10-03) — operator "其实注册的森林也是域, 建好的森林
      // 也会出现在域中": 建 forest 时自动 INSERT 一个 role='root' 根域行,
      // domain_dn = forest.rootDn, domain_name = forest.forestName. 这样 Tab 2
      // 域列表永远能看到根域, 不需要前端虚拟行. 同一事务, rootDn 变更走
      // updateForest 那里也跟改根域的 domain_dn (id 由 getDomainByRootDn 拿).
      await tx.execute(dict.insertDomain[dbi.dialect], [
        newId,
        input.rootDn.trim(),
        input.forestName.trim(),
        'root',
        null,
        null,
        0
      ]);
      // R158.44.7-2 (2026-10-04) — operator 决策: 建森林时, 根域 (role='root')
      // 自动从森林继承 LDAP 配置 (base_dn / ldap_url / bind_dn) + sync_mode=inherit。
      // 子域 (role='child') 不继承 — 子域通常有独立 LDAP 服务。
      // 端口补全: forest.ad_url 若缺端口, 加 :389 (ldap) 或 :636 (ldaps)
      // (与 r158-44-7-inherit-from-forest.mjs ensurePort() 同逻辑).
      const rootDomainId = (await tx.query(
        dbi.dialect === 'mssql'
          ? `SELECT TOP 1 id FROM ad_forest_domain WHERE forest_id = ? AND role = 'root'`
          : `SELECT id FROM ad_forest_domain WHERE forest_id = ? AND role = 'root' LIMIT 1`,
        [newId]
      )).rows?.[0]?.id;
      if (rootDomainId) {
        const adUrlRaw = input.adUrl.trim();
        const adUrlWithPort = /:\d+\/?$/.test(adUrlRaw)
          ? adUrlRaw
          : `${adUrlRaw.replace(/\/+$/, '')}:${/^ldaps:\/\//i.test(adUrlRaw) ? 636 : 389}`;
        const inheritKvs = [
          ['base_dn', input.rootDn.trim()],
          ['ldap_url', adUrlWithPort],
          ['bind_dn', input.bindDn.trim()],
          ['sync_mode', 'inherit']
        ];
        for (const [k, v] of inheritKvs) {
          await tx.execute(dict.upsertDomainSetting[dbi.dialect], [
            rootDomainId, k, v
          ]);
        }
      }
    });
  } catch (e) {
    if (/duplicate|unique/i.test(String(e.message || ''))) {
      throw Object.assign(new Error('森林名称已存在'), { http: 409 });
    }
    throw e;
  }
  return await getForest(newId, { db: dbi });
}

export async function updateForest(id, input, { db, logger, jwtSecret } = {}) {
  const dbi = db || getDb();
  const existing = await getForest(id, { db: dbi });
  if (!existing) throw Object.assign(new Error('森林不存在'), { http: 404 });
  const errors = validateForestInput({ ...existing, ...input }, /*partial*/ true);
  if (errors.length) throw Object.assign(new Error(errors.join('; ')), { http: 400 });

  const dict = dbi.sql.forestRegistry;
  const isDefault = input.isDefault === undefined ? (existing.isDefault ? 1 : 0) : (input.isDefault ? 1 : 0);

  // Two SQL paths because MSSQL refuses to SET a VARBINARY column from a
  // CASE expression with a placeholder THEN branch. Service picks at call
  // time based on whether the operator passed a new bind_password.
  const keepBindPassword = (input.bindPassword === undefined || input.bindPassword === PASSWORD_MASK);
  const newBindPasswordBuffer = keepBindPassword
    ? null
    : Buffer.from(encryptBindPassword(input.bindPassword, deriveSecretKey(process.env, jwtSecret || '')), 'base64');

  await dbi.transaction(async (tx) => {
    if (isDefault) await tx.execute(dict.clearDefault[dbi.dialect]);
    if (keepBindPassword) {
      await tx.execute(dict.updateForestKeepPassword[dbi.dialect], [
        input.forestName ?? existing.forestName,
        input.rootDn ?? existing.rootDn,
        input.adUrl ?? existing.adUrl,
        input.bindDn ?? existing.bindDn,
        input.description ?? existing.description,
        isDefault,
        id
      ]);
    } else {
      await tx.execute(dict.updateForestSetPassword[dbi.dialect], [
        input.forestName ?? existing.forestName,
        input.rootDn ?? existing.rootDn,
        input.adUrl ?? existing.adUrl,
        input.bindDn ?? existing.bindDn,
        newBindPasswordBuffer,
        input.description ?? existing.description,
        isDefault,
        id
      ]);
    }
    // R158.38.4 (2026-10-03) — 森林名下若有 id 时同步根域行. 老 forest
    // 是 R158.37 早期建的话没有根域行, 自动补一条 (ON DUPLICATE KEY 是
    // uq_forest_domain 唯一约束 forest_id+domain_dn). 显式 UPDATE 比
    // ON DUPLICATE 简单. 若 user 改了 forestName / rootDn, UPDATE 跟上.
    const newForestName = input.forestName ?? existing.forestName;
    const newRootDn = input.rootDn ?? existing.rootDn;
    const { rows: rdRows } = await tx.execute(dict.findRootDomainId[dbi.dialect], [id]);
    let rootDomainId;
    if (rdRows && rdRows[0]?.id) {
      await tx.execute(dict.updateRootDomainDn[dbi.dialect], [
        newRootDn, newForestName, rdRows[0].id
      ]);
      rootDomainId = rdRows[0].id;
    } else {
      await tx.execute(dict.insertDomain[dbi.dialect], [
        id, newRootDn, newForestName, 'root', null, null, 0
      ]);
      // INSERT 后取新 root domain id (用 dialect-aware LIMIT)
      const { rows: newIdRows } = await tx.query(
        dbi.dialect === 'mssql'
          ? `SELECT TOP 1 id FROM ad_forest_domain WHERE forest_id = ? AND role = 'root'`
          : `SELECT id FROM ad_forest_domain WHERE forest_id = ? AND role = 'root' LIMIT 1`,
        [id]
      );
      rootDomainId = newIdRows?.[0]?.id;
    }
    // R158.44.7-2 (2026-10-04) — operator 决策: 改森林 LDAP / 根域时, 同步根域 KV。
    // 仅当 adUrl / bindDn / rootDn 真改变时覆盖 (避免无谓写 + 保护 operator
    // 手动设的独立 ldap_url 等)。bind_password 不进 KV (inherit 模式走森林密码)。
    const ldapChanged =
      (input.adUrl !== undefined && input.adUrl !== existing.adUrl) ||
      (input.bindDn !== undefined && input.bindDn !== existing.bindDn) ||
      (input.rootDn !== undefined && input.rootDn !== existing.rootDn);
    if (ldapChanged && rootDomainId) {
      const adUrlRaw = (input.adUrl ?? existing.adUrl).trim();
      const adUrlWithPort = /:\d+\/?$/.test(adUrlRaw)
        ? adUrlRaw
        : `${adUrlRaw.replace(/\/+$/, '')}:${/^ldaps:\/\//i.test(adUrlRaw) ? 636 : 389}`;
      const inheritKvs = [
        ['base_dn', (input.rootDn ?? existing.rootDn).trim()],
        ['ldap_url', adUrlWithPort],
        ['bind_dn', (input.bindDn ?? existing.bindDn).trim()]
        // sync_mode 不动 — operator 可能已改成 override / independent
      ];
      for (const [k, v] of inheritKvs) {
        await tx.execute(dict.upsertDomainSetting[dbi.dialect], [
          rootDomainId, k, v
        ]);
      }
    }
  });
  return await getForest(id, { db: dbi });
}

export async function deleteForest(id, { db, logger } = {}) {
  const dbi = db || getDb();
  const dict = dbi.sql.forestRegistry;
  // R158.38.2 — 移除 binding check (中心端不维护 binding). 若 forest 是
  // is_default=1, 提示 operator 先另设一个默认再删, 避免 LDAP sync tick
  // 找不到森林时走到 fallback (不致命但行为变).
  const { rows: forestRows } = await dbi.execute(dict.getForest[dbi.dialect], [id]);
  const forest = forestRows?.[0];
  if (forest && Number(forest.is_default) === 1) {
    // is_default 单森林唯一, 删除会破坏唯一约束 (FK 级联无碍);
    // 让 operator 显式 setDefault 另一个森林, 再删本表.
    throw Object.assign(new Error('该森林为默认森林, 请先把其他森林设为默认再删除'), { http: 400 });
  }
  const r = await dbi.execute(dict.deleteForest[dbi.dialect], [id]);
  return (r.affectedRows || 0) > 0;
}

export async function setDefaultForest(id, { db, logger } = {}) {
  const dbi = db || getDb();
  const dict = dbi.sql.forestRegistry;
  let ok = false;
  await dbi.transaction(async (tx) => {
    await tx.execute(dict.clearDefault[dbi.dialect]);
    const r = await tx.execute(dict.setDefault[dbi.dialect], [id]);
    ok = (r.affectedRows || 0) > 0;
  });
  return ok;
}

// ---- domain CRUD ----

export async function listDomains(forestId, { db } = {}) {
  const dbi = db || getDb();
  const dict = dbi.sql.forestRegistry;
  const { rows } = await dbi.execute(dict.listDomains[dbi.dialect], [forestId]);
  return (rows || []).map(rowToDomainWire);
}

// R158.43 (2026-10-03) — 路由 /domain-binding 需要按 id 单查域 (无须 forestId).
// 走 dict.getDomain SQL helper (assignDc 内部已用, 公开化).
export async function getDomain(domainId, { db } = {}) {
  const dbi = db || getDb();
  const dict = dbi.sql.forestRegistry;
  const { rows } = await dbi.execute(dict.getDomain[dbi.dialect], [domainId]);
  return rowToDomainWire((rows || [])[0]);
}

// R158.39 (2026-10-03) — tick 用, 仅返 sync_enabled=1 的域. UI 仍走
// listDomains 看全量 (含 disabled) 让操作员独立切换.
export async function listEnabledDomains(forestId, { db } = {}) {
  const dbi = db || getDb();
  const dict = dbi.sql.forestRegistry;
  const { rows } = await dbi.execute(dict.listEnabledDomains[dbi.dialect], [forestId]);
  return (rows || []).map(rowToDomainWire);
}

// R158.39 (2026-10-03) — 切换某域自动同步开关. UI (ForestRegistry Tab 2
// 自动同步 checkbox) + cron tick 协同. false 时 tick 跳过, 但手动触发
// DirectorySyncView 多选仍可选 (覆盖).
export async function setDomainSyncEnabled(domainId, enabled, { db } = {}) {
  const dbi = db || getDb();
  const dict = dbi.sql.forestRegistry;
  const r = await dbi.execute(dict.setDomainSyncEnabled[dbi.dialect], [
    enabled ? 1 : 0,
    Number(domainId)
  ]);
  return (r.affectedRows || 0) > 0;
}

// R158.5.4 (2026-10-04) — 域级 bind_password 覆盖. DirectorySyncView 矩阵
// 行内 [设置密码] 按钮. 优先级: domain 覆盖 > forest.bind_password. 空字符串
// = 删除 KV 恢复读 forest. 加密路径与 forest.bind_password 完全相同
// (ad-credential-vault.js AES-256-GCM, R158.37 抽出来的).
export const DOMAIN_BIND_PASSWORD_KEY = 'bind_password';

export async function setDomainBindPassword(domainId, plaintext, { db, jwtSecret, logger } = {}) {
  const dbi = db || getDb();
  if (plaintext == null || plaintext === '') {
    return deleteDomainSetting(domainId, DOMAIN_BIND_PASSWORD_KEY, { db: dbi });
  }
  const sk = deriveSecretKey(process.env, jwtSecret || '');
  if (!sk) {
    throw Object.assign(new Error('凭据保险库密钥未配置 (AD_BIND_PASSWORD_KEY 或 jwtSecret)'), { http: 500 });
  }
  const encrypted = encryptBindPassword(String(plaintext), sk);
  return setDomainSetting(domainId, DOMAIN_BIND_PASSWORD_KEY, encrypted, { db: dbi, logger });
}

// R158.5.4 — 读域级 bind_password (解密). 返回 '' 表示"未设置或解密失败",
// caller 必须 fallback 到 forest.bind_password. 解密失败 warn 一次但不 throw
// (LDAP sync tick 不应该因为某一域密码错就全森林跳过).
export async function getDomainBindPassword(domainId, { db, jwtSecret, logger } = {}) {
  const dbi = db || getDb();
  let settings;
  try {
    settings = await listDomainSettings(domainId, { db: dbi });
  } catch (e) {
    logger?.warn?.({ component: 'ad-forest-registry', domainId, err: e?.message },
      'listDomainSettings failed in getDomainBindPassword');
    return '';
  }
  const setting = (settings || []).find(s => s.settingKey === DOMAIN_BIND_PASSWORD_KEY);
  if (!setting || !setting.settingValue) return '';
  const sk = deriveSecretKey(process.env, jwtSecret || '');
  if (!sk) return '';
  try {
    return decryptBindPassword(String(setting.settingValue), sk);
  } catch (e) {
    logger?.warn?.({ component: 'ad-forest-registry', domainId, err: e?.message },
      'getDomainBindPassword decrypt failed');
    return '';
  }
}

// R158.5.4 — 是否存在覆盖 (UI 显示「已设独立密码 / 继承森林」状态). 仅看
// KV 行是否存在 + 非空, 不解密 (性能 + 安全: 不在 GET 路径触发 AES).
export async function hasDomainBindPassword(domainId, { db } = {}) {
  const dbi = db || getDb();
  let settings;
  try {
    settings = await listDomainSettings(domainId, { db: dbi });
  } catch {
    return false;
  }
  const setting = (settings || []).find(s => s.settingKey === DOMAIN_BIND_PASSWORD_KEY);
  return Boolean(setting && setting.settingValue);
}

// R158.5.4 (2026-10-04) — 合并读 base_dn / sync_mode / bind_password 三个 KV
// 给 sync tick 用, 减少 N+1. baseDn 覆盖顺序: domainKV.base_dn > domain.domainDn.
// syncMode 默认 'inherit' (兼容老数据). bindPassword 仅当 syncMode='independent'
// 或显式设置时取 domainKV, 否则继承 forest.bind_password (本函数不解密, 返
// 布尔 / 标志 + 引用 ID; 真解密走 resolveBindPasswordFromForest).
//
// 返回 wire: { baseDn, syncMode, hasDomainPassword, ldapUrl, hasDomainLdapUrl, bindDn, hasDomainBindDn }.
// R158.44.2 (2026-10-04) — 加 ldapUrl override: operator 反馈 "在域卡片绑了 DC, 但同步
// 依然遵循森林根域 ad_url, 绑的机器没生效". 改为 priority: domain setting `ldap_url`
// → forest.adUrl. caller 必须先 try domain.ldapUrl, 失败再 fallback forest.adUrl.
// R158.44.3 (2026-10-04) — 加 bindDn override: operator 反馈 "域注册的界面中没有
// 设置同步的账户, 只有密码". priority: domain setting `bind_dn` → forest.bindDn.
// 注意: bindDn 与 bindPassword 必须配对 — caller 同时取两个字段, 不要单边切换.
export async function getEffectiveDomainConfig(domain, { db, logger } = {}) {
  const dbi = db || getDb();
  let settings = [];
  try {
    settings = await listDomainSettings(domain.id, { db: dbi });
  } catch (e) {
    logger?.warn?.({ component: 'ad-forest-registry', domainId: domain.id, err: e?.message },
      'getEffectiveDomainConfig: listDomainSettings failed');
  }
  const byKey = new Map((settings || []).map(s => [s.settingKey, s.settingValue]));
  const baseDn = String(byKey.get('base_dn') || '').trim() || (domain.domainDn || '');
  const syncModeRaw = String(byKey.get('sync_mode') || 'inherit').trim().toLowerCase();
  const syncMode = ['inherit', 'override', 'independent'].includes(syncModeRaw) ? syncModeRaw : 'inherit';
  const hasDomainPassword = Boolean(byKey.get('bind_password'));
  const ldapUrlSetting = String(byKey.get('ldap_url') || '').trim();
  const bindDnSetting = String(byKey.get('bind_dn') || '').trim();
  return {
    baseDn,
    syncMode,
    hasDomainPassword,
    ldapUrl: ldapUrlSetting || null,
    hasDomainLdapUrl: Boolean(ldapUrlSetting),
    bindDn: bindDnSetting || null,
    hasDomainBindDn: Boolean(bindDnSetting)
  };
}

export async function createDomain(forestId, input, { db } = {}) {
  const dbi = db || getDb();
  const errors = validateDomainInput(input);
  if (errors.length) throw Object.assign(new Error(errors.join('; ')), { http: 400 });

  const dict = dbi.sql.forestRegistry;
  try {
    const r = await dbi.execute(dict.insertDomain[dbi.dialect], [
      forestId,
      input.domainDn.trim(),
      input.domainName.trim(),
      input.role,
      input.trustDirection || null,
      input.dcHostname || null,
      input.isPdc ? 1 : 0
    ]);
    const newId = r.insertId;
    const { rows } = await dbi.execute(dict.getDomain[dbi.dialect], [newId]);
    return rowToDomainWire((rows || [])[0]);
  } catch (e) {
    if (/duplicate|unique/i.test(String(e.message || ''))) {
      throw Object.assign(new Error('该森林下已存在相同 domain_dn'), { http: 409 });
    }
    throw e;
  }
}

export async function deleteDomain(domainId, { db } = {}) {
  const dbi = db || getDb();
  const dict = dbi.sql.forestRegistry;
  // R158.38.2 — 移除 binding check. domain_id FK in ad_forest_dc_assignment
  // is NO ACTION (migration 049 MSSQL cycle fix), pre-clean first.
  await dbi.execute('DELETE FROM ad_forest_dc_assignment WHERE domain_id = ?', [domainId]);
  const r = await dbi.execute(dict.deleteDomain[dbi.dialect], [domainId]);
  return (r.affectedRows || 0) > 0;
}

// ---- DC assignment ----

export async function listDcAssignments(forestId, { db } = {}) {
  const dbi = db || getDb();
  const dict = dbi.sql.forestRegistry;
  const { rows } = await dbi.execute(dict.listDcAssignments[dbi.dialect], [forestId]);
  return (rows || []).map(rowToAssignmentWire);
}

export async function assignDc(domainId, dcHostname, siteId = null, { db } = {}) {
  const dbi = db || getDb();
  if (!dcHostname || typeof dcHostname !== 'string') {
    throw Object.assign(new Error('DC 主机名必填'), { http: 400 });
  }
  const dict = dbi.sql.forestRegistry;
  // resolve forest_id from domain
  const { rows: domainRows } = await dbi.execute(dict.getDomain[dbi.dialect], [domainId]);
  if (!domainRows || !domainRows[0]) throw Object.assign(new Error('域不存在'), { http: 404 });
  const forestId = domainRows[0].forest_id;
  try {
    const r = await dbi.execute(dict.assignDc[dbi.dialect], [
      forestId, domainId, dcHostname.trim(), siteId
    ]);
    const newId = r.insertId;
    const { rows } = await dbi.execute(
      'SELECT id, forest_id, domain_id, dc_hostname, site_id, assigned_at FROM ad_forest_dc_assignment WHERE id = ?',
      [newId]
    );
    return rowToAssignmentWire((rows || [])[0]);
  } catch (e) {
    if (/duplicate|unique/i.test(String(e.message || ''))) {
      throw Object.assign(new Error(`DC "${dcHostname}" 已被分配`), { http: 409 });
    }
    throw e;
  }
}

export async function unassignDc(dcHostname, { db } = {}) {
  const dbi = db || getDb();
  const dict = dbi.sql.forestRegistry;
  const r = await dbi.execute(dict.unassignDc[dbi.dialect], [dcHostname]);
  return (r.affectedRows || 0) > 0;
}

// ---- settings KV ----

export async function listSettings(forestId, { db } = {}) {
  const dbi = db || getDb();
  const dict = dbi.sql.forestRegistry;
  const { rows } = await dbi.execute(dict.listSettings[dbi.dialect], [forestId]);
  return (rows || []).map(rowToSettingWire);
}

export async function setSetting(forestId, key, value, { db } = {}) {
  const dbi = db || getDb();
  const dict = dbi.sql.forestRegistry;
  await dbi.execute(dict.upsertSetting[dbi.dialect], [forestId, key, value == null ? null : String(value)]);
  const { rows } = await dbi.execute(
    'SELECT id, forest_id, setting_key, setting_value, updated_at FROM ad_forest_setting WHERE forest_id = ? AND setting_key = ?',
    [forestId, key]
  );
  return rowToSettingWire((rows || [])[0]);
}

export async function deleteSetting(forestId, key, { db } = {}) {
  const dbi = db || getDb();
  const dict = dbi.sql.forestRegistry;
  const r = await dbi.execute(dict.deleteSetting[dbi.dialect], [forestId, key]);
  return (r.affectedRows || 0) > 0;
}

// ---- domain-level settings (R158.38.3) ----
// operator 「在域里面也和森林里面也要有和森林一样的同步设置」 — 独立表
// ad_forest_domain_setting (R158.38.3 决策 B), 不复用 ad_forest_setting.
// 单 FK → ad_forest_domain, UNIQUE (domain_id, setting_key) 干净.

export async function listDomainSettings(domainId, { db } = {}) {
  const dbi = db || getDb();
  const dict = dbi.sql.forestRegistry;
  const { rows } = await dbi.execute(dict.listDomainSettings[dbi.dialect], [domainId]);
  return (rows || []).map(rowToDomainSettingWire);
}

export async function setDomainSetting(domainId, key, value, { db } = {}) {
  const dbi = db || getDb();
  const dict = dbi.sql.forestRegistry;
  await dbi.execute(dict.upsertDomainSetting[dbi.dialect], [domainId, key, value == null ? null : String(value)]);
  const { rows } = await dbi.execute(
    'SELECT id, domain_id, setting_key, setting_value, updated_at FROM ad_forest_domain_setting WHERE domain_id = ? AND setting_key = ?',
    [domainId, key]
  );
  return rowToDomainSettingWire((rows || [])[0]);
}

export async function deleteDomainSetting(domainId, key, { db } = {}) {
  const dbi = db || getDb();
  const dict = dbi.sql.forestRegistry;
  const r = await dbi.execute(dict.deleteDomainSetting[dbi.dialect], [domainId, key]);
  return (r.affectedRows || 0) > 0;
}

// R158.5 (2026-10-04) — operator 「域也支持自己定义同步凭据」
// 把 bind_password (AES-GCM ciphertext base64) 当作 domain-level KV
// 存进 ad_forest_domain_setting 表. 调用方传 plaintext, service 用
// AD_BIND_PASSWORD_KEY / jwtSecret 加密再写入. 取时解 base64 → decryptBindPassword.
// setting_key 固定 'bind_password' (与森林端 R158.37 一致).
// (实现在 R158.5.4 — 与 forest.bind_password 共用 encryptBindPassword 路径,
//  上方 308-371 已 export, 此处不再重复.)

// R158.38.4 (2026-10-03) — startup backfill: 给所有 ad_forest 补 role='root'
// 根域行. 老 forest 在 R158.37 时代建的没有根域行, 现在统一补上.
// 路径: LEFT JOIN ad_forest_domain 看 forest 是否有 role='root' 行;
// 没有就 INSERT. 用 INSERT ... ON DUPLICATE KEY UPDATE / MERGE 兜底 (按 forest_id
// 唯一约束不存在所以 INSERT 重复会抛; 我们用普通 INSERT + try/catch 一行一行
// 处理). 仅在 server.js 启动时跑一次.
export async function backfillRootDomains({ db, logger } = {}) {
  const dbi = db || getDb();
  const dict = dbi.sql.forestRegistry;
  let inserted = 0;
  let skipped = 0;
  try {
    // 取所有 forest
    const { rows: forests } = await dbi.execute(dict.listForests[dbi.dialect]);
    for (const f of (forests || [])) {
      // 看是否已有 role='root' 行
      const { rows: rdRows } = await dbi.execute(dict.findRootDomainId[dbi.dialect], [f.id]);
      if (rdRows && rdRows[0]?.id) { skipped++; continue; }
      try {
        await dbi.execute(dict.insertDomain[dbi.dialect], [
          f.id, f.root_dn, f.forest_name, 'root', null, null, 0
        ]);
        inserted++;
      } catch (e) {
        // uq_forest_domain (forest_id, domain_dn) 撞了 — 说明根域行其实在,
        // findRootDomainId 没拿到是因为 role 字段写错. 忽略.
        if (!/duplicate|unique/i.test(String(e.message || ''))) {
          logger?.warn?.({ component: 'forest-registry', forestId: f.id, err: e.message },
            'backfill root domain failed');
        } else {
          skipped++;
        }
      }
    }
    logger?.info?.({ component: 'forest-registry', inserted, skipped },
      'R158.38.4 backfill root domains done');
  } catch (e) {
    logger?.error?.({ component: 'forest-registry', err: e.message },
      'backfill root domains failed');
  }
  return { inserted, skipped };
}

// ---- validators ----

function validateForestInput(input, partial = false) {
  const errs = [];
  if (!partial || input.forestName !== undefined) {
    if (!input.forestName || typeof input.forestName !== 'string' || input.forestName.length > 128) {
      errs.push('森林名称必填, 最长 128 字符');
    }
  }
  if (!partial || input.rootDn !== undefined) {
    if (!input.rootDn || typeof input.rootDn !== 'string') errs.push('根 DN 必填');
  }
  if (!partial || input.adUrl !== undefined) {
    if (!input.adUrl || typeof input.adUrl !== 'string') errs.push('AD 地址必填');
  }
  if (!partial || input.bindDn !== undefined) {
    if (!input.bindDn || typeof input.bindDn !== 'string') errs.push('绑定 DN 必填');
  }
  // bindPassword: required on create; on update omit or pass '********' = keep current
  if (!partial && (input.bindPassword === undefined || input.bindPassword === PASSWORD_MASK)) {
    errs.push('绑定密码必填 (明文)');
  }
  if (input.bindPassword !== undefined && input.bindPassword !== PASSWORD_MASK && typeof input.bindPassword !== 'string') {
    errs.push('绑定密码必须为字符串');
  }
  return errs;
}

function validateDomainInput(input) {
  const errs = [];
  if (!input.domainDn || typeof input.domainDn !== 'string') errs.push('域 DN 必填');
  if (!input.domainName || typeof input.domainName !== 'string') errs.push('域名称必填');
  // R158.44.7-2 (2026-10-04) — DN shape check. Rejects rows like 'dc=shaphar,dc-net'
  // (missing '=' between RDN segments) which previously slipped through the
  // non-empty check and produced silent LDAP bind failures. RFC 4514 form:
  // one or more RDNs separated by ',', each RDN = attr=value with no spaces
  // around '='. Auto-derivation is deliberately NOT performed here — strict
  // reject keeps the data layer clean; fix scripts (r158-44-7-fix-domain-dn.mjs)
  // are the only path that touches malformed historical rows.
  if (input.domainDn && typeof input.domainDn === 'string') {
    const dn = input.domainDn.trim();
    if (!/^([A-Za-z][A-Za-z0-9-]*=[^,=]+,)*[A-Za-z][A-Za-z0-9-]*=[^,=]+$/.test(dn)) {
      errs.push('域 DN 格式不合法 (期望形如 dc=example,dc=com; RDN 必须 attr=value,逗号分隔,不可有空格)');
    }
  }
  if (!input.role || !VALID_ROLES.has(input.role)) errs.push(`角色必须为 ${[...VALID_ROLES].join(' / ')} 之一`);
  if (input.trustDirection != null && !VALID_TRUST.has(input.trustDirection)) {
    errs.push(`信任方向必须为 ${[...VALID_TRUST].join(' / ')} 之一`);
  }
  return errs;
}