import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ApplicationFormValues } from '@/lib/hire/application-form';
import {
  APPLY_HONEYPOT, APPLY_MESSAGES, EMPTY_APPLY_VALUES, isRequired, shownFields, type ApplyField,
} from '@/lib/hire/application-fields';
import type { ApplyState } from '@/app/careers/[orgId]/[jobId]/actions';

/**
 * The apply form as the server sends it, before any script has run: this is
 * all a visitor without JavaScript ever gets. Rendered to a string and read as
 * markup. What the form does on blur and on submit needs a browser.
 */

const mocks = vi.hoisted(() => ({
  /** What the action last answered, as `useActionState` would hand it to the form. */
  answer: { state: undefined as unknown, pending: false, real: false },
}));

// The real hook renders its initial state here. Replaced so a test can also
// render the form as it is after the server has answered a post.
vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>();
  return {
    ...react,
    useActionState: (action: never, initial: never) =>
      mocks.answer.real ? react.useActionState(action, initial) : [mocks.answer.state, action, mocks.answer.pending],
  };
});

// The real hook needs the app's router around it. Nothing here runs a handler, so nothing refreshes.
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));

import { ApplyForm } from '@/app/careers/[orgId]/[jobId]/apply-form';

const FORMS: Record<string, ApplicationFormValues> = {
  'all off': { require_cv: false, require_cover_letter: false, ask_portfolio: false, ask_expected_salary: false },
  'all on': { require_cv: true, require_cover_letter: true, ask_portfolio: true, ask_expected_salary: true },
  'CV only': { require_cv: true, require_cover_letter: false, ask_portfolio: false, ask_expected_salary: false },
  'portfolio and salary': { require_cv: false, require_cover_letter: false, ask_portfolio: true, ask_expected_salary: true },
};
const ALL = FORMS['all on'];
const ORG_NAME = 'Tanjung Trading';

const LABELS: Record<ApplyField, string> = {
  name: 'Full name', email: 'Email', phone: 'Phone', cv_url: 'CV link', cover_letter: 'Cover letter',
  portfolio_url: 'Portfolio link', expected_salary: 'Expected monthly salary',
  consent: "I agree that Tanjung Trading may store and use the details I've given to consider me for this role, "
    + 'and that they are processed through OpenKuasa.',
};

const action = async (): Promise<ApplyState> => undefined;
/**
 * The form's own markup. `action` here is a plain function, not a server
 * action, so React ends the markup with a script of its own that holds a
 * submit until the page is live. A server action gets hidden fields instead;
 * the script is no part of the form and is cut off.
 */
