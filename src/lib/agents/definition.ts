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

/**
 * One allow-listed action, type-erased for the registry: its input schema + a run that
 * takes the owner-session write-context. {@link entry} binds a typed capability into it.
 */
export type Entry = {
  schema: ZodType;
  run: (ctx: unknown, input: unknown) => Promise<CapResult<unknown>>;
};

/**
 * Bind a typed capability into an {@link Entry}: the caller keeps full type-safety on the
 * input (`I`, from the schema) and the write-context (`Ctx`, from the capability); the stored
 * entry erases both, parsing the input with the schema and handing the context on.
 */
export function entry<I, Ctx>(
  schema: ZodType<I>,
  cap: (ctx: Ctx, input: I) => Promise<CapResult<unknown>>,
): Entry {
  return { schema, run: (ctx, input) => cap(ctx as Ctx, schema.parse(input) as I) };
}

/** The model-ready snapshot a run builds once and threads to digest + proposer. */
export type BuiltContext = { context: string; raw: unknown; trend?: string };

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
 * One product's autonomous agent, keyed by `agent_key` and carrying its `product`. The
 * generic spine (worker/proposer/scheduler/apply/UI) reads a definition instead of
 * hardwiring reach. It is type-erased (`raw`/write-context are `unknown`) so a registry can
 * hold agents of different products; each definition narrows `raw` internally. The
 * write-context the apply path runs capabilities under is reach's `ReachWriteContext` today.
 */
export type AgentDefinition = {
  agentKey: string;
  product: string;
  /** Service-role read of the workspace + a model-ready snapshot string. */
  buildContext(service: SupabaseClient, orgId: string): Promise<{ context: string; raw: unknown }>;
  /** Deterministic, pure candidate changes from this run's data. */
  scan(raw: unknown, now: Date): Candidate[];
  /** DB-touching candidates (reach: the trend-gated createForm cooldown). Awaited after scan. */
  extraCandidates?(
    service: SupabaseClient,
    orgId: string,
    built: BuiltContext,
    now: Date,
  ): Promise<Candidate[]>;
  /** What a schedule's monitor-skip counts as new data since `since`. */
  hasNewData(service: SupabaseClient, orgId: string, since: string): Promise<boolean>;
  /** The owner-approved allow-list: action name -> { input schema, capability run }. */
  actions: Record<string, Entry>;
  /** Builds the owner-session write-context the apply path runs the capability under. */
  buildWriteContext(client: SupabaseClient, orgId: string, userId: string): unknown;
  /** Optional web-search step; its text feeds the digest and the proposer's `trend`. */
  research?: { prompt(context: string): string };
  digest: { prompt(context: string, research: string | null): string };
  /** Optional poster/hero/video generation; returns the cost it added. */
  media?(mctx: MediaContext): Promise<{ cost_cents: number }>;
  ui: { title: string; subtitle: string; screenPath: string; assetKinds: readonly string[] };
};

export type AgentRegistry = ReadonlyMap<string, AgentDefinition>;

export function agentFor(agentKey: string, reg: AgentRegistry): AgentDefinition | undefined {
  return reg.get(agentKey);
}

export function agentForProduct(product: string, reg: AgentRegistry): AgentDefinition | undefined {
  for (const def of reg.values()) if (def.product === product) return def;
  return undefined;
}

export function actionsFor(product: string, reg: AgentRegistry): Record<string, Entry> {
  return agentForProduct(product, reg)?.actions ?? {};
}
