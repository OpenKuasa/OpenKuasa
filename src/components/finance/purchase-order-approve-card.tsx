'use client';

import { Check, CircleCheck } from 'lucide-react';
import { BentoCard } from '@/components/bento/bento';
import { useFinanceAction } from '@/components/finance/use-finance-action';
import { Button } from '@/components/ui/button';
import { BASE_CURRENCY } from '@/lib/finance/currencies';
import { money, rm, unitPrice } from '@/lib/finance/format';
import type { PurchaseOrderDetail } from '@/lib/finance/purchase-orders';
import type { DecidePurchaseOrder } from '@/components/finance/purchase-order-reject-card';

/**
 * What is being ordered, for the person deciding: each line's item, quantity,
 * unit price and amount, then the order's subtotal, SST and total. A list, not
 * a table, so a long description wraps at phone width instead of scrolling.
 * Every figure is in the order's currency; a foreign total has its ringgit
 * at the order's rate beneath it.
 */
export function PurchaseOrderLines({ order }: { order: PurchaseOrderDetail }) {
  const amount = (n: number) => money(n, order.currency);
  return (
    <div className="space-y-2 text-sm">
      <ul aria-label={`Lines of ${order.po_no ?? 'the order'}`} className="divide-y rounded-lg border">
        {order.lines.map((line) => (
          <li key={line.id} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-3 py-2">
            <div className="min-w-0 flex-1 basis-56">
              <span className="font-medium break-words">{line.description}</span>
              <span className="block text-xs text-muted-foreground tabular-nums">
                {line.quantity}
                {line.uom ? ` ${line.uom}` : ''}
                {line.pack_size ? ` (${line.pack_size})` : ''} at {unitPrice(line.unit_price, order.currency)}
                {line.sst_rate > 0 ? `, SST ${line.sst_rate}%` : ''}
              </span>
            </div>
            <span className="ml-auto tabular-nums">{amount(line.amount)}</span>
          </li>
        ))}
      </ul>
      <dl className="ml-auto grid w-fit grid-cols-[auto_auto] gap-x-6 gap-y-0.5 tabular-nums">
        {order.sst_total > 0 ? (
          <>
            <dt className="text-muted-foreground">Subtotal</dt>
            <dd className="text-right">{amount(order.subtotal)}</dd>
            <dt className="text-muted-foreground">SST</dt>
            <dd className="text-right">{amount(order.sst_total)}</dd>
          </>
        ) : null}
        <dt className="font-medium">Total</dt>
        <dd className="text-right font-medium">{amount(order.total)}</dd>
        {order.currency !== BASE_CURRENCY && order.total_myr !== null ? (
          <>
            <dt className="text-muted-foreground">In ringgit</dt>
            <dd className="text-right text-muted-foreground">≈ {rm(order.total_myr)}</dd>
          </>
        ) : null}
      </dl>
    </div>
  );
}

/** Approves an order awaiting approval, after showing its lines. */
export function PurchaseOrderApproveCard({
  order,
  decide,
  onClose,
}: {
  order: PurchaseOrderDetail;
  decide: DecidePurchaseOrder;
  onClose: () => void;
}) {
  const save = useFinanceAction();
  return (
    <BentoCard
      title="Approve purchase order"
      subtitle={`${order.po_no ?? 'The order'} to ${order.supplier_name}`}
      icon={CircleCheck}
      className="col-span-2 md:col-span-12"
    >
      <div className="space-y-3">
        <PurchaseOrderLines order={order} />
        <p className="text-sm text-muted-foreground">Once approved, deliveries can be recorded and bills raised against it.</p>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            size="sm"
            disabled={save.pending}
            onClick={() => save.run(() => decide({ id: order.id, approve: true }), onClose)}
          >
            <Check className="size-4" />
            {save.pending ? 'Approving…' : 'Approve'}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={save.pending} autoFocus data-finance-focus>
            Cancel
          </Button>
          {save.error ? (
            <p role="alert" className="text-sm text-destructive">
              {save.error}
            </p>
          ) : null}
        </div>
      </div>
    </BentoCard>
  );
}
