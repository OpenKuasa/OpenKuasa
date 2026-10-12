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
  ambiguousLookup, cardCheck, cardShown, deniedHere, notLookedUp, oneStillStands, partsOf, thisTurn,
  type CardCheck, type Decision, type DeletionGate,
} from '@/lib/ai/hire-deletions';
import { lookedUpAs } from '@/lib/ai/hire-pool-gate';
import { isHeldCvMessage } from '@/lib/ai/hire-tools';
import { ALSO_SCHEDULED_MAX, THIS_INTERVIEW, alsoScheduledLines, interviewFullLine, interviewLine } from '@/lib/hire/interviews';
import { interviewCardFromLists, namesakesFromLists } from '@/lib/hire/namesakes';
import { instantMs, klInstant } from '@/lib/hire/interview-time';
import type { HireData, InterviewCardRow, Namesakes } from '@/lib/hire/types';

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
/** The other way: give the link again in the next message, or go ahead without one and add it later with "Reschedule or edit". */
export const LINK_NOT_GIVEN =
  'That link was not given by the user since the last interview card, so no interview change was prepared: ask the user to give the link again in their message, or prepare it without one.';
/**
 * A link with a zero-width or a direction-changing character in it. It reads as one link and is another, or is one
 * only once the hidden character is taken out: nobody types that on purpose, and it is how a link in a CV would get
 * past a reader. Refused even when the user's own message holds the same thing. The other way is in the sentence:
 * the user types the link out by hand (a typed link has no such character), or goes ahead without one.
 */
export const LINK_HIDDEN =
  'That link has hidden characters in it, so no interview change was prepared: ask the user to type the link out by hand in their message, or prepare it without one.';
/**
 * The interviewer is a typed name, and it is shown to the candidate in the invitation and the calendar file: a link
 * there would reach them unchecked. Refused whoever gave the link. The other way: give the link as the place (where
 * it is checked), or type it in "Place or link" on the Interviews screen.
 */
export const LINK_IN_INTERVIEWER =
  'The interviewer\'s name holds a link, so no interview change was prepared. Give the interviewer as a name only. ' +
  'A link goes in the place, and only one the user gave.';
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
/**
 * A change that sends the date and time the interview already has, with something else. Its card is worded from the
 * input and would say "New time" of a time that is not new, so there is no card: the model is told to send only what
 * changes, and does so in the same turn (this refusal is not the turn's one). The person need do nothing; if the
 * model does not, they ask again for only what should change.
 */
export const SAME_TIME_SENT =
  'The date and time sent are the ones this interview already has, so no change was prepared. ' +
  'Send only what changes: prepare it again without the date and the time.';
/** The same with nothing else sent. Written for a person as it is; there is nothing to do, the interview is as they asked. */
export const NOTHING_WOULD_CHANGE = 'Nothing would change: this interview is already at that date and time. No change was prepared.';
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

/** Characters that take no room or change the direction of the text: taken out before anything is read. */
const HIDDEN = /[­͏؜ᅟᅠ឴឵᠎​-‏‪-‮⁠-⁤⁦-⁯ㅤ﻿ﾠ]/g;
/** Text with look-alike forms folded into the plain ones (full-width letters, a full-width full stop). */
const folded = (text: string) => text.normalize('NFKC');
/** Text as it is read for links: folded, and with the hidden characters gone. */
const plain = (text: string) => folded(text).replace(HIDDEN, '');

