// tests/hire-interview-dialog.test.ts
import { describe, expect, it } from 'vitest';
import type { InterviewChange } from '@/lib/hire/capabilities';
import type { InterviewRow, PickerApplication } from '@/lib/hire/lists';
import {
  BAD_LENGTH, CHOOSE_APPLICATION, CHOOSE_DATE, CHOOSE_OUTCOME, CHOOSE_TIME, COPY_FAILED, DONE, DOWNLOAD_HELP, DOWNLOAD_LABEL, FIND_HELP, ICS_MIME,
  INTERVIEWER_HELP, INTERVIEWER_TOO_LONG, KEEP_INTERVIEW, MENU_WORDS, MOVED, NOTES_HELP, NOTES_TOO_LONG, NOTHING_CHANGED, OUTCOME_HELP, PANEL_EMPTY,
  PANEL_HEADING, PANEL_ROWS, PICKER_MAX, PLACE_TOO_LONG, REAL_DATE, canSubmit, cancelBody, cancelLabel, cancelTitle, changesFrom, copyLabel,
  dateBounds, dateHelper, dialogDescription, dialogTitle, discardTitle, durationOptions, emptyValues, fieldId, fieldOfRefusal, firstWrongField,
  focusIdAfter, interviewProblems, interviewResult, inviteLead, inviteTitle, isDirty, keptChoice, mayClose,
  menuGroups, menuName, moveInput, moveLabel, moveResult, noticeOf, offersMove, onOf, openerId, outcomeInput, panelLine, panelMore, panelRows,
  pastInput, pickerLabel, pickerNotes, pickerOptions, placeHelper, placeLabel, refreshAfter, refusalWord, rowMenu, sayOnNotice, scheduleInput,
  stepAfter, stillScheduledNotice, submission, submitLabel, tagsFor, timeCell, timeHelper, valuesFrom, type InterviewFormValues,
  GETTING_INVITATION, LOAD_CURRENT, LOAD_CURRENT_HELP, calendarOf, clockAt, currentResult, offersReload, rowWithCurrent, handoverAfter, handoverResult, mayAskHandover, rowWaitingWord,
} from '@/lib/hire/interview-dialog-state';

const APP = '44444444-4444-4444-8444-444444444444';
const IV = '77777777-7777-4777-8777-777777777777';
/** Monday 12 October 2026, 10:15 in Kuala Lumpur. */
const NOW = new Date('2026-10-12T02:15:00Z');
const IN_PAST = 'That time has already passed in Kuala Lumpur. Choose a later one, or use “Record a past interview” if it already took place.';
const NOT_PAST = 'That time has not passed yet in Kuala Lumpur. To plan an interview, use “Schedule interview”.';
const GENERIC = 'That change could not be saved. Please try again.';

const values = (over: Partial<InterviewFormValues> = {}): InterviewFormValues => ({
  application_id: APP, date: '2026-10-20', time: '15:00', duration_minutes: 60, kind: 'video', outcome: '', place: '', interviewer_name: '', notes: '',
  ...over,
});
const row = (over: Partial<InterviewRow> = {}): InterviewRow => ({
  id: IV, name: 'Aina Rahman', role: 'Sales Executive', date: '20 Oct 2026', time: '3:00 pm', interviewer: 'Farah Lim', type: 'Video', status: 'Scheduled',
  applicationId: APP, statusKey: 'scheduled', scheduledAt: '2026-10-20T07:00:00+00:00', durationMinutes: 60, length: '1 hour', kind: 'video',
  place: 'https://meet.example.com/abc', placeLink: { href: 'https://meet.example.com/abc', host: 'meet.example.com' },
  interviewerName: 'Farah Lim', notes: 'Second round.', createdAt: '2026-10-12T02:00:00+00:00', updatedAt: '2026-10-12T02:05:00+00:00',
  applicationStage: 'screening', applicationOutcome: 'active', needsOutcome: false, ...over,
});
const change = (over: Partial<InterviewChange> = {}): InterviewChange => ({
  id: IV, application_id: APP, candidate: 'Aina Rahman', job: 'Sales Executive', application_stage: 'screening', application_outcome: 'active',
  scheduled_at: '2026-10-20T07:00:00+00:00', date: '2026-10-20', time: '15:00', duration_minutes: 60, kind: 'video', place: null,
  interviewer_name: null, status: 'scheduled', created_at: '2026-10-12T02:15:00+00:00', updated_at: '2026-10-12T02:15:00+00:00',
  message: 'Scheduled an interview with Aina Rahman for Tuesday, 20 October 2026, 3:00 pm. Nothing has been sent to them.',
  invitation: 'Hi Aina Rahman,\n\nYou are invited to an interview for the Sales Executive role at Rimba Ventures.', confirmed: true, ...over,
});
const application = (id: string, name: string, job: string, over: Partial<PickerApplication> = {}): PickerApplication =>
  ({ id, name, job, stage: 'screening', outcome: 'active', ...over });

describe('the form\'s starting values', () => {
  it('a new interview starts at an hour, by video, with nothing else chosen', () => {
    expect(emptyValues()).toEqual({
      application_id: '', date: '', time: '', duration_minutes: 60, kind: 'video', outcome: '', place: '', interviewer_name: '', notes: '',
    });
  });
  it('a change starts at what is stored, the date and the time as Kuala Lumpur text', () => {
    expect(valuesFrom(row())).toEqual({
      application_id: APP, date: '2026-10-20', time: '15:00', duration_minutes: 60, kind: 'video', outcome: '',
      place: 'https://meet.example.com/abc', interviewer_name: 'Farah Lim', notes: 'Second round.',
    });
    // 23:30 in Kuala Lumpur is still the 20th there, whatever day it is in UTC.
    expect(valuesFrom(row({ scheduledAt: '2026-10-20T15:30:00+00:00' }))).toMatchObject({ date: '2026-10-20', time: '23:30' });
    expect(valuesFrom(row({ place: null, interviewerName: null, notes: null }))).toMatchObject({ place: '', interviewer_name: '', notes: '' });
  });
});

