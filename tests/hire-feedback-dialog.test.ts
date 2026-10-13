// tests/hire-feedback-dialog.test.ts
import { describe, expect, it } from 'vitest';
import {
  CLEAR_BODY, COMMENTS_HELP, FEEDBACK_CLEARED_MEANWHILE, FEEDBACK_MENU_WORDS, KEEP_FEEDBACK, LOAD_CURRENT_FEEDBACK, LOAD_CURRENT_FEEDBACK_HELP, RATINGS, RATING_HELP,
  RECOMMENDATION_HELP, ROW_MENU_WORDS, charactersLeft, clearLabel, clearTitle, countAnnouncement, countShown, countText, currentFeedbackResult, emptyFeedback,
  feedbackDialogDescription, feedbackDialogTitle, feedbackDiscardTitle, feedbackFieldId, feedbackFocusIdAfter, feedbackGone, feedbackNotice, feedbackProblems,
  feedbackRefreshAfter, feedbackRefusalWord, feedbackResult, feedbackSubmission, feedbackSubmitLabel, firstWrongFeedbackField, isDestructive, isFeedbackDirty, modeOf,
  offersFeedbackReload, panelShowsHelper, ratingId, ratingSpoken, recommendationId, reopenRefusal, rowMenuWithFeedback, startingValues, valuesFromFeedback,
  type FeedbackFormValues,
} from '@/lib/hire/feedback-dialog-state';
import type { Feedback } from '@/lib/hire/interview-feedback';
import { MENU_WORDS, canSubmit, mayClose } from '@/lib/hire/interview-dialog-state';
import type { InterviewRow } from '@/lib/hire/lists';

const IV = '77777777-7777-4777-8777-777777777777';
const SAVED_AT = '2026-10-21T02:05:40.123456+00:00';
const STORED: Feedback = { rating: 4, recommendation: 'advance', comments: 'Strong on key accounts.', recorded_at: SAVED_AT };
const GENERIC = 'That change could not be saved. Please try again.';
const NOT_LOADED = 'The feedback could not be loaded just now. Close this and open it again.';
const row = (over: Partial<InterviewRow> = {}): InterviewRow => ({
  id: IV, name: 'Aina Rahman', role: 'Sales Executive', date: '20 Oct 2026', time: '3:00 pm', interviewer: 'Farah Lim', type: 'Video', status: 'Scheduled',
  applicationId: 'a1', statusKey: 'scheduled', scheduledAt: '2026-10-20T07:00:00+00:00', durationMinutes: 60, length: '1 hour', kind: 'video',
  place: null, placeLink: null, interviewerName: 'Farah Lim', notes: null, createdAt: '2026-10-12T02:00:00+00:00', updatedAt: '2026-10-12T02:05:00+00:00',
  applicationStage: 'screening', applicationOutcome: 'active', needsOutcome: false, ...over,
});
const filled: FeedbackFormValues = { rating: 4, recommendation: 'advance', comments: 'Strong on key accounts.' };

