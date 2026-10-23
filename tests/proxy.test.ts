import { beforeEach, expect, test, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const updateSession = vi.fn();
vi.mock('@/lib/supabase/middleware', () => ({ updateSession: (request: NextRequest) => updateSession(request) }));

const { proxy } = await import('@/proxy');

beforeEach(() => {
  updateSession.mockReset();
  updateSession.mockImplementation(() => NextResponse.next());
});

test.each(['/api/mcp', '/.well-known/oauth-protected-resource'])('%s skips the cookie session', async (path) => {
  const response = await proxy(new NextRequest(`https://openkuasa.com${path}`, { method: path === '/api/mcp' ? 'POST' : 'GET' }));
  expect(updateSession).not.toHaveBeenCalled();
  expect(response.status).toBe(200);
  expect(response.headers.get('location')).toBeNull();
});

test('other paths still refresh the session', async () => {
  await proxy(new NextRequest('https://openkuasa.com/api/chat', { method: 'POST' }));
  await proxy(new NextRequest('https://openkuasa.com/api/mcpx'));
  expect(updateSession).toHaveBeenCalledTimes(2);
});
