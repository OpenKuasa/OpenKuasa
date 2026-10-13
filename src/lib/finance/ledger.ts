/**
 * The general ledger: the chart of accounts, the lines every posted document
 * leaves in it, and manual journals. An account is a plain table; a journal and
 * its lines are saved by one database function, and posting gives it its number
 * and locks it. Only an owner or admin changes accounts or journals. The ledger
 * lines and the account balances are views the database works out; nothing here
 * adds them up. org_id comes from the context.
 */
import { z } from 'zod';
import { DOCUMENT_LINES_MAX, isoDate, optionalText } from './document-lines';
import {
  type FinResult,
  type FinanceWriteContext,
  FIN_SIGN_OFF,
  PG_FORBIDDEN,
  PG_FOREIGN_KEY,
  PG_OUT_OF_RANGE,
  PG_UNIQUE,
  TOO_LARGE,
  pgCode,
  writeFailed,
} from './result';

export const JOURNAL_LINES_MAX = DOCUMENT_LINES_MAX;
/** Accounts, ledger lines and journals loaded for a screen, a page at a time. */
export const LEDGER_PAGE_SIZE = 1000;

export const LEDGER_MESSAGES = {
  code: 'Enter a code of 1 to 10 characters.',
  name: 'Enter a name.',
  type: 'Choose what kind of account it is.',
  // 23505
  taken: 'That code or name is already used by another account.',
  // FIN25
  fixed: 'That cannot be done to this account: it stands for a bank account, a category or a system account, or it is in use.',
  // 23503
  hasLines: 'This account has journal lines, so it cannot be deleted. Archive it instead.',
  accountGone: 'That account no longer exists.',
  date: 'Enter a valid date.',
  description: 'Describe the journal.',
  lines: 'Add at least two lines.',
  tooManyLines: `A journal can have at most ${JOURNAL_LINES_MAX} lines.`,
  side: 'Each line needs a debit or a credit, not both.',
  account: 'Choose an account for each line.',
  amount: 'Enter an amount of 0 or more.',
  // FIN23
  unbalanced: 'Debits and credits must be equal before the journal is posted.',
  // FIN24
  incomplete: 'A journal needs at least two lines, each on an active account.',
  // FIN01. A menu offers only what a journal's status allows, so this reaches a person only when the journal
  // changed under them in another tab. It says what may have happened, not what did.
  locked: 'That cannot be done to this journal as it now stands. It may have been posted since this page was loaded.',
  // FIN11
  gone: 'That journal no longer exists.',
  // FIN14, 42501: changing accounts and journals is an owner's or admin's.
  needsSignOff: 'Only an owner or admin can change accounts or journals.',
  // FIN27, and 23505 on a reversal
  reversedOnce: 'This journal already has a reversal.',
} as const;

const M = LEDGER_MESSAGES;

/** The most a ledger figure can hold: numeric(14,2). */
const MAX_AMOUNT = 999_999_999_999.99;

/* ---- inputs ----------------------------------------------------------- */

export type AccountType = 'asset' | 'liability' | 'equity' | 'income' | 'expense';

const accountId = z.string({ error: M.accountGone }).uuid(M.accountGone);
const accountCode = z.string({ error: M.code }).trim().min(1, M.code).max(10, M.code);
const accountName = z.string({ error: M.name }).trim().min(1, M.name).max(200, M.name);

/** A person adds only an account with no link: what an account stands for, and its type, never change. */
export const createAccountInput = z.object({
  code: accountCode,
  name: accountName,
  type: z.enum(['asset', 'liability', 'equity', 'income', 'expense'], { error: M.type }),
});

/** Renaming: the code and the name. Anything else sent with it is dropped. */
export const updateAccountInput = z.object({ id: accountId, code: accountCode, name: accountName });

export const accountIdInput = z.object({ id: accountId });
export const setAccountActiveInput = accountIdInput.extend({ active: z.boolean() });

