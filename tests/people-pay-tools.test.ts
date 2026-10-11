import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UIMessage } from 'ai';
import type { Claim, OvertimeRecord, PeopleData, PeopleViewer } from '@/lib/people/types';

const ctl = vi.hoisted(() => ({
  ran: [] as { fn: string; orgId: string; input: unknown }[],
  uploads: [] as { userId: string; size: number; mediaType: string }[],
  fail: null as string | null,
  uploadFails: false,
  removed: [] as string[],
  released: [] as string[],
  release: true as unknown,
  decidedStatus: 'approved',
  decidedAmount: 15000,
  overtimeRate: 2500 as number | null,
}));

// Every claim and overtime function is replaced by a recorder; the schemas and `approvedThisYear` stay real.
vi.mock('@/lib/people/pay-requests', async (orig) => {
  const actual = await orig<typeof import('@/lib/people/pay-requests')>();
  const record =
    <T>(fn: string, reply: (input: Record<string, unknown>) => T) =>
    async (ctx: { orgId: string }, input: Record<string, unknown>) => {
      ctl.ran.push({ fn, orgId: ctx.orgId, input });
      if (ctl.fail === 'throw') throw new Error('secret reason: my mother is ill');
      if (ctl.fail) return { ok: false as const, error: ctl.fail };
      return { ok: true as const, data: reply(input) };
    };
  return {
    ...actual,
    submitClaim: record('submitClaim', (i) => ({ id: 'c1', status: 'pending', has_receipt: i.receipt_path != null })),
    cancelClaim: record('cancelClaim', () => ({ id: 'c1', status: 'cancelled', removed_receipt_path: 'u1/secret-file.png' })),
    decideClaim: record('decideClaim', () => ({ id: 'c1', status: 'approved' })),
    markClaimPaid: record('markClaimPaid', () => ({ id: 'c1', status: 'paid', paid_on: '2026-10-10' })),
    unmarkClaimPaid: record('unmarkClaimPaid', () => ({ id: 'c1', status: 'approved' })),
    previewOvertime: record('previewOvertime', () => ({
      day_kind: 'rest_day',
      multiplier: 2,
      hourly_rate_cents: ctl.overtimeRate,
      amount_cents: ctl.overtimeRate === null ? null : ctl.overtimeRate * 2 * 3,
    })),
    submitOvertime: record('submitOvertime', () => ({
      id: 'o1',
      status: 'pending',
      amount_cents: ctl.overtimeRate === null ? 0 : 15000,
      hourly_rate_cents: ctl.overtimeRate,
    })),
    cancelOvertime: record('cancelOvertime', () => ({ id: 'o1', status: 'cancelled' })),
    decideOvertime: record('decideOvertime', () => ({ id: 'o1', status: ctl.decidedStatus, amount_cents: ctl.decidedAmount })),
  };
});

vi.mock('@/lib/people/receipts', async (orig) => {
  const actual = await orig<typeof import('@/lib/people/receipts')>();
  return {
    ...actual,
    uploadReceipt: async (_client: unknown, userId: string, body: { byteLength: number }, mediaType: string) => {
      ctl.uploads.push({ userId, size: body.byteLength, mediaType });
      return ctl.uploadFails
        ? { ok: false as const, error: 'That file could not be uploaded.' }
        : { ok: true as const, data: { path: `${userId}/uploaded-receipt.png` } };
    },
  };
});

vi.mock('@/lib/people/receipts-server', () => ({
  // The database decides whether an upload can go; what it answers is set per test.
  releaseReceipt: async (_ctx: unknown, path: string) => {
    ctl.released.push(path);
    return ctl.release === true;
  },
  removeReceipt: async (path: string) => {
    ctl.removed.push(path);
  },
}));

const { PEOPLE_TOOL_NAMES, createPeopleTools, receiptFromMessages } = await import('@/lib/ai/people-tools');
const { PEOPLE_WRITE_TOOL_NAMES, combineToolkits, peopleProduct } = await import('@/lib/ai/products');
const { createSeedPeopleData } = await import('@/lib/people/seed');

const NOW = new Date('2026-10-09T04:00:00Z');
const ME = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const REQ = '44444444-4444-4444-8444-444444444444';
const USER = '99999999-9999-4999-8999-999999999999';
const HR_VIEWER: PeopleViewer = { employeeId: null, isHr: true, isDemo: false };
const MEMBER_VIEWER: PeopleViewer = { employeeId: ME, employeeName: 'Faiz Hakim', isHr: false, isDemo: false };
const DEMO_VIEWER: PeopleViewer = { employeeId: ME, isHr: false, isDemo: true };
const base = createSeedPeopleData(NOW);

