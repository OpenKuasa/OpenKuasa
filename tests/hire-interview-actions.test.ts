import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The six actions behind the interview controls. The viewer, the database
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
vi.mock('@/lib/supabase/service', () => ({ serviceClient: () => { throw new Error('the service role is never used for an interview'); } }));
vi.mock('@/lib/hire/capabilities', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/hire/capabilities')>();
  const record = (fn: 'scheduleInterview' | 'recordPastInterview' | 'rescheduleInterview' | 'cancelInterview' | 'setInterviewOutcome' | 'reopenInterview' | 'interviewInvitation' | 'interviewForEdit') =>
    async (ctx: Ctx, input: unknown, ...rest: unknown[]) => {
      ctl.calls.push({ fn, ctx, input, rest });
      if (ctl.real) return (actual[fn] as unknown as (...args: unknown[]) => Promise<unknown>)(ctx, input, ...rest);
      return ctl.result;
    };
  return {
    ...actual,
    scheduleInterview: record('scheduleInterview'),
    recordPastInterview: record('recordPastInterview'),
    rescheduleInterview: record('rescheduleInterview'),
    cancelInterview: record('cancelInterview'),
    setInterviewOutcome: record('setInterviewOutcome'),
    reopenInterview: record('reopenInterview'),
    interviewInvitation: record('interviewInvitation'),
    interviewForEdit: record('interviewForEdit'),
  };
});

const {
  cancelInterviewAction, getInterviewForEditAction, getInterviewInvitationAction, recordPastInterviewAction, reopenInterviewAction, rescheduleInterviewAction, scheduleInterviewAction,
  setInterviewOutcomeAction,
} = await import('@/app/(app)/hire/actions');

const APP = '44444444-4444-4444-8444-444444444444';
const IV = '77777777-7777-4777-8777-777777777777';
const SEEN = '2026-10-12T02:15:00.123456+00:00';
const FORBIDDEN = { ok: false, error: 'You do not have permission to make changes here.' };
const EVERY_PATH = [
  '/hire/jobs', '/hire/careers-page', '/hire/assistant', '/hire/dashboard', '/hire/applications', '/hire/candidates',
  '/hire/interviews', '/hire/talent-pool',
];
const SAVED = {
  ok: true,
  data: {
    id: IV, application_id: APP, candidate: 'Aina Rahman', job: 'Sales Executive',
    message: 'Scheduled an interview with Aina Rahman for Tuesday, 20 October 2026, 3:00 pm. Nothing has been sent to them.',
    invitation: 'Hi Aina Rahman,', confirmed: true,
  },
};
const SCHEDULE = { application_id: APP, date: '2026-10-20', time: '15:00', duration_minutes: 60, kind: 'video' };

/** Each action as the screen calls it: its name among the capabilities, the call, and the input it hands on. */
const ACTIONS = [
  ['scheduleInterview', (input: unknown) => scheduleInterviewAction(input), SCHEDULE],
  ['recordPastInterview', (input: unknown) => recordPastInterviewAction(input), { ...SCHEDULE, date: '2026-10-06', outcome: 'completed' }],
  ['rescheduleInterview', (input: unknown) => rescheduleInterviewAction(input, SEEN), { id: IV, date: '2026-10-22', time: '11:00' }],
  ['cancelInterview', (input: unknown) => cancelInterviewAction(input), { id: IV }],
  ['setInterviewOutcome', (input: unknown) => setInterviewOutcomeAction(input), { id: IV, outcome: 'no_show' }],
  ['reopenInterview', (input: unknown) => reopenInterviewAction(input), { id: IV }],
] as const;

beforeEach(() => {
  ctl.viewer = { orgId: 'org1', orgName: 'Rimba Ventures', role: 'member', isDemo: false };
  ctl.revalidated = [];
  ctl.calls = [];
  ctl.result = SAVED;
  ctl.real = false;
  ctl.asked = [];
});

describe('who may change an interview', () => {
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
  it.each(['owner', 'admin', 'member'])('a %s reaches the capability with the session\'s own workspace and its name, whatever the input says', async (role) => {
    ctl.viewer = { orgId: 'org1', orgName: 'Rimba Ventures', role, isDemo: false };
    await scheduleInterviewAction({ ...SCHEDULE, org_id: 'evil', orgName: 'Evil Co' });
    expect(ctl.calls).toHaveLength(1);
    expect(ctl.calls[0].ctx.orgId).toBe('org1');
    // The name the invitation is written with: the session's, never the input's.
    expect(ctl.calls[0].ctx.orgName).toBe('Rimba Ventures');
    expect(ctl.calls[0].ctx.client).toMatchObject({ marker: 'session' });
  });
});

