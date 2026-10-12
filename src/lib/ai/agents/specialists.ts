/**
 * Tuah's team. Tuah itself holds almost no tools: it asks a specialist per
 * product (`askJebat`, `askKasturi`) and carries out what they prepare
 * (`applyChange`). A specialist runs on the cheaper model with its product's
 * lookups, and with "prepare" versions of its change tools: same inputs, but
 * they save nothing and hand back a proposal.
 *
 * The AI SDK does not allow an approval inside a sub-agent, so the approval
 * lives on Tuah: `applyChange` is the only tool that asks for one, and it is
 * the only place a real change tool is ever run.
 */

import {
  stepCountIs,
  streamText,
  tool,
  type LanguageModel,
  type ModelMessage,
  type Tool,
  type ToolSet,
} from 'ai';
import { z } from 'zod';
import { subAgentSystem } from '@/lib/ai/agents/prompts';
import { prepareCvStep } from '@/lib/ai/hire-tools';
import {
  AMBIGUOUS_DELETION,
  HIRE_DELETE_TOOL_NAMES,
  ambiguousLookup,
  ONE_DELETION,
  cardDecision,
  cardShown,
  deniedHere,
  notLookedUp,
  partsOf,
  stoppedAfterApproval,
  thisTurn,
  type DeletionGate,
} from '@/lib/ai/hire-deletions';
import {
  AMBIGUOUS_POOL_CHANGE,
  HIRE_POOL_TOOL_NAMES,
  ONE_POOL_CHANGE,
  jobNotLookedUp,
  poolCardDecision,
  poolNotLookedUp,
} from '@/lib/ai/hire-pool-gate';
import type { ProductToolkit } from '@/lib/ai/products';
import { logModelCall, logModelError, modelErrorCode } from '@/lib/ai/call-log';
import { getModel, pickModelId } from '@/lib/ai/provider';
import {
  approvalDetail,
  approvalTitle,
  collectNames,
  knownOnFile,
  nameIn,
  withoutPoolSide,
  type ItemKind,
  type KnownNames,
  type ToolResult,
} from '@/lib/chat/change-titles';
import {
  APPLY_TOOL,
  ASK_PREFIX,
  isDelegation,
  type AgentStep,
  type Delegation,
  type Proposal,
} from '@/lib/chat/delegation';

export type TeamContext = {
  /** A workspace's own OpenRouter key; omitted for platform-paid turns. */
  apiKey?: string;
  /** The conversation so far, in words, for specialists that only see their task. */
  transcript: string;
  /** Changes prepared earlier in the conversation, by id. New ones are added here. */
  proposals: Map<string, Proposal>;
  /** Names of rows the conversation has come across, by `kind:id`. Added to as it goes. */
  names?: KnownNames;
};

type Execute = (input: unknown, options: unknown) => unknown;
const executeOf = (t: Tool): Execute | undefined =>
  (t as { execute?: Execute }).execute?.bind(t);

/** What a specialist reports back, as Tuah's model reads it. */
export function delegationForModel(output: Delegation): string {
  if (output.status === 'failed') {
    return `${output.agent} could not finish. ${output.answer}`.trim();
  }
  const lines = [output.answer.trim() || `${output.agent} finished without a report.`];
  if (output.proposals.length > 0) {
    lines.push(
      '',
      'Prepared changes, not saved yet. Call applyChange with the id to put each in front of the user:',
      ...output.proposals.map((p) => `- proposalId ${p.id}: ${p.title}`),
    );
  }
  return lines.join('\n');
}

/** The four application changes: the id must have been seen as an application, not just anywhere. */
const APPLICATION_CHANGES = new Set(['moveApplication', 'rejectApplication', 'reopenApplication', 'rateApplication']);
const ONE_APPLICATION_CHANGE = 'One application change at a time. One is already prepared for approval.';

/** The two candidate changes: one person per delegation, and the ids they carry must have been looked up as what they are. */
const CANDIDATE_CHANGES = new Set(['addCandidate', 'updateCandidate']);
const ONE_CANDIDATE_CHANGE = 'One candidate change at a time. One is already prepared for approval.';

