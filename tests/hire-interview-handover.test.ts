// tests/hire-interview-handover.test.ts
import { describe, expect, it, vi } from 'vitest';
import {
  NOT_AN_INTERVIEW_ID, calendarOfChange, interviewForEdit, interviewInvitation, interviewInvitationInput, type HireWriteContext, type InterviewChange,
} from '@/lib/hire/capabilities';

/**
 * What a recruiter hands to a candidate, made on the server at the press from
 * the interview AS STORED at that moment: the invitation text and the calendar
 * file. A row drawn on a screen can be minutes or hours old (a colleague
 * rescheduled, a page was restored by Back, a second tab); a text or a file
 * made from it would hand a candidate a time that is no longer true. Nothing
 * here reaches a database: the client is a stand-in that writes down what it
 * was asked.
 */

const ORG = '11111111-1111-4111-8111-111111111111';
const APP_ID = '44444444-4444-4444-8444-444444444444';
const IV_ID = '77777777-7777-4777-8777-777777777777';
/** 12:00 on 11 October 2026 in Kuala Lumpur. */
const NOW = new Date('2026-10-11T04:00:00Z');
/** 3:00 pm on Tuesday 20 October 2026 in Kuala Lumpur, as the database writes it. */
const ROW = {
  id: IV_ID, application_id: APP_ID, scheduled_at: '2026-10-20T07:00:00+00:00', duration_minutes: 60, kind: 'video',
  place: 'https://meet.example.com/abc', interviewer_name: 'Farah Lim', status: 'scheduled',
  created_at: '2026-10-11T04:00:00+00:00', updated_at: '2026-10-11T04:00:30+00:00',
  application: { stage: 'screening', outcome: 'active', candidate: { name: 'Aina Rahman' }, job: { title: 'Sales Executive' } },
};
const TEXT = [
  'Hi Aina Rahman,',
  '',
  'You are invited to an interview for the Sales Executive role at Rimba Ventures.',
  '',
  'Date: Tuesday, 20 October 2026',
  'Time: 3:00 pm to 4:00 pm, Kuala Lumpur time (GMT+8)',
  'Length: 1 hour',
  'Type: Video call',
  'Link: https://meet.example.com/abc',
  'With: Farah Lim',
  '',
  'Please reply to confirm, or tell us if you need another time.',
].join('\n');
const NOT_FOUND = 'That interview could not be found. It may have been deleted with its application.';
const NOT_SCHEDULED = 'This interview is no longer scheduled. Mark it as scheduled again first.';
const PASSED = 'This interview\'s start has already passed, so there is no invitation or calendar file for it.';
const NOT_MADE = 'The invitation could not be made just now. Please try again.';

function fake(opts: { row?: unknown; error?: unknown; throws?: boolean; orgName?: string | null } = {}) {
  const reads: { table: string; columns: string; filters: Record<string, unknown> }[] = [];
  const writes: string[] = [];
  const client = {
    rpc: async (fn: string) => {
      writes.push(fn);
      return { data: 'ok', error: null };
    },
    from: (table: string) => {
      const entry = { table, columns: '', filters: {} as Record<string, unknown> };
      reads.push(entry);
      const chain = {
        select: (columns: string) => { entry.columns = columns; return chain; },
        eq: (key: string, value: unknown) => { entry.filters[key] = value; return chain; },
        maybeSingle: async () => {
          if (opts.throws) throw new Error('Aina Rahman read failed');
          return { data: opts.error ? null : 'row' in opts ? opts.row : ROW, error: opts.error ?? null };
        },
      };
      return chain;
    },
  };
  const ctx: HireWriteContext = { client: client as never, orgId: ORG, ...(opts.orgName === null ? {} : { orgName: opts.orgName ?? 'Rimba Ventures' }) };
  return { ctx, reads, writes };
}

