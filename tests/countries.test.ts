import { describe, expect, it } from 'vitest';
import { COUNTRIES } from '@/config/countries';

describe('COUNTRIES', () => {
  it('puts Malaysia first, once, and keeps the rest A to Z', () => {
    expect(COUNTRIES[0]).toBe('Malaysia');
    expect(COUNTRIES.filter((c) => c === 'Malaysia')).toHaveLength(1);
    const rest = COUNTRIES.slice(1);
    expect(rest).toEqual([...rest].sort((a, b) => a.localeCompare(b)));
  });
});
