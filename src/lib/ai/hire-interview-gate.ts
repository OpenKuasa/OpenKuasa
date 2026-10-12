// src/lib/ai/hire-interview-gate.ts
/**
 * The rules that hold an interview change back whoever prepares it: one a
 * turn, only for an id a lookup really returned as the right kind of thing,
 * never from a lookup that said its name fits more than one row, and never
 * with a meeting link nobody gave. A prompt rule alone was not enough for the
 * first three, so all are checked in code: here for an agent that holds the
 * tools itself, and in specialists.ts for Tuah's team.
 *
 * This is the third kind of change on the machinery built for deletions
 * (hire-deletions.ts) and widened for the talent pool (hire-pool-gate.ts). It
 * is the same code, not a second gate: what a turn is, which calls a gate
 * denied, which were stopped after the user's yes, and what a lookup said, are
 * all asked of those files.
 *
 * Two things are the interview's own. The second: one person can have two
 * scheduled interviews, and a name does not say which. A lookup that holds
 * two says so (`several_match`), and a change to either is held back for the
 * rest of the turn; and whenever a card is shown, it lists what else is
 * scheduled with that person, read on the server, so the person deciding sees
 * that there is another. The first: every card about an interview that already
 * exists carries a line that says which interview it is: its day, its time and
 * how it is held, read on the server by the interview's id and never taken
 * from what the model looked up or passed in. One application can rightly have
 * two interviews, so that line is always there, not only when a name is
 * shared. It travels on the approval request, which goes to the browser and is
 * left out of what any model is sent. When another application shares the
 * candidate's name and the job, the deletion gate's line for the application
 * follows it, and that one can hold an email.
 *
 * Every sentence here begins as one of the starts in hire-deletions.ts
 * (`GATE_REASON_STARTS`): that is how a call this gate denied is told from one
 * the user rejected, when the turn is read back.
 */
import type { ModelMessage } from 'ai';
import {
  ambiguousLookup, cardCheck, cardShown, deniedHere, notLookedUp, partsOf, thisTurn,
  type CardCheck, type Decision, type DeletionGate,
} from '@/lib/ai/hire-deletions';
import { lookedUpAs } from '@/lib/ai/hire-pool-gate';
import { isHeldCvMessage } from '@/lib/ai/hire-tools';
import { THIS_INTERVIEW, alsoScheduledLines, interviewFullLine, interviewLine } from '@/lib/hire/interviews';
import { interviewCardFromLists, namesakesFromLists } from '@/lib/hire/namesakes';
import type { HireData, Namesakes } from '@/lib/hire/types';

export const HIRE_INTERVIEW_TOOL_NAMES = [
  'scheduleInterview', 'recordPastInterview', 'rescheduleInterview', 'cancelInterview', 'setInterviewOutcome', 'reopenInterview',
] as const;

// Each refusal leaves the person another way. It is said beside the sentence, and where the person reads it.

/** The other way: answer the card that is showing, then ask for the next one (the next message is a new turn); or use the Interviews screen. */
export const ONE_INTERVIEW_CHANGE = 'One interview change at a time. One is already prepared for approval.';
/** The other way: say which one, by job, day or time; the assistant asks. */
export const AMBIGUOUS_INTERVIEW_CHANGE =
  // No "look it up again": a later lookup cannot clear this in the same turn, and a model told to try would loop.
  'More than one match was found for that name, so no interview change was prepared. Stop here: say which match and ask the user which one they mean. ' +
  'Once the user has said which, they can ask again.';
/** The refusal for an id that no lookup returned as an interview. It tells the model which lookup to use; the person need do nothing. */
export const interviewNotLookedUp = (id: unknown) =>
  `You have not looked up ${String(id)} as an interview. Never guess an id: use listInterviews ` +
  'to find the interview and get its real id, then prepare the change again.';
/** The other way: type the link, or go ahead without one and add it later with "Reschedule or edit". */
export const LINK_NOT_GIVEN =
  'That link was not given by the user, so no interview change was prepared. Ask the user for the link, or prepare it without one.';
/**
 * The other way is in the sentence: the menu on the interview's own row acts on that row's id, whatever it looks like.
 * It is also what scheduling or recording is refused with when two applications look the same (there is no row then):
 * that person's other way is "Schedule interview" or "Record a past interview" in the application's own details on the
 * Applications screen, which act on that application's id.
 */
