import type { SupabaseClient } from '@supabase/supabase-js';
import { addDays, todayInMalaysia } from '@/lib/people/dates';
import { readWaitingCounts, waitingTotal } from '@/lib/people/waiting-counts';
import type { NudgeCounts, ProductKey } from './types';

/** The client comes in from the caller (RLS-scoped session); this module never creates one. */
export type CountsCtx = { client: SupabaseClient; orgId: string; userId: string; now: Date };

const PRODUCT_TIMEOUT_MS = 800;
const PRODUCTS: ProductKey[] = ['people', 'finance', 'hire', 'crm', 'reach'];

/** Resolves to `fallback` if `p` has not settled within `ms`, or rejects. Never throws. */
export async function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } catch {
    return fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type Day = { start: string; end: string; weekAgo: string };

// Kuala Lumpur day bounds, computed once per call. The overdue views filter on the database's UTC current_date,
// so they can differ from KL "today" by up to a day; acceptable for a nudge.
function dayBounds(now: Date): Day {
  const today = todayInMalaysia(now);
  return {
    start: `${today}T00:00:00+08:00`,
    end: `${addDays(today, 1)}T00:00:00+08:00`,
    weekAgo: `${addDays(today, -7)}T00:00:00+08:00`,
  };
}

type Query = PromiseLike<{ count: number | null; error: unknown }>;

/** One head-only count; a failure (error or throw) is undefined, so the field is omitted. */
async function head(build: () => Query): Promise<number | undefined> {
  try {
    const { count, error } = await build();
    if (error || typeof count !== 'number' || !Number.isFinite(count)) return undefined;
    return count;
  } catch {
    return undefined;
  }
}

function sum(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined || b === undefined ? undefined : a + b;
}

function compact(counts: NudgeCounts): NudgeCounts {
  return Object.fromEntries(Object.entries(counts).filter(([, v]) => v !== undefined)) as NudgeCounts;
}

const count = (ctx: CountsCtx, table: string) =>
  ctx.client.from(table).select('id', { count: 'exact', head: true }).eq('org_id', ctx.orgId);

async function readPeople(ctx: CountsCtx): Promise<NudgeCounts> {
  try {
    const counts = await readWaitingCounts({ client: ctx.client, orgId: ctx.orgId });
    return { hrApprovals: waitingTotal(counts), swapReplies: counts.swap_replies };
  } catch {
    return {};
  }
}

async function readFinance(ctx: CountsCtx): Promise<NudgeCounts> {
  const [tx, po, invoices, bills] = await Promise.all([
    head(() => count(ctx, 'finance_transactions').eq('status', 'pending_approval')),
    head(() => count(ctx, 'finance_purchase_orders').eq('status', 'pending_approval')),
    head(() => count(ctx, 'finance_invoice_totals').eq('display_status', 'overdue')),
    head(() => count(ctx, 'supplier_bill_totals').eq('display_status', 'overdue')),
  ]);
  return compact({ financeApprovals: sum(tx, po), overdueInvoices: invoices, overdueBills: bills });
}

async function readHire(ctx: CountsCtx, day: Day): Promise<NudgeCounts> {
  const [interviews, waiting] = await Promise.all([
    head(() =>
      count(ctx, 'hire_interviews').eq('status', 'scheduled').gte('scheduled_at', day.start).lt('scheduled_at', day.end),
    ),
    // "Active" as the hire overview defines it: outcome active and not yet hired.
    head(() => count(ctx, 'hire_applications').eq('outcome', 'active').neq('stage', 'hired')),
  ]);
  return compact({ interviewsToday: interviews, applicationsWaiting: waiting });
}

async function readCrm(ctx: CountsCtx, day: Day): Promise<NudgeCounts> {
  const [followUps, appointments] = await Promise.all([
    head(() =>
      count(ctx, 'crm_activities')
        .eq('type', 'task')
        .is('completed_at', null)
        .eq('owner_user_id', ctx.userId)
        .lt('due_at', day.end),
    ),
    head(() =>
      count(ctx, 'appointments').neq('status', 'cancelled').gte('scheduled_at', day.start).lt('scheduled_at', day.end),
    ),
  ]);
  return compact({ followUpsDue: followUps, appointmentsToday: appointments });
}

async function readReach(ctx: CountsCtx, day: Day): Promise<NudgeCounts> {
  const newLeads = await head(() => count(ctx, 'leads').eq('stage', 'lead').gte('created_at', day.weekAgo));
  return compact({ newLeads });
}

/** One product's nudge counts. Never throws; a failed signal is simply absent. */
export async function readProductCounts(ctx: CountsCtx, product: ProductKey): Promise<NudgeCounts> {
  try {
    const day = dayBounds(ctx.now);
    switch (product) {
      case 'people':
        return await readPeople(ctx);
      case 'finance':
        return await readFinance(ctx);
      case 'hire':
        return await readHire(ctx, day);
      case 'crm':
        return await readCrm(ctx, day);
      case 'reach':
        return await readReach(ctx, day);
    }
  } catch {
    return {};
  }
}

/** Every product in parallel, each bounded so a slow one is skipped rather than awaited. */
export async function readAllCounts(ctx: CountsCtx): Promise<NudgeCounts> {
  const parts = await Promise.all(
    PRODUCTS.map((p) => withTimeout<NudgeCounts>(readProductCounts(ctx, p), PRODUCT_TIMEOUT_MS, {})),
  );
  return Object.assign({}, ...parts) as NudgeCounts;
}
