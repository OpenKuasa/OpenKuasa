import { beforeEach, describe, expect, it, vi } from 'vitest';

const JOURNAL = '33333333-3333-4333-8333-333333333333';
const ACCOUNT = '22222222-2222-4222-8222-222222222222';
const CASH = '44444444-4444-4444-8444-444444444444';
const SALES = '55555555-5555-4555-8555-555555555555';

type Answer = { ok: true; data: unknown } | { ok: false; error: string };

const ctl = vi.hoisted(() => ({
  viewer: { userId: 'u1', orgId: 'org1', role: 'admin', isDemo: false } as {
    userId: string; orgId: string; role: string; isDemo: boolean;
  },
  /** Every data-layer call, in order: the function, the workspace it was given, and its input. */
  calls: [] as { fn: string; orgId: string; input: unknown }[],
  revalidated: [] as string[],
  /** What each data-layer function answers; a function with no entry succeeds. */
  answers: {} as Record<string, unknown>,
  /** What getJournal returns, or an Error for it to throw. */
  journal: null as unknown,
}));

vi.mock('@/lib/auth/viewer', () => ({ getViewer: async () => ctl.viewer }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({}) }));
vi.mock('next/cache', () => ({
  revalidatePath: (path: string) => {
    ctl.revalidated.push(path);
  },
}));

function recorder(fn: string, ok: unknown) {
  return async (ctx: { orgId: string }, input: unknown) => {
    ctl.calls.push({ fn, orgId: ctx.orgId, input });
    return ctl.answers[fn] ?? { ok: true, data: ok };
  };
}

vi.mock('@/lib/finance/ledger', async (orig) => {
  const actual = await orig<typeof import('@/lib/finance/ledger')>();
  const account = { id: '22222222-2222-4222-8222-222222222222' };
  const journal = { id: '33333333-3333-4333-8333-333333333333' };
  return {
    ...actual,
    createAccount: recorder('createAccount', account),
    updateAccount: recorder('updateAccount', account),
    setAccountActive: recorder('setAccountActive', account),
    deleteAccount: recorder('deleteAccount', account),
    saveJournal: recorder('saveJournal', journal),
    postJournal: recorder('postJournal', { ...journal, journal_no: 'JV-0007' }),
    reverseJournal: recorder('reverseJournal', { ...journal, reversal_id: '66666666-6666-4666-8666-666666666666' }),
    deleteJournal: recorder('deleteJournal', journal),
    getJournal: async (ctx: { orgId: string }, id: string) => {
      ctl.calls.push({ fn: 'getJournal', orgId: ctx.orgId, input: id });
      if (ctl.journal instanceof Error) throw ctl.journal;
      return ctl.journal;
    },
  };
});

const actions = await import('@/app/(app)/finance/actions');

const LEDGER = ['/finance/chart-of-accounts', '/finance/journals'];
const FORBIDDEN = { ok: false, error: 'You do not have permission to make changes here.' };
const NEEDS = { ok: false, error: 'Only an owner or admin can change accounts or journals.' };
const GONE = { ok: false, error: 'That journal no longer exists.' };
const LOCKED = {
  ok: false,
  error: 'That cannot be done to this journal as it now stands. It may have been posted since this page was loaded.',
};

const journal = {
  journal_date: '2026-10-12',
  description: 'Capital',
  lines: [
    { account_id: CASH, debit: 100, credit: 0 },
    { account_id: SALES, debit: 0, credit: 100 },
  ],
};
const account = { code: '1500', name: 'Equipment', type: 'asset' };

/** Every write action with an input its schema accepts and the data-layer function it must call. */
const writes: [string, (input: unknown) => Promise<Answer>, unknown, string][] = [
  ['createAccountAction', actions.createAccountAction, account, 'createAccount'],
  ['updateAccountAction', actions.updateAccountAction, { id: ACCOUNT, code: '1510', name: 'Plant' }, 'updateAccount'],
  ['setAccountActiveAction', actions.setAccountActiveAction, { id: ACCOUNT, active: false }, 'setAccountActive'],
  ['deleteAccountAction', actions.deleteAccountAction, { id: ACCOUNT }, 'deleteAccount'],
  ['saveJournalAction', actions.saveJournalAction, journal, 'saveJournal'],
  ['postJournalAction', actions.postJournalAction, { id: JOURNAL }, 'postJournal'],
  ['reverseJournalAction', actions.reverseJournalAction, { id: JOURNAL, reversal_date: '2026-10-20' }, 'reverseJournal'],
  ['deleteJournalAction', actions.deleteJournalAction, { id: JOURNAL }, 'deleteJournal'],
];