export const lookTheSameInterviews = (name: string, job: string) =>
  `Two interviews with ${name} for ${job} look the same from here, so I cannot tell them apart. Nothing was changed. ` +
  'Use the menu on the interview\'s own row on the Interviews screen.';
/**
 * The interview is not there: it was deleted, or its application was (its interviews go with it; from an
 * interview's id alone the two cannot be told apart). Written for a person as it is. There is no other way and none
 * is needed: there is nothing left to change, and the sentence says where to see what is still there.
 */
export const INTERVIEW_GONE =
  'This interview no longer exists: it was deleted, or the application it belonged to was. Nothing was changed, and there is nothing left to change. ' +
  'The Interviews screen shows what is still there.';
/**
 * A change of time or details for an interview whose application was rejected or withdrawn: the database would refuse
 * it only after the user's yes. The other way is in the sentence: reopen the application, or cancel the interview
 * (cancelling, marking and reopening an interview do not need an active application).
 */
export const APPLICATION_NOT_ACTIVE =
  'The application this interview belongs to is no longer active, so the interview\'s time and details cannot be changed. Nothing was changed. ' +
  'Reopen the application first, or cancel the interview instead.';
/** The other way: ask again in a moment, or use the Interviews screen, which does not depend on this read. */
export const INTERVIEW_CHECK_FAILED = 'I could not check which interview this is just now, so no change was prepared. Try again in a moment.';
/** The other way: ask again; the new card shows the interview as it is now. */
export const INTERVIEW_CHANGED_SINCE =
  'This interview was changed after the card was shown, so a last check stopped it. Nothing was changed. ' +
  'Prepare it again: the card will show it as it is now.';

const isInterviewChange = (name: unknown): boolean =>
  typeof name === 'string' && (HIRE_INTERVIEW_TOOL_NAMES as readonly string[]).includes(name);

/** The two that make an interview: there is none yet, so they name an application. The other four name an interview. */
const ON_APPLICATION = new Set<string>(['scheduleInterview', 'recordPastInterview']);
export const actsOnApplication = (tool: unknown): boolean => typeof tool === 'string' && ON_APPLICATION.has(tool);

/** The id of the row a change is about: the application's for the two that make an interview, the interview's for the rest. */
export function interviewTarget(tool: unknown, input: unknown): unknown {
  const given = (input && typeof input === 'object' ? input : {}) as { id?: unknown; application_id?: unknown };
  return actsOnApplication(tool) ? given.application_id : given.id;
}

/** The ids a lookup's result says its `several_match` is about, or null when it names none (then it is about every row). */
function severalIdsOf(output: unknown): unknown[] | null {
  const at = (value: unknown): unknown => (value && typeof value === 'object' ? (value as { several_ids?: unknown }).several_ids : undefined);
  // A result as a tool returned it, or as the part of a message that carries it.
  const inner = (output as { output?: { value?: unknown } } | null | undefined)?.output?.value;
  const ids = at(output) ?? at(inner);
  return Array.isArray(ids) ? ids : null;
}

/**
 * True when a lookup result that holds this id says more than one row fits, and means this row. The deletion gate's
 * rule (`ambiguousLookup`), with one thing more: a plain list of interviews can hold two of one person's beside
 * other people's, and then says which ids it means (`several_ids`); the others in that list are not held back.
 * The other way for the person whose change is held back: say which one, in the next message.
 */
export function ambiguousFor(outputs: unknown[], id: unknown): boolean {
  return outputs.some((output) => {
    if (!ambiguousLookup([output], id)) return false;
    const only = severalIdsOf(output);
    return only === null || only.includes(id);
  });
}

/**
 * Why an interview change an agent has just called must not become a card, or
 * null. `messages` is the conversation as the agent has it; the call itself may
 * or may not be in it yet, so it is told apart by its id. `call.id` is the id
 * of the row it is about (`interviewTarget`).
 */
export function interviewChangeProblem(
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
          isInterviewChange(part.toolName) &&
          // Itself: the same call id for the same row.
          !(part.toolCallId === call.toolCallId && interviewTarget(part.toolName, part.input) === call.id) &&
          !denied.has(part.toolCallId),
      ),
  );
  if (another) return ONE_INTERVIEW_CHANGE;
  const lookups = turn
    .filter((message) => message.role === 'tool')
    .flatMap(partsOf)
    .filter((part) => part.type === 'tool-result');
  // Any lookup: an interview's row holds its application's id, so an application found inside an ambiguous interview
  // lookup is held back too. It fails safe; the user says which, and the next message is a new turn.
  return ambiguousFor(lookups, call.id) ? AMBIGUOUS_INTERVIEW_CHANGE : null;
}

const LINK = /https?:\/\/\S+/gi;
/** What ends a sentence or closes a bracket is not part of a link someone typed: "Use https://meet.example.com/abc." */
const CLOSING = /[.,;:!?)\]}>'"”’]+$/;

/** Every link in a text, each without the punctuation that follows it. */
export function linksIn(text: unknown): string[] {
  if (typeof text !== 'string') return [];
  return (text.match(LINK) ?? []).map((link) => link.replace(CLOSING, '')).filter((link) => /^https?:\/\/./i.test(link));
}

/** Every string anywhere in a value, such as a tool's result. */
export function stringsIn(value: unknown, depth = 0): string[] {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object' || depth > 6) return [];
  return Object.values(value).flatMap((inner) => stringsIn(inner, depth + 1));
}

/**
 * A link as it is compared: the scheme and the host in lower case (they are the same address in any case), a port
 * that is the scheme's own left out, and no closing slash on the path. Nothing else is touched: the letter case of a
 * path or a query can be a meeting's code or its password, and a login part in front of a host names another place.
 * Text that is not a link after all is compared as it is.
 */
export function sameLink(link: string): string {
  try {
    const url = new URL(link);
    const login = url.username ? `${url.username}${url.password ? `:${url.password}` : ''}@` : '';
    return `${url.protocol}//${login}${url.host}${url.pathname.replace(/\/+$/, '')}${url.search}${url.hash}`;
  } catch {
    return link;
  }
}

/** Every string held under a key called `place`, anywhere in a value. */
export function placesIn(value: unknown, depth = 0): string[] {
  if (!value || typeof value !== 'object' || depth > 6) return [];
  if (Array.isArray(value)) return value.flatMap((inner) => placesIn(inner, depth + 1));
  return Object.entries(value).flatMap(([key, inner]) => (key === 'place' ? stringsIn(inner, depth + 1) : placesIn(inner, depth + 1)));
}

/** The tools whose results hold an interview's row: the lookup, and the six changes. */
const INTERVIEW_RESULTS = new Set<string>(['listInterviews', ...HIRE_INTERVIEW_TOOL_NAMES]);

/**
 * The place of every interview in these tool results. Only the results of
 * the interview lookup and of the six interview changes are read, and of
 * those only the `place`: a link there was typed by someone in the team, or
 * approved on a card. Nothing else a tool returns counts, because much of it
 * is a stranger's text: a cover letter, a CV link, a portfolio link, a
 * headline. An interview's notes do not count either: they are the team's
 * own, and are never shown to a candidate.
 */
export function interviewPlacesIn(results: readonly { tool: string; output: unknown }[]): string[] {
  return results.filter((result) => INTERVIEW_RESULTS.has(result.tool)).flatMap((result) => placesIn(result.output));
}

/**
 * True when `place` holds a link that nobody gave. A link passes only when the
 * same link (`sameLink`) is in something the user typed in this conversation,
 * or is the place of an interview a tool of the app returned
 * (`interviewPlacesIn`). Not counted, because none of them is the user typing:
 * a CV the assistant fetched (it sits in a user message, see
 * `isHeldCvMessage`), anything an assistant wrote, a tool call's input, a
 * denial or an error, any other part of a lookup's result (a cover letter, a
 * CV link, a portfolio link, notes), and a specialist's written report to Tuah
 * (the result of an `ask…` tool).
 *
 * `extra` is more text that counts. Team mode uses it for the places of the
 * interviews a specialist looked up in this delegation, which are not in
 * Tuah's messages. The task Tuah wrote is never passed: it is not the user
 * typing.
 *
 * The other way for the person, when a link is refused: type it, or go ahead
 * without one and add it later with "Reschedule or edit" on the Interviews
 * screen, whose form takes any link.
 */
