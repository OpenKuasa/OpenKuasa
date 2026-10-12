import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LOGO_BUCKET,
  LOGO_MAX_BYTES,
  LOGO_TYPES,
  DEMO_LOGO_PATH,
  isLogoPath,
  logoPath,
  logoTypeOfBytes,
  logoUrl,
  pickLogoFile,
  prepareLogoFile,
  uploadLogoFile,
} from '@/lib/account/logo';
import { LOGO_NOT_IMAGE, LOGO_REFUSALS, LOGO_TOO_BIG, LOGO_UPLOAD_FAILED } from '@/lib/account/logo-refusals';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER = '99999999-9999-4999-8999-999999999999';
const NAME = 'abcdef01-aaaa-4bbb-8ccc-0123456789ab';

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0];
const JPG = [0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0];
const WEBP = [0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50];
const file = (bytes: number[], name: string, type: string, extra = 0) =>
  new File([new Uint8Array([...bytes, ...new Array(extra).fill(0)])], name, { type });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('the limits', () => {
  it('are 1 MB and three image types, never SVG', () => {
    expect(LOGO_MAX_BYTES).toBe(1_048_576);
    expect([...LOGO_TYPES]).toEqual(['image/png', 'image/jpeg', 'image/webp']);
  });
});

describe('pickLogoFile', () => {
  it('accepts a png, a jpeg and a webp, whatever the case of the declared type', () => {
    for (const type of ['image/png', 'image/jpeg', 'IMAGE/WEBP']) {
      expect(pickLogoFile(file(PNG, 'a', type))).toEqual({ ok: true, input: expect.any(File) });
    }
  });
  it('refuses svg, gif, pdf, an empty type and a text file with the not-an-image sentence', () => {
    for (const type of ['image/svg+xml', 'image/gif', 'application/pdf', '', 'text/plain']) {
      expect(pickLogoFile(file(PNG, 'a', type))).toEqual({ ok: false, error: LOGO_NOT_IMAGE });
    }
  });
  it('refuses an empty file with the not-an-image sentence', () => {
    expect(pickLogoFile(new File([], 'a.png', { type: 'image/png' }))).toEqual({ ok: false, error: LOGO_NOT_IMAGE });
  });
  it('accepts exactly 1 MB and refuses one byte more', () => {
    expect(pickLogoFile(file([], 'a', 'image/png', LOGO_MAX_BYTES)).ok).toBe(true);
    expect(pickLogoFile(file(PNG, 'a', 'image/png', LOGO_MAX_BYTES))).toEqual({ ok: false, error: LOGO_TOO_BIG });
  });
  it('says the sentences the spec gives', () => {
    expect(LOGO_NOT_IMAGE).toBe('That file is not a PNG, JPEG or WebP image.');
    expect(LOGO_TOO_BIG).toBe('That image is over 1 MB.');
    expect(LOGO_REFUSALS.LOGO_NOT_ALLOWED).toBe("You can't change the workspace logo.");
    expect(LOGO_REFUSALS.LOGO_BAD_FILE).toBe('That image could not be saved. Upload it again.');
  });
});

describe('logoTypeOfBytes', () => {
  it('knows the three signatures', () => {
    expect(logoTypeOfBytes(new Uint8Array(PNG))).toBe('image/png');
    expect(logoTypeOfBytes(new Uint8Array(JPG))).toBe('image/jpeg');
    expect(logoTypeOfBytes(new Uint8Array(WEBP))).toBe('image/webp');
  });
  it('knows nothing else: svg, gif, riff that is not webp, short or empty input', () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(logoTypeOfBytes(enc('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(logoTypeOfBytes(enc('GIF89a......'))).toBeNull();
    expect(logoTypeOfBytes(new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45]))).toBeNull();
    expect(logoTypeOfBytes(new Uint8Array(PNG.slice(0, 5)))).toBeNull();
    expect(logoTypeOfBytes(new Uint8Array())).toBeNull();
  });
});

describe('prepareLogoFile', () => {
  it('decides the type from the bytes, whatever the browser said, and returns a file carrying it', async () => {
    const out = await prepareLogoFile(file(PNG, 'logo.JPG', ''));
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.input.type).toBe('image/png');
      expect(out.input.size).toBe(PNG.length);
    }
    const odd = await prepareLogoFile(file(JPG, 'x', 'application/octet-stream'));
    expect(odd.ok && odd.input.type).toBe('image/jpeg');
    const lying = await prepareLogoFile(file(WEBP, 'x.png', 'image/png'));
    expect(lying.ok && lying.input.type).toBe('image/webp');
  });
  it('refuses an svg even when it says it is a png, and a text file, and an empty file', async () => {
    const svg = new File(['<svg/>'], 'a.png', { type: 'image/png' });
    expect(await prepareLogoFile(svg)).toEqual({ ok: false, error: LOGO_NOT_IMAGE });
    expect(await prepareLogoFile(new File(['hello'], 'a.txt', { type: 'text/plain' }))).toEqual({ ok: false, error: LOGO_NOT_IMAGE });
    expect(await prepareLogoFile(new File([], 'a.png', { type: 'image/png' }))).toEqual({ ok: false, error: LOGO_NOT_IMAGE });
  });
  it('refuses a real image over 1 MB with the size sentence', async () => {
    expect(await prepareLogoFile(file(PNG, 'a', 'image/png', LOGO_MAX_BYTES))).toEqual({ ok: false, error: LOGO_TOO_BIG });
  });
});

