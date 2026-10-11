import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BoardModel } from '@/lib/hire/lists';

/**
 * The Add Candidate and Edit candidate forms, and where they are offered, as
 * the server sends them: rendered to a string and read as markup. A dialog is
 * drawn in a portal, which a string render leaves out, so the forms inside the
 * two dialogs are rendered on their own.
 *
 * There is no DOM here (the tests run in node, and no jsdom, happy-dom or
 * testing library is installed), so nothing can be pressed, typed or focused.
 * What a save decides is therefore held in plain functions the forms call
 * (`candidateChanges`, `nothingChanged`, `firstWrongField`, `postedCv`) and
 * tested as such at the end of this file. What still needs a browser: that a
 * second press while a save is pending is ignored, that focus really lands on
 * the field `firstWrongField` names, that the dialog closes and announces
 * "Nothing was changed.", and that the browser puts the chosen file in the
 * form's own post.
 */

const mocks = vi.hoisted(() => ({
  viewer: { orgId: 'org1', role: 'member', isDemo: false } as { orgId: string; role: string; isDemo: boolean },
  board: null as unknown,
  action: vi.fn(),
  refresh: vi.fn(),
}));

// The real file is a server module (cookies, the database). Nothing here runs a handler.
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
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock('@/lib/auth/viewer', () => ({ getViewer: async () => mocks.viewer }));
vi.mock('@/screens/hire/parts', () => ({
  LOAD_FAILED: <p>load failed</p>,
  Muted: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  FUNNEL_COLOR: {},
  loadHire: async () => ({ model: mocks.board, isDemo: false }),
}));
vi.mock('@/components/charts', () => ({
  AreaTrend: () => null, BarGroup: () => null, DonutStat: () => null, FunnelFlow: () => null,
}));
// A closed menu draws nothing but its button. Here its items are drawn in place, so what the menu offers can be read.
vi.mock('@/components/ui/dropdown-menu', () => {
  const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
  const Item = ({ children }: { children?: ReactNode }) => <div role="menuitem">{children}</div>;
  return {
    DropdownMenu: Pass, DropdownMenuTrigger: Pass, DropdownMenuContent: Pass, DropdownMenuLabel: Pass,
    DropdownMenuRadioGroup: Pass, DropdownMenuSeparator: () => null, DropdownMenuItem: Item, DropdownMenuRadioItem: Item,
  };
});

import { ApplicationActions, ApplicationMenu, type ApplicationSubject } from '@/screens/hire/application-actions';
import { ApplicationRow, type ApplicationRowData } from '@/screens/hire/application-details';
import {
  AddCandidate, AddCandidateForm, EditCandidateForm, candidateChanges, firstWrongField, nothingChanged, postedCv,
} from '@/screens/hire/candidate-forms';
import { EMPTY_CANDIDATE_FORM } from '@/lib/hire/candidate-fields';
import CandidatesScreen from '@/screens/hire/candidates';

const ID = '44444444-4444-4444-8444-444444444444';
const CANDIDATE = '33333333-3333-4333-8333-333333333333';
const JOBS = [
  { id: '22222222-2222-4222-8222-222222222222', title: 'Barista' },
  { id: '55555555-5555-4555-8555-555555555555', title: 'Cashier & <Lead>' },
];
const subject: ApplicationSubject = {
  id: ID, candidateId: CANDIDATE, name: 'Aina Rahman', job: 'Barista', stage: 'interview', outcome: 'active', rating: null, rejectReason: null,
};
const card = { id: ID, candidateId: CANDIDATE, name: 'Aina Rahman', role: 'Barista', source: 'LinkedIn', lastTouch: '2d ago', active: true, stage: 'interview' as const, outcome: 'active' as const, rating: 4, rejectReason: null };
const board: BoardModel = {
  isEmpty: false, total: 1, hired: 0, inPipeline: 1, interviewing: 1, offers: 0, trend: [], funnel: [], jobs: JOBS,
  stages: (['applied', 'screening', 'interview', 'offer', 'hired'] as const).map((key) => ({
    key, name: key, count: key === 'interview' ? 1 : 0, candidates: key === 'interview' ? [card] : [],
  })),
};
const VIEWERS = {
  viewer: { orgId: 'org1', role: 'viewer', isDemo: false },
  'demo owner': { orgId: 'org1', role: 'owner', isDemo: true },
};

