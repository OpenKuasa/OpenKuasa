import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { type CategoryActions, CategoriesCard } from '@/components/finance/categories-card';
import { ExpensesView, type ExpensesWriter } from '@/components/finance/expenses-view';
import type { CategoryRow } from '@/lib/finance/categories';
import { SAMPLE_EXPENSES } from '@/screens/finance/cash-book-sample';
import { SAMPLE_TODAY } from '@/screens/finance/sales-sample';

/**
 * The Categories card as the server sends it: rendered to a string and read as markup (no DOM here), and the
 * Expenses header that opens it. What a click does is the pure rules' to decide (finance-category-form.test.ts).
 */

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));

const never = async () => ({ ok: false as const, error: 'no' });
const actions: CategoryActions = { create: never, rename: never, setActive: never };

const LONG = 'Penyelenggaraan'.repeat(5);
const ROWS: CategoryRow[] = [
  { id: 'e1', name: 'Rent', kind: 'expense', active: true, default_for: null },
  { id: 'e2', name: 'Purchases', kind: 'expense', active: true, default_for: 'purchases' },
  { id: 'e3', name: 'Entertainment', kind: 'expense', active: false, default_for: null },
  { id: 'e4', name: LONG, kind: 'expense', active: true, default_for: null },
  { id: 'e5', name: '<b>Bold</b>', kind: 'expense', active: true, default_for: null },
  { id: 'i1', name: 'Jualan', kind: 'income', active: true, default_for: 'sales' },
  { id: 'i2', name: 'Other income', kind: 'income', active: true, default_for: null },
];

const card = (rows: CategoryRow[] = ROWS) => renderToStaticMarkup(<CategoriesCard rows={rows} actions={actions} onClose={() => {}} />);