const PNG = { bytes: Buffer.from('not really a png'), mediaType: 'image/png' };
type Receipt = { bytes: Buffer; mediaType: string } | null;
const hr = (receipt: Receipt = null) => ({
  ctx: { client: {} as never, orgId: 'org-1' },
  tier: 'hr' as const,
  employeeId: null as string | null,
  receipt,
  userId: USER,
});
const self = (employeeId: string | null = ME, receipt: Receipt = null) => ({
  ctx: { client: {} as never, orgId: 'org-1' },
  tier: 'self' as const,
  employeeId,
  receipt,
  userId: USER,
});
type Write = ReturnType<typeof hr> | ReturnType<typeof self>;

const MEMBER_PAY_TOOLS = ['previewOvertime', 'submitClaim', 'submitOvertime', 'cancelClaim', 'cancelOvertime'];
const PAY_TOOLS = ['submitClaim', 'cancelClaim', 'submitOvertime', 'cancelOvertime', 'decideClaim', 'markClaimPaid', 'unmarkClaimPaid', 'decideOvertime'];
const DECIDING = ['decideClaim', 'decideOvertime', 'markClaimPaid', 'unmarkClaimPaid'];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;
const tools = (viewer = HR_VIEWER, write?: Write, data: PeopleData = base) => createPeopleTools(data, viewer, NOW, write);
const call = (name: string, input: Record<string, unknown>, viewer = HR_VIEWER, write?: Write, data?: PeopleData): Promise<Loose> =>
  (tools(viewer, write, data)[name] as unknown as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute(input, {
    toolCallId: 't',
    messages: [],
  });
const schemaOf = (name: string, write: Write) =>
  (tools(write.tier === 'hr' ? HR_VIEWER : MEMBER_VIEWER, write)[name] as unknown as {
    inputSchema: { shape: Record<string, unknown>; safeParse: (v: unknown) => { success: boolean; data?: Record<string, unknown> } };
  }).inputSchema;
const keysOf = (name: string, write: Write) => Object.keys(schemaOf(name, write).shape).sort();

const CLAIM = { category: 'travel', amount_cents: 8500, claim_date: '2026-10-09', description: 'Taxi to the client' };

beforeEach(() => {
  ctl.ran = [];
  ctl.uploads = [];
  ctl.fail = null;
  ctl.uploadFails = false;
  ctl.removed = [];
  ctl.released = [];
  ctl.release = true;
  ctl.decidedStatus = 'approved';
  ctl.decidedAmount = 15000;
  ctl.overtimeRate = 2500;
});

describe('who holds the claim and overtime tools', () => {
  it('an owner or admin holds all of them, and the overtime preview', () => {
    const held = Object.keys(tools(HR_VIEWER, hr()));
    for (const name of [...PAY_TOOLS, 'previewOvertime']) expect(held, name).toContain(name);
    for (const name of PAY_TOOLS) expect(PEOPLE_WRITE_TOOL_NAMES, name).toContain(name);
  });

  it('a linked member holds the preview, submit and cancel for themselves, and nothing that decides or marks paid', () => {
    const held = Object.keys(tools(MEMBER_VIEWER, self()));
    for (const name of MEMBER_PAY_TOOLS) expect(held, name).toContain(name);
    for (const name of DECIDING) expect(held, name).not.toContain(name);
  });

  it('an unlinked member, a demo visitor and anyone without write access hold lookups only', () => {
    expect(Object.keys(tools(MEMBER_VIEWER, self(null)))).toEqual([...PEOPLE_TOOL_NAMES]);
    expect(Object.keys(tools(MEMBER_VIEWER))).toEqual([...PEOPLE_TOOL_NAMES]);
    expect(Object.keys(tools(DEMO_VIEWER))).toEqual([...PEOPLE_TOOL_NAMES]);
    // Even an owner in the demo: the route passes no write access there.
    expect(Object.keys(tools({ ...HR_VIEWER, isDemo: true }))).toEqual([...PEOPLE_TOOL_NAMES]);
  });

  it('every change waits for approval and the preview does not, whoever holds them', () => {
    for (const write of [hr(), self()]) {
      const kit = peopleProduct({ data: base, viewer: write.tier === 'hr' ? HR_VIEWER : MEMBER_VIEWER, write });
      const { toolApproval } = combineToolkits([kit]);
      for (const name of Object.keys(kit.write)) {
        expect(PEOPLE_WRITE_TOOL_NAMES, name).toContain(name);
        expect(toolApproval?.[name], name).toBe('user-approval');
      }
      expect(kit.read).toHaveProperty('previewOvertime');
      expect(toolApproval).not.toHaveProperty('previewOvertime');
    }
    const member = peopleProduct({ data: base, viewer: MEMBER_VIEWER, write: self() });
    expect(Object.keys(member.write).filter((n) => PAY_TOOLS.includes(n)).sort()).toEqual(
      ['cancelClaim', 'cancelOvertime', 'submitClaim', 'submitOvertime'],
    );
    const owner = peopleProduct({ data: base, viewer: HR_VIEWER, write: hr() });
    expect(Object.keys(owner.write).filter((n) => PAY_TOOLS.includes(n)).sort()).toEqual([...PAY_TOOLS].sort());
  });
});

describe('a member’s tools act for themselves only', () => {
  it('have no employee field in their schema, and an owner or admin’s do', () => {
    for (const name of ['submitClaim', 'submitOvertime', 'previewOvertime']) {
      expect(keysOf(name, self()), name).not.toContain('employee_id');
      expect(keysOf(name, hr()), name).toContain('employee_id');
    }
    expect(keysOf('submitClaim', self())).toEqual(['amount_cents', 'category', 'claim_date', 'description']);
    expect(keysOf('submitOvertime', self())).toEqual(['hours', 'reason', 'work_date']);
    expect(keysOf('previewOvertime', self())).toEqual(['hours', 'work_date']);
  });

  it('give submitClaim no file, path or bytes field, for anyone', () => {
    for (const write of [hr(), self()]) {
      for (const key of keysOf('submitClaim', write)) expect(key, key).not.toMatch(/path|file|bytes|url|base64|name/i);
    }
  });

  it('drop an employee or a path the model sends before the call is even made', () => {
    const parsed = schemaOf('submitClaim', self()).safeParse({ ...CLAIM, employee_id: OTHER, receipt_path: 'u1/other.png' });
    expect(parsed.success).toBe(true);
    expect(parsed.data).not.toHaveProperty('employee_id');
    expect(parsed.data).not.toHaveProperty('receipt_path');
  });

  it('submit and preview with the member’s own id, whatever the model sends', async () => {
    await call('submitClaim', { ...CLAIM, employee_id: OTHER }, MEMBER_VIEWER, self());
    await call('submitOvertime', { employee_id: OTHER, work_date: '2026-10-08', hours: 3 }, MEMBER_VIEWER, self());
    await call('previewOvertime', { employee_id: OTHER, work_date: '2026-10-08', hours: 3 }, MEMBER_VIEWER, self());
    expect(ctl.ran.map((r) => r.fn)).toEqual(['submitClaim', 'submitOvertime', 'previewOvertime']);
    for (const r of ctl.ran) {
      expect(r.orgId).toBe('org-1');
      expect(r.input).toMatchObject({ employee_id: ME });
    }
  });

  it('an owner or admin names the employee they submit for', async () => {
    await call('submitOvertime', { employee_id: OTHER, work_date: '2026-10-08', hours: 2.5, reason: 'Stocktake' }, HR_VIEWER, hr());
    expect(ctl.ran).toEqual([
      { fn: 'submitOvertime', orgId: 'org-1', input: { employee_id: OTHER, work_date: '2026-10-08', hours: 2.5, reason: 'Stocktake' } },
    ]);
  });

  it('cancel by request id only, for a member and for an owner or admin', async () => {
    await call('cancelClaim', { id: REQ }, MEMBER_VIEWER, self());
    await call('cancelOvertime', { id: REQ }, HR_VIEWER, hr());
    expect(ctl.ran).toEqual([
      { fn: 'cancelClaim', orgId: 'org-1', input: { id: REQ } },
      { fn: 'cancelOvertime', orgId: 'org-1', input: { id: REQ } },
    ]);
    expect(keysOf('cancelClaim', self())).toEqual(['id']);
  });
});

describe('an owner or admin’s decisions', () => {
  it('go to the decide and paid functions with the input as given', async () => {
    await call('decideClaim', { id: REQ, approve: false, note: 'No receipt' }, HR_VIEWER, hr());
    await call('markClaimPaid', { id: REQ, paid_on: '2026-10-10', reference: 'TRX-1' }, HR_VIEWER, hr());
    await call('unmarkClaimPaid', { id: REQ }, HR_VIEWER, hr());
    await call('decideOvertime', { id: REQ, approve: true }, HR_VIEWER, hr());
    expect(ctl.ran).toEqual([
      { fn: 'decideClaim', orgId: 'org-1', input: { id: REQ, approve: false, note: 'No receipt' } },
      { fn: 'markClaimPaid', orgId: 'org-1', input: { id: REQ, paid_on: '2026-10-10', reference: 'TRX-1' } },
      { fn: 'unmarkClaimPaid', orgId: 'org-1', input: { id: REQ } },
      { fn: 'decideOvertime', orgId: 'org-1', input: { id: REQ, approve: true } },
    ]);
  });
});

describe('the receipt comes from the question, never from the model', () => {
  it('uploads the attached file as the signed-in user and passes its path on', async () => {
    const out = await call('submitClaim', { ...CLAIM }, MEMBER_VIEWER, self(ME, PNG));
    expect(ctl.uploads).toEqual([{ userId: USER, size: PNG.bytes.byteLength, mediaType: 'image/png' }]);
    expect(ctl.ran[0].input).toMatchObject({ employee_id: ME, receipt_path: `${USER}/uploaded-receipt.png` });
    expect(out).toMatchObject({ ok: true, data: { id: 'c1', has_receipt: true } });
    expect(out.data.receipt_note).toMatch(/attached receipt was sent/);
  });

  it('removes the uploaded file when the database refuses the claim, and keeps it when the claim goes in', async () => {
    ctl.fail = 'You can only claim for yourself.';
    await call('submitClaim', { ...CLAIM }, MEMBER_VIEWER, self(ME, PNG));
    expect(ctl.released).toEqual([`${USER}/uploaded-receipt.png`]);
    expect(ctl.removed).toEqual([`${USER}/uploaded-receipt.png`]);
    ctl.fail = null;
    ctl.removed = [];
    await call('submitClaim', { ...CLAIM }, MEMBER_VIEWER, self(ME, PNG));
    expect(ctl.removed).toEqual([]);
  });

  it('removes the uploaded file when the claim call itself throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    ctl.fail = 'throw';
    await call('submitClaim', { ...CLAIM }, MEMBER_VIEWER, self(ME, PNG));
    expect(ctl.released).toEqual([`${USER}/uploaded-receipt.png`]);
    expect(ctl.removed).toEqual([`${USER}/uploaded-receipt.png`]);
  });

  it.each([false, null, 'true', 1, undefined])('keeps the file when the database answers %j to the release', async (answer) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    ctl.release = answer;
    ctl.fail = 'You can only claim for yourself.';
    await call('submitClaim', { ...CLAIM }, MEMBER_VIEWER, self(ME, PNG));
    ctl.fail = 'throw';
    await call('submitClaim', { ...CLAIM }, MEMBER_VIEWER, self(ME, PNG));
    expect(ctl.released).toHaveLength(2);
    expect(ctl.removed).toEqual([]);
  });

  it('never asks to release anything when the claim was saved', async () => {
    await call('submitClaim', { ...CLAIM }, MEMBER_VIEWER, self(ME, PNG));
    expect(ctl.released).toEqual([]);
  });

  it('uploads nothing and sends no path when no file came with the question', async () => {
    const out = await call('submitClaim', { ...CLAIM }, MEMBER_VIEWER, self(ME, null));
    expect(ctl.uploads).toEqual([]);
    expect(ctl.ran[0].input).toMatchObject({ receipt_path: null });
    expect(out.data.receipt_note).toMatch(/without a receipt/);
    expect(out.data.receipt_note).not.toMatch(/No receipt was attached/);
  });

  it('ignores a path the model smuggles in, with a file or without', async () => {
    const smuggled = { ...CLAIM, receipt_path: 'someone-else/their-receipt.png', receipt_attached: false };
    await call('submitClaim', smuggled, MEMBER_VIEWER, self(ME, null));
    expect(ctl.ran[0].input).toMatchObject({ receipt_path: null });
    await call('submitClaim', { ...smuggled }, MEMBER_VIEWER, self(ME, PNG));
    expect(ctl.ran[1].input).toMatchObject({ receipt_path: `${USER}/uploaded-receipt.png` });
    expect(JSON.stringify(ctl.ran)).not.toContain('their-receipt');
  });

  it('gives the model no say: a field claiming no receipt changes nothing', async () => {
    await call('submitClaim', { ...CLAIM, receipt_attached: false }, MEMBER_VIEWER, self(ME, PNG));
    expect(ctl.uploads).toHaveLength(1);
    expect(ctl.ran[0].input).toMatchObject({ receipt_path: `${USER}/uploaded-receipt.png` });
    expect(Object.keys(ctl.ran[0].input as object).sort()).toEqual(
      ['amount_cents', 'category', 'claim_date', 'description', 'employee_id', 'receipt_path'],
    );
  });

  it('says no file was attached to the message, and not that an unusable file was missing, when there is none', async () => {
    const none = await call('submitClaim', CLAIM, MEMBER_VIEWER, self(ME, null));
    expect(none.data.receipt_note).toMatch(/No file was attached to the message this claim was made from/);
  });

  it('submits without a receipt, and says why, for a file that is not a receipt type or is too big', async () => {
    const gif = await call('submitClaim', { ...CLAIM }, MEMBER_VIEWER, self(ME, { bytes: Buffer.from('gif'), mediaType: 'image/gif' }));
    const big = await call(
      'submitClaim',
      { ...CLAIM },
      MEMBER_VIEWER,
      self(ME, { bytes: Buffer.alloc(5 * 1024 * 1024 + 1), mediaType: 'application/pdf' }),
    );
    expect(ctl.uploads).toEqual([]);
    expect(ctl.ran.map((r) => (r.input as { receipt_path: unknown }).receipt_path)).toEqual([null, null]);
    expect(gif.data.receipt_note).toContain('Attach a photo (JPEG, PNG, WebP or HEIC) or a PDF.');
    expect(big.data.receipt_note).toContain('5 MB');
    expect(gif.data.receipt_note).not.toMatch(/No receipt was attached/);
  });

  it('submits without a receipt when the upload fails, and says so', async () => {
    ctl.uploadFails = true;
    const out = await call('submitClaim', { ...CLAIM }, MEMBER_VIEWER, self(ME, PNG));
    expect(ctl.ran[0].input).toMatchObject({ receipt_path: null });
    expect(out.data.receipt_note).toMatch(/could not be uploaded/);
    expect(out.data.receipt_note).not.toMatch(/No receipt was attached|No photo/);
  });

  it('never puts a storage path in what the model is told', async () => {
    const out = await call('submitClaim', { ...CLAIM }, MEMBER_VIEWER, self(ME, PNG));
    expect(JSON.stringify(out)).not.toContain('uploaded-receipt');
    const cancelled = await call('cancelClaim', { id: REQ }, MEMBER_VIEWER, self());
    expect(JSON.stringify(cancelled)).not.toContain('secret-file');
    expect(cancelled).toEqual({ ok: true, data: { id: 'c1', status: 'cancelled' } });
    // The file the cancel let go of is removed, from the path the database returned.
    expect(ctl.removed).toEqual(['u1/secret-file.png']);
  });
});

