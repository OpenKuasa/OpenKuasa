// tests/hire-interview-time.test.ts
import { describe, expect, it } from 'vitest';
import {
  MAX_AHEAD_DAYS, MAX_BACK_DAYS, PAST_TOLERANCE_MS, ZONE_LABEL, clock12, durationText, instantMs, isRealDate, klDateOf, klInstant,
  klTimeOf, klTodayWords, longDate, pastProblem, shortWhen, timeProblem, timeRange,
} from '@/lib/hire/interview-time';

const MINUTE = 60_000;
const DAY = 86_400_000;
const NOW = new Date('2026-10-12T02:15:00Z'); // 10:15 on Monday 12 October in Kuala Lumpur

/** Runs `run` with the process in another time zone, and puts the zone back whatever happens. */
function inZone<T>(zone: string, run: () => T): T {
  const before = process.env.TZ;
  process.env.TZ = zone;
  try {
    return run();
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
}
/** Each zone with the minutes it is behind UTC on 20 October 2026: the proof that the switch took hold. */
const ZONES = [['UTC', 0], ['America/New_York', 240], ['Asia/Tokyo', -540]] as const;

describe('klInstant', () => {
  it('joins a Kuala Lumpur date and time with +08:00', () => {
    expect(klInstant('2026-10-20', '15:00')).toBe('2026-10-20T15:00:00+08:00');
    expect(Date.parse(klInstant('2026-10-20', '15:00')!)).toBe(Date.UTC(2026, 9, 20, 7, 0));
  });
  it('is right at both ends of a day', () => {
    // Midnight in Kuala Lumpur is 16:00 the day before in UTC.
    expect(klInstant('2026-10-20', '00:00')).toBe('2026-10-20T00:00:00+08:00');
    expect(Date.parse(klInstant('2026-10-20', '00:00')!)).toBe(Date.UTC(2026, 9, 19, 16, 0));
    expect(klInstant('2026-10-20', '23:59')).toBe('2026-10-20T23:59:00+08:00');
    expect(Date.parse(klInstant('2026-10-20', '23:59')!)).toBe(Date.UTC(2026, 9, 20, 15, 59));
  });
  it('takes 29 February in a leap year and not in another', () => {
    expect(klInstant('2028-02-29', '09:30')).toBe('2028-02-29T09:30:00+08:00');
    expect(Date.parse(klInstant('2028-02-29', '09:30')!)).toBe(Date.UTC(2028, 1, 29, 1, 30));
    expect(klInstant('2026-02-29', '09:30')).toBeNull();
  });
  it('answers null for a day that does not exist and for a time that is not HH:MM from 00:00 to 23:59', () => {
    for (const date of ['2026-02-31', '2026-13-01', '2026-00-10', '2026-10-32', '2026-1-5', '20-10-2026', 'tomorrow', '']) {
      expect(klInstant(date, '15:00'), date).toBeNull();
    }
    for (const time of ['24:00', '9:5', '9:05', '15:60', '15:00:00', '3pm', '15.00', ' 15:00', '']) {
      expect(klInstant('2026-10-20', time), time).toBeNull();
    }
    expect(klInstant(undefined as never, '15:00')).toBeNull();
    expect(klInstant('2026-10-20', 1500 as never)).toBeNull();
  });
  it('is the same instant whatever zone the process is in', () => {
    for (const [zone, behind] of ZONES) {
      inZone(zone, () => {
        // The zone really changed: a test that could not switch it would prove nothing.
        expect(new Date('2026-10-20T07:00:00Z').getTimezoneOffset(), zone).toBe(behind);
        expect(klInstant('2026-10-20', '15:00'), zone).toBe('2026-10-20T15:00:00+08:00');
        expect(Date.parse(klInstant('2026-10-20', '15:00')!), zone).toBe(Date.UTC(2026, 9, 20, 7, 0));
        expect(Date.parse(klInstant('2026-10-20', '00:00')!), zone).toBe(Date.UTC(2026, 9, 19, 16, 0));
        expect(Date.parse(klInstant('2026-10-20', '23:59')!), zone).toBe(Date.UTC(2026, 9, 20, 15, 59));
        expect(klInstant('2026-02-29', '09:30'), zone).toBeNull();
      });
    }
  });
});

describe('klDateOf and klTimeOf', () => {
  it('give the Kuala Lumpur date and time of an instant', () => {
    expect([klDateOf('2026-10-20T07:00:00Z'), klTimeOf('2026-10-20T07:00:00Z')]).toEqual(['2026-10-20', '15:00']);
    // One minute before and at midnight in Kuala Lumpur.
    expect([klDateOf('2026-10-19T15:59:00Z'), klTimeOf('2026-10-19T15:59:00Z')]).toEqual(['2026-10-19', '23:59']);
    expect([klDateOf('2026-10-19T16:00:00Z'), klTimeOf('2026-10-19T16:00:00Z')]).toEqual(['2026-10-20', '00:00']);
    // The year turns eight hours early.
    expect(klDateOf('2026-12-31T16:00:00Z')).toBe('2027-01-01');
    // As the database writes an instant.
    expect([klDateOf('2026-10-20T07:00:00+00:00'), klTimeOf('2026-10-20T07:00:00+00:00')]).toEqual(['2026-10-20', '15:00']);
  });
  it('invert klInstant, in every zone', () => {
    const pairs = [['2026-10-20', '15:00'], ['2026-10-20', '00:00'], ['2026-10-20', '23:59'], ['2028-02-29', '09:30'], ['2026-01-01', '00:05'], ['2026-12-31', '23:30']];
    for (const [zone] of ZONES) {
      inZone(zone, () => {
        for (const [date, time] of pairs) {
          const iso = klInstant(date, time)!;
          expect([klDateOf(iso), klTimeOf(iso)], `${zone} ${date} ${time}`).toEqual([date, time]);
        }
      });
    }
  });
  it('give nothing for text that is not an instant', () => {
    expect([klDateOf('next Tuesday'), klTimeOf('next Tuesday')]).toEqual(['', '']);
  });
});

describe('isRealDate', () => {
  it('knows which days exist', () => {
    for (const real of ['2026-10-31', '2028-02-29', '2026-01-01', '2026-12-31']) expect(isRealDate(real), real).toBe(true);
    for (const not of ['2026-02-31', '2026-02-29', '2026-13-01', '2026-04-31', 'nonsense', '']) expect(isRealDate(not), not).toBe(false);
  });
});

describe('timeProblem', () => {
  const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
  it('lets a time up to five minutes ago through, and refuses an older one', () => {
    expect(PAST_TOLERANCE_MS).toBe(300_000);
    expect(timeProblem(at(-4 * MINUTE), NOW)).toBeNull();
    expect(timeProblem(at(-5 * MINUTE), NOW)).toBeNull();
    expect(timeProblem(at(-6 * MINUTE), NOW)).toBe('in_past');
    expect(timeProblem(at(0), NOW)).toBeNull();
  });
  it('lets a time up to 366 days ahead through, and refuses a later one', () => {
    expect(MAX_AHEAD_DAYS).toBe(366);
    expect(timeProblem(at(366 * DAY), NOW)).toBeNull();
    expect(timeProblem(at(367 * DAY), NOW)).toBe('too_far_ahead');
  });
  it('reads the instant with its offset', () => {
    // 10:12 in Kuala Lumpur is three minutes before NOW; 10:00 is fifteen.
    expect(timeProblem(klInstant('2026-10-12', '10:12')!, NOW)).toBeNull();
    expect(timeProblem(klInstant('2026-10-12', '10:00')!, NOW)).toBe('in_past');
  });
  it('refuses text that is not an instant', () => {
    expect(timeProblem('next Tuesday', NOW)).toBe('in_past');
  });
});

describe('pastProblem', () => {
  const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
  it('refuses a start that is still ahead, and takes one that is now or earlier', () => {
    expect(pastProblem(at(MINUTE), NOW)).toBe('not_past');
    expect(pastProblem(at(0), NOW)).toBeNull();
    expect(pastProblem(at(-MINUTE), NOW)).toBeNull();
  });
  it('takes a start up to 366 days back, and refuses an older one', () => {
    expect(MAX_BACK_DAYS).toBe(366);
    expect(pastProblem(at(-365 * DAY), NOW)).toBeNull();
    expect(pastProblem(at(-366 * DAY), NOW)).toBeNull();
    expect(pastProblem(at(-367 * DAY), NOW)).toBe('too_far_back');
  });
  it('refuses text that is not an instant', () => {
    expect(pastProblem('last week', NOW)).toBe('not_past');
  });
});

describe('dates and times in words', () => {
  it('writes the date in full with the weekday, and the day without a leading zero', () => {
    expect(longDate('2026-10-20T07:00:00Z')).toBe('Tuesday, 20 October 2026');
    expect(longDate('2026-10-06T07:00:00Z')).toBe('Tuesday, 6 October 2026');
    expect(longDate('2026-10-22T03:00:00Z')).toBe('Thursday, 22 October 2026');
    expect(longDate(klInstant('2028-02-29', '09:30')!)).toBe('Tuesday, 29 February 2028');
    // 00:30 on New Year's Day in Kuala Lumpur is still 31 December in UTC.
    expect(longDate('2026-12-31T16:30:00Z')).toBe('Friday, 1 January 2027');
  });
  it('writes the short form with the time', () => {
    expect(shortWhen('2026-10-20T07:00:00Z')).toBe('Tue 20 Oct 2026, 3:00 pm');
    expect(shortWhen('2026-10-06T07:00:00Z')).toBe('Tue 6 Oct 2026, 3:00 pm');
    expect(shortWhen('2026-10-19T16:00:00Z')).toBe('Tue 20 Oct 2026, 12:00 am');
  });
  it('writes a time on the 12-hour clock', () => {
    expect(clock12(klInstant('2026-10-20', '00:05')!)).toBe('12:05 am');
    expect(clock12(klInstant('2026-10-20', '12:00')!)).toBe('12:00 pm');
    expect(clock12(klInstant('2026-10-20', '15:00')!)).toBe('3:00 pm');
    expect(clock12(klInstant('2026-10-20', '09:30')!)).toBe('9:30 am');
    expect(clock12(klInstant('2026-10-20', '23:59')!)).toBe('11:59 pm');
  });
  it('writes a range, and says when it ends the next day', () => {
    expect(timeRange(klInstant('2026-10-20', '15:00')!, 60)).toBe('3:00 pm to 4:00 pm');
    expect(timeRange(klInstant('2026-10-20', '11:00')!, 60)).toBe('11:00 am to 12:00 pm');
    expect(timeRange(klInstant('2026-10-20', '09:00')!, 480)).toBe('9:00 am to 5:00 pm');
    expect(timeRange(klInstant('2026-10-20', '00:00')!, 45)).toBe('12:00 am to 12:45 am');
    expect(timeRange(klInstant('2026-10-20', '23:30')!, 60)).toBe('11:30 pm to 12:30 am the next day');
    expect(timeRange(klInstant('2026-10-20', '23:00')!, 60)).toBe('11:00 pm to 12:00 am the next day');
    expect(timeRange(klInstant('2026-10-20', '23:00')!, 45)).toBe('11:00 pm to 11:45 pm');
  });
  it('writes a length', () => {
    expect([15, 45, 60, 75, 90, 120].map(durationText)).toEqual(['15 minutes', '45 minutes', '1 hour', '1 hour 15 minutes', '1 hour 30 minutes', '2 hours']);
    expect([30, 180, 240, 480, 61].map(durationText)).toEqual(['30 minutes', '3 hours', '4 hours', '8 hours', '1 hour 1 minute']);
  });
  it('says today for the model, with the weekday and the time', () => {
    expect(klTodayWords(NOW)).toBe('Monday, 2026-10-12, and the time there is 10:15');
    // 00:30 on Tuesday in Kuala Lumpur, still Monday in UTC.
    expect(klTodayWords(new Date('2026-10-12T16:30:00Z'))).toBe('Tuesday, 2026-10-13, and the time there is 00:30');
  });
  it('names the zone one way', () => {
    expect(ZONE_LABEL).toBe('Kuala Lumpur time (GMT+8)');
  });
  it('reads the same in every zone', () => {
    const iso = klInstant('2026-10-20', '23:30')!;
    for (const [zone] of ZONES) {
      inZone(zone, () => {
        expect(longDate(iso), zone).toBe('Tuesday, 20 October 2026');
        expect(shortWhen(iso), zone).toBe('Tue 20 Oct 2026, 11:30 pm');
        expect(clock12(iso), zone).toBe('11:30 pm');
        expect(timeRange(iso, 60), zone).toBe('11:30 pm to 12:30 am the next day');
        expect(klTodayWords(NOW), zone).toBe('Monday, 2026-10-12, and the time there is 10:15');
      });
    }
  });
  it('shows text that is not an instant as it was given', () => {
    expect(longDate('next Tuesday')).toBe('next Tuesday');
    expect(shortWhen('next Tuesday')).toBe('next Tuesday');
    expect(clock12('3pm')).toBe('3pm');
    expect(timeRange('3pm', 60)).toBe('3pm');
  });
});

// ─── boundaries beyond the plan's own tests ──────────────────────────────────

describe('more boundaries', () => {
  it('knows the century rule for 29 February', () => {
    expect(isRealDate('2000-02-29')).toBe(true);
    expect(isRealDate('2100-02-29')).toBe(false);
    expect(klInstant('2100-02-29', '09:00')).toBeNull();
  });
  it('takes no space around a date or a time', () => {
    for (const [date, time] of [['2026-10-20', '15:00 '], ['2026-10-20 ', '15:00'], [' 2026-10-20', '15:00'], ['2026-10-20', '15:00\n']]) {
      expect(klInstant(date, time), JSON.stringify([date, time])).toBeNull();
    }
  });
  it('is right on both sides of a year, and of 29 February', () => {
    expect(Date.parse(klInstant('2026-12-31', '23:59')!)).toBe(Date.UTC(2026, 11, 31, 15, 59));
    expect(Date.parse(klInstant('2027-01-01', '00:00')!)).toBe(Date.UTC(2026, 11, 31, 16, 0));
    expect(Date.parse(klInstant('2028-02-29', '00:00')!)).toBe(Date.UTC(2028, 1, 28, 16, 0));
    expect(Date.parse(klInstant('2028-02-29', '23:59')!)).toBe(Date.UTC(2028, 1, 29, 15, 59));
    expect(longDate(klInstant('2028-02-28', '23:59')!)).toBe('Monday, 28 February 2028');
    expect(longDate(klInstant('2028-02-29', '00:00')!)).toBe('Tuesday, 29 February 2028');
    expect(longDate(klInstant('2028-02-29', '23:59')!)).toBe('Tuesday, 29 February 2028');
    expect(longDate(klInstant('2028-03-01', '00:00')!)).toBe('Wednesday, 1 March 2028');
    expect(shortWhen(klInstant('2026-12-31', '23:59')!)).toBe('Thu 31 Dec 2026, 11:59 pm');
    expect(shortWhen(klInstant('2027-01-01', '00:00')!)).toBe('Fri 1 Jan 2027, 12:00 am');
    expect(klTodayWords(new Date('2026-12-31T16:00:00Z'))).toBe('Friday, 2027-01-01, and the time there is 00:00');
    expect(klTodayWords(new Date('2026-12-31T15:59:59.999Z'))).toBe('Thursday, 2026-12-31, and the time there is 23:59');
  });
  it('reads an instant with the database\'s six decimal places, and never rounds a minute up', () => {
    const iso = '2026-10-19T15:59:59.999999+00:00';
    expect([klDateOf(iso), klTimeOf(iso)]).toEqual(['2026-10-19', '23:59']);
    expect(shortWhen(iso)).toBe('Mon 19 Oct 2026, 11:59 pm');
  });
  it('says the next day for a long interview that runs past midnight, and across a year', () => {
    expect(timeRange(klInstant('2026-10-20', '23:30')!, 480)).toBe('11:30 pm to 7:30 am the next day');
    expect(timeRange(klInstant('2026-10-20', '16:00')!, 480)).toBe('4:00 pm to 12:00 am the next day');
    expect(timeRange(klInstant('2026-10-20', '15:59')!, 480)).toBe('3:59 pm to 11:59 pm');
    expect(timeRange(klInstant('2026-12-31', '23:30')!, 60)).toBe('11:30 pm to 12:30 am the next day');
  });
  it('holds the two limits to the millisecond', () => {
    const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
    expect(timeProblem(at(-PAST_TOLERANCE_MS - 1), NOW)).toBe('in_past');
    expect(timeProblem(at(366 * DAY + 1), NOW)).toBe('too_far_ahead');
    expect(pastProblem(at(1), NOW)).toBe('not_past');
    expect(pastProblem(at(-366 * DAY - 1), NOW)).toBe('too_far_back');
  });
  it('does not take text with no zone as an instant, in any zone: the machine\'s own zone would decide what it means', () => {
    const zoneless = ['2026-10-20T15:00:00', '2026-10-20T15:00', '2026-10-20 15:00:00', '2026-10-20', 'Oct 20 2026 15:00', '20 October 2026'];
    for (const [zone] of ZONES) {
      inZone(zone, () => {
        for (const text of zoneless) {
          expect(Number.isNaN(instantMs(text)), `${zone} ${text}`).toBe(true);
          expect([klDateOf(text), klTimeOf(text)], `${zone} ${text}`).toEqual(['', '']);
          expect([longDate(text), shortWhen(text), clock12(text), timeRange(text, 60)], `${zone} ${text}`).toEqual([text, text, text, text]);
          expect(timeProblem(text, NOW), `${zone} ${text}`).toBe('in_past');
          expect(pastProblem(text, NOW), `${zone} ${text}`).toBe('not_past');
        }
      });
    }
  });
  it('takes an instant written with Z, with an offset, and with or without seconds and decimals', () => {
    const at = Date.UTC(2026, 9, 20, 7, 0);
    for (const text of [
      '2026-10-20T07:00:00Z', '2026-10-20T07:00:00.000Z', '2026-10-20T07:00:00+00:00', '2026-10-20T07:00:00.000000+00:00',
      '2026-10-20T15:00:00+08:00', '2026-10-20T15:00+08:00', '2026-10-20T02:00:00-05:00',
    ]) {
      expect(instantMs(text), text).toBe(at);
    }
    expect(Number.isNaN(instantMs(undefined as never))).toBe(true);
    expect(Number.isNaN(instantMs(1_792_479_600_000 as never))).toBe(true);
  });
  it('does not take a day or a time of day that does not exist and read it as a later one, in any zone', () => {
    // Each of these has the shape of an instant. `Date.parse` alone reads 30 February as 2 March and 24:00 as the next day.
    const impossible = [
      '2026-02-30T10:00:00Z', '2026-02-29T10:00:00+08:00', '2026-02-31T10:00:00+08:00', '2026-04-31T10:00:00Z', '2100-02-29T10:00:00Z',
      '2026-13-01T10:00:00Z', '2026-00-10T10:00:00Z', '2026-10-00T10:00:00Z', '2026-10-32T10:00:00Z',
      '2026-10-20T24:00:00Z', '2026-10-20T24:00:00+08:00', '2026-10-20T25:00:00Z', '2026-10-20T10:60:00Z', '2026-10-20T10:00:60Z', '2026-10-20T10:00:61.5Z',
      '2026-10-20T10:00:00+24:00', '2026-10-20T10:00:00+08:60', '2026-10-20T10:00:00-99:00',
    ];
    for (const [zone] of ZONES) {
      inZone(zone, () => {
        for (const text of impossible) {
          expect(Number.isNaN(instantMs(text)), `${zone} ${text}`).toBe(true);
          expect([klDateOf(text), klTimeOf(text), longDate(text), shortWhen(text), clock12(text), timeRange(text, 60)], `${zone} ${text}`)
            .toEqual(['', '', text, text, text, text]);
          expect(timeProblem(text, NOW), `${zone} ${text}`).toBe('in_past');
          expect(pastProblem(text, NOW), `${zone} ${text}`).toBe('not_past');
        }
      });
    }
  });
  it('still takes every real day and time at its edges', () => {
    expect(instantMs('2028-02-29T23:59:59.999999+08:00')).toBe(Date.UTC(2028, 1, 29, 15, 59, 59, 999));
    expect(instantMs('2000-02-29T00:00:00Z')).toBe(Date.UTC(2000, 1, 29));
    expect(instantMs('2026-12-31T23:59:59Z')).toBe(Date.UTC(2026, 11, 31, 23, 59, 59));
    expect(instantMs('2026-10-20T00:00:00+14:00')).toBe(Date.UTC(2026, 9, 19, 10, 0));
    expect(instantMs('2026-10-20T00:00:00-12:00')).toBe(Date.UTC(2026, 9, 20, 12, 0));
    expect(instantMs('2026-10-20T23:59:00+05:45')).toBe(Date.UTC(2026, 9, 20, 18, 14));
    // The day is judged as it is written, in the text's own zone: 31 October written with +08:00 is real.
    expect(instantMs('2026-10-31T23:30:00+08:00')).toBe(Date.UTC(2026, 9, 31, 15, 30));
  });
});
