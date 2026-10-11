# Lekiu L3: Claims and Overtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan. Tasks 1 and 2 run one after the other. Tasks 3, 4 and 5 run in parallel after Task 2 (superpowers:dispatching-parallel-agents), each on its own files. Task 6 is run by the coordinator and stops for the owner. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A linked employee submits and cancels their own expense claims (with a receipt file) and overtime; an owner or admin approves, rejects, cancels, enters either for anyone and marks a claim paid; on the screens and through Ask-Lekiu.

**Architecture:** As L2. The rules live in the database: one `security definer` function per action, no write grant on `hr_claims` or `hr_overtime_records`. `src/lib/people/pay-requests.ts` wraps each function (schema, call, refusal code to sentence). Server actions and Lekiu's tools both call that module. Receipts live in a private storage bucket whose read rule goes through the claim.

**Tech Stack:** Supabase Postgres (plpgsql, RLS, Storage), Next.js 16 App Router, AI SDK v7, Zod v4, Vitest, pnpm.

**Spec:** `docs/superpowers/specs/2026-10-11-lekiu-claims-overtime-design.md`. It is the authority: §4 gives every column, function, permission, refusal code, the overtime arithmetic and the storage rules; §5 gives the app's behaviour. This plan gives the order of work, the files, the interfaces between tasks, and the tests each task must pass. It does not repeat the spec's tables: read them.

**How this plan is written:** like L2's, it gives interfaces, rules and required tests, not every line of code. L2 is the pattern to imitate throughout: `supabase/migrations/20261018090000_people_leave_writes.sql`, `supabase/tests/people_leave_check.sql`, `src/lib/people/leave.ts`, `src/app/(app)/people/leave-actions.ts`, the leave components, and the leave tools in `src/lib/ai/people-tools.ts`. The database task goes to the most capable model and is reviewed by it.

## Global Constraints

