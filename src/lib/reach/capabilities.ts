/**
 * The single write path for Jebat reach data. Each mutation is one Zod schema +
 * one async function; the AI tool's inputSchema IS the schema and the UI server
 * action parses with it, so the two surfaces cannot diverge. org_id always comes
 * from the ReachWriteContext (the caller's session), never from the input.
 */
import { errorCodeOf } from '@/lib/ai/call-log';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { createCrmContact, type CrmContactInsert } from '@/lib/crm/contacts';
import type { AdSettings, Appointment, Campaign, Creative, Form, Lead } from './types';
import {
  FORM_CATEGORY_MAX,
  FORM_COLUMNS,
  FORM_CONSENT_MAX,
  FORM_MESSAGES,
  FORM_NAME_MAX,
  FORM_SLUG_INPUT_PATTERN,
  resolveFormSlug,
} from './forms';

export type ReachWriteContext = { client: SupabaseClient; orgId: string };
/**
 * A capability's answer. `stale` (set only by Bendahara's agent note) means the target no longer
 * matches what the suggestion was about: the apply path dismisses the proposal instead of failing it.
 */
export type CapResult<T> = { ok: true; data: T } | { ok: false; error: string; stale?: true };

const channel = z.enum(['whatsapp', 'facebook', 'instagram', 'tiktok']);
const campaignStatus = z.enum(['active', 'paused']);

export const createCampaignInput = z.object({
  name: z.string().trim().min(1).max(120),
  channel,
  status: campaignStatus.default('active'),
  spend_cents: z.number().int().min(0).default(0),
  leads_count: z.number().int().min(0).default(0),
});
export const updateCampaignInput = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(120).optional(),
  channel: channel.optional(),
  status: campaignStatus.optional(),
  spend_cents: z.number().int().min(0).optional(),
  leads_count: z.number().int().min(0).optional(),
});
export const setCampaignStatusInput = z.object({ id: z.string().uuid(), status: campaignStatus });
export const deleteCampaignInput = z.object({ id: z.string().uuid() });

const WRITE_FAILED = 'That change could not be saved. Please try again.';

/** Logs the DB error's code for triage; callers only ever see the generic user-facing message. */
function writeFailed(fnName: string, error: unknown): { ok: false; error: string } {
  // The code only: a database error's message and details quote the values it refused.
  console.error(`[reach-capability] ${fnName} failed:`, errorCodeOf(error));
  return { ok: false, error: WRITE_FAILED };
}

export async function createCampaign(
  ctx: ReachWriteContext,
  input: z.infer<typeof createCampaignInput>,
): Promise<CapResult<Campaign>> {
  const values = createCampaignInput.parse(input);
  const { data, error } = await ctx.client
    .from('campaigns')
    .insert({ ...values, org_id: ctx.orgId })
    .select('id,name,channel,status,leads_count,spend_cents,cpl_cents,created_at')
    .single();
  if (error || !data) return writeFailed('createCampaign', error);
  return { ok: true, data: data as Campaign };
}

export async function updateCampaign(
  ctx: ReachWriteContext,
  input: z.infer<typeof updateCampaignInput>,
): Promise<CapResult<Campaign>> {
  const { id, ...fields } = updateCampaignInput.parse(input);
  if (Object.values(fields).every((v) => v === undefined)) {
    return { ok: false, error: 'Nothing to update.' };
  }
  const { data, error } = await ctx.client
    .from('campaigns')
    .update(fields)
    .eq('id', id)
    .eq('org_id', ctx.orgId)
    .select('id,name,channel,status,leads_count,spend_cents,cpl_cents,created_at')
    .maybeSingle();
  if (error) return writeFailed('updateCampaign', error);
  if (!data) return { ok: false, error: 'That campaign was not found.' };
  return { ok: true, data: data as Campaign };
}

export async function setCampaignStatus(
  ctx: ReachWriteContext,
  input: z.infer<typeof setCampaignStatusInput>,
): Promise<CapResult<Campaign>> {
  const { id, status } = setCampaignStatusInput.parse(input);
  return updateCampaign(ctx, { id, status });
}

