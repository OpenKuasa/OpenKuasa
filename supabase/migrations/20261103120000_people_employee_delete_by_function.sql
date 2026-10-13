-- An employee is deleted through public.hr_delete_employee, and no other way a
-- signed-in user has. This file takes away the direct DELETE on
-- public.hr_employees that the first people migration granted
-- (20261014090000_people_core.sql, line 148).
--
-- Why. The function (20261102090050_people_documents_writes.sql) records the
-- paths of the employee's document files as released and hands them back, so
-- the app can remove the files. A delete sent straight to the table, by an
-- owner or admin through the API, took the documents with the employee and
-- released nothing: the files stayed in the bucket until the sweep found
-- them. Nothing was exposed (a file is read only through its document); this
-- closes the way around the function.
--
-- What changes: one privilege. `authenticated` can no longer DELETE from
-- public.hr_employees; a direct delete is refused (42501) for everyone,
-- owners and admins included.
--
-- What does not change:
--   * INSERT and the column UPDATE grant on the table, and SELECT.
--   * The policy hr_employees_write. It is `for all`, so it is also the rule
--     for adding and editing an employee; there is no policy for deleting
--     alone to drop. Its delete branch simply has no grant behind it now.
--   * hr_delete_employee: a definer function, it deletes as the table owner
--     and needs no grant to `authenticated`. Who may call it, and what it
--     answers (null for a member, another workspace, the demo), is as before.
--   * The trigger hr_employees_paid_payslips_guard: an employee with a paid
--     payslip is still refused with HR_EMPLOYEE_HAS_PAID_PAYSLIPS, through
--     the function and for the database owner alike.
--   * Everything that deletes employees as the table owner: the demo reseed
--     (private.reseed_demo_people) and the cascade from deleting a workspace.
--   * hr_departments and hr_employee_private keep their DELETE grants.
--
-- Safe with the app deployed before it? For deleting an employee, yes: the
-- app has gone through the function since the documents slice. One other
-- place did not: when a new employee's private details could not be saved,
-- createEmployee took the employee back out with a direct delete. The release
-- that carries this file does that through the function too. Against an app
-- older than that release, that one rollback would be refused after this is
-- applied, leaving the employee without private details (logged, and the
-- person is told the change was not saved). So: deploy the app release first,
-- then apply this. The function has to exist first as well, and this file
-- stops if it does not.
--
-- Safe to apply twice.

do $$
declare fn oid := to_regprocedure('public.hr_delete_employee(uuid,uuid)');
begin
  if fn is null or not has_function_privilege('authenticated', fn, 'execute') then
    raise exception 'public.hr_delete_employee(uuid, uuid) is not there for signed-in users: apply 20261102090050_people_documents_writes.sql first';
  end if;
end $$;

revoke delete on public.hr_employees from authenticated;
