// tests/hire-pool-dialog-state.test.ts
import { describe, expect, it } from 'vitest';
import {
  CHOOSE_A_JOB, NO_JOBS, PICKER_LOADING, PICKER_ROWS, REMOVE_BODY, SHORTLISTED_NOTE, addInput, addLabel, addName, addToPoolInput,
  addedLabel, boardPoolLine, boxSent, changeResult, followAddress, fromOutside, searchBox, jobOption, moveBody, moveInput, moveLabel, moveTitle, nextAddFocus, personLine,
  pickerFrom, pickerMatches, pickerOpenAfter, pickerView, removeInput, removeLabel, removeTitle, searchHref, shortlistedNote, statusChangeInput,
} from '@/lib/hire/pool-dialog-state';

const A = '11111111-1111-4111-8111-111111111111';
const J = '22222222-2222-4222-8222-222222222222';
const person = (id: string, name: string, over: Record<string, unknown> = {}) =>
  ({ id, name, headline: null, location: null, skills: [] as string[], source: null, ...over });

describe('what a change answered', () => {
  it('is a sentence on success and the refusal otherwise; anything malformed is the generic sentence', () => {
    expect(changeResult({ ok: true, data: { message: 'Added Aina to the talent pool as Available.' } }))
      .toEqual({ ok: true, message: 'Added Aina to the talent pool as Available.' });
    expect(changeResult({ ok: false, error: 'That candidate could not be found.' })).toEqual({ ok: false, error: 'That candidate could not be found.' });
    const GENERIC = { ok: false, error: 'That change could not be saved. Please try again.' };
    for (const odd of [null, undefined, 'ok', {}, { ok: true }, { ok: true, data: {} }, { ok: true, data: { message: '' } }, { ok: false }, { ok: false, error: '' }]) {
      expect(changeResult(odd)).toEqual(GENERIC);
    }
  });
});

describe('adding to the pool', () => {
  it('always sends the switch, so a person already in the pool is refused and left as they are', () => {
    expect(addInput(A, 'passive')).toEqual({ id: A, status: 'passive', only_if_outside: true });
    // From the board and the Applications panel: always as Available.
    expect(addToPoolInput(A)).toEqual({ id: A, status: 'available', only_if_outside: true });
  });
  it('names what it did and what it is doing', () => {
    expect(addedLabel('available')).toBe('Added as Available');
    expect(addedLabel('re_engaged')).toBe('Added as Re-engaged');
    expect(addName('Aina binti Salleh')).toBe('Add Aina binti Salleh to the talent pool');
    expect(addLabel(false)).toBe('Add');
    expect(addLabel(true)).toBe('Adding…');
  });
  it('says where a person stands, on the board and in the Applications panel', () => {
    expect(boardPoolLine('passive')).toBe('In the talent pool: Passive');
    expect(boardPoolLine('re_engaged')).toBe('In the talent pool: Re-engaged');
    // Not in the pool, or not known: the control offers the add instead.
    expect(boardPoolLine('none')).toBeNull();
    expect(boardPoolLine(undefined)).toBeNull();
  });
});

