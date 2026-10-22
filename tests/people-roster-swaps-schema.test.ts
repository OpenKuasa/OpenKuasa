import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const DIR = join(process.cwd(), 'supabase/migrations');
const FILE = '20261125090400_people_roster_notify_swaps.sql';
const ROSTERS = '20261124140000_people_rosters_and_hours.sql';
const REPORTING = '20261115133700_people_reporting_lines.sql';

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
  const open = text.indexOf(' as $$', start);
  return text.slice(open, text.indexOf('$$;', open + 6));
}
/** Removes one exact piece of text, which must be there once. */
function cut(text: string, piece: string | RegExp): string {
  const found = typeof piece === 'string' ? text.split(piece).length - 1 : (text.match(new RegExp(piece, 'g')) ?? []).length;
  expect(found, String(piece)).toBe(1);
  return text.replace(piece, '');
}
const sql = statements(FILE);
const text = flat(sql);

describe('roster notifications and shift swaps migration', () => {
  test('hr_save_roster is its newest body with only the notification lines added', () => {
    let now = body(sql, 'public.hr_save_roster');
    now = cut(now, "today date := (now() at time zone 'Asia/Kuala_Lumpur')::date;");
    now = cut(now, 'changed uuid[];');
    now = cut(now, /select coalesce\(array_agg\(distinct c\.e\), '\{\}'\) into changed[\s\S]*?is distinct from c\.t;/);
    now = cut(now, 'perform private.hr_notify_roster_changed(p_org, p_week, changed);');
    expect(flat(now)).toBe(flat(body(statements(ROSTERS), 'public.hr_save_roster')));
  });

  test('who is told is worked out before the writes and told after them', () => {
    const now = flat(body(sql, 'public.hr_save_roster'));
    const order = [
      "raise exception 'ROSTER_ARCHIVED_SHIFT_TYPE'",
      'into changed',
      'delete from public.hr_shifts s',
      'insert into public.hr_shifts as s',
      'perform private.hr_notify_roster_changed(p_org, p_week, changed);',
    ].map((needle) => now.indexOf(needle));
    expect(order.every((i) => i > -1), JSON.stringify(order)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(now).toContain('where c.d >= today and s.shift_type_id is distinct from c.t');
  });

  test('hr_waiting_counts is its newest body with only the two swap counts added', () => {
    let now = body(sql, 'public.hr_waiting_counts');
    now = cut(now, 'n_swaps int := 0;');
    now = cut(now, 'n_replies int := 0;');
    now = cut(now, "today date := (now() at time zone 'Asia/Kuala_Lumpur')::date;");
    now = cut(now, /select count\(\*\) into n_swaps[\s\S]*?end;\n/);
    now = cut(now, /select count\(\*\) into n_replies[\s\S]*?private\.is_own_employee\(w\.colleague_employee_id\);/);
    now = cut(now, ",\n    'swaps', n_swaps, 'swap_replies', n_replies");
    expect(flat(now)).toBe(flat(body(statements(REPORTING), 'public.hr_waiting_counts')));
  });

  test('every public function is revoked from everyone and granted to signed-in users only; every private one is closed', () => {
    const fns = [...sql.matchAll(/create or replace function (public\.\w+)\(/g)].map((m) => m[1]);
    expect(fns.sort()).toEqual([
      'public.hr_cancel_shift_swap', 'public.hr_decide_shift_swap', 'public.hr_reply_shift_swap', 'public.hr_request_shift_swap',
      'public.hr_save_roster', 'public.hr_swap_options', 'public.hr_waiting_counts',
    ]);
    for (const f of fns) {
      expect(text, f).toMatch(new RegExp(`revoke all on function ${f.replace('.', '\\.')}\\([^)]*\\) from public, anon;`));
      expect(text, f).toMatch(new RegExp(`grant execute on function ${f.replace('.', '\\.')}\\([^)]*\\) to authenticated;`));
    }
    const privates = [...sql.matchAll(/create or replace function (private\.\w+)\(/g)].map((m) => m[1]);
    expect(privates.length).toBeGreaterThan(0);
    for (const f of privates) {
      expect(text, f).toMatch(new RegExp(`revoke all on function ${f.replace('.', '\\.')}\\([^)]*\\) from public, anon, authenticated;`));
    }
  });

  test('the swap table is read-only to signed-in users, with the four-way read rule', () => {
    expect(text).toContain('revoke all on public.hr_shift_swaps from anon, authenticated;');
    expect(text).toContain('grant select on public.hr_shift_swaps to authenticated;');
    expect(text).not.toMatch(/grant (insert|update|delete|all)[^;]*hr_shift_swaps/);
    expect(text).toContain(
      'private.is_org_admin(org_id) or private.is_own_employee(requester_employee_id) or private.is_own_employee(colleague_employee_id) or (private.is_manager_of(requester_employee_id) and private.is_manager_of(colleague_employee_id))',
    );
    expect(text).toContain('create policy mfa_required on public.hr_shift_swaps as restrictive for all to authenticated');
  });

  test('approving re-checks the roster and both days under the workspace lock before exchanging', () => {
    const decide = flat(body(sql, 'public.hr_decide_shift_swap'));
    const order = [
      'for no key update',
      "if sw.status <> 'accepted' then raise exception 'SWAP_NOT_PENDING'",
      "raise exception 'SWAP_NOT_FUTURE'",
      "raise exception 'SWAP_SHIFT_CHANGED'",
      'delete from public.hr_shifts s',
      'insert into public.hr_shifts',
    ].map((needle) => decide.indexOf(needle));
    expect(order.every((i) => i > -1), JSON.stringify(order)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  test('the notification events are the ones the preferences screen lists', () => {
    const events = [...sql.matchAll(/deliver_notification\([^,]+, [^,]+, '(\w+)'/g)].map((m) => m[1]);
    expect([...new Set(events)].sort()).toEqual(['hr_request_filed', 'hr_roster_changed', 'hr_shift_swap']);
  });

  test('no purple, violet, fuchsia or indigo', () => {
    expect(sql).not.toMatch(/purple|violet|fuchsia|indigo/);
  });
});
