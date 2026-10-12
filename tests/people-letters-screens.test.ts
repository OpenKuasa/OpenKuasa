import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildLettersModel } from '@/lib/people/documents';
import {
  ACK_LINE,
  deleteDraftSentence,
  insertPlaceholder,
  insertRefusal,
  issueFailureSentence,
  issueState,
  letterFormDefaults,
  letterIssueSentence,
  letterPullBackSentence,
  letterView,
  lettersScreenControls,
  placeholderSpot,
  removeTemplateSentence,
  startChoice,
  visibleLetterRows,
} from '@/lib/people/letters-screens';
import { PLACEHOLDERS } from '@/lib/people/letter-placeholders';
import { WRITE_FAILED } from '@/lib/people/capabilities';
import type { Letter, PeopleViewer } from '@/lib/people/types';

const EMP = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

const letter = (over: Partial<Letter> & { id: string }): Letter => ({
  employee_id: EMP,
  employee_name: 'Aisyah Rahman',
  letter_type: 'offer',
  title: 'Offer',
  body: 'Welcome.',
  status: 'issued',
  issued_on: '2026-10-01',
  ack_requested: false,
  acknowledged_at: null,
  created_at: '2026-09-30T00:00:00Z',
  ...over,
});

const VIEWERS: Record<string, PeopleViewer> = {
  owner: { employeeId: null, isHr: true, isDemo: false },
  admin: { employeeId: OTHER, isHr: true, isDemo: false },
  linkedMember: { employeeId: EMP, isHr: false, isDemo: false },
  unlinkedMember: { employeeId: null, isHr: false, isDemo: false },
  demo: { employeeId: 'demo', isHr: false, isDemo: true },
  demoOwner: { employeeId: null, isHr: true, isDemo: true },
};

describe('lettersScreenControls', () => {
  it('draws owner controls for an owner or admin outside the demo, with the data loaded', () => {
    expect(lettersScreenControls(VIEWERS.owner, true).write).toBe(true);
    expect(lettersScreenControls(VIEWERS.admin, true).write).toBe(true);
  });
  it('draws none for a member (a viewer role is the same to this rule: only isHr and isDemo decide), an unlinked account or a demo visitor', () => {
    for (const key of ['linkedMember', 'unlinkedMember', 'demo', 'demoOwner']) {
      expect(lettersScreenControls(VIEWERS[key], true).write, key).toBe(false);
    }
  });
  it('is decided by the kind of viewer alone: true exactly for the owner and the admin', () => {
    const expected: Record<string, boolean> = {
      owner: true,
      admin: true,
      linkedMember: false,
      unlinkedMember: false,
      demo: false,
      demoOwner: false,
    };
    for (const key of Object.keys(VIEWERS)) expect(lettersScreenControls(VIEWERS[key], true).write, key).toBe(expected[key]);
  });
  it('draws none when the data did not load', () => {
    expect(lettersScreenControls(VIEWERS.owner, false).write).toBe(false);
    expect(lettersScreenControls(VIEWERS.admin, false).write).toBe(false);
  });
});

describe('issueFailureSentence', () => {
  it('says the draft was saved when the issue was refused', () => {
    expect(issueFailureSentence(true, 'The letter still has a placeholder in it. Replace it before issuing.')).toBe(
      'Saved as a draft, but not issued. The letter still has a placeholder in it. Replace it before issuing.',
    );
  });
  it('says the draft was saved when the issue threw', () => {
    expect(issueFailureSentence(true, null)).toBe('Saved as a draft, but not issued. Try again.');
  });
  it('gives the refusal as it is when nothing was saved', () => {
    expect(issueFailureSentence(false, 'Some of that was not accepted. Check it and try again.')).toBe(
      'Some of that was not accepted. Check it and try again.',
    );
  });
  it('gives the generic sentence only when nothing was saved and the call threw', () => {
    expect(issueFailureSentence(false, null)).toBe(WRITE_FAILED);
  });
});

