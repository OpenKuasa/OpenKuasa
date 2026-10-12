# Lekiu L6a: Performance, Training and Announcements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan. Tasks 1 and 2 run one after the other. Tasks 3, 4 and 5 run in parallel after Task 2 (superpowers:dispatching-parallel-agents), each on its own files. Task 6 is run by the coordinator and stops for the owner. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Employees keep their own goals and enrol themselves in training; owners and admins write reviews and release them when ready, run the courses, and post announcements with drafts and per-person unread marks; on the screens and through Ask-Lekiu.

**Architecture:** As L2 to L5. The rules live in the database: one `security definer` function per action, no write grant on any table. `src/lib/people/performance-writes.ts` and `announcement-writes.ts` wrap each function (schema, call, refusal code to sentence). Server actions and Lekiu's tools both call those write paths and nothing else. A review is one record that the Scorecard and Review Scores screens both read.

**Tech Stack:** Supabase Postgres (plpgsql, RLS), Next.js 16 App Router, AI SDK v7, Zod v4, Vitest, pnpm.

**Spec:** `docs/superpowers/specs/2026-10-12-lekiu-performance-design.md`. It is the authority: §4 gives every column, table, read rule, rule, function with its refusals, and the codes; §5 gives the sentences, the screens and Lekiu's tools. This plan gives the order of work, the files, the interfaces between tasks, and the tests each task must pass.

**How this plan is written:** like L2 to L5, it gives interfaces, rules and required tests, not every line of code. L5 (payroll) is the closest pattern throughout: `supabase/migrations/20261027090000_people_payroll_writes.sql`, `supabase/tests/people_payroll_check.sql`, `tests/people-payroll-schema.test.ts`, `src/lib/people/payroll-writes.ts`, `payroll-refusals.ts`, `payroll-forms.ts`, `src/app/(app)/people/payroll-actions.ts`, `src/components/people/payroll-run-controls.tsx` and `payslip-*.tsx`, and the payroll tools in `src/lib/ai/people-tools.ts` with their cards in `src/lib/chat/change-titles.ts`. For acting on one's own record read L2 (`src/app/(app)/people/leave-actions.ts`) and L4 (`attendance-actions.ts`).

## Global Constraints

- pnpm only. One test file: `pnpm vitest run --dir tests <exact-file-name>.test`. **Always the exact file name**: a prefix such as `people-performance` also matches `people-performance.rls.test.ts`, which runs against the live production database. Never run a file whose name contains `.rls.` or `.live.`, and never `pnpm test`, except the coordinator in Task 6.
- Before writing a server action, route change or client component, read the matching page under `node_modules/next/dist/docs/`.
- **Nothing in this plan is applied to the live database** until Task 6, and then only with the owner's explicit go-ahead. Task 1 verifies on a local scratch Postgres only. No subagent uses any Supabase MCP tool.
- No table gets an insert, update or delete grant. Every write is a function call.
- The acting user always comes from the session (`auth.uid()`); the workspace from the row named, and from an argument only for a new course or announcement, where it is checked against the caller's role. **A member's own `employee_id` comes from the viewer, never from a form field, a URL or the model.**
- Owner and admin actions: in the database `private.is_org_admin`, in the app `can(role, 'approve')`, checked before any read. Never `role !== 'viewer'`.
- The demo workspace is read-only: every function refuses there, the actions refuse it before asking the database, and nobody in it holds a change tool.
- **A draft review never reaches the person it is about**: not a row, not a count, not an average, not a sentence from Lekiu. The database decides; every model a member's screen uses filters again to `released`; every average counts released reviews only.
- A draft announcement never reaches a member; the same double rule.
- No score or average is computed in the app: `score` is the row's. Course status is the one exception, worked out from the dates by ONE pure helper used everywhere (Malaysia time, through `src/lib/people/dates.ts`).
- Never log a goal's title, a review's comment or scores, a course's name or an announcement's title or body. Log the database's code and the function's name only.
- Refusal sentences live in one leaf module with no imports (`src/lib/people/performance-refusals.ts`), re-exported by the write paths. Tests take sentences from it, never as literals, except the one test that pins the whole list.
- Ids are validated with `z.guid()`, never `z.string().uuid()`. An optional id a model may send is `.nullish()`, and an empty string from a model means none (`src/lib/people/loose-input.ts`). A non-string, non-null id is refused, never read as "add".
- A card states exactly what will be saved, in full, every time; anything the conversation suggests about the row's state is a hedged second sentence, never a replacement. A tool's input is normalised by the same helper the card uses. Card facts follow changes made earlier in the same chat (the newest of lookup or change wins).
- An input that can only fail (an unreadable period, a score that is not 1 to 5 in half steps, a blank title) is refused at the tool's schema, before any card.
- Pulling a released review back to draft exists on the Review Scores screen only. It is never a Lekiu tool.
- A chat route's `onError` logs only the error's name. Every new change tool is added to `PEOPLE_WRITE_TOOL_NAMES` in `src/lib/ai/products.ts`: a tool missing from it runs with no card.
- The language block at the top of `LEKIU_SYSTEM` stays first and unchanged.
- No model call in any automated test. No change to Tuah. No Kuasa names in `src/`. No purple or violet.
- A live test creates its users and workspaces through `tests/helpers/live-workspaces.ts` (`createConfirmedTestUser` for a real member), and nothing else.
- A component a member's page renders imports nothing that reaches an owner-only server action (a test walks the imports, as `tests/people-payroll-screen.test.ts` does for `payslip-detail.tsx`).
- 2-space indent, single quotes, semicolons, named exports (screens keep `export default`).
- The migrations are `20261028090000_people_performance_writes.sql`, `20261028090100_people_training_announcements_writes.sql` and `20261028090200_people_performance_demo_seed.sql`; re-check just before the PR that they still sort after everything on `main` and share a 14-digit version with nothing (L4 and L5 each had to renumber twice).

