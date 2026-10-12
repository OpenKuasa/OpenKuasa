import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeSupabase } from './setup/fake-supabase';

type Role = 'owner' | 'admin' | 'member' | 'viewer';
type Reply = { ok: true; data: unknown } | { ok: false; error: string };

const ctl = vi.hoisted(() => ({
  viewer: { userId: 'u1', orgId: 'org1', role: 'owner', isDemo: false } as {
    userId: string;
    orgId: string;
    role: string;
    isDemo: boolean;
  },
  people: { employeeId: 'emp-own', isHr: true, isDemo: false } as {
    employeeId: string | null;
    isHr: boolean;
    isDemo: boolean;
    managesTeam?: boolean;
  },
  lookupFails: false,
  client: {} as unknown,
  // What every mocked write answers; null means a plain success.
  reply: null as null | { ok: false; error: string },
  cancelData: { id: 'r1', status: 'cancelled', removed_receipt_path: 'u9/file.pdf' as string | null },
  ran: [] as { fn: string; orgId: string; input: unknown }[],
  revalidated: [] as string[],
  removed: [] as string[],
  removeFails: false,
  rpcs: [] as { fn: string; args: unknown }[],
  rpcReply: { data: true, error: null } as { data: unknown; error: unknown },
  rpcThrows: false,
  claims: [] as { id: string; receipt_path: string | null }[],
  claimsFail: false,
  signed: [] as { bucket: string; path: string; seconds: number }[],
  signReply: { data: { signedUrl: 'https://signed.example/r' }, error: null } as {
    data: { signedUrl: string } | null;
    error: { message: string } | null;
  },
}));

vi.mock('@/lib/auth/viewer', () => ({ getViewer: async () => ctl.viewer }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ctl.client }));
vi.mock('next/cache', () => ({ revalidatePath: (path: string) => ctl.revalidated.push(path) }));
vi.mock('@/lib/people/viewer', () => ({
  getPeopleViewer: async () => {
    if (ctl.lookupFails) throw new Error('lookup failed');
    return ctl.people;
  },
}));
vi.mock('@/lib/people/supabase', () => ({
  createSupabasePeopleData: () => ({
    listClaims: async () => {
      if (ctl.claimsFail) throw new Error('read failed');
      return ctl.claims;
    },
  }),
}));
vi.mock('@/lib/people/receipts-server', async (orig) => ({
  // The path-shape guard stays real; only the deletion is recorded.
  ...(await orig<typeof import('@/lib/people/receipts-server')>()),
  removeReceipt: async (path: string) => {
    ctl.removed.push(path);
    // The real one never throws; a failed removal must change nothing the caller sees.
    if (ctl.removeFails) return;
  },
}));
vi.mock('@/lib/people/pay-requests', async (orig) => {
  const actual = await orig<typeof import('@/lib/people/pay-requests')>();
  const record = (fn: string, data: unknown = { id: 'r1', status: 'pending' }) => async (ctx: { orgId: string }, input: unknown): Promise<Reply> => {
    ctl.ran.push({ fn, orgId: ctx.orgId, input });
    return ctl.reply ?? { ok: true, data };
  };
  return {
    ...actual,
    submitClaim: record('submitClaim'),
    cancelClaim: async (ctx: { orgId: string }, input: unknown): Promise<Reply> => {
      ctl.ran.push({ fn: 'cancelClaim', orgId: ctx.orgId, input });
      return ctl.reply ?? { ok: true, data: ctl.cancelData };
    },
    decideClaim: record('decideClaim'),
    markClaimPaid: record('markClaimPaid'),
    unmarkClaimPaid: record('unmarkClaimPaid'),
    previewOvertime: record('previewOvertime'),
    submitOvertime: record('submitOvertime'),
    cancelOvertime: record('cancelOvertime'),
    decideOvertime: record('decideOvertime'),
  };
});

const actions = await import('@/app/(app)/people/pay-actions');
const { PEOPLE_PATHS } = await import('@/lib/people/paths');

const EMP = '22222222-2222-4222-8222-222222222222';
const REQ = '33333333-3333-4333-8333-333333333333';
const FORBIDDEN = { ok: false, error: 'Only owners and admins can do that.' };
const DEMO = { ok: false, error: 'The sample company is read-only. Sign up to try claims and overtime with your own team.' };
const NOT_LINKED = { ok: false, error: "Your account isn't linked to an employee record yet." };
const NOT_FOUND = { ok: false, error: 'That request was not found.' };
const CLAIM = { category: 'travel', amount_cents: 8500, claim_date: '2026-10-09' };
const OT = { work_date: '2026-10-09', hours: 2 };