export async function deleteCampaign(
  ctx: ReachWriteContext,
  input: z.infer<typeof deleteCampaignInput>,
): Promise<CapResult<{ id: string }>> {
  const { id } = deleteCampaignInput.parse(input);
  const { data, error } = await ctx.client
    .from('campaigns')
    .delete()
    .eq('id', id)
    .eq('org_id', ctx.orgId)
    .select('id')
    .maybeSingle();
  if (error) return writeFailed('deleteCampaign', error);
  if (!data) return { ok: false, error: 'That campaign was not found.' };
  return { ok: true, data: { id: data.id } };
}

// ---- Leads ----------------------------------------------------------------
// promoted_contact_id is never accepted here; only the promote capability sets it.
const leadStage = z.enum(['lead', 'contacted', 'qualified', 'booked', 'won']);
const LEAD_COLS = 'id,name,channel,stage,source,promoted_contact_id,created_at';

export const createLeadInput = z.object({
  name: z.string().trim().min(1).max(120),
  channel,
  stage: leadStage.default('lead'),
  source: z.string().trim().max(120).optional(),
});
export const updateLeadInput = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(120).optional(),
  channel: channel.optional(),
  stage: leadStage.optional(),
  source: z.string().trim().max(120).optional(),
});
export const setLeadStageInput = z.object({ id: z.string().uuid(), stage: leadStage });
export const deleteLeadInput = z.object({ id: z.string().uuid() });

export async function createLead(
  ctx: ReachWriteContext,
  input: z.input<typeof createLeadInput>,
): Promise<CapResult<Lead>> {
  const values = createLeadInput.parse(input);
  const { data, error } = await ctx.client
    .from('leads')
    .insert({ ...values, org_id: ctx.orgId })
    .select(LEAD_COLS)
    .single();
  if (error || !data) return writeFailed('createLead', error);
  return { ok: true, data: data as unknown as Lead };
}

export async function updateLead(
  ctx: ReachWriteContext,
  input: z.infer<typeof updateLeadInput>,
): Promise<CapResult<Lead>> {
  const { id, ...fields } = updateLeadInput.parse(input);
  if (Object.values(fields).every((v) => v === undefined)) {
    return { ok: false, error: 'Nothing to update.' };
  }
  const { data, error } = await ctx.client
    .from('leads')
    .update(fields)
    .eq('id', id)
    .eq('org_id', ctx.orgId)
    .select(LEAD_COLS)
    .maybeSingle();
  if (error) return writeFailed('updateLead', error);
  if (!data) return { ok: false, error: 'That lead was not found.' };
  return { ok: true, data: data as unknown as Lead };
}

export async function setLeadStage(
  ctx: ReachWriteContext,
  input: z.infer<typeof setLeadStageInput>,
): Promise<CapResult<Lead>> {
  const { id, stage } = setLeadStageInput.parse(input);
  return updateLead(ctx, { id, stage });
}

export async function deleteLead(
  ctx: ReachWriteContext,
  input: z.infer<typeof deleteLeadInput>,
): Promise<CapResult<{ id: string }>> {
  const { id } = deleteLeadInput.parse(input);
  const { data, error } = await ctx.client
    .from('leads')
    .delete()
    .eq('id', id)
    .eq('org_id', ctx.orgId)
    .select('id')
    .maybeSingle();
  if (error) return writeFailed('deleteLead', error);
  if (!data) return { ok: false, error: 'That lead was not found.' };
  return { ok: true, data: { id: data.id } };
}

// ---- Appointments ---------------------------------------------------------
const appointmentStatus = z.enum(['scheduled', 'completed', 'cancelled', 'no_show']);
const APPOINTMENT_COLS = 'id,contact_name,kind,scheduled_at,via,status,created_at';

export const createAppointmentInput = z.object({
  contact_name: z.string().trim().min(1).max(120),
  kind: z.string().trim().min(1).max(120),
  scheduled_at: z.string().datetime(),
  via: z.string().trim().min(1).max(80).optional(),
  status: appointmentStatus.default('scheduled'),
});
export const updateAppointmentInput = z.object({
  id: z.string().uuid(),
  contact_name: z.string().trim().min(1).max(120).optional(),
  kind: z.string().trim().min(1).max(120).optional(),
  scheduled_at: z.string().datetime().optional(),
  via: z.string().trim().min(1).max(80).optional(),
  status: appointmentStatus.optional(),
});
export const setAppointmentStatusInput = z.object({ id: z.string().uuid(), status: appointmentStatus });
export const deleteAppointmentInput = z.object({ id: z.string().uuid() });

