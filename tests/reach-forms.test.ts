import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FORM_CATEGORIES,
  DEFAULT_FORM_CONSENT,
  FORM_MESSAGES,
  NO_FORM_FILTERS,
  filterForms,
  formCategoriesInUse,
  formCategorySuggestions,
  formKpis,
  formatFormDate,
  hasFormFilters,
  isValidFormSlug,
  normalizeFormSlug,
  parseFormFields,
  resolveFormSlug,
  slugifyFormName,
} from '@/lib/reach/forms';
import { seedForms } from '@/lib/reach/seed';

describe('slugifyFormName', () => {
  it('lower-cases and joins words with hyphens', () => {
    expect(slugifyFormName('Raya Promo Signup')).toBe('raya-promo-signup');
  });
  it('drops punctuation, accents and stray hyphens', () => {
    expect(slugifyFormName('  Café — Grand Opening!! ')).toBe('cafe-grand-opening');
    expect(slugifyFormName('eBook: SME_Growth (2026)')).toBe('ebook-sme-growth-2026');
  });
  it('keeps to 60 characters without ending on a hyphen', () => {
    const slug = slugifyFormName(`${'a'.repeat(59)} b c`);
    expect(slug).toBe('a'.repeat(59));
    expect(slugifyFormName('x'.repeat(200))).toHaveLength(60);
  });
  it('returns nothing when the name has no letters or digits', () => {
    expect(slugifyFormName('!!!')).toBe('');
    expect(slugifyFormName('')).toBe('');
  });
});

describe('slug rules', () => {
  it('strips one leading slash and the spaces around it', () => {
    expect(normalizeFormSlug(' /raya-promo ')).toBe('raya-promo');
    expect(normalizeFormSlug('raya-promo')).toBe('raya-promo');
    expect(normalizeFormSlug(undefined)).toBe('');
    expect(normalizeFormSlug('//raya')).toBe('/raya');
  });
  it('accepts lower-case letters, digits and hyphens, 2 to 60 long', () => {
    expect(isValidFormSlug('raya-promo')).toBe(true);
    expect(isValidFormSlug('a1')).toBe(true);
    expect(isValidFormSlug('a'.repeat(60))).toBe(true);
    expect(isValidFormSlug('a')).toBe(false);
    expect(isValidFormSlug('a'.repeat(61))).toBe(false);
    expect(isValidFormSlug('Raya-Promo')).toBe(false);
    expect(isValidFormSlug('raya promo')).toBe(false);
    expect(isValidFormSlug('raya_promo')).toBe(false);
    expect(isValidFormSlug('/raya')).toBe(false);
  });
  it('uses the typed link, or derives one from the name when it is empty', () => {
    expect(resolveFormSlug('/free-consult', 'Anything')).toEqual({ ok: true, slug: 'free-consult' });
    expect(resolveFormSlug('', 'Raya Promo')).toEqual({ ok: true, slug: 'raya-promo' });
    expect(resolveFormSlug('   ', 'Raya Promo')).toEqual({ ok: true, slug: 'raya-promo' });
    expect(resolveFormSlug(undefined, 'Raya Promo')).toEqual({ ok: true, slug: 'raya-promo' });
  });
  it('does not quietly repair a link the person typed wrongly', () => {
    expect(resolveFormSlug('Raya Promo', 'Raya Promo')).toEqual({ ok: false, error: FORM_MESSAGES.slug });
    expect(resolveFormSlug('/', 'Raya Promo')).toEqual({ ok: true, slug: 'raya-promo' });
  });
  it('says so when neither the link nor the name gives a usable link', () => {
    expect(resolveFormSlug('', '!!!')).toEqual({ ok: false, error: FORM_MESSAGES.slug });
    expect(resolveFormSlug('', 'X')).toEqual({ ok: false, error: FORM_MESSAGES.slug });
    expect(resolveFormSlug('', undefined)).toEqual({ ok: false, error: FORM_MESSAGES.slug });
  });
});

describe('parseFormFields', () => {
  const typed = {
    name: ' Raya Promo ',
    category: ' Promotions ',
    slug: '/raya-promo',
    status: 'active',
    consent_text: `  ${DEFAULT_FORM_CONSENT}\n`,
  };

  it('shapes what was typed for the actions', () => {
    expect(parseFormFields(typed)).toEqual({
      ok: true,
      input: {
        name: 'Raya Promo',
        category: 'Promotions',
        slug: 'raya-promo',
        status: 'active',
        consent_text: DEFAULT_FORM_CONSENT,
      },
    });
  });
  it('asks for a consent sentence of 1 to 300 characters, counted as the database counts them', () => {
    expect(parseFormFields({ ...typed, consent_text: ' \n\t ' })).toEqual({ ok: false, error: FORM_MESSAGES.consent });
    expect(parseFormFields({ ...typed, consent_text: 'c'.repeat(301) })).toEqual({ ok: false, error: FORM_MESSAGES.consentTooLong });
    expect(parseFormFields({ ...typed, consent_text: ` ${'c'.repeat(300)} ` })).toMatchObject({ ok: true, input: { consent_text: 'c'.repeat(300) } });
    // One emoji is one character, as in Postgres, not two UTF-16 units.
    expect(parseFormFields({ ...typed, consent_text: '😀'.repeat(300) })).toMatchObject({ ok: true });
    expect(parseFormFields({ ...typed, consent_text: '😀'.repeat(301) })).toEqual({ ok: false, error: FORM_MESSAGES.consentTooLong });
  });
  it('asks for a name first', () => {
    expect(parseFormFields({ ...typed, name: '   ' })).toEqual({ ok: false, error: 'Enter a name for the form.' });
  });
  it('derives the link from the name when the link is empty', () => {
    const parsed = parseFormFields({ ...typed, slug: '' });
    expect(parsed).toMatchObject({ ok: true, input: { slug: 'raya-promo' } });
  });
  it('explains a link that is not allowed', () => {
    expect(parseFormFields({ ...typed, slug: 'Raya Promo!' })).toEqual({
      ok: false,
      error: 'Use only lower-case letters, numbers and hyphens in the short name, such as raya-promo.',
    });
  });
  it('stores an empty category as none', () => {
    expect(parseFormFields({ ...typed, category: '  ' })).toMatchObject({ ok: true, input: { category: null } });
  });
  it('rejects a long name, a long category and an unknown status', () => {
    expect(parseFormFields({ ...typed, name: 'n'.repeat(121) })).toEqual({ ok: false, error: FORM_MESSAGES.nameTooLong });
    expect(parseFormFields({ ...typed, category: 'c'.repeat(61) })).toEqual({ ok: false, error: FORM_MESSAGES.categoryTooLong });
    expect(parseFormFields({ ...typed, status: 'archived' })).toEqual({ ok: false, error: FORM_MESSAGES.status });
  });
});

