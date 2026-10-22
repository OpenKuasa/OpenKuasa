import { z } from 'zod';
import { addDays, formatDay, malaysiaDate } from '@/lib/people/dates';
import type { FinanceWriteContext } from './result';

/** What a finance row in the audit trail is about: the `entity_type` the database writes on `activity_log`. */
export type AuditEntityType =
  | 'finance_invoice'
  | 'finance_quotation'
  | 'finance_credit_note'
  | 'finance_supplier_bill'
  | 'finance_supplier_credit_note'
  | 'finance_payment'
  | 'finance_transfer'
  | 'finance_expense'
  | 'finance_contra'
  | 'finance_journal'
  | 'finance_purchase_order'
  | 'finance_fx_revaluation'
  | 'finance_sst_return'
  | 'finance_settings';

/** Each kind of document, its name, and the screen it lives on (null when it has none). */
export const AUDIT_ENTITY_TYPES: { value: AuditEntityType; label: string; path: string | null }[] = [
  { value: 'finance_invoice', label: 'Invoice', path: '/finance/invoices' },
  { value: 'finance_quotation', label: 'Quotation', path: '/finance/quotations' },
  { value: 'finance_credit_note', label: 'Credit note', path: '/finance/credit-notes' },
  { value: 'finance_supplier_bill', label: 'Supplier bill', path: '/finance/supplier-bills' },
  { value: 'finance_supplier_credit_note', label: 'Supplier credit note', path: '/finance/supplier-bills' },
  { value: 'finance_payment', label: 'Payment', path: '/finance/banking' },
  { value: 'finance_transfer', label: 'Transfer', path: '/finance/banking' },
  { value: 'finance_expense', label: 'Expense', path: '/finance/expenses' },
  { value: 'finance_contra', label: 'Contra entry', path: '/finance/contra-entries' },
  { value: 'finance_journal', label: 'Journal', path: '/finance/journals' },
  { value: 'finance_purchase_order', label: 'Purchase order', path: '/finance/purchase-orders' },
  { value: 'finance_fx_revaluation', label: 'FX revaluation', path: '/finance/fx-revaluation' },
  { value: 'finance_sst_return', label: 'SST return', path: '/finance/sst-report' },
  { value: 'finance_settings', label: 'Settings', path: '/finance/sst-report' },
];

export type AuditPeriod = '7d' | '30d' | '90d' | 'all';

export const AUDIT_PERIODS: { value: AuditPeriod; label: string; days: number | null }[] = [
  { value: '7d', label: 'Last 7 days', days: 7 },
  { value: '30d', label: 'Last 30 days', days: 30 },
  { value: '90d', label: 'Last 90 days', days: 90 },
  { value: 'all', label: 'All time', days: null },
];

/** What the database wrote about an event. `event` is always there; the rest depends on the document. */
export type AuditDetails = {
  event: string;
  number?: string;
  party?: string;
  date?: string;
  amount?: number;
  currency?: string;
  amount_myr?: number;
  [key: string]: unknown;
};

export type AuditEntry = {
  id: string;
  createdAt: string;
  actorName: string;
  action: string;
  target: string | null;
  entityType: AuditEntityType;
  entityId: string | null;
  details: AuditDetails;
};

export type AuditFilters = {
  type: AuditEntityType | null;
  actor: string | null;
  period: AuditPeriod;
  q: string;
  /** Cursor: only rows created before this timestamp. */
  before: string | null;
};

export const AUDIT_PAGE_SIZE = 50;

export type AuditSummary = {
  today: number;
  week: number;
  voidsThisMonth: number;
  deletionsThisMonth: number;
  daily: { date: string; label: string; count: number }[];
  byType: { type: AuditEntityType; label: string; count: number }[];
  actors: string[];
};

const DAY_MS = 86_400_000;
/** How many days the KPI strip and the charts cover, whatever the table's filters. */
export const AUDIT_SUMMARY_DAYS = 30;
const SUMMARY_DAYS = AUDIT_SUMMARY_DAYS;
const SUMMARY_ROW_CAP = 5000;
/** The most rows the hosted API returns in one response (PostgREST max-rows); the summary reads page by page. */
const SUMMARY_PAGE_SIZE = 1000;

