import { describe, expect, it } from 'vitest';
import { blank, hhmm } from '@/lib/people/loose-input';

describe('hhmm', () => {
  it('reads one-digit hours and seconds as HH:MM', () => {
    expect(hhmm('9:00')).toBe('09:00');
    expect(hhmm('09:00')).toBe('09:00');
    expect(hhmm('09:00:00')).toBe('09:00');
    expect(hhmm(' 18:30:15 ')).toBe('18:30');
  });
  it('reads nothing, spaces and non-times as none', () => {
    for (const v of ['', '   ', null, undefined, 5, 'abc', '24:00', '9:7']) expect(hhmm(v)).toBeNull();
  });
});

describe('blank', () => {
  it('trims, and reads empty and whitespace as none', () => {
    expect(blank('  x ')).toBe('x');
    for (const v of ['', '  ', null, undefined, 3]) expect(blank(v)).toBeNull();
  });
});
