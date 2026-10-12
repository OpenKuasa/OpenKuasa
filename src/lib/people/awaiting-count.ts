import type { SupabaseClient } from '@supabase/supabase-js';
import { awaitingTotal, safeCount } from './documents-screens';

/**
 * How many documents and issued letters of the signed-in person's own await their acknowledgement: the figure on
 * the My Documents navigation badge. It runs on every Lekiu page load, so it reads only what the count needs
 * (their employee id, then two head-only counts) and never throws: any failure reads as 0, and a log line carries
 * the database's code and nothing else. Their own rows only: an owner who is also an employee must not be counted
 * everyone's. A letter counts only once issued, so a draft is never a number.
 */
export async function awaitingAcknowledgementCount(
  ctx: { client: SupabaseClient; orgId: string },
  userId: string,
): Promise<number> {
  try {
    const { client, orgId } = ctx;
    const employee = await client
      .from('hr_employees')
      .select('id')
      .eq('org_id', orgId)
      .eq('user_id', userId)
      .maybeSingle();
    if (employee.error) {
      console.error('[people-layout] awaiting count failed:', employee.error.code ?? 'no-code');
      return 0;
    }
    const employeeId = (employee.data as { id?: unknown } | null)?.id;
    if (typeof employeeId !== 'string') return 0;

    const count = async (table: 'hr_documents' | 'hr_letters'): Promise<number> => {
      try {
        let query = client
          .from(table)
          .select('id', { count: 'exact', head: true })
          .eq('org_id', orgId)
          .eq('employee_id', employeeId)
          .eq('ack_requested', true)
          .is('acknowledged_at', null);
        if (table === 'hr_letters') query = query.eq('status', 'issued');
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
