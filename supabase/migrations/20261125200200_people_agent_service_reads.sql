-- The Lekiu agent worker may read the HR columns its scan reads, and nothing else.
--
-- The worker builds its snapshot (src/lib/people/agent/) with the service-role
-- client. In this project service_role holds no table grants unless one is written
-- (see 20261015100000_agent_service_role_grants.sql), so without these grants every
-- run fails with permission denied.
--
-- Read only, and only the columns of spec §5 (the checks of §4.1): ids, the
-- employee's name and status, document type and expiry, goal title, progress and
-- due date, the status and created_at of leave, claims, overtime and letters, the
-- dates the checks name (leave start_date and end_date, claim_date, overtime
-- work_date), attendance day statuses and the payroll month's status.
-- Never granted: a leave reason or type, a claim category, amount or description,
-- overtime hours, rate or amount, a document or letter title, a letter body,
-- anything in hr_employee_private, payslips or the statutory tables, and nothing
-- in hr_agent_notes (dedupe reads agent_proposals). supabase/tests/
-- people_agent_notes_check.sql pins this list: a new grant fails it until reviewed.
set local lock_timeout = '5s';

-- Supabase grants service_role table privileges by default on fresh projects.
-- Remove those broad grants before adding the worker's column-level reads.
revoke all on
  public.hr_employees,
  public.hr_documents,
  public.hr_goals,
  public.hr_leave_requests,
  public.hr_claims,
  public.hr_overtime_records,
  public.hr_letters,
  public.hr_attendance_days,
  public.hr_payroll_runs,
  public.hr_employee_private,
  public.hr_agent_notes
  from service_role;

grant select (id, org_id, name, status)
  on public.hr_employees to service_role;
grant select (id, org_id, employee_id, doc_type, expires_on)
  on public.hr_documents to service_role;
grant select (id, org_id, employee_id, title, progress, due_date, status)
  on public.hr_goals to service_role;
grant select (id, org_id, employee_id, status, created_at, start_date, end_date)
  on public.hr_leave_requests to service_role;
grant select (id, org_id, employee_id, status, created_at, claim_date)
  on public.hr_claims to service_role;
grant select (id, org_id, employee_id, status, created_at, work_date)
  on public.hr_overtime_records to service_role;
grant select (id, org_id, employee_id, status, created_at)
  on public.hr_letters to service_role;
grant select (org_id, employee_id, work_date, status)
  on public.hr_attendance_days to service_role;
grant select (org_id, period_month, status)
  on public.hr_payroll_runs to service_role;

-- ---------------------------------------------------------------------------
-- Self-check: every column granted above is readable (and really read, as
-- service_role), and a sample of what must stay out is denied.
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
  missing text;
begin
  for r in
    select * from (values
      ('hr_employees', 'id,org_id,name,status'),
      ('hr_documents', 'id,org_id,employee_id,doc_type,expires_on'),
      ('hr_goals', 'id,org_id,employee_id,title,progress,due_date,status'),
      ('hr_leave_requests', 'id,org_id,employee_id,status,created_at,start_date,end_date'),
      ('hr_claims', 'id,org_id,employee_id,status,created_at,claim_date'),
      ('hr_overtime_records', 'id,org_id,employee_id,status,created_at,work_date'),
      ('hr_letters', 'id,org_id,employee_id,status,created_at'),
      ('hr_attendance_days', 'org_id,employee_id,work_date,status'),
      ('hr_payroll_runs', 'org_id,period_month,status')
    ) v(tbl, cols)
  loop
    select string_agg(c, ',') into missing from unnest(string_to_array(r.cols, ',')) c
     where not has_column_privilege('service_role', ('public.' || r.tbl)::regclass, c, 'select');
    if missing is not null then
      raise exception 'service_role may not read %.%', r.tbl, missing;
    end if;
    set local role service_role;
    execute format('select %s from public.%I limit 1', r.cols, r.tbl);
    reset role;
  end loop;

  for r in
    select * from (values
      ('hr_leave_requests', 'reason'), ('hr_leave_requests', 'leave_type'),
      ('hr_claims', 'amount_cents'), ('hr_claims', 'category'), ('hr_claims', 'description'),
      ('hr_overtime_records', 'amount_cents'), ('hr_overtime_records', 'hours'),
      ('hr_overtime_records', 'rate_multiplier'), ('hr_documents', 'title'),
      ('hr_letters', 'title'), ('hr_letters', 'body'),
      ('hr_agent_notes', 'body'), ('hr_agent_notes', 'entity_label')
    ) v(tbl, col)
  loop
    if has_column_privilege('service_role', ('public.' || r.tbl)::regclass, r.col, 'select') then
      raise exception 'service_role may read %.%', r.tbl, r.col;
    end if;
  end loop;
  select string_agg(column_name, ',') into missing from information_schema.columns
   where table_schema = 'public' and table_name = 'hr_employee_private'
     and has_column_privilege('service_role', 'public.hr_employee_private'::regclass, column_name, 'select');
  if missing is not null then
    raise exception 'service_role may read hr_employee_private.%', missing;
  end if;
end $$;
