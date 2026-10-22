import { SHIFT_COLOR_CLASS, shiftTimes } from '@/lib/people/roster';
import type { ShiftType } from '@/lib/people/types';
import { cn } from '@/lib/utils';

/** A shift type as a small coloured label: its name, and its times underneath when it has them. */
export function ShiftPill({ type, withTimes = true }: { type: ShiftType; withTimes?: boolean }) {
  const times = withTimes ? shiftTimes(type) : null;
  return (
    <span
      className={cn('inline-flex flex-col whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-medium leading-tight', SHIFT_COLOR_CLASS[type.color])}
      title={times ? `${type.name}, ${times}` : type.name}
    >
      <span>{type.name}</span>
      {times ? <span className="text-[0.65rem] font-normal opacity-80">{times}</span> : null}
    </span>
  );
}