const unescape = (value: string) => value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const text = (html: string) => unescape(html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
const buttons = (html: string) =>
  [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map(([, attrs, inner]) => /aria-label="([^"]*)"/.exec(attrs)?.[1] ?? text(inner));
/** The opening tag of the button with this accessible name. */
const buttonTag = (html: string, name: string) => {
  const found = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].find(([, attrs, inner]) => (/aria-label="([^"]*)"/.exec(attrs)?.[1] ?? text(inner)) === name);
  if (!found) throw new Error(`no button named ${name}`);
  return `<button${found[1]}>`;
};
const tags = (html: string, name: string) => [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'g'))].map(([tag]) => tag);
const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
/** The text of every label, by the id of the control it is for. */
const labels = (html: string) =>
  Object.fromEntries([...html.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/g)].map(([, attrs, inner]) => [attr(`<label${attrs}>`, 'for'), text(inner)]));
/** The control (input, select or textarea) a label with this text is for. */
const control = (html: string, label: string) => {
  const id = Object.entries(labels(html)).find(([, value]) => value === label || value === `${label} *`)?.[0];
  if (!id) throw new Error(`no label ${label}`);
  const tag = [...tags(html, 'input'), ...tags(html, 'select'), ...tags(html, 'textarea')].find((t) => attr(t, 'id') === id);
  if (!tag) throw new Error(`the label ${label} is for nothing`);
  return tag;
};

const noop = () => {};
const addForm = (jobId = '', jobs = JOBS) =>
  renderToStaticMarkup(
    <AddCandidateForm jobs={jobs} initialJobId={jobId} pending={false} error={null} onDirtyChange={noop} onClearError={noop} onCancel={noop} onSubmit={noop} />,
  );
const STORED = { id: CANDIDATE, name: 'Aina Rahman', email: 'aina@example.com', phone: '+60123456789', headline: 'Barista', location: 'Shah Alam', skills: 'Latte art, Cashier', source: 'Referral' };
const editForm = (pending = false, error: string | null = null) =>
  renderToStaticMarkup(
    <EditCandidateForm initial={STORED} pending={pending} error={error} onDirtyChange={noop} onClearError={noop} onCancel={noop} onSubmit={noop} />,
  );

const PERSON_LABELS = ['Full name *', 'Email', 'Phone', 'Headline', 'Location', 'Skills', 'Source'];

beforeEach(() => {
  mocks.viewer = { orgId: 'org1', role: 'member', isDemo: false };
  mocks.board = board;
  mocks.action.mockReset();
});

