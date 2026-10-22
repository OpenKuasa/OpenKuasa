'use client';

import { usePathname, useRouter } from 'next/navigation';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { SstReturnType } from '@/lib/finance/sst-return';

/**
 * Which SST return the screen shows: service or sales tax, and which taxable period. Each choice sets both
 * `?tax=` and `?period=` so changing one keeps the other; the screen reads them (pickSstView).
 */
export function SstReturnPicker({
  type,
  periodStart,
  periods,
}: {
  type: SstReturnType;
  periodStart: string;
  /** Newest first; the shown period is among them. */
  periods: { start: string; label: string }[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const go = (tax: string, period: string) => router.replace(`${pathname}?tax=${tax}&period=${period}`);

  return (
    <>
      <Select value={type} onValueChange={(v) => go(v, periodStart)}>
        <SelectTrigger className="w-36" aria-label="Tax">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="service">Service tax</SelectItem>
          <SelectItem value="sales">Sales tax</SelectItem>
        </SelectContent>
      </Select>
      <Select value={periodStart} onValueChange={(v) => go(type, v)}>
        <SelectTrigger className="w-full sm:w-56" aria-label="Taxable period">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {periods.map((p) => (
            <SelectItem key={p.start} value={p.start}>
              {p.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </>
  );
}
