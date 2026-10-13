// tests/hire-interviews.test.ts
import { describe, expect, it } from 'vitest';
import {
  DURATION_CHOICES, INTERVIEW_INPUT_MESSAGES, INTERVIEW_KINDS, INTERVIEW_LIMITS, INTERVIEW_NOT_READ_BACK, INTERVIEW_NOT_SENT,
  INTERVIEW_OUTCOMES, INTERVIEW_SAVE_FAILED, KIND_WORDS, PLACE_LABEL, THIS_INTERVIEW, alsoScheduledLines, cancelledMessage, interviewFullLine, interviewCardDetail,
  interviewCardTitle, interviewLine, interviewMessage, menuFor, needsOutcome, offerMoveToInterview, outcomeMessage,
  recordedPastMessage, reopenedMessage, scheduledMessage, stillScheduledMessage, updatedMessage,
  INVITATION_NOT_MADE, STARTED_ALREADY, noInvitationMessage, withNoInvitation,
} from '@/lib/hire/interviews';
import { durationText } from '@/lib/hire/interview-time';
import { APPLICATION_STAGES, type ApplicationOutcome, type InterviewStatus } from '@/lib/hire/types';

const AT = '2026-10-20T07:00:00Z'; // Tuesday 20 October 2026, 3:00 pm in Kuala Lumpur
const MOVED = '2026-10-22T03:00:00Z'; // Thursday 22 October 2026, 11:00 am
const PAST = '2026-10-06T07:00:00Z'; // Tuesday 6 October 2026, 3:00 pm

describe('limits and labels', () => {
  it('are the agreed ones', () => {
    expect(INTERVIEW_LIMITS).toEqual({ durationMin: 15, durationMax: 480, place: 300, interviewer: 120, notes: 2000 });
    expect(INTERVIEW_KINDS).toEqual(['video', 'onsite', 'phone']);
    expect(INTERVIEW_OUTCOMES).toEqual(['completed', 'no_show']);
    expect(KIND_WORDS).toEqual({ video: 'Video call', onsite: 'In person', phone: 'Phone call' });
    expect(PLACE_LABEL).toEqual({ video: 'Link', onsite: 'Place', phone: 'Details' });
    expect(DURATION_CHOICES).toEqual([15, 30, 45, 60, 90, 120, 180, 240]);
    // The Duration field's options, as the form shows them.
    expect(DURATION_CHOICES.map(durationText)).toEqual([
      '15 minutes', '30 minutes', '45 minutes', '1 hour', '1 hour 30 minutes', '2 hours', '3 hours', '4 hours',
    ]);
  });
  it('have one sentence for each thing an input can get wrong', () => {
    expect(INTERVIEW_INPUT_MESSAGES).toEqual({
      date: 'Use a real date, like 2026-10-31.',
      time: 'Give the time as HH:MM in 24-hour form, like 15:00.',
      together: 'Give the date and the time together.',
      length: 'Choose a length between 15 minutes and 8 hours.',
      place: 'Keep this under 300 characters.',
      interviewer: 'Keep the interviewer\'s name under 120 characters.',
      notes: 'Keep the notes under 2,000 characters.',
      outcome: 'Choose what happened.',
    });
  });
});

