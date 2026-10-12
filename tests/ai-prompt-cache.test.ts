// tests/ai-prompt-cache.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logModelCall } from '@/lib/ai/call-log';
import { cachedInstructions } from '@/lib/ai/prompt-cache';

afterEach(() => vi.restoreAllMocks());

describe('cachedInstructions', () => {
  it('gives the prompt as one system message marked for the provider to cache', () => {
    expect(cachedInstructions('You are Tuah.')).toEqual({
      role: 'system',
      content: 'You are Tuah.',
      providerOptions: { openrouter: { cacheControl: { type: 'ephemeral' } } },
    });
  });

  it('leaves the words exactly as they were given', () => {
    const prompt = 'Line one.\n\n- A rule with “quotes” and RM 6.88.\n';
    expect(cachedInstructions(prompt).content).toBe(prompt);
  });
});

describe('logModelCall', () => {
  const call = (details?: { cacheReadTokens?: number; cacheWriteTokens?: number }) => ({
    modelId: 'anthropic/claude-sonnet-4.6',
    finishReason: 'stop',
    usage: { inputTokens: 5000, outputTokens: 120, ...(details ? { inputTokenDetails: details } : {}) },
    performance: { responseTimeMs: 1234.4 },
  });

  it('says how many input tokens were read from the cache and how many were written to it', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    logModelCall('tuah-team', 'fallback')(call({ cacheReadTokens: 4600, cacheWriteTokens: 0 }));
    expect(info).toHaveBeenCalledWith(
      '[ai] agent=tuah-team model=anthropic/claude-sonnet-4.6 ms=1234 in=5000 cached=4600 wrote=0 out=120 finish=stop',
    );
  });

  it('says 0 when the provider reports no cache figures, so a missing cache is visible', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    logModelCall('lekir', 'fallback')(call());
    expect(info).toHaveBeenCalledWith(
      '[ai] agent=lekir model=anthropic/claude-sonnet-4.6 ms=1234 in=5000 cached=0 wrote=0 out=120 finish=stop',
    );
  });
});
