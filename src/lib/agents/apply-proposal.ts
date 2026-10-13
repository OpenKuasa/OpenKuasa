import { errorCodeOf } from '@/lib/ai/call-log';
import { actionsFor, type AgentRegistry } from '@/lib/agents/definition';
import { AGENTS } from '@/lib/agents/registry';

export type ApplyResult = { ok: true; result: unknown } | { ok: false; error: string };

/**
 * Re-validate a persisted proposal's input and run its capability under `ctx` (the OWNER's
 * write-context), dispatched by the proposal's `product` to that agent's allow-list. Only the
 * non-destructive actions the agent exposes can run; anything off-list is refused. Mirrors the
 * in-chat applyChange re-validation. The registry is injectable for testing; defaults to AGENTS.
 */
export async function runProposalAction(
  product: string,
  ctx: unknown,
  action: string,
  input: unknown,
  registry: AgentRegistry = AGENTS,
): Promise<ApplyResult> {
  const found = actionsFor(product, registry)[action];
  if (!found) return { ok: false, error: 'That action is not allowed.' };
  const parsed = found.schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'That proposed change is no longer valid.' };
  let res: Awaited<ReturnType<typeof found.run>>;
  try {
    res = await found.run(ctx, parsed.data);
  } catch (e) {
    // Log the code for ops: the error itself can quote the proposal's values. The caller keeps the
    // generic message and never writes the raw error to the user-visible row.
    console.error('[agent-proposals] apply capability threw', errorCodeOf(e));
    return { ok: false, error: 'That change could not be applied.' };
  }
  return res.ok ? { ok: true, result: res.data } : { ok: false, error: res.error };
}