/** An amount of 0 or more, rounded to the sen first, as the column numeric(14,2) stores it. */
const sideAmount = z
  .number({ error: M.amount })
  .transform((v) => Math.round(v * 100) / 100)
  .pipe(z.number().min(0, M.amount).max(MAX_AMOUNT, M.amount));

const journalLine = z
  .object({
    account_id: z.string({ error: M.account }).uuid(M.account),
    debit: sideAmount,
    credit: sideAmount,
    note: optionalText.default(null),
  })
  .refine((l) => l.debit > 0 !== l.credit > 0, { message: M.side, path: ['debit'] });

const journalId = z.string({ error: M.gone }).uuid(M.gone);

/**
 * A draft journal. It may be saved unbalanced and with one line: the database asks for two lines and equal
 * sides when the journal is posted.
 */
export const saveJournalInput = z.object({
  /** Present to change a draft; absent to create one. */
  id: journalId.optional(),
  journal_date: isoDate,
  description: z.string({ error: M.description }).trim().min(1, M.description).max(200, M.description),
  lines: z.array(journalLine, { error: M.lines }).min(1, M.lines).max(JOURNAL_LINES_MAX, M.tooManyLines),
});

export const journalIdInput = z.object({ id: journalId });
export const reverseJournalInput = journalIdInput.extend({ reversal_date: isoDate });

/* ---- refusals --------------------------------------------------------- */

const ACCOUNT_REFUSALS: Record<string, string> = {
  [PG_UNIQUE]: M.taken,
  FIN25: M.fixed,
  [PG_FOREIGN_KEY]: M.hasLines,
  [FIN_SIGN_OFF]: M.needsSignOff,
  [PG_FORBIDDEN]: M.needsSignOff,
};

function accountWriteFailed(fnName: string, error: unknown): { ok: false; error: string } {
  const refusal = ACCOUNT_REFUSALS[pgCode(error) ?? ''];
  return refusal ? { ok: false, error: refusal } : writeFailed(fnName, error);
}

const JOURNAL_REFUSALS: Record<string, string> = {
  FIN01: M.locked,
  FIN11: M.gone,
  [FIN_SIGN_OFF]: M.needsSignOff,
  [PG_FORBIDDEN]: M.needsSignOff,
  FIN23: M.unbalanced,
  FIN24: M.incomplete,
  FIN27: M.reversedOnce,
  [PG_OUT_OF_RANGE]: TOO_LARGE,
};

/** On a reversal, the unique index that allows one reversal per journal is what refuses a second. */
function journalWriteFailed(fnName: string, error: unknown, uniqueMeans?: string): { ok: false; error: string } {
  const code = pgCode(error) ?? '';
  const refusal = code === PG_UNIQUE && uniqueMeans ? uniqueMeans : JOURNAL_REFUSALS[code];
  return refusal ? { ok: false, error: refusal } : writeFailed(fnName, error);
}

/* ---- reads ------------------------------------------------------------ */

/** What an account stands for. */
export type AccountStandsFor = 'system' | 'bank' | 'category' | 'own';

export type LedgerAccount = {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  active: boolean;
  /** What it stands for. */
  stands_for: AccountStandsFor;
  system_key: string | null;
  bank_account_id: string | null;
  category_id: string | null;
  default_for: 'sales' | 'purchases' | null;
  /** From finance_ledger_balances; 0 for an account nothing has posted to. */
  debit_total: number;
  credit_total: number;
  balance: number;
};

export type LedgerSource =
  | 'invoice'
  | 'credit_note'
  | 'payment_in'
  | 'refund'
  | 'bill'
  | 'payment_out'
  | 'expense'
  | 'transfer'
  | 'opening'
  | 'journal';

export type LedgerLine = {
  entry_key: string;
  entry_date: string;
  source: LedgerSource;
  source_id: string;
  source_no: string | null;
  description: string;
  account_id: string | null;
  debit: number;
  credit: number;
};

export type JournalStatus = 'draft' | 'posted';

