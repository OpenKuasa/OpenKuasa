import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The route needs a request scope for the real client; the client, the
// workspace and the contacts read are replaced so it runs offline.
const { createClient, getCurrentOrg, listContactsForExport } = vi.hoisted(() => ({
  createClient: vi.fn(),
  getCurrentOrg: vi.fn(),
  listContactsForExport: vi.fn(),
}));
vi.mock('@/lib/supabase/server', () => ({ createClient }));
vi.mock('@/lib/auth/current-org', () => ({ getCurrentOrg }));
vi.mock('@/lib/auth/viewer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/viewer')>()),
  hasSupabaseEnv: () => true,
}));
vi.mock('@/lib/crm/settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/crm/settings')>()),
  listContactsForExport,
}));

import { GET } from '@/app/api/crm/contacts/export/route';

const CONTACT = {
  first_name: 'Aminah',
  last_name: 'Yusof',
  email: 'aminah@example.com',
  phone: null,
  company: 'Kedai Aminah',
  country: 'MY',
  status: 'lead',
  source: null,
  tags: [],
  created_at: '2026-10-01T02:00:00Z',
};

function fakeClient(rpcResult: { error: { code: string; message: string } | null } = { error: null }) {
  const rpc = vi.fn(async () => rpcResult);
  createClient.mockResolvedValue({ rpc });
  return rpc;
}

beforeEach(() => {
  getCurrentOrg.mockResolvedValue({ orgId: 'org-1', role: 'owner' });
  listContactsForExport.mockResolvedValue({ contacts: [CONTACT], complete: true });
});

afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

describe('GET /api/crm/contacts/export', () => {
  it('records the export, then returns the CSV', async () => {
    const rpc = fakeClient();
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/csv; charset=utf-8');
    expect(await res.text()).toContain('aminah@example.com');
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('log_event', { p_key: 'contacts_exported' });
  });

  it('records it for an admin too', async () => {
    getCurrentOrg.mockResolvedValue({ orgId: 'org-1', role: 'admin' });
    const rpc = fakeClient();
    expect((await GET()).status).toBe(200);
    expect(rpc).toHaveBeenCalledWith('log_event', { p_key: 'contacts_exported' });
  });

  it('returns no file when the export cannot be recorded, and logs the code only', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    fakeClient({ error: { code: 'P0001', message: 'not allowed' } });
    const res = await GET();
    expect(res.status).toBe(503);
    expect(res.headers.get('Content-Type')).not.toContain('text/csv');
    const body = await res.text();
    expect(body).not.toContain('aminah@example.com');
    expect(JSON.parse(body)).toEqual({ error: 'The export is unavailable right now. Please try again.' });
    expect(logged).toHaveBeenCalledWith('[crm/contacts/export] could not record the export:', 'P0001');
  });

  it('returns no file when recording throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    createClient.mockResolvedValue({
      rpc: vi.fn(async () => {
        throw Object.assign(new Error('fetch failed'), { name: 'TypeError' });
      }),
    });
    const res = await GET();
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain('aminah@example.com');
  });

  it('refuses a member with 403 and records nothing', async () => {
    getCurrentOrg.mockResolvedValue({ orgId: 'org-1', role: 'member' });
    const rpc = fakeClient();
    const res = await GET();
    expect(res.status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
    expect(listContactsForExport).not.toHaveBeenCalled();
  });

  it('records nothing when the contacts cannot be read', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    listContactsForExport.mockRejectedValue({ code: '42501', message: 'permission denied' });
    const rpc = fakeClient();
    const res = await GET();
    expect(res.status).toBe(503);
    expect(rpc).not.toHaveBeenCalled();
  });
});
