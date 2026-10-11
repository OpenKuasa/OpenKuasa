import { describe, expect, it, vi } from 'vitest';
import { CV_BUCKET, cvPath, isPdf, removeCv, signedCvUrl, storeCv } from '@/lib/hire/cv-store';

const ORG = '11111111-1111-4111-8111-111111111111';
const JOB = '22222222-2222-4222-8222-222222222222';
const pdf = (extra = 20) => new Uint8Array([...new TextEncoder().encode('%PDF-1.7\n'), ...new Uint8Array(extra)]);

function fakeService(result: { error: { statusCode?: string } | null } = { error: null }) {
  const upload = vi.fn(async () => ({ data: result.error ? null : {}, ...result }));
  const remove = vi.fn(async (paths: string[]) => ({ data: paths.map((name) => ({ name })) as { name: string }[], error: null }));
  const list = vi.fn(async () => ({ data: [] as { name: string }[], error: null as { statusCode?: string } | null }));
  const createSignedUrl = vi.fn(async () => ({ data: { signedUrl: 'https://x/signed' }, error: null }));
  const from = vi.fn(() => ({ upload, remove, list, createSignedUrl }));
  return { client: { storage: { from } } as never, from, upload, remove, list, createSignedUrl };
}

describe('isPdf', () => {
  it('is true for bytes that start %PDF-', () => expect(isPdf(pdf())).toBe(true));
  it('is false for a text file with a pdf name', () => expect(isPdf(new TextEncoder().encode('hello world'))).toBe(false));
  it('is false for an empty file', () => expect(isPdf(new Uint8Array())).toBe(false));
  it('is false for four of the five bytes', () => expect(isPdf(new TextEncoder().encode('%PDF'))).toBe(false));
});

describe('cvPath', () => {
  it('is the workspace, the job and a random name', () => {
    expect(cvPath(ORG, JOB)).toMatch(new RegExp(`^${ORG}/${JOB}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.pdf$`));
    expect(cvPath(ORG, JOB)).not.toBe(cvPath(ORG, JOB));
  });
  it('writes the ids in lowercase, as the database does', () => {
    expect(cvPath(ORG.toUpperCase().replace(/1/g, 'A'), JOB)).toMatch(/^aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\//);
  });
});

describe('storeCv', () => {
  it('uploads a PDF to the private bucket, never replacing, and answers with the path', async () => {
    const s = fakeService();
    const path = await storeCv(s.client, ORG, JOB, pdf());
    expect(path).toMatch(new RegExp(`^${ORG}/${JOB}/`));
    expect(s.from).toHaveBeenCalledWith(CV_BUCKET);
    expect(s.upload).toHaveBeenCalledWith(path, expect.any(Uint8Array), { contentType: 'application/pdf', upsert: false });
  });
  it('refuses what is not a PDF without uploading', async () => {
    const s = fakeService();
    expect(await storeCv(s.client, ORG, JOB, new TextEncoder().encode('not a pdf'))).toBeNull();
    expect(s.upload).not.toHaveBeenCalled();
  });
  it('refuses a file over 5 MB without uploading', async () => {
    const s = fakeService();
    expect(await storeCv(s.client, ORG, JOB, pdf(5 * 1024 * 1024))).toBeNull();
    expect(s.upload).not.toHaveBeenCalled();
  });
  it('answers null when storage refuses', async () => {
    const s = fakeService({ error: { statusCode: '500' } });
    expect(await storeCv(s.client, ORG, JOB, pdf())).toBeNull();
  });
  it('answers null when storage throws', async () => {
    const s = fakeService();
    s.upload.mockRejectedValueOnce(new Error('network'));
    expect(await storeCv(s.client, ORG, JOB, pdf())).toBeNull();
  });
});

describe('removeCv and signedCvUrl', () => {
  it('removes one path', async () => {
    const s = fakeService();
    expect(await removeCv(s.client, `${ORG}/${JOB}/x.pdf`)).toBe(true);
    expect(s.remove).toHaveBeenCalledWith([`${ORG}/${JOB}/x.pdf`]);
  });
  it('counts a file storage did not name as removed only when it is not there', async () => {
    const s = fakeService();
    s.remove.mockResolvedValue({ data: [], error: null });
    expect(await removeCv(s.client, `${ORG}/${JOB}/x.pdf`)).toBe(true);
    expect(s.list).toHaveBeenCalledWith(`${ORG}/${JOB}`, { limit: 1, search: 'x.pdf' });
    s.list.mockResolvedValue({ data: [{ name: 'x.pdf' }], error: null });
    expect(await removeCv(s.client, `${ORG}/${JOB}/x.pdf`)).toBe(false);
    s.list.mockResolvedValue({ data: [], error: { statusCode: '500' } });
    expect(await removeCv(s.client, `${ORG}/${JOB}/x.pdf`)).toBe(false);
  });
  it('answers false when storage refuses the removal', async () => {
    const s = fakeService();
    s.remove.mockResolvedValue({ data: null, error: { statusCode: '403' } } as never);
    expect(await removeCv(s.client, `${ORG}/${JOB}/x.pdf`)).toBe(false);
  });
  it('signs for five minutes as a download', async () => {
    const s = fakeService();
    expect(await signedCvUrl(s.client, 'p.pdf')).toBe('https://x/signed');
    expect(s.createSignedUrl).toHaveBeenCalledWith('p.pdf', 300, { download: 'cv.pdf' });
  });
  it('answers null when signing fails', async () => {
    const s = fakeService();
    s.createSignedUrl.mockResolvedValueOnce({ data: null, error: { statusCode: '404' } } as never);
    expect(await signedCvUrl(s.client, 'p.pdf')).toBeNull();
  });
});
