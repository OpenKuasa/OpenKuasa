import { renderToStaticMarkup } from 'react-dom/server';
import { Plus } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import {
  EmployeeCell,
  HrOnlyScreen,
  LATER_NOTE,
  LaterButton,
  NotLinkedCard,
  StatusPill,
  requestTone,
} from '@/screens/people/parts';

describe('LaterButton', () => {
  const DISABLED = /<button[^>]*\sdisabled(=""|\s|>)/;

  it('is a real disabled button that says why, where it can be seen', () => {
    const html = renderToStaticMarkup(<LaterButton icon={Plus}>New request</LaterButton>);
    expect(html).toMatch(DISABLED);
    expect(html).not.toContain('sr-only');
    expect(html).toContain('type="button"');
    expect(html).toContain('New request');
    expect(html).toContain(LATER_NOTE);
    expect(html).toContain(`title="${LATER_NOTE}"`);
  });

  it('in compact form keeps the note for screen readers only', () => {
    const html = renderToStaticMarkup(<LaterButton compact>Approve</LaterButton>);
    expect(html).toMatch(DISABLED);
    expect(html).toContain(`<span class="sr-only">${LATER_NOTE}</span>`);
    expect(html).toContain(`title="${LATER_NOTE}"`);
    expect(html).toContain('whitespace-nowrap');
  });

  it('has the agreed note', () => {
    expect(LATER_NOTE).toBe('Available in a later update');
  });
});

describe('requestTone', () => {
  it('maps the four statuses', () => {
    expect(requestTone('approved')).toBe('good');
    expect(requestTone('paid')).toBe('good');
    expect(requestTone('pending')).toBe('pending');
    expect(requestTone('rejected')).toBe('bad');
    expect(requestTone('cancelled')).toBe('neutral');
  });
});

describe('StatusPill and EmployeeCell', () => {
  it('colours the pill by tone', () => {
    expect(renderToStaticMarkup(<StatusPill tone="good">Approved</StatusPill>)).toContain('text-emerald-600');
    expect(renderToStaticMarkup(<StatusPill tone="pending">Pending</StatusPill>)).toContain('text-amber-600');
    expect(renderToStaticMarkup(<StatusPill tone="bad">Rejected</StatusPill>)).toContain('text-red-600');
    expect(renderToStaticMarkup(<StatusPill tone="neutral">Cancelled</StatusPill>)).toContain('text-muted-foreground');
  });

  it('shows initials, the name and an optional second line', () => {
    const html = renderToStaticMarkup(<EmployeeCell name="Aisyah Rahim" sub="Sales" />);
    expect(html).toContain('>AR<');
    expect(html).toContain('Aisyah Rahim');
    expect(html).toContain('Sales');
    expect(renderToStaticMarkup(<EmployeeCell name="Siti" />)).toContain('>S<');
    expect(renderToStaticMarkup(<EmployeeCell name="" />)).toContain('>?<');
  });
});

describe('NotLinkedCard and HrOnlyScreen', () => {
  it('keeps the Overview wording for an unlinked account', () => {
    const html = renderToStaticMarkup(<NotLinkedCard />);
    expect(html).toContain('Your HR record isn&#x27;t linked yet');
    expect(html).toContain('Ask an owner or admin of this workspace');
  });

  it('shows the title and the notice, nothing else', () => {
    const html = renderToStaticMarkup(<HrOnlyScreen title="Payroll" />);
    expect(html).toContain('Payroll');
    expect(html).toContain('This page is for owners and admins of the workspace.');
  });
});
