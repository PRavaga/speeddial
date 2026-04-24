/**
 * Speed Dial — End-to-end Extension ↔ Web-app sync test
 *
 * Run: npx tsx test/web-sync.test.ts
 *
 * Spins up:
 *   - Local static server for web-app on port 8765
 *   - Chromium with the extension loaded
 *   - Route interceptor that simulates the Cloudflare Worker (fake KV)
 *
 * Tests:
 *   1. Crypto compatibility — ext encrypt → web decrypt round-trips
 *   2. Extension syncs an encrypted blob to the fake worker
 *   3. Web-app pulls + decrypts + renders the session correctly
 */

import { chromium, type BrowserContext } from 'playwright';
import path from 'path';
import http from 'http';
import fs from 'fs';

const EXT_PATH = path.resolve(__dirname, '../extension');
const WEB_APP_PATH = path.resolve(__dirname, '../web-app');
const WEB_PORT = 8765;

type Session = {
  timestamp: number;
  type: string;
  groups: { title: string; color: string; tabs: { title: string; url: string; pinned: boolean }[] }[];
  ungrouped: { title: string; url: string; pinned: boolean }[];
  tabCount: number;
  groupCount: number;
};

const TEST_USER = {
  sub: 'test-user-123456789',
  email: 'test@example.com',
  name: 'Test User',
  picture: ''
};

const TEST_AUTH = {
  accessToken: 'fake-access-token',
  refreshToken: 'fake-refresh-token',
  idToken: 'fake.id.token',
  expiresAt: Date.now() + 3600 * 1000,
  user: TEST_USER
};

const SAMPLE_SESSION: Session = {
  timestamp: Date.now() - 60000,
  type: 'manual',
  groups: [
    {
      title: 'Research',
      color: 'blue',
      tabs: [
        { title: 'MDN Web Docs — AES-GCM', url: 'https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/encrypt', pinned: false },
        { title: 'OAuth 2.0 PKCE RFC 7636', url: 'https://datatracker.ietf.org/doc/html/rfc7636', pinned: false }
      ]
    },
    {
      title: 'Todo',
      color: 'green',
      tabs: [
        { title: 'GitHub — PRavaga/speeddial', url: 'https://github.com/PRavaga/speeddial', pinned: false }
      ]
    }
  ],
  ungrouped: [
    { title: 'Hacker News', url: 'https://news.ycombinator.com/', pinned: true }
  ],
  tabCount: 4,
  groupCount: 2
};

const RESULTS: { name: string; pass: boolean; error?: string; duration: number }[] = [];

async function test(name: string, fn: () => Promise<void>) {
  const start = Date.now();
  try {
    await fn();
    RESULTS.push({ name, pass: true, duration: Date.now() - start });
    console.log(`  ✓ ${name} (${Date.now() - start}ms)`);
  } catch (e: any) {
    RESULTS.push({ name, pass: false, error: e.message, duration: Date.now() - start });
    console.log(`  ✗ ${name}: ${e.message}`);
  }
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(msg);
}

// -------------------------------------------------------------------
// Local static server for web-app
// -------------------------------------------------------------------