describe('the six change actions', () => {
  it.each(ACTIONS)('%s: hands the input on as it is, returns the result and revalidates every hiring screen', async (name, action, input) => {
    // The change as the capability answered it, with the calendar file the server makes beside it (none here: SAVED
    // is not a whole read-back row). Changed from the plan's `toBe(SAVED)` in the final-review fix pass.
    expect(await action(input)).toEqual({ ok: true, data: { ...SAVED.data, calendar: null } });
    expect(ctl.calls.map((c) => c.fn)).toEqual([name]);
    expect(ctl.calls[0].input).toBe(input);
    expect(ctl.revalidated).toEqual(EVERY_PATH);
    // The Interviews screen itself, the Dashboard (it counts interviews) and the Applications panel's list.
    expect(ctl.revalidated).toEqual(expect.arrayContaining(['/hire/interviews', '/hire/dashboard', '/hire/applications']));
  });
  it.each(ACTIONS)('%s: a refusal revalidates nothing', async (_name, action, input) => {
    ctl.result = { ok: false, error: 'This interview is no longer scheduled. Mark it as scheduled again first.' };
    expect(await action(input)).toBe(ctl.result);
    expect(ctl.revalidated).toEqual([]);
  });
  it.each(ACTIONS)('%s: a malformed input is refused by the capability\'s own check, before the database is asked anything', async (_name, action) => {
    ctl.real = true;
    for (const odd of [undefined, null, 'nope', 7, {}, { id: 'not-an-id' }, { application_id: 'not-an-id', date: 'tomorrow', time: '3pm', kind: 'lunch' }]) {
      const result = await action(odd);
      expect(result.ok, JSON.stringify(odd)).toBe(false);
    }
    expect(ctl.asked).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
  });
});

describe('rescheduleInterviewAction and the time the form was opened with', () => {
  const input = { id: IV, notes: 'Bring the portfolio.' };
  it('passes it to the capability as `seen`, after an empty `now`', async () => {
    await rescheduleInterviewAction(input, SEEN);
    expect(ctl.calls[0].rest).toEqual([undefined, SEEN]);
  });
  it('passes nothing when it is not a string, or is an empty one', async () => {
    for (const odd of [undefined, null, 42, true, {}, [SEEN], new Date(0), '']) {
      ctl.calls = [];
      await rescheduleInterviewAction(input, odd);
      expect(ctl.calls[0].rest[1], String(odd)).toBeUndefined();
    }
  });
  it('none of the other five passes a `seen` or a `now`', async () => {
    for (const [name, action, body] of ACTIONS) {
      if (name === 'rescheduleInterview') continue;
      ctl.calls = [];
      await action(body);
      expect(ctl.calls[0].rest, name).toEqual([]);
    }
  });
});

// Added in the final-review fix pass.
describe('the calendar file beside a saved change', () => {
  /** A change as the capability answers it after reading the row back: 3:00 pm on 20 October 2099 in Kuala Lumpur. */
  const WHOLE = {
    ok: true,
    data: {
      id: IV, application_id: APP, candidate: 'Aina Rahman', job: 'Sales Executive', application_stage: 'screening', application_outcome: 'active',
      scheduled_at: '2099-10-20T07:00:00+00:00', date: '2099-10-20', time: '15:00', duration_minutes: 60, kind: 'video', place: null,
      interviewer_name: null, status: 'scheduled', created_at: '2026-10-12T02:15:00+00:00', updated_at: '2026-10-12T02:15:00+00:00',
      message: 'Scheduled.', invitation: 'Hi Aina Rahman,', confirmed: true,
    },
  };
  it('is made on the server, from the row the change read back and the session\'s workspace name', async () => {
    ctl.result = WHOLE;
    const result = await scheduleInterviewAction({ ...SCHEDULE, orgName: 'Evil Co' }) as { ok: true; data: { calendar: { ics: string; fileName: string } | null } };
    expect(result.data).toMatchObject(WHOLE.data);
    expect(result.data.calendar?.fileName).toBe('interview-aina-rahman-2099-10-20.ics');
    expect(result.data.calendar?.ics).toContain('DTSTART:20991020T070000Z\r\n');
    expect(result.data.calendar?.ics).toContain(`UID:${IV}@openkuasa.com\r\n`);
    expect(result.data.calendar?.ics).toContain('SUMMARY:Interview for Sales Executive at Rimba Ventures\r\n');
    expect(JSON.stringify(result)).not.toContain('Evil Co');
  });
  it('is there exactly when the invitation is: none for a change with no invitation', async () => {
    for (const data of [{ ...WHOLE.data, invitation: null }, { ...WHOLE.data, status: 'cancelled' }, { ...WHOLE.data, confirmed: false }]) {
      ctl.result = { ok: true, data };
      const result = await cancelInterviewAction({ id: IV }) as { ok: true; data: { calendar: unknown } };
      expect(result.data.calendar).toBeNull();
    }
  });
});

