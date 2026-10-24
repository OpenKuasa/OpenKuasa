import type { SupabaseClient } from '@supabase/supabase-js';
import type { CapResult } from '@/lib/people/capabilities';
import type { PeopleNoteEntityType } from '@/lib/people/agent/scan';

/**
 * The notes Lekiu's agent left once HR approved them (`hr_agent_notes`). Only owners and admins
 * read or delete them (row-level security); nobody writes one directly (the `hr_add_agent_note`
 * RPC does). There is no row marker on the other screens: the notes live on the Agents screen.
 */

export type PeopleNotesContext = { client: SupabaseClient; orgId: string };

export type PeopleAgentNote = {
  id: string;
  entityType: PeopleNoteEntityType;
  entityId: string | null;
  /** The record's own employee; null only for a payroll month. */
  employeeId: string | null;
  /** The employee's name, or `Payroll Oct 2026`. */
  entityLabel: string;
  body: string;
  /** Who approved it, by name or email; null when that person can no longer be read. */
  approvedBy: string | null;
  createdAt: string;
};

/** The newest notes shown on the Agents screen. */
export const NOTES_SHOWN = 50;

const NOTE_COLS = 'id,entity_type,entity_id,employee_id,entity_label,body,created_by,created_at';

type NoteRow = {
  id: string;
  entity_type: PeopleNoteEntityType;
  entity_id: string | null;
  employee_id: string | null;
  entity_label: string;
  body: string;
  created_by: string | null;
  created_at: string;
};

/**
 * The screen a note's record lives on. The Employees screen reads nothing from the address, so
 * its link is the plain screen. Only the absence check writes an employee note, so an employee
 * note goes to Attendance.
 */
export function noteHref(entityType: string): string | null {
  switch (entityType) {
    case 'hr_document':
      return '/people/employees';
    case 'hr_employee':
      return '/people/attendance';
    case 'hr_leave_request':
      return '/people/approve-leave';
    case 'hr_claim':
      return '/people/approve-claims';
    case 'hr_overtime_record':
      return '/people/approve-overtime';
    case 'hr_letter':
      return '/people/letters';
    case 'hr_goal':
      return '/people/scorecard';
    case 'hr_payroll_month':
      return '/people/payroll';
    default:
      return null;
  }
}

/** Names (or emails) of the people who approved, as far as the workspace's profiles say. */
async function approverNames(ctx: PeopleNotesContext, rows: NoteRow[]): Promise<Record<string, string>> {
  const ids = [...new Set(rows.map((r) => r.created_by).filter((id): id is string => !!id))];
  if (ids.length === 0) return {};
  const { data, error } = await ctx.client.from('profiles').select('user_id,full_name,email').in('user_id', ids);
  if (error) {
    console.error('[people/agents] who approved could not be read:', error.code ?? 'unknown');
    return {};
  }
  const names: Record<string, string> = {};
  for (const p of (data ?? []) as { user_id: string; full_name: string | null; email: string | null }[]) {
    const name = p.full_name?.trim() || p.email?.trim();
    if (name) names[p.user_id] = name;
  }
  return names;
}

/** The workspace's newest notes, newest first; null when they could not be read (logged, code only). */
export async function listAgentNotes(ctx: PeopleNotesContext): Promise<PeopleAgentNote[] | null> {
  const { data, error } = await ctx.client
    .from('hr_agent_notes')
    .select(NOTE_COLS)
    .eq('org_id', ctx.orgId)
    .order('created_at', { ascending: false })
    .limit(NOTES_SHOWN);
  if (error) {
    console.error('[people/agents] notes could not be read:', error.code ?? 'unknown');
    return null;
  }
  const rows = (data ?? []) as NoteRow[];
  const names = await approverNames(ctx, rows);
  return rows.map((r) => ({
    id: r.id,
    entityType: r.entity_type,
    entityId: r.entity_id,
    employeeId: r.employee_id,
    entityLabel: r.entity_label,
    body: r.body,
    approvedBy: r.created_by ? (names[r.created_by] ?? null) : null,
    createdAt: r.created_at,
  }));
}

/** Deletes one note of the workspace. Row-level security lets only owners and admins do it. */
export async function deleteAgentNote(ctx: PeopleNotesContext, id: string): Promise<CapResult<null>> {
  const { data, error } = await ctx.client
    .from('hr_agent_notes')
    .delete()
    .eq('org_id', ctx.orgId)
    .eq('id', id)
    .select('id');
  if (error) return { ok: false, error: 'That note could not be deleted. Please try again.' };
  if (!data || data.length === 0) return { ok: false, error: 'That note is already gone, or you may not delete it.' };
  return { ok: true, data: null };
}
