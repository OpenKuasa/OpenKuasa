/**
 * GET /api/crm/contacts/export — the workspace's contacts as a CSV file.
 *
 * For owners and admins only: it is every contact the workspace has, in one
 * file. The contacts are read as the caller, so the database's own rules
 * decide what they may see; the role check here is the stricter rule on top.
 */

import { errorCodeOf } from '@/lib/ai/call-log';
import { getCurrentOrg } from '@/lib/auth/current-org';
import { hasSupabaseEnv } from '@/lib/auth/viewer';
import { contactsCsv, listContactsForExport } from '@/lib/crm/settings';
import { klDay } from '@/lib/crm/deal-stats';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

const refuse = (status: number, error: string) => Response.json({ error }, { status });

export async function GET() {
  if (!hasSupabaseEnv()) return refuse(404, 'There is nothing to export.');

  const supabase = await createClient();
  let org: Awaited<ReturnType<typeof getCurrentOrg>>;
  try {
    org = await getCurrentOrg(supabase);
  } catch (error) {
    console.error('[crm/contacts/export] could not read the workspace:', errorCodeOf(error));
    return refuse(503, 'The export is unavailable right now. Please try again.');
  }
  if (!org) return refuse(401, 'Please sign in.');
  if (org.role !== 'owner' && org.role !== 'admin') {
    return refuse(403, 'Only an owner or admin can export the workspace’s contacts.');
  }

  let csv: string;
  let complete: boolean;
  try {
    const read = await listContactsForExport(supabase, org.orgId);
    csv = contactsCsv(read.contacts);
    complete = read.complete;
  } catch (error) {
    // The code only: a database message can quote a contact's details.
    console.error('[crm/contacts/export] could not read the contacts:', errorCodeOf(error));
    return refuse(503, 'The export is unavailable right now. Please try again.');
  }

  // The byte-order mark makes a spreadsheet read names with accents correctly.
  return new Response(`\uFEFF${csv}`, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="contacts-${klDay(new Date())}.csv"`,
      'Cache-Control': 'no-store',
      // False when the workspace has more contacts than one file holds.
      'X-Export-Complete': String(complete),
    },
  });
}