describe('logoPath and isLogoPath', () => {
  it('builds <org>/<uuid>.<ext> from the file TYPE, never from its name', () => {
    const path = logoPath(ORG.toUpperCase(), file(PNG, 'evil.webp', 'image/png'));
    expect(path).toMatch(new RegExp(`^${ORG}/[0-9a-f-]{36}\\.png$`));
    expect(logoPath(ORG, file(JPG, 'a.png', 'image/jpeg'))).toMatch(/\.jpg$/);
    expect(logoPath(ORG, file(WEBP, 'a.png', 'image/webp'))).toMatch(/\.webp$/);
    expect(logoPath(ORG, file(PNG, 'a', 'image/png'))).not.toBe(logoPath(ORG, file(PNG, 'a', 'image/png')));
  });
  it('refuses to build a path for a type that is not allowed', () => {
    expect(() => logoPath(ORG, file(PNG, 'a.svg', 'image/svg+xml'))).toThrow();
    expect(() => logoPath(ORG, file(PNG, 'a.png', ''))).toThrow();
  });
  it('accepts exactly the shape in this workspace', () => {
    expect(isLogoPath(`${ORG}/${NAME}.png`, ORG)).toBe(true);
    expect(isLogoPath(`${ORG}/${NAME}.jpg`, ORG)).toBe(true);
    expect(isLogoPath(`${ORG}/${NAME}.webp`, ORG)).toBe(true);
    expect(isLogoPath(`${ORG}/${NAME}.png`, ORG.toUpperCase())).toBe(true);
  });
  it('refuses another workspace, capitals, another extension, extra segments, dots and a newline', () => {
    const bad = [
      `${OTHER}/${NAME}.png`,
      `${ORG}/${NAME.toUpperCase()}.png`,
      `${NAME.toUpperCase()}/${NAME}.png`,
      `${ORG}/${NAME}.jpeg`,
      `${ORG}/${NAME}.gif`,
      `${ORG}/${NAME}.svg`,
      `${ORG}/${NAME}.PNG`,
      `${ORG}/${NAME}.png.exe`,
      `${ORG}/extra/${NAME}.png`,
      `${ORG}/../${OTHER}/${NAME}.png`,
      `../${ORG}/${NAME}.png`,
      `${ORG}/${NAME}.png\n`,
      `/${ORG}/${NAME}.png`,
      `${ORG}/${NAME}`,
      '',
    ];
    for (const path of bad) expect(isLogoPath(path, ORG)).toBe(false);
    expect(isLogoPath(`${ORG}/${NAME}.png`, 'not-a-uuid')).toBe(false);
    expect(isLogoPath(`${NAME.toUpperCase()}/${NAME}.png`, NAME)).toBe(false);
  });
});

describe('logoUrl', () => {
  it('forms the public url from the path, as avatars do', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://proj.supabase.co');
    expect(logoUrl(`${ORG}/${NAME}.png`, { isDemo: false })).toBe(
      `https://proj.supabase.co/storage/v1/object/public/${LOGO_BUCKET}/${ORG}/${NAME}.png`,
    );
  });
  it('trims trailing slashes from the base url', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://x.supabase.co/');
    expect(logoUrl(`${ORG}/${NAME}.png`, { isDemo: false })).toBe(
      `https://x.supabase.co/storage/v1/object/public/${LOGO_BUCKET}/${ORG}/${NAME}.png`,
    );
  });
  it('gives the demo asset for a null path in the demo, and null elsewhere', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://proj.supabase.co');
    expect(logoUrl(null, { isDemo: true })).toBe(DEMO_LOGO_PATH);
    expect(DEMO_LOGO_PATH).toBe('/demo-logo.png');
    expect(logoUrl(null, { isDemo: false })).toBeNull();
  });
  it('prefers a real path to the demo asset, and gives null for a path of no known shape', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://proj.supabase.co');
    expect(logoUrl(`${ORG}/${NAME}.webp`, { isDemo: true })).toContain('/org-logos/');
    expect(logoUrl('../etc/passwd', { isDemo: false })).toBeNull();
    expect(logoUrl('javascript:alert(1)', { isDemo: true })).toBeNull();
  });
  it('gives null for a path when no project is configured', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '');
    expect(logoUrl(`${ORG}/${NAME}.png`, { isDemo: false })).toBeNull();
  });
});

