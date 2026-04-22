// ===================================================================
// Speed Dial — Tab Command Center v2
// ===================================================================

import { initAuth, signIn, signOut, isSignedIn, getUser } from './auth.js';
import { initSync, syncNow, getSyncStatus } from './sync.js';

// ----- State -----
let tabs = [];
let groups = [];
let searchQuery = '';
let activeGroupId = 'all'; // 'all' | group id number | 'ungrouped'
let thumbnails = {};        // url → data:image/jpeg;base64,...

// ----- Render caches (keyed DOM reuse, prevents flicker) -----
const tileNodes = new Map();      // tab.id → HTMLElement
const groupTabNodes = new Map();  // 'all' | number | 'ungrouped' → HTMLElement

// ----- Render scheduler (anti-flicker) -----
let renderFrame = null;
let fullReloadPending = false;
// Monotonic token: renderTiles() bails after its await if a newer render started.
let renderVersion = 0;

// Gate for the async tileCount skeleton re-render: once the initial boot has
// resolved (success or error) we must NEVER repaint skeletons, since that
// would clobber a retry-state error UI or a live tile grid.
let initialLoadPending = true;

// Chrome extension APIs should respond near-instantly. A hung query keeps the
// user staring at skeletons forever, so race against a timeout and surface the
// failure through the normal error path.
// Hook: tests may set globalThis.__SPEED_DIAL_TEST_LOAD_TIMEOUT_MS before the
// module loads to exercise the hung-query path without waiting 10 s.
const LOAD_TIMEOUT_MS =
  (typeof globalThis !== 'undefined' &&
   Number.isFinite(globalThis.__SPEED_DIAL_TEST_LOAD_TIMEOUT_MS))
    ? globalThis.__SPEED_DIAL_TEST_LOAD_TIMEOUT_MS
    : 10000;
function withTimeout(promise, ms, label) {
  let t;
  const timer = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timer]).finally(() => clearTimeout(t));
}

function scheduleRender(fullReload = false) {
  if (fullReload) fullReloadPending = true;
  if (renderFrame) return;
  renderFrame = requestAnimationFrame(async () => {
    renderFrame = null;
    try {
      if (fullReloadPending) {
        fullReloadPending = false;
        await loadData();
      } else {
        renderGroupTabs();
        await renderTiles();
      }
    } catch (e) {
      // Live-update reloads shouldn't take down the UI if the Chrome API
      // rejects or hangs (timeout). Log and keep the existing render intact.
      console.error('scheduleRender failed', e);
    }
  });
}

// ----- Constants -----
const GROUP_COLORS = {
  grey:   '#8b8fa3',
  blue:   '#5b9fff',
  red:    '#ff6363',
  yellow: '#ffc44a',
  green:  '#4adf7e',
  pink:   '#ff6eb4',
  purple: '#a78bfa',
  cyan:   '#22d3ee',
  orange: '#ff8a4a',
};

