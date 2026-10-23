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
import { subAgentSystem, withToday } from '@/lib/ai/agents/prompts';
import { cachedInstructions } from '@/lib/ai/prompt-cache';
import { prepareCvStep } from '@/lib/ai/hire-tools';
import {
  AMBIGUOUS_DELETION,
  CHANGE_NOT_CHECKED,
  HIRE_DELETE_TOOL_NAMES,
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
import {
  AMBIGUOUS_INTERVIEW_CHANGE,
  HIRE_INTERVIEW_KIND_TOOL_NAMES,
  ONE_INTERVIEW_CHANGE,
  actsOnApplication,
  ambiguousFor,
  interviewCardDecision,
  interviewLinkProblem,
  interviewNotLookedUp,
  interviewTarget,
  rejectedByUser,
  sameInterviewTarget,
} from '@/lib/ai/hire-interview-gate';
import type { ProductToolkit } from '@/lib/ai/products';
import { FINANCE_ID_GATED, FINANCE_SAVE_GATED } from '@/lib/ai/finance-id-gate';
import { rosterIdProblem } from '@/lib/ai/roster-id-gate';
import { revalidateFinance } from '@/lib/ai/finance-revalidate';
import { logModelCall, logModelError, modelErrorCode } from '@/lib/ai/call-log';
import { getModel, pickModelId } from '@/lib/ai/provider';
import { changeRows } from '@/lib/chat/change-rows';
import {
  approvalDetail,
  approvalTitle,
  collectNames,
  knownOnFile,
  nameIn,
  rowIn,
  withoutPoolSide,
  type ItemKind,
  type KnownNames,
  type ToolResult,
} from '@/lib/chat/change-titles';
import { NOT_PREPARED, NOT_WAITING, type ProposalStore } from '@/lib/chat/proposal-store';
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
  /**
   * Changes prepared earlier in the conversation, by id, as the server recorded them (never as the conversation
   * describes them). New ones are added here. Used to word and to gate; the change that runs is taken from `store`.
   */
  proposals: Map<string, Proposal>;
  /** Where prepared changes are kept: one is recorded when it is prepared, and taken, once, when it is applied. */
  store: ProposalStore;
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
/** The six interview changes and the two changes to an interview's feedback: held to one a turn between them, and counted apart from the other two kinds. */
const INTERVIEW_CHANGES = new Set<string>(HIRE_INTERVIEW_KIND_TOOL_NAMES);

/** The kinds of change held to one a turn. Each is counted on its own: a deletion, a pool change and an interview change may share a turn. */
type Limited = 'deletion' | 'pool' | 'interview';
const limitedKind = (action: string): Limited | null =>
  DELETIONS.has(action) ? 'deletion' : POOL_CHANGES.has(action) ? 'pool' : INTERVIEW_CHANGES.has(action) ? 'interview' : null;
const ONE_A_TURN: Record<Limited, string> = { deletion: ONE_DELETION, pool: ONE_POOL_CHANGE, interview: ONE_INTERVIEW_CHANGE };
/** What each kind is refused with after a lookup that said several rows match. */
const AMBIGUOUS: Record<Limited, string> = { deletion: AMBIGUOUS_DELETION, pool: AMBIGUOUS_POOL_CHANGE, interview: AMBIGUOUS_INTERVIEW_CHANGE };

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

/**
 * Every id that a lookup among these returned while saying its name fits several rows. A result that says which
 * rows it means (an interview list with two of one person's) holds back those alone; any other, every id in it.
 */
function ambiguousIn(results: ToolResult[]): string[] {
  return [...new Set(results.flatMap((r) => idsIn(r.output).filter((id) => ambiguousFor([r.output], id))))];
}

/**
 * The turn's state as a request finds it. The browser sends the chat back whole, so the turn's earlier request is
 * in these messages: what a specialist reported (its prepared changes and its ambiguous lookups), and each
 * `applyChange` call. A call the gate itself denied was never shown to the user and is not counted.
 */
function turnStateFrom(messages: readonly ModelMessage[], proposals: Map<string, Proposal>): TurnState {
  const state: TurnState = {
    prepared: { deletion: new Set(), pool: new Set(), interview: new Set() },
    shown: { deletion: new Map(), pool: new Map(), interview: new Map() },
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

/** The changes specialists reported preparing, by id, as the reports in these messages hold them. */
function describedIn(messages: readonly ModelMessage[]): Map<string, Proposal> {
  const found = new Map<string, Proposal>();
  for (const message of messages) {
    if (message.role !== 'tool') continue;
    for (const part of partsOf(message)) {
      if (part.type !== 'tool-result' || typeof part.toolName !== 'string' || !part.toolName.startsWith(ASK_PREFIX)) continue;
      const output = part.output as { type?: unknown; value?: unknown } | null | undefined;
      const report = output?.type === 'json' ? output.value : null;
      if (isDelegation(report)) for (const proposal of report.proposals) found.set(proposal.id, proposal);
    }
  }
  return found;
}

/**
 * The approval for `applyChange`: a card for the user, except a change of a kind held to one a turn (a deletion, a
 * talent pool change, an interview change) beside another of the same kind in the same turn, which is denied before a card exists.
 * "Another" is one a specialist prepared in this turn or one already put to the user in it, under a different
 * proposal; the same proposal asked for again under a new call is another too. The SDK asks again about a call the
 * user approved, when their answer arrives: same proposal, same call, so it passes.
 */
function applyGate(products: ProductToolkit[], team: TeamContext, turn: TurnState, gated: Set<string>): DeletionGate {
  return async (input, { toolCallId, messages }) => {
    const id = (input as { proposalId?: unknown } | null)?.proposalId;
    const proposal = typeof id === 'string' ? team.proposals.get(id) : undefined;
    // A finance write acts on a row the caller must have looked up (issue #225). The row id is in the stored
    // proposal, not in the messages here, so it is checked on the server by reading the row: a hallucinated or
    // foreign id fails this read before any card is drawn. Finance is not a limited kind, so without this it would
    // fall straight through the early return below to a card. A settled or lapsed proposal (input === null) is left
    // to `apply`'s own NOT_WAITING: reading `undefined` would otherwise mislabel it "that row does not exist".
    if (proposal && proposal.input != null) {
      const tk = products.find((p) => p.key === proposal.product);
      if (tk?.checkFinanceId) {
        const target = (proposal.input as { id?: unknown } | null)?.id;
        if (!(await tk.checkFinanceId(proposal.action, target))) {
          return { type: 'denied', reason: 'That row does not exist for you. Look it up first, then prepare the change again.' };
        }
      }
    }
    const kind = proposal ? limitedKind(proposal.action) : null;
    // A change of no limited kind has no check here: its record was seen, and it goes to the user as before.
    if (proposal && !kind) gated.add(proposal.id);
    if (!proposal || !kind) return 'user-approval';
    // A record that was already answered (approved, rejected or lapsed) keeps its tool and loses its arguments. There
    // is then no row to check and nothing that could run: said as what it is, before any check could read "no id" as
    // "the interview is gone". It was not shown in this turn, so it is not the turn's one.
    // The other way for the person: ask for the change again; it is prepared anew.
    if (proposal.input === null || proposal.input === undefined) return { type: 'denied', reason: NOT_WAITING };
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
        : kind === 'pool'
          ? (product?.checkPoolChange ? poolCardDecision(await product.checkPoolChange(proposal.action, target), was) : 'user-approval')
          // The whole input, not an id: two of the eight name an application and six an interview, and the check knows which.
          : (product?.checkInterviewChange ? interviewCardDecision(await product.checkInterviewChange(proposal.action, proposal.input), was) : 'user-approval');
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
    // The record was seen and every check of its kind ran on it in this request: only now may `apply` take it.
    gated.add(proposal.id);
    // What a check binds is the record's (kept when the change was prepared), never the SDK's: the answer goes on without it.
    return typeof decision === 'object' ? { type: 'user-approval', reason: decision.reason } : decision;
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
  /** The conversation as Tuah's request received it: where a link the user typed is. */
  messages: readonly ModelMessage[],
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
        // The same for an interview change: which interview it is, and whether another could be taken for it.
        // Read here, with the other waits, so everything below still runs without a pause.
        const checkedInterview = INTERVIEW_CHANGES.has(name)
          ? await product.checkInterviewChange?.(name, input)
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
        // A roster, hours, shift type or swap change: each id must have been looked up as what it is (an employee from
        // the directory, a type from listShiftTypes, a shift from listSwapOptions, a swap from listShiftSwaps).
        const rosterProblem = product.key === 'people' ? rosterIdProblem(name, input, nameIn(results), team.names) : null;
        if (rosterProblem) return { prepared: false, error: rosterProblem };
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
        if (INTERVIEW_CHANGES.has(name)) {
          // A new interview names an application, from listApplications; the other six name an interview, from
          // listInterviews or from the result of the change that made it. In this delegation or an earlier turn;
          // never an id seen as the other kind.
          const id = interviewTarget(name, input);
          if (actsOnApplication(name)) {
            const asApplication =
              typeof id === 'string' && (team.names?.[`application:${id}`] || nameIn(results)(id, 'application'));
            if (!asApplication) {
              return { prepared: false, error: notLookedUp('application', id) };
            }
          } else {
            const asInterview =
              typeof id === 'string' && (team.names?.[`interview:${id}`] || nameIn(results)(id, 'interview'));
            if (!asInterview) {
              return { prepared: false, error: interviewNotLookedUp(id) };
            }
          }
        }
        // A lookup in this turn that holds the id and says several rows match: the model must ask, not choose.
        const target = INTERVIEW_CHANGES.has(name) ? interviewTarget(name, input) : (input as { id?: unknown } | null)?.id;
        if (
          limited &&
          ((typeof target === 'string' && turn.ambiguous.has(target)) || ambiguousFor(results.map((r) => r.output), target))
        ) {
          return { prepared: false, error: AMBIGUOUS[limited] };
        }
        // A link in the place must be one somebody gave: typed by the user since the last interview card was shown to
        // them, or already the place of the very interview being changed, as a lookup of this specialist returned
        // it. Not `given`: the task Tuah wrote, and Tuah's words in the transcript, are not the user typing. Not a
        // link typed for an earlier interview, and not another interview's. Not the rest of a lookup: a cover letter
        // is a stranger's text. Here a card is an `applyChange` call for an interview change a specialist prepared.
        // The other way for the person: give the link again in their next message, or add it on the Interviews screen.
        // A card the user rejected for this very application or interview does not close it: a correction keeps the link.
        const rejected = rejectedByUser(messages);
        const wasInterviewCard = (call: { toolName?: unknown; toolCallId?: unknown; input?: unknown }) => {
          const id = call.toolName === APPLY_TOOL ? (call.input as { proposalId?: unknown } | null | undefined)?.proposalId : undefined;
          // Whether it was an interview change is the server's record's to say, when there is one. A record is not
          // kept for ever (old ones are cleared, and a failed read answers nothing), and a missing record must
          // never read as "no card was shown": the kind is then taken from the specialist's own report in the
          // conversation, as it was before records were kept. That report comes back through the browser; a forged
          // one could at most keep that user's own link, for a card that still shows it and still needs their yes.
          const reported = typeof id === 'string' ? describedIn(messages).get(id) : undefined;
          const shown = (typeof id === 'string' ? team.proposals.get(id) : undefined) ?? reported;
          if (!shown || !INTERVIEW_CHANGES.has(shown.action)) return false;
          if (!rejected.has(call.toolCallId)) return true;
          // A record that was answered no longer holds its arguments (proposal-store.ts). Which row the rejected
          // card was about is then read from the report too, and all it can do is keep the link for the same row.
          const was = shown.input ?? (reported?.action === shown.action ? reported.input : null);
          return !sameInterviewTarget(shown.action, was, name, input);
        };
        // And the interviewer is a name: a link in it would reach the candidate unchecked, so it is refused outright.
        const linked = INTERVIEW_CHANGES.has(name) ? interviewLinkProblem(messages, name, input, results, wasInterviewCard) : null;
        if (linked) return { prepared: false, error: linked };
        // Last, the server's own rows (read above): two rows of one name that look the same cannot be told apart on a card.
        // When they can, the card says which one it is; that line is added when the card is shown, not kept here.
        if (checked && !checked.ok) return { prepared: false, error: checked.refusal };
        if (checkedPool && !checkedPool.ok) return { prepared: false, error: checkedPool.refusal };
        if (checkedInterview && !checkedInterview.ok) return { prepared: false, error: checkedInterview.refusal };
        // Named from what this specialist just looked up, else from earlier turns.
        const find = (id: unknown, kind?: ItemKind) =>
          nameIn(results)(id, kind) ??
          (kind && typeof id === 'string' ? (team.names?.[`${kind}:${id}`] ?? null) : null);
        const proposal: Proposal = {
          // The id of the server's record of this change: what an approval names.
          id: crypto.randomUUID(),
          product: product.key,
          action: name,
          input,
          title: approvalTitle(name, input, find),
          detail: approvalDetail(name, input, undefined, find),
          // Every value it carries, from the input itself, beside what this specialist's lookups showed is there now.
          changes: changeRows(name, input, find, rowIn(results)),
        };
        team.proposals.set(proposal.id, proposal);
        prepared.push(proposal);
        if (limited) turn.prepared[limited].add(proposal.id);
        // Its place is held above without a pause; now it is recorded. An approval is answered from this record,
        // so a change that could not be recorded is withdrawn and never reaches a card: a deletion or a talent
        // pool change gives its one place in the turn back, like any other.
        // With what the server read binds to it (the version of the feedback the card was made from): kept on the
        // record, never on the proposal the browser and the models see.
        const bound = checkedInterview?.ok ? checkedInterview.bound : undefined;
        const kept = await team.store.record({ id: proposal.id, product: product.key, action: name, input, ...(bound ? { bound } : {}) });
        if (!kept) {
          team.proposals.delete(proposal.id);
          prepared.splice(prepared.indexOf(proposal), 1);
          if (limited) turn.prepared[limited].delete(proposal.id);
          return { prepared: false, error: NOT_PREPARED };
        }
        return { prepared: true, proposalId: proposal.id, card: proposal.title };
      },
    });
  }
  return tools;
}

