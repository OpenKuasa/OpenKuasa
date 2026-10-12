import type { SupabaseClient } from '@supabase/supabase-js';
import { runAgent, type AgentRunResult } from '@/lib/agents/run-agent';
import { reachAgent } from '@/lib/agents/reach-agent';
import type { AgentRunTrigger } from '@/lib/agents/types';

export type WeeklyStudioResult = AgentRunResult;

/**
 * Runs the reach "Weekly Studio" agent for one org. Thin wrapper over the generic
 * {@link runAgent} spine bound to {@link reachAgent}; the behavior (digest, images,
 * async video, proposals, budget) lives in the reach definition. Kept as the name the
 * scheduler/tests/actions already import. Throws RunInProgressError when a run is in progress.
 */
export function runWeeklyStudio(
  service: SupabaseClient,
  orgId: string,
  trigger: AgentRunTrigger,
): Promise<WeeklyStudioResult> {
  return runAgent(service, orgId, trigger, reachAgent);
}
