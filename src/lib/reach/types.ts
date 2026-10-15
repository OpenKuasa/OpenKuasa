/**
 * Jebat (`reach`) domain types.
 *
 * These mirror the slice-1 Postgres schema (see the Jebat backend design doc,
 * §4.2): money is stored in **cents** to avoid float drift, and every row that
 * will live in Postgres carries the same field names the tables use. Keeping the
 * shapes identical here means the data slice can swap the seed-backed
 * {@link ReachData} provider for an RLS-scoped Supabase one without touching the
 * AI tools or their aggregation math.
 */

export type Channel = 'whatsapp' | 'facebook' | 'instagram' | 'tiktok';
/**
 * Where a lead came in: an ad channel, or `web` for someone who filled in a
 * lead form, a landing page or the chatbot (they are Kasturi contacts).
 */
export type LeadChannel = Channel | 'web';
export const LEAD_CHANNELS: readonly LeadChannel[] = ['whatsapp', 'facebook', 'instagram', 'tiktok', 'web'];
export type CampaignStatus = 'active' | 'paused';
export type LeadStage = 'lead' | 'contacted' | 'qualified' | 'booked' | 'won';

/** The lead lifecycle, earliest → furthest. A lead's `stage` is the furthest it reached. */
export const LEAD_STAGES: readonly LeadStage[] = [
  'lead',
  'contacted',
  'qualified',
  'booked',
  'won',
];

export type Campaign = {
  id: string;
  name: string;
  channel: Channel;
  status: CampaignStatus;
  /** Ad-platform-reported leads for the campaign (not reconciled against CRM `leads`). */
  leads_count: number;
  spend_cents: number;
  /** Cost per lead, in cents. */
  cpl_cents: number | null;
  created_at: string;
};

export type Lead = {
  id: string;
  name: string;
  channel: LeadChannel;
  /** Furthest stage this lead has reached. */
  stage: LeadStage;
  source: string;
  created_at: string;
  /** Set when the lead was promoted to a CRM contact; no FK (module-decoupled). */
  promoted_contact_id: string | null;
  /**
   * `crm` when this lead is a Kasturi contact read as a lead (see
   * `crm-leads.ts`): its id is the contact's, and it is changed in Kasturi,
   * never through the Jebat lead writes. Absent on rows of the `leads` table.
   */
  origin?: 'crm';
};

export type AppointmentStatus = 'scheduled' | 'completed' | 'cancelled' | 'no_show';
export const APPOINTMENT_STATUSES: AppointmentStatus[] = [
  'scheduled', 'completed', 'cancelled', 'no_show',
];

export type Appointment = {
  id: string;
  contact_name: string;
  kind: string;
  scheduled_at: string;
  via: string;
  status: AppointmentStatus;
  created_at: string;
};

export type FormStatus = 'draft' | 'active' | 'paused';
export type BroadcastChannel = 'whatsapp' | 'email';
export type AutomationStatus = 'active' | 'paused' | 'draft';

/**
 * A lead-capture form. While it is active, anyone can fill it in at its public
 * page (`/f/<id>`); the two counters follow what happens there.
 */
export type Form = {
  id: string;
  name: string;
  /** Free text such as Promotions or Sales. */
  category: string | null;
  /** The link, without the leading "/": lower-case letters, digits and hyphens. */
  slug: string;
  /** Where the form is mainly shared, when that is known. */
  channel: Channel | null;
  status: FormStatus;
  views_count: number;
  submissions_count: number;
  created_at: string;
  updated_at: string;
};

/** What one visitor sent through a form's public page. */
export type FormSubmission = {
  id: string;
  form_id: string;
  /** The Kasturi contact it made or matched; null once that contact is deleted. */
  contact_id: string | null;
  name: string;
  email: string;
  phone: string | null;
  message: string | null;
  created_at: string;
};

/** A one-to-many email / WhatsApp message blast. */
export type Broadcast = {
  id: string;
  name: string;
  channel: BroadcastChannel;
  sent_count: number;
  opened_count: number;
  clicked_count: number;
  sent_at: string;
  created_at: string;
};

/** An automation workflow (trigger → actions). */
export type Automation = {
  id: string;
  name: string;
  trigger: string;
  status: AutomationStatus;
  runs_count: number;
  created_at: string;
};

export type CreativeType = 'image' | 'video' | 'copy';
export type CreativeStatus = 'draft' | 'active' | 'archived';

export type Creative = {
  id: string;
  campaign_id: string | null;
  name: string;
  type: CreativeType;
  channel: Channel;
  status: CreativeStatus;
  body: string | null;
  ctr: number | null;
  created_at: string;
};

export type AdSettings = {
  daily_cap_cents: number | null;
  monthly_cap_cents: number | null;
  currency: string;
  automation: Record<string, boolean>;
  notifications: Record<string, boolean>;
  updated_at: string;
};

/**
 * The data seam the AI tools read through. The seed provider returns in-memory
 * fixtures today; the data slice adds a Supabase provider whose methods query
 * with the caller's session so Postgres RLS scopes every read to their org.
 */
export interface ReachData {
  listCampaigns(): Promise<Campaign[]>;
  listLeads(): Promise<Lead[]>;
  listAppointments(): Promise<Appointment[]>;
  listForms(): Promise<Form[]>;
  listBroadcasts(): Promise<Broadcast[]>;
  listAutomations(): Promise<Automation[]>;
  listCreatives(): Promise<Creative[]>;
  getAdSettings(): Promise<AdSettings | null>;
  /**
   * Submissions exist only in a real workspace, so only the Supabase provider
   * has these two; a provider without them has none to show.
   */
  /** One form's newest submissions, newest first. */
  listFormSubmissions?(formId: string, limit?: number): Promise<FormSubmission[]>;
  /** When each submission since `sinceIso` came in, across every form. */
  listFormSubmissionTimes?(sinceIso: string): Promise<string[]>;
}
