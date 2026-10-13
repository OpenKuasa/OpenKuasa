// tests/hire-interview-feedback.test.ts
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  HAS_NUL, NOT_AN_INTERVIEW_ID, clearInterviewFeedback, clearInterviewFeedbackInput, interviewFeedbackForEdit, saveInterviewFeedback,
  saveInterviewFeedbackInput, type HireWriteContext,
} from '@/lib/hire/capabilities';
import {
  COMMENTS_FOR_MODEL, COMMENTS_ON_CARD, FEEDBACK_INPUT_MESSAGES, FEEDBACK_LIMITS, FEEDBACK_NOT_LOADED, FEEDBACK_SAVE_FAILED, PANEL_FEEDBACK_HELPER,
  RECOMMENDATIONS, RECOMMENDATION_LABEL, clearedFeedbackMessage, feedbackBlocksReopen, feedbackCardDetail, feedbackCardTitle, feedbackCell, feedbackForModel,
  feedbackMenuFor, feedbackMessage, feedbackNowLine, feedbackOf, feedbackSummary, panelFeedbackLine, ratingWords, savedFeedbackMessage,
  type Feedback,
} from '@/lib/hire/interview-feedback';
import { shortDate, shortWhenToSecond } from '@/lib/hire/interview-time';
import { interviewMessage } from '@/lib/hire/interviews';
import { buildApplicationsModel, buildInterviewsModel } from '@/lib/hire/lists';
import { interviewCardFromLists } from '@/lib/hire/namesakes';
import { createSeedHireData } from '@/lib/hire/seed';
import { createSupabaseHireData } from '@/lib/hire/supabase';
import type { HireData, Interview } from '@/lib/hire/types';

const ORG = '11111111-1111-4111-8111-111111111111';
const IV_ID = '77777777-7777-4777-8777-777777777777';
/** 10:05:40 am on Wednesday 21 October 2026 in Kuala Lumpur, as the database writes a time. */
const SAVED_AT = '2026-10-21T02:05:40.123456+00:00';
const FEEDBACK: Feedback = { rating: 4, recommendation: 'advance', comments: 'Strong on key accounts.', recorded_at: SAVED_AT };
const NOT_FOUND = 'That interview could not be found. It may have been deleted with its application.';
const FORBIDDEN = 'You do not have permission to make changes here.';
const GENERIC = 'That change could not be saved. Please try again.';
const NOT_READ = 'Saved. The interview could not be read back, so some details are not shown.';

describe('a day, and a time to the second, in Kuala Lumpur', () => {
  it('give the date with its year, whatever zone the instant was written in', () => {
    expect(shortDate(SAVED_AT)).toBe('21 Oct 2026');
    expect(shortWhenToSecond(SAVED_AT)).toBe('Wed 21 Oct 2026, 10:05:40 am');
    // Five seconds past midnight in Kuala Lumpur is still the 20th in UTC.
    expect(shortDate('2026-10-20T16:00:05+00:00')).toBe('21 Oct 2026');
    expect(shortWhenToSecond('2026-10-20T16:00:05+00:00')).toBe('Wed 21 Oct 2026, 12:00:05 am');
    expect(shortWhenToSecond('2026-10-21T15:07:09+08:00')).toBe('Wed 21 Oct 2026, 3:07:09 pm');
  });
  it('give text that is not an instant back as it is', () => {
    expect(shortDate('soon')).toBe('soon');
    expect(shortWhenToSecond('2026-10-21T10:05:40')).toBe('2026-10-21T10:05:40');
  });
});

