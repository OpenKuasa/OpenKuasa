// tests/hire-talent-pool-migration.test.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const read = (file: string) => readFileSync(join(process.cwd(), 'supabase/migrations', file), 'utf8');
// Comment lines are dropped so an explanation can never satisfy an order check.
const strip = (text: string) => text.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
const sql = strip(read('20261029090000_hire_talent_pool.sql'));
const before = strip(read('20261026090000_hire_candidate_changes.sql'));
// The one-time data change has a file of its own: the three functions can be run again
// safely, and a re-run of them must never repeat it.
const backfill = strip(read('20261029090100_hire_talent_pool_backfill.sql'));
const publicForm = strip(read('20261019090000_hire_cv_upload.sql'));
const fnIn = (source: string, name: string) => {
  const start = source.indexOf(`create or replace function public.${name}(`);
  expect(start, name).toBeGreaterThan(-1);
  const end = source.indexOf('end $$;', start);
  expect(end, name).toBeGreaterThan(start);
  return source.slice(start, end);
};
const fn = (name: string) => fnIn(sql, name);
const flat = (text: string) => text.replace(/\s+/g, ' ').trim();

const NEW = ['hire_set_pool_status', 'hire_move_to_pipeline'] as const;
const MEMBER = 'private.is_org_member(v_org) is not true';
const WRITER = 'private.is_org_writer(v_org) is not true';
const GONE = "if not found then return jsonb_build_object('word', 'not_found'); end if;";
const LOCK_KEY = "pg_advisory_xact_lock(hashtextextended(v_org::text || ':' || v_email, 0))";
const ADD_ARGS = 'uuid, text, text, text, text, text, text[], text, uuid, text, text';

