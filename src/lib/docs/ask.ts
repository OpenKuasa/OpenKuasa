// A question carried from the docs to Sari in a link. Imported by client
// components and by the sign-in return check, so it stays free of server-only modules.

/** The longest question a link can carry. */
export const ASK_MAX = 300;

// Control characters; a line break or tab becomes a space.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
// Invisible characters that hide or reorder text.
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
// Half of a surrogate pair on its own: not text, and encodeURIComponent throws on it.
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * The question as plain text: control and invisible characters gone, whitespace collapsed to single
 * spaces, trimmed and cut to ASK_MAX. Null when nothing is left. Cleaning a cleaned question changes nothing.
 */
export function cleanAsk(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value
    .replace(LONE_SURROGATE, '')
    .replace(CONTROL, ' ')
    .replace(INVISIBLE, '')
    .replace(/\s+/g, ' ')
    .trim();
  // Cutting can split a pair or end on a space; tidy both.
  const cut = text.slice(0, ASK_MAX).replace(LONE_SURROGATE, '').trimEnd();
  return cut || null;
}

/** Sari's page with the question waiting in the input. */
export function sariAskPath(question: string): string {
  return `/command?ask=${encodeURIComponent(cleanAsk(question) ?? '')}`;
}
