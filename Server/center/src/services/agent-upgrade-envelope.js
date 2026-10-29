// agent-upgrade-envelope — 「谁该被升级到哪个包」的**纯逻辑** (零依赖)
//
// R161.22 (2026-10-29)
//
// ── 为什么必须单独一个模块 ───────────────────────────────────────────
//   这条链路上有两棵树:
//     AD 血统  = <repoRoot>/agent      (34 台 DC 跑它)
//     non-AD   = <repoRoot>/noadagent  (成员服务器跑它)
//   R158.48 建自动升级时**只有一棵树** (server.js:511
//   `join(repoRoot, 'agent')`), 于是升级信封对所有代理长得一模一样。
//
//   后果 (P0, 本轮修):
//     ① 成员代理心跳走 centre 的 non-ad 分支 (routes/agent.js:395),
//        那条分支照样返回 upgradeAvailable / upgradeVersion ⇒ 成员代理
//        每一次心跳都被告知「有 0.1.9 可升」。
//     ② 成员代理若真去拉 GET /api/agent/upgrade, 中心端吐的是 **AD 包**
//        (agent.js + src/** + build-manifest.json) ⇒ applyUpgradeDelivery
//        把它 sha256 校验后**原子 rename 覆盖到成员服务器自己的目录**
//        ⇒ 成员服务器变成一台 DC 代理。
//
//   R158.75 fork 成员代理时, 这条链没跟着 fork —— 断链点在这里。
//
// ── 为什么这个模块必须**零 import** ───────────────────────────────────
//   回归网 tests/agent-upgrade-lineage.test.js 要在**不连数据库、不起
//   中心进程**的前提下断言:
//     · non-AD 代理永远拿不到 AD 包的升级信封
//     · AD 代理的升级信封逐字不变 (34 台 DC 零影响)
//     · non-AD 代理拿到的是 noad 包的版本号
//   若本模块 import 了 express / mysql2 / mssql, 本机 center/node_modules
//   是空的 ⇒ 测试整个跑不起来。
//
// 纯函数 = 无 IO、无 DB、无 clock、无第三方依赖。

/** 血统标识。跟中心端 `req.body.agentType` 的取值同源 ('ad' / 'non-ad')。 */
export const LINEAGE_AD = 'ad';
export const LINEAGE_NON_AD = 'non-ad';

/**
 * 把请求方声明的 agentType 归一化成血统。
 *
 * 未知 / 缺失一律按 'ad' 处理 —— 这是**故意**的:
 *   · AD 代理是绝大多数 (34 台), 任何解析失败都不该把它们踢出升级通道;
 *   · 成员代理**必须**显式声明 'non-ad', 而它的 payload 里一直带着
 *     `agentType: 'non-ad'` (noadagent/agent.js:680), 所以真实链路上
 *     不会误判。
 *
 * @param {unknown} agentType
 * @returns {'ad'|'non-ad'}
 */
export function normalizeLineage(agentType) {
  return String(agentType || '').trim().toLowerCase() === LINEAGE_NON_AD
    ? LINEAGE_NON_AD
    : LINEAGE_AD;
}

/**
 * 按血统挑升级源。
 *
 * ★ 关键不变量: **non-AD 血统绝不回退到 AD 源**。
 *   中心端只有一棵树时 (LinuxServer 镜像里既没有 agent/ 也没有
 *   noadagent/), non-AD 代理拿到的就是 null ⇒ 信封是
 *   {upgradeAvailable:false, upgradeVersion:null} ⇒ 代理端早退。
 *   「回退到 AD 源」正是本轮要修的那个 P0。
 *
 * @param {{ad?: object|null, nonAd?: object|null}} sources
 * @param {unknown} agentType
 * @returns {object|null} 选中的升级源 (没有就 null)
 */
export function selectUpgradeSource(sources, agentType) {
  const lineage = normalizeLineage(agentType);
  const bag = sources && typeof sources === 'object' ? sources : {};
  if (lineage === LINEAGE_NON_AD) {
    const src = bag.nonAd ?? null;
    return src && src.available ? src : null;
  }
  const src = bag.ad ?? null;
  return src && src.available ? src : null;
}

