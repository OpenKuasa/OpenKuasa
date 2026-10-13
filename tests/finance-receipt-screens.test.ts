import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');

/**
 * Expenses and Supplier Bills draw a paperclip only if their loader reads the receipts tied to the rows and hands
 * the view the inbox's link action. A loader is an async server component with no unit of its own, so its wiring
 * is read from its text, as the other screens' source checks are.
 */
describe('the paperclip is wired on the two document screens', () => {
  for (const [name, file] of [
    ['Expenses', 'src/screens/finance/expenses.tsx'],
    ['Supplier Bills', 'src/screens/finance/supplier-bills.tsx'],
  ] as const) {
    it(`${name} reads the tied receipts, groups them by document and passes the link action`, () => {
      const source = read(file);
      // A failed read of the tied receipts costs the paperclips and nothing else (attachedReceiptsOrNone, tested).
      expect(source).toContain('attachedReceiptsOrNone(() => listAttachedReceipts(ctx))');
      expect(source).toContain('receipts={receiptsByDocument(attached)}');
      expect(source).toContain('receiptLinkOf={receiptLinkAction}');
      expect(source).toContain("import { receiptLinkAction } from '@/app/(app)/finance/receipt-inbox-actions';");
    });
  }
});
