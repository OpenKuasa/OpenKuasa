import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { AGENT_KEYS } from '@/lib/agents/agent-keys';
import { crmAgent } from '@/lib/agents/crm-agent';
import { financeAgent } from '@/lib/agents/finance-agent';
import { interpretFocus, interpretPrompt } from '@/lib/agents/focus/interpret';
import { AGENTS, agentForProduct } from '@/lib/agents/registry';
import { FINANCE_FOCUS } from '@/lib/agents/types';
import { FINANCE_FOCUS_MENU } from '@/lib/finance/agent/checks';
import { buildFinanceAgentContext } from '@/lib/finance/agent/context';
import { FINANCE_FOCUS_SPEC } from '@/lib/finance/agent/settings';

const ORG = '33333333-3333-4333-8333-333333333333';
const USER = '44444444-4444-4444-8444-444444444444';
const A = '11111111-1111-4111-8111-111111111111';

describe('registry', () => {
  it('registers Bendahara after Kasturi, with the same keys list', () => {
    expect([...AGENTS.keys()]).toEqual(['weekly-studio', 'crm-focus', 'finance-focus']);
    expect([...AGENT_KEYS]).toEqual([...AGENTS.keys()]);
    expect(agentForProduct('finance', AGENTS)).toBe(financeAgent);
    expect(agentForProduct('crm', AGENTS)).toBe(crmAgent);
  });
});

describe('financeAgent', () => {
  it('is the finance-focus agent with one action and no digest, research or media', () => {
    expect(financeAgent.agentKey).toBe(FINANCE_FOCUS);
    expect(financeAgent.product).toBe('finance');
    expect(Object.keys(financeAgent.actions)).toEqual(['createAgentNote']);
    expect(financeAgent.digest).toBeUndefined();
    expect(financeAgent.research).toBeUndefined();
    expect(financeAgent.media).toBeUndefined();
    expect(financeAgent.ui).toEqual({
      title: 'AI Agents',
      subtitle: 'Watches your books for what you asked',
      screenPath: '/finance/agents',
      assetKinds: [],
    });
  });

  it('builds the write context from the session and asks for the proposal id', () => {
    const client = {} as never;
    expect(financeAgent.buildWriteContext(client, ORG, USER)).toEqual({ client, orgId: ORG, userId: USER });
    expect(financeAgent.writeContextTakesProposal).toBe(true);
    expect(crmAgent.writeContextTakesProposal).toBeUndefined();
  });

  it('expires in 7 days and never re-offers a decided stage', () => {
    expect(financeAgent.proposals.expiresInDays).toBe(7);
    expect(financeAgent.proposals.cooldownDays).toBe(36500);
  });

  it('dedupes on action, check, target and stage', () => {
    const key = financeAgent.proposals.dedupeKey!;
    const input = { entityType: 'finance_invoice', entityId: A, entityLabel: 'INV-1', body: 'x', target: A, stage: '14' };
    expect(key('createAgentNote', input, 'invoice_overdue')).toBe(`createAgentNote:invoice_overdue:${A}:14`);
    expect(key('createAgentNote', { ...input, stage: '28' }, 'invoice_overdue')).not.toBe(
      key('createAgentNote', input, 'invoice_overdue'),
    );
    expect(key('createAgentNote', { target: 'sst:2026-09-01', stage: '2026-09-01' }, 'sst_period_closing')).toBe(
      'createAgentNote:sst_period_closing:sst:2026-09-01:2026-09-01',
    );
  });

  it('pick prompt carries the context and the list, and says it only leaves notes', () => {
    const prompt = financeAgent.proposals.pickPrompt('CTX', '0. INV-1');
    expect(prompt).toContain('CTX');
    expect(prompt).toContain('0. INV-1');
    expect(prompt).toContain('Choose at most 5');
    expect(prompt).toContain('only leaves a note');
  });

  it('shares the settings spec with Bendahara defaults', () => {
    expect(FINANCE_FOCUS_SPEC).toMatchObject({
      agentKey: 'finance-focus',
      maxChars: 500,
      defaults: { max_cost_cents: 50, daily_cap_cents: 200, weekly_cap_cents: 500 },
    });
    expect(FINANCE_FOCUS_SPEC.menu).toBe(FINANCE_FOCUS_MENU);
  });
});