describe('the Add Candidate button on the board', () => {
  it('is a real button for someone who may edit, beside the Export placeholder, which stays disabled', async () => {
    const html = renderToStaticMarkup(await CandidatesScreen());
    expect(buttons(html)).toEqual(expect.arrayContaining(['Export', 'Add Candidate']));
    const add = buttonTag(html, 'Add Candidate');
    expect(add).toContain('type="button"');
    expect(add).not.toMatch(/\sdisabled=|aria-disabled=|title="Coming soon"/);
    expect(add).toContain('min-h-11');
    expect(add).toMatch(/focus-visible:ring-/);
    expect(buttonTag(html, 'Export')).toMatch(/\sdisabled=""/);
  });

  it('is not drawn at all for a viewer or in the demo workspace, where only the Export placeholder is left', async () => {
    for (const who of ['viewer', 'demo owner'] as const) {
      mocks.viewer = VIEWERS[who];
      const html = renderToStaticMarkup(await CandidatesScreen());
      // The two unnamed ones are the disabled filter placeholders, which are not this task's.
      expect(buttons(html).filter((name) => name !== '')).toEqual(['Export']);
      for (const tag of tags(html, 'button')) expect(tag).toMatch(/\sdisabled=""/);
      expect(html).not.toContain('Add Candidate');
      expect(html).not.toContain('Edit candidate');
    }
  });

  it('is drawn when the board has no applications yet, and when it could not be loaded', async () => {
    mocks.board = { ...board, isEmpty: true };
    expect(buttons(renderToStaticMarkup(await CandidatesScreen()))).toContain('Add Candidate');
    mocks.board = null;
    expect(buttons(renderToStaticMarkup(await CandidatesScreen()))).toContain('Add Candidate');
  });

  it('comes with a polite live region that is in the page before there is anything to say', () => {
    const html = renderToStaticMarkup(<AddCandidate jobs={JOBS} />);
    expect(html).toMatch(/<p\b[^>]*aria-live="polite"[^>]*><\/p>/);
    expect(buttons(html)).toEqual(['Add Candidate']);
    // The dialog is closed: no form and no job title has been sent yet.
    expect(html).not.toContain('<form');
  });

  it('puts no email, phone number or storage path in the board\'s markup', async () => {
    const html = renderToStaticMarkup(await CandidatesScreen());
    expect(html).not.toMatch(/cv_path|[\w.]+@[\w-]+\.\w+|\+?60\d{8,}/);
  });
});

