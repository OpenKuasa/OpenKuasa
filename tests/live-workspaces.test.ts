import { describe, expect, it } from 'vitest';
import { createRegistry, type ServiceLike } from './helpers/live-workspaces';

type Fake = {
  service: ServiceLike;
  calls: string[];
};

function fake(opts: {
  slugs?: Record<string, string | null>;
  users?: Record<string, { is_anonymous?: boolean } | null>;
  failOrgDelete?: boolean;
  failUserDelete?: boolean;
} = {}): Fake {
  const calls: string[] = [];
  const service: ServiceLike = {
    from: () => ({
      select: () => ({
        eq: (_c, id) => ({
          maybeSingle: async () => {
            calls.push(`select-org:${id}`);
            const slug = opts.slugs?.[id] ?? null;
            return { data: { slug }, error: null };
          },
        }),
      }),
      delete: () => ({
        eq: async (_c, id) => {
          calls.push(`delete-org:${id}`);
          return { error: opts.failOrgDelete ? { message: 'denied' } : null };
        },
      }),
    }),
    auth: {
      admin: {
        getUserById: async (id) => {
          const user = opts.users && id in opts.users ? opts.users[id] : { is_anonymous: true };
          return { data: { user }, error: null };
        },
        deleteUser: async (id) => {
          calls.push(`delete-user:${id}`);
          return { error: opts.failUserDelete ? { message: 'denied' } : null };
        },
      },
    },
  };
  return { service, calls };
}

describe('live workspace cleanup', () => {
  it('deletes workspaces before users, and only recorded ids', async () => {
    const r = createRegistry();
    r.recordUser('u1');
    r.recordOrg('o1');
    r.recordUser('u2');
    r.recordOrg('o2');
    const { service, calls } = fake();
    const result = await r.cleanup(service, () => {});
    expect(result).toEqual({ skipped: false, workspaces: 2, users: 2 });
    const deletes = calls.filter((c) => c.startsWith('delete-'));
    expect(deletes).toEqual(['delete-org:o1', 'delete-org:o2', 'delete-user:u1', 'delete-user:u2']);
  });

  it('does nothing when nothing was recorded', async () => {
    const { service, calls } = fake();
    const lines: string[] = [];
    await createRegistry().cleanup(service, (l) => lines.push(l));
    await createRegistry().cleanup(null, (l) => lines.push(l));
    expect(calls).toEqual([]);
    expect(lines).toEqual([]);
  });

  it('refuses to delete a workspace that has a slug', async () => {
    const r = createRegistry();
    r.recordOrg('demo');
    r.recordOrg('mine');
    const { service, calls } = fake({ slugs: { demo: 'rimba-ventures-demo' } });
    const lines: string[] = [];
    await expect(r.cleanup(service, (l) => lines.push(l))).rejects.toThrow(/cleanup failed/);
    expect(calls).not.toContain('delete-org:demo');
    expect(calls).toContain('delete-org:mine');
    expect(lines).toEqual([expect.stringContaining('1 workspace(s)')]);
  });

  it('refuses a recorded anonymous user that is not anonymous, but allows a sign-up user', async () => {
    const r = createRegistry();
    r.recordUser('real', 'anonymous');
    r.recordUser('qa', 'signup');
    const { service, calls } = fake({
      users: { real: { is_anonymous: false }, qa: { is_anonymous: false } },
    });
    await expect(r.cleanup(service, () => {})).rejects.toThrow();
    expect(calls).not.toContain('delete-user:real');
    expect(calls).toContain('delete-user:qa');
  });

  it('skips with one loud line when the service key is missing', async () => {
    const r = createRegistry();
    r.recordOrg('o1');
    r.recordUser('u1');
    const lines: string[] = [];
    const result = await r.cleanup(null, (l) => lines.push(l));
    expect(result.skipped).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/SUPABASE_SERVICE_ROLE_KEY/);
    expect(lines[0]).toMatch(/LEFT BEHIND 1 workspace\(s\) and 1 user\(s\)/);
  });

  it('reports a failed delete (one line per kind, with a count) and rejects', async () => {
    const r = createRegistry();
    r.recordOrg('o1');
    r.recordOrg('o2');
    r.recordUser('u1');
    const { service } = fake({ failOrgDelete: true, failUserDelete: true });
    const lines: string[] = [];
    await expect(r.cleanup(service, (l) => lines.push(l))).rejects.toThrow(/2 workspace\(s\), 1 user\(s\)/);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/2 workspace\(s\)/);
    expect(lines[1]).toMatch(/1 user\(s\)/);
  });
});
