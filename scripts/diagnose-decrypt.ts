/**
 * Speed Dial — web-app decryption diagnostic
 *
 * Opens https://app.speeddial.dev/ in a visible Chromium window. Sign in with
 * the same Google account you use in the extension, then wait — the script
 * will auto-detect the "Couldn't load sessions" state, dump the envelope +
 * sub, attempt decryption manually, and print the exact failure mode.
 *
 * Run: npx tsx scripts/diagnose-decrypt.ts
 */

import { chromium } from 'playwright';

const URL = 'https://app.speeddial.dev/';
const PROFILE_DIR = '/tmp/speeddial-diag-profile';

async function main() {
  console.log('\nLaunching Chromium — a browser window will open.');
  console.log('Sign in with your main Google account (same one as the extension).');
  console.log('The diagnostic will run automatically as soon as the error state appears.\n');

  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1200, height: 800 },
    args: ['--no-first-run', '--disable-default-apps'],
  });

  const page = ctx.pages()[0] || await ctx.newPage();

  const consoleErrors: string[] = [];
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push('console.error: ' + m.text());
  });

  await page.goto(URL, { waitUntil: 'load' });

  console.log('→ Waiting up to 3 minutes for sign-in to complete…');
  await page.waitForSelector(
    '.session-card, .empty-state .reload-btn, .empty:not(.reload-btn)',
    { timeout: 180_000 }
  );

  await page.waitForTimeout(800);

  const diagnosis = await page.evaluate(async () => {
    // Helper
    const out: Record<string, unknown> = {};

    const rawAuth = localStorage.getItem('sd.syncAuth');
    if (!rawAuth) return { error: 'not signed in — localStorage sd.syncAuth missing' };
    const auth = JSON.parse(rawAuth);
    out.user_email = auth?.user?.email;
    out.user_name = auth?.user?.name;
    out.user_sub = auth?.user?.sub;
    out.user_sub_len = auth?.user?.sub?.length;
    out.idtoken_present = !!auth?.idToken;
    out.expires_in_ms = (auth?.expiresAt || 0) - Date.now();

    // Decode idToken payload to cross-check sub
    try {
      const payload = auth.idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      const json = atob(payload + '==='.slice(0, (4 - payload.length % 4) % 4));
      const p = JSON.parse(json);
      out.idtoken_sub = p.sub;
      out.idtoken_sub_matches = p.sub === auth.user.sub;
      out.idtoken_aud = p.aud;
    } catch (e: any) {
      out.idtoken_decode_error = e.message;
    }

    // Fetch envelope directly
    try {
      const resp = await fetch(
        'https://speeddial-sync.apps-0fb.workers.dev/api/sync',
        { headers: { Authorization: 'Bearer ' + auth.idToken } }
      );
      out.sync_status = resp.status;
      if (resp.ok) {
        const body = await resp.json();
        const env = body.data;
        out.envelope_keys = env ? Object.keys(env) : null;
        out.envelope_v = env?.v;
        out.envelope_v_type = typeof env?.v;
        out.envelope_iv_len = env?.iv?.length;
        out.envelope_data_len = env?.data?.length;
        out.envelope_version_field = body.version;
        out.envelope_updatedAt = body.updatedAt
          ? new Date(body.updatedAt).toISOString()
          : null;

        // Try manual decrypt
        try {
          const cryptoMod: any = await import('/crypto.js');
          const plaintext = await cryptoMod.decrypt(env, auth.user.sub);
          out.decrypt_ok = true;
          out.decrypt_sessions_count = plaintext?.sessions?.length ?? null;
          out.decrypt_keys = plaintext ? Object.keys(plaintext) : null;
        } catch (err: any) {
          out.decrypt_ok = false;
          out.decrypt_error_name = err?.name;
          out.decrypt_error_message = err?.message;
          out.decrypt_error_string = String(err);

          // Also test with trimmed sub / different encodings — just in case
          try {
            const cryptoMod: any = await import('/crypto.js');
            await cryptoMod.decrypt(env, String(auth.user.sub).trim());
            out.decrypt_with_trimmed = 'ok';
          } catch {
            out.decrypt_with_trimmed = 'failed';
          }
        }
      } else {
        out.sync_body = (await resp.text()).slice(0, 300);
      }
    } catch (e: any) {
      out.fetch_error = e.message;
    }

    return out;
  });

  console.log('\n=== Diagnostic output ===');
  console.log(JSON.stringify(diagnosis, null, 2));

  if (consoleErrors.length) {
    console.log('\n=== Console errors during load ===');
    consoleErrors.forEach((e) => console.log('  ' + e));
  }

  console.log('\nLeaving the browser open for 15s so you can inspect further, then closing…');
  await page.waitForTimeout(15_000);
  await ctx.close();
}

main().catch((e) => {
  console.error('Script failed:', e);
  process.exit(1);
});
