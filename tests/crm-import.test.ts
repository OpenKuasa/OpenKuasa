import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, test, vi } from 'vitest';
import { CrmContactFormError, type CrmContactFields } from '@/lib/crm/contacts';
import {
  IMPORT_FIELDS,
  IMPORT_LIMIT,
  guessMapping,
  importCrmContacts,
  parseCsv,
  planImport,
  type ImportMapping,
} from '@/lib/crm/import';

const UNMAPPED: ImportMapping = {
  firstName: null,
  lastName: null,
  email: null,
  phone: null,
  company: null,
  country: null,
  status: null,
  leadScore: null,
  tags: null,
};

describe('IMPORT_FIELDS', () => {
  test('lists the fields in display order and requires only first name and email', () => {
    expect(IMPORT_FIELDS.map((f) => f.label)).toEqual([
      'First name',
      'Last name',
      'Email',
      'Phone',
      'Company',
      'Country',
      'Status',
      'Lead score',
      'Tags',
    ]);
    expect(IMPORT_FIELDS.filter((f) => f.required).map((f) => f.key)).toEqual([
      'firstName',
      'email',
    ]);
    expect(IMPORT_LIMIT).toBe(500);
  });
});

describe('parseCsv', () => {
  test('splits plain rows and trims cells', () => {
    expect(parseCsv('First, Last ,Email\nAisyah,Rahim, a@example.com ')).toEqual([
      ['First', 'Last', 'Email'],
      ['Aisyah', 'Rahim', 'a@example.com'],
    ]);
  });

  test('keeps delimiters, line breaks and doubled quotes inside a quoted field', () => {
    const text = 'Name,Company,Note\n"Rahim, Aisyah","Rimba ""Ventures"" Sdn Bhd","line one\nline two"\n';
    expect(parseCsv(text)).toEqual([
      ['Name', 'Company', 'Note'],
      ['Rahim, Aisyah', 'Rimba "Ventures" Sdn Bhd', 'line one\nline two'],
    ]);
  });

  test('handles CRLF and lone CR line endings', () => {
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(parseCsv('a,b\r1,2\r3,4')).toEqual([
      ['a', 'b'],
      ['1', '2'],
      ['3', '4'],
    ]);
  });

  test('strips a leading byte order mark', () => {
    expect(parseCsv('﻿Email,Name\nx@example.com,X')[0]).toEqual(['Email', 'Name']);
  });

  test('detects semicolon and tab delimiters from the first line', () => {
    expect(parseCsv('Name;Email\nRahim, Aisyah;a@example.com')).toEqual([
      ['Name', 'Email'],
      ['Rahim, Aisyah', 'a@example.com'],
    ]);
    expect(parseCsv('Name\tEmail\nAisyah\ta@example.com')).toEqual([
      ['Name', 'Email'],
      ['Aisyah', 'a@example.com'],
    ]);
  });

  test('ignores delimiters inside quotes when detecting, and prefers comma on a tie', () => {
    expect(parseCsv('"a;b;c",d,e\n1,2,3')).toEqual([
      ['a;b;c', 'd', 'e'],
      ['1', '2', '3'],
    ]);
    expect(parseCsv('a,b;c\n1,2;3')).toEqual([
      ['a', 'b;c'],
      ['1', '2;3'],
    ]);
    expect(parseCsv('only\none')).toEqual([['only'], ['one']]);
  });

  test('drops blank rows and does not add a row for a trailing newline', () => {
    expect(parseCsv('a,b\n\n,\n  ,  \n1,2\n\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(parseCsv('')).toEqual([]);
  });

  test('keeps empty cells in a row that has some content', () => {
    expect(parseCsv('a,b,c\n1,,3\n,,"x"')).toEqual([
      ['a', 'b', 'c'],
      ['1', '', '3'],
      ['', '', 'x'],
    ]);
  });
});

describe('guessMapping', () => {
  test('matches typical headers whatever their case and punctuation', () => {
    expect(
      guessMapping([
        'First Name',
        'LAST_NAME',
        'E-mail',
        'Phone Number',
        'Company.Name',
        'Country Code',
        'Stage',
        'lead-score',
        'Labels',
      ]),
    ).toEqual({
      firstName: 0,
      lastName: 1,
      email: 2,
      phone: 3,
      company: 4,
      country: 5,
      status: 6,
      leadScore: 7,
      tags: 8,
    });
  });

  test('accepts the other spellings of each field', () => {
    expect(guessMapping(['Surname', 'Given name', 'Email Address', 'WhatsApp', 'Organisation'])).toEqual({
      ...UNMAPPED,
      lastName: 0,
      firstName: 1,
      email: 2,
      phone: 3,
      company: 4,
    });
    expect(guessMapping(['first', 'last', 'tel', 'business', 'country', 'status', 'score', 'tag'])).toEqual({
      ...UNMAPPED,
      firstName: 0,
      lastName: 1,
      phone: 2,
      company: 3,
      country: 4,
      status: 5,
      leadScore: 6,
      tags: 7,
    });
  });

  test('falls back to a full-name column for the first name', () => {
    expect(guessMapping(['Email', 'Full Name'])).toEqual({ ...UNMAPPED, email: 0, firstName: 1 });
    expect(guessMapping(['Contact_Name', 'Email']).firstName).toBe(0);
    expect(guessMapping(['name']).firstName).toBe(0);
  });

  test('prefers a real first-name column over a full-name column', () => {
    expect(guessMapping(['Name', 'First name', 'Email'])).toEqual({
      ...UNMAPPED,
      firstName: 1,
      email: 2,
    });
  });

  test('leaves unmatched fields null', () => {
    expect(guessMapping(['Notes', 'Birthday', ''])).toEqual(UNMAPPED);
    expect(guessMapping([])).toEqual(UNMAPPED);
  });

  test('uses the first matching header and never one column for two fields', () => {
    const mapping = guessMapping(['Phone', 'Mobile', 'Email', 'email address', 'Name', 'Full name']);
    expect(mapping).toEqual({ ...UNMAPPED, phone: 0, email: 2, firstName: 4 });

    const used = Object.values(mapping).filter((index) => index !== null);
    expect(new Set(used).size).toBe(used.length);
  });
});

describe('planImport', () => {
  const HEADERS = ['First', 'Last', 'Email', 'Phone', 'Company', 'Country', 'Status', 'Score', 'Tags'];
  const FULL: ImportMapping = {
    firstName: 0,
    lastName: 1,
    email: 2,
    phone: 3,
    company: 4,
    country: 5,
    status: 6,
    leadScore: 7,
    tags: 8,
  };

  test('turns valid rows into contact fields', () => {
    const plan = planImport(
      [
        HEADERS,
        [
          ' Aisyah ',
          'Rahim',
          'Aisyah@Example.com',
          '+60123456789',
          'Rimba Ventures',
          'sg',
          'qualified',
          '92',
          'vip, KL',
        ],
        ['Faiz', '', 'faiz@example.com'],
      ],
      FULL,
    );

    expect(plan.skipped).toEqual([]);
    expect(plan.rows).toEqual([
      {
        first_name: 'Aisyah',
        last_name: 'Rahim',
        email: 'aisyah@example.com',
        phone: '+60123456789',
        company: 'Rimba Ventures',
        country: 'SG',
        status: 'qualified',
        lead_score: 92,
        tags: ['vip', 'KL'],
      },
      {
        first_name: 'Faiz',
        last_name: null,
        email: 'faiz@example.com',
        phone: null,
        company: null,
        country: 'MY',
        status: 'lead',
        lead_score: 0,
        tags: [],
      },
    ]);
  });

  test('maps the status labels people see back to stored values', () => {
    const table = [
      ['Name', 'Email', 'Status'],
      ['A', 'a@example.com', 'New lead'],
      ['B', 'b@example.com', 'New Leads'],
      ['C', 'c@example.com', 'Customers'],
      ['D', 'd@example.com', 'Contacted'],
    ];
    const plan = planImport(table, { ...UNMAPPED, firstName: 0, email: 1, status: 2 });

    expect(plan.rows.map((row) => row.status)).toEqual(['lead', 'lead', 'customer', 'contacted']);
  });

  test('splits a full name when no last-name column is chosen', () => {
    const plan = planImport(
      [
        ['Name', 'Email'],
        ['  Aisyah binti Rahim ', 'a@example.com'],
        ['Faiz', 'f@example.com'],
      ],
      { ...UNMAPPED, firstName: 0, email: 1 },
    );

    expect(plan.rows.map((row) => [row.first_name, row.last_name])).toEqual([
      ['Aisyah', 'binti Rahim'],
      ['Faiz', null],
    ]);
  });

  test('does not split the first name when a last-name column is chosen', () => {
    const plan = planImport(
      [
        ['First', 'Last', 'Email'],
        ['Nur Aisyah', 'Rahim', 'a@example.com'],
      ],
      { ...UNMAPPED, firstName: 0, lastName: 1, email: 2 },
    );

    expect(plan.rows[0]).toMatchObject({ first_name: 'Nur Aisyah', last_name: 'Rahim' });
  });

  test('skips invalid rows with their line number and the validator message', () => {
    const plan = planImport(
      [
        HEADERS,
        ['', 'Rahim', 'a@example.com'],
        ['Faiz', 'Hakim', 'not-an-email'],
        ['Mei', 'Ling', 'mei@example.com', '', '', ' Atlantis '],
        ['Tag', 'Heavy', 'tags@example.com', '', '', '', '', '', 'x'.repeat(31)],
        ['Many', 'Tags', 'many@example.com', '', '', '', '', '', 'a,b,c,d,e,f,g,h,i,j,k'],
        [],
        ['Good', 'Row', 'good@example.com'],
      ],
      FULL,
    );

    expect(plan.skipped).toEqual([
      { line: 2, reason: 'Enter a first name.' },
      { line: 3, reason: 'Enter a valid email.' },
      {
        line: 4,
        reason:
          'Country "Atlantis" is not recognised. Use a name such as Malaysia or a two-letter code such as MY.',
      },
      { line: 5, reason: 'Keep each tag to 30 characters or fewer.' },
      { line: 6, reason: 'Use at most 10 tags per contact.' },
      { line: 7, reason: 'Enter a first name.' },
    ]);
    expect(plan.rows.map((row) => row.email)).toEqual(['good@example.com']);
  });

  describe('country column', () => {
    const mapping: ImportMapping = { ...UNMAPPED, firstName: 0, email: 1, country: 2 };
    const countries = (cells: string[]) =>
      planImport(
        [['Name', 'Email', 'Country'], ...cells.map((cell, i) => [`P${i}`, `p${i}@example.com`, cell])],
        mapping,
      );

    test('stores the code for a country name', () => {
      const plan = countries(['Malaysia']);

      expect(plan.skipped).toEqual([]);
      expect(plan.rows[0]).toMatchObject({ email: 'p0@example.com', country: 'MY' });
    });

    test('accepts a name or a code in any case', () => {
      const plan = countries(['singapore', 'SG', 'sg', ' United Kingdom ', 'U.S.A.']);

      expect(plan.skipped).toEqual([]);
      expect(plan.rows.map((row) => row.country)).toEqual(['SG', 'SG', 'SG', 'GB', 'US']);
    });

    test('skips a country it does not recognise, quoting the cell', () => {
      const plan = countries(['Malaysia', 'Narnia', 'XX', 'Thailand']);

      expect(plan.skipped).toEqual([
        {
          line: 3,
          reason:
            'Country "Narnia" is not recognised. Use a name such as Malaysia or a two-letter code such as MY.',
        },
        {
          line: 4,
          reason:
            'Country "XX" is not recognised. Use a name such as Malaysia or a two-letter code such as MY.',
        },
      ]);
      expect(plan.rows.map((row) => row.country)).toEqual(['MY', 'TH']);
    });

    test('reports the country before any other problem with the row', () => {
      const plan = planImport(
        [
          ['Name', 'Email', 'Country'],
          ['', 'not-an-email', 'Narnia'],
        ],
        mapping,
      );

      expect(plan.skipped).toEqual([
        {
          line: 2,
          reason:
            'Country "Narnia" is not recognised. Use a name such as Malaysia or a two-letter code such as MY.',
        },
      ]);
    });

    test('defaults an empty or unmapped country to MY', () => {
      expect(countries(['', '   ']).rows.map((row) => row.country)).toEqual(['MY', 'MY']);

      const unmapped = planImport(
        [
          ['Name', 'Email', 'Country'],
          ['A', 'a@example.com', 'Singapore'],
        ],
        { ...mapping, country: null },
      );
      expect(unmapped.rows[0].country).toBe('MY');
    });
  });

  test('skips an email already accepted earlier in the file', () => {
    const plan = planImport(
      [
        ['Name', 'Email'],
        ['', 'dup@example.com'],
        ['Aisyah', 'dup@example.com'],
        ['Faiz', 'other@example.com'],
        ['Aisyah Again', ' DUP@Example.com '],
      ],
      { ...UNMAPPED, firstName: 0, email: 1 },
    );

    // Line 2 was rejected, so line 3 is the one later rows are compared with.
    expect(plan.skipped).toEqual([
      { line: 2, reason: 'Enter a first name.' },
      { line: 5, reason: 'Same email as line 3.' },
    ]);
    expect(plan.rows).toHaveLength(2);
  });

  test('skips every row after the limit, one entry per row', () => {
    const table = [['Name', 'Email']];
    for (let i = 0; i < IMPORT_LIMIT + 3; i += 1) table.push([`Person ${i}`, `p${i}@example.com`]);
    // An invalid row inside the limit does not use up a place.
    table[10] = ['', 'broken'];

    const plan = planImport(table, { ...UNMAPPED, firstName: 0, email: 1 });

    expect(plan.rows).toHaveLength(IMPORT_LIMIT);
    expect(plan.rows.at(-1)?.email).toBe(`p${IMPORT_LIMIT}@example.com`);
    expect(plan.skipped).toEqual([
      { line: 11, reason: 'Enter a first name.' },
      { line: IMPORT_LIMIT + 3, reason: `Over the ${IMPORT_LIMIT}-row limit.` },
      { line: IMPORT_LIMIT + 4, reason: `Over the ${IMPORT_LIMIT}-row limit.` },
    ]);
  });

  test('throws when first name or email has no column', () => {
    const table = [['Name', 'Email'], ['A', 'a@example.com']];

    for (const mapping of [
      { ...UNMAPPED, email: 1 },
      { ...UNMAPPED, firstName: 0 },
    ]) {
      expect(() => planImport(table, mapping)).toThrow(CrmContactFormError);
      expect(() => planImport(table, mapping)).toThrow(
        'Choose the columns for first name and email.',
      );
    }
  });

  test('returns nothing for an empty table or one with only headers', () => {
    const mapping = { ...UNMAPPED, firstName: 0, email: 1 };

    expect(planImport([], mapping)).toEqual({ rows: [], skipped: [] });
    expect(planImport([['Name', 'Email']], mapping)).toEqual({ rows: [], skipped: [] });
  });

  test('treats a column index past the end of a row as an empty cell', () => {
    const plan = planImport(
      [
        ['Name', 'Email'],
        ['Aisyah', 'a@example.com'],
      ],
      { ...UNMAPPED, firstName: 0, email: 1, phone: 7, tags: 9 },
    );

    expect(plan.rows[0]).toMatchObject({ phone: null, tags: [] });
  });

  test('drops the apostrophe the contacts export puts before a value a spreadsheet would work out', () => {
    const plan = planImport(
      [
        ['First', 'Email', 'Phone', 'Company'],
        ["'Ah", 'ahkow@example.com', "'+60-12-345 6789", "'=Rimba"],
        ['Mei', 'mei@example.com', '012-345 6789', "Mei's Kitchen"],
      ],
      { ...UNMAPPED, firstName: 0, email: 1, phone: 2, company: 3 },
    );

    expect(plan.skipped).toEqual([]);
    // Only an apostrophe in front of = + - or @ is the export's: anything else is part of the value.
    expect(plan.rows[0]).toMatchObject({ first_name: "'Ah", phone: '+60-12-345 6789', company: '=Rimba' });
    expect(plan.rows[1]).toMatchObject({ phone: '012-345 6789', company: "Mei's Kitchen" });
  });
});

describe('importCrmContacts', () => {
  type LookupResult = { data: { email: string | null }[] | null; error: unknown };

  function createClient(
    options: {
      /** Emails already in the workspace, as stored. */
      existing?: string[];
      lookupError?: unknown;
      insertError?: unknown;
    } = {},
  ) {
    const stored = options.existing ?? [];
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn(() => query),
      in: vi.fn(async (_column: string, emails: string[]): Promise<LookupResult> => {
        if (options.lookupError) return { data: null, error: options.lookupError };
        const wanted = new Set(emails);
        return {
          data: stored.filter((email) => wanted.has(email)).map((email) => ({ email })),
          error: null,
        };
      }),
      insert: vi.fn(async (rows: Record<string, unknown>[]) => {
        void rows;
        return { error: options.insertError ?? null };
      }),
    };
    const from = vi.fn(() => query);
    return { client: { from } as unknown as SupabaseClient, from, query };
  }

  function contact(email: string): CrmContactFields {
    return {
      first_name: 'Person',
      last_name: null,
      email,
      phone: null,
      company: null,
      country: 'MY',
      status: 'lead',
      lead_score: 0,
      tags: [],
    };
  }

  function contacts(count: number) {
    return Array.from({ length: count }, (_, i) => contact(`p${i}@example.com`));
  }

  test('does nothing for an empty list', async () => {
    const { client, from } = createClient();

    await expect(importCrmContacts(client, 'org-1', 'user-1', [])).resolves.toEqual({
      imported: 0,
      duplicates: 0,
    });
    expect(from).not.toHaveBeenCalled();
  });

  test('looks up emails in the org and inserts only the new contacts', async () => {
    const { client, from, query } = createClient({ existing: ['b@example.com'] });
    const rows = [contact('a@example.com'), contact('b@example.com'), contact('c@example.com')];

    const result = await importCrmContacts(client, 'org-1', 'user-1', rows);

    expect(result).toEqual({ imported: 2, duplicates: 1 });
    expect(from).toHaveBeenCalledWith('crm_contacts');
    expect(query.select).toHaveBeenCalledWith('email');
    expect(query.eq).toHaveBeenCalledWith('org_id', 'org-1');
    expect(query.in).toHaveBeenCalledWith('email', [
      'a@example.com',
      'b@example.com',
      'c@example.com',
    ]);
    expect(query.insert).toHaveBeenCalledTimes(1);
    expect(query.insert).toHaveBeenCalledWith([
      { ...contact('a@example.com'), org_id: 'org-1', owner_user_id: 'user-1' },
      { ...contact('c@example.com'), org_id: 'org-1', owner_user_id: 'user-1' },
    ]);
  });

  test('inserts nothing when every contact already exists', async () => {
    const { client, query } = createClient({ existing: ['a@example.com', 'b@example.com'] });

    const result = await importCrmContacts(client, 'org-1', null, [
      contact('a@example.com'),
      contact('b@example.com'),
    ]);

    expect(result).toEqual({ imported: 0, duplicates: 2 });
    expect(query.insert).not.toHaveBeenCalled();
  });

  test('looks up emails 100 at a time and inserts 200 at a time', async () => {
    const existing = ['p0@example.com', 'p150@example.com', 'p449@example.com'];
    const { client, query } = createClient({ existing });

    const result = await importCrmContacts(client, 'org-1', 'user-1', contacts(450));

    expect(result).toEqual({ imported: 447, duplicates: 3 });
    expect(query.in.mock.calls.map(([, emails]) => emails.length)).toEqual([100, 100, 100, 100, 50]);
    expect(query.in.mock.calls[1][1][0]).toBe('p100@example.com');
    expect(query.insert.mock.calls.map(([rows]) => rows.length)).toEqual([200, 200, 47]);

    const inserted = query.insert.mock.calls.flatMap(([rows]) => rows.map((row) => row.email));
    expect(new Set(inserted).size).toBe(447);
    expect(inserted).not.toContain('p150@example.com');
  });

  test('sets the owner only when one is given', async () => {
    for (const owner of [null, '']) {
      const { client, query } = createClient();
      await importCrmContacts(client, 'org-1', owner, [contact('a@example.com')]);

      const [row] = query.insert.mock.calls[0][0];
      expect(row).not.toHaveProperty('owner_user_id');
      expect(row).toMatchObject({ org_id: 'org-1', email: 'a@example.com' });
    }

    const { client, query } = createClient();
    await importCrmContacts(client, 'org-1', 'user-9', [contact('a@example.com')]);
    expect(query.insert.mock.calls[0][0][0]).toHaveProperty('owner_user_id', 'user-9');
  });

  test('rethrows a lookup error without inserting', async () => {
    const error = new Error('42501');
    const { client, query } = createClient({ lookupError: error });

    await expect(importCrmContacts(client, 'org-1', null, contacts(3))).rejects.toBe(error);
    expect(query.insert).not.toHaveBeenCalled();
  });

  test('rethrows an insert error', async () => {
    const error = new Error('23514');
    const { client } = createClient({ insertError: error });

    await expect(importCrmContacts(client, 'org-1', null, contacts(3))).rejects.toBe(error);
  });
});
