import type { FocusAgentSpec } from '@/lib/agents/focus/settings';
import { PEOPLE_FOCUS } from '@/lib/agents/types';
import { PEOPLE_DEFAULTS, PEOPLE_FOCUS_MENU, PEOPLE_MAX_FOCUS_CHARS } from '@/lib/people/agent/checks';

/** Lekiu's agent, as the shared focus settings (`@/lib/agents/focus/settings`) see it. */
export const PEOPLE_FOCUS_SPEC: FocusAgentSpec = {
  agentKey: PEOPLE_FOCUS,
  menu: PEOPLE_FOCUS_MENU,
  defaults: PEOPLE_DEFAULTS,
  maxChars: PEOPLE_MAX_FOCUS_CHARS,
};
