'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { getViewer } from '@/lib/auth/viewer';
import { getMfaStatus } from '@/lib/auth/mfa';
import {
  PASSWORD_CHECK_ERRORS,
  verifyCurrentPassword,
} from '@/lib/auth/verify-password';
import { recordEvent } from '@/lib/events';
import {
  mfaVerifyErrorMessage,
  totpCodeSchema,
} from '@/components/account/mfa-helpers';
import { isOwnAvatarPath } from '@/components/account/avatar-rules';
import type { SettingsState } from '@/app/account/actions';

const DEMO_ERROR = 'The demo workspace is read-only. Sign up to save changes.';
const PHOTO_ERROR = 'Could not save your photo. Please try again.';

// Absolute origin of the current request, for building email redirect targets.
async function requestOrigin(): Promise<string> {
  const h = await headers();
  const origin = h.get('origin');
  if (origin) return origin;
  const host = h.get('x-forwarded-host') ?? h.get('host');
  const proto = h.get('x-forwarded-proto') ?? 'https';
  return host ? `${proto}://${host}` : 'https://openkuasa.com';
}

// Points the profile at `path` (or clears it) and deletes the photo it
// replaces. The old path is read here rather than taken from the client.
async function setAvatarPath(
  supabase: SupabaseClient,
  userId: string,
  path: string | null,
): Promise<boolean> {
  const { data: current } = await supabase
    .from('profiles')
    .select('avatar_path')
    .eq('user_id', userId)
    .maybeSingle();
  const previous: string | null = current?.avatar_path ?? null;

  const { data, error } = await supabase
    .from('profiles')
    .update({ avatar_path: path })
    .eq('user_id', userId)
    .select('user_id');
  if (error || !data?.length) return false;

  // Best effort: a leftover file is harmless, a failed save is not.
  if (previous && previous !== path && isOwnAvatarPath(previous, userId)) {
    const { error: removeErr } = await supabase.storage
      .from('avatars')
      .remove([previous]);
    if (removeErr) console.error('avatar cleanup failed:', removeErr.message);
  }
  return true;
}

const avatarPathSchema = z.string().min(1).max(200);

/** Saves the path of a photo the browser has already uploaded to storage. */
export async function saveAvatarAction(path: string): Promise<SettingsState> {
  const viewer = await getViewer();
  if (viewer.isDemo) return { error: DEMO_ERROR };

  const parsed = avatarPathSchema.safeParse(path);
  if (!parsed.success || !isOwnAvatarPath(parsed.data, viewer.userId)) {
    return { error: PHOTO_ERROR };
  }

  const supabase = await createClient();
  // Only accept a path that really holds an uploaded file.
  const [folder, name] = parsed.data.split('/');
  const { data: found } = await supabase.storage
    .from('avatars')
    .list(folder, { search: name, limit: 1 });
  if (!found?.some((object) => object.name === name)) {
    return { error: PHOTO_ERROR };
  }

  if (!(await setAvatarPath(supabase, viewer.userId, parsed.data))) {
    return { error: PHOTO_ERROR };
  }

  await recordEvent(supabase, {
    action: 'Updated their profile photo',
    category: 'data',
  });

  // The photo appears in the nav of every signed-in layout.
  revalidatePath('/', 'layout');
  return { notice: 'Photo updated.' };
}

export async function removeAvatarAction(): Promise<SettingsState> {
  const viewer = await getViewer();
  if (viewer.isDemo) return { error: DEMO_ERROR };

  const supabase = await createClient();
  if (!(await setAvatarPath(supabase, viewer.userId, null))) {
    return { error: 'Could not remove your photo. Please try again.' };
  }

  await recordEvent(supabase, {
    action: 'Removed their profile photo',
    category: 'data',
  });

  revalidatePath('/', 'layout');
  return { notice: 'Photo removed.' };
}

const emailChangeSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(254, 'Please enter a valid email address.')
    .email('Please enter a valid email address.'),
  current: z.string().min(1, 'Please enter your current password.'),
});

/**
 * Starts an email change. Supabase emails a confirmation link to the new
 * address; the sign-in email only changes once that link is opened (handled
 * by /auth/confirm), and a database trigger then mirrors it to the profile.
 *
 * Whoever controls the sign-in email controls the account, so an open session
 * is not enough: the current password is asked for again, and so is an
 * authenticator code when two-factor authentication is on.
 */
export async function requestEmailChangeAction(
  _prev: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const viewer = await getViewer();
  if (viewer.isDemo || !viewer.email) return { error: DEMO_ERROR };

  const parsed = emailChangeSchema.safeParse({
    email: String(formData.get('email') ?? ''),
    current: String(formData.get('current') ?? ''),
  });
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const newEmail = parsed.data.email;
  if (newEmail === viewer.email.toLowerCase()) {
    return { error: 'That is already your sign-in email.' };
  }

  const check = await verifyCurrentPassword(viewer.email, parsed.data.current);
  if (check !== 'ok') return { error: PASSWORD_CHECK_ERRORS[check] };

  const supabase = await createClient();
  const { factors } = await getMfaStatus(supabase);
  if (factors.length > 0) {
    const code = totpCodeSchema.safeParse(String(formData.get('code') ?? ''));
    if (!code.success) return { error: code.error.issues[0].message };
    const { error: codeErr } = await supabase.auth.mfa.challengeAndVerify({
      factorId: factors[0].id,
      code: code.data,
    });
    if (codeErr) return { error: mfaVerifyErrorMessage(codeErr) };
  }

  const origin = await requestOrigin();
  const { error } = await supabase.auth.updateUser(
    { email: newEmail },
    { emailRedirectTo: `${origin}/auth/confirm?next=/account/profile` },
  );
  // An address that belongs to another account is answered exactly like one
  // that is free, so this form cannot be used to find out who has an account.
  if (error && error.code !== 'email_exists') {
    if (error.code === 'over_email_send_rate_limit' || error.status === 429) {
      return {
        error: 'Too many emails sent. Please wait a few minutes and try again.',
      };
    }
    return { error: 'Could not start the email change. Please try again.' };
  }

  await recordEvent(supabase, {
    action: 'Requested an email change',
    category: 'security',
    target: newEmail,
    notify: {
      to: 'self',
      event: 'security',
      title: 'Email change requested',
      body: `If ${newEmail} can be used, a confirmation link has been sent to it.`,
      href: '/account/profile',
    },
  });

  revalidatePath('/account/profile');
  return {
    notice: `If ${newEmail} can be used, a confirmation link is on its way to it. Your sign-in email stays ${viewer.email} until that link is opened.`,
  };
}
