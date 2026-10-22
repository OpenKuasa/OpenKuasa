// tests/hire-apply-daily-cap-migration.test.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const read = (name: string) => readFileSync(join(process.cwd(), 'supabase/migrations', name), 'utf8');
const sql = read('20261125090200_hire_apply_daily_cap.sql');
const SIGNATURE = 'public.submit_public_application(uuid, uuid, text, text, text, text, text, text, bigint, boolean, text, text)';

/** A function's text, from its last `create` in a file to the end of its body. */
const body = (text: string, name: string) => {
  const start = text.lastIndexOf(`create or replace function ${name}(`);
  expect(start, name).toBeGreaterThan(-1);
  return text.slice(start, text.indexOf('$$;', start));
};

/** Lines that are not blank and not only a comment, trimmed, with a trailing comment removed. */
const code = (text: string) =>
  text.split('\n').map((line) => line.replace(/\s+--.*$/, '').trim()).filter((line) => line && !line.startsWith('--'));

describe('the workspace\'s daily cap on public applications', () => {
  const now = body(sql, 'public.submit_public_application');
  const was = body(read('20261101091500_rate_limits.sql'), 'public.submit_public_application');

  test('is the latest definition with only the day\'s check replaced', () => {
    const nowLines = code(now);
    const wasLines = code(was);
    expect(wasLines.filter((line) => !nowLines.includes(line))).toEqual([
      "if not (select q.allowed from private.rate_limit_consume('org_apply_day', p_org_id::text, 300, 86400) q) then",
    ]);
    expect(nowLines.filter((line) => !wasLines.includes(line))).toEqual([
      'c_org_day_cap constant integer := 300;',
      "perform pg_advisory_xact_lock(hashtextextended('hire_apply_day:' || p_org_id::text, 0));",
      'if (select count(*) from public.hire_applications a',
      "where a.org_id = p_org_id and a.applied_at > now() - interval '24 hours'",
      'and a.consented_at is not null) >= c_org_day_cap then',
      "return 'day_full';",
    ]);
    // Same count too, so nothing else was dropped or doubled: two lines out (the old check and its
    // `return 'throttled';`, which other checks still use), six in.
    expect(nowLines.length).toBe(wasLines.length - 2 + 6);
  });

  test('keeps the argument list, the answer type and how it runs', () => {
    expect(now).toContain('p_cv_path text default null');
    expect(now).toContain("returns text\nlanguage plpgsql security definer set search_path = '' as $$");
  });

  test('comes after the job\'s own limit and before anything is written', () => {
    const perJob = now.indexOf("t.at > now() - interval '1 minute') >= 30");
    const cap = now.indexOf('>= c_org_day_cap');
    expect(perJob).toBeGreaterThan(-1);
    expect(perJob).toBeLessThan(cap);
    expect(cap).toBeLessThan(now.indexOf('insert into private.hire_apply_ticks'));
    expect(cap).toBeLessThan(now.indexOf('insert into public.hire_candidates'));
    expect(now).not.toContain('org_apply_day');
  });

  test('counts only applications the applicant sent: hand-added ones carry no consent date', () => {
    expect(now).toContain('a.consented_at is not null');
    expect(now).not.toMatch(/a\.source\s*=/);
  });

  test('bounds the count by applied_at, so the (org_id, applied_at) index serves it', () => {
    expect(read('20261013090000_hire_foundation.sql')).toContain(
      'create index hire_applications_org_applied_idx on public.hire_applications (org_id, applied_at desc);',
    );
    expect(now).toContain("a.org_id = p_org_id and a.applied_at > now() - interval '24 hours'");
  });

  test('says in its header that repeats do not count and deletions free room', () => {
    expect(sql).toMatch(/repeat application[\s\S]*does not count/);
    expect(sql).toMatch(/deleting[\s\S]*frees room/i);
  });

  test('stays the server\'s alone', () => {
    expect(sql).toContain(`revoke execute on function ${SIGNATURE} from public, anon, authenticated;`);
    expect(sql).toContain(`grant execute on function ${SIGNATURE} to service_role;`);
    expect(sql).not.toMatch(/grant execute[^;]*to (anon|authenticated)/);
  });
});