describe('the Add Candidate form', () => {
  it('has a visible label for every field, each tied to its control, in the order of the form', () => {
    const html = addForm();
    expect(Object.values(labels(html))).toEqual([...PERSON_LABELS, 'Job']);
    for (const label of ['Full name', 'Email', 'Phone', 'Headline', 'Location', 'Skills', 'Source', 'Job']) control(html, label);
  });

  it('marks the name as required, in words for a screen reader, and explains the mark', () => {
    const html = addForm();
    expect(control(html, 'Full name')).toContain('aria-required="true"');
    expect(html).toMatch(/Full name <span aria-hidden="true">\*<\/span>/);
    expect(text(html)).toContain('* Required');
    for (const label of ['Email', 'Phone', 'Headline', 'Location', 'Skills', 'Source']) expect(control(html, label)).not.toContain('aria-required');
  });

  it('names every field for the form post, and types the email and the phone', () => {
    const html = addForm();
    const names = ['name', 'email', 'phone', 'headline', 'location', 'skills', 'source', 'job_id'];
    expect(['Full name', 'Email', 'Phone', 'Headline', 'Location', 'Skills', 'Source', 'Job'].map((label) => attr(control(html, label), 'name'))).toEqual(names);
    expect(attr(control(html, 'Email'), 'type')).toBe('email');
    expect(attr(control(html, 'Phone'), 'type')).toBe('tel');
    // No browser bubble: the form says what is wrong itself.
    expect(tags(html, 'form')[0]).toMatch(/\snovalidate=""/i);
  });

  it('gives the headline and the skills a helper tied to the field, and the source its placeholder', () => {
    const html = addForm();
    expect(text(html)).toContain('For example, Senior Sales Executive at Bintang Packaging');
    expect(text(html)).toContain('Separate with commas');
    for (const [label, helper] of [['Headline', 'For example, Senior Sales Executive at Bintang Packaging'], ['Skills', 'Separate with commas']]) {
      const describedBy = attr(control(html, label), 'aria-describedby')!;
      expect(new RegExp(`<p\\b[^>]*id="${describedBy}"[^>]*>([^<]*)</p>`).exec(html)?.[1]).toBe(helper);
    }
    expect(attr(control(html, 'Source'), 'placeholder')).toBe('Added by hand');
  });

  it('offers the jobs in a native select, with No job yet first and chosen', () => {
    const html = addForm();
    const select = /<select\b[^>]*>([\s\S]*?)<\/select>/.exec(html)![1];
    const options = [...select.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/g)].map(([, attrs, inner]) => [attr(`<option${attrs}>`, 'value'), unescape(inner), /\sselected=""/.test(attrs)]);
    expect(options).toEqual([
      ['', 'No job yet', true],
      [JOBS[0].id, 'Barista', false],
      [JOBS[1].id, 'Cashier & <Lead>', false],
    ]);
    // A title is text, never markup.
    expect(html).not.toContain('<Lead>');
  });

  it('with no job: says when a CV can be added, and has no application fields and no file input', () => {
    const html = addForm();
    expect(text(html)).toContain('A CV can be added once the candidate is put forward for a job.');
    expect(html).not.toContain('For this application');
    expect(html).not.toContain('type="file"');
    expect(html).not.toContain('name="cover_letter"');
    expect(html).not.toContain('name="cv_url"');
  });

  it('with no job: the hint tied to the job select says the person will not be on the board, and that Lekir can find them', () => {
    const html = addForm();
    const hintId = attr(control(html, 'Job'), 'aria-describedby')!;
    const hint = unescape(new RegExp(`<p\\b[^>]*id="${hintId}"[^>]*>([^<]*)</p>`).exec(html)?.[1] ?? '');
    expect(hint).toBe(
      'This person will not appear on the board until they are added to a job. Lekir can find them by name. '
      + 'A CV can be added once the candidate is put forward for a job.',
    );
    // Said only while no job is picked, and never on the Edit form, which has no job.
    expect(text(addForm(JOBS[0].id))).not.toMatch(/will not appear on the board|Lekir can find/);
    expect(attr(control(addForm(JOBS[0].id), 'Job'), 'aria-describedby')).toBeUndefined();
    expect(text(editForm())).not.toMatch(/will not appear on the board|Lekir can find/);
  });

  it('with a job: a fieldset For this application with the cover note and its count, the CV link and the file input', () => {
    const html = addForm(JOBS[0].id);
    expect(text(html)).not.toContain('A CV can be added once');
    const fieldset = /<fieldset\b[^>]*>\s*<legend\b[^>]*>For this application<\/legend>([\s\S]*?)<\/fieldset>/.exec(html)?.[1];
    expect(fieldset).toBeTruthy();
    expect(Object.values(labels(fieldset!))).toEqual(['Cover note', 'CV link', 'CV file']);
    const note = control(html, 'Cover note');
    expect(note.startsWith('<textarea')).toBe(true);
    expect(attr(note, 'name')).toBe('cover_letter');
    expect(text(fieldset!)).toContain('0 / 4,000');
    expect(attr(control(html, 'CV link'), 'name')).toBe('cv_url');
    const file = control(html, 'CV file');
    expect(attr(file, 'type')).toBe('file');
    expect(attr(file, 'name')).toBe('cv_file');
    expect(attr(file, 'accept')).toBe('application/pdf,.pdf');
    const hint = attr(file, 'aria-describedby')!;
    expect(new RegExp(`<p\\b[^>]*id="${hint}"[^>]*>([^<]*)</p>`).exec(html)?.[1]).toBe('PDF, up to 5 MB');
    // Nothing is chosen yet: no file name, no Remove.
    expect(buttons(html)).toEqual(['Cancel', 'Save']);
  });

  it('has Cancel and Save with 44 pixel targets, every field 44 pixels high, and nothing shown as wrong before anything is tried', () => {
    const html = addForm(JOBS[0].id);
    expect(buttons(html)).toEqual(['Cancel', 'Save']);
    for (const tag of tags(html, 'button')) expect(tag).toMatch(/min-h-11/);
    expect(tags(html, 'button')[1]).toContain('type="submit"');
    for (const tag of [...tags(html, 'input'), ...tags(html, 'select')]) expect(tag).toMatch(/\bh-11\b|min-h-11/);
    expect(html).not.toContain('role="alert"');
    expect(html).not.toMatch(/\saria-invalid=/);
    expect(html).not.toContain("can't be matched");
  });

  it('says Saving… and marks both buttons as waiting, without the disabled attribute, while it is being saved', () => {
    const html = renderToStaticMarkup(
      <AddCandidateForm jobs={JOBS} initialJobId="" pending error={null} onDirtyChange={noop} onClearError={noop} onCancel={noop} onSubmit={noop} />,
    );
    expect(buttons(html)).toEqual(['Cancel', 'Saving…']);
    for (const tag of tags(html, 'button')) {
      expect(tag).toContain('aria-disabled="true"');
      expect(tag).not.toMatch(/\sdisabled=""/);
    }
  });

  it.each([
    ['Enter an email address like name@example.com.', 'Email'],
    ['That job could not be found.', 'Job'],
    ['Only an open or paused job can take a new application.', 'Job'],
  ])('shows the refusal "%s" under the %s field, and not in the box above the buttons', (error, label) => {
    const html = renderToStaticMarkup(
      <AddCandidateForm jobs={JOBS} initialJobId={JOBS[0].id} pending={false} error={error} onDirtyChange={noop} onClearError={noop} onCancel={noop} onSubmit={noop} />,
    );
    const tag = control(html, label);
    expect(tag).toContain('aria-invalid="true"');
    const alerts = [...html.matchAll(/<p\b([^>]*)role="alert"([^>]*)>([^<]*)<\/p>/g)].map(([, a, b, inner]) => [attr(`<p${a}${b}>`, 'id'), unescape(inner)]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0][1]).toBe(error);
    expect(attr(tag, 'aria-describedby')!.split(' ')).toContain(alerts[0][0]);
  });

  it('shows a link refusal under the CV link and a file refusal under the file input', () => {
    const render = (error: string) => renderToStaticMarkup(
      <AddCandidateForm jobs={JOBS} initialJobId={JOBS[0].id} pending={false} error={error} onDirtyChange={noop} onClearError={noop} onCancel={noop} onSubmit={noop} />,
    );
    expect(control(render('Enter a link that starts with https://'), 'CV link')).toContain('aria-invalid="true"');
    expect(control(render('Choose a PDF file.'), 'CV file')).toContain('aria-invalid="true"');
    expect(control(render('This file is 7.2 MB. Choose one under 5 MB.'), 'CV file')).toContain('aria-invalid="true"');
    // Refused because files cannot be taken just now: said at the file, where it can be removed and the form sent again.
    const noUploads = render('CV files cannot be uploaded right now. Add the candidate without the file, or try again later.');
    expect(control(noUploads, 'CV file')).toContain('aria-invalid="true"');
    expect(noUploads.match(/role="alert"/g)).toHaveLength(1);
  });

  it('shows any other refusal in one alert box above the buttons, with no field marked wrong', () => {
    const error = 'You do not have permission to make changes here.';
    const html = renderToStaticMarkup(
      <AddCandidateForm jobs={JOBS} initialJobId="" pending={false} error={error} onDirtyChange={noop} onClearError={noop} onCancel={noop} onSubmit={noop} />,
    );
    expect(html).not.toMatch(/\saria-invalid=/);
    expect(html.match(/role="alert"/g)).toHaveLength(1);
    const at = html.indexOf(unescape(error));
    expect(at).toBeGreaterThan(html.indexOf('name="job_id"'));
    expect(at).toBeLessThan(html.indexOf('Cancel'));
  });

  it('uses no purple or violet, and no raw colour', () => {
    expect(addForm(JOBS[0].id)).not.toMatch(/purple|violet|chart-5|#[0-9a-f]{6}\b/i);
  });

  it('sends nothing to the server just by being drawn', () => {
    addForm();
    addForm(JOBS[0].id);
    expect(mocks.action).not.toHaveBeenCalled();
  });
});

