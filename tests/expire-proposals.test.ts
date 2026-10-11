import { describe, expect, it } from 'vitest';
import { expireProposals } from '@/lib/agents/runner';

function fakeService() {
  const calls: Record<string, unknown> = {};
  const client = {
    from(table: string) {
      calls.table = table;
      return {
        update(patch: unknown) {
          calls.update = patch;
          return {
            eq(col: string, val: unknown) {
              calls.eqCol = col;
              calls.eqVal = val;
              return {
                lte: async (col2: string, val2: unknown) => {
                  calls.lteCol = col2;
                  calls.lteVal = val2;
                  return { error: null };
                },
              };
            },
          };
        },
      };
    },
  } as never;
  return { client, calls };
}

describe('expireProposals', () => {
  it('flips pending proposals past expires_at to expired', async () => {
    const { client, calls } = fakeService();
    await expireProposals(client);
    expect(calls.table).toBe('agent_proposals');
    expect(calls.update).toMatchObject({ status: 'expired' });
    expect(calls.eqCol).toBe('status');
    expect(calls.eqVal).toBe('pending');
    expect(calls.lteCol).toBe('expires_at');
    expect(typeof calls.lteVal).toBe('string');
  });
});
