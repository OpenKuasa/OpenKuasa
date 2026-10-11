// tests/hire-chat-route.test.ts
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
  /** Tables the provider read, to prove which data the tools were given. */
  tablesRead: [] as string[],
  /** The HireAccess the route handed to the runner. */
  captured: null as null | {
    data: import('@/lib/hire/types').HireData;
    origin?: string | null;
    files?: import('@/lib/hire/cv-read').CvReader;
    cvShelf?: unknown[];
  },
  /** What the Tuah route handed its runner: whether it ran with the team, and the HireAccess. */
  tuah: null as null | { team: boolean; hire: { files?: import('@/lib/hire/cv-read').CvReader; cvShelf?: unknown[] } | null },
  /** When set, the model call throws this instead of answering. */
  fails: null as unknown,
}));

vi.mock('@/lib/ai/agents/orchestrator', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/agents/orchestrator')>();
  return {
    ...actual,
    runLekir: ((messages, hire, ...rest) => {
      ctl.captured = hire;
      return actual.runLekir(messages, hire, ...rest);
    }) as typeof actual.runLekir,
    runTuah: ((...args) => {
      ctl.tuah = { team: Boolean(args[6]), hire: args[7] ?? null };
      return actual.runTuah(...args);
    }) as typeof actual.runTuah,
  };
});

// The Tuah route also reads marketing data; the fake client has no such tables.
vi.mock('@/lib/reach/supabase', () => ({
  getReachData: async () => {
    const { createSeedReachData } = await import('@/lib/reach/seed');
    return createSeedReachData();
  },
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: ctl.user }, error: null }) },
    rpc: async (name: string) => {
      if (name === 'org_ai_key_ciphertext') return { data: ctl.sealedKey, error: null };
      if (name === 'consume_free_question') {
        ctl.freeConsumed += 1;
        return { data: ctl.freeRemaining, error: null };
      }
      return { data: null, error: { message: `unexpected rpc ${name}` } };
    },
    from: (table: string) => {
      ctl.tablesRead.push(table);
      return { select: () => ({ eq: () => ({ order: () => ({ limit: async () => ({ data: [], error: null }) }) }) }) };
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
        doStream: async (options: {
          prompt: { role: string; content: unknown }[];
          tools?: { name: string }[];
        }) => {
          ctl.calls.push({
            system: String(options.prompt.find((m) => m.role === 'system')?.content ?? ''),
            tools: (options.tools ?? []).map((tool) => tool.name),
          });
          if (ctl.fails) throw ctl.fails;
          return {
            stream: simulateReadableStream({
              initialDelayInMs: 0,
              chunkDelayInMs: 0,
              chunks: [
                { type: 'text-start', id: '0' },
                { type: 'text-delta', id: '0', delta: 'Ada 6 job yang open sekarang.' },
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
const { HIRE_TOOL_NAMES } = await import('@/lib/ai/hire-tools');
const { HIRE_WRITE_TOOL_NAMES } = await import('@/lib/ai/products');
const { POST } = await import('@/app/api/hire/chat/route');

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/hire/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

const validBody = {
  messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'berapa job yang open?' }] }],
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
  ctl.tablesRead = [];
  ctl.captured = null;
  ctl.tuah = null;
  ctl.fails = null;
  process.env.AI_KEYS_ENCRYPTION_SECRET = SECRET;
});

/**
 * A provider failure as the SDK reports it: the request it failed on rides
 * along, and after a CV read that request holds the file as a data URL.
 */
const providerFailure = () =>
  Object.assign(new Error('The provider could not process the CV of Aisyah Rahman at org/job/secret-file-name.pdf.'), {
    name: 'AI_APICallError',
    statusCode: 500,
    requestBodyValues: {
      messages: [{ content: [{ file: { file_data: 'data:application/pdf;base64,JVBERi0=' } }] }],
    },
  });

/** Everything of the logged values a log drain could serialise: an error's message and stack too. */
function serialise(value: unknown): string {
  const met = new WeakSet<object>();
  return JSON.stringify(value, (_key, inner: unknown) => {
    if (!inner || typeof inner !== 'object') return inner;
    if (met.has(inner)) return '[seen]';
    met.add(inner);
    if (inner instanceof Error) return { ...inner, name: inner.name, message: inner.message, stack: inner.stack };
    return inner;
  });
}

/** Runs a request whose model call fails, and gives back what was sent and what was logged. */
async function failing(run: () => Promise<Response>): Promise<{ status: number; body: string; logged: string }> {
  ctl.fails = providerFailure();
  const spies = (['error', 'warn', 'info', 'log', 'debug'] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation(() => {}),
  );
  try {
    const res = await run();
    const body = await res.text();
    return { status: res.status, body, logged: serialise(spies.flatMap((spy) => spy.mock.calls)) };
  } finally {
    spies.forEach((spy) => spy.mockRestore());
    ctl.fails = null;
  }
}

function expectOnlyACode(logged: string) {
  expect(logged).toContain('"code":500');
  expect(logged).not.toContain('JVBERi0');
  expect(logged).not.toContain('requestBodyValues');
  expect(logged).not.toContain('Aisyah');
  expect(logged).not.toContain('secret-file-name');
}

describe('POST /api/hire/chat gating', () => {
  it('401 when not signed in', async () => {
    ctl.user = null;
    expect((await POST(post(validBody))).status).toBe(401);
  });

  it('403 for a demo / anonymous viewer, without calling a model', async () => {
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
    ctl.sealedKey = encryptApiKey('sk-or-v1-workspace-key-aaaaaaaaaaaa');
    process.env.AI_KEYS_ENCRYPTION_SECRET = 'a-different-secret-than-the-one-used-to-seal-it';
    const res = await POST(post(validBody));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'key_unavailable' });
    expect(ctl.usedKeys).toEqual([]);
  });
});

