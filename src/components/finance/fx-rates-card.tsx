'use client';

import { useState } from 'react';
import { Coins } from 'lucide-react';
import { BentoCard } from '@/components/bento/bento';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { FX_CARD_FIRST, type FxLatestRate, fxRatesCardView } from '@/lib/finance/fx-rates';

/**
 * Bank Negara Malaysia's newest rate for each currency it publishes. Read
 * only, for everyone who can open Banking. The ten most used come first; the
 * rest are a click away. `rates` is null when they could not be read.
 */
export function FxRatesCard({ rates, today }: { rates: FxLatestRate[] | null; today: string }) {
  const [all, setAll] = useState(false);
  if (rates === null) {
    return (
      <BentoCard title="Exchange rates" icon={Coins} className="col-span-2 md:col-span-12">
        <p className="text-sm text-muted-foreground">The exchange rates could not be loaded. Please try again later.</p>
      </BentoCard>
    );
  }
  const view = fxRatesCardView(rates, today);
  const shown = all ? view.rows : view.rows.slice(0, FX_CARD_FIRST.length);
  return (
    <BentoCard title="Exchange rates" subtitle={view.subtitle} icon={Coins} className="col-span-2 md:col-span-12">
      {view.note ? <p className="mb-3 text-sm text-muted-foreground">{view.note}</p> : null}
      {view.rows.length > 0 ? (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-20">Currency</TableHead>
                <TableHead>Rate</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((r) => (
                <TableRow key={r.currency}>
                  <TableCell className="font-medium">{r.currency}</TableCell>
                  <TableCell className="whitespace-normal tabular-nums">
                    {r.words}
                    {r.date ? <span className="block text-xs text-muted-foreground">Rate of {r.date}</span> : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {view.rows.length > FX_CARD_FIRST.length ? (
            <Button type="button" variant="ghost" size="sm" className="mt-2 self-start" onClick={() => setAll((v) => !v)}>
              {all ? 'Show fewer' : `Show all ${view.rows.length} currencies`}
            </Button>
          ) : null}
        </>
      ) : null}
    </BentoCard>
  );
}
