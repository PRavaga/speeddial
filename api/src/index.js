// ===================================================================
// Speed Dial — Sync API (Cloudflare Worker)
// ===================================================================

const MAX_BODY_SIZE = 1024 * 1024; // 1MB
const RATE_LIMIT_PER_MIN = 60;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return corsResponse(request, env, new Response(null, { status: 204 }));
    }

    // Public routes
    if (path === '/api/health') {
      return corsResponse(request, env, json({ ok: true, ts: Date.now() }));
    }

    // Authenticated routes
    if (path === '/api/sync' || path === '/api/sync/info') {
      const user = await verifyAuth(request, env);
      if (!user) {
        return corsResponse(request, env, json({ error: 'Unauthorized' }, 401));
      }

      // Rate limiting
      const rateLimited = await checkRateLimit(user.sub, env);
      if (rateLimited) {
        return corsResponse(request, env, json({ error: 'Too many requests' }, 429));
      }

      try {
        if (path === '/api/sync/info' && request.method === 'GET') {
          return corsResponse(request, env, await handleSyncInfo(user, env));
        }
        if (path === '/api/sync') {
          if (request.method === 'GET')    return corsResponse(request, env, await handleSyncGet(user, env));
          if (request.method === 'PUT')    return corsResponse(request, env, await handleSyncPut(user, request, env));
          if (request.method === 'DELETE') return corsResponse(request, env, await handleSyncDelete(user, env));
        }
      } catch (e) {
        return corsResponse(request, env, json({ error: e.message }, 500));
      }
    }

    return corsResponse(request, env, json({ error: 'Not found' }, 404));
  }
};

// ===================================================================
// Route handlers
// ===================================================================

async function handleSyncGet(user, env) {
  const stored = await env.SYNC_KV.get(`user:${user.sub}:data`, 'json');
  if (!stored) return json({ error: 'No data' }, 404);
  return json({ data: stored.data, version: stored.version, updatedAt: stored.updatedAt });
}

async function handleSyncPut(user, request, env) {
  // Payload size check
  const contentLength = parseInt(request.headers.get('Content-Length') || '0');
  if (contentLength > MAX_BODY_SIZE) {
    return json({ error: 'Payload too large' }, 413);
  }

  const body = await request.json();
  if (!body.data || body.version === undefined) {
    return json({ error: 'Missing data or version' }, 400);
  }

  const stored = await env.SYNC_KV.get(`user:${user.sub}:data`, 'json');

  // Optimistic concurrency: reject if server version doesn't match expected
  if (stored && body.expectedVersion !== undefined && stored.version !== body.expectedVersion) {
    return json({ error: 'Version conflict', serverVersion: stored.version }, 409);
  }

  const record = {
    data: body.data,
    version: body.version,
    updatedAt: Date.now()
  };

  await env.SYNC_KV.put(`user:${user.sub}:data`, JSON.stringify(record));

  await env.SYNC_KV.put(`user:${user.sub}:meta`, JSON.stringify({
    email: user.email,
    lastSync: Date.now(),
    version: body.version
  }));

  return json({ ok: true, version: body.version });
}

async function handleSyncDelete(user, env) {
  await env.SYNC_KV.delete(`user:${user.sub}:data`);
  await env.SYNC_KV.delete(`user:${user.sub}:meta`);
  return json({ ok: true });
}

async function handleSyncInfo(user, env) {
  const meta = await env.SYNC_KV.get(`user:${user.sub}:meta`, 'json');
  if (!meta) return json({ error: 'No data' }, 404);
  return json(meta);
}

// ===================================================================
// Rate limiting (KV-based, per user, per minute)
// ===================================================================

async function checkRateLimit(sub, env) {
  const key = `rate:${sub}:${Math.floor(Date.now() / 60000)}`;
  const count = parseInt(await env.SYNC_KV.get(key) || '0');
  if (count >= RATE_LIMIT_PER_MIN) return true;
  // Fire-and-forget — don't await, minor race is acceptable
  env.SYNC_KV.put(key, String(count + 1), { expirationTtl: 120 });
  return false;
}

// ===================================================================
// Auth — verify Google ID token locally via JWKS
// ===================================================================

let cachedKeys = null;
let cachedKeysAt = 0;
const JWKS_TTL = 3600000; // 1 hour

async function getGoogleKeys() {
  if (cachedKeys && (Date.now() - cachedKeysAt) < JWKS_TTL) return cachedKeys;
  const resp = await fetch('https://www.googleapis.com/oauth2/v3/certs');
  if (!resp.ok) throw new Error('Failed to fetch Google JWKS');
  const jwks = await resp.json();
  cachedKeys = jwks.keys;
  cachedKeysAt = Date.now();
  return cachedKeys;
}

async function verifyAuth(request, env) {
  const header = request.headers.get('Authorization');
  if (!header?.startsWith('Bearer ')) return null;

  const idToken = header.slice(7);

  try {
    // Decode header to find the key ID
    const [headerB64, payloadB64] = idToken.split('.');
    if (!headerB64 || !payloadB64) return null;

    const jwtHeader = JSON.parse(b64UrlDecode(headerB64));
    const payload = JSON.parse(b64UrlDecode(payloadB64));

    // Check claims before verifying signature (fast fail)
    if (payload.aud !== env.GOOGLE_CLIENT_ID) return null;
    if (!payload.iss?.includes('accounts.google.com')) return null;
    if (payload.exp && payload.exp * 1000 < Date.now()) return null;

    // Verify RS256 signature
    const keys = await getGoogleKeys();
    const key = keys.find(k => k.kid === jwtHeader.kid);
    if (!key) return null;

    const cryptoKey = await crypto.subtle.importKey(
      'jwk', key, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']
    );

    const sigInput = new TextEncoder().encode(idToken.split('.').slice(0, 2).join('.'));
    const signature = b64UrlToBuffer(idToken.split('.')[2]);

    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', cryptoKey, signature, sigInput);
    if (!valid) return null;

    return { sub: payload.sub, email: payload.email };
  } catch {
    return null;
  }
}

function b64UrlDecode(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  return atob(padded);
}

function b64UrlToBuffer(str) {
  const binary = b64UrlDecode(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// ===================================================================
// Helpers
// ===================================================================

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function corsResponse(request, env, response) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim());

  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Methods', 'GET, PUT, DELETE, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  headers.set('Access-Control-Max-Age', '86400');

  if (allowed.includes(origin)) {
    headers.set('Access-Control-Allow-Origin', origin);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
