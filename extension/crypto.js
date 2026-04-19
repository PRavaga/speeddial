// ===================================================================
// Speed Dial — Client-side Encryption (AES-256-GCM)
// ===================================================================
//
// Ciphertext envelope: { v, iv, data }
//   v = key-derivation version (see KEY_VERSIONS)
// Legacy blobs with no `v` field are treated as v=1.
// To rotate params: add a new entry to KEY_VERSIONS and bump CURRENT_KEY_VERSION.
// ===================================================================

const KEY_VERSIONS = {
  1: { iterations: 100000, passphrase: 'speeddial-v1' },
  2: { iterations: 600000, passphrase: 'speeddial-v1' },
};
const CURRENT_KEY_VERSION = 2;

async function deriveKey(userSub, version) {
  const params = KEY_VERSIONS[version];
  if (!params) throw new Error(`Unknown key version: ${version}`);
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(params.passphrase), 'PBKDF2', false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode(userSub), iterations: params.iterations, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encrypt(data, userSub) {
  const key = await deriveKey(userSub, CURRENT_KEY_VERSION);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(data));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  return {
    v: CURRENT_KEY_VERSION,
    iv: bufToBase64(iv),
    data: bufToBase64(new Uint8Array(ciphertext))
  };
}

export async function decrypt(encrypted, userSub) {
  const version = encrypted.v || 1;
  const key = await deriveKey(userSub, version);
  const iv = base64ToBuf(encrypted.iv);
  const ciphertext = base64ToBuf(encrypted.data);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return JSON.parse(new TextDecoder().decode(plaintext));
}

function bufToBase64(buf) {
  let binary = '';
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  }
  return btoa(binary);
}

function base64ToBuf(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