describe('the form\'s values and checks', () => {
  it('starts empty when adding or completing, and at what is stored when editing', () => {
    expect(emptyFeedback()).toEqual({ rating: null, recommendation: '', comments: '' });
    expect(valuesFromFeedback(STORED)).toEqual(filled);
    expect(valuesFromFeedback({ ...STORED, comments: null })).toEqual({ ...filled, comments: '' });
    expect(startingValues('edit', STORED)).toEqual(filled);
    expect(startingValues('add', STORED)).toEqual(emptyFeedback());
    expect(startingValues('complete', null)).toEqual(emptyFeedback());
    expect(startingValues('edit', null)).toEqual(emptyFeedback());
    expect(RATINGS).toEqual([1, 2, 3, 4, 5]);
  });
  it('needs a rating and a recommendation, and comments within 2,000 characters', () => {
    expect(feedbackProblems(emptyFeedback())).toEqual({ rating: 'Choose a rating from 1 to 5.', recommendation: 'Choose a recommendation.' });
    expect(feedbackProblems(filled)).toEqual({});
    expect(feedbackProblems({ ...filled, comments: '' })).toEqual({});
    expect(feedbackProblems({ ...filled, comments: 'c'.repeat(2000) })).toEqual({});
    expect(feedbackProblems({ ...filled, comments: 'c'.repeat(2001) })).toEqual({ comments: 'Keep the comments under 2,000 characters.' });
    // Spaces at the ends are not counted: the database trims them.
    expect(feedbackProblems({ ...filled, comments: `  ${'c'.repeat(2000)}  ` })).toEqual({});
    for (const rating of [0, 6, 3.5]) expect(feedbackProblems({ ...filled, rating }), String(rating)).toEqual({ rating: 'Choose a rating from 1 to 5.' });
  });
  it('the first wrong field is in the order the form shows them', () => {
    expect(firstWrongFeedbackField({ comments: 'x', recommendation: 'y', rating: 'z' })).toBe('rating');
    expect(firstWrongFeedbackField({ comments: 'x', recommendation: 'y' })).toBe('recommendation');
    expect(firstWrongFeedbackField({ comments: 'x' })).toBe('comments');
    expect(firstWrongFeedbackField({})).toBeNull();
  });
});

describe('what is sent', () => {
  it('adding: the three values, no switch, and no version', () => {
    expect(feedbackSubmission('add', filled, { id: IV, stored: null })).toEqual({
      kind: 'save', input: { id: IV, rating: 4, recommendation: 'advance', comments: 'Strong on key accounts.' }, seen: null,
    });
  });
  it('"Mark completed and add feedback": mark_completed, and only from there', () => {
    const sent = feedbackSubmission('complete', filled, { id: IV, stored: null });
    expect(sent).toEqual({ kind: 'save', input: { id: IV, rating: 4, recommendation: 'advance', comments: 'Strong on key accounts.', mark_completed: true }, seen: null });
    for (const mode of ['add', 'edit'] as const) {
      expect(JSON.stringify(feedbackSubmission(mode, { ...filled, rating: 5 }, { id: IV, stored: STORED })), mode).not.toContain('mark_completed');
    }
  });
  it('editing: replace, and the version the form was opened on exactly as it was read; never when adding', () => {
    const sent = feedbackSubmission('edit', { ...filled, recommendation: 'reject' }, { id: IV, stored: STORED });
    expect(sent).toEqual({ kind: 'save', input: { id: IV, rating: 4, recommendation: 'reject', comments: 'Strong on key accounts.', replace: true }, seen: SAVED_AT });
    expect(JSON.stringify(feedbackSubmission('add', filled, { id: IV, stored: null }))).not.toContain('replace');
    expect(JSON.stringify(feedbackSubmission('complete', filled, { id: IV, stored: null }))).not.toContain('replace');
  });
  it('blank comments are sent as null, and comments are trimmed', () => {
    for (const comments of ['', '   ', '\n']) {
      const sent = feedbackSubmission('add', { ...filled, comments }, { id: IV, stored: null });
      expect(sent.kind === 'save' && sent.input.comments, JSON.stringify(comments)).toBeNull();
    }
    const sent = feedbackSubmission('add', { ...filled, comments: '  Good.\nClear.  ' }, { id: IV, stored: null });
    expect(sent.kind === 'save' && sent.input.comments).toBe('Good.\nClear.');
  });
  it('never sends a basis: that is the assistant\'s field', () => {
    for (const mode of ['add', 'edit', 'complete'] as const) {
      expect(JSON.stringify(feedbackSubmission(mode, { ...filled, rating: 1 }, { id: IV, stored: STORED })), mode).not.toContain('basis');
    }
  });
  it('sends nothing when editing changed nothing, when there is nothing stored to edit, or when a value is missing', () => {
    expect(feedbackSubmission('edit', filled, { id: IV, stored: STORED })).toEqual({ kind: 'nothing' });
    expect(feedbackSubmission('edit', { ...filled, comments: '  Strong on key accounts.  ' }, { id: IV, stored: STORED })).toEqual({ kind: 'nothing' });
    expect(feedbackSubmission('edit', { ...filled, rating: 5 }, { id: IV, stored: null })).toEqual({ kind: 'nothing' });
    expect(feedbackSubmission('add', { ...filled, rating: null }, { id: IV, stored: null })).toEqual({ kind: 'nothing' });
    expect(feedbackSubmission('add', { ...filled, recommendation: '' }, { id: IV, stored: null })).toEqual({ kind: 'nothing' });
  });
  it('knows when closing would lose something', () => {
    expect(isFeedbackDirty(emptyFeedback(), emptyFeedback())).toBe(false);
    expect(isFeedbackDirty(emptyFeedback(), { ...emptyFeedback(), comments: '  ' })).toBe(false);
    expect(isFeedbackDirty(emptyFeedback(), { ...emptyFeedback(), rating: 3 })).toBe(true);
    expect(isFeedbackDirty(emptyFeedback(), { ...emptyFeedback(), recommendation: 'hold' })).toBe(true);
    expect(isFeedbackDirty(filled, { ...filled, comments: 'Strong.' })).toBe(true);
    expect(isFeedbackDirty(filled, filled)).toBe(false);
  });
  it('one send at a time, and no closing while it is saved', () => {
    expect(canSubmit(false)).toBe(true);
    expect(canSubmit(true)).toBe(false);
    expect(mayClose(true)).toBe(false);
    expect(feedbackSubmitLabel(false)).toBe('Save feedback');
    expect(feedbackSubmitLabel(true)).toBe('Saving…');
  });
});

