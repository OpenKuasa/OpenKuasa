-- Lekiu: a scorecard is its employee's to read once HR has released it.
--
-- The rule "a record about an employee is theirs to read once it is released"
-- is already written for every other table it applies to:
--   * hr_payslips (once paid) and hr_letters (once issued):
--     20261027090000_people_payroll_writes.
--   * hr_reviews (once status = 'released'):
--     20261028090000_people_performance_writes.
--   * hr_announcements (a member reads one once status = 'published'):
--     20261028090100_people_training_announcements_writes.
-- None of those is touched here. hr_scorecards is the one table left on the
-- general "personal" rule of private.people_secure_table (the employee always
-- reads their own). This file gives it the same rule as a review.
--
-- An owner or admin reads every scorecard, as before. So does any member of
-- the demo workspace, where every row is fictional. The table keeps its
-- restrictive second-factor policy (mfa_required); it is not touched here.
--
-- hr_scorecards has no insert, update or delete grant, and nothing writes to
-- it but the demo reseed, so this file changes who may read and nothing else.
-- The demo reseed does not set released_at; in the demo every member reads
-- every row whatever it says. The slice that adds writing scorecards sets
-- released_at when HR releases one.
--
-- Left as they are, on purpose:
--   * hr_documents: a document waiting for a signature is shown to its
--     employee, who is the one who signs it (My Documents counts them).
--   * hr_goals: an employee's goals are theirs to work on from the start.
--
-- Safe with the app deployed before or after it: no screen reads this table.

-- ---- released_at -----------------------------------------------------------------
-- Null means not released. A new row is not released until someone says so.
alter table public.hr_scorecards add column released_at timestamptz;

-- Every row that exists today could already be read by its employee, so each
-- counts as released from the moment it was made. Nothing anyone can see now
-- is taken away by this file.
update public.hr_scorecards set released_at = created_at;

-- ---- who may read -------------------------------------------------------------
-- The policy being replaced is the one private.people_secure_table made for a
-- 'personal' table (20261014090500_people_performance, the last line that
-- names hr_scorecards; the rule text is in 20261014090000_people_core). The
-- new one is that rule with the release test added to the employee's own
-- branch: the same shape as hr_reviews_select.

drop policy hr_scorecards_select on public.hr_scorecards;
create policy hr_scorecards_select on public.hr_scorecards for select to authenticated using (
  private.is_org_admin(org_id)
  or (released_at is not null and private.is_own_employee(employee_id))
  or (private.is_demo_org(org_id) and private.is_org_member(org_id)));
