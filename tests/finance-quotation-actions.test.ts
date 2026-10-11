import { beforeEach, describe, expect, it, vi } from 'vitest';

const QUOTATION = '33333333-3333-4333-8333-333333333333';
const CUSTOMER = '44444444-4444-4444-8444-444444444444';
const INVOICE = '55555555-5555-4555-8555-555555555555';
const TXN = '66666666-6666-4666-8666-666666666666';

type Answer = { ok: true; data: unknown } | { ok: false; error: string };

const ctl = vi.hoisted(() => ({
  viewer: { userId: 'u1', orgId: 'org1', role: 'member', isDemo: false } as {
    userId: string; orgId: string; role: string; isDemo: boolean;
  },
  /** Every data-layer call, in order: the function, the workspace it was given, and its input. */
  calls: [] as { fn: string; orgId: string; input: unknown }[],
  revalidated: [] as string[],
  /** What each data-layer function answers; a function with no entry succeeds. */
  answers: {} as Record<string, unknown>,
  /** What getQuotation returns, or an Error for it to throw. */
  quotation: null as unknown,
}));

vi.mock('@/lib/auth/viewer', () => ({ getViewer: async () => ctl.viewer }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({}) }));
vi.mock('next/cache', () => ({
  revalidatePath: (path: string) => {
    ctl.revalidated.push(path);
  },
}));

function recorder(fn: string, ok: unknown) {
  return async (ctx: { orgId: string }, input: unknown) => {
    ctl.calls.push({ fn, orgId: ctx.orgId, input });
    return ctl.answers[fn] ?? { ok: true, data: ok };
  };
}

vi.mock('@/lib/finance/quotations', async (orig) => {
  const actual = await orig<typeof import('@/lib/finance/quotations')>();
  return {
    ...actual,
    saveQuotation: recorder('saveQuotation', { id: '33333333-3333-4333-8333-333333333333' }),
    sendQuotation: recorder('sendQuotation', { id: '33333333-3333-4333-8333-333333333333', quotation_no: 'QT-0007' }),
    acceptQuotation: recorder('acceptQuotation', { id: '33333333-3333-4333-8333-333333333333' }),
    declineQuotation: recorder('declineQuotation', { id: '33333333-3333-4333-8333-333333333333' }),
    deleteQuotation: recorder('deleteQuotation', { id: '33333333-3333-4333-8333-333333333333' }),
    convertQuotation: recorder('convertQuotation', {
      id: '33333333-3333-4333-8333-333333333333',
      invoice_id: '55555555-5555-4555-8555-555555555555',
    }),
    getQuotation: async (ctx: { orgId: string }, id: string) => {
      ctl.calls.push({ fn: 'getQuotation', orgId: ctx.orgId, input: id });
      if (ctl.quotation instanceof Error) throw ctl.quotation;
      return ctl.quotation;
    },
  };
});

vi.mock('@/lib/finance/money', async (orig) => {
  const actual = await orig<typeof import('@/lib/finance/money')>();
  return {
    ...actual,
    markPaymentPaid: recorder('markPaymentPaid', { id: '66666666-6666-4666-8666-666666666666', number: 'PV-0003' }),
    voidPayment: recorder('voidPayment', { id: '66666666-6666-4666-8666-666666666666' }),
    deleteScheduledPayment: recorder('deleteScheduledPayment', { id: '66666666-6666-4666-8666-666666666666' }),
  };
});

const actions = await import('@/app/(app)/finance/actions');

const QUOTATIONS = ['/finance/quotations'];
const QUOTATIONS_AND_INVOICES = ['/finance/quotations', '/finance/invoices'];
const PURCHASES = ['/finance/supplier-bills', '/finance/payments-out', '/finance/customers-suppliers', '/finance/payment-vouchers'];
const FORBIDDEN = { ok: false, error: 'You do not have permission to make changes here.' };
const LOCKED =
  'That cannot be done to this quotation as it now stands. It may have been sent, accepted or declined since this page was loaded.';

const quotation = {
  customer_id: CUSTOMER,
  quote_date: '2026-10-01',
  valid_until: '2026-10-31',
  lines: [{ description: 'Design work', quantity: 10, unit_price: 12.5 }],
};

/** What "Make invoice" sends: the quotation, and the date on the person's own calendar. */
const CONVERT = { id: QUOTATION, invoice_date: '2026-10-12' };