const FALLBACK_ICON = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">' +
  '<rect width="16" height="16" rx="3" fill="#252938"/>' +
  '<circle cx="8" cy="8" r="3" fill="#4c4f62"/></svg>'
)}`;

// ----- DOM refs -----
const $ = (s) => document.getElementById(s);
const tileGrid      = $('tile-grid');
const groupTabsEl   = $('group-tabs');
const searchInput   = $('search');
const statsEl       = $('stats');
const backupTimeEl  = $('backup-time');
const backupBtn     = $('backup-btn');
const sessionsCount = $('sessions-count');
const sessionsToggle= $('sessions-toggle');
const sessionsList  = $('sessions-list');
const settingsBtn      = $('settings-btn');
const settingsDropdown = $('settings-dropdown');
const themeToggle      = $('theme-toggle');
const syncSignedOut    = $('sync-signed-out');
const syncSignedIn     = $('sync-signed-in');
const googleSigninBtn  = $('google-signin-btn');
const syncAvatar       = $('sync-avatar');
const syncEmail        = $('sync-email');
const syncStatusText   = $('sync-status-text');
const syncNowBtn       = $('sync-now-btn');
const syncSignoutBtn   = $('sync-signout-btn');

// ===================================================================
// Init
// ===================================================================

document.addEventListener('DOMContentLoaded', async () => {
  // Paint skeletons immediately so the grid has shape while data loads.
  // Use cached count if we have it; otherwise a sensible default.
  renderSkeletons(DEFAULT_SKELETON_COUNT);
  chrome.storage.local.get('tileCount').then(({ tileCount }) => {
    // Guard against a late resolution after loadData has already finished
    // (success → tiles painted, or failure → error UI). Only repaint
    // skeletons while the initial boot is still pending.
    if (!initialLoadPending) return;
    if (typeof tileCount === 'number' && tileCount > 0 && tileNodes.size === 0) {
      renderSkeletons(tileCount);
    }
  }).catch(() => {});

  // Non-tab UI setup is isolated from tab-data failures so the page stays
  // interactive (search, keyboard, sessions, settings, sync) even if tabs
  // fail to load.
  const safeInit = async (name, fn) => {
    try { await fn(); } catch (e) { console.error(`init: ${name} failed`, e); }
  };
  await safeInit('loadTheme', loadTheme);
  await safeInit('initAuth', initAuth);
  await safeInit('initSync', initSync);
  await safeInit('loadActiveGroup', loadActiveGroup);

  setupSearch();
  setupKeyboard();
  setupBackup();
  setupSessions();
  setupSettings();
  setupSyncUI();
  loadBackupStatus();
  renderSyncUI();
  setInterval(loadBackupStatus, 30000);

  // Load tab data. On failure, replace skeletons with a retryable error state
  // rather than leaving the shimmer running forever.
  try {
    await loadData();
  } catch (e) {
    console.error('loadData failed', e);
    showLoadError(e);
  } finally {
    initialLoadPending = false;
  }
});

function showLoadError(err) {
  tileNodes.clear();
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="empty-state">
      <svg width="40" height="40" viewBox="0 0 40 40" fill="none" aria-hidden="true">
        <circle cx="20" cy="20" r="16" stroke="currentColor" stroke-width="1.5"/>
        <path d="M20 13v9M20 26v0.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      </svg>
      <p>Couldn't load tabs${err?.message ? ` — ${esc(err.message)}` : ''}.</p>
      <button class="reload-btn" type="button">Retry</button>
    </div>`;
  const node = wrap.firstElementChild;
  tileGrid.replaceChildren(node);
  node.querySelector('.reload-btn').addEventListener('click', async () => {
    renderSkeletons(DEFAULT_SKELETON_COUNT);
    try { await loadData(); } catch (e) { showLoadError(e); }
  });
  updateStats(0);
}

// ===================================================================
// Skeleton placeholders
// ===================================================================

const DEFAULT_SKELETON_COUNT = 12;
const MAX_SKELETON_COUNT = 48;

function renderSkeletons(count) {
  const n = Math.max(1, Math.min(MAX_SKELETON_COUNT, count | 0));
  const frag = document.createDocumentFragment();
  for (let i = 0; i < n; i++) {
    const card = document.createElement('div');
    card.className = 'tile-skeleton';
    card.innerHTML = `
      <div class="tile-skeleton-visual"></div>
      <div class="tile-skeleton-info">
        <div class="tile-skeleton-line"></div>
        <div class="tile-skeleton-line"></div>
      </div>`;
    frag.appendChild(card);
  }
  tileGrid.replaceChildren(frag);
}

// ===================================================================
// Data
// ===================================================================

async function loadData() {
  const [rawTabs, rawGroups] = await Promise.all([
    withTimeout(chrome.tabs.query({}), LOAD_TIMEOUT_MS, 'chrome.tabs.query'),
    withTimeout(chrome.tabGroups.query({}), LOAD_TIMEOUT_MS, 'chrome.tabGroups.query')
  ]);

  let currentTabId = null;
  try {
    const cur = await chrome.tabs.getCurrent();
    if (cur) currentTabId = cur.id;
  } catch {}

  tabs = rawTabs.filter(t => t.id !== currentTabId);
  groups = rawGroups;

  renderGroupTabs();
  await renderTiles();
}

function getVisibleTabs() {
  const q = searchQuery;
  let filtered = tabs;

  // Search filter
  if (q) {
    filtered = filtered.filter(tab => {
      const t = (tab.title || '').toLowerCase();
      const u = (tab.url   || '').toLowerCase();
      return t.includes(q) || u.includes(q);
    });
  }

  // Group filter
  if (activeGroupId === 'all') {
    return filtered;
  } else if (activeGroupId === 'ungrouped') {
    return filtered.filter(t => t.groupId === -1);
  } else {
    return filtered.filter(t => t.groupId === activeGroupId);
  }
}

function getGroupForTab(tab) {
  return groups.find(g => g.id === tab.groupId) || null;
}

// ===================================================================
// Group tab bar
// ===================================================================

