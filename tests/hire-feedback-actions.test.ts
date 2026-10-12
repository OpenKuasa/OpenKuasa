// tests/hire-feedback-actions.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The three actions behind the feedback controls. The viewer, the database
 * client and the capabilities are replaced: nothing here reaches a database.
 * With `ctl.real` set, a call goes on to the real capability, whose own input
 * check must refuse before the client is asked for anything.
 */

type Ctx = { orgId: string; orgName?: string; client: unknown };

const ctl = vi.hoisted(() => ({
  viewer: { orgId: 'org1', orgName: 'Rimba Ventures', role: 'member', isDemo: false } as { orgId: string; orgName: string; role: string; isDemo: boolean },
  revalidated: [] as string[],
  calls: [] as { fn: string; ctx: { orgId: string; orgName?: string; client: unknown }; input: unknown; rest: unknown[] }[],
  result: null as unknown,
  real: false,
  asked: [] as string[],
}));

vi.mock('next/cache', () => ({ revalidatePath: (path: string) => { ctl.revalidated.push(path); } }));
vi.mock('@/lib/auth/viewer', () => ({ getViewer: async () => ctl.viewer }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    marker: 'session',
    rpc: (fn: string) => {
      ctl.asked.push(`rpc:${fn}`);
      throw new Error('no database in this test');
    },
    from: (table: string) => {
      ctl.asked.push(`from:${table}`);
      throw new Error('no database in this test');
    },
  }),
}));
vi.mock('@/lib/supabase/service', () => ({ serviceClient: () => { throw new Error('the service role is never used for feedback'); } }));
vi.mock('@/lib/hire/capabilities', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/hire/capabilities')>();
  const record = (fn: 'saveInterviewFeedback' | 'clearInterviewFeedback' | 'interviewFeedbackForEdit') =>
    async (ctx: Ctx, input: unknown, ...rest: unknown[]) => {
      ctl.calls.push({ fn, ctx, input, rest });
      if (ctl.real) return (actual[fn] as unknown as (...args: unknown[]) => Promise<unknown>)(ctx, input, ...rest);
      return ctl.result;
    };
  return {
    ...actual,
    saveInterviewFeedback: record('saveInterviewFeedback'),
    clearInterviewFeedback: record('clearInterviewFeedback'),
    interviewFeedbackForEdit: record('interviewFeedbackForEdit'),
  };
});

const { clearInterviewFeedbackAction, getInterviewFeedbackAction, saveInterviewFeedbackAction } = await import('@/app/(app)/hire/actions');

const IV = '77777777-7777-4777-8777-777777777777';
const SEEN = '2026-10-21T02:05:40.123456+00:00';
const FORBIDDEN = { ok: false, error: 'You do not have permission to make changes here.' };
const EVERY_PATH = [
  '/hire/jobs', '/hire/careers-page', '/hire/assistant', '/hire/dashboard', '/hire/applications', '/hire/candidates',
  '/hire/interviews', '/hire/talent-pool',
];
const SAVED = {
  ok: true,
  data: {
    id: IV, candidate: 'Aina Rahman', job: 'Sales Executive', status: 'completed', scheduled_at: null,
    feedback: { rating: 4, recommendation: 'advance', comments: null, recorded_at: SEEN }, replaced: false, marked_completed: false,
    message: 'Saved feedback on the interview with Aina Rahman: 4 out of 5, advance.', confirmed: true,
  },
};
const SAVE = { id: IV, rating: 4, recommendation: 'advance' };

/** Each action as the screen calls it: its name among the capabilities, the call, and the input it hands on. */
const ACTIONS = [
  ['saveInterviewFeedback', (input: unknown) => saveInterviewFeedbackAction(input, SEEN), SAVE],
  ['clearInterviewFeedback', (input: unknown) => clearInterviewFeedbackAction(input), { id: IV }],
  ['interviewFeedbackForEdit', (input: unknown) => getInterviewFeedbackAction(input), { id: IV }],
] as const;
const CHANGES = ACTIONS.slice(0, 2);

