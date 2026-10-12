import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LEDGER_MESSAGES,
  LEDGER_PAGE_SIZE,
  accountIdInput,
  createAccount,
  createAccountInput,
  deleteAccount,
  deleteJournal,
  getJournal,
  journalIdInput,
  listJournals,
  listLedgerAccounts,
  listLedgerLines,
  purchasesCategoryId,
  postJournal,
  reverseJournal,
  reverseJournalInput,
  saveJournal,
  saveJournalInput,
  setAccountActive,
  setAccountActiveInput,
  updateAccount,
  updateAccountInput,
} from '@/lib/finance/ledger';
import { fakeFinance } from './setup/fake-finance';

const ID = '33333333-3333-4333-8333-333333333333';
const CASH = '44444444-4444-4444-8444-444444444444';
const SALES = '55555555-5555-4555-8555-555555555555';

let logged: ReturnType<typeof vi.spyOn>;
beforeEach(() => { logged = vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { logged.mockRestore(); });

const said = (schema: { safeParse: (v: unknown) => { error?: { issues: { message: string }[] } } }, value: unknown) =>
  schema.safeParse(value).error?.issues[0]?.message;

describe('the sentences', () => {
  it('are the ones the screens show', () => {
    expect(LEDGER_MESSAGES).toMatchObject({
      code: 'Enter a code of 1 to 10 characters.',
      name: 'Enter a name.',
      type: 'Choose what kind of account it is.',
      taken: 'That code or name is already used by another account.',
      fixed: 'That cannot be done to this account: it stands for a bank account, a category or a system account, or it is in use.',
      hasLines: 'This account has journal lines, so it cannot be deleted. Archive it instead.',
      accountGone: 'That account no longer exists.',
      date: 'Enter a valid date.',
      description: 'Describe the journal.',
      lines: 'Add at least two lines.',
      side: 'Each line needs a debit or a credit, not both.',
      account: 'Choose an account for each line.',
      unbalanced: 'Debits and credits must be equal before the journal is posted.',
      incomplete: 'A journal needs at least two lines, each on an active account.',
      locked: 'That cannot be done to this journal as it now stands. It may have been posted since this page was loaded.',
      gone: 'That journal no longer exists.',
      needsSignOff: 'Only an owner or admin can change accounts or journals.',
      reversedOnce: 'This journal already has a reversal.',
    });
  });
});

describe('account inputs', () => {
  const valid = { code: '1500', name: 'Equipment', type: 'asset' };

  it('wants a code of 1 to 10 characters, trimmed', () => {
    expect(said(createAccountInput, { ...valid, code: '' })).toBe(LEDGER_MESSAGES.code);
    expect(said(createAccountInput, { ...valid, code: '   ' })).toBe(LEDGER_MESSAGES.code);
    expect(said(createAccountInput, { ...valid, code: '12345678901' })).toBe(LEDGER_MESSAGES.code);
    expect(said(createAccountInput, { ...valid, code: undefined })).toBe(LEDGER_MESSAGES.code);
    expect(createAccountInput.parse({ ...valid, code: ' 1500 ' }).code).toBe('1500');
    expect(createAccountInput.parse({ ...valid, code: '1234567890' }).code).toBe('1234567890');
  });
  it('wants a name of 1 to 200 characters, trimmed', () => {
    expect(said(createAccountInput, { ...valid, name: '  ' })).toBe(LEDGER_MESSAGES.name);
    expect(said(createAccountInput, { ...valid, name: 'a'.repeat(201) })).toBe(LEDGER_MESSAGES.name);
    expect(createAccountInput.parse({ ...valid, name: '  Equipment ' }).name).toBe('Equipment');
  });
  it('wants one of the five kinds of account', () => {
    for (const type of ['', 'cash', undefined, null]) expect(said(createAccountInput, { ...valid, type }), String(type)).toBe(LEDGER_MESSAGES.type);
    for (const type of ['asset', 'liability', 'equity', 'income', 'expense']) expect(createAccountInput.parse({ ...valid, type }).type).toBe(type);
  });
  it('has no place for a link, a system key or a workspace', () => {
    const parsed = createAccountInput.parse({ ...valid, system_key: 'payable', category_id: ID, org_id: 'x', active: false });
    expect(Object.keys(parsed).sort()).toEqual(['code', 'name', 'type']);
  });
  it('changes the code and name only: the kind of account is fixed', () => {
    expect(updateAccountInput.parse({ id: ID, code: ' 1510 ', name: ' Plant ', type: 'expense' })).toEqual({ id: ID, code: '1510', name: 'Plant' });
    expect(said(updateAccountInput, { id: 'nope', code: '1', name: 'x' })).toBe(LEDGER_MESSAGES.accountGone);
    expect(said(updateAccountInput, { id: ID, code: '', name: 'x' })).toBe(LEDGER_MESSAGES.code);
    expect(said(updateAccountInput, { id: ID, code: '1', name: '' })).toBe(LEDGER_MESSAGES.name);
  });
  it('wants an account id, and a yes or no for archiving', () => {
    expect(accountIdInput.safeParse({ id: ID }).success).toBe(true);
    expect(said(accountIdInput, { id: 'nope' })).toBe(LEDGER_MESSAGES.accountGone);
    expect(setAccountActiveInput.safeParse({ id: ID, active: false }).success).toBe(true);
    expect(setAccountActiveInput.safeParse({ id: ID, active: 'no' }).success).toBe(false);
    expect(said(setAccountActiveInput, { id: 'nope', active: true })).toBe(LEDGER_MESSAGES.accountGone);
  });
});

describe('journal inputs', () => {
  const lines = [
    { account_id: CASH, debit: 100, credit: 0 },
    { account_id: SALES, debit: 0, credit: 100 },
  ];
  const valid = { journal_date: '2026-10-12', description: 'Owner’s capital', lines };

  it('wants a real date and a description of 1 to 200 characters, trimmed', () => {
    expect(said(saveJournalInput, { ...valid, journal_date: '12/10/2026' })).toBe(LEDGER_MESSAGES.date);
    expect(said(saveJournalInput, { ...valid, journal_date: '2026-02-30' })).toBe(LEDGER_MESSAGES.date);
    expect(said(saveJournalInput, { ...valid, description: '  ' })).toBe(LEDGER_MESSAGES.description);
    expect(said(saveJournalInput, { ...valid, description: 'a'.repeat(201) })).toBe(LEDGER_MESSAGES.description);
    expect(saveJournalInput.parse({ ...valid, description: ' Capital ' }).description).toBe('Capital');
  });
  it('takes 1 to 100 lines', () => {
    expect(said(saveJournalInput, { ...valid, lines: [] })).toBe(LEDGER_MESSAGES.lines);
    expect(said(saveJournalInput, { ...valid, lines: undefined })).toBe(LEDGER_MESSAGES.lines);
    expect(saveJournalInput.safeParse({ ...valid, lines: [lines[0]] }).success).toBe(true);
    expect(said(saveJournalInput, { ...valid, lines: Array.from({ length: 101 }, () => lines[0]) })).toBe(LEDGER_MESSAGES.tooManyLines);
    expect(LEDGER_MESSAGES.tooManyLines).toBe('A journal can have at most 100 lines.');
  });
  it('wants an account on every line', () => {
    expect(said(saveJournalInput, { ...valid, lines: [{ ...lines[0], account_id: '' }, lines[1]] })).toBe(LEDGER_MESSAGES.account);
    expect(said(saveJournalInput, { ...valid, lines: [{ debit: 1, credit: 0 }, lines[1]] })).toBe(LEDGER_MESSAGES.account);
  });
  it('wants exactly one side above zero on each line', () => {
    expect(said(saveJournalInput, { ...valid, lines: [{ ...lines[0], debit: 0 }, lines[1]] })).toBe(LEDGER_MESSAGES.side);
    expect(said(saveJournalInput, { ...valid, lines: [{ ...lines[0], credit: 5 }, lines[1]] })).toBe(LEDGER_MESSAGES.side);
    // 0.004 rounds to nothing, so this line has no side at all.
    expect(said(saveJournalInput, { ...valid, lines: [{ ...lines[0], debit: 0.004 }, lines[1]] })).toBe(LEDGER_MESSAGES.side);
  });
  it('refuses an amount that is negative, not a number or too large, and rounds to the sen', () => {
    for (const debit of [-1, Number.NaN, '5', 1e13]) {
      expect(said(saveJournalInput, { ...valid, lines: [{ ...lines[0], debit }, lines[1]] }), String(debit)).toBe(LEDGER_MESSAGES.amount);
    }
    expect(LEDGER_MESSAGES.amount).toBe('Enter an amount of 0 or more.');
    expect(saveJournalInput.parse({ ...valid, lines: [{ ...lines[0], debit: 10.005 }, lines[1]] }).lines[0].debit).toBe(10.01);
  });
  it('keeps a note trimmed, and an empty one as null', () => {
    const parsed = saveJournalInput.parse({ ...valid, lines: [{ ...lines[0], note: ' cash in ' }, { ...lines[1], note: '  ' }] });
    expect(parsed.lines.map((l) => l.note)).toEqual(['cash in', null]);
    expect(saveJournalInput.parse(valid).lines[0].note).toBeNull();
  });
  it('has no place for a number, a status or a workspace', () => {
    const parsed = saveJournalInput.parse({ ...valid, journal_no: 'JV-9', status: 'posted', org_id: 'x' });
    expect(Object.keys(parsed).sort()).toEqual(['description', 'journal_date', 'lines']);
  });
  it('wants a journal id, and a real date to reverse on', () => {
    expect(journalIdInput.safeParse({ id: ID }).success).toBe(true);
    expect(said(journalIdInput, { id: 'nope' })).toBe(LEDGER_MESSAGES.gone);
    expect(reverseJournalInput.safeParse({ id: ID, reversal_date: '2026-10-12' }).success).toBe(true);
    expect(said(reverseJournalInput, { id: ID, reversal_date: '12/10/2026' })).toBe(LEDGER_MESSAGES.date);
    expect(said(reverseJournalInput, { id: 'nope', reversal_date: '2026-10-12' })).toBe(LEDGER_MESSAGES.gone);
  });
});

describe('ledger account reads', () => {
  const account = (code: string, extra: Record<string, unknown> = {}) => ({
    id: `acc-${code}`, code, name: `Account ${code}`, type: 'asset', system_key: null, bank_account_id: null, category_id: null,
    default_for: null, active: true, ...extra,
  });
  const balance = (code: string, debit: string, credit: string, bal: string) => ({
    account_id: `acc-${code}`, debit_total: debit, credit_total: credit, balance: bal,
  });

  it('merges the accounts with their balances by account, in the caller’s workspace', async () => {
    const { ctx, calls } = fakeFinance((call) =>
      call.name === 'finance_ledger_accounts'
        ? { data: [account('1000', { bank_account_id: 'b1' }), account('1100', { system_key: 'receivable' }), account('2000', { category_id: 'c1', type: 'expense', default_for: 'purchases' }), account('3000')], error: null }
        : { data: [balance('1000', '150.50', '50.25', '100.25'), balance('1100', '10', '0', '10')], error: null },
    );
    const rows = await listLedgerAccounts(ctx);
    expect(rows.map((r) => [r.code, r.stands_for, r.debit_total, r.credit_total, r.balance])).toEqual([
      ['1000', 'bank', 150.5, 50.25, 100.25],
      ['1100', 'system', 10, 0, 10],
      ['2000', 'category', 0, 0, 0],
      ['3000', 'own', 0, 0, 0],
    ]);
    expect(rows[2]).toMatchObject({ category_id: 'c1', default_for: 'purchases', type: 'expense', active: true });
    expect(calls.map((c) => [c.name, c.filters])).toEqual([
      ['finance_ledger_accounts', { org_id: 'org-1' }],
      ['finance_ledger_balances', { org_id: 'org-1' }],
    ]);
    expect(calls[0].order).toEqual(['code asc', 'id asc']);
    expect(calls[0].columns).toBe('id,code,name,type,system_key,bank_account_id,category_id,default_for,active');
  });
  it('reads both on past a full page', async () => {
    const full = Array.from({ length: LEDGER_PAGE_SIZE }, (_, n) => account(String(n).padStart(5, '0')));
    const { ctx, calls } = fakeFinance((call) => {
      if (call.name === 'finance_ledger_balances') return { data: [], error: null };
      return { data: call.range?.[0] === 0 ? full : [account('99999')], error: null };
    });
    expect(await listLedgerAccounts(ctx)).toHaveLength(LEDGER_PAGE_SIZE + 1);
    expect(calls.filter((c) => c.name === 'finance_ledger_accounts').map((c) => c.range)).toEqual([
      [0, LEDGER_PAGE_SIZE - 1],
      [LEDGER_PAGE_SIZE, 2 * LEDGER_PAGE_SIZE - 1],
    ]);
  });
  it('throws a read error rather than showing accounts without their balances', async () => {
    const { ctx } = fakeFinance((call) =>
      call.name === 'finance_ledger_balances' ? { data: null, error: { code: 'XX000' } } : { data: [account('1000')], error: null },
    );
    await expect(listLedgerAccounts(ctx)).rejects.toMatchObject({ code: 'XX000' });
  });
});

describe('ledger line reads', () => {
  const row = (n: number, extra: Record<string, unknown> = {}) => ({
    entry_key: `invoice:${n}`, entry_date: '2026-10-01', source: 'invoice', source_id: `i${n}`, source_no: `INV-${n}`,
    description: 'Invoice', account_id: 'a1', debit: '106.00', credit: '0.00', ...extra,
  });

  it('reads the view in the caller’s workspace, newest first with an entry’s lines together, figures as numbers', async () => {
    const { ctx, calls } = fakeFinance({ data: [row(1), row(1, { debit: '0.00', credit: '100.00', account_id: null })], error: null });
    const lines = await listLedgerLines(ctx);
    expect(lines.map((l) => [l.debit, l.credit, l.account_id])).toEqual([[106, 0, 'a1'], [0, 100, null]]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      name: 'finance_ledger_lines',
      op: 'select',
      filters: { org_id: 'org-1' },
      order: ['entry_date desc', 'entry_key asc', 'debit desc', 'account_id asc', 'credit desc'],
      range: [0, LEDGER_PAGE_SIZE - 1],
    });
    expect(calls[0].columns).toBe('entry_key,entry_date,source,source_id,source_no,description,account_id,debit,credit');
  });
  it('reads on past a full page', async () => {
    const full = Array.from({ length: LEDGER_PAGE_SIZE }, (_, n) => row(n));
    const { ctx, calls } = fakeFinance((call) => ({ data: call.range?.[0] === 0 ? full : [row(-1)], error: null }));
    expect(await listLedgerLines(ctx)).toHaveLength(LEDGER_PAGE_SIZE + 1);
    expect(calls.map((c) => c.range)).toEqual([
      [0, LEDGER_PAGE_SIZE - 1],
      [LEDGER_PAGE_SIZE, 2 * LEDGER_PAGE_SIZE - 1],
    ]);
  });
  it('throws a read error', async () => {
    const { ctx } = fakeFinance({ data: null, error: { code: 'XX000' } });
    await expect(listLedgerLines(ctx)).rejects.toMatchObject({ code: 'XX000' });
  });
});

