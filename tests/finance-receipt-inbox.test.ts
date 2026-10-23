import { describe, expect, it, vi } from 'vitest';
import {
  RECEIPT_INBOX_MESSAGES as M,
  deleteInboxReceipt,
  escapeClosesCard,
  getReceiptFile,
  inboxHiddenNote,
  registerReceipt,
  registerReceiptInput,
  reviewFormInput,
  reviewFormOf,
  reviewFormProblem,
  reviewReceipt,
  reviewReceiptInput,
  signReceiptLink,
} from '@/lib/finance/receipt-inbox';
import { NOT_ALLOWED, TOO_LARGE, WRITE_FAILED } from '@/lib/finance/result';
import { type FinanceAnswer, type FinanceCall, fakeFinance } from './setup/fake-finance';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER = '33333333-3333-4333-8333-333333333333';
const FILE = '22222222-2222-4222-8222-222222222222';
const RECEIPT = '44444444-4444-4444-8444-444444444444';
const PATH = `${ORG}/${FILE}.jpg`;

function fake(answer: FinanceAnswer | ((call: FinanceCall) => FinanceAnswer)) {
  const made = fakeFinance(answer);
  return { ctx: { client: made.ctx.client, orgId: ORG }, calls: made.calls };
}
const refusal = (code: string) => ({ data: null, error: { code, message: 'the database said something' } });

describe('registerReceipt', () => {
  it('records the path and the cleaned name in the caller’s workspace', async () => {
    const { ctx, calls } = fake({ data: RECEIPT, error: null });
    const input = registerReceiptInput.parse({ path: PATH, name: 'C:\\photos\\Resit\u0000.jpg' });
    expect(await registerReceipt(ctx, input)).toEqual({ ok: true, data: { id: RECEIPT } });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      name: 'finance_register_receipt',
      args: { target_org: ORG, file: { path: PATH, name: 'Resit.jpg' } },
    });
  });

  it('never asks the database about a path outside the caller’s workspace, or of another shape', async () => {
    for (const path of [`${OTHER}/${FILE}.jpg`, `${ORG}/${FILE}.webp`, `${ORG}/../${OTHER}/${FILE}.jpg`, 'x']) {
      const { ctx, calls } = fake({ data: RECEIPT, error: null });
      expect(await registerReceipt(ctx, { path, name: 'a.jpg' })).toEqual({ ok: false, error: M.fileGone });
      expect(calls).toHaveLength(0);
    }
  });

  it('answers with the row an earlier call made, when the file is already a receipt', async () => {
    const { ctx, calls } = fake((call) => (call.kind === 'rpc' ? refusal('FIN24') : { data: [{ id: RECEIPT }], error: null }));
    expect(await registerReceipt(ctx, { path: PATH, name: 'a.jpg' })).toEqual({ ok: true, data: { id: RECEIPT } });
    expect(calls[1]).toMatchObject({ name: 'finance_receipts', op: 'select', filters: { org_id: ORG, file_path: PATH } });
  });

  it('says to upload again when the file is not there to record', async () => {
    const { ctx } = fake((call) => (call.kind === 'rpc' ? refusal('FIN24') : { data: [], error: null }));
    expect(await registerReceipt(ctx, { path: PATH, name: 'a.jpg' })).toEqual({ ok: false, error: M.fileGone });
  });

  it('tries again with the same path when the look-up after FIN24 itself fails, and never says to upload again', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { ctx, calls } = fake((call) => (call.kind === 'rpc' ? refusal('FIN24') : { data: null, error: { code: '57014', message: PATH } }));
    expect(await registerReceipt(ctx, { path: PATH, name: 'a.jpg' })).toEqual({ ok: false, error: M.notSaved });
    expect(calls).toHaveLength(2);
    expect(log.mock.calls).toEqual([['[finance] registerReceipt look-up failed:', '57014']]);
    log.mockRestore();
  });

  it('treats a unique violation as the same file recorded twice: the first row, or not there', async () => {
    const found = fake((call) => (call.kind === 'rpc' ? refusal('23505') : { data: [{ id: RECEIPT }], error: null }));
    expect(await registerReceipt(found.ctx, { path: PATH, name: 'a.jpg' })).toEqual({ ok: true, data: { id: RECEIPT } });
    const missing = fake((call) => (call.kind === 'rpc' ? refusal('23505') : { data: [], error: null }));
    expect(await registerReceipt(missing.ctx, { path: PATH, name: 'a.jpg' })).toEqual({ ok: false, error: M.fileGone });
  });

  it('words a refusal by role, and keeps everything else to one sentence', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await registerReceipt(fake(refusal('42501')).ctx, { path: PATH, name: 'a.jpg' })).toEqual({ ok: false, error: NOT_ALLOWED });
    expect(await registerReceipt(fake(refusal('23514')).ctx, { path: PATH, name: 'a.jpg' })).toEqual({ ok: false, error: M.notSaved });
    expect(await registerReceipt(fake(refusal('XX000')).ctx, { path: PATH, name: 'a.jpg' })).toEqual({ ok: false, error: M.notSaved });
    // The path begins with a workspace id and the name is the person's: neither is logged.
    expect(JSON.stringify(log.mock.calls)).not.toContain(FILE);
    log.mockRestore();
  });
});

