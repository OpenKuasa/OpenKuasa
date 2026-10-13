import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, test, vi } from 'vitest';
import {
  createCrmContact,
  parseCrmContactForm,
} from '@/lib/crm/contacts';

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

function createInsertClient() {
  const query = {
    insert: vi.fn(() => query),
    select: vi.fn(() => query),
    single: vi.fn(async () => ({
      data: {
        id: 'contact-1',
        email: 'aisyah@example.com',
        company: 'Rimba Ventures',
        first_name: 'Aisyah',
        last_name: 'Rahim',
        phone: '+60123456789',
        country: 'MY',
        status: 'qualified',
        lead_score: 72,
        owner_user_id: null,
        last_interaction_at: null,
        tags: ['VIP', 'Wholesale'],
      },
      error: null,
    })),
  };
  const from = vi.fn(() => query);
  return { client: { from } as unknown as SupabaseClient, from, query };
}

describe('create Kasturi contact', () => {
  test('parses form data into an org-scoped insert payload', () => {
    const payload = parseCrmContactForm(
      form({
        firstName: ' Aisyah ',
        lastName: ' Rahim ',
        email: ' AISYAH@EXAMPLE.COM ',
        phone: ' +60123456789 ',
        company: ' Rimba Ventures ',
        country: ' my ',
        status: 'Qualified',
        leadScore: '72',
        tags: ' VIP , wholesale  buyer ,, vip ',
      }),
      'org-1',
    );

    expect(payload).toEqual({
      org_id: 'org-1',
      first_name: 'Aisyah',
      last_name: 'Rahim',
      email: 'aisyah@example.com',
      phone: '+60123456789',
      company: 'Rimba Ventures',
      country: 'MY',
      status: 'qualified',
      lead_score: 72,
      tags: ['VIP', 'wholesale buyer'],
    });
  });

  test('sends no tags when the form has no tags field', () => {
    const payload = parseCrmContactForm(
      form({ firstName: 'Aisyah', email: 'aisyah@example.com' }),
      'org-1',
    );

    expect(payload).toEqual({
      org_id: 'org-1',
      first_name: 'Aisyah',
      last_name: null,
      email: 'aisyah@example.com',
      phone: null,
      company: null,
      country: 'MY',
      status: 'lead',
      lead_score: 0,
      tags: [],
    });
  });

  test('rejects too many tags before insert', () => {
    const tags = Array.from({ length: 11 }, (_, i) => `tag-${i}`).join(',');

    expect(() =>
      parseCrmContactForm(
        form({ firstName: 'Aisyah', email: 'aisyah@example.com', tags }),
        'org-1',
      ),
    ).toThrow('Use at most 10 tags per contact.');
  });

  test.each([
    ['new', 'lead'],
    ['New Lead', 'lead'],
    ['New Leads', 'lead'],
    [' new leads ', 'lead'],
    ['Leads', 'lead'],
    ['Lead', 'lead'],
    ['Customers', 'customer'],
    ['Customer', 'customer'],
    ['Contacted', 'contacted'],
    ['QUALIFIED', 'qualified'],
    ['Archived', 'archived'],
  ])('stores the status label %j as %j', (label, stored) => {
    const payload = parseCrmContactForm(
      form({ firstName: 'Aisyah', email: 'aisyah@example.com', status: label }),
      'org-1',
    );

    expect(payload.status).toBe(stored);
  });

  test.each(['prospect', 'VIP', 'new customer', ''])(
    'falls back to lead for the unknown status %j',
    (label) => {
      const payload = parseCrmContactForm(
        form({ firstName: 'Aisyah', email: 'aisyah@example.com', status: label }),
        'org-1',
      );

      expect(payload.status).toBe('lead');
    },
  );

  test('accepts archived as a status', () => {
    const payload = parseCrmContactForm(
      form({ firstName: 'Aisyah', email: 'aisyah@example.com', status: 'Archived' }),
      'org-1',
    );

    expect(payload.status).toBe('archived');
  });

  test('sets the owner only when an owner id is passed', () => {
    const values = form({ firstName: 'Aisyah', email: 'aisyah@example.com' });

    expect(parseCrmContactForm(values, 'org-1', 'user-1').owner_user_id).toBe('user-1');
    expect(parseCrmContactForm(values, 'org-1')).not.toHaveProperty('owner_user_id');
    expect(parseCrmContactForm(values, 'org-1', null)).not.toHaveProperty('owner_user_id');
    expect(parseCrmContactForm(values, 'org-1', '')).not.toHaveProperty('owner_user_id');
  });

  test('rejects an invalid email before insert', () => {
    expect(() =>
      parseCrmContactForm(
        form({ firstName: 'Aisyah', email: 'bad-email' }),
        'org-1',
      ),
    ).toThrow('Enter a valid email.');
  });

  test('defaults to the status and country the table accepts', () => {
    const payload = parseCrmContactForm(
      form({ firstName: 'Aisyah', email: 'aisyah@example.com', status: 'prospect' }),
      'org-1',
    );

    // crm_contacts.status allows lead, contacted, qualified, customer, archived.
    expect(payload.status).toBe('lead');
    expect(payload.country).toBe('MY');
    expect(payload).not.toHaveProperty('company_name');
  });

  test('rejects a country that is not a two-letter code', () => {
    expect(() =>
      parseCrmContactForm(
        form({ firstName: 'Aisyah', email: 'aisyah@example.com', country: 'Malaysia' }),
        'org-1',
      ),
    ).toThrow('Use a two-letter country code, such as MY.');
  });

  test('inserts the contact and maps the returned row', async () => {
    const { client, from, query } = createInsertClient();

    const contact = await createCrmContact(client, {
      org_id: 'org-1',
      first_name: 'Aisyah',
      last_name: 'Rahim',
      email: 'aisyah@example.com',
      phone: '+60123456789',
      company: 'Rimba Ventures',
      country: 'MY',
      status: 'qualified',
      lead_score: 72,
      tags: ['VIP', 'Wholesale'],
    });

    expect(from).toHaveBeenCalledWith('crm_contacts');
    expect(query.insert).toHaveBeenCalledWith({
      org_id: 'org-1',
      first_name: 'Aisyah',
      last_name: 'Rahim',
      email: 'aisyah@example.com',
      phone: '+60123456789',
      company: 'Rimba Ventures',
      country: 'MY',
      status: 'qualified',
      lead_score: 72,
      tags: ['VIP', 'Wholesale'],
    });
    expect(query.select).toHaveBeenCalledWith(
      'id,email,company,first_name,last_name,phone,country,status,lead_score,owner_user_id,last_interaction_at,tags,finance_customer_id',
    );
    expect(query.single).toHaveBeenCalled();
    expect(contact.email).toBe('aisyah@example.com');
    expect(contact.status).toBe('Qualified');
    expect(contact.tags).toEqual(['VIP', 'Wholesale']);
    expect(contact.form?.tags).toBe('VIP, Wholesale');
  });
});
