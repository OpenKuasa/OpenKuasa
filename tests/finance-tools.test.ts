import { describe, expect, it, vi } from 'vitest';

const seen = vi.hoisted(() => ({ postInput: null as unknown, decideInput: null as unknown }));

// Keep the real Zod input schemas; override only the fns we invoke.
vi.mock('@/lib/finance/invoices', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/finance/invoices')>();
  return {
    ...actual,
    listInvoices: async (ctx: { orgId: string }) => ({ echoedOrg: ctx.orgId }),
    postInvoice: async (_ctx: unknown, input: unknown) => {
      seen.postInput = input;
      return { ok: false as const, error: 'posting blocked' };
    },
  };
});

// Sign-off: the capability refuses (FIN14-style); the tool must hand that refusal back untouched.
vi.mock('@/lib/finance/purchase-orders', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/finance/purchase-orders')>();
  return {
    ...actual,
    decidePurchaseOrder: async (_ctx: unknown, input: unknown) => {
      seen.decideInput = input;
      return { ok: false as const, error: 'Only the business owner or an admin can approve a purchase order.' };
    },
  };
});

// getFinanceOverview sums balances; keep real schemas, override the balance reads.
vi.mock('@/lib/finance/contacts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/finance/contacts')>();
  return {
    ...actual,
    listInvoiceBalances: async () => [
      { customer_id: 'c1', balance: 16900.1, display_status: 'overdue' },
      { customer_id: 'c2', balance: 0.399999, display_status: 'open' },
    ],
    listBillBalances: async () => [{ supplier_id: 's1', balance: 9300, display_status: 'open' }],
  };
});
vi.mock('@/lib/finance/money', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/finance/money')>();
  return {
    ...actual,
    listAccounts: async () => [{ id: 'a1', name: 'Maybank', kind: 'bank', bank_name: 'Maybank Berhad', currency: 'MYR' }],
  };
});

const { createBendaharaTools, FINANCE_WRITE_TOOL_NAMES } = await import('@/lib/ai/finance-tools');

