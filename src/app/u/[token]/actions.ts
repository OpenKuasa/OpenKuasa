'use server';

import { hasSupabaseEnv } from '@/lib/auth/viewer';
import { recordUnsubscribe, verifyUnsubscribeToken } from '@/lib/crm/unsubscribe';

export type UnsubscribeState = { done?: true; error?: string } | undefined;

/**
 * Records an opt-out when the visitor presses the button. Runs for anyone, so
 * nothing is trusted but the link itself: its signature says which recipient
 * it was made for, and only this server can make one.
 */
export async function confirmUnsubscribeAction(
  token: string,
  _prev: UnsubscribeState,
  _formData: FormData,
): Promise<UnsubscribeState> {
  void _formData;
  const recipientId = hasSupabaseEnv() ? verifyUnsubscribeToken(token) : null;
  if (!recipientId) return { error: 'This link is not valid. Use the link in the email you received.' };
  // Only thanked when it was stored. If it was not, they must know to try again.
  if ((await recordUnsubscribe(recipientId)) === 'failed') {
    return { error: 'That did not go through, so you are still subscribed. Please try again in a moment.' };
  }
  return { done: true };
}
