import { beforeEach, describe, expect, it, vi } from 'vitest';

// Shared, hoisted control surface so the mock factories can read mutable state.
const ctl = vi.hoisted(() => ({
  user: null as { id: string; is_anonymous: boolean } | null,
  /** The caller's workspace, or null when they are in none. */
  org: null as { orgId: string; role: string } | null,
  /** What consume_free_question answers: questions left, or -1 when used up. */
  freeRemaining: 2 as number,
  /** The workspace's stored (sealed) key, or null when none is set. */
  sealedKey: null as string | null,
  providerKey: true,
  /** The key each model was built with: undefined means the platform key. */
  usedKeys: [] as (string | undefined)[],
  freeConsumed: 0,
  /** What consume_ai_quota answers on a workspace key: turns left today, or -1 when used up. */
  dailyRemaining: 100 as number,
  dailyConsumed: 0,
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: ctl.user }, error: null }) },
    rpc: async (name: string) => {
      if (name === 'org_ai_key_status') {
        return { data: ctl.sealedKey ? [{ key_hint: 'sk-or-…aaaa' }] : [], error: null };
      }
      if (name === 'consume_free_question') {
        ctl.freeConsumed += 1;
        return { data: ctl.freeRemaining, error: null };
      }
      if (name === 'consume_ai_quota') {
        ctl.dailyConsumed += 1;
        return { data: ctl.dailyRemaining, error: null };
      }
      return { data: null, error: { message: `unexpected rpc ${name}` } };
    },
  }),
}));

// The sealed key is read on the server, by the service-role client.
vi.mock('@/lib/supabase/service', () => ({
  serviceClient: () => ({
    from: () => {
      const query = {
        select: () => query,
        eq: () => query,
        maybeSingle: async () => ({
          data: ctl.sealedKey ? { ciphertext: ctl.sealedKey } : null,
          error: null,
        }),
      };
      return query;
    },
  }),
}));

// The route also resolves the caller's org for write tools; the fake client has no tables.
// No workspace by default; a test that stores a key gives the caller one.
vi.mock('@/lib/auth/current-org', () => ({ getCurrentOrg: async () => ctl.org }));

vi.mock('@/lib/reach/supabase', () => ({
  getReachData: async () => {
    const { createSeedReachData } = await import('@/lib/reach/seed');
    return createSeedReachData();
  },
}));

vi.mock('@/lib/ai/provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/provider')>();
  const { MockLanguageModelV4, simulateReadableStream } = await import('ai/test');
  return {
    ...actual,
    hasProviderKey: () => ctl.providerKey,
    getModel: (_layer: string, apiKey?: string) => {
      ctl.usedKeys.push(apiKey);
      return new MockLanguageModelV4({
        // Minimal valid V4 text stream; cast because the spec's usage/finish
        // shapes are richer than this fixture needs (runtime ignores the extras).
        doStream: async () => ({
          stream: simulateReadableStream({
            initialDelayInMs: 0,
            chunkDelayInMs: 0,
            chunks: [
              { type: 'text-start', id: '0' },
              { type: 'text-delta', id: '0', delta: 'The Lead Magnet eBook campaign has the best cost per lead.' },
              { type: 'text-end', id: '0' },
              { type: 'finish', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 12, totalTokens: 22 } },
            ],
          }),
        }),
      } as unknown as ConstructorParameters<typeof MockLanguageModelV4>[0]);
    },
  };
});

const SECRET = 'test-secret-for-sealing-workspace-keys-0123456789';
const { encryptApiKey } = await import('@/lib/ai/key-crypto');

const KEY_ORG = '11111111-1111-4111-8111-111111111111';
/** Stores a key sealed for the caller's workspace, as the server does. */
const sealForWorkspace = () => {
  ctl.org = { orgId: KEY_ORG, role: 'owner' };
  return encryptApiKey('sk-or-v1-workspace-key-aaaaaaaaaaaa', KEY_ORG);
};

const { POST } = await import('@/app/api/reach/chat/route');

function post(body: unknown): Request {
  return new Request('http://localhost/api/reach/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const validBody = {
  messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'which campaign has the best cost per lead?' }] }],
};