describe('the count of characters left', () => {
  it('is shown once fewer than 200 remain, and never goes below 0', () => {
    expect(charactersLeft('')).toBe(2000);
    expect(charactersLeft('c'.repeat(1800))).toBe(200);
    expect(countShown(200)).toBe(false);
    expect(countShown(199)).toBe(true);
    expect(countShown(0)).toBe(true);
    expect(countText(150)).toBe('150 characters left');
    expect(countText(1)).toBe('1 character left');
    expect(countText(0)).toBe('0 characters left');
    expect(countText(-3)).toBe('0 characters left');
  });
  it('is read out when it first appears and when it reaches 0, not on every keystroke', () => {
    expect(countAnnouncement(200, 199)).toBe('199 characters left');
    expect(countAnnouncement(500, 150)).toBe('150 characters left');
    expect(countAnnouncement(199, 198)).toBe('');
    expect(countAnnouncement(1, 0)).toBe('0 characters left');
    expect(countAnnouncement(0, 0)).toBe('');
    expect(countAnnouncement(150, 300)).toBe('');
  });
});

describe('the dialog\'s words', () => {
  const at = { name: 'Aina Rahman', role: 'Sales Executive', scheduledAt: '2026-10-20T07:00:00+00:00' };
  it('titles, descriptions with the date and its year, and the discard question', () => {
    expect(feedbackDialogTitle('add', 'Aina Rahman')).toBe('Add feedback on the interview with Aina Rahman');
    expect(feedbackDialogTitle('edit', 'Aina Rahman')).toBe('Edit feedback on the interview with Aina Rahman');
    expect(feedbackDialogTitle('complete', 'Aina Rahman')).toBe('Mark completed and add feedback');
    expect(feedbackDialogDescription('add', at)).toBe('Sales Executive, Tuesday, 20 October 2026, 3:00 pm.');
    expect(feedbackDialogDescription('edit', at)).toBe('Sales Executive, Tuesday, 20 October 2026, 3:00 pm.');
    expect(feedbackDialogDescription('complete', at))
      .toBe('Interview with Aina Rahman for Sales Executive, Tuesday, 20 October 2026, 3:00 pm. Saving also marks it completed.');
    expect(feedbackDiscardTitle('add')).toBe('Discard this feedback?');
    expect(feedbackDiscardTitle('complete')).toBe('Discard this feedback?');
    expect(feedbackDiscardTitle('edit')).toBe('Discard your changes?');
  });
  it('helpers, and how a rating is read out', () => {
    expect(RATING_HELP).toBe('1 is the lowest, 5 the highest.');
    expect(RECOMMENDATION_HELP).toBe('A note for whoever decides. It does not move or reject the application.');
    expect(COMMENTS_HELP).toBe('Optional. What the interview showed that bears on the job.');
    expect(ratingSpoken(4)).toBe('4 out of 5');
  });
  it('the clear confirm', () => {
    expect(clearTitle('Aina Rahman')).toBe('Clear the feedback on the interview with Aina Rahman?');
    expect(CLEAR_BODY).toBe('The rating, the recommendation and the comments are removed. The interview stays completed. This can\'t be undone.');
    expect(KEEP_FEEDBACK).toBe('Keep feedback');
    expect(clearLabel(false)).toBe('Clear feedback');
    expect(clearLabel(true)).toBe('Clearing…');
  });
});

