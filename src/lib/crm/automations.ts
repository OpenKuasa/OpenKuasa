import type { SupabaseClient } from '@supabase/supabase-js';
import { CrmContactFormError, MAX_TAG_LENGTH } from '@/lib/crm/contacts';
import { klDay } from '@/lib/crm/deal-stats';

/**
 * Kasturi's automations: "when this happens, do that". One trigger, one
 * action. The database runs them itself, the moment the event happens (see
 * the `kasturi_automations` migration); this file is how the screen lists,
 * adds and changes them, and reads what they have done. Nothing here runs one.
 */

export const AUTOMATION_TRIGGERS = ['contact_created', 'form_submitted', 'deal_stage', 'deal_won', 'deal_lost'] as const;
export type AutomationTrigger = (typeof AUTOMATION_TRIGGERS)[number];

export const AUTOMATION_ACTIONS = ['add_follow_up', 'add_tag', 'set_status'] as const;
export type AutomationAction = (typeof AUTOMATION_ACTIONS)[number];

/** The statuses an automation can set. It never archives a contact. */
export const AUTOMATION_STATUSES = ['lead', 'contacted', 'qualified', 'customer'] as const;
export type AutomationStatus = (typeof AUTOMATION_STATUSES)[number];

export const TRIGGER_LABELS: Record<AutomationTrigger, string> = {
  contact_created: 'A contact is created',
  form_submitted: 'A lead form is submitted',
  deal_stage: 'A deal arrives in a stage',
  deal_won: 'A deal is won',
  deal_lost: 'A deal is lost',
};

export const ACTION_LABELS: Record<AutomationAction, string> = {
  add_follow_up: 'Add a follow-up',
  add_tag: 'Add a tag',
  set_status: 'Set the contact’s status',
};

export const STATUS_LABELS: Record<AutomationStatus, string> = {
  lead: 'New lead',
  contacted: 'Contacted',
  qualified: 'Qualified',
  customer: 'Customer',
};

/** The same limits as the table's check constraints. */
export const AUTOMATION_NAME_MAX = 120;
export const AUTOMATION_TITLE_MAX = 200;
export const AUTOMATION_DUE_DAYS_MAX = 365;
/** How many runs in one day switch an automation off. The database enforces it. */
export const AUTOMATION_DAILY_CAP = 1000;
/** How many automations a workspace can have switched on. The database enforces it. */
export const AUTOMATIONS_ENABLED_MAX = 50;
/** How many automations and recent runs the screen loads. */
export const AUTOMATIONS_LOADED = 500;
export const RECENT_RUNS_LISTED = 12;
/** How many weeks the "Runs over time" chart covers, ending with this one. */
export const RUN_TREND_WEEKS = 8;
const RUN_PAGE_SIZE = 1000;
/** The most runs read for the chart and the figures. */
const RUNS_READ_MAX = 20000;

export const AUTOMATION_MESSAGES = {
  name: 'Enter a name for the automation.',
  nameTooLong: `Keep the name to ${AUTOMATION_NAME_MAX} characters or fewer.`,
  trigger: 'Choose what sets the automation off.',
  stage: 'Choose the stage a deal must arrive in.',
  form: 'Choose a lead form, or "Any lead form".',
  action: 'Choose what the automation does.',
  title: 'Say what the follow-up is for.',
  titleTooLong: `Keep the follow-up to ${AUTOMATION_TITLE_MAX} characters or fewer.`,
  dueDays: `Enter a number of days from 0 to ${AUTOMATION_DUE_DAYS_MAX}, or leave it empty for no due date.`,
  tag: 'Enter the tag to add.',
  tagTooLong: `Keep the tag to ${MAX_TAG_LENGTH} characters or fewer.`,
  tagComma: 'Enter one tag, without commas.',
  status: 'Choose the status to set.',
  missing: 'The stage or lead form you chose no longer exists. Choose another.',
  tooManyOn: `A workspace can have at most ${AUTOMATIONS_ENABLED_MAX} automations switched on. Switch one off first.`,
  gone: 'That automation no longer exists.',
} as const;

const M = AUTOMATION_MESSAGES;

export type RunStatus = 'done' | 'skipped' | 'failed';