describe('journal reads', () => {
  const journal = (id: string, extra: Record<string, unknown> = {}) => ({
    id, journal_no: null, journal_date: '2026-10-01', description: 'Capital', status: 'draft', reverses_journal_id: null, ...extra,
  });

  it('lists in the caller’s workspace, and marks a journal reversed when another one names it', async () => {
    const { ctx, calls } = fakeFinance({
      data: [
        journal('j3', { status: 'posted', journal_no: 'JV-0002', reverses_journal_id: 'j1' }),
        journal('j2'),
        journal('j1', { status: 'posted', journal_no: 'JV-0001' }),
      ],
      error: null,
    });
    const rows = await listJournals(ctx);
    expect(rows.map((r) => [r.id, r.reversed])).toEqual([['j3', false], ['j2', false], ['j1', true]]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      name: 'finance_journals', filters: { org_id: 'org-1' }, order: ['journal_date desc', 'id asc'], range: [0, LEDGER_PAGE_SIZE - 1],
    });
    expect(calls[0].columns).toBe('id,journal_no,journal_date,description,status,reverses_journal_id');
  });
  it('finds the reversal even when it is on a later page', async () => {
    const full = Array.from({ length: LEDGER_PAGE_SIZE }, (_, n) => journal(`j${n}`));
    const { ctx } = fakeFinance((call) => ({
      data: call.range?.[0] === 0 ? full : [journal('rev', { reverses_journal_id: 'j0' })],
      error: null,
    }));
    const rows = await listJournals(ctx);
    expect(rows).toHaveLength(LEDGER_PAGE_SIZE + 1);
    expect(rows[0].reversed).toBe(true);
    expect(rows[1].reversed).toBe(false);
  });
  it('throws a read error', async () => {
    const { ctx } = fakeFinance({ data: null, error: { code: 'XX000' } });
    await expect(listJournals(ctx)).rejects.toMatchObject({ code: 'XX000' });
  });
  it('reads one journal with its lines in the order entered', async () => {
    const lines = [
      { id: 'l1', position: 0, account_id: CASH, debit: '100.00', credit: '0.00', note: 'cash in' },
      { id: 'l2', position: 1, account_id: SALES, debit: '0.00', credit: '100.00', note: null },
    ];
    const { ctx, calls } = fakeFinance((call) => {
      if (call.name === 'finance_journals' && call.filters.id) return { data: journal(ID, { status: 'posted', journal_no: 'JV-0001' }), error: null };
      if (call.name === 'finance_journals') return { data: null, error: null };
      return { data: lines, error: null };
    });
    expect(await getJournal(ctx, ID)).toEqual({
      ...journal(ID, { status: 'posted', journal_no: 'JV-0001' }),
      reversed: false,
      lines: [
        { id: 'l1', position: 0, account_id: CASH, debit: 100, credit: 0, note: 'cash in' },
        { id: 'l2', position: 1, account_id: SALES, debit: 0, credit: 100, note: null },
      ],
    });
    expect(calls[0].filters).toEqual({ org_id: 'org-1', id: ID });
    expect(calls.find((c) => c.name === 'finance_journal_lines')).toMatchObject({
      filters: { org_id: 'org-1', journal_id: ID }, order: ['position asc', 'id asc'],
    });
    expect(calls.find((c) => c.filters.reverses_journal_id)?.filters).toEqual({ org_id: 'org-1', reverses_journal_id: ID });
  });
  it('says reversed when a journal names this one', async () => {
    const { ctx } = fakeFinance((call) => {
      if (call.filters.id) return { data: journal(ID, { status: 'posted' }), error: null };
      if (call.filters.reverses_journal_id) return { data: { id: 'rev' }, error: null };
      return { data: [], error: null };
    });
    expect((await getJournal(ctx, ID))?.reversed).toBe(true);
  });
  it('answers null for a journal that is not there, and for an id that is not an id, without asking the database', async () => {
    const missing = fakeFinance({ data: null, error: null });
    expect(await getJournal(missing.ctx, ID)).toBeNull();
    const bad = fakeFinance({ data: null, error: null });
    expect(await getJournal(bad.ctx, 'nope')).toBeNull();
    expect(bad.calls).toEqual([]);
  });
});

