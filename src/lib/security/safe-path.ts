// The one check for any caller-supplied path that becomes a redirect or a
// link: a `next` query parameter, a form field, a stored notification href.
// Imported by client components, so it must stay free of server-only modules.

import { cleanAsk } from '@/lib/docs/ask';

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

/** The consent screen an AI tool sent the person to. */
const SIGN_IN_RETURN = '/oauth/consent';

/** Sari's page, when the docs sent a question along. */
const SARI_RETURN = '/command';

/** Exactly `/command?ask=<question>`: one `ask`, nothing else, no fragment, the question already cleaned. */
function isSariAsk(path: string): boolean {
  const url = new URL(path, BASE);
  if (url.pathname !== SARI_RETURN || url.hash) return false;
  const keys = [...url.searchParams.keys()];
  if (keys.length !== 1 || keys[0] !== 'ask') return false;
  const ask = url.searchParams.get('ask');
  return cleanAsk(ask) === ask;
}

/**
 * A `next` for the sign-in page and action: a same-site path (as `safeAppPath` checks), otherwise null.
 * Only two places are accepted: the consent screen (`/oauth/consent`, any query), and Sari's page with a
 * question from the docs (`/command` with only `ask`, once, already in its `cleanAsk` form, and no fragment).
 * The question only fills the input there; nothing is sent. Any other page is ignored, so sign-in cannot be
 * used to send people somewhere else.
 */
export function signInReturnPath(value: unknown): string | null {
  const path = safeAppPath(value);
  if (!path) return null;
  if (path === SIGN_IN_RETURN || path.startsWith(`${SIGN_IN_RETURN}?`)) return path;
  return isSariAsk(path) ? path : null;
}
