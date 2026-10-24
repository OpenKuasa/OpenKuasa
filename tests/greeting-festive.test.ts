import { describe, expect, it } from 'vitest';
import { festiveOn, festivalWithin } from '@/lib/greeting/festive';

describe('festiveOn', () => {
  it('returns the built-in festival on a wish day', () => {
    expect(festiveOn('2026-03-21')?.wish).toBe('Selamat Hari Raya');
  });

  it('returns null on a replacement day that is not a wish day', () => {
    expect(festiveOn('2026-03-23')).toBeNull();
  });

  it('returns null on an ordinary day', () => {
    expect(festiveOn('2026-07-01')).toBeNull();
  });

  it('uses a workspace holiday when there is no built-in match', () => {
    const festival = festiveOn('2026-07-01', [{ date: '2026-07-01', name: 'Hari Hol' }]);
    expect(festival?.key).toBe('workspace');
    expect(festival?.wish).toBe('Selamat Hari Hol');
    expect(festival?.major).toBe(false);
  });

  it('lets a built-in date beat a workspace entry on the same day', () => {
    const festival = festiveOn('2026-12-25', [{ date: '2026-12-25', name: 'Cuti Syarikat' }]);
    expect(festival?.key).toBe('christmas');
  });
});

describe('festivalWithin', () => {
  it('finds a major festival within the window', () => {
    expect(festivalWithin('2026-11-02', 7)?.key).toBe('deepavali');
  });

  it('returns null when none is within the window', () => {
    expect(festivalWithin('2026-10-20', 7)).toBeNull();
  });

  it('ignores non-major festivals', () => {
    expect(festivalWithin('2026-05-25', 7)).toBeNull();
  });

  it('includes the day itself', () => {
    expect(festivalWithin('2026-11-08', 0)?.key).toBe('deepavali');
  });
});
