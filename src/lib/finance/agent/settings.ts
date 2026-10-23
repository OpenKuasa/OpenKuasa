import type { FocusAgentSpec } from '@/lib/agents/focus/settings';
import { FINANCE_FOCUS } from '@/lib/agents/types';
import { FINANCE_DEFAULTS, FINANCE_FOCUS_MENU, FINANCE_MAX_FOCUS_CHARS } from '@/lib/finance/agent/checks';

/** Bendahara's agent, as the shared focus settings (`@/lib/agents/focus/settings`) see it. */
export const FINANCE_FOCUS_SPEC: FocusAgentSpec = {
  agentKey: FINANCE_FOCUS,
  menu: FINANCE_FOCUS_MENU,
  defaults: FINANCE_DEFAULTS,
  maxChars: FINANCE_MAX_FOCUS_CHARS,
};
