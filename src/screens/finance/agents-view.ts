import type { FocusView } from '@/components/agents/focus-box';
import type { ScheduleSettings, ScheduleSpend } from '@/components/agents/schedule-box';
import type { SuggestionView } from '@/components/agents/pending-approvals';
import { describeCheck, readBack, validatePlan, type FocusPlan } from '@/lib/agents/focus/plan';
import type { AgentCadence, AgentProposal, AgentRunStatus } from '@/lib/agents/types';
import { FINANCE_DEFAULTS as DEFAULTS, FINANCE_FOCUS_MENU } from '@/lib/finance/agent/checks';
import { noteHref, type FinanceAgentNote } from '@/lib/finance/agent/notes';

/**
 * Bendahara's Agents screen view model, built on the server from what was read. Pure: no
 * database, no server code, so it can be tested on its own.
 */

export type FinanceAgentConfigRow = {
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

export type FinanceAgentRunRow = { id: string; status: AgentRunStatus; cost_cents: number; started_at: string };

export type FinanceAgentsInput = {
  config: FinanceAgentConfigRow | null;
  /** An active preset schedule exists for the agent (the cron only runs those). */
  hasActiveSchedule: boolean;
  pending: AgentProposal[];
  decided: AgentProposal[];
  runs: FinanceAgentRunRow[];
  /** Suggestions made per run id; null when they could not be counted. */
  suggestionsByRun: Record<string, number> | null;
  spentTodayCents: number | null;
  spentWeekCents: number | null;
  hasKey: boolean | null;
  /** The newest notes; null when they could not be read. */
  notes: FinanceAgentNote[] | null;
};

export type FinanceAgentsSection = 'waiting' | 'focus' | 'schedule' | 'notes' | 'history';

export type FinanceNoteView = FinanceAgentNote & { href: string | null };

export type FinanceAgentsView = {
  sections: FinanceAgentsSection[];
  focus: FocusView;
  settings: ScheduleSettings;
  spend: ScheduleSpend;
  needsSchedule: boolean;
  pending: AgentProposal[];
  suggestions: Record<string, SuggestionView>;
  decided: AgentProposal[];
  history: { id: string; status: AgentRunStatus; costCents: number; startedAt: string; suggestions: number | null }[];
  /** Null when they could not be read: the list says so. */
  notes: FinanceNoteView[] | null;
  hasKey: boolean | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const str = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);

/** The document's screen, the note approving adds, and the check behind it (never the model's rationale). */
export function financeSuggestionView(p: AgentProposal, plan?: FocusPlan): SuggestionView {
  const input = isRecord(p.input) ? p.input : {};
  const entityType = str(input.entityType);
  const href = entityType ? noteHref(entityType) : null;
  const body = str(input.body);
  const effect = body ? `Approving adds this note: “${body}”` : 'Approving adds this note.';
  const planned = plan?.checks.find((c) => c.key === p.check_key);
  const why = p.check_key ? describeCheck(FINANCE_FOCUS_MENU, p.check_key, planned?.params) : null;
  return { href, effect, why };
}

function focusView(config: FinanceAgentConfigRow | null): FocusView {
  const text = config?.focus_text?.trim() ?? '';
  if (!config || text.length === 0) return { state: 'none', text: '', readBack: [], cannot: [] };
  const { plan } = validatePlan(FINANCE_FOCUS_MENU, config.focus_plan);
  return {
    state: config.focus_confirmed_at ? 'confirmed' : 'unconfirmed',
    text,
    readBack: readBack(FINANCE_FOCUS_MENU, plan),
    cannot: (config.focus_cannot ?? []).filter((s) => typeof s === 'string' && s.trim().length > 0),
  };
}

function sectionsFor(focus: FocusView, notes: FinanceAgentNote[] | null): FinanceAgentsSection[] {
  if (focus.state !== 'none') return ['waiting', 'focus', 'schedule', 'notes', 'history'];
  // With no focus yet only the focus box shows, unless notes remain from an earlier focus: they
  // stay listed so a writer can still delete them.
  return notes && notes.length > 0 ? ['focus', 'notes'] : ['focus'];
}

export function buildFinanceAgentsView(input: FinanceAgentsInput): FinanceAgentsView {
  const { config } = input;
  const focus = focusView(config);
  const suggestions: Record<string, SuggestionView> = {};
  const { plan } = validatePlan(FINANCE_FOCUS_MENU, config?.focus_plan);
  for (const p of input.pending) suggestions[p.id] = financeSuggestionView(p, plan);

  return {
    sections: sectionsFor(focus, input.notes),
    focus,
    settings: {
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
    notes: input.notes ? input.notes.map((n) => ({ ...n, href: noteHref(n.entityType) })) : null,
    hasKey: input.hasKey,
  };
}
