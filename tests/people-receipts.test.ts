import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RECEIPT_BUCKET,
  RECEIPT_MAX_BYTES,
  RECEIPT_TYPES,
  receiptPath,
  receiptProblem,
  uploadReceipt,
} from '@/lib/people/receipts';

const svc = vi.hoisted(() => ({
  remove: vi.fn(),
  buckets: [] as string[],
  construct: null as null | (() => never),
}));
vi.mock('@/lib/supabase/service', () => ({
  serviceClient: () => {
    if (svc.construct) svc.construct();
    return {
      storage: {
        from: (bucket: string) => {
          svc.buckets.push(bucket);
          return { remove: svc.remove };
        },
      },
    };
  },
}));
const { removeReceipt } = await import('@/lib/people/receipts-server');

const USER = '11111111-1111-4111-8111-111111111111';
const PATH = `${USER}/44444444-4444-4444-8444-444444444444.pdf`;
const UUID_PATH = /^11111111-1111-4111-8111-111111111111\/[0-9a-f-]{36}\.(jpg|png|webp|heic|pdf)$/;

afterEach(() => vi.restoreAllMocks());

describe('the rules', () => {
  it('names the private bucket and a 5 MB limit', () => {
    expect(RECEIPT_BUCKET).toBe('hr-receipts');
    expect(RECEIPT_MAX_BYTES).toBe(5 * 1024 * 1024);
  });

  it('allows the same five types as the bucket, each with its extension', () => {
    expect(RECEIPT_TYPES).toEqual({
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
      'image/heic': 'heic',
      'application/pdf': 'pdf',
    });
  });
});

describe('receiptProblem', () => {
  it.each(Object.keys(RECEIPT_TYPES))('accepts a small %s file', (type) => {
    expect(receiptProblem({ type, size: 1000 })).toBeNull();
  });

  it('accepts a file of exactly 5 MB and refuses one byte more', () => {
    expect(receiptProblem({ type: 'image/png', size: RECEIPT_MAX_BYTES })).toBeNull();
    expect(receiptProblem({ type: 'image/png', size: RECEIPT_MAX_BYTES + 1 })).toBe('Keep the file to 5 MB or less.');
  });

  it.each(['image/gif', 'text/plain', 'application/zip', 'application/x-msdownload', '', 'IMAGE/PNG', 'toString'])(
    'refuses the type %j',
    (type) => {
      expect(receiptProblem({ type, size: 1000 })).toBe('Attach a photo (JPEG, PNG, WebP or HEIC) or a PDF.');
    },
  );

  it('refuses an empty file', () => {
    expect(receiptProblem({ type: 'application/pdf', size: 0 })).toBe('That file is empty.');
  });
});

describe('receiptPath', () => {
  it('is the user folder, a random uuid and the extension of the type', () => {
    expect(receiptPath(USER, 'application/pdf')).toMatch(UUID_PATH);
    expect(receiptPath(USER, 'image/jpeg').endsWith('.jpg')).toBe(true);
  });

  it('is different every time', () => {
    expect(receiptPath(USER, 'image/png')).not.toBe(receiptPath(USER, 'image/png'));
  });

  it('refuses a type that is not a receipt type', () => {
    expect(() => receiptPath(USER, 'text/html')).toThrow();
  });
});

describe('uploadReceipt', () => {
  const clientOf = (reply: { error: unknown } | (() => never)) => {
    const upload = vi.fn(async (...args: unknown[]) => (args.length >= 0 && typeof reply === 'function' ? reply() : reply));
    const buckets: string[] = [];
    const client = { storage: { from: (bucket: string) => (buckets.push(bucket), { upload }) } } as never;
    return { client, upload, buckets };
  };

  it('uploads into the signed-in user\'s folder of the receipts bucket and returns the path', async () => {
    const { client, upload, buckets } = clientOf({ error: null });
    const body = new Blob(['x'], { type: 'application/pdf' });
    const result = await uploadReceipt(client, USER, body, 'application/pdf');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.path).toMatch(UUID_PATH);
    expect(buckets).toEqual(['hr-receipts']);
    expect(upload).toHaveBeenCalledWith(result.data.path, body, { contentType: 'application/pdf', upsert: false });
  });

  it('works with bytes from the server as well as a browser file', async () => {
    const { client, upload } = clientOf({ error: null });
    expect((await uploadReceipt(client, USER, Buffer.from('abc'), 'image/png')).ok).toBe(true);
    expect((await uploadReceipt(client, USER, new Uint8Array([1, 2, 3]).buffer, 'image/webp')).ok).toBe(true);
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it('refuses a wrong type, an empty file and an oversized one before touching storage', async () => {
    const { client, upload } = clientOf({ error: null });
    expect(await uploadReceipt(client, USER, Buffer.from('abc'), 'text/plain')).toEqual({
      ok: false,
      error: 'Attach a photo (JPEG, PNG, WebP or HEIC) or a PDF.',
    });
    expect(await uploadReceipt(client, USER, Buffer.alloc(0), 'image/png')).toEqual({ ok: false, error: 'That file is empty.' });
    expect(await uploadReceipt(client, USER, Buffer.alloc(RECEIPT_MAX_BYTES + 1), 'image/png')).toEqual({
      ok: false,
      error: 'Keep the file to 5 MB or less.',
    });
    expect(upload).not.toHaveBeenCalled();
  });

  it('says the file could not be uploaded, logging a fixed sentence and neither the path nor the storage message', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = clientOf({ error: { message: `new row violates policy for ${PATH}` } });
    expect(await uploadReceipt(client, USER, Buffer.from('abc'), 'application/pdf')).toEqual({
      ok: false,
      error: 'That file could not be uploaded.',
    });
    expect(log.mock.calls).toEqual([['[people/receipts] a receipt could not be uploaded.']]);
  });

  it('treats a storage call that throws the same way', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = clientOf(() => {
      throw new Error(`network down ${PATH}`);
    });
    expect(await uploadReceipt(client, USER, Buffer.from('abc'), 'application/pdf')).toEqual({
      ok: false,
      error: 'That file could not be uploaded.',
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain(USER);
  });
});

describe('removeReceipt', () => {
  beforeEach(() => {
    svc.remove.mockReset();
    svc.buckets.length = 0;
    svc.construct = null;
  });

  it('removes the file from the receipts bucket with the service client', async () => {
    svc.remove.mockResolvedValue({ error: null });
    await removeReceipt(PATH);
    expect(svc.buckets).toEqual(['hr-receipts']);
    expect(svc.remove).toHaveBeenCalledWith([PATH]);
  });

  it('resolves, logging one fixed sentence without the path, when the removal fails', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    svc.remove.mockResolvedValue({ error: { message: `could not delete ${PATH}` } });
    await expect(removeReceipt(PATH)).resolves.toBeUndefined();
    expect(log.mock.calls).toEqual([['[people/receipts] a receipt file could not be removed.']]);
  });

  it('resolves when the call itself throws', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    svc.remove.mockRejectedValue(new Error(`boom ${PATH}`));
    await expect(removeReceipt(PATH)).resolves.toBeUndefined();
    expect(JSON.stringify(log.mock.calls)).not.toContain(USER);
  });

  it('resolves when no service key is configured', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    svc.construct = () => {
      throw new Error('Service role is not configured.');
    };
    await expect(removeReceipt(PATH)).resolves.toBeUndefined();
    expect(svc.remove).not.toHaveBeenCalled();
    expect(log.mock.calls).toEqual([['[people/receipts] a receipt file could not be removed.']]);
  });
});
