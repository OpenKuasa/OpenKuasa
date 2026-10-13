import { describe, expect, it } from 'vitest';
import { VOID_REFUSED_TITLE, visibleOpen, voidQuestionGone } from '@/lib/finance/banking-open';

const ASKING = { kind: 'void', transactionId: 'tx-1' } as const;
const REFUSED = 'This transfer has already been voided.';

describe('visibleOpen', () => {
  it('shows a void question while its row is in the table, and hides it when the row is not', () => {
    expect(visibleOpen(ASKING, ['tx-1', 'tx-2'], [])).toEqual(ASKING);
    expect(visibleOpen(ASKING, ['tx-2'], [])).toBeNull();
  });

  it('shows an archive question while its account is there, and hides it when it is not', () => {
    const asking = { kind: 'archive', accountId: 'a-1' } as const;
    expect(visibleOpen(asking, [], ['a-1'])).toEqual(asking);
    expect(visibleOpen(asking, [], ['a-2'])).toBeNull();
  });

  it('never hides a form, whatever is on screen', () => {
    const form = { kind: 'transfer', today: '2026-10-13' } as const;
    expect(visibleOpen(form, [], [])).toEqual(form);
    expect(visibleOpen(null, ['tx-1'], ['a-1'])).toBeNull();
  });
});

describe('voidQuestionGone', () => {
  it('keeps the question while its row is in the table', () => {
    expect(voidQuestionGone(ASKING, ['tx-1'], false, REFUSED)).toEqual({ close: false, refusal: null });
  });

  it('closes it when the row has left, and hands back the refusal so it is still said', () => {
    expect(voidQuestionGone(ASKING, ['tx-2'], false, REFUSED)).toEqual({ close: true, refusal: REFUSED });
  });

  it('closes it with nothing to say when no refusal came (a search or filter hid it)', () => {
    expect(voidQuestionGone(ASKING, [], false, null)).toEqual({ close: true, refusal: null });
  });

  it('waits while the void is under way: its answer is still to come', () => {
    expect(voidQuestionGone(ASKING, [], true, null)).toEqual({ close: false, refusal: null });
  });

  it('has nothing to do for any other thing that is open', () => {
    const gone = { close: false, refusal: null };
    expect(voidQuestionGone(null, [], false, REFUSED)).toEqual(gone);
    expect(voidQuestionGone({ kind: 'archive', accountId: 'a-1' }, [], false, REFUSED)).toEqual(gone);
    expect(voidQuestionGone({ kind: 'transfer', today: '2026-10-13' }, [], false, REFUSED)).toEqual(gone);
  });

  it('names the note the way the screen titles it', () => {
    expect(VOID_REFUSED_TITLE).toBe('Transfer not voided');
  });
});
