import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { serviceClient } from './service';

/**
 * The client the public pages write through: the server as itself. The
 * functions a visitor's post ends in (`submit_public_form`,
 * `submit_public_application`) are granted to the service role alone, so a
 * post can only arrive through a server action, where the per-client limit
 * and the honeypot are.
 *
 * One case falls back to `fallback` (the client that carries no session, as
 * these calls were made before): the database refusing the service role with
 * "permission denied" (42501), which is what it answers until the migration
 * that moves the grant has been applied, and a host with no service key. That
 * keeps a release that is live before its migration working. Once the
 * migration is applied the fallback is refused in turn and the post fails as
 * any failed call does.
 *
 * Nothing else is retried, on purpose: a call that timed out or broke on the
 * way back may have been kept, and sending it again would record it twice.
 */
export function serverWriteClient(fallback: () => SupabaseClient): SupabaseClient {
  const rpc = async (fn: string, args?: Record<string, unknown>) => {
    let service: SupabaseClient;
    try {
      service = serviceClient();
    } catch {
      console.error('[server-writer] the service role is not configured; calling', fn, 'without it');
      return fallback().rpc(fn, args);
    }
    const result = await service.rpc(fn, args);
    if (result.error?.code === '42501') return fallback().rpc(fn, args);
    return result;
  };
  return { rpc } as unknown as SupabaseClient;
}