const viewer = () => ({ client: {} as never, orgId: 'org1', canWrite: false });
const writer = () => ({ client: {} as never, orgId: 'org1', canWrite: true });
const exec = (tool: unknown, input: unknown) =>
  (tool as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute(input, {
    toolCallId: 't',
    messages: [],
  });

const READ_NAMES = [
  'getFinanceOverview',
  'listInvoices',
  'getInvoice',
  'listInvoiceBalances',
  'listQuotations',
  'listCreditNotes',
  'listRefunds',
  'listBills',
  'getBill',
  'listBillBalances',
  'listPaymentsIn',
  'listPaymentsOut',
  'listContraEntries',
  'listFinanceContacts',
  'listFinanceItems',
  'listAccounts',
];

describe('Bendahara read tools', () => {
  it('exposes every finance lookup', () => {
    const tools = createBendaharaTools(viewer());
    for (const name of READ_NAMES) expect(Object.keys(tools), name).toContain(name);
  });

  it('reads contra entries, and has no tool that writes one', () => {
    const names = Object.keys(createBendaharaTools(writer()));
    expect(names).toContain('listContraEntries');
    expect(names.filter((n) => /contra/i.test(n))).toEqual(['listContraEntries']);
  });

  it('gives a viewer no change tools at all', () => {
    const names = Object.keys(createBendaharaTools(viewer()));
    for (const write of ['postInvoice', 'voidInvoice', 'recordPaymentIn', 'createFinanceContact']) {
      expect(names, write).not.toContain(write);
    }
  });

  it('runs lookups with the caller ctx (org never from the model)', async () => {
    const tools = createBendaharaTools(viewer());
    expect(await exec(tools.listInvoices, {})).toEqual({ echoedOrg: 'org1' });
  });

  it('getFinanceOverview reports ringgit totals, rounded to 2dp, not sen', async () => {
    const tools = createBendaharaTools(viewer());
    const out = (await exec(tools.getFinanceOverview, {})) as {
      receivables: { total: number; overdue_count: number };
      payables: { total: number; overdue_count: number };
      accounts: unknown[];
    };
    // 16900.1 + 0.399999 = 16900.499999… → rounded, and named `total` (ringgit), never `total_sen`.
    expect(out.receivables).toEqual({ total: 16900.5, overdue_count: 1 });
    expect(out.payables).toEqual({ total: 9300, overdue_count: 0 });
    expect(out).not.toHaveProperty('receivables.total_sen');
    expect(out.accounts).toEqual([{ id: 'a1', name: 'Maybank', kind: 'bank', currency: 'MYR' }]);
    // The description must not claim sen.
    expect(String(tools.getFinanceOverview.description).toLowerCase()).not.toContain('sen');
    expect(String(tools.getFinanceOverview.description).toLowerCase()).toContain('ringgit');
  });
});

describe('Bendahara write tools', () => {
  it('gives a writer the full lifecycle, and every declared write name is present', () => {
    const tools = createBendaharaTools(writer());
    for (const name of FINANCE_WRITE_TOOL_NAMES) expect(Object.keys(tools), name).toContain(name);
    // A representative spread, including the legally-weighty and finance-scoped ones.
    for (const name of ['saveInvoice', 'postInvoice', 'setEInvoice', 'postBill', 'recordPaymentIn', 'issueCreditNote', 'recordRefund', 'createFinanceContact', 'createFinanceItem']) {
      expect(Object.keys(tools), name).toContain(name);
    }
  });

  it('forwards input to the capability and returns its FinResult verbatim (ok:false reaches the model)', async () => {
    const tools = createBendaharaTools(writer()) as Record<string, unknown>;
    const out = await exec(tools.postInvoice, { id: 'inv-1' });
    expect(out).toEqual({ ok: false, error: 'posting blocked' });
    expect(seen.postInput).toEqual({ id: 'inv-1' }); // input passed straight through, no computing
  });

  it('never clashes with a reach/crm tool name (finance-scoped contacts/items)', () => {
    const names = Object.keys(createBendaharaTools(writer()));
    for (const clash of ['listContacts', 'createContact', 'updateContact', 'deleteContact']) {
      expect(names, clash).not.toContain(clash);
    }
  });

  it('offers the RFQ read tools to everyone', () => {
    const tools = createBendaharaTools({ client: {} as never, orgId: 'org-1', canWrite: false });
    expect(tools).toHaveProperty('listRfqs');
    expect(tools).toHaveProperty('getRfq');
    expect(tools).toHaveProperty('getRfqGroup');
  });

  it('adds the RFQ write tools for a writer, none for a viewer', () => {
    const names = ['saveRfq', 'sendRfq', 'quoteRfq', 'convertRfq', 'closeRfq'];
    const w = createBendaharaTools({ client: {} as never, orgId: 'o', canWrite: true });
    const v = createBendaharaTools({ client: {} as never, orgId: 'o', canWrite: false });
    for (const name of names) {
      expect(w).toHaveProperty(name);
      expect(FINANCE_WRITE_TOOL_NAMES).toContain(name);
      expect(v).not.toHaveProperty(name);
    }
  });

  it('adds the purchase-order write tools for a writer, none for a viewer', () => {
    const names = ['savePurchaseOrder', 'submitPurchaseOrder', 'receivePurchaseOrder', 'billFromPurchaseOrder'];
    const w = createBendaharaTools({ client: {} as never, orgId: 'o', canWrite: true });
    const v = createBendaharaTools({ client: {} as never, orgId: 'o', canWrite: false });
    for (const name of names) {
      expect(w).toHaveProperty(name);
      expect(FINANCE_WRITE_TOOL_NAMES).toContain(name);
      expect(v).not.toHaveProperty(name);
    }
  });

  it('adds the purchase-order sign-off tools for a writer, none for a viewer', () => {
    const names = ['decidePurchaseOrder', 'closePurchaseOrder', 'cancelPurchaseOrder'];
    const w = createBendaharaTools({ client: {} as never, orgId: 'o', canWrite: true });
    const v = createBendaharaTools({ client: {} as never, orgId: 'o', canWrite: false });
    for (const name of names) {
      expect(w).toHaveProperty(name);
      expect(FINANCE_WRITE_TOOL_NAMES).toContain(name);
      expect(v).not.toHaveProperty(name);
    }
  });

  it('adds the manual journal write tools for a writer, none for a viewer', () => {
    const names = ['saveJournal', 'postJournal', 'reverseJournal'];
    const w = createBendaharaTools({ client: {} as never, orgId: 'o', canWrite: true });
    const v = createBendaharaTools({ client: {} as never, orgId: 'o', canWrite: false });
    for (const name of names) {
      expect(w).toHaveProperty(name);
      expect(FINANCE_WRITE_TOOL_NAMES).toContain(name);
      expect(v).not.toHaveProperty(name);
    }
  });

  it('relays a refused purchase-order approval verbatim: nothing swallowed, no success claimed', async () => {
    const tools = createBendaharaTools(writer()) as Record<string, unknown>;
    const out = await exec(tools.decidePurchaseOrder, { id: '11111111-1111-4111-8111-111111111111', approve: true });
    expect(out).toEqual({ ok: false, error: 'Only the business owner or an admin can approve a purchase order.' });
    expect(out).not.toHaveProperty('data');
    expect(seen.decideInput).toMatchObject({ approve: true });
  });

  it('lists chart-of-accounts, filtered ledger entries, and journals', () => {
    const tools = createBendaharaTools({ client: {} as never, orgId: 'org-1', canWrite: false });
    for (const name of ['listLedgerAccounts', 'listLedgerEntries', 'listJournals', 'getJournal']) {
      expect(tools).toHaveProperty(name);
    }
  });
});
