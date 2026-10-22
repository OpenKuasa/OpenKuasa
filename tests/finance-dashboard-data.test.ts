import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadDashboardInputs } from '@/lib/finance/dashboard-data';
import type { FinanceWriteContext } from '@/lib/finance/result';

/**
 * The one parallel read behind the Bendahara dashboards, on a fake client that answers each table with the
 * rows (or the error) given for it. A table not given reads as empty.
 */
type Answer = { data?: unknown[]; error?: { message: string } };

function ctxFor(answers: Record<string, Answer>): FinanceWriteContext {
  const client = {
    from(table: string) {
      const chain: Record<string, unknown> = {};
      for (const method of ['select', 'eq', 'neq', 'gt', 'in', 'order']) chain[method] = () => chain;
      const answer = answers[table] ?? {};
      const result = { data: answer.error ? null : (answer.data ?? []), error: answer.error ?? null };
      chain.range = () => Promise.resolve(result);
      // The bank accounts read ends on order(), with no range.
      chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
      return chain;
    },
  };
  return { client, orgId: 'org1' } as unknown as FinanceWriteContext;
}

const invoice = { customer_id: 'c1', customer_name: 'Acme', due_date: '2026-10-30', balance: '120.50', display_status: 'sent' };
const bill = { supplier_id: 's1', supplier_name: 'Bolt', due_date: '2026-10-31', balance: '80', display_status: 'pending' };

afterEach(() => vi.restoreAllMocks());

describe('loadDashboardInputs', () => {
  it('returns every read, the receivables and payables mapped to open documents', async () => {
    const out = await loadDashboardInputs(
      ctxFor({
        finance_ledger_lines: { data: [{ entry_date: '2026-10-01', debit: '5', credit: '0' }] },
        finance_invoice_totals: { data: [invoice] },
        supplier_bill_totals: { data: [bill] },
      }),
    );
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0].debit).toBe(5);
    expect(out.accounts).toEqual([]);
    expect(out.receivables).toEqual([{ party_id: 'c1', party_name: 'Acme', due_date: '2026-10-30', balance: 120.5 }]);
    expect(out.payables).toEqual([{ party_id: 's1', party_name: 'Bolt', due_date: '2026-10-31', balance: 80 }]);
    expect(out.bankAccounts).toEqual([]);
    expect(out.bankTransactions).toEqual([]);
  });

  it('gives null for a bank movements read that fails, logs it, and keeps the rest', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = await loadDashboardInputs(
      ctxFor({
        finance_invoice_totals: { data: [invoice] },
        finance_bank_transactions: { error: { message: 'boom' } },
      }),
    );
    expect(out.bankTransactions).toBeNull();
    expect(out.receivables).toHaveLength(1);
    expect(out.bankAccounts).toEqual([]);
    expect(log).toHaveBeenCalledWith('[finance] dashboard: the bank movements could not be read:', expect.anything());
  });

  it('rejects when the ledger lines read fails', async () => {
    await expect(loadDashboardInputs(ctxFor({ finance_ledger_lines: { error: { message: 'down' } } }))).rejects.toBeTruthy();
  });
});