describe('the Edit candidate form', () => {
  it('has the seven personal fields, filled with what is stored, and no job, cover note, link or file', () => {
    const html = editForm();
    expect(Object.values(labels(html))).toEqual(PERSON_LABELS);
    const value = (label: string) => unescape(attr(control(html, label), 'value') ?? '');
    expect(['Full name', 'Email', 'Phone', 'Headline', 'Location', 'Skills', 'Source'].map(value)).toEqual([
      'Aina Rahman', 'aina@example.com', '+60123456789', 'Barista', 'Shah Alam', 'Latte art, Cashier', 'Referral',
    ]);
    expect(html).not.toContain('<select');
    expect(html).not.toContain('type="file"');
    expect(html).not.toContain('For this application');
    expect(html).not.toContain('A CV can be added once');
    expect(buttons(html)).toEqual(['Cancel', 'Save']);
  });

  it('shows "Another candidate already has this email." under the email', () => {
    const html = editForm(false, 'Another candidate already has this email.');
    const tag = control(html, 'Email');
    expect(tag).toContain('aria-invalid="true"');
    const id = /<p\b[^>]*id="([^"]+)"[^>]*role="alert"|<p\b[^>]*role="alert"[^>]*id="([^"]+)"/.exec(html);
    expect(attr(tag, 'aria-describedby')!.split(' ')).toContain(id?.[1] ?? id?.[2]);
    expect(html.match(/role="alert"/g)).toHaveLength(1);
  });

  it('says Saving… and marks both buttons as waiting while it is being saved', () => {
    const html = editForm(true);
    expect(buttons(html)).toEqual(['Cancel', 'Saving…']);
    for (const tag of tags(html, 'button')) expect(tag).toContain('aria-disabled="true"');
  });

  it('asks the server for nothing just by being drawn', () => {
    editForm();
    expect(mocks.action).not.toHaveBeenCalled();
  });
});

