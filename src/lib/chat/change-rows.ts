/**
 * What an approval card lists under its question: every value the change
 * carries, one row each. The rows are made from the change's own arguments by
 * walking them, not from a sentence written per tool, so a tool that gains an
 * argument shows it without anyone remembering to word it, and a card can
 * never say less than what will be saved.
 *
 * Pure, and free of server code: the server makes the rows for a change a
 * specialist prepared, and the chat makes them for a change it finds in a
 * message.
 */

import { kindOfTool, type ItemKind, type NameFinder, type RowFinder } from '@/lib/chat/change-titles';

export type ChangeRow = {
  /** The argument this row shows, as a path into the input: `private.bank_account`. */
  key: string;
  /** `record`: which row the change is about, or which row it points at. Its text comes from that row, not from the change. */
  kind: 'record' | 'field';
  label: string;
  /** What will be saved, or for a record its name (its id when no lookup named it). */
  to: string;
  /** What is there now, when a lookup in the conversation showed it. */
  from?: string;
};

/** Longer than this, a value is cut on the card behind a "Show more". Nothing is dropped from the row itself. */
export const LONG_VALUE_CHARS = 140;

export const CLEARED = '(cleared)';
export const EMPTY = '(empty)';
const NONE = '(none)';

const UPPER: Record<string, string> = {
  nric: 'NRIC',
  epf: 'EPF',
  socso: 'SOCSO',
  eis: 'EIS',
  pcb: 'PCB',
  cv: 'CV',
  url: 'URL',
  kpi: 'KPI',
  hr: 'HR',
  utm: 'UTM',
  cpl: 'CPL',
  ai: 'AI',
};

/** Labels that read better than the argument's own name. Anything not here is worded from its name. */
const FIELD_LABELS: Record<string, string> = {
  interval_seconds: 'Runs every',
  max_runs: 'Runs at most',
  max_total_cents: 'Total budget',
  max_cost_cents: 'Budget for each run',
  ends_at: 'Stops on',
  careers_enabled: 'Public careers page',
  careers_headline: 'Headline',
  careers_tagline: 'Tagline',
  is_manager: 'Manager',
  half_day: 'Half day',
  memberEmail: 'Account email',
  approve: 'Decision',
};

/** `salary_min_cents` → "Salary min", `firstName` → "First name", `nric` → "NRIC". */
export function fieldLabel(key: string): string {
  if (Object.hasOwn(FIELD_LABELS, key)) return FIELD_LABELS[key];
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_]+/)
    .map((word) => word.toLowerCase())
    .filter(Boolean);
  // An amount kept in sen is shown in ringgit, and an id as the row it names: neither unit is part of the label.
  while (words.length > 1 && ['cents', 'sen', 'id'].includes(words[words.length - 1])) words.pop();
  const worded = words.map((word) => UPPER[word] ?? word).join(' ');
  return worded ? worded.charAt(0).toUpperCase() + worded.slice(1) : key;
}

const isCents = (key: string) => /(_cents|Cents|_sen)$/.test(key);
const isIdKey = (key: string) => key === 'id' || /(_id|Id)$/.test(key);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function ringgit(cents: number): string {
  const [whole, sen] = (cents / 100).toFixed(2).split('.');
  return `RM ${whole.replace(/\B(?=(\d{3})+$)/g, ',')}.${sen}`;
}

function seconds(value: number): string {
  const units: [number, string][] = [[86_400, 'day'], [3_600, 'hour'], [60, 'minute']];
  for (const [size, word] of units) {
    if (value >= size && value % size === 0) {
      const n = value / size;
      return `${n} ${word}${n === 1 ? '' : 's'}`;
    }
  }
  return `${value} seconds`;
}

/** One value as the card shows it. A value is never left out: an empty one says so. */
export function valueText(key: string, value: unknown): string {
  if (value === null || value === undefined) return CLEARED;
  if (typeof value === 'string') return value.trim() === '' ? EMPTY : value;
  if (typeof value === 'boolean') {
    if (key === 'approve') return value ? 'Approve' : 'Reject';
    return value ? 'Yes' : 'No';
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return String(value);
    if (isCents(key)) return ringgit(value);
    if (/_seconds$/.test(key)) return seconds(value);
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.length === 0 ? NONE : value.map((item) => (isPlain(item) ? JSON.stringify(item) : valueText(key, item))).join(', ');
  }
  return JSON.stringify(value);
}

const isPlain = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const ITEM_KINDS: ReadonlySet<string> = new Set<ItemKind>([
  'campaign', 'creative', 'form', 'lead', 'contact', 'deal', 'stage', 'follow-up', 'schedule', 'job', 'application',
  'candidate', 'employee', 'department', 'leave', 'time-off', 'claim', 'overtime', 'holiday', 'settings', 'payslip',
  'payslip-line', 'payroll-run', 'goal', 'review', 'training', 'announcement',
]);

/** The kind of row an id argument points at, from its name: `contactId` and `contact_id` → contact. */
function kindOfKey(key: string): ItemKind | undefined {
  const stem = key.replace(/(_id|Id)$/, '').replace(/([a-z])([A-Z])/g, '$1-$2').replace(/_/g, '-').toLowerCase();
  const alias: Record<string, ItemKind> = { line: 'payslip-line', run: 'payroll-run', 'payroll-run': 'payroll-run', course: 'training' };
  if (Object.hasOwn(alias, stem)) return alias[stem];
  return ITEM_KINDS.has(stem) ? (stem as ItemKind) : undefined;
}

