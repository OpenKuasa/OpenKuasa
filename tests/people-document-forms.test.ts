import { describe, expect, it } from 'vitest';
import {
  EXPIRY_WINDOW_DAYS,
  expiryState,
  toDocumentInput,
  toLetterInput,
  toTemplateInput,
} from '@/lib/people/document-forms';
import { DOCUMENT_TYPES, EMPLOYEE_DOCUMENT_TYPES, LETTER_TYPES } from '@/lib/people/types';

const TODAY = '2026-10-12';

describe('expiryState', () => {
  it('is none without a date', () => {
    expect(expiryState(null, TODAY)).toBe('none');
  });
  it('is expired the day after, and any time before', () => {
    expect(expiryState('2026-10-11', TODAY)).toBe('expired');
    expect(expiryState('2000-01-01', TODAY)).toBe('expired');
  });
  it('is expiring on the day itself', () => {
    expect(expiryState(TODAY, TODAY)).toBe('expiring');
  });
  it('is expiring on day 90 and not on day 91', () => {
    expect(EXPIRY_WINDOW_DAYS).toBe(90);
    expect(expiryState('2027-01-10', TODAY)).toBe('expiring'); // +90
    expect(expiryState('2027-01-11', TODAY)).toBe('none'); // +91
  });
  it('crosses a year end and a leap day correctly', () => {
    expect(expiryState('2028-02-29', '2027-12-01')).toBe('expiring'); // +90 over a leap day
    expect(expiryState('2028-03-01', '2027-12-01')).toBe('none'); // +91
    expect(expiryState('2027-12-31', '2027-10-02')).toBe('expiring'); // +90
    expect(expiryState('2028-01-01', '2027-10-02')).toBe('none'); // +91
    expect(expiryState('2028-02-29', '2028-02-28')).toBe('expiring');
  });
});

describe('toDocumentInput', () => {
  const ok = { title: ' Passport ', doc_type: 'identity', expires_on: '2030-01-31' };

  it('trims the title and keeps a real date', () => {
    expect(toDocumentInput(ok, EMPLOYEE_DOCUMENT_TYPES)).toEqual({
      ok: true,
      input: { title: 'Passport', doc_type: 'identity', expires_on: '2030-01-31' },
    });
  });
  it('turns an empty expiry into none', () => {
    expect(toDocumentInput({ ...ok, expires_on: '  ' }, EMPLOYEE_DOCUMENT_TYPES)).toMatchObject({
      ok: true,
      input: { expires_on: null },
    });
  });
  it('asks for a title, and not a long one', () => {
    expect(toDocumentInput({ ...ok, title: '   ' }, DOCUMENT_TYPES)).toEqual({ ok: false, error: 'Give the document a title.' });
    expect(toDocumentInput({ ...ok, title: 'x'.repeat(201) }, DOCUMENT_TYPES)).toEqual({
      ok: false,
      error: 'Keep the title to 200 characters.',
    });
    expect(toDocumentInput({ ...ok, title: 'x'.repeat(200) }, DOCUMENT_TYPES).ok).toBe(true);
  });
  it('refuses a type outside the allowed list, so an employee cannot choose the other three', () => {
    for (const type of ['contract', 'tax', 'benefits']) {
      expect(toDocumentInput({ ...ok, doc_type: type }, EMPLOYEE_DOCUMENT_TYPES)).toEqual({
        ok: false,
        error: 'Choose a type from the list.',
      });
      expect(toDocumentInput({ ...ok, doc_type: type }, DOCUMENT_TYPES).ok).toBe(true);
    }
    expect(toDocumentInput({ ...ok, doc_type: 'payslip' }, DOCUMENT_TYPES).ok).toBe(false);
    expect(toDocumentInput({ ...ok, doc_type: '' }, DOCUMENT_TYPES).ok).toBe(false);
  });
  it('refuses an expiry that is not a real date or is outside 2000 to 2100', () => {
    const sentence = 'Enter a real expiry date between 2000 and 2100, or leave it empty.';
    for (const bad of ['2026-02-30', 'soon', '31/12/2030', '1999-12-31', '2101-01-01']) {
      expect(toDocumentInput({ ...ok, expires_on: bad }, DOCUMENT_TYPES)).toEqual({ ok: false, error: sentence });
    }
    expect(toDocumentInput({ ...ok, expires_on: '2000-01-01' }, DOCUMENT_TYPES).ok).toBe(true);
    expect(toDocumentInput({ ...ok, expires_on: '2100-12-31' }, DOCUMENT_TYPES).ok).toBe(true);
  });
});