describe('visibleLetterRows', () => {
  const letters = [
    letter({ id: 'a', title: 'Old', issued_on: '2026-01-01' }),
    letter({ id: 'b', title: 'Needs ack', issued_on: '2026-02-01', ack_requested: true }),
    letter({ id: 'c', title: 'Newest', issued_on: '2026-09-01' }),
    letter({ id: 'd', title: 'Secret draft', status: 'draft', issued_on: null }),
    letter({ id: 'e', title: 'Not mine', employee_id: OTHER }),
  ];
  it('gives a member their issued letters only, awaiting acknowledgement first, then newest', () => {
    const model = buildLettersModel(letters, VIEWERS.linkedMember, '2026-10-12');
    expect(visibleLetterRows(model).map((r) => r.id)).toEqual(['b', 'c', 'a']);
  });
  it('shows no count or hint of drafts to a member, even if a draft row is handed to the model', () => {
    const model = buildLettersModel(letters, VIEWERS.linkedMember, '2026-10-12');
    expect(model.totals).toBeNull();
    expect(JSON.stringify(visibleLetterRows(model))).not.toContain('Secret draft');
  });
  it('filters again at the screen: a draft row in a non-team model still draws nothing', () => {
    const model = buildLettersModel(letters, VIEWERS.linkedMember, '2026-10-12');
    const tampered = { ...model, rows: [...model.rows, ...buildLettersModel(letters, VIEWERS.owner, '2026-10-12').rows.filter((r) => r.id === 'd')] };
    expect(visibleLetterRows(tampered).map((r) => r.id)).not.toContain('d');
  });
  it('gives an owner every letter, drafts first', () => {
    const model = buildLettersModel(letters, VIEWERS.owner, '2026-10-12');
    const rows = visibleLetterRows(model);
    expect(rows[0].id).toBe('d');
    expect(rows).toHaveLength(5);
  });
});

describe('sentences', () => {
  it('says what issuing and pulling back do', () => {
    expect(letterIssueSentence('Aisyah')).toBe('Aisyah will be able to see this letter.');
    expect(letterPullBackSentence('Aisyah')).toBe('Aisyah will no longer see this letter, and any acknowledgement is cleared.');
  });
  it('names the draft being deleted and says it cannot be undone', () => {
    expect(deleteDraftSentence('Aisyah', 'Offer')).toBe('Delete the draft "Offer" to Aisyah? This cannot be undone.');
    expect(removeTemplateSentence('Warning')).toBe('Remove the template "Warning"? Letters already started from it are not changed.');
  });
  it('says an acknowledgement is not a signature', () => {
    expect(ACK_LINE).toBe('This records that you have read it. It is not a signature.');
  });
});

describe('issueState', () => {
  it('allows a letter with text and no known placeholder', () => {
    expect(issueState('Offer', 'Dear Aisyah,')).toEqual({ allowed: true, reason: null, names: [] });
  });
  it('refuses an empty or blank body with the reason', () => {
    expect(issueState('Offer', '')).toMatchObject({ allowed: false, reason: 'The letter has no text yet.', names: [] });
    expect(issueState('Offer', '  \n ').allowed).toBe(false);
  });
  it('names every placeholder left in the CURRENT title and body, title first, each once', () => {
    const state = issueState('Letter to {employee_name}', 'Role {designation}, {employee_name}, {today}');
    expect(state.allowed).toBe(false);
    expect(state.names).toEqual(['employee_name', 'designation', 'today']);
    expect(state.reason).toBe('Replace {employee_name}, {designation}, {today} before issuing.');
  });
  it('catches a placeholder the database did not report (a name that is literally one)', () => {
    expect(issueState('Offer', 'Dear {designation},').names).toEqual(['designation']);
  });
  it('leaves unknown braces alone', () => {
    expect(issueState('Offer', 'Salary {salary} and { today } and {Today}').allowed).toBe(true);
  });
  it('gives the empty-body reason first when both apply, and still names the placeholders', () => {
    const state = issueState('Hi {today}', '');
    expect(state.reason).toBe('The letter has no text yet.');
    expect(state.names).toEqual(['today']);
  });
});

