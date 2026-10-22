// src/lib/hire/latest-answer.ts
/**
 * For a box that asks the server as the person types: each question gets a
 * number, and only the answer to the newest one is used, so an older answer
 * that comes back late never replaces a newer one. Pure.
 */

/** How long typing must pause before the server is asked, in milliseconds. */
export const SEARCH_PAUSE_MS = 250;

export type LatestOnly = {
  /** A new question: its number. Every question asked before it is now stale. */
  begin(): number;
  /** Whether the answer to question `n` is still the one to use. */
  isCurrent(n: number): boolean;
  /** Every question still out is stale (the box closed, or its owner went away). */
  cancel(): void;
};

export function latestOnly(): LatestOnly {
  let newest = 0;
  return {
    begin: () => ++newest,
    isCurrent: (n) => n === newest,
    cancel: () => {
      newest += 1;
    },
  };
}
