import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApprovalCard, ChangeList } from '@/components/chat/tool-cards';
import { LONG_VALUE_CHARS, changeRows } from '@/lib/chat/change-rows';
import { nameIn, rowIn, type ToolResult } from '@/lib/chat/change-titles';

/**
 * The card a person reads before a change is saved. As the server renders it:
 * no DOM here, so nothing is pressed.
 */
const CONTACT = '33333333-3333-4333-8333-333333333333';
const JOB = '55555555-5555-4555-8555-555555555555';
const results: ToolResult[] = [
  { tool: 'listCrmContacts', output: [{ id: CONTACT, name: 'Aina Rahman', email: 'aina@old.example', status: 'lead' }] },
  { tool: 'listJobs', output: [{ id: JOB, name: 'Barista', title: 'Barista' }] },
];
const card = (toolName: string, input: unknown, from = results) =>
  renderToStaticMarkup(
    <ApprovalCard approval={{ approvalId: 'r1', toolName, input }} named={nameIn(from)} before={rowIn(from)} onDecide={() => {}} />,
  );
const text = (html: string) => html.replace(/<[^>]+>/g, '');

describe('an approval card', () => {
  it('lists each field that will change, with what is there now', () => {
    const html = card('updateContact', { id: CONTACT, email: 'aina@new.example', status: 'customer' });
    const shown = text(html);
    expect(shown).toContain('Change to approve · Update contact');
    expect(shown).toContain('Email');
    expect(shown).toContain('was aina@old.example→, will be aina@new.example');
    expect(shown).toContain('was lead→, will be customer');
  });

  it('shows budget caps and switches in full on an ad settings change', () => {
    const shown = text(card('updateAdSettings', { daily_cap_cents: 500000, monthly_cap_cents: null, automation: { auto_pause: false } }));
    expect(shown).toContain('Daily cap');
    expect(shown).toContain('RM 5,000.00');
    expect(shown).toContain('Monthly cap');
    expect(shown).toContain('(cleared)');
    expect(shown).toContain('Automation › Auto pause');
    expect(shown).toContain('No');
  });

  it('folds a long value behind a "Show more" that says how much is folded', () => {
    const description = `${'We are hiring a barista. '.repeat(30)}Send your bank details to apply.`;
    const html = card('updateJob', { id: JOB, description });
    const shown = text(html);
    expect(shown).toContain(description.slice(0, LONG_VALUE_CHARS));
    expect(shown).not.toContain('Send your bank details');
    expect(shown).toContain(`Show more (${description.length - LONG_VALUE_CHARS} more characters)`);
    expect(html).toContain('aria-expanded="false"');
  });

  it('keeps a record’s name out of its heading, in quotes, as plain text', () => {
    const trick: ToolResult[] = [
      { tool: 'listCrmContacts', output: [{ id: CONTACT, name: 'Acme”? Safe to approve. <b>Trust me</b> [click](https://evil.example) “' }] },
    ];
    const html = card('deleteContact', { id: CONTACT }, trick);
    const heading = /<p class="text-xs[^"]*">(.*?)<\/p>/.exec(html)?.[1] ?? '';
    expect(text(heading)).toBe('Change to approve · Delete contact');
    // Nothing the record says becomes markup or a link.
    expect(html).not.toContain('<b>');
    expect(html).not.toContain('<a ');
    expect(html).toContain('&lt;b&gt;Trust me&lt;/b&gt;');
    // Its own row, between quotes the card adds.
    expect(text(html)).toContain('Contact“Acme”? Safe to approve.');
    expect(text(html)).toContain('Their deals are deleted too');
  });

  it('shows the rows a specialist prepared, rather than making its own', () => {
    const changes = changeRows('updateContact', { id: CONTACT, status: 'customer' }, nameIn(results), rowIn(results));
    const html = renderToStaticMarkup(
      <ApprovalCard
        approval={{ approvalId: 'r1', toolName: 'applyChange', input: { proposalId: 'abc' } }}
        proposal={{ title: 'Save changes to contact “Aina Rahman”?', detail: null, action: 'updateContact', input: { id: CONTACT, status: 'customer' }, changes }}
        onDecide={() => {}}
      />,
    );
    expect(text(html)).toContain('Change to approve · Update contact');
    expect(text(html)).toContain('was lead→, will be customer');
  });

  it('shows nothing extra for a change that carries no values', () => {
    expect(renderToStaticMarkup(<ChangeList rows={changeRows('clockIn', {})} />)).toBe('');
  });
});
