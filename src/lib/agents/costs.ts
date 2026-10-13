/**
 * What each paid step of an agent run is assumed to cost when the provider has not
 * (yet) said. Deliberately on the high side: an estimate is what the spend caps see
 * until a real figure replaces it, so it must not flatter the run.
 *
 * Kept apart from the media seam (openrouter-media.ts) because tests replace that
 * whole module, and these numbers are part of the budget logic under test.
 */

/** One text call: the web search, the digest, or the proposal pick. */
export const TEXT_ESTIMATE_CENTS = 3;
/** One generated image. Also gates each image against the per-run cap. */
export const IMAGE_ESTIMATE_CENTS = 5;
/** One video clip; the priciest step, so it is gated last. */
export const VIDEO_ESTIMATE_CENTS = 50;

/**
 * OpenRouter reports cost in USD credits. Whole cents, rounded up, because
 * `cost_cents` columns are INTEGER; `null` when the provider gave no figure, which
 * is not the same as a reported cost of zero.
 */
export function usdToCents(usd: unknown): number | null {
  return typeof usd === 'number' && Number.isFinite(usd) && usd >= 0 ? Math.ceil(usd * 100) : null;
}

/** The provider's figure when it gave one (zero included), otherwise the step's estimate. */
export function costOr(reported: number | null | undefined, estimateCents: number): number {
  return typeof reported === 'number' && Number.isFinite(reported) && reported >= 0
    ? reported
    : estimateCents;
}
