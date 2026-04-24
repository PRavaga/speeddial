// ===================================================================
// Speed Dial Web — Google OAuth 2.0 (PKCE, redirect flow)
// ===================================================================

const STORAGE_KEY = 'sd.syncAuth';
const PKCE_KEY = 'sd.pkceVerifier';

// Same OAuth Web client as the extension. The web app just needs its
// origin added to the authorized redirect URIs in Google Cloud Console.
const CLIENT_ID = '1017927287759-mgaib9am82c58fl9e6u7m7ht10kj1bp9.apps.googleusercontent.com';
const CLIENT_SECRET = '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';

// The redirect lands back on this page (root) with ?code=...&state=...
function redirectUri() {
  return `${location.origin}/`;
}

// ===================================================================
// Public API
// ===================================================================

export async function initAuth() {
  // Handle OAuth redirect if we arrived with ?code=...
  const url = new URL(location.href);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const err = url.searchParams.get('error');

  if (err) {
    // Clear any stale PKCE and surface the error
    sessionStorage.removeItem(PKCE_KEY);
    cleanUrl();
    throw new Error(`OAuth error: ${err}`);
  }

  if (code) {
    await completeSignIn(code, state);
    cleanUrl();
  }
}

export async function signIn() {
  const verifier = generateCodeVerifier();
  const challenge = await computeCodeChallenge(verifier);
  const state = generateCodeVerifier().slice(0, 16);

  sessionStorage.setItem(PKCE_KEY, JSON.stringify({ verifier, state }));

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', redirectUri());
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'openid email profile');
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');
  authUrl.searchParams.set('state', state);

  // Full-page redirect — Google will come back to us
  location.assign(authUrl.toString());
}

export function signOut() {
  localStorage.removeItem(STORAGE_KEY);
  sessionStorage.removeItem(PKCE_KEY);
}

export function getAuth() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function isSignedIn() {
  const auth = getAuth();
  return !!(auth?.refreshToken);
}

export function getUser() {
  return getAuth()?.user || null;
}

export async function getValidIdToken() {
  let auth = getAuth();
  if (!auth?.refreshToken) return null;

  // Refresh if within 60s of expiry
  if (Date.now() > (auth.expiresAt - 60000)) {
    auth = await refreshTokens(auth);
  }

  return auth.idToken;
}

// ===================================================================
// Internals
// ===================================================================

async function completeSignIn(code, state) {
  const pkce = JSON.parse(sessionStorage.getItem(PKCE_KEY) || 'null');
  sessionStorage.removeItem(PKCE_KEY);

  if (!pkce) throw new Error('Missing PKCE verifier — retry sign-in');
  if (pkce.state !== state) throw new Error('OAuth state mismatch — retry sign-in');

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      code_verifier: pkce.verifier,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri()
    })
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error_description || err.error || `Token exchange failed (${resp.status})`);
  }

  const tokens = await resp.json();
  const user = decodeIdToken(tokens.id_token);

  const auth = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    idToken: tokens.id_token,
    expiresAt: Date.now() + (tokens.expires_in * 1000),
    user
  };

  localStorage.setItem(STORAGE_KEY, JSON.stringify(auth));
}

async function refreshTokens(auth) {
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: auth.refreshToken,
      grant_type: 'refresh_token'
    })
  });

  if (!resp.ok) {
    signOut();
    throw new Error('Session expired, please sign in again');
  }

  const tokens = await resp.json();
  const updated = {
    ...auth,
    accessToken: tokens.access_token,
    idToken: tokens.id_token || auth.idToken,
    expiresAt: Date.now() + (tokens.expires_in * 1000),
    user: tokens.id_token ? decodeIdToken(tokens.id_token) : auth.user
  };

  localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  return updated;
}

function cleanUrl() {
  const url = new URL(location.href);
  for (const k of ['code', 'state', 'scope', 'authuser', 'prompt', 'error', 'iss', 'hd', 'session_state']) {
    url.searchParams.delete(k);
  }
  history.replaceState(null, '', url.pathname + (url.search ? url.search : '') + url.hash);
}

function generateCodeVerifier() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return base64UrlEncode(bytes);
}

async function computeCodeChallenge(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

function base64UrlEncode(buf) {
  let binary = '';
  for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeIdToken(idToken) {
  try {
    const payload = idToken.split('.')[1];
    const padded = payload.replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(padded);
    const data = JSON.parse(json);
    return {
      sub: data.sub,
      email: data.email,
      name: data.name || data.email,
      picture: data.picture || ''
    };
  } catch {
    return null;
  }
}