const markup = (form: ApplicationFormValues) =>
  renderToStaticMarkup(<ApplyForm action={action} form={form} orgName={ORG_NAME} />)
    .replace(/<script>addEventListener\("submit"[\s\S]*<\/script>$/, '');
const render = (form: ApplicationFormValues = ALL, state?: ApplyState, pending = false) => {
  mocks.answer.state = state;
  mocks.answer.pending = pending;
  return markup(form);
};

type Control = { tag: string; attrs: string; body: string };
/** Every input and textarea, in the order they come. */
const controls = (html: string): Control[] =>
  [...html.matchAll(/<(input|textarea)\b([^>]*)>(?:([^<]*)<\/textarea>)?/g)]
    .map((match) => ({ tag: match[1], attrs: match[2], body: match[3] ?? '' }));
const attr = (attrs: string, key: string) => new RegExp(`(?:^|\\s)${key}="([^"]*)"`).exec(attrs)?.[1];
const has = (attrs: string, key: string) => new RegExp(`(?:^|\\s)${key}(?:=|\\s|$)`).test(attrs);
const control = (html: string, name: string): Control => {
  const found = controls(html).find((item) => attr(item.attrs, 'name') === name);
  if (!found) throw new Error(`no control named ${name}`);
  return found;
};
/** Tags out and entities back, to read text as a visitor reads it. */
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const labelFor = (html: string, id: string) => new RegExp(`<label[^>]*\\sfor="${id}"[^>]*>(.*?)</label>`, 's').exec(html)?.[1];
const byId = (html: string, id: string) => new RegExp(`<(\\w+)([^>]*\\sid="${id}"[^>]*)>(.*?)</\\1>`, 's').exec(html);
const count = (html: string, pattern: RegExp) => (html.match(pattern) ?? []).length;

beforeEach(() => {
  mocks.answer.state = undefined;
  mocks.answer.pending = false;
  mocks.answer.real = false;
});

describe('the form with the real hook', () => {
  it('renders its first state on the server exactly as the stand-in hook does', () => {
    const standIn = render();
    mocks.answer.real = true;
    const real = markup(ALL);
    expect(real).toContain('Send application');
    // React writes the form's `action` itself when the hook is real; nothing else differs.
    const withoutAction = (html: string) => html.replace(/<form[^>]*>/, '<form>');
    expect(withoutAction(real)).toBe(withoutAction(standIn));
  });
});

describe.each(Object.entries(FORMS))('a form with %s', (_name, form) => {
  const html = render(form);
  const shown = shownFields(form);

  it('has exactly the fields this form shows, in order, and the honeypot', () => {
    const names = controls(html).map((item) => attr(item.attrs, 'name'));
    expect(names.filter((name) => name !== APPLY_HONEYPOT)).toEqual(shown);
    expect(names.filter((name) => name === APPLY_HONEYPOT)).toHaveLength(1);
  });

  it('ties a label to every input, the honeypot included', () => {
    const ids = controls(html).map((item) => attr(item.attrs, 'id'));
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toBeTruthy();
      expect(labelFor(html, id!)).toBeTruthy();
    }
  });

  it('words each label, and marks it required or optional as the form requires', () => {
    for (const field of shown) {
      const { attrs } = control(html, field);
      const label = labelFor(html, attr(attrs, 'id')!)!;
      expect(text(label)).toContain(LABELS[field]);
      if (isRequired(field, form)) {
        expect(label).toMatch(/<span[^>]*aria-hidden="true"[^>]*>\*<\/span>/);
        expect(label).not.toContain('(optional)');
        expect(has(attrs, 'required')).toBe(true);
        expect(attr(attrs, 'aria-required')).toBe('true');
      } else {
        expect(label).not.toContain('*');
        expect(label).toContain('(optional)');
        expect(has(attrs, 'required')).toBe(false);
        expect(has(attrs, 'aria-required')).toBe(false);
      }
    }
  });
});

