import { beforeEach, describe, expect, it, vi } from 'vitest';

const FORM = '11111111-1111-4111-8111-111111111111';

const mocks = vi.hoisted(() => ({
  formViewCounts: vi.fn(),
  serviceClient: vi.fn(),
  recordFormView: vi.fn(),
  getUser: vi.fn(),
}));

vi.mock('@/lib/security/limits', () => ({ formViewCounts: mocks.formViewCounts }));
vi.mock('@/lib/supabase/service', () => ({ serviceClient: mocks.serviceClient }));
vi.mock('@/lib/reach/public-forms', () => ({ recordFormView: mocks.recordFormView }));

const { countFormView } = await import('@/lib/reach/form-views');

const SERVICE = { service: true };
const session = { auth: { getUser: mocks.getUser } } as never;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.formViewCounts.mockResolvedValue(true);
  mocks.serviceClient.mockReturnValue(SERVICE);
  mocks.getUser.mockResolvedValue({ data: { user: null } });
  mocks.recordFormView.mockResolvedValue(undefined);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('countFormView', () => {
  it('counts a first view as the server, naming nobody for a visitor who is not signed in', async () => {
    await countFormView(session, FORM);
    expect(mocks.formViewCounts).toHaveBeenCalledExactlyOnceWith(FORM);
    expect(mocks.recordFormView).toHaveBeenCalledExactlyOnceWith(SERVICE, FORM, { viewerId: null, legacy: session });
  });

  it('names the signed-in visitor, so the database can leave out a member previewing their form', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } } });
    await countFormView(session, FORM);
    expect(mocks.recordFormView).toHaveBeenCalledExactlyOnceWith(SERVICE, FORM, { viewerId: 'user-1', legacy: session });
  });

  it('counts nothing, and asks nothing more, for a repeat view by the same client', async () => {
    mocks.formViewCounts.mockResolvedValue(false);
    await countFormView(session, FORM);
    expect(mocks.recordFormView).not.toHaveBeenCalled();
    expect(mocks.serviceClient).not.toHaveBeenCalled();
    expect(mocks.getUser).not.toHaveBeenCalled();
  });

  it('counts as the visitor, as before, on a host with no service key', async () => {
    mocks.serviceClient.mockImplementation(() => {
      throw new Error('Service role is not configured.');
    });
    await countFormView(session, FORM);
    expect(mocks.recordFormView).toHaveBeenCalledExactlyOnceWith(session, FORM);
  });

  it('never fails the page', async () => {
    mocks.getUser.mockRejectedValue(new Error('network'));
    await expect(countFormView(session, FORM)).resolves.toBeUndefined();
    mocks.formViewCounts.mockRejectedValue(new Error('down'));
    await expect(countFormView(session, FORM)).resolves.toBeUndefined();
    expect(mocks.recordFormView).not.toHaveBeenCalled();
  });
});
