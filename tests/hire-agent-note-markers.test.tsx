import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { NoteCounts } from '@/lib/hire/agent/notes';
import type { ApplicationsModel, InterviewRow, InterviewsModel, JobsModel, PoolModel } from '@/lib/hire/lists';
import type { Job } from '@/lib/hire/types';

/**
 * The agent note marker on Lekir's four list screens (Applications, Interviews, Jobs, Talent
 * Pool): each reads the note counts for exactly the rows it loaded, shows the count with the
 * newest note as its tooltip, and still renders, with no marker, when the counts can't be read.
 */

const mocks = vi.hoisted(() => ({
  viewer: { orgId: 'org1', role: 'member', isDemo: false } as { orgId: string; role: string; isDemo: boolean },
  models: {} as Record<string, unknown>,
  counts: null as null | ((ids: readonly string[]) => Promise<NoteCounts | null>),
  seen: [] as { type: string; ids: readonly string[] }[],
  action: vi.fn(),
}));

vi.mock('@/app/(app)/hire/actions', () => {
  const names = [
    'createJobAction', 'updateJobAction', 'setJobStatusAction', 'deleteJobAction', 'moveApplicationAction', 'closeApplicationAction',
    'reopenApplicationAction', 'rateApplicationAction', 'updateCareersPageAction', 'updateApplicationFormAction', 'viewCvAction',
    'addCandidateAction', 'getCandidateAction', 'updateCandidateAction', 'deleteApplicationAction', 'deleteCandidateAction',
    'getDeletionSummaryAction', 'setPoolStatusAction', 'moveToPipelineAction', 'searchPoolPickerAction', 'searchInterviewPickerAction',
    'getInterviewInvitationAction', 'getInterviewForEditAction', 'scheduleInterviewAction', 'recordPastInterviewAction',
    'rescheduleInterviewAction', 'cancelInterviewAction', 'setInterviewOutcomeAction', 'reopenInterviewAction',
    'saveInterviewFeedbackAction', 'clearInterviewFeedbackAction', 'getInterviewFeedbackAction',
  ];
  return Object.fromEntries(names.map((n) => [n, mocks.action]));
});
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {}, replace: () => {} }),
  usePathname: () => '/hire',
}));
vi.mock('@/lib/auth/viewer', () => ({ getViewer: async () => mocks.viewer }));
vi.mock('@/screens/hire/parts', () => ({
  LOAD_FAILED: <p>load failed</p>,
  NOT_AVAILABLE: <p>not available</p>,
  Muted: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  FUNNEL_COLOR: {},
  topSlices: () => [],
  loadHire: async (tag: string) => ({ model: mocks.models[tag] ?? null, isDemo: false }),
}));
vi.mock('@/components/charts', () => ({
  AreaTrend: () => null, BarGroup: () => null, DonutStat: () => null, FunnelFlow: () => null,
}));
vi.mock('@/components/ui/dropdown-menu', () => {
  const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
  return {
    DropdownMenu: Pass, DropdownMenuTrigger: Pass, DropdownMenuContent: Pass, DropdownMenuLabel: Pass,
    DropdownMenuRadioGroup: Pass, DropdownMenuSeparator: () => null, DropdownMenuItem: Pass, DropdownMenuRadioItem: Pass,
  };
});
vi.mock('@/components/ui/select', () => {
  const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
  return { Select: Pass, SelectTrigger: Pass, SelectValue: () => null, SelectContent: Pass, SelectItem: Pass };
});
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({}) }));
vi.mock('@/lib/hire/agent/notes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/hire/agent/notes')>()),
  noteCountsFor: async (_ctx: unknown, type: string, ids: readonly string[]) => {
    mocks.seen.push({ type, ids });
    return mocks.counts!(ids);
  },
}));

const ApplicationsScreen = (await import('@/screens/hire/applications')).default;
const InterviewsScreen = (await import('@/screens/hire/interviews')).default;
const JobsScreen = (await import('@/screens/hire/jobs')).default;
const TalentPoolScreen = (await import('@/screens/hire/talent-pool')).default;

/* ---- one row per screen ---- */

const APP = '44444444-4444-4444-8444-444444444444';
const IV = '77777777-7777-4777-8777-777777777777';
const JOB = '55555555-5555-4555-8555-555555555555';
const CANDIDATE = '33333333-3333-4333-8333-333333333333';

const applications: ApplicationsModel = {
  isEmpty: false,
  total: 1,
  rows: [
    {
      id: APP, candidateId: CANDIDATE, name: 'Aina Rahman', job: 'Sales Executive', source: 'Referral', status: 'New', applied: '08 Oct 2026',
      details: null, interviews: [], stage: 'applied', outcome: 'active', rating: null, rejectReason: null,
    },
  ],
  statusMix: [{ key: 'New', value: 1 }],
  byJob: [],
};

