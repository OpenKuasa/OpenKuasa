import type { SupabaseClient } from '@supabase/supabase-js';
import { type Lead, type Appointment, LEAD_STAGES } from '@/lib/reach/types';
import { approvalDetail, approvalTitle, type ItemKind } from '@/lib/chat/change-titles';
import { isAllowedAction, ALLOWED_ACTIONS } from '@/lib/agents/apply-proposal';
import { TEXT_ESTIMATE_CENTS, costOr } from '@/lib/agents/costs';
import { suggestProposals } from '@/lib/agents/openrouter-media';

const MAX_PROPOSALS = 5;
/** How long after any form proposal (any status) before the agent may offer another. */
const FORM_PROPOSAL_COOLDOWN_MS = 30 * 24 * 3600_000;

/**
 * True when no createForm proposal (any status) exists in the cooldown window. The model
 * names each form differently, so a name-based dedupe can't stop weekly re-offers on its
 * own; this is the real gate. Fails closed: a query error means "do not offer".
 */
async function noRecentFormProposal(service: SupabaseClient, orgId: string): Promise<boolean> {
  const since = new Date(Date.now() - FORM_PROPOSAL_COOLDOWN_MS).toISOString();
  const { data, error } = await service
    .from('agent_proposals')
    .select('id')
    .eq('org_id', orgId)
    .eq('action', 'createForm')
    .gte('created_at', since)
    .limit(1);
  if (error) return false;
  return (data ?? []).length === 0;
}

export type Candidate = {
  action: string;
  input: unknown;
  title: string;
  detail: string | null;
  /** The model supplies this candidate's form `name` at selection time (rule 4). */
  fillName?: boolean;
};

/** A stable dedupe key: the action + the input's identifying field, so it matches
 * regardless of jsonb key order or a changing scheduled_at. */
function dedupeKeyOf(action: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const key =
    typeof i.id === 'string'
      ? i.id
      : typeof i.contact_name === 'string'
        ? i.contact_name
        : typeof i.name === 'string'
          ? i.name
          : JSON.stringify(i);
  return `${action}:${key}`;
}

/** Deterministic: the opportunities worth proposing from this week's data. */
export function opportunityScan(leads: Lead[], appts: Appointment[], now: Date): Candidate[] {
  const nameOf = (id: unknown, kind?: ItemKind): string | null =>
    kind === 'lead' && typeof id === 'string' ? (leads.find((l) => l.id === id)?.name ?? null) : null;
  const make = (action: string, input: unknown): Candidate => ({
    action,
    input,
    title: approvalTitle(action, input, nameOf),
    detail: approvalDetail(action, input),
  });
  const upcomingByName = new Set(
    appts.filter((a) => new Date(a.scheduled_at) > now).map((a) => a.contact_name),
  );
  const metByName = new Set(
    appts.filter((a) => a.status === 'completed').map((a) => a.contact_name),
  );
  const bookedIndex = LEAD_STAGES.indexOf('booked');
  const out: Candidate[] = [];
  for (const l of leads) {
    if (l.stage === 'won' && !l.promoted_contact_id) {
      out.push(make('promoteLeadToContact', { id: l.id }));
    }
    // A lead that has met (a completed appointment) but is still short of 'booked' → advance it.
    if (LEAD_STAGES.indexOf(l.stage) < bookedIndex && metByName.has(l.name)) {
      out.push(make('setLeadStage', { id: l.id, stage: 'booked' }));
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
        ),
      );
    }
  }
  return out;
}

/**
 * Proposes changes for one run. The deterministic candidates are de-duped against
 * the current pending proposals BEFORE the paid LLM call (spec §6) — if nothing new
 * remains, the model is never called. The LLM then only SELECTS from the fresh
 * candidates; the server re-validates every kept candidate's input against the
 * capability schema + the allow-list, caps the count, and inserts. Returns how many
 * were queued and the LLM cost.
 */
export async function proposeChanges(
  service: SupabaseClient,
  orgId: string,
  runId: string,
  apiKey: string,
  reach: { leads: Lead[]; appts: Appointment[]; context: string; trend?: string },
  maxCost: number,
  costSoFar: number,
  scan: (leads: Lead[], appts: Appointment[], now: Date) => Candidate[] = opportunityScan,
): Promise<{ proposed: number; cost_cents: number }> {
  if (costSoFar >= maxCost) return { proposed: 0, cost_cents: 0 };
  const candidates = scan(reach.leads, reach.appts, new Date());
  if (candidates.length === 0 && !reach.trend) return { proposed: 0, cost_cents: 0 };

  // De-dupe BEFORE the paid LLM call: drop candidates already queued as pending, and
  // if nothing new remains, skip the model call entirely.
  const { data: existing, error: dErr } = await service
    .from('agent_proposals')
    .select('action, input')
    .eq('org_id', orgId)
    .eq('status', 'pending');
  if (dErr) return { proposed: 0, cost_cents: 0 }; // fail closed: never propose without a dedupe set
  const pendingKeys = new Set(
    (existing ?? []).map((r) =>
      dedupeKeyOf((r as { action: string }).action, (r as { input: unknown }).input),
    ),
  );
  const offered = candidates.filter((c) => !pendingKeys.has(dedupeKeyOf(c.action, c.input)));

  // Rule 4: offer ONE draft lead-capture form for the model to NAME after the week's trend,
  // when there is a trend and none was proposed in the cooldown window (so it is not
  // re-offered every run). The model supplies only the name; channel/status stay server-locked.
  if (reach.trend && (await noRecentFormProposal(service, orgId))) {
    offered.push({
      action: 'createForm',
      input: {},
      title: "Create a draft lead-capture form for this week's trend",
      detail: null,
      fillName: true,
    });
  }
  if (offered.length === 0) return { proposed: 0, cost_cents: 0 }; // nothing new to offer → no LLM call

  const picked = await suggestProposals(
    apiKey,
    reach.context,
    offered.map((c, index) => ({ index, title: c.title })),
    reach.trend,
  );
  const keep = picked.keep;
  // A call the provider put no price on still counts, at the text-call estimate.
  const cost_cents = costOr(picked.cost_cents, TEXT_ESTIMATE_CENTS);

  let proposed = 0;
  try {
    for (const sel of keep) {
      if (proposed >= MAX_PROPOSALS) break;
      const c = offered[sel.index];
      if (!c || !isAllowedAction(c.action)) continue; // tampered / off-list selection
      // For a fill-name candidate (the draft form) the model supplies only the name;
      // channel + status are server-forced, so an approved form is never live or channel-bound.
      const input = c.fillName
        ? { name: sel.name, category: null, channel: null, status: 'draft' }
        : c.input;
      if (!ALLOWED_ACTIONS[c.action].schema.safeParse(input).success) continue; // re-validate input
      const key = dedupeKeyOf(c.action, input);
      if (pendingKeys.has(key)) continue; // intra-run duplicate selection
      const title = c.fillName ? approvalTitle(c.action, input, () => null) : c.title;
      const { error } = await service.from('agent_proposals').insert({
        org_id: orgId,
        run_id: runId,
        agent_key: 'weekly-studio',
        product: 'reach',
        action: c.action,
        input,
        title,
        detail: c.detail,
        rationale: sel.rationale.slice(0, 280),
        status: 'pending',
      });
      if (!error) {
        proposed += 1;
        pendingKeys.add(key);
      }
    }
    return { proposed, cost_cents };
  } catch {
    return { proposed, cost_cents }; // keep the LLM spend even if an insert throws
  }
}
