import { randomBytes } from 'node:crypto';
import { afterAll } from 'vitest';
import { createClient, type AuthError, type Session, type SupabaseClient, type User } from '@supabase/supabase-js';

// Shared creation + cleanup for tests that run against the LIVE Supabase project.
//
// Every user and every workspace a test file creates goes through here
// and is recorded in a per-file registry (Vitest gives each file its own module
// instance: this relies on `isolate: true`, see vitest.config.mts). When the file
// finishes, `cleanupLive` uses the service-role client to delete exactly the recorded
// workspaces first (through the `delete_test_org` function, which refuses anything that
// is not recent, slugless test debris), then, only if every workspace went, exactly the
// recorded users. Nothing is ever deleted by name, pattern or query: only ids this
// process recorded itself.

/**
 * The address pattern of users this helper signs up, as the SQL regex used by
 * public.delete_test_org (supabase/migrations/20261019100000_delete_test_org.sql).
 * KEEP IN STEP with that file: tests/delete-test-org-schema.test.ts checks it contains
 * this exact string.
 */
export const TEST_EMAIL_SQL_PATTERN = '^qa-[0-9a-f]{12}-[0-9]+@example\\.com$';

type Failure = { message: string; code?: string; status?: number } | null;

/** The slice of the Supabase service client the cleanup touches (and a test can fake). */
export type ServiceLike = {
  rpc(
    fn: 'delete_test_org',
    args: { p_id: string },
  ): PromiseLike<{ data: unknown; error: Failure }>;
  auth: {
    admin: {
      getUserById(id: string): PromiseLike<{
        data: { user: { is_anonymous?: boolean; email?: string; created_at?: string } | null };
        error: Failure;
      }>;
      deleteUser(id: string): PromiseLike<{ error: Failure }>;
    };
  };
};

/** The slice of the service client `createConfirmedTestUser` touches. */
export type AdminLike = {
  auth: {
    admin: {
      createUser(attrs: { email: string; password: string; email_confirm: boolean }): PromiseLike<{
        data: { user: { id: string } | null } | null;
        error: Failure;
      }>;
    };
  };
};

/**
 * What `signInOwner` answers. `error` is always null (a failure throws); it is typed like a sign-in's so a test
 * can check it the way it checks `signInAnon`'s.
 */
export type OwnerSignIn = {
  data: { user: User | null; session: Session | null };
  error: AuthError | null;
  email: string;
  userId: string;
};

export type UserGuard = { kind: 'anonymous' } | { kind: 'signup'; email: string };
export type CleanupResult = {
  skipped: boolean;
  workspaces: number;
  users: number;
  alreadyGone: number;
};

export type RegistryOptions = { startedAt?: number; runToken?: string };

const BATCH = 5;
/** Server and local clocks may differ a little; a user created before this run is far older. */
const CLOCK_SKEW_MS = 60_000;
/** Error codes that mean the delete_test_org migration is not applied (or not granted). */
const NOT_APPLIED = new Set(['PGRST202', '42883', '42501']);

const isGone = (e: Failure) => e !== null && (e.code === 'user_not_found' || e.status === 404);
const describe = (id: string, e: Failure) => (e?.code ? `${id} (${e.code})` : id);

async function inBatches<T>(items: T[], run: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += BATCH) {
    await Promise.all(items.slice(i, i + BATCH).map(run));
  }
}

