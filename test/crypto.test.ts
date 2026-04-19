/**
 * Speed Dial — Crypto Unit Tests
 *
 * Runs crypto.js in Node's Web Crypto API to verify the envelope versioning
 * and legacy-blob decrypt path. Node 22+ exposes `crypto.subtle` globally.
 *
 * Run: npx tsx test/crypto.test.ts
 */

import { encrypt, decrypt } from '../extension/crypto.js';

const RESULTS: { name: string; pass: boolean; error?: string }[] = [];

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    RESULTS.push({ name, pass: true });
    console.log(`  ✓ ${name}`);
  } catch (e: any) {
    RESULTS.push({ name, pass: false, error: e.message });
    console.log(`  ✗ ${name}: ${e.message}`);
  }
}

function assert(cond: any, msg: string) {
  if (!cond) throw new Error(msg);
}

// Manual v1 envelope builder (simulates an older client at 100k iterations).
async function encryptV1Legacy(data: any, userSub: string) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode('speeddial-v1'), 'PBKDF2', false, ['deriveKey']
  );
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode(userSub), iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(data));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  const bufToB64 = (buf: Uint8Array) => Buffer.from(buf).toString('base64');
  // Legacy shape: NO `v` field — decrypt must default to v=1.
  return {
    iv: bufToB64(iv),
    data: bufToB64(new Uint8Array(ciphertext))
  };
}

async function main() {
  console.log('\n── Crypto Unit Tests ──\n');

  const sub = '113421845199809478625';
  const payload = { version: 1, sessions: [{ url: 'https://example.com', title: 'Example' }] };

  await test('encrypt returns envelope with v=2, iv, data', async () => {
    const env = await encrypt(payload, sub);
    assert(env.v === 2, `Expected v=2, got v=${env.v}`);
    assert(typeof env.iv === 'string' && env.iv.length > 0, 'Missing iv');
    assert(typeof env.data === 'string' && env.data.length > 0, 'Missing data');
  });

  await test('encrypt → decrypt roundtrip preserves payload', async () => {
    const env = await encrypt(payload, sub);
    const plain = await decrypt(env, sub);
    assert(JSON.stringify(plain) === JSON.stringify(payload), 'Roundtrip mismatch');
  });

  await test('decrypt rejects wrong userSub with OperationError', async () => {
    const env = await encrypt(payload, sub);
    try {
      await decrypt(env, 'wrong-sub');
      assert(false, 'Should have thrown');
    } catch (e: any) {
      assert(e.name === 'OperationError', `Expected OperationError, got ${e.name}`);
    }
  });

  await test('decrypt handles legacy v1 blob (no v field, 100k iters)', async () => {
    const legacyEnv = await encryptV1Legacy(payload, sub);
    assert(!('v' in legacyEnv), 'Legacy shape should have no v field');
    const plain = await decrypt(legacyEnv as any, sub);
    assert(JSON.stringify(plain) === JSON.stringify(payload), 'Legacy decrypt mismatch');
  });

  await test('decrypt of v1 blob with wrong params still fails loudly', async () => {
    // Legacy blob with someone else's sub: must still fail with OperationError, not silently decode.
    const legacyEnv = await encryptV1Legacy(payload, sub);
    try {
      await decrypt(legacyEnv as any, 'different-sub');
      assert(false, 'Should have thrown');
    } catch (e: any) {
      assert(e.name === 'OperationError', `Expected OperationError, got ${e.name}`);
    }
  });

  await test('decrypt rejects unknown future version', async () => {
    const env = await encrypt(payload, sub);
    try {
      await decrypt({ ...env, v: 99 } as any, sub);
      assert(false, 'Should have thrown');
    } catch (e: any) {
      assert(/Unknown key version/.test(e.message), `Wrong error: ${e.message}`);
    }
  });

  await test('encrypt produces different ciphertext each call (fresh IV)', async () => {
    const a = await encrypt(payload, sub);
    const b = await encrypt(payload, sub);
    assert(a.iv !== b.iv, 'IV reused across encryptions');
    assert(a.data !== b.data, 'Ciphertext identical — IV probably not random');
  });

  await test('large payload (1 MB) roundtrips', async () => {
    const big = { blob: 'x'.repeat(1024 * 1024) };
    const env = await encrypt(big, sub);
    const plain = await decrypt(env, sub);
    assert(plain.blob.length === 1024 * 1024, 'Large roundtrip failed');
  });

  console.log('');
  const passed = RESULTS.filter(r => r.pass).length;
  const failed = RESULTS.filter(r => !r.pass).length;
  console.log(`  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('Runner failed:', e);
  process.exit(1);
});
