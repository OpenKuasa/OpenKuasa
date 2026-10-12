import type { SupabaseClient } from '@supabase/supabase-js';
import { CrmContactFormError } from '@/lib/crm/contacts';

/**
 * Kasturi's landing pages: a public page at `/p/<page id>` with a headline,
 * some text and one of the workspace's lead forms under it. This file is what
 * the signed-in screen uses; what a visitor's request does is in
 * `./public-landing-pages`.
 */

export type LandingPageStatus = 'draft' | 'published';

export const LANDING_PAGE_STATUS_LABELS: Record<LandingPageStatus, string> = {
  draft: 'Draft',
  published: 'Published',
};

/** The same limits as the table's check constraints. */
export const PAGE_NAME_MAX = 120;
export const PAGE_HEADLINE_MAX = 160;
export const PAGE_SUBHEADLINE_MAX = 300;
export const PAGE_BODY_MAX = 4000;
export const PAGE_BUTTON_MAX = 40;
/** How many pages the screen loads. */
export const LANDING_PAGES_LOADED = 500;
/** What the form's button says when the page gives no label of its own. */
export const DEFAULT_BUTTON_LABEL = 'Send';

export const LANDING_PAGE_MESSAGES = {
  name: 'Enter a name for the page.',
  nameTooLong: `Keep the name to ${PAGE_NAME_MAX} characters or fewer.`,
  headline: 'Enter a headline.',
  headlineTooLong: `Keep the headline to ${PAGE_HEADLINE_MAX} characters or fewer.`,
  subheadlineTooLong: `Keep the subheading to ${PAGE_SUBHEADLINE_MAX} characters or fewer.`,
  bodyTooLong: `Keep the text to ${PAGE_BODY_MAX} characters or fewer.`,
  buttonTooLong: `Keep the button label to ${PAGE_BUTTON_MAX} characters or fewer.`,
  form: 'That lead form could not be found. Choose another.',
  formNeeded: 'Choose a lead form before publishing: a published page needs one to show.',
  gone: 'That page no longer exists.',
} as const;

const M = LANDING_PAGE_MESSAGES;

/** A lead form the page can show, as the picker lists it. */
export type LandingPageFormChoice = { id: string; name: string; status: string };

/** A landing page as the screen lists it. */
export type LandingPage = {
  id: string;
  name: string;
  headline: string;
  subheadline: string;
  body: string;
  /** Empty when the page uses the default label. */
  buttonLabel: string;
  formId: string | null;
  /** The chosen form's name; null when none is chosen or it was deleted. */
  formName: string | null;
  status: LandingPageStatus;
  /**
   * Whether a visitor can open it now: it is published and its form is active.
   * (The shared demo workspace's pages are never live; the database decides that.)
   */
  live: boolean;
  views: number;
  leads: number;
  /** `/p/<id>`. */
  path: string;
};

/** The columns a person fills in on the form. */
export type LandingPageFields = {
  name: string;
  headline: string;
  subheadline: string | null;
  body: string | null;
  button_label: string | null;
  form_id: string | null;
  status: LandingPageStatus;
};

export type LandingPageStats = {
  pages: number;
  published: number;
  views: number;
  leads: number;
  /** Leads as a share of views, 0 to 100 with one decimal; null with no views. */
  conversion: number | null;
};

type LandingPageRow = {
  id: string;
  name: string;
  headline: string;
  subheadline: string | null;
  body: string | null;
  button_label: string | null;
  form_id: string | null;
  status: string;
  views_count: number | null;
  leads_count: number | null;
};

const PAGE_COLUMNS = 'id,name,headline,subheadline,body,button_label,form_id,status,views_count,leads_count';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Row-level security refused the write: the chosen form is not this workspace's. */
const PG_FORBIDDEN = '42501';
const FOREIGN_KEY_VIOLATION = '23503';

/** Where a visitor opens the page. */
export function landingPagePath(id: string): string {
  return `/p/${id}`;
}

function read(formData: FormData, key: string) {
  return String(formData.get(key) ?? '').trim();
}