/** What the Edit form holds for a stored candidate, and what it holds after some fields were retyped. */
const held = (over: Partial<typeof STORED> = {}) => {
  const { name, email, phone, headline, location, skills, source } = { ...STORED, ...over };
  return { ...EMPTY_CANDIDATE_FORM, name, email, phone, headline, location, skills, source };
};

describe('what an edit sends when a stored skill has a comma in it', () => {
  // Possible for a candidate saved before a skill was refused a comma. The form shows "Sales, B2B, Excel".
  const stored = held({ skills: ['Sales, B2B', 'Excel'].join(', ') });

  it('sends no skills when the skills line was not touched, so the stored skill is left whole', () => {
    expect(candidateChanges(CANDIDATE, stored, { ...stored })).toEqual({ id: CANDIDATE });
    expect(candidateChanges(CANDIDATE, stored, { ...stored, phone: '+60198887766' })).toEqual({ id: CANDIDATE, phone: '+60198887766' });
    // Retyped to the same line, or with other spacing: still not a change.
    expect(candidateChanges(CANDIDATE, stored, { ...stored, skills: ' Sales,B2B ,Excel, ' })).toEqual({ id: CANDIDATE });
  });

  it('sends the line as it reads once it was edited: every comma separates, as the form says', () => {
    expect(candidateChanges(CANDIDATE, stored, { ...stored, skills: 'Sales, B2B, Excel, Negotiation' })).toEqual({
      id: CANDIDATE, skills: ['Sales', 'B2B', 'Excel', 'Negotiation'],
    });
    for (const skill of candidateChanges(CANDIDATE, stored, { ...stored, skills: 'Sales, B2B' }).skills ?? ['a,b']) expect(skill).not.toContain(',');
  });
});