export async function createAppointment(
  ctx: ReachWriteContext,
  input: z.input<typeof createAppointmentInput>,
): Promise<CapResult<Appointment>> {
  const values = createAppointmentInput.parse(input);
  const { data, error } = await ctx.client
    .from('appointments')
    .insert({ ...values, org_id: ctx.orgId })
    .select(APPOINTMENT_COLS)
    .single();
  if (error || !data) return writeFailed('createAppointment', error);
  return { ok: true, data: data as unknown as Appointment };
}

export async function updateAppointment(
  ctx: ReachWriteContext,
  input: z.infer<typeof updateAppointmentInput>,
): Promise<CapResult<Appointment>> {
  const { id, ...fields } = updateAppointmentInput.parse(input);
  if (Object.values(fields).every((v) => v === undefined)) {
    return { ok: false, error: 'Nothing to update.' };
  }
  const { data, error } = await ctx.client
    .from('appointments')
    .update(fields)
    .eq('id', id)
    .eq('org_id', ctx.orgId)
    .select(APPOINTMENT_COLS)
    .maybeSingle();
  if (error) return writeFailed('updateAppointment', error);
  if (!data) return { ok: false, error: 'That appointment was not found.' };
  return { ok: true, data: data as unknown as Appointment };
}

export async function setAppointmentStatus(
  ctx: ReachWriteContext,
  input: z.infer<typeof setAppointmentStatusInput>,
): Promise<CapResult<Appointment>> {
  const { id, status } = setAppointmentStatusInput.parse(input);
  return updateAppointment(ctx, { id, status });
}

export async function deleteAppointment(
  ctx: ReachWriteContext,
  input: z.infer<typeof deleteAppointmentInput>,
): Promise<CapResult<{ id: string }>> {
  const { id } = deleteAppointmentInput.parse(input);
  const { data, error } = await ctx.client
    .from('appointments')
    .delete()
    .eq('id', id)
    .eq('org_id', ctx.orgId)
    .select('id')
    .maybeSingle();
  if (error) return writeFailed('deleteAppointment', error);
  if (!data) return { ok: false, error: 'That appointment was not found.' };
  return { ok: true, data: { id: data.id } };
}

// ---- Promote lead → CRM contact -------------------------------------------
export function leadStageToCrmStatus(stage: Lead['stage']): string {
  return (
    { lead: 'lead', contacted: 'contacted', qualified: 'qualified', booked: 'qualified', won: 'customer' } as const
  )[stage];
}
export function leadStageToScore(stage: Lead['stage']): number {
  return ({ lead: 20, contacted: 40, qualified: 60, booked: 80, won: 100 } as const)[stage];
}
export function splitLeadName(name: string): { first_name: string; last_name: string | null } {
  const t = name.trim();
  const i = t.indexOf(' ');
  return i === -1 ? { first_name: t, last_name: null } : { first_name: t.slice(0, i), last_name: t.slice(i + 1) };
}

export const promoteLeadToContactInput = z.object({ id: z.string().uuid() });

/**
 * One-way bridge: reuses createCrmContact, then stamps the lead so it cannot be promoted twice.
 * Re-promote is allowed only if the previously promoted contact was deleted in CRM.
 */
