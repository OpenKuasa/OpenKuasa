// tests/mcp-dispatch.test.ts
import { tool, type Tool } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { guardDeletions, notLookedUp, ONE_DELETION, type DeletionCheck, type DeletionGate } from '@/lib/ai/hire-deletions';
import { guardInterviewChanges, LINK_NOT_GIVEN } from '@/lib/ai/hire-interview-gate';
import { changeHeading } from '@/lib/chat/change-rows';
import { CONFIRM_INVALID, FAILED, UNKNOWN_CHANGE, UNKNOWN_READ, runChange, runRead } from '@/lib/mcp/dispatch';
import type { Operation, Operations } from '@/lib/mcp/operations';
import { memoryTranscriptStore, type TranscriptStore } from '@/lib/mcp/transcript';
import type { HeldCv } from '@/lib/ai/hire-tools';

const APP = '44444444-4444-4444-8444-444444444481';
const DEAL = '55555555-5555-4555-8555-555555555501';
const LINK = 'https://meet.example/x';
const CALLER = { credentialId: 'cred1', userId: 'user1' };
const OTHER = { credentialId: 'cred2', userId: 'user1' };
const OTHER_PERSON = { credentialId: 'cred1', userId: 'user2' };

type Gates = Record<string, 'user-approval' | DeletionGate>;

/** Fake tools that record their calls. One set per test, shared by every build of the operations. */
function fakeTools() {
  const calls: Array<{ name: string; input: unknown; options: Record<string, unknown> }> = [];
  const shelf: HeldCv[] = [];
  const make = (name: string, schema: z.ZodType, result: (input: unknown) => unknown): Tool =>
    tool({
      description: name,
      inputSchema: schema,
      execute: async (input: unknown, options: unknown) => {
        calls.push({ name, input, options: options as Record<string, unknown> });
        return result(input);
      },
    } as never) as Tool;
  const reads: Record<string, Tool> = {
    listCandidates: make('listCandidates', z.object({ q: z.string().optional() }), () => ({
      total: 2,
      candidates: [{ id: 'c1', name: 'Aisyah Lim' }, { id: 'c2', name: 'Farid Osman' }],
    })),
    listApplications: make('listApplications', z.object({}), () => ({
      total: 1,
      applications: [{ id: APP, candidate: 'Aina Rahman', job: 'Sales Executive', stage: 'screening', outcome: 'active' }],
    })),
    listDeals: make('listDeals', z.object({}), () => ({
      total: 1,
      deals: [{ id: DEAL, name: 'Annual plan', contact_name: 'Tan Wei Ming' }],
    })),
    readCandidateCv: make('readCandidateCv', z.object({ applicationId: z.string() }), (input) => {
      shelf.push({ toolCallId: 'x', applicationId: (input as { applicationId: string }).applicationId, bytes: new Uint8Array([37, 80]), candidate: 'Aina Rahman', job: 'Sales Executive' });
      return { ok: true, candidate: 'Aina Rahman', job: 'Sales Executive' };
    }),
  };
  const writes: Record<string, Tool> = {
    deleteCandidate: make('deleteCandidate', z.object({ id: z.string().min(1) }), () => ({ ok: true })),
    scheduleInterview: make(
      'scheduleInterview',
      z.object({ application_id: z.string(), date: z.string(), time: z.string(), kind: z.string(), place: z.string().optional() }),
      () => ({ ok: true }),
    ),
    createDeal: make('createDeal', z.object({ title: z.string(), contactId: z.string(), stageId: z.string() }), (input) => ({
      ok: true,
      data: { id: DEAL, name: (input as { title: string }).title },
    })),
    deleteDeal: make('deleteDeal', z.object({ id: z.string() }), () => ({ ok: true })),
    updateDeal: make('updateDeal', z.object({ id: z.string(), tag: z.string().optional() }), () => ({ ok: true })),
    throwing: make('throwing', z.object({}), () => {
      throw new Error('relation "secret_table" does not exist at /srv/app.ts:12');
    }),
  };
  return { calls, shelf, reads, writes };
}

type Fakes = ReturnType<typeof fakeTools>;

