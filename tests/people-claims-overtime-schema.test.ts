import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const DIR = join(process.cwd(), 'supabase/migrations');
const WRITES = '20261020090000_people_claims_overtime_writes.sql';

/** The migration's statements, without its comment lines (they describe the rules in words the checks would trip on). */
const writes = () =>
  readFileSync(join(DIR, WRITES), 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');

/** The nine functions the app calls, with the argument types their grants name. */
const FUNCTIONS: { name: string; args: string }[] = [
  { name: 'hr_submit_claim', args: 'uuid, text, bigint, date, text, text' },
  { name: 'hr_cancel_claim', args: 'uuid' },
  { name: 'hr_decide_claim', args: 'uuid, boolean, text' },
  { name: 'hr_mark_claim_paid', args: 'uuid, date, text' },
  { name: 'hr_unmark_claim_paid', args: 'uuid' },
  { name: 'hr_overtime_preview', args: 'uuid, date, numeric' },
  { name: 'hr_submit_overtime', args: 'uuid, date, numeric, text' },
  { name: 'hr_cancel_overtime', args: 'uuid' },
  { name: 'hr_decide_overtime', args: 'uuid, boolean, text' },
];

/** The functions that act on a saved request, and the table each one reads it from. */
const ON_A_REQUEST: { name: string; table: string }[] = [
  { name: 'hr_cancel_claim', table: 'hr_claims' },
  { name: 'hr_decide_claim', table: 'hr_claims' },
  { name: 'hr_mark_claim_paid', table: 'hr_claims' },
  { name: 'hr_unmark_claim_paid', table: 'hr_claims' },
  { name: 'hr_cancel_overtime', table: 'hr_overtime_records' },
  { name: 'hr_decide_overtime', table: 'hr_overtime_records' },
];
const ADMIN_ONLY = ['hr_decide_claim', 'hr_mark_claim_paid', 'hr_unmark_claim_paid', 'hr_decide_overtime'];

const CODES = [
  'PAY_NOT_ALLOWED',
  'PAY_NOT_FOUND',
  'PAY_NOT_PENDING',
  'PAY_NOT_APPROVED',
  'PAY_NOT_PAID',
  'PAY_ALREADY_PAID',
  'PAY_INACTIVE_EMPLOYEE',
  'PAY_TOO_MANY_HOURS',
  'PAY_BAD_RECEIPT',
  'PAY_BAD_INPUT',
];

/** One function's text: `header` up to `as $$`, `body` from there to its closing `$$;`. */
function fn(text: string, qualified: string): { header: string; body: string } {
  const start = text.indexOf(`create or replace function ${qualified}(`);
  expect(start, qualified).toBeGreaterThan(-1);
  const open = text.indexOf(' as $$', start);
  const close = text.indexOf('$$;', open + 6);
  return { header: text.slice(start, open), body: text.slice(open, close) };
}

/** Every function the file creates, by its qualified name. */
function allFunctions(text: string): string[] {
  return [...text.matchAll(/create or replace function ((?:public|private)\.\w+)\(/g)].map((m) => m[1]);
}

/** One storage policy's text, from `create policy <name>` to its semicolon. */
function policy(text: string, name: string): string {
  const start = text.indexOf(`create policy ${name} on storage.objects`);
  expect(start, name).toBeGreaterThan(-1);
  return text.slice(start, text.indexOf(';', start) + 1);
}

describe('Lekiu claims and overtime migration', () => {
  test('sorts after the migrations it builds on, alone on its timestamp', () => {
    // 20261018100000 was the latest file when this was written.
    expect(WRITES > '20261018100000_hire_public_applications.sql').toBe(true);
    const files = readdirSync(DIR);
    expect(files).toContain(WRITES);
    expect(files.filter((f) => f.startsWith('20261020090000'))).toEqual([WRITES]);
  });

  test('adds exactly the columns in the spec', () => {
    const text = writes();
    for (const line of [
      // hr_claims
      'add column requested_by uuid references auth.users(id) on delete set null,',
      'add column decision_note text check (decision_note is null or char_length(decision_note) <= 500),',
      'add column receipt_path text,',
      'add column paid_on date,',
      'add column paid_reference text check (paid_reference is null or char_length(paid_reference) <= 100),',
      'add column paid_by uuid references auth.users(id) on delete set null,',
      'add constraint hr_claims_description_length check (description is null or char_length(description) <= 500);',
      // hr_overtime_records
      'add column reason text check (reason is null or char_length(reason) <= 500),',
      'add column hourly_rate_cents bigint check (hourly_rate_cents is null or hourly_rate_cents >= 0),',
      "add column day_kind text check (day_kind is null or day_kind in ('weekday','rest_day','public_holiday'));",
    ]) {
      expect(text).toContain(line);
    }
    expect(text.match(/add column/g)).toHaveLength(11);
    expect(text.match(/add column requested_by uuid references auth\.users\(id\) on delete set null,/g)).toHaveLength(2);
    expect(text.match(/add column decision_note text check/g)).toHaveLength(2);
    // Every new column is nullable with no default, so the demo seed needs no change.
    expect(text).not.toMatch(/add column[^,;]*\b(not null|default)\b/);
    expect([...new Set(text.match(/alter table public\.(\w+)/g))]).toEqual([
      'alter table public.hr_claims',
      'alter table public.hr_overtime_records',
    ]);
    expect(text).not.toMatch(/drop (table|column|policy|function|index)/);
    expect(text).not.toMatch(/alter table storage\./);
    expect(text).not.toMatch(/alter column/);
  });

  test('a claim can be paid, and the paid columns follow the status', () => {
    const text = writes();
    // The old status check is found by what it says, never by a guessed name.
    expect(text).toContain("where con.conrelid = 'public.hr_claims'::regclass and con.contype = 'c'");
    expect(text).toContain("pg_get_constraintdef(con.oid) like '%status%'");
    expect(text).toContain("execute format('alter table public.hr_claims drop constraint %I', c.conname);");
    expect(text).not.toMatch(/drop constraint (if exists )?hr_claims/);
    // And finding nothing to drop stops the migration.
    expect(text).toContain("if dropped = 0 then raise exception 'the status check on hr_claims was not found'; end if;");
    expect(text).toContain("check (status in ('pending','approved','rejected','cancelled','paid')),");
    expect(text).toContain("check ((status = 'paid') = (paid_on is not null)");
    expect(text).toContain("and (status = 'paid' or (paid_reference is null and paid_by is null)));");
    // Overtime has no paid mark.
    expect(text).not.toMatch(/alter table public\.hr_overtime_records[^;]*paid/);
  });

  test('a file is the receipt of one claim at most', () => {
    expect(writes()).toContain(
      'create unique index hr_claims_receipt_path_idx on public.hr_claims (receipt_path) where receipt_path is not null;',
    );
  });

  test('creates the nine functions, and no other in the public schema', () => {
    const made = allFunctions(writes()).filter((name) => name.startsWith('public.'));
    expect(made.sort()).toEqual(FUNCTIONS.map((f) => `public.${f.name}`).sort());
  });

  test.each(FUNCTIONS)('$name runs as the owner on a fixed search path and returns jsonb', ({ name }) => {
    const { header } = fn(writes(), `public.${name}`);
    expect(header).toContain('returns jsonb language plpgsql');
    expect(header).toContain('security definer');
    expect(header).toContain('set search_path = public');
  });

  test.each(FUNCTIONS)('$name can be called by signed-in users only', ({ name, args }) => {
    const text = writes();
    expect(text).toContain(`revoke all on function public.${name}(${args}) from public, anon;`);
    expect(text).toContain(`grant execute on function public.${name}(${args}) to authenticated;`);
  });

  test('execute is granted on those nine and on nothing else', () => {
    const grants = (writes().match(/grant [^;]*;/g) ?? []).sort();
    expect(grants).toEqual(
      FUNCTIONS.map((f) => `grant execute on function public.${f.name}(${f.args}) to authenticated;`).sort(),
    );
  });

  test('the two tables get no write grant, no new policy, and keep row level security', () => {
    const text = writes();
    expect(text).not.toMatch(/grant\s+(all|select|insert|update|delete|truncate)/i);
    expect(text).not.toMatch(/create policy \w+ on public\./i);
    expect(text).not.toMatch(/(disable|enable) row level security/i);
  });

  test('no function takes a workspace from its caller', () => {
    const text = writes();
    for (const { name } of FUNCTIONS) {
      const { header } = fn(text, `public.${name}`);
      expect(header, name).not.toMatch(/org/i);
    }
  });

  test('the two helpers are private, on a fixed search path, and closed to the API roles', () => {
    const text = writes();
    const helpers = allFunctions(text).filter((name) => name.startsWith('private.'));
    expect(helpers).toEqual(['private.hr_pay_may_act', 'private.hr_overtime_figures']);
    for (const helper of helpers) {
      const { header } = fn(text, helper);
      expect(header, helper).toContain('set search_path = public');
      expect(text, helper).toMatch(
        new RegExp(`revoke all on function ${helper.replace('.', '\\.')}\\([^)]*\\) from public, anon, authenticated;`),
      );
    }
  });

  test('a refusal is one of the ten codes and carries nothing else', () => {
    const text = writes();
    // Every function's text; the one other raise is the migration's own guard, outside any function.
    const inFunctions = allFunctions(text)
      .map((name) => fn(text, name).body)
      .join('\n');
    const raised = [...inFunctions.matchAll(/raise exception ([^;]*);/g)].map((m) => m[1]);
    expect(raised.length).toBeGreaterThan(40);
    expect(text.match(/raise exception/g)).toHaveLength(raised.length + 1);
    for (const message of raised) expect(message).toMatch(/^'PAY_[A-Z_]+'$/);
    expect([...new Set(raised.map((m) => m.slice(1, -1)))].sort()).toEqual([...CODES].sort());
    expect(text).not.toMatch(/raise (notice|warning|log|info)/i);
  });

  test.each(ON_A_REQUEST)('$name locks the request before it reads the status', ({ name, table }) => {
    const { body } = fn(writes(), `public.${name}`);
    const lock = body.indexOf(`select * into req from public.${table} r where r.id = p_request for update;`);
    const status = body.indexOf('req.status');
    expect(lock, name).toBeGreaterThan(-1);
    expect(status, name).toBeGreaterThan(lock);
    expect(body.match(/\bfrom public\.(hr_claims|hr_overtime_records) r\b/g), name).toHaveLength(1);
    // And nothing is written before that lock is held.
    expect(body.indexOf('update public.'), name).toBeGreaterThan(lock);
  });

  test.each(['hr_submit_claim', 'hr_submit_overtime', 'hr_cancel_claim', 'hr_cancel_overtime'])(
    '%s takes the employee row, so one employee\'s changes take turns',
    (name) => {
      const { body } = fn(writes(), `public.${name}`);
      const lock = body.search(/from public\.hr_employees e\s+where e\.id = (p_employee|req\.employee_id) for no key update;/);
      expect(lock, name).toBeGreaterThan(-1);
      const write = Math.max(body.indexOf('insert into public.'), body.indexOf('update public.'));
      expect(write, name).toBeGreaterThan(lock);
    },
  );

  test.each(ADMIN_ONLY)('%s is for owners and admins only', (name) => {
    const { body } = fn(writes(), `public.${name}`);
    expect(body).toContain('is_admin := private.is_org_admin(req.org_id);');
    const gate = body.indexOf("if not is_admin then raise exception 'PAY_NOT_ALLOWED'; end if;");
    expect(gate, name).toBeGreaterThan(-1);
    // Nothing is changed, and no status is revealed, before that gate.
    expect(body.indexOf('update public.'), name).toBeGreaterThan(gate);
    expect(body.indexOf('req.status'), name).toBeGreaterThan(gate);
    expect(body).not.toContain('is_org_writer');
  });

  test.each(ON_A_REQUEST)(
    '$name tells someone with no business with the request only that it was not found',
    ({ name }) => {
      const { body } = fn(writes(), `public.${name}`);
      expect(body).toContain(
        'if not (is_admin or private.is_own_employee(req.employee_id)\n'
          + '          or (is_demo and private.is_org_member(req.org_id))) then\n'
          + "    raise exception 'PAY_NOT_FOUND';",
      );
      expect(body.match(/raise exception 'PAY_NOT_FOUND'/g)).toHaveLength(2);
      // That answer comes before any other refusal that depends on the request.
      const hidden = body.lastIndexOf("raise exception 'PAY_NOT_FOUND'");
      for (const later of [
        "if is_demo then raise exception 'PAY_NOT_ALLOWED'",
        'req.status',
        'req.claim_date',
        'PAY_BAD_INPUT',
        'PAY_ALREADY_PAID',
      ]) {
        const at = body.indexOf(later);
        if (at > -1) expect(at, `${name}: ${later}`).toBeGreaterThan(hidden);
      }
    },
  );

  test('acting for an employee means an admin of their workspace or the member linked to them', () => {
    const text = writes();
    const { body } = fn(text, 'private.hr_pay_may_act');
    expect(body).toContain('select e.org_id into org from public.hr_employees e where e.id = p_employee;');
    expect(body).toContain('if not (private.is_org_admin(org) or private.is_own_employee(p_employee)) then');
    expect(body).not.toContain('is_org_writer');
    expect(body).not.toContain('is_org_member');
    for (const name of ['hr_submit_claim', 'hr_overtime_preview', 'hr_submit_overtime']) {
      const fnBody = fn(text, `public.${name}`).body;
      const gate = fnBody.indexOf('org := private.hr_pay_may_act(p_employee);');
      expect(gate, name).toBeGreaterThan(-1);
      // It is the first thing each of them does.
      expect(fnBody.slice(fnBody.indexOf('begin'), gate).trim(), name).toBe('begin');
    }
    for (const name of ['hr_cancel_claim', 'hr_cancel_overtime']) {
      const fnBody = fn(text, `public.${name}`).body;
      expect(fnBody, name).toContain('is_admin := private.is_org_admin(req.org_id);');
      expect(fnBody, name).toContain("if req.status <> 'pending' then raise exception 'PAY_NOT_PENDING'; end if;");
    }
  });

  test('every function refuses in the demo workspace', () => {
    const text = writes();
    expect(fn(text, 'private.hr_pay_may_act').body).toContain(
      "if private.is_demo_org(org) then raise exception 'PAY_NOT_ALLOWED'; end if;",
    );
    for (const { name } of ON_A_REQUEST) {
      const body = fn(text, `public.${name}`).body;
      expect(body, name).toContain('is_demo := private.is_demo_org(req.org_id);');
      const refusal = body.indexOf("if is_demo then raise exception 'PAY_NOT_ALLOWED'; end if;");
      expect(refusal, name).toBeGreaterThan(-1);
      expect(body.indexOf('update public.'), name).toBeGreaterThan(refusal);
    }
  });

  test('a paid claim cannot be cancelled, and only an approved one can be marked', () => {
    const text = writes();
    const cancel = fn(text, 'public.hr_cancel_claim').body;
    const guard = cancel.indexOf("if req.status = 'paid' then raise exception 'PAY_ALREADY_PAID'; end if;");
    expect(guard).toBeGreaterThan(-1);
    expect(cancel.indexOf('update public.hr_claims')).toBeGreaterThan(guard);
    expect(cancel).toContain("set status = 'cancelled', receipt_path = null, has_receipt = false");
    expect(cancel).toContain("'removed_receipt_path', req.receipt_path");

    const mark = fn(text, 'public.hr_mark_claim_paid').body;
    expect(mark).toContain("if req.status <> 'approved' then raise exception 'PAY_NOT_APPROVED'; end if;");
    expect(mark).toContain("if p_paid_on > today or p_paid_on < req.claim_date then raise exception 'PAY_BAD_INPUT'; end if;");
    expect(mark).toContain("set status = 'paid', paid_on = p_paid_on, paid_reference = ref, paid_by = auth.uid()");

    const undo = fn(text, 'public.hr_unmark_claim_paid').body;
    expect(undo).toContain("if req.status <> 'paid' then raise exception 'PAY_NOT_PAID'; end if;");
    expect(undo).toContain("set status = 'approved', paid_on = null, paid_reference = null, paid_by = null");
  });

  test('a receipt is taken only from the caller\'s own folder of the receipts bucket', () => {
    const { body } = fn(writes(), 'public.hr_submit_claim');
    const check = body.indexOf('if p_receipt_path is not null then');
    expect(check).toBeGreaterThan(-1);
    expect(body).toContain("split_part(p_receipt_path, '/', 1) <> auth.uid()::text");
    expect(body).toContain("where o.bucket_id = 'hr-receipts' and o.name = p_receipt_path");
    expect(body).toContain('or exists (select 1 from public.hr_claims c where c.receipt_path = p_receipt_path)');
    expect(body.indexOf('insert into public.hr_claims')).toBeGreaterThan(check);
    expect(body).toContain('p_receipt_path is not null, p_receipt_path,');
  });

  test('overtime pay is worked out in one place', () => {
    const text = writes();
    const { body } = fn(text, 'private.hr_overtime_figures');
    // A public holiday is looked for before the rest day.
    const holiday = body.indexOf("day_kind := 'public_holiday';");
    const rest = body.indexOf("day_kind := 'rest_day';");
    expect(holiday).toBeGreaterThan(-1);
    expect(rest).toBeGreaterThan(holiday);
    expect(body).toContain("multiplier := case day_kind when 'weekday' then 1.5 when 'rest_day' then 2.0 else 3.0 end;");
    expect(body).toContain("if jsonb_typeof(custom) = 'number' then");
    // The floor of 1 is tested on the configured value, before it is rounded.
    expect(body).toContain(
      "if (custom #>> '{}')::numeric >= 1 and round((custom #>> '{}')::numeric, 1) <= 99.9 then",
    );
    // A salary of 0 is no salary.
    expect(body).toContain('hourly_rate_cents := round(nullif(salary, 0) / 208.0)::bigint;');
    expect(body).toContain('amount_cents := coalesce(round(hourly_rate_cents * p_hours * multiplier), 0)::bigint;');
    // No second copy of the arithmetic: the three callers use the helper.
    expect(text.match(/208/g)).toHaveLength(1);
    expect(text.match(/\* multiplier/g)).toHaveLength(1);
    for (const name of ['hr_overtime_preview', 'hr_submit_overtime', 'hr_decide_overtime']) {
      expect(fn(text, `public.${name}`).body, name).toMatch(/select \* into f from private\.hr_overtime_figures\(/);
    }
    expect(fn(text, 'public.hr_decide_overtime').body).toContain('if p_approve and req.hourly_rate_cents is null then');
  });

  test('one employee\'s pending and approved overtime on a date stays within 24 hours', () => {
    const { body } = fn(writes(), 'public.hr_submit_overtime');
    expect(body).toContain(
      "where r.employee_id = p_employee and r.work_date = p_work_date and r.status in ('pending','approved');",
    );
    const cap = body.indexOf("if already + p_hours > 24 then raise exception 'PAY_TOO_MANY_HOURS'; end if;");
    expect(cap).toBeGreaterThan(-1);
    expect(body.indexOf('insert into public.hr_overtime_records')).toBeGreaterThan(cap);
    // The count is taken while the employee's row is held.
    expect(cap).toBeGreaterThan(body.indexOf('for no key update;'));
  });

  test('the preview cannot write', () => {
    const { header, body } = fn(writes(), 'public.hr_overtime_preview');
    expect(header).toContain('language plpgsql stable security definer');
    expect(body).not.toMatch(/\b(insert into|update public|delete from)\b/);
    expect(body).not.toContain('for update');
    expect(body).not.toContain('for no key update');
  });

  test('today is today in Malaysia', () => {
    const text = writes();
    for (const name of ['public.hr_submit_claim', 'public.hr_mark_claim_paid', 'private.hr_overtime_figures']) {
      expect(fn(text, name).body, name).toContain("today date := (now() at time zone 'Asia/Kuala_Lumpur')::date;");
    }
    expect(text).not.toContain('current_date');
  });

  test('the receipts bucket is private, 5 MB, and takes five types', () => {
    const text = writes();
    expect(text).toContain(
      'insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)\n'
        + "values ('hr-receipts', 'hr-receipts', false, 5242880,\n"
        + "        array['image/jpeg','image/png','image/webp','image/heic','application/pdf'])\n"
        + 'on conflict (id) do nothing;',
    );
    expect(text.match(/insert into storage\./g)).toHaveLength(1);
  });

  test('a receipt is read by its uploader and by whoever may read its claim', () => {
    const select = policy(writes(), 'hr_receipts_select');
    expect(select).toContain('for select to authenticated');
    expect(select).toContain("bucket_id = 'hr-receipts'\n    and (");
    expect(select).toContain('(storage.foldername(name))[1] = (select auth.uid())::text');
    expect(select).toContain(
      'select 1 from public.hr_claims c\n'
        + '        where c.receipt_path = storage.objects.name\n'
        + '          and (private.is_org_admin(c.org_id) or private.is_own_employee(c.employee_id))',
    );
    expect(select).not.toContain('is_org_member');
    expect(select).not.toContain('is_org_writer');
    expect(select).not.toContain('is_demo_org');
  });

  test('a receipt is uploaded by a signed-up account into its own folder', () => {
    const insert = policy(writes(), 'hr_receipts_insert_own');
    expect(insert).toContain('for insert to authenticated');
    expect(insert).toContain("bucket_id = 'hr-receipts'");
    expect(insert).toContain('and (storage.foldername(name))[1] = (select auth.uid())::text');
    expect(insert).toContain("and coalesce((auth.jwt()->>'is_anonymous')::boolean, false) = false");
  });

  test('the bucket needs the second factor, and nobody updates or deletes in it', () => {
    const text = writes();
    expect(policy(text, 'hr_receipts_mfa_required')).toBe(
      'create policy hr_receipts_mfa_required on storage.objects as restrictive\n'
        + '  for all to authenticated\n'
        + "  using (bucket_id <> 'hr-receipts' or (select private.mfa_ok()))\n"
        + "  with check (bucket_id <> 'hr-receipts' or (select private.mfa_ok()));",
    );
    const policies = [...text.matchAll(/create policy (\w+) on (\S+)( as restrictive)?\s+for (\w+) to (\w+)/g)].map(
      (m) => `${m[1]} on ${m[2]}${m[3] ?? ''} for ${m[4]} to ${m[5]}`,
    );
    expect(policies).toEqual([
      'hr_receipts_select on storage.objects for select to authenticated',
      'hr_receipts_insert_own on storage.objects for insert to authenticated',
      'hr_receipts_mfa_required on storage.objects as restrictive for all to authenticated',
    ]);
    expect(text.match(/create policy/g)).toHaveLength(3);
    // `for update` is a row lock in the functions; as a policy it would follow `on storage.objects`.
    expect(text).not.toMatch(/create policy[^;]*\bfor (update|delete)\b/i);
    expect(text).not.toMatch(/\bto (anon|public|service_role)\b/);
  });
});
