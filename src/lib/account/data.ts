import { cache } from 'react';
import { createClient } from '@/lib/supabase/server';
import {
  avatarPublicUrl,
  getViewer,
  hasSupabaseEnv,
  initialsOf,
} from '@/lib/auth/viewer';
import type { OrgRole } from '@/lib/auth/current-org';
import {
  resolveNotificationPrefs,
  type NotificationPrefs,
} from '@/config/account';

export type Profile = {
  fullName: string;
  email: string | null;
  avatarUrl: string | null;
  phone: string;
  jobTitle: string;
  timezone: string;
  language: string;
  productUpdates: boolean;
  notificationPrefs: NotificationPrefs;
};

export type Company = {
  name: string;
  registrationNo: string;
  sstNo: string;
  /** The tax identification number (TIN), or '' when none is saved. */
  tin: string;
  website: string;
  industry: string;
  companySize: string;
  address: string;
  city: string;
  state: string;
  postcode: string;
  /** `<org>/<uuid>.<ext>` in the `org-logos` bucket, or null. Use `logoUrl` (lib/account/logo) for its address. */
  logoPath: string | null;
};

export type TeamMember = {
  userId: string;
  name: string;
  email: string;
  initials: string;
  avatarUrl: string | null;
  role: OrgRole;
  joinedAt: string;
  isYou: boolean;
};

export const getProfile = cache(async (): Promise<Profile> => {
  const viewer = await getViewer();
  const base: Profile = {
    fullName: viewer.isDemo ? '' : viewer.name,
    email: viewer.email,
    avatarUrl: viewer.avatarUrl,
    phone: '',
    jobTitle: '',
    timezone: 'Asia/Kuala_Lumpur',
    language: 'en',
    productUpdates: true,
    notificationPrefs: resolveNotificationPrefs(null),
  };
  if (!hasSupabaseEnv()) return base;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('profiles')
    .select(
      'full_name, phone, job_title, timezone, language, product_updates, notification_prefs',
    )
    .eq('user_id', viewer.userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return base;

  return {
    ...base,
    fullName: data.full_name ?? base.fullName,
    phone: data.phone ?? '',
    jobTitle: data.job_title ?? '',
    timezone: data.timezone,
    language: data.language,
    productUpdates: data.product_updates,
    notificationPrefs: resolveNotificationPrefs(data.notification_prefs),
  };
});

export const getCompany = cache(async (): Promise<Company> => {
  const viewer = await getViewer();
  const base: Company = {
    name: viewer.orgName,
    registrationNo: '',
    sstNo: '',
    tin: '',
    website: '',
    industry: '',
    companySize: '',
    address: '',
    city: '',
    state: '',
    postcode: '',
    logoPath: null,
  };
  if (!hasSupabaseEnv()) return base;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('orgs')
    .select(
      'name, registration_no, sst_no, tin, website, industry, company_size, address, city, state, postcode, logo_path',
    )
    .eq('id', viewer.orgId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return base;

  return {
    name: data.name,
    registrationNo: data.registration_no ?? '',
    sstNo: data.sst_no ?? '',
    tin: data.tin ?? '',
    website: data.website ?? '',
    industry: data.industry ?? '',
    companySize: data.company_size ?? '',
    address: data.address ?? '',
    city: data.city ?? '',
    state: data.state ?? '',
    postcode: data.postcode ?? '',
    logoPath: data.logo_path ?? null,
  };
});

/**
 * Members of the viewer's org who have a real account. Anonymous demo
 * sessions (no email) are left out, so the shared demo org is not a wall of
 * guests.
 */
export const getTeam = cache(async (): Promise<TeamMember[]> => {
  const viewer = await getViewer();
  if (!hasSupabaseEnv()) return [];

  const supabase = await createClient();
  const { data: members, error } = await supabase
    .from('org_members')
    .select('user_id, role, created_at')
    .eq('org_id', viewer.orgId)
    .order('created_at', { ascending: true });
  if (error) throw error;

  // RLS already limits profiles to the viewer and their org-mates.
  const { data: profiles, error: profileErr } = await supabase
    .from('profiles')
    .select('user_id, full_name, email, avatar_path')
    .not('email', 'is', null);
  if (profileErr) throw profileErr;

  const byId = new Map((profiles ?? []).map((p) => [p.user_id, p]));
  const team: TeamMember[] = [];
  for (const m of members ?? []) {
    const p = byId.get(m.user_id);
    if (!p?.email) continue;
    const name = p.full_name?.trim() || p.email.split('@')[0];
    team.push({
      userId: m.user_id,
      name,
      email: p.email,
      initials: initialsOf(name),
      avatarUrl: avatarPublicUrl(p.avatar_path),
      role: m.role as OrgRole,
      joinedAt: m.created_at,
      isYou: m.user_id === viewer.userId,
    });
  }
  return team;
});