/** The operations as the endpoint builds them: once per request, so the gates' own counts start at zero. */
function opsFor(f: Fakes, gates: (base: Gates) => Gates | undefined = (base) => guardDeletions(base)): Operations {
  const byName = new Map<string, Operation>();
  for (const [kind, set] of [['read', f.reads], ['write', f.writes]] as const) {
    for (const [name, t] of Object.entries(set)) {
      byName.set(name, { name, product: 'hire', kind, description: name, inputSchema: {}, tool: t });
    }
  }
  const base: Gates = Object.fromEntries(Object.keys(f.writes).map((n) => [n, 'user-approval' as const]));
  return { byName, gates: gates(base), products: [], cvShelf: f.shelf };
}

const writeCalls = (f: Fakes) => f.calls.filter((c) => c.name in f.writes);

afterEach(() => {
  vi.useRealTimers();
});

describe('runChange', () => {
  it('refuses a change on an id no read returned', async () => {
    const f = fakeTools();
    const store = memoryTranscriptStore();
    const out = await runChange(opsFor(f), store, CALLER, 'deleteCandidate', { id: 'c9' });
    expect(out).toEqual({ ok: false, error: notLookedUp('candidate', 'c9') });
    expect(writeCalls(f)).toHaveLength(0);
  });

  it('runs a change after the id was read', async () => {
    const f = fakeTools();
    const store = memoryTranscriptStore();
    const read = await runRead(opsFor(f), store, CALLER, 'listCandidates', {});
    expect(read.ok).toBe(true);
    expect(JSON.stringify((read as { result: unknown }).result)).toContain('c1');
    const out = await runChange(opsFor(f), store, CALLER, 'deleteCandidate', { id: 'c1' });
    expect(out.ok).toBe(true);
    expect(writeCalls(f)).toHaveLength(1);
    const done = out as { summary?: { heading: string; rows: Array<{ to: string }> } };
    expect(done.summary?.heading).toBe(changeHeading('deleteCandidate'));
    // The row is named from what the read returned.
    expect(done.summary?.rows[0]?.to).toBe('Aisyah Lim');
  });

  it('a second deletion after the first ran is a new turn, not refused as one a turn', async () => {
    const f = fakeTools();
    const store = memoryTranscriptStore();
    await runRead(opsFor(f), store, CALLER, 'listCandidates', {});
    expect((await runChange(opsFor(f), store, CALLER, 'deleteCandidate', { id: 'c1' })).ok).toBe(true);
    expect((await runChange(opsFor(f), store, CALLER, 'deleteCandidate', { id: 'c2' })).ok).toBe(true);
    expect(writeCalls(f)).toHaveLength(2);
  });

  it('a note needs a second call with the token', async () => {
    const f = fakeTools();
    const store = memoryTranscriptStore();
    const seen: Array<{ note: string | null } | null> = [];
    const { cardShown } = await import('@/lib/ai/hire-deletions');
    const gate: DeletionGate = (_input, { toolCallId, messages }) => {
      seen.push(cardShown(messages, toolCallId));
      return { type: 'user-approval', reason: 'N' };
    };
    const gates = (base: Gates) => ({ ...base, deleteCandidate: gate });
    const first = await runChange(opsFor(f, gates), store, CALLER, 'deleteCandidate', { id: 'c1' });
    expect(first).toMatchObject({ ok: false, needsConfirm: true, note: 'N' });
    expect(writeCalls(f)).toHaveLength(0);
    const token = (first as { confirm: string }).confirm;
    const second = await runChange(opsFor(f, gates), store, CALLER, 'deleteCandidate', { id: 'c1' }, token);
    expect(second.ok).toBe(true);
    expect(writeCalls(f)).toHaveLength(1);
    expect(seen).toEqual([null, { note: 'N' }]);
  });

  it('a note through the real deletion gate: propose, then confirm', async () => {
    const f = fakeTools();
    const store = memoryTranscriptStore();
    const check: DeletionCheck = async () => ({ ok: true, note: 'More than one candidate is called Aisyah Lim. This one: a@x.', namesakes: [] });
    const gates = (base: Gates) => guardDeletions(base, check);
    await runRead(opsFor(f, gates), store, CALLER, 'listCandidates', {});
    const first = await runChange(opsFor(f, gates), store, CALLER, 'deleteCandidate', { id: 'c1' });
    expect(first).toMatchObject({ ok: false, needsConfirm: true });
    const second = await runChange(opsFor(f, gates), store, CALLER, 'deleteCandidate', { id: 'c1' }, (first as { confirm: string }).confirm);
    expect(second.ok).toBe(true);
    expect(writeCalls(f)).toHaveLength(1);
  });

  it('a changed note on confirm asks again with the new note', async () => {
    const f = fakeTools();
    const store = memoryTranscriptStore();
    let note = 'N1';
    const gates = (base: Gates) => ({ ...base, deleteCandidate: (() => ({ type: 'user-approval', reason: note })) as DeletionGate });
    const first = await runChange(opsFor(f, gates), store, CALLER, 'deleteCandidate', { id: 'c1' });
    note = 'N2';
    const second = await runChange(opsFor(f, gates), store, CALLER, 'deleteCandidate', { id: 'c1' }, (first as { confirm: string }).confirm);
    expect(second).toMatchObject({ ok: false, needsConfirm: true, note: 'N2' });
    expect(writeCalls(f)).toHaveLength(0);
    // The new note's token then runs it, once.
    const third = await runChange(opsFor(f, gates), store, CALLER, 'deleteCandidate', { id: 'c1' }, (second as { confirm: string }).confirm);
    expect(third.ok).toBe(true);
    expect(writeCalls(f)).toHaveLength(1);
  });

  it('confirm token is single-use and bound to args and credential', async () => {
    vi.useFakeTimers();
    const f = fakeTools();
    const store = memoryTranscriptStore();
    const gates = (base: Gates) => ({ ...base, deleteCandidate: (() => ({ type: 'user-approval', reason: 'N' })) as DeletionGate });
    const ask = async (caller = CALLER, args: unknown = { id: 'c1' }) =>
      (await runChange(opsFor(f, gates), store, caller, 'deleteCandidate', args)) as { confirm: string };

    // Used once, then reused.
    const t1 = (await ask()).confirm;
    expect((await runChange(opsFor(f, gates), store, CALLER, 'deleteCandidate', { id: 'c1' }, t1)).ok).toBe(true);
    const reused = await runChange(opsFor(f, gates), store, CALLER, 'deleteCandidate', { id: 'c1' }, t1);
    expect(reused).toEqual({ ok: false, error: CONFIRM_INVALID });
    expect(reused).not.toHaveProperty('needsConfirm');
    const ranOnce = writeCalls(f).length;
    expect(ranOnce).toBe(1);

    // Other arguments.
    const t2 = (await ask()).confirm;
    expect(await runChange(opsFor(f, gates), store, CALLER, 'deleteCandidate', { id: 'c2' }, t2)).toEqual({ ok: false, error: CONFIRM_INVALID });
    // Other credential.
    const t3 = (await ask()).confirm;
    expect(await runChange(opsFor(f, gates), store, OTHER, 'deleteCandidate', { id: 'c1' }, t3)).toEqual({ ok: false, error: CONFIRM_INVALID });
    // Same credential, another person.
    const t4 = (await ask()).confirm;
    expect(await runChange(opsFor(f, gates), store, OTHER_PERSON, 'deleteCandidate', { id: 'c1' }, t4)).toEqual({ ok: false, error: CONFIRM_INVALID });
    // Other operation.
    const t5 = (await ask()).confirm;
    expect(await runChange(opsFor(f, gates), store, CALLER, 'scheduleInterview', { application_id: APP, date: 'd', time: 't', kind: 'video' }, t5)).toEqual({ ok: false, error: CONFIRM_INVALID });
    // Expired.
    const t6 = (await ask()).confirm;
    vi.advanceTimersByTime(10 * 60 * 1000 + 1);
    expect(await runChange(opsFor(f, gates), store, CALLER, 'deleteCandidate', { id: 'c1' }, t6)).toEqual({ ok: false, error: CONFIRM_INVALID });
    // An unknown token.
    expect(await runChange(opsFor(f, gates), store, CALLER, 'deleteCandidate', { id: 'c1' }, 'made-up')).toEqual({ ok: false, error: CONFIRM_INVALID });

    expect(writeCalls(f)).toHaveLength(ranOnce);
  });

  it('an empty reason is no note: it runs without a confirm', async () => {
    // Mirrors cardShown, which treats only a truthy string as a note, so the two never disagree.
    const f = fakeTools();
    const store = memoryTranscriptStore();
    const gates = (base: Gates) => ({ ...base, deleteCandidate: (() => ({ type: 'user-approval', reason: '' })) as DeletionGate });
    const out = await runChange(opsFor(f, gates), store, CALLER, 'deleteCandidate', { id: 'c1' });
    expect(out.ok).toBe(true);
    expect(out).not.toHaveProperty('needsConfirm');
    expect(writeCalls(f)).toHaveLength(1);
  });

  it('read names are refused by runChange and write names by runRead', async () => {
    const f = fakeTools();
    const store = memoryTranscriptStore();
    expect(await runChange(opsFor(f), store, CALLER, 'listCandidates', {})).toEqual({ ok: false, error: UNKNOWN_CHANGE });
    expect(await runRead(opsFor(f), store, CALLER, 'deleteCandidate', { id: 'c1' })).toEqual({ ok: false, error: UNKNOWN_READ });
    expect(await runRead(opsFor(f), store, CALLER, 'nope', {})).toEqual({ ok: false, error: UNKNOWN_READ });
    expect(await runChange(opsFor(f), store, CALLER, 'nope', {})).toEqual({ ok: false, error: UNKNOWN_CHANGE });
    expect(f.calls).toHaveLength(0);
  });

  it('invalid args are refused before any gate or execute', async () => {
    const f = fakeTools();
    const store = memoryTranscriptStore();
    const gate = vi.fn<DeletionGate>(() => 'user-approval');
    const out = await runChange(opsFor(f, (base) => ({ ...base, deleteCandidate: gate })), store, CALLER, 'deleteCandidate', { id: 42 });
    expect(out).toMatchObject({ ok: false, error: expect.any(String) });
    expect(gate).not.toHaveBeenCalled();
    expect(f.calls).toHaveLength(0);
    expect(await runRead(opsFor(f), store, CALLER, 'readCandidateCv', {})).toMatchObject({ ok: false, error: expect.any(String) });
    expect(f.calls).toHaveLength(0);
  });

  it('bound reaches execute options', async () => {
    const f = fakeTools();
    const store = memoryTranscriptStore();
    const gates = (base: Gates) => ({ ...base, deleteCandidate: (() => ({ type: 'user-approval', reason: 'N', bound: { version: 7 } })) as DeletionGate });
    const first = await runChange(opsFor(f, gates), store, CALLER, 'deleteCandidate', { id: 'c1' });
    await runChange(opsFor(f, gates), store, CALLER, 'deleteCandidate', { id: 'c1' }, (first as { confirm: string }).confirm);
    expect(writeCalls(f)[0]?.options.bound).toEqual({ version: 7 });
    // The gate's decision object never reaches execute as anything but `bound`.
    expect(writeCalls(f)[0]?.input).toEqual({ id: 'c1' });
  });

  it('a meeting link in the arguments counts as given by the person', async () => {
    const f = fakeTools();
    const store = memoryTranscriptStore();
    const gates = (base: Gates) => guardInterviewChanges(base);
    const args = { application_id: APP, date: '2026-10-27', time: '09:00', kind: 'video', place: LINK };
    // The read is in the same turn and still counts.
    await runRead(opsFor(f, gates), store, CALLER, 'listApplications', {});
    const out = await runChange(opsFor(f, gates), store, CALLER, 'scheduleInterview', args);
    expect(out).not.toEqual({ ok: false, error: LINK_NOT_GIVEN });
    expect(out.ok).toBe(true);
    expect(writeCalls(f)).toHaveLength(1);
  });

  it('a meeting link counts after an earlier change ended the turn', async () => {
    const f = fakeTools();
    const store = memoryTranscriptStore();
    const gates = (base: Gates) => guardInterviewChanges(base);
    await runRead(opsFor(f, gates), store, CALLER, 'listApplications', {});
    const args = { application_id: APP, date: '2026-10-27', time: '09:00', kind: 'video', place: LINK };
    expect((await runChange(opsFor(f, gates), store, CALLER, 'scheduleInterview', args)).ok).toBe(true);
    const next = { ...args, date: '2026-10-28', place: 'https://meet.example/y' };
    expect((await runChange(opsFor(f, gates), store, CALLER, 'scheduleInterview', next)).ok).toBe(true);
  });

  it('the merged link text stays out of the stored transcript', async () => {
    const f = fakeTools();
    const store: TranscriptStore = memoryTranscriptStore();
    const gates = (base: Gates) => guardInterviewChanges(base);
    await runRead(opsFor(f, gates), store, CALLER, 'listApplications', {});
    await runChange(opsFor(f, gates), store, CALLER, 'scheduleInterview', { application_id: APP, date: 'd', time: 't', kind: 'video', place: LINK });
    const users = store.messages('cred1:user1').filter((m) => m.role === 'user');
    expect(users.every((m) => !JSON.stringify(m.content).includes(LINK))).toBe(true);
  });

  it('an error thrown by a tool comes back plain', async () => {
    const f = fakeTools();
    const store = memoryTranscriptStore();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = await runChange(opsFor(f), store, CALLER, 'throwing', {});
    expect(out).toEqual({ ok: false, error: FAILED });
    expect((out as { error: string }).error).not.toMatch(/secret_table|\/srv/);
    for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toMatch(/secret_table/);
    spy.mockRestore();
  });

  it('an unconfirmed note does not hold back the next deletion', async () => {
    const f = fakeTools();
    const store = memoryTranscriptStore();
    const check: DeletionCheck = async () => ({ ok: true, note: 'N', namesakes: [] });
    const gates = (base: Gates) => guardDeletions(base, check);
    await runRead(opsFor(f, gates), store, CALLER, 'listCandidates', {});
    // Asked once (a note), never confirmed: the note is not in the transcript, so a second ask is not refused.
    await runChange(opsFor(f, gates), store, CALLER, 'deleteCandidate', { id: 'c1' });
    const again = await runChange(opsFor(f, gates), store, CALLER, 'deleteCandidate', { id: 'c2' });
    expect(again).not.toEqual({ ok: false, error: ONE_DELETION });
  });
  // A confirmed change its gate then refused ends the turn, so its result-less note does not count as one a turn.
  it('a refused confirm does not hold back the next deletion', async () => {
    const f = fakeTools();
    const store = memoryTranscriptStore();
    let refuse = false;
    const check: DeletionCheck = async () => (refuse ? { ok: false, refusal: 'Gone.' } : { ok: true, note: 'N', namesakes: [] });
    const gates = (base: Gates) => guardDeletions(base, check);
    await runRead(opsFor(f, gates), store, CALLER, 'listCandidates', {});
    const first = await runChange(opsFor(f, gates), store, CALLER, 'deleteCandidate', { id: 'c1' });
    refuse = true;
    const token = (first as { confirm: string }).confirm;
    expect(await runChange(opsFor(f, gates), store, CALLER, 'deleteCandidate', { id: 'c1' }, token)).toEqual({ ok: false, error: 'Gone.' });
    refuse = false;
    const next = await runChange(opsFor(f, gates), store, CALLER, 'deleteCandidate', { id: 'c2' });
    expect(next).not.toEqual({ ok: false, error: ONE_DELETION });
    expect(next).toMatchObject({ ok: false, needsConfirm: true, note: 'N' });
    expect(writeCalls(f)).toHaveLength(0);
  });
  it('a changed note whose new token is never sent does not hold back the next deletion', async () => {
    const f = fakeTools();
    const store = memoryTranscriptStore();
    let note = 'N1';
    const check: DeletionCheck = async () => ({ ok: true, note, namesakes: [] });
    const gates = (base: Gates) => guardDeletions(base, check);
    await runRead(opsFor(f, gates), store, CALLER, 'listCandidates', {});
    const first = await runChange(opsFor(f, gates), store, CALLER, 'deleteCandidate', { id: 'c1' });
    note = 'N2';
    const second = await runChange(opsFor(f, gates), store, CALLER, 'deleteCandidate', { id: 'c1' }, (first as { confirm: string }).confirm);
    expect(second).toMatchObject({ ok: false, needsConfirm: true, note: 'N2' });
    // The new token is dropped; another deletion is asked for instead.
    const next = await runChange(opsFor(f, gates), store, CALLER, 'deleteCandidate', { id: 'c2' });
    expect(next).not.toEqual({ ok: false, error: ONE_DELETION });
    expect(next).toMatchObject({ ok: false, needsConfirm: true, note: 'N2' });
    expect(writeCalls(f)).toHaveLength(0);
  });

  it('a confirm whose change throws does not hold back the next deletion', async () => {
    const f = fakeTools();
    const store = memoryTranscriptStore();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let fail = true;
    f.writes.deleteCandidate = tool({
      description: 'deleteCandidate',
      inputSchema: z.object({ id: z.string().min(1) }),
      execute: async () => {
        if (fail) throw new Error('boom at /srv/db.ts');
        return { ok: true };
      },
    } as never) as Tool;
    const check: DeletionCheck = async () => ({ ok: true, note: 'N', namesakes: [] });
    const gates = (base: Gates) => guardDeletions(base, check);
    await runRead(opsFor(f, gates), store, CALLER, 'listCandidates', {});
    const first = await runChange(opsFor(f, gates), store, CALLER, 'deleteCandidate', { id: 'c1' });
    const thrown = await runChange(opsFor(f, gates), store, CALLER, 'deleteCandidate', { id: 'c1' }, (first as { confirm: string }).confirm);
    expect(thrown).toEqual({ ok: false, error: FAILED });
    fail = false;
    const next = await runChange(opsFor(f, gates), store, CALLER, 'deleteCandidate', { id: 'c2' });
    expect(next).not.toEqual({ ok: false, error: ONE_DELETION });
    expect(next).toMatchObject({ ok: false, needsConfirm: true });
    spy.mockRestore();
  });

  it('a gate that throws returns the plain failure, and a confirm it stops ends the turn', async () => {
    const f = fakeTools();
    const store = memoryTranscriptStore();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let throwing = false;
    const gates = (base: Gates) => {
      const real = guardDeletions(base, async () => ({ ok: true, note: 'N', namesakes: [] }))!;
      return {
        ...real,
        deleteCandidate: ((input, options) => {
          if (throwing) throw new Error('db said: relation "hire_secret" at /srv/gate.ts');
          return (real.deleteCandidate as DeletionGate)(input, options);
        }) as DeletionGate,
      };
    };
    await runRead(opsFor(f, gates), store, CALLER, 'listCandidates', {});
    throwing = true;
    const plain = await runChange(opsFor(f, gates), store, CALLER, 'deleteCandidate', { id: 'c1' });
    expect(plain).toEqual({ ok: false, error: FAILED });
    expect(JSON.stringify(plain)).not.toMatch(/hire_secret|\/srv/);
    throwing = false;
    const first = await runChange(opsFor(f, gates), store, CALLER, 'deleteCandidate', { id: 'c1' });
    throwing = true;
    const stopped = await runChange(opsFor(f, gates), store, CALLER, 'deleteCandidate', { id: 'c1' }, (first as { confirm: string }).confirm);
    expect(stopped).toEqual({ ok: false, error: FAILED });
    throwing = false;
    const next = await runChange(opsFor(f, gates), store, CALLER, 'deleteCandidate', { id: 'c2' });
    expect(next).not.toEqual({ ok: false, error: ONE_DELETION });
    expect(writeCalls(f)).toHaveLength(0);
    for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toMatch(/hire_secret/);
    spy.mockRestore();
  });
});

