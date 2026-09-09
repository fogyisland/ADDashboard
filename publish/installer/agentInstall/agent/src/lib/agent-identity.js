// 2026-09-09 S82 (security) — agent identity binding.
//
// Background: the center's agent-token middleware validates the shared
// `X-Agent-Token` header, but the body fields `hostname` and `agentId`
// are NOT bound to the token. Agent A can authenticate successfully and
// then claim `hostname=B` in the body — impersonating B's reporting
// surface (replication data, AD discovery, file-push claims, command
// queue acks).
//
// This module adds an HMAC-SHA256 signature over `hostname:agentId:<sorted
// body>` keyed by the agent token. The center recomputes the same HMAC
// from the supplied token + body and compares via crypto.timingSafe
//// Equal. The body is sorted (JSON-stable) so insertion order doesn't
// change the signature.
//
// Wire format:
//   X-Agent-Signature: <hex(hmac-sha256(token, hostname + ':' + agentId + ':' + sortedBody))>
// For HTTP requests without a body (GETs), pass an empty JSON literal '' or '{}'.

import { createHmac, timingSafeEqual } from 'node:crypto';

// Stable JSON serialization — sorts keys at every level so {a:1,b:2} and
// {b:2,a:1} produce the same string. Object values nested inside arrays
// also get sorted.
function stableJson(value) {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(stableJson).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableJson(value[k])).join(',') + '}';
}

/**
 * Sign a request body so the center can verify (hostname, agentId, body)
 * was not tampered with after the token validated.
 *
 * @param {object} args
 * @param {string} args.hostname    — agent's hostname (or agentId for agents without one)
 * @param {string} args.agentId     — agent's persistent identifier
 * @param {object|null} [args.body] — request body to be POSTed (or null for GET)
 * @param {string} args.token       — shared secret (same as X-Agent-Token)
 * @returns {string} hex-encoded HMAC-SHA256 signature
 */
export function signRequest({ hostname, agentId, body, token } = {}) {
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('token required');
  }
  if (typeof hostname !== 'string' || typeof agentId !== 'string') {
    throw new Error('hostname + agentId required');
  }
  const bodyStr = body == null ? '' : stableJson(body);
  const message = `${hostname}:${agentId}:${bodyStr}`;
  return createHmac('sha256', token).update(message).digest('hex');
}

/**
 * Verify a request signature with constant-time comparison.
 *
 * @param {object} args
 * @param {string} args.signature  — X-Agent-Signature value
 * @param {string} args.hostname
 * @param {string} args.agentId
 * @param {object|null} [args.body]
 * @param {string} args.token
 * @returns {boolean} true when signature matches
 */
export function verifyRequest({ signature, hostname, agentId, body, token } = {}) {
  if (typeof signature !== 'string' || signature.length === 0) return false;
  const expected = signRequest({ hostname, agentId, body, token });
  // timingSafeEqual requires equal-length buffers; pad / trim defensively.
  // Lengths should always be equal (both are hex sha256 = 64 chars).
  if (expected.length !== signature.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

// Exposed for the test harness.
export const __testing = { stableJson };