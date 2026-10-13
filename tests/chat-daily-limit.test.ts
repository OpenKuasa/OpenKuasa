import { beforeEach, describe, expect, it, vi } from 'vitest';

const ctl = vi.hoisted(() => ({
  user: { id: 'u1', is_anonymous: false } as { id: string; is_anonymous: boolean } | null,
  access: { kind: 'byok', apiKey: 'sk-or-workspace' } as
    | { kind: 'byok'; apiKey: string }
    | { kind: 'free'; remaining: number }
    | { kind: 'locked'; status: number; code: string; error: string },
  quota: { data: 10 as unknown, error: null as { message: string } | null },
  quotaThrows: false,
  rpcCalls: [] as { name: string; args: unknown }[],
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: ctl.user } }) },
    rpc: async (name: string, args: unknown) => {
      ctl.rpcCalls.push({ name, args });
      if (ctl.quotaThrows) throw new Error('network down');
      return ctl.quota;
    },
  }),
}));
vi.mock('@/lib/ai/gate', () => ({ resolveChatAccess: async () => ctl.access }));
vi.mock('@/lib/chat/attachment-store', () => ({
  resolveStoredFiles: async (_client: unknown, _userId: string, messages: unknown[]) => messages,
}));

const { prepareChat } = await import('@/lib/ai/chat-request');
const { WORKSPACE_KEY_TURNS_PER_DAY, consumeDailyQuota } = await import('@/lib/ai/rate-limit');

const turn = (body: unknown = { messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }] }) =>
  new Request('http://x/api/chat', { method: 'POST', body: JSON.stringify(body) });

const quotaCalls = () => ctl.rpcCalls.filter((c) => c.name === 'consume_ai_quota');

beforeEach(() => {
  ctl.user = { id: 'u1', is_anonymous: false };
  ctl.access = { kind: 'byok', apiKey: 'sk-or-workspace' };
  ctl.quota = { data: 10, error: null };
  ctl.quotaThrows = false;
  ctl.rpcCalls = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('prepareChat: per-user daily limit on a workspace key', () => {
  it('counts one turn against the caller and lets it through while under the limit', async () => {
    const chat = await prepareChat(turn());
    expect(chat.ok).toBe(true);
    expect(quotaCalls()).toEqual([
      { name: 'consume_ai_quota', args: { daily_limit: WORKSPACE_KEY_TURNS_PER_DAY } },
    ]);
    if (chat.ok) expect(chat.apiKey).toBe('sk-or-workspace');
  });

  it('refuses the turn once the caller is over the limit for the day', async () => {
    ctl.quota = { data: -1, error: null };
    const chat = await prepareChat(turn());
    expect(chat.ok).toBe(false);
    if (chat.ok) return;
    expect(chat.response.status).toBe(429);
    expect(await chat.response.json()).toMatchObject({ code: 'daily_limit' });
  });

  it('refuses the turn when the counter cannot be read (no silent unlimited chat)', async () => {
    ctl.quota = { data: null, error: { message: 'function public.consume_ai_quota does not exist' } };
    const chat = await prepareChat(turn());
    expect(chat.ok).toBe(false);
    if (chat.ok) return;
    expect(chat.response.status).toBe(503);
    const body = await chat.response.json();
    expect(body).toMatchObject({ code: 'limit_unavailable' });
    // The database's message stays in the server log.
    expect(JSON.stringify(body)).not.toContain('consume_ai_quota');
  });

  it('refuses the turn when the counter call throws', async () => {
    ctl.quotaThrows = true;
    const chat = await prepareChat(turn());
    expect(chat.ok).toBe(false);
    if (!chat.ok) expect(chat.response.status).toBe(503);
  });

  it('a free question on the platform key keeps its weekly allowance and is not counted here', async () => {
    ctl.access = { kind: 'free', remaining: 2 };
    const chat = await prepareChat(turn());
    expect(chat.ok).toBe(true);
    if (chat.ok) expect(chat.freeRemaining).toBe(2);
    expect(quotaCalls()).toHaveLength(0);
  });

  it('a malformed request does not use up a turn', async () => {
    const chat = await prepareChat(turn({ messages: [] }));
    expect(chat.ok).toBe(false);
    expect(quotaCalls()).toHaveLength(0);
  });

  it('a request that may not reach a model does not use up a turn', async () => {
    ctl.access = { kind: 'locked', status: 403, code: 'demo', error: 'Sign up for a free account to chat.' };
    const chat = await prepareChat(turn());
    expect(chat.ok).toBe(false);
    expect(quotaCalls()).toHaveLength(0);
  });
});

describe('consumeDailyQuota', () => {
  const client = (result: { data: unknown; error: { message: string } | null }) =>
    ({ rpc: async () => result }) as never;

  it('allows with the remaining count when under the limit', async () => {
    expect(await consumeDailyQuota(client({ data: 0, error: null }))).toEqual({ allowed: true, remaining: 0 });
  });
  it('is over the limit on -1', async () => {
    expect(await consumeDailyQuota(client({ data: -1, error: null }))).toEqual({ allowed: false, reason: 'limit' });
  });
  it('fails closed on an error or an answer that is not a number', async () => {
    expect(await consumeDailyQuota(client({ data: null, error: { message: 'x' } }))).toEqual({
      allowed: false,
      reason: 'unavailable',
    });
    expect(await consumeDailyQuota(client({ data: null, error: null }))).toEqual({
      allowed: false,
      reason: 'unavailable',
    });
  });
});
