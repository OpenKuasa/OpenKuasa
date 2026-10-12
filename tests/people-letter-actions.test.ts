import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WRITE_FAILED } from '@/lib/people/capabilities';

type Reply = { ok: true; data: unknown } | { ok: false; error: string };

const ctl = vi.hoisted(() => ({
  viewer: { userId: 'u1', orgId: 'org1', role: 'owner', isDemo: false } as {
    userId: string;
    orgId: string;
    role: string;
    isDemo: boolean;
  },
  people: { employeeId: 'emp-own' as string | null, isHr: true, isDemo: false },
  client: { marker: 'the-signed-in-client' } as unknown,
  reply: null as null | Reply,
  ran: [] as { fn: string; orgId: string; client: unknown; input: unknown }[],
  revalidated: [] as string[],
  lookupFails: false,
  lookups: 0,
  clients: 0,
}));

vi.mock('@/lib/auth/viewer', () => ({ getViewer: async () => ctl.viewer }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => {
    ctl.clients += 1;
    return ctl.client;
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: (path: string) => ctl.revalidated.push(path) }));
vi.mock('@/lib/people/viewer', () => ({
  getPeopleViewer: async () => {
    ctl.lookups += 1;
    if (ctl.lookupFails) throw new Error('SECRET lookup failure');
    return ctl.people;
  },
}));

const record = (fn: string) => async (ctx: { orgId: string; client: unknown }, input?: unknown): Promise<Reply> => {
  ctl.ran.push({ fn, orgId: ctx.orgId, client: ctx.client, input });
  return ctl.reply ?? { ok: true, data: { id: 'x' } };
};
vi.mock('@/lib/people/letter-writes', async (orig) => {
  const actual = await orig<typeof import('@/lib/people/letter-writes')>();
  return {
    ...actual,
    saveLetter: record('saveLetter'),
    startLetterFromTemplate: record('startLetterFromTemplate'),
    issueLetter: record('issueLetter'),
    unissueLetter: record('unissueLetter'),
    deleteLetter: record('deleteLetter'),
    acknowledgeLetter: record('acknowledgeLetter'),
    saveLetterTemplate: record('saveLetterTemplate'),
    deleteLetterTemplate: record('deleteLetterTemplate'),
  };
});

const actions = await import('@/app/(app)/people/letter-actions');
const { PEOPLE_PATHS } = await import('@/lib/people/paths');

const EMP = '22222222-2222-4222-8222-222222222222';
const LETTER = '33333333-3333-4333-8333-333333333333';
const TEMPLATE = '44444444-4444-4444-8444-444444444444';
const DEMO_SENTENCE = 'The sample company is read-only. Sign up to try this with your own team.';
const FORBIDDEN_SENTENCE = 'Only owners and admins can do that.';
const NOT_LINKED_SENTENCE = "Your account isn't linked to an employee record yet.";

const asRole = (role: string) => {
  ctl.viewer = { ...ctl.viewer, role };
  ctl.people = { ...ctl.people, isHr: role === 'owner' || role === 'admin' };
};

beforeEach(() => {
  ctl.viewer = { userId: 'u1', orgId: 'org1', role: 'owner', isDemo: false };
  ctl.people = { employeeId: 'emp-own', isHr: true, isDemo: false };
  ctl.reply = null;
  ctl.ran = [];
  ctl.revalidated = [];
  ctl.lookupFails = false;
  ctl.lookups = 0;
  ctl.clients = 0;
});

const OWNER_ONLY: [string, string, (input: unknown) => Promise<unknown>, Record<string, unknown>][] = [
  ['saveLetterAction', 'saveLetter', actions.saveLetterAction, { employee_id: EMP, letter_type: 'offer', title: 'T', body: 'B' }],
  ['startLetterFromTemplateAction', 'startLetterFromTemplate', actions.startLetterFromTemplateAction, { employee_id: EMP, template_id: TEMPLATE }],
  ['issueLetterAction', 'issueLetter', actions.issueLetterAction, { letter_id: LETTER }],
  ['unissueLetterAction', 'unissueLetter', actions.unissueLetterAction, { letter_id: LETTER }],
  ['deleteLetterAction', 'deleteLetter', actions.deleteLetterAction, { letter_id: LETTER }],
  ['saveLetterTemplateAction', 'saveLetterTemplate', actions.saveLetterTemplateAction, { name: 'N', letter_type: 'other', title: 'T', body: 'B' }],
  ['deleteLetterTemplateAction', 'deleteLetterTemplate', actions.deleteLetterTemplateAction, { template_id: TEMPLATE }],
];