beforeEach(() => {
  ctl.viewer = { userId: 'u1', orgId: 'org1', role: 'admin', isDemo: false };
  ctl.calls = [];
  ctl.revalidated = [];
  ctl.answers = {};
  ctl.journal = null;
});

describe('who may write', () => {
  it('refuses a viewer and the demo workspace on every action, before anything is parsed, read or written', async () => {
    for (const viewer of [
      { userId: 'u1', orgId: 'org1', role: 'viewer', isDemo: false },
      { userId: 'u1', orgId: 'org1', role: 'owner', isDemo: true },
    ]) {
      ctl.viewer = viewer;
      for (const [name, action, input] of writes) {
        expect(await action(input), name).toEqual(FORBIDDEN);
        expect(await action(null), name).toEqual(FORBIDDEN);
      }
      expect(await actions.saveAndPostJournalAction(journal)).toEqual(FORBIDDEN);
      expect(await actions.saveAndPostJournalAction({ lines: [] })).toEqual(FORBIDDEN);
      expect(await actions.getJournalAction({ id: JOURNAL })).toEqual(FORBIDDEN);
      expect(await actions.getJournalAction({ id: 'nope' })).toEqual(FORBIDDEN);
    }
    expect(ctl.calls).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
  });

  it('refuses a member who may write but not sign off, in the ledger’s own words, before the input is read or anything is called', async () => {
    ctl.viewer = { userId: 'u1', orgId: 'org1', role: 'member', isDemo: false };
    for (const [name, action, input] of writes) {
      expect(await action(input), name).toEqual(NEEDS);
      expect(await action(null), name).toEqual(NEEDS);
    }
    expect(await actions.saveAndPostJournalAction(journal)).toEqual(NEEDS);
    expect(await actions.saveAndPostJournalAction(null)).toEqual(NEEDS);
    expect(await actions.getJournalAction({ id: JOURNAL })).toEqual(NEEDS);
    expect(ctl.calls).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
  });

  it('lets an owner and an admin do all of it', async () => {
    for (const role of ['owner', 'admin']) {
      ctl.viewer = { userId: 'u1', orgId: 'org1', role, isDemo: false };
      for (const [name, action, input] of writes) expect((await action(input)).ok, `${role} ${name}`).toBe(true);
    }
  });
});

describe('each write action', () => {
  it('calls its own data-layer function in the viewer’s workspace and refreshes the two ledger screens', async () => {
    for (const [name, action, input, fn] of writes) {
      ctl.calls = [];
      ctl.revalidated = [];
      expect((await action(input)).ok, name).toBe(true);
      expect(ctl.calls.map((c) => [c.fn, c.orgId]), name).toEqual([[fn, 'org1']]);
      expect(ctl.revalidated, name).toEqual(LEDGER);
    }
  });

  it('never takes the workspace from the input', async () => {
    await actions.createAccountAction({ ...account, org_id: 'someone-else' });
    await actions.saveJournalAction({ ...journal, org_id: 'someone-else', target_org: 'someone-else' });
    expect(ctl.calls.map((c) => c.orgId)).toEqual(['org1', 'org1']);
    expect(JSON.stringify(ctl.calls)).not.toContain('someone-else');
  });

  it('answers with the schema’s sentence, touching nothing, when the input is refused', async () => {
    expect(await actions.createAccountAction({ ...account, code: '' })).toEqual({ ok: false, error: 'Enter a code of 1 to 10 characters.' });
    expect(await actions.createAccountAction({ ...account, type: 'cash' })).toEqual({ ok: false, error: 'Choose what kind of account it is.' });
    expect(await actions.saveJournalAction({ ...journal, description: '' })).toEqual({ ok: false, error: 'Describe the journal.' });
    expect(await actions.saveJournalAction({ ...journal, lines: [] })).toEqual({ ok: false, error: 'Add at least two lines.' });
    expect(await actions.saveJournalAction({ ...journal, lines: [{ account_id: CASH, debit: 5, credit: 5 }] })).toEqual({
      ok: false, error: 'Each line needs a debit or a credit, not both.',
    });
    expect(await actions.reverseJournalAction({ id: JOURNAL, reversal_date: 'today' })).toEqual({ ok: false, error: 'Enter a valid date.' });
    for (const action of [actions.postJournalAction, actions.deleteJournalAction, actions.reverseJournalAction]) {
      expect(await action({ id: 'nope' })).toEqual(GONE);
    }
    for (const action of [actions.deleteAccountAction, actions.setAccountActiveAction, actions.updateAccountAction]) {
      expect(await action({ id: 'nope' })).toEqual({ ok: false, error: 'That account no longer exists.' });
    }
    expect(ctl.calls).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
  });

  it('hands the data layer the parsed input: text trimmed, amounts to the sen, empty notes as null', async () => {
    await actions.saveJournalAction({
      journal_date: '2026-10-12',
      description: '  Capital ',
      lines: [
        { account_id: CASH, debit: 10.005, credit: 0, note: ' ' },
        { account_id: SALES, debit: 0, credit: 10.01, note: ' owner ' },
      ],
    });
    expect(ctl.calls[0].input).toEqual({
      journal_date: '2026-10-12',
      description: 'Capital',
      lines: [
        { account_id: CASH, debit: 10.01, credit: 0, note: null },
        { account_id: SALES, debit: 0, credit: 10.01, note: 'owner' },
      ],
    });
  });

  it('refreshes both screens after a refusal too, so a journal someone else changed shows as it now is', async () => {
    ctl.answers.postJournal = LOCKED;
    expect(await actions.postJournalAction({ id: JOURNAL })).toEqual(LOCKED);
    expect(ctl.revalidated).toEqual(LEDGER);
  });
});

