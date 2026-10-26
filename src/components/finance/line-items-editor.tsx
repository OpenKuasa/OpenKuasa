'use client';

import { type CSSProperties, useId, useRef } from 'react';
import { Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { documentTotals, lineAmounts } from '@/lib/finance/bill-math';
import {
  type DocDiscountDraft,
  type LineDraft,
  docDiscountNumbers,
  docDiscountProblem,
  emptyLine,
  lineNumbers,
} from '@/lib/finance/document-form';
import { DOCUMENT_LINES_MAX } from '@/lib/finance/document-lines';
import { currencyLabel } from '@/lib/finance/currencies';
import { money } from '@/lib/finance/format';
import type { FinanceProduct } from '@/lib/finance/products';
import { cn } from '@/lib/utils';

/** Radix Select has no empty value; this stands for "no product" and never leaves the component. */
const NO_PRODUCT = 'none';

/** One box of a line on the one-row layout: the narrowest it may get, in rem, and its share of the rest. */
export type LineTrack = { box: string; floor: number; share: number };

/** The space between two boxes on the row (`gap-2`), in rem. */
export const LINE_GAP_REM = 0.5;

/**
 * The boxes of a line on the one-row layout, in order, each with a floor its own text needs. Measured
 * in Lexend, the app's face:
 * - product 8rem: "No product" (77px) beside the trigger's padding and chevron (42px);
 * - description 11.5rem: "Arabica beans, roasted" (161px);
 * - quantity, unit and SST 3.5rem: a short number or "kg";
 * - price 8.5rem: the longest placeholder, "Supplier price";
 * - discount 8.5rem: "12.5" (26px), the number arrows Chrome draws on hover and focus (about 15px) and
 *   the input's padding (22px), beside the 64px unit select and its 4px gap;
 * - amount 9.5rem: "USD 123,456.00" (106px) beside the 32px remove button and its 8px gap.
 */
export function lineTracks(discount: boolean): LineTrack[] {
  return [
    { box: 'product', floor: 8, share: 2 },
    { box: 'description', floor: 11.5, share: discount ? 4 : 3 },
    { box: 'quantity', floor: 3.5, share: 1 },
    { box: 'unit', floor: 3.5, share: 1 },
    { box: 'price', floor: 8.5, share: 2 },
    { box: 'sst', floor: 3.5, share: 1 },
    ...(discount ? [{ box: 'discount', floor: 8.5, share: 2 }] : []),
    { box: 'amount', floor: 9.5, share: 2 },
  ];
}

/** The row's `grid-template-columns`. */
export function lineTemplate(tracks: LineTrack[]): string {
  return tracks.map((t) => `minmax(${t.floor}rem,${t.share}fr)`).join(' ');
}

/**
 * The form width, in rem, from which a line is one row: the theme's `--container-lines-row` (54rem)
 * and `--container-lines-row-sales` (60rem) in globals.css, which the tests hold to these numbers.
 * The seven purchase floors and their gaps come to 51rem; the eight sales floors and their gaps come
 * to exactly 60rem, so a sales line waits for that.
 */
export function lineRowFromRem(discount: boolean): number {
  return discount ? 60 : 54;
}

/**
 * The classes that switch a line to one row. Tailwind only sees whole class names, so each width is
 * written out once here and the rest of the file uses these. Named sizes keep the width itself in one
 * place, the theme.
 */
const ROW = {
  purchase: {
    list: '@lines-row/lines:space-y-2',
    row: '@lines-row/lines:grid-cols-(--line-tracks) @lines-row/lines:items-end @lines-row/lines:border-0 @lines-row/lines:p-0',
    oneTrack: '@lines-row/lines:col-span-1',
    header: '@lines-row/lines:sr-only',
  },
  sales: {
    list: '@lines-row-sales/lines:space-y-2',
    row: '@lines-row-sales/lines:grid-cols-(--line-tracks) @lines-row-sales/lines:items-end @lines-row-sales/lines:border-0 @lines-row-sales/lines:p-0',
    oneTrack: '@lines-row-sales/lines:col-span-1',
    header: '@lines-row-sales/lines:sr-only',
  },
} as const;

/**
 * The lines of a bill, invoice, quotation or RFQ, with live totals. On a phone or a tablet each line
 * is a card: quantity beside unit, price beside SST, and every other box on a row of its own, so no row
 * is left half empty and the amount always has the card's full width. Once the form itself is wide
 * enough a line is one row, and each box in it has a floor so nothing is squeezed below its own text
 * (see `lineTracks`). The row follows the width of the form and not the width of the screen, because
 * the menu beside the form takes about 250px (issue #396). Nothing scrolls sideways. The arithmetic
 * is in src/lib/finance/bill-math.ts.
 */
export function LineItemsEditor({
  lines,
  products,
  withProduct,
  pricePlaceholder = '0.00',
  discount = false,
  currency = 'MYR',
  docDiscount,
  onChange,
}: {
  /** The document's currency: its amounts and labels read in it. Ringgit when absent, exactly as before. */
  currency?: string;
  lines: LineDraft[];
  /** Active products and services, for the optional picker. */
  products: FinanceProduct[];
  /** What choosing a product fills in: a bill takes its cost, an invoice its price. */
  withProduct: (line: LineDraft, product: FinanceProduct | null) => LineDraft;
  /** What an empty price box says. */
  pricePlaceholder?: string;
  /** Sales documents show a per-line discount (a percentage or a ringgit amount); others do not. */
  discount?: boolean;
  /**
   * A discount on the whole document (invoices and quotations): its box is drawn below the lines and the
   * totals read Subtotal, "Less: discount", SST, Total. Absent, the totals are the lines' own.
   */
  docDiscount?: { label: string; draft: DocDiscountDraft; onChange: (draft: DocDiscountDraft) => void };
  onChange: (lines: LineDraft[]) => void;
}) {
  const id = useId();
  const addButton = useRef<HTMLButtonElement>(null);
  /** The line just added, so its first box can take focus once it is on the page. */
  const justAdded = useRef<string | null>(null);
  const docDraft = docDiscount?.draft;
  const docNumbers = docDraft ? docDiscountNumbers(docDraft) : { pct: null, amount: null };
  // The lines are in position order, which is how the split breaks ties.
  const totals = documentTotals(lines.map(lineNumbers), docNumbers);
  const docIsAmount = docDraft ? docDraft.amount.trim() !== '' : false;
  const docProblem = docDraft ? docDiscountProblem(lines, docDraft) : null;
  // "Less: discount 10%" for a percentage; a fixed amount is its own figure.
  const lessLabel = docNumbers.pct != null && docNumbers.pct > 0 ? `Less: discount ${docNumbers.pct}%` : 'Less: discount';
  const hasDocDiscount = (docNumbers.pct != null && docNumbers.pct > 0) || (docNumbers.amount != null && docNumbers.amount > 0);

  const wide = discount ? ROW.sales : ROW.purchase;
  const rowStyle = { '--line-tracks': lineTemplate(lineTracks(discount)) } as CSSProperties;

  const change = (key: string, next: (line: LineDraft) => LineDraft) =>
    onChange(lines.map((line) => (line.key === key ? next(line) : line)));

  const add = () => {
    const key = `new-${Date.now()}-${lines.length}`;
    justAdded.current = key;
    onChange([...lines, emptyLine(key)]);
  };

  const remove = (key: string) => {
    onChange(lines.filter((line) => line.key !== key));
    // The button that was pressed is gone; keep the keyboard somewhere useful.
    addButton.current?.focus();
  };

  return (
    <div className="@container/lines space-y-3">
      <ol className={cn('space-y-3', wide.list)}>
        {lines.map((line, index) => {
          const n = index + 1;
          const field = (name: string) => `${id}-${line.key}-${name}`;
          // Only the first line shows its labels once the lines are on one row, like a table's header row.
          const label = cn('text-xs text-muted-foreground', index > 0 && wide.header);
          // A product archived since the draft was saved is still this line's product.
          const known = line.product_id === '' || products.some((p) => p.id === line.product_id);
          return (
            <li
              key={line.key}
              aria-label={`Line ${n}`}
              className={cn('grid grid-cols-6 gap-2 rounded-lg border p-3', wide.row)}
              style={rowStyle}
            >
              {/* A flex gap, not space-y: in a form the select adds a hidden native select as the last
                  child, and space-y would then put 4px under the trigger and lift this box's label. */}
              <div className={cn('col-span-6 flex flex-col gap-1', wide.oneTrack)}>
                <Label htmlFor={field('product')} className={label}>
                  Product
                </Label>
                <Select
                  value={line.product_id || NO_PRODUCT}
                  onValueChange={(v) =>
                    change(line.key, (l) => withProduct(l, v === NO_PRODUCT ? null : (products.find((p) => p.id === v) ?? null)))
                  }
                >
                  <SelectTrigger id={field('product')} className="w-full" aria-label={`Product for line ${n}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_PRODUCT}>No product</SelectItem>
                    {known ? null : <SelectItem value={line.product_id}>Archived item</SelectItem>}
                    {products.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className={cn('col-span-6 space-y-1', wide.oneTrack)}>
                <Label htmlFor={field('description')} className={label}>
                  Description
                </Label>
                <Input
                  id={field('description')}
                  ref={(input) => {
                    if (!input || justAdded.current !== line.key) return;
                    justAdded.current = null;
                    input.focus();
                  }}
                  value={line.description}
                  maxLength={200}
                  autoComplete="off"
                  aria-label={`Description for line ${n}`}
                  onChange={(e) => change(line.key, (l) => ({ ...l, description: e.target.value }))}
                />
              </div>
              <div className={cn('col-span-3 space-y-1', wide.oneTrack)}>
                <Label htmlFor={field('quantity')} className={label}>
                  Qty
                </Label>
                <Input
                  id={field('quantity')}
                  type="number"
                  onWheel={(e) => e.currentTarget.blur()}
                  inputMode="decimal"
                  min={0}
                  step="any"
                  className="tabular-nums"
                  value={line.quantity}
                  aria-label={`Quantity for line ${n}`}
                  onChange={(e) => change(line.key, (l) => ({ ...l, quantity: e.target.value }))}
                />
              </div>
              <div className={cn('col-span-3 space-y-1', wide.oneTrack)}>
                <Label htmlFor={field('uom')} className={label}>
                  Unit
                </Label>
                <Input
                  id={field('uom')}
                  value={line.uom}
                  maxLength={200}
                  placeholder="unit"
                  autoComplete="off"
                  aria-label={`Unit for line ${n}`}
                  onChange={(e) => change(line.key, (l) => ({ ...l, uom: e.target.value }))}
                />
              </div>
              {/* On a card the price box takes two thirds of its row beside SST, room for the longest placeholder. */}
              <div className={cn('col-span-4 space-y-1', wide.oneTrack)}>
                <Label htmlFor={field('price')} className={label}>
                  Unit price ({currencyLabel(currency)})
                </Label>
                <Input
                  id={field('price')}
                  type="number"
                  onWheel={(e) => e.currentTarget.blur()}
                  inputMode="decimal"
                  min={0}
                  step="any"
                  placeholder={pricePlaceholder}
                  className="tabular-nums"
                  value={line.unit_price}
                  aria-label={`Unit price for line ${n}`}
                  onChange={(e) => change(line.key, (l) => ({ ...l, unit_price: e.target.value }))}
                />
              </div>
              <div className={cn('col-span-2 space-y-1', wide.oneTrack)}>
                <Label htmlFor={field('sst')} className={label}>
                  SST %
                </Label>
                <Input
                  id={field('sst')}
                  type="number"
                  onWheel={(e) => e.currentTarget.blur()}
                  inputMode="decimal"
                  min={0}
                  max={100}
                  step="any"
                  className="tabular-nums"
                  value={line.sst_rate}
                  aria-label={`SST percent for line ${n}`}
                  onChange={(e) => change(line.key, (l) => ({ ...l, sst_rate: e.target.value }))}
                />
              </div>
              {discount ? (
                <div className={cn('col-span-6 space-y-1', wide.oneTrack)}>
                  <Label htmlFor={field('discount')} className={label}>
                    Discount
                  </Label>
                  <div className="flex gap-1">
                    <Input
                      id={field('discount')}
                      type="number"
                      onWheel={(e) => e.currentTarget.blur()}
                      inputMode="decimal"
                      min={0}
                      step="any"
                      className="tabular-nums"
                      value={line.discount_amount.trim() !== '' ? line.discount_amount : line.discount_pct}
                      aria-label={`Discount for line ${n}`}
                      onChange={(e) =>
                        change(line.key, (l) =>
                          l.discount_amount.trim() !== ''
                            ? { ...l, discount_amount: e.target.value, discount_pct: '' }
                            : { ...l, discount_pct: e.target.value, discount_amount: '' },
                        )
                      }
                    />
                    <Select
                      value={line.discount_amount.trim() !== '' ? 'rm' : 'pct'}
                      onValueChange={(u) =>
                        change(line.key, (l) => {
                          const current = l.discount_amount.trim() !== '' ? l.discount_amount : l.discount_pct;
                          return u === 'rm'
                            ? { ...l, discount_amount: current, discount_pct: '' }
                            : { ...l, discount_pct: current, discount_amount: '' };
                        })
                      }
                    >
                      <SelectTrigger className="w-16 shrink-0" aria-label={`Discount unit for line ${n}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="pct">%</SelectItem>
                        <SelectItem value="rm">{currencyLabel(currency)}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              ) : null}
              <div className={cn('col-span-6 flex items-end justify-between gap-2', wide.oneTrack)}>
                <div className="min-w-0 space-y-1">
                  <span className={cn('block', label)}>Amount</span>
                  <output
                    htmlFor={`${field('quantity')} ${field('price')}`}
                    aria-label={`Amount for line ${n}`}
                    className="flex h-8 items-center truncate text-sm font-medium tabular-nums"
                  >
                    {money(lineAmounts(lineNumbers(line)).amount, currency)}
                  </output>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove line ${n}`}
                  disabled={lines.length === 1}
                  onClick={() => remove(line.key)}
                >
                  <X className="size-4" />
                </Button>
              </div>
            </li>
          );
        })}
      </ol>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <Button ref={addButton} type="button" variant="outline" size="sm" disabled={lines.length >= DOCUMENT_LINES_MAX} onClick={add}>
          <Plus className="size-4" />
          Add line
        </Button>
        <div className="w-full space-y-3 @sm/lines:w-64">
          {docDiscount && docDraft ? (
            <div className="space-y-1">
              <Label htmlFor={`${id}-doc-discount`} className="text-xs text-muted-foreground">
                {docDiscount.label}
              </Label>
              <div className="flex gap-1">
                <Input
                  id={`${id}-doc-discount`}
                  type="number"
                  onWheel={(e) => e.currentTarget.blur()}
                  inputMode="decimal"
                  min={0}
                  step="any"
                  className="tabular-nums"
                  value={docIsAmount ? docDraft.amount : docDraft.pct}
                  aria-invalid={docProblem ? true : undefined}
                  aria-describedby={docProblem ? `${id}-doc-discount-problem` : undefined}
                  onChange={(e) =>
                    docDiscount.onChange(docIsAmount ? { pct: '', amount: e.target.value } : { pct: e.target.value, amount: '' })
                  }
                />
                <Select
                  value={docIsAmount ? 'rm' : 'pct'}
                  onValueChange={(u) => {
                    const current = docIsAmount ? docDraft.amount : docDraft.pct;
                    docDiscount.onChange(u === 'rm' ? { pct: '', amount: current } : { pct: current, amount: '' });
                  }}
                >
                  <SelectTrigger className="w-16 shrink-0" aria-label={`${docDiscount.label}: unit`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="pct">%</SelectItem>
                    <SelectItem value="rm">{currencyLabel(currency)}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {docProblem ? (
                <p id={`${id}-doc-discount-problem`} role="alert" className="text-xs text-destructive">
                  {docProblem}
                </p>
              ) : null}
            </div>
          ) : null}
          <dl className="grid w-full grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-sm" aria-live="polite">
            <dt className="text-muted-foreground">Subtotal</dt>
            <dd className="text-right tabular-nums">{money(totals.subtotal, currency)}</dd>
            {hasDocDiscount ? (
              <>
                <dt className="text-muted-foreground">{lessLabel}</dt>
                <dd className="text-right tabular-nums">−{money(totals.discount, currency)}</dd>
              </>
            ) : null}
            <dt className="text-muted-foreground">SST</dt>
            <dd className="text-right tabular-nums">{money(totals.sst, currency)}</dd>
            <dt className="font-semibold">Total</dt>
            <dd className="text-right font-semibold tabular-nums">{money(totals.total, currency)}</dd>
          </dl>
        </div>
      </div>
    </div>
  );
}