export async function promoteLeadToContact(
  ctx: ReachWriteContext,
  input: z.infer<typeof promoteLeadToContactInput>,
): Promise<CapResult<{ contact_id: string; contact: { id: string; name: string } }>> {
  const { id } = promoteLeadToContactInput.parse(input);
  const { data: lead, error: readErr } = await ctx.client
    .from('leads')
    .select('id,name,channel,stage,source,promoted_contact_id')
    .eq('id', id)
    .eq('org_id', ctx.orgId)
    .maybeSingle();
  if (readErr) return writeFailed('promoteLeadToContact.read', readErr);
  if (!lead) return { ok: false, error: 'That lead was not found.' };
  const existingContactId = (lead as { promoted_contact_id: string | null }).promoted_contact_id;
  if (existingContactId) {
    const { data: existingContact, error: contactErr } = await ctx.client
      .from('crm_contacts')
      .select('id')
      .eq('id', existingContactId)
      .eq('org_id', ctx.orgId)
      .maybeSingle();
    if (contactErr) return writeFailed('promoteLeadToContact.contactCheck', contactErr);
    if (existingContact) return { ok: false, error: 'Already promoted to a contact.' };
    // The promoted contact was deleted in CRM; fall through to re-promote (fresh contact + re-stamp).
  }
  const l = lead as unknown as Lead;
  const name = splitLeadName(l.name);
  const payload: CrmContactInsert = {
    first_name: name.first_name,
    last_name: name.last_name,
    email: '',
    phone: null,
    company: null,
    // NOT '': crm_contacts CHECK is (country IS NULL OR country ~ '^[A-Z]{2}$') and
    // CrmContactInsert.country is non-null. 'MY' matches parseCrmContactFields's default.
    country: 'MY',
    status: leadStageToCrmStatus(l.stage),
    lead_score: leadStageToScore(l.stage),
    tags: [l.channel, ...(l.source ? [l.source] : [])],
    org_id: ctx.orgId,
  };
  let contactId: string;
  try {
    const contact = await createCrmContact(ctx.client, payload);
    contactId = contact.id;
  } catch (error) {
    return writeFailed('promoteLeadToContact.createContact', error);
  }
  const { error: stampErr } = await ctx.client
    .from('leads')
    .update({ promoted_contact_id: contactId })
    .eq('id', id)
    .eq('org_id', ctx.orgId);
  // The contact exists; a re-promote would duplicate it (rare, low-harm), so log and succeed.
  if (stampErr) console.error('[reach-capability] promoteLeadToContact.stamp failed:', errorCodeOf(stampErr));
  // The contact is returned by name too, so a later change to it can say who it is about.
  return { ok: true, data: { contact_id: contactId, contact: { id: contactId, name: l.name.trim() } } };
}

const creativeType = z.enum(['image', 'video', 'copy']);
const creativeStatus = z.enum(['draft', 'active', 'archived']);

export const createCreativeInput = z.object({
  name: z.string().trim().min(1).max(120),
  type: creativeType,
  channel,
  status: creativeStatus.default('draft'),
  campaign_id: z.string().uuid().nullable().default(null),
  body: z.string().trim().max(2000).nullable().default(null),
  ctr: z.number().min(0).max(100).nullable().default(null),
});
export const updateCreativeInput = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(120).optional(),
  type: creativeType.optional(),
  channel: channel.optional(),
  status: creativeStatus.optional(),
  campaign_id: z.string().uuid().nullable().optional(),
  body: z.string().trim().max(2000).nullable().optional(),
  ctr: z.number().min(0).max(100).nullable().optional(),
});
export const deleteCreativeInput = z.object({ id: z.string().uuid() });

const CREATIVE_COLS = 'id,campaign_id,name,type,channel,status,body,ctr,created_at';

export async function createCreative(
  ctx: ReachWriteContext,
  input: z.infer<typeof createCreativeInput>,
): Promise<CapResult<Creative>> {
  const values = createCreativeInput.parse(input);
  const { data, error } = await ctx.client
    .from('creatives')
    .insert({ ...values, org_id: ctx.orgId })
    .select(CREATIVE_COLS)
    .single();
  if (error || !data) return writeFailed('createCreative', error);
  return { ok: true, data: data as Creative };
}

export async function updateCreative(
  ctx: ReachWriteContext,
  input: z.infer<typeof updateCreativeInput>,
): Promise<CapResult<Creative>> {
  const { id, ...fields } = updateCreativeInput.parse(input);
  if (Object.values(fields).every((v) => v === undefined)) {
    return { ok: false, error: 'Nothing to update.' };
  }
  const { data, error } = await ctx.client
    .from('creatives')
    .update(fields)
    .eq('id', id)
    .eq('org_id', ctx.orgId)
    .select(CREATIVE_COLS)
    .maybeSingle();
  if (error) return writeFailed('updateCreative', error);
  if (!data) return { ok: false, error: 'That creative was not found.' };
  return { ok: true, data: data as Creative };
}

export async function deleteCreative(
  ctx: ReachWriteContext,
  input: z.infer<typeof deleteCreativeInput>,
): Promise<CapResult<{ id: string }>> {
  const { id } = deleteCreativeInput.parse(input);
  const { data, error } = await ctx.client
    .from('creatives')
    .delete()
    .eq('id', id)
    .eq('org_id', ctx.orgId)
    .select('id')
    .maybeSingle();
  if (error) return writeFailed('deleteCreative', error);
  if (!data) return { ok: false, error: 'That creative was not found.' };
  return { ok: true, data: { id: data.id } };
}