describe('what an action answered', () => {
  const change = { id: IV, candidate: 'Aina Rahman', job: 'Sales Executive', status: 'completed', scheduled_at: null, feedback: STORED, replaced: false, marked_completed: false,
    message: 'Saved feedback on the interview with Aina Rahman: 4 out of 5, advance.', confirmed: true };
  it('a saved change, a refusal in its own words, and anything malformed fails closed', () => {
    expect(feedbackResult({ ok: true, data: change })).toEqual({ ok: true, change });
    expect(feedbackResult({ ok: false, error: 'This interview already has feedback. Open it to edit it.' })).toEqual({ ok: false, error: 'This interview already has feedback. Open it to edit it.' });
    for (const bad of [null, undefined, 'ok', {}, { ok: true }, { ok: true, data: { id: IV } }, { ok: false }, { ok: false, error: '' }, { ok: true, data: { ...change, confirmed: 'yes' } }]) {
      expect(feedbackResult(bad), JSON.stringify(bad)).toEqual({ ok: false, error: GENERIC });
    }
  });
  it('the notice is the sentence, or the note when the row could not be read back', () => {
    expect(feedbackNotice(change as never)).toBe(change.message);
    expect(feedbackNotice({ ...change, confirmed: false, note: 'Saved. The interview could not be read back, so some details are not shown.' } as never))
      .toBe('Saved. The interview could not be read back, so some details are not shown.');
    expect(feedbackNotice({ ...change, confirmed: false } as never)).toBe('Saved. The interview could not be read back, so some details are not shown.');
  });
  it('finds the word a refusal was made from, and what follows it', () => {
    expect(feedbackRefusalWord('This interview already has feedback. Open it to edit it.')).toBe('has_feedback');
    expect(feedbackRefusalWord('The feedback on this interview was changed a moment ago. Nothing was saved. Check it and try again.')).toBe('changed');
    expect(feedbackRefusalWord('Feedback is for a completed interview. Mark this one completed first.')).toBe('not_completed');
    expect(feedbackRefusalWord('That interview could not be found. It may have been deleted with its application.')).toBe('not_found');
    expect(feedbackRefusalWord('You do not have permission to make changes here.')).toBe('forbidden');
    expect(feedbackRefusalWord(GENERIC)).toBeNull();
    expect(feedbackRefusalWord('')).toBeNull();
    // The screen is fetched again whenever someone else changed the row, and when it is not known what happened.
    for (const word of ['changed', 'has_feedback', 'not_completed', 'not_found', null]) expect(feedbackRefreshAfter(word), String(word)).toBe(true);
    expect(feedbackRefreshAfter('forbidden')).toBe(false);
    expect(feedbackGone('not_found')).toBe(true);
    expect(feedbackGone('changed')).toBe(false);
    expect(feedbackGone(null)).toBe(false);
  });
  it('"Load the current feedback": only after "changed", only once it was read, and not while saving', () => {
    expect(LOAD_CURRENT_FEEDBACK).toBe('Load the current feedback');
    expect(LOAD_CURRENT_FEEDBACK_HELP).toBe('This replaces what you typed with the feedback as it is now. Nothing is saved until you save again.');
    expect(offersFeedbackReload('changed', true, false)).toBe(true);
    expect(offersFeedbackReload('changed', false, false)).toBe(false);
    expect(offersFeedbackReload('changed', true, true)).toBe(false);
    expect(offersFeedbackReload('has_feedback', true, false)).toBe(false);
    expect(offersFeedbackReload(null, true, false)).toBe(false);
  });
  it('the current feedback, read after "changed": whole and for this interview, or nothing', () => {
    expect(currentFeedbackResult({ ok: true, data: { id: IV, status: 'completed', feedback: STORED } }, IV)).toEqual({ ok: true, current: STORED });
    expect(currentFeedbackResult({ ok: true, data: { id: IV, status: 'completed', feedback: { ...STORED, comments: null } } }, IV)).toEqual({ ok: true, current: { ...STORED, comments: null } });
    // Cleared meanwhile: there is nothing to load, and the sentence says what to do.
    expect(FEEDBACK_CLEARED_MEANWHILE).toBe('The feedback on this interview was cleared a moment ago. Close this, then use “Add feedback” if it should have one.');
    expect(currentFeedbackResult({ ok: true, data: { id: IV, status: 'completed', feedback: null } }, IV)).toEqual({ ok: false, error: FEEDBACK_CLEARED_MEANWHILE });
    expect(currentFeedbackResult({ ok: false, error: 'That interview could not be found. It may have been deleted with its application.' }, IV))
      .toEqual({ ok: false, error: 'That interview could not be found. It may have been deleted with its application.' });
    for (const bad of [
      null, {}, { ok: true }, { ok: false },
      { ok: true, data: { id: 'another', status: 'completed', feedback: STORED } },
      { ok: true, data: { id: IV, status: 'completed', feedback: { ...STORED, rating: 9 } } },
      { ok: true, data: { id: IV, status: 'completed', feedback: { ...STORED, recommendation: 'maybe' } } },
      { ok: true, data: { id: IV, status: 'completed', feedback: { ...STORED, recorded_at: '' } } },
      { ok: true, data: { id: IV, status: 'completed', feedback: { ...STORED, comments: 7 } } },
    ]) {
      expect(currentFeedbackResult(bad, IV), JSON.stringify(bad)).toEqual({ ok: false, error: NOT_LOADED });
    }
  });
});

