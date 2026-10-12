import type { SupabaseClient } from '@supabase/supabase-js';
import { awaitingTotal, safeCount } from './documents-screens';

/**
 * How many documents and issued letters of the signed-in person's own await their acknowledgement: the figure on
 * the My Documents navigation badge. It runs on every Lekiu page load, so it reads only what the count needs
 * (two head-only counts in parallel, each joined to their own employee row) and never throws: any failure reads as 0, and a log line carries
 * the database's code and nothing else. Their own rows only: an owner who is also an employee must not be counted
 * everyone's. A letter counts only once issued, so a draft is never a number.
 */
export async function awaitingAcknowledgementCount(
  ctx: { client: SupabaseClient; orgId: string },
  userId: string,
): Promise<number> {
  try {
    const { client, orgId } = ctx;
    // The inner embed keeps only rows whose employee is the signed-in user's own (none when they have no record).
    // The foreign key is named, as the provider names every embed of hr_employees.
    const count = async (table: 'hr_documents' | 'hr_letters'): Promise<number> => {
      try {
        let query = client
          .from(table)
          .select(`id, hr_employees!${table}_employee_id_org_id_fkey!inner(user_id)`, { count: 'exact', head: true })
          .eq('org_id', orgId)
          .eq('hr_employees.user_id', userId)
          .eq('ack_requested', true)
          .is('acknowledged_at', null);
        // A document counts only when HR added it (the employee's own uploads never ask); a letter only once issued.
        query = table === 'hr_letters' ? query.eq('status', 'issued') : query.eq('source', 'hr');
        const { count: n, error } = await query;
        if (error) {
          console.error('[people-layout] awaiting count failed:', error.code ?? 'no-code');
          return 0;
        }
        return safeCount(n);
      } catch (error) {
        console.error('[people-layout] awaiting count failed:', error instanceof Error ? error.name : 'error');
        return 0;
      }
    };
    const [documents, letters] = await Promise.all([count('hr_documents'), count('hr_letters')]);
    return awaitingTotal(documents, letters);
  } catch (error) {
    console.error('[people-layout] awaiting count failed:', error instanceof Error ? error.name : 'error');
    return 0;
  }
}
