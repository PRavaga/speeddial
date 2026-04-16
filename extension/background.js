const MAX_BACKUPS = 20;

chrome.alarms.create('auto-backup', { periodInMinutes: 5 });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'auto-backup') await createBackup('auto');
});

chrome.runtime.onStartup.addListener(() => createBackup('startup'));
chrome.runtime.onInstalled.addListener(() => createBackup('install'));

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
      if (tab.url?.startsWith('chrome://') || tab.url?.startsWith('edge://') || tab.url?.startsWith('chrome-extension://')) continue;
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
