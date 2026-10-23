import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, test, vi } from 'vitest';
import { RecordNotes } from '@/components/crm/record-notes';
import {
  NOTES_SHOWN,
  listRecordNotes,
  loadRecordNotes,
  mapCrmNote,
  readOpenParam,
} from '@/lib/crm/notes';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const DEAL_ID = '22222222-2222-4222-8222-222222222222';
const CONTACT_ID = '33333333-3333-4333-8333-333333333333';

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'n1',
    body: 'Called, wants a quote',
    source: 'user',
    created_at: '2026-10-20T09:30:00.000Z',
    ...overrides,
  };
}

/** A client whose notes query ends at `.limit()` and records every call made on it. */
function clientReturning(result: { data: unknown; error: unknown }) {
  const calls: [string, ...unknown[]][] = [];
  const chain: Record<string, unknown> = {};
  for (const name of ['select', 'eq', 'order']) {
    chain[name] = (...args: unknown[]) => {
      calls.push([name, ...args]);
      return chain;
    };
  }
  chain.limit = async (...args: unknown[]) => {
    calls.push(['limit', ...args]);
    return result;
  };
  const from = vi.fn(() => chain);
  return { client: { from } as unknown as SupabaseClient, from, calls };
}

describe('mapCrmNote', () => {
  test('marks a note from the agent by its source', () => {
    expect(mapCrmNote(row({ source: 'agent' }))).toStrictEqual({
      id: 'n1',
      body: 'Called, wants a quote',
      fromAgent: true,
      createdAt: '2026-10-20T09:30:00.000Z',
    });
  });

  test('a note written by a person is not from the agent', () => {
    expect(mapCrmNote(row({ source: 'user' })).fromAgent).toBe(false);
  });

  test('anything but "agent" is not from the agent', () => {
    expect(mapCrmNote(row({ source: null })).fromAgent).toBe(false);
  });
});

describe('listRecordNotes', () => {
  test('reads a deal\'s notes newest first, limited, in the given workspace', async () => {
    const { client, from, calls } = clientReturning({ data: [row()], error: null });

    const notes = await listRecordNotes(client, ORG_ID, { dealId: DEAL_ID });

    expect(from).toHaveBeenCalledWith('crm_notes');
    expect(calls).toContainEqual(['eq', 'org_id', ORG_ID]);
    expect(calls).toContainEqual(['eq', 'deal_id', DEAL_ID]);
    expect(calls).toContainEqual(['order', 'created_at', { ascending: false }]);
    expect(calls).toContainEqual(['order', 'id', { ascending: false }]);
    expect(calls).toContainEqual(['limit', NOTES_SHOWN]);
    expect(NOTES_SHOWN).toBe(20);
    expect(notes).toHaveLength(1);
  });

  test('reads a contact\'s notes by contact_id', async () => {
    const { client, calls } = clientReturning({ data: [], error: null });

    await listRecordNotes(client, ORG_ID, { contactId: CONTACT_ID });

    expect(calls).toContainEqual(['eq', 'contact_id', CONTACT_ID]);
  });

  test('throws when the read fails', async () => {
    const { client } = clientReturning({ data: null, error: new Error('boom') });
    await expect(listRecordNotes(client, ORG_ID, { dealId: DEAL_ID })).rejects.toThrow('boom');
  });
});

describe('loadRecordNotes', () => {
  test('returns the notes for a valid id', async () => {
    const { client } = clientReturning({ data: [row({ source: 'agent' })], error: null });
    const notes = await loadRecordNotes(client, ORG_ID, { dealId: DEAL_ID });
    expect(notes?.[0].fromAgent).toBe(true);
  });

  test('an id that is not a uuid reads nothing', async () => {
    const { client, from } = clientReturning({ data: [row()], error: null });
    expect(await loadRecordNotes(client, ORG_ID, { dealId: 'not-a-uuid' })).toBeNull();
    expect(from).not.toHaveBeenCalled();
  });

  test('a failed read gives null rather than throwing', async () => {
    const { client } = clientReturning({ data: null, error: { code: '42703', message: 'no column source' } });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await loadRecordNotes(client, ORG_ID, { contactId: CONTACT_ID })).toBeNull();
    spy.mockRestore();
  });
});

describe('RecordNotes', () => {
  test('shows a note body as text, not markup', () => {
    const html = renderToStaticMarkup(
      createElement(RecordNotes, {
        notes: [{ id: 'n1', body: '<script>x</script>', fromAgent: false, createdAt: '2026-10-20T09:30:00.000Z' }],
      }),
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(html).toContain('whitespace-pre-wrap');
    expect(html).toContain('20 Oct 2026');
  });

  test('dates a note by its Kuala Lumpur day', () => {
    const html = renderToStaticMarkup(
      createElement(RecordNotes, {
        notes: [{ id: 'n1', body: 'late', fromAgent: false, createdAt: '2026-10-20T20:00:00.000Z' }],
      }),
    );
    expect(html).toContain('21 Oct 2026');
  });

  test('labels a note from the agent, and only that one', () => {
    const html = renderToStaticMarkup(
      createElement(RecordNotes, {
        notes: [
          { id: 'a', body: 'agent note', fromAgent: true, createdAt: '2026-10-20T09:30:00.000Z' },
          { id: 'b', body: 'my note', fromAgent: false, createdAt: '2026-10-19T09:30:00.000Z' },
        ],
      }),
    );
    expect(html.match(/from the agent/g)).toHaveLength(1);
  });

  test('renders nothing when there are no notes', () => {
    expect(renderToStaticMarkup(createElement(RecordNotes, { notes: [] }))).toBe('');
  });
});

describe('readOpenParam', () => {
  test('accepts a uuid', () => {
    expect(readOpenParam(DEAL_ID)).toBe(DEAL_ID);
  });

  test.each([undefined, '', 'abc', ['x'], `${DEAL_ID}x`, `${DEAL_ID}'; drop table`])(
    'refuses %j',
    (value) => {
      expect(readOpenParam(value as string | string[] | undefined)).toBeNull();
    },
  );
});