describe('interviewMessage', () => {
  it('has two meanings of not_found: the application when scheduling, the interview otherwise', () => {
    expect(interviewMessage('not_found', 'application')).toBe('That application could not be found. It may have been deleted.');
    expect(interviewMessage('not_found', 'interview')).toBe('That interview could not be found. It may have been deleted with its application.');
  });
  it('has one sentence for every other word, whichever it is about', () => {
    const sentences: Record<string, string> = {
      forbidden: 'You do not have permission to make changes here.',
      not_active: 'This application is no longer active. Reopen it before scheduling or changing an interview.',
      in_past: 'That time has already passed in Kuala Lumpur. Choose a later one, or use “Record a past interview” if it already took place.',
      too_far_ahead: 'Choose a date within the next 12 months.',
      duplicate: 'This application already has an interview at that time.',
      not_scheduled: 'This interview is no longer scheduled. Mark it as scheduled again first.',
      not_closed: 'This interview is already scheduled.',
      unchanged: 'Nothing was changed: the interview already has these details.',
      changed: 'This interview was changed a moment ago. Nothing was saved. Check it and try again.',
      not_past: 'That time has not passed yet in Kuala Lumpur. To plan an interview, use “Schedule interview”.',
      too_far_back: 'Choose a date within the last 12 months.',
    };
    for (const [word, sentence] of Object.entries(sentences)) {
      expect(interviewMessage(word, 'application'), word).toBe(sentence);
      expect(interviewMessage(word, 'interview'), word).toBe(sentence);
    }
  });
  it('gives the generic sentence for a word it has none for, an error or no answer', () => {
    const others = [
      'invalid_time', 'invalid_duration', 'invalid_kind', 'invalid_place', 'invalid_interviewer', 'invalid_notes', 'invalid_outcome',
      'invalid_changes', 'ok', 'surprise', 'toString', '__proto__', '', null, undefined, 7, { word: 'not_found' },
    ];
    for (const word of others) {
      expect(interviewMessage(word, 'interview'), String(word)).toBe('That change could not be saved. Please try again.');
      expect(interviewMessage(word, 'application'), String(word)).toBe('That change could not be saved. Please try again.');
    }
    expect(INTERVIEW_SAVE_FAILED).toBe('That change could not be saved. Please try again.');
    expect(INTERVIEW_NOT_SENT).toBe('That change could not be sent. Check your connection and try again.');
    expect(INTERVIEW_NOT_READ_BACK).toBe('Saved. The interview could not be read back, so some details are not shown.');
  });
});

describe('what a person reads after a change', () => {
  it('says what was done, when it is, and that nothing was sent', () => {
    expect(scheduledMessage('Aina Rahman', AT))
      .toBe('Scheduled an interview with Aina Rahman for Tuesday, 20 October 2026, 3:00 pm. Nothing has been sent to them.');
    expect(updatedMessage('Aina Rahman', MOVED))
      .toBe('Updated the interview with Aina Rahman. It is on Thursday, 22 October 2026, 11:00 am. Nothing has been sent to them.');
    expect(cancelledMessage('Aina Rahman')).toBe('Cancelled the interview with Aina Rahman. Nothing has been sent to them.');
    expect(outcomeMessage('Aina Rahman', 'completed')).toBe('Marked the interview with Aina Rahman as completed.');
    expect(outcomeMessage('Aina Rahman', 'no_show')).toBe('Marked the interview with Aina Rahman as a no-show.');
    expect(reopenedMessage('Aina Rahman')).toBe('The interview with Aina Rahman is scheduled again.');
  });
  it('says what was recorded for a past interview, and that no invitation was made', () => {
    expect(recordedPastMessage('Aina Rahman', PAST, 'completed'))
      .toBe('Recorded a completed interview with Aina Rahman on Tuesday, 6 October 2026, 3:00 pm. No invitation was made.');
    expect(recordedPastMessage('Aina Rahman', PAST, 'no_show'))
      .toBe('Recorded a no-show for the interview with Aina Rahman on Tuesday, 6 October 2026, 3:00 pm.');
  });
  it('counts the interviews a closed application still has ahead', () => {
    expect(stillScheduledMessage('Aina Rahman', 1))
      .toBe('1 interview with Aina Rahman is still scheduled. Cancel it on the Interviews screen if it should not go ahead.');
    expect(stillScheduledMessage('Aina Rahman', 2))
      .toBe('2 interviews with Aina Rahman are still scheduled. Cancel them on the Interviews screen if they should not go ahead.');
    expect(stillScheduledMessage('Aina Rahman', 0)).toBe('');
    expect(stillScheduledMessage('Aina Rahman', -1)).toBe('');
    expect(stillScheduledMessage('Aina Rahman', 1.5)).toBe('');
  });
  it('still makes a sentence when the name could not be read back', () => {
    expect(scheduledMessage('', AT)).toBe('Scheduled an interview with the candidate for Tuesday, 20 October 2026, 3:00 pm. Nothing has been sent to them.');
    expect(cancelledMessage('  ')).toBe('Cancelled the interview with the candidate. Nothing has been sent to them.');
    expect(outcomeMessage('', 'no_show')).toBe('Marked the interview with the candidate as a no-show.');
    expect(reopenedMessage('')).toBe('The interview with the candidate is scheduled again.');
    expect(recordedPastMessage('', PAST, 'completed'))
      .toBe('Recorded a completed interview with the candidate on Tuesday, 6 October 2026, 3:00 pm. No invitation was made.');
    expect(stillScheduledMessage('', 1)).toBe('1 interview with the candidate is still scheduled. Cancel it on the Interviews screen if it should not go ahead.');
  });
  it('leaves the time out of an update when it is not known', () => {
    expect(updatedMessage('Aina Rahman', null)).toBe('Updated the interview with Aina Rahman. Nothing has been sent to them.');
    expect(updatedMessage('', null)).toBe('Updated the interview with the candidate. Nothing has been sent to them.');
  });
});

