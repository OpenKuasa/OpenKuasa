import type { SupabaseClient } from '@supabase/supabase-js';
import type { AgentProposal } from '@/lib/agents/types';
import { collectNames, kindOfTool, type KnownNames, type ToolResult } from '@/lib/chat/change-titles';

/** Where each kind of row a reach proposal points at lives, and the lookup whose rows name it the way a chat card does. */
const SOURCES = {
  lead: { table: 'leads', columns: 'id,name', tool: 'listContacts' },
  appointment: { table: 'appointments', columns: 'id,contact_name,kind,scheduled_at', tool: 'getUpcomingAppointments' },
  form: { table: 'forms', columns: 'id,name', tool: 'listForms' },
} as const;

/**
 * The names of the rows these proposals are about (`kind:id`), so their cards say which lead or appointment instead
 * of an id. Only the ids the proposals carry are read. Display only: an id that cannot be read stays unnamed.
 */
export async function proposalNames(client: SupabaseClient, orgId: string, proposals: AgentProposal[]): Promise<KnownNames> {
  const ids: Record<keyof typeof SOURCES, Set<string>> = { lead: new Set(), appointment: new Set(), form: new Set() };
  for (const p of proposals) {
    const kind = kindOfTool(p.action);
    const id = (p.input as { id?: unknown } | null)?.id;
    if (kind && Object.hasOwn(ids, kind) && typeof id === 'string') ids[kind as keyof typeof SOURCES].add(id);
  }
  const results = await Promise.all(
    (Object.keys(SOURCES) as (keyof typeof SOURCES)[])
      .filter((kind) => ids[kind].size > 0)
      .map(async (kind): Promise<ToolResult | null> => {
        const { table, columns, tool } = SOURCES[kind];
        const { data, error } = await client.from(table).select(columns).eq('org_id', orgId).in('id', [...ids[kind]]);
        return error || !data ? null : { tool, output: data };
      }),
  );
  return collectNames(results.filter((r): r is ToolResult => r !== null));
}
