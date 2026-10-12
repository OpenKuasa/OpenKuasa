import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ctl = vi.hoisted(() => ({ heic: null as Blob | null, heicCalls: 0 }));

vi.mock('@/components/finance/receipt-heic', () => ({
  heicToJpeg: async () => {
    ctl.heicCalls += 1;
    return ctl.heic;
  },
}));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({}) }));

import { downloadReceipt, previewUrlOf, prepareReceipt } from '@/components/finance/receipt-upload';
import { INBOX_RECEIPT_MAX_BYTES } from '@/lib/finance/receipts';
import { RECEIPT_FILE_MESSAGES as M } from '@/lib/finance/receipt-files';

const text = (s: string) => Array.from(s).map((c) => c.charCodeAt(0));
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0];
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0];
const HEIC = [0, 0, 0, 24, ...text('ftypheic'), 0, 0, 0, 0, ...text('mif1heic')];
const file = (bytes: number[], name: string, type = '') => new File([new Uint8Array(bytes)], name, { type });
const served = (bytes: number[], status = 200) => vi.fn(async () => new Response(new Uint8Array(bytes), { status }));

beforeEach(() => {
  ctl.heic = null;
  ctl.heicCalls = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('previewUrlOf: bytes are checked before an object URL is made', () => {
  it('draws a JPG whose first bytes are a JPG, as a blob of the checked type', async () => {
    vi.stubGlobal('fetch', served(JPEG));
    const made = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:checked');
    expect(await previewUrlOf('https://store.example/signed', 'image/jpeg')).toBe('blob:checked');
    const blob = made.mock.calls[0][0] as Blob;
    expect(blob.type).toBe('image/jpeg');
  });

  it('gives no preview, and makes no object URL, for PNG bytes asked for as a JPEG', async () => {
    vi.stubGlobal('fetch', served(PNG));
    const made = vi.spyOn(URL, 'createObjectURL');
    expect(await previewUrlOf('u', 'image/jpeg')).toBeNull();
    expect(made).not.toHaveBeenCalled();
  });

  it('gives no preview for HTML served as an image, a failed fetch, or a thrown one', async () => {
    const made = vi.spyOn(URL, 'createObjectURL');
    vi.stubGlobal('fetch', served(text('<!doctype html><script>alert(1)</script>')));
    expect(await previewUrlOf('u', 'image/png')).toBeNull();
    vi.stubGlobal('fetch', served(PNG, 404));
    expect(await previewUrlOf('u', 'image/png')).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    expect(await previewUrlOf('u', 'image/png')).toBeNull();
    expect(made).not.toHaveBeenCalled();
  });

  it('never fetches for a PDF or a HEIC', async () => {
    const fetcher = served(PNG);
    vi.stubGlobal('fetch', fetcher);
    expect(await previewUrlOf('u', 'application/pdf')).toBeNull();
    expect(await previewUrlOf('u', 'image/heic')).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('previewUrlOf: a closed card stops the fetch', () => {
  it('passes the abort signal to the fetch and answers null once aborted', async () => {
    const stop = new AbortController();
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(init?.signal).toBe(stop.signal);
      stop.abort();
      throw new DOMException('aborted', 'AbortError');
    });
    vi.stubGlobal('fetch', fetcher);
    const made = vi.spyOn(URL, 'createObjectURL');
    expect(await previewUrlOf('u', 'image/png', stop.signal)).toBeNull();
    expect(made).not.toHaveBeenCalled();
  });

  it('makes no object URL when the card closed while the bytes were arriving', async () => {
    const stop = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        stop.abort();
        return new Response(new Uint8Array(PNG), { status: 200 });
      }),
    );
    const made = vi.spyOn(URL, 'createObjectURL');
    expect(await previewUrlOf('u', 'image/png', stop.signal)).toBeNull();
    expect(made).not.toHaveBeenCalled();
  });
});

describe('prepareReceipt', () => {
  const prepare = (f: File) => prepareReceipt(f, () => {});

  it('stores PNG bytes named .jpg as a PNG, with the name kept', async () => {
    const result = await prepare(file(PNG, 'resit.jpg', 'image/jpeg'));
    expect(result).toMatchObject({ ok: true, data: { type: 'image/png', name: 'resit.jpg' } });
  });

  it('refuses HTML named .png, whatever type the device reports', async () => {
    expect(await prepare(file(text('<!doctype html><p>hi</p>'), 'resit.png', 'image/png'))).toEqual({ ok: false, error: M.wrongType });
  });

  it('refuses zero bytes, and a file over 10 MB without reading it', async () => {
    expect(await prepare(file([], 'resit.jpg', 'image/jpeg'))).toEqual({ ok: false, error: M.empty });
    const big = { size: INBOX_RECEIPT_MAX_BYTES + 1, name: 'big.jpg' } as unknown as File;
    expect(await prepare(big)).toEqual({ ok: false, error: M.tooBig });
  });

  it('keeps a HEIC as a HEIC when it cannot be converted', async () => {
    ctl.heic = null;
    const told = vi.fn();
    const result = await prepareReceipt(file(HEIC, 'IMG_1.HEIC'), told);
    expect(told).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ ok: true, data: { type: 'image/heic', name: 'IMG_1.HEIC' } });
  });

  it('keeps a HEIC as a HEIC when the converted file is not really a JPG', async () => {
    ctl.heic = new Blob([new Uint8Array(PNG)], { type: 'image/jpeg' });
    expect(await prepare(file(HEIC, 'IMG_1.heic'))).toMatchObject({ ok: true, data: { type: 'image/heic' } });
  });

  it('uploads the JPG a HEIC was converted to, under a .jpg name', async () => {
    ctl.heic = new Blob([new Uint8Array(JPEG)], { type: 'image/jpeg' });
    const result = await prepare(file(HEIC, 'IMG_1.heic'));
    expect(result).toMatchObject({ ok: true, data: { type: 'image/jpeg', name: 'IMG_1.jpg' } });
    expect(ctl.heicCalls).toBe(1);
  });

  it('does not ask the converter about a JPG', async () => {
    await prepare(file(JPEG, 'a.jpg'));
    expect(ctl.heicCalls).toBe(0);
  });
});

