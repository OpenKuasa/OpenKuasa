import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { NextRequest } from 'next/server';

// viewer.ts imports the server Supabase client, which needs a request scope.
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }));

import { deploymentMode, resolveDeploymentMode } from '@/lib/auth/preview-mode';
import { getViewer } from '@/lib/auth/viewer';
import { updateSession } from '@/lib/supabase/middleware';

const request = () => new NextRequest('https://app.example/command');

function setEnv(env: {
  node: string;
  url?: string;
  key?: string;
  preview?: string;
}) {
  vi.stubEnv('NODE_ENV', env.node);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', env.url ?? '');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', env.key ?? '');
  vi.stubEnv('OPENKUASA_PREVIEW', env.preview ?? '');
}

let logged: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  logged = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  logged.mockRestore();
});

test('with both Supabase values the app is live, whatever else is set', () => {
  for (const nodeEnv of ['production', 'development', 'test']) {
    expect(
      resolveDeploymentMode({ hasSupabase: true, nodeEnv, previewFlag: undefined }),
    ).toBe('live');
  }
  expect(
    resolveDeploymentMode({ hasSupabase: true, nodeEnv: 'production', previewFlag: '1' }),
  ).toBe('live');
});

test('outside production a missing project means preview', () => {
  for (const nodeEnv of ['development', 'test', undefined]) {
    expect(
      resolveDeploymentMode({ hasSupabase: false, nodeEnv, previewFlag: undefined }),
    ).toBe('preview');
  }
});

test('in production a missing project is blocked unless preview is asked for', () => {
  const production = { hasSupabase: false, nodeEnv: 'production' };
  expect(resolveDeploymentMode({ ...production, previewFlag: undefined })).toBe('blocked');
  expect(resolveDeploymentMode({ ...production, previewFlag: '' })).toBe('blocked');
  expect(resolveDeploymentMode({ ...production, previewFlag: '0' })).toBe('blocked');
  expect(resolveDeploymentMode({ ...production, previewFlag: 'true' })).toBe('blocked');
  expect(resolveDeploymentMode({ ...production, previewFlag: '1' })).toBe('preview');
});

test('losing either value in production counts as missing', () => {
  setEnv({ node: 'production', url: 'https://x.supabase.co' });
  expect(deploymentMode()).toBe('blocked');
  setEnv({ node: 'production', key: 'anon' });
  expect(deploymentMode()).toBe('blocked');
  setEnv({ node: 'production', url: 'https://x.supabase.co', key: 'anon' });
  expect(deploymentMode()).toBe('live');
});

test('a production request without a project gets a 503, not the sample app', async () => {
  setEnv({ node: 'production' });

  const response = await updateSession(request());

  expect(response.status).toBe(503);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('content-type')).toMatch(/^text\/plain/);
  const body = await response.text();
  expect(body).toMatch(/unavailable/i);
  // The public page says nothing about how the server is set up.
  expect(body).not.toMatch(/SUPABASE|OPENKUASA_PREVIEW|env/i);
  // The operator's log does.
  expect(logged).toHaveBeenCalled();
  expect(String(logged.mock.calls[0][0])).toMatch(/NEXT_PUBLIC_SUPABASE_URL/);
  expect(String(logged.mock.calls[0][0])).toMatch(/OPENKUASA_PREVIEW=1/);
});

test('an intentional preview deployment is served', async () => {
  setEnv({ node: 'production', preview: '1' });
  const response = await updateSession(request());
  expect(response.status).toBe(200);
});

test('local development without a project is served as before', async () => {
  setEnv({ node: 'development' });
  const response = await updateSession(request());
  expect(response.status).toBe(200);
  expect(logged).not.toHaveBeenCalled();
});

test('the guest viewer is never handed out when preview is blocked', async () => {
  setEnv({ node: 'production' });
  await expect(getViewer()).rejects.toThrow(/not configured/i);

  setEnv({ node: 'production', preview: '1' });
  expect((await getViewer()).name).toBe('Guest');

  setEnv({ node: 'test' });
  expect((await getViewer()).name).toBe('Guest');
});