/** The two deletions: one a turn, across every delegation in it, and never from a lookup that said several rows match. */
const DELETIONS = new Set<string>(HIRE_DELETE_TOOL_NAMES);
/** The two talent pool changes: held to one a turn in the same way, and counted apart from deletions. */
const POOL_CHANGES = new Set<string>(HIRE_POOL_TOOL_NAMES);

/** The kinds of change held to one a turn. Each is counted on its own: a deletion and a pool change may share a turn. */
type Limited = 'deletion' | 'pool';
const limitedKind = (action: string): Limited | null =>
  DELETIONS.has(action) ? 'deletion' : POOL_CHANGES.has(action) ? 'pool' : null;
const ONE_A_TURN: Record<Limited, string> = { deletion: ONE_DELETION, pool: ONE_POOL_CHANGE };

/**
 * What the turn in progress holds, for the rules about a change held to one a turn. A turn is everything after the
 * last thing the user said, and can span two requests (the one that shows a card, and the one with the user's
 * answer). So this is read from the conversation's messages when a request starts, and added to as the request goes.
 */
type TurnState = {
  /** Such changes a specialist prepared in this turn, by kind and proposal id. */
  prepared: Record<Limited, Set<string>>;
  /** Such changes put in front of the user in this turn, whatever they answered: by kind, proposal id, and the call that asked. */
  shown: Record<Limited, Map<string, unknown>>;
  /**
   * Every id a lookup returned while saying its name fits several rows, whichever delegation ran it. A later
   * delegation that looks the same person up by a fuller name must not get past the question the user was owed.
   */
  ambiguous: Set<string>;
};

/** HR changes decide leave, pay and staff records: one person's decision per card, so only one is prepared a turn. */
const ONE_PEOPLE_CHANGE = 'One HR change at a time. One is already prepared for approval.';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every id a change refers to, wherever it sits in the input. */
export function idsIn(value: unknown, depth = 0): string[] {
  if (typeof value === 'string') return UUID.test(value) ? [value] : [];
  if (!value || typeof value !== 'object' || depth > 4) return [];
  return Object.values(value).flatMap((inner) => idsIn(inner, depth + 1));
}

/** Every id that a lookup among these returned while saying its name fits several rows. */
function ambiguousIn(results: ToolResult[]): string[] {
  return [...new Set(results.flatMap((r) => idsIn(r.output).filter((id) => ambiguousLookup([r.output], id))))];
}

/**
 * The turn's state as a request finds it. The browser sends the chat back whole, so the turn's earlier request is
 * in these messages: what a specialist reported (its prepared changes and its ambiguous lookups), and each
 * `applyChange` call. A call the gate itself denied was never shown to the user and is not counted.
 */
function turnStateFrom(messages: readonly ModelMessage[], proposals: Map<string, Proposal>): TurnState {
  const state: TurnState = {
    prepared: { deletion: new Set(), pool: new Set() },
    shown: { deletion: new Map(), pool: new Map() },
    ambiguous: new Set(),
  };
  const turn = thisTurn(messages);
  const denied = deniedHere(turn);
  const stopped = stoppedAfterApproval(turn);
  for (const message of turn) {
    for (const part of partsOf(message)) {
      if (message.role === 'assistant' && part.type === 'tool-call' && part.toolName === APPLY_TOOL && stopped.has(part.toolCallId)) {
        // Approved, then stopped by the last check: it never ran and is over, so it is not the turn's one. The
        // specialist's report that prepared it is earlier in the turn, so it is already in `prepared` here.
        const id = (part.input as { proposalId?: unknown } | null | undefined)?.proposalId;
        if (typeof id === 'string') for (const held of Object.values(state.prepared)) held.delete(id);
      } else if (message.role === 'tool' && part.type === 'tool-result' && typeof part.toolName === 'string' && part.toolName.startsWith(ASK_PREFIX)) {
        const output = part.output as { type?: unknown; value?: unknown } | null | undefined;
        const report = output?.type === 'json' ? output.value : null;
        if (!isDelegation(report)) continue;
        for (const proposal of report.proposals) {
          const kind = limitedKind(proposal.action);
          if (kind) state.prepared[kind].add(proposal.id);
        }
        for (const id of Array.isArray(report.ambiguous) ? report.ambiguous : []) if (typeof id === 'string') state.ambiguous.add(id);
      } else if (message.role === 'assistant' && part.type === 'tool-call' && part.toolName === APPLY_TOOL && !denied.has(part.toolCallId)) {
        const id = (part.input as { proposalId?: unknown } | null | undefined)?.proposalId;
        const proposal = typeof id === 'string' ? proposals.get(id) : undefined;
        const kind = proposal ? limitedKind(proposal.action) : null;
        if (typeof id === 'string' && kind) state.shown[kind].set(id, part.toolCallId);
      }
    }
  }
  return state;
}

