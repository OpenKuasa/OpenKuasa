import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, test, vi } from 'vitest';
import { contactLabel, listCrmDealContacts, listCrmDeals, mapCrmDeal } from '@/lib/crm/deals';

type Result = { data: unknown[] | null; count?: number | null; error: unknown };

function createClient(
  rows: Result,
  profiles: Result = { data: [], error: null },
  one: { data: unknown; error: unknown } = { data: null, error: null },
) {
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    order: vi.fn(() => query),
    limit: vi.fn(async () => rows),
    maybeSingle: vi.fn(async () => one),
  };
  const profilesQuery = {
    select: vi.fn(() => profilesQuery),
    in: vi.fn(async () => profiles),
  };
  const from = vi.fn((table: string) => (table === 'profiles' ? profilesQuery : query));
  return { client: { from } as unknown as SupabaseClient, from, query, profilesQuery };
}

const ROW = {
  id: 'deal-1',
  title: 'POS rollout',
  value_cents: 1800000,
  tag: 'Inbound',
  status: 'open',
  contact_id: 'contact-1',
  pipeline_id: 'pipeline-1',
  stage_id: 'stage-1',
  expected_close_date: '2026-10-20',
  won_at: null,
  lost_at: null,
  lost_reason: null,
  owner_user_id: 'user-1',
  last_activity_at: '2026-10-09T10:00:00.000Z',
  created_at: '2026-10-01T02:00:00.000Z',
  crm_contacts: { company: 'Seri Mutiara Enterprise', first_name: 'Aisyah', last_name: 'Rahim' },
};

describe('listCrmDeals', () => {
  test('reads the org deals with their contact and owner name', async () => {
    const { client, from, query, profilesQuery } = createClient(
      { data: [ROW], count: 12, error: null },
      {
        data: [{ user_id: 'user-1', full_name: 'Faiz Hakim', email: 'faiz@example.com' }],
        error: null,
      },
    );

    const result = await listCrmDeals(client, 'org-1', 50);

    expect(from).toHaveBeenCalledWith('crm_deals');
    // Columns of crm_deals in the Kasturi schema migration, plus the contact.
    expect(query.select).toHaveBeenCalledWith(
      'id,title,value_cents,tag,status,contact_id,pipeline_id,stage_id,expected_close_date,won_at,lost_at,lost_reason,owner_user_id,last_activity_at,created_at,crm_contacts(company,first_name,last_name)',
      { count: 'exact' },
    );
    expect(query.eq).toHaveBeenCalledWith('org_id', 'org-1');
    expect(query.order).toHaveBeenCalledWith('created_at', { ascending: false });
    expect(query.limit).toHaveBeenCalledWith(50);
    expect(profilesQuery.in).toHaveBeenCalledWith('user_id', ['user-1']);
    expect(result).toEqual({
      total: 12,
      deals: [
        {
          id: 'deal-1',
          title: 'POS rollout',
          company: 'Seri Mutiara Enterprise',
          contactName: 'Aisyah Rahim',
          value: 18000,
          owner: 'Faiz Hakim',
          tag: 'Inbound',
          status: 'open',
          pipelineId: 'pipeline-1',
          stageId: 'stage-1',
          lastTouch: '9 Oct 2026',
          expectedClose: '2026-10-20',
          createdAt: '2026-10-01T02:00:00.000Z',
          wonAt: null,
          lostAt: null,
          lostReason: null,
          form: {
            title: 'POS rollout',
            contactId: 'contact-1',
            contactLabel: 'Seri Mutiara Enterprise — Aisyah Rahim',
            stageId: 'stage-1',
            value: '18000',
            tag: 'Inbound',
            expectedCloseDate: '2026-10-20',
          },
        },
      ],
    });
  });

  test('loads 500 deals unless told otherwise', async () => {
    const { client, query } = createClient({ data: [], count: 0, error: null });

    await listCrmDeals(client, 'org-1');

    expect(query.limit).toHaveBeenCalledWith(500);
  });

  test('returns no deals for an empty workspace without looking up owners', async () => {
    const { client, from } = createClient({ data: [], count: 0, error: null });

    await expect(listCrmDeals(client, 'org-2')).resolves.toEqual({ deals: [], total: 0 });
    expect(from).not.toHaveBeenCalledWith('profiles');
  });

  test('shows a deal nobody owns, or whose owner cannot be read, as Unassigned', async () => {
    const { client } = createClient(
      {
        data: [
          { ...ROW, id: 'deal-1', owner_user_id: null },
          { ...ROW, id: 'deal-2', owner_user_id: 'user-9' },
        ],
        count: 2,
        error: null,
      },
      { data: null, error: new Error('profiles unavailable') },
    );

    const { deals } = await listCrmDeals(client, 'org-1');

    expect(deals.map((deal) => deal.owner)).toEqual(['Unassigned', 'Unassigned']);
  });

  test('falls back to the number of rows when the count is missing', async () => {
    const { client } = createClient({ data: [{ ...ROW, owner_user_id: null }], error: null });

    await expect(listCrmDeals(client, 'org-1')).resolves.toMatchObject({ total: 1 });
  });

  test('rethrows a database error', async () => {
    const failure = new Error('42P01');
    const { client } = createClient({ data: null, error: failure });

    await expect(listCrmDeals(client, 'org-1')).rejects.toBe(failure);
  });
});

