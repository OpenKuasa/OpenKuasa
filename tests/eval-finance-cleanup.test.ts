import { describe, expect, test } from 'vitest';
import { cleanUp, type Workspace } from '../evals/tuah/harness';

/**
 * Pins Task 12's cleanUp: every finance table the Tuah finance cases seed must be targeted for deletion, so a
 * seeded row is never silently left behind in the production workspace the eval runs against (see
 * [[live-test-leftovers]]). This test NEVER touches a database — a recording mock stands in for the Supabase
 * client — so it is prod-safe to run anywhere. It fails if a finance table is dropped from cleanUp.
 *
 * (It proves cleanUp ISSUES the deletes, not that the books accept them: finance_*_guard refuses to delete a
 * numbered or posted row, which is why only a draft RFQ is removable. See the Task 12 report.)
 */

/**
 * A stand-in Supabase client: every query builder method returns the same thenable builder, awaiting it
 * resolves to one generic row (so each conditional branch in cleanUp runs and its deletes are recorded), and
 * the table of every builder on which `.delete()` was called is collected.
 */
function recordingClient() {
  const deletedTables = new Set<string>();
  // Both lookups in cleanUp read an `id` / a `promoted_contact_id`; one row carrying both drives every branch.
  const result = { data: [{ id: 'seed', promoted_contact_id: 'seed' }], error: null } as const;
  const builder = (table: string): unknown =>
    new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') {
            return (resolve: (value: typeof result) => unknown) => resolve(result);
          }
          if (prop === 'delete') deletedTables.add(table);
          // Every builder method (select, eq, ilike, in, not, update, delete, …) returns the builder again.
          return () => builder(table);
        },
      },
    );
  const client = { from: (table: string) => builder(table) };
  return { client, deletedTables };
}

describe('Tuah eval finance cleanup', () => {
  test('cleanUp targets every finance table the finance cases seed', async () => {
    const { client, deletedTables } = recordingClient();
    await cleanUp({ client, orgId: 'org-under-test' } as unknown as Workspace);
    const deleted = [...deletedTables];
    for (const table of ['finance_contacts', 'finance_rfqs', 'finance_purchase_orders', 'finance_journals']) {
      expect(deleted, `cleanUp must delete ${table}`).toContain(table);
    }
  });
});