describe('saveAndPostJournalAction', () => {
  it('saves, then posts what it saved, and answers with the number', async () => {
    expect(await actions.saveAndPostJournalAction(journal)).toEqual({ ok: true, data: { id: JOURNAL, journal_no: 'JV-0007' } });
    expect(ctl.calls.map((c) => c.fn)).toEqual(['saveJournal', 'postJournal']);
    expect(ctl.calls[1].input).toEqual({ id: JOURNAL });
    expect(ctl.revalidated).toEqual(LEDGER);
  });

  it('does not post when the save is refused', async () => {
    ctl.answers.saveJournal = { ok: false, error: 'A journal needs at least two lines, each on an active account.' };
    expect(await actions.saveAndPostJournalAction(journal)).toEqual(ctl.answers.saveJournal);
    expect(ctl.calls.map((c) => c.fn)).toEqual(['saveJournal']);
    expect(ctl.revalidated).toEqual(LEDGER);
  });

  it('keeps the draft when posting is refused, and says which draft it is', async () => {
    ctl.answers.postJournal = { ok: false, error: 'Debits and credits must be equal before the journal is posted.' };
    expect(await actions.saveAndPostJournalAction(journal)).toEqual({
      ok: false, error: 'Debits and credits must be equal before the journal is posted.', draftId: JOURNAL,
    });
    expect(ctl.calls.map((c) => c.fn)).toEqual(['saveJournal', 'postJournal']);
  });

  it('answers with the schema’s sentence and saves nothing when the form is refused', async () => {
    expect(await actions.saveAndPostJournalAction({ ...journal, description: '' })).toEqual({ ok: false, error: 'Describe the journal.' });
    expect(ctl.calls).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
  });
});

describe('getJournalAction', () => {
  const found = { id: JOURNAL, status: 'draft', lines: [] };

  it('returns a draft, without refreshing anything', async () => {
    ctl.journal = found;
    expect(await actions.getJournalAction({ id: JOURNAL })).toEqual({ ok: true, data: found });
    expect(ctl.calls).toEqual([{ fn: 'getJournal', orgId: 'org1', input: JOURNAL }]);
    expect(ctl.revalidated).toEqual([]);
  });
  it('says the journal is gone, and refreshes the list, when it was deleted meanwhile', async () => {
    expect(await actions.getJournalAction({ id: JOURNAL })).toEqual(GONE);
    expect(ctl.revalidated).toEqual(LEDGER);
  });
  it('says it can no longer be done, and refreshes the list, when the journal has been posted', async () => {
    ctl.journal = { ...found, status: 'posted' };
    expect(await actions.getJournalAction({ id: JOURNAL })).toEqual(LOCKED);
    expect(ctl.revalidated).toEqual(LEDGER);
  });
  it('says the journal is gone for an id that is not an id, without reading', async () => {
    expect(await actions.getJournalAction({ id: 'nope' })).toEqual(GONE);
    expect(await actions.getJournalAction(undefined)).toEqual(GONE);
    expect(ctl.calls).toEqual([]);
  });
  it('answers with a sentence when the read fails, and logs the cause', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    ctl.journal = new Error('connection reset');
    expect(await actions.getJournalAction({ id: JOURNAL })).toEqual({ ok: false, error: 'That could not be loaded. Please try again.' });
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});