describe('menuFor', () => {
  it('offers everything for a scheduled interview of an active application', () => {
    expect(menuFor('scheduled', 'active')).toEqual(['edit', 'invitation', 'completed', 'no_show', 'cancel']);
  });
  it('leaves the edit out when the application is closed: it would be refused', () => {
    expect(menuFor('scheduled', 'rejected')).toEqual(['invitation', 'completed', 'no_show', 'cancel']);
    expect(menuFor('scheduled', 'withdrawn')).toEqual(['invitation', 'completed', 'no_show', 'cancel']);
  });
  it('offers only the undo for a closed interview, whatever the application', () => {
    for (const status of ['cancelled', 'completed', 'no_show'] as InterviewStatus[]) {
      for (const outcome of ['active', 'rejected', 'withdrawn'] as ApplicationOutcome[]) {
        expect(menuFor(status, outcome), `${status} ${outcome}`).toEqual(['reopen']);
      }
    }
  });
});

describe('offerMoveToInterview', () => {
  it('is true for exactly two of the fifteen combinations: active at Applied or Screening', () => {
    const offered: string[] = [];
    for (const stage of APPLICATION_STAGES) {
      for (const outcome of ['active', 'rejected', 'withdrawn'] as ApplicationOutcome[]) {
        if (offerMoveToInterview(stage, outcome)) offered.push(`${stage}/${outcome}`);
      }
    }
    expect(offered).toEqual(['applied/active', 'screening/active']);
  });
});

describe('needsOutcome', () => {
  const now = new Date('2026-10-20T07:00:00Z');
  it('is true only for a scheduled interview whose start has passed', () => {
    expect(needsOutcome('scheduled', '2026-10-20T06:59:00Z', now)).toBe(true);
    expect(needsOutcome('scheduled', '2026-10-20T07:00:00Z', now)).toBe(false);
    expect(needsOutcome('scheduled', '2026-10-20T07:01:00Z', now)).toBe(false);
    for (const status of ['cancelled', 'completed', 'no_show'] as InterviewStatus[]) {
      expect(needsOutcome(status, '2026-10-19T07:00:00Z', now), status).toBe(false);
    }
    expect(needsOutcome('scheduled', 'not a time', now)).toBe(false);
  });
});

describe('the line that says which interview', () => {
  it('is the short date, the time and the stored type', () => {
    expect(interviewLine(AT, 'video')).toBe('Tue 20 Oct 2026, 3:00 pm · video');
    expect(interviewLine(AT, 'onsite')).toBe('Tue 20 Oct 2026, 3:00 pm · onsite');
    expect(THIS_INTERVIEW(interviewLine(AT, 'video'))).toBe('This interview: Tue 20 Oct 2026, 3:00 pm · video');
  });
});

describe('the title of an Approve card', () => {
  const who = 'Aina Rahman (Sales Executive)';
  it('names the person and the job for each of the six tools', () => {
    expect(interviewCardTitle('scheduleInterview', {}, who)).toBe('Schedule an interview with Aina Rahman (Sales Executive)?');
    expect(interviewCardTitle('recordPastInterview', {}, who)).toBe('Record a past interview with Aina Rahman (Sales Executive)?');
    expect(interviewCardTitle('rescheduleInterview', {}, who)).toBe('Change the interview with Aina Rahman (Sales Executive)?');
    expect(interviewCardTitle('cancelInterview', {}, who)).toBe('Cancel the interview with Aina Rahman (Sales Executive)?');
    expect(interviewCardTitle('setInterviewOutcome', { outcome: 'completed' }, who)).toBe('Mark the interview with Aina Rahman (Sales Executive) as completed?');
    expect(interviewCardTitle('setInterviewOutcome', { outcome: 'no_show' }, who)).toBe('Mark the interview with Aina Rahman (Sales Executive) as a no-show?');
    expect(interviewCardTitle('reopenInterview', {}, who)).toBe('Mark the interview with Aina Rahman (Sales Executive) as scheduled again?');
  });
  it('says so when the id was not in a lookup: an application for the two that take one, an interview for the rest', () => {
    expect(interviewCardTitle('scheduleInterview', {}, null)).toBe('Schedule an interview with an application that was not in the list above?');
    expect(interviewCardTitle('recordPastInterview', {}, null)).toBe('Record a past interview with an application that was not in the list above?');
    expect(interviewCardTitle('rescheduleInterview', {}, null)).toBe('Change the interview with an interview that was not in the list above?');
    expect(interviewCardTitle('cancelInterview', {}, null)).toBe('Cancel the interview with an interview that was not in the list above?');
    expect(interviewCardTitle('setInterviewOutcome', { outcome: 'completed' }, null)).toBe('Mark the interview with an interview that was not in the list above as completed?');
    expect(interviewCardTitle('reopenInterview', {}, null)).toBe('Mark the interview with an interview that was not in the list above as scheduled again?');
    expect(interviewCardTitle('scheduleInterview', {}, '  ')).toBe('Schedule an interview with an application that was not in the list above?');
  });
  it('has no title for another tool, or for an outcome that is neither of the two', () => {
    expect(interviewCardTitle('moveApplication', {}, who)).toBeNull();
    expect(interviewCardTitle('setInterviewOutcome', { outcome: 'cancelled' }, who)).toBeNull();
    expect(interviewCardTitle('setInterviewOutcome', {}, who)).toBeNull();
  });
});