describe('account writes', () => {
  it('creates an account with no link, in the caller’s workspace', async () => {
    const { ctx, calls } = fakeFinance({ data: { id: ID }, error: null });
    expect(await createAccount(ctx, { code: ' 1500 ', name: 'Equipment', type: 'asset' })).toEqual({ ok: true, data: { id: ID } });
    expect(calls[0]).toMatchObject({ name: 'finance_ledger_accounts', op: 'insert' });
    expect(calls[0].values).toEqual({ org_id: 'org-1', code: '1500', name: 'Equipment', type: 'asset' });
  });
  it('renames an account: code and name only', async () => {
    const { ctx, calls } = fakeFinance({ data: { id: ID }, error: null });
    expect(await updateAccount(ctx, { id: ID, code: '1510', name: 'Plant' })).toEqual({ ok: true, data: { id: ID } });
    expect(calls[0]).toMatchObject({ name: 'finance_ledger_accounts', op: 'update', filters: { id: ID, org_id: 'org-1' } });
    expect(Object.keys(calls[0].values!).sort()).toEqual(['code', 'name', 'updated_at']);
    expect(calls[0].values).toMatchObject({ code: '1510', name: 'Plant' });
  });
  it('archives and unarchives', async () => {
    const { ctx, calls } = fakeFinance({ data: { id: ID }, error: null });
    expect(await setAccountActive(ctx, { id: ID, active: false })).toEqual({ ok: true, data: { id: ID } });
    expect(calls[0]).toMatchObject({ op: 'update', filters: { id: ID, org_id: 'org-1' } });
    expect(calls[0].values).toMatchObject({ active: false });
    expect(Object.keys(calls[0].values!).sort()).toEqual(['active', 'updated_at']);
  });
  it('deletes, scoped to the workspace', async () => {
    const { ctx, calls } = fakeFinance({ data: { id: ID }, error: null });
    expect(await deleteAccount(ctx, { id: ID })).toEqual({ ok: true, data: { id: ID } });
    expect(calls[0]).toMatchObject({ name: 'finance_ledger_accounts', op: 'delete', filters: { id: ID, org_id: 'org-1' } });
  });
  it('turns each database refusal into a sentence', async () => {
    const cases: [string, string][] = [
      ['23505', LEDGER_MESSAGES.taken],
      ['FIN25', LEDGER_MESSAGES.fixed],
      ['23503', LEDGER_MESSAGES.hasLines],
      ['42501', LEDGER_MESSAGES.needsSignOff],
      ['FIN14', LEDGER_MESSAGES.needsSignOff],
    ];
    for (const [code, message] of cases) {
      const { ctx } = fakeFinance({ data: null, error: { code } });
      const expected = { ok: false, error: message };
      expect(await createAccount(ctx, { code: '1', name: 'x', type: 'asset' }), code).toEqual(expected);
      expect(await updateAccount(ctx, { id: ID, code: '1', name: 'x' }), code).toEqual(expected);
      expect(await setAccountActive(ctx, { id: ID, active: true }), code).toEqual(expected);
      expect(await deleteAccount(ctx, { id: ID }), code).toEqual(expected);
    }
    expect(logged).not.toHaveBeenCalled();
  });
  it('says the account is gone when an update, archive or delete touches no row', async () => {
    const { ctx } = fakeFinance({ data: null, error: null });
    const gone = { ok: false, error: LEDGER_MESSAGES.accountGone };
    expect(await updateAccount(ctx, { id: ID, code: '1', name: 'x' })).toEqual(gone);
    expect(await setAccountActive(ctx, { id: ID, active: true })).toEqual(gone);
    expect(await deleteAccount(ctx, { id: ID })).toEqual(gone);
  });
  it('hides any other database error behind the general message and logs it', async () => {
    const { ctx } = fakeFinance({ data: null, error: { code: 'XX000' } });
    expect(await createAccount(ctx, { code: '1', name: 'x', type: 'asset' })).toEqual({
      ok: false, error: 'That change could not be saved. Please try again.',
    });
    expect(logged).toHaveBeenCalled();
  });
});

