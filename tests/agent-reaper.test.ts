import { describe, expect, it } from 'vitest';
import { reapStaleRuns, RUN_MAX_AGE_MS } from '@/lib/agents/runner';

type Rec = { table: string; patch: unknown; eqs: [string, unknown][]; lts: [string, unknown][] };

function fakeClient() {
  const calls: Rec[] = [];
  const client = {
    from(table: string) {
      const rec: Rec = { table, patch: undefined, eqs: [], lts: [] };
      const b = {
        update(patch: unknown) {
          rec.patch = patch;
          return b;
        },
        eq(c: string, v: unknown) {
          rec.eqs.push([c, v]);
          return b;
        },
        lt(c: string, v: unknown) {
          rec.lts.push([c, v]);
          return b;
        },
        then(resolve: (v: { error: null }) => void) {
          calls.push(rec);
          resolve({ error: null });
        },
      };
      return b;
    },
  };
  return { client, calls };
}

describe('reapStaleRuns', () => {
  it("fails runs stuck in 'running' past the max age, scoped to running + older than the cutoff", async () => {
    const { client, calls } = fakeClient();
    await reapStaleRuns(client as never);

    expect(calls).toHaveLength(1);
    const c = calls[0];
    expect(c.table).toBe('agent_runs');
    expect(c.patch).toMatchObject({ status: 'failed', error: 'timed out' });
    expect(c.patch).toHaveProperty('finished_at');
    // only in-flight runs are reaped
    expect(c.eqs).toContainEqual(['status', 'running']);
    // and only those older than now - RUN_MAX_AGE_MS
    expect(c.lts).toHaveLength(1);
    expect(c.lts[0][0]).toBe('started_at');
    const cutoff = new Date(c.lts[0][1] as string).getTime();
    expect(Date.now() - cutoff).toBeGreaterThanOrEqual(RUN_MAX_AGE_MS - 5_000);
    expect(Date.now() - cutoff).toBeLessThanOrEqual(RUN_MAX_AGE_MS + 5_000);
    // the global sweep is not scoped to one workspace
    expect(c.eqs.map(([col]) => col)).not.toContain('org_id');
  });

  it('given a workspace, sweeps only that workspace', async () => {
    const { client, calls } = fakeClient();
    await reapStaleRuns(client as never, 'org-7');
    expect(calls).toHaveLength(1);
    expect(calls[0].eqs).toContainEqual(['status', 'running']);
    expect(calls[0].eqs).toContainEqual(['org_id', 'org-7']);
    expect(calls[0].lts.map(([col]) => col)).toEqual(['started_at']);
  });

  it('keeps the cost a stuck run had already recorded', async () => {
    const { client, calls } = fakeClient();
    await reapStaleRuns(client as never);
    // A run writes its known-or-estimated spend before each paid step; reaping must not zero it.
    expect(calls[0].patch).not.toHaveProperty('cost_cents');
  });
});