describe('the checks before anything is sent', () => {
  const schedule = (over: Partial<InterviewFormValues>, picking = false) => interviewProblems(values(over), NOW, { mode: 'schedule', picking });

  it('finds nothing wrong with a full form', () => {
    expect(schedule({})).toEqual({});
    expect(schedule({ place: 'x'.repeat(300), interviewer_name: 'y'.repeat(120), notes: 'z'.repeat(2000) })).toEqual({});
  });
  it('asks for the application only when the form has a picker', () => {
    expect(schedule({ application_id: '' }, true)).toEqual({ application_id: 'Choose an application.' });
    expect(schedule({ application_id: '' }, false)).toEqual({});
    expect(CHOOSE_APPLICATION).toBe('Choose an application.');
  });
  it('asks for a date and a time, and refuses a day that does not exist', () => {
    expect(schedule({ date: '', time: '' })).toEqual({ date: 'Choose a date.', time: 'Choose a time.' });
    expect(schedule({ date: '2026-02-31' })).toEqual({ date: 'Use a real date, like 2026-10-31.' });
    expect(schedule({ date: '2027-02-29' })).toEqual({ date: 'Use a real date, like 2026-10-31.' });
    expect(schedule({ time: '25:00' })).toEqual({ time: 'Choose a time.' });
    expect([CHOOSE_DATE, REAL_DATE, CHOOSE_TIME]).toEqual(['Choose a date.', 'Use a real date, like 2026-10-31.', 'Choose a time.']);
  });
  it('refuses a time that has passed in Kuala Lumpur, at the date field, and names the other path', () => {
    // 10:00 is 15 minutes ago; 10:12 is 3, inside the 5 minutes a slow form is allowed.
    expect(schedule({ date: '2026-10-12', time: '10:00' })).toEqual({ date: IN_PAST });
    expect(schedule({ date: '2026-10-12', time: '10:12' })).toEqual({});
    expect(schedule({ date: '2026-10-11', time: '23:59' })).toEqual({ date: IN_PAST });
  });
  it('refuses a date more than 12 months ahead', () => {
    expect(schedule({ date: '2027-10-20' })).toEqual({ date: 'Choose a date within the next 12 months.' });
    expect(schedule({ date: '2027-10-01' })).toEqual({});
  });
  it('refuses a length outside 15 minutes to 8 hours, or one that is not whole minutes', () => {
    for (const minutes of [0, 10, 481, 22.5, Number.NaN]) {
      expect(schedule({ duration_minutes: minutes }), String(minutes)).toEqual({ duration_minutes: 'Choose a length between 15 minutes and 8 hours.' });
    }
    expect(schedule({ duration_minutes: 15 })).toEqual({});
    expect(schedule({ duration_minutes: 480 })).toEqual({});
    expect(BAD_LENGTH).toBe('Choose a length between 15 minutes and 8 hours.');
  });
  it('holds the three text fields to their lengths, counted after the ends are trimmed', () => {
    expect(schedule({ place: 'x'.repeat(301) })).toEqual({ place: 'Keep this under 300 characters.' });
    expect(schedule({ place: `  ${'x'.repeat(300)}  ` })).toEqual({});
    expect(schedule({ interviewer_name: 'y'.repeat(121) })).toEqual({ interviewer_name: 'Keep the interviewer\'s name under 120 characters.' });
    expect(schedule({ notes: 'z'.repeat(2001) })).toEqual({ notes: 'Keep the notes under 2,000 characters.' });
    expect([PLACE_TOO_LONG, INTERVIEWER_TOO_LONG, NOTES_TOO_LONG]).toEqual([
      'Keep this under 300 characters.', 'Keep the interviewer\'s name under 120 characters.', 'Keep the notes under 2,000 characters.',
    ]);
  });
  it('never asks what happened when scheduling or changing', () => {
    expect(schedule({ outcome: '' }).outcome).toBeUndefined();
    expect(interviewProblems(values(), NOW, { mode: 'change', picking: false }).outcome).toBeUndefined();
  });
  it('when changing: a time left as it was is not checked against the clock, and a moved one is', () => {
    const started = values({ date: '2026-10-12', time: '09:00' });
    // The interview began 75 minutes ago: its notes can still be edited.
    expect(interviewProblems({ ...started, notes: 'Running late.' }, NOW, { mode: 'change', picking: false, stored: started })).toEqual({});
    // Moved to another time that has also passed: refused.
    expect(interviewProblems({ ...started, time: '09:30' }, NOW, { mode: 'change', picking: false, stored: started })).toEqual({ date: IN_PAST });
    // Moved to a later one: accepted.
    expect(interviewProblems({ ...started, time: '16:00' }, NOW, { mode: 'change', picking: false, stored: started })).toEqual({});
    // With nothing stored to compare with, the time is checked.
    expect(interviewProblems(started, NOW, { mode: 'change', picking: false })).toEqual({ date: IN_PAST });
  });
  it('a past interview: the start must have passed, within 12 months, and what happened must be chosen', () => {
    const past = (over: Partial<InterviewFormValues>) => interviewProblems(values({ date: '2026-10-06', outcome: 'completed', ...over }), NOW, { mode: 'past', picking: true });
    expect(past({})).toEqual({});
    expect(past({ outcome: 'no_show' })).toEqual({});
    expect(past({ outcome: '' })).toEqual({ outcome: 'Choose what happened.' });
    expect(past({ date: '2026-10-12', time: '11:00' })).toEqual({ date: NOT_PAST });
    expect(past({ date: '2026-10-12', time: '10:15' })).toEqual({});
    expect(past({ date: '2025-10-01' })).toEqual({ date: 'Choose a date within the last 12 months.' });
    expect(past({ application_id: '' })).toEqual({ application_id: 'Choose an application.' });
    expect(CHOOSE_OUTCOME).toBe('Choose what happened.');
  });
  it('names the first wrong field in the order the form shows them', () => {
    expect(firstWrongField({})).toBeNull();
    expect(firstWrongField({ notes: 'x', time: 'x', place: 'x' })).toBe('time');
    expect(firstWrongField({ outcome: 'x', date: 'x', application_id: 'x' })).toBe('application_id');
    expect(firstWrongField({ interviewer_name: 'x', outcome: 'x' })).toBe('outcome');
  });
});