describe('interviewInvitation', () => {
  it('takes an interview\'s id and nothing else', () => {
    expect(Object.keys(interviewInvitationInput.shape)).toEqual(['id']);
    expect(interviewInvitationInput.safeParse({ id: IV_ID }).success).toBe(true);
  });
  it('makes the text, the calendar file and its name from the stored row, read inside the workspace', async () => {
    const f = fake();
    const result = await interviewInvitation(f.ctx, { id: IV_ID }, NOW);
    expect(result).toEqual({
      ok: true,
      data: { text: TEXT, ics: expect.any(String), fileName: 'interview-aina-rahman-2026-10-20.ics' },
    });
    const ics = result.ok ? result.data.ics : '';
    // 3:00 pm in Kuala Lumpur is 07:00 UTC; the file says so in UTC, whatever zone this machine is in.
    expect(ics).toContain('DTSTART:20261020T070000Z\r\n');
    expect(ics).toContain('DTEND:20261020T080000Z\r\n');
    expect(ics).toContain(`UID:${IV_ID}@openkuasa.com\r\n`);
    // Thirty seconds between `created_at` and `updated_at`.
    expect(ics).toContain('SEQUENCE:30\r\n');
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    // One read, of that id in the session's workspace, and nothing written.
    expect(f.reads).toHaveLength(1);
    expect(f.reads[0].table).toBe('hire_interviews');
    expect(f.reads[0].filters).toEqual({ id: IV_ID, org_id: ORG });
    expect(f.writes).toEqual([]);
  });
  it('never reads the notes, and would not hand them over if the read returned them', async () => {
    const f = fake({ row: { ...ROW, notes: 'Asked for RM 4,500. Weak on Excel.' } });
    const result = await interviewInvitation(f.ctx, { id: IV_ID }, NOW);
    expect(f.reads[0].columns).not.toMatch(/notes/);
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/4,500|Excel/);
    expect(Object.keys(result.ok ? result.data : {})).toEqual(['text', 'ics', 'fileName']);
  });
  it('is made from what is stored, not from anything the caller sent', async () => {
    // The screen still shows 3:00 pm; a colleague has moved it to 4:00 pm on the 22nd.
    const moved = { ...ROW, scheduled_at: '2026-10-22T08:00:00+00:00', place: null, interviewer_name: null };
    const stale = {
      id: IV_ID, scheduled_at: '2026-10-20T07:00:00+00:00', date: '2026-10-20', time: '15:00', place: 'https://evil.example.com', candidate: 'Someone Else',
      workspace: 'Evil Co', orgName: 'Evil Co', org_id: 'evil',
    };
    const result = await interviewInvitation(fake({ row: moved }).ctx, stale as never, NOW);
    expect(result.ok).toBe(true);
    const said = JSON.stringify(result);
    expect(said).toContain('Date: Thursday, 22 October 2026');
    expect(said).toContain('Time: 4:00 pm to 5:00 pm');
    expect(said).toContain('DTSTART:20261022T080000Z');
    expect(result.ok && result.data.fileName).toBe('interview-aina-rahman-2026-10-22.ics');
    expect(said).not.toMatch(/evil|Evil Co|Someone Else|20261020|3:00 pm/);
    expect(said).not.toMatch(/Link:|With:/);
  });
  it('names the session\'s workspace, and leaves it out when there is none', async () => {
    const named = await interviewInvitation(fake({ orgName: 'Kedai Kopi Aina' }).ctx, { id: IV_ID }, NOW);
    expect(named.ok && named.data.text).toContain('role at Kedai Kopi Aina.');
    expect(named.ok && named.data.ics).toContain('SUMMARY:Interview for Sales Executive at Kedai Kopi Aina\r\n');
    const bare = await interviewInvitation(fake({ orgName: null }).ctx, { id: IV_ID }, NOW);
    expect(bare.ok && bare.data.text).toContain('for the Sales Executive role.');
  });
  it('never says the time is new: only the answer to a reschedule knows that', async () => {
    const result = await interviewInvitation(fake().ctx, { id: IV_ID }, NOW);
    expect(result.ok && result.data.text).not.toContain('has a new time');
  });

  describe('refuses, with a sentence and nothing to hand over', () => {
    it('an interview that is no longer there', async () => {
      expect(await interviewInvitation(fake({ row: null }).ctx, { id: IV_ID }, NOW)).toEqual({ ok: false, error: NOT_FOUND });
    });
    it('one that is no longer scheduled: cancelled, completed or a no-show', async () => {
      for (const status of ['cancelled', 'completed', 'no_show']) {
        expect(await interviewInvitation(fake({ row: { ...ROW, status } }).ctx, { id: IV_ID }, NOW), status).toEqual({ ok: false, error: NOT_SCHEDULED });
      }
      expect(await interviewInvitation(fake({ row: { ...ROW, status: 'something-new' } }).ctx, { id: IV_ID }, NOW)).toEqual({ ok: false, error: NOT_SCHEDULED });
    });
    it('one whose start has passed by the server\'s clock, saying only what its menu offers', async () => {
      const after = new Date('2026-10-20T07:00:00.001Z');
      expect(await interviewInvitation(fake().ctx, { id: IV_ID }, after)).toEqual({ ok: false, error: `${PASSED} Mark what happened, or reschedule it.` });
      for (const outcome of ['rejected', 'withdrawn']) {
        const closed = { ...ROW, application: { ...ROW.application, outcome } };
        expect(await interviewInvitation(fake({ row: closed }).ctx, { id: IV_ID }, after), outcome).toEqual({ ok: false, error: `${PASSED} Mark what happened.` });
      }
      // At the very start it is still ahead, as everywhere else.
      expect((await interviewInvitation(fake().ctx, { id: IV_ID }, new Date('2026-10-20T07:00:00Z'))).ok).toBe(true);
    });
    it('one the text or the file cannot be made for: no name, no job, no time to tell, an odd length', async () => {
      const odd = [
        { ...ROW, application: null },
        { ...ROW, application: { ...ROW.application, candidate: null } },
        { ...ROW, application: { ...ROW.application, job: { title: '' } } },
        { ...ROW, scheduled_at: '2026-10-20T15:00:00' },
        { ...ROW, scheduled_at: null },
        { ...ROW, duration_minutes: 0 },
        { ...ROW, duration_minutes: 22.5 },
        { ...ROW, updated_at: 'not a time' },
      ];
      for (const row of odd) {
        expect(await interviewInvitation(fake({ row }).ctx, { id: IV_ID }, NOW), JSON.stringify(row).slice(0, 80)).toEqual({ ok: false, error: NOT_MADE });
      }
    });
    it('a read that fails or throws, logging a code and never a name or an id', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(await interviewInvitation(fake({ error: { code: '57014', message: 'Aina Rahman timed out' } }).ctx, { id: IV_ID }, NOW)).toEqual({ ok: false, error: NOT_MADE });
      expect(await interviewInvitation(fake({ throws: true }).ctx, { id: IV_ID }, NOW)).toEqual({ ok: false, error: NOT_MADE });
      expect(spy).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(spy.mock.calls)).not.toMatch(/Aina|77777777/);
      spy.mockRestore();
    });
    it('anything that is not an interview\'s id, before the database is asked', async () => {
      for (const input of [undefined, null, 'nope', 7, {}, { id: 'not-an-id' }, { id: 12 }, { id: '' }]) {
        const f = fake();
        const result = await interviewInvitation(f.ctx, input as never, NOW);
        expect(result.ok, JSON.stringify(input)).toBe(false);
        expect(f.reads, JSON.stringify(input)).toEqual([]);
      }
      expect(await interviewInvitation(fake().ctx, { id: 'iv-1' }, NOW)).toEqual({ ok: false, error: NOT_AN_INTERVIEW_ID });
    });
  });
});

