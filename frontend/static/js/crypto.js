// crypto.js — 連絡先E2E暗号化（管理者ブラウザ側でのみ暗号化/復号）
//
// 仕組み:
//   - 管理者が設定したパスフレーズから PBKDF2 (SHA-256, 310,000回) で AES-256-GCM 鍵を導出
//   - 暗号文フォーマット: "enc.v1.<base64(iv)>.<base64(ciphertext)>"
//   - サーバには KDFソルト と 検証用暗号文(verifier) のみ保存。パスフレーズ・鍵は送信しない
//   - 導出済み鍵は sessionStorage にキャッシュ（タブを閉じるまで有効）

const PREFIX        = 'enc.v1.';
const PBKDF2_ITERS  = 310000;
const VERIFIER_TEXT = 'shift-app-crypto-v1';
const SESSION_KEY   = 'shift_crypto_key';

let _key = null; // CryptoKey（メモリキャッシュ）

// ─── ユーティリティ ──────────────────────────────────────────
const b64 = {
  encode: (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))),
  decode: (str) => Uint8Array.from(atob(str), c => c.charCodeAt(0)),
};

export function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

// ─── 鍵導出・キャッシュ ──────────────────────────────────────
async function deriveKey(passphrase, saltB64) {
  const material = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: b64.decode(saltB64), iterations: PBKDF2_ITERS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    true, // sessionStorage キャッシュ用に extractable
    ['encrypt', 'decrypt']);
}

async function cacheKey(key) {
  _key = key;
  try {
    const raw = await crypto.subtle.exportKey('raw', key);
    sessionStorage.setItem(SESSION_KEY, b64.encode(raw));
  } catch { /* キャッシュ不可でも動作は継続 */ }
}

async function loadCachedKey() {
  if (_key) return _key;
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    _key = await crypto.subtle.importKey(
      'raw', b64.decode(raw), { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
    return _key;
  } catch {
    return null;
  }
}

export async function isUnlocked() {
  return (await loadCachedKey()) !== null;
}

export function lock() {
  _key = null;
  try { sessionStorage.removeItem(SESSION_KEY); } catch { /* noop */ }
}

// ─── 暗号化・復号 ────────────────────────────────────────────
async function encryptWith(key, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
  return PREFIX + b64.encode(iv) + '.' + b64.encode(ct);
}

async function decryptWith(key, value) {
  const parts = value.slice(PREFIX.length).split('.');
  if (parts.length !== 2) throw new Error('暗号文の形式が不正です');
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64.decode(parts[0]) }, key, b64.decode(parts[1]));
  return new TextDecoder().decode(pt);
}

// encryptValue は平文を暗号化する。鍵が未ロードならエラー。
export async function encryptValue(plaintext) {
  const key = await loadCachedKey();
  if (!key) throw new Error('復号鍵がロードされていません');
  return encryptWith(key, plaintext);
}

// decryptValue は暗号文を復号する。復号できない場合は null。
export async function decryptValue(value) {
  if (!isEncrypted(value)) return value;
  const key = await loadCachedKey();
  if (!key) return null;
  try {
    return await decryptWith(key, value);
  } catch {
    return null;
  }
}

// ─── セットアップ・アンロック ────────────────────────────────
// setup はパスフレーズから新規に設定を作る。
// 戻り値 { kdf_salt, verifier } をサーバに登録する。
export async function setup(passphrase) {
  const saltB64 = b64.encode(crypto.getRandomValues(new Uint8Array(16)));
  const key = await deriveKey(passphrase, saltB64);
  const verifier = await encryptWith(key, VERIFIER_TEXT);
  await cacheKey(key);
  return { kdf_salt: saltB64, verifier };
}

// unlock はパスフレーズを検証して鍵をキャッシュする。
// 成功: true / パスフレーズ不一致: false
export async function unlock(passphrase, settings) {
  const key = await deriveKey(passphrase, settings.kdf_salt);
  try {
    if ((await decryptWith(key, settings.verifier)) !== VERIFIER_TEXT) return false;
  } catch {
    return false;
  }
  await cacheKey(key);
  return true;
}