describe('owner and admin letter actions', () => {
  it.each(OWNER_ONLY)('%s runs for an owner and an admin with the session\'s workspace and client', async (_name, fn, action, input) => {
    for (const role of ['owner', 'admin']) {
      ctl.ran = [];
      asRole(role);
      expect(((await action(input)) as Reply).ok).toBe(true);
      expect(ctl.ran).toEqual([{ fn, orgId: 'org1', client: ctl.client, input }]);
    }
  });

  it.each(OWNER_ONLY)('%s refuses a member and a viewer before any lookup or read', async (_name, _fn, action, input) => {
    for (const role of ['member', 'viewer']) {
      asRole(role);
      ctl.clients = 0;
      ctl.lookups = 0;
      expect(await action(input)).toEqual({ ok: false, error: FORBIDDEN_SENTENCE });
      expect(ctl.clients).toBe(0);
      expect(ctl.lookups).toBe(0);
      expect(ctl.ran).toEqual([]);
    }
  });

  it.each(OWNER_ONLY)('%s refuses the demo, even for its admin, before any database call', async (_name, _fn, action, input) => {
    ctl.viewer = { ...ctl.viewer, isDemo: true };
    expect(await action(input)).toEqual({ ok: false, error: DEMO_SENTENCE });
    ctl.viewer = { ...ctl.viewer, isDemo: false };
    ctl.people = { ...ctl.people, isDemo: true };
    expect(await action(input)).toEqual({ ok: false, error: DEMO_SENTENCE });
    expect(ctl.ran).toEqual([]);
  });

  it.each(OWNER_ONLY)('%s answers a failed viewer lookup with one sentence that holds no detail', async (_name, _fn, action, input) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    ctl.lookupFails = true;
    expect(await action(input)).toEqual({ ok: false, error: WRITE_FAILED });
    expect(ctl.ran).toEqual([]);
  });

  it('refreshes the pages after a change and not after a refusal', async () => {
    await actions.issueLetterAction({ letter_id: LETTER });
    expect(ctl.revalidated).toEqual(PEOPLE_PATHS);
    ctl.revalidated = [];
    ctl.reply = { ok: false, error: 'nope' };
    await actions.issueLetterAction({ letter_id: LETTER });
    expect(ctl.revalidated).toEqual([]);
  });

  it('passes a refusal on as it came', async () => {
    ctl.reply = { ok: false, error: 'The letter still has a placeholder in it. Replace it before issuing.' };
    expect(await actions.issueLetterAction({ letter_id: LETTER })).toEqual(ctl.reply);
  });
});

describe('acknowledgeLetterAction (the employee\'s own)', () => {
  it('runs for a member, with the session\'s client, and no employee in what it sends', async () => {
    asRole('member');
    expect(((await actions.acknowledgeLetterAction({ letter_id: LETTER, employee_id: 'someone-else' })) as Reply).ok).toBe(true);
    expect(ctl.ran).toHaveLength(1);
    expect(ctl.ran[0]).toMatchObject({ fn: 'acknowledgeLetter', client: ctl.client, orgId: 'org1' });
    expect(JSON.stringify(ctl.ran[0].input)).not.toContain('someone-else');
    expect(ctl.ran[0].input).toEqual({ letter_id: LETTER });
  });
  it('refuses an account with no employee record before any write', async () => {
    ctl.people = { ...ctl.people, employeeId: null };
    expect(await actions.acknowledgeLetterAction({ letter_id: LETTER })).toEqual({ ok: false, error: NOT_LINKED_SENTENCE });
    expect(ctl.ran).toEqual([]);
  });
  it('refuses a demo visitor before any database call', async () => {
    ctl.viewer = { ...ctl.viewer, isDemo: true };
    expect(await actions.acknowledgeLetterAction({ letter_id: LETTER })).toEqual({ ok: false, error: DEMO_SENTENCE });
    expect(ctl.ran).toEqual([]);
    expect(ctl.clients).toBe(0);
  });
});

describe('the module', () => {
  it('exports exactly the letter actions, none of which is a way to acknowledge for someone else', () => {
    expect(Object.keys(actions).sort()).toEqual(
      [
        'acknowledgeLetterAction',
        'deleteLetterAction',
        'deleteLetterTemplateAction',
        'issueLetterAction',
        'saveLetterAction',
        'saveLetterTemplateAction',
        'startLetterFromTemplateAction',
        'unissueLetterAction',
      ].sort(),
    );
  });
});
