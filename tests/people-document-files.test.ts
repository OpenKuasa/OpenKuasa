import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DOCUMENT_BUCKET,
  DOCUMENT_FILE_TYPES,
  DOCUMENT_MAX_BYTES,
  documentFileFacts,
  documentFileName,
  documentMediaType,
  documentPath,
  isDocumentPath,
  isDocumentPathShape,
  pickDocumentFile,
  uploadDocumentFile,
} from '@/lib/people/document-files';
import { DOCUMENT_REFUSALS, FILE_UNAVAILABLE } from '@/lib/people/documents-refusals';

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
const { documentLink, releaseDocumentFile, removeDocumentFile, removeDocumentFiles } = await import(
  '@/lib/people/document-files-server'
);

const ORG = '11111111-1111-4111-8111-111111111111';
const EMP = '22222222-2222-4222-8222-222222222222';
const DOC = '33333333-3333-4333-8333-333333333333';
const NAME = 'abcdef01-aaaa-4bbb-8ccc-0123456789ab';
const PATH = `${ORG}/${EMP}/${NAME}.pdf`;

const file = (name: string, type: string, bytes = 100) => new File([new Uint8Array(bytes)], name, { type });
const fake = (name: string, type: string, size: number) => ({ name, type, size }) as unknown as File;

afterEach(() => {
  vi.restoreAllMocks();
  svc.remove.mockReset();
  svc.buckets.length = 0;
  svc.construct = null;
});

describe('the rules', () => {
  it('names the private bucket, a 10 MB limit and the five types with their extensions', () => {
    expect(DOCUMENT_BUCKET).toBe('hr-documents');
    expect(DOCUMENT_MAX_BYTES).toBe(10 * 1024 * 1024);
    expect(DOCUMENT_FILE_TYPES).toEqual({
      'application/pdf': 'pdf',
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
      'image/heic': 'heic',
    });
  });
});

describe('documentMediaType', () => {
  it('keeps a real type', () => {
    expect(documentMediaType({ type: 'application/pdf', name: 'a.png' })).toBe('application/pdf');
  });
  it('works the type out from the extension when the browser gave none (HEIC is the usual case)', () => {
    expect(documentMediaType({ type: '', name: 'IMG_1.HEIC' })).toBe('image/heic');
    expect(documentMediaType({ type: 'application/octet-stream', name: 'scan.pdf' })).toBe('application/pdf');
    expect(documentMediaType({ type: '', name: 'photo.jpeg' })).toBe('image/jpeg');
  });
  it('treats image/heif as image/heic, whatever its case', () => {
    expect(documentMediaType({ type: 'image/heif', name: 'a.heif' })).toBe('image/heic');
    expect(documentMediaType({ type: 'IMAGE/HEIF' })).toBe('image/heic');
  });
  it('leaves an unknown type unknown', () => {
    expect(documentMediaType({ type: '', name: 'notes.txt' })).toBe('');
    expect(documentMediaType({ type: 'text/plain', name: 'notes.pdf' })).toBe('text/plain');
  });
});

describe('pickDocumentFile', () => {
  it.each(Object.keys(DOCUMENT_FILE_TYPES))('accepts a small %s file', (type) => {
    const f = file('a', type);
    expect(pickDocumentFile(f)).toEqual({ ok: true, input: f });
  });
  it('accepts a headerless HEIC by its extension', () => {
    expect(pickDocumentFile(file('IMG_2.heic', '')).ok).toBe(true);
  });
  it('accepts exactly 10 MB and refuses one byte more with the spec sentence', () => {
    expect(pickDocumentFile(fake('a.pdf', 'application/pdf', DOCUMENT_MAX_BYTES)).ok).toBe(true);
    expect(pickDocumentFile(fake('a.pdf', 'application/pdf', DOCUMENT_MAX_BYTES + 1))).toEqual({
      ok: false,
      error: 'That file is larger than 10 MB.',
    });
  });
  it('refuses another type with the spec sentence', () => {
    expect(pickDocumentFile(file('a.txt', 'text/plain'))).toEqual({
      ok: false,
      error: 'Use a PDF or an image (JPEG, PNG, WebP or HEIC).',
    });
    expect(pickDocumentFile(file('a.exe', '')).ok).toBe(false);
  });
  it('refuses an empty file', () => {
    expect(pickDocumentFile(file('a.pdf', 'application/pdf', 0))).toEqual({ ok: false, error: 'That file is empty.' });
  });
});

