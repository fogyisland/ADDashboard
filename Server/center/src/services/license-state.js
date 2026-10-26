// center/src/services/license-state.js
// R158.License-expiry (2026-10-15) — 派生 license display status.
//
// 5 分支 (跟 R158.LA-V1-delete base32Status 0 改对立, 这是 server-side 真源):
//   - none           : rows.length === 0 (从未激活过)
//   - active (永久)  : expires_at === null
//   - active         : days_remaining >= 30
//   - expiring_soon  : 0 <= days_remaining < 30
//   - expired        : days_remaining < 0
//   - unknown        : DB 异常 / fail-closed (D-8)
//
// 跟 R158.LA-V1-delete base32Status localStorage cache 1:1 平行但 0 耦合:
//   - base32Status 走前端 localStorage, 登录后显示
//   - licenseState 走后端 DB, 公开端点 /login 前能查, admin 重定向依据
//
// fail-closed (R158.103 教训): 任何 throw / DB 异常 → status='unknown',
// should_redirect=false. 避免公开端点被 DoS 攻击锁死 admin.
//
// 0 触碰 license-codec / license-validator / license-notify (R158.LA-V1-delete 锁定).
// 0 触碰 ad_system_registration 老 row (license_kind IS NULL ADSPK 老 row in-place).
//
// R158.X.99-trial (2026-10-21) — 追加 `trial` envelope (不增 status 分支!).
//   6 个 return site 全挂 trial. trial.active 由 has_license + days_remaining 派生, 跟
//   DB status 字段 orthogonal —— 0 触发 router.js:584 的 ls.status === 'expired' 重定向.
//   真源 = appsettings.json.installedAt (boot lazy idempotent 写到 frozen, patchConfigAtomic
//   tmp+rename 会重置 mtime → 0 能直接信 mtime). R158.License-config.install precedent
//   1:1 平行 (readInstalledAt 已经在 license-validator.js).
//   trial state 优先级 (最优先 → 最次):
//     1. permanent license (expires_at===null) → trial.active=false, banner 永久隐藏
//     2. timed license (has_license=true)        → trial.active=false, banner 隐藏
//     3. trial days in [0,30)                   → blue banner "还剩 N 天"
//     4. trial days < 0                         → orange banner "已过期 N 天"
//     5. trial state 解析失败                    → trial.active=false, banner 隐藏, log.warn
//                                                  (fail-closed 跟 status='unknown' 一致,
//                                                   不恶化 DB fail-closed) .

const DAYS_UNTIL_WARNING = 30;
const TRIAL_DAYS = 30;

import { readInstalledAt, readSignature } from './license-validator.js';
// R158.X.99-quota (2026-10-21) — 节点配额派生 (1.2 倍宽限 policy 单一真源).
import { applyHeadroom, buildQuota, NODE_HEADROOM_RATIO } from './license-quota.js';
// R158.Trial-anchor (2026-10-22) — 安装锚点 (DB 侧防篡改副本, 挡住"只重装程序保留 DB").
import { computeAnchoredStartedAt, ensureAnchorRow, primaryMac } from './install-anchor.js';

// toLocalYmd — 本地时区 YYYY-MM-DD (跟 system-settings-v2.js:65 1:1 平行).
function toLocalYmd(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

// addDaysYmd — 纯本地 YYYY-MM-DD + N 天 (不通过 Date 构造 UTC, 0 受时区漂移).
//   用本地 midnight Date + setDate 加法, 0 受 DST 边缘影响.
function addDaysYmd(ymd, n) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(y, mo - 1, d);
  dt.setDate(dt.getDate() + n);
  return toLocalYmd(dt);
}

// daysBetweenYmd — 同上, 纯本地日差 (calendar-day, 不 24h × N).
function daysBetweenYmd(fromYmd, toYmd) {
  const a = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fromYmd);
  const b = /^(\d{4})-(\d{2})-(\d{2})$/.exec(toYmd);
  if (!a || !b) return null;
  const da = new Date(Number(a[1]), Number(a[2]) - 1, Number(a[3]));
  const db = new Date(Number(b[1]), Number(b[2]) - 1, Number(b[3]));
  const ms = db.getTime() - da.getTime();
  return Math.round(ms / 86_400_000);
}

