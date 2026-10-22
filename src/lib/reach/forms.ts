/**
 * Pure helpers for lead forms: the link (slug) rules, the list filters and the
 * KPI maths. No I/O, so the capability layer, the screen and the tests all
 * share one definition of each rule.
 */
import type { Form, FormStatus } from './types';

/** The columns of `public.forms`, mapping 1:1 onto {@link Form}. */
export const FORM_COLUMNS =
  'id,name,category,slug,channel,status,consent_text,views_count,submissions_count,created_at,updated_at';

export const FORM_STATUSES: readonly FormStatus[] = ['draft', 'active', 'paused'];

export const FORM_STATUS_LABEL: Record<FormStatus, string> = {
  draft: 'Draft',
  active: 'Active',
  paused: 'Paused',
};

/** Offered in the category field before a workspace has any of its own. */
export const DEFAULT_FORM_CATEGORIES: readonly string[] = [
  'Promotions',
  'Sales',
  'Marketing',
  'Support',
  'Events',
];

export const FORM_NAME_MAX = 120;
export const FORM_CATEGORY_MAX = 60;
export const FORM_SLUG_MIN = 2;
export const FORM_SLUG_MAX = 60;
export const FORM_CONSENT_MAX = 300;

/** The text in a consent sentence that becomes the workspace's name. */
export const FORM_CONSENT_PLACEHOLDER = '{workspace}';

/**
 * The consent sentence every form starts with. The same text is the column's
 * default in the database (20261124130000_kasturi_form_consent.sql).
 */
export const DEFAULT_FORM_CONSENT =
  'I agree that {workspace} may keep these details and contact me about my enquiry.';

/** A stored slug. The same rule is the check constraint on `forms.slug`. */
export const FORM_SLUG_PATTERN = /^[a-z0-9-]{2,60}$/;
/**
 * What a person or the assistant may send: empty (derive it from the name), or
 * a slug with one optional leading "/".
 */
export const FORM_SLUG_INPUT_PATTERN = /^(\/?[a-z0-9-]{2,60})?$/;

export const FORM_MESSAGES = {
  name: 'Enter a name for the form.',
  nameTooLong: `Keep the name to ${FORM_NAME_MAX} characters or fewer.`,
  categoryTooLong: `Keep the category to ${FORM_CATEGORY_MAX} characters or fewer.`,
  slug: 'Use only lower-case letters, numbers and hyphens in the short name, such as raya-promo.',
  slugTaken: 'Another form already uses that short name.',
  status: 'Choose a status: draft, active or paused.',
  channel: 'Choose a channel: WhatsApp, Facebook, Instagram or TikTok.',
  gone: 'That form no longer exists.',
  consent: 'Enter the sentence visitors tick to agree.',
  consentTooLong: `Keep the consent sentence to ${FORM_CONSENT_MAX} characters or fewer.`,
} as const;

/**
 * Turns a form name into a link: "Raya Promo 2026!" becomes "raya-promo-2026".
 * May return fewer than two characters (or none) when the name has nothing
 * usable in it; {@link resolveFormSlug} reports that.
 */
export function slugifyFormName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, FORM_SLUG_MAX)
    .replace(/-+$/g, '');
}

/** Trims a typed link and drops one leading "/". Nothing else is changed. */
export function normalizeFormSlug(raw: string | null | undefined): string {
  const trimmed = (raw ?? '').trim();
  return trimmed.startsWith('/') ? trimmed.slice(1) : trimmed;
}

export function isValidFormSlug(slug: string): boolean {
  return FORM_SLUG_PATTERN.test(slug);
}

export type SlugResult = { ok: true; slug: string } | { ok: false; error: string };

/**
 * The link to store: what was typed (without its leading "/"), or one derived
 * from the name when the link was left empty.
 */
export function resolveFormSlug(
  rawSlug: string | null | undefined,
  name: string | null | undefined,
): SlugResult {
  const typed = normalizeFormSlug(rawSlug);
  const slug = typed || slugifyFormName(name ?? '');
  return isValidFormSlug(slug) ? { ok: true, slug } : { ok: false, error: FORM_MESSAGES.slug };
}

/** What the form card holds, as typed. */
export type FormFieldValues = {
  name: string;
  category: string;
  slug: string;
  status: string;
  consent_text: string;
};

export type FormFieldInput = {
  name: string;
  category: string | null;
  slug: string;
  status: FormStatus;
  consent_text: string;
};

