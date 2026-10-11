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
  const out: Candidate[] = [];
  for (const l of leads) {
    if (l.stage === 'won' && !l.promoted_contact_id) {
      out.push(make('promoteLeadToContact', { id: l.id }));
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
  reach: { leads: Lead[]; appts: Appointment[]; context: string },
  maxCost: number,
  costSoFar: number,
  scan: (leads: Lead[], appts: Appointment[], now: Date) => Candidate[] = opportunityScan,
): Promise<{ proposed: number; cost_cents: number }> {
  if (costSoFar >= maxCost) return { proposed: 0, cost_cents: 0 };
  const candidates = scan(reach.leads, reach.appts, new Date());
  if (candidates.length === 0) return { proposed: 0, cost_cents: 0 };

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
  const fresh = candidates.filter((c) => !pendingKeys.has(dedupeKeyOf(c.action, c.input)));
  if (fresh.length === 0) return { proposed: 0, cost_cents: 0 }; // all already pending → no LLM call

  const { keep, cost_cents } = await suggestProposals(
    apiKey,
    reach.context,
    fresh.map((c, index) => ({ index, title: c.title })),
  );

  let proposed = 0;
  try {
    for (const sel of keep) {
      if (proposed >= MAX_PROPOSALS) break;
      const c = fresh[sel.index];
      if (!c || !isAllowedAction(c.action)) continue; // tampered / off-list selection
      if (!ALLOWED_ACTIONS[c.action].schema.safeParse(c.input).success) continue; // re-validate input
      const key = dedupeKeyOf(c.action, c.input);
      if (pendingKeys.has(key)) continue; // intra-run duplicate selection
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
        pendingKeys.add(key);
      }
    }
    return { proposed, cost_cents };
  } catch {
    return { proposed, cost_cents }; // keep the LLM spend even if an insert throws
  }
}
