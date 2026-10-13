// tests/hire-application-changes.test.ts
import { describe, expect, it } from 'vitest';
import {
  REASON_LABEL,
  REJECT_REASONS,
  allowedMoves,
  changeMessage,
  datesAfterMove,
  moveProblem,
  CHANGE_MESSAGES,
} from '@/lib/hire/application-changes';
import { APPLICATION_STAGES } from '@/lib/hire/types';

const NOW = '2026-10-11T04:00:00.000Z';

describe('moveProblem', () => {
  it('judges all 25 stage pairs for an active application', () => {
    for (const [i, from] of APPLICATION_STAGES.entries()) {
      for (const [j, to] of APPLICATION_STAGES.entries()) {
        const expected = i === j ? 'same_stage' : j < i - 1 ? 'too_far_back' : null;
        expect(moveProblem(from, to, 'active'), `${from} -> ${to}`).toBe(expected);
      }
    }
  });
  it('refuses any move for a closed application', () => {
    expect(moveProblem('applied', 'screening', 'rejected')).toBe('not_active');
    expect(moveProblem('offer', 'offer', 'withdrawn')).toBe('not_active');
  });
});

describe('allowedMoves', () => {
  it('lists every later stage and the one before', () => {
    expect(allowedMoves('interview', 'active')).toEqual(['screening', 'offer', 'hired']);
    expect(allowedMoves('applied', 'active')).toEqual(['screening', 'interview', 'offer', 'hired']);
    expect(allowedMoves('hired', 'active')).toEqual(['offer']);
  });
  it('is empty when the application is closed', () => {
    expect(allowedMoves('interview', 'rejected')).toEqual([]);
    expect(allowedMoves('interview', 'withdrawn')).toEqual([]);
  });
});

describe('datesAfterMove', () => {
  it('sets the offer date when moving to offer from nothing', () => {
    expect(datesAfterMove('offer', null, null, NOW)).toEqual({ offered_at: NOW, hired_at: null });
  });
  it('sets both when moving to hired from nothing', () => {
    expect(datesAfterMove('hired', null, null, NOW)).toEqual({ offered_at: NOW, hired_at: NOW });
  });
  it('keeps an existing offer date when moving to hired', () => {
    const offered = '2026-10-01T00:00:00.000Z';
    expect(datesAfterMove('hired', offered, null, NOW)).toEqual({ offered_at: offered, hired_at: NOW });
  });
  it('clears the hire date but keeps the offer date going back to offer', () => {
    const offered = '2026-10-01T00:00:00.000Z';
    expect(datesAfterMove('offer', offered, '2026-10-05T00:00:00.000Z', NOW)).toEqual({ offered_at: offered, hired_at: null });
  });
  it('clears both going back to interview', () => {
    expect(datesAfterMove('interview', '2026-10-01T00:00:00.000Z', null, NOW)).toEqual({ offered_at: null, hired_at: null });
  });
});

describe('reasons and messages', () => {
  it('has the six reasons with their labels verbatim', () => {
    expect([...REJECT_REASONS]).toEqual(['skills', 'experience', 'salary', 'role_filled', 'not_reachable', 'other']);
    expect(REASON_LABEL).toEqual({
      skills: 'Skills not a match',
      experience: 'Not enough experience',
      salary: 'Salary expectations',
      role_filled: 'Role filled',
      not_reachable: 'Could not reach the candidate',
      other: 'Other',
    });
  });
  it('words every refusal verbatim', () => {
    const generic = 'That change could not be saved. Please try again.';
    expect(changeMessage('not_found')).toBe('That application could not be found.');
    expect(changeMessage('forbidden')).toBe('You do not have permission to make changes here.');
    expect(changeMessage('not_active')).toBe('This application is no longer active. Reopen it first.');
    expect(changeMessage('not_closed')).toBe('This application is already active.');
    expect(changeMessage('same_stage')).toBe('This application is already at that stage.');
    expect(changeMessage('too_far_back')).toBe('An application can move back one stage at a time.');
    for (const w of ['invalid_stage', 'invalid_outcome', 'invalid_reason', 'invalid_rating', 'surprise']) {
      expect(changeMessage(w)).toBe(generic);
    }
    expect(changeMessage(undefined)).toBe(generic);
    expect(changeMessage(null)).toBe(generic);
    expect(Object.keys(CHANGE_MESSAGES)).toContain('too_far_back');
  });
});
