import type { FinanceNoteEntityType } from '@/lib/finance/agent/scan';
import type { FinanceWriteContext, FinResult } from '@/lib/finance/result';

/**
 * The notes Bendahara's agent left once someone approved them (`finance_agent_notes`). Members read
 * them; writers may delete one; nobody writes one directly (the `finance_add_agent_note` RPC does).
 */

export type FinanceAgentNote = {
  id: string;
  entityType: FinanceNoteEntityType;
  entityId: string | null;
  entityLabel: string;
  body: string;
  /** Who approved it, by name or email; null when that person can no longer be read. */
  approvedBy: string | null;
  createdAt: string;
};

/** How many notes a document has, and the newest one's text (the row marker's tooltip). */
export type NoteCount = { count: number; latest: string };
export type NoteCounts = Record<string, NoteCount>;

/** The newest notes shown on the Agents screen. */
export const NOTES_SHOWN = 50;
/** Ids per `in` filter, so a long list never makes an overlong request. */
const IDS_PER_READ = 200;

const NOTE_COLS = 'id,entity_type,entity_id,entity_label,body,created_by,created_at';

type NoteRow = {
  id: string;
  entity_type: FinanceNoteEntityType;
  entity_id: string | null;
  entity_label: string;
  body: string;
  created_by: string | null;
  created_at: string;
};

/**
 * The screen a note's document lives on. None of these screens reads a search from the address
 * (their search box starts empty), so the link is the plain screen.
 */
export function noteHref(entityType: string): string | null {
  switch (entityType) {
    case 'finance_invoice':
      return '/finance/invoices';
    case 'finance_supplier_bill':
      return '/finance/supplier-bills';
    case 'finance_expense':
      return '/finance/expenses';
    case 'finance_quotation':
      return '/finance/quotations';
    case 'finance_bank_account':
      return '/finance/banking';
    case 'finance_sst_period':
      return '/finance/sst-report';
    default:
      return null;
  }
}

/** Names (or emails) of the people who approved, as far as the workspace's profiles say. */
async function approverNames(ctx: FinanceWriteContext, rows: NoteRow[]): Promise<Record<string, string>> {
  const ids = [...new Set(rows.map((r) => r.created_by).filter((id): id is string => !!id))];
  if (ids.length === 0) return {};
  const { data, error } = await ctx.client.from('profiles').select('user_id,full_name,email').in('user_id', ids);
  if (error) {
    console.error('[finance/agents] who approved could not be read:', error.code ?? 'unknown');
    return {};
  }
  const names: Record<string, string> = {};
  for (const p of (data ?? []) as { user_id: string; full_name: string | null; email: string | null }[]) {
    const name = p.full_name?.trim() || p.email?.trim();
    if (name) names[p.user_id] = name;
  }
  return names;
}

/** The workspace's newest notes, newest first; null when they could not be read (logged). */
export async function listAgentNotes(ctx: FinanceWriteContext): Promise<FinanceAgentNote[] | null> {
  const { data, error } = await ctx.client
    .from('finance_agent_notes')
    .select(NOTE_COLS)
    .eq('org_id', ctx.orgId)
    .order('created_at', { ascending: false })
    .limit(NOTES_SHOWN);
  if (error) {
    console.error('[finance/agents] notes could not be read:', error.code ?? 'unknown');
    return null;
  }
  const rows = (data ?? []) as NoteRow[];
  const names = await approverNames(ctx, rows);
  return rows.map((r) => ({
    id: r.id,
    entityType: r.entity_type,
    entityId: r.entity_id,
    entityLabel: r.entity_label,
    body: r.body,
    approvedBy: r.created_by ? (names[r.created_by] ?? null) : null,
    createdAt: r.created_at,
  }));
}

/** Deletes one note of the workspace. Row-level security lets only its writers do it. */
export async function deleteAgentNote(ctx: FinanceWriteContext, id: string): Promise<FinResult<null>> {
  const { data, error } = await ctx.client
    .from('finance_agent_notes')
    .delete()
    .eq('org_id', ctx.orgId)
    .eq('id', id)
    .select('id');
  if (error) return { ok: false, error: 'That note could not be deleted. Please try again.' };
  if (!data || data.length === 0) return { ok: false, error: 'That note is already gone, or you may not delete it.' };
  return { ok: true, data: null };
}

/**
 * Note counts for the documents a list screen has loaded, by document id, with the newest note's text.
 * Only those ids are read. Null when they could not be read (logged): the screen then shows no marker.
 */
export async function noteCountsFor(
  ctx: FinanceWriteContext,
  entityType: FinanceNoteEntityType,
  ids: readonly string[],
): Promise<NoteCounts | null> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return {};
  try {
    const chunks: string[][] = [];
    for (let i = 0; i < unique.length; i += IDS_PER_READ) chunks.push(unique.slice(i, i + IDS_PER_READ));
    const results = await Promise.all(
      chunks.map((chunk) =>
        ctx.client
          .from('finance_agent_notes')
          .select('entity_id,body,created_at')
          .eq('org_id', ctx.orgId)
          .eq('entity_type', entityType)
          .in('entity_id', chunk)
          .order('created_at', { ascending: false }),
      ),
    );
    const failed = results.find((r) => r.error);
    if (failed) {
      console.error('[finance] agent note counts could not be read:', failed.error?.code ?? 'unknown');
      return null;
    }
    const rows = results
      .flatMap((r) => (r.data ?? []) as { entity_id: string | null; body: string; created_at: string }[])
      .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
    const counts: NoteCounts = {};
    for (const row of rows) {
      if (!row.entity_id) continue;
      const seen = counts[row.entity_id];
      if (seen) seen.count += 1;
      else counts[row.entity_id] = { count: 1, latest: row.body };
    }
    return counts;
  } catch (error) {
    console.error('[finance] agent note counts could not be read:', (error as { code?: string } | null)?.code ?? 'unknown');
    return null;
  }
}
