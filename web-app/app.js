// ===================================================================
// Speed Dial Web — Sessions dashboard
// ===================================================================

import { initAuth, signIn, signOut, isSignedIn, getUser } from './auth.js';
import { pullDoc } from './sync.js';

const root = document.getElementById('app');

const state = {
  sessions: [],
  settings: { theme: 'dark' },
  query: '',
  view: 'list', // 'list' | 'detail'
  selectedIdx: 0,
  error: null,
  loading: false,
};

// -------------------------------------------------------------------
// Boot
// -------------------------------------------------------------------

(async function boot() {
  applyTheme(loadStoredTheme());

  try {
    await initAuth();
  } catch (e) {
    renderSignIn({ error: e.message });
    return;
  }

  if (!isSignedIn()) {
    renderSignIn({});
    return;
  }

  await loadAndRender();
})();

async function loadAndRender() {
  state.loading = true;
  renderShell();
  try {
    const doc = await pullDoc();
    if (doc) {
      state.sessions = doc.sessions || [];
      if (doc.settings?.theme) {
        state.settings.theme = doc.settings.theme;
        applyTheme(doc.settings.theme);
        saveTheme(doc.settings.theme);
      }
    } else {
      state.sessions = [];
    }
    state.error = null;
  } catch (e) {
    console.error('[speeddial] pullDoc failed', e);
    state.error = e.message || e.name || String(e) || 'Failed to load sessions';
    state.errorDiag = e?.diag || null;
  } finally {
    state.loading = false;
    renderShell();
  }
}

// -------------------------------------------------------------------
// Signed-out view
// -------------------------------------------------------------------

function renderSignIn({ error }) {
  root.innerHTML = '';
  const screen = el('div', { class: 'signin-screen' });

  const logo = el('img', { class: 'logo', src: 'favicon.svg', alt: '' });
  const h1 = el('h1', {}, 'Speed Dial');
  const tagline = el('p', { class: 'tagline' },
    'Your saved tab sessions, on any device. Sign in with the same Google account you use in the extension.');

  const btn = el('button', { class: 'google-btn', type: 'button' });
  btn.innerHTML = `
    <svg width="18" height="18" viewBox="0 0 48 48">
      <path fill="#4285F4" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
      <path fill="#34A853" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
      <path fill="#FBBC05" d="M10.53 28.59A14.5 14.5 0 0 1 9.5 24c0-1.59.28-3.14.76-4.59l-7.98-6.19A23.99 23.99 0 0 0 0 24c0 3.77.9 7.35 2.56 10.52l7.97-5.93z"/>
      <path fill="#EA4335" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 5.93C6.51 42.62 14.62 48 24 48z"/>
    </svg>
    <span>Sign in with Google</span>`;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try { await signIn(); } catch (e) { btn.disabled = false; renderSignIn({ error: e.message }); }
  });

  screen.appendChild(logo);
  screen.appendChild(h1);
  screen.appendChild(tagline);
  screen.appendChild(btn);

  if (error) {
    screen.appendChild(el('div', { class: 'error' }, error));
  }

  const footer = el('div', { class: 'footer' });
  footer.innerHTML = `Don't have the extension yet? <a href="https://chromewebstore.google.com/detail/speed-dial/miphkkgceicjjenpfeajamfdceiapppe" target="_blank" rel="noopener">Get it on the Chrome Web Store</a>.`;
  screen.appendChild(footer);

  root.appendChild(screen);
}

// -------------------------------------------------------------------
// Shell (header + main)
// -------------------------------------------------------------------

function renderShell() {
  root.innerHTML = '';
  root.appendChild(renderTopbar());

  const main = el('main', {});
  if (state.loading) {
    main.appendChild(el('div', { class: 'boot' }, el('div', { class: 'spinner' })));
  } else if (state.error) {
    main.appendChild(renderError());
  } else if (state.view === 'detail') {
    main.appendChild(renderDetail());
  } else {
    main.appendChild(renderList());
  }
  root.appendChild(main);
}