describe('what the form sends', () => {
  it('scheduling: the application, the Kuala Lumpur date and time as typed, and only the details that were given', () => {
    const sent = scheduleInput(values({ place: '  https://meet.example.com/abc ', interviewer_name: ' ', notes: 'Bring the portfolio.\nSecond floor.' }), APP);
    expect(sent).toEqual({
      application_id: APP, date: '2026-10-20', time: '15:00', duration_minutes: 60, kind: 'video',
      place: 'https://meet.example.com/abc', notes: 'Bring the portfolio.\nSecond floor.',
    });
    // A blank field is left out, never sent as an empty string. Never an instant or an offset.
    expect(Object.keys(sent)).not.toContain('interviewer_name');
    expect(Object.keys(scheduleInput(values(), APP)).sort()).toEqual(['application_id', 'date', 'duration_minutes', 'kind', 'time']);
    expect(JSON.stringify(sent)).not.toMatch(/\+08:00|T\d\d:|outcome/);
  });
  it('a past interview: the same with what happened, and nothing while that is not chosen', () => {
    expect(pastInput(values({ date: '2026-10-06', outcome: 'no_show', kind: 'onsite' }), APP)).toEqual({
      application_id: APP, date: '2026-10-06', time: '15:00', duration_minutes: 60, kind: 'onsite', outcome: 'no_show',
    });
    expect(pastInput(values({ date: '2026-10-06' }), APP)).toBeNull();
  });
  it('a change: only what differs, the date and the time together, a cleared field as null', () => {
    const stored = valuesFrom(row());
    expect(changesFrom(stored, stored)).toBeNull();
    expect(changesFrom(stored, { ...stored, time: '11:00' })).toEqual({ date: '2026-10-20', time: '11:00' });
    expect(changesFrom(stored, { ...stored, date: '2026-10-22' })).toEqual({ date: '2026-10-22', time: '15:00' });
    expect(changesFrom(stored, { ...stored, duration_minutes: 90, kind: 'phone' })).toEqual({ duration_minutes: 90, kind: 'phone' });
    expect(changesFrom(stored, { ...stored, place: '', interviewer_name: '   ', notes: '' })).toEqual({ place: null, interviewer_name: null, notes: null });
    expect(changesFrom(stored, { ...stored, place: ' Level 3, Menara Rimba ' })).toEqual({ place: 'Level 3, Menara Rimba' });
    // Spaces at the ends are not a change, and neither is the outcome or the application, which a change never carries.
    expect(changesFrom(stored, { ...stored, interviewer_name: ' Farah Lim ', outcome: 'completed', application_id: 'x' })).toBeNull();
  });
  it('decides what a submit does: schedule, record, change with the time the row was last changed, or nothing', () => {
    expect(submission('schedule', values(), { applicationId: APP, stored: null })).toEqual({ kind: 'schedule', input: scheduleInput(values(), APP) });
    const past = values({ date: '2026-10-06', outcome: 'completed' });
    expect(submission('past', past, { applicationId: APP, stored: null })).toEqual({ kind: 'past', input: pastInput(past, APP) });
    expect(submission('past', values(), { applicationId: APP, stored: null })).toEqual({ kind: 'nothing' });
    const opened = row();
    expect(submission('change', { ...valuesFrom(opened), time: '11:00' }, { applicationId: APP, stored: opened })).toEqual({
      kind: 'change', input: { id: IV, date: '2026-10-20', time: '11:00' }, seen: '2026-10-12T02:05:00+00:00',
    });
    // Nothing differs: nothing is sent, so `updated_at` and the calendar file's sequence do not move.
    expect(submission('change', valuesFrom(opened), { applicationId: APP, stored: opened })).toEqual({ kind: 'nothing' });
    expect(submission('change', values(), { applicationId: APP, stored: null })).toEqual({ kind: 'nothing' });
    expect(NOTHING_CHANGED).toBe('Nothing has been changed yet.');
  });
  it('knows when closing would lose something typed', () => {
    expect(isDirty(emptyValues(), emptyValues())).toBe(false);
    expect(isDirty(emptyValues(), { ...emptyValues(), notes: ' ' })).toBe(true);
    expect(isDirty(emptyValues(), { ...emptyValues(), kind: 'phone' })).toBe(true);
    expect(isDirty(valuesFrom(row()), valuesFrom(row()))).toBe(false);
  });
  it('sends once: no submit and no close while a change is being saved', () => {
    expect(canSubmit(false)).toBe(true);
    expect(canSubmit(true)).toBe(false);
    expect(mayClose(false)).toBe(true);
    expect(mayClose(true)).toBe(false);
  });
});

describe('the form\'s words', () => {
  it('titles', () => {
    expect(dialogTitle('schedule', null)).toBe('Schedule an interview');
    expect(dialogTitle('schedule', 'Aina Rahman')).toBe('Schedule an interview with Aina Rahman');
    expect(dialogTitle('change', 'Aina Rahman')).toBe('Change the interview with Aina Rahman');
    expect(dialogTitle('past', null)).toBe('Record a past interview');
    expect(dialogTitle('past', 'Aina Rahman')).toBe('Record a past interview with Aina Rahman');
  });
  it('descriptions', () => {
    expect(dialogDescription('schedule', null)).toBe('Nothing is sent to the candidate: you get an invitation to copy afterwards.');
    expect(dialogDescription('schedule', 'Sales Executive')).toBe('For Sales Executive. Nothing is sent to the candidate: you get an invitation to copy afterwards.');
    expect(dialogDescription('change', 'Sales Executive')).toBe('For Sales Executive. Nothing is sent to the candidate: you get an invitation to copy afterwards.');
    expect(dialogDescription('past', null)).toBe('For an interview that already took place. Nothing is sent and no invitation is made.');
    expect(dialogDescription('past', 'Sales Executive')).toBe('For Sales Executive. For an interview that already took place. Nothing is sent and no invitation is made.');
  });
  it('buttons, while idle and while saving', () => {
    expect([submitLabel('schedule', false), submitLabel('schedule', true)]).toEqual(['Schedule interview', 'Scheduling…']);
    expect([submitLabel('change', false), submitLabel('change', true)]).toEqual(['Save changes', 'Saving…']);
    expect([submitLabel('past', false), submitLabel('past', true)]).toEqual(['Record interview', 'Recording…']);
  });
  it('the discard question', () => {
    expect(discardTitle('schedule')).toBe('Discard this interview?');
    expect(discardTitle('past')).toBe('Discard this interview?');
    expect(discardTitle('change')).toBe('Discard your changes?');
  });
  it('helpers under the fields, which differ for a past interview', () => {
    expect([dateHelper('schedule'), dateHelper('change')]).toEqual(['In Kuala Lumpur.', 'In Kuala Lumpur.']);
    expect(dateHelper('past')).toBe('The day it took place, in Kuala Lumpur.');
    expect([timeHelper('schedule'), timeHelper('change')]).toEqual(['Kuala Lumpur time (GMT+8).', 'Kuala Lumpur time (GMT+8).']);
    expect(timeHelper('past')).toBe('When it started, Kuala Lumpur time (GMT+8).');
    expect([placeHelper('schedule'), placeHelper('change')]).toEqual(['Optional. Shown in the invitation.', 'Optional. Shown in the invitation.']);
    // No invitation is made for a past interview, so its helper does not mention one.
    expect(placeHelper('past')).toBe('Optional.');
    expect(INTERVIEWER_HELP).toBe('Optional. A name, as you want the candidate to read it.');
    expect(NOTES_HELP).toBe('Optional. For your team only: never in the invitation.');
    expect(OUTCOME_HELP).toBe('Completed if the interview took place. No-show if the candidate did not turn up.');
    expect(FIND_HELP).toBe('Type a name or a job.');
  });
  it('the place field is named after the type', () => {
    expect(placeLabel('video')).toBe('Meeting link');
    expect(placeLabel('onsite')).toBe('Place');
    expect(placeLabel('phone')).toBe('Phone number or details');
  });
  it('the date picker stops at today in Kuala Lumpur: no earlier day to schedule, no later day to record', () => {
    expect(dateBounds('schedule', '2026-10-12')).toEqual({ min: '2026-10-12' });
    expect(dateBounds('change', '2026-10-12')).toEqual({ min: '2026-10-12' });
    expect(dateBounds('past', '2026-10-12')).toEqual({ max: '2026-10-12' });
    // No day known: no bound, and the server's own check still holds.
    expect(dateBounds('schedule', '')).toEqual({});
    expect(dateBounds('past', '')).toEqual({});
  });
  it('the eight lengths, and a stored length that is not among them in its place', () => {
    expect(durationOptions(null).map((o) => o.label)).toEqual([
      '15 minutes', '30 minutes', '45 minutes', '1 hour', '1 hour 30 minutes', '2 hours', '3 hours', '4 hours',
    ]);
    expect(durationOptions(60).map((o) => o.value)).toEqual([15, 30, 45, 60, 90, 120, 180, 240]);
    expect(durationOptions(75)).toEqual(expect.arrayContaining([{ value: 75, label: '1 hour 15 minutes' }]));
    expect(durationOptions(75).map((o) => o.value)).toEqual([15, 30, 45, 60, 75, 90, 120, 180, 240]);
    expect(durationOptions(480).map((o) => o.value).at(-1)).toBe(480);
  });
});