/** Every write action with an input its schema accepts, the data-layer function it must call, and the screens it refreshes. */
const writes: [string, (input: unknown) => Promise<Answer>, unknown, string, string[]][] = [
  ['saveQuotationAction', actions.saveQuotationAction, quotation, 'saveQuotation', QUOTATIONS],
  ['sendQuotationAction', actions.sendQuotationAction, { id: QUOTATION }, 'sendQuotation', QUOTATIONS],
  ['acceptQuotationAction', actions.acceptQuotationAction, { id: QUOTATION }, 'acceptQuotation', QUOTATIONS],
  ['declineQuotationAction', actions.declineQuotationAction, { id: QUOTATION }, 'declineQuotation', QUOTATIONS],
  ['deleteQuotationAction', actions.deleteQuotationAction, { id: QUOTATION }, 'deleteQuotation', QUOTATIONS],
  ['convertQuotationAction', actions.convertQuotationAction, CONVERT, 'convertQuotation', QUOTATIONS_AND_INVOICES],
];

beforeEach(() => {
  ctl.viewer = { userId: 'u1', orgId: 'org1', role: 'member', isDemo: false };
  ctl.calls = [];
  ctl.revalidated = [];
  ctl.answers = {};
  ctl.quotation = null;
});

describe('who may write', () => {
  it('refuses a viewer and the demo workspace on every action, before anything is parsed, read or written', async () => {
    for (const viewer of [
      { userId: 'u1', orgId: 'org1', role: 'viewer', isDemo: false },
      { userId: 'u1', orgId: 'org1', role: 'owner', isDemo: true },
    ]) {
      ctl.viewer = viewer;
      for (const [name, action, input] of writes) expect(await action(input), name).toEqual(FORBIDDEN);
      expect(await actions.saveAndSendQuotationAction(quotation)).toEqual(FORBIDDEN);
      expect(await actions.getQuotationAction({ id: QUOTATION })).toEqual(FORBIDDEN);
      // Not even a malformed input gets a schema's sentence: the refusal comes first.
      expect(await actions.saveQuotationAction({ lines: [] })).toEqual(FORBIDDEN);
      expect(await actions.convertQuotationAction(null)).toEqual(FORBIDDEN);
      expect(await actions.saveAndSendQuotationAction({ lines: [] })).toEqual(FORBIDDEN);
      expect(await actions.getQuotationAction({ id: 'nope' })).toEqual(FORBIDDEN);
    }
    expect(ctl.calls).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
  });

  it('tells a viewer they may not, not that the quotation is gone', async () => {
    ctl.viewer = { userId: 'u1', orgId: 'org1', role: 'viewer', isDemo: false };
    // The database would answer a viewer's update or delete with no row, and the functions with FIN11: both read "no longer exists".
    for (const fn of ['sendQuotation', 'acceptQuotation', 'declineQuotation', 'deleteQuotation', 'convertQuotation']) {
      ctl.answers[fn] = { ok: false, error: 'That quotation no longer exists.' };
    }
    expect(await actions.sendQuotationAction({ id: QUOTATION })).toEqual(FORBIDDEN);
    expect(await actions.acceptQuotationAction({ id: QUOTATION })).toEqual(FORBIDDEN);
    expect(await actions.declineQuotationAction({ id: QUOTATION })).toEqual(FORBIDDEN);
    expect(await actions.deleteQuotationAction({ id: QUOTATION })).toEqual(FORBIDDEN);
    expect(await actions.convertQuotationAction(CONVERT)).toEqual(FORBIDDEN);
    expect(ctl.calls).toEqual([]);
  });
});

