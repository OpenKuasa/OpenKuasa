import { describe, expect, it } from 'vitest';
import { idleLineCount, pickIdle, type IdleCtx } from '@/lib/greeting/idle';
import type { Surface } from '@/lib/greeting/types';

const SURFACES: Surface[] = ['tuah', 'crm', 'people', 'hire', 'finance', 'reach'];
const DEEPAVALI = { key: 'deepavali', wish: 'Happy Deepavali', emoji: '🪔', major: true };

const base: IdleCtx = {
  surface: 'tuah',
  userId: 'user-1',
  date: '2026-10-21',
  window: 'pagi',
  isWeekend: false,
  isFriday: false,
  festiveWeek: null,
};

describe('idle greeting lines', () => {
  it.each(SURFACES)('%s has at least 8 lines', (surface) => {
    expect(idleLineCount(surface)).toBeGreaterThanOrEqual(8);
  });

  it('is deterministic for the same context', () => {
    for (const surface of SURFACES) {
      const first = pickIdle({ ...base, surface });
      for (let i = 0; i < 100; i += 1) {
        expect(pickIdle({ ...base, surface })).toEqual(first);
      }
    }
  });

  it('varies with window and userId', () => {
    const windows = ['pagi', 'tengah-hari', 'petang', 'malam'] as const;
    const byWindow = new Set(windows.map((window) => pickIdle({ ...base, window }).text));
    expect(byWindow.size).toBeGreaterThan(1);
    const byUser = new Set(
      ['a', 'b', 'c', 'd', 'e', 'f'].map((userId) => pickIdle({ ...base, userId }).text),
    );
    expect(byUser.size).toBeGreaterThan(1);
  });

  it('references the holiday on a festive-week Friday or weekend', () => {
    for (const surface of SURFACES) {
      for (const flags of [{ isFriday: true }, { isWeekend: true }]) {
        for (const userId of ['a', 'b', 'c', 'd']) {
          const line = pickIdle({ ...base, surface, userId, festiveWeek: DEEPAVALI, ...flags });
          expect(line.text).toMatch(/festive|holiday/i);
        }
      }
    }
  });

  it('uses the general set when the festive week is not a Friday or weekend', () => {
    const line = pickIdle({ ...base, festiveWeek: DEEPAVALI });
    expect(line.text).not.toMatch(/festive|holiday/i);
  });

  it('always returns a non-empty question', () => {
    for (const surface of SURFACES) {
      const line = pickIdle({ ...base, surface });
      expect(line.text.length).toBeGreaterThan(0);
      expect(line.question.length).toBeGreaterThan(0);
    }
  });
});