/**
 * The approval for `applyChange`: a card for the user, except a change of a kind held to one a turn (a deletion, a
 * talent pool change) beside another of the same kind in the same turn, which is denied before a card exists.
 * "Another" is one a specialist prepared in this turn or one already put to the user in it, under a different
 * proposal; the same proposal asked for again under a new call is another too. The SDK asks again about a call the
 * user approved, when their answer arrives: same proposal, same call, so it passes.
 */
function applyGate(products: ProductToolkit[], team: TeamContext, turn: TurnState): DeletionGate {
  return async (input, { toolCallId, messages }) => {
    const id = (input as { proposalId?: unknown } | null)?.proposalId;
    const proposal = typeof id === 'string' ? team.proposals.get(id) : undefined;
    const kind = proposal ? limitedKind(proposal.action) : null;
    if (!proposal || !kind) return 'user-approval';
    const [prepared, shown] = [turn.prepared[kind], turn.shown[kind]];
    const another =
      [...prepared, ...shown.keys()].some((other) => other !== proposal.id) ||
      (shown.has(proposal.id) && shown.get(proposal.id) !== toolCallId);
    if (another) return { type: 'denied', reason: ONE_A_TURN[kind] };
    // Asked again here, as it was when the change was prepared: the rows may have changed since, or the proposal may be an old one.
    // This is where the card gets its identifying line: on the approval request, which no model is sent.
    const product = products.find((p) => p.key === proposal.product);
    const target = (proposal.input as { id?: unknown } | null)?.id;
    const was = cardShown(messages, toolCallId);
    const decision =
      kind === 'deletion'
        ? (product?.checkDeletion ? cardDecision(await product.checkDeletion(proposal.action, target), was) : 'user-approval')
        : (product?.checkPoolChange ? poolCardDecision(await product.checkPoolChange(proposal.action, target), was) : 'user-approval');
    if (typeof decision === 'object' && decision.type === 'denied') {
      // Stopped after the user's yes (the card had been shown): it will not run, so it stops being the turn's one,
      // and what the specialist prepares in its place can reach a card. One the user rejected, or that ran, stays.
      if (was) {
        prepared.delete(proposal.id);
        shown.delete(proposal.id);
      }
      return decision;
    }
    shown.set(proposal.id, toolCallId);
    return decision;
  };
}

/**
 * A specialist's tools: its lookups as they are, and its changes as proposals.
 * `given` is everything the specialist was told (its task and the
 * conversation), which is the other place an id may rightly come from.
 */
