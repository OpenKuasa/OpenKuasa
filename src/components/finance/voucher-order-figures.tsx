import { money } from '@/lib/finance/format';
import type { VoucherFigures } from '@/lib/finance/voucher-order-figures';
import { displayDate } from '@/lib/finance/view-helpers';

/**
 * The purchase orders behind a supplier payment, shown beside the approve
 * question (#242) so an approver can check the figures match rather than take
 * the note's word for it: ordered, received, billed so far and paid so far,
 * with this payment on its own line, then each bill under the order with the
 * part of this payment that goes to it and the supplier's own invoice number
 * and date. A bill with no order is said so in words. Delivery order numbers
 * are not shown: deliveries are not stored as records yet (#190).
 *
 * The order's figures are in the order's currency, which is its bills'
 * currency too (FIN49); nothing is converted. Contra entries are in ringgit, so
 * that line is, and it is drawn only when there is one. A list, not a table, so
 * a long bill number wraps at phone width instead of scrolling.
 */
export function VoucherOrderFigures({ figures }: { figures: VoucherFigures }) {
  const billLine = (bill: VoucherFigures['withoutOrder'][number]) => (
    <li key={bill.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-xs">
      <span className="min-w-0 flex-1 basis-40 break-words text-muted-foreground">
        {bill.billNo ?? 'Draft bill'}
        {bill.supplierRef ? `, ${bill.supplierRef}` : ''}
        {bill.billDate ? `, ${displayDate(bill.billDate)}` : ''}
      </span>
      <span className="ml-auto tabular-nums">{money(bill.thisPayment, bill.currency)}</span>
    </li>
  );

  return (
    <div role="group" aria-label="The purchase orders behind this payment" className="mt-2 space-y-3 border-t pt-2">
      {figures.orders.map((order) => (
        <div key={order.orderId} className="space-y-1">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-xs">
            <a
              href={order.href}
              title={`Open ${order.poNo ?? 'the purchase order'} on Purchase orders`}
              className="font-medium underline-offset-2 hover:underline"
            >
              {order.poNo ?? 'Purchase order'}
            </a>
            <span className="text-muted-foreground">Line by line</span>
          </div>
          <dl className="grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5 text-xs tabular-nums">
            <dt className="text-muted-foreground">Ordered</dt>
            <dd className="text-right">{money(order.ordered, order.currency)}</dd>
            <dt className="text-muted-foreground">Received</dt>
            <dd className="text-right">{money(order.received, order.currency)}</dd>
            <dt className="text-muted-foreground">Billed so far</dt>
            <dd className="text-right">{money(order.billed, order.currency)}</dd>
            <dt className="text-muted-foreground">Paid so far</dt>
            <dd className="text-right">{money(order.paid, order.currency)}</dd>
            <dt className="font-medium">This payment</dt>
            <dd className="text-right font-medium">{money(order.thisPayment, order.currency)}</dd>
            {order.setOff > 0 ? (
              <>
                <dt className="text-muted-foreground">Set off by contra</dt>
                <dd className="text-right">{money(order.setOff)}</dd>
              </>
            ) : null}
          </dl>
          <ul aria-label={`Bills this payment puts on ${order.poNo ?? 'the purchase order'}`}>{order.bills.map(billLine)}</ul>
        </div>
      ))}
      {figures.withoutOrder.length > 0 ? (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">No purchase order</p>
          <ul aria-label="Bills with no purchase order">{figures.withoutOrder.map(billLine)}</ul>
        </div>
      ) : null}
    </div>
  );
}
