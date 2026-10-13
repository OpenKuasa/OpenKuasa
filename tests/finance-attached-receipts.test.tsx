import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AttachedReceipts } from '@/components/finance/attached-receipts';
import type { AttachedReceipt } from '@/lib/finance/receipt-match';

/**
 * The paperclip in a document's row, rendered to a string (no DOM here: nothing can be pressed). A receipt with
 * a file is a button that asks the link action for a download; it is never a link. One with no file, or a screen
 * with no link action, shows the name as text.
 */

const linkOf = vi.fn(async () => ({ ok: false as const, error: 'unused' }));

const receipt = (over: Partial<AttachedReceipt> = {}): AttachedReceipt => ({
  id: 'r1',
  file_name: 'petrol-5-oct.png',
  mime_type: 'image/png',
  has_file: true,
  expense_id: 'e1',
  bill_id: null,
  ...over,
});

const render = (receipts: AttachedReceipt[] | undefined, withLink = true) =>
  renderToStaticMarkup(<AttachedReceipts receipts={receipts} linkOf={withLink ? linkOf : undefined} />);

describe('the paperclip', () => {
  it('draws nothing for a document with no receipt', () => {
    expect(render(undefined)).toBe('');
    expect(render([])).toBe('');
  });

  it('a receipt with a file is a button, named for what it downloads, and never an anchor', () => {
    const html = render([receipt()]);
    expect(html).toContain('<button');
    expect(html).toContain('aria-label="Download the receipt petrol-5-oct.png"');
    expect(html).toContain('petrol-5-oct.png');
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('href');
    expect(html).not.toContain('sample receipt');
  });

  it('a receipt with no file (the demo) is text, with no button', () => {
    const html = render([receipt({ has_file: false })]);
    expect(html).not.toContain('<button');
    expect(html).toContain('petrol-5-oct.png (sample receipt, no file)');
  });

  it('a screen with no link action shows the name as text too', () => {
    const html = render([receipt()], false);
    expect(html).not.toContain('<button');
    expect(html).toContain('(sample receipt, no file)');
  });

  it('draws one line for each receipt, and a file name only as text', () => {
    const html = render([receipt(), receipt({ id: 'r2', file_name: '<b>x</b>.pdf', mime_type: 'application/pdf' })]);
    expect(html.match(/<button/g)).toHaveLength(2);
    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;.pdf');
  });
});
