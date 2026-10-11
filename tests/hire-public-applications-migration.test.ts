// tests/hire-public-applications-migration.test.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const sql = readFileSync(
  join(process.cwd(), 'supabase/migrations', '20261018100000_hire_public_applications.sql'), 'utf8',
);
const fn = (name: string) => {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  expect(start, name).toBeGreaterThan(-1);
  return sql.slice(start, sql.indexOf('$$;', start));
};
const WORDS = [
  'ok', 'name_too_long', 'email_too_long', 'phone_too_long', 'cover_letter_too_long', 'url_too_long',
  'invalid_name', 'invalid_email', 'invalid_url', 'invalid_salary', 'not_found', 'closed',
  'consent_required', 'cv_required', 'cover_letter_required', 'throttled',
];

describe('hire public applications migration', () => {
  test('adds the five application fields with their checks', () => {
    expect(sql).toContain('alter table public.hire_applications');
    expect(sql).toContain('add column cover_letter text check (char_length(cover_letter) <= 4000)');
    expect(sql).toContain("add column cv_url text check (char_length(cv_url) <= 500 and cv_url ~ '^https?://')");
    expect(sql).toContain("add column portfolio_url text check (char_length(portfolio_url) <= 500 and portfolio_url ~ '^https?://')");
    expect(sql).toContain('add column expected_salary_cents bigint check (expected_salary_cents >= 0)');
    expect(sql).toContain('add column consented_at timestamptz');
  });

  test('makes a candidate email unique within a workspace, whatever its letter case', () => {
    expect(sql).toContain(
      'create unique index hire_candidates_org_email_key on public.hire_candidates (org_id, lower(email)) where email is not null',
    );
  });

  test('gives visitors no table privilege, and execute on exactly two functions', () => {
    expect(sql).not.toMatch(/grant\s+(select|insert|update|delete|all)[^;]*to[^;]*\banon\b/i);
    const grants = sql.match(/grant execute on function public\.\w+\([^)]*\) to anon, authenticated;/g) ?? [];
    expect(grants).toHaveLength(2);
    expect(sql).toContain('revoke execute on function public.submit_public_application(uuid, uuid, text, text, text, text, text, text, bigint, boolean, text) from public, anon, authenticated');
    expect(sql).toContain('revoke execute on function public.get_public_job(uuid, uuid) from public, anon, authenticated');
  });

  test('the submit function is a locked-down definer function that only ever returns a word', () => {
    const body = fn('submit_public_application');
    expect(body).toContain("returns text");
    expect(body).toContain("language plpgsql security definer set search_path = ''");
    expect(body).not.toMatch(/\bexecute\s+(format|')/i);
    const returned = [...body.matchAll(/return '([a-z_]+)'/g)].map((m) => m[1]);
    expect([...new Set(returned)].sort()).toEqual([...WORDS].sort());
  });

  test('checks in the order the spec gives: honeypot, lengths, shapes, job, consent, requirements, throttle', () => {
    const body = fn('submit_public_application');
    const order = [
      'p_honeypot', "'name_too_long'", "'invalid_name'", "'not_found'", "'closed'",
      "'consent_required'", "'cv_required'", "'throttled'", 'insert into public.hire_candidates',
      'insert into public.hire_applications',
    ].map((needle) => body.indexOf(needle));
    expect(order.every((at) => at > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test('refuses the demo workspace, a board that is off, a job that is not open or is past its closing date', () => {
    const body = fn('submit_public_application');
    expect(body).toContain("'rimba-ventures-demo'");
    expect(body).toContain('careers_enabled');
    expect(body).toContain("v_status <> 'open'");
    expect(body).toContain("(now() at time zone 'Asia/Kuala_Lumpur')::date");
  });

  test('never overwrites an existing candidate: only a missing phone is filled', () => {
    const body = fn('submit_public_application');
    const updates = [...body.matchAll(/update public\.hire_candidates[\s\S]*?;/g)].map((m) => m[0]);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatch(/set phone = v_phone/);
    expect(updates[0]).toContain('phone is null');
    expect(updates[0]).not.toMatch(/\bname\s*=/);
  });

  test('a repeat application is not an error, and a failed notification does not fail the application', () => {
    const body = fn('submit_public_application');
    expect(body).toContain('on conflict (candidate_id, job_id) do nothing');
    expect(body).toContain('private.deliver_notification');
    expect(body).toMatch(/exception\s+when others then/);
  });

  test('keeps every read and write inside the workspace and the job that were asked for', () => {
    const body = fn('submit_public_application');
    expect(body).toContain('where j.id = p_job_id and j.org_id = p_org_id');
    expect(body).toContain('where c.org_id = p_org_id and lower(c.email) = v_email');
    expect(body).toContain('if v_application_id is not null then');
    // The honeypot is the first thing checked in the body, before any length.
    const begin = body.indexOf('\nbegin\n');
    expect(body.indexOf("btrim(coalesce(p_honeypot, '')) <> ''", begin)).toBeLessThan(body.indexOf("'name_too_long'"));
    // Every part of the closed rule is in the one condition.
    const closed = body.slice(body.indexOf('if not v_enabled'), body.indexOf("return 'closed'"));
    for (const part of ['not v_enabled', "'rimba-ventures-demo'", "v_status <> 'open'", 'v_described is not true', 'v_closes <']) {
      expect(closed, part).toContain(part);
    }
    // A web address and nothing else.
    expect(body).toContain("v_cv !~ '^https?://[^\\s]+$'");
    expect(body).toContain("v_portfolio !~ '^https?://[^\\s]+$'");
    // Nothing is returned but a literal word.
    expect(body.match(/\breturn\b(?! '[a-z_]+';)/g) ?? []).toEqual([]);
  });

  test('a cover letter is trimmed of line breaks as well as spaces, as the page trims it', () => {
    const body = fn('submit_public_application');
    expect(body).toContain("v_cover text := regexp_replace(coalesce(p_cover_letter, ''), '^\\s+|\\s+$', '', 'g');");
  });

  test('the rate limit counts accepted submissions, so a repeat cannot be told from a new one', () => {
    const body = fn('submit_public_application');
    expect(sql).toContain('create table private.hire_apply_ticks');
    expect(sql).toContain('alter table private.hire_apply_ticks enable row level security');
    expect(sql).toContain('revoke all on private.hire_apply_ticks from public, anon, authenticated');
    expect(body).toContain('from private.hire_apply_ticks t');
    expect(body).not.toMatch(/count\(\*\) from public\.hire_applications/);
    // The tick is written after the last refusal and before the candidate is looked up.
    const tick = body.indexOf('insert into private.hire_apply_ticks');
    expect(tick).toBeGreaterThan(body.indexOf("return 'throttled'"));
    expect(tick).toBeLessThan(body.indexOf('insert into public.hire_candidates'));
    expect(body).toContain("raise log 'submit_public_application: notification skipped (%)', sqlstate");
  });

  test('the public job function still shows only open, described jobs of a board that is on', () => {
    const body = fn('get_public_job');
    for (const part of ['s.careers_enabled', "j.status = 'open'", "j.description ~ '\\S'", "o.slug is distinct from 'rimba-ventures-demo'", 'j.org_id = o.id', 'case when j.show_salary then j.salary_min_cents end']) {
      expect(body, part).toContain(part);
    }
  });

  test('the public job function now also says what the form asks for, and still hides what it hid', () => {
    const body = fn('get_public_job');
    const returns = body.slice(body.indexOf('returns table'), body.indexOf('language sql'));
    for (const column of ['require_cv', 'require_cover_letter', 'ask_portfolio', 'ask_expected_salary']) {
      expect(returns, column).toContain(`${column} boolean`);
    }
    for (const hidden of ['headcount', 'status', 'created_at', 'closed_at', 'show_salary']) {
      expect(returns, hidden).not.toContain(hidden);
    }
    expect(body).toContain("language sql security definer stable set search_path = ''");
    expect(sql).toContain('drop function public.get_public_job(uuid, uuid);');
  });
});