export function linkNobodyGave(messages: readonly ModelMessage[], place: unknown, extra = ''): boolean {
  const wanted = linksIn(place);
  if (wanted.length === 0) return false;
  const given = new Set<string>(linksIn(extra).map(sameLink));
  const take = (text: unknown) => {
    for (const link of linksIn(text)) given.add(sameLink(link));
  };
  for (const message of messages) {
    if (message.role === 'user' && !isHeldCvMessage(message)) {
      if (typeof message.content === 'string') take(message.content);
      else for (const part of partsOf(message) as { type?: unknown; text?: unknown }[]) if (part.type === 'text') take(part.text);
    } else if (message.role === 'tool') {
      for (const part of partsOf(message)) {
        if (part.type !== 'tool-result' || typeof part.toolName !== 'string') continue;
        const output = part.output as { type?: unknown; value?: unknown } | null | undefined;
        if (output?.type !== 'json') continue;
        for (const text of interviewPlacesIn([{ tool: part.toolName, output: output.value }])) take(text);
      }
    }
  }
  return wanted.some((link) => !given.has(sameLink(link)));
}

/**
 * Asks the server about an interview change's row. Given the tool's whole
 * input, not an id: two of the six tools name an application and four an
 * interview, and the check, not each of its three callers, knows which key
 * holds the row's id. Nothing else of the input is read. Never throws.
 */
export type InterviewCheck = (tool: string, input: unknown) => Promise<CardCheck>;

export function interviewCheckFor(
  data: Pick<HireData, 'listCandidates' | 'listApplications' | 'listInterviews' | 'namesakes' | 'interviewCard'>,
): InterviewCheck {
  // A provider over a database reads by id and by name. One that holds every row (the sample data) is asked for its lists.
  const applicationAndNamesakes = async (id: unknown): Promise<Namesakes> =>
    data.namesakes
      ? data.namesakes('application', id)
      : namesakesFromLists('application', id, await data.listCandidates(), await data.listApplications());
  return async (tool, input) => {
    const id = interviewTarget(tool, input);
    try {
      if (actsOnApplication(tool)) {
        // No interview yet, so no line of its own: the deletion gate's rule for an application, as it is. Only the
        // words of its one refusal are this gate's.
        const found = await applicationAndNamesakes(id);
        const check = cardCheck(found);
        return check.ok
          ? check
          : { ok: false, refusal: lookTheSameInterviews(found.target?.name.trim() ?? '', found.target?.job?.trim() ?? '') };
      }
      const { target, others, cut, also, application_outcome: outcome } = data.interviewCard
        ? await data.interviewCard(id)
        : interviewCardFromLists(id, await data.listInterviews());
      // Not there (deleted since it was listed, or since its card was shown): there is no line to put on a card.
      if (!target) return { ok: false, refusal: INTERVIEW_GONE };
      // Its time and details can be changed only while its application is active. Said here, before a card and again
      // when the user's yes arrives, rather than by the database after it.
      if (tool === 'rescheduleInterview' && (outcome === 'rejected' || outcome === 'withdrawn')) {
        return { ok: false, refusal: APPLICATION_NOT_ACTIVE };
      }
      // Two read the same when their day, time and type do: that is what a person asks for one by.
      const line = interviewLine(target.scheduled_at, target.kind);
      const twins = others.filter((other) => other.id !== target.id && interviewLine(other.scheduled_at, other.kind) === line);
      const application = cardCheck(await applicationAndNamesakes(target.application_id));
      // The card could not show a wrong id when: more rows share the name and job than were read; or another interview
      // of this very application reads the same; or a namesake's does and the two applications cannot be told apart.
      const alike =
        cut ||
        twins.some((other) => other.application_id === target.application_id) ||
        (twins.length > 0 && !application.ok);
      if (alike) return { ok: false, refusal: lookTheSameInterviews(target.candidate.trim(), target.job.trim()) };
      // The card's lines: which interview this is; which application, when a namesake has one for the same job; and
      // what else is scheduled with the person, so "cancel Aina's" cannot be approved without seeing there is another.
      const named = application.ok && application.note ? application : null;
      const note = [THIS_INTERVIEW(interviewFullLine(target)), ...(named ? [named.note] : []), ...alsoScheduledLines(target.candidate, also ?? [])].join('\n');
      return { ok: true, note, namesakes: named ? named.namesakes : [] };
    } catch {
      // Nothing of the error is logged: its words can hold a name, an email or a link.
      console.error('[lekir] the check before an interview change could not read the rows');
      return { ok: false, refusal: INTERVIEW_CHECK_FAILED };
    }
  };
}