describe('what an edit sends', () => {
  const opened = held();

  it('sends the id and only the fields that were changed, trimmed', () => {
    expect(candidateChanges(CANDIDATE, opened, { ...opened, phone: ' +60198887766 ' })).toEqual({ id: CANDIDATE, phone: '+60198887766' });
    expect(candidateChanges(CANDIDATE, opened, { ...opened, name: 'Aina Abdul Rahman', skills: 'Latte art, Cashier, Stock take' })).toEqual({
      id: CANDIDATE, name: 'Aina Abdul Rahman', skills: ['Latte art', 'Cashier', 'Stock take'],
    });
    // Every field, each on its own: nothing else rides along.
    const next = { name: 'A', email: 'a@b.co', phone: '1', headline: 'H', location: 'L', source: 'S' };
    for (const [field, value] of Object.entries(next)) {
      expect(candidateChanges(CANDIDATE, opened, { ...opened, [field]: value })).toEqual({ id: CANDIDATE, [field]: value });
    }
  });

  it('sends a blank for a field that was emptied, and an empty list for skills that were', () => {
    expect(candidateChanges(CANDIDATE, opened, { ...opened, email: '  ', skills: ' , ' })).toEqual({ id: CANDIDATE, email: '', skills: [] });
  });

  it('never sends the job, the cover note or the CV link: an edit is of the person', () => {
    const changes = candidateChanges(CANDIDATE, opened, { ...opened, job_id: JOBS[0].id, cover_letter: 'x', cv_url: 'https://a.co' });
    expect(changes).toEqual({ id: CANDIDATE });
  });

  it('sends nothing but the id when nothing differs, and that is what the dialog reads as nothing changed', () => {
    const same = candidateChanges(CANDIDATE, opened, { ...opened });
    expect(same).toEqual({ id: CANDIDATE });
    expect(nothingChanged(same)).toBe(true);
    // Only spacing differs: still nothing.
    expect(nothingChanged(candidateChanges(CANDIDATE, opened, { ...opened, name: ' Aina Rahman ', skills: 'Latte art,Cashier' }))).toBe(true);
    expect(nothingChanged(candidateChanges(CANDIDATE, opened, { ...opened, source: '' }))).toBe(false);
    expect(nothingChanged({ id: CANDIDATE, skills: [] })).toBe(false);
  });
});

describe('the field a refused save goes to', () => {
  it('is the first wrong one in the order the form shows them, not the order they were found', () => {
    expect(firstWrongField('add', { cv_file: 'x', cv_url: 'x', email: 'x', name: 'x' })).toBe('name');
    expect(firstWrongField('add', { cv_file: 'x', cv_url: 'x', email: 'x' })).toBe('email');
    expect(firstWrongField('add', { cv_file: 'x', cover_letter: 'x', job_id: 'x' })).toBe('job_id');
    expect(firstWrongField('add', { cv_file: 'x', cv_url: 'x' })).toBe('cv_url');
    expect(firstWrongField('add', { cv_file: 'x' })).toBe('cv_file');
    expect(firstWrongField('edit', { source: 'x', skills: 'x' })).toBe('skills');
  });

  it('is none when nothing is wrong, and on an edit never one the Edit form does not show', () => {
    expect(firstWrongField('add', {})).toBeNull();
    expect(firstWrongField('edit', {})).toBeNull();
    expect(firstWrongField('edit', { job_id: 'x', cover_letter: 'x', cv_url: 'x', cv_file: 'x' })).toBeNull();
  });

  it('names a control the drawn form really has, by the id focus is sent to', () => {
    const html = addForm(JOBS[0].id);
    const ids = [...tags(html, 'input'), ...tags(html, 'select'), ...tags(html, 'textarea')].map((tag) => attr(tag, 'id') ?? '');
    for (const field of ['name', 'email', 'phone', 'headline', 'location', 'skills', 'source', 'job_id', 'cover_letter', 'cv_url', 'cv_file'] as const) {
      expect(firstWrongField('add', { [field]: 'x' })).toBe(field);
      expect(ids.filter((id) => id.endsWith(`-${field}`)), field).toHaveLength(1);
    }
  });
});