describe('the application picker', () => {
  const list = [
    application('3', 'Zarina binti Hashim', 'Warehouse Supervisor', { stage: 'applied' }),
    application('1', 'aina rahman', 'Sales Executive'),
    application('2', 'Aina Rahman', 'Barista', { stage: 'interview' }),
    application('4', 'Farid bin Osman', 'Sales Executive', { outcome: 'rejected', stage: 'screening' }),
    application('5', 'Mei Ling Tan', 'Driver', { outcome: 'withdrawn', stage: 'offer' }),
  ];
  it('writes an option as name, job and stage; a closed application says its outcome instead', () => {
    expect(pickerLabel(list[0])).toBe('Zarina binti Hashim — Warehouse Supervisor (Applied)');
    expect(pickerLabel(list[2])).toBe('Aina Rahman — Barista (Interview)');
    expect(pickerLabel(list[3])).toBe('Farid bin Osman — Sales Executive (Rejected)');
    expect(pickerLabel(list[4])).toBe('Mei Ling Tan — Driver (Withdrawn)');
  });
  it('scheduling lists active applications only; a past interview lists every one', () => {
    expect(pickerOptions(list, '', 'schedule').options.map((o) => o.id)).toEqual(['2', '1', '3']);
    expect(pickerOptions(list, '', 'past').options.map((o) => o.id)).toEqual(['2', '1', '4', '5', '3']);
    expect(pickerOptions(list, '', 'past').options[2]).toEqual({ id: '4', label: 'Farid bin Osman — Sales Executive (Rejected)' });
  });
  it('filters by any part of the name or the job, in any letter case, and sorts by name then job', () => {
    expect(pickerOptions(list, 'AINA', 'schedule').options.map((o) => o.id)).toEqual(['2', '1']);
    expect(pickerOptions(list, '  sales ', 'schedule').options.map((o) => o.id)).toEqual(['1']);
    expect(pickerOptions(list, 'sales', 'past').options.map((o) => o.id)).toEqual(['1', '4']);
    expect(pickerOptions(list, 'nobody', 'schedule')).toEqual({ options: [], more: false });
    // The list it was given is left in its own order.
    expect(list.map((a) => a.id)).toEqual(['3', '1', '2', '4', '5']);
  });
  it('draws at most 200 options and says when there are more', () => {
    const many = Array.from({ length: 201 }, (_, i) => application(`a${i}`, `Person ${String(i).padStart(3, '0')}`, 'Barista'));
    expect(PICKER_MAX).toBe(200);
    expect(pickerOptions(many, '', 'schedule').options).toHaveLength(200);
    expect(pickerOptions(many, '', 'schedule').more).toBe(true);
    expect(pickerOptions(many.slice(1), '', 'schedule').more).toBe(false);
    expect(pickerOptions(many, 'person 2', 'schedule').more).toBe(false);
  });
  it('says what the list cannot show', () => {
    const QUIET = { none: null, noMatch: null, more: null, cut: null };
    expect(pickerNotes(list, '', 'schedule', false)).toEqual(QUIET);
    expect(pickerNotes(list, 'nobody', 'schedule', false)).toEqual({ ...QUIET, noMatch: 'No active application matches.' });
    // Farid's application is rejected: nothing to schedule for, though he is on file.
    expect(pickerNotes(list, 'farid', 'schedule', false)).toEqual({ ...QUIET, noMatch: 'No active application matches.' });
    expect(pickerNotes([list[3]], '', 'schedule', false)).toEqual({ ...QUIET, none: 'There are no active applications to schedule for.' });
    expect(pickerNotes([], 'x', 'schedule', false)).toEqual({ ...QUIET, none: 'There are no active applications to schedule for.' });
    const many = Array.from({ length: 201 }, (_, i) => application(`a${i}`, `Person ${i}`, 'Barista'));
    expect(pickerNotes(many, '', 'schedule', true)).toEqual({
      ...QUIET,
      more: 'Showing the first 200. Type more of the name.',
      cut: 'Only the newest 1,000 applications are listed here. If the one you want is missing, schedule from its row on the Applications screen.',
    });
  });
  it('the past form\'s notes do not say "active" or "schedule"', () => {
    expect(pickerNotes(list, 'nobody', 'past', false).noMatch).toBe('No application matches.');
    expect(pickerNotes(list, 'farid', 'past', false).noMatch).toBeNull();
    expect(pickerNotes([], '', 'past', false).none).toBe('There are no applications to record an interview for.');
    expect(pickerNotes(list, '', 'past', true).cut)
      .toBe('Only the newest 1,000 applications are listed here. If the one you want is missing, record it from its row on the Applications screen.');
  });
  it('drops a choice the narrowed list no longer shows', () => {
    const { options } = pickerOptions(list, 'aina', 'schedule');
    expect(keptChoice(options, '2')).toBe('2');
    expect(keptChoice(options, '3')).toBe('');
    expect(keptChoice(options, '')).toBe('');
  });
});

