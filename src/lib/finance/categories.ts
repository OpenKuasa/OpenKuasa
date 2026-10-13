/**
 * Expense and income categories: the reads and writes of the Categories card
 * on Expenses. A category is one finance_categories row, written directly
 * under row-level security. One Zod schema and one function per write;
 * org_id comes from the context.
 *
 * What the database holds everyone to (20261116120000 and the ledger's
 * triggers, 20261108090000): adding and changing a category is an owner's or
 * admin's (42501 on an insert; an update by anyone else touches no row and
 * raises nothing); a name is 1 to 80 characters with no space at either end
 * and is unique within its kind, capitals aside, archived categories
 * included; a category's kind never changes. Each category has an account in
 * the Chart of Accounts, which the database makes, renames (until someone
 * renames that account by hand) and archives with it.
 *
 * Nothing here deletes: a category is archived, and restored.
 */
import { z } from 'zod';
import { type FinResult, type FinanceWriteContext, PG_CHECK, PG_FORBIDDEN, PG_UNIQUE, pgCode, writeFailed } from './result';

export type CategoryKind = 'expense' | 'income';
/** The job the books lean on a category for: every invoice credits 'sales'; a bill with no category gets 'purchases'. */
export type CategoryMark = 'sales' | 'purchases';

export const CATEGORY_NAME_MAX = 80;

export type CategoryRow = {
  id: string;
  name: string;
  kind: CategoryKind;
  active: boolean;
  /** Set on the two categories the books lean on, whatever they are called now; null on every other. */
  default_for: CategoryMark | null;
};

export const CATEGORY_MESSAGES = {
  name: 'Enter a name for the category.',
  nameTooLong: `Keep the name to ${CATEGORY_NAME_MAX} characters or fewer.`,
  kind: 'Choose Expense or Income.',
  active: 'Choose whether to archive or restore the category.',
  gone: 'That category no longer exists.',
  // 23505. The card refuses a name it can see is taken, in fuller words, before anything is sent; this is the race.
  nameTaken: 'Another category of the same kind already has that name. Archived categories keep their names.',
  // 42501, an update that touched no row of a category that is still there, and what the server action says first.
  needsSignOff: 'Only an owner or admin can add or change categories. Ask one of them to do this.',
  // 23514. The schema refuses everything that could meet the name rule, so only a direct call does.
  invalid: `A category’s name is 1 to ${CATEGORY_NAME_MAX} characters, with no space before or after it.`,
  // Refused here, before the write: the database itself would take it.
  salesKept: 'Invoices post to this category, so it is not archived. It can be renamed.',
  purchasesKept: 'A bill with no category goes to this one, so it is not archived. It can be renamed.',
} as const;

const M = CATEGORY_MESSAGES;

const id = z.string({ error: M.gone }).uuid(M.gone);
/** What the table trims: spaces only (`btrim`), not tabs or newlines. */
export const trimSpaces = (s: string) => s.replace(/^ +| +$/g, '');
/** The table's own rule (`finance_categories_name_check`): 1 to 80 characters, counted as `char_length` does, by code point. */
const name = z
  .string({ error: M.name })
  .transform(trimSpaces)
  .pipe(z.string().min(1, M.name).max(CATEGORY_NAME_MAX, M.nameTooLong));
const kind = z.enum(['expense', 'income'], { error: M.kind });

/** A new category. Its kind is chosen here and never changes. */
export const createCategoryInput = z.object({ name, kind });
/** A new name for a category, and nothing else: whether it is archived is not this write's to say. */
export const renameCategoryInput = z.object({ id, name });
/** Archiving (`active: false`) or restoring a category, and nothing else: its name is not this write's to say. */
export const setCategoryActiveInput = z.object({ id, active: z.boolean({ error: M.active }) }, { error: M.gone });

const REFUSALS: Record<string, string> = {
  [PG_UNIQUE]: M.nameTaken,
  [PG_CHECK]: M.invalid,
  [PG_FORBIDDEN]: M.needsSignOff,
};

function categoryWriteFailed(fnName: string, error: unknown): { ok: false; error: string } {
  const refusal = REFUSALS[pgCode(error) ?? ''];
  return refusal ? { ok: false, error: refusal } : writeFailed(fnName, error);
}

const SAVED_COLUMNS = 'id,name,kind,active';
export type SavedCategory = { id: string; name: string; kind: CategoryKind; active: boolean };

/* ---- reads ------------------------------------------------------------ */

/**
 * Every category of the workspace, both kinds, archived ones included, by
 * name, each with its mark when the books lean on it. The marks are on the
 * categories' accounts in the Chart of Accounts, which every member reads.
 */
