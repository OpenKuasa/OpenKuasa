import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { type AccountActions, AccountsView, filterAccounts } from '@/components/finance/accounts-view';
import { AccountFormCard } from '@/components/finance/account-form-card';
import type { LedgerAccount } from '@/lib/finance/ledger';
import { SAMPLE_LEDGER_ACCOUNTS } from '@/screens/finance/ledger-sample';
import { trialBalance } from '@/lib/finance/ledger-views';

/**
 * The Chart of Accounts screen, as the server sends it: rendered to a string and read as markup. There is no
 * DOM here (node, no jsdom), so nothing can be pressed or typed: what a press decides is in plain functions
 * (tests/finance-ledger-form.test.ts, tests/finance-ledger-views.test.ts). What still needs a browser is
 * checked by hand.
 */

// A closed menu draws nothing but its button. Here its items are drawn in place, so what the menu offers can be read.
vi.mock('@/components/ui/dropdown-menu', () => {
  const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
  const Item = ({ children }: { children?: ReactNode }) => <div role="menuitem">{children}</div>;
  return {
    DropdownMenu: Pass,
    DropdownMenuTrigger: Pass,
    DropdownMenuContent: Pass,
    DropdownMenuLabel: Pass,
    DropdownMenuSeparator: () => <hr />,
    DropdownMenuItem: Item,
  };
});

// A closed select draws no options. Here its options are drawn in place, and the chosen one is marked.
vi.mock('@/components/ui/select', () => {
  const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
  return {
    Select: ({ value, children }: { value?: string; children?: ReactNode }) => <div data-chosen={value}>{children}</div>,
    SelectTrigger: Pass,
    SelectValue: () => null,
    SelectContent: Pass,
    SelectItem: ({ value, children }: { value: string; children?: ReactNode }) => <span data-option={value}>{children}</span>,
  };
});

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const items = (html: string) =>
  [...html.matchAll(/<div role="menuitem">([\s\S]*?)<\/div>/g)].map(([, inner]) => text(inner));

const account = (over: Partial<LedgerAccount> = {}): LedgerAccount => ({
  id: 'acc-1',
  code: '1100',
  name: 'Main Bank',
  type: 'asset',
  active: true,
  stands_for: 'bank',
  system_key: null,
  bank_account_id: 'bank-1',
  category_id: null,
  default_for: null,
  debit_total: 1000,
  credit_total: 0,
  balance: 1000,
  ...over,
});

const done = <T,>(data: T) => vi.fn(async () => ({ ok: true as const, data }));
const actions: AccountActions = {
  create: done({ id: 'x' }),
  update: done({ id: 'x' }),
  setActive: done({ id: 'x' }),
  remove: done({ id: 'x' }),
};

const render = (accounts: LedgerAccount[], writer = true) =>
  renderToStaticMarkup(<AccountsView accounts={accounts} writer={writer ? { actions } : undefined} />);

