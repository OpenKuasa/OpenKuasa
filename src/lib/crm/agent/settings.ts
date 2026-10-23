import type { SupabaseClient } from '@supabase/supabase-js';
import {
  START_REFUSED,
  confirmFocus as confirmAgentFocus,
  ensureAgentConfig,
  hasConfirmedFocus as hasConfirmedAgentFocus,
  nextKlSeven,
  saveFocus as saveAgentFocus,
  writeAgentConfig,
  type FocusAgentSpec,
  type SaveFocusDeps,
  type SaveFocusResult,
} from '@/lib/agents/focus/settings';
import { CRM_FOCUS } from '@/lib/agents/types';
import { CRM_DEFAULTS, CRM_FOCUS_MENU, CRM_MAX_FOCUS_CHARS } from '@/lib/crm/agent/checks';
import type { CapResult } from '@/lib/reach/capabilities';

export { CRM_DEFAULTS, nextKlSeven };
export type { SaveFocusDeps, SaveFocusResult };

/** Kasturi's agent, as the shared focus settings see it. */
export const CRM_FOCUS_SPEC: FocusAgentSpec = {
  agentKey: CRM_FOCUS,
  menu: CRM_FOCUS_MENU,
  defaults: CRM_DEFAULTS,
  maxChars: CRM_MAX_FOCUS_CHARS,
};

/** What the person is told when the start gate refuses. */
export const CRM_START_REFUSED = START_REFUSED;

/** Makes sure Kasturi's settings row exists, with Kasturi's defaults and its schedule off. */
export function ensureCrmAgentConfig(client: SupabaseClient, orgId: string): Promise<CapResult<null>> {
  return ensureAgentConfig(client, orgId, CRM_FOCUS_SPEC);
}

/** Writes columns on Kasturi's row, creating it with Kasturi's defaults first. */
export function writeCrmConfig(
  client: SupabaseClient,
  orgId: string,
  patch: Record<string, unknown>,
): Promise<CapResult<null>> {
  return writeAgentConfig(client, orgId, CRM_FOCUS_SPEC, patch);
}

/** Whether the workspace has a confirmed Kasturi focus plan. Pass the service client for the runner. */
export function hasConfirmedFocus(client: SupabaseClient, orgId: string): Promise<boolean> {
  return hasConfirmedAgentFocus(client, orgId, CRM_FOCUS);
}

/** Reads the workspace's words into Kasturi's plan (unconfirmed). See the shared `saveFocus`. */
export function saveFocus(deps: SaveFocusDeps, text: string): Promise<SaveFocusResult> {
  return saveAgentFocus(deps, CRM_FOCUS_SPEC, text);
}

/** Confirms Kasturi's saved plan (owner/admin) and switches the agent on. */
export function confirmFocus(client: SupabaseClient, orgId: string, now: Date = new Date()): Promise<CapResult<null>> {
  return confirmAgentFocus(client, orgId, CRM_FOCUS_SPEC, now);
}
