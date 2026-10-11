import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createRegistry, TEST_EMAIL_SQL_PATTERN, type ServiceLike } from './helpers/live-workspaces';

type Failure = { message: string; code?: string; status?: number } | null;
type FakeUser = { is_anonymous?: boolean; email?: string; created_at?: string } | null;

const NOW = Date.parse('2026-10-19T12:00:00Z');
const FRESH = new Date(NOW + 1000).toISOString();
const STALE = new Date(NOW - 3_600_000).toISOString();
const GONE: Failure = { message: 'User not found', code: 'user_not_found', status: 404 };

function fake(
  opts: {
    orgs?: Record<string, boolean | Failure>; // rpc outcome per org id (default true)
    users?: Record<string, FakeUser | 'error'>; // default: fresh anonymous
    deleteUserError?: Record<string, Failure>;
  } = {},
) {
  const calls: string[] = [];
  const service: ServiceLike = {
    rpc: async (fn, args) => {
      calls.push(`rpc:${fn}:${args.p_id}`);
      const o = opts.orgs?.[args.p_id] ?? true;
      if (typeof o === 'boolean') return { data: o, error: null };
      return { data: null, error: o };
    },
    auth: {
      admin: {
        getUserById: async (id) => {
          calls.push(`get:${id}`);
          const u = opts.users && id in opts.users ? opts.users[id] : { is_anonymous: true, created_at: FRESH };
          if (u === 'error') return { data: { user: null }, error: { message: 'boom' } };
          if (u === null) return { data: { user: null }, error: GONE };
          return { data: { user: u }, error: null };
        },
        deleteUser: async (id) => {
          calls.push(`delete-user:${id}`);
          return { error: opts.deleteUserError?.[id] ?? null };
        },
      },
    },
  };
  return { service, calls };
}

const make = () => createRegistry({ startedAt: NOW, runToken: 'abcdef012345' });
const quiet = () => {
  const lines: string[] = [];
  return { lines, log: (l: string) => void lines.push(l) };
};

/** A fake signed-out client for driving signInAnon / createOrg / joinDemo / signUp. */
function fakeClient(over: {
  anonUser?: string | null;
  rpc?: (fn: string) => { data: unknown; error: Failure };
  signUpUser?: string | null;
}) {
  return {
    auth: {
      signInAnonymously: async () => ({
        data: { user: over.anonUser ? { id: over.anonUser } : null },
        error: null,
      }),
      signUp: async () => ({
        data: { user: over.signUpUser ? { id: over.signUpUser } : null },
        error: null,
      }),
    },
    rpc: async (fn: string) => over.rpc?.(fn) ?? { data: null, error: null },
  } as unknown as SupabaseClient;
}

describe('recording', () => {
  it('signInAnon records the user, createOrg records a string id, joinDemo records no workspace', async () => {
    const r = make();
    const c = fakeClient({ anonUser: 'u1', rpc: (fn) => ({ data: fn === 'join_demo_org' ? 'demo-id' : 'o1', error: null }) });
    await r.signInAnon(c);
    await r.createOrg(c, 'X');
    await r.joinDemo(c);
    const { service, calls } = fake();
    await r.cleanup(() => service, () => {});
    expect(calls.filter((x) => x.startsWith('rpc'))).toEqual(['rpc:delete_test_org:o1']);
    expect(calls).toContain('delete-user:u1');
  });

  it('a non-string rpc result records nothing', async () => {
    const r = make();
    const c = fakeClient({ rpc: () => ({ data: { id: 'o1' }, error: null }) });
    await r.createOrg(c, 'X');
    const { service, calls } = fake();
    let built = false;
    await r.cleanup(() => ((built = true), service), () => {});
    expect(built).toBe(false);
    expect(calls).toEqual([]);
  });

  it('builds no service client when nothing was recorded', async () => {
    let built = false;
    const lines: string[] = [];
    await make().cleanup(() => ((built = true), null), (l) => lines.push(l));
    expect(built).toBe(false);
    expect(lines).toEqual([]);
  });

  it('signUpTestUser generates the address itself and records it', async () => {
    const r = make();
    const c = fakeClient({ signUpUser: 'su1' });
    const res = await r.signUpTestUser(c, 'pw');
    expect(res.email).toMatch(/^qa-abcdef012345-1@example\.com$/);
    const { service, calls } = fake({ users: { su1: { is_anonymous: false, email: res.email, created_at: FRESH } } });
    await r.cleanup(() => service, () => {});
    expect(calls).toContain('delete-user:su1');
  });

  it('a later recordUser cannot downgrade an existing record', async () => {
    const r = make();
    r.recordUser('x', { kind: 'signup', email: 'qa-abcdef012345-1@example.com' });
    r.recordUser('x', { kind: 'anonymous' });
    // the fetched user is a fresh anonymous one: an overwrite to 'anonymous' would delete it,
    // but the original sign-up guard (email must match) refuses it
    const { service, calls } = fake({ users: { x: { is_anonymous: true, email: 'real@corp.com', created_at: FRESH } } });
    await expect(r.cleanup(() => service, () => {})).rejects.toThrow();
    expect(calls).not.toContain('delete-user:x');
  });
});

