import { describe, expect, it } from 'vitest';
import { hireAgentNoteInput } from '@/lib/hire/agent/actions';
import type { HireAgentRaw } from '@/lib/hire/agent/context';
import { scanHire, type HireNoteInput } from '@/lib/hire/agent/scan';

// 12:00 on Fri 23 Oct 2026 in Kuala Lumpur.
const NOW = new Date('2026-10-23T04:00:00.000Z');
const AS_OF = ' (as of 23 Oct 2026)';
const DAY = 86_400_000;
/** An instant `n` days before NOW (same Malaysian time of day). */
const ago = (n: number) => new Date(NOW.getTime() - n * DAY).toISOString();

const APP = '11111111-1111-4111-8111-111111111111';
const APP2 = '11111111-1111-4111-8111-222222222222';
const CAND = '22222222-2222-4222-8222-111111111111';
const CAND2 = '22222222-2222-4222-8222-222222222222';
const JOB = '33333333-3333-4333-8333-111111111111';
const INT = '44444444-4444-4444-8444-111111111111';

type App = HireAgentRaw['applications'][number];
type Int = HireAgentRaw['interviews'][number];
type Job = HireAgentRaw['jobs'][number];
type Cand = HireAgentRaw['candidates'][number];

const app = (over: Partial<App> = {}): App => ({
  id: APP,
  candidateId: CAND,
  jobId: JOB,
  candidate: 'Aisyah',
  job: 'Events Executive',
  stage: 'applied',
  outcome: 'active',
  appliedAt: ago(5),
  offeredAt: null,
  hiredAt: null,
  ...over,
});
const interview = (over: Partial<Int> = {}): Int => ({
  id: INT,
  applicationId: APP,
  scheduledAt: ago(3),
  status: 'scheduled',
  createdAt: ago(10),
  updatedAt: ago(10),
  feedbackAt: null,
  ...over,
});
const job = (over: Partial<Job> = {}): Job => ({
  id: JOB,
  title: 'Events Executive',
  status: 'open',
  openedAt: ago(45),
  createdAt: ago(60),
  closesOn: null,
  headcount: 1,
  ...over,
});
const cand = (over: Partial<Cand> = {}): Cand => ({
  id: CAND,
  name: 'Aisyah',
  poolStatus: 'available',
  createdAt: ago(90),
  ...over,
});

function raw(
  checks: { key: string; params: Record<string, number> }[] | null,
  over: Partial<Omit<HireAgentRaw, 'plan'>> = {},
): HireAgentRaw {
  return { plan: checks ? { checks } : null, applications: [], interviews: [], jobs: [], candidates: [], ...over };
}

const one = (key: string, params: Record<string, number>) => [{ key, params }];
const inputs = (r: HireAgentRaw) => scanHire(r, NOW).map((c) => c.input as HireNoteInput);