export function createRegistry(options: RegistryOptions = {}) {
  const startedAt = options.startedAt ?? Date.now();
  const runToken = options.runToken ?? randomBytes(6).toString('hex');
  const orgs = new Set<string>();
  const users = new Map<string, UserGuard>();
  const hooks: Array<() => unknown> = [];
  let emailCounter = 0;

  const recordOrg = (id: string) => void orgs.add(id);
  // Never overwrite an existing record: a later call must not weaken its guard.
  const recordUser = (id: string, guard: UserGuard = { kind: 'anonymous' }) => {
    if (!users.has(id)) users.set(id, guard);
  };

  const createConfirmedTestUser = async (admin: AdminLike | null, client: SupabaseClient, password: string) => {
    if (!admin) {
      throw new Error('createConfirmedTestUser needs SUPABASE_SERVICE_ROLE_KEY (and the project URL) to be set.');
    }
    const email = `qa-${runToken}-${++emailCounter}@example.com`;
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    const id = created.data?.user?.id;
    if (id) recordUser(id, { kind: 'signup', email });
    if (created.error || !id) {
      throw new Error(`creating the test user failed: ${created.error?.message ?? 'no user returned'}`);
    }
    const signedIn = await client.auth.signInWithPassword({ email, password });
    if (signedIn.error || !signedIn.data.session) {
      throw new Error(`the confirmed test user got no session: ${signedIn.error?.message ?? 'no session returned'}`);
    }
    return { ...signedIn, email, userId: id };
  };

  return {
    recordOrg,
    recordUser,
    /** Runs first inside `cleanup`, even when the delete is skipped. A throw counts as a failure. */
    beforeCleanup(fn: () => unknown) {
      hooks.push(fn);
    },

    async signInAnon(client: SupabaseClient) {
      const result = await client.auth.signInAnonymously();
      const id = result.data?.user?.id;
      if (id) recordUser(id, { kind: 'anonymous' });
      return result;
    },
    async createOrg(client: SupabaseClient, orgName: string) {
      const result = await client.rpc('create_org_for_current_user', { org_name: orgName });
      if (typeof result.data === 'string') recordOrg(result.data);
      return result;
    },
    /** The demo workspace is shared: nothing is recorded for it. */
    joinDemo(client: SupabaseClient) {
      return client.rpc('join_demo_org');
    },
    /** Signs up a user with a generated address and records it with that address as its guard. */
    async signUpTestUser(client: SupabaseClient, password: string) {
      const email = `qa-${runToken}-${++emailCounter}@example.com`;
      const result = await client.auth.signUp({ email, password });
      const id = result.data?.user?.id;
      if (id) recordUser(id, { kind: 'signup', email });
      return { ...result, email };
    },
    /**
     * For a test that needs a user who can sign in at once. `signUpTestUser` is a plain sign-up, which returns no
     * session when the project requires email confirmation. This creates the user already confirmed through the
     * service client (same address pattern, same recording), then signs in with the password and insists on a
     * session. The user is recorded before the sign-in so a failure there still gets cleaned up.
     */
    createConfirmedTestUser,
    /**
     * Signs `client` in as a new signed-up account, the only kind that may create a workspace (a demo guest may
     * not: see 20261030131500_demo_guests_cannot_create_workspaces.sql). Same result shape as `signInAnon`, so a
     * test reads `data.user` and `error` from it alike; it throws instead of returning an error. The password is
     * generated here and never needed again. Needs the service key, like `createConfirmedTestUser`.
     */
    async signInOwner(admin: AdminLike | null, client: SupabaseClient): Promise<OwnerSignIn> {
      return createConfirmedTestUser(admin, client, `Qa-${randomBytes(16).toString('hex')}`);
    },

    async cleanup(
      getService: () => ServiceLike | null,
      log: (line: string) => void = (line) => console.error(line),
    ): Promise<CleanupResult> {
      const result: CleanupResult = { skipped: false, workspaces: 0, users: 0, alreadyGone: 0 };

      // 1. Teardown steps that must run whatever else happens.
      const hookErrors: string[] = [];
      for (const fn of hooks) {
        try {
          await fn();
        } catch (e) {
          hookErrors.push(e instanceof Error ? e.message : String(e));
        }
      }
      if (hookErrors.length > 0) {
        log(`[live-workspaces] ${hookErrors.length} teardown step(s) failed: ${hookErrors.join('; ')}`);
      }
      const finish = (orgFailures: number, userFailures: number): CleanupResult => {
        if (hookErrors.length + orgFailures + userFailures > 0) {
          throw new Error(
            `live test cleanup failed (${hookErrors.length} teardown step(s), ${orgFailures} workspace(s), ${userFailures} user(s))`,
          );
        }
        return result;
      };

      if (orgs.size === 0 && users.size === 0) return finish(0, 0);

      const service = getService();
      if (!service) {
        log(
          `[live-workspaces] SUPABASE_SERVICE_ROLE_KEY (or the project URL) is missing: LEFT BEHIND ${orgs.size} workspace(s) and ${users.size} user(s) in the live database. Set the key in .env.local so the tests can clean up after themselves.`,
        );
        result.skipped = true;
        return finish(0, 0);
      }

      // 2. Workspaces first. The first call goes alone so a missing migration is noticed once.
      const orgIds = [...orgs];
      const orgFailed: string[] = [];
      let notApplied = false;
      const deleteOrg = async (id: string) => {
        try {
          const res = await service.rpc('delete_test_org', { p_id: id });
          if (res.error) {
            if (res.error.code && NOT_APPLIED.has(res.error.code)) notApplied = true;
            orgFailed.push(describe(id, res.error));
          } else if (res.data === true) {
            result.workspaces += 1;
          } else {
            orgFailed.push(`${id} (not deleted: not eligible or already gone)`);
          }
        } catch (e) {
          orgFailed.push(`${id} (${e instanceof Error ? e.message : 'threw'})`);
        }
      };
      if (orgIds.length > 0) {
        await deleteOrg(orgIds[0]);
        if (notApplied) {
          log(
            `[live-workspaces] public.delete_test_org is not applied (or not granted to service_role): LEFT BEHIND ${orgs.size} workspace(s) and ${users.size} user(s). Apply supabase/migrations/20261019100000_delete_test_org.sql.`,
          );
          result.skipped = true;
          result.workspaces = 0;
          return finish(0, 0);
        }
        await inBatches(orgIds.slice(1), deleteOrg);
      }

      // 3. Never delete a user whose workspace survived.
      if (orgFailed.length > 0) {
        log(`[live-workspaces] cleanup FAILED for ${orgFailed.length} workspace(s): ${orgFailed.join(', ')}`);
        log(
          `[live-workspaces] ${users.size} user(s) NOT deleted because a workspace survived: they are left behind.`,
        );
        return finish(orgFailed.length, 0);
      }

      // 4. Users, each only if it is demonstrably one this run created.
      const userFailed: string[] = [];
      const deleteUser = async (id: string, guard: UserGuard) => {
        try {
          const found = await service.auth.admin.getUserById(id);
          if (found.error) {
            if (isGone(found.error)) result.alreadyGone += 1;
            else userFailed.push(describe(id, found.error));
            return;
          }
          const user = found.data.user;
          if (!user) {
            result.alreadyGone += 1;
            return;
          }
          const created = user.created_at ? Date.parse(user.created_at) : NaN;
          const fresh = Number.isFinite(created) && created >= startedAt - CLOCK_SKEW_MS;
          const allowed =
            guard.kind === 'anonymous'
              ? user.is_anonymous === true && fresh
              : user.email === guard.email && guard.email.includes(runToken) && fresh;
          if (!allowed) {
            userFailed.push(`${id} (refused: not a user this run created)`);
            return;
          }
          const del = await service.auth.admin.deleteUser(id);
          if (del.error) {
            if (isGone(del.error)) result.alreadyGone += 1;
            else userFailed.push(describe(id, del.error));
          } else {
            result.users += 1;
          }
        } catch (e) {
          userFailed.push(`${id} (${e instanceof Error ? e.message : 'threw'})`);
        }
      };
      await inBatches([...users], ([id, guard]) => deleteUser(id, guard));
      if (userFailed.length > 0) {
        log(`[live-workspaces] cleanup FAILED for ${userFailed.length} user(s): ${userFailed.join(', ')}`);
      }
      return finish(0, userFailed.length);
    },
  };
}

