import { postFxRevaluationAction, previewFxRevaluationAction } from '@/app/(app)/finance/actions';
import { type FxRevaluationActions, FxRevaluationView } from '@/components/finance/fx-revaluation-view';
import { can } from '@/lib/auth/permissions';
import { getViewer, hasSupabaseEnv } from '@/lib/auth/viewer';
import { malaysiaClock } from '@/lib/finance/fx-dates';
import {
  type RevaluationItem,
  type RevaluationRun,
  fxRevaluationRefusal,
  listFxRevaluations,
  previewFxRevaluation,
} from '@/lib/finance/fx-revaluation';
import { defaultMonthEnd, monthEndsBetween } from '@/lib/finance/fx-revaluation-views';
import { type FxBooks, readFxBooks } from '@/lib/finance/reports-data';
import { type FinanceWriteContext, READ_FAILED } from '@/lib/finance/result';
import { createClient } from '@/lib/supabase/server';
import { SAMPLE_FX_ITEMS, SAMPLE_FX_MONTH_END, SAMPLE_FX_RUNS } from './fx-revaluation-sample';

/** A read the page can show without: logged, and null in its place. */
async function readOrNull<T>(what: string, read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    console.error(`[finance] FxRevaluationScreen: ${what} could not be read:`, error);
    return null;
  }
}

/** The preview of the month end shown first, or the sentence for why it could not be worked out. */
async function firstPreview(ctx: FinanceWriteContext, periodEnd: string): Promise<{ items: RevaluationItem[] | null; error: string | null }> {
  try {
    return { items: await previewFxRevaluation(ctx, { period_end: periodEnd, rates: {} }), error: null };
  } catch (error) {
    const refusal = fxRevaluationRefusal(error);
    if (!refusal) console.error('[finance] FxRevaluationScreen: the preview could not be read:', error);
    return { items: null, error: refusal ?? READ_FAILED };
  }
}

/**
 * Who posted each run, by name (or email), as far as the workspace's profiles say. A person who has left the
 * workspace cannot be read (profiles are shared only within a workspace), and is shown as a dash.
 */
async function postedByNames(ctx: FinanceWriteContext, runs: RevaluationRun[] | null): Promise<Record<string, string>> {
  const ids = [...new Set((runs ?? []).map((r) => r.posted_by).filter((id): id is string => !!id))];
  if (ids.length === 0) return {};
  const { data, error } = await ctx.client.from('profiles').select('user_id,full_name,email').in('user_id', ids);
  if (error) {
    console.error('[finance] FxRevaluationScreen: who posted could not be read:', error);
    return {};
  }
  const names: Record<string, string> = {};
  for (const p of (data ?? []) as { user_id: string; full_name: string | null; email: string | null }[]) {
    const name = p.full_name?.trim() || p.email?.trim();
    if (name) names[p.user_id] = name;
  }
  return names;
}

/** The earliest date the month-end picker needs to reach: the first foreign item, or the oldest run. */
function firstDate(books: FxBooks | null, runs: RevaluationRun[] | null): string | null {
  const dates = [books?.firstForeignDate ?? null, ...(runs ?? []).map((r) => r.period_end)].filter((d): d is string => d !== null).sort();
  return dates[0] ?? null;
}

/**
 * FX Revaluation: every member reads the posted runs and previews a month end (read only; the database asks
 * `is_org_member`). Typing closing rates and posting is an owner's or admin's (`sign-off-finance`), as the
 * database enforces (FIN14); a member is told who posts, and a viewer and the demo workspace only read. Month ends
 * are Malaysia's: the newest offered is the last on or before today there.
 */
export default async function FxRevaluationScreen() {
  if (!hasSupabaseEnv()) {
    return <FxRevaluationView monthEnds={[SAMPLE_FX_MONTH_END]} periodEnd={SAMPLE_FX_MONTH_END} items={SAMPLE_FX_ITEMS} runs={SAMPLE_FX_RUNS} />;
  }
  const viewer = await getViewer();
  const ctx = { client: await createClient(), orgId: viewer.orgId };
  const canSignOff = !viewer.isDemo && can(viewer.role, 'sign-off-finance');
  const today = malaysiaClock(new Date()).date;
  const periodEnd = defaultMonthEnd(today);
  const [preview, runs, books] = await Promise.all([
    firstPreview(ctx, periodEnd),
    readOrNull('the posted revaluations', () => listFxRevaluations(ctx)),
    readOrNull('what the books hold in foreign currency', () => readFxBooks(ctx)),
  ]);
  const postedBy = await postedByNames(ctx, runs);
  const first = firstDate(books, runs);
  // Nothing foreign has ever been in the books: no figure and no field, only the sentence (plan decision 14).
  const ringgitOnly = books !== null && first === null && preview.items !== null && preview.items.length === 0;
  const actions: FxRevaluationActions = canSignOff
    ? { preview: previewFxRevaluationAction, post: postFxRevaluationAction }
    : { preview: previewFxRevaluationAction };
  return (
    <FxRevaluationView
      monthEnds={monthEndsBetween(first ?? periodEnd, today)}
      periodEnd={periodEnd}
      items={preview.items}
      itemsError={preview.error}
      runs={runs}
      postedBy={postedBy}
      actions={actions}
      memberNote={!viewer.isDemo && !canSignOff && can(viewer.role, 'edit-data')}
      ringgitOnly={ringgitOnly}
    />
  );
}