describe('runRead', () => {
  it('records the read so a later change sees it', async () => {
    const f = fakeTools();
    const store = memoryTranscriptStore();
    const out = await runRead(opsFor(f), store, CALLER, 'listCandidates', {});
    expect(out.ok).toBe(true);
    expect(store.messages('cred1:user1').some((m) => m.role === 'tool')).toBe(true);
    // Another credential's record is apart.
    expect(store.messages('cred2:user1')).toEqual([]);
  });

  it('returns a CV the read put on the shelf', async () => {
    const f = fakeTools();
    const store = memoryTranscriptStore();
    const out = await runRead(opsFor(f), store, CALLER, 'readCandidateCv', { applicationId: APP });
    expect(out).toMatchObject({ ok: true, cv: { mediaType: 'application/pdf' } });
    expect((out as { cv: { data: Uint8Array } }).cv.data).toEqual(new Uint8Array([37, 80]));
    const plain = await runRead(opsFor(f), store, CALLER, 'listCandidates', {});
    expect(plain).not.toHaveProperty('cv');
  });
});

describe('runChange activity log', () => {
  const readFirst = async (f: Fakes, store: TranscriptStore) => {
    await runRead(opsFor(f), store, CALLER, 'listCandidates', {});
  };

  it('logs a successful change once, named for the thing changed', async () => {
    const f = fakeTools();
    const store = memoryTranscriptStore();
    await readFirst(f, store);
    const log = vi.fn(async () => true);
    const out = await runChange(opsFor(f), store, CALLER, 'deleteCandidate', { id: 'c1' }, undefined, { log });
    expect(out.ok).toBe(true);
    expect(out).not.toHaveProperty('logged');
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith({ operation: 'deleteCandidate', target: 'Aisyah Lim' });
  });

  it('adds logged: false when the entry could not be written, and the change stands', async () => {
    const f = fakeTools();
    const store = memoryTranscriptStore();
    await readFirst(f, store);
    const out = await runChange(opsFor(f), store, CALLER, 'deleteCandidate', { id: 'c1' }, undefined, { log: async () => false });
    expect(out).toMatchObject({ ok: true, logged: false });
    expect(writeCalls(f)).toHaveLength(1);
  });

  it('a logger that throws never fails the change', async () => {
    const f = fakeTools();
    const store = memoryTranscriptStore();
    await readFirst(f, store);
    const out = await runChange(opsFor(f), store, CALLER, 'deleteCandidate', { id: 'c1' }, undefined, {
      log: async () => {
        throw new Error('boom');
      },
    });
    expect(out).toMatchObject({ ok: true, logged: false });
  });

  it('does not log a refused, failed or unconfirmed change', async () => {
    const f = fakeTools();
    const store = memoryTranscriptStore();
    const log = vi.fn(async () => true);
    await runChange(opsFor(f), store, CALLER, 'deleteCandidate', { id: 'c9' }, undefined, { log });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await runChange(opsFor(f), store, CALLER, 'throwing', {}, undefined, { log });
    expect(log).not.toHaveBeenCalled();
  });

  it('falls back to the heading when no row names the change', async () => {
    const f = fakeTools();
    const store = memoryTranscriptStore();
    const log = vi.fn(async () => true);
    await runChange(opsFor(f, () => ({ throwing: 'user-approval', scheduleInterview: 'user-approval' })), store, CALLER, 'scheduleInterview', { application_id: APP, date: '2026-11-01', time: '10:00', kind: 'online' }, undefined, { log });
    expect(log).toHaveBeenCalledTimes(1);
    const arg = log.mock.calls[0] as unknown as [{ operation: string; target: string }];
    expect(arg[0].operation).toBe('scheduleInterview');
    expect(arg[0].target.length).toBeGreaterThan(0);
  });

  const GATES = () => ({ throwing: 'user-approval' as const, createDeal: 'user-approval' as const, deleteDeal: 'user-approval' as const, updateDeal: 'user-approval' as const });
  const CONTACT = '66666666-6666-4666-8666-666666666601';
  const STAGE = '77777777-7777-4777-8777-777777777701';

  it('names a created deal by its title, not by the contact it points at', async () => {
    const f = fakeTools();
    const log = vi.fn(async () => true);
    await runChange(opsFor(f, GATES), memoryTranscriptStore(), CALLER, 'createDeal', { title: 'OAuth prod check deal', contactId: CONTACT, stageId: STAGE }, undefined, { log });
    expect(log).toHaveBeenCalledWith({ operation: 'createDeal', target: 'OAuth prod check deal' });
  });

  it('names a deleted deal by its name', async () => {
    const f = fakeTools();
    const store = memoryTranscriptStore();
    await runRead(opsFor(f), store, CALLER, 'listDeals', {});
    const log = vi.fn(async () => true);
    await runChange(opsFor(f, GATES), store, CALLER, 'deleteDeal', { id: DEAL }, undefined, { log });
    expect(log).toHaveBeenCalledWith({ operation: 'deleteDeal', target: 'Annual plan' });
  });

  it('names an update that carries only an id by that record', async () => {
    const f = fakeTools();
    const store = memoryTranscriptStore();
    await runRead(opsFor(f), store, CALLER, 'listDeals', {});
    const log = vi.fn(async () => true);
    await runChange(opsFor(f, GATES), store, CALLER, 'updateDeal', { id: DEAL, tag: 'hot' }, undefined, { log });
    expect(log).toHaveBeenCalledWith({ operation: 'updateDeal', target: 'Annual plan' });
  });

  it('falls back to the heading rather than an unresolved record', async () => {
    const f = fakeTools();
    const log = vi.fn(async () => true);
    await runChange(opsFor(f, GATES), memoryTranscriptStore(), CALLER, 'deleteDeal', { id: DEAL }, undefined, { log });
    expect(log).toHaveBeenCalledWith({ operation: 'deleteDeal', target: changeHeading('deleteDeal') });
  });
});
