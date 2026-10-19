import { describe, expect, test } from 'vitest';
import { cleanUp, EVAL_TAG, type Workspace } from '../evals/tuah/harness';

/**
 * Pins Task 12's cleanUp: every finance table the Tuah finance cases seed must be targeted for deletion, and
 * each finance delete must be TAG-SCOPED (never org-only), so a seeded row is never left behind and a real
 * production row is never nuked (see [[live-test-leftovers]]). This test NEVER touches a database — a
 * recording mock stands in for the Supabase client — so it is prod-safe to run anywhere. It fails if a
 * finance table is dropped from cleanUp, or if a finance delete is weakened to org-only.
 *
 * (It proves cleanUp ISSUES tag-scoped deletes, not that the books accept them: finance_*_guard refuses to
 * delete a numbered or posted row, which is why only a draft RFQ is removable. See the Task 12 report.)
 */

type Chain = { table: string; deleted: boolean; tagScoped: boolean };

/**
 * A stand-in Supabase client. Each `.from(table)` starts a chain; every builder method returns that same
 * chain (so the whole fluent call is one record), awaiting it resolves to one generic row (so every
 * conditional branch in cleanUp runs), and the chain notes whether `.delete()` ran and whether a tag filter
 * was applied: `.ilike(col, '%evalcheck%')`, `.in('supplier_id', ids)` (the tagged suppliers), or
 * `.eq('id', id)` (one tagged contact). An org-only delete records `tagScoped: false`.
 */
function recordingClient() {
  const chains: Chain[] = [];
  // Both lookups in cleanUp read an `id` / a `promoted_contact_id`; one row carrying both drives every branch.
  const result = { data: [{ id: 'seed', promoted_contact_id: 'seed' }], error: null } as const;
  function startChain(table: string): unknown {
    const chain: Chain = { table, deleted: false, tagScoped: false };
    chains.push(chain);
    const proxy = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') {
            return (resolve: (value: typeof result) => unknown) => resolve(result);
          }
          if (prop === 'delete') chain.deleted = true;
          return (...args: unknown[]) => {
            if (prop === 'ilike' && args.some((a) => typeof a === 'string' && a.includes(EVAL_TAG))) chain.tagScoped = true;
            if (prop === 'in' && args[0] === 'supplier_id') chain.tagScoped = true;
            if (prop === 'eq' && args[0] === 'id') chain.tagScoped = true;
            return proxy;
          };
        },
      },
    );
    return proxy;
  }
  const client = { from: (table: string) => startChain(table) };
  return { client, chains };
}

describe('Tuah eval finance cleanup', () => {
  test('cleanUp issues a tag-scoped delete for every finance table the cases seed', async () => {
    const { client, chains } = recordingClient();
    await cleanUp({ client, orgId: 'org-under-test' } as unknown as Workspace);

    const financeDeletes = chains.filter((c) => c.deleted && c.table.startsWith('finance_'));
    for (const table of ['finance_contacts', 'finance_rfqs', 'finance_purchase_orders', 'finance_journals']) {
      const forTable = financeDeletes.filter((c) => c.table === table);
      expect(forTable.length, `cleanUp must delete ${table}`).toBeGreaterThan(0);
      expect(
        forTable.every((c) => c.tagScoped),
        `every ${table} delete must be tag-scoped (ilike %${EVAL_TAG}% / in supplier_id / eq id), never org-only`,
      ).toBe(true);
    }
    // Nothing in finance may be deleted org-only — the "nuke real production rows" failure.
    expect(
      financeDeletes.every((c) => c.tagScoped),
      'a finance delete is org-only (no tag filter)',
    ).toBe(true);
  });
});