describe('feedback in words', () => {
  it('has the limits of the table and the three recommendations with their labels', () => {
    expect(FEEDBACK_LIMITS).toEqual({ ratingMin: 1, ratingMax: 5, comments: 2000, basis: 500 });
    expect(RECOMMENDATIONS).toEqual(['advance', 'hold', 'reject']);
    expect(RECOMMENDATION_LABEL).toEqual({ advance: 'Advance', hold: 'Hold', reject: 'Reject' });
    expect(COMMENTS_ON_CARD).toBe(600);
    expect(COMMENTS_FOR_MODEL).toBe(600);
  });
  it('reads a rating and a summary the same way everywhere', () => {
    expect(ratingWords(4)).toBe('4 out of 5');
    expect(feedbackSummary({ rating: 4, recommendation: 'advance' })).toBe('4 out of 5 · Advance');
    expect(feedbackSummary({ rating: 3, recommendation: 'hold' })).toBe('3 out of 5 · Hold');
    expect(feedbackSummary({ rating: 1, recommendation: 'reject' })).toBe('1 out of 5 · Reject');
  });
  it('the table cell: the summary, "None yet" for a completed interview without one, a dash for any other status', () => {
    expect(feedbackCell('completed', FEEDBACK)).toBe('4 out of 5 · Advance');
    expect(feedbackCell('completed', null)).toBe('None yet');
    expect(feedbackCell('completed', undefined)).toBe('None yet');
    for (const status of ['scheduled', 'cancelled', 'no_show'] as const) expect(feedbackCell(status, null), status).toBe('—');
  });
  it('the panel line gives the day it was saved, with the year, and the helper says the two ratings are separate', () => {
    expect(panelFeedbackLine(FEEDBACK)).toBe('Feedback: 4 out of 5 · Advance · saved 21 Oct 2026');
    expect(PANEL_FEEDBACK_HELPER).toBe('Interview feedback is separate from the application\'s rating below.');
  });
  it('the form\'s three sentences', () => {
    expect(FEEDBACK_INPUT_MESSAGES).toEqual({
      rating: 'Choose a rating from 1 to 5.',
      recommendation: 'Choose a recommendation.',
      comments: 'Keep the comments under 2,000 characters.',
    });
  });
  it('maps each word to its sentence, by what was being done', () => {
    expect(feedbackMessage('not_found', 'save')).toBe(NOT_FOUND);
    expect(feedbackMessage('not_found', 'clear')).toBe(NOT_FOUND);
    expect(feedbackMessage('forbidden', 'save')).toBe(FORBIDDEN);
    expect(feedbackMessage('forbidden', 'clear')).toBe(FORBIDDEN);
    expect(feedbackMessage('not_completed', 'save')).toBe('Feedback is for a completed interview. Mark this one completed first.');
    expect(feedbackMessage('has_feedback', 'save')).toBe('This interview already has feedback. Open it to edit it.');
    expect(feedbackMessage('changed', 'save')).toBe('The feedback on this interview was changed a moment ago. Nothing was saved. Check it and try again.');
    expect(feedbackMessage('no_feedback', 'clear')).toBe('This interview has no feedback to clear.');
    // The other meaning of has_feedback is 4a's function's, and is said by 4a's own map.
    expect(interviewMessage('has_feedback', 'interview')).toBe('This interview has feedback. Clear the feedback before marking it as scheduled again.');
  });
  it('gives the generic sentence for a word that has none, a word of the other function, an error and no answer', () => {
    expect(FEEDBACK_SAVE_FAILED).toBe(GENERIC);
    for (const word of ['invalid_rating', 'invalid_recommendation', 'invalid_comments', 'surprise', 'toString', '', null, undefined, 7, {}]) {
      expect(feedbackMessage(word, 'save'), String(word)).toBe(GENERIC);
    }
    expect(feedbackMessage('no_feedback', 'save')).toBe(GENERIC);
    expect(feedbackMessage('has_feedback', 'clear')).toBe(GENERIC);
    expect(FEEDBACK_NOT_LOADED).toBe('The feedback could not be loaded just now. Close this and open it again.');
  });
  it('says what happened from what the database answered: saved, replaced, or marked completed and saved', () => {
    const f = { rating: 4, recommendation: 'advance' } as const;
    expect(savedFeedbackMessage('Aina Rahman', f, { replaced: false, completed: false })).toBe('Saved feedback on the interview with Aina Rahman: 4 out of 5, advance.');
    expect(savedFeedbackMessage('Aina Rahman', f, { replaced: true, completed: false })).toBe('Replaced the feedback on the interview with Aina Rahman: 4 out of 5, advance.');
    expect(savedFeedbackMessage('Aina Rahman', f, { replaced: false, completed: true }))
      .toBe('Marked the interview with Aina Rahman as completed and saved feedback: 4 out of 5, advance.');
    expect(savedFeedbackMessage('Aina Rahman', { rating: 2, recommendation: 'reject' }, { replaced: false, completed: false }))
      .toBe('Saved feedback on the interview with Aina Rahman: 2 out of 5, reject.');
    expect(clearedFeedbackMessage('Aina Rahman')).toBe('Cleared the feedback on the interview with Aina Rahman.');
    // No name was read back.
    expect(savedFeedbackMessage('', f, { replaced: false, completed: false })).toBe('Saved feedback on the interview with the candidate: 4 out of 5, advance.');
    expect(clearedFeedbackMessage('  ')).toBe('Cleared the feedback on the interview with the candidate.');
  });
});

describe('what a row offers for feedback', () => {
  it('a scheduled interview: completing it with feedback in one step', () => {
    expect(feedbackMenuFor('scheduled', false)).toEqual(['complete_with_feedback']);
  });
  it('a completed interview: add when there is none, edit and clear when there is', () => {
    expect(feedbackMenuFor('completed', false)).toEqual(['add_feedback']);
    expect(feedbackMenuFor('completed', true)).toEqual(['edit_feedback', 'clear_feedback']);
  });
  it('a cancelled interview and a no-show: nothing', () => {
    for (const status of ['cancelled', 'no_show'] as const) {
      expect(feedbackMenuFor(status, false), status).toEqual([]);
      expect(feedbackMenuFor(status, true), status).toEqual([]);
    }
  });
  it('"Mark as scheduled again" would be refused exactly for a completed interview that has feedback', () => {
    expect(feedbackBlocksReopen('completed', true)).toBe(true);
    expect(feedbackBlocksReopen('completed', false)).toBe(false);
    for (const status of ['scheduled', 'cancelled', 'no_show'] as const) expect(feedbackBlocksReopen(status, true), status).toBe(false);
  });
});

