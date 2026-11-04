import { beforeEach, describe, expect, it, vi } from 'vitest';

const ctl = vi.hoisted(() => ({ verdict: { allowed: true, enforced: true } as unknown, checks: [] as unknown[] }));
vi.mock('@/lib/security/rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/security/rate-limit')>()),
  consumeRateLimits: async (checks: unknown[]) => {
    ctl.checks = checks;
    return ctl.verdict;
  },
}));

import { SUPPORT_QUESTION_PER_USER, supportQuestionLimited } from '@/lib/security/limits';

beforeEach(() => {
  ctl.verdict = { allowed: true, enforced: true };
});

describe('the support question allowance', () => {
  it('is 10 a week per person, counted by user id', async () => {
    expect(SUPPORT_QUESTION_PER_USER).toMatchObject({ bucket: 'support_question', limit: 10, windowSeconds: 7 * 24 * 3600 });
    expect(await supportQuestionLimited('u1')).toBe('ok');
    expect(ctl.checks).toEqual([{ bucket: 'support_question', value: 'u1', limit: 10, windowSeconds: 604800 }]);
  });

  it('says limited once the week is used up', async () => {
    ctl.verdict = { allowed: false, retryAfterSeconds: 3600 };
    expect(await supportQuestionLimited('u1')).toBe('limited');
  });

  it('fails closed when the counter cannot be asked', async () => {
    ctl.verdict = { allowed: true, enforced: false };
    expect(await supportQuestionLimited('u1')).toBe('unavailable');
  });
});