const dataUrl = (type: string, text = 'bytes') => `data:${type};base64,${Buffer.from(text).toString('base64')}`;
const user = (id: string, ...parts: UIMessage['parts']): UIMessage => ({ id, role: 'user', parts });
const file = (mediaType: string, url = dataUrl(mediaType), filename = 'receipt') => ({ type: 'file' as const, mediaType, url, filename });
const text = (t: string) => ({ type: 'text' as const, text: t });
const proposed = (state: 'approval-requested' | 'approval-responded'): UIMessage => ({
  id: 'a1',
  role: 'assistant',
  parts: [
    {
      type: 'tool-submitClaim',
      toolCallId: 't1',
      state,
      input: { ...CLAIM },
      approval: state === 'approval-responded' ? { id: 'ap1', approved: true } : { id: 'ap1' },
    } as unknown as UIMessage['parts'][number],
  ],
});

describe('finding the receipt in the request', () => {
  it('is the first image or PDF on the newest user message, as bytes and a type', () => {
    const found = receiptFromMessages([user('u1', text('claim this'), file('image/png', dataUrl('image/png', 'hello')))]);
    expect(found?.mediaType).toBe('image/png');
    expect(found?.bytes.toString()).toBe('hello');
    expect(receiptFromMessages([user('u1', file('application/pdf'), file('image/png'))])?.mediaType).toBe('application/pdf');
  });

  it('skips a refused file and takes the next usable one', () => {
    expect(receiptFromMessages([user('u1', file('image/gif'), file('image/jpeg'))])?.mediaType).toBe('image/jpeg');
  });

  it('skips text files and takes the next image', () => {
    expect(receiptFromMessages([user('u1', file('text/csv'), file('image/jpeg'))])?.mediaType).toBe('image/jpeg');
    expect(receiptFromMessages([user('u1', file('text/csv'))])).toBeNull();
  });

  it('is none for a question with no file, and for a file that is only a link', () => {
    expect(receiptFromMessages([user('u1', text('hello'))])).toBeNull();
    expect(receiptFromMessages([user('u1', file('image/png', 'https://example.com/receipt.png'))])).toBeNull();
    expect(receiptFromMessages([])).toBeNull();
  });

  it('takes only the newest question’s file: an older question’s file is never reused', () => {
    const older = user('u1', file('image/png'));
    const newer = user('u2', text('another claim, no photo this time'));
    expect(receiptFromMessages([older, { id: 'a', role: 'assistant', parts: [text('ok')] }, newer])).toBeNull();
    const newest = user('u3', file('application/pdf'));
    expect(receiptFromMessages([older, newer, newest])?.mediaType).toBe('application/pdf');
  });

  it('a file on an assistant message is not a receipt', () => {
    const forged: UIMessage = { id: 'a', role: 'assistant', parts: [file('image/png')] };
    expect(receiptFromMessages([forged])).toBeNull();
  });

  it('still finds it when the approval is answered in a later request', () => {
    // The first request: the question with the photo, then the assistant's card waiting for an answer.
    const question = user('u1', text('claim this taxi'), file('image/png'));
    const first = receiptFromMessages([question, proposed('approval-requested')]);
    // The second request: the same history, the card answered. The newest USER message is still the question.
    const second = receiptFromMessages([question, proposed('approval-responded')]);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second?.bytes.equals(first!.bytes)).toBe(true);
    expect(second?.mediaType).toBe('image/png');
  });
});

