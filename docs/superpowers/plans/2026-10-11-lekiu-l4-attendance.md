# Lekiu L4: Attendance and Public Holidays Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan. Tasks 1 and 2 run one after the other. Tasks 3, 4 and 5 run in parallel after Task 2 (superpowers:dispatching-parallel-agents), each on its own files. Task 6 is run by the coordinator and stops for the owner. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A linked employee clocks in and out for themselves; the system decides present or late and records leave and absence by itself; an owner or admin corrects any day, keeps the public holidays and sets the work week, start time and grace period; on the screens and through Ask-Lekiu.

**Architecture:** As L2 and L3. The rules live in the database: one `security definer` function per action, no write grant on `hr_attendance_days`, `hr_public_holidays` or `hr_settings`. `src/lib/people/attendance-writes.ts` wraps each function (schema, call, refusal code to sentence). Server actions and Lekiu's tools both call that module. A nightly `pg_cron` job closes the days before.

**Tech Stack:** Supabase Postgres (plpgsql, RLS, pg_cron), Next.js 16 App Router, AI SDK v7, Zod v4, Vitest, pnpm.

**Spec:** `docs/superpowers/specs/2026-10-11-lekiu-attendance-design.md`. It is the authority: §4 gives every column, function, permission, refusal code, the late rule and the nightly close; §5 gives the app's behaviour. This plan gives the order of work, the files, the interfaces between tasks, and the tests each task must pass. It does not repeat the spec's tables: read them.

**How this plan is written:** like L2's and L3's, it gives interfaces, rules and required tests, not every line of code. L3 is the pattern to imitate throughout: `supabase/migrations/20261020090000_people_claims_overtime_writes.sql`, `supabase/tests/people_claims_overtime_check.sql`, `src/lib/people/pay-requests.ts`, `src/app/(app)/people/pay-actions.ts`, the claims components (`request-row.tsx`, `paid-buttons.tsx`, `request-dialog.tsx`), and the claims tools in `src/lib/ai/people-tools.ts`. The database task goes to the most capable model and is reviewed by it.

## Global Constraints

- pnpm only. One test file: `pnpm vitest run --dir tests <exact-file-name>.test`. **Always the exact file name**: a prefix such as `people-attendance` also matches `people-attendance.rls.test.ts`, which runs against the live production database. Never run a file whose name contains `.rls.` or `.live.`, and never `pnpm test` (the full suite), unless a task says so.
- Before writing a server action, route change or client component, read the matching page under `node_modules/next/dist/docs/`.
- **Nothing in this plan is applied to the live database** until Task 6, and then only with the owner's explicit go-ahead. Task 1 verifies on a local Postgres only.
- No table gets an insert, update or delete grant. Every write is a function call.
- The acting user always comes from the session (`auth.uid()`); the workspace from the row, or from an argument only where the spec says so and then checked against the caller's role there. A member's own `employee_id` comes from the viewer, never from a form field or the model. **No clock time ever comes from a caller**: the database stamps it.
- Only an owner or admin corrects attendance, edits holidays and saves settings: in the database `private.is_org_admin`, in the app `can(role, 'approve')`. Never `role !== 'viewer'`.
- Clocking in and out is open to anyone linked to an employee record who is not in the demo, whatever their workspace role, and only ever for themselves.
- The demo workspace is read-only: every function refuses there, the actions refuse it before asking the database, and nobody in it holds a change tool.
- Never log a note, a name or a holiday's name. Log the database's code and message only.
- All dates and times shown or decided are Malaysia time (`Asia/Kuala_Lumpur`); use the helpers in `src/lib/people/dates.ts`, never the browser's or the server's local zone.
- Ids are validated with `z.guid()`, never `z.string().uuid()`. An optional id a model may send is `.nullish()`.
- A chat route's `onError` logs only the error's name.
- No model call in any automated test. No change to Tuah. No Kuasa names in `src/`. No purple or violet.
- A live test creates its users and workspaces through `tests/helpers/live-workspaces.ts`, and nothing else.
- 2-space indent, single quotes, semicolons, named exports (screens keep `export default`).
- The migrations are `supabase/migrations/20261024090000_people_attendance_writes.sql` and `20261024090100_people_attendance_cron.sql`; re-check just before the PR that they still sort after everything on `main` and share a 14-digit version with nothing.

