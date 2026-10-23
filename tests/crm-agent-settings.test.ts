import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { confirmFocus, ensureCrmAgentConfig, nextKlSeven, saveFocus } from '@/lib/crm/agent/settings';

vi.mock('@/lib/ai/workspace-key', () => ({ readWorkspaceKey: vi.fn() }));
vi.mock('@/lib/agents/runner', () => ({ startRefusal: vi.fn() }));

import { readWorkspaceKey } from '@/lib/ai/workspace-key';
import { startRefusal } from '@/lib/agents/runner';

const ORG = '11111111-1111-1111-1111-111111111111';
const NOW = new Date('2026-10-23T05:00:00Z');

type Log = { table: string; op: string; payload?: unknown; filters: Array<[string, unknown]> };

/** A table-aware fake: update().eq().eq().select().maybeSingle(), insert(), select().eq()...maybeSingle()/count. */
function fake(opts: {
  updateData?: unknown;
  selectData?: unknown;
  count?: number | null;
  countError?: unknown;
  insertError?: unknown;
} = {}) {
  const log: Log[] = [];
  const client = {
    from(table: string) {
      return {
        update(payload: unknown) {
          const entry: Log = { table, op: 'update', payload, filters: [] };
          log.push(entry);
          const chain: Record<string, unknown> = {
            eq(c: string, v: unknown) { entry.filters.push([c, v]); return chain; },
            select: () => chain,
            maybeSingle: async () => ({ data: opts.updateData ?? null, error: null }),
            then: (res: (v: unknown) => unknown) => res({ error: null }),
          };
          return chain;
        },
        insert(payload: unknown) {
          log.push({ table, op: 'insert', payload, filters: [] });
          const res = { data: null, error: opts.insertError ?? null };
          const p = Promise.resolve(res) as Promise<typeof res> & { select: () => unknown };
          p.select = () => ({ single: async () => ({ data: opts.insertError ? null : { id: 'run1' }, error: opts.insertError ?? null }) });
          return p;
        },
        select(_cols: string, o?: { count?: string }) {
          const entry: Log = { table, op: o?.count ? 'count' : 'select', filters: [] };
          log.push(entry);
          const chain: Record<string, unknown> = {
            eq(c: string, v: unknown) { entry.filters.push([c, v]); return chain; },
            gte(c: string, v: unknown) { entry.filters.push([c, v]); return chain; },
            maybeSingle: async () => ({ data: opts.selectData ?? null, error: null }),
            then: (res: (v: unknown) => unknown) =>
              res({ count: opts.count ?? 0, error: opts.countError ?? null }),
          };
          return chain;
        },
      };
    },
  } as unknown as SupabaseClient;
  return { client, log };
}

const okKey = () => vi.mocked(readWorkspaceKey).mockResolvedValue({ status: 'ok', apiKey: 'k' });
const okInterpret = vi.fn(async () => ({
  plan: { checks: [{ key: 'follow_up_overdue', params: {} }] },
  cannot: ['Send emails'],
  cost_cents: 1.4,
}));

function deps(over: Partial<Parameters<typeof saveFocus>[0]> = {}) {
  const session = fake();
  const service = fake();
  return {
    session,
    service,
    d: {
      client: session.client,
      service: service.client,
      orgId: ORG,
      interpret: okInterpret,
      now: NOW,
      ...over,
    } as Parameters<typeof saveFocus>[0],
  };
}

