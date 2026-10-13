import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// No model exists in this file: the reader is a recorder, and so is everything else the action calls.

const ORG = '11111111-1111-4111-8111-111111111111';
const RECEIPT = '44444444-4444-4444-8444-444444444444';
const PATH = `${ORG}/22222222-2222-4222-8222-222222222222.jpg`;
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
const WORKSPACE_KEY = 'sk-or-v1-workspace-key-0001';
const PLATFORM_KEY = 'sk-or-v1-platform-key-0002';
const TYPED = { vendor: 'Typed Sdn Bhd', receipt_date: '2026-10-01', amount: 12.5, sst_amount: null };
const CATEGORIES = [
  { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Office' },
  { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Fuel' },
];

const ctl = vi.hoisted(() => ({
  viewer: { userId: 'u1', orgId: '11111111-1111-4111-8111-111111111111', role: 'member', isDemo: false } as {
    userId: string; orgId: string; role: string; isDemo: boolean;
  },
  /** Every call the action made, in order. */
  calls: [] as { fn: string; input?: unknown }[],
  revalidated: [] as string[],
  clients: 0,
  serviceThrows: false,
  modelId: 'vendor/reader:free' as string | null,
  receipt: null as unknown,
  keyState: 'set' as 'set' | 'none' | 'unknown',
  stored: { status: 'ok', apiKey: '' } as { status: string; apiKey?: string },
  link: { ok: true, data: { url: 'https://store.example/signed' } } as unknown,
  bytes: null as Uint8Array | null,
  categories: [] as { id: string; name: string }[] | Error,
  quota: { allowed: true, remaining: 199 } as unknown,
  reading: null as unknown,
  wrote: { ok: true, data: { written: true } } as unknown,
}));

vi.mock('@/lib/auth/viewer', () => ({ getViewer: async () => ctl.viewer }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => {
    ctl.clients += 1;
    return { tag: 'caller' };
  },
}));
vi.mock('@/lib/supabase/service', () => ({
  serviceClient: () => {
    if (ctl.serviceThrows) throw new Error('Service role is not configured.');
    return { tag: 'service' };
  },
}));
vi.mock('next/cache', () => ({
  revalidatePath: (path: string) => {
    ctl.revalidated.push(path);
  },
}));
vi.mock('@/lib/ai/workspace-key', () => ({
  readWorkspaceKey: async (service: { tag: string }, orgId: string) => {
    ctl.calls.push({ fn: 'readWorkspaceKey', input: { by: service.tag, orgId } });
    return ctl.stored;
  },
}));
vi.mock('@/lib/ai/rate-limit', () => ({
  consumeDailyQuota: async (client: { tag: string }) => {
    ctl.calls.push({ fn: 'consumeDailyQuota', input: { by: client.tag } });
    return ctl.quota;
  },
}));
vi.mock('@/lib/ai/provider', () => ({
  getWorkspaceModelById: (modelId: string, apiKey: string) => {
    ctl.calls.push({ fn: 'getWorkspaceModelById', input: { modelId, apiKey } });
    return { tag: 'model', modelId, apiKey };
  },
  // Present so that a call to either would be seen: the action must make none.
  getModel: () => {
    ctl.calls.push({ fn: 'getModel' });
    return { tag: 'platform-model' };
  },
  hasProviderKey: () => true,
}));
vi.mock('@/lib/finance/expenses', async (orig) => ({
  ...(await orig<typeof import('@/lib/finance/expenses')>()),
  listExpenseCategories: async (ctx: { orgId: string; client: { tag: string } }) => {
    ctl.calls.push({ fn: 'listExpenseCategories', input: { by: ctx.client.tag, orgId: ctx.orgId } });
    if (ctl.categories instanceof Error) throw ctl.categories;
    return ctl.categories;
  },
}));
vi.mock('@/lib/finance/receipt-inbox', async (orig) => ({
  ...(await orig<typeof import('@/lib/finance/receipt-inbox')>()),
  signReceiptLink: async (ctx: { client: { tag: string } }, file: unknown) => {
    ctl.calls.push({ fn: 'signReceiptLink', input: { by: ctx.client.tag, file } });
    return ctl.link;
  },
}));
vi.mock('@/lib/finance/receipt-reader', async (orig) => ({
  // `sendableAs` is the real one: the first bytes are really checked here.
  ...(await orig<typeof import('@/lib/finance/receipt-reader')>()),
  receiptModelId: () => ctl.modelId,
  workspaceKeyState: async (client: { tag: string }) => {
    ctl.calls.push({ fn: 'workspaceKeyState', input: { by: client.tag } });
    return ctl.keyState;
  },
  getReceiptForReading: async (ctx: { orgId: string; client: { tag: string } }, id: string) => {
    ctl.calls.push({ fn: 'getReceiptForReading', input: { by: ctx.client.tag, orgId: ctx.orgId, id } });
    return ctl.receipt;
  },
  receiptBytes: async (url: string) => {
    ctl.calls.push({ fn: 'receiptBytes', input: { url } });
    return ctl.bytes;
  },
  readReceiptWithModel: async (input: unknown) => {
    ctl.calls.push({ fn: 'readReceiptWithModel', input });
    return ctl.reading;
  },
  setReceiptExtraction: async (ctx: { orgId: string; client: { tag: string } }, id: string, outcome: unknown) => {
    ctl.calls.push({ fn: 'setReceiptExtraction', input: { by: ctx.client.tag, orgId: ctx.orgId, id, outcome } });
    return ctl.wrote;
  },
}));

import { readReceiptAction } from '@/app/(app)/finance/receipt-inbox-actions';
import { RECEIPT_READING_MESSAGES as M } from '@/lib/finance/receipt-reading';
import { NOT_ALLOWED, READ_FAILED } from '@/lib/finance/result';

const fns = () => ctl.calls.map((c) => c.fn);
const called = (fn: string) => ctl.calls.filter((c) => c.fn === fn);
/** Nothing was counted, no model was built or called, and nothing was written. */
const nothingSpent = () => {
  expect(called('consumeDailyQuota')).toEqual([]);
  expect(called('readReceiptWithModel')).toEqual([]);
  expect(called('setReceiptExtraction')).toEqual([]);
  expect(called('getModel')).toEqual([]);
  expect(ctl.revalidated).toEqual([]);
};

const savedEnv = { ...process.env };

beforeEach(() => {
  ctl.viewer = { userId: 'u1', orgId: ORG, role: 'member', isDemo: false };
  ctl.calls = [];
  ctl.revalidated = [];
  ctl.clients = 0;
  ctl.serviceThrows = false;
  ctl.modelId = 'vendor/reader:free';
  ctl.receipt = { ok: true, data: { status: 'review', file: { path: PATH, type: 'image/jpeg' }, details: { ...TYPED }, extractedAt: null } };
  ctl.keyState = 'set';
  ctl.stored = { status: 'ok', apiKey: WORKSPACE_KEY };
  ctl.link = { ok: true, data: { url: 'https://store.example/signed' } };
  ctl.bytes = JPG;
  ctl.categories = CATEGORIES;
  ctl.quota = { allowed: true, remaining: 199 };
  ctl.reading = { ok: true, vendor: 'Shell Bangsar', receipt_date: '2026-10-03', amount: 142.5, sst_amount: 8.07, category_index: 1 };
  ctl.wrote = { ok: true, data: { written: true } };
  // The platform's key is on this server: the action must never use it.
  process.env.OPENROUTER_API_KEY = PLATFORM_KEY;
});

afterEach(() => {
  process.env = { ...savedEnv };
  vi.restoreAllMocks();
});

describe('who may send a receipt to be read', () => {
  it('an owner, an admin and a member may', async () => {
    for (const role of ['owner', 'admin', 'member']) {
      ctl.viewer.role = role;
      expect((await readReceiptAction({ id: RECEIPT })).ok, role).toBe(true);
    }
    expect(called('readReceiptWithModel')).toHaveLength(3);
  });

  it('a viewer and the demo are refused before a client is made, anything is read, counted or sent', async () => {
    ctl.viewer.role = 'viewer';
    expect(await readReceiptAction({ id: RECEIPT })).toEqual({ ok: false, error: NOT_ALLOWED });
    ctl.viewer = { ...ctl.viewer, role: 'owner', isDemo: true };
    expect(await readReceiptAction({ id: RECEIPT })).toEqual({ ok: false, error: NOT_ALLOWED });
    expect(ctl.calls).toEqual([]);
    expect(ctl.clients).toBe(0);
    nothingSpent();
  });

  it('answers a malformed input without a call, and takes the workspace from the session', async () => {
    expect(await readReceiptAction({ id: 'nope' })).toEqual({ ok: false, error: M.gone });
    expect(await readReceiptAction(null)).toEqual({ ok: false, error: M.gone });
    expect(ctl.calls).toEqual([]);
    await readReceiptAction({ id: RECEIPT, orgId: 'elsewhere', org_id: 'elsewhere' });
    expect(called('getReceiptForReading')[0].input).toEqual({ by: 'caller', orgId: ORG, id: RECEIPT });
    expect(called('readWorkspaceKey')[0].input).toEqual({ by: 'service', orgId: ORG });
  });
});

describe('every refusal comes before anything is counted or sent', () => {
  it('no model in the environment', async () => {
    ctl.modelId = null;
    expect(await readReceiptAction({ id: RECEIPT })).toEqual({ ok: false, error: M.notSetUp });
    expect(ctl.calls).toEqual([]);
    expect(ctl.clients).toBe(0);
  });

  it('a receipt that is gone, or could not be read', async () => {
    for (const error of [M.gone, READ_FAILED]) {
      ctl.calls = [];
      ctl.receipt = { ok: false, error };
      expect(await readReceiptAction({ id: RECEIPT })).toEqual({ ok: false, error });
      expect(fns()).toEqual(['getReceiptForReading']);
    }
    nothingSpent();
  });

  it('a receipt that is no longer in review, has no file, or is a stored HEIC: the key is never read', async () => {
    const cases: [unknown, string][] = [
      [{ status: 'unmatched', file: { path: PATH, type: 'image/jpeg' }, details: TYPED }, M.notInReview],
      [{ status: 'matched', file: { path: PATH, type: 'image/jpeg' }, details: TYPED }, M.notInReview],
      [{ status: 'review', file: null, details: TYPED }, M.noFile],
      [{ status: 'review', file: { path: PATH.replace('.jpg', '.heic'), type: 'image/heic' }, details: TYPED }, M.heic],
      [{ status: 'review', file: { path: PATH.replace('.jpg', '.heif'), type: 'image/heif' }, details: TYPED }, M.heic],
    ];
    for (const [data, error] of cases) {
      ctl.calls = [];
      ctl.receipt = { ok: true, data };
      expect(await readReceiptAction({ id: RECEIPT }), error).toEqual({ ok: false, error });
      expect(fns()).toEqual(['getReceiptForReading']);
    }
    nothingSpent();
  });

  it('no workspace key: says so, by what the person may do about it, and never falls back to the platform’s key', async () => {
    ctl.keyState = 'none';
    expect(await readReceiptAction({ id: RECEIPT })).toEqual({ ok: false, error: M.noKey });
    for (const role of ['owner', 'admin']) {
      ctl.viewer.role = role;
      expect(await readReceiptAction({ id: RECEIPT })).toEqual({ ok: false, error: M.noKeyCanAdd });
    }
    ctl.keyState = 'unknown';
    expect(await readReceiptAction({ id: RECEIPT })).toEqual({ ok: false, error: M.keyUnknown });
    expect(called('readWorkspaceKey')).toEqual([]);
    expect(called('getWorkspaceModelById')).toEqual([]);
    expect(called('signReceiptLink')).toEqual([]);
    nothingSpent();
  });

  it('a key that cannot be used on this server, or a server with no service key', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const status of ['unusable', 'error', 'none']) {
      ctl.stored = { status };
      expect(await readReceiptAction({ id: RECEIPT }), status).toEqual({ ok: false, error: M.keyUnusable });
    }
    ctl.serviceThrows = true;
    expect(await readReceiptAction({ id: RECEIPT })).toEqual({ ok: false, error: M.keyUnusable });
    expect(called('getWorkspaceModelById')).toEqual([]);
    expect(called('signReceiptLink')).toEqual([]);
    nothingSpent();
    log.mockRestore();
  });

  it('a file that cannot be fetched, and bytes that are not what the receipt says', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    ctl.link = { ok: false, error: 'That file could not be opened. Please try again.' };
    expect(await readReceiptAction({ id: RECEIPT })).toEqual({ ok: false, error: M.fileUnavailable });
    expect(called('receiptBytes')).toEqual([]);
    ctl.link = { ok: true, data: { url: 'https://store.example/signed' } };
    ctl.bytes = null;
    expect(await readReceiptAction({ id: RECEIPT })).toEqual({ ok: false, error: M.fileUnavailable });
    // A PNG stored under a receipt that says JPG.
    ctl.bytes = PNG;
    expect(await readReceiptAction({ id: RECEIPT })).toEqual({ ok: false, error: M.notWhatItSays });
    ctl.bytes = new TextEncoder().encode('<html><script>alert(1)</script>');
    expect(await readReceiptAction({ id: RECEIPT })).toEqual({ ok: false, error: M.notWhatItSays });
    expect(called('listExpenseCategories')).toEqual([]);
    nothingSpent();
    // The path begins with the workspace's id: it is never logged.
    expect(JSON.stringify(log.mock.calls)).not.toContain(ORG);
  });

  it('the daily limit, and a counter that cannot be read: the model is not called', async () => {
    ctl.quota = { allowed: false, reason: 'limit' };
    expect(await readReceiptAction({ id: RECEIPT })).toEqual({ ok: false, error: M.dailyLimit });
    ctl.quota = { allowed: false, reason: 'unavailable' };
    expect(await readReceiptAction({ id: RECEIPT })).toEqual({ ok: false, error: M.limitUnavailable });
    expect(called('consumeDailyQuota')).toHaveLength(2);
    expect(called('readReceiptWithModel')).toEqual([]);
    expect(called('setReceiptExtraction')).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
  });
});

