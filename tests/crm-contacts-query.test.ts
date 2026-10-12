import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, test, vi } from 'vitest';
import { listCrmContacts } from '@/lib/crm/contacts';

type Result = { data: unknown[] | null; count?: number | null; error: unknown };

function createClient(contacts: Result, profiles: Result = { data: [], error: null }) {
  const contactsQuery = {
    select: vi.fn(() => contactsQuery),
    eq: vi.fn(() => contactsQuery),
    order: vi.fn(() => contactsQuery),
    limit: vi.fn(async () => contacts),
  };
  const profilesQuery = {
    select: vi.fn(() => profilesQuery),
    in: vi.fn(async () => profiles),
  };
  const from = vi.fn((table: string) => (table === 'profiles' ? profilesQuery : contactsQuery));
  return { client: { from } as unknown as SupabaseClient, from, contactsQuery, profilesQuery };
}

const ROW = {
  id: 'contact-1',
  email: 'aisyah@example.com',
  company: 'Rimba Ventures Sdn Bhd',
  first_name: 'Aisyah',
  last_name: 'Rahim',
  phone: '+60123456789',
  country: 'MY',
  status: 'qualified',
  lead_score: 92,
  owner_user_id: 'user-1',
  last_interaction_at: '2026-10-09T10:00:00.000Z',
  tags: ['VIP', 'Wholesale buyer'],
};

describe('listCrmContacts', () => {
  test('reads contacts for one org and maps database rows to the screen model', async () => {
    const { client, from, contactsQuery, profilesQuery } = createClient(
      { data: [ROW], count: 8, error: null },
      {
        data: [{ user_id: 'user-1', full_name: 'Faiz Hakim', email: 'faiz@example.com' }],
        error: null,
      },
    );

    const result = await listCrmContacts(client, 'org-1', 25);

    expect(from).toHaveBeenCalledWith('crm_contacts');
    // Exactly the columns of crm_contacts in the Kasturi schema migration.
    expect(contactsQuery.select).toHaveBeenCalledWith(
      'id,email,company,first_name,last_name,phone,country,status,lead_score,owner_user_id,last_interaction_at,tags,finance_customer_id',
      { count: 'exact' },
    );
    expect(contactsQuery.eq).toHaveBeenCalledWith('org_id', 'org-1');
    expect(contactsQuery.order).toHaveBeenCalledWith('created_at', { ascending: false });
    expect(contactsQuery.limit).toHaveBeenCalledWith(25);
    expect(from).toHaveBeenCalledWith('profiles');
    expect(profilesQuery.select).toHaveBeenCalledWith('user_id,full_name,email');
    expect(profilesQuery.in).toHaveBeenCalledWith('user_id', ['user-1']);
    expect(result).toEqual({
      total: 8,
      contacts: [
        {
          id: 'contact-1',
          email: 'aisyah@example.com',
          company: 'Rimba Ventures Sdn Bhd',
          first: 'Aisyah',
          last: 'Rahim',
          phone: '+60123456789',
          country: 'MY',
          status: 'Qualified',
          score: 92,
          pic: 'Faiz Hakim',
          lastInteraction: '9 Oct 2026',
          tags: ['VIP', 'Wholesale buyer'],
          form: {
            firstName: 'Aisyah',
            lastName: 'Rahim',
            email: 'aisyah@example.com',
            phone: '+60123456789',
            company: 'Rimba Ventures Sdn Bhd',
            country: 'MY',
            status: 'qualified',
            leadScore: '92',
            tags: 'VIP, Wholesale buyer',
            billingCustomerId: '',
          },
        },
      ],
    });
  });

  test('labels a new lead the way the screen does and leaves an unowned contact blank', async () => {
    const { client, from } = createClient({
      data: [
        { ...ROW, status: 'lead', owner_user_id: null, last_interaction_at: null, country: null },
      ],
      count: 1,
      error: null,
    });

    const { contacts } = await listCrmContacts(client, 'org-1');

    expect(contacts[0]).toMatchObject({
      status: 'New Leads',
      pic: null,
      lastInteraction: null,
      country: '—',
    });
    expect(from).not.toHaveBeenCalledWith('profiles');
  });

  test('lists a contact whose tags column is null with no tags', async () => {
    const { client } = createClient({ data: [{ ...ROW, tags: null }], count: 1, error: null });

    const { contacts } = await listCrmContacts(client, 'org-1');

    expect(contacts[0].tags).toEqual([]);
    expect(contacts[0].form?.tags).toBe('');
  });

  test('shows the full name of the person in charge, trimmed, ahead of the email', async () => {
    const { client } = createClient(
      { data: [ROW], count: 1, error: null },
      {
        data: [{ user_id: 'user-1', full_name: '  Faiz Hakim ', email: 'faiz@example.com' }],
        error: null,
      },
    );

    const { contacts } = await listCrmContacts(client, 'org-1');

    expect(contacts[0].pic).toBe('Faiz Hakim');
  });

  test.each([
    ['null', null],
    ['empty', ''],
    ['whitespace-only', '   '],
  ])(
    'falls back to the part of the email before the @ when the full name is %s',
    async (_label, fullName) => {
      const { client } = createClient(
        { data: [ROW], count: 1, error: null },
        {
          data: [{ user_id: 'user-1', full_name: fullName, email: 'faiz.hakim@example.com' }],
          error: null,
        },
      );

      const { contacts } = await listCrmContacts(client, 'org-1');

      expect(contacts[0].pic).toBe('faiz.hakim');
    },
  );

  test.each([
    ['null', null],
    ['empty', ''],
  ])(
    'calls an owner with no full name and a %s email a demo guest',
    async (_label, email) => {
      const { client } = createClient(
        { data: [ROW], count: 1, error: null },
        { data: [{ user_id: 'user-1', full_name: null, email }], error: null },
      );

      const { contacts } = await listCrmContacts(client, 'org-1');

      expect(contacts[0].pic).toBe('Demo guest');
    },
  );

  test('leaves the person in charge blank when the owner has no profile row', async () => {
    const { client, profilesQuery } = createClient(
      {
        data: [ROW, { ...ROW, id: 'contact-2', owner_user_id: 'user-2' }],
        count: 2,
        error: null,
      },
      {
        data: [{ user_id: 'user-1', full_name: null, email: 'faiz@example.com' }],
        error: null,
      },
    );

    const { contacts } = await listCrmContacts(client, 'org-1');

    expect(profilesQuery.in).toHaveBeenCalledWith('user_id', ['user-1', 'user-2']);
    expect(contacts.map((c) => c.pic)).toEqual(['faiz', null]);
  });

  test('still returns contacts when the owner names cannot be read', async () => {
    const { client } = createClient(
      { data: [ROW], count: 1, error: null },
      { data: null, error: new Error('denied') },
    );

    const { contacts } = await listCrmContacts(client, 'org-1');

    expect(contacts).toHaveLength(1);
    expect(contacts[0].id).toBe('contact-1');
    expect(contacts[0].pic).toBeNull();
  });

  test('throws when the contacts query fails, so the page can fall back', async () => {
    const { client } = createClient({ data: null, count: null, error: new Error('42P01') });

    await expect(listCrmContacts(client, 'org-1')).rejects.toThrow('42P01');
  });

  test('returns an empty list when the org has no contacts', async () => {
    const { client } = createClient({ data: [], count: 0, error: null });

    await expect(listCrmContacts(client, 'org-2')).resolves.toEqual({
      total: 0,
      contacts: [],
    });
  });
});
