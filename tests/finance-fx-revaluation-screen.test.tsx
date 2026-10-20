import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The FX Revaluation loader: who is given Post (an owner or admin), who is told who posts (a member), that every
 * role previews and reads the runs, which month end is shown first (Malaysia's), which month ends are offered,
 * and when a workspace is ringgit only. The view and the reads are mocked; the loader's own wiring is read.
 */

const actions = vi.hoisted(() => ({
  previewFxRevaluationAction: vi.fn(),
  postFxRevaluationAction: vi.fn(),
}));
vi.mock('@/app/(app)/finance/actions', () => actions);

const state = vi.hoisted(() => ({
  viewer: { orgId: 'org', role: 'owner', isDemo: false } as { orgId: string; role: string; isDemo: boolean },
  previews: [] as unknown[],
  preview: async (): Promise<unknown[]> => [],
  runs: async (): Promise<unknown[]> => [],
  books: async (): Promise<unknown> => ({ firstForeignDate: '2026-07-15', revaluedMonthEnds: [] }),
  profiles: [] as { user_id: string; full_name: string | null; email: string | null }[],
}));
vi.mock('@/lib/auth/viewer', () => ({ getViewer: async () => state.viewer, hasSupabaseEnv: () => true }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    from: () => ({ select: () => ({ in: async () => ({ data: state.profiles, error: null }) }) }),
  }),
}));
vi.mock('@/lib/finance/fx-revaluation', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  previewFxRevaluation: async (_ctx: unknown, input: unknown) => {
    state.previews.push(input);
    return state.preview();
  },
  listFxRevaluations: async () => state.runs(),
}));
vi.mock('@/lib/finance/reports-data', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readFxBooks: async () => state.books(),
}));
// Replace the view with a component that is never rendered: the element's props are what the loader decided.
vi.mock('@/components/finance/fx-revaluation-view', () => ({ FxRevaluationView: () => null, FX_MEMBER_NOTE: '' }));

import FxRevaluationScreen from '@/screens/finance/fx-revaluation';

type Props = {
  monthEnds: string[];
  periodEnd: string;
  items: unknown[] | null;
  itemsError: string | null;
  runs: unknown[] | null;
  postedBy: Record<string, string>;
  actions: { preview: unknown; post?: unknown };
  memberNote: boolean;
  ringgitOnly: boolean;
};
const load = async (role: string, isDemo = false) => {
  state.viewer = { orgId: 'org', role, isDemo };
  const element = (await FxRevaluationScreen()) as { props: Props };
  return element.props;
};

const ITEM = { kind: 'invoice', item_id: 'a', currency: 'USD', foreign_balance: 600 };

beforeEach(() => {
  // 21 October 2026, 00:30 in Malaysia, still 20 October in UTC.
  vi.useFakeTimers({ now: new Date('2026-10-20T16:30:00Z'), toFake: ['Date'] });
  state.previews.length = 0;
  state.preview = async () => [ITEM];
  state.runs = async () => [];
  state.books = async () => ({ firstForeignDate: '2026-07-15', revaluedMonthEnds: [] });
  state.profiles = [];
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the FX Revaluation loader', () => {
  it('gives an owner and an admin Post and the preview, and no member line', async () => {
    for (const role of ['owner', 'admin']) {
      const props = await load(role);
      expect(props.actions).toEqual({ preview: actions.previewFxRevaluationAction, post: actions.postFxRevaluationAction });
      expect(props.memberNote).toBe(false);
    }
  });

  it('gives a member the preview only, and the line saying who posts', async () => {
    const props = await load('member');
    expect(props.actions).toEqual({ preview: actions.previewFxRevaluationAction });
    expect(props.memberNote).toBe(true);
  });

  it('gives a viewer and a demo guest (even as owner) the preview only, and no member line', async () => {
    for (const [role, demo] of [['viewer', false], ['owner', true]] as const) {
      const props = await load(role, demo);
      expect(props.actions).toEqual({ preview: actions.previewFxRevaluationAction });
      expect(props.memberNote).toBe(false);
    }
  });

  it('previews the last month end on or before today in Malaysia, with no rates sent, for every role', async () => {
    for (const role of ['owner', 'member', 'viewer']) await load(role);
    expect(state.previews).toEqual([
      { period_end: '2026-09-30', rates: {} },
      { period_end: '2026-09-30', rates: {} },
      { period_end: '2026-09-30', rates: {} },
    ]);
    const props = await load('viewer');
    expect([props.periodEnd, props.items]).toEqual(['2026-09-30', [ITEM]]);
  });

  it('offers every month end from the first foreign item to the newest', async () => {
    expect((await load('owner')).monthEnds).toEqual(['2026-09-30', '2026-08-31', '2026-07-31']);
    state.books = async () => null as never;
    state.runs = async () => [{ id: 'r', period_end: '2026-06-30', posted_by: null, lines: [] }];
    expect((await load('owner')).monthEnds).toEqual(['2026-09-30', '2026-08-31', '2026-07-31', '2026-06-30']);
  });

  it('calls a workspace ringgit only when nothing foreign was ever in its books', async () => {
    state.preview = async () => [];
    state.books = async () => ({ firstForeignDate: null, revaluedMonthEnds: [] });
    const props = await load('owner');
    expect(props.ringgitOnly).toBe(true);
    expect(props.monthEnds).toEqual(['2026-09-30']);
    // Not when the books could not be read, nor with a posted run.
    state.books = async () => {
      throw new Error('boom');
    };
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect((await load('owner')).ringgitOnly).toBe(false);
    spy.mockRestore();
  });

  it('names who posted each run from the workspace\'s profiles', async () => {
    state.runs = async () => [{ id: 'r', period_end: '2026-08-31', posted_by: 'u1', lines: [] }, { id: 's', period_end: '2026-07-31', posted_by: 'u2', lines: [] }];
    state.profiles = [{ user_id: 'u1', full_name: 'Aminah Ismail', email: 'a@x.test' }, { user_id: 'u2', full_name: null, email: 'b@x.test' }];
    expect((await load('owner')).postedBy).toEqual({ u1: 'Aminah Ismail', u2: 'b@x.test' });
  });

  it('says why the preview was refused, and shows the page without the runs when they cannot be read', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    state.preview = async () => {
      throw { code: '42501' };
    };
    state.runs = async () => {
      throw new Error('boom');
    };
    const props = await load('viewer');
    expect(props.items).toBeNull();
    expect(props.itemsError).toBe('You do not have permission to make changes here.');
    expect(props.runs).toBeNull();
    spy.mockRestore();
  });
});
