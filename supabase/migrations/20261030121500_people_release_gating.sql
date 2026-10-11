-- Lekiu: a record about an employee is theirs to read once HR has released it.
--
-- The payroll slice (20261027090000) already wrote this rule for payslips (the
-- employee reads a payslip once it is paid) and for letters (once issued).
-- This file writes it for the three tables that were left on the general
-- rules of private.people_secure_table:
--   * hr_reviews and hr_scorecards: the employee reads their own once it is
--     released. Neither table had a way to say so, so each gains released_at.
--   * hr_announcements: a member reads an announcement once its published_at
--     has come.
-- An owner or admin reads everything, as before. So does any member of the
-- demo workspace, where every row is fictional. Each table keeps its
-- restrictive second-factor policy (mfa_required); it is not touched here.
--
-- Left as they are, on purpose:
--   * hr_documents: a document waiting for a signature is shown to its
--     employee, who is the one who signs it (My Documents counts them).
--   * hr_goals: an employee's goals are theirs to work on from the start.
--
-- No table here has an insert, update or delete grant, and no function writes
-- to them but the demo reseed, so this file changes who may read and nothing
-- else. The slice that adds writing reviews and scorecards sets released_at
-- when HR releases one.

-- ---- reviews and scorecards: released_at ------------------------------------
-- Null means not released. A new row is not released until someone says so.
alter table public.hr_reviews add column released_at timestamptz;
alter table public.hr_scorecards add column released_at timestamptz;

-- Every row that exists today could already be read by its employee, so each
-- counts as released from the moment it was made. Nothing anyone can see now
-- is taken away by this file.
update public.hr_reviews set released_at = created_at;
update public.hr_scorecards set released_at = created_at;

-- ---- who may read -------------------------------------------------------------
-- The same shape as hr_payslips_select and hr_letters_select.

drop policy hr_reviews_select on public.hr_reviews;
create policy hr_reviews_select on public.hr_reviews for select to authenticated using (
  private.is_org_admin(org_id)
  or (released_at <= now() and private.is_own_employee(employee_id))
  or (private.is_demo_org(org_id) and private.is_org_member(org_id)));

drop policy hr_scorecards_select on public.hr_scorecards;
create policy hr_scorecards_select on public.hr_scorecards for select to authenticated using (
  private.is_org_admin(org_id)
  or (released_at <= now() and private.is_own_employee(employee_id))
  or (private.is_demo_org(org_id) and private.is_org_member(org_id)));

drop policy hr_announcements_select on public.hr_announcements;
create policy hr_announcements_select on public.hr_announcements for select to authenticated using (
  private.is_org_admin(org_id)
  or (published_at <= now() and private.is_org_member(org_id))
  or (private.is_demo_org(org_id) and private.is_org_member(org_id)));
