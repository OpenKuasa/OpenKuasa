import { beforeEach, describe, expect, test, vi } from 'vitest';

const KEY = 'okk_' + 'A'.repeat(40);

const mocks = vi.hoisted(() => ({
  resolveCaller: vi.fn(),
  buildTuahAccess: vi.fn(),
  buildOperations: vi.fn(),
  listOperations: vi.fn(),
  runRead: vi.fn(),
  runChange: vi.fn(),
  logMcpChange: vi.fn(),
}));

vi.mock('@/lib/mcp/caller', () => ({ resolveCaller: mocks.resolveCaller }));
vi.mock('@/lib/ai/tuah-access', () => ({ buildTuahAccess: mocks.buildTuahAccess }));
vi.mock('@/lib/mcp/operations', () => ({ buildOperations: mocks.buildOperations, listOperations: mocks.listOperations }));
vi.mock('@/lib/mcp/dispatch', () => ({ runRead: mocks.runRead, runChange: mocks.runChange }));
vi.mock('@/lib/mcp/activity', () => ({ logMcpChange: mocks.logMcpChange }));

const { DELETE, GET, POST } = await import('@/app/api/mcp/route');
const wellKnown = await import('@/app/.well-known/oauth-protected-resource/route');

const SUPABASE = { from: () => ({}) };
let credential = 0;

/** A fresh credential per test, so the process-wide limits and names never carry over. */
function signIn(extra: Record<string, unknown> = {}) {
  credential += 1;
  const caller = {
    supabase: SUPABASE,
    userId: 'user-1',
    orgId: 'org-1',
    orgName: 'Rimba',
    role: 'owner',
    credentialId: `key:${credential}`,
    clientName: 'ignored',
    ...extra,
  };
  mocks.resolveCaller.mockResolvedValue({ ok: true, caller });
  return caller;
}

