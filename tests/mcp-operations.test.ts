// tests/mcp-operations.test.ts
import { describe, expect, it } from 'vitest';
import { buildOperations, listOperations } from '@/lib/mcp/operations';
import { crmProduct, financeProduct, hireProduct, peopleProduct, reachProduct } from '@/lib/ai/products';
import type { TuahAccess } from '@/lib/ai/tuah-access';

const client = {} as never;
const stub = {} as never;

function access(role: 'owner' | 'viewer'): TuahAccess {
  const canWrite = role !== 'viewer';
  const write = canWrite ? { ctx: { client, orgId: 'o1' }, canWrite: true, canManageAgents: true } : undefined;
  return {
    reach: { data: stub, write },
    crm: { client, orgId: 'o1', userId: 'u1', canWrite, requireLostReason: false },
    hire: { data: stub, write, origin: null },
    people: {
      data: stub,
      viewer: { employeeId: 'e1', isHr: canWrite, isDemo: false, managesTeam: false } as never,
      write: canWrite ? ({ client, orgId: 'o1', canWrite: true } as never) : undefined,
    },
    finance: { client, orgId: 'o1', canWrite },
  } as TuahAccess;
}

describe('buildOperations', () => {
  it('has every tool Tuah has for an owner', () => {
    const a = access('owner');
    const expected = new Set<string>();
    for (const p of [reachProduct(a.reach), crmProduct(a.crm!), hireProduct(a.hire), peopleProduct(a.people!), financeProduct(a.finance!)]) {
      for (const n of [...Object.keys(p.read), ...Object.keys(p.write)]) expected.add(n);
    }
    expect(new Set(buildOperations(a).byName.keys())).toEqual(expected);
  });

  it('viewer gets read operations only', () => {
    const ops = buildOperations(access('viewer'));
    expect([...ops.byName.values()].some((o) => o.kind === 'write')).toBe(false);
    expect(listOperations(ops).some((o) => o.kind === 'write')).toBe(false);
  });

  it('marks writes by the *_WRITE_TOOL_NAMES lists', () => {
    const ops = buildOperations(access('owner'));
    expect(ops.byName.get('deleteCandidate')?.kind).toBe('write');
    expect(ops.byName.get('listCandidates')?.kind).toBe('read');
  });

  it('gates cover the guarded writes', () => {
    const gates = buildOperations(access('owner')).gates!;
    expect(typeof gates.deleteCandidate).toBe('function');
    expect(typeof gates.postJournal).toBe('function');
    const roster = Object.keys(gates).find((n) => /roster|shift/i.test(n));
    expect(roster).toBeDefined();
    expect(typeof gates[roster!]).toBe('function');
  });

  it('gives each operation a JSON Schema and filters by product', () => {
    const ops = buildOperations(access('owner'));
    const list = listOperations(ops, 'hire');
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((o) => o.product === 'hire')).toBe(true);
    for (const o of listOperations(ops)) expect((o.inputSchema as { type?: string }).type).toBe('object');
  });
});

describe('input schemas', () => {
  it('keeps the properties of a tool whose schema has a transform', () => {
    const ops = buildOperations(access('owner'));
    const schema = ops.byName.get('saveInvoice')!.inputSchema as { properties?: Record<string, unknown> };
    expect(Object.keys(schema.properties ?? {}).length).toBeGreaterThan(0);
  });
});