export type JournalRow = {
  id: string;
  /** null until the journal is posted. */
  journal_no: string | null;
  journal_date: string;
  description: string;
  status: JournalStatus;
  /** The journal this one undoes, if it is a reversal. */
  reverses_journal_id: string | null;
  /** Another journal, a draft included, undoes this one. */
  reversed: boolean;
};

export type JournalDetail = JournalRow & {
  lines: { id: string; position: number; account_id: string; debit: number; credit: number; note: string | null }[];
};

/**
 * The answer to "Save and post". When the draft was saved but posting it was refused, `draftId` is that
 * draft, so the form goes on editing it instead of saving a second copy.
 */
export type SaveAndPostJournalResult = FinResult<{ id: string; journal_no: string }> & { draftId?: string };

const ACCOUNT_COLUMNS = 'id,code,name,type,system_key,bank_account_id,category_id,default_for,active';
const BALANCE_COLUMNS = 'account_id,debit_total,credit_total,balance';
const LINE_COLUMNS = 'entry_key,entry_date,source,source_id,source_no,description,account_id,debit,credit';
const JOURNAL_COLUMNS = 'id,journal_no,journal_date,description,status,reverses_journal_id';

function standsFor(row: Record<string, unknown>): AccountStandsFor {
  if (row.system_key) return 'system';
  if (row.bank_account_id) return 'bank';
  if (row.category_id) return 'category';
  return 'own';
}

/**
 * Every workspace row of a table or view, read a page at a time. Like the other reads here it throws when it
 * fails: a screen that quietly showed part of the books would be wrong, not just incomplete.
 */
async function readAll(
  ctx: FinanceWriteContext,
  table: string,
  columns: string,
  order: { column: string; ascending: boolean }[],
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  for (let from = 0; ; from += LEDGER_PAGE_SIZE) {
    let query = ctx.client.from(table).select(columns).eq('org_id', ctx.orgId);
    for (const { column, ascending } of order) query = query.order(column, { ascending });
    const { data, error } = await query.range(from, from + LEDGER_PAGE_SIZE - 1);
    if (error) throw error;
    const page = (data ?? []) as unknown as Record<string, unknown>[];
    rows.push(...page);
    if (page.length < LEDGER_PAGE_SIZE) return rows;
  }
}

/**
 * Every account of the workspace, by code, with what has been posted to it. PostgREST cannot join a table to
 * a view without a declared relationship, so the balances are a second read, merged here by account.
 */
export async function listLedgerAccounts(ctx: FinanceWriteContext): Promise<LedgerAccount[]> {
  const accounts = await readAll(ctx, 'finance_ledger_accounts', ACCOUNT_COLUMNS, [
    { column: 'code', ascending: true },
    { column: 'id', ascending: true },
  ]);
  const balances = new Map<string, Record<string, unknown>>();
  for (const b of await readAll(ctx, 'finance_ledger_balances', BALANCE_COLUMNS, [{ column: 'account_id', ascending: true }])) {
    balances.set(b.account_id as string, b);
  }
  return accounts.map((row) => {
    const balance = balances.get(row.id as string);
    return {
      ...(row as unknown as LedgerAccount),
      stands_for: standsFor(row),
      debit_total: Number(balance?.debit_total ?? 0),
      credit_total: Number(balance?.credit_total ?? 0),
      balance: Number(balance?.balance ?? 0),
    };
  });
}

/**
 * The expense category behind the account purchases post to, or null when there is none. One small read, for a
 * screen that needs only this and not every account's balance.
 */
export async function purchasesCategoryId(ctx: FinanceWriteContext): Promise<string | null> {
  const { data, error } = await ctx.client
    .from('finance_ledger_accounts')
    .select('category_id')
    .eq('org_id', ctx.orgId)
    .eq('default_for', 'purchases')
    .maybeSingle();
  if (error) throw error;
  return (data as { category_id: string | null } | null)?.category_id ?? null;
}

/**
 * Every line every posted document has left in the books, newest entry first. An entry's lines are kept
 * together, debits first, so no entry is split across two pages; the account, then the credit, are the last
 * tiebreaks so the pages never overlap.
 */
