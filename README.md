# Speed Dial

Tab command center for Chrome and Edge. Replaces your new tab page with a live dashboard of all open tabs organized by tab groups.

## Features

- **Tab groups as columns** — each group displayed with its color, collapsible
- **Search** — filter tabs by title or URL (`/` or `Ctrl+K`)
- **Tab management** — switch to, close, or rename groups inline
- **Auto-backup** — snapshots every 5 minutes, on startup, on install
- **Session restore** — browse and restore saved tab snapshots
- **Live sync** — display updates in real-time as tabs change
- **Keyboard shortcuts** — `/` search, `Esc` clear, `Ctrl+Shift+B` manual backup

## Install (sideload)

1. Clone this repo
2. Open `chrome://extensions` or `edge://extensions`
3. Enable **Developer mode**
4. Click **Load unpacked** → select the `extension/` folder
5. Open a new tab

## Permissions

| Permission | Why |
|---|---|
| `tabs` | Read tab titles, URLs, favicons |
| `tabGroups` | Read and update tab group names/colors |
| `storage` | Persist backups and settings locally |
| `alarms` | Schedule auto-backup every 5 min |
| `favicon` | Resolve favicons for unloaded tabs |

All data stays local. No external network requests (except Google Fonts for typography).

## Stack

- Vanilla HTML/CSS/JS — no build step, no framework
- Manifest V3
- Works on Chrome 111+ and Edge 111+

## Project structure

```
speeddial/
├── extension/       # Browser extension (load this folder)
│   ├── manifest.json
│   ├── background.js
│   ├── newtab.html
│   ├── newtab.css
│   └── newtab.js
├── shared/          # (planned) Shared UI components for extension + web
├── web/             # (planned) Web app with Google auth + sync
└── api/             # (planned) Sync API (Cloudflare Workers + KV)
```

## License

MIT
