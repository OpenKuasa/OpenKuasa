# Lekiu L2: Leave and Time-Off Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan. Tasks 1 and 2 run one after the other. Tasks 3, 4 and 5 run in parallel after Task 2 (superpowers:dispatching-parallel-agents), each on its own files. Task 6 is run by the coordinator and stops for the owner. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A linked employee applies for and cancels their own leave and time-off; an owner or admin approves, rejects, cancels, enters leave for anyone and sets entitlements; on the screens and through Ask-Lekiu.

**Architecture:** The rules live in the database: one `security definer` function per action, no write grant on any leave table. `src/lib/people/leave.ts` wraps each function (schema, call, refusal code to sentence). Server actions and Lekiu's tools both call that module.

**Tech Stack:** Supabase Postgres (plpgsql, RLS, pg_cron), Next.js 16 App Router, AI SDK v7, Zod v4, Vitest, pnpm.

**Spec:** `docs/superpowers/specs/2026-10-11-lekiu-leave-design.md`. It is the authority: §4 gives every column, function, permission and refusal code; §5 gives the app's behaviour. This plan gives the order of work, the files, the interfaces between tasks, and the tests each task must pass. It does not repeat the spec's tables: read them.

**How this plan is written:** like plan C, it gives interfaces, rules and required tests, not every line of code. The database task goes to the most capable model and is reviewed by it.

## Global Constraints

