'use client';

import { Printer } from 'lucide-react';
import { Dialog } from 'radix-ui';
import { LetterHead, useLetterhead } from '@/components/people/letter-head';
import { PRINT_CSS } from '@/components/people/letter-view';
import { Button } from '@/components/ui/button';
import { purchaseOrderPrint, type PrintablePurchaseOrder } from '@/lib/finance/purchase-order-print';

/**
 * An approved or closed order as it is sent to the supplier: the workspace's letterhead, the order's number, date
 * and terms, who it is to and where it is delivered, the lines and totals, and a "Prepared by" and an "Approved by"
 * block with a line to sign on by hand. Opened from the row menu; Print calls the browser's print, and Lekiu's
 * letter print styles (`PRINT_CSS`) leave only the order on the page.
 */
export function PurchaseOrderPrintDialog({ order, onClose }: { order: PrintablePurchaseOrder; onClose: () => void }) {
  return (
    <Dialog.Root open onOpenChange={(open) => (open ? null : onClose())}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" data-letter-noprint />
        <Dialog.Content
          data-letter-dialog
          className="fixed top-1/2 left-1/2 z-50 max-h-[90vh] w-[calc(100%-2rem)] max-w-3xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border bg-background p-5 shadow-lg outline-none"
        >
          <style>{PRINT_CSS}</style>
          <Dialog.Title className="sr-only">Purchase order {order.po_no}</Dialog.Title>
          <Dialog.Description className="sr-only">
            The purchase order to {order.supplier_name}, as it prints.
          </Dialog.Description>
          <PurchaseOrderPaper order={order} />
          <div className="mt-4 flex justify-end gap-2" data-letter-noprint>
            <Button type="button" variant="outline" size="sm" onClick={() => window.print()}>
              <Printer aria-hidden />
              Print
            </Button>
            <Dialog.Close asChild>
              <Button type="button" variant="ghost" size="sm">
                Close
              </Button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** The printed order itself; see `purchaseOrderPrint` for what each part says. */
function PurchaseOrderPaper({ order }: { order: PrintablePurchaseOrder }) {
  const p = purchaseOrderPrint(order, useLetterhead());
  return (
    <article data-letter-print className="space-y-5 bg-white p-6 text-sm text-black">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-black/20 pb-3">
        <LetterHead />
        <div className="sm:text-right print:text-right">
          <h2 className="text-lg font-semibold tracking-wide">PURCHASE ORDER</h2>
          <p className="font-medium">{p.po_no}</p>
          <p>Date: {p.date}</p>
        </div>
      </header>

      <div className="grid gap-4 sm:grid-cols-2 print:grid-cols-2">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide">To</p>
          {p.to.map((line, index) => (
            <p key={index} className={index === 0 ? 'font-medium' : undefined}>
              {line}
            </p>
          ))}
        </div>
        {p.deliver_to ? (
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide">Deliver to</p>
            <p className="whitespace-pre-line">{p.deliver_to}</p>
          </div>
        ) : null}
      </div>

      {p.details.length > 0 ? (
        <p className="flex flex-wrap gap-x-6 gap-y-1">
          {p.details.map((d) => (
            <span key={d.label}>
              <span className="font-semibold">{d.label}:</span> {d.value}
            </span>
          ))}
        </p>
      ) : null}

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left tabular-nums">
          <thead>
            <tr className="border-b border-black/40 text-xs whitespace-nowrap uppercase tracking-wide">
              <th className="py-1 pr-2 font-semibold">No.</th>
              <th className="py-1 pr-2 font-semibold">Description</th>
              <th className="py-1 pr-2 text-right font-semibold">Qty</th>
              <th className="py-1 pr-2 font-semibold">Unit</th>
              <th className="py-1 pr-2 text-right font-semibold">Unit price</th>
              <th className="py-1 pr-2 text-right font-semibold">SST</th>
              <th className="py-1 text-right font-semibold">Amount</th>
            </tr>
          </thead>
          <tbody>
            {p.lines.map((line) => (
              <tr key={line.no} className="break-inside-avoid border-b border-black/10 align-top">
                <td className="py-1 pr-2">{line.no}</td>
                <td className="py-1 pr-2 break-words">{line.description}</td>
                <td className="py-1 pr-2 text-right">{line.quantity}</td>
                <td className="py-1 pr-2">{line.unit}</td>
                <td className="py-1 pr-2 text-right whitespace-nowrap">{line.unit_price}</td>
                <td className="py-1 pr-2 text-right">{line.sst}</td>
                <td className="py-1 text-right whitespace-nowrap">{line.amount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <dl className="ml-auto grid w-fit break-inside-avoid grid-cols-[auto_auto] gap-x-6 gap-y-0.5 tabular-nums">
        {p.totals.map((t) => (
          <div key={t.label} className="contents">
            <dt className={t.label === 'Total' ? 'font-semibold' : undefined}>{t.label}</dt>
            <dd className={t.label === 'Total' ? 'text-right font-semibold' : 'text-right'}>{t.value}</dd>
          </div>
        ))}
      </dl>

      {p.notes ? (
        <p className="whitespace-pre-line">
          <span className="font-semibold">Notes:</span> {p.notes}
        </p>
      ) : null}
      <p>{p.quote_line}</p>

      <div className="grid break-inside-avoid grid-cols-2 gap-8 pt-6">
        {p.signatures.map((s) => (
          <div key={s.label} className="space-y-1">
            <p className="font-semibold">{s.label}</p>
            <div className="h-14 border-b border-black" aria-hidden />
            <p>Name: {s.name}</p>
            <p>Designation: {s.designation}</p>
            <p>Date: {s.date}</p>
          </div>
        ))}
      </div>
    </article>
  );
}