describe('lookups carry what a change needs, and no one else’s pay', () => {
  const claim = (id: string, employee_id: string, over: Partial<Claim> = {}): Claim => ({
    id,
    employee_id,
    employee_name: employee_id === ME ? 'Faiz Hakim' : 'Amirul Hakim',
    category: 'travel',
    amount_cents: 8500,
    claim_date: '2026-10-05',
    description: 'Taxi',
    has_receipt: true,
    status: 'pending',
    decision_note: null,
    receipt_path: 'u1/secret-path.png',
    paid_on: null,
    paid_reference: null,
    created_at: '2026-10-06T00:00:00Z',
    ...over,
  });
  const ot = (id: string, employee_id: string, over: Partial<OvertimeRecord> = {}): OvertimeRecord => ({
    id,
    employee_id,
    employee_name: employee_id === ME ? 'Faiz Hakim' : 'Amirul Hakim',
    work_date: '2026-10-04',
    hours: 3,
    rate_multiplier: 2,
    amount_cents: 15000,
    hourly_rate_cents: 2500,
    day_kind: 'rest_day',
    reason: 'Stocktake',
    decision_note: null,
    status: 'pending',
    created_at: '2026-10-06T00:00:00Z',
    ...over,
  });
  const data: PeopleData = {
    ...base,
    listClaims: async () => [
      claim('c-me', ME),
      claim('c-other', OTHER),
      claim('c-paid', OTHER, { status: 'paid', paid_on: '2026-10-08', amount_cents: 12000, claim_date: '2026-03-01' }),
      claim('c-approved', OTHER, { status: 'approved', amount_cents: 5000, claim_date: '2026-02-01' }),
      claim('c-rejected', ME, { status: 'rejected', decision_note: 'No receipt' }),
    ],
    listOvertime: async () => [
      ot('o-me', ME),
      ot('o-other', OTHER),
      ot('o-unset', OTHER, { hourly_rate_cents: null, amount_cents: 0, day_kind: null }),
      ot('o-legacy', OTHER, { hourly_rate_cents: null, amount_cents: 7500, day_kind: null }),
    ],
  };
  const lookup = (name: string, viewer: PeopleViewer, write?: Write, input: Record<string, unknown> = {}): Promise<Loose> =>
    call(name, input, viewer, write, data);

  it('give an owner or admin every claim’s id, the paid date, and the year’s approved-or-paid total on pending ones', async () => {
    const { claims } = await lookup('listClaims', HR_VIEWER, hr());
    expect(claims.map((c: Loose) => c.id)).toEqual(['c-me', 'c-other', 'c-paid', 'c-approved', 'c-rejected']);
    const paid = claims.find((c: Loose) => c.id === 'c-paid');
    expect(paid).toMatchObject({ status: 'paid', paid_on: '2026-10-08' });
    // Amirul has RM 120.00 paid and RM 50.00 approved in travel, both in 2026 (the pending claim itself is not counted).
    expect(claims.find((c: Loose) => c.id === 'c-other').approved_this_year).toBe('RM 170.00');
    expect(claims.find((c: Loose) => c.id === 'c-me').approved_this_year).toBe('RM 0.00');
    for (const c of claims.filter((r: Loose) => r.status !== 'pending')) expect(c).not.toHaveProperty('approved_this_year');
    expect(claims.find((c: Loose) => c.id === 'c-rejected').decision_note).toBe('No receipt');
    expect(JSON.stringify(claims)).not.toContain('secret-path');
  });

  it('count a paid claim with the approved ones in the totals, and filter on paid', async () => {
    const all = await lookup('listClaims', HR_VIEWER, hr());
    // 120.00 paid + 50.00 approved.
    expect(all.approved_or_paid_total).toBe('RM 170.00');
    const paid = await lookup('listClaims', HR_VIEWER, hr(), { status: 'paid' });
    expect(paid.total).toBe(1);
    expect(paid.approved_or_paid_total).toBe('RM 120.00');
    expect((await lookup('listClaims', HR_VIEWER, hr(), { status: 'approved' })).total).toBe(1);
  });

  it('give a member the id of their own claims only, and no year total', async () => {
    const { claims } = await lookup('listClaims', MEMBER_VIEWER, self());
    expect(claims.find((c: Loose) => c.id === 'c-me')).toBeDefined();
    expect(claims.find((c: Loose) => c.employee === 'Amirul Hakim')).not.toHaveProperty('id');
    for (const c of claims) expect(c).not.toHaveProperty('approved_this_year');
  });

  it('give an id to no one who holds no change tool', async () => {
    for (const result of [await lookup('listClaims', MEMBER_VIEWER), await lookup('listClaims', DEMO_VIEWER, self())]) {
      for (const c of result.claims) expect(c).not.toHaveProperty('id');
    }
    for (const result of [await lookup('listOvertime', MEMBER_VIEWER), await lookup('listOvertime', DEMO_VIEWER, self())]) {
      for (const o of result.overtime) expect(o).not.toHaveProperty('id');
    }
  });

  it('keep the amount of a record made before the rate was stored, and say not calculated only when there is none', async () => {
    const { overtime } = await lookup('listOvertime', HR_VIEWER, hr());
    expect(overtime.find((o: Loose) => o.id === 'o-legacy')).toMatchObject({ amount: 'RM 75.00', amount_calculated: true });
    expect(overtime.find((o: Loose) => o.id === 'o-legacy')).not.toHaveProperty('hourly_rate');
    expect(overtime.find((o: Loose) => o.id === 'o-unset')).toMatchObject({ amount: null, amount_calculated: false });
  });

  it('give the hourly rate to an owner or admin', async () => {
    const { overtime } = await lookup('listOvertime', HR_VIEWER, hr());
    expect(overtime.find((o: Loose) => o.id === 'o-other').hourly_rate).toBe('RM 25.00');
    expect(overtime.find((o: Loose) => o.id === 'o-me').hourly_rate).toBe('RM 25.00');
  });

  it('give a member the figures on their own record and none on any other row', async () => {
    const { overtime } = await lookup('listOvertime', MEMBER_VIEWER, self());
    expect(overtime.find((o: Loose) => o.id === 'o-me')).toMatchObject({ hourly_rate: 'RM 25.00', amount: 'RM 150.00', amount_calculated: true });
    const others = overtime.filter((o: Loose) => o.employee !== 'Faiz Hakim');
    expect(others.length).toBeGreaterThan(0);
    for (const o of others) {
      for (const key of ['hourly_rate', 'hourly_rate_cents', 'amount', 'amount_calculated', 'id']) expect(o, key).not.toHaveProperty(key);
      // What is left is the fact of the record, not pay.
      expect(o).toHaveProperty('hours');
      expect(o).toHaveProperty('day_kind');
    }
  });

  it('gate on who the viewer is, not on holding change tools: a read-only owner sees the figures, a read-only member only their own', async () => {
    const owner = (await lookup('listOvertime', HR_VIEWER)).overtime;
    for (const o of owner) expect(o).toHaveProperty('amount_calculated');
    expect(owner.find((o: Loose) => o.employee === 'Amirul Hakim' && o.amount_calculated)).toMatchObject({ amount: 'RM 150.00', hourly_rate: 'RM 25.00' });
    for (const o of owner) expect(o).not.toHaveProperty('id');
    const member = (await lookup('listOvertime', MEMBER_VIEWER)).overtime;
    expect(member.find((o: Loose) => o.employee === 'Faiz Hakim')).toMatchObject({ amount_calculated: true, hourly_rate: 'RM 25.00' });
    for (const o of member.filter((r: Loose) => r.employee !== 'Faiz Hakim')) {
      for (const key of ['hourly_rate', 'amount', 'amount_calculated']) expect(o, key).not.toHaveProperty(key);
    }
  });

  it('give no id to a read-only caller, and no figures to a demo visitor’s view of other people’s rows', async () => {
    for (const result of [await lookup('listOvertime', MEMBER_VIEWER), await lookup('listOvertime', DEMO_VIEWER, self())]) {
      for (const o of result.overtime) {
        expect(o).not.toHaveProperty('id');
        if (o.employee !== 'Faiz Hakim') expect(o).not.toHaveProperty('hourly_rate');
      }
    }
  });

  it('say the kind of day, and whether the amount is calculated, with no amount when it is not', async () => {
    const { overtime } = await lookup('listOvertime', HR_VIEWER, hr());
    expect(overtime.find((o: Loose) => o.id === 'o-me')).toMatchObject({ day_kind: 'rest_day', amount: 'RM 150.00', amount_calculated: true });
    const unset = overtime.find((o: Loose) => o.id === 'o-unset');
    expect(unset).toMatchObject({ day_kind: null, amount: null, amount_calculated: false });
    expect(unset).not.toHaveProperty('hourly_rate');
  });
});

