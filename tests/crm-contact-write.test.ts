import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  CrmContactFormError,
  deleteCrmContact,
  mapCrmContact,
  MAX_TAG_LENGTH,
  MAX_TAGS,
  parseCrmContactFields,
  parseTags,
  readContactId,
  updateCrmContact,
  type CrmContactFields,
} from '@/lib/crm/contacts';

const CONTACT_ID = '3f2b8c1e-6a4d-4e2b-9c1f-0a1b2c3d4e5f';

const FIELDS: CrmContactFields = {
  first_name: 'Aisyah',
  last_name: 'Rahim',
  email: 'aisyah@example.com',
  phone: null,
  company: 'Rimba Ventures',
  country: 'MY',
  status: 'customer',
  lead_score: 80,
  tags: ['VIP', 'Wholesale buyer'],
};

/** A `crm_contacts` row with every nullable column empty. */
const ROW = {
  id: CONTACT_ID,
  email: 'aisyah@example.com',
  company: null,
  first_name: 'Aisyah',
  last_name: null,
  phone: null,
  country: null,
  status: 'lead',
  lead_score: 72,
  owner_user_id: null,
  last_interaction_at: null,
  tags: null,
};

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

/** A `crm_contacts` write whose final `.select('id')` resolves to `result`. */
function createWriteClient(result: { data: { id: string }[] | null; error: unknown }) {
  const query = {
    update: vi.fn(() => query),
    delete: vi.fn(() => query),
    eq: vi.fn(() => query),
    select: vi.fn(async () => result),
  };
  const from = vi.fn(() => query);
  return { client: { from } as unknown as SupabaseClient, from, query };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('edit form values on a mapped contact', () => {
  test('carries the raw column values keyed by the form field names', () => {
    const contact = mapCrmContact({
      id: CONTACT_ID,
      email: 'aisyah@example.com',
      company: null,
      first_name: 'Aisyah',
      last_name: null,
      phone: null,
      country: null,
      status: 'lead',
      lead_score: 72,
      owner_user_id: null,
      last_interaction_at: null,
      tags: null,
    });

    expect(contact.form).toEqual({
      firstName: 'Aisyah',
      lastName: '',
      email: 'aisyah@example.com',
      phone: '',
      company: '',
      country: '',
      status: 'lead',
      leadScore: '72',
      tags: '',
      // No billing customer linked.
      billingCustomerId: '',
    });
    // A row with no tags maps to an empty list, never null.
    expect(contact.tags).toEqual([]);
    // The display fields keep their labels and placeholders.
    expect(contact.company).toBe('Personal');
    expect(contact.status).toBe('New Leads');
  });

  test('carries tags as a list and as the comma-separated line the form edits', () => {
    const contact = mapCrmContact({ ...ROW, tags: ['VIP', 'Wholesale buyer'] });

    expect(contact.tags).toEqual(['VIP', 'Wholesale buyer']);
    expect(contact.form?.tags).toBe('VIP, Wholesale buyer');
    // What the edit form is prefilled with parses back to the same tags.
    expect(parseTags(contact.form?.tags ?? '')).toEqual(['VIP', 'Wholesale buyer']);
  });

  test('maps a row with an empty tags array to no tags', () => {
    const contact = mapCrmContact({ ...ROW, tags: [] });

    expect(contact.tags).toEqual([]);
    expect(contact.form?.tags).toBe('');
  });
});

describe('parseCrmContactFields', () => {
  test('returns the editable columns only', () => {
    const fields = parseCrmContactFields(
      form({
        firstName: ' Aisyah ',
        lastName: 'Rahim',
        email: 'AISYAH@example.com',
        company: 'Rimba Ventures',
        status: 'archived',
        leadScore: '140',
      }),
    );

    expect(fields).toEqual({
      first_name: 'Aisyah',
      last_name: 'Rahim',
      email: 'aisyah@example.com',
      phone: null,
      company: 'Rimba Ventures',
      country: 'MY',
      status: 'archived',
      lead_score: 100,
      tags: [],
    });
    expect(fields).not.toHaveProperty('org_id');
  });

  test('reads tags from the tags field', () => {
    const fields = parseCrmContactFields(
      form({
        firstName: 'Aisyah',
        email: 'aisyah@example.com',
        tags: '  VIP, Wholesale   buyer , vip,, ',
      }),
    );

    expect(fields.tags).toEqual(['VIP', 'Wholesale buyer']);
  });

  test('returns no tags when the tags field is blank', () => {
    const fields = parseCrmContactFields(
      form({ firstName: 'Aisyah', email: 'aisyah@example.com', tags: ' , ' }),
    );

    expect(fields.tags).toEqual([]);
  });

  test('rejects a tag that is too long', () => {
    const parse = () =>
      parseCrmContactFields(
        form({ firstName: 'Aisyah', email: 'aisyah@example.com', tags: 'x'.repeat(31) }),
      );

    expect(parse).toThrow(CrmContactFormError);
    expect(parse).toThrow('Keep each tag to 30 characters or fewer.');
  });

  test('requires a first name', () => {
    expect(() => parseCrmContactFields(form({ email: 'aisyah@example.com' }))).toThrow(
      CrmContactFormError,
    );
  });
});

describe('parseTags', () => {
  test('splits on commas and trims each tag', () => {
    expect(parseTags(' VIP ,Wholesale,  Penang ')).toEqual(['VIP', 'Wholesale', 'Penang']);
  });

  test('collapses whitespace inside a tag', () => {
    expect(parseTags('Wholesale   buyer,big\t\tspender')).toEqual([
      'Wholesale buyer',
      'big spender',
    ]);
  });

  test('drops blank entries', () => {
    expect(parseTags(',VIP,, ,Wholesale,')).toEqual(['VIP', 'Wholesale']);
  });

  test('drops repeats ignoring case and keeps the first spelling', () => {
    expect(parseTags('VIP, vip, Vip, Wholesale, WHOLESALE')).toEqual(['VIP', 'Wholesale']);
    expect(parseTags('vip, VIP')).toEqual(['vip']);
    // Repeats are compared after whitespace is collapsed.
    expect(parseTags('big spender, Big   Spender')).toEqual(['big spender']);
  });

  test('returns no tags for an empty or blank line', () => {
    expect(parseTags('')).toEqual([]);
    expect(parseTags('   ')).toEqual([]);
    expect(parseTags(' , ,')).toEqual([]);
  });

  test('rejects a tag longer than the limit', () => {
    const tooLong = 'x'.repeat(MAX_TAG_LENGTH + 1);

    expect(() => parseTags(tooLong)).toThrow(CrmContactFormError);
    expect(() => parseTags(`VIP, ${tooLong}`)).toThrow('Keep each tag to 30 characters or fewer.');
  });

  test('accepts a tag exactly at the length limit', () => {
    const longest = 'x'.repeat(MAX_TAG_LENGTH);

    expect(MAX_TAG_LENGTH).toBe(30);
    expect(parseTags(longest)).toEqual([longest]);
  });

  test('measures a tag after trimming and collapsing whitespace', () => {
    const padded = `   ${'x'.repeat(15)}     ${'y'.repeat(14)}   `;

    expect(parseTags(padded)).toEqual([`${'x'.repeat(15)} ${'y'.repeat(14)}`]);
  });

  test('rejects more tags than the limit', () => {
    const tooMany = Array.from({ length: MAX_TAGS + 1 }, (_, i) => `tag-${i}`).join(', ');

    expect(() => parseTags(tooMany)).toThrow(CrmContactFormError);
    expect(() => parseTags(tooMany)).toThrow('Use at most 10 tags per contact.');
  });

  test('accepts exactly the limit, counting repeats and blanks once', () => {
    const ten = Array.from({ length: MAX_TAGS }, (_, i) => `tag-${i}`);

    expect(MAX_TAGS).toBe(10);
    expect(parseTags(ten.join(','))).toEqual(ten);
    expect(parseTags([...ten, 'TAG-0', '', 'tag-9'].join(','))).toEqual(ten);
  });
});

describe('readContactId', () => {
  test('returns a UUID contact id', () => {
    expect(readContactId(form({ contactId: ` ${CONTACT_ID} ` }))).toBe(CONTACT_ID);
  });

  test('rejects a missing or malformed id', () => {
    expect(() => readContactId(form({}))).toThrow(CrmContactFormError);
    expect(() => readContactId(form({ contactId: 'contact-1' }))).toThrow(
      'That contact could not be found.',
    );
    expect(() => readContactId(form({ contactId: `${CONTACT_ID},org_id.neq.x` }))).toThrow(
      'That contact could not be found.',
    );
  });
});

describe('updateCrmContact', () => {
  test('writes the fields and updated_at to one contact in one org', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-10T08:30:00.000Z'));
    const { client, from, query } = createWriteClient({ data: [{ id: CONTACT_ID }], error: null });

    await expect(updateCrmContact(client, 'org-1', CONTACT_ID, FIELDS)).resolves.toBeUndefined();

    expect(from).toHaveBeenCalledWith('crm_contacts');
    expect(query.update).toHaveBeenCalledWith({
      first_name: 'Aisyah',
      last_name: 'Rahim',
      email: 'aisyah@example.com',
      phone: null,
      company: 'Rimba Ventures',
      country: 'MY',
      status: 'customer',
      lead_score: 80,
      tags: ['VIP', 'Wholesale buyer'],
      updated_at: '2026-10-10T08:30:00.000Z',
    });
    expect(query.eq).toHaveBeenCalledTimes(2);
    expect(query.eq).toHaveBeenCalledWith('id', CONTACT_ID);
    expect(query.eq).toHaveBeenCalledWith('org_id', 'org-1');
    expect(query.select).toHaveBeenCalledWith('id');
  });

  test('sends an empty tags list so clearing the field removes the tags', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-10T08:30:00.000Z'));
    const { client, query } = createWriteClient({ data: [{ id: CONTACT_ID }], error: null });

    await updateCrmContact(client, 'org-1', CONTACT_ID, { ...FIELDS, tags: [] });

    expect(query.update).toHaveBeenCalledWith({
      ...FIELDS,
      tags: [],
      updated_at: '2026-10-10T08:30:00.000Z',
    });
  });

  test('throws a form error when no row was updated', async () => {
    const { client } = createWriteClient({ data: [], error: null });

    const update = updateCrmContact(client, 'org-1', CONTACT_ID, FIELDS);

    await expect(update).rejects.toBeInstanceOf(CrmContactFormError);
    await expect(update).rejects.toThrow('That contact no longer exists.');
  });

  test('rethrows a database error', async () => {
    const failure = new Error('42501');
    const { client } = createWriteClient({ data: null, error: failure });

    await expect(updateCrmContact(client, 'org-1', CONTACT_ID, FIELDS)).rejects.toBe(failure);
  });
});