type Action = (input: unknown) => Promise<unknown>;
const OWN: [string, Action, unknown][] = [
  ['submitOwnClaimAction', actions.submitOwnClaimAction, CLAIM],
  ['submitOwnOvertimeAction', actions.submitOwnOvertimeAction, OT],
  ['previewOwnOvertimeAction', actions.previewOwnOvertimeAction, OT],
];
const ANYONE: [string, Action, unknown][] = [
  ['cancelClaimAction', actions.cancelClaimAction, { id: REQ }],
  ['cancelOvertimeAction', actions.cancelOvertimeAction, { id: REQ }],
  ['claimReceiptUrlAction', actions.claimReceiptUrlAction, { id: REQ }],
];
const ADMIN: [string, Action, unknown][] = [
  ['submitClaimForAction', actions.submitClaimForAction, { employee_id: EMP, ...CLAIM }],
  ['submitOvertimeForAction', actions.submitOvertimeForAction, { employee_id: EMP, ...OT }],
  ['previewOvertimeForAction', actions.previewOvertimeForAction, { employee_id: EMP, ...OT }],
  ['decideClaimAction', actions.decideClaimAction, { id: REQ, approve: true }],
  ['decideOvertimeAction', actions.decideOvertimeAction, { id: REQ, approve: false, note: 'No' }],
  ['markClaimPaidAction', actions.markClaimPaidAction, { id: REQ, paid_on: '2026-10-10' }],
  ['unmarkClaimPaidAction', actions.unmarkClaimPaidAction, { id: REQ }],
];

const DECIDE: [string, Action, unknown, string][] = [
  ['decideClaimAction', actions.decideClaimAction, { id: REQ, approve: true }, 'decideClaim'],
  ['decideOvertimeAction', actions.decideOvertimeAction, { id: REQ, approve: false, note: 'No' }, 'decideOvertime'],
];
const DECIDE_FORBIDDEN = { ok: false, error: "Only owners, admins and the employee's manager can do that." };

const as = (role: Role, linked = true) => {
  ctl.viewer = { userId: 'u1', orgId: 'org1', role, isDemo: false };
  ctl.people = { employeeId: linked ? 'emp-own' : null, isHr: role === 'owner' || role === 'admin', isDemo: false };
};

beforeEach(() => {
  as('owner');
  ctl.client = {
    ...(fakeSupabase().client as object),
    storage: {
      from: (bucket: string) => ({
        createSignedUrl: async (path: string, seconds: number) => {
          ctl.signed.push({ bucket, path, seconds });
          return ctl.signReply;
        },
      }),
    },
    rpc: async (fn: string, args: unknown) => {
      ctl.rpcs.push({ fn, args });
      if (ctl.rpcThrows) throw new Error('network');
      return ctl.rpcReply;
    },
  };
  ctl.reply = null;
  ctl.cancelData = { id: 'r1', status: 'cancelled', removed_receipt_path: 'u9/file.pdf' };
  ctl.ran = [];
  ctl.revalidated = [];
  ctl.removed = [];
  ctl.removeFails = false;
  ctl.rpcs = [];
  ctl.rpcReply = { data: true, error: null };
  ctl.rpcThrows = false;
  ctl.claims = [{ id: REQ, receipt_path: 'u9/file.pdf' }];
  ctl.claimsFail = false;
  ctl.signed = [];
  ctl.signReply = { data: { signedUrl: 'https://signed.example/r' }, error: null };
});