describe('the Approve cards', () => {
  const LAST = 'This does not move or reject the application.';
  it('titles name the person and the job, or say the interview was not listed', () => {
    expect(feedbackCardTitle('saveInterviewFeedback', 'Aina Rahman (Sales Executive)')).toBe('Record feedback on the interview with Aina Rahman (Sales Executive)?');
    expect(feedbackCardTitle('clearInterviewFeedback', 'Aina Rahman (Sales Executive)')).toBe('Clear the feedback on the interview with Aina Rahman (Sales Executive)?');
    expect(feedbackCardTitle('saveInterviewFeedback', null)).toBe('Record feedback on the interview with an interview that was not in the list above?');
    expect(feedbackCardTitle('clearInterviewFeedback', '  ')).toBe('Clear the feedback on the interview with an interview that was not in the list above?');
    expect(feedbackCardTitle('cancelInterview', 'Aina Rahman')).toBeNull();
  });
  it('a save: the rating, the recommendation, the comments on one line, and always last that nothing else changes', () => {
    expect(feedbackCardDetail('saveInterviewFeedback', { id: IV_ID, rating: 4, recommendation: 'advance', comments: 'Strong on key accounts.\n\nClear   about targets.' }))
      .toBe(`4 out of 5 · Recommendation: Advance · Comments: Strong on key accounts. Clear about targets. · ${LAST}`);
    expect(feedbackCardDetail('saveInterviewFeedback', { id: IV_ID, rating: 2, recommendation: 'reject' })).toBe(`2 out of 5 · Recommendation: Reject · No comments · ${LAST}`);
    expect(feedbackCardDetail('saveInterviewFeedback', { id: IV_ID, rating: 3, recommendation: 'hold', comments: '   ' })).toBe(`3 out of 5 · Recommendation: Hold · No comments · ${LAST}`);
    expect(feedbackCardDetail('saveInterviewFeedback', { id: IV_ID, rating: 3, recommendation: 'hold', comments: null })).toBe(`3 out of 5 · Recommendation: Hold · No comments · ${LAST}`);
  });
  it('a save: the grounds of the assistant\'s own reading, that it also marks completed, and that it REPLACES, each only when the input says so', () => {
    expect(feedbackCardDetail('saveInterviewFeedback', {
      id: IV_ID, rating: 4, recommendation: 'advance', comments: 'Strong.', basis: 'She closed two enterprise deals\nbut could not explain her pipeline.', mark_completed: true, replace: true,
    })).toBe(
      '4 out of 5 · Recommendation: Advance · Comments: Strong. · Why: She closed two enterprise deals but could not explain her pipeline. · ' +
        `Also marks the interview completed. · Replaces the feedback already recorded. · ${LAST}`,
    );
    const plain = feedbackCardDetail('saveInterviewFeedback', { id: IV_ID, rating: 4, recommendation: 'advance', mark_completed: false, replace: false, basis: '  ' })!;
    expect(plain).not.toContain('Why:');
    expect(plain).not.toContain('Also marks');
    expect(plain).not.toContain('Replaces');
    // Only `true` counts: a string is not a yes.
    expect(feedbackCardDetail('saveInterviewFeedback', { id: IV_ID, rating: 4, recommendation: 'advance', replace: 'true' })).not.toContain('Replaces');
  });
  it('a save: comments longer than 600 characters are cut, and the card says how many more there are', () => {
    const exact = feedbackCardDetail('saveInterviewFeedback', { id: IV_ID, rating: 4, recommendation: 'advance', comments: 'c'.repeat(600) })!;
    expect(exact).toContain(`Comments: ${'c'.repeat(600)} · ${LAST}`);
    const one = feedbackCardDetail('saveInterviewFeedback', { id: IV_ID, rating: 4, recommendation: 'advance', comments: 'c'.repeat(601) })!;
    expect(one).toContain(`Comments: ${'c'.repeat(600)}… (and 1 more character) · ${LAST}`);
    const long = feedbackCardDetail('saveInterviewFeedback', { id: IV_ID, rating: 4, recommendation: 'advance', comments: 'c'.repeat(2000) })!;
    expect(long).toContain(`Comments: ${'c'.repeat(600)}… (and 1,400 more characters) · ${LAST}`);
    expect(long).not.toContain('c'.repeat(601));
  });
  it('a save whose rating or recommendation is not one the schema takes says so, and never guesses', () => {
    expect(feedbackCardDetail('saveInterviewFeedback', { id: IV_ID, rating: 9, recommendation: 'maybe' })).toBe(`No rating given · No recommendation given · No comments · ${LAST}`);
    expect(feedbackCardDetail('saveInterviewFeedback', { id: IV_ID })).toBe(`No rating given · No recommendation given · No comments · ${LAST}`);
  });
  it('a clear says what goes; any other tool has nothing here', () => {
    expect(feedbackCardDetail('clearInterviewFeedback', { id: IV_ID })).toBe('The rating, the recommendation and the comments are removed. This cannot be undone.');
    expect(feedbackCardDetail('cancelInterview', { id: IV_ID })).toBeNull();
    expect(feedbackCardDetail('rateApplication', { id: IV_ID, rating: 4 })).toBeNull();
  });
  it('the line that says how the interview stands now: its status, and its feedback to the second', () => {
    expect(feedbackNowLine('completed', null)).toBe('Now: completed · no feedback yet');
    expect(feedbackNowLine('scheduled', undefined)).toBe('Now: scheduled · no feedback yet');
    expect(feedbackNowLine('cancelled', null)).toBe('Now: cancelled · no feedback yet');
    expect(feedbackNowLine('no_show', null)).toBe('Now: a no-show · no feedback yet');
    expect(feedbackNowLine('completed', { rating: 3, recommendation: 'hold', recorded_at: SAVED_AT }))
      .toBe('Now: completed · feedback 3 out of 5 · Hold · saved Wed 21 Oct 2026, 10:05:40 am');
    // A save one second later reads differently, so a change since the card is seen.
    expect(feedbackNowLine('completed', { rating: 3, recommendation: 'hold', recorded_at: '2026-10-21T02:05:41.000001+00:00' }))
      .not.toBe(feedbackNowLine('completed', { rating: 3, recommendation: 'hold', recorded_at: SAVED_AT }));
  });
});

