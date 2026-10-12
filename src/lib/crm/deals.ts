import type { SupabaseClient } from '@supabase/supabase-js';
import { CrmContactFormError, MAX_TAG_LENGTH, ownerNames } from '@/lib/crm/contacts';
import { isWonStage } from '@/lib/crm/pipelines';

/** Separate from the stage: a deal anywhere on the board can be lost. */
export type CrmDealStatus = 'open' | 'won' | 'lost';

/** A deal as the board shows it. */
export type CrmDeal = {
  id: string;
  title: string;
  /** The contact's company, or their name when they have none. Heads the card. */
  company: string;
  /** The contact's first and last name. */
  contactName: string;
  /** In ringgit; the table stores cents. */
  value: number;
  /** The owner's name, or 'Unassigned'. */
  owner: string;
  tag?: string;
  status: CrmDealStatus;
  pipelineId: string;
  stageId: string;
  /** `last_activity_at`, formatted for display; '—' when never touched. */
  lastTouch: string;
  /** `YYYY-MM-DD`, or null when no date was given. */
  expectedClose: string | null;
  /** ISO timestamps. Null on sample rows. */
  createdAt: string | null;
  wonAt: string | null;
  lostAt: string | null;
  lostReason: string | null;
  /** What the invoices linked to the deal add up to. Absent when none is linked. */
  billing?: { count: number; billed: number; outstanding: number };
  /** Raw values keyed by the form's field names, for prefilling the edit form. */
  form?: Record<string, string>;
};

export type CrmDealsResult = {
  /** The most recent deals, across every pipeline. */
  deals: CrmDeal[];
  /** How many deals the workspace has, which can be more than were loaded. */
  total: number;
};

/** A contact a deal can be for, as the form's select lists it. */
export type CrmDealContactChoice = {
  id: string;
  /** "Company — First Last", or the name alone. */
  label: string;
};

/** The columns of `crm_deals` a person fills in on the form. */
export type CrmDealFields = {
  title: string;
  contact_id: string;
  stage_id: string;
  value_cents: number;
  tag: string | null;
  /** `YYYY-MM-DD`. */
  expected_close_date: string | null;
};

type CrmDealRow = {
  id: string;
  title: string | null;
  value_cents: number | null;
  tag: string | null;
  status: string | null;
  contact_id: string;
  pipeline_id: string;
  stage_id: string;
  expected_close_date: string | null;
  won_at: string | null;
  lost_at: string | null;
  lost_reason: string | null;
  owner_user_id: string | null;
  last_activity_at: string | null;
  created_at: string | null;
  crm_contacts: {
    company: string | null;
    first_name: string | null;
    last_name: string | null;
  } | null;
};

/** What a write needs to know about the deal it is changing. */
type CrmDealState = {
  id: string;
  status: CrmDealStatus;
  stage_id: string;
  pipeline_id: string;
};

type CrmStageState = {
  id: string;
  name: string;
  pipeline_id: string;
};

/** The status columns a change of stage can touch. */
export type CrmDealStatusPatch = {
  status?: CrmDealStatus;
  won_at?: string | null;
  lost_at?: string | null;
  lost_reason?: string | null;
};

/** Columns of `crm_deals` the board lists, with the contact it is for. */
const DEAL_COLUMNS = [
  'id',
  'title',
  'value_cents',
  'tag',
  'status',
  'contact_id',
  'pipeline_id',
  'stage_id',
  'expected_close_date',
  'won_at',
  'lost_at',
  'lost_reason',
  'owner_user_id',
  'last_activity_at',
  'created_at',
  'crm_contacts(company,first_name,last_name)',
].join(',');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Postgres foreign-key violation: a row the deal points at was deleted meanwhile. */
const FOREIGN_KEY_VIOLATION = '23503';

export const MAX_DEAL_TITLE_LENGTH = 200;
export const MAX_LOST_REASON_LENGTH = 200;
/** The largest value the form takes, in ringgit. */
export const MAX_DEAL_VALUE = 999_999_999_999;

const VALUE_MESSAGE = 'Enter the value as a number of ringgit, such as 18000.';
const GONE = 'That deal no longer exists.';

function readString(formData: FormData, key: string) {
  return String(formData.get(key) ?? '').trim();
}

function formatDate(value: string | null) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-MY', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(value));
}

function personName(first: string | null | undefined, last: string | null | undefined) {
  return [first, last]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(' ');
}

/** "Company — First Last", or the name alone when there is no company. */
export function contactLabel(
  company: string | null | undefined,
  first: string | null | undefined,
  last: string | null | undefined,
) {
  const name = personName(first, last);
  const firm = company?.trim();
  if (firm && name) return `${firm} — ${name}`;
  return firm || name || 'Unnamed contact';
}

