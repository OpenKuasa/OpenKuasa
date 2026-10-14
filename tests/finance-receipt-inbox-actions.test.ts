import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ORG = '11111111-1111-4111-8111-111111111111';
const FILE = '22222222-2222-4222-8222-222222222222';
const RECEIPT = '44444444-4444-4444-8444-444444444444';
const PATH = `${ORG}/${FILE}.jpg`;

const ctl = vi.hoisted(() => ({
  viewer: { userId: 'u1', orgId: '11111111-1111-4111-8111-111111111111', role: 'member', isDemo: false } as {
    userId: string; orgId: string; role: string; isDemo: boolean;
  },
  calls: [] as { fn: string; orgId?: string; input: unknown }[],
  revalidated: [] as string[],
  answers: {} as Record<string, unknown>,
  check: 'match' as 'match' | 'mismatch' | 'unreadable',
  serviceThrows: false,
  /** How many times a client was made for the caller. */
  clients: 0,
}));

vi.mock('@/lib/auth/viewer', () => ({ getViewer: async () => ctl.viewer }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => {
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

function recorder(fn: string, ok: unknown) {
  return async (ctx: { orgId: string }, input: unknown) => {
    ctl.calls.push({ fn, orgId: ctx.orgId, input });
    return ctl.answers[fn] ?? { ok: true, data: ok };
  };
}

vi.mock('@/lib/finance/receipt-inbox', async (orig) => {
  const actual = await orig<typeof import('@/lib/finance/receipt-inbox')>();
  const id = '44444444-4444-4444-8444-444444444444';
  const path = '11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222.jpg';
  return {
    ...actual,
    registerReceipt: recorder('registerReceipt', { id }),
    reviewReceipt: recorder('reviewReceipt', { id }),
    deleteInboxReceipt: recorder('deleteInboxReceipt', { id, file_path: path }),
    getReceiptFile: recorder('getReceiptFile', { path, type: 'image/jpeg' }),
    signReceiptLink: recorder('signReceiptLink', { url: 'https://store.example/signed' }),
  };
});

vi.mock('@/lib/finance/receipt-files-server', () => ({
  removeReleasedReceiptFile: async (service: { tag: string }, path: string) => {
    ctl.calls.push({ fn: 'removeReleasedReceiptFile', input: { by: service.tag, path } });
    return true;
  },
  storedFileCheck: async (url: string, type: string) => {
    ctl.calls.push({ fn: 'storedFileCheck', input: { url, type } });
    return ctl.check;
  },
}));

import {
  deleteReceiptAction,
  receiptLinkAction,
  registerReceiptAction,
  reviewReceiptAction,
} from '@/app/(app)/finance/receipt-inbox-actions';
import { RECEIPT_INBOX_MESSAGES as M } from '@/lib/finance/receipt-inbox';
import { NOT_ALLOWED } from '@/lib/finance/result';

beforeEach(() => {
  ctl.viewer = { userId: 'u1', orgId: ORG, role: 'member', isDemo: false };
  ctl.calls = [];
  ctl.revalidated = [];
  ctl.answers = {};
  ctl.check = 'match';
  ctl.serviceThrows = false;
  ctl.clients = 0;
});

const WRITES: [string, (input: unknown) => Promise<{ ok: boolean; error?: string }>, unknown][] = [
  ['register', registerReceiptAction, { path: PATH, name: 'a.jpg' }],
  ['review', reviewReceiptAction, { id: RECEIPT, amount: 12 }],
  ['delete', deleteReceiptAction, { id: RECEIPT }],
];

describe('who may write', () => {
  it.each(WRITES)('%s: an owner, an admin and a member may', async (_name, action, input) => {
    for (const role of ['owner', 'admin', 'member']) {
      ctl.viewer.role = role;
      expect((await action(input)).ok, role).toBe(true);
    }
    expect(ctl.revalidated).toEqual(Array(3).fill('/finance/receipts-inbox'));
    expect(ctl.calls.every((c) => c.orgId === undefined || c.orgId === ORG)).toBe(true);
  });

  it.each(WRITES)('%s: a viewer and the demo are refused before anything is read or written', async (_name, action, input) => {
    ctl.viewer.role = 'viewer';
    expect(await action(input)).toEqual({ ok: false, error: NOT_ALLOWED });
    ctl.viewer = { ...ctl.viewer, role: 'member', isDemo: true };
    expect(await action(input)).toEqual({ ok: false, error: NOT_ALLOWED });
    expect(ctl.calls).toEqual([]);
    // Not even a client is made before the guard has answered.
    expect(ctl.clients).toBe(0);
    expect(ctl.revalidated).toEqual([]);
  });

  it('answers a malformed input with the schema’s sentence, without a call', async () => {
    expect(await reviewReceiptAction({ id: RECEIPT, amount: Number.NaN })).toEqual({ ok: false, error: M.amount });
    expect(await deleteReceiptAction({ id: 'nope' })).toEqual({ ok: false, error: M.gone });
    expect(await registerReceiptAction({ path: 7, name: 'a' })).toEqual({ ok: false, error: M.fileGone });
    expect(ctl.calls).toEqual([]);
  });

  it('takes the workspace from the session, never from the input', async () => {
    await registerReceiptAction({ path: PATH, name: 'a.jpg', orgId: 'elsewhere', org_id: 'elsewhere' });
    expect(ctl.calls[0]).toEqual({ fn: 'registerReceipt', orgId: ORG, input: { path: PATH, name: 'a.jpg' } });
  });
});

describe('deleteReceiptAction', () => {
  it('removes the file with the service client after the row is gone, and keeps the path on the server', async () => {
    expect(await deleteReceiptAction({ id: RECEIPT })).toEqual({ ok: true, data: { id: RECEIPT } });
    expect(ctl.calls.map((c) => c.fn)).toEqual(['deleteInboxReceipt', 'removeReleasedReceiptFile']);
    expect(ctl.calls[1].input).toEqual({ by: 'service', path: PATH });
  });

  it('removes nothing when the delete was refused, or the receipt had no file', async () => {
    ctl.answers.deleteInboxReceipt = { ok: false, error: M.matched };
    expect(await deleteReceiptAction({ id: RECEIPT })).toEqual({ ok: false, error: M.matched });
    ctl.answers.deleteInboxReceipt = { ok: true, data: { id: RECEIPT, file_path: null } };
    expect(await deleteReceiptAction({ id: RECEIPT })).toEqual({ ok: true, data: { id: RECEIPT } });
    expect(ctl.calls.map((c) => c.fn)).toEqual(['deleteInboxReceipt', 'deleteInboxReceipt']);
  });

  it('still succeeds when the server has no service key: the clean-up run takes the file', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    ctl.serviceThrows = true;
    expect(await deleteReceiptAction({ id: RECEIPT })).toEqual({ ok: true, data: { id: RECEIPT } });
    expect(JSON.stringify(log.mock.calls)).not.toContain(FILE);
    log.mockRestore();
  });
});

describe('receiptLinkAction', () => {
  it('lets a viewer and a demo guest open a file: reading is membership', async () => {
    for (const viewer of [{ role: 'viewer', isDemo: false }, { role: 'member', isDemo: true }]) {
      ctl.viewer = { ...ctl.viewer, ...viewer };
      expect(await receiptLinkAction({ id: RECEIPT })).toEqual({
        ok: true,
        data: { url: 'https://store.example/signed', type: 'image/jpeg', preview: true },
      });
    }
    expect(ctl.revalidated).toEqual([]);
  });

  it('checks the stored bytes before it hands the link out', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    ctl.check = 'mismatch';
    expect(await receiptLinkAction({ id: RECEIPT })).toEqual({ ok: false, error: M.notWhatItSays });
    ctl.check = 'unreadable';
    expect(await receiptLinkAction({ id: RECEIPT })).toEqual({ ok: false, error: M.fileUnavailable });
    expect(ctl.calls.filter((c) => c.fn === 'storedFileCheck')).toHaveLength(2);
    log.mockRestore();
  });

  it('never previews a PDF or a HEIC, and stops at a receipt with no file', async () => {
    ctl.answers.getReceiptFile = { ok: true, data: { path: PATH, type: 'application/pdf' } };
    expect(await receiptLinkAction({ id: RECEIPT })).toMatchObject({ ok: true, data: { preview: false } });
    ctl.answers.getReceiptFile = { ok: false, error: M.noFile };
    ctl.calls = [];
    expect(await receiptLinkAction({ id: RECEIPT })).toEqual({ ok: false, error: M.noFile });
    expect(ctl.calls.map((c) => c.fn)).toEqual(['getReceiptFile']);
  });
});

describe('how the code is kept safe', () => {
  const read = (path: string) => readFileSync(path, 'utf8');
  const SOURCES = [
    'src/components/finance/receipts-inbox-view.tsx',
    'src/components/finance/receipt-review-card.tsx',
    'src/components/finance/receipt-upload-card.tsx',
    'src/components/finance/receipt-match-cards.tsx',
    'src/components/finance/attached-receipts.tsx',
    'src/components/finance/receipt-upload.ts',
    'src/components/finance/receipt-heic.ts',
  ];

  it('exports only async functions from the actions file', async () => {
    const actions = await import('@/app/(app)/finance/receipt-inbox-actions');
    expect(Object.keys(actions).sort()).toEqual([
      'attachReceiptAction',
      'deleteReceiptAction',
      'detachReceiptAction',
      'readReceiptAction',
      'receiptLinkAction',
      'receiptToBillAction',
      'receiptToExpenseAction',
      'registerReceiptAction',
      'reviewReceiptAction',
    ]);
    for (const [name, value] of Object.entries(actions)) {
      expect(typeof value, name).toBe('function');
      expect((value as { constructor: { name: string } }).constructor.name, name).toBe('AsyncFunction');
    }
    expect(read('src/app/(app)/finance/receipt-inbox-actions.ts').startsWith("'use server';")).toBe(true);
  });

  it('never points an image, a frame or a new tab at a stored file, and draws no HTML', () => {
    for (const file of SOURCES) {
      const source = read(file);
      expect(source, file).not.toMatch(/dangerouslySetInnerHTML|<iframe|<embed|<object|window\.open|target="_blank"/);
      expect(source, file).not.toMatch(/purple|violet|indigo|fuchsia/);
    }
    // The one image element is fed an object URL the page made from bytes it checked.
    const card = read('src/components/finance/receipt-review-card.tsx');
    expect(card.match(/<img /g)).toHaveLength(1);
    expect(card).toContain('<img src={preview.url}');
    // That its bytes are checked first is tested by running it: tests/finance-receipt-upload.test.ts.
  });

  it('keeps the focus target off anything that is always on the page, so a row menu moves focus to what it opened', () => {
    expect(read('src/components/finance/receipt-upload-card.tsx')).not.toContain('data-finance-focus');
  });

  it('has no way left in the receipt components to point the page at a link', () => {
    // A source check, stricter than a name: it proves these files contain no navigation of any kind and no `href`
    // except the one temporary anchor of the saved copy. It cannot prove what that anchor is given; the run test in
    // tests/finance-receipt-upload.test.ts does ("navigated" is only ever the page's own blob: URL).
    const components = SOURCES.filter((f) => !f.endsWith('receipt-heic.ts'));
    for (const file of components) {
      const source = read(file);
      expect(source, file).not.toMatch(/location\.(href|assign|replace)|window\.open|\.open\(|startDownload|href=\{|href=["']/);
      for (const line of source.split('\n').filter((l) => /\.href\s*=/.test(l))) {
        expect(line.trim(), file).toBe('link.href = copy;');
      }
    }
  });

  it('loads the HEIC decoder only on demand, and only its build that needs no WebAssembly', () => {
    const heic = read('src/components/finance/receipt-heic.ts');
    expect(heic).toContain("await import('heic-to/csp')");
    expect(heic).not.toMatch(/^import .*heic-to/m);
    for (const file of SOURCES.filter((f) => !f.endsWith('receipt-heic.ts'))) expect(read(file), file).not.toContain('heic-to');
  });

  it('does not raise the server action body limit or loosen the Content-Security-Policy', () => {
    expect(read('next.config.ts')).toContain('bodySizeLimit: "6mb"');
    expect(read('src/lib/security/headers.ts')).not.toContain('wasm-unsafe-eval');
  });
});
