import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { LeadFormCard, SubmissionConsent } from '@/components/reach/lead-forms-view';
import { PublicLeadForm } from '@/components/reach/public-lead-form';
import { DEFAULT_FORM_CONSENT, FORM_CONSENT_MAX } from '@/lib/reach/forms';
import { CONSENT_FIELD, submissionOutcome } from '@/lib/reach/form-submissions';
import type { Form } from '@/lib/reach/types';

/**
 * PDPA consent on lead forms (issue #230): the box on the public form, the
 * sentence in the form editor, and the consent shown with each submission.
 *
 * There is no DOM here (node, no testing library), so the forms are rendered to
 * markup and read. That the browser stops an unticked send before it is posted
 * needs a browser; the server action refusing it is in reach-public-forms.test.ts.
 */

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20261124130000_kasturi_form_consent.sql'),
  'utf8',
);

const SENTENCE = 'I agree that Kedai Sdn Bhd may keep these details and contact me about my enquiry.';

describe('the migration and the app agree', () => {
  it('uses the same default sentence and the same limit', () => {
    expect(migration).toContain(`default '${DEFAULT_FORM_CONSENT}'`);
    expect(migration).toContain(`between 1 and ${FORM_CONSENT_MAX}`);
  });

  it('answers an unticked box with the word the app reads as a problem beside the box', () => {
    expect(migration).toContain("then return 'consent_required'");
    expect(submissionOutcome('consent_required')).toEqual({
      kind: 'invalid',
      errors: { consent: 'Please tick the box to agree before sending.' },
    });
  });

  it('says it must be applied right before the release, not ahead of it', () => {
    expect(migration).toMatch(/IMMEDIATELY BEFORE the app release/);
  });
});

describe('the public form', () => {
  const html = renderToStaticMarkup(
    <PublicLeadForm action={vi.fn()} consentText={SENTENCE} submitLabel="Send" />,
  );

  it('shows the sentence beside a required box', () => {
    expect(html).toContain(SENTENCE);
    const box = html.match(/<input[^>]*type="checkbox"[^>]*>/)?.[0] ?? '';
    expect(box).toContain(`name="${CONSENT_FIELD}"`);
    expect(box).toContain('required');
    // Not ticked to begin with.
    expect(box).not.toContain('checked');
  });

  it('puts the box and its sentence in one label, so either can be clicked', () => {
    const label = html.match(/<label[^>]*>(?:(?!<\/label>)[\s\S])*type="checkbox"(?:(?!<\/label>)[\s\S])*<\/label>/)?.[0] ?? '';
    expect(label).toContain(SENTENCE);
  });

  it('keeps the box before the button', () => {
    expect(html.indexOf('type="checkbox"')).toBeLessThan(html.indexOf('type="submit"'));
  });
});

describe('the form editor', () => {
  const form: Form = {
    id: 'f1',
    name: 'Raya Promo',
    category: null,
    slug: 'raya-promo',
    channel: null,
    status: 'active',
    consent_text: '{workspace} may WhatsApp me about Raya offers.',
    views_count: 0,
    submissions_count: 0,
    created_at: '2026-10-10T00:00:00Z',
    updated_at: '2026-10-10T00:00:00Z',
  };
  const card = (editing: Form | null) =>
    renderToStaticMarkup(
      <LeadFormCard
        editing={editing}
        suggestions={[]}
        nameRef={createRef()}
        save={vi.fn()}
        onClose={vi.fn()}
      />,
    );
  const textarea = (html: string) =>
    html.match(/<textarea[^>]*name="consent_text"[^>]*>([^<]*)<\/textarea>/)?.[1];

  it('starts a new form with the default sentence filled in', () => {
    const html = card(null);
    expect(textarea(html)).toBe(DEFAULT_FORM_CONSENT);
    expect(html).toContain('Consent sentence');
    expect(html).toContain('{workspace} becomes your');
  });

  it('shows a form\'s own sentence when it is edited', () => {
    expect(textarea(card(form))).toBe(form.consent_text);
  });
});

describe('a submission, as the workspace sees it', () => {
  it('says when the visitor agreed, and to what', () => {
    const html = renderToStaticMarkup(
      <dl>
        <SubmissionConsent
          submission={{ consent_text: SENTENCE, consented_at: '2026-10-10T06:05:00Z' }}
        />
      </dl>,
    );
    // Malaysian time: 14:05 on 10 Oct.
    expect(html).toContain('Consented 10 Oct 2026, 14:05');
    expect(html).toContain(SENTENCE);
  });

  it('says so for a submission from before consent was asked for', () => {
    const html = renderToStaticMarkup(
      <dl>
        <SubmissionConsent submission={{ consent_text: null, consented_at: null }} />
      </dl>,
    );
    expect(html).toContain('Not recorded (sent before consent was asked for)');
    expect(html).not.toContain('Consented ');
  });
});