function toStatus(value: string | null): CrmDealStatus {
  return value === 'won' || value === 'lost' ? value : 'open';
}

/** Cents to the ringgit figure the form edits: '18000', or '18000.50'. */
function centsToInput(cents: number) {
  const whole = Math.trunc(cents / 100);
  const rest = cents % 100;
  return rest === 0 ? String(whole) : `${whole}.${String(rest).padStart(2, '0')}`;
}

/**
 * Ringgit as typed ('18000', '18,000.50', 'RM 18 000') to cents. Worked out
 * on the digits, so no fraction is lost to floating point. Blank means zero.
 */
export function parseRinggit(value: string): number {
  const typed = value
    .trim()
    .replace(/^rm/i, '')
    .replace(/[\s,]/g, '');
  if (!typed) return 0;

  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(typed);
  if (!match) throw new CrmContactFormError(VALUE_MESSAGE);

  const whole = Number(match[1]);
  if (whole > MAX_DEAL_VALUE) {
    throw new CrmContactFormError('Enter a value below RM 1,000,000,000,000.');
  }
  return whole * 100 + Number((match[2] ?? '').padEnd(2, '0'));
}

/** `YYYY-MM-DD` as typed; rejects dates that do not exist. */
function parseCloseDate(value: string) {
  const invalid = new CrmContactFormError('Enter a valid expected close date.');
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw invalid;

  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  // Date.UTC rolls 30 Feb over to March, and maps years 0-99 to 1900-1999.
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw invalid;
  }
  return value;
}

/**
 * Validates the deal form, shared by adding and editing. Reads `title`,
 * `contactId`, `stageId`, `value` (ringgit), `tag` and `expectedCloseDate`.
 */
export function parseCrmDealForm(formData: FormData): CrmDealFields {
  const title = readString(formData, 'title').replace(/\s+/g, ' ');
  const contactId = readString(formData, 'contactId');
  const stageId = readString(formData, 'stageId');
  const tag = readString(formData, 'tag').replace(/\s+/g, ' ');
  const closeDate = readString(formData, 'expectedCloseDate');

  if (!title) throw new CrmContactFormError('Enter a title for the deal.');
  if (title.length > MAX_DEAL_TITLE_LENGTH) {
    throw new CrmContactFormError(
      `Keep the title to ${MAX_DEAL_TITLE_LENGTH} characters or fewer.`,
    );
  }
  if (!UUID.test(contactId)) throw new CrmContactFormError('Choose a contact.');
  if (!UUID.test(stageId)) throw new CrmContactFormError('Choose a stage.');
  const valueCents = parseRinggit(readString(formData, 'value'));
  if (tag.length > MAX_TAG_LENGTH) {
    throw new CrmContactFormError(`Keep the tag to ${MAX_TAG_LENGTH} characters or fewer.`);
  }

  return {
    title,
    contact_id: contactId,
    stage_id: stageId,
    value_cents: valueCents,
    tag: tag || null,
    expected_close_date: closeDate ? parseCloseDate(closeDate) : null,
  };
}

/** The id of the deal an edit, move or delete form is about. */
export function readDealId(formData: FormData): string {
  const id = readString(formData, 'dealId');
  if (!UUID.test(id)) throw new CrmContactFormError('That deal could not be found.');
  return id;
}

/** The id of the stage a deal is being moved to. */
export function readStageId(formData: FormData): string {
  const id = readString(formData, 'stageId');
  if (!UUID.test(id)) throw new CrmContactFormError('That stage could not be found.');
  return id;
}

/** Why a deal was lost: optional, at most 200 characters. */
export function readLostReason(formData: FormData): string | null {
  const reason = readString(formData, 'lostReason').replace(/\s+/g, ' ');
  if (reason.length > MAX_LOST_REASON_LENGTH) {
    throw new CrmContactFormError(
      `Keep the reason to ${MAX_LOST_REASON_LENGTH} characters or fewer.`,
    );
  }
  return reason || null;
}

/**
 * What a change of stage does to a deal's status. Going into the stage called
 * "Won" wins the deal, whatever it was before. Leaving it puts a won deal
 * back to open. A lost deal stays lost when it moves between other stages;
 * Reopen is how it comes back.
 */
export function stageStatusPatch(
  status: CrmDealStatus,
  toWonStage: boolean,
  now: string,
): CrmDealStatusPatch {
  if (toWonStage) {
    if (status === 'won') return {};
    return { status: 'won', won_at: now, lost_at: null, lost_reason: null };
  }
  if (status === 'won') return { status: 'open', won_at: null };
  return {};
}

