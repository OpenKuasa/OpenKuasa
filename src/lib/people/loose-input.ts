/**
 * How the assistant's looser attendance inputs are read: one place, so the tool that writes and the approval
 * card that describes the write can never disagree. A model sends '' (or spaces) for "none" and `9:00` for a time.
 * Pure; imports nothing from the tools or the chat code, so both can use it.
 */

/** `9:00` and `09:00:00` as `09:00`; '', whitespace, null, undefined, a non-string or anything that is not a time as null. */
export function hhmm(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /^([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/.exec(value.trim());
  return match ? `${match[1].padStart(2, '0')}:${match[2]}` : null;
}

/** The trimmed text, or null for '', whitespace, null, undefined or a non-string. */
export function blank(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
