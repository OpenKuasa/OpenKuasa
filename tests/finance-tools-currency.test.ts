import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createBendaharaTools } from '@/lib/ai/finance-tools';
import { saveQuotation } from '@/lib/finance/quotations';

/**
 * The finance assistant writes ringgit only: no currency, rate or default currency in what the model is offered,
 * and none in what reaches the database even when a call carries them.
 */

const CUSTOMER = '6a9c1c7e-2f0b-4a67-9a53-0d4a8f1f6e11';
const DRAFT = '0b6f3f6e-5d0e-4b0f-8f55-1d4b2f2f9a22';
const KEYS = ['currency', 'fx_rate', 'fx_rate_source', 'fx_rate_date', 'default_currency'];

type Call = { kind: string; payload: unknown };

/** A client that answers the few reads and writes these tools make, and records what was written. */
function fakeClient(storedCurrency: string | null) {
  const calls: Call[] = [];
  const chain = (result: unknown) => {
    const q: Record<string, unknown> = {};
    for (const m of ['select', 'eq']) q[m] = () => q;
    q.maybeSingle = async () => result;
    q.single = async () => result;
    return q;
  };
  const client = {
    rpc: async (name: string, args: unknown) => {
      calls.push({ kind: `rpc:${name}`, payload: args });
      return { data: DRAFT, error: null };
    },
    from: (table: string) => ({
      select: () => chain({ data: storedCurrency === null ? null : { currency: storedCurrency }, error: null }),
      insert: (values: unknown) => {
        calls.push({ kind: `insert:${table}`, payload: values });
        return chain({ data: { id: 'c1', ...(values as object) }, error: null });
      },
      update: (values: unknown) => {
        calls.push({ kind: `update:${table}`, payload: values });
        return chain({ data: { id: 'c1', ...(values as object) }, error: null });
      },
    }),
  };
  return { client: client as never, calls };
}

const exec = (tool: unknown, input: unknown) =>
  (tool as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute(input, { toolCallId: 't', messages: [] });
const toolsFor = (stored: string | null) => {
  const { client, calls } = fakeClient(stored);
  return { tools: createBendaharaTools({ client, orgId: 'org1', canWrite: true }) as Record<string, unknown>, calls };
};
const quotation = {
  customer_id: CUSTOMER,
  quote_date: '2026-10-15',
  valid_until: '2026-11-15',
  lines: [{ description: 'Design', quantity: 1, unit_price: 1000, sst_rate: 0 }],
};
const withCurrency = { currency: 'USD', fx_rate: 4.08, fx_rate_source: 'manual', fx_rate_date: null };

describe('the assistant is offered no currency', () => {
  it('has none of the currency keys in the schema of the quotation and contact tools', () => {
    const { tools } = toolsFor(null);
    for (const name of ['saveQuotation', 'createFinanceContact', 'updateFinanceContact']) {
      const schema = z.toJSONSchema((tools[name] as { inputSchema: z.ZodType }).inputSchema, { unrepresentable: 'any', io: 'input' }) as { properties: object };
      const props = Object.keys(schema.properties);
      for (const key of KEYS) expect(props, `${name} offers ${key}`).not.toContain(key);
    }
  });
});

describe('a tool call that carries a currency still writes ringgit', () => {
  it('saves a new quotation with no currency, rate or source', async () => {
    const { tools, calls } = toolsFor(null);
    expect(await exec(tools.saveQuotation, { ...quotation, ...withCurrency })).toEqual({ ok: true, data: { id: DRAFT } });
    const sent = calls.find((c) => c.kind === 'rpc:finance_save_quotation')!.payload as { quotation: object };
    for (const key of KEYS) expect(Object.keys(sent.quotation), key).not.toContain(key);
  });

  it('edits a ringgit draft', async () => {
    const { tools, calls } = toolsFor('MYR');
    expect(await exec(tools.saveQuotation, { ...quotation, id: DRAFT, ...withCurrency })).toEqual({ ok: true, data: { id: DRAFT } });
    expect(calls.map((c) => c.kind)).toEqual(['rpc:finance_save_quotation']);
  });

  it('refuses to edit a draft in another currency, in a plain sentence, and writes nothing', async () => {
    const { tools, calls } = toolsFor('USD');
    const out = await exec(tools.saveQuotation, { ...quotation, id: DRAFT });
    expect(out).toEqual({
      ok: false,
      error: 'This quotation is not in ringgit. Edit it on the Quotations screen, where its currency and exchange rate are shown.',
    });
    expect(calls).toEqual([]);
  });

  it('creates a contact with no default currency', async () => {
    const { tools, calls } = toolsFor(null);
    await exec(tools.createFinanceContact, { name: 'Acme', is_customer: true, is_supplier: false, default_currency: 'USD' });
    const values = calls.find((c) => c.kind === 'insert:finance_contacts')!.payload as { default_currency: unknown };
    expect(values.default_currency).toBeNull();
  });

  it('leaves a contact’s default currency alone when updating', async () => {
    const { tools, calls } = toolsFor(null);
    await exec(tools.updateFinanceContact, { id: DRAFT, name: 'Acme Sdn Bhd', default_currency: 'USD' });
    const values = calls.find((c) => c.kind === 'update:finance_contacts')!.payload as object;
    expect(Object.keys(values)).not.toContain('default_currency');
    expect(await exec(tools.updateFinanceContact, { id: DRAFT, default_currency: 'USD' })).toEqual({
      ok: false,
      error: 'Nothing to update.',
    });
  });
});

describe('saving a draft without sending its currency', () => {
  const ctx = (stored: string) => ({ ...fakeClient(stored), orgId: 'org1' });
  const jpy = (unit_price: number) => ({ ...quotation, id: DRAFT, lines: [{ ...quotation.lines[0], unit_price }] });

  it('holds a JPY draft to whole amounts', async () => {
    const { client, orgId } = ctx('JPY');
    expect(await saveQuotation({ client, orgId } as never, jpy(1500.5))).toEqual({ ok: false, error: 'JPY has no cents: enter whole amounts.' });
    expect(await saveQuotation({ client, orgId } as never, jpy(1500))).toEqual({ ok: true, data: { id: DRAFT } });
  });

  it('lets a ringgit or USD draft take cents', async () => {
    for (const stored of ['MYR', 'USD']) {
      const { client, orgId } = ctx(stored);
      expect(await saveQuotation({ client, orgId } as never, jpy(1500.5))).toEqual({ ok: true, data: { id: DRAFT } });
    }
  });
});
