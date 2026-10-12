import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/service', () => ({ serviceClient: vi.fn(() => ({ tag: 'svc' })) }));
vi.mock('@/lib/agents/runner', () => ({
  reapStaleRuns: vi.fn(),
  pollVideos: vi.fn(),
  expireProposals: vi.fn(),
}));

import { POST } from '@/app/api/agents/poll/route';
import { expireProposals, pollVideos, reapStaleRuns } from '@/lib/agents/runner';

const SECRET = 'cron-secret-0123456789abcdef0123456789abcdef';
const KEY = 'test-service-key';
const req = (headers: Record<string, string> = {}) =>
  new Request('http://localhost/api/agents/poll', { method: 'POST', headers });

beforeEach(() => {
  vi.stubEnv('CRON_SECRET', SECRET);
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', KEY);
  for (const step of [reapStaleRuns, pollVideos, expireProposals]) vi.mocked(step).mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('POST /api/agents/poll', () => {
  it('401s with no credentials or a wrong secret, and runs nothing', async () => {
    expect((await POST(req())).status).toBe(401);
    expect((await POST(req({ authorization: 'Bearer nope' }))).status).toBe(401);
    expect((await POST(req({ 'x-service-key': 'nope' }))).status).toBe(401);
    for (const step of [reapStaleRuns, pollVideos, expireProposals]) expect(step).not.toHaveBeenCalled();
  });

  it('runs each step once with the cron secret', async () => {
    const res = await POST(req({ authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    for (const step of [reapStaleRuns, pollVideos, expireProposals]) expect(step).toHaveBeenCalledTimes(1);
  });

  it('still runs on the legacy service-role key during the transition, and 401s once it is switched off', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await POST(req({ 'x-service-key': KEY }))).status).toBe(200);
    expect(warn).toHaveBeenCalledTimes(1);
    vi.stubEnv('CRON_ALLOW_LEGACY_KEY', 'false');
    expect((await POST(req({ 'x-service-key': KEY }))).status).toBe(401);
    expect(pollVideos).toHaveBeenCalledTimes(1);
  });
});