// computeTrial — 单一真源. 任何 throw 内部 try/catch 兜底, 返 unknown envelope.
//   0 改 readInstalledAt (precedent 已有). 0 写 disk (trial 没必要 pin — installedAt 已是
//   boot lazy idempotent freeze, 复用即可, lesson 140 锁 "mtime 永不能做 clock 真源").
//   hasLicense=true / isPermanent=true 时早退返 null-banner envelope, 0 读盘 (性能).
function computeTrial({ configPath, hasLicense, isPermanent }, logger) {
  // 永久 license / timed license 都永久隐藏 trial banner.
  if (hasLicense) {
    return {
      active: false,
      days_total: TRIAL_DAYS,
      days_remaining: null,
      started_at: null,
      expires_at: null,
      date_source: isPermanent ? 'permanent_license' : 'covered_by_license',
      pinned: true
    };
  }
  if (!configPath) {
    return {
      active: false,
      days_total: TRIAL_DAYS,
      days_remaining: null,
      started_at: null,
      expires_at: null,
      date_source: 'no_config_path',
      pinned: false
    };
  }
  try {
    const startedAt = readInstalledAt(configPath);
    if (!startedAt) {
      return {
        active: false,
        days_total: TRIAL_DAYS,
        days_remaining: null,
        started_at: null,
        expires_at: null,
        date_source: 'no_installedAt',
        pinned: false
      };
    }
    const expiresAt = addDaysYmd(startedAt, TRIAL_DAYS);
    if (!expiresAt) {
      return {
        active: false,
        days_total: TRIAL_DAYS,
        days_remaining: null,
        started_at: startedAt,
        expires_at: null,
        date_source: 'date_parse_failed',
        pinned: false
      };
    }
    const today = toLocalYmd();
    const daysRemaining = daysBetweenYmd(today, expiresAt);
    if (daysRemaining === null) {
      return {
        active: false,
        days_total: TRIAL_DAYS,
        days_remaining: null,
        started_at: startedAt,
        expires_at: expiresAt,
        date_source: 'date_parse_failed',
        pinned: true
      };
    }
    // clamp 防御: mtime 不可信防 lesson 140 (plan 风险表 "mtime 时钟被 reset"), 但 readInstalledAt
    // 是既有的 idempotent 字段 0 会被 patchConfigAtomic 重置 → 实际不会爆; 此处 clamp 仅作
    // 兜底, 0 是真实发生路径.
    let clamped = daysRemaining;
    let dateSource = 'appsettings_installedAt';
    if (clamped > TRIAL_DAYS) {
      clamped = TRIAL_DAYS;
      dateSource = 'clamped_to_30';
    } else if (clamped < -90) {
      // 极端 garbage date, 降级到 0 不让 banner 一直 "过期 9999 天"
      clamped = -1;
      dateSource = 'clamped_to_neg1';
    }
    return {
      active: clamped >= 0,
      days_total: TRIAL_DAYS,
      days_remaining: clamped,
      started_at: startedAt,
      expires_at: expiresAt,
      date_source: dateSource,
      pinned: true
    };
  } catch (e) {
    logger?.warn?.({ err: e?.message }, 'computeTrial failed — fail-closed to null banner');
    return {
      active: false,
      days_total: TRIAL_DAYS,
      days_remaining: null,
      started_at: null,
      expires_at: null,
      date_source: 'unknown',
      pinned: false
    };
  }
}

