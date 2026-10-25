import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PushDevice } from '@/components/account/push-device-card';

/** "3 Oct 2026" in the person's timezone. Formatted here so server and browser agree. */
export function formatAddedDate(iso: string, timeZone: string): string {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return '';
  const format = (tz: string) =>
    new Intl.DateTimeFormat('en-MY', { day: 'numeric', month: 'short', year: 'numeric', timeZone: tz }).format(when);
  try {
    return format(timeZone);
  } catch {
    return format('Asia/Kuala_Lumpur');
  }
}

/**
 * The signed-in person's devices with push on, newest first. Row-level security limits
 * the read to their own rows. A failed read shows an empty list rather than breaking the page.
 */
export async function listPushDevices(supabase: SupabaseClient, timeZone: string): Promise<PushDevice[]> {
  const { data, error } = await supabase
    .from('push_subscriptions')
    .select('id, endpoint, device_label, created_at')
    .order('created_at', { ascending: false });
  if (error || !data) return [];
  return data.map((row) => ({
    id: String(row.id),
    endpoint: String(row.endpoint),
    label: typeof row.device_label === 'string' && row.device_label ? row.device_label : null,
    added: formatAddedDate(String(row.created_at), timeZone),
  }));
}
