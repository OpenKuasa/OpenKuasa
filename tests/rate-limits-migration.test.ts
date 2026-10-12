// tests/rate-limits-migration.test.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const read = (name: string) => readFileSync(join(process.cwd(), 'supabase/migrations', name), 'utf8');
const sql = read('20261101091500_rate_limits.sql');
const cron = read('20261101093000_rate_limits_cron.sql');

/** One function's text, from its `create` to the end of its body. */
const fn = (name: string) => {
  const start = sql.indexOf(`create or replace function ${name}(`);
  expect(start, name).toBeGreaterThan(-1);
  const end = sql.indexOf('$$;', start);
  return sql.slice(start, end);
};

/** A function's body as it was in an earlier migration, for comparing with what replaced it. */
const earlier = (file: string, name: string) => {
  const text = read(file);
  const start = text.lastIndexOf(`create or replace function ${name}(`);
  expect(start, name).toBeGreaterThan(-1);
  return text.slice(start, text.indexOf('$$;', start));
};

/** Lines that are not blank and not only a comment, trimmed, with a trailing comment removed. */
const code = (text: string) =>
  text.split('\n').map((line) => line.replace(/\s+--.*$/, '').trim()).filter((line) => line && !line.startsWith('--'));

describe('the attempt counter', () => {
  test('lives in the private schema, behind row level security, with no grant to a client', () => {
    expect(sql).toContain('create table private.rate_limits (');
    expect(sql).toContain('primary key (bucket, key, window_start)');
    expect(sql).toContain('alter table private.rate_limits enable row level security;');
    expect(sql).toContain('revoke all on private.rate_limits from public, anon, authenticated;');
    expect(sql).not.toMatch(/create policy [^;]* on private\.rate_limits/);
    expect(sql).not.toMatch(/grant [^;]* on private\.rate_limits/);
  });

  test('counts in one statement, in a window every caller agrees on', () => {
    const body = fn('private.rate_limit_consume');
    expect(body).toContain('security definer');
    expect(body).toContain("set search_path = ''");
    expect(body).toContain('floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds');
    expect(body).toContain('on conflict (bucket, key, window_start)');
    expect(body).toContain('returning r.hits into v_hits');
    expect(body).toContain('allowed := v_hits <= p_limit;');
    // A key's finished windows go as it is used.
    expect(body).toContain('r.window_start < v_start');
  });

  test('the function the server calls takes only hashed keys and is the service role\'s alone', () => {
    const body = fn('public.consume_rate_limits');
    expect(body).toContain('security definer');
    expect(body).toContain("set search_path = ''");
    expect(body).toContain("c.key !~ '^[0-9a-f]{64}$'");
    expect(body).toContain("c.bucket !~ '^[a-z0-9_]{1,48}$'");
    // Always the same order, so two calls that share keys cannot deadlock.
    expect(body).toContain('order by x.bucket, x.key');
    expect(sql).toContain('revoke execute on function public.consume_rate_limits(jsonb) from public, anon, authenticated;');
    expect(sql).toContain('grant execute on function public.consume_rate_limits(jsonb) to service_role;');
  });

  test('neither private function can be run by a client', () => {
    expect(sql).toContain(
      'revoke execute on function private.rate_limit_consume(text, text, integer, integer) from public, anon, authenticated;',
    );
    expect(sql).toContain('revoke execute on function private.rate_limits_sweep() from public, anon, authenticated;');
  });

  test('old windows are swept hourly, a bounded number at a time, by a job in its own migration', () => {
    const body = fn('private.rate_limits_sweep');
    expect(body).toContain("x.expires_at < now() - interval '1 hour'");
    expect(body).toContain('limit 5000');
    expect(sql).not.toContain('cron.schedule');
    expect(cron).toContain("select cron.schedule('rate-limits-sweep', '17 * * * *', $$select private.rate_limits_sweep()$$);");
  });
});