describe('the picker', () => {
  const people = [
    person('1', 'Zarina binti Hashim', { headline: 'Warehouse Supervisor', location: 'Klang', skills: ['Forklift'] }),
    person('2', 'Kamal Ariffin', { headline: 'Driver', skills: ['GDL', 'Forklift'] }),
    person('3', 'Suraya Jamil'),
  ];
  it('starts by loading, and fails closed on anything that is not a well-formed answer', () => {
    expect(PICKER_LOADING).toEqual({ state: 'loading' });
    const FAILED = { state: 'failed', error: 'The list could not be loaded. Check your connection and try again.' };
    for (const odd of [null, undefined, 'x', {}, { ok: true }, { ok: true, data: {} }, { ok: true, data: { people: 'no' } }, { ok: true, data: { people: [{ id: 1, name: 'x' }] } }]) {
      expect(pickerFrom(odd)).toEqual(FAILED);
    }
    expect(pickerFrom({ ok: false, error: 'You do not have permission to make changes here.' }))
      .toEqual({ state: 'failed', error: 'You do not have permission to make changes here.' });
  });
  it('keeps only the six fields of a person, whatever else rode along', () => {
    const state = pickerFrom({ ok: true, data: { people: [{ ...people[0], email: 'z@example.com', phone: '012' }], capped: true } });
    expect(state).toEqual({ state: 'ready', people: [people[0]], capped: true });
    expect(pickerFrom({ ok: true, data: { people: [] } })).toEqual({ state: 'ready', people: [], capped: false });
  });
  it('narrows by any part of the name, the headline or a skill, in any letter case', () => {
    expect(pickerMatches(people, 'ZARINA').map((p) => p.id)).toEqual(['1']);
    expect(pickerMatches(people, 'driver').map((p) => p.id)).toEqual(['2']);
    expect(pickerMatches(people, 'forklift').map((p) => p.id)).toEqual(['1', '2']);
    expect(pickerMatches(people, '  ').map((p) => p.id)).toEqual(['1', '2', '3']);
    // The picker does not search by place: that is the pool table's search.
    expect(pickerMatches(people, 'klang')).toEqual([]);
  });
  it('draws at most 50 rows and says how many there are', () => {
    const many = Array.from({ length: 312 }, (_, i) => person(String(i), `Person ${i}`));
    expect(PICKER_ROWS).toBe(50);
    expect(pickerView(many, '')).toMatchObject({ line: 'Showing 50 of 312. Type to narrow the list.', empty: null });
    expect(pickerView(many, '').rows).toHaveLength(50);
    expect(pickerView(many.slice(0, 50), '')).toMatchObject({ line: null, empty: null });
    expect(pickerView(many, 'person 31').rows.map((p) => p.name)).toEqual(['Person 31', 'Person 310', 'Person 311']);
  });
  it('says so when there is nobody to add, and when nobody matches', () => {
    expect(pickerView([], '')).toEqual({ rows: [], line: null, empty: 'Everyone on file is already in the talent pool.' });
    expect(pickerView(people, ' nobody ')).toEqual({ rows: [], line: null, empty: 'No one matches “nobody”.' });
  });
  it('puts headline and place on one line', () => {
    expect(personLine(people[0])).toBe('Warehouse Supervisor · Klang');
    expect(personLine(people[1])).toBe('Driver');
    expect(personLine(people[2])).toBe('');
  });
  it('stays open while an add is being saved, whatever asked it to close, and closes again once the add has settled', () => {
    // Escape, Done and a click outside all ask the same thing: open = false.
    expect(pickerOpenAfter(false, true)).toBe(true);
    expect(pickerOpenAfter(false, false)).toBe(false);
    // Opening is never held back.
    expect(pickerOpenAfter(true, false)).toBe(true);
    expect(pickerOpenAfter(true, true)).toBe(true);
  });
  it('after an add, focus goes to the next row still to be added, or to the search field (null)', () => {
    expect(nextAddFocus(people, {}, '1')).toBe('2');
    expect(nextAddFocus(people, { 2: 'available' }, '1')).toBe('3');
    expect(nextAddFocus(people, {}, '3')).toBeNull();
    expect(nextAddFocus(people, { 2: 'available', 3: 'passive' }, '1')).toBeNull();
    expect(nextAddFocus(people, {}, 'gone')).toBeNull();
  });
});

describe('the row menu', () => {
  it('sends nothing for the status the person already has, or for a word that is not a status', () => {
    expect(statusChangeInput(A, 'passive', 'passive')).toBeNull();
    expect(statusChangeInput(A, 'passive', 'none')).toBeNull();
    expect(statusChangeInput(A, 'passive', 'shortlisted')).toBeNull();
    expect(statusChangeInput(A, 'passive', '')).toBeNull();
  });
  it('sends a change without the add switch: the person is already in the pool', () => {
    expect(statusChangeInput(A, 'passive', 're_engaged')).toEqual({ id: A, status: 're_engaged' });
    expect(statusChangeInput(A, 'available', 'passive')).toEqual({ id: A, status: 'passive' });
  });
  it('explains the label only on a row shown as Shortlisted', () => {
    expect(shortlistedNote('Shortlisted')).toBe('Shown as Shortlisted while they have a live application at Interview or beyond.');
    expect(SHORTLISTED_NOTE).toBe(shortlistedNote('Shortlisted'));
    for (const label of ['Available', 'Passive', 'Re-engaged']) expect(shortlistedNote(label)).toBeNull();
  });
  it('removes by setting the status to none, and says what stays', () => {
    expect(removeInput(A)).toEqual({ id: A, status: 'none' });
    expect(removeTitle('Aina binti Salleh')).toBe('Remove Aina binti Salleh from the talent pool?');
    expect(REMOVE_BODY).toBe('They stay on file with their details and applications. You can add them back with Add to Pool.');
    expect(removeLabel(false)).toBe('Remove from pool');
    expect(removeLabel(true)).toBe('Removing…');
  });
});