describe('what an action answered', () => {
  it('is the change on success and the refusal otherwise; anything malformed is the generic sentence', () => {
    const saved = change();
    expect(interviewResult({ ok: true, data: saved })).toEqual({ ok: true, change: saved });
    expect(interviewResult({ ok: false, error: 'This interview is already scheduled.' })).toEqual({ ok: false, error: 'This interview is already scheduled.' });
    for (const odd of [null, undefined, 'ok', {}, { ok: true }, { ok: true, data: {} }, { ok: true, data: { id: IV } }, { ok: true, data: { id: IV, message: 'x' } }, { ok: false }, { ok: false, error: '' }]) {
      expect(interviewResult(odd), JSON.stringify(odd)).toEqual({ ok: false, error: GENERIC });
    }
  });
  it('the notice is the success sentence, or the note alone when the row could not be read back', () => {
    expect(noticeOf(change())).toBe('Scheduled an interview with Aina Rahman for Tuesday, 20 October 2026, 3:00 pm. Nothing has been sent to them.');
    const NOT_READ = 'Saved. The interview could not be read back, so some details are not shown.';
    expect(noticeOf(change({ confirmed: false, candidate: '', message: 'Scheduled an interview with  for .', note: NOT_READ }))).toBe(NOT_READ);
    expect(noticeOf(change({ confirmed: false, note: undefined }))).toBe(NOT_READ);
  });
  it('finds the word a refusal was made from, by the sentence and by what it was about', () => {
    expect(refusalWord('That application could not be found. It may have been deleted.', 'application')).toBe('not_found');
    expect(refusalWord('That interview could not be found. It may have been deleted with its application.', 'interview')).toBe('not_found');
    expect(refusalWord('That interview could not be found. It may have been deleted with its application.', 'application')).toBeNull();
    expect(refusalWord(IN_PAST, 'application')).toBe('in_past');
    expect(refusalWord('Choose a date within the next 12 months.', 'interview')).toBe('too_far_ahead');
    expect(refusalWord(NOT_PAST, 'application')).toBe('not_past');
    expect(refusalWord('Choose a date within the last 12 months.', 'application')).toBe('too_far_back');
    expect(refusalWord('This application already has an interview at that time.', 'application')).toBe('duplicate');
    expect(refusalWord('This interview was changed a moment ago. Nothing was saved. Check it and try again.', 'interview')).toBe('changed');
    expect(refusalWord('Nothing was changed: the interview already has these details.', 'interview')).toBe('unchanged');
    expect(refusalWord('This interview is no longer scheduled. Mark it as scheduled again first.', 'interview')).toBe('not_scheduled');
    expect(refusalWord('This application is no longer active. Reopen it before scheduling or changing an interview.', 'application')).toBe('not_active');
    expect(refusalWord('This interview is already scheduled.', 'interview')).toBe('not_closed');
    expect(refusalWord('You do not have permission to make changes here.', 'interview')).toBe('forbidden');
    expect(refusalWord(GENERIC, 'interview')).toBeNull();
    expect(refusalWord('', 'interview')).toBeNull();
    expect([onOf('schedule'), onOf('past'), onOf('change')]).toEqual(['application', 'application', 'interview']);
  });
  it('shows a refusal about the time at the date field, a double booking at the time field, and any other in the alert', () => {
    for (const word of ['in_past', 'too_far_ahead', 'not_past', 'too_far_back']) expect(fieldOfRefusal(word), word).toBe('date');
    expect(fieldOfRefusal('duplicate')).toBe('time');
    for (const word of ['not_found', 'forbidden', 'not_active', 'not_scheduled', 'unchanged', 'changed', 'invalid_place', 'whatever', null]) {
      expect(fieldOfRefusal(word), String(word)).toBeNull();
    }
  });
  it('fetches the screen again after a refusal that means it is out of date, and after one it cannot name', () => {
    for (const word of ['changed', 'not_found', 'not_scheduled', 'not_active', null]) expect(refreshAfter(word), String(word)).toBe(true);
    for (const word of ['in_past', 'too_far_ahead', 'not_past', 'too_far_back', 'duplicate', 'unchanged', 'forbidden', 'not_closed']) {
      expect(refreshAfter(word), word).toBe(false);
    }
  });
  it('a row that has gone has its refusal said on the notice line, which outlives the row', () => {
    expect(sayOnNotice('not_found')).toBe(true);
    for (const word of ['not_scheduled', 'changed', 'forbidden', null]) expect(sayOnNotice(word), String(word)).toBe(false);
  });
  it('goes to the invitation step only after scheduling or changing, and only with an invitation to show', () => {
    expect(stepAfter('schedule', change())).toBe('invitation');
    expect(stepAfter('change', change())).toBe('invitation');
    // The row could not be read back: saved, but nothing to hand over here.
    expect(stepAfter('schedule', change({ invitation: null }))).toBe('done');
    expect(stepAfter('change', change({ invitation: '' }))).toBe('done');
    // A past interview never has an invitation step, whatever the result carries.
    expect(stepAfter('past', change({ invitation: null, status: 'completed' }))).toBe('done');
    expect(stepAfter('past', change())).toBe('done');
  });
  it('says where focus goes', () => {
    expect(fieldId('f', 'date')).toBe('f-date');
    expect(focusIdAfter({ after: 'open', picking: true }, 'f')).toBe('f-find');
    expect(focusIdAfter({ after: 'open', picking: false }, 'f')).toBe('f-date');
    expect(focusIdAfter({ after: 'check', problems: { notes: 'x', time: 'x' } }, 'f')).toBe('f-time');
    expect(focusIdAfter({ after: 'check', problems: { outcome: 'x' } }, 'f')).toBe('f-outcome');
    expect(focusIdAfter({ after: 'check', problems: {} }, 'f')).toBeNull();
    expect(focusIdAfter({ after: 'refusal', word: 'in_past' }, 'f')).toBe('f-date');
    expect(focusIdAfter({ after: 'refusal', word: 'duplicate' }, 'f')).toBe('f-time');
    expect(focusIdAfter({ after: 'refusal', word: 'changed' }, 'f')).toBe('f-alert');
    expect(focusIdAfter({ after: 'refusal', word: null }, 'f')).toBe('f-alert');
    expect(focusIdAfter({ after: 'saved' }, 'f')).toBe('f-copy');
  });
});

