// src/lib/hire/interview-invite.ts
/**
 * What a recruiter hands to a candidate: the invitation to copy, and a
 * calendar file (RFC 5545) to download. Both are made from one plain object
 * and neither reads the clock, so the same row always gives the same text and
 * the same file. The file is built in the browser, so nothing here uses a
 * Node-only API. The notes are not part of `InviteSource`: they cannot reach
 * a candidate from here.
 */
import { ZONE_LABEL, durationText, instantMs, klDateOf, longDate, timeRange } from './interview-time';
import { KIND_WORDS, PLACE_LABEL } from './interviews';
import type { InterviewKind } from './types';

export type InviteSource = {
  id: string;
  scheduled_at: string;
  duration_minutes: number;
  kind: InterviewKind;
  place: string | null;
  interviewer_name: string | null;
  created_at: string;
  updated_at: string;
  /** The candidate's name, as stored. */
  candidate: string;
  /** The job's title. */
  job: string;
  /** The workspace's name; left out of the text when there is none. */
  workspace: string | null;
};

/** A value that is there: trimmed, or null for a blank. */
const present = (value: string | null | undefined) => (value && value.trim() ? value.trim() : null);

/**
 * The invitation, in English, for the recruiter to copy into their own email
 * or message. `moved`: the interview's time was changed, so the opening line
 * says the time is new. A line whose value is missing is left out, with
 * nothing in its place.
 */
export function invitationText(i: InviteSource, moved: boolean): string {
  const workspace = present(i.workspace);
  const at = workspace ? ` at ${workspace}` : '';
  const place = present(i.place);
  const interviewer = present(i.interviewer_name);
  const lines = [
    `Hi ${i.candidate},`,
    '',
    moved
      ? `Your interview for the ${i.job} role${at} has a new time.`
      : `You are invited to an interview for the ${i.job} role${at}.`,
    '',
    `Date: ${longDate(i.scheduled_at)}`,
    `Time: ${timeRange(i.scheduled_at, i.duration_minutes)}, ${ZONE_LABEL}`,
    `Length: ${durationText(i.duration_minutes)}`,
    `Type: ${KIND_WORDS[i.kind]}`,
  ];
  if (place) lines.push(`${PLACE_LABEL[i.kind]}: ${place}`);
  if (interviewer) lines.push(`With: ${interviewer}`);
  lines.push('', 'Please reply to confirm, or tell us if you need another time.');
  return lines.join('\n');
}

// ─── the calendar file ───────────────────────────────────────────────────────

const CRLF = '\r\n';
const LINE_OCTETS = 75;

/** An instant as `20261020T070000Z`: UTC, so no time-zone block is needed and every calendar shows it in its owner's zone. */
function utcStamp(ms: number): string {
  if (!Number.isFinite(ms)) return '';
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
}

/** Whether a character is kept in a text value: a line break is, every other control character is not. */
function kept(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  if (code === 0x0a) return true;
  return code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f);
}

/**
 * A text value as the format wants it: control characters dropped (a carriage
 * return among them), then `\` `;` `,` escaped and a line break written `\n`.
 * The backslash first, or the escapes themselves would be escaped again.
 */
function icsText(value: string): string {
  return Array.from(value).filter(kept).join('')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

/** How many octets a character takes in UTF-8. Worked out by hand: the browser has no `Buffer`. */
function octets(character: string): number {
  const code = character.codePointAt(0) ?? 0;
  if (code < 0x80) return 1;
  if (code < 0x800) return 2;
  if (code < 0x10000) return 3;
  return 4;
}

/**
 * A line longer than 75 octets continued on the next line after CRLF and one
 * space (which counts towards that line's 75). It is cut between characters,
 * never inside one: `Array.from` walks whole code points.
 */
function fold(line: string): string {
  const pieces: string[] = [];
  let piece = '';
  let size = 0;
  for (const character of Array.from(line)) {
    const width = octets(character);
    if (size + width > LINE_OCTETS) {
      pieces.push(piece);
      piece = ' ';
      size = 1;
    }
    piece += character;
    size += width;
  }
  pieces.push(piece);
  return pieces.join(CRLF);
}

/**
 * One calendar with one event, as one string. `METHOD:PUBLISH`, never
 * `REQUEST`: there is no organiser, no attendee and no reply to collect. The
 * UID is the interview's id, which never changes, and the sequence number
 * grows with every change, so a file downloaded after a reschedule replaces
 * the entry a calendar already has.
 */
export function interviewIcs(i: InviteSource): string {
  const start = instantMs(i.scheduled_at);
  const changedAfter = Math.floor((instantMs(i.updated_at) - instantMs(i.created_at)) / 1000);
  const sequence = Number.isFinite(changedAfter) && changedAfter > 0 ? changedAfter : 0;
  const workspace = present(i.workspace);
  const place = present(i.place);
  const interviewer = present(i.interviewer_name);
  const description = [
    `Candidate: ${i.candidate}`,
    `Type: ${KIND_WORDS[i.kind]}`,
    ...(interviewer ? [`With: ${interviewer}`] : []),
  ].join('\n');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//OpenKuasa//Lekir//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${i.id}@openkuasa.com`,
    `DTSTAMP:${utcStamp(instantMs(i.updated_at))}`,
    `SEQUENCE:${sequence}`,
    `DTSTART:${utcStamp(start)}`,
    `DTEND:${utcStamp(start + i.duration_minutes * 60_000)}`,
    `SUMMARY:${icsText(`Interview for ${i.job}${workspace ? ` at ${workspace}` : ''}`)}`,
    ...(place ? [`LOCATION:${icsText(place)}`] : []),
    `DESCRIPTION:${icsText(description)}`,
    'STATUS:CONFIRMED',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.map(fold).join(CRLF) + CRLF;
}

/**
 * `interview-aina-rahman-2026-10-20.ics`: the name in lower case with
 * anything but a to z and 0 to 9 turned into single hyphens, then the Kuala
 * Lumpur date. A name with none of those characters gives the date alone.
 */
export function icsFileName(i: InviteSource): string {
  const slug = i.candidate.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `interview-${slug ? `${slug}-` : ''}${klDateOf(i.scheduled_at)}.ics`;
}