describe('feedback as a model is given it', () => {
  it('is null when there is none', () => {
    expect(feedbackForModel(null)).toBeNull();
    expect(feedbackForModel(undefined)).toBeNull();
  });
  it('carries the time in words with its date and year, beside the instant', () => {
    expect(feedbackForModel(FEEDBACK)).toEqual({
      rating: 4, recommendation: 'advance', comments: 'Strong on key accounts.', comments_cut: false, recorded_at: SAVED_AT, recorded: 'Wed 21 Oct 2026, 10:05 am',
    });
  });
  it('cuts comments at 600 characters and says so; shorter ones and none are as they are', () => {
    expect(feedbackForModel({ ...FEEDBACK, comments: 'c'.repeat(601) })).toMatchObject({ comments: `${'c'.repeat(600)}…`, comments_cut: true });
    expect(feedbackForModel({ ...FEEDBACK, comments: 'c'.repeat(600) })).toMatchObject({ comments: 'c'.repeat(600), comments_cut: false });
    expect(feedbackForModel({ ...FEEDBACK, comments: null })).toMatchObject({ comments: null, comments_cut: false });
  });
});

describe('feedback from the four columns', () => {
  const columns = { feedback_rating: 4, feedback_recommendation: 'advance', feedback_comments: 'Strong on key accounts.', feedback_at: SAVED_AT };
  it('is one value when the row has it', () => {
    expect(feedbackOf(columns)).toEqual(FEEDBACK);
    expect(feedbackOf({ ...columns, feedback_comments: null })).toEqual({ ...FEEDBACK, comments: null });
    expect(feedbackOf({ ...columns, feedback_comments: '   ' })).toEqual({ ...FEEDBACK, comments: null });
    // Comments that were not read are none.
    expect(feedbackOf({ feedback_rating: 4, feedback_recommendation: 'advance', feedback_at: SAVED_AT })).toEqual({ ...FEEDBACK, comments: null });
  });
  it('is whole or nothing: no saved time, no rating or an unknown recommendation is no feedback', () => {
    expect(feedbackOf(null)).toBeNull();
    expect(feedbackOf(undefined)).toBeNull();
    expect(feedbackOf({})).toBeNull();
    expect(feedbackOf({ ...columns, feedback_at: null })).toBeNull();
    expect(feedbackOf({ ...columns, feedback_rating: null })).toBeNull();
    expect(feedbackOf({ ...columns, feedback_rating: 6 })).toBeNull();
    expect(feedbackOf({ ...columns, feedback_rating: 3.5 })).toBeNull();
    expect(feedbackOf({ ...columns, feedback_recommendation: 'maybe' })).toBeNull();
  });
});

describe('where feedback is read', () => {
  const NOW = new Date('2026-10-22T04:00:00Z');
  const interview = (id: string, over: Partial<Interview> = {}): Interview => ({
    id, application_id: 'a1', candidate_name: 'Aina Rahman', job_title: 'Sales Executive', scheduled_at: '2026-10-20T07:00:00Z', duration_minutes: 60,
    kind: 'video', place: null, interviewer_name: 'Farah Lim', notes: 'Team only.', status: 'completed', created_at: '2026-10-12T02:00:00Z',
    updated_at: '2026-10-21T02:05:40Z', application_stage: 'interview', application_outcome: 'active', ...over,
  });
  const dataWith = (interviews: Interview[]): HireData => ({ ...createSeedHireData(NOW), listInterviews: async () => interviews });

  it('the provider reads the four columns and gives one value; a row without feedback has no such key, and no raw column rides along', async () => {
    const asked: string[] = [];
    const rows = [
      { id: 'i-with', application_id: 'a1', scheduled_at: '2026-10-20T07:00:00+00:00', status: 'completed', feedback_rating: 4, feedback_recommendation: 'advance',
        feedback_comments: 'Strong on key accounts.', feedback_at: SAVED_AT, application: { stage: 'interview', outcome: 'active', candidate: { name: 'Aina Rahman' }, job: { title: 'Sales Executive' } } },
      { id: 'i-none', application_id: 'a1', scheduled_at: '2026-10-19T07:00:00+00:00', status: 'completed', feedback_rating: null, feedback_recommendation: null,
        feedback_comments: null, feedback_at: null, application: null },
    ];
    const client = {
      from: () => {
        const chain = {
          select: (columns: string) => { asked.push(columns); return chain; },
          eq: () => chain,
          order: () => chain,
          limit: async () => ({ data: rows, error: null }),
        };
        return chain;
      },
    };
    const read = await createSupabaseHireData(client as never, ORG).listInterviews();
    expect(asked[0]).toContain(',updated_at,feedback_rating,feedback_recommendation,feedback_comments,feedback_at,application:hire_applications(');
    const byId = new Map(read.map((i) => [i.id, i]));
    expect(byId.get('i-with')!.feedback).toEqual(FEEDBACK);
    expect(Object.keys(byId.get('i-none')!)).not.toContain('feedback');
    for (const row of read) expect(Object.keys(row).filter((key) => key.startsWith('feedback_'))).toEqual([]);
  });
  it('the sample data: the two most recent completed interviews have feedback, saved after the interview and before now; nothing else has', async () => {
    const interviews = await createSeedHireData(NOW).listInterviews();
    const withFeedback = interviews.filter((i) => i.feedback);
    expect(withFeedback.map((i) => i.id).sort()).toEqual(['int-7', 'int-8']);
    for (const i of withFeedback) {
      expect(i.status, i.id).toBe('completed');
      expect(Date.parse(i.feedback!.recorded_at), i.id).toBeGreaterThan(Date.parse(i.scheduled_at));
      expect(Date.parse(i.feedback!.recorded_at), i.id).toBeLessThan(NOW.getTime());
    }
    expect(withFeedback.map((i) => [i.feedback!.rating, i.feedback!.recommendation]).sort()).toEqual([[2, 'hold'], [4, 'advance']]);
    expect(interviews.filter((i) => i.status === 'completed')).toHaveLength(3);
  });
  it('a row of the Interviews screen carries the feedback whole, and only when there is some', async () => {
    const model = await buildInterviewsModel(dataWith([interview('with', { feedback: FEEDBACK }), interview('none'), interview('null', { feedback: null })]), NOW);
    const byId = new Map(model.rows.map((r) => [r.id, r]));
    expect(byId.get('with')!.feedback).toEqual(FEEDBACK);
    expect(Object.keys(byId.get('none')!)).not.toContain('feedback');
    expect(Object.keys(byId.get('null')!)).not.toContain('feedback');
  });
  it('the Applications panel gets the feedback too, comments included, and still no notes: a viewer may read feedback', async () => {
    const base = createSeedHireData(NOW);
    const [application] = await base.listApplications();
    const source: HireData = { ...base, listInterviews: async () => [interview('with', { application_id: application.id, feedback: FEEDBACK })] };
    const row = (await buildApplicationsModel(source, NOW)).rows.find((r) => r.id === application.id)!;
    expect(row.interviews).toHaveLength(1);
    expect(row.interviews[0].feedback).toEqual(FEEDBACK);
    expect(Object.keys(row.interviews[0])).not.toContain('notes');
  });
  it('a card\'s own read says what feedback the interview has, without the comments, and only when there is some', () => {
    const interviews = [interview('with', { feedback: FEEDBACK }), interview('none', { scheduled_at: '2026-10-19T07:00:00Z' })];
    expect(interviewCardFromLists('with', interviews).target!.feedback).toEqual({ rating: 4, recommendation: 'advance', recorded_at: SAVED_AT });
    expect(Object.keys(interviewCardFromLists('none', interviews).target!)).not.toContain('feedback');
  });
});