beforeEach(() => {
  ctl.user = { id: 'u1', is_anonymous: false };
  ctl.org = null;
  ctl.freeRemaining = 2;
  ctl.sealedKey = null;
  ctl.providerKey = true;
  ctl.usedKeys = [];
  ctl.freeConsumed = 0;
  ctl.dailyRemaining = 100;
  ctl.dailyConsumed = 0;
  process.env.AI_KEYS_ENCRYPTION_SECRET = SECRET;
});

describe('POST /api/reach/chat gating', () => {
  it('401 when not signed in', async () => {
    ctl.user = null;
    expect((await POST(post(validBody))).status).toBe(401);
  });

  it('403 for a demo / anonymous viewer', async () => {
    ctl.user = { id: 'u2', is_anonymous: true };
    expect((await POST(post(validBody))).status).toBe(403);
  });

  it('402 key_required when the free questions are used up', async () => {
    ctl.freeRemaining = -1;
    const res = await POST(post(validBody));
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ code: 'key_required' });
    expect(ctl.usedKeys).toEqual([]);
  });

  it('402 key_required when there is no platform key to run free questions on', async () => {
    ctl.providerKey = false;
    const res = await POST(post(validBody));
    expect(res.status).toBe(402);
    expect(ctl.freeConsumed).toBe(0);
  });

  it('does not spend a free question on a malformed request', async () => {
    expect((await POST(post({ messages: [] }))).status).toBe(400);
    expect(ctl.freeConsumed).toBe(0);
  });

  it('fails closed when the workspace key cannot be opened on this server', async () => {
    ctl.sealedKey = sealForWorkspace();
    process.env.AI_KEYS_ENCRYPTION_SECRET = 'a-different-secret-than-the-one-used-to-seal-it';
    const res = await POST(post(validBody));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'key_unavailable' });
    // Never falls back to the platform key or the free allowance.
    expect(ctl.usedKeys).toEqual([]);
    expect(ctl.freeConsumed).toBe(0);
  });

  it('400 on an empty/invalid message list', async () => {
    expect((await POST(post({ messages: [] }))).status).toBe(400);
  });
});

describe('POST /api/reach/chat happy path', () => {
  it('runs a free question on the platform key', async () => {
    const res = await POST(post(validBody));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('Lead Magnet');
    expect(ctl.freeConsumed).toBe(1);
    expect(ctl.usedKeys).toEqual([undefined]);
  });

  it('refuses a workspace-key turn once the caller has used up the day, without calling a model', async () => {
    ctl.sealedKey = sealForWorkspace();
    ctl.dailyRemaining = -1;
    const res = await POST(post(validBody));
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ code: 'daily_limit' });
    expect(ctl.usedKeys).toEqual([]);
  });

  it('a free question is not counted against the workspace-key daily limit', async () => {
    const res = await POST(post(validBody));
    expect(res.status).toBe(200);
    await res.text();
    expect(ctl.freeConsumed).toBe(1);
    expect(ctl.dailyConsumed).toBe(0);
  });

  it('runs on the workspace key without touching the free allowance', async () => {
    ctl.sealedKey = sealForWorkspace();
    // Even with the free questions used up and no platform key at all.
    ctl.freeRemaining = -1;
    ctl.providerKey = false;
    const res = await POST(post(validBody));
    expect(res.status).toBe(200);
    await res.text();
    expect(ctl.freeConsumed).toBe(0);
    expect(ctl.dailyConsumed).toBe(1);
    expect(ctl.usedKeys).toEqual(['sk-or-v1-workspace-key-aaaaaaaaaaaa']);
  });
});

describe('POST /api/chat (Tuah)', () => {
  it('uses the same gate and streams an answer', async () => {
    const { POST: tuah } = await import('@/app/api/chat/route');
    const request = () =>
      new Request('http://localhost/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(validBody),
      });

    const ok = await tuah(request());
    expect(ok.status).toBe(200);
    await ok.text();
    expect(ctl.freeConsumed).toBe(1);

    ctl.freeRemaining = -1;
    const refused = await tuah(request());
    expect(refused.status).toBe(402);
    expect(await refused.json()).toMatchObject({ code: 'key_required' });
  });
});
