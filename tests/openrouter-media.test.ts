import { afterEach, describe, expect, test, vi } from 'vitest';
import { costOr, usdToCents } from '@/lib/agents/costs';
import * as media from '@/lib/agents/openrouter-media';

// Shape-only: never calls the network. The real calls are validated at the manual smoke;
// agent/runner unit tests mock this whole module.
describe('openrouter media seam (shape only)', () => {
  test('exports the five media functions', () => {
    expect(typeof media.webSearch).toBe('function');
    expect(typeof media.writeDigest).toBe('function');
    expect(typeof media.generateImage).toBe('function');
    expect(typeof media.startVideo).toBe('function');
    expect(typeof media.checkVideo).toBe('function');
  });

  test('each function takes the apiKey first (declared arity)', () => {
    expect(media.webSearch.length).toBe(2);
    expect(media.writeDigest.length).toBe(2);
    expect(media.generateImage.length).toBe(2);
    expect(media.startVideo.length).toBe(2);
    expect(media.checkVideo.length).toBe(2);
  });
});

describe('cost reporting', () => {
  afterEach(() => vi.unstubAllGlobals());
  const respond = (body: unknown) =>
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => body })));

  test('a missing cost is "not reported" (null), never zero', () => {
    expect(usdToCents(undefined)).toBeNull();
    expect(usdToCents('0.2')).toBeNull();
    expect(usdToCents(Number.NaN)).toBeNull();
    expect(usdToCents(0)).toBe(0);
    // whole cents, rounded up
    expect(usdToCents(0.0312)).toBe(4);
  });

  test('an unreported cost falls back to the step estimate; a reported zero stays zero', () => {
    expect(costOr(null, 50)).toBe(50);
    expect(costOr(undefined, 50)).toBe(50);
    expect(costOr(0, 50)).toBe(0);
    expect(costOr(12, 50)).toBe(12);
  });

  test('submitting a video reports no cost when the provider gives none', async () => {
    respond({ id: 'job-1', status: 'pending' });
    expect(await media.startVideo('k', 'p')).toEqual({ jobId: 'job-1', cost_cents: null });
  });

  test('a finished video carries the cost the provider reports', async () => {
    respond({ status: 'completed', unsigned_urls: ['https://cdn/v.mp4'], usage: { cost: 0.42 } });
    expect(await media.checkVideo('k', 'job-1')).toEqual({
      status: 'done',
      url: 'https://cdn/v.mp4',
      cost_cents: 42,
    });
  });

  test('a finished or failed video with no usage reports no cost', async () => {
    respond({ status: 'completed', unsigned_urls: ['https://cdn/v.mp4'] });
    expect((await media.checkVideo('k', 'job-1')).cost_cents).toBeNull();
    respond({ status: 'failed' });
    expect(await media.checkVideo('k', 'job-1')).toEqual({ status: 'failed', cost_cents: null });
  });
});
