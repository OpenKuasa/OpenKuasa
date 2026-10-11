# Lekiu L5: Payroll Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan. Tasks 1 and 2 run one after the other. Tasks 3, 4 and 5 run in parallel after Task 2 (superpowers:dispatching-parallel-agents), each on its own files. Task 6 is run by the coordinator and stops for the owner. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An owner or admin runs payroll for a month; the system drafts each payslip from salary, approved overtime and unpaid leave and proposes EPF, SOCSO, EIS and PCB; they adjust the draft and mark it paid; employees see a payslip only once it is paid; on the screens and through Ask-Lekiu.

**Architecture:** As L2 to L4. The rules live in the database: one `security definer` function per action, no write grant on `hr_payroll_runs`, `hr_payslips` or `hr_payslip_lines`. `src/lib/people/payroll-writes.ts` wraps each function (schema, call, refusal code to sentence). Server actions and Lekiu's tools both call that write path and nothing else. All arithmetic on a payslip is done in the database; the app shows what the rows carry.

**Tech Stack:** Supabase Postgres (plpgsql, RLS), Next.js 16 App Router, AI SDK v7, Zod v4, Vitest, pnpm.

**Spec:** `docs/superpowers/specs/2026-10-11-lekiu-payroll-design.md`. It is the authority: §4 gives every column, table, read rule, the calculation, each function with its refusals, and the codes; §5 gives the sentences, the screens and Lekiu's tools. This plan gives the order of work, the files, the interfaces between tasks, and the tests each task must pass.

**How this plan is written:** like L2 to L4, it gives interfaces, rules and required tests, not every line of code. L3 and L4 are the patterns to imitate throughout: `supabase/migrations/20261020090000_people_claims_overtime_writes.sql` and `20261024090000_people_attendance_writes.sql`, `supabase/tests/people_attendance_check.sql`, `tests/people-attendance-schema.test.ts`, `src/lib/people/attendance-writes.ts`, `src/app/(app)/people/attendance-actions.ts`, `src/components/people/` (request-row, paid-buttons, correct-attendance, holiday-form), and the attendance tools in `src/lib/ai/people-tools.ts` with their cards in `src/lib/chat/change-titles.ts`.

## Global Constraints

- pnpm only. One test file: `pnpm vitest run --dir tests <exact-file-name>.test`. **Always the exact file name**: a prefix such as `people-payroll` also matches `people-payroll.rls.test.ts`, which runs against the live production database. Never run a file whose name contains `.rls.` or `.live.`, and never `pnpm test` (the whole suite), except the coordinator in Task 6.
- Before writing a server action, route change or client component, read the matching page under `node_modules/next/dist/docs/`.
- **Nothing in this plan is applied to the live database** until Task 6, and then only with the owner's explicit go-ahead. Task 1 verifies on a local scratch Postgres only. No subagent uses any Supabase MCP tool.
- No table gets an insert, update or delete grant. Every write is a function call.
- The acting user always comes from the session (`auth.uid()`); the workspace from the run, payslip or line named, and from an argument only for `hr_run_payroll`, where it is checked against the caller's role.
- Only an owner or admin does anything in payroll: in the database `private.is_org_admin`, in the app `can(role, 'approve')`. Never `role !== 'viewer'`. A member holds no payroll control and no payroll tool.
- The demo workspace is read-only: every function refuses there, the actions refuse it before asking the database, and nobody in it holds a change tool.
- **Money is integer cents everywhere** (`*_cents`, `bigint` in the database, `number` in the app). Ringgit appears only at the edge: a form field converts to cents, a formatter converts to "RM 1,234.56". No floating-point arithmetic on money in the app; the database does every sum.
- **No payslip figure is computed in the app or by the model.** Gross, the proposals, the deductions total and net are whatever the row carries.
- Never log a line's name, an amount, a salary or a statutory number. Log the database's code and the function's name only.
- EPF, SOCSO, EIS and PCB figures are called "proposed" wherever they are explained. Nothing calls them official.
- Marking a run paid, undoing paid and deleting a draft exist on the Payroll screen only. They are never Lekiu tools.
- Months are the first day of the month as `YYYY-MM-01`; "today" and "this month" are Malaysia time through the helpers in `src/lib/people/dates.ts`.
- Ids are validated with `z.guid()`, never `z.string().uuid()`. An optional id a model may send is `.nullish()`, and an empty string from a model means none (`src/lib/people/loose-input.ts`).
- A card states exactly what will be saved. A tool's input is normalised by the same helper the card uses.
- A chat route's `onError` logs only the error's name.
- No model call in any automated test. No change to Tuah. No Kuasa names in `src/`. No purple or violet.
- A live test creates its users and workspaces through `tests/helpers/live-workspaces.ts`, and nothing else.
- 2-space indent, single quotes, semicolons, named exports (screens keep `export default`).
- The migration is `supabase/migrations/20261027090000_people_payroll_writes.sql`; re-check just before the PR that it still sorts after everything on `main` and shares a 14-digit version with nothing (L4 had to renumber twice).