describe('documentFileName and documentFileFacts', () => {
  it('keeps an ordinary name', () => {
    expect(documentFileName({ type: 'application/pdf', name: 'Contract (signed).pdf' })).toBe('Contract (signed).pdf');
  });
  it('removes control characters and slashes, which the database refuses', () => {
    const name = documentFileName({ type: 'application/pdf', name: 'a/b\\c\u0000d\n.pdf' });
    expect(name).toBe('a-b-cd.pdf');
    expect(name).not.toMatch(/[/\\\u0000-\u001f]/);
  });
  it('cuts a long name to 200 characters and keeps the extension', () => {
    const name = documentFileName({ type: 'application/pdf', name: `${'x'.repeat(300)}.pdf` });
    expect(name).toHaveLength(200);
    expect(name.endsWith('.pdf')).toBe(true);
  });
  it('gives a name with nothing left a plain one', () => {
    expect(documentFileName({ type: 'application/pdf', name: '  ' })).toBe('document.pdf');
    expect(documentFileName({ type: 'image/png', name: '\n' })).toBe('document.png');
    expect(documentFileName({ type: 'image/png', name: '..' })).toBe('document.png');
  });
  it('declares the real byte length and the very type the file is uploaded with', () => {
    const f = file('IMG_3.HEIC', '', 321);
    expect(documentFileFacts(f)).toEqual({ file_name: 'IMG_3.HEIC', file_size: 321, file_type: 'image/heic' });
    expect(documentFileFacts(file('s.pdf', 'application/pdf', 7))).toEqual({
      file_name: 's.pdf',
      file_size: 7,
      file_type: 'application/pdf',
    });
  });
});

describe('documentPath and isDocumentPath', () => {
  it('is <org>/<employee>/<uuid>.<ext>, in lower case, with the extension of the type', () => {
    const path = documentPath(ORG.toUpperCase(), EMP, file('a', 'image/jpeg'));
    expect(path).toMatch(new RegExp(`^${ORG}/${EMP}/[0-9a-f-]{36}\\.jpg$`));
    expect(documentPath(ORG, EMP, file('IMG.heic', ''))).toMatch(/\.heic$/);
    expect(documentPath(ORG, EMP, file('a', 'application/pdf'))).not.toBe(documentPath(ORG, EMP, file('a', 'application/pdf')));
  });
  it('refuses to make a path for a type the bucket does not take', () => {
    expect(() => documentPath(ORG, EMP, file('a.txt', 'text/plain'))).toThrow();
  });
  it('accepts a path it made, and only for that workspace and employee', () => {
    const path = documentPath(ORG, EMP, file('a', 'application/pdf'));
    expect(isDocumentPath(path, ORG, EMP)).toBe(true);
    expect(isDocumentPath(path, EMP, EMP)).toBe(false);
    expect(isDocumentPath(path, ORG, ORG)).toBe(false);
    expect(isDocumentPathShape(path)).toBe(true);
  });
  it('refuses a path in another workspace or another employee\'s folder, though its shape is fine', () => {
    const other = '99999999-9999-4999-8999-999999999999';
    for (const path of [`${other}/${EMP}/${NAME}.pdf`, `${ORG}/${other}/${NAME}.pdf`]) {
      expect(isDocumentPathShape(path)).toBe(true);
      expect(isDocumentPath(path, ORG, EMP)).toBe(false);
    }
  });
  it.each([
    ['dot-dot', `${ORG}/${EMP}/../${NAME}.pdf`],
    ['dot-dot as the employee', `${ORG}/../${NAME}.pdf`],
    ['upper case', `${ORG}/${EMP}/${NAME.toUpperCase()}.pdf`],
    ['upper case extension', `${ORG}/${EMP}/${NAME}.PDF`],
    ['no extension', `${ORG}/${EMP}/${NAME}`],
    ['an unknown extension', `${ORG}/${EMP}/${NAME}.exe`],
    ['too deep', `${ORG}/${EMP}/x/${NAME}.pdf`],
    ['too shallow', `${EMP}/${NAME}.pdf`],
    ['a leading slash', `/${ORG}/${EMP}/${NAME}.pdf`],
    ['a trailing newline', `${ORG}/${EMP}/${NAME}.pdf\n`],
    ['empty', ''],
  ])('refuses %s', (_label, path) => {
    expect(isDocumentPath(path, ORG, EMP)).toBe(false);
    expect(isDocumentPathShape(path)).toBe(false);
  });
});

