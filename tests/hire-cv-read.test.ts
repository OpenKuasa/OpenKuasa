// tests/hire-cv-read.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createCvReader } from '@/lib/hire/cv-read';
import type { Application, HireData } from '@/lib/hire/types';

const ID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const PATH = 'org/job/secret-file-name.pdf';
const NAME = 'Aina Rahman';
const JOB = 'Sales Executive';
const PDF = new TextEncoder().encode('%PDF-1.4\n%test\n');

const app = (over: Partial<Application> = {}): Application =>
  ({ id: ID, candidate_name: NAME, job_title: JOB, cv_path: PATH, cv_url: null, ...over }) as Application;

const dataWith = (apps: () => Promise<Application[]>) => ({ listApplications: vi.fn(apps) }) as unknown as HireData & {
  listApplications: ReturnType<typeof vi.fn>;
};

function clientWith(download: () => Promise<unknown>) {
  const dl = vi.fn(download);
  const from = vi.fn(() => ({ download: dl }));
  return { client: { storage: { from } } as unknown as SupabaseClient, from, dl };
}
const blobOf = (bytes: Uint8Array) => async () => ({ data: new Blob([bytes as BlobPart]), error: null });

afterEach(() => vi.restoreAllMocks());

describe('createCvReader', () => {
  it('answers missing for a value that is not a UUID, reading nothing', async () => {
    const data = dataWith(async () => [app()]);
    const { client, dl } = clientWith(blobOf(PDF));
    expect(await createCvReader(client, data).readCv('../etc/passwd')).toEqual({ state: 'missing' });
    expect(data.listApplications).not.toHaveBeenCalled();
    expect(dl).not.toHaveBeenCalled();
  });

  it('answers missing for an id no application has, downloading nothing', async () => {
    const data = dataWith(async () => [app()]);
    const { client, dl } = clientWith(blobOf(PDF));
    expect(await createCvReader(client, data).readCv(OTHER)).toEqual({ state: 'missing' });
    expect(dl).not.toHaveBeenCalled();
  });

  it('answers none, with whether there is a link', async () => {
    const { client, dl } = clientWith(blobOf(PDF));
    const link = dataWith(async () => [app({ cv_path: null, cv_url: 'https://example.com/cv' })]);
    expect(await createCvReader(client, link).readCv(ID)).toEqual({
      state: 'none', hasLink: true, candidate: NAME, job: JOB,
    });
    const bare = dataWith(async () => [app({ cv_path: null })]);
    expect(await createCvReader(client, bare).readCv(ID)).toEqual({
      state: 'none', hasLink: false, candidate: NAME, job: JOB,
    });
    expect(dl).not.toHaveBeenCalled();
  });

  it('downloads the file from the CV bucket', async () => {
    const { client, from, dl } = clientWith(blobOf(PDF));
    const got = await createCvReader(client, dataWith(async () => [app()])).readCv(ID);
    expect(got).toMatchObject({ state: 'ok', candidate: NAME, job: JOB });
    expect(got.state === 'ok' && Array.from(got.bytes)).toEqual(Array.from(PDF));
    expect(from).toHaveBeenCalledWith('hire-cvs');
    expect(dl).toHaveBeenCalledWith(PATH);
  });

  it('answers failed on a download error, a throw, a non-PDF, an empty file and an oversize file', async () => {
    const data = dataWith(async () => [app()]);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = async () => ({ data: null, error: { name: 'StorageApiError', statusCode: '404', message: PATH } });
    expect(await createCvReader(clientWith(failing).client, data).readCv(ID)).toEqual({ state: 'failed' });
    const throwing = async () => {
      throw Object.assign(new Error(PATH), { name: 'FetchError' });
    };
    expect(await createCvReader(clientWith(throwing).client, data).readCv(ID)).toEqual({ state: 'failed' });
    const text = new TextEncoder().encode('hello, not a pdf');
    expect(await createCvReader(clientWith(blobOf(text)).client, data).readCv(ID)).toEqual({ state: 'failed' });
    expect(await createCvReader(clientWith(blobOf(new Uint8Array(0))).client, data).readCv(ID)).toEqual({
      state: 'failed',
    });
    const big = new Uint8Array(5 * 1024 * 1024 + 1);
    big.set(PDF);
    expect(await createCvReader(clientWith(blobOf(big)).client, data).readCv(ID)).toEqual({ state: 'failed' });
    expect(spy).toHaveBeenCalledWith('[cv-read] download failed:', { code: '404' });
    expect(spy).toHaveBeenCalledWith('[cv-read] download failed:', { code: 'FetchError' });
  });

  it('cuts a long string code to 64 characters in the log', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const long = 'y'.repeat(200);
    const failing = async () => ({ data: null, error: { name: 'StorageApiError', statusCode: long, message: PATH } });
    const data = dataWith(async () => [app()]);
    expect(await createCvReader(clientWith(failing).client, data).readCv(ID)).toEqual({ state: 'failed' });
    expect(spy).toHaveBeenCalledWith('[cv-read] download failed:', { code: 'y'.repeat(64) });
  });

  it('answers none for a file when there is no client', async () => {
    const got = await createCvReader(null, dataWith(async () => [app()])).readCv(ID);
    expect(got).toEqual({ state: 'none', hasLink: false, candidate: NAME, job: JOB });
  });

  it('answers failed when listing the applications throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const data = dataWith(async () => {
      throw new Error('boom');
    });
    expect(await createCvReader(clientWith(blobOf(PDF)).client, data).readCv(ID)).toEqual({ state: 'failed' });
  });

  it('never logs the path, the name or the bytes', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const data = dataWith(async () => [app()]);
    await createCvReader(clientWith(blobOf(PDF)).client, data).readCv(ID);
    const failing = async () => ({
      data: null,
      error: { name: 'StorageApiError', statusCode: '400', message: `${PATH} ${NAME}` },
    });
    await createCvReader(clientWith(failing).client, data).readCv(ID);
    await createCvReader(clientWith(blobOf(new TextEncoder().encode('nope'))).client, data).readCv(ID);
    const logged = JSON.stringify(spy.mock.calls);
    expect(logged).not.toContain('secret-file-name');
    expect(logged).not.toContain(NAME);
    expect(logged).not.toContain('PDF');
  });
});