export type Automation = {
  id: string;
  name: string;
  trigger: AutomationTrigger;
  /** For `deal_stage`. Null when the stage was deleted: it then matches nothing. */
  stageId: string | null;
  /** For `form_submitted`, unless `anyForm`. Null when the form was deleted. */
  formId: string | null;
  anyForm: boolean;
  action: AutomationAction;
  title: string;
  /** Days from the event the follow-up is due; null for no due date. */
  dueDays: number | null;
  tag: string;
  status: AutomationStatus | null;
  enabled: boolean;
  /** Why the database switched it off, when it did. */
  pausedReason: string | null;
  runs: number;
  /** `YYYY-MM-DD` in Malaysia of its last run; null when it has never run. */
  lastRunDay: string | null;
};

/** The columns a person fills in on the form. */
export type AutomationFields = {
  name: string;
  trigger_type: AutomationTrigger;
  trigger_stage_id: string | null;
  trigger_form_id: string | null;
  trigger_any_form: boolean;
  action_type: AutomationAction;
  action_title: string | null;
  action_due_days: number | null;
  action_tag: string | null;
  action_status: AutomationStatus | null;
  enabled: boolean;
};

/** One thing an automation did. */
export type AutomationRun = {
  id: string;
  automationId: string;
  automationName: string;
  /** The contact it acted on; null when the contact has since been deleted. */
  contactName: string | null;
  status: RunStatus;
  detail: string | null;
  /** ISO timestamp. */
  at: string;
};

export type AutomationStats = {
  total: number;
  active: number;
  /** Runs since the first of this month, in Malaysia. */
  runsThisMonth: number;
  /** Runs this month that did not fail, 0 to 100; null with no runs. */
  successRate: number | null;
  /** Runs per week, oldest first. `label` is the week's first day, '6 Oct'. */
  trend: { week: string; label: string; runs: number; failed: number }[];
};

/** A stage or lead form an automation can name, as its picker lists it. */
export type AutomationChoice = { id: string; label: string };

type AutomationRow = {
  id: string;
  name: string;
  trigger_type: string;
  trigger_stage_id: string | null;
  trigger_form_id: string | null;
  trigger_any_form: boolean | null;
  action_type: string;
  action_title: string | null;
  action_due_days: number | null;
  action_tag: string | null;
  action_status: string | null;
  enabled: boolean | null;
  paused_reason: string | null;
  runs_count: number | null;
  last_run_at: string | null;
};

const AUTOMATION_COLUMNS =
  'id,name,trigger_type,trigger_stage_id,trigger_form_id,trigger_any_form,action_type,action_title,action_due_days,action_tag,action_status,enabled,paused_reason,runs_count,last_run_at';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Row-level security refused the write: the stage or form is not this workspace's. */
const PG_FORBIDDEN = '42501';
const FOREIGN_KEY_VIOLATION = '23503';
/** The database's limit on automations switched on. */
const CHECK_VIOLATION = '23514';
const DAY_MS = 24 * 60 * 60 * 1000;

function read(formData: FormData, key: string) {
  return String(formData.get(key) ?? '').trim();
}

