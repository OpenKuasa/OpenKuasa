import type { SupabaseClient } from '@supabase/supabase-js';
import type { Lead, Appointment } from '@/lib/reach/types';
import { approvalDetail, approvalTitle, type ItemKind } from '@/lib/chat/change-titles';
import { isAllowedAction, ALLOWED_ACTIONS } from '@/lib/agents/apply-proposal';
import { suggestProposals } from '@/lib/agents/openrouter-media';

const MAX_PROPOSALS = 5;

export type Candidate = {
  action: string;
  input: unknown;
  title: string;
  detail: string | null;
  dedupeKey: string;
};

/** Deterministic: the opportunities worth proposing from this week's data. */
export function opportunityScan(leads: Lead[], appts: Appointment[], now: Date): Candidate[] {
  const nameOf = (id: unknown, kind?: ItemKind): string | null =>
    kind === 'lead' && typeof id === 'string' ? (leads.find((l) => l.id === id)?.name ?? null) : null;
  const make = (action: string, input: unknown, dedupeKey: string): Candidate => ({
    action,
    input,
    title: approvalTitle(action, input, nameOf),
    detail: approvalDetail(action, input),
    dedupeKey,
  });
  const upcomingByName = new Set(
    appts.filter((a) => new Date(a.scheduled_at) > now).map((a) => a.contact_name),
  );
  const out: Candidate[] = [];
  for (const l of leads) {
    if (l.stage === 'won' && !l.promoted_contact_id) {
      out.push(make('promoteLeadToContact', { id: l.id }, `promote:${l.id}`));
    }
    if ((l.stage === 'qualified' || l.stage === 'booked') && !upcomingByName.has(l.name)) {
      const when = new Date(now.getTime() + 3 * 24 * 3600_000);
      when.setUTCHours(9, 0, 0, 0);
      out.push(
        make(
          'createAppointment',
          {
            contact_name: l.name,
            kind: 'Follow-up call',
            scheduled_at: when.toISOString(),
            via: 'Phone',
            status: 'scheduled',
          },
          `appt:${l.id}`,
        ),
      );
    }
  }
  return out;
}

/**
 * Proposes changes for one run. The LLM only SELECTS from the deterministic
 * candidates; the server re-validates every kept candidate's input against the
 * capability schema + the allow-list, de-dupes against pending proposals, caps the
 * count, and inserts. Returns how many were queued and the LLM cost.
 */
export async function proposeChanges(
  service: SupabaseClient,
  orgId: string,
  runId: string,
  apiKey: string,
  reach: { leads: Lead[]; appts: Appointment[]; context: string },
  maxCost: number,
  costSoFar: number,
): Promise<{ proposed: number; cost_cents: number }> {
  if (costSoFar >= maxCost) return { proposed: 0, cost_cents: 0 };
  const candidates = opportunityScan(reach.leads, reach.appts, new Date());
  if (candidates.length === 0) return { proposed: 0, cost_cents: 0 };

  const { keep, cost_cents } = await suggestProposals(
    apiKey,
    reach.context,
    candidates.map((c, index) => ({ index, title: c.title })),
  );

  // Existing pending proposals for this org, to de-dupe against.
  const { data: existing } = await service
    .from('agent_proposals')
    .select('action, input')
    .eq('org_id', orgId)
    .eq('status', 'pending');
  const keyOf = (action: string, input: unknown) => `${action}:${JSON.stringify(input)}`;
  const pendingKeys = new Set(
    (existing ?? []).map((r) => keyOf((r as { action: string }).action, (r as { input: unknown }).input)),
  );

  let proposed = 0;
  for (const sel of keep) {
    if (proposed >= MAX_PROPOSALS) break;
    const c = candidates[sel.index];
    if (!c || !isAllowedAction(c.action)) continue; // tampered / off-list selection
    if (!ALLOWED_ACTIONS[c.action].schema.safeParse(c.input).success) continue; // re-validate input
    if (pendingKeys.has(keyOf(c.action, c.input))) continue; // dedupe
    const { error } = await service.from('agent_proposals').insert({
      org_id: orgId,
      run_id: runId,
      agent_key: 'weekly-studio',
      product: 'reach',
      action: c.action,
      input: c.input,
      title: c.title,
      detail: c.detail,
      rationale: sel.rationale.slice(0, 280),
      status: 'pending',
    });
    if (!error) {
      proposed += 1;
      pendingKeys.add(keyOf(c.action, c.input));
    }
  }
  return { proposed, cost_cents };
}