export type ParsedFormFields =
  | { ok: true; input: FormFieldInput }
  | { ok: false; error: string };

/**
 * Checks what was typed into the form card and shapes it for the create and
 * update actions. The server runs the same rules again; this only saves a
 * round trip and gives the same message either way.
 */
export function parseFormFields(values: FormFieldValues): ParsedFormFields {
  const name = values.name.trim();
  if (!name) return { ok: false, error: FORM_MESSAGES.name };
  if (name.length > FORM_NAME_MAX) return { ok: false, error: FORM_MESSAGES.nameTooLong };
  const category = values.category.trim();
  if (category.length > FORM_CATEGORY_MAX) {
    return { ok: false, error: FORM_MESSAGES.categoryTooLong };
  }
  const slug = resolveFormSlug(values.slug, name);
  if (!slug.ok) return slug;
  if (!(FORM_STATUSES as readonly string[]).includes(values.status)) {
    return { ok: false, error: FORM_MESSAGES.status };
  }
  const consent = values.consent_text.trim();
  if (!consent) return { ok: false, error: FORM_MESSAGES.consent };
  if ([...consent].length > FORM_CONSENT_MAX) return { ok: false, error: FORM_MESSAGES.consentTooLong };
  return {
    ok: true,
    input: {
      name,
      category: category || null,
      slug: slug.slug,
      status: values.status as FormStatus,
      consent_text: consent,
    },
  };
}

/** The categories in use, A to Z, ignoring case when spotting duplicates. */
export function formCategoriesInUse(forms: Pick<Form, 'category'>[]): string[] {
  const seen = new Map<string, string>();
  for (const f of forms) {
    const c = f.category?.trim();
    if (c && !seen.has(c.toLowerCase())) seen.set(c.toLowerCase(), c);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

/** Suggestions for the category field: the ones in use, then the defaults. */
export function formCategorySuggestions(forms: Pick<Form, 'category'>[]): string[] {
  const inUse = formCategoriesInUse(forms);
  const known = new Set(inUse.map((c) => c.toLowerCase()));
  return [...inUse, ...DEFAULT_FORM_CATEGORIES.filter((c) => !known.has(c.toLowerCase()))];
}

export type FormFilters = {
  /** Matched against the name and the link, ignoring case. */
  query: string;
  /** A category, or '' for all. */
  category: string;
  status: FormStatus | '';
};

export const NO_FORM_FILTERS: FormFilters = { query: '', category: '', status: '' };

export function hasFormFilters(filters: FormFilters): boolean {
  return Boolean(filters.query.trim() || filters.category || filters.status);
}

/** Narrows the loaded forms. Runs in the browser; keeps the given order. */
export function filterForms<T extends Pick<Form, 'name' | 'slug' | 'category' | 'status'>>(
  forms: T[],
  filters: FormFilters,
): T[] {
  // A search typed as "/raya-promo" should still find the link.
  const query = normalizeFormSlug(filters.query).toLowerCase();
  const category = filters.category.trim().toLowerCase();
  return forms.filter((f) => {
    if (filters.status && f.status !== filters.status) return false;
    if (category && (f.category ?? '').trim().toLowerCase() !== category) return false;
    if (!query) return true;
    return f.name.toLowerCase().includes(query) || f.slug.toLowerCase().includes(query);
  });
}

export type FormKpis = {
  total_forms: number;
  total_views: number;
  /** Sum of submissions across every form. */
  total_leads: number;
  /** Submissions ÷ views as a percentage; null when nothing has been viewed. */
  conversion_pct: number | null;
  /** Ready to show: "18%", "4.5%" or "—". */
  conversion: string;
};

export function formKpis(
  forms: Pick<Form, 'views_count' | 'submissions_count'>[],
): FormKpis {
  const total_views = forms.reduce((a, f) => a + f.views_count, 0);
  const total_leads = forms.reduce((a, f) => a + f.submissions_count, 0);
  const conversion_pct =
    total_views > 0 ? Math.round((total_leads / total_views) * 1000) / 10 : null;
  return {
    total_forms: forms.length,
    total_views,
    total_leads,
    conversion_pct,
    conversion: conversion_pct == null ? '—' : `${conversion_pct}%`,
  };
}

/** "12 Mar 2026", in Malaysian time so the server and the browser agree. */
export function formatFormDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Kuala_Lumpur',
  }).format(date);
}
