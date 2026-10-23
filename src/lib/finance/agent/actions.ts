import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { FINANCE_NOTE_ENTITY_TYPES } from '@/lib/finance/agent/scan';
import type { CapResult } from '@/lib/reach/capabilities';

/**
 * The approver's own session the apply path runs Bendahara's agent action under, plus the
 * claimed proposal's id (the note RPC reads the note's text and target from that proposal).
 */
export type FinanceAgentWriteContext = {
  client: SupabaseClient;
  orgId: string;
  userId: string;
  proposalId?: string;
};

export const FINANCE_NO_LONGER_APPLIES = 'This no longer applies.';
const NOT_ADDED = 'That note could not be added.';

const SST_TARGET = /^sst:(\d{4}-\d{2}-\d{2})$/;

export const financeAgentNoteInput = z
  .object({
    entityType: z.enum(FINANCE_NOTE_ENTITY_TYPES),
    entityId: z.string().uuid().nullable(),
    entityLabel: z.string().min(1).max(120),
    // Never trimmed: the note is written from the stored proposal exactly as it was approved.
    body: z
      .string()
      .min(1)
      .max(500)
      .refine((s) => s.trim().length > 0, 'Write a note'),
    target: z.string().min(1).max(100),
    stage: z.string().min(1).max(40),
    minAmount: z.number().min(0).max(10000000).optional(),
  })
  .refine(
    (v) =>
      v.entityType === 'finance_sst_period'
        ? v.entityId === null && SST_TARGET.test(v.target)
        : v.entityId !== null && v.target === v.entityId,
    { message: 'The note is not about anything it can be left on' },
  );

export type FinanceAgentNoteInput = z.infer<typeof financeAgentNoteInput>;

type Check = 'stale' | 'live' | 'unreadable';

/** One row by id under the approver's session; 'stale' when it is gone (or not theirs to see). */
async function readOne(
  ctx: FinanceAgentWriteContext,
  table: string,
  columns: string,
  id: string,
  stillMatches: (row: Record<string, unknown>) => boolean,
): Promise<Check> {
  const { data, error } = await ctx.client.from(table).select(columns).eq('org_id', ctx.orgId).eq('id', id).maybeSingle();
  if (error) return 'unreadable';
  if (!data) return 'stale';
  return stillMatches(data as unknown as Record<string, unknown>) ? 'live' : 'stale';
}

const owed = (row: Record<string, unknown>, open: string[]) =>
  open.includes(String(row.display_status)) && Number(row.balance_myr) > 0;

/** Whether the note's target still matches the check that raised it (spec §5, "no longer applies"). */
async function stillApplies(
  ctx: FinanceAgentWriteContext,
  checkKey: string,
  input: FinanceAgentNoteInput,
  proposedAt: string,
): Promise<Check> {
  const id = input.entityId;
  switch (checkKey) {
    case 'invoice_overdue':
      return readOne(
        ctx,
        'finance_invoice_totals',
        'display_status,balance_myr',
        id as string,
        // Part-paid below the check's minimum no longer matches either.
        (r) => owed(r, ['sent', 'overdue']) && Number(r.balance_myr) >= (input.minAmount ?? 0),
      );
    case 'bill_due_soon':
      return readOne(ctx, 'supplier_bill_totals', 'display_status,balance_myr', id as string, (r) =>
        owed(r, ['pending', 'overdue']),
      );
    case 'draft_stale':
      return readOne(
        ctx,
        input.entityType === 'finance_invoice' ? 'finance_invoices' : 'supplier_bills',
        'status,updated_at',
        id as string,
        // Touched since the suggestion was made: it is no longer stale.
        (r) => r.status === 'draft' && !(Date.parse(String(r.updated_at)) > Date.parse(proposedAt)),
      );
    case 'expense_waiting':
      return readOne(ctx, 'finance_expenses', 'status', id as string, (r) => r.status === 'pending');
    case 'quotation_expiring':
      return readOne(ctx, 'finance_quotations', 'status', id as string, (r) => r.status === 'sent');
    case 'bank_unmatched': {
      const account = await readOne(ctx, 'finance_accounts', 'active', id as string, (r) => r.active === true);
      if (account !== 'live') return account;
      const { data, error } = await ctx.client
        .from('finance_statement_lines')
        .select('id')
        .eq('org_id', ctx.orgId)
        .eq('account_id', id as string)
        .is('transaction_id', null)
        .limit(1);
      if (error) return 'unreadable';
      return (data ?? []).length > 0 ? 'live' : 'stale';
    }
    case 'sst_period_closing': {
      const start = SST_TARGET.exec(input.target)?.[1];
      if (!start) return 'stale';
      const settings = await ctx.client
        .from('finance_sst_settings')
        .select('service_tax_no,sales_tax_no')
        .eq('org_id', ctx.orgId)
        .maybeSingle();
      if (settings.error) return 'unreadable';
      const s = settings.data as { service_tax_no: string | null; sales_tax_no: string | null } | null;
      const taxes = [s?.service_tax_no?.trim() ? 'service' : null, s?.sales_tax_no?.trim() ? 'sales' : null].filter(
        (t): t is string => t !== null,
      );
      if (taxes.length === 0) return 'stale';
      const filed = await ctx.client
        .from('finance_sst_returns')
        .select('tax_type')
        .eq('org_id', ctx.orgId)
        .eq('period_start', start);
      if (filed.error) return 'unreadable';
      const done = new Set(((filed.data ?? []) as { tax_type: string }[]).map((r) => r.tax_type));
      return taxes.every((t) => done.has(t)) ? 'stale' : 'live';
    }
    default:
      return 'unreadable';
  }
}

/**
 * Leaves the agent's note through the `finance_add_agent_note` RPC, which takes the note's text
 * and target from the approved proposal itself (and refuses unless this person approved it in
 * the last 10 minutes, once). First re-reads the target under the approver's own session: when
 * it no longer matches its check (paid, voided, approved, answered, matched, filed) nothing is
 * written and the answer is "This no longer applies." with `stale: true`.
 */
export async function financeCreateAgentNote(
  ctx: FinanceAgentWriteContext,
  input: FinanceAgentNoteInput,
): Promise<CapResult<{ id: string }>> {
  if (!ctx.proposalId) return { ok: false, error: NOT_ADDED };

  const proposal = await ctx.client
    .from('agent_proposals')
    .select('check_key,created_at')
    .eq('org_id', ctx.orgId)
    .eq('id', ctx.proposalId)
    .maybeSingle();
  const row = proposal.data as { check_key: string | null; created_at: string } | null;
  const checkKey = row?.check_key;
  if (proposal.error || !row || !checkKey) {
    console.error('[finance-agent] proposal not read:', proposal.error?.code);
    return { ok: false, error: NOT_ADDED };
  }

  const applies = await stillApplies(ctx, checkKey, input, row.created_at);
  if (applies === 'stale') return { ok: false, error: FINANCE_NO_LONGER_APPLIES, stale: true };
  if (applies === 'unreadable') return { ok: false, error: NOT_ADDED };

  const { data, error } = await ctx.client.rpc('finance_add_agent_note', {
    target_org: ctx.orgId,
    p_proposal: ctx.proposalId,
  });
  if (error || !data) {
    console.error('[finance-agent] note failed:', error?.code);
    return { ok: false, error: NOT_ADDED };
  }
  return { ok: true, data: { id: String(data) } };
}