/** A link with a scheme: "https://…", any other scheme ("zoommtg://…"), and a scheme written with one slash ("msteams:/…"). */
const SCHEME_LINK = /(?<![\p{L}\p{N}])[a-z][a-z0-9+.-]*:\/\S+/giu;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\//i;
/** An IP address for a host: four numbers, or the bracketed form, each with what follows it. */
const IP_HOST = /(?<![\p{L}\p{N}.])((?:\d{1,3}\.){3}\d{1,3}|\[[0-9a-f:.]{2,}\])(?![\p{L}\p{N}.])(:\d{1,5})?([/?#]\S*)?/giu;
/**
 * A host written without a scheme, with what follows it: labels joined by dots, ending in letters, in any script.
 * Not the middle of a longer word, and not the part of an email address before its "@".
 */
const BARE_HOST = /(?<![\p{L}\p{N}])((?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+)(\p{L}{2,24})(?![\p{L}\p{N}@-])(:\d{1,5})?([/?#]\S*)?/giu;
/**
 * Endings that make a dotted word a web address on their own ("zoom.us", "syarikat.com.my", "meet.new"). Not "am"
 * or "pm": "3.pm" is a time.
 */
const WEB_ENDINGS = new Set([
  'com', 'net', 'org', 'io', 'co', 'my', 'us', 'me', 'app', 'dev', 'ai', 'edu', 'gov', 'info', 'biz', 'sg', 'uk', 'id', 'ly', 'gl', 'to', 'tv', 'cc',
  'link', 'page', 'site', 'online', 'live', 'team', 'chat', 'video', 'cloud', 'xyz', 'in', 'au', 'ca', 'de', 'fr', 'eu', 'asia',
  'ru', 'cn', 'jp', 'kr', 'hk', 'tw', 'th', 'vn', 'ph', 'bn', 'nz', 'br', 'mx', 'es', 'nl', 'se', 'ch', 'pl', 'tr', 'ae', 'sa', 'pk', 'bd', 'lk', 'za',
  'ua', 'su', 'tk', 'ml', 'ga', 'cf', 'gq', 'ws', 'fm', 'la', 'sh', 'ac', 'pw', 'top', 'club', 'shop', 'store', 'tech', 'space', 'website', 'zone', 'new',
  'one', 'work', 'world', 'today', 'life', 'fun', 'icu', 'vip', 'pro', 'name', 'mobi', 'meet', 'zoom', 'click', 'rest', 'bar', 'email', 'run', 'art',
]);
/**
 * Titles and place words that people write with a full stop and no space after it: "Dr.Tan/Ops", "Kg.Baru/KL",
 * "Sdn.Bhd/HQ". A dotted word made of these and one more word that is not a web ending is not a link, even with a
 * slash after it.
 */
const TITLES_AND_PLACES = new Set([
  'dr', 'mr', 'mrs', 'ms', 'mdm', 'miss', 'en', 'encik', 'cik', 'pn', 'puan', 'tn', 'tuan', 'hj', 'hjh', 'haji', 'hajah', 'dato', 'datuk', 'datin', 'tan',
  'sri', 'seri', 'prof', 'ir', 'ts', 'ar', 'sr', 'jr', 'st', 'ybhg', 'yb',
  'jln', 'jalan', 'lrg', 'lorong', 'tmn', 'taman', 'kg', 'kampung', 'sg', 'sungai', 'bkt', 'bukit', 'bdr', 'bandar', 'blk', 'blok', 'aras', 'tkt',
  'tingkat', 'lot', 'no', 'bgn', 'bangunan', 'menara', 'wisma', 'plaza', 'kompleks', 'pejabat', 'bilik', 'level', 'lvl', 'suite', 'unit', 'sdn', 'bhd',
  'pt', 'psn', 'persiaran', 'lbh', 'lebuh', 'kws', 'kawasan', 'seksyen', 'sek', 'pusat',
]);
/** What ends a sentence or closes a bracket, bold text or code is not part of a link someone typed: "Use https://meet.example.com/abc." */
const CLOSING = /[.,;:!?)\]}>'"”’*`]+$/;

/** Whether a dotted word, with what follows it, is a web address. The rule is said whole in `linksIn`. */
function isWebHost(labels: string[], ending: string, followed: boolean): boolean {
  const first = labels[0];
  if (first === 'www') return true;
  // "Blok B.My office", "Aras 1.Me": one letter, or a number, then a short word that happens to be an ending.
  if (labels.length === 1 && !followed && ([...first].length === 1 || /^\d+$/.test(first))) return false;
  if (WEB_ENDINGS.has(ending)) return true;
  // With another ending, it takes a port, a path, a query or a fragment to be an address; and then not when every
  // word before the ending is a title or a place word.
  return followed && !labels.every((label) => TITLES_AND_PLACES.has(label));
}

/** The links in text that was already made ready (`plain`, or `folded` alone), each without its closing punctuation. */
function linksInReady(ready: string): string[] {
  const found: { at: number; link: string }[] = [];
  const blank = (whole: string) => ' '.repeat(whole.length);
  // Those with a scheme first, then IP addresses, each blanked out so that no part of it is found a second time.
  let rest = ready.replace(SCHEME_LINK, (whole, at: number) => {
    const link = whole.replace(CLOSING, '');
    if (link.replace(HAS_SCHEME, '')) found.push({ at, link });
    return blank(whole);
  });
  rest = rest.replace(IP_HOST, (whole: string, host: string, port: string | undefined, after: string | undefined, at: number) => {
    const numbers = host.startsWith('[') ? [] : host.split('.').map(Number);
    // An address alone ("1.2.3.4") is a number, a version, a section: it takes a port or something after it.
    const followed = Boolean(port) || (after ?? '').replace(CLOSING, '').length > 1;
    if (!followed || numbers.some((n) => n > 255)) return whole;
    found.push({ at, link: whole.replace(CLOSING, '') });
    return blank(whole);
  });
  for (const match of rest.matchAll(BARE_HOST)) {
    const [whole, labels, ending, port] = match;
    const at = match.index ?? 0;
    const link = whole.replace(CLOSING, '');
    // A port, or a path, a query or a fragment with something in it: "evil.ru?id=5", not "ok.Boleh?".
    const followed = Boolean(port) || link.length > labels.length + ending.length + 1;
    // After an "@" it is the host of an email address, which is left alone, unless something follows the host:
    // "good.example@evil.example/x" is a link to evil.example.
    if (rest[at - 1] === '@' && !followed) continue;
    if (isWebHost(labels.toLowerCase().split('.').filter(Boolean), ending.toLowerCase(), followed)) found.push({ at, link });
  }
  return found.sort((a, b) => a.at - b.at).map((one) => one.link);
}

/**
 * Every link in a text, each without the punctuation that follows it. The text is first folded into plain forms
 * (full-width letters read as the letters they look like) and its hidden characters are taken out, so a link is
 * found however it was dressed. A link is:
 * - text with a scheme, with two slashes or one ("https://meet.example.com/abc", "zoommtg://…", "msteams:/…");
 * - an IP address with a port or something after it ("203.0.113.5/join", "[2001:db8::1]:8443");
 * - a host that begins "www.";
 * - a host with a web ending ("zoom.us", "syarikat.com.my", "meet.new"), with or without anything after it;
 * - any other dotted host with a port, a path, a query or a fragment after it ("rooms.example.host/abc",
 *   "evil.host?id=5"), in any script, even after "user@".
 * Not a link: a place ("Level 3, Menara KL"), a room number ("Bilik Mesyuarat 2.1"), a title or an initial
 * ("Dr. Aina b. Rahman"), a phone number, a bare IP address, an email address (left alone on purpose), one letter
 * or a number and a short word with nothing after ("Blok B.My office"), and a title or a place word joined to one
 * more word that is not a web ending, even with a slash after it ("Dr.Tan/Ops", "Kg.Baru/KL", "Sdn.Bhd/HQ").
 * What that last rule lets through: a real address whose every label is such a word and whose ending is not in the
 * list of web endings. The card shows the place in full.
 */
export function linksIn(text: unknown): string[] {
  return typeof text === 'string' ? linksInReady(plain(text)) : [];
}

/**
 * True when a hidden character changes which links a text holds: one is a link only once the character is taken
 * out, or reads differently with it. A hidden character that is in no link changes nothing.
 */
export function hasHiddenLink(text: unknown): boolean {
  if (typeof text !== 'string' || folded(text) === plain(text)) return false;
  return linksInReady(folded(text)).join('\n') !== linksInReady(plain(text)).join('\n');
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

/**
 * A link as two things to compare: its scheme (null when it was written without one) and everything after it, in
 * `sameLink`'s form. A link written without a scheme is read as "https://" would be.
 */
function linkParts(link: string): { scheme: string | null; rest: string } {
  const written = HAS_SCHEME.test(link);
  const whole = sameLink(written ? link : `https://${link}`);
  return { scheme: written ? whole.slice(0, whole.indexOf(':')).toLowerCase() : null, rest: whole.replace(/^[a-z][a-z0-9+.-]*:\/*/i, '') };
}
/**
 * True when the two are the same link. With a scheme on both, the schemes must be the same. One written without a
 * scheme is the same as that address under "http" or "https", and under no other scheme.
 */
function sameAddress(a: { scheme: string | null; rest: string }, b: { scheme: string | null; rest: string }): boolean {
  if (a.rest !== b.rest) return false;
  if (a.scheme === b.scheme) return true;
  const web = (scheme: string | null) => scheme === null || scheme === 'http' || scheme === 'https';
  return (a.scheme === null || b.scheme === null) && web(a.scheme) && web(b.scheme);
}

/** The `place` of every row with this id, anywhere in a value. */
function placesOf(value: unknown, id: string, depth = 0): string[] {
  if (!value || typeof value !== 'object' || depth > 6) return [];
  if (Array.isArray(value)) return value.flatMap((inner) => placesOf(inner, id, depth + 1));
  const row = value as { id?: unknown; place?: unknown };
  const own = row.id === id && typeof row.place === 'string' ? [row.place] : [];
  return [...own, ...Object.values(row).flatMap((inner) => placesOf(inner, id, depth + 1))];
}

/** The tools whose results hold an interview's row: the lookup, and the six changes. */
const INTERVIEW_RESULTS = new Set<string>(['listInterviews', ...HIRE_INTERVIEW_TOOL_NAMES]);
type Result = { tool: string; output: unknown };

/**
 * The place of ONE interview, as these tool results hold it. Only the results
 * of the interview lookup and of the six interview changes are read, only the
 * rows with this interview's id, and of those only the `place`: a link there
 * was typed by someone in the team, or approved on a card, for this very
 * interview. Nothing else a tool returns counts, because much of it is a
 * stranger's text (a cover letter, a CV link, a portfolio link, a headline),
 * and another interview's place is another interview's. Notes do not count
 * either: they are the team's own, and are never shown to a candidate.
 */
export function interviewPlacesIn(results: readonly Result[], id: unknown): string[] {
  if (typeof id !== 'string' || !id) return [];
  return results.filter((result) => INTERVIEW_RESULTS.has(result.tool)).flatMap((result) => placesOf(result.output, id));
}

/** Every tool result in a conversation, as a tool returned it. */
function resultsIn(messages: readonly ModelMessage[]): Result[] {
  return messages
    .filter((message) => message.role === 'tool')
    .flatMap(partsOf)
    .filter((part) => part.type === 'tool-result' && typeof part.toolName === 'string')
    .flatMap((part) => {
      const output = part.output as { type?: unknown; value?: unknown } | null | undefined;
      return output?.type === 'json' ? [{ tool: part.toolName as string, output: output.value }] : [];
    });
}

/** A call in a conversation that put an interview change in front of the user, for `linkNobodyGave`. */
export type IsInterviewCard = (call: { toolName?: unknown; toolCallId?: unknown; input?: unknown }) => boolean;
/** For an agent that holds the tools itself: a call of one of the six. */
const anInterviewCall: IsInterviewCard = (call) => isInterviewChange(call.toolName);

/**
 * The calls in these messages whose card the user REJECTED, by call id: a card of their own (not an automatic one)
 * answered with `approved: false`. Read from the structure of the conversation, as `stoppedAfterApproval` reads an
 * approval: text cannot make one.
 */
export function rejectedByUser(messages: readonly ModelMessage[]): Set<unknown> {
  const cardOf = new Map<unknown, unknown>();
  const ids = new Set<unknown>();
  type Wide = { type?: unknown; toolCallId?: unknown; approvalId?: unknown; approved?: unknown; isAutomatic?: unknown };
  for (const message of messages) {
    for (const part of partsOf(message) as Wide[]) {
      if (message.role === 'assistant' && part.type === 'tool-approval-request' && part.isAutomatic !== true) cardOf.set(part.approvalId, part.toolCallId);
      else if (message.role === 'tool' && part.type === 'tool-approval-response' && part.approved === false && cardOf.has(part.approvalId)) ids.add(cardOf.get(part.approvalId));
    }
  }
  return ids;
}

/** True when two interview changes are about the same row: the same application for the two that make one, the same interview for the rest. */
export function sameInterviewTarget(toolA: unknown, inputA: unknown, toolB: unknown, inputB: unknown): boolean {
  const target = interviewTarget(toolA, inputA);
  return typeof target === 'string' && Boolean(target) && actsOnApplication(toolA) === actsOnApplication(toolB) && target === interviewTarget(toolB, inputB);
}

/**
 * What the user has typed since the last interview card was shown to them, or since the conversation began when
 * none was. A card is a call (`isCard`) that reached the user, whatever they answered and whether or not they have
 * answered yet; a call a gate denied itself never did (`deniedHere`: known by its reason, or by having been stopped
 * after the user's yes, which its replacement must be able to follow). A CV the assistant fetched sits in a user
 * message and is not the user typing.
 */
function saidSinceLastCard(messages: readonly ModelMessage[], isCard: IsInterviewCard): string[] {
  const denied = deniedHere(messages);
  let from = 0;
  messages.forEach((message, index) => {
    if (message.role !== 'assistant') return;
    if (partsOf(message).some((part) => part.type === 'tool-call' && !denied.has(part.toolCallId) && isCard(part))) from = index + 1;
  });
  return messages.slice(from).flatMap((message) => {
    if (message.role !== 'user' || isHeldCvMessage(message)) return [];
    if (typeof message.content === 'string') return [message.content];
    return (partsOf(message) as { type?: unknown; text?: unknown }[]).flatMap((part) => (part.type === 'text' && typeof part.text === 'string' ? [part.text] : []));
  });
}

/**
 * True when `place` holds a link that nobody gave. A link is one with or
 * without its scheme (`linksIn`): a model whose "https://zoom.us/j/9911" was
 * refused must not get a card for "zoom.us/j/9911". A link passes only when
 * the same link (`sameLink`, and `sameAddress` for the scheme) is in what the
 * user has typed since the last interview card was shown to them
 * (`saidSinceLastCard`), or in `extra`.
 *
 * Since the last interview card, not the whole conversation and not this
 * turn alone. A link typed for one interview must not reach the next
 * person's card; and a question the assistant asks in between ("video or
 * phone?") must not cost the user the link they gave. Nor must a card they
 * rejected for the same interview (`interviewLinkProblem`). Not counted, because
 * none of them is the user typing: a CV the assistant fetched (it sits in a
 * user message, see `isHeldCvMessage`), anything an assistant wrote, a tool
 * call's input, a denial or an error, a lookup's result, and a specialist's
 * written report to Tuah.
 *
 * `extra` is more text that counts: the caller passes the stored place of the
 * very interview being changed (`interviewLinkProblem`), so that a change may
 * keep the link the interview already has. `isCard` says which calls were an
 * interview card: one of the six tools by default; Tuah's team passes its
 * own, because there the card is an `applyChange` call.
 *
 * The other way for the person, when a link is refused: give it again in
 * their next message (the refusal says so), or go ahead without one and add
 * it later with "Reschedule or edit" on the Interviews screen.
 */
export function linkNobodyGave(messages: readonly ModelMessage[], place: unknown, extra = '', isCard: IsInterviewCard = anInterviewCall): boolean {
  const wanted = linksIn(place).map(linkParts);
  if (wanted.length === 0) return false;
  const given = [extra, ...saidSinceLastCard(messages, isCard)].flatMap((text) => linksIn(text)).map(linkParts);
  return wanted.some((link) => !given.some((one) => sameAddress(link, one)));
}

/**
 * Why a change's place or interviewer must not reach a card, or null: a link in the place that nobody gave
 * (`linkNobodyGave`), any link at all in the interviewer's name, or a link with a hidden character in either. Notes
 * are not read: no candidate sees them.
 * For a change to an interview that exists, the place that interview already has counts as given: `results` are the
 * lookups to find it in (a specialist's own, in Tuah's team); left out, they are the conversation's. `card` says
 * which earlier calls were an interview card: a call id (the call being asked about, which is not its own
 * predecessor) for an agent that holds the tools, or Tuah's team's own rule.
 */
export function interviewLinkProblem(
  messages: readonly ModelMessage[],
  tool: string,
  input: unknown,
  results?: readonly Result[],
  card?: string | IsInterviewCard,
): string | null {
  const sent = (input && typeof input === 'object' ? input : {}) as { place?: unknown; interviewer_name?: unknown };
  // A link dressed with a hidden character is refused whoever gave it, in either field a candidate reads.
  if (hasHiddenLink(sent.place) || hasHiddenLink(sent.interviewer_name)) return LINK_HIDDEN;
  // A new interview has no place yet: only what the user typed counts for it.
  const own = actsOnApplication(tool) ? [] : interviewPlacesIn(results ?? resultsIn(messages), interviewTarget(tool, input));
  // A card the user rejected for this very row does not close what they gave for it: "make it 4pm" after a no is
  // a correction of the same interview, and its link is still theirs. One that ran, or was for another row, does.
  const rejected = rejectedByUser(messages);
  const isCard: IsInterviewCard =
    typeof card === 'function'
      ? card
      : (call) =>
          anInterviewCall(call) &&
          call.toolCallId !== card &&
          !(rejected.has(call.toolCallId) && sameInterviewTarget(call.toolName, call.input, tool, input));
  if (linkNobodyGave(messages, sent.place, own.join('\n'), isCard)) return LINK_NOT_GIVEN;
  return linksIn(sent.interviewer_name).length > 0 ? LINK_IN_INTERVIEWER : null;
}

/**
 * Asks the server about an interview change's row. Given the tool's whole
 * input, not an id: two of the six tools name an application and four an
 * interview, and the check, not each of its three callers, knows which key
 * holds the row's id. One other thing of the input is read: the date and time
 * of a change, to see whether they are the ones the interview already has.
 * Nothing of the input is ever put on the card's line. Never throws.
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
      const { target, others, cut, also, alsoClosed, application_outcome: outcome } = data.interviewCard
        ? await data.interviewCard(id)
        : interviewCardFromLists(id, await data.listInterviews(), await data.listApplications());
      // Not there (deleted since it was listed, or since its card was shown): there is no line to put on a card.
      if (!target) return { ok: false, refusal: INTERVIEW_GONE };
      // Its time and details can be changed only while its application is active. Said here, before a card and again
      // when the user's yes arrives, rather than by the database after it.
      if (tool === 'rescheduleInterview' && (outcome === 'rejected' || outcome === 'withdrawn')) {
        return { ok: false, refusal: APPLICATION_NOT_ACTIVE };
      }
      if (tool === 'rescheduleInterview') {
        // The time sent, read as the capability reads it. The same instant as the stored one is not a new time.
        const sent = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
        const at = typeof sent.date === 'string' && typeof sent.time === 'string' ? klInstant(sent.date, sent.time) : null;
        if (at && instantMs(at) === instantMs(target.scheduled_at)) {
          const more = ['duration_minutes', 'kind', 'place', 'interviewer_name', 'notes'].some((key) => sent[key] !== undefined);
          return { ok: false, refusal: more ? SAME_TIME_SENT : NOTHING_WOULD_CHANGE };
        }
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
      // Marking one as scheduled again is the one change to a closed interview: its card lists the other closed ones too.
      const closed = tool === 'reopenInterview' ? alsoClosedLines(target.candidate, alsoClosed ?? []) : [];
      const note = [THIS_INTERVIEW(interviewFullLine(target)), ...(named ? [named.note] : []), ...alsoScheduledLines(target.candidate, also ?? []), ...closed].join('\n');
      return { ok: true, note, namesakes: named ? named.namesakes : [] };
    } catch {
      // Nothing of the error is logged: its words can hold a name, an email or a link.
      console.error('[lekir] the check before an interview change could not read the rows');
      return { ok: false, refusal: INTERVIEW_CHECK_FAILED };
    }
  };
}

const STATUS_WORDS: Record<string, string> = { cancelled: 'cancelled', completed: 'completed', no_show: 'no-show', scheduled: 'scheduled' };
/**
 * The candidate's other CLOSED interviews, for the card of the one change that acts on a closed interview ("mark as
 * scheduled again"): one line each with how it ended, at most three, then how many more. Two closed interviews of one
 * person are as easily taken for each other as two scheduled ones. (It stands here, not with the other card
 * sentences in lib/hire/interviews.ts, because that file was being changed by someone else when this was written.)
 */
export function alsoClosedLines(name: string, others: readonly InterviewCardRow[]): string[] {
  const one = (text: string) => text.replace(/\s+/g, ' ').trim();
  const who = one(name) || 'the candidate';
  const lines = others
    .slice(0, ALSO_SCHEDULED_MAX)
    .map((other) => `Also closed for ${who}: ${interviewLine(other.scheduled_at, other.kind)} · ${STATUS_WORDS[other.status] ?? other.status} (${one(other.job)})`);
  const more = others.length - ALSO_SCHEDULED_MAX;
  return more > 0 ? [...lines, `and ${more} more`] : lines;
}

/** A stored chat keeps this much of a card's line (src/lib/chat/stored-parts.ts). */
const LINE_KEPT = 500;
/** A card's lines about the interview itself: everything before the list of what else is scheduled. */
const ownLines = (note: string | null): string | null => (note === null ? null : note.split(/\nAlso (?:scheduled|closed) for /)[0]);
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
  const passed = new Set<string>();
  // One gate per tool, because the SDK does not say which tool it is asking about; one count between them.
  const gateFor = (tool: string): DeletionGate => async (input, { toolCallId, messages }) => {
    const id = interviewTarget(tool, input);
    const onApplication = actsOnApplication(tool);
    // In this order: one a turn, then an id that was really looked up as the right kind, then a lookup that was not
    // ambiguous, then a link somebody gave.
    const inTurn = oneStillStands(passed, messages) ? ONE_INTERVIEW_CHANGE : interviewChangeProblem(messages, { toolCallId, id });
    const problem =
      inTurn === ONE_INTERVIEW_CHANGE
        ? inTurn
        : ((lookedUpAs(messages, onApplication ? 'application' : 'interview', id)
            ? null
            : onApplication ? notLookedUp('application', id) : interviewNotLookedUp(id))
          ?? inTurn
          ?? interviewLinkProblem(messages, tool, input, undefined, toolCallId));
    if (problem) return { type: 'denied', reason: problem };
    // The SDK waits for each call's answer before asking about the next, so the count is safe across this read.
    const decision = check ? interviewCardDecision(await check(tool, input), cardShown(messages, toolCallId)) : 'user-approval';
    if (typeof decision === 'object' && decision.type === 'denied') return decision;
    passed.add(toolCallId);
    return decision;
  };
  return { ...approval, ...Object.fromEntries(names.map((name) => [name, gateFor(name)])) };
}
