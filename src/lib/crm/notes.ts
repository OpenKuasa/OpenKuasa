import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { errorCodeOf } from '@/lib/ai/call-log';

/** A note on a deal or contact, as the pop-up lists it. */
export type RecordNote = {
  id: string;
  body: string;
  /** True for a note the Kasturi agent proposed and a person approved. */
  fromAgent: boolean;
  /** ISO timestamp. */
  createdAt: string;
};

/** Which record's notes: a deal's or a contact's. */
export type NoteTarget = { dealId: string } | { contactId: string };

/** How many notes a pop-up lists, newest first. */
export const NOTES_SHOWN = 20;

/** `?open=<id>` on /crm/deals and /crm/contacts opens that record's pop-up. */
export const OPEN_PARAM = 'open';

type CrmNoteRow = {
  id: string;
  body: string;
  source: string | null;
  created_at: string;
};

const idSchema = z.string().uuid();

/** The id in `?open=`, or null when it is missing or is not a uuid. */
export function readOpenParam(value: string | string[] | undefined): string | null {
  const parsed = idSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function mapCrmNote(row: CrmNoteRow): RecordNote {
  return {
    id: row.id,
    body: row.body,
    fromAgent: row.source === 'agent',
    createdAt: row.created_at,
  };
}

/** The newest notes on one deal or contact of the workspace. Throws when the read fails. */
export async function listRecordNotes(
  client: SupabaseClient,
  orgId: string,
  target: NoteTarget,
): Promise<RecordNote[]> {
  const [column, id] = 'dealId' in target ? (['deal_id', target.dealId] as const) : (['contact_id', target.contactId] as const);

  const { data, error } = await client
    .from('crm_notes')
    .select('id,body,source,created_at')
    .eq('org_id', orgId)
    .eq(column, id)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(NOTES_SHOWN);

  if (error) throw error;
  return ((data ?? []) as unknown as CrmNoteRow[]).map(mapCrmNote);
}

/**
 * The notes for a pop-up, or null when they cannot be had (a bad id, or a read
 * that failed, for instance before the notes migration has reached a database).
 * The pop-up then shows no notes section; it never breaks.
 */
export async function loadRecordNotes(
  client: SupabaseClient,
  orgId: string,
  target: NoteTarget,
): Promise<RecordNote[] | null> {
  const id = 'dealId' in target ? target.dealId : target.contactId;
  if (!idSchema.safeParse(id).success) return null;
  try {
    return await listRecordNotes(client, orgId, target);
  } catch (error) {
    console.error('[crm/notes] could not load notes', errorCodeOf(error));
    return null;
  }
}