describe('getInterviewInvitationAction: the invitation and the calendar file for a row, read at the press', () => {
  const HANDOVER = { ok: true, data: { text: 'Hi Aina Rahman,', ics: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n', fileName: 'interview-aina-rahman-2026-10-20.ics' } };
  it('a viewer and the demo workspace are refused before the capability or the database is reached', async () => {
    for (const viewer of [
      { orgId: 'org1', orgName: 'Rimba Ventures', role: 'viewer', isDemo: false },
      { orgId: 'org1', orgName: 'Rimba Ventures', role: 'owner', isDemo: true },
    ]) {
      ctl.viewer = viewer;
      expect(await getInterviewInvitationAction({ id: IV })).toEqual(FORBIDDEN);
    }
    expect(ctl.calls).toEqual([]);
    expect(ctl.asked).toEqual([]);
  });
  it.each(['owner', 'admin', 'member'])('a %s gets what the capability made, with the session\'s workspace and its name, and nothing is revalidated', async (role) => {
    ctl.viewer = { orgId: 'org1', orgName: 'Rimba Ventures', role, isDemo: false };
    ctl.result = HANDOVER;
    const input = { id: IV, org_id: 'evil', orgName: 'Evil Co' };
    expect(await getInterviewInvitationAction(input)).toBe(HANDOVER);
    expect(ctl.calls.map((c) => c.fn)).toEqual(['interviewInvitation']);
    expect(ctl.calls[0].input).toBe(input);
    expect(ctl.calls[0].ctx).toMatchObject({ orgId: 'org1', orgName: 'Rimba Ventures', client: { marker: 'session' } });
    // The server's own clock: none is passed in.
    expect(ctl.calls[0].rest).toEqual([]);
    // A read: no screen is fetched again because of it.
    expect(ctl.revalidated).toEqual([]);
  });
  it('a refusal goes back as it is', async () => {
    ctl.result = { ok: false, error: 'This interview is no longer scheduled. Mark it as scheduled again first.' };
    expect(await getInterviewInvitationAction({ id: IV })).toBe(ctl.result);
    expect(ctl.revalidated).toEqual([]);
  });
  it('a malformed input is refused by the capability\'s own check, before the database is asked anything', async () => {
    ctl.real = true;
    for (const odd of [undefined, null, 'nope', 7, {}, { id: 'not-an-id' }]) {
      const result = await getInterviewInvitationAction(odd);
      expect(result.ok, JSON.stringify(odd)).toBe(false);
    }
    expect(ctl.asked).toEqual([]);
  });
});

describe('getInterviewForEditAction: the interview as it stands now, for a form that was refused as stale', () => {
  const CURRENT = {
    ok: true,
    data: {
      id: IV, scheduled_at: '2026-10-22T08:00:00+00:00', duration_minutes: 90, kind: 'onsite', place: null, interviewer_name: null,
      notes: 'Second round.', status: 'scheduled', updated_at: SEEN,
    },
  };
  it('a viewer and the demo workspace are refused before anything is read: the notes are for those who may edit', async () => {
    for (const viewer of [
      { orgId: 'org1', orgName: 'Rimba Ventures', role: 'viewer', isDemo: false },
      { orgId: 'org1', orgName: 'Rimba Ventures', role: 'owner', isDemo: true },
    ]) {
      ctl.viewer = viewer;
      expect(await getInterviewForEditAction({ id: IV })).toEqual(FORBIDDEN);
    }
    expect(ctl.calls).toEqual([]);
    expect(ctl.asked).toEqual([]);
  });
  it('someone who may edit gets what the capability read, in the session\'s workspace, and nothing is revalidated', async () => {
    ctl.result = CURRENT;
    const input = { id: IV, org_id: 'evil' };
    expect(await getInterviewForEditAction(input)).toBe(CURRENT);
    expect(ctl.calls.map((c) => c.fn)).toEqual(['interviewForEdit']);
    expect(ctl.calls[0].input).toBe(input);
    expect(ctl.calls[0].ctx).toMatchObject({ orgId: 'org1', client: { marker: 'session' } });
    expect(ctl.revalidated).toEqual([]);
  });
  it('a malformed input is refused before the database is asked anything', async () => {
    ctl.real = true;
    for (const odd of [undefined, null, 'nope', {}, { id: 'not-an-id' }]) expect((await getInterviewForEditAction(odd)).ok, JSON.stringify(odd)).toBe(false);
    expect(ctl.asked).toEqual([]);
  });
});