describe("a member's own claims and overtime", () => {
  it.each(['owner', 'admin', 'member', 'viewer'] as Role[])('are open to a linked %s', async (role) => {
    as(role);
    for (const [name, action, input] of OWN) expect(((await action(input)) as { ok: boolean }).ok, name).toBe(true);
    expect(ctl.ran.map((r) => r.fn)).toEqual(['submitClaim', 'submitOvertime', 'previewOvertime']);
  });

  it('use the linked employee from the server and the workspace from the session', async () => {
    as('member');
    await actions.submitOwnClaimAction({ ...CLAIM, description: 'Taxi' });
    expect(ctl.ran).toEqual([{ fn: 'submitClaim', orgId: 'org1', input: { ...CLAIM, description: 'Taxi', employee_id: 'emp-own' } }]);
  });

  it('ignore an employee_id smuggled into the input, on every own action', async () => {
    as('member');
    for (const [, action, input] of OWN) await action({ ...(input as object), employee_id: EMP, org_id: 'someone-else' });
    expect(ctl.ran.map((r) => (r.input as { employee_id: string }).employee_id)).toEqual(['emp-own', 'emp-own', 'emp-own']);
    expect(ctl.ran.every((r) => r.orgId === 'org1')).toBe(true);
  });

  it('still take the linked employee when the input is not an object', async () => {
    as('member');
    await actions.submitOwnOvertimeAction('nonsense');
    expect(ctl.ran[0].input).toEqual({ employee_id: 'emp-own' });
  });

  it('refuse an account with no linked employee, before any call', async () => {
    as('admin', false);
    for (const [name, action, input] of OWN) expect(await action(input), name).toEqual(NOT_LINKED);
    expect(ctl.ran).toEqual([]);
  });

  it('refuse a demo visitor, and a real account whose workspace is the demo, before any call', async () => {
    ctl.viewer.isDemo = true;
    for (const [name, action, input] of OWN) expect(await action(input), name).toEqual(DEMO);
    ctl.viewer.isDemo = false;
    ctl.people = { employeeId: 'emp-own', isHr: false, isDemo: true };
    for (const [name, action, input] of OWN) expect(await action(input), name).toEqual(DEMO);
    expect(ctl.ran).toEqual([]);
  });

  it('refresh the Lekiu pages after a submit, and not after a preview', async () => {
    await actions.previewOwnOvertimeAction(OT);
    expect(ctl.revalidated).toEqual([]);
    await actions.submitOwnClaimAction(CLAIM);
    expect(ctl.revalidated).toEqual(PEOPLE_PATHS);
  });

  it('refresh nothing when the change is refused', async () => {
    ctl.reply = { ok: false, error: 'No.' };
    expect(await actions.submitOwnClaimAction(CLAIM)).toEqual({ ok: false, error: 'No.' });
    expect(await actions.submitOwnOvertimeAction(OT)).toEqual({ ok: false, error: 'No.' });
    expect(ctl.revalidated).toEqual([]);
  });
});

describe('discardReceiptAction', () => {
  const ME_ID = '55555555-5555-4555-8555-555555555555';
  const OTHER_ID = '66666666-6666-4666-8666-666666666666';
  const FILE = `${ME_ID}/44444444-4444-4444-8444-444444444444.pdf`;

  beforeEach(() => {
    ctl.viewer.userId = ME_ID;
  });

  it('removes an unused file in the caller\'s own folder, and reports nothing about it', async () => {
    const result = await actions.discardReceiptAction({ path: FILE });
    expect(result).toEqual({ ok: true });
    expect(ctl.removed).toEqual([FILE]);
  });

  it.each(['owner', 'admin', 'member', 'viewer'] as Role[])('is open to a %s', async (role) => {
    as(role);
    ctl.viewer.userId = ME_ID;
    await actions.discardReceiptAction({ path: FILE });
    expect(ctl.removed).toEqual([FILE]);
  });

  it('refuses a demo visitor and a real account in the demo', async () => {
    ctl.viewer.isDemo = true;
    await actions.discardReceiptAction({ path: FILE });
    ctl.viewer.isDemo = false;
    ctl.people = { employeeId: null, isHr: true, isDemo: true };
    await actions.discardReceiptAction({ path: FILE });
    expect(ctl.removed).toEqual([]);
  });

  it('never removes a file in someone else\'s folder', async () => {
    await actions.discardReceiptAction({ path: `${OTHER_ID}/44444444-4444-4444-8444-444444444444.pdf` });
    expect(ctl.removed).toEqual([]);
  });

  it.each([
    ['no path', {}],
    ['a path of the wrong shape', { path: `${ME_ID}/../x.pdf` }],
    ['an extra segment', { path: `${ME_ID}/a/44444444-4444-4444-8444-444444444444.pdf` }],
    ['an unknown extension', { path: `${ME_ID}/44444444-4444-4444-8444-444444444444.exe` }],
    ['a path that is not text', { path: 5 }],
    ['not an object', 'nonsense'],
  ])('removes nothing for %s', async (_label, input) => {
    await actions.discardReceiptAction(input);
    expect(ctl.removed).toEqual([]);
    expect(ctl.rpcs).toEqual([]);
  });

  it('asks the database with the signed-in user\'s client, passing only the path, and removes the file on a true', async () => {
    await actions.discardReceiptAction({ path: FILE });
    expect(ctl.rpcs).toEqual([{ fn: 'hr_release_receipt', args: { p_path: FILE } }]);
    expect(ctl.removed).toEqual([FILE]);
  });

  it.each([
    ['false', { data: false, error: null }],
    ['null', { data: null, error: null }],
    ['the text "true"', { data: 'true', error: null }],
    ['1', { data: 1, error: null }],
    ['an error', { data: true, error: { message: `boom ${FILE}` } }],
  ])('keeps the file when the database answers %s', async (_label, reply) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    ctl.rpcReply = reply;
    expect(await actions.discardReceiptAction({ path: FILE })).toEqual({ ok: false });
    expect(ctl.removed).toEqual([]);
  });

  it('keeps the file when the call throws, and logs neither the path nor the user id', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    ctl.rpcThrows = true;
    expect(await actions.discardReceiptAction({ path: FILE })).toEqual({ ok: false });
    expect(ctl.removed).toEqual([]);
    expect(JSON.stringify(log.mock.calls)).not.toContain(ME_ID);
  });

  it('does not read any claims to decide', async () => {
    ctl.claimsFail = true;
    await actions.discardReceiptAction({ path: FILE });
    expect(ctl.removed).toEqual([FILE]);
  });
});

