import { describe, expect, it } from 'vitest';
import {
  canSelfEnrol,
  canSelfWithdraw,
  courseStatus,
  reviewPeriods,
  toAnnouncementInput,
  toGoalInput,
  toPeriod,
  toReviewInput,
  toScore,
  toTrainingInput,
} from '@/lib/people/performance-forms';

describe('reviewPeriods', () => {
  it('lists the current and previous two years, each as H2, H1 and FY, newest first', () => {
    expect(reviewPeriods('2026-10-12')).toEqual([
      'H2 2026', 'H1 2026', 'FY 2026',
      'H2 2025', 'H1 2025', 'FY 2025',
      'H2 2024', 'H1 2024', 'FY 2024',
    ]);
  });

  it('follows the year of the date it is given', () => {
    expect(reviewPeriods('2027-01-01')[0]).toBe('H2 2027');
    expect(reviewPeriods('2026-12-31')[0]).toBe('H2 2026');
  });
});

describe('toPeriod', () => {
  it.each([
    ['H1 2026', 'H1 2026'],
    ['h1 2026', 'H1 2026'],
    ['  H2 2026  ', 'H2 2026'],
    ['2026 H1', 'H1 2026'],
    ['2026 h2', 'H2 2026'],
    ['FY2026', 'FY 2026'],
    ['fy 2026', 'FY 2026'],
    ['2026 FY', 'FY 2026'],
    ['H12026', 'H1 2026'],
    ['FY 2000', 'FY 2000'],
    ['FY 2100', 'FY 2100'],
  ])('reads %j as %j', (text, expected) => {
    expect(toPeriod(text)).toBe(expected);
  });

  it.each(['', '   ', 'H3 2026', 'H1', '2026', 'Q1 2026', 'H1 1999', 'FY 2101', 'H1 26', 'H1 2026 extra', 'H1-2026'])(
    'refuses %j',
    (text) => {
      expect(toPeriod(text)).toBeNull();
    },
  );

  it('refuses what is not text', () => {
    expect(toPeriod(undefined as never)).toBeNull();
    expect(toPeriod(2026 as never)).toBeNull();
  });
});

describe('toScore', () => {
  it.each([
    ['1', 1], ['1.5', 1.5], ['3', 3], ['4.5', 4.5], ['5', 5], [' 4 ', 4], [1, 1], [2.5, 2.5], [5, 5],
  ])('reads %j as %j', (text, expected) => {
    expect(toScore(text)).toBe(expected);
  });

  it.each([
    '', ' ', '3,5', '5.0', '05', '1e0', '0', '0.5', '5.5', '6', '4.25', '4.', '.5', '-3', '+3', '1 5', 'four', '3.50',
  ])('refuses the text %j', (text) => {
    expect(toScore(text)).toBeNull();
  });

  it.each([0, 0.5, 5.5, 6, 4.25, -1, Number.NaN, Number.POSITIVE_INFINITY])('refuses the number %j', (n) => {
    expect(toScore(n)).toBeNull();
  });
});

describe('toGoalInput', () => {
  const ok = { title: 'Ship the thing', progress: '40', due_date: '2026-12-01', at_risk: false };

  it('converts a good form, trimming the title', () => {
    expect(toGoalInput({ ...ok, title: '  Ship the thing  ' })).toEqual({
      ok: true,
      input: { title: 'Ship the thing', progress: 40, due_date: '2026-12-01', at_risk: false },
    });
  });

  it('reads an empty due date as none and passes at_risk through', () => {
    expect(toGoalInput({ ...ok, due_date: '  ', at_risk: true })).toEqual({
      ok: true,
      input: { title: 'Ship the thing', progress: 40, due_date: null, at_risk: true },
    });
  });

  it('accepts the ends of progress and refuses beyond them', () => {
    expect(toGoalInput({ ...ok, progress: '0' })).toMatchObject({ ok: true, input: { progress: 0 } });
    expect(toGoalInput({ ...ok, progress: '100' })).toMatchObject({ ok: true, input: { progress: 100 } });
    for (const progress of ['101', '-1', '', '12.5', '1e1', 'abc', '1000']) {
      expect(toGoalInput({ ...ok, progress }), progress).toMatchObject({ ok: false });
    }
  });

  it('refuses a blank or over-long title', () => {
    expect(toGoalInput({ ...ok, title: '   ' })).toMatchObject({ ok: false });
    expect(toGoalInput({ ...ok, title: 'x'.repeat(200) })).toMatchObject({ ok: true });
    expect(toGoalInput({ ...ok, title: 'x'.repeat(201) })).toMatchObject({ ok: false });
  });

  it('refuses a date that does not exist or lies outside 2000 to 2100', () => {
    for (const due_date of ['2026-02-31', '12/01/2026', '1999-12-31', '2101-01-01', 'soon']) {
      expect(toGoalInput({ ...ok, due_date }), due_date).toMatchObject({ ok: false });
    }
    expect(toGoalInput({ ...ok, due_date: '2000-01-01' })).toMatchObject({ ok: true });
    expect(toGoalInput({ ...ok, due_date: '2100-12-31' })).toMatchObject({ ok: true });
  });
});