// ─── ad settings (one row per org, upserted) ─────────────────────────────────

export const updateAdSettingsInput = z.object({
  daily_cap_cents: z.number().int().min(0).nullable().optional(),
  monthly_cap_cents: z.number().int().min(0).nullable().optional(),
  currency: z.string().length(3).optional(),
  automation: z.record(z.string(), z.boolean()).optional(),
  notifications: z.record(z.string(), z.boolean()).optional(),
});

export async function updateAdSettings(
  ctx: ReachWriteContext,
  input: z.infer<typeof updateAdSettingsInput>,
): Promise<CapResult<AdSettings>> {
  const parsed = updateAdSettingsInput.parse(input);
  const cols = 'daily_cap_cents,monthly_cap_cents,currency,automation,notifications,updated_at';
  // Update-first: an UPDATE must never SET org_id (not granted); insert only if no row exists yet.
  const upd = await ctx.client
    .from('ad_settings')
    .update({ ...parsed, updated_at: new Date().toISOString() })
    .eq('org_id', ctx.orgId)
    .select(cols)
    .maybeSingle();
  if (upd.error) return writeFailed('updateAdSettings', upd.error);
  if (upd.data) return { ok: true, data: upd.data as AdSettings };
  const ins = await ctx.client
    .from('ad_settings')
    .insert({ ...parsed, org_id: ctx.orgId })
    .select(cols)
    .single();
  if (ins.error || !ins.data) return writeFailed('updateAdSettings', ins.error);
  return { ok: true, data: ins.data as AdSettings };
}

// ─── lead forms ──────────────────────────────────────────────────────────────

const formStatus = z.enum(['draft', 'active', 'paused'], { error: FORM_MESSAGES.status });
const formName = z
  .string({ error: FORM_MESSAGES.name })
  .trim()
  .min(1, FORM_MESSAGES.name)
  .max(FORM_NAME_MAX, FORM_MESSAGES.nameTooLong);
const formCategory = z
  .string({ error: FORM_MESSAGES.categoryTooLong })
  .trim()
  .max(FORM_CATEGORY_MAX, FORM_MESSAGES.categoryTooLong)
  .nullable();
/** The link, with or without its leading "/". Empty means: derive it from the name. */
const formSlug = z
  .string({ error: FORM_MESSAGES.slug })
  .trim()
  .regex(FORM_SLUG_INPUT_PATTERN, FORM_MESSAGES.slug);
const formChannel = z
  .enum(['whatsapp', 'facebook', 'instagram', 'tiktok'], { error: FORM_MESSAGES.channel })
  .nullable();
const formId = z.string({ error: FORM_MESSAGES.gone }).uuid(FORM_MESSAGES.gone);
/**
 * The sentence a visitor ticks to agree. Counted per character, as the
 * database counts it. Left out of a new form, the database's default is used.
 */
const formConsent = z
  .string({ error: FORM_MESSAGES.consent })
  .trim()
  .min(1, FORM_MESSAGES.consent)
  .refine((text) => [...text].length <= FORM_CONSENT_MAX, FORM_MESSAGES.consentTooLong);

export const createFormInput = z.object({
  name: formName,
  category: formCategory.default(null),
  slug: formSlug.optional(),
  channel: formChannel.default(null),
  status: formStatus.default('draft'),
  consent_text: formConsent.optional(),
});
export const updateFormInput = z.object({
  id: formId,
  name: formName.optional(),
  category: formCategory.optional(),
  slug: formSlug.optional(),
  channel: formChannel.optional(),
  status: formStatus.optional(),
  consent_text: formConsent.optional(),
});
/**
 * What Tuah's createForm and updateForm tools take: the same rules, without the
 * consent sentence. The model is shown exactly what it was shown before the
 * sentence existed, so a form it makes gets the database's default sentence.
 */
export const createFormToolInput = createFormInput.omit({ consent_text: true });
export const updateFormToolInput = updateFormInput.omit({ consent_text: true });
export const setFormStatusInput = z.object({ id: formId, status: formStatus });
export const deleteFormInput = z.object({ id: formId });

