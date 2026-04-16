# Speed Dial — Sync Setup Guide

## Overview

Extension + Cloudflare Worker + Google OAuth. All data encrypted client-side (AES-256-GCM).

```
Extension ←→ Sync API (CF Worker + KV) ←→ Web App (future)
    ↓              ↓
Google OAuth    Encrypted JSON blobs
```

---

## Step 1: Load extension and get stable ID

1. Open Edge (or Chrome)
2. Go to `edge://extensions` (or `chrome://extensions`)
3. Enable **Developer mode** (top-right toggle)
4. If Speed Dial was loaded before, **remove it** first (manifest key changed = new ID)
5. Click **Load unpacked** → `\\wsl$\Ubuntu\home\ravaga\webworks\speeddial\extension`
6. Copy the **extension ID** from the card (e.g. `abcdefghijklmnopqrstuvwxyz012345`)

This ID is permanent — derived from the RSA key in `manifest.json`.

---

## Step 2: Create Google OAuth Client ID

1. Go to https://console.cloud.google.com/
2. Sign in with `pavel@ravaga.com`
3. **Create project** (or reuse existing):
   - Top-left dropdown → "New Project" → Name: `Speed Dial` → Create
   - Select the new project
4. **Configure consent screen**:
   - Left menu → "APIs & Services" → "OAuth consent screen"
   - User Type: **External** → Create
   - App name: `Speed Dial`
   - User support email: `pavel@ravaga.com`
   - Developer contact: `pavel@ravaga.com`
   - Skip scopes (requested at runtime)
   - **Test users**: add `trueravaga@gmail.com`
   - Save → Back to dashboard
5. **Create credentials**:
   - Left menu → "APIs & Services" → "Credentials"
   - **+ CREATE CREDENTIALS** → "OAuth client ID"
   - Application type: **Web application**
   - Name: `Speed Dial Extension`
   - **Authorized redirect URIs** → Add URI:
     ```
     https://<EXTENSION-ID>.chromiumapp.org/
     ```
     (use the ID from Step 1, include `https://` and trailing `/`)
   - Click **Create**
6. **Copy the Client ID** (format: `123456789-abcdef.apps.googleusercontent.com`)

> Note: The app is in "Testing" mode — only test users can sign in.
> To open it up later: OAuth consent screen → Publish App.

---

## Step 3: Authenticate Cloudflare Wrangler

```bash
cd ~/webworks/speeddial/api
npx wrangler login
```

This opens a browser tab. Sign in with your Cloudflare account and authorize.

Verify:
```bash
npx wrangler whoami
```

---

## Step 4: Create KV namespace

```bash
cd ~/webworks/speeddial/api
npx wrangler kv namespace create SYNC_KV
```

Output will show something like:
```
{ binding = "SYNC_KV", id = "abc123..." }
```

Copy the `id` value.

---

## Step 5: Configure wrangler.toml

Edit `~/webworks/speeddial/api/wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "SYNC_KV"
id = "<paste KV namespace ID from Step 4>"

[vars]
GOOGLE_CLIENT_ID = "<paste Client ID from Step 2>"
ALLOWED_ORIGINS = "chrome-extension://<EXTENSION-ID>"
```

> For future web app, add its origin too:
> `ALLOWED_ORIGINS = "chrome-extension://<ID>,https://speeddial.yourdomain.com"`

---

## Step 6: Deploy the Worker

```bash
cd ~/webworks/speeddial/api
npx wrangler deploy
```

Output shows the Worker URL:
```
Published speeddial-sync (...)
  https://speeddial-sync.<account>.workers.dev
```

Test it:
```bash
curl https://speeddial-sync.<account>.workers.dev/api/health
# Should return: {"ok":true,"ts":...}
```

---

## Step 7: Configure the extension

Open a new tab (Speed Dial page), press `F12` → Console, run:

```js
chrome.storage.local.set({ config: {
  googleClientId: '<CLIENT-ID>.apps.googleusercontent.com',
  syncApiUrl: 'https://speeddial-sync.<account>.workers.dev'
}})
```

---

## Step 8: Test sign-in and sync

1. Close the new tab, open a fresh one
2. Click the **gear icon** (settings)
3. Under "Sync", click **Sign in**
4. Google sign-in popup opens → authenticate with `trueravaga@gmail.com`
5. Should show avatar, email, and "Synced just now"
6. Click the sync button (arrows icon) to manual sync anytime

---

## Architecture Notes

### What syncs
- Saved sessions (tab backups) — merged by timestamp, union, max 20
- Settings (theme) — last-write-wins
- Pinned sites (future) — merged by URL

### What doesn't sync
- Live tab state (browser-specific)
- Thumbnails (too large, browser-specific)
- Collapsed group state (UI preference per browser)

### Encryption
- Key derivation: PBKDF2(passphrase="speeddial-v1", salt=google_user_sub, iterations=100000) → AES-256-GCM
- Server stores opaque encrypted blobs — can't read your data
- Same user on different browsers derives the same key → can decrypt each other's data

### Sync frequency
- Auto: every 15 minutes (background alarm)
- Manual: click sync button in settings
- On sign-in: immediate full sync
- After backup: background pushes if signed in

### Merge strategy
- Sessions: union by timestamp (deduplicate), keep newest 20
- Settings: compare lastModified timestamps, newest wins
- Pinned sites: merge by URL key, latest addedAt wins

### Files
```
extension/
├── auth.js      — Google OAuth 2.0 PKCE flow
├── crypto.js    — AES-256-GCM encrypt/decrypt
├── sync.js      — push/pull/merge orchestrator
├── background.js — alarms, thumbnail capture, sync triggers
├── newtab.js    — UI + sync UI
├── newtab.html/css — layout + styles
└── manifest.json — permissions, stable key

api/
├── src/index.js  — Cloudflare Worker (REST API)
├── wrangler.toml — config (KV, client ID, origins)
└── package.json
```

### Security
- PKCE (no client secret) — safe for public clients
- ID token verified server-side via Google's tokeninfo endpoint
- Client-side encryption — server is zero-knowledge
- CORS restricted to extension origin
- Refresh tokens stored in chrome.storage.local (extension-only access)

---

## Troubleshooting

### "Sign in failed"
- Check Client ID is correct in storage config
- Check redirect URI matches exactly (including trailing `/`)
- Check test user is added in Google Console

### "Sync failed: Not authenticated"
- Token may have expired — sign out and sign in again
- Check that syncApiUrl is correct in storage config

### "Sync failed: 401"
- Worker's GOOGLE_CLIENT_ID doesn't match extension's
- Redeploy Worker after updating wrangler.toml

### "CORS error"
- ALLOWED_ORIGINS in wrangler.toml must include `chrome-extension://<ID>`
- Redeploy Worker after updating

### Extension ID changed
- This happens if you remove and re-add without the `key` field
- The key is in manifest.json — as long as it's there, ID stays stable
- Private key: `~/webworks/speeddial/speeddial.pem` (gitignored)
