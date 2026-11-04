import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

/** A server with no platform OpenRouter key (a self-hosted copy) has no free questions to give. */

vi.mock('@/lib/supabase/service', () => ({ serviceClient: vi.fn() }));
vi.mock('@/lib/auth/current-org', () => ({ getCurrentOrg: vi.fn() }));

import { FREE_QUESTIONS_PER_WEEK, getChatStatus } from '@/lib/ai/gate';

const client = (used: number) =>
  ({
    rpc: vi.fn(async (name: string) =>
      name === 'free_questions_used' ? { data: used, error: null } : { data: [], error: null },
    ),
  }) as unknown as SupabaseClient;

afterEach(() => vi.unstubAllEnvs());

describe('getChatStatus', () => {
  it('reports a limit of 0, not "all used", when the server has no platform key', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', '');
    const status = await getChatStatus(client(0));
    expect(status.freeLimit).toBe(0);
    expect(status.freeRemaining).toBe(0);
    expect(status.hasKey).toBe(false);
  });

  it('keeps the weekly free questions when the server has a platform key', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-test');
    const status = await getChatStatus(client(1));
    expect(status.freeLimit).toBe(FREE_QUESTIONS_PER_WEEK);
    expect(status.freeRemaining).toBe(FREE_QUESTIONS_PER_WEEK - 1);
  });
});
