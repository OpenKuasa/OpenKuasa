'use client';

/**
 * Shared chart kit — thin, themed wrappers over Recharts 3, built on the
 * shadcn `ui/chart` primitive so every chart picks up our `--chart-*` tokens,
 * tooltips and legend styling automatically.
 *
 * Rules for callers (incl. server screens):
 *  - Pass only serializable props (arrays of numbers/strings, series configs).
 *    Never pass a LucideIcon or ReactNode in here — compose those in the
 *    screen, around the chart.
 *  - Every chart has a fixed pixel height (overridable) so the bento grid
 *    never shifts on hydrate.
 */

import { useId, type CSSProperties } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Label,
  Line,
  LineChart,
  Pie,
  PieChart,
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  RadialBar,
  RadialBarChart,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from 'recharts';
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart';
import { cn } from '@/lib/utils';
import {
  X_KEY,
  keyedRows,
  keyedSlices,
  safeKey,
  seriesConfig,
  sliceConfig,
  token,
  type Series,
  type Slice,
} from './keys';

export type { Series, Slice };

/*
 * Every chart below draws from positional keys (`s0`, `s1`, …), never from the
 * `key` a caller passes: see ./keys. The caller's key only says which field of
 * a row a series reads; the label is what people see.
 */

/** Fixed-height wrapper props shared by the Recharts-backed charts. */
const fill = (height: number): CSSProperties => ({ height, aspectRatio: 'auto' });

/* ------------------------------------------------------------------ */
/* Area trend — gradient area chart for time series.                   */
/* ------------------------------------------------------------------ */