describe('POST /api/hire/chat happy path', () => {
  it('answers as Lekir, with the hiring lookups and job changes and nothing else', async () => {
    const res = await POST(post(validBody));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('6 job');
    expect(ctl.freeConsumed).toBe(1);

    const [call] = ctl.calls;
    expect(call.system).toMatch(/^You are Lekir/);
    expect(call.tools.sort()).toEqual([...HIRE_TOOL_NAMES, ...HIRE_WRITE_TOOL_NAMES].sort());
    expect(call.tools).not.toContain('getCampaigns');
    expect(call.tools).not.toContain('listDeals');

    // A user in a workspace reads the hire_ tables.
    await ctl.captured!.data.listJobs();
    expect(ctl.tablesRead).toContain('hire_jobs');
  });

  it('hands Lekir the site origin from the request headers', async () => {
    const res = await POST(post(validBody, { 'x-forwarded-host': 'openkuasa.com' }));
    expect(res.status).toBe(200);
    await res.text();
    expect(ctl.captured!.origin).toBe('https://openkuasa.com');
  });

  it('gives a viewer the lookups and no change tools', async () => {
    ctl.org = { orgId: 'org1', role: 'viewer' };
    const res = await POST(post(validBody));
    expect(res.status).toBe(200);
    await res.text();
    expect(ctl.calls[0].tools.sort()).toEqual([...HIRE_TOOL_NAMES].sort());
    for (const name of HIRE_WRITE_TOOL_NAMES) expect(ctl.calls[0].tools).not.toContain(name);
  });

  it('answers someone in no workspace from empty data, never the sample data', async () => {
    ctl.org = null;
    const res = await POST(post(validBody));
    expect(res.status).toBe(200);
    await res.text();
    // What the route gave the runner is empty, not the sample data.
    const data = ctl.captured!.data;
    expect(await data.listJobs()).toEqual([]);
    expect(await data.listCandidates()).toEqual([]);
    expect(await data.listApplications()).toEqual([]);
    expect(await data.listInterviews()).toEqual([]);
    expect(ctl.tablesRead.filter((t) => t.startsWith('hire_'))).toEqual([]);
    // Someone in no workspace may look things up but can change nothing.
    const tools = ctl.calls[0].tools;
    for (const name of HIRE_TOOL_NAMES) expect(tools).toContain(name);
    for (const name of HIRE_WRITE_TOOL_NAMES) expect(tools).not.toContain(name);
  });

  it('hands Lekir a way to read a CV, through the member’s own data, for a viewer too', async () => {
    ctl.org = { orgId: 'org1', role: 'viewer' };
    const res = await POST(post(validBody));
    expect(res.status).toBe(200);
    await res.text();
    expect(ctl.calls[0].tools).toContain('readCandidateCv');
    const files = ctl.captured!.files!;
    expect(typeof files.readCv).toBe('function');
    // It looks the application up through the same workspace-scoped data the lookups use.
    ctl.tablesRead = [];
    expect(await files.readCv('11111111-1111-4111-8111-111111111111')).toEqual({ state: 'missing' });
    // With it goes an empty shelf for the files it reads: this request's own, not one shared with the next.
    const shelf = ctl.captured!.cvShelf;
    expect(shelf).toEqual([]);
    await (await POST(post(validBody))).text();
    expect(ctl.captured!.cvShelf).toEqual([]);
    expect(ctl.captured!.cvShelf).not.toBe(shelf);
    expect(ctl.tablesRead).toContain('hire_applications');
  });

  it('runs on the workspace key without touching the free allowance', async () => {
    ctl.sealedKey = encryptApiKey('sk-or-v1-workspace-key-aaaaaaaaaaaa');
    ctl.freeRemaining = -1;
    ctl.providerKey = false;
    const res = await POST(post(validBody));
    expect(res.status).toBe(200);
    await res.text();
    expect(ctl.freeConsumed).toBe(0);
    expect(ctl.usedKeys).toEqual(['sk-or-v1-workspace-key-aaaaaaaaaaaa']);
  });
});

