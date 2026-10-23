import type { AgentRegistry } from '@/lib/agents/definition';
import { reachAgent } from '@/lib/agents/reach-agent';
import { crmAgent } from '@/lib/agents/crm-agent';

/**
 * The single composition root for the autonomous-agent framework. Statically imports
 * each product agent so that any consumer importing `AGENTS` pulls the agent into its
 * module graph — there is no floating `register()` side-effect that a consumer could
 * fail to trigger (which would silently resolve a live `agent_key` to `undefined`).
 */
export const AGENTS: AgentRegistry = new Map([
  [reachAgent.agentKey, reachAgent],
  [crmAgent.agentKey, crmAgent],
]);

export { agentFor, agentForProduct, actionsFor } from '@/lib/agents/definition';
