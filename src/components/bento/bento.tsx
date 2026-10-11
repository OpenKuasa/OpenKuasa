import { type LucideIcon } from 'lucide-react';
import { type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { AnimatedIcon } from '@/components/ui/animated-icon';

/**
 * Dense bento layout primitives.
 *
 * `BentoGrid` is a 12-column grid on md+ (2 columns on mobile) with tight gaps,
 * so tiles pack together with minimal whitespace. Tiles set their own width
 * with literal Tailwind spans, e.g.
 *
 *   <BentoCard className="col-span-2 md:col-span-12" ... />  // full row
 *   <BentoCard className="col-span-1 md:col-span-3"  ... />  // KPI quarter
 *   <BentoCard className="col-span-2 md:col-span-8"  ... />  // two-thirds
 *   <BentoCard className="col-span-2 md:col-span-6"  ... />  // half
 *
 * Keep spans as literal classes (not interpolated) so Tailwind emits them.
 */
export function BentoGrid({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn('grid grid-cols-2 gap-3 md:grid-cols-12', className)}>
      {children}
    </div>
  );
}

export type BentoTone = 'default' | 'muted' | 'primary';

const TONES: Record<BentoTone, string> = {
  default: 'border bg-card text-card-foreground',
  muted: 'border bg-muted/40 text-card-foreground',
  primary:
    'border-primary/20 bg-gradient-to-br from-primary to-primary/80 text-primary-foreground',
};

/**
 * A single bento tile. Optional header (icon chip + title/subtitle on the
 * left, `action` on the right); `children` is the body. Set `flush` for
 * edge-to-edge content (e.g. a chart that should bleed to the border).
 */
export function BentoCard({
  title,
  subtitle,
  icon: Icon,
  action,
  tone = 'default',
  flush = false,
  className,
  bodyClassName,
  children,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  icon?: LucideIcon;
  action?: ReactNode;
  tone?: BentoTone;
  flush?: boolean;
  className?: string;
  bodyClassName?: string;
  children?: ReactNode;
}) {
  const hasHeader = title != null || action != null;
  const onPrimary = tone === 'primary';
  return (
    <section
      className={cn(
        'group/bento flex flex-col overflow-hidden rounded-xl shadow-sm',
        flush ? '' : 'p-4',
        TONES[tone],
        className,
      )}
    >
      {hasHeader ? (
        <div className={cn('flex items-start justify-between gap-2', flush && 'p-4 pb-0')}>
          <div className="flex min-w-0 items-center gap-2.5">
            {Icon ? (
              <span
                className={cn(
                  'grid size-8 shrink-0 place-items-center rounded-lg',
                  onPrimary
                    ? 'bg-primary-foreground/15 text-primary-foreground'
                    : 'bg-primary/10 text-primary',
                )}
              >
                <AnimatedIcon
                  name={(Icon as unknown as { displayName?: string }).displayName}
                  size={16}
                />
              </span>
            ) : null}
            <div className="min-w-0">
              {title ? (
                <h3 className="truncate text-sm font-semibold leading-tight">{title}</h3>
              ) : null}
              {subtitle ? (
                <p
                  className={cn(
                    'truncate text-xs',
                    onPrimary ? 'text-primary-foreground/70' : 'text-muted-foreground',
                  )}
                >
                  {subtitle}
                </p>
              ) : null}
            </div>
          </div>
          {action ? <div className="shrink-0">{action}</div> : null}
        </div>
      ) : null}
      <div
        className={cn(
          hasHeader && !flush && 'mt-3',
          flush && hasHeader && 'mt-3',
          'min-w-0 flex-1',
          bodyClassName,
        )}
      >
        {children}
      </div>
    </section>
  );
}

/**
 * Compact KPI figure for inside a bento tile: big value, label, delta chip and
 * (optionally) a sparkline passed as `chart`.
 */
export function BentoStat({
  label,
  value,
  delta,
  deltaTone = 'up',
  chart,
  onPrimary = false,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  delta?: ReactNode;
  deltaTone?: 'up' | 'down' | 'flat';
  chart?: ReactNode;
  onPrimary?: boolean;
  className?: string;
}) {
  const deltaClass = onPrimary
    ? 'bg-primary-foreground/15 text-primary-foreground'
    : deltaTone === 'up'
      ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
      : deltaTone === 'down'
        ? 'bg-red-500/15 text-red-600 dark:text-red-400'
        : 'bg-muted text-muted-foreground';
  return (
    <div className={cn('flex flex-col', className)}>
      <p
        className={cn(
          'text-xs font-medium',
          onPrimary ? 'text-primary-foreground/70' : 'text-muted-foreground',
        )}
      >
        {label}
      </p>
      {/* A figure and its chip never break inside themselves; in a narrow card the chip drops below the figure. */}
      <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-2xl font-bold tracking-tight whitespace-nowrap tabular-nums">{value}</span>
        {delta != null ? (
          <span
            className={cn(
              'rounded-full px-1.5 py-0.5 text-[11px] font-semibold whitespace-nowrap',
              deltaClass,
            )}
          >
            {delta}
          </span>
        ) : null}
      </div>
      {chart ? <div className="mt-2">{chart}</div> : null}
    </div>
  );
}
