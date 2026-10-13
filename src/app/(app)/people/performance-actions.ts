'use server';

import {
  deleteGoal,
  deleteReview,
  deleteTraining,
  enrol,
  releaseReview,
  saveGoal,
  saveReview,
  saveTraining,
  setTrainingCompleted,
  unenrol,
  unreleaseReview,
} from '@/lib/people/performance-writes';
import { asAdmin, asMember, changed, refused, withoutEmployee } from './performance-guards';

// Every action passes its input to the write path, which validates it. The workspace is always the session's.

// ---- A member's own goals and enrolment -------------------------------------------------
// The employee is the viewer's linked record, never a field of the input: a smuggled `employee_id` is dropped.
// The database also lets a member change only their own, so a goal or course id alone cannot reach a colleague.

export async function saveMyGoalAction(input: unknown) {
  const guard = await asMember('performance-actions', true);
  if (refused(guard)) return guard;
  return changed(await saveGoal(guard.ctx, { ...withoutEmployee(input), employee_id: guard.employeeId! } as never));
}

export async function deleteMyGoalAction(input: unknown) {
  const guard = await asMember('performance-actions', true);
  if (refused(guard)) return guard;
  return changed(await deleteGoal(guard.ctx, withoutEmployee(input) as never));
}

export async function enrolMeAction(input: unknown) {
  const guard = await asMember('performance-actions', true);
  if (refused(guard)) return guard;
  return changed(await enrol(guard.ctx, { ...withoutEmployee(input), employee_id: guard.employeeId! } as never));
}

export async function withdrawMeAction(input: unknown) {
  const guard = await asMember('performance-actions', true);
  if (refused(guard)) return guard;
  return changed(await unenrol(guard.ctx, { ...withoutEmployee(input), employee_id: guard.employeeId! } as never));
}

// ---- Owner or admin -----------------------------------------------------------------------

export async function saveGoalForAction(input: unknown) {
  const guard = await asAdmin('performance-actions');
  if (refused(guard)) return guard;
  return changed(await saveGoal(guard.ctx, input as never));
}

export async function deleteGoalForAction(input: unknown) {
  const guard = await asAdmin('performance-actions');
  if (refused(guard)) return guard;
  return changed(await deleteGoal(guard.ctx, input as never));
}

export async function saveReviewAction(input: unknown) {
  const guard = await asAdmin('performance-actions');
  if (refused(guard)) return guard;
  return changed(await saveReview(guard.ctx, input as never));
}

export async function releaseReviewAction(input: unknown) {
  const guard = await asAdmin('performance-actions');
  if (refused(guard)) return guard;
  return changed(await releaseReview(guard.ctx, input as never));
}

export async function unreleaseReviewAction(input: unknown) {
  const guard = await asAdmin('performance-actions');
  if (refused(guard)) return guard;
  return changed(await unreleaseReview(guard.ctx, input as never));
}

export async function deleteReviewAction(input: unknown) {
  const guard = await asAdmin('performance-actions');
  if (refused(guard)) return guard;
  return changed(await deleteReview(guard.ctx, input as never));
}

export async function saveTrainingAction(input: unknown) {
  const guard = await asAdmin('performance-actions');
  if (refused(guard)) return guard;
  return changed(await saveTraining(guard.ctx, input as never));
}

export async function deleteTrainingAction(input: unknown) {
  const guard = await asAdmin('performance-actions');
  if (refused(guard)) return guard;
  return changed(await deleteTraining(guard.ctx, input as never));
}

export async function enrolAction(input: unknown) {
  const guard = await asAdmin('performance-actions');
  if (refused(guard)) return guard;
  return changed(await enrol(guard.ctx, input as never));
}

export async function unenrolAction(input: unknown) {
  const guard = await asAdmin('performance-actions');
  if (refused(guard)) return guard;
  return changed(await unenrol(guard.ctx, input as never));
}

export async function setTrainingCompletedAction(input: unknown) {
  const guard = await asAdmin('performance-actions');
  if (refused(guard)) return guard;
  return changed(await setTrainingCompleted(guard.ctx, input as never));
}
