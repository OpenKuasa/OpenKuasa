import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/agents/weekly-studio', () => ({ runWeeklyStudio: vi.fn() }));
vi.mock('@/lib/agents/openrouter-media', () => ({ checkVideo: vi.fn() }));
vi.mock('@/lib/ai/key-crypto', () => ({ hasKeySecret: () => true, decryptApiKey: () => 'k' }));

const CRON_SECRET = 'cron-secret-0123456789abcdef0123456789abcdef';
const post = (headers: Record<string, string>) => new Request('http://x/api/agents/run', { method: 'POST', headers });

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// The check itself is covered in tests/trigger-auth.test.ts.
describe('run route', () => {
  async function load() {
    vi.resetModules();
    const runSchedulesMock = vi.fn().mockResolvedValue({ ran: 1, skipped: 0, paused: 0, completed: 0, failed: 0 });
    vi.doMock('@/lib/agents/runner', () => ({ runSchedules: runSchedulesMock, pollVideos: vi.fn() }));
    vi.doMock('@/lib/supabase/service', () => ({ serviceClient: () => ({}) }));
    vi.stubEnv('CRON_SECRET', CRON_SECRET);
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-key-123');
    const { POST } = await import('@/app/api/agents/run/route');
    return { POST, runSchedulesMock };
  }

  it('401s without calling runSchedules on a bad secret; runs on the cron secret', async () => {
    const { POST, runSchedulesMock } = await load();
    const bad = await POST(post({ authorization: 'Bearer nope' }));
    expect(bad.status).toBe(401);
    const none = await POST(post({}));
    expect(none.status).toBe(401);
    expect(runSchedulesMock).not.toHaveBeenCalled();
    const ok = await POST(post({ authorization: `Bearer ${CRON_SECRET}` }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ran: 1, skipped: 0, paused: 0, completed: 0, failed: 0 });
    expect(runSchedulesMock).toHaveBeenCalledTimes(1);
  });

  it('still runs on the legacy service-role key during the transition, and 401s once it is switched off', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { POST, runSchedulesMock } = await load();
    const legacy = await POST(post({ 'x-service-key': 'service-key-123' }));
    expect(legacy.status).toBe(200);
    expect(warn).toHaveBeenCalledTimes(1);
    vi.stubEnv('CRON_ALLOW_LEGACY_KEY', 'false');
    const off = await POST(post({ 'x-service-key': 'service-key-123' }));
    expect(off.status).toBe(401);
    expect(runSchedulesMock).toHaveBeenCalledTimes(1);
  });
});
