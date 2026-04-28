// ===================================================================
// Speed Dial — Sync Orchestrator
// ===================================================================

import { getValidIdToken, getUser, isSignedIn } from './auth.js';
import { encrypt, decrypt } from './crypto.js';

const SYNC_API = 'https://speeddial-sync.apps-0fb.workers.dev';

// Sessions are immutable, union-merged, and accumulate forever. Two caps:
//   LOCAL_MAX — chrome.storage.local ceiling (matches MAX_BACKUPS in background.js)
//   SYNC_MAX  — only the newest N are pushed to the server, keeping the
//               encrypted payload well under the worker's 5 MB body limit
//               even when users have many tabs per session.
const LOCAL_MAX_SESSIONS = 100;
const SYNC_MAX_SESSIONS = 50;

export async function initSync() {
  // No-op — API URL is hardcoded. Kept for interface compatibility.
}

// ===================================================================
// Main sync entry point
// ===================================================================

export async function syncNow() {
  if (!SYNC_API || !(await isSignedIn())) return { ok: false, reason: 'not configured' };

  try {
    const remote = await pullFromServer();
    const local = await collectLocalData();

    const remoteVersion = remote?.version || 0;
    let merged;
    if (remote) {
      merged = mergeDocs(local, remote);
      merged.version = Math.max(local.version || 0, remoteVersion) + 1;
    } else {
      merged = { ...local, version: (local.version || 0) + 1 };
    }

    merged.lastModified = Date.now();
    await pushToServer(merged, remoteVersion);
    await applyRemoteData(merged);
    await chrome.storage.local.set({ lastSync: Date.now(), syncVersion: merged.version });

    return { ok: true, version: merged.version };
  } catch (e) {
    console.error('Sync failed:', e);
    return { ok: false, reason: e.message || e.name || 'unknown error' };
  }
}

// ===================================================================
// Push / Pull
// ===================================================================

async function pushToServer(doc, expectedVersion = 0) {
  const user = await getUser();
  const idToken = await getValidIdToken();
  if (!user || !idToken) throw new Error('Not authenticated');

  // Truncate sessions to SYNC_MAX_SESSIONS for the wire payload only — local
  // storage retains up to LOCAL_MAX_SESSIONS, so users don't lose history.
  const wireDoc = { ...doc, sessions: (doc.sessions || []).slice(0, SYNC_MAX_SESSIONS) };
  const encrypted = await encrypt(wireDoc, user.sub);

  const resp = await fetch(`${SYNC_API}/api/sync`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${idToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ data: encrypted, version: doc.version, expectedVersion })
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    if (resp.status === 413) {
      throw new Error('Sync payload exceeds 5 MB. Trim sessions in the panel and retry.');
    }
    throw new Error(err.error || `Push failed: ${resp.status}`);
  }
}

async function pullFromServer() {
  const user = await getUser();
  const idToken = await getValidIdToken();
  if (!user || !idToken) return null;

  const resp = await fetch(`${SYNC_API}/api/sync`, {
    headers: { 'Authorization': `Bearer ${idToken}` }
  });

  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`Pull failed: ${resp.status}`);

  const { data: encrypted } = await resp.json();
  if (!encrypted) return null;

  try {
    return await decrypt(encrypted, user.sub);
  } catch (e) {
    // OperationError = AES-GCM auth failure (wrong key). Most likely cause:
    // blob was encrypted with older key-derivation params we no longer support,
    // or the user wiped local state. Either way, the blob is unusable — wipe it
    // so the next push reseeds from local instead of leaving sync permanently broken.
    if (e.name === 'OperationError') {
      console.warn('Sync blob undecryptable — wiping server and reseeding from local');
      await fetch(`${SYNC_API}/api/sync`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${idToken}` }
      }).catch(() => {});
      return null;
    }
    throw e;
  }
}

// ===================================================================
// Collect local data into sync document
// ===================================================================

async function collectLocalData() {
  const storage = await chrome.storage.local.get(['backups', 'theme', 'pinnedSites', 'syncVersion']);
  return {
    version: storage.syncVersion || 0,
    lastModified: Date.now(),
    sessions: (storage.backups || []).slice(0, LOCAL_MAX_SESSIONS).map(stripSessionFat),
    settings: { theme: storage.theme || 'dark' },
    pinnedSites: storage.pinnedSites || []
  };
}

// Drop favIconUrl (often long data: URLs) — we regenerate via chrome _favicon API from url.
function stripSessionFat(session) {
  const stripTab = t => ({ title: t.title, url: t.url, pinned: t.pinned });
  return {
    ...session,
    groups: (session.groups || []).map(g => ({ ...g, tabs: (g.tabs || []).map(stripTab) })),
    ungrouped: (session.ungrouped || []).map(stripTab)
  };
}

// ===================================================================
// Apply merged data locally
// ===================================================================

async function applyRemoteData(doc) {
  const updates = {};
  if (doc.sessions) updates.backups = doc.sessions.slice(0, LOCAL_MAX_SESSIONS);
  if (doc.settings?.theme) updates.theme = doc.settings.theme;
  if (doc.pinnedSites) updates.pinnedSites = doc.pinnedSites;
  await chrome.storage.local.set(updates);
}

// ===================================================================
// Merge logic
// ===================================================================

function mergeDocs(local, remote) {
  return {
    version: 0, // caller sets this
    lastModified: Date.now(),
    sessions: mergeSessions(local.sessions || [], remote.sessions || []),
    settings: mergeSettings(local.settings || {}, remote.settings || {}, local.lastModified, remote.lastModified),
    pinnedSites: mergePinnedSites(local.pinnedSites || [], remote.pinnedSites || [])
  };
}

function mergeSessions(localSessions, remoteSessions) {
  // Union by timestamp — sessions are immutable once created
  const seen = new Set();
  const merged = [];

  for (const s of [...localSessions, ...remoteSessions]) {
    const key = `${s.timestamp}-${s.type}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(s);
    }
  }

  // Sort newest first, cap at LOCAL_MAX_SESSIONS — wire truncation happens later in pushToServer.
  merged.sort((a, b) => b.timestamp - a.timestamp);
  return merged.slice(0, LOCAL_MAX_SESSIONS);
}

function mergeSettings(local, remote, localTs, remoteTs) {
  // Latest modification wins
  return (remoteTs || 0) > (localTs || 0) ? { ...local, ...remote } : { ...remote, ...local };
}

function mergePinnedSites(local, remote) {
  // Merge by URL, latest addedAt wins
  const map = new Map();
  for (const s of [...remote, ...local]) {
    const existing = map.get(s.url);
    if (!existing || (s.addedAt || 0) > (existing.addedAt || 0)) {
      map.set(s.url, s);
    }
  }
  return [...map.values()].sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
}

// ===================================================================
// Sync status helpers
// ===================================================================

export async function getSyncStatus() {
  const { lastSync, syncVersion } = await chrome.storage.local.get(['lastSync', 'syncVersion']);
  const signedIn = await isSignedIn();
  return {
    signedIn,
    lastSync: lastSync || null,
    version: syncVersion || 0,
    configured: !!SYNC_API
  };
}
