import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { AGENTS } from '@/lib/agents/registry';
import {
  AGENT_KEYS,
  agentKeySchema,
  listAgentConfigs,
  setAgentCadence,
  setAgentCadenceInput,
  setAgentCap,
  setAgentCapInput,
  setAgentEnabled,
  setAgentEnabledInput,
} from '@/lib/agents/config';

const ORG = '11111111-1111-1111-1111-111111111111';
const ROW = { id: 'r1', org_id: ORG, agent_key: 'weekly-studio', enabled: true, cadence: 'off', max_cost_cents: 500 };

type Opts = { updateData?: unknown; updateError?: unknown; insertData?: unknown; insertError?: unknown };

// Minimal fake of the chain: from().update().eq().eq().select().maybeSingle()
// and from().insert().select().single().
function fakeClient(opts: Opts = {}) {
  const calls = { from: [] as string[], update: [] as unknown[], eq: [] as Array<[string, unknown]>, insert: [] as unknown[] };
  const client = {
    from(table: string) {
      calls.from.push(table);
      return {
        update(payload: unknown) {
          calls.update.push(payload);
          const chain = {
            eq(col: string, val: unknown) { calls.eq.push([col, val]); return chain; },
            select: () => chain,
            maybeSingle: async () => ({ data: opts.updateData ?? null, error: opts.updateError ?? null }),
          };
          return chain;
        },
        insert(payload: unknown) {
          calls.insert.push(payload);
          return {
            select: () => ({
              single: async () => ({ data: opts.insertData ?? null, error: opts.insertError ?? null }),
            }),
          };
        },
      };
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

describe('agent config input schemas', () => {
  it('rejects an unknown agent_key', () => {
    expect(setAgentEnabledInput.safeParse({ agent_key: 'other', enabled: true }).success).toBe(false);
    expect(setAgentEnabledInput.safeParse({ agent_key: 'weekly-studio', enabled: true }).success).toBe(true);
  });
  it('derives AGENT_KEYS from the registry and rejects keys outside it', () => {
    expect([...AGENT_KEYS]).toEqual([...AGENTS.keys()]);
    expect(agentKeySchema.safeParse('nope').success).toBe(false);
    expect(agentKeySchema.safeParse(AGENT_KEYS[0]).success).toBe(true);
  });
  it('rejects a cadence outside off/daily/weekly', () => {
    expect(setAgentCadenceInput.safeParse({ agent_key: 'weekly-studio', cadence: 'hourly' }).success).toBe(false);
    for (const c of ['off', 'daily', 'weekly']) {
      expect(setAgentCadenceInput.safeParse({ agent_key: 'weekly-studio', cadence: c }).success).toBe(true);
    }
  });
  it('rejects max_cost_cents outside 0..10000 or non-integer', () => {
    const base = { agent_key: 'weekly-studio' };
    expect(setAgentCapInput.safeParse({ ...base, max_cost_cents: -1 }).success).toBe(false);
    expect(setAgentCapInput.safeParse({ ...base, max_cost_cents: 10001 }).success).toBe(false);
    expect(setAgentCapInput.safeParse({ ...base, max_cost_cents: 1.5 }).success).toBe(false);
    expect(setAgentCapInput.safeParse({ ...base, max_cost_cents: 0 }).success).toBe(true);
    expect(setAgentCapInput.safeParse({ ...base, max_cost_cents: 10000 }).success).toBe(true);
  });
});

describe('agent config writes', () => {
  it('updates an existing row scoped by org_id and agent_key, with no insert', async () => {
    const { client, calls } = fakeClient({ updateData: ROW });
    const res = await setAgentEnabled({ client, orgId: ORG }, { agent_key: 'weekly-studio', enabled: true });
    expect(res).toEqual({ ok: true, data: ROW });
    expect(calls.from).toEqual(['agent_configs']);
    expect(calls.eq).toEqual([['org_id', ORG], ['agent_key', 'weekly-studio']]);
    expect(calls.update[0]).toMatchObject({ enabled: true });
    expect(calls.insert).toHaveLength(0);
  });

  it('falls through to insert carrying org_id and agent_key when no row exists', async () => {
    const { client, calls } = fakeClient({ updateData: null, insertData: ROW });
    const res = await setAgentCadence({ client, orgId: ORG }, { agent_key: 'weekly-studio', cadence: 'weekly' });
    expect(res.ok).toBe(true);
    expect(calls.update).toHaveLength(1);
    expect(calls.insert).toEqual([{ org_id: ORG, agent_key: 'weekly-studio', cadence: 'weekly' }]);
  });

  it('takes org_id from ctx and ignores one smuggled into the input', async () => {
    const { client, calls } = fakeClient({ updateData: null, insertData: ROW });
    await setAgentCap(
      { client, orgId: ORG },
      // @ts-expect-error org_id is not part of the input type; prove it is ignored.
      { agent_key: 'weekly-studio', max_cost_cents: 200, org_id: '99999999-9999-9999-9999-999999999999' },
    );
    expect(calls.eq[0]).toEqual(['org_id', ORG]);
    expect(calls.insert).toEqual([{ org_id: ORG, agent_key: 'weekly-studio', max_cost_cents: 200 }]);
  });

  it('rejects invalid input before touching the client', async () => {
    const { client, calls } = fakeClient();
    await expect(setAgentCap({ client, orgId: ORG }, { agent_key: 'weekly-studio', max_cost_cents: 99999 })).rejects.toThrow();
    expect(calls.from).toHaveLength(0);
  });

  it('returns a generic error when the update fails', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client, calls } = fakeClient({ updateError: { message: 'boom' } });
    const res = await setAgentEnabled({ client, orgId: ORG }, { agent_key: 'weekly-studio', enabled: false });
    expect(res).toEqual({ ok: false, error: 'That change could not be saved.' });
    expect(calls.insert).toHaveLength(0);
    spy.mockRestore();
  });

  it('returns a generic error when the insert fails', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = fakeClient({ insertError: { message: 'nope' } });
    const res = await setAgentEnabled({ client, orgId: ORG }, { agent_key: 'weekly-studio', enabled: true });
    expect(res).toEqual({ ok: false, error: 'That change could not be saved.' });
    spy.mockRestore();
  });
});

describe('listAgentConfigs', () => {
  it('selects rows for the given org and returns [] on no data', async () => {
    const eq = vi.fn(async () => ({ data: null, error: null }));
    const select = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ select }));
    const out = await listAgentConfigs({ from } as unknown as SupabaseClient, ORG);
    expect(from).toHaveBeenCalledWith('agent_configs');
    expect(eq).toHaveBeenCalledWith('org_id', ORG);
    expect(out).toEqual([]);
  });

  it('selects the workspace cap columns so the budget strip has real values', async () => {
    // Regression: omitting these made the Agents screen show "RM NaN" once a
    // real agent_configs row existed (the synthetic default has them hard-coded).
    const eq = vi.fn(async () => ({ data: null, error: null }));
    const select = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ select }));
    await listAgentConfigs({ from } as unknown as SupabaseClient, ORG);
    expect(select).toHaveBeenCalledWith(expect.stringContaining('daily_cap_cents'));
    expect(select).toHaveBeenCalledWith(expect.stringContaining('weekly_cap_cents'));
  });
});
