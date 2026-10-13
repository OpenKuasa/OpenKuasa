// tests/hire-interviews-migration.test.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const read = (file: string) => readFileSync(join(process.cwd(), 'supabase/migrations', file), 'utf8');
// Comment lines are dropped so an explanation can never satisfy an order check.
const strip = (text: string) => text.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
const flat = (text: string) => text.replace(/\s+/g, ' ').trim();

const rawColumns = read('20261107090000_hire_interviews_columns.sql');
const rawWrites = read('20261107090100_hire_interviews_writes.sql');
const columns = flat(strip(rawColumns));
const writes = strip(rawWrites);

const FUNCTIONS = {
  hire_schedule_interview: {
    returns: 'jsonb',
    params:
      'p_application_id uuid, p_scheduled_at text, p_duration_minutes integer, p_kind text, ' +
      'p_place text, p_interviewer_name text, p_notes text',
    args: 'uuid, text, integer, text, text, text, text',
  },
  hire_record_past_interview: {
    returns: 'jsonb',
    params:
      'p_application_id uuid, p_scheduled_at text, p_duration_minutes integer, p_kind text, ' +
      'p_outcome text, p_place text, p_interviewer_name text, p_notes text',
    args: 'uuid, text, integer, text, text, text, text, text',
  },
  hire_reschedule_interview: {
    returns: 'jsonb',
    params: 'p_interview_id uuid, p_changes jsonb, p_if_updated_at timestamptz default null',
    args: 'uuid, jsonb, timestamptz',
  },
  hire_cancel_interview: { returns: 'text', params: 'p_interview_id uuid', args: 'uuid' },
  hire_set_interview_outcome: { returns: 'text', params: 'p_interview_id uuid, p_outcome text', args: 'uuid, text' },
  hire_reopen_interview: { returns: 'text', params: 'p_interview_id uuid', args: 'uuid' },
} as const;
type Name = keyof typeof FUNCTIONS;
const NAMES = Object.keys(FUNCTIONS) as Name[];
const INSERTING: Name[] = ['hire_schedule_interview', 'hire_record_past_interview'];
const UPDATING: Name[] = [
  'hire_reschedule_interview',
  'hire_cancel_interview',
  'hire_set_interview_outcome',
  'hire_reopen_interview',
];
const STATUS_ONLY: Name[] = ['hire_cancel_interview', 'hire_set_interview_outcome', 'hire_reopen_interview'];

// One function's text, from its first line to just before its "end $$;", on one line.
const fn = (name: Name) => {
  const start = writes.indexOf(`create or replace function public.${name}(`);
  expect(start, name).toBeGreaterThan(-1);
  const end = writes.indexOf('end $$;', start);
  expect(end, name).toBeGreaterThan(start);
  return flat(writes.slice(start, end));
};
// How a function answers with a word: three answer jsonb (the two that insert, and the one that changes, whose
// `ok` also says whether the time moved), three answer text.
const answer = (name: Name, word: string) =>
  FUNCTIONS[name].returns === 'jsonb' ? `return jsonb_build_object('word', '${word}');` : `return '${word}';`;
// Each of the given pieces is there, and they come in this order. Each is looked for AFTER the one before it:
// a short piece such as "return 'invalid_changes';" can also sit inside an earlier, longer piece.
const inOrder = (body: string, pieces: string[]) => {
  let last = -1;
  for (const piece of pieces) {
    const at = body.indexOf(piece, last + 1);
    expect(at, piece).toBeGreaterThan(last);
    last = at;
  }
};

const MEMBER = 'private.is_org_member(v_org) is not true';
const WRITER = 'private.is_org_writer(v_org) is not true';
const APPLICATION_LOCK =
  'select a.org_id, a.outcome into v_app_org, v_outcome from public.hire_applications a where a.id = p_application_id for update;';
const APPLICATION_LOCK_NO_OUTCOME =
  'select a.org_id into v_app_org from public.hire_applications a where a.id = p_application_id for update;';