export function mapCrmDeal(row: CrmDealRow, ownerName: string | null = null): CrmDeal {
  const tag = row.tag?.trim();
  const contact = row.crm_contacts;
  const name = personName(contact?.first_name, contact?.last_name);
  const cents = row.value_cents ?? 0;

  return {
    id: row.id,
    title: row.title?.trim() || 'Untitled deal',
    company: contact?.company?.trim() || name || 'Unknown contact',
    contactName: name,
    value: cents / 100,
    owner: ownerName ?? 'Unassigned',
    ...(tag ? { tag } : {}),
    status: toStatus(row.status),
    pipelineId: row.pipeline_id,
    stageId: row.stage_id,
    lastTouch: formatDate(row.last_activity_at),
    expectedClose: row.expected_close_date,
    createdAt: row.created_at,
    wonAt: row.won_at,
    lostAt: row.lost_at,
    lostReason: row.lost_reason,
    form: {
      title: row.title ?? '',
      contactId: row.contact_id,
      contactLabel: contactLabel(contact?.company, contact?.first_name, contact?.last_name),
      stageId: row.stage_id,
      value: centsToInput(cents),
      tag: row.tag ?? '',
      expectedCloseDate: row.expected_close_date ?? '',
    },
  };
}

/**
 * The workspace's most recent deals, across every pipeline. The board picks a
 * pipeline's deals out of these in the browser, which is also where search and
 * the filters run, so `limit` is how far they all reach.
 */