describe('uploadDocumentFile', () => {
  const clientOf = (reply: () => unknown) => {
    const upload = vi.fn(async (path: string, body: File, options: { contentType: string; upsert: boolean }) => {
      void [path, body, options];
      return reply();
    });
    const from = vi.fn(() => ({ upload }));
    return { client: { storage: { from } } as never, upload, from };
  };

  it('uploads into the private bucket with the declared type, never as an upsert, and returns the path', async () => {
    const { client, upload, from } = clientOf(() => ({ error: null }));
    const f = file('IMG_4.heic', '', 50);
    const path = documentPath(ORG, EMP, f);
    expect(await uploadDocumentFile(client, path, f)).toEqual({ ok: true, data: { path } });
    expect(from).toHaveBeenCalledWith('hr-documents');
    expect(upload).toHaveBeenCalledWith(path, expect.objectContaining({ type: 'image/heic', size: 50 }), { contentType: 'image/heic', upsert: false });
    expect(upload.mock.calls[0][2].contentType).toBe(documentFileFacts(f).file_type);
  });
  it.each([
    ['a .heic with no type', 'IMG_5.heic', '', 'image/heic'],
    ['an image/heif file', 'IMG_6.heif', 'image/heif', 'image/heic'],
    ['an upper-case type', 'a.PDF', 'APPLICATION/PDF', 'application/pdf'],
    ['an octet-stream pdf', 'b.pdf', 'application/octet-stream', 'application/pdf'],
  ])('sends storage a body whose own type is the declared one, for %s', async (_label, name, type, declared) => {
    const { client, upload } = clientOf(() => ({ error: null }));
    const f = file(name, type, 64);
    const path = documentPath(ORG, EMP, f);
    expect((await uploadDocumentFile(client, path, f)).ok).toBe(true);
    const body = upload.mock.calls[0][1];
    expect(body.type).toBe(declared);
    expect(body.type).toBe(documentFileFacts(f).file_type);
    expect(body.size).toBe(f.size);
    expect(body.name).toBe(f.name);
  });
  it('refuses a bad file without touching storage', async () => {
    const { client, from } = clientOf(() => ({ error: null }));
    expect(await uploadDocumentFile(client, PATH, file('a.txt', 'text/plain'))).toEqual({
      ok: false,
      error: 'Use a PDF or an image (JPEG, PNG, WebP or HEIC).',
    });
    expect(from).not.toHaveBeenCalled();
  });
  it('refuses a path that is not of the shape, without touching storage', async () => {
    const { client, from } = clientOf(() => ({ error: null }));
    const result = await uploadDocumentFile(client, `${ORG}/../x.pdf`, file('a.pdf', 'application/pdf'));
    expect(result).toEqual({ ok: false, error: 'The upload did not finish. Try again.' });
    expect(from).not.toHaveBeenCalled();
  });
  it.each([
    ['an error', () => ({ error: { message: `refused ${PATH}` } })],
    ['a throw', () => {
      throw new Error(`boom ${PATH}`);
    }],
  ])('answers %s with one sentence and logs neither the path nor the file name', async (_label, reply) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = clientOf(reply);
    const result = await uploadDocumentFile(client, PATH, file('secret-name.pdf', 'application/pdf'));
    expect(result).toEqual({ ok: false, error: 'The upload did not finish. Try again.' });
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).not.toContain(PATH);
    expect(logged).not.toContain(ORG);
    expect(logged).not.toContain('secret-name');
  });
});

