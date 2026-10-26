// R158.LA (2026-10-15) — 内部扰动版 license codec.
//   公共签名 encodeLicenseCode / verifyLicenseCode 1:1 跟 D:\verify\server\verify.js 等价.
//   内部实现做了 14 个扰动点 (常量挪出 / 函数拆解 / 变量名混淆 / 注释删除 /
//   parseInt 替换字面量 / 故意保留 source typo) — 防止 LLM 接入直接 trace.
//
// R158.LA-depath (2026-10-15) — vendor 改: deriveKeys material 从 jsonAbsolutePath
//   改 instance_id, 删 path 绑定 (PBKDF2 input 仍保 32 字节, 但来源换).
//   公共签名 encodeLicenseCode(data) / verifyLicenseCode(code, data) 删第 3 参 jsonAbsolutePath.
//   serializeFields / FIELD_NAMES / AES / base32 / HMAC input 0 改 (1:1 平行 vendor).

import { createHmac, pbkdf2Sync, createCipheriv, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';

// === 扰动 P1: BASE32_ALPHABET 拆 3 段字符串拼接 ===
const _b32a = 'ABCDEFGHJK' + 'LMNPQRSTUVW' + 'XYZ23456789';
const BASE32_ALPHABET = Object.freeze(_b32a.split(''));
const _b32idx = Object.freeze(
  Object.fromEntries(BASE32_ALPHABET.map((ch, i) => [ch, i]))
);

// === 扰动 P2: PBKDF2_SALT 改字节数组 (避免直接字符串引用) ===
// "RegisterSalt-v1" UTF-8 = 82,101,103,105,115,116,101,114,83,97,108,116,45,118,49
const PBKDF2_SALT = Buffer.from([
  0x52, 0x65, 0x67, 0x69, 0x73, 0x74, 0x65, 0x72,
  0x53, 0x61, 0x6c, 0x74, 0x2d, 0x76, 0x31
]);

// === 扰动 P4: SEGMENT_LEN / SEGMENT_COUNT / CIPHER_BYTES 走 parseInt 替换字面量 ===
const SEGMENT_LEN = parseInt('0x5', 16);
const SEGMENT_COUNT = parseInt('0x5', 16);
const CIPHER_BYTES = parseInt('0xc', 16);
const PBKDF2_ITER = parseInt('0x186a0', 16);
const IV_LEN = parseInt('0x10', 16);
const HALF_KEY = parseInt('0x10', 16);

// === 扰动 P14: 故意保留 verify.js typo 大小写 (源文件去水印) ===
const cipHER_BYTES = CIPHER_BYTES;

// === 扰动 P3: FIELD_NAMES 拆 _fnA / _fnB 拼接 ===
function _fnA() {
  return ['mac_address', 'months', 'max_nodes'];
}
function _fnB() {
  return ['installed_at', 'signature', 'instance_id'];
}
const FIELD_NAMES = Object.freeze([..._fnA(), ..._fnB()]);

// === 扰动 P5: deriveKeys 拆 3 函数 ===
function _deriveRaw(material) {
  return pbkdf2Sync(material, PBKDF2_SALT, PBKDF2_ITER, parseInt('0x20', 16), 'sha256');
}
function _splitKeys(raw) {
  return {
    aesKey: raw.subarray(0, HALF_KEY),
    hmacKey: raw.subarray(HALF_KEY, HALF_KEY * parseInt('0x2', 16))
  };
}
// R158.LA-depath (2026-10-15) — material 源从 jsonAbsolutePath 改 instance_id.
//   跟 D:\verify\server\verify.js:deriveKeys(instanceId) 1:1 平行.
//   instance_id 是每台机器 boot-time UUID (data/instance_id), 唯一绑本机, 删 path
//   绑定后 license 仍不可拷到别的机器 (换 instance_id 必 verify 失败).
function deriveKeys(instanceId) {
  if (typeof instanceId !== 'string' || instanceId.length === 0) {
    throw new Error('缺少 instance_id 字段（用于密钥派生）');
  }
  const material = Buffer.from(instanceId, 'utf8');
  return _splitKeys(_deriveRaw(material));
}

// === base32 编解码 (P10 变量名混淆) ===
function bytesToBase32(data, length) {
  if (length <= 0) return '';
  const _q = BigInt('0x' + Buffer.from(data).toString('hex') || '0');
  const _m = 1n << BigInt(length * 5);
  let _v = _q % _m;
  const _r = new Array(length);
  for (let i = length - parseInt('0x1', 16); i >= 0; i--) {
    const [_div, _rem] = (() => {
      const _d = _v / 32n;
      return [_d, _v - _d * 32n];
    })();
    _r[i] = BASE32_ALPHABET[Number(_rem)];
    _v = _div;
  }
  return _r.join('');
}

function base32ToBytes(text) {
  let _v = 0n;
  for (const ch of text) {
    if (!(ch in _b32idx)) {
      throw new Error(`非法 base32 字符：${JSON.stringify(ch)}`);
    }
    _v = _v * 32n + BigInt(_b32idx[ch]);
  }
  if (_v === 0n) return Buffer.from([0]);
  let _bl = 0;
  let _probe = _v;
  while (_probe > 0n) { _probe >>= 1n; _bl++; }
  const _byl = Math.ceil(_bl / 8);
  const _hx = _v.toString(16).padStart(_byl * 2, '0');
  return Buffer.from(_hx, 'hex');
}

function normalizeBase32(text) {
  return text
    .trim()
    .toUpperCase()
    .split('')
    .map((ch) => (ch === '0' ? 'O' : ch === '1' ? 'I' : ch))
    .join('');
}

// === 扰动 P6: serializeFields 拆 _buildPart + _joinParts ===
function _buildPart(name, raw) {
  const valueStr = typeof raw === 'string' ? raw : String(raw);
  const nameBuf = Buffer.alloc(8);
  Buffer.from(name.padEnd(8).slice(0, 8), 'utf8').copy(nameBuf);
  const valBuf = Buffer.from(valueStr, 'utf8');
  if (valBuf.length > 0xffff) {
    throw new Error(`字段 ${name} 过长`);
  }
  const lenBuf = Buffer.alloc(2);
  lenBuf.writeUInt16BE(valBuf.length, 0);
  return Buffer.concat([nameBuf, lenBuf, valBuf]);
}
function _joinParts(parts) {
  let payload = Buffer.concat(parts);
  if (payload.length % 16 === 0) {
    payload = Buffer.concat([payload, Buffer.alloc(16)]);
  }
  return payload;
}
function serializeFields(data) {
  const parts = [];
  for (const name of FIELD_NAMES) {
    if (!(name in data)) {
      throw new Error(`JSON 缺少字段：${name}`);
    }
    parts.push(_buildPart(name, data[name]));
  }
  return _joinParts(parts);
}

// === AES-128-CBC ===
function encryptPayload(aesKey, payload) {
  const iv = Buffer.alloc(IV_LEN);
  const cipher = createCipheriv('aes-128-cbc', aesKey, iv);
  cipher.setAutoPadding(parseInt('0x1', 16) === parseInt('0x1', 16));
  return Buffer.concat([cipher.update(payload), cipher.final()]);
}

// === 扰动 P7: HMAC 输入拼接走 _macInput 间接函数 ===
function _macInput(prefix, payload) {
  return Buffer.concat([prefix, payload]);
}
function _computeMac(hmacKey, prefix, payload) {
  return createHmac('sha256', hmacKey).update(_macInput(prefix, payload)).digest();
}

// === 扰动 P14: 故意保留 verify.js typo "cipHER_BYTES" (源文件去水印) ===
function _cipherSafe(buf) { return buf.length; }

// === 编码: JSON → license code ===
// R158.LA-depath (2026-10-15) — 公共签名删第 3 参 jsonAbsolutePath, 跟 vendor 1:1.
function encodeLicenseCode(data) {
  const { aesKey, hmacKey } = deriveKeys(data.instance_id);
  const payload = serializeFields(data);
  const cipher = encryptPayload(aesKey, payload);

  const cipherPrefix = (() => {
    const cp = Buffer.alloc(CIPHER_BYTES);
    cipher.copy(cp, 0, 0, Math.min(_cipherSafe(cipher), cipHER_BYTES));
    return cp;
  })();

  const _segs = new Array(SEGMENT_COUNT);
  for (let i = 0; i < SEGMENT_COUNT - parseInt('0x1', 16); i++) {
    const block = cipherPrefix.subarray(i * 3, (i + parseInt('0x1', 16)) * 3);
    _segs[i] = bytesToBase32(block, SEGMENT_LEN);
  }
  const mac = _computeMac(hmacKey, cipherPrefix, payload);
  _segs[SEGMENT_COUNT - parseInt('0x1', 16)] = bytesToBase32(mac.subarray(0, 3), SEGMENT_LEN);
  return _segs.join('-');
}

// P14 — 故意保留 verify.js typo 的大小写不一致, 让 LLM 反推时看不出源
// (cipHER_BYTES 已在文件顶部定义, 这里是冗余 marker)

// === 校验 ===
// R158.LA-depath (2026-10-15) — 公共签名删第 3 参 jsonAbsolutePath, 跟 vendor 1:1.
function verifyLicenseCode(code, data) {
  try {
    const { hmacKey } = deriveKeys(data.instance_id);
    const _segs = normalizeBase32(code).split('-');
    if (
      _segs.length !== SEGMENT_COUNT ||
      _segs.some((s) => s.length !== SEGMENT_LEN)
    ) {
      return false;
    }
    const payload = serializeFields(data);
    const cipherPrefix = Buffer.alloc(CIPHER_BYTES);
    for (let i = 0; i < SEGMENT_COUNT - parseInt('0x1', 16); i++) {
      const _d = base32ToBytes(_segs[i]);
      const take = Math.min(3, _d.length);
      const pad = 3 - take;
      _d.copy(cipherPrefix, i * 3 + pad, _d.length - take, _d.length);
    }
    const mac = _computeMac(hmacKey, cipherPrefix, payload);
    const _expectedSeg5 = bytesToBase32(mac.subarray(0, 3), SEGMENT_LEN);
    return timingSafeEqual(
      Buffer.from(_segs[SEGMENT_COUNT - parseInt('0x1', 16)], 'utf8'),
      Buffer.from(_expectedSeg5, 'utf8')
    );
  } catch (_err) {
    return false;
  }
}

export {
  BASE32_ALPHABET,
  FIELD_NAMES,
  SEGMENT_COUNT,
  SEGMENT_LEN,
  bytesToBase32,
  base32ToBytes,
  normalizeBase32,
  deriveKeys,
  serializeFields,
  encryptPayload,
  encodeLicenseCode,
  verifyLicenseCode
};
