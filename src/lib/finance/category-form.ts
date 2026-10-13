/**
 * The Categories card's rules and every sentence it says, as pure functions:
 * how the two lists are ordered, what a row offers, what is refused before
 * anything is sent, and what the card says afterwards. The card itself only
 * draws and calls.
 */
import {
  type CategoryKind,
  type CategoryRow,
  type SavedCategory,
  createCategoryInput,
  renameCategoryInput,
  trimSpaces,
} from './categories';

/** What the add form holds. */
export type CategoryForm = { name: string; kind: CategoryKind };

export function newCategoryForm(kind: CategoryKind = 'expense'): CategoryForm {
  return { name: '', kind };
}

export const CATEGORY_KIND_LABELS: Record<CategoryKind, string> = { expense: 'Expense', income: 'Income' };

/** "expense category" or "income category", for a sentence. */
function kindWords(kind: CategoryKind): string {
  return `${kind} category`;
}

/** The forms an active category is offered on, for a sentence. */
function offeredOn(kind: CategoryKind): string {
  return kind === 'expense' ? 'new expenses, supplier bills and payment vouchers' : 'new cash receipts';
}

const byName = (a: CategoryRow, b: CategoryRow) =>
  a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The two lists the card draws: each kind's active categories by name, then its archived ones by name. */
export function categoryLists(rows: CategoryRow[]): Record<CategoryKind, CategoryRow[]> {
  const list = (kind: CategoryKind) => {
    const mine = rows.filter((r) => r.kind === kind);
    return [...mine.filter((r) => r.active).sort(byName), ...mine.filter((r) => !r.active).sort(byName)];
  };
  return { expense: list('expense'), income: list('income') };
}

/** What the books lean on a category for, in the words its row shows; null for every other category. */
export function categoryMark(row: Pick<CategoryRow, 'default_for'>): string | null {
  if (row.default_for === 'sales') return 'Invoices post here';
  if (row.default_for === 'purchases') return 'Bills default here';
  return null;
}

export type CategoryAction = 'rename' | 'archive' | 'restore';

/**
 * What a category's row menu offers an owner or admin. A category is
 * archived, never deleted. The two the books lean on are renamed and not
 * archived; one that was archived all the same (by a direct call) is restored.
 */
export function categoryActions(row: Pick<CategoryRow, 'active' | 'default_for'>): CategoryAction[] {
  if (!row.active) return ['rename', 'restore'];
  return row.default_for ? ['rename'] : ['rename', 'archive'];
}

/**
 * The category of this kind that already has this name, capitals and outer
 * spaces aside, other than `exceptId`; null when the name is free. The
 * database has the last word (its own rule also counts archived ones); this
 * lets the card say which case it is without a second read.
 */
export function categoryNameClash(rows: CategoryRow[], kind: CategoryKind, name: string, exceptId?: string): CategoryRow | null {
  const wanted = trimSpaces(name).toLowerCase();
  return rows.find((r) => r.kind === kind && r.id !== exceptId && r.name.toLowerCase() === wanted) ?? null;
}

/** What is wrong with the add form, in the sentence to show, or null when it can be sent. */
export function categoryAddError(form: CategoryForm, rows: CategoryRow[]): string | null {
  const parsed = createCategoryInput.safeParse(form);
  if (!parsed.success) return parsed.error.issues[0].message;
  const clash = categoryNameClash(rows, parsed.data.kind, parsed.data.name);
  if (!clash) return null;
  return clash.active
    ? `There is already an ${kindWords(clash.kind)} called ${clash.name}.`
    : `An archived ${kindWords(clash.kind)} is already called ${clash.name}. Restore it from its row rather than adding it again.`;
}

/** What the add form sends. */
export function categoryPayload(form: CategoryForm): { name: string; kind: CategoryKind } {
  return { name: form.name, kind: form.kind };
}

/** True when the typed name is the name the category already has: nothing is sent, and the question closes. */
export function renameChangesNothing(row: Pick<CategoryRow, 'name'>, typed: string): boolean {
  return trimSpaces(typed) === row.name;
}

/** What is wrong with a new name for `row`, in the sentence to show, or null when it can be sent. */
export function categoryRenameError(row: CategoryRow, typed: string, rows: CategoryRow[]): string | null {
  // The name's own rule; the id is the row's and is not the person's to get wrong.
  const parsed = renameCategoryInput.shape.name.safeParse(typed);
  if (!parsed.success) return parsed.error.issues[0].message;
  const clash = categoryNameClash(rows, row.kind, parsed.data, row.id);
  if (!clash) return null;
  return clash.active
    ? `There is already an ${kindWords(clash.kind)} called ${clash.name}.`
    : `An archived ${kindWords(clash.kind)} is already called ${clash.name}. Choose another name.`;
}

/** What Archive sends. */
export function categoryArchivePayload(row: Pick<CategoryRow, 'id'>): { id: string; active: false } {
  return { id: row.id, active: false };
}

/** What Restore sends. */
export function categoryRestorePayload(row: Pick<CategoryRow, 'id'>): { id: string; active: true } {
  return { id: row.id, active: true };
}

/** Under the new-name box: what renaming reaches. */
export const CATEGORY_RENAME_HELP =
  'Everything filed under it shows the new name. Its account in the Chart of Accounts is renamed too, unless that one was renamed there.';

/** What archiving does, for the question in the row. */
export function categoryArchiveEffect(row: Pick<CategoryRow, 'kind'>): string {
  return `It will no longer be offered on ${offeredOn(row.kind)}, and its account in the Chart of Accounts is archived with it. What is already filed under it keeps it, and it can be restored.`;
}

/** What the card says once a category was added. */
export function categoryAddedNote(saved: Pick<SavedCategory, 'name' | 'kind'>): string {
  return `${saved.name} is added. It is offered on ${offeredOn(saved.kind)}.`;
}

/** What the card says once a category was renamed. */
export function categoryRenamedNote(before: string, saved: Pick<SavedCategory, 'name'>): string {
  return `${before} is now called ${saved.name}.`;
}

/** What the card says once a category was archived. */
export function categoryArchivedNote(saved: Pick<SavedCategory, 'name'>): string {
  return `${saved.name} is archived. It stays in this list, where it can be restored.`;
}

/** What the card says once a category was restored. */
export function categoryRestoredNote(saved: Pick<SavedCategory, 'name' | 'kind'>): string {
  return `${saved.name} is restored. It is offered on ${offeredOn(saved.kind)} again.`;
}
