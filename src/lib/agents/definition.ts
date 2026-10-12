import type { SupabaseClient } from '@supabase/supabase-js';
import type { ZodType } from 'zod';
import type { CapResult } from '@/lib/reach/capabilities';

/**
 * A deterministic candidate change an agent may propose. The model only ever
 * SELECTS from these; the server re-validates each kept one against the matching
 * action schema before it is inserted. `fillName` marks a candidate whose final
 * input the model names at selection time (reach's draft lead-capture form).
 */
export type Candidate = {
  action: string;
  input: unknown;
  title: string;
  detail: string | null;
  fillName?: boolean;
};

/** One allow-listed action: its input schema + the capability to run under the write-context. */
export type Entry<Ctx> = {
  schema: ZodType;
  run: (ctx: Ctx, input: unknown) => Promise<CapResult<unknown>>;
};

/** Erase the per-capability input type: parse with the schema, hand the parsed value on. */
export function entry<I, Ctx>(
  schema: ZodType<I>,
  cap: (ctx: Ctx, input: I) => Promise<CapResult<unknown>>,
): Entry<Ctx> {
  return { schema, run: (ctx, input) => cap(ctx, schema.parse(input) as I) };
}

/** The model-ready snapshot a run builds once and threads to digest + proposer. */
export type BuiltContext<Raw> = { context: string; raw: Raw; trend?: string };

/**
 * Everything the generic worker hands a definition's media step: the open key, the
 * snapshot, the budget cap + spend-so-far, and `reserve` — which books an ABSOLUTE
 * running total to the run row before each paid step (the step tracks its own running
 * cost from `costSoFar` and reserves `running + estimate`). The step returns the real
 * cost it added, which the worker then adds to the run's spend.
 */
export type MediaContext = {
  apiKey: string;
  context: string;
  maxCost: number;
  costSoFar: number;
  reserve: (totalCents: number) => Promise<void>;
  service: SupabaseClient;
  orgId: string;
  runId: string;
};

/**
 * One product's autonomous agent, keyed by `agent_key` and carrying its `product`.
 * The generic spine (worker/proposer/scheduler/apply/UI) reads a definition instead
 * of hardwiring reach. Ctx is the owner-session write-context the apply path runs
 * capabilities under (reach: {@link import('@/lib/reach/capabilities').ReachWriteContext}).
 */
export type AgentDefinition<Raw, Ctx> = {
  agentKey: string;
  product: string;
  /** Service-role read of the workspace + a model-ready snapshot string. */
  buildContext(service: SupabaseClient, orgId: string): Promise<{ context: string; raw: Raw }>;
  /** Deterministic, pure candidate changes from this run's data. */
  scan(raw: Raw, now: Date): Candidate[];
  /** DB-touching candidates (reach: the trend-gated createForm cooldown). Awaited after scan. */
  extraCandidates?(
    service: SupabaseClient,
    orgId: string,
    built: BuiltContext<Raw>,
    now: Date,
  ): Promise<Candidate[]>;
  /** What a schedule's monitor-skip counts as new data since `since`. */
  hasNewData(service: SupabaseClient, orgId: string, since: string): Promise<boolean>;
  /** The owner-approved allow-list: action name -> { input schema, capability run }. */
  actions: Record<string, Entry<Ctx>>;
  /** Builds the owner-session write-context the apply path runs the capability under. */
  buildWriteContext(client: SupabaseClient, orgId: string, userId: string): Ctx;
  /** Optional web-search step; its text feeds the digest and the proposer's `trend`. */
  research?: { prompt(context: string): string };
  digest: { prompt(context: string, research: string | null): string };
  /** Optional poster/hero/video generation; returns the cost it added. */
  media?(mctx: MediaContext): Promise<{ cost_cents: number }>;
  ui: { title: string; subtitle: string; screenPath: string; assetKinds: readonly string[] };
};

export type AgentRegistry = ReadonlyMap<string, AgentDefinition<any, any>>;

export function agentFor(agentKey: string, reg: AgentRegistry): AgentDefinition<any, any> | undefined {
  return reg.get(agentKey);
}

export function agentForProduct(
  product: string,
  reg: AgentRegistry,
): AgentDefinition<any, any> | undefined {
  for (const def of reg.values()) if (def.product === product) return def;
  return undefined;
}

export function actionsFor(product: string, reg: AgentRegistry): Record<string, Entry<any>> {
  return agentForProduct(product, reg)?.actions ?? {};
}
