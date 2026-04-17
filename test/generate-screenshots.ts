/**
 * Generate marketing screenshots with real page thumbnails.
 *
 * Opens tabs, cycles through them to trigger screenshot capture,
 * then opens speed dial to take the final screenshot.
 */

import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';

const EXT_PATH = path.resolve(__dirname, '../extension');
const OUT_DIR = path.resolve(__dirname, '../web');

const GROUPS = [
  { name: 'Work',     color: 'blue',   urls: ['https://mail.google.com', 'https://docs.google.com', 'https://calendar.google.com'] },
  { name: 'Social',   color: 'pink',   urls: ['https://twitter.com', 'https://reddit.com'] },
  { name: 'Dev',      color: 'green',  urls: ['https://github.com', 'https://stackoverflow.com', 'https://developer.mozilla.org'] },
  { name: 'Trading',  color: 'yellow', urls: ['https://www.coingecko.com', 'https://www.tradingview.com'] },
  { name: 'Research', color: 'purple', urls: ['https://arxiv.org', 'https://scholar.google.com'] },
  { name: 'Media',    color: 'red',    urls: ['https://youtube.com', 'https://spotify.com'] },
  { name: 'Infra',    color: 'cyan',   urls: ['https://dash.cloudflare.com'] },
  { name: 'Notes',    color: 'orange', urls: ['https://notion.so'] },
];

async function main() {
  console.log('Launching Chromium...');
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

  // Get extension ID
  let extensionId = '';
  const sw = context.serviceWorkers();
  if (sw.length > 0) {
    extensionId = sw[0].url().split('/')[2];
  } else {
    const worker = await context.waitForEvent('serviceworker', { timeout: 10000 });
    extensionId = worker.url().split('/')[2];
  }
  console.log(`Extension: ${extensionId}`);
  const extUrl = `chrome-extension://${extensionId}/newtab.html`;

  // Open all tabs
  console.log('Opening tabs...');
  const pages: any[] = [];
  for (const group of GROUPS) {
    for (const url of group.urls) {
      const p = await context.newPage();
      try {
        await p.goto(url, { timeout: 8000, waitUntil: 'domcontentloaded' });
      } catch {}
      pages.push(p);
    }
  }

  // Wait for pages to settle
  console.log('Waiting for pages to load...');
  await new Promise(r => setTimeout(r, 5000));

  // Cycle through each tab to trigger screenshot capture
  console.log('Cycling tabs to capture thumbnails...');
  for (const p of pages) {
    try {
      await p.bringToFront();
      await new Promise(r => setTimeout(r, 2500)); // Background captures after 2s
    } catch {}
  }

  // Open speed dial and create groups
  console.log('Setting up groups...');
  const dial = await context.newPage();
  await dial.goto(extUrl);
  await dial.waitForTimeout(2000);

  // Create tab groups via Chrome API
  await dial.evaluate(async (groups) => {
    const allTabs = await chrome.tabs.query({});
    const realTabs = allTabs.filter(t =>
      !t.url?.startsWith('chrome-extension://') &&
      t.url !== 'about:blank' &&
      t.url !== 'chrome://newtab/'
    );

    let idx = 0;
    for (const group of groups) {
      const tabIds: number[] = [];
      for (let i = 0; i < group.urls.length && idx < realTabs.length; i++, idx++) {
        tabIds.push(realTabs[idx].id!);
      }
      if (tabIds.length > 0) {
        const gid = await chrome.tabs.group({ tabIds });
        await chrome.tabGroups.update(gid, {
          title: group.name,
          color: group.color as chrome.tabGroups.ColorEnum
        });
      }
    }
  }, GROUPS);

  // Reload to pick up groups + thumbnails
  await dial.goto(extUrl);
  await dial.waitForTimeout(3000);

  // Dark theme screenshot
  console.log('Taking dark screenshot...');
  await dial.screenshot({ path: `${OUT_DIR}/screenshot-dark.png`, fullPage: false });

  // Switch to light theme
  await dial.locator('#settings-btn').click();
  await dial.waitForTimeout(200);
  await dial.locator('.toggle-track').first().click();
  await dial.waitForTimeout(500);
  await dial.click('body');
  await dial.waitForTimeout(300);

  // Light theme screenshot
  console.log('Taking light screenshot...');
  await dial.screenshot({ path: `${OUT_DIR}/screenshot-light.png`, fullPage: false });

  console.log('Done! Screenshots saved to web/');
  await context.close();
}

main().catch(e => { console.error(e); process.exit(1); });