describe('downloadReceipt: the page never navigates to the stored file', () => {
  const link = (type = 'image/jpeg') => ({ ok: true as const, data: { url: 'https://store.example/signed?token=t', type: type as 'image/jpeg', preview: true } });
  const anchor = { href: '', download: '', rel: '', click: vi.fn(), remove: vi.fn() };
  let navigated: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    anchor.href = '';
    anchor.download = '';
    anchor.click = vi.fn(() => {
      navigated.push(anchor.href);
    });
    anchor.remove = vi.fn();
    navigated = [];
    vi.stubGlobal('document', { createElement: () => anchor, body: { appendChild: vi.fn() } });
  });
  afterEach(() => vi.useRealTimers());

  it('fetches the bytes, saves them from an object URL under our name, and revokes it afterwards', async () => {
    const fetcher = served(JPEG);
    vi.stubGlobal('fetch', fetcher);
    const created = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:saved');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    expect(await downloadReceipt(async () => link(), 'r1')).toEqual({ ok: true, data: true });
    expect(fetcher).toHaveBeenCalledWith('https://store.example/signed?token=t', expect.objectContaining({ credentials: 'omit' }));
    expect(anchor.download).toBe('receipt.jpg');
    // The anchor points at the page's own copy, never at the stored file.
    expect(navigated).toEqual(['blob:saved']);
    // Never drawn under the app's origin if a browser ignores `download`: the type says nothing, the name carries the extension.
    const saved = created.mock.calls[0][0] as Blob;
    expect(saved.type).toBe('application/octet-stream');
    expect(saved.size).toBe(JPEG.length);
    expect(revoke).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(revoke).toHaveBeenCalledWith('blob:saved');
  });

  it('answers a sentence, and saves nothing, when the file cannot be fetched', async () => {
    const made = vi.spyOn(URL, 'createObjectURL');
    vi.stubGlobal('fetch', served(JPEG, 403));
    expect(await downloadReceipt(async () => link(), 'r1')).toEqual({ ok: false, error: M.downloadFailed });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    expect(await downloadReceipt(async () => link(), 'r1')).toEqual({ ok: false, error: M.downloadFailed });
    expect(anchor.click).not.toHaveBeenCalled();
    expect(made).not.toHaveBeenCalled();
  });

  it('reads the download sentence when the link action throws, and fetches nothing', async () => {
    const fetcher = served(JPEG);
    vi.stubGlobal('fetch', fetcher);
    const thrown = async () => {
      throw new Error('network');
    };
    expect(await downloadReceipt(thrown, 'r1')).toEqual({ ok: false, error: M.downloadFailed });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('gives up on a stalled transfer after its time limit with the same sentence', async () => {
    vi.useRealTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: unknown, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      ),
    );
    expect(await downloadReceipt(async () => link(), 'r1', 20)).toEqual({ ok: false, error: M.downloadFailed });
    expect(anchor.click).not.toHaveBeenCalled();
  });

  it('passes on the server’s sentence when no link is made, and fetches nothing', async () => {
    const fetcher = served(JPEG);
    vi.stubGlobal('fetch', fetcher);
    expect(await downloadReceipt(async () => ({ ok: false as const, error: 'That file could not be opened.' }), 'r1')).toEqual({
      ok: false,
      error: 'That file could not be opened.',
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
