import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BANK_ACCOUNT_MESSAGES,
  changesOpeningBalance,
  createBankAccount,
  createBankAccountInput,
  listBankAccountNumbers,
  setBankAccountActive,
  setBankAccountActiveInput,
  setsOpeningBalance,
  updateBankAccount,
  updateBankAccountInput,
} from '@/lib/finance/bank-accounts';
import type { FinanceWriteContext } from '@/lib/finance/result';

const M = BANK_ACCOUNT_MESSAGES;
const ID = '11111111-1111-4111-8111-111111111111';

type Call = {
  table?: string;
  rpc?: string;
  args?: unknown;
  op?: 'insert' | 'update';
  values?: Record<string, unknown>;
  columns?: string;
  filters: Record<string, unknown>;
};

/** A stand-in client that records the one request each write makes and answers it. */
function fake(answer: { data: unknown; error: unknown }) {
  const calls: Call[] = [];
  const client = {
    rpc: async (rpc: string, args: unknown) => {
      calls.push({ rpc, args, filters: {} });
      return answer;
    },
    from(table: string) {
      const call: Call = { table, filters: {} };
      calls.push(call);
      const builder = {
        insert(values: Record<string, unknown>) {
          call.op = 'insert';
          call.values = values;
          return builder;
        },
        update(values: Record<string, unknown>) {
          call.op = 'update';
          call.values = values;
          return builder;
        },
        eq(column: string, value: unknown) {
          call.filters[column] = value;
          return builder;
        },
        select(columns: string) {
          call.columns = columns;
          return builder;
        },
        maybeSingle: async () => answer,
      };
      return builder;
    },
  };
  return { ctx: { client: client as never, orgId: 'org-1' } satisfies FinanceWriteContext, calls };
}

const saved = { data: { id: ID, name: 'Savings', active: true }, error: null };
const refused = (code: string) => ({ data: null, error: { code, message: 'the database said no' } });

afterEach(() => vi.restoreAllMocks());

describe('createBankAccountInput', () => {
  it('trims, and stores an empty bank name or number as nothing', () => {
    expect(createBankAccountInput.parse({ name: '  Savings ', kind: 'bank', bank_name: ' ', account_no: '' })).toEqual({
      name: 'Savings',
      kind: 'bank',
      bank_name: null,
      account_no: null,
      // Stage 5a: an account says no currency only when it is in ringgit.
      currency: 'MYR',
    });
  });

  it('keeps an opening balance of either sign, rounded to the sen, and its date', () => {
    const parsed = createBankAccountInput.parse({ name: 'Overdraft', kind: 'bank', opening_balance: -250.505, opening_date: '2026-09-30' });
    expect(parsed.opening_balance).toBe(-250.5);
    expect(parsed.opening_date).toBe('2026-09-30');
    expect(createBankAccountInput.parse({ name: 'Till', kind: 'cash', opening_balance: 0 }).opening_balance).toBe(0);
  });

  it.each([
    [{ kind: 'bank' }, M.name],
    [{ name: '   ', kind: 'bank' }, M.name],
    [{ name: 'x'.repeat(81), kind: 'bank' }, M.nameTooLong],
    [{ name: 'A', kind: 'savings' }, M.kind],
    [{ name: 'A' }, M.kind],
    [{ name: 'A', kind: 'bank', bank_name: 'x'.repeat(81) }, M.bankTooLong],
    [{ name: 'A', kind: 'bank', account_no: '1'.repeat(35) }, M.numberTooLong],
    [{ name: 'A', kind: 'bank', opening_balance: Number.NaN }, M.opening],
    [{ name: 'A', kind: 'bank', opening_balance: '100' }, M.opening],
    [{ name: 'A', kind: 'bank', opening_balance: Number.POSITIVE_INFINITY }, M.opening],
    [{ name: 'A', kind: 'bank', opening_balance: 1_000_000_000_000 }, M.opening],
    [{ name: 'A', kind: 'bank', opening_balance: -1_000_000_000_000 }, M.opening],
    [{ name: 'A', kind: 'bank', opening_balance: 5, opening_date: '2026-02-30' }, M.date],
    [{ name: 'A', kind: 'bank', opening_balance: 5, opening_date: 'yesterday' }, M.date],
  ])('refuses %j', (input, message) => {
    const parsed = createBankAccountInput.safeParse(input);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe(message);
  });

  it('drops anything that is not an account’s to send', () => {
    const parsed = createBankAccountInput.parse({ name: 'A', kind: 'cash', org_id: 'other', id: ID, active: false, created_at: 'x' });
    expect(Object.keys(parsed).sort()).toEqual(['account_no', 'bank_name', 'currency', 'kind', 'name']);
  });
});

