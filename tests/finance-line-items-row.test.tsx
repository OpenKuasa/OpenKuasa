import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  LINE_GAP_REM,
  LineItemsEditor,
  lineRowFromRem,
  lineTemplate,
  lineTracks,
} from '@/components/finance/line-items-editor';
import { emptyLine } from '@/lib/finance/document-form';

// A closed select draws nothing but its trigger, and Radix reads the DOM; the markup is all this file needs.
vi.mock('@/components/ui/select', () => {
  const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
  return {
    Select: Pass,
    SelectTrigger: Pass,
    SelectValue: () => null,
    SelectContent: Pass,
    SelectItem: Pass,
  };
});

/**
 * A line is one row of seven boxes on a bill or RFQ, or eight on an invoice or quotation, which carry
 * a per-line discount. Which layout it takes must follow the width of the form it sits in, not the
 * width of the screen: the menu beside the form takes about 250px, so a tablet screen leaves the form
 * far too narrow for one row (issue #396). The floors were measured in Chrome with Lexend; these
 * checks hold the numbers and the rules that keep them honest.
 */
const markup = (discount = false) =>
  renderToStaticMarkup(
    <LineItemsEditor
      lines={[emptyLine('k1')]}
      products={[]}
      withProduct={(line) => line}
      pricePlaceholder="Supplier price"
      discount={discount}
      onChange={() => {}}
    />,
  );

const floorsAndGaps = (discount: boolean) => {
  const tracks = lineTracks(discount);
  return tracks.reduce((sum, t) => sum + t.floor, 0) + (tracks.length - 1) * LINE_GAP_REM;
};

/** The box a field's label and input sit in: the nearest `<div class=…>` before the field's label. */
const fieldBox = (html: string, name: string) => {
  const at = html.indexOf(`-k1-${name}"`);
  if (at === -1) throw new Error(`no ${name} in the markup`);
  const opens = [...html.slice(0, at).matchAll(/<div class="([^"]*)"/g)];
  return opens.at(-1)?.[1].split(/\s+/) ?? [];
};

/** How many of the card's six columns a box takes. */
const span = (classes: string[]) => Number(classes.find((c) => /^col-span-\d$/.test(c))?.slice(9) ?? 1);

/** The amount box: it has no label `for`, so it is the box around the line's output. */
const amountBox = (html: string) => {
  const at = html.indexOf('aria-label="Amount for line 1"');
  return [...html.slice(0, at).matchAll(/<div class="([^"]*)"/g)].at(-2)?.[1].split(/\s+/) ?? [];
};

/** The line card's boxes in order, each with the columns of the card's six it takes. */
const cardSpans = (discount: boolean) => {
  const html = markup(discount);
  const names = ['product', 'description', 'quantity', 'uom', 'price', 'sst', ...(discount ? ['discount'] : [])];
  return [...names.map((name) => span(fieldBox(html, name))), span(amountBox(html))];
};