export async function listCrmDeals(
  client: SupabaseClient,
  orgId: string,
  limit = 500,
): Promise<CrmDealsResult> {
  const { data, count, error } = await client
    .from('crm_deals')
    .select(DEAL_COLUMNS, { count: 'exact' })
    .eq('org_id', orgId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;

  const rows = (Array.isArray(data) ? data : []) as unknown as CrmDealRow[];
  const names = await ownerNames(client, rows);

  return {
    deals: rows.map((row) =>
      mapCrmDeal(row, row.owner_user_id ? (names.get(row.owner_user_id) ?? null) : null),
    ),
    total: count ?? rows.length,
  };
}

/** The contacts a deal can be for, in the order the select lists them. */
export async function listCrmDealContacts(
  client: SupabaseClient,
  orgId: string,
  limit = 1000,
): Promise<CrmDealContactChoice[]> {
  const { data, error } = await client
    .from('crm_contacts')
    .select('id,company,first_name,last_name')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;

  const rows = (data ?? []) as unknown as {
    id: string;
    company: string | null;
    first_name: string | null;
    last_name: string | null;
  }[];
  return rows
    .map((row) => ({
      id: row.id,
      label: contactLabel(row.company, row.first_name, row.last_name),
    }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
}

/** A foreign key that failed: say which choice has gone, beside the form. */
function throwWriteError(error: { code?: string; message?: string; details?: string }): never {
  if (error.code === FOREIGN_KEY_VIOLATION) {
    const about = `${error.message ?? ''} ${error.details ?? ''}`;
    if (about.includes('contact')) {
      throw new CrmContactFormError('That contact no longer exists. Choose another.');
    }
    if (about.includes('stage') || about.includes('pipeline')) {
      throw new CrmContactFormError('That stage no longer exists. Choose another.');
    }
    throw new CrmContactFormError(
      'The contact or stage you chose no longer exists. Choose another.',
    );
  }
  throw error;
}

/** The stage a deal is going into, which must belong to this workspace. */
async function readStage(
  client: SupabaseClient,
  orgId: string,
  stageId: string,
): Promise<CrmStageState> {
  const { data, error } = await client
    .from('crm_pipeline_stages')
    .select('id,name,pipeline_id')
    .eq('id', stageId)
    .eq('org_id', orgId)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new CrmContactFormError('That stage no longer exists. Choose another.');
  return data as unknown as CrmStageState;
}

/** A deal that is gone, or belongs to another org, matches no row. */
async function readDeal(
  client: SupabaseClient,
  orgId: string,
  id: string,
): Promise<CrmDealState> {
  const { data, error } = await client
    .from('crm_deals')
    .select('id,status,stage_id,pipeline_id')
    .eq('id', id)
    .eq('org_id', orgId)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new CrmContactFormError(GONE);
  const row = data as unknown as Omit<CrmDealState, 'status'> & { status: string | null };
  return { ...row, status: toStatus(row.status) };
}

/**
 * Writes `patch` to one deal in one org. Nothing in the database maintains
 * `updated_at` or `last_activity_at`, so every change sets both.
 */
async function patchDeal(
  client: SupabaseClient,
  orgId: string,
  id: string,
  patch: Record<string, unknown>,
  now: string,
): Promise<void> {
  const { data, error } = await client
    .from('crm_deals')
    .update({ ...patch, last_activity_at: now, updated_at: now })
    .eq('id', id)
    .eq('org_id', orgId)
    .select('id');

  if (error) throwWriteError(error);
  if (!data || data.length === 0) throw new CrmContactFormError(GONE);
}

/**
 * Adds a deal, owned by `ownerUserId` when given. Its pipeline is the one the
 * chosen stage belongs to, and a deal added straight into "Won" is won.
 */
export async function createCrmDeal(
  client: SupabaseClient,
  orgId: string,
  fields: CrmDealFields,
  ownerUserId?: string | null,
  now: Date = new Date(),
): Promise<void> {
  const stamp = now.toISOString();
  const stage = await readStage(client, orgId, fields.stage_id);

  const { error } = await client.from('crm_deals').insert({
    org_id: orgId,
    ...fields,
    pipeline_id: stage.pipeline_id,
    ...stageStatusPatch('open', isWonStage(stage.name), stamp),
    ...(ownerUserId ? { owner_user_id: ownerUserId } : {}),
    last_activity_at: stamp,
  });

  if (error) throwWriteError(error);
}

/** Saves the edit form. Choosing another stage there moves the deal too. */
export async function updateCrmDeal(
  client: SupabaseClient,
  orgId: string,
  id: string,
  fields: CrmDealFields,
  now: Date = new Date(),
): Promise<void> {
  const stamp = now.toISOString();
  const deal = await readDeal(client, orgId, id);

  let statusPatch: CrmDealStatusPatch = {};
  if (fields.stage_id !== deal.stage_id) {
    const stage = await readStage(client, orgId, fields.stage_id);
    if (stage.pipeline_id !== deal.pipeline_id) {
      throw new CrmContactFormError("Choose a stage from this deal's pipeline.");
    }
    statusPatch = stageStatusPatch(deal.status, isWonStage(stage.name), stamp);
  }

  await patchDeal(client, orgId, id, { ...fields, ...statusPatch }, stamp);
}

/** Moves a deal to another stage of its pipeline. */
export async function moveCrmDeal(
  client: SupabaseClient,
  orgId: string,
  id: string,
  stageId: string,
  now: Date = new Date(),
): Promise<void> {
  const stamp = now.toISOString();
  const [deal, stage] = await Promise.all([
    readDeal(client, orgId, id),
    readStage(client, orgId, stageId),
  ]);
  // Already there: another tab moved it first.
  if (deal.stage_id === stage.id) return;
  if (stage.pipeline_id !== deal.pipeline_id) {
    throw new CrmContactFormError("Choose a stage from this deal's pipeline.");
  }

  await patchDeal(
    client,
    orgId,
    id,
    { stage_id: stage.id, ...stageStatusPatch(deal.status, isWonStage(stage.name), stamp) },
    stamp,
  );
}

/** Marks a deal lost where it stands, with the reason if one was given. */
export async function markCrmDealLost(
  client: SupabaseClient,
  orgId: string,
  id: string,
  reason: string | null,
  now: Date = new Date(),
): Promise<void> {
  const stamp = now.toISOString();
  await patchDeal(
    client,
    orgId,
    id,
    { status: 'lost', lost_at: stamp, lost_reason: reason, won_at: null },
    stamp,
  );
}

/**
 * Brings a lost deal back. It returns to open, unless it sits in the "Won"
 * stage, where a deal that is not lost is won.
 */
export async function reopenCrmDeal(
  client: SupabaseClient,
  orgId: string,
  id: string,
  now: Date = new Date(),
): Promise<void> {
  const stamp = now.toISOString();
  const deal = await readDeal(client, orgId, id);
  // Already reopened in another tab.
  if (deal.status !== 'lost') return;

  const stage = await readStage(client, orgId, deal.stage_id);
  const won = isWonStage(stage.name);
  await patchDeal(
    client,
    orgId,
    id,
    {
      status: won ? 'won' : 'open',
      won_at: won ? stamp : null,
      lost_at: null,
      lost_reason: null,
    },
    stamp,
  );
}

/** Deletes a deal. Its activities, notes and attachments go with it. */
export async function deleteCrmDeal(
  client: SupabaseClient,
  orgId: string,
  id: string,
): Promise<void> {
  const { data, error } = await client
    .from('crm_deals')
    .delete()
    .eq('id', id)
    .eq('org_id', orgId)
    .select('id');

  if (error) throw error;
  if (!data || data.length === 0) throw new CrmContactFormError(GONE);
}
