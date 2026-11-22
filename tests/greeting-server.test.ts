import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getViewer = vi.fn();
const createClient = vi.fn();
const readProductCounts = vi.fn();
const readAllCounts = vi.fn();

vi.mock('@/lib/auth/viewer', () => ({ getViewer: () => getViewer() }));
vi.mock('@/lib/supabase/server', () => ({ createClient: () => createClient() }));
vi.mock('@/lib/greeting/counts', () => ({
  readProductCounts: (...a: unknown[]) => readProductCounts(...a),
  readAllCounts: (...a: unknown[]) => readAllCounts(...a),
  withTimeout: async <T>(p: Promise<T>, _ms: number, fallback: T) => {
    try {
      return await p;
    } catch {
      return fallback;
    }
  },
}));

import { todayInMalaysia } from '@/lib/people/dates';
import { loadServerGreeting } from '@/lib/greeting/server';

const viewer = (over: Record<string, unknown> = {}) => ({
  userId: 'u1',
  orgId: 'o1',
  role: 'owner',
  isDemo: false,
  ...over,
});

type Result = { data: { name: string; holiday_date: string }[] | null; error: unknown };

/** 22 Nov 2026, 12:00 in Kuala Lumpur, a day the built-in calendar does not hold. */
const ORDINARY_DAY = new Date('2026-11-22T04:00:00Z');
/** Christmas Day, which the built-in calendar does hold. */
const FESTIVE_DAY = new Date('2026-12-25T04:00:00Z');

function fakeClient(result: Result | Error) {
  const eq2 = vi.fn(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
  const eq1 = vi.fn(() => ({ eq: eq2 }));
  const select = vi.fn(() => ({ eq: eq1 }));
  const from = vi.fn(() => ({ select }));
  return { client: { from }, from, eq1, eq2 };
}

beforeEach(() => {
  vi.clearAllMocks();
  readProductCounts.mockResolvedValue({});
  readAllCounts.mockResolvedValue({});
  // loadServerGreeting reads the clock itself, so the file pins the day instead of
  // inheriting the one the suite runs on: three "not festive" assertions used to
  // read differently on a festival date (2026-12-25 gave 3 failed | 3 passed).
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(ORDINARY_DAY);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('loadServerGreeting', () => {
  it('demo viewer reads nothing and gets an idle line', async () => {
    getViewer.mockResolvedValue(viewer({ isDemo: true }));
    const g = await loadServerGreeting('crm');
    expect(createClient).not.toHaveBeenCalled();
    expect(readProductCounts).not.toHaveBeenCalled();
    expect(readAllCounts).not.toHaveBeenCalled();
    expect(typeof g.secondHalf).toBe('string');
    expect(g.secondHalf.length).toBeGreaterThan(0);
  });

  it('live viewer on a product reads that product counts', async () => {
    getViewer.mockResolvedValue(viewer());
    const f = fakeClient({ data: [], error: null });
    createClient.mockResolvedValue(f.client);
    const g = await loadServerGreeting('finance');
    expect(readProductCounts).toHaveBeenCalledTimes(1);
    expect(readProductCounts.mock.calls[0][1]).toBe('finance');
    expect(readProductCounts.mock.calls[0][0]).toMatchObject({ orgId: 'o1', userId: 'u1' });
    expect(readAllCounts).not.toHaveBeenCalled();
    expect(g.isFestive).toBe(false);
  });

  it('tuah reads all counts', async () => {
    getViewer.mockResolvedValue(viewer());
    createClient.mockResolvedValue(fakeClient({ data: [], error: null }).client);
    await loadServerGreeting('tuah');
    expect(readAllCounts).toHaveBeenCalledTimes(1);
    expect(readProductCounts).not.toHaveBeenCalled();
  });

  it("a workspace holiday today makes the greeting festive", async () => {
    getViewer.mockResolvedValue(viewer());
    const today = todayInMalaysia(new Date());
    const f = fakeClient({ data: [{ name: 'Founders Day', holiday_date: today }], error: null });
    createClient.mockResolvedValue(f.client);
    const g = await loadServerGreeting('people');
    expect(f.from).toHaveBeenCalledWith('hr_public_holidays');
    expect(f.eq1).toHaveBeenCalledWith('org_id', 'o1');
    expect(f.eq2).toHaveBeenCalledWith('holiday_date', today);
    expect(g.isFestive).toBe(true);
  });

  it('wishes the festival the built-in calendar holds for the day', async () => {
    getViewer.mockResolvedValue(viewer());
    createClient.mockResolvedValue(fakeClient({ data: [], error: null }).client);
    vi.setSystemTime(FESTIVE_DAY);
    const g = await loadServerGreeting('people');
    expect(g.isFestive).toBe(true);
    expect(g.lead).toBe('Merry Christmas');
  });

  it('survives a rejecting counts reader and holidays query', async () => {
    getViewer.mockResolvedValue(viewer());
    readProductCounts.mockRejectedValue(new Error('boom'));
    createClient.mockResolvedValue(fakeClient(new Error('db down')).client);
    const g = await loadServerGreeting('hire');
    expect(g.isFestive).toBe(false);
    expect(g.secondHalf.length).toBeGreaterThan(0);
  });

  it('survives a holidays query returning an error', async () => {
    getViewer.mockResolvedValue(viewer());
    createClient.mockResolvedValue(
      fakeClient({ data: null, error: { message: 'rls' } }).client,
    );
    const g = await loadServerGreeting('reach');
    expect(g.isFestive).toBe(false);
  });
});
