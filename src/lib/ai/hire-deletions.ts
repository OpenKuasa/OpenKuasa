// src/lib/ai/hire-deletions.ts
/**
 * The two rules that hold a deletion back whoever prepares it: one deletion a
 * turn, and never from a lookup that said its name fits more than one row. A
 * prompt rule alone was not enough for either, so both are checked in code:
 * here for an agent that holds the tools itself, and in specialists.ts for
 * Tuah's team. No model, no database.
 */
import type { ModelMessage } from 'ai';
import { isHeldCvMessage } from '@/lib/ai/hire-tools';
import { nameIn } from '@/lib/chat/change-titles';
import { HIRE_READ_CAP, type HireData } from '@/lib/hire/types';

export const HIRE_DELETE_TOOL_NAMES = ['deleteApplication', 'deleteCandidate'] as const;

export const ONE_DELETION = 'One deletion at a time. One is already prepared for approval.';
export const AMBIGUOUS_DELETION =
  // No "look it up again": a later lookup cannot clear this in the same turn, and a model told to try would loop.
  'More than one match was found for that name, so no deletion was prepared. Stop here: say who matches and ask the user which one they mean. ' +
  'Once the user has said who, they can ask for the deletion again.';

/** What each delete tool removes. */
export type DeletionKind = 'application' | 'candidate';
export const kindOfDeletion = (tool: string): DeletionKind => (tool === 'deleteApplication' ? 'application' : 'candidate');

/** The refusal for an id that no lookup returned as this kind of thing. It tells the model which lookup to use. */
export function notLookedUp(kind: DeletionKind, id: unknown): string {
  return kind === 'application'
    ? `You have not looked up ${String(id)} as an application. Never guess an id: use listApplications ` +
        'to find the application and get its real id, then prepare the change again.'
    : `You have not looked up ${String(id)} as a candidate. Never guess an id: use listCandidates ` +
        'to find the candidate and get its real id, then prepare the change again.';
}

/**
 * True for a reason one of the checks in this file gave. A call denied with one
 * never became a card. Some reasons carry a name or an id, so they are known by
 * how they begin; a reason kept with a stored chat is cut at 500 characters,
 * which leaves every beginning whole.
 */
const GATE_REASON_STARTS = [
  'One deletion at a time.',
  'More than one match was found',
  'You have not looked up ',
  'More than one candidate is called ',
  'More than one application is from someone called ',
  'There are too many ',
  'I could not check ',
];
export function isGateReason(reason: unknown): boolean {
  return typeof reason === 'string' && GATE_REASON_STARTS.some((start) => reason.startsWith(start));
}

const isDeletion = (name: unknown): boolean =>
  typeof name === 'string' && (HIRE_DELETE_TOOL_NAMES as readonly string[]).includes(name);

/** True when a lookup result that holds this id also says its name matched several rows. */
export function ambiguousLookup(outputs: unknown[], id: unknown): boolean {
  if (typeof id !== 'string' || !id) return false;
  return outputs.some((output) => {
    let written: string;
    try {
      written = JSON.stringify(output) ?? '';
    } catch {
      return false;
    }
    return written.includes('"several_match"') && written.includes(id);
  });
}

/** Team mode: nothing else prepared in this delegation, and no deletion prepared earlier in this turn. */
export function oneDeletionRefusal(preparedHere: number, deletionsThisTurn: number): string | null {
  return preparedHere > 0 || deletionsThisTurn > 0 ? ONE_DELETION : null;
}

export type MessagePart = { type?: unknown; toolName?: unknown; toolCallId?: unknown; input?: unknown; output?: unknown };
type Part = MessagePart;
export const partsOf = (message: ModelMessage): Part[] =>
  Array.isArray(message.content) ? (message.content as unknown as Part[]) : [];

/**
 * The turn in progress: everything after the last thing the user said. A CV
 * the assistant fetched also sits in a user message (see `withHeldCvs`), in
 * the middle of a turn: that one is not the user speaking.
 */
export function thisTurn(messages: readonly ModelMessage[]): ModelMessage[] {
  let from = 0;
  messages.forEach((message, index) => {
    if (message.role === 'user' && !isHeldCvMessage(message)) from = index + 1;
  });
  return messages.slice(from);
}