describe('deleteCrmContact', () => {
  test('deletes one contact in one org', async () => {
    const { client, from, query } = createWriteClient({ data: [{ id: CONTACT_ID }], error: null });

    await expect(deleteCrmContact(client, 'org-1', CONTACT_ID)).resolves.toBeUndefined();

    expect(from).toHaveBeenCalledWith('crm_contacts');
    expect(query.delete).toHaveBeenCalledWith();
    expect(query.eq).toHaveBeenCalledTimes(2);
    expect(query.eq).toHaveBeenCalledWith('id', CONTACT_ID);
    expect(query.eq).toHaveBeenCalledWith('org_id', 'org-1');
    expect(query.select).toHaveBeenCalledWith('id');
  });

  test('throws a form error when no row was deleted', async () => {
    const { client } = createWriteClient({ data: [], error: null });

    const removal = deleteCrmContact(client, 'org-1', CONTACT_ID);

    await expect(removal).rejects.toBeInstanceOf(CrmContactFormError);
    await expect(removal).rejects.toThrow('That contact no longer exists.');
  });

  test('rethrows a database error', async () => {
    const failure = new Error('42501');
    const { client } = createWriteClient({ data: null, error: failure });

    await expect(deleteCrmContact(client, 'org-1', CONTACT_ID)).rejects.toBe(failure);
  });
});