describe('the chart of accounts', () => {
  const books = [
    account({ id: 'a1', code: '1100', name: 'Main Bank', debit_total: 5000, credit_total: 0, balance: 5000 }),
    account({ id: 'a2', code: '1200', name: 'Trade Receivables', stands_for: 'system', debit_total: 1000, credit_total: 0, balance: 1000 }),
    account({ id: 'l1', code: '2000', name: 'Trade Payables', type: 'liability', stands_for: 'system', debit_total: 0, credit_total: 2500, balance: 2500 }),
    account({ id: 'e1', code: '3000', name: 'Owner’s Capital', type: 'equity', stands_for: 'system', debit_total: 0, credit_total: 3500, balance: 3500 }),
  ];

  it('groups the accounts by kind with each group’s total, and the two headline totals', () => {
    const html = text(render(books));
    expect(html).toContain('Total assets RM 6,000.00');
    expect(html).toContain('Total liabilities RM 2,500.00');
    // Group headings carry the group total.
    expect(html).toContain('Asset RM 6,000.00');
    expect(html).toContain('Liability RM 2,500.00');
    expect(html).toContain('Equity RM 3,500.00');
    // Kinds with no accounts have no heading.
    expect(html).not.toContain('Income RM');
    expect(html.indexOf('Asset RM')).toBeLessThan(html.indexOf('Liability RM'));
  });

  it('shows each account’s code, name, what it stands for and balance, linked to its journal lines', () => {
    const html = render(books);
    expect(text(html)).toContain('1100 Main Bank Bank or cash account RM 5,000.00');
    expect(text(html)).toContain('System');
    expect(html).toContain('href="/finance/journals?account=a1"');
  });

  it('says the books balance when debits equal credits, with the two totals', () => {
    const html = text(render(books));
    expect(html).toContain('Books balance');
    expect(html).toContain('RM 6,000.00 debit and RM 6,000.00 credit');
    expect(html).not.toContain('Out of balance');
  });

  it('says how far out of balance the books are when they are not', () => {
    const html = text(render([...books, account({ id: 'x', code: '6100', name: 'Rent', type: 'expense', debit_total: 100, credit_total: 0, balance: 100 })]));
    expect(html).toContain('Out of balance by RM 100.00');
    expect(html).not.toContain('Books balance');
  });

  it('balances the sample books', () => {
    expect(trialBalance(SAMPLE_LEDGER_ACCOUNTS).balanced).toBe(true);
    expect(text(render(SAMPLE_LEDGER_ACCOUNTS, false))).toContain('Books balance');
  });

  it('hides archived accounts until Show archived is on, and dims them', () => {
    const withArchived = [...books, account({ id: 'old', code: '6900', name: 'Courier (old)', type: 'expense', stands_for: 'own', active: false, debit_total: 0, credit_total: 0, balance: 0 })];
    expect(render(withArchived)).not.toContain('Courier (old)');
    expect(text(render(withArchived))).toContain('Show archived');
    expect(filterAccounts(withArchived, '', false).map((a) => a.id)).toEqual(['a1', 'a2', 'l1', 'e1']);
    expect(filterAccounts(withArchived, '', true).map((a) => a.id)).toEqual(['a1', 'a2', 'l1', 'e1', 'old']);
  });

  it('totals each kind over all its accounts, so the headline and the heading agree with archived rows hidden', () => {
    const withArchived = [
      ...books,
      account({ id: 'old', code: '1900', name: 'Old Float', stands_for: 'own', active: false, debit_total: 400, credit_total: 0, balance: 400 }),
    ];
    const html = text(render(withArchived));
    expect(html).not.toContain('Old Float');
    expect(html).toContain('Total assets RM 6,400.00');
    expect(html).toContain('Asset RM 6,400.00');
  });

  it('searches by code or name', () => {
    expect(filterAccounts(books, '1200', false).map((a) => a.id)).toEqual(['a2']);
    expect(filterAccounts(books, 'payables', false).map((a) => a.id)).toEqual(['l1']);
    expect(filterAccounts(books, '  ', false)).toHaveLength(4);
  });

  it('says so when there are no accounts', () => {
    expect(text(render([], false))).toContain('No accounts yet.');
  });
});

describe('who may change accounts', () => {
  it('gives a sign-off viewer New account and a menu for each kind of account', () => {
    const html = render([
      account({ id: 'bank', code: '1100', name: 'Main Bank', stands_for: 'bank' }),
      account({ id: 'own', code: '1500', name: 'Accum Dep', stands_for: 'own' }),
    ]);
    expect(text(html)).toContain('New account');
    expect(items(html)).toEqual(['Edit', 'Archive', 'Edit', 'Archive', 'Delete']);
  });

  it('offers Unarchive on an archived account, once archived accounts are shown', () => {
    expect(items(renderToStaticMarkup(<AccountsView accounts={[account({ active: false, stands_for: 'category' })]} writer={{ actions }} initialShowArchived />))).toEqual([
      'Edit',
      'Unarchive',
    ]);
  });

  it('gives a member the accounts and Export, but no New account and no menu', () => {
    const html = render([account({ stands_for: 'own' })], false);
    expect(text(html)).not.toContain('New account');
    expect(items(html)).toEqual([]);
    expect(html).not.toContain('Actions for');
    expect(text(html)).toContain('Export');
    expect(text(html)).toContain('Main Bank');
  });
});

describe('the account form', () => {
  const card = (editing?: LedgerAccount) =>
    renderToStaticMarkup(<AccountFormCard editing={editing} actions={actions} onClose={() => {}} />);

  it('asks a new account for code, name and type', () => {
    const html = card();
    expect(text(html)).toContain('New account');
    expect(html).toContain('>Code<');
    expect(html).toContain('>Name<');
    expect(html).toContain('>Type<');
    for (const type of ['asset', 'liability', 'equity', 'income', 'expense']) expect(html).toContain(`data-option="${type}"`);
    expect(html).toContain('data-finance-focus');
  });

  it('edits only code and name of a saved account, and shows its type', () => {
    const html = card(account({ id: 'a1', code: '1100', name: 'Main Bank' }));
    expect(text(html)).toContain('Edit account');
    expect(html).toContain('value="1100"');
    expect(html).toContain('value="Main Bank"');
    expect(html).not.toMatch(/<label[^>]*>Type</);
    expect(text(html)).toContain('Asset');
    expect(html).not.toContain('data-option=');
  });
});