function oneLine(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

const isTrigger = (value: string): value is AutomationTrigger =>
  (AUTOMATION_TRIGGERS as readonly string[]).includes(value);
const isAction = (value: string): value is AutomationAction =>
  (AUTOMATION_ACTIONS as readonly string[]).includes(value);
const isStatus = (value: string): value is AutomationStatus =>
  (AUTOMATION_STATUSES as readonly string[]).includes(value);

/** The form's "Any lead form" choice. */
export const ANY_FORM = 'any';

/**
 * Validates the add and edit form. Only what the chosen trigger and action
 * use is kept: switching an automation from "add a tag" to "add a follow-up"
 * leaves no stray tag behind.
 */
export function parseAutomationForm(formData: FormData): AutomationFields {
  const name = oneLine(read(formData, 'name'));
  const trigger = read(formData, 'trigger');
  const action = read(formData, 'action');

  if (!name) throw new CrmContactFormError(M.name);
  if (name.length > AUTOMATION_NAME_MAX) throw new CrmContactFormError(M.nameTooLong);
  if (!isTrigger(trigger)) throw new CrmContactFormError(M.trigger);

  let stageId: string | null = null;
  let formId: string | null = null;
  let anyForm = false;
  if (trigger === 'deal_stage') {
    stageId = read(formData, 'stageId');
    if (!UUID.test(stageId)) throw new CrmContactFormError(M.stage);
  }
  if (trigger === 'form_submitted') {
    const chosen = read(formData, 'formId');
    if (chosen === ANY_FORM) anyForm = true;
    else if (UUID.test(chosen)) formId = chosen;
    else throw new CrmContactFormError(M.form);
  }

  if (!isAction(action)) throw new CrmContactFormError(M.action);
  let title: string | null = null;
  let dueDays: number | null = null;
  let tag: string | null = null;
  let status: AutomationStatus | null = null;
  if (action === 'add_follow_up') {
    title = oneLine(read(formData, 'title'));
    if (!title) throw new CrmContactFormError(M.title);
    if (title.length > AUTOMATION_TITLE_MAX) throw new CrmContactFormError(M.titleTooLong);
    const days = read(formData, 'dueDays');
    if (days) {
      dueDays = Number(days);
      if (!/^\d{1,3}$/.test(days) || dueDays > AUTOMATION_DUE_DAYS_MAX) throw new CrmContactFormError(M.dueDays);
    }
  }
  if (action === 'add_tag') {
    tag = oneLine(read(formData, 'tag'));
    if (!tag) throw new CrmContactFormError(M.tag);
    if (tag.includes(',')) throw new CrmContactFormError(M.tagComma);
    if (tag.length > MAX_TAG_LENGTH) throw new CrmContactFormError(M.tagTooLong);
  }
  if (action === 'set_status') {
    const chosen = read(formData, 'status');
    if (!isStatus(chosen)) throw new CrmContactFormError(M.status);
    status = chosen;
  }

  return {
    name,
    trigger_type: trigger,
    trigger_stage_id: stageId,
    trigger_form_id: formId,
    trigger_any_form: anyForm,
    action_type: action,
    action_title: title,
    action_due_days: dueDays,
    action_tag: tag,
    action_status: status,
    // A new automation starts on; the edit form says which way it is.
    enabled: !formData.has('enabledField') || formData.get('enabled') === 'on',
  };
}

/** The id of the automation an edit, switch or delete form is about. */
export function readAutomationId(formData: FormData): string {
  const id = read(formData, 'automationId');
  if (!UUID.test(id)) throw new CrmContactFormError(M.gone);
  return id;
}

export function mapAutomation(row: AutomationRow): Automation {
  return {
    id: row.id,
    name: row.name,
    trigger: isTrigger(row.trigger_type) ? row.trigger_type : 'contact_created',
    stageId: row.trigger_stage_id,
    formId: row.trigger_form_id,
    anyForm: row.trigger_any_form === true,
    action: isAction(row.action_type) ? row.action_type : 'add_follow_up',
    title: row.action_title ?? '',
    dueDays: row.action_due_days,
    tag: row.action_tag ?? '',
    status: row.action_status && isStatus(row.action_status) ? row.action_status : null,
    enabled: row.enabled === true,
    pausedReason: row.paused_reason,
    runs: row.runs_count ?? 0,
    lastRunDay: row.last_run_at ? klDay(new Date(row.last_run_at)) : null,
  };
}

/**
 * What sets an automation off, in words: 'A deal arrives in Proposal'. Says
 * so when the stage or form it named has been deleted, since it then never runs.
 */
export function describeTrigger(
  automation: Pick<Automation, 'trigger' | 'stageId' | 'formId' | 'anyForm'>,
  stages: AutomationChoice[],
  forms: AutomationChoice[],
): { text: string; broken: boolean } {
  if (automation.trigger === 'deal_stage') {
    const stage = stages.find((choice) => choice.id === automation.stageId);
    return stage
      ? { text: `A deal arrives in ${stage.label}`, broken: false }
      : { text: 'A deal arrives in a stage that was deleted', broken: true };
  }
  if (automation.trigger === 'form_submitted') {
    if (automation.anyForm) return { text: 'Any lead form is submitted', broken: false };
    const form = forms.find((choice) => choice.id === automation.formId);
    return form
      ? { text: `“${form.label}” is submitted`, broken: false }
      : { text: 'A lead form that was deleted is submitted', broken: true };
  }
  return { text: TRIGGER_LABELS[automation.trigger], broken: false };
}

/** What an automation does, in words: 'Add follow-up “Chase the quote”, due in 2 days'. */
export function describeAction(automation: Pick<Automation, 'action' | 'title' | 'dueDays' | 'tag' | 'status'>): string {
  if (automation.action === 'add_follow_up') {
    const due =
      automation.dueDays === null
        ? 'no due date'
        : automation.dueDays === 0
          ? 'due the same day'
          : `due in ${automation.dueDays} ${automation.dueDays === 1 ? 'day' : 'days'}`;
    return `Add follow-up “${automation.title}”, ${due}`;
  }
  if (automation.action === 'add_tag') return `Add the tag “${automation.tag}”`;
  return `Set status to ${automation.status ? STATUS_LABELS[automation.status] : 'a status'}`;
}

/** The Monday a day's week starts on, `YYYY-MM-DD`. */
function weekStart(day: string): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  const sinceMonday = (date.getUTCDay() + 6) % 7;
  return new Date(date.getTime() - sinceMonday * DAY_MS).toISOString().slice(0, 10);
}