beforeEach(() => {
  ctl.viewer = { orgId: 'org1', orgName: 'Rimba Ventures', role: 'member', isDemo: false };
  ctl.revalidated = [];
  ctl.calls = [];
  ctl.result = SAVED;
  ctl.real = false;
  ctl.asked = [];
});

describe('who may change or load feedback', () => {
  it.each(ACTIONS)('%s: a viewer and the demo workspace are refused before the capability or the database is reached', async (_name, action, input) => {
    for (const viewer of [
      { orgId: 'org1', orgName: 'Rimba Ventures', role: 'viewer', isDemo: false },
      { orgId: 'org1', orgName: 'Rimba Ventures', role: 'owner', isDemo: true },
    ]) {
      ctl.viewer = viewer;
      expect(await action(input)).toEqual(FORBIDDEN);
    }
    expect(ctl.calls).toEqual([]);
    expect(ctl.asked).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
  });
  it.each(ACTIONS)('%s: an owner, an admin and a member reach the capability, in the session\'s own workspace', async (name, action, input) => {
    for (const role of ['owner', 'admin', 'member']) {
      ctl.calls = [];
      ctl.viewer = { orgId: 'org1', orgName: 'Rimba Ventures', role, isDemo: false };
      await action(input);
      expect(ctl.calls.map((call) => call.fn), role).toEqual([name]);
      expect(ctl.calls[0].ctx.orgId, role).toBe('org1');
      expect(ctl.calls[0].input, role).toEqual(input);
    }
  });
});

describe('what the actions hand on and fetch again', () => {
  it.each(CHANGES)('%s: a saved change revalidates every screen that shows interviews, and answers what the capability answered', async (_name, action, input) => {
    expect(await action(input)).toEqual(SAVED);
    expect([...ctl.revalidated].sort()).toEqual([...EVERY_PATH].sort());
  });
  it.each(CHANGES)('%s: a refusal revalidates nothing and is handed on as it is', async (_name, action, input) => {
    ctl.result = { ok: false, error: 'This interview already has feedback. Open it to edit it.' };
    expect(await action(input)).toEqual(ctl.result);
    expect(ctl.revalidated).toEqual([]);
  });
  it('the version the edit form was opened on goes to the capability exactly as it arrived; anything but a non-empty string is not passed on', async () => {
    await saveInterviewFeedbackAction(SAVE, SEEN);
    expect(ctl.calls[0].rest).toEqual([SEEN]);
    for (const seen of [undefined, null, '', 7, { at: SEEN }]) {
      ctl.calls = [];
      await saveInterviewFeedbackAction(SAVE, seen);
      expect(ctl.calls[0].rest, JSON.stringify(seen)).toEqual([undefined]);
    }
  });
  it('loading the current feedback changes nothing, so nothing is fetched again', async () => {
    ctl.result = { ok: true, data: { id: IV, status: 'completed', feedback: null } };
    expect(await getInterviewFeedbackAction({ id: IV })).toEqual(ctl.result);
    expect(ctl.revalidated).toEqual([]);
  });
});

describe('malformed input, through the real capability', () => {
  it.each(ACTIONS)('%s: refused by the capability\'s own check, before the database is asked for anything', async (_name, action) => {
    ctl.real = true;
    for (const input of [null, undefined, 'x', {}, { id: 'interview-7', rating: 4, recommendation: 'advance' }]) {
      const result = (await action(input)) as { ok: boolean };
      expect(result.ok, JSON.stringify(input)).toBe(false);
    }
    expect(ctl.asked).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
  });
  it('a rating outside 1 to 5 and a recommendation outside the three never reach the database', async () => {
    ctl.real = true;
    expect(await saveInterviewFeedbackAction({ ...SAVE, rating: 9 }, null)).toEqual({ ok: false, error: 'Choose a rating from 1 to 5.' });
    expect(await saveInterviewFeedbackAction({ ...SAVE, recommendation: 'maybe' }, null)).toEqual({ ok: false, error: 'Choose a recommendation.' });
    expect(ctl.asked).toEqual([]);
  });
});