describe('updateBankAccountInput and setBankAccountActiveInput', () => {
  it('has no kind: bank or cash is chosen once', () => {
    const parsed = updateBankAccountInput.parse({ id: ID, name: 'A', kind: 'cash' });
    expect(parsed).toEqual({ id: ID, name: 'A', bank_name: null, account_no: null });
  });

  it('answers "no longer exists" for an id that is not one', () => {
    expect(updateBankAccountInput.safeParse({ id: 'nope', name: 'A' }).error?.issues[0]?.message).toBe(M.gone);
    expect(setBankAccountActiveInput.safeParse({ id: 'nope', active: true }).error?.issues[0]?.message).toBe(M.gone);
    expect(setBankAccountActiveInput.safeParse({ id: ID }).error?.issues[0]?.message).toBe(M.gone);
  });
});

describe('who an opening balance needs', () => {
  it('a new account: only when it starts with something', () => {
    expect(setsOpeningBalance(createBankAccountInput.parse({ name: 'A', kind: 'bank' }))).toBe(false);
    expect(setsOpeningBalance(createBankAccountInput.parse({ name: 'A', kind: 'bank', opening_balance: 0, opening_date: '2026-01-01' }))).toBe(false);
    expect(setsOpeningBalance(createBankAccountInput.parse({ name: 'A', kind: 'bank', opening_balance: 0.004 }))).toBe(false);
    expect(setsOpeningBalance(createBankAccountInput.parse({ name: 'A', kind: 'bank', opening_balance: 10 }))).toBe(true);
    expect(setsOpeningBalance(createBankAccountInput.parse({ name: 'A', kind: 'bank', opening_balance: -10 }))).toBe(true);
  });

  it('a change: whenever the balance or its date is sent at all', () => {
    expect(changesOpeningBalance(updateBankAccountInput.parse({ id: ID, name: 'A' }))).toBe(false);
    expect(changesOpeningBalance(updateBankAccountInput.parse({ id: ID, name: 'A', opening_balance: 0 }))).toBe(true);
    expect(changesOpeningBalance(updateBankAccountInput.parse({ id: ID, name: 'A', opening_date: '2026-01-01' }))).toBe(true);
  });
});

describe('createBankAccount', () => {
  it('inserts the fields with the workspace from the context, and reads back three named columns', async () => {
    const { ctx, calls } = fake(saved);
    const result = await createBankAccount(ctx, { name: 'Savings', kind: 'bank', bank_name: 'Maybank', account_no: '8001234567' });
    expect(result).toEqual({ ok: true, data: { id: ID, name: 'Savings', active: true } });
    expect(calls).toEqual([
      {
        table: 'finance_accounts',
        op: 'insert',
        values: { name: 'Savings', kind: 'bank', bank_name: 'Maybank', account_no: '8001234567', org_id: 'org-1' },
        columns: 'id,name,active',
        filters: {},
      },
    ]);
  });

  it('writes an opening balance and its date only when they are sent', async () => {
    const { ctx, calls } = fake(saved);
    await createBankAccount(ctx, { name: 'Savings', kind: 'bank', opening_balance: 1500, opening_date: '2026-09-30' });
    expect(calls[0].values).toMatchObject({ opening_balance: 1500, opening_date: '2026-09-30' });
    const plain = fake(saved);
    await createBankAccount(plain.ctx, { name: 'Till', kind: 'cash' });
    expect(Object.keys(plain.calls[0].values ?? {})).not.toContain('opening_balance');
    expect(Object.keys(plain.calls[0].values ?? {})).not.toContain('opening_date');
  });

  it.each([
    ['23505', M.nameTaken],
    ['FIN14', M.needsSignOff],
    ['23514', M.invalid],
    ['42501', 'You do not have permission to make changes here.'],
    ['22003', 'That amount is too large.'],
  ])('words %s', async (code, message) => {
    const { ctx } = fake(refused(code));
    expect(await createBankAccount(ctx, { name: 'Savings', kind: 'bank' })).toEqual({ ok: false, error: message });
  });

  it('logs anything else and answers with the general sentence', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { ctx } = fake(refused('XX000'));
    expect(await createBankAccount(ctx, { name: 'Savings', kind: 'bank' })).toEqual({
      ok: false,
      error: 'That change could not be saved. Please try again.',
    });
    expect(log).toHaveBeenCalledOnce();
  });
});

