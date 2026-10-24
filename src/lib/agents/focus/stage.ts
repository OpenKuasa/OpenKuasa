/**
 * The doubling bucket a count of days is in, past the threshold `n`: n, 2n, 4n, 8n… So a check
 * with a 14-day threshold is raised at 14 days, again at 28, then 56, 112. Null below `n`.
 * Product-neutral: every focus agent's "raised again only when it gets worse" uses it.
 */
export function doublingStage(days: number, n: number): number | null {
  if (n < 1 || days < n) return null;
  let stage = n;
  while (stage * 2 <= days) stage *= 2;
  return stage;
}
