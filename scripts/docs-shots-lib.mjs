// Pure helpers for scripts/docs-shots.mjs, kept apart so tests can import them.

const DENIED = ['save', 'submit', 'send', 'approve', 'delete', 'remove', 'post', 'confirm', 'pay'];

/** True only for a http(s) URL whose host is exactly localhost or 127.0.0.1. */
export function isLocalBase(base) {
  try {
    const url = new URL(base);
    return (url.protocol === 'http:' || url.protocol === 'https:') && ['localhost', '127.0.0.1'].includes(url.hostname);
  } catch {
    return false;
  }
}

/** True when a click name contains a word that would save, send or delete something. */
export function isDeniedClick(name) {
  const words = String(name).toLowerCase().split(/[^a-z]+/);
  return words.some((w) => DENIED.includes(w));
}