function renderTopbar() {
  const bar = el('header', { class: 'topbar' });
  bar.appendChild(el('div', { class: 'topbar-title' }, 'Speed Dial'));
  bar.appendChild(el('div', { class: 'topbar-spacer' }));

  // Theme toggle
  const themeBtn = el('button', {
    class: 'icon-btn',
    type: 'button',
    title: 'Toggle theme',
    'aria-label': 'Toggle theme'
  });
  themeBtn.innerHTML = iconSvg('theme');
  themeBtn.addEventListener('click', () => {
    const next = (document.documentElement.getAttribute('data-theme') === 'light') ? 'dark' : 'light';
    applyTheme(next);
    saveTheme(next);
    state.settings.theme = next;
  });
  bar.appendChild(themeBtn);

  // User menu
  const user = getUser();
  const menu = el('div', { class: 'user-menu' });
  const menuBtn = el('button', { class: 'user-menu-btn', type: 'button', 'aria-haspopup': 'true' });
  if (user?.picture) {
    const img = el('img', { class: 'avatar', src: user.picture, alt: '' });
    img.addEventListener('error', () => { img.style.display = 'none'; });
    menuBtn.appendChild(img);
  }
  menuBtn.appendChild(el('span', { class: 'name' }, user?.name || user?.email || 'Account'));
  const dropdown = el('div', { class: 'user-menu-dropdown' });
  if (user?.email) dropdown.appendChild(el('div', { class: 'email' }, user.email));
  const signOutBtn = el('button', { type: 'button' }, 'Sign out');
  signOutBtn.addEventListener('click', () => {
    signOut();
    location.reload();
  });
  dropdown.appendChild(signOutBtn);
  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown.classList.toggle('open');
  });
  document.addEventListener('click', () => dropdown.classList.remove('open'));
  menu.appendChild(menuBtn);
  menu.appendChild(dropdown);
  bar.appendChild(menu);

  return bar;
}

// -------------------------------------------------------------------
// Session list
// -------------------------------------------------------------------