describe('insertPlaceholder', () => {
  it('inserts at the caret and moves it after the placeholder', () => {
    expect(insertPlaceholder('Dear ,', 5, 5, 'employee_name')).toEqual({ text: 'Dear {employee_name},', caret: 20 });
  });
  it('replaces a selection', () => {
    expect(insertPlaceholder('Dear NAME,', 5, 9, 'today')).toEqual({ text: 'Dear {today},', caret: 12 });
  });
  it('accepts a backwards selection and clamps out-of-range positions', () => {
    expect(insertPlaceholder('abc', 3, 1, 'today').text).toBe('a{today}');
    expect(insertPlaceholder('abc', -4, 99, 'today').text).toBe('{today}');
    expect(insertPlaceholder('abc', 1.5, 1.5, 'today').text).toBe('a{today}bc');
  });
  it('inserts at the end of empty text', () => {
    expect(insertPlaceholder('', 0, 0, 'today')).toEqual({ text: '{today}', caret: 7 });
  });
  it('inserts every one of the seven and no other name', () => {
    for (const name of PLACEHOLDERS) expect(insertPlaceholder('x', 1, 1, name).text).toBe(`x{${name}}`);
    expect(insertPlaceholder('x', 1, 1, 'salary')).toEqual({ text: 'x', caret: 1 });
  });
  it('refuses to go over a length limit, leaving the text and caret', () => {
    expect(insertPlaceholder('abcd', 2, 2, 'today', 8)).toEqual({ text: 'abcd', caret: 2 });
    expect(insertPlaceholder('abcd', 2, 4, 'today', 9)).toEqual({ text: 'ab{today}', caret: 9 });
  });
});

describe('insertRefusal', () => {
  it('says why when the placeholder would not fit', () => {
    expect(insertRefusal('abcd', 2, 2, 'today', 8, 'title')).toBe('That would make the title longer than 8 characters.');
  });
  it('is null when it fits, or the name is not a placeholder', () => {
    expect(insertRefusal('abcd', 2, 2, 'today', 20, 'title')).toBeNull();
    expect(insertRefusal('abcd', 2, 4, 'today', 9, 'letter text')).toBeNull();
    expect(insertRefusal('abcd', 2, 2, 'salary', 3, 'title')).toBeNull();
  });
});

describe('placeholderSpot', () => {
  it('finds the first occurrence, title before body', () => {
    expect(placeholderSpot('Hi {today}', 'x {today} {today}', 'today')).toEqual({ field: 'title', start: 3, end: 10 });
    expect(placeholderSpot('Hi', 'x {today} {today}', 'today')).toEqual({ field: 'body', start: 2, end: 9 });
  });
  it('is null when absent', () => {
    expect(placeholderSpot('Hi', 'x', 'today')).toBeNull();
    expect(placeholderSpot('{salary}', '{Today}', 'today')).toBeNull();
  });
});

describe('startChoice', () => {
  it('needs an employee', () => {
    expect(startChoice({ employeeId: '', templateId: '' })).toEqual({ ok: false, error: 'Choose an employee.' });
  });
  it('is blank without a template and from-template with one', () => {
    expect(startChoice({ employeeId: EMP, templateId: '' })).toEqual({ ok: true, kind: 'blank' });
    expect(startChoice({ employeeId: EMP, templateId: 'T' })).toEqual({ ok: true, kind: 'template' });
  });
});

describe('letterFormDefaults', () => {
  it('is blank for a new letter and the row for an edit', () => {
    expect(letterFormDefaults(null)).toEqual({ letter_type: 'offer', title: '', body: '', ack_requested: false });
    expect(
      letterFormDefaults({ letter_type: 'warning', title: 'T', body: 'B', ack_requested: true }),
    ).toEqual({ letter_type: 'warning', title: 'T', body: 'B', ack_requested: true });
  });
});

describe('letterView', () => {
  const issued = visibleLetterRows(buildLettersModel([letter({ id: 'a', ack_requested: true, body: 'Line 1\n\n<b>Line 2</b>' })], VIEWERS.linkedMember, '2026-10-12'))[0];
  it('lays out workspace, date, employee, title and the body as plain text', () => {
    const view = letterView(issued, 'Acme Sdn Bhd');
    expect(view).toMatchObject({
      workspace: 'Acme Sdn Bhd',
      date_line: 'Issued 01 Oct 2026',
      employee_name: 'Aisyah Rahman',
      title: 'Offer',
      body: 'Line 1\n\n<b>Line 2</b>',
      draft: false,
      can_acknowledge: true,
    });
  });
  it('marks a draft, says it is not issued, and offers no acknowledgement', () => {
    const draft = visibleLetterRows(buildLettersModel([letter({ id: 'd', status: 'draft', issued_on: null, ack_requested: true })], VIEWERS.owner, '2026-10-12'))[0];
    const view = letterView(draft, 'Acme');
    expect(view.draft).toBe(true);
    expect(view.date_line).toBe('Not issued yet');
    expect(view.draft_note).toBe('Draft: the employee cannot see this yet.');
    expect(view.can_acknowledge).toBe(false);
  });
  it('falls back to a plain name when the workspace name is unknown', () => {
    expect(letterView(issued, '').workspace).toBe('Your workspace');
  });
});