const interviewRow: InterviewRow = {
  id: IV, name: 'Aina Rahman', role: 'Sales Executive', date: '20 Oct 2026', time: '3:00 pm', interviewer: 'Farah Lim', type: 'Video', status: 'Scheduled',
  applicationId: APP, statusKey: 'scheduled', scheduledAt: '2026-10-20T07:00:00+00:00', durationMinutes: 60, length: '1 hour', kind: 'video',
  place: null, placeLink: null, interviewerName: 'Farah Lim', notes: null, createdAt: '2026-10-12T02:00:00+00:00', updatedAt: '2026-10-12T02:05:00+00:00',
  applicationStage: 'interview', applicationOutcome: 'active', needsOutcome: false,
};
const interviews: InterviewsModel = {
  isEmpty: false,
  rows: [interviewRow],
  upcoming: [],
  scheduled: 1, ahead: 0, completed: 0, noShow: 0, next7Days: 0, weekLoad: [],
  applications: [], applicationsCut: false, today: '2026-10-12',
};

const job: Job = {
  id: JOB, title: 'Sales Executive', department: 'Sales', location: 'Klang', employment_type: 'full_time', status: 'open', description: 'Sell.',
  salary_min_cents: null, salary_max_cents: null, show_salary: false, closes_on: null, work_arrangement: null, headcount: 1,
  opened_at: '2026-09-01T00:00:00Z', closed_at: null, created_at: '2026-09-01T00:00:00Z',
};
const jobs: JobsModel = {
  isEmpty: false,
  rows: [{ id: JOB, title: 'Sales Executive', dept: 'Sales', applicants: 1, status: 'Open', posted: '1 month ago', job }],
  statusMix: [],
  byJob: [],
  totalApplicants: 1,
  openJobs: 1,
};

const pool: PoolModel = {
  isEmpty: false,
  size: 1,
  rows: [
    { id: CANDIDATE, name: 'Siti Nur Aisyah', title: 'Barista', skills: ['POS'], location: 'Klang', source: 'Referral', rating: 4, status: 'Available', poolStatus: 'available' },
  ],
  statusCounts: [{ key: 'Available', value: 1 }],
  byTitle: [],
  bySource: [],
  jobs: [],
  search: null,
  matched: 1,
  readCapped: false,
};

const screens = [
  { name: 'Applications', type: 'hire_application', id: APP, render: async () => renderToStaticMarkup(await ApplicationsScreen()) },
  { name: 'Interviews', type: 'hire_interview', id: IV, render: async () => renderToStaticMarkup(await InterviewsScreen()) },
  { name: 'Jobs', type: 'hire_job', id: JOB, render: async () => renderToStaticMarkup(await JobsScreen()) },
  { name: 'Talent Pool', type: 'hire_candidate', id: CANDIDATE, render: async () => renderToStaticMarkup(await TalentPoolScreen()) },
];

/** Any marker's screen-reader text. */
const ANY = /\d+ agent notes?:/;

beforeEach(() => {
  mocks.viewer = { orgId: 'org1', role: 'member', isDemo: false };
  mocks.models = { applications, interviews, jobs, 'talent-pool': pool };
  mocks.seen = [];
  mocks.counts = async (ids) => Object.fromEntries(ids.map((id) => [id, { count: 2, latest: `LATEST ${id}` }]));
});

describe('the agent note marker on Lekir list rows', () => {
  for (const s of screens) {
    it(`${s.name}: reads counts for exactly the rows it loaded and shows the count with the newest note`, async () => {
      const html = await s.render();
      expect(mocks.seen).toEqual([{ type: s.type, ids: [s.id] }]);
      expect(html).toContain(`<span class="sr-only">2 agent notes: LATEST ${s.id}</span>`);
      expect(html).toContain('<span aria-hidden="true">2</span>');
      expect(html).toContain(`title="LATEST ${s.id}"`);
    });

    it(`${s.name}: still renders, with no marker, when the counts could not be read`, async () => {
      mocks.counts = async () => null;
      const html = await s.render();
      expect(html).not.toMatch(ANY);
      expect(html).not.toContain('load failed');
    });

    it(`${s.name}: reads nothing in the demo workspace`, async () => {
      mocks.viewer = { orgId: 'org1', role: 'owner', isDemo: true };
      const html = await s.render();
      expect(mocks.seen).toEqual([]);
      expect(html).not.toMatch(ANY);
    });
  }

  it('says "note" for a single one', async () => {
    mocks.counts = async (ids) => ({ [ids[0]]: { count: 1, latest: 'Waiting 6 days' } });
    const html = await screens[0].render();
    expect(html).toContain('<span class="sr-only">1 agent note: Waiting 6 days</span>');
  });
});