/** The figures above the table, from the automations and their runs. */
export function automationStats(
  automations: Pick<Automation, 'enabled'>[],
  runs: { status: RunStatus; at: string }[],
  now: Date,
): AutomationStats {
  const today = klDay(now);
  const month = today.slice(0, 7);
  const thisWeek = weekStart(today);
  const weeks = Array.from({ length: RUN_TREND_WEEKS }, (_, index) =>
    new Date(Date.parse(`${thisWeek}T00:00:00.000Z`) - (RUN_TREND_WEEKS - 1 - index) * 7 * DAY_MS)
      .toISOString()
      .slice(0, 10),
  );
  const byWeek = new Map<string, { runs: number; failed: number }>(
    weeks.map((week) => [week, { runs: 0, failed: 0 }]),
  );
  let inMonth = 0;
  let failedInMonth = 0;
  for (const run of runs) {
    const day = klDay(new Date(run.at));
    if (day.slice(0, 7) === month) {
      inMonth += 1;
      if (run.status === 'failed') failedInMonth += 1;
    }
    const bucket = byWeek.get(weekStart(day));
    if (bucket) {
      bucket.runs += 1;
      if (run.status === 'failed') bucket.failed += 1;
    }
  }
  return {
    total: automations.length,
    active: automations.filter((automation) => automation.enabled).length,
    runsThisMonth: inMonth,
    successRate: inMonth > 0 ? Math.round(((inMonth - failedInMonth) / inMonth) * 100) : null,
    trend: weeks.map((week) => ({
      week,
      label: new Intl.DateTimeFormat('en-US', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(
        new Date(`${week}T00:00:00.000Z`),
      ),
      ...(byWeek.get(week) ?? { runs: 0, failed: 0 }),
    })),
  };
}

/** The first moment of the chart's first week, for reading runs since then. */
export function runsSince(now: Date): string {
  const first = Date.parse(`${weekStart(klDay(now))}T00:00:00.000Z`) - (RUN_TREND_WEEKS - 1) * 7 * DAY_MS;
  // Midnight in Malaysia is 16:00 UTC the day before.
  return new Date(first - 8 * 60 * 60 * 1000).toISOString();
}

/**
 * The workspace's automations, newest first, each with how often it has run
 * and when it last did (counted from its runs by the `crm_automation_totals` view).
 */
export async function listAutomations(client: SupabaseClient, orgId: string): Promise<Automation[]> {
  const { data, error } = await client
    .from('crm_automation_totals')
    .select(AUTOMATION_COLUMNS)
    .eq('org_id', orgId)
    .order('created_at', { ascending: false })
    .limit(AUTOMATIONS_LOADED);
  if (error) throw error;
  return ((data ?? []) as unknown as AutomationRow[]).map(mapAutomation);
}

/** Every run since `since`, oldest read last, a page at a time; `complete` is false past the read limit. */
export async function listRunsSince(
  client: SupabaseClient,
  orgId: string,
  since: string,
): Promise<{ runs: { status: RunStatus; at: string }[]; complete: boolean }> {
  const runs: { status: RunStatus; at: string }[] = [];
  for (let from = 0; from < RUNS_READ_MAX; from += RUN_PAGE_SIZE) {
    const { data, error } = await client
      .from('crm_automation_runs')
      .select('status,created_at')
      .eq('org_id', orgId)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .order('id', { ascending: true })
      .range(from, from + RUN_PAGE_SIZE - 1);
    if (error) throw error;
    const page = (data ?? []) as { status: RunStatus; created_at: string }[];
    runs.push(...page.map((row) => ({ status: row.status, at: row.created_at })));
    if (page.length < RUN_PAGE_SIZE) return { runs, complete: true };
  }
  return { runs, complete: false };
}

/** The latest runs, newest first, with the automation's and the contact's names. */
export async function listRecentRuns(
  client: SupabaseClient,
  orgId: string,
  automations: Pick<Automation, 'id' | 'name'>[],
): Promise<AutomationRun[]> {
  const { data, error } = await client
    .from('crm_automation_runs')
    .select('id,automation_id,contact_id,status,detail,created_at')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: true })
    .limit(RECENT_RUNS_LISTED);
  if (error) throw error;
  const rows = (data ?? []) as {
    id: string;
    automation_id: string;
    contact_id: string | null;
    status: RunStatus;
    detail: string | null;
    created_at: string;
  }[];

  const contactIds = [...new Set(rows.map((row) => row.contact_id).filter((id): id is string => Boolean(id)))];
  const contactNames = new Map<string, string>();
  if (contactIds.length > 0) {
    const contacts = await client
      .from('crm_contacts')
      .select('id,first_name,last_name')
      .eq('org_id', orgId)
      .in('id', contactIds);
    if (contacts.error) throw contacts.error;
    for (const contact of (contacts.data ?? []) as { id: string; first_name: string; last_name: string | null }[]) {
      contactNames.set(contact.id, [contact.first_name, contact.last_name].filter(Boolean).join(' '));
    }
  }
  const names = new Map(automations.map((automation) => [automation.id, automation.name] as const));

  return rows.map((row) => ({
    id: row.id,
    automationId: row.automation_id,
    automationName: names.get(row.automation_id) ?? 'An automation',
    contactName: row.contact_id ? (contactNames.get(row.contact_id) ?? null) : null,
    status: row.status,
    detail: row.detail,
    at: row.created_at,
  }));
}