describe('reviewReceiptInput', () => {
  const ok = (extra: Record<string, unknown>) => reviewReceiptInput.safeParse({ id: RECEIPT, ...extra });
  const message = (extra: Record<string, unknown>) => {
    const r = ok(extra);
    return r.success ? null : r.error.issues[0].message;
  };

  it('takes every field empty, and stores empty as null', () => {
    expect(ok({}).data).toEqual({ id: RECEIPT, vendor: null, receipt_date: null, amount: null, sst_amount: null });
    expect(ok({ vendor: '   ', receipt_date: '', amount: null, sst_amount: null }).data).toMatchObject({ vendor: null, receipt_date: null });
  });

  it('trims the vendor and rounds amounts to the sen', () => {
    expect(ok({ vendor: '  Kedai Ali  ', receipt_date: '2026-10-01', amount: 12.345, sst_amount: 0 }).data).toEqual({
      id: RECEIPT, vendor: 'Kedai Ali', receipt_date: '2026-10-01', amount: 12.35, sst_amount: 0,
    });
  });

  it('cleans the vendor of control and direction characters, as a file name is', () => {
    expect(ok({ vendor: 'a\u0000b\u202ec' }).data?.vendor).toBe('abc');
    expect(ok({ vendor: '  Kedai\u200b  Ali\u061c ' }).data?.vendor).toBe('Kedai Ali');
    expect(ok({ vendor: '\u202e\u0000' }).data?.vendor).toBeNull();
    expect(message({ vendor: `${'x'.repeat(200)}\u0000y` })).toBe(M.vendor);
  });

  it('refuses what the database would, in a sentence', () => {
    expect(message({ vendor: 'x'.repeat(201) })).toBe(M.vendor);
    expect(message({ receipt_date: '2026-02-30' })).toBe(M.date);
    expect(message({ receipt_date: '0202-10-01' })).toBe(M.date);
    expect(message({ receipt_date: 'yesterday' })).toBe(M.date);
    for (const amount of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1e12, '12']) expect(message({ amount }), String(amount)).toBe(M.amount);
    expect(message({ amount: 0.004 })).toBe(M.amount);
    for (const sst of [-0.01, Number.NaN, Number.POSITIVE_INFINITY, '1']) expect(message({ amount: 10, sst_amount: sst }), String(sst)).toBe(M.sst);
    expect(message({ amount: 10, sst_amount: 10.01 })).toBe(M.sstOver);
    expect(message({ amount: 10, sst_amount: 10 })).toBeNull();
    expect(message({ sst_amount: 1 })).toBe(M.sstAlone);
    expect(reviewReceiptInput.safeParse({ id: 'nope' }).error?.issues[0].message).toBe(M.gone);
  });
});

