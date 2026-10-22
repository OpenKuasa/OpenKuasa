/**
 * The sentences for each refusal the shift swap functions raise. A leaf module with no imports, so a browser
 * component can read a sentence without loading the write path, which imports zod. `swap-writes.ts` re-exports it.
 */

/** Each refusal code the swap functions raise, and what the person is told. */
export const SWAP_REFUSALS: Record<string, string> = {
  SWAP_NOT_ALLOWED: "You can't do that with this shift swap.",
  SWAP_NOT_FOUND: 'That shift swap was not found.',
  SWAP_BAD_INPUT: 'That swap was not accepted. Pick two different shifts, and keep any note to 500 characters.',
  SWAP_NOT_YOUR_SHIFT: 'You can only offer one of your own shifts.',
  SWAP_BAD_COLLEAGUE: 'That colleague cannot take part in a swap. Pick an active colleague in this workspace.',
  SWAP_INACTIVE_EMPLOYEE: 'One of the employee records in this swap is inactive.',
  SWAP_NOT_FUTURE: 'Both shifts must be after today.',
  SWAP_CLASH: 'One of you already works on the other day, so those shifts cannot be swapped.',
  SWAP_ALREADY_OPEN: 'One of those shifts is already in a swap that is waiting. Cancel that one first.',
  SWAP_NOT_PENDING: 'That swap has already moved on. Refresh the page to see where it stands.',
  SWAP_SHIFT_CHANGED: 'The roster changed since this swap was asked for, so it cannot be approved. Reject it, and ask again if it still makes sense.',
  SWAP_OWN_REQUEST: 'You are one of the two people in this swap, so someone else has to decide it.',
};
