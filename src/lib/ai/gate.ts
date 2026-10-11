/**
 * Who pays for a chat turn.
 *
 * A workspace that has added its own OpenRouter key chats on that key with no
 * platform quota. Without one, each signed-up user gets a few free questions a
 * week on the platform key, after which chat asks for a key. Demo guests never
 * reach a model.
 */

import type { SupabaseClient, User } from '@supabase/supabase-js';
import { isLiveChatAllowed } from '@/lib/ai/access';
import { hasProviderKey } from '@/lib/ai/provider';
import { readWorkspaceKey, type WorkspaceKey } from '@/lib/ai/workspace-key';
import { getCurrentOrg } from '@/lib/auth/current-org';
import { serviceClient } from '@/lib/supabase/service';

export const FREE_QUESTIONS_PER_WEEK = 3;

export type ChatAccess =
  /** Run on the workspace's own key. */
  | { kind: 'byok'; apiKey: string }
  /** Run on the platform key; `remaining` free questions are left after this one. */
  | { kind: 'free'; remaining: number }
  | { kind: 'locked'; status: number; code: ChatLockCode; error: string };

export type ChatLockCode =
  | 'sign_in'
  | 'demo'
  | 'key_required'
  | 'key_unavailable';

const locked = (
  status: number,
  code: ChatLockCode,
  error: string,
): ChatAccess => ({ kind: 'locked', status, code, error });

/**
 * The stored key of the session's own workspace. The sealed value is read on
 * the server with the service-role client and never passes through the
 * caller's session. The workspace id comes from the verified session:
 * `getCurrentOrg` reads `profiles` and `org_members` as the caller, and both
 * carry the `mfa_required` restrictive policy, so a session that owes a second
 * factor resolves to no workspace and no key is read for it.
 */
async function readSessionWorkspaceKey(supabase: SupabaseClient): Promise<WorkspaceKey> {
  try {
    const org = await getCurrentOrg(supabase);
    if (!org) return { status: 'unusable' };
    const stored = await readWorkspaceKey(serviceClient(), org.orgId);
    // A key is known to be set, so finding none for this workspace is a
    // mismatch to refuse, not a reason to use the platform key.
    return stored.status === 'none' ? { status: 'unusable' } : stored;
  } catch {
    // No service role on this host, or the workspace lookup failed.
    console.error('[chat] could not read the workspace key on the server.');
    return { status: 'error' };
  }
}

/**
 * Decides how this request may reach a model, consuming one free question when
 * it runs on the platform key. Call once per chat turn, before the model.
 */
export async function resolveChatAccess(
  supabase: SupabaseClient,
  user: User | null | undefined,
): Promise<ChatAccess> {
  if (!user) return locked(401, 'sign_in', 'Please sign in to chat.');
  if (!isLiveChatAllowed(user)) {
    return locked(403, 'demo', 'Sign up for a free account to chat.');
  }

  // Whether the caller's workspace has a key is asked as the caller. The
  // database answers for `private.current_org(auth.uid())`, which is null for
  // a session that still owes a second factor, so such a session is told
  // "no key" here and is then refused a free question too.
  const { data: status, error } = await supabase.rpc('org_ai_key_status');
  if (error) {
    console.error('[chat] could not read the workspace key:', error.message);
    return locked(503, 'key_unavailable', 'Chat is unavailable right now. Please try again.');
  }

  if (Array.isArray(status) ? status.length > 0 : Boolean(status)) {
    // Fail closed: a workspace that set its own key must never fall back to
    // the platform key because this server cannot read or open it.
    const stored = await readSessionWorkspaceKey(supabase);
    if (stored.status === 'ok') return { kind: 'byok', apiKey: stored.apiKey };
    return stored.status === 'error'
      ? locked(503, 'key_unavailable', 'Chat is unavailable right now. Please try again.')
      : locked(
          503,
          'key_unavailable',
          'Your workspace key could not be used on this server. Ask an owner to save it again.',
        );
  }

  const needsKey = locked(
    402,
    'key_required',
    'Add your OpenRouter key to keep chatting.',
  );
  if (!hasProviderKey()) return needsKey;

  const { data: remaining, error: quotaErr } = await supabase.rpc(
    'consume_free_question',
    { weekly_limit: FREE_QUESTIONS_PER_WEEK },
  );
  if (quotaErr) {
    console.error('[chat] free allowance unavailable:', quotaErr.message);
    return locked(503, 'key_unavailable', 'Chat is unavailable right now. Please try again.');
  }
  if (typeof remaining !== 'number' || remaining < 0) return needsKey;
  return { kind: 'free', remaining };
}

/** What the chat UI shows before a question is asked. Does not consume anything. */
export type ChatStatus = {
  hasKey: boolean;
  keyHint: string | null;
  freeLimit: number;
  freeRemaining: number;
};

export async function getChatStatus(supabase: SupabaseClient): Promise<ChatStatus> {
  const [{ data: key }, { data: used }] = await Promise.all([
    supabase.rpc('org_ai_key_status'),
    supabase.rpc('free_questions_used'),
  ]);
  const row = Array.isArray(key) ? key[0] : key;
  const hint = (row as { key_hint?: string } | null | undefined)?.key_hint ?? null;
  const usedCount = typeof used === 'number' ? used : 0;

  return {
    hasKey: hint !== null,
    keyHint: hint,
    freeLimit: FREE_QUESTIONS_PER_WEEK,
    // Without a platform key there is nothing to run free questions on.
    freeRemaining: hasProviderKey()
      ? Math.max(0, FREE_QUESTIONS_PER_WEEK - usedCount)
      : 0,
  };
}
