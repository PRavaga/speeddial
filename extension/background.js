// ===================================================================
// Speed Dial — Background Service Worker
// ===================================================================

import { initAuth, isSignedIn } from './auth.js';
import { initSync, syncNow } from './sync.js';

// ----- Backup config -----
const MAX_BACKUPS = 20;

// ----- Thumbnail config -----
const CAPTURE_DELAY = 2000;
const MIN_RECAPTURE = 5 * 60000;
const MAX_THUMBNAILS = 500;
const THUMB_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const THUMB_WIDTH = 400;
const THUMB_HEIGHT = 250;
const THUMB_QUALITY = 0.5;

// ===================================================================
// Auto-backup + sync alarms
// ===================================================================

chrome.alarms.create('auto-backup', { periodInMinutes: 5 });
chrome.alarms.create('sync-interval', { periodInMinutes: 15 });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'auto-backup') await createBackup('auto');
  if (alarm.name === 'thumb-cleanup') await cleanupThumbnails();
  if (alarm.name === 'sync-interval') {
    await initAuth();
    await initSync();
    if (await isSignedIn()) {
      try { await syncNow(); } catch {}
    }
  }
});

chrome.runtime.onStartup.addListener(async () => {
  createBackup('startup');
  chrome.alarms.create('thumb-cleanup', { periodInMinutes: 60 });
  // Init auth/sync on startup
  await initAuth();
  await initSync();
});

chrome.runtime.onInstalled.addListener(() => {
  createBackup('install');
  chrome.alarms.create('thumb-cleanup', { periodInMinutes: 60 });
});

// ===================================================================
// Message handler — newtab.js can request sync operations
// ===================================================================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'syncNow') {
    (async () => {
      await initAuth();
      await initSync();
      const result = await syncNow();
      sendResponse(result);
    })();
    return true; // async response
  }
});

// ===================================================================
// Auto-backup
// ===================================================================

async function createBackup(type = 'auto') {
  try {
    const [tabs, groups] = await Promise.all([
      chrome.tabs.query({}),
      chrome.tabGroups.query({})
    ]);

    const groupMap = {};
    groups.forEach(g => {
      groupMap[g.id] = { title: g.title || '', color: g.color, tabs: [] };
    });

    const ungrouped = [];
    let tabCount = 0;

    for (const tab of tabs) {
      if (isInternalUrl(tab.url)) continue;
      const entry = { title: tab.title || '', url: tab.url || '', favIconUrl: tab.favIconUrl || '', pinned: tab.pinned };
      tabCount++;
      if (tab.groupId !== -1 && groupMap[tab.groupId]) {
        groupMap[tab.groupId].tabs.push(entry);
      } else {
        ungrouped.push(entry);
      }
    }

    const backup = {
      timestamp: Date.now(),
      type,
      groups: Object.values(groupMap),
      ungrouped,
      tabCount,
      groupCount: groups.length
    };

    const { backups = [] } = await chrome.storage.local.get('backups');
    backups.unshift(backup);
    if (backups.length > MAX_BACKUPS) backups.length = MAX_BACKUPS;
    await chrome.storage.local.set({ backups, lastBackup: backup.timestamp });
  } catch (e) {
    console.error('Backup failed:', e);
  }
}

// ===================================================================
// Thumbnail capture
// ===================================================================

let captureTimer = null;

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  clearTimeout(captureTimer);
  captureTimer = setTimeout(() => captureTab(tabId, windowId), CAPTURE_DELAY);
});

chrome.tabs.onUpdated.addListener((tabId, changes, tab) => {
  if (changes.status === 'complete' && tab.active) {
    clearTimeout(captureTimer);
    captureTimer = setTimeout(() => captureTab(tabId, tab.windowId), 1500);
  }
});

async function captureTab(tabId, windowId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab || !tab.active || !tab.url || tab.status !== 'complete') return;
    if (isInternalUrl(tab.url)) return;

    const key = thumbKey(tab.url);
    const existing = await chrome.storage.local.get(key);
    if (existing[key] && (Date.now() - existing[key].ts) < MIN_RECAPTURE) return;

    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 60 });
    const thumbnail = await resizeThumbnail(dataUrl);
    await chrome.storage.local.set({ [key]: { data: thumbnail, ts: Date.now() } });
  } catch {}
}

async function resizeThumbnail(dataUrl) {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);

  const scale = Math.min(THUMB_WIDTH / bitmap.width, THUMB_HEIGHT / bitmap.height, 1);
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);

  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();

  const outBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: THUMB_QUALITY });
  return blobToDataUrl(outBlob);
}

async function blobToDataUrl(blob) {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const chunkSize = 8192;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return `data:${blob.type};base64,${btoa(binary)}`;
}

// ===================================================================
// Thumbnail cleanup
// ===================================================================

async function cleanupThumbnails() {
  try {
    const all = await chrome.storage.local.get(null);
    const thumbKeys = Object.keys(all).filter(k => k.startsWith('thumb:'));
    const now = Date.now();

    const expired = thumbKeys.filter(k => (now - (all[k]?.ts || 0)) > THUMB_MAX_AGE);
    if (expired.length > 0) await chrome.storage.local.remove(expired);

    const remaining = thumbKeys.filter(k => !expired.includes(k));
    if (remaining.length > MAX_THUMBNAILS) {
      remaining.sort((a, b) => (all[a]?.ts || 0) - (all[b]?.ts || 0));
      const excess = remaining.slice(0, remaining.length - MAX_THUMBNAILS);
      await chrome.storage.local.remove(excess);
    }
  } catch {}
}

// ===================================================================
// Utilities
// ===================================================================

function thumbKey(url) { return `thumb:${url}`; }

function isInternalUrl(url) {
  if (!url) return true;
  return url.startsWith('chrome://') || url.startsWith('edge://') ||
         url.startsWith('chrome-extension://') || url.startsWith('about:') || url.startsWith('data:');
}