describe('removeDocumentFile', () => {
  it('removes one path from the private bucket with the service client', async () => {
    svc.remove.mockResolvedValue({ error: null });
    await removeDocumentFile(PATH);
    expect(svc.buckets).toEqual(['hr-documents']);
    expect(svc.remove).toHaveBeenCalledOnce();
    expect(svc.remove).toHaveBeenCalledWith([PATH]);
  });
  it.each([
    ['dot-dot', `${ORG}/${EMP}/../${NAME}.pdf`],
    ['a folder', `${ORG}/${EMP}`],
    ['a pattern', `${ORG}/${EMP}/*`],
    ['empty', ''],
    ['upper case', PATH.toUpperCase()],
  ])('does not call storage for %s', async (_label, path) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await removeDocumentFile(path);
    expect(svc.remove).not.toHaveBeenCalled();
    expect(svc.buckets).toEqual([]);
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.stringify(log.mock.calls)).not.toContain(path || 'never-empty-match');
  });
  it('never throws, and logs one fixed sentence that holds no path', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    svc.remove.mockResolvedValue({ error: { message: `no ${PATH}` } });
    await expect(removeDocumentFile(PATH)).resolves.toBeUndefined();
    svc.remove.mockRejectedValue(new Error(`boom ${PATH}`));
    await expect(removeDocumentFile(PATH)).resolves.toBeUndefined();
    svc.construct = () => {
      throw new Error('Service role is not configured.');
    };
    await expect(removeDocumentFile(PATH)).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledTimes(3);
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).not.toContain(PATH);
    expect(logged).not.toContain(ORG);
  });
});

describe('removeDocumentFiles', () => {
  it('removes each path on its own, in order, and carries on past a failure', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const second = `${ORG}/${EMP}/55555555-5555-4555-8555-555555555555.png`;
    const third = `${ORG}/${EMP}/66666666-6666-4666-8666-666666666666.jpg`;
    svc.remove.mockResolvedValueOnce({ error: null }).mockResolvedValueOnce({ error: { message: 'x' } }).mockResolvedValueOnce({ error: null });
    await removeDocumentFiles([PATH, second, third]);
    expect(svc.remove.mock.calls).toEqual([[[PATH]], [[second]], [[third]]]);
    expect(log).toHaveBeenCalledOnce();
  });
  it('does nothing for no paths', async () => {
    await removeDocumentFiles([]);
    expect(svc.remove).not.toHaveBeenCalled();
  });
});

describe('releaseDocumentFile', () => {
  const ctxOf = (reply: () => unknown) => {
    const rpc = vi.fn(async () => reply());
    return { ctx: { client: { rpc } as never }, rpc };
  };

  it('asks the database by path and is true only for exactly true', async () => {
    const yes = ctxOf(() => ({ data: true, error: null }));
    expect(await releaseDocumentFile(yes.ctx, PATH)).toBe(true);
    expect(yes.rpc).toHaveBeenCalledWith('hr_release_document_file', { p_path: PATH });
    for (const data of [false, null, 'true', 1, {}]) {
      expect(await releaseDocumentFile(ctxOf(() => ({ data, error: null })).ctx, PATH)).toBe(false);
    }
  });
  it('is false for an error or a throw and logs no path', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await releaseDocumentFile(ctxOf(() => ({ data: true, error: { message: `x ${PATH}` } })).ctx, PATH)).toBe(false);
    expect(
      await releaseDocumentFile(
        ctxOf(() => {
          throw new Error(PATH);
        }).ctx,
        PATH,
      ),
    ).toBe(false);
    expect(JSON.stringify(log.mock.calls)).not.toContain(PATH);
  });
});