// R158.Trial-anchor (2026-10-22) — trial envelope 的锚点叠加层.
//
//   为什么独立于 computeTrial: computeTrial 是**同步纯函数** (无 I/O, 可直接
//   单测), 锚点要读 DB 是异步的。若把 await 塞进 computeTrial, 它的 4 个调用点
//   全要加 await —— 而其中 3 个是 hasLicense=true 的早退路径, 根本用不到锚点。
//   拆开后: computeTrial 0 改动, 叠加层只包 hasLicense=false 的 2 处。
//
//   叠加规则 = 取 min(文件日期, DB 锚点日期):
//     - 只有文件日期 → 原行为 (首次安装 / 纯空库)
//     - 两者都有 → 取更早者, 所以"改 appsettings 往后推"无效
//     - 锚点验签失败 → date_source 记 tampered 但**不**采用其日期 (fail-closed
//       到文件日期, 而不是信任一个验不过的值)
//
//   返回的 envelope 保留 computeTrial 的全部字段, 只覆写 started_at /
//   expires_at / days_remaining / date_source 4 项 —— 前端 LicenseView.vue
//   读的字段集 0 变 (lesson: wire shape preserve)。
//
//   绝不抛: 锚点是加固层, 任何异常都退回纯文件行为并记 warn。
async function applyInstallAnchor(db, logger, configPath, base) {
  if (!base || base.date_source === 'permanent_license' || base.date_source === 'covered_by_license') {
    return base;
  }
  let localSig = null;
  try {
    localSig = readSignature(configPath);
  } catch {
    localSig = null;
  }
  let anchored;
  try {
    anchored = await computeAnchoredStartedAt(db, localSig, logger);
  } catch (err) {
    logger?.warn?.({ err: err?.message }, 'applyInstallAnchor: unexpected throw — keeping file date');
    return base;
  }

  // 无 DB 锚点 → 顺便幂等建锚 (首次安装 / 纯空库), 让后续重装有下限可用。
  //   只在文件日期可用时建: 无 installedAt 时建出来的 at 是空, 建了也验不过。
  //   tampered 时**不**建也不改 —— 覆盖等于擦除痕迹。
  if (!anchored.at && anchored.date_source === 'db_anchor_missing' && base.started_at) {
    try {
      await ensureAnchorRow(db, localSig, logger, { at: base.started_at, mac: primaryMac() });
    } catch (err) {
      logger?.warn?.({ err: err?.message }, 'applyInstallAnchor: ensureAnchorRow threw — non-fatal');
    }
  }

  if (!anchored.at) {
    // 没有可用锚点 → 保持文件日期, 但把 date_source 换成锚点侧的诊断值,
    // 让操作员在 LicenseView 上能看出"DB 锚点是没建、被删了、还是被改了"。
    //
    // tampered 时额外透出 claimed_at = DB 行里声称的日期 (不验签, 仅展示)。
    //   前端 LoginView 用它显示"安装日期为哪一天, 需激活" (操作员 directive
    //   2026-10-22)。这**不是**参与计时的日期 —— 计时仍用 base.started_at。
    const extra = anchored.claimed_at ? { claimed_at: anchored.claimed_at } : {};
    return { ...base, ...extra, date_source: anchored.date_source };
  }

  // 取 min: 文件日期与 DB 锚点谁更早用谁。
  const fileAt = base.started_at;
  if (!fileAt || anchored.at < fileAt) {
    // DB 更早 → 用 DB 日期重算整个 envelope
    const expiresAt = addDaysYmd(anchored.at, TRIAL_DAYS);
    if (!expiresAt) {
      return { ...base, date_source: `${anchored.date_source}|date_parse_failed` };
    }
    const days = daysBetweenYmd(toLocalYmd(), expiresAt);
    if (days === null) {
      return { ...base, date_source: `${anchored.date_source}|date_parse_failed` };
    }
    let clamped = days;
    let src = anchored.date_source;
    if (clamped > TRIAL_DAYS) {
      clamped = TRIAL_DAYS;
      src = `${anchored.date_source}|clamped_to_30`;
    } else if (clamped < -90) {
      clamped = -1;
      src = `${anchored.date_source}|clamped_to_neg1`;
    }
    return {
      ...base,
      started_at: anchored.at,
      expires_at: expiresAt,
      days_remaining: clamped,
      active: clamped >= 0,
      date_source: src
    };
  }
  // 文件日期更早或相等 → 文件本来就已是更严的下限, DB 锚点不改变结论。
  // date_source 仍标出来源, 便于诊断"DB 里有个更晚的锚点(异常)"。
  return { ...base, date_source: `${base.date_source}|db_anchor_kept` };
}