## Review Focus

1. **A draft leaking**: a member's own draft review through the API, Scorecard, Review Scores, the Dashboard and Overview averages, `getPerformanceSummary`, `listReviews`, or Lekiu's wording ("your review is not ready yet" is a leak); a draft announcement through the list, the unread count or Lekiu. Tasks 1, 2, 4, 5.
2. **Acting for someone else**: a member saving or removing a colleague's goal, enrolling or withdrawing a colleague, by passing another employee's id to the function, the action or the tool. Tasks 1, 2, 3, 5.
3. **Unread marks**: another person's marks unreadable and unchangeable; the count per person; nothing published before you joined counts; an edit does not re-mark; re-publishing does not re-mark; the demo is always zero; opening the page as an owner does not mark it read for anyone else. Tasks 1, 4.
4. **Dates and status**: a course's status on its first day, its last day and the day after, in Malaysia time whatever the server's zone; enrol and withdraw at each boundary; the same helper on the screen and in Lekiu. Tasks 1, 2, 3, 5.
5. **Lekiu's cards**: a release card carries the four scores, the rating and the comment in full; a publish card carries the whole body; a card after an earlier change in the same chat shows the current values; a member asking to release, to post or to "pull back" gets a plain "this is for an owner or admin" (or "on the Review Scores screen") with no lookup and no question. Task 5.

---

### Task 1: The database (most capable model)

