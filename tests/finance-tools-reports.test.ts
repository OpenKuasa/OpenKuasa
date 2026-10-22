import { describe, expect, it, vi } from 'vitest';

const pl = vi.hoisted(() => ({
  period: { from: '2026-01', to: '2026-12' },
  rows: [{ name: 'Rent', amount: 1200 }],
  net: -1200,
  periodArgs: [] as unknown[],
}));

// Hoisted by vitest above the import below, so the mocks reach createBendaharaTools.
vi.mock('@/lib/finance/reports', async (orig) => ({
  ...(await orig<typeof import('@/lib/finance/reports')>()),
  profitAndLoss: () => pl,
  monthlyTotals: () => ({ totals: [], unassigned: 0 }),
  periodFor: (...args: unknown[]) => {
    pl.periodArgs = args;
    return pl.period;
  },
}));
// The workspace's financial year ends in June: the report tools pass it to periodFor.
vi.mock('@/lib/finance/settings', async (orig) => ({
  ...(await orig<typeof import('@/lib/finance/settings')>()),
  financeSettingsOrDefault: async () => ({ yearEndMonth: 6, lockDate: null, updatedAt: null }),
}));
vi.mock('@/lib/finance/ledger', async (orig) => ({
  ...(await orig<typeof import('@/lib/finance/ledger')>()),
  listLedgerLines: async () => [],
  listLedgerAccounts: async () => [],
}));

const { createBendaharaTools } = await import('@/lib/ai/finance-tools');

type Exec = { execute: (i: unknown, o: unknown) => Promise<unknown> };
const tools = createBendaharaTools({ client: {} as never, orgId: 'org-1', canWrite: false }) as unknown as Record<string, Exec>;
const opts = { toolCallId: 't', messages: [] };

describe('Bendahara report read tools', () => {
  it('offers all six report tools, to a read-only user', () => {
    for (const name of ['profitAndLoss', 'balanceSheet', 'trialBalance', 'agedReceivables', 'agedPayables', 'cashFlow']) {
      expect(tools[name], name).toBeDefined();
    }
  });

  it('returns the P&L the library computes, not its own math', async () => {
    const out = await tools.profitAndLoss.execute({ period: 'this_year' }, opts);
    expect(out).toBe(pl); // the exact library object: statement shape (rows/period), not re-summed
  });

  it("works the period out from the workspace's financial year end", async () => {
    for (const name of ['profitAndLoss', 'balanceSheet', 'trialBalance', 'cashFlow']) {
      pl.periodArgs = [];
      await tools[name].execute({ period: 'this_year' }, opts);
      expect(pl.periodArgs[0], name).toBe('this_year');
      expect(pl.periodArgs[3], name).toBe(6);
    }
  });
});
