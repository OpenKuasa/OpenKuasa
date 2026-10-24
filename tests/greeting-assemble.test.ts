import { describe, expect, it } from 'vitest';
import { assembleServerGreeting, composeHeading } from '@/lib/greeting/assemble';
import { idleLineCount } from '@/lib/greeting/idle';

const base = {
  surface: 'people' as const,
  role: 'owner' as const,
  userId: 'u1',
  isDemo: false,
  counts: {},
};
// 2026-10-24 (not a festival) at 10:00 / 02:00 Malaysia time.
const MORNING = new Date('2026-10-24T02:00:00Z');
const LATE = new Date('2026-10-23T18:00:00Z');
// 2026-12-25 02:00 Malaysia time (Christmas, late night).
const XMAS_LATE = new Date('2026-12-24T18:00:00Z');

describe('composeHeading', () => {
  it('joins lead, name and emoji', () => {
    expect(
      composeHeading({ lead: 'Selamat pagi', firstName: 'Aisyah', emoji: '☀️', weatherPhrase: null }),
    ).toBe('Selamat pagi, Aisyah ☀️');
  });

  it('handles the late-night question lead', () => {
    expect(
      composeHeading({ lead: 'Still at it?', firstName: 'Aisyah', emoji: '🌙', weatherPhrase: null }),
    ).toBe('Still at it, Aisyah? 🌙');
    expect(
      composeHeading({ lead: 'Still at it?', firstName: null, emoji: '🌙', weatherPhrase: null }),
    ).toBe('Still at it? 🌙');
  });

  it('has no comma without a name', () => {
    const out = composeHeading({
      lead: 'Selamat petang',
      firstName: null,
      emoji: '🌇',
      weatherPhrase: null,
    });
    expect(out).toBe('Selamat petang 🌇');
    expect(out).not.toContain(',');
  });

  it('uses the weather phrase instead of the emoji', () => {
    const out = composeHeading({
      lead: 'Selamat pagi',
      firstName: 'Aisyah',
      emoji: '☀️',
      weatherPhrase: 'Looks sunny today 🌤️',
    });
    expect(out).toBe('Selamat pagi, Aisyah. Looks sunny today 🌤️');
    expect(out).not.toContain('☀️');
  });

  it('drops the weather phrase when too long and keeps the emoji', () => {
    const out = composeHeading({
      lead: 'Selamat pagi',
      firstName: 'Aisyah',
      emoji: '☀️',
      weatherPhrase: 'It is a very long and rather elaborate forecast for the whole day ahead 🌤️',
    });
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out.endsWith('☀️')).toBe(true);
    expect(out).not.toContain('forecast');
  });

  it('drops the emoji when still too long, never the lead or name', () => {
    const name = 'A'.repeat(58);
    const out = composeHeading({
      lead: 'Selamat tengah hari',
      firstName: name,
      emoji: '☀️',
      weatherPhrase: 'Hot out there 🥵',
    });
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out).toBe(`Selamat tengah hari, ${name}`);
  });
});

describe('assembleServerGreeting', () => {
  it('uses the time-of-day lead on a normal day', () => {
    const out = assembleServerGreeting({ ...base, now: MORNING });
    expect(out.lead).toBe('Selamat pagi');
    expect(out.isFestive).toBe(false);
  });

  it('uses "Still at it?" at 02:00 on a non-festive day', () => {
    const out = assembleServerGreeting({ ...base, now: LATE });
    expect(out.lead).toBe('Still at it?');
    expect(out.emoji).toBe('🌙');
  });

  it('prefers the festive lead over time of day and late night', () => {
    const out = assembleServerGreeting({ ...base, now: XMAS_LATE });
    expect(out.isFestive).toBe(true);
    expect(out.lead).toBe('Merry Christmas');
    expect(out.emoji).toBe('🎄');
  });

  it('uses a workspace holiday', () => {
    const out = assembleServerGreeting({
      ...base,
      now: MORNING,
      workspaceHolidays: [{ date: '2026-10-24', name: 'Hari Ulang Tahun' }],
    });
    expect(out.isFestive).toBe(true);
    expect(out.lead).toBe('Selamat Hari Ulang Tahun');
  });

  it('uses the nudge when one qualifies', () => {
    const out = assembleServerGreeting({ ...base, now: MORNING, counts: { hrApprovals: 3 } });
    expect(out.secondHalf).toBe('3 approvals are waiting for you.');
    expect(out.secondHalfQuestion).toBe('Show me the approvals waiting for me');
  });

  it('uses the top nudge on the tuah surface', () => {
    const out = assembleServerGreeting({
      ...base,
      surface: 'tuah',
      now: MORNING,
      counts: { newLeads: 2 },
    });
    expect(out.secondHalf).toBe('2 new leads since this week.');
  });

  it('ignores nudges for the demo and returns an idle line', () => {
    const out = assembleServerGreeting({
      ...base,
      isDemo: true,
      now: MORNING,
      counts: { hrApprovals: 3 },
    });
    expect(out.secondHalf).not.toContain('approval');
    expect(out.secondHalfQuestion).toBe(out.secondHalf);
    expect(idleLineCount('people')).toBeGreaterThan(0);
  });

  it('falls back to an idle line when no nudge qualifies', () => {
    const out = assembleServerGreeting({ ...base, now: MORNING, counts: { hrApprovals: 0 } });
    expect(out.secondHalf.length).toBeGreaterThan(0);
    expect(out.secondHalfQuestion).toBe(out.secondHalf);
  });
});
