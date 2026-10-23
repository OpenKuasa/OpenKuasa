import { describe, expect, it } from 'vitest';
import type { FinanceAgentRaw } from '@/lib/finance/agent/context';
import { doublingStage, scanFinance, type FinanceNoteInput } from '@/lib/finance/agent/scan';
import { financeAgentNoteInput } from '@/lib/finance/agent/actions';

// 12:00 on Fri 23 Oct 2026 in Kuala Lumpur.
const NOW = new Date('2026-10-23T04:00:00.000Z');
const AS_OF = ' (as of 23 Oct 2026)';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

function raw(over: Partial<FinanceAgentRaw> & { checks?: { key: string; params: Record<string, number> }[] }): FinanceAgentRaw {
  const { checks, ...rest } = over;
  return {
    plan: checks ? { checks } : null,
    invoices: [],
    bills: [],
    drafts: [],
    expenses: [],
    quotations: [],
    bankLines: [],
    sst: null,
    ...rest,
  };
}

const inputs = (r: FinanceAgentRaw) => scanFinance(r, NOW).map((c) => c.input as FinanceNoteInput);

describe('doublingStage', () => {
  it('buckets at n, 2n, 4n, 8n', () => {
    expect(doublingStage(13, 14)).toBeNull();
    expect(doublingStage(14, 14)).toBe(14);
    expect(doublingStage(27, 14)).toBe(14);
    expect(doublingStage(28, 14)).toBe(28);
    expect(doublingStage(55, 14)).toBe(28);
    expect(doublingStage(56, 14)).toBe(56);
    expect(doublingStage(112, 14)).toBe(112);
  });
});