describe('the public write functions', () => {
  test('are the server\'s alone, and nothing in the file is granted to a visitor', () => {
    const SUBMIT_FORM = 'public.submit_public_form(uuid, text, text, text, text, text)';
    const SUBMIT_APPLICATION =
      'public.submit_public_application(uuid, uuid, text, text, text, text, text, text, bigint, boolean, text, text)';
    for (const signature of ['public.record_form_view(uuid, uuid)', SUBMIT_FORM, SUBMIT_APPLICATION]) {
      expect(sql).toContain(`revoke execute on function ${signature} from public, anon, authenticated;`);
      expect(sql).toContain(`grant execute on function ${signature} to service_role;`);
    }
    expect(sql).not.toMatch(/grant [^;]* to [^;]*\b(anon|authenticated|public)\b/);
  });

  test('the read functions are left as they were', () => {
    for (const name of ['get_public_form', 'get_public_careers', 'get_public_job']) {
      expect(sql).not.toMatch(new RegExp(`(function|revoke|grant)[^;]*public\\.${name}\\(`));
    }
  });

  test('a view is counted for whoever the server names, and the old one-argument function is gone', () => {
    expect(sql).toContain('drop function public.record_form_view(uuid);');
    const body = fn('public.record_form_view');
    expect(body).toContain('(p_form_id uuid, p_viewer uuid default null)');
    expect(body).toContain('m.user_id = p_viewer');
    expect(body).not.toContain('auth.uid()');
    expect(body).toContain("f.status = 'active'");
    expect(body).toContain("o.slug is distinct from 'rimba-ventures-demo'");
  });

  test('submit_public_form is its latest definition plus the workspace\'s day', () => {
    const now = code(fn('public.submit_public_form'));
    const was = code(earlier('20261012110000_reach_form_submissions.sql', 'public.submit_public_form'));
    const added = now.filter((line) => !was.includes(line));
    expect(was.filter((line) => !now.includes(line))).toEqual([]);
    expect(added).toEqual([
      "if not (select q.allowed from private.rate_limit_consume('org_form_day', v_org_id::text, 1000, 86400) q) then",
    ]);
    // The form's own limit is still there, and still first.
    const body = fn('public.submit_public_form');
    expect(body.indexOf("interval '1 minute') >= 30")).toBeGreaterThan(-1);
    expect(body.indexOf("interval '1 minute') >= 30")).toBeLessThan(body.indexOf('org_form_day'));
    expect(body.indexOf('org_form_day')).toBeLessThan(body.indexOf('insert into public.form_submissions'));
  });

  test('submit_public_application is its latest definition plus the day and the notification cap', () => {
    const body = fn('public.submit_public_application');
    const now = code(body);
    const was = code(earlier('20261019090000_hire_cv_upload.sql', 'public.submit_public_application'));
    // Nothing of the earlier function is lost, the rule about who may attach a file included.
    expect(was.filter((line) => !now.includes(line))).toEqual([]);
    expect(body).toContain("if v_cv_path is not null and coalesce((select auth.role()), '') <> 'service_role' then");
    expect(body).toContain("private.rate_limit_consume('org_apply_day', p_org_id::text, 300, 86400)");
    expect(body).toContain("private.rate_limit_consume('hire_notify', v_job_id::text, 10, 3600)");
    expect(body).toContain('if v_announced <= 11 then');
    // The job's own limit comes first, and the day is counted before anything is written.
    const perJob = body.indexOf("t.at > now() - interval '1 minute') >= 30");
    expect(perJob).toBeGreaterThan(-1);
    expect(perJob).toBeLessThan(body.indexOf('org_apply_day'));
    expect(body.indexOf('org_apply_day')).toBeLessThan(body.indexOf('insert into private.hire_apply_ticks'));
    // The cap sits inside the block that may fail without losing the application.
    expect(body.indexOf('hire_notify')).toBeLessThan(body.indexOf('exception when others'));
  });
});
