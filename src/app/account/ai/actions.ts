'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { serviceClient } from '@/lib/supabase/service';
import { getViewer, type Viewer } from '@/lib/auth/viewer';
import { can } from '@/lib/auth/permissions';
import {
  encryptApiKey,
  hasKeySecret,
  isOpenRouterKeyShape,
  keyHint,
} from '@/lib/ai/key-crypto';
import { getChatStatus, type ChatStatus } from '@/lib/ai/gate';
import type { SettingsState } from '@/app/account/actions';

const DEMO_ERROR = 'The demo workspace is read-only. Sign up to save changes.';
const ROLE_ERROR = 'Only owners and admins can manage the workspace AI key.';
const SAVE_ERROR = 'Could not save the key. Please try again.';
const KEY_CHECK_URL ='https://openrouter.ai/api/v1/key';

const keySchema = z
  .string()
  .trim()
  .refine(isOpenRouterKeyShape, 'That does not look like an OpenRouter key. It should start with sk-or-.');

/** Asks OpenRouter whether the key is real. Never logs the key. */
async function checkWithOpenRouter(
  apiKey: string,
): Promise<'valid' | 'invalid' | 'unreachable'> {
  try {
    const response = await fetch(KEY_CHECK_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    if (response.ok) return 'valid';
    return response.status === 401 || response.status === 403
      ? 'invalid'
      : 'unreachable';
  } catch {
    return 'unreachable';
  }
}

/**
 * The signed-in owner or admin, or why they may not manage the key.
 * `getViewer` sends a session that owes a second factor to the verify page,
 * and reads the role through `org_members`, whose `mfa_required` policy hides
 * every row from such a session.
 */
async function requireKeyManager(): Promise<{ viewer: Viewer } | { denied: string }> {
  const viewer = await getViewer();
  if (viewer.isDemo) return { denied: DEMO_ERROR };
  if (!can(viewer.role, 'manage-ai-key')) return { denied: ROLE_ERROR };
  return { viewer };
}

export async function saveAiKeyAction(
  _prev: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const manager = await requireKeyManager();
  if ('denied' in manager) return { error: manager.denied };
  const { viewer } = manager;

  const parsed = keySchema.safeParse(String(formData.get('apiKey') ?? ''));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const apiKey = parsed.data;

  if (!hasKeySecret()) {
    return {
      error:
        'This server is not set up to store workspace keys yet (AI_KEYS_ENCRYPTION_SECRET is missing).',
    };
  }

  const check = await checkWithOpenRouter(apiKey);
  if (check === 'invalid') {
    return { error: 'OpenRouter rejected that key. Check it and try again.' };
  }
  if (check === 'unreachable') {
    return { error: 'Could not reach OpenRouter to check the key. Please try again.' };
  }

  // The server is the only writer of a sealed key. It seals for the workspace
  // of the verified session (never an id from the form) and stores through a
  // service-role-only function, so the value held for a workspace is always
  // one sealed for that workspace. The function checks again that this user
  // is an owner or admin there.
  try {
    const { error } = await serviceClient().rpc('set_org_ai_key', {
      p_org: viewer.orgId,
      p_actor: viewer.userId,
      p_ciphertext: encryptApiKey(apiKey, viewer.orgId),
      p_hint: keyHint(apiKey),
    });
    if (error) return { error: SAVE_ERROR };
  } catch {
    // No service role on this host. Never surface or log the key.
    return { error: SAVE_ERROR };
  }

  revalidatePath('/', 'layout');
  return { notice: 'Key saved. Chat now runs on your OpenRouter account.' };
}

export async function removeAiKeyAction(
  _prev: SettingsState,
  _formData: FormData,
): Promise<SettingsState> {
  void _formData;
  const manager = await requireKeyManager();
  if ('denied' in manager) return { error: manager.denied };

  const supabase = await createClient();
  const { error } = await supabase.rpc('clear_org_ai_key');
  if (error) return { error: 'Could not remove the key. Please try again.' };

  revalidatePath('/', 'layout');
  return { notice: 'Key removed.' };
}

export type ChatStatusForViewer = ChatStatus & {
  /** Demo guests get sample answers and never need a key. */
  isDemo: boolean;
  /** Whether this person may add the workspace key themselves. */
  canManageKey: boolean;
};

/** What the chat surfaces show before a question is asked. */
export async function getChatStatusAction(): Promise<ChatStatusForViewer> {
  const viewer = await getViewer();
  if (viewer.isDemo) {
    return {
      isDemo: true,
      canManageKey: false,
      hasKey: false,
      keyHint: null,
      freeLimit: 0,
      freeRemaining: 0,
    };
  }
  const supabase = await createClient();
  return {
    ...(await getChatStatus(supabase)),
    isDemo: false,
    canManageKey: can(viewer.role, 'manage-ai-key'),
  };
}
