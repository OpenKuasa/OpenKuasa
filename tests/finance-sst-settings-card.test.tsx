import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SstSettingsCard } from '@/components/finance/sst-settings-card';
import type { SstSettings } from '@/lib/finance/sst';

/**
 * The SST settings card (#222 stage 1): the taxable period, the two registration numbers and the service tax
 * basis. Read only without `save` (a member, a viewer, the demo); a form with it (an owner or admin).
 */
const textOf = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

const SAVED: SstSettings = { period_start_month: 9, service_tax_no: 'W10-1', sales_tax_no: null, service_tax_basis: 'payment' };
const save = vi.fn(async () => ({ ok: true as const, data: null }));

describe('the SST settings card', () => {
  it('asks for the taxable period while nothing is saved, and offers no Save without the action', () => {
    const html = renderToStaticMarkup(<SstSettingsCard settings={null} suggestedNumber={null} today="2026-10-21" />);
    expect(textOf(html)).toContain('Set your taxable period to see your returns.');
    expect(html).not.toMatch(/>\s*Save/);
  });

  it('shows the current period, the numbers and the basis', () => {
    const text = textOf(renderToStaticMarkup(<SstSettingsCard settings={SAVED} suggestedNumber={null} today="2026-10-21" />));
    expect(text).toContain('1 Sep – 31 Oct 2026');
    expect(text).toContain('W10-1');
    expect(text).toContain('Not registered');
    expect(text).toContain('Payment received');
    expect(text).not.toContain('Set your taxable period');
  });

  it('suggests the company SST no. when both numbers are empty, with buttons only for someone who may save', () => {
    const html = renderToStaticMarkup(<SstSettingsCard settings={null} suggestedNumber="X1" today="2026-10-21" save={save} />);
    const text = textOf(html);
    expect(text).toContain('Your company details have SST no. X1.');
    expect(text).toContain('Use for service tax');
    expect(text).toContain('Use for sales tax');

    const member = textOf(renderToStaticMarkup(<SstSettingsCard settings={null} suggestedNumber="X1" today="2026-10-21" />));
    expect(member).not.toContain('Use for service tax');
    // Once a number is saved there is nothing to suggest.
    const saved = textOf(renderToStaticMarkup(<SstSettingsCard settings={SAVED} suggestedNumber="X1" today="2026-10-21" save={save} />));
    expect(saved).not.toContain('Your company details have SST no.');
  });

  it('gives a member no control to change anything', () => {
    for (const settings of [null, SAVED]) {
      const html = renderToStaticMarkup(<SstSettingsCard settings={settings} suggestedNumber="X1" today="2026-10-21" />);
      // Read only is shown as text: no input, select or button at all, so none can be enabled.
      const enabled = (html.match(/<(input|select|textarea|button)\b[^>]*>/g) ?? []).filter((c) => !/\sdisabled\b/.test(c));
      expect(enabled).toEqual([]);
    }
  });

  it('gives an owner or admin the form: the twelve two-month pairs, both numbers, both bases and Save', () => {
    const html = renderToStaticMarkup(<SstSettingsCard settings={SAVED} suggestedNumber={null} today="2026-10-21" save={save} />);
    const text = textOf(html);
    for (const pair of ['Jan – Feb', 'Feb – Mar', 'Jun – Jul', 'Nov – Dec', 'Dec – Jan']) expect(text).toContain(pair);
    expect(html.match(/<option value="\d+"/g)).toHaveLength(12);
    expect(text).toContain('Payment received');
    expect(text).toContain('Invoice issued (approved by Customs)');
    expect(html).toContain('value="W10-1"');
    expect(text).toMatch(/Save/);
    expect(text).toContain('1 Sep – 31 Oct 2026');
  });

  it('keeps the words of GST and LHDN out of the form, as the screen does', () => {
    const html = renderToStaticMarkup(<SstSettingsCard settings={null} suggestedNumber="X1" today="2026-10-21" save={save} />);
    const text = textOf(html);
    for (const wrong of [/input/i, /net payable/i, /LHDN/, /file return/i, /collected/i]) expect(text, String(wrong)).not.toMatch(wrong);
  });
});
