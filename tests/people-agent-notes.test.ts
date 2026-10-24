import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import * as notes from '@/lib/people/agent/notes';
import { deleteAgentNote, listAgentNotes, noteHref } from '@/lib/people/agent/notes';
import { PEOPLE_NOTE_ENTITY_TYPES } from '@/lib/people/agent/scan';

type Result = { data: unknown; error: { code?: string } | null };
type Call = { table: string; ops: [string, ...unknown[]][] };

/** A Supabase client stand-in: every query records its calls and resolves with `answer(call)`. */
function fakeClient(answer: (call: Call) => Result) {
  const calls: Call[] = [];
  const client = {
    from(table: string) {
      const call: Call = { table, ops: [] };
      calls.push(call);
      const builder: Record<string, unknown> = {};
      for (const op of ['select', 'eq', 'in', 'order', 'limit', 'delete']) {
        builder[op] = (...args: unknown[]) => {
          call.ops.push([op, ...args]);
          return builder;
        };
      }
      builder.then = (resolve: (r: Result) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve(answer(call)).then(resolve, reject);
      return builder;
    },
  };
  return { client: client as unknown as SupabaseClient, calls };
}

const op = (call: Call, name: string) => call.ops.filter((o) => o[0] === name);

afterEach(() => vi.restoreAllMocks());

describe('listAgentNotes (Lekiu)', () => {
  const NOTE = {
    id: 'n1',
    entity_type: 'hr_leave_request',
    entity_id: 'l1',
    employee_id: 'e1',
    entity_label: 'Aisyah Rahman',
    body: 'Leave has waited 6 days for a decision (as of 09 Oct 2026)',
    created_by: 'u1',
    created_at: '2026-10-09T01:00:00Z',
  };

  it('reads hr_agent_notes of the workspace, newest first, with who approved them', async () => {
    const { client, calls } = fakeClient((call) =>
      call.table === 'profiles'
        ? { data: [{ user_id: 'u1', full_name: ' Farid ', email: 'f@x.my' }], error: null }
        : { data: [NOTE, { ...NOTE, id: 'n2', created_by: 'gone' }], error: null },
    );
    const list = await listAgentNotes({ client, orgId: 'org' });
    expect(list).toEqual([
      {
        id: 'n1',
        entityType: 'hr_leave_request',
        entityId: 'l1',
        employeeId: 'e1',
        entityLabel: 'Aisyah Rahman',
        body: NOTE.body,
        approvedBy: 'Farid',
        createdAt: NOTE.created_at,
      },
      expect.objectContaining({ id: 'n2', approvedBy: null }),
    ]);
    expect(calls[0].table).toBe('hr_agent_notes');
    expect(op(calls[0], 'eq')).toEqual([['eq', 'org_id', 'org']]);
    expect(op(calls[0], 'order')).toEqual([['order', 'created_at', { ascending: false }]]);
    expect(op(calls[0], 'limit')).toEqual([['limit', 50]]);
  });

  it('still lists the notes when the names cannot be read', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = fakeClient((call) =>
      call.table === 'profiles' ? { data: null, error: { code: 'x' } } : { data: [NOTE], error: null },
    );
    expect((await listAgentNotes({ client, orgId: 'org' }))?.[0].approvedBy).toBeNull();
  });

  it('gives null, logging only the error code, when the notes cannot be read', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = fakeClient(() => ({ data: null, error: { code: '42501' } }));
    expect(await listAgentNotes({ client, orgId: 'org' })).toBeNull();
    expect(JSON.stringify(log.mock.calls)).not.toContain('Aisyah');
  });
});

describe('deleteAgentNote (Lekiu)', () => {
  it('deletes one note of the workspace', async () => {
    const { client, calls } = fakeClient(() => ({ data: [{ id: 'n1' }], error: null }));
    expect(await deleteAgentNote({ client, orgId: 'org' }, 'n1')).toEqual({ ok: true, data: null });
    expect(calls[0].table).toBe('hr_agent_notes');
    expect(op(calls[0], 'delete')).toHaveLength(1);
    expect(op(calls[0], 'eq')).toEqual([
      ['eq', 'org_id', 'org'],
      ['eq', 'id', 'n1'],
    ]);
  });

  it('says so when nothing was deleted (gone, or not HR)', async () => {
    const { client } = fakeClient(() => ({ data: [], error: null }));
    const res = await deleteAgentNote({ client, orgId: 'org' }, 'n1');
    expect(res.ok).toBe(false);
  });

  it('refuses plainly on a database error', async () => {
    const { client } = fakeClient(() => ({ data: null, error: { code: '42501' } }));
    expect(await deleteAgentNote({ client, orgId: 'org' }, 'n1')).toEqual({
      ok: false,
      error: 'That note could not be deleted. Please try again.',
    });
  });
});

describe('noteHref (Lekiu)', () => {
  it('links each kind of note to the screen its record lives on', () => {
    // The Employees screen reads no ?open=, so its link is the plain screen.
    expect(noteHref('hr_document')).toBe('/people/employees');
    expect(noteHref('hr_leave_request')).toBe('/people/approve-leave');
    expect(noteHref('hr_claim')).toBe('/people/approve-claims');
    expect(noteHref('hr_overtime_record')).toBe('/people/approve-overtime');
    expect(noteHref('hr_letter')).toBe('/people/letters');
    expect(noteHref('hr_goal')).toBe('/people/scorecard');
    // Only the absence check writes an employee note.
    expect(noteHref('hr_employee')).toBe('/people/attendance');
    expect(noteHref('hr_payroll_month')).toBe('/people/payroll');
    expect(noteHref('something_else')).toBeNull();
  });

  it('covers every entity type a note can have', () => {
    for (const t of PEOPLE_NOTE_ENTITY_TYPES) expect(noteHref(t), t).not.toBeNull();
  });

  it('has no row-marker helper (a non-goal)', () => {
    expect('noteCountsFor' in notes).toBe(false);
  });
});
