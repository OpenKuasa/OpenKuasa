import { describe, expect, test, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { currentOrgFor, getCurrentOrg, requireOrg } from '@/lib/auth/current-org';

vi.mock('next/navigation', () => ({
  redirect: vi.fn((path: string) => { throw new Error(`REDIRECT:${path}`); }),
}));

type Row = { user_id: string; org_id: string; role: string };

// Serves profiles (returns current_org_id) and org_members (filtered by the
// eq() calls) from one fake, keyed by table name.
function fakeClient(
  user: { id: string } | null,
  currentOrgId: string | null,
  memberships: Row[],
  opts: { queryError?: Error } = {},
) {
  return {
    auth: { getUser: async () => ({ data: { user }, error: null }) },
    from: (table: string) => {
      const eqs: Record<string, string> = {};
      const b = {
        select: () => b,
        eq: (c: string, v: string) => { eqs[c] = v; return b; },
        order: () => b,
        limit: () => b,
        maybeSingle: async () => {
          if (table === 'profiles') return { data: { current_org_id: currentOrgId }, error: null };
          if (opts.queryError) return { data: null, error: opts.queryError };
          let rows = memberships.filter((r) => r.user_id === eqs.user_id);
          if (eqs.org_id) rows = rows.filter((r) => r.org_id === eqs.org_id);
          const m = rows[0];
          return { data: m ? { org_id: m.org_id, role: m.role } : null, error: null };
        },
      };
      return b;
    },
  } as unknown as SupabaseClient;
}

test('returns null when not signed in', async () => {
  expect(await getCurrentOrg(fakeClient(null, null, []))).toBeNull();
});

test('returns null when signed in but org-less', async () => {
  expect(await getCurrentOrg(fakeClient({ id: 'u1' }, null, []))).toBeNull();
});

test('falls back to the earliest membership when no current_org_id is set', async () => {
  const rows = [{ user_id: 'u1', org_id: 'o1', role: 'owner' }];
  expect(await getCurrentOrg(fakeClient({ id: 'u1' }, null, rows))).toEqual({ orgId: 'o1', role: 'owner' });
});

test('prefers the chosen current org when the user still belongs to it', async () => {
  const rows = [
    { user_id: 'u1', org_id: 'o1', role: 'owner' },
    { user_id: 'u1', org_id: 'o2', role: 'viewer' }, // e.g. the demo org
  ];
  expect(await getCurrentOrg(fakeClient({ id: 'u1' }, 'o2', rows))).toEqual({ orgId: 'o2', role: 'viewer' });
});

test('ignores a current_org_id the user no longer belongs to', async () => {
  const rows = [{ user_id: 'u1', org_id: 'o1', role: 'owner' }];
  expect(await getCurrentOrg(fakeClient({ id: 'u1' }, 'o9', rows))).toEqual({ orgId: 'o1', role: 'owner' });
});

test('throws on an org_members query error instead of reporting org-less', async () => {
  const boom = new Error('db down');
  await expect(getCurrentOrg(fakeClient({ id: 'u1' }, null, [], { queryError: boom }))).rejects.toBe(boom);
});

test('requireOrg redirects to /onboarding when org-less', async () => {
  await expect(requireOrg(fakeClient({ id: 'u1' }, null, []))).rejects.toThrow('REDIRECT:/onboarding');
});

test('requireOrg returns the org for a member', async () => {
  const rows = [{ user_id: 'u1', org_id: 'o1', role: 'admin' }];
  expect(await requireOrg(fakeClient({ id: 'u1' }, null, rows))).toEqual({ orgId: 'o1', role: 'admin' });
});

describe('currentOrgFor', () => {
  const rows = [
    { user_id: 'u1', org_id: 'o1', role: 'owner' },
    { user_id: 'u1', org_id: 'o2', role: 'viewer' },
  ];

  test('the recorded workspace, while the person still belongs to it', async () => {
    expect(await currentOrgFor(fakeClient(null, 'o2', rows), 'u1')).toEqual({ orgId: 'o2', role: 'viewer' });
  });

  test('the earliest membership when the recorded workspace was left', async () => {
    expect(await currentOrgFor(fakeClient(null, 'o9', rows), 'u1')).toEqual({ orgId: 'o1', role: 'owner' });
  });

  test('the earliest membership when nothing is recorded', async () => {
    expect(await currentOrgFor(fakeClient(null, null, rows), 'u1')).toEqual({ orgId: 'o1', role: 'owner' });
  });

  test('null with no membership at all', async () => {
    expect(await currentOrgFor(fakeClient(null, null, []), 'u1')).toBeNull();
  });

  test('throws on the earliest-membership read error', async () => {
    const boom = new Error('db down');
    await expect(currentOrgFor(fakeClient(null, null, [], { queryError: boom }), 'u1')).rejects.toBe(boom);
  });

  test('getCurrentOrg still returns null when signed out, without a lookup', async () => {
    expect(await getCurrentOrg(fakeClient(null, 'o1', rows))).toBeNull();
  });
});