describe('cancelling', () => {
  it.each(['owner', 'admin', 'member', 'viewer'] as Role[])('is open to a %s, and the database decides whose', async (role) => {
    as(role);
    expect(((await actions.cancelClaimAction({ id: REQ })) as { ok: boolean }).ok).toBe(true);
    expect(((await actions.cancelOvertimeAction({ id: REQ })) as { ok: boolean }).ok).toBe(true);
    expect(ctl.ran.map((r) => r.fn)).toEqual(['cancelClaim', 'cancelOvertime']);
  });

  it("needs no linked record, so an admin without one can cancel anyone's", async () => {
    as('admin', false);
    expect(((await actions.cancelClaimAction({ id: REQ })) as { ok: boolean }).ok).toBe(true);
  });

  it('refuses a demo visitor and a real account in the demo, before any call', async () => {
    ctl.viewer.isDemo = true;
    expect(await actions.cancelClaimAction({ id: REQ })).toEqual(DEMO);
    expect(await actions.cancelOvertimeAction({ id: REQ })).toEqual(DEMO);
    ctl.viewer.isDemo = false;
    ctl.people = { employeeId: null, isHr: true, isDemo: true };
    expect(await actions.cancelClaimAction({ id: REQ })).toEqual(DEMO);
    expect(ctl.ran).toEqual([]);
    expect(ctl.removed).toEqual([]);
  });

  it('removes the receipt file the cancel let go of, and answers without its path', async () => {
    expect(await actions.cancelClaimAction({ id: REQ })).toEqual({ ok: true, data: { id: 'r1', status: 'cancelled' } });
    expect(ctl.removed).toEqual(['u9/file.pdf']);
    expect(ctl.revalidated).toEqual(PEOPLE_PATHS);
  });

  it('removes nothing when the claim had no file', async () => {
    ctl.cancelData = { id: 'r1', status: 'cancelled', removed_receipt_path: null };
    expect((await actions.cancelClaimAction({ id: REQ })) as { ok: boolean }).toMatchObject({ ok: true });
    expect(ctl.removed).toEqual([]);
  });

  it('still succeeds, and refreshes, when removing the file fails', async () => {
    ctl.removeFails = true;
    expect(await actions.cancelClaimAction({ id: REQ })).toEqual({ ok: true, data: { id: 'r1', status: 'cancelled' } });
    expect(ctl.removed).toEqual(['u9/file.pdf']);
    expect(ctl.revalidated).toEqual(PEOPLE_PATHS);
  });

  it('removes nothing and refreshes nothing when the cancel is refused', async () => {
    ctl.reply = { ok: false, error: 'That request has already been decided or cancelled.' };
    expect(await actions.cancelClaimAction({ id: REQ })).toEqual(ctl.reply);
    expect(ctl.removed).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
  });

  it('refreshes after overtime is cancelled, and only on success', async () => {
    await actions.cancelOvertimeAction({ id: REQ });
    expect(ctl.revalidated).toEqual(PEOPLE_PATHS);
    ctl.revalidated = [];
    ctl.reply = { ok: false, error: 'No.' };
    await actions.cancelOvertimeAction({ id: REQ });
    expect(ctl.revalidated).toEqual([]);
  });
});

