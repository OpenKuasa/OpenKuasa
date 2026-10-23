import { describe, expect, it, vi } from 'vitest';
import { planSequenceSave, sendSequenceChanges } from '@/components/finance/settings-forms';
import type { SequenceRow } from '@/lib/finance/settings';

/** The numbering table's one Save: it sends only what changed and reports each refused row on its own. */

const rows: SequenceRow[] = [
  { doc: 'invoice', label: 'Invoice', prefix: 'INV-', nextNumber: 6, pad: 4 },
  { doc: 'quotation', label: 'Quotation', prefix: 'QT-', nextNumber: 3, pad: 4 },
  { doc: 'receipt', label: 'Receipt', prefix: 'RC-', nextNumber: 5, pad: 4 },
] as SequenceRow[];

const untouched = Object.fromEntries(rows.map((r) => [r.doc, { prefix: r.prefix, next: String(r.nextNumber) }]));

describe('planSequenceSave', () => {
  it('sends nothing when nothing changed, even with spaces around a number', () => {
    expect(planSequenceSave(rows, { ...untouched, invoice: { prefix: 'INV-', next: ' 6 ' } })).toEqual({ send: [], invalid: {} });
  });

  it('sends only the changed rows', () => {
    const plan = planSequenceSave(rows, {
      ...untouched,
      invoice: { prefix: 'INV/', next: '6' },
      receipt: { prefix: 'RC-', next: '10' },
    });
    expect(plan.send).toEqual([
      { doc: 'invoice', prefix: 'INV/', nextNumber: 6 },
      { doc: 'receipt', prefix: 'RC-', nextNumber: 10 },
    ]);
    expect(plan.invalid).toEqual({});
  });

  it('sends nothing and names each changed row whose number is not a whole number of 1 or more', () => {
    const plan = planSequenceSave(rows, {
      ...untouched,
      invoice: { prefix: 'INV-', next: '0' },
      quotation: { prefix: 'QT-', next: '2.5' },
      receipt: { prefix: 'RC/', next: '5' },
    });
    expect(plan.send).toEqual([]);
    expect(Object.keys(plan.invalid)).toEqual(['invoice', 'quotation']);
  });
});

describe('sendSequenceChanges', () => {
  it('saves each change in turn and returns only the refusals', async () => {
    const save = vi.fn(async ({ doc }: { doc: string }) =>
      doc === 'quotation' ? { ok: false as const, error: 'Prefix taken' } : { ok: true as const, data: null },
    );
    const refused = await sendSequenceChanges(
      [
        { doc: 'invoice', prefix: 'A-', nextNumber: 1 },
        { doc: 'quotation', prefix: 'B-', nextNumber: 1 },
        { doc: 'receipt', prefix: 'C-', nextNumber: 1 },
      ] as never,
      save as never,
    );
    expect(save).toHaveBeenCalledTimes(3);
    expect(refused).toEqual({ quotation: 'Prefix taken' });
  });

  it('says a lost answer may have saved, rather than that it failed', async () => {
    const refused = await sendSequenceChanges([{ doc: 'invoice', prefix: 'A-', nextNumber: 1 }] as never, (async () => {
      throw new Error('network');
    }) as never);
    expect(refused.invoice).toMatch(/could not confirm/);
  });
});