function renderList() {
  const wrap = el('div', {});
  const toolbar = el('div', { class: 'toolbar' });

  const search = el('div', { class: 'search' });
  search.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>`;
  const input = el('input', { type: 'search', placeholder: 'Search sessions, tabs, URLs…', autocomplete: 'off' });
  input.value = state.query;
  input.addEventListener('input', () => {
    state.query = input.value.trim().toLowerCase();
    renderSessions(sessionsEl, filteredSessions(), countEl);
  });
  search.appendChild(input);
  toolbar.appendChild(search);

  const countEl = el('div', { class: 'count' });
  toolbar.appendChild(countEl);
  wrap.appendChild(toolbar);

  const sessionsEl = el('div', { class: 'sessions' });
  renderSessions(sessionsEl, filteredSessions(), countEl);
  wrap.appendChild(sessionsEl);

  return wrap;
}

function filteredSessions() {
  if (!state.query) return state.sessions;
  const q = state.query;
  return state.sessions.filter((s) => {
    if (String(s.type || '').toLowerCase().includes(q)) return true;
    for (const g of s.groups || []) {
      if ((g.title || '').toLowerCase().includes(q)) return true;
      for (const t of g.tabs || []) {
        if ((t.title || '').toLowerCase().includes(q)) return true;
        if ((t.url || '').toLowerCase().includes(q)) return true;
      }
    }
    for (const t of s.ungrouped || []) {
      if ((t.title || '').toLowerCase().includes(q)) return true;
      if ((t.url || '').toLowerCase().includes(q)) return true;
    }
    return false;
  });
}

function renderSessions(container, list, countEl) {
  container.innerHTML = '';
  countEl.textContent = list.length === state.sessions.length
    ? `${list.length} session${list.length === 1 ? '' : 's'}`
    : `${list.length} / ${state.sessions.length} sessions`;

  if (list.length === 0) {
    const e = el('div', { class: 'empty' },
      state.sessions.length === 0
        ? 'No saved sessions yet. Create one in the extension (Snapshot button or Ctrl+Shift+B).'
        : 'No sessions match your search.');
    container.appendChild(e);
    return;
  }

  list.forEach((s, i) => {
    const idx = state.sessions.indexOf(s);
    const card = el('button', { class: 'session-card', type: 'button' });
    card.appendChild(el('div', { class: 'date' }, fmtDate(s.timestamp)));
    card.appendChild(el('div', { class: 'type' }, s.type || 'snapshot'));
    const stats = highlightText(
      `${s.tabCount ?? countTabs(s)} tabs · ${s.groupCount ?? (s.groups?.length || 0)} groups`,
      state.query
    );
    const statsEl = el('div', { class: 'stats' });
    statsEl.innerHTML = stats;
    card.appendChild(statsEl);
    card.addEventListener('click', () => {
      state.selectedIdx = idx;
      state.view = 'detail';
      renderShell();
      window.scrollTo({ top: 0 });
    });
    container.appendChild(card);
  });
}

function countTabs(s) {
  let n = (s.ungrouped || []).length;
  for (const g of s.groups || []) n += (g.tabs || []).length;
  return n;
}

// -------------------------------------------------------------------
// Session detail
// -------------------------------------------------------------------

function renderDetail() {
  const s = state.sessions[state.selectedIdx];
  if (!s) {
    state.view = 'list';
    return renderList();
  }

  const wrap = el('div', {});

  const header = el('div', { class: 'detail-header' });
  const back = el('button', { class: 'back-btn', type: 'button', 'aria-label': 'Back to sessions' });
  back.innerHTML = iconSvg('back');
  back.addEventListener('click', () => {
    state.view = 'list';
    renderShell();
  });
  header.appendChild(back);

  const titleWrap = el('div', { class: 'detail-title' });
  titleWrap.appendChild(el('h2', {}, fmtDate(s.timestamp)));
  const tabCount = s.tabCount ?? countTabs(s);
  const groupCount = s.groupCount ?? (s.groups?.length || 0);
  titleWrap.appendChild(el('div', { class: 'sub' },
    `${tabCount} tabs · ${groupCount} groups · ${s.type || 'snapshot'}`));
  header.appendChild(titleWrap);

  const actions = el('div', { class: 'actions' });
  const openAll = el('button', { class: 'btn primary', type: 'button' });
  openAll.innerHTML = `${iconSvg('external')}<span class="label">Open all</span>`;
  openAll.addEventListener('click', () => openAllTabs(s));
  actions.appendChild(openAll);
  header.appendChild(actions);

  wrap.appendChild(header);

  // Groups
  for (const g of s.groups || []) {
    if (!g.tabs || g.tabs.length === 0) continue;
    wrap.appendChild(renderGroupBlock(g.title || 'Unnamed', g.color, g.tabs));
  }
  if (s.ungrouped && s.ungrouped.length > 0) {
    wrap.appendChild(renderGroupBlock('Ungrouped', null, s.ungrouped));
  }

  return wrap;
}

const GROUP_COLORS = {
  grey: '#8b8fa3', blue: '#5b9fff', red: '#ff6363', yellow: '#ffc44a',
  green: '#4adf7e', pink: '#ff6eb4', purple: '#a78bfa', cyan: '#22d3ee', orange: '#ff8a4a'
};

function renderGroupBlock(title, color, tabs) {
  const block = el('section', { class: 'group-block' });
  const header = el('div', { class: 'group-header' });
  const dot = el('span', { class: 'group-dot' });
  dot.style.background = color ? (GROUP_COLORS[color] || GROUP_COLORS.grey) : '#4c4f62';
  header.appendChild(dot);
  header.appendChild(el('div', { class: 'group-title' }, title));
  header.appendChild(el('div', { class: 'group-count' }, `${tabs.length} tab${tabs.length === 1 ? '' : 's'}`));
  block.appendChild(header);

  const list = el('div', { class: 'tab-list' });
  for (const t of tabs) list.appendChild(renderTabRow(t));
  block.appendChild(list);
  return block;
}

function renderTabRow(tab) {
  const a = el('a', {
    class: 'tab-row',
    href: tab.url || '#',
    target: '_blank',
    rel: 'noopener noreferrer'
  });

  const domain = domainOf(tab.url);
  const letter = (domain[0] || '?').toUpperCase();

  // Favicon with fallback to letter
  const favicon = el('img', {
    class: 'tab-favicon',
    alt: '',
    loading: 'lazy',
    referrerpolicy: 'no-referrer'
  });
  favicon.src = googleFavicon(tab.url);
  favicon.addEventListener('error', () => {
    const fb = el('div', { class: 'tab-favicon-fallback' }, letter);
    favicon.replaceWith(fb);
  }, { once: true });
  a.appendChild(favicon);

  const info = el('div', { class: 'tab-info' });
  const title = el('div', { class: 'tab-title' });
  const url = el('div', { class: 'tab-url' });
  title.innerHTML = highlightText(tab.title || 'Untitled', state.query);
  url.innerHTML = highlightText(domain, state.query);
  info.appendChild(title);
  info.appendChild(url);
  a.appendChild(info);

  return a;
}

function openAllTabs(s) {
  // Collect all tabs across groups + ungrouped
  const urls = [];
  for (const g of s.groups || []) for (const t of g.tabs || []) if (t.url) urls.push(t.url);
  for (const t of s.ungrouped || []) if (t.url) urls.push(t.url);

  if (urls.length === 0) return;

  // Browser popup blockers throttle bursts — open up to 20 synchronously,
  // and confirm before opening more than 10.
  if (urls.length > 10) {
    const ok = confirm(`Open ${urls.length} tabs? Your browser may block some.`);
    if (!ok) return;
  }
  for (const u of urls.slice(0, 30)) {
    window.open(u, '_blank', 'noopener,noreferrer');
  }
  if (urls.length > 30) {
    alert(`Opened the first 30 of ${urls.length} tabs. Open the rest individually.`);
  }
}

// -------------------------------------------------------------------
// Error state
// -------------------------------------------------------------------

function renderError() {
  const wrap = el('div', { class: 'empty' });
  wrap.appendChild(el('div', {}, `Couldn't load sessions — ${state.error}`));
  const retry = el('button', { class: 'btn', type: 'button', style: 'margin-top:12px' }, 'Retry');
  retry.addEventListener('click', () => loadAndRender());
  wrap.appendChild(retry);

  if (state.errorDiag) {
    const details = el('details', {
      style: 'margin-top:16px;text-align:left;font-family:var(--font-mono);font-size:11px;color:var(--text-tertiary);max-width:400px;margin-left:auto;margin-right:auto'
    });
    details.appendChild(el('summary', { style: 'cursor:pointer' }, 'Diagnostic'));
    const pre = el('pre', { style: 'white-space:pre-wrap;word-break:break-all;margin:8px 0' });
    pre.textContent = JSON.stringify(state.errorDiag, null, 2);
    details.appendChild(pre);
    wrap.appendChild(details);
  }
  return wrap;
}