// ─── the capabilities ────────────────────────────────────────────────────────

const FB_READ = 'id,scheduled_at,status,feedback_rating,feedback_recommendation,feedback_comments,feedback_at,'
  + 'application:hire_applications(candidate:hire_candidates(name),job:hire_jobs(title))';
const FB_ROW = {
  id: IV_ID, scheduled_at: '2026-10-20T07:00:00+00:00', status: 'completed', feedback_rating: 4, feedback_recommendation: 'advance',
  feedback_comments: 'Strong on key accounts.', feedback_at: SAVED_AT,
  application: { candidate: { name: 'Aina Rahman' }, job: { title: 'Sales Executive' } },
};
const SAVE = { id: IV_ID, rating: 4, recommendation: 'advance' } as const;

/** A client whose rpc answers `answer` and whose read answers `row`; it writes down both. */
function fbFake(opts: { answer?: unknown; error?: unknown; throws?: unknown; row?: unknown; readThrows?: boolean; readError?: unknown } = {}) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const reads: { table: string; columns: string; filters: Record<string, unknown> }[] = [];
  const client = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      if (opts.throws) throw opts.throws;
      return { data: 'answer' in opts ? opts.answer : { word: 'ok', replaced: false, completed: false }, error: opts.error ?? null };
    },
    from: (table: string) => {
      const entry = { table, columns: '', filters: {} as Record<string, unknown> };
      reads.push(entry);
      const chain = {
        select: (columns: string) => { entry.columns = columns; return chain; },
        eq: (k: string, v: unknown) => { entry.filters[k] = v; return chain; },
        maybeSingle: async () => {
          if (opts.readThrows) throw new Error('Aina read failed');
          return { data: 'row' in opts ? opts.row : FB_ROW, error: opts.readError ?? null };
        },
      };
      return chain;
    },
  };
  const ctx: HireWriteContext = { client: client as never, orgId: ORG };
  return { ctx, calls, reads };
}