let nextId = 1;
function rpc(method: string, params?: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://openkuasa.com/api/mcp', {
    method: 'POST',
    headers: {
      host: 'openkuasa.com',
      authorization: `Bearer ${KEY}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, ...(params === undefined ? {} : { params }) }),
  });
}

const call = (name: string, args: unknown, headers?: Record<string, string>) =>
  rpc('tools/call', { name, arguments: args }, headers);

async function resultOf(response: Response) {
  expect(response.status).toBe(200);
  const body = (await response.json()) as { result?: Record<string, unknown>; error?: unknown };
  expect(body.error).toBeUndefined();
  return body.result as {
    tools?: Array<{ name: string; annotations?: Record<string, unknown> }>;
    content?: Array<Record<string, unknown>>;
    isError?: boolean;
  };
}

const textOf = (result: { content?: Array<Record<string, unknown>> }) =>
  (result.content ?? []).filter((c) => c.type === 'text').map((c) => c.text as string).join('\n');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.buildTuahAccess.mockResolvedValue({ reach: {}, crm: null, hire: {}, people: null, finance: null });
  mocks.buildOperations.mockImplementation(() => ({ byName: new Map(), gates: undefined, products: [], cvShelf: undefined }));
  mocks.listOperations.mockReturnValue([{ name: 'listCrmDeals', product: 'crm', kind: 'read', description: 'Deals', inputSchema: {} }]);
  mocks.logMcpChange.mockResolvedValue(true);
});

describe('/api/mcp', () => {
  test('tools/list returns exactly the three tools with their annotations', async () => {
    signIn();
    const result = await resultOf(await POST(rpc('tools/list')));
    const tools = result.tools ?? [];
    expect(tools.map((t) => t.name).sort()).toEqual(['openkuasa_change', 'openkuasa_read', 'openkuasa_tools']);
    const by = new Map(tools.map((t) => [t.name, t.annotations ?? {}]));
    expect(by.get('openkuasa_tools')?.readOnlyHint).toBe(true);
    expect(by.get('openkuasa_read')?.readOnlyHint).toBe(true);
    expect(by.get('openkuasa_change')?.destructiveHint).toBe(true);
    expect(by.get('openkuasa_change')?.readOnlyHint).not.toBe(true);
    // Listing the tools touches no data.
    expect(mocks.buildTuahAccess).not.toHaveBeenCalled();
  });

  test('openkuasa_change needsConfirm comes back as text with the token', async () => {
    signIn();
    mocks.runChange.mockResolvedValue({ ok: false, needsConfirm: true, note: 'This deletes Aina from the talent pool', confirm: 'tok-123' });
    const result = await resultOf(await POST(call('openkuasa_change', { operation: 'removeFromPool', arguments: { id: 'x' } })));
    expect(result.isError).not.toBe(true);
    expect(textOf(result)).toBe(
      'This change needs your OK first: This deletes Aina from the talent pool. To go ahead, call openkuasa_change again ' +
        'with the same operation and arguments and confirm: "tok-123".',
    );
  });

  test('a confirmed change passes the token and an activity log bound to the client name', async () => {
    const caller = signIn();
    // The name the client gave at initialize is remembered for its credential.
    await POST(
      rpc('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'claude-code\u0007', version: '2.0.0' },
      }),
    );
    mocks.runChange.mockImplementation(async (_ops, _store, _caller, _name, _args, _confirm, deps) => {
      await deps.log({ operation: 'createCrmDeal', target: 'Big order' });
      return { ok: true, result: { ok: true }, summary: { heading: 'Add a deal', rows: [] } };
    });
    const result = await resultOf(
      await POST(call('openkuasa_change', { operation: 'createCrmDeal', arguments: { title: 'Big order' }, confirm: 'tok-1' })),
    );
    expect(result.isError).not.toBe(true);
    const [, , ref, name, args, confirm] = mocks.runChange.mock.calls[0];
    expect(ref.credentialId).toBe(caller.credentialId);
    expect(name).toBe('createCrmDeal');
    expect(args).toEqual({ title: 'Big order' });
    expect(confirm).toBe('tok-1');
    expect(mocks.logMcpChange).toHaveBeenCalledWith(SUPABASE, { operation: 'createCrmDeal', target: 'Big order', client: 'claude-code' });
  });

  test('without an initialize the client is named by its User-Agent', async () => {
    signIn();
    mocks.runChange.mockImplementation(async (_o, _s, _c, _n, _a, _t, deps) => {
      await deps.log({ operation: 'createCrmDeal', target: 'x' });
      return { ok: true, result: { ok: true } };
    });
    await POST(call('openkuasa_change', { operation: 'createCrmDeal', arguments: {} }, { 'user-agent': 'Cursor/1.7.0 (darwin)' }));
    expect(mocks.logMcpChange.mock.calls[0][1].client).toBe('Cursor');
  });

  test('Operations are built fresh for every call, with the caller\'s own access', async () => {
    const caller = signIn();
    mocks.runRead.mockResolvedValue({ ok: true, result: { deals: [] } });
    await POST(call('openkuasa_read', { operation: 'listCrmDeals', arguments: {} }));
    await POST(call('openkuasa_read', { operation: 'listCrmDeals', arguments: {} }));
    expect(mocks.buildOperations).toHaveBeenCalledTimes(2);
    expect(mocks.runRead.mock.calls[0][0]).not.toBe(mocks.runRead.mock.calls[1][0]);
    expect(mocks.buildTuahAccess).toHaveBeenCalledWith({
      supabase: SUPABASE,
      org: { orgId: caller.orgId, role: caller.role },
      userId: caller.userId,
      origin: 'https://openkuasa.com',
      withCvReader: true,
      receipt: null,
    });
  });

  test('a read result comes back as JSON text; a refusal as a tool error', async () => {
    signIn();
    mocks.runRead.mockResolvedValueOnce({ ok: true, result: { deals: [{ title: 'Big order' }] } });
    const ok = await resultOf(await POST(call('openkuasa_read', { operation: 'listCrmDeals', arguments: {} })));
    expect(JSON.parse(textOf(ok))).toEqual({ deals: [{ title: 'Big order' }] });
    mocks.runRead.mockResolvedValueOnce({ ok: false, error: 'There is no read operation by that name.' });
    const refused = await resultOf(await POST(call('openkuasa_read', { operation: 'nope', arguments: {} })));
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toBe('There is no read operation by that name.');
  });

  test('a CV read comes back as an embedded PDF resource', async () => {
    signIn();
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
    mocks.runRead.mockResolvedValue({
      ok: true,
      result: { ok: true, read: true },
      cv: { name: 'CV - Aina - Designer.pdf', mediaType: 'application/pdf', data: bytes },
    });
    const result = await resultOf(await POST(call('openkuasa_read', { operation: 'readCandidateCv', arguments: { applicationId: 'a' } })));
    const resource = (result.content ?? []).find((c) => c.type === 'resource')?.resource as Record<string, unknown> | undefined;
    expect(resource).toBeDefined();
    expect(resource?.mimeType).toBe('application/pdf');
    expect(resource?.blob).toBe(Buffer.from(bytes).toString('base64'));
    expect(typeof resource?.uri).toBe('string');
  });

  test('openkuasa_tools lists the operations, narrowed to a product', async () => {
    signIn();
    const result = await resultOf(await POST(call('openkuasa_tools', { product: 'crm' })));
    expect(mocks.listOperations.mock.calls[0][1]).toBe('crm');
    expect(JSON.parse(textOf(result))).toEqual([
      { name: 'listCrmDeals', product: 'crm', kind: 'read', description: 'Deals', inputSchema: {} },
    ]);
  });

  test('a thrown failure gives a plain tool error that names nothing', async () => {
    signIn();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.buildTuahAccess.mockRejectedValue(new Error('relation crm_deals token=eyJsecret'));
    const result = await resultOf(await POST(call('openkuasa_read', { operation: 'listCrmDeals', arguments: {} })));
    expect(result.isError).toBe(true);
    expect(textOf(result)).not.toMatch(/crm_deals|eyJ/);
    expect(errors.mock.calls.flat().join(' ')).not.toMatch(/crm_deals|eyJ/);
    errors.mockRestore();
  });

  test('rate limit refuses the 61st call in a minute', async () => {
    signIn();
    mocks.runRead.mockResolvedValue({ ok: true, result: {} });
    for (let i = 0; i < 60; i += 1) {
      const r = await resultOf(await POST(call('openkuasa_read', { operation: 'listCrmDeals', arguments: {} })));
      expect(r.isError).not.toBe(true);
    }
    const refused = await resultOf(await POST(call('openkuasa_read', { operation: 'listCrmDeals', arguments: {} })));
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toBe('Too many calls just now. Wait a minute and try again.');
    // Refused before any data was touched.
    expect(mocks.buildTuahAccess).toHaveBeenCalledTimes(60);
  });

  test('rate limit refuses the 11th change in a minute', async () => {
    signIn();
    mocks.runChange.mockResolvedValue({ ok: true, result: { ok: true } });
    for (let i = 0; i < 10; i += 1) {
      await POST(call('openkuasa_change', { operation: 'createCrmDeal', arguments: {} }));
    }
    const refused = await resultOf(await POST(call('openkuasa_change', { operation: 'createCrmDeal', arguments: {} })));
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toBe('Too many calls just now. Wait a minute and try again.');
    expect(mocks.runChange).toHaveBeenCalledTimes(10);
    // Reads still have room.
    mocks.runRead.mockResolvedValue({ ok: true, result: {} });
    const read = await resultOf(await POST(call('openkuasa_read', { operation: 'listCrmDeals', arguments: {} })));
    expect(read.isError).not.toBe(true);
  });

  test('unauthenticated gives 401 with resource_metadata', async () => {
    mocks.resolveCaller.mockResolvedValue({ ok: false, status: 401, message: 'Sign in to OpenKuasa or use an API key.' });
    const response = await POST(rpc('tools/list', undefined, { authorization: '' }));
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe(
      'Bearer resource_metadata="https://openkuasa.com/.well-known/oauth-protected-resource"',
    );
    const body = (await response.json()) as { error?: { message?: string } };
    expect(body.error?.message).toBe('Sign in to OpenKuasa or use an API key.');
  });

  test('403 and 503 pass through with their message and no token', async () => {
    for (const status of [403, 503] as const) {
      mocks.resolveCaller.mockResolvedValue({ ok: false, status, message: 'Switch back to Rimba in OpenKuasa.' });
      const response = await POST(rpc('tools/list'));
      expect(response.status).toBe(status);
      expect(response.headers.get('www-authenticate')).toBeNull();
      const text = await response.text();
      expect(JSON.parse(text).error.message).toBe('Switch back to Rimba in OpenKuasa.');
      expect(text).not.toContain(KEY);
    }
  });

  test('an unauthenticated request never has its body read', async () => {
    mocks.resolveCaller.mockResolvedValue({ ok: false, status: 401, message: 'Sign in to OpenKuasa or use an API key.' });
    const request = rpc('tools/list');
    await POST(request);
    expect(request.bodyUsed).toBe(false);
  });

  test('a body over the limit is refused before it is parsed', async () => {
    signIn();
    const response = await POST(
      new Request('https://openkuasa.com/api/mcp', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${KEY}`,
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          'content-length': String(5 * 1024 * 1024),
        },
        body: '{}',
      }),
    );
    expect(response.status).toBe(413);
  });

  test('GET is not offered: a stateless server has nothing to stream', async () => {
    const response = GET();
    expect(response.status).toBe(405);
  });

  test('DELETE goes through the caller check', async () => {
    mocks.resolveCaller.mockResolvedValue({ ok: false, status: 401, message: 'Sign in to OpenKuasa or use an API key.' });
    const response = await DELETE(new Request('https://openkuasa.com/api/mcp', { method: 'DELETE' }));
    expect(response.status).toBe(401);
  });

  test('initialize carries the server instructions', async () => {
    signIn();
    const result = (await resultOf(
      await POST(rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } })),
    )) as { instructions?: string };
    expect(result.instructions).toMatch(/race, religion, gender, age, marital status, pregnancy, disability or nationality/);
    expect(result.instructions).toMatch(/confirm/);
    expect((result.instructions ?? '').length).toBeLessThanOrEqual(1200);
  });
});

describe('/.well-known/oauth-protected-resource', () => {
  test('names this endpoint and the Supabase auth server', async () => {
    const before = process.env.NEXT_PUBLIC_SUPABASE_URL;
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://abc.supabase.co';
    const response = await wellKnown.GET(
      new Request('https://openkuasa.com/.well-known/oauth-protected-resource', { headers: { host: 'openkuasa.com' } }),
    );
    process.env.NEXT_PUBLIC_SUPABASE_URL = before;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      resource: 'https://openkuasa.com/api/mcp',
      authorization_servers: ['https://abc.supabase.co/auth/v1'],
    });
  });
});