describe('journal writes', () => {
  const valid = {
    journal_date: '2026-10-12',
    description: 'Capital',
    lines: [
      { account_id: CASH, debit: 100, credit: 0 },
      { account_id: SALES, debit: 0, credit: 100, note: 'owner' },
    ],
  };

  it('saves through the database function, in the caller’s workspace', async () => {
    const { ctx, calls } = fakeFinance({ data: ID, error: null });
    expect(await saveJournal(ctx, { ...valid, id: ID })).toEqual({ ok: true, data: { id: ID } });
    expect(calls[0]).toMatchObject({ kind: 'rpc', name: 'finance_save_journal' });
    expect(calls[0].args).toEqual({
      target_org: 'org-1',
      journal: { id: ID, journal_date: '2026-10-12', description: 'Capital' },
      lines: [
        { account_id: CASH, debit: 100, credit: 0, note: null },
        { account_id: SALES, debit: 0, credit: 100, note: 'owner' },
      ],
    });
  });
  it('sends no id for a new journal', async () => {
    const { ctx, calls } = fakeFinance({ data: ID, error: null });
    await saveJournal(ctx, valid);
    expect(calls[0].args!.journal).toEqual({ journal_date: '2026-10-12', description: 'Capital' });
  });
  it('posts and returns the number', async () => {
    const { ctx, calls } = fakeFinance({ data: 'JV-0007', error: null });
    expect(await postJournal(ctx, { id: ID })).toEqual({ ok: true, data: { id: ID, journal_no: 'JV-0007' } });
    expect(calls[0]).toMatchObject({ kind: 'rpc', name: 'finance_post_journal' });
    expect(calls[0].args).toEqual({ target_org: 'org-1', target_journal: ID });
  });
  it('reverses on the date given and returns the draft reversal', async () => {
    const REVERSAL = '66666666-6666-4666-8666-666666666666';
    const { ctx, calls } = fakeFinance({ data: REVERSAL, error: null });
    expect(await reverseJournal(ctx, { id: ID, reversal_date: '2026-10-20' })).toEqual({ ok: true, data: { id: ID, reversal_id: REVERSAL } });
    expect(calls[0]).toMatchObject({ kind: 'rpc', name: 'finance_reverse_journal' });
    expect(calls[0].args).toEqual({ target_org: 'org-1', target_journal: ID, reversal_date: '2026-10-20' });
  });
  it('deletes a draft, scoped to the workspace', async () => {
    const { ctx, calls } = fakeFinance({ data: { id: ID }, error: null });
    expect(await deleteJournal(ctx, { id: ID })).toEqual({ ok: true, data: { id: ID } });
    expect(calls[0]).toMatchObject({ name: 'finance_journals', op: 'delete', filters: { id: ID, org_id: 'org-1' } });
  });
  it('says the journal is gone when a delete touches no row', async () => {
    const { ctx } = fakeFinance({ data: null, error: null });
    expect(await deleteJournal(ctx, { id: ID })).toEqual({ ok: false, error: LEDGER_MESSAGES.gone });
  });
  it('turns each database refusal into a sentence', async () => {
    const cases: [string, string][] = [
      ['FIN01', LEDGER_MESSAGES.locked],
      ['FIN11', LEDGER_MESSAGES.gone],
      ['FIN14', LEDGER_MESSAGES.needsSignOff],
      ['42501', LEDGER_MESSAGES.needsSignOff],
      ['FIN23', LEDGER_MESSAGES.unbalanced],
      ['FIN24', LEDGER_MESSAGES.incomplete],
      ['FIN27', LEDGER_MESSAGES.reversedOnce],
      ['22003', 'That amount is too large.'],
    ];
    for (const [code, message] of cases) {
      const { ctx } = fakeFinance({ data: null, error: { code } });
      const expected = { ok: false, error: message };
      expect(await saveJournal(ctx, valid), code).toEqual(expected);
      expect(await postJournal(ctx, { id: ID }), code).toEqual(expected);
      expect(await reverseJournal(ctx, { id: ID, reversal_date: '2026-10-20' }), code).toEqual(expected);
      expect(await deleteJournal(ctx, { id: ID }), code).toEqual(expected);
    }
    expect(logged).not.toHaveBeenCalled();
  });
  it('reads 23505 as "already reversed" on a reversal, where the one-reversal index refuses', async () => {
    const { ctx } = fakeFinance({ data: null, error: { code: '23505' } });
    expect(await reverseJournal(ctx, { id: ID, reversal_date: '2026-10-20' })).toEqual({ ok: false, error: LEDGER_MESSAGES.reversedOnce });
  });
  it('hides any other database error behind the general message and logs it', async () => {
    const { ctx } = fakeFinance({ data: null, error: { code: 'XX000' } });
    expect(await saveJournal(ctx, valid)).toEqual({ ok: false, error: 'That change could not be saved. Please try again.' });
    expect(logged).toHaveBeenCalled();
  });
});

describe('purchasesCategoryId', () => {
  it('reads the one account behind purchases and gives its category', async () => {
    const { ctx, calls } = fakeFinance({ data: { category_id: 'cat-1' }, error: null });
    expect(await purchasesCategoryId(ctx)).toBe('cat-1');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      name: 'finance_ledger_accounts',
      op: 'select',
      columns: 'category_id',
      filters: { org_id: 'org-1', default_for: 'purchases' },
    });
  });
  it('is null when there is no such account, or it has no category', async () => {
    expect(await purchasesCategoryId(fakeFinance({ data: null, error: null }).ctx)).toBeNull();
    expect(await purchasesCategoryId(fakeFinance({ data: { category_id: null }, error: null }).ctx)).toBeNull();
  });
  it('throws a read error', async () => {
    await expect(purchasesCategoryId(fakeFinance({ data: null, error: { code: 'XX000' } }).ctx)).rejects.toMatchObject({ code: 'XX000' });
  });
});