describe('uploadLogoFile', () => {
  const clientOf = (upload: ReturnType<typeof vi.fn>) => {
    const buckets: string[] = [];
    const client = {
      storage: {
        from: (bucket: string) => {
          buckets.push(bucket);
          return { upload };
        },
      },
    } as never;
    return { client, buckets };
  };

  it('uploads to org-logos with no upsert, with a body that carries the type, and answers the path', async () => {
    const upload = vi.fn().mockResolvedValue({ error: null });
    const { client, buckets } = clientOf(upload);
    const f = file(PNG, 'whatever.webp', 'image/png');
    const path = `${ORG}/${NAME}.png`;
    expect(await uploadLogoFile(client, path, f)).toEqual({ ok: true, data: { path } });
    expect(buckets).toEqual(['org-logos']);
    const [p, body, options] = upload.mock.calls[0];
    expect(p).toBe(path);
    expect((body as File).type).toBe('image/png');
    expect(options).toEqual({ cacheControl: '60', contentType: 'image/png', upsert: false });
  });

  it('asks storage to cache the file for 60 seconds, not the client\'s default hour: a removed logo stops answering sooner', async () => {
    const upload = vi.fn().mockResolvedValue({ error: null });
    const { client } = clientOf(upload);
    const path = `${ORG}/${NAME}.webp`;
    await uploadLogoFile(client, path, file(WEBP, 'logo.webp', 'image/webp'));
    expect(upload.mock.calls[0][2].cacheControl).toBe('60');
  });

  it("refuses before any call: a bad path, an extension that is not the type's, a wrong type, a big file", async () => {
    const upload = vi.fn();
    const { client } = clientOf(upload);
    expect(await uploadLogoFile(client, `${OTHER.toUpperCase()}/x.png`, file(PNG, 'a', 'image/png'))).toEqual({ ok: false, error: LOGO_UPLOAD_FAILED });
    expect(await uploadLogoFile(client, `${ORG}/${NAME}.jpg`, file(PNG, 'a', 'image/png'))).toEqual({ ok: false, error: LOGO_UPLOAD_FAILED });
    expect(await uploadLogoFile(client, `${ORG}/${NAME}.png`, file([0x3c, 0x73, 0x76, 0x67], 'a', 'image/svg+xml'))).toEqual({ ok: false, error: LOGO_NOT_IMAGE });
    expect(await uploadLogoFile(client, `${ORG}/${NAME}.png`, file(PNG, 'a', 'image/png', LOGO_MAX_BYTES))).toEqual({ ok: false, error: LOGO_TOO_BIG });
    expect(upload).not.toHaveBeenCalled();
  });

  it('decides the type from the bytes: a text file named x.png declared image/png uploads nothing', async () => {
    const upload = vi.fn();
    const { client } = clientOf(upload);
    const text = new File([new TextEncoder().encode('not an image at all')], 'x.png', { type: 'image/png' });
    expect(await uploadLogoFile(client, `${ORG}/${NAME}.png`, text)).toEqual({ ok: false, error: LOGO_NOT_IMAGE });
    expect(upload).not.toHaveBeenCalled();
  });

  it('uploads real PNG bytes with an empty declared type as image/png', async () => {
    const upload = vi.fn().mockResolvedValue({ error: null });
    const { client } = clientOf(upload);
    const path = `${ORG}/${NAME}.png`;
    expect(await uploadLogoFile(client, path, file(PNG, 'a', ''))).toEqual({ ok: true, data: { path } });
    const [, body, options] = upload.mock.calls[0];
    expect((body as File).type).toBe('image/png');
    expect(options).toEqual({ cacheControl: '60', contentType: 'image/png', upsert: false });
  });

  it('answers the upload-failed sentence for a refused or thrown upload and logs no name or path', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const upload of [
      vi.fn().mockResolvedValue({ error: { message: 'new row violates SECRET' } }),
      vi.fn().mockRejectedValue(new Error('SECRET')),
    ]) {
      const { client } = clientOf(upload);
      expect(await uploadLogoFile(client, `${ORG}/${NAME}.png`, file(PNG, 'private-name.png', 'image/png'))).toEqual({ ok: false, error: LOGO_UPLOAD_FAILED });
    }
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).not.toContain('SECRET');
    expect(logged).not.toContain(ORG);
    expect(logged).not.toContain('private-name');
  });
});