describe('a line of a document', () => {
  it('switches to one row on the form’s own width, not the screen’s', () => {
    for (const discount of [false, true]) {
      const html = markup(discount);
      expect(html).toContain('@container/lines');
      // No screen-width breakpoint is left on the line, its boxes or its totals. (The inputs' own
      // `md:text-sm` is the shared input's and only sets the text size.)
      const own = [...html.matchAll(/<(?:li|div|ol)[^>]*\sclass="([^"]*)"/g)].map((m) => m[1]).join(' ');
      expect(own).not.toMatch(/(^|\s)(sm|md|lg|xl):/);
    }
  });

  it('draws the row from the tracks, seven on a purchase and eight on a sale', () => {
    expect(lineTracks(false)).toHaveLength(7);
    expect(lineTracks(true)).toHaveLength(8);
    for (const discount of [false, true]) {
      const style = markup(discount).match(/--line-tracks:([^";]*)/)?.[1];
      expect(style?.trim()).toBe(lineTemplate(lineTracks(discount)));
    }
  });

  it('only goes to one row once every box can keep its floor', () => {
    expect(floorsAndGaps(false)).toBeLessThanOrEqual(lineRowFromRem(false));
    expect(floorsAndGaps(true)).toBeLessThanOrEqual(lineRowFromRem(true));
    // A sales line has no slack to spare at its switch, so a wider floor has to move the switch.
    expect(floorsAndGaps(true)).toBe(lineRowFromRem(true));
  });

  it('keeps the switch widths in the theme the same as the code', () => {
    const css = readFileSync(resolve('src/app/globals.css'), 'utf8');
    expect(css).toMatch(new RegExp(`--container-lines-row:\\s*${lineRowFromRem(false)}rem;`));
    expect(css).toMatch(new RegExp(`--container-lines-row-sales:\\s*${lineRowFromRem(true)}rem;`));
  });

  it('switches every part of a line at the one width its document uses', () => {
    // A label or a box that changes at a different width than its row would leave a line with eight
    // boxes and seven labels, or the row at one width and its spacing at another.
    const sizes = (html: string) => new Set([...html.matchAll(/@([a-z-]+)\/lines:/g)].map((m) => m[1]).filter((s) => s !== 'sm'));
    expect(sizes(markup(false))).toEqual(new Set(['lines-row']));
    expect(sizes(markup(true))).toEqual(new Set(['lines-row-sales']));
    expect(markup(true)).not.toMatch(/@min-\[/);
  });

  it('gives each box the floor its measured text needs', () => {
    const floor = (discount: boolean, box: string) => lineTracks(discount).find((t) => t.box === box)?.floor;
    for (const discount of [false, true]) {
      // "No product" (77px) beside the trigger's padding and chevron (42px).
      expect(floor(discount, 'product')).toBeGreaterThanOrEqual(7.5);
      // "Arabica beans, roasted" (161px).
      expect(floor(discount, 'description')).toBeGreaterThanOrEqual(11.5);
      // "Supplier price", the longest placeholder.
      expect(floor(discount, 'price')).toBeGreaterThanOrEqual(8.5);
      // "USD 123,456.00" (106px) beside the 32px remove button and the 8px gap.
      expect(floor(discount, 'amount')).toBeGreaterThanOrEqual(9.25);
    }
    // "12.5" with the number arrows and padding (63px), the 64px unit select and the 4px gap.
    expect(floor(true, 'discount')).toBeGreaterThanOrEqual(8.25);
  });

  it('gives the description more of the free width than any other box', () => {
    for (const discount of [false, true]) {
      const tracks = lineTracks(discount);
      const description = tracks.find((t) => t.box === 'description')?.share ?? 0;
      for (const t of tracks) if (t.box !== 'description') expect(description).toBeGreaterThan(t.share);
    }
  });

  it('leaves no half-empty row on a line card', () => {
    for (const discount of [false, true]) {
      let column = 0;
      for (const taken of cardSpans(discount)) {
        // A box that does not fit in what is left of a row would wrap and leave a hole behind it.
        expect(column + taken).toBeLessThanOrEqual(6);
        column = (column + taken) % 6;
      }
      expect(column).toBe(0);
    }
  });

  it('keeps the price and the amount wide on a phone, so neither is cut off', () => {
    // "Supplier price" is the longest placeholder (130px with the padding); two thirds of a 300px
    // card is 181px. "RM 123,456.00" shares its box with the remove button: beside another box on a
    // 300px card the amount lost 5px, so it takes the whole row.
    for (const discount of [false, true]) {
      const html = markup(discount);
      expect(span(fieldBox(html, 'price'))).toBeGreaterThanOrEqual(4);
      expect(span(amountBox(html))).toBe(6);
    }
  });

  it('takes every box back to one track on the row layout', () => {
    for (const discount of [false, true]) {
      const html = markup(discount);
      const oneTrack = `@${discount ? 'lines-row-sales' : 'lines-row'}/lines:col-span-1`;
      const names = ['product', 'description', 'quantity', 'uom', 'price', 'sst', ...(discount ? ['discount'] : [])];
      for (const name of names) expect(fieldBox(html, name)).toContain(oneTrack);
      expect(amountBox(html)).toContain(oneTrack);
    }
  });

  it('keeps the product box as tall as the others on the row', () => {
    // Inside a form, the product select also draws a hidden native <select> as the box's last child.
    // `space-y-1` puts its margin under every child but the last, so the visible trigger got 4px
    // under it and the box stood 4px taller, its label 4px above the row's other labels. A flex gap
    // only falls between children in the flow, and the hidden select is positioned out of it.
    for (const discount of [false, true]) {
      const box = fieldBox(markup(discount), 'product');
      expect(box).not.toContain('space-y-1');
      expect(box).toEqual(expect.arrayContaining(['flex', 'flex-col', 'gap-1']));
    }
  });

  it('sizes the totals from the form too', () => {
    const html = markup(true);
    expect(html).toContain('@sm/lines:w-64');
  });
});