describe('move to pipeline', () => {
  const jobs = [{ id: J, title: 'Sales Executive', status: 'paused' as const }, { id: 'j2', title: 'Barista', status: 'open' as const }];
  it('words the dialog', () => {
    expect(moveTitle('Aina binti Salleh')).toBe('Move Aina binti Salleh to pipeline');
    expect(moveBody('Aina binti Salleh')).toBe('Aina binti Salleh gets a new application at Applied and is marked Re-engaged. They stay in the talent pool.');
    expect(jobOption(jobs[0])).toBe('Sales Executive (paused)');
    expect(jobOption(jobs[1])).toBe('Barista');
    expect(CHOOSE_A_JOB).toBe('Choose a job.');
    expect(NO_JOBS).toBe('There are no open or paused jobs. Open a job first.');
    expect(moveLabel(false)).toBe('Move to pipeline');
    expect(moveLabel(true)).toBe('Moving…');
  });
  it('sends nothing until a job from the list is chosen', () => {
    expect(moveInput(A, '', jobs)).toBeNull();
    expect(moveInput(A, 'not-in-the-list', jobs)).toBeNull();
    expect(moveInput(A, J, [])).toBeNull();
    expect(moveInput(A, J, jobs)).toEqual({ id: A, job_id: J });
  });
});

describe('the search box\'s address', () => {
  it('puts the text in q, trimmed and cut to 80, and drops q when there is nothing to search for', () => {
    expect(searchHref('/hire/talent-pool', ' aina ')).toBe('/hire/talent-pool?q=aina');
    expect(searchHref('/hire/talent-pool', 'nur aina & co')).toBe('/hire/talent-pool?q=nur%20aina%20%26%20co');
    expect(searchHref('/hire/talent-pool', '')).toBe('/hire/talent-pool');
    expect(searchHref('/hire/talent-pool', '   ')).toBe('/hire/talent-pool');
    expect(searchHref('/hire/talent-pool', 'x'.repeat(200))).toBe(`/hire/talent-pool?q=${'x'.repeat(80)}`);
  });
});

describe('the search box\'s text follows the address, but never fights the typing', () => {
  it('starts with what the address searches for', () => {
    expect(searchBox('aina')).toEqual({ text: 'aina', sent: ['aina'] });
    expect(searchBox(null)).toEqual({ text: '', sent: [null] });
  });
  it('typing in progress: nothing was sent yet and the address has not moved, so the text is left alone', () => {
    const typing = { text: 'ai', sent: [null] };
    expect(fromOutside(typing.sent, null)).toBe(false);
    expect(followAddress(typing, null)).toEqual(typing);
    // The page is drawn again for another reason (a pool change) with the same address: still left alone.
    expect(followAddress({ text: 'zar', sent: ['aina'] }, 'aina')).toEqual({ text: 'zar', sent: ['aina'] });
  });
  it('the address catching up with what was typed keeps the text as typed, spaces and all', () => {
    const sent = boxSent({ text: 'aina ', sent: [null] }, 'aina ');
    expect(sent).toEqual({ text: 'aina ', sent: [null, 'aina'] });
    // Before the server has answered, the address is still the old one.
    expect(followAddress(sent, null)).toEqual(sent);
    // The answer: the address is what the box asked for.
    expect(followAddress(sent, 'aina')).toEqual({ text: 'aina ', sent: ['aina'] });
  });
  it('an earlier answer arriving while more has been typed and sent does not pull the text back', () => {
    const box = { text: 'aina', sent: [null, 'ai', 'ain'] };
    expect(followAddress(box, 'ai')).toEqual({ text: 'aina', sent: ['ai', 'ain'] });
    expect(followAddress({ text: 'aina', sent: ['ai', 'ain'] }, 'ain')).toEqual({ text: 'aina', sent: ['ain'] });
    // An answer that was skipped (a later search replaced it) is fine too.
    expect(followAddress(box, 'ain')).toEqual({ text: 'aina', sent: ['ain'] });
  });
  it('a nav link to the page with no query empties the box', () => {
    const box = { text: 'aina', sent: ['aina'] };
    expect(fromOutside(box.sent, null)).toBe(true);
    expect(followAddress(box, null)).toEqual({ text: '', sent: [null] });
  });
  it('Back or Forward to another query shows that query', () => {
    expect(followAddress({ text: '', sent: [null] }, 'zarina')).toEqual({ text: 'zarina', sent: ['zarina'] });
    expect(followAddress({ text: 'aina', sent: ['aina'] }, 'zarina')).toEqual({ text: 'zarina', sent: ['zarina'] });
  });
  it('Clear search: the box empties at once and stays empty when the address catches up', () => {
    const cleared = boxSent({ text: '', sent: ['aina'] }, '');
    expect(cleared).toEqual({ text: '', sent: ['aina', null] });
    expect(followAddress(cleared, 'aina')).toEqual(cleared);
    expect(followAddress(cleared, null)).toEqual({ text: '', sent: [null] });
  });
  it('what the box sent is recorded as the address will show it: trimmed, cut to 80, blank as no search', () => {
    expect(boxSent({ text: '   ', sent: ['aina'] }, '   ').sent).toEqual(['aina', null]);
    expect(boxSent({ text: 'x', sent: [null] }, 'x'.repeat(200)).sent).toEqual([null, 'x'.repeat(80)]);
  });
});