describe('scanHire', () => {
  it('suggests nothing without a confirmed plan', () => {
    expect(scanHire(raw(null, { applications: [app({ appliedAt: ago(50) })] }), NOW)).toEqual([]);
  });

  it('every check on an empty workspace proposes nothing and does not throw', () => {
    const all = [
      'application_unscreened',
      'screening_no_interview',
      'application_quiet',
      'interview_not_updated',
      'feedback_missing',
      'offer_waiting',
      'job_open_long',
      'job_few_applicants',
      'job_closing_soon',
      'pool_idle',
    ].map((key) => ({ key, params: { days: 7, min: 1 } }));
    expect(scanHire(raw(all), NOW)).toEqual([]);
  });

  it('every input is a valid note input with exactly the five keys', () => {
    const r = raw(one('application_unscreened', { days: 5 }), { applications: [app()] });
    for (const c of scanHire(r, NOW)) {
      expect(c.action).toBe('createAgentNote');
      expect(Object.keys(c.input as object).sort()).toEqual(['body', 'entity_type', 'label', 'stage', 'target']);
      expect(hireAgentNoteInput.safeParse(c.input).success).toBe(true);
    }
  });

  describe('application_unscreened', () => {
    const check = one('application_unscreened', { days: 5 });

    it('fires at N days with the template, and not one day short', () => {
      const got = scanHire(raw(check, { applications: [app()] }), NOW);
      expect(got).toHaveLength(1);
      expect(got[0].checkKey).toBe('application_unscreened');
      expect(got[0].input).toEqual({
        target: APP,
        entity_type: 'hire_application',
        label: 'Aisyah · Events Executive',
        body: `Aisyah applied for Events Executive 5 days ago and is still at Applied.${AS_OF}`,
        stage: '1',
      });
      expect(scanHire(raw(check, { applications: [app({ appliedAt: ago(4) })] }), NOW)).toEqual([]);
    });

    it('stage 1 at 5–9 days, stage 2 at 10–19 days, stage 3 at 20', () => {
      const stageAt = (d: number) => inputs(raw(check, { applications: [app({ appliedAt: ago(d) })] }))[0].stage;
      expect(stageAt(5)).toBe('1');
      expect(stageAt(9)).toBe('1');
      expect(stageAt(10)).toBe('2');
      expect(stageAt(19)).toBe('2');
      expect(stageAt(20)).toBe('3');
    });

    it('ignores other stages, and withdrawn or rejected applications', () => {
      for (const over of [{ stage: 'screening' as const }, { outcome: 'withdrawn' as const }, { outcome: 'rejected' as const }]) {
        expect(scanHire(raw(check, { applications: [app({ appliedAt: ago(30), ...over })] }), NOW)).toEqual([]);
      }
    });
  });

  describe('screening_no_interview', () => {
    const check = one('screening_no_interview', { days: 14 });
    const screening = (over: Partial<App> = {}) => app({ stage: 'screening', appliedAt: ago(14), ...over });

    it('fires with the template when no interview was ever booked, and not one day short', () => {
      expect(inputs(raw(check, { applications: [screening()] }))).toEqual([
        {
          target: APP,
          entity_type: 'hire_application',
          label: 'Aisyah · Events Executive',
          body: `Aisyah is at Screening for Events Executive with no interview booked, 14 days after applying.${AS_OF}`,
          stage: '1',
        },
      ]);
      expect(scanHire(raw(check, { applications: [screening({ appliedAt: ago(13) })] }), NOW)).toEqual([]);
    });

    it('any interview, even a cancelled one, means one was booked', () => {
      const r = raw(check, { applications: [screening()], interviews: [interview({ status: 'cancelled' })] });
      expect(scanHire(r, NOW)).toEqual([]);
    });

    it('ignores withdrawn and rejected applications', () => {
      for (const outcome of ['withdrawn', 'rejected'] as const) {
        expect(scanHire(raw(check, { applications: [screening({ appliedAt: ago(40), outcome })] }), NOW)).toEqual([]);
      }
    });
  });

  describe('application_quiet', () => {
    const check = one('application_quiet', { days: 14 });

    it('fires for interview and offer stages with no activity for N days', () => {
      const r = raw(check, {
        applications: [
          app({ stage: 'interview', appliedAt: ago(30) }),
          app({ id: APP2, candidateId: CAND2, candidate: 'Ben', stage: 'offer', appliedAt: ago(60), offeredAt: ago(14) }),
        ],
      });
      const got = inputs(r);
      expect(got.map((i) => i.body)).toEqual([
        `Aisyah (Events Executive, Interview) has had no activity for 30 days.${AS_OF}`,
        `Ben (Events Executive, Offer) has had no activity for 14 days.${AS_OF}`,
      ]);
      expect(got[0].stage).toBe('2');
      expect(got[1].stage).toBe('1');
    });

    it('counts from the latest interview activity, not from applied_at', () => {
      const r = raw(check, {
        applications: [app({ stage: 'interview', appliedAt: ago(30) })],
        interviews: [interview({ createdAt: ago(20), updatedAt: ago(2) })],
      });
      expect(scanHire(r, NOW)).toEqual([]);
      const feedback = raw(check, {
        applications: [app({ stage: 'interview', appliedAt: ago(30) })],
        interviews: [interview({ createdAt: ago(20), updatedAt: ago(20), feedbackAt: ago(13) })],
      });
      expect(scanHire(feedback, NOW)).toEqual([]);
      const old = raw(check, {
        applications: [app({ stage: 'interview', appliedAt: ago(30) })],
        interviews: [interview({ createdAt: ago(20), updatedAt: ago(15) })],
      });
      expect(inputs(old)[0].body).toContain('no activity for 15 days');
    });

    it('is one day short at 13 days, and ignores applied/screening stages and closed outcomes', () => {
      expect(scanHire(raw(check, { applications: [app({ stage: 'interview', appliedAt: ago(13) })] }), NOW)).toEqual([]);
      for (const over of [
        { stage: 'screening' as const },
        { stage: 'interview' as const, outcome: 'withdrawn' as const },
        { stage: 'offer' as const, outcome: 'rejected' as const },
      ]) {
        expect(scanHire(raw(check, { applications: [app({ appliedAt: ago(40), ...over })] }), NOW)).toEqual([]);
      }
    });
  });

  describe('interview_not_updated', () => {
    const check = one('interview_not_updated', { days: 1 });

    it('fires once for a scheduled interview whose time has passed, with the date', () => {
      const r = raw(check, {
        applications: [app({ stage: 'interview' })],
        interviews: [interview({ scheduledAt: '2026-10-21T02:00:00.000Z' })],
      });
      expect(inputs(r)).toEqual([
        {
          target: INT,
          entity_type: 'hire_interview',
          label: 'Aisyah · Events Executive',
          body: `The interview with Aisyah for Events Executive on 21 Oct 2026 is still marked Scheduled.${AS_OF}`,
          stage: 'once',
        },
      ]);
    });

    it('not one day short, not when completed, and not for a withdrawn or rejected application', () => {
      const today = raw(check, { applications: [app({ stage: 'interview' })], interviews: [interview({ scheduledAt: ago(0) })] });
      expect(scanHire(today, NOW)).toEqual([]);
      const done = raw(check, {
        applications: [app({ stage: 'interview' })],
        interviews: [interview({ status: 'completed', scheduledAt: ago(5) })],
      });
      expect(scanHire(done, NOW)).toEqual([]);
      for (const outcome of ['withdrawn', 'rejected'] as const) {
        const r = raw(check, { applications: [app({ stage: 'interview', outcome })], interviews: [interview({ scheduledAt: ago(5) })] });
        expect(scanHire(r, NOW)).toEqual([]);
      }
    });
  });

  describe('feedback_missing', () => {
    const check = one('feedback_missing', { days: 2 });

    it('fires once for a completed interview with no feedback, held N days ago', () => {
      const r = raw(check, {
        applications: [app({ stage: 'interview' })],
        interviews: [interview({ status: 'completed', scheduledAt: '2026-10-21T02:00:00.000Z' })],
      });
      expect(inputs(r)).toEqual([
        {
          target: INT,
          entity_type: 'hire_interview',
          label: 'Aisyah · Events Executive',
          body: `The interview with Aisyah for Events Executive on 21 Oct 2026 has no feedback yet.${AS_OF}`,
          stage: 'once',
        },
      ]);
    });

    it('not one day short, not with feedback, not while still scheduled, and not for closed applications', () => {
      const base = { applications: [app({ stage: 'interview' })] };
      expect(scanHire(raw(check, { ...base, interviews: [interview({ status: 'completed', scheduledAt: ago(1) })] }), NOW)).toEqual([]);
      expect(
        scanHire(raw(check, { ...base, interviews: [interview({ status: 'completed', scheduledAt: ago(5), feedbackAt: ago(4) })] }), NOW),
      ).toEqual([]);
      expect(scanHire(raw(check, { ...base, interviews: [interview({ status: 'scheduled', scheduledAt: ago(5) })] }), NOW)).toEqual([]);
      for (const outcome of ['withdrawn', 'rejected'] as const) {
        const r = raw(check, {
          applications: [app({ stage: 'interview', outcome })],
          interviews: [interview({ status: 'completed', scheduledAt: ago(5) })],
        });
        expect(scanHire(r, NOW)).toEqual([]);
      }
    });
  });

  describe('offer_waiting', () => {
    const check = one('offer_waiting', { days: 7 });

    it('fires with the template at N days, and not one day short', () => {
      const r = raw(check, { applications: [app({ stage: 'offer', appliedAt: ago(40), offeredAt: ago(7) })] });
      expect(inputs(r)).toEqual([
        {
          target: APP,
          entity_type: 'hire_application',
          label: 'Aisyah · Events Executive',
          body: `The offer to Aisyah for Events Executive was made 7 days ago and has no answer recorded.${AS_OF}`,
          stage: '1',
        },
      ]);
      expect(scanHire(raw(check, { applications: [app({ stage: 'offer', offeredAt: ago(6) })] }), NOW)).toEqual([]);
    });

    it('ignores offers with no time, and withdrawn or rejected applications', () => {
      expect(scanHire(raw(check, { applications: [app({ stage: 'offer', offeredAt: null, appliedAt: ago(30) })] }), NOW)).toEqual([]);
      for (const outcome of ['withdrawn', 'rejected'] as const) {
        expect(scanHire(raw(check, { applications: [app({ stage: 'offer', offeredAt: ago(30), outcome })] }), NOW)).toEqual([]);
      }
    });
  });

  describe('job_open_long', () => {
    const check = one('job_open_long', { days: 45 });

    it('fires for an open job past N days with fewer hires than headcount', () => {
      const r = raw(check, {
        jobs: [job({ headcount: 2 })],
        applications: [
          app({ stage: 'hired', hiredAt: ago(3) }),
          app({ id: APP2, stage: 'hired', outcome: 'withdrawn' }),
        ],
      });
      expect(inputs(r)).toEqual([
        {
          target: JOB,
          entity_type: 'hire_job',
          label: 'Events Executive',
          body: `Events Executive has been open 45 days with 1 of 2 hired.${AS_OF}`,
          stage: '1',
        },
      ]);
    });

    it('a null headcount counts as 1, and a filled job is silent', () => {
      expect(inputs(raw(check, { jobs: [job({ headcount: null })] }))[0].body).toContain('with 0 of 1 hired');
      expect(scanHire(raw(check, { jobs: [job({ headcount: null })], applications: [app({ stage: 'hired' })] }), NOW)).toEqual([]);
    });

    it('a null opened_at falls back to created_at', () => {
      expect(inputs(raw(check, { jobs: [job({ openedAt: null, createdAt: ago(50) })] }))[0].body).toContain('open 50 days');
      expect(scanHire(raw(check, { jobs: [job({ openedAt: null, createdAt: ago(44) })] }), NOW)).toEqual([]);
    });

    it('not one day short, and not for paused, draft or closed jobs', () => {
      expect(scanHire(raw(check, { jobs: [job({ openedAt: ago(44) })] }), NOW)).toEqual([]);
      for (const status of ['paused', 'draft', 'closed'] as const) {
        expect(scanHire(raw(check, { jobs: [job({ status, openedAt: ago(100) })] }), NOW)).toEqual([]);
      }
    });
  });

  describe('job_few_applicants', () => {
    const check = one('job_few_applicants', { days: 14, min: 2 });

    it('fires when fewer than min applications came in the last N days', () => {
      const r = raw(check, {
        jobs: [job({ openedAt: ago(14) })],
        applications: [app({ appliedAt: ago(3) }), app({ id: APP2, appliedAt: ago(14) })],
      });
      expect(inputs(r)).toEqual([
        {
          target: JOB,
          entity_type: 'hire_job',
          label: 'Events Executive',
          body: `Events Executive has had 1 new application in the last 14 days.${AS_OF}`,
          stage: '1',
        },
      ]);
    });

    it('counts every application received, whatever happened to it since', () => {
      const r = raw(check, {
        jobs: [job({ openedAt: ago(14) })],
        applications: [app({ appliedAt: ago(3), outcome: 'rejected' }), app({ id: APP2, appliedAt: ago(1), outcome: 'withdrawn' })],
      });
      expect(scanHire(r, NOW)).toEqual([]);
    });

    it('waits until the job has been open N days (null opened_at uses created_at), and skips closed jobs', () => {
      expect(scanHire(raw(check, { jobs: [job({ openedAt: ago(13) })] }), NOW)).toEqual([]);
      expect(inputs(raw(check, { jobs: [job({ openedAt: null, createdAt: ago(20) })] }))[0].body).toBe(
        `Events Executive has had 0 new applications in the last 14 days.${AS_OF}`,
      );
      expect(scanHire(raw(check, { jobs: [job({ openedAt: null, createdAt: ago(13) })] }), NOW)).toEqual([]);
      expect(scanHire(raw(check, { jobs: [job({ status: 'closed' })] }), NOW)).toEqual([]);
    });
  });

  describe('job_closing_soon', () => {
    const check = one('job_closing_soon', { days: 7 });

    it('fires once per closing date, counting active applications still in progress', () => {
      const r = raw(check, {
        jobs: [job({ closesOn: '2026-10-30' })],
        applications: [
          app(),
          app({ id: APP2, stage: 'interview' }),
          app({ id: 'x', stage: 'hired' }),
          app({ id: 'y', outcome: 'withdrawn' }),
        ],
      });
      expect(inputs(r)).toEqual([
        {
          target: JOB,
          entity_type: 'hire_job',
          label: 'Events Executive',
          body: `Events Executive closes on 30 Oct 2026 with 2 active applications.${AS_OF}`,
          stage: '2026-10-30',
        },
      ]);
    });

    it('not one day too far out, not after it closed, and not for jobs that are not open', () => {
      expect(scanHire(raw(check, { jobs: [job({ closesOn: '2026-10-31' })] }), NOW)).toEqual([]);
      expect(scanHire(raw(check, { jobs: [job({ closesOn: '2026-10-22' })] }), NOW)).toEqual([]);
      expect(inputs(raw(check, { jobs: [job({ closesOn: '2026-10-23' })] }))).toHaveLength(1);
      expect(scanHire(raw(check, { jobs: [job({ status: 'paused', closesOn: '2026-10-25' })] }), NOW)).toEqual([]);
    });
  });

  describe('pool_idle', () => {
    const check = one('pool_idle', { days: 90 });

    it('fires for someone in the pool, on file N days, with no active application', () => {
      const r = raw(check, {
        candidates: [cand({ poolStatus: 're_engaged' })],
        applications: [app({ outcome: 'rejected' })],
      });
      expect(inputs(r)).toEqual([
        {
          target: CAND,
          entity_type: 'hire_candidate',
          label: 'Aisyah',
          body: `Aisyah has been on file 90 days, is in the talent pool (Re-engaged), and isn't in any current application.${AS_OF}`,
          stage: '1',
        },
      ]);
    });

    it("ignores pool_status 'none', anyone with an active application, and one day short", () => {
      expect(scanHire(raw(check, { candidates: [cand({ poolStatus: 'none' })] }), NOW)).toEqual([]);
      expect(scanHire(raw(check, { candidates: [cand()], applications: [app({ stage: 'screening' })] }), NOW)).toEqual([]);
      expect(scanHire(raw(check, { candidates: [cand({ createdAt: ago(89) })] }), NOW)).toEqual([]);
    });
  });

  it('fairness: labels, bodies and titles never carry contact details, skills or location', () => {
    const extra = { email: 'aisyah@example.com', phone: '+60123456789', skills: ['Photoshop'], location: 'Shah Alam' };
    const r = raw(
      [
        { key: 'application_unscreened', params: { days: 5 } },
        { key: 'pool_idle', params: { days: 30 } },
        { key: 'interview_not_updated', params: { days: 1 } },
      ],
      {
        applications: [{ ...app({ appliedAt: ago(10) }), ...extra } as App],
        candidates: [{ ...cand({ id: CAND2, name: 'Ben' }), ...extra } as Cand],
        interviews: [{ ...interview({ scheduledAt: ago(5) }), ...extra } as Int],
      },
    );
    const got = scanHire(r, NOW);
    expect(got.length).toBe(3);
    for (const c of got) {
      const text = JSON.stringify([c.title, c.input]);
      for (const secret of ['aisyah@example.com', '+60123456789', 'Photoshop', 'Shah Alam']) expect(text).not.toContain(secret);
    }
  });
});