describe('the detail of an Approve card', () => {
  const NOTHING_SENT = 'Nothing is sent to the candidate.';
  it('writes out a new interview in full, from the tool\'s own input', () => {
    expect(interviewCardDetail('scheduleInterview', {
      application_id: 'x', date: '2026-10-20', time: '15:00', duration_minutes: 60, kind: 'video',
      place: 'https://meet.example.com/abc', interviewer_name: 'Farah Lim', notes: 'Second round',
    })).toBe(
      'Tuesday, 20 October 2026, 3:00 pm to 4:00 pm, Kuala Lumpur time (GMT+8) · Video call · Link: https://meet.example.com/abc · With: Farah Lim · Notes: Second round · Nothing is sent to the candidate.',
    );
  });
  it('says what nobody gave, and takes 60 minutes when no length was sent', () => {
    expect(interviewCardDetail('scheduleInterview', { date: '2026-10-20', time: '15:00', kind: 'video' })).toBe(
      'Tuesday, 20 October 2026, 3:00 pm to 4:00 pm, Kuala Lumpur time (GMT+8) · Video call · No place or link given · No interviewer given · Nothing is sent to the candidate.',
    );
    expect(interviewCardDetail('scheduleInterview', { date: '2026-10-20', time: '15:00', kind: 'video', place: '  ', interviewer_name: null })).toBe(
      'Tuesday, 20 October 2026, 3:00 pm to 4:00 pm, Kuala Lumpur time (GMT+8) · Video call · No place or link given · No interviewer given · Nothing is sent to the candidate.',
    );
  });
  it('labels the place by the type', () => {
    const detail = (kind: string, place: string) => interviewCardDetail('scheduleInterview', { date: '2026-10-20', time: '09:30', duration_minutes: 90, kind, place });
    expect(detail('onsite', 'Level 3, Menara Rimba')).toBe(
      'Tuesday, 20 October 2026, 9:30 am to 11:00 am, Kuala Lumpur time (GMT+8) · In person · Place: Level 3, Menara Rimba · No interviewer given · Nothing is sent to the candidate.',
    );
    expect(detail('phone', 'We will call you')).toBe(
      'Tuesday, 20 October 2026, 9:30 am to 11:00 am, Kuala Lumpur time (GMT+8) · Phone call · Details: We will call you · No interviewer given · Nothing is sent to the candidate.',
    );
  });
  it('says when an interview ends the next day', () => {
    expect(interviewCardDetail('scheduleInterview', { date: '2026-10-20', time: '23:30', kind: 'phone' })).toBe(
      'Tuesday, 20 October 2026, 11:30 pm to 12:30 am the next day, Kuala Lumpur time (GMT+8) · Phone call · No place or link given · No interviewer given · Nothing is sent to the candidate.',
    );
  });
  it('shows a date or a time it cannot read as it was sent, never worked around', () => {
    expect(interviewCardDetail('scheduleInterview', { date: 'next Tuesday', time: '3pm', kind: 'video' })).toBe(
      'next Tuesday, 3pm · Video call · No place or link given · No interviewer given · Nothing is sent to the candidate.',
    );
    expect(interviewCardDetail('scheduleInterview', { date: '2026-02-31', time: '15:00', kind: 'video' })).toBe(
      '2026-02-31, 15:00 · Video call · No place or link given · No interviewer given · Nothing is sent to the candidate.',
    );
    expect(interviewCardDetail('scheduleInterview', { date: '2026-10-20', kind: 'video' })).toBe(
      '2026-10-20 · Video call · No place or link given · No interviewer given · Nothing is sent to the candidate.',
    );
  });
  it('puts what happened after the type for a past interview, and says no invitation is made', () => {
    expect(interviewCardDetail('recordPastInterview', { date: '2026-10-06', time: '15:00', kind: 'video', outcome: 'completed' })).toBe(
      'Tuesday, 6 October 2026, 3:00 pm to 4:00 pm, Kuala Lumpur time (GMT+8) · Video call · Completed · No place or link given · No interviewer given · Recorded as already held. No invitation is made.',
    );
    expect(interviewCardDetail('recordPastInterview', {
      date: '2026-10-06', time: '15:00', duration_minutes: 45, kind: 'onsite', outcome: 'no_show', place: 'Level 3', interviewer_name: 'Farah Lim',
    })).toBe(
      'Tuesday, 6 October 2026, 3:00 pm to 3:45 pm, Kuala Lumpur time (GMT+8) · In person · No-show · Place: Level 3 · With: Farah Lim · Recorded as already held. No invitation is made.',
    );
  });
  it('lists only what a change changes, then always that nothing is sent', () => {
    expect(interviewCardDetail('rescheduleInterview', { id: 'x' })).toBe(NOTHING_SENT);
    expect(interviewCardDetail('rescheduleInterview', { id: 'x', date: '2026-10-22', time: '11:00', duration_minutes: 60 })).toBe(
      'New time: Thursday, 22 October 2026, 11:00 am to 12:00 pm, Kuala Lumpur time (GMT+8) · Length: 1 hour · Nothing is sent to the candidate.',
    );
    expect(interviewCardDetail('rescheduleInterview', {
      id: 'x', duration_minutes: 90, kind: 'phone', place: '+60 3-1234 5678', interviewer_name: 'Farah Lim', notes: 'Call the mobile first',
    })).toBe(
      'Length: 1 hour 30 minutes · Type: Phone call · Place or link: +60 3-1234 5678 · Interviewer: Farah Lim · Notes: Call the mobile first · Nothing is sent to the candidate.',
    );
  });
  it('shows the start alone for a new time when the length is not part of the change: the stored length is not known here', () => {
    expect(interviewCardDetail('rescheduleInterview', { id: 'x', date: '2026-10-22', time: '11:00' })).toBe(
      'New time: Thursday, 22 October 2026, 11:00 am, Kuala Lumpur time (GMT+8) · Nothing is sent to the candidate.',
    );
  });
  it('says cleared for a place, an interviewer or notes sent blank or as null', () => {
    expect(interviewCardDetail('rescheduleInterview', { id: 'x', place: null, interviewer_name: '', notes: '  ' })).toBe(
      'Place or link: cleared · Interviewer: cleared · Notes: cleared · Nothing is sent to the candidate.',
    );
  });
  it('shows half a new time, or one it cannot read, as it was sent', () => {
    expect(interviewCardDetail('rescheduleInterview', { id: 'x', date: '2026-10-22' })).toBe('New time: 2026-10-22 · Nothing is sent to the candidate.');
    expect(interviewCardDetail('rescheduleInterview', { id: 'x', date: 'Thursday', time: '11am' })).toBe('New time: Thursday, 11am · Nothing is sent to the candidate.');
  });
  // The notes are the team's own and no candidate ever reads them. They are saved all the same, and the person who
  // approves must see what the assistant wrote there.
  it('shows the notes that will be saved, on one line, on a new interview, a past one and a change', () => {
    const when = { date: '2026-10-20', time: '15:00', kind: 'video' };
    expect(interviewCardDetail('scheduleInterview', { ...when, notes: 'Salary was the sticking point' })).toBe(
      'Tuesday, 20 October 2026, 3:00 pm to 4:00 pm, Kuala Lumpur time (GMT+8) · Video call · No place or link given · No interviewer given · ' +
        'Notes: Salary was the sticking point · Nothing is sent to the candidate.',
    );
    expect(interviewCardDetail('recordPastInterview', { date: '2026-10-06', time: '15:00', kind: 'video', outcome: 'completed', notes: 'Strong on the till.\nWeak on stock.' })).toBe(
      'Tuesday, 6 October 2026, 3:00 pm to 4:00 pm, Kuala Lumpur time (GMT+8) · Video call · Completed · No place or link given · No interviewer given · ' +
        'Notes: Strong on the till. Weak on stock. · Recorded as already held. No invitation is made.',
    );
    expect(interviewCardDetail('rescheduleInterview', { id: 'x', notes: ' Second round.\n\n  Bring the portfolio. ' })).toBe(
      'Notes: Second round. Bring the portfolio. · Nothing is sent to the candidate.',
    );
  });
  it('cuts long notes at 300 characters, and says nothing of notes that were not sent or are blank', () => {
    const long = 'n'.repeat(301);
    expect(interviewCardDetail('scheduleInterview', { date: '2026-10-20', time: '15:00', kind: 'video', notes: long })).toContain(` · Notes: ${'n'.repeat(300)}… · Nothing is sent`);
    expect(interviewCardDetail('rescheduleInterview', { id: 'x', notes: long })).toBe(`Notes: ${'n'.repeat(300)}… · Nothing is sent to the candidate.`);
    expect(interviewCardDetail('rescheduleInterview', { id: 'x', notes: 'n'.repeat(300) })).toBe(`Notes: ${'n'.repeat(300)} · Nothing is sent to the candidate.`);
    for (const none of [undefined, null, '', '  \n ']) {
      expect(interviewCardDetail('scheduleInterview', { date: '2026-10-20', time: '15:00', kind: 'video', notes: none }), String(none)).not.toContain('Notes');
      expect(interviewCardDetail('recordPastInterview', { date: '2026-10-06', time: '15:00', kind: 'video', outcome: 'no_show', notes: none }), String(none)).not.toContain('Notes');
    }
    // On a change, notes sent blank are notes cleared.
    expect(interviewCardDetail('rescheduleInterview', { id: 'x', notes: null })).toBe('Notes: cleared · Nothing is sent to the candidate.');
    expect(interviewCardDetail('rescheduleInterview', { id: 'x', date: '2026-10-22', time: '11:00' })).not.toContain('Notes');
  });
  it('says what a cancellation leaves, and has nothing to add for an outcome or an undo', () => {
    expect(interviewCardDetail('cancelInterview', { id: 'x' })).toBe('It stays in the list as cancelled. Nothing is sent to the candidate.');
    expect(interviewCardDetail('setInterviewOutcome', { id: 'x', outcome: 'completed' })).toBeNull();
    expect(interviewCardDetail('reopenInterview', { id: 'x' })).toBeNull();
    expect(interviewCardDetail('moveApplication', { id: 'x' })).toBeNull();
  });
});

