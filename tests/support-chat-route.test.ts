import { beforeEach, describe, expect, it, vi } from 'vitest';

const ctl = vi.hoisted(() => ({
  user: { id: 'u1', is_anonymous: false } as null | { id: string; is_anonymous: boolean },
  hasKey: false,
  verdict: 'ok' as 'ok' | 'limited' | 'unavailable',
  daily: { allowed: true } as { allowed: true } | { allowed: false; reason: 'limit' | 'unavailable' },
  rpc: vi.fn(),
  streamText: vi.fn(),
  getModel: vi.fn(),
  limited: vi.fn(),
  daily_: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: ctl.user } }) },
    rpc: ctl.rpc,
  }),
}));
vi.mock('@/lib/ai/workspace-key', () => ({ readWorkspaceKey: async () => ({ status: 'ok', apiKey: 'sk-workspace' }) }));
vi.mock('@/lib/auth/current-org', () => ({ getCurrentOrg: async () => ({ orgId: 'o1', role: 'owner' }) }));
vi.mock('@/lib/supabase/service', () => ({ serviceClient: () => ({}) }));
vi.mock('@/lib/ai/provider', () => ({
  getModel: (...args: unknown[]) => {
    ctl.getModel(...args);
    return { id: 'model' };
  },
  pickModelId: () => 'worker-model',
  hasProviderKey: () => true,
}));
vi.mock('@/lib/ai/reply-language', () => ({ inUsersLanguage: (m: unknown) => m }));
vi.mock('@/lib/ai/rate-limit', () => ({
  consumeDailyQuota: async () => {
    ctl.daily_();
    return ctl.daily;
  },
}));
vi.mock('@/lib/security/limits', () => ({
  SUPPORT_QUESTION_PER_USER: { bucket: 'support_question', limit: 10, windowSeconds: 604800 },
  supportQuestionLimited: async (id: string) => {
    ctl.limited(id);
    return ctl.verdict;
  },
}));
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    streamText: (opts: unknown) => {
      ctl.streamText(opts);
      return { toUIMessageStreamResponse: () => new Response('streamed') };
    },
  };
});

import { handleSupportChat } from '@/lib/ai/support-chat';

const ask = (text: string, extraParts: unknown[] = []) =>
  new Request('http://localhost/api/support/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text }, ...extraParts] }],
    }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  ctl.user = { id: 'u1', is_anonymous: false };
  ctl.hasKey = false;
  ctl.verdict = 'ok';
  ctl.daily = { allowed: true };
  ctl.rpc.mockImplementation(async (name: string) =>
    name === 'org_ai_key_status' ? { data: ctl.hasKey, error: null } : { data: null, error: { message: 'unexpected ' + name } });
});

describe('the support Live chat', () => {
  it('turns away the signed out and demo guests before any model call', async () => {
    ctl.user = null;
    expect((await handleSupportChat(ask('How do I add an employee?'))).status).toBe(401);
    ctl.user = { id: 'g1', is_anonymous: true };
    expect((await handleSupportChat(ask('How do I add an employee?'))).status).toBe(403);
    expect(ctl.streamText).not.toHaveBeenCalled();
    expect(ctl.limited).not.toHaveBeenCalled();
  });

  it('answers on the platform key from its own allowance, with the guides search as its only tool', async () => {
    const res = await handleSupportChat(ask('How do I add an employee?'));
    expect(res.status).toBe(200);
    expect(ctl.limited).toHaveBeenCalledWith('u1');
    expect(ctl.getModel).toHaveBeenCalledWith('worker', undefined);
    const opts = ctl.streamText.mock.calls[0][0] as { tools: Record<string, unknown> };
    expect(Object.keys(opts.tools)).toEqual(['searchDocs']);
    // The weekly free chat questions are untouched.
    expect(ctl.rpc).not.toHaveBeenCalledWith('consume_free_question', expect.anything());
  });

  it('says the week is used up, and points to email', async () => {
    ctl.verdict = 'limited';
    const res = await handleSupportChat(ask('How do I add an employee?'));
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.code).toBe('support_limit');
    expect(body.error).toContain('openkuasa@proton.me');
    expect(ctl.streamText).not.toHaveBeenCalled();
  });

  it('refuses rather than answering free when the counter cannot be asked', async () => {
    ctl.verdict = 'unavailable';
    const res = await handleSupportChat(ask('How do I add an employee?'));
    expect(res.status).toBe(503);
    expect(ctl.streamText).not.toHaveBeenCalled();
  });

  it('bills a workspace with its own key to that key, with no support allowance spent', async () => {
    ctl.hasKey = true;
    const res = await handleSupportChat(ask('How do I add an employee?'));
    expect(res.status).toBe(200);
    expect(ctl.getModel).toHaveBeenCalledWith('worker', 'sk-workspace');
    expect(ctl.limited).not.toHaveBeenCalled();
    expect(ctl.daily_).toHaveBeenCalled();
  });

  it('keeps the daily limit for a workspace key', async () => {
    ctl.hasKey = true;
    ctl.daily = { allowed: false, reason: 'limit' };
    expect((await handleSupportChat(ask('How do I add an employee?'))).status).toBe(429);
    expect(ctl.streamText).not.toHaveBeenCalled();
  });

  it('refuses an over-long question and spends nothing on it', async () => {
    const res = await handleSupportChat(ask('x'.repeat(1001)));
    expect(res.status).toBe(413);
    expect(ctl.limited).not.toHaveBeenCalled();
  });

  it('drops attached files: words only', async () => {
    await handleSupportChat(ask('What is this?', [{ type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,AAAA' }]));
    const opts = ctl.streamText.mock.calls[0][0] as { messages: { content: unknown }[] };
    expect(JSON.stringify(opts.messages)).not.toContain('image/png');
  });

  it('refuses a request with no question', async () => {
    const res = await handleSupportChat(ask('   '));
    expect(res.status).toBe(400);
    expect(ctl.limited).not.toHaveBeenCalled();
  });
});