describe('feedback schemas', () => {
  it('convert to JSON Schema, describe every field and carry no workspace key', () => {
    for (const schema of [saveInterviewFeedbackInput, clearInterviewFeedbackInput]) {
      // A transform or a preprocess cannot be converted: this is what keeps the schemas plain.
      expect(z.toJSONSchema(schema)).toMatchObject({ type: 'object' });
      for (const [key, field] of Object.entries(schema.shape)) {
        expect(key).not.toMatch(/org|tenant|workspace/i);
        expect((field as z.ZodType).description, key).toBeTruthy();
      }
    }
  });
  it('have exactly these fields, and need a rating and a recommendation', () => {
    expect(Object.keys(saveInterviewFeedbackInput.shape)).toEqual(['id', 'rating', 'recommendation', 'comments', 'mark_completed', 'replace', 'basis']);
    expect(Object.keys(clearInterviewFeedbackInput.shape)).toEqual(['id']);
    expect(saveInterviewFeedbackInput.parse(SAVE)).toEqual(SAVE);
    expect(z.toJSONSchema(saveInterviewFeedbackInput).required).toEqual(['id', 'rating', 'recommendation']);
  });
  it('drop a key they do not know, so a workspace or a "last seen" time named by the caller goes nowhere', () => {
    expect(saveInterviewFeedbackInput.parse({ ...SAVE, org_id: 'evil', seen: SAVED_AT, p_if_feedback_at: 'x', status: 'completed' })).toEqual(SAVE);
    expect(clearInterviewFeedbackInput.parse({ id: IV_ID, org_id: 'evil' })).toEqual({ id: IV_ID });
  });
  it('say what is wrong: a made-up id with where to get a real one, and the form\'s own sentences for the rest', () => {
    const said = (input: Record<string, unknown>) => saveInterviewFeedbackInput.safeParse({ ...SAVE, ...input }).error?.issues[0]?.message;
    for (const id of ['interview-7', '', 'Aina Rahman']) expect(said({ id }), id).toBe(NOT_AN_INTERVIEW_ID);
    for (const rating of [0, 6, 3.5, '4', null, undefined]) expect(said({ rating }), String(rating)).toBe('Choose a rating from 1 to 5.');
    for (const recommendation of ['maybe', 'Advance', '', null, undefined]) expect(said({ recommendation }), String(recommendation)).toBe('Choose a recommendation.');
    expect(said({ comments: 'c'.repeat(2001) })).toBe('Keep the comments under 2,000 characters.');
    expect(said({ comments: 'c'.repeat(2000) })).toBeUndefined();
    expect(said({ comments: 'a\u0000b' })).toBe(HAS_NUL);
    expect(said({ basis: 'a\u0000b' })).toBe(HAS_NUL);
    expect(saveInterviewFeedbackInput.safeParse({ ...SAVE, basis: 'b'.repeat(501) }).success).toBe(false);
    expect(clearInterviewFeedbackInput.safeParse({ id: 'interview-7' }).error?.issues[0]?.message).toBe(NOT_AN_INTERVIEW_ID);
  });
});

