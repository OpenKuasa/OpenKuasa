'use client';

import { useId, useRef } from 'react';
import { Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { billTotals, lineAmounts } from '@/lib/finance/bill-math';
import { type LineDraft, emptyLine, lineNumbers } from '@/lib/finance/document-form';
import { DOCUMENT_LINES_MAX } from '@/lib/finance/document-lines';
import { rm } from '@/lib/finance/format';
import type { FinanceProduct } from '@/lib/finance/products';
import { cn } from '@/lib/utils';

/** Radix Select has no empty value; this stands for "no product" and never leaves the component. */
const NO_PRODUCT = 'none';

/**
 * The lines of a bill, invoice, quotation or RFQ, with live totals. On a phone each line
 * is a card with its fields stacked two to a row; from the md breakpoint a
 * line is one row. Nothing scrolls sideways. The arithmetic is in
 * src/lib/finance/bill-math.ts.
 */
export function LineItemsEditor({
  lines,
  products,
  withProduct,
  pricePlaceholder = '0.00',
  onChange,
}: {
  lines: LineDraft[];
  /** Active products and services, for the optional picker. */
  products: FinanceProduct[];
  /** What choosing a product fills in: a bill takes its cost, an invoice its price. */
  withProduct: (line: LineDraft, product: FinanceProduct | null) => LineDraft;
  /** What an empty price box says. */
  pricePlaceholder?: string;
  onChange: (lines: LineDraft[]) => void;
}) {
  const id = useId();
  const addButton = useRef<HTMLButtonElement>(null);
  /** The line just added, so its first box can take focus once it is on the page. */
  const justAdded = useRef<string | null>(null);
  const totals = billTotals(lines.map(lineNumbers));

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
    <div className="space-y-3">
      <ol className="space-y-3 md:space-y-2">
        {lines.map((line, index) => {
          const n = index + 1;
          const field = (name: string) => `${id}-${line.key}-${name}`;
          // From md up only the first line shows its labels, like a table's header row.
          const label = cn('text-xs text-muted-foreground', index > 0 && 'md:sr-only');
          // A product archived since the draft was saved is still this line's product.
          const known = line.product_id === '' || products.some((p) => p.id === line.product_id);
          return (
            <li
              key={line.key}
              aria-label={`Line ${n}`}
              className="grid grid-cols-2 gap-2 rounded-lg border p-3 md:grid-cols-12 md:items-end md:border-0 md:p-0"
            >
              <div className="col-span-2 space-y-1 md:col-span-2">
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
              <div className="col-span-2 space-y-1 md:col-span-3">
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
              <div className="space-y-1 md:col-span-1">
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
              <div className="space-y-1 md:col-span-1">
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
              <div className="space-y-1 md:col-span-2">
                <Label htmlFor={field('price')} className={label}>
                  Unit price (RM)
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
              <div className="space-y-1 md:col-span-1">
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
              <div className="col-span-2 flex items-end justify-between gap-2 md:col-span-2">
                <div className="min-w-0 space-y-1">
                  <span className={cn('block', label)}>Amount</span>
                  <output
                    htmlFor={`${field('quantity')} ${field('price')}`}
                    aria-label={`Amount for line ${n}`}
                    className="flex h-8 items-center truncate text-sm font-medium tabular-nums"
                  >
                    {rm(lineAmounts(lineNumbers(line)).amount)}
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
        <dl className="grid w-full grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-sm sm:w-64" aria-live="polite">
          <dt className="text-muted-foreground">Subtotal</dt>
          <dd className="text-right tabular-nums">{rm(totals.subtotal)}</dd>
          <dt className="text-muted-foreground">SST</dt>
          <dd className="text-right tabular-nums">{rm(totals.sst)}</dd>
          <dt className="font-semibold">Total</dt>
          <dd className="text-right font-semibold tabular-nums">{rm(totals.total)}</dd>
        </dl>
      </div>
    </div>
  );
}
