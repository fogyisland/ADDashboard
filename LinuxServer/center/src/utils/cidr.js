// R158.X.99.28 (2026-10-19) — MCP IP whitelist CIDR matcher.
//
// 1:1 平行 R158.69 agent IP allowlist 范式 + R158.102/R158.113 MCP 访问控制.
//
// 解析 `system_config.mcp_ip_whitelist` (JSON 数组字符串) 成 [{ip, cidr, family}]
// 范式, 然后用 `matchIp(clientIp, parsed)` 验 client 是否在白名单.
//
// 支持:
//   - 纯 IPv4:    "192.168.1.5"           → 4 / 32
//   - 纯 IPv6:    "::1" / "fe80::1"       → 6 / 128
//   - IPv4 CIDR:  "10.0.0.0/8"            → 4 / 8
//   - IPv6 CIDR:  "2001:db8::/32"         → 6 / 32
//   - IPv4-mapped IPv6 规范化: "::ffff:127.0.0.1" → "127.0.0.1" (1:1 平行 routes/system.js:28-33)
//
// 跨 family 必 0 匹配 (IPv4 entry 永不匹配 IPv6 client, 反之亦然). 1:1 平行
// net.isIP family. CIDR /0 = 全 family 旁路 (1:1 平行 routes/system.js
// LOCALHOST_IPS Set 范式).
//
// 必 0 必 new dependency — 全部走 Node built-in `node:net` isIP.

import { isIP } from 'node:net';

// IPv4 CIDR 段匹配 — 走 BigInt 防 Number 32-bit 溢出.
function cidrMatchV4(clientIp, entryIp, cidr) {
  const c = toBigIntBE(clientIp, 4);
  const e = toBigIntBE(entryIp, 4);
  if (c === null || e === null) return false;
  if (cidr === 0) return true; // /0 = 全 IPv4 旁路
  if (cidr >= 32) return c === e;
  const mask = ((1n << BigInt(32 - cidr)) - 1n) ^ 0xffffffffn;
  return (c & mask) === (e & mask);
}

// IPv6 CIDR 段匹配 — 128 bit, BigInt 强制.
function cidrMatchV6(clientIp, entryIp, cidr) {
  const c = toBigIntBE(clientIp, 6);
  const e = toBigIntBE(entryIp, 6);
  if (c === null || e === null) return false;
  if (cidr === 0) return true; // /0 = 全 IPv6 旁路
  if (cidr >= 128) return c === e;
  const mask = ((1n << BigInt(128 - cidr)) - 1n) ^ ((1n << 128n) - 1n);
  return (c & mask) === (e & mask);
}

// IP → BigInt (big-endian 字节序). 4 字节 IPv4 / 16 字节 IPv6.
function toBigIntBE(ip, family) {
  if (family === 4) {
    const parts = ip.split('.');
    if (parts.length !== 4) return null;
    let result = 0n;
    for (const p of parts) {
      const n = Number(p);
      if (!Number.isInteger(n) || n < 0 || n > 255) return null;
      result = (result << 8n) | BigInt(n);
    }
    return result;
  } else {
    // IPv6: 支持 "::" 缩写. 走 BigInt 组装.
    // Node `node:net` 0 提供 BigInt 转换, 自写最稳.
    const parts = ip.split(':');
    if (parts.length < 3 || parts.length > 8) return null;
    // 找 "::" 缩写
    const dcIdx = parts.indexOf('');
    let groups;
    if (dcIdx !== -1) {
      const left = parts.slice(0, dcIdx).filter(p => p !== '');
      const right = parts.slice(dcIdx + 1).filter(p => p !== '');
      if (left.length + right.length > 7) return null;
      const fill = 8 - left.length - right.length;
      groups = [...left, ...Array(fill).fill('0'), ...right];
    } else {
      if (parts.length !== 8) return null;
      groups = parts;
    }
    let result = 0n;
    for (const g of groups) {
      if (g.length === 0 || g.length > 4) return null;
      const n = parseInt(g, 16);
      if (!Number.isInteger(n) || n < 0 || n > 0xffff) return null;
      result = (result << 16n) | BigInt(n);
    }
    return result;
  }
}

// 解析 JSON 数组字符串 → [{ip, cidr, family, raw}]. 失败 / 0 数组 → [].
// 1:1 平行 R158.69 agent IP allowlist 范式 + R158.16 email_enabled 旁路 fallback.
export function parseIpList(jsonOrArray) {
  let arr;
  if (Array.isArray(jsonOrArray)) {
    arr = jsonOrArray;
  } else if (typeof jsonOrArray === 'string') {
    try {
      const parsed = JSON.parse(jsonOrArray);
      if (!Array.isArray(parsed)) return [];
      arr = parsed;
    } catch {
      return [];
    }
  } else {
    return [];
  }
  const result = [];
  for (const raw of arr) {
    const s = String(raw).trim();
    if (!s) continue;
    if (s.includes('/')) {
      const [ip, bitsStr] = s.split('/');
      const bits = Number(bitsStr);
      const family = isIP(ip);
      if (family !== 0 && Number.isInteger(bits) && bits >= 0 &&
          ((family === 4 && bits <= 32) || (family === 6 && bits <= 128))) {
        result.push({ raw: s, ip, cidr: bits, family });
      }
    } else {
      const family = isIP(s);
      if (family !== 0) {
        result.push({ raw: s, ip: s, cidr: family === 4 ? 32 : 128, family });
      }
    }
  }
  return result;
}

// Match clientIp against parsed list. 1:1 平行 routes/system.js:28-33 clientIp shape.
// 跨 family 0 必 match. IPv4-mapped IPv6 `::ffff:127.0.0.1` → 规范化 `127.0.0.1`.
export function matchIp(clientIp, parsed) {
  if (!clientIp || !Array.isArray(parsed) || parsed.length === 0) return false;
  let cip = String(clientIp).trim();
  // 1:1 平行 routes/system.js:28-33 clientIp normalize (IPv4-mapped IPv6 → IPv4)
  if (cip.startsWith('::ffff:')) cip = cip.slice(7);
  const clientFamily = isIP(cip);
  if (clientFamily === 0) return false;
  for (const entry of parsed) {
    // 跨 family 0 必 match (1:1 平行 net.isIP family)
    if (entry.family !== clientFamily) continue;
    if (clientFamily === 4) {
      if (cidrMatchV4(cip, entry.ip, entry.cidr)) return true;
    } else {
      if (cidrMatchV6(cip, entry.ip, entry.cidr)) return true;
    }
  }
  return false;
}