describe('reviewReceipt and deleteInboxReceipt', () => {
  it('sends the four details to finance_review_receipt', async () => {
    const { ctx, calls } = fake({ data: null, error: null });
    const input = { id: RECEIPT, vendor: 'Kedai Ali', receipt_date: '2026-10-01', amount: 12.5, sst_amount: null };
    expect(await reviewReceipt(ctx, input)).toEqual({ ok: true, data: { id: RECEIPT } });
    expect(calls[0]).toMatchObject({
      name: 'finance_review_receipt',
      args: { target_org: ORG, target_receipt: RECEIPT, details: { vendor: 'Kedai Ali', receipt_date: '2026-10-01', amount: 12.5, sst_amount: null } },
    });
  });

  it('words each refusal', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const by = async (code: string) => (await reviewReceipt(fake(refusal(code)).ctx, { id: RECEIPT })) as { error: string };
    expect((await by('FIN11')).error).toBe(M.gone);
    expect((await by('23514')).error).toBe(M.invalid);
    expect((await by('42501')).error).toBe(NOT_ALLOWED);
    expect((await by('22003')).error).toBe(TOO_LARGE);
    expect((await by('XX000')).error).toBe(WRITE_FAILED);
    // A settings refusal answers in its own words (none of these writes meets one today).
    expect((await by('FIN63')).error).toBe('This date is in a closed period: the books are locked.');
    log.mockRestore();
  });

  it('logs only the database code of a write it cannot word, never the error object', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await reviewReceipt(fake({ data: null, error: { code: 'XX000', message: `broke at ${PATH}`, details: PATH } }).ctx, { id: RECEIPT });
    await deleteInboxReceipt(fake({ data: null, error: { code: 'XX001', message: PATH } }).ctx, { id: RECEIPT });
    expect(log.mock.calls).toEqual([
      ['[finance] reviewReceipt failed:', 'XX000'],
      ['[finance] deleteInboxReceipt failed:', 'XX001'],
    ]);
    log.mockRestore();
  });

  it('deletes one receipt of the workspace and hands back its path', async () => {
    const { ctx, calls } = fake({ data: [{ id: RECEIPT, file_path: PATH }], error: null });
    expect(await deleteInboxReceipt(ctx, { id: RECEIPT })).toEqual({ ok: true, data: { id: RECEIPT, file_path: PATH } });
    expect(calls[0]).toMatchObject({ name: 'finance_receipts', op: 'delete', filters: { org_id: ORG, id: RECEIPT }, columns: 'id,file_path' });
  });

  it('says a matched receipt is untied first, and that a receipt nobody may delete is gone', async () => {
    expect(await deleteInboxReceipt(fake(refusal('FIN23')).ctx, { id: RECEIPT })).toEqual({ ok: false, error: M.matched });
    expect(await deleteInboxReceipt(fake({ data: [], error: null }).ctx, { id: RECEIPT })).toEqual({ ok: false, error: M.gone });
  });
});

describe('the file', () => {
  it('reads the path as the caller, and refuses a row with no file or a path of another workspace', async () => {
    const row = (file_path: string | null) => fake({ data: [{ file_path, mime_type: 'image/jpeg' }], error: null });
    expect(await getReceiptFile(row(PATH).ctx, RECEIPT)).toEqual({ ok: true, data: { path: PATH, type: 'image/jpeg' } });
    expect(await getReceiptFile(row(null).ctx, RECEIPT)).toEqual({ ok: false, error: M.noFile });
    expect(await getReceiptFile(row(`${OTHER}/${FILE}.jpg`).ctx, RECEIPT)).toEqual({ ok: false, error: M.noFile });
    expect(await getReceiptFile(fake({ data: [], error: null }).ctx, RECEIPT)).toEqual({ ok: false, error: M.gone });
  });

  it('signs a one-minute link that always carries a download name of ours', async () => {
    const createSignedUrl = vi.fn(async () => ({ data: { signedUrl: 'https://store.example/signed' }, error: null }));
    const from = vi.fn(() => ({ createSignedUrl }));
    const ctx = { client: { storage: { from } } as never, orgId: ORG };
    expect(await signReceiptLink(ctx, { path: PATH, type: 'application/pdf' })).toEqual({ ok: true, data: { url: 'https://store.example/signed' } });
    expect(from).toHaveBeenCalledWith('finance-receipts');
    expect(createSignedUrl).toHaveBeenCalledWith(PATH, 60, { download: 'receipt.pdf' });
  });

  it('answers one sentence when the link is refused or the call throws, and logs no path', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const refused = { storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: { message: PATH } }) }) } };
    const thrown = { storage: { from: () => ({ createSignedUrl: async () => { throw new Error(PATH); } }) } };
    for (const client of [refused, thrown]) {
      expect(await signReceiptLink({ client: client as never, orgId: ORG }, { path: PATH, type: 'image/png' })).toEqual({ ok: false, error: M.fileUnavailable });
    }
    expect(JSON.stringify(log.mock.calls)).not.toContain(FILE);
    log.mockRestore();
  });
});

