import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PoolModel } from '@/lib/hire/lists';

/**
 * The Talent Pool screen and the pool's controls, as the server sends them:
 * rendered to a string and read as markup. There is no DOM here, so nothing can
 * be pressed, typed, focused or closed: what a control decides is in plain
 * functions (tests/hire-pool-dialog-state.test.ts, tests/hire-pool.test.ts).
 * What still needs a browser is in the plan's smoke checklist.
 */

const mocks = vi.hoisted(() => ({
  viewer: { orgId: 'org1', role: 'member', isDemo: false } as { orgId: string; role: string; isDemo: boolean },
  pool: null as unknown,
  searched: [] as unknown[],
  action: vi.fn(),
  refresh: vi.fn(),
  replace: vi.fn(),
}));

vi.mock('@/app/(app)/hire/actions', () => ({
  moveApplicationAction: mocks.action,
  closeApplicationAction: mocks.action,
  reopenApplicationAction: mocks.action,
  rateApplicationAction: mocks.action,
  viewCvAction: mocks.action,
  addCandidateAction: mocks.action,
  getCandidateAction: mocks.action,
  updateCandidateAction: mocks.action,
  deleteApplicationAction: mocks.action,
  deleteCandidateAction: mocks.action,
  getDeletionSummaryAction: mocks.action,
  setPoolStatusAction: mocks.action,
  moveToPipelineAction: mocks.action,
  listPoolPickerAction: mocks.action,
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mocks.refresh, replace: mocks.replace }),
  usePathname: () => '/hire/talent-pool',
}));
vi.mock('@/lib/auth/viewer', () => ({ getViewer: async () => mocks.viewer }));
// The real loader reads the session and the database. Here it hands back the model under test, and notes what the
// screen asked it to build: the search text must reach buildPoolModel.
vi.mock('@/lib/hire/lists', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/hire/lists')>();
  return {
    ...actual,
    buildPoolModel: async (_data: unknown, search?: string | null) => {
      mocks.searched.push(search ?? null);
      return mocks.pool;
    },
  };
});
vi.mock('@/screens/hire/parts', () => ({
  LOAD_FAILED: <p>load failed</p>,
  Muted: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  FUNNEL_COLOR: {},
  topSlices: () => [],
  loadHire: async (_tag: string, build: (data: unknown, now: Date) => Promise<unknown>) => ({ model: await build({}, new Date()), isDemo: false }),
}));
vi.mock('@/components/charts', () => ({
  AreaTrend: () => null, BarGroup: () => null, DonutStat: () => null, FunnelFlow: () => null,
}));
// A closed menu draws nothing but its button. Here its items are drawn in place, so what the menu offers can be read.
vi.mock('@/components/ui/dropdown-menu', () => {
  const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
  const Item = ({ children, variant }: { children?: ReactNode; variant?: string }) => (
    <div role="menuitem" data-variant={variant ?? 'default'}>{children}</div>
  );
  const Radio = ({ children, value }: { children?: ReactNode; value?: string }) => (
    <div role="menuitemradio" data-value={value}>{children}</div>
  );
  const Group = ({ children, value }: { children?: ReactNode; value?: string }) => <div role="group" data-checked={value}>{children}</div>;
  return {
    DropdownMenu: Pass, DropdownMenuTrigger: Pass, DropdownMenuContent: Pass,
    DropdownMenuLabel: ({ children }: { children?: ReactNode }) => <p data-menu-label="">{children}</p>,
    DropdownMenuRadioGroup: Group, DropdownMenuSeparator: () => <hr />, DropdownMenuItem: Item, DropdownMenuRadioItem: Radio,
  };
});

import { ApplicationActions, ApplicationMenu, type ApplicationSubject } from '@/screens/hire/application-actions';
import { AddToPool, PoolFooter, PoolRowControls, PoolSearch } from '@/screens/hire/pool-actions';
import TalentPoolScreen from '@/screens/hire/talent-pool';
import { DELETION_NOTICE_ID } from '@/lib/hire/delete-dialog-state';