export async function listCategories(ctx: FinanceWriteContext): Promise<CategoryRow[]> {
  const [categories, marked] = await Promise.all([
    ctx.client
      .from('finance_categories')
      .select(SAVED_COLUMNS)
      .eq('org_id', ctx.orgId)
      .order('name', { ascending: true })
      .order('id', { ascending: true }),
    ctx.client.from('finance_ledger_accounts').select('category_id,default_for').eq('org_id', ctx.orgId).in('default_for', ['sales', 'purchases']),
  ]);
  if (categories.error) throw categories.error;
  if (marked.error) throw marked.error;
  const marks = new Map<string, CategoryMark>();
  for (const row of (marked.data ?? []) as unknown as { category_id: string | null; default_for: CategoryMark }[]) {
    if (row.category_id) marks.set(row.category_id, row.default_for);
  }
  return ((categories.data ?? []) as unknown as SavedCategory[]).map((c) => ({ ...c, default_for: marks.get(c.id) ?? null }));
}

/* ---- writes ----------------------------------------------------------- */

/**
 * What an update that touched no row means. The database does not refuse a
 * change by someone who may not make it: it finds them no row. So the
 * category is read: there still, it was not theirs to change; not there, it
 * is gone.
 */
async function untouched(ctx: FinanceWriteContext, fnName: string, categoryId: string): Promise<{ ok: false; error: string }> {
  const { data, error } = await ctx.client
    .from('finance_categories')
    .select('id')
    .eq('org_id', ctx.orgId)
    .eq('id', categoryId)
    .maybeSingle();
  if (error) return writeFailed(fnName, error);
  return { ok: false, error: data ? M.needsSignOff : M.gone };
}

/** Adds a category. The database makes its account in the Chart of Accounts in the same write. */
export async function createCategory(
  ctx: FinanceWriteContext,
  input: z.input<typeof createCategoryInput>,
): Promise<FinResult<SavedCategory>> {
  const parsed = createCategoryInput.parse(input);
  const { data, error } = await ctx.client
    .from('finance_categories')
    .insert({ org_id: ctx.orgId, name: parsed.name, kind: parsed.kind })
    .select(SAVED_COLUMNS)
    .maybeSingle();
  if (error || !data) return categoryWriteFailed('createCategory', error);
  return { ok: true, data: data as unknown as SavedCategory };
}

/** Renames a category. Everything filed under it shows the new name, since each names it by id. */
export async function renameCategory(
  ctx: FinanceWriteContext,
  input: z.input<typeof renameCategoryInput>,
): Promise<FinResult<SavedCategory>> {
  const parsed = renameCategoryInput.parse(input);
  const { data, error } = await ctx.client
    .from('finance_categories')
    .update({ name: parsed.name, updated_at: new Date().toISOString() })
    .eq('id', parsed.id)
    .eq('org_id', ctx.orgId)
    .select(SAVED_COLUMNS)
    .maybeSingle();
  if (error) return categoryWriteFailed('renameCategory', error);
  if (!data) return untouched(ctx, 'renameCategory', parsed.id);
  return { ok: true, data: data as unknown as SavedCategory };
}

/**
 * Archives a category, or restores it. An archived category keeps everything
 * filed under it and its name. The two the books lean on are not archived:
 * the database would take it, so the mark is read first and the write is not
 * made. Restoring asks nothing.
 */
export async function setCategoryActive(
  ctx: FinanceWriteContext,
  input: z.input<typeof setCategoryActiveInput>,
): Promise<FinResult<SavedCategory>> {
  const parsed = setCategoryActiveInput.parse(input);
  if (!parsed.active) {
    const { data: account, error: readError } = await ctx.client
      .from('finance_ledger_accounts')
      .select('default_for')
      .eq('org_id', ctx.orgId)
      .eq('category_id', parsed.id)
      .maybeSingle();
    if (readError) return writeFailed('setCategoryActive', readError);
    const mark = (account as { default_for: CategoryMark | null } | null)?.default_for;
    if (mark === 'sales') return { ok: false, error: M.salesKept };
    if (mark === 'purchases') return { ok: false, error: M.purchasesKept };
  }
  const { data, error } = await ctx.client
    .from('finance_categories')
    .update({ active: parsed.active, updated_at: new Date().toISOString() })
    .eq('id', parsed.id)
    .eq('org_id', ctx.orgId)
    .select(SAVED_COLUMNS)
    .maybeSingle();
  if (error) return categoryWriteFailed('setCategoryActive', error);
  if (!data) return untouched(ctx, 'setCategoryActive', parsed.id);
  return { ok: true, data: data as unknown as SavedCategory };
}