describe('the invitation step', () => {
  it('titles and words', () => {
    expect(inviteTitle('schedule')).toBe('Interview scheduled');
    expect(inviteTitle('change')).toBe('Interview updated');
    expect(inviteTitle('row')).toBe('Invitation');
    expect(inviteLead('Aina Rahman')).toBe('Nothing has been sent. Copy this into your own email or message to Aina Rahman.');
    expect([copyLabel(false), copyLabel(true)]).toEqual(['Copy invitation', 'Copied']);
    expect(COPY_FAILED).toBe('Couldn\'t copy. Select the text above and copy it yourself.');
    expect(DOWNLOAD_LABEL).toBe('Download calendar file (.ics)');
    expect(DOWNLOAD_HELP).toBe('Opens in most calendar apps. Attach it to your message so the candidate gets a reminder from their own calendar.');
    expect(ICS_MIME).toBe('text/calendar;charset=utf-8');
    expect([moveLabel(false), moveLabel(true)]).toEqual(['Move to Interview', 'Moving…']);
    expect(MOVED).toBe('Moved to Interview.');
    expect(DONE).toBe('Done');
  });
  // Final-review fix pass. The plan's `inviteSourceOfRow` and `inviteSourceOfChange` (and their tests) are gone: the
  // browser no longer makes an invitation or a file out of a row. Both come from the server, as given.
  it('reads the invitation and the calendar file the server made for a row, and fails closed on anything else', () => {
    const made = { text: 'Hi Aina Rahman,', ics: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n', fileName: 'interview-aina-rahman-2026-10-20.ics' };
    expect(handoverResult({ ok: true, data: made })).toEqual({
      ok: true,
      handover: { text: 'Hi Aina Rahman,', file: { name: 'interview-aina-rahman-2026-10-20.ics', content: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n' } },
    });
    const SENTENCE = 'This interview is no longer scheduled. Mark it as scheduled again first.';
    expect(handoverResult({ ok: false, error: SENTENCE })).toEqual({ ok: false, error: SENTENCE });
    const NOT_MADE = 'The invitation could not be made just now. Please try again.';
    for (const odd of [
      null, undefined, 'ok', {}, { ok: true }, { ok: true, data: {} }, { ok: true, data: { ...made, text: '' } }, { ok: true, data: { ...made, ics: '' } },
      { ok: true, data: { ...made, fileName: '' } }, { ok: true, data: { ...made, ics: 7 } }, { ok: false }, { ok: false, error: '' },
    ]) {
      expect(handoverResult(odd), JSON.stringify(odd)).toEqual({ ok: false, error: NOT_MADE });
    }
  });
  it('reads the calendar file that came beside a saved change, or none', () => {
    const calendar = { ics: 'BEGIN:VCALENDAR\r\n', fileName: 'interview-aina-rahman-2026-10-20.ics' };
    expect(calendarOf({ ...change(), calendar })).toEqual({ name: 'interview-aina-rahman-2026-10-20.ics', content: 'BEGIN:VCALENDAR\r\n' });
    for (const odd of [change(), { ...change(), calendar: null }, { ...change(), calendar: { ics: '', fileName: 'x.ics' } }, { ...change(), calendar: { ics: 'x' } }, null, 'x']) {
      expect(calendarOf(odd), JSON.stringify(odd)).toBeNull();
    }
  });
  it('a row\'s invitation is asked for once at a time: a second press while it loads, or while a change is saved, does nothing', () => {
    expect(mayAskHandover('idle', false)).toBe(true);
    expect(mayAskHandover('loading', false)).toBe(false);
    expect(mayAskHandover('shown', false)).toBe(false);
    expect(mayAskHandover('idle', true)).toBe(false);
    // Ask, then the answer opens the panel; a refusal goes back to idle with nothing open; closing the panel is idle again.
    expect(handoverAfter('idle', 'ask')).toBe('loading');
    expect(handoverAfter('loading', 'ask')).toBe('loading');
    expect(handoverAfter('loading', 'made')).toBe('shown');
    expect(handoverAfter('loading', 'refused')).toBe('idle');
    expect(handoverAfter('shown', 'closed')).toBe('idle');
    // An answer nobody is waiting for opens nothing.
    expect(handoverAfter('idle', 'made')).toBe('idle');
    expect(handoverAfter('shown', 'ask')).toBe('shown');
  });
  it('says what the row is waiting for', () => {
    expect(GETTING_INVITATION).toBe('Getting the invitation…');
    expect(rowWaitingWord(false, 'idle')).toBe('');
    expect(rowWaitingWord(false, 'loading')).toBe('Getting the invitation…');
    expect(rowWaitingWord(true, 'idle')).toBe('Saving…');
    expect(rowWaitingWord(false, 'shown')).toBe('');
    // Fetching the invitation is not saving anything.
    expect(rowWaitingWord(true, 'loading')).toBe('Getting the invitation…');
  });
  it('offers Move to Interview only for an active application at Applied or Screening', () => {
    expect(offersMove(change({ application_stage: 'applied' }))).toBe(true);
    expect(offersMove(change({ application_stage: 'screening' }))).toBe(true);
    for (const stage of ['interview', 'offer', 'hired'] as const) expect(offersMove(change({ application_stage: stage })), stage).toBe(false);
    expect(offersMove(change({ application_outcome: 'rejected' }))).toBe(false);
    // Not known (the row was not read back): not offered.
    expect(offersMove(change({ application_stage: null }))).toBe(false);
    expect(offersMove(change({ application_outcome: null }))).toBe(false);
    expect(offersMove(change({ application_id: null }))).toBe(false);
  });
  it('the move sends the application to Interview and nothing else', () => {
    expect(moveInput(APP)).toEqual({ id: APP, stage: 'interview' });
    expect(moveResult({ ok: true, data: { id: APP } })).toEqual({ ok: true });
    expect(moveResult({ ok: false, error: 'This application is already at that stage.' })).toEqual({ ok: false, error: 'This application is already at that stage.' });
    for (const odd of [null, undefined, {}, { ok: false }, 'ok']) expect(moveResult(odd)).toEqual({ ok: false, error: GENERIC });
  });
});

describe('a row of the Interviews table', () => {
  it('offers what the status allows, grouped as the menu draws it', () => {
    expect(rowMenu(row())).toEqual(['edit', 'invitation', 'completed', 'no_show', 'cancel']);
    expect(menuGroups(rowMenu(row()))).toEqual([['edit', 'invitation'], ['completed', 'no_show'], ['cancel']]);
    // The application was rejected: a change would be refused, so it is not offered. Cancelling is.
    expect(menuGroups(rowMenu(row({ applicationOutcome: 'rejected' })))).toEqual([['invitation'], ['completed', 'no_show'], ['cancel']]);
    for (const statusKey of ['cancelled', 'completed', 'no_show'] as const) {
      expect(menuGroups(rowMenu(row({ statusKey }))), statusKey).toEqual([['reopen']]);
    }
    expect(menuGroups([])).toEqual([]);
  });
  it('names every item and the menu\'s button', () => {
    expect(MENU_WORDS).toEqual({
      edit: 'Reschedule or edit', invitation: 'Invitation and calendar file', completed: 'Mark completed', no_show: 'Mark no-show',
      cancel: 'Cancel interview', reopen: 'Mark as scheduled again',
    });
    expect(menuName('Aina Rahman')).toBe('Actions for the interview with Aina Rahman');
    expect(outcomeInput(IV, 'no_show')).toEqual({ id: IV, outcome: 'no_show' });
  });
  it('tags a scheduled row that needs an outcome, or whose application is closed', () => {
    expect(tagsFor(row())).toEqual([]);
    expect(tagsFor(row({ needsOutcome: true }))).toEqual(['Needs an outcome']);
    expect(tagsFor(row({ applicationOutcome: 'rejected' }))).toEqual(['Application rejected']);
    expect(tagsFor(row({ applicationOutcome: 'withdrawn' }))).toEqual(['Application withdrawn']);
    expect(tagsFor(row({ needsOutcome: true, applicationOutcome: 'rejected' }))).toEqual(['Needs an outcome', 'Application rejected']);
    // A closed interview needs no warning about its application.
    expect(tagsFor(row({ statusKey: 'cancelled', applicationOutcome: 'rejected' }))).toEqual([]);
    expect(tagsFor(row({ statusKey: 'completed', applicationOutcome: 'withdrawn' }))).toEqual([]);
  });
  it('writes the time with the length', () => {
    // Changed from the plan's 24-hour `15:00`: a row's time now reads as the invitation's does (Task 2's review).
    expect(timeCell(row())).toBe('3:00 pm · 1 hour');
    expect(timeCell(row({ time: '9:30 am', length: '1 hour 30 minutes' }))).toBe('9:30 am · 1 hour 30 minutes');
  });
  it('the cancel confirm names the job and the time, and says nobody is told', () => {
    expect(cancelTitle('Aina Rahman')).toBe('Cancel the interview with Aina Rahman?');
    expect(cancelBody(row()))
      .toBe('Sales Executive, Tuesday, 20 October 2026, 3:00 pm. It stays in the list as cancelled. Nothing is sent to Aina Rahman: you will need to tell them.');
    expect(KEEP_INTERVIEW).toBe('Keep interview');
    expect([cancelLabel(false), cancelLabel(true)]).toEqual(['Cancel interview', 'Cancelling…']);
  });
  it('gives every opener an id that is the same when its card or row is drawn again', () => {
    expect(openerId('header-schedule')).toBe('hire-interview-header-schedule');
    expect(openerId('header-past')).toBe('hire-interview-header-past');
    expect(openerId('row', IV)).toBe(`hire-interview-row-${IV}`);
    expect(openerId('card', APP)).toBe(`hire-interview-card-${APP}`);
    expect(openerId('panel-schedule', APP)).not.toBe(openerId('panel-past', APP));
  });
});

describe('the Applications panel', () => {
  it('writes one line an interview, leaving out an interviewer nobody gave', () => {
    expect(panelLine(row())).toBe('Tue 20 Oct 2026, 3:00 pm · 1 hour · Video call · Farah Lim · Scheduled');
    expect(panelLine(row({ interviewer: '—', interviewerName: null, kind: 'onsite', status: 'No-show', statusKey: 'no_show', length: '45 minutes' })))
      .toBe('Tue 20 Oct 2026, 3:00 pm · 45 minutes · In person · No-show');
    expect([PANEL_HEADING, PANEL_EMPTY, PANEL_ROWS]).toEqual(['Interviews', 'No interviews yet.', 5]);
  });
  it('shows at most five and counts the rest', () => {
    const seven = Array.from({ length: 7 }, (_, i) => row({ id: `iv${i}` }));
    expect(panelRows(seven).shown.map((r) => r.id)).toEqual(['iv0', 'iv1', 'iv2', 'iv3', 'iv4']);
    expect(panelRows(seven).more).toBe(2);
    expect(panelRows(seven.slice(0, 5))).toEqual({ shown: seven.slice(0, 5), more: 0 });
    expect(panelRows([])).toEqual({ shown: [], more: 0 });
    expect(panelMore(2)).toBe('and 2 more on the Interviews screen');
    expect(panelMore(1)).toBe('and 1 more on the Interviews screen');
  });
  it('after a rejection or a withdrawal, says how many interviews are still scheduled', () => {
    const closed = (data: Record<string, unknown>) => ({ ok: true, data: { id: APP, candidate: 'Aina Rahman', job: 'Sales Executive', ...data } });
    expect(stillScheduledNotice(closed({ scheduled_interviews: 1 }), 'Aina'))
      .toBe('1 interview with Aina Rahman is still scheduled. Cancel it on the Interviews screen if it should not go ahead.');
    expect(stillScheduledNotice(closed({ scheduled_interviews: 2 }), 'Aina'))
      .toBe('2 interviews with Aina Rahman are still scheduled. Cancel them on the Interviews screen if they should not go ahead.');
    // The row was not read back, so the result has no name: the one the control already shows is used.
    expect(stillScheduledNotice(closed({ candidate: '', scheduled_interviews: 1 }), 'Aina Rahman'))
      .toBe('1 interview with Aina Rahman is still scheduled. Cancel it on the Interviews screen if it should not go ahead.');
    for (const none of [closed({ scheduled_interviews: 0 }), closed({}), closed({ scheduled_interviews: '2' }), closed({ scheduled_interviews: 1.5 }), { ok: false, error: 'x' }, { ok: true }, null, undefined]) {
      expect(stillScheduledNotice(none, 'Aina Rahman'), JSON.stringify(none)).toBeNull();
    }
  });
});

// Final-review fix pass. A form refused as stale ("changed a moment ago") used to keep its stale copy, so Save could
// never succeed until the dialog was closed and opened again.
describe('after someone else changed the interview behind an open form', () => {
  const CHANGED = 'This interview was changed a moment ago. Nothing was saved. Check it and try again.';
  const NOT_LOADED = 'The interview could not be loaded just now. Close this and open it again.';
  const stored = {
    id: IV, scheduled_at: '2026-10-22T08:00:00+00:00', duration_minutes: 90, kind: 'onsite', place: 'Level 3, Menara Rimba', interviewer_name: null,
    notes: 'Moved by Farah.', status: 'scheduled', updated_at: '2026-10-12T02:30:00.654321+00:00',
  };
  it('reads the interview as it stands now, for that interview only, and fails closed on anything else', () => {
    expect(currentResult({ ok: true, data: stored }, IV)).toEqual({
      ok: true,
      current: {
        scheduledAt: '2026-10-22T08:00:00+00:00', durationMinutes: 90, kind: 'onsite', place: 'Level 3, Menara Rimba', interviewerName: null,
        notes: 'Moved by Farah.', updatedAt: '2026-10-12T02:30:00.654321+00:00',
      },
    });
    const GONE = 'That interview could not be found. It may have been deleted with its application.';
    expect(currentResult({ ok: false, error: GONE }, IV)).toEqual({ ok: false, error: GONE });
    for (const odd of [
      null, undefined, {}, { ok: true }, { ok: false }, { ok: true, data: { ...stored, id: 'another' } }, { ok: true, data: { ...stored, scheduled_at: '2026-10-22T16:00:00' } },
      { ok: true, data: { ...stored, updated_at: '' } }, { ok: true, data: { ...stored, kind: 'lunch' } }, { ok: true, data: { ...stored, duration_minutes: '90' } },
      { ok: true, data: { ...stored, status: 'cancelled' } }, { ok: true, data: { ...stored, place: 7 } },
    ]) {
      expect(currentResult(odd, IV), JSON.stringify(odd)).toEqual({ ok: false, error: NOT_LOADED });
    }
  });
  it('makes the row the form is opened afresh with: the current values and the current `seen`, and whose interview it is unchanged', () => {
    const result = currentResult({ ok: true, data: stored }, IV);
    if (!result.ok) throw new Error('unreachable');
    const fresh = rowWithCurrent(row(), result.current);
    expect(fresh).toMatchObject({
      id: IV, name: 'Aina Rahman', role: 'Sales Executive', applicationId: APP,
      scheduledAt: '2026-10-22T08:00:00+00:00', durationMinutes: 90, length: '1 hour 30 minutes', kind: 'onsite', time: '4:00 pm',
      place: 'Level 3, Menara Rimba', placeLink: null, interviewer: '—', interviewerName: null, notes: 'Moved by Farah.',
      updatedAt: '2026-10-12T02:30:00.654321+00:00',
    });
    // The form then starts at the current values: 4:00 pm on the 22nd in Kuala Lumpur.
    expect(valuesFrom(fresh)).toEqual({
      application_id: APP, date: '2026-10-22', time: '16:00', duration_minutes: 90, kind: 'onsite', outcome: '', place: 'Level 3, Menara Rimba',
      interviewer_name: '', notes: 'Moved by Farah.',
    });
    // And a save from it sends the current `seen`, with only what the person then changes.
    expect(submission('change', { ...valuesFrom(fresh), notes: 'Confirmed.' }, { applicationId: APP, stored: fresh })).toEqual({
      kind: 'change', input: { id: IV, notes: 'Confirmed.' }, seen: '2026-10-12T02:30:00.654321+00:00',
    });
    // The row it was made from is left as it was.
    expect(row().updatedAt).toBe('2026-10-12T02:05:00+00:00');
  });
  it('offers to load the current details only after that refusal, only once they were read, and never while saving', () => {
    expect(offersReload('changed', true, false)).toBe(true);
    expect(offersReload('changed', false, false)).toBe(false);
    expect(offersReload('changed', true, true)).toBe(false);
    for (const word of ['not_found', 'not_scheduled', 'in_past', 'duplicate', 'unchanged', null]) expect(offersReload(word, true, false), String(word)).toBe(false);
    expect(refusalWord(CHANGED, 'interview')).toBe('changed');
  });
  it('never sends again by itself: a stale form keeps its own `seen` until the person loads the current details', () => {
    const opened = row();
    const typed = { ...valuesFrom(opened), notes: 'My own note.' };
    // The same form, submitted again without loading: still the old `seen`, so the database refuses it again.
    expect(submission('change', typed, { applicationId: APP, stored: opened })).toMatchObject({ seen: '2026-10-12T02:05:00+00:00' });
    expect(LOAD_CURRENT).toBe('Load the current details');
    expect(LOAD_CURRENT_HELP).toBe('This replaces what you typed with the interview as it is now. Nothing is saved until you save again.');
  });
});

// Not in the plan: added by Task 3. A calendar file made from a start with no zone would carry an empty DTSTART,
// and an invitation would show the text as stored where the date belongs. Neither is handed to a candidate.
describe('a time that is not an instant', () => {
  const ZONELESS = ['2026-10-20T15:00:00', '2026-10-20', '', 'soon'];
  const REST = ['edit', 'completed', 'no_show', 'cancel'];
  it('shows no invitation step after a save whose start cannot be read', () => {
    for (const odd of ZONELESS) {
      expect(stepAfter('schedule', change({ scheduled_at: odd })), odd).toBe('done');
      expect(stepAfter('change', change({ scheduled_at: odd })), odd).toBe('done');
    }
    expect(stepAfter('schedule', change({ scheduled_at: null }))).toBe('done');
  });
  it('leaves "Invitation and calendar file" out of the row\'s menu, and keeps the rest', () => {
    for (const odd of ZONELESS) {
      expect(rowMenu(row({ scheduledAt: odd })), odd).toEqual(REST);
      expect(rowMenu(row({ createdAt: odd })), odd).toEqual(REST);
      expect(rowMenu(row({ updatedAt: odd })), odd).toEqual(REST);
    }
    expect(rowMenu(row({ scheduledAt: '2026-10-20T15:00:00', statusKey: 'cancelled' }))).toEqual(['reopen']);
  });
  it('tells the time by the server\'s clock and how long the page has been open, whatever the browser\'s clock says', () => {
    const SERVER = '2026-10-12T02:15:00.000Z';
    // The browser's clock is nine hours fast: only the ten minutes between its two readings count.
    const received = Date.parse('2026-10-12T11:15:00Z');
    expect(clockAt(SERVER, received, received + 600_000).toISOString()).toBe('2026-10-12T02:25:00.000Z');
    expect(clockAt(SERVER, null, received).toISOString()).toBe(SERVER);
    // A browser clock that was set back meanwhile never takes the time backwards.
    expect(clockAt(SERVER, received, received - 5_000).toISOString()).toBe(SERVER);
    for (const odd of ['2026-10-12T02:15:00', '', 'now']) expect(Number.isNaN(clockAt(odd, received, received).getTime()), odd).toBe(true);
  });
  it('a newly scheduled interview that the server gave no invitation (its start had just passed) is done, with no error', () => {
    expect(stepAfter('schedule', change({ invitation: null, scheduled_at: '2026-10-12T02:12:00+00:00' }))).toBe('done');
    expect(noticeOf(change({ invitation: null }))).toContain('Scheduled an interview with Aina Rahman');
  });
  it('a scheduled interview whose start has passed offers no invitation either', () => {
    expect(rowMenu(row({ needsOutcome: true }))).toEqual(REST);
    expect(rowMenu(row({ needsOutcome: true, applicationOutcome: 'rejected' }))).toEqual(['completed', 'no_show', 'cancel']);
  });
});