/** The tool Tuah uses to hand a task to one specialist. */
function askTool(product: ProductToolkit, team: TeamContext, turn: TurnState, messages: readonly ModelMessage[]): Tool {
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

      const specialistPrompt = subAgentSystem(product.key, canChange);
      yield snapshot('working');
      try {
        const result = streamText({
          model: getModel('worker', team.apiKey),
          // A specialist's prompt is the same for every task of its kind: marked for the provider's cache.
          // Today's date follows it, unmarked, so "this week" or "esok" in Tuah's task resolves to the right day.
          system: cachedInstructions(withToday(specialistPrompt, new Date()), specialistPrompt),
          prompt: given,
          tools: specialistTools(product, team, results, prepared, given, turn, messages),
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

export const AREA: Record<ProductToolkit['key'], string> = {
  reach: 'marketing (ads, campaigns, creatives, leads, lead forms, appointments, ad settings)',
  crm: 'the CRM (contacts, deals, pipelines and their stages)',
  hire: 'hiring (jobs, candidates, applications, the hiring funnel, interviews, the talent pool; it can read one candidate\'s uploaded CV and give a verdict on it; it can prepare moving, rejecting, reopening or rating one application at a time; it can prepare recording or clearing the feedback on one interview at a time; it can prepare adding or editing one candidate at a time; it can prepare scheduling, changing, cancelling or closing one interview at a time, or recording one that already took place; it can prepare deleting one application or one candidate at a time; it can prepare a talent pool change for one candidate at a time)',
  people: 'HR (existing staff, leave, time-off, claims, overtime, attendance, timesheets, shift rosters, shift types and shift swaps, payroll, performance; a manager sees and decides their direct reports\' leave, time-off, claims and overtime; it can prepare deciding leave, time-off, claims and overtime, correcting attendance, editing staff and departments, setting a week\'s shifts, logging hours, adding or changing shift types, and asking for, answering, deciding or cancelling a shift swap, one change at a time)',
  finance: 'finance (sales invoices and quotations, supplier bills, payments in and out, credit notes, refunds, customers and suppliers, items, bank and cash accounts, RFQs and purchase orders, chart of accounts, ledger and manual journals, financial reports (P&L, balance sheet, trial balance, cash flow, aged receivables/payables); it can prepare drafting, posting and voiding invoices and bills, recording payments, issuing credit notes and refunds, managing customers, suppliers and items, handling RFQs and purchase orders and manual journals, each with approval)',
};

/**
 * Runs a prepared change through the product's own change tool. The change is the server's record of it, taken
 * here once: which product, which tool and which arguments all come from that record, and nothing from the
 * conversation the browser sent. A change with no waiting record does not run.
 */
async function apply(
  products: ProductToolkit[],
  team: TeamContext,
  proposalId: string,
  options: unknown,
  /** The proposals whose record `applyGate` saw, and let through, in this request. */
  gated: ReadonlySet<string>,
): Promise<unknown> {
  // The gate decides from the records the request was given (`team.proposals`); this takes a record straight from
  // the store. The two can disagree: the read behind `team.proposals` answers nothing when it fails, and the take a
  // moment later can still work. A deletion, a talent pool change or an interview change would then run without its
  // last check (the row changed since the card, the person left the pool, a second one in the turn). So a record the
  // gate did not see in this request is looked at before it is taken, and one of a limited kind is left waiting.
  // It cannot be got round by a failed read: the only way to `claim` below is to be in `gated`, which the gate fills
  // after its checks, or to be read here and found to be of a kind that has no gate. A record that cannot be read
  // here either is not taken at all.
  if (!gated.has(proposalId)) {
    const seen = (await team.store.peek([proposalId])).get(proposalId);
    if (!seen) return { ok: false, error: NOT_WAITING };
    if (limitedKind(seen.action)) return { ok: false, error: CHANGE_NOT_CHECKED };
    // Finance is not a limited kind, but its id-safety is the existence check `applyGate` runs, and the gate runs
    // it only for a record it saw in `team.proposals`. A record it did not see (the read/take disagreement above)
    // would otherwise reach `claim` on an id the gate never checked. So an id-gated finance write is left waiting
    // too, exactly as a limited kind is. A pure create (a save with no id) has no row to check and is let through.
    const financeIdGated =
      seen.action in FINANCE_ID_GATED ||
      (seen.action in FINANCE_SAVE_GATED && (seen.input as { id?: unknown } | null)?.id != null);
    if (financeIdGated) return { ok: false, error: CHANGE_NOT_CHECKED };
  }
  const stored = await team.store.claim({ id: proposalId });
  if (!stored) return { ok: false, error: NOT_WAITING };
  const proposal = { product: stored.product, action: stored.action, input: stored.input };
  const product = products.find((p) => p.key === proposal.product);
  const change =
    product && Object.hasOwn(product.write, proposal.action)
      ? product.write[proposal.action]
      : undefined;
  const run = change ? executeOf(change) : undefined;
  if (!change || !run) {
    return { ok: false, error: 'You are not able to make that change in this workspace.' };
  }
  // Checked like any other input before it runs.
  const parsed = (change.inputSchema as z.ZodType).safeParse(proposal.input);
  if (!parsed.success) {
    return { ok: false, error: 'That prepared change is no longer valid. Ask for it again.' };
  }
  // What the server bound when it prepared the change goes beside the SDK's options, where no argument can reach.
  const output = await run(parsed.data, stored.bound ? { ...(options as object), bound: stored.bound } : options);
  if (team.names) collectNames([{ tool: proposal.action, output }], team.names);
  // An AI-applied finance write bypasses the finance forms' own revalidatePath calls, so refresh the screens
  // it changed here — only on success, and only for finance (see finance-revalidate.ts).
  if (proposal.product === 'finance' && (output as { ok?: unknown } | null)?.ok) revalidateFinance(proposal.action);
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
  // The proposals `applyGate` saw the record of, and let through, in this request: what `apply` may take.
  const gated = new Set<string>();
  for (const product of products) {
    tools[`${ASK_PREFIX}${product.name}`] = askTool(product, team, turn, messages);
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
    execute: async ({ proposalId }, options) => apply(products, team, proposalId, options, gated),
  });
  return {
    tools,
    // A team that can prepare a change held to one a turn needs the gate; so does one with finance writes, whose
    // id-safety is the server check `applyGate` runs (finance is not a limited kind, so this install condition must
    // name it or the check never runs). Any other team keeps the plain card.
    toolApproval: {
      [APPLY_TOOL]:
        products.some((p) => Object.keys(p.write).some((name) => limitedKind(name) !== null)) ||
        products.some((p) => p.checkFinanceId)
          ? applyGate(products, team, turn, gated)
          : 'user-approval',
    },
    prepareStep: ({ steps }) => {
      const proposal = changeToApply(steps[steps.length - 1]);
      return proposal ? { model: applyStep(proposal.id) } : undefined;
    },
  };
}
