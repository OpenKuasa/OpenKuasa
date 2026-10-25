// Pure helpers for scripts/docs-shots.mjs, kept apart so tests can import them.

const DENIED = [
  'save', 'submit', 'send', 'approve', 'delete', 'remove', 'post', 'confirm', 'pay',
  'apply', 'invite', 'create', 'reject', 'add',
];
/** Past forms that don't follow the -ed pattern. */
const DENIED_IRREGULAR = ['sent', 'paid', 'applied'];

/** A denied word as itself or inflected: Save, Saves, Saved, Saving; Submit, Submitted, Submitting. */
const DENIED_WORD = new RegExp(
  `^(?:${DENIED.map((w) => {
    const stem = w.replace(/e$/, '');
    const last = stem.slice(-1);
    return `${stem}(?:${last})?(?:e|es|s|ed|d|ing)?`;
  }).join('|')}|${DENIED_IRREGULAR.join('|')})$`,
);

/** True only for a http(s) URL whose host is exactly localhost or 127.0.0.1, with no user name or password. */
export function isLocalBase(base) {
  try {
    const url = new URL(base);
    if (url.username || url.password) return false;
    return (url.protocol === 'http:' || url.protocol === 'https:') && ['localhost', '127.0.0.1'].includes(url.hostname);
  } catch {
    return false;
  }
}

/** True when a click name holds a word, in any case, inflected or run into another word, that would save, send or delete something. */
export function isDeniedClick(name) {
  const words = String(name)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z]+/);
  return words.some((w) => DENIED_WORD.test(w));
}

/** Hides the floating "Ask Sari" button, which would cover part of every shot. Matches assistant-fab.tsx. */
export const HIDE_ASSISTANT_FAB_CSS = 'button[aria-label="Ask Taming Sari"] { display: none !important; }';

/** Browser context options for one shot: its own viewport, plus the saved demo sign-in for a demo shot. */
export function shotContextOptions(as, viewport, demoState) {
  const options = { viewport, colorScheme: 'light', deviceScaleFactor: 1 };
  if (as !== 'demo') return options;
  if (!demoState) throw new Error('A demo shot needs the saved demo sign-in.');
  return { ...options, storageState: demoState };
}