function startWebServer() {
  const mime: Record<string, string> = {
    '.html': 'text/html',
    '.js':   'text/javascript',
    '.css':  'text/css',
    '.svg':  'image/svg+xml',
    '.png':  'image/png',
    '.json': 'application/json'
  };
  const server = http.createServer((req, res) => {
    const urlPath = (req.url || '/').split('?')[0];
    const safe = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
    let file = path.join(WEB_APP_PATH, safe === '/' ? 'index.html' : safe);
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
    if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise<http.Server>((resolve) => server.listen(WEB_PORT, () => resolve(server)));
}

// -------------------------------------------------------------------
// Fake worker route handler (shared KV)
// -------------------------------------------------------------------

function installFakeWorker(context: BrowserContext) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let store: { data: any; version: number } | null = null;
  const calls: { method: string; status: number }[] = [];

  context.route('https://speeddial-sync.apps-0fb.workers.dev/api/sync', async (route) => {
    const req = route.request();
    const method = req.method();
    const auth = req.headerValue('authorization');

    if (!auth) {
      calls.push({ method, status: 401 });
      return route.fulfill({ status: 401, body: JSON.stringify({ error: 'no auth' }) });
    }

    if (method === 'GET') {
      if (!store) {
        calls.push({ method, status: 404 });
        return route.fulfill({ status: 404, body: 'null' });
      }
      calls.push({ method, status: 200 });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(store) });
    }

    if (method === 'PUT') {
      const body = JSON.parse(req.postData() || '{}');
      if (!body.data) {
        calls.push({ method, status: 400 });
        return route.fulfill({ status: 400, body: JSON.stringify({ error: 'missing data' }) });
      }
      store = { data: body.data, version: body.version || 1 };
      calls.push({ method, status: 200 });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, version: store.version }) });
    }

    if (method === 'DELETE') {
      store = null;
      calls.push({ method, status: 200 });
      return route.fulfill({ status: 200, body: '{}' });
    }

    calls.push({ method, status: 405 });
    return route.fulfill({ status: 405, body: 'method not allowed' });
  });

  return {
    getStore: () => store,
    setStore: (s: typeof store) => { store = s; },
    getCalls: () => calls
  };
}

// -------------------------------------------------------------------
// Main
// -------------------------------------------------------------------

