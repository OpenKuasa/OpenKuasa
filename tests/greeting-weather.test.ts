import { describe, expect, it } from 'vitest';
import { conditionFromWmo, isHot, weatherPhrase } from '@/lib/greeting/weather';

const mon = { window: 'pagi' as const, weekday: 'Monday' };

describe('conditionFromWmo', () => {
  it('maps WMO codes', () => {
    expect(conditionFromWmo(61)).toBe('rain');
    expect(conditionFromWmo(95)).toBe('storm');
    expect(conditionFromWmo(48)).toBe('haze');
    expect(conditionFromWmo(0)).toBe('clear');
    expect(conditionFromWmo(3)).toBe('cloudy');
    expect(conditionFromWmo(999)).toBe('cloudy');
  });
});

describe('isHot', () => {
  it('is hot at 33C and above', () => {
    expect(isHot(33)).toBe(true);
    expect(isHot(30)).toBe(false);
  });
});

describe('weatherPhrase', () => {
  it('names weekday, place and umbrella for rain', () => {
    const p = weatherPhrase({ condition: 'rain', hot: false, place: 'Shah Alam' }, mon);
    expect(p).toContain('Monday');
    expect(p).toContain('Shah Alam');
    expect(p).toContain('☔');
  });
  it('omits place when null', () => {
    const p = weatherPhrase({ condition: 'rain', hot: false, place: null }, mon);
    expect(p).not.toBeNull();
    expect(p).not.toContain(' in ');
  });
  it('returns null for mild clear', () => {
    expect(weatherPhrase({ condition: 'clear', hot: false, place: 'KL' }, mon)).toBeNull();
  });
  it('hot overrides mild cloudy', () => {
    const p = weatherPhrase(
      { condition: 'cloudy', hot: true, place: 'Kuching' },
      { window: 'petang', weekday: 'Friday' },
    );
    expect(p).toContain('Kuching');
    expect(p).toContain('☀️');
    expect(p).toContain('evening');
  });
  it('storm and haze shapes', () => {
    expect(weatherPhrase({ condition: 'storm', hot: false, place: null }, mon)).toBe('Stormy Monday ⛈️');
    expect(weatherPhrase({ condition: 'haze', hot: false, place: null }, mon)).toBe('Hazy morning 🌫️');
  });
});
