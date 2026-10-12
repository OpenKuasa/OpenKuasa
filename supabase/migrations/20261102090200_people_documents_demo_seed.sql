-- The demo re-seed, replaced for the letters and documents slice (it replaces
-- the function of the performance slice). Word for word what it was, but for
-- three things:
--   documents  none has a file (the app shows "Sample document, no file");
--              the placeholder payslips and the placeholder letter are gone
--              (the real ones are in payroll and in hr_letters); one asks for
--              an acknowledgement, one expires soon and one has expired; all
--              are of types the app deployed before this slice can label;
--   letters    the five there were, with the new types and a body each; three
--              are issued and two are drafts, and one issued letter asks for
--              an acknowledgement;
--   templates  the starter set every workspace gets, made afresh.
-- Idempotent and anchored to today; runs hourly, and is not run here: the
-- hourly job rebuilds the demo with it at the next minute :01.

create or replace function private.reseed_demo_people()
returns void language plpgsql security definer set search_path = public as $$
declare
  demo uuid;
  today date := (now() at time zone 'Asia/Kuala_Lumpur')::date;
  month_start date;
  week_start date;
  this_year int;
begin
  select id into demo from public.orgs where slug = 'rimba-ventures-demo';
  if demo is null then raise exception 'demo org missing'; end if;
  month_start := date_trunc('month', today)::date;
  week_start := date_trunc('week', today)::date;
  this_year := extract(year from today)::int;

  -- The payroll runs go first, and their payslips with them: an employee with
  -- a paid payslip cannot be deleted.
  delete from public.hr_payroll_runs where org_id = demo;
  -- Deleting employees removes every personal row with them.
  delete from public.hr_employees where org_id = demo;
  delete from public.hr_payment_vouchers where org_id = demo;
  delete from public.hr_departments where org_id = demo;
  delete from public.hr_public_holidays where org_id = demo;
  delete from public.hr_trainings where org_id = demo;
  delete from public.hr_announcements where org_id = demo;
  delete from public.hr_settings where org_id = demo;
  delete from public.hr_letter_templates where org_id = demo;

  insert into public.hr_departments (id, org_id, name)
  select md5('rimba-dept-' || d)::uuid, demo, d
  from unnest(array['Sales','Operations','Marketing','Finance','Management']) as d;

  -- 20 employees: Sales 6, Operations 5, Marketing 3, Finance 3, Management 3.
  -- tenure = days since joining; bday = days from today to the next birthday.
  insert into public.hr_employees (id, org_id, employee_no, name, work_email, department_id,
    designation, employment_type, is_manager, join_date, status, date_of_birth_day, date_of_birth_month)
  select md5('rimba-emp-' || v.n)::uuid, demo, 'EMP-' || lpad(v.n::text, 3, '0'), v.name,
    v.handle || '@openkuasa.com', md5('rimba-dept-' || v.dept)::uuid, v.designation, v.etype, v.mgr,
    today - v.tenure, 'active',
    extract(day from today + v.bday)::smallint, extract(month from today + v.bday)::smallint
  from (values
    (1, 'Aisyah Rahim', 'aisyah', 'Sales', 'Sales Executive', 'full_time', false, 1730, 19),
    (2, 'Faiz Hakim', 'faiz', 'Marketing', 'Designer', 'full_time', false, 1680, 143),
    (3, 'Ahmad Zaki', 'zaki', 'Operations', 'Ops Lead', 'full_time', true, 1081, 201),
    (4, 'Nurul Huda', 'nurul', 'Finance', 'Accountant', 'full_time', false, 960, 9),
    (5, 'Siti Aminah', 'siti', 'Sales', 'Sales Executive', 'part_time', false, 850, 77),
    (6, 'Lim Wei Jie', 'weijie', 'Operations', 'Technician', 'contract', false, 1060, 256),
    (7, 'Siti Lestari', 'lestari', 'Management', 'HR Executive', 'full_time', false, 610, 310),
    (8, 'Raj Kumar', 'raj', 'Finance', 'Finance Analyst', 'full_time', false, 470, 118),
    (9, 'Tan Mei Ling', 'meiling', 'Marketing', 'Content Lead', 'full_time', true, 1240, 45),
    (10, 'Hafiz Osman', 'hafiz', 'Sales', 'Business Development', 'full_time', false, 395, 170),
    (11, 'Amirul Danial', 'amirul', 'Sales', 'Sales Executive', 'full_time', false, 720, 228),
    (12, 'Farid Ismail', 'farid', 'Sales', 'Sales Manager', 'full_time', true, 2010, 284),
    (13, 'Priya Devi', 'priya', 'Sales', 'Account Executive', 'full_time', false, 330, 61),
    (14, 'Chong Wei Han', 'weihan', 'Operations', 'Logistics Coordinator', 'full_time', false, 890, 332),
    (15, 'Zainab Yusof', 'zainab', 'Operations', 'Customer Support', 'full_time', false, 540, 97),
    (16, 'Daniel Wong', 'daniel', 'Operations', 'Technician', 'contract', false, 210, 189),
    (17, 'Syafiq Karim', 'syafiq', 'Marketing', 'Performance Marketer', 'full_time', false, 660, 131),
    (18, 'Liyana Salleh', 'liyana', 'Finance', 'Finance Manager', 'full_time', true, 1520, 266),
    (19, 'Kavitha Nair', 'kavitha', 'Management', 'Operations Director', 'full_time', true, 2300, 29),
    (20, 'Hakim Abdullah', 'hakim', 'Management', 'Managing Director', 'full_time', true, 2800, 215)
  ) as v(n, name, handle, dept, designation, etype, mgr, tenure, bday);

  -- Pay: RM 2,800 to RM 5,600 by position in the list; managers RM 3,000 more.
  insert into public.hr_employee_private (employee_id, org_id, nric, date_of_birth, phone, address,
    base_salary_cents, bank_name, bank_account, epf_no, socso_no, tax_no,
    emergency_contact_name, emergency_contact_phone)
  select e.id, demo,
    '900101-14-' || lpad((5000 + e.n)::text, 4, '0'),
    make_date(this_year - 26 - (e.n % 14), e.date_of_birth_month, least(e.date_of_birth_day, 28)),
    '+60 12-555 ' || lpad((1000 + e.n * 37)::text, 4, '0'),
    e.n || ' Jalan Rimba, 50450 Kuala Lumpur',
    280000 + ((e.n * 7) % 8) * 40000 + case when e.is_manager then 300000 else 0 end,
    (array['Maybank','CIMB','Public Bank','RHB'])[1 + (e.n % 4)],
    lpad((100000000 + e.n * 7919)::text, 12, '5'),
    'EPF' || lpad((20000 + e.n)::text, 8, '0'),
    'SOC' || lpad((30000 + e.n)::text, 8, '0'),
    'SG' || lpad((40000 + e.n)::text, 9, '0'),
    'Waris ' || split_part(e.name, ' ', 1),
    '+60 13-555 ' || lpad((2000 + e.n * 41)::text, 4, '0')
  from (select x.*, substr(x.employee_no, 5)::int as n from public.hr_employees x where x.org_id = demo) e;

  -- Leave. First three: approved and covering today. Next three: waiting.
  insert into public.hr_leave_requests (org_id, employee_id, leave_type, start_date, end_date, days, reason, status, decided_at, created_at)
  select demo, md5('rimba-emp-' || v.n)::uuid, v.leave_type, today + v.from_day, today + v.to_day, v.days, v.reason, v.status,
    case when v.status = 'pending' then null else now() - interval '3 days' end,
    now() - make_interval(days => v.applied_ago)
  from (values
    (7, 'annual', -2, 1, 4.0, 'Family trip', 'approved', 12),
    (6, 'medical', 0, 0, 1.0, 'Clinic visit', 'approved', 1),
    (4, 'emergency', 0, 0, 1.0, 'Family matter', 'approved', 1),
    (1, 'annual', 10, 11, 2.0, 'Balik kampung', 'pending', 2),
    (11, 'annual', 5, 5, 1.0, 'Personal errand', 'pending', 1),
    (9, 'emergency', 3, 3, 1.0, 'Car repair', 'pending', 0),
    (2, 'annual', -40, -38, 3.0, 'Holiday', 'approved', 55),
    (3, 'medical', -25, -24, 2.0, 'Flu', 'approved', 26),
    (5, 'annual', -60, -58, 3.0, 'Wedding', 'approved', 75),
    (8, 'unpaid', -33, -33, 1.0, 'Personal', 'rejected', 40),
    (10, 'annual', -18, -17, 2.0, 'Rest', 'approved', 30),
    (12, 'annual', -75, -71, 5.0, 'Umrah', 'approved', 100),
    (13, 'medical', -12, -12, 1.0, 'Dental', 'approved', 13),
    (15, 'annual', -50, -49, 2.0, 'Holiday', 'approved', 62),
    (17, 'emergency', -8, -8, 1.0, 'Child unwell', 'approved', 9),
    (18, 'annual', -90, -86, 5.0, 'Holiday', 'approved', 110),
    (1, 'medical', -21, -21, 1.0, 'Fever', 'approved', 22),
    (1, 'annual', -45, -44, 2.0, 'Holiday', 'approved', 60)
  ) as v(n, leave_type, from_day, to_day, days, reason, status, applied_ago);

  insert into public.hr_leave_balances (org_id, employee_id, leave_type, year, entitled_days, used_days)
  select demo, e.id, t.leave_type, this_year, t.entitled,
    coalesce((
      select sum(r.days) from public.hr_leave_requests r
      where r.employee_id = e.id and r.leave_type = t.leave_type and r.status = 'approved'
        and extract(year from r.start_date) = this_year
    ), 0)
  from public.hr_employees e
  cross join (values ('annual', 16.0), ('medical', 14.0), ('emergency', 3.0)) as t(leave_type, entitled)
  where e.org_id = demo;

  insert into public.hr_time_off_requests (org_id, employee_id, off_date, start_time, end_time, reason, status, decided_at)
  select demo, md5('rimba-emp-' || v.n)::uuid, today + v.day, v.start_time::time, v.end_time::time, v.reason, v.status,
    case when v.status = 'pending' then null else now() - interval '2 days' end
  from (values
    (1, -9, '15:00', '17:00', 'Bank appointment', 'approved'),
    (1, -30, '09:00', '11:00', 'School event', 'approved'),
    (2, 2, '14:00', '16:00', 'Clinic follow-up', 'approved'),
    (5, -14, '16:00', '18:00', 'JPJ appointment', 'approved'),
    (10, -6, '09:00', '10:30', 'Car service', 'rejected'),
    (14, -20, '13:00', '15:00', 'Bank appointment', 'approved')
  ) as v(n, day, start_time, end_time, reason, status);

  -- Claims. First two are waiting.
  insert into public.hr_claims (org_id, employee_id, category, amount_cents, claim_date, description, has_receipt, status, decided_at)
  select demo, md5('rimba-emp-' || v.n)::uuid, v.category, v.amount, today + v.day, v.description, v.receipt, v.status,
    case when v.status = 'pending' then null else now() - interval '2 days' end
  from (values
    (2, 'medical', 24000, -1, 'Clinic consultation', true, 'pending'),
    (4, 'travel', 18000, -2, 'Site visit mileage', true, 'pending'),
    (1, 'travel', 32000, -12, 'Client visit, Johor Bahru', true, 'approved'),
    (1, 'meals', 8600, -20, 'Client lunch', true, 'approved'),
    (1, 'medical', 15000, -41, 'Panel clinic', true, 'approved'),
    (1, 'equipment', 68400, -55, 'Headset and keyboard', false, 'rejected'),
    (3, 'travel', 21000, -9, 'Warehouse run', true, 'approved'),
    (5, 'meals', 6400, -15, 'Team lunch', true, 'approved'),
    (9, 'equipment', 129000, -27, 'Camera tripod', true, 'approved'),
    (12, 'travel', 54000, -33, 'Penang roadshow', true, 'approved'),
    (13, 'medical', 9000, -6, 'Pharmacy', true, 'approved'),
    (17, 'other', 12000, -18, 'Courier fees', false, 'rejected')
  ) as v(n, category, amount, day, description, receipt, status);

  -- Overtime. The first is waiting; pay is hours x rate x RM 25.
  insert into public.hr_overtime_records (org_id, employee_id, work_date, hours, rate_multiplier, amount_cents, status, decided_at)
  select demo, md5('rimba-emp-' || v.n)::uuid, today + v.day, v.hours, v.rate,
    round(v.hours * v.rate * 2500)::bigint, v.status,
    case when v.status = 'pending' then null else now() - interval '1 day' end
  from (values
    (3, -2, 4.0, 1.5, 'pending'),
    (1, -7, 2.0, 1.5, 'approved'),
    (1, -23, 3.0, 1.5, 'approved'),
    (1, -37, 2.5, 2.0, 'approved'),
    (6, -5, 3.5, 1.5, 'approved'),
    (6, -19, 4.0, 2.0, 'approved'),
    (14, -11, 2.0, 1.5, 'approved'),
    (15, -4, 1.5, 1.5, 'approved'),
    (16, -13, 5.0, 2.0, 'approved'),
    (16, -26, 3.0, 1.5, 'rejected'),
    (3, -16, 2.5, 1.5, 'approved'),
    (10, -8, 2.0, 1.5, 'approved')
  ) as v(n, day, hours, rate, status);

  -- Attendance for the last eight weeks of weekdays. h is a stable 0..39 per
  -- employee and day: 0 is absent, 1 to 4 late, the rest on time.
  insert into public.hr_attendance_days (org_id, employee_id, work_date, clock_in, clock_out, status)
  select demo, a.employee_id, a.work_date,
    case when a.status in ('absent', 'on_leave') then null
         else (a.work_date + time '09:00'
               + case when a.status = 'late' then (10 + a.h * 5) else -(a.h % 10) end * interval '1 minute')
              at time zone 'Asia/Kuala_Lumpur' end,
    case when a.status in ('absent', 'on_leave') or a.work_date = today then null
         else (a.work_date + time '18:00' + (a.h % 30) * interval '1 minute') at time zone 'Asia/Kuala_Lumpur' end,
    a.status
  from (
    select e.id as employee_id, d::date as work_date, x.h,
      case
        when exists (
          select 1 from public.hr_leave_requests r
          where r.employee_id = e.id and r.status = 'approved' and d::date between r.start_date and r.end_date
        ) then 'on_leave'
        when x.h = 0 then 'absent'
        when x.h between 1 and 4 then 'late'
        else 'present'
      end as status
    from public.hr_employees e
    cross join generate_series(today - 55, today, interval '1 day') as d
    cross join lateral (select (abs(hashtext(e.id::text || d::date::text)::bigint) % 40)::int as h) x
    where e.org_id = demo and extract(isodow from d) < 6
  ) a;

  insert into public.hr_timesheet_entries (org_id, employee_id, work_date, hours, billable_hours)
  select demo, a.employee_id, a.work_date, t.hours, round(t.hours * 0.8 * 2) / 2
  from public.hr_attendance_days a
  cross join lateral (
    select 7.5 + (abs(hashtext(a.employee_id::text || a.work_date::text || 'h')::bigint) % 3) * 0.5 as hours
  ) t
  where a.org_id = demo and a.status in ('present', 'late');

  -- This week's roster for Operations.
  insert into public.hr_shifts (org_id, employee_id, work_date, shift)
  select demo, e.id, week_start + g.i,
    case (substr(e.employee_no, 5)::int + g.i) % 4 when 0 then 'off' when 1 then 'night' else 'morning' end
  from public.hr_employees e
  cross join generate_series(0, 6) as g(i)
  where e.org_id = demo and e.department_id = md5('rimba-dept-Operations')::uuid;

  -- Fixed-date holidays only: the movable ones change every year.
  insert into public.hr_public_holidays (org_id, name, holiday_date, scope, state)
  select demo, v.name, make_date(this_year, v.m, v.d), v.scope, v.state
  from (values
    ('New Year''s Day', 1, 1, 'state', 'Kuala Lumpur'),
    ('Federal Territory Day', 2, 1, 'state', 'Kuala Lumpur'),
    ('Labour Day', 5, 1, 'national', null),
    ('National Day', 8, 31, 'national', null),
    ('Malaysia Day', 9, 16, 'national', null),
    ('Christmas Day', 12, 25, 'national', null)
  ) as v(name, m, d, scope, state);

  -- Payroll: this month in draft, the seven before it paid. A payslip starts
  -- from the salary; its lines follow; then every figure is worked out by the
  -- function a real payslip is worked out by. PCB is an illustrative figure.
  -- The settings row comes first: the joiner line counts working days, which
  -- reads the work week from it.
  insert into public.hr_settings (org_id, notifications)
  values (demo, '{"leave_requests":true,"payslip_ready":true,"document_expiry":true,"birthdays":false}'::jsonb);

  insert into public.hr_payroll_runs (id, org_id, period_month, status, paid_at)
  select md5('rimba-run-' || g.m)::uuid, demo, (month_start - make_interval(months => g.m))::date,
    case when g.m = 0 then 'draft' else 'paid' end,
    case when g.m = 0 then null else (month_start - make_interval(months => g.m) + interval '27 days') end
  from generate_series(0, 7) as g(m);

  insert into public.hr_payslips (org_id, employee_id, payroll_run_id, period_month,
    basic_cents, gross_cents, pcb_cents, status)
  select demo, p.employee_id, r.id, r.period_month, p.base_salary_cents, p.base_salary_cents,
    case when p.base_salary_cents > 500000 then (8000 + round((p.base_salary_cents - 500000) * 0.08))::bigint
         when p.base_salary_cents > 350000 then round((p.base_salary_cents - 350000) * 0.03)::bigint
         else 0 end,
    case when r.status = 'paid' then 'paid' else 'pending' end
  from public.hr_employee_private p
  join public.hr_employees e on e.id = p.employee_id
  join public.hr_payroll_runs r on r.org_id = demo and e.join_date < (r.period_month + interval '1 month')::date
  where p.org_id = demo;

  -- Whoever joined part-way through a month is paid for its working days from
  -- the day they joined.
  insert into public.hr_payslip_lines (org_id, payslip_id, kind, source, label, amount_cents)
  select demo, j.id, 'unpaid', 'joiner', 'Joined ' || to_char(j.join_date, 'FMDD Mon YYYY'), j.amount
  from (
    select s.id, e.join_date,
      s.basic_cents - round(s.basic_cents::numeric
        * private.hr_payroll_working_days(demo, e.join_date, (s.period_month + interval '1 month')::date - 1)
        / nullif(private.hr_payroll_working_days(demo, s.period_month, (s.period_month + interval '1 month')::date - 1), 0)
      )::bigint as amount
    from public.hr_payslips s
    join public.hr_employees e on e.id = s.employee_id
    where s.org_id = demo and e.join_date > s.period_month
  ) j
  where j.amount > 0;

  -- Approved overtime is paid with the month it was worked in.
  with taken as (
    update public.hr_overtime_records r set payslip_id = s.id
    from public.hr_payslips s
    where r.org_id = demo and r.status = 'approved' and r.amount_cents > 0
      and s.employee_id = r.employee_id and s.period_month = date_trunc('month', r.work_date)::date
    returning r.id, s.id as slip_id, r.work_date, r.hours, r.amount_cents
  )
  insert into public.hr_payslip_lines (org_id, payslip_id, kind, source, label, amount_cents, overtime_record_id, created_at)
  select demo, t.slip_id, 'earning', 'overtime',
    'Overtime, ' || to_char(t.work_date, 'FMDD Mon YYYY') || ', ' || trim_scale(t.hours) || ' h',
    t.amount_cents, t.id,
    now() + (1 + row_number() over (partition by t.slip_id order by t.work_date, t.id)) * interval '1 microsecond'
  from taken t;

  -- A few lines an owner or admin added by hand: this month and last month.
  insert into public.hr_payslip_lines (org_id, payslip_id, kind, source, label, amount_cents, created_at)
  select demo, s.id, v.kind, 'hr', v.label, v.amount, now() + interval '1 second'
  from (values
    (12, 0, 'earning', 'Sales commission', 85000),
    (12, 1, 'earning', 'Sales commission', 72000),
    (1, 1, 'earning', 'Sales commission', 45000),
    (19, 0, 'earning', 'Project bonus', 100000),
    (10, 0, 'deduction', 'Salary advance', 30000),
    (5, 1, 'deduction', 'Uniform', 6000)
  ) as v(n, months_ago, kind, label, amount)
  join public.hr_payslips s on s.employee_id = md5('rimba-emp-' || v.n)::uuid
    and s.period_month = (month_start - make_interval(months => v.months_ago))::date;

  perform private.hr_payroll_refresh_payslip(p.id) from public.hr_payslips p where p.org_id = demo;

  insert into public.hr_payment_vouchers (org_id, voucher_no, payee, voucher_type, amount_cents, issued_date, status)
  select demo, 'PV-' || lpad(v.no::text, 4, '0'), v.payee, v.voucher_type, v.amount, today + v.day, v.status
  from (values
    (1041, 'Aisyah Rahim', 'Claim reimbursement', 32000, -10, 'paid'),
    (1042, 'Tan Mei Ling', 'Claim reimbursement', 129000, -24, 'paid'),
    (1043, 'Lembaga Hasil Dalam Negeri', 'Statutory payment', 412000, -18, 'paid'),
    (1044, 'KWSP', 'Statutory payment', 1986000, -18, 'paid'),
    (1045, 'Farid Ismail', 'Advance', 150000, -3, 'issued'),
    (1046, 'Daniel Wong', 'Overtime payout', 37500, 0, 'draft')
  ) as v(no, payee, voucher_type, amount, day, status);

  -- Performance.
  insert into public.hr_goals (org_id, employee_id, title, progress, due_date, status)
  select demo, e.id, v.title, least(100, v.progress + (e.n * 7) % 20),
    today + v.due,
    case when least(100, v.progress + (e.n * 7) % 20) >= 100 then 'done'
         when v.progress < 40 then 'at_risk' else 'on_track' end
  from (select x.*, substr(x.employee_no, 5)::int as n from public.hr_employees x where x.org_id = demo) e
  cross join (values
    ('Hit the quarterly target', 62, 40),
    ('Complete the compliance course', 85, 20),
    ('Cut response time to under 4 hours', 30, 60),
    ('Mentor one new hire', 55, 75)
  ) as v(title, progress, due)
  where e.n <= 10;

  insert into public.hr_scorecards (org_id, employee_id, period, score, competencies)
  select demo, e.id, 'H1 ' || this_year, 3.0 + ((e.n * 7) % 19) / 10.0,
    jsonb_build_object(
      'Delivery', 3.0 + ((e.n * 3) % 20) / 10.0,
      'Teamwork', 3.0 + ((e.n * 5) % 20) / 10.0,
      'Ownership', 3.0 + ((e.n * 11) % 20) / 10.0,
      'Communication', 3.0 + ((e.n * 13) % 20) / 10.0)
  from (select x.*, substr(x.employee_no, 5)::int as n from public.hr_employees x where x.org_id = demo) e;

  -- Reviews: four scores in half steps, the overall score their average. All
  -- are released but two, which are still drafts.
  insert into public.hr_reviews (org_id, employee_id, period, competencies, score, rating, comment,
    status, released_at, reviewer_name, reviewed_at)
  select demo, e.id, 'H1 ' || this_year,
    jsonb_build_object('Delivery', v.d, 'Teamwork', v.t, 'Ownership', v.o, 'Communication', v.c),
    round((v.d + v.t + v.o + v.c) / 4, 2),
    case when (v.d + v.t + v.o + v.c) / 4 >= 4.3 then 'exceeds' when (v.d + v.t + v.o + v.c) / 4 >= 3.4 then 'meets' else 'below' end,
    case when (v.d + v.t + v.o + v.c) / 4 >= 4.3 then 'Consistently ahead of plan, and a steady hand for the team.'
         when (v.d + v.t + v.o + v.c) / 4 >= 3.4 then 'A solid half. Keep building on ownership of the bigger pieces.'
         else 'Below what the role needs this half. A plan for the next quarter is agreed.' end,
    case when e.n in (10, 16) then 'draft' else 'released' end,
    case when e.n in (10, 16) then null else now() - interval '40 days' end,
    'Kavitha Nair', today - 45
  from (select x.*, substr(x.employee_no, 5)::int as n from public.hr_employees x where x.org_id = demo) e
  cross join lateral (
    select trim_scale(3.0 + ((e.n * 3) % 5) * 0.5) as d, trim_scale(3.0 + ((e.n * 5) % 4) * 0.5) as t,
      trim_scale(2.5 + ((e.n * 11) % 5) * 0.5) as o, trim_scale(3.0 + ((e.n * 13) % 5) * 0.5) as c
  ) v;

  insert into public.hr_trainings (id, org_id, title, category, provider, starts_on, ends_on, status)
  select md5('rimba-training-' || v.k)::uuid, demo, v.title, v.category, v.provider, today + v.from_day, today + v.to_day, v.status
  from (values
    (1, 'Workplace safety refresher', 'Compliance', 'In-house', -60, -59, 'completed'),
    (2, 'PDPA for customer data', 'Compliance', 'In-house', -30, -30, 'completed'),
    (3, 'Consultative selling', 'Sales', 'External trainer', -3, 4, 'in_progress'),
    (4, 'Excel for finance teams', 'Skills', 'Online course', 12, 13, 'upcoming'),
    (5, 'First-time manager programme', 'Leadership', 'External trainer', 30, 32, 'upcoming')
  ) as v(k, title, category, provider, from_day, to_day, status);

  -- Whoever is marked completed carries the time: the end of the course's last day.
  insert into public.hr_training_enrolments (org_id, employee_id, training_id, completed, completed_at)
  select demo, e.id, t.id, t.status = 'completed',
    case when t.status = 'completed' then (t.ends_on + time '18:00') at time zone 'Asia/Kuala_Lumpur' end
  from (select x.*, substr(x.employee_no, 5)::int as n from public.hr_employees x where x.org_id = demo) e
  cross join (
    select tr.id, tr.status, tr.ends_on, row_number() over (order by tr.starts_on) as k
    from public.hr_trainings tr where tr.org_id = demo
  ) t
  where (e.n + t.k) % 3 = 0 or (e.n = 1 and t.k <= 3);

  -- Communications and documents. The last announcement is still a draft.
  insert into public.hr_announcements (org_id, title, body, category, status, published_at, author_name)
  select demo, v.title, v.body, v.category, v.status,
    case when v.status = 'published' then now() - make_interval(days => v.ago) end,
    case when v.status = 'published' then 'Siti Lestari' end
  from (values
    ('Office closed for National Day', 'The office is closed on 31 August. Support runs a skeleton shift.', 'holiday', 'published', 4),
    ('New panel clinics added', 'Three more panel clinics are available under the medical benefit.', 'benefits', 'published', 9),
    ('Quarterly town hall', 'Join the town hall this Friday at 3pm in the main meeting room.', 'general', 'published', 13),
    ('Updated leave policy', 'Annual leave may now be carried forward up to five days.', 'policy', 'published', 21),
    ('Second-half priorities', 'Leadership has shared the three priorities for the second half.', 'strategy', 'published', 34),
    ('Year-end dinner', 'Save the date for the year-end dinner. Venue and time to be confirmed.', 'general', 'draft', 0)
  ) as v(title, body, category, status, ago);

  insert into public.hr_documents (org_id, employee_id, title, doc_type, issued_on, expires_on)
  select demo, e.id, 'Employment contract', 'contract', e.join_date, null
  from public.hr_employees e where e.org_id = demo;

  insert into public.hr_documents (org_id, employee_id, title, doc_type, issued_on, expires_on, ack_requested)
  select demo, md5('rimba-emp-1')::uuid, v.title, v.doc_type, today + v.issued, today + v.expires, v.ack
  from (values
    ('EA form', 'tax', -150, null, false),
    ('Code of conduct', 'contract', -6, null, true),
    ('Medical card', 'benefits', -340, 25, false),
    ('Insurance certificate', 'benefits', -375, -10, false)
  ) as v(title, doc_type, issued, expires, ack);

  insert into public.hr_letters (org_id, employee_id, letter_type, title, body, status, issued_on, ack_requested)
  select demo, md5('rimba-emp-' || v.n)::uuid, v.letter_type, v.title,
    'Dear ' || e.name || E',\n\n' || v.body || E'\n\nYours sincerely,\nRimba Ventures',
    v.status, case when v.status = 'issued' then today + v.day else null end, v.ack
  from (values
    (1, 'confirmation', 'Confirmation of employment', 'issued', -2, true,
     'Following the end of your probation, we are pleased to confirm your employment as Sales Executive. The other terms of your employment stay as they are.'),
    (13, 'offer', 'Offer of employment', 'issued', -330, false,
     'We are pleased to offer you the position of Account Executive in the Sales department. Your salary and benefits are set out in your employment contract.'),
    (10, 'warning', 'Late attendance reminder', 'draft', 0, false,
     'Our records show several late arrivals this month. Please make sure you are at work by the start of the working day from now on.'),
    (9, 'promotion', 'Promotion to Content Lead', 'issued', -120, false,
     'We are pleased to tell you that you have been promoted to Content Lead in the Marketing department. Congratulations.'),
    (16, 'contract_renewal', 'Contract renewal', 'draft', 0, false,
     'We are pleased to renew your contract as Technician in the Operations department for a further twelve months.')
  ) as v(n, letter_type, title, status, day, ack, body)
  join public.hr_employees e on e.id = md5('rimba-emp-' || v.n)::uuid;

  -- The starter templates, as a new workspace gets them.
  perform private.hr_seed_letter_templates(demo);
end; $$;
revoke all on function private.reseed_demo_people() from public, anon, authenticated;
