import { beforeEach, describe, expect, it, vi } from 'vitest';

const ctl = vi.hoisted(() => ({
  user: null as { id: string; is_anonymous: boolean } | null,
  org: null as { orgId: string; role: string } | null,
  freeRemaining: 2 as number,
  sealedKey: null as string | null,
  providerKey: true,
  usedKeys: [] as (string | undefined)[],
  calls: [] as { system: string; tools: string[] }[],
  freeConsumed: 0,
  dailyRemaining: 100 as number,
  dailyConsumed: 0,
  // Every session client `createClient()` hands out this test, newest last. prepareChat makes one per request.
  sessionClients: [] as object[],
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => {
    const client = {
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
    };
    ctl.sessionClients.push(client);
    return client;
  },
}));

// Spy on how the route builds the finance tools, keeping the real implementation (so the write tool names
// below still appear). The invariant test reads the `access` it received to prove the client is the session one.
vi.mock('@/lib/ai/finance-tools', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/finance-tools')>();
  return { ...actual, createBendaharaTools: vi.fn(actual.createBendaharaTools) };
});

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
        doStream: async (options: { prompt: { role: string; content: unknown }[]; tools?: { name: string }[] }) => {
          ctl.calls.push({
            // The fixed prompt and today's date are two system messages (the first is marked for the provider's cache).
            system: options.prompt.filter((m) => m.role === 'system').map((m) => String(m.content)).join('\n\n'),
            tools: (options.tools ?? []).map((tool) => tool.name),
          });
          return {
            stream: simulateReadableStream({
              initialDelayInMs: 0,
              chunkDelayInMs: 0,
              chunks: [
                { type: 'text-start', id: '0' },
                { type: 'text-delta', id: '0', delta: 'Baki belum terima: RM 3,200.00.' },
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

const { FINANCE_WRITE_TOOL_NAMES, createBendaharaTools } = await import('@/lib/ai/finance-tools');
const { POST } = await import('@/app/api/finance/chat/route');

function post(body: unknown): Request {
  return new Request('http://localhost/api/finance/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const validBody = {
  messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'berapa baki belum terima?' }] }],
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
  ctl.dailyRemaining = 100;
  ctl.dailyConsumed = 0;
  ctl.sessionClients = [];
  vi.mocked(createBendaharaTools).mockClear();
  process.env.AI_KEYS_ENCRYPTION_SECRET = 'test-secret-for-sealing-workspace-keys-0123456789';
});

describe('POST /api/finance/chat gating', () => {
  it('401 when not signed in', async () => {
    ctl.user = null;
    expect((await POST(post(validBody))).status).toBe(401);
  });

  it('409 no_workspace, without calling a model, for someone in no workspace', async () => {
    ctl.org = null;
    const res = await POST(post(validBody));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'no_workspace' });
    expect(ctl.usedKeys).toEqual([]);
  });
});

describe('POST /api/finance/chat happy path', () => {
  it('answers as Bendahara, with the finance lookups and the full write lifecycle for an owner', async () => {
    const res = await POST(post(validBody));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('RM 3,200.00');
    const [call] = ctl.calls;
    expect(call.system).toMatch(/^You are Bendahara/);
    expect(call.tools).toEqual(
      expect.arrayContaining(['getFinanceOverview', 'listInvoices', 'listBills', 'listFinanceContacts', ...FINANCE_WRITE_TOOL_NAMES]),
    );
    expect(call.system).toContain('TODAY');
  });

  it('gives a viewer the lookups and none of the changes', async () => {
    ctl.org = { orgId: 'org1', role: 'viewer' };
    const res = await POST(post(validBody));
    expect(res.status).toBe(200);
    await res.text();
    const [call] = ctl.calls;
    expect(call.tools).toContain('listInvoices');
    for (const name of FINANCE_WRITE_TOOL_NAMES) expect(call.tools, name).not.toContain(name);
  });
});

/**
 * The finance tools must be built from the caller's own session client (RLS applies, the viewer's role is
 * honoured), never the service-role client. This is what keeps the DB sign-off gates (FIN14/FIN18) meaningful:
 * a service-role client would bypass them. Pinned here so a refactor that passed `serviceClient()` to the
 * finance tools fails loudly.
 */
describe('POST /api/finance/chat session-client invariant', () => {
  it('builds the finance tools from the request session client, never the service-role client', async () => {
    const res = await POST(post(validBody));
    expect(res.status).toBe(200);
    await res.text();
    // prepareChat creates exactly one session client per request; that same object must reach the finance tools.
    expect(ctl.sessionClients).toHaveLength(1);
    expect(vi.mocked(createBendaharaTools)).toHaveBeenCalledTimes(1);
    const access = vi.mocked(createBendaharaTools).mock.calls.at(-1)?.[0];
    // Object identity with the session client the route created. The service-role client (mocked separately,
    // with `from` and no `auth`) is a different object, so passing it here would fail this assertion.
    expect(access?.client).toBe(ctl.sessionClients[0]);
    expect(access?.client).toHaveProperty('auth');
  });
});
