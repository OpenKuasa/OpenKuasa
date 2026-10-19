/** Option lists and notification defaults shared by account forms and actions. */

export const TIMEZONES = [
  'Asia/Kuala_Lumpur',
  'Asia/Singapore',
  'Asia/Jakarta',
  'Asia/Bangkok',
  'Asia/Manila',
  'UTC',
] as const;

export const LANGUAGES = [
  { value: 'en', label: 'English' },
  { value: 'ms', label: 'Bahasa Melayu' },
] as const;

export const INDUSTRIES = [
  'Technology',
  'Retail & e-commerce',
  'Professional services',
  'Manufacturing',
  'Food & beverage',
  'Healthcare',
  'Education',
  'Other',
] as const;

export const COMPANY_SIZES = [
  'Just me',
  '2–5',
  '6–20',
  '21–50',
  '51–200',
  '200+',
] as const;

export const MY_STATES = [
  'Johor',
  'Kedah',
  'Kelantan',
  'Melaka',
  'Negeri Sembilan',
  'Pahang',
  'Perak',
  'Perlis',
  'Pulau Pinang',
  'Sabah',
  'Sarawak',
  'Selangor',
  'Terengganu',
  'WP Kuala Lumpur',
  'WP Labuan',
  'WP Putrajaya',
] as const;

export const NOTIFY_CHANNELS = ['email', 'push', 'inapp'] as const;
export type NotifyChannel = (typeof NOTIFY_CHANNELS)[number];

export const NOTIFY_EVENTS = [
  { id: 'new_leads', name: 'New leads', help: 'When a campaign captures a new lead' },
  { id: 'deal_stages', name: 'Deal stage changes', help: 'Movement across your CRM pipeline' },
  { id: 'payments', name: 'Payments & invoices', help: 'Receipts, overdue invoices & e-Invoice status' },
  { id: 'team_activity', name: 'Team activity', help: 'Leave & claims approvals waiting on you' },
  { id: 'hr_request_filed', name: 'Requests from your team', help: 'When someone who reports to you files leave, time-off, a claim or overtime' },
  { id: 'hr_request_decided', name: 'Decisions on your requests', help: 'When your leave, time-off, claim or overtime is approved or rejected' },
  { id: 'hiring', name: 'Hiring', help: 'When someone applies to one of your jobs' },
  { id: 'weekly_summary', name: 'Weekly summary', help: 'A Monday digest of last week across your workspace' },
  { id: 'product_updates', name: 'Product updates', help: 'New features and improvements to OpenKuasa' },
] as const;
export type NotifyEventId = (typeof NOTIFY_EVENTS)[number]['id'];

export const QUIET_TIMES = [
  '20:00', '21:00', '22:00', '23:00', '00:00',
  '05:00', '06:00', '07:00', '08:00', '09:00',
] as const;

export type NotificationPrefs = {
  channels: Record<NotifyChannel, boolean>;
  events: Record<NotifyEventId, Record<NotifyChannel, boolean>>;
  quiet: { enabled: boolean; from: string; to: string };
};

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  channels: { email: true, push: false, inapp: true },
  events: {
    new_leads: { email: true, push: true, inapp: true },
    deal_stages: { email: true, push: false, inapp: true },
    payments: { email: true, push: true, inapp: true },
    team_activity: { email: false, push: false, inapp: true },
    hr_request_filed: { email: false, push: false, inapp: true },
    hr_request_decided: { email: false, push: false, inapp: true },
    hiring: { email: false, push: false, inapp: true },
    weekly_summary: { email: true, push: false, inapp: false },
    product_updates: { email: false, push: false, inapp: true },
  },
  quiet: { enabled: false, from: '22:00', to: '07:00' },
};

/** Merge stored prefs (possibly partial or empty) over the defaults. */
export function resolveNotificationPrefs(stored: unknown): NotificationPrefs {
  const s = (stored && typeof stored === 'object' ? stored : {}) as Partial<NotificationPrefs>;
  const d = DEFAULT_NOTIFICATION_PREFS;
  const events = { ...d.events };
  for (const e of NOTIFY_EVENTS) {
    events[e.id] = { ...d.events[e.id], ...(s.events?.[e.id] ?? {}) };
  }
  return {
    channels: { ...d.channels, ...(s.channels ?? {}) },
    events,
    quiet: { ...d.quiet, ...(s.quiet ?? {}) },
  };
}