describe('the Categories card', () => {
  it('lists both kinds under their own headings, archived ones included, with a menu on every row', () => {
    const html = card();
    expect(html).toContain('Expense categories');
    expect(html).toContain('Income categories');
    for (const row of ROWS.filter((r) => !r.name.includes('<'))) expect(html).toContain(row.name);
    expect(html.match(/aria-label="Actions for /g)).toHaveLength(ROWS.length);
    expect(html.match(/>Archived</g)).toHaveLength(1);
    expect(html.match(/>Active</g)).toHaveLength(ROWS.length - 1);
    // Expense categories come before income categories.
    expect(html.indexOf('Expense categories')).toBeLessThan(html.indexOf('Income categories'));
    expect(html.indexOf('Rent')).toBeLessThan(html.indexOf('Jualan'));
  });

  it('says what the books lean on the two marked categories for, whatever they are called', () => {
    const html = card();
    expect(html.match(/Invoices post here/g)).toHaveLength(1);
    expect(html.match(/Bills default here/g)).toHaveLength(1);
  });

  it('has the add form, with a name box, and a way out; nothing is asked until a menu is used', () => {
    const html = card();
    expect(html).toContain('New category');
    // No maxLength: it counts UTF-16 units and the table counts characters, so 80 emoji would be stopped at 40.
    expect(html).not.toContain('maxLength');
    expect(html).toContain('Add category');
    expect(html).toContain('>Done<');
    expect(html).not.toContain('role="group"');
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain('role="status"');
    expect(html).not.toContain(' inert');
  });

  it('draws a name as text, lets a long one wrap, and hides none behind a tooltip', () => {
    const html = card();
    expect(html).toContain('&lt;b&gt;Bold&lt;/b&gt;');
    expect(html).not.toContain('<b>Bold</b>');
    // The cell that holds the name is the one that wraps (the card's own title is the only thing that truncates).
    expect(html).toMatch(new RegExp(`<td[^>]*whitespace-normal[^>]*\\[overflow-wrap:anywhere\\][^>]*>${LONG}`));
    expect(html).not.toContain(' title=');
  });

  it('says so when a kind has no category', () => {
    const html = card(ROWS.filter((r) => r.kind === 'expense'));
    expect(html).toContain('No income categories yet.');
    expect(html).not.toContain('No expense categories yet.');
  });

  it('offers no delete anywhere, and uses no purple', () => {
    const source = readFileSync('src/components/finance/categories-card.tsx', 'utf8');
    // Its comments say that nothing is deleted; no control does.
    expect(source).not.toMatch(/Trash|['"`>]Delete|remove\b/);
    expect(source).not.toMatch(/purple|violet|indigo|fuchsia/i);
    expect(card()).not.toMatch(/delete/i);
  });
});

/**
 * The loader is an async server component with no unit of its own, so its wiring is read from its text, as the
 * other screens' source checks are: every category is read, and handed over, only for someone who manages them.
 */
describe('the Expenses loader', () => {
  const source = readFileSync('src/screens/finance/expenses.tsx', 'utf8');

  it('reads every category only for someone who manages them, and reads it once', () => {
    expect(source).toContain('plan.managesCategories ? listCategories(ctx) : []');
    expect(source.match(/listCategories\(/g)).toHaveLength(1);
  });

  it('hands the list and the three actions to nobody else', () => {
    expect(source).toContain('categoryAdmin: plan.managesCategories ? { rows: allCategories, actions: CATEGORY_ACTIONS } : undefined');
    expect(source.match(/categoryAdmin/g)).toHaveLength(1);
    expect(source.match(/CATEGORY_ACTIONS/g)).toHaveLength(2);
    expect(source).toContain('const plan = expensesScreenPlan(viewer.role, viewer.isDemo);');
  });
});

/**
 * What a press does is in the card's handlers, and the suite has no DOM, so the wiring that matters is read from
 * the source, as the loader's is: what Archive and Restore send, the checks before a write, and what waits.
 */
describe('the card’s wiring', () => {
  const source = readFileSync('src/components/finance/categories-card.tsx', 'utf8');

  it('Restore sends the restore payload and Archive the archive payload', () => {
    expect(source).toContain('actions.setActive(categoryRestorePayload(row))');
    expect(source).toContain('actions.setActive(categoryArchivePayload(row))');
    expect(source).not.toMatch(/active: (true|false)/);
  });

  it('checks the name against the list before it sends an add or a rename', () => {
    expect(source.indexOf('categoryAddError(form, rows)')).toBeGreaterThan(-1);
    expect(source.indexOf('categoryAddError(form, rows)')).toBeLessThan(source.indexOf('actions.create('));
    expect(source.indexOf('categoryRenameError(row, typed, rows)')).toBeGreaterThan(-1);
    expect(source.indexOf('categoryRenameError(row, typed, rows)')).toBeLessThan(source.indexOf('actions.rename('));
    expect(source.indexOf('renameChangesNothing(row, typed)')).toBeLessThan(source.indexOf('categoryRenameError(row, typed, rows)'));
  });

  it('says what happened under the add form, in view, and not at the foot under both lists', () => {
    const jsx = source.slice(source.indexOf('  return (\n    <BentoCard'));
    const form = jsx.indexOf('</form>');
    expect(form).toBeGreaterThan(-1);
    for (const shown of ['role="status"', '{restore.error}', '{note}']) {
      expect(jsx.indexOf(shown)).toBeGreaterThan(form);
      expect(jsx.indexOf(shown)).toBeLessThan(jsx.indexOf("{list('expense')}"));
    }
    expect(jsx).toContain('role="alert"');
  });

  it('lets the subtitle wrap at a narrow width instead of cutting it', () => {
    expect(source).toMatch(/subtitle=\{<span className="block whitespace-normal">/);
  });

  it('keeps one thing open at a time: the add form waits for a question, and nothing is sent twice or mid-write', () => {
    expect(source).toContain('inert={asked !== null}');
    expect(source).toContain('if (busy || asked) return;');
    expect(source).toContain('if (write.pending) return;');
    expect(source).toContain('onClick={onClose} disabled={busy}');
    expect(source).toContain('{busy ? null : <RowMenu');
    expect(source).toContain('setForm(newCategoryForm(saved.kind))');
    expect(source).toContain('data-finance-focus');
  });
});

describe('the Expenses page while the card is open', () => {
  const source = readFileSync('src/components/finance/expenses-view.tsx', 'utf8');

  it('locks the rest of the page, as an open form does, and does not count the card as a row question', () => {
    expect(source).toMatch(/const locked = [^;]*open\?\.kind === 'categories'/);
    expect(source).toMatch(/const asking = open && [^;]*open\.kind !== 'categories'/);
    expect(source).toContain('aria-expanded={open?.kind === \'categories\'}');
    expect(source.match(/disabled=\{locked\}/g)?.length).toBeGreaterThanOrEqual(2);
    expect(source).toContain('<span inert={locked}');
  });
});

describe('the Categories button on Expenses', () => {
  const expenseActions = { save: never, approve: never, reject: never, remove: never, pay: never };
  const member: ExpensesWriter = { actions: expenseActions, canDecide: false, contacts: [], categories: [], accounts: [] };
  const owner: ExpensesWriter = { ...member, canDecide: true, categoryAdmin: { rows: ROWS, actions } };
  const render = (writer?: ExpensesWriter) =>
    renderToStaticMarkup(<ExpensesView rows={SAMPLE_EXPENSES} today={SAMPLE_TODAY} followClock={false} writer={writer} />);

  it('is not there for a viewer, the demo workspace or the sample (no writer)', () => {
    expect(render()).not.toContain('>Categories<');
  });

  it('is not there for a member, who is handed no categories to manage and still gets New expense', () => {
    const html = render(member);
    expect(html).toContain('New expense');
    expect(html).not.toContain('Categories</button>');
  });

  it('is there for an owner or admin, beside New expense, and the card stays closed until it is pressed', () => {
    const html = render(owner);
    expect(html).toContain('Categories</button>');
    expect(html).toContain('New expense');
    expect(html.indexOf('Categories</button>')).toBeLessThan(html.indexOf('New expense'));
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('Expense categories');
    expect(html).not.toContain('Add category');
  });
});