export async function listLedgerLines(ctx: FinanceWriteContext): Promise<LedgerLine[]> {
  const rows = await readAll(ctx, 'finance_ledger_lines', LINE_COLUMNS, [
    { column: 'entry_date', ascending: false },
    { column: 'entry_key', ascending: true },
    { column: 'debit', ascending: false },
    { column: 'account_id', ascending: true },
    // Two credit lines on one account in one entry would otherwise straddle a page boundary ambiguously.
    { column: 'credit', ascending: false },
  ]);
  return rows.map((row) => ({ ...(row as unknown as LedgerLine), debit: Number(row.debit), credit: Number(row.credit) }));
}

/** Every journal the caller may see, newest first. A member sees posted journals only (row-level security). */
export async function listJournals(ctx: FinanceWriteContext): Promise<JournalRow[]> {
  const rows = await readAll(ctx, 'finance_journals', JOURNAL_COLUMNS, [
    { column: 'journal_date', ascending: false },
    { column: 'id', ascending: true },
  ]);
  const reversed = new Set(rows.map((r) => r.reverses_journal_id as string | null).filter((id): id is string => id !== null));
  return rows.map((row) => ({ ...(row as unknown as JournalRow), reversed: reversed.has(row.id as string) }));
}

/** One journal with its lines in the order entered; null when it is not in this workspace or the id is not an id. */
export async function getJournal(ctx: FinanceWriteContext, id: string): Promise<JournalDetail | null> {
  // The database would throw on casting it; there is simply no such journal.
  if (!journalIdInput.safeParse({ id }).success) return null;
  const { data: journal, error } = await ctx.client
    .from('finance_journals')
    .select(JOURNAL_COLUMNS)
    .eq('org_id', ctx.orgId)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!journal) return null;
  const { data: lines, error: linesError } = await ctx.client
    .from('finance_journal_lines')
    .select('id,position,account_id,debit,credit,note')
    .eq('org_id', ctx.orgId)
    .eq('journal_id', id)
    .order('position', { ascending: true })
    .order('id', { ascending: true });
  if (linesError) throw linesError;
  const { data: reversal, error: reversalError } = await ctx.client
    .from('finance_journals')
    .select('id')
    .eq('org_id', ctx.orgId)
    .eq('reverses_journal_id', id)
    .limit(1)
    .maybeSingle();
  if (reversalError) throw reversalError;
  return {
    ...(journal as unknown as JournalRow),
    reversed: reversal !== null && reversal !== undefined,
    lines: ((lines ?? []) as unknown as Record<string, unknown>[]).map((l) => ({
      id: l.id as string,
      position: Number(l.position),
      account_id: l.account_id as string,
      debit: Number(l.debit),
      credit: Number(l.credit),
      note: (l.note as string | null) ?? null,
    })),
  };
}

/* ---- writes: accounts -------------------------------------------------- */

/** Adds an account of the workspace's own. The kind of account is fixed from then on. */
export async function createAccount(
  ctx: FinanceWriteContext,
  input: z.input<typeof createAccountInput>,
): Promise<FinResult<{ id: string }>> {
  const values = createAccountInput.parse(input);
  const { data, error } = await ctx.client
    .from('finance_ledger_accounts')
    .insert({ ...values, org_id: ctx.orgId })
    .select('id')
    .single();
  if (error || !data) return accountWriteFailed('createAccount', error);
  return { ok: true, data: { id: data.id } };
}

