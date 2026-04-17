// ===================================================================
// Speed Dial — Google OAuth 2.0 (PKCE)
// ===================================================================

const STORAGE_KEY = 'syncAuth';

let CLIENT_ID = '1017927287759-tbs9i5pv4voe8oe25bb93vdokte7sqa9.apps.googleusercontent.com';
let CLIENT_SECRET = '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';
let REDIRECT_URL = '';

export async function initAuth() {
  try {
    REDIRECT_URL = chrome.identity.getRedirectURL();
  } catch {}
}

export function setClientId(id) {
  CLIENT_ID = id;
  chrome.storage.local.set({ config: { googleClientId: id } });
}

export function getClientId() {
  return CLIENT_ID;
}

// ---- Sign In (PKCE) ----

export async function signIn() {
  if (!CLIENT_ID) throw new Error('Google Client ID not configured');

  const verifier = generateCodeVerifier();
  const challenge = await computeCodeChallenge(verifier);

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', REDIRECT_URL);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'openid email profile');
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');

  const responseUrl = await chrome.identity.launchWebAuthFlow({
    url: authUrl.toString(),
    interactive: true
  });

  const code = new URL(responseUrl).searchParams.get('code');
  if (!code) throw new Error('No authorization code received');

  // Exchange code for tokens
  const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: REDIRECT_URL
    })
  });

  if (!tokenResp.ok) {
    const err = await tokenResp.json().catch(() => ({}));
    console.error('Token exchange failed:', err);
    console.error('Redirect URI used:', REDIRECT_URL);
    console.error('Client ID used:', CLIENT_ID);
    throw new Error(err.error_description || err.error || `Token exchange failed (${tokenResp.status})`);
  }

  const tokens = await tokenResp.json();
  const user = decodeIdToken(tokens.id_token);

  const auth = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    idToken: tokens.id_token,
    expiresAt: Date.now() + (tokens.expires_in * 1000),
    user
  };

  await chrome.storage.local.set({ [STORAGE_KEY]: auth });
  return auth;
}

// ---- Sign Out ----

export async function signOut() {
  await chrome.storage.local.remove(STORAGE_KEY);
  try { await chrome.identity.clearAllCachedAuthTokens(); } catch {}
}

// ---- Token Management ----

export async function getAuth() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return result[STORAGE_KEY] || null;
}

export async function isSignedIn() {
  const auth = await getAuth();
  return !!(auth?.refreshToken);
}

export async function getValidIdToken() {
  let auth = await getAuth();
  if (!auth?.refreshToken) return null;

  // Refresh if expired (or within 60s of expiry)
  if (Date.now() > (auth.expiresAt - 60000)) {
    auth = await refreshTokens(auth);
  }

  return auth.idToken;
}

export async function getUser() {
  const auth = await getAuth();
  return auth?.user || null;
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
    // Refresh token revoked — user needs to sign in again
    await signOut();
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

  await chrome.storage.local.set({ [STORAGE_KEY]: updated });
  return updated;
}

// ---- PKCE Helpers ----

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

// ---- JWT decode (no verification — we got it from Google directly) ----

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
