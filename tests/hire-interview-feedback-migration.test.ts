// tests/hire-interview-feedback-migration.test.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const read = (file: string) => readFileSync(join(process.cwd(), 'supabase/migrations', file), 'utf8');
// Comment lines are dropped so an explanation can never satisfy an order check.
const strip = (text: string) => text.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
const flat = (text: string) => text.replace(/\s+/g, ' ').trim();

const COLUMNS_FILE = '20261113090000_hire_interview_feedback_columns.sql';
const WRITES_FILE = '20261113090100_hire_interview_feedback_writes.sql';
const rawColumns = read(COLUMNS_FILE);
const rawWrites = read(WRITES_FILE);
const columns = flat(strip(rawColumns));
const writes = strip(rawWrites);
/** 4a's functions, as they were merged: the text `hire_reopen_interview` is compared with. */
const before = strip(read('20261107090100_hire_interviews_writes.sql'));

// One function's text in a file, from its first line to just before its "end $$;", on one line.
const bodyIn = (source: string, name: string) => {
  const start = source.indexOf(`create or replace function public.${name}(`);
  expect(start, name).toBeGreaterThan(-1);
  const end = source.indexOf('end $$;', start);
  expect(end, name).toBeGreaterThan(start);
  return flat(source.slice(start, end));
};
const fn = (name: string) => bodyIn(writes, name);
// Each of the given pieces is there, and they come in this order. Each is looked for AFTER the one before it.
const inOrder = (body: string, pieces: string[]) => {
  let last = -1;
  for (const piece of pieces) {
    const at = body.indexOf(piece, last + 1);
    expect(at, piece).toBeGreaterThan(last);
    last = at;
  }
};
/** A function's one update statement, without its closing semicolon. */
const updateOf = (body: string) => {
  const from = body.indexOf('update public.hire_interviews');
  expect(from).toBeGreaterThan(-1);
  return body.slice(from, body.indexOf(';', from));
};

const SAVE = 'hire_save_interview_feedback';
const CLEAR = 'hire_clear_interview_feedback';
const REOPEN = 'hire_reopen_interview';
const NAMES = [SAVE, CLEAR, REOPEN];
const ARGS: Record<string, string> = {
  [SAVE]: 'uuid, integer, text, text, boolean, boolean, timestamptz',
  [CLEAR]: 'uuid',
  [REOPEN]: 'uuid',
};
const ORG_READ = 'select i.org_id into v_org from public.hire_interviews i where i.id = p_interview_id;';
const MEMBER = 'private.is_org_member(v_org) is not true';
const WRITER = 'private.is_org_writer(v_org) is not true';
const word = (w: string) => `return jsonb_build_object('word', '${w}');`;

describe('interview feedback migration: the columns file', () => {
  test('is exactly one alter table: four nullable columns and five named checks', () => {
    const statements = columns.split(';').map((statement) => statement.trim()).filter(Boolean);
    expect(statements).toEqual([
      'alter table public.hire_interviews ' +
        'add column feedback_rating smallint, ' +
        'add column feedback_recommendation text, ' +
        'add column feedback_comments text, ' +
        'add column feedback_at timestamptz, ' +
        'add constraint hire_interviews_feedback_rating_range check (feedback_rating between 1 and 5), ' +
        'add constraint hire_interviews_feedback_recommendation_known check (feedback_recommendation in (\'advance\', \'hold\', \'reject\')), ' +
        'add constraint hire_interviews_feedback_comments_length check (char_length(feedback_comments) <= 2000), ' +
        'add constraint hire_interviews_feedback_whole check (' +
        '(feedback_at is null and feedback_rating is null and feedback_recommendation is null and feedback_comments is null) ' +
        'or (feedback_at is not null and feedback_rating is not null and feedback_recommendation is not null)), ' +
        'add constraint hire_interviews_feedback_when_completed check (feedback_at is null or status = \'completed\')',
    ]);
  });

  test('gives no column a default and none a not null, so every existing row has no feedback and passes both table checks', () => {
    expect(columns.match(/add column/g)).toHaveLength(4);
    expect(columns).not.toMatch(/\bdefault\b/i);
    expect(columns).not.toMatch(/not null,/i);
    // Every earlier hiring migration adds its columns plainly.
    expect(columns).not.toMatch(/if not exists/i);
  });

  test('holds no function, grant, policy, trigger or write of any row, and leaves the demo refill alone', () => {
    expect(columns).not.toMatch(/create (or replace )?function/i);
    expect(columns).not.toMatch(/\bgrant\b|\brevoke\b/i);
    expect(columns).not.toMatch(/create policy|drop policy|alter policy|create trigger|drop trigger/i);
    expect(columns).not.toMatch(/create table|drop table|drop column|drop constraint|create index/i);
    expect(columns).not.toMatch(/insert into|delete from|\bupdate\b/i);
    expect(rawColumns).not.toContain('reseed_demo_hire');
  });
});