describe('the calendar file that goes with a saved change', () => {
  const change = (over: Partial<InterviewChange> = {}): InterviewChange => ({
    id: IV_ID, application_id: APP_ID, candidate: 'Aina Rahman', job: 'Sales Executive', application_stage: 'screening', application_outcome: 'active',
    scheduled_at: '2026-10-20T07:00:00+00:00', date: '2026-10-20', time: '15:00', duration_minutes: 60, kind: 'video', place: 'Level 3',
    interviewer_name: null, status: 'scheduled', created_at: '2026-10-11T04:00:00+00:00', updated_at: '2026-10-11T04:00:00+00:00',
    message: 'Scheduled.', invitation: TEXT, confirmed: true, ...over,
  });
  it('is made on the server from the row the change read back', () => {
    const file = calendarOfChange(change(), 'Rimba Ventures', NOW);
    expect(file?.fileName).toBe('interview-aina-rahman-2026-10-20.ics');
    expect(file?.ics).toContain('DTSTART:20261020T070000Z\r\n');
    expect(file?.ics).toContain(`UID:${IV_ID}@openkuasa.com\r\n`);
    expect(file?.ics).toContain('LOCATION:Level 3\r\n');
    expect(file?.ics).toContain('SUMMARY:Interview for Sales Executive at Rimba Ventures\r\n');
    expect(calendarOfChange(change(), undefined, NOW)?.ics).toContain('SUMMARY:Interview for Sales Executive\r\n');
  });
  it('is there only when there is an invitation: none for a row not read back, a status that is not scheduled, or a start that has passed', () => {
    expect(calendarOfChange(change({ invitation: null }), 'Rimba Ventures', NOW)).toBeNull();
    expect(calendarOfChange(change({ invitation: '' }), 'Rimba Ventures', NOW)).toBeNull();
    expect(calendarOfChange(change({ confirmed: false }), 'Rimba Ventures', NOW)).toBeNull();
    for (const status of ['cancelled', 'completed', 'no_show'] as const) expect(calendarOfChange(change({ status }), null, NOW), status).toBeNull();
    expect(calendarOfChange(change(), 'Rimba Ventures', new Date('2026-10-20T07:00:00.001Z'))).toBeNull();
    for (const missing of [
      { scheduled_at: null }, { duration_minutes: null }, { kind: null }, { created_at: null }, { updated_at: null },
      { scheduled_at: '2026-10-20T15:00:00' }, { updated_at: 'soon' }, { candidate: '' }, { job: '' },
    ]) {
      expect(calendarOfChange(change(missing), 'Rimba Ventures', NOW), JSON.stringify(missing)).toBeNull();
    }
  });
});