const ENTITY_VALUES = AUDIT_ENTITY_TYPES.map((t) => t.value) as [AuditEntityType, ...AuditEntityType[]];
const PERIOD_VALUES = AUDIT_PERIODS.map((p) => p.value) as [AuditPeriod, ...AuditPeriod[]];

// Each field falls back on its own, so one bad value (or a repeated param,
// which arrives as an array) does not reset the others.
const filtersSchema = z.object({
  type: z.enum(ENTITY_VALUES).nullable().catch(null),
  actor: z.string().trim().min(1).max(200).nullable().catch(null),
  period: z.enum(PERIOD_VALUES).catch('30d'),
  q: z.string().trim().max(100).catch(''),
  before: z
    .string()
    .refine(isCursor)
    .nullable()
    .catch(null),
});

/** What an unnamed actor is called, on a row and in the actor filter. */
const SYSTEM_ACTOR = 'System';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Splits a page cursor, `<created_at>~<id>`, into its two halves; null when it is not in exactly that shape. */
function splitCursor(cursor: string): { createdAt: string; id: string } | null {
  const at = cursor.indexOf('~');
  if (at < 0) return null;
  const createdAt = cursor.slice(0, at);
  const id = cursor.slice(at + 1);
  if (!z.iso.datetime({ offset: true }).safeParse(createdAt).success || !UUID.test(id)) return null;
  return { createdAt, id };
}

function isCursor(value: string): boolean {
  return splitCursor(value) !== null;
}

/** Reads the audit screen's filters off the address; a bad value falls back on its own. */
export function parseAuditFilters(params: Record<string, string | string[] | undefined>): AuditFilters {
  // A search longer than 100 characters is cut, not thrown away.
  const q = typeof params.q === 'string' ? params.q.trim().slice(0, 100) : '';
  return filtersSchema.parse({
    type: params.type ?? null,
    actor: params.actor ?? null,
    period: params.period,
    q,
    before: params.before ?? null,
  });
}

/** Escapes `%`, `_` and `\` so a search is matched as typed, not as a pattern. */
function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

const typeLabels = new Map(AUDIT_ENTITY_TYPES.map((t) => [t.value as string, t.label]));

function isEntityType(value: unknown): value is AuditEntityType {
  return typeof value === 'string' && typeLabels.has(value);
}

type ActivityRow = {
  id: string;
  created_at: string;
  actor_name: string | null;
  action: string;
  target: string | null;
  entity_type: string | null;
  entity_id: string | null;
  details: AuditDetails | null;
};

/**
 * One page of the workspace's finance audit trail, newest first. Reads one row more than the page to know
 * whether an older page exists; a row whose type this code does not know is left out.
 */
export async function listFinanceAudit(
  ctx: FinanceWriteContext,
  filters: AuditFilters,
  pageSize: number = AUDIT_PAGE_SIZE,
): Promise<{ entries: AuditEntry[]; nextBefore: string | null }> {
  let query = ctx.client
    .from('activity_log')
    .select('id, created_at, actor_name, action, target, entity_type, entity_id, details')
    .eq('org_id', ctx.orgId);
  query = filters.type ? query.eq('entity_type', filters.type) : query.like('entity_type', 'finance\\_%');
  if (filters.actor === SYSTEM_ACTOR) query = query.or('actor_name.is.null,actor_name.eq.');
  else if (filters.actor) query = query.eq('actor_name', filters.actor);
  const days = AUDIT_PERIODS.find((p) => p.value === filters.period)?.days;
  if (days) query = query.gte('created_at', new Date(Date.now() - days * DAY_MS).toISOString());
  // Rows written together share a timestamp, so the cursor also carries the id to break the tie.
  const cursor = filters.before ? splitCursor(filters.before) : null;
  if (cursor) {
    const ts = `"${cursor.createdAt}"`;
    query = query.or(`created_at.lt.${ts},and(created_at.eq.${ts},id.lt.${cursor.id})`);
  }
  if (filters.q) query = query.ilike('target', `%${escapeLike(filters.q)}%`);

  const { data, error } = await query
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(pageSize + 1);
  if (error) throw error;

  const rows = (data ?? []) as ActivityRow[];
  const page = rows.slice(0, pageSize);
  const entries: AuditEntry[] = [];
  for (const r of page) {
    if (!isEntityType(r.entity_type)) continue;
    entries.push({
      id: r.id,
      createdAt: r.created_at,
      actorName: r.actor_name?.trim() || SYSTEM_ACTOR,
      action: r.action,
      target: r.target ?? null,
      entityType: r.entity_type,
      entityId: r.entity_id ?? null,
      details: r.details && typeof r.details.event === 'string' ? r.details : { ...(r.details ?? {}), event: '' },
    });
  }
  // The raw database timestamp keeps its microseconds, so the next page starts exactly after this row.
  const last = page[page.length - 1];
  const nextBefore = rows.length > pageSize && last ? `${last.created_at}~${last.id}` : null;
  return { entries, nextBefore };
}