function specialistTools(
  product: ProductToolkit,
  team: TeamContext,
  results: ToolResult[],
  prepared: Proposal[],
  given: string,
  turn: TurnState,
): ToolSet {
  const tools: ToolSet = {};

  for (const [name, lookup] of Object.entries(product.read)) {
    const run = executeOf(lookup);
    tools[name] = {
      ...lookup,
      // Remembered so a prepared change can be worded with the item's name.
      execute: async (input: unknown, options: unknown) => {
        const output = await run?.(input, options);
        results.push({ tool: name, output });
        for (const id of ambiguousIn([{ tool: name, output }])) turn.ambiguous.add(id);
        return output;
      },
    } as Tool;
  }

  for (const [name, change] of Object.entries(product.write)) {
    tools[name] = tool({
      description:
        `${change.description ?? name} ` +
        'Calling this only PREPARES the change: the user is shown an Approve card and nothing is saved until they approve.',
      inputSchema: change.inputSchema as z.ZodType,
      execute: async (input: unknown) => {
        // The one thing here that waits is read first. Calls made in one step run side by side, and everything
        // below, down to the proposal being kept, must run without a pause for "only the first is prepared" to hold.
        const checked = DELETIONS.has(name)
          ? await product.checkDeletion?.(name, (input as { id?: unknown } | null)?.id)
          : undefined;
        // The same for a talent pool change: is a move's person in the pool, and can they be told from a namesake.
        // Read here, with the other wait, so everything below still runs without a pause.
        const checkedPool = POOL_CHANGES.has(name)
          ? await product.checkPoolChange?.(name, (input as { id?: unknown } | null)?.id)
          : undefined;
        // A specialist stops after the step in which it prepared a change, but one step can hold
        // several calls. Each card is a decision about one person: only the first is prepared.
        if (APPLICATION_CHANGES.has(name) && prepared.length > 0) {
          return { prepared: false, error: ONE_APPLICATION_CHANGE };
        }
        if (CANDIDATE_CHANGES.has(name) && prepared.length > 0) {
          return { prepared: false, error: ONE_CANDIDATE_CHANGE };
        }
        // One of its kind a turn, across every delegation in it: nothing else prepared here, and none of that kind prepared or shown earlier in the turn.
        const limited = limitedKind(name);
        if (limited && (prepared.length > 0 || turn.prepared[limited].size + turn.shown[limited].size > 0)) {
          return { prepared: false, error: ONE_A_TURN[limited] };
        }
        if (product.key === 'people' && prepared.length > 0) {
          return { prepared: false, error: ONE_PEOPLE_CHANGE };
        }
        // An id must have come from somewhere: a lookup just now, an earlier
        // turn, or the task. One that appears nowhere was made up, and a
        // change prepared with it would fail after the user approved it.
        const seen = JSON.stringify(results);
        const known = Object.keys(team.names ?? {}).join(' ');
        const invented = idsIn(input).filter(
          (id) => !seen.includes(id) && !known.includes(id) && !given.includes(id),
        );
        if (invented.length > 0) {
          return {
            prepared: false,
            error:
              `You have not looked up ${invented.join(', ')}. Never guess an id: use a lookup tool ` +
              'to list the item and get its real id, then prepare the change again.',
          };
        }
        if (APPLICATION_CHANGES.has(name) || name === 'deleteApplication') {
          const id = (input as { id?: unknown } | null)?.id;
          const asApplication =
            typeof id === 'string' && (team.names?.[`application:${id}`] || nameIn(results)(id, 'application'));
          if (!asApplication) {
            return { prepared: false, error: notLookedUp('application', id) };
          }
        }
        if (name === 'updateCandidate' || name === 'deleteCandidate') {
          const id = (input as { id?: unknown } | null)?.id;
          // A deletion takes only an id from a lookup of everyone on file: the pool lookup sees pool members only and
          // cannot say that two people on file share the name. The other way for the person: the Talent Pool row's
          // own "Delete candidate", or asking again, when the specialist looks the candidate up with listCandidates.
          const asCandidate =
            typeof id === 'string' &&
            (name === 'deleteCandidate'
              ? knownOnFile(team.names, id) || nameIn(withoutPoolSide(results))(id, 'candidate')
              : team.names?.[`candidate:${id}`] || nameIn(results)(id, 'candidate'));
          if (!asCandidate) {
            return { prepared: false, error: notLookedUp('candidate', id) };
          }
        }
        if (name === 'addCandidate') {
          // A person added on their own has no job; one added to a job must name a job that was looked up.
          const jobId = (input as { job_id?: unknown } | null)?.job_id;
          const asJob =
            typeof jobId === 'string' && (team.names?.[`job:${jobId}`] || nameIn(results)(jobId, 'job'));
          if (typeof jobId === 'string' && !asJob) {
            return {
              prepared: false,
              error:
                `You have not looked up ${jobId} as a job. Never guess an id: use listJobs ` +
                'to find the job and get its real id, then prepare the change again.',
            };
          }
        }
        if (POOL_CHANGES.has(name)) {
          // An id from listCandidates or listTalentPool, in this delegation or an earlier turn; never one seen as something else.
          const id = (input as { id?: unknown } | null)?.id;
          const asCandidate =
            typeof id === 'string' && (team.names?.[`candidate:${id}`] || nameIn(results)(id, 'candidate'));
          if (!asCandidate) {
            return { prepared: false, error: poolNotLookedUp(id) };
          }
        }
        if (name === 'moveToPipeline') {
          const jobId = (input as { job_id?: unknown } | null)?.job_id;
          const asJob =
            typeof jobId === 'string' && (team.names?.[`job:${jobId}`] || nameIn(results)(jobId, 'job'));
          if (!asJob) {
            return { prepared: false, error: jobNotLookedUp(jobId) };
          }
        }
        // A lookup in this turn that holds the id and says several rows match: the model must ask, not choose.
        const target = (input as { id?: unknown } | null)?.id;
        if (
          limited &&
          ((typeof target === 'string' && turn.ambiguous.has(target)) || ambiguousLookup(results.map((r) => r.output), target))
        ) {
          return { prepared: false, error: limited === 'deletion' ? AMBIGUOUS_DELETION : AMBIGUOUS_POOL_CHANGE };
        }
        // Last, the server's own rows (read above): two rows of one name that look the same cannot be told apart on a card.
        // When they can, the card says which one it is; that line is added when the card is shown, not kept here.
        if (checked && !checked.ok) return { prepared: false, error: checked.refusal };
        if (checkedPool && !checkedPool.ok) return { prepared: false, error: checkedPool.refusal };
        // Named from what this specialist just looked up, else from earlier turns.
        const find = (id: unknown, kind?: ItemKind) =>
          nameIn(results)(id, kind) ??
          (kind && typeof id === 'string' ? (team.names?.[`${kind}:${id}`] ?? null) : null);
        const proposal: Proposal = {
          id: crypto.randomUUID().slice(0, 8),
          product: product.key,
          action: name,
          input,
          title: approvalTitle(name, input, find),
          detail: approvalDetail(name, input, undefined, find),
        };
        team.proposals.set(proposal.id, proposal);
        prepared.push(proposal);
        if (limited) turn.prepared[limited].add(proposal.id);
        return { prepared: true, proposalId: proposal.id, card: proposal.title };
      },
    });
  }
  return tools;
}

