// src/lib/hire/delete-dialog-state.ts
/**
 * Everything the delete dialog decides, as plain functions: the tests run with
 * no DOM, so a decision made inside the component could not be tested. Pure.
 */
import { CHECKING, SUMMARY_FAILED, confirmBody, type DeletionKind, type Removal } from './deletion';

/** The id of a screen's notice line: where the success sentence is written, and where focus goes when the row has gone. */
export const DELETION_NOTICE_ID = 'hire-deletion-notice';

/** What is to be deleted, from values the row already has: ids and names, nothing else. */
export type DeleteTarget = { kind: DeletionKind; id: string; name: string; job: string | null };

/** What the dialog knows about what will go. */
export type SummaryState =
  | { state: 'loading' }
  | { state: 'ready'; removal: Removal }
  | { state: 'failed'; error: string };

export const LOADING: SummaryState = { state: 'loading' };

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;

/**
 * The answer of the summary action as a state. Anything that is not a
 * well-formed answer (a throw is passed as null) fails closed: the dialog then
 * offers no way to delete.
 */
export function summaryFrom(result: unknown): SummaryState {
  const failed: SummaryState = { state: 'failed', error: SUMMARY_FAILED };
  if (!result || typeof result !== 'object') return failed;
  const answer = result as { ok?: unknown; data?: unknown; error?: unknown };
  if (answer.ok === false && typeof answer.error === 'string' && answer.error) return { state: 'failed', error: answer.error };
  if (answer.ok !== true || !answer.data || typeof answer.data !== 'object') return failed;
  const data = answer.data as { name?: unknown; job?: unknown; applications?: unknown; interviews?: unknown; cvFiles?: unknown };
  if (typeof data.name !== 'string') return failed;
  if (!isCount(data.applications) || !isCount(data.interviews) || !isCount(data.cvFiles)) return failed;
  return {
    state: 'ready',
    removal: {
      name: data.name,
      job: typeof data.job === 'string' ? data.job : null,
      applications: data.applications,
      interviews: data.interviews,
      cvFiles: data.cvFiles,
    },
  };
}

/** The dialog's body: checking, exactly what goes, or why it could not be checked. */
export function dialogBody(kind: DeletionKind, summary: SummaryState): string {
  if (summary.state === 'loading') return CHECKING;
  if (summary.state === 'failed') return summary.error;
  return confirmBody(kind, summary.removal);
}

/** Only once the numbers are on screen, and never while a deletion is being saved. */
export function canConfirm(summary: SummaryState, busy: boolean): boolean {
  return summary.state === 'ready' && !busy;
}

export function confirmLabel(kind: DeletionKind, busy: boolean): string {
  if (busy) return 'Deleting…';
  return kind === 'application' ? 'Delete application' : 'Delete candidate';
}

/** Cancel and Escape do nothing while a deletion is being saved. */
export function mayClose(busy: boolean): boolean {
  return !busy;
}

/**
 * Where focus goes when the dialog has closed. Null: back to what opened it.
 * After a deletion that control has gone, so an id that is still in the page:
 * the one given (a board column's heading), else the screen's notice line.
 */
export function focusIdAfter(deleted: boolean, focusAfterId?: string): string | null {
  if (!deleted) return null;
  return focusAfterId ?? DELETION_NOTICE_ID;
}

/** An application's row as a target: the application by its own id, the candidate by theirs. */
export function deleteTargetFor(
  kind: DeletionKind,
  application: { id: string; candidateId: string; name: string; job: string },
): DeleteTarget {
  return kind === 'application'
    ? { kind, id: application.id, name: application.name, job: application.job }
    : { kind, id: application.candidateId, name: application.name, job: null };
}