function renderGroupTabs() {
  // Build desired entries: [{id, name, count, color}]
  const entries = [];
  entries.push({ id: 'all', name: 'All', count: tabs.length, color: null });

  const groupCounts = new Map();
  for (const tab of tabs) {
    if (tab.groupId !== -1) {
      groupCounts.set(tab.groupId, (groupCounts.get(tab.groupId) || 0) + 1);
    }
  }
  for (const g of groups) {
    entries.push({ id: g.id, name: g.title || 'Unnamed', count: groupCounts.get(g.id) || 0, color: g.color });
  }

  const ungroupedCount = tabs.filter(t => t.groupId === -1).length;
  if (ungroupedCount > 0) {
    entries.push({ id: 'ungrouped', name: 'Ungrouped', count: ungroupedCount, color: null });
  }

  const wantIds = new Set(entries.map(e => e.id));

  // Remove gone nodes
  for (const [id, node] of groupTabNodes) {
    if (!wantIds.has(id)) {
      node.remove();
      groupTabNodes.delete(id);
    }
  }

  // Upsert + reorder
  for (const e of entries) {
    let node = groupTabNodes.get(e.id);
    if (!node) {
      node = createGroupTabSkeleton(e.id);
      groupTabNodes.set(e.id, node);
    }
    updateGroupTab(node, e);
    groupTabsEl.appendChild(node); // appending an existing child reorders, no anim replay
  }
}

function createGroupTabSkeleton(id) {
  const btn = document.createElement('button');
  btn.className = 'group-tab';
  btn._gid = id;
  btn.innerHTML = `
    <span class="group-tab-dot"></span>
    <span class="group-tab-name"></span>
    <span class="group-tab-count"></span>`;

  btn.addEventListener('click', () => {
    const gid = btn._gid;
    if (gid === activeGroupId) return;
    activeGroupId = gid;
    saveActiveGroup();
    renderGroupTabs();
    renderTiles();
  });

  if (typeof id === 'number') {
    const nameEl = btn.querySelector('.group-tab-name');
    nameEl.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      nameEl.contentEditable = 'true';
      nameEl.focus();
      const range = document.createRange();
      range.selectNodeContents(nameEl);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    });
    nameEl.addEventListener('blur', async () => {
      nameEl.contentEditable = 'false';
      const newTitle = nameEl.textContent.trim();
      const original = btn._origName || '';
      if (newTitle && newTitle !== original) {
        try { await chrome.tabGroups.update(id, { title: newTitle }); } catch {}
      }
    });
    nameEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); nameEl.blur(); }
      if (e.key === 'Escape') { nameEl.textContent = btn._origName || ''; nameEl.blur(); }
    });
  }

  return btn;
}

function updateGroupTab(btn, entry) {
  const { id, name, count, color } = entry;
  const isAll = id === 'all' || !color;
  btn.classList.toggle('tab-all', isAll);
  btn.classList.toggle('active', id === activeGroupId);

  const hex = color ? (GROUP_COLORS[color] || GROUP_COLORS.grey) : '#4c4f62';
  btn.style.setProperty('--tab-color', hex);

  const dot = btn.querySelector('.group-tab-dot');
  if (dot.style.background !== hex) dot.style.background = hex;

  const nameEl = btn.querySelector('.group-tab-name');
  if (!nameEl.isContentEditable && nameEl.textContent !== name) nameEl.textContent = name;
  btn._origName = name;

  const countEl = btn.querySelector('.group-tab-count');
  const countStr = String(count);
  if (countEl.textContent !== countStr) countEl.textContent = countStr;
}

// ===================================================================
// Tile grid
// ===================================================================