describe('a reading', () => {
  it('runs the steps in order, counts one turn last, and makes exactly one call to the model', async () => {
    await readReceiptAction({ id: RECEIPT });
    expect(fns()).toEqual([
      'getReceiptForReading',
      'workspaceKeyState',
      'readWorkspaceKey',
      'getWorkspaceModelById',
      'signReceiptLink',
      'receiptBytes',
      'listExpenseCategories',
      'consumeDailyQuota',
      'readReceiptWithModel',
      'setReceiptExtraction',
    ]);
    // Everything about the receipt, its file, its categories and the count is asked as the caller.
    for (const fn of ['getReceiptForReading', 'workspaceKeyState', 'signReceiptLink', 'listExpenseCategories', 'consumeDailyQuota', 'setReceiptExtraction']) {
      expect((called(fn)[0].input as { by: string }).by, fn).toBe('caller');
    }
    // The service client reads the sealed key of the session's own workspace, and nothing else.
    expect(ctl.calls.filter((c) => (c.input as { by?: string } | undefined)?.by === 'service').map((c) => c.fn)).toEqual(['readWorkspaceKey']);
  });

  it('gives the model the bytes, the receipt’s type, the server’s date and the category names: no id, on the workspace’s key and the environment’s model', async () => {
    await readReceiptAction({ id: RECEIPT });
    expect(called('getWorkspaceModelById')[0].input).toEqual({ modelId: 'vendor/reader:free', apiKey: WORKSPACE_KEY });
    const given = called('readReceiptWithModel')[0].input as Record<string, unknown>;
    expect(Object.keys(given).sort()).toEqual(['bytes', 'categoryNames', 'mediaType', 'model', 'modelId', 'today']);
    expect(given.bytes).toBe(JPG);
    expect(given.mediaType).toBe('image/jpeg');
    expect(given.modelId).toBe('vendor/reader:free');
    expect(given.model).toEqual({ tag: 'model', modelId: 'vendor/reader:free', apiKey: WORKSPACE_KEY });
    expect(given.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(given.categoryNames).toEqual(['Office', 'Fuel']);
    // Not an id, not the path, not the file's name, not what the boxes held, and not the platform's key.
    const words = JSON.stringify({ ...given, bytes: undefined });
    for (const secret of [CATEGORIES[0].id, CATEGORIES[1].id, ORG, RECEIPT, 'Typed Sdn Bhd', PLATFORM_KEY]) expect(words).not.toContain(secret);
  });

  it('stores the four details as the caller and answers with the category the model’s number stands for', async () => {
    expect(await readReceiptAction({ id: RECEIPT })).toEqual({ ok: true, data: { id: RECEIPT, category: CATEGORIES[1] } });
    const write = called('setReceiptExtraction')[0].input as { orgId: string; id: string; outcome: { read: Record<string, unknown> } };
    expect(write).toMatchObject({ by: 'caller', orgId: ORG, id: RECEIPT });
    expect(write.outcome.read).toMatchObject({ vendor: 'Shell Bangsar', receipt_date: '2026-10-03', amount: 142.5, sst_amount: 8.07 });
    expect(ctl.revalidated).toEqual(['/finance/receipts-inbox']);
  });

  it('answers no category when the model chose none, chose a place outside the list, or the categories could not be read', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const category_index of [null, 2, -1]) {
      ctl.reading = { ok: true, vendor: 'Shell', receipt_date: null, amount: 5, sst_amount: null, category_index };
      expect(await readReceiptAction({ id: RECEIPT })).toEqual({ ok: true, data: { id: RECEIPT, category: null } });
    }
    ctl.calls = [];
    ctl.categories = new Error('categories unreadable');
    ctl.reading = { ok: true, vendor: 'Shell', receipt_date: null, amount: 5, sst_amount: null, category_index: 0 };
    // The receipt is still read, with no list.
    expect(await readReceiptAction({ id: RECEIPT })).toEqual({ ok: true, data: { id: RECEIPT, category: null } });
    expect((called('readReceiptWithModel')[0].input as { categoryNames: string[] }).categoryNames).toEqual([]);
    log.mockRestore();
  });

  it('a reading that arrives after someone reviewed or matched the receipt is dropped, and says so', async () => {
    ctl.wrote = { ok: true, data: { written: false } };
    expect(await readReceiptAction({ id: RECEIPT })).toEqual({ ok: false, error: M.notInReview });
    expect(ctl.revalidated).toEqual(['/finance/receipts-inbox']);
  });

  it('a reading that could not be saved says so', async () => {
    ctl.wrote = { ok: false, error: M.notSaved };
    expect(await readReceiptAction({ id: RECEIPT })).toEqual({ ok: false, error: M.notSaved });
  });
});