describe('each write action', () => {
  it('calls its own data-layer function in the viewer’s workspace and refreshes the screens it moves', async () => {
    for (const [name, action, input, fn, paths] of writes) {
      ctl.calls = [];
      ctl.revalidated = [];
      expect((await action(input)).ok, name).toBe(true);
      expect(ctl.calls.map((c) => [c.fn, c.orgId]), name).toEqual([[fn, 'org1']]);
      expect(ctl.revalidated, name).toEqual(paths);
    }
  });

  it('refreshes Invoices only when an invoice is made: no other quotation action moves a figure there', async () => {
    for (const [name, action, input, fn] of writes) {
      ctl.revalidated = [];
      await action(input);
      expect(ctl.revalidated.includes('/finance/invoices'), name).toBe(fn === 'convertQuotation');
      expect(ctl.revalidated, name).not.toContain('/finance/payments-out');
    }
  });

  it('answers a conversion with the new invoice’s id', async () => {
    expect(await actions.convertQuotationAction(CONVERT)).toEqual({ ok: true, data: { id: QUOTATION, invoice_id: INVOICE } });
  });

  it('hands a conversion the person’s date beside the quotation, and nothing else', async () => {
    await actions.convertQuotationAction({ ...CONVERT, due_date: '2026-10-13' });
    expect(ctl.calls).toEqual([{ fn: 'convertQuotation', orgId: 'org1', input: CONVERT }]);
  });

  it('refuses a conversion with no date, or one that is not a date, touching nothing', async () => {
    for (const invoice_date of [undefined, '', '12/10/2026', '2026-02-30']) {
      expect(await actions.convertQuotationAction({ id: QUOTATION, invoice_date }), String(invoice_date)).toEqual({
        ok: false,
        error: 'Enter a valid date.',
      });
    }
    expect(ctl.calls).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
  });

  it('never takes the workspace from the input', async () => {
    await actions.saveQuotationAction({ ...quotation, org_id: 'someone-else' });
    await actions.convertQuotationAction({ ...CONVERT, org_id: 'someone-else', target_org: 'someone-else' });
    expect(ctl.calls.map((c) => c.orgId)).toEqual(['org1', 'org1']);
    expect(JSON.stringify(ctl.calls)).not.toContain('someone-else');
  });

  it('answers with the schema’s sentence, touching nothing, when the input is refused', async () => {
    expect(await actions.saveQuotationAction({ ...quotation, lines: [] })).toEqual({ ok: false, error: 'Add at least one line.' });
    expect(await actions.saveQuotationAction({ ...quotation, customer_id: '' })).toEqual({ ok: false, error: 'Choose a customer.' });
    expect(await actions.saveQuotationAction({ ...quotation, valid_until: '2026-09-30' })).toEqual({
      ok: false,
      error: 'The valid-until date cannot be before the quotation date.',
    });
    for (const action of [
      actions.sendQuotationAction,
      actions.acceptQuotationAction,
      actions.declineQuotationAction,
      actions.deleteQuotationAction,
      actions.convertQuotationAction,
    ]) {
      expect(await action({ id: 'nope' })).toEqual({ ok: false, error: 'That quotation no longer exists.' });
      expect(await action(null)).toMatchObject({ ok: false });
    }
    expect(ctl.calls).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
  });

  it('hands the data layer the parsed input: text trimmed, empties as null, figures rounded', async () => {
    await actions.saveQuotationAction({
      ...quotation,
      notes: '  ',
      lines: [{ description: ' Design work ', quantity: 1.23456, unit_price: 12.5, uom: '', product_id: '' }],
    });
    expect(ctl.calls[0].input).toEqual({
      ...quotation,
      notes: null,
      lines: [{ product_id: null, description: 'Design work', quantity: 1.235, uom: null, pack_size: null, unit_price: 12.5, sst_rate: 0 }],
    });
  });

  it('refreshes the screens after a refusal too, so a quotation someone else changed shows as it now is', async () => {
    // Sent in another tab while this one still had the draft open.
    ctl.answers.saveQuotation = { ok: false, error: LOCKED };
    expect(await actions.saveQuotationAction({ ...quotation, id: QUOTATION })).toEqual(ctl.answers.saveQuotation);
    expect(ctl.revalidated).toEqual(QUOTATIONS);

    // Made into an invoice in another tab: converting it again here is refused, and both screens show it as it is.
    ctl.revalidated = [];
    ctl.answers.convertQuotation = {
      ok: false,
      error: 'This quotation already has an invoice. Void that invoice, or delete it if it is a draft, first.',
    };
    expect(await actions.convertQuotationAction(CONVERT)).toEqual(ctl.answers.convertQuotation);
    expect(ctl.revalidated).toEqual(QUOTATIONS_AND_INVOICES);
  });
});