/** Changes an account's code and name. */
export async function updateAccount(
  ctx: FinanceWriteContext,
  input: z.input<typeof updateAccountInput>,
): Promise<FinResult<{ id: string }>> {
  const { id, code, name } = updateAccountInput.parse(input);
  const { data, error } = await ctx.client
    .from('finance_ledger_accounts')
    .update({ code, name, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('org_id', ctx.orgId)
    .select('id')
    .maybeSingle();
  if (error) return accountWriteFailed('updateAccount', error);
  if (!data) return { ok: false, error: M.accountGone };
  return { ok: true, data: { id: data.id } };
}

/** Archives an account, or brings it back. An archived account takes no new journal line. */
export async function setAccountActive(
  ctx: FinanceWriteContext,
  input: z.input<typeof setAccountActiveInput>,
): Promise<FinResult<{ id: string }>> {
  const { id, active } = setAccountActiveInput.parse(input);
  const { data, error } = await ctx.client
    .from('finance_ledger_accounts')
    .update({ active, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('org_id', ctx.orgId)
    .select('id')
    .maybeSingle();
  if (error) return accountWriteFailed('setAccountActive', error);
  if (!data) return { ok: false, error: M.accountGone };
  return { ok: true, data: { id: data.id } };
}

/** Deletes an account of the workspace's own that no journal line uses; any other is refused (archive it). */
export async function deleteAccount(
  ctx: FinanceWriteContext,
  input: z.input<typeof accountIdInput>,
): Promise<FinResult<{ id: string }>> {
  const { id } = accountIdInput.parse(input);
  const { data, error } = await ctx.client
    .from('finance_ledger_accounts')
    .delete()
    .eq('id', id)
    .eq('org_id', ctx.orgId)
    .select('id')
    .maybeSingle();
  if (error) return accountWriteFailed('deleteAccount', error);
  if (!data) return { ok: false, error: M.accountGone };
  return { ok: true, data: { id: data.id } };
}

/* ---- writes: journals -------------------------------------------------- */

/** Creates a draft journal, or replaces a draft's header and lines. */
export async function saveJournal(
  ctx: FinanceWriteContext,
  input: z.input<typeof saveJournalInput>,
): Promise<FinResult<{ id: string }>> {
  const { lines, ...journal } = saveJournalInput.parse(input);
  const { data, error } = await ctx.client.rpc('finance_save_journal', {
    target_org: ctx.orgId,
    journal,
    lines,
  });
  if (error || !data) return journalWriteFailed('saveJournal', error);
  return { ok: true, data: { id: data as string } };
}

/** Posts a draft: it gets its number, enters the books and can no longer be edited. */
export async function postJournal(
  ctx: FinanceWriteContext,
  input: z.input<typeof journalIdInput>,
): Promise<FinResult<{ id: string; journal_no: string }>> {
  const { id } = journalIdInput.parse(input);
  const { data, error } = await ctx.client.rpc('finance_post_journal', {
    target_org: ctx.orgId,
    target_journal: id,
  });
  if (error || !data) return journalWriteFailed('postJournal', error);
  return { ok: true, data: { id, journal_no: data as string } };
}

/**
 * Makes the draft that undoes a posted journal, dated `reversal_date`, and returns its id. The draft is
 * posted like any other. A journal has one reversal.
 */
export async function reverseJournal(
  ctx: FinanceWriteContext,
  input: z.input<typeof reverseJournalInput>,
): Promise<FinResult<{ id: string; reversal_id: string }>> {
  const { id, reversal_date } = reverseJournalInput.parse(input);
  const { data, error } = await ctx.client.rpc('finance_reverse_journal', {
    target_org: ctx.orgId,
    target_journal: id,
    reversal_date,
  });
  if (error || !data) return journalWriteFailed('reverseJournal', error, M.reversedOnce);
  return { ok: true, data: { id, reversal_id: data as string } };
}

/** Deletes a draft journal and its lines. A posted one is refused (reverse it). */
export async function deleteJournal(
  ctx: FinanceWriteContext,
  input: z.input<typeof journalIdInput>,
): Promise<FinResult<{ id: string }>> {
  const { id } = journalIdInput.parse(input);
  const { data, error } = await ctx.client
    .from('finance_journals')
    .delete()
    .eq('id', id)
    .eq('org_id', ctx.orgId)
    .select('id')
    .maybeSingle();
  if (error) return journalWriteFailed('deleteJournal', error);
  if (!data) return { ok: false, error: M.gone };
  return { ok: true, data: { id: data.id } };
}
