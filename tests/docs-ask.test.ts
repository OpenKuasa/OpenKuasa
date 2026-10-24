import { beforeEach, expect, test, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { createClient } = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createClient }));

import { GET } from '@/app/docs/ask/route';
import { ASK_MAX, cleanAsk, sariAskPath } from '@/lib/docs/ask';

// A JWT whose payload carries the claims given; the signature is never checked.
function token(claims: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `e30.${body}.sig`;
}

type Session = {
  user?: { id: string; is_anonymous?: boolean } | null;
  accessToken?: string;
};

function fakeClient({ user = null, accessToken = token({ sub: 'u1' }) }: Session = {}) {
  const client = {
    auth: {
      getUser: vi.fn(async () => ({ data: { user }, error: null })),
      getSession: vi.fn(async () => ({
        data: { session: user ? { access_token: accessToken } : null },
        error: null,
      })),
    },
  };
  createClient.mockResolvedValue(client);
  return client;
}

function request(query: string): NextRequest {
  const nextUrl = new URL(`https://app.example/docs/ask${query}`);
  return { nextUrl, url: nextUrl.toString() } as unknown as NextRequest;
}

const QUESTION = 'How do I run payroll?';
const SARI = `/command?ask=${encodeURIComponent(QUESTION)}`;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://db.example');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon');
});

test('cleanAsk keeps plain text, strips control chars and caps length', () => {
  expect(cleanAsk('  How do I\nrun payroll?\u0000 ')).toBe('How do I run payroll?');
  expect(cleanAsk('a'.repeat(2000))?.length).toBe(300);
  expect(cleanAsk('   ')).toBeNull();
  expect(cleanAsk(42)).toBeNull();
});

test('cleanAsk is stable and never leaves half a character', () => {
  const long = `${'a'.repeat(ASK_MAX - 1)}😀 tail`;
  const cleaned = cleanAsk(long)!;
  expect(cleaned).toBe('a'.repeat(ASK_MAX - 1));
  expect(cleanAsk(`${'a'.repeat(ASK_MAX - 1)} b`)).toBe('a'.repeat(ASK_MAX - 1));
  expect(cleanAsk('a‮b​c')).toBe('abc');
  expect(cleanAsk('lone \ud800 surrogate')).toBe('lone surrogate');
  for (const value of ['  x  y ', long, 'Gaji & KWSP?']) {
    const once = cleanAsk(value);
    expect(cleanAsk(once)).toBe(once);
  }
  expect(sariAskPath('  a  b ')).toBe('/command?ask=a%20b');
});

test('signed-out, anonymous demo and OAuth-token sessions go to sign-in with Sari as the return', async () => {
  const login = `/login?next=${encodeURIComponent(SARI)}`;
  const cases: Session[] = [
    {},
    { user: { id: 'demo', is_anonymous: true } },
    { user: { id: 'u1' }, accessToken: token({ sub: 'u1', client_id: 'tool' }) },
  ];
  for (const session of cases) {
    fakeClient(session);
    const response = await GET(request(`?q=${encodeURIComponent(QUESTION)}`));
    expect(response.status).toBe(307);
    const location = new URL(response.headers.get('location')!);
    expect(location.origin).toBe('https://app.example');
    expect(`${location.pathname}${location.search}`).toBe(login);
    expect(response.headers.get('cache-control')).toBe('no-store');
  }
});

test('a signed-in person goes straight to Sari with the question', async () => {
  fakeClient({ user: { id: 'u1', is_anonymous: false } });
  const response = await GET(request(`?q=${encodeURIComponent(`  ${QUESTION}\n`)}`));
  expect(response.status).toBe(307);
  const location = new URL(response.headers.get('location')!);
  expect(`${location.pathname}${location.search}`).toBe(SARI);
  expect(response.headers.get('cache-control')).toBe('no-store');
});

test('an empty question goes back to /docs and nothing is cached', async () => {
  fakeClient({ user: { id: 'u1' } });
  for (const query of ['', '?q=', '?q=%20%0A', '?other=1']) {
    const response = await GET(request(query));
    expect(response.status).toBe(307);
    expect(new URL(response.headers.get('location')!).pathname).toBe('/docs');
    expect(response.headers.get('cache-control')).toBe('no-store');
  }
  expect(createClient).not.toHaveBeenCalled();
});

test('without a database configured, the visitor is sent to sign-in', async () => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '');
  const response = await GET(request(`?q=${encodeURIComponent(QUESTION)}`));
  expect(new URL(response.headers.get('location')!).pathname).toBe('/login');
  expect(createClient).not.toHaveBeenCalled();
});
