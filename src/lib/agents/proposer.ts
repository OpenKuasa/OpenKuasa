import type { SupabaseClient } from '@supabase/supabase-js';
import { approvalTitle } from '@/lib/chat/change-titles';
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
      // A fill-input candidate (the definition owns the shape, e.g. reach's draft form) lets the
      // model supply only the name; the definition server-forces the rest, so the server re-validates
      // the built input against the action schema before it is ever inserted.
      const input = c.fillInput ? c.fillInput(sel.name) : c.input;
      if (!def.actions[c.action].schema.safeParse(input).success) continue; // re-validate input
      const key = dedupeKeyOf(c.action, input);
      if (pendingKeys.has(key)) continue; // intra-run duplicate selection
      const title = c.fillInput ? approvalTitle(c.action, input, () => null) : c.title;
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
