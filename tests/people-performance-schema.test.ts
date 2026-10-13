import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const DIR = join(process.cwd(), 'supabase/migrations');
const PERFORMANCE = '20261028090000_people_performance_writes.sql';
const TRAINING = '20261028090100_people_training_announcements_writes.sql';
const SEED = '20261028090200_people_performance_demo_seed.sql';
const FILES = [PERFORMANCE, TRAINING, SEED];
const PAYROLL = '20261027090000_people_payroll_writes.sql';
const HIRE_DELETIONS = '20261028090000_hire_deletions.sql';

const raw = (file: string) => readFileSync(join(DIR, file), 'utf8');

/** A migration's statements, without its comment lines (they describe the rules in words the checks would trip on). */
const statements = (file: string) =>
  raw(file)
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');

/** The two files that hold the rules, read as one. */
const rules = () => `${statements(PERFORMANCE)}\n${statements(TRAINING)}`;

type Fn = { name: string; args: string; file: string; gate: string; returns: 'jsonb' | 'int' };

/** The seventeen functions the app calls: the argument types their grants name, and the gate each passes before it writes. */
const FUNCTIONS: Fn[] = [
  { name: 'hr_save_goal', args: 'uuid, uuid, text, int, date, boolean', file: PERFORMANCE, gate: 'private.hr_perf_held_employee(p_employee, true)', returns: 'jsonb' },
  { name: 'hr_delete_goal', args: 'uuid', file: PERFORMANCE, gate: 'private.hr_perf_held_employee(owner_id, true)', returns: 'jsonb' },
  { name: 'hr_save_review', args: 'uuid, uuid, text, jsonb, text, text', file: PERFORMANCE, gate: 'private.hr_perf_held_employee(p_employee, false)', returns: 'jsonb' },
  { name: 'hr_release_review', args: 'uuid', file: PERFORMANCE, gate: 'private.hr_perf_held_review(p_review)', returns: 'jsonb' },
  { name: 'hr_unrelease_review', args: 'uuid', file: PERFORMANCE, gate: 'private.hr_perf_held_review(p_review)', returns: 'jsonb' },
  { name: 'hr_delete_review', args: 'uuid', file: PERFORMANCE, gate: 'private.hr_perf_held_review(p_review)', returns: 'jsonb' },
  { name: 'hr_save_training', args: 'uuid, uuid, text, text, text, date, date', file: TRAINING, gate: 'private.hr_perf_held_training(p_org, p_training)', returns: 'jsonb' },
  { name: 'hr_delete_training', args: 'uuid', file: TRAINING, gate: 'private.hr_perf_held_training(null, p_training)', returns: 'jsonb' },
  { name: 'hr_enrol', args: 'uuid, uuid', file: TRAINING, gate: 'private.hr_perf_held_employee(p_employee, true)', returns: 'jsonb' },
  { name: 'hr_unenrol', args: 'uuid, uuid', file: TRAINING, gate: 'private.hr_perf_held_employee(p_employee, true)', returns: 'jsonb' },
  { name: 'hr_set_training_completed', args: 'uuid, uuid, boolean', file: TRAINING, gate: 'private.hr_perf_held_employee(p_employee, false)', returns: 'jsonb' },
  { name: 'hr_save_announcement', args: 'uuid, uuid, text, text, text, boolean', file: TRAINING, gate: 'private.hr_ann_held(p_org, p_announcement)', returns: 'jsonb' },
  { name: 'hr_publish_announcement', args: 'uuid', file: TRAINING, gate: 'private.hr_ann_held(null, p_announcement)', returns: 'jsonb' },
  { name: 'hr_unpublish_announcement', args: 'uuid', file: TRAINING, gate: 'private.hr_ann_held(null, p_announcement)', returns: 'jsonb' },
  { name: 'hr_delete_announcement', args: 'uuid', file: TRAINING, gate: 'private.hr_ann_held(null, p_announcement)', returns: 'jsonb' },
  { name: 'hr_mark_announcements_read', args: 'uuid', file: TRAINING, gate: 'private.is_demo_org(p_org)', returns: 'jsonb' },
  { name: 'hr_unread_announcements', args: 'uuid', file: TRAINING, gate: 'private.is_demo_org(p_org)', returns: 'int' },
];
const HELPERS: Record<string, string[]> = {
  [PERFORMANCE]: ['private.hr_perf_caller_name', 'private.hr_perf_held_employee', 'private.hr_perf_held_review', 'private.hr_review_json'],
  [TRAINING]: ['private.hr_perf_held_training', 'private.hr_perf_course', 'private.hr_ann_held', 'private.hr_announcement_json', 'private.hr_ann_unread'],
};
const PERF_CODES = [
  'PERF_NOT_ALLOWED', 'PERF_NOT_FOUND', 'PERF_BAD_INPUT', 'PERF_TOO_MANY_GOALS', 'PERF_REVIEW_EXISTS', 'PERF_NOT_DRAFT',
  'PERF_NOT_RELEASED', 'PERF_ALREADY_ENROLLED', 'PERF_NOT_ENROLLED', 'PERF_COURSE_ENDED', 'PERF_COURSE_STARTED',
  'PERF_COURSE_NOT_STARTED', 'PERF_COMPLETED', 'PERF_INACTIVE_EMPLOYEE',
];
const ANN_CODES = ['ANN_NOT_ALLOWED', 'ANN_NOT_FOUND', 'ANN_BAD_INPUT', 'ANN_NOT_DRAFT', 'ANN_NOT_PUBLISHED'];

