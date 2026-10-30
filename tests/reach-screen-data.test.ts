import { beforeEach, describe, expect, it, vi } from 'vitest';

const ctl = vi.hoisted(() => ({
  env: false,
  clientCreations: 0,
  liveReads: 0,
}));

const PREVIEW_DATA = { marker: 'preview' };
const LIVE_DATA = { marker: 'live' };
const CLIENT = { marker: 'client' };

vi.mock('@/lib/auth/viewer', () => ({ hasSupabaseEnv: () => ctl.env }));
vi.mock('@/lib/reach/seed', () => ({ createSeedReachData: () => PREVIEW_DATA }));
vi.mock('@/lib/reach/supabase', () => ({
  getReachData: async (client: unknown) => {
    ctl.liveReads += 1;
    expect(client).toBe(CLIENT);
    return LIVE_DATA;
  },
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => {
    ctl.clientCreations += 1;
    return CLIENT;
  },
}));

import { loadReachData } from '@/screens/reach/parts';

beforeEach(() => {
  ctl.env = false;
  ctl.clientCreations = 0;
  ctl.liveReads = 0;
});

describe('loadReachData', () => {
  it('returns sample data without constructing a Supabase client in preview mode', async () => {
    expect(await loadReachData()).toBe(PREVIEW_DATA);
    expect(ctl.clientCreations).toBe(0);
    expect(ctl.liveReads).toBe(0);
  });

  it('uses the Supabase provider for a configured project', async () => {
    ctl.env = true;

    expect(await loadReachData()).toBe(LIVE_DATA);
    expect(ctl.clientCreations).toBe(1);
    expect(ctl.liveReads).toBe(1);
  });
});