describe('saveInterviewFeedback', () => {
  it('sends the function exactly its arguments, trimmed, and reads the row back in the caller\'s workspace', async () => {
    const f = fbFake();
    await saveInterviewFeedback(f.ctx, { ...SAVE, comments: '  Strong on key accounts.  ' });
    expect(f.calls).toEqual([{
      fn: 'hire_save_interview_feedback',
      args: { p_interview_id: IV_ID, p_rating: 4, p_recommendation: 'advance', p_comments: 'Strong on key accounts.', p_mark_completed: false, p_replace: false },
    }]);
    expect(f.reads).toEqual([{ table: 'hire_interviews', columns: FB_READ, filters: { id: IV_ID, org_id: ORG } }]);
    expect(JSON.stringify(f.calls)).not.toContain('org_id');
  });
  it('sends blank comments, no comments and null comments as none; and the two switches only as true or false', async () => {
    for (const comments of ['   ', undefined, null]) {
      const f = fbFake();
      await saveInterviewFeedback(f.ctx, { ...SAVE, comments });
      expect(f.calls[0].args.p_comments, String(comments)).toBeNull();
    }
    const on = fbFake();
    await saveInterviewFeedback(on.ctx, { ...SAVE, mark_completed: true, replace: true });
    expect(on.calls[0].args).toMatchObject({ p_mark_completed: true, p_replace: true });
  });
  it('never sends the basis: it is for the card', async () => {
    const f = fbFake();
    await saveInterviewFeedback(f.ctx, { ...SAVE, basis: 'She closed two enterprise deals last year.' });
    expect(Object.keys(f.calls[0].args).sort()).toEqual(['p_comments', 'p_interview_id', 'p_mark_completed', 'p_rating', 'p_recommendation', 'p_replace']);
    expect(JSON.stringify(f.calls)).not.toMatch(/basis|enterprise/);
  });
  it('passes the version the form saw exactly as it arrived, and nothing when there is none', async () => {
    const seen = fbFake();
    await saveInterviewFeedback(seen.ctx, { ...SAVE, replace: true }, SAVED_AT);
    // The same text, to the microsecond: a value that went through a Date would lose the last three digits.
    expect(seen.calls[0].args.p_if_feedback_at).toBe(SAVED_AT);
    for (const none of [undefined, ''] as const) {
      const f = fbFake();
      await saveInterviewFeedback(f.ctx, SAVE, none);
      expect('p_if_feedback_at' in f.calls[0].args, String(none)).toBe(false);
    }
  });
  it('refuses a made-up id, a rating of 0, 6 or 3.5, a recommendation outside the three and comments too long, before any call', async () => {
    const f = fbFake();
    expect(await saveInterviewFeedback(f.ctx, { ...SAVE, id: 'interview-7' })).toEqual({ ok: false, error: NOT_AN_INTERVIEW_ID });
    for (const rating of [0, 6, 3.5]) {
      expect(await saveInterviewFeedback(f.ctx, { ...SAVE, rating }), String(rating)).toEqual({ ok: false, error: 'Choose a rating from 1 to 5.' });
    }
    expect(await saveInterviewFeedback(f.ctx, { id: IV_ID, recommendation: 'advance' } as never)).toEqual({ ok: false, error: 'Choose a rating from 1 to 5.' });
    expect(await saveInterviewFeedback(f.ctx, { ...SAVE, recommendation: 'maybe' } as never)).toEqual({ ok: false, error: 'Choose a recommendation.' });
    expect(await saveInterviewFeedback(f.ctx, { id: IV_ID, rating: 4 } as never)).toEqual({ ok: false, error: 'Choose a recommendation.' });
    expect(await saveInterviewFeedback(f.ctx, { ...SAVE, comments: 'c'.repeat(2001) })).toEqual({ ok: false, error: 'Keep the comments under 2,000 characters.' });
    expect(f.calls).toEqual([]);
    expect(f.reads).toEqual([]);
  });
  it('answers with the row as read back, and no notes', async () => {
    expect(await saveInterviewFeedback(fbFake().ctx, { ...SAVE, comments: 'Strong on key accounts.' })).toEqual({
      ok: true,
      data: {
        id: IV_ID, candidate: 'Aina Rahman', job: 'Sales Executive', status: 'completed', scheduled_at: '2026-10-20T07:00:00+00:00', feedback: FEEDBACK,
        replaced: false, marked_completed: false, message: 'Saved feedback on the interview with Aina Rahman: 4 out of 5, advance.', confirmed: true,
      },
    });
  });
  it('"replaced" and "marked completed" are the database\'s to say, never the input\'s', async () => {
    const said = async (answer: unknown, input: Record<string, unknown> = {}) => {
      const result = await saveInterviewFeedback(fbFake({ answer }).ctx, { ...SAVE, ...input });
      if (!result.ok) throw new Error(result.error);
      return [result.data.message, result.data.replaced, result.data.marked_completed];
    };
    const SAVED = 'Saved feedback on the interview with Aina Rahman: 4 out of 5, advance.';
    const REPLACED = 'Replaced the feedback on the interview with Aina Rahman: 4 out of 5, advance.';
    const MARKED = 'Marked the interview with Aina Rahman as completed and saved feedback: 4 out of 5, advance.';
    // The database says it replaced something, and the input did not say replace.
    expect(await said({ word: 'ok', replaced: true, completed: false })).toEqual([REPLACED, true, false]);
    // The input said replace, and the database found nothing to replace.
    expect(await said({ word: 'ok', replaced: false, completed: false }, { replace: true })).toEqual([SAVED, false, false]);
    // The database marked it completed.
    expect(await said({ word: 'ok', replaced: false, completed: true }, { mark_completed: true })).toEqual([MARKED, false, true]);
    // The input asked for it, and a colleague had completed it already: saved, not "marked".
    expect(await said({ word: 'ok', replaced: false, completed: false }, { mark_completed: true })).toEqual([SAVED, false, false]);
    // An answer that does not say, or says it with anything but true, is neither.
    expect(await said({ word: 'ok' }, { replace: true, mark_completed: true })).toEqual([SAVED, false, false]);
    expect(await said({ word: 'ok', replaced: 'true', completed: 1 })).toEqual([SAVED, false, false]);
  });
  it('is still a success when the row cannot be read back: what is known is said, and nothing is guessed', async () => {
    const blank = {
      id: IV_ID, candidate: '', job: '', status: 'completed', scheduled_at: null, feedback: null, replaced: false, marked_completed: false,
      message: 'Saved feedback on the interview with the candidate: 4 out of 5, advance.', confirmed: false, note: NOT_READ,
    };
    expect(await saveInterviewFeedback(fbFake({ row: null }).ctx, SAVE)).toEqual({ ok: true, data: blank });
    expect(await saveInterviewFeedback(fbFake({ readThrows: true }).ctx, SAVE)).toEqual({ ok: true, data: blank });
  });
  it('maps each word to its sentence, and reads nothing back after a refusal', async () => {
    for (const [word, error] of [
      ['not_found', NOT_FOUND], ['forbidden', FORBIDDEN],
      ['not_completed', 'Feedback is for a completed interview. Mark this one completed first.'],
      ['has_feedback', 'This interview already has feedback. Open it to edit it.'],
      ['changed', 'The feedback on this interview was changed a moment ago. Nothing was saved. Check it and try again.'],
      ['invalid_rating', GENERIC], ['surprise', GENERIC],
    ] as const) {
      const f = fbFake({ answer: { word } });
      expect(await saveInterviewFeedback(f.ctx, SAVE), word).toEqual({ ok: false, error });
      expect(f.reads, word).toEqual([]);
    }
    for (const answer of [null, {}, 'ok ', { word: null }]) {
      expect(await saveInterviewFeedback(fbFake({ answer }).ctx, SAVE), JSON.stringify(answer)).toEqual({ ok: false, error: GENERIC });
    }
  });
  it('gives the generic sentence and logs only a code on an rpc error and on a throw: never the comments, a name or an id', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const input = { ...SAVE, comments: 'Strong on key accounts.' };
    const failing = fbFake({ error: { code: '42501', message: 'Aina secret', details: 'Strong on key accounts.' } }).ctx;
    expect(await saveInterviewFeedback(failing, input)).toEqual({ ok: false, error: GENERIC });
    expect(spy).toHaveBeenLastCalledWith('[hire-capability] saveInterviewFeedback failed:', { code: '42501' });
    expect(await saveInterviewFeedback(fbFake({ throws: new TypeError('Aina fetch failed') }).ctx, input)).toEqual({ ok: false, error: GENERIC });
    expect(spy).toHaveBeenLastCalledWith('[hire-capability] saveInterviewFeedback failed:', { code: 'TypeError' });
    expect(JSON.stringify(spy.mock.calls)).not.toMatch(/Aina|key accounts|77777777/);
    spy.mockRestore();
  });
});