describe('where focus goes', () => {
  it('ids of the parts', () => {
    expect(feedbackFieldId('f', 'comments')).toBe('f-comments');
    expect(feedbackFieldId('f', 'alert')).toBe('f-alert');
    expect(ratingId('f', 4)).toBe('f-rating-4');
    expect(recommendationId('f', 'hold')).toBe('f-recommendation-hold');
  });
  it('on opening: the stored rating when editing, the first rating otherwise', () => {
    expect(feedbackFocusIdAfter({ after: 'open', values: filled }, 'f')).toBe('f-rating-4');
    expect(feedbackFocusIdAfter({ after: 'open', values: emptyFeedback() }, 'f')).toBe('f-rating-1');
  });
  it('after a failed check: the first group or field that is wrong; after a refusal: the alert', () => {
    expect(feedbackFocusIdAfter({ after: 'check', problems: feedbackProblems(emptyFeedback()), values: emptyFeedback() }, 'f')).toBe('f-rating-1');
    const noRecommendation = { ...filled, recommendation: '' as const };
    expect(feedbackFocusIdAfter({ after: 'check', problems: feedbackProblems(noRecommendation), values: noRecommendation }, 'f')).toBe('f-recommendation-advance');
    const tooLong = { ...filled, comments: 'c'.repeat(2001) };
    expect(feedbackFocusIdAfter({ after: 'check', problems: feedbackProblems(tooLong), values: tooLong }, 'f')).toBe('f-comments');
    expect(feedbackFocusIdAfter({ after: 'check', problems: {}, values: filled }, 'f')).toBeNull();
    expect(feedbackFocusIdAfter({ after: 'refusal' }, 'f')).toBe('f-alert');
  });
});