/** The tool Tuah uses to hand a task to one specialist. */
function askTool(product: ProductToolkit, team: TeamContext, turn: TurnState): Tool {
  const canChange = Object.keys(product.write).length > 0;
  return tool({
    description:
      `Ask ${product.name}, the specialist for ${AREA[product.key]}, to look things up` +
      (canChange ? ' or to prepare a change' : '') +
      `. Give ${product.name} a complete task, with the names, amounts and details the user gave.`,
    inputSchema: z.object({
      task: z.string().min(1).describe('What to find out or prepare, in full.'),
    }),
    execute: async function* ({ task }, { abortSignal }) {
      const steps: AgentStep[] = [];
      const prepared: Proposal[] = [];
      const results: ToolResult[] = [];
      let answer = '';
      const snapshot = (status: Delegation['status']): Delegation => ({
        agent: product.name,
        product: product.key,
        status,
        steps: steps.map((step) => ({ ...step })),
        answer:
          answer.trim() || status === 'working' || prepared.length === 0
            ? answer
            : `Prepared: ${prepared.map((p) => p.title).join(' ')}`,
        proposals: [...prepared],
        ...(status === 'working' ? {} : { names: collectNames(results) }),
        ...(status !== 'working' && ambiguousIn(results).length > 0 && { ambiguous: ambiguousIn(results) }),
      });

      const given =
        (team.transcript ? `The conversation so far:\n${team.transcript}\n\n` : '') +
        `Task from Tuah: ${task}`;

      yield snapshot('working');
      try {
        const result = streamText({
          model: getModel('worker', team.apiKey),
          system: subAgentSystem(product.key, canChange),
          prompt: given,
          tools: specialistTools(product, team, results, prepared, given, turn),
          // A CV this specialist reads reaches its own model as a user file in the next step:
          // only a run whose messages hold the read is given the file, so never Tuah, never another delegation.
          prepareStep: prepareCvStep(product.cvShelf),
          // A prepared change is the whole report: stop there rather than
          // spend another call having the specialist describe it.
          stopWhen: [stepCountIs(8), () => prepared.length > 0],
          maxOutputTokens: 900,
          abortSignal,
          onLanguageModelCallEnd: logModelCall(product.name.toLowerCase(), pickModelId('worker')),
          // After a CV read the request holds the file: a failure is logged by its code, never whole.
          onError: logModelError(product.name.toLowerCase()),
        });
        for await (const part of result.fullStream) {
          if (part.type === 'tool-call') {
            steps.push({ tool: part.toolName, done: false });
            // Words said before a lookup are not the report.
            answer = '';
            yield snapshot('working');
          } else if (part.type === 'tool-result' || part.type === 'tool-error') {
            const open = steps.find((step) => step.tool === part.toolName && !step.done);
            if (open) open.done = true;
            yield snapshot('working');
          } else if (part.type === 'text-delta') {
            answer += part.text;
          } else if (part.type === 'error') {
            throw part.error;
          }
        }
        yield snapshot('done');
      } catch (error) {
        // The code only: a provider's message can quote the request, and a non-Error can be anything.
        console.error(`[tuah] ${product.name} could not finish:`, modelErrorCode(error));
        answer = 'Something went wrong while working on this. Try again in a moment.';
        yield snapshot('failed');
      }
    },
    toModelOutput: ({ output }) => ({
      type: 'text',
      value: delegationForModel(output as Delegation),
    }),
  }) as Tool;
}