describe('cleanup order and scope', () => {
  it('deletes workspaces before users, and only recorded ids', async () => {
    const r = make();
    r.recordUser('u1');
    r.recordOrg('o1');
    r.recordUser('u2');
    r.recordOrg('o2');
    const { service, calls } = fake();
    const res = await r.cleanup(() => service, () => {});
    expect(res).toMatchObject({ skipped: false, workspaces: 2, users: 2 });
    const deletes = calls.filter((c) => c.startsWith('rpc') || c.startsWith('delete-'));
    expect(deletes.slice(0, 2).sort()).toEqual(['rpc:delete_test_org:o1', 'rpc:delete_test_org:o2']);
    expect(deletes.slice(2).sort()).toEqual(['delete-user:u1', 'delete-user:u2']);
  });
});

describe('workspace failures protect users (I1)', () => {
  it('skips every user delete when a workspace delete returned false, and reports ids', async () => {
    const r = make();
    r.recordOrg('demo');
    r.recordUser('u1');
    const { service, calls } = fake({ orgs: { demo: false } });
    const { lines, log } = quiet();
    await expect(r.cleanup(() => service, log)).rejects.toThrow(/cleanup failed/);
    expect(calls.some((c) => c.startsWith('get:') || c.startsWith('delete-user:'))).toBe(false);
    expect(lines.join('\n')).toMatch(/demo/);
    expect(lines.join('\n')).toMatch(/user/);
  });

  it('skips users when a workspace delete errored, with the error code in the line', async () => {
    const r = make();
    r.recordOrg('o1');
    r.recordUser('u1');
    const { service, calls } = fake({ orgs: { o1: { message: 'bad', code: 'XX000' } } });
    const { lines, log } = quiet();
    await expect(r.cleanup(() => service, log)).rejects.toThrow();
    expect(calls.some((c) => c.startsWith('delete-user:'))).toBe(false);
    expect(lines.join('\n')).toMatch(/XX000/);
  });

  it.each(['PGRST202', '42883', '42501'])('treats %s on the first call as "migration not applied": one loud line, no failure', async (code) => {
    const r = make();
    r.recordOrg('o1');
    r.recordOrg('o2');
    r.recordUser('u1');
    const { service, calls } = fake({ orgs: { o1: { message: 'nope', code }, o2: { message: 'nope', code } } });
    const { lines, log } = quiet();
    const res = await r.cleanup(() => service, log);
    expect(res.skipped).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/delete_test_org/);
    expect(lines[0]).toMatch(/not applied/i);
    expect(calls.filter((c) => c.startsWith('rpc'))).toHaveLength(1);
    expect(calls.some((c) => c.startsWith('delete-user:'))).toBe(false);
  });
});

describe('missing key', () => {
  it('skips with one loud line', async () => {
    const r = make();
    r.recordOrg('o1');
    r.recordUser('u1');
    const { lines, log } = quiet();
    const res = await r.cleanup(() => null, log);
    expect(res.skipped).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/SUPABASE_SERVICE_ROLE_KEY/);
    expect(lines[0]).toMatch(/LEFT BEHIND 1 workspace\(s\) and 1 user\(s\)/);
  });
});

describe('more cases', () => {
  it('does not delete any user when the first workspace deleted but a later one failed', async () => {
    const r = make();
    r.recordOrg('o1');
    r.recordOrg('o2');
    r.recordUser('u1');
    const { service, calls } = fake({ orgs: { o2: false } });
    await expect(r.cleanup(() => service, () => {})).rejects.toThrow();
    expect(calls).toContain('rpc:delete_test_org:o1');
    expect(calls.some((c) => c.startsWith('delete-user:'))).toBe(false);
  });

  it('generates sign-up addresses that match the SQL pattern', async () => {
    const r = createRegistry();
    const res = await r.signUpTestUser(fakeClient({ signUpUser: 's1' }), 'pw');
    expect(res.email).toMatch(new RegExp(TEST_EMAIL_SQL_PATTERN));
  });

  it('allows a user created just inside 60s before process start and refuses one just outside', async () => {
    const r = make();
    r.recordUser('inside');
    r.recordUser('outside');
    const { service, calls } = fake({
      users: {
        inside: { is_anonymous: true, created_at: new Date(NOW - 59_000).toISOString() },
        outside: { is_anonymous: true, created_at: new Date(NOW - 61_000).toISOString() },
      },
    });
    await expect(r.cleanup(() => service, () => {})).rejects.toThrow(/1 user/);
    expect(calls).toContain('delete-user:inside');
    expect(calls).not.toContain('delete-user:outside');
  });
});

