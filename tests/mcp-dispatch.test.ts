// tests/mcp-dispatch.test.ts
import { tool, type Tool } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { guardDeletions, notLookedUp, ONE_DELETION, type DeletionCheck, type DeletionGate } from '@/lib/ai/hire-deletions';
import { guardInterviewChanges, LINK_NOT_GIVEN } from '@/lib/ai/hire-interview-gate';
import { changeHeading } from '@/lib/chat/change-rows';
import { runChange, runRead } from '@/lib/mcp/dispatch';
import type { Operation, Operations } from '@/lib/mcp/operations';
import { memoryTranscriptStore, type TranscriptStore } from '@/lib/mcp/transcript';
import type { HeldCv } from '@/lib/ai/hire-tools';

const APP = '44444444-4444-4444-8444-444444444481';
const LINK = 'https://meet.example/x';
const CALLER = { credentialId: 'cred1', userId: 'user1' };
const OTHER = { credentialId: 'cred2', userId: 'user1' };

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
    expect(reused).toMatchObject({ ok: false, error: expect.any(String) });
    expect(reused).not.toHaveProperty('needsConfirm');
    const ranOnce = writeCalls(f).length;
    expect(ranOnce).toBe(1);

    // Other arguments.
    const t2 = (await ask()).confirm;
    expect(await runChange(opsFor(f, gates), store, CALLER, 'deleteCandidate', { id: 'c2' }, t2)).toMatchObject({ ok: false, error: expect.any(String) });
    // Other credential.
    const t3 = (await ask()).confirm;
    expect(await runChange(opsFor(f, gates), store, OTHER, 'deleteCandidate', { id: 'c1' }, t3)).toMatchObject({ ok: false, error: expect.any(String) });
    // Other operation.
    const t5 = (await ask()).confirm;
    expect(await runChange(opsFor(f, gates), store, CALLER, 'scheduleInterview', { application_id: APP, date: 'd', time: 't', kind: 'video' }, t5)).toMatchObject({ ok: false, error: expect.any(String) });
    // Expired.
    const t6 = (await ask()).confirm;
    vi.advanceTimersByTime(10 * 60 * 1000 + 1);
    expect(await runChange(opsFor(f, gates), store, CALLER, 'deleteCandidate', { id: 'c1' }, t6)).toMatchObject({ ok: false, error: expect.any(String) });
    // An unknown token.
    expect(await runChange(opsFor(f, gates), store, CALLER, 'deleteCandidate', { id: 'c1' }, 'made-up')).toMatchObject({ ok: false, error: expect.any(String) });

    expect(writeCalls(f)).toHaveLength(ranOnce);
  });

  it('read names are refused by runChange and write names by runRead', async () => {
    const f = fakeTools();
    const store = memoryTranscriptStore();
    expect(await runChange(opsFor(f), store, CALLER, 'listCandidates', {})).toMatchObject({ ok: false, error: expect.any(String) });
    expect(await runRead(opsFor(f), store, CALLER, 'deleteCandidate', { id: 'c1' })).toMatchObject({ ok: false, error: expect.any(String) });
    expect(await runRead(opsFor(f), store, CALLER, 'nope', {})).toMatchObject({ ok: false, error: expect.any(String) });
    expect(await runChange(opsFor(f), store, CALLER, 'nope', {})).toMatchObject({ ok: false, error: expect.any(String) });
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
    expect(out).toMatchObject({ ok: false, error: expect.any(String) });
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
  // Recorded as it stands (see the task report): a confirmed change its gate then refused leaves its note in the
  // turn with no result, and Tuah's one-a-turn rule counts it until a change ends the turn.
  it('a refused confirm leaves its note in the turn (current behaviour)', async () => {
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
    expect(await runChange(opsFor(f, gates), store, CALLER, 'deleteCandidate', { id: 'c2' })).toEqual({ ok: false, error: ONE_DELETION });
    expect(writeCalls(f)).toHaveLength(0);
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
