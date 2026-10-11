import { afterAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Shared creation + cleanup for tests that run against the LIVE Supabase project.
//
// Every anonymous user and every workspace a test file creates goes through here
// and is recorded in a per-file registry (Vitest gives each file its own module
// instance). When the file finishes, `cleanupLive` uses the service-role client to
// delete exactly the recorded workspaces first (the cascade removes product rows and
// memberships), then exactly the recorded users. Nothing is ever deleted by name,
// pattern or query: only ids this process recorded itself.

type Row = { slug: string | null } | null;
type Failure = { message: string } | null;

/** The slice of the Supabase service client the cleanup touches (and a test can fake). */
export type ServiceLike = {
  from(table: 'orgs'): {
    select(columns: 'slug'): {
      eq(
        column: 'id',
        value: string,
      ): { maybeSingle(): PromiseLike<{ data: Row; error: Failure }> };
    };
    delete(): { eq(column: 'id', value: string): PromiseLike<{ error: Failure }> };
  };
  auth: {
    admin: {
      getUserById(
        id: string,
      ): PromiseLike<{ data: { user: { is_anonymous?: boolean } | null }; error: Failure }>;
      deleteUser(id: string): PromiseLike<{ error: Failure }>;
    };
  };
};

export type CleanupResult = { skipped: boolean; workspaces: number; users: number };

export type Registry = {
  recordOrg(id: string): void;
  recordUser(id: string, via?: 'anonymous' | 'signup'): void;
  cleanup(service: ServiceLike | null, log?: (line: string) => void): Promise<CleanupResult>;
};

export function createRegistry(): Registry {
  const orgs = new Set<string>();
  const users = new Map<string, 'anonymous' | 'signup'>();

  return {
    recordOrg(id) {
      orgs.add(id);
    },
    recordUser(id, via = 'anonymous') {
      users.set(id, via);
    },
    async cleanup(service, log = (line) => console.error(line)) {
      if (orgs.size === 0 && users.size === 0) return { skipped: false, workspaces: 0, users: 0 };
      if (!service) {
        log(
          `[live-workspaces] SUPABASE_SERVICE_ROLE_KEY (or the project URL) is missing: LEFT BEHIND ${orgs.size} workspace(s) and ${users.size} user(s) in the live database. Set the key in .env.local so the tests can clean up after themselves.`,
        );
        return { skipped: true, workspaces: 0, users: 0 };
      }

      let orgFailures = 0;
      let userFailures = 0;

      // Workspaces first: orgs have no owner column, so deleting a user alone would orphan them.
      for (const id of orgs) {
        try {
          const found = await service.from('orgs').select('slug').eq('id', id).maybeSingle();
          if (found.error) {
            orgFailures += 1;
            continue;
          }
          if (found.data === null) continue; // already gone
          if (found.data.slug !== null) {
            orgFailures += 1; // never delete the demo (or any slugged, public) workspace
            continue;
          }
          const del = await service.from('orgs').delete().eq('id', id);
          if (del.error) orgFailures += 1;
        } catch {
          orgFailures += 1;
        }
      }

      for (const [id, via] of users) {
        try {
          const found = await service.auth.admin.getUserById(id);
          if (found.error) {
            userFailures += 1;
            continue;
          }
          const user = found.data.user;
          if (!user) continue; // already gone
          if (via === 'anonymous' && user.is_anonymous !== true) {
            userFailures += 1; // recorded as anonymous but is not: refuse
            continue;
          }
          const del = await service.auth.admin.deleteUser(id);
          if (del.error) userFailures += 1;
        } catch {
          userFailures += 1;
        }
      }

      if (orgFailures > 0) {
        log(`[live-workspaces] cleanup FAILED for ${orgFailures} workspace(s): rows were left behind.`);
      }
      if (userFailures > 0) {
        log(`[live-workspaces] cleanup FAILED for ${userFailures} user(s): accounts were left behind.`);
      }
      if (orgFailures + userFailures > 0) {
        throw new Error(
          `live test cleanup failed (${orgFailures} workspace(s), ${userFailures} user(s))`,
        );
      }
      return { skipped: false, workspaces: orgs.size, users: users.size };
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
export async function cleanupLive(): Promise<CleanupResult> {
  return registry.cleanup(serviceClient());
}

afterAll(cleanupLive);

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
export async function signInAnon(client: SupabaseClient) {
  const result = await client.auth.signInAnonymously();
  const id = result.data?.user?.id;
  if (id) registry.recordUser(id, 'anonymous');
  return result;
}

/** RPC `create_org_for_current_user`, recording the new workspace for cleanup. */
export async function createOrg(client: SupabaseClient, orgName: string) {
  const result = await client.rpc('create_org_for_current_user', { org_name: orgName });
  if (typeof result.data === 'string') registry.recordOrg(result.data);
  return result;
}

/** RPC `join_demo_org`. The demo workspace is shared and is never recorded or deleted. */
export function joinDemo(client: SupabaseClient) {
  return client.rpc('join_demo_org');
}

/** Record a user a test created through email sign-up (so cleanup may delete it). */
export function recordSignedUpUser(id: string): void {
  registry.recordUser(id, 'signup');
}

/** A new anonymous, signed-in client. */
export async function anonClient(): Promise<{ client: SupabaseClient; userId: string }> {
  const client = liveClient();
  const { data, error } = await signInAnon(client);
  if (error || !data.user) throw new Error(`anonymous sign-in failed: ${error?.message}`);
  return { client, userId: data.user.id };
}

/** A new anonymous, signed-in client that owns a new workspace. */
export async function ownerClient(
  orgName: string,
): Promise<{ client: SupabaseClient; userId: string; orgId: string }> {
  const { client, userId } = await anonClient();
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