async function renderTiles() {
  const myVersion = ++renderVersion;
  const visible = getVisibleTabs();

  if (visible.length === 0) {
    tileNodes.clear();
    const empty = document.createElement('div');
    empty.innerHTML = `
      <div class="empty-state">
        <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
          <rect x="4" y="4" width="32" height="32" rx="8" stroke="currentColor" stroke-width="1.5"/>
          <path d="M14 20h12M20 14v12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
        <p>${searchQuery ? 'No tabs match your search' : 'No tabs in this group'}</p>
      </div>`;
    tileGrid.replaceChildren(empty.firstElementChild);
    updateStats(0);
    return;
  }

  // Load thumbnails before touching the DOM so a stale render can bail cleanly.
  await loadThumbnails(visible.map(t => t.url).filter(Boolean));
  if (myVersion !== renderVersion) return; // newer render started; abandon

  // Clear any non-tile children (skeleton placeholders, prior .empty-state)
  for (const child of [...tileGrid.children]) {
    if (!child.classList.contains('tile')) child.remove();
  }

  // Cache the count so next cold load can paint the right number of skeletons
  chrome.storage.local.set({ tileCount: visible.length }).catch(() => {});

  const wantIds = new Set(visible.map(t => t.id));

  // Remove tiles for tabs no longer visible
  for (const [id, node] of tileNodes) {
    if (!wantIds.has(id)) {
      node.remove();
      tileNodes.delete(id);
    }
  }

  // Upsert + reorder. Stagger entrance animation only for brand-new tiles.
  let newCount = 0;
  for (const tab of visible) {
    let tile = tileNodes.get(tab.id);
    if (!tile) {
      tile = createTileSkeleton();
      tile.style.animationDelay = `${newCount * 30}ms`;
      newCount++;
      tileNodes.set(tab.id, tile);
    }
    updateTile(tile, tab);
    tileGrid.appendChild(tile); // move-into-order; no animation replay for existing nodes
  }

  updateStats(visible.length);
}

async function loadThumbnails(urls) {
  const keys = urls.map(u => `thumb:${u}`);
  try {
    const data = await chrome.storage.local.get(keys);
    thumbnails = {};
    for (const [key, val] of Object.entries(data)) {
      if (val?.data) thumbnails[key.replace('thumb:', '')] = val.data;
    }
  } catch {
    thumbnails = {};
  }
}

function createTileSkeleton() {
  const tile = document.createElement('div');
  tile.className = 'tile';
  tile.innerHTML = `
    <div class="tile-actions-overlay">
      <button class="tile-action-btn tile-retake" title="Retake screenshot">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path d="M1 4.5V2.5a1 1 0 011-1h1.5M11 7.5v2a1 1 0 01-1 1H8.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
          <circle cx="6" cy="6" r="2.5" stroke="currentColor" stroke-width="1.2"/>
        </svg>
      </button>
      <button class="tile-action-btn tile-close" title="Close tab">
        <svg width="12" height="12" viewBox="0 0 12 12">
          <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" fill="none" stroke-width="1.3" stroke-linecap="round"/>
        </svg>
      </button>
    </div>
    <div class="tile-visual"></div>
    <div class="tile-info">
      <div class="tile-title"></div>
      <div class="tile-url"></div>
    </div>`;

  // Handlers attached once; read live tab from tile._tab.
  tile.addEventListener('click', (e) => {
    if (e.target.closest('.tile-action-btn')) return;
    const t = tile._tab;
    if (t) switchToTab(t.id, t.windowId);
  });
  tile.querySelector('.tile-close').addEventListener('click', (e) => {
    e.stopPropagation();
    const t = tile._tab;
    if (t) closeTileTab(t.id, tile);
  });
  tile.querySelector('.tile-retake').addEventListener('click', (e) => {
    e.stopPropagation();
    const t = tile._tab;
    if (t) retakeScreenshot(t);
  });

  return tile;
}