describe('owner and admin actions', () => {
  it.each(['owner', 'admin'] as Role[])('are open to an %s, in their own workspace', async (role) => {
    as(role);
    for (const [name, action, input] of ADMIN) expect(((await action(input)) as { ok: boolean }).ok, name).toBe(true);
    expect(ctl.ran.map((r) => r.fn)).toEqual([
      'submitClaim', 'submitOvertime', 'previewOvertime', 'decideClaim', 'decideOvertime', 'markClaimPaid', 'unmarkClaimPaid',
    ]);
    expect(ctl.ran.every((r) => r.orgId === 'org1')).toBe(true);
    expect(ctl.ran[0].input).toEqual({ employee_id: EMP, ...CLAIM });
  });

  it.each(['member', 'viewer'] as Role[])('refuse a %s on every one before anything runs', async (role) => {
    as(role);
    for (const [name, action, input] of ADMIN) {
      // The two decide actions are open to a manager, so they refuse with their own sentence.
      expect(await action(input), name).toEqual(DECIDE.some(([n]) => n === name) ? DECIDE_FORBIDDEN : FORBIDDEN);
    }
    expect(ctl.ran).toEqual([]);
  });

  it('refuse a demo visitor on every one, even a demo "owner"', async () => {
    ctl.viewer.isDemo = true;
    for (const [name, action, input] of ADMIN) expect(await action(input), name).toEqual(DEMO);
    ctl.viewer.role = 'viewer';
    for (const [name, action, input] of ADMIN) expect(await action(input), name).toEqual(DEMO);
    expect(ctl.ran).toEqual([]);
  });

  it('refuse a real account whose current workspace is the demo, before any call', async () => {
    ctl.people = { employeeId: 'emp-own', isHr: true, isDemo: true };
    for (const [name, action, input] of ADMIN) expect(await action(input), name).toEqual(DEMO);
    expect(ctl.ran).toEqual([]);
  });

  describe('the decide actions, open to a manager', () => {
    const asManager = () => {
      as('member');
      ctl.people = { employeeId: 'emp-own', isHr: false, isDemo: false, managesTeam: true };
    };

    it.each(DECIDE)('%s: a member who manages a team gets through, once, with the input', async (_name, action, input, fn) => {
      asManager();
      expect(((await action(input)) as { ok: boolean }).ok).toBe(true);
      expect(ctl.ran).toEqual([{ fn, orgId: 'org1', input }]);
    });

    it.each(DECIDE)('%s: a member with no team is refused before anything runs', async (_name, action, input) => {
      as('member');
      expect(await action(input)).toEqual(DECIDE_FORBIDDEN);
      expect(ctl.ran).toEqual([]);
    });

    it.each(DECIDE)('%s: an owner and an admin go through, as today', async (_name, action, input) => {
      for (const role of ['owner', 'admin'] as Role[]) {
        as(role);
        expect(((await action(input)) as { ok: boolean }).ok).toBe(true);
      }
      expect(ctl.ran).toHaveLength(2);
    });

    it.each(DECIDE)('%s: the demo account is refused before the viewer is looked up', async (_name, action, input) => {
      asManager();
      ctl.viewer.isDemo = true;
      expect(await action(input)).toEqual(DEMO);
      expect(ctl.ran).toEqual([]);
    });

    it.each(DECIDE)('%s: a manager in a workspace that is the demo is refused', async (_name, action, input) => {
      asManager();
      ctl.people = { ...ctl.people, isDemo: true };
      expect(await action(input)).toEqual(DEMO);
      expect(ctl.ran).toEqual([]);
    });

    it.each(DECIDE)('%s: a failed viewer lookup is a plain failure and runs nothing', async (_name, action, input) => {
      asManager();
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      ctl.lookupFails = true;
      try {
        expect(await action(input)).toEqual({ ok: false, error: 'That change could not be saved. Please try again.' });
      } finally {
        ctl.lookupFails = false;
        spy.mockRestore();
      }
      expect(ctl.ran).toEqual([]);
    });

    it.each(DECIDE)("%s: the database's own refusal reaches the manager unchanged", async (_name, action, input) => {
      asManager();
      ctl.reply = { ok: false, error: 'That request was not found.' };
      expect(await action(input)).toEqual(NOT_FOUND);
    });

    it('keeps every other admin action admin-only for a manager', async () => {
      asManager();
      for (const [name, action, input] of ADMIN) {
        if (DECIDE.some(([n]) => n === name)) continue;
        expect(await action(input), name).toEqual(FORBIDDEN);
      }
      expect(ctl.ran).toEqual([]);
    });
  });

  it('refresh the Lekiu pages after a change, not after a preview or when refused', async () => {
    await actions.previewOvertimeForAction({ employee_id: EMP, ...OT });
    expect(ctl.revalidated).toEqual([]);
    ctl.reply = { ok: false, error: 'No.' };
    await actions.markClaimPaidAction({ id: REQ, paid_on: '2026-10-10' });
    expect(ctl.revalidated).toEqual([]);
    ctl.reply = null;
    await actions.markClaimPaidAction({ id: REQ, paid_on: '2026-10-10' });
    await actions.unmarkClaimPaidAction({ id: REQ });
    expect(ctl.revalidated).toEqual([...PEOPLE_PATHS, ...PEOPLE_PATHS]);
  });
});