describe('updateBankAccount', () => {
  it('updates by id and workspace, without kind, org_id or the opening balance unless sent', async () => {
    const { ctx, calls } = fake(saved);
    await updateBankAccount(ctx, { id: ID, name: 'Savings', bank_name: 'Maybank', account_no: '' });
    expect(calls[0]).toMatchObject({ table: 'finance_accounts', op: 'update', columns: 'id,name,active', filters: { id: ID, org_id: 'org-1' } });
    expect(Object.keys(calls[0].values ?? {}).sort()).toEqual(['account_no', 'bank_name', 'name', 'updated_at']);
    expect(calls[0].values).toMatchObject({ name: 'Savings', bank_name: 'Maybank', account_no: null });
  });

  it('sends the opening balance and date when an owner or admin’s form does', async () => {
    const { ctx, calls } = fake(saved);
    await updateBankAccount(ctx, { id: ID, name: 'Savings', opening_balance: 0, opening_date: '2026-01-01' });
    expect(calls[0].values).toMatchObject({ opening_balance: 0, opening_date: '2026-01-01' });
  });

  it('says the account has gone when no row comes back, and words the refusals', async () => {
    expect(await updateBankAccount(fake({ data: null, error: null }).ctx, { id: ID, name: 'A' })).toEqual({ ok: false, error: M.gone });
    expect(await updateBankAccount(fake(refused('23505')).ctx, { id: ID, name: 'A' })).toEqual({ ok: false, error: M.nameTaken });
    expect(await updateBankAccount(fake(refused('FIN14')).ctx, { id: ID, name: 'A' })).toEqual({ ok: false, error: M.needsSignOff });
  });

  it('clears the bank name and number of an update that leaves them out: the form always sends both', async () => {
    expect(updateBankAccountInput.parse({ id: ID, name: 'A' })).toMatchObject({ bank_name: null, account_no: null });
    const { ctx, calls } = fake({ data: { id: ID, name: 'A', active: true }, error: null });
    await updateBankAccount(ctx, { id: ID, name: 'A' });
    expect(calls[0].values).toMatchObject({ bank_name: null, account_no: null });
  });

  it('does not tell an owner who owes a second step that they are not an owner', () => {
    expect(M.needsSignOff).toBe(
      'Only an owner or admin can set or change an opening balance. If you are one, sign in again with your second step.',
    );
  });
});

describe('setBankAccountActive', () => {
  it('writes active and updated_at only', async () => {
    const { ctx, calls } = fake({ data: { id: ID, name: 'Savings', active: false }, error: null });
    expect(await setBankAccountActive(ctx, { id: ID, active: false })).toEqual({ ok: true, data: { id: ID, name: 'Savings', active: false } });
    expect(Object.keys(calls[0].values ?? {}).sort()).toEqual(['active', 'updated_at']);
    expect(calls[0].filters).toEqual({ id: ID, org_id: 'org-1' });
  });

  it('words the archive refusal, and a row that has gone', async () => {
    expect(await setBankAccountActive(fake(refused('FIN30')).ctx, { id: ID, active: false })).toEqual({ ok: false, error: M.inUse });
    expect(await setBankAccountActive(fake({ data: null, error: null }).ctx, { id: ID, active: true })).toEqual({ ok: false, error: M.gone });
  });
});

describe('listBankAccountNumbers', () => {
  it('asks the function for the workspace and keys the numbers by account, leaving out an account with none', async () => {
    const { ctx, calls } = fake({
      data: [
        { account_id: 'a', account_no: '8001234567' },
        { account_id: 'b', account_no: null },
        { account_id: 'c', account_no: '' },
      ],
      error: null,
    });
    expect(await listBankAccountNumbers(ctx)).toEqual({ a: '8001234567' });
    expect(calls).toEqual([{ rpc: 'finance_account_numbers', args: { target_org: 'org-1' }, filters: {} }]);
  });

  it('throws what the database answered', async () => {
    await expect(listBankAccountNumbers(fake(refused('XX000')).ctx)).rejects.toMatchObject({ code: 'XX000' });
  });
});
