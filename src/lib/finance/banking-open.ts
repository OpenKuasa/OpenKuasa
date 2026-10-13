import type { BankAccountRow } from './banking';

/**
 * The one thing that is open on Banking: a form (it holds what was typed) or a question in a row. Opening
 * another replaces it, and the header's buttons wait while anything is open. `today` is the person's own date
 * when a form was opened.
 */
export type BankingOpen =
  | { kind: 'account'; today: string; editing: BankAccountRow | null }
  | { kind: 'transfer'; today: string }
  | { kind: 'archive'; accountId: string }
  | { kind: 'void'; transactionId: string }
  | null;

/** What is open as the screen shows it: a question whose row has left the screen counts as closed. */
export function visibleOpen(opened: BankingOpen, shownIds: string[], accountIds: string[]): BankingOpen {
  if (opened?.kind === 'void' && !shownIds.includes(opened.transactionId)) return null;
  if (opened?.kind === 'archive' && !accountIds.includes(opened.accountId)) return null;
  return opened;
}

/** The title of the note that says a void was refused. */
export const VOID_REFUSED_TITLE = 'Transfer not voided';

/**
 * What to do when the open void question's row is no longer in the table (a search or filter hides it, or the
 * refresh after a refusal took it away because it was already voided or is gone). The question is closed for
 * good, so it does not come back, or take the focus, when a filter is cleared. If the void had been refused,
 * its sentence is returned so that it is said at the top of the page, where it outlives the question it was
 * in. While the void is still under way nothing is closed: its answer is still to come.
 */
export function voidQuestionGone(
  opened: BankingOpen,
  shownIds: string[],
  pending: boolean,
  error: string | null,
): { close: boolean; refusal: string | null } {
  const gone = opened?.kind === 'void' && !pending && !shownIds.includes(opened.transactionId);
  return gone ? { close: true, refusal: error } : { close: false, refusal: null };
}
