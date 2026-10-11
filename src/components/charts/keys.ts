import type { ChartConfig } from '@/components/ui/chart';

/**
 * Chart keys.
 *
 * A chart's key ends up as a CSS custom property name (`--color-<key>`), an
 * SVG id and a Recharts data key. What a caller passes as `key` is often a
 * record's own name (a department, a category, a source), which is free text.
 * So the charts never use it: every series and slice is keyed by its position
 * (`s0`, `s1`, …) and its label travels separately, as text.
 */

/** A metric line/series drawn across a shared x-axis. */
export type Series = { key: string; label: string; color?: string };
/** A single categorical slice (donut / funnel). */
export type Slice = { key: string; label: string; value: number; color?: string };

/** Where a re-keyed row holds its x-axis value. */
export const X_KEY = 'x';

export const safeKey = (i: number) => `s${i}`;

export const token = (i: number) => `var(--chart-${(i % 5) + 1})`;

const positional = (items: { label: string; color?: string }[]): ChartConfig =>
  Object.fromEntries(
    items.map((item, i) => [safeKey(i), { label: item.label, color: item.color ?? token(i) }]),
  );

export const seriesConfig = (series: Series[]): ChartConfig => positional(series);

export const sliceConfig = (slices: Slice[]): ChartConfig => positional(slices);

/** The same slices, each keyed by its position. */
export const keyedSlices = (slices: Slice[]): Slice[] =>
  slices.map((slice, i) => ({ ...slice, key: safeKey(i) }));

/**
 * Rows for a series chart, re-keyed to match `seriesConfig`: the x value under
 * `X_KEY` and each series' value under its positional key. A value is read by
 * the series' own name, as a plain property, so a name with a dot in it is not
 * taken for a path.
 */
export function keyedRows(
  data: Record<string, string | number>[],
  series: Series[],
  xKey: string,
): Record<string, string | number>[] {
  return data.map((row) => {
    const out: Record<string, string | number> = {};
    if (Object.hasOwn(row, xKey)) out[X_KEY] = row[xKey];
    series.forEach((s, i) => {
      if (Object.hasOwn(row, s.key)) out[safeKey(i)] = row[s.key];
    });
    return out;
  });
}