describe('a row\'s menu, with feedback', () => {
  it('a scheduled interview: "Mark completed and add feedback" directly after "Mark completed"', () => {
    expect(rowMenuWithFeedback(row())).toEqual([['edit', 'invitation'], ['completed', 'complete_with_feedback', 'no_show'], ['cancel']]);
    // Its application is closed: no edit, and the feedback item is still there.
    expect(rowMenuWithFeedback(row({ applicationOutcome: 'rejected' }))).toEqual([['invitation'], ['completed', 'complete_with_feedback', 'no_show'], ['cancel']]);
    expect(rowMenuWithFeedback(row({ needsOutcome: true }))).toEqual([['edit'], ['completed', 'complete_with_feedback', 'no_show'], ['cancel']]);
  });
  it('a completed interview without feedback: "Add feedback" above "Mark as scheduled again"', () => {
    expect(rowMenuWithFeedback(row({ statusKey: 'completed', status: 'Completed' }))).toEqual([['add_feedback'], ['reopen']]);
  });
  it('a completed interview with feedback: "Edit feedback", then "Mark as scheduled again", then "Clear feedback" last and alone', () => {
    expect(rowMenuWithFeedback(row({ statusKey: 'completed', status: 'Completed', feedback: STORED }))).toEqual([['edit_feedback'], ['reopen'], ['clear_feedback']]);
  });
  it('a cancelled interview and a no-show: nothing new', () => {
    for (const statusKey of ['cancelled', 'no_show'] as const) expect(rowMenuWithFeedback(row({ statusKey })), statusKey).toEqual([['reopen']]);
  });
  it('the words of every item, 4a\'s unchanged, and which are drawn in the danger style', () => {
    expect(FEEDBACK_MENU_WORDS).toEqual({
      complete_with_feedback: 'Mark completed and add feedback', add_feedback: 'Add feedback', edit_feedback: 'Edit feedback', clear_feedback: 'Clear feedback',
    });
    expect(ROW_MENU_WORDS).toEqual({ ...MENU_WORDS, ...FEEDBACK_MENU_WORDS });
    expect((Object.keys(ROW_MENU_WORDS) as (keyof typeof ROW_MENU_WORDS)[]).filter(isDestructive)).toEqual(['cancel', 'clear_feedback']);
  });
  it('which form an item opens', () => {
    expect(modeOf('complete_with_feedback')).toBe('complete');
    expect(modeOf('add_feedback')).toBe('add');
    expect(modeOf('edit_feedback')).toBe('edit');
    for (const item of ['clear_feedback', 'reopen', 'cancel', 'edit', 'completed'] as const) expect(modeOf(item), item).toBeNull();
  });
  it('"Mark as scheduled again" is refused at the row, with the other route in the sentence, exactly when the interview has feedback', () => {
    expect(reopenRefusal(row({ statusKey: 'completed', feedback: STORED }))).toBe('This interview has feedback. Clear the feedback before marking it as scheduled again.');
    expect(reopenRefusal(row({ statusKey: 'completed' }))).toBeNull();
    expect(reopenRefusal(row({ statusKey: 'cancelled' }))).toBeNull();
  });
  it('the panel\'s helper line is shown only when some interview in the list has feedback', () => {
    expect(panelShowsHelper([row(), row({ feedback: STORED })])).toBe(true);
    expect(panelShowsHelper([row(), row()])).toBe(false);
    expect(panelShowsHelper([])).toBe(false);
  });
});