describe('interview feedback migration: the writes file', () => {
  test('changes no table, column, trigger, policy or table grant, never raises, and does not mention the demo refill', () => {
    expect(writes).not.toMatch(/alter table|create table|drop table/i);
    expect(writes).not.toMatch(/create policy|drop policy|alter policy|create trigger|drop trigger/i);
    expect(writes).not.toMatch(/grant[^;]*\bon\s+(table\s+)?(public\.)?hire_/i);
    expect(writes).not.toMatch(/raise\s+exception/i);
    expect(rawWrites).not.toContain('reseed_demo_hire');
  });

  test('holds the three functions and, outside them, only their revokes and grants', () => {
    expect(writes.match(/create or replace function/g)).toHaveLength(3);
    expect(writes.match(/create or replace function public\.hire_/g)).toHaveLength(3);
    const outside = writes.replace(/create or replace function[\s\S]*?end \$\$;/g, '');
    const statements = outside.split(';').map((statement) => flat(statement)).filter(Boolean);
    expect(statements).toHaveLength(6);
    for (const statement of statements) {
      expect(statement).toMatch(
        /^(revoke execute on function public\.hire_\w+\([^)]*\) from public, anon, service_role|grant execute on function public\.hire_\w+\([^)]*\) to authenticated)$/,
      );
    }
  });

  test('all three are for signed-in members only: the server\'s own role gets nothing', () => {
    for (const name of NAMES) {
      const signature = `${name}(${ARGS[name]})`;
      expect(writes, name).toContain(`revoke execute on function public.${signature} from public, anon, service_role;`);
      expect(writes, name).toContain(`grant execute on function public.${signature} to authenticated;`);
    }
    expect(writes).not.toMatch(/to\s+(anon|public|service_role)\b/i);
  });

  test.each(NAMES)('%s is security definer with an empty search path, and takes no workspace from the caller', (name) => {
    const body = fn(name);
    expect(body).toContain('language plpgsql security definer set search_path = \'\' as $$');
    expect(body).not.toMatch(/p_org\w*/);
    // Every table is named with its schema.
    expect(body).not.toMatch(/(from|update|join)\s+hire_/i);
  });

  test('the signatures are the ones the capabilities call', () => {
    expect(fn(SAVE).startsWith(
      'create or replace function public.hire_save_interview_feedback( ' +
        'p_interview_id uuid, p_rating integer, p_recommendation text, p_comments text, ' +
        'p_mark_completed boolean default false, p_replace boolean default false, p_if_feedback_at timestamptz default null ) ' +
        'returns jsonb language plpgsql',
    )).toBe(true);
    expect(fn(CLEAR).startsWith('create or replace function public.hire_clear_interview_feedback(p_interview_id uuid) returns text language plpgsql')).toBe(true);
    expect(fn(REOPEN).startsWith('create or replace function public.hire_reopen_interview(p_interview_id uuid) returns text language plpgsql')).toBe(true);
  });

  test.each(NAMES)('%s locks the interview\'s row and nothing else, writes it once, and never reads the application', (name) => {
    const body = fn(name);
    expect(body.match(/for update/g)).toHaveLength(1);
    expect(body.match(/update public\./g)).toHaveLength(1);
    expect(body).not.toContain('insert into');
    expect(body).not.toContain('delete from');
    expect(body).not.toContain('hire_applications');
    expect(body).not.toContain('hire_candidates');
  });

  test('save: both caller checks, then the lock, then the rules in order, then one update and the answer', () => {
    const body = fn(SAVE);
    inOrder(body, [
      ORG_READ,
      MEMBER, word('not_found'),
      WRITER, word('forbidden'),
      'select i.status, i.feedback_at into v_status, v_feedback_at from public.hire_interviews i where i.id = p_interview_id for update;',
      `if not found then ${word('not_found')} end if;`,
      `if p_if_feedback_at is not null and p_if_feedback_at is distinct from v_feedback_at then ${word('changed')} end if;`,
      `if v_status = 'scheduled' and p_mark_completed is not true then ${word('not_completed')} end if;`,
      `if v_status not in ('scheduled', 'completed') then ${word('not_completed')} end if;`,
      `if v_feedback_at is not null and p_replace is not true then ${word('has_feedback')} end if;`,
      `if p_rating is null or p_rating < 1 or p_rating > 5 then ${word('invalid_rating')} end if;`,
      `if p_recommendation is null or p_recommendation not in ('advance', 'hold', 'reject') then ${word('invalid_recommendation')} end if;`,
      `if char_length(v_comments) > 2000 then ${word('invalid_comments')} end if;`,
      'update public.hire_interviews',
      'return jsonb_build_object(\'word\', \'ok\', \'replaced\', v_feedback_at is not null, \'completed\', v_status = \'scheduled\');',
    ]);
    // Nothing is read under a lock, or written, before the two caller checks.
    expect(body.indexOf(WRITER)).toBeLessThan(body.indexOf('for update'));
    expect(body.indexOf(WRITER)).toBeLessThan(body.indexOf('update public.'));
  });

  test('save: the status and the feedback are one write, the comments are trimmed and a blank is stored as none', () => {
    const body = fn(SAVE);
    expect(updateOf(body)).toBe(
      'update public.hire_interviews set status = \'completed\', feedback_rating = p_rating::smallint, feedback_recommendation = p_recommendation, ' +
        'feedback_comments = v_comments, feedback_at = clock_timestamp(), updated_at = now() where id = p_interview_id',
    );
    expect(body).toContain('v_comments text := nullif(regexp_replace(coalesce(p_comments, \'\'), \'^\\s+|\\s+$\', \'\', \'g\'), \'\');');
    // The comments that are stored and measured are the trimmed ones, never the parameter itself.
    expect(body.match(/p_comments/g)).toHaveLength(2); // the parameter and the one trim
  });

  test('save: what it answers about the row comes from the row as it was locked, never from what was sent', () => {
    const body = fn(SAVE);
    const answer = body.slice(body.indexOf('return jsonb_build_object(\'word\', \'ok\''));
    expect(answer).not.toContain('p_replace');
    expect(answer).not.toContain('p_mark_completed');
  });

  test('clear: both caller checks, the lock, only an interview that has feedback, and the four columns go together', () => {
    const body = fn(CLEAR);
    inOrder(body, [
      ORG_READ,
      MEMBER, 'return \'not_found\';',
      WRITER, 'return \'forbidden\';',
      'select i.feedback_at into v_feedback_at from public.hire_interviews i where i.id = p_interview_id for update;',
      'if not found then return \'not_found\'; end if;',
      'if v_feedback_at is null then return \'no_feedback\'; end if;',
      'update public.hire_interviews',
      'return \'ok\';',
    ]);
    expect(updateOf(body)).toBe(
      'update public.hire_interviews set feedback_rating = null, feedback_recommendation = null, feedback_comments = null, feedback_at = null, ' +
        'updated_at = now() where id = p_interview_id',
    );
    // The interview stays completed: its status is neither read nor written.
    expect(body).not.toContain('status');
  });

  test('reopen: 4a\'s function copied whole, with three fragments added and nothing else changed', () => {
    const was = bodyIn(before, REOPEN);
    const now = fn(REOPEN);
    const steps: [string, string][] = [
      ['v_status text; begin', 'v_status text; v_has_feedback boolean; begin'],
      ['select i.status into v_status from', 'select i.status, i.feedback_at is not null into v_status, v_has_feedback from'],
      [
        'if v_status = \'scheduled\' then return \'not_closed\'; end if;',
        'if v_status = \'scheduled\' then return \'not_closed\'; end if; if v_has_feedback then return \'has_feedback\'; end if;',
      ],
    ];
    let expected = was;
    for (const [from, to] of steps) {
      // Each anchor is in 4a's text exactly once: a replacement that found nothing would prove nothing.
      expect(expected.split(from), from).toHaveLength(2);
      expected = expected.replace(from, to);
    }
    expect(now).toBe(expected);
  });

  test('reopen: still everything 4a\'s test asserted, the owner\'s choice of no duplicate check kept, and the new word after not_closed', () => {
    const body = fn(REOPEN);
    inOrder(body, [
      ORG_READ,
      MEMBER, 'return \'not_found\';',
      WRITER, 'return \'forbidden\';',
      'for update',
      'if not found then return \'not_found\'; end if;',
      'if v_status = \'scheduled\' then return \'not_closed\'; end if;',
      'if v_has_feedback then return \'has_feedback\'; end if;',
      'update public.hire_interviews set status = \'scheduled\', updated_at = now() where id = p_interview_id;',
      'return \'ok\';',
    ]);
    expect(body).not.toContain('scheduled_at');
    expect(body).not.toMatch(/\bexists\s*\(/i);
    expect(rawWrites).toContain('Deliberately no duplicate check on this undo');
  });

  test.each(NAMES)('%s sets updated_at = now() in its one update', (name) => {
    expect(updateOf(fn(name))).toContain('updated_at = now()');
  });
});