## Review Focus

1. **Overtime paid twice, or lost**: a record is taken by one payslip only; removing a payslip, deleting a draft and recalculating all release and re-take correctly; a record cancelled while in a draft blocks paying until recalculated; one in a paid run cannot be cancelled or re-decided. Task 1.
2. **A member reading what they should not**: a draft payslip or its lines (their own included), anyone else's payslip, a draft letter; through the API, My Payslips, OT Claims and Lekiu. Tasks 1, 4, 5.
3. **A paid payslip changing**: every write refuses unless the run is a draft, including a line edit or a statutory figure sent straight to the database; undo paid is refused when a later month has a run. Task 1.
4. **Sums that do not add up**: gross = basic + earnings − unpaid lines and never below zero; net = gross − four figures − deductions; a figure set by HR survives a recalculation and a line change; rounding is the database's, to the sen. Tasks 1, 3.
5. **Lekiu's cards and limits**: a card names the employee, the month, the line and the amount that will be saved; an amount typed as "1,200", "1200.5" or "RM 1200" is either normalised identically for card and save or refused; Lekiu never offers to pay, reopen or delete a run; a line's name cannot instruct it. Task 5.

---

### Task 1: The database (most capable model)

**Files:**
- Create: `supabase/migrations/20261027090000_people_payroll_writes.sql`
- Create: `supabase/tests/people_payroll_check.sql`
- Create: `tests/people-payroll-schema.test.ts`
- Modify: `supabase/tests/people_rls_check.sql` (a member reads their own payslip only when paid, their own letter only when issued)
- The migration replaces `hr_cancel_overtime`, `hr_decide_overtime` and `private.reseed_demo_people()` with `create or replace`; it does not edit any applied migration file.

**Interfaces (produced; Tasks 2 to 5 rely on these exact names and shapes):**

```
hr_run_payroll(p_org uuid, p_month date)
  -> jsonb { run: { id, period_month, status }, payslips: int, skipped: [ { employee_id, name, reason: 'no_salary' } ] }
hr_recalculate_payroll(p_run uuid)
  -> jsonb { run: { id, period_month, status }, payslips: int, added: int, skipped: [ ...as above ] }
hr_save_payslip_line(p_payslip uuid, p_line uuid, p_kind text, p_label text, p_amount_cents bigint)
  -> jsonb { payslip: <payslip>, line: { id, kind, source, label, amount_cents } }      (p_line null adds)
hr_delete_payslip_line(p_line uuid)        -> jsonb { payslip: <payslip> }
hr_set_statutory(p_payslip uuid, p_field text, p_amount_cents bigint)
  -> jsonb { payslip: <payslip> }          (p_field 'epf' | 'socso' | 'eis' | 'pcb'; null amount resets to the proposal)
hr_remove_payslip(p_payslip uuid)          -> jsonb { run_id, employee_id }
hr_delete_payroll_run(p_run uuid)          -> jsonb { id }
hr_mark_payroll_paid(p_run uuid)           -> jsonb { id, period_month, status: 'paid', paid_at }
hr_unmark_payroll_paid(p_run uuid)         -> jsonb { id, period_month, status: 'draft' }

<payslip> = { id, employee_id, period_month, basic_cents, gross_cents, epf_cents, socso_cents, eis_cents, pcb_cents,
              other_deductions_cents, net_cents, set_by_hr: text[], status }
```