const AREA: Record<ProductToolkit['key'], string> = {
  reach: 'marketing (ads, campaigns, creatives, leads, lead forms, appointments, ad settings)',
  crm: 'the CRM (contacts, deals, pipelines and their stages)',
  hire: 'hiring (jobs, candidates, applications, the hiring funnel, interviews, the talent pool; it can read one candidate\'s uploaded CV and give a verdict on it; it can prepare moving, rejecting, reopening or rating one application at a time; it can prepare adding or editing one candidate at a time; it can prepare deleting one application or one candidate at a time; it can prepare a talent pool change for one candidate at a time)',
  people: 'HR (existing staff, leave, time-off, claims, overtime, attendance, payroll, performance; it can prepare deciding leave, claims and overtime, correcting attendance, and editing staff and departments, one change at a time)',
};

/** Runs a prepared change through the product's own change tool, after checking its input again. */
async function apply(
  products: ProductToolkit[],
  team: TeamContext,
  proposal: Proposal | undefined,
  options: unknown,
): Promise<unknown> {
  if (!proposal) {
    return {
      ok: false,
      error: 'That prepared change was not found. Ask the specialist to prepare it again.',
    };
  }
  const product = products.find((p) => p.key === proposal.product);
  const change =
    product && Object.hasOwn(product.write, proposal.action)
      ? product.write[proposal.action]
      : undefined;
  const run = change ? executeOf(change) : undefined;
  if (!change || !run) {
    return { ok: false, error: 'You are not able to make that change in this workspace.' };
  }
  // A proposal read back from the conversation is checked like any other input.
  const parsed = (change.inputSchema as z.ZodType).safeParse(proposal.input);
  if (!parsed.success) {
    return { ok: false, error: 'That prepared change is no longer valid. Ask for it again.' };
  }
  const output = await run(parsed.data, options);
  if (team.names) collectNames([{ tool: proposal.action, output }], team.names);
  return output;
}

