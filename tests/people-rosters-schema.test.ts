import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const DIR = join(process.cwd(), 'supabase/migrations');
const FILE = '20261124140000_people_rosters_and_hours.sql';
const PREVIOUS = '20261123130000_people_drop_is_manager.sql';

/** A migration's statements without its comment lines. */
const statements = (file: string) =>
  readFileSync(join(DIR, file), 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
const flat = (text: string) => text.replace(/\s+/g, ' ');
function body(text: string, qualified: string): string {
  const start = text.indexOf(`create or replace function ${qualified}(`);
  expect(start, qualified).toBeGreaterThan(-1);
  const open = text.indexOf(' as $$', start);
  return text.slice(open, text.indexOf('$$;', open + 6));
}
const sql = statements(FILE);
const text = flat(sql);

describe('rosters, hours and shift types migration', () => {
  test('backfills every shift before requiring a type, and keeps the old column optional', () => {
    const order = [
      'create table public.hr_shift_types (',
      'perform private.hr_ensure_shift_types(o);',
      'alter table public.hr_shifts add column shift_type_id uuid;',
      'update public.hr_shifts s set shift_type_id = t.id',
      'alter table public.hr_shifts alter column shift_type_id set not null;',
      'foreign key (shift_type_id, org_id) references public.hr_shift_types (id, org_id)',
      'alter table public.hr_shifts alter column shift drop not null;',
    ].map((needle) => text.indexOf(needle));
    expect(order.every((i) => i > -1), JSON.stringify(order)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(text).not.toContain('drop column shift');
    expect(text).toContain("select private.people_secure_table('hr_shift_types', 'shared');");
  });

  test('the palette has no purple, violet, fuchsia or indigo', () => {
    expect(sql).not.toMatch(/purple|violet|fuchsia|indigo/);
  });

  test('every public function is revoked from everyone and granted to signed-in users only', () => {
    const fns = [...sql.matchAll(/create or replace function (public\.\w+)\(/g)].map((m) => m[1]);
    expect(fns.sort()).toEqual([
      'public.hr_archive_shift_type', 'public.hr_ensure_shift_types', 'public.hr_save_hours', 'public.hr_save_roster', 'public.hr_save_shift_type',
    ]);
    for (const f of fns) {
      expect(text, f).toMatch(new RegExp(`revoke all on function ${f.replace('.', '\\.')}\\([^)]*\\) from public, anon;`));
      expect(text, f).toMatch(new RegExp(`grant execute on function ${f.replace('.', '\\.')}\\([^)]*\\) to authenticated;`));
    }
    for (const f of [...sql.matchAll(/create or replace function (private\.\w+)\(/g)].map((m) => m[1])) {
      expect(text, f).toMatch(new RegExp(`revoke all on function ${f.replace('.', '\\.')}\\([^)]*\\) from public, anon, authenticated;`));
    }
  });

  test('the demo re-seed is its newest body with only the roster insert changed', () => {
    const before = body(statements(PREVIOUS), 'private.reseed_demo_people');
    const now = body(sql, 'private.reseed_demo_people');
    const cut = (b: string) => {
      const start = b.indexOf('insert into public.hr_shifts');
      return b.slice(0, start) + b.slice(b.indexOf(';', start) + 1);
    };
    const nowWithoutEnsure = now.replace(/\n\s*perform private\.hr_ensure_shift_types\(demo\);/, '');
    expect(flat(cut(nowWithoutEnsure))).toBe(flat(cut(before)));
    expect(flat(now)).toContain('insert into public.hr_shifts (org_id, employee_id, work_date, shift_type_id, shift)');
    expect(flat(now)).toContain('join public.hr_shift_types t on t.org_id = demo and t.default_kind = k.kind');
  });
});
