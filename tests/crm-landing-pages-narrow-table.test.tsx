import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import type { LandingPage } from '@/lib/crm/landing-pages';
import { LandingPagesView } from '@/screens/crm/landing-pages-view';

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
