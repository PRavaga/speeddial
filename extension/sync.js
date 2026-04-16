// ===================================================================
// Speed Dial — Sync Orchestrator
// ===================================================================

import { getValidIdToken, getUser, isSignedIn } from './auth.js';
import { deriveKey, encrypt, decrypt } from './crypto.js';

let SYNC_API = '';

export async function initSync() {
  try {
    const { config } = await chrome.storage.local.get('config');
    if (config?.syncApiUrl) SYNC_API = config.syncApiUrl;
  } catch {}
}

export function setSyncApiUrl(url) {
  SYNC_API = url.replace(/\/$/, '');
  chrome.storage.local.get('config').then(({ config = {} }) => {
    chrome.storage.local.set({ config: { ...config, syncApiUrl: SYNC_API } });
  });
}

// ===================================================================
// Main sync entry point
// ===================================================================

export async function syncNow() {
  if (!SYNC_API || !(await isSignedIn())) return { ok: false, reason: 'not configured' };

  try {
    const remote = await pullFromServer();
    const local = await collectLocalData();

    let merged;
    if (remote) {
      merged = mergeDocs(local, remote);
      merged.version = Math.max(local.version || 0, remote.version || 0) + 1;
    } else {
      merged = { ...local, version: (local.version || 0) + 1 };
    }

    merged.lastModified = Date.now();
    await pushToServer(merged);
    await applyRemoteData(merged);
    await chrome.storage.local.set({ lastSync: Date.now(), syncVersion: merged.version });

    return { ok: true, version: merged.version };
  } catch (e) {
    console.error('Sync failed:', e);
    return { ok: false, reason: e.message };
  }
}

// ===================================================================
// Push / Pull
// ===================================================================

async function pushToServer(doc) {
  const user = await getUser();
  const idToken = await getValidIdToken();
  if (!user || !idToken) throw new Error('Not authenticated');

  const key = await deriveKey(user.sub);
  const encrypted = await encrypt(doc, key);

  const resp = await fetch(`${SYNC_API}/api/sync`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${idToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ data: encrypted, version: doc.version })
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
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

  const key = await deriveKey(user.sub);
  return decrypt(encrypted, key);
}

// ===================================================================
// Collect local data into sync document
// ===================================================================

async function collectLocalData() {
  const storage = await chrome.storage.local.get(['backups', 'theme', 'pinnedSites', 'syncVersion']);
  return {
    version: storage.syncVersion || 0,
    lastModified: Date.now(),
    sessions: (storage.backups || []).slice(0, 20),
    settings: { theme: storage.theme || 'dark' },
    pinnedSites: storage.pinnedSites || []
  };
}

// ===================================================================
// Apply merged data locally
// ===================================================================

async function applyRemoteData(doc) {
  const updates = {};
  if (doc.sessions) updates.backups = doc.sessions.slice(0, 20);
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

  // Sort newest first, keep max 20
  merged.sort((a, b) => b.timestamp - a.timestamp);
  return merged.slice(0, 20);
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
