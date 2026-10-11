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
  /** The system prompt and tool names each model call was given. */
  calls: [] as { system: string; tools: string[] }[],
  freeConsumed: 0,
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

vi.mock('@/lib/auth/current-org', () => ({ getCurrentOrg: async () => ctl.org }));
vi.mock('@/lib/reach/supabase', async () => {
  const { createSeedReachData } = await import('@/lib/reach/seed');
  return { getReachData: async () => createSeedReachData() };
});
vi.mock('@/lib/auth/viewer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/viewer')>()),
  hasSupabaseEnv: () => true,
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
        doStream: async (options: {
          prompt: { role: string; content: unknown }[];
          tools?: { name: string }[];
        }) => {
          ctl.calls.push({
            system: String(options.prompt.find((m) => m.role === 'system')?.content ?? ''),
            tools: (options.tools ?? []).map((tool) => tool.name),
          });
          return {
            stream: simulateReadableStream({
              initialDelayInMs: 0,
              chunkDelayInMs: 0,
              chunks: [
                { type: 'text-start', id: '0' },
                { type: 'text-delta', id: '0', delta: 'Your open pipeline is worth RM 12,000.00.' },
                { type: 'text-end', id: '0' },
                { type: 'finish', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 12, totalTokens: 22 } },
              ],
            }),
          };
        },
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
const { CRM_WRITE_TOOL_NAMES } = await import('@/lib/ai/crm-tools');
const { KASTURI_SHARED_TOOL_NAMES, REACH_WRITE_TOOL_NAMES } = await import('@/lib/ai/products');

const { POST } = await import('@/app/api/crm/chat/route');

function post(body: unknown): Request {
  return new Request('http://localhost/api/crm/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const validBody = {
  messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'how much is my pipeline worth?' }] }],
};

beforeEach(() => {
  ctl.user = { id: 'u1', is_anonymous: false };
  ctl.org = { orgId: 'org1', role: 'owner' };
  ctl.freeRemaining = 2;
  ctl.sealedKey = null;
  ctl.providerKey = true;
  ctl.usedKeys = [];
  ctl.calls = [];
  ctl.freeConsumed = 0;
  process.env.AI_KEYS_ENCRYPTION_SECRET = SECRET;
});

describe('POST /api/crm/chat gating', () => {
  it('401 when not signed in', async () => {
    ctl.user = null;
    expect((await POST(post(validBody))).status).toBe(401);
  });

  it('403 for a demo / anonymous viewer', async () => {
    ctl.user = { id: 'u2', is_anonymous: true };
    expect((await POST(post(validBody))).status).toBe(403);
    expect(ctl.usedKeys).toEqual([]);
  });

  it('402 key_required when the free questions are used up', async () => {
    ctl.freeRemaining = -1;
    const res = await POST(post(validBody));
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ code: 'key_required' });
    expect(ctl.usedKeys).toEqual([]);
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
    expect(ctl.usedKeys).toEqual([]);
    expect(ctl.freeConsumed).toBe(0);
  });

  it('409 no_workspace, without calling a model, for someone in no workspace', async () => {
    ctl.org = null;
    const res = await POST(post(validBody));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'no_workspace' });
    expect(ctl.usedKeys).toEqual([]);
  });
});

describe('POST /api/crm/chat happy path', () => {
  it('answers as Kasturi, with the CRM tools and only the marketing ones for its shared screens', async () => {
    const res = await POST(post(validBody));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('RM 12,000.00');
    expect(ctl.freeConsumed).toBe(1);
    expect(ctl.usedKeys).toEqual([undefined]);

    const [call] = ctl.calls;
    expect(call.system).toMatch(/^You are Kasturi/);
    expect(call.tools).toEqual(
      expect.arrayContaining(['listCrmContacts', 'listDeals', 'listPipelines', 'getDealStats', ...CRM_WRITE_TOOL_NAMES]),
    );
    expect(call.tools).toEqual(
      expect.arrayContaining(['listFollowUps', 'getCalendar', ...KASTURI_SHARED_TOOL_NAMES]),
    );
    expect(call.system).toContain('TODAY');
    // Appointments and lead forms are Kasturi screens too; ads and leads are not.
    expect(call.tools).toHaveLength(4 + 2 + CRM_WRITE_TOOL_NAMES.length + KASTURI_SHARED_TOOL_NAMES.length);
    expect(call.tools).not.toContain('getCampaigns');
    expect(call.tools).not.toContain('createLead');
    expect(call.tools).not.toContain('promoteLeadToContact');
  });

  it('gives a viewer the lookups and none of the changes', async () => {
    ctl.org = { orgId: 'org1', role: 'viewer' };
    const res = await POST(post(validBody));
    expect(res.status).toBe(200);
    await res.text();
    const [call] = ctl.calls;
    expect(call.tools).toContain('listDeals');
    expect(call.tools).toEqual(
      expect.arrayContaining(['listFollowUps', 'getCalendar', 'getUpcomingAppointments', 'listForms']),
    );
    for (const name of [...CRM_WRITE_TOOL_NAMES, ...REACH_WRITE_TOOL_NAMES]) {
      expect(call.tools).not.toContain(name);
    }
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
    expect(ctl.usedKeys).toEqual(['sk-or-v1-workspace-key-aaaaaaaaaaaa']);
  });
});
