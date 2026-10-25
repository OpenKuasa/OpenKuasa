import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * Jebat → Ad Settings: nothing acts on the saved caps, currency, automation or notification choices yet, so each
 * card says so. The saved values still show and can still be changed and saved.
 */

vi.mock('@/app/(app)/reach/actions', () => ({ updateAdSettingsAction: vi.fn() }));

import { AdSettingsForm } from '@/components/reach/ad-settings-form';

const settings = {
  daily_cap_cents: 5000,
  monthly_cap_cents: null,
  currency: 'SGD',
  automation: { auto_pause_low_ctr: true, auto_boost_winners: false, daily_budget_guard: true },
  notifications: { spend_alerts: true, weekly_summary: false },
  updated_at: '2026-10-01T00:00:00Z',
};

const screen = (canEdit = true) => renderToStaticMarkup(<AdSettingsForm settings={settings} canEdit={canEdit} />);
const count = (html: string, text: string) => html.split(text).length - 1;

describe('the Jebat ad settings cards', () => {
  it('drops the promises nothing keeps', () => {
    const html = screen();
    expect(html).not.toContain('Let Jebat optimise while you sleep');
    expect(html).not.toContain('Stay in the loop on spend &amp; performance');
    expect(html).not.toContain('Caps apply across all active campaigns');
  });

  it('marks budget, automation and notifications as coming soon', () => {
    const html = screen();
    expect(count(html, '>Coming soon<')).toBe(3);
    expect(html).toContain('Saved for later. The caps don&#x27;t stop any spend yet.');
    expect(html).toContain('Saved for later. Amounts still show in RM.');
    expect(count(html, 'Saved for later. Nothing acts on these yet.')).toBe(2);
  });

  it('keeps the saved choices showing and changeable', () => {
    const html = screen();
    expect(html).toMatch(/id="setting-auto_pause_low_ctr"[^>]*aria-checked="true"|aria-checked="true"[^>]*id="setting-auto_pause_low_ctr"/);
    expect(html).toMatch(/id="setting-spend_alerts"[^>]*aria-checked="true"|aria-checked="true"[^>]*id="setting-spend_alerts"/);
    expect(html).toContain('value="50"');
    expect(html).not.toMatch(/id="setting-auto_pause_low_ctr"[^>]*disabled=""/);
    expect(count(html, '>Save</button>')).toBe(3);
  });
});
