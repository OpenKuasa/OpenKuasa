'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { BadgeCheck, ClipboardCheck, Scale } from 'lucide-react';
import { BentoCard } from '@/components/bento/bento';
import { useFinanceAction } from '@/components/finance/use-finance-action';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { rm } from '@/lib/finance/format';
import { RFQ_STATUS_LABELS, rfqActions } from '@/lib/finance/purchase-views';
import { compareQuotes, orderableRfq } from '@/lib/finance/rfq-compare';
import type { RfqDetail } from '@/lib/finance/rfqs';
import type { FinResult } from '@/lib/finance/result';
import { cn } from '@/lib/utils';

/** A unit price keeps up to 4 decimals, so two prices that differ only there do not read the same. */
function unitPrice(n: number) {
  return `RM ${n.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
}

/**
 * The quotes for one request side by side: a row for each item, a column for each supplier asked, the
 * lowest price on each line marked in words as well as colour, and "Not quoted" where a supplier gave
 * no price. A quoted column without an order gets Make purchase order, the RFQ's own action; closing the
 * other RFQs is left to the person. The rules are in src/lib/finance/rfq-compare.ts.
 *
 * The question it asks before making an order behaves as ConfirmRow's does: the button that is working
 * keeps focus, Escape and Cancel take the question away and hand focus back to the button that asked it,
 * and after a refusal the group is read again (`reload`), so a column that can no longer be ordered
 * stops offering it.
 *
 * When the card appears its title takes focus, not Close: Close is the last thing in the card, and
 * focusing it scrolled the page down past the supplier names. From the title, Tab reaches the table's
 * buttons and then Close, in order.
 */
export function RfqCompareCard({
  rfqs,
  convert,
  reload,
  onConverted,
  onClose,
}: {
  /** The group's RFQs that have gone to their supplier, in the order they were made, with their lines. */
  rfqs: RfqDetail[];
  /** Makes a draft purchase order from a quoted RFQ; absent for a person who may not. */
  convert?: (input: unknown) => Promise<FinResult<unknown>>;
  /** Reads the group again and gives it back as `rfqs`, after an order was refused. */
  reload?: () => Promise<void>;
  /** The order was made from this RFQ. */
  onConverted: (rfq: RfqDetail) => void;
  onClose: () => void;
}) {
  const rows = compareQuotes(rfqs);
  const [confirming, setConfirming] = useState<RfqDetail | null>(null);
  const action = useFinanceAction();
  // The question is asked of the group as it now reads, not as it read when the question was opened.
  const asked = orderableRfq(rfqs, confirming?.id ?? null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const closeButton = useRef<HTMLButtonElement | null>(null);
  const heading = useRef<HTMLSpanElement | null>(null);
  // A plain focus, so the top of the card is brought into view and the card is read from its title.
  useEffect(() => {
    heading.current?.focus();
  }, []);
  const cancel = () => {
    // The refusal belonged to the question, so it goes with it, as ConfirmRow's does.
    action.clear();
    setConfirming(null);
    opener.current?.focus();
  };
  // A question whose RFQ can no longer be ordered goes, and its buttons with it: focus goes to Close, not to the page.
  // Before the browser paints, so focus rests on the page for one frame at most (the question goes a commit before
  // its action stops pending). The refusal is the line above Close, so scrolling Close into view keeps it in view too.
  const dropped = confirming !== null && asked === null;
  useLayoutEffect(() => {
    if (dropped && !action.pending) closeButton.current?.focus();
  }, [dropped, action.pending]);

  return (
    <BentoCard
      // The title takes focus when the comparison appears (the effect above), so the card opens at its top. It carries
      // `data-finance-focus` too, for a group that arrives before the row menu has handed focus on.
      title={
        <span ref={heading} tabIndex={-1} data-finance-focus>
          Compare quotes
        </span>
      }
      subtitle={`${rfqs.length} suppliers asked for the same items`}
      icon={Scale}
      flush
      className="col-span-2 md:col-span-12"
    >
      <div className="overflow-x-auto">
        <Table aria-label="Quotes compared">
          <TableHeader>
            <TableRow className="bg-muted/40">
              <TableHead scope="col">Item</TableHead>
              {rfqs.map((r) => (
                <TableHead key={r.id} scope="col" className="text-right align-bottom">
                  <span className="block whitespace-normal font-medium text-foreground">{r.supplier_name}</span>
                  <span className="block whitespace-nowrap text-xs font-normal">
                    {r.rfq_no} · {RFQ_STATUS_LABELS[r.status]}
                  </span>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.key}>
                {/* The row's header, drawn as the other cells are: a header cell is otherwise shorter and bold. */}
                <TableHead scope="row" className="h-auto min-w-48 p-2 font-normal [overflow-wrap:anywhere] whitespace-normal align-top">
                  <span className="font-medium">{row.description}</span>
                  {row.uom || row.pack_size ? (
                    <span className="block text-xs text-muted-foreground">{[row.uom, row.pack_size].filter(Boolean).join(' · ')}</span>
                  ) : null}
                </TableHead>
                {row.cells.map((cell, i) => (
                  <TableCell key={rfqs[i].id} className="whitespace-nowrap text-right align-top tabular-nums">
                    {cell === null || cell.unit_price === null || cell.total === null ? (
                      <span className="text-muted-foreground">Not quoted</span>
                    ) : (
                      <>
                        <span className="flex items-center justify-end gap-1.5">
                          {cell.lowest ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-semibold text-emerald-600">
                              <BadgeCheck className="size-3" aria-hidden />
                              Lowest
                            </span>
                          ) : null}
                          <span className={cn(cell.lowest && 'font-semibold')}>{unitPrice(cell.unit_price)}</span>
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          Qty {cell.quantity} · {cell.sst_rate ? `SST ${cell.sst_rate}%` : 'No SST'} · {rm(cell.total)}
                        </span>
                      </>
                    )}
                    {/* Matched by product but worded differently, as a substitute is: this supplier's own description. */}
                    {cell?.description ? (
                      <span className="ml-auto block max-w-48 text-xs break-words whitespace-normal">{cell.description}</span>
                    ) : null}
                  </TableCell>
                ))}
              </TableRow>
            ))}
            <TableRow className="bg-muted/40 font-medium">
              <TableHead scope="row" className="h-auto p-2">
                Total
              </TableHead>
              {rfqs.map((r) => (
                <TableCell key={r.id} className="whitespace-nowrap text-right tabular-nums">
                  {r.quoted_at ? rm(r.total) : <span className="font-normal text-muted-foreground">Not quoted</span>}
                </TableCell>
              ))}
            </TableRow>
            <TableRow>
              <TableHead scope="row" className="h-auto p-2">
                <span className="sr-only">Purchase order</span>
              </TableHead>
              {rfqs.map((r) => (
                <TableCell key={r.id} className="whitespace-nowrap text-right">
                  {convert && rfqActions(r).includes('convert') ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      aria-expanded={asked?.id === r.id}
                      disabled={action.pending}
                      onClick={(event) => {
                        opener.current = event.currentTarget;
                        action.clear();
                        setConfirming(r);
                      }}
                    >
                      <ClipboardCheck className="size-4" />
                      Make purchase order
                    </Button>
                  ) : (
                    <span className="text-sm text-muted-foreground">
                      {r.purchase_order_id ? `Order ${r.purchase_order_no ?? 'drafted'}` : '—'}
                    </span>
                  )}
                </TableCell>
              ))}
            </TableRow>
          </TableBody>
        </Table>
      </div>

      <div className="space-y-3 border-t px-4 py-3 text-sm">
        {asked && convert ? (
          <div
            role="group"
            aria-label={`Make a purchase order from ${asked.rfq_no}`}
            className="flex flex-wrap items-center gap-3"
            onKeyDown={(event) => {
              if (event.key !== 'Escape' || action.pending) return;
              event.stopPropagation();
              cancel();
            }}
          >
            <p className="basis-full">
              Make a draft purchase order from <span className="font-medium">{asked.rfq_no}</span> to{' '}
              <span className="font-medium">{asked.supplier_name}</span> ({rm(asked.total)})? It gets the same supplier
              and lines, at the prices quoted, and stays a draft on Purchase Orders until it is submitted for approval. The
              other RFQs stay as they are.
            </p>
            {/* aria-disabled rather than disabled, as in ConfirmRow: a disabled button drops focus to the page. */}
            <Button
              type="button"
              size="sm"
              aria-disabled={action.pending}
              className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
              autoFocus
              onClick={() => {
                if (action.pending) return;
                action.run(
                  async () => {
                    const result = await convert({ id: asked.id });
                    if (!result.ok) {
                      try {
                        await reload?.();
                      } catch {
                        // The group could not be read again: the card stays as it was, under the refusal.
                      }
                    }
                    return result;
                  },
                  () => onConverted(asked),
                );
              }}
            >
              {action.pending ? 'Making…' : 'Make purchase order'}
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={action.pending} onClick={cancel}>
              Cancel
            </Button>
          </div>
        ) : null}
        {/* Outside the question, so the refusal is still read once its question has gone. */}
        {action.error ? (
          <p role="alert" className="text-destructive">
            {action.error}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <p className="flex-1 text-muted-foreground">
            Lowest is the lowest price for one unit once SST is added. The lowest price is not always the best choice:
            delivery time and past service count too.
          </p>
          <Button type="button" size="sm" variant="outline" onClick={onClose} disabled={action.pending} ref={closeButton}>
            Close
          </Button>
        </div>
      </div>
    </BentoCard>
  );
}
