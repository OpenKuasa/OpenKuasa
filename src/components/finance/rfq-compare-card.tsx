'use client';

import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { BadgeCheck, ClipboardCheck, Scale } from 'lucide-react';
import { BentoCard } from '@/components/bento/bento';
import { RfqReasonInput, WHOLE_RFQ_REASON_HINT } from '@/components/finance/rfq-reason-input';
import { useFinanceAction } from '@/components/finance/use-finance-action';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { money, rm, unitPrice } from '@/lib/finance/format';
import { RFQ_STATUS_LABELS, rfqActions } from '@/lib/finance/purchase-views';
import {
  type SplitChoice,
  compareQuotes,
  makeSplitLabel,
  orderableRfq,
  quoteTotals,
  quotesInSeveralCurrencies,
  reviewSplitLabel,
  splitAwards,
  splitPlan,
  splitReasonHint,
  startingChoice,
  toggleChoice,
} from '@/lib/finance/rfq-compare';
import type { RfqDetail } from '@/lib/finance/rfqs';
import type { FinResult } from '@/lib/finance/result';
import { cn } from '@/lib/utils';

/**
 * The quotes for one request side by side: a row for each item, a column for each supplier asked, the
 * lowest price on each line marked in words as well as colour, and "Not quoted" where a supplier gave
 * no price. A quoted column without an order gets Make purchase order, the RFQ's own action; closing the
 * other RFQs is left to the person. The rules are in src/lib/finance/rfq-compare.ts.
 *
 * Split between suppliers lets each line go to the supplier chosen for it, with a Split column and a Chosen row
 * beside the totals, and then makes one draft order for each supplier chosen, each with its own reason. What it
 * shows is worked out in rfq-compare.ts; the database decides what it accepts.
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
  award,
  reload,
  onConverted,
  onAwarded,
  onClose,
}: {
  /** The group's RFQs that have gone to their supplier, in the order they were made, with their lines. */
  rfqs: RfqDetail[];
  /** Makes a draft purchase order from a quoted RFQ; absent for a person who may not. */
  convert?: (input: unknown) => Promise<FinResult<unknown>>;
  /** Splits the quotes between suppliers, a draft purchase order for each; absent for a person who may not. */
  award?: (input: unknown) => Promise<FinResult<unknown>>;
  /** Reads the group again and gives it back as `rfqs`, after an order was refused. */
  reload?: () => Promise<void>;
  /** The order was made from this RFQ. */
  onConverted: (rfq: RfqDetail) => void;
  /** The split made this many orders. */
  onAwarded: (count: number) => void;
  onClose: () => void;
}) {
  const rows = compareQuotes(rfqs);
  const totals = quoteTotals(rfqs);
  const mixed = quotesInSeveralCurrencies(rfqs);
  const [confirming, setConfirming] = useState<RfqDetail | null>(null);
  // Why the supplier being ordered from was chosen, as typed; kept when the database refuses the order.
  const [reason, setReason] = useState('');
  // Split between suppliers: whether it is on, the line chosen for each row, whether its question is open, and why
  // each supplier was chosen (by RFQ), as typed; kept when the database refuses.
  const [splitting, setSplitting] = useState(false);
  const [chosen, setChosen] = useState<SplitChoice>({});
  const [asking, setAsking] = useState(false);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const action = useFinanceAction();
  const orderable = rfqs.map((r) => rfqActions(r).includes('convert'));
  // Once nothing can be ordered (the group, read again, shows the orders someone else made) there is nothing to split.
  const canSplit = award !== undefined && orderable.some(Boolean);
  const split = splitting && canSplit;
  const plan = splitPlan(rfqs, rows, chosen);
  const confirmingSplit = asking && split && plan.orders.length > 0;
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
    setReason('');
    setAsking(false);
    setReasons({});
    opener.current?.focus();
  };
  const toggleSplit = () => {
    action.clear();
    setConfirming(null);
    setReason('');
    setAsking(false);
    setReasons({});
    setChosen(split ? {} : startingChoice(rows, rfqs));
    setSplitting(!split);
  };
  /** Chooses this RFQ for a row, taking it from whichever had it, or clears the row if it already has it. */
  const choose = (key: string, rfqId: string) => {
    setAsking(false);
    setChosen((cur) => toggleChoice(cur, key, rfqId));
  };
  const makeSplit = () => {
    if (action.pending || !award) return;
    const awards = splitAwards(plan, reasons);
    action.run(
      async () => {
        const result = await award({ awards });
        if (!result.ok) {
          try {
            await reload?.();
          } catch {
            // The group could not be read again: the card stays as it was, under the refusal.
          }
        }
        return result;
      },
      () => onAwarded(awards.length),
    );
  };
  /** Escape takes a question away, unless it is working. */
  const escapes = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || action.pending) return;
    event.stopPropagation();
    cancel();
  };
  const lineCount = (n: number) => `${n} ${n === 1 ? 'line' : 'lines'}`;
  /** A chosen row's amount in the Split column: a dash for a row not chosen. */
  const splitFigure = (sen: number | null | undefined) =>
    sen === undefined ? '—' : sen === null ? 'No exchange rate' : plan.mixed ? `≈ ${rm(sen / 100)}` : money(sen / 100, plan.currency);
  // A question whose RFQ can no longer be ordered goes, and its buttons with it: focus goes to Close, not to the page.
  // Before the browser paints, so focus rests on the page for one frame at most (the question goes a commit before
  // its action stops pending). The refusal is the line above Close, so scrolling Close into view keeps it in view too.
  const dropped = (confirming !== null && asked === null) || (asking && !confirmingSplit);
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
              {split ? (
                <TableHead scope="col" className="text-right align-bottom">
                  <span className="block font-medium text-foreground">Split</span>
                  <span className="block whitespace-nowrap text-xs font-normal">{plan.mixed ? 'Chosen, ≈ ringgit' : 'Chosen'}</span>
                </TableHead>
              ) : null}
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
                          <span className={cn(cell.lowest && 'font-semibold')}>{unitPrice(cell.unit_price, rfqs[i].currency)}</span>
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          Qty {cell.quantity} · {cell.sst_rate ? `SST ${cell.sst_rate}%` : 'No SST'} · {money(cell.total, rfqs[i].currency)}
                        </span>
                        {split && orderable[i] ? (
                          <Button
                            type="button"
                            size="sm"
                            variant={chosen[row.key] === rfqs[i].id ? 'default' : 'outline'}
                            aria-pressed={chosen[row.key] === rfqs[i].id}
                            aria-label={`Choose ${row.description} from ${rfqs[i].supplier_name}`}
                            disabled={action.pending}
                            className="mt-1.5"
                            onClick={() => choose(row.key, rfqs[i].id)}
                          >
                            {chosen[row.key] === rfqs[i].id ? 'Chosen' : 'Choose'}
                          </Button>
                        ) : null}
                      </>
                    )}
                    {/* Matched by product but worded differently, as a substitute is: this supplier's own description. */}
                    {cell?.description ? (
                      <span className="ml-auto block max-w-48 text-xs break-words whitespace-normal">{cell.description}</span>
                    ) : null}
                  </TableCell>
                ))}
                {split ? (
                  <TableCell className="whitespace-nowrap text-right align-top tabular-nums">{splitFigure(plan.rowSen[row.key])}</TableCell>
                ) : null}
              </TableRow>
            ))}
            <TableRow className="bg-muted/40 font-medium">
              <TableHead scope="row" className="h-auto p-2">
                Total
              </TableHead>
              {rfqs.map((r, i) => {
                const t = totals[i];
                return (
                  <TableCell key={r.id} className="whitespace-nowrap text-right tabular-nums">
                    {t.total === null ? (
                      <span className="font-normal text-muted-foreground">Not quoted</span>
                    ) : (
                      <>
                        <span className="flex items-center justify-end gap-1.5">
                          {t.lowest ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-semibold text-emerald-600">
                              <BadgeCheck className="size-3" aria-hidden />
                              Lowest
                            </span>
                          ) : null}
                          <span>{t.total}</span>
                        </span>
                        {t.ringgit ? <span className="block text-xs font-normal text-muted-foreground">{t.ringgit}</span> : null}
                      </>
                    )}
                  </TableCell>
                );
              })}
              {split ? (
                <TableCell className="whitespace-nowrap text-right tabular-nums">
                  {splitFigure(plan.orders.length > 0 ? plan.totalSen : undefined)}
                  {plan.unrated > 0 ? (
                    <span className="ml-auto block max-w-24 text-xs font-normal whitespace-normal text-muted-foreground">
                      plus {lineCount(plan.unrated)} with no exchange rate
                    </span>
                  ) : null}
                  {plan.notChosen > 0 ? (
                    <span className="ml-auto block max-w-24 text-xs font-normal whitespace-normal text-muted-foreground">
                      {lineCount(plan.notChosen)} not chosen
                    </span>
                  ) : null}
                </TableCell>
              ) : null}
            </TableRow>
            {split ? (
              <TableRow>
                <TableHead scope="row" className="h-auto p-2">
                  Chosen
                </TableHead>
                {rfqs.map((r) => {
                  const order = plan.orders.find((o) => o.rfq.id === r.id);
                  return (
                    <TableCell key={r.id} className="whitespace-nowrap text-right tabular-nums">
                      {order ? `${lineCount(order.lines.length)}, ${money(order.sen / 100, r.currency)}` : '—'}
                    </TableCell>
                  );
                })}
                <TableCell />
              </TableRow>
            ) : null}
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
                      disabled={action.pending || split}
                      onClick={(event) => {
                        opener.current = event.currentTarget;
                        action.clear();
                        setReason('');
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
              {split ? <TableCell /> : null}
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
            onKeyDown={escapes}
          >
            <p className="basis-full">
              Make a draft purchase order from <span className="font-medium">{asked.rfq_no}</span> to{' '}
              <span className="font-medium">{asked.supplier_name}</span> ({money(asked.total, asked.currency)})? It gets the same supplier
              and lines, at the prices quoted, and stays a draft on Purchase Orders until it is submitted for approval. The
              other RFQs stay as they are.
              <RfqReasonInput value={reason} onChange={setReason} disabled={action.pending} hint={WHOLE_RFQ_REASON_HINT} />
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
                    const result = await convert({ id: asked.id, reason });
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
        {split ? (
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              size="sm"
              aria-expanded={confirmingSplit}
              disabled={action.pending || plan.orders.length === 0}
              onClick={(event) => {
                opener.current = event.currentTarget;
                action.clear();
                setAsking(true);
              }}
            >
              <ClipboardCheck className="size-4" />
              {reviewSplitLabel(plan.orders.length)}
            </Button>
            {plan.orders.length === 0 ? (
              <p className="text-muted-foreground">Choose a quote on at least one line to make an order.</p>
            ) : null}
            {rfqs.some((r) => r.purchase_order_id !== null) ? (
              <p className="basis-full text-muted-foreground">
                An order has already been made from this request, so nothing starts chosen. Check what it holds, so no line is ordered twice.
              </p>
            ) : null}
          </div>
        ) : null}
        {confirmingSplit ? (
          <div
            role="group"
            aria-label={`Make ${plan.orders.length === 1 ? 'a purchase order' : `${plan.orders.length} purchase orders`} from the chosen quotes`}
            className="space-y-3"
            onKeyDown={escapes}
          >
            <p>
              Make {plan.orders.length === 1 ? 'this draft purchase order' : `these ${plan.orders.length} draft purchase orders`}? Each
              has the lines chosen for its supplier, at the prices quoted, and stays a draft on Purchase Orders until it is
              submitted for approval. The RFQs stay as they are.
            </p>
            <ul className="space-y-3">
              {plan.orders.map((o) => (
                <li key={o.rfq.id} className="rounded-lg border p-3">
                  <p>
                    <span className="font-medium">{o.rfq.supplier_name}</span> · {o.rfq.rfq_no} · {lineCount(o.lines.length)} ·{' '}
                    {money(o.sen / 100, o.rfq.currency)}
                  </p>
                  {o.lines.length < o.quoted ? (
                    <p className="text-xs text-muted-foreground">
                      Gets {o.lines.length} of the {o.quoted} lines it quoted. Check any minimum order or delivery charge.
                    </p>
                  ) : null}
                  <RfqReasonInput
                    label={`Why ${o.rfq.supplier_name} was chosen`}
                    value={reasons[o.rfq.id] ?? ''}
                    onChange={(value) => setReasons((cur) => ({ ...cur, [o.rfq.id]: value }))}
                    disabled={action.pending}
                    hint={splitReasonHint(o) ?? undefined}
                  />
                </li>
              ))}
            </ul>
            {plan.noQuote > 0 ? (
              <p className="text-muted-foreground">
                {lineCount(plan.noQuote)} had no quotes and {plan.noQuote === 1 ? 'is' : 'are'} not ordered.
              </p>
            ) : null}
            {plan.notChosen > 0 ? (
              <p className="text-muted-foreground">
                {lineCount(plan.notChosen)} {plan.notChosen === 1 ? 'was' : 'were'} left out.
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-3">
              {/* aria-disabled rather than disabled, as in ConfirmRow: a disabled button drops focus to the page. */}
              <Button
                type="button"
                size="sm"
                aria-disabled={action.pending}
                className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
                autoFocus
                onClick={makeSplit}
              >
                {action.pending ? 'Making…' : makeSplitLabel(plan.orders.length)}
              </Button>
              <Button type="button" size="sm" variant="outline" disabled={action.pending} onClick={cancel}>
                Cancel
              </Button>
            </div>
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
            Lowest is the lowest price for one unit once SST is added
            {mixed ? ', and the lowest total, compared in ringgit at each RFQ’s own exchange rate' : ''}. The lowest price
            is not always the best choice: delivery time and past service count too.
            {split
              ? ` Split shows what the lines chosen would cost${plan.mixed ? ', in ringgit at each RFQ’s own exchange rate' : ''}; each order is priced when it is made.`
              : ''}
          </p>
          <div className="flex items-center gap-2">
            {canSplit ? (
              <Button type="button" size="sm" variant="outline" aria-pressed={split} disabled={action.pending} onClick={toggleSplit}>
                {split ? 'Stop splitting' : 'Split between suppliers'}
              </Button>
            ) : null}
            <Button type="button" size="sm" variant="outline" onClick={onClose} disabled={action.pending} ref={closeButton}>
              Close
            </Button>
          </div>
        </div>
      </div>
    </BentoCard>
  );
}
