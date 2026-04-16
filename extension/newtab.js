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
  await loadTheme();
  await initAuth();
  await initSync();
  await loadActiveGroup();
  await loadData();
  setupSearch();
  setupKeyboard();
  setupBackup();
  setupSessions();
  setupSettings();
  setupSyncUI();
  loadBackupStatus();
  renderSyncUI();
  setInterval(loadBackupStatus, 30000);
});

// ===================================================================
// Data
// ===================================================================

async function loadData() {
  const [rawTabs, rawGroups] = await Promise.all([
    chrome.tabs.query({}),
    chrome.tabGroups.query({})
  ]);

  let currentTabId = null;
  try {
    const cur = await chrome.tabs.getCurrent();
    if (cur) currentTabId = cur.id;
  } catch {}

  tabs = rawTabs.filter(t => t.id !== currentTabId);
  groups = rawGroups;

  renderGroupTabs();
  renderTiles();
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
  groupTabsEl.innerHTML = '';

  // "All" tab
  const allCount = tabs.length;
  groupTabsEl.appendChild(buildGroupTab('all', 'All', allCount, null));

  // One tab per group
  const groupCounts = new Map();
  for (const tab of tabs) {
    if (tab.groupId !== -1) {
      groupCounts.set(tab.groupId, (groupCounts.get(tab.groupId) || 0) + 1);
    }
  }

  for (const g of groups) {
    const count = groupCounts.get(g.id) || 0;
    groupTabsEl.appendChild(buildGroupTab(g.id, g.title || 'Unnamed', count, g.color));
  }

  // Ungrouped tab (if any ungrouped tabs exist)
  const ungroupedCount = tabs.filter(t => t.groupId === -1).length;
  if (ungroupedCount > 0) {
    groupTabsEl.appendChild(buildGroupTab('ungrouped', 'Ungrouped', ungroupedCount, null));
  }
}

function buildGroupTab(id, name, count, color) {
  const btn = document.createElement('button');
  btn.className = 'group-tab';
  if (id === 'all' || !color) btn.classList.add('tab-all');
  if (id === activeGroupId) btn.classList.add('active');

  const hex = color ? (GROUP_COLORS[color] || GROUP_COLORS.grey) : '#4c4f62';
  btn.style.setProperty('--tab-color', hex);

  btn.innerHTML = `
    <span class="group-tab-dot" style="background:${hex}"></span>
    <span class="group-tab-name">${esc(name)}</span>
    <span class="group-tab-count">${count}</span>`;

  // Click → switch group view
  btn.addEventListener('click', () => {
    activeGroupId = id;
    saveActiveGroup();
    renderGroupTabs();
    renderTiles();
  });

  // Double-click → rename (only for real groups)
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
      if (newTitle && newTitle !== name) {
        try { await chrome.tabGroups.update(id, { title: newTitle }); } catch {}
      }
    });
    nameEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); nameEl.blur(); }
      if (e.key === 'Escape') { nameEl.textContent = name; nameEl.blur(); }
    });
  }

  return btn;
}

// ===================================================================
// Tile grid
// ===================================================================

async function renderTiles() {
  const visible = getVisibleTabs();
  tileGrid.innerHTML = '';

  if (visible.length === 0) {
    tileGrid.innerHTML = `
      <div class="empty-state">
        <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
          <rect x="4" y="4" width="32" height="32" rx="8" stroke="currentColor" stroke-width="1.5"/>
          <path d="M14 20h12M20 14v12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
        <p>${searchQuery ? 'No tabs match your search' : 'No tabs in this group'}</p>
      </div>`;
    updateStats(0);
    return;
  }

  // Load thumbnails for visible tabs
  await loadThumbnails(visible.map(t => t.url).filter(Boolean));

  visible.forEach((tab, i) => {
    const tile = buildTile(tab, i);
    tileGrid.appendChild(tile);
  });

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

function buildTile(tab, index) {
  const tile = document.createElement('div');
  tile.className = 'tile';
  if (tab.active) tile.classList.add('active');
  if (tab.pinned) tile.classList.add('pinned');
  tile.style.animationDelay = `${index * 30}ms`;

  const group = getGroupForTab(tab);
  const color = group ? (GROUP_COLORS[group.color] || GROUP_COLORS.grey) : '#4c4f62';
  tile.style.setProperty('--tile-color', color);

  let domain = '';
  try { domain = new URL(tab.url || '').hostname.replace(/^www\./, ''); } catch {}

  const favicon = tab.favIconUrl || faviconFor(tab.url);
  const letter = (domain[0] || '?').toUpperCase();
  const showBadge = activeGroupId === 'all' && group;
  const thumb = thumbnails[tab.url];

  const titleHtml = searchQuery ? highlight(tab.title || 'Untitled', searchQuery) : esc(tab.title || 'Untitled');
  const urlHtml = searchQuery ? highlight(domain, searchQuery) : esc(domain);

  // Visual area: screenshot thumbnail if available, otherwise large favicon
  let visualHtml;
  if (thumb) {
    visualHtml = `
      <img class="tile-thumb" src="${escAttr(thumb)}" alt="" loading="lazy">
      <img class="tile-favicon-badge" src="${escAttr(favicon)}" alt="" loading="lazy"
           onerror="this.style.display='none'">`;
  } else {
    visualHtml = `
      <img class="tile-favicon" src="${escAttr(favicon)}" alt="" loading="lazy"
           onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'tile-letter',textContent:'${letter}'}))">`;
  }

  tile.innerHTML = `
    ${showBadge ? `<div class="tile-group-badge" title="${esc(group.title || 'Unnamed')}"></div>` : ''}
    <button class="tile-close" title="Close tab">
      <svg width="12" height="12" viewBox="0 0 12 12">
        <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" fill="none" stroke-width="1.3" stroke-linecap="round"/>
      </svg>
    </button>
    <div class="tile-visual">${visualHtml}</div>
    <div class="tile-info" title="${escAttr(tab.title || '')}">
      <div class="tile-title">${titleHtml}</div>
      <div class="tile-url">${urlHtml}</div>
    </div>`;

  // Click → switch to tab
  tile.addEventListener('click', (e) => {
    if (e.target.closest('.tile-close')) return;
    switchToTab(tab.id, tab.windowId);
  });

  // Close
  tile.querySelector('.tile-close').addEventListener('click', (e) => {
    e.stopPropagation();
    closeTileTab(tab.id, tile);
  });

  return tile;
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
    renderGroupTabs();
    renderTiles();
  }, 180);
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
  if (backups.length > 20) backups.length = 20;
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
// Live updates
// ===================================================================

chrome.tabs.onCreated.addListener(() => loadData());
chrome.tabs.onRemoved.addListener((id) => {
  tabs = tabs.filter(t => t.id !== id);
  renderGroupTabs();
  renderTiles();
});
chrome.tabs.onUpdated.addListener((id, changes) => {
  const t = tabs.find(t => t.id === id);
  if (t) { Object.assign(t, changes); renderTiles(); }
});
chrome.tabs.onMoved.addListener(() => loadData());
chrome.tabs.onAttached.addListener(() => loadData());
chrome.tabs.onDetached.addListener(() => loadData());

if (chrome.tabGroups.onCreated)  chrome.tabGroups.onCreated.addListener(() => loadData());
if (chrome.tabGroups.onUpdated)  chrome.tabGroups.onUpdated.addListener(() => loadData());
if (chrome.tabGroups.onRemoved)  chrome.tabGroups.onRemoved.addListener(() => loadData());
if (chrome.tabGroups.onMoved)    chrome.tabGroups.onMoved.addListener(() => loadData());

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
