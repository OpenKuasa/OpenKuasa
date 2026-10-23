/**
 * Product-neutral focus plan: the owner writes a focus in their own words, a model
 * picks checks from a FIXED menu, and this module is the gate that keeps only what the
 * menu allows. Nothing the model says can add a check, a param or an action.
 */

export type CheckSpec = {
  key: string;
  params: Record<string, { min: number; max: number; default: number }>;
  describe(params: Record<string, number>): string;
  summary: string;
};
export type FocusMenu = { product: string; checks: readonly CheckSpec[] };
export type FocusPlan = { checks: { key: string; params: Record<string, number> }[] };

const MAX_CANNOT = 5;
const MAX_CANNOT_LENGTH = 120;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cleanParams(spec: CheckSpec, raw: unknown): Record<string, number> {
  const given = isRecord(raw) ? raw : {};
  const out: Record<string, number> = {};
  for (const [name, range] of Object.entries(spec.params)) {
    const value = given[name];
    out[name] =
      typeof value === 'number' && Number.isFinite(value)
        ? Math.round(Math.min(range.max, Math.max(range.min, value)))
        : range.default;
  }
  return out;
}

export function validatePlan(menu: FocusMenu, raw: unknown): { plan: FocusPlan; cannot: string[] } {
  const body = isRecord(raw) ? raw : {};
  const checks: FocusPlan['checks'] = [];
  const seen = new Set<string>();
  if (Array.isArray(body.checks)) {
    for (const item of body.checks) {
      if (!isRecord(item) || typeof item.key !== 'string' || seen.has(item.key)) continue;
      const spec = menu.checks.find((c) => c.key === item.key);
      if (!spec) continue;
      seen.add(spec.key);
      checks.push({ key: spec.key, params: cleanParams(spec, item.params) });
    }
  }
  const cannot = Array.isArray(body.cannot)
    ? body.cannot
        .filter((s): s is string => typeof s === 'string')
        .map((s) => s.trim().slice(0, MAX_CANNOT_LENGTH))
        .filter((s) => s.length > 0)
        .slice(0, MAX_CANNOT)
    : [];
  return { plan: { checks }, cannot };
}

/** One plain-language line per check, for the owner to confirm. */
export function readBack(menu: FocusMenu, plan: FocusPlan): string[] {
  const lines: string[] = [];
  for (const check of plan.checks) {
    const spec = menu.checks.find((c) => c.key === check.key);
    if (spec) lines.push(spec.describe(cleanParams(spec, check.params)));
  }
  return lines;
}

/** The plain-language line for one check key, with the given params (clamped; defaults fill gaps). Null for an unknown key. */
export function describeCheck(menu: FocusMenu, key: string, params?: unknown): string | null {
  const spec = menu.checks.find((c) => c.key === key);
  return spec ? spec.describe(cleanParams(spec, params)) : null;
}