/**
 * Stands in for Tuah's model on the one step whose outcome is already
 * decided: a specialist has just prepared a single change, and the rule is to
 * put it in front of the user at once. It makes that `applyChange` call
 * without a round trip to a model, which is about two seconds the user would
 * otherwise wait for the Approve card.
 */
function applyStep(proposalId: string): LanguageModel {
  const usage = {
    inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 0, text: 0, reasoning: 0 },
  };
  const chunks = [
    {
      type: 'tool-call',
      toolCallId: `apply-${proposalId}`,
      toolName: APPLY_TOOL,
      input: JSON.stringify({ proposalId }),
    },
    { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage },
  ];
  return {
    specificationVersion: 'v4',
    provider: 'openkuasa',
    modelId: 'apply-prepared-change',
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error('apply-prepared-change only streams.');
    },
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      }),
    }),
  } as unknown as LanguageModel;
}

type StepLike = { toolResults: { toolName: string; output: unknown; preliminary?: boolean }[] };

/**
 * The single change to apply straight away after a step, if that is what the
 * step produced: every specialist asked has finished, and between them they
 * prepared exactly one change. Anything else is left to Tuah to think about.
 */
export function changeToApply(step: StepLike | undefined): Proposal | null {
  if (!step) return null;
  const reports = step.toolResults
    .filter((r) => r.toolName.startsWith(ASK_PREFIX) && r.toolName !== APPLY_TOOL && !r.preliminary)
    .map((r) => r.output);
  if (reports.length === 0 || !reports.every((r) => isDelegation(r) && r.status === 'done')) {
    return null;
  }
  const proposals = reports.flatMap((r) => (isDelegation(r) ? r.proposals : []));
  return proposals.length === 1 ? proposals[0] : null;
}

/** Tuah's tools when it works through its team, and which of them need approval. */
export function createTeamTools(
  products: ProductToolkit[],
  team: TeamContext,
  /** The conversation as this request received it: the turn in progress is read from it. */
  messages: readonly ModelMessage[] = [],
): {
  tools: ToolSet;
  toolApproval: Record<string, 'user-approval' | DeletionGate> | undefined;
  /** Chooses the model for a step: the scripted one when a single change is ready to apply. */
  prepareStep?: (options: { steps: StepLike[] }) => { model: LanguageModel } | undefined;
} {
  const tools: ToolSet = {};
  // Every specialist asked in this request, and applyChange, share what the turn holds.
  const turn = turnStateFrom(messages, team.proposals);
  for (const product of products) {
    tools[`${ASK_PREFIX}${product.name}`] = askTool(product, team, turn);
  }

  const anyChanges = products.some((p) => Object.keys(p.write).length > 0);
  if (!anyChanges) return { tools, toolApproval: undefined };

  tools[APPLY_TOOL] = tool({
    description:
      'Carry out a change a specialist prepared, by its proposalId. This shows the user an ' +
      'Approve / Reject card; nothing is saved until they approve. Needs approval.',
    inputSchema: z.object({
      proposalId: z.string().min(1).describe('The id the specialist reported.'),
    }),
    execute: async ({ proposalId }, options) =>
      apply(products, team, team.proposals.get(proposalId), options),
  });
  return {
    tools,
    // Only a team that can prepare a change held to one a turn needs the gate; any other keeps the plain card.
    toolApproval: {
      [APPLY_TOOL]: products.some((p) => Object.keys(p.write).some((name) => limitedKind(name) !== null))
        ? applyGate(products, team, turn)
        : 'user-approval',
    },
    prepareStep: ({ steps }) => {
      const proposal = changeToApply(steps[steps.length - 1]);
      return proposal ? { model: applyStep(proposal.id) } : undefined;
    },
  };
}
