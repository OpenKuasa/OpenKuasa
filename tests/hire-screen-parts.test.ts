import { beforeEach, describe, expect, it, vi } from 'vitest';

const ctl = vi.hoisted(() => ({
  env: false,
  clientCreations: 0,
  liveReads: 0,
  user: null as { id: string; is_anonymous?: boolean } | null,
}));

const PREVIEW_DATA = { marker: 'preview' };
const LIVE_DATA = { marker: 'live' };

vi.mock('@/lib/auth/viewer', () => ({ hasSupabaseEnv: () => ctl.env }));
vi.mock('@/lib/hire/seed', () => ({ createSeedHireData: () => PREVIEW_DATA }));
vi.mock('@/lib/hire/supabase', () => ({
  getHireData: async () => {
    ctl.liveReads += 1;
    return LIVE_DATA;
  },
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => {
    ctl.clientCreations += 1;
    return { auth: { getUser: async () => ({ data: { user: ctl.user } }) } };
  },
}));

import { loadHire, topSlices } from '@/screens/hire/parts';

beforeEach(() => {
  ctl.env = false;
  ctl.clientCreations = 0;
  ctl.liveReads = 0;
  ctl.user = null;
});

describe('loadHire', () => {
  it('builds sample data without constructing a Supabase client in preview mode', async () => {
    const result = await loadHire('test', async (data) => data);

    expect(result).toEqual({ model: PREVIEW_DATA, isDemo: true });
    expect(ctl.clientCreations).toBe(0);
    expect(ctl.liveReads).toBe(0);
  });

  it('keeps the live Supabase path for a configured project', async () => {
    ctl.env = true;
    ctl.user = { id: 'user-1' };

    const result = await loadHire('test', async (data) => data);

    expect(result).toEqual({ model: LIVE_DATA, isDemo: false });
    expect(ctl.clientCreations).toBe(1);
    expect(ctl.liveReads).toBe(1);
  });

  it('returns the preview fallback when a builder fails', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await loadHire('test', async () => {
      throw new Error('boom');
    });

    expect(result).toEqual({ model: null, isDemo: true });
    expect(spy).toHaveBeenCalled();
  });
});

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `S${i}`, v: 10 - i }));
const slices = (n: number) =>
  topSlices(rows(n), (r) => r.v, (r) => r.name);
const total = (n: number) => rows(n).reduce((sum, row) => sum + row.v, 0);

describe('topSlices', () => {
  it.each([0, 1, 4])('keeps all %i rows', (n) => {
    const out = slices(n);
    expect(out).toHaveLength(n);
    expect(out.reduce((sum, row) => sum + row.value, 0)).toBe(total(n));
    expect(out.find((row) => row.key === 'other')).toBeUndefined();
  });

  it.each([5, 7])('folds %i rows into 3 plus Other', (n) => {
    const out = slices(n);
    expect(out).toHaveLength(4);
    expect(out[3]).toEqual({
      key: 'other',
      label: 'Other',
      value: rows(n).slice(3).reduce((sum, row) => sum + row.v, 0),
    });
    expect(out.reduce((sum, row) => sum + row.value, 0)).toBe(total(n));
  });
});
