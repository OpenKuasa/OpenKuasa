'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { getViewer } from '@/lib/auth/viewer';
import { can } from '@/lib/auth/permissions';
import { endOtherSessions } from '@/lib/auth/sessions';
import {
  PASSWORD_CHECK_ERRORS,
  verifyCurrentPassword,
} from '@/lib/auth/verify-password';
import { recordEvent } from '@/lib/events';
import { passwordCheckLimited } from '@/lib/security/limits';
import {
  COMPANY_SIZES,
  INDUSTRIES,
  LANGUAGES,
  MY_STATES,
  NOTIFY_CHANNELS,
  NOTIFY_EVENTS,
  QUIET_TIMES,
  TIMEZONES,
  type NotificationPrefs,
} from '@/config/account';

export type SettingsState = { error?: string; notice?: string } | undefined;

const DEMO_ERROR = 'The demo workspace is read-only. Sign up to save changes.';

const text = (max: number) => z.string().trim().max(max);
const optionalOf = <T extends readonly string[]>(values: T) =>
  z.union([z.literal(''), z.enum(values as unknown as [string, ...string[]])]);

function field(formData: FormData, name: string): string {
  return String(formData.get(name) ?? '');
}

const profileSchema = z.object({
  fullName: text(120).min(1, 'Please enter your name.'),
  phone: text(40),
  jobTitle: text(120),
  timezone: z.enum(TIMEZONES),
  language: z.enum(LANGUAGES.map((l) => l.value) as [string, ...string[]]),
  productUpdates: z.boolean(),
});

export async function updateProfileAction(
  _prev: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const viewer = await getViewer();
  if (viewer.isDemo) return { error: DEMO_ERROR };

  const parsed = profileSchema.safeParse({
    fullName: field(formData, 'fullName'),
    phone: field(formData, 'phone'),
    jobTitle: field(formData, 'jobTitle'),
    timezone: field(formData, 'timezone'),
    language: field(formData, 'language'),
    productUpdates: formData.get('productUpdates') === 'on',
  });
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('profiles')
    .update({
      full_name: parsed.data.fullName,
      phone: parsed.data.phone || null,
      job_title: parsed.data.jobTitle || null,
      timezone: parsed.data.timezone,
      language: parsed.data.language,
      product_updates: parsed.data.productUpdates,
    })
    .eq('user_id', viewer.userId)
    .select('user_id');
  if (error || !data?.length) {
    return { error: 'Could not save your profile. Please try again.' };
  }

  await recordEvent(supabase, { action: 'Updated their profile', category: 'data' });

  // The name appears in the nav of every signed-in layout.
  revalidatePath('/', 'layout');
  return { notice: 'Profile saved.' };
}

const companySchema = z.object({
  name: text(120).min(1, 'Please enter your company name.'),
  registrationNo: text(40),
  sstNo: text(40),
  website: text(200),
  industry: optionalOf(INDUSTRIES),
  companySize: optionalOf(COMPANY_SIZES),
  address: text(200),
  city: text(80),
  state: optionalOf(MY_STATES),
  postcode: text(12),
});

export async function updateCompanyAction(
  _prev: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const viewer = await getViewer();
  if (viewer.isDemo) return { error: DEMO_ERROR };
  if (!can(viewer.role, 'manage-company')) {
    return { error: 'Only owners and admins can edit company details.' };
  }

  const parsed = companySchema.safeParse({
    name: field(formData, 'name'),
    registrationNo: field(formData, 'registrationNo'),
    sstNo: field(formData, 'sstNo'),
    website: field(formData, 'website'),
    industry: field(formData, 'industry'),
    companySize: field(formData, 'companySize'),
    address: field(formData, 'address'),
    city: field(formData, 'city'),
    state: field(formData, 'state'),
    postcode: field(formData, 'postcode'),
  });
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const v = parsed.data;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('orgs')
    .update({
      name: v.name,
      registration_no: v.registrationNo || null,
      sst_no: v.sstNo || null,
      website: v.website || null,
      industry: v.industry || null,
      company_size: v.companySize || null,
      address: v.address || null,
      city: v.city || null,
      state: v.state || null,
      postcode: v.postcode || null,
    })
    .eq('id', viewer.orgId)
    .select('id');
  // RLS filters a disallowed update to zero rows rather than raising.
  if (error || !data?.length) {
    return { error: 'Could not save company details. Please try again.' };
  }

  await recordEvent(supabase, {
    action: 'Updated company details',
    category: 'data',
    target: v.name,
  });

  revalidatePath('/', 'layout');
  return { notice: 'Company details saved.' };
}

