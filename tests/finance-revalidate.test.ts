import { describe, expect, it } from 'vitest';
import { FINANCE_REVALIDATE } from '@/lib/ai/finance-revalidate';
import { FINANCE_WRITE_TOOL_NAMES } from '@/lib/ai/finance-tools';
import { FINANCE_ID_GATED, FINANCE_SAVE_GATED } from '@/lib/ai/finance-id-gate';

/**
 * The finance write actions whose tools arrive in Tasks 7-10. Their revalidation paths are pinned here now,
 * so a later task that adds a tool but forgets its screen path fails loudly.
 */
const WRITE_ACTIONS = [
  'saveRfq',
  'sendRfq',
  'quoteRfq',
  'convertRfq',
  'closeRfq',
  'savePurchaseOrder',
  'submitPurchaseOrder',
  'receivePurchaseOrder',
  'billFromPurchaseOrder',
  'decidePurchaseOrder',
  'closePurchaseOrder',
  'cancelPurchaseOrder',
  'saveJournal',
  'postJournal',
  'reverseJournal',
] as const;

describe('finance revalidation map', () => {
  it('maps every expected finance write action to at least one /finance screen path', () => {
    for (const action of WRITE_ACTIONS) {
      const paths = FINANCE_REVALIDATE[action];
      expect(paths, action).toBeDefined();
      expect(Array.isArray(paths) && paths.length > 0, action).toBe(true);
      expect(paths?.every((p) => p.startsWith('/finance')), action).toBe(true);
    }
  });

  it('every entry in the map is a non-empty list of /finance screen paths', () => {
    for (const [action, paths] of Object.entries(FINANCE_REVALIDATE)) {
      expect(Array.isArray(paths) && paths.length > 0, action).toBe(true);
      expect(paths.every((p) => p.startsWith('/finance')), action).toBe(true);
    }
  });

  it('every new write tool is registered as a finance write tool AND has a revalidation entry', () => {
    for (const action of WRITE_ACTIONS) {
      expect(FINANCE_WRITE_TOOL_NAMES, action).toContain(action);
      expect(FINANCE_REVALIDATE[action], action).toBeDefined();
    }
  });

  // The map keys are exactly the id-gated finance write actions: a typo in a key (or a stray key) is caught
  // here, not silently ignored by `revalidateFinance`'s `?? []`. Pure data, no next/cache mock needed.
  it('covers exactly the id-gated finance write actions', () => {
    expect(Object.keys(FINANCE_REVALIDATE).sort()).toEqual(
      [...Object.keys(FINANCE_ID_GATED), ...Object.keys(FINANCE_SAVE_GATED)].sort(),
    );
  });
});