describe('a reading that failed', () => {
  it('nothing read, or the call failed: the failure is stored with the values the receipt held, so what a person typed is kept', async () => {
    for (const reason of ['nothing', 'failed']) {
      ctl.calls = [];
      ctl.revalidated = [];
      ctl.reading = { ok: false, reason };
      expect(await readReceiptAction({ id: RECEIPT }), reason).toEqual({ ok: false, error: M.failed });
      const write = called('setReceiptExtraction');
      expect(write).toHaveLength(1);
      expect((write[0].input as { outcome: unknown }).outcome).toEqual({ failed: true, keep: TYPED });
      expect(ctl.revalidated).toEqual(['/finance/receipts-inbox']);
    }
  });

  it('a reading already on the receipt is left alone by a failed new one: nothing is written, and the person is told the earlier one is still shown', async () => {
    ctl.receipt = {
      ok: true,
      data: { status: 'review', file: { path: PATH, type: 'image/jpeg' }, details: { ...TYPED }, extractedAt: '2026-10-12T02:00:00Z' },
    };
    for (const reason of ['nothing', 'failed']) {
      ctl.calls = [];
      ctl.revalidated = [];
      ctl.reading = { ok: false, reason };
      expect(await readReceiptAction({ id: RECEIPT }), reason).toEqual({ ok: false, error: M.failedAgain });
      expect(called('setReceiptExtraction'), reason).toEqual([]);
    }
    expect(M.failedAgain).toContain('earlier reading is still shown');
  });

  it('a provider that is busy, down or never reached writes nothing about the receipt and does not say it was sent', async () => {
    ctl.reading = { ok: false, reason: 'unavailable' };
    expect(await readReceiptAction({ id: RECEIPT })).toEqual({ ok: false, error: M.unavailable });
    expect(called('setReceiptExtraction')).toEqual([]);
    expect(M.unavailable).toMatch(/try again later/i);
    expect(M.unavailable).not.toMatch(/was sent|could not be read/i);
    // The turn was counted before the call and is not given back, as a chat turn that fails is not.
    expect(called('consumeDailyQuota')).toHaveLength(1);
  });

  it('a model that does not take the file writes nothing and says so truly', async () => {
    ctl.reading = { ok: false, reason: 'unsupported' };
    expect(await readReceiptAction({ id: RECEIPT })).toEqual({ ok: false, error: M.unsupported });
    expect(called('setReceiptExtraction')).toEqual([]);
    expect(M.unsupported).toContain('did not accept this file');
    expect(M.unsupported).toContain('a PDF can be read only by a model that takes PDFs directly');
    expect(M.unsupported).not.toMatch(/was sent|could not be read/i);
  });

  it('a PDF over 4 MB is refused from its stored size: no key opened, no download, no turn, nothing written', async () => {
    const PDF_PATH = PATH.replace('.jpg', '.pdf');
    const pdf = (sizeBytes: number | null) => ({
      ok: true,
      data: { status: 'review', file: { path: PDF_PATH, type: 'application/pdf' }, details: { ...TYPED }, extractedAt: null, sizeBytes },
    });
    ctl.receipt = pdf(4 * 1024 * 1024 + 1);
    expect(await readReceiptAction({ id: RECEIPT })).toEqual({ ok: false, error: M.pdfTooBig });
    expect(called('receiptBytes')).toEqual([]);
    expect(called('readWorkspaceKey')).toEqual([]);
    nothingSpent();
    // Exactly at the cap goes.
    ctl.calls = [];
    ctl.bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0, 0, 0, 0, 0, 0, 0]);
    ctl.receipt = pdf(4 * 1024 * 1024);
    expect((await readReceiptAction({ id: RECEIPT })).ok).toBe(true);
    expect(called('readReceiptWithModel')).toHaveLength(1);
  });

  it('a PDF whose size is not known is checked on the bytes fetched, still before a turn is counted', async () => {
    ctl.receipt = {
      ok: true,
      data: { status: 'review', file: { path: PATH.replace('.jpg', '.pdf'), type: 'application/pdf' }, details: { ...TYPED }, extractedAt: null, sizeBytes: null },
    };
    const big = new Uint8Array(4 * 1024 * 1024 + 1);
    big.set([0x25, 0x50, 0x44, 0x46, 0x2d]);
    ctl.bytes = big;
    expect(await readReceiptAction({ id: RECEIPT })).toEqual({ ok: false, error: M.pdfTooBig });
    nothingSpent();
  });

  it('an image over 4 MB still goes', async () => {
    ctl.receipt = {
      ok: true,
      data: { status: 'review', file: { path: PATH, type: 'image/jpeg' }, details: { ...TYPED }, extractedAt: null, sizeBytes: 9_000_000 },
    };
    expect((await readReceiptAction({ id: RECEIPT })).ok).toBe(true);
  });

  it('an empty file is not a reason to try again', async () => {
    ctl.bytes = new Uint8Array(0);
    expect(await readReceiptAction({ id: RECEIPT })).toEqual({ ok: false, error: M.fileEmpty });
    expect(M.fileEmpty).not.toMatch(/try again/i);
    nothingSpent();
  });

  it('the provider refused the key, or says there is no credit: nothing is written about the receipt', async () => {
    ctl.reading = { ok: false, reason: 'key' };
    expect(await readReceiptAction({ id: RECEIPT })).toEqual({ ok: false, error: M.keyRefused });
    ctl.reading = { ok: false, reason: 'credit' };
    expect(await readReceiptAction({ id: RECEIPT })).toEqual({ ok: false, error: M.noCredit });
    expect(called('setReceiptExtraction')).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
  });
});