describe('the review form', () => {
  const row = { vendor: 'Kedai Ali', receipt_date: '2026-10-01', amount: 1200.5, sst_amount: null };

  it('starts from what the receipt holds', () => {
    expect(reviewFormOf(row)).toEqual({ vendor: 'Kedai Ali', date: '2026-10-01', amount: '1200.50', sst: '' });
    expect(reviewFormOf({ vendor: null, receipt_date: null, amount: null, sst_amount: 0 })).toEqual({ vendor: '', date: '', amount: '', sst: '0.00' });
  });

  it('sends empty boxes as nothing and typed ones as numbers', () => {
    expect(reviewFormInput(RECEIPT, { vendor: '', date: '', amount: ' ', sst: '' })).toEqual({ id: RECEIPT, vendor: '', receipt_date: '', amount: null, sst_amount: null });
    expect(reviewFormInput(RECEIPT, { vendor: 'A', date: '2026-10-01', amount: '12.5', sst: '.5' })).toMatchObject({ amount: 12.5, sst_amount: 0.5 });
  });

  it('refuses a typed comma, letters and a future date before anything is sent', () => {
    const problem = (form: Partial<{ vendor: string; date: string; amount: string; sst: string }>) =>
      reviewFormProblem(RECEIPT, { vendor: '', date: '', amount: '', sst: '', ...form }, '2026-10-12');
    expect(problem({})).toBeNull();
    expect(problem({ amount: '1,200.50' })).toBe(M.amount);
    expect(problem({ amount: 'RM 12' })).toBe(M.amount);
    expect(problem({ amount: '1e3' })).toBe(M.amount);
    expect(problem({ amount: '12', sst: '1,0' })).toBe(M.sst);
    expect(problem({ amount: '12', sst: '13' })).toBe(M.sstOver);
    expect(problem({ sst: '1' })).toBe(M.sstAlone);
    expect(problem({ date: '2026-10-12' })).toBeNull();
    expect(problem({ date: '2026-10-13' })).toBe(M.future);
  });
});

describe('inboxHiddenNote', () => {
  const listed = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

  it('says nothing when what was written is on the screen, or not yet in the list', () => {
    expect(inboxHiddenNote({ kind: 'added', ids: ['a'] }, listed, listed, 'all')).toBeNull();
    expect(inboxHiddenNote({ kind: 'added', ids: ['z'] }, listed, [], 'matched')).toBeNull();
  });

  it('says where an added or reviewed receipt went', () => {
    expect(inboxHiddenNote({ kind: 'added', ids: ['a', 'b'] }, listed, [{ id: 'c' }], 'unmatched')).toBe(
      '2 receipts were added and are under To review: choose To review or All receipts in the status filter.',
    );
    expect(inboxHiddenNote({ kind: 'added', ids: ['a'] }, listed, [], 'all')).toBe(
      '1 receipt was added and is not in the rows below: clear the search or choose View all.',
    );
    expect(inboxHiddenNote({ kind: 'reviewed', ids: ['a'] }, listed, [{ id: 'b' }], 'review')).toContain('now under Unmatched');
    expect(inboxHiddenNote({ kind: 'reviewed', ids: ['a'] }, listed, [{ id: 'b' }], 'all')).toContain('Clear the search');
  });
});

describe('escapeClosesCard', () => {
  it('closes on Escape pressed in the card, and on nothing else', () => {
    expect(escapeClosesCard({ key: 'Escape' }, false)).toBe(true);
    expect(escapeClosesCard({ key: 'Enter' }, false)).toBe(false);
    expect(escapeClosesCard({ key: 'a' }, false)).toBe(false);
  });

  it('does not close while a save is on its way', () => {
    expect(escapeClosesCard({ key: 'Escape' }, true)).toBe(false);
  });

  it('does not close an Escape that ends text composition', () => {
    expect(escapeClosesCard({ key: 'Escape', isComposing: true }, false)).toBe(false);
    expect(escapeClosesCard({ key: 'Escape', keyCode: 229 }, false)).toBe(false);
  });
});
