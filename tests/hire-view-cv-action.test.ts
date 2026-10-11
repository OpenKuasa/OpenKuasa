import { beforeEach, describe, expect, it, vi } from 'vitest';

/** The action a member presses "View CV" through. The viewer, the session client and the signer are replaced. */

const mocks = vi.hoisted(() => ({
  getViewer: vi.fn(),
  createClient: vi.fn(),
  signedCvUrl: vi.fn(),
  maybeSingle: vi.fn(),
  eq: vi.fn(),
  select: vi.fn(),
  from: vi.fn(),
}));

vi.mock('@/lib/auth/viewer', () => ({ getViewer: mocks.getViewer }));
vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.createClient }));
vi.mock('@/lib/hire/cv-store', () => ({ signedCvUrl: mocks.signedCvUrl }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { viewCvAction } from '@/app/(app)/hire/actions';

const APP = '44444444-4444-4444-8444-444444444444';
const ORG = '11111111-1111-4111-8111-111111111111';
const PATH = `${ORG}/22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333.pdf`;
const GONE = { ok: false, error: 'This file is no longer available.' };
const FAILED = { ok: false, error: "Couldn't open the CV. Try again." };

const viewer = (over: Record<string, unknown> = {}) => ({ isDemo: false, orgId: ORG, role: 'viewer', ...over });

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.getViewer.mockResolvedValue(viewer());
  mocks.createClient.mockResolvedValue({ from: mocks.from });
  mocks.from.mockReturnValue({ select: mocks.select });
  mocks.select.mockReturnValue({ eq: mocks.eq });
  mocks.eq.mockReturnValue({ eq: mocks.eq, maybeSingle: mocks.maybeSingle });
  mocks.maybeSingle.mockResolvedValue({ data: { cv_path: PATH }, error: null });
  mocks.signedCvUrl.mockResolvedValue('https://files.example/signed?token=abc');
});

describe('viewCvAction', () => {
  it('has no file for the demo workspace and asks nothing', async () => {
    mocks.getViewer.mockResolvedValue(viewer({ isDemo: true }));
    expect(await viewCvAction(APP)).toEqual(GONE);
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.signedCvUrl).not.toHaveBeenCalled();
  });
  it.each([undefined, null, 5, '', 'not-a-uuid', `${APP}x`])('refuses %s without asking', async (id) => {
    expect(await viewCvAction(id)).toEqual(GONE);
    expect(mocks.from).not.toHaveBeenCalled();
  });
  it('says the file is gone when there is no row', async () => {
    mocks.maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await viewCvAction(APP)).toEqual(GONE);
    expect(mocks.signedCvUrl).not.toHaveBeenCalled();
  });
  it('says the file is gone when the path is null', async () => {
    mocks.maybeSingle.mockResolvedValue({ data: { cv_path: null }, error: null });
    expect(await viewCvAction(APP)).toEqual(GONE);
    expect(mocks.signedCvUrl).not.toHaveBeenCalled();
  });
  it('says it could not open when the read fails', async () => {
    mocks.maybeSingle.mockResolvedValue({ data: null, error: { code: '500' } });
    expect(await viewCvAction(APP)).toEqual(FAILED);
    expect(mocks.signedCvUrl).not.toHaveBeenCalled();
  });
  it('says it could not open when signing fails', async () => {
    mocks.signedCvUrl.mockResolvedValue(null);
    expect(await viewCvAction(APP)).toEqual(FAILED);
  });
  it('answers the link, reading by both the id and the workspace, and never the path', async () => {
    const result = await viewCvAction(APP);
    expect(result).toEqual({ ok: true, url: 'https://files.example/signed?token=abc' });
    expect(mocks.from).toHaveBeenCalledWith('hire_applications');
    expect(mocks.select).toHaveBeenCalledWith('cv_path');
    expect(mocks.eq).toHaveBeenCalledWith('id', APP);
    expect(mocks.eq).toHaveBeenCalledWith('org_id', ORG);
    expect(mocks.signedCvUrl).toHaveBeenCalledWith(expect.anything(), PATH);
    expect(JSON.stringify(result)).not.toContain(PATH);
  });
  it('lets a viewer-role member open it', async () => {
    mocks.getViewer.mockResolvedValue(viewer({ role: 'viewer' }));
    expect((await viewCvAction(APP)).ok).toBe(true);
  });
  it('never logs the path', async () => {
    await viewCvAction(APP);
    mocks.signedCvUrl.mockResolvedValue(null);
    await viewCvAction(APP);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(PATH);
  });
});