function updateTile(tile, tab) {
  tile._tab = tab;
  tile.classList.toggle('active', !!tab.active);
  tile.classList.toggle('pinned', !!tab.pinned);

  const group = getGroupForTab(tab);
  const color = group ? (GROUP_COLORS[group.color] || GROUP_COLORS.grey) : '#4c4f62';
  tile.style.setProperty('--tile-color', color);

  let domain = '';
  try { domain = new URL(tab.url || '').hostname.replace(/^www\./, ''); } catch {}

  const favicon = faviconFor(tab.url) || tab.favIconUrl;
  const letter = (domain[0] || '?').toUpperCase();
  const showBadge = activeGroupId === 'all' && !!group;
  const thumb = thumbnails[tab.url];

  // Group badge — add/remove from DOM so counts reflect visible badges only
  let badge = tile.querySelector('.tile-group-badge');
  if (showBadge) {
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'tile-group-badge';
      tile.insertBefore(badge, tile.firstChild);
    }
    const badgeTitle = group.title || 'Unnamed';
    if (badge.title !== badgeTitle) badge.title = badgeTitle;
  } else if (badge) {
    badge.remove();
  }

  // Title/URL (with optional search highlight)
  const titleEl = tile.querySelector('.tile-title');
  const urlEl = tile.querySelector('.tile-url');
  const infoEl = tile.querySelector('.tile-info');
  const titleHtml = searchQuery ? highlight(tab.title || 'Untitled', searchQuery) : esc(tab.title || 'Untitled');
  const urlHtml = searchQuery ? highlight(domain, searchQuery) : esc(domain);
  if (titleEl.innerHTML !== titleHtml) titleEl.innerHTML = titleHtml;
  if (urlEl.innerHTML !== urlHtml) urlEl.innerHTML = urlHtml;
  const infoTitle = tab.title || '';
  if (infoEl.title !== infoTitle) infoEl.title = infoTitle;

  // Visual area: thumb vs favicon. Only rebuild when mode changes.
  const visual = tile.querySelector('.tile-visual');
  const wantMode = thumb ? 'thumb' : 'favicon';
  const prevMode = visual.dataset.mode;

  if (prevMode !== wantMode) {
    visual.dataset.mode = wantMode;
    if (wantMode === 'thumb') {
      visual.innerHTML = `
        <img class="tile-thumb" alt="">
        <img class="tile-favicon-badge" alt="">`;
      const thumbImg = visual.querySelector('.tile-thumb');
      const badgeImg = visual.querySelector('.tile-favicon-badge');
      thumbImg.src = thumb;
      badgeImg.src = favicon;
      attachBadgeErrorHandlers(badgeImg);
      visual.dataset.thumbSrc = thumb;
      visual.dataset.faviconSrc = favicon;
    } else {
      visual.innerHTML = `<img class="tile-favicon" alt="">`;
      const favImg = visual.querySelector('.tile-favicon');
      favImg.dataset.letter = letter;
      favImg.src = favicon;
      attachFaviconErrorHandlers(favImg);
      visual.dataset.faviconSrc = favicon;
      delete visual.dataset.thumbSrc;
    }
  } else if (wantMode === 'thumb') {
    const thumbImg = visual.querySelector('.tile-thumb');
    const badgeImg = visual.querySelector('.tile-favicon-badge');
    if (thumbImg && visual.dataset.thumbSrc !== thumb) {
      thumbImg.src = thumb;
      visual.dataset.thumbSrc = thumb;
    }
    if (badgeImg && visual.dataset.faviconSrc !== favicon) {
      badgeImg.src = favicon;
      badgeImg.style.display = '';
      attachBadgeErrorHandlers(badgeImg);
      visual.dataset.faviconSrc = favicon;
    }
  } else {
    // favicon mode. On URL change, rebuild the <img> so a previously-failed
    // favicon (now showing .tile-letter) gets another attempt with the new URL.
    // Rebuilding also gives us a fresh element for the { once: true } handlers.
    const faviconChanged = visual.dataset.faviconSrc !== favicon;
    if (faviconChanged) {
      visual.innerHTML = `<img class="tile-favicon" alt="">`;
      const favImg = visual.querySelector('.tile-favicon');
      favImg.dataset.letter = letter;
      favImg.src = favicon;
      attachFaviconErrorHandlers(favImg);
      visual.dataset.faviconSrc = favicon;
    } else {
      const favImg = visual.querySelector('.tile-favicon');
      if (favImg) {
        favImg.dataset.letter = letter;
      } else {
        // Currently showing .tile-letter fallback with same URL; update glyph if domain changed
        const letterEl = visual.querySelector('.tile-letter');
        if (letterEl && letterEl.textContent !== letter) letterEl.textContent = letter;
      }
    }
  }
}

function attachFaviconErrorHandlers(favImg) {
  const swapToLetter = () => {
    const letterDiv = document.createElement('div');
    letterDiv.className = 'tile-letter';
    letterDiv.textContent = favImg.dataset.letter || '?';
    favImg.replaceWith(letterDiv);
  };
  favImg.addEventListener('error', swapToLetter, { once: true });
  favImg.addEventListener('load', () => {
    if (favImg.naturalWidth === 0) swapToLetter();
  }, { once: true });
}

function attachBadgeErrorHandlers(badgeImg) {
  badgeImg.addEventListener('error', () => { badgeImg.style.display = 'none'; }, { once: true });
  badgeImg.addEventListener('load', () => {
    if (badgeImg.naturalWidth === 0) badgeImg.style.display = 'none';
  }, { once: true });
}

// ===================================================================
// Actions
// ===================================================================

async function switchToTab(tabId, windowId) {
  try {
    await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(windowId, { focused: true });
  } catch {}
}

