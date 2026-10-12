// tests/hire-id-messages.test.ts
import { describe, expect, it } from 'vitest';
import {
  addCandidateInput,
  deleteApplicationInput,
  deleteCandidateInput,
  deleteJobInput,
  moveApplicationInput,
  moveToPipelineInput,
  setPoolStatusInput,
  updateCandidateInput,
} from '@/lib/hire/capabilities';

/**
 * A made-up id is refused by the tool's own input check, before any of the
 * assistant's checks run, so what that check says is all the model is told.
 * A question-set run showed the worker inventing "candidate-4842", being told
 * only that it was malformed, and the user being told the change was impossible.
 * So the message says where a real id comes from.
 */
const MADE_UP = 'candidate-4842';
const UUID = '11111111-1111-4111-8111-111111111111';
const said = (schema: { safeParse: (v: unknown) => { success: boolean; error?: { issues: { message: string }[] } } }, input: unknown) => {
  const parsed = schema.safeParse(input);
  expect(parsed.success).toBe(false);
  return parsed.error!.issues.map((issue) => issue.message).join(' ');
};

describe('a made-up id is answered with where to get a real one', () => {
  it('for a candidate', () => {
    for (const [schema, input] of [
      [deleteCandidateInput, { id: MADE_UP }],
      [updateCandidateInput, { id: MADE_UP }],
      [setPoolStatusInput, { id: MADE_UP, status: 'passive' }],
      [moveToPipelineInput, { id: MADE_UP, job_id: UUID }],
    ] as const) {
      const message = said(schema, input);
      expect(message).toContain('listCandidates');
      expect(message).toContain('Never make one up.');
    }
  });
  it('for an application', () => {
    for (const [schema, input] of [
      [deleteApplicationInput, { id: MADE_UP }],
      [moveApplicationInput, { id: MADE_UP, stage: 'interview' }],
    ] as const) {
      const message = said(schema, input);
      expect(message).toContain('listApplications');
      expect(message).toContain('Never make one up.');
    }
  });
  it('for a job', () => {
    for (const [schema, input] of [
      [deleteJobInput, { id: MADE_UP }],
      [moveToPipelineInput, { id: UUID, job_id: 'job-12' }],
      [addCandidateInput, { name: 'Aina', job_id: 'job-12' }],
    ] as const) {
      const message = said(schema, input);
      expect(message).toContain('listJobs');
      expect(message).toContain('Never make one up.');
    }
  });
  it('names no id back, so nothing a model typed is echoed', () => {
    expect(said(deleteCandidateInput, { id: MADE_UP })).not.toContain(MADE_UP);
  });
});
