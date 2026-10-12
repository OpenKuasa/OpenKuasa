/**
 * "Jebat, your CMO" — a single agent that calls the read-only data tools
 * directly. Returns a `streamText` result the route turns into a UI message
 * stream (the client sees the real tool calls). Step-capped so one turn cannot
 * loop without bound.
 */

import { type ModelMessage, stepCountIs, streamText } from 'ai';
import { logModelCall, logModelError } from '@/lib/ai/call-log';
import { getModel, pickModelId } from '@/lib/ai/provider';
import type { CrmAccess } from '@/lib/ai/crm-tools';
import { prepareCvStep } from '@/lib/ai/hire-tools';
import { guardDeletions } from '@/lib/ai/hire-deletions';
import { guardPoolChanges } from '@/lib/ai/hire-pool-gate';
import {
  REACH_WRITE_TOOL_NAMES,
  combineToolkits,
  crmProduct,
  hireProduct,
  kasturiSharedProduct,
  peopleProduct,
  reachProduct,
  type HireAccess,
  type PeopleAccess,
  type ReachAccess,
} from '@/lib/ai/products';
import {
  JEBAT_SYSTEM,
  LEKIR_SYSTEM,
  lekiuSystem,
  kasturiSystem,
  tuahSystem,
  tuahTeamSystem,
} from '@/lib/ai/agents/prompts';
import { createTeamTools, type TeamContext } from '@/lib/ai/agents/specialists';
import type { Screen } from '@/lib/chat/screen';

/** Tools that change data: each one pauses for the owner's approval before running. */
export const WRITE_TOOL_NAMES = REACH_WRITE_TOOL_NAMES;

export type { HireAccess, PeopleAccess, ReachAccess };

export function runJebat(
  messages: ModelMessage[],
  reach: ReachAccess,
  abortSignal?: AbortSignal,
  /** A workspace's own OpenRouter key; omitted for platform-paid turns. */
  apiKey?: string,
) {
  const { tools, toolApproval } = combineToolkits([reachProduct(reach)]);
  return streamText({
    model: getModel('orchestrator', apiKey),
    system: JEBAT_SYSTEM,
    messages,
    tools,
    toolApproval,
    onLanguageModelCallEnd: logModelCall('jebat', pickModelId('orchestrator')),
    onError: logModelError('jebat'),
    stopWhen: stepCountIs(8),
    maxOutputTokens: 1000,
    // Stop in-flight model/tool work if the client disconnects.
    abortSignal,
  });
}

/**
 * "Kasturi, your sales co-pilot": the same single agent as Jebat, holding the
 * CRM tools instead of the marketing ones, plus the marketing tools for the
 * two screens it shares with Jebat (Appointments and Lead Forms). Lookups run
 * on their own; each change waits for the owner's approval.
 */
export function runKasturi(
  messages: ModelMessage[],
  crm: CrmAccess,
  reach: ReachAccess,
  abortSignal?: AbortSignal,
  /** A workspace's own OpenRouter key; omitted for platform-paid turns. */
  apiKey?: string,
) {
  const { tools, toolApproval } = combineToolkits([crmProduct(crm), kasturiSharedProduct(reach)]);
  return streamText({
    model: getModel('orchestrator', apiKey),
    system: kasturiSystem(new Date()),
    messages,
    tools,
    toolApproval,
    onLanguageModelCallEnd: logModelCall('kasturi', pickModelId('orchestrator')),
    onError: logModelError('kasturi'),
    // A CRM change often needs two lookups first (the contact, then the stage).
    stopWhen: stepCountIs(10),
    maxOutputTokens: 1000,
    abortSignal,
  });
}

/**
 * "Lekir, your hiring lead": the same single agent as Jebat, holding the
 * hiring lookups, plus (for someone who may write) job, careers page, application form and application changes that each
 * wait for the user's approval.
 */
export function runLekir(
  messages: ModelMessage[],
  hire: HireAccess,
  abortSignal?: AbortSignal,
  /** A workspace's own OpenRouter key; omitted for platform-paid turns. */
  apiKey?: string,
) {
  const product = hireProduct(hire);
  const { tools, toolApproval } = combineToolkits([product]);
  return streamText({
    model: getModel('orchestrator', apiKey),
    system: LEKIR_SYSTEM,
    messages,
    tools,
    // The first deletion of a turn, and the first talent pool change, go to the user as a card; any other is denied
    // before a card exists, and so is one for an id nobody looked up.
    toolApproval: guardPoolChanges(guardDeletions(toolApproval, product.checkDeletion), product.checkPoolChange),
    // A CV Lekir has read reaches its model as a user file in the next step, never inside the tool result.
    prepareStep: prepareCvStep(product.cvShelf),
    onLanguageModelCallEnd: logModelCall('lekir', pickModelId('orchestrator')),
    // After a CV read the request holds the file: a failure is logged by its code, never whole.
    onError: logModelError('lekir'),
    stopWhen: stepCountIs(8),
    // A drafted job description runs longer than a data answer.
    maxOutputTokens: 1400,
    abortSignal,
  });
}

/**
 * "Lekiu, your HR co-pilot": the same single agent as Jebat, holding the HR
 * lookups. Lookups run on their own; each change to an employee or a department waits for the person's approval.
 */
