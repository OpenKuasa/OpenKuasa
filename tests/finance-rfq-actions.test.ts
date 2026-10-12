import { beforeEach, describe, expect, it, vi } from 'vitest';

const RFQ = '33333333-3333-4333-8333-333333333333';
const SUPPLIER = '44444444-4444-4444-8444-444444444444';
const LINE = '66666666-6666-4666-8666-666666666666';

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
  /** What getRfq returns, or an Error for it to throw. */
  rfq: null as unknown,
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

vi.mock('@/lib/finance/rfqs', async (orig) => {
  const actual = await orig<typeof import('@/lib/finance/rfqs')>();
  return {
    ...actual,
    saveRfq: recorder('saveRfq', { id: '33333333-3333-4333-8333-333333333333' }),
    sendRfq: recorder('sendRfq', { id: '33333333-3333-4333-8333-333333333333', rfq_no: 'RFQ-0007' }),
    quoteRfq: recorder('quoteRfq', { id: '33333333-3333-4333-8333-333333333333' }),
    convertRfq: recorder('convertRfq', { id: '33333333-3333-4333-8333-333333333333', purchase_order_id: '88888888-8888-4888-8888-888888888888' }),
    closeRfq: recorder('closeRfq', { id: '33333333-3333-4333-8333-333333333333' }),
    deleteRfq: recorder('deleteRfq', { id: '33333333-3333-4333-8333-333333333333' }),
    getRfq: async (ctx: { orgId: string }, id: string) => {
      ctl.calls.push({ fn: 'getRfq', orgId: ctx.orgId, input: id });
      if (ctl.rfq instanceof Error) throw ctl.rfq;
      return ctl.rfq;
    },
  };
});

const actions = await import('@/app/(app)/finance/actions');

const RFQS = ['/finance/rfqs'];
const FORBIDDEN = { ok: false, error: 'You do not have permission to make changes here.' };
const GONE = { ok: false, error: 'That RFQ no longer exists.' };
const LOCKED =
  'That cannot be done to this RFQ as it now stands. It may have been sent, priced or closed since this page was loaded.';

const rfq = {
  supplier_id: SUPPLIER,
  rfq_date: '2026-10-01',
  reply_by: '2026-10-31',
  lines: [{ description: 'Printer paper', quantity: 10, unit_price: null }],
};
const quote = { id: RFQ, supplier_ref: 'Q-1', prices: [{ line_id: LINE, unit_price: 4.5 }] };

/** Every write action with an input its schema accepts, the data-layer function it must call, and the screens it refreshes. */
const writes: [string, (input: unknown) => Promise<Answer>, unknown, string][] = [
  ['saveRfqAction', actions.saveRfqAction, rfq, 'saveRfq'],
  ['sendRfqAction', actions.sendRfqAction, { id: RFQ }, 'sendRfq'],
  ['quoteRfqAction', actions.quoteRfqAction, quote, 'quoteRfq'],
  ['closeRfqAction', actions.closeRfqAction, { id: RFQ }, 'closeRfq'],
  ['deleteRfqAction', actions.deleteRfqAction, { id: RFQ }, 'deleteRfq'],
];

beforeEach(() => {
  ctl.viewer = { userId: 'u1', orgId: 'org1', role: 'member', isDemo: false };
  ctl.calls = [];
  ctl.revalidated = [];
  ctl.answers = {};
  ctl.rfq = null;
});

describe('who may write', () => {
  it('refuses a viewer and the demo workspace on every action, before anything is parsed, read or written', async () => {
    for (const viewer of [
      { userId: 'u1', orgId: 'org1', role: 'viewer', isDemo: false },
      { userId: 'u1', orgId: 'org1', role: 'owner', isDemo: true },
    ]) {
      ctl.viewer = viewer;
      for (const [name, action, input] of writes) {
        expect(await action(input), name).toEqual(FORBIDDEN);
        // Not even a malformed input gets a schema's sentence: the refusal comes first.
        expect(await action(null), name).toEqual(FORBIDDEN);
      }
      expect(await actions.saveAndSendRfqAction(rfq)).toEqual(FORBIDDEN);
      expect(await actions.saveAndSendRfqAction({ lines: [] })).toEqual(FORBIDDEN);
      expect(await actions.getRfqAction({ id: RFQ })).toEqual(FORBIDDEN);
      expect(await actions.getRfqAction({ id: 'nope' })).toEqual(FORBIDDEN);
    }
    expect(ctl.calls).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
  });

  it('tells a viewer they may not, not that the RFQ is gone', async () => {
    ctl.viewer = { userId: 'u1', orgId: 'org1', role: 'viewer', isDemo: false };
    for (const fn of ['sendRfq', 'quoteRfq', 'closeRfq', 'deleteRfq']) ctl.answers[fn] = GONE;
    expect(await actions.sendRfqAction({ id: RFQ })).toEqual(FORBIDDEN);
    expect(await actions.quoteRfqAction(quote)).toEqual(FORBIDDEN);
    expect(await actions.closeRfqAction({ id: RFQ })).toEqual(FORBIDDEN);
    expect(await actions.deleteRfqAction({ id: RFQ })).toEqual(FORBIDDEN);
    expect(ctl.calls).toEqual([]);
  });
});