const INSERT = 'insert into public.hire_interviews';
const ZONED_REGEX = "'^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2}(\\.\\d{1,6})?)?(Z|[+-]\\d{2}:\\d{2})$'";
const helperText = () => {
  const start = writes.indexOf('create or replace function private.hire_zoned_instant(');
  expect(start).toBeGreaterThan(-1);
  const end = writes.indexOf('end $$;', start);
  expect(end).toBeGreaterThan(start);
  return flat(writes.slice(start, end));
};
const IS_NULL_TIME = (name: Name) => `if v_at is null then ${answer(name, 'invalid_time').replace('return ', 'return ')} end if;`;
const UPDATE = 'update public.hire_interviews';

describe('hire interviews migration: the columns file', () => {
  test('is exactly one alter table and one update', () => {
    const statements = columns.split(';').map((statement) => statement.trim()).filter(Boolean);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toBe(
      'alter table public.hire_interviews ' +
        'add column duration_minutes smallint not null default 60, ' +
        'add column place text, ' +
        'add column notes text, ' +
        'add column updated_at timestamptz not null default now(), ' +
        'add constraint hire_interviews_duration_range check (duration_minutes between 15 and 480), ' +
        'add constraint hire_interviews_place_length check (char_length(place) <= 300), ' +
        'add constraint hire_interviews_notes_length check (char_length(notes) <= 2000), ' +
        'add constraint hire_interviews_interviewer_name_length check (char_length(interviewer_name) <= 120)',
    );
    expect(statements[1]).toBe('update public.hire_interviews set updated_at = created_at');
  });

  test('adds four columns and four named checks, the house way', () => {
    expect(columns.match(/add column/g)).toHaveLength(4);
    expect(columns.match(/add constraint hire_interviews_\w+ check \(/g)).toHaveLength(4);
    // Every earlier hiring migration adds its columns plainly.
    expect(columns).not.toMatch(/if not exists/i);
  });

  test('holds no function, grant, policy, trigger or other write, and leaves the demo reseed alone', () => {
    expect(columns).not.toMatch(/create (or replace )?function/i);
    expect(columns).not.toMatch(/\bgrant\b|\brevoke\b/i);
    expect(columns).not.toMatch(/create policy|drop policy|alter policy|create trigger|drop trigger/i);
    expect(columns).not.toMatch(/create table|drop table|drop column|drop constraint|create index/i);
    expect(columns).not.toMatch(/insert into|delete from/i);
    expect(columns.match(/\bupdate\b/g)).toHaveLength(1);
    expect(rawColumns).not.toContain('reseed_demo_hire');
  });
});

describe('hire interviews migration: the writes file', () => {
  test('changes no table, column, trigger, policy or table grant, and does not mention the demo reseed', () => {
    expect(writes).not.toMatch(/alter table|create table|drop table/i);
    expect(writes).not.toMatch(/create policy|drop policy|alter policy|create trigger|drop trigger/i);
    expect(writes).not.toMatch(/grant[^;]*\bon\s+(table\s+)?(public\.)?hire_/i);
    expect(rawWrites).not.toContain('reseed_demo_hire');
  });

  test('holds the six functions and, outside them, only their revokes and grants', () => {
    expect(writes.match(/create or replace function/g)).toHaveLength(7);
    expect(writes.match(/create or replace function public\.hire_/g)).toHaveLength(6);
    const outside = writes.replace(/create or replace function[\s\S]*?end \$\$;/g, '');
    const statements = outside.split(';').map((statement) => flat(statement)).filter(Boolean);
    expect(statements).toHaveLength(13);
    for (const statement of statements) {
      expect(statement).toMatch(
        /^(revoke execute on function private\.hire_zoned_instant\(text\) from public, anon, authenticated|revoke execute on function public\.hire_\w+\([^)]*\) from public, anon, service_role|grant execute on function public\.hire_\w+\([^)]*\) to authenticated)$/,
      );
    }
  });

  test.each(NAMES)('%s has its exact arguments, is security definer with an empty search path, and never raises', (name) => {
    const body = fn(name);
    const head = body.slice(0, body.indexOf(' returns ')).replace('( ', '(').replace(/ \)$/, ')');
    expect(head).toBe(`create or replace function public.${name}(${FUNCTIONS[name].params})`);
    expect(body).toContain(`returns ${FUNCTIONS[name].returns} language plpgsql security definer set search_path = '' as $$`);
    expect(body).not.toMatch(/\braise\b/i);
    expect(body).not.toMatch(/\bexception\b/i);
    // Every table is named with its schema: the search path is empty.
    expect(body).not.toMatch(/\b(from|join|into|update)\s+hire_/);
    // The caller never names a workspace.
    expect(body).not.toMatch(/\bp_(org|tenant|workspace)/);
  });

  test.each(NAMES)('%s checks the member, then the writer, before any lock or write', (name) => {
    const body = fn(name);
    const begin = body.indexOf(' begin ');
    const member = body.indexOf(MEMBER);
    const writer = body.indexOf(WRITER);
    const firstLock = body.indexOf('for update');
    expect(begin).toBeGreaterThan(-1);
    expect(member).toBeGreaterThan(begin);
    expect(writer).toBeGreaterThan(member);
    expect(firstLock).toBeGreaterThan(writer);
    // Before the two checks: one read, of the row's workspace, and nothing else.
    expect(body.slice(begin, member).match(/\bselect\b/g)).toHaveLength(1);
    expect(body.slice(begin, member)).toContain('.org_id');
    for (const later of ['insert into', 'update public.', 'delete from', 'exists (']) {
      const at = body.indexOf(later);
      if (at !== -1) expect(at, later).toBeGreaterThan(writer);
    }
    expect(body).not.toContain('delete from');
    // A stranger and a missing row read the same; a viewer of the workspace is told apart.
    expect(body.slice(member, writer)).toContain(answer(name, 'not_found'));
    expect(body.slice(writer, firstLock)).toContain(answer(name, 'forbidden'));
    // After every lock, a row that has gone answers not_found.
    const gone = `if not found then ${answer(name, 'not_found')} end if;`;
    expect(body.split(gone)).toHaveLength(body.split('for update').length);
  });

  test.each(INSERTING)('%s locks the application, then inserts one row with the application\'s own workspace', (name) => {
    const body = fn(name);
    const lock = body.indexOf(name === 'hire_schedule_interview' ? APPLICATION_LOCK : APPLICATION_LOCK_NO_OUTCOME);
    const gone = body.indexOf(`if not found then ${answer(name, 'not_found')} end if;`);
    const sameOrg = body.indexOf(`if v_app_org is distinct from v_org then ${answer(name, 'not_found')} end if;`);
    const insert = body.indexOf(INSERT);
    expect(lock).toBeGreaterThan(body.indexOf(WRITER));
    expect(gone).toBeGreaterThan(lock);
    expect(sameOrg).toBeGreaterThan(gone);
    expect(insert).toBeGreaterThan(sameOrg);
    expect(body.match(/for update/g)).toHaveLength(1);
    expect(body.match(/insert into/g)).toHaveLength(1);
    expect(body).not.toContain('update public.');
    const row = body.slice(insert);
    expect(row).toContain('(org_id, application_id, scheduled_at, duration_minutes, kind, place, interviewer_name, notes, status)');
    const status = name === 'hire_schedule_interview' ? "'scheduled'" : 'p_outcome';
    expect(row).toContain(
      `(v_app_org, p_application_id, v_at, p_duration_minutes::smallint, p_kind, v_place, v_interviewer, v_notes, ${status})`,
    );
    expect(row).toContain('returning id into v_id;');
    expect(row).toContain("return jsonb_build_object('word', 'ok', 'id', v_id);");
  });

  test('schedule: only an active application, the arguments in order, not in the past, not too far ahead, not twice', () => {
    const body = fn('hire_schedule_interview');
    inOrder(body, [
      APPLICATION_LOCK,
      "if v_outcome <> 'active' then return jsonb_build_object('word', 'not_active'); end if;",
      'v_at := private.hire_zoned_instant(p_scheduled_at);',
      "if v_at is null then return jsonb_build_object('word', 'invalid_time'); end if;",
      'if p_duration_minutes is null or p_duration_minutes < 15 or p_duration_minutes > 480 then',
      "return jsonb_build_object('word', 'invalid_duration');",
      "if p_kind is null or p_kind not in ('video', 'onsite', 'phone') then",
      "return jsonb_build_object('word', 'invalid_kind');",
      "if char_length(v_place) > 300 then return jsonb_build_object('word', 'invalid_place'); end if;",
      "if char_length(v_interviewer) > 120 then return jsonb_build_object('word', 'invalid_interviewer'); end if;",
      "if char_length(v_notes) > 2000 then return jsonb_build_object('word', 'invalid_notes'); end if;",
      "if v_at < now() - interval '5 minutes' then return jsonb_build_object('word', 'in_past'); end if;",
      "if v_at > now() + interval '366 days' then return jsonb_build_object('word', 'too_far_ahead'); end if;",
      "where i.application_id = p_application_id and i.status = 'scheduled' and i.scheduled_at = v_at",
      "return jsonb_build_object('word', 'duplicate');",
      INSERT,
    ]);
    expect(body).toContain('v_place text := private.hire_one_line(p_place);');
    expect(body).toContain('v_interviewer text := private.hire_one_line(p_interviewer_name);');
    expect(body).toContain("v_notes text := nullif(regexp_replace(coalesce(p_notes, ''), '^\\s+|\\s+$', '', 'g'), '');");
    expect(body).not.toMatch(/not_past|too_far_back|invalid_outcome/);
  });

  test('record past: any outcome of the application, only completed or no-show, not in the future, not too far back', () => {
    const body = fn('hire_record_past_interview');
    inOrder(body, [
      APPLICATION_LOCK_NO_OUTCOME,
      'v_at := private.hire_zoned_instant(p_scheduled_at);',
      "if v_at is null then return jsonb_build_object('word', 'invalid_time'); end if;",
      'if p_duration_minutes is null or p_duration_minutes < 15 or p_duration_minutes > 480 then',
      "return jsonb_build_object('word', 'invalid_duration');",
      "if p_kind is null or p_kind not in ('video', 'onsite', 'phone') then",
      "return jsonb_build_object('word', 'invalid_kind');",
      "if p_outcome is null or p_outcome not in ('completed', 'no_show') then",
      "return jsonb_build_object('word', 'invalid_outcome');",
      "if char_length(v_place) > 300 then return jsonb_build_object('word', 'invalid_place'); end if;",
      "if char_length(v_interviewer) > 120 then return jsonb_build_object('word', 'invalid_interviewer'); end if;",
      "if char_length(v_notes) > 2000 then return jsonb_build_object('word', 'invalid_notes'); end if;",
      "if v_at > now() then return jsonb_build_object('word', 'not_past'); end if;",
      "if v_at < now() - interval '366 days' then return jsonb_build_object('word', 'too_far_back'); end if;",
      "where i.application_id = p_application_id and i.status <> 'cancelled' and i.scheduled_at = v_at",
      "return jsonb_build_object('word', 'duplicate');",
      INSERT,
    ]);
    // It never looks at whether the application is active.
    expect(body).not.toContain("'active'");
    expect(body).not.toContain('a.outcome');
    expect(body).not.toContain('v_outcome');
    expect(body).not.toContain('not_active');
    // It is never created as scheduled, and the past rule of scheduling is not here.
    expect(body).not.toContain("'scheduled'");
    expect(body).not.toMatch(/in_past|too_far_ahead/);
  });

  test('reschedule: the shape of the changes is checked before any lock', () => {
    const body = fn('hire_reschedule_interview');
    expect(body).toContain(
      "c_keys constant text[] := array['scheduled_at','duration_minutes','kind','place','interviewer_name','notes'];",
    );
    inOrder(body, [
      'select i.org_id, i.application_id into v_org, v_application from public.hire_interviews i where i.id = p_interview_id;',
      WRITER,
      "if p_changes is null or jsonb_typeof(p_changes) <> 'object' then return jsonb_build_object('word', 'invalid_changes'); end if;",
      'if exists (select 1 from jsonb_object_keys(p_changes) as k(key) where k.key <> all (c_keys)) then',
      "return jsonb_build_object('word', 'invalid_changes');",
      'for update',
    ]);
  });

  test('reschedule: the application is locked before the interview', () => {
    const body = fn('hire_reschedule_interview');
    const applicationLock = body.indexOf('for update');
    const interviewLock = body.indexOf('for update', applicationLock + 1);
    expect(interviewLock).toBeGreaterThan(applicationLock);
    expect(body.match(/for update/g)).toHaveLength(2);
    const first = body.slice(body.indexOf(WRITER), applicationLock);
    expect(first).toContain('select a.org_id, a.outcome into v_app_org, v_outcome from public.hire_applications a where a.id = v_application');
    expect(first).not.toContain('into v_row');
    const second = body.slice(applicationLock, interviewLock);
    expect(second).toContain("if not found then return jsonb_build_object('word', 'not_found'); end if;");
    // The interview's application must be in the interview's own workspace, checked under the application's lock
    // and before the interview is read or locked.
    inOrder(second, [
      "if not found then return jsonb_build_object('word', 'not_found'); end if;",
      "if v_app_org is distinct from v_org then return jsonb_build_object('word', 'not_found'); end if;",
      'select i.* into v_row from public.hire_interviews i where i.id = p_interview_id',
    ]);
    expect(second).toContain('select i.* into v_row from public.hire_interviews i where i.id = p_interview_id');
    expect(body.slice(interviewLock, interviewLock + 110)).toContain("if not found then return jsonb_build_object('word', 'not_found'); end if;");
  });

  test('reschedule: changed, then the two states, then each value, then unchanged, then the time rules, then one update', () => {
    const body = fn('hire_reschedule_interview');
    const interviewLock = body.lastIndexOf('for update');
    const changed = body.indexOf(
      "if p_if_updated_at is not null and p_if_updated_at is distinct from v_row.updated_at then return jsonb_build_object('word', 'changed'); end if;",
    );
    expect(changed).toBeGreaterThan(interviewLock);
    inOrder(body, [
      "return jsonb_build_object('word', 'changed');",
      "if v_row.status <> 'scheduled' then return jsonb_build_object('word', 'not_scheduled'); end if;",
      "if v_outcome <> 'active' then return jsonb_build_object('word', 'not_active'); end if;",
      "return jsonb_build_object('word', 'invalid_time');",
      "return jsonb_build_object('word', 'invalid_duration');",
      "return jsonb_build_object('word', 'invalid_kind');",
      "return jsonb_build_object('word', 'invalid_place');",
      "return jsonb_build_object('word', 'invalid_interviewer');",
      "return jsonb_build_object('word', 'invalid_notes');",
      "return jsonb_build_object('word', 'unchanged');",
      'if v_at <> v_row.scheduled_at then',
      "if v_at < now() - interval '5 minutes' then return jsonb_build_object('word', 'in_past'); end if;",
      "if v_at > now() + interval '366 days' then return jsonb_build_object('word', 'too_far_ahead'); end if;",
      "where i.application_id = v_application and i.id <> p_interview_id and i.status = 'scheduled' and i.scheduled_at = v_at",
      "return jsonb_build_object('word', 'duplicate');",
      UPDATE,
    ]);
    // Nothing is written on changed, unchanged or duplicate: each returns before the one update.
    expect(body.match(/update public\./g)).toHaveLength(1);
    expect(body).not.toContain('insert into');
    expect(body).toContain(
      'update public.hire_interviews set scheduled_at = v_at, duration_minutes = v_duration::smallint, kind = v_kind, ' +
        'place = v_place, interviewer_name = v_interviewer, notes = v_notes, updated_at = now() where id = p_interview_id;',
    );
    // The answer says whether the stored time is another instant than it was: v_row still holds the row as it was
    // locked, before the update. The invitation's "has a new time" rests on this and on nothing the caller sent.
    expect(body.slice(body.indexOf(UPDATE))).toContain(
      "return jsonb_build_object('word', 'ok', 'moved', v_at <> v_row.scheduled_at);",
    );
    expect(body.match(/'moved'/g)).toHaveLength(1);
    expect(body).not.toContain("return jsonb_build_object('word', 'ok');");
    // Never a bare word: every answer of this function is jsonb.
    expect(body).not.toMatch(/return '[a-z_]+';/);
  });

  test('reschedule: unchanged means none of the six values differs', () => {
    const body = fn('hire_reschedule_interview');
    expect(body).toContain(
      'if v_at = v_row.scheduled_at and v_duration = v_row.duration_minutes and v_kind = v_row.kind ' +
        'and v_place is not distinct from v_row.place ' +
        'and v_interviewer is not distinct from v_row.interviewer_name ' +
        "and v_notes is not distinct from v_row.notes then return jsonb_build_object('word', 'unchanged'); end if;",
    );
  });

  test('reschedule: a key that is absent keeps the stored value, and null clears only place, interviewer and notes', () => {
    const body = fn('hire_reschedule_interview');
    for (const start of [
      'v_at := v_row.scheduled_at;',
      'v_duration := v_row.duration_minutes;',
      'v_kind := v_row.kind;',
      'v_place := v_row.place;',
      'v_interviewer := v_row.interviewer_name;',
      'v_notes := v_row.notes;',
    ]) {
      expect(body, start).toContain(start);
    }
    for (const key of ['scheduled_at', 'duration_minutes', 'kind', 'place', 'interviewer_name', 'notes']) {
      expect(body, key).toContain(`if p_changes ? '${key}' then`);
    }
    // Null is refused for the three that cannot be empty.
    expect(body).toContain("if jsonb_typeof(p_changes -> 'scheduled_at') <> 'string'");
    expect(body).toContain("if jsonb_typeof(p_changes -> 'duration_minutes') <> 'number' then return jsonb_build_object('word', 'invalid_duration'); end if;");
    expect(body).toContain("if jsonb_typeof(p_changes -> 'kind') <> 'string' or v_kind not in ('video', 'onsite', 'phone') then");
    // Null clears the other three.
    expect(body).toContain("if jsonb_typeof(p_changes -> 'place') not in ('string', 'null') then return jsonb_build_object('word', 'invalid_place'); end if;");
    expect(body).toContain("v_place := private.hire_one_line(p_changes ->> 'place');");
    expect(body).toContain(
      "if jsonb_typeof(p_changes -> 'interviewer_name') not in ('string', 'null') then return jsonb_build_object('word', 'invalid_interviewer'); end if;",
    );
    expect(body).toContain("v_interviewer := private.hire_one_line(p_changes ->> 'interviewer_name');");
    expect(body).toContain("if jsonb_typeof(p_changes -> 'notes') not in ('string', 'null') then return jsonb_build_object('word', 'invalid_notes'); end if;");
    expect(body).toContain("v_notes := nullif(regexp_replace(coalesce(p_changes ->> 'notes', ''), '^\\s+|\\s+$', '', 'g'), '');");
    expect(body).toContain("if char_length(v_place) > 300 then return jsonb_build_object('word', 'invalid_place'); end if;");
    expect(body).toContain("if char_length(v_interviewer) > 120 then return jsonb_build_object('word', 'invalid_interviewer'); end if;");
    expect(body).toContain("if char_length(v_notes) > 2000 then return jsonb_build_object('word', 'invalid_notes'); end if;");
    expect(body).toContain("if v_number <> trunc(v_number) or v_number < 15 or v_number > 480 then return jsonb_build_object('word', 'invalid_duration'); end if;");
  });

  test('reschedule: a time that is not a real instant with a zone is refused by the shared helper, before any cast here', () => {
    const body = fn('hire_reschedule_interview');
    inOrder(body, [
      "if p_changes ? 'scheduled_at' then",
      "if jsonb_typeof(p_changes -> 'scheduled_at') <> 'string' then return jsonb_build_object('word', 'invalid_time'); end if;",
      "v_at := private.hire_zoned_instant(p_changes ->> 'scheduled_at');",
      "if v_at is null then return jsonb_build_object('word', 'invalid_time'); end if;",
    ]);
    expect(body).not.toContain('::timestamptz');
  });

  test('the shared helper refuses text without a zone or that is not a real instant, and casts only after both checks', () => {
    const body = helperText();
    expect(body).toContain(
      "create or replace function private.hire_zoned_instant(p_text text) returns timestamptz language plpgsql stable set search_path = '' as $$",
    );
    inOrder(body, [
      'begin',
      'if p_text is null',
      `or p_text !~ ${ZONED_REGEX}`,
      "or pg_input_is_valid(p_text, 'timestamptz') is not true then",
      'return null;',
      'return p_text::timestamptz;',
    ]);
    expect(body.match(/::timestamptz/g)).toHaveLength(1);
    expect(body).not.toMatch(/\braise\b|\bexception\b/i);
    expect(writes).toContain('revoke execute on function private.hire_zoned_instant(text) from public, anon, authenticated;');
    expect(writes).not.toMatch(/grant[^;]*hire_zoned_instant/);
  });

  test.each(INSERTING)('%s takes the time as text and never casts it itself', (name) => {
    const body = fn(name);
    expect(body).toContain('p_scheduled_at text,');
    expect(body).not.toMatch(/p_scheduled_at timestamptz/);
    expect(body).not.toContain('::timestamptz');
    expect(body.match(/p_scheduled_at/g)).toHaveLength(2); // the parameter and the one helper call
    expect(body).toContain('v_at timestamptz;');
    // The helper answers before any write, and after the caller checks and the application lock (the order is pinned above).
    expect(body.indexOf('private.hire_zoned_instant(p_scheduled_at)')).toBeLessThan(body.indexOf('insert into'));
    expect(body.indexOf(IS_NULL_TIME(name))).toBeGreaterThan(body.indexOf('private.hire_zoned_instant(p_scheduled_at)'));
  });

  test('no function in the file has a timestamptz parameter that a caller\'s text would be cast into for a time', () => {
    expect(writes).not.toMatch(/p_scheduled_at timestamptz/);
    for (const name of INSERTING) expect(writes).not.toContain(`${name}(uuid, timestamptz`);
  });

  test.each(STATUS_ONLY)('%s locks the interview only and never reads the application', (name) => {
    const body = fn(name);
    expect(body.match(/for update/g)).toHaveLength(1);
    expect(body).toContain('select i.status into v_status from public.hire_interviews i where i.id = p_interview_id for update;');
    expect(body).not.toContain('hire_applications');
    expect(body.match(/update public\./g)).toHaveLength(1);
    expect(body).not.toContain('insert into');
  });

  test('cancel: only a scheduled interview, and it becomes cancelled', () => {
    inOrder(fn('hire_cancel_interview'), [
      'for update',
      "if v_status <> 'scheduled' then return 'not_scheduled'; end if;",
      "update public.hire_interviews set status = 'cancelled', updated_at = now() where id = p_interview_id;",
      "return 'ok';",
    ]);
  });

  test('outcome: completed or no-show only, and only for a scheduled interview', () => {
    inOrder(fn('hire_set_interview_outcome'), [
      'for update',
      "if p_outcome is null or p_outcome not in ('completed', 'no_show') then return 'invalid_outcome'; end if;",
      "if v_status <> 'scheduled' then return 'not_scheduled'; end if;",
      'update public.hire_interviews set status = p_outcome, updated_at = now() where id = p_interview_id;',
      "return 'ok';",
    ]);
  });

  test('reopen: only a closed interview, and it becomes scheduled with its time as it was', () => {
    const body = fn('hire_reopen_interview');
    inOrder(body, [
      'for update',
      "if v_status = 'scheduled' then return 'not_closed'; end if;",
      "update public.hire_interviews set status = 'scheduled', updated_at = now() where id = p_interview_id;",
      "return 'ok';",
    ]);
    expect(body).not.toContain('scheduled_at');
  });

  test.each(UPDATING)('%s sets updated_at = now() in its one update', (name) => {
    const body = fn(name);
    const update = body.slice(body.indexOf(UPDATE));
    expect(update.slice(0, update.indexOf(';'))).toContain('updated_at = now()');
  });

  test('all six are for signed-in members only', () => {
    for (const name of NAMES) {
      const signature = `${name}(${FUNCTIONS[name].args})`;
      expect(writes).toContain(`revoke execute on function public.${signature} from public, anon, service_role;`);
      expect(writes).toContain(`grant execute on function public.${signature} to authenticated;`);
    }
    expect(writes.match(/revoke execute/g)).toHaveLength(7);
    expect(writes.match(/grant execute/g)).toHaveLength(6);
    expect(writes).not.toMatch(/grant execute[^;]*to[^;]*\b(anon|service_role|public)\b/i);
  });
});
