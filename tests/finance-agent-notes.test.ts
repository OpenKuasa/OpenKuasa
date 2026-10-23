import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { deleteAgentNote, listAgentNotes, noteCountsFor, noteHref } from '@/lib/finance/agent/notes';

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

describe('noteCountsFor', () => {
  it('reads nothing when no documents are loaded', async () => {
    const { client, calls } = fakeClient(() => ({ data: [], error: null }));
    expect(await noteCountsFor({ client, orgId: 'org' }, 'finance_invoice', [])).toEqual({});
    expect(calls).toHaveLength(0);
  });

  it('reads only the given ids of that type in the workspace, and counts with the newest body', async () => {
    const { client, calls } = fakeClient(() => ({
      data: [
        { entity_id: 'a', body: 'older', created_at: '2026-10-01T00:00:00Z' },
        { entity_id: 'a', body: 'newest', created_at: '2026-10-05T00:00:00Z' },
        { entity_id: 'b', body: 'only', created_at: '2026-10-02T00:00:00Z' },
      ],
      error: null,
    }));
    const counts = await noteCountsFor({ client, orgId: 'org' }, 'finance_invoice', ['a', 'b', 'a']);
    expect(counts).toEqual({ a: { count: 2, latest: 'newest' }, b: { count: 1, latest: 'only' } });
    expect(calls).toHaveLength(1);
    expect(calls[0].table).toBe('finance_agent_notes');
    expect(op(calls[0], 'eq')).toEqual([
      ['eq', 'org_id', 'org'],
      ['eq', 'entity_type', 'finance_invoice'],
    ]);
    expect(op(calls[0], 'in')).toEqual([['in', 'entity_id', ['a', 'b']]]);
  });

  it('splits a long list of ids into several reads', async () => {
    const { client, calls } = fakeClient(() => ({ data: [], error: null }));
    const ids = Array.from({ length: 450 }, (_, i) => `id-${i}`);
    await noteCountsFor({ client, orgId: 'org' }, 'finance_expense', ids);
    expect(calls.map((c) => (op(c, 'in')[0][2] as string[]).length)).toEqual([200, 200, 50]);
  });

  it('gives null (logged) when the read fails, so the screen shows no marker', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = fakeClient(() => ({ data: null, error: { code: '42501' } }));
    expect(await noteCountsFor({ client, orgId: 'org' }, 'finance_quotation', ['a'])).toBeNull();
    expect(log).toHaveBeenCalled();
  });

  it('gives null (logged) when the client throws', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = { from: () => { throw new Error('boom'); } } as unknown as SupabaseClient;
    expect(await noteCountsFor({ client, orgId: 'org' }, 'finance_quotation', ['a'])).toBeNull();
    expect(log).toHaveBeenCalled();
  });
});

describe('listAgentNotes', () => {
  const NOTE = {
    id: 'n1',
    entity_type: 'finance_invoice',
    entity_id: 'i1',
    entity_label: 'INV-0042',
    body: 'Overdue 14 days (as of 09 Oct 2026)',
    created_by: 'u1',
    created_at: '2026-10-09T01:00:00Z',
  };

  it('lists the newest notes with who approved them', async () => {
    const { client, calls } = fakeClient((call) =>
      call.table === 'profiles'
        ? { data: [{ user_id: 'u1', full_name: ' Aisyah ', email: 'a@x.my' }], error: null }
        : { data: [NOTE, { ...NOTE, id: 'n2', created_by: 'gone' }], error: null },
    );
    const notes = await listAgentNotes({ client, orgId: 'org' });
    expect(notes).toEqual([
      {
        id: 'n1',
        entityType: 'finance_invoice',
        entityId: 'i1',
        entityLabel: 'INV-0042',
        body: NOTE.body,
        approvedBy: 'Aisyah',
        createdAt: NOTE.created_at,
      },
      expect.objectContaining({ id: 'n2', approvedBy: null }),
    ]);
    expect(op(calls[0], 'order')).toEqual([['order', 'created_at', { ascending: false }]]);
    expect(op(calls[0], 'eq')).toEqual([['eq', 'org_id', 'org']]);
  });

  it('still lists the notes when the names cannot be read', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = fakeClient((call) =>
      call.table === 'profiles' ? { data: null, error: { code: 'x' } } : { data: [NOTE], error: null },
    );
    const notes = await listAgentNotes({ client, orgId: 'org' });
    expect(notes?.[0].approvedBy).toBeNull();
  });

  it('gives null when the notes cannot be read', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = fakeClient(() => ({ data: null, error: { code: 'x' } }));
    expect(await listAgentNotes({ client, orgId: 'org' })).toBeNull();
  });
});

describe('deleteAgentNote', () => {
  it('deletes one note of the workspace', async () => {
    const { client, calls } = fakeClient(() => ({ data: [{ id: 'n1' }], error: null }));
    expect(await deleteAgentNote({ client, orgId: 'org' }, 'n1')).toEqual({ ok: true, data: null });
    expect(op(calls[0], 'delete')).toHaveLength(1);
    expect(op(calls[0], 'eq')).toEqual([
      ['eq', 'org_id', 'org'],
      ['eq', 'id', 'n1'],
    ]);
  });

  it('says so when nothing was deleted (gone, or not allowed)', async () => {
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

describe('noteHref', () => {
  it('links each kind of note to its screen', () => {
    expect(noteHref('finance_invoice')).toBe('/finance/invoices');
    expect(noteHref('finance_supplier_bill')).toBe('/finance/supplier-bills');
    expect(noteHref('finance_expense')).toBe('/finance/expenses');
    expect(noteHref('finance_quotation')).toBe('/finance/quotations');
    expect(noteHref('finance_bank_account')).toBe('/finance/banking');
    expect(noteHref('finance_sst_period')).toBe('/finance/sst-report');
    expect(noteHref('something_else')).toBeNull();
  });
});