describe('categories', () => {
  const forms = [{ category: 'Sales' }, { category: 'sales' }, { category: ' Content ' }, { category: null }, { category: '' }];

  it('lists the categories in use once each, A to Z', () => {
    expect(formCategoriesInUse(forms)).toEqual(['Content', 'Sales']);
    expect(formCategoriesInUse([])).toEqual([]);
  });
  it('suggests the ones in use, then the defaults not already there', () => {
    expect(formCategorySuggestions(forms)).toEqual(['Content', 'Sales', 'Promotions', 'Marketing', 'Support', 'Events']);
    expect(formCategorySuggestions([])).toEqual([...DEFAULT_FORM_CATEGORIES]);
  });
});

describe('filterForms', () => {
  const forms = seedForms();

  it('returns everything, in order, with no filters', () => {
    expect(filterForms(forms, NO_FORM_FILTERS)).toEqual(forms);
    expect(hasFormFilters(NO_FORM_FILTERS)).toBe(false);
    expect(hasFormFilters({ ...NO_FORM_FILTERS, query: '  ' })).toBe(false);
    expect(hasFormFilters({ ...NO_FORM_FILTERS, status: 'draft' })).toBe(true);
  });
  it('searches the name, ignoring case', () => {
    expect(filterForms(forms, { ...NO_FORM_FILTERS, query: 'NEWS' }).map((f) => f.name)).toEqual(['Newsletter']);
  });
  it('searches the link, with or without its leading slash', () => {
    expect(filterForms(forms, { ...NO_FORM_FILTERS, query: 'usahawan' }).map((f) => f.name)).toEqual(['Event RSVP']);
    expect(filterForms(forms, { ...NO_FORM_FILTERS, query: '/free-consult' }).map((f) => f.name)).toEqual(['Free Consultation']);
  });
  it('filters by category and by status', () => {
    expect(filterForms(forms, { ...NO_FORM_FILTERS, category: 'sales' }).map((f) => f.name)).toEqual([
      'Free Consultation',
      'Product Demo Request',
    ]);
    expect(filterForms(forms, { ...NO_FORM_FILTERS, status: 'draft' }).map((f) => f.name)).toEqual([
      'eBook Download',
      'Event RSVP',
    ]);
    expect(filterForms(forms, { ...NO_FORM_FILTERS, status: 'paused' })).toEqual([]);
  });
  it('combines the filters', () => {
    expect(filterForms(forms, { query: 'demo', category: 'Sales', status: 'active' }).map((f) => f.slug)).toEqual(['demo-request']);
    expect(filterForms(forms, { query: 'demo', category: 'Events', status: 'active' })).toEqual([]);
  });
});

describe('formKpis', () => {
  it('matches the sample screen: 6 forms, 428 leads, 18% conversion', () => {
    expect(formKpis(seedForms())).toEqual({
      total_forms: 6,
      total_views: 2378,
      total_leads: 428,
      conversion_pct: 18,
      conversion: '18%',
    });
  });
  it('shows a dash for conversion when nothing has been viewed', () => {
    const fresh = [{ views_count: 0, submissions_count: 0 }, { views_count: 0, submissions_count: 0 }];
    expect(formKpis(fresh)).toMatchObject({ total_forms: 2, total_leads: 0, conversion_pct: null, conversion: '—' });
    expect(formKpis([])).toMatchObject({ total_forms: 0, total_leads: 0, conversion: '—' });
  });
  it('rounds conversion to one decimal place', () => {
    expect(formKpis([{ views_count: 222, submissions_count: 10 }]).conversion).toBe('4.5%');
  });
});

describe('formatFormDate', () => {
  it('formats in Malaysian time', () => {
    expect(formatFormDate('2026-03-12T04:00:00.000Z')).toBe('12 Mar 2026');
    // 17:30 UTC is already the next day in Kuala Lumpur.
    expect(formatFormDate('2026-03-12T17:30:00.000Z')).toBe('13 Mar 2026');
  });
  it('shows a dash for a date it cannot read', () => {
    expect(formatFormDate('not a date')).toBe('—');
  });
});
