import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Which client the live tests call the public write functions with
 * (`submit_public_form`, `submit_public_application`, `record_form_view`).
 *
 * Until 20261101091500_rate_limits.sql is applied to the database under test,
 * a signed-out visitor may call them, as the app once did. After it, only the
 * server may. A live test file asks here once and uses what it is given, so
 * the same file passes against a database on either side of that migration.
 */
export type PublicWriter = {
  /** The client to call the write functions with. */
  writer: SupabaseClient;
  /** True when the functions are the server's alone (the migration is applied). */
  serverOnly: boolean;
};

export const hasServiceKey = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY,
);

/** The server's own client: no session kept, the service key. */
export const liveServer = (): SupabaseClient =>
  createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

/** PostgREST's code for "there is no such function". */
const NO_SUCH_FUNCTION = 'PGRST202';

/** True when the attempt counter exists, which is to say the migration has been applied. */
export async function rateLimitsApplied(server: SupabaseClient): Promise<boolean> {
  // An empty list is refused by the function itself; only a missing function answers PGRST202.
  const { error } = await server.rpc('consume_rate_limits', { p_checks: [] });
  return error?.code !== NO_SUCH_FUNCTION;
}

export async function publicWriter(visitor: SupabaseClient): Promise<PublicWriter> {
  if (!hasServiceKey) {
    console.warn(
      '[public-writer] SUPABASE_SERVICE_ROLE_KEY is not set: calling the public write functions as a visitor, which a database with the rate limits migration refuses.',
    );
    return { writer: visitor, serverOnly: false };
  }
  const server = liveServer();
  return (await rateLimitsApplied(server))
    ? { writer: server, serverOnly: true }
    : { writer: visitor, serverOnly: false };
}
