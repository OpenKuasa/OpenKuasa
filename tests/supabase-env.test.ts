import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  demoEnabled,
  supabaseAnonKey,
  supabasePublicUrl,
  supabaseServerUrl,
} from '@/lib/supabase/env';
import { storedPathOf } from '@/lib/chat/attachment-store';
import { authCookieName, serializePublicConfig, toPublicSupabaseUrl } from '@/lib/supabase/public-config';

const NAMES = [
  'SUPABASE_INTERNAL_URL',
  'SUPABASE_PUBLIC_URL',
  'NEXT_PUBLIC_SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'OPENKUASA_DEMO_ENABLED',
  'NEXT_PUBLIC_DEMO_ENABLED',
];

function clear() {
  for (const n of NAMES) vi.stubEnv(n, '');
}

afterEach(() => vi.unstubAllEnvs());

describe('runtime Supabase settings', () => {
  it('falls back to the NEXT_PUBLIC values when only they are set', () => {
    clear();
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://abc.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'k');
    expect(supabaseServerUrl()).toBe('https://abc.supabase.co');
    expect(supabasePublicUrl()).toBe('https://abc.supabase.co');
    expect(supabaseAnonKey()).toBe('k');
  });

  it('uses the internal URL on the server and the public one for the browser', () => {
    clear();
    vi.stubEnv('SUPABASE_INTERNAL_URL', 'http://kong:8000');
    vi.stubEnv('SUPABASE_PUBLIC_URL', 'http://localhost:58273');
    expect(supabaseServerUrl()).toBe('http://kong:8000');
    expect(supabasePublicUrl()).toBe('http://localhost:58273');
  });

  it('names the auth cookie from the public URL', () => {
    expect(authCookieName('https://abc.supabase.co')).toBe('sb-abc-auth-token');
    expect(authCookieName('http://localhost:58273')).toBe('sb-localhost-auth-token');
  });

  it('escapes < so the config cannot close its script tag', () => {
    const c = { supabaseUrl: '</script>', supabaseAnonKey: null };
    const s = serializePublicConfig(c);
    expect(s).not.toContain('</');
    expect(JSON.parse(s)).toEqual(c);
  });

  it('turns the demo on from either variable', () => {
    clear();
    expect(demoEnabled()).toBe(false);
    vi.stubEnv('OPENKUASA_DEMO_ENABLED', '1');
    expect(demoEnabled()).toBe(true);
    clear();
    vi.stubEnv('NEXT_PUBLIC_DEMO_ENABLED', '1');
    expect(demoEnabled()).toBe(true);
  });

  it('rewrites a signed link from the internal host to the public one', () => {
    clear();
    vi.stubEnv('SUPABASE_INTERNAL_URL', 'http://kong:8000');
    vi.stubEnv('SUPABASE_PUBLIC_URL', 'http://localhost:58273');
    expect(toPublicSupabaseUrl('http://kong:8000/storage/v1/object/sign/b/p.pdf?token=abc')).toBe(
      'http://localhost:58273/storage/v1/object/sign/b/p.pdf?token=abc',
    );
    expect(toPublicSupabaseUrl('https://elsewhere.test/x')).toBe('https://elsewhere.test/x');
  });

  it('leaves a link alone when both URLs are the same', () => {
    clear();
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://abc.supabase.co');
    const link = 'https://abc.supabase.co/storage/v1/object/sign/b/p.pdf?token=abc';
    expect(toPublicSupabaseUrl(link)).toBe(link);
  });

  it('finds a stored chat path from a link with either prefix', () => {
    clear();
    vi.stubEnv('SUPABASE_INTERNAL_URL', 'http://kong:8000');
    vi.stubEnv('SUPABASE_PUBLIC_URL', 'http://localhost:58273');
    const id = '11111111-1111-4111-8111-111111111111';
    const path = `${id}/${id}/${id}`;
    const tail = `/storage/v1/object/sign/chat-attachments/${path}?token=t`;
    expect(storedPathOf(`http://localhost:58273${tail}`, id)).toBe(path);
    expect(storedPathOf(`http://kong:8000${tail}`, id)).toBe(path);
  });
});