describe('saveAndSendQuotationAction', () => {
  it('saves, then marks what it saved as sent, and answers with the number', async () => {
    expect(await actions.saveAndSendQuotationAction(quotation)).toEqual({ ok: true, data: { id: QUOTATION, quotation_no: 'QT-0007' } });
    expect(ctl.calls.map((c) => c.fn)).toEqual(['saveQuotation', 'sendQuotation']);
    expect(ctl.calls[1].input).toEqual({ id: QUOTATION });
    expect(ctl.revalidated).toEqual(QUOTATIONS);
  });

  it('does not send when the save is refused', async () => {
    ctl.answers.saveQuotation = { ok: false, error: 'The customer or a product on this quotation no longer exists.' };
    expect(await actions.saveAndSendQuotationAction(quotation)).toEqual(ctl.answers.saveQuotation);
    expect(ctl.calls.map((c) => c.fn)).toEqual(['saveQuotation']);
    expect(ctl.revalidated).toEqual(QUOTATIONS);
  });

  it('keeps the draft when sending is refused, and says which draft it is', async () => {
    ctl.answers.sendQuotation = { ok: false, error: 'A quotation needs at least one line with an amount.' };
    expect(await actions.saveAndSendQuotationAction(quotation)).toEqual({
      ok: false,
      error: 'A quotation needs at least one line with an amount.',
      draftId: QUOTATION,
    });
    expect(ctl.calls.map((c) => c.fn)).toEqual(['saveQuotation', 'sendQuotation']);
    expect(ctl.revalidated).toEqual(QUOTATIONS);
  });

  it('answers with the schema’s sentence and saves nothing when the form is refused', async () => {
    expect(await actions.saveAndSendQuotationAction({ ...quotation, customer_id: '' })).toEqual({ ok: false, error: 'Choose a customer.' });
    expect(ctl.calls).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
  });
});

describe('getQuotationAction', () => {
  const draft = { id: QUOTATION, display_status: 'draft', lines: [] };

  it('returns a draft with its lines, without refreshing anything', async () => {
    ctl.quotation = draft;
    expect(await actions.getQuotationAction({ id: QUOTATION })).toEqual({ ok: true, data: draft });
    expect(ctl.calls).toEqual([{ fn: 'getQuotation', orgId: 'org1', input: QUOTATION }]);
    expect(ctl.revalidated).toEqual([]);
  });

  it('says the quotation is gone, and refreshes the list, when it was deleted meanwhile', async () => {
    expect(await actions.getQuotationAction({ id: QUOTATION })).toEqual({ ok: false, error: 'That quotation no longer exists.' });
    expect(ctl.revalidated).toEqual(QUOTATIONS);
  });

  it('says the quotation can no longer be changed, and refreshes the list, when it was sent or answered meanwhile', async () => {
    for (const display_status of ['sent', 'expired', 'accepted', 'declined']) {
      ctl.revalidated = [];
      ctl.quotation = { ...draft, display_status };
      expect(await actions.getQuotationAction({ id: QUOTATION }), display_status).toEqual({ ok: false, error: LOCKED });
      expect(ctl.revalidated, display_status).toEqual(QUOTATIONS);
    }
  });

  it('says the quotation is gone for an id that is not an id, without reading', async () => {
    expect(await actions.getQuotationAction({ id: 'nope' })).toEqual({ ok: false, error: 'That quotation no longer exists.' });
    expect(await actions.getQuotationAction(undefined)).toEqual({ ok: false, error: 'That quotation no longer exists.' });
    expect(ctl.calls).toEqual([]);
  });

  it('answers with a sentence when the read fails, and logs the cause', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    ctl.quotation = new Error('connection reset');
    expect(await actions.getQuotationAction({ id: QUOTATION })).toEqual({ ok: false, error: 'That could not be loaded. Please try again.' });
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});

describe('the Payments Out actions, now that refunds are money out too', () => {
  it('still refresh the purchase screens only: a refund cannot be reached through them', async () => {
    for (const [action, input] of [
      [actions.markPaymentPaidAction, { id: TXN, paid_on: '2026-10-09' }],
      [actions.voidPaymentAction, { id: TXN }],
      [actions.deleteScheduledPaymentAction, { id: TXN }],
    ] as const) {
      ctl.revalidated = [];
      expect((await action(input)).ok).toBe(true);
      expect(ctl.revalidated).toEqual(PURCHASES);
    }
  });
});
