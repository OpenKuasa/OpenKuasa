import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { BankingView, type BankingWriter } from '@/components/finance/banking-view';
import { TransferFormCard } from '@/components/finance/transfer-form-card';
import type { BankAccountRow, BankTransactionRow } from '@/lib/finance/banking';

/**
 * Banking, as the server sends it: rendered to a string and read as markup (node, no DOM). What a press decides
 * is in plain functions (tests/finance-banking-open.test.ts); what these pin is that the view uses them: who is
 * offered what, what waits while something is open, and what a void sends.
 */

const asked = vi.hoisted(() => ({ confirm: null as null | (() => void) }));

// A transition cannot be started while rendering to a string; here a run is just the call and what follows it.
vi.mock('@/components/finance/use-finance-action', () => ({
  useFinanceAction: () => ({
    pending: false,
    error: null,
    clear: () => {},
    fail: () => {},
    run: async (call: () => Promise<{ ok: boolean; data?: unknown }>, onDone?: (data: unknown) => void) => {
      const result = await call();
      if (result.ok) onDone?.(result.data);
    },
  }),
}));
vi.mock('@/components/charts', () => ({ AreaTrend: () => null, RadialGauge: () => null }));

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
vi.mock('@/components/ui/select', () => {
  const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
  return { Select: Pass, SelectTrigger: Pass, SelectValue: () => null, SelectContent: Pass, SelectItem: Pass };
});
// The question in a row, drawn as its words, with its confirm button kept so that a press can be made.
vi.mock('@/components/finance/confirm-row', () => ({
  ConfirmRow: ({ label, children, onConfirm }: { label: string; children?: ReactNode; onConfirm: () => void }) => {
    asked.confirm = onConfirm;
    return (
      <tr data-question={label}>
        <td>{children}</td>
      </tr>
    );
  },
}));

const TODAY = '2026-10-13';
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const items = (html: string) => [...html.matchAll(/<div role="menuitem">([\s\S]*?)<\/div>/g)].map(([, inner]) => text(inner));
const button = (html: string, label: string) =>
  [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].find(([, , inner]) => text(inner) === label);

/** Actions columns drawn: the Accounts table has one for a writer, the Transactions table one for someone who may transfer. */
const actionsColumns = (html: string) => html.split('<span class="sr-only">Actions</span>').length - 1;
/** The button's own attributes carry a bare `disabled` (its class list mentions `disabled:` styles either way). */
const disabled = (attrs: string) => /\sdisabled(=|\s|$)/.test(` ${attrs}`);

const account = (over: Partial<BankAccountRow> = {}): BankAccountRow => ({
  id: 'acc-main',
  name: 'Main Bank',
  kind: 'bank',
  bank_name: 'Maybank',
  opening_balance: 0,
  opening_date: '2026-01-01',
  active: true,
  balance: 300,
  to_be_paid: 0,
  last_import_at: null,
  unmatched_lines: 0,
  ...over,
});
const move = (over: Partial<BankTransactionRow> = {}): BankTransactionRow => ({
  transaction_id: 'tx-1',
  account_id: 'acc-main',
  account_name: 'Main Bank',
  account_kind: 'bank',
  direction: 'out',
  txn_date: '2026-10-05',
  amount: 500,
  status: 'posted',
  number: 'TR-0004',
  method: 'bank_transfer',
  reference: null,
  notes: null,
  party_name: null,
  kind: 'transfer',
  category_name: null,
  documents: null,
  transfer_id: 'transfer-1',
  other_account_name: 'Savings',
  reconciled: false,
  created_at: '2026-10-05T01:00:00Z',
  ...over,
});

const ACCOUNTS = [account(), account({ id: 'acc-save', name: 'Savings', balance: 900 })];
const ROWS = [
  move(),
  move({ transaction_id: 'tx-2', account_id: 'acc-save', account_name: 'Savings', direction: 'in', other_account_name: 'Main Bank' }),
  move({
    transaction_id: 'tx-3',
    kind: 'invoice',
    number: 'RC-0001',
    transfer_id: null,
    other_account_name: null,
    direction: 'in',
    amount: 80,
  }),
];

const voidCalls: unknown[] = [];
const writer = (over: Partial<BankingWriter> = {}): BankingWriter => ({
  actions: { create: vi.fn(), update: vi.fn(), setActive: vi.fn() } as unknown as BankingWriter['actions'],
  canSignOff: true,
  transfers: {
    record: vi.fn(),
    void: async (input: unknown) => {
      voidCalls.push(input);
      return { ok: true as const, data: { transfer_id: 'transfer-1' } };
    },
  },
  numbers: {},
  ...over,
});
const view = (props: Partial<Parameters<typeof BankingView>[0]> = {}) =>
  renderToStaticMarkup(<BankingView accounts={ACCOUNTS} rows={ROWS} today={TODAY} followClock={false} writer={writer()} {...props} />);

beforeEach(() => {
  voidCalls.length = 0;
  asked.confirm = null;
});

