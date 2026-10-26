// R158.37 (2026-10-03) - AD Credential Vault (shared AES-256-GCM)
//
// Extracted from R158.35 ad-directory-sync.js so ad_directory_sync +
// ad_forest_registry + any future AD service share the same AES-256-GCM
// helpers. Same encryption tier as R139 smtp_password.
//
// Ciphertext layout (base64):
//   salt[16] | iv[12] | gcmTag[16] | ciphertext
// Key derivation: scryptSync(secretKey, salt, 32). AES-GCM 16-byte
// auth tag guarantees tamper detection.
//
// Secret key priority (deriveSecretKey):
//   process.env.AD_BIND_PASSWORD_KEY -> jwtSecret (fallback)
//
// R158.37.3 fix: prior Edit pass corrupted this file's Chinese header
// comments (mixed UTF-8 + GB18030 bytes). Node ESM failed to compile
// the module, cascading into ad-forest-registry.js namespace being empty
// and listForests throwing "(intermediate value) is not iterable". Clean
// UTF-8 rewrite.

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const ENC_ALG = 'aes-256-gcm';
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

export function deriveSecretKey(env = process.env, jwtSecret = '') {
  return env.AD_BIND_PASSWORD_KEY || jwtSecret || '';
}

export function encryptBindPassword(plaintext, secretKey) {
  if (!secretKey) throw new Error('encryptBindPassword: secretKey is required');
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = scryptSync(secretKey, salt, KEY_LEN);
  const cipher = createCipheriv(ENC_ALG, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([salt, iv, tag, ct]).toString('base64');
}

export function decryptBindPassword(b64Ciphertext, secretKey) {
  if (!secretKey) throw new Error('decryptBindPassword: secretKey is required');
  const buf = Buffer.from(b64Ciphertext, 'base64');
  if (buf.length < SALT_LEN + IV_LEN + TAG_LEN) {
    throw new Error('decryptBindPassword: ciphertext too short');
  }
  const salt = buf.subarray(0, SALT_LEN);
  const iv = buf.subarray(SALT_LEN, SALT_LEN + IV_LEN);
  const tag = buf.subarray(SALT_LEN + IV_LEN, SALT_LEN + IV_LEN + TAG_LEN);
  const ct = buf.subarray(SALT_LEN + IV_LEN + TAG_LEN);
  const key = scryptSync(secretKey, salt, KEY_LEN);
  const decipher = createDecipheriv(ENC_ALG, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

// Heuristic: ciphertext is at least salt+iv+tag+1 byte base64-encoded =
// 56 chars. Treat longer alphanumeric+/+=/ strings as ciphertext,
// anything shorter or with non-base64 chars as plaintext.
export function looksLikeCiphertext(stored) {
  return typeof stored === 'string' && /^[A-Za-z0-9+/=]{56,}$/.test(stored);
}