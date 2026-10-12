'use client';

import { type FormEvent, useId, useState } from 'react';
import { Package } from 'lucide-react';
import { BentoCard } from '@/components/bento/bento';
import { useFinanceAction } from '@/components/finance/use-finance-action';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { typedNumber } from '@/lib/finance/format';
import { type ReceiptDraft, receiptDrafts, submitReceipts } from '@/lib/finance/purchase-order-form';
import type { PurchaseOrderDetail } from '@/lib/finance/purchase-orders';
import type { FinResult } from '@/lib/finance/result';

export type ReceivePurchaseOrder = (input: unknown) => Promise<FinResult<{ id: string }>>;

/**
 * Records what has arrived against an approved order: for every line, the
 * total received so far (not this delivery's share). A figure above the
 * ordered quantity is flagged but still saves, since suppliers do over-deliver;
 * the rules are in src/lib/finance/purchase-order-form.ts.
 */
export function PurchaseOrderReceiveCard({
  order,
  receive,
  onClose,
}: {
  order: PurchaseOrderDetail;
  receive: ReceivePurchaseOrder;
  onClose: () => void;
}) {
  const id = useId();
  const [drafts, setDrafts] = useState<ReceiptDraft[]>(() => receiptDrafts(order));
  const save = useFinanceAction();
  /** A change by the person answers the last refusal, so its sentence goes. */
  const change = (lineId: string, received: string) => {
    save.clear();
    setDrafts((all) => all.map((d) => (d.line_id === lineId ? { ...d, received } : d)));
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    // Handled here rather than as a form action, so a refused form keeps what was typed.
    event.preventDefault();
    // One decision function: a bad box is refused with its sentence before any call is made.
    const result = submitReceipts(order.id, drafts);
    if ('error' in result) {
      save.fail(result.error);
      return;
    }
    save.run(() => receive(result.payload), onClose);
  };

  return (
    <BentoCard
      title="Record delivery"
      subtitle={`${order.po_no ?? 'The order'} from ${order.supplier_name}`}
      icon={Package}
      className="col-span-2 md:col-span-12"
    >
      <form onSubmit={submit} noValidate className="grid gap-3 md:grid-cols-12">
        <fieldset className="space-y-1.5 md:col-span-12">
          <legend className="text-sm font-medium leading-none">Received so far</legend>
          <p id={`${id}-help`} className="text-sm text-muted-foreground">
            Enter the total that has arrived so far, not just this delivery.
          </p>
          <ul className="divide-y rounded-lg border">
            {drafts.map((d, index) => {
              const typed = typedNumber(d.received);
              const over = typed !== null && typed > d.ordered;
              return (
                <li key={d.line_id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2">
                  <div className="min-w-0 flex-1 basis-56 text-sm">
                    <span className="font-medium">{d.description}</span>
                    <span className="block text-xs text-muted-foreground tabular-nums">
                      Ordered {d.ordered}
                      {d.uom ? ` ${d.uom}` : ''}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Input
                      type="number"
                      inputMode="decimal"
                      min={0}
                      step="any"
                      aria-label={`Total received for line ${index + 1}, ${d.description}`}
                      aria-describedby={over ? `${id}-help ${id}-over-${index}` : `${id}-help`}
                      className="w-28 text-right tabular-nums"
                      autoFocus={index === 0}
                      data-finance-focus={index === 0 ? '' : undefined}
                      onWheel={(e) => e.currentTarget.blur()}
                      // Enter in a box does not save a half-filled delivery.
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') e.preventDefault();
                      }}
                      value={d.received}
                      onChange={(e) => change(d.line_id, e.target.value)}
                    />
                    {d.uom ? (
                      <span className="text-sm text-muted-foreground" aria-hidden>
                        {d.uom}
                      </span>
                    ) : null}
                    {over ? (
                      <span id={`${id}-over-${index}`} className="text-xs font-medium text-amber-600">
                        More than ordered
                      </span>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </fieldset>

        <div className="flex flex-wrap items-center gap-3 md:col-span-12">
          <Button type="submit" size="sm" disabled={save.pending}>
            {save.pending ? 'Saving…' : 'Save delivery'}
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