describe('Banking: what the header offers', () => {
  it('offers an owner or admin New receipt, Transfer and Add account', () => {
    const html = view();
    expect(text(html)).toContain('New receipt');
    expect(button(html, 'Transfer')).toBeTruthy();
    expect(button(html, 'Add account')).toBeTruthy();
  });

  it('offers a member no Transfer', () => {
    const html = view({ writer: writer({ canSignOff: false, transfers: undefined }) });
    expect(button(html, 'Transfer')).toBeUndefined();
    expect(button(html, 'Add account')).toBeTruthy();
  });

  it('offers Transfer only when two accounts are active', () => {
    expect(button(view({ accounts: [ACCOUNTS[0]] }), 'Transfer')).toBeUndefined();
    expect(button(view({ accounts: [ACCOUNTS[0], account({ id: 'acc-save', name: 'Savings', active: false })] }), 'Transfer')).toBeUndefined();
    expect(button(view({ accounts: ACCOUNTS }), 'Transfer')).toBeTruthy();
  });

  it('offers a viewer, and the sample, no buttons at all', () => {
    const html = view({ writer: undefined });
    expect(button(html, 'Transfer')).toBeUndefined();
    expect(button(html, 'Add account')).toBeUndefined();
    expect(text(html)).not.toContain('New receipt');
  });

  it('enables the buttons with nothing open', () => {
    const html = view();
    expect(button(html, 'Transfer')?.[1] ?? '').not.toSatisfy(disabled);
    expect(button(html, 'Add account')?.[1] ?? '').not.toSatisfy(disabled);
  });
});

describe('Banking: one thing open at a time', () => {
  it('disables both header buttons over the transfer form, and draws only that form', () => {
    const html = view({ initialOpen: { kind: 'transfer', today: TODAY } });
    expect(button(html, 'Transfer')?.[1] ?? '').toSatisfy(disabled);
    expect(button(html, 'Add account')?.[1] ?? '').toSatisfy(disabled);
    expect(text(html)).toContain('Record transfer');
    expect(text(html)).not.toContain('Save account');
  });

  it('disables both header buttons over an account form', () => {
    const html = view({ initialOpen: { kind: 'account', today: TODAY, editing: null } });
    expect(button(html, 'Transfer')?.[1] ?? '').toSatisfy(disabled);
    expect(button(html, 'Add account')?.[1] ?? '').toSatisfy(disabled);
    expect(text(html)).not.toContain('Record transfer');
  });

  it('disables both header buttons over an archive question, which the screen holds (the account card does not)', () => {
    const html = view({ initialOpen: { kind: 'archive', accountId: 'acc-main' } });
    expect(button(html, 'Add account')?.[1] ?? '').toSatisfy(disabled);
    expect(button(html, 'Transfer')?.[1] ?? '').toSatisfy(disabled);
    expect(html).toContain('data-question="Archive Main Bank"');
  });

  it('disables both header buttons over a void question, and draws it in the row', () => {
    const html = view({ initialOpen: { kind: 'void', transactionId: 'tx-1' } });
    expect(button(html, 'Add account')?.[1] ?? '').toSatisfy(disabled);
    expect(button(html, 'Transfer')?.[1] ?? '').toSatisfy(disabled);
    expect(html).toContain('data-question="Void transfer TR-0004 of RM 500.00 from Main Bank to Savings"');
  });

  it('closes a void question whose row is not on the screen', () => {
    const html = view({ initialOpen: { kind: 'void', transactionId: 'tx-gone' } });
    expect(html).not.toContain('data-question');
    expect(button(html, 'Add account')?.[1] ?? '').not.toSatisfy(disabled);
  });
});

describe('Banking: the Transactions table', () => {
  it('gives an owner an Actions column and a Void transfer menu on a transfer\'s two rows only', () => {
    const html = view();
    expect(actionsColumns(html)).toBe(2);
    expect(items(html).filter((i) => i === 'Void transfer')).toEqual(['Void transfer', 'Void transfer']);
  });

  it('gives a member no Actions column and no menu on any transfer row', () => {
    const html = view({ writer: writer({ canSignOff: false, transfers: undefined }) });
    expect(actionsColumns(html)).toBe(1);
    expect(items(html).filter((i) => i === 'Void transfer')).toEqual([]);
  });

  it('gives a viewer neither', () => {
    const html = view({ writer: undefined });
    expect(actionsColumns(html)).toBe(0);
    expect(items(html).filter((i) => i === 'Void transfer')).toEqual([]);
  });

  it('draws no menu on a row that is not a transfer', () => {
    const html = view({ rows: [ROWS[2]] });
    expect(items(html).filter((i) => i === 'Void transfer')).toEqual([]);
  });

  it('keeps the transfer menus away over a form', () => {
    const html = view({ initialOpen: { kind: 'transfer', today: TODAY } });
    expect(items(html).filter((i) => i === 'Void transfer')).toEqual([]);
  });

  it('sends the transfer\'s id when a void is confirmed, never the row\'s', async () => {
    view({ initialOpen: { kind: 'void', transactionId: 'tx-1' } });
    expect(asked.confirm).toBeTypeOf('function');
    asked.confirm?.();
    await Promise.resolve();
    expect(voidCalls).toEqual([{ transfer_id: 'transfer-1' }]);
  });
});

describe('The transfer form: the overdraw line', () => {
  const card = (initial: Parameters<typeof TransferFormCard>[0]['initial']) =>
    renderToStaticMarkup(
      <TransferFormCard accounts={ACCOUNTS} today={TODAY} record={vi.fn()} onClose={() => {}} onRecorded={() => {}} initial={initial} />,
    );

  it('says what the transfer leaves the account at, when it would overdraw it', () => {
    const html = card({ from: 'acc-main', to: 'acc-save', amount: '500' });
    expect(text(html)).toContain('Main Bank holds RM 300.00. This transfer leaves it overdrawn by RM 200.00.');
    expect(html).toContain('role="status"');
  });

  it('says nothing when the account covers it, or nothing is chosen', () => {
    expect(text(card({ from: 'acc-main', to: 'acc-save', amount: '300' }))).not.toContain('overdrawn');
    expect(text(card({}))).not.toContain('overdrawn');
  });
});