describe('claimReceiptUrlAction', () => {
  it.each(['owner', 'member', 'viewer'] as Role[])('gives a %s a 60-second link for a claim the provider returns', async (role) => {
    as(role);
    expect(await actions.claimReceiptUrlAction({ id: REQ })).toEqual({ ok: true, data: { url: 'https://signed.example/r' } });
    expect(ctl.signed).toEqual([{ bucket: 'hr-receipts', path: 'u9/file.pdf', seconds: 60 }]);
  });

  it('refuses a claim the provider does not return, without asking storage for anything', async () => {
    ctl.claims = [{ id: 'someone-elses', receipt_path: 'u2/theirs.pdf' }];
    expect(await actions.claimReceiptUrlAction({ id: REQ })).toEqual(NOT_FOUND);
    expect(ctl.signed).toEqual([]);
  });

  it('refuses a claim with no file, such as a sample claim that is only ticked', async () => {
    ctl.claims = [{ id: REQ, receipt_path: null }];
    expect(await actions.claimReceiptUrlAction({ id: REQ })).toEqual(NOT_FOUND);
    expect(ctl.signed).toEqual([]);
  });

  it('refuses an id that is not a uuid, without reading', async () => {
    expect(await actions.claimReceiptUrlAction({ id: 'nope' })).toEqual(NOT_FOUND);
    expect(await actions.claimReceiptUrlAction('nonsense')).toEqual(NOT_FOUND);
    expect(ctl.signed).toEqual([]);
  });

  it('refuses a demo visitor', async () => {
    ctl.viewer.isDemo = true;
    expect(await actions.claimReceiptUrlAction({ id: REQ })).toEqual(DEMO);
    expect(ctl.signed).toEqual([]);
  });

  it('answers in words, and refreshes nothing, when the claims cannot be read', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    ctl.claimsFail = true;
    expect(await actions.claimReceiptUrlAction({ id: REQ })).toEqual({
      ok: false,
      error: 'That change could not be saved. Please try again.',
    });
    expect(log.mock.calls).toEqual([['[people/pay-actions] could not read the claim:', 'Error']]);
    expect(ctl.revalidated).toEqual([]);
    log.mockRestore();
  });

  it('answers in words, logging neither the path nor the storage message, when the link cannot be made', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    ctl.signReply = { data: null, error: { message: 'Object not found: u9/file.pdf' } };
    expect(await actions.claimReceiptUrlAction({ id: REQ })).toEqual({
      ok: false,
      error: 'The receipt could not be opened. Please try again.',
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain('u9');
    log.mockRestore();
  });
});

describe('actions every caller can reach', () => {
  it('are listed, so a new one is looked at here', () => {
    expect(ANYONE.map(([name]) => name)).toEqual(['cancelClaimAction', 'cancelOvertimeAction', 'claimReceiptUrlAction']);
  });
});
