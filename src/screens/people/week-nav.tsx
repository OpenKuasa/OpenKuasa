import { ChevronLeft, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { buttonVariants } from '@/components/ui/button';
import { formatDay } from '@/lib/people/dates';
import { type WeekNav as Nav, weekHref } from '@/lib/people/roster';

/** Previous week, this week and next week, as links that set `?week=` (the Monday). */
export function WeekNav({ path, nav }: { path: string; nav: Nav }) {
  const outline = buttonVariants({ variant: 'outline', size: 'sm' });
  return (
    <nav aria-label="Choose the week" className="flex flex-wrap items-center gap-2">
      <Link href={weekHref(path, nav.previous, nav.current)} className={outline} aria-label={`Previous week, from ${formatDay(nav.previous)}`}>
        <ChevronLeft aria-hidden />
      </Link>
      {nav.isCurrent ? (
        <span className={outline + ' pointer-events-none opacity-50'} aria-current="true">
          This week
        </span>
      ) : (
        <Link href={path} className={outline}>
          This week
        </Link>
      )}
      <Link href={weekHref(path, nav.next, nav.current)} className={outline} aria-label={`Next week, from ${formatDay(nav.next)}`}>
        <ChevronRight aria-hidden />
      </Link>
    </nav>
  );
}
