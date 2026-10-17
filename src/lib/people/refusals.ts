/**
 * The sentences an approval screen shows, and the one sentence for deciding your
 * own request. A leaf module with no imports, so a browser component can read a
 * sentence without loading the write path, which imports zod.
 *
 * The write paths keep re-exporting these, so a server file can still import
 * `LEAVE_REFUSALS` from `leave.ts` and nothing else has to change.
 */

/**
 * What an admin is told when the request they are deciding, or marking as
 * paid, is their own. The database raises LEAVE_OWN_REQUEST or PAY_OWN_REQUEST;
 * the same sentence answers both, and the approval screens show it in place of
 * the buttons.
 */
export const OWN_REQUEST_REFUSAL =
  "You can't approve, reject or pay your own request. Ask the workspace owner or another admin.";

/** Each refusal code the leave functions raise, and what the person is told. */
export const LEAVE_REFUSALS: Record<string, string> = {
  LEAVE_NOT_ALLOWED: "You can't make that change.",
  // An admin deciding their own request; the workspace's owner may.
  LEAVE_OWN_REQUEST: OWN_REQUEST_REFUSAL,
  LEAVE_OVERLAP: 'That overlaps leave already applied for on those dates.',
  LEAVE_NO_WORKING_DAY: 'Those dates have no working day in them.',
  LEAVE_NOT_PENDING: 'That request has already been decided or cancelled.',
  LEAVE_ALREADY_STARTED: 'That leave has already started. Ask an owner or admin to cancel it.',
  LEAVE_INACTIVE_EMPLOYEE: 'That employee is inactive.',
  LEAVE_NOT_FOUND: 'That request was not found.',
  LEAVE_BAD_INPUT: "That request isn't valid. Check the dates and try again.",
};

/** Each refusal code the claim and overtime functions raise, and what the person is told. */
export const PAY_REFUSALS: Record<string, string> = {
  PAY_NOT_ALLOWED: "You can't make that change.",
  // An admin deciding, or marking as paid, their own claim or overtime; the workspace's owner may.
  PAY_OWN_REQUEST: OWN_REQUEST_REFUSAL,
  PAY_NOT_FOUND: 'That request was not found.',
  PAY_NOT_PENDING: 'That request has already been decided or cancelled.',
  PAY_NOT_APPROVED: 'Only an approved claim can be marked as paid.',
  PAY_NOT_PAID: 'That claim is not marked as paid.',
  PAY_ALREADY_PAID: 'That claim is marked as paid. Undo the paid mark first.',
  PAY_INACTIVE_EMPLOYEE: 'That employee is inactive.',
  PAY_TOO_MANY_HOURS: 'That would be more than 24 hours of overtime on one day.',
  PAY_BAD_RECEIPT: 'That receipt could not be attached. Please upload it again.',
  PAY_BAD_INPUT: "That request isn't valid. Check the details and try again.",
};