describe('interviewForEdit: the interview as it stands now, for a form whose own copy has gone stale', () => {
  const STORED = {
    id: IV_ID, scheduled_at: '2026-10-22T08:00:00+00:00', duration_minutes: 90, kind: 'onsite', place: 'Level 3, Menara Rimba',
    interviewer_name: null, notes: 'Second round.', status: 'scheduled', updated_at: '2026-10-11T04:05:00.123456+00:00',
  };
  const NOT_LOADED = 'The interview could not be loaded just now. Close this and open it again.';
  it('gives the stored values the form edits, the notes among them, and the time the row was last changed, as stored', async () => {
    const f = fake({ row: STORED });
    expect(await interviewForEdit(f.ctx, { id: IV_ID })).toEqual({ ok: true, data: STORED });
    expect(f.reads).toHaveLength(1);
    expect(f.reads[0]).toMatchObject({ table: 'hire_interviews', filters: { id: IV_ID, org_id: ORG } });
    expect(f.reads[0].columns).toBe('id,scheduled_at,duration_minutes,kind,place,interviewer_name,notes,status,updated_at');
    expect(f.writes).toEqual([]);
  });
  it('names each field: nothing else the read returned rides along', async () => {
    const result = await interviewForEdit(fake({ row: { ...STORED, org_id: ORG, application: { candidate: { email: 'aina@example.com' } } } }).ctx, { id: IV_ID });
    expect(Object.keys(result.ok ? result.data : {}).sort()).toEqual(Object.keys(STORED).sort());
    expect(JSON.stringify(result)).not.toContain('example.com');
  });
  it('refuses one that has gone, one that is no longer scheduled, a failed read and a made-up id', async () => {
    expect(await interviewForEdit(fake({ row: null }).ctx, { id: IV_ID })).toEqual({ ok: false, error: NOT_FOUND });
    for (const status of ['cancelled', 'completed', 'no_show']) {
      expect(await interviewForEdit(fake({ row: { ...STORED, status } }).ctx, { id: IV_ID }), status).toEqual({ ok: false, error: NOT_SCHEDULED });
    }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await interviewForEdit(fake({ error: { code: '57014' } }).ctx, { id: IV_ID })).toEqual({ ok: false, error: NOT_LOADED });
    expect(await interviewForEdit(fake({ throws: true }).ctx, { id: IV_ID })).toEqual({ ok: false, error: NOT_LOADED });
    expect(JSON.stringify(spy.mock.calls)).not.toMatch(/Aina|77777777/);
    spy.mockRestore();
    const f = fake();
    expect(await interviewForEdit(f.ctx, { id: 'iv-1' })).toEqual({ ok: false, error: NOT_AN_INTERVIEW_ID });
    expect(f.reads).toEqual([]);
  });
});
