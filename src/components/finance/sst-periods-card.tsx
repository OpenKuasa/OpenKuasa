'use client';

import Link from 'next/link';
import { CalendarClock } from 'lucide-react';
import { BentoCard } from '@/components/bento/bento';
import { useFinanceAction } from '@/components/finance/use-finance-action';
import { Button } from '@/components/ui/button';
import type { FinResult } from '@/lib/finance/result';
import type { SstReturnType } from '@/lib/finance/sst-return';
import { cn } from '@/lib/utils';

export type SstFiledAction = (input: { type: SstReturnType; period_start: string }) => Promise<FinResult<null>>;

export type SstPeriodRow = {
  start: string;
  label: string;
  /** Already formatted: "30 Nov 2026". */
  due: string;
  /** Item 14 formatted, or "not ready yet" (lower case: it follows "payable" mid-line). */
  payable: string;
  /** Formatted date it was marked filed, or null. */
  filedOn: string | null;
  /** Malaysian today is after the period's end, so it can be marked filed. */
  ended: boolean;
};

/**
 * The taxable periods of one tax type, newest first: due date, item 14 and the filed mark (#222 stage 2).
 * Bendahara cannot see MySST, so a person marks a return filed. `mark` and `unmark` are given only to an owner
 * or admin outside the demo; without them the marks are shown with no button. A refusal shows beside its button.
 */
export function SstPeriodsCard({
  type,
  shownStart,
  rows,
  mark,
  unmark,
}: {
  type: SstReturnType;
  shownStart: string;
  rows: SstPeriodRow[];
  mark?: SstFiledAction;
  unmark?: SstFiledAction;
}) {
  return (
    <BentoCard
      title="Periods"
      subtitle="Bendahara cannot see MySST, so you mark a return as filed"
      icon={CalendarClock}
      className="col-span-2 md:col-span-12"
    >
      <ul className="divide-y">
        {rows.map((r) => (
          <PeriodRow key={r.start} type={type} row={r} shown={r.start === shownStart} mark={mark} unmark={unmark} />
        ))}
      </ul>
    </BentoCard>
  );
}

function PeriodRow({
  type,
  row,
  shown,
  mark,
  unmark,
}: {
  type: SstReturnType;
  row: SstPeriodRow;
  shown: boolean;
  mark?: SstFiledAction;
  unmark?: SstFiledAction;
}) {
  const action = useFinanceAction();
  const filed = row.filedOn !== null;
  const input = { type, period_start: row.start };
  const button = filed ? unmark : row.ended ? mark : undefined;
  // A period still running is open, not overdue: only an ended, unmarked period is "Not filed".
  const badge = filed
    ? { text: 'Marked filed', tone: 'bg-emerald-500/15 text-emerald-600' }
    : row.ended
      ? { text: 'Not filed', tone: 'bg-amber-500/15 text-amber-600' }
      : { text: 'Open', tone: 'bg-muted text-muted-foreground' };

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2.5">
      <span className="min-w-0 flex-1 basis-48">
        <Link
          href={`?tax=${type}&period=${row.start}`}
          className={cn('block truncate text-sm font-medium hover:underline', shown && 'text-primary')}
          aria-current={shown ? 'page' : undefined}
        >
          {row.label}
        </Link>
        <span className="block text-xs text-muted-foreground">
          Due {row.due} · payable {row.payable}
          {filed ? ` · filed ${row.filedOn}` : ''}
        </span>
      </span>
      <span className={cn('shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium', badge.tone)}>{badge.text}</span>
      {button ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={filed ? `Undo the filed mark for ${row.label}` : `Mark ${row.label} as filed`}
          disabled={action.pending}
          onClick={() => action.run(() => button(input))}
        >
          {filed ? 'Undo' : 'Mark as filed'}
        </Button>
      ) : null}
      {action.error ? (
        <p role="alert" className="basis-full text-sm text-destructive">
          {action.error}
        </p>
      ) : null}
    </li>
  );
}