type SummaryRow = { created_at: string; entity_type: string; actor_name: string; event: string };

/**
 * The last 31 days of finance rows (just what the summary counts), at most 5000. The hosted API answers at most 1000
 * rows a request, so they are read in pages of 1000 until a short page or the cap. The window's end is fixed when the
 * read starts, so a row logged meanwhile does not shift the later pages.
 */
export async function readAuditSummaryRows(ctx: FinanceWriteContext): Promise<SummaryRow[]> {
  const now = Date.now();
  const since = new Date(now - (SUMMARY_DAYS + 1) * DAY_MS).toISOString();
  const until = new Date(now).toISOString();
  const out: SummaryRow[] = [];
  while (out.length < SUMMARY_ROW_CAP) {
    const from = out.length;
    const to = Math.min(from + SUMMARY_PAGE_SIZE, SUMMARY_ROW_CAP) - 1;
    const { data, error } = await ctx.client
      .from('activity_log')
      .select('created_at, entity_type, actor_name, event:details->>event')
      .eq('org_id', ctx.orgId)
      .like('entity_type', 'finance\\_%')
      .gte('created_at', since)
      .lte('created_at', until)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(from, to);
    if (error) throw error;
    const page = (data ?? []) as Partial<SummaryRow>[];
    for (const r of page) {
      out.push({
        created_at: r.created_at ?? '',
        entity_type: r.entity_type ?? '',
        actor_name: r.actor_name ?? '',
        event: r.event ?? '',
      });
    }
    if (page.length < to - from + 1) break;
  }
  return out;
}

/** Counts for the strip above the trail. Days are Malaysia days, so a late-evening row lands on the right one. */
export function buildAuditSummary(rows: SummaryRow[], today: string): AuditSummary {
  const weekStart = addDays(today, -6);
  const month = today.slice(0, 7);
  const perDay = new Map<string, number>();
  const perType = new Map<AuditEntityType, number>();
  const actors = new Set<string>();
  let todayCount = 0;
  let week = 0;
  let voids = 0;
  let deletions = 0;

  for (const r of rows) {
    const day = malaysiaDate(r.created_at);
    if (!day) continue;
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
    if (day === today) todayCount += 1;
    if (day >= weekStart && day <= today) week += 1;
    if (day.slice(0, 7) === month && day <= today) {
      if (r.event === 'voided') voids += 1;
      if (r.event === 'deleted') deletions += 1;
    }
    if (isEntityType(r.entity_type)) perType.set(r.entity_type, (perType.get(r.entity_type) ?? 0) + 1);
    actors.add(r.actor_name?.trim() || SYSTEM_ACTOR);
  }

  const daily = Array.from({ length: SUMMARY_DAYS }, (_, i) => {
    const date = addDays(today, i - (SUMMARY_DAYS - 1));
    return { date, label: formatDay(date), count: perDay.get(date) ?? 0 };
  });
  const byType = [...perType.entries()]
    .map(([type, count]) => ({ type, label: typeLabels.get(type) ?? type, count }))
    .sort((a, b) => b.count - a.count);

  return {
    today: todayCount,
    week,
    voidsThisMonth: voids,
    deletionsThisMonth: deletions,
    daily,
    byType,
    actors: [...actors].sort((a, b) => a.localeCompare(b)),
  };
}
