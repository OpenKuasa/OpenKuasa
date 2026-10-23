import { expect, test, vi } from 'vitest';

// viewer.ts imports the server Supabase client, which needs a request scope.
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }));

import { initialsOf, toViewer } from '@/lib/auth/viewer';

const org = { id: 'org-1', name: 'Acme Sdn Bhd', role: 'owner' as const };

test('uses full_name from user metadata when present', () => {
  const viewer = toViewer(
    { id: 'u1', email: 'siti@acme.my', user_metadata: { full_name: ' Siti Aminah ' } },
    org,
  );
  expect(viewer).toEqual({
    userId: 'u1',
    orgId: 'org-1',
    name: 'Siti Aminah',
    email: 'siti@acme.my',
    initials: 'SA',
    avatarUrl: null,
    orgName: 'Acme Sdn Bhd',
    role: 'owner',
    isDemo: false,
    firstName: 'Siti',
  });
});

test('falls back to the email local part when no name is set', () => {
  const viewer = toViewer({ id: 'u1', email: 'siti@acme.my', user_metadata: {} }, org);
  expect(viewer.name).toBe('siti');
  expect(viewer.initials).toBe('S');
});

test('labels anonymous demo sessions as a demo guest', () => {
  const viewer = toViewer({ id: 'u1', email: '', is_anonymous: true }, org);
  expect(viewer.name).toBe('Demo guest');
  expect(viewer.email).toBeNull();
  expect(viewer.isDemo).toBe(true);
});

test('prefers the profile name over auth metadata', () => {
  const viewer = toViewer(
    { id: 'u1', email: 'siti@acme.my', user_metadata: { full_name: 'Old Name' } },
    org,
    'Siti Aminah',
  );
  expect(viewer.name).toBe('Siti Aminah');
});

test('initialsOf takes at most two words and never returns empty', () => {
  expect(initialsOf('ahmad zaki bin ali')).toBe('AZ');
  expect(initialsOf('   ')).toBe('?');
});