describe('user guards (I3)', () => {
  it('refuses an anonymous record that is not anonymous, or older than the process', async () => {
    const r = make();
    r.recordUser('real');
    r.recordUser('old');
    r.recordUser('ok');
    const { service, calls } = fake({
      users: {
        real: { is_anonymous: false, created_at: FRESH },
        old: { is_anonymous: true, created_at: STALE },
        ok: { is_anonymous: true, created_at: FRESH },
      },
    });
    const { lines, log } = quiet();
    await expect(r.cleanup(() => service, log)).rejects.toThrow(/2 user/);
    expect(calls).toEqual(expect.arrayContaining(['delete-user:ok']));
    expect(calls).not.toContain('delete-user:real');
    expect(calls).not.toContain('delete-user:old');
    expect(lines.join('\n')).toMatch(/real/);
  });

  it('refuses a sign-up user whose email differs, lacks the run token, or is older than the process', async () => {
    const r = make();
    const good = 'qa-abcdef012345-1@example.com';
    r.recordUser('a', { kind: 'signup', email: good });
    r.recordUser('b', { kind: 'signup', email: 'qa-ffffffffffff-1@example.com' });
    r.recordUser('c', { kind: 'signup', email: good });
    r.recordUser('d', { kind: 'signup', email: good });
    const { service, calls } = fake({
      users: {
        a: { is_anonymous: false, email: good, created_at: FRESH },
        b: { is_anonymous: false, email: 'qa-ffffffffffff-1@example.com', created_at: FRESH }, // other run's token
        c: { is_anonymous: false, email: 'someone@else.com', created_at: FRESH }, // email changed
        d: { is_anonymous: false, email: good, created_at: STALE },
      },
    });
    await expect(r.cleanup(() => service, () => {})).rejects.toThrow(/3 user/);
    expect(calls).toContain('delete-user:a');
    for (const id of ['b', 'c', 'd']) expect(calls).not.toContain(`delete-user:${id}`);
  });

  it('counts a user that is already gone as already-gone, not cleaned, and not failed', async () => {
    const r = make();
    r.recordUser('g1');
    r.recordUser('g2');
    r.recordUser('u1');
    const { service } = fake({ users: { g1: null }, deleteUserError: { g2: GONE } });
    const res = await r.cleanup(() => service, () => {});
    expect(res).toMatchObject({ users: 1, alreadyGone: 2 });
  });

  it('reports a failed user delete with its id', async () => {
    const r = make();
    r.recordUser('u1');
    const { service } = fake({ deleteUserError: { u1: { message: 'denied', code: '403' } } });
    const { lines, log } = quiet();
    await expect(r.cleanup(() => service, log)).rejects.toThrow(/1 user/);
    expect(lines.join('\n')).toMatch(/u1/);
  });
});

describe('beforeCleanup (I2)', () => {
  it('runs every callback first, isolates throws, and counts them as failures', async () => {
    const r = make();
    const order: string[] = [];
    r.beforeCleanup(async () => {
      order.push('one');
      throw new Error('first broke');
    });
    r.beforeCleanup(async () => void order.push('two'));
    r.recordOrg('o1');
    const { service, calls } = fake();
    const origRpc = service.rpc;
    service.rpc = async (fn, args) => {
      order.push('rpc');
      return origRpc(fn, args);
    };
    const { lines, log } = quiet();
    await expect(r.cleanup(() => service, log)).rejects.toThrow(/1 teardown/);
    expect(order).toEqual(['one', 'two', 'rpc']);
    expect(calls).toContain('rpc:delete_test_org:o1');
    expect(lines.join('\n')).toMatch(/first broke/);
  });

  it('runs even when nothing was recorded and when the key is missing', async () => {
    const r = make();
    let ran = 0;
    r.beforeCleanup(() => void ran++);
    r.recordOrg('o1');
    await r.cleanup(() => null, () => {});
    expect(ran).toBe(1);
    const r2 = make();
    r2.beforeCleanup(() => void ran++);
    await r2.cleanup(() => null, () => {});
    expect(ran).toBe(2);
  });
});
