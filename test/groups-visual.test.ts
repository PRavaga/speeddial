/**
 * Speed Dial — Tab Groups Visual Test
 *
 * Creates tab groups with all 9 Chrome colors and screenshots the result.
 * Run: npx tsx test/groups-visual.test.ts
 */

import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';

const EXT_PATH = path.resolve(__dirname, '../extension');
const SCREENSHOT_DIR = '/tmp/speeddial-test';

const GROUPS = [
  { name: 'Work',      color: 'blue',   urls: ['https://mail.google.com', 'https://docs.google.com', 'https://calendar.google.com'] },
  { name: 'Social',    color: 'pink',   urls: ['https://twitter.com', 'https://reddit.com'] },
  { name: 'Dev',       color: 'green',  urls: ['https://github.com', 'https://stackoverflow.com', 'https://developer.mozilla.org'] },
  { name: 'Trading',   color: 'yellow', urls: ['https://www.coingecko.com', 'https://www.tradingview.com'] },
  { name: 'Research',  color: 'purple', urls: ['https://arxiv.org', 'https://scholar.google.com'] },
  { name: 'Media',     color: 'red',    urls: ['https://youtube.com', 'https://spotify.com'] },
  { name: 'Infra',     color: 'cyan',   urls: ['https://dash.cloudflare.com'] },
  { name: 'Notes',     color: 'orange', urls: ['https://notion.so', 'https://obsidian.md'] },
  { name: 'Misc',      color: 'grey',   urls: ['https://example.com', 'https://httpbin.org'] },
];

async function main() {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  console.log('Launching Chromium with extension...');
  const context = await chromium.launchPersistentContext('', {
    headless: false,
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--no-first-run',
      '--disable-default-apps',
    ],
    viewport: { width: 1920, height: 1080 },
  });

  // Wait for service worker
  let extensionId = '';
  const sw = context.serviceWorkers();
  if (sw.length > 0) {
    extensionId = sw[0].url().split('/')[2];
  } else {
    const worker = await context.waitForEvent('serviceworker', { timeout: 10000 });
    extensionId = worker.url().split('/')[2];
  }
  console.log(`Extension ID: ${extensionId}\n`);

  // Create tabs and groups
  console.log('Creating tab groups...');
  for (const group of GROUPS) {
    const tabIds: number[] = [];
    for (const url of group.urls) {
      const page = await context.newPage();
      try {
        await page.goto(url, { timeout: 5000, waitUntil: 'domcontentloaded' });
      } catch {}
      // Get the tab ID via the Chrome extension API
      const targets = context.pages();
      // We'll group by Chrome API from the extension page later
    }
  }

  // Wait for pages to load
  await new Promise(r => setTimeout(r, 3000));

  // Open speed dial page and use it to create groups via Chrome API
  const speedDial = await context.newPage();
  await speedDial.goto(`chrome-extension://${extensionId}/newtab.html`);
  await speedDial.waitForTimeout(2000);

  // Create groups using chrome.tabs API from the extension page
  console.log('Organizing into groups via Chrome API...');
  await speedDial.evaluate(async (groups) => {
    const allTabs = await chrome.tabs.query({});
    // Skip the speed dial tab itself and the initial blank tab
    const realTabs = allTabs.filter(t =>
      !t.url?.startsWith('chrome-extension://') &&
      t.url !== 'about:blank' &&
      t.url !== 'chrome://newtab/'
    );

    let tabIndex = 0;
    for (const group of groups) {
      const tabIds: number[] = [];
      for (let i = 0; i < group.urls.length && tabIndex < realTabs.length; i++, tabIndex++) {
        tabIds.push(realTabs[tabIndex].id!);
      }
      if (tabIds.length > 0) {
        const groupId = await chrome.tabs.group({ tabIds });
        await chrome.tabGroups.update(groupId, {
          title: group.name,
          color: group.color as chrome.tabGroups.ColorEnum
        });
      }
    }
  }, GROUPS);

  // Reload speed dial to pick up the groups
  await speedDial.goto(`chrome-extension://${extensionId}/newtab.html`);
  await speedDial.waitForTimeout(3000);

  // Screenshot: All groups dark theme
  console.log('Taking screenshots...');
  await speedDial.screenshot({
    path: `${SCREENSHOT_DIR}/groups-dark-all.png`,
    fullPage: true
  });
  console.log('  Saved: groups-dark-all.png');

  // Click through each group tab and screenshot
  const groupTabs = speedDial.locator('.group-tab');
  const tabCount = await groupTabs.count();
  console.log(`  ${tabCount} group tabs found`);

  for (let i = 0; i < Math.min(tabCount, 4); i++) {
    const name = await groupTabs.nth(i).locator('.group-tab-name').textContent();
    await groupTabs.nth(i).click();
    await speedDial.waitForTimeout(500);
    await speedDial.screenshot({
      path: `${SCREENSHOT_DIR}/groups-dark-${name?.toLowerCase() || i}.png`,
      fullPage: true
    });
    console.log(`  Saved: groups-dark-${name?.toLowerCase() || i}.png`);
  }

  // Switch back to All
  await groupTabs.nth(0).click();
  await speedDial.waitForTimeout(300);

  // Switch to light theme
  await speedDial.locator('#settings-btn').click();
  await speedDial.waitForTimeout(200);
  await speedDial.locator('.toggle-track').first().click();
  await speedDial.waitForTimeout(500);
  await speedDial.click('body');
  await speedDial.waitForTimeout(300);

  await speedDial.screenshot({
    path: `${SCREENSHOT_DIR}/groups-light-all.png`,
    fullPage: true
  });
  console.log('  Saved: groups-light-all.png');

  // Switch back to dark
  await speedDial.locator('#settings-btn').click();
  await speedDial.waitForTimeout(200);
  await speedDial.locator('.toggle-track').first().click();
  await speedDial.waitForTimeout(300);
  await speedDial.click('body');

  // Log summary
  const stats = await speedDial.locator('#stats').textContent();
  console.log(`\nStats: ${stats}`);

  // Verify all group colors are visible
  const dots = await speedDial.locator('.group-tab-dot').count();
  console.log(`Group dots rendered: ${dots}`);

  // Check tile group badges in "All" view
  const badges = await speedDial.locator('.tile-group-badge').count();
  console.log(`Group badges on tiles: ${badges}`);

  const tiles = await speedDial.locator('.tile').count();
  console.log(`Total tiles: ${tiles}`);

  console.log(`\nScreenshots saved to ${SCREENSHOT_DIR}/`);
  console.log('Done!');

  await context.close();
}

main().catch(e => {
  console.error('Failed:', e);
  process.exit(1);
});