describe('toLetterInput', () => {
  const ok = { letter_type: 'offer', title: ' Offer ', body: '  Dear Farah,\n\nWelcome.  ', ack_requested: true };

  it('trims the title and keeps the body exactly as typed', () => {
    expect(toLetterInput(ok)).toEqual({
      ok: true,
      input: { letter_type: 'offer', title: 'Offer', body: '  Dear Farah,\n\nWelcome.  ', ack_requested: true },
    });
  });
  it('accepts an empty body for a draft', () => {
    expect(toLetterInput({ ...ok, body: '' })).toMatchObject({ ok: true, input: { body: '' } });
  });
  it('reads anything but true as not asking', () => {
    expect(toLetterInput({ ...ok, ack_requested: false })).toMatchObject({ input: { ack_requested: false } });
  });
  it('refuses a missing or long title, a long body and an unknown type', () => {
    expect(toLetterInput({ ...ok, title: ' ' })).toEqual({ ok: false, error: 'Give the letter a title.' });
    expect(toLetterInput({ ...ok, title: 'x'.repeat(201) })).toEqual({ ok: false, error: 'Keep the title to 200 characters.' });
    expect(toLetterInput({ ...ok, body: 'x'.repeat(10001) })).toEqual({ ok: false, error: 'Keep the letter to 10,000 characters.' });
    expect(toLetterInput({ ...ok, body: 'x'.repeat(10000) }).ok).toBe(true);
    expect(toLetterInput({ ...ok, letter_type: 'memo' })).toEqual({ ok: false, error: 'Choose a type from the list.' });
    for (const type of LETTER_TYPES) expect(toLetterInput({ ...ok, letter_type: type }).ok).toBe(true);
  });
});

describe('toTemplateInput', () => {
  const ok = { name: ' Offer ', letter_type: 'offer', title: ' Offer for {employee_name} ', body: 'Dear {employee_name}', lang: 'ms' };

  it('trims the name and title, keeps the body, and keeps placeholders', () => {
    expect(toTemplateInput(ok)).toEqual({
      ok: true,
      input: { name: 'Offer', letter_type: 'offer', title: 'Offer for {employee_name}', body: 'Dear {employee_name}', lang: 'ms' },
    });
    expect(toTemplateInput({ ...ok, lang: 'en' })).toMatchObject({ ok: true, input: { lang: 'en' } });
  });
  it('refuses a language that is not one of the two', () => {
    for (const lang of ['', 'fr', 'MS', 'english']) expect(toTemplateInput({ ...ok, lang })).toEqual({ ok: false, error: 'Choose a language from the list.' });
  });
  it('refuses a missing or long name, a missing or long title, and a long body', () => {
    expect(toTemplateInput({ ...ok, name: '' })).toEqual({ ok: false, error: 'Give the template a name.' });
    expect(toTemplateInput({ ...ok, name: 'x'.repeat(121) })).toEqual({ ok: false, error: 'Keep the name to 120 characters.' });
    expect(toTemplateInput({ ...ok, title: '' })).toEqual({ ok: false, error: 'Give the template a title.' });
    expect(toTemplateInput({ ...ok, title: 'x'.repeat(201) })).toEqual({ ok: false, error: 'Keep the title to 200 characters.' });
    expect(toTemplateInput({ ...ok, body: 'x'.repeat(10001) })).toEqual({ ok: false, error: 'Keep the letter to 10,000 characters.' });
    expect(toTemplateInput({ ...ok, letter_type: 'nope' })).toEqual({ ok: false, error: 'Choose a type from the list.' });
  });
});
