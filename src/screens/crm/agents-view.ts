import { describeCheck, readBack, validatePlan, type FocusPlan } from '@/lib/agents/focus/plan';
import type { AgentCadence, AgentProposal, AgentRunStatus } from '@/lib/agents/types';
import { CRM_DEFAULTS as DEFAULTS, CRM_FOCUS_MENU } from '@/lib/crm/agent/checks';

/**
 * The Kasturi Agents screen's view model, built on the server from what was read. Pure:
 * no database, no server code, so it can be tested on its own.
 */

export type CrmAgentConfigRow = {
  enabled: boolean;
  cadence: AgentCadence;
  max_cost_cents: number;
  daily_cap_cents: number;
  weekly_cap_cents: number;
  focus_text: string | null;
  focus_plan: unknown;
  focus_cannot: string[] | null;
  focus_confirmed_at: string | null;
};

export type CrmAgentRunRow = { id: string; status: AgentRunStatus; cost_cents: number; started_at: string };

export type CrmAgentsInput = {
  config: CrmAgentConfigRow | null;
  /** An active preset schedule exists for the agent (the cron only runs those). */
  hasActiveSchedule: boolean;
  pending: AgentProposal[];
  decided: AgentProposal[];
  runs: CrmAgentRunRow[];
  /** Suggestions made per run id; null when they could not be counted. */
  suggestionsByRun: Record<string, number> | null;
  /** Null when the spend could not be read: the strip says so rather than showing RM 0.00. */
  spentTodayCents: number | null;
  spentWeekCents: number | null;
  /** Null when the key status could not be read: treated as unknown, never as "no key". */
  hasKey: boolean | null;
};

export type CrmAgentsSection = 'waiting' | 'focus' | 'schedule' | 'history';

export type CrmFocusView = {
  state: 'none' | 'unconfirmed' | 'confirmed';
  text: string;
  readBack: string[];
  cannot: string[];
};

/** How one waiting suggestion is shown: its record link, what approving does, and the check behind it. */
export type CrmSuggestionView = { href: string | null; effect: string; why: string | null };

export type CrmAgentsView = {
  sections: CrmAgentsSection[];
  focus: CrmFocusView;
  settings: { cadence: AgentCadence; maxCostCents: number; dailyCapCents: number; weeklyCapCents: number };
  spend: { todayCents: number | null; weekCents: number | null };
  /** The focus is confirmed but nothing is scheduled: the Schedule section asks for one. */
  needsSchedule: boolean;
  pending: AgentProposal[];
  suggestions: Record<string, CrmSuggestionView>;
  decided: AgentProposal[];
  history: { id: string; status: AgentRunStatus; costCents: number; startedAt: string; suggestions: number | null }[];
  /** True, false, or null when unknown (buttons stay enabled; the server still refuses without a key). */
  hasKey: boolean | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const str = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);

function formatDay(day: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const d = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** The record link and the effect line, from the proposal's stored input (never shown raw). */
export function suggestionView(p: AgentProposal, plan?: FocusPlan): CrmSuggestionView {
  const input = isRecord(p.input) ? p.input : {};
  const dealId = str(input.dealId);
  const contactId = str(input.contactId);
  const href = dealId
    ? `/crm/deals?open=${encodeURIComponent(dealId)}`
    : contactId
      ? `/crm/contacts?open=${encodeURIComponent(contactId)}`
      : null;

  let effect = 'Approving makes this change.';
  if (p.action === 'createFollowUp') {
    const title = str(input.title);
    const due = typeof input.dueDay === 'string' ? formatDay(input.dueDay) : null;
    effect = `Adds a follow-up task${title ? ` “${title}”` : ''}${due ? `, due ${due}` : ''}.`;
  } else if (p.action === 'createAgentNote') {
    const body = str(input.body);
    const on = dealId ? 'the deal' : 'the contact';
    effect = body ? `Leaves this note on ${on}: “${body}”` : `Leaves a note on ${on}.`;
  }
  // The confirmed plan's own line for this check (default numbers if the focus has since changed);
  // never the model's rationale.
  const planned = plan?.checks.find((c) => c.key === p.check_key);
  const why = p.check_key ? describeCheck(CRM_FOCUS_MENU, p.check_key, planned?.params) : null;
  return { href, effect, why };
}

function focusView(config: CrmAgentConfigRow | null): CrmFocusView {
  const text = config?.focus_text?.trim() ?? '';
  if (!config || text.length === 0) return { state: 'none', text: '', readBack: [], cannot: [] };
  const { plan } = validatePlan(CRM_FOCUS_MENU, config.focus_plan);
  return {
    state: config.focus_confirmed_at ? 'confirmed' : 'unconfirmed',
    text,
    readBack: readBack(CRM_FOCUS_MENU, plan),
    cannot: (config.focus_cannot ?? []).filter((s) => typeof s === 'string' && s.trim().length > 0),
  };
}

export function buildCrmAgentsView(input: CrmAgentsInput): CrmAgentsView {
  const { config } = input;
  const focus = focusView(config);
  const suggestions: Record<string, CrmSuggestionView> = {};
  const { plan } = validatePlan(CRM_FOCUS_MENU, config?.focus_plan);
  for (const p of input.pending) suggestions[p.id] = suggestionView(p, plan);

  return {
    sections: focus.state === 'none' ? ['focus'] : ['waiting', 'focus', 'schedule', 'history'],
    focus,
    settings: {
      // A stored cadence only means something when the agent is on and a schedule exists.
      cadence: config && config.enabled && input.hasActiveSchedule ? config.cadence : 'off',
      maxCostCents: config?.max_cost_cents ?? DEFAULTS.max_cost_cents,
      dailyCapCents: config?.daily_cap_cents ?? DEFAULTS.daily_cap_cents,
      weeklyCapCents: config?.weekly_cap_cents ?? DEFAULTS.weekly_cap_cents,
    },
    spend: { todayCents: input.spentTodayCents, weekCents: input.spentWeekCents },
    needsSchedule: focus.state === 'confirmed' && !input.hasActiveSchedule,
    pending: input.pending,
    suggestions,
    decided: input.decided,
    history: input.runs.map((r) => ({
      id: r.id,
      status: r.status,
      costCents: r.cost_cents,
      startedAt: r.started_at,
      suggestions: input.suggestionsByRun ? (input.suggestionsByRun[r.id] ?? 0) : null,
    })),
    hasKey: input.hasKey,
  };
}