describe('what is logged', () => {
  it('nothing of the receipt, the categories, the path or the key, whatever happens', async () => {
    const spies = (['error', 'info', 'warn', 'log'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
    await readReceiptAction({ id: RECEIPT });
    ctl.reading = { ok: false, reason: 'failed' };
    await readReceiptAction({ id: RECEIPT });
    ctl.bytes = PNG;
    await readReceiptAction({ id: RECEIPT });
    ctl.categories = new Error('Office Fuel unreadable');
    ctl.bytes = JPG;
    await readReceiptAction({ id: RECEIPT });
    ctl.serviceThrows = true;
    await readReceiptAction({ id: RECEIPT });
    const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
    for (const secret of ['Shell Bangsar', 'Typed Sdn Bhd', 'Office', 'Fuel', ORG, PATH, WORKSPACE_KEY, PLATFORM_KEY, 'store.example']) {
      expect(logged, secret).not.toContain(secret);
    }
  });
});

describe('how the code is kept safe', () => {
  const read = (path: string) => readFileSync(path, 'utf8');
  const ACTIONS = 'src/app/(app)/finance/receipt-inbox-actions.ts';
  const READER = 'src/lib/finance/receipt-reader.ts';

  it('nothing here reaches for the platform’s key, the free questions or a model id written in code', () => {
    for (const file of [ACTIONS, READER, 'src/lib/finance/receipt-reading.ts']) {
      expect(read(file), file).not.toMatch(/OPENROUTER_API_KEY|consume_free_question|resolveChatAccess|getModel\(|pickModelId|hasProviderKey/);
    }
  });

  it('the model is given no tool, and its answer is taken only through the schema', () => {
    const reader = read(READER);
    expect(reader).not.toMatch(/\btools\s*:|\btool\(|toolChoice|stopWhen/);
    expect(reader).toContain('output: Output.object({ schema: receiptReadingSchema })');
    expect(reader).toContain('maxRetries: 0');
    expect(reader.match(/generateText\(/g)).toHaveLength(1);
    expect(reader.startsWith("import 'server-only';")).toBe(true);
  });

  it('the model is called from one place, and the action writes nothing but the receipt’s own extraction', () => {
    const actions = read(ACTIONS);
    expect(actions.match(/readReceiptWithModel\(/g)).toHaveLength(1);
    expect(actions.match(/consumeDailyQuota\(/g)).toHaveLength(1);
    // Inside readReceiptAction nothing saves an expense or a bill: the two writes are both setReceiptExtraction.
    const body = actions.slice(actions.indexOf('export async function readReceiptAction'));
    expect(body).not.toMatch(/receiptToExpense|receiptToBill|attachReceipt|saveExpense|saveBill|reviewReceipt\(/);
    expect(body.match(/setReceiptExtraction\(/g)).toHaveLength(2);
    // The service client is used once in it, for the workspace's sealed key.
    expect(body.match(/serviceClient\(\)/g)).toHaveLength(1);
    expect(body).toContain('readWorkspaceKey(serviceClient(), viewer.orgId)');
  });
});
