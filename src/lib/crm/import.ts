import type { SupabaseClient } from '@supabase/supabase-js';
import {
  CrmContactFormError,
  parseCrmContactFields,
  type CrmContactFields,
  type CrmContactInsert,
} from './contacts';
import { countryCode } from './countries';

/** Rows of data accepted per file (the header row is not counted). */
export const IMPORT_LIMIT = 500;

export type ImportFieldKey =
  | 'firstName'
  | 'lastName'
  | 'email'
  | 'phone'
  | 'company'
  | 'country'
  | 'status'
  | 'leadScore'
  | 'tags';

/** The contact fields a column can feed, in display order. */
export const IMPORT_FIELDS: { key: ImportFieldKey; label: string; required: boolean }[] = [
  { key: 'firstName', label: 'First name', required: true },
  { key: 'lastName', label: 'Last name', required: false },
  { key: 'email', label: 'Email', required: true },
  { key: 'phone', label: 'Phone', required: false },
  { key: 'company', label: 'Company', required: false },
  { key: 'country', label: 'Country', required: false },
  { key: 'status', label: 'Status', required: false },
  { key: 'leadScore', label: 'Lead score', required: false },
  { key: 'tags', label: 'Tags', required: false },
];

/** Field -> index of the column that feeds it, or null when no column does. */
export type ImportMapping = Record<ImportFieldKey, number | null>;

export type ImportSkip = { line: number; reason: string };

export type ImportPlan = {
  /** Valid, de-duplicated within the file, at most IMPORT_LIMIT. */
  rows: CrmContactFields[];
  /** In file order. */
  skipped: ImportSkip[];
};

export type ImportResult = { imported: number; duplicates: number };

/** Emails per lookup query, and rows per insert. */
const LOOKUP_CHUNK = 100;
const INSERT_CHUNK = 200;

const DELIMITERS = [',', ';', '\t'];

/** The delimiter seen most on the first line, outside quotes; comma on a tie. */
function detectDelimiter(text: string) {
  const counts = new Map<string, number>(DELIMITERS.map((d) => [d, 0]));
  let inQuotes = false;
  for (const char of text) {
    if (char === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (char === '\n' || char === '\r')) break;
    else if (!inQuotes && counts.has(char)) counts.set(char, (counts.get(char) ?? 0) + 1);
  }
  let best = ',';
  for (const delimiter of DELIMITERS) {
    if ((counts.get(delimiter) ?? 0) > (counts.get(best) ?? 0)) best = delimiter;
  }
  return best;
}