/** A refusal the person can do something about is said beside the form. */
function throwWriteError(error: { code?: string }): never {
  // The stage or form chosen has gone, or is not this workspace's.
  if (error.code === PG_FORBIDDEN || error.code === FOREIGN_KEY_VIOLATION) {
    throw new CrmContactFormError(M.missing);
  }
  if (error.code === CHECK_VIOLATION) throw new CrmContactFormError(M.tooManyOn);
  throw error;
}

export async function createAutomation(
  client: SupabaseClient,
  orgId: string,
  fields: AutomationFields,
  userId?: string | null,
): Promise<void> {
  const { error } = await client
    .from('crm_automations')
    .insert({ org_id: orgId, ...fields, ...(userId ? { created_by: userId } : {}) });
  if (error) throwWriteError(error);
}

/** Nothing in the database maintains `updated_at`, so the write sets it. */
export async function updateAutomation(
  client: SupabaseClient,
  orgId: string,
  id: string,
  fields: AutomationFields,
): Promise<void> {
  const { data, error } = await client
    .from('crm_automations')
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('org_id', orgId)
    .select('id');
  if (error) throwWriteError(error);
  if (!data || data.length === 0) throw new CrmContactFormError(M.gone);
}

/** Switches an automation on or off. Switching it on clears the database's reason for switching it off. */
export async function setAutomationEnabled(
  client: SupabaseClient,
  orgId: string,
  id: string,
  enabled: boolean,
): Promise<void> {
  const { data, error } = await client
    .from('crm_automations')
    .update({ enabled, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('org_id', orgId)
    .select('id');
  if (error) throwWriteError(error);
  if (!data || data.length === 0) throw new CrmContactFormError(M.gone);
}

export async function deleteAutomation(client: SupabaseClient, orgId: string, id: string): Promise<void> {
  const { data, error } = await client
    .from('crm_automations')
    .delete()
    .eq('id', id)
    .eq('org_id', orgId)
    .select('id');
  if (error) throw error;
  if (!data || data.length === 0) throw new CrmContactFormError(M.gone);
}