// ─── boundaries beyond the plan's own tests ──────────────────────────────────

describe('times at the edges of a day and a year', () => {
  it('says the Kuala Lumpur day, not the UTC one, in every sentence and line', () => {
    // 12:30 am on Tuesday 20 October in Kuala Lumpur is still Monday the 19th in UTC.
    const early = '2026-10-19T16:30:00+00:00';
    expect(scheduledMessage('Aina Rahman', early))
      .toBe('Scheduled an interview with Aina Rahman for Tuesday, 20 October 2026, 12:30 am. Nothing has been sent to them.');
    expect(updatedMessage('Aina Rahman', early))
      .toBe('Updated the interview with Aina Rahman. It is on Tuesday, 20 October 2026, 12:30 am. Nothing has been sent to them.');
    expect(recordedPastMessage('Aina Rahman', early, 'no_show'))
      .toBe('Recorded a no-show for the interview with Aina Rahman on Tuesday, 20 October 2026, 12:30 am.');
    expect(interviewLine(early, 'phone')).toBe('Tue 20 Oct 2026, 12:30 am · phone');
    // 12:00 am on New Year's Day in Kuala Lumpur is 31 December in UTC: the year is the Kuala Lumpur one.
    expect(interviewLine('2026-12-31T16:00:00Z', 'video')).toBe('Fri 1 Jan 2027, 12:00 am · video');
    expect(scheduledMessage('Aina Rahman', '2026-12-31T16:00:00Z'))
      .toBe('Scheduled an interview with Aina Rahman for Friday, 1 January 2027, 12:00 am. Nothing has been sent to them.');
  });
  it('writes a card for midnight, the last minute of a day, 29 February and another year from the input alone', () => {
    const when = (date: string, time: string, minutes?: number) =>
      interviewCardDetail('scheduleInterview', { date, time, kind: 'video', ...(minutes ? { duration_minutes: minutes } : {}) })!.split(' · ')[0];
    expect(when('2026-10-20', '00:00')).toBe('Tuesday, 20 October 2026, 12:00 am to 1:00 am, Kuala Lumpur time (GMT+8)');
    expect(when('2026-10-20', '23:59', 15)).toBe('Tuesday, 20 October 2026, 11:59 pm to 12:14 am the next day, Kuala Lumpur time (GMT+8)');
    expect(when('2028-02-29', '09:30')).toBe('Tuesday, 29 February 2028, 9:30 am to 10:30 am, Kuala Lumpur time (GMT+8)');
    expect(when('2027-01-01', '00:00')).toBe('Friday, 1 January 2027, 12:00 am to 1:00 am, Kuala Lumpur time (GMT+8)');
    expect(when('2026-12-31', '23:30')).toBe('Thursday, 31 December 2026, 11:30 pm to 12:30 am the next day, Kuala Lumpur time (GMT+8)');
    // 29 February in a year that has none is shown as it was sent, with no weekday made up for it.
    expect(when('2027-02-29', '09:30')).toBe('2027-02-29, 09:30');
    expect(interviewCardDetail('rescheduleInterview', { id: 'x', date: '2027-01-01', time: '00:00' }))
      .toBe('New time: Friday, 1 January 2027, 12:00 am, Kuala Lumpur time (GMT+8) · Nothing is sent to the candidate.');
  });
  it('writes the same card whatever zone the process is in', () => {
    const before = process.env.TZ;
    const input = { date: '2026-10-20', time: '23:30', kind: 'phone' };
    try {
      for (const zone of ['UTC', 'America/New_York', 'Asia/Tokyo']) {
        process.env.TZ = zone;
        expect(interviewCardDetail('scheduleInterview', input), zone).toBe(
          'Tuesday, 20 October 2026, 11:30 pm to 12:30 am the next day, Kuala Lumpur time (GMT+8) · Phone call · No place or link given · No interviewer given · Nothing is sent to the candidate.',
        );
        expect(interviewLine('2026-10-19T16:30:00+00:00', 'video'), zone).toBe('Tue 20 Oct 2026, 12:30 am · video');
      }
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
  });
  it('does not tag a start with no zone of its own as needing an outcome: it is not an instant', () => {
    const now = new Date('2026-10-20T07:00:00Z');
    expect(needsOutcome('scheduled', '2026-10-19T07:00:00', now)).toBe(false);
    expect(needsOutcome('scheduled', '2026-10-19', now)).toBe(false);
    expect(needsOutcome('scheduled', '2026-10-20T14:59:00+08:00', now)).toBe(true);
    expect(needsOutcome('scheduled', '2026-10-20T15:00:00+08:00', now)).toBe(false);
  });
});

describe('what else is scheduled with the same person, on a card about one interview', () => {
  const other = (scheduled_at: string, kind: 'video' | 'onsite' | 'phone', job: string) => ({ scheduled_at, kind, job });
  it('one line for each, with its date, its time, its type and its job', () => {
    expect(alsoScheduledLines('Aina Rahman', [other('2026-10-22T02:00:00.000Z', 'onsite', 'Sales Executive')])).toEqual([
      'Also scheduled for Aina Rahman: Thu 22 Oct 2026, 10:00 am · onsite (Sales Executive)',
    ]);
    expect(alsoScheduledLines('Aina Rahman', [])).toEqual([]);
  });
  it('at most three, then how many more', () => {
    const many = [
      other('2026-10-22T02:00:00.000Z', 'onsite', 'Sales Executive'), other('2026-10-23T02:00:00.000Z', 'video', 'Barista'),
      other('2026-10-24T02:00:00.000Z', 'phone', 'Barista'), other('2026-10-25T02:00:00.000Z', 'video', 'Barista'), other('2026-10-26T02:00:00.000Z', 'video', 'Barista'),
    ];
    expect(alsoScheduledLines('Aina Rahman', many)).toEqual([
      'Also scheduled for Aina Rahman: Thu 22 Oct 2026, 10:00 am · onsite (Sales Executive)',
      'Also scheduled for Aina Rahman: Fri 23 Oct 2026, 10:00 am · video (Barista)',
      'Also scheduled for Aina Rahman: Sat 24 Oct 2026, 10:00 am · phone (Barista)',
      'and 2 more',
    ]);
    expect(alsoScheduledLines('Aina Rahman', many.slice(0, 3))).toHaveLength(3);
  });
  it('a name or a job with a line break in it stays on its one line, and no name is "the candidate"', () => {
    expect(alsoScheduledLines(' Aina\nRahman ', [other('2026-10-22T02:00:00.000Z', 'onsite', 'Sales\n Executive ')])).toEqual([
      'Also scheduled for Aina Rahman: Thu 22 Oct 2026, 10:00 am · onsite (Sales Executive)',
    ]);
    expect(alsoScheduledLines('  ', [other('2026-10-22T02:00:00.000Z', 'onsite', 'Barista')])[0]).toBe('Also scheduled for the candidate: Thu 22 Oct 2026, 10:00 am · onsite (Barista)');
  });
});

describe('the stored interview as a card says it', () => {
  const AT = '2026-10-20T07:00:00.000Z';
  it('its day, its time, its type, its length and its place, the place under the label of its type', () => {
    expect(THIS_INTERVIEW(interviewFullLine({ scheduled_at: AT, kind: 'video', duration_minutes: 60, place: null })))
      .toBe('This interview: Tue 20 Oct 2026, 3:00 pm · video · 1 hour · No place or link given');
    expect(interviewFullLine({ scheduled_at: AT, kind: 'video', duration_minutes: 45, place: 'https://meet.example.com/abc' }))
      .toBe('Tue 20 Oct 2026, 3:00 pm · video · 45 minutes · Link: https://meet.example.com/abc');
    expect(interviewFullLine({ scheduled_at: AT, kind: 'onsite', duration_minutes: 90, place: 'Level 3, Menara Aina' }))
      .toBe('Tue 20 Oct 2026, 3:00 pm · onsite · 1 hour 30 minutes · Place: Level 3, Menara Aina');
    expect(interviewFullLine({ scheduled_at: AT, kind: 'phone', duration_minutes: 15, place: '+60 12-345 6789' }))
      .toBe('Tue 20 Oct 2026, 3:00 pm · phone · 15 minutes · Details: +60 12-345 6789');
  });
  it('a place of spaces is no place, and one with a line break stays on the line', () => {
    expect(interviewFullLine({ scheduled_at: AT, kind: 'video', duration_minutes: 60, place: '   ' })).toBe('Tue 20 Oct 2026, 3:00 pm · video · 1 hour · No place or link given');
    expect(interviewFullLine({ scheduled_at: AT, kind: 'onsite', duration_minutes: 60, place: ' Level 3,\n Menara  Aina ' })).toBe('Tue 20 Oct 2026, 3:00 pm · onsite · 1 hour · Place: Level 3, Menara Aina');
  });
});

// Added in the final-review fix pass: the sentences for "there is no invitation".
describe('when there is no invitation', () => {
  const PASSED = 'This interview\'s start has already passed, so there is no invitation or calendar file for it.';
  it('says only what the row\'s menu really offers', () => {
    // An active application: its outcome can be marked, and it can be rescheduled.
    expect(noInvitationMessage(menuFor('scheduled', 'active'))).toBe(`${PASSED} Mark what happened, or reschedule it.`);
    // A rejected or withdrawn application: "Reschedule or edit" is not in the menu, so it is not suggested.
    for (const outcome of ['rejected', 'withdrawn'] as const) {
      expect(noInvitationMessage(menuFor('scheduled', outcome)), outcome).toBe(`${PASSED} Mark what happened.`);
    }
    // Nothing the menu offers would help: the fact alone.
    expect(noInvitationMessage(menuFor('cancelled', 'active'))).toBe(PASSED);
    expect(noInvitationMessage([])).toBe(PASSED);
  });
  it('adds one sentence to a success notice for an interview saved after its start', () => {
    expect(STARTED_ALREADY).toBe('Its start has already passed, so there is no invitation or calendar file.');
    expect(withNoInvitation(scheduledMessage('Aina Rahman', AT)))
      .toBe('Scheduled an interview with Aina Rahman for Tuesday, 20 October 2026, 3:00 pm. Nothing has been sent to them. Its start has already passed, so there is no invitation or calendar file.');
  });
  it('has a sentence of its own for an invitation that could not be made, which says nothing about saving', () => {
    expect(INVITATION_NOT_MADE).toBe('The invitation could not be made just now. Please try again.');
    expect(INVITATION_NOT_MADE).not.toMatch(/saved/);
  });
});