// -------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') node.className = v;
    else if (k === 'style' && typeof v === 'string') node.setAttribute('style', v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

function fmtDate(ts) {
  if (!ts) return 'Unknown';
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const opts = sameDay
    ? { hour: '2-digit', minute: '2-digit' }
    : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };
  return sameDay ? `Today ${d.toLocaleTimeString(undefined, opts)}` : d.toLocaleString(undefined, opts);
}

function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url || ''; }
}

function googleFavicon(url) {
  try {
    const host = new URL(url).hostname;
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`;
  } catch {
    return '';
  }
}

function esc(str) {
  const el = document.createElement('span');
  el.textContent = String(str ?? '');
  return el.innerHTML;
}

function highlightText(text, query) {
  const safe = esc(text);
  if (!query) return safe;
  const q = esc(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return safe.replace(new RegExp(`(${q})`, 'gi'), '<mark>$1</mark>');
}

function iconSvg(name) {
  switch (name) {
    case 'theme':
      return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
    case 'back':
      return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>';
    case 'external':
      return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>';
    default: return '';
  }
}

// -------------------------------------------------------------------
// Theme persistence
// -------------------------------------------------------------------

function loadStoredTheme() {
  try { return localStorage.getItem('sd.theme') || 'dark'; } catch { return 'dark'; }
}
function saveTheme(theme) {
  try { localStorage.setItem('sd.theme', theme); } catch {}
}
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme || 'dark');
  document.querySelector('meta[name="theme-color"]')?.setAttribute(
    'content', theme === 'light' ? '#f5f6f8' : '#0c0d10'
  );
}