/** Postgres unique violation: (org_id, slug) is already taken. */
const UNIQUE_VIOLATION = '23505';

function formWriteFailed(fnName: string, error: unknown): { ok: false; error: string } {
  if ((error as { code?: string } | null)?.code === UNIQUE_VIOLATION) {
    return { ok: false, error: FORM_MESSAGES.slugTaken };
  }
  return writeFailed(fnName, error);
}

export async function createForm(
  ctx: ReachWriteContext,
  input: z.input<typeof createFormInput>,
): Promise<CapResult<Form>> {
  const values = createFormInput.parse(input);
  const slug = resolveFormSlug(values.slug, values.name);
  if (!slug.ok) return slug;
  const { data, error } = await ctx.client
    .from('forms')
    .insert({
      org_id: ctx.orgId,
      name: values.name,
      category: values.category || null,
      slug: slug.slug,
      channel: values.channel,
      status: values.status,
      // Left out, the database gives the form its default sentence.
      ...(values.consent_text !== undefined ? { consent_text: values.consent_text } : {}),
    })
    .select(FORM_COLUMNS)
    .single();
  if (error || !data) return formWriteFailed('createForm', error);
  return { ok: true, data: data as unknown as Form };
}

export async function updateForm(
  ctx: ReachWriteContext,
  input: z.input<typeof updateFormInput>,
): Promise<CapResult<Form>> {
  const { id, slug: rawSlug, category, ...rest } = updateFormInput.parse(input);
  const fields: Record<string, unknown> = { ...rest };
  if (category !== undefined) fields.category = category || null;
  if (rawSlug !== undefined) {
    // An emptied link is derived again from the name sent with it.
    const slug = resolveFormSlug(rawSlug, rest.name);
    if (!slug.ok) return slug;
    fields.slug = slug.slug;
  }
  if (Object.values(fields).every((v) => v === undefined)) {
    return { ok: false, error: 'Nothing to update.' };
  }
  const { data, error } = await ctx.client
    .from('forms')
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('org_id', ctx.orgId)
    .select(FORM_COLUMNS)
    .maybeSingle();
  if (error) return formWriteFailed('updateForm', error);
  if (!data) return { ok: false, error: FORM_MESSAGES.gone };
  return { ok: true, data: data as unknown as Form };
}

/** Activate or pause a form (or move it back to draft). */
export async function setFormStatus(
  ctx: ReachWriteContext,
  input: z.input<typeof setFormStatusInput>,
): Promise<CapResult<Form>> {
  const { id, status } = setFormStatusInput.parse(input);
  return updateForm(ctx, { id, status });
}

export async function deleteForm(
  ctx: ReachWriteContext,
  input: z.input<typeof deleteFormInput>,
): Promise<CapResult<{ id: string }>> {
  const { id } = deleteFormInput.parse(input);
  const { data, error } = await ctx.client
    .from('forms')
    .delete()
    .eq('id', id)
    .eq('org_id', ctx.orgId)
    .select('id')
    .maybeSingle();
  if (error) return formWriteFailed('deleteForm', error);
  if (!data) return { ok: false, error: FORM_MESSAGES.gone };
  return { ok: true, data: { id: data.id } };
}

// ─── lead form submissions ───────────────────────────────────────────────────
// Submissions are written only by the public page (through submit_public_form).
// A member with write access may delete one; nothing can edit one.

const SUBMISSION_GONE = 'That submission no longer exists.';

export const deleteFormSubmissionInput = z.object({
  id: z.string({ error: SUBMISSION_GONE }).uuid(SUBMISSION_GONE),
});

/** Deletes one submission. The contact it made is kept. */
export async function deleteFormSubmission(
  ctx: ReachWriteContext,
  input: z.input<typeof deleteFormSubmissionInput>,
): Promise<CapResult<{ id: string }>> {
  const { id } = deleteFormSubmissionInput.parse(input);
  const { data, error } = await ctx.client
    .from('form_submissions')
    .delete()
    .eq('id', id)
    .eq('org_id', ctx.orgId)
    .select('id')
    .maybeSingle();
  if (error) return writeFailed('deleteFormSubmission', error);
  if (!data) return { ok: false, error: SUBMISSION_GONE };
  return { ok: true, data: { id: data.id } };
}