/** Splits CSV text into rows of cells. */
export function parseCsv(text: string): string[][] {
  const source = text.startsWith('﻿') ? text.slice(1) : text;
  const delimiter = detectDelimiter(source);

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  const endCell = () => {
    row.push(cell.trim());
    cell = '';
  };
  const endRow = () => {
    endCell();
    if (row.some((value) => value !== '')) rows.push(row);
    row = [];
  };

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (inQuotes) {
      if (char !== '"') cell += char;
      else if (source[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else inQuotes = false;
    } else if (char === '"' && cell.trim() === '') {
      // A quote opens a quoted field only at the start of the cell.
      cell = '';
      inQuotes = true;
    } else if (char === delimiter) {
      endCell();
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i += 1;
      endRow();
    } else {
      cell += char;
    }
  }
  endRow();

  return rows;
}

/** Header spellings per field, lower-cased with spaces and punctuation removed. */
const HEADER_ALIASES: Record<ImportFieldKey, string[]> = {
  firstName: ['firstname', 'givenname', 'first'],
  lastName: ['lastname', 'surname', 'familyname', 'last'],
  email: ['email', 'emailaddress'],
  phone: ['phone', 'phonenumber', 'mobile', 'mobilenumber', 'tel', 'telephone', 'whatsapp'],
  company: ['company', 'companyname', 'organisation', 'organization', 'business'],
  country: ['country', 'countrycode'],
  status: ['status', 'stage'],
  leadScore: ['leadscore', 'score'],
  tags: ['tags', 'tag', 'labels'],
};

/** Headers that hold a whole name; used for the first name when nothing else matched. */
const FULL_NAME_HEADERS = ['name', 'fullname', 'contactname'];

function normalizeHeader(header: string) {
  return String(header ?? '')
    .toLowerCase()
    .replace(/[\s_.-]/g, '');
}

/** Best guess at which header feeds which field. */
export function guessMapping(headers: string[]): ImportMapping {
  const mapping: ImportMapping = {
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
  const names = headers.map(normalizeHeader);

  names.forEach((name, index) => {
    const field = IMPORT_FIELDS.find(({ key }) => HEADER_ALIASES[key].includes(name));
    if (field && mapping[field.key] === null) mapping[field.key] = index;
  });

  if (mapping.firstName === null) {
    const index = names.findIndex((name) => FULL_NAME_HEADERS.includes(name));
    if (index !== -1) mapping.firstName = index;
  }

  return mapping;
}

/** The trimmed text of the cell a field is mapped to; '' when unmapped or missing. */
function readCell(row: string[], index: number | null) {
  if (index === null) return '';
  const value = String(row[index] ?? '').trim();
  // The contacts export puts an apostrophe before a value a spreadsheet would work out (+60…, =…), so it shows
  // as text. Dropped here so an exported file imports unchanged; any other apostrophe is part of the value.
  return /^'[=+\-@]/.test(value) ? value.slice(1) : value;
}

/**
 * Validates a table (row 0 = headers) against a mapping. Pure; used in the
 * browser for the preview and again on the server.
 *
 * The country cell may hold a two-letter code or a country name in English
 * or Malay ("SG", "Singapore", "Singapura"); either is stored as the code.
 * An empty cell defaults to MY, and a row whose country is not recognised is
 * skipped.
 */
export function planImport(table: string[][], mapping: ImportMapping): ImportPlan {
  if (mapping.firstName === null || mapping.email === null) {
    throw new CrmContactFormError('Choose the columns for first name and email.');
  }

  const plan: ImportPlan = { rows: [], skipped: [] };
  /** Email -> the line it was accepted on. */
  const seen = new Map<string, number>();

  for (let i = 1; i < table.length; i += 1) {
    const row = table[i] ?? [];
    const line = i + 1;

    if (plan.rows.length >= IMPORT_LIMIT) {
      plan.skipped.push({ line, reason: `Over the ${IMPORT_LIMIT}-row limit.` });
      continue;
    }

    let firstName = readCell(row, mapping.firstName);
    let lastName = readCell(row, mapping.lastName);
    // One "Name" column: the first word is the first name, the rest the last.
    if (mapping.lastName === null) {
      const space = firstName.search(/\s/);
      if (space !== -1) {
        lastName = firstName.slice(space + 1).trim();
        firstName = firstName.slice(0, space);
      }
    }

    // A name or a code; an empty cell is left for the validator to default.
    const countryCell = readCell(row, mapping.country);
    const country = countryCell === '' ? '' : countryCode(countryCell);
    if (country === null) {
      plan.skipped.push({
        line,
        reason: `Country "${countryCell}" is not recognised. Use a name such as Malaysia or a two-letter code such as MY.`,
      });
      continue;
    }

    const formData = new FormData();
    formData.set('firstName', firstName);
    formData.set('lastName', lastName);
    formData.set('email', readCell(row, mapping.email));
    formData.set('phone', readCell(row, mapping.phone));
    formData.set('company', readCell(row, mapping.company));
    formData.set('country', country);
    formData.set('status', readCell(row, mapping.status));
    formData.set('leadScore', readCell(row, mapping.leadScore));
    formData.set('tags', readCell(row, mapping.tags));

    let fields: CrmContactFields;
    try {
      fields = parseCrmContactFields(formData);
    } catch (error) {
      if (!(error instanceof CrmContactFormError)) throw error;
      plan.skipped.push({ line, reason: error.message });
      continue;
    }

    const earlier = seen.get(fields.email);
    if (earlier !== undefined) {
      plan.skipped.push({ line, reason: `Same email as line ${earlier}.` });
      continue;
    }

    seen.set(fields.email, line);
    plan.rows.push(fields);
  }

  return plan;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/**
 * Inserts the rows that are not already in the workspace (matched by email,
 * case-insensitive). The table has no unique constraint on email, so this
 * lookup is what keeps a file from being imported twice.
 */
export async function importCrmContacts(
  client: SupabaseClient,
  orgId: string,
  ownerUserId: string | null,
  rows: CrmContactFields[],
): Promise<ImportResult> {
  if (rows.length === 0) return { imported: 0, duplicates: 0 };

  const existing = new Set<string>();
  const emails = [...new Set(rows.map((row) => row.email.toLowerCase()))];
  for (const part of chunk(emails, LOOKUP_CHUNK)) {
    const { data, error } = await client
      .from('crm_contacts')
      .select('email')
      .eq('org_id', orgId)
      .in('email', part);
    if (error) throw error;

    for (const found of (data ?? []) as { email: string | null }[]) {
      if (found.email) existing.add(found.email.toLowerCase());
    }
  }

  const inserts: CrmContactInsert[] = rows
    .filter((row) => !existing.has(row.email.toLowerCase()))
    .map((row) => ({
      ...row,
      org_id: orgId,
      ...(ownerUserId ? { owner_user_id: ownerUserId } : {}),
    }));

  for (const part of chunk(inserts, INSERT_CHUNK)) {
    const { error } = await client.from('crm_contacts').insert(part);
    if (error) throw error;
  }

  return { imported: inserts.length, duplicates: rows.length - inserts.length };
}