describe('clearInterviewFeedback', () => {
  const CLEARED_ROW = { ...FB_ROW, feedback_rating: null, feedback_recommendation: null, feedback_comments: null, feedback_at: null };
  it('sends only the id, and answers with the interview as it is afterwards', async () => {
    const f = fbFake({ answer: 'ok', row: CLEARED_ROW });
    expect(await clearInterviewFeedback(f.ctx, { id: IV_ID })).toEqual({
      ok: true,
      data: {
        id: IV_ID, candidate: 'Aina Rahman', job: 'Sales Executive', status: 'completed', scheduled_at: '2026-10-20T07:00:00+00:00', feedback: null,
        replaced: false, marked_completed: false, message: 'Cleared the feedback on the interview with Aina Rahman.', confirmed: true,
      },
    });
    expect(f.calls).toEqual([{ fn: 'hire_clear_interview_feedback', args: { p_interview_id: IV_ID } }]);
    expect(f.reads).toEqual([{ table: 'hire_interviews', columns: FB_READ, filters: { id: IV_ID, org_id: ORG } }]);
  });
  it('refuses a made-up id before any call, and maps each word to its sentence', async () => {
    const f = fbFake({ answer: 'ok' });
    expect(await clearInterviewFeedback(f.ctx, { id: 'interview-7' })).toEqual({ ok: false, error: NOT_AN_INTERVIEW_ID });
    expect(f.calls).toEqual([]);
    for (const [answer, error] of [
      ['not_found', NOT_FOUND], ['forbidden', FORBIDDEN], ['no_feedback', 'This interview has no feedback to clear.'], ['has_feedback', GENERIC], [null, GENERIC],
    ] as const) {
      expect(await clearInterviewFeedback(fbFake({ answer }).ctx, { id: IV_ID }), String(answer)).toEqual({ ok: false, error });
    }
  });
  it('is still a success when the row cannot be read back, and logs only a code when the call fails', async () => {
    expect(await clearInterviewFeedback(fbFake({ answer: 'ok', row: null }).ctx, { id: IV_ID })).toEqual({
      ok: true,
      data: {
        id: IV_ID, candidate: '', job: '', status: 'completed', scheduled_at: null, feedback: null, replaced: false, marked_completed: false,
        message: 'Cleared the feedback on the interview with the candidate.', confirmed: false, note: NOT_READ,
      },
    });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await clearInterviewFeedback(fbFake({ error: { code: '42501', message: 'Aina secret' } }).ctx, { id: IV_ID })).toEqual({ ok: false, error: GENERIC });
    expect(spy).toHaveBeenLastCalledWith('[hire-capability] clearInterviewFeedback failed:', { code: '42501' });
    expect(JSON.stringify(spy.mock.calls)).not.toMatch(/Aina|77777777/);
    spy.mockRestore();
  });
});

describe('interviewFeedbackForEdit', () => {
  const EDIT_READ = 'id,status,feedback_rating,feedback_recommendation,feedback_comments,feedback_at';
  it('reads the stored feedback by id in the caller\'s workspace, changes nothing, and hands the saved time back exactly as stored', async () => {
    const f = fbFake();
    expect(await interviewFeedbackForEdit(f.ctx, { id: IV_ID })).toEqual({ ok: true, data: { id: IV_ID, status: 'completed', feedback: FEEDBACK } });
    expect(f.calls).toEqual([]);
    expect(f.reads).toEqual([{ table: 'hire_interviews', columns: EDIT_READ, filters: { id: IV_ID, org_id: ORG } }]);
  });
  it('says there is none when it was cleared meanwhile, and that the interview has gone when it has', async () => {
    const cleared = { ...FB_ROW, feedback_rating: null, feedback_recommendation: null, feedback_comments: null, feedback_at: null };
    expect(await interviewFeedbackForEdit(fbFake({ row: cleared }).ctx, { id: IV_ID })).toEqual({ ok: true, data: { id: IV_ID, status: 'completed', feedback: null } });
    expect(await interviewFeedbackForEdit(fbFake({ row: null }).ctx, { id: IV_ID })).toEqual({ ok: false, error: NOT_FOUND });
    expect(await interviewFeedbackForEdit(fbFake().ctx, { id: 'interview-7' })).toEqual({ ok: false, error: NOT_AN_INTERVIEW_ID });
  });
  it('a failed read says it could not be loaded and logs only a code', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await interviewFeedbackForEdit(fbFake({ readError: { code: 'PGRST301', message: 'Aina secret' } }).ctx, { id: IV_ID })).toEqual({ ok: false, error: FEEDBACK_NOT_LOADED });
    expect(spy).toHaveBeenLastCalledWith('[hire-capability] interviewFeedbackForEdit failed:', { code: 'PGRST301' });
    expect(await interviewFeedbackForEdit(fbFake({ readThrows: true }).ctx, { id: IV_ID })).toEqual({ ok: false, error: FEEDBACK_NOT_LOADED });
    expect(spy).toHaveBeenLastCalledWith('[hire-capability] interviewFeedbackForEdit failed:', { code: 'Error' });
    expect(JSON.stringify(spy.mock.calls)).not.toMatch(/Aina|77777777/);
    spy.mockRestore();
  });
});