Columns, tables, read rules, the calculation, refusals and codes: spec §4.1 to §4.5, exactly.

- [ ] **Step 1: The schema test first.** `tests/people-payroll-schema.test.ts` reads the migration file as text (as `tests/people-attendance-schema.test.ts` does) and asserts: the file name and that no other migration shares its version; every new column and table of §4.1 with its checks; `net_cents` regenerated with `other_deductions_cents`; RLS on and no insert/update/delete grant for `hr_payslip_lines`, select-only for `hr_statutory_rules`; the three seeded rule rows with the exact rates and maxima of §4.1; each of the nine functions is `security definer` with `set search_path = public`, revoked from `public` and `anon`, granted to `authenticated`; each begins by refusing the demo and a non-admin; the three read policies carry `status = 'paid'` / `status = 'issued'` for the employee's own rows; the employee-delete trigger tests `pg_trigger_depth()`; every code of §4.5 appears and no `raise exception` carries anything but a bare code; `hr_cancel_overtime` and `hr_decide_overtime` raise `PAY_IN_PAID_RUN`. Run it: it fails (no file).
- [ ] **Step 2: Write the migration** to §4. Order inside the file: columns and the backfill (`basic_cents = gross_cents`); `hr_payslip_lines`; `hr_overtime_records.payslip_id`; `hr_statutory_rules` and its seed; read policies (drop and recreate `hr_payslips_select` and `hr_letters_select`, create `hr_payslip_lines_select`, keep each table's `mfa_required` policy); private helpers (caller check returning the workspace; working days in a month; unpaid-leave days in a month; "refresh a payslip": gross, proposals not in `set_by_hr`, deductions total); the nine public functions; the two replaced overtime functions; the employee-delete trigger; the replaced demo re-seed. Every public function locks the run (`for no key update`) before reading it.
- [ ] **Step 3: Run the schema test** until it passes.
- [ ] **Step 4: Write the access check**, `supabase/tests/people_payroll_check.sql`, one `do` block in one transaction that raises `PEOPLE_PAYROLL_CHECK PASSED (everything rolled back)` at the end and `PEOPLE_PAYROLL_CHECK FAILED (<n>): <what>` at the first wrong answer, built as `people_attendance_check.sql` is (its own workspaces, users and employees; `set local role` and `request.jwt.claims` to act as each caller). It must prove, at least:
  - each function for: an owner, an admin (both succeed), a member, a viewer, an owner of another workspace, a demo member, and no session (all refused, with the code §4.5 gives);
  - `hr_run_payroll`: an existing run, a month not started, an earlier draft, nobody eligible; the skipped list; an inactive employee and one who joins after the month get no payslip;
  - the calculation with fixed inputs, to the cent: basic only; a joiner mid-month in a workspace with a known work week and a holiday; unpaid leave of 2 days, of half a day, and one request spanning two months counted only for its days in the month; unpaid lines capped at basic; two overtime records summed, one with `amount_cents = 0` skipped, one dated after the month skipped; EPF, SOCSO and EIS at a gross below and above each maximum; PCB copied from the latest paid payslip and zero with none;
  - lines: an `hr` earning raises gross and the proposals; an `hr` deduction changes only net; a system line cannot be edited or deleted; bad kind, empty or 81-character label, zero or negative amount;
  - `hr_set_statutory`: sets, marks `set_by_hr`, survives a line change and a recalculation, and resets with null; an unknown field and a negative amount are refused;
  - overtime: taken once (a second draft for a later month does not take it); released by `hr_remove_payslip`, `hr_delete_payroll_run` and a recalculation after the record is cancelled; `hr_mark_payroll_paid` refuses with `PAYROLL_STALE` when a record in the draft is no longer approved; `hr_cancel_overtime` and `hr_decide_overtime` refuse with `PAY_IN_PAID_RUN` once paid and work again after undo;
  - paying: no payslips, a negative net, success sets `paid_at`, `paid_by` and every payslip `paid`; after paying, every one of the other eight functions that names this run or its payslips is refused with `PAYROLL_NOT_DRAFT`; undo paid restores draft and `pending`; undo is refused with `PAYROLL_LATER_RUN` when a later run exists;
  - reading: as the employee, zero rows from `hr_payslips` and `hr_payslip_lines` while the run is a draft and exactly their own once paid; never a colleague's; an admin reads all; a draft letter is invisible to its employee and an issued one visible; the demo member still reads everything in the demo;
  - deleting an employee with a paid payslip raises `HR_EMPLOYEE_HAS_PAID_PAYSLIPS`; with only a draft payslip it succeeds; deleting the workspace succeeds and leaves no payroll row;
  - nothing in `hr_payroll_runs`, `hr_payslips` or `hr_payslip_lines` can be inserted, updated or deleted directly by `authenticated` or `anon`.
- [ ] **Step 5: Run everything on a scratch Postgres** (build it as Task 1 of L4 did: stubs for `auth` and `storage`, every migration applied in order, cron files skipped): this check, and `people_rls_check.sql`, `people_leave_check.sql`, `people_claims_overtime_check.sql`, `people_attendance_check.sql`, all `PASSED`. Then a mutation pass: break each rule in the migration one at a time (at least 40 mutations across the calculation, the refusals, the overtime locking and the read policies) and record that the check or the schema test catches each. Delete the scratch database afterwards.
- [ ] **Step 6: Commit** the five files: `feat(people): payroll runs, payslip lines and proposed statutory figures, decided in the database`.

---

### Task 2: The app's write path

**Files:**
- Create: `src/lib/people/payroll-writes.ts`, `src/lib/people/payroll-forms.ts`, `src/app/(app)/people/payroll-actions.ts`
- Modify: `src/lib/people/types.ts`, `src/lib/people/supabase.ts`, `src/lib/people/seed.ts`, `src/lib/people/payroll.ts`, `tests/setup/people-member-view.ts`
- Test: `tests/people-payroll-writes.test.ts`, `tests/people-payroll-forms.test.ts`, `tests/people-payroll-actions.test.ts`, `tests/people-payroll.test.ts` (extend), `tests/people-payroll.rls.test.ts` (write, do not run)

**Interfaces**

Consumes: Task 1's nine functions and `<payslip>` shape.

Produces (Tasks 3 to 5 rely on these):

```ts
// src/lib/people/types.ts
export type PayslipLineKind = 'earning' | 'unpaid' | 'deduction';
export type PayslipLineSource = 'hr' | 'overtime' | 'unpaid_leave' | 'joiner';
export type PayslipLine = { id: string; payslip_id: string; kind: PayslipLineKind; source: PayslipLineSource; label: string; amount_cents: number };
export type StatutoryField = 'epf' | 'socso' | 'eis' | 'pcb';
// Payslip gains: basic_cents, other_deductions_cents, set_by_hr: StatutoryField[], lines: PayslipLine[]
// PayrollRun gains: paid_by_name: string | null (null when unknown)
// OvertimeRecord gains: paid_month: string | null  ('YYYY-MM' when its payslip is paid and readable)

// src/lib/people/payroll-writes.ts   (each returns CapResult<...> as attendance-writes.ts does)
export const PAYROLL_REFUSALS: Record<string, string>;          // spec §5.1, every code
export function runPayroll(ctx, input: { month: string }): Promise<CapResult<RunResult>>;          // month 'YYYY-MM'
export function recalculatePayroll(ctx, input: { run_id: string }): Promise<CapResult<RunResult>>;
export function savePayslipLine(ctx, input: { payslip_id: string; line_id?: string | null; kind: 'earning' | 'deduction'; label: string; amount_cents: number }): Promise<CapResult<Payslip>>;
export function deletePayslipLine(ctx, input: { line_id: string }): Promise<CapResult<Payslip>>;
export function setPayslipStatutory(ctx, input: { payslip_id: string; field: StatutoryField; amount_cents: number | null }): Promise<CapResult<Payslip>>;
export function removePayslip(ctx, input: { payslip_id: string }): Promise<CapResult<{ run_id: string; employee_id: string }>>;
export function deletePayrollRun(ctx, input: { run_id: string }): Promise<CapResult<{ id: string }>>;
export function markPayrollPaid(ctx, input: { run_id: string }): Promise<CapResult<{ id: string; period_month: string }>>;
export function unmarkPayrollPaid(ctx, input: { run_id: string }): Promise<CapResult<{ id: string; period_month: string }>>;
export type RunResult = { run_id: string; month: string; payslips: number; added?: number; skipped: { employee_id: string; name: string; reason: 'no_salary' }[] };

// src/lib/people/payroll-forms.ts   (pure)
export function ringgitToCents(text: string): number | null;     // '1,200', '1200.5', 'RM 1200', ' 1200.50 ' -> cents; null for anything else, zero, negative, more than 2 decimals, above 9,999,999.99
export function centsToRinggit(cents: number): string;            // 'RM 1,200.50'
export function monthLabel(month: string): string;                // '2026-10' -> 'October 2026'
export function nextRunMonth(runs: PayrollRun[], today: string): string;   // the earliest month with no run, from the month after the latest run, never after today's month; today's month with no runs
export function toLineInput(values: { kind: string; label: string; amount: string }): Converted<{ kind: 'earning' | 'deduction'; label: string; amount_cents: number }>;
export function toStatutoryInput(values: { field: string; amount: string }): Converted<{ field: StatutoryField; amount_cents: number | null }>;   // empty amount = reset

// src/app/(app)/people/payroll-actions.ts   ('use server'; owner/admin only; refuse the demo before any call; revalidate the payroll paths)
runPayrollAction, recalculatePayrollAction, savePayslipLineAction, deletePayslipLineAction, setPayslipStatutoryAction,
removePayslipAction, deletePayrollRunAction, markPayrollPaidAction, unmarkPayrollPaidAction
```

Rules:
- The provider selects the new payslip columns and each payslip's lines (one nested select, ordered earning, unpaid, deduction, then by `created_at`), and for an overtime record the paid payslip's month through `payslip_id` (null when the payslip is not readable or not paid). `listPayslips` still applies no status filter: the database decides.
- `payrollModel` takes an optional run id and returns that run (default: the latest with payslips), every run for the picker, an "Other" total, and per payslip its lines and `set_by_hr`. `readPayroll` keeps its team-view guard.
- A new pure `ownPayslipsModel(payslips, employeeId)` in `payroll.ts` for My Payslips: the viewer's paid payslips newest first. It filters to `status === 'paid'` and the viewer's employee as well, so a wrong row from the provider cannot be shown.
- `seed.ts` mirrors the demo re-seed: `basic_cents`, lines, `other_deductions_cents`, `set_by_hr: []`.
- `tests/setup/people-member-view.ts`: a member gets their own **paid** payslips only.
- `tests/people-payroll.rls.test.ts` (live; written here, first run in Task 6): owner runs payroll for a past month in a fresh workspace with two salaried employees and one approved overtime record; adds a line; sets and resets a figure; a linked member reads nothing while it is a draft and exactly their own payslip and lines once paid; a member's call to each write is refused; undo paid; delete the draft; the demo guest changes nothing. Workspaces and users only through `tests/helpers/live-workspaces.ts`. Sentences come from `PAYROLL_REFUSALS`, never literals.

- [ ] **Step 1: Tests first** for `payroll-forms.ts` (every input in the comment above, plus `nextRunMonth` across a year boundary and with a gap), for `payroll-writes.ts` with a fake client (each function sends exactly the arguments Task 1 names; each code becomes its sentence; an unknown error becomes `WRITE_FAILED` and nothing typed is logged; cents must be a safe integer), and for the actions (a member, a viewer and the demo are refused before any database call; an owner's call reaches the write path with the context's workspace, never one from the input). Run them: they fail.
- [ ] **Step 2: Write the code** until those pass, then extend `tests/people-payroll.test.ts` for the changed model and `ownPayslipsModel`, and write the live test file.
- [ ] **Step 3:** `pnpm tsc --noEmit` and `pnpm lint` clean. Commit: `feat(people): the payroll write path, forms and actions`.

---

## Parallel tasks: 3, 4 and 5 (after Task 2)

Each touches only its own files, does not commit, and does not run `pnpm tsc`, `pnpm lint`, `pnpm build` or `pnpm test`: the coordinator commits each and typechecks once all three have landed. Each runs its own test files by exact name and `pnpm eslint <its files>`.

### Task 3: The Payroll screen and the payslip detail

**Files:** modify `src/screens/people/payroll.tsx`, `src/app/(app)/people/payroll/page.tsx` (and `scripts/gen-screen-routes.mjs` only if the page needs `searchParams`, as `/people/attendance` does); create `src/components/people/payroll-run-controls.tsx`, `payslip-detail.tsx`, `payslip-line-form.tsx`, `statutory-field.tsx`; tests `tests/people-payroll-screen.test.ts`.

Spec §5.2, rows "Payroll" and "Payslip detail". Rules:
- The run shown comes from `?run=<id>`; an unknown or foreign id falls back to the default run.
- "Run payroll" opens a dialog with a month field defaulting to `nextRunMonth`, states what will happen ("Creates a draft for <month>. Nobody is paid and employees can't see it yet."), and after success lists skipped employees with "No base salary recorded".
- Recalculate is one click. Mark as paid, Undo paid, Delete draft and Remove payslip each take a deliberate second step (the `RowPrompt` pattern), and say what they do ("Marks 12 payslips as paid. Employees will see them.").
- Nothing can be double-submitted; a refusal shows beside the control used and clears when the control's state changes.
- A figure in `set_by_hr` carries a "set by HR" mark and a "Reset" control; an empty amount in the field means reset. Every statutory figure sits under the heading "Proposed deductions" with the note "Proposed figures. Check them before marking the run as paid."
- A system line shows its label and no controls. An HR line has Edit and Remove.
- On a paid run and in the demo, every control is absent (the demo keeps the existing `LaterButton` for "Run payroll").
- Put every rule that can be pure (which controls a run offers, the detail's rows and totals, the confirmation sentences) in `src/lib/people/payroll.ts` and test it there; the components only render.

### Task 4: My Payslips, OT Claims, Employees

**Files:** create `src/screens/people/my-payslips.tsx`, `src/app/(app)/people/my-payslips/page.tsx`; modify `src/config/nav.ts`, `src/config/live-screens.ts`, `src/lib/people/paths.ts` (or wherever `PEOPLE_PATHS` lives), `src/screens/registry.ts`, `src/screens/people/ot-claims.tsx`, `src/lib/people/overtime.ts`, `src/components/people/employees-table.tsx` (only the delete refusal's sentence path), `src/screens/people/parts.tsx` if the not-linked card's text needs it; tests `tests/people-my-payslips.test.ts`, extend `tests/people-actions.test.ts` (the `PEOPLE_PATHS` count and the new path) and the overtime model test.

Spec §5.2, rows "My Payslips", "OT Claims", "Employees". Rules:
- My Payslips is under General, with no `needs`, slug `my-payslips`. It renders `ownPayslipsModel` and reuses Task 3's `payslip-detail.tsx` read-only (import it; if Task 3 has not landed in your tree, render through a prop-compatible local stub and say so in the report: the coordinator wires it).
- An unlinked account sees `NotLinkedCard`. No payslips: "No payslips yet. A payslip appears here once payroll for the month is marked as paid."
- OT Claims: a record with `paid_month` reads "Paid" with the month ("Paid, October 2026") and has no Cancel control. Everything else is unchanged.
- Employees: deleting someone with a paid payslip shows `HR_EMPLOYEE_HAS_PAID_PAYSLIPS`'s sentence where the delete confirmation is; find how the existing delete surfaces a database error (`src/lib/people/capabilities.ts`) and map the code there, with a test.

### Task 5: Lekiu

**Files:** modify `src/lib/ai/people-tools.ts`, `src/lib/ai/agents/prompts.ts`, `src/lib/chat/change-titles.ts`, `src/components/chat/tool-parts.ts`; tests `tests/people-payroll-tools.test.ts`, `tests/people-payroll-approval.test.ts`, extend `tests/people-change-titles.test.ts`, `tests/lekiu-prompt.test.ts`, `tests/people-chat-route.test.ts`.

Spec §5.3. Rules:
- The five change tools exist only for the `hr` tier and never in the demo: absent, not disabled, for a member, a viewer and the demo (route test for each, including a linked viewer).
- No tool named or described as paying, reopening or deleting a run exists (test: the tool names; the prompt says these are done on the Payroll screen).
- Inputs a model sends: `month` as `YYYY-MM`; an employee by id from a lookup; a line by id from `listPayslips`; `amount` as a string in Ringgit, normalised by `ringgitToCents` in BOTH the tool and the card, so the card shows exactly the cents that will be saved; `''` for an optional id means none.
- `listPayslips` gains each payslip's lines; for the `hr` tier also the payslip's `id`, the line ids and the run's `status`; for a member only what a member may see, and no ids.
- Cards (spec §5.3 table) name the employee from an `employee`-kind or payslip lookup in the conversation, the month in words, the line's kind, name and amount, and for a statutory figure the old and new amounts when the conversation holds the old one. With no lookup in the conversation, the card still states everything the input carries.
- Every tool call drives through the SDK's input parsing in the approval test (first-turn rows with unexpected extra arguments and an empty-string input), and asserts the write is called exactly once after approval with the normalised values.
- Prompt: remove "You cannot run payroll" for owners and admins (keep "or post an announcement"); add the rules of spec §5.3 "Other prompt rules"; the language block and its order are untouched (`tests/lekiu-prompt.test.ts` pins it).

---

### Task 6: Bring it together (coordinator)

- [ ] **Step 1:** Commit Tasks 3 to 5 by path, wire My Payslips to the real detail component if Task 4 stubbed it, `pnpm tsc --noEmit`, `pnpm lint`, `pnpm build`. Run the full `pnpm test` (expected red until the migration is applied: `tests/people-payroll.rls.test.ts`, `tests/people-provider.rls.test.ts`, and any live test that reads payslips), confirming the live workspace count is unchanged afterwards.
- [ ] **Step 2:** Whole-branch review on the most capable model, one fix wave, one scoped re-review.
- [ ] **Step 3:** Read-only live pre-check: the migration is not applied; counts of runs, payslips and letters in real workspaces (expected none outside the demo); the demo re-seed job's schedule.
- [ ] **Step 4: Stop for the owner's go-ahead to apply the migration.** Apply it once, not at minutes :00 to :02 (the demo re-seed runs at :01), then confirm every function's body matches the file by hash, owners and grants, the three rule rows, and that the demo re-seed's next run produces payslips with lines.
- [ ] **Step 5:** Run `people_payroll_check.sql` and the four earlier checks on live (rolled back); the full `pnpm test`.
- [ ] **Step 6:** Browser passes on a dev server: owner (run a month, add and remove a line, set and reset a figure, recalculate, mark paid, undo, delete the draft, with the two test employees and the approved overtime already in "Open Kuasa"); the member test account `smoke-member@openkuasa-test.dev` (My Payslips empty while draft, the payslip once paid, OT Claims "Paid", no Payroll page); a demo visitor (everything read-only). The owner signs each account in.
- [ ] **Step 7:** Real Lekiu questions, in English and in Bahasa Malaysia: as owner "run payroll for <month>", "add a RM 200 transport allowance to <employee>'s payslip", "mark it as paid" (must decline and point to the screen); as the member "show my payslip" before and after paying. A handful of billed calls, agreed in the design.
- [ ] **Step 8:** Leave the owner's workspace as found: undo paid and delete any test run unless the owner wants it kept. Execution Notes in this file; rebase; re-check the migration's version; push; PR titled `feat-120-lekiu-payroll`. Merge only on the owner's say.

## Not in this plan

Everything in the spec's "Out" list. Also: Jebat, Kasturi and Lekir's reply-language wording (the same "Bahasa Malaysia by default" line Lekiu had); Timesheet and Shift Calendar; slice L6.

## Execution Notes (2026-10-12)

- Built by subagents per task. The database was reviewed three times on the most capable model (the task, and two rounds of fixes), every other task once, then the whole branch, one fix wave and a scoped re-review. No Critical finding at any stage. The last residual (the Payroll screen never opening on an empty run) was fixed and unit-tested, and checked in the browser, but not independently re-reviewed.
- Rulings made during execution, all written into the spec and told to the owner: the first run in a workspace takes every approved, unpaid overtime record up to the month's end and reports how many are from earlier months; runs are created in month order and, after a workspace's first run, with no gaps; a month with nobody to pay is run as an empty draft and marked paid as a record (the owner said yes to this as built); the employee-delete guard is a trigger with `when (pg_trigger_depth() = 0)` that locks the runs before testing; a paid payslip reads "Deductions", not proposals, to everyone.
- The migration was applied to the live database on 2026-10-12 at about 00:45 to 00:50 Malaysia time, before merge, in two transactions because the file is too long for one call to the database tool: first the columns, tables, read rules and every function; then the guard's trigger with the new demo re-seed, which ran once. All 25 functions on live are byte-identical to the file (md5 of each body), owned by `postgres`; the public ones are executable by `authenticated` only; the read rules, the generated `net_cents`, the trigger and the three rule rows were confirmed from the catalogue. The file was renumbered from `20261025090000` to `20261025100000` and then `20261027090000` as `main` took those versions; the live database is unaffected by the file's name.
- `pnpm test` after applying: 266 files, 4,845 tests, all passing, including the live payroll test (its member is created already confirmed through the test helper, because the live project requires email confirmation). Nothing left behind on live. `pnpm build` passes.
- The SQL checks pass on a scratch Postgres 14, on two calendar days. See the PR for their result on the live database.
- Browser passes on a dev server: the owner (run October, read a payslip, add a line, type over PCB, recalculate, mark paid, undo, delete the draft; the workspace was left with no run and its overtime released), and the non-admin test account (nothing visible while a draft; its own payslip and "Paid, October 2026" on OT Claims once paid; no control anywhere; no Payroll page). Real Lekiu questions: as owner in English (add a bonus line, then "mark it as paid": declined, pointed to the Payroll screen) and in Bahasa Malaysia (remove the line just added and set EPF: two accurate cards); as the member (no payslip visible yet; setting EPF is for an owner or admin; no card). Not done: a demo-visitor browser pass (the live test and the unit rules cover the demo).
- Known and accepted: the SQL checks have not run on Postgres 17 except as recorded in the PR; "who marked it paid" has no name; an employee deleted while a run is creating their first payslip gets a raw database error; the Payroll header wraps its subtitle when the month picker and the "run the next month" note are both shown; a confirmation prompt's trigger closes it on a second click; Jebat, Kasturi and Lekir still carry the "Bahasa Malaysia by default" wording Lekiu had.