describe('POST /api/hire/chat when the model call fails', () => {
  it('tells the user Lekir ran into a problem, and logs only a code', async () => {
    const { status, body, logged } = await failing(() => POST(post(validBody)));
    expect(status).toBe(200);
    expect(body).toContain('Lekir ran into a problem. Please try again in a moment.');
    expect(body).not.toContain('Aisyah');
    expect(logged).toContain('[ask-lekir] stream error:');
    expect(logged).toContain('[ai] lekir model call failed:');
    expectOnlyACode(logged);
  });
});

describe('POST /api/chat (Tuah) and reading a CV', () => {
  const tuahPost = (body: unknown) =>
    new Request('http://localhost/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('gives Lekir a way to read a CV when Tuah answers with its team', async () => {
    const { POST: tuah } = await import('@/app/api/chat/route');
    const res = await tuah(tuahPost(validBody));
    expect(res.status).toBe(200);
    await res.text();
    expect(ctl.tuah!.team).toBe(true);
    expect(typeof ctl.tuah!.hire!.files?.readCv).toBe('function');
    // ...and an empty shelf of this request's own for what it reads.
    const shelf = ctl.tuah!.hire!.cvShelf;
    expect(shelf).toEqual([]);
    await (await tuah(tuahPost(validBody))).text();
    expect(ctl.tuah!.hire!.cvShelf).toEqual([]);
    expect(ctl.tuah!.hire!.cvShelf).not.toBe(shelf);
    // Tuah itself never holds the tool: only the specialist it asks does.
    expect(ctl.calls[0].tools).toContain('askLekir');
    expect(ctl.calls[0].tools).not.toContain('readCandidateCv');
  });

  it('tells the user Tuah ran into a problem when the model call fails, and logs only a code', async () => {
    const { POST: tuah } = await import('@/app/api/chat/route');
    const { status, body, logged } = await failing(() => tuah(tuahPost({ ...validBody, team: false })));
    expect(status).toBe(200);
    expect(body).toContain('Tuah ran into a problem. Please try again in a moment.');
    expect(body).not.toContain('Aisyah');
    expect(logged).toContain('[tuah] stream error:');
    expectOnlyACode(logged);
  });

  it('gives the single agent no way to read a CV', async () => {
    const { POST: tuah } = await import('@/app/api/chat/route');
    const res = await tuah(tuahPost({ ...validBody, team: false }));
    expect(res.status).toBe(200);
    await res.text();
    expect(ctl.tuah!.team).toBe(false);
    expect(ctl.tuah!.hire).not.toBeNull();
    expect(ctl.tuah!.hire!.files).toBeUndefined();
    expect(ctl.tuah!.hire!.cvShelf).toBeUndefined();
    expect(ctl.calls[0].tools).toContain('listApplications');
    expect(ctl.calls[0].tools).not.toContain('readCandidateCv');
  });
});
