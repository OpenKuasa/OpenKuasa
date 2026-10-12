// The one check for any caller-supplied path that becomes a redirect or a
// link: a `next` query parameter, a form field, a stored notification href.
// Imported by client components, so it must stay free of server-only modules.

// Never resolved over the network; only used to parse a relative path.
const BASE = 'http://app.invalid';

// Control characters and every kind of whitespace. Browsers drop some of
// these while parsing a URL, which changes what the path means.
const UNSAFE_CHARS = /[\s\u0000-\u001f\u007f-\u009f]/;

const startsWithOneSlash = (value: string) =>
  value.startsWith('/') && !value.startsWith('//');

/**
 * Returns the path (with query and fragment) when it stays inside this app,
 * otherwise null. The result is re-serialised from the parsed URL, so what is
 * returned is what a browser will follow.
 */
export function safeAppPath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (!startsWithOneSlash(value)) return null;
  if (value.includes('\\') || UNSAFE_CHARS.test(value)) return null;

  let url: URL;
  try {
    url = new URL(value, BASE);
  } catch {
    return null;
  }
  if (url.origin !== BASE) return null;
  // Dot segments can collapse into a leading `//`, which names another host.
  if (!startsWithOneSlash(url.pathname)) return null;

  return `${url.pathname}${url.search}${url.hash}`;
}