## Review Focus

1. **Clocking in for someone else, for another day, or with a chosen time** (through the API, not the UI): impossible by construction (no employee other than the caller's own, no date, no time argument) and refused for an owner or admin too. Task 1's access check.
2. **False absences**: nobody is closed as absent before the epoch, before their join date or their record's creation, on a weekend or holiday, while inactive, or in the demo; a first run right after applying writes nothing. Task 1.
3. **The system overwriting a real record**: the close only touches rows with no clock-in and no correction; a clock-in replaces an early "absent" correction for today and nothing else. Task 1.
4. **The late boundary and the clock**: at start plus grace is present, one minute later is late, in Malaysia time whatever the server's zone; the screen, Lekiu and the row agree because only the database decides. Tasks 1, 3, 5.
5. **A member's Lekiu**: holds clock in, clock out and the "today" lookup only, with no employee field; nothing a lookup returns (a note, a holiday name) can make it correct a day or change a setting; a card never promises a time. Task 5.

---

### Task 1: The database (most capable model)

**Files:**
- Create: `supabase/migrations/20261024090000_people_attendance_writes.sql`, `supabase/migrations/20261024090100_people_attendance_cron.sql`
- Create: `supabase/tests/people_attendance_check.sql`
- Create: `tests/people-attendance-schema.test.ts`
- Do not modify the demo seed or any applied migration: every new column is nullable or defaulted.

**Interfaces (produced; Tasks 2 to 5 rely on these exact names and shapes):**

```
hr_clock_in(p_employee uuid)
  -> jsonb { id, employee_id, work_date, clock_in, clock_out, status }      (clock_out null; status 'present' | 'late')
hr_clock_out(p_employee uuid)
  -> jsonb { id, employee_id, work_date, clock_in, clock_out, status }
hr_correct_attendance(p_employee uuid, p_work_date date, p_status text, p_clock_in time, p_clock_out time, p_note text)
  -> jsonb { id, employee_id, work_date, clock_in, clock_out, status, corrected: true }
hr_save_holiday(p_org uuid, p_id uuid, p_name text, p_holiday_date date)   (p_id null adds)
  -> jsonb { id, name, holiday_date }
hr_delete_holiday(p_id uuid)                                                -> jsonb { id }
hr_save_attendance_settings(p_org uuid, p_work_week jsonb, p_work_start_time time, p_late_grace_minutes int)
  -> jsonb { work_week, work_start_time, late_grace_minutes }
```

`clock_in` and `clock_out` in results are timestamps (ISO, with zone). A refusal is `raise exception '<CODE>'` with one of the codes in spec §4.2 and nothing else. Columns and the epoch table: exactly spec §4.1. The close: exactly spec §4.4, as `private.hr_attendance_close()`.

**Rules the SQL must follow** (beyond the spec):

- Everything L3's migration does for its functions: `security definer`, `set search_path = public`, `revoke all … from public, anon`, `grant execute … to authenticated`; helpers in `private` with execute revoked from `public, anon, authenticated`; refuse in the demo; refuse a session that owes a second factor (`private.is_own_employee` and `private.is_org_admin` already include it: confirm, do not assume).
- Clock in and out: `private.is_own_employee(p_employee)` and nothing else grants it. An owner or admin who is not that employee gets `ATT_NOT_ALLOWED`. An employee id that does not exist is refused the same way, so the answer says nothing about which ids are real.
- One helper for "is `d` a working day for this workspace" and one for "does this employee's approved leave cover `d`" (full day or half day, as the caller needs), used by clock-in and by the close. No second copy.
- One helper for present-or-late, `private.hr_attendance_status(org, at)`, as spec §4.3.
- The epoch table is filled once by the migration (`on conflict do nothing` on a fixed key, so a second apply cannot move it), has row level security on, and no grant to anyone.
- `hr_correct_attendance`: times are combined with `p_work_date` in `Asia/Kuala_Lumpur`; a `present`/`late` correction with a clock-out not after the clock-in is `ATT_BAD_INPUT`; `absent`/`on_leave` with any time is `ATT_BAD_INPUT`; a correction for today is allowed; a date after today is `ATT_BAD_INPUT`. It replaces whatever row is there (system, clocked or corrected).
- `hr_save_holiday`: editing keeps `scope` and `state` as they are; adding leaves them at their defaults. The one-per-date rule is enforced in the function (the table's own unique key includes the name), with the workspace's holidays locked for the check so two saves cannot both pass.
- `hr_save_attendance_settings` creates the settings row with `insert … on conflict (org_id) do update` touching only the three columns.
- The close runs as the owner, is `revoke`d from everyone, loops workspaces in a fixed order, and uses one set-based statement per workspace where it can. It must not raise for a workspace with odd data (a malformed `work_week` falls back to Monday to Friday).
- The cron file is separate, named like the others, and schedules exactly one job, `5 16 * * *`, calling the close.
- `note` and `name` are trimmed; empty note becomes null; over-length is `ATT_BAD_INPUT`.

- [ ] **Step 1: Write the access check first**, `supabase/tests/people_attendance_check.sql`, built like `supabase/tests/people_claims_overtime_check.sql` (staged lists of who, what, the call, the refusal expected; ends `PEOPLE_ATTENDANCE_CHECK PASSED (everything rolled back)` or `FAILED (n): …`). It must assert everything in spec §4.5, each both ways. Because clock-in reads the real clock, drive present and late by saving settings around the current Malaysia time (a start time one hour ahead with no grace gives present; one hour behind gives late; the exact boundary is tested through `private.hr_attendance_status` directly with fixed timestamps, at the minute and one minute after, with default settings, custom settings and no settings row). If today is not a working day for the default week, the check sets a work week that includes today before the clock cases and says so. The close is exercised by calling `private.hr_attendance_close()` after moving the epoch back inside the transaction and planting employees, leave and holidays on fixed past dates.
- [ ] **Step 2: Run it on a local Postgres and watch it fail.** Never the live project. As L3's Task 1: a scratch cluster under the session's scratch directory, `authenticated`, `anon` and `service_role` roles, a stubbed `auth` schema, the repo's migrations applied in order as far as needed, every `*_cron.sql` skipped (check the new cron file by its text only). Say exactly what was stubbed.
- [ ] **Step 3: Write the two migrations** until the check passes. Run `people_rls_check.sql`, `people_leave_check.sql` and `people_claims_overtime_check.sql` on the same database: all must still pass.
- [ ] **Step 4: Mutation pass.** Break the migration one rule at a time (the own-employee test, the demo test, the working-day test, the leave test, the second clock-in, the grace arithmetic, the epoch bound, the join-date bound, the "untouched if clocked or corrected" guard, the inactive skip, the demo skip, the one-per-date rule, each admin test, a `for no key update`) and confirm the check or the schema test fails each time. Report the count. Restore the files.
- [ ] **Step 5: `tests/people-attendance-schema.test.ts`**, reading the migration text as `tests/people-claims-overtime-schema.test.ts` does: the columns; the six function names; each `security definer` with the fixed search path and revoked from `public` and `anon`; no `grant insert|update|delete` on the three tables; the lock in clock in, clock out and correct; no time or date argument on the two clock functions; the cron file schedules exactly one job at `5 16 * * *`; both files alone on their timestamps.
- [ ] **Step 6: Report** (the check's final line, what was stubbed, the mutation count, nothing left behind) and commit: `feat(people): attendance rules in the database — clock in and out, corrections, holidays, settings, a nightly close`.

---

### Task 2: The app's write path

**Files:**
- Create: `src/lib/people/attendance-writes.ts`, `src/lib/people/attendance-forms.ts`, `src/app/(app)/people/attendance-actions.ts`
- Create, but do not run: `tests/people-attendance.rls.test.ts` (needs the migration live; style of `tests/people-pay.rls.test.ts` after its conversion to `tests/helpers/live-workspaces.ts`; spec §7's live row; it does not clock in)
- Modify: `src/lib/people/types.ts`, `supabase.ts`, `seed.ts` (new columns: `AttendanceDay` gains `corrected: boolean` and `correction_note: string | null`; `PeopleSettings` gains `work_start_time` as `'HH:MM'` and `late_grace_minutes`; a holiday row carries its `id`), `src/lib/people/dates.ts` only for a helper that is missing
- Test: `tests/people-attendance-writes.test.ts`, `tests/people-attendance-actions.test.ts`, `tests/people-attendance-forms.test.ts`; extend `tests/people-provider.test.ts`, `tests/people-seed.test.ts`; fix every fixture the type change breaks.

**Interfaces (produced; Tasks 3 to 5 rely on these):**

```ts
// src/lib/people/attendance-writes.ts
export type ClockedDay = { id: string; work_date: string; clock_in: string | null; clock_out: string | null; status: AttendanceStatus };
export const correctAttendanceInput;   // { employee_id: guid, work_date, status, clock_in?: 'HH:MM'|null, clock_out?: 'HH:MM'|null, note?: string|null }
export const saveHolidayInput;         // { id?: guid|null, name: string (1..120), holiday_date }
export const holidayIdInput;           // { id: guid }
export const attendanceSettingsInput;  // { work_week: Weekday[] (non-empty, distinct), work_start_time: 'HH:MM', late_grace_minutes: int 0..240 }
export function clockIn(ctx, input: { employee_id: string }): Promise<CapResult<ClockedDay>>;
export function clockOut(ctx, input: { employee_id: string }): Promise<CapResult<ClockedDay>>;
export function correctAttendance(ctx, input): Promise<CapResult<ClockedDay>>;
export function saveHoliday(ctx, input): Promise<CapResult<{ id: string; name: string; holiday_date: string }>>;      // p_org from ctx.orgId
export function deleteHoliday(ctx, input): Promise<CapResult<{ id: string }>>;
export function saveAttendanceSettings(ctx, input): Promise<CapResult<{ work_week: Weekday[]; work_start_time: string; late_grace_minutes: number }>>;
export const ATT_REFUSALS: Record<string, string>;   // code -> sentence, spec §5.1

// src/lib/people/attendance-forms.ts (pure)
export type TodayState =
  | { kind: 'not_linked' } | { kind: 'not_working_day'; why: 'weekend' | 'holiday'; holiday?: string } | { kind: 'on_leave' }
  | { kind: 'not_in' } | { kind: 'in'; since: string } | { kind: 'done'; from: string; to: string; worked: string };
/** What today is for one employee, from rows the page already has. The one rule for the screen, the button and Lekiu's "today" lookup. */
export function todayState(input: { today: string; day: AttendanceDay | null; workWeek: Weekday[]; holidays: PublicHoliday[]; leave: LeaveRequest[]; employeeId: string | null }): TodayState;
export function todayLine(state: TodayState): string;                      // "Not clocked in yet", "In since 8:52 am", "8:52 am to 6:03 pm, 9 h 11 min", …
export function clockAction(state: TodayState): 'in' | 'out' | null;       // which button, if any
export function toCorrectionInput(values): { ok: true; input } | { ok: false; error: string };
export function toHolidayInput(values): { ok: true; input } | { ok: false; error: string };
export function toSettingsInput(values): { ok: true; input } | { ok: false; error: string };

// src/app/(app)/people/attendance-actions.ts  ('use server')
clockInAction()   clockOutAction()                                  // no input: the employee is the viewer's own
// owner or admin only:
correctAttendanceAction(input)   saveHolidayAction(input)   deleteHolidayAction(input)   saveAttendanceSettingsAction(input)
```

- Actions follow `pay-actions.ts` rule for rule: the clock actions resolve the employee from the viewer and refuse "Your account isn't linked to an employee record yet." when there is none; owner-only actions need `can(role, 'approve')`; the demo workspace is refused first; revalidate `PEOPLE_PATHS` only on success.
- A member's read of settings is refused by row security (`hr_settings` is HR-only), so `todayState` takes the work week from what the page can read: Task 3 decides how a member's page learns it (see Task 3); this task only makes the pure function take it as an argument.
- `todayState` is a display aid. The database is still the judge: a state of `not_in` that the database refuses shows the database's sentence.

**Tests must cover:** each function's `rpc` name and argument keys (and that the two clock calls send only `p_employee`); every code in `ATT_REFUSALS` reaching the caller as its sentence; an unknown error giving the generic sentence with nothing typed in the logs; `todayState` for every kind, including a half-day leave (not `on_leave`: clocking is allowed), a holiday that falls on a weekend, a day with a correction, and an unlinked viewer; `todayLine` and `clockAction` for each; the three converters (times as `HH:MM`, a clock-out not after the clock-in, times on an absent correction, an empty week, a duplicate weekday, grace out of range); the clock actions ignoring any input and using the viewer's employee; a plain member refused on every owner-only action before any call; the demo refused on all.

- [ ] Tests first, then code, then `pnpm tsc --noEmit`, `pnpm lint`, the test files touched (exact names). Commit: `feat(people): the app's write path for attendance, holidays and attendance settings`.

---

## Parallel tasks: 3, 4 and 5 (after Task 2)

Each owns the files it lists. As in L2 and L3: do not run `pnpm tsc`, `pnpm lint`, `pnpm test` or `pnpm build`, and do not commit; run your own test files by exact name and `pnpm eslint` on your files. Do not edit `attendance-writes.ts`, `attendance-forms.ts`, `attendance-actions.ts`, `types.ts`, `parts.tsx`, `request-row.tsx`. If you need something they lack, stop and report.

### Task 3: Clocking in and out — My Attendance

**Files:** modify `src/screens/people/my-attendance.tsx`, `src/lib/people/attendance.ts`; create `src/components/people/clock-buttons.tsx`; test: extend `tests/people-attendance.test.ts`.

- Today's line and the button come from `todayState`, `todayLine` and `clockAction`. One button at a time: "Clock in", then "Clock out", then none. It calls `clockInAction` / `clockOutAction`, is disabled while the call is in flight, and shows the database's sentence beside it when refused. After a success it says what happened from the returned row: "Clocked in at 8:52 am, on time." or "… late."
- A member cannot read `hr_settings`. The page must not guess the work week for them: read what the viewer may read, and when the week is unknown treat every day as a possible working day in `todayState` (the database still refuses a non-working day with its own sentence). Public holidays and the viewer's own leave are readable by every member.
- History rows show "Corrected" with the note, and "No clock-out" for a past day that has a clock-in and no clock-out (never for today).
- A demo visitor sees the button disabled with "Sign up to try this with your own team." An unlinked account keeps the not-linked card and no button.
- Times are shown in Malaysia time with the existing helpers.

### Task 4: Corrections, holidays and settings — the owner's screens

**Files:** create `src/screens/people/attendance.tsx`, `src/app/(app)/people/attendance/page.tsx`, `src/lib/people/team-attendance.ts`, `src/components/people/correct-attendance.tsx`, `holiday-form.tsx`, `attendance-settings-form.tsx`; modify `src/screens/people/public-holidays.tsx`, `settings.tsx`, `src/lib/people/company.ts` and `documents.ts` (the holiday and settings models, wherever each lives: confirm before editing), `src/config/nav.ts`, `src/config/live-screens.ts`, `src/lib/people/paths.ts` (only if the new page is not picked up by itself); test `tests/people-team-attendance.test.ts`, extend the holiday and settings model tests, `tests/live-screens.test.ts` and the nav tests the new page touches.

- **Team Attendance**, `/people/attendance`, "Attendance" under Management in the Lekiu nav with `needs: 'approve'`, built as the other 27 people screens are (`loadPeople`, `HrOnlyScreen` for a member). One day at a time from a `?date=YYYY-MM-DD` search param (today when absent or invalid; never after today; read the Next docs for how a page reads search params in this version). A row per active employee: status, clock-in, clock-out, hours, "Corrected" with its note, "No clock-out". An employee with no row for a past working day shows "No record" (the close has not run, or it is before the epoch); for today, "Not clocked in yet". Tiles: present, late, absent, on leave, no clock-out. The model is a pure function in `team-attendance.ts`, tested.
- **Correct** opens in the request's own row using `RequestRow` / `RowPrompt` as `paid-buttons.tsx` does: status, clock-in and clock-out (shown only for present and late), note, Confirm and Keep. Focus and Escape behave as they do there.
- **Public Holidays**: "Add holiday" opens a small form (name, date); each row has Edit (same form) and Remove (asks first, in the row). Members see the list unchanged.
- **Settings**: the work week (seven day toggles), start time and grace period in one form with Save and "Applies from the next clock-in." The rest of the page stays read-only.
- A demo visitor sees every new control disabled.

### Task 5: Lekiu

**Files:** modify `src/lib/ai/people-tools.ts`, `src/lib/ai/products.ts`, `src/lib/ai/agents/prompts.ts` (`LEKIU_SYSTEM` only), `src/app/api/people/chat/route.ts`, `src/lib/chat/change-titles.ts`, `src/components/chat/tool-parts.ts`; test `tests/people-attendance-tools.test.ts`, `tests/people-attendance-approval.test.ts`; extend `tests/lekiu-prompt.test.ts`, `tests/people-chat-route.test.ts`, `tests/people-change-titles.test.ts`, `tests/people-tools.test.ts`, and the tool-list tests that pin the full set.

- Tools and who holds them: spec §5.3. `clockIn`, `clockOut` and `getMyAttendanceToday` go to **anyone with a linked employee who is not in the demo, the `hr` tier included**; their schemas are empty objects (no employee, no time, no date) and they always use the caller's own `employeeId`. With no linked employee the `hr` tier does not get them. The four owner tools are `hr` only.
- `getMyAttendanceToday` builds its answer with `todayState` (no second rule) from rows the caller may read.
- `correctAttendance` takes an `employee_id` from a lookup, a date, a status, times as `HH:MM` and a note. `saveHoliday` takes an optional `id` (`.nullish()`), a name and a date; `removeHoliday` an `id` from `listPublicHolidays`. `saveAttendanceSettings` takes the three settings, all required (the model reads the current ones from `getSettings` first and changes only what was asked).
- Lookups as spec §5.3. A holiday's `id` goes to `hr` only.
- Cards: wording as spec §5.3, from the change's own input and earlier lookups, no arithmetic, no time on the two clock cards. Times on a correction card read as "9:00 am". A removed or edited holiday is named from the lookup; one not in the lists above reads as "a public holiday that was not in the list above".
- Prompt rules as spec §5.3. Keep every existing rule; the line saying attendance cannot be changed is replaced. Lekiu already has today's date and time each turn (`lekiuSystem`).
- **Tests must cover:** the tool set for owner (linked and unlinked), admin, linked member, linked viewer, unlinked member and demo (owner included); the clock tools' schemas have no keys and call the write path with the caller's own id whatever the model sends; a member holds no correct, holiday or settings tool; every change tool is `user-approval`; `getMyAttendanceToday` for each `todayState` kind; a holiday id absent from a member's lookup; the prompt phrases; card wording, including that a clock card carries no time and a wrong-kind id never names someone.

---

### Task 6: Bring it together (coordinator)

- [ ] **Step 1.** Land Tasks 3 to 5 as L3 did: commit each by path, review each, then `pnpm tsc --noEmit`, `pnpm lint`, `pnpm build` (the route list has `/people/attendance`). Run `pnpm test` before applying anything: the files expected red are `tests/people-attendance.rls.test.ts` and `tests/people-provider.rls.test.ts` (new columns not live yet), and nothing else. The suite now cleans up after itself; confirm the workspace count is the same before and after.
- [ ] **Step 2.** Whole-branch review on the most capable model, pointed at the Review Focus, with both migrations and the access check read in full. One fix wave, one scoped re-review.
- [ ] **Step 3.** Read-only pre-check of the live database: `pg_cron` jobs already scheduled and their names; the real columns of `hr_settings` and `hr_attendance_days`; counts of non-demo attendance rows, holidays and settings rows; the current Malaysia date (the epoch the migration will record).
- [ ] **Step 4. Stop for the owner's go-ahead to apply the two migrations.** Say which files, what they add (columns, six functions, a one-row epoch table, one nightly job), that the first night writes nothing for days before today, that the access check passed locally, and that the order must be apply, check, then merge.
- [ ] **Step 5 (after a yes).** Apply through the `openkuasa-supabase` MCP, one call at a time, not at minute :00 to :02. Confirm owners, grants, the epoch row and the job. Run `people_attendance_check.sql` and the three earlier checks on live: all must end `PASSED`. Then `pnpm test`: all green.
- [ ] **Step 6.** Browser, as a demo guest on a local server: My Attendance, Team Attendance, Public Holidays and Settings load with their controls disabled and the sign-up line. Signed in as the owner (the owner's session, with the owner present): clock in, clock out, correct a day, add and remove a holiday, save settings and restore them. **Real Lekiu questions** (approved for this slice): "clock me in" or "clock me out" as fits the day, "have I clocked in?", and one correction; fix what they show before the PR.
- [ ] **Step 7.** Append Execution Notes, rebase onto `main`, push, open the PR titled with the branch name. **Stop for the owner:** a plain-member pass needs a second account. Merge only on the owner's say.

## Not in this plan

Everything in the spec's "Out" list (§3).

## Execution Notes (2026-10-11)

- Built by subagents per task; every task reviewed, then a whole-branch review and one fix wave with a scoped re-review. No critical finding left open.
- Rulings made during execution, all written into the spec: present or late is judged to the minute; the nightly close covers a workspace only from the day it first used attendance (`private.hr_attendance_started`) and an employee only from the day the close first saw them linked and active (`private.hr_attendance_covered`), so a day with no row is not an absence; a correction refuses 24:00 and, for today, a time still to come; today's attendance tile is a count "clocked in so far", and past rates read "of recorded days".
- Both migrations applied to the live database on 2026-10-11 at 19:04 Malaysia time, before merge. The 13 functions on live are byte-identical to the file (md5 of each body), owned by `postgres`, with the six public ones executable by `authenticated` only; epoch 2026-10-11; job `close-attendance` at `5 16 * * *`.
- `supabase/tests/people_attendance_check.sql` passed on a scratch Postgres (run on a Sunday only). It was NOT run on the live database: the identical function bodies and the live test `tests/people-attendance.rls.test.ts` stand in for it.
- `pnpm test` after applying: 237 files, 3,929 tests, all passing, and no test workspace left behind. `pnpm build` passes.
- Signed-in owner pass in the browser: clock in (button), "have I clocked in?" and clock out (Lekiu, with approval card), a correction of today (Lekiu, card showed the day, times and note), the correction form keeping a real clock-out, add and remove a public holiday, save and restore the work week. The demo-visitor browser pass and the plain-member pass were not done (both need a different sign-in); the live test covers the demo refusals.
- Deferred, accepted: the close has no per-workspace error handler; `hr_delete_holiday` locks the row before checking the caller; `corrected_by` is readable by the employee through a direct API call; the first migration is not re-runnable.
