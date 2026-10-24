import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const DIR = join(process.cwd(), 'supabase/migrations');
const FILE = '20261125200300_hr_shifts_drop_legacy_shift.sql';
const ROSTERS = '20261124140000_people_rosters_and_hours.sql';
const SWAPS = '20261125090400_people_roster_notify_swaps.sql';

/** A migration's statements without its comment lines. */
const statements = (file: string) =>
  readFileSync(join(DIR, file), 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
const flat = (text: string) => text.replace(/\s+/g, ' ').trim();
function body(text: string, qualified: string): string {
  const start = text.indexOf(`create or replace function ${qualified}(`);
  expect(start, qualified).toBeGreaterThan(-1);
  return text.slice(start, text.indexOf('$$;', text.indexOf(' as $$', start) + 6));
}
/** Replaces one exact piece of text, which must be there once. */
function swap(text: string, piece: string, by: string): string {
  expect(text.split(piece).length - 1, piece).toBe(1);
  return text.replace(piece, by);
}
const sql = statements(FILE);
const text = flat(sql);

describe('dropping the legacy hr_shifts.shift column', () => {
  test('the demo re-seed is its newest body without the old column', () => {
    let before = flat(body(statements(ROSTERS), 'private.reseed_demo_people'));
    before = swap(before, 'work_date, shift_type_id, shift)', 'work_date, shift_type_id)');
    before = swap(before, 'week_start + g.i, t.id, k.kind', 'week_start + g.i, t.id');
    expect(flat(body(sql, 'private.reseed_demo_people'))).toBe(before);
  });

  test('hr_save_roster is its newest body without the old column', () => {
    let before = flat(body(statements(SWAPS), 'public.hr_save_roster'));
    before = swap(before, 'work_date, shift_type_id, shift)', 'work_date, shift_type_id)');
    before = swap(before, 'select p_org, c.e, c.d, c.t, t.default_kind', 'select p_org, c.e, c.d, c.t');
    before = swap(before, 'shift_type_id = excluded.shift_type_id, shift = excluded.shift', 'shift_type_id = excluded.shift_type_id');
    expect(flat(body(sql, 'public.hr_save_roster'))).toBe(before);
  });

  test('hr_decide_shift_swap is its newest body without the old column', () => {
    let before = flat(body(statements(SWAPS), 'public.hr_decide_shift_swap'));
    before = swap(before, 'work_date, shift_type_id, shift)', 'work_date, shift_type_id)');
    before = swap(before, 'select sw.org_id, x.e, d, x.t, t.default_kind', 'select sw.org_id, x.e, d, x.t');
    expect(flat(body(sql, 'public.hr_decide_shift_swap'))).toBe(before);
  });

  test('the grants are restated as before', () => {
    expect(text).toContain('revoke all on function private.reseed_demo_people() from public, anon, authenticated;');
    for (const f of ['public.hr_save_roster(uuid, date, jsonb)', 'public.hr_decide_shift_swap(uuid, boolean, text)']) {
      expect(text).toContain(`revoke all on function ${f} from public, anon;`);
      expect(text).toContain(`grant execute on function ${f} to authenticated;`);
    }
  });

  test('the column goes only after every writer is redefined, then checks itself', () => {
    const order = [
      "set local lock_timeout = '5s';",
      'create or replace function private.reseed_demo_people(',
      'create or replace function public.hr_save_roster(',
      'create or replace function public.hr_decide_shift_swap(',
      'alter table public.hr_shifts drop constraint if exists hr_shifts_shift_check;',
      'alter table public.hr_shifts drop column shift;',
      'do $$',
    ].map((needle) => text.indexOf(needle));
    expect(order.every((i) => i > -1), JSON.stringify(order)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});