describe('the form before anything is typed', () => {
  const html = render();

  it('is a plain form that posts without the browser blocking it', () => {
    expect(count(html, /<form[\s>]/g)).toBe(1);
    expect(html).toMatch(/<form[^>]*\snoValidate=""/i);
  });

  it('says "* Required" once, above the first field', () => {
    expect(count(html, /\* Required/g)).toBe(1);
    expect(html.indexOf('* Required')).toBeLessThan(html.indexOf('name="name"'));
    expect(html.indexOf('* Required')).toBeGreaterThan(html.indexOf('<form'));
  });

  it('asks for the name with the name autofill', () => {
    const { attrs } = control(html, 'name');
    expect(attr(attrs, 'autoComplete')).toBe('name');
    expect(attr(attrs, 'type') ?? 'text').toBe('text');
  });

  it('asks for the email with the email keyboard and autofill', () => {
    const { attrs } = control(html, 'email');
    expect(attr(attrs, 'type')).toBe('email');
    expect(attr(attrs, 'autoComplete')).toBe('email');
    expect(attr(attrs, 'inputMode')).toBe('email');
  });

  it('asks for the phone with the phone keyboard and autofill', () => {
    const { attrs } = control(html, 'phone');
    expect(attr(attrs, 'type')).toBe('tel');
    expect(attr(attrs, 'autoComplete')).toBe('tel');
  });

  it.each(['cv_url', 'portfolio_url'])('asks for %s with the link keyboard', (field) => {
    const { attrs } = control(html, field);
    expect(attr(attrs, 'type')).toBe('url');
    expect(attr(attrs, 'inputMode')).toBe('url');
  });

  it('explains the CV link under it, tied to the input', () => {
    const described = attr(control(html, 'cv_url').attrs, 'aria-describedby')!.split(' ');
    const helper = described.map((id) => byId(html, id)).find(Boolean);
    expect(text(helper![3])).toBe(
      'Paste a link to your CV, for example Google Drive or LinkedIn. Make sure anyone with the link can view it.',
    );
    expect(html.indexOf(helper![0])).toBeGreaterThan(html.indexOf('name="cv_url"'));
  });

  it('takes the salary as text with a number pad, between "RM" and "a month", both tied to the input', () => {
    const { attrs } = control(html, 'expected_salary');
    expect(attr(attrs, 'type')).toBe('text');
    expect(attr(attrs, 'inputMode')).toBe('decimal');
    const described = attr(attrs, 'aria-describedby')!.split(' ').map((id) => byId(html, id)!);
    expect(described.map((found) => text(found[3]))).toEqual(['RM', 'a month']);
    const at = html.indexOf('name="expected_salary"');
    expect(html.indexOf(described[0][0])).toBeLessThan(at);
    expect(html.indexOf(described[1][0])).toBeGreaterThan(at);
  });

  it('counts the cover letter under it, tied to the field and not read out on every pause', () => {
    const { tag, attrs } = control(html, 'cover_letter');
    expect(tag).toBe('textarea');
    expect(attr(attrs, 'aria-describedby')!.split(' ')).toEqual(['apply-cover_letter-count']);
    const counter = byId(html, 'apply-cover_letter-count')!;
    expect(text(counter[3])).toBe('0 / 4,000');
    expect(html.indexOf(counter[0])).toBeGreaterThan(html.indexOf('name="cover_letter"'));
    expect(html).not.toContain('aria-live');
  });

  it('makes every input and the button at least 44px tall with 16px text', () => {
    for (const { tag, attrs } of controls(html)) {
      if (attr(attrs, 'name') === APPLY_HONEYPOT || attr(attrs, 'type') === 'checkbox') continue;
      const classes = attr(attrs, 'class')!.split(' ');
      expect(classes).toContain(tag === 'textarea' ? 'min-h-32' : 'h-11');
      expect(classes).toContain('text-base');
      // Not shrunk again on a wider screen.
      expect(classes).not.toContain('md:text-sm');
    }
    const button = /<button([^>]*)>/.exec(html)![1];
    expect(attr(button, 'class')!.split(' ')).toContain('h-11');
    // The consent row: the box and its sentence are one tap area.
    expect(attr(/<label([^>]*\sfor="apply-consent"[^>]*)>/.exec(html)![1], 'class')!.split(' ')).toContain('min-h-11');
  });

  it('has an unticked native consent checkbox that posts "on", with the whole sentence as its label', () => {
    const { attrs } = control(html, 'consent');
    expect(attr(attrs, 'type')).toBe('checkbox');
    expect(has(attrs, 'checked')).toBe(false);
    expect(has(attrs, 'value')).toBe(false);
    expect(text(labelFor(html, attr(attrs, 'id')!)!)).toBe(`${LABELS.consent} *`);
  });

  it('links to the privacy page in a new tab, after the consent sentence and outside its label', () => {
    const link = /<a([^>]*\shref="\/privacy"[^>]*)>([\s\S]*?)<\/a>/.exec(html)!;
    expect(attr(link[1], 'target')).toBe('_blank');
    expect(attr(link[1], 'rel')).toBe('noopener');
    expect(text(link[2])).toMatch(/^Privacy\b/);
    expect(html.indexOf(link[0])).toBeGreaterThan(html.indexOf('name="consent"'));
    expect(labelFor(html, 'apply-consent')).not.toContain('<a');
  });

  it('hides the honeypot from people, not from scripts', () => {
    const { attrs } = control(html, APPLY_HONEYPOT);
    expect(attr(attrs, 'tabindex')).toBe('-1');
    expect(attr(attrs, 'autoComplete')).toBe('off');
    expect(has(attrs, 'required')).toBe(false);
    const wrapper = new RegExp(`<div([^>]*)>\\s*<label[^>]*>[^<]+</label>\\s*<input[^>]*name="${APPLY_HONEYPOT}"`).exec(html)!;
    expect(attr(wrapper[1], 'aria-hidden')).toBe('true');
    // Off screen, which a script still reads; not removed from the page.
    expect(attr(wrapper[1], 'class')).toContain('-left-[9999px]');
    expect(wrapper[0]).not.toMatch(/hidden=""|display:\s*none|type="hidden"/);
    expect(attr(wrapper[1], 'class')!.split(' ')).not.toContain('hidden');
    // Words a script reads as a field to fill, and that no browser matches to something it has saved.
    expect(text(labelFor(html, attr(attrs, 'id')!)!)).toBe('Leave this field empty');
    expect(attr(attrs, 'name')).toBe('referral_code');
    expect(html).not.toMatch(/company|website/i);
  });

  it('has one button, "Send application", ready to press', () => {
    expect(count(html, /<button[\s>]/g)).toBe(1);
    const button = /<button([^>]*)>([\s\S]*?)<\/button>/.exec(html)!;
    expect(attr(button[1], 'type')).toBe('submit');
    expect(has(button[1], 'disabled')).toBe(false);
    expect(text(button[2])).toBe('Send application');
  });

  it('reports no problem and holds no value', () => {
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain(' aria-invalid=');
    expect(html).not.toMatch(/needs? fixing/);
    expect(html).not.toContain('<script');
    for (const { attrs, body } of controls(html)) {
      expect(attr(attrs, 'value') ?? '').toBe('');
      expect(body).toBe('');
    }
  });

  it('uses no purple or violet, and no colour of its own', () => {
    expect(html).not.toMatch(/purple|violet|indigo|fuchsia|chart-5|#[0-9a-f]{3,8}\b|rgb\(|oklch\(|hsl\(/i);
  });
});

describe('the form while it is being sent', () => {
  it('says "Sending…" on a disabled button, so a second tap sends nothing', () => {
    const button = /<button([^>]*)>([\s\S]*?)<\/button>/.exec(render(ALL, undefined, true))!;
    expect(has(button[1], 'disabled')).toBe(true);
    expect(text(button[2])).toBe('Sending…');
  });
});

describe('the form after the server found problems (no script needed)', () => {
  const values = {
    ...EMPTY_APPLY_VALUES,
    name: 'Aisyah <b>Rahman</b>', email: 'aisyah@', phone: '012-345 6789',
    cover_letter: 'Line one.\nLine "two" & <script>alert(1)</script>', expected_salary: 'lots',
  };
  const errors = {
    email: APPLY_MESSAGES.emailInvalid, cv_url: APPLY_MESSAGES.cvRequired,
    expected_salary: APPLY_MESSAGES.salaryInvalid, consent: APPLY_MESSAGES.consent,
  };
  const html = render(ALL, { errors, values });

  it('keeps what was typed in every field, as text', () => {
    expect(attr(control(html, 'name').attrs, 'value')).toBe('Aisyah &lt;b&gt;Rahman&lt;/b&gt;');
    expect(attr(control(html, 'email').attrs, 'value')).toBe('aisyah@');
    expect(attr(control(html, 'phone').attrs, 'value')).toBe('012-345 6789');
    expect(attr(control(html, 'expected_salary').attrs, 'value')).toBe('lots');
    expect(control(html, 'cover_letter').body).toBe('Line one.\nLine &quot;two&quot; &amp; &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<b>');
  });

  it('counts the cover letter that came back', () => {
    expect(html).toContain(`${[...values.cover_letter].length} / 4,000`);
  });

  it('counts a cover letter of emoji one each, and without the space around it, as the check does', () => {
    const emoji = render(ALL, { errors, values: { ...values, cover_letter: `  ${'😀'.repeat(1234)}\n` } });
    expect(text(byId(emoji, 'apply-cover_letter-count')![3])).toBe('1,234 / 4,000');
  });

  it('leaves the consent box unticked, because the visitor had not ticked it', () => {
    expect(has(control(html, 'consent').attrs, 'checked')).toBe(false);
  });

  it('puts each message under its own field, tied to it, and marks the field invalid', () => {
    for (const field of shownFields(ALL)) {
      const { attrs } = control(html, field);
      const message = byId(html, `${attr(attrs, 'id')}-error`);
      if (field in errors) {
        expect(attr(attrs, 'aria-invalid')).toBe('true');
        expect(attr(attrs, 'aria-describedby')!.split(' ')).toContain(`${attr(attrs, 'id')}-error`);
        expect(attr(message![2], 'role')).toBe('alert');
        expect(text(message![3])).toBe(errors[field as keyof typeof errors]);
        expect(html.indexOf(message![0])).toBeGreaterThan(html.indexOf(`name="${field}"`));
      } else {
        expect(has(attrs, 'aria-invalid')).toBe(false);
        expect(message).toBeNull();
      }
    }
  });

  it('keeps the helper text and the units tied to a field that also has a message', () => {
    expect(attr(control(html, 'cv_url').attrs, 'aria-describedby')!.split(' ')).toHaveLength(2);
    expect(attr(control(html, 'expected_salary').attrs, 'aria-describedby')!.split(' ')).toHaveLength(3);
  });

  it('lists the problems at the top of the form, each a link to its field, in the form\'s order', () => {
    expect(text(html)).toContain('4 things need fixing');
    const summary = html.slice(html.indexOf('4 things need fixing'), html.indexOf('* Required'));
    const links = [...summary.matchAll(/<a[^>]*\shref="#([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
    expect(links.map((link) => link[1])).toEqual(
      (['email', 'cv_url', 'expected_salary', 'consent'] as const).map((field) => attr(control(html, field).attrs, 'id')),
    );
    expect(links.map((link) => text(link[2]))).toEqual(Object.values(errors));
    expect(html.indexOf('4 things need fixing')).toBeGreaterThan(html.indexOf('<form'));
    expect(html.indexOf('4 things need fixing')).toBeLessThan(html.indexOf('name="name"'));
  });

  it('says "1 thing needs fixing" for one', () => {
    const one = render(ALL, { errors: { email: APPLY_MESSAGES.email }, values: { ...values, consent: true } });
    expect(text(one)).toContain('1 thing needs fixing');
    expect(text(one)).not.toContain('things need fixing');
  });

  it('keeps the consent box ticked when the visitor had ticked it', () => {
    const ticked = render(ALL, { errors: { email: APPLY_MESSAGES.email }, values: { ...values, consent: true } });
    expect(has(control(ticked, 'consent').attrs, 'checked')).toBe(true);
  });

  it('shows no message for a field this form does not have', () => {
    const none = render(FORMS['all off'], { errors: { cv_url: APPLY_MESSAGES.cvRequired }, values });
    expect(none).not.toContain(APPLY_MESSAGES.cvRequired);
    expect(none).not.toMatch(/needs? fixing/);
  });
});

describe('the form after a problem with the whole application', () => {
  const values = { ...EMPTY_APPLY_VALUES, name: 'Aisyah Rahman', email: 'aisyah@example.com', consent: true };

  it.each([APPLY_MESSAGES.throttled, APPLY_MESSAGES.failed])('says "%s" above the button and keeps what was typed', (error) => {
    const html = render(ALL, { error, values });
    const alert = /<p([^>]*\srole="alert"[^>]*)>([\s\S]*?)<\/p>/.exec(html)!;
    expect(text(alert[2])).toBe(error);
    expect(count(html, /role="alert"/g)).toBe(1);
    expect(html.indexOf(alert[0])).toBeLessThan(html.indexOf('<button'));
    expect(html.indexOf(alert[0])).toBeGreaterThan(html.indexOf('name="consent"'));
    expect(attr(control(html, 'name').attrs, 'value')).toBe('Aisyah Rahman');
    expect(attr(control(html, 'email').attrs, 'value')).toBe('aisyah@example.com');
    expect(has(control(html, 'consent').attrs, 'checked')).toBe(true);
    expect(html).not.toMatch(/needs? fixing/);
  });
});

describe('the form after its requirements changed while it was open', () => {
  const values = { ...EMPTY_APPLY_VALUES, name: 'Aisyah Rahman', email: 'aisyah@example.com', consent: true };
  const state = { error: APPLY_MESSAGES.formChanged, errors: { cv_url: APPLY_MESSAGES.cvRequired }, values };

  it('says the form changed above the button while the new field is still on its way', () => {
    const html = render(FORMS['all off'], state);
    const alerts = [...html.matchAll(/<p[^>]*\srole="alert"[^>]*>([\s\S]*?)<\/p>/g)].map((match) => text(match[1]));
    expect(alerts).toEqual([APPLY_MESSAGES.formChanged]);
    expect(attr(control(html, 'name').attrs, 'value')).toBe('Aisyah Rahman');
    expect(has(control(html, 'consent').attrs, 'checked')).toBe(true);
  });

  it('shows the new field with its problem under it once the page has the current form, with or without a script', () => {
    const html = render(FORMS['CV only'], state);
    const { attrs } = control(html, 'cv_url');
    expect(attr(attrs, 'aria-invalid')).toBe('true');
    expect(text(byId(html, `${attr(attrs, 'id')}-error`)![3])).toBe(APPLY_MESSAGES.cvRequired);
    expect(text(html)).toContain('1 thing needs fixing');
    expect(text(html)).toContain(APPLY_MESSAGES.formChanged);
    expect(attr(control(html, 'name').attrs, 'value')).toBe('Aisyah Rahman');
    // Without a script the answer carries no such notice; the field and its problem are there all the same.
    const posted = render(FORMS['CV only'], { errors: state.errors, values });
    expect(text(byId(posted, 'apply-cv_url-error')![3])).toBe(APPLY_MESSAGES.cvRequired);
  });
});

describe('the form once it is over', () => {
  it('done: a panel that can take focus thanks the visitor by first name, and the form is gone', () => {
    const html = render(ALL, { done: { firstName: 'Aisyah' } });
    expect(html).not.toMatch(/<(form|input|textarea|button)[\s>]/);
    const panel = /^<div([^>]*)>/.exec(html)![1];
    expect(attr(panel, 'tabindex')).toBe('-1');
    expect(attr(panel, 'role')).toBe('status');
    expect(html).toMatch(/<h3[^>]*>Application sent<\/h3>/);
    expect(text(html)).toContain(
      "Thanks, Aisyah. Tanjung Trading has your details and will be in touch if there's a match.",
    );
  });

  it('done with no first name: "Thanks."', () => {
    const html = text(render(ALL, { done: { firstName: '' } }));
    expect(html).toContain("Thanks. Tanjung Trading has your details and will be in touch if there's a match.");
    expect(html).not.toContain('Thanks,');
  });

  it('done: the name is text, never markup', () => {
    const html = render(ALL, { done: { firstName: '<img src=x onerror=alert(1)>' } });
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('closed: the same panel says the role is no longer taking applications, and the form is gone', () => {
    const html = render(ALL, { closed: true });
    expect(html).not.toMatch(/<(form|input|textarea|button)[\s>]/);
    const panel = /^<div([^>]*)>/.exec(html)![1];
    expect(attr(panel, 'tabindex')).toBe('-1');
    expect(attr(panel, 'role')).toBe('status');
    expect(attr(panel, 'class')).toBe(attr(/^<div([^>]*)>/.exec(render(ALL, { done: { firstName: 'A' } }))![1], 'class'));
    expect(text(html)).toBe(APPLY_MESSAGES.closed);
  });
});