/** Every local module an entry reaches, with its source; stops at the shared action module. */
function reachable(entry: string): Map<string, string> {
  const seen = new Map<string, string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    const source = readFileSync(file, 'utf8');
    seen.set(file, source);
    if (file.endsWith('letter-actions.ts')) continue;
    for (const m of source.matchAll(/(?:import|export)\s[^;]*?from\s+'([^']+)'|import\s+'([^']+)'/g)) {
      const spec = m[1] ?? m[2];
      const base = spec.startsWith('@/') ? join(resolve('src'), spec.slice(2)) : spec.startsWith('.') ? resolve(dirname(file), spec) : null;
      if (!base) continue;
      const found = ['.ts', '.tsx', '/index.ts', '/index.tsx'].map((e) => base + e).find((p) => existsSync(p));
      if (found) queue.push(found);
    }
  }
  return seen;
}

const ownerOnly = readFileSync(resolve('src/app/(app)/people/letter-actions.ts'), 'utf8')
  .split('export async function ')
  .slice(1)
  .filter((chunk) => chunk.includes('asAdmin('))
  .map((chunk) => chunk.slice(0, chunk.indexOf('(')));

describe('the member side of Letters names no owner-only action', () => {
  it('finds the owner-only actions, and not the acknowledgement', () => {
    expect(ownerOnly).toEqual(expect.arrayContaining(['saveLetterAction', 'issueLetterAction', 'deleteLetterAction', 'saveLetterTemplateAction']));
    expect(ownerOnly).not.toContain('acknowledgeLetterAction');
  });
  for (const entry of ['src/components/people/letter-view.tsx', 'src/components/people/letter-ack-button.tsx']) {
    const graph = reachable(resolve(entry));
    it(`${entry} reaches a real set of modules`, () => {
      expect(graph.size).toBeGreaterThan(1);
    });
    it(`${entry} imports no owner component or write path and names no owner-only action`, () => {
      for (const [file, source] of graph) {
        if (file.endsWith('letter-actions.ts')) continue;
        expect(file, file).not.toMatch(/letter-form|letter-row-controls|template-form|templates-section|letter-writes/);
        for (const name of ownerOnly) expect(source, `${file} names ${name}`).not.toContain(name);
      }
    });
  }
  it('the letter acknowledge button is the one shared AcknowledgeButton with kind letter, and imports no action itself', () => {
    const source = readFileSync(resolve('src/components/people/letter-ack-button.tsx'), 'utf8');
    expect(source).toMatch(/import \{ AcknowledgeButton \} from '\.\/acknowledge-button'/);
    expect(source).toMatch(/<AcknowledgeButton[^>]*kind="letter"/);
    expect(source).not.toMatch(/-actions'/);
  });
  it('the shared button imports exactly the two own acknowledgement actions, shows Acknowledged at once and puts the button back on a refusal', () => {
    const source = readFileSync(resolve('src/components/people/acknowledge-button.tsx'), 'utf8');
    const named = [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'[^']*(?:document|letter)-actions'/g)].flatMap((m) =>
      m[1].split(',').map((s) => s.trim()).filter(Boolean),
    );
    expect([...named].sort()).toEqual(['acknowledgeDocumentAction', 'acknowledgeLetterAction']);
    expect(source).toContain('Acknowledged');
    expect(source).toContain('setDone(false)');
  });
  it('nothing on the letter screens calls an acknowledgement a signature, except to say it is not one', () => {
    for (const file of ['letter-view', 'letter-ack-button', 'letter-form', 'letter-row-controls', 'template-form', 'templates-section']) {
      const path = resolve(`src/components/people/${file}.tsx`);
      if (!existsSync(path)) continue;
      expect(readFileSync(path, 'utf8').replace(ACK_LINE, ''), file).not.toMatch(/signature|signed/i);
    }
  });
});
