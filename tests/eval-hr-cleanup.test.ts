import { describe, expect, test } from 'vitest';
import { cleanUp, EVAL_TAG, type Workspace } from '../evals/tuah/harness';

/**
 * Pins cleanUp for the HR (Lekiu) cases: the departments and the staff they seed are removed, and only those.
 * Staff go through `hr_delete_employee` one tagged id at a time (as the app deletes them), before the
 * departments they point at; departments go by their tagged name. This test NEVER touches a database: a
 * recording stand-in replaces the Supabase client.
 */

type Call = { kind: 'from' | 'rpc'; name: string; deleted: boolean; tagScoped: boolean; args?: unknown };

function recordingClient() {
  const calls: Call[] = [];
  const rows = { data: [{ id: '5e1f0c2a-3b4d-4e5f-8a6b-7c8d9e0f1a2b', promoted_contact_id: 'seed' }], error: null } as const;
  function chain(name: string): unknown {
    const call: Call = { kind: 'from', name, deleted: false, tagScoped: false };
    calls.push(call);
    const proxy: unknown = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') return (resolve: (value: typeof rows) => unknown) => resolve(rows);
          if (prop === 'delete') call.deleted = true;
          return (...args: unknown[]) => {
            if (prop === 'ilike' && args.some((a) => typeof a === 'string' && a.includes(EVAL_TAG))) call.tagScoped = true;
            if ((prop === 'in' && args[0] === 'supplier_id') || (prop === 'eq' && args[0] === 'id')) call.tagScoped = true;
            return proxy;
          };
        },
      },
    );
    return proxy;
  }
  const client = {
    from: (table: string) => chain(table),
    rpc: async (name: string, args: unknown) => {
      calls.push({ kind: 'rpc', name, deleted: false, tagScoped: false, args });
      return { data: { id: '5e1f0c2a-3b4d-4e5f-8a6b-7c8d9e0f1a2b', name: 'x' }, error: null };
    },
  };
  return { client, calls };
}

describe('Tuah eval HR cleanup', () => {
  test('removes each tagged employee through hr_delete_employee, then the tagged departments, never org-only', async () => {
    const { client, calls } = recordingClient();
    await cleanUp({ client, orgId: 'org-under-test' } as unknown as Workspace);

    const employeeRead = calls.find((c) => c.kind === 'from' && c.name === 'hr_employees' && !c.deleted);
    expect(employeeRead?.tagScoped, 'tagged staff are found by their tagged work email').toBe(true);
    const removal = calls.findIndex((c) => c.kind === 'rpc' && c.name === 'hr_delete_employee');
    expect(removal, 'each tagged employee is removed through hr_delete_employee').toBeGreaterThan(-1);
    expect(calls[removal].args).toEqual({ p_org: 'org-under-test', p_employee: '5e1f0c2a-3b4d-4e5f-8a6b-7c8d9e0f1a2b' });
    // No employee is ever deleted straight from the table.
    expect(calls.some((c) => c.kind === 'from' && c.name === 'hr_employees' && c.deleted)).toBe(false);

    const departments = calls.filter((c) => c.kind === 'from' && c.name === 'hr_departments' && c.deleted);
    expect(departments.length, 'cleanUp must delete the tagged departments').toBeGreaterThan(0);
    expect(departments.every((c) => c.tagScoped), 'every department delete is tag-scoped, never org-only').toBe(true);
    // Staff before the departments they point at.
    expect(calls.indexOf(departments[0])).toBeGreaterThan(removal);
  });
});