describe('saveFocus', () => {
  it('rejects empty and over-long text', async () => {
    const { d } = deps();
    const msg = 'Write what the agent should watch for (up to 500 characters).';
    expect(await saveFocus(d, '   ')).toEqual({ ok: false, error: msg });
    expect(await saveFocus(d, 'x'.repeat(501))).toEqual({ ok: false, error: msg });
  });

  it('asks for an AI key when there is none', async () => {
    vi.mocked(readWorkspaceKey).mockResolvedValue({ status: 'none' });
    const { d } = deps();
    expect(await saveFocus(d, 'watch deals')).toEqual({ ok: false, error: 'Add your AI key in Settings to use the agent.' });
  });

  it('returns the start gate refusal message', async () => {
    okKey();
    vi.mocked(startRefusal).mockResolvedValue('daily budget reached');
    const { d } = deps();
    const r = await saveFocus(d, 'watch deals');
    expect(r).toEqual({
      ok: false,
      error: 'The workspace daily spend cap has been reached. Try again tomorrow, or ask an owner or admin to raise it.',
    });
    expect(vi.mocked(startRefusal)).toHaveBeenCalledWith(expect.anything(), ORG, 'crm-focus');
  });

  it('still saves while the agent is switched off (second save, no confirm)', async () => {
    okKey();
    vi.mocked(startRefusal).mockResolvedValue('disabled');
    const session = fake({ updateData: { id: 'row' } });
    const { d } = deps({ client: session.client });
    expect((await saveFocus(d, 'watch deals')).ok).toBe(true);
  });

  it('does not call the model when the spend cannot be reserved', async () => {
    okKey();
    vi.mocked(startRefusal).mockResolvedValue(null);
    const service = fake({ count: 0, insertError: { code: '42501' } });
    const interpret = vi.fn();
    const { d } = deps({ service: service.client, interpret: interpret as never });
    expect(await saveFocus(d, 'watch deals')).toEqual({
      ok: false,
      error: 'The focus could not be saved just now. Please try again.',
    });
    expect(interpret).not.toHaveBeenCalled();
  });

  it('refuses the 11th change in a KL day', async () => {
    okKey();
    vi.mocked(startRefusal).mockResolvedValue(null);
    const service = fake({ count: 10 });
    const { d } = deps({ service: service.client });
    expect(await saveFocus(d, 'watch deals')).toEqual({
      ok: false,
      error: 'You have changed the focus 10 times today. Try again tomorrow.',
    });
    const q = service.log.find((l) => l.op === 'count')!;
    expect(q.filters).toContainEqual(['trigger', 'interpret']);
    expect(q.filters).toContainEqual(['agent_key', 'crm-focus']);
    // KL midnight of 2026-10-23 is 2026-10-22T16:00:00Z
    expect(q.filters).toContainEqual(['started_at', '2026-10-22T16:00:00.000Z']);
  });

  it('records the interpret run and clears the confirmation', async () => {
    okKey();
    vi.mocked(startRefusal).mockResolvedValue(null);
    const session = fake({ updateData: { id: 'row' } });
    const service = fake({ count: 0 });
    const { d } = deps({ client: session.client, service: service.client });
    const r = await saveFocus(d, '  watch overdue follow-ups  ');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.cannot).toEqual(['Send emails']);
    const run = service.log.find((l) => l.op === 'insert' && l.table === 'agent_runs')!;
    expect(run.payload).toMatchObject({
      org_id: ORG,
      agent_key: 'crm-focus',
      status: 'done',
      trigger: 'interpret',
      cost_cents: 3,
    });
    const settled = service.log.find((l) => l.op === 'update' && l.table === 'agent_runs')!;
    expect(settled.payload).toEqual({ cost_cents: 1 });
    expect(settled.filters).toContainEqual(['id', 'run1']);
    const write = session.log.filter((l) => l.op === 'update').pop()!;
    expect(write.payload).toMatchObject({
      focus_text: 'watch overdue follow-ups',
      focus_plan: { checks: [{ key: 'follow_up_overdue', params: {} }] },
      focus_cannot: ['Send emails'],
      focus_confirmed_at: null,
    });
  });

  it('records a failed run at the estimate when interpreting throws, and hides the exception', async () => {
    okKey();
    vi.mocked(startRefusal).mockResolvedValue(null);
    const service = fake({ count: 0 });
    const boom = vi.fn(async () => {
      throw new Error('secret sk-123');
    });
    const { d } = deps({ service: service.client, interpret: boom });
    const r = await saveFocus(d, 'watch deals');
    expect(r).toEqual({ ok: false, error: 'The focus could not be read just now. Please try again.' });
    const run = service.log.find((l) => l.op === 'insert' && l.table === 'agent_runs')!;
    expect(run.payload).toMatchObject({ status: 'done', trigger: 'interpret', cost_cents: 3 });
    const failed = service.log.find((l) => l.op === 'update' && l.table === 'agent_runs')!;
    expect(failed.payload).toEqual({ status: 'failed', error: 'interpret failed' });
    expect(failed.filters).toContainEqual(['id', 'run1']);
  });
});

describe('confirmFocus', () => {
  it('refuses an empty plan', async () => {
    const { client } = fake({ selectData: { focus_plan: { checks: [] } } });
    const r = await confirmFocus(client, ORG, NOW);
    expect(r.ok).toBe(false);
  });

  it('refuses when nothing was saved', async () => {
    const { client } = fake({ selectData: null });
    expect((await confirmFocus(client, ORG, NOW)).ok).toBe(false);
  });

  it('confirms and enables', async () => {
    const { client, log } = fake({ selectData: { focus_plan: { checks: [{ key: 'a', params: {} }] } }, updateData: { id: 'r' } });
    expect(await confirmFocus(client, ORG, NOW)).toEqual({ ok: true, data: null });
    const upd = log.filter((l) => l.op === 'update').pop()!;
    expect(upd.payload).toMatchObject({ focus_confirmed_at: NOW.toISOString(), enabled: true });
  });
});

describe('ensureCrmAgentConfig', () => {
  it('inserts Kasturi defaults when no row exists', async () => {
    const { client, log } = fake({ updateData: null });
    expect(await ensureCrmAgentConfig(client, ORG)).toEqual({ ok: true, data: null });
    const ins = log.find((l) => l.op === 'insert')!;
    expect(ins.payload).toEqual({
      org_id: ORG,
      agent_key: 'crm-focus',
      // Starts off: the owner picks daily or weekly (or presses Run now).
      cadence: 'off',
      max_cost_cents: 50,
      daily_cap_cents: 200,
      weekly_cap_cents: 500,
    });
  });

  it('does not insert when the row exists', async () => {
    const { client, log } = fake({ updateData: { id: 'r' } });
    await ensureCrmAgentConfig(client, ORG);
    expect(log.some((l) => l.op === 'insert')).toBe(false);
  });

  it('treats a lost insert race as fine', async () => {
    const { client } = fake({ updateData: null, insertError: { code: '23505' } });
    expect((await ensureCrmAgentConfig(client, ORG)).ok).toBe(true);
  });
});

describe('nextKlSeven', () => {
  it('daily: next 07:00 Kuala Lumpur', () => {
    expect(nextKlSeven(new Date('2026-10-23T05:00:00Z'), 'daily').toISOString()).toBe('2026-10-23T23:00:00.000Z');
    expect(nextKlSeven(new Date('2026-10-22T22:59:00Z'), 'daily').toISOString()).toBe('2026-10-22T23:00:00.000Z');
  });

  it('weekly: next Monday 07:00 Kuala Lumpur', () => {
    expect(nextKlSeven(new Date('2026-10-23T05:00:00Z'), 'weekly').toISOString()).toBe('2026-10-25T23:00:00.000Z');
  });

  it('weekly: already Monday before 07:00 KL gives the same day', () => {
    // Monday 26 Oct 06:00 KL
    expect(nextKlSeven(new Date('2026-10-25T22:00:00Z'), 'weekly').toISOString()).toBe('2026-10-25T23:00:00.000Z');
  });
});