describe('documentLink', () => {
  const ctxOf = (row: unknown, sign: () => unknown) => {
    const filters: Record<string, unknown> = {};
    const select = vi.fn();
    const builder = {
      select: (columns: string) => {
        select(columns);
        return builder;
      },
      eq: (column: string, value: unknown) => {
        filters[column] = value;
        return builder;
      },
      maybeSingle: async () => row,
    };
    const createSignedUrl = vi.fn(async () => sign());
    const bucket = vi.fn(() => ({ createSignedUrl }));
    const ctx = { client: { from: () => builder, storage: { from: bucket } } as never, orgId: ORG };
    return { ctx, select, filters, createSignedUrl, bucket };
  };
  const SIGNED = 'https://example.test/storage/v1/object/sign/hr-documents/x?token=abc';

  it('reads the path with the caller\'s own client, signs it for one minute and returns only the link', async () => {
    const t = ctxOf({ data: { file_path: PATH }, error: null }, () => ({ data: { signedUrl: SIGNED }, error: null }));
    expect(await documentLink(t.ctx, DOC)).toEqual({ ok: true, data: { url: SIGNED } });
    expect(t.select).toHaveBeenCalledWith('file_path');
    expect(t.filters).toEqual({ id: DOC, org_id: ORG });
    expect(t.bucket).toHaveBeenCalledWith('hr-documents');
    expect(t.createSignedUrl).toHaveBeenCalledWith(PATH, 60);
    expect(JSON.stringify(await documentLink(t.ctx, DOC))).not.toContain(PATH);
  });
  it('does not use the service client', async () => {
    svc.construct = () => {
      throw new Error('the service client must not be built');
    };
    const t = ctxOf({ data: { file_path: PATH }, error: null }, () => ({ data: { signedUrl: SIGNED }, error: null }));
    expect((await documentLink(t.ctx, DOC)).ok).toBe(true);
  });
  it('says the document is not found for a row the caller cannot read, one with no file, or a bad id, and signs nothing', async () => {
    for (const row of [{ data: null, error: null }, { data: { file_path: null }, error: null }]) {
      const t = ctxOf(row, () => ({ data: { signedUrl: SIGNED }, error: null }));
      expect(await documentLink(t.ctx, DOC)).toEqual({ ok: false, error: DOCUMENT_REFUSALS.DOC_NOT_FOUND });
      expect(t.createSignedUrl).not.toHaveBeenCalled();
    }
    const t = ctxOf({ data: { file_path: PATH }, error: null }, () => ({ data: { signedUrl: SIGNED }, error: null }));
    expect(await documentLink(t.ctx, 'not-an-id')).toEqual({ ok: false, error: DOCUMENT_REFUSALS.DOC_NOT_FOUND });
    expect(t.select).not.toHaveBeenCalled();
  });
  it('refuses a stored path that is not of the shape, without signing it', async () => {
    const t = ctxOf({ data: { file_path: `${ORG}/../x.pdf` }, error: null }, () => ({ data: { signedUrl: SIGNED }, error: null }));
    expect(await documentLink(t.ctx, DOC)).toEqual({ ok: false, error: FILE_UNAVAILABLE });
    expect(t.createSignedUrl).not.toHaveBeenCalled();
  });
  it.each([
    ['a refused signature', () => ({ data: null, error: { message: `no ${PATH}` } })],
    ['no link', () => ({ data: {}, error: null })],
    ['a throw', () => {
      throw new Error(PATH);
    }],
  ])('answers %s with one sentence and logs no path', async (_label, sign) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const t = ctxOf({ data: { file_path: PATH }, error: null }, sign);
    expect(await documentLink(t.ctx, DOC)).toEqual({ ok: false, error: FILE_UNAVAILABLE });
    expect(JSON.stringify(log.mock.calls)).not.toContain(PATH);
  });
  it('answers a failed read with one sentence and logs no path', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const t = ctxOf({ data: null, error: { message: 'down' } }, () => ({ data: { signedUrl: SIGNED }, error: null }));
    expect(await documentLink(t.ctx, DOC)).toEqual({ ok: false, error: FILE_UNAVAILABLE });
    expect(t.createSignedUrl).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalled();
  });
});