const CANDIDATE = '33333333-3333-4333-8333-333333333333';
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const unescape = (html: string) => html.replace(/&quot;/g, '"').replace(/&#x27;/g, '\'').replace(/&amp;/g, '&');
const buttons = (html: string) =>
  [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map(([, attrs, inner]) => /aria-label="([^"]*)"/.exec(attrs)?.[1] ?? text(inner));
const tagOf = (html: string, pattern: RegExp) => pattern.exec(html)?.[0] ?? '';
/** The opening tag of every link named "Clear search". */
const clearLinks = (html: string) => [...html.matchAll(/<a\b[^>]*>/g)].map(([tag]) => tag).filter((tag) => tag.includes('aria-label="Clear search"'));
// The attribute, not the `disabled:` classes every button carries.
const DISABLED = /\sdisabled(=|\s|>)/;
const row = (over: Partial<PoolModel['rows'][number]> = {}): PoolModel['rows'][number] => ({
  id: CANDIDATE, name: 'Aina binti Salleh', title: 'Barista', skills: ['POS'], location: 'Klang', source: 'Referral', rating: 4,
  status: 'Available', poolStatus: 'available', ...over,
});
const pool = (over: Partial<PoolModel> = {}): PoolModel => ({
  isEmpty: false,
  size: 1,
  rows: [row()],
  statusCounts: [
    { key: 'Available', value: 4 }, { key: 'Shortlisted', value: 3 }, { key: 'Passive', value: 2 }, { key: 'Re-engaged', value: 1 },
  ],
  byTitle: [{ label: 'Barista', value: 1 }],
  bySource: [{ label: 'Referral', value: 1 }],
  jobs: [{ id: 'j1', title: 'Barista', status: 'open' }, { id: 'j2', title: 'Sales Executive', status: 'paused' }],
  search: null,
  matched: 1,
  readCapped: false,
  ...over,
});
const screen = async (q?: string | string[]) =>
  renderToStaticMarkup(await TalentPoolScreen(q === undefined ? {} : { searchParams: Promise.resolve({ q }) }));

beforeEach(() => {
  mocks.viewer = { orgId: 'org1', role: 'member', isDemo: false };
  mocks.pool = pool();
  mocks.searched = [];
  mocks.action.mockReset();
  mocks.refresh.mockReset();
  mocks.replace.mockReset();
});

describe('the tiles', () => {
  it('are five: the size, then Available, Shortlisted, Passive and Re-engaged, which add up to it', async () => {
    mocks.pool = pool({ size: 10 });
    const said = text(await screen());
    const at = ['Talent pool size', 'Available', 'Shortlisted', 'Passive', 'Re-engaged'].map((label) => said.indexOf(label));
    expect(at.every((n) => n >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    // Each figure beside its own label, whichever of the two the tile draws first.
    for (const [label, value] of [['Talent pool size', 10], ['Available', 4], ['Shortlisted', 3], ['Passive', 2], ['Re-engaged', 1]] as const) {
      expect(said, label).toMatch(new RegExp(`${label}\\D{0,20}\\b${value}\\b|\\b${value}\\b\\D{0,20}${label}`));
    }
  });
  it('the size tile spans both columns on a phone and four of twelve from the medium width; each status tile one and two', async () => {
    const html = await screen();
    expect(html.match(/col-span-2 md:col-span-4/g)).toHaveLength(2); // the size tile, and the skills chart below
    expect(html.match(/col-span-1 md:col-span-2/g)).toHaveLength(4);
    expect(html).not.toContain('col-span-1 md:col-span-3');
  });
});

describe('the search box', () => {
  it('hands the q of the address to the read, trimmed, the first of several, and nothing when blank', async () => {
    await screen('  aina ');
    await screen(['zarina', 'kamal']);
    await screen('   ');
    await screen();
    expect(mocks.searched).toEqual(['aina', 'zarina', null, null]);
  });
  it('is a search form with a labelled field named q, a real method and no "Coming soon"', async () => {
    const html = await screen();
    const form = tagOf(html, /<form\b[^>]*>/);
    expect(form).toContain('role="search"');
    expect(form).toContain('method="get"');
    expect(form).toContain('action="/hire/talent-pool"');
    const field = tagOf(html, /<input\b[^>]*name="q"[^>]*>/);
    expect(field).toContain('type="search"');
    // React writes the attribute as `maxLength` in a string render; HTML reads it in any letter case.
    expect(field.toLowerCase()).toContain('maxlength="80"');
    expect(unescape(field)).toContain('placeholder="Search by name, skill or location…"');
    expect(field).not.toMatch(DISABLED);
    expect(field).not.toContain('Coming soon');
    const id = /id="([^"]+)"/.exec(field)?.[1];
    expect(html).toContain(`<label for="${id}"`);
    expect(text(tagOf(html, new RegExp(`<label for="${id}"[^>]*>[^<]*</label>`)))).toBe('Search the talent pool');
    // 44 pixels tall.
    expect(field).toContain('h-11');
  });
  it('shows the text being searched for and Clear search as a link to the page with no query, which works with scripting off', async () => {
    mocks.pool = pool({ search: 'aina', matched: 1 });
    const searched = await screen('aina');
    expect(tagOf(searched, /<input\b[^>]*name="q"[^>]*>/)).toContain('value="aina"');
    // A real link: a button here would do nothing until scripting has run.
    expect(clearLinks(searched)).toHaveLength(1);
    const clear = clearLinks(searched)[0];
    expect(clear).toContain('href="/hire/talent-pool"');
    expect(clear).not.toContain('?');
    expect(clear).toContain('min-h-11');
    expect(clear).toContain('min-w-11');
    expect(clear).toMatch(/focus-visible:ring-/);
    expect(buttons(searched)).not.toContain('Clear search');
    // The model is what says what was searched for: one with no search draws no such control.
    mocks.pool = pool();
    expect(clearLinks(await screen())).toEqual([]);
  });
  it('is there for a viewer too: it changes nothing', async () => {
    mocks.viewer = { orgId: 'org1', role: 'viewer', isDemo: false };
    expect(await screen()).toContain('role="search"');
  });
  it('leaves the role select, Filter and All sources disabled and marked Coming soon', async () => {
    const html = await screen();
    expect(html.match(/title="Coming soon"/g)).toHaveLength(3);
    for (const label of ['Filter', 'All sources']) {
      expect(tagOf(html, new RegExp(`<button\\b[^>]*>(?:(?!</button>)[\\s\\S])*${label}`)), label).toMatch(DISABLED);
    }
    // The box on its own: a field, no button, and the Clear search link only while there is a search.
    expect(buttons(renderToStaticMarkup(<PoolSearch search={null} />))).toEqual([]);
    expect(clearLinks(renderToStaticMarkup(<PoolSearch search={null} />))).toEqual([]);
    expect(buttons(renderToStaticMarkup(<PoolSearch search="aina" />))).toEqual([]);
    expect(clearLinks(renderToStaticMarkup(<PoolSearch search="aina" />))).toHaveLength(1);
  });
});

describe('the line under the table', () => {
  const line = (html: string) => unescape(text(/<p\b[^>]*aria-live="polite"[^>]*data-pool-footer=""[^>]*>([\s\S]*?)<\/p>/.exec(html)?.[1] ?? 'no footer'));
  it('is one polite live region, always in the page', async () => {
    expect((await screen()).match(/data-pool-footer=""/g)).toHaveLength(1);
    mocks.pool = pool({ search: 'nobody', matched: 0, rows: [] });
    expect((await screen('nobody')).match(/data-pool-footer=""/g)).toHaveLength(1);
    expect(renderToStaticMarkup(<PoolFooter line="x" />)).toContain('aria-live="polite"');
  });
  it('counts what is drawn with no search, and points at the search when the pool is larger than the table', async () => {
    mocks.pool = pool({ size: 37, matched: 37, rows: Array.from({ length: 37 }, (_, i) => row({ id: `c${i}` })) });
    expect(line(await screen())).toBe('Showing 37 candidates');
    mocks.pool = pool({ size: 137, matched: 137, rows: Array.from({ length: 50 }, (_, i) => row({ id: `c${i}` })) });
    expect(line(await screen())).toBe('Showing the newest 50 of 137. Search to find anyone else.');
  });
  it('counts the matches with a search', async () => {
    mocks.pool = pool({ size: 137, search: 'aina', matched: 1 });
    expect(line(await screen('aina'))).toBe('1 person matches “aina”.');
    mocks.pool = pool({ size: 137, search: 'aina', matched: 7, rows: Array.from({ length: 7 }, (_, i) => row({ id: `c${i}` })) });
    expect(line(await screen('aina'))).toBe('7 people match “aina”.');
    mocks.pool = pool({ size: 300, search: 'a', matched: 212, rows: Array.from({ length: 50 }, (_, i) => row({ id: `c${i}` })) });
    expect(line(await screen('a'))).toBe('Showing the newest 50 of 212 people who match “a”. Type more to narrow it down.');
  });
  it('replaces the table with one sentence when nobody matches, and still shows the tiles and the search box', async () => {
    mocks.pool = pool({ size: 137, search: 'nobody', matched: 0, rows: [] });
    const html = await screen('nobody');
    expect(line(html)).toBe('No one in the talent pool matches “nobody”.');
    expect(html).not.toContain('<table');
    expect(text(html)).toContain('Talent pool size');
    expect(text(html)).toMatch(/\b137\b/);
    expect(clearLinks(html)).toHaveLength(1);
    expect(text(html)).not.toContain('No one in the talent pool yet');
  });
  it('an empty pool says so, with or without a search', async () => {
    mocks.pool = pool({ isEmpty: true, size: 0, rows: [], matched: 0 });
    expect(text(await screen())).toContain('No one in the talent pool yet');
  });
});

describe('the read limit', () => {
  it('is said above the table only when the read came back full', async () => {
    const CAP = 'Only the newest 1,000 people on file are read, so someone added long ago may be missing from this list and from search.';
    expect(text(await screen())).not.toContain(CAP);
    mocks.pool = pool({ readCapped: true });
    const html = await screen();
    expect(text(html)).toContain(CAP);
    expect(html.indexOf('Only the newest 1,000')).toBeLessThan(html.indexOf('<table'));
  });
});

describe('the header button and the table\'s subtitle', () => {
  it('Add to Pool is a real button for someone who may edit, and nowhere for a viewer or the demo workspace', async () => {
    const html = await screen();
    expect(buttons(html)).toContain('Add to Pool');
    const add = tagOf(html, /<button\b[^>]*>(?:(?!<\/button>)[\s\S])*Add to Pool/);
    expect(add).not.toMatch(DISABLED);
    expect(add).not.toContain('Coming soon');
    expect(add).toContain('min-h-11');
    for (const viewer of [{ orgId: 'org1', role: 'viewer', isDemo: false }, { orgId: 'org1', role: 'owner', isDemo: true }]) {
      mocks.viewer = viewer;
      expect(buttons(await screen())).not.toContain('Add to Pool');
    }
    expect(buttons(renderToStaticMarkup(<AddToPool />))).toEqual(['Add to Pool']);
  });
  it('says the order truthfully', async () => {
    const said = text(await screen());
    expect(said).toContain('Newest on file first');
    expect(said).not.toContain('Most recently added first');
  });
});

describe('a pool row', () => {
  const controls = (over: { poolStatus?: 'available' | 'passive' | 're_engaged'; label?: string } = {}) =>
    renderToStaticMarkup(
      <PoolRowControls
        candidate={{ id: CANDIDATE, name: 'Aina binti Salleh', poolStatus: over.poolStatus ?? 'passive', label: over.label ?? 'Passive' }}
        jobs={pool().jobs}
      />,
    );
  const radios = (html: string) =>
    [...html.matchAll(/<div role="menuitemradio" data-value="([^"]*)">([\s\S]*?)<\/div>/g)].map(([, value, inner]) => ({ value, said: text(inner) }));
  const items = (html: string) =>
    [...html.matchAll(/<div role="menuitem" data-variant="([^"]*)">([\s\S]*?)<\/div>/g)].map(([, variant, inner]) => ({ variant, label: text(inner) }));

  it('has two controls: Move to pipeline, now real, and a menu named after the person', () => {
    const html = controls();
    expect(buttons(html)).toEqual(['Move to pipeline', 'Actions for Aina binti Salleh']);
    for (const name of ['Move to pipeline', 'Actions for Aina binti Salleh']) {
      const tag = name.startsWith('Actions')
        ? tagOf(html, /<button\b[^>]*aria-label="Actions for Aina binti Salleh"[^>]*>/)
        : tagOf(html, /<button\b[^>]*>(?=Move to pipeline)/);
      expect(tag, name).toContain('min-h-11');
      expect(tag, name).not.toMatch(DISABLED);
      expect(tag, name).not.toContain('Coming soon');
    }
  });
  it('the menu holds, in order: the three statuses each with its meaning, Remove from pool, and last the deletion', () => {
    const html = controls();
    expect(text(/<p data-menu-label="">([\s\S]*?)<\/p>/.exec(html)?.[1] ?? '')).toBe('Pool status');
    expect(radios(html)).toEqual([
      { value: 'available', said: 'Available Open to hearing about a role now.' },
      { value: 'passive', said: 'Passive Not looking right now. Worth keeping in touch for later.' },
      { value: 're_engaged', said: 'Re-engaged You have been back in touch and put them forward for a job again.' },
    ]);
    expect(items(html)).toEqual([
      { variant: 'default', label: 'Remove from pool' },
      { variant: 'destructive', label: 'Delete candidate' },
    ]);
    // Each of the two under a rule of its own, and the deletion after everything else.
    expect(html.match(/<hr\/>/g)).toHaveLength(2);
    expect(html.lastIndexOf('<hr/>')).toBeLessThan(html.indexOf('Delete candidate'));
    expect(html.indexOf('Remove from pool')).toBeLessThan(html.lastIndexOf('<hr/>'));
  });
  it('checks the stored status, also on a row whose label is Shortlisted, and says there why the label differs', () => {
    expect(controls({ poolStatus: 'passive' })).toContain('data-checked="passive"');
    const shortlisted = controls({ poolStatus: 're_engaged', label: 'Shortlisted' });
    expect(shortlisted).toContain('data-checked="re_engaged"');
    expect(text(shortlisted)).toContain('Shown as Shortlisted while they have a live application at Interview or beyond.');
    expect(text(controls())).not.toContain('Shown as Shortlisted');
  });
  it('is on the screen for someone who may edit, with the line that says what a change did', async () => {
    const html = await screen();
    expect(buttons(html)).toEqual(expect.arrayContaining(['Move to pipeline', 'Actions for Aina binti Salleh']));
    expect(html).toContain(`id="${DELETION_NOTICE_ID}"`);
  });
  it('a viewer and the demo workspace see the row and an empty Action cell', async () => {
    for (const viewer of [{ orgId: 'org1', role: 'viewer', isDemo: false }, { orgId: 'org1', role: 'owner', isDemo: true }]) {
      mocks.viewer = viewer;
      const html = await screen();
      expect(text(html)).toContain('Aina binti Salleh');
      expect(buttons(html)).not.toContain('Move to pipeline');
      expect(buttons(html).filter((name) => name.startsWith('Actions for'))).toEqual([]);
      expect(html).not.toMatch(/Remove from pool|Delete candidate|Pool status/);
      expect(html).not.toContain(DELETION_NOTICE_ID);
    }
  });
  it('sends nothing to the server just by being drawn, and carries no contact detail and nothing purple or violet', async () => {
    const html = (await screen()) + controls();
    expect(mocks.action).not.toHaveBeenCalled();
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(html).not.toMatch(/cv_path|[\w.]+@[\w-]+\.\w+|\+?60\d{8,}/);
    expect(html).not.toMatch(/purple|violet/i);
  });
});

describe('the pool on the board card and in the Applications panel', () => {
  const subject = (over: Partial<ApplicationSubject> = {}): ApplicationSubject => ({
    id: '44444444-4444-4444-8444-444444444444', candidateId: CANDIDATE, name: 'Aina Rahman', job: 'Barista',
    stage: 'interview', outcome: 'active', rating: null, rejectReason: null, ...over,
  });
  const items = (html: string) =>
    [...html.matchAll(/<div role="menuitem" data-variant="([^"]*)">([\s\S]*?)<\/div>/g)].map(([, , inner]) => text(inner));

  it('the card menu offers Add to talent pool straight after Edit candidate, for someone not in the pool', () => {
    for (const poolStatus of ['none', undefined] as const) {
      const all = items(renderToStaticMarkup(<ApplicationMenu application={subject({ poolStatus })} canEdit />));
      expect(all[all.indexOf('Edit candidate') + 1]).toBe('Add to talent pool');
      // 3c's two deletions stay last.
      expect(all.slice(-2)).toEqual(['Delete application', 'Delete candidate']);
    }
  });
  it('the card menu says where a pool member stands instead, and offers no add', () => {
    const html = renderToStaticMarkup(<ApplicationMenu application={subject({ poolStatus: 'passive' })} canEdit />);
    expect(items(html)).not.toContain('Add to talent pool');
    expect(text(html)).toContain('In the talent pool: Passive');
    expect(html.indexOf('Edit candidate')).toBeLessThan(html.indexOf('In the talent pool: Passive'));
    expect(html.indexOf('In the talent pool: Passive')).toBeLessThan(html.indexOf('Delete application'));
  });
  it('the panel has the button beside Edit candidate, or the same line', () => {
    const outside = renderToStaticMarkup(<ApplicationActions application={subject({ poolStatus: 'none' })} canEdit />);
    const names = buttons(outside);
    expect(names[names.indexOf('Edit candidate') + 1]).toBe('Add to talent pool');
    expect(tagOf(outside, /<button\b[^>]*>(?=Add to talent pool)/)).toContain('min-h-11');
    const inside = renderToStaticMarkup(<ApplicationActions application={subject({ poolStatus: 're_engaged' })} canEdit />);
    expect(buttons(inside)).not.toContain('Add to talent pool');
    expect(text(inside)).toContain('In the talent pool: Re-engaged');
  });
  it('is nowhere for someone who may not edit', () => {
    expect(renderToStaticMarkup(<ApplicationMenu application={subject()} canEdit={false} />)).toBe('');
    expect(renderToStaticMarkup(<ApplicationActions application={subject()} canEdit={false} />)).toBe('');
  });
});

describe('the generated page', () => {
  it('hands the address\'s parameters to the screen', () => {
    const page = readFileSync(join(process.cwd(), 'src/app/(app)/hire/talent-pool/page.tsx'), 'utf8');
    expect(page).toContain('searchParams: Promise<Record<string, string | string[] | undefined>>');
    expect(page).toContain('<Screen searchParams={searchParams} />');
    expect(readFileSync(join(process.cwd(), 'scripts/gen-screen-routes.mjs'), 'utf8')).toContain('\'hire/talent-pool\'');
  });
});
