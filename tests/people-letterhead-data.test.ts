import { afterEach, describe, expect, it, vi } from 'vitest';
import { getLetterhead } from '@/lib/people/letterhead-data';
import { fakeSupabase } from './setup/fake-supabase';

const ORG = '11111111-1111-4111-8111-111111111111';
const PATH = `${ORG}/abcdef01-aaaa-4bbb-8ccc-0123456789ab.png`;
const ROW = {
  name: 'Rimba Ventures Sdn Bhd',
  registration_no: '202001012345 (1234567-X)',
  address: '12 Jalan Ampang',
  city: 'Kuala Lumpur',
  state: 'Wilayah Persekutuan',
  postcode: '50450',
  logo_path: PATH,
};

afterEach(() => vi.restoreAllMocks());

describe('getLetterhead', () => {
  it('reads only the org row, with only the letterhead columns, and shapes it', async () => {
    const { client, calls } = fakeSupabase({ 'orgs.select': { data: ROW } });
    expect(await getLetterhead({ client, orgId: ORG, isDemo: false })).toEqual({
      name: ROW.name,
      registration_no: ROW.registration_no,
      address: ROW.address,
      city: ROW.city,
      state: ROW.state,
      postcode: ROW.postcode,
      logo_path: PATH,
      isDemo: false,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].table).toBe('orgs');
    expect(calls[0].filters).toEqual({ id: ORG });
    expect(calls[0].columns).toBe('name, registration_no, address, city, state, postcode, logo_path');
  });

  it('keeps null for what is not set and carries the demo flag it was given', async () => {
    const empty = { name: 'Demo', registration_no: null, address: null, city: null, state: null, postcode: null, logo_path: null };
    const { client } = fakeSupabase({ 'orgs.select': { data: empty } });
    expect(await getLetterhead({ client, orgId: ORG, isDemo: true })).toEqual({ ...empty, isDemo: true });
  });

  it('drops a logo path that is not of the shape for this workspace (a letter never points at another folder)', async () => {
    const other = `99999999-9999-4999-8999-999999999999/abcdef01-aaaa-4bbb-8ccc-0123456789ab.png`;
    const { client } = fakeSupabase({ 'orgs.select': { data: { ...ROW, logo_path: other } } });
    expect((await getLetterhead({ client, orgId: ORG, isDemo: false }))?.logo_path).toBeNull();
  });

  it('is null with no workspace, no row, a failed read, or a row of the wrong shape, and never throws', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const none = fakeSupabase();
    expect(await getLetterhead({ client: none.client, orgId: null, isDemo: false })).toBeNull();
    expect(none.calls).toEqual([]);
    expect(await getLetterhead({ client: fakeSupabase({ 'orgs.select': { data: null } }).client, orgId: ORG, isDemo: false })).toBeNull();
    expect(await getLetterhead({ client: fakeSupabase({ 'orgs.select': { error: { message: 'SECRET' } } }).client, orgId: ORG, isDemo: false })).toBeNull();
    expect(await getLetterhead({ client: fakeSupabase({ 'orgs.select': { data: { name: 5 } } }).client, orgId: ORG, isDemo: false })).toBeNull();
    const boom = { from: () => { throw new Error('SECRET'); } } as never;
    expect(await getLetterhead({ client: boom, orgId: ORG, isDemo: false })).toBeNull();
    expect(JSON.stringify(log.mock.calls)).not.toContain('SECRET');
  });
});