/**
 * The calls in these messages that the gate below denied itself, by call id.
 * Such a call never became a card, so it is not the turn's one deletion: the
 * SDK asks the gate about an approved call again in the request that carries
 * the user's answer, and the denied call beside it is then in the messages.
 * Known by its reason, which is all that comes back in every form: in the same
 * request as `execution-denied`, from the browser as `error-text`.
 */
export function deniedHere(turn: readonly ModelMessage[]): Set<unknown> {
  const ids = new Set<unknown>();
  for (const message of turn) {
    if (message.role !== 'tool') continue;
    for (const part of partsOf(message)) {
      if (part.type !== 'tool-result') continue;
      const output = part.output as { type?: unknown; reason?: unknown; value?: unknown } | null | undefined;
      const reason =
        output?.type === 'execution-denied' ? output.reason : output?.type === 'error-text' ? output.value : undefined;
      if (isGateReason(reason)) ids.add(part.toolCallId);
    }
  }
  return ids;
}

/**
 * Why a deletion an agent has just called must not become a card, or null.
 * `messages` is the conversation as the agent has it; the call itself may or
 * may not be in it yet, so it is told apart by its id.
 */
export function deletionProblem(
  messages: readonly ModelMessage[],
  call: { toolCallId: string; id: unknown },
): string | null {
  const turn = thisTurn(messages);
  const denied = deniedHere(turn);
  const another = turn.some(
    (message) =>
      message.role === 'assistant' &&
      partsOf(message).some(
        (part) =>
          part.type === 'tool-call' &&
          isDeletion(part.toolName) &&
          // Itself: the same call id for the same row. A provider that reused a call id for another row would not pass.
          !(part.toolCallId === call.toolCallId && (part.input as { id?: unknown } | null | undefined)?.id === call.id) &&
          !denied.has(part.toolCallId),
      ),
  );
  if (another) return ONE_DELETION;
  const lookups = turn
    .filter((message) => message.role === 'tool')
    .flatMap(partsOf)
    .filter((part) => part.type === 'tool-result');
  return ambiguousLookup(lookups, call.id) ? AMBIGUOUS_DELETION : null;
}

/**
 * True when a lookup anywhere in the conversation returned this id as this
 * kind of thing. The whole conversation, not the turn: "delete the one you
 * listed" must work. A real id comes only from a lookup's result, so one typed
 * by the user, made up, or seen only as another kind of row does not pass. A
 * chat opened again whose listing was too long to keep needs a new lookup.
 */
export function lookedUp(messages: readonly ModelMessage[], kind: DeletionKind, id: unknown): boolean {
  if (typeof id !== 'string' || !id) return false;
  const results = messages
    .filter((message) => message.role === 'tool')
    .flatMap(partsOf)
    .filter((part) => part.type === 'tool-result' && typeof part.toolName === 'string')
    .map((part) => {
      const output = part.output as { type?: unknown; value?: unknown } | null | undefined;
      return { tool: part.toolName as string, output: output?.type === 'json' ? output.value : null };
    });
  return nameIn(results)(id, kind) !== null;
}

/*
 * Two rows the card could not tell apart. A card names a person (and, for an application, the job); when two rows
 * share that, a wrong id cannot be seen on the card, and approving it would delete the wrong one for good. So the
 * workspace's rows are read on the server when a deletion is asked for, and a shared name is refused before any
 * card. The read is the session's own (the one the lookups use), never what the model looked up or passed in.
 */
export const sameNameCandidate = (name: string) =>
  `More than one candidate is called ${name}, so I cannot tell them apart here. Delete the right one from the Candidates screen.`;
export const sameNameApplication = (name: string, job: string) =>
  `More than one application is from someone called ${name} for ${job}, so I cannot tell them apart here. Delete the right one from the Applications screen.`;
/** The read keeps the newest HIRE_READ_CAP rows: at the cap a namesake may be among those left out, so nothing can be said. */
export const TOO_MANY_CANDIDATES =
  'There are too many candidates here to be sure which one this is. Delete them from the Candidates screen.';
export const TOO_MANY_APPLICATIONS =
  'There are too many applications here to be sure which one this is. Delete it from the Applications screen.';
export const DELETION_CHECK_FAILED =
  'I could not check whether someone else has the same name just now, so no deletion was prepared. Try again in a moment.';

/** Two names are one when they differ only in letter case and in spacing. */
const sameText = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase();

