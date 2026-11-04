import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import type { LandingPage } from '@/lib/crm/landing-pages';
import { LandingPagesView } from '@/screens/crm/landing-pages-view';
import type { Broadcast } from '@/lib/crm/broadcasts';
import { BroadcastsView } from '@/screens/crm/broadcasts-view';

const page: LandingPage = {
  id: 'p1',
  name: 'Smoke test page',
  headline: 'Smoke test page',
  subheadline: '',
  body: '',
  buttonLabel: '',
  formId: 'f1',
  formName: 'Free Quote Request',
  status: 'published',
  live: true,
  views: 4,
  leads: 1,
  chatEnabled: false,
  path: '/p/p1',
};

const noop = async () => undefined;

/** The class lists of the cells (th or td) whose text is exactly `text`. */
function cellClasses(html: string, tag: 'th' | 'td', text: string): string[][] {
  return [...html.matchAll(new RegExp(`<${tag}[^>]*class="([^"]*)"[^>]*>${text}</${tag}>`, 'g'))].map((m) => m[1].split(/\s+/));
}

describe('the landing pages table on a narrow screen', () => {
  // The Actions column is pinned to the right edge, so in a narrow card it sat on
  // top of Status. Conversion is the column to give up: the Conversion card above
  // the table shows the same figure.
  it('drops the Conversion column, heading and cells, when the table is narrow', () => {
    const html = renderToStaticMarkup(
      <LandingPagesView pages={[page]} forms={[]} actions={{ save: noop, remove: noop }} />,
    );
    const heading = cellClasses(html, 'th', 'Conversion');
    const cell = cellClasses(html, 'td', '25%');
    expect(heading).toHaveLength(1);
    expect(cell).toHaveLength(1);
    expect(heading[0]).toContain('@max-3xl:hidden');
    expect(cell[0]).toContain('@max-3xl:hidden');
  });

  it('keeps Status and the other columns at every width', () => {
    const html = renderToStaticMarkup(<LandingPagesView pages={[page]} forms={[]} />);
    for (const name of ['Page', 'Lead form', 'Views', 'Leads', 'Status']) {
      const heading = cellClasses(html, 'th', name);
      expect(heading, name).toHaveLength(1);
      expect(heading[0].some((c) => c.endsWith(':hidden')), name).toBe(false);
    }
  });
});

const broadcast: Broadcast = {
  id: 'b1',
  name: 'Raya promo',
  subject: 'Raya deals',
  body: 'Hello',
  audience: { statuses: [], tags: ['vip'] },
  status: 'draft',
  revision: 1,
  updatedDay: '2026-11-03',
  sentDay: null,
  sentCount: 0,
  failedCount: 0,
  sendingStartedAt: null,
  resumedAt: null,
};

describe('the broadcasts table on a narrow screen', () => {
  const html = renderToStaticMarkup(
    <BroadcastsView
      broadcasts={[broadcast]}
      contacts={[
        { id: 'c1', name: 'Aina', email: 'aina@example.com', company: '', status: 'lead', tags: ['vip'] },
        { id: 'c2', name: 'Lim', email: 'lim@example.com', company: '', status: 'lead', tags: ['vip'] },
      ]}
      contactsComplete
      optOuts={[]}
      emailKey={null}
      testAddress={null}
    />,
  );

  // Five buttons on a draft left Status wholly under the pinned Actions at a
  // 1080px window, more than any one column gives back.
  it('drops the Recipients column when the table is narrow', () => {
    const heading = cellClasses(html, 'th', 'Recipients');
    expect(heading).toHaveLength(1);
    expect(heading[0]).toContain('@max-3xl:hidden');
  });

  it('shows the count under the audience instead, and lets the audience wrap', () => {
    const audience = html.match(/<td[^>]*class="([^"]*)"><p class="([^"]*)">All contacts[^<]*<\/p><p class="([^"]*)">2 recipients<\/p><\/td>/);
    expect(audience).not.toBeNull();
    expect(audience![1].split(' ')).toContain('@max-3xl:max-w-40');
    expect(audience![2].split(' ')).toContain('@max-3xl:whitespace-normal');
    expect(audience![3].split(' ')).toEqual(expect.arrayContaining(['hidden', '@max-3xl:block']));
  });

  it('keeps Status at every width', () => {
    const heading = cellClasses(html, 'th', 'Status');
    expect(heading).toHaveLength(1);
    expect(heading[0].some((c) => c.endsWith(':hidden'))).toBe(false);
  });
});
