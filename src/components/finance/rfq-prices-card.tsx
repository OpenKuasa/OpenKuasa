'use client';

import { type FormEvent, useId, useState } from 'react';
import { Tag } from 'lucide-react';
import { BentoCard } from '@/components/bento/bento';
import { useFinanceAction } from '@/components/finance/use-finance-action';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { type PriceDraft, priceDrafts, submitPrices } from '@/lib/finance/rfq-form';
import type { RfqDetail } from '@/lib/finance/rfqs';
import type { FinResult } from '@/lib/finance/result';

export type QuoteRfq = (input: unknown) => Promise<FinResult<{ id: string }>>;

/**
 * Records the supplier's answer to a sent RFQ: their own reference, and a
 * price and SST rate for every line. Saving marks the RFQ as quoted, so every
 * line needs a price; the rules are in src/lib/finance/rfq-form.ts.
 */
export function RfqPricesCard({ rfq, quote, onClose }: { rfq: RfqDetail; quote: QuoteRfq; onClose: () => void }) {
  const id = useId();
  const [supplierRef, setSupplierRef] = useState(rfq.supplier_ref ?? '');
  const [drafts, setDrafts] = useState<PriceDraft[]>(() => priceDrafts(rfq));
  const save = useFinanceAction();
  /** A change by the person answers the last refusal, so its sentence goes. */
  const change = (lineId: string, patch: Partial<Pick<PriceDraft, 'unit_price' | 'sst_rate'>>) => {
    save.clear();
    setDrafts((all) => all.map((d) => (d.line_id === lineId ? { ...d, ...patch } : d)));
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    // Handled here rather than as a form action, so a refused form keeps what was typed.
    event.preventDefault();
    // The database refuses an unpriced line too (FIN19); asking first gives the sentence without a round trip.
    const result = submitPrices(rfq.id, supplierRef, drafts);
    if ('error' in result) {
      save.fail(result.error);
      return;
    }
    save.run(() => quote(result.payload), onClose);
  };

  return (
    <BentoCard
      title="Record prices"
      subtitle={`${rfq.rfq_no ?? 'The RFQ'} to ${rfq.supplier_name}: saving marks it as quoted`}
      icon={Tag}
      className="col-span-2 md:col-span-12"
    >
      <form onSubmit={submit} noValidate className="grid gap-3 md:grid-cols-12">
        <div className="space-y-1.5 md:col-span-4">
          <Label htmlFor={`${id}-ref`}>Supplier reference</Label>
          <Input
            id={`${id}-ref`}
            value={supplierRef}
            maxLength={200}
            placeholder="Their quotation number"
            autoComplete="off"
            autoFocus
            data-finance-focus
            onChange={(e) => {
              save.clear();
              setSupplierRef(e.target.value);
            }}
          />
        </div>

        <fieldset className="space-y-1.5 md:col-span-12">
          <legend className="text-sm font-medium leading-none">Prices quoted</legend>
          <ul className="divide-y rounded-lg border">
            {drafts.map((d, index) => (
              <li key={d.line_id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2">
                <div className="min-w-0 flex-1 basis-56 text-sm">
                  <span className="font-medium">{d.description}</span>
                  <span className="block text-xs text-muted-foreground tabular-nums">
                    {d.quantity}
                    {d.uom ? ` ${d.uom}` : ''}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground" aria-hidden>
                    RM
                  </span>
                  <Input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="0.01"
                    placeholder="Unit price"
                    aria-label={`Unit price for line ${index + 1}, ${d.description}`}
                    className="w-32 text-right tabular-nums"
                    onWheel={(e) => e.currentTarget.blur()}
                    // Enter in a price box does not save a half-priced RFQ.
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.preventDefault();
                    }}
                    value={d.unit_price}
                    onChange={(e) => change(d.line_id, { unit_price: e.target.value })}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    max={100}
                    step="0.01"
                    aria-label={`SST rate for line ${index + 1}, ${d.description}`}
                    className="w-20 text-right tabular-nums"
                    onWheel={(e) => e.currentTarget.blur()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.preventDefault();
                    }}
                    value={d.sst_rate}
                    onChange={(e) => change(d.line_id, { sst_rate: e.target.value })}
                  />
                  <span className="text-sm text-muted-foreground" aria-hidden>
                    % SST
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </fieldset>

        <div className="flex flex-wrap items-center gap-3 md:col-span-12">
          <Button type="submit" size="sm" disabled={save.pending}>
            {save.pending ? 'Saving…' : 'Save prices'}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={save.pending}>
            Cancel
          </Button>
          {save.error ? (
            <p role="alert" className="text-sm text-destructive">
              {save.error}
            </p>
          ) : null}
        </div>
      </form>
    </BentoCard>
  );
}
