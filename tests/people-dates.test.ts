import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  clockTime,
  daysBetween,
  formatDate,
  formatDay,
  hoursBetween,
  hoursBetweenTimes,
  isRealDate,
  isWeekday,
  malaysiaDate,
  monthLabel,
  monthStart,
  monthYearLabel,
  relativeTime,
  todayInMalaysia,
  weekdayName,
  weekStart,
} from '@/lib/people/dates';

describe('people dates', () => {
  it('takes today from the clock in Malaysia, not UTC', () => {
    // 17:30 UTC on the 9th is 01:30 on the 10th in Kuala Lumpur.
    expect(todayInMalaysia(new Date('2026-10-09T17:30:00Z'))).toBe('2026-10-10');
    expect(todayInMalaysia(new Date('2026-10-09T15:59:00Z'))).toBe('2026-10-09');
  });

  it('adds and subtracts days across month and year ends', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(daysBetween('2026-10-01', '2026-10-10')).toBe(9);
    expect(daysBetween('2026-10-10', '2026-10-01')).toBe(-9);
  });

  it('finds the first of the month and steps by whole months', () => {
    expect(monthStart('2026-10-10')).toBe('2026-10-01');
    expect(addMonths('2026-10-01', -7)).toBe('2026-03-01');
    expect(addMonths('2026-01-01', -1)).toBe('2025-12-01');
    expect(addMonths('2026-12-01', 1)).toBe('2027-01-01');
  });

  it('starts the week on Monday and knows a weekday from a weekend', () => {
    expect(weekStart('2026-10-10')).toBe('2026-10-05'); // a Saturday
    expect(weekStart('2026-10-05')).toBe('2026-10-05'); // a Monday
    expect(weekStart('2026-10-11')).toBe('2026-10-05'); // a Sunday
    expect(isWeekday('2026-10-09')).toBe(true);
    expect(isWeekday('2026-10-10')).toBe(false);
    expect(isWeekday('2026-10-11')).toBe(false);
  });

  it('labels a day and a month the same way on any machine', () => {
    expect(formatDay('2026-10-09')).toBe('09 Oct');
    expect(formatDay('2026-01-31')).toBe('31 Jan');
    expect(monthLabel('2026-03-01')).toBe('Mar');
  });

  it('takes today from the clock in Malaysia without locale data', () => {
    expect(todayInMalaysia(new Date('2026-10-10T16:30:00Z'))).toBe('2026-10-11');
    expect(todayInMalaysia(new Date('2026-10-10T15:59:59Z'))).toBe('2026-10-10');
    expect(malaysiaDate('2026-10-10T16:30:00Z')).toBe('2026-10-11');
    expect(malaysiaDate('2026-10-10T15:59:59Z')).toBe('2026-10-10');
  });

  it('formats dates by hand', () => {
    expect(formatDate('2026-10-09')).toBe('09 Oct 2026');
    expect(monthYearLabel('2026-10-09')).toBe('October 2026');
    expect(weekdayName('2026-10-09')).toBe('Friday');
    expect(weekdayName('2026-10-11')).toBe('Sunday');
  });

  it('reads a clock time on the Malaysian clock', () => {
    expect(clockTime('2026-10-09T00:59:00Z')).toBe('08:59');
    expect(clockTime('2026-10-09T16:05:00Z')).toBe('00:05');
  });

  it('measures hours between instants and between times', () => {
    expect(hoursBetween('2026-10-09T01:00:00Z', '2026-10-09T09:06:00Z')).toBe(8.1);
    expect(hoursBetween('2026-10-09T09:00:00Z', '2026-10-09T01:00:00Z')).toBe(0);
    expect(hoursBetween('2026-10-09T01:00:00Z', '2026-10-09T01:00:00Z')).toBe(0);
    expect(hoursBetweenTimes('14:00:00', '15:30')).toBe(1.5);
    expect(hoursBetweenTimes('09:00', '10:20:00')).toBe(1.33);
    expect(hoursBetweenTimes('15:00', '14:00')).toBe(0);
  });

  it('does not throw on an unparseable instant', () => {
    const now = new Date('2026-10-09T04:00:00Z');
    expect(clockTime('not a time')).toBe('—');
    expect(malaysiaDate('not a time')).toBe('');
    expect(relativeTime('not a time', now)).toBe('—');
    expect(hoursBetween('not a time', '2026-10-09T01:00:00Z')).toBe(0);
    expect(hoursBetween('2026-10-09T01:00:00Z', 'nope')).toBe(0);
  });

  it('says how long ago something happened', () => {
    const now = new Date('2026-10-09T04:00:00Z');
    const before = (seconds: number) => new Date(now.getTime() - seconds * 1000).toISOString();
    expect(relativeTime(before(30), now)).toBe('just now');
    expect(relativeTime(before(5 * 60), now)).toBe('5 minutes ago');
    expect(relativeTime(before(60), now)).toBe('1 minute ago');
    expect(relativeTime(before(2 * 3600), now)).toBe('2 hours ago');
    expect(relativeTime(before(86_400), now)).toBe('yesterday');
    expect(relativeTime(before(3 * 86_400), now)).toBe('3 days ago');
    expect(relativeTime(before(15 * 86_400), now)).toBe('2 weeks ago');
    expect(relativeTime(before(60 * 86_400), now)).toBe('10 Aug 2026');
    expect(relativeTime(before(-60), now)).toBe('just now');
  });
});

describe('isRealDate', () => {
  it('accepts a date that exists, including 29 February in a leap year', () => {
    expect(isRealDate('2026-10-11')).toBe(true);
    expect(isRealDate('2028-02-29')).toBe(true);
  });
  it('refuses a date that matches the pattern but does not exist', () => {
    expect(isRealDate('2026-02-31')).toBe(false);
    expect(isRealDate('2027-02-29')).toBe(false);
    expect(isRealDate('2026-13-01')).toBe(false);
  });
  it('refuses anything not shaped YYYY-MM-DD', () => {
    for (const value of ['', '2026-1-1', '26-10-11', '2026-10-11T00:00:00Z', 'tomorrow']) {
      expect(isRealDate(value)).toBe(false);
    }
  });
});
