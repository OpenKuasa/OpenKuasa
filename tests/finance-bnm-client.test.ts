import { afterEach, describe, expect, it, vi } from 'vitest';
import { bnmGet } from '@/lib/finance/bnm-client';

// The one call to BNM, with fetch stubbed: nothing here reaches the network.

afterEach(() => vi.unstubAllGlobals());

const stub = (res: Response | Error) => {
  const fn = vi.fn(async () => {
    if (res instanceof Error) throw res;
    return res;
  });
  vi.stubGlobal('fetch', fn);
  return fn;
};

describe('bnmGet', () => {
  it('sends BNM its Accept header and reads JSON, including a 404 BNM sent on purpose', async () => {
    const fn = stub(new Response(JSON.stringify({ code: 404 }), { status: 404, headers: { 'content-type': 'application/json' } }));
    expect(await bnmGet('/exchange-rate?session=1700', 1000)).toEqual({ kind: 'json', status: 404, body: { code: 404 } });
    const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.bnm.gov.my/public/exchange-rate?session=1700');
    expect((init.headers as Record<string, string>).Accept).toBe('application/vnd.BNM.API.v1+json');
  });

  it('says not-json for HTML, and for JSON that does not parse', async () => {
    stub(new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    expect(await bnmGet('/x', 1000)).toEqual({ kind: 'not-json', status: 200 });
    stub(new Response('{oops', { status: 200, headers: { 'content-type': 'application/json' } }));
    expect(await bnmGet('/x', 1000)).toEqual({ kind: 'not-json', status: 200 });
  });

  it('throws on a network failure or a timeout', async () => {
    stub(new TypeError('fetch failed'));
    await expect(bnmGet('/x', 1000)).rejects.toThrow('fetch failed');
  });
});