export async function updateNotificationsAction(
  _prev: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const viewer = await getViewer();
  if (viewer.isDemo) return { error: DEMO_ERROR };

  const on = (name: string) => formData.get(name) === 'on';
  const time = z.enum(QUIET_TIMES);
  const from = time.safeParse(field(formData, 'quietFrom'));
  const to = time.safeParse(field(formData, 'quietTo'));
  if (!from.success || !to.success) {
    return { error: 'Please choose valid quiet hours.' };
  }

  const channels = Object.fromEntries(
    NOTIFY_CHANNELS.map((c) => [c, on(`channel.${c}`)]),
  ) as NotificationPrefs['channels'];
  const events = Object.fromEntries(
    NOTIFY_EVENTS.map((e) => [
      e.id,
      Object.fromEntries(NOTIFY_CHANNELS.map((c) => [c, on(`event.${e.id}.${c}`)])),
    ]),
  ) as NotificationPrefs['events'];
  const prefs: NotificationPrefs = {
    channels,
    events,
    quiet: { enabled: on('quietEnabled'), from: from.data, to: to.data },
  };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('profiles')
    .update({ notification_prefs: prefs })
    .eq('user_id', viewer.userId)
    .select('user_id');
  if (error || !data?.length) {
    return { error: 'Could not save your preferences. Please try again.' };
  }

  await recordEvent(supabase, {
    action: 'Updated notification preferences',
    category: 'data',
  });

  revalidatePath('/account/notifications');
  return { notice: 'Notification preferences saved.' };
}

const passwordSchema = z
  .object({
    current: z.string().min(1, 'Please enter your current password.'),
    next: z.string().min(8, 'New password must be at least 8 characters.'),
    confirm: z.string(),
  })
  .refine((v) => v.next === v.confirm, {
    message: 'The new passwords do not match.',
  });

export async function changePasswordAction(
  _prev: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const viewer = await getViewer();
  if (viewer.isDemo || !viewer.email) return { error: DEMO_ERROR };

  const parsed = passwordSchema.safeParse({
    current: field(formData, 'current'),
    next: field(formData, 'next'),
    confirm: field(formData, 'confirm'),
  });
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const limited = await passwordCheckLimited(viewer.userId);
  if (limited) return { error: limited };

  // Re-check the current password so a borrowed session cannot change it.
  const check = await verifyCurrentPassword(viewer.email, parsed.data.current);
  if (check !== 'ok') return { error: PASSWORD_CHECK_ERRORS[check] };

  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({
    password: parsed.data.next,
  });
  if (error) {
    return { error: 'Could not update your password. Please try again.' };
  }
  const othersEnded = await endOtherSessions(supabase);
  await recordEvent(supabase, {
    action: 'Changed password',
    category: 'security',
    notify: {
      to: 'self',
      event: 'security',
      title: 'Your password was changed',
      body: 'If this was not you, reset your password now.',
      href: '/account/security',
    },
  });
  return {
    notice: othersEnded
      ? 'Password updated.'
      : 'Password updated. Your other devices could not be signed out; use "Sign out other devices" below.',
  };
}

export async function signOutOtherSessionsAction(
  _prev: SettingsState,
  _formData: FormData,
): Promise<SettingsState> {
  void _formData;
  const viewer = await getViewer();
  if (viewer.isDemo) return { error: DEMO_ERROR };

  const supabase = await createClient();
  const { error } = await supabase.auth.signOut({ scope: 'others' });
  if (error) return { error: 'Could not sign out other devices.' };
  await recordEvent(supabase, {
    action: 'Signed out other devices',
    category: 'security',
  });
  return { notice: 'Signed out of all other devices.' };
}
