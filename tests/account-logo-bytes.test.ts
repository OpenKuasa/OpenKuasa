import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as browserHalf from '@/lib/account/logo';
import { LOGO_EXTENSION, LOGO_MAX_BYTES, LOGO_TYPES, logoBytesRefusal, logoTypeOfBytes, logoTypeOfPath } from '@/lib/account/logo-bytes';
import { LOGO_NOT_IMAGE, LOGO_TOO_BIG } from '@/lib/account/logo-refusals';

const ORG = '11111111-1111-4111-8111-111111111111';
const NAME = 'abcdef01-aaaa-4bbb-8ccc-0123456789ab';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]);
const path = (ext: string) => `${ORG}/${NAME}.${ext}`;

describe('the byte check, shared by the browser and the server', () => {
  it('is one function: the browser half re-exports the very one the server imports', () => {
    expect(browserHalf.logoTypeOfBytes).toBe(logoTypeOfBytes);
    expect(browserHalf.LOGO_MAX_BYTES).toBe(LOGO_MAX_BYTES);
    expect(browserHalf.LOGO_TYPES).toBe(LOGO_TYPES);
  });

  it('lives in a leaf module: nothing imported but the sentences', () => {
    const source = readFileSync(resolve('src/lib/account/logo-bytes.ts'), 'utf8');
    expect([...source.matchAll(/from '([^']+)'/g)].map((m) => m[1])).toEqual(['./logo-refusals']);
    // And the server reads the bytes with it, not with a copy.
    const server = readFileSync(resolve('src/lib/account/logo-server.ts'), 'utf8');
    expect(server).toContain("from './logo-bytes'");
    expect(server).not.toMatch(/0x89|0xff, 0xd8|RIFF/);
  });

  it('knows the three signatures and nothing else', () => {
    expect(logoTypeOfBytes(PNG)).toBe('image/png');
    expect(logoTypeOfBytes(JPG)).toBe('image/jpeg');
    expect(logoTypeOfBytes(WEBP)).toBe('image/webp');
    for (const other of ['<svg xmlns="http://www.w3.org/2000/svg">', 'GIF89a......', '%PDF-1.7 .....', 'RIFF1234WAVEfmt ', '', 'plain text']) {
      expect(logoTypeOfBytes(new TextEncoder().encode(other)), other).toBeNull();
    }
  });

  it('knows the type a path ends in', () => {
    expect(logoTypeOfPath(path('png'))).toBe('image/png');
    expect(logoTypeOfPath(path('jpg'))).toBe('image/jpeg');
    expect(logoTypeOfPath(path('webp'))).toBe('image/webp');
    for (const other of [path('svg'), path('PNG'), path('jpeg'), `${ORG}/${NAME}`, '', 'png']) expect(logoTypeOfPath(other), other).toBeNull();
    expect(Object.entries(LOGO_EXTENSION)).toEqual([['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/webp', 'webp']]);
  });
});

describe('logoBytesRefusal', () => {
  it('lets through bytes that are the image the path says, up to 1 MB', () => {
    expect(logoBytesRefusal({ size: 12, head: PNG, path: path('png') })).toBeNull();
    expect(logoBytesRefusal({ size: 500, head: JPG, path: path('jpg') })).toBeNull();
    expect(logoBytesRefusal({ size: LOGO_MAX_BYTES, head: WEBP, path: path('webp') })).toBeNull();
  });
  it('refuses bytes that are no image with the not-an-image sentence, whatever the path and the size', () => {
    const text = new TextEncoder().encode('hello, I am text');
    expect(logoBytesRefusal({ size: 16, head: text, path: path('png') })).toBe(LOGO_NOT_IMAGE);
    expect(logoBytesRefusal({ size: LOGO_MAX_BYTES + 1, head: text, path: path('png') })).toBe(LOGO_NOT_IMAGE);
    expect(logoBytesRefusal({ size: 0, head: new Uint8Array(), path: path('png') })).toBe(LOGO_NOT_IMAGE);
    expect(logoBytesRefusal({ size: 0, head: PNG, path: path('png') })).toBe(LOGO_NOT_IMAGE);
    expect(logoBytesRefusal({ size: Number.NaN, head: PNG, path: path('png') })).toBe(LOGO_NOT_IMAGE);
  });
  it('refuses an image over 1 MB with the size sentence', () => {
    expect(logoBytesRefusal({ size: LOGO_MAX_BYTES + 1, head: PNG, path: path('png') })).toBe(LOGO_TOO_BIG);
  });
  it('refuses an image whose bytes are not the type its path ends in', () => {
    expect(logoBytesRefusal({ size: 12, head: JPG, path: path('png') })).toBe(LOGO_NOT_IMAGE);
    expect(logoBytesRefusal({ size: 12, head: PNG, path: path('webp') })).toBe(LOGO_NOT_IMAGE);
    expect(logoBytesRefusal({ size: 12, head: PNG, path: path('svg') })).toBe(LOGO_NOT_IMAGE);
  });
});
