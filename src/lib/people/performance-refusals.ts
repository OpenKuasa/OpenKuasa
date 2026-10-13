/**
 * The sentences for every goal, review, training and announcement refusal code. A leaf module with no imports,
 * so any file that needs one sentence can read it without loading the write paths.
 */

/** Each refusal code the performance and announcement functions raise, and what the person is told. */
export const PERFORMANCE_REFUSALS: Record<string, string> = {
  PERF_NOT_ALLOWED: "You can't make that change.",
  ANN_NOT_ALLOWED: "You can't make that change.",
  PERF_NOT_FOUND: 'That record could not be found.',
  ANN_NOT_FOUND: 'That announcement could not be found.',
  PERF_BAD_INPUT: 'Some of that was not accepted. Check it and try again.',
  ANN_BAD_INPUT: 'Some of that was not accepted. Check it and try again.',
  PERF_TOO_MANY_GOALS: 'That is 30 open goals already. Finish or remove one first.',
  PERF_REVIEW_EXISTS: 'There is already a review for that period.',
  PERF_NOT_DRAFT: 'That review has been released. Pull it back to draft on the Review Scores screen to change it.',
  PERF_NOT_RELEASED: 'That review is still a draft.',
  PERF_ALREADY_ENROLLED: 'They are already enrolled in that course.',
  PERF_NOT_ENROLLED: 'They are not enrolled in that course.',
  PERF_COURSE_ENDED: 'That course has ended.',
  PERF_COURSE_STARTED: 'That course has already started. Ask an owner or admin to remove you.',
  PERF_COURSE_NOT_STARTED: 'That course has not started yet.',
  PERF_COMPLETED: 'Someone is marked as completed on it. Undo that first.',
  PERF_INACTIVE_EMPLOYEE: 'This employee record is inactive.',
  ANN_NOT_DRAFT: 'That announcement is already published.',
  ANN_NOT_PUBLISHED: 'That announcement is still a draft.',
};