async function closeTileTab(tabId, tileEl) {
  tileEl.style.transition = 'all 0.2s ease';
  tileEl.style.opacity = '0';
  tileEl.style.transform = 'scale(0.9)';

  setTimeout(async () => {
    try { await chrome.tabs.remove(tabId); } catch {}
    tabs = tabs.filter(t => t.id !== tabId);
    scheduleRender();
  }, 180);
}

async function retakeScreenshot(tab) {
  // Delete cached thumbnail so it falls back to favicon immediately
  const key = `thumb:${tab.url}`;
  await chrome.storage.local.remove(key);
  delete thumbnails[tab.url];

  // Switch to the tab — background's onActivated handler will capture it
  await switchToTab(tab.id, tab.windowId);

  toast('Switched to tab — screenshot will update');
}

// ===================================================================
// Search
// ===================================================================

function setupSearch() {
  let timer;
  searchInput.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      searchQuery = searchInput.value.trim().toLowerCase();
      renderTiles();
    }, 80);
  });
}

// ===================================================================
// Keyboard
// ===================================================================

function setupKeyboard() {
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== searchInput && !isEditing()) {
      e.preventDefault();
      searchInput.focus();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      searchInput.focus();
    }
    if (e.key === 'Escape') {
      searchInput.value = '';
      searchQuery = '';
      searchInput.blur();
      renderTiles();
    }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'b') {
      e.preventDefault();
      manualBackup();
    }
    // Left/right arrow to switch group tabs when not in input
    if (!isEditing() && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      const ids = getGroupTabIds();
      const curIdx = ids.indexOf(activeGroupId);
      if (curIdx === -1) return;
      const next = e.key === 'ArrowRight'
        ? ids[Math.min(curIdx + 1, ids.length - 1)]
        : ids[Math.max(curIdx - 1, 0)];
      if (next !== activeGroupId) {
        activeGroupId = next;
        saveActiveGroup();
        renderGroupTabs();
        renderTiles();
      }
    }
  });
}

function getGroupTabIds() {
  const ids = ['all'];
  for (const g of groups) ids.push(g.id);
  if (tabs.some(t => t.groupId === -1)) ids.push('ungrouped');
  return ids;
}

