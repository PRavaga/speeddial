// ===================================================================
// Speed Dial Web — Read-only sync (pull + decrypt)
// ===================================================================

import { getValidIdToken, getUser } from './auth.js';
import { decrypt } from './crypto.js';

const SYNC_API = 'https://speeddial-sync.apps-0fb.workers.dev';

export async function pullDoc() {
  const user = getUser();
  const idToken = await getValidIdToken();
  if (!user || !idToken) return null;

  const resp = await fetch(`${SYNC_API}/api/sync`, {
    headers: { 'Authorization': `Bearer ${idToken}` }
  });

  if (resp.status === 404) return null;
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Sync API ${resp.status}${body ? ': ' + body.slice(0, 200) : ''}`);
  }

  const { data: encrypted } = await resp.json();
  if (!encrypted) return null;

  try {
    return await decrypt(encrypted, user.sub);
  } catch (e) {
    if (e && e.name === 'OperationError') {
      const err = new Error('Decryption failed (key mismatch). Make sure you signed in with the same Google account used in the extension.');
      err.diag = {
        envelope_v: encrypted.v,
        envelope_v_type: typeof encrypted.v,
        iv_len: encrypted.iv?.length,
        data_len: encrypted.data?.length,
        sub_len: user.sub?.length,
        sub_last6: user.sub?.slice(-6),
        expected_versions: [1, 2]
      };
      throw err;
    }
    throw e;
  }
}