describe('the CV in the form\'s post', () => {
  const PDF_BYTES = new TextEncoder().encode('%PDF-1.7 a small file');
  const post = (file?: File) => {
    const data = new FormData();
    data.set('name', 'Aina Rahman');
    data.set('job_id', JOBS[0].id);
    if (file) data.set('cv_file', file);
    return data;
  };

  it('travels as the file itself, bytes and name, when a job is picked', async () => {
    const data = post(new File([PDF_BYTES], 'aina-cv.pdf', { type: 'application/pdf' }));
    expect(postedCv(data, true)).toEqual({ name: 'aina-cv.pdf', size: PDF_BYTES.length, type: 'application/pdf' });
    const sent = data.get('cv_file');
    expect(sent).toBeInstanceOf(File);
    expect((sent as File).name).toBe('aina-cv.pdf');
    expect(new Uint8Array(await (sent as File).arrayBuffer())).toEqual(PDF_BYTES);
    // The rest of the post is as it was.
    expect(data.get('name')).toBe('Aina Rahman');
    expect(data.get('job_id')).toBe(JOBS[0].id);
  });

  it('is left out when the file input was not touched: an empty, nameless file is no file', () => {
    const data = post(new File([], ''));
    expect(postedCv(data, true)).toBeNull();
    expect(data.has('cv_file')).toBe(false);
    expect(postedCv(post(), true)).toBeNull();
  });

  it('is left out when no job is picked, whatever the post holds', () => {
    const data = post(new File([PDF_BYTES], 'aina-cv.pdf', { type: 'application/pdf' }));
    expect(postedCv(data, false)).toBeNull();
    expect(data.has('cv_file')).toBe(false);
  });
});

describe('where Edit candidate is offered', () => {
  it('is an item of the board card\'s menu for someone who may edit, apart from the changes to the application', () => {
    const html = renderToStaticMarkup(<ApplicationMenu application={subject} canEdit />);
    const items = [...html.matchAll(/<div role="menuitem">([\s\S]*?)<\/div>/g)].map(([, inner]) => text(inner));
    expect(items).toContain('Edit candidate');
    expect(items.indexOf('Edit candidate')).toBeGreaterThan(items.indexOf('Rate 5 out of 5'));
    expect(items.indexOf('Edit candidate')).toBeLessThan(items.indexOf('Mark withdrawn'));
  });

  it('is in the menu of a rejected application too: the person can still be edited', () => {
    const html = renderToStaticMarkup(<ApplicationMenu application={{ ...subject, outcome: 'rejected' }} canEdit />);
    expect(text(html)).toContain('Edit candidate');
  });

  it('is not in the card for someone who may not edit', () => {
    expect(renderToStaticMarkup(<ApplicationMenu application={subject} canEdit={false} />)).toBe('');
  });

  it('is a button in the Applications details panel for someone who may edit, with a 44 pixel target', () => {
    const html = renderToStaticMarkup(<ApplicationActions application={subject} canEdit />);
    expect(buttons(html)).toContain('Edit candidate');
    const tag = tags(html, 'button').at(-1)!;
    expect(tag).toContain('min-h-11');
    expect(tag).toMatch(/focus-visible:ring-/);
    expect(renderToStaticMarkup(<ApplicationActions application={{ ...subject, outcome: 'withdrawn' }} canEdit />)).toContain('Edit candidate');
  });

  it('is not in the details panel for someone who may not edit', () => {
    expect(renderToStaticMarkup(<ApplicationActions application={subject} canEdit={false} />)).toBe('');
    const row: ApplicationRowData = {
      id: ID, candidateId: CANDIDATE, name: 'Aina Rahman', job: 'Barista', source: 'LinkedIn', status: 'Shortlisted', statusClass: 'pill', live: true,
      applied: '08 Oct 2026', details: { coverLetter: 'Dear team', cv: null, hasCvFile: false, portfolio: null, expectedSalary: null },
      stage: 'interview', outcome: 'active', rating: null, rejectReason: null,
    };
    const html = renderToStaticMarkup(<table><tbody><ApplicationRow row={row} canEdit={false} /></tbody></table>);
    expect(html).not.toContain('Edit candidate');
    expect(renderToStaticMarkup(<table><tbody><ApplicationRow row={row} canEdit /></tbody></table>)).toContain('Edit candidate');
  });

  it('asks for nobody\'s details until the form is opened: drawing the menu, the panel and the board calls nothing', async () => {
    renderToStaticMarkup(<ApplicationMenu application={subject} canEdit />);
    renderToStaticMarkup(<ApplicationActions application={subject} canEdit />);
    renderToStaticMarkup(await CandidatesScreen());
    expect(mocks.action).not.toHaveBeenCalled();
  });
});