describe('mapCrmDeal', () => {
  test('fills in for empty columns and a missing contact', () => {
    const deal = mapCrmDeal({
      ...ROW,
      title: null,
      value_cents: null,
      tag: '  ',
      status: null,
      expected_close_date: null,
      last_activity_at: null,
      crm_contacts: null,
    });

    expect(deal.title).toBe('Untitled deal');
    expect(deal.company).toBe('Unknown contact');
    expect(deal.contactName).toBe('');
    expect(deal.value).toBe(0);
    expect(deal.owner).toBe('Unassigned');
    expect(deal).not.toHaveProperty('tag');
    expect(deal.status).toBe('open');
    expect(deal.lastTouch).toBe('—');
    expect(deal.form).toMatchObject({ title: '', value: '0', tag: '  ', expectedCloseDate: '' });
  });

  test('heads the card with the name when the contact has no company', () => {
    const deal = mapCrmDeal({
      ...ROW,
      crm_contacts: { company: null, first_name: 'Nurul', last_name: 'Huda' },
    });

    expect(deal.company).toBe('Nurul Huda');
    expect(deal.contactName).toBe('Nurul Huda');
    expect(deal.form?.contactLabel).toBe('Nurul Huda');
  });

  test('keeps sen in the value and in what the edit form is prefilled with', () => {
    const deal = mapCrmDeal({ ...ROW, value_cents: 1800050, status: 'won' });

    expect(deal.value).toBe(18000.5);
    expect(deal.form?.value).toBe('18000.50');
    expect(deal.status).toBe('won');
  });
});

describe('contactLabel', () => {
  test('joins company and name, or uses whichever there is', () => {
    expect(contactLabel('Rimba Ventures', 'Aisyah', 'Rahim')).toBe('Rimba Ventures — Aisyah Rahim');
    expect(contactLabel(null, 'Aisyah', null)).toBe('Aisyah');
    expect(contactLabel(' ', 'Aisyah', 'Rahim')).toBe('Aisyah Rahim');
    expect(contactLabel('Rimba Ventures', null, null)).toBe('Rimba Ventures');
    expect(contactLabel(null, null, null)).toBe('Unnamed contact');
  });
});

describe('listCrmDealContacts', () => {
  test('adds the contact a new deal starts with when it is beyond those loaded', async () => {
    const { client, query } = createClient(
      { data: [{ id: 'c-1', company: 'Teratak Kopi', first_name: null, last_name: null }], error: null },
      undefined,
      { data: { id: 'c-9', company: 'Bumi Hijau', first_name: null, last_name: null }, error: null },
    );

    const choices = await listCrmDealContacts(client, 'org-1', 1, 'c-9');

    expect(query.eq).toHaveBeenCalledWith('id', 'c-9');
    expect(choices).toEqual([
      { id: 'c-9', label: 'Bumi Hijau' },
      { id: 'c-1', label: 'Teratak Kopi' },
    ]);
  });

  test('does not look again for a contact already loaded, or one that is not found', async () => {
    const loaded = createClient({ data: [{ id: 'c-1', company: 'Teratak Kopi', first_name: null, last_name: null }], error: null });
    expect(await listCrmDealContacts(loaded.client, 'org-1', 1000, 'c-1')).toHaveLength(1);
    expect(loaded.query.maybeSingle).not.toHaveBeenCalled();

    // Fewer than the limit came back, so every contact of the workspace is already here.
    const short = createClient({ data: [], error: null });
    expect(await listCrmDealContacts(short.client, 'org-1', 1000, 'c-gone')).toEqual([]);
    expect(short.query.maybeSingle).not.toHaveBeenCalled();

    const gone = createClient(
      { data: [{ id: 'c-1', company: 'Teratak Kopi', first_name: null, last_name: null }], error: null },
    );
    expect(await listCrmDealContacts(gone.client, 'org-1', 1, 'c-gone')).toHaveLength(1);
  });

  test('lists the org contacts as labelled choices, A to Z', async () => {
    const { client, from, query } = createClient({
      data: [
        { id: 'c-1', company: 'Teratak Kopi', first_name: 'Faiz', last_name: 'Hakim' },
        { id: 'c-2', company: null, first_name: 'aisyah', last_name: null },
        { id: 'c-3', company: 'Bumi Hijau', first_name: 'Ahmad', last_name: 'Zaki' },
      ],
      error: null,
    });

    const choices = await listCrmDealContacts(client, 'org-1');

    expect(from).toHaveBeenCalledWith('crm_contacts');
    expect(query.select).toHaveBeenCalledWith('id,company,first_name,last_name');
    expect(query.eq).toHaveBeenCalledWith('org_id', 'org-1');
    expect(query.limit).toHaveBeenCalledWith(1000);
    expect(choices).toEqual([
      { id: 'c-2', label: 'aisyah' },
      { id: 'c-3', label: 'Bumi Hijau — Ahmad Zaki' },
      { id: 'c-1', label: 'Teratak Kopi — Faiz Hakim' },
    ]);
  });

  test('rethrows a database error', async () => {
    const failure = new Error('42501');
    const { client } = createClient({ data: null, error: failure });

    await expect(listCrmDealContacts(client, 'org-1')).rejects.toBe(failure);
  });
});
