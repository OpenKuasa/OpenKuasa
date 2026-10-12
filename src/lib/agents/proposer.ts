import type { SupabaseClient } from '@supabase/supabase-js';
import { type Lead, type Appointment, LEAD_STAGES } from '@/lib/reach/types';
import { approvalDetail, approvalTitle, type ItemKind } from '@/lib/chat/change-titles';
import { type AgentDefinition, type Candidate } from '@/lib/agents/definition';
import { TEXT_ESTIMATE_CENTS, costOr } from '@/lib/agents/costs';
import { suggestProposals } from '@/lib/agents/openrouter-media';

const MAX_PROPOSALS = 5;

export type { Candidate };

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
  built: { context: string; raw: unknown; trend?: string },
  maxCost: number,
  costSoFar: number,
  def: AgentDefinition,
): Promise<{ proposed: number; cost_cents: number }> {
  if (costSoFar >= maxCost) return { proposed: 0, cost_cents: 0 };
  const now = new Date();
  const candidates = def.scan(built.raw, now);
  if (candidates.length === 0 && !built.trend) return { proposed: 0, cost_cents: 0 };

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

  // DB-touching extras the definition supplies (reach: the trend-gated, cooldown-limited
  // draft lead-capture form for the model to NAME — rule 4). Appended after the dedupe
  // filter, like the deterministic candidates it joins.
  if (def.extraCandidates) offered.push(...(await def.extraCandidates(service, orgId, built, now)));
  if (offered.length === 0) return { proposed: 0, cost_cents: 0 }; // nothing new to offer → no LLM call

  const picked = await suggestProposals(
    apiKey,
    built.context,
    offered.map((c, index) => ({ index, title: c.title })),
    built.trend,
  );
  const keep = picked.keep;
  // A call the provider put no price on still counts, at the text-call estimate.
  const cost_cents = costOr(picked.cost_cents, TEXT_ESTIMATE_CENTS);

  let proposed = 0;
  try {
    for (const sel of keep) {
      if (proposed >= MAX_PROPOSALS) break;
      const c = offered[sel.index];
      if (!c || !Object.hasOwn(def.actions, c.action)) continue; // tampered / off-list selection
      // For a fill-name candidate (the draft form) the model supplies only the name;
      // channel + status are server-forced, so an approved form is never live or channel-bound.
      const input = c.fillName
        ? { name: sel.name, category: null, channel: null, status: 'draft' }
        : c.input;
      if (!def.actions[c.action].schema.safeParse(input).success) continue; // re-validate input
      const key = dedupeKeyOf(c.action, input);
      if (pendingKeys.has(key)) continue; // intra-run duplicate selection
      const title = c.fillName ? approvalTitle(c.action, input, () => null) : c.title;
      const { error } = await service.from('agent_proposals').insert({
        org_id: orgId,
        run_id: runId,
        agent_key: def.agentKey,
        product: def.product,
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
