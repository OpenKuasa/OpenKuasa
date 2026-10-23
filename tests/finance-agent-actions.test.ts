import { describe, expect, it, vi } from 'vitest';
import {
  FINANCE_NO_LONGER_APPLIES,
  financeAgentNoteInput,
  financeCreateAgentNote,
  type FinanceAgentNoteInput,
} from '@/lib/finance/agent/actions';

const ORG = '33333333-3333-4333-8333-333333333333';
const USER = '44444444-4444-4444-8444-444444444444';
const PROPOSAL = '55555555-5555-4555-8555-555555555555';
const A = '11111111-1111-4111-8111-111111111111';
const NOTE = '66666666-6666-4666-8666-666666666666';

type Reply = { data: unknown; error: unknown };

/** A client whose reads answer per table (single row or rows), and whose rpc is a spy. */
function fake(tables: Record<string, Reply>, rpcReply: Reply = { data: NOTE, error: null }) {
  const reads: { table: string; filters: [string, unknown][] }[] = [];
  const rpc = vi.fn(async () => rpcReply);
  const client = {
    rpc,
    from(table: string) {
      const read = { table, filters: [] as [string, unknown][] };
      reads.push(read);
      const reply = async () => tables[table] ?? { data: null, error: null };
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (c: string, v: unknown) => {
          read.filters.push([c, v]);
          return chain;
        },
        is: (c: string, v: unknown) => {
          read.filters.push([c, v]);
          return chain;
        },
        maybeSingle: reply,
        limit: reply,
        then: (res: (v: unknown) => unknown) => reply().then(res),
      };
      return chain;
    },
  };
  return { ctx: { client: client as never, orgId: ORG, userId: USER, proposalId: PROPOSAL }, rpc, reads };
}

const invoiceNote: FinanceAgentNoteInput = {
  entityType: 'finance_invoice',
  entityId: A,
  entityLabel: 'INV-1',
  body: 'INV-1 is 14 days overdue: RM 5.00 unpaid. (as of 23 Oct 2026)',
  target: A,
  stage: '14',
};
const PROPOSED_AT = '2026-10-23T04:00:00.000Z';
const proposal = (check_key: string): Reply => ({ data: { check_key, created_at: PROPOSED_AT }, error: null });

describe('financeAgentNoteInput', () => {
  it('accepts a document note and an SST period note', () => {
    expect(financeAgentNoteInput.safeParse(invoiceNote).success).toBe(true);
    expect(
      financeAgentNoteInput.safeParse({
        entityType: 'finance_sst_period',
        entityId: null,
        entityLabel: 'SST 1 Sep – 31 Oct 2026',
        body: 'x',
        target: 'sst:2026-09-01',
        stage: '2026-09-01',
      }).success,
    ).toBe(true);
  });

  it('refuses a target that is not the document, an id on an SST note, unknown types and long bodies', () => {
    expect(financeAgentNoteInput.safeParse({ ...invoiceNote, target: 'other' }).success).toBe(false);
    expect(financeAgentNoteInput.safeParse({ ...invoiceNote, entityId: null }).success).toBe(false);
    expect(financeAgentNoteInput.safeParse({ ...invoiceNote, entityType: 'finance_payment' }).success).toBe(false);
    expect(
      financeAgentNoteInput.safeParse({ ...invoiceNote, entityType: 'finance_sst_period', target: 'sst:2026-09-01' }).success,
    ).toBe(false);
    expect(financeAgentNoteInput.safeParse({ ...invoiceNote, body: 'x'.repeat(501) }).success).toBe(false);
    expect(financeAgentNoteInput.safeParse({ ...invoiceNote, body: '   ' }).success).toBe(false);
  });
});