/** One function's text: `header` up to `as $$`, `body` from there to its closing `$$;`. */
function fn(text: string, qualified: string): { header: string; body: string } {
  const start = text.indexOf(`create or replace function ${qualified}(`);
  expect(start, qualified).toBeGreaterThan(-1);
  const open = text.indexOf(' as $$', start);
  const close = text.indexOf('$$;', open + 6);
  return { header: text.slice(start, open), body: text.slice(open, close) };
}

/** Every function a file creates, by its qualified name. */
const allFunctions = (text: string) =>
  [...text.matchAll(/create or replace function ((?:public|private)\.\w+)\(/g)].map((m) => m[1]);

/** Where the first statement that changes a row begins. */
function firstWrite(body: string): number {
  const at = ['insert into public.', 'update public.', 'delete from public.'].map((s) => body.indexOf(s)).filter((i) => i > -1);
  return at.length ? Math.min(...at) : -1;
}

/** The bare messages of every `raise exception` in a piece of text. */
const raised = (text: string) => [...text.matchAll(/raise exception ([^;]*);/g)].map((m) => m[1]);
const codes = (text: string) => [...new Set(raised(text).map((m) => m.slice(1, -1)))].sort();

describe('Lekiu performance, training and announcements migrations', () => {
  test('the three files exist, in order, after everything they build on, each alone on its version', () => {
    const files = readdirSync(DIR).sort();
    const at = FILES.map((f) => files.indexOf(f));
    expect(at.every((i) => i > -1)).toBe(true);
    expect(at).toEqual([at[0], at[0] + 1, at[0] + 2]);
    expect(at[0]).toBeGreaterThan(files.indexOf(PAYROLL));
    // 20261028090000 is one of the known earlier pairs (tests/migration-versions.test.ts): hire_deletions shares it.
    const sharing = (f: string) => files.filter((x) => x.slice(0, 14) === f.slice(0, 14) && x !== HIRE_DELETIONS);
    for (const f of FILES) expect(sharing(f), f).toEqual([f]);
    expect(FILES.map((f) => f.slice(0, 14))).toEqual(['20261028090000', '20261028090100', '20261028090200']);
  });

  test('reviews: the columns and checks of the spec, and a score to two decimals', () => {
    const text = statements(PERFORMANCE);
    for (const line of [
      "add column competencies jsonb not null default '{}'::jsonb,",
      'add column comment text check (comment is null or char_length(comment) <= 2000),',
      "add column status text not null default 'draft' check (status in ('draft','released')),",
      'add column released_at timestamptz,',
      'add column reviewer_id uuid references auth.users(id) on delete set null,',
      "add constraint hr_reviews_released_at check ((status = 'released') = (released_at is not null));",
      'alter table public.hr_reviews alter column score type numeric(3,2);',
    ]) {
      expect(text, line).toContain(line);
    }
    expect(text.match(/add column/g)).toHaveLength(5);
    expect(text.match(/alter column/g)).toHaveLength(1);
    // Goals get no column; the scorecards and every other table are left alone.
    expect([...new Set(text.match(/alter table public\.(\w+)/g))]).toEqual(['alter table public.hr_reviews']);
    expect(text).not.toMatch(/create table|drop (table|column)|hr_scorecards/);
  });

  test('training and announcements: the columns and checks of the spec', () => {
    const text = statements(TRAINING);
    for (const line of [
      'add column completed_at timestamptz,',
      'add column completed_by uuid references auth.users(id) on delete set null;',
      "add column status text not null default 'published' check (status in ('draft','published')),",
      'add column author_id uuid references auth.users(id) on delete set null,',
      'add column edited_at timestamptz,',
      'alter column published_at drop not null,',
      "add constraint hr_announcements_published_at check ((status = 'published') = (published_at is not null)),",
      'add constraint hr_announcements_body_length check (char_length(body) <= 5000);',
    ]) {
      expect(text, line).toContain(line);
    }
    expect(text.match(/add column/g)).toHaveLength(5);
    expect(text.match(/alter column/g)).toHaveLength(1);
    // The course table, with the status the deployed app still reads, is not touched.
    expect([...new Set(text.match(/alter table public\.(\w+)/g))]).toEqual([
      'alter table public.hr_training_enrolments',
      'alter table public.hr_announcements',
      'alter table public.hr_announcement_reads',
    ]);
    expect(text).not.toMatch(/drop (table|column|default)|hr_scorecards/);
    expect(text).toContain('insert into public.hr_trainings (org_id, title, category, provider, starts_on, ends_on)');
    expect(text).not.toMatch(/update public\.hr_trainings[^;]*status/);
  });

  test('read marks: the table of the spec, row level security on, one\'s own rows only, and no way to write', () => {
    const text = statements(TRAINING);
    expect(text).toContain(
      'create table public.hr_announcement_reads (\n'
        + '  announcement_id uuid not null references public.hr_announcements(id) on delete cascade,\n'
        + '  user_id uuid not null references auth.users(id) on delete cascade,\n'
        + '  read_at timestamptz not null default now(),\n'
        + '  primary key (announcement_id, user_id)\n'
        + ');',
    );
    expect(text.match(/create table/g)).toHaveLength(1);
    expect(text).toContain('alter table public.hr_announcement_reads enable row level security;');
    expect(text).toContain(
      'create policy hr_announcement_reads_select on public.hr_announcement_reads for select to authenticated\n'
        + '  using (user_id = (select auth.uid()));',
    );
    expect(text).toContain(
      'create policy mfa_required on public.hr_announcement_reads as restrictive for all to authenticated\n'
        + '  using ((select private.mfa_ok())) with check ((select private.mfa_ok()));',
    );
    expect(text).toContain('revoke all on public.hr_announcement_reads from anon, authenticated;');
    expect(text).toContain('grant select on public.hr_announcement_reads to authenticated;');
  });

  test('a review is read by owners and admins, by its employee once released, and by the demo', () => {
    const text = statements(PERFORMANCE);
    const drop = text.indexOf('drop policy hr_reviews_select on public.hr_reviews;');
    const create = text.indexOf(
      'create policy hr_reviews_select on public.hr_reviews for select to authenticated using (\n'
        + '  private.is_org_admin(org_id)\n'
        + "  or (status = 'released' and private.is_own_employee(employee_id))\n"
        + '  or (private.is_demo_org(org_id) and private.is_org_member(org_id)));',
    );
    expect(drop).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(drop);
    expect(text.match(/create policy/g)).toHaveLength(1);
  });

  test('an announcement is read by owners and admins, by every member once published, and by the demo', () => {
    const text = statements(TRAINING);
    const drop = text.indexOf('drop policy hr_announcements_select on public.hr_announcements;');
    const create = text.indexOf(
      'create policy hr_announcements_select on public.hr_announcements for select to authenticated using (\n'
        + '  private.is_org_admin(org_id)\n'
        + "  or (status = 'published' and private.is_org_member(org_id))\n"
        + '  or (private.is_demo_org(org_id) and private.is_org_member(org_id)));',
    );
    expect(drop).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(drop);
    expect((text.match(/create policy (\w+) on (\w+\.\w+)/g) ?? []).sort()).toEqual([
      'create policy hr_announcement_reads_select on public.hr_announcement_reads',
      'create policy hr_announcements_select on public.hr_announcements',
      'create policy mfa_required on public.hr_announcement_reads',
    ]);
  });

  test('no table gets a write grant or a write policy, and each keeps its second-factor policy', () => {
    const text = rules();
    expect((text.match(/grant [^;]*;/g) ?? []).sort()).toEqual(
      [
        ...FUNCTIONS.map((f) => `grant execute on function public.${f.name}(${f.args}) to authenticated;`),
        'grant select on public.hr_announcement_reads to authenticated;',
      ].sort(),
    );
    expect(text).not.toMatch(/grant\s+(all|insert|update|delete|truncate)/i);
    expect(text).not.toMatch(/disable row level security/i);
    expect(text).not.toMatch(/drop policy mfa_required/);
    expect(text.match(/drop policy/g)).toHaveLength(2);
    expect(text).not.toMatch(/for (all|insert|update|delete) to authenticated\s+using \((?!\(select private\.mfa_ok)/);
    expect(statements(SEED)).not.toMatch(/\bgrant\b|(create|drop) policy|alter table|create table/);
  });

  test('the seventeen functions, and no other in the public schema', () => {
    for (const file of [PERFORMANCE, TRAINING]) {
      const made = allFunctions(statements(file));
      expect(made.filter((n) => n.startsWith('public.'))).toEqual(FUNCTIONS.filter((f) => f.file === file).map((f) => `public.${f.name}`));
      expect(made.filter((n) => n.startsWith('private.'))).toEqual(HELPERS[file]);
      expect(new Set(made).size).toBe(made.length);
    }
    expect(FUNCTIONS).toHaveLength(17);
  });

  test.each(FUNCTIONS)('$name runs as the owner on a fixed search path, for signed-in users only', ({ name, args, file, returns }) => {
    const text = statements(file);
    const { header } = fn(text, `public.${name}`);
    expect(header).toMatch(new RegExp(`returns ${returns} language plpgsql (stable )?security definer set search_path = public$`));
    // As many arguments as the grant names.
    expect(header.slice(header.indexOf('(') + 1, header.indexOf(')')).split(',')).toHaveLength(args.split(', ').length);
    expect(text).toContain(`revoke all on function public.${name}(${args}) from public, anon;`);
    expect(text).toContain(`grant execute on function public.${name}(${args}) to authenticated;`);
  });

  test.each(FUNCTIONS)('$name passes its gate, which refuses the demo, before it changes anything', ({ name, file, gate }) => {
    const text = statements(file);
    const { body } = fn(text, `public.${name}`);
    const call = body.indexOf(gate);
    expect(call, name).toBeGreaterThan(-1);
    const write = firstWrite(body);
    if (name === 'hr_unread_announcements') expect(write).toBe(-1);
    else expect(write, name).toBeGreaterThan(call);
    // Nobody is let in on being a writer, or on a role read here.
    expect(body, name).not.toMatch(/is_org_writer|\brole\b/);
  });

  test('the gates: signed in, the row held before it is read, hidden from outsiders, never the demo', () => {
    const all = rules();
    const gates: [string, string, string][] = [
      ['private.hr_perf_held_employee', 'select e.* into emp from public.hr_employees e where e.id = p_employee for no key update;', 'PERF'],
      ['private.hr_perf_held_review', 'select r.* into rev from public.hr_reviews r where r.id = p_review for update;', 'PERF'],
      ['private.hr_perf_held_training', 'select t.* into course from public.hr_trainings t where t.id = p_training for update;', 'PERF'],
      ['private.hr_ann_held', 'select a.* into ann from public.hr_announcements a where a.id = p_announcement for update;', 'ANN'],
    ];
    for (const [name, lock, prefix] of gates) {
      const { body } = fn(all, name);
      const signedIn = body.indexOf(`if auth.uid() is null then raise exception '${prefix}_NOT_ALLOWED'; end if;`);
      const held = body.indexOf(lock);
      const missing = body.indexOf(`if not found then raise exception '${prefix}_NOT_FOUND'; end if;`, held);
      const hidden = body.indexOf(`raise exception '${prefix}_NOT_FOUND';`, missing + 10);
      const demo = body.lastIndexOf(`then raise exception '${prefix}_NOT_ALLOWED'; end if;`);
      const order = [signedIn, held, missing, hidden, demo];
      expect(order.every((i) => i > -1), name).toBe(true);
      expect([...order].sort((a, b) => a - b), name).toEqual(order);
      expect(body, name).toContain('private.is_demo_org(');
      expect(body, name).toContain('private.is_org_admin(');
      expect(body, name).not.toMatch(/is_org_writer/);
    }
    // An enrolment holds its course too, shared, so the dates it is judged by cannot change under it.
    const course = fn(all, 'private.hr_perf_course').body;
    expect(course).toContain('select t.* into course from public.hr_trainings t where t.id = p_training and t.org_id = p_org for share;');
    for (const name of ['hr_enrol', 'hr_unenrol', 'hr_set_training_completed']) {
      const { body } = fn(all, `public.${name}`);
      const held = body.indexOf('private.hr_perf_held_employee(p_employee, ');
      const shared = body.indexOf('course := private.hr_perf_course(p_training, emp.org_id);');
      expect(held, name).toBeGreaterThan(-1);
      expect(shared, name).toBeGreaterThan(held);
      expect(body.indexOf('from public.hr_training_enrolments'), name).toBeGreaterThan(shared);
    }
    // A goal is read only once its employee's row is held; a review to change, under its own lock.
    const goal = fn(all, 'public.hr_save_goal').body;
    expect(goal.indexOf('from public.hr_goals')).toBeGreaterThan(goal.indexOf('private.hr_perf_held_employee(p_employee, true)'));
    expect(fn(all, 'public.hr_delete_goal').body).toContain('delete from public.hr_goals g where g.id = p_goal and g.employee_id = emp.id;');
    expect(fn(all, 'public.hr_save_review').body).toContain(
      'select r.* into rev from public.hr_reviews r where r.id = p_review and r.employee_id = emp.id for update;',
    );
    // Only marking needs the course to have started: a completion can always be undone.
    expect(fn(all, 'public.hr_set_training_completed').body).toContain(
      "if p_completed and (course.starts_on is null or today < course.starts_on) then raise exception 'PERF_COURSE_NOT_STARTED'; end if;",
    );
    // Only the employee gate ever lets someone in on the row being their own, and only when asked to.
    expect(all.match(/is_own_employee/g)).toHaveLength(2);
    expect(fn(all, 'private.hr_perf_held_employee').body).toContain('(p_own and private.is_own_employee(emp.id))');
    // A new course or announcement: the workspace named, for its owners and admins, never the demo.
    for (const [name, prefix] of [['private.hr_perf_held_training', 'PERF'], ['private.hr_ann_held', 'ANN']]) {
      const { body } = fn(all, name);
      expect(body).toContain(
        `if p_org is null or private.is_demo_org(p_org) or not private.is_org_admin(p_org) then\n      raise exception '${prefix}_NOT_ALLOWED';`,
      );
    }
  });

  test('a draft review is the only one changed or deleted, and the score is the database\'s', () => {
    const text = statements(PERFORMANCE);
    const save = fn(text, 'public.hr_save_review').body;
    expect(save.indexOf("raise exception 'PERF_NOT_DRAFT'")).toBeLessThan(firstWrite(save));
    expect(save).toContain("p_period !~ '^(H1|H2|FY) (20[0-9][0-9]|2100)$'");
    expect(save).toContain("array['Delivery','Teamwork','Ownership','Communication']");
    expect(save).toContain('if v < 1 or v > 5 or v * 2 <> trunc(v * 2) then');
    expect(save).toContain('round(total / 4, 2)');
    expect(save).toContain("'draft'");
    expect(save).not.toContain("'released'");
    for (const name of ['hr_release_review', 'hr_delete_review']) {
      const { body } = fn(text, `public.${name}`);
      expect(body.indexOf("if rev.status <> 'draft' then raise exception 'PERF_NOT_DRAFT'; end if;"), name).toBeGreaterThan(-1);
      expect(body.indexOf("raise exception 'PERF_NOT_DRAFT'"), name).toBeLessThan(firstWrite(body));
    }
    const back = fn(text, 'public.hr_unrelease_review').body;
    expect(back).toContain("if rev.status <> 'released' then raise exception 'PERF_NOT_RELEASED'; end if;");
    expect(back).toContain("set status = 'draft', released_at = null");
    expect(fn(text, 'public.hr_release_review').body).toContain("set status = 'released', released_at = now()");
  });

  test('today is today in Malaysia, and nothing reads another clock', () => {
    const text = rules();
    expect(text.match(/now\(\) at time zone '[^']*'/g)?.every((m) => m.includes('Asia/Kuala_Lumpur'))).toBe(true);
    expect(text.match(/\(now\(\) at time zone 'Asia\/Kuala_Lumpur'\)::date/g)).toHaveLength(4);
    expect(text).not.toMatch(/current_date|current_timestamp|clock_timestamp|localtime/i);
  });

  test('unread is one rule: published, after the person joined, and not marked by them', () => {
    const text = statements(TRAINING);
    const { body } = fn(text, 'private.hr_ann_unread');
    expect(body).toContain('join public.org_members m on m.org_id = a.org_id and m.user_id = auth.uid()');
    expect(body).toContain("a.status = 'published' and a.published_at > m.created_at");
    expect(body).toContain('x.announcement_id = a.id and x.user_id = auth.uid()');
    for (const name of ['hr_mark_announcements_read', 'hr_unread_announcements']) {
      const fnBody = fn(text, `public.${name}`).body;
      expect(fnBody, name).toContain('private.hr_ann_unread(p_org)');
      expect(fnBody, name).toContain('private.is_org_member(p_org)');
      expect(fnBody, name).not.toMatch(/p_user|user_id\s*=\s*p_/);
    }
    // A mark is only ever the caller's own.
    expect(text.match(/insert into public\.hr_announcement_reads/g)).toHaveLength(1);
    expect(fn(text, 'public.hr_mark_announcements_read').body).toContain('select u.id, auth.uid() from private.hr_ann_unread(p_org) as u(id)');
  });

  test('the helpers are private, on a fixed search path, and closed to the API roles', () => {
    for (const file of [PERFORMANCE, TRAINING]) {
      const text = statements(file);
      for (const helper of HELPERS[file]) {
        const { header } = fn(text, helper);
        expect(header, helper).toContain('set search_path = public');
        expect(text, helper).toMatch(
          new RegExp(`revoke all on function ${helper.replace('.', '\\.')}\\([^)]*\\) from public, anon, authenticated;`),
        );
      }
    }
  });

  test('a refusal is one of the nineteen codes and carries nothing else', () => {
    const text = rules();
    const messages = raised(text);
    expect(messages.length).toBeGreaterThan(40);
    // Every raise is a `raise exception '<CODE>'`: no notice, no format arguments, no `using`.
    expect(text.match(/\braise /g)).toHaveLength(messages.length);
    for (const message of messages) expect(message).toMatch(/^'[A-Z_]+'$/);
    expect(codes(text)).toEqual([...PERF_CODES, ...ANN_CODES].sort());
    // Announcements answer in their own codes, everything else in the performance ones.
    const announcements = [
      ...FUNCTIONS.filter((f) => f.name.includes('announcement')).map((f) => `public.${f.name}`),
      'private.hr_ann_held',
    ].map((name) => fn(text, name).body).join('\n');
    expect(codes(announcements)).toEqual([...ANN_CODES].sort());
    const rest = [
      ...FUNCTIONS.filter((f) => !f.name.includes('announcement')).map((f) => `public.${f.name}`),
      ...HELPERS[PERFORMANCE],
      'private.hr_perf_held_training',
      'private.hr_perf_course',
    ].map((name) => fn(text, name).body).join('\n');
    expect(codes(rest)).toEqual([...PERF_CODES].sort());
    expect(codes(statements(PERFORMANCE)).filter((c) => c.startsWith('ANN_'))).toEqual([]);
  });

  test('the third file is the demo re-seed and nothing else, and does not run it', () => {
    const text = statements(SEED);
    expect(allFunctions(text)).toEqual(['private.reseed_demo_people']);
    expect(fn(text, 'private.reseed_demo_people').header).toContain('returns void language plpgsql security definer set search_path = public');
    expect(text).toContain('revoke all on function private.reseed_demo_people() from public, anon, authenticated;');
    expect(raw(SEED)).not.toMatch(/(select|perform)\s+private\.reseed_demo_people/);
    // Outside the function there is nothing but that revoke.
    const outside = text.slice(0, text.indexOf('create or replace function')) + text.slice(text.indexOf('$$;') + 3);
    expect(outside.trim()).toBe('revoke all on function private.reseed_demo_people() from public, anon, authenticated;');
    expect(raised(text)).toEqual(["'demo org missing'"]);
  });

  test('only the reviews, the enrolments and the announcements of the demo re-seed differ from the payroll slice\'s', () => {
    const parts = (file: string) => fn(raw(file), 'private.reseed_demo_people').body.split('\n\n');
    const before = parts(PAYROLL);
    const after = parts(SEED);
    expect(after).toHaveLength(before.length);
    expect(before.length).toBeGreaterThan(30);
    const changed = after.map((part, i) => (part === before[i] ? null : i)).filter((i): i is number => i !== null);
    expect(changed).toHaveLength(3);
    const tables = ['hr_reviews', 'hr_training_enrolments', 'hr_announcements'];
    changed.forEach((i, k) => {
      for (const part of [before[i], after[i]]) {
        expect(part.match(/insert into public\.(\w+) \(/g), tables[k]).toEqual([`insert into public.${tables[k]} (`]);
        expect(part).not.toMatch(/\b(delete|update|perform)\b/);
      }
    });
    const [reviews, enrolments, announcements] = changed.map((i) => after[i]);
    // Reviews: the four scores in half steps, the score their average, all released but two.
    expect(reviews).toContain("jsonb_build_object('Delivery', v.d, 'Teamwork', v.t, 'Ownership', v.o, 'Communication', v.c)");
    expect(reviews).toContain('round((v.d + v.t + v.o + v.c) / 4, 2)');
    expect(reviews).toContain("case when e.n in (10, 16) then 'draft' else 'released' end");
    expect(reviews).toMatch(/comment/);
    // Enrolments marked completed carry the time.
    expect(enrolments).toContain('completed, completed_at)');
    expect(enrolments).toContain("case when t.status = 'completed' then");
    // One announcement is a draft, with no time; the five there were are still published.
    expect(announcements.match(/'published', \d+\)/g)).toHaveLength(5);
    expect(announcements.match(/'draft', \d+\)/g)).toHaveLength(1);
    expect(announcements).toContain("case when v.status = 'published' then now() - make_interval(days => v.ago) end");
    for (const line of before[changed[2]].split('\n').filter((l) => l.trim().startsWith("('"))) {
      expect(announcements, line).toContain(line.replace(/, (\d+)\)(,?)$/, ", 'published', $1)"));
    }
  });
});