const KIND_WORDS: Partial<Record<ItemKind, string>> = {
  form: 'Lead form',
  'follow-up': 'Follow-up',
  'time-off': 'Time-off request',
  leave: 'Leave request',
  overtime: 'Overtime record',
  holiday: 'Public holiday',
  settings: 'Attendance settings',
  'payslip-line': 'Payslip line',
  'payroll-run': 'Payroll run',
  training: 'Course',
  schedule: 'Schedule',
};
const kindLabel = (kind: ItemKind | undefined): string =>
  kind ? (KIND_WORDS[kind] ?? kind.charAt(0).toUpperCase() + kind.slice(1)) : 'Record';

// Line breaks and control characters, written as escapes so none sits in this file.
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001f\\u007f\\u2028\\u2029]+', 'g');

/**
 * A row's name as it may be shown: one line, with nothing that could pass for
 * the card's own layout. Some kinds are "named" by a set of facts kept as JSON
 * (a payslip, a goal): of those only the person or the title is a name.
 */
function recordName(raw: string | null): string | null {
  if (!raw) return null;
  let name = raw;
  if (raw.startsWith('{')) {
    try {
      const facts = JSON.parse(raw) as Record<string, unknown>;
      const first = [facts.employee, facts.title, facts.name, facts.label].find((v) => typeof v === 'string' && v.trim());
      if (typeof first !== 'string') return null;
      name = first;
    } catch {
      return null;
    }
  }
  const oneLine = name.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  return oneLine || null;
}

// `firstName` and `first_name` are one field. An amount in sen is never matched to one in ringgit: the unit stays in the name.
const norm = (key: string) => key.replace(/[^a-z0-9]/gi, '').toLowerCase();

/** The value a lookup row holds for an argument, whatever case the two were written in. Undefined when it holds none. */
function fromRow(row: Record<string, unknown> | null, path: string[]): unknown {
  let at: unknown = row;
  for (const key of path) {
    if (!isPlain(at)) return undefined;
    const wanted = norm(key);
    const hit = Object.keys(at).find((k) => norm(k) === wanted);
    if (hit === undefined) return undefined;
    at = at[hit];
  }
  return at;
}

/**
 * Every value a change carries, as rows. The row the change is about comes
 * first (by its name when a lookup in the conversation named it, else by its
 * id); then one row per argument, in the order they were given, nested ones
 * under their parent's label. `before` supplies the row as a lookup last
 * showed it, for "was → will be".
 */
export function changeRows(toolName: string, input: unknown, find?: NameFinder, before?: RowFinder): ChangeRow[] {
  if (!isPlain(input)) {
    return input === undefined || input === null ? [] : [{ key: '', kind: 'field', label: 'Value', to: valueText('', input) }];
  }
  const subjectKind = kindOfTool(toolName);
  const current = typeof input.id === 'string' && before ? before(input.id, subjectKind) : null;
  const rows: ChangeRow[] = [];

  const walk = (value: Record<string, unknown>, path: string[], labels: string[]) => {
    for (const [key, inner] of Object.entries(value)) {
      const at = [...path, key];
      const label = [...labels, fieldLabel(key)].join(' › ');
      if (isIdKey(key) && typeof inner === 'string' && inner.trim() !== '') {
        const subject = path.length === 0 && key === 'id';
        const kind = subject ? subjectKind : kindOfKey(key);
        // Named by a lookup; else, for the row the change is about, by what that row calls itself.
        const shown = subject && current ? [current.name, current.title, current.contact_name].find((v) => typeof v === 'string') : null;
        const name = recordName(find?.(inner, kind) ?? null) ?? recordName(typeof shown === 'string' ? shown : null);
        rows.push({
          key: at.join('.'),
          kind: 'record',
          label: subject ? kindLabel(kind) : [...labels, kind ? kindLabel(kind) : fieldLabel(key)].join(' › '),
          // No lookup named it: the id itself is shown, so the row is never blank.
          to: name ?? (UUID.test(inner) ? `id ${inner}` : inner),
        });
        continue;
      }
      if (isPlain(inner)) {
        if (Object.keys(inner).length === 0) rows.push({ key: at.join('.'), kind: 'field', label, to: NONE });
        else walk(inner, at, [...labels, fieldLabel(key)]);
        continue;
      }
      if (Array.isArray(inner) && inner.some(isPlain)) {
        inner.forEach((item, index) => {
          if (isPlain(item)) walk(item, [...at, String(index)], [...labels, `${fieldLabel(key)} ${index + 1}`]);
          else rows.push({ key: [...at, String(index)].join('.'), kind: 'field', label: `${label} ${index + 1}`, to: valueText(key, item) });
        });
        continue;
      }
      const row: ChangeRow = { key: at.join('.'), kind: 'field', label, to: valueText(key, inner) };
      const was = fromRow(current, at);
      if (was !== undefined) row.from = valueText(key, was);
      rows.push(row);
    }
  };
  walk(input, [], []);
  // The row the change is about leads; everything else keeps the order it was given in.
  return [...rows.filter((r) => r.key === 'id'), ...rows.filter((r) => r.key !== 'id')];
}

/** True when a card should say the value stays as it is. */
export const unchanged = (row: ChangeRow): boolean => row.from !== undefined && row.from === row.to;

/**
 * The card's heading: what kind of change this is, from the tool's own name
 * and nothing else. No name, no value and nothing a record or a model wrote
 * can appear in it.
 */
export function changeHeading(toolName: string): string {
  const words = toolName.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/\s+/).map((w) => w.toLowerCase()).filter(Boolean);
  if (words.length === 0 || !/^[a-zA-Z0-9]+$/.test(toolName)) return 'Change';
  const worded = words.map((word) => UPPER[word] ?? word).join(' ');
  return worded.charAt(0).toUpperCase() + worded.slice(1);
}
