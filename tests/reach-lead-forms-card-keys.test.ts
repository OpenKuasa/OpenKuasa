import { describe, expect, it } from 'vitest';
import { formCardKey, submissionsCardKey } from '@/components/reach/lead-forms-view';

/**
 * The form editor and the Submissions card sit side by side in one grid, and
 * both can be open for the same form. Keyed by the bare form id, React saw two
 * children with one key and could drop or swap a card.
 */
describe('the Lead Forms cards have their own keys', () => {
  const id = 'dd6ffaa5-1079-47f1-8b19-2d13b66e2f78';

  it('differ when the editor and the submissions are open for the same form', () => {
    expect(formCardKey({ id })).not.toBe(submissionsCardKey({ id }));
  });

  it('still start a fresh card for another form or a new one', () => {
    expect(formCardKey({ id })).not.toBe(formCardKey({ id: 'another' }));
    expect(formCardKey(null)).not.toBe(formCardKey({ id }));
    expect(submissionsCardKey({ id })).not.toBe(submissionsCardKey({ id: 'another' }));
  });
});
