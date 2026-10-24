import { describe, expect, it } from 'vitest';
import { hourInMalaysia } from '@/lib/people/dates';
import { timeOfDayPhrase } from '@/lib/greeting/time-of-day';

describe('hourInMalaysia', () => {
  it('reads the hour on the Malaysian clock (UTC+8)', () => {
    expect(hourInMalaysia(new Date('2026-10-24T01:30:00Z'))).toBe(9);
  });
});

describe('timeOfDayPhrase', () => {
  it('greets the morning from 05:00 to 11:59', () => {
    expect(timeOfDayPhrase(5).lead).toBe('Selamat pagi');
    expect(timeOfDayPhrase(11).window).toBe('pagi');
    expect(timeOfDayPhrase(5).emoji).toBe('☀️');
  });

  it('greets midday from 12:00 to 14:59', () => {
    const p = timeOfDayPhrase(12);
    expect(p.lead).toBe('Selamat tengah hari');
    expect(p.window).toBe('tengah-hari');
    expect(p.emoji).toBe('☀️');
  });

  it('greets the afternoon from 15:00 to 18:59', () => {
    expect(timeOfDayPhrase(15).lead).toBe('Selamat petang');
    expect(timeOfDayPhrase(15).emoji).toBe('🌇');
    expect(timeOfDayPhrase(18).lateNight).toBe(false);
  });

  it('greets the evening from 19:00 to 22:59', () => {
    const p = timeOfDayPhrase(19);
    expect(p.lead).toBe('Selamat malam');
    expect(p.emoji).toBe('🌙');
    expect(p.lateNight).toBe(false);
  });

  it('marks 23:00 to 04:59 as late night', () => {
    expect(timeOfDayPhrase(23).lateNight).toBe(true);
    expect(timeOfDayPhrase(0).lead).toBe('Selamat malam');
    expect(timeOfDayPhrase(4).lateNight).toBe(true);
    expect(timeOfDayPhrase(4).window).toBe('malam');
  });
});
