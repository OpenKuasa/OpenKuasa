import { describe, expect, it } from 'vitest';
import { claimFormDefaults, receiptSubmitProblem, toClaimInput } from '@/lib/people/claim-forms';

describe('receiptSubmitProblem', () => {
  it('blocks a submit after a failed upload, and says how to go on', () => {
    expect(receiptSubmitProblem('failed')).toBe('The receipt did not upload. Remove the file, or choose it again, before you submit.');
  });

  it.each(['none', 'attached', 'uploading'] as const)('does not block a form whose receipt is %s', (state) => {
    expect(receiptSubmitProblem(state)).toBeNull();
  });
});

const TODAY = '2026-10-11';
const filled = { ...claimFormDefaults(TODAY), amount: '85.50', claim_date: '2026-10-09' };
const PATH = '11111111-1111-4111-8111-111111111111/44444444-4444-4444-8444-444444444444.pdf';

describe('claimFormDefaults', () => {
  it('starts on travel, dated today, with nothing typed or attached', () => {
    expect(claimFormDefaults(TODAY)).toEqual({ category: 'travel', amount: '', claim_date: TODAY, description: '', receipt_path: null });
  });
});

describe('toClaimInput', () => {
  it('sends the category, the amount in sen, the date and a trimmed description, with no employee', () => {
    expect(toClaimInput({ ...filled, description: '  Taxi to client  ' }, TODAY)).toEqual({
      ok: true,
      input: { category: 'travel', amount_cents: 8550, claim_date: '2026-10-09', description: 'Taxi to client', receipt_path: null },
    });
  });

  it('sends a blank description as null', () => {
    const result = toClaimInput({ ...filled, description: '   ' });
    expect(result.ok && result.input.description).toBeNull();
  });

  it('carries the receipt path once uploaded', () => {
    const result = toClaimInput({ ...filled, receipt_path: PATH });
    expect(result.ok && result.input.receipt_path).toBe(PATH);
  });

  it('accepts today, and any date when today is not known', () => {
    expect(toClaimInput({ ...filled, claim_date: TODAY }, TODAY).ok).toBe(true);
    expect(toClaimInput({ ...filled, claim_date: '2099-01-01' }).ok).toBe(true);
  });

  it.each([
    ['no amount', { amount: '' }, 'Enter the amount in Ringgit, like 85 or 85.50.'],
    ['an amount that is text', { amount: 'abc' }, 'Enter the amount in Ringgit, like 85 or 85.50.'],
    ['a negative amount', { amount: '-5' }, 'Enter the amount in Ringgit, like 85 or 85.50.'],
    ['a third decimal', { amount: '85.123' }, 'Enter the amount in Ringgit, like 85 or 85.50.'],
    ['an amount of zero', { amount: '0' }, 'Enter an amount above zero.'],
    ['an amount over RM 1,000,000', { amount: '1000000.01' }, 'Keep a claim to RM 1,000,000 or less.'],
    ['no date', { claim_date: '' }, 'Choose the date of the expense.'],
    ['a date that does not exist', { claim_date: '2026-02-31' }, 'Choose a real date.'],
    ['a date before 2000', { claim_date: '1999-12-31' }, 'The date cannot be before the year 2000.'],
    ['a date in the future', { claim_date: '2026-10-12' }, 'The date cannot be in the future.'],
    ['a description over 500 characters', { description: 'x'.repeat(501) }, 'Keep the description to 500 characters.'],
  ])('says what is wrong with %s', (_name, over, error) => {
    expect(toClaimInput({ ...filled, ...over }, TODAY)).toEqual({ ok: false, error });
  });
});