function isEditing() {
  const el = document.activeElement;
  return el && (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
}

// ===================================================================
// Backup
// ===================================================================

function setupBackup() {
  backupBtn.addEventListener('click', manualBackup);
}

async function manualBackup() {
  backupBtn.classList.add('saving');

  const [allTabs, allGroups] = await Promise.all([
    chrome.tabs.query({}),
    chrome.tabGroups.query({})
  ]);

  const gMap = {};
  allGroups.forEach(g => { gMap[g.id] = { title: g.title || '', color: g.color, tabs: [] }; });

  const ung = [];
  let count = 0;

  for (const tab of allTabs) {
    if (isInternal(tab.url)) continue;
    const entry = { title: tab.title || '', url: tab.url || '', favIconUrl: tab.favIconUrl || '', pinned: tab.pinned };
    count++;
    if (tab.groupId !== -1 && gMap[tab.groupId]) {
      gMap[tab.groupId].tabs.push(entry);
    } else {
      ung.push(entry);
    }
  }

  const backup = {
    timestamp: Date.now(),
    type: 'manual',
    groups: Object.values(gMap),
    ungrouped: ung,
    tabCount: count,
    groupCount: allGroups.length
  };

  const { backups = [] } = await chrome.storage.local.get('backups');
  backups.unshift(backup);
  if (backups.length > 100) backups.length = 100;
  await chrome.storage.local.set({ backups, lastBackup: backup.timestamp });

  setTimeout(() => backupBtn.classList.remove('saving'), 500);
  loadBackupStatus();
  if (sessionsList.classList.contains('open')) loadSessions();
  toast('Snapshot saved');
}

async function loadBackupStatus() {
  const { lastBackup } = await chrome.storage.local.get('lastBackup');
  backupTimeEl.textContent = lastBackup ? timeAgo(lastBackup) : 'no backups';
}

// ===================================================================
// Sessions
// ===================================================================

function setupSessions() {
  sessionsToggle.addEventListener('click', () => {
    sessionsList.classList.toggle('open');
    if (sessionsList.classList.contains('open')) loadSessions();
  });
}

async function loadSessions() {
  const { backups = [] } = await chrome.storage.local.get('backups');
  sessionsCount.textContent = backups.length;

  if (backups.length === 0) {
    sessionsList.innerHTML = '<div class="empty-state" style="padding:20px"><p>No saved sessions</p></div>';
    return;
  }

  sessionsList.innerHTML = backups.map((b, i) => `
    <div class="session-item">
      <div class="session-meta">
        <span class="session-time">${fmtDate(b.timestamp)}</span>
        <span class="session-stats">${b.tabCount} tabs · ${b.groupCount} groups</span>
      </div>
      <div class="session-right">
        <span class="session-type">${esc(b.type)}</span>
        <button class="session-restore" data-idx="${i}">Restore</button>
        <button class="session-delete" data-idx="${i}">×</button>
      </div>
    </div>`).join('');

  sessionsList.querySelectorAll('.session-restore').forEach(btn =>
    btn.addEventListener('click', () => restoreSession(+btn.dataset.idx)));
  sessionsList.querySelectorAll('.session-delete').forEach(btn =>
    btn.addEventListener('click', () => deleteSession(+btn.dataset.idx)));
}

async function restoreSession(idx) {
  const { backups = [] } = await chrome.storage.local.get('backups');
  const b = backups[idx];
  if (!b) return;

  for (const t of b.ungrouped) {
    await chrome.tabs.create({ url: t.url, pinned: t.pinned });
  }

  for (const g of b.groups) {
    if (g.tabs.length === 0) continue;
    const ids = [];
    for (const t of g.tabs) {
      const created = await chrome.tabs.create({ url: t.url, pinned: t.pinned });
      ids.push(created.id);
    }
    try {
      const gid = await chrome.tabs.group({ tabIds: ids });
      await chrome.tabGroups.update(gid, { title: g.title, color: g.color });
    } catch {}
  }

  toast(`Restored ${b.tabCount} tabs`);
  setTimeout(loadData, 500);
}

async function deleteSession(idx) {
  const { backups = [] } = await chrome.storage.local.get('backups');
  backups.splice(idx, 1);
  await chrome.storage.local.set({ backups });
  loadSessions();
  loadBackupStatus();
}

// ===================================================================
// Stats
// ===================================================================

function updateStats(visibleCount) {
  const totalTabs = tabs.length;
  const wins = new Set(tabs.map(t => t.windowId)).size;
  const p = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  statsEl.innerHTML =
    `<span><span class="stat-value">${visibleCount}</span>` +
    `${visibleCount !== totalTabs ? ` / ${totalTabs}` : ''} tabs</span>` +
    `<span><span class="stat-value">${groups.length}</span> ${groups.length === 1 ? 'group' : 'groups'}</span>` +
    `<span><span class="stat-value">${wins}</span> ${wins === 1 ? 'window' : 'windows'}</span>`;
}

// ===================================================================
// Active group persistence
// ===================================================================

async function loadActiveGroup() {
  try {
    const { activeGroup } = await chrome.storage.local.get('activeGroup');
    if (activeGroup !== undefined) activeGroupId = activeGroup;
  } catch {}
}

async function saveActiveGroup() {
  await chrome.storage.local.set({ activeGroup: activeGroupId });
}

// ===================================================================
// Settings
// ===================================================================

function setupSettings() {
  settingsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    settingsDropdown.classList.toggle('open');
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.settings-wrap')) {
      settingsDropdown.classList.remove('open');
    }
  });

  themeToggle.addEventListener('change', () => {
    const theme = themeToggle.checked ? 'light' : 'dark';
    applyTheme(theme);
    chrome.storage.local.set({ theme });
  });
}

async function loadTheme() {
  try {
    const { theme } = await chrome.storage.local.get('theme');
    applyTheme(theme || 'dark');
  } catch {
    applyTheme('dark');
  }
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  themeToggle.checked = theme === 'light';
}

// ===================================================================
// Sync UI
// ===================================================================