describe('scanFinance', () => {
  it('suggests nothing without a confirmed plan', () => {
    expect(scanFinance(raw({ invoices: [{ id: A, invoiceNo: 'INV-1', customer: 'X', dueDate: '2026-01-01', balance: 5 }] }), NOW)).toEqual([]);
  });

  it('empty sources: every check on an empty workspace proposes nothing and does not throw', () => {
    const all = [
      'invoice_overdue',
      'bill_due_soon',
      'expense_waiting',
      'quotation_expiring',
      'draft_stale',
      'bank_unmatched',
      'sst_period_closing',
    ].map((key) => ({ key, params: { days: 7, min_amount: 0 } }));
    expect(scanFinance(raw({ checks: all }), NOW)).toEqual([]);
  });

  describe('invoice_overdue', () => {
    const check = (days = 14, min_amount = 0) => [{ key: 'invoice_overdue', params: { days, min_amount } }];

    it('notes at 14, 28 and 56 days with the doubling stage, in ringgit', () => {
      const r = raw({
        checks: check(),
        invoices: [
          { id: A, invoiceNo: 'INV-0001', customer: 'Ming Hardware', dueDate: '2026-10-09', balance: 1240 }, // 14
          { id: B, invoiceNo: 'INV-0002', customer: 'Ali', dueDate: '2026-09-25', balance: 10 }, // 28
          { id: C, invoiceNo: 'INV-0003', customer: null, dueDate: '2026-08-28', balance: 5 }, // 56
        ],
      });
      const got = inputs(r);
      expect(got.map((i) => [i.target, i.stage])).toEqual([
        [C, '56'],
        [B, '28'],
        [A, '14'],
      ]);
      expect(got[2]).toEqual({
        entityType: 'finance_invoice',
        entityId: A,
        entityLabel: 'INV-0001',
        body: `INV-0001 to Ming Hardware is 14 days overdue: RM 1,240.00 unpaid.${AS_OF}`,
        target: A,
        stage: '14',
        minAmount: 0,
      });
      expect(got[0].body).toBe(`INV-0003 is 56 days overdue: RM 5.00 unpaid.${AS_OF}`);
      for (const c of scanFinance(r, NOW)) {
        expect(c.action).toBe('createAgentNote');
        expect(c.checkKey).toBe('invoice_overdue');
        expect(financeAgentNoteInput.safeParse(c.input).success).toBe(true);
      }
    });

    it('skips invoices under the threshold, without a balance, or under the minimum amount', () => {
      const r = raw({
        checks: check(14, 1000),
        invoices: [
          { id: A, invoiceNo: 'INV-1', customer: 'X', dueDate: '2026-10-10', balance: 5000 }, // 13 days
          { id: B, invoiceNo: 'INV-2', customer: 'X', dueDate: '2026-01-01', balance: 999.99 },
          { id: C, invoiceNo: 'INV-3', customer: 'X', dueDate: '2026-01-01', balance: 0 },
        ],
      });
      expect(scanFinance(r, NOW)).toEqual([]);
    });

    it('carries the minimum amount so approval can tell the balance fell below it', () => {
      const r = raw({ checks: check(14, 1000), invoices: [{ id: A, invoiceNo: 'INV-1', customer: 'X', dueDate: '2026-09-01', balance: 1500 }] });
      expect(inputs(r)[0].minAmount).toBe(1000);
    });

    it('uses the ringgit balance it was given for a foreign-currency invoice', () => {
      // A USD 100 invoice whose balance_myr is RM 472.30.
      const r = raw({ checks: check(), invoices: [{ id: A, invoiceNo: 'INV-9', customer: 'Acme', dueDate: '2026-09-01', balance: 472.3 }] });
      expect(inputs(r)[0].body).toContain('RM 472.30 unpaid');
    });
  });

  describe('bill_due_soon', () => {
    it('notes a bill before its due date and once after, as separate stages', () => {
      const r = raw({
        checks: [{ key: 'bill_due_soon', params: { days: 7 } }],
        bills: [
          { id: A, billNo: 'BILL-0007', supplier: 'Tenaga', dueDate: '2026-10-30', balance: 320.5 }, // in 7 days
          { id: B, billNo: 'BILL-0008', supplier: 'Maxis', dueDate: '2026-10-20', balance: 99 }, // overdue
          { id: C, billNo: 'BILL-0009', supplier: 'Far', dueDate: '2026-10-31', balance: 50 }, // 8 days out
        ],
      });
      const got = inputs(r);
      expect(got.map((i) => [i.target, i.stage])).toEqual([
        [B, 'overdue'],
        [A, 'due_soon'],
      ]);
      expect(got[0].body).toBe(`BILL-0008 from Maxis was due 20 Oct 2026: RM 99.00 to pay.${AS_OF}`);
      expect(got[1].body).toBe(`BILL-0007 from Tenaga is due 30 Oct 2026: RM 320.50 to pay.${AS_OF}`);
      expect(got[1].entityType).toBe('finance_supplier_bill');
    });

    it('a bill due today is still due soon', () => {
      const r = raw({
        checks: [{ key: 'bill_due_soon', params: { days: 1 } }],
        bills: [{ id: A, billNo: 'BILL-1', supplier: 'S', dueDate: '2026-10-23', balance: 1 }],
      });
      expect(inputs(r)[0].stage).toBe('due_soon');
    });
  });

  it('expense_waiting: counts days from the Malaysian day it was entered', () => {
    const r = raw({
      checks: [{ key: 'expense_waiting', params: { days: 7 } }],
      expenses: [
        // 15 Oct 23:30 KL = 15 Oct 15:30Z: 8 days.
        { id: A, amount: 88.5, vendor: 'Grab', createdAt: '2026-10-15T15:30:00Z' },
        // 16 Oct 00:30 KL = 15 Oct 16:30Z: 7 days.
        { id: B, amount: 12, vendor: null, createdAt: '2026-10-15T16:30:00Z' },
        // 17 Oct: 6 days.
        { id: C, amount: 1, vendor: 'X', createdAt: '2026-10-17T04:00:00Z' },
      ],
    });
    const got = inputs(r);
    expect(got.map((i) => i.target)).toEqual([A, B]);
    expect(got[0]).toMatchObject({
      entityType: 'finance_expense',
      entityLabel: 'Expense to Grab',
      body: `Expense of RM 88.50 to Grab has waited 8 days for approval.${AS_OF}`,
      stage: '7',
    });
    expect(got[1].body).toBe(`Expense of RM 12.00 has waited 7 days for approval.${AS_OF}`);
  });

  it('quotation_expiring: within the window, once per expiry date, not after it expired', () => {
    const r = raw({
      checks: [{ key: 'quotation_expiring', params: { days: 7 } }],
      quotations: [
        { id: A, quotationNo: 'QT-0004', customer: 'Ming', validUntil: '2026-10-28' },
        { id: B, quotationNo: 'QT-0005', customer: 'Ali', validUntil: '2026-10-22' }, // expired
        { id: C, quotationNo: 'QT-0006', customer: 'Abu', validUntil: '2026-10-31' }, // 8 days
      ],
    });
    const got = inputs(r);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({
      entityType: 'finance_quotation',
      entityLabel: 'QT-0004',
      body: `QT-0004 to Ming expires 28 Oct 2026 with no answer.${AS_OF}`,
      target: A,
      stage: '2026-10-28',
    });
  });

  it('draft_stale: draft invoices and bills untouched for N days', () => {
    const r = raw({
      checks: [{ key: 'draft_stale', params: { days: 14 } }],
      drafts: [
        { kind: 'invoice', id: A, party: 'Ming', updatedAt: '2026-10-01T02:00:00Z' }, // 22 days
        { kind: 'bill', id: B, party: 'Tenaga', updatedAt: '2026-09-20T02:00:00Z' }, // 33 days
        { kind: 'invoice', id: C, party: null, updatedAt: '2026-10-20T02:00:00Z' }, // 3 days
      ],
    });
    const got = inputs(r);
    expect(got.map((i) => [i.entityType, i.target, i.stage])).toEqual([
      ['finance_supplier_bill', B, '28'],
      ['finance_invoice', A, '14'],
    ]);
    expect(got[1].body).toBe(`Draft invoice to Ming hasn't been touched for 22 days.${AS_OF}`);
    expect(got[0].body).toBe(`Draft bill from Tenaga hasn't been touched for 33 days.${AS_OF}`);
  });

  it('bank_unmatched: one note per account, staged by its oldest line', () => {
    const r = raw({
      checks: [{ key: 'bank_unmatched', params: { days: 14 } }],
      bankLines: [
        { accountId: A, account: 'Main Bank', currency: 'MYR', lineDate: '2026-09-20', amount: 100 }, // 33 days
        { accountId: A, account: 'Main Bank', currency: 'MYR', lineDate: '2026-10-05', amount: 50.25 }, // 18 days
        { accountId: A, account: 'Main Bank', currency: 'MYR', lineDate: '2026-10-20', amount: 999 }, // too new
        { accountId: B, account: 'Petty', currency: 'MYR', lineDate: '2026-10-09', amount: 7 }, // 14 days
        { accountId: C, account: 'New', currency: 'MYR', lineDate: '2026-10-10', amount: 7 }, // 13 days
      ],
    });
    const got = inputs(r);
    expect(got.map((i) => [i.target, i.stage])).toEqual([
      [A, '28'],
      [B, '14'],
    ]);
    expect(got[0]).toMatchObject({
      entityType: 'finance_bank_account',
      entityId: A,
      entityLabel: 'Main Bank',
      body: `Main Bank has 2 statement lines older than 14 days with nothing matched (RM 150.25).${AS_OF}`,
    });
    expect(got[1].body).toBe(`Petty has 1 statement line older than 14 days with nothing matched (RM 7.00).${AS_OF}`);
  });

  it('bank_unmatched: a foreign-currency account totals in its own currency, not RM', () => {
    const r = raw({
      checks: [{ key: 'bank_unmatched', params: { days: 14 } }],
      bankLines: [
        { accountId: A, account: 'USD Account', currency: 'USD', lineDate: '2026-09-20', amount: 1000 },
        { accountId: A, account: 'USD Account', currency: 'USD', lineDate: '2026-09-21', amount: 250.5 },
      ],
    });
    expect(inputs(r)[0].body).toBe(
      `USD Account has 2 statement lines older than 14 days with nothing matched (USD 1,250.50).${AS_OF}`,
    );
  });

  describe('sst_period_closing', () => {
    const check = [{ key: 'sst_period_closing', params: { days: 10 } }];
    // Periods start in odd months: 1 Sep – 31 Oct 2026 holds 23 Oct; it ends in 8 days.

    it('notes the current period once, keyed by its start', () => {
      const r = raw({ checks: check, sst: { periodStartMonth: 1, taxes: ['service'], filed: [] } });
      const got = inputs(r);
      expect(got).toEqual([
        {
          entityType: 'finance_sst_period',
          entityId: null,
          entityLabel: 'SST 1 Sep – 31 Oct 2026',
          body: `The service tax period 1 Sep – 31 Oct 2026 ends 31 Oct 2026; its return isn't marked filed.${AS_OF}`,
          target: 'sst:2026-09-01',
          stage: '2026-09-01',
        },
      ]);
      expect(financeAgentNoteInput.safeParse(got[0]).success).toBe(true);
    });

    it('names both taxes in one note when both are registered', () => {
      const r = raw({ checks: check, sst: { periodStartMonth: 1, taxes: ['service', 'sales'], filed: [] } });
      expect(inputs(r)[0].body).toBe(
        `The service tax and sales tax period 1 Sep – 31 Oct 2026 ends 31 Oct 2026; their returns aren't marked filed.${AS_OF}`,
      );
    });

    it('skips when settings are missing, when the period ends later, or when every return is filed', () => {
      expect(scanFinance(raw({ checks: check }), NOW)).toEqual([]);
      // Periods start in even months: 1 Oct – 30 Nov, 38 days left.
      expect(scanFinance(raw({ checks: check, sst: { periodStartMonth: 2, taxes: ['service'], filed: [] } }), NOW)).toEqual([]);
      expect(
        scanFinance(
          raw({
            checks: check,
            sst: { periodStartMonth: 1, taxes: ['service'], filed: [{ taxType: 'service', periodStart: '2026-09-01' }] },
          }),
          NOW,
        ),
      ).toEqual([]);
    });
  });

  it('every candidate of every check passes the action schema (the proposer drops ones that do not)', () => {
    const r = raw({
      checks: [
        { key: 'invoice_overdue', params: { days: 1, min_amount: 0 } },
        { key: 'bill_due_soon', params: { days: 30 } },
        { key: 'expense_waiting', params: { days: 1 } },
        { key: 'quotation_expiring', params: { days: 30 } },
        { key: 'draft_stale', params: { days: 3 } },
        { key: 'bank_unmatched', params: { days: 3 } },
        { key: 'sst_period_closing', params: { days: 30 } },
      ],
      invoices: [{ id: A, invoiceNo: null, customer: null, dueDate: '2026-10-01', balance: 1 }],
      bills: [{ id: B, billNo: null, supplier: null, dueDate: '2026-10-01', balance: 1 }],
      expenses: [{ id: C, amount: 1, vendor: null, createdAt: '2026-10-01T00:00:00Z' }],
      quotations: [{ id: A, quotationNo: null, customer: null, validUntil: '2026-10-30' }],
      drafts: [{ kind: 'bill', id: B, party: null, updatedAt: '2026-10-01T00:00:00Z' }],
      bankLines: [{ accountId: C, account: 'Main', currency: 'MYR', lineDate: '2026-10-01', amount: 1 }],
      sst: { periodStartMonth: 1, taxes: ['sales'], filed: [] },
    });
    const all = scanFinance(r, NOW);
    expect(new Set(all.map((c) => c.checkKey)).size).toBe(7);
    for (const c of all) expect(financeAgentNoteInput.safeParse(c.input).success).toBe(true);
  });

  it('cuts long names so a body stays within 500 characters', () => {
    const long = 'N'.repeat(400);
    const r = raw({
      checks: [{ key: 'invoice_overdue', params: { days: 1, min_amount: 0 } }],
      invoices: [{ id: A, invoiceNo: 'INV-1', customer: long, dueDate: '2026-10-01', balance: 1 }],
    });
    const body = inputs(r)[0].body;
    expect(body.length).toBeLessThanOrEqual(500);
    expect(body).toContain('…');
  });
});