describe('each write action', () => {
  it('calls its own data-layer function in the viewer’s workspace and refreshes RFQs only', async () => {
    for (const [name, action, input, fn] of writes) {
      ctl.calls = [];
      ctl.revalidated = [];
      expect((await action(input)).ok, name).toBe(true);
      expect(ctl.calls.map((c) => [c.fn, c.orgId]), name).toEqual([[fn, 'org1']]);
      expect(ctl.revalidated, name).toEqual(RFQS);
    }
  });

  it('never takes the workspace from the input', async () => {
    await actions.saveRfqAction({ ...rfq, org_id: 'someone-else' });
    await actions.quoteRfqAction({ ...quote, org_id: 'someone-else', target_org: 'someone-else' });
    expect(ctl.calls.map((c) => c.orgId)).toEqual(['org1', 'org1']);
    expect(JSON.stringify(ctl.calls)).not.toContain('someone-else');
  });

  it('answers with the schema’s sentence, touching nothing, when the input is refused', async () => {
    expect(await actions.saveRfqAction({ ...rfq, lines: [] })).toEqual({ ok: false, error: 'Add at least one line.' });
    expect(await actions.saveRfqAction({ ...rfq, supplier_id: '' })).toEqual({ ok: false, error: 'Choose a supplier.' });
    expect(await actions.saveRfqAction({ ...rfq, reply_by: '2026-09-30' })).toEqual({
      ok: false,
      error: 'The reply-by date cannot be before the RFQ date.',
    });
    expect(await actions.quoteRfqAction({ id: RFQ, prices: [] })).toEqual({
      ok: false,
      error: 'Enter a price for every line before marking the RFQ as quoted.',
    });
    for (const action of [actions.sendRfqAction, actions.closeRfqAction, actions.deleteRfqAction, actions.quoteRfqAction]) {
      expect(await action({ id: 'nope' })).toEqual(GONE);
      expect(await action(null)).toMatchObject({ ok: false });
    }
    expect(ctl.calls).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
  });

  it('hands the data layer the parsed input: text trimmed, empties as null, a missing price kept missing', async () => {
    await actions.saveRfqAction({
      ...rfq,
      reply_by: '',
      notes: '  ',
      lines: [{ description: ' Printer paper ', quantity: 1.23456, unit_price: null, uom: '', product_id: '' }],
    });
    expect(ctl.calls[0].input).toEqual({
      ...rfq,
      reply_by: null,
      notes: null,
      lines: [{ product_id: null, description: 'Printer paper', quantity: 1.235, uom: null, pack_size: null, unit_price: null, sst_rate: 0 }],
    });
  });

  it('refreshes RFQs after a refusal too, so an RFQ someone else changed shows as it now is', async () => {
    ctl.answers.saveRfq = { ok: false, error: LOCKED };
    expect(await actions.saveRfqAction({ ...rfq, id: RFQ })).toEqual(ctl.answers.saveRfq);
    expect(ctl.revalidated).toEqual(RFQS);
  });
});

describe('convertRfqAction', () => {
  it('makes the order in the viewer’s workspace and refreshes RFQs and Purchase Orders', async () => {
    expect(await actions.convertRfqAction({ id: RFQ })).toEqual({
      ok: true, data: { id: RFQ, purchase_order_id: '88888888-8888-4888-8888-888888888888' },
    });
    expect(ctl.calls).toEqual([{ fn: 'convertRfq', orgId: 'org1', input: { id: RFQ } }]);
    expect(ctl.revalidated).toEqual(['/finance/rfqs', '/finance/purchase-orders']);
  });
  it('refuses a viewer and the demo workspace before parsing, and an id that is not an id with the RFQ sentence', async () => {
    expect(await actions.convertRfqAction({ id: 'nope' })).toEqual(GONE);
    expect(ctl.calls).toEqual([]);
    for (const viewer of [
      { userId: 'u1', orgId: 'org1', role: 'viewer', isDemo: false },
      { userId: 'u1', orgId: 'org1', role: 'owner', isDemo: true },
    ]) {
      ctl.viewer = viewer;
      expect(await actions.convertRfqAction({ id: RFQ })).toEqual(FORBIDDEN);
      expect(await actions.convertRfqAction(null)).toEqual(FORBIDDEN);
    }
    expect(ctl.calls).toEqual([]);
  });
  it('refreshes both screens after a refusal too, so an RFQ that already has an order shows it', async () => {
    ctl.answers.convertRfq = { ok: false, error: 'This RFQ already has a purchase order. Cancel that order first to make another.' };
    expect(await actions.convertRfqAction({ id: RFQ })).toEqual(ctl.answers.convertRfq);
    expect(ctl.revalidated).toEqual(['/finance/rfqs', '/finance/purchase-orders']);
  });
});

