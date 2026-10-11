// src/lib/hire/application-changes.ts
/**
 * The pure rules for changing a job application. The database applies the same
 * rules inside its functions; these exist so screens can offer only the moves
 * that will be accepted and so the two stay in step under test.
 */
import type { ApplicationOutcome, ApplicationStage } from './types';

/** The stages in order, as in the types file (kept here so this file imports types only). */
const APPLICATION_STAGES: readonly ApplicationStage[] = ['applied', 'screening', 'interview', 'offer', 'hired'];

export const REJECT_REASONS = ['skills', 'experience', 'salary', 'role_filled', 'not_reachable', 'other'] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

export const REASON_LABEL: Record<RejectReason, string> = {
  skills: 'Skills not a match',
  experience: 'Not enough experience',
  salary: 'Salary expectations',
  role_filled: 'Role filled',
  not_reachable: 'Could not reach the candidate',
  other: 'Other',
};

export type MoveProblem = 'not_active' | 'same_stage' | 'too_far_back';

/** Why a move would be refused, or null when it is allowed. */
export function moveProblem(
  from: ApplicationStage,
  to: ApplicationStage,
  outcome: ApplicationOutcome,
): MoveProblem | null {
  if (outcome !== 'active') return 'not_active';
  const a = APPLICATION_STAGES.indexOf(from);
  const b = APPLICATION_STAGES.indexOf(to);
  if (a === b) return 'same_stage';
  if (b < a - 1) return 'too_far_back';
  return null;
}

/** Every later stage and the one before, in stage order; none when the application is closed. */
export function allowedMoves(from: ApplicationStage, outcome: ApplicationOutcome): ApplicationStage[] {
  return APPLICATION_STAGES.filter((to) => moveProblem(from, to, outcome) === null);
}

/** The offer and hire dates after a move: set exactly when the stage says so. */
export function datesAfterMove(
  to: ApplicationStage,
  offeredAt: string | null,
  hiredAt: string | null,
  nowIso: string,
): { offered_at: string | null; hired_at: string | null } {
  const offered = to === 'offer' || to === 'hired';
  return {
    offered_at: offered ? (offeredAt ?? nowIso) : null,
    hired_at: to === 'hired' ? (hiredAt ?? nowIso) : null,
  };
}

const GENERIC = 'That change could not be saved. Please try again.';

/** What the person is told for each word the database functions answer with. */
export const CHANGE_MESSAGES: Record<string, string> = {
  not_found: 'That application could not be found.',
  forbidden: 'You do not have permission to make changes here.',
  not_active: 'This application is no longer active. Reopen it first.',
  not_closed: 'This application is already active.',
  same_stage: 'This application is already at that stage.',
  too_far_back: 'An application can move back one stage at a time.',
  invalid_stage: GENERIC,
  invalid_outcome: GENERIC,
  invalid_reason: GENERIC,
  invalid_rating: GENERIC,
};

export function changeMessage(word: unknown): string {
  return typeof word === 'string' && Object.hasOwn(CHANGE_MESSAGES, word) ? CHANGE_MESSAGES[word] : GENERIC;
}