export function AreaTrend({
  data,
  series,
  xKey = 'label',
  height = 220,
  stacked = false,
  showLegend = false,
  className,
}: {
  data: Record<string, string | number>[];
  series: Series[];
  xKey?: string;
  height?: number;
  stacked?: boolean;
  showLegend?: boolean;
  className?: string;
}) {
  // Each chart's gradients get ids of their own: two charts on a page both have an `s0`.
  const id = useId().replace(/:/g, '');
  const keys = series.map((_, i) => safeKey(i));
  return (
    <ChartContainer
      config={seriesConfig(series)}
      style={fill(height)}
      className={cn('w-full', className)}
    >
      <AreaChart
        data={keyedRows(data, series, xKey)}
        margin={{ left: 4, right: 8, top: 8, bottom: 0 }}
      >
        <defs>
          {keys.map((key) => (
            <linearGradient key={key} id={`at-${id}-${key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={`var(--color-${key})`} stopOpacity={0.35} />
              <stop offset="95%" stopColor={`var(--color-${key})`} stopOpacity={0.04} />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis
          dataKey={X_KEY}
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={16}
        />
        <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
        {keys.map((key) => (
          <Area
            key={key}
            dataKey={key}
            type="monotone"
            stroke={`var(--color-${key})`}
            fill={`url(#at-${id}-${key})`}
            strokeWidth={2}
            stackId={stacked ? 'a' : undefined}
          />
        ))}
        {showLegend ? <ChartLegend content={<ChartLegendContent />} /> : null}
      </AreaChart>
    </ChartContainer>
  );
}

/* ------------------------------------------------------------------ */
/* Bar group — vertical or horizontal bars.                            */
/* ------------------------------------------------------------------ */

export function BarGroup({
  data,
  series,
  xKey = 'label',
  height = 220,
  horizontal = false,
  stacked = false,
  showLegend = false,
  className,
}: {
  data: Record<string, string | number>[];
  series: Series[];
  xKey?: string;
  height?: number;
  horizontal?: boolean;
  stacked?: boolean;
  showLegend?: boolean;
  className?: string;
}) {
  const keys = series.map((_, i) => safeKey(i));
  return (
    <ChartContainer
      config={seriesConfig(series)}
      style={fill(height)}
      className={cn('w-full', className)}
    >
      <BarChart
        data={keyedRows(data, series, xKey)}
        layout={horizontal ? 'vertical' : 'horizontal'}
        margin={{ left: 4, right: 8, top: 8, bottom: 0 }}
      >
        <CartesianGrid
          horizontal={!horizontal ? true : false}
          vertical={horizontal ? true : false}
          strokeDasharray="3 3"
        />
        {horizontal ? (
          <>
            <XAxis type="number" hide />
            <YAxis
              type="category"
              dataKey={X_KEY}
              tickLine={false}
              axisLine={false}
              width={84}
            />
          </>
        ) : (
          <XAxis dataKey={X_KEY} tickLine={false} axisLine={false} tickMargin={8} />
        )}
        <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
        {keys.map((key) => (
          <Bar
            key={key}
            dataKey={key}
            fill={`var(--color-${key})`}
            radius={horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]}
            stackId={stacked ? 'a' : undefined}
          />
        ))}
        {showLegend ? <ChartLegend content={<ChartLegendContent />} /> : null}
      </BarChart>
    </ChartContainer>
  );
}

/* ------------------------------------------------------------------ */
/* Donut — proportion with an optional centre label.                   */
/* ------------------------------------------------------------------ */

export function DonutStat({
  data,
  height = 220,
  centerValue,
  centerLabel,
  showLegend = true,
  className,
}: {
  data: Slice[];
  height?: number;
  centerValue?: string;
  centerLabel?: string;
  showLegend?: boolean;
  className?: string;
}) {
  const slices = keyedSlices(data);
  return (
    <ChartContainer
      config={sliceConfig(data)}
      style={fill(height)}
      className={cn('w-full', className)}
    >
      <PieChart>
        <ChartTooltip cursor={false} content={<ChartTooltipContent nameKey="key" />} />
        <Pie
          data={slices}
          dataKey="value"
          nameKey="key"
          innerRadius="58%"
          outerRadius="88%"
          paddingAngle={2}
          strokeWidth={2}
        >
          {slices.map((d) => (
            <Cell key={d.key} fill={`var(--color-${d.key})`} />
          ))}
          {centerValue ? (
            <Label
              content={({ viewBox }) => {
                if (viewBox && 'cx' in viewBox && viewBox.cx != null) {
                  const cx = viewBox.cx;
                  const cy = viewBox.cy ?? 0;
                  return (
                    <text x={cx} y={cy} textAnchor="middle" dominantBaseline="middle">
                      <tspan
                        x={cx}
                        y={cy - 4}
                        className="fill-foreground text-xl font-bold"
                      >
                        {centerValue}
                      </tspan>
                      {centerLabel ? (
                        <tspan
                          x={cx}
                          y={cy + 15}
                          className="fill-muted-foreground text-xs"
                        >
                          {centerLabel}
                        </tspan>
                      ) : null}
                    </text>
                  );
                }
                return null;
              }}
            />
          ) : null}
        </Pie>
        {showLegend ? (
          <ChartLegend
            content={
              <ChartLegendContent
                nameKey="key"
                className="-translate-y-1 flex-wrap gap-x-3 gap-y-1"
              />
            }
          />
        ) : null}
      </PieChart>
    </ChartContainer>
  );
}

/* ------------------------------------------------------------------ */
/* Radial gauge — one value out of max, as an arc with a centre label. */
/* ------------------------------------------------------------------ */

export function RadialGauge({
  value,
  max = 100,
  label,
  valueLabel,
  color = 'var(--chart-1)',
  height = 200,
  className,
}: {
  value: number;
  max?: number;
  label?: string;
  valueLabel?: string;
  color?: string;
  height?: number;
  className?: string;
}) {
  const pct = Math.max(0, Math.min(value / max, 1));
  const endAngle = 90 - pct * 360;
  return (
    <ChartContainer
      config={{ value: { label: label ?? 'Value', color } }}
      style={fill(height)}
      className={cn('w-full', className)}
    >
      <RadialBarChart
        data={[{ value, fill: color }]}
        startAngle={90}
        endAngle={endAngle}
        innerRadius="66%"
        outerRadius="100%"
      >
        <PolarGrid
          gridType="circle"
          radialLines={false}
          stroke="none"
          className="first:fill-muted last:fill-background"
          polarRadius={[86, 74]}
        />
        <RadialBar dataKey="value" background cornerRadius={8} />
        <PolarRadiusAxis tick={false} axisLine={false} domain={[0, max]}>
          <Label
            content={({ viewBox }) => {
              if (viewBox && 'cx' in viewBox && viewBox.cx != null) {
                const cx = viewBox.cx;
                const cy = viewBox.cy ?? 0;
                return (
                  <text x={cx} y={cy} textAnchor="middle" dominantBaseline="middle">
                    <tspan x={cx} y={cy - 2} className="fill-foreground text-2xl font-bold">
                      {valueLabel ?? value}
                    </tspan>
                    {label ? (
                      <tspan x={cx} y={cy + 18} className="fill-muted-foreground text-xs">
                        {label}
                      </tspan>
                    ) : null}
                  </text>
                );
              }
              return null;
            }}
          />
        </PolarRadiusAxis>
      </RadialBarChart>
    </ChartContainer>
  );
}

/* ------------------------------------------------------------------ */
/* Radar — multi-metric comparison.                                    */
/* ------------------------------------------------------------------ */

export function RadarSpread({
  data,
  series,
  height = 240,
  className,
}: {
  data: Record<string, string | number>[];
  series: Series[];
  height?: number;
  className?: string;
}) {
  const keys = series.map((_, i) => safeKey(i));
  return (
    <ChartContainer
      config={seriesConfig(series)}
      style={fill(height)}
      className={cn('mx-auto w-full', className)}
    >
      <RadarChart
        data={keyedRows(data, series, 'label')}
        margin={{ top: 8, right: 8, bottom: 8, left: 8 }}
      >
        <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
        <PolarGrid className="stroke-border" />
        <PolarAngleAxis dataKey={X_KEY} className="fill-muted-foreground text-xs" />
        {keys.map((key) => (
          <Radar
            key={key}
            dataKey={key}
            stroke={`var(--color-${key})`}
            fill={`var(--color-${key})`}
            fillOpacity={0.2}
            strokeWidth={2}
          />
        ))}
      </RadarChart>
    </ChartContainer>
  );
}

/* ------------------------------------------------------------------ */
/* Funnel — stage drop-off as centred, decreasing bars (not Recharts). */
/* Reads cleanly with uneven stages; shows value + conversion vs top.   */
/* ------------------------------------------------------------------ */

export function FunnelFlow({
  data,
  height = 200,
  className,
}: {
  data: Slice[];
  height?: number;
  className?: string;
}) {
  const top = data[0]?.value || 1;
  return (
    <div
      className={cn('flex flex-col justify-center gap-1.5', className)}
      style={{ minHeight: height }}
    >
      {data.map((d, i) => {
        const width = Math.max(10, (d.value / top) * 100);
        const conv = Math.round((d.value / top) * 100);
        return (
          <div key={safeKey(i)} className="flex items-center gap-2">
            <span className="w-20 shrink-0 truncate text-right text-xs text-muted-foreground">
              {d.label}
            </span>
            <div className="flex-1">
              <div
                className="mx-auto flex h-7 items-center justify-center rounded-md text-xs font-semibold text-white shadow-sm"
                style={{ width: `${width}%`, backgroundColor: d.color ?? token(i) }}
                title={`${d.label}: ${d.value}`}
              >
                {d.value.toLocaleString()}
              </div>
            </div>
            <span className="w-9 shrink-0 text-xs tabular-nums text-muted-foreground">
              {conv}%
            </span>
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Sparkline — tiny trend for KPI tiles (no axes, no tooltip).         */
/* ------------------------------------------------------------------ */

export function Sparkline({
  data,
  color = 'var(--chart-1)',
  type = 'area',
  height = 40,
  className,
}: {
  data: number[];
  color?: string;
  type?: 'area' | 'line';
  height?: number;
  className?: string;
}) {
  const id = useId().replace(/:/g, '');
  const series = data.map((v, i) => ({ i, v }));
  return (
    <div className={cn('w-full', className)} style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        {type === 'area' ? (
          <AreaChart data={series} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id={`sp-${id}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.3} />
                <stop offset="100%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <Area
              dataKey="v"
              type="monotone"
              stroke={color}
              fill={`url(#sp-${id})`}
              strokeWidth={1.75}
              dot={false}
              isAnimationActive={false}
            />
          </AreaChart>
        ) : (
          <LineChart data={series} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
            <Line
              dataKey="v"
              type="monotone"
              stroke={color}
              strokeWidth={1.75}
              dot={false}
              isAnimationActive={false}
            />
          </LineChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Heat grid — weekly activity heatmap (plain divs, no library).       */
/* ------------------------------------------------------------------ */

export function HeatGrid({
  xLabels,
  yLabels,
  values,
  color = 'var(--chart-1)',
  className,
}: {
  xLabels: string[];
  yLabels: string[];
  /** values[y][x] — rows keyed by yLabels, columns by xLabels. */
  values: number[][];
  color?: string;
  className?: string;
}) {
  const max = Math.max(1, ...values.flat());
  return (
    <div className={cn('w-full', className)}>
      <div className="flex flex-col gap-1">
        {values.map((row, y) => (
          <div key={yLabels[y]} className="flex items-center gap-1">
            <span className="w-8 shrink-0 text-right text-[10px] text-muted-foreground">
              {yLabels[y]}
            </span>
            <div className="flex flex-1 gap-1">
              {row.map((v, x) => (
                <div
                  key={`${yLabels[y]}-${xLabels[x]}`}
                  title={`${yLabels[y]} ${xLabels[x]}: ${v}`}
                  className="h-5 flex-1 rounded-[3px] border border-border/40"
                  style={{
                    backgroundColor: color,
                    opacity: 0.08 + 0.92 * (v / max),
                  }}
                />
              ))}
            </div>
          </div>
        ))}
        <div className="flex items-center gap-1 pt-0.5">
          <span className="w-8 shrink-0" />
          <div className="flex flex-1 gap-1">
            {xLabels.map((x) => (
              <span
                key={x}
                className="min-w-0 flex-1 truncate text-center text-[10px] text-muted-foreground"
              >
                {x}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