describe('financeCreateAgentNote', () => {
  it('adds the note through the RPC with the workspace and the claimed proposal', async () => {
    const { ctx, rpc, reads } = fake({
      agent_proposals: proposal('invoice_overdue'),
      finance_invoice_totals: { data: { display_status: 'overdue', balance_myr: 5 }, error: null },
    });
    expect(await financeCreateAgentNote(ctx, invoiceNote)).toEqual({ ok: true, data: { id: NOTE } });
    expect(rpc).toHaveBeenCalledWith('finance_add_agent_note', { target_org: ORG, p_proposal: PROPOSAL });
    expect(reads.find((r) => r.table === 'finance_invoice_totals')!.filters).toEqual([
      ['org_id', ORG],
      ['id', A],
    ]);
  });

  const stale = { ok: false, error: FINANCE_NO_LONGER_APPLIES, stale: true };

  it.each([
    ['paid', { display_status: 'paid', balance_myr: 0 }],
    ['voided', { display_status: 'void', balance_myr: 5 }],
    ['no balance', { display_status: 'overdue', balance_myr: 0 }],
  ])('an invoice since %s no longer applies, and writes nothing', async (_why, row) => {
    const { ctx, rpc } = fake({
      agent_proposals: proposal('invoice_overdue'),
      finance_invoice_totals: { data: row, error: null },
    });
    expect(await financeCreateAgentNote(ctx, invoiceNote)).toEqual(stale);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('an invoice part-paid below the check minimum no longer applies', async () => {
    const input = { ...invoiceNote, minAmount: 1000 };
    const below = fake({
      agent_proposals: proposal('invoice_overdue'),
      finance_invoice_totals: { data: { display_status: 'overdue', balance_myr: 999.99 }, error: null },
    });
    expect(await financeCreateAgentNote(below.ctx, input)).toEqual(stale);
    const still = fake({
      agent_proposals: proposal('invoice_overdue'),
      finance_invoice_totals: { data: { display_status: 'overdue', balance_myr: 1000 }, error: null },
    });
    expect((await financeCreateAgentNote(still.ctx, input)).ok).toBe(true);
  });

  it('a draft touched after the suggestion was made no longer applies', async () => {
    const input = { ...invoiceNote, entityType: 'finance_invoice' } as FinanceAgentNoteInput;
    const touched = fake({
      agent_proposals: proposal('draft_stale'),
      finance_invoices: { data: { status: 'draft', updated_at: '2026-10-23T05:00:00Z' }, error: null },
    });
    expect(await financeCreateAgentNote(touched.ctx, input)).toEqual(stale);
    const untouched = fake({
      agent_proposals: proposal('draft_stale'),
      finance_invoices: { data: { status: 'draft', updated_at: '2026-10-01T05:00:00Z' }, error: null },
    });
    expect((await financeCreateAgentNote(untouched.ctx, input)).ok).toBe(true);
  });

  it('a document that is gone no longer applies', async () => {
    const { ctx, rpc } = fake({ agent_proposals: proposal('invoice_overdue') });
    expect(await financeCreateAgentNote(ctx, invoiceNote)).toEqual(stale);
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['bill_due_soon', 'finance_supplier_bill', 'supplier_bill_totals', { display_status: 'paid', balance_myr: 0 }, { display_status: 'pending', balance_myr: 3 }],
    ['draft_stale', 'finance_invoice', 'finance_invoices', { status: 'posted' }, { status: 'draft', updated_at: '2026-10-01T00:00:00Z' }],
    ['draft_stale', 'finance_supplier_bill', 'supplier_bills', { status: 'void' }, { status: 'draft', updated_at: '2026-10-01T00:00:00Z' }],
    ['expense_waiting', 'finance_expense', 'finance_expenses', { status: 'approved' }, { status: 'pending' }],
    ['quotation_expiring', 'finance_quotation', 'finance_quotations', { status: 'accepted' }, { status: 'sent' }],
    ['quotation_expiring', 'finance_quotation', 'finance_quotations', { status: 'declined' }, { status: 'sent' }],
  ])('%s on %s re-reads %s', async (check, entityType, table, gone, still) => {
    const input = { ...invoiceNote, entityType } as FinanceAgentNoteInput;
    const staleRun = fake({ agent_proposals: proposal(check), [table]: { data: gone, error: null } });
    expect(await financeCreateAgentNote(staleRun.ctx, input)).toEqual(stale);
    const liveRun = fake({ agent_proposals: proposal(check), [table]: { data: still, error: null } });
    expect((await financeCreateAgentNote(liveRun.ctx, input)).ok).toBe(true);
  });

  it('bank_unmatched no longer applies once nothing is left to match', async () => {
    const input = { ...invoiceNote, entityType: 'finance_bank_account' } as FinanceAgentNoteInput;
    const matched = fake({
      agent_proposals: proposal('bank_unmatched'),
      finance_accounts: { data: { active: true }, error: null },
      finance_statement_lines: { data: [], error: null },
    });
    expect(await financeCreateAgentNote(matched.ctx, input)).toEqual(stale);
    const open = fake({
      agent_proposals: proposal('bank_unmatched'),
      finance_accounts: { data: { active: true }, error: null },
      finance_statement_lines: { data: [{ id: 'l1' }], error: null },
    });
    expect((await financeCreateAgentNote(open.ctx, input)).ok).toBe(true);
    expect(open.reads.find((r) => r.table === 'finance_statement_lines')!.filters).toContainEqual(['transaction_id', null]);
  });

  it('sst_period_closing no longer applies once every registered return is filed', async () => {
    const input: FinanceAgentNoteInput = {
      entityType: 'finance_sst_period',
      entityId: null,
      entityLabel: 'SST 1 Sep – 31 Oct 2026',
      body: 'x',
      target: 'sst:2026-09-01',
      stage: '2026-09-01',
    };
    const settings = { data: { service_tax_no: 'W1', sales_tax_no: 'B1' }, error: null };
    const filed = fake({
      agent_proposals: proposal('sst_period_closing'),
      finance_sst_settings: settings,
      finance_sst_returns: { data: [{ tax_type: 'service' }, { tax_type: 'sales' }], error: null },
    });
    expect(await financeCreateAgentNote(filed.ctx, input)).toEqual(stale);
    expect(filed.reads.find((r) => r.table === 'finance_sst_returns')!.filters).toContainEqual(['period_start', '2026-09-01']);
    const half = fake({
      agent_proposals: proposal('sst_period_closing'),
      finance_sst_settings: settings,
      finance_sst_returns: { data: [{ tax_type: 'service' }], error: null },
    });
    expect((await financeCreateAgentNote(half.ctx, input)).ok).toBe(true);
  });

  it('a read error is a plain failure, not "no longer applies"', async () => {
    const { ctx, rpc } = fake({
      agent_proposals: proposal('invoice_overdue'),
      finance_invoice_totals: { data: null, error: { code: '42501' } },
    });
    expect(await financeCreateAgentNote(ctx, invoiceNote)).toEqual({ ok: false, error: 'That note could not be added.' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('refuses without a proposal id, or when the proposal cannot be read', async () => {
    const { ctx, rpc } = fake({});
    expect(await financeCreateAgentNote({ ...ctx, proposalId: undefined }, invoiceNote)).toEqual({
      ok: false,
      error: 'That note could not be added.',
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await financeCreateAgentNote(ctx, invoiceNote)).ok).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it('returns a plain message and logs only the code when the RPC refuses', async () => {
    const { ctx } = fake(
      {
        agent_proposals: proposal('invoice_overdue'),
        finance_invoice_totals: { data: { display_status: 'overdue', balance_myr: 5 }, error: null },
      },
      { data: null, error: { code: 'FIN70', message: 'secret detail' } },
    );
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await financeCreateAgentNote(ctx, invoiceNote)).toEqual({ ok: false, error: 'That note could not be added.' });
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret detail');
    log.mockRestore();
  });
});
