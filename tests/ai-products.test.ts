import { describe, expect, it } from 'vitest';
import type { Tool } from 'ai';
import {
  combineToolkits,
  crmProduct,
  hireProduct,
  peopleProduct,
  reachProduct,
  type ProductToolkit,
} from '@/lib/ai/products';
import { createSeedReachData } from '@/lib/reach/seed';
import { createSeedHireData } from '@/lib/hire/seed';
import { createSeedPeopleData } from '@/lib/people/seed';

const reach = (canWrite: boolean) =>
  reachProduct({
    data: createSeedReachData(),
    write: canWrite ? { ctx: { client: {} as never, orgId: 'org1' }, canWrite: true } : undefined,
  });
const crm = (canWrite: boolean) =>
  crmProduct({ client: {} as never, orgId: 'org1', userId: 'user1', canWrite });
const hire = (canWrite: boolean) =>
  hireProduct({
    data: createSeedHireData(),
    write: canWrite ? { ctx: { client: {} as never, orgId: 'org1' }, canWrite: true } : undefined,
  });
const people = (canWrite: boolean) =>
  peopleProduct({
    data: createSeedPeopleData(),
    viewer: { employeeId: null, isHr: canWrite, isDemo: false },
    write: canWrite
      ? { ctx: { client: {} as never, orgId: 'org1' }, tier: 'hr', employeeId: null, receipt: null, userId: 'u1' }
      : undefined,
  });

const describes = (tool: Tool) => String(tool.description ?? '').toLowerCase();

describe('product toolkits', () => {
  it('puts lookups and changes on separate sides', () => {
    const jebat = reach(true);
    expect(Object.keys(jebat.read)).toContain('getCampaigns');
    expect(Object.keys(jebat.write)).toContain('deleteCampaign');
    expect(Object.keys(jebat.read)).not.toContain('deleteCampaign');

    const kasturi = crm(true);
    expect(Object.keys(kasturi.read)).toEqual([
      'listCrmContacts',
      'listDeals',
      'listPipelines',
      'getDealStats',
      'listFollowUps',
      'getCalendar',
      'getBillingSummary',
      'listBillingInvoices',
    ]);
    expect(Object.keys(kasturi.write)).toContain('deleteContact');
  });

  it('gives someone who may not change anything no change tools at all', () => {
    expect(Object.keys(reach(false).write)).toEqual([]);
    expect(Object.keys(crm(false).write)).toEqual([]);
    expect(Object.keys(crm(false).read).length).toBeGreaterThan(0);
  });

  // The safety net: a change tool left on the lookup side would run with no
  // Approve card. Every tool that says it needs approval must be a change.
  it('has every tool that needs approval on the change side', () => {
    for (const product of [reach(true), crm(true)]) {
      for (const [name, tool] of Object.entries(product.read)) {
        expect(describes(tool as Tool), `${product.name}: ${name}`).not.toContain('approval');
      }
      for (const [name, tool] of Object.entries(product.write)) {
        expect(describes(tool as Tool), `${product.name}: ${name}`).toContain('approval');
      }
    }
  });

  it('gives Lekiu its HR lookups, and HR changes only to someone who may make them', () => {
    const lekiu = people(true);
    expect(Object.keys(lekiu.read)).toContain('listEmployees');
    expect(Object.keys(lekiu.read)).toContain('getPayrollSummary');
    expect(Object.keys(lekiu.write)).toContain('decideLeave');
    expect(Object.keys(lekiu.read)).not.toContain('decideLeave');
    expect(Object.keys(people(false).write)).toEqual([]);
  });
});

describe('combineToolkits', () => {
  it('asks for approval on every change, from every product, and on nothing else', () => {
    const products = [reach(true), crm(true), hire(true), people(true)];
    const { tools, toolApproval } = combineToolkits(products);
    const changes = products.flatMap((p) => Object.keys(p.write)).sort();
    expect(Object.keys(toolApproval ?? {}).sort()).toEqual(changes);
    // Every HR change is gated too (its description does not need the word, the map does the gating).
    expect(Object.keys(toolApproval ?? {})).toContain('decideLeave');
    expect(Object.keys(tools).length).toBe(
      products.reduce((n, p) => n + Object.keys(p.read).length + Object.keys(p.write).length, 0),
    );
  });

  it('asks for nothing when there is nothing to change', () => {
    expect(combineToolkits([reach(false), crm(false)]).toolApproval).toBeUndefined();
  });

  it('combines all four products (Tuah single-agent) without a tool-name clash', () => {
    const products = [reach(true), crm(true), hire(true), people(true)];
    const total = products.reduce(
      (n, p) => n + Object.keys(p.read).length + Object.keys(p.write).length,
      0,
    );
    const { tools } = combineToolkits(products);
    // No throw, and nothing silently dropped: every tool survives the merge.
    expect(Object.keys(tools).length).toBe(total);
  });

  it('refuses two products with the same tool name', () => {
    const one: ProductToolkit = { key: 'reach', name: 'A', read: reach(false).read, write: {} };
    const two: ProductToolkit = { key: 'crm', name: 'B', read: reach(false).read, write: {} };
    expect(() => combineToolkits([one, two])).toThrow(/both have a tool called/);
  });
});
