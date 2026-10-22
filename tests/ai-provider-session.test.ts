// tests/ai-provider-session.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateText } from 'ai';
import { getModel, pickModelId } from '@/lib/ai/provider';

/** What `getModel`'s calls post to OpenRouter, read from a stand-in for fetch. */
async function postedBody(layer: 'orchestrator' | 'worker', apiKey = 'sk-or-test'): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> = {};
  vi.stubGlobal('fetch', async (_url: unknown, init: { body?: string }) => {
    body = JSON.parse(init.body ?? '{}') as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        id: 'gen-1', model: 'm', created: 0, object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
  await generateText({ model: getModel(layer, apiKey), prompt: 'hi' });
  return body;
}

afterEach(() => vi.unstubAllGlobals());

describe('getModel', () => {
  it('names a session for the model, so OpenRouter keeps its calls on one provider and its prompt cache', async () => {
    const body = await postedBody('orchestrator');
    expect(body.session_id).toBe(`openkuasa:${pickModelId('orchestrator')}`);
  });

  it('gives each model its own session, the same on every call', async () => {
    const worker = await postedBody('worker');
    expect(worker.session_id).toBe(`openkuasa:${pickModelId('worker')}`);
    expect((await postedBody('worker', 'sk-or-other')).session_id).toBe(worker.session_id);
  });

  it('never sets a provider order, which would turn sticky routing off', async () => {
    expect((await postedBody('orchestrator')).provider).toBeUndefined();
  });
});
