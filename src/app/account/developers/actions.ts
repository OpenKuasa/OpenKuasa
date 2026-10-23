'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getViewer } from '@/lib/auth/viewer';
import { createApiKey, revokeApiKey } from '@/lib/mcp/keys';
import { logFailure } from '@/lib/mcp/shared';
import { createClient } from '@/lib/supabase/server';
import type { SettingsState } from '@/app/account/actions';

export type CreateKeyState = { key: string; name: string; id: string } | { error: string } | undefined;

const PATH = '/account/developers';
const DEMO_ERROR = 'The demo workspace is read-only. Sign up to make keys and connect AI tools.';
const REVOKE_ERROR = 'That key could not be revoked. It may already be revoked. Reload the page and try again.';
const DISCONNECT_ERROR = 'Could not disconnect that app just now. Try again.';
const TIDY_ERROR =
  'The app was disconnected, but its workspace record could not be cleared. If you connect it again, you will choose the workspace again.';

const field = (formData: FormData, name: string) => String(formData.get(name) ?? '');

/**
 * Makes a key for the signed-in person in the workspace they have open. Both come from the verified session,
 * never the form; `getViewer` has already sent a session that owes its second factor to the code prompt. The key
 * goes back in this action's state only, so it is shown once and never again.
 */
export async function createKeyAction(_prev: CreateKeyState, formData: FormData): Promise<CreateKeyState> {
  const viewer = await getViewer();
  if (viewer.isDemo) return { error: DEMO_ERROR };

  const name = field(formData, 'name').trim();
  const totp = field(formData, 'totp').replace(/\s+/g, '') || undefined;
  const supabase = await createClient();
  const result = await createApiKey(supabase, { orgId: viewer.orgId, userId: viewer.userId, name, totp });
  if (!result.ok) return { error: result.error };

  revalidatePath(PATH);
  return { key: result.key, name, id: result.id };
}

/** Revokes a key with the person's own session: theirs, or any in a workspace they own or administer (RLS). */
export async function revokeKeyAction(_prev: SettingsState, formData: FormData): Promise<SettingsState> {
  const viewer = await getViewer();
  if (viewer.isDemo) return { error: DEMO_ERROR };

  const supabase = await createClient();
  if (!(await revokeApiKey(supabase, field(formData, 'id')))) return { error: REVOKE_ERROR };

  revalidatePath(PATH);
  return { notice: 'Key revoked.' };
}

const ClientId = z.string().trim().min(1).max(200);

/**
 * Disconnect: ends the AI tool's sign-in (the auth server revokes the grant and its sessions), then removes the
 * record of which workspace it acted in, so connecting again starts fresh. The record stays when the grant could
 * not be revoked: without it, the next call would bind the still-live connection to whichever workspace is open.
 */
export async function disconnectAppAction(_prev: SettingsState, formData: FormData): Promise<SettingsState> {
  const viewer = await getViewer();
  if (viewer.isDemo) return { error: DEMO_ERROR };

  const parsed = ClientId.safeParse(formData.get('client_id'));
  if (!parsed.success) return { error: DISCONNECT_ERROR };
  const clientId = parsed.data;

  const supabase = await createClient();
  try {
    const { error } = await supabase.auth.oauth.revokeGrant({ clientId });
    if (error) {
      logFailure('developers', 'revoke grant', error);
      return { error: DISCONNECT_ERROR };
    }
  } catch (error) {
    logFailure('developers', 'revoke grant', error);
    return { error: DISCONNECT_ERROR };
  }

  // The grant is gone, so the app drops off the list: try the record twice rather than ask for another click.
  const removeBinding = async () =>
    (await supabase.from('mcp_oauth_bindings').delete().eq('user_id', viewer.userId).eq('client_id', clientId)).error;
  const deleteError = (await removeBinding()) && (await removeBinding());
  revalidatePath(PATH);
  if (deleteError) {
    logFailure('developers', 'remove binding', deleteError);
    return { error: TIDY_ERROR };
  }
  return { notice: 'Disconnected.' };
}