/** Why this candidate cannot be told apart from another, or null. A row that is not there is left to the database to report. */
export function candidateNameProblem(rows: readonly { id: string; name: string }[], id: unknown): string | null {
  if (rows.length >= HIRE_READ_CAP) return TOO_MANY_CANDIDATES;
  const row = rows.find((r) => r.id === id);
  if (!row) return null;
  const name = sameText(row.name);
  return rows.some((r) => r.id !== row.id && sameText(r.name) === name) ? sameNameCandidate(row.name.trim()) : null;
}

/** The same for an application: another one from someone of the same name for the same job. */
export function applicationNameProblem(
  rows: readonly { id: string; candidate_name: string; job_title: string }[],
  id: unknown,
): string | null {
  if (rows.length >= HIRE_READ_CAP) return TOO_MANY_APPLICATIONS;
  const row = rows.find((r) => r.id === id);
  if (!row) return null;
  const [name, job] = [sameText(row.candidate_name), sameText(row.job_title)];
  return rows.some((r) => r.id !== row.id && sameText(r.candidate_name) === name && sameText(r.job_title) === job)
    ? sameNameApplication(row.candidate_name.trim(), row.job_title.trim())
    : null;
}

/** Asks the server whether a deletion's row can be told apart: the refusal, or null. Never throws. */
export type DeletionCheck = (tool: string, id: unknown) => Promise<string | null>;

export function deletionCheckFor(data: Pick<HireData, 'listCandidates' | 'listApplications'>): DeletionCheck {
  return async (tool, id) => {
    try {
      return kindOfDeletion(tool) === 'application'
        ? applicationNameProblem(await data.listApplications(), id)
        : candidateNameProblem(await data.listCandidates(), id);
    } catch {
      // Nothing of the error is logged: its words can hold a name.
      console.error('[lekir] the same-name check before a deletion could not read the rows');
      return DELETION_CHECK_FAILED;
    }
  };
}

type Decision = 'user-approval' | { type: 'denied'; reason: string };
/** The approval function both delete tools share (the SDK's per-tool approval function). */
export type DeletionGate = (
  input: unknown,
  options: { toolCallId: string; messages: ModelMessage[] },
) => Decision | Promise<Decision>;

/**
 * An agent's approval map with the two delete tools gated: the first deletion
 * of a request goes to the user as a card, and any other is denied before a
 * card exists. Built once per request, so the count starts at zero each time;
 * a deletion earlier in the same turn is found in the messages.
 *
 * The SDK calls the gate once per call, one after the other in the order the
 * model made them, with the messages that led to the step (the step's own
 * calls are not among them, hence the count). It calls it once more for a call
 * the user approved, at the start of the request that carries their answer:
 * that call is let through again and is then that request's one.
 */
export function guardDeletions(
  approval: Record<string, 'user-approval' | DeletionGate> | undefined,
  /** The server read that says whether the row can be told apart from another. Asked last, and only for a call nothing else refused. */
  check?: DeletionCheck,
): Record<string, 'user-approval' | DeletionGate> | undefined {
  if (!approval) return undefined;
  const names = HIRE_DELETE_TOOL_NAMES.filter((name) => name in approval);
  if (names.length === 0) return approval;
  let asked = 0;
  // One gate per tool, because the SDK does not say which tool it is asking about; one count between them.
  const gateFor = (tool: string): DeletionGate => async (input, { toolCallId, messages }) => {
    const id = (input as { id?: unknown } | null)?.id;
    const kind = kindOfDeletion(tool);
    // In this order: one a turn, then an id that was really looked up, then a lookup that was not ambiguous.
    const inTurn = asked > 0 ? ONE_DELETION : deletionProblem(messages, { toolCallId, id });
    const problem =
      inTurn === ONE_DELETION ? inTurn : ((lookedUp(messages, kind, id) ? null : notLookedUp(kind, id)) ?? inTurn);
    if (problem) return { type: 'denied', reason: problem };
    // The SDK waits for each call's answer before asking about the next, so the count is safe across this read.
    const unclear = check ? await check(tool, id) : null;
    if (unclear) return { type: 'denied', reason: unclear };
    asked += 1;
    return 'user-approval';
  };
  return { ...approval, ...Object.fromEntries(names.map((name) => [name, gateFor(name)])) };
}
