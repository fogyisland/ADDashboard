// R158.113 (2026-10-17) — AD command dispatch helper for MCP write tools.
// 跟 admin.js POST /api/admin/ad-commands 1:1 平行, 唯一差异: targetDc 可选,
// 0 必传 → resolveTargetDc 走 site_keyword 解析 + Hub fallback 链. 调用方:
//   - mcp-write route 6 write tool handler
// 复用 services/ad-admin-commands.js queueCommand + _testInternals.validators
// + admin.js _checkDcOnline. 0 改老 service / route.
export class HttpErr extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.expose = true;
  }
}

// resolveTargetDc: 3 路径
//   (1) explicit targetDc 必填 (LLM 直接指定, 跟 admin.js:1849-1851 1:1 平行)
//   (2) site_keyword 模糊匹配 ad_sites.site_name
//       0 match → Hub fallback
//       1 match → 用该 site 的 PDC
//       N match → 返 list 给 LLM 重选
//   (3) 全 0 → 400 no_match_no_hub
//
// 1:1 mirror admin.js _checkDcOnline pre-flight 失败语义 (R158.50.6 fail-closed
// 锁, 0 改 service 内部).
export async function resolveTargetDc({ siteKeyword, explicitDc, db }) {
  // (1) explicit DC 优先 (跟 admin.js 1:1 平行)
  if (typeof explicitDc === 'string' && explicitDc.trim()) {
    return { dc: explicitDc.trim(), source: 'explicit' };
  }
  // (2) site_keyword 模糊匹配
  if (typeof siteKeyword === 'string' && siteKeyword.trim()) {
    const kw = siteKeyword.trim();
    const like = `%${kw}%`;
    // params = [like] 单个 —— getSiteByKeyword 的 alias 分支已删 (ad_sites
    // 从来没有 alias 列, 引用它会让 MSSQL 在解析阶段抛 Invalid column name).
    // 传 2 个会因参数个数不匹配直接失败. mysql/mssql 两段同步改.
    const { rows: sites } = await db.query(db.sql.dashboard.getSiteByKeyword, [like]);
    if (sites.length > 1) {
      return {
        ambiguous: true,
        candidates: sites.map(s => ({ siteId: s.site_id, siteName: s.site_name }))
      };
    }
    if (sites.length === 1) {
      const { rows: dcs } = await db.query(db.sql.dashboard.getDcsBySite, [sites[0].site_id]);
      if (dcs.length === 0) {
        throw new HttpErr(400, `site '${sites[0].site_name}' has no DC configured`);
      }
      // 1+ DC, 优先 is_pdc=1
      const pdc = dcs.find(d => d.is_pdc === 1 || d.is_pdc === true);
      return { dc: (pdc || dcs[0]).dc_name, source: 'site_keyword' };
    }
    // 0 match → 落 Hub fallback
  }
  // (3) Hub fallback
  const { rows: hubDcs } = await db.query(db.sql.dashboard.getHubDefaultDc);
  if (hubDcs.length === 0) {
    throw new HttpErr(400, 'no site_keyword match and no hub site configured (ad_sites.is_hub=1)');
  }
  return { dc: hubDcs[0].dc_name, source: 'hub_fallback' };
}

// buildAdParams: 6 write tool → 1:1 复用 services/ad-admin-commands.js
// _testInternals.validators. 0 必新加 command type, 0 改 service.
export async function buildAdParams(commandType, params, adAdminCommands) {
  const validators = adAdminCommands._testInternals?.validators;
  if (!validators || typeof validators[commandType] !== 'function') {
    throw new HttpErr(500, `no validator for command type ${commandType}`);
  }
  const v = validators[commandType](params);
  if (!v || v.ok !== true) {
    throw new HttpErr(400, v?.error || `invalid params for ${commandType}`);
  }
  return v.normalized;
}

// Redact password-shaped fields before writeAudit. 1:1 平行 admin.js 既有
// `redactPasswords` helper (R158.100.A 锁). MCP write audit 永远不落明文密码.
export function redactForAudit(payload) {
  if (payload == null || typeof payload !== 'object') return payload;
  const out = {};
  for (const [k, v] of Object.entries(payload)) {
    if (k === 'password' || k === 'newPassword' || k === 'oldPassword') {
      out[k] = '[redacted]';
    } else {
      out[k] = v;
    }
  }
  return out;
}
