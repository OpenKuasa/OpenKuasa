import { noteCountsFor, type NoteCounts } from '@/lib/hire/agent/notes';
import type { HireNoteEntityType } from '@/lib/hire/agent/scan';
import { createClient } from '@/lib/supabase/server';

/**
 * The agent's note counts for the rows a Lekir list screen just loaded (only those ids), for the
 * row marker. Undefined, so no marker shows, in the demo workspace, with nothing loaded, or when
 * the counts could not be read (logged). Never throws: a list never fails over its markers.
 */
export async function hireNoteCounts(
  viewer: { orgId: string; isDemo: boolean },
  entityType: HireNoteEntityType,
  ids: readonly string[] | undefined,
): Promise<NoteCounts | undefined> {
  if (viewer.isDemo || !viewer.orgId || !ids || ids.length === 0) return undefined;
  try {
    return (await noteCountsFor({ client: await createClient(), orgId: viewer.orgId }, entityType, ids)) ?? undefined;
  } catch {
    console.error('[hire] agent note counts could not be read');
    return undefined;
  }
}