// computeQuota — R158.X.99-quota 节点配额派生. 永不抛.
//   读 max_nodes (findActiveQuota 独立 helper) + 已接入 agent 数 (agentCount),
//   交给 buildQuota 算宽限后的完整视图. 任何一步失败 → enforced=false (不限额),
//   跟 buildQuota 的 fail-open 语义一致: 统计失败不该把新 agent 全拒掉.
//   双重失败域: ① 读配额 SQL 挂 ② 读 agent 数 SQL 挂 —— 分别独立 catch.
async function computeQuota(db, logger, { hasLicense }) {
  const base = {
    max_nodes: null,
    headroom_ratio: NODE_HEADROOM_RATIO,
    allowed_nodes: null,
    used_nodes: null,
    remaining_nodes: null,
    over_quota: null,
    enforced: false
  };
  // 无 active license → 没有配额契约可言 (trial 期不限额).
  if (!hasLicense) return base;

  let maxNodes = null;
  let maxNodesAllowed = null;
  try {
    const q = await db.query(db.sql.systemRegistration.findActiveQuota, []);
    const row = q?.rows?.[0];
    if (row) {
      maxNodes = row.max_nodes;
      // max_nodes_allowed 是激活时写死的契约; 若它缺失(老行/降级 INSERT) 则实时补算,
      // 保证两者至少有一个来源可用.
      maxNodesAllowed = row.max_nodes_allowed;
      if (maxNodesAllowed == null && Number(maxNodes) > 0) {
        maxNodesAllowed = applyHeadroom(maxNodes);
      }
    }
  } catch (e) {
    // 配额列不存在 / 表不存在 / 无权限 —— 全部降级为不限额, 0 阻断 license 状态查询.
    logger?.warn?.({ err: e?.message }, 'computeQuota: quota column query failed — quota disabled (unlimited)');
    return base;
  }

  let usedNodes = null;
  try {
    // 用量统计复用 dashboard overview 的同款 helper (跟 routes/dashboard.js:91 1:1 平行) —
    //   它已排除退役/暂停管控的 DC 和 member server, 正是"已授权节点数"该有的口径.
    //   注意是 dashboard 域而非 replication 域 (后者没有 agentCount, 传 undefined 会让
    //   driver 抛 "Cannot read properties of undefined (reading 'replace')").
    const c = await db.query(db.sql.dashboard.agentCount, []);
    const n = Number(c?.rows?.[0]?.agent_count);
    if (Number.isFinite(n)) usedNodes = n;
  } catch (e) {
    logger?.warn?.({ err: e?.message }, 'computeQuota: agentCount query failed — usage unknown, not enforcing');
  }

  // 优先用库里的 max_nodes_allowed (当次授权的固定契约), 否则用申请值实时算.
  const effectiveMax = maxNodesAllowed != null && maxNodesAllowed > 0
    ? Math.round(Number(maxNodesAllowed) / NODE_HEADROOM_RATIO)
    : maxNodes;
  return buildQuota(effectiveMax, usedNodes);
}

