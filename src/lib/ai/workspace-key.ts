/**
 * Reads and opens a workspace's stored OpenRouter key on the server.
 *
 * The sealed value never leaves the server: it is read with the service-role
 * client, by a workspace id the caller has already resolved from trusted
 * state (the verified session's current workspace, or a schedule/run row).
 */

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { decryptApiKey, encryptApiKey, hasKeySecret } from '@/lib/ai/key-crypto';

export type WorkspaceKey =
  /** The workspace has not stored a key. */
  | { status: 'none' }
  | { status: 'ok'; apiKey: string }
  /** A key is stored but this server cannot open it for this workspace. */
  | { status: 'unusable' }
  /** The stored key could not be read. */
  | { status: 'error' };

// Same test as `isLegacySealed` in key-crypto, kept local so this module needs
// only the seal/open functions.
const isLegacy = (sealed: string) => sealed.startsWith('v1.');

/**
 * `service` MUST be the service-role client and `orgId` MUST come from
 * server-side state. Only `ok` carries a key; callers treat `unusable` and
 * `error` as "this workspace has a key that cannot be used", never as "no key".
 */
export async function readWorkspaceKey(
  service: SupabaseClient,
  orgId: string,
): Promise<WorkspaceKey> {
  const { data, error } = await service
    .from('org_ai_keys')
    .select('ciphertext')
    .eq('org_id', orgId)
    .maybeSingle();
  if (error) return { status: 'error' };

  const sealed = data?.ciphertext;
  if (typeof sealed !== 'string' || !sealed) return { status: 'none' };

  const apiKey = hasKeySecret() ? decryptApiKey(sealed, orgId) : null;
  if (!apiKey) return { status: 'unusable' };

  if (isLegacy(sealed)) await resealForWorkspace(service, orgId, sealed, apiKey);
  return { status: 'ok', apiKey };
}

/**
 * Replaces a key held in the earlier format with one bound to its workspace.
 * Only the row still holding the value that was just opened is touched, so a
 * key saved or removed in the meantime is left alone. Best effort: the key
 * that was opened stays usable for this request whatever happens here, and
 * the next read tries again.
 */
async function resealForWorkspace(
  service: SupabaseClient,
  orgId: string,
  legacySealed: string,
  apiKey: string,
): Promise<void> {
  try {
    const { error } = await service
      .from('org_ai_keys')
      .update({ ciphertext: encryptApiKey(apiKey, orgId) })
      .eq('org_id', orgId)
      .eq('ciphertext', legacySealed);
    if (error) console.error('[ai-key] could not re-seal a workspace key:', error.message);
  } catch {
    console.error('[ai-key] could not re-seal a workspace key.');
  }
}