describe('hire talent pool migration', () => {
  test('changes no table, column, trigger, policy or table grant', () => {
    expect(sql).not.toMatch(/alter table|create table|drop table/i);
    expect(sql).not.toMatch(/create policy|drop policy|create trigger|drop trigger/i);
    expect(sql).not.toMatch(/grant[^;]*\bon\s+(table\s+)?(public\.)?hire_/i);
  });

  test.each(NEW)('%s is security definer with an empty search path, answers jsonb and never raises', (name) => {
    const body = fn(name);
    expect(body).toContain('returns jsonb');
    expect(body).toContain('security definer');
    expect(body).toContain("set search_path = ''");
    expect(body).not.toMatch(/\braise\b/i);
    expect(body).not.toMatch(/\bexception\b/i);
  });

  test.each(NEW)('%s checks the member, then the writer, before any lock or write', (name) => {
    const body = fn(name);
    const member = body.indexOf(MEMBER);
    const writer = body.indexOf(WRITER);
    expect(member).toBeGreaterThan(-1);
    expect(writer).toBeGreaterThan(member);
    for (const later of ['for update', 'for share', 'pg_advisory_xact_lock', 'insert into', 'update public.']) {
      const at = body.indexOf(later);
      const absent = name === 'hire_set_pool_status' && ['for share', 'pg_advisory_xact_lock', 'insert into'].includes(later);
      if (absent) expect(at, later).toBe(-1);
      else expect(at, later).toBeGreaterThan(writer);
    }
    // A stranger and a missing row read the same; a viewer of the workspace is told apart.
    expect(body.slice(member, writer)).toContain("jsonb_build_object('word', 'not_found')");
    expect(body.slice(writer, body.indexOf('for update'))).toContain("jsonb_build_object('word', 'forbidden')");
  });

  test('set status: refuses a bad status before the lock, an add over a pool member before a same status, and writes one field', () => {
    const body = fn('hire_set_pool_status');
    const bad = body.indexOf("jsonb_build_object('word', 'invalid_status')");
    const rowLock = body.indexOf('for update');
    const gone = body.indexOf(GONE);
    const already = body.indexOf("jsonb_build_object('word', 'already_in_pool', 'from', v_from)");
    const same = body.indexOf("jsonb_build_object('word', 'same_status', 'from', v_from)");
    const write = body.indexOf('update public.hire_candidates set pool_status = p_status where id = p_candidate_id;');
    expect(bad).toBeGreaterThan(-1);
    expect(rowLock).toBeGreaterThan(bad);
    expect(gone).toBeGreaterThan(rowLock);
    expect(already).toBeGreaterThan(gone);
    expect(same).toBeGreaterThan(already);
    expect(write).toBeGreaterThan(same);
    expect(body).toContain("p_status not in ('none', 'available', 'passive', 're_engaged')");
    // An add may not be a removal.
    expect(body).toContain("(p_only_if_outside is true and p_status = 'none')");
    expect(body).toContain("if p_only_if_outside is true and v_from <> 'none' then");
    expect(body.match(/update public\./g)).toHaveLength(1);
    expect(body).not.toMatch(/delete from|insert into/);
    expect(body.slice(body.lastIndexOf("'word', 'ok'"))).toContain("'from', v_from, 'to', p_status");
  });

  test('move: the job is held, then the email lock, then the candidate\'s row', () => {
    const body = fn('hire_move_to_pipeline');
    const job = body.indexOf('for share');
    const lock = body.indexOf(LOCK_KEY);
    const rowLock = body.indexOf('for update');
    expect(job).toBeGreaterThan(-1);
    expect(lock).toBeGreaterThan(job);
    expect(rowLock).toBeGreaterThan(lock);
    expect(body).toContain('if v_email is not null then');
    expect(body).toContain('lower(c.email)');
    expect(body.match(/pg_advisory_xact_lock/g)).toHaveLength(1);
    // The job must be the candidate's workspace's, and open or paused.
    expect(body).toContain('where j.id = p_job_id and j.org_id = v_org');
    expect(body).toContain("if v_status not in ('open', 'paused') then return jsonb_build_object('word', 'job_not_open'); end if;");
    expect(body).toContain("if v_status is null then return jsonb_build_object('word', 'job_not_found'); end if;");
    // The same key, letter for letter, as the two functions that find a candidate by email.
    const key = "hashtextextended(p_org_id::text || ':' || v_email, 0)";
    expect(read('20261019090000_hire_cv_upload.sql')).toContain(key);
    expect(read('20261026090000_hire_candidate_changes.sql')).toContain(key);
  });

  test('move: only a pool member, one application by hand, and nothing changed when they had applied', () => {
    const body = fn('hire_move_to_pipeline');
    const rowLock = body.indexOf('for update');
    const gone = body.indexOf(GONE);
    const outside = body.indexOf("if v_from = 'none' then return jsonb_build_object('word', 'not_in_pool'); end if;");
    const insert = body.indexOf('insert into public.hire_applications');
    const applied = body.indexOf("jsonb_build_object('word', 'already_applied'");
    const mark = body.indexOf("update public.hire_candidates set pool_status = 're_engaged' where id = p_candidate_id;");
    expect(gone).toBeGreaterThan(rowLock);
    expect(outside).toBeGreaterThan(gone);
    expect(insert).toBeGreaterThan(outside);
    // "Already applied" returns before the pool status is touched.
    expect(applied).toBeGreaterThan(insert);
    expect(mark).toBeGreaterThan(applied);
    const row = flat(body.slice(insert, applied));
    expect(row).toContain('(org_id, candidate_id, job_id, stage, outcome, source)');
    expect(row).toContain("(v_org, p_candidate_id, p_job_id, 'applied', 'active', coalesce(private.hire_one_line(v_source), 'Added by hand'))");
    expect(row).toContain('on conflict (candidate_id, job_id) do nothing');
    // By hand: no consent date, no cover note, no CV.
    expect(body).not.toMatch(/consented_at|cover_letter|cv_url|cv_path/);
    expect(body.slice(applied, mark)).toContain("'application_id', v_application_id, 'outcome', v_outcome");
    expect(body.match(/update public\./g)).toHaveLength(1);
    expect(body.match(/insert into/g)).toHaveLength(1);
    expect(body).not.toContain('delete from');
    expect(body).not.toContain('insert into public.hire_candidates');
    expect(body.slice(body.lastIndexOf("'word', 'ok'"))).toContain("'application_id', v_application_id, 'from', v_from, 'to', 're_engaged'");
  });

  test('hire_add_candidate is the 3b function with one expression changed', () => {
    const was = fnIn(before, 'hire_add_candidate');
    const needle = "v_source, 'none')";
    expect(was.split(needle)).toHaveLength(2);
    expect(fn('hire_add_candidate')).toBe(
      was.replace(needle, "v_source, case when p_job_id is null then 'available' else 'none' end)"),
    );
  });

  test('all three are for signed-in members only', () => {
    const signatures = [
      'hire_set_pool_status(uuid, text, boolean)',
      'hire_move_to_pipeline(uuid, uuid)',
      `hire_add_candidate(${ADD_ARGS})`,
    ];
    for (const signature of signatures) {
      expect(sql).toContain(`revoke execute on function public.${signature} from public, anon, service_role;`);
      expect(sql).toContain(`grant execute on function public.${signature} to authenticated;`);
    }
    expect(sql.match(/grant execute/g)).toHaveLength(3);
    expect(sql).not.toMatch(/grant execute[^;]*to[^;]*\b(anon|service_role|public)\b/i);
  });

  describe('the one-time update', () => {
    const statement = flat(backfill);

    test('the functions file writes no row outside a function, so running it again changes no data', () => {
      const outside = sql.replace(/create or replace function[\s\S]*?end \$\$;/g, '');
      expect(outside).not.toMatch(/\b(update|insert into|delete from)\b/i);
    });
    test('each function is defined once', () => {
      for (const name of [...NEW, 'hire_add_candidate']) {
        expect(sql.split(`create or replace function public.${name}(`), name).toHaveLength(2);
      }
    });
    test('its own file holds that one statement and nothing else', () => {
      expect(statement).toBe(
        "update public.hire_candidates c set pool_status = 'available' " +
          "where c.pool_status = 'none' " +
          'and not exists (select 1 from public.hire_applications a where a.candidate_id = c.id) ' +
          "and c.source is distinct from 'Careers page';",
      );
    });
    test('leaves out exactly the source the public apply form writes', () => {
      // The form's own file is read, so a change of its wording there fails here.
      expect(publicForm).toContain("'Careers page'");
      expect(statement).toContain("c.source is distinct from 'Careers page'");
    });
    test('touches nobody already in the pool, so a row it moved is not moved again', () => {
      expect(statement).toContain("where c.pool_status = 'none'");
      expect(statement).not.toMatch(/pool_status (in|<>|!=)/);
    });
  });
});
