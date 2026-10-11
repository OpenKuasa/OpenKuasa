import { describe, expect, it } from 'vitest';
import { type DocumentParty, withCurrentParty } from '@/lib/finance/document-form';

const active: DocumentParty[] = [
  { id: 'aisyah', name: 'Aisyah Trading', payment_terms_days: 14 },
  { id: 'zaki', name: 'Zaki Enterprise', payment_terms_days: 30 },
];

describe('withCurrentParty', () => {
  it('is the same list for a new document, which has no party yet', () => {
    expect(withCurrentParty(active)).toBe(active);
    expect(withCurrentParty(active, undefined)).toBe(active);
    expect(withCurrentParty([])).toEqual([]);
  });
  it('is the same list when the draft’s party is still offered, with that party’s own terms', () => {
    expect(withCurrentParty(active, { id: 'zaki', name: 'Zaki Enterprise' })).toBe(active);
  });
  it('puts a party archived since the draft was saved first, so the picker can show it', () => {
    expect(withCurrentParty(active, { id: 'lim', name: 'Lim Hardware' })).toEqual([
      { id: 'lim', name: 'Lim Hardware', payment_terms_days: 0 },
      ...active,
    ]);
    // The form must not open on "Add a customer first" when the only customer was archived.
    expect(withCurrentParty([], { id: 'lim', name: 'Lim Hardware' })).toEqual([
      { id: 'lim', name: 'Lim Hardware', payment_terms_days: 0 },
    ]);
  });
  it('does not change the list it was given', () => {
    const before = [...active];
    withCurrentParty(active, { id: 'lim', name: 'Lim Hardware' });
    expect(active).toEqual(before);
  });
});
