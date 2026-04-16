// ===================================================================
// Speed Dial — Tab Command Center
// ===================================================================

// ----- State -----
let tabs = [];
let groups = [];
let searchQuery = '';
let collapsedGroups = new Set();

// ----- Constants -----
const GROUP_COLORS = {
  grey:   { hex: '#8b8fa3' },
  blue:   { hex: '#5b9fff' },
  red:    { hex: '#ff6363' },
  yellow: { hex: '#ffc44a' },
  green:  { hex: '#4adf7e' },
  pink:   { hex: '#ff6eb4' },
  purple: { hex: '#a78bfa' },
  cyan:   { hex: '#22d3ee' },
  orange: { hex: '#ff8a4a' },
};

const FALLBACK_ICON = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">' +
  '<rect width="16" height="16" rx="3" fill="#252938"/>' +
  '<circle cx="8" cy="8" r="3" fill="#4c4f62"/>' +
  '</svg>'
)}`;

// ----- DOM refs -----
const $ = (s) => document.getElementById(s);
const grid          = $('grid');
const searchInput   = $('search');
const statsEl       = $('stats');
const backupTimeEl  = $('backup-time');
const backupBtn     = $('backup-btn');
const sessionsCount = $('sessions-count');
const sessionsToggle= $('sessions-toggle');
const sessionsList  = $('sessions-list');

// ===================================================================
// Init
// ===================================================================

document.addEventListener('DOMContentLoaded', async () => {
  await loadCollapsedState();
  await loadData();
  setupSearch();
  setupKeyboard();
  setupBackup();
  setupSessions();
  loadBackupStatus();

  // Refresh backup time display every 30s
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

  // Exclude the current new-tab page from the list
  let currentTabId = null;
  try {
    const cur = await chrome.tabs.getCurrent();
    if (cur) currentTabId = cur.id;
  } catch {}

  tabs = rawTabs.filter(t => t.id !== currentTabId);
  groups = rawGroups;
  render();
}

function organizeByGroup() {
  const map = new Map();
  groups.forEach(g => map.set(g.id, { ...g, tabs: [] }));

  const ungrouped = [];
  const q = searchQuery;

  for (const tab of tabs) {
    if (q) {
      const t = (tab.title || '').toLowerCase();
      const u = (tab.url   || '').toLowerCase();
      if (!t.includes(q) && !u.includes(q)) continue;
    }
    if (tab.groupId !== -1 && map.has(tab.groupId)) {
      map.get(tab.groupId).tabs.push(tab);
    } else {
      ungrouped.push(tab);
    }
  }

  // When searching, hide empty groups
  const organized = q
    ? [...map.values()].filter(g => g.tabs.length > 0)
    : [...map.values()];

  return { groups: organized, ungrouped };
}

// ===================================================================
// Render
// ===================================================================

function render() {
  const { groups: gList, ungrouped } = organizeByGroup();
  grid.innerHTML = '';

  if (gList.length === 0 && ungrouped.length === 0) {
    grid.innerHTML = `
      <div class="empty-state">
        <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
          <rect x="4" y="4" width="32" height="32" rx="8" stroke="currentColor" stroke-width="1.5"/>
          <path d="M14 20h12M20 14v12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
        <p>${searchQuery ? 'No tabs match your search' : 'No open tabs'}</p>
      </div>`;
    updateStats(0, 0);
    return;
  }

  let total = 0;

  gList.forEach((g, i) => {
    grid.appendChild(buildGroupCol(g, i));
    total += g.tabs.length;
  });

  if (ungrouped.length > 0) {
    grid.appendChild(buildUngroupedCol(ungrouped, gList.length));
    total += ungrouped.length;
  }

  updateStats(total, gList.length);
}

// ----- Group column -----

function buildGroupCol(group, idx) {
  const col = document.createElement('div');
  col.className = 'group-column';
  col.style.animationDelay = `${idx * 55}ms`;

  const gc = GROUP_COLORS[group.color] || GROUP_COLORS.grey;
  col.style.setProperty('--group-color', gc.hex);

  const collapsed = collapsedGroups.has(group.id);

  // Header
  const hdr = document.createElement('div');
  hdr.innerHTML = `<div class="group-color-bar"></div>`;

  const header = document.createElement('div');
  header.className = 'group-header';
  header.innerHTML = `
    <div class="group-info">
      <span class="group-title">${esc(group.title || 'Unnamed')}</span>
      <span class="group-count">${group.tabs.length}</span>
    </div>
    <button class="group-collapse ${collapsed ? 'collapsed' : ''}">
      <svg width="12" height="12" viewBox="0 0 12 12">
        <path d="M3 4.5l3 3 3-3" stroke="currentColor" fill="none" stroke-width="1.5" stroke-linecap="round"/>
      </svg>
    </button>`;

  col.appendChild(hdr.firstElementChild); // color bar
  col.appendChild(header);

  // Collapse toggle
  header.querySelector('.group-collapse').addEventListener('click', () => {
    collapsedGroups.has(group.id) ? collapsedGroups.delete(group.id) : collapsedGroups.add(group.id);
    saveCollapsedState();
    render();
  });

  // Rename on double-click
  const titleEl = header.querySelector('.group-title');
  titleEl.addEventListener('dblclick', () => {
    titleEl.contentEditable = 'true';
    titleEl.focus();
    const range = document.createRange();
    range.selectNodeContents(titleEl);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  });
  titleEl.addEventListener('blur', async () => {
    titleEl.contentEditable = 'false';
    const newTitle = titleEl.textContent.trim();
    if (newTitle && newTitle !== (group.title || 'Unnamed')) {
      try { await chrome.tabGroups.update(group.id, { title: newTitle }); } catch {}
    }
  });
  titleEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); titleEl.blur(); }
    if (e.key === 'Escape') { titleEl.textContent = group.title || 'Unnamed'; titleEl.blur(); }
  });

  // Tab list
  if (!collapsed) {
    const list = document.createElement('div');
    list.className = 'tab-list';
    group.tabs.forEach(tab => list.appendChild(buildTabRow(tab)));
    col.appendChild(list);
  }

  return col;
}

// ----- Ungrouped column -----

function buildUngroupedCol(ungroupedTabs, idx) {
  const col = document.createElement('div');
  col.className = 'group-column ungrouped';
  col.style.animationDelay = `${idx * 55}ms`;
  col.style.setProperty('--group-color', '#4c4f62');

  col.innerHTML = `
    <div class="group-color-bar"></div>
    <div class="group-header">
      <div class="group-info">
        <span class="group-title" style="color:var(--text-secondary)">Ungrouped</span>
        <span class="group-count">${ungroupedTabs.length}</span>
      </div>
    </div>`;

  const list = document.createElement('div');
  list.className = 'tab-list';
  ungroupedTabs.forEach(tab => list.appendChild(buildTabRow(tab)));
  col.appendChild(list);

  return col;
}

// ----- Tab row -----

function buildTabRow(tab) {
  const row = document.createElement('div');
  row.className = 'tab-row';
  if (tab.active) row.classList.add('active');
  if (tab.pinned) row.classList.add('pinned');

  let domain = '';
  try { domain = new URL(tab.url || '').hostname.replace(/^www\./, ''); } catch {}

  const favicon = tab.favIconUrl || faviconFor(tab.url);
  const title = searchQuery ? highlight(tab.title || 'Untitled', searchQuery) : esc(tab.title || 'Untitled');
  const urlHtml = searchQuery ? highlight(domain, searchQuery) : esc(domain);

  row.innerHTML = `
    <img class="tab-favicon" src="${escAttr(favicon)}" alt="" loading="lazy">
    <div class="tab-info" title="${escAttr(tab.title || '')}">
      <div class="tab-title">${title}</div>
      <div class="tab-url">${urlHtml}</div>
    </div>
    <div class="tab-actions">
      <button class="tab-action close" title="Close tab">
        <svg width="14" height="14" viewBox="0 0 14 14">
          <path d="M3.5 3.5l7 7M10.5 3.5l-7 7" stroke="currentColor" fill="none" stroke-width="1.3" stroke-linecap="round"/>
        </svg>
      </button>
    </div>`;

  // Favicon error fallback
  const img = row.querySelector('.tab-favicon');
  img.addEventListener('error', () => { img.src = FALLBACK_ICON; }, { once: true });

  // Click → switch to tab
  row.addEventListener('click', (e) => {
    if (e.target.closest('.tab-action')) return;
    switchToTab(tab.id, tab.windowId);
  });

  // Close
  row.querySelector('.tab-action.close').addEventListener('click', (e) => {
    e.stopPropagation();
    closeTab(tab.id, row);
  });

  return row;
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

async function closeTab(tabId, rowEl) {
  // Animate out
  rowEl.style.transition = 'all 0.2s ease';
  rowEl.style.opacity = '0';
  rowEl.style.transform = 'translateX(12px)';

  setTimeout(async () => {
    try { await chrome.tabs.remove(tabId); } catch {}
    tabs = tabs.filter(t => t.id !== tabId);
    render();
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
      render();
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
      render();
    }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'b') {
      e.preventDefault();
      manualBackup();
    }
  });
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
        <span class="session-type">${b.type}</span>
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

  // Open ungrouped tabs
  for (const t of b.ungrouped) {
    await chrome.tabs.create({ url: t.url, pinned: t.pinned });
  }

  // Open grouped tabs and recreate groups
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

function updateStats(tabCount, groupCount) {
  const wins = new Set(tabs.map(t => t.windowId)).size;
  statsEl.innerHTML =
    `<span><span class="stat-value">${tabCount}</span> tabs</span>` +
    `<span><span class="stat-value">${groupCount}</span> groups</span>` +
    `<span><span class="stat-value">${wins}</span> windows</span>`;
}

// ===================================================================
// Collapsed state persistence
// ===================================================================

async function loadCollapsedState() {
  try {
    const { collapsedGroupIds = [] } = await chrome.storage.local.get('collapsedGroupIds');
    collapsedGroups = new Set(collapsedGroupIds);
  } catch {}
}

async function saveCollapsedState() {
  await chrome.storage.local.set({ collapsedGroupIds: [...collapsedGroups] });
}

// ===================================================================
// Live updates — keep display in sync
// ===================================================================

chrome.tabs.onCreated.addListener(() => loadData());
chrome.tabs.onRemoved.addListener((id) => {
  tabs = tabs.filter(t => t.id !== id);
  render();
});
chrome.tabs.onUpdated.addListener((id, changes) => {
  const t = tabs.find(t => t.id === id);
  if (t) { Object.assign(t, changes); render(); }
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