describe('toReviewInput', () => {
  const ok = {
    period: 'h1 2026',
    competencies: { Delivery: '4', Teamwork: '3.5', Ownership: 5, Communication: '2' },
    rating: 'meets',
    comment: '  Solid half.  ',
  };

  it('converts a good form', () => {
    expect(toReviewInput(ok)).toEqual({
      ok: true,
      input: {
        period: 'H1 2026',
        competencies: { Delivery: 4, Teamwork: 3.5, Ownership: 5, Communication: 2 },
        rating: 'meets',
        comment: 'Solid half.',
      },
    });
  });

  it('reads a blank comment as none', () => {
    expect(toReviewInput({ ...ok, comment: '   ' })).toMatchObject({ ok: true, input: { comment: null } });
  });

  it('refuses an unreadable period, a bad rating and a comment over 2,000 characters', () => {
    expect(toReviewInput({ ...ok, period: 'sometime' })).toMatchObject({ ok: false });
    expect(toReviewInput({ ...ok, rating: 'great' })).toMatchObject({ ok: false });
    expect(toReviewInput({ ...ok, rating: '' })).toMatchObject({ ok: false });
    expect(toReviewInput({ ...ok, comment: 'x'.repeat(2000) })).toMatchObject({ ok: true });
    expect(toReviewInput({ ...ok, comment: 'x'.repeat(2001) })).toMatchObject({ ok: false });
  });

  it('names the competency whose score is not 1 to 5 in half steps', () => {
    const result = toReviewInput({ ...ok, competencies: { ...ok.competencies, Ownership: '5.0' } });
    expect(result).toMatchObject({ ok: false });
    expect(result.ok ? '' : result.error).toContain('Ownership');
    expect(toReviewInput({ ...ok, competencies: { ...ok.competencies, Delivery: '' } })).toMatchObject({ ok: false });
  });

  it('refuses a missing competency', () => {
    const three = { Delivery: 4, Teamwork: 4, Ownership: 4 };
    expect(toReviewInput({ ...ok, competencies: three as never })).toMatchObject({ ok: false });
  });
});

describe('toTrainingInput', () => {
  const ok = { title: ' Excel ', category: ' Skills ', provider: '', starts_on: '2026-11-01', ends_on: '2026-11-02' };

  it('converts a good form, reading blank optional fields as none', () => {
    expect(toTrainingInput(ok)).toEqual({
      ok: true,
      input: { title: 'Excel', category: 'Skills', provider: null, starts_on: '2026-11-01', ends_on: '2026-11-02' },
    });
  });

  it('allows a one-day course and refuses an end before the start', () => {
    expect(toTrainingInput({ ...ok, ends_on: '2026-11-01' })).toMatchObject({ ok: true });
    expect(toTrainingInput({ ...ok, ends_on: '2026-10-31' })).toMatchObject({ ok: false });
  });

  it('needs both dates, and real ones', () => {
    for (const patch of [{ starts_on: '' }, { ends_on: '' }, { starts_on: '2026-02-30' }, { ends_on: 'later' }]) {
      expect(toTrainingInput({ ...ok, ...patch }), JSON.stringify(patch)).toMatchObject({ ok: false });
    }
  });

  it('limits the title to 200 and the category and provider to 80', () => {
    expect(toTrainingInput({ ...ok, title: '' })).toMatchObject({ ok: false });
    expect(toTrainingInput({ ...ok, title: 'x'.repeat(201) })).toMatchObject({ ok: false });
    expect(toTrainingInput({ ...ok, category: 'x'.repeat(80) })).toMatchObject({ ok: true });
    expect(toTrainingInput({ ...ok, category: 'x'.repeat(81) })).toMatchObject({ ok: false });
    expect(toTrainingInput({ ...ok, provider: 'x'.repeat(81) })).toMatchObject({ ok: false });
  });
});

