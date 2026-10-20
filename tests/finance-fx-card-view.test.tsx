import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { BankingView } from '@/components/finance/banking-view';
import { workspaceUsesForeignCurrency } from '@/lib/finance/fx-card-gate';

/**
 * The real gate: a workspace deals in another currency when one contact's default currency, or one quotation's,
 * invoice's, supplier bill's or bank or cash account's currency, is not ringgit. A ringgit-only workspace's
 * Banking does not draw the rates card.
 */

type Answer = { data: { id: string }[] | null; error: { message: string } | null };

/** A client whose two reads answer as given, and which records the filters each was asked with. */
type Table = 'finance_contacts' | 'finance_quotations' | 'finance_invoices' | 'supplier_bills' | 'finance_accounts';
function fakeClient(answers: Partial<Record<Table, Answer>>) {
  const calls: { table: string; filters: [string, string, string][]; limit: number | null }[] = [];
  const client = {
    from(table: Table) {
      const call = { table, filters: [] as [string, string, string][], limit: null as number | null };
      calls.push(call);
      const query = {
        select: () => query,
        eq: (column: string, value: string) => (call.filters.push(['eq', column, value]), query),
        neq: (column: string, value: string) => (call.filters.push(['neq', column, value]), query),
        limit: (n: number) => ((call.limit = n), Promise.resolve(answers[table] ?? none)),
      };
      return query;
    },
  };
  return { client: client as never, calls };
}
const none: Answer = { data: [], error: null };
const one: Answer = { data: [{ id: 'x' }], error: null };

vi.mock('@/components/charts', () => ({ AreaTrend: () => null, RadialGauge: () => null }));

const base = { accounts: [], rows: [], today: '2026-10-15', followClock: false };
const usd = { currency: 'USD', rate_date: '2026-10-15', unit: 1, middle_rate: 4.0815, rate: 4.0815 };

describe('the exchange-rates card on Banking', () => {
  it('is not asked for by a ringgit-only workspace, and the gate reads one row of each table for the workspace', async () => {
    const { client, calls } = fakeClient({ finance_contacts: none, finance_quotations: none });
    expect(await workspaceUsesForeignCurrency(client, 'org')).toBe(false);
    expect(calls).toEqual([
      { table: 'finance_contacts', filters: [['eq', 'org_id', 'org'], ['neq', 'default_currency', 'MYR']], limit: 1 },
      { table: 'finance_quotations', filters: [['eq', 'org_id', 'org'], ['neq', 'currency', 'MYR']], limit: 1 },
      { table: 'finance_invoices', filters: [['eq', 'org_id', 'org'], ['neq', 'currency', 'MYR']], limit: 1 },
      { table: 'supplier_bills', filters: [['eq', 'org_id', 'org'], ['neq', 'currency', 'MYR']], limit: 1 },
      { table: 'finance_accounts', filters: [['eq', 'org_id', 'org'], ['neq', 'currency', 'MYR']], limit: 1 },
    ]);
  });

  it('is asked for once an invoice is in another currency (stage 3a)', async () => {
    const { client } = fakeClient({ finance_contacts: none, finance_quotations: none, finance_invoices: one });
    expect(await workspaceUsesForeignCurrency(client, 'org')).toBe(true);
  });

  it('is asked for once a supplier bill is in another currency (stage 4a)', async () => {
    const { client } = fakeClient({ supplier_bills: one });
    expect(await workspaceUsesForeignCurrency(client, 'org')).toBe(true);
  });

  it('is asked for once a bank or cash account is in another currency (stage 5a)', async () => {
    const { client } = fakeClient({ finance_accounts: one });
    expect(await workspaceUsesForeignCurrency(client, 'org')).toBe(true);
  });

  it('is left off when the bills or accounts read fails', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { client } = fakeClient({ finance_accounts: { data: null, error: { message: 'boom' } }, supplier_bills: one });
    expect(await workspaceUsesForeignCurrency(client, 'org')).toBe(false);
    spy.mockRestore();
  });

  it('is asked for once a contact has a default currency that is not ringgit', async () => {
    const { client } = fakeClient({ finance_contacts: one, finance_quotations: none });
    expect(await workspaceUsesForeignCurrency(client, 'org')).toBe(true);
  });

  it('is asked for once a quotation is in another currency', async () => {
    const { client } = fakeClient({ finance_contacts: none, finance_quotations: one });
    expect(await workspaceUsesForeignCurrency(client, 'org')).toBe(true);
  });

  it('is left off, not thrown, when a read fails', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { client } = fakeClient({ finance_contacts: { data: null, error: { message: 'boom' } }, finance_quotations: one });
    expect(await workspaceUsesForeignCurrency(client, 'org')).toBe(false);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('is not drawn when the screen passes no rates (a ringgit-only workspace, the sample)', () => {
    expect(renderToStaticMarkup(<BankingView {...base} />)).not.toContain('Exchange rates');
  });

  it('is drawn when the screen passes rates, or passes that they could not be read', () => {
    expect(renderToStaticMarkup(<BankingView {...base} fxRates={[usd]} />)).toContain('Exchange rates');
    expect(renderToStaticMarkup(<BankingView {...base} fxRates={null} />)).toContain('could not be loaded');
  });
});