export function runLekiu(
  messages: ModelMessage[],
  people: PeopleAccess,
  abortSignal?: AbortSignal,
  /** A workspace's own OpenRouter key; omitted for platform-paid turns. */
  apiKey?: string,
) {
  const { tools, toolApproval } = combineToolkits([peopleProduct(people)]);
  return streamText({
    model: getModel('orchestrator', apiKey),
    system: lekiuSystem(new Date()),
    messages,
    tools,
    toolApproval,
    onLanguageModelCallEnd: logModelCall('lekiu', pickModelId('orchestrator')),
    onError: logModelError('lekiu'),
    // A change often needs two lookups first (the employee, then the department).
    stopWhen: stepCountIs(10),
    // A drafted notice or letter runs longer than a data answer.
    maxOutputTokens: 1400,
    abortSignal,
  });
}

/** What each specialist is for, as Tuah's instructions put it. */
const TEAM_AREA = {
  reach:
    'marketing: ads and campaigns, spend, leads (finding, adding and editing them, and promoting a lead to a CRM contact), lead forms, creatives, appointments and ad settings',
  crm: 'the CRM: contacts, deals, pipelines and their stages, follow-ups (reminders to get back to a contact) and the calendar. A lead is not a contact yet: anything about a lead goes to Jebat',
  hire: 'hiring: job openings, candidates and their applications, the hiring funnel, interviews, the talent pool and time to hire. Job openings can be created, edited, opened, paused, closed and deleted. Applications can be moved, rejected, reopened and rated, one at a time. Candidates can be added by hand and edited, one at a time. An application or a candidate can be deleted, one at a time. A candidate can be added to the talent pool, given a pool status, removed from the pool or moved to the pipeline for a job, one at a time. Existing staff, leave and payroll are not hiring. It can read one candidate\'s uploaded CV and give a verdict on it',
  people: 'HR: existing staff, leave, time-off, claims, overtime, attendance, payroll and performance. It looks these up (an owner or admin sees everyone; others see their own) and can prepare changes that wait for approval — deciding leave, claims and overtime, correcting attendance, and editing staff and departments, one change at a time. Hiring new people is not HR',
} as const;

/**
 * Tuah, the cross-app assistant on the Command page and the floating button.
 * It has the marketing tools Jebat has, Kasturi's CRM tools, Lekir's hiring
 * tools and Lekiu's HR tools (lookups, and changes behind an approval), runs on
 * the model those rules were tuned on, and says so rather than inventing data
 * from the products it cannot see yet (finance).
 */
export function runTuah(
  messages: ModelMessage[],
  reach: ReachAccess,
  abortSignal?: AbortSignal,
  apiKey?: string,
  /** The screen the question was asked from, if it came from the floating assistant. */
  screen?: Screen | null,
  /** The workspace's CRM, when the user is in one. */
  crm?: CrmAccess | null,
  /**
   * Set to run Tuah with its team: it asks a specialist per product and
   * carries out what they prepare, instead of holding every tool itself.
   */
  team?: Omit<TeamContext, 'apiKey'> | null,
  /**
   * The workspace's hiring data. The lookups need no workspace role; the change
   * tools (jobs, careers page, application form, applications) are added only when `hire.write.canWrite` is set, and each
   * waits for the user's approval.
   */
  hire?: HireAccess | null,
  /**
   * The workspace's HR data. The caller's own session decides which rows the
   * lookups return; the change tools are added per the HR tier (`hr` or `self`)
   * the route resolved, and each waits for the user's approval.
   */
  people?: PeopleAccess | null,
) {
  // Every product the user can reach: marketing always, the CRM in a workspace, hiring when passed, HR when passed.
  const products = [
    reachProduct(reach),
    ...(crm ? [crmProduct(crm)] : []),
    ...(hire ? [hireProduct(hire)] : []),
    ...(people ? [peopleProduct(people)] : []),
  ];
  const teamTools = team ? createTeamTools(products, { ...team, apiKey }, messages) : null;
  const { tools, toolApproval } = teamTools ?? combineToolkits(products);
  const system = team
    ? tuahTeamSystem(
        products.map((p) => ({ name: p.name, area: TEAM_AREA[p.key] })),
        toolApproval !== undefined,
        screen,
      )
    : tuahSystem(screen);
  return streamText({
    model: getModel('orchestrator', apiKey),
    system,
    messages,
    tools,
    // The first deletion of a turn, and the first talent pool change, go to the user as a card; any other is denied before a card exists.
    toolApproval: guardPoolChanges(
      guardDeletions(toolApproval, products.find((p) => p.checkDeletion)?.checkDeletion),
      products.find((p) => p.checkPoolChange)?.checkPoolChange,
    ),
    prepareStep: teamTools?.prepareStep as never,
    onLanguageModelCallEnd: logModelCall(team ? 'tuah-team' : 'tuah', pickModelId('orchestrator')),
    onError: logModelError(team ? 'tuah-team' : 'tuah'),
    // A CRM change often needs two lookups first (the contact, then the stage).
    stopWhen: stepCountIs(10),
    maxOutputTokens: 1000,
    abortSignal,
  });
}