export async function getLicenseState(db, logger, configPath) {
  try {
    const sqlHelper = db.sql.systemRegistration.findLatestActive;
    const { rows } = await db.query(sqlHelper, []);

    if (!rows || rows.length === 0) {
      return {
        has_license: false,
        status: 'none',
        should_redirect: false,
        days_remaining: null,
        days_until_warning: DAYS_UNTIL_WARNING,
        trial: await applyInstallAnchor(db, logger, configPath,
          computeTrial({ configPath, hasLicense: false, isPermanent: false }, logger)),
        quota: await computeQuota(db, logger, { hasLicense: false })
      };
    }

    const r = rows[0];
    // R158.X.99-quota — 配额从**独立 helper** 读 (刻意不并进 findLatestActive,
    //   理由见 db/sql/system-registration.js 的 findActiveQuota 注释: 配额列是
    //   启动期 ALTER 加的, 缺列时绝不能拖累 license 核心链路). computeQuota 内部
    //   自带 try/catch, 永不 reject.
    //   **必须 await**: computeQuota 是 async, 漏 await 会让 quota 字段是个 Promise
    //   → JSON 序列化后变成 {} , 前端永远拿不到用量且**不报任何错**(沉默失败).
    const quota = await computeQuota(db, logger, { hasLicense: true });
    // 永久 license (expires_at NULL): status=active, no redirect, no warning.
    if (r.expires_at === null) {
      return {
        has_license: true,
        status: 'active',
        should_redirect: false,
        days_remaining: null,
        days_until_warning: DAYS_UNTIL_WARNING,
        expires_at: null,
        instance_id: r.instance_id,
        license_kind: r.license_kind,
        license_id: r.id,
        trial: computeTrial({ configPath, hasLicense: true, isPermanent: true }, logger),
        quota
      };
    }

    // mssql DATEDIFF(day, SYSUTCDATETIME(), expires_at) 返 (SYSUTCDATETIME → expires_at)
    // 方向: 正数 = 还剩 N 天 (未到期), 0 = 今天到, 负数 = 已过 N 天. mysql 同理
    // (DATEDIFF(UTC_TIMESTAMP(), expires_at), UTC_TIMESTAMP < expires_at → 正数).
    // 派生 days_remaining = expires_at - now 的天数 (整数, 正数=剩, 负数=已过).
    // 不取负 —— critical #1 反向 BUG: ship 时按注释"-1 取负"被颠倒符号.
    const daysRemaining = Number(r._days_overdue_signed);

    if (daysRemaining < 0) {
      return {
        has_license: true,
        status: 'expired',
        should_redirect: true,
        days_remaining: daysRemaining,
        days_until_warning: DAYS_UNTIL_WARNING,
        expires_at: r.expires_at,
        instance_id: r.instance_id,
        license_kind: r.license_kind,
        license_id: r.id,
        trial: computeTrial({ configPath, hasLicense: true, isPermanent: false }, logger),
        quota
      };
    }
    if (daysRemaining < DAYS_UNTIL_WARNING) {
      return {
        has_license: true,
        status: 'expiring_soon',
        should_redirect: false,
        days_remaining: daysRemaining,
        days_until_warning: DAYS_UNTIL_WARNING,
        expires_at: r.expires_at,
        instance_id: r.instance_id,
        license_kind: r.license_kind,
        license_id: r.id,
        trial: computeTrial({ configPath, hasLicense: true, isPermanent: false }, logger),
        quota
      };
    }
    return {
      has_license: true,
      status: 'active',
      should_redirect: false,
      days_remaining: daysRemaining,
      days_until_warning: DAYS_UNTIL_WARNING,
      expires_at: r.expires_at,
      instance_id: r.instance_id,
      license_kind: r.license_kind,
      license_id: r.id,
      trial: computeTrial({ configPath, hasLicense: true, isPermanent: false }, logger),
      quota
    };
  } catch (e) {
    logger?.error?.({ err: e?.message, stack: e?.stack }, 'getLicenseState failed — fail-closed to unknown');
    // fail-closed 仍给 trial envelope (lesson 141, fail-closed 0 静默). trial 在 hasLicense 路径
    // fail 时返 null active, 跟 status='unknown' 一致 0 矛盾.
    return {
      has_license: false,
      status: 'unknown',
      should_redirect: false,
      days_remaining: null,
      days_until_warning: DAYS_UNTIL_WARNING,
      trial: await applyInstallAnchor(db, logger, configPath,
        computeTrial({ configPath, hasLicense: false, isPermanent: false }, logger)),
      quota: await computeQuota(db, logger, { hasLicense: false })
    };
  }
}