describe('interpret refuses actions', () => {
  it('a focus asking to pay, void, post or email yields only "cannot" items and no checks', async () => {
    const focus = 'Pay every supplier bill, void old invoices, post the drafts and email customers a reminder';
    const prompts: string[] = [];
    // A model that tries to sneak in actions as checks.
    const complete = async (_k: string, _m: string, prompt: string) => {
      prompts.push(prompt);
      return {
        text: JSON.stringify({
          checks: [
            { key: 'pay_bills', params: {} },
            { key: 'void_invoices', params: {} },
            { key: 'email_customers', params: { days: 3 } },
          ],
          cannot: ['Pay supplier bills', 'Void invoices', 'Post drafts', 'Email customers'],
        }),
        cost_cents: 1,
      };
    };
    const out = await interpretFocus('k', FINANCE_FOCUS_MENU, focus, complete);
    expect(out.plan.checks).toEqual([]);
    expect(out.cannot).toEqual(['Pay supplier bills', 'Void invoices', 'Post drafts', 'Email customers']);
    expect(prompts[0]).toBe(interpretPrompt(FINANCE_FOCUS_MENU, focus));
  });

  it('clamps a menu check to its ranges', async () => {
    const complete = async () => ({
      text: '{"checks":[{"key":"invoice_overdue","params":{"days":999,"min_amount":-5}}],"cannot":[]}',
      cost_cents: null,
    });
    const out = await interpretFocus('k', FINANCE_FOCUS_MENU, 'overdue', complete);
    expect(out.plan.checks).toEqual([{ key: 'invoice_overdue', params: { days: 180, min_amount: 0 } }]);
  });
});

/** Columns service_role is granted for the scan (Task 1 migration). */
const GRANTED: Record<string, string[]> = {
  agent_configs: ['focus_plan', 'focus_confirmed_at'],
  finance_invoice_totals: ['org_id', 'id', 'invoice_no', 'customer_id', 'invoice_date', 'due_date', 'display_status', 'balance_myr', 'currency'],
  supplier_bill_totals: ['org_id', 'id', 'bill_no', 'supplier_id', 'bill_date', 'due_date', 'display_status', 'balance_myr', 'currency'],
  finance_invoices: ['org_id', 'id', 'status', 'customer_id', 'invoice_date', 'updated_at'],
  supplier_bills: ['org_id', 'id', 'status', 'supplier_id', 'bill_date', 'updated_at'],
  finance_expenses: ['org_id', 'id', 'status', 'amount', 'vendor_id', 'vendor_name', 'expense_date', 'created_at'],
  finance_quotations: ['org_id', 'id', 'quotation_no', 'customer_id', 'status', 'valid_until'],
  finance_statement_lines: ['org_id', 'id', 'account_id', 'line_date', 'money_in', 'money_out', 'transaction_id'],
  finance_accounts: ['org_id', 'id', 'name', 'active', 'currency'],
  finance_contacts: ['org_id', 'id', 'name'],
  finance_sst_settings: ['org_id', 'period_start_month', 'service_tax_no', 'sales_tax_no'],
  finance_sst_returns: ['org_id', 'tax_type', 'period_start'],
};

type Query = { table: string; columns: string[]; filters: [string, string, unknown][] };

function fakeService(data: Record<string, unknown>) {
  const queries: Query[] = [];
  const client = {
    from(table: string) {
      const q: Query = { table, columns: [], filters: [] };
      queries.push(q);
      const result = () => {
        const d = data[table];
        return { data: d ?? (table === 'agent_configs' || table === 'finance_sst_settings' ? null : []), error: null };
      };
      const chain: Record<string, unknown> = {
        select(cols: string) {
          q.columns = cols.split(',');
          return chain;
        },
        maybeSingle: async () => result(),
        range: async () => result(),
        then: (res: (v: unknown) => unknown) => res(result()),
      };
      for (const op of ['eq', 'in', 'gt', 'is', 'order', 'lt', 'gte']) {
        chain[op] = (c: string, v: unknown) => {
          if (op !== 'order') q.filters.push([op, c, v]);
          return chain;
        };
      }
      return chain;
    },
  } as unknown as SupabaseClient;
  return { client, queries };
}

