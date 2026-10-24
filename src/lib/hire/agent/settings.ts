import type { FocusAgentSpec } from '@/lib/agents/focus/settings';
import { HIRE_FOCUS } from '@/lib/agents/types';
import { HIRE_DEFAULTS, HIRE_FOCUS_MENU, HIRE_MAX_FOCUS_CHARS } from '@/lib/hire/agent/checks';

/** Lekir's agent, as the shared focus settings (`@/lib/agents/focus/settings`) see it. */
export const HIRE_FOCUS_SPEC: FocusAgentSpec = {
  agentKey: HIRE_FOCUS,
  menu: HIRE_FOCUS_MENU,
  defaults: HIRE_DEFAULTS,
  maxChars: HIRE_MAX_FOCUS_CHARS,
};