describe('saveAndSendRfqAction', () => {
  it('saves, then marks what it saved as sent, and answers with the number', async () => {
    expect(await actions.saveAndSendRfqAction(rfq)).toEqual({ ok: true, data: { id: RFQ, rfq_no: 'RFQ-0007' } });
    expect(ctl.calls.map((c) => c.fn)).toEqual(['saveRfq', 'sendRfq']);
    expect(ctl.calls[1].input).toEqual({ id: RFQ });
    expect(ctl.revalidated).toEqual(RFQS);
  });

  it('does not send when the save is refused', async () => {
    ctl.answers.saveRfq = { ok: false, error: 'The supplier or a product on this RFQ no longer exists.' };
    expect(await actions.saveAndSendRfqAction(rfq)).toEqual(ctl.answers.saveRfq);
    expect(ctl.calls.map((c) => c.fn)).toEqual(['saveRfq']);
    expect(ctl.revalidated).toEqual(RFQS);
  });

  it('keeps the draft when sending is refused, and says which draft it is', async () => {
    ctl.answers.sendRfq = { ok: false, error: 'An RFQ needs at least one line.' };
    expect(await actions.saveAndSendRfqAction(rfq)).toEqual({ ok: false, error: 'An RFQ needs at least one line.', draftId: RFQ });
    expect(ctl.calls.map((c) => c.fn)).toEqual(['saveRfq', 'sendRfq']);
    expect(ctl.revalidated).toEqual(RFQS);
  });

  it('answers with the schema’s sentence and saves nothing when the form is refused', async () => {
    expect(await actions.saveAndSendRfqAction({ ...rfq, supplier_id: '' })).toEqual({ ok: false, error: 'Choose a supplier.' });
    expect(ctl.calls).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
  });
});

describe('getRfqAction', () => {
  const draft = { id: RFQ, status: 'draft', lines: [] };

  it('returns a draft with its lines, without refreshing anything', async () => {
    ctl.rfq = draft;
    expect(await actions.getRfqAction({ id: RFQ })).toEqual({ ok: true, data: draft });
    expect(ctl.calls).toEqual([{ fn: 'getRfq', orgId: 'org1', input: RFQ }]);
    expect(ctl.revalidated).toEqual([]);
  });

  it('says the RFQ is gone, and refreshes the list, when it was deleted meanwhile', async () => {
    expect(await actions.getRfqAction({ id: RFQ })).toEqual(GONE);
    expect(ctl.revalidated).toEqual(RFQS);
  });

  it('says the RFQ can no longer be changed, and refreshes the list, when it was sent, priced or closed meanwhile', async () => {
    for (const status of ['sent', 'quoted', 'closed']) {
      ctl.revalidated = [];
      ctl.rfq = { ...draft, status };
      expect(await actions.getRfqAction({ id: RFQ }), status).toEqual({ ok: false, error: LOCKED });
      expect(ctl.revalidated, status).toEqual(RFQS);
    }
  });

  it('says the RFQ is gone for an id that is not an id, without reading', async () => {
    expect(await actions.getRfqAction({ id: 'nope' })).toEqual(GONE);
    expect(await actions.getRfqAction(undefined)).toEqual(GONE);
    expect(ctl.calls).toEqual([]);
  });

  it('answers with a sentence when the read fails, and logs the cause', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    ctl.rfq = new Error('connection reset');
    expect(await actions.getRfqAction({ id: RFQ })).toEqual({ ok: false, error: 'That could not be loaded. Please try again.' });
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});

describe('getSentRfqAction', () => {
  const sent = { id: RFQ, status: 'sent', lines: [] };

  it('returns a sent RFQ with its lines, without refreshing anything', async () => {
    ctl.rfq = sent;
    expect(await actions.getSentRfqAction({ id: RFQ })).toEqual({ ok: true, data: sent });
    expect(ctl.revalidated).toEqual([]);
  });

  it('refuses an RFQ in any other status, and refreshes the list', async () => {
    for (const status of ['draft', 'quoted', 'closed']) {
      ctl.revalidated = [];
      ctl.rfq = { ...sent, status };
      expect(await actions.getSentRfqAction({ id: RFQ }), status).toEqual({ ok: false, error: LOCKED });
      expect(ctl.revalidated, status).toEqual(RFQS);
    }
  });

  it('says the RFQ is gone, tells a viewer they may not, and answers a failed read with a sentence', async () => {
    expect(await actions.getSentRfqAction({ id: RFQ })).toEqual(GONE);
    expect(ctl.revalidated).toEqual(RFQS);
    expect(await actions.getSentRfqAction({ id: 'nope' })).toEqual(GONE);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    ctl.rfq = new Error('connection reset');
    expect(await actions.getSentRfqAction({ id: RFQ })).toEqual({ ok: false, error: 'That could not be loaded. Please try again.' });
    logged.mockRestore();
    ctl.rfq = sent;
    for (const viewer of [
      { userId: 'u1', orgId: 'org1', role: 'viewer', isDemo: false },
      { userId: 'u1', orgId: 'org1', role: 'owner', isDemo: true },
    ]) {
      ctl.viewer = viewer;
      expect(await actions.getSentRfqAction({ id: RFQ }), JSON.stringify(viewer)).toEqual(FORBIDDEN);
    }
  });
});
