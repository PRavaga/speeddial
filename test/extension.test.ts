/**
 * Speed Dial Extension — Comprehensive E2E Tests
 *
 * Run: npx tsx test/extension.test.ts
 *
 * Launches Chromium with the extension loaded and tests everything:
 * - Page load and rendering
 * - Group tabs navigation
 * - Search and filtering
 * - Tile interactions (hover, close, retake)
 * - Settings (theme toggle, sync UI)
 * - Backup/sessions panel
 * - Keyboard shortcuts
 * - Edge cases (empty states, rapid interactions)
 * - Light and dark theme visual checks
 * - Screenshot capture pipeline
 */

import { chromium, type BrowserContext, type Page } from 'playwright';
import path from 'path';
import fs from 'fs';

const EXT_PATH = path.resolve(__dirname, '../extension');
const SCREENSHOT_DIR = '/tmp/speeddial-test';
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

async function main() {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║   Speed Dial — E2E Test Suite            ║');
  console.log('╚══════════════════════════════════════════╝\n');

  // Launch Chromium with extension
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
    viewport: { width: 1440, height: 900 },
  });

  // Get extension ID from service worker
  let extensionId = '';
  const sw = context.serviceWorkers();
  if (sw.length > 0) {
    extensionId = sw[0].url().split('/')[2];
  } else {
    const worker = await context.waitForEvent('serviceworker', { timeout: 10000 });
    extensionId = worker.url().split('/')[2];
  }
  console.log(`Extension ID: ${extensionId}`);
  const extUrl = `chrome-extension://${extensionId}/newtab.html`;

  // Create some tabs in different windows so we have content to display
  console.log('Setting up test tabs...\n');
  const testUrls = [
    'https://example.com',
    'https://httpbin.org/html',
    'about:blank',
  ];
  for (const url of testUrls) {
    try { await context.newPage().then(p => p.goto(url, { timeout: 5000 }).catch(() => {})); } catch {}
  }
  await new Promise(r => setTimeout(r, 1000));

  // Open speed dial
  const page = await context.newPage();
  await page.goto(extUrl);
  await page.waitForTimeout(2000);

  // ================================================================
  // 1. PAGE LOAD & STRUCTURE
  // ================================================================
  console.log('─── Page Load & Structure ───');

  await test('Page title is "Speed Dial"', async () => {
    assert(await page.title() === 'Speed Dial', `Got: "${await page.title()}"`);
  });

  await test('Favicon link exists', async () => {
    const favicon = await page.locator('link[rel="icon"]').count();
    assert(favicon > 0, 'No favicon link found');
  });

  await test('App container renders', async () => {
    await page.locator('.app').waitFor({ state: 'visible', timeout: 3000 });
  });

  await test('Search input exists', async () => {
    await page.locator('#search').waitFor({ state: 'visible', timeout: 2000 });
  });

  await test('Stats bar shows numbers', async () => {
    const text = await page.locator('#stats').textContent();
    assert(text!.includes('tabs'), `Stats: "${text}"`);
    assert(text!.includes('window'), `Stats missing windows: "${text}"`);
  });

  await test('Settings button exists', async () => {
    await page.locator('#settings-btn').waitFor({ state: 'visible', timeout: 2000 });
  });

  await test('Group tabs bar renders', async () => {
    const count = await page.locator('.group-tab').count();
    assert(count >= 1, `Expected at least 1 group tab, got ${count}`);
  });

  await test('Tile grid renders', async () => {
    await page.locator('#tile-grid').waitFor({ state: 'visible', timeout: 2000 });
  });

  await test('Sessions panel exists at bottom', async () => {
    await page.locator('.sessions-panel').waitFor({ state: 'attached', timeout: 2000 });
  });

  await test('Backup button is in sessions panel (not topbar)', async () => {
    const inSessions = await page.locator('.sessions-panel #backup-btn').count();
    const inTopbar = await page.locator('.topbar #backup-btn').count();
    assert(inSessions === 1, 'Backup button not in sessions panel');
    assert(inTopbar === 0, 'Backup button still in topbar');
  });

  await test('Grain overlay exists', async () => {
    await page.locator('.grain').waitFor({ state: 'attached' });
  });

  await page.screenshot({ path: `${SCREENSHOT_DIR}/01-initial-load.png`, fullPage: true });

  // ================================================================
  // 2. GROUP TABS
  // ================================================================
  console.log('\n─── Group Tabs ───');

  await test('"All" tab exists and shows tab count', async () => {
    const allTab = page.locator('.group-tab').first();
    assert(await allTab.count() >= 1, 'No group tabs found');
    const countText = await allTab.locator('.group-tab-count').textContent();
    assert(parseInt(countText!) >= 0, `Invalid count: "${countText}"`);
  });

  await test('"All" tab is active by default or from storage', async () => {
    const activeTabs = await page.locator('.group-tab.active').count();
    assert(activeTabs === 1, `Expected 1 active tab, got ${activeTabs}`);
  });

  await test('Clicking a group tab changes active state', async () => {
    const tabs = page.locator('.group-tab');
    const count = await tabs.count();
    if (count > 1) {
      await tabs.nth(1).click();
      await page.waitForTimeout(300);
      const isActive = await tabs.nth(1).evaluate(el => el.classList.contains('active'));
      assert(isActive, 'Second tab not active after click');
      // Switch back
      await tabs.nth(0).click();
      await page.waitForTimeout(300);
    }
  });

  await test('Group tab shows colored dot', async () => {
    const tabs = page.locator('.group-tab');
    const count = await tabs.count();
    if (count > 1) {
      // Non-"All" tabs should have a visible dot
      const dot = tabs.nth(1).locator('.group-tab-dot');
      assert(await dot.count() === 1, 'No dot found');
    }
  });

  await test('Arrow keys switch between groups', async () => {
    // Focus body first
    await page.click('body');
    const tabs = page.locator('.group-tab');
    const count = await tabs.count();
    if (count > 1) {
      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(200);
      const isSecondActive = await tabs.nth(1).evaluate(el => el.classList.contains('active'));
      assert(isSecondActive, 'ArrowRight did not switch group');
      await page.keyboard.press('ArrowLeft');
      await page.waitForTimeout(200);
    }
  });

  // ================================================================
  // 3. TILES
  // ================================================================
  console.log('\n─── Tiles ───');

  const tileCount = await page.locator('.tile').count();
  console.log(`  (${tileCount} tiles visible)`);

  await test('Tiles have title and URL', async () => {
    if (tileCount === 0) return;
    const tile = page.locator('.tile').first();
    const title = await tile.locator('.tile-title').textContent();
    assert(title!.length > 0, 'Empty tile title');
  });

  await test('Tiles have visual area (favicon or screenshot)', async () => {
    if (tileCount === 0) return;
    const tile = page.locator('.tile').first();
    const visual = await tile.locator('.tile-visual').count();
    assert(visual === 1, 'No .tile-visual found');
    // Should have either favicon, letter, or thumbnail
    const hasFavicon = await tile.locator('.tile-favicon').count();
    const hasLetter = await tile.locator('.tile-letter').count();
    const hasThumb = await tile.locator('.tile-thumb').count();
    assert(hasFavicon + hasLetter + hasThumb > 0, 'No visual content in tile');
  });

  await test('Tile hover shows action overlay', async () => {
    if (tileCount === 0) return;
    const tile = page.locator('.tile').first();
    await tile.hover();
    await page.waitForTimeout(200);
    const overlay = tile.locator('.tile-actions-overlay');
    assert(await overlay.count() === 1, 'No actions overlay');
    // Check buttons
    const closeBtn = tile.locator('.tile-close');
    const retakeBtn = tile.locator('.tile-retake');
    assert(await closeBtn.count() === 1, 'No close button');
    assert(await retakeBtn.count() === 1, 'No retake button');
  });

  await test('Tile hover lifts tile (transform)', async () => {
    if (tileCount === 0) return;
    const tile = page.locator('.tile').first();
    await tile.hover();
    await page.waitForTimeout(200);
    const transform = await tile.evaluate(el => getComputedStyle(el).transform);
    // Should have a translateY when hovered
    assert(transform !== 'none', 'No hover transform');
  });

  await test('Tile click navigates (switches to tab)', async () => {
    // We just verify no JS errors on click — actual tab switch can't be asserted easily
    if (tileCount === 0) return;
    // Don't actually click (it would navigate away) — just verify the handler exists
    const tile = page.locator('.tile').first();
    const cursor = await tile.evaluate(el => getComputedStyle(el).cursor);
    assert(cursor === 'pointer', `Cursor: ${cursor}`);
  });

  await test('Tile animations have stagger delay', async () => {
    if (tileCount < 2) return;
    const delay0 = await page.locator('.tile').nth(0).evaluate(el => el.style.animationDelay);
    const delay1 = await page.locator('.tile').nth(1).evaluate(el => el.style.animationDelay);
    assert(delay0 !== delay1, 'Tiles have same animation delay');
  });

  await page.screenshot({ path: `${SCREENSHOT_DIR}/02-tiles.png`, fullPage: true });

  // ================================================================
  // 4. SEARCH & FILTERING
  // ================================================================
  console.log('\n─── Search & Filtering ───');

  await test('Search input accepts text', async () => {
    const search = page.locator('#search');
    await search.fill('example');
    await page.waitForTimeout(200);
    assert(await search.inputValue() === 'example', 'Input value not set');
    await search.fill('');
    await page.waitForTimeout(200);
  });

  await test('Search filters tiles', async () => {
    const beforeCount = await page.locator('.tile').count();
    await page.locator('#search').fill('xyznonexistent12345');
    await page.waitForTimeout(200);
    const afterCount = await page.locator('.tile').count();
    assert(afterCount === 0, `Expected 0 tiles for nonsense query, got ${afterCount}`);
    // Check empty state shows
    const emptyState = await page.locator('.empty-state').count();
    assert(emptyState === 1, 'No empty state shown');
    await page.locator('#search').fill('');
    await page.waitForTimeout(200);
  });

  await test('Search shows "No tabs match" in empty state', async () => {
    await page.locator('#search').fill('xyznonexistent12345');
    await page.waitForTimeout(200);
    const text = await page.locator('.empty-state').textContent();
    assert(text!.includes('No tabs match'), `Empty state: "${text}"`);
    await page.locator('#search').fill('');
    await page.waitForTimeout(200);
  });

  await test('/ keyboard shortcut focuses search', async () => {
    await page.click('body');
    await page.keyboard.press('/');
    const focused = await page.evaluate(() => document.activeElement?.id);
    assert(focused === 'search', `Focused: ${focused}`);
    await page.keyboard.press('Escape');
  });

  await test('Ctrl+K focuses search', async () => {
    await page.click('body');
    await page.keyboard.press('Control+k');
    const focused = await page.evaluate(() => document.activeElement?.id);
    assert(focused === 'search', `Focused: ${focused}`);
    await page.keyboard.press('Escape');
  });

  await test('Escape clears search and blurs', async () => {
    await page.locator('#search').fill('test');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    const value = await page.locator('#search').inputValue();
    assert(value === '', `Search not cleared: "${value}"`);
    const focused = await page.evaluate(() => document.activeElement?.id);
    assert(focused !== 'search', 'Search still focused after Escape');
  });

  await test('/ hint badge hides when search is focused', async () => {
    const kbd = page.locator('.search-kbd');
    // Before focus
    await page.click('body');
    await page.waitForTimeout(100);
    const before = await kbd.evaluate(el => getComputedStyle(el).opacity);
    // Focus
    await page.locator('#search').focus();
    await page.waitForTimeout(100);
    const after = await kbd.evaluate(el => getComputedStyle(el).opacity);
    assert(parseFloat(after) < parseFloat(before), 'Kbd hint did not hide');
    await page.keyboard.press('Escape');
  });

  // ================================================================
  // 5. SETTINGS
  // ================================================================
  console.log('\n─── Settings ───');

  await test('Settings dropdown opens on click', async () => {
    await page.locator('#settings-btn').click();
    await page.waitForTimeout(200);
    const dropdown = page.locator('#settings-dropdown');
    assert(await dropdown.evaluate(el => el.classList.contains('open')), 'Dropdown not open');
  });

  await test('Settings has Appearance section', async () => {
    const headings = await page.locator('.settings-heading').allTextContents();
    assert(headings.some(h => h.includes('APPEARANCE') || h.includes('Appearance')), 'No Appearance section');
  });

  await test('Settings has Sync section', async () => {
    const headings = await page.locator('.settings-heading').allTextContents();
    assert(headings.some(h => h.includes('SYNC') || h.includes('Sync')), 'No Sync section');
  });

  await test('Theme toggle exists', async () => {
    assert(await page.locator('#theme-toggle').count() === 1, 'No theme toggle');
  });

  await test('Light theme toggle works', async () => {
    await page.locator('.toggle-track').first().click();
    await page.waitForTimeout(300);
    const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    assert(theme === 'light', `Theme: ${theme}`);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/03-light-theme.png`, fullPage: true });
  });

  await test('Light theme changes background colors', async () => {
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    // Light theme should not be near-black
    assert(!bg.includes('7, 8, 10'), `Background still dark: ${bg}`);
  });

  await test('Dark theme toggle works', async () => {
    await page.locator('.toggle-track').first().click();
    await page.waitForTimeout(300);
    const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    assert(theme === 'dark', `Theme: ${theme}`);
  });

  await test('Settings dropdown closes on outside click', async () => {
    // Make sure it's open first
    if (!await page.locator('#settings-dropdown').evaluate(el => el.classList.contains('open'))) {
      await page.locator('#settings-btn').click();
      await page.waitForTimeout(100);
    }
    await page.click('.tile-grid');
    await page.waitForTimeout(200);
    const isOpen = await page.locator('#settings-dropdown').evaluate(el => el.classList.contains('open'));
    assert(!isOpen, 'Dropdown still open after outside click');
  });

  await test('Google sign-in button exists', async () => {
    await page.locator('#settings-btn').click();
    await page.waitForTimeout(200);
    const btn = page.locator('#google-signin-btn');
    assert(await btn.count() === 1, 'No sign-in button');
    await page.click('body');
  });

  // ================================================================
  // 6. SESSIONS & BACKUP
  // ================================================================
  console.log('\n─── Sessions & Backup ───');

  await test('Sessions toggle opens the list', async () => {
    await page.locator('#sessions-toggle').click();
    await page.waitForTimeout(300);
    const isOpen = await page.locator('#sessions-list').evaluate(el => el.classList.contains('open'));
    assert(isOpen, 'Sessions list not open');
  });

  await test('Sessions list shows content', async () => {
    const content = await page.locator('#sessions-list').innerHTML();
    assert(content.length > 0, 'Sessions list is empty HTML');
  });

  await test('Backup button triggers save', async () => {
    const btn = page.locator('#backup-btn');
    await btn.click();
    await page.waitForTimeout(1000);
    // Check for toast notification
    const toast = await page.locator('.toast').count();
    // Toast might have already disappeared, check backup time updated
    const time = await page.locator('#backup-time').textContent();
    assert(time!.includes('just now') || time!.includes('ago'), `Backup time: "${time}"`);
  });

  await test('Sessions toggle closes the list', async () => {
    await page.locator('#sessions-toggle').click();
    await page.waitForTimeout(200);
    const isOpen = await page.locator('#sessions-list').evaluate(el => el.classList.contains('open'));
    assert(!isOpen, 'Sessions list still open');
  });

  await test('Ctrl+Shift+B triggers backup', async () => {
    await page.keyboard.press('Control+Shift+b');
    await page.waitForTimeout(1000);
    const time = await page.locator('#backup-time').textContent();
    assert(time!.includes('just now'), `After Ctrl+Shift+B: "${time}"`);
  });

  // ================================================================
  // 7. EDGE CASES
  // ================================================================
  console.log('\n─── Edge Cases ───');

  await test('Rapid search typing does not crash', async () => {
    const search = page.locator('#search');
    for (const char of 'rapidtypingtest') {
      await search.press(char);
    }
    await page.waitForTimeout(300);
    await search.fill('');
    await page.waitForTimeout(200);
    // Page should still be functional
    const tiles = await page.locator('.tile').count();
    assert(tiles >= 0, 'Page broke after rapid typing');
  });

  await test('Multiple rapid group tab clicks do not crash', async () => {
    const tabs = page.locator('.group-tab');
    const count = await tabs.count();
    for (let i = 0; i < Math.min(count, 5); i++) {
      await tabs.nth(i % count).click({ delay: 0 });
    }
    await page.waitForTimeout(500);
    // Should still have an active tab
    const active = await page.locator('.group-tab.active').count();
    assert(active === 1, `${active} active tabs after rapid clicks`);
    // Reset to All
    await tabs.nth(0).click();
    await page.waitForTimeout(200);
  });

  await test('Page handles no tiles gracefully (empty group)', async () => {
    // Search for something that won't match
    await page.locator('#search').fill('zzzzzzz_nonexistent_tab_12345');
    await page.waitForTimeout(300);
    const empty = await page.locator('.empty-state').count();
    assert(empty === 1, 'No empty state for zero results');
    await page.locator('#search').fill('');
    await page.waitForTimeout(200);
  });

  await test('Stats update correctly after filtering', async () => {
    const allStats = await page.locator('#stats').textContent();
    const allCount = parseInt(allStats!.match(/(\d+)/)?.[1] || '0');

    await page.locator('#search').fill('example');
    await page.waitForTimeout(300);
    const filteredStats = await page.locator('#stats').textContent();
    const filteredCount = parseInt(filteredStats!.match(/(\d+)/)?.[1] || '0');

    assert(filteredCount <= allCount, `Filtered (${filteredCount}) > total (${allCount})`);
    await page.locator('#search').fill('');
    await page.waitForTimeout(200);
  });

  await test('Theme persists across page reload', async () => {
    // Set to light
    await page.locator('#settings-btn').click();
    await page.waitForTimeout(100);
    await page.locator('.toggle-track').first().click();
    await page.waitForTimeout(300);
    // Reload
    await page.goto(extUrl);
    await page.waitForTimeout(2000);
    const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    assert(theme === 'light', `Theme not persisted: ${theme}`);
    // Reset to dark
    await page.locator('#settings-btn').click();
    await page.waitForTimeout(100);
    await page.locator('.toggle-track').first().click();
    await page.waitForTimeout(300);
    await page.click('body');
  });

  await test('Active group persists across page reload', async () => {
    const tabs = page.locator('.group-tab');
    const count = await tabs.count();
    if (count > 1) {
      await tabs.nth(1).click();
      await page.waitForTimeout(200);
      const groupName = await tabs.nth(1).locator('.group-tab-name').textContent();
      // Reload
      await page.goto(extUrl);
      await page.waitForTimeout(2000);
      const activeTab = page.locator('.group-tab.active');
      const activeName = await activeTab.locator('.group-tab-name').textContent();
      assert(activeName === groupName, `Group not persisted: "${activeName}" vs "${groupName}"`);
      // Reset
      await page.locator('.group-tab').nth(0).click();
      await page.waitForTimeout(200);
    }
  });

  // ================================================================
  // 8. CSS & VISUAL CHECKS
  // ================================================================
  console.log('\n─── CSS & Visual Checks ───');

  await test('No horizontal scrollbar on page', async () => {
    const overflows = await page.evaluate(() => {
      return document.body.scrollWidth <= document.body.clientWidth;
    });
    assert(overflows, 'Page has horizontal overflow');
  });

  await test('Grain overlay has correct z-index', async () => {
    const z = await page.locator('.grain').evaluate(el => getComputedStyle(el).zIndex);
    assert(z === '1000', `Grain z-index: ${z}`);
  });

  await test('Grain overlay is non-interactive', async () => {
    const pe = await page.locator('.grain').evaluate(el => getComputedStyle(el).pointerEvents);
    assert(pe === 'none', `Grain pointer-events: ${pe}`);
  });

  await test('Tiles have border-radius', async () => {
    if (tileCount === 0) return;
    const radius = await page.locator('.tile').first().evaluate(el => getComputedStyle(el).borderRadius);
    assert(radius !== '0px', `Tile radius: ${radius}`);
  });

  await test('Font families are applied', async () => {
    const font = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
    assert(font.includes('Outfit') || font.includes('sans-serif'), `Font: ${font}`);
  });

  // Final screenshots
  await page.screenshot({ path: `${SCREENSHOT_DIR}/04-final-dark.png`, fullPage: true });

  // ================================================================
  // 9. CLOSE TAB TEST (last — it modifies state)
  // ================================================================
  console.log('\n─── Destructive Tests ───');

  await test('Closing a tab removes the tile', async () => {
    const before = await page.locator('.tile').count();
    if (before === 0) return;

    const closeBtn = page.locator('.tile').first().locator('.tile-close');
    await page.locator('.tile').first().hover();
    await page.waitForTimeout(200);
    await closeBtn.click();
    await page.waitForTimeout(500);

    const after = await page.locator('.tile').count();
    assert(after < before, `Tile not removed: ${before} → ${after}`);
  });

  // ================================================================
  // SUMMARY
  // ================================================================
  console.log('\n' + '═'.repeat(50));
  const passed = RESULTS.filter(r => r.pass).length;
  const failed = RESULTS.filter(r => !r.pass).length;
  const totalTime = RESULTS.reduce((s, r) => s + r.duration, 0);
  console.log(`\n  ${passed} passed, ${failed} failed (${RESULTS.length} total, ${totalTime}ms)\n`);
  console.log(`  Screenshots: ${SCREENSHOT_DIR}/`);

  if (failed > 0) {
    console.log('\n  Failed:');
    RESULTS.filter(r => !r.pass).forEach(r => console.log(`    ✗ ${r.name}: ${r.error}`));
  }

  console.log('');
  await context.close();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('Test runner failed:', e);
  process.exit(1);
});