describe('what the model is told after a change', () => {
  it('previews overtime in Ringgit with the kind of day, the multiplier and the rate', async () => {
    const out = await call('previewOvertime', { work_date: '2026-10-04', hours: 3 }, MEMBER_VIEWER, self());
    expect(out).toEqual({
      ok: true,
      data: { day_kind: 'rest_day', multiplier: 2, amount_calculated: true, amount: 'RM 150.00', hourly_rate: 'RM 25.00' },
    });
  });

  it('previews overtime with no salary on file as not calculated, without a rate', async () => {
    ctl.overtimeRate = null;
    const out = await call('previewOvertime', { work_date: '2026-10-04', hours: 3 }, MEMBER_VIEWER, self());
    expect(out.data).toMatchObject({ day_kind: 'rest_day', amount_calculated: false, amount: null });
    expect(out.data).not.toHaveProperty('hourly_rate');
    expect(out.data.note).toMatch(/once HR sets the salary/);
  });

  it('reports a submitted and a decided overtime in Ringgit, never as sen', async () => {
    const submitted = await call('submitOvertime', { work_date: '2026-10-04', hours: 3 }, MEMBER_VIEWER, self());
    expect(submitted).toEqual({ ok: true, data: { id: 'o1', status: 'pending', amount_calculated: true, amount: 'RM 150.00' } });
    ctl.overtimeRate = null;
    const unset = await call('submitOvertime', { work_date: '2026-10-04', hours: 3 }, MEMBER_VIEWER, self());
    expect(unset.data).toMatchObject({ amount_calculated: false, amount: null });
    const decided = await call('decideOvertime', { id: REQ, approve: true }, HR_VIEWER, hr());
    expect(decided.data).toEqual({ id: 'o1', status: 'approved', amount_calculated: true, amount: 'RM 150.00' });
  });

  it('never says RM 0.00 for an overtime decision that has no amount', async () => {
    ctl.decidedStatus = 'rejected';
    ctl.decidedAmount = 0;
    const rejected = await call('decideOvertime', { id: REQ, approve: false }, HR_VIEWER, hr());
    expect(rejected.data).toEqual({ id: 'o1', status: 'rejected', amount_calculated: false, amount: null });
    ctl.decidedStatus = 'approved';
    const unset = await call('decideOvertime', { id: REQ, approve: true }, HR_VIEWER, hr());
    expect(unset.data).toMatchObject({ amount_calculated: false, amount: null });
    expect(JSON.stringify([rejected, unset])).not.toContain('0.00');
  });

  it('passes a refusal on as it is', async () => {
    ctl.fail = 'That claim is marked as paid. Undo the paid mark first.';
    expect(await call('cancelClaim', { id: REQ }, HR_VIEWER, hr())).toEqual({ ok: false, error: ctl.fail });
  });

  it('turns a crash into a plain refusal and logs only the error’s name, never what it carried', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    ctl.fail = 'throw';
    const result = await call('submitClaim', { ...CLAIM, description: 'my mother is ill' }, MEMBER_VIEWER, self());
    expect(result).toEqual({ ok: false, error: 'That change could not be saved. Please try again.' });
    expect(JSON.stringify(log.mock.calls)).not.toContain('mother');
    expect(log).toHaveBeenCalledWith('[lekiu] submitClaim failed:', 'Error');
    ctl.fail = 'throw';
    const preview = await call('previewOvertime', { work_date: '2026-10-04', hours: 3 }, MEMBER_VIEWER, self());
    expect(preview).toEqual({ ok: false, error: 'Could not work out the overtime just now.' });
    expect(JSON.stringify(log.mock.calls)).not.toContain('mother');
    log.mockRestore();
  });
});

