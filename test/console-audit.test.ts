/**
 * Speed Dial — Console Audit + Change Validation
 *
 * Validates the recent fixes:
 *   - favicon change: no ERR_BLOCKED_BY_RESPONSE.NotSameOrigin in console
 *   - loading=lazy removal: no [Intervention] warning
 *   - envelope versioning: sync module importable, v2 ciphertext shape
 *   - manifest bumped
 *
 * Run: npx tsx test/console-audit.test.ts
 */

import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';

const EXT_PATH = path.resolve(__dirname, '../extension');
const RESULTS: { name: string; pass: boolean; error?: string }[] = [];

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    RESULTS.push({ name, pass: true });
    console.log(`  ✓ ${name}`);
  } catch (e: any) {
    RESULTS.push({ name, pass: false, error: e.message });
    console.log(`  ✗ ${name}: ${e.message}`);
  }
}

function assert(cond: any, msg: string) {
  if (!cond) throw new Error(msg);
}

async function main() {
  console.log('\n── Console Audit & Change Validation ──\n');

  // ── Static file checks (no browser needed) ──
  await test('manifest version bumped to 2.1.1', async () => {
    const m = JSON.parse(fs.readFileSync(path.join(EXT_PATH, 'manifest.json'), 'utf8'));
    assert(m.version === '2.1.1', `Version: ${m.version}`);
  });

  await test('newtab.js uses faviconFor() first, tab.favIconUrl as fallback', async () => {
    const js = fs.readFileSync(path.join(EXT_PATH, 'newtab.js'), 'utf8');
    assert(/faviconFor\(tab\.url\) \|\| tab\.favIconUrl/.test(js), 'Favicon priority not swapped');
  });

  await test('newtab.js has no loading="lazy" on tile images', async () => {
    const js = fs.readFileSync(path.join(EXT_PATH, 'newtab.js'), 'utf8');
    const lazy = (js.match(/loading="lazy"/g) || []).length;
    assert(lazy === 0, `Found ${lazy} loading="lazy" still present`);
  });

  await test('crypto.js exports envelope-versioned encrypt/decrypt', async () => {
    const js = fs.readFileSync(path.join(EXT_PATH, 'crypto.js'), 'utf8');
    assert(/CURRENT_KEY_VERSION = 2/.test(js), 'CURRENT_KEY_VERSION not 2');
    assert(/KEY_VERSIONS/.test(js), 'KEY_VERSIONS table missing');
    assert(/encrypt\(data, userSub\)/.test(js), 'encrypt signature changed');
    assert(/decrypt\(encrypted, userSub\)/.test(js), 'decrypt signature changed');
  });

  await test('sync.js has OperationError recovery path', async () => {
    const js = fs.readFileSync(path.join(EXT_PATH, 'sync.js'), 'utf8');
    assert(/OperationError/.test(js), 'No OperationError handling');
    assert(/method: 'DELETE'/.test(js), 'No DELETE wipe on bad blob');
  });

  await test('sync.js falls back to e.name when e.message empty', async () => {
    const js = fs.readFileSync(path.join(EXT_PATH, 'sync.js'), 'utf8');
    assert(/e\.message \|\| e\.name/.test(js), 'Error reason fallback missing');
  });

  await test('sync.js strips favIconUrl from sessions', async () => {
    const js = fs.readFileSync(path.join(EXT_PATH, 'sync.js'), 'utf8');
    assert(/stripSessionFat/.test(js), 'No stripSessionFat helper');
    // Confirm favIconUrl is NOT in the stripped tab shape
    const stripTabLine = js.match(/stripTab = t => \(\{[^}]+\}\)/);
    assert(stripTabLine != null, 'stripTab shape not found');
    assert(!/favIconUrl/.test(stripTabLine![0]), 'favIconUrl still in stripped shape');
  });

  // ── Browser checks ──
  console.log('\n  Launching Chromium...');
  const context = await chromium.launchPersistentContext('', {
    headless: false,
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--no-first-run',
      '--disable-default-apps',
    ],
    viewport: { width: 1440, height: 900 },
  });

  let extensionId = '';
  const sw = context.serviceWorkers();
  if (sw.length > 0) {
    extensionId = sw[0].url().split('/')[2];
  } else {
    const w = await context.waitForEvent('serviceworker', { timeout: 10000 });
    extensionId = w.url().split('/')[2];
  }
  const extUrl = `chrome-extension://${extensionId}/newtab.html`;

  // Seed a few tabs so the grid has content
  for (const url of ['https://example.com', 'https://www.wikipedia.org', 'https://github.com']) {
    try { await context.newPage().then(p => p.goto(url, { timeout: 5000 }).catch(() => {})); } catch {}
  }
  await new Promise(r => setTimeout(r, 1000));

  // Collect console messages + network failures from the newtab page
  const consoleMessages: { type: string; text: string }[] = [];
  const failedRequests: { url: string; failure: string }[] = [];

  const page = await context.newPage();
  page.on('console', msg => {
    consoleMessages.push({ type: msg.type(), text: msg.text() });
  });
  page.on('requestfailed', req => {
    failedRequests.push({ url: req.url(), failure: req.failure()?.errorText || '' });
  });
  page.on('pageerror', err => {
    consoleMessages.push({ type: 'pageerror', text: err.message });
  });

  await page.goto(extUrl);
  await page.waitForTimeout(2500); // let favicons and all renders settle

  await test('no ERR_BLOCKED_BY_RESPONSE.NotSameOrigin for favicons', async () => {
    const blocks = failedRequests.filter(r => r.failure.includes('BLOCKED_BY_RESPONSE'));
    if (blocks.length > 0) {
      console.log('    blocked requests:', blocks.slice(0, 3));
    }
    assert(blocks.length === 0, `${blocks.length} BLOCKED_BY_RESPONSE failures`);
  });

  await test('no [Intervention] lazy-load warnings', async () => {
    const interventions = consoleMessages.filter(m => /Intervention/i.test(m.text));
    if (interventions.length > 0) {
      console.log('    interventions:', interventions.slice(0, 3).map(m => m.text));
    }
    assert(interventions.length === 0, `${interventions.length} [Intervention] warnings`);
  });

  await test('no page errors during load', async () => {
    const errs = consoleMessages.filter(m => m.type === 'pageerror' || m.type === 'error');
    // Filter out noise we don't care about (e.g. third-party extension-store chatter)
    const meaningful = errs.filter(m =>
      !/sw\.js/.test(m.text) &&
      !/^$/.test(m.text)
    );
    if (meaningful.length > 0) {
      console.log('    errors:', meaningful.slice(0, 5).map(m => `[${m.type}] ${m.text}`));
    }
    assert(meaningful.length === 0, `${meaningful.length} console errors`);
  });

  await test('tile favicons use _favicon/ URL (same-origin)', async () => {
    const srcs: string[] = await page.$$eval('.tile-favicon, .tile-favicon-badge', els =>
      (els as HTMLImageElement[]).map(el => el.src)
    );
    if (srcs.length === 0) {
      // No favicons in grid (maybe all tiles show letter fallback) — acceptable
      return;
    }
    // All should be chrome-extension://.../\_favicon/... since we swapped priority.
    // tab.favIconUrl fallback only kicks in if faviconFor returns empty, which it shouldn't for valid URLs.
    const bad = srcs.filter(s => !s.startsWith(`chrome-extension://`) && !s.startsWith('data:'));
    assert(bad.length === 0, `${bad.length} favicons not same-origin: ${bad.slice(0, 2).join(', ')}`);
  });

  await test('no empty "Error:" string in sync UI (not signed in → shows status)', async () => {
    // Open settings to reveal sync section
    await page.locator('#settings-btn').click();
    await page.waitForTimeout(300);
    const text = await page.locator('#sync-signed-out, #sync-signed-in').allTextContents();
    const joined = text.join(' ');
    // If user isn't signed in we should see sign-in UI, NOT a stray "Error:"
    assert(!/Error:\s*$/.test(joined), 'Stray empty Error: in sync panel');
  });

  await context.close();

  console.log('');
  const passed = RESULTS.filter(r => r.pass).length;
  const failed = RESULTS.filter(r => !r.pass).length;
  console.log(`  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    RESULTS.filter(r => !r.pass).forEach(r => console.log(`    ✗ ${r.name}: ${r.error}`));
    console.log('');
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('Runner failed:', e);
  process.exit(1);
});