**Files:**
- Create: the three migrations named above
- Create: `supabase/tests/people_performance_check.sql`
- Create: `tests/people-performance-schema.test.ts`
- Modify: `supabase/tests/people_rls_check.sql` (a member reads their own review only when released, an announcement only when published; read marks are one's own)
- The third migration replaces `private.reseed_demo_people()` with `create or replace` (copy the whole function from `20261027090000_people_payroll_writes.sql`, the latest definition, and change only what §4.4 says); it does not edit any applied migration file, and it does NOT run the re-seed (the hourly job will).

**Interfaces (produced; Tasks 2 to 5 rely on these exact names and shapes):**

```
hr_save_goal(p_employee uuid, p_goal uuid, p_title text, p_progress int, p_due_date date, p_at_risk boolean)
  -> jsonb { id, employee_id, title, progress, due_date, status }          (p_goal null adds)
hr_delete_goal(p_goal uuid)                                  -> jsonb { id, employee_id }
hr_save_review(p_employee uuid, p_review uuid, p_period text, p_competencies jsonb, p_rating text, p_comment text)
  -> jsonb <review>                                                          (p_review null adds; always a draft)
hr_release_review(p_review uuid)                             -> jsonb <review>
hr_unrelease_review(p_review uuid)                           -> jsonb <review>
hr_delete_review(p_review uuid)                              -> jsonb { id, employee_id }
hr_save_training(p_org uuid, p_training uuid, p_title text, p_category text, p_provider text, p_starts_on date, p_ends_on date)
  -> jsonb { id, title, category, provider, starts_on, ends_on }
hr_delete_training(p_training uuid)                          -> jsonb { id }
hr_enrol(p_training uuid, p_employee uuid)                   -> jsonb { training_id, employee_id, completed: false }
hr_unenrol(p_training uuid, p_employee uuid)                 -> jsonb { training_id, employee_id }
hr_set_training_completed(p_training uuid, p_employee uuid, p_completed boolean)
  -> jsonb { training_id, employee_id, completed }
hr_save_announcement(p_org uuid, p_announcement uuid, p_title text, p_body text, p_category text, p_publish boolean)
  -> jsonb <announcement>
hr_publish_announcement(p_announcement uuid)                 -> jsonb <announcement>
hr_unpublish_announcement(p_announcement uuid)               -> jsonb <announcement>
hr_delete_announcement(p_announcement uuid)                  -> jsonb { id }
hr_mark_announcements_read(p_org uuid)                       -> jsonb { marked: int }
hr_unread_announcements(p_org uuid)                          -> int

<review> = { id, employee_id, period, competencies: { Delivery, Teamwork, Ownership, Communication }, score, rating,
             comment, status, released_at, reviewer_name, reviewed_at }
<announcement> = { id, title, body, category, status, published_at, edited_at, author_name }
```

Columns, tables, read rules, rules, refusals and codes: spec §4.1 to §4.5, exactly.

- [ ] **Step 1: The schema test first.** `tests/people-performance-schema.test.ts` reads the three files as text (as `tests/people-payroll-schema.test.ts` does) and asserts: the three names, their order, and that no other migration shares a version; every column, check and table of §4.1; `hr_reviews.score` is `numeric(3,2)`; RLS on and select-only for `hr_announcement_reads` with an own-rows policy; the two changed read policies carry `status = 'released'` / `status = 'published'` for a member and keep each table's `mfa_required` policy; each of the seventeen public functions is `security definer` with `set search_path = public`, revoked from `public` and `anon`, granted to `authenticated`, and refuses the demo; every code of §4.5 appears and no `raise exception` carries anything but a bare code; the third file contains exactly one function, the re-seed, and no `select private.reseed_demo_people()`; diffed line by line against the re-seed in the payroll migration, only the reviews, announcements and enrolments blocks differ. Run it: it fails (no files).
- [ ] **Step 2: Write the three migrations** to §4. Each file must apply cleanly on its own after the previous one, with the deployed (older) app still running: new columns nullable or defaulted; existing announcements `published` with their time kept; `hr_scorecards` and `hr_trainings.status` untouched. Every write function locks the row it changes before reading it.
- [ ] **Step 3: Run the schema test** until it passes.
- [ ] **Step 4: Write the access check**, `supabase/tests/people_performance_check.sql`, one `do` block in one transaction that raises `PEOPLE_PERFORMANCE_CHECK PASSED (everything rolled back)` at the end and `PEOPLE_PERFORMANCE_CHECK FAILED (<n>): <what>` at the first wrong answer, built as `people_payroll_check.sql` is, with fixed dates so it does not depend on the day it runs (plant course dates relative to a fixed "today" only where the function reads the real date: then derive them from the real Malaysia date so every branch runs on any day). It must prove, at least:
  - each function for: an owner and an admin (succeed); the employee concerned (succeeds only where §4.4 says "own"); another member, a viewer, an owner of another workspace, a demo member, and no session (refused, with the code §4.5 gives; `_NOT_FOUND` where an id is named);
  - goals: add, edit, finish at 100 (status `done` whatever `p_at_risk` says), at risk below 100, the 31st open goal refused while a done one does not count, a colleague's goal id refused, a goal id of another employee passed with one's own `p_employee` refused; delete;
  - reviews: a draft saved with each bad input refused (a fifth key, a missing key, 0.5, 5.5, 3.25, a bad period, a year out of range, a 2,001-character comment, an unknown rating); the average to two decimals for a fixed set; a second review for the same period refused; edit and delete only as a draft; release sets `released_at`; a released one refuses save and delete; pull back clears it; `reviewer_name` from the caller's employee record, and from their account when they have none;
  - reading: as the employee, zero rows of their own draft review and exactly their own released one; never a colleague's; an admin reads all; the demo member reads everything in the demo; a member calling `hr_release_review` on their own draft gets `PERF_NOT_FOUND`;
  - training: bad input refused (end before start, a missing date, a blank title); self-enrol on the day before the start, the first day, the last day (all succeed) and the day after (refused `PERF_COURSE_ENDED`); self-withdraw the day before the start (succeeds) and on the first day (refused `PERF_COURSE_STARTED`); an inactive employee's self-enrol refused; an admin enrols and removes at any time; completion refused before the start and for someone not enrolled; a completed person cannot be removed or withdraw; a course with a completion cannot be deleted, and can once it is undone; a member enrolling a colleague refused;
  - announcements: draft invisible to a member and visible to an admin; publish sets the time and the author; edit sets `edited_at` and keeps the time; pull back hides it; publish again sets a new time; delete removes read marks; bad input refused (blank title, 5,001-character body, unknown category);
  - unread: two members with different counts; marking read changes only the caller's; something published before a member joined never counts for them; an edit does not re-mark; pull back then publish again does not re-mark for someone who had read it; a draft never counts; the demo's count is 0 and marking is refused there; a member cannot select another member's read rows;
  - nothing in any of the seven tables can be inserted, updated or deleted directly by `authenticated` or `anon`.
- [ ] **Step 5: Run everything on a scratch Postgres** (build it as L5's Task 1 did: stubs for `auth` and `storage`, every migration applied in order, cron files skipped; then run the re-seed once by hand to prove the new one works): this check, and `people_rls_check.sql`, `people_leave_check.sql`, `people_claims_overtime_check.sql`, `people_attendance_check.sql`, `people_payroll_check.sql`, all `PASSED`. Then a mutation pass: break each rule one at a time (at least 50 mutations across the caller tests, the read policies, the review rules, the date boundaries and the unread rule) and record that the check or the schema test catches each; for any survivor, either strengthen the check or show it is equivalent by naming a call sequence that cannot tell the two apart. Delete the scratch database afterwards.
- [ ] **Step 6: Commit** the six files: `feat(people): goals, reviews, training and announcements, decided in the database`. The report carries a section "Facts for Tasks 2 to 5": argument forms, returned shapes, which code each caller gets, and anything the spec does not state exactly.

---

### Task 2: The app's write path

**Files:**
- Create: `src/lib/people/performance-writes.ts`, `announcement-writes.ts`, `performance-refusals.ts`, `performance-forms.ts`, `src/app/(app)/people/performance-actions.ts`, `announcement-actions.ts`
- Modify: `src/lib/people/types.ts`, `supabase.ts`, `seed.ts`, `performance.ts`, `company.ts`, `summaries.ts`, `tests/setup/people-member-view.ts`
- Test: `tests/people-performance-writes.test.ts`, `tests/people-announcement-writes.test.ts`, `tests/people-performance-forms.test.ts`, `tests/people-performance-actions.test.ts`, extend the existing model tests for `performance.ts` and `company.ts`, `tests/people-performance.rls.test.ts` (write, do not run)

**Interfaces**

Consumes: Task 1's seventeen functions and shapes.

Produces (Tasks 3 to 5 rely on these):

```ts
// src/lib/people/types.ts
export const COMPETENCIES = ['Delivery', 'Teamwork', 'Ownership', 'Communication'] as const;
export type Competency = (typeof COMPETENCIES)[number];
export type ReviewStatus = 'draft' | 'released';
// Review gains: competencies: Record<Competency, number>, comment: string | null, status: ReviewStatus, released_at: string | null
// Announcement gains: status: 'draft' | 'published', edited_at: string | null, unread: boolean; published_at becomes string | null
// TrainingEnrolment gains: completed_at: string | null
// Scorecard is derived from Review; listScorecards is removed from PeopleData

// src/lib/people/performance-writes.ts   (each returns CapResult<...>)
saveGoal(ctx, { employee_id, goal_id?, title, progress, due_date?, at_risk }), deleteGoal(ctx, { goal_id }),
saveReview(ctx, { employee_id, review_id?, period, competencies, rating, comment? }), releaseReview(ctx, { review_id }),
unreleaseReview(ctx, { review_id }), deleteReview(ctx, { review_id }),
saveTraining(ctx, { training_id?, title, category?, provider?, starts_on, ends_on }), deleteTraining(ctx, { training_id }),
enrol(ctx, { training_id, employee_id }), unenrol(ctx, { training_id, employee_id }),
setTrainingCompleted(ctx, { training_id, employee_id, completed })
// src/lib/people/announcement-writes.ts
saveAnnouncement(ctx, { announcement_id?, title, body, category, publish }), publishAnnouncement(ctx, { announcement_id }),
unpublishAnnouncement(ctx, { announcement_id }), deleteAnnouncement(ctx, { announcement_id }),
markAnnouncementsRead(ctx), unreadAnnouncements(ctx): Promise<number>     // 0 on any failure; never throws
// src/lib/people/performance-refusals.ts  (leaf; no imports)
export const PERFORMANCE_REFUSALS: Record<string, string>;     // spec §5.1, every code

// src/lib/people/performance-forms.ts   (pure)
reviewPeriods(today: string): string[]                 // the current and previous two years x H1, H2, FY, newest first
toPeriod(text: string): string | null                  // 'H1 2026' | 'h1 2026' | '2026 H1' | 'FY2026' -> 'H1 2026' form; null otherwise
toScore(text: string | number): number | null          // 1 to 5 in steps of 0.5 only
toGoalInput(values), toReviewInput(values), toTrainingInput(values), toAnnouncementInput(values)   // Converted<...>
courseStatus(course: { starts_on: string | null; ends_on: string | null }, today: string): 'upcoming' | 'in_progress' | 'completed'
canSelfEnrol(course, today), canSelfWithdraw(course, enrolment, today): boolean

// server actions ('use server')
// own: saveMyGoalAction, deleteMyGoalAction, enrolMeAction, withdrawMeAction, markAnnouncementsReadAction   (employee from the viewer)
// owner/admin: saveGoalForAction, deleteGoalForAction, saveReviewAction, releaseReviewAction, unreleaseReviewAction,
//   deleteReviewAction, saveTrainingAction, deleteTrainingAction, enrolAction, unenrolAction, setTrainingCompletedAction,
//   saveAnnouncementAction, publishAnnouncementAction, unpublishAnnouncementAction, deleteAnnouncementAction
```

Rules:
- The provider selects the new columns; `listReviews` and `listAnnouncements` apply no status filter (the database decides); `listAnnouncements` carries `unread` for the caller (join the caller's read marks; the provider needs the caller's membership time: read it once).
- `buildScorecardModel` and `buildReviewsModel` take reviews. For a non-team viewer they filter to `released` and the viewer's employee; for a team viewer drafts are returned marked and left out of every average. `performanceSummary`, the Dashboard and the Overview count released reviews only.
- `buildTrainingModel` uses `courseStatus`; nothing reads `hr_trainings.status`.
- `buildAnnouncementsModel` puts drafts first for a team viewer and never returns one otherwise.
- `seed.ts` mirrors the demo re-seed.
- `tests/setup/people-member-view.ts`: a member gets their own released reviews and published announcements only.
- `tests/people-performance.rls.test.ts` (live; first run in Task 6): an owner and a confirmed member (`createConfirmedTestUser`) in a fresh workspace: the member's goal round trip and a refused colleague's goal; a draft review invisible to the member, visible once released, invisible again after pull back; a course with real dates around today for self-enrol and the admin's completion; an announcement draft invisible, published and unread for the member only, read after marking, and the owner's count unaffected; every owner-only write refused for the member with the sentence from `PERFORMANCE_REFUSALS`; the demo guest changes nothing. It must not run its demo part in minutes :00 to :02.

- [ ] **Step 1: Tests first** for `performance-forms.ts` (every form in the comments above; `courseStatus` and the two `can…` rules at each boundary; hostile inputs for `toScore` such as `'3,5'`, `'5.0'`, `'05'`, `'1e0'`, `''`), for both write paths with a fake client (each function sends exactly the arguments Task 1 names; each code becomes its sentence; an unknown error becomes `WRITE_FAILED` and nothing typed is logged; a non-string, non-null id is refused), and for the actions (the own-record actions take the employee from the viewer and refuse an unlinked account; a member, a viewer and the demo are refused before any read on the owner-only ones). Run them and watch them fail.
- [ ] **Step 2: Write the code** until those pass, then the model tests (a draft never in a member's model, never in any average; drafts first for a team viewer), and the live test file.
- [ ] **Step 3:** `pnpm tsc --noEmit` and `pnpm lint` clean. Commit: `feat(people): the performance and announcement write paths, forms and actions`. The report carries "Facts for Tasks 3 to 5".

---

## Parallel tasks: 3, 4 and 5 (after Task 2)

Each touches only its own files, does not commit, and does not run `pnpm tsc`, `pnpm lint`, `pnpm build` or `pnpm test`: the coordinator commits each and typechecks once all three have landed. Each runs its own test files by exact name and `pnpm eslint <its files>`. Vitest has no DOM: every rule that can be pure goes in a tested pure function, and each report ends with the component-only behaviours left for the browser pass, worst first.

### Task 3: Goals and Training

**Files:** modify `src/screens/people/my-goals.tsx`, `src/screens/people/training.tsx`, `src/components/people/employees-table.tsx` (the Goals action only); create `src/components/people/goal-form.tsx`, `goal-card-controls.tsx`, `employee-goals.tsx`, `course-form.tsx`, `course-enrolments.tsx`, `enrol-buttons.tsx`; pure rules in a new `src/lib/people/goals-training.ts`; tests `tests/people-goals-training.test.ts`.

Spec §5.2 rows "My Goals", "Employees", "Training". Rules:
- My Goals calls the own-record actions; the Employees "Goals" action (owners and admins only, absent otherwise) opens that employee's goals with the owner-only actions. The two share presentational pieces; a member's page imports nothing that reaches an owner-only action (import-walk test).
- Progress is a whole number 0 to 100; at 100 the at-risk choice is hidden and the card reads "Done". Remove takes a second step. A refusal shows beside the control used and clears when its state changes.
- Training: for a member, exactly one of Enrol, Withdraw, "You are enrolled", "Completed" per course, chosen by a pure function from `courseStatus`, `canSelfEnrol`, `canSelfWithdraw` and the enrolment; an unlinked account sees none. For owners and admins: Add course, Edit, Remove (second step; when someone is completed the control says why it will be refused, from data), and the enrolment list with Enrol someone (employees not yet enrolled), Remove and Mark completed (absent before the course starts).

### Task 4: Reviews, Scorecard, Announcements and the unread count

**Files:** modify `src/screens/people/review-scores.tsx`, `scorecard.tsx`, `announcements.tsx`, `src/screens/people/dashboard.tsx` and `assistant.tsx` (only if a figure there read scorecards), the app layout that fills `NavBadges` and `src/config/nav.ts` (the badge key for Announcements); create `src/components/people/review-form.tsx`, `review-row-controls.tsx`, `announcement-form.tsx`, `announcement-row-controls.tsx`, `mark-announcements-read.tsx`; pure rules in a new `src/lib/people/reviews-announcements.ts`; tests `tests/people-reviews-announcements.test.ts`.

Spec §5.2 rows "Review Scores", "Scorecard", "Announcements", "Navigation", "Dashboard, Overview". Rules:
- Review form: employee, period from `reviewPeriods`, four scores (1 to 5 in half steps, one control each), rating, comment. The overall score is shown only from a saved row, never computed in the form.
- Release and Pull back take a second step with the sentences "<Name> will be able to see this review." and "<Name> will no longer see this review." Delete (drafts only) takes a second step.
- Scorecard for owners and admins marks drafts and excludes them from every average and chart; for a member it shows released reviews only (through the model; assert it in a test with a draft in the input).
- Announcements: opening the page as a signed-in, non-demo person calls `markAnnouncementsReadAction` once, after the list has rendered with its unread marks (so the person sees which were new); it must not fire in the demo or during a prefetch. Drafts first for owners and admins.
- The unread count: read with `unreadAnnouncements` in the layout that already fills `NavBadges` for the marketing product (find it: grep `NavBadges`), only for a signed-in member of a non-demo workspace, and never blocking the page if it fails (0).

### Task 5: Lekiu

**Files:** modify `src/lib/ai/people-tools.ts`, `src/lib/ai/products.ts`, `src/lib/ai/agents/prompts.ts`, `src/lib/chat/change-titles.ts`; tests `tests/people-performance-tools.test.ts`, `tests/people-performance-approval.test.ts`, extend `tests/people-change-titles.test.ts`, `tests/lekiu-prompt.test.ts`, `tests/people-chat-route.test.ts`, `tests/people-tools.test.ts`, `tests/people-change-tools.test.ts`.

Spec §5.3. Rules:
- Tiers: `saveGoal`, `removeGoal`, `enrolInTraining`, `withdrawFromTraining` for any linked employee (their own employee id from the viewer; an `employee_id` argument is accepted only from the `hr` tier) and for the `hr` tier for anyone; every other change tool for the `hr` tier only; none in the demo. Absent, not disabled. No tool pulls a review back to draft.
- Inputs a model sends: `period` normalised by `toPeriod`; each score by `toScore`; dates as `YYYY-MM-DD`; ids from lookups; `''` for an optional id means none. The card uses the same normalisers. Unreadable ones are refused at the schema.
- Lookups by tier: `listReviews` gives a member their own released reviews and no ids; the `hr` tier every review with its status and ids. `listAnnouncements` gives a member published ones with `unread`; the `hr` tier drafts too, with ids. `listTrainings` gives each course's worked-out status and, for the `hr` tier, who is enrolled. `listGoals` gives ids to whoever may change them. `getPerformanceSummary` counts released reviews only.
- Cards: spec §5.3 table, in full every time; a release card and a publish card carry everything that will become visible; facts follow earlier changes in the same chat; a fact from the conversation that suggests a refusal (already released, already published, course ended) is a hedged second sentence in the detail.
- Prompt: the rules of spec §5.3; each "you do not hold this tool" case has its own line saying what to say and what not to do (a member asking to release a review, post an announcement, mark a completion, change a colleague's goal; anyone asking to pull a review back); a member is never told a draft exists: "no review on record for you for that period" is the whole answer.
- Every change tool drives through the SDK's input parsing in the approval test (first-turn rows with extra arguments, `''` and `null` for optional ids, a wrong type), asserts the write runs exactly once after approval with the normalised values, and at least one row per tool builds its card title WITH a finder from an earlier lookup.

---

### Task 6: Bring it together (coordinator)

- [ ] **Step 1:** Commit Tasks 3 to 5 by path, `pnpm tsc --noEmit`, `pnpm lint`, `pnpm build`. Run the full `pnpm test` (expected red until the migrations are applied: `tests/people-performance.rls.test.ts`, `tests/people-provider.rls.test.ts`, and any live test that reads reviews or announcements), confirming the live workspace count is unchanged afterwards.
- [ ] **Step 2:** Whole-branch review on the most capable model, one fix wave, one scoped re-review.
- [ ] **Step 3:** Read-only live pre-check: the migrations are not applied; counts of goals, reviews, courses, enrolments and announcements in real workspaces (expected none outside the demo); the Postgres version; the foreign-key names the provider's embeds use.
- [ ] **Step 4: Stop for the owner's go-ahead to apply the three migrations.** Apply them one at a time, in order, not at minutes :00 to :02; after each, confirm every function body matches the file by hash, plus owners, grants, policies and checks from the catalogue. The third (the demo re-seed) goes on last, immediately before the merge.
- [ ] **Step 5:** `people_performance_check.sql` and `people_rls_check.sql` on live (rolled back), one fresh agent per script, each started between minute :05 and :52, never two at once; stop any agent left holding a timer. Then the full `pnpm test`.
- [ ] **Step 6:** Browser passes on a dev server, in this order: a demo visitor in the automation browser BEFORE the member signs in there (every new control absent, no unread count); the owner in Chrome (a goal for an employee; a draft review, release, pull back; a course with enrolment and completion; a draft announcement, publish); the member test account `smoke-member@openkuasa-test.dev` (own goal add and progress; no draft review visible, then the released one; enrol and withdraw; the unread count appears, the announcement is marked as new, and the count clears after opening the page; no owner control anywhere). The owner signs each account in.
- [ ] **Step 7:** Real Lekiu questions, in English and in Bahasa Malaysia: as owner "write a review for <employee> for H2 2026 …" then "release it" (two cards, the second carrying everything), "pull it back" (declined, pointed to the screen), "post an announcement that …" (card with the full body); as the member "add a goal …", "what was my review?" before and after release, "post an announcement" (for an owner or admin; no card). About five billed calls, agreed in the design.
- [ ] **Step 8:** Leave the owner's workspace as found unless the owner wants the test rows kept. Execution Notes in this file; rebase; re-check the migrations' versions; push; PR titled `feat-128-lekiu-performance`. Merge only on the owner's say; apply the third migration immediately before it.

## Not in this plan

Everything in the spec's "Out" list. Also: dropping `hr_scorecards` and `hr_trainings.status`; Jebat, Kasturi and Lekir's reply-language wording; slice L6b.

## Execution Notes (2026-10-12)

- **Built as planned**, tasks 1 to 6, subagent-driven; tasks 3 to 5 in parallel. Each task was reviewed; a whole-branch review and one fix wave followed, then a scoped re-review (clean).
- **Rulings made during the build:**
  - "A member's page imports nothing that reaches an owner-only action" became "a component written for members names no owner-only action, and a screen renders an owner component only for an owner or admin outside the demo", decided by pure functions tested for every kind of viewer. The server refuses in any case.
  - The unread count is read in `src/app/(app)/people/layout.tsx` only, so no other product's pages pay for it. The badge appears after hydration.
  - Undoing a completion is always allowed; only marking needs the course to have started.
  - For an owner or admin, a Lekiu change with no employee named falls back to their own record, as the leave tools do; the card says so.
  - All three migrations were applied together (the plan held the re-seed back until the merge): the live check needs the new re-seed.
- **Applied to live** 2026-10-12, about 08:50 MYT, one file at a time with a 5-second lock timeout. All 27 function bodies match their files by hash. The demo was re-seeded once by hand: 20 reviews (2 drafts), 6 announcements (1 draft).
- **Checked on live:** `people_performance_check.sql` and `people_rls_check.sql` both PASSED (rolled back). Full `pnpm test` after the apply: 288 files, 5,830 tests, none failing.
- **Browser passes:** demo visitor (separate signed-out context), owner, member: all pass. A member sees no draft review and no draft announcement in any form; the unread badge shows and clears on viewing.
- **Real Lekiu questions (5):** an owner's goal for a named employee (card names them; saved); all reviews in Bahasa Malaysia (draft marked); pulling a review back (declined, pointed to the screen, no card); a member asking about a period with a draft ("no review on record", no hint); a member enrolling in Bahasa Malaysia (card, saved).
- **Known, not fixed here:**
  - After a Bahasa Malaysia turn, an English question was answered in Bahasa Malaysia (the decline in question 3). The language block was out of scope for this slice.
  - Approval cards are always in English.
  - An inactive linked employee is offered Enrol; the database refuses with the right sentence.
  - A member enrolled in an upcoming course sees Withdraw without the words "You are enrolled".
  - The demo still shows the disabled sample buttons ("Available in a later update") on My Goals and Training, as on other Lekiu screens.
  - `hr_scorecards` and `hr_trainings.status` are kept and unused.