const registry = createRegistry();

function serviceClient(): ServiceLike | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  }) as unknown as ServiceLike;
}

/** Delete everything this file recorded. Registered automatically as an `afterAll`. */
export function cleanupLive(): Promise<CleanupResult> {
  return registry.cleanup(serviceClient);
}

afterAll(cleanupLive, 120_000);

// --- creation helpers (used by the live test files) ---

/** A fresh, signed-out client with the anon key and no persisted session. */
export function liveClient(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

/** `client.auth.signInAnonymously()`, recording the new user for cleanup. */
export const signInAnon = (client: SupabaseClient) => registry.signInAnon(client);
/** RPC `create_org_for_current_user`, recording the new workspace for cleanup. */
export const createOrg = (client: SupabaseClient, orgName: string) =>
  registry.createOrg(client, orgName);
/** RPC `join_demo_org`. The demo workspace is shared and is never recorded or deleted. */
export const joinDemo = (client: SupabaseClient) => registry.joinDemo(client);
/** Sign up an email user with a generated test address; cleanup deletes it. */
export const signUpTestUser = (client: SupabaseClient, password: string) =>
  registry.signUpTestUser(client, password);
/**
 * A confirmed email user who can sign in at once (see `createConfirmedTestUser` on the registry); cleanup
 * deletes it. Needs the service key. `signUpTestUser` is unchanged for its other callers.
 */
export const createConfirmedTestUser = (client: SupabaseClient, password: string) =>
  registry.createConfirmedTestUser(serviceClient() as unknown as AdminLike | null, client, password);
/**
 * Sign `client` in as a new signed-up account that may create a workspace (see `signInOwner` on the registry);
 * cleanup deletes it. Needs the service key. Use `signInAnon` only for a demo guest or a user in no workspace.
 */
export const signInOwner = (client: SupabaseClient) =>
  registry.signInOwner(serviceClient() as unknown as AdminLike | null, client);
/**
 * Register a teardown step that runs first in the file's cleanup, even when the delete is
 * skipped (missing key / migration) and even if the file's own hooks failed.
 */
export const beforeCleanup = (fn: () => unknown) => registry.beforeCleanup(fn);

/** A new anonymous, signed-in client. */
export async function anonClient(): Promise<{ client: SupabaseClient; userId: string }> {
  const client = liveClient();
  const { data, error } = await signInAnon(client);
  if (error || !data.user) throw new Error(`anonymous sign-in failed: ${error?.message}`);
  return { client, userId: data.user.id };
}

/** A new signed-up, signed-in client that owns a new workspace. */
export async function ownerClient(
  orgName: string,
): Promise<{ client: SupabaseClient; userId: string; orgId: string }> {
  const client = liveClient();
  const { userId } = await signInOwner(client);
  const { data, error } = await createOrg(client, orgName);
  if (error || typeof data !== 'string') throw new Error(`create_org failed: ${error?.message}`);
  return { client, userId, orgId: data };
}

/** A new anonymous, signed-in client that has joined the demo workspace. */
export async function demoClient(): Promise<{
  client: SupabaseClient;
  userId: string;
  orgId: string;
}> {
  const { client, userId } = await anonClient();
  const { data, error } = await joinDemo(client);
  if (error || typeof data !== 'string') throw new Error(`join_demo_org failed: ${error?.message}`);
  return { client, userId, orgId: data };
}
