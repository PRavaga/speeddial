// ===================================================================
// Speed Dial — Sync API (Cloudflare Worker)
// ===================================================================

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
  const body = await request.json();
  if (!body.data || body.version === undefined) {
    return json({ error: 'Missing data or version' }, 400);
  }

  const stored = await env.SYNC_KV.get(`user:${user.sub}:data`, 'json');

  // Optimistic concurrency: reject if server version is ahead
  if (stored && body.expectedVersion !== undefined && stored.version !== body.expectedVersion) {
    return json({ error: 'Version conflict', serverVersion: stored.version }, 409);
  }

  const record = {
    data: body.data,
    version: body.version,
    updatedAt: Date.now()
  };

  await env.SYNC_KV.put(`user:${user.sub}:data`, JSON.stringify(record));

  // Update metadata
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
// Auth — verify Google ID token
// ===================================================================

async function verifyAuth(request, env) {
  const header = request.headers.get('Authorization');
  if (!header?.startsWith('Bearer ')) return null;

  const idToken = header.slice(7);

  try {
    // Simple verification via Google's tokeninfo endpoint
    const resp = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${idToken}`);
    if (!resp.ok) return null;

    const info = await resp.json();

    // Verify audience matches our client ID
    if (info.aud !== env.GOOGLE_CLIENT_ID) return null;

    // Check expiry
    if (info.exp && Number(info.exp) * 1000 < Date.now()) return null;

    return { sub: info.sub, email: info.email };
  } catch {
    return null;
  }
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

  // Allow if origin matches, or allow all for dev
  if (allowed.includes(origin) || allowed.includes('*')) {
    headers.set('Access-Control-Allow-Origin', origin);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