- pnpm only. One test file: `pnpm vitest run --dir tests <name>`. Full suite `pnpm test` creates users in the live database: only where a task says so.
- Before writing a server action, route change or client component, read the matching page under `node_modules/next/dist/docs/`.
- **Nothing in this plan is applied to the live database.** Task 1 verifies on a local Postgres only. Applying is Task 6 and needs the owner's explicit go-ahead.
- No table gets an insert, update or delete grant. Every write is a function call.
- The workspace and the acting user always come from the session (`auth.uid()`, the row's own `org_id`), never from an argument a caller can choose. A member's own `employee_id` comes from the viewer, never from a form field or the model.
- Only an owner or admin decides requests and sets entitlements: in the database `private.is_org_admin`, in the app `can(role, 'approve')`. Never `role !== 'viewer'`.
- The demo workspace is read-only: every function refuses there.
- Never log a reason, a note or a name. Log the database's code and message only.
- Ids are validated with `z.guid()`, never `z.string().uuid()`.
- A chat route's `onError` logs only the error's name (B2).
- No model call in any test. No change to Tuah. No Kuasa names in `src/`. No purple or violet.
- 2-space indent, single quotes, semicolons, named exports (screens keep `export default`).
- Migration file names take a timestamp after the latest file on `main` at the time of writing; re-check just before the PR.

## Review Focus

1. **A member calling a function directly for someone else's request or employee** (the API, not the UI): refused, every function. Task 1's access check.
2. **Two decisions racing** (approve and cancel at the same moment, or two approvals): one wins, the other gets `LEAVE_NOT_PENDING`; `used_days` ends correct. Task 1 (row lock), with a check.
3. **Leave across New Year, over a public holiday, on a weekend only, a half day**: counted as §4.3 says, and charged to the right year. Task 1.
4. **An over-balance request**: allowed, and visible to the applicant before submitting and to the decider in the queue and on Lekiu's card. Tasks 3, 4, 5.
5. **A member's Lekiu**: holds apply and cancel only, with no employee field, and nothing a lookup returns (a reason, a name) can make it decide a request. Task 5.

---

### Task 1: The database (most capable model)

**Files:**
- Create: `supabase/migrations/<ts>_people_leave_writes.sql`, `supabase/migrations/<ts+1>_people_leave_cron.sql`
- Create: `supabase/tests/people_leave_check.sql`
- Create: `tests/people-leave-schema.test.ts`
- Modify: `supabase/migrations/20261014090700_people_demo_seed.sql` only if the reseed must set a new not-null column (it should not: every new column has a default or is nullable). Prefer no change.

**Interfaces (produced; Tasks 2 to 5 rely on these exact names and shapes):**

Functions in `public`, callable with `client.rpc(name, args)`; argument names are the keys:

```
hr_leave_preview(p_employee uuid, p_leave_type text, p_start date, p_end date, p_half_day boolean)
  -> jsonb { days: number, years: [{ year, days, entitled, used, pending, remaining_after }], over_by: number }
     (`years` is [] and `over_by` 0 for unpaid, maternity, paternity)
hr_apply_leave(p_employee uuid, p_leave_type text, p_start date, p_end date, p_half_day boolean, p_reason text)
  -> jsonb { id, employee_id, leave_type, start_date, end_date, days, half_day, status }
hr_apply_time_off(p_employee uuid, p_off_date date, p_start_time time, p_end_time time, p_reason text)
  -> jsonb { id, employee_id, off_date, start_time, end_time, status }
hr_cancel_leave(p_request uuid)      -> jsonb { id, status }
hr_cancel_time_off(p_request uuid)   -> jsonb { id, status }
hr_decide_leave(p_request uuid, p_approve boolean, p_note text)     -> jsonb { id, status }
hr_decide_time_off(p_request uuid, p_approve boolean, p_note text)  -> jsonb { id, status }
hr_set_leave_entitlement(p_employee uuid, p_leave_type text, p_year int, p_days numeric)
  -> jsonb { employee_id, leave_type, year, entitled_days, used_days }
```

A refusal is `raise exception '<CODE>'` with one of the codes in spec §4.2, so the client sees it as `error.message` beginning with the code.

Columns added: exactly those in spec §4.1.

**Rules the SQL must follow** (beyond the spec's tables):

- Every function: `security definer`, `set search_path = public`, `revoke all … from public, anon`, `grant execute … to authenticated`. Helper functions go in `private` with execute revoked from everyone but the definer where they are not meant to be called directly.
- Resolve the workspace from the employee row or the request row, then check the caller against **that** workspace. Never trust a workspace passed in.
- "May act for employee E": `private.is_org_admin(E.org_id)`, or E's `user_id = auth.uid()` and the caller is still a member of that workspace. `private.is_own_employee` already encodes the second (and the second-factor check); use it.
- Refuse first when `private.is_demo_org(org)`.
- Cancel and decide take the request row `for update` before reading its status, so two callers cannot both act on a pending request.
- "Today" for the already-started rule is `(now() at time zone 'Asia/Kuala_Lumpur')::date`.
- Overlap for leave: another request of the same employee with status pending or approved whose date range intersects. Overlap for time-off: same employee, same date, pending or approved, time ranges intersecting.
- `used_days` is recomputed with one `update … set used_days = (recount)` per (employee, type, year) touched, on approval and on cancelling an approved request. The recount uses the same day-counting helper, clipped to the year.
- The insert trigger on `hr_employees`, the backfill in the migration and the yearly job all skip the demo workspace. The trigger must not fail an employee insert if the workspace has no settings row (use the table defaults).
- The cron file is separate, named like the demo cron, and schedules `0 16 31 12 *` UTC (midnight on 1 January in Malaysia) to ensure the new year's rows for every non-demo workspace.
- `decision_note` and `reason` are trimmed and limited (note 500, reason 500); an over-length value is `LEAVE_BAD_INPUT`.

- [ ] **Step 1: Write the access check first.** `supabase/tests/people_leave_check.sql`, built like `supabase/tests/people_rls_check.sql` (one `do` block; create a workspace, an admin, two linked members, an unlinked member and an outsider; switch sessions with `set local role authenticated` and `request.jwt.claims`; collect failures in an array with `array_append`; always end with `raise exception 'PEOPLE_LEAVE_CHECK PASSED'` or `'… FAILED: <first failures>'` so it rolls back). It must assert, each both ways:
  - member A applies for own leave (allowed) and for member B (refused `LEAVE_NOT_ALLOWED`); the unlinked member and the outsider cannot apply for anyone; the admin applies for B.
  - a direct `insert`, `update` and `delete` on each of the three leave tables by a member and by the admin is refused (no grant).
  - A cancels own pending (allowed), own approved future leave (allowed), own approved leave that started (refused `LEAVE_ALREADY_STARTED`), B's request (refused); the admin cancels any.
  - only the admin decides; deciding a non-pending request is `LEAVE_NOT_PENDING`; a member deciding their own is refused.
  - only the admin sets an entitlement; unpaid is `LEAVE_BAD_INPUT`.
  - counting: Friday to Tuesday is 3; a range holding one public holiday loses a day; Saturday to Sunday is `LEAVE_NO_WORKING_DAY`; a half day is 0.5 and is refused on a two-day range; 30 December to 4 January is split between the two years in the preview.
  - overlap refused for leave and for time-off; a cancelled request does not block a new one.
  - balances: three rows appear for a newly inserted employee; `used_days` rises on approval and returns on cancelling the approved request; an entitlement change shows in the next preview; `over_by` is positive when the request exceeds what is left and the request is still accepted.
  - an inactive employee: `LEAVE_INACTIVE_EMPLOYEE`.
  - time-off: the same apply, cancel and decide rules.
- [ ] **Step 2: Run it on a local Postgres and watch it fail.** Use the dry-run method plan A used (see "dry-run" in `docs/superpowers/plans/2026-10-10-lekiu-a-database.md`): a scratch local database with the earlier migrations applied. Never the live project.
- [ ] **Step 3: Write the two migrations** until the check ends with `PEOPLE_LEAVE_CHECK PASSED`. Also run `supabase/tests/people_rls_check.sql` on the same local database: it must still pass.
- [ ] **Step 4: `tests/people-leave-schema.test.ts`**, reading the migration text as `tests/people-schema.test.ts` does: the columns of §4.1; the eight function names; each is `security definer` with `set search_path = public`; execute is revoked from `public` and `anon`; **no** `grant insert`, `grant update` or `grant delete` on the three leave tables; the cron file schedules exactly one job.
- [ ] **Step 5: Report** the local results (the check's final line, the row counts left behind: none), and commit.

```bash
git add supabase/migrations supabase/tests/people_leave_check.sql tests/people-leave-schema.test.ts
git commit -m "feat(people): leave and time-off rules in the database — functions per action, no table write grants"
```

---

### Task 2: The app's write path

**Files:**
- Create: `src/lib/people/leave.ts`, `src/app/(app)/people/leave-actions.ts`
- Modify: `src/lib/people/types.ts`, `supabase.ts`, `seed.ts` (the new columns on `LeaveRequest` and `TimeOffRequest`: `half_day`, `decision_note`; the two new defaults on `PeopleSettings`), `src/lib/people/own.ts` only if a label is needed
- Test: `tests/people-leave.test.ts`, `tests/people-leave-actions.test.ts`; extend `tests/people-provider.test.ts`, `tests/people-seed.test.ts`; fix every hand-built `PeopleData`/row fixture the type change breaks

**Interfaces (produced; Tasks 3 to 5 rely on these):**

```ts
// src/lib/people/leave.ts
export type LeavePreview = { days: number; years: { year: number; days: number; entitled: number; used: number; pending: number; remaining_after: number }[]; over_by: number };
export const applyLeaveInput;        // { employee_id: guid, leave_type, start_date, end_date, half_day?: boolean, reason?: string|null }
export const previewLeaveInput;      // the same without reason
export const applyTimeOffInput;      // { employee_id: guid, off_date, start_time 'HH:MM', end_time 'HH:MM', reason? }
export const requestIdInput;         // { id: guid }
export const decideInput;            // { id: guid, approve: boolean, note?: string|null }
export const setLeaveEntitlementInput; // { employee_id: guid, leave_type: 'annual'|'medical'|'emergency', year: int, days: number }
export function previewLeave(ctx, input): Promise<CapResult<LeavePreview>>;
export function applyLeave(ctx, input): Promise<CapResult<{ id: string; days: number; status: string }>>;
export function applyTimeOff(ctx, input): Promise<CapResult<{ id: string; status: string }>>;
export function cancelLeave(ctx, input): Promise<CapResult<{ id: string; status: string }>>;
export function cancelTimeOff(ctx, input): Promise<CapResult<{ id: string; status: string }>>;
export function decideLeave(ctx, input): Promise<CapResult<{ id: string; status: string }>>;
export function decideTimeOff(ctx, input): Promise<CapResult<{ id: string; status: string }>>;
export function setLeaveEntitlement(ctx, input): Promise<CapResult<{ employee_id: string; leave_type: string; year: number; entitled_days: number }>>;
export const LEAVE_REFUSALS: Record<string, string>;   // code -> sentence, spec §5.1

// src/app/(app)/people/leave-actions.ts  ('use server'; async functions only)
previewOwnLeaveAction(input)   applyOwnLeaveAction(input)   applyOwnTimeOffAction(input)
cancelLeaveAction(input)       cancelTimeOffAction(input)
// owner or admin only:
previewLeaveForAction(input)   applyLeaveForAction(input)   decideLeaveAction(input)   decideTimeOffAction(input)   setLeaveEntitlementAction(input)
loadLeaveEntitlementsAction({ employee_id })   // -> CapResult<{ leave_type, year, entitled_days, used_days }[]> for the current year; reads only
```

`ctx` is the existing `PeopleWriteContext` (`{ client, orgId }`). Functions return a refusal (never throw) for bad input, as `capabilities.ts` does; a refusal code the map does not know is logged (code and message) and answered with the generic sentence.

The "own" actions take no employee id: they resolve the viewer's linked employee on the server (`getPeopleViewer`) and refuse with "Your account isn't linked to an employee record yet." when there is none. They are open to any signed-in member who is not a demo visitor. The "for" and decide actions require `can(role, 'approve')`. Every successful change revalidates `PEOPLE_PATHS`.

**Tests must cover:** each function's `rpc` name and argument keys; every code in `LEAVE_REFUSALS` reaching the caller as its sentence; an unknown database error giving the generic sentence with nothing typed in the logs; times sent as `HH:MM`; a member's own action ignoring an `employee_id` smuggled into the input; a plain member refused on every owner-only action before any call; a demo visitor refused on all; revalidation only on success.

- [ ] Tests first, then code, then `pnpm tsc --noEmit`, `pnpm lint`, the test files touched. Commit: `feat(people): the app's write path for leave and time-off`.

---

## Parallel tasks: 3, 4 and 5 (after Task 2)

Each owns the files it lists. As in plan C: do not run `pnpm tsc`, `pnpm lint`, `pnpm test` or `pnpm build`, and do not commit; run your own test file and `pnpm eslint` on your files. Do not edit `src/lib/people/leave.ts`, `leave-actions.ts`, `types.ts`, `parts.tsx`.

### Task 3: Applying and cancelling — Leave and Time-Off screens

**Files:** modify `src/screens/people/leave.tsx`, `time-off.tsx`, `my-requests.tsx`, `src/lib/people/requests.ts`; create `src/components/people/leave-form.tsx`, `time-off-form.tsx`, `cancel-request-button.tsx`, `src/lib/people/leave-forms.ts`; test `tests/people-leave-forms.test.ts`, extend `tests/people-requests.test.ts`.

- The header's `LaterButton` becomes a real button opening a dialog form (follow `src/components/people/employees-table.tsx` for the dialog, transition and error pattern). Leave: type, start, end, a half-day tick shown only when start equals end, reason. Time-off: date, from, to, reason.
- The leave form calls `previewOwnLeaveAction` when type and dates are complete and shows "N working days", per year "N days left after this", and in a warning tone "N days more than your remaining leave" when `over_by > 0`. If the preview fails it says the count could not be worked out and still lets the person submit.
- Each row of "My requests" shows Cancel when the model says it may be cancelled (`pending`, or `approved` with a start date after today); the rule is a pure function in `requests.ts`, tested.
- A demo visitor keeps disabled controls (`LaterButton`) with the line "Sign up to try this with your own team." An unlinked account still gets the not-linked card and no button.
- Pure logic lives in `src/lib/people/leave-forms.ts` (what the forms send, when the half-day tick shows, the preview's sentences) and is what the tests exercise.

### Task 4: Deciding — approvals, entitlements, settings

**Files:** modify `src/screens/people/approvals-screen.tsx`, `approve-leave.tsx`, `approve-time-off.tsx`, `src/lib/people/approvals.ts`, `src/screens/people/settings.tsx`, `src/lib/people/documents.ts` (settings model only), `src/components/people/employee-form.tsx`, `src/components/people/employees-table.tsx`; create `src/components/people/decide-buttons.tsx`, `add-leave-for.tsx`, `entitlements-fields.tsx`; test: extend `tests/people-approvals.test.ts`, `tests/people-documents.test.ts`, `tests/people-employees.test.ts`.

- Approve and Reject on leave and time-off rows become real (client buttons calling the decide actions; Reject opens a small note field, optional). The claims and overtime queues keep their disabled buttons: the shared layout takes a flag for which queues can decide.
- Leave rows carry `over_by` for the request's year when it exceeds the balance (computed in `approvals.ts` from the balances and the requests, pure and tested) and "yours" when the request belongs to the viewer's own employee.
- "Add leave for…" on Leave Approvals: pick an active employee, then the same fields as the leave form, with `previewLeaveForAction`.
- Cancel on any leave or time-off row for an owner or admin.
- The Employees edit form shows this year's annual, medical and emergency entitlement (loaded with the private details when the form opens, through `loadLeaveEntitlementsAction`) and saves a changed one with `setLeaveEntitlementAction`.
- Settings shows the three default entitlements, read-only.
- A demo visitor sees every new control disabled.

### Task 5: Lekiu

**Files:** modify `src/lib/ai/people-tools.ts`, `src/lib/ai/products.ts`, `src/lib/ai/agents/prompts.ts` (`LEKIU_SYSTEM` only), `src/app/api/people/chat/route.ts`, `src/lib/chat/change-titles.ts`, `src/components/chat/tool-parts.ts`; test `tests/people-leave-tools.test.ts`, `tests/people-leave-approval.test.ts`, extend `tests/lekiu-prompt.test.ts`, `tests/people-chat-route.test.ts`, `tests/people-change-titles.test.ts`.

- `PeopleWrite` becomes `{ ctx, tier: 'hr' | 'self', employeeId: string | null }` (replacing `canWrite`); the route passes `tier: 'hr'` for an owner or admin, `tier: 'self'` with the linked employee id for a linked member who is not in the demo, and nothing otherwise. Existing employee and department tools stay `hr`-only.
- Tools as spec §5.3. For `tier: 'self'` the apply and preview tools' schemas have **no** employee field and the tool fills in `employeeId`; for `hr` they require an employee id from a lookup.
- `listLeaveRequests` and the time-off lookup return `id` for rows the caller may act on, and `over_balance` for `hr`.
- Approval cards as spec §5.3, with the detail line (days, balance after, over-balance figure) taken from the most recent `previewLeave` result in the conversation whose employee, type and dates match the change's input, the way the card already finds a name for an id in earlier results; never from the model's own arithmetic. With no matching preview the card shows the type and dates only. A member's card never names another employee.
- Prompt rules as spec §5.3. Keep every existing rule; the line that says leave cannot be applied for or approved is replaced.
- **Tests must cover:** the tool set for owner, admin, linked member, unlinked member, viewer and demo; a member's `applyLeave` schema has no employee key and calls the write path with the member's own id whatever the model sends; every change tool is `user-approval`; a member holds no decide or entitlement tool; the prompt phrases; card wording, including that an employee id of the wrong kind never names someone.

---

### Task 6: Bring it together (coordinator)

- [ ] **Step 1.** Land Tasks 3 to 5 as plan C did: commit each by path, review each, then `pnpm tsc --noEmit`, `pnpm lint`, `pnpm build` once all three are in.
- [ ] **Step 2.** Whole-branch review on the most capable model, pointed at the Review Focus, with the migration and the access check read in full.
- [ ] **Step 3. Stop for the owner's go-ahead to apply the migrations.** Say exactly which two files, that they add columns and functions only, and that the access check was run locally. Do not apply without a yes.
- [ ] **Step 4 (after a yes).** Apply the two files through the `openkuasa-supabase` MCP, one call at a time. Run `supabase/tests/people_leave_check.sql` and `people_rls_check.sql` with `execute_sql`: both must end with `PASSED`. Then `pnpm test` (the live tests, including a new `tests/people-leave.rls.test.ts`: an owner applies, approves and cancels through `src/lib/people/leave.ts`; a demo guest changes nothing).
- [ ] **Step 5.** Browser, as a demo guest: Leave, Time-Off and Leave Approvals load, with their controls disabled and the sign-up line.
- [ ] **Step 6. Stop for the owner:** signed in as a real owner and a real linked member, apply → approve → cancel; one real question to Lekiu.

## Not in this plan

Everything in the spec's "Out" list (§3).