/** A stored chat keeps this much of a card's line (src/lib/chat/stored-parts.ts). */
const LINE_KEPT = 500;
/** A card's lines about the interview itself: everything before the list of what else is scheduled. */
const ownLines = (note: string | null): string | null => (note === null ? null : note.split('\nAlso scheduled for ')[0]);
/**
 * True when the line the card showed is the line now, allowing for a card reopened from a stored chat. What else
 * is scheduled with the person is not compared: another interview that came, went or moved since the card does not
 * change which interview the person said yes to.
 */
const sameLine = (shown: string | null, now: string | null): boolean =>
  ownLines(shown) === ownLines(now) || (shown !== null && now !== null && shown.length === LINE_KEPT && now.startsWith(shown));

/**
 * The gate's answer once nothing else refused the call: a card, with the line
 * as the request's reason. When the SDK asks again about a call the user
 * approved and the line is no longer the one their card showed (someone
 * changed the interview's time, type, length or place meanwhile, or a namesake
 * came or went), the change is stopped. An interview that was deleted
 * meanwhile, or whose application was closed, is stopped by the check's own
 * refusal, in that outcome's own words.
 */
export function interviewCardDecision(check: CardCheck, shown: { note: string | null } | null): Decision {
  if (!check.ok) return { type: 'denied', reason: check.refusal };
  if (shown && !sameLine(shown.note, check.note)) return { type: 'denied', reason: INTERVIEW_CHANGED_SINCE };
  return check.note ? { type: 'user-approval', reason: check.note } : 'user-approval';
}

/**
 * An agent's approval map with the six interview tools gated: the first
 * interview change of a request goes to the user as a card, and any other is
 * denied before a card exists. Built once per request, so the count starts at
 * zero each time; an interview change earlier in the same turn is found in the
 * messages. Whatever the map already holds for another tool (a deletion's
 * gate, a pool change's) is kept as it is: the three limits are counted apart.
 *
 * The SDK calls a gate once per call, in the order the model made them, and
 * once more for a call the user approved, at the start of the request that
 * carries their answer: that call is let through again and is then that
 * request's one.
 */
export function guardInterviewChanges(
  approval: Record<string, 'user-approval' | DeletionGate> | undefined,
  /** The server read: which interview this is, and whether anything could be taken for it. Asked last, and only for a call nothing else refused. */
  check?: InterviewCheck,
): Record<string, 'user-approval' | DeletionGate> | undefined {
  if (!approval) return undefined;
  const names = HIRE_INTERVIEW_TOOL_NAMES.filter((name) => name in approval);
  if (names.length === 0) return approval;
  let asked = 0;
  // One gate per tool, because the SDK does not say which tool it is asking about; one count between them.
  const gateFor = (tool: string): DeletionGate => async (input, { toolCallId, messages }) => {
    const id = interviewTarget(tool, input);
    const onApplication = actsOnApplication(tool);
    // In this order: one a turn, then an id that was really looked up as the right kind, then a lookup that was not
    // ambiguous, then a link somebody gave.
    const inTurn = asked > 0 ? ONE_INTERVIEW_CHANGE : interviewChangeProblem(messages, { toolCallId, id });
    const problem =
      inTurn === ONE_INTERVIEW_CHANGE
        ? inTurn
        : ((lookedUpAs(messages, onApplication ? 'application' : 'interview', id)
            ? null
            : onApplication ? notLookedUp('application', id) : interviewNotLookedUp(id))
          ?? inTurn
          ?? (linkNobodyGave(messages, (input as { place?: unknown } | null)?.place) ? LINK_NOT_GIVEN : null));
    if (problem) return { type: 'denied', reason: problem };
    // The SDK waits for each call's answer before asking about the next, so the count is safe across this read.
    const decision = check ? interviewCardDecision(await check(tool, input), cardShown(messages, toolCallId)) : 'user-approval';
    if (typeof decision === 'object' && decision.type === 'denied') return decision;
    asked += 1;
    return decision;
  };
  return { ...approval, ...Object.fromEntries(names.map((name) => [name, gateFor(name)])) };
}
