import { beforeEach, describe, expect, it, vi } from 'vitest';

const getUser = vi.fn();
const maybeSingle = vi.fn();
const fake = {
  auth: { getUser },
  from: vi.fn(() => ({ select: () => ({ eq: () => ({ maybeSingle }) }) })),
};

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(async () => fake) }));
vi.mock('@/lib/auth/current-org', () => ({ getCurrentOrg: vi.fn() }));
vi.mock('@/lib/auth/viewer', () => ({ hasSupabaseEnv: vi.fn(() => true) }));
vi.mock('@/lib/greeting/weather-source', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/greeting/weather-source')>();
  return { ...actual, fetchWeather: vi.fn() };
});
vi.mock('@/lib/security/limits', () => ({ weatherLimited: vi.fn() }));

import { GET } from '@/app/api/weather/route';
import { getCurrentOrg } from '@/lib/auth/current-org';
import { fetchWeather } from '@/lib/greeting/weather-source';
import { weatherLimited } from '@/lib/security/limits';

const EMPTY = { condition: null, place: null, hot: false };
const req = (qs = '?lat=3.1&lon=101.5') => new Request(`http://localhost/api/weather${qs}`);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCurrentOrg).mockResolvedValue({ orgId: 'org-1', role: 'owner' });
  getUser.mockResolvedValue({ data: { user: { id: 'u1', is_anonymous: false } } });
  vi.mocked(weatherLimited).mockResolvedValue({ allowed: true, enforced: true });
  maybeSingle.mockResolvedValue({ data: { city: 'Kuching', state: 'Sarawak' } });
  vi.mocked(fetchWeather).mockResolvedValue({ condition: 'rain', place: 'Kuching', hot: false } as never);
});

describe('GET /api/weather', () => {
  it('401s with no session and does not fetch', async () => {
    vi.mocked(getCurrentOrg).mockResolvedValue(null);
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Please sign in.' });
    expect(fetchWeather).not.toHaveBeenCalled();
  });

  it('gives the demo (anonymous) user no weather', async () => {
    getUser.mockResolvedValue({ data: { user: { id: 'u1', is_anonymous: true } } });
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(EMPTY);
    expect(fetchWeather).not.toHaveBeenCalled();
  });

  it('429s when rate limited', async () => {
    vi.mocked(weatherLimited).mockResolvedValue({ allowed: false, retryAfterSeconds: 60 });
    const res = await GET(req());
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'Too many requests.' });
    expect(weatherLimited).toHaveBeenCalledWith('u1');
    expect(fetchWeather).not.toHaveBeenCalled();
  });

  it('uses lat/lon (1 dp) when given', async () => {
    const res = await GET(req('?lat=3.14159&lon=101.52'));
    expect(fetchWeather).toHaveBeenCalledWith({ lat: 3.1, lon: 101.5 }, expect.anything());
    expect(await res.json()).toEqual({ condition: 'rain', place: 'Kuching', hot: false });
  });

  it('falls back to the workspace city without lat/lon', async () => {
    await GET(req(''));
    expect(fetchWeather).toHaveBeenCalledWith({ city: 'Kuching', state: 'Sarawak' }, expect.anything());
  });

  it('treats empty lat/lon as absent', async () => {
    await GET(req('?lat=&lon='));
    expect(fetchWeather).toHaveBeenCalledWith({ city: 'Kuching', state: 'Sarawak' }, expect.anything());
  });

  it('answers the empty shape with no coordinates and no city', async () => {
    maybeSingle.mockResolvedValue({ data: { city: null, state: null } });
    const res = await GET(req(''));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(EMPTY);
    expect(fetchWeather).not.toHaveBeenCalled();
  });

  it('answers the empty shape when the source has nothing', async () => {
    vi.mocked(fetchWeather).mockResolvedValue(null);
    const res = await GET(req());
    expect(await res.json()).toEqual(EMPTY);
  });

  it('answers 200 empty when the source throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(fetchWeather).mockRejectedValue(new Error('boom'));
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(EMPTY);
  });
});
