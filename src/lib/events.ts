import type { SupabaseClient } from '@supabase/supabase-js';

export type ActivityCategory = 'auth' | 'team' | 'data' | 'security' | 'billing';

/**
 * Every event the app records, by the sentence its callers pass as `action`,
 * and the key the database knows it by. The database writes the entry from
 * the key alone: the sentence, category, target and any notification are
 * built there (public.log_event), never sent from here.
 *
 * KEEP IN STEP with supabase/migrations/20261101133000_activity_log_events.sql;
 * tests/events.test.ts compares the two and checks every caller is listed.
 */
export const EVENT_KEYS = {
  'Signed in': 'signed_in',
  'Created the workspace': 'workspace_created',
  'Updated their profile': 'profile_updated',
  'Updated their profile photo': 'profile_photo_updated',
  'Removed their profile photo': 'profile_photo_removed',
  'Updated company details': 'company_updated',
  'Updated notification preferences': 'notification_prefs_updated',
  'Changed password': 'password_changed',
  'Reset password by email': 'password_reset',
  'Signed out other devices': 'other_sessions_signed_out',
  'Requested an email change': 'email_change_requested',
  'Turned on two-factor authentication': 'mfa_enabled',
  'Turned off two-factor authentication': 'mfa_disabled',
  'Regenerated recovery codes': 'recovery_codes_regenerated',
  'Signed in with a recovery code': 'recovery_code_sign_in',
} as const satisfies Record<string, string>;

export type EventKey = (typeof EVENT_KEYS)[keyof typeof EVENT_KEYS];

export type AppEvent = {
  /**
   * Which event happened, as its activity-log sentence, e.g. "Changed
   * password". It must be one of the sentences in {@link EVENT_KEYS}; anything
   * else is not recorded.
   */
  action: string;
  /**
   * The remaining fields describe the entry for the reader of the call site.
   * They are not sent: the database decides them from the event.
   */
  category: ActivityCategory;
  target?: string;
  notify?: {
    to: 'self' | 'admins';
    event: string;
    title: string;
    body?: string;
    href?: string;
  };
};

/** The database key for an event sentence, or null when it is not a known event. */
export function eventKey(action: string): EventKey | null {
  return Object.hasOwn(EVENT_KEYS, action)
    ? EVENT_KEYS[action as keyof typeof EVENT_KEYS]
    : null;
}

/**
 * Records an activity-log entry for the signed-in user's current workspace
 * (and, for some events, an in-app notification to that user). Never throws:
 * an audit write must not fail the action it describes. Viewers and demo
 * guests are ignored by the database function.
 */
export async function recordEvent(
  supabase: SupabaseClient,
  event: AppEvent,
): Promise<void> {
  const key = eventKey(event.action);
  if (!key) {
    console.error(
      `recordEvent skipped: "${event.action}" is not a known event. Add it to EVENT_KEYS and to public.log_event.`,
    );
    return;
  }
  try {
    const { error } = await supabase.rpc('log_event', { p_key: key });
    if (error) console.error('recordEvent failed:', error.message);
  } catch (error) {
    console.error('recordEvent failed:', error);
  }
}
