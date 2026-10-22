import { z } from 'zod';
import { WEEKLY_STUDIO } from '@/lib/agents/types';

// A leaf module on purpose. The registry cannot be imported here: registry -> reach-agent
// -> reach/reports -> ai/tools -> reach/schedule-capabilities (which needs this schema at
// module load) is a runtime import cycle. tests/agent-config.test.ts asserts this list
// equals [...AGENTS.keys()], so adding an agent to the registry without listing it here
// fails the test.
export const AGENT_KEYS: readonly [string, ...string[]] = [WEEKLY_STUDIO];
export const agentKeySchema = z.enum(AGENT_KEYS);