describe('buildFinanceAgentContext', () => {
  const plan = { checks: [{ key: 'invoice_overdue', params: { days: 14, min_amount: 0 } }] };

  it('reads only granted columns, and only posted, owed documents (no drafts or voids)', async () => {
    const { client, queries } = fakeService({
      agent_configs: { focus_plan: plan, focus_confirmed_at: '2026-10-01T00:00:00Z' },
      finance_sst_settings: { period_start_month: 1, service_tax_no: 'W10-1', sales_tax_no: null },
    });
    await buildFinanceAgentContext(client, ORG);
    for (const q of queries) {
      const allowed = GRANTED[q.table];
      expect(allowed, `unexpected table ${q.table}`).toBeDefined();
      for (const col of [...q.columns, ...q.filters.map((f) => f[1])]) {
        if (q.table !== 'agent_configs' && col !== 'agent_key') expect(allowed, `${q.table}.${col}`).toContain(col);
      }
      expect(q.filters).toContainEqual(['eq', 'org_id', ORG]);
    }
    const inv = queries.find((q) => q.table === 'finance_invoice_totals')!;
    expect(inv.filters).toContainEqual(['in', 'display_status', ['sent', 'overdue']]);
    expect(inv.filters).toContainEqual(['gt', 'balance_myr', 0]);
    const bill = queries.find((q) => q.table === 'supplier_bill_totals')!;
    expect(bill.filters).toContainEqual(['in', 'display_status', ['pending', 'overdue']]);
    expect(bill.filters).toContainEqual(['gt', 'balance_myr', 0]);
    expect(queries.find((q) => q.table === 'finance_invoices')!.filters).toContainEqual(['eq', 'status', 'draft']);
    expect(queries.find((q) => q.table === 'supplier_bills')!.filters).toContainEqual(['eq', 'status', 'draft']);
    expect(queries.find((q) => q.table === 'finance_expenses')!.filters).toContainEqual(['eq', 'status', 'pending']);
    expect(queries.find((q) => q.table === 'finance_quotations')!.filters).toContainEqual(['eq', 'status', 'sent']);
    expect(queries.find((q) => q.table === 'finance_statement_lines')!.filters).toContainEqual(['is', 'transaction_id', null]);
  });

  it('maps rows: names from contacts, ringgit balances, inactive accounts dropped, SST types from numbers', async () => {
    const { client } = fakeService({
      agent_configs: { focus_plan: plan, focus_confirmed_at: '2026-10-01T00:00:00Z' },
      finance_contacts: [
        { id: 'c1', name: 'Ming Hardware' },
        { id: 'v1', name: 'Grab' },
      ],
      finance_invoice_totals: [
        { id: A, invoice_no: 'INV-1', customer_id: 'c1', due_date: '2026-09-01', display_status: 'overdue', balance_myr: '472.30' },
      ],
      finance_expenses: [
        { id: 'e1', amount: '10.5', vendor_id: 'v1', vendor_name: null, created_at: '2026-10-01T00:00:00Z' },
        { id: 'e2', amount: 3, vendor_id: null, vendor_name: 'Kedai', created_at: '2026-10-01T00:00:00Z' },
      ],
      finance_accounts: [
        { id: 'a1', name: 'Main Bank', active: true, currency: 'MYR' },
        { id: 'a2', name: 'Old', active: false, currency: 'MYR' },
        { id: 'a3', name: 'USD Account', active: true, currency: 'USD' },
      ],
      finance_statement_lines: [
        { id: 'l1', account_id: 'a1', line_date: '2026-09-01', money_in: '0', money_out: '12.5' },
        { id: 'l2', account_id: 'a2', line_date: '2026-09-01', money_in: '5', money_out: '0' },
        { id: 'l3', account_id: 'a3', line_date: '2026-09-02', money_in: '100', money_out: '0' },
      ],
      finance_sst_settings: { period_start_month: 3, service_tax_no: ' ', sales_tax_no: 'B16-1' },
      finance_sst_returns: [{ tax_type: 'sales', period_start: '2026-07-01' }],
    });
    const { raw, context } = await buildFinanceAgentContext(client, ORG);
    expect(raw.plan).toEqual(plan);
    expect(raw.invoices).toEqual([{ id: A, invoiceNo: 'INV-1', customer: 'Ming Hardware', dueDate: '2026-09-01', balance: 472.3 }]);
    expect(raw.expenses.map((e) => [e.vendor, e.amount])).toEqual([
      ['Grab', 10.5],
      ['Kedai', 3],
    ]);
    expect(raw.bankLines).toEqual([
      { accountId: 'a1', account: 'Main Bank', currency: 'MYR', lineDate: '2026-09-01', amount: 12.5 },
      { accountId: 'a3', account: 'USD Account', currency: 'USD', lineDate: '2026-09-02', amount: 100 },
    ]);
    expect(raw.sst).toEqual({ periodStartMonth: 3, taxes: ['sales'], filed: [{ taxType: 'sales', periodStart: '2026-07-01' }] });
    // Counts and the read-back only: no names, no ids.
    expect(context).toContain('Unpaid invoices: 1.');
    expect(context).toContain('- Flag invoices more than 14 days overdue');
    expect(context).not.toContain('Ming');
    expect(context).not.toContain(A);
  });

  it('has no plan until it is confirmed, and no SST without settings', async () => {
    const { client } = fakeService({ agent_configs: { focus_plan: plan, focus_confirmed_at: null } });
    const { raw, context } = await buildFinanceAgentContext(client, ORG);
    expect(raw.plan).toBeNull();
    expect(raw.sst).toBeNull();
    expect(context).not.toContain('What the owner asked');
  });
});