function setupSyncUI() {
  googleSigninBtn.addEventListener('click', async () => {
    try {
      googleSigninBtn.disabled = true;
      googleSigninBtn.textContent = 'Signing in...';
      await signIn();
      await renderSyncUI();
      // Trigger initial sync
      syncNowBtn.classList.add('spinning');
      syncStatusText.textContent = 'Syncing...';
      const result = await syncNow();
      syncNowBtn.classList.remove('spinning');
      syncStatusText.textContent = result.ok ? 'Synced just now' : `Error: ${result.reason}`;
      if (result.ok) {
        loadSessions();
        loadTheme();
      }
      toast(result.ok ? 'Signed in and synced' : 'Signed in, sync failed');
    } catch (e) {
      toast(`Sign in failed: ${e.message}`);
    } finally {
      googleSigninBtn.disabled = false;
      googleSigninBtn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 48 48"><path fill="#4285F4" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#34A853" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59A14.5 14.5 0 019.5 24c0-1.59.28-3.14.76-4.59l-7.98-6.19A23.99 23.99 0 000 24c0 3.77.9 7.35 2.56 10.52l7.97-5.93z"/><path fill="#EA4335" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 5.93C6.51 42.62 14.62 48 24 48z"/></svg>
        Sign in`;
    }
  });

  syncNowBtn.addEventListener('click', async () => {
    syncNowBtn.classList.add('spinning');
    syncStatusText.textContent = 'Syncing...';
    const result = await syncNow();
    syncNowBtn.classList.remove('spinning');
    if (result.ok) {
      syncStatusText.textContent = 'Synced just now';
      loadSessions();
    } else {
      syncStatusText.textContent = `Error: ${result.reason}`;
    }
  });

  syncSignoutBtn.addEventListener('click', async () => {
    await signOut();
    renderSyncUI();
    toast('Signed out');
  });
}

async function renderSyncUI() {
  const signedIn = await isSignedIn();

  if (signedIn) {
    const user = await getUser();
    const status = await getSyncStatus();

    syncSignedOut.style.display = 'none';
    syncSignedIn.style.display = 'flex';

    if (user) {
      syncAvatar.src = user.picture || '';
      syncAvatar.style.display = user.picture ? 'block' : 'none';
      syncEmail.textContent = user.email || user.name || 'Signed in';
    }

    if (status.lastSync) {
      syncStatusText.textContent = `Synced ${timeAgo(status.lastSync)}`;
    } else {
      syncStatusText.textContent = status.configured ? 'Not synced yet' : 'API not configured';
    }
  } else {
    syncSignedOut.style.display = 'flex';
    syncSignedIn.style.display = 'none';
  }
}

// ===================================================================
// Live updates — debounced to prevent flicker
//
// Source of truth: the BROWSER is always primary.
// This extension is a read-only view + management layer.
// We never maintain our own tab state — we read from chrome.tabs.
// Backups are historical snapshots. Restore creates new tabs.
// ===================================================================

chrome.tabs.onCreated.addListener(() => scheduleRender(true));

chrome.tabs.onRemoved.addListener((id) => {
  tabs = tabs.filter(t => t.id !== id);
  scheduleRender();
});

// Only re-render if something the user can see changed
chrome.tabs.onUpdated.addListener((id, changes) => {
  const t = tabs.find(t => t.id === id);
  if (!t) return;
  const visible = changes.title !== undefined || changes.url !== undefined ||
                  changes.favIconUrl !== undefined || changes.status !== undefined ||
                  changes.pinned !== undefined || changes.groupId !== undefined;
  if (visible) {
    Object.assign(t, changes);
    scheduleRender();
  }
});

chrome.tabs.onMoved.addListener(() => scheduleRender(true));
chrome.tabs.onAttached.addListener(() => scheduleRender(true));
chrome.tabs.onDetached.addListener(() => scheduleRender(true));

if (chrome.tabGroups.onCreated)  chrome.tabGroups.onCreated.addListener(() => scheduleRender(true));
if (chrome.tabGroups.onUpdated)  chrome.tabGroups.onUpdated.addListener(() => scheduleRender(true));
if (chrome.tabGroups.onRemoved)  chrome.tabGroups.onRemoved.addListener(() => scheduleRender(true));
if (chrome.tabGroups.onMoved)    chrome.tabGroups.onMoved.addListener(() => scheduleRender(true));

// ===================================================================
// Utilities
// ===================================================================

function esc(str) {
  const el = document.createElement('span');
  el.textContent = str;
  return el.innerHTML;
}

function escAttr(str) {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;');
}

function faviconFor(url) {
  try {
    return `chrome-extension://${chrome.runtime.id}/_favicon/?pageUrl=${encodeURIComponent(url)}&size=32`;
  } catch {
    return FALLBACK_ICON;
  }
}

function highlight(text, query) {
  const safe = esc(text);
  const q = esc(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return safe.replace(new RegExp(`(${q})`, 'gi'), '<mark>$1</mark>');
}

function isInternal(url) {
  if (!url) return true;
  return url.startsWith('chrome://') || url.startsWith('edge://') || url.startsWith('chrome-extension://') || url.startsWith('about:');
}

function timeAgo(ts) {
  const d = Date.now() - ts;
  const m = Math.floor(d / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function fmtDate(ts) {
  return new Date(ts).toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false
  });
}

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 200);
  }, 2000);
}