- pnpm only. One test file: `pnpm vitest run --dir tests <name>`. Full suite `pnpm test` creates users in the live database: only where a task says so.
- Before writing a server action, route change or client component, read the matching page under `node_modules/next/dist/docs/`.
- **Nothing in this plan is applied to the live database** until Task 6, and then only with the owner's explicit go-ahead. Task 1 verifies on a local Postgres only.
- No table gets an insert, update or delete grant. Every write is a function call.
- The workspace and the acting user always come from the session (`auth.uid()`, the row's own `org_id`), never from an argument a caller can choose. A member's own `employee_id` comes from the viewer, never from a form field or the model. A receipt path never comes from the model.
- Only an owner or admin decides requests and marks claims paid: in the database `private.is_org_admin`, in the app `can(role, 'approve')`. Never `role !== 'viewer'`.
- A linked member of any workspace role, viewer included, may submit and cancel their own. "Own" depends on a linked employee record and not being in the demo, not on the role.
- The demo workspace is read-only: every function refuses there, the actions refuse it before asking the database, and nobody in it holds a change tool.
- Never log a description, a reason, a note, a name, an amount, a file name or a storage path. Log the database's code and message only.
- Money is whole sen (`amount_cents`) everywhere except what a person types and reads, which is Ringgit.
- Ids are validated with `z.guid()`, never `z.string().uuid()`.
- A chat route's `onError` logs only the error's name.
- No model call in any test. No change to Tuah. No Kuasa names in `src/`. No purple or violet.
- 2-space indent, single quotes, semicolons, named exports (screens keep `export default`).
- The migration is `supabase/migrations/20261020090000_people_claims_overtime_writes.sql`; re-check just before the PR that it still sorts after everything on `main`.

## Review Focus

1. **A receipt opened by the wrong person**: a colleague, a member of another workspace, a demo visitor, or anyone holding a guessed path. Refused by storage itself, not by the app. Task 1's access check; Task 2's `receiptUrl` reads the claim first as well.
2. **A member calling a function directly for someone else's claim, overtime or employee** (the API, not the UI): refused, every function, and told "not found" where the request is not theirs. Task 1.
3. **Salary leaking through overtime**: the preview, the stored hourly rate and the amount reach only those who may act for the employee; no lookup, card, log or error carries a rate to anyone else. Tasks 1, 3, 4, 5.
4. **Paid and cancelled racing, and paid claims disappearing from totals**: mark-paid, undo and cancel take the row `for update`; a paid claim cannot be cancelled; every figure that counts approved claims counts paid ones. Task 1 (schema test finds `for update`), Task 2 (the ripple), review.
5. **Overtime on the edges**: a public holiday that falls on a rest day (holiday wins), a workspace with no settings row or a malformed multiplier, no salary on file then a salary set before approval, half hours, 24 hours across several records on one date. Task 1.

---

### Task 1: The database (most capable model)

**Files:**
- Create: `supabase/migrations/20261020090000_people_claims_overtime_writes.sql`
- Create: `supabase/tests/people_claims_overtime_check.sql`
- Create: `tests/people-claims-overtime-schema.test.ts`
- Do not modify the demo seed: every new column is nullable or defaulted.

**Interfaces (produced; Tasks 2 to 5 rely on these exact names and shapes):**

```
hr_submit_claim(p_employee uuid, p_category text, p_amount_cents bigint, p_claim_date date, p_description text, p_receipt_path text)
  -> jsonb { id, employee_id, category, amount_cents, claim_date, has_receipt, status }
hr_cancel_claim(p_request uuid)                              -> jsonb { id, status, removed_receipt_path }   (null when there was none)
hr_decide_claim(p_request uuid, p_approve boolean, p_note text)   -> jsonb { id, status }
hr_mark_claim_paid(p_request uuid, p_paid_on date, p_reference text) -> jsonb { id, status, paid_on }
hr_unmark_claim_paid(p_request uuid)                         -> jsonb { id, status }
hr_overtime_preview(p_employee uuid, p_work_date date, p_hours numeric)
  -> jsonb { day_kind, multiplier, hourly_rate_cents, amount_cents }   (the last two null with no salary on file)
hr_submit_overtime(p_employee uuid, p_work_date date, p_hours numeric, p_reason text)
  -> jsonb { id, employee_id, work_date, hours, day_kind, rate_multiplier, hourly_rate_cents, amount_cents, status }
hr_cancel_overtime(p_request uuid)                           -> jsonb { id, status }
hr_decide_overtime(p_request uuid, p_approve boolean, p_note text) -> jsonb { id, status, amount_cents }
```

A refusal is `raise exception '<CODE>'` with one of the codes in spec §4.2 and nothing else. Columns added: exactly those in spec §4.1. Bucket `hr-receipts` and its policies: exactly spec §4.4.

**Rules the SQL must follow** (beyond the spec):

- Everything L2's migration does for its functions: `security definer`, `set search_path = public`, `revoke all … from public, anon`, `grant execute … to authenticated`; helpers in `private` with execute revoked from `public, anon, authenticated`; the workspace resolved from the employee row or the request row; refuse in the demo; the not-found rule (`is_admin or is_own_employee or (is_demo and is_org_member)`, else `PAY_NOT_FOUND`) copied from `hr_cancel_leave`.
- Reuse `private.is_own_employee`, `is_org_admin`, `is_demo_org`, `is_org_member`. Write one `private.hr_pay_may_act(p_employee)` like `hr_leave_may_act`, raising `PAY_NOT_ALLOWED`.
- One `private.hr_overtime_figures(org, employee, work_date, hours)` used by the preview, submit and the approve-when-null path. No second copy of the arithmetic.
- Dropping and re-adding the `hr_claims` status check: find the constraint by its definition, not by a guessed name.
- `hr_submit_claim` checks `p_receipt_path` when it is not null: `split_part(path, '/', 1) = auth.uid()::text` and a row exists in `storage.objects` with `bucket_id = 'hr-receipts'` and that `name`. Otherwise `PAY_BAD_RECEIPT`.
- Storage select policy: own folder, or `exists (select 1 from public.hr_claims c where c.receipt_path = storage.objects.name and (private.is_org_admin(c.org_id) or private.is_own_employee(c.employee_id)))`. No update or delete policy. A restrictive second-factor policy for the bucket, written as the avatars one is in `20261010120000_enforce_second_factor.sql`. The insert policy refuses an anonymous account (`coalesce((auth.jwt()->>'is_anonymous')::boolean, false)` is false).
- `description`, `reason`, `decision_note` and `paid_reference` are trimmed; empty becomes null; over-length is `PAY_BAD_INPUT`.

- [ ] **Step 1: Write the access check first**, `supabase/tests/people_claims_overtime_check.sql`, built like `supabase/tests/people_leave_check.sql` (staged lists of who, what, the call, the refusal expected; ends `PEOPLE_CLAIMS_OVERTIME_CHECK PASSED (everything rolled back)` or `FAILED (n): …`). It must assert everything in spec §4.5, each both ways, including: the catalogue checks (functions exist, grants, definer, helpers not callable, no table write grant); a linked viewer submitting and cancelling their own; every refusal code reachable; the not-found answer for a request that is not the caller's; second-factor sessions refused; the demo refused for a visitor and for a planted admin; the figures for a weekday, a rest day, a public holiday, a public holiday on a rest day, a custom `overtime_rates`, a malformed one, half hours, no salary (rate null, amount 0) and approval after a salary is set; the 24-hour cap across pending and approved records, and that a cancelled or rejected record does not count; paid: only approved can be marked, a paid claim cannot be cancelled, undo returns it to approved with the three columns cleared, `paid_on` bounds; a cancelled claim loses `receipt_path` and `has_receipt` and returns the path; direct insert, update and delete on both tables refused for a member and the admin; storage: insert into own folder allowed and into another's refused, an anonymous account refused, select as the uploader, as the claim's employee, as the admin, as a colleague (none), as an outsider (none), as a demo visitor (none); `PAY_BAD_RECEIPT` for a path in someone else's folder and for a path with no object; the demo reseed still gives its usual row counts; a workspace with claims and overtime can still be deleted.
- [ ] **Step 2: Run it on a local Postgres and watch it fail.** Never the live project. As L2's Task 1: a scratch cluster under the session's scratch directory (`initdb`, `pg_ctl`, `psql` in `/opt/homebrew/bin`), `authenticated` and `anon` roles, a stubbed `auth` schema, the repo's migrations applied in order as far as needed, every `*_cron.sql` skipped. New here: stub the `storage` schema with `storage.buckets` and `storage.objects` (at least `id`, `bucket_id`, `name`, `owner`, `created_at`, row level security on, select and insert granted to `authenticated`) and `storage.foldername(text)`, and say exactly what was stubbed. The real storage schema is checked in Task 6 before applying.
- [ ] **Step 3: Write the migration** until the check passes. Run `people_rls_check.sql` and `people_leave_check.sql` on the same database: both must still pass. Note: `people_rls_check.sql` asserts no unexpected policies and no write grants per table; it must not need changing.
- [ ] **Step 4: Mutation pass.** Break the migration one rule at a time (drop a role check, a demo check, the receipt folder check, the paid guard on cancel, the 24-hour cap, a `for update`, the holiday-before-rest-day order, a storage policy term) and confirm the check fails each time. Report the count. Restore the file.
- [ ] **Step 5: `tests/people-claims-overtime-schema.test.ts`**, reading the migration text as `tests/people-leave-schema.test.ts` does: the columns; the nine function names; each `security definer` with the fixed search path and revoked from `public` and `anon`; no `grant insert|update|delete` on the two tables; `for update` in each cancel, decide and paid function; the bucket is private with the size and type limits; no update or delete policy on it.
- [ ] **Step 6: Report** (the check's final line, what was stubbed, the mutation count, nothing left behind) and commit: `feat(people): claims and overtime rules in the database — functions per action, receipts readable through the claim`.

---

### Task 2: The app's write path

**Files:**
- Create: `src/lib/people/pay-requests.ts`, `src/lib/people/receipts.ts`, `src/lib/people/claim-forms.ts`, `src/lib/people/overtime-forms.ts`, `src/app/(app)/people/pay-actions.ts`, `src/components/people/claim-form.tsx`, `overtime-form.tsx`, `receipt-link.tsx`
- Create, but do not run: `tests/people-pay.rls.test.ts` (needs the migration live; style of `tests/people-leave.rls.test.ts`; spec §7's last row; it removes the employee, requests and file it made)
- Modify: `src/lib/people/types.ts`, `supabase.ts`, `seed.ts` (new columns; `ClaimStatus = RequestStatus | 'paid'`), `src/screens/people/parts.tsx` (`StatusPill`, `requestTone`: "Paid" in the approved tone), and every place a claim counts as approved (`requests.ts`, `approvals.ts`, `overtime.ts`, `dashboard` and Overview models, `src/lib/ai/people-tools.ts` lookups: grep for `'approved'` near claims) so a paid claim counts too. Only that one-line widening in those files; Tasks 3 to 5 own the rest of them.
- Test: `tests/people-pay-requests.test.ts`, `tests/people-pay-actions.test.ts`, `tests/people-receipts.test.ts`, `tests/people-claim-form.test.ts`, `tests/people-overtime-form.test.ts`; extend `tests/people-provider.test.ts`, `tests/people-seed.test.ts` and the model tests the ripple touches; fix every fixture the type change breaks.

**Interfaces (produced; Tasks 3 to 5 rely on these):**

```ts
// src/lib/people/pay-requests.ts
export type OvertimePreview = { day_kind: 'weekday' | 'rest_day' | 'public_holiday'; multiplier: number; hourly_rate_cents: number | null; amount_cents: number | null };
export const submitClaimInput;      // { employee_id: guid, category, amount_cents: int > 0, claim_date, description?: string|null, receipt_path?: string|null }
export const submitOvertimeInput;   // { employee_id: guid, work_date, hours: number (halves, 0.5..24), reason?: string|null }
export const previewOvertimeInput;  // the same without reason
export const markClaimPaidInput;    // { id: guid, paid_on, reference?: string|null }
// requestIdInput and decideInput are re-exported from leave.ts, not redefined.
export function submitClaim(ctx, input): Promise<CapResult<{ id: string; status: string; has_receipt: boolean }>>;
export function cancelClaim(ctx, input): Promise<CapResult<{ id: string; status: string; removed_receipt_path: string | null }>>;
export function decideClaim(ctx, input): Promise<CapResult<{ id: string; status: string }>>;
export function markClaimPaid(ctx, input): Promise<CapResult<{ id: string; status: string; paid_on: string }>>;
export function unmarkClaimPaid(ctx, input): Promise<CapResult<{ id: string; status: string }>>;
export function previewOvertime(ctx, input): Promise<CapResult<OvertimePreview>>;
export function submitOvertime(ctx, input): Promise<CapResult<{ id: string; status: string; amount_cents: number; hourly_rate_cents: number | null }>>;
export function cancelOvertime(ctx, input): Promise<CapResult<{ id: string; status: string }>>;
export function decideOvertime(ctx, input): Promise<CapResult<{ id: string; status: string }>>;
export const PAY_REFUSALS: Record<string, string>;   // code -> sentence, spec §5.1
/** Approved-or-paid sen this employee has in that category in the claim's calendar year, excluding the claim itself. The one formula for the approvals queue and Lekiu. */
export function approvedThisYear(claim: { id: string; employee_id: string; category: string; claim_date: string }, claims: Claim[]): number;
export function ringgitToSen(text: string): number | null;   // '85', '85.5', '85.50' -> sen; anything else null

// src/lib/people/receipts.ts
export const RECEIPT_BUCKET = 'hr-receipts';
export const RECEIPT_MAX_BYTES = 5 * 1024 * 1024;
export const RECEIPT_TYPES: Record<string, string>;      // media type -> extension
export function receiptProblem(file: { type: string; size: number }): string | null;   // a sentence, or null when acceptable
export function receiptPath(userId: string, mediaType: string): string;                 // '<userId>/<uuid>.<ext>'
export async function uploadReceipt(client, userId, body: Blob | ArrayBuffer | Buffer, mediaType: string): Promise<CapResult<{ path: string }>>;   // works with the browser and the server client
export async function removeReceipt(path: string): Promise<void>;                        // service client; never throws; logs a fixed sentence on failure

// src/lib/people/claim-forms.ts, overtime-forms.ts (pure) and the two form components (client, controlled; know nothing about whose request it is)
export function toClaimInput(values): { ok: true; input } | { ok: false; error: string };
export function toOvertimeInput(values): { ok: true; input } | { ok: false; error: string };
export function overtimePreviewLines(preview: OvertimePreview): { kind: string; amount: string; note: string | null };
export function ClaimForm(props: { disabled; error; onUpload: (file: File) => Promise<CapResult<{ path: string }>>; onSubmit; onCancel });
export function OvertimeForm(props: { disabled; error; onPreview; onSubmit; onCancel });   // remount per employee with key, as LeaveForm

// src/components/people/receipt-link.tsx
export function ReceiptLink(props: { claimId: string; hasFile: boolean; ticked: boolean });   // "View receipt" (asks the action for a link, opens it), "Receipt on file" (ticked, no file), or "No receipt"

// src/app/(app)/people/pay-actions.ts  ('use server')
submitOwnClaimAction  submitOwnOvertimeAction  previewOwnOvertimeAction
cancelClaimAction     cancelOvertimeAction     claimReceiptUrlAction({ id })   // -> CapResult<{ url: string }>, 60 seconds
// owner or admin only:
submitClaimForAction  submitOvertimeForAction  previewOvertimeForAction
decideClaimAction     decideOvertimeAction     markClaimPaidAction    unmarkClaimPaidAction
```

- Actions follow `leave-actions.ts` rule for rule: own actions resolve the employee from the viewer; owner-only actions need `can(role, 'approve')`; the demo workspace is refused first; revalidate `PEOPLE_PATHS` only on success.
- `cancelClaimAction` calls `removeReceipt` with the returned path after a successful cancel; a failed removal changes nothing the caller sees.
- `claimReceiptUrlAction` reads the claim through the people provider (so the row rule applies), refuses "That request was not found." when it is not readable or has no file, then signs the path as the signed-in user.
- The browser uploads with the browser Supabase client before submitting; `ClaimForm` removes nothing itself (no delete right), and a refused submit leaves the file as an unused upload (spec §4.4; the spec's "the form removes its own upload" is not possible without a delete policy, so it is dropped: ruling recorded here).

**Tests must cover:** each function's `rpc` name and argument keys; every code in `PAY_REFUSALS` reaching the caller as its sentence; an unknown error giving the generic sentence with nothing typed in the logs; `ringgitToSen` (whole, one and two decimals, three decimals refused, negative, text, empty); `approvedThisYear` (approved and paid counted, pending/rejected/cancelled not, other categories, other years, other employees, the claim itself excluded); `receiptProblem` and `receiptPath`; the forms' pure logic; a member's own action ignoring a smuggled `employee_id`; a plain member refused on every owner-only action before any call; the demo refused on all; cancel removing the file and surviving a failed removal; the receipt link action refusing a claim the provider does not return; `paid` counted in each model the ripple touched.

- [ ] Tests first, then code, then `pnpm tsc --noEmit`, `pnpm lint`, the test files touched. Commit: `feat(people): the app's write path for claims and overtime`.

---

## Parallel tasks: 3, 4 and 5 (after Task 2)

Each owns the files it lists. As in L2: do not run `pnpm tsc`, `pnpm lint`, `pnpm test` or `pnpm build`, and do not commit; run your own test files by exact name and `pnpm eslint` on your files. Do not edit `pay-requests.ts`, `receipts.ts`, `pay-actions.ts`, `claim-forms.ts`, `overtime-forms.ts`, the two form components, `receipt-link.tsx`, `types.ts`, `parts.tsx`. If you need something they lack, stop and report.

### Task 3: Submitting and cancelling — Financial Claims and OT Claims

**Files:** modify `src/screens/people/claims.tsx`, `ot-claims.tsx`, `my-requests.tsx`, `src/lib/people/requests.ts`, `src/components/people/cancel-request-button.tsx`; create `src/components/people/new-claim-dialog.tsx`, `new-overtime-dialog.tsx`; test: extend `tests/people-requests.test.ts`.

- The header's `LaterButton` becomes a real button opening a dialog, as `apply-leave-dialog.tsx` does. Claims: `ClaimForm` with `uploadReceipt` (browser client) and `submitOwnClaimAction`. Overtime: `OvertimeForm` with `previewOwnOvertimeAction` and `submitOwnOvertimeAction`.
- `CancelRequestButton` gains the kinds `claim` and `overtime` (it already asks first). Cancel shows on a row only while it is `pending`: a pure rule in `requests.ts`, tested.
- The claims table shows `ReceiptLink`, the rejection note under the status (as leave does), and the date paid on a paid row. The overtime table shows the kind of day, the amount or "Not calculated", and the rejection note.
- A demo visitor keeps disabled controls with "Sign up to try this with your own team." An unlinked account keeps the not-linked card and no button.

### Task 4: Deciding — claims and overtime approvals

**Files:** modify `src/screens/people/approvals-screen.tsx`, `approve-claims.tsx`, `approve-overtime.tsx`, `src/lib/people/approvals.ts`, `src/lib/people/overtime.ts`, `src/components/people/decide-buttons.tsx`; create `src/components/people/paid-buttons.tsx`, `add-claim-for.tsx`, `add-overtime-for.tsx`; test: extend `tests/people-approvals.test.ts`, `tests/people-overtime.test.ts`.

- `DecideButtons` gains the kinds `claim` and `overtime`; the two queues stop passing the flag that kept their buttons disabled. The cancel prompt mentions a balance for leave only (already so).
- Claims rows: `ReceiptLink`; the employee's approved-or-paid total this year in the category (`approvedThisYear`; no second formula); "yours". An approved row has "Mark paid" (a date, today by default, and an optional reference, then confirm); a paid row shows the date and "Undo paid" (asks first). Cancel is absent on a paid row.
- A tile "Approved, not yet paid" (count and total). Existing tiles keep their meaning, with paid counted as approved.
- Overtime rows: hours, kind of day, multiplier, amount or "Not calculated" with "Set a salary to work this out".
- "Add claim for…" and "Add overtime for…": pick an active employee, then the Task 2 form remounted per employee (`key={employeeId}`), with the owner-only actions. An owner's upload goes into the owner's own folder.
- A demo visitor sees every new control disabled.

### Task 5: Lekiu

**Files:** modify `src/lib/ai/people-tools.ts`, `src/lib/ai/products.ts`, `src/lib/ai/agents/prompts.ts` (`LEKIU_SYSTEM` only), `src/app/api/people/chat/route.ts`, `src/lib/chat/change-titles.ts`, `src/components/chat/tool-parts.ts`; test `tests/people-pay-tools.test.ts`, `tests/people-pay-approval.test.ts`; extend `tests/lekiu-prompt.test.ts`, `tests/people-chat-route.test.ts`, `tests/people-change-titles.test.ts`, `tests/people-tools.test.ts`.

- Tools and who holds them: spec §5.3, on the existing `PeopleWrite` tiers. For `tier: 'self'` the submit and preview schemas have **no** employee field and the tool fills in `employeeId`.
- **The receipt.** `PeopleWrite` gains `receipt: { bytes, mediaType } | null`, set by the route from the newest user message in `chat.uiMessages` (the first file part that is an image or a PDF; `prepareChat` has already turned stored files back into data URLs). `submitClaim`'s schema has no file or path field. When it runs it checks `receiptProblem`, uploads with `uploadReceipt` as the signed-in user, and passes the path on; when there is no file, or it is refused or the upload fails, it submits without one and its result says which. (The spec says "copies from the chat's attachment area"; the bytes are already in the request, so nothing is copied between buckets. Same outcome.)
- Lookups: `listClaims` and `listOvertime` as spec §5.3. The hourly rate is returned only to `hr` and to the record's own employee.
- Cards: titles and details as spec §5.3, from the change's own input, no arithmetic; amounts shown from the input's sen as "RM 85.00". An overtime card has no amount. A member's card never names another employee. Notes and reasons are quoted as L2 does.
- Prompt rules as spec §5.3. Keep every existing rule; the line saying claims and overtime cannot be applied for is replaced.
- **Tests must cover:** the tool set for owner, admin, linked member, linked viewer, unlinked member and demo (owner included); a member's `submitClaim` and `submitOvertime` schemas have no employee key and call the write path with the member's own id whatever the model sends; `submitClaim`'s schema has no path or file key, and a path smuggled into the input is ignored; with a receipt in `PeopleWrite` the upload happens and its path is passed, with none it is not; every change tool is `user-approval`; a member holds no decide or paid tool; the rate is absent from a lookup row that is not the caller's own for `self`; the prompt phrases; card wording.

---

### Task 6: Bring it together (coordinator)

- [ ] **Step 1.** Land Tasks 3 to 5 as L2 did: commit each by path, review each, then `pnpm tsc --noEmit`, `pnpm lint`, `pnpm build`. Run `pnpm test` before applying anything: the files expected red are `tests/people-pay.rls.test.ts` and `tests/people-provider.rls.test.ts` (new columns not live yet), and nothing else.
- [ ] **Step 2.** Whole-branch review on the most capable model, pointed at the Review Focus, with the migration and the access check read in full. One fix wave, one scoped re-review.
- [ ] **Step 3.** Read-only pre-check of the live database: the real columns of `storage.objects` and `storage.buckets` and the existing policies on `storage.objects` (so the migration's storage statements and the check's inserts fit the real schema, as L2 had to fix for `auth.mfa_factors`); the `hr_claims` status constraint's real name; counts of non-demo claims and overtime rows.
- [ ] **Step 4. Stop for the owner's go-ahead to apply the migration.** Say which file, what it adds (columns, nine functions, one private bucket and its policies, one widened status check), that the access check passed locally with storage stubbed, and that the order must be apply, check, then merge.
- [ ] **Step 5 (after a yes).** Apply through the `openkuasa-supabase` MCP, not at minute :00 to :02. Confirm owners and grants. Run `people_claims_overtime_check.sql`, `people_leave_check.sql` and `people_rls_check.sql` with `execute_sql`: all three must end `PASSED`. Then `pnpm test`: all green.
- [ ] **Step 6.** Browser, as a demo guest on a local server: Financial Claims, OT Claims and both approval pages load with their controls disabled and the sign-up line. Append Execution Notes, rebase onto `main`, push, open the PR titled with the branch name.
- [ ] **Step 7. Stop for the owner:** signed in, submit a claim with a real receipt file, open the receipt, approve, mark paid, undo, cancel; submit and approve overtime with and without a salary on file; one real question to Lekiu with a receipt attached. Merge only on the owner's say.

## Not in this plan

Everything in the spec's "Out" list (§3).

## Execution Notes (2026-10-11)

The plan above is as written, except the migration's file name. The branch is the reference. What changed or was decided along the way:

- **Migration renumbered.** `main` gained a file with the same version, so this one is `20261020090000_people_claims_overtime_writes.sql`.
- **One file, one claim.** A unique index on `receipt_path`: attaching a file to a second claim is `PAY_BAD_RECEIPT`, so cancelling one claim can never remove another's receipt.
- **Overtime figures.** The multiplier is rounded to one decimal (the column holds one) and the floor of 1 is tested before rounding. A salary of 0 counts as no salary. The preview refuses a bad date or hours but not an inactive employee.
- **"Not calculated"** means the rate is null and the amount is 0, decided by one helper in `src/lib/people/overtime.ts`. Rows made before this slice, and every demo row, have an amount and no stored rate, and keep showing their amount.
- **Cancelling.** A member cancelling their own paid claim is told it has already been decided; an owner or admin is told to undo the paid mark first. `removeReceipt` lives in `receipts-server.ts` (service client, server only) and deletes only a path shaped `<uuid>/<uuid>.<known extension>`.
- **A refused claim leaves its upload behind.** Nobody but the service client can delete from the bucket, so the form cannot remove it.
- **Chat receipts.** The model has no say: `submitClaim` has no file, path or flag. The receipt is the first usable image or PDF on the user message immediately before the assistant message that proposes the claim, picked by one rule (`pickReceipt`, `userMessageBefore` in `receipts.ts`) that the server and the approval card both use. A file sent before a clarifying question is not picked up: Lekiu is told to ask for it to be attached again. A chat cancel removes the file as the screens do.
- **Salary in tool code.** `listOvertime` returns the amount and rate only to an owner or admin or for the caller's own record, without relying on row security.
- **Shared dialog shell.** `src/components/people/request-dialog.tsx` now serves the leave, claim and overtime dialogs.
- **The hourly rate is not shown on the employee's own OT Claims page** (kind of day, multiplier and amount are). The spec limits who may see it; it does not require showing it.
- **The live test submits claims without a receipt**, because the suite signs in anonymously and anonymous accounts cannot upload.
- **Rollout, done 2026-10-11.** `pnpm test` after applying: 3,248 passed, 1 skipped, none failed. Migration applied to the live database with the owner's go-ahead. The nine functions and both tables are owned by `postgres`; signed-in users hold no write grant on either table; the bucket is private. `people_claims_overtime_check.sql`, `people_leave_check.sql` and `people_rls_check.sql` each ended `PASSED` on the live database and left nothing behind (each was sent whole through the MCP by a helper that retyped the file, not by a mechanical copy). Demo guest on a local server: Financial Claims, OT Claims, both approval pages and the team Overtime page load with every control disabled and the sign-up line, no console errors.
- **Left for later:** the claim form submits without a receipt after a failed upload (the message stays visible); a HEIC file whose browser type is empty is refused; a refused chat claim leaves its upload behind; deleting an employee or workspace leaves its receipt files unreachable in storage; unused uploads are never cleared; the approvals row shows "RM 0.00 approved or paid in <year>" when there is nothing else that year; no component tests for the dialogs, `PaidButtons` or the kind-to-action maps; the Tuah card site does not pass the receipt state (unreachable today); duplicate constants and one cast noted in review.
- **Owner's call, open:** let a chat claim pick up the nearest earlier photo in the conversation instead of asking for it again.
- **Not done, needs the owner:** signed in, a claim with a real receipt file (open it, approve, mark paid, undo, cancel), overtime with and without a salary on file, and one real question to Lekiu with a receipt attached; the same as a plain member, which needs a second account.

## Execution Notes, follow-up (2026-10-11)

After the signed-in pass, on the same branch:

- **Signed-in pass, done as the owner.** A claim with a real receipt file was submitted, its receipt opened through the signed link, approved, marked paid with a reference, the mark undone, and cancelled (the file was removed from storage). Overtime on a rest day with no salary on file read "Not calculated"; after a salary was set, approval worked it out exactly.
- **A second migration, `20261020100000_people_receipt_release.sql`, applied to the live database with the owner's go-ahead.** `hr_release_receipt(p_path)` decides whether an uploaded file may be deleted: the caller's own folder, the exact receipt shape, the file exists, and no claim in any workspace carries it. A released path, and the path a cancelled claim hands back, can never be attached again (`private.hr_released_receipts`); `hr_submit_claim` and `hr_cancel_claim` were replaced with only those additions. The first version of the discard action answered "is it attached?" from the caller's own claims list and could have deleted a saved claim's receipt; it was caught in review before it was pushed.
- **Unused uploads are discarded** when a file is replaced or removed, the form is closed, the employee is changed, or a submit is definitely refused. A submit whose outcome is unknown keeps its file. A browser closed mid-form, or a hard navigation away, still leaves a file.
- **Cancelling a claim and submitting again needs a fresh upload.**
- **A failed upload blocks submit** until the file is removed or chosen again. The file control shows "Choose file" / "Replace file" / "Remove" with the file's name.
- **File type from the name** when the browser reports none (`.heic`, `.heif`, `.jpg`, `.jpeg`, `.png`, `.webp`, `.pdf`); HEIF is stored as HEIC.
- **Approvals rows.** Status and Action sit side by side; confirm prompts, the reject note and the Mark paid form open in a full-width row under the request, with focus moved in and returned. The year-to-date line is hidden when it is zero.
- **Still left for later:** the hourly rate is not shown on the employee's own page; one photo can back several claims in one chat turn; deleting an employee or workspace leaves its receipt files unreachable in storage; a hard navigation mid-form leaves an upload; no component tests for the dialogs, the prompt row or `PaidButtons`.
- **Not done:** a plain-member pass (needs a second account); a real question to Lekiu with a receipt attached; a browser re-check of the prompt row's focus handling after the last change.
