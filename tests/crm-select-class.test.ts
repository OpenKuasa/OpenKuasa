import { describe, expect, it } from 'vitest';
import { SELECT_CLASS } from '@/screens/crm/crm-form';

describe('SELECT_CLASS', () => {
  it('greys out and blocks a native select inside a disabled fieldset', () => {
    expect(SELECT_CLASS).toContain('disabled:opacity-50');
    expect(SELECT_CLASS).toContain('disabled:cursor-not-allowed');
  });
});