/** One line of text: runs of spaces and line breaks become one space. */
function oneLine(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

/** Validates the add and edit form. */
export function parseLandingPageForm(formData: FormData): LandingPageFields {
  const name = oneLine(read(formData, 'name'));
  const headline = oneLine(read(formData, 'headline'));
  const subheadline = oneLine(read(formData, 'subheadline'));
  // The text keeps its line breaks; the page shows them as paragraphs.
  const body = read(formData, 'body').replace(/\r\n/g, '\n');
  const buttonLabel = oneLine(read(formData, 'buttonLabel'));
  const formId = read(formData, 'formId');
  const status: LandingPageStatus = read(formData, 'status') === 'published' ? 'published' : 'draft';

  if (!name) throw new CrmContactFormError(M.name);
  if (name.length > PAGE_NAME_MAX) throw new CrmContactFormError(M.nameTooLong);
  if (!headline) throw new CrmContactFormError(M.headline);
  if (headline.length > PAGE_HEADLINE_MAX) throw new CrmContactFormError(M.headlineTooLong);
  if (subheadline.length > PAGE_SUBHEADLINE_MAX) throw new CrmContactFormError(M.subheadlineTooLong);
  if (body.length > PAGE_BODY_MAX) throw new CrmContactFormError(M.bodyTooLong);
  if (buttonLabel.length > PAGE_BUTTON_MAX) throw new CrmContactFormError(M.buttonTooLong);
  if (formId && !UUID.test(formId)) throw new CrmContactFormError(M.form);
  if (status === 'published' && !formId) throw new CrmContactFormError(M.formNeeded);

  return {
    name,
    headline,
    subheadline: subheadline || null,
    body: body || null,
    button_label: buttonLabel || null,
    form_id: formId || null,
    status,
  };
}

/** The id of the page an edit or delete form is about. */
export function readLandingPageId(formData: FormData): string {
  const id = read(formData, 'pageId');
  if (!UUID.test(id)) throw new CrmContactFormError(M.gone);
  return id;
}

export function mapLandingPage(row: LandingPageRow, forms: ReadonlyMap<string, LandingPageFormChoice>): LandingPage {
  const form = row.form_id ? forms.get(row.form_id) : undefined;
  const status: LandingPageStatus = row.status === 'published' ? 'published' : 'draft';
  return {
    id: row.id,
    name: row.name,
    headline: row.headline,
    subheadline: row.subheadline ?? '',
    body: row.body ?? '',
    buttonLabel: row.button_label ?? '',
    formId: row.form_id,
    formName: form?.name ?? null,
    status,
    live: status === 'published' && form?.status === 'active',
    views: row.views_count ?? 0,
    leads: row.leads_count ?? 0,
    path: landingPagePath(row.id),
  };
}

/** The figures above the table. */
export function landingPageStats(pages: Pick<LandingPage, 'status' | 'views' | 'leads'>[]): LandingPageStats {
  const views = pages.reduce((total, page) => total + page.views, 0);
  const leads = pages.reduce((total, page) => total + page.leads, 0);
  return {
    pages: pages.length,
    published: pages.filter((page) => page.status === 'published').length,
    views,
    leads,
    conversion: views > 0 ? Math.round((leads / views) * 1000) / 10 : null,
  };
}

/** The workspace's lead forms, by name, for the page form's picker. */
export async function listLandingPageForms(client: SupabaseClient, orgId: string): Promise<LandingPageFormChoice[]> {
  const { data, error } = await client
    .from('forms')
    .select('id,name,status')
    .eq('org_id', orgId)
    .order('name', { ascending: true })
    .limit(1000);
  if (error) throw error;
  return (data ?? []) as LandingPageFormChoice[];
}

/** The workspace's landing pages, newest first. */
export async function listLandingPages(
  client: SupabaseClient,
  orgId: string,
  forms: LandingPageFormChoice[],
): Promise<LandingPage[]> {
  const { data, error } = await client
    .from('crm_landing_pages')
    .select(PAGE_COLUMNS)
    .eq('org_id', orgId)
    .order('created_at', { ascending: false })
    .limit(LANDING_PAGES_LOADED);
  if (error) throw error;
  const byId = new Map(forms.map((form) => [form.id, form] as const));
  return ((data ?? []) as unknown as LandingPageRow[]).map((row) => mapLandingPage(row, byId));
}

/** The chosen form has gone, or is not this workspace's: say so beside the form. */
function throwWriteError(error: { code?: string }): never {
  if (error.code === PG_FORBIDDEN || error.code === FOREIGN_KEY_VIOLATION) {
    throw new CrmContactFormError(M.form);
  }
  throw error;
}

export async function createLandingPage(
  client: SupabaseClient,
  orgId: string,
  fields: LandingPageFields,
  userId?: string | null,
): Promise<void> {
  const { error } = await client
    .from('crm_landing_pages')
    .insert({ org_id: orgId, ...fields, ...(userId ? { created_by: userId } : {}) });
  if (error) throwWriteError(error);
}

/** Nothing in the database maintains `updated_at`, so the write sets it. */
export async function updateLandingPage(
  client: SupabaseClient,
  orgId: string,
  id: string,
  fields: LandingPageFields,
): Promise<void> {
  const { data, error } = await client
    .from('crm_landing_pages')
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('org_id', orgId)
    .select('id');
  if (error) throwWriteError(error);
  if (!data || data.length === 0) throw new CrmContactFormError(M.gone);
}

export async function deleteLandingPage(client: SupabaseClient, orgId: string, id: string): Promise<void> {
  const { data, error } = await client
    .from('crm_landing_pages')
    .delete()
    .eq('id', id)
    .eq('org_id', orgId)
    .select('id');
  if (error) throw error;
  if (!data || data.length === 0) throw new CrmContactFormError(M.gone);
}