/**
 * canaryBucket — 稳定哈希 (reported|target) mod 100 < ratio。
 *   无 Date.now / 无 Math.random ⇒ 同一台机器永远落在同一个桶里,
 *   操作员调比例时灰度集合是**确定性**扩张的。
 */
export function canaryBucket(reported, target, ratio) {
  if (ratio >= 100) return true;
  if (ratio <= 0) return false;
  // FNV-1a 32-bit on `${reported}|${target}`
  const s = `${reported}|${target}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return (h % 100) < ratio;
}

/**
 * 升级信封的**纯**计算。给定一份升级源, 返回 {upgradeAvailable,
 * upgradeVersion, rolloutStrategy}。
 *
 * 与 R158.48 的 computeUpgradeEnvelope 逐字同规则 (字符串不等比较 +
 * 三档 rollout 熔断), 只是把「源」从模块级闭包换成了参数 ⇒ 可离线断言。
 *
 * - source 为 null / 不可用 ⇒ {false, null, 'unavailable'}
 * - target === reported ⇒ {false, null, 'full'} (同版本 → 无需灰度闸门)
 * - gate.strategy === 'paused' ⇒ {false, null, 'paused'} (熔断)
 * - gate.strategy === 'canary' 且本机不在桶里 ⇒ {false, null, 'canary'}
 * - 其余 ⇒ {true, target, 'full'}
 *
 * ★ upgradeVersion 在「不可用」时一律是 **null** (不是 '' 也不是 undefined):
 *   代理端 upgrade-delivery.js 的判定是
 *   `typeof data.upgradeVersion === 'string' ? ... : ''` ⇒ null 会归一成
 *   '' ⇒ `upgradeVersion.length === 0` ⇒ 早退。三个形态都安全, 但 null
 *   在 JSON 里最显眼, 排查时一眼能看出「中心端没给版本」。
 *
 * @param {object|null} source 升级源 ({available, version, ...})
 * @param {unknown} agentVersion 代理自报版本
 * @param {object|null} [rolloutGate] {strategy, canaryRatio}
 */
export function computeUpgradeEnvelopeFrom(source, agentVersion, rolloutGate = null) {
  if (!source || !source.available) {
    return { upgradeAvailable: false, upgradeVersion: null, rolloutStrategy: 'unavailable' };
  }
  const target = String(source.version || '');
  const reported = String(agentVersion || '');
  const baseAvailable = target !== reported && target.length > 0;

  const gate = rolloutGate && typeof rolloutGate === 'object' ? rolloutGate : { strategy: 'full', canaryRatio: 100 };
  const gateStrategy = String(gate.strategy || 'full');
  const canaryRatio = Number.isFinite(Number(gate.canaryRatio))
    ? Math.max(0, Math.min(100, Number(gate.canaryRatio)))
    : 100;

  let strategy;
  let upgradeAvailable = baseAvailable;
  let upgradeVersion = baseAvailable ? target : null;
  if (!baseAvailable) {
    strategy = 'full';  // 同版本 → 无需灰度闸门, 直接放行 (无升级)
  } else if (gateStrategy === 'paused') {
    strategy = 'paused';
    upgradeAvailable = false;
    upgradeVersion = null;  // 代理端短路的形状
  } else if (gateStrategy === 'canary') {
    strategy = 'canary';
    const bucket = canaryBucket(reported, target, canaryRatio);
    if (!bucket) {
      upgradeAvailable = false;
      upgradeVersion = null;  // 代理端短路的形状
    }
  } else {
    // 'full' 或任何未知策略 → 保守默认 'full' (放行升级)。
    // 操作员可以用 feature flag 把 strategy 翻成 'paused' 立刻熔断。
    strategy = 'full';
  }

  return { upgradeAvailable, upgradeVersion, rolloutStrategy: strategy };
}
