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

describe('cachedInstructions, for a prompt that ends with the time of day', () => {
  const FIXED = 'You are Kasturi.\n\nRULES\n- One rule.';
  const TODAY = 'TODAY\n- It is Tuesday, 2026-10-13, 09:41 in Malaysia (UTC+8).';
  const mark = { openrouter: { cacheControl: { type: 'ephemeral' } } };

  it('marks the fixed part and leaves the dated part out of the cache, in that order', () => {
    expect(cachedInstructions(`${FIXED}\n\n${TODAY}`, FIXED)).toEqual([
      { role: 'system', content: FIXED, providerOptions: mark },
      { role: 'system', content: TODAY },
    ]);
  });

  it('gives the model the same words, in the same order, as the one prompt did', () => {
    const whole = `${FIXED}\n\n${TODAY}`;
    const parts = cachedInstructions(whole, FIXED) as { content: string }[];
    expect(parts.map((p) => p.content).join('\n\n')).toBe(whole);
  });

  it('a minute later, the cached part is word for word the same', () => {
    const later = TODAY.replace('09:41', '09:42');
    const [a] = cachedInstructions(`${FIXED}\n\n${TODAY}`, FIXED) as { content: string }[];
    const [b] = cachedInstructions(`${FIXED}\n\n${later}`, FIXED) as { content: string }[];
    expect(a.content).toBe(b.content);
  });

  it('caches nothing, and loses nothing, when the prompt does not begin with the fixed part', () => {
    // Marked whole, a prompt holding the time would be written to the cache on every call and never read back.
    expect(cachedInstructions(`Something else.\n\n${TODAY}`, FIXED)).toEqual({ role: 'system', content: `Something else.\n\n${TODAY}` });
  });

  it('is one marked message when nothing follows the fixed part', () => {
    expect(cachedInstructions(FIXED, FIXED)).toEqual({ role: 'system', content: FIXED, providerOptions: mark });
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