describe('an owner or admin’s own claims and overtime', () => {
  const NO_ONE = 'Say which employee this is for. Your own account is not linked to an employee record.';
  const linked = (employeeId: string | null) => ({ ...hr(), employeeId });
  const OT = { work_date: '2026-10-08', hours: 3 };
  const CALLS: [string, Record<string, unknown>][] = [
    ['submitClaim', CLAIM],
    ['submitOvertime', OT],
    ['previewOvertime', OT],
  ];

  it('make the employee optional in the schema', () => {
    for (const [name, input] of CALLS) {
      expect(schemaOf(name, hr()).safeParse(input).success, name).toBe(true);
      expect(keysOf(name, hr()), name).toContain('employee_id');
    }
  });

  it('act for their own linked employee when none is named', async () => {
    for (const [name, input] of CALLS) await call(name, input, HR_VIEWER, linked(ME));
    expect(ctl.ran.map((r) => r.fn)).toEqual(['submitClaim', 'submitOvertime', 'previewOvertime']);
    for (const r of ctl.ran) expect(r.input).toMatchObject({ employee_id: ME });
  });

  it('refuse, without touching the database, when none is named and their account is linked to no one', async () => {
    for (const [name, input] of CALLS) {
      expect(await call(name, input, HR_VIEWER, linked(null)), name).toEqual({ ok: false, error: NO_ONE });
    }
    expect(ctl.ran).toEqual([]);
    expect(ctl.uploads).toEqual([]);
  });

  it('let an employee they name win over their own', async () => {
    for (const [name, input] of CALLS) await call(name, { ...input, employee_id: OTHER }, HR_VIEWER, linked(ME));
    for (const r of ctl.ran) expect(r.input).toMatchObject({ employee_id: OTHER });
    expect(ctl.ran).toHaveLength(3);
  });

  it('treat an employee sent as null like one left out', async () => {
    for (const [name, input] of CALLS) {
      expect(schemaOf(name, hr()).safeParse({ ...input, employee_id: null }).success, name).toBe(true);
      await call(name, { ...input, employee_id: null }, HR_VIEWER, linked(ME));
    }
    expect(ctl.ran).toHaveLength(3);
    for (const r of ctl.ran) expect(r.input).toMatchObject({ employee_id: ME });
  });

  it('refuse when their own employee is undefined, never writing it as an id', async () => {
    const unset = { ...hr(), employeeId: undefined as unknown as null };
    for (const [name, input] of CALLS) {
      expect(await call(name, input, HR_VIEWER, unset), name).toEqual({ ok: false, error: NO_ONE });
    }
    expect(ctl.ran).toEqual([]);
  });

  it('upload no receipt when the claim is refused', async () => {
    await call('submitClaim', CLAIM, HR_VIEWER, { ...hr(PNG), employeeId: null });
    expect(ctl.uploads).toEqual([]);
  });
});