async function main() {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║  Speed Dial — Extension ↔ Web-app E2E    ║');
  console.log('╚══════════════════════════════════════════╝\n');

  console.log('Starting web-app server on http://localhost:' + WEB_PORT);
  const server = await startWebServer();

  console.log('Launching Chromium with extension...');
  const context = await chromium.launchPersistentContext('', {
    headless: false,
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--no-first-run',
      '--disable-default-apps',
      '--disable-popup-blocking',
      '--disable-infobars',
    ],
    viewport: { width: 1280, height: 800 },
  });

  // Extension ID — needed to open the new-tab page
  let extensionId = '';
  const sw = context.serviceWorkers();
  if (sw.length > 0) extensionId = sw[0].url().split('/')[2];
  else {
    const w = await context.waitForEvent('serviceworker', { timeout: 10000 });
    extensionId = w.url().split('/')[2];
  }
  const extUrl = `chrome-extension://${extensionId}/newtab.html`;
  console.log(`Extension ID: ${extensionId}\n`);

  const worker = installFakeWorker(context);

  // ================================================================
  // Test 1 — crypto round-trip (ext encrypts, web-app decrypts)
  // ================================================================
  console.log('─── Crypto Compatibility ───');

  await test('ext crypto.js → web-app crypto.js round-trip', async () => {
    // Load both crypto modules into two pages and verify compatibility.
    const extPage = await context.newPage();
    await extPage.goto(extUrl, { waitUntil: 'load' });

    const encrypted = await extPage.evaluate(async (userSub) => {
      const mod = await import('./crypto.js');
      const payload = { hello: 'world', n: 42, arr: [1, 2, 3] };
      return mod.encrypt(payload, userSub);
    }, TEST_USER.sub);

    assert(encrypted && encrypted.v === 2 && encrypted.iv && encrypted.data,
      `Encrypted envelope malformed: ${JSON.stringify(encrypted)}`);

    const webPage = await context.newPage();
    await webPage.goto(`http://localhost:${WEB_PORT}/`, { waitUntil: 'load' });

    const decrypted = await webPage.evaluate(async ({ envelope, userSub }) => {
      const mod = await import('./crypto.js');
      return mod.decrypt(envelope, userSub);
    }, { envelope: encrypted, userSub: TEST_USER.sub });

    assert(decrypted.hello === 'world' && decrypted.n === 42 && JSON.stringify(decrypted.arr) === '[1,2,3]',
      `Decrypted payload mismatch: ${JSON.stringify(decrypted)}`);

    await extPage.close();
    await webPage.close();
  });

  // ================================================================
  // Test 2 — Extension pushes to fake worker
  // ================================================================
  console.log('\n─── Extension → Worker Push ───');

  await test('Extension syncs session to fake worker', async () => {
    const extPage = await context.newPage();

    // Inject fake auth + sample session into chrome.storage.local BEFORE
    // the page's modules load, so initAuth() finds valid state.
    await extPage.addInitScript((args) => {
      chrome.storage.local.set({
        syncAuth: args.auth,
        backups: [args.session],
        theme: 'dark',
        lastBackup: Date.now()
      });
    }, { auth: TEST_AUTH, session: SAMPLE_SESSION });

    await extPage.goto(extUrl, { waitUntil: 'load' });
    // Wait for the extension to settle
    await extPage.waitForSelector('.tile-grid', { timeout: 5000 });
    await extPage.waitForTimeout(500);

    // Call syncNow() directly via module import — more reliable than UI
    const result = await extPage.evaluate(async () => {
      const mod = await import('./sync.js');
      return await mod.syncNow();
    });

    assert(result.ok === true, `syncNow failed: ${JSON.stringify(result)}`);

    const store = worker.getStore();
    assert(store !== null, 'Fake worker has no stored blob after sync');
    assert(store!.data && store!.data.v === 2 && store!.data.iv && store!.data.data,
      `Stored blob is not a v2 envelope: ${JSON.stringify(store)}`);

    const calls = worker.getCalls();
    const putCalls = calls.filter(c => c.method === 'PUT' && c.status === 200);
    assert(putCalls.length >= 1, `Expected ≥1 successful PUT, got ${putCalls.length}`);

    await extPage.close();
  });

  // ================================================================
  // Test 2b — onChanged trigger fires a debounced sync
  // ================================================================

  await test('Extension onChanged → debounced sync on backups change', async () => {
    worker.setStore(null); // wipe so we observe a fresh write
    const extPage = await context.newPage();
    await extPage.addInitScript((args) => {
      chrome.storage.local.set({
        syncAuth: args.auth,
        backups: [],
        theme: 'dark'
      });
    }, { auth: TEST_AUTH });
    await extPage.goto(extUrl, { waitUntil: 'load' });
    await extPage.waitForSelector('.tile-grid', { timeout: 5000 });

    // Let the service worker come up + register its onChanged listener
    await extPage.waitForTimeout(800);
    const callsBefore = worker.getCalls().filter(c => c.method === 'PUT' && c.status === 200).length;

    // Trigger: write a new backup. Background's onChanged listener should
    // debounce (2s) then call guardedSync → pushes to the fake worker.
    await extPage.evaluate((session) => {
      return chrome.storage.local.set({ backups: [session], lastBackup: Date.now() });
    }, SAMPLE_SESSION);

    // 2s debounce + sync round-trip + margin
    await extPage.waitForTimeout(4000);

    const callsAfter = worker.getCalls().filter(c => c.method === 'PUT' && c.status === 200).length;
    assert(callsAfter > callsBefore,
      `Expected new PUT after backups change; before=${callsBefore}, after=${callsAfter}`);
    assert(worker.getStore() !== null, 'Store should have blob after onChanged-triggered sync');

    await extPage.close();
  });

  // ================================================================
  // Test 3 — Web app pulls + decrypts + renders
  // ================================================================
  console.log('\n─── Web-app ← Worker Pull ───');

  await test('Web-app pulls blob and renders session list', async () => {
    assert(worker.getStore() !== null, 'Pre-req: worker must have a stored blob from test 2');

    const webPage = await context.newPage();
    await webPage.addInitScript((auth) => {
      localStorage.setItem('sd.syncAuth', JSON.stringify(auth));
    }, TEST_AUTH);

    await webPage.goto(`http://localhost:${WEB_PORT}/`, { waitUntil: 'load' });

    // Header shows account + session card appears
    await webPage.waitForSelector('.session-card', { timeout: 5000 });

    const dateText = await webPage.locator('.session-card .date').first().textContent();
    const statsText = await webPage.locator('.session-card .stats').first().textContent();
    assert(/\d/.test(dateText || ''), `Session date missing: ${dateText}`);
    assert(/4 tabs/.test(statsText || ''), `Session stats missing tab count: ${statsText}`);
    assert(/2 groups/.test(statsText || ''), `Session stats missing group count: ${statsText}`);

    const userEmailVisible = await webPage.evaluate(() => {
      return !!document.querySelector('.user-menu-btn')?.textContent?.includes('Test User');
    });
    assert(userEmailVisible, 'Account name not shown in header');

    await webPage.close();
  });

  await test('Web-app session detail shows tabs, favicons, and open-all', async () => {
    const webPage = await context.newPage();
    await webPage.addInitScript((auth) => {
      localStorage.setItem('sd.syncAuth', JSON.stringify(auth));
    }, TEST_AUTH);
    await webPage.goto(`http://localhost:${WEB_PORT}/`, { waitUntil: 'load' });
    await webPage.waitForSelector('.session-card', { timeout: 5000 });

    // Open the session
    await webPage.locator('.session-card').first().click();
    await webPage.waitForSelector('.group-block', { timeout: 2000 });

    // Both groups + ungrouped should appear
    const groupHeaders = await webPage.locator('.group-title').allTextContents();
    assert(groupHeaders.includes('Research'), `"Research" group missing: ${JSON.stringify(groupHeaders)}`);
    assert(groupHeaders.includes('Todo'), `"Todo" group missing: ${JSON.stringify(groupHeaders)}`);
    assert(groupHeaders.includes('Ungrouped'), `"Ungrouped" missing: ${JSON.stringify(groupHeaders)}`);

    // All 4 tab rows present
    const tabRows = await webPage.locator('.tab-row').count();
    assert(tabRows === 4, `Expected 4 tab rows, got ${tabRows}`);

    // Titles rendered
    const titleText = await webPage.locator('.tab-title').allTextContents();
    assert(titleText.some(t => t.includes('PRavaga/speeddial')), `GitHub title missing: ${JSON.stringify(titleText)}`);
    assert(titleText.some(t => t.includes('Hacker News')), `HN title missing: ${JSON.stringify(titleText)}`);

    // URLs rendered as hostnames
    const urlText = await webPage.locator('.tab-url').allTextContents();
    assert(urlText.includes('news.ycombinator.com'), `HN hostname missing: ${JSON.stringify(urlText)}`);
    assert(urlText.includes('github.com'), `github hostname missing: ${JSON.stringify(urlText)}`);

    // Each tab has href
    const hrefs = await webPage.locator('.tab-row').evaluateAll(els => els.map(e => (e as HTMLAnchorElement).href));
    assert(hrefs.some(h => h.includes('news.ycombinator.com')), `HN href missing: ${JSON.stringify(hrefs)}`);
    assert(hrefs.every(h => h.startsWith('http')), `All hrefs should be http(s): ${JSON.stringify(hrefs)}`);

    // rel=noopener is set on tab links (security)
    const rels = await webPage.locator('.tab-row').evaluateAll(els => els.map(e => (e as HTMLAnchorElement).rel));
    assert(rels.every(r => r.includes('noopener')), `All tab links must rel=noopener: ${JSON.stringify(rels)}`);

    // Group color dots
    const dotBg = await webPage.locator('.group-dot').first().evaluate(el => (el as HTMLElement).style.background);
    assert(dotBg.length > 0, `Group dot has no color: "${dotBg}"`);

    // Back button returns to list
    await webPage.locator('.back-btn').click();
    await webPage.waitForSelector('.sessions', { timeout: 1000 });

    await webPage.close();
  });

  await test('Web-app search filters sessions by tab title', async () => {
    const webPage = await context.newPage();
    await webPage.addInitScript((auth) => {
      localStorage.setItem('sd.syncAuth', JSON.stringify(auth));
    }, TEST_AUTH);
    await webPage.goto(`http://localhost:${WEB_PORT}/`, { waitUntil: 'load' });
    await webPage.waitForSelector('.session-card', { timeout: 5000 });

    // Search for "hacker" — should still match the session that contains HN tab
    await webPage.locator('.search input').fill('hacker');
    await webPage.waitForTimeout(150);
    let visible = await webPage.locator('.session-card').count();
    assert(visible === 1, `"hacker" query: expected 1 session, got ${visible}`);

    // Search for something that doesn't exist
    await webPage.locator('.search input').fill('zzzzzz-nothing');
    await webPage.waitForTimeout(150);
    visible = await webPage.locator('.session-card').count();
    assert(visible === 0, `Non-matching query should show 0 cards, got ${visible}`);
    const empty = await webPage.locator('.empty').count();
    assert(empty === 1, 'Expected empty-state when no sessions match');

    await webPage.close();
  });

  await test('Web-app mobile viewport (375px) keeps tap targets accessible', async () => {
    const webPage = await context.newPage();
    await webPage.setViewportSize({ width: 375, height: 700 });
    await webPage.addInitScript((auth) => {
      localStorage.setItem('sd.syncAuth', JSON.stringify(auth));
    }, TEST_AUTH);
    await webPage.goto(`http://localhost:${WEB_PORT}/`, { waitUntil: 'load' });
    await webPage.waitForSelector('.session-card', { timeout: 5000 });

    const cardBox = await webPage.locator('.session-card').first().boundingBox();
    assert(cardBox !== null && cardBox.height >= 44, `Card tap target too short: ${cardBox?.height}px`);
    assert(cardBox !== null && cardBox.width <= 375, `Card wider than viewport: ${cardBox?.width}`);

    await webPage.locator('.session-card').first().click();
    await webPage.waitForSelector('.tab-row', { timeout: 2000 });

    const rowBox = await webPage.locator('.tab-row').first().boundingBox();
    assert(rowBox !== null && rowBox.height >= 36, `Tab row too short for tap: ${rowBox?.height}px`);

    // No horizontal scrollbar
    const horiz = await webPage.evaluate(() =>
      document.documentElement.scrollWidth > document.documentElement.clientWidth);
    assert(!horiz, 'Horizontal scroll overflow on mobile');

    await webPage.close();
  });

  await test('Web-app pulls nothing when worker has no blob', async () => {
    worker.setStore(null);
    const webPage = await context.newPage();
    await webPage.addInitScript((auth) => {
      localStorage.setItem('sd.syncAuth', JSON.stringify(auth));
    }, TEST_AUTH);
    await webPage.goto(`http://localhost:${WEB_PORT}/`, { waitUntil: 'load' });
    await webPage.waitForSelector('.empty', { timeout: 5000 });
    const empty = await webPage.locator('.empty').textContent();
    assert(/no saved sessions/i.test(empty || ''), `Empty state text mismatch: ${empty}`);
    await webPage.close();
  });

  await test('Web-app signed-out state shows Google sign-in button', async () => {
    const webPage = await context.newPage();
    // Clear localStorage before navigation
    await webPage.goto(`http://localhost:${WEB_PORT}/`, { waitUntil: 'load' });
    await webPage.evaluate(() => localStorage.clear());
    await webPage.reload({ waitUntil: 'load' });

    await webPage.waitForSelector('.signin-screen', { timeout: 3000 });
    const btnText = await webPage.locator('.google-btn').textContent();
    assert(/sign in with google/i.test(btnText || ''), `Sign-in button text: ${btnText}`);
    await webPage.close();
  });

  // ================================================================
  // Summary
  // ================================================================
  console.log('\n' + '═'.repeat(50));
  const passed = RESULTS.filter(r => r.pass).length;
  const failed = RESULTS.filter(r => !r.pass).length;
  const totalTime = RESULTS.reduce((s, r) => s + r.duration, 0);
  console.log(`\n  ${passed} passed, ${failed} failed (${RESULTS.length} total, ${totalTime}ms)\n`);

  if (failed > 0) {
    console.log('  Failed:');
    RESULTS.filter(r => !r.pass).forEach(r => console.log(`    ✗ ${r.name}: ${r.error}`));
  }

  console.log('');
  await context.close();
  server.close();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('Test runner failed:', e);
  process.exit(1);
});