describe('toAnnouncementInput', () => {
  const ok = { title: ' Town hall ', body: 'Friday at 3pm.\n', category: 'general' };

  it('trims the title and keeps the body as typed', () => {
    expect(toAnnouncementInput(ok)).toEqual({
      ok: true,
      input: { title: 'Town hall', body: 'Friday at 3pm.\n', category: 'general' },
    });
  });

  it('accepts each of the five categories and no other', () => {
    for (const category of ['general', 'holiday', 'benefits', 'strategy', 'policy']) {
      expect(toAnnouncementInput({ ...ok, category })).toMatchObject({ ok: true });
    }
    expect(toAnnouncementInput({ ...ok, category: 'news' })).toMatchObject({ ok: false });
  });

  it('limits the title to 200 and the body to 5,000 characters', () => {
    expect(toAnnouncementInput({ ...ok, title: '  ' })).toMatchObject({ ok: false });
    expect(toAnnouncementInput({ ...ok, title: 'x'.repeat(201) })).toMatchObject({ ok: false });
    expect(toAnnouncementInput({ ...ok, body: 'x'.repeat(5000) })).toMatchObject({ ok: true });
    expect(toAnnouncementInput({ ...ok, body: 'x'.repeat(5001) })).toMatchObject({ ok: false });
  });
});

describe('courseStatus', () => {
  const course = { starts_on: '2026-10-10', ends_on: '2026-10-12' };

  it('is upcoming the day before the first day', () => {
    expect(courseStatus(course, '2026-10-09')).toBe('upcoming');
  });
  it('is in progress on the first day, between, and on the last day', () => {
    expect(courseStatus(course, '2026-10-10')).toBe('in_progress');
    expect(courseStatus(course, '2026-10-11')).toBe('in_progress');
    expect(courseStatus(course, '2026-10-12')).toBe('in_progress');
  });
  it('is completed the day after the last day', () => {
    expect(courseStatus(course, '2026-10-13')).toBe('completed');
  });
  it('treats a one-day course as in progress on that day only', () => {
    const one = { starts_on: '2026-10-10', ends_on: '2026-10-10' };
    expect([courseStatus(one, '2026-10-09'), courseStatus(one, '2026-10-10'), courseStatus(one, '2026-10-11')]).toEqual([
      'upcoming', 'in_progress', 'completed',
    ]);
  });
  it('is upcoming for a course with no dates', () => {
    expect(courseStatus({ starts_on: null, ends_on: null }, '2026-10-12')).toBe('upcoming');
  });
  it('agrees with the database for a course with one date: only the date it has is compared', () => {
    expect(courseStatus({ starts_on: null, ends_on: '2026-10-12' }, '2026-10-13')).toBe('completed');
    expect(courseStatus({ starts_on: null, ends_on: '2026-10-12' }, '2026-10-12')).toBe('upcoming');
    expect(courseStatus({ starts_on: '2026-10-10', ends_on: null }, '2026-10-10')).toBe('in_progress');
  });
});

describe('canSelfEnrol', () => {
  const course = { starts_on: '2026-10-10', ends_on: '2026-10-12' };
  it('is open before, during and on the last day, and closed the day after', () => {
    expect(canSelfEnrol(course, '2026-10-09')).toBe(true);
    expect(canSelfEnrol(course, '2026-10-10')).toBe(true);
    expect(canSelfEnrol(course, '2026-10-12')).toBe(true);
    expect(canSelfEnrol(course, '2026-10-13')).toBe(false);
  });
  it('is open for a course with no dates', () => {
    expect(canSelfEnrol({ starts_on: null, ends_on: null }, '2026-10-12')).toBe(true);
  });
});

describe('canSelfWithdraw', () => {
  const course = { starts_on: '2026-10-10', ends_on: '2026-10-12' };
  const enrolled = { completed: false };
  it('is open until the day before the course starts, and closed from the first day', () => {
    expect(canSelfWithdraw(course, enrolled, '2026-10-09')).toBe(true);
    expect(canSelfWithdraw(course, enrolled, '2026-10-10')).toBe(false);
    expect(canSelfWithdraw(course, enrolled, '2026-10-13')).toBe(false);
  });
  it('is closed for someone marked completed, and for someone not enrolled', () => {
    expect(canSelfWithdraw(course, { completed: true }, '2026-10-09')).toBe(false);
    expect(canSelfWithdraw(course, null, '2026-10-09')).toBe(false);
  });
  it('is open for a course with no dates', () => {
    expect(canSelfWithdraw({ starts_on: null, ends_on: null }, enrolled, '2026-10-12')).toBe(true);
  });
});
