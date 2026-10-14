import type { Lead, LeadStage } from './types';

/**
 * Leads that came in through a lead form, a landing page or the chatbot are
 * kept once, as Kasturi contacts (`crm_contacts`). Jebat reads them from there
 * rather than keeping a copy, so its counts, funnel and AI see them and a
 * contact's status in Kasturi is the stage Jebat shows.
 */

/** The tags the public capture paths put on a contact they create. */
export const CAPTURED_CONTACT_TAGS = ['lead-form', 'chatbot'];

export const CAPTURED_CONTACT_COLUMNS = 'id,first_name,last_name,status,source,created_at';

export type CapturedContactRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  status: string | null;
  source: string | null;
  created_at: string;
};

/** Kasturi status -> Jebat stage. Booked has no contact status. */
const STAGE_OF_STATUS: Record<string, LeadStage> = {
  lead: 'lead',
  contacted: 'contacted',
  qualified: 'qualified',
  customer: 'won',
};

/** A captured contact as a Jebat lead; null for an archived contact, which is no longer worked. */
export function capturedContactToLead(row: CapturedContactRow): Lead | null {
  if (row.status === 'archived') return null;
  const name = [row.first_name, row.last_name].map((part) => part?.trim() ?? '').filter(Boolean).join(' ');
  return {
    id: row.id,
    name: name || 'Unnamed contact',
    channel: 'web',
    stage: STAGE_OF_STATUS[row.status ?? ''] ?? 'lead',
    source: row.source ?? '',
    created_at: row.created_at,
    // It is already in Kasturi, so it is never offered for promotion.
    promoted_contact_id: row.id,
    origin: 'crm',
  };
}

/** The `leads` table's rows and the captured contacts, newest first. */
export function mergeCapturedLeads(leads: Lead[], contacts: CapturedContactRow[]): Lead[] {
  const captured = contacts.map(capturedContactToLead).filter((lead): lead is Lead => lead !== null);
  return [...leads, ...captured].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
}
