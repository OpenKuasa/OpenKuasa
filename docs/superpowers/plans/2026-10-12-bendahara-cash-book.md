# Bendahara Cash Receipts, Payment Vouchers and Expenses Implementation Plan (stage 5a)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stage 5a of the Bendahara CRUD spec: expenses exist in the database, money out can pay them, the approval rule the owner decided on is enforced by the database for expenses and for money out that settles no document, the functions the cash book's forms will call are written and proven, and the Cash Receipts, Payment Vouchers and Expenses screens stop being mock-ups: they read the workspace's own data, read-only, with a period selector, search, filters, "View all" and CSV export. Cash Receipts lists every movement of money in and Payment Vouchers every movement of money out, once each, including the payments that Payments In, Payments Out and Refunds already show per document.

**Architecture:** One additive migration creates `finance_expenses`, lets a `finance_allocations` row point at an expense, and adds three views: `finance_cash_receipts` and `finance_payment_vouchers`, each one row per `finance_transactions` row of its direction with a `kind` column that says what the row is, and `finance_expense_totals`. Two live guard functions are replaced (payments, allocations) and one live function (`finance_mark_payment_paid`); each handles every write the deployed code makes exactly as before. The approval rule is in the guards, which ask `private.is_org_admin`, so no caller gets round it; `finance_record_payment_out`, `finance_record_payment_in` and `finance_record_refund` are not touched and nothing they record waits for approval. Four new functions save and post a cash receipt, record a payment voucher and save an expense. A second, data-only migration seeds the demo workspace. TypeScript follows stage 4a for reads: list functions in `src/lib/finance/`, pure view builders with unit tests, each screen a server loader plus a client view. No write function, schema or server action is added: they arrive with the forms.

**Tech Stack:** Supabase Postgres (RLS, plpgsql), Next.js 16.3 App Router (server components), React 19, Tailwind v4, shadcn/Radix, Recharts, Zod 4, Vitest (node, no DOM), pnpm.

**Spec:** `docs/superpowers/specs/2026-10-10-bendahara-crud-design.md`, build-order item 5, "Cash Book: Cash Receipts, Payment Vouchers, Expenses with approval". This plan is the first part. Backend notes: `docs/bendahara-backend.md` (read all of it, Known limits included). The stage this one mirrors: `docs/superpowers/plans/2026-10-11-bendahara-sales-followons.md` (4a). What the database allows today: `supabase/migrations/20261013100000_bendahara_money.sql`, `supabase/migrations/20261014100000_bendahara_invoices.sql` and `supabase/migrations/20261022100000_bendahara_sales_followons.sql`.

## How stage 5 is split, and why

Stages 3 and 4 each went: (a) database, data layer, screens live and read-only, demo seed; then (b) forms and actions, and 4b was split again. Stage 5 is three screens and an approval rule that touches money every live screen records, so it is five parts. This plan is the first.

| Part | Takes | Migration |
|---|---|---|
| **5a (this plan)** | The whole database for the cash book: expenses, allocations to expenses, three views, the approval rule in the guards, the functions for receipts, vouchers and expenses. Reading it (`cash-book.ts`, `expenses.ts`, `cash-book-views.ts`). Cash Receipts, Payment Vouchers and Expenses live and read-only. Demo seed. Two fixes carried from earlier stages: `finance_mark_payment_paid` refuses money in, and `voidPaymentIn` reads Payments In first | Yes, with a seed |
| 5b | Cash Receipts: the receipt form and its actions | None expected |
| 5c | Expenses: the expense form, approve and reject, mark paid, categories | None expected |
| 5d | Payment Vouchers: the voucher form, approve and reject, mark paid, void, delete | None expected |
| 5e | Whether a payment to a supplier and a refund wait for approval too, and if so the change to two live functions and two live screens. **Needs the owner's decision first** (Decision 1) | Yes, if the answer is yes |

Why this cut:

- **The database goes in once.** Every migration here is dry-run on the hosted database and applied on the owner's word, which is the expensive step, and two guards that production runs under are replaced. Doing that once, with the approval rule in it, is safer than replacing the same two guards again in each of three forms parts. The functions the forms will call are in the migration and are proven by the check script and the database tests, as the write functions of 4a were before 4b called them.
- **Approval is not its own part, but its reach is.** What approval means for an expense and for a voucher that settles no document is in the spec and is built here. Whether it also reaches a payment to a supplier recorded on Payments Out and a refund recorded on Refunds is not: the spec's rule says "a transaction", the stages that shipped say money in "needs no approval" and record money out with none, and holding a member's "Pay now" on a live screen before any screen has an Approve button would leave production with rows nobody can act on. So this part enforces approval where nothing live can be held up by it, and 5e is the owner's question.
- **The write half of the data layer moves to the forms parts.** 4a wrote every Zod schema and write function before a form existed. Here they come with the form and the server action that call them, for two reasons: a refusal is worded by the button that meets it, and this part is already a migration, three screens and a seed. The cost is that nothing in TypeScript exercises the four new database functions until 5b to 5d; the check script and `tests/bendahara-cash-book.test.ts` do.
- **Three forms parts, not one.** Each of the three screens has its own form and its own states, and 4b needed two plans for three smaller forms. The controller may merge two of them if they turn out small.

## Later parts of stage 5

Exactly what each takes, so nothing is dropped. Every item is in the spec's Cash Book or Purchases section, or was handed to stage 5 by an earlier stage.

**5b, Cash Receipts forms.**
- `New receipt`: from whom (a contact or a typed name), account, method, date, reference, notes, and either one customer's open invoices with an amount against each, or an income category and an amount.
- Zod schema and data layer in `src/lib/finance/`: save a draft (`finance_save_cash_receipt`), post (`finance_post_cash_receipt`), save and post in one go, void a posted receipt, delete a draft; sentences for `FIN03`, `FIN04`, `FIN05`, `FIN06`, `FIN09`, `FIN11`, `FIN15`, `23514`.
- Row menu by `kind` and status: a draft is edited, posted or deleted; a posted receipt of kind `income` is voided here; one of kind `invoice` is voided here or on Payments In, by the same function.
- Each write reads `finance_cash_receipts` first and routes by `kind`, as the Payments Out and Refunds writes read their views.
- Payments In shows a draft receipt against invoices as Draft with nothing offered: confirm that reads well, and reword `RECEIPT_MESSAGES.locked` ("This payment has already been voided."), which a draft sent to `voidPaymentIn` by a direct call would get.
- The payment-in form's `receivableInvoices` already takes off what drafts hold; say on Invoices what is held, as Supplier Bills does for bills (`heldByBill`).
- Say on a draft's row when its invoice no longer owes what the draft holds (it was credited since): posting it leaves the customer in credit (Decision 9).
- Server actions and the paths they refresh; `tests/finance-schemas.test.ts`.

**5c, Expenses forms.**
- `New Expense`, edit while pending, edit a rejected one back to pending: date, category, vendor (a contact or a typed name), amount, SST, notes (`finance_save_expense`).
- Approve and reject, offered to owners and admins only (`can(role, 'approve')`); reject an approved one while nothing is paid; delete while pending or rejected.
- `Mark paid` from an account: `finance_record_voucher` with one allocation for what is left of the expense.
- Categories managed from Expenses, as the spec has it: add, rename, archive, for both kinds. `finance_categories` has had no screen since stage 1.
- Sentences for `FIN01`, `FIN02`, `FIN04`, `FIN05`, `FIN11`, `FIN14`, `FIN15`, `23503`, `23514`.
- "Attach receipt" is stage 7 (Receipts Inbox), not here.

**5d, Payment Vouchers forms.**
- `New voucher`: to whom, account, method, date, and either approved expenses or a category and an amount (`finance_record_voucher`). Whether the form also offers bills, and under which rule, follows the owner's answer to Decision 1.
- Approve and reject for owners and admins; mark paid, void, delete; the row menu by `kind` and status, with `bill` and `refund` rows still changed on their own screens.
- A voucher recorded by a member lands as Pending approval whatever was asked: the form says so before it is saved.
- Each write reads `finance_payment_vouchers` first and routes by `kind`.
- Sentences for `FIN04`, `FIN05`, `FIN06`, `FIN09`, `FIN11`, `FIN14`, `FIN15`, `22023`, `23514`.
- Who recorded and who approved a voucher, by name: the view has `created_by` and `approved_at`; names need the profiles.

**5e, approval for supplier payments and refunds (if the owner says yes).**
- `finance_record_payment_out` and `finance_record_refund` leave a member's payment `pending_approval`; the guard's rule becomes "all money out".
- Payments Out and Refunds learn Pending approval and Rejected: labels are there already, menus and forms are not.
- What happens to payments that are scheduled on the day it ships.

**Carried, and not stage 5's to close** (each is in Known limits and stays there): a retry after a lost response can record a second expense, receipt or voucher, until every write carries a client-made id, which needs one migration for all document tables; the rules for payment dates, where the owner's decision is pending and this plan decides nothing; a bill's lines have no stored order.

## Global Constraints

- New tables are prefixed `finance_`, carry `org_id`, use composite `(org_id, id)` foreign keys, `numeric(14,2)` ringgit, `created_at` and `updated_at`.
- Every table: select for `private.is_org_member(org_id)`, writes for `private.is_org_writer(org_id)`, the restrictive `mfa_required` policy, `revoke all … from anon, authenticated` then explicit grants to `authenticated`. Views are `security_invoker = true` with select granted to `authenticated` only. Nothing is granted to `service_role`: it has no default privileges in this project and nothing here is written by a worker.
- Database functions callable by the app are `security invoker` with `set search_path = ''` and every name schema-qualified; execute is revoked from `public` and `anon`.
- A document that has been posted cannot be edited or deleted; it can only be voided. A payment's number is given when it is posted. A payment is created as a draft, and a direct INSERT cannot create one that is scheduled, posted or approved. Guards never block deleting a workspace or a user.
- A payment's amount is the sum of its allocations when it has any, each rounded to the sen first. Once a payment is split it cannot change direction or go below its split (already enforced; nothing here weakens it).
- For every write the deployed code makes, a replaced guard runs the same checks in the same order and answers with the same code. `finance_record_payment_out`, `finance_record_payment_in`, `finance_record_refund`, `finance_save_invoice`, `finance_post_invoice`, `finance_save_bill`, `finance_post_bill` and the five existing views that live screens read are not touched.
- `org_id` always comes from the server-side context, never from client input.
- One Zod schema per write; messages are sentences a person can act on. This stage adds no write, so no schema.
- A table row is keyed by a database id (a receipt's or voucher's `transaction_id`, an expense's `id`), never by a number that can be null or repeat.
- "Is there anything to show" flags (`hasTrend`, `hasReceived`, `hasPaid`, `hasSpend`) are worked out from the rows, never from a rounded chart series. Every chart and table has an empty state. A row with no number shows a dash.
- `src/lib/finance/*.ts` must not import `@/lib/supabase/server`, `next/headers` or anything else server-only: client views import types and pure functions from them. `src/screens/finance/cash-book-sample.ts` is pure too.
- A `'use server'` file exports only async functions. This stage adds no server action.
- Nothing in this stage writes from the browser: the three new views take no `writer`, no actions, and render no button or menu that changes data. The period selector, search, filters, "View all" and Export are included because they change nothing.
- Money is shown with `rm()` and `rmShort()` from `format.ts`. Payment method labels come from `PAYMENT_METHOD_LABELS` in `money.ts`; do not define a second map.
- No purple, violet, indigo or fuchsia anywhere. No Kuasa names in `src/`. Icons from lucide-react only.
- `BentoCard`'s `icon` prop is typed `LucideIcon`, but it draws the icon through `AnimatedIcon`, which returns nothing for a name that is not in its map. Pass `BentoCard` only these: `FileText`, `Wallet`, `Plus`, `Banknote`, `TrendingUp`, `ChartColumn`, `PieChart`. The mock-ups pass `Receipt` and `TrendingDown`; do not carry them over. An icon drawn directly in a table cell (`Landmark`, `Banknote`) is not affected.
- Radix `SelectItem` throws at runtime for `value=""`. Every select here has a real default value (`'month'`, `'open'`, `'all'`).
- This is Next.js 16.3. No Next API is used here beyond what the live finance screens already use (an async server component as the screen's default export; `next/link` in a client component, as `src/components/finance/saved-note-card.tsx` does; `revalidatePath` in the existing actions file). No `useRouter`, no `redirect`, no `router.refresh()`. If you reach for anything else, read the matching guide in `node_modules/next/dist/docs/` first.
- pnpm only. 2-space indent, single quotes, semicolons, named exports. The only default exports are the three screen files under `src/screens/finance/`, which Next's generated route files import by default.
- Vitest runs in node with no DOM: components have no unit tests. Everything that can be a pure function is one, in `src/lib/finance/`, with tests; components only draw.
- Every task leaves `pnpm exec tsc --noEmit`, `pnpm lint` and the unit tests green. Lint has one warning before this branch (`tests/apply-proposal.test.ts`, `'_p' is defined but never used`) and must have no other after any task.
- **Unit tests are run with `pnpm exec vitest run --exclude 'tests/*.rls.test.ts' --exclude 'tests/bendahara-*.test.ts'`, or with the files named. Never bare `pnpm test`.** The Supabase variables are set in the implementers' shell, so `tests/bendahara-*.test.ts` and `tests/*.rls.test.ts` run against the hosted production database. No implementer step runs them. `tests/bendahara-cash-book.test.ts` is written in Task 1 and run only by the controller, after the migration is applied. It makes its users and workspaces through `tests/helpers/live-workspaces.ts`, which deletes what it made when the file finishes.
- **The hosted database is shared with production. Implementers never call a database tool, never apply or dry-run SQL, and never start a dev server or a browser.** The controller dry-runs each migration inside a rolled-back transaction on the hosted database and applies it only on the owner's explicit go-ahead.
- **Order is fixed:** Task 1's files are written and committed → the controller dry-runs and applies the schema migration and then the seed (Task 1, steps 10 to 14) → Tasks 2 to 6 → merge and deploy. The schema migration is additive, so production's current code keeps working once it is applied; the new code must not be deployed before it, because the three screens read views it creates. The seed changes nothing that a screen live before the deploy reads (Decision 20), so it goes in at the same gate as the schema, not after the deploy.
- Branch `feat-129-bendahara-cash-book`, where the controller fills in the number: the next free one after `git branch -a | grep -E "(feat|bug|exp)-"`. The controller cuts it from an up-to-date `main` and checks it out before Task 1; work on it, do not create another. PR title equals the branch name. The PR body has no close keyword unless `gh issue list` shows a tracking issue for this stage. Do not push or merge until the owner says so.

## Not in this stage

- **Forms, row menus and server actions** on Cash Receipts, Payment Vouchers and Expenses; approve and reject buttons; "mark paid" on an expense; managing categories: parts 5b, 5c and 5d. The database functions are here; nothing in the app calls them yet.
- **Approval of a payment to a supplier or of a refund**: part 5e, after the owner decides (Decision 1). `finance_record_payment_out` and `finance_record_refund` are not touched.
- **Editing or resubmitting a payment that is waiting or was rejected** (Decision 4).
- **A client-made id on every write**, so a retry after a lost response cannot record a second document. It needs a migration on every document table and is better done once for all of them; it stays in Known limits.
- **Rules for payment dates.** "Pay now" still accepts a future date and "schedule" a past one, for vouchers as for payments. The owner's decision on this is pending and this plan makes none.
- **A stored order for a bill's lines.**
- **Attach a receipt to an expense**, and the Receipts Inbox: stage 7. **Banking**, accounts, transfers between accounts and statement import: stage 6. The two views here already leave a transfer's two sides out (Decision 22).
- Printing, PDF, email. Submission to LHDN. AI tools for finance. A financial-year setting. The People product's own Payment Vouchers screen.

## Decisions this plan makes (flag to the owner at handoff)

Each is a place where the plan decides something the spec left open, goes beyond it, or differs from the stages before it. Most consequential first. **Decisions 1, 4, 5, 9 and 10 are the owner's to confirm before the forms parts are planned; 1 should be answered before 5d, and 9 is one check in one function now and a migration later.**

1. **Approval reaches expenses and money out that settles no document. It does not reach a payment to a supplier or a refund.** The owner decided "owners and admins approve expenses and payment vouchers", and the spec's rule reads "a transaction or expense created by an owner or admin is approved on saving; otherwise it waits as pending". Read to the letter, every payment out a member records would wait, including "Record payment" on Payments Out and a refund on Refunds, both live. This plan does not do that: those two functions are untouched and a member's payment or refund is posted or scheduled at once, as today. What is enforced: an expense is approved or rejected by an owner or admin; money out with no bill, invoice, credit note or approved expense behind it needs one of them before it is scheduled or paid. **What it costs:** a member can still pay a supplier bill or refund a customer with nobody approving, which is most of the money a small business pays out. It is the one thing in this plan the owner must rule on (part 5e).
2. **The rule is in the guards, and approving is a plain update.** The spec says "the check is in the database function, using the caller's role". Here the functions that run are the trigger functions on `finance_transactions` and `finance_expenses`: they ask `private.is_org_admin(org_id)` for the caller, refuse with `FIN14`, and write `approved_by` and `approved_at` themselves, so nobody approves in another's name and no path round a function exists. Approve, reject, void and delete are then single-row updates and deletes, as void and delete already are everywhere in Bendahara. Cost: there is no `finance_approve_…` function to call; a forms part that wants one writes a three-line wrapper.
3. **A session with no signed-in user is not asked for a role.** `private.finance_may_decide` answers yes when `auth.uid()` is null. That is a migration or the SQL editor, which runs as the table owner and could disable the triggers anyway, and it is how the demo seed approves its rows without pretending to be somebody. Neither API role can be in that state and still write: `authenticated` always carries a user, and a signed-in session that names none reaches no row (the check script proves it); `anon` and `service_role` have no rights on these tables. Cost: a rule with an exception in it; rows approved that way have an empty `approved_by`.
4. **A voucher that waits is approved to `scheduled`, never straight to paid; a rejected one is final; a waiting one cannot be edited or withdrawn.** Approve always lands on `scheduled`, so `finance_mark_payment_paid` stays the one way money out gets its number and date. A member's "pay now" voucher therefore takes two more steps: approve, then mark paid. A rejected payment can only be deleted: stage 4a had to re-check a rejected refund in full when it was paid out, because a rejected payment holds nothing while another takes its place; making rejected final closes that for every kind of money out with one rule. A payment waiting for approval is locked, split included, so what is approved is what was submitted; to change it, delete it and record it again, as a scheduled payment already works. Cost: no "resubmit", no "withdraw", and one more click to pay.
5. **Paying an approved expense needs no second approval.** The expense was approved by an owner or admin for its amount, and the database lets money out go against an approved expense only, for no more than is left of it. So "mark paid" on an expense, by a member, is posted at once. The spec lists "submit, approve or reject" among a voucher's actions without saying whether one that pays approved expenses goes through them. Cost: a member chooses the account and the moment money leaves for an approved expense.
6. **What the two Cash Book screens list.** As the spec's table has it: Cash Receipts is every transaction with direction `in`, Payment Vouchers every transaction with direction `out`. So a payment against invoices is on Payments In (one row per invoice) and on Cash Receipts (one row); a payment to a supplier is on Payments Out and on Payment Vouchers; a refund is on Refunds and on Payment Vouchers, as stage 4a said it would be. Nothing is counted twice, because no screen adds its figures to another's: the document screens are views of allocations joined to their document, the cash book views are views of the transactions, and the table "Every movement of money" below says for each kind where it shows and which code may change it. A `kind` column on each view (`invoice` or `income`; `bill`, `refund`, `expense` or `other`) is what the forms parts will route by. In this part the Kind cell of a supplier payment or a refund links to the screen that changes it. Cost: the same payment is visible in two places and changeable in one.
7. **One payment pays one kind of document.** The guard on allocations refuses a second allocation that names another kind than the payment's first: bills, or invoices and credit notes, or expenses (`FIN06`). Until now only the functions kept a payment to one kind. Without the rule a hand-made payment could be a supplier payment and a refund at once, show on both screens, be reachable through both screens' actions, and have no single `kind`. Cost: one more query on every allocation insert on the live path; a direct write that mixed kinds is refused where it was allowed.
8. **A payment starts as a draft.** A new trigger refuses a direct INSERT into `finance_transactions` with any status but `draft` (`FIN09`) and clears `approved_by` and `approved_at`. Every function and every seed already inserts a draft first. Without it, the approval rule could be skipped by inserting a row that is already scheduled. It also closes part of a known limit: a payment can no longer be created already posted. Cost: none for the app; a direct insert of a posted row is refused where it was allowed.
9. **A cash receipt can be a draft, and a draft holds what it is split across.** The spec gives Cash Receipts "edit draft, post". Money in recorded on Payments In stays posted at once (`finance_record_payment_in`, unchanged). A draft receipt against invoices counts against each invoice in the allocation guard, as every unposted payment has since stage 3, so two people cannot receive the same balance; it shows on Payments In as a Draft row with nothing offered. **A draft is not looked at again when it is posted.** Its split was checked when it was saved and has held its part since, so no other payment can have taken it. One thing can still shrink an invoice's balance under a draft: a credit note, whose cap is the invoice's total, not what is owed or held. Posting the draft then leaves the customer in credit by the overlap, which is the position that paying first and crediting afterwards already gives, and a refund pays it out; the check script pins it. The alternative was to refuse the post with `FIN05`, as a pending refund is looked at again when it is paid out; that would tell someone holding the customer's money that it cannot be recorded, and money in is not money out. Cost: a draft that is forgotten keeps its invoices from being paid in full until someone posts or deletes it; and a customer can end up in credit through a draft receipt and a credit note that each looked right when it was made. No draft can exist until 5b ships.
10. **The shape of an expense.** As the spec's data model: date, category, vendor (a contact or typed text, exactly one), `amount`, `sst_amount`, notes, `status` of `pending`, `approved` or `rejected`, `approved_by`, `approved_at`, `created_by`. Decided here: **`amount` has its SST inside it** and `sst_amount` is that part (never more than the amount), because an expense is typed from a receipt whose total is known, and the mock-up shows one Amount; a bill line has its SST on top. An expense has one category, no lines and no number (the spec numbers six document types and an expense is not one). Paid is derived: posted money out covers the amount. It can be paid in parts. An approved expense is locked; an owner or admin can reject it while no payment stands against it, which is its only way back; a rejected one is deleted, or edited, which makes it pending again. Cost: SST on an expense is entered as an amount, not a rate; an approved expense cannot be corrected without rejecting it first.
11. **`approved_by` and `approved_at` also record a rejection.** The spec has those two columns and no others. They say who decided and when, whichever way; the status says which. The check constraint on expenses uses `approved_at` only (`pending` has none, the other two have one), because `approved_by` is cleared when that user is deleted and a seed has nobody to name. Cost: the names read oddly on a rejected row.
12. **Three live functions are replaced:** `private.finance_transaction_guard`, `private.finance_allocation_guard` and `public.finance_mark_payment_paid`. For every write the deployed code makes, each runs the checks it ran, in the order it ran them, and answers with the code it gave. Some answers differ, each for a write only a direct call can make. **The complete list is the header comment of the migration file on the branch** ("What differs from the guards that were live"), nineteen items after the two rounds of fixes to Task 1's review; it is not repeated here, so there is one list to keep right. The five this plan first counted are among them: a direct INSERT of a payment that is not a draft is `FIN09` (was allowed); a rejected payment moved to another status is `FIN14` (was allowed, and for a refund is still refused first by `FIN04` or `FIN05` where it was); money out whose amount is more than its split cannot be scheduled or paid by someone who is not an owner or admin, `FIN14` (was allowed; `finance_record_payment_out` adds unrounded amounts, so a direct call with fractions of a sen could meet it); a second kind of document on one payment is `FIN06` (was allowed or `FIN04`); `finance_mark_payment_paid` on money in is `FIN09` (it would have given it a `PV-` number). The migration file on the branch is the authority: where the SQL printed in Task 1 below disagrees with that file, the file is right. One line of the refund re-check in the payment guard is changed, of necessity: it found "the invoices this payment refunds" by "allocations that are not a bill", which would now take in an expense. The controller's dry run proves no existing row reads differently; the two existing check scripts pass unchanged.
13. **The guards enforce what protects money and approval; the shape of a document is the functions' business.** That a receipt names invoices or an income category and never both, that a voucher names expenses or an expense category, and that a category is of the right kind, are checked by the four new functions (`FIN15`), not by the guards. A direct write can therefore give money out an income category. The alternative is three more rules in a guard every live payment passes through. Cost: listed under Known limits; the app cannot reach it.
14. **Who paid or was paid is a contact or a typed name, never both, and may be nobody.** `finance_transactions.party_name` has existed since stage 2 and nothing has written it. It gets a check constraint beside `contact_id` (`23514` for both). Neither is required: a cash sale has no named payer. Cost: a check constraint added to a live table, validated against every existing row when the migration is applied; no row can fail it unless something has written `party_name` by hand, and the dry run would say so.
15. **Two new error codes, and one reused where a new one was possible.** `FIN14` is approval; `FIN15` is a receipt, voucher or expense that names the wrong thing. Everything else reuses a code whose meaning it shares (see the table). `finance_mark_payment_paid` refuses money in with `FIN09`, the code it already gives a payment that cannot be marked paid. No file words `FIN14` or `FIN15` yet, because nothing in the app can meet them.
16. **No write function in TypeScript in this part** (see "How stage 5 is split"). `tests/finance-schemas.test.ts` is not touched.
17. **`voidPaymentIn` reads Payments In first.** Stage 4b left it kept to `direction = 'in'` "until money in gains a second kind". It now refuses anything `finance_payments_in` does not show, without writing, as the money-out functions of each screen do. Its sentence for a draft is left wrong on purpose and listed (Task 3): no button reaches it, and 5b rewords it with the form that creates drafts.
18. **Screen changes beyond "keep the layout".** Sparklines and hand-written deltas go, as on every live finance screen. The period selector on Cash Receipts and Payment Vouchers offers This month, This quarter and This year: the mock-up's "Financial YTD" needs a financial-year setting that does not exist, so it is the calendar year. The trend charts cover the last eight months, as every live finance chart does, where the mock-ups drew eight weeks. Cash Receipts: Received, Receipts, Average receipt, Into the bank (replacing "Bank share"); the table gains a For column. Payment Vouchers: Paid, Vouchers, Pending approval (everything waiting, whatever its date), Average voucher; "By category" puts supplier payments and refunds in a category each; the table gains a Kind column; a voucher that may be paid and has not been reads "To be paid". Expenses: Total (YTD), This month, Top category, Pending approval; the trend is "entered" against "approved"; the table gains a status filter; a paid expense reads "Paid" and shows how it was paid. A donut names its four largest slices and adds the rest up as one. The header buttons "New receipt", "New voucher" and "New Expense" are removed until their part gives them something to do.
19. **The existing actions refresh the new screens.** `SALES_PATHS` gains Cash Receipts, `PURCHASE_PATHS` and `CREDIT_PATHS` gain Payment Vouchers, `CONTACT_PATHS` gains all three. Each list is used by more actions than need the new path. Five test files pin these lists and each gets its line changed.
20. **The demo seed, and what it does to the demo.** 23 expenses (2 pending, 1 rejected, 1 approved and unpaid, 19 paid), 19 vouchers that pay them, 6 vouchers that settle no document (2 waiting, 1 to be paid, 2 paid, 1 rejected) and 7 receipts for income (1 a draft), built from the mock-ups, with the mock-ups' week of rows and earlier months for the charts. Nothing is put against an invoice or a bill, so Invoices, Payments In, Refunds, Supplier Bills, Payments Out and Customers & Suppliers read exactly as they did; the dry run proves it. The demo's existing payments to suppliers, refunds and payments in also show on the two cash book screens, because those list everything. Vendors and payees are typed names, except one payer who is a demo contact if it is there. Approved rows name nobody (Decision 3). Posted by plain UPDATE, as in 4a. Because no screen that is live before the deploy reads these rows, the seed goes in with the schema, before the deploy, not after it as 4a's had to.
21. **The database tests run as owners only.** `tests/helpers/live-workspaces.ts` makes anonymous users who each own a workspace; it has no way to add a member to one. What an editor and a viewer may not do is proved by `supabase/tests/bendahara_cash_book_check.sql`, which acts as an owner, an editor, a viewer and an outsider, on the hosted database in the dry run and again once applied. The database test file adds what only real concurrent sessions can show: two vouchers for one expense, and two posts of one receipt, at the same moment.
22. **A transfer between accounts is in neither view.** `transfer_id` arrives with Banking (stage 6); its two sides are not a receipt and a voucher. The views leave rows with a `transfer_id` out now, so stage 6 does not have to replace them.
23. **Migration file names.** `20261028100000` and `20261028100100`. The newest file on `main` is `20261026090000_hire_candidate_changes.sql`; a change in flight is adding one more, and `20261027…` is left free for it.
24. **Declined, on purpose:** a client-made id on writes; any rule about payment dates (the owner's decision is pending and is not made here); a stored order for bill lines; attach-receipt; managing categories; who approved, by name. Each is under "Not in this stage" or "Later parts".

## Review Focus

The cases most likely to hurt, each pinned by a test or by the controller's check.

1. **Two live guards and a live function are replaced, on a database production is using.** Every bill, payment out, invoice, payment in, credit note and refund must behave exactly as before. Expected: `supabase/tests/bendahara_followons_check.sql` and `supabase/tests/bendahara_invoices_check.sql` pass, unedited, after the migration; `tests/bendahara-purchases.test.ts`, `tests/bendahara-sales.test.ts` and `tests/bendahara-followons.test.ts` pass unchanged; the dry run finds six views and every row of `finance_transactions` the same, row for row. (Task 1, steps 10 and 13.)
2. **Money leaving without approval, by a way round.** Expected: an editor cannot approve or reject; cannot pay a voucher that is waiting, change it, put it back to draft or split it; cannot insert a payment that is already scheduled; cannot schedule or pay their own draft that settles no document, nor one that is a sen against a bill and RM 499.99 against nothing, nor a scheduled supplier payment raised above its bill; cannot raise an approved voucher or pay it for another amount; cannot bring a rejected one back. A session that names no user reaches no row. (Task 1, check script, "what an editor cannot do to a voucher that is waiting" to "a rejected voucher is final", and "nobody signed in".)
3. **A payment counted twice, or reachable through the wrong screen.** Expected: each view has exactly one row per movement of its direction and its posted total is the table's; a payment across two bills is two rows on Payments Out and one voucher; an expense voucher is on none of Payments Out, Refunds, Payments In; `voidPaymentIn` refuses a receipt for income without writing. (Task 1, check script, "every movement of money shows once"; Task 3.)
4. **Two people pay the same expense, or post the same receipt, at the same moment.** Expected: exactly one succeeds each time. (Task 1, `tests/bendahara-cash-book.test.ts`, the two "at the same moment" tests.)
5. **A member's payment to a supplier or refund held up by this migration.** Expected: recorded by an editor through the untouched functions, both are posted at once and name nobody as approver. (Task 1, check script, "an editor's payment to a supplier and refund are not held for approval".)
6. **A workspace, or a user, deleted while approved expenses and paid vouchers exist.** Expected: both deletes go through; `created_by` and `approved_by` are cleared whatever the status; no finance row of the workspace is left. (Task 1, check script, its last two sections.)
7. **The demo's live screens moved by the seed.** Expected: receivable, payments in, refunds, payments out and bills paid read the same before and after the seed, and the seed run twice changes nothing the second time. (Task 1, step 11.)
8. **A sample screen disagreeing with another sample screen.** Expected: each sample payment in is one sample receipt for the same amount; each sample refund is one sample voucher; each paid sample expense has one voucher of its amount. (Task 4, "the sample shown when there is no database".)

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/20261028100000_bendahara_cash_book.sql` | Expenses, allocations to expenses, three views, the approval rule, guards, five functions |
| `supabase/migrations/20261028100100_bendahara_cash_book_seed.sql` | Demo expenses, vouchers and receipts; data only |
| `supabase/tests/bendahara_cash_book_check.sql` | The controller's check: expenses, vouchers, receipts and approval, as owner, editor, viewer and outsider; always rolls back |
| `tests/bendahara-cash-book.test.ts` | The cash book against the hosted database; run by the controller only |
| `src/lib/finance/cash-book.ts` | Row types and reads for Cash Receipts and Payment Vouchers |
| `src/lib/finance/expenses.ts` | Row type and read for Expenses |
| `src/lib/finance/money.ts` | (modified) `voidPaymentIn` reads `finance_payments_in` first |
| `src/lib/finance/cash-book-views.ts` | The period selector; KPI figures, chart data, filters, status words and CSV rows for the three screens |
| `src/screens/finance/cash-book-sample.ts` | Sample receipts, vouchers and expenses, tied to the sales sample |
| `src/components/finance/cash-receipts-view.tsx`, `payment-vouchers-view.tsx`, `expenses-view.tsx` | Client views, read-only |
| `src/screens/finance/cash-receipts.tsx`, `payment-vouchers.tsx`, `expenses.tsx` | (replaced) server loaders |
| `src/config/live-screens.ts`, `src/app/(app)/finance/actions.ts` | (modified) three screens are live; four path lists refresh them |
| `docs/bendahara-backend.md` | (modified) the cash book, expenses, approval, guards, functions, error codes, known limits |
| `tests/finance-cash-book.test.ts`, `tests/finance-cash-book-views.test.ts` | New unit tests |
| `tests/finance-payments-in.test.ts`, `tests/live-screens.test.ts`, `tests/finance-contact-paths.test.ts`, `tests/finance-sales-actions.test.ts`, `tests/finance-actions.test.ts`, `tests/finance-credit-refund-actions.test.ts`, `tests/finance-quotation-actions.test.ts` | (modified) `voidPaymentIn`'s two requests; live screens; pinned paths |

Not edited: `supabase/tests/bendahara_followons_check.sql` and `supabase/tests/bendahara_invoices_check.sql` (both pass as they are after this migration), `src/lib/finance/refunds.ts`, `src/screens/finance/sales-sample.ts`, and every other live view and screen.

Names used across tasks, spelled once here:

- Database: table `finance_expenses`; column `finance_allocations.expense_id`; views `finance_cash_receipts`, `finance_payment_vouchers`, `finance_expense_totals`; functions `finance_save_cash_receipt`, `finance_post_cash_receipt`, `finance_record_voucher`, `finance_save_expense`, `finance_mark_payment_paid` (replaced), `private.finance_may_decide`; guards `private.finance_expense_guard`, `private.finance_transaction_insert_guard`, `private.finance_transaction_guard` (replaced), `private.finance_allocation_guard` (replaced).
- From `cash-book.ts`: `CashBookStatus`, `CashReceiptKind`, `CashReceiptRow`, `PaymentVoucherKind`, `PaymentVoucherRow`, `listCashReceipts`, `listPaymentVouchers`.
- From `expenses.ts`: `ExpenseStatus`, `ExpenseDisplayStatus`, `EXPENSE_PAGE_SIZE`, `ExpenseRow`, `listExpenses`.
- From `cash-book-views.ts`: `CASH_BOOK_PERIODS`, `CashBookPeriod`, `CASH_BOOK_PERIOD_LABELS`, `inPeriod`, `DONUT_SLICES`, `CashReceiptsViewData`, `CASH_RECEIPT_STATUS_LABELS`, `receiptFor`, `cashReceiptsView`, `CashReceiptFilter`, `filterCashReceipts`, `cashReceiptsCsv`, `PaymentVouchersViewData`, `PAYMENT_VOUCHER_STATUS_LABELS`, `PAYMENT_VOUCHER_KIND_LABELS`, `voucherHome`, `voucherCategory`, `isWaitingVoucher`, `paymentVouchersView`, `PaymentVoucherFilter`, `filterPaymentVouchers`, `paymentVouchersCsv`, `ExpensesViewData`, `EXPENSE_STATUS_LABELS`, `isApprovedExpense`, `expensesView`, `expenseCategories`, `ExpenseFilter`, `filterExpenses`, `expenseMethod`, `expensesCsv`.
- From `cash-book-sample.ts`: `SAMPLE_EXPENSES`, `SAMPLE_PAYMENT_VOUCHERS`, `SAMPLE_CASH_RECEIPTS`. From `sales-sample.ts`, unchanged: `SAMPLE_TODAY`, `SAMPLE_PAYMENTS_IN`, `SAMPLE_REFUNDS`.
- Reused from `money.ts`, unchanged: `PAYMENT_METHODS`, `PAYMENT_METHOD_LABELS`, `PaymentMethod`, `PAYMENT_PAGE_SIZE`, `PaymentInRow`, `paymentIdInput`.
- A receipt's and a voucher's `status` is a payment's, one of `draft`, `pending_approval`, `scheduled`, `posted`, `rejected`, `void`. On Payment Vouchers `pending_approval` is worded "Pending approval", `scheduled` "To be paid" and `posted` "Paid". An expense's `display_status` is `pending`, `approved`, `rejected` or `paid`.

## Every movement of money: where it shows, and which code may change it

All of this must hold after the stage. The first three columns are what the migration's views produce; the last two are what the code allows.

| Movement | Cash book row | Also on | Recorded by | Changed through |
|---|---|---|---|---|
| Money in against invoices, posted at once | Cash Receipts, `kind = invoice` | Payments In, one row per invoice | `finance_record_payment_in` (unchanged) | `voidPaymentIn`, after reading `finance_payments_in` (Task 3) |
| Money in against invoices, a draft first | Cash Receipts, `kind = invoice`, Draft | Payments In, as Draft, nothing offered | `finance_save_cash_receipt`, `finance_post_cash_receipt` (no caller yet) | 5b |
| Money in for an income category | Cash Receipts, `kind = income` | nowhere | `finance_save_cash_receipt`, `finance_post_cash_receipt` (no caller yet) | 5b. `voidPaymentIn` refuses it |
| A payment to a supplier | Payment Vouchers, `kind = bill` | Payments Out, one row per bill | `finance_record_payment_out` (unchanged) | `markPaymentPaid`, `voidPayment`, `deleteScheduledPayment`, after reading `finance_payments_out` (unchanged) |
| A refund | Payment Vouchers, `kind = refund` | Refunds | `finance_record_refund` (unchanged) | `markRefundPaid`, `voidRefund`, `deleteRefund`, after reading `finance_refunds` (unchanged) |
| A payment of approved expenses | Payment Vouchers, `kind = expense` | Expenses, as Paid | `finance_record_voucher` (no caller yet) | 5c and 5d. In none of the three views above, so none of those functions reaches it |
| Money out for an expense category | Payment Vouchers, `kind = other` | nowhere | `finance_record_voucher` (no caller yet) | 5d. In none of the three views above |
| One side of a transfer between accounts | neither | Banking (stage 6) | stage 6 | stage 6 |

No screen adds its total to another screen's. "Paid (MTD)" on Supplier Bills and Payments Out is built from `finance_payments_out`, "Received (MTD)" on Payments In from `finance_payments_in`, "Refunded" from `finance_refunds`; none of them reads the two new views, and the two new screens read nothing else.

## Database error codes

Raised by the guards and functions with these SQLSTATEs. Existing codes are reused where the meaning is the same. **Two codes are new: `FIN14` and `FIN15`** (the highest in use was `FIN13`). No file in `src/lib/finance/` words a code in this part, because no write is called from the app; each forms part adds the sentences for the codes its buttons can meet.

| Code | New meaning in this stage | Worded by |
|---|---|---|
| `FIN01` | An expense does not move to another workspace. An expense must be created pending; an approved or rejected one cannot be edited; it is approved or rejected as it stands, with nothing else changing; an approved one does not go back to pending and is not deleted; a rejected one is edited before it is decided again | 5c |
| `FIN02` | An approved expense with a payment that is posted, scheduled, waiting or in progress cannot be rejected | 5c |
| `FIN04` | A payment can only go against an approved expense, and only money out pays one | 5c, 5d |
| `FIN05` | More than is left of the expense, counting payments that are posted, scheduled, waiting or in progress. Money in against an invoice is unchanged, and a draft receipt now holds its part | 5b, 5c, 5d |
| `FIN06` | A voucher names an expense that is not there or not in the workspace; a receipt's invoices belong to different customers or are not found; one payment names two kinds of document | 5b, 5d |
| `FIN09` | A payment or an allocation does not move to another workspace. A payment must be created as a draft; a posted receipt cannot be saved or posted again; the split of a payment that is waiting for approval, was rejected, or was approved, is locked; money in cannot be marked paid | 5b, 5d |
| `FIN11` | The receipt or the expense no longer exists. `finance_save_cash_receipt` and `finance_post_cash_receipt` also answer this for a payment that is not money in, and to a viewer, who may not lock the row | 5b, 5c |
| **`FIN14`** | **New.** Approval: only an owner or admin approves or rejects an expense or a payment; money out that settles no document needs one of them before it is scheduled or paid; a payment waiting for approval, or rejected, cannot be changed; only a draft is submitted; a rejected payment is final; an approved payment is paid as it was approved | 5c, 5d |
| **`FIN15`** | **New.** A receipt names both invoices and a category, or neither, or a category that is not an income category of the workspace; a voucher names both expenses and a category, or neither, or a category that is not an expense category; an expense names no expense category of the workspace; a receipt for invoices is not exactly its split when it is posted | 5b, 5c, 5d |
| `22023` | `finance_record_voucher` was given a status other than `posted` or `scheduled` | none; only a direct call reaches it |
| `23514` | A check constraint: an expense with a contact and a typed vendor, or neither; more SST than its amount; an amount of nothing; decided without a time or pending with one; a payment with a contact and a typed name; an allocation naming two documents or none | 5b, 5c, 5d for the first two; the rest only a direct write can break |
| `23503` | The category or the vendor of an expense, or the account of a receipt or voucher, is not in the workspace; an expense that a voided payment still names is deleted | 5b, 5c, 5d |
| `42501` | Row-level security refused the write, as everywhere | already worded (`NOT_ALLOWED`) |

`FIN03`, `FIN07`, `FIN08`, `FIN10`, `FIN12`, `FIN13` and every existing meaning of the codes above are unchanged.


---

### Task 1: Migration, seed, check script and database tests

**Files:**
- Create: `tests/bendahara-cash-book.test.ts`
- Create: `supabase/migrations/20261028100000_bendahara_cash_book.sql`
- Create: `supabase/migrations/20261028100100_bendahara_cash_book_seed.sql`
- Create: `supabase/tests/bendahara_cash_book_check.sql`

**Interfaces:**
- Consumes (already in the database): `public.finance_transactions` (with its columns `party_name`, `category_id`, `approved_by`, `approved_at` and `transfer_id`, none of which anything has written, and its status check, which already allows `pending_approval` and `rejected`), `public.finance_allocations` (with its check constraint `finance_allocations_one_document_check`), `public.finance_accounts`, `public.finance_categories` (`kind` is `expense` or `income`), `public.finance_contacts`, `public.finance_invoices`, `public.supplier_bills`, `public.finance_credit_notes`, `public.finance_sequences`, `public.finance_next_number(target_org uuid, doc text) returns text` (which already answers `'receipt'` with `RC-` and `'voucher'` with `PV-`, so no sequence definition is added), `public.finance_invoice_totals`, `private.finance_refunds_held(uuid, uuid, uuid)`, `private.finance_seed_accounts(target_org uuid)`, `private.finance_seed_categories(target_org uuid)`, `private.is_org_member`, `private.is_org_writer`, `private.is_org_admin` (true for a role of `owner` or `admin`, and granted to `authenticated`), `private.mfa_ok`, and the triggers `finance_transaction_guard` (before update or delete) and `finance_allocation_guard` (their functions are replaced; the triggers stay).
- Produces table `finance_expenses`; column `finance_allocations.expense_id`; check constraint `finance_transactions_party_check`; views `finance_cash_receipts`, `finance_payment_vouchers`, `finance_expense_totals`; triggers `finance_expense_guard` and `finance_transaction_insert_guard`.
- Produces functions:
  - `public.finance_save_cash_receipt(target_org uuid, receipt jsonb, allocations jsonb) returns uuid`
  - `public.finance_post_cash_receipt(target_org uuid, target_txn uuid) returns text` (the `RC-` number)
  - `public.finance_record_voucher(target_org uuid, voucher jsonb, allocations jsonb) returns uuid`
  - `public.finance_save_expense(target_org uuid, expense jsonb) returns uuid`
  - `public.finance_mark_payment_paid(target_org uuid, target_txn uuid, paid_on date) returns text` (replaced; same signature)
  - `private.finance_may_decide(target_org uuid) returns boolean`
- `finance_cash_receipts` columns, in order: `transaction_id, org_id, number, txn_date, method, amount, status, reference, notes, account_id, account_name, account_kind, contact_id, party_name, kind, category_id, category_name, documents, created_by, created_at`.
- `finance_payment_vouchers` columns: `transaction_id, org_id, number, txn_date, method, amount, status, reference, notes, account_id, account_name, account_kind, contact_id, party_name, kind, category_id, category_name, documents, approved_at, created_by, created_at`.
- `finance_expense_totals` columns: `id, org_id, expense_date, category_id, category_name, vendor_id, vendor_name, amount, sst_amount, notes, status, approved_by, approved_at, created_by, created_at, updated_at, paid, held, display_status, method, paid_on`.

**The implementer writes the four files and commits (steps 1 to 9). Steps 10 to 14 are the controller's and are not run by an implementer. No step of this task runs anything against a database.**

What is replaced and what is left alone, so nobody has to rediscover it:

- `finance_payments_out`, `finance_payments_in`, `finance_refunds`, `finance_invoice_totals`, `supplier_bill_totals`, `finance_quotation_totals`, `finance_credit_note_totals`, every guard on bills, invoices, quotations, credit notes and contacts, and the functions `finance_record_payment_out`, `finance_record_payment_in`, `finance_record_refund`, `finance_save_invoice`, `finance_post_invoice`, `finance_save_bill`, `finance_post_bill`, the quotation and credit note functions and `finance_next_number` are **not touched**.
- `private.finance_transaction_guard()`: the 4a function, with one line of its refund re-check changed (the invoices a payment refunds are found by its allocations that name an invoice or a credit note, where the test was "not a bill"), and the approval block added before its final `return new`.
- `private.finance_allocation_guard()`: the 4a function, with the payment's `approved_at` read beside its status; the lock on a posted payment's split widened to one that is waiting, rejected or approved; the one-kind rule after the split check; and an expense branch before the bill branch. The invoice, credit note and bill branches are the 4a text.
- `public.finance_mark_payment_paid(uuid, uuid, date)`: the stage 2 function, with the direction read and one check added.
- `finance_allocations_one_document_check` is dropped and added again by name, widened to four columns. Its name does not change, and both existing check scripts list the constraints of that table by name.

- [ ] **Step 1: Check the file names are free**

Run: `ls supabase/migrations | tail -4`
Expected: no file whose name starts with `20261028`, and none later. If `main` has gained a file stamped `20261028` or later, stop and tell the controller: the two new files must sort after every file in the folder.

- [ ] **Step 2: Write the database test**

It runs against the hosted database and is run by the controller only (step 13). Every user in it owns the workspace it makes; what an editor and a viewer may not do is the check script's to prove (Decision 21).

Create `tests/bendahara-cash-book.test.ts`:

```ts
import { beforeAll, expect, test } from 'vitest';
import { type SupabaseClient } from '@supabase/supabase-js';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { createOrg, joinDemo, signInAnon, liveClient } from './helpers/live-workspaces';

// Cash receipts, payment vouchers and expenses against the hosted database.
// Run by the controller only, after the cash book migration is applied. Every
// user here owns the workspace it makes, so each is an owner: what an editor
// and a viewer may not do is proved by supabase/tests/bendahara_cash_book_check.sql,
// which acts as each of them. The last test reads the demo seed.

const testWithSupabase = hasSupabaseEnv ? test : test.skip;

if (!hasSupabaseEnv) console.warn(supabaseEnvSkipReason);

type Org = {
  c: SupabaseClient;
  userId: string;
  orgId: string;
  bank: string;
  till: string;
  customer: string;
  supplier: string;
  rent: string;
  sales: string;
};

async function anonUserWithOrg(orgName: string): Promise<Org> {
  const c = liveClient();
  const { data: auth, error: authErr } = await signInAnon(c);
  expect(authErr, authErr?.message).toBeNull();
  const { data: orgId, error } = await createOrg(c, orgName);
  expect(error, error?.message).toBeNull();
  const { data: accounts } = await c.from('finance_accounts').select('id, kind').eq('org_id', orgId);
  const { data: categories } = await c.from('finance_categories').select('id, name, kind').eq('org_id', orgId);
  const { data: contacts, error: contactErr } = await c
    .from('finance_contacts')
    .insert([
      { org_id: orgId, name: `Customer of ${orgName}`, is_customer: true },
      { org_id: orgId, name: `Supplier of ${orgName}`, is_supplier: true },
    ])
    .select('id, is_customer');
  expect(contactErr, contactErr?.message).toBeNull();
  return {
    c,
    userId: auth.user!.id,
    orgId: orgId as string,
    bank: accounts!.find((a) => a.kind === 'bank')!.id as string,
    till: accounts!.find((a) => a.kind === 'cash')!.id as string,
    customer: contacts!.find((x) => x.is_customer)!.id as string,
    supplier: contacts!.find((x) => !x.is_customer)!.id as string,
    rent: categories!.find((x) => x.kind === 'expense' && x.name === 'Rent')!.id as string,
    sales: categories!.find((x) => x.kind === 'income' && x.name === 'Sales')!.id as string,
  };
}

function daysFromToday(days: number) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const DESIGN = { description: 'Design work', quantity: 10, unit_price: 12.5, sst_rate: 6 }; // 125.00 + 7.50 SST = 132.50

/** A posted invoice of RM 132.50. */
async function postedInvoice(o: Org) {
  const saved = await o.c.rpc('finance_save_invoice', {
    target_org: o.orgId,
    invoice: { customer_id: o.customer, invoice_date: daysFromToday(0), due_date: daysFromToday(30) },
    lines: [DESIGN],
  });
  expect(saved.error, saved.error?.message).toBeNull();
  const posted = await o.c.rpc('finance_post_invoice', { target_org: o.orgId, target_invoice: saved.data });
  expect(posted.error, posted.error?.message).toBeNull();
  return saved.data as string;
}

/** A posted bill of RM 132.50. */
async function postedBill(o: Org) {
  const saved = await o.c.rpc('finance_save_bill', {
    target_org: o.orgId,
    bill: { supplier_id: o.supplier, bill_date: daysFromToday(0), due_date: daysFromToday(30) },
    lines: [DESIGN],
  });
  expect(saved.error, saved.error?.message).toBeNull();
  const posted = await o.c.rpc('finance_post_bill', { target_org: o.orgId, target_bill: saved.data });
  expect(posted.error, posted.error?.message).toBeNull();
  return saved.data as string;
}

function saveExpense(o: Org, amount: number, extra: object = {}) {
  return o.c.rpc('finance_save_expense', {
    target_org: o.orgId,
    expense: { expense_date: daysFromToday(0), category_id: o.rent, vendor_name: 'Landlord', amount, ...extra },
  });
}

function payExpense(o: Org, expenseId: string, amount: number, status: 'posted' | 'scheduled' = 'posted') {
  return o.c.rpc('finance_record_voucher', {
    target_org: o.orgId,
    voucher: { account_id: o.bank, txn_date: daysFromToday(0), method: 'fpx', party_name: 'Landlord', status },
    allocations: [{ expense_id: expenseId, amount }],
  });
}

function categoryVoucher(o: Org, amount: number, status: 'posted' | 'scheduled' = 'posted') {
  return o.c.rpc('finance_record_voucher', {
    target_org: o.orgId,
    voucher: {
      account_id: o.bank, txn_date: daysFromToday(0), method: 'fpx', party_name: 'Water board', category_id: o.rent, amount, status,
    },
    allocations: [],
  });
}

function saveReceipt(o: Org, receipt: object, allocations: object[] = []) {
  return o.c.rpc('finance_save_cash_receipt', {
    target_org: o.orgId,
    receipt: { account_id: o.bank, txn_date: daysFromToday(0), method: 'cash', ...receipt },
    allocations,
  });
}

async function expense(c: SupabaseClient, id: string) {
  const { data, error } = await c
    .from('finance_expense_totals')
    .select('status, display_status, amount, paid, held, approved_by, method')
    .eq('id', id)
    .single();
  expect(error, error?.message).toBeNull();
  return data!;
}

async function txn(c: SupabaseClient, id: string) {
  const { data, error } = await c
    .from('finance_transactions')
    .select('direction, status, amount, number, approved_by, approved_at, category_id')
    .eq('id', id)
    .single();
  expect(error, error?.message).toBeNull();
  return data!;
}

let a: Org;
let b: Org;

beforeAll(async () => {
  if (!hasSupabaseEnv) return;
  a = await anonUserWithOrg('Cash Book A Sdn Bhd');
  b = await anonUserWithOrg('Cash Book B Sdn Bhd');
});

testWithSupabase('an expense saved by an owner is approved, locked, and reads Paid once a voucher covers it', async () => {
  const saved = await saveExpense(a, 100, { sst_amount: 6 });
  expect(saved.error, saved.error?.message).toBeNull();
  expect(await expense(a.c, saved.data)).toEqual({
    status: 'approved', display_status: 'approved', amount: 100, paid: 0, held: 0, approved_by: a.userId, method: null,
  });

  const direct = await a.c.from('finance_expenses').insert({
    org_id: a.orgId, category_id: a.rent, vendor_name: 'Sneaky', amount: 1, status: 'approved', approved_at: new Date().toISOString(),
  });
  expect(direct.error?.code).toBe('FIN01');
  const wrongKind = await saveExpense(a, 10, { category_id: a.sales });
  expect(wrongKind.error?.code).toBe('FIN15');
  const noVendor = await saveExpense(a, 10, { vendor_name: null });
  expect(noVendor.error?.code).toBe('23514');
  const edit = await a.c.from('finance_expenses').update({ amount: 1 }).eq('id', saved.data);
  expect(edit.error?.code).toBe('FIN01');
  const remove = await a.c.from('finance_expenses').delete().eq('id', saved.data);
  expect(remove.error?.code).toBe('FIN01');

  const part = await payExpense(a, saved.data, 40, 'scheduled');
  expect(part.error, part.error?.message).toBeNull();
  expect(await expense(a.c, saved.data)).toMatchObject({ paid: 0, held: 40, display_status: 'approved' });
  const tooMuch = await payExpense(a, saved.data, 60.01);
  expect(tooMuch.error?.code).toBe('FIN05');
  const rest = await payExpense(a, saved.data, 60);
  expect(rest.error, rest.error?.message).toBeNull();
  expect((await txn(a.c, rest.data)).number).toMatch(/^PV-\d{4}$/);
  const paid = await a.c.rpc('finance_mark_payment_paid', { target_org: a.orgId, target_txn: part.data, paid_on: daysFromToday(0) });
  expect(paid.error, paid.error?.message).toBeNull();
  expect(await expense(a.c, saved.data)).toMatchObject({ paid: 100, held: 0, display_status: 'paid', method: 'fpx' });

  // With payments standing it cannot be rejected; once they are voided it can, and is then edited back to pending.
  const reject = () => a.c.from('finance_expenses').update({ status: 'rejected' }).eq('id', saved.data);
  expect((await reject()).error?.code).toBe('FIN02');
  for (const id of [part.data, rest.data]) {
    expect((await a.c.from('finance_transactions').update({ status: 'void' }).eq('id', id)).error).toBeNull();
  }
  expect((await reject()).error).toBeNull();
  expect((await payExpense(a, saved.data, 10)).error?.code).toBe('FIN04');
});

testWithSupabase('two vouchers for the whole of one expense at the same moment: only one goes through', async () => {
  const saved = await saveExpense(a, 75);
  expect(saved.error, saved.error?.message).toBeNull();
  const results = await Promise.all([payExpense(a, saved.data, 75), payExpense(a, saved.data, 75)]);
  expect(results.filter((r) => r.error === null)).toHaveLength(1);
  expect(results.find((r) => r.error)?.error?.code).toBe('FIN05');
  expect(await expense(a.c, saved.data)).toMatchObject({ paid: 75, display_status: 'paid' });
});

testWithSupabase('a voucher that settles no document is approved in the owner\'s name; a payment cannot be created past its draft', async () => {
  const paid = await categoryVoucher(a, 300);
  expect(paid.error, paid.error?.message).toBeNull();
  const row = await txn(a.c, paid.data);
  expect(row).toMatchObject({ direction: 'out', status: 'posted', amount: 300, approved_by: a.userId, category_id: a.rent });
  expect(row.number).toMatch(/^PV-\d{4}$/);
  expect(row.approved_at).not.toBeNull();

  const later = await categoryVoucher(a, 80, 'scheduled');
  expect(later.error, later.error?.message).toBeNull();
  expect(await txn(a.c, later.data)).toMatchObject({ status: 'scheduled', number: null, approved_by: a.userId });
  // Approved, it is paid as it was approved.
  const changed = await a.c.from('finance_transactions').update({ amount: 8000 }).eq('id', later.data);
  expect(changed.error?.code).toBe('FIN14');
  const marked = await a.c.rpc('finance_mark_payment_paid', { target_org: a.orgId, target_txn: later.data, paid_on: daysFromToday(0) });
  expect(marked.error, marked.error?.message).toBeNull();
  expect(await txn(a.c, later.data)).toMatchObject({ status: 'posted', amount: 80 });

  const direct = await a.c.from('finance_transactions').insert({
    org_id: a.orgId, direction: 'out', account_id: a.bank, amount: 5, method: 'cash', category_id: a.rent, status: 'posted', number: 'PV-SNEAKY',
  });
  expect(direct.error?.code).toBe('FIN09');
  const wrongKind = await a.c.rpc('finance_record_voucher', {
    target_org: a.orgId,
    voucher: { account_id: a.bank, method: 'fpx', party_name: 'X', category_id: a.sales, amount: 5 },
    allocations: [],
  });
  expect(wrongKind.error?.code).toBe('FIN15');

  // A rejected payment is final: it is deleted, never brought back.
  const { data: draft } = await a.c
    .from('finance_transactions')
    .insert({ org_id: a.orgId, direction: 'out', account_id: a.bank, amount: 5, method: 'cash', category_id: a.rent })
    .select('id')
    .single();
  expect((await a.c.from('finance_transactions').update({ status: 'pending_approval' }).eq('id', draft!.id)).error).toBeNull();
  expect((await a.c.from('finance_transactions').update({ status: 'rejected' }).eq('id', draft!.id)).error).toBeNull();
  const back = await a.c.from('finance_transactions').update({ status: 'scheduled' }).eq('id', draft!.id);
  expect(back.error?.code).toBe('FIN14');
  expect((await a.c.from('finance_transactions').delete().eq('id', draft!.id)).error).toBeNull();
});

testWithSupabase('a cash receipt is a draft until it is posted, and a draft holds what it is split across', async () => {
  const income = await saveReceipt(a, { party_name: 'Walk-in', category_id: a.sales, amount: 80, account_id: a.till });
  expect(income.error, income.error?.message).toBeNull();
  const { data: draft } = await a.c
    .from('finance_cash_receipts')
    .select('kind, status, number, amount, party_name, category_name, account_kind')
    .eq('transaction_id', income.data)
    .single();
  expect(draft).toEqual({
    kind: 'income', status: 'draft', number: null, amount: 80, party_name: 'Walk-in', category_name: 'Sales', account_kind: 'cash',
  });
  const neither = await saveReceipt(a, { party_name: 'Walk-in', amount: 80 });
  expect(neither.error?.code).toBe('FIN15');
  const expenseCategory = await saveReceipt(a, { party_name: 'Walk-in', category_id: a.rent, amount: 80 });
  expect(expenseCategory.error?.code).toBe('FIN15');

  const posted = await a.c.rpc('finance_post_cash_receipt', { target_org: a.orgId, target_txn: income.data });
  expect(posted.error, posted.error?.message).toBeNull();
  expect(posted.data).toMatch(/^RC-\d{4}$/);
  const again = await saveReceipt(a, { id: income.data, party_name: 'Walk-in', category_id: a.sales, amount: 1 });
  expect(again.error?.code).toBe('FIN09');

  // Against an invoice: the draft holds RM 100 of the RM 132.50, so only RM 32.50 more can be received.
  const invoice = await postedInvoice(a);
  const held = await saveReceipt(a, { method: 'fpx' }, [{ invoice_id: invoice, amount: 100 }]);
  expect(held.error, held.error?.message).toBeNull();
  const receive = (amount: number) =>
    a.c.rpc('finance_record_payment_in', {
      target_org: a.orgId,
      payment: { account_id: a.bank, txn_date: daysFromToday(0), method: 'fpx' },
      allocations: [{ invoice_id: invoice, amount }],
    });
  expect((await receive(32.51)).error?.code).toBe('FIN05');
  expect((await receive(32.5)).error).toBeNull();
  const post = await a.c.rpc('finance_post_cash_receipt', { target_org: a.orgId, target_txn: held.data });
  expect(post.error, post.error?.message).toBeNull();
  const { data: totals } = await a.c.from('finance_invoice_totals').select('paid, balance, display_status').eq('id', invoice).single();
  expect(totals).toEqual({ paid: 132.5, balance: 0, display_status: 'paid' });
  // The same money: one row per invoice on Payments In, one row on Cash Receipts.
  const { data: onPaymentsIn } = await a.c.from('finance_payments_in').select('allocation_id').eq('transaction_id', held.data);
  const { data: onCashReceipts } = await a.c.from('finance_cash_receipts').select('kind, documents').eq('transaction_id', held.data);
  expect(onPaymentsIn).toHaveLength(1);
  expect(onCashReceipts).toHaveLength(1);
  expect(onCashReceipts![0].kind).toBe('invoice');
  expect(onCashReceipts![0].documents).toMatch(/^INV-\d{4}$/);
});

testWithSupabase('one draft receipt posted twice at the same moment gets one number', async () => {
  const saved = await saveReceipt(a, { party_name: 'Walk-in', category_id: a.sales, amount: 12 });
  expect(saved.error, saved.error?.message).toBeNull();
  const post = () => a.c.rpc('finance_post_cash_receipt', { target_org: a.orgId, target_txn: saved.data });
  const results = await Promise.all([post(), post()]);
  expect(results.filter((r) => r.error === null)).toHaveLength(1);
  expect(results.find((r) => r.error)?.error?.code).toBe('FIN09');
  expect((await txn(a.c, saved.data)).number).toBe(results.find((r) => r.error === null)!.data);
});

testWithSupabase('money in is never marked paid, and never takes a voucher number', async () => {
  const { data: draft } = await a.c
    .from('finance_transactions')
    .insert({ org_id: a.orgId, direction: 'in', account_id: a.bank, amount: 5, method: 'cash', category_id: a.sales })
    .select('id')
    .single();
  expect((await a.c.from('finance_transactions').update({ status: 'scheduled' }).eq('id', draft!.id)).error).toBeNull();
  const marked = await a.c.rpc('finance_mark_payment_paid', { target_org: a.orgId, target_txn: draft!.id, paid_on: daysFromToday(0) });
  expect(marked.error?.code).toBe('FIN09');
  expect(await txn(a.c, draft!.id)).toMatchObject({ status: 'scheduled', number: null });
  expect((await a.c.from('finance_transactions').delete().eq('id', draft!.id)).error).toBeNull();
});

testWithSupabase('every movement of money is one row on its cash book screen, whatever it pays', async () => {
  const first = await postedBill(a);
  const second = await postedBill(a);
  const paid = await a.c.rpc('finance_record_payment_out', {
    target_org: a.orgId,
    payment: { account_id: a.bank, txn_date: daysFromToday(0), method: 'fpx' },
    allocations: [{ bill_id: first, amount: 132.5 }, { bill_id: second, amount: 100 }],
  });
  expect(paid.error, paid.error?.message).toBeNull();
  const { data: onPaymentsOut } = await a.c.from('finance_payments_out').select('allocation_id').eq('transaction_id', paid.data);
  const { data: vouchers } = await a.c
    .from('finance_payment_vouchers')
    .select('kind, amount, status, documents, party_name')
    .eq('transaction_id', paid.data);
  expect(onPaymentsOut).toHaveLength(2);
  expect(vouchers).toHaveLength(1);
  expect(vouchers![0]).toMatchObject({ kind: 'bill', amount: 232.5, status: 'posted', party_name: 'Supplier of Cash Book A Sdn Bhd' });
  expect(vouchers![0].documents).toMatch(/^BILL-\d{4}, BILL-\d{4}$/);
  // A payment to a supplier recorded the old way is not held for approval and names nobody as approver.
  expect(await txn(a.c, paid.data)).toMatchObject({ status: 'posted', approved_by: null, approved_at: null });

  // One payment pays one kind of document.
  const saved = await saveExpense(a, 20);
  const { data: draft } = await a.c
    .from('finance_transactions')
    .insert({ org_id: a.orgId, direction: 'out', account_id: a.bank, amount: 30, method: 'cash' })
    .select('id')
    .single();
  const onBill = await a.c.from('finance_allocations').insert({ org_id: a.orgId, transaction_id: draft!.id, bill_id: second, amount: 10 });
  expect(onBill.error, onBill.error?.message).toBeNull();
  const onExpense = await a.c
    .from('finance_allocations')
    .insert({ org_id: a.orgId, transaction_id: draft!.id, expense_id: saved.data, amount: 10 });
  expect(onExpense.error?.code).toBe('FIN06');
  expect((await a.c.from('finance_transactions').delete().eq('id', draft!.id)).error).toBeNull();

  // The two views are exactly the payments table, by direction.
  const { count: out } = await a.c
    .from('finance_transactions').select('id', { count: 'exact', head: true }).eq('org_id', a.orgId).eq('direction', 'out');
  const { count: listedOut } = await a.c
    .from('finance_payment_vouchers').select('transaction_id', { count: 'exact', head: true }).eq('org_id', a.orgId);
  const { count: moneyIn } = await a.c
    .from('finance_transactions').select('id', { count: 'exact', head: true }).eq('org_id', a.orgId).eq('direction', 'in');
  const { count: listedIn } = await a.c
    .from('finance_cash_receipts').select('transaction_id', { count: 'exact', head: true }).eq('org_id', a.orgId);
  expect(listedOut).toBe(out);
  expect(listedIn).toBe(moneyIn);
});

testWithSupabase('another workspace cannot see or touch expenses, vouchers or receipts', async () => {
  const saved = await saveExpense(a, 50);
  expect(saved.error, saved.error?.message).toBeNull();
  const receipt = await saveReceipt(a, { party_name: 'Walk-in', category_id: a.sales, amount: 9 });
  expect(receipt.error, receipt.error?.message).toBeNull();

  for (const table of ['finance_expenses', 'finance_expense_totals', 'finance_payment_vouchers', 'finance_cash_receipts']) {
    const { data } = await b.c.from(table).select('org_id').eq('org_id', a.orgId);
    expect(data ?? [], table).toEqual([]);
  }
  const save = await b.c.rpc('finance_save_expense', {
    target_org: a.orgId,
    expense: { category_id: a.rent, vendor_name: 'X', amount: 1 },
  });
  expect(save.error?.code).toBe('FIN15');
  const pay = await b.c.rpc('finance_record_voucher', {
    target_org: b.orgId,
    voucher: { account_id: b.bank, method: 'fpx', party_name: 'X' },
    allocations: [{ expense_id: saved.data, amount: 1 }],
  });
  expect(pay.error?.code).toBe('FIN06');
  const post = await b.c.rpc('finance_post_cash_receipt', { target_org: a.orgId, target_txn: receipt.data });
  expect(post.error?.code).toBe('FIN11');
  const { data: approved } = await b.c.from('finance_expenses').update({ status: 'rejected' }).eq('id', saved.data).select('id');
  expect(approved ?? []).toEqual([]);
  expect((await expense(a.c, saved.data)).status).toBe('approved');
});

testWithSupabase('a demo viewer reads the seeded cash book, and can write none of it', async () => {
  const c = liveClient();
  const { error: authErr } = await signInAnon(c);
  expect(authErr, authErr?.message).toBeNull();
  const { data: demoId, error } = await joinDemo(c);
  expect(error, error?.message).toBeNull();

  // Dates are relative to the day the seed ran: only what cannot drift is asserted.
  const { data: expenses } = await c.from('finance_expense_totals').select('id, display_status, amount, paid').eq('org_id', demoId);
  expect((expenses ?? []).length).toBe(23);
  expect((expenses ?? []).filter((e) => e.display_status === 'paid')).toHaveLength(19);
  expect((expenses ?? []).filter((e) => e.display_status === 'pending')).toHaveLength(2);
  expect((expenses ?? []).filter((e) => e.display_status === 'paid').every((e) => Number(e.paid) === Number(e.amount))).toBe(true);

  const { data: vouchers } = await c.from('finance_payment_vouchers').select('kind, status, number, amount').eq('org_id', demoId);
  const own = (vouchers ?? []).filter((v) => v.kind === 'expense' || v.kind === 'other');
  expect(own.filter((v) => v.kind === 'expense')).toHaveLength(19);
  expect(own.filter((v) => v.status === 'pending_approval').reduce((sum, v) => sum + Number(v.amount), 0)).toBe(4340);
  expect(own.every((v) => (v.status === 'posted') === /^PV-\d+$/.test(v.number ?? ''))).toBe(true);
  // The demo's payments to suppliers and refunds are vouchers too.
  expect((vouchers ?? []).some((v) => v.kind === 'bill')).toBe(true);
  expect((vouchers ?? []).some((v) => v.kind === 'refund')).toBe(true);

  const { data: receipts } = await c.from('finance_cash_receipts').select('kind, status, number, amount').eq('org_id', demoId);
  const income = (receipts ?? []).filter((r) => r.kind === 'income');
  expect(income).toHaveLength(7);
  expect(income.filter((r) => r.status === 'draft').every((r) => r.number === null)).toBe(true);
  expect(income.filter((r) => r.status === 'posted').reduce((sum, r) => sum + Number(r.amount), 0)).toBeCloseTo(4444.2, 2);
  expect((receipts ?? []).some((r) => r.kind === 'invoice')).toBe(true);

  const pending = (expenses ?? []).find((e) => e.display_status === 'pending')!;
  const save = await c.rpc('finance_save_expense', {
    target_org: demoId,
    expense: { category_id: crypto.randomUUID(), vendor_name: 'Viewer', amount: 1 },
  });
  expect(save.error?.code).toBe('FIN15');
  const { data: decided } = await c.from('finance_expenses').update({ status: 'approved' }).eq('id', pending.id).select('id');
  expect(decided ?? []).toEqual([]);
  const voucher = await c.rpc('finance_record_voucher', {
    target_org: demoId,
    voucher: { account_id: crypto.randomUUID(), method: 'fpx', party_name: 'Viewer' },
    allocations: [{ expense_id: pending.id, amount: 1 }],
  });
  expect(voucher.error?.code).toBe('42501');
  const receipt = await c.from('finance_transactions').insert({
    org_id: demoId, direction: 'in', account_id: crypto.randomUUID(), amount: 1, method: 'cash',
  });
  expect(receipt.error?.code).toBe('42501');
});
```

- [ ] **Step 3: Do not run it**

It needs the migration, which is not applied, and it reaches the hosted production database. Type-checking it is step 8.

- [ ] **Step 4: Write the schema migration**

Create `supabase/migrations/20261028100000_bendahara_cash_book.sql`:

```sql
-- Bendahara cash book, database half (additive; safe to apply while the
-- previous code is still deployed).
--   * finance_expenses: an expense with a category and a vendor, approved or
--     rejected by an owner or admin.
--   * finance_allocations can now point at an expense: money out pays it.
--   * Views: finance_cash_receipts (every movement of money in, one row each),
--     finance_payment_vouchers (every movement of money out, one row each) and
--     finance_expense_totals.
--   * Approval: a payment waiting for approval is approved or rejected by an
--     owner or admin only, a rejected one is final, and money out that settles
--     no document needs an owner or admin before it is scheduled or paid.
--   * Guards: the ones on payments and allocations are replaced; payments get
--     one on insert; expenses get their own.
--   * Functions that save and post a cash receipt, record a payment voucher
--     and save an expense. finance_mark_payment_paid is replaced: it now
--     refuses money in.
--
-- The code deployed while this is applied records payments to suppliers,
-- payments in and refunds through finance_record_payment_out,
-- finance_record_payment_in and finance_record_refund, marks scheduled money
-- out as paid, voids posted payments and deletes scheduled ones. For every one
-- of those writes the guards below answer as they did before: same checks,
-- same order, same codes. None of those three functions is touched, and no
-- payment they record waits for approval.
--
-- What differs, for writes only a direct call can make:
--   * A payment is created as a draft. A direct INSERT with another status is
--     FIN09 where it was allowed.
--   * A rejected payment can no longer be moved to any other status (FIN14).
--     A rejected refund that is paid out is still refused first by the refund
--     checks (FIN04, FIN05), as before.
--   * A payment out whose amount is more than its split is, for that part,
--     money that settles no document: someone who is not an owner or admin
--     can no longer schedule or pay it (FIN14).
--   * One payment pays one kind of document: bills, or invoices and credit
--     notes, or expenses. A second kind on the same payment is FIN06.
--   * finance_mark_payment_paid refuses money in (FIN09) where it would have
--     given it a PV- number.
--
-- Nothing here is granted to service_role: every write is made by a signed-in
-- person through the authenticated role, and no worker touches these tables.

-- Fail fast instead of queueing behind a long transaction and stalling sign-ins.
set local lock_timeout = '5s';

-- ---- expenses ---------------------------------------------------------------
-- amount is what was paid or is to be paid, SST included; sst_amount is the
-- part of it that is SST. The vendor is a contact or a typed name, never both.
-- approved_by and approved_at say who decided and when, whichever way it was
-- decided: a pending expense has neither.
create table public.finance_expenses (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  expense_date date not null default current_date,
  category_id uuid not null,
  vendor_id uuid,
  vendor_name text,
  amount numeric(14,2) not null check (amount > 0),
  sst_amount numeric(14,2) not null default 0 check (sst_amount >= 0),
  notes text,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, id),
  constraint finance_expenses_vendor_check check (num_nonnulls(vendor_id, vendor_name) = 1),
  constraint finance_expenses_sst_check check (sst_amount <= amount),
  -- approved_by is not in this rule: it is cleared when that user is deleted.
  constraint finance_expenses_decided_check check ((status = 'pending') = (approved_at is null)),
  foreign key (org_id, category_id) references public.finance_categories(org_id, id),
  foreign key (org_id, vendor_id) references public.finance_contacts(org_id, id)
);
create index finance_expenses_date_idx on public.finance_expenses (org_id, expense_date);
create index finance_expenses_category_idx on public.finance_expenses (org_id, category_id);
create index finance_expenses_vendor_idx on public.finance_expenses (org_id, vendor_id);

do $$
declare t text;
begin
  foreach t in array array['finance_expenses'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for select to authenticated using (private.is_org_member(org_id))', t || '_select', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (private.is_org_writer(org_id))', t || '_insert', t);
    execute format('create policy %I on public.%I for update to authenticated using (private.is_org_writer(org_id)) with check (private.is_org_writer(org_id))', t || '_update', t);
    execute format('create policy %I on public.%I for delete to authenticated using (private.is_org_writer(org_id))', t || '_delete', t);
    execute format(
      'create policy mfa_required on public.%I as restrictive for all to authenticated '
      || 'using ((select private.mfa_ok())) with check ((select private.mfa_ok()))', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;

-- ---- allocations: a bill, an invoice, a credit note or an expense -----------
alter table public.finance_allocations add column expense_id uuid;
alter table public.finance_allocations
  drop constraint finance_allocations_one_document_check,
  add constraint finance_allocations_one_document_check
    check (num_nonnulls(bill_id, invoice_id, credit_note_id, expense_id) = 1),
  add constraint finance_allocations_transaction_expense_key unique (transaction_id, expense_id),
  add constraint finance_allocations_expense_fkey
    foreign key (org_id, expense_id) references public.finance_expenses(org_id, id);
create index finance_allocations_expense_idx on public.finance_allocations (org_id, expense_id);

-- ---- payments: who paid or was paid is a contact or a typed name ------------
-- party_name was a free column nothing wrote, so no row has both.
alter table public.finance_transactions
  add constraint finance_transactions_party_check check (contact_id is null or party_name is null);

-- ---- views ------------------------------------------------------------------
-- One row per movement of money in, whatever it is for. kind is 'invoice' for
-- a payment against invoices, which Payments In also shows one row per
-- invoice of, and 'income' for money that settles no invoice and carries a
-- category. The two sides of a transfer between accounts are not receipts.
create view public.finance_cash_receipts with (security_invoker = true) as
select
  t.id as transaction_id,
  t.org_id,
  t.number,
  t.txn_date,
  t.method,
  t.amount,
  t.status,
  t.reference,
  t.notes,
  t.account_id,
  acc.name as account_name,
  acc.kind as account_kind,
  t.contact_id,
  coalesce(c.name, t.party_name) as party_name,
  case when d.invoices > 0 then 'invoice' else 'income' end as kind,
  t.category_id,
  cat.name as category_name,
  d.documents,
  t.created_by,
  t.created_at
from public.finance_transactions t
join public.finance_accounts acc on acc.org_id = t.org_id and acc.id = t.account_id
left join public.finance_contacts c on c.org_id = t.org_id and c.id = t.contact_id
left join public.finance_categories cat on cat.org_id = t.org_id and cat.id = t.category_id
cross join lateral (
  select
    count(*) as invoices,
    string_agg(i.invoice_no, ', ' order by i.invoice_no) as documents
  from public.finance_allocations a
  join public.finance_invoices i on i.org_id = a.org_id and i.id = a.invoice_id
  where a.org_id = t.org_id and a.transaction_id = t.id
) d
where t.direction = 'in' and t.transfer_id is null;
revoke all on public.finance_cash_receipts from anon, authenticated;
grant select on public.finance_cash_receipts to authenticated;

-- One row per movement of money out, whatever it is for. kind is 'bill' for a
-- payment to a supplier (Payments Out shows one row per bill of it), 'refund'
-- for money back to a customer (Refunds shows it), 'expense' for a payment of
-- approved expenses, and 'other' for money that settles no document and
-- carries a category. category_name is the payment's own category, or the one
-- its expenses share; documents is the numbers of what it pays.
create view public.finance_payment_vouchers with (security_invoker = true) as
select
  t.id as transaction_id,
  t.org_id,
  t.number,
  t.txn_date,
  t.method,
  t.amount,
  t.status,
  t.reference,
  t.notes,
  t.account_id,
  acc.name as account_name,
  acc.kind as account_kind,
  t.contact_id,
  coalesce(c.name, t.party_name) as party_name,
  case
    when d.bills > 0 then 'bill'
    when d.refunds > 0 then 'refund'
    when d.expenses > 0 then 'expense'
    else 'other'
  end as kind,
  t.category_id,
  case when d.expenses > 0 then d.expense_category else cat.name end as category_name,
  d.documents,
  t.approved_at,
  t.created_by,
  t.created_at
from public.finance_transactions t
join public.finance_accounts acc on acc.org_id = t.org_id and acc.id = t.account_id
left join public.finance_contacts c on c.org_id = t.org_id and c.id = t.contact_id
left join public.finance_categories cat on cat.org_id = t.org_id and cat.id = t.category_id
cross join lateral (
  select
    count(a.bill_id) as bills,
    count(a.invoice_id) + count(a.credit_note_id) as refunds,
    count(a.expense_id) as expenses,
    case when count(distinct ec.id) = 1 then min(ec.name) end as expense_category,
    string_agg(coalesce(b.bill_no, i.invoice_no, n.credit_note_no), ', '
               order by coalesce(b.bill_no, i.invoice_no, n.credit_note_no)) as documents
  from public.finance_allocations a
  left join public.supplier_bills b on b.org_id = a.org_id and b.id = a.bill_id
  left join public.finance_invoices i on i.org_id = a.org_id and i.id = a.invoice_id
  left join public.finance_credit_notes n on n.org_id = a.org_id and n.id = a.credit_note_id
  left join public.finance_expenses e on e.org_id = a.org_id and e.id = a.expense_id
  left join public.finance_categories ec on ec.org_id = e.org_id and ec.id = e.category_id
  where a.org_id = t.org_id and a.transaction_id = t.id
) d
where t.direction = 'out' and t.transfer_id is null;
revoke all on public.finance_payment_vouchers from anon, authenticated;
grant select on public.finance_payment_vouchers to authenticated;

-- An expense with its category, its vendor's name, what has been paid against
-- it (posted money out), what payments not yet posted hold of it, and how it
-- reads: 'pending', 'rejected', 'approved', or 'paid' once posted money out
-- covers it. method and paid_on are those of the latest posted payment.
create view public.finance_expense_totals with (security_invoker = true) as
select
  e.id,
  e.org_id,
  e.expense_date,
  e.category_id,
  cat.name as category_name,
  e.vendor_id,
  coalesce(c.name, e.vendor_name) as vendor_name,
  e.amount,
  e.sst_amount,
  e.notes,
  e.status,
  e.approved_by,
  e.approved_at,
  e.created_by,
  e.created_at,
  e.updated_at,
  coalesce(p.paid, 0)::numeric(14,2) as paid,
  coalesce(h.held, 0)::numeric(14,2) as held,
  case
    when e.status <> 'approved' then e.status
    when coalesce(p.paid, 0) >= e.amount then 'paid'
    else 'approved'
  end as display_status,
  last.method,
  last.txn_date as paid_on
from public.finance_expenses e
join public.finance_categories cat on cat.org_id = e.org_id and cat.id = e.category_id
left join public.finance_contacts c on c.org_id = e.org_id and c.id = e.vendor_id
left join lateral (
  -- Only posted money out counts as paid.
  select sum(a.amount) as paid
  from public.finance_allocations a
  join public.finance_transactions t on t.org_id = a.org_id and t.id = a.transaction_id
  where a.org_id = e.org_id and a.expense_id = e.id and t.direction = 'out' and t.status = 'posted'
) p on true
left join lateral (
  select sum(a.amount) as held
  from public.finance_allocations a
  join public.finance_transactions t on t.org_id = a.org_id and t.id = a.transaction_id
  where a.org_id = e.org_id and a.expense_id = e.id
    and t.direction = 'out' and t.status in ('draft','pending_approval','scheduled')
) h on true
left join lateral (
  select t.method, t.txn_date
  from public.finance_allocations a
  join public.finance_transactions t on t.org_id = a.org_id and t.id = a.transaction_id
  where a.org_id = e.org_id and a.expense_id = e.id and t.direction = 'out' and t.status = 'posted'
  order by t.txn_date desc, t.created_at desc, t.id
  limit 1
) last on true;
revoke all on public.finance_expense_totals from anon, authenticated;
grant select on public.finance_expense_totals to authenticated;

-- ---- who may approve --------------------------------------------------------
-- An owner or admin of the workspace. A session with no signed-in user is not
-- asked: that is a migration or the SQL editor, which could disable the
-- guards anyway, and it is how the demo seed approves its rows. Neither API
-- role can be in that state and still write: authenticated always carries a
-- user, and anon and service_role have no rights on these tables. Runs as the
-- caller, from inside the guards and functions; the private schema is not
-- reachable through the API.
create or replace function private.finance_may_decide(target_org uuid)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select auth.uid() is null or private.is_org_admin(target_org);
$$;
revoke all on function private.finance_may_decide(uuid) from public, anon;
grant execute on function private.finance_may_decide(uuid) to authenticated;

-- ---- guards -----------------------------------------------------------------
-- Each guard steps aside when its workspace is being deleted: by the time a
-- cascade reaches these rows the orgs row is already gone.

-- An expense starts as pending. While pending it can be edited or deleted by
-- anyone who may write. Approving or rejecting it is a change of status and
-- nothing else, by an owner or admin, and the guard writes down who and when.
-- An approved expense is locked; an owner or admin can still reject it while
-- no payment stands against it. A rejected expense can be deleted, or edited,
-- which puts it back to pending.
create or replace function private.finance_expense_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'approved' and exists (select 1 from public.orgs where id = old.org_id) then
      raise exception 'an approved expense cannot be deleted' using errcode = 'FIN01';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'pending' then
      raise exception 'an expense starts as pending' using errcode = 'FIN01';
    end if;
    new.approved_by := null;
    return new;
  end if;

  -- A deleted user is cleared from these two columns by their foreign keys,
  -- whatever the expense's status. Nothing else may change with it.
  if new.status = old.status
     and (to_jsonb(new) - 'created_by' - 'approved_by') = (to_jsonb(old) - 'created_by' - 'approved_by')
     and (new.created_by is null or new.created_by = old.created_by)
     and (new.approved_by is null or new.approved_by = old.approved_by) then
    return new;
  end if;

  if new.status = old.status then
    if old.status <> 'pending' then
      raise exception 'an expense that has been approved or rejected cannot be changed' using errcode = 'FIN01';
    end if;
    new.approved_by := null;
    return new;
  end if;

  -- Back to pending: only a rejected expense, and it may be edited in the same update.
  if new.status = 'pending' then
    if old.status <> 'rejected' then
      raise exception 'an approved expense does not go back to pending' using errcode = 'FIN01';
    end if;
    new.approved_by := null;
    new.approved_at := null;
    return new;
  end if;

  -- Approved or rejected: the expense is decided as it stands.
  if (to_jsonb(new) - 'status' - 'approved_by' - 'approved_at' - 'updated_at')
     is distinct from (to_jsonb(old) - 'status' - 'approved_by' - 'approved_at' - 'updated_at') then
    raise exception 'an expense is approved or rejected as it stands' using errcode = 'FIN01';
  end if;
  if old.status = 'rejected' then
    raise exception 'a rejected expense is edited before it is decided again' using errcode = 'FIN01';
  end if;
  if not private.finance_may_decide(new.org_id) then
    raise exception 'only an owner or admin approves or rejects an expense' using errcode = 'FIN14';
  end if;
  if old.status = 'approved' and exists (
    select 1
    from public.finance_allocations a
    join public.finance_transactions t on t.org_id = a.org_id and t.id = a.transaction_id
    where a.org_id = old.org_id and a.expense_id = old.id
      and t.status in ('draft','pending_approval','scheduled','posted')
  ) then
    raise exception 'the expense has payments' using errcode = 'FIN02';
  end if;
  if auth.uid() is not null then
    new.approved_by := auth.uid();
    new.approved_at := now();
  else
    new.approved_at := coalesce(new.approved_at, now());
  end if;
  return new;
end $$;

create trigger finance_expense_guard
  before insert or update or delete on public.finance_expenses
  for each row execute function private.finance_expense_guard();

-- A payment is created as a draft, and nobody has approved it yet.
create or replace function private.finance_transaction_insert_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status <> 'draft' then
    raise exception 'a payment starts as a draft' using errcode = 'FIN09';
  end if;
  new.approved_by := null;
  new.approved_at := null;
  return new;
end $$;

create trigger finance_transaction_insert_guard
  before insert on public.finance_transactions
  for each row execute function private.finance_transaction_insert_guard();

-- Replaces the guard on payments. Everything it refused before it refuses the
-- same way, in the same order. The refund checks are the text they were but
-- for one line: the invoices a payment refunds are found by its allocations
-- that name an invoice or a credit note, where the test was "not a bill",
-- which would now take in an expense. The approval rules are new and come
-- last, so a write that was refused before is still refused with the code it
-- had:
--   * A rejected payment is final: it can be deleted and nothing else.
--   * A payment waiting for approval cannot be changed. It is approved, which
--     makes it scheduled, or rejected, by an owner or admin, with nothing else
--     changing in that update; the guard writes down who and when. Only a
--     draft is submitted for approval.
--   * A draft can be rejected by an owner or admin. The app never does; a
--     scheduled payment cannot be.
--   * Money out that settles no document, which is the part of a payment out
--     above its split, needs an owner or admin when the payment becomes
--     scheduled or posted, unless one of them approved it already. A payment
--     to a supplier and a refund are exactly their split, so nothing changes
--     for them.
--   * A scheduled payment that was approved is paid as it was approved: only
--     its status, number and date change, when it is marked paid.
create or replace function private.finance_transaction_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  allocated numeric;
  r record;
  owing numeric;
  note record;
  others numeric;
  mine numeric;
begin
  if tg_op = 'DELETE' then
    if old.status in ('posted','void') and exists (select 1 from public.orgs where id = old.org_id) then
      raise exception 'a posted payment cannot be deleted' using errcode = 'FIN09';
    end if;
    return old;
  end if;

  -- A deleted user is cleared from these two columns by their foreign keys.
  if new.status = old.status
     and (to_jsonb(new) - 'created_by' - 'approved_by') = (to_jsonb(old) - 'created_by' - 'approved_by')
     and (new.created_by is null or new.created_by = old.created_by)
     and (new.approved_by is null or new.approved_by = old.approved_by) then
    return new;
  end if;

  if old.status = 'posted' and new.status = 'void'
     and (to_jsonb(new) - 'status' - 'updated_at') is not distinct from (to_jsonb(old) - 'status' - 'updated_at') then
    return new;
  end if;
  if old.status in ('posted','void') then
    raise exception 'a posted payment cannot be changed' using errcode = 'FIN09';
  end if;
  if new.status = 'void' then
    raise exception 'only a paid payment is voided; delete this one' using errcode = 'FIN09';
  end if;

  -- Not posted yet, so it may still be edited, but not out from under its split.
  if new.direction is distinct from old.direction or new.amount < old.amount then
    select coalesce(sum(a.amount), 0) into allocated
    from public.finance_allocations a
    where a.org_id = old.org_id and a.transaction_id = old.id;
    if allocated > 0 then
      if new.direction is distinct from old.direction then
        raise exception 'a payment that is split cannot change direction' using errcode = 'FIN04';
      end if;
      if new.amount < allocated then
        raise exception 'the split is more than the payment' using errcode = 'FIN03';
      end if;
    end if;
  end if;

  -- A refund being paid out: look again at each credit note and each invoice
  -- it refunds. What this payment itself refunds is added by hand (mine),
  -- and every other sum leaves this payment out, so the answer does not
  -- depend on the status it is coming from. mine is read after the row it is
  -- measured against is locked, never carried over from the loop's query.
  if new.status = 'posted' and new.direction = 'out' then
    for r in
      select a.credit_note_id
      from public.finance_allocations a
      where a.org_id = old.org_id and a.transaction_id = old.id and a.credit_note_id is not null
      group by 1
      order by 1
    loop
      -- Lock the credit note, so it cannot be voided while this is checked.
      select status, amount into note from public.finance_credit_notes
      where org_id = old.org_id and id = r.credit_note_id for update;
      if not found or note.status <> 'issued' then
        raise exception 'a refund can only go against an issued credit note' using errcode = 'FIN04';
      end if;
      -- What this payment refunds against the note, read now that the note is locked.
      select coalesce(sum(a.amount), 0) into mine
      from public.finance_allocations a
      where a.org_id = old.org_id and a.transaction_id = old.id and a.credit_note_id = r.credit_note_id;
      -- Never more than the credit note itself, counting every other refund against it that stands.
      select coalesce(sum(a.amount), 0) into others
      from public.finance_allocations a
      join public.finance_transactions x on x.org_id = a.org_id and x.id = a.transaction_id
      where a.org_id = old.org_id and a.credit_note_id = r.credit_note_id and a.transaction_id <> old.id
        and x.status in ('draft','pending_approval','scheduled','posted');
      if others + mine > note.amount then
        raise exception 'more than the credit note' using errcode = 'FIN05';
      end if;
    end loop;

    for r in
      select coalesce(a.invoice_id, n.invoice_id) as invoice_id
      from public.finance_allocations a
      left join public.finance_credit_notes n on n.org_id = a.org_id and n.id = a.credit_note_id
      where a.org_id = old.org_id and a.transaction_id = old.id
        and (a.invoice_id is not null or a.credit_note_id is not null)
      group by 1
      order by 1
    loop
      -- Lock the invoice, so two refunds paid out at the same moment are checked one after the other.
      perform 1 from public.finance_invoices where org_id = old.org_id and id = r.invoice_id for update;
      -- The balance already has every posted refund in it.
      select balance into owing from public.finance_invoice_totals
      where org_id = old.org_id and id = r.invoice_id;
      -- No figures, no answer: without them the cap below would let anything through.
      if not found then
        raise exception 'a payment can only go against a posted invoice' using errcode = 'FIN04';
      end if;
      -- Refunds of other payments that are waiting to be paid out, against the
      -- invoice itself or against one of its credit notes.
      select
        coalesce((
          select sum(a.amount)
          from public.finance_allocations a
          join public.finance_transactions x on x.org_id = a.org_id and x.id = a.transaction_id
          where a.org_id = old.org_id and a.invoice_id = r.invoice_id and a.transaction_id <> old.id
            and x.direction = 'out' and x.status in ('draft','pending_approval','scheduled')
        ), 0)
        + coalesce((
          select sum(a.amount)
          from public.finance_credit_notes n
          join public.finance_allocations a on a.org_id = n.org_id and a.credit_note_id = n.id
          join public.finance_transactions x on x.org_id = a.org_id and x.id = a.transaction_id
          where n.org_id = old.org_id and n.invoice_id = r.invoice_id and a.transaction_id <> old.id
            and x.direction = 'out' and x.status in ('draft','pending_approval','scheduled')
        ), 0)
      into others;
      -- What this payment refunds on the invoice, against the invoice itself or
      -- against one of its credit notes, read now that the invoice is locked.
      -- The figure the loop started from was read before the lock, and a split
      -- added to this payment in between would be in neither sum.
      select
        coalesce((
          select sum(a.amount)
          from public.finance_allocations a
          where a.org_id = old.org_id and a.transaction_id = old.id and a.invoice_id = r.invoice_id
        ), 0)
        + coalesce((
          select sum(a.amount)
          from public.finance_credit_notes n
          join public.finance_allocations a on a.org_id = n.org_id and a.credit_note_id = n.id
          where n.org_id = old.org_id and n.invoice_id = r.invoice_id and a.transaction_id = old.id
        ), 0)
      into mine;
      if others + mine > greatest(-owing, 0) then
        raise exception 'more than the customer is in credit' using errcode = 'FIN05';
      end if;
    end loop;
  end if;

  -- ---- approval ---------------------------------------------------------------
  if new.status is distinct from old.status then
    if old.status = 'rejected' then
      raise exception 'a rejected payment is deleted, not brought back' using errcode = 'FIN14';
    end if;
    if new.status = 'pending_approval' and old.status <> 'draft' then
      raise exception 'only a draft is submitted for approval' using errcode = 'FIN14';
    end if;
    if old.status = 'pending_approval' and new.status not in ('scheduled','rejected') then
      raise exception 'a payment waiting for approval is approved, rejected or deleted' using errcode = 'FIN14';
    end if;
    if new.status = 'rejected' and old.status not in ('draft','pending_approval') then
      raise exception 'only a payment that has not been approved is rejected' using errcode = 'FIN14';
    end if;
    if old.status = 'scheduled' and old.approved_at is not null then
      if new.status <> 'posted' then
        raise exception 'an approved payment is paid or deleted' using errcode = 'FIN14';
      end if;
      if (to_jsonb(new) - 'status' - 'number' - 'txn_date' - 'updated_at')
         is distinct from (to_jsonb(old) - 'status' - 'number' - 'txn_date' - 'updated_at') then
        raise exception 'an approved payment is paid as it was approved' using errcode = 'FIN14';
      end if;
    end if;

    if new.status = 'rejected' or old.status = 'pending_approval' then
      -- A decision: approved (scheduled) or rejected.
      if not private.finance_may_decide(new.org_id) then
        raise exception 'only an owner or admin approves or rejects a payment' using errcode = 'FIN14';
      end if;
      if old.status = 'pending_approval'
         and (to_jsonb(new) - 'status' - 'approved_by' - 'approved_at' - 'updated_at')
             is distinct from (to_jsonb(old) - 'status' - 'approved_by' - 'approved_at' - 'updated_at') then
        raise exception 'a payment is approved or rejected as it was submitted' using errcode = 'FIN14';
      end if;
      if auth.uid() is not null then
        new.approved_by := auth.uid();
        new.approved_at := now();
      else
        new.approved_at := coalesce(new.approved_at, now());
      end if;
    elsif new.direction = 'out' and new.status in ('scheduled','posted') and old.approved_at is null then
      -- Money out that settles no document: the part of the payment above its
      -- split. Looked at when a draft is scheduled or paid, and again when a
      -- scheduled payment nobody approved is paid, since its amount could
      -- have been raised in between.
      select coalesce(sum(a.amount), 0) into allocated
      from public.finance_allocations a
      where a.org_id = old.org_id and a.transaction_id = old.id;
      if new.amount > allocated then
        if not private.finance_may_decide(new.org_id) then
          raise exception 'money out that settles no document needs an owner or admin' using errcode = 'FIN14';
        end if;
        if auth.uid() is not null then
          new.approved_by := auth.uid();
          new.approved_at := now();
        else
          new.approved_at := coalesce(new.approved_at, now());
        end if;
      end if;
    end if;
  elsif old.status in ('pending_approval','rejected') then
    raise exception 'a payment waiting for approval, or rejected, cannot be changed' using errcode = 'FIN14';
  elsif old.status = 'scheduled' and old.approved_at is not null
        and (to_jsonb(new) - 'updated_at') is distinct from (to_jsonb(old) - 'updated_at') then
    raise exception 'an approved payment is paid as it was approved' using errcode = 'FIN14';
  end if;
  return new;
end $$;

-- Replaces the guard on allocations. A bill, an invoice and a credit note are
-- handled by the same checks in the same order as before. New:
--   * The split of a payment that is waiting for approval, was rejected, or
--     was approved, is locked with it (FIN09), as a posted payment's is.
--   * One payment pays one kind of document: bills, or invoices and credit
--     notes, or expenses (FIN06).
--   * Money out against an expense. The expense must be approved (FIN04), and
--     everything standing against it never exceeds its amount (FIN05). The
--     expense row is locked while this is checked.
create or replace function private.finance_allocation_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  t record;
  has_txn boolean;
  doc_status text;
  doc_total numeric;
  taken numeric;
  note record;
  target_invoice uuid;
  pos record;
  exp record;
begin
  -- The workspace is being deleted: its payments and their splits all go.
  if tg_op = 'DELETE' and not exists (select 1 from public.orgs where id = old.org_id) then
    return old;
  end if;
  if tg_op <> 'INSERT' then
    select status, approved_at into t from public.finance_transactions where org_id = old.org_id and id = old.transaction_id;
    -- No parent row: the payment itself is being deleted.
    if found and (t.status in ('posted','void','pending_approval','rejected') or t.approved_at is not null) then
      raise exception 'the split of a posted payment cannot be changed' using errcode = 'FIN09';
    end if;
    if tg_op = 'DELETE' then return old; end if;
  end if;

  select amount, status, direction, approved_at into t from public.finance_transactions where org_id = new.org_id and id = new.transaction_id;
  has_txn := found;
  if has_txn and (t.status in ('posted','void','pending_approval','rejected') or t.approved_at is not null) then
    raise exception 'the split of a posted payment cannot be changed' using errcode = 'FIN09';
  end if;

  -- A credit note takes only money out. An invoice takes money in (a
  -- payment) or money out (a refund). An expense takes only money out.
  -- Everything else is a bill and takes money out. (A row naming two
  -- documents, or none, is refused by the table's check constraint, which
  -- runs after this trigger.)
  if new.bill_id is null and new.credit_note_id is not null then
    if has_txn and t.direction <> 'out' then
      raise exception 'only money out refunds a credit note' using errcode = 'FIN04';
    end if;
  elsif new.bill_id is null and new.invoice_id is not null then
    null;
  elsif new.bill_id is null and new.expense_id is not null then
    if has_txn and t.direction <> 'out' then
      raise exception 'only money out pays an expense' using errcode = 'FIN04';
    end if;
  else
    if has_txn and t.direction <> 'out' then
      raise exception 'only money out pays a bill' using errcode = 'FIN04';
    end if;
  end if;

  select coalesce(sum(amount), 0) into taken
  from public.finance_allocations
  where org_id = new.org_id and transaction_id = new.transaction_id and id <> new.id;
  if taken + new.amount > t.amount then
    raise exception 'the split is more than the payment' using errcode = 'FIN03';
  end if;

  -- One payment, one kind of document. Without this a payment could be a
  -- payment to a supplier and a refund at once, and show on both screens.
  if exists (
    select 1
    from public.finance_allocations a
    where a.org_id = new.org_id and a.transaction_id = new.transaction_id and a.id <> new.id
      and (case when a.bill_id is not null then 'bill' when a.expense_id is not null then 'expense' else 'sales' end)
          <> (case when new.bill_id is not null then 'bill' when new.expense_id is not null then 'expense' else 'sales' end)
  ) then
    raise exception 'one payment pays one kind of document' using errcode = 'FIN06';
  end if;

  if new.bill_id is null and (new.invoice_id is not null or new.credit_note_id is not null) then
    target_invoice := new.invoice_id;
    if new.credit_note_id is not null then
      -- Lock the credit note, so it cannot be voided while this is checked.
      select invoice_id, status, amount into note from public.finance_credit_notes
      where org_id = new.org_id and id = new.credit_note_id for update;
      if not found or note.status <> 'issued' then
        raise exception 'a refund can only go against an issued credit note' using errcode = 'FIN04';
      end if;
      target_invoice := note.invoice_id;
    end if;

    -- Lock the invoice, so two payments or refunds at the same moment are checked one after the other.
    select status into doc_status from public.finance_invoices
    where org_id = new.org_id and id = target_invoice for update;
    if doc_status is distinct from 'posted' then
      raise exception 'a payment can only go against a posted invoice' using errcode = 'FIN04';
    end if;
    -- total, less posted money in, less issued credit notes, plus posted refunds.
    select balance into pos from public.finance_invoice_totals
    where org_id = new.org_id and id = target_invoice;
    -- No figures, no answer: without them the caps below would let anything through.
    if not found then
      raise exception 'a payment can only go against a posted invoice' using errcode = 'FIN04';
    end if;

    if has_txn and t.direction = 'out' then
      if pos.balance >= 0 then
        raise exception 'only money in pays an invoice; a refund needs the customer to be in credit' using errcode = 'FIN04';
      end if;
      if private.finance_refunds_held(new.org_id, target_invoice, new.id) + new.amount > -pos.balance then
        raise exception 'more than the customer is in credit' using errcode = 'FIN05';
      end if;
      if new.credit_note_id is not null then
        -- Never more than the credit note itself, counting every refund against it that stands.
        select coalesce(sum(a.amount), 0) into taken
        from public.finance_allocations a
        join public.finance_transactions x on x.org_id = a.org_id and x.id = a.transaction_id
        where a.org_id = new.org_id and a.credit_note_id = new.credit_note_id and a.id <> new.id
          and x.status in ('draft','pending_approval','scheduled','posted');
        if taken + new.amount > note.amount then
          raise exception 'more than the credit note' using errcode = 'FIN05';
        end if;
      end if;
      return new;
    end if;

    -- Money in. Payments that are not posted yet hold their part of the balance.
    select coalesce(sum(a.amount), 0) into taken
    from public.finance_allocations a
    join public.finance_transactions x on x.org_id = a.org_id and x.id = a.transaction_id
    where a.org_id = new.org_id and a.invoice_id = target_invoice and a.id <> new.id
      and x.direction = 'in' and x.status in ('draft','pending_approval','scheduled');
    if taken + new.amount > pos.balance then
      raise exception 'more than is still owed on the invoice' using errcode = 'FIN05';
    end if;
    return new;
  end if;

  if new.bill_id is null and new.expense_id is not null then
    -- Lock the expense, so two payments at the same moment are checked one
    -- after the other and it cannot be rejected while this is checked.
    select status, amount into exp from public.finance_expenses
    where org_id = new.org_id and id = new.expense_id for update;
    if not found or exp.status <> 'approved' then
      raise exception 'a payment can only go against an approved expense' using errcode = 'FIN04';
    end if;
    select coalesce(sum(a.amount), 0) into taken
    from public.finance_allocations a
    join public.finance_transactions x on x.org_id = a.org_id and x.id = a.transaction_id
    where a.org_id = new.org_id and a.expense_id = new.expense_id and a.id <> new.id
      and x.status in ('draft','pending_approval','scheduled','posted');
    if taken + new.amount > exp.amount then
      raise exception 'more than is still to pay on the expense' using errcode = 'FIN05';
    end if;
    return new;
  end if;

  -- Lock the bill, so two payments at the same moment are checked one after the other.
  select status into doc_status from public.supplier_bills
  where org_id = new.org_id and id = new.bill_id for update;
  if doc_status is distinct from 'posted' then
    raise exception 'a payment can only go against a posted bill' using errcode = 'FIN04';
  end if;

  select coalesce(sum(amount + sst_amount), 0) into doc_total
  from public.supplier_bill_lines where org_id = new.org_id and bill_id = new.bill_id;
  select coalesce(sum(a.amount), 0) into taken
  from public.finance_allocations a
  join public.finance_transactions x on x.org_id = a.org_id and x.id = a.transaction_id
  where a.org_id = new.org_id and a.bill_id = new.bill_id and a.id <> new.id
    and x.status in ('draft','pending_approval','scheduled','posted');
  if taken + new.amount > doc_total then
    raise exception 'more than is still owed on the bill' using errcode = 'FIN05';
  end if;
  return new;
end $$;

revoke all on function private.finance_expense_guard() from public, anon, authenticated;
revoke all on function private.finance_transaction_insert_guard() from public, anon, authenticated;
revoke all on function private.finance_transaction_guard() from public, anon, authenticated;
revoke all on function private.finance_allocation_guard() from public, anon, authenticated;

-- ---- functions --------------------------------------------------------------
-- All run as the caller, so RLS decides who may write and to which workspace.

-- Turns a scheduled payment out into a paid one and returns its number. The
-- text it had, with one check added: money in is never scheduled and is never
-- given a PV- number.
create or replace function public.finance_mark_payment_paid(target_org uuid, target_txn uuid, paid_on date)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  t record;
  no text;
begin
  select status, number, direction into t from public.finance_transactions
  where org_id = target_org and id = target_txn for update;
  if not found then
    raise exception 'the payment no longer exists' using errcode = 'FIN11';
  end if;
  if t.status <> 'scheduled' then
    raise exception 'only a scheduled payment can be marked paid' using errcode = 'FIN09';
  end if;
  if t.direction <> 'out' then
    raise exception 'only money out is marked paid' using errcode = 'FIN09';
  end if;
  no := coalesce(t.number, public.finance_next_number(target_org, 'voucher'));
  update public.finance_transactions
     set status = 'posted', number = no, txn_date = coalesce(paid_on, current_date), updated_at = now()
   where org_id = target_org and id = target_txn;
  return no;
end $$;

-- Creates a draft cash receipt, or replaces a draft's details and split.
-- Returns its id. A receipt is for one customer's posted invoices, in which
-- case its amount is the sum of its split and the customer is the payer, or
-- it is for an income category, with an amount and a payer who is a contact
-- or a typed name. While it is a draft, what it is split across is held: the
-- guard on allocations counts it against each invoice.
create or replace function public.finance_save_cash_receipt(target_org uuid, receipt jsonb, allocations jsonb)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  tid uuid := nullif(receipt->>'id', '')::uuid;
  cat uuid := nullif(receipt->>'category_id', '')::uuid;
  payer uuid := nullif(receipt->>'contact_id', '')::uuid;
  payer_name text := nullif(receipt->>'party_name', '');
  has_split boolean := case when jsonb_typeof(allocations) = 'array' then jsonb_array_length(allocations) > 0 else false end;
  total numeric;
  customers uuid[];
  current_status text;
begin
  if has_split then
    if cat is not null then
      raise exception 'a receipt is for invoices or for a category, not both' using errcode = 'FIN15';
    end if;
    -- Each amount is rounded to the sen before it is added, as each allocation
    -- is when it is stored, so the receipt is exactly the sum of its split.
    select coalesce(sum(round((a->>'amount')::numeric, 2)), 0) into total from jsonb_array_elements(allocations) as a;
    select array_agg(distinct i.customer_id) into customers
    from jsonb_array_elements(allocations) as a
    join public.finance_invoices i on i.org_id = target_org and i.id = (a->>'invoice_id')::uuid;
    if customers is null or array_length(customers, 1) <> 1 then
      raise exception 'one receipt is from one customer' using errcode = 'FIN06';
    end if;
    payer := customers[1];
    payer_name := null;
  else
    if cat is null or not exists (
      select 1 from public.finance_categories where org_id = target_org and id = cat and kind = 'income'
    ) then
      raise exception 'a receipt names invoices or an income category' using errcode = 'FIN15';
    end if;
    total := round((receipt->>'amount')::numeric, 2);
  end if;

  if tid is null then
    insert into public.finance_transactions
      (org_id, direction, account_id, txn_date, amount, method, reference, contact_id, party_name, category_id, notes, status)
    values (
      target_org, 'in',
      (receipt->>'account_id')::uuid,
      coalesce((receipt->>'txn_date')::date, current_date),
      total,
      receipt->>'method',
      nullif(receipt->>'reference', ''),
      payer,
      payer_name,
      cat,
      nullif(receipt->>'notes', ''),
      'draft'
    )
    returning id into tid;
  else
    select status into current_status from public.finance_transactions
    where org_id = target_org and id = tid and direction = 'in' for update;
    if not found then
      raise exception 'the receipt no longer exists' using errcode = 'FIN11';
    end if;
    if current_status <> 'draft' then
      raise exception 'a posted receipt cannot be changed' using errcode = 'FIN09';
    end if;
    -- The old split goes first, so the new amount is never below it.
    delete from public.finance_allocations where org_id = target_org and transaction_id = tid;
    update public.finance_transactions
       set account_id = (receipt->>'account_id')::uuid,
           txn_date = coalesce((receipt->>'txn_date')::date, current_date),
           amount = total,
           method = receipt->>'method',
           reference = nullif(receipt->>'reference', ''),
           contact_id = payer,
           party_name = payer_name,
           category_id = cat,
           notes = nullif(receipt->>'notes', ''),
           updated_at = now()
     where org_id = target_org and id = tid;
  end if;

  if has_split then
    -- In id order, so two receipts that share invoices lock them in the same order.
    insert into public.finance_allocations (org_id, transaction_id, invoice_id, amount)
    select target_org, tid, (a->>'invoice_id')::uuid, (a->>'amount')::numeric
    from jsonb_array_elements(allocations) as a
    order by (a->>'invoice_id')::uuid;
  end if;
  return tid;
end $$;

-- Posts a draft cash receipt and returns its RC- number. The number is taken
-- here, so a failed post does not use one up.
create or replace function public.finance_post_cash_receipt(target_org uuid, target_txn uuid)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  t record;
  allocated numeric;
  no text;
begin
  select status, number, amount, category_id into t from public.finance_transactions
  where org_id = target_org and id = target_txn and direction = 'in' for update;
  if not found then
    raise exception 'the receipt no longer exists' using errcode = 'FIN11';
  end if;
  if t.status <> 'draft' then
    raise exception 'the receipt is already posted' using errcode = 'FIN09';
  end if;
  select coalesce(sum(a.amount), 0) into allocated
  from public.finance_allocations a
  where a.org_id = target_org and a.transaction_id = target_txn;
  if allocated > 0 then
    if allocated <> t.amount or t.category_id is not null then
      raise exception 'a receipt for invoices is exactly its split, with no category' using errcode = 'FIN15';
    end if;
  elsif t.category_id is null then
    raise exception 'a receipt names invoices or an income category' using errcode = 'FIN15';
  end if;

  no := coalesce(t.number, public.finance_next_number(target_org, 'receipt'));
  update public.finance_transactions
     set status = 'posted', number = no, updated_at = now()
   where org_id = target_org and id = target_txn;
  return no;
end $$;

-- Records one payment voucher: money out that pays approved expenses, or
-- money out that settles no document and carries an expense category. A
-- payment to a supplier is finance_record_payment_out and a refund is
-- finance_record_refund; neither is recorded here. voucher.status is 'posted'
-- (paid now, numbered PV-) or 'scheduled' (to be paid). Returns its id.
--
-- A voucher for approved expenses needs no second approval: it is recorded as
-- asked. A voucher that settles no document is recorded as asked when an
-- owner or admin records it; from anyone else it waits as pending_approval,
-- whatever was asked, and once approved it is scheduled and is paid by
-- finance_mark_payment_paid.
create or replace function public.finance_record_voucher(target_org uuid, voucher jsonb, allocations jsonb)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  tid uuid;
  cat uuid := nullif(voucher->>'category_id', '')::uuid;
  has_split boolean := case when jsonb_typeof(allocations) = 'array' then jsonb_array_length(allocations) > 0 else false end;
  total numeric;
  found_expenses integer;
  want text := coalesce(voucher->>'status', 'posted');
  no text;
begin
  if want not in ('posted','scheduled') then
    raise exception 'unknown voucher status %', want using errcode = '22023';
  end if;
  if has_split then
    if cat is not null then
      raise exception 'a voucher is for expenses or for a category, not both' using errcode = 'FIN15';
    end if;
    select coalesce(sum(round((a->>'amount')::numeric, 2)), 0) into total from jsonb_array_elements(allocations) as a;
    select count(*) into found_expenses
    from jsonb_array_elements(allocations) as a
    join public.finance_expenses e on e.org_id = target_org and e.id = (a->>'expense_id')::uuid;
    if found_expenses <> jsonb_array_length(allocations) then
      raise exception 'no expense was chosen or found' using errcode = 'FIN06';
    end if;
  else
    if cat is null or not exists (
      select 1 from public.finance_categories where org_id = target_org and id = cat and kind = 'expense'
    ) then
      raise exception 'a voucher names expenses or an expense category' using errcode = 'FIN15';
    end if;
    total := round((voucher->>'amount')::numeric, 2);
  end if;

  insert into public.finance_transactions
    (org_id, direction, account_id, txn_date, amount, method, reference, contact_id, party_name, category_id, notes, status)
  values (
    target_org, 'out',
    (voucher->>'account_id')::uuid,
    coalesce((voucher->>'txn_date')::date, current_date),
    total,
    voucher->>'method',
    nullif(voucher->>'reference', ''),
    nullif(voucher->>'contact_id', '')::uuid,
    nullif(voucher->>'party_name', ''),
    cat,
    nullif(voucher->>'notes', ''),
    'draft'
  )
  returning id into tid;

  if has_split then
    -- In id order, so two vouchers that share expenses lock them in the same order.
    insert into public.finance_allocations (org_id, transaction_id, expense_id, amount)
    select target_org, tid, (a->>'expense_id')::uuid, (a->>'amount')::numeric
    from jsonb_array_elements(allocations) as a
    order by (a->>'expense_id')::uuid;
  elsif not private.finance_may_decide(target_org) then
    update public.finance_transactions
       set status = 'pending_approval', updated_at = now()
     where org_id = target_org and id = tid;
    return tid;
  end if;

  if want = 'posted' then
    no := public.finance_next_number(target_org, 'voucher');
  end if;
  update public.finance_transactions
     set status = want, number = no, updated_at = now()
   where org_id = target_org and id = tid;
  return tid;
end $$;

-- Creates an expense, or changes one that is pending or was rejected (which
-- puts it back to pending). Returns its id. Saved by an owner or admin it is
-- approved in the same call; saved by anyone else it waits as pending.
-- expense has id (to change one), expense_date, category_id, vendor_id or
-- vendor_name, amount, sst_amount, notes.
create or replace function public.finance_save_expense(target_org uuid, expense jsonb)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  eid uuid := nullif(expense->>'id', '')::uuid;
  cat uuid := nullif(expense->>'category_id', '')::uuid;
  n integer;
begin
  if cat is null or not exists (
    select 1 from public.finance_categories where org_id = target_org and id = cat and kind = 'expense'
  ) then
    raise exception 'an expense names an expense category' using errcode = 'FIN15';
  end if;

  if eid is null then
    insert into public.finance_expenses
      (org_id, expense_date, category_id, vendor_id, vendor_name, amount, sst_amount, notes, status)
    values (
      target_org,
      coalesce((expense->>'expense_date')::date, current_date),
      cat,
      nullif(expense->>'vendor_id', '')::uuid,
      nullif(expense->>'vendor_name', ''),
      (expense->>'amount')::numeric,
      coalesce((expense->>'sst_amount')::numeric, 0),
      nullif(expense->>'notes', ''),
      'pending'
    )
    returning id into eid;
  else
    update public.finance_expenses
       set expense_date = coalesce((expense->>'expense_date')::date, current_date),
           category_id = cat,
           vendor_id = nullif(expense->>'vendor_id', '')::uuid,
           vendor_name = nullif(expense->>'vendor_name', ''),
           amount = (expense->>'amount')::numeric,
           sst_amount = coalesce((expense->>'sst_amount')::numeric, 0),
           notes = nullif(expense->>'notes', ''),
           status = 'pending',
           updated_at = now()
     where org_id = target_org and id = eid;
    get diagnostics n = row_count;
    if n = 0 then
      raise exception 'the expense no longer exists' using errcode = 'FIN11';
    end if;
  end if;

  if private.is_org_admin(target_org) then
    update public.finance_expenses
       set status = 'approved', updated_at = now()
     where org_id = target_org and id = eid;
  end if;
  return eid;
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.finance_mark_payment_paid(uuid, uuid, date)',
    'public.finance_save_cash_receipt(uuid, jsonb, jsonb)',
    'public.finance_post_cash_receipt(uuid, uuid)',
    'public.finance_record_voucher(uuid, jsonb, jsonb)',
    'public.finance_save_expense(uuid, jsonb)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
```

- [ ] **Step 5: Write the seed migration**

Create `supabase/migrations/20261028100100_bendahara_cash_book_seed.sql`:

```sql
-- Demo data for Bendahara Cash Receipts, Payment Vouchers and Expenses in the
-- shared demo org, built from what the three mock-up screens showed. Dates
-- are relative to today. Skips when the demo org is missing or already has an
-- expense, and touches no other workspace.
--
-- Nothing is disabled: every row goes in the way the guards allow. An expense
-- is inserted as pending and then approved or rejected. A payment is inserted
-- as a draft, split against its expense where it pays one, and then posted
-- with its number, scheduled, or sent for approval and decided. A migration
-- has no signed-in user, which is the one case the approval rules do not ask
-- for an owner or admin (private.finance_may_decide), so approved_by stays
-- empty on these rows. The functions are not used because they take their
-- numbers from finance_next_number, which answers only to a signed-in editor
-- of the workspace.
--
-- Nothing here is put against an invoice or a bill, so Invoices, Payments In,
-- Refunds, Supplier Bills and Payments Out read exactly as they did. The
-- demo's payments to suppliers, refunds and payments in also show on Payment
-- Vouchers and Cash Receipts, which list every movement of money.

do $$
declare
  demo uuid;
  bank uuid;
  cash uuid;
  cat uuid;
  payer uuid;
  eid uuid;
  txn uuid;
  pv integer;
  rc integer;
  r record;
begin
  select id into demo from public.orgs where slug = 'rimba-ventures-demo';
  if demo is null or exists (select 1 from public.finance_expenses where org_id = demo) then
    return;
  end if;

  -- The accounts and categories every workspace starts with. Seeding them again changes nothing if they are there.
  perform private.finance_seed_accounts(demo);
  perform private.finance_seed_categories(demo);
  select id into bank from public.finance_accounts
   where org_id = demo and kind = 'bank'
   order by (lower(name) = 'main bank') desc, created_at, id limit 1;
  select id into cash from public.finance_accounts
   where org_id = demo and kind = 'cash'
   order by (lower(name) = 'cash in hand') desc, created_at, id limit 1;
  cash := coalesce(cash, bank);
  bank := coalesce(bank, cash);
  if bank is null then
    raise exception 'the demo org has no account for its cash book';
  end if;

  -- Vouchers and receipts are numbered after any the demo already has.
  select greatest(
           coalesce((select next_number from public.finance_sequences where org_id = demo and doc_type = 'voucher'), 1),
           coalesce((select max(substring(number from '^PV-([0-9]{1,9})$')::integer) + 1
                       from public.finance_transactions where org_id = demo and number ~ '^PV-[0-9]{1,9}$'), 1))
    into pv;
  select greatest(
           coalesce((select next_number from public.finance_sequences where org_id = demo and doc_type = 'receipt'), 1),
           coalesce((select max(substring(number from '^RC-([0-9]{1,9})$')::integer) + 1
                       from public.finance_transactions where org_id = demo and number ~ '^RC-[0-9]{1,9}$'), 1))
    into rc;

  -- ---- expenses: pending, then decided; a paid one gets its payment voucher ---
  -- paid_with is null for an expense that has not been paid. An expense is
  -- paid on the day it is dated.
  for r in
    select * from (values
      ( 1, 'Marketing', 'Billboard Kuala Lumpur',    3600::numeric,  0::numeric, 'pending',  null),
      ( 2, 'Rent',      'Menara Axis Management',    4500,           0,          'approved', 'bank_transfer'),
      ( 3, 'Utilities', 'Suria Utilities Sdn Bhd',   1280,           0,          'approved', 'fpx'),
      ( 4, 'Marketing', 'Meta Ads Malaysia',         2200,           0,          'pending',  null),
      ( 5, 'Travel',    'Grab Malaysia',              186,           0,          'approved', 'ewallet'),
      ( 6, 'Supplies',  'Printhub Solutions',         640,           0,          'approved', 'cash'),
      ( 7, 'Salaries',  'Payroll, September',        8900,           0,          'approved', 'bank_transfer'),
      ( 8, 'Utilities', 'Unifi Business',              94,           5.32,       'approved', 'card'),
      ( 9, 'Travel',    'AirAsia',                    420,           0,          'rejected', null),
      (10, 'Services',  'Syarikat Guaman Lee',       1500,           0,          'approved', null),
      -- Earlier months, so the trend chart has a shape.
      ( 38, 'Rent',      'Menara Axis Management',   4500,           0,          'approved', 'bank_transfer'),
      ( 40, 'Salaries',  'Payroll, August',          8700,           0,          'approved', 'bank_transfer'),
      ( 45, 'Marketing', 'Meta Ads Malaysia',        1900,           0,          'approved', 'card'),
      ( 69, 'Rent',      'Menara Axis Management',   4500,           0,          'approved', 'bank_transfer'),
      ( 70, 'Salaries',  'Payroll, July',            8700,           0,          'approved', 'bank_transfer'),
      ( 75, 'Utilities', 'Suria Utilities Sdn Bhd',  1310,           0,          'approved', 'fpx'),
      (100, 'Rent',      'Menara Axis Management',   4500,           0,          'approved', 'bank_transfer'),
      (101, 'Salaries',  'Payroll, June',            8500,           0,          'approved', 'bank_transfer'),
      (130, 'Rent',      'Menara Axis Management',   4500,           0,          'approved', 'bank_transfer'),
      (131, 'Salaries',  'Payroll, May',             8500,           0,          'approved', 'bank_transfer'),
      (161, 'Rent',      'Menara Axis Management',   4500,           0,          'approved', 'bank_transfer'),
      (162, 'Salaries',  'Payroll, April',           8300,           0,          'approved', 'bank_transfer'),
      (190, 'Marketing', 'Meta Ads Malaysia',        2400,           0,          'approved', 'card')
    ) as v(days_ago, category, vendor, amount, sst, status, paid_with)
  loop
    select id into cat from public.finance_categories
     where org_id = demo and kind = 'expense' and name = r.category;

    insert into public.finance_expenses (org_id, expense_date, category_id, vendor_name, amount, sst_amount, status)
    values (demo, current_date - r.days_ago, cat, r.vendor, r.amount, r.sst, 'pending')
    returning id into eid;
    if r.status <> 'pending' then
      update public.finance_expenses
         set status = r.status, approved_at = now() - make_interval(days => r.days_ago), updated_at = now()
       where id = eid;
    end if;

    if r.paid_with is not null then
      insert into public.finance_transactions
        (org_id, direction, account_id, txn_date, amount, method, party_name, status)
      values (
        demo, 'out',
        case when r.paid_with = 'cash' then cash else bank end,
        current_date - r.days_ago, r.amount, r.paid_with, r.vendor, 'draft'
      )
      returning id into txn;
      insert into public.finance_allocations (org_id, transaction_id, expense_id, amount)
      values (demo, txn, eid, r.amount);
      update public.finance_transactions
         set status = 'posted', number = 'PV-' || lpad(pv::text, greatest(4, length(pv::text)), '0'), updated_at = now()
       where id = txn;
      pv := pv + 1;
    end if;
  end loop;

  -- ---- vouchers that settle no document: a draft, then where it got to --------
  for r in
    select * from (values
      ( 0, 'Tenaga Nasional Berhad',      'Utilities', 'bank_transfer', 960::numeric, 'scheduled'),
      ( 1, 'Syarikat Ramli & Anak',       'Rent',      'bank_transfer', 2200,         'pending_approval'),
      ( 4, 'Kurier Pantas Sdn Bhd',       'Services',  'bank_transfer', 2140,         'pending_approval'),
      ( 6, 'Syabas Air Selangor',         'Utilities', 'fpx',            420,         'posted'),
      ( 9, 'Majlis Bandaraya Shah Alam',  'Services',  'cash',           380,         'posted'),
      (12, 'Kedai Alat Tulis Maju',       'Supplies',  'cash',            75,         'rejected')
    ) as v(days_ago, payee, category, method, amount, status)
  loop
    select id into cat from public.finance_categories
     where org_id = demo and kind = 'expense' and name = r.category;

    insert into public.finance_transactions
      (org_id, direction, account_id, txn_date, amount, method, party_name, category_id, status)
    values (
      demo, 'out',
      case when r.method = 'cash' then cash else bank end,
      current_date - r.days_ago, r.amount, r.method, r.payee, cat, 'draft'
    )
    returning id into txn;

    if r.status = 'posted' then
      update public.finance_transactions
         set status = 'posted', number = 'PV-' || lpad(pv::text, greatest(4, length(pv::text)), '0'),
             approved_at = now() - make_interval(days => r.days_ago), updated_at = now()
       where id = txn;
      pv := pv + 1;
    elsif r.status = 'scheduled' then
      update public.finance_transactions
         set status = 'scheduled', approved_at = now(), updated_at = now()
       where id = txn;
    else
      update public.finance_transactions set status = 'pending_approval', updated_at = now() where id = txn;
      if r.status = 'rejected' then
        update public.finance_transactions
           set status = 'rejected', approved_at = now() - make_interval(days => r.days_ago), updated_at = now()
         where id = txn;
      end if;
    end if;
  end loop;

  -- ---- receipts for income that settles no invoice: a draft, then posted ------
  -- A payer who is one of the demo's contacts is tied to that contact; anyone
  -- else is a typed name.
  for r in
    select * from (values
      ( 0, 'Langkawi Fresh',          'cheque',        'Sales',        2180::numeric, 'draft'),
      ( 1, 'Kedai Runcit Pak Din',    'cash',          'Sales',         850,          'posted'),
      ( 4, 'Mei Ling Bakery',         'cash',          'Sales',         900,          'posted'),
      ( 6, 'Tan & Sons Enterprise',   'duitnow',       'Sales',        1200,          'posted'),
      (11, 'Bank Islam, profit paid', 'bank_transfer', 'Other income',   64.20,       'posted'),
      (40, 'Kedai Runcit Pak Din',    'cash',          'Sales',         780,          'posted'),
      (72, 'Mei Ling Bakery',         'cash',          'Sales',         650,          'posted')
    ) as v(days_ago, payer, method, category, amount, status)
  loop
    select id into cat from public.finance_categories
     where org_id = demo and kind = 'income' and name = r.category;
    payer := null;
    select id into payer from public.finance_contacts
     where org_id = demo and name = r.payer
     order by created_at, id limit 1;

    insert into public.finance_transactions
      (org_id, direction, account_id, txn_date, amount, method, contact_id, party_name, category_id, status)
    values (
      demo, 'in',
      case when r.method = 'cash' then cash else bank end,
      current_date - r.days_ago, r.amount, r.method,
      payer, case when payer is null then r.payer end, cat, 'draft'
    )
    returning id into txn;
    if r.status = 'posted' then
      update public.finance_transactions
         set status = 'posted', number = 'RC-' || lpad(rc::text, greatest(4, length(rc::text)), '0'), updated_at = now()
       where id = txn;
      rc := rc + 1;
    end if;
  end loop;

  -- The demo's counters start after the numbers used above.
  insert into public.finance_sequences (org_id, doc_type, prefix, next_number)
  values (demo, 'voucher', 'PV-', pv), (demo, 'receipt', 'RC-', rc)
  on conflict (org_id, doc_type)
    do update set next_number = greatest(public.finance_sequences.next_number, excluded.next_number);
end $$;
```

- [ ] **Step 6: Write the check script**

Create `supabase/tests/bendahara_cash_book_check.sql`:

```sql
-- Bendahara cash book check. Run it after
-- 20261028100000_bendahara_cash_book.sql, in the same transaction for a dry
-- run, or by itself once the migration is applied. It goes through expenses,
-- payment vouchers, cash receipts and the approval rules as an owner, an
-- editor, a viewer and an outsider, and checks that the two cash book views
-- list every movement of money once. The invoice, bill, quotation, credit
-- note and refund flows are the business of bendahara_followons_check.sql and
-- bendahara_invoices_check.sql, which must still pass beside this one. It
-- leaves nothing behind either way: the block always ends with RAISE, so
-- every row and the helper function below are rolled back. Read the message:
--   BENDAHARA_CASH_BOOK_CHECK PASSED ...   or   BENDAHARA_CASH_BOOK_CHECK FAILED: <what went wrong>
-- It makes its own workspace and acts as each person the way the app does:
-- the authenticated role with that person's id in request.jwt.claims.
do $$
declare
  org uuid := gen_random_uuid();
  other_org uuid := gen_random_uuid();
  owner_id uuid := gen_random_uuid();
  editor_id uuid := gen_random_uuid();
  viewer_id uuid := gen_random_uuid();
  outsider uuid := gen_random_uuid();
  owner_claims text;
  editor_claims text;
  bank uuid;
  till uuid;
  rent uuid;
  utilities uuid;
  sales uuid;
  cust uuid;
  cust2 uuid;
  sup uuid;
  inv uuid;
  inv2 uuid;
  inv3 uuid;
  bill1 uuid;
  bill2 uuid;
  cn uuid;
  ex1 uuid;
  ex2 uuid;
  ex3 uuid;
  ex4 uuid;
  theirs uuid;
  p1 uuid;
  p2 uuid;
  v1 uuid;
  v2 uuid;
  v3 uuid;
  v4 uuid;
  v5 uuid;
  r1 uuid;
  r2 uuid;
  r3 uuid;
  cn2 uuid;
  pay uuid;
  rf uuid;
  stray uuid;
  no text;
  n integer;
  m integer;
  t text;
  r record;
  one_line jsonb := '[{"description":"Check","quantity":10,"unit_price":12.5,"sst_rate":6}]';
  fails text[] := '{}';
  notes text[] := '{}';
begin
  -- ---- a helper, rolled back with everything else -------------------------
  -- Runs one statement as whoever is acting and answers null when it ended
  -- the expected way ('ok' or a SQLSTATE), or a sentence for the report.
  execute $f$
    create function public.bendahara_check_try(label text, want text, q text) returns text
    language plpgsql security invoker set search_path = '' as $g$
    declare got text := 'ok';
    begin
      begin
        execute q;
      exception when others then
        got := sqlstate;
      end;
      if got = want then return null; end if;
      return format('%s: expected %s, got %s', label, want, got);
    end $g$
  $f$;
  execute 'grant execute on function public.bendahara_check_try(text, text, text) to authenticated';

  -- ---- structure ------------------------------------------------------------
  select count(*) into n from pg_policies where schemaname = 'public' and tablename = 'finance_expenses';
  if n <> 5 then fails := fails || format('expected 5 policies on finance_expenses, found %s', n); end if;
  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename = 'finance_expenses' and policyname = 'mfa_required' and permissive = 'RESTRICTIVE';
  if n <> 1 then fails := array_append(fails, 'finance_expenses has no restrictive mfa_required policy'); end if;
  select count(*) into n from pg_class c join pg_namespace s on s.oid = c.relnamespace
   where s.nspname = 'public' and c.relname = 'finance_expenses' and c.relrowsecurity;
  if n <> 1 then fails := array_append(fails, 'row-level security is not enabled on finance_expenses'); end if;
  select count(*) into n from pg_class c join pg_namespace s on s.oid = c.relnamespace
   where s.nspname = 'public'
     and c.relname in ('finance_cash_receipts','finance_payment_vouchers','finance_expense_totals',
                       'finance_invoice_totals','finance_payments_in','finance_payments_out','supplier_bill_totals',
                       'finance_quotation_totals','finance_credit_note_totals','finance_refunds')
     and c.reloptions::text ilike '%security_invoker=true%';
  if n <> 10 then fails := fails || format('expected 10 security_invoker views, found %s', n); end if;
  select string_agg(conname, ',' order by conname) into t from pg_constraint
   where conrelid = 'public.finance_allocations'::regclass and contype = 'c';
  if t is distinct from 'finance_allocations_amount_check,finance_allocations_one_document_check,finance_allocations_reason_check' then
    fails := fails || format('check constraints on finance_allocations are: %s', t);
  end if;
  select pg_get_constraintdef(oid) into t from pg_constraint
   where conrelid = 'public.finance_allocations'::regclass and conname = 'finance_allocations_one_document_check';
  if t is null or t not ilike '%bill_id, invoice_id, credit_note_id, expense_id%' then
    fails := fails || format('an allocation names one document of: %s', t);
  end if;
  select string_agg(attname, ',' order by attnum) into t from pg_attribute
   where attrelid = 'public.finance_cash_receipts'::regclass and attnum > 0 and not attisdropped;
  if t is distinct from 'transaction_id,org_id,number,txn_date,method,amount,status,reference,notes,account_id,account_name,'
       || 'account_kind,contact_id,party_name,kind,category_id,category_name,documents,created_by,created_at' then
    fails := fails || format('finance_cash_receipts has the columns: %s', t);
  end if;
  select string_agg(attname, ',' order by attnum) into t from pg_attribute
   where attrelid = 'public.finance_payment_vouchers'::regclass and attnum > 0 and not attisdropped;
  if t is distinct from 'transaction_id,org_id,number,txn_date,method,amount,status,reference,notes,account_id,account_name,'
       || 'account_kind,contact_id,party_name,kind,category_id,category_name,documents,approved_at,created_by,created_at' then
    fails := fails || format('finance_payment_vouchers has the columns: %s', t);
  end if;
  select string_agg(attname, ',' order by attnum) into t from pg_attribute
   where attrelid = 'public.finance_expense_totals'::regclass and attnum > 0 and not attisdropped;
  if t is distinct from 'id,org_id,expense_date,category_id,category_name,vendor_id,vendor_name,amount,sst_amount,notes,status,'
       || 'approved_by,approved_at,created_by,created_at,updated_at,paid,held,display_status,method,paid_on' then
    fails := fails || format('finance_expense_totals has the columns: %s', t);
  end if;
  foreach t in array array[
    'public.finance_mark_payment_paid(uuid, uuid, date)',
    'public.finance_save_cash_receipt(uuid, jsonb, jsonb)',
    'public.finance_post_cash_receipt(uuid, uuid)',
    'public.finance_record_voucher(uuid, jsonb, jsonb)',
    'public.finance_save_expense(uuid, jsonb)',
    'public.finance_record_payment_out(uuid, jsonb, jsonb)',
    'public.finance_record_payment_in(uuid, jsonb, jsonb)',
    'public.finance_record_refund(uuid, jsonb)',
    'private.finance_may_decide(uuid)'
  ] loop
    if has_function_privilege('anon', t, 'execute') then fails := fails || format('anon can execute %s', t); end if;
    if not has_function_privilege('authenticated', t, 'execute') then fails := fails || format('authenticated cannot execute %s', t); end if;
  end loop;
  foreach t in array array[
    'private.finance_expense_guard()', 'private.finance_transaction_insert_guard()',
    'private.finance_transaction_guard()', 'private.finance_allocation_guard()'
  ] loop
    if has_function_privilege('authenticated', t, 'execute') or has_function_privilege('anon', t, 'execute') then
      fails := fails || format('a guard can be called directly: %s', t);
    end if;
  end loop;
  foreach t in array array['finance_expenses','finance_cash_receipts','finance_payment_vouchers','finance_expense_totals'] loop
    if has_table_privilege('anon', 'public.' || t, 'select') then fails := fails || format('anon can read %s', t); end if;
    if not has_table_privilege('authenticated', 'public.' || t, 'select') then fails := fails || format('authenticated cannot read %s', t); end if;
    if has_table_privilege('service_role', 'public.' || t, 'select') then fails := fails || format('service_role was granted %s', t); end if;
  end loop;
  if has_table_privilege('service_role', 'public.finance_expenses', 'insert')
     or has_table_privilege('service_role', 'public.finance_expenses', 'update')
     or has_table_privilege('service_role', 'public.finance_expenses', 'delete') then
    fails := array_append(fails, 'service_role can write finance_expenses');
  end if;
  select count(*) into n from pg_trigger
   where not tgisinternal
     and ((tgrelid = 'public.finance_expenses'::regclass and tgname = 'finance_expense_guard')
       or (tgrelid = 'public.finance_transactions'::regclass and tgname in ('finance_transaction_guard','finance_transaction_insert_guard'))
       or (tgrelid = 'public.finance_allocations'::regclass and tgname = 'finance_allocation_guard'));
  if n <> 4 then fails := fails || format('expected 4 guard triggers, found %s', n); end if;

  -- ---- people and two workspaces -------------------------------------------
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_anonymous)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    u.id || '@cash-book-check.openkuasa-test.dev', '', now(), now(), now(), '{}'::jsonb, '{}'::jsonb, false
  from unnest(array[owner_id, editor_id, viewer_id, outsider]) as u(id);

  -- The trigger on orgs gives each workspace its accounts and categories.
  insert into public.orgs (id, name) values (org, 'Cash Book Check Sdn Bhd'), (other_org, 'Cash Book Other Sdn Bhd');
  insert into public.org_members (org_id, user_id, role)
  values (org, owner_id, 'owner'), (org, editor_id, 'member'), (org, viewer_id, 'viewer'), (other_org, outsider, 'owner');
  select id into bank from public.finance_accounts where org_id = org and kind = 'bank' order by created_at limit 1;
  select id into till from public.finance_accounts where org_id = org and kind = 'cash' order by created_at limit 1;
  select id into rent from public.finance_categories where org_id = org and kind = 'expense' and name = 'Rent';
  select id into utilities from public.finance_categories where org_id = org and kind = 'expense' and name = 'Utilities';
  select id into sales from public.finance_categories where org_id = org and kind = 'income' and name = 'Sales';
  if bank is null or till is null or rent is null or utilities is null or sales is null then
    raise exception 'BENDAHARA_CASH_BOOK_CHECK cannot run: the new workspace has no accounts or categories';
  end if;
  owner_claims := json_build_object('sub', owner_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  editor_claims := json_build_object('sub', editor_id, 'role', 'authenticated', 'aal', 'aal2')::text;

  -- ==== as the owner: what the cash book stands beside =========================
  perform set_config('request.jwt.claims', owner_claims, true);
  set local role authenticated;

  insert into public.finance_contacts (org_id, name, is_customer) values (org, 'Check Customer', true) returning id into cust;
  insert into public.finance_contacts (org_id, name, is_customer) values (org, 'Check Customer Two', true) returning id into cust2;
  insert into public.finance_contacts (org_id, name, is_supplier) values (org, 'Check Supplier', true) returning id into sup;
  -- Three invoices of RM 132.50, two for the first customer.
  inv := public.finance_save_invoice(org,
    jsonb_build_object('customer_id', cust, 'invoice_date', current_date, 'due_date', current_date + 30), one_line);
  perform public.finance_post_invoice(org, inv);
  inv2 := public.finance_save_invoice(org,
    jsonb_build_object('customer_id', cust, 'invoice_date', current_date, 'due_date', current_date + 30), one_line);
  perform public.finance_post_invoice(org, inv2);
  inv3 := public.finance_save_invoice(org,
    jsonb_build_object('customer_id', cust2, 'invoice_date', current_date, 'due_date', current_date + 30), one_line);
  perform public.finance_post_invoice(org, inv3);
  -- Two bills of RM 132.50.
  bill1 := public.finance_save_bill(org,
    jsonb_build_object('supplier_id', sup, 'bill_date', current_date, 'due_date', current_date + 30), one_line);
  perform public.finance_post_bill(org, bill1);
  bill2 := public.finance_save_bill(org,
    jsonb_build_object('supplier_id', sup, 'bill_date', current_date, 'due_date', current_date + 30), one_line);
  perform public.finance_post_bill(org, bill2);

  -- ==== expenses, as the editor ================================================
  perform set_config('request.jwt.claims', editor_claims, true);

  ex1 := public.finance_save_expense(org, jsonb_build_object(
    'expense_date', current_date, 'category_id', rent, 'vendor_name', 'Check Landlord', 'amount', 100, 'sst_amount', 6));
  select * into r from public.finance_expense_totals where id = ex1;
  if (r.status, r.display_status, r.category_name, r.vendor_name, r.amount, r.sst_amount, r.paid, r.held, r.created_by)
     is distinct from ('pending', 'pending', 'Rent', 'Check Landlord', 100.00, 6.00, 0.00, 0.00, editor_id)
     or r.approved_at is not null or r.approved_by is not null or r.method is not null then
    fails := fails || format('an expense saved by an editor reads as %s', row_to_json(r));
  end if;

  -- ---- what saving an expense refuses ----------------------------------------
  fails := fails || public.bendahara_check_try('an expense is given an income category', 'FIN15',
    format('select public.finance_save_expense(%L, %L)', org,
      jsonb_build_object('category_id', sales, 'vendor_name', 'X', 'amount', 10)));
  fails := fails || public.bendahara_check_try('an expense has no category', 'FIN15',
    format('select public.finance_save_expense(%L, %L)', org, jsonb_build_object('vendor_name', 'X', 'amount', 10)));
  fails := fails || public.bendahara_check_try('an expense names a contact and a typed vendor', '23514',
    format('select public.finance_save_expense(%L, %L)', org,
      jsonb_build_object('category_id', rent, 'vendor_id', sup, 'vendor_name', 'X', 'amount', 10)));
  fails := fails || public.bendahara_check_try('an expense has no vendor', '23514',
    format('select public.finance_save_expense(%L, %L)', org, jsonb_build_object('category_id', rent, 'amount', 10)));
  fails := fails || public.bendahara_check_try('an expense has more SST than its amount', '23514',
    format('select public.finance_save_expense(%L, %L)', org,
      jsonb_build_object('category_id', rent, 'vendor_name', 'X', 'amount', 10, 'sst_amount', 10.01)));
  fails := fails || public.bendahara_check_try('an expense of nothing', '23514',
    format('select public.finance_save_expense(%L, %L)', org,
      jsonb_build_object('category_id', rent, 'vendor_name', 'X', 'amount', 0)));
  fails := fails || public.bendahara_check_try('an expense is created already approved', 'FIN01',
    format('insert into public.finance_expenses (org_id, category_id, vendor_name, amount, status, approved_at) values (%L, %L, %L, 10, %L, now())',
      org, rent, 'X', 'approved'));
  fails := fails || public.bendahara_check_try('an expense that is not there is changed', 'FIN11',
    format('select public.finance_save_expense(%L, %L)', org,
      jsonb_build_object('id', gen_random_uuid(), 'category_id', rent, 'vendor_name', 'X', 'amount', 10)));

  -- ---- a pending expense is edited; an editor cannot decide it -----------------
  if public.finance_save_expense(org, jsonb_build_object(
       'id', ex1, 'expense_date', current_date, 'category_id', rent, 'vendor_id', sup, 'amount', 120, 'sst_amount', 6, 'notes', 'October'))
     is distinct from ex1 then
    fails := array_append(fails, 'saving an expense again did not keep its id');
  end if;
  select * into r from public.finance_expense_totals where id = ex1;
  if (r.status, r.vendor_name, r.amount, r.notes) is distinct from ('pending', 'Check Supplier', 120.00, 'October') then
    fails := fails || format('an edited pending expense reads as %s', row_to_json(r));
  end if;
  fails := fails || public.bendahara_check_try('an editor approves an expense', 'FIN14',
    format('update public.finance_expenses set status = %L, updated_at = now() where id = %L', 'approved', ex1));
  fails := fails || public.bendahara_check_try('an editor rejects an expense', 'FIN14',
    format('update public.finance_expenses set status = %L, updated_at = now() where id = %L', 'rejected', ex1));
  fails := fails || public.bendahara_check_try('an editor approves an expense in someone else''s name', 'FIN14',
    format('update public.finance_expenses set status = %L, approved_by = %L, approved_at = now() where id = %L', 'approved', owner_id, ex1));
  fails := fails || public.bendahara_check_try('a pending expense is paid', 'FIN04',
    format('select public.finance_record_voucher(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx', 'party_name', 'Check Supplier'),
      jsonb_build_array(jsonb_build_object('expense_id', ex1, 'amount', 10))));
  -- A second pending expense, deleted again: anyone who may write can.
  ex3 := public.finance_save_expense(org, jsonb_build_object('category_id', utilities, 'vendor_name', 'Typo', 'amount', 5));
  fails := fails || public.bendahara_check_try('a pending expense is deleted', 'ok',
    format('delete from public.finance_expenses where id = %L', ex3));

  -- ==== expenses, as the owner =================================================
  perform set_config('request.jwt.claims', owner_claims, true);

  fails := fails || public.bendahara_check_try('an expense is approved and changed in one update', 'FIN01',
    format('update public.finance_expenses set status = %L, amount = 999 where id = %L', 'approved', ex1));
  fails := fails || public.bendahara_check_try('an owner approves an expense', 'ok',
    format('update public.finance_expenses set status = %L, updated_at = now() where id = %L', 'approved', ex1));
  select * into r from public.finance_expense_totals where id = ex1;
  if (r.status, r.display_status, r.approved_by, r.created_by) is distinct from ('approved', 'approved', owner_id, editor_id)
     or r.approved_at is null then
    fails := fails || format('an approved expense reads as %s', row_to_json(r));
  end if;
  fails := fails || public.bendahara_check_try('an approved expense is edited', 'FIN01',
    format('update public.finance_expenses set amount = 1 where id = %L', ex1));
  fails := fails || public.bendahara_check_try('an approved expense is saved again', 'FIN01',
    format('select public.finance_save_expense(%L, %L)', org,
      jsonb_build_object('id', ex1, 'category_id', rent, 'vendor_id', sup, 'amount', 1)));
  fails := fails || public.bendahara_check_try('an approved expense is deleted', 'FIN01',
    format('delete from public.finance_expenses where id = %L', ex1));
  fails := fails || public.bendahara_check_try('an approved expense is approved in another name', 'FIN01',
    format('update public.finance_expenses set approved_by = %L where id = %L', editor_id, ex1));
  -- Saved by an owner, an expense is approved in the same call.
  ex2 := public.finance_save_expense(org, jsonb_build_object('category_id', utilities, 'vendor_name', 'Check Utility', 'amount', 40));
  select status || '/' || coalesce(approved_by::text, 'nobody') into t from public.finance_expenses where id = ex2;
  if t is distinct from 'approved/' || owner_id then fails := fails || format('an expense saved by an owner reads %s', t); end if;

  -- ==== paying an approved expense, as the editor ==============================
  -- No second approval: the expense was approved.
  perform set_config('request.jwt.claims', editor_claims, true);

  p1 := public.finance_record_voucher(org,
    jsonb_build_object('account_id', bank, 'txn_date', current_date, 'method', 'fpx', 'contact_id', sup, 'status', 'scheduled'),
    jsonb_build_array(jsonb_build_object('expense_id', ex1, 'amount', 50)));
  select * into r from public.finance_transactions where id = p1;
  if (r.direction, r.status, r.amount, r.number, r.contact_id, r.category_id)
     is distinct from ('out', 'scheduled', 50.00, null::text, sup, null::uuid) or r.approved_at is not null then
    fails := fails || format('a scheduled payment of an expense reads as %s', row_to_json(r));
  end if;
  select * into r from public.finance_expense_totals where id = ex1;
  if (r.paid, r.held, r.display_status) is distinct from (0.00, 50.00, 'approved') then
    fails := fails || format('with RM 50 scheduled the expense reads %s', row_to_json(r));
  end if;
  fails := fails || public.bendahara_check_try('an expense is paid a sen more than is left', 'FIN05',
    format('select public.finance_record_voucher(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx', 'contact_id', sup),
      jsonb_build_array(jsonb_build_object('expense_id', ex1, 'amount', 70.01))));
  p2 := public.finance_record_voucher(org,
    jsonb_build_object('account_id', till, 'method', 'cash', 'contact_id', sup),
    jsonb_build_array(jsonb_build_object('expense_id', ex1, 'amount', 70)));
  select status || '/' || number into t from public.finance_transactions where id = p2;
  if t is distinct from 'posted/PV-0001' then fails := fails || format('the first voucher reads %s', t); end if;
  select * into r from public.finance_expense_totals where id = ex1;
  if (r.paid, r.held, r.display_status, r.method) is distinct from (70.00, 50.00, 'approved', 'cash') then
    fails := fails || format('with RM 70 paid and RM 50 scheduled the expense reads %s', row_to_json(r));
  end if;
  no := public.finance_mark_payment_paid(org, p1, current_date);
  if no is distinct from 'PV-0002' then fails := fails || format('the scheduled payment was numbered %s', no); end if;
  select * into r from public.finance_expense_totals where id = ex1;
  if (r.paid, r.held, r.display_status) is distinct from (120.00, 0.00, 'paid') then
    fails := fails || format('paid in full the expense reads %s', row_to_json(r));
  end if;
  select * into r from public.finance_payment_vouchers where transaction_id = p2;
  if (r.kind, r.category_name, r.party_name, r.account_kind, r.documents)
     is distinct from ('expense', 'Rent', 'Check Supplier', 'cash', null::text) then
    fails := fails || format('a payment of an expense shows on Payment Vouchers as %s', row_to_json(r));
  end if;

  -- ---- what a voucher for expenses refuses ------------------------------------
  fails := fails || public.bendahara_check_try('a voucher names expenses and a category', 'FIN15',
    format('select public.finance_record_voucher(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx', 'category_id', rent),
      jsonb_build_array(jsonb_build_object('expense_id', ex2, 'amount', 10))));
  fails := fails || public.bendahara_check_try('a voucher names an expense that is not there', 'FIN06',
    format('select public.finance_record_voucher(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx'),
      jsonb_build_array(jsonb_build_object('expense_id', gen_random_uuid(), 'amount', 10))));
  fails := fails || public.bendahara_check_try('a voucher is asked for a status that is not one', '22023',
    format('select public.finance_record_voucher(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx', 'status', 'void'),
      jsonb_build_array(jsonb_build_object('expense_id', ex2, 'amount', 10))));
  -- Money in never pays an expense.
  insert into public.finance_transactions (org_id, direction, account_id, amount, method)
  values (org, 'in', bank, 20, 'cash') returning id into stray;
  fails := fails || public.bendahara_check_try('money in is put against an expense', 'FIN04',
    format('insert into public.finance_allocations (org_id, transaction_id, expense_id, amount) values (%L, %L, %L, 10)', org, stray, ex2));
  delete from public.finance_transactions where id = stray;
  -- One payment, one kind of document.
  insert into public.finance_transactions (org_id, direction, account_id, amount, method)
  values (org, 'out', bank, 20, 'cash') returning id into stray;
  insert into public.finance_allocations (org_id, transaction_id, expense_id, amount) values (org, stray, ex2, 10);
  fails := fails || public.bendahara_check_try('a payment of an expense is also put against a bill', 'FIN06',
    format('insert into public.finance_allocations (org_id, transaction_id, bill_id, amount) values (%L, %L, %L, 10)', org, stray, bill1));
  fails := fails || public.bendahara_check_try('one allocation names an expense and a bill', '23514',
    format('update public.finance_allocations set bill_id = %L where transaction_id = %L', bill1, stray));
  delete from public.finance_transactions where id = stray;
  insert into public.finance_transactions (org_id, direction, account_id, amount, method)
  values (org, 'out', bank, 20, 'cash') returning id into stray;
  insert into public.finance_allocations (org_id, transaction_id, bill_id, amount) values (org, stray, bill1, 10);
  fails := fails || public.bendahara_check_try('a payment of a bill is also put against an expense', 'FIN06',
    format('insert into public.finance_allocations (org_id, transaction_id, expense_id, amount) values (%L, %L, %L, 10)', org, stray, ex2));
  delete from public.finance_transactions where id = stray;

  -- ==== an approved expense is rejected only once nothing stands against it ====
  perform set_config('request.jwt.claims', owner_claims, true);

  fails := fails || public.bendahara_check_try('an approved expense with payments is rejected', 'FIN02',
    format('update public.finance_expenses set status = %L, updated_at = now() where id = %L', 'rejected', ex1));
  update public.finance_transactions set status = 'void', updated_at = now() where id in (p1, p2);
  select * into r from public.finance_expense_totals where id = ex1;
  if (r.paid, r.held, r.display_status) is distinct from (0.00, 0.00, 'approved') or r.method is not null then
    fails := fails || format('with its payments voided the expense reads %s', row_to_json(r));
  end if;
  fails := fails || public.bendahara_check_try('an approved expense with no payment is rejected', 'ok',
    format('update public.finance_expenses set status = %L, updated_at = now() where id = %L', 'rejected', ex1));
  fails := fails || public.bendahara_check_try('a rejected expense is approved without being edited', 'FIN01',
    format('update public.finance_expenses set status = %L, updated_at = now() where id = %L', 'approved', ex1));
  fails := fails || public.bendahara_check_try('a rejected expense is edited and stays rejected', 'FIN01',
    format('update public.finance_expenses set amount = 1 where id = %L', ex1));
  fails := fails || public.bendahara_check_try('a rejected expense is paid', 'FIN04',
    format('select public.finance_record_voucher(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx', 'contact_id', sup),
      jsonb_build_array(jsonb_build_object('expense_id', ex1, 'amount', 10))));
  -- Edited by the editor, it is pending again and nobody has decided it.
  perform set_config('request.jwt.claims', editor_claims, true);
  perform public.finance_save_expense(org, jsonb_build_object('id', ex1, 'category_id', rent, 'vendor_id', sup, 'amount', 110));
  select status || '/' || amount || '/' || coalesce(approved_by::text, 'nobody') || '/' || coalesce(approved_at::text, 'never')
    into t from public.finance_expenses where id = ex1;
  if t is distinct from 'pending/110.00/nobody/never' then fails := fails || format('a rejected expense edited reads %s', t); end if;
  -- Its voided payments still name it, so it stays as a record.
  fails := fails || public.bendahara_check_try('an expense with voided payments is deleted', '23503',
    format('delete from public.finance_expenses where id = %L', ex1));

  -- ==== vouchers that settle no document, as the editor ========================
  v1 := public.finance_record_voucher(org,
    jsonb_build_object('account_id', bank, 'txn_date', current_date, 'method', 'fpx', 'party_name', 'Check Water Board',
                       'category_id', utilities, 'amount', 300, 'reference', 'ACC 1', 'status', 'posted'), null);
  select * into r from public.finance_transactions where id = v1;
  if (r.direction, r.status, r.amount, r.number, r.party_name, r.category_id, r.created_by)
     is distinct from ('out', 'pending_approval', 300.00, null::text, 'Check Water Board', utilities, editor_id)
     or r.approved_at is not null or r.approved_by is not null then
    fails := fails || format('a voucher recorded by an editor reads as %s', row_to_json(r));
  end if;
  select * into r from public.finance_payment_vouchers where transaction_id = v1;
  if (r.kind, r.category_name, r.party_name, r.status, r.documents)
     is distinct from ('other', 'Utilities', 'Check Water Board', 'pending_approval', null::text) then
    fails := fails || format('a voucher waiting for approval shows as %s', row_to_json(r));
  end if;
  fails := fails || public.bendahara_check_try('a voucher is given an income category', 'FIN15',
    format('select public.finance_record_voucher(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx', 'party_name', 'X', 'category_id', sales, 'amount', 10), '[]'::jsonb));
  fails := fails || public.bendahara_check_try('a voucher names no expense and no category', 'FIN15',
    format('select public.finance_record_voucher(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx', 'party_name', 'X', 'amount', 10), '[]'::jsonb));
  fails := fails || public.bendahara_check_try('a voucher names a contact and a typed payee', '23514',
    format('select public.finance_record_voucher(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx', 'contact_id', sup, 'party_name', 'X', 'category_id', rent, 'amount', 10), null::jsonb));

  -- ---- what an editor cannot do to a voucher that is waiting -------------------
  fails := fails || public.bendahara_check_try('an editor approves a voucher', 'FIN14',
    format('update public.finance_transactions set status = %L, updated_at = now() where id = %L', 'scheduled', v1));
  fails := fails || public.bendahara_check_try('an editor rejects a voucher', 'FIN14',
    format('update public.finance_transactions set status = %L, updated_at = now() where id = %L', 'rejected', v1));
  fails := fails || public.bendahara_check_try('an editor pays a voucher that is waiting', 'FIN14',
    format('update public.finance_transactions set status = %L, number = %L where id = %L', 'posted', 'PV-SNEAKY', v1));
  fails := fails || public.bendahara_check_try('a voucher that is waiting is marked paid', 'FIN09',
    format('select public.finance_mark_payment_paid(%L, %L, current_date)', org, v1));
  fails := fails || public.bendahara_check_try('a voucher that is waiting is changed', 'FIN14',
    format('update public.finance_transactions set amount = 3000 where id = %L', v1));
  fails := fails || public.bendahara_check_try('a voucher that is waiting goes back to draft', 'FIN14',
    format('update public.finance_transactions set status = %L where id = %L', 'draft', v1));
  fails := fails || public.bendahara_check_try('a voucher that is waiting is given a split', 'FIN09',
    format('insert into public.finance_allocations (org_id, transaction_id, bill_id, amount) values (%L, %L, %L, 10)', org, v1, bill1));
  -- Behind the function: a payment starts as a draft, and money out that
  -- settles no document does not leave draft without an owner or admin.
  fails := fails || public.bendahara_check_try('a payment is created already scheduled', 'FIN09',
    format('insert into public.finance_transactions (org_id, direction, account_id, amount, method, category_id, status) values (%L, %L, %L, 10, %L, %L, %L)',
      org, 'out', bank, 'cash', rent, 'scheduled'));
  fails := fails || public.bendahara_check_try('a payment is created already posted', 'FIN09',
    format('insert into public.finance_transactions (org_id, direction, account_id, amount, method, category_id, status, number) values (%L, %L, %L, 10, %L, %L, %L, %L)',
      org, 'out', bank, 'cash', rent, 'posted', 'PV-SNEAKY'));
  insert into public.finance_transactions (org_id, direction, account_id, amount, method, category_id, approved_by, approved_at)
  values (org, 'out', bank, 500, 'cash', rent, owner_id, now()) returning id into stray;
  select count(*) into n from public.finance_transactions where id = stray and approved_by is null and approved_at is null;
  if n <> 1 then fails := array_append(fails, 'a payment was created already approved'); end if;
  fails := fails || public.bendahara_check_try('an editor schedules money out that settles no document', 'FIN14',
    format('update public.finance_transactions set status = %L where id = %L', 'scheduled', stray));
  fails := fails || public.bendahara_check_try('an editor pays money out that settles no document', 'FIN14',
    format('update public.finance_transactions set status = %L, number = %L where id = %L', 'posted', 'PV-SNEAKY', stray));
  -- A sen against a bill does not make the other RM 499.99 a payment to a supplier.
  insert into public.finance_allocations (org_id, transaction_id, bill_id, amount) values (org, stray, bill1, 0.01);
  fails := fails || public.bendahara_check_try('an editor pays money out that is mostly not for its bill', 'FIN14',
    format('update public.finance_transactions set status = %L, number = %L where id = %L', 'posted', 'PV-SNEAKY', stray));
  fails := fails || public.bendahara_check_try('a draft is deleted', 'ok',
    format('delete from public.finance_transactions where id = %L', stray));
  -- Nor by scheduling a payment to a supplier, which needs nobody, and raising it afterwards.
  stray := public.finance_record_payment_out(org,
    jsonb_build_object('account_id', bank, 'method', 'fpx', 'status', 'scheduled'),
    jsonb_build_array(jsonb_build_object('bill_id', bill1, 'amount', 1)));
  update public.finance_transactions set amount = 500 where id = stray;
  fails := fails || public.bendahara_check_try('an editor marks paid a scheduled payment raised above its bill', 'FIN14',
    format('select public.finance_mark_payment_paid(%L, %L, current_date)', org, stray));
  update public.finance_transactions set amount = 1 where id = stray;
  fails := fails || public.bendahara_check_try('an editor marks paid a scheduled payment that is exactly its bill', 'ok',
    format('select public.finance_mark_payment_paid(%L, %L, current_date)', org, stray));
  update public.finance_transactions set status = 'void', updated_at = now() where id = stray;

  -- ==== the owner decides ======================================================
  perform set_config('request.jwt.claims', owner_claims, true);

  fails := fails || public.bendahara_check_try('a voucher is approved and changed in one update', 'FIN14',
    format('update public.finance_transactions set status = %L, amount = 3000 where id = %L', 'scheduled', v1));
  fails := fails || public.bendahara_check_try('a voucher that is waiting is paid without being approved', 'FIN14',
    format('update public.finance_transactions set status = %L, number = %L where id = %L', 'posted', 'PV-SNEAKY', v1));
  -- Without a number the table's own check would refuse it (23514); the guard comes first.
  fails := fails || public.bendahara_check_try('a voucher that is waiting is paid in one step', 'FIN14',
    format('update public.finance_transactions set status = %L where id = %L', 'posted', v1));
  fails := fails || public.bendahara_check_try('an owner approves a voucher', 'ok',
    format('update public.finance_transactions set status = %L, updated_at = now() where id = %L', 'scheduled', v1));
  select * into r from public.finance_transactions where id = v1;
  if (r.status, r.number, r.approved_by, r.created_by) is distinct from ('scheduled', null::text, owner_id, editor_id)
     or r.approved_at is null then
    fails := fails || format('an approved voucher reads as %s', row_to_json(r));
  end if;
  -- Recorded by an owner, a voucher is as asked, and approved in the same call.
  v2 := public.finance_record_voucher(org,
    jsonb_build_object('account_id', till, 'method', 'cash', 'party_name', 'Check Stationer', 'category_id', utilities, 'amount', 25.5), null);
  select * into r from public.finance_transactions where id = v2;
  if (r.status, r.number, r.approved_by) is distinct from ('posted', 'PV-0004', owner_id) or r.approved_at is null then
    fails := fails || format('a voucher paid by an owner reads as %s', row_to_json(r));
  end if;
  v3 := public.finance_record_voucher(org,
    jsonb_build_object('account_id', bank, 'method', 'fpx', 'party_name', 'Check Insurer', 'category_id', utilities, 'amount', 80, 'status', 'scheduled'), null);
  select status || '/' || coalesce(number, 'no number') || '/' || coalesce(approved_by::text, 'nobody') into t
    from public.finance_transactions where id = v3;
  if t is distinct from 'scheduled/no number/' || owner_id then fails := fails || format('a voucher scheduled by an owner reads %s', t); end if;

  -- ==== an approved voucher is paid as it was approved, by anyone who may write =
  perform set_config('request.jwt.claims', editor_claims, true);

  fails := fails || public.bendahara_check_try('an approved voucher is changed', 'FIN14',
    format('update public.finance_transactions set amount = 3000 where id = %L', v1));
  fails := fails || public.bendahara_check_try('an approved voucher is paid for another amount', 'FIN14',
    format('update public.finance_transactions set status = %L, number = %L, amount = 3000 where id = %L', 'posted', 'PV-SNEAKY', v1));
  fails := fails || public.bendahara_check_try('an approved voucher goes back to draft', 'FIN14',
    format('update public.finance_transactions set status = %L where id = %L', 'draft', v1));
  fails := fails || public.bendahara_check_try('an approved voucher is given a split', 'FIN09',
    format('insert into public.finance_allocations (org_id, transaction_id, bill_id, amount) values (%L, %L, %L, 10)', org, v1, bill1));
  no := public.finance_mark_payment_paid(org, v1, current_date - 1);
  select * into r from public.finance_transactions where id = v1;
  if (no, r.status, r.number, r.txn_date, r.amount, r.approved_by)
     is distinct from ('PV-0005', 'posted', 'PV-0005', current_date - 1, 300.00, owner_id) then
    fails := fails || format('an approved voucher marked paid reads as %s', row_to_json(r));
  end if;
  fails := fails || public.bendahara_check_try('a paid voucher is changed', 'FIN09',
    format('update public.finance_transactions set amount = 1 where id = %L', v1));
  fails := fails || public.bendahara_check_try('a paid voucher is deleted', 'FIN09',
    format('delete from public.finance_transactions where id = %L', v1));
  fails := fails || public.bendahara_check_try('a paid voucher is voided', 'ok',
    format('update public.finance_transactions set status = %L, updated_at = now() where id = %L', 'void', v1));
  fails := fails || public.bendahara_check_try('an approved voucher that was never paid is deleted', 'ok',
    format('delete from public.finance_transactions where id = %L', v3));

  -- ==== a rejected voucher is final ============================================
  v4 := public.finance_record_voucher(org,
    jsonb_build_object('account_id', bank, 'method', 'fpx', 'party_name', 'Check Caterer', 'category_id', utilities, 'amount', 60), null);
  v5 := public.finance_record_voucher(org,
    jsonb_build_object('account_id', bank, 'method', 'fpx', 'party_name', 'Check Mistake', 'category_id', utilities, 'amount', 61), null);
  fails := fails || public.bendahara_check_try('a voucher that is waiting is deleted by the editor', 'ok',
    format('delete from public.finance_transactions where id = %L', v5));
  perform set_config('request.jwt.claims', owner_claims, true);
  fails := fails || public.bendahara_check_try('an owner rejects a voucher', 'ok',
    format('update public.finance_transactions set status = %L, updated_at = now() where id = %L', 'rejected', v4));
  select status || '/' || coalesce(approved_by::text, 'nobody') into t from public.finance_transactions where id = v4;
  if t is distinct from 'rejected/' || owner_id then fails := fails || format('a rejected voucher reads %s', t); end if;
  foreach t in array array['scheduled','posted','draft','pending_approval'] loop
    fails := fails || public.bendahara_check_try(format('a rejected voucher becomes %s', t), 'FIN14',
      format('update public.finance_transactions set status = %L, number = case when %L = %L then %L end where id = %L',
        t, t, 'posted', 'PV-SNEAKY', v4));
  end loop;
  fails := fails || public.bendahara_check_try('a rejected voucher is changed', 'FIN14',
    format('update public.finance_transactions set amount = 1 where id = %L', v4));
  fails := fails || public.bendahara_check_try('a rejected voucher is marked paid', 'FIN09',
    format('select public.finance_mark_payment_paid(%L, %L, current_date)', org, v4));
  fails := fails || public.bendahara_check_try('a scheduled payment is rejected', 'FIN14',
    format('update public.finance_transactions set status = %L where id = %L', 'rejected',
      public.finance_record_voucher(org,
        jsonb_build_object('account_id', bank, 'method', 'fpx', 'party_name', 'Check Later', 'category_id', utilities, 'amount', 7, 'status', 'scheduled'), null)));
  fails := fails || public.bendahara_check_try('a rejected voucher is deleted', 'ok',
    format('delete from public.finance_transactions where id = %L', v4));

  -- ==== cash receipts, as the editor ===========================================
  perform set_config('request.jwt.claims', editor_claims, true);

  -- ---- income that settles no invoice ----------------------------------------
  r1 := public.finance_save_cash_receipt(org,
    jsonb_build_object('account_id', till, 'txn_date', current_date, 'method', 'cash', 'party_name', 'Walk-in',
                       'category_id', sales, 'amount', 80), null);
  select * into r from public.finance_cash_receipts where transaction_id = r1;
  if (r.kind, r.status, r.number, r.amount, r.party_name, r.category_name, r.account_kind, r.documents)
     is distinct from ('income', 'draft', null::text, 80.00, 'Walk-in', 'Sales', 'cash', null::text) then
    fails := fails || format('a draft receipt reads as %s', row_to_json(r));
  end if;
  if public.finance_save_cash_receipt(org,
       jsonb_build_object('id', r1, 'account_id', bank, 'method', 'duitnow', 'contact_id', cust, 'category_id', sales, 'amount', 85.555), '[]'::jsonb)
     is distinct from r1 then
    fails := array_append(fails, 'saving a draft receipt again did not keep its id');
  end if;
  select * into r from public.finance_cash_receipts where transaction_id = r1;
  if (r.amount, r.party_name, r.contact_id, r.method, r.account_kind) is distinct from (85.56, 'Check Customer', cust, 'duitnow', 'bank') then
    fails := fails || format('an edited draft receipt reads as %s', row_to_json(r));
  end if;
  fails := fails || public.bendahara_check_try('a receipt is given an expense category', 'FIN15',
    format('select public.finance_save_cash_receipt(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'cash', 'party_name', 'X', 'category_id', rent, 'amount', 10), null::jsonb));
  fails := fails || public.bendahara_check_try('a receipt names no invoice and no category', 'FIN15',
    format('select public.finance_save_cash_receipt(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'cash', 'party_name', 'X', 'amount', 10), null::jsonb));
  fails := fails || public.bendahara_check_try('a receipt names invoices and a category', 'FIN15',
    format('select public.finance_save_cash_receipt(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'cash', 'category_id', sales),
      jsonb_build_array(jsonb_build_object('invoice_id', inv, 'amount', 10))));
  fails := fails || public.bendahara_check_try('a receipt names a contact and a typed payer', '23514',
    format('select public.finance_save_cash_receipt(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'cash', 'contact_id', cust, 'party_name', 'X', 'category_id', sales, 'amount', 10), null::jsonb));
  fails := fails || public.bendahara_check_try('a receipt that is not there is changed', 'FIN11',
    format('select public.finance_save_cash_receipt(%L, %L, %L)', org,
      jsonb_build_object('id', gen_random_uuid(), 'account_id', bank, 'method', 'cash', 'party_name', 'X', 'category_id', sales, 'amount', 10), null::jsonb));
  fails := fails || public.bendahara_check_try('a voucher is changed as if it were a receipt', 'FIN11',
    format('select public.finance_save_cash_receipt(%L, %L, %L)', org,
      jsonb_build_object('id', v2, 'account_id', bank, 'method', 'cash', 'party_name', 'X', 'category_id', sales, 'amount', 10), null::jsonb));
  fails := fails || public.bendahara_check_try('a voucher is posted as if it were a receipt', 'FIN11',
    format('select public.finance_post_cash_receipt(%L, %L)', org, v2));
  -- Money in needs nobody's approval: the editor posts it.
  no := public.finance_post_cash_receipt(org, r1);
  select * into r from public.finance_transactions where id = r1;
  if (no, r.status, r.number, r.direction) is distinct from ('RC-0001', 'posted', 'RC-0001', 'in') or r.approved_at is not null then
    fails := fails || format('a posted receipt reads as %s', row_to_json(r));
  end if;
  fails := fails || public.bendahara_check_try('a posted receipt is saved again', 'FIN09',
    format('select public.finance_save_cash_receipt(%L, %L, %L)', org,
      jsonb_build_object('id', r1, 'account_id', bank, 'method', 'cash', 'party_name', 'X', 'category_id', sales, 'amount', 10), null::jsonb));
  fails := fails || public.bendahara_check_try('a posted receipt is posted again', 'FIN09',
    format('select public.finance_post_cash_receipt(%L, %L)', org, r1));
  fails := fails || public.bendahara_check_try('a posted receipt is deleted', 'FIN09',
    format('delete from public.finance_transactions where id = %L', r1));
  fails := fails || public.bendahara_check_try('a posted receipt is voided', 'ok',
    format('update public.finance_transactions set status = %L, updated_at = now() where id = %L', 'void', r1));
  -- A draft that names neither invoices nor a category, written straight to the table, is not posted.
  insert into public.finance_transactions (org_id, direction, account_id, amount, method)
  values (org, 'in', bank, 20, 'cash') returning id into stray;
  fails := fails || public.bendahara_check_try('a receipt for nothing is posted', 'FIN15',
    format('select public.finance_post_cash_receipt(%L, %L)', org, stray));
  -- Money in is never scheduled, and is never given a voucher number.
  update public.finance_transactions set status = 'scheduled', category_id = sales where id = stray;
  fails := fails || public.bendahara_check_try('scheduled money in is marked paid', 'FIN09',
    format('select public.finance_mark_payment_paid(%L, %L, current_date)', org, stray));
  delete from public.finance_transactions where id = stray;

  -- ---- a receipt for invoices: a draft holds what it is split across ---------
  r2 := public.finance_save_cash_receipt(org,
    jsonb_build_object('account_id', bank, 'method', 'fpx', 'party_name', 'Ignored', 'reference', 'CHK 9'),
    jsonb_build_array(jsonb_build_object('invoice_id', inv, 'amount', 100), jsonb_build_object('invoice_id', inv2, 'amount', 32.5)));
  select * into r from public.finance_cash_receipts where transaction_id = r2;
  if (r.kind, r.status, r.amount, r.party_name, r.contact_id, r.category_id, r.documents)
     is distinct from ('invoice', 'draft', 132.50, 'Check Customer', cust, null::uuid, 'INV-0001, INV-0002') then
    fails := fails || format('a draft receipt for two invoices reads as %s', row_to_json(r));
  end if;
  select paid || '/' || balance into t from public.finance_invoice_totals where id = inv;
  if t is distinct from '0.00/132.50' then fails := fails || format('with a draft receipt the invoice reads %s', t); end if;
  fails := fails || public.bendahara_check_try('an invoice is paid in full while a draft receipt holds part of it', 'FIN05',
    format('select public.finance_record_payment_in(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx'), jsonb_build_array(jsonb_build_object('invoice_id', inv, 'amount', 32.51))));
  pay := public.finance_record_payment_in(org,
    jsonb_build_object('account_id', bank, 'method', 'fpx'), jsonb_build_array(jsonb_build_object('invoice_id', inv, 'amount', 32.5)));
  fails := fails || public.bendahara_check_try('a receipt is for two customers', 'FIN06',
    format('select public.finance_save_cash_receipt(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx'),
      jsonb_build_array(jsonb_build_object('invoice_id', inv2, 'amount', 1), jsonb_build_object('invoice_id', inv3, 'amount', 1))));
  fails := fails || public.bendahara_check_try('a draft receipt is saved for more than its invoice owes', 'FIN05',
    format('select public.finance_save_cash_receipt(%L, %L, %L)', org,
      jsonb_build_object('id', r2, 'account_id', bank, 'method', 'fpx'),
      jsonb_build_array(jsonb_build_object('invoice_id', inv, 'amount', 100.01))));
  -- The refused save changed nothing: the draft still has its two invoices.
  select count(*) into n from public.finance_allocations where transaction_id = r2;
  if n <> 2 then fails := fails || format('a refused save left the draft receipt with %s invoices', n); end if;
  -- Saved again for less, against one invoice: the old split goes and the amount follows.
  perform public.finance_save_cash_receipt(org,
    jsonb_build_object('id', r2, 'account_id', bank, 'method', 'fpx'),
    jsonb_build_array(jsonb_build_object('invoice_id', inv, 'amount', 50)));
  select amount::text || '/' || (select count(*) from public.finance_allocations where transaction_id = r2) into t
    from public.finance_transactions where id = r2;
  if t is distinct from '50.00/1' then fails := fails || format('a draft receipt saved for less reads %s', t); end if;
  no := public.finance_post_cash_receipt(org, r2);
  if no is distinct from 'RC-0003' then fails := fails || format('the receipt for an invoice was numbered %s', no); end if;
  select paid || '/' || balance || '/' || display_status into t from public.finance_invoice_totals where id = inv;
  if t is distinct from '82.50/50.00/sent' then fails := fails || format('after the receipt was posted the invoice reads %s', t); end if;
  -- The same money on Payments In, one row per invoice, and on Cash Receipts, one row.
  select count(*) into n from public.finance_payments_in where transaction_id = r2;
  select count(*) into m from public.finance_cash_receipts where transaction_id = r2;
  if (n, m) is distinct from (1, 1) then fails := fails || format('a receipt for an invoice shows %s times on Payments In and %s on Cash Receipts', n, m); end if;

  -- ==== every movement of money shows once =====================================
  perform set_config('request.jwt.claims', owner_claims, true);

  -- One payment to a supplier across two bills: two rows on Payments Out, one voucher.
  pay := public.finance_record_payment_out(org,
    jsonb_build_object('account_id', bank, 'method', 'fpx'),
    jsonb_build_array(jsonb_build_object('bill_id', bill1, 'amount', 100), jsonb_build_object('bill_id', bill2, 'amount', 32.5)));
  select count(*) into n from public.finance_payments_out where transaction_id = pay;
  select * into r from public.finance_payment_vouchers where transaction_id = pay;
  if (n, r.kind, r.documents, r.party_name, r.amount, r.category_name)
     is distinct from (2, 'bill', 'BILL-0001, BILL-0002', 'Check Supplier', 132.50, null::text) then
    fails := fails || format('a payment across two bills shows %s times on Payments Out and on Payment Vouchers as %s', n, row_to_json(r));
  end if;
  if (select approved_at from public.finance_transactions where id = pay) is not null then
    fails := array_append(fails, 'a payment to a supplier was marked as approved');
  end if;
  -- A refund: the third invoice paid in full, credited RM 30, RM 30 paid back.
  perform public.finance_record_payment_in(org,
    jsonb_build_object('account_id', bank, 'method', 'fpx'), jsonb_build_array(jsonb_build_object('invoice_id', inv3, 'amount', 132.5)));
  cn := public.finance_save_credit_note(org, jsonb_build_object('invoice_id', inv3, 'reason', 'returns', 'amount', 30));
  perform public.finance_issue_credit_note(org, cn);
  rf := public.finance_record_refund(org,
    jsonb_build_object('credit_note_id', cn, 'account_id', bank, 'method', 'fpx', 'reason', 'other', 'amount', 30));
  select count(*) into n from public.finance_refunds where transaction_id = rf;
  select * into r from public.finance_payment_vouchers where transaction_id = rf;
  if (n, r.kind, r.documents, r.party_name, r.status) is distinct from (1, 'refund', 'CN-0001', 'Check Customer Two', 'posted') then
    fails := fails || format('a refund shows %s times on Refunds and on Payment Vouchers as %s', n, row_to_json(r));
  end if;
  -- A refund is not a payment to a supplier and an expense voucher is neither.
  select (select count(*) from public.finance_payments_out where transaction_id in (rf, p2, v2))
       + (select count(*) from public.finance_refunds where transaction_id in (pay, p2, v2))
       + (select count(*) from public.finance_payments_in where transaction_id in (rf, pay, p2, v2)) into n;
  if n <> 0 then fails := fails || format('%s rows of a voucher show on a screen that is not its own', n); end if;
  -- An editor's payment to a supplier and refund are not held for approval: those two functions are untouched.
  perform set_config('request.jwt.claims', editor_claims, true);
  stray := public.finance_record_payment_out(org,
    jsonb_build_object('account_id', bank, 'method', 'fpx'), jsonb_build_array(jsonb_build_object('bill_id', bill2, 'amount', 10)));
  select status into t from public.finance_transactions where id = stray;
  if t is distinct from 'posted' then fails := fails || format('a payment to a supplier recorded by an editor is %s', t); end if;
  perform set_config('request.jwt.claims', owner_claims, true);
  -- Each view has exactly one row per movement of its direction, and their totals are the table's.
  select (select count(*) from public.finance_payment_vouchers where org_id = org)
       - (select count(*) from public.finance_transactions where org_id = org and direction = 'out') into n;
  select (select count(*) from public.finance_cash_receipts where org_id = org)
       - (select count(*) from public.finance_transactions where org_id = org and direction = 'in') into m;
  if (n, m) is distinct from (0, 0) then fails := fails || format('Payment Vouchers is %s rows out and Cash Receipts %s rows out', n, m); end if;
  select (select coalesce(sum(amount), 0) from public.finance_payment_vouchers where org_id = org and status = 'posted')
       - (select coalesce(sum(amount), 0) from public.finance_transactions where org_id = org and direction = 'out' and status = 'posted') into n;
  if n <> 0 then fails := fails || format('posted money out on Payment Vouchers is out by %s', n); end if;
  select string_agg(kind || '=' || c, ', ' order by kind) into t
    from (select kind, count(*) c from public.finance_payment_vouchers where org_id = org group by 1) k;
  if t is distinct from 'bill=3, expense=2, other=3, refund=1' then fails := fails || format('vouchers by kind: %s', t); end if;
  select string_agg(kind || '=' || c, ', ' order by kind) into t
    from (select kind, count(*) c from public.finance_cash_receipts where org_id = org group by 1) k;
  if t is distinct from 'income=1, invoice=3' then fails := fails || format('receipts by kind: %s', t); end if;
  -- The two sides of a transfer between accounts are not receipts or vouchers.
  insert into public.finance_transactions (org_id, direction, account_id, amount, method, transfer_id)
  values (org, 'out', bank, 5, 'cash', gen_random_uuid()) returning id into stray;
  if exists (select 1 from public.finance_payment_vouchers where transaction_id = stray) then
    fails := array_append(fails, 'one side of a transfer shows on Payment Vouchers');
  end if;
  delete from public.finance_transactions where id = stray;

  -- ==== a draft receipt is not looked at again when it is posted ===============
  -- A draft holds RM 100 of the second invoice. A credit note is capped by the
  -- invoice's total, not by what is owed or held, so the whole invoice can
  -- still be credited. Posting the draft then leaves the customer RM 100 in
  -- credit: the position paying first and crediting afterwards gives.
  r3 := public.finance_save_cash_receipt(org,
    jsonb_build_object('account_id', bank, 'method', 'fpx'),
    jsonb_build_array(jsonb_build_object('invoice_id', inv2, 'amount', 100)));
  cn2 := public.finance_save_credit_note(org, jsonb_build_object('invoice_id', inv2, 'reason', 'goodwill', 'amount', 132.5));
  perform public.finance_issue_credit_note(org, cn2);
  select * into r from public.finance_invoice_totals where id = inv2;
  if (r.paid, r.credited, r.balance, r.display_status) is distinct from (0.00, 132.50, 0.00, 'paid') then
    fails := fails || format('credited in full under a draft receipt, the invoice reads %s', row_to_json(r));
  end if;
  fails := fails || public.bendahara_check_try('a draft receipt is posted after its invoice was credited in full', 'ok',
    format('select public.finance_post_cash_receipt(%L, %L)', org, r3));
  select * into r from public.finance_invoice_totals where id = inv2;
  if (r.paid, r.credited, r.balance, r.display_status) is distinct from (100.00, 132.50, -100.00, 'paid') then
    fails := fails || format('with that draft posted, the invoice reads %s', row_to_json(r));
  end if;
  -- That credit can be refunded, and no more than it.
  fails := fails || public.bendahara_check_try('more than that credit is refunded', 'FIN05',
    format('select public.finance_record_refund(%L, %L)', org,
      jsonb_build_object('invoice_id', inv2, 'account_id', bank, 'method', 'fpx', 'reason', 'overpayment', 'amount', 100.01)));
  fails := fails || public.bendahara_check_try('that credit is refunded', 'ok',
    format('select public.finance_record_refund(%L, %L)', org,
      jsonb_build_object('invoice_id', inv2, 'account_id', bank, 'method', 'fpx', 'reason', 'overpayment', 'amount', 100)));

  -- ==== a viewer reads and cannot write ========================================
  perform set_config('request.jwt.claims', json_build_object('sub', viewer_id, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  select (select count(*) from public.finance_expense_totals where org_id = org)
       + (select count(*) from public.finance_payment_vouchers where org_id = org)
       + (select count(*) from public.finance_cash_receipts where org_id = org) into n;
  if n <> 17 then fails := fails || format('a viewer reads %s rows of the three views, not 17', n); end if;
  fails := fails || public.bendahara_check_try('a viewer saves an expense', '42501',
    format('select public.finance_save_expense(%L, %L)', org, jsonb_build_object('category_id', rent, 'vendor_name', 'X', 'amount', 10)));
  fails := fails || public.bendahara_check_try('a viewer records a voucher', '42501',
    format('select public.finance_record_voucher(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx', 'party_name', 'X', 'category_id', rent, 'amount', 10), null::jsonb));
  fails := fails || public.bendahara_check_try('a viewer saves a receipt', '42501',
    format('select public.finance_save_cash_receipt(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'cash', 'party_name', 'X', 'category_id', sales, 'amount', 10), null::jsonb));
  -- An update a viewer sends reaches no row.
  update public.finance_expenses set status = 'approved', updated_at = now() where id = ex1;
  update public.finance_transactions set status = 'void', updated_at = now() where id = v2;
  reset role;
  select (select count(*) from public.finance_expenses where id = ex1 and status = 'pending')
       + (select count(*) from public.finance_transactions where id = v2 and status = 'posted') into n;
  if n <> 2 then fails := array_append(fails, 'a viewer changed an expense or a voucher'); end if;

  -- ==== another workspace ======================================================
  perform set_config('request.jwt.claims', json_build_object('sub', outsider, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  set local role authenticated;
  select (select count(*) from public.finance_expense_totals where org_id = org)
       + (select count(*) from public.finance_payment_vouchers where org_id = org)
       + (select count(*) from public.finance_cash_receipts where org_id = org) into n;
  if n <> 0 then fails := fails || format('another workspace reads %s rows of the three views', n); end if;
  fails := fails || public.bendahara_check_try('another workspace saves an expense here', 'FIN15',
    format('select public.finance_save_expense(%L, %L)', org, jsonb_build_object('category_id', rent, 'vendor_name', 'X', 'amount', 10)));
  fails := fails || public.bendahara_check_try('another workspace pays an expense here', 'FIN06',
    format('select public.finance_record_voucher(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx'), jsonb_build_array(jsonb_build_object('expense_id', ex2, 'amount', 10))));
  fails := fails || public.bendahara_check_try('another workspace posts a receipt here', 'FIN11',
    format('select public.finance_post_cash_receipt(%L, %L)', org, r2));
  -- Its own expense cannot be paid from here, nor carry a category from here.
  select id into t from public.finance_categories where org_id = other_org and kind = 'expense' and name = 'Rent';
  theirs := public.finance_save_expense(other_org, jsonb_build_object('category_id', t, 'vendor_name', 'Theirs', 'amount', 10));
  fails := fails || public.bendahara_check_try('an expense is given another workspace''s category', 'FIN15',
    format('select public.finance_save_expense(%L, %L)', other_org, jsonb_build_object('category_id', rent, 'vendor_name', 'X', 'amount', 10)));
  reset role;
  perform set_config('request.jwt.claims', owner_claims, true);
  set local role authenticated;
  fails := fails || public.bendahara_check_try('an expense of another workspace is paid from here', 'FIN06',
    format('select public.finance_record_voucher(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx'), jsonb_build_array(jsonb_build_object('expense_id', theirs, 'amount', 10))));
  reset role;

  -- ==== nobody signed in =======================================================
  -- A signed-in session that names no user reaches no row, so it decides nothing.
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'aal', 'aal2')::text, true);
  set local role authenticated;
  update public.finance_expenses set status = 'approved', updated_at = now() where id = ex1;
  reset role;
  if (select status from public.finance_expenses where id = ex1) is distinct from 'pending' then
    fails := array_append(fails, 'a session with no user approved an expense');
  end if;
  -- A migration has no user and is not asked for a role: it is how the demo seed approves its rows.
  perform set_config('request.jwt.claims', '{}', true);
  ex4 := gen_random_uuid();
  insert into public.finance_expenses (id, org_id, category_id, vendor_name, amount) values (ex4, org, rent, 'Seeded', 10);
  update public.finance_expenses set status = 'approved', approved_at = now() - interval '3 days' where id = ex4;
  select status || '/' || coalesce(approved_by::text, 'nobody') || '/' || (approved_at < now() - interval '2 days') into t
    from public.finance_expenses where id = ex4;
  if t is distinct from 'approved/nobody/true' then fails := fails || format('an expense approved by a migration reads %s', t); end if;

  -- ==== a user is deleted: who made it and who decided it are cleared ==========
  -- If the delete is stopped by something outside finance, the clearing its
  -- foreign keys would have done is done by hand, and the message says so.
  begin
    delete from auth.users where id = editor_id;
  exception when others then
    if sqlstate like 'FIN%' then raise; end if;
    notes := array_append(notes, format('deleting a user was stopped outside finance (%s: %s), so created_by was cleared by hand', sqlstate, sqlerrm));
    update public.finance_expenses set created_by = null where created_by = editor_id;
    update public.finance_transactions set created_by = null where created_by = editor_id;
    update public.finance_invoices set created_by = null where created_by = editor_id;
  end;
  select (select count(*) from public.finance_transactions where id = v1 and status = 'void' and created_by is null and approved_by = owner_id)
       + (select count(*) from public.finance_transactions where id = r2 and status = 'posted' and created_by is null)
       + (select count(*) from public.finance_expenses where id = ex1 and status = 'pending' and created_by is null) into n;
  if n <> 3 then fails := array_append(fails, 'deleting a user did not clear created_by on their voucher, receipt and expense'); end if;
  begin
    delete from auth.users where id = owner_id;
  exception when others then
    if sqlstate like 'FIN%' then raise; end if;
    update public.finance_expenses set created_by = null where created_by = owner_id;
    update public.finance_expenses set approved_by = null where approved_by = owner_id;
    update public.finance_transactions set created_by = null where created_by = owner_id;
    update public.finance_transactions set approved_by = null where approved_by = owner_id;
    update public.finance_invoices set created_by = null where created_by = owner_id;
    update public.finance_credit_notes set created_by = null where created_by = owner_id;
  end;
  select (select count(*) from public.finance_transactions where id = v1 and status = 'void' and approved_by is null and approved_at is not null)
       + (select count(*) from public.finance_transactions where id = v2 and status = 'posted' and approved_by is null and created_by is null)
       + (select count(*) from public.finance_expenses where id = ex2 and status = 'approved' and approved_by is null and approved_at is not null) into n;
  if n <> 3 then fails := array_append(fails, 'deleting a user did not clear approved_by on what they approved'); end if;

  -- ==== the workspace is deleted, with everything in it =======================
  delete from public.orgs where id = org;
  select (select count(*) from public.finance_expenses where org_id = org)
       + (select count(*) from public.finance_allocations where org_id = org)
       + (select count(*) from public.finance_transactions where org_id = org)
       + (select count(*) from public.finance_invoices where org_id = org)
       + (select count(*) from public.supplier_bills where org_id = org) into n;
  if n <> 0 then fails := fails || format('deleting the workspace left %s finance rows', n); end if;

  fails := array_remove(fails, null);
  if array_length(fails, 1) is null then
    raise exception 'BENDAHARA_CASH_BOOK_CHECK PASSED (everything rolled back)%',
      case when array_length(notes, 1) is null then '' else ' NOTE: ' || array_to_string(notes, ' | ') end;
  end if;
  raise exception 'BENDAHARA_CASH_BOOK_CHECK FAILED: %', array_to_string(fails, ' | ');
end $$;
```

- [ ] **Step 7: Leave the two existing check scripts as they are**

`supabase/tests/bendahara_followons_check.sql` and `supabase/tests/bendahara_invoices_check.sql` are not edited. Each lists the check constraints on `finance_allocations` by name, and this migration keeps the three names; each counts a fixed list of views, which are all still there; the follow-ons script rejects a draft refund by a direct update as an owner and then tries to pay it out, expecting the refund checks' `FIN05` or `FIN04`, which still come first, and neither script inserts a payment that is not a draft or mixes kinds on one payment. They pass after this migration as they are, and the controller runs them beside the new one as a second proof that nothing they cover moved.

Run: `git status --short supabase/tests`
Expected: one line, the new `bendahara_cash_book_check.sql`.

- [ ] **Step 8: Type-check and lint**

Run: `pnpm exec tsc --noEmit` then `pnpm lint`
Expected: no errors; lint reports the one warning it had before this branch and nothing new. (Only the test file is TypeScript; the SQL is checked by the controller.)

Run: `grep -c "errcode = 'FIN1[45]'" supabase/migrations/20261028100000_bendahara_cash_book.sql`
Expected: `19` as first written; `23` after the fixes to Task 1's review.

Run: `grep -c "security_invoker = true" supabase/migrations/20261028100000_bendahara_cash_book.sql` and `grep -c "service_role" supabase/migrations/20261028100000_bendahara_cash_book.sql`
Expected: `3` (the three views) and `2` (two comments; nothing is granted to it).

- [ ] **Step 9: Commit**

```bash
git add supabase/migrations/20261028100000_bendahara_cash_book.sql supabase/migrations/20261028100100_bendahara_cash_book_seed.sql supabase/tests/bendahara_cash_book_check.sql tests/bendahara-cash-book.test.ts
git commit -m "feat: expenses, the cash book views and the approval rule for finance"
```

**Controller gate. Tasks 2 to 6 can be built while it is open, but nothing merges until step 13 has passed.**

- [ ] **Step 10 (controller): Dry-run the schema migration on the hosted database**

First confirm the database role can act as a signed-in user. With the `openkuasa-supabase` MCP `execute_sql`:

```sql
do $$ begin set local role authenticated; reset role; raise exception 'ROLE_SWITCH_OK'; end $$;
```

Expected: an error whose message is `ROLE_SWITCH_OK`. A permission error instead means the check cannot run this way: stop and tell the owner.

Then send, in one `execute_sql` call: `begin;`, the "before" block, the whole of `supabase/migrations/20261028100000_bendahara_cash_book.sql`, the "after" block, the whole of `supabase/tests/bendahara_cash_book_check.sql`, and `rollback;`.

Before the migration:

<!-- controller-sql: dry_before -->
```sql
create temp table before_bills on commit drop as
select id, total, paid, balance, display_status from public.supplier_bill_totals;
create temp table before_out on commit drop as
select allocation_id, amount, transaction_amount, status, number, bill_no from public.finance_payments_out;
create temp table before_invoices on commit drop as
select id, subtotal, sst, total, paid, credited, refunded, balance, display_status, status, invoice_no from public.finance_invoice_totals;
create temp table before_in on commit drop as
select allocation_id, amount, transaction_amount, status, number, invoice_no from public.finance_payments_in;
create temp table before_refunds on commit drop as
select allocation_id, amount, transaction_amount, status, number, reason, invoice_no, credit_note_no from public.finance_refunds;
create temp table before_notes on commit drop as
select id, amount, status, refunded, credit_note_no from public.finance_credit_note_totals;
create temp table before_txns on commit drop as
select id, direction, status, amount, number, contact_id, party_name, category_id, approved_by, approved_at, transfer_id
from public.finance_transactions;
```

After the migration:

<!-- controller-sql: dry_after -->
```sql
do $$
declare n integer;
begin
  select count(*) into n
  from before_bills x full join public.supplier_bill_totals t on t.id = x.id
  where (t.total, t.paid, t.balance, t.display_status) is distinct from (x.total, x.paid, x.balance, x.display_status);
  if n <> 0 then raise exception 'DRYRUN FAILED: % bills read differently after the migration', n; end if;
  select count(*) into n
  from before_out x full join public.finance_payments_out t on t.allocation_id = x.allocation_id
  where (t.amount, t.transaction_amount, t.status, t.number, t.bill_no)
        is distinct from (x.amount, x.transaction_amount, x.status, x.number, x.bill_no);
  if n <> 0 then raise exception 'DRYRUN FAILED: % payment-out rows read differently after the migration', n; end if;
  select count(*) into n
  from before_invoices x full join public.finance_invoice_totals t on t.id = x.id
  where (t.subtotal, t.sst, t.total, t.paid, t.credited, t.refunded, t.balance, t.display_status, t.status, t.invoice_no)
        is distinct from (x.subtotal, x.sst, x.total, x.paid, x.credited, x.refunded, x.balance, x.display_status, x.status, x.invoice_no);
  if n <> 0 then raise exception 'DRYRUN FAILED: % invoices read differently after the migration', n; end if;
  select count(*) into n
  from before_in x full join public.finance_payments_in t on t.allocation_id = x.allocation_id
  where (t.amount, t.transaction_amount, t.status, t.number, t.invoice_no)
        is distinct from (x.amount, x.transaction_amount, x.status, x.number, x.invoice_no);
  if n <> 0 then raise exception 'DRYRUN FAILED: % payment-in rows read differently after the migration', n; end if;
  select count(*) into n
  from before_refunds x full join public.finance_refunds t on t.allocation_id = x.allocation_id
  where (t.amount, t.transaction_amount, t.status, t.number, t.reason, t.invoice_no, t.credit_note_no)
        is distinct from (x.amount, x.transaction_amount, x.status, x.number, x.reason, x.invoice_no, x.credit_note_no);
  if n <> 0 then raise exception 'DRYRUN FAILED: % refund rows read differently after the migration', n; end if;
  select count(*) into n
  from before_notes x full join public.finance_credit_note_totals t on t.id = x.id
  where (t.amount, t.status, t.refunded, t.credit_note_no) is distinct from (x.amount, x.status, x.refunded, x.credit_note_no);
  if n <> 0 then raise exception 'DRYRUN FAILED: % credit notes read differently after the migration', n; end if;
  -- The migration writes to no payment: every row of the table is as it was.
  select count(*) into n
  from before_txns x full join public.finance_transactions t on t.id = x.id
  where (t.direction, t.status, t.amount, t.number, t.contact_id, t.party_name, t.category_id, t.approved_by, t.approved_at, t.transfer_id)
        is distinct from (x.direction, x.status, x.amount, x.number, x.contact_id, x.party_name, x.category_id, x.approved_by, x.approved_at, x.transfer_id);
  if n <> 0 then raise exception 'DRYRUN FAILED: % payments were changed by the migration', n; end if;
  -- The two new views list every movement of money once, and nothing else.
  select (select count(*) from public.finance_payment_vouchers)
       - (select count(*) from public.finance_transactions where direction = 'out' and transfer_id is null) into n;
  if n <> 0 then raise exception 'DRYRUN FAILED: Payment Vouchers is % rows away from the payments out it should list', n; end if;
  select (select count(*) from public.finance_cash_receipts)
       - (select count(*) from public.finance_transactions where direction = 'in' and transfer_id is null) into n;
  if n <> 0 then raise exception 'DRYRUN FAILED: Cash Receipts is % rows away from the payments in it should list', n; end if;
  -- Before any expense or category voucher exists, a voucher is a supplier payment, a refund, or neither.
  select count(*) into n from public.finance_payment_vouchers v
   where v.kind is distinct from case
     when exists (select 1 from public.finance_payments_out p where p.transaction_id = v.transaction_id) then 'bill'
     when exists (select 1 from public.finance_refunds f where f.transaction_id = v.transaction_id) then 'refund'
     else 'other' end;
  if n <> 0 then raise exception 'DRYRUN FAILED: % vouchers are not the kind their own screen says', n; end if;
  select count(*) into n from public.finance_expenses;
  if n <> 0 then raise exception 'DRYRUN FAILED: finance_expenses has % rows before any expense exists', n; end if;
end $$;
```

Expected: an error whose message is `BENDAHARA_CASH_BOOK_CHECK PASSED (everything rolled back)`. A `NOTE:` after it means deleting the check's own users was stopped by something outside finance and `created_by` was cleared by hand instead; read it, it is not a failure.

- `DRYRUN FAILED: …` means existing bills, payments out, invoices, payments in, refunds or credit notes read differently after the migration, a payment row was changed by it, or the two new views do not list exactly the payments there are. Stop: a guard or a view is wrong. This is the comparison that protects production's live screens; do not go on with it failing.
- `BENDAHARA_CASH_BOOK_CHECK FAILED: …` lists each expectation that did not hold, separated by ` | `.
- Any other error message that is not `PASSED` is a failure too: the script ends at the first statement that should have worked and did not (a function that refused, a guard that raised), and the message is that statement's own, with the line of the script in its context.
- `constraint "finance_allocations_one_document_check" of relation "finance_allocations" does not exist` means the hosted constraint has another name. Run `select conname, pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.finance_allocations'::regclass and contype = 'c';` and change the migration's `drop constraint` to match.
- `check constraint "finance_transactions_party_check" of relation "finance_transactions" is violated by some row` means something has written `party_name` on a payment that also has a contact. Nothing in the app does. Run `select id, org_id, contact_id, party_name from public.finance_transactions where contact_id is not null and party_name is not null;` and take the result to the owner before changing anything.
- `canceling statement due to lock timeout` means a long transaction held one of the finance tables for more than five seconds. Nothing was changed; run it again.
- An error on the insert into `auth.users` or `public.orgs` is the script's own set-up, not the migration: add the column the message names and run again.

On any failure: fix the file on the branch, commit the fix, and dry-run again from the top. Nothing has been applied, so the migration file itself is edited.

Then confirm nothing was left: `select to_regclass('public.finance_expenses') is null;` → `true`.

Then send, in one `execute_sql` call: `begin;`, the whole schema migration, the whole of `supabase/tests/bendahara_followons_check.sql`, and `rollback;`. Expected: `BENDAHARA_FOLLOWONS_CHECK PASSED (everything rolled back)`. And the same with `supabase/tests/bendahara_invoices_check.sql`. Expected: `BENDAHARA_INVOICES_CHECK PASSED (everything rolled back)`. These two are the proof that invoices, bills, quotations, credit notes and refunds run through the replaced guards as they did; if the branch's copy of either script has gained tests from another change, use the branch's copy.

What the new check covers, for the record. An expense saved by an editor (pending) and by an owner (approved at once); what saving refuses; an editor who cannot approve or reject, in their own name or another's; an approved expense that is locked; paying it in two parts by an editor with no second approval, a sen too much refused, Paid once covered; mixed kinds on one payment, both ways round; rejecting an approved expense only once its payments are voided; a rejected expense edited back to pending and kept as a record. A voucher that settles no document: recorded by an editor it waits; everything an editor cannot then do to it, and cannot do behind the function; approved by an owner as it was submitted; paid as approved by an editor; recorded by an owner, paid or scheduled at once; a rejected one that stays rejected. A cash receipt: a draft for income, edited, posted by an editor, locked, voided; a draft for two invoices that holds their balance, saved again for less, posted; the same money once on Payments In and once on Cash Receipts; a draft posted after its invoice was credited in full, which leaves the customer in credit. One voucher for a payment across two bills; a refund as a voucher; an editor's supplier payment not held; both views against the table, row for row and by kind; a transfer left out. A viewer, another workspace, a session with no user, a migration with none. Deleting the users who made and approved the rows; deleting the workspace with all of it inside.

- [ ] **Step 11 (controller): Dry-run the seed**

First read what the demo workspace has today, which the seed must not move:

```sql
select
  (select sum(balance) from public.finance_invoice_totals t where t.org_id = o.id and t.display_status in ('sent','overdue')) as receivable,
  (select count(*) from public.finance_payments_in p where p.org_id = o.id) as payments_in_rows,
  (select count(*) from public.finance_refunds r where r.org_id = o.id) as refund_rows,
  (select count(*) from public.finance_payments_out p where p.org_id = o.id) as payments_out_rows,
  (select sum(paid) from public.supplier_bill_totals b where b.org_id = o.id) as bills_paid,
  (select count(*) from public.finance_transactions x where x.org_id = o.id and x.direction = 'out') as money_out,
  (select count(*) from public.finance_transactions x where x.org_id = o.id and x.direction = 'in') as money_in,
  (select string_agg(doc_type || '=' || next_number, ', ' order by doc_type)
     from public.finance_sequences s where s.org_id = o.id and s.doc_type in ('receipt','voucher')) as sequences
from public.orgs o where o.slug = 'rimba-ventures-demo';
```

Then send, in one `execute_sql` call: `begin;`, the whole schema migration, the whole of `supabase/migrations/20261028100100_bendahara_cash_book_seed.sql` **twice**, this block, and `rollback;`.

<!-- controller-sql: seed_summary -->
```sql
do $$
declare
  demo uuid;
  r text;
begin
  select id into demo from public.orgs where slug = 'rimba-ventures-demo';
  select format(
    'expenses=%s (%s) RM %s | vouchers=%s (%s) | by status: %s | receipts=%s (%s) | by status: %s | '
    || 'approved without a name=%s | receivable=%s, payments in=%s rows, refunds=%s rows, payments out=%s rows, bills paid=%s | sequences: %s',
    (select count(*) from public.finance_expense_totals where org_id = demo),
    (select string_agg(display_status || '=' || n, ', ' order by display_status)
       from (select display_status, count(*) n from public.finance_expense_totals where org_id = demo group by 1) s),
    (select sum(amount) from public.finance_expense_totals where org_id = demo and status = 'approved'),
    (select count(*) from public.finance_payment_vouchers where org_id = demo),
    (select string_agg(kind || '=' || n, ', ' order by kind)
       from (select kind, count(*) n from public.finance_payment_vouchers where org_id = demo group by 1) s),
    (select string_agg(status || '=' || n || ' RM ' || total, ', ' order by status)
       from (select status, count(*) n, sum(amount) total from public.finance_payment_vouchers
              where org_id = demo and kind in ('expense','other') group by 1) s),
    (select count(*) from public.finance_cash_receipts where org_id = demo),
    (select string_agg(kind || '=' || n, ', ' order by kind)
       from (select kind, count(*) n from public.finance_cash_receipts where org_id = demo group by 1) s),
    (select string_agg(status || '=' || n || ' RM ' || total, ', ' order by status)
       from (select status, count(*) n, sum(amount) total from public.finance_cash_receipts
              where org_id = demo and kind = 'income' group by 1) s),
    (select count(*) from public.finance_transactions where org_id = demo and approved_at is not null and approved_by is null),
    (select sum(balance) from public.finance_invoice_totals where org_id = demo and display_status in ('sent','overdue')),
    (select count(*) from public.finance_payments_in where org_id = demo),
    (select count(*) from public.finance_refunds where org_id = demo),
    (select count(*) from public.finance_payments_out where org_id = demo),
    (select sum(paid) from public.supplier_bill_totals where org_id = demo),
    (select string_agg(doc_type || '=' || next_number, ', ' order by doc_type)
       from public.finance_sequences where org_id = demo and doc_type in ('receipt','voucher')))
  into r;
  raise exception 'SEED DRYRUN, rolling back: %', r;
end $$;
```

Expected: an error starting `SEED DRYRUN, rolling back:` in which:

- `expenses=23 (approved=1, paid=19, pending=2, rejected=1) RM 87910.00`
- `vouchers=` is the demo's `money_out` plus 25, and among the kinds `expense=19` and `other=6`; `bill=` and `refund=` are what the demo had (4 and 6 if it holds exactly what the repository's seeds gave it)
- `by status: pending_approval=2 RM 4340.00, posted=21 RM 87210.00, rejected=1 RM 75.00, scheduled=1 RM 960.00`
- `receipts=` is the demo's `money_in` plus 7, with `income=7`; `invoice=` is what the demo had
- `by status: draft=1 RM 2180.00, posted=6 RM 4444.20`
- `approved without a name=4`
- `receivable=`, `payments in=`, `refunds=`, `payments out=` and `bills paid=` are **exactly** the five figures read before. The seed must not move any of them.
- `sequences:` has `receipt=` 6 more than it was and `voucher=` 21 more than it was.

On a database that holds exactly what the repository's seeds give the demo, the whole line reads:

`expenses=23 (approved=1, paid=19, pending=2, rejected=1) RM 87910.00 | vouchers=35 (bill=4, expense=19, other=6, refund=6) | by status: pending_approval=2 RM 4340.00, posted=21 RM 87210.00, rejected=1 RM 75.00, scheduled=1 RM 960.00 | receipts=21 (income=7, invoice=14) | by status: draft=1 RM 2180.00, posted=6 RM 4444.20 | approved without a name=4 | receivable=20460.00, payments in=14 rows, refunds=6 rows, payments out=4 rows, bills paid=2749.00 | sequences: receipt=115, voucher=26`

Running the seed twice and still counting 23, 19 and 7 is the proof it does nothing the second time. Other readings:

- `expenses=0` means the demo workspace was not found by its slug.
- The seed ending in `FIN14` means an approval rule refused a seeded row: `auth.uid()` is not null in the session the migration runs in. Stop and tell the owner; the seed relies on a migration having no signed-in user (Decision 3).
- The seed ending in `null value in column "category_id"` means the demo workspace has lost one of the nine default categories by name. Run `select name, kind from public.finance_categories c join public.orgs o on o.id = c.org_id where o.slug = 'rimba-ventures-demo' order by 2, 1;` and compare with `private.finance_seed_categories`.
- Any of the five figures moving: stop. The seed puts nothing against an invoice or a bill, so none of them can move unless a view is wrong.

- [ ] **Step 12 (controller): Apply the schema migration, on the owner's explicit go-ahead**

Stop and ask the owner first. Apply `20261028100000_bendahara_cash_book.sql` with `apply_migration`, name `bendahara_cash_book`. One `apply_migration` call at a time.

- [ ] **Step 13 (controller): Check the applied schema**

Send the whole of `supabase/tests/bendahara_cash_book_check.sql` by itself with `execute_sql`.
Expected: `BENDAHARA_CASH_BOOK_CHECK PASSED (everything rolled back)`.

Send the whole of `supabase/tests/bendahara_followons_check.sql` by itself, then the whole of `supabase/tests/bendahara_invoices_check.sql` by itself.
Expected: `BENDAHARA_FOLLOWONS_CHECK PASSED (everything rolled back)` and `BENDAHARA_INVOICES_CHECK PASSED (everything rolled back)`.

Confirm the functions in the database are the file's, body for body:

```sql
select n.nspname || '.' || p.proname as fn, md5(p.prosrc) as body
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where (n.nspname, p.proname) in (
  ('private','finance_may_decide'), ('private','finance_expense_guard'), ('private','finance_transaction_insert_guard'),
  ('private','finance_transaction_guard'), ('private','finance_allocation_guard'), ('public','finance_mark_payment_paid'),
  ('public','finance_save_cash_receipt'), ('public','finance_post_cash_receipt'), ('public','finance_record_voucher'),
  ('public','finance_save_expense'))
order by 1;
```

Expected: ten rows, with these values. They are `md5` of the text between each function's `$$` in the migration as this plan has it, as Postgres stores it; they do not depend on the Postgres version.

| Function | `md5(prosrc)` |
|---|---|
| `private.finance_allocation_guard` | `03851a3b3508c1efdeaf4c66ad51b6a9` |
| `private.finance_expense_guard` | `6116138cb802525a8d1bd772fa2505d4` |
| `private.finance_may_decide` | `7119efd06d4983de6b70b357d1d274d4` |
| `private.finance_transaction_guard` | `f0e431492300eb490c35cb22ca4227ea` |
| `private.finance_transaction_insert_guard` | `83ee812b8727dcabf18844013fd6c9ab` |
| `public.finance_mark_payment_paid` | `9dde60c90118d944d0e80066a940f788` |
| `public.finance_post_cash_receipt` | `0d770dcb8208c26605ca150af28cc358` |
| `public.finance_record_voucher` | `00dd9028c05c52822aa51432a357a6d9` |
| `public.finance_save_cash_receipt` | `7eed22450322e4136acb4c6a4254dc45` |
| `public.finance_save_expense` | `48317b9e89d497b6f10295d81b56db0a` |

A different value means the function in the database is not the one in this plan's file. If the migration file was changed on the branch after a review, that is expected: apply the branch's file to any scratch Postgres 15 or later, run the same query there, and compare with that instead. Fewer than ten rows means a function is missing, and more means an overload exists: `select oid::regprocedure from pg_proc where proname = 'finance_mark_payment_paid';` should answer one row.

Open production's Invoices, Payments In, Refunds, Supplier Bills and Payments Out in the demo workspace: the same figures as before the migration. Record a payment on an open bill in the smoke workspace and void it; record a payment on an open invoice and void it: both still work. (Production is still on the old code; this is the old code running under the new guards.)

Run: `pnpm exec vitest run tests/bendahara-purchases.test.ts tests/bendahara-foundation.rls.test.ts tests/bendahara-sales.test.ts tests/bendahara-followons.test.ts tests/bendahara-cash-book.test.ts`
Expected: every test in the first four files passes, **unchanged from before this stage**: that is the proof the replaced guards treat bills, invoices, credit notes and refunds as they did. In `tests/bendahara-cash-book.test.ts` every test passes except the last, 'a demo viewer reads the seeded cash book, and can write none of it', which fails until step 14. Each file deletes the users and workspaces it made when it finishes.

If a test fails for a reason in the SQL: the migration is applied now, so the fix is a new corrective migration file, never an edit to the applied one.

- [ ] **Step 14 (controller): Apply the seed**

With the owner's go-ahead, apply `20261028100100_bendahara_cash_book_seed.sql` with `apply_migration`, name `bendahara_cash_book_seed`. It can go in now, before the new code is deployed: no screen that is live today reads an expense, a voucher that settles no document, or a receipt for income, and the five figures of step 11 do not move.

Run: `pnpm exec vitest run tests/bendahara-cash-book.test.ts tests/bendahara-followons.test.ts tests/bendahara-sales.test.ts tests/bendahara-purchases.test.ts`
Expected: PASS, every test, in all four files.

Open production's Invoices, Payments In, Refunds, Supplier Bills, Payments Out and Customers & Suppliers in the demo workspace once more: the same figures as before the seed.

---

### Task 2: Reading the cash book and the expenses

**Files:**
- Create: `tests/finance-cash-book.test.ts`
- Create: `src/lib/finance/cash-book.ts`
- Create: `src/lib/finance/expenses.ts`

**Interfaces:**
- Consumes: `PAYMENT_PAGE_SIZE`, `PaymentInRow`, `PaymentMethod` from `./money` (unchanged); `FinanceWriteContext` from `./result`; `fakeFinance` and `FinanceCall` from `tests/setup/fake-finance.ts`; the views `finance_cash_receipts`, `finance_payment_vouchers` and `finance_expense_totals` (Task 1).
- Produces, from `cash-book.ts`:
  - `type CashBookStatus = PaymentInRow['status']` (the six statuses of `finance_transactions`)
  - `type CashReceiptKind = 'invoice' | 'income'`
  - `type CashReceiptRow = { transaction_id: string; number: string | null; txn_date: string; method: PaymentMethod; amount: number; status: CashBookStatus; reference: string | null; notes: string | null; account_id: string; account_name: string; account_kind: 'bank' | 'cash'; contact_id: string | null; party_name: string | null; kind: CashReceiptKind; category_id: string | null; category_name: string | null; documents: string | null }`
  - `type PaymentVoucherKind = 'bill' | 'refund' | 'expense' | 'other'`
  - `type PaymentVoucherRow`: the fields of `CashReceiptRow` with `kind: PaymentVoucherKind`, plus `approved_at: string | null`
  - `listCashReceipts(ctx: FinanceWriteContext): Promise<CashReceiptRow[]>`
  - `listPaymentVouchers(ctx: FinanceWriteContext): Promise<PaymentVoucherRow[]>`
- Produces, from `expenses.ts`:
  - `type ExpenseStatus = 'pending' | 'approved' | 'rejected'`, `type ExpenseDisplayStatus = ExpenseStatus | 'paid'`
  - `EXPENSE_PAGE_SIZE = 1000`
  - `type ExpenseRow = { id: string; expense_date: string; category_id: string; category_name: string; vendor_id: string | null; vendor_name: string; amount: number; sst_amount: number; notes: string | null; status: ExpenseStatus; display_status: ExpenseDisplayStatus; paid: number; held: number; method: PaymentMethod | null; paid_on: string | null }`
  - `listExpenses(ctx: FinanceWriteContext): Promise<ExpenseRow[]>`

These two files only read. No Zod schema and no write function is added in this stage, so `tests/finance-schemas.test.ts` is not touched: each write function arrives with the form and the server action that call it (see "Later parts of stage 5"). A read that fails throws, as every list function in `src/lib/finance/` does, and `src/app/(app)/finance/error.tsx` is what a person then sees.

A row is keyed by `transaction_id` on the two cash book views and by `id` on expenses: one row per movement of money, never one per document it pays.

- [ ] **Step 1: Write the failing tests**

Create `tests/finance-cash-book.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { listCashReceipts, listPaymentVouchers } from '@/lib/finance/cash-book';
import { EXPENSE_PAGE_SIZE, listExpenses } from '@/lib/finance/expenses';
import { PAYMENT_PAGE_SIZE } from '@/lib/finance/money';
import { type FinanceCall, fakeFinance } from './setup/fake-finance';

// PostgREST answers a numeric column as a string when it is large, and as a number otherwise.
const receiptRow = {
  transaction_id: 't1', number: 'RC-0001', txn_date: '2026-10-05', method: 'cash', amount: '80.00', status: 'posted',
  reference: null, notes: null, account_id: 'a1', account_name: 'Cash in hand', account_kind: 'cash', contact_id: null,
  party_name: 'Walk-in', kind: 'income', category_id: 'c1', category_name: 'Sales', documents: null,
};
const voucherRow = {
  transaction_id: 't2', number: null, txn_date: '2026-10-06', method: 'fpx', amount: '300.00', status: 'pending_approval',
  reference: 'ACC 1', notes: null, account_id: 'a2', account_name: 'Main Bank', account_kind: 'bank', contact_id: null,
  party_name: 'Water board', kind: 'other', category_id: 'c2', category_name: 'Utilities', documents: null, approved_at: null,
};
const expenseRow = {
  id: 'e1', expense_date: '2026-10-04', category_id: 'c3', category_name: 'Rent', vendor_id: null, vendor_name: 'Landlord',
  amount: '4500.00', sst_amount: '0.00', notes: null, status: 'approved', display_status: 'paid', paid: '4500.00', held: '0.00',
  method: 'bank_transfer', paid_on: '2026-10-04',
};

describe('listCashReceipts', () => {
  it('reads the receipts view for the workspace, newest first, with amounts as numbers', async () => {
    const { ctx, calls } = fakeFinance({ data: [receiptRow], error: null });
    expect(await listCashReceipts(ctx)).toEqual([{ ...receiptRow, amount: 80 }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      kind: 'table', name: 'finance_cash_receipts', op: 'select', filters: { org_id: 'org-1' },
      order: ['txn_date desc', 'transaction_id asc'], range: [0, PAYMENT_PAGE_SIZE - 1],
    });
    // Every column the row type has, and nothing the view does not have.
    expect(calls[0].columns!.split(',').sort()).toEqual(Object.keys(receiptRow).sort());
  });
  it('reads on until a page comes back short', async () => {
    const full = Array.from({ length: PAYMENT_PAGE_SIZE }, (_, i) => ({ ...receiptRow, transaction_id: `t${i}` }));
    const pages = (call: FinanceCall) => ({ data: call.range![0] === 0 ? full : [receiptRow], error: null });
    const { ctx, calls } = fakeFinance(pages);
    expect(await listCashReceipts(ctx)).toHaveLength(PAYMENT_PAGE_SIZE + 1);
    expect(calls.map((c) => c.range)).toEqual([[0, PAYMENT_PAGE_SIZE - 1], [PAYMENT_PAGE_SIZE, 2 * PAYMENT_PAGE_SIZE - 1]]);
  });
  it('answers with no rows when the view has none, and throws when it cannot be read', async () => {
    expect(await listCashReceipts(fakeFinance({ data: null, error: null }).ctx)).toEqual([]);
    await expect(listCashReceipts(fakeFinance({ data: null, error: { code: '42501' } }).ctx)).rejects.toEqual({ code: '42501' });
  });
});

describe('listPaymentVouchers', () => {
  it('reads the vouchers view, with when it was approved', async () => {
    const { ctx, calls } = fakeFinance({ data: [voucherRow], error: null });
    expect(await listPaymentVouchers(ctx)).toEqual([{ ...voucherRow, amount: 300 }]);
    expect(calls[0]).toMatchObject({
      name: 'finance_payment_vouchers', filters: { org_id: 'org-1' }, order: ['txn_date desc', 'transaction_id asc'],
    });
    expect(calls[0].columns!.split(',').sort()).toEqual(Object.keys(voucherRow).sort());
  });
  it('never reads the payments table itself, nor the screens that show part of it', async () => {
    const { ctx, calls } = fakeFinance({ data: [], error: null });
    await listPaymentVouchers(ctx);
    await listCashReceipts(ctx);
    expect(calls.map((c) => c.name)).toEqual(['finance_payment_vouchers', 'finance_cash_receipts']);
  });
  it('throws when the view cannot be read', async () => {
    await expect(listPaymentVouchers(fakeFinance({ data: null, error: { code: 'XX000' } }).ctx)).rejects.toEqual({ code: 'XX000' });
  });
});

describe('listExpenses', () => {
  it('reads the expense totals for the workspace, newest first, with every amount as a number', async () => {
    const { ctx, calls } = fakeFinance({ data: [expenseRow], error: null });
    expect(await listExpenses(ctx)).toEqual([{ ...expenseRow, amount: 4500, sst_amount: 0, paid: 4500, held: 0 }]);
    expect(calls[0]).toMatchObject({
      kind: 'table', name: 'finance_expense_totals', op: 'select', filters: { org_id: 'org-1' },
      order: ['expense_date desc', 'id asc'], range: [0, EXPENSE_PAGE_SIZE - 1],
    });
    expect(calls[0].columns!.split(',').sort()).toEqual(Object.keys(expenseRow).sort());
  });
  it('reads on until a page comes back short, and throws when it cannot be read', async () => {
    const full = Array.from({ length: EXPENSE_PAGE_SIZE }, (_, i) => ({ ...expenseRow, id: `e${i}` }));
    const pages = (call: FinanceCall) => ({ data: call.range![0] === 0 ? full : [], error: null });
    const paged = fakeFinance(pages);
    expect(await listExpenses(paged.ctx)).toHaveLength(EXPENSE_PAGE_SIZE);
    expect(paged.calls).toHaveLength(2);
    await expect(listExpenses(fakeFinance({ data: null, error: { code: '42501' } }).ctx)).rejects.toEqual({ code: '42501' });
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm exec vitest run tests/finance-cash-book.test.ts`
Expected: FAIL, the file cannot be loaded: `@/lib/finance/cash-book` does not exist.

- [ ] **Step 3: Write `src/lib/finance/cash-book.ts`**

Create `src/lib/finance/cash-book.ts`:

```ts
/**
 * The cash book: every movement of money, one row each. Cash Receipts lists
 * money in and Payment Vouchers money out, whatever it is for, so a payment
 * that Payments In, Payments Out or Refunds shows per document is one row
 * here. `kind` says what a row is and therefore which screen changes it.
 * This file only reads; the writes arrive with the forms. org_id comes from
 * the context.
 */
import { PAYMENT_PAGE_SIZE, type PaymentInRow, type PaymentMethod } from './money';
import type { FinanceWriteContext } from './result';

/** A movement of money is a `finance_transactions` row, and takes that table's statuses. */
export type CashBookStatus = PaymentInRow['status'];

/** `invoice`: a payment against invoices, also on Payments In. `income`: money that settles no invoice and carries a category. */
export type CashReceiptKind = 'invoice' | 'income';

/** One movement of money in. `transaction_id` is the row's key. A draft or voided receipt is included; callers filter. */
export type CashReceiptRow = {
  transaction_id: string;
  number: string | null;
  txn_date: string;
  method: PaymentMethod;
  amount: number;
  status: CashBookStatus;
  reference: string | null;
  notes: string | null;
  account_id: string;
  account_name: string;
  account_kind: 'bank' | 'cash';
  contact_id: string | null;
  /** Who paid: the contact's name, or the name that was typed. Nobody may be named. */
  party_name: string | null;
  kind: CashReceiptKind;
  category_id: string | null;
  category_name: string | null;
  /** The numbers of the invoices it pays, in order, separated by ", ". */
  documents: string | null;
};

/**
 * `bill`: a payment to a supplier, also on Payments Out. `refund`: money back
 * to a customer, also on Refunds. `expense`: a payment of approved expenses.
 * `other`: money that settles no document and carries a category.
 */
export type PaymentVoucherKind = 'bill' | 'refund' | 'expense' | 'other';

/** One movement of money out. `transaction_id` is the row's key. Every status is included; callers filter. */
export type PaymentVoucherRow = {
  transaction_id: string;
  number: string | null;
  txn_date: string;
  method: PaymentMethod;
  amount: number;
  status: CashBookStatus;
  reference: string | null;
  notes: string | null;
  account_id: string;
  account_name: string;
  account_kind: 'bank' | 'cash';
  contact_id: string | null;
  /** Who was paid: the contact's name, or the name that was typed. */
  party_name: string | null;
  kind: PaymentVoucherKind;
  category_id: string | null;
  /** The voucher's own category, or the one its expenses share; nothing for a bill, a refund, or expenses of several categories. */
  category_name: string | null;
  /** The numbers of the bills, invoices or credit notes it pays; an expense has no number. */
  documents: string | null;
  /** When an owner or admin approved or rejected it; null for a payment nobody had to approve. */
  approved_at: string | null;
};

const SHARED_COLUMNS =
  'transaction_id,number,txn_date,method,amount,status,reference,notes,account_id,account_name,account_kind,' +
  'contact_id,party_name,kind,category_id,category_name,documents';
const CASH_RECEIPT_COLUMNS = SHARED_COLUMNS;
const PAYMENT_VOUCHER_COLUMNS = `${SHARED_COLUMNS},approved_at`;

/** Every row of one of the two cash book views, newest first, read a page at a time. */
async function listCashBookRows<T extends { amount: number }>(
  ctx: FinanceWriteContext,
  view: 'finance_cash_receipts' | 'finance_payment_vouchers',
  columns: string,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAYMENT_PAGE_SIZE) {
    const { data, error } = await ctx.client
      .from(view)
      .select(columns)
      .eq('org_id', ctx.orgId)
      .order('txn_date', { ascending: false })
      .order('transaction_id', { ascending: true })
      .range(from, from + PAYMENT_PAGE_SIZE - 1);
    if (error) throw error;
    const page = (data ?? []) as unknown as Record<string, unknown>[];
    rows.push(...page.map((row) => ({ ...(row as unknown as T), amount: Number(row.amount) })));
    if (page.length < PAYMENT_PAGE_SIZE) return rows;
  }
}

/** Every movement of money in. */
export async function listCashReceipts(ctx: FinanceWriteContext): Promise<CashReceiptRow[]> {
  return listCashBookRows<CashReceiptRow>(ctx, 'finance_cash_receipts', CASH_RECEIPT_COLUMNS);
}

/** Every movement of money out. */
export async function listPaymentVouchers(ctx: FinanceWriteContext): Promise<PaymentVoucherRow[]> {
  return listCashBookRows<PaymentVoucherRow>(ctx, 'finance_payment_vouchers', PAYMENT_VOUCHER_COLUMNS);
}
```

- [ ] **Step 4: Write `src/lib/finance/expenses.ts`**

Create `src/lib/finance/expenses.ts`:

```ts
/**
 * Expenses. An expense is one `finance_expenses` row: a date, a category, a
 * vendor (a contact or a typed name) and an amount with the SST inside it.
 * An owner or admin approves or rejects it, and an approved one is paid by a
 * payment voucher. This file only reads; the writes arrive with the form.
 * org_id comes from the context.
 */
import type { PaymentMethod } from './money';
import type { FinanceWriteContext } from './result';

/** What a person sets. */
export type ExpenseStatus = 'pending' | 'approved' | 'rejected';

/** How an expense reads: `paid` once posted money out covers an approved one. Never stored. */
export type ExpenseDisplayStatus = ExpenseStatus | 'paid';

export const EXPENSE_PAGE_SIZE = 1000;

export type ExpenseRow = {
  id: string;
  expense_date: string;
  category_id: string;
  category_name: string;
  vendor_id: string | null;
  vendor_name: string;
  /** What was paid or is to be paid, SST included. */
  amount: number;
  /** The part of `amount` that is SST. */
  sst_amount: number;
  notes: string | null;
  status: ExpenseStatus;
  display_status: ExpenseDisplayStatus;
  /** Posted money out against it. */
  paid: number;
  /** What payments not yet posted hold of it. */
  held: number;
  /** How the latest posted payment was made; null while nothing has been paid. */
  method: PaymentMethod | null;
  paid_on: string | null;
};

const EXPENSE_COLUMNS =
  'id,expense_date,category_id,category_name,vendor_id,vendor_name,amount,sst_amount,notes,status,display_status,' +
  'paid,held,method,paid_on';

/** Every expense in the workspace, newest first, read a page at a time. */
export async function listExpenses(ctx: FinanceWriteContext): Promise<ExpenseRow[]> {
  const rows: ExpenseRow[] = [];
  for (let from = 0; ; from += EXPENSE_PAGE_SIZE) {
    const { data, error } = await ctx.client
      .from('finance_expense_totals')
      .select(EXPENSE_COLUMNS)
      .eq('org_id', ctx.orgId)
      .order('expense_date', { ascending: false })
      .order('id', { ascending: true })
      .range(from, from + EXPENSE_PAGE_SIZE - 1);
    if (error) throw error;
    const page = (data ?? []) as unknown as Record<string, unknown>[];
    rows.push(
      ...page.map((row) => ({
        ...(row as unknown as ExpenseRow),
        amount: Number(row.amount),
        sst_amount: Number(row.sst_amount),
        paid: Number(row.paid),
        held: Number(row.held),
      })),
    );
    if (page.length < EXPENSE_PAGE_SIZE) return rows;
  }
}
```

- [ ] **Step 5: Run the tests**

Run: `pnpm exec vitest run tests/finance-cash-book.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Type-check, lint and commit**

Run: `pnpm exec tsc --noEmit` then `pnpm lint`
Expected: no errors; lint reports the one warning it had before this branch and nothing new.

Run: `grep -n -E "supabase/server|next/headers|server-only" src/lib/finance/cash-book.ts src/lib/finance/expenses.ts`
Expected: no output.

```bash
git add src/lib/finance/cash-book.ts src/lib/finance/expenses.ts tests/finance-cash-book.test.ts
git commit -m "feat: read cash receipts, payment vouchers and expenses"
```

---

### Task 3: Voiding a payment in asks Payments In first

**Files:**
- Modify: `tests/finance-payments-in.test.ts`
- Modify: `src/lib/finance/money.ts`

**Interfaces:**
- Consumes: the view `finance_payments_in` (unchanged); `fakeFinance` and `FinanceCall` from `tests/setup/fake-finance.ts`.
- Produces: no new name. `voidPaymentIn(ctx, { id }): Promise<FinResult<{ id: string }>>` keeps its signature and its sentences. It now makes two requests: it reads `finance_payments_in` for the workspace and the transaction, one row, and only when that view shows the payment does it send the update it sent before.

Why now. Until this stage every movement of money in was a payment against invoices, so `voidPaymentIn` could be kept to `direction = 'in'` and nothing else. The migration in Task 1 makes a second kind possible: a receipt for income that settles no invoice. Nothing in the app records one yet, but the demo seed does, and the forms part will. `voidPaymentInAction` is what the Payments In screen calls; it refreshes the sales screens and answers in the sentences of a payment against invoices. A receipt for income must not be voidable through it by a direct call with that receipt's id. This is the same protection `markPaymentPaid`, `voidPayment` and `deleteScheduledPayment` have had since stage 4b (`refusalUnlessPaymentOut`), and `markRefundPaid`, `voidRefund` and `deleteRefund` (`refusalUnlessRefund`).

What does not change: a draft receipt against invoices, which only the forms part can create, is on `finance_payments_in` with the status `draft`. Sent to `voidPaymentIn` by a direct call, the view shows it, the update is refused by the database with `FIN09`, and the answer is "This payment has already been voided.", which is not true of a draft. Payments In offers Void on a posted row only, and a posted payment never goes back to draft, so no button reaches that sentence. It is listed under Known limits in Task 6 and is the forms part's to reword when it adds drafts to the app.

- [ ] **Step 1: Write the failing tests**

In `tests/finance-payments-in.test.ts`, replace:

```ts
import { fakeFinance } from './setup/fake-finance';
```

with:

```ts
import { type FinanceAnswer, type FinanceCall, fakeFinance } from './setup/fake-finance';
```

In `tests/finance-payments-in.test.ts`, replace:

```ts
  it('is voided by one status change, kept to money in and to the workspace', async () => {
    const { ctx, calls } = fakeFinance({ data: { id: TXN }, error: null });
    expect(await voidPaymentIn(ctx, { id: TXN })).toEqual({ ok: true, data: { id: TXN } });
    expect(calls[0]).toMatchObject({ name: 'finance_transactions', op: 'update' });
    expect(calls[0].filters).toEqual({ id: TXN, org_id: 'org-1', direction: 'in' });
    expect(Object.keys(calls[0].values!).sort()).toEqual(['status', 'updated_at']);
    expect(calls[0].values).toMatchObject({ status: 'void' });
  });
  it('says a payment that is already void is already void, and never to void it', async () => {
    const { ctx } = fakeFinance({ data: null, error: { code: 'FIN09' } });
    const result = await voidPaymentIn(ctx, { id: TXN });
    expect(result).toEqual({ ok: false, error: 'This payment has already been voided.' });
    expect(JSON.stringify(result)).not.toContain('Void it');
  });
  it('says the payment is gone when voiding touches no row, and refuses an id that is not an id', async () => {
    const { ctx, calls } = fakeFinance({ data: null, error: null });
    expect(await voidPaymentIn(ctx, { id: TXN })).toEqual({ ok: false, error: 'That payment no longer exists.' });
    await expect(voidPaymentIn(ctx, { id: 'nope' })).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
```

with:

```ts
  /** Answers the payments-in check with a row (a payment against invoices) or none (any other money in), and the update with `other`. */
  const paymentInOr = (isPaymentIn: boolean, other: FinanceAnswer) => (call: FinanceCall) =>
    call.name === 'finance_payments_in' ? { data: isPaymentIn ? [{ transaction_id: TXN }] : [], error: null } : other;

  it('is voided by one status change, kept to money in and to the workspace, once Payments In shows it', async () => {
    const { ctx, calls } = fakeFinance(paymentInOr(true, { data: { id: TXN }, error: null }));
    expect(await voidPaymentIn(ctx, { id: TXN })).toEqual({ ok: true, data: { id: TXN } });
    expect(calls.map((c) => [c.name, c.op])).toEqual([['finance_payments_in', 'select'], ['finance_transactions', 'update']]);
    // One row is asked for: a payment split across invoices is several rows there.
    expect(calls[0]).toMatchObject({ filters: { org_id: 'org-1', transaction_id: TXN }, limit: 1 });
    expect(calls[1].filters).toEqual({ id: TXN, org_id: 'org-1', direction: 'in' });
    expect(Object.keys(calls[1].values!).sort()).toEqual(['status', 'updated_at']);
    expect(calls[1].values).toMatchObject({ status: 'void' });
  });
  it('refuses money in that is not a payment against an invoice, without writing', async () => {
    // A receipt for income that settles no invoice is money in too, and Payments In never shows it.
    const { ctx, calls } = fakeFinance(paymentInOr(false, { data: { id: TXN }, error: null }));
    expect(await voidPaymentIn(ctx, { id: TXN })).toEqual({ ok: false, error: 'That payment no longer exists.' });
    expect(calls.map((c) => [c.name, c.op])).toEqual([['finance_payments_in', 'select']]);
    // The same when the view answers with nothing at all.
    const empty = fakeFinance((call: FinanceCall) =>
      call.name === 'finance_payments_in' ? { data: null, error: null } : { data: { id: TXN }, error: null },
    );
    expect(await voidPaymentIn(empty.ctx, { id: TXN })).toEqual({ ok: false, error: 'That payment no longer exists.' });
    expect(empty.calls).toHaveLength(1);
  });
  it('writes nothing when the check cannot be read: a viewer is told they may not, anything else is logged', async () => {
    const refused = fakeFinance((call: FinanceCall) =>
      call.name === 'finance_payments_in' ? { data: null, error: { code: '42501' } } : { data: { id: TXN }, error: null },
    );
    expect(await voidPaymentIn(refused.ctx, { id: TXN })).toEqual({
      ok: false, error: 'You do not have permission to make changes here.',
    });
    expect(refused.calls).toHaveLength(1);
    expect(logged).not.toHaveBeenCalled();
    const broken = fakeFinance((call: FinanceCall) =>
      call.name === 'finance_payments_in' ? { data: null, error: { code: 'XX000' } } : { data: { id: TXN }, error: null },
    );
    expect(await voidPaymentIn(broken.ctx, { id: TXN })).toEqual({
      ok: false, error: 'That change could not be saved. Please try again.',
    });
    expect(broken.calls).toHaveLength(1);
    expect(logged).toHaveBeenCalled();
  });
  it('says a payment that is already void is already void, and never to void it', async () => {
    const { ctx, calls } = fakeFinance(paymentInOr(true, { data: null, error: { code: 'FIN09' } }));
    const result = await voidPaymentIn(ctx, { id: TXN });
    expect(result).toEqual({ ok: false, error: 'This payment has already been voided.' });
    expect(JSON.stringify(result)).not.toContain('Void it');
    expect(calls).toHaveLength(2);
  });
  it('says the payment is gone when voiding touches no row, and refuses an id that is not an id', async () => {
    const { ctx, calls } = fakeFinance(paymentInOr(true, { data: null, error: null }));
    expect(await voidPaymentIn(ctx, { id: TXN })).toEqual({ ok: false, error: 'That payment no longer exists.' });
    expect(calls).toHaveLength(2);
    await expect(voidPaymentIn(ctx, { id: 'nope' })).rejects.toThrow();
    // The id is refused before anything is read.
    expect(calls).toHaveLength(2);
  });
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm exec vitest run tests/finance-payments-in.test.ts`
Expected: FAIL. "is voided by one status change…" finds one request where it expects two; "refuses money in that is not a payment against an invoice" gets `{ ok: true, … }`. The other tests in the file pass.

- [ ] **Step 3: `src/lib/finance/money.ts`: read the view, then write**

In `src/lib/finance/money.ts`, replace:

```ts
  if (error) return moneyWriteFailed(fnName, error);
  if (!data || data.length === 0) return { ok: false, error: M.gone };
  return null;
}

/* ---- writes ----------------------------------------------------------- */
```

with:

```ts
  if (error) return moneyWriteFailed(fnName, error);
  if (!data || data.length === 0) return { ok: false, error: M.gone };
  return null;
}

/**
 * The transaction must be a payment against invoices, which the payments-in
 * view shows. Money in can also be a receipt for income that settles no
 * invoice; that is on Cash Receipts and never in this view, which joins each
 * allocation to its invoice. Voiding a payment in asks the view first and
 * refuses anything it does not show, without writing. One row is asked for: a
 * payment split across invoices is several rows there.
 */
async function refusalUnlessPaymentIn(
  ctx: FinanceWriteContext,
  fnName: string,
  txnId: string,
): Promise<{ ok: false; error: string } | null> {
  const { data, error } = await ctx.client
    .from('finance_payments_in')
    .select('transaction_id')
    .eq('org_id', ctx.orgId)
    .eq('transaction_id', txnId)
    .limit(1);
  if (error) return moneyWriteFailed(fnName, error, RECEIPT_REFUSALS);
  if (!data || data.length === 0) return { ok: false, error: R.gone };
  return null;
}

/* ---- writes ----------------------------------------------------------- */
```

In `src/lib/finance/money.ts`, replace:

```ts
/**
 * Voids a payment in: the same status change, kept to money in and worded
 * for it. The invoices it paid owe that amount again. There is no delete and
 * no edit: money in is posted the moment it is recorded.
 */
export async function voidPaymentIn(
  ctx: FinanceWriteContext,
  input: z.input<typeof paymentIdInput>,
): Promise<FinResult<{ id: string }>> {
  const { id: txnId } = paymentIdInput.parse(input);
  const { data, error } = await ctx.client
```

with:

```ts
/**
 * Voids a payment in: the same status change, kept to money in and worded
 * for it. The invoices it paid owe that amount again. There is no delete and
 * no edit: money in is posted the moment it is recorded. Anything the
 * payments-in view does not show is refused first.
 */
export async function voidPaymentIn(
  ctx: FinanceWriteContext,
  input: z.input<typeof paymentIdInput>,
): Promise<FinResult<{ id: string }>> {
  const { id: txnId } = paymentIdInput.parse(input);
  const refusal = await refusalUnlessPaymentIn(ctx, 'voidPaymentIn', txnId);
  if (refusal) return refusal;
  const { data, error } = await ctx.client
```

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vitest run tests/finance-payments-in.test.ts tests/finance-money.test.ts tests/finance-sales-actions.test.ts`
Expected: PASS, all three files. `tests/finance-sales-actions.test.ts` stands in for the data layer, so it does not see the extra read; it is run to show the action still calls `voidPaymentIn` and nothing else.

- [ ] **Step 5: Type-check, lint and commit**

Run: `pnpm exec tsc --noEmit` then `pnpm lint`
Expected: no errors; lint reports the one warning it had before this branch (`tests/apply-proposal.test.ts`, `'_p' is defined but never used`) and nothing new.

Run: `pnpm exec vitest run --exclude 'tests/*.rls.test.ts' --exclude 'tests/bendahara-*.test.ts'`
Expected: PASS, every file.

```bash
git add src/lib/finance/money.ts tests/finance-payments-in.test.ts
git commit -m "fix: voiding a payment in reads Payments In first, so a receipt for income cannot be reached through it"
```

---

### Task 4: What the three screens show

**Files:**
- Create: `tests/finance-cash-book-views.test.ts`
- Create: `src/lib/finance/cash-book-views.ts`
- Create: `src/screens/finance/cash-book-sample.ts`

**Interfaces:**
- Consumes: `CashBookStatus`, `CashReceiptRow`, `PaymentVoucherKind`, `PaymentVoucherRow` (Task 2, `cash-book.ts`); `ExpenseDisplayStatus`, `ExpenseRow`, `ExpenseStatus` (Task 2, `expenses.ts`); `toCsv`, `CSV_BOM` from `./csv`; `rmShort` from `./format`; `PAYMENT_METHOD_LABELS`, `PaymentMethod` from `./money`; `Stat`, `count`, `lastMonths`, `monthOf`, `sum`, `thousands`, `paymentCount` from `./view-helpers`; `Slice` from `@/components/charts` (a type only); `SAMPLE_PAYMENTS_IN`, `SAMPLE_REFUNDS`, `SAMPLE_TODAY` from `src/screens/finance/sales-sample.ts` (unchanged).
- Produces, from `cash-book-views.ts`:
  - `CASH_BOOK_PERIODS = ['month', 'quarter', 'year']`, `type CashBookPeriod`, `CASH_BOOK_PERIOD_LABELS: Record<CashBookPeriod, string>`, `inPeriod(iso: string, today: string, period: CashBookPeriod): boolean`, `DONUT_SLICES = 4`
  - `type CashReceiptsViewData = { stats: Stat[]; trend: { label: string; bank: number; cash: number }[]; hasTrend: boolean; byAccount: Slice[]; hasReceived: boolean; received: string }`
  - `CASH_RECEIPT_STATUS_LABELS: Record<CashBookStatus, string>`, `receiptFor(row: CashReceiptRow): string`, `cashReceiptsView(rows: CashReceiptRow[], today: string, period: CashBookPeriod): CashReceiptsViewData`, `type CashReceiptFilter = 'open' | 'draft' | 'posted' | 'void'`, `filterCashReceipts(rows, query, filter): CashReceiptRow[]`, `cashReceiptsCsv(rows): string`
  - `type PaymentVouchersViewData = { stats: Stat[]; trend: { label: string; paid: number }[]; hasTrend: boolean; byCategory: Slice[]; hasPaid: boolean; paid: string }`
  - `PAYMENT_VOUCHER_STATUS_LABELS: Record<CashBookStatus, string>`, `PAYMENT_VOUCHER_KIND_LABELS: Record<PaymentVoucherKind, string>`, `voucherHome(kind): { label: string; href: string } | null`, `voucherCategory(row): string`, `isWaitingVoucher(row): boolean`, `paymentVouchersView(rows: PaymentVoucherRow[], today: string, period: CashBookPeriod): PaymentVouchersViewData`, `type PaymentVoucherFilter = 'open' | 'waiting' | 'scheduled' | 'posted' | 'rejected' | 'void'`, `filterPaymentVouchers(rows, query, filter, kind = 'all'): PaymentVoucherRow[]`, `paymentVouchersCsv(rows): string`
  - `type ExpensesViewData = { stats: Stat[]; trend: { label: string; entered: number; approved: number }[]; hasTrend: boolean; byCategory: Slice[]; hasSpend: boolean; spendYtd: string }`
  - `EXPENSE_STATUS_LABELS: Record<ExpenseDisplayStatus, string>`, `isApprovedExpense(row): boolean`, `expensesView(rows: ExpenseRow[], today: string): ExpensesViewData`, `expenseCategories(rows): { id: string; name: string }[]`, `type ExpenseFilter = 'open' | ExpenseDisplayStatus`, `filterExpenses(rows, query, filter, categoryId = 'all'): ExpenseRow[]`, `expenseMethod(row): string`, `expensesCsv(rows): string`
- Produces, from `cash-book-sample.ts`: `SAMPLE_EXPENSES: ExpenseRow[]`, `SAMPLE_PAYMENT_VOUCHERS: PaymentVoucherRow[]`, `SAMPLE_CASH_RECEIPTS: CashReceiptRow[]`.

What each screen counts, in one place:

| Screen | Counts | Leaves out |
|---|---|---|
| Cash Receipts: Received, Receipts, Average receipt, Into the bank, By account | receipts that are `posted` and dated in the chosen period | drafts, void |
| Cash Receipts: Receipts over time | `posted` receipts, last eight months, bank and cash | drafts, void |
| Payment Vouchers: Paid, Vouchers, Average voucher, By category | vouchers that are `posted` and dated in the chosen period | waiting, to be paid, rejected, void, draft |
| Payment Vouchers: Pending approval | every voucher that is `pending_approval`, whatever its date | everything else |
| Expenses: Total (YTD), This month, Top category, Spend by category | expenses that are approved, paid or not, by `expense_date` | pending, rejected |
| Expenses: Pending approval | every expense that is `pending` | everything else |
| Expenses over time | "entered" is every expense not rejected; "approved" is the approved ones | rejected |

A donut names its four largest slices and adds the rest up as one, so its slices always come to the figure in its middle. Supplier payments and refunds are a category each on Payment Vouchers ("Supplier bills", "Refunds"): they have no category of their own.

The sample is three more lists beside `sales-sample.ts`, which is not edited. The sample's payments in are its receipts and the sample's refunds are among its vouchers, row for row, because the cash book lists the same money; a test holds them together. The sample's payments to suppliers on Payment Vouchers are four rows of its own: the Payments Out sample is private to `src/screens/finance/payments-out.tsx` and this stage does not move it.

- [ ] **Step 1: Write the failing tests**

Create `tests/finance-cash-book-views.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { CashReceiptRow, PaymentVoucherRow } from '@/lib/finance/cash-book';
import {
  CASH_BOOK_PERIODS,
  CASH_BOOK_PERIOD_LABELS,
  CASH_RECEIPT_STATUS_LABELS,
  DONUT_SLICES,
  EXPENSE_STATUS_LABELS,
  PAYMENT_VOUCHER_KIND_LABELS,
  PAYMENT_VOUCHER_STATUS_LABELS,
  cashReceiptsCsv,
  cashReceiptsView,
  expenseCategories,
  expenseMethod,
  expensesCsv,
  expensesView,
  filterCashReceipts,
  filterExpenses,
  filterPaymentVouchers,
  inPeriod,
  isApprovedExpense,
  isWaitingVoucher,
  paymentVouchersCsv,
  paymentVouchersView,
  receiptFor,
  voucherCategory,
  voucherHome,
} from '@/lib/finance/cash-book-views';
import { CSV_BOM } from '@/lib/finance/csv';
import type { ExpenseRow } from '@/lib/finance/expenses';
import { paymentCount, sum } from '@/lib/finance/view-helpers';
import { SAMPLE_CASH_RECEIPTS, SAMPLE_EXPENSES, SAMPLE_PAYMENT_VOUCHERS } from '@/screens/finance/cash-book-sample';
import { SAMPLE_PAYMENTS_IN, SAMPLE_REFUNDS, SAMPLE_TODAY } from '@/screens/finance/sales-sample';

const today = '2026-10-09';

let seq = 0;
const receipt = (r: Partial<CashReceiptRow> = {}): CashReceiptRow => {
  seq += 1;
  return {
    transaction_id: `receipt-${seq}`,
    number: `RC-${String(seq).padStart(4, '0')}`,
    txn_date: '2026-10-05',
    method: 'fpx',
    amount: 100,
    status: 'posted',
    reference: null,
    notes: null,
    account_id: 'bank',
    account_name: 'Main Bank',
    account_kind: 'bank',
    contact_id: null,
    party_name: 'Aisyah Trading',
    kind: 'invoice',
    category_id: null,
    category_name: null,
    documents: 'INV-0001',
    ...r,
  };
};
const cash = (r: Partial<CashReceiptRow> = {}) =>
  receipt({ account_id: 'cash', account_name: 'Cash in hand', account_kind: 'cash', method: 'cash', kind: 'income', documents: null, category_name: 'Sales', ...r });

const voucher = (v: Partial<PaymentVoucherRow> = {}): PaymentVoucherRow => {
  seq += 1;
  return {
    transaction_id: `voucher-${seq}`,
    number: `PV-${String(seq).padStart(4, '0')}`,
    txn_date: '2026-10-05',
    method: 'fpx',
    amount: 100,
    status: 'posted',
    reference: null,
    notes: null,
    account_id: 'bank',
    account_name: 'Main Bank',
    account_kind: 'bank',
    contact_id: null,
    party_name: 'Syabas',
    kind: 'other',
    category_id: 'utilities',
    category_name: 'Utilities',
    documents: null,
    approved_at: null,
    ...v,
  };
};

const expense = (e: Partial<ExpenseRow> = {}): ExpenseRow => {
  seq += 1;
  return {
    id: `expense-${seq}`,
    expense_date: '2026-10-05',
    category_id: 'rent',
    category_name: 'Rent',
    vendor_id: null,
    vendor_name: 'Menara Axis',
    amount: 100,
    sst_amount: 0,
    notes: null,
    status: 'approved',
    display_status: 'approved',
    paid: 0,
    held: 0,
    method: null,
    paid_on: null,
    ...e,
  };
};

const stat = (stats: { label: string; value: string; delta?: string }[], label: string) => stats.find((s) => s.label === label)!;

describe('the period selector', () => {
  it('offers this month, this quarter and this year, and says so in a person’s words', () => {
    expect(CASH_BOOK_PERIODS).toEqual(['month', 'quarter', 'year']);
    expect(CASH_BOOK_PERIOD_LABELS).toEqual({ month: 'This month', quarter: 'This quarter', year: 'This year' });
  });
  it('places a date by the calendar: month, quarter and year of today', () => {
    expect(inPeriod('2026-10-01', today, 'month')).toBe(true);
    expect(inPeriod('2026-09-30', today, 'month')).toBe(false);
    expect(inPeriod('2026-11-30', today, 'quarter')).toBe(true);
    expect(inPeriod('2026-09-30', today, 'quarter')).toBe(false);
    expect(inPeriod('2026-01-01', today, 'year')).toBe(true);
    expect(inPeriod('2025-12-31', today, 'year')).toBe(false);
    // Another year's October is not this month.
    expect(inPeriod('2025-10-09', today, 'month')).toBe(false);
    expect(inPeriod('2025-11-09', today, 'quarter')).toBe(false);
  });
});

describe('cashReceiptsView', () => {
  it('counts only posted receipts dated in the period: not a draft, not a void one', () => {
    const rows = [
      receipt({ amount: 300 }),
      cash({ amount: 100 }),
      receipt({ amount: 9999, status: 'draft', number: null }),
      receipt({ amount: 9999, status: 'void' }),
      receipt({ amount: 50, txn_date: '2026-08-15' }),
    ];
    const month = cashReceiptsView(rows, today, 'month');
    expect(stat(month.stats, 'Received')).toMatchObject({ value: 'RM 400', delta: 'this month' });
    expect(stat(month.stats, 'Receipts')).toMatchObject({ value: '2', delta: '1 draft not yet posted' });
    expect(stat(month.stats, 'Average receipt').value).toBe('RM 200');
    expect(stat(month.stats, 'Into the bank').value).toBe('75%');
    expect(month.received).toBe('RM 400');
    expect(month.hasReceived).toBe(true);
    const year = cashReceiptsView(rows, today, 'year');
    expect(stat(year.stats, 'Received')).toMatchObject({ value: 'RM 450', delta: 'this year' });
    expect(stat(year.stats, 'Receipts').value).toBe('3');
    // August is in the third quarter.
    expect(stat(cashReceiptsView(rows, today, 'quarter').stats, 'Received').value).toBe('RM 400');
  });
  it('splits each account its own slice, largest first, and the trend into bank and cash', () => {
    const rows = [receipt({ amount: 1000 }), cash({ amount: 3000 }), cash({ amount: 500, txn_date: '2026-09-02' })];
    const view = cashReceiptsView(rows, today, 'month');
    expect(view.byAccount.map((s) => [s.label, s.value])).toEqual([['Cash in hand', 3000], ['Main Bank', 1000]]);
    expect(new Set(view.byAccount.map((s) => s.key)).size).toBe(2);
    expect(view.trend).toHaveLength(8);
    expect(view.trend[7]).toEqual({ label: 'Oct', bank: 1, cash: 3 });
    expect(view.trend[6]).toEqual({ label: 'Sep', bank: 0, cash: 0.5 });
    expect(view.hasTrend).toBe(true);
  });
  it('says there is a trend for a receipt too small to show in thousands, and none when nothing was posted', () => {
    expect(cashReceiptsView([cash({ amount: 4 })], today, 'month').hasTrend).toBe(true);
    expect(cashReceiptsView([cash({ amount: 4 })], today, 'month').trend[7]).toEqual({ label: 'Oct', bank: 0, cash: 0 });
    const empty = cashReceiptsView([receipt({ status: 'draft' })], today, 'month');
    expect(empty.hasTrend).toBe(false);
    expect(empty.hasReceived).toBe(false);
    expect(empty.byAccount).toEqual([]);
    expect(stat(empty.stats, 'Average receipt').value).toBe('—');
    expect(stat(empty.stats, 'Into the bank').value).toBe('—');
    expect(stat(empty.stats, 'Receipts')).toMatchObject({ value: '0', delta: '1 draft not yet posted' });
  });
  it('adds amounts in sen, so thirty receipts of ten sen are three ringgit', () => {
    const rows = Array.from({ length: 30 }, () => cash({ amount: 0.1 }));
    expect(cashReceiptsView(rows, today, 'month').byAccount[0].value).toBe(3);
  });
});

describe('a receipt in the table', () => {
  it('says what it is for: its invoices, or its category', () => {
    expect(receiptFor(receipt({ documents: 'INV-0001, INV-0002' }))).toBe('INV-0001, INV-0002');
    expect(receiptFor(receipt({ documents: null }))).toBe('Invoices');
    expect(receiptFor(cash())).toBe('Sales');
    expect(receiptFor(cash({ category_name: null }))).toBe('—');
  });
  it('has a word for every status', () => {
    expect(CASH_RECEIPT_STATUS_LABELS).toMatchObject({ draft: 'Draft', posted: 'Posted', void: 'Void' });
    expect(Object.values(CASH_RECEIPT_STATUS_LABELS).every((label) => label.length > 0)).toBe(true);
  });
  it('is found by its number, payer, invoice, category or reference, within the status chosen', () => {
    const rows = [
      receipt({ number: 'RC-0101', party_name: 'Aisyah Trading', documents: 'INV-1042' }),
      cash({ number: 'RC-0102', party_name: 'Walk-in', reference: 'TILL 7' }),
      receipt({ number: null, status: 'draft', party_name: 'Langkawi Fresh' }),
      receipt({ number: 'RC-0099', status: 'void', party_name: 'Zaki Enterprise' }),
    ];
    expect(filterCashReceipts(rows, '', 'open')).toHaveLength(3);
    expect(filterCashReceipts(rows, '', 'void').map((r) => r.party_name)).toEqual(['Zaki Enterprise']);
    expect(filterCashReceipts(rows, '', 'draft').map((r) => r.party_name)).toEqual(['Langkawi Fresh']);
    expect(filterCashReceipts(rows, '', 'posted')).toHaveLength(2);
    expect(filterCashReceipts(rows, ' inv-1042 ', 'open').map((r) => r.number)).toEqual(['RC-0101']);
    expect(filterCashReceipts(rows, 'sales', 'open').map((r) => r.number)).toEqual(['RC-0102']);
    expect(filterCashReceipts(rows, 'till', 'open').map((r) => r.number)).toEqual(['RC-0102']);
    expect(filterCashReceipts(rows, 'zaki', 'open')).toEqual([]);
  });
  it('exports with the table’s columns and amounts as numbers', () => {
    const csv = cashReceiptsCsv([cash({ number: 'RC-0102', party_name: 'Walk-in', amount: 80.5, reference: '=SUM(A1)' }), receipt({ number: null, status: 'draft', party_name: null })]);
    const lines = csv.slice(CSV_BOM.length).split('\r\n');
    expect(lines[0]).toBe('Date,No.,Received from,For,Account,Method,Reference,Amount,Status');
    expect(lines[1]).toBe("2026-10-05,RC-0102,Walk-in,Sales,Cash in hand,Cash,'=SUM(A1),80.5,Posted");
    expect(lines[2]).toBe('2026-10-05,,,INV-0001,Main Bank,FPX,,100,Draft');
  });
});

describe('paymentVouchersView', () => {
  it('counts only vouchers that were paid in the period, and what is waiting whatever its date', () => {
    const rows = [
      voucher({ amount: 300 }),
      voucher({ amount: 100, kind: 'bill', category_name: null, documents: 'BILL-0001' }),
      voucher({ amount: 2200, status: 'pending_approval', number: null, txn_date: '2026-07-01' }),
      voucher({ amount: 960, status: 'scheduled', number: null }),
      voucher({ amount: 9999, status: 'rejected', number: null }),
      voucher({ amount: 9999, status: 'void' }),
      voucher({ amount: 50, txn_date: '2026-08-15' }),
    ];
    const month = paymentVouchersView(rows, today, 'month');
    expect(stat(month.stats, 'Paid')).toMatchObject({ value: 'RM 400', delta: 'this month' });
    expect(stat(month.stats, 'Vouchers')).toMatchObject({ value: '2', delta: '1 more to be paid' });
    expect(stat(month.stats, 'Pending approval')).toMatchObject({ value: 'RM 2,200', delta: '1 voucher', deltaTone: 'down' });
    expect(stat(month.stats, 'Average voucher').value).toBe('RM 200');
    expect(stat(paymentVouchersView(rows, today, 'year').stats, 'Paid').value).toBe('RM 450');
    expect(month.paid).toBe('RM 400');
  });
  it('puts supplier payments and refunds in a category each, and the rest under their own', () => {
    const rows = [
      voucher({ amount: 500, kind: 'bill', category_name: null }),
      voucher({ amount: 200, kind: 'refund', category_name: null }),
      voucher({ amount: 300, kind: 'expense', category_name: 'Rent' }),
      voucher({ amount: 100, kind: 'other', category_name: 'Rent' }),
      voucher({ amount: 50, kind: 'expense', category_name: null }),
      voucher({ amount: 25, kind: 'other', category_name: null }),
    ];
    expect(rows.map(voucherCategory)).toEqual(['Supplier bills', 'Refunds', 'Rent', 'Rent', 'Several categories', 'No category']);
    const view = paymentVouchersView(rows, today, 'month');
    expect(view.byCategory.map((s) => [s.label, s.value])).toEqual([
      ['Supplier bills', 500], ['Rent', 400], ['Refunds', 200], ['Several categories', 50], ['Other categories', 25],
    ]);
    // The slices add up to what was paid: nothing is counted twice and nothing dropped.
    expect(sum(view.byCategory, (s) => s.value)).toBe(1175);
    expect(view.byCategory).toHaveLength(DONUT_SLICES + 1);
  });
  it('has nothing to chart when nothing was paid, and no alarm when nothing is waiting', () => {
    const view = paymentVouchersView([voucher({ status: 'scheduled', number: null })], today, 'month');
    expect(view.hasPaid).toBe(false);
    expect(view.hasTrend).toBe(false);
    expect(view.byCategory).toEqual([]);
    expect(stat(view.stats, 'Pending approval')).toMatchObject({ value: 'RM 0', delta: '0 vouchers', deltaTone: 'flat' });
    expect(stat(view.stats, 'Average voucher').value).toBe('—');
    expect(paymentVouchersView([voucher({ amount: 3 })], today, 'month').hasTrend).toBe(true);
  });
});

describe('a voucher in the table', () => {
  it('names the screen it is changed on when that is not this one', () => {
    expect(voucherHome('bill')).toEqual({ label: 'Payments Out', href: '/finance/payments-out' });
    expect(voucherHome('refund')).toEqual({ label: 'Refunds', href: '/finance/refunds' });
    expect(voucherHome('expense')).toBeNull();
    expect(voucherHome('other')).toBeNull();
  });
  it('has a word for every status and every kind', () => {
    expect(PAYMENT_VOUCHER_STATUS_LABELS).toMatchObject({
      pending_approval: 'Pending approval', scheduled: 'To be paid', posted: 'Paid', rejected: 'Rejected', void: 'Void',
    });
    expect(PAYMENT_VOUCHER_KIND_LABELS).toEqual({ bill: 'Supplier payment', refund: 'Refund', expense: 'Expense', other: 'Other payment' });
  });
  it('is waiting only while it is pending approval', () => {
    expect(isWaitingVoucher(voucher({ status: 'pending_approval' }))).toBe(true);
    for (const status of ['draft', 'scheduled', 'posted', 'rejected', 'void'] as const) {
      expect(isWaitingVoucher(voucher({ status })), status).toBe(false);
    }
  });
  it('is found by status, by kind and by what it says', () => {
    const rows = [
      voucher({ number: 'PV-0001', party_name: 'Syabas', kind: 'other', category_name: 'Utilities' }),
      voucher({ number: 'PV-0002', party_name: 'Lim Hardware', kind: 'bill', category_name: null, documents: 'BILL-0221' }),
      voucher({ number: null, party_name: 'Ramli', status: 'pending_approval', reference: 'OCT RENT' }),
      voucher({ number: null, party_name: 'TNB', status: 'scheduled' }),
      voucher({ number: null, party_name: 'Maju', status: 'rejected' }),
      voucher({ number: 'PV-0003', party_name: 'Gone', status: 'void' }),
      voucher({ number: null, party_name: 'Half written', status: 'draft' }),
    ];
    expect(filterPaymentVouchers(rows, '', 'open').map((v) => v.party_name)).toEqual(['Syabas', 'Lim Hardware', 'Ramli', 'TNB', 'Half written']);
    expect(filterPaymentVouchers(rows, '', 'waiting').map((v) => v.party_name)).toEqual(['Ramli']);
    expect(filterPaymentVouchers(rows, '', 'scheduled').map((v) => v.party_name)).toEqual(['TNB']);
    expect(filterPaymentVouchers(rows, '', 'posted')).toHaveLength(2);
    expect(filterPaymentVouchers(rows, '', 'rejected').map((v) => v.party_name)).toEqual(['Maju']);
    expect(filterPaymentVouchers(rows, '', 'void').map((v) => v.party_name)).toEqual(['Gone']);
    expect(filterPaymentVouchers(rows, '', 'open', 'bill').map((v) => v.number)).toEqual(['PV-0002']);
    expect(filterPaymentVouchers(rows, 'bill-0221', 'open').map((v) => v.number)).toEqual(['PV-0002']);
    expect(filterPaymentVouchers(rows, 'supplier bills', 'open').map((v) => v.number)).toEqual(['PV-0002']);
    expect(filterPaymentVouchers(rows, 'oct rent', 'open').map((v) => v.party_name)).toEqual(['Ramli']);
  });
  it('exports with its kind, category and documents, and amounts as numbers', () => {
    const csv = paymentVouchersCsv([
      voucher({ number: 'PV-0002', party_name: 'Lim Hardware', kind: 'bill', category_name: null, documents: 'BILL-0221, BILL-0222', amount: 1200.5 }),
      voucher({ number: null, party_name: 'Ramli', status: 'pending_approval', category_name: 'Rent' }),
    ]);
    const lines = csv.slice(CSV_BOM.length).split('\r\n');
    expect(lines[0]).toBe('Date,No.,Paid to,Kind,Category,For,Account,Method,Reference,Amount,Status');
    expect(lines[1]).toBe('2026-10-05,PV-0002,Lim Hardware,Supplier payment,Supplier bills,"BILL-0221, BILL-0222",Main Bank,FPX,,1200.5,Paid');
    expect(lines[2]).toBe('2026-10-05,,Ramli,Other payment,Rent,,Main Bank,FPX,,100,Pending approval');
  });
});

describe('expensesView', () => {
  it('counts approved and paid expenses as spend, and pending ones apart; a rejected one nowhere', () => {
    const rows = [
      expense({ amount: 4500, category_name: 'Rent', display_status: 'paid', paid: 4500, method: 'bank_transfer' }),
      expense({ amount: 1500, category_id: 'services', category_name: 'Services' }),
      expense({ amount: 2200, category_id: 'marketing', category_name: 'Marketing', status: 'pending', display_status: 'pending' }),
      expense({ amount: 9999, status: 'rejected', display_status: 'rejected' }),
      expense({ amount: 4500, expense_date: '2026-08-03', display_status: 'paid', paid: 4500 }),
      expense({ amount: 7777, expense_date: '2025-12-31' }),
    ];
    const view = expensesView(rows, today);
    expect(stat(view.stats, 'Total expenses (YTD)')).toMatchObject({ value: 'RM 10.5k', delta: '3 approved expenses' });
    expect(stat(view.stats, 'This month')).toMatchObject({ value: 'RM 6,000', delta: '2 approved expenses' });
    expect(stat(view.stats, 'Top category')).toMatchObject({ value: 'Rent', delta: '86% of spend this year' });
    expect(stat(view.stats, 'Pending approval')).toMatchObject({ value: 'RM 2,200', delta: '1 expense', deltaTone: 'down' });
    expect(view.byCategory.map((s) => [s.label, s.value])).toEqual([['Rent', 9000], ['Services', 1500]]);
    expect(view.spendYtd).toBe('RM 10.5k');
    expect(view.hasSpend).toBe(true);
    // October: entered is everything not rejected, approved leaves the pending one out.
    expect(view.trend[7]).toEqual({ label: 'Oct', entered: 8.2, approved: 6 });
    expect(view.trend[5]).toEqual({ label: 'Aug', entered: 4.5, approved: 4.5 });
    expect(view.hasTrend).toBe(true);
  });
  it('has empty states: no spend, no top category, nothing pending', () => {
    const view = expensesView([expense({ status: 'rejected', display_status: 'rejected' })], today);
    expect(view.hasSpend).toBe(false);
    expect(view.hasTrend).toBe(false);
    expect(view.byCategory).toEqual([]);
    expect(stat(view.stats, 'Top category')).toMatchObject({ value: '—', delta: 'this year' });
    expect(stat(view.stats, 'Pending approval')).toMatchObject({ value: 'RM 0', delta: '0 expenses', deltaTone: 'flat' });
    // A pending expense alone is a trend, and still no spend.
    const pending = expensesView([expense({ status: 'pending', display_status: 'pending' })], today);
    expect(pending.hasTrend).toBe(true);
    expect(pending.hasSpend).toBe(false);
  });
  it('folds categories past the fourth into one slice', () => {
    const names = ['Rent', 'Salaries', 'Marketing', 'Utilities', 'Travel', 'Supplies'];
    const rows = names.map((name, i) => expense({ category_id: name, category_name: name, amount: 600 - i * 100 }));
    const view = expensesView(rows, today);
    expect(view.byCategory.map((s) => [s.label, s.value])).toEqual([
      ['Rent', 600], ['Salaries', 500], ['Marketing', 400], ['Utilities', 300], ['Other categories', 300],
    ]);
  });
});

describe('an expense in the table', () => {
  it('is approved spend once approved, paid or not', () => {
    expect(isApprovedExpense(expense({ display_status: 'approved' }))).toBe(true);
    expect(isApprovedExpense(expense({ display_status: 'paid' }))).toBe(true);
    expect(isApprovedExpense(expense({ display_status: 'pending' }))).toBe(false);
    expect(isApprovedExpense(expense({ display_status: 'rejected' }))).toBe(false);
  });
  it('has a word for every status, and a dash for how it was paid until it is', () => {
    expect(EXPENSE_STATUS_LABELS).toEqual({ pending: 'Pending approval', approved: 'Approved', rejected: 'Rejected', paid: 'Paid' });
    expect(expenseMethod(expense())).toBe('—');
    expect(expenseMethod(expense({ method: 'ewallet' }))).toBe('E-Wallet');
  });
  it('lists the categories the rows name, once each, by name', () => {
    const rows = [
      expense({ category_id: 'u', category_name: 'Utilities' }),
      expense({ category_id: 'r', category_name: 'Rent' }),
      expense({ category_id: 'u', category_name: 'Utilities' }),
      expense({ category_id: 'r2', category_name: 'Rent' }),
    ];
    expect(expenseCategories(rows)).toEqual([{ id: 'r', name: 'Rent' }, { id: 'r2', name: 'Rent' }, { id: 'u', name: 'Utilities' }]);
  });
  it('is found by status, by category and by vendor, category or notes', () => {
    const rows = [
      expense({ vendor_name: 'Menara Axis', category_id: 'rent', category_name: 'Rent', display_status: 'paid' }),
      expense({ vendor_name: 'Meta Ads', category_id: 'marketing', category_name: 'Marketing', status: 'pending', display_status: 'pending', notes: 'Raya campaign' }),
      expense({ vendor_name: 'AirAsia', category_id: 'travel', category_name: 'Travel', status: 'rejected', display_status: 'rejected' }),
      expense({ vendor_name: 'Guaman Lee', category_id: 'services', category_name: 'Services' }),
    ];
    expect(filterExpenses(rows, '', 'open').map((e) => e.vendor_name)).toEqual(['Menara Axis', 'Meta Ads', 'Guaman Lee']);
    expect(filterExpenses(rows, '', 'rejected').map((e) => e.vendor_name)).toEqual(['AirAsia']);
    expect(filterExpenses(rows, '', 'paid').map((e) => e.vendor_name)).toEqual(['Menara Axis']);
    expect(filterExpenses(rows, '', 'approved').map((e) => e.vendor_name)).toEqual(['Guaman Lee']);
    expect(filterExpenses(rows, '', 'open', 'marketing').map((e) => e.vendor_name)).toEqual(['Meta Ads']);
    expect(filterExpenses(rows, ' RAYA ', 'open').map((e) => e.vendor_name)).toEqual(['Meta Ads']);
    expect(filterExpenses(rows, 'services', 'open').map((e) => e.vendor_name)).toEqual(['Guaman Lee']);
  });
  it('exports amounts as numbers, with what was paid and how', () => {
    const csv = expensesCsv([
      expense({ vendor_name: 'Unifi Business', category_name: 'Utilities', amount: 94, sst_amount: 5.32, display_status: 'paid', paid: 94, method: 'card' }),
      expense({ vendor_name: 'Meta Ads', category_name: 'Marketing', status: 'pending', display_status: 'pending', notes: 'Raya, week 1' }),
    ]);
    const lines = csv.slice(CSV_BOM.length).split('\r\n');
    expect(lines[0]).toBe('Date,Category,Vendor,Amount,SST,Paid,Method,Status,Notes');
    expect(lines[1]).toBe('2026-10-05,Utilities,Unifi Business,94,5.32,94,Card,Paid,');
    expect(lines[2]).toBe('2026-10-05,Marketing,Meta Ads,100,0,0,,Pending approval,"Raya, week 1"');
  });
});

describe('the sample shown when there is no database', () => {
  it('lists each sample payment in once on Cash Receipts, for what the payment came to', () => {
    const invoiceReceipts = SAMPLE_CASH_RECEIPTS.filter((r) => r.kind === 'invoice');
    expect(invoiceReceipts).toHaveLength(paymentCount(SAMPLE_PAYMENTS_IN));
    for (const r of invoiceReceipts) {
      const parts = SAMPLE_PAYMENTS_IN.filter((p) => p.transaction_id === r.transaction_id);
      expect(parts.length, r.transaction_id).toBeGreaterThan(0);
      expect(r.amount, r.transaction_id).toBe(sum(parts, (p) => p.amount));
      expect(r.number, r.transaction_id).toBe(parts[0].number);
    }
    expect(new Set(SAMPLE_CASH_RECEIPTS.map((r) => r.transaction_id)).size).toBe(SAMPLE_CASH_RECEIPTS.length);
  });
  it('lists each sample refund once on Payment Vouchers, with its amount and status', () => {
    const refundVouchers = SAMPLE_PAYMENT_VOUCHERS.filter((v) => v.kind === 'refund');
    expect(refundVouchers).toHaveLength(SAMPLE_REFUNDS.length);
    for (const v of refundVouchers) {
      const refund = SAMPLE_REFUNDS.find((r) => r.transaction_id === v.transaction_id)!;
      expect([v.amount, v.status, v.number], v.transaction_id).toEqual([refund.amount, refund.status, refund.number]);
    }
    expect(new Set(SAMPLE_PAYMENT_VOUCHERS.map((v) => v.transaction_id)).size).toBe(SAMPLE_PAYMENT_VOUCHERS.length);
  });
  it('has one paid voucher for each paid sample expense, for its amount, and no number used twice', () => {
    const expenseVouchers = SAMPLE_PAYMENT_VOUCHERS.filter((v) => v.kind === 'expense');
    const paid = SAMPLE_EXPENSES.filter((e) => e.display_status === 'paid');
    expect(expenseVouchers).toHaveLength(paid.length);
    expect(sum(expenseVouchers, (v) => v.amount)).toBe(sum(paid, (e) => e.paid));
    expect(expenseVouchers.every((v) => v.status === 'posted' && v.category_name !== null)).toBe(true);
    const numbers = SAMPLE_PAYMENT_VOUCHERS.map((v) => v.number).filter((n) => n !== null);
    expect(new Set(numbers).size).toBe(numbers.length);
    const receiptNumbers = SAMPLE_CASH_RECEIPTS.map((r) => r.number).filter((n) => n !== null);
    expect(new Set(receiptNumbers).size).toBe(receiptNumbers.length);
  });
  it('gives every card, chart and filter something to show', () => {
    const receipts = cashReceiptsView(SAMPLE_CASH_RECEIPTS, SAMPLE_TODAY, 'month');
    expect(receipts.hasTrend && receipts.hasReceived).toBe(true);
    expect(receipts.byAccount.map((s) => s.label).sort()).toEqual(['Cash in hand', 'Main Bank']);
    expect(SAMPLE_CASH_RECEIPTS.some((r) => r.status === 'draft' && r.number === null)).toBe(true);
    const vouchers = paymentVouchersView(SAMPLE_PAYMENT_VOUCHERS, SAMPLE_TODAY, 'month');
    expect(vouchers.hasTrend && vouchers.hasPaid).toBe(true);
    expect(stat(vouchers.stats, 'Pending approval')).toMatchObject({ value: 'RM 4,340', delta: '2 vouchers' });
    expect(new Set(SAMPLE_PAYMENT_VOUCHERS.map((v) => v.kind))).toEqual(new Set(['bill', 'refund', 'expense', 'other']));
    expect(SAMPLE_PAYMENT_VOUCHERS.every((v) => (v.status === 'posted') === (v.number !== null))).toBe(true);
    const expenses = expensesView(SAMPLE_EXPENSES, SAMPLE_TODAY);
    expect(expenses.hasTrend && expenses.hasSpend).toBe(true);
    expect(stat(expenses.stats, 'Pending approval')).toMatchObject({ value: 'RM 5,800', delta: '2 expenses' });
    expect(new Set(SAMPLE_EXPENSES.map((e) => e.display_status))).toEqual(new Set(['pending', 'approved', 'rejected', 'paid']));
    expect(SAMPLE_EXPENSES.every((e) => e.sst_amount <= e.amount && (e.display_status === 'paid') === (e.method !== null))).toBe(true);
  });
  it('keeps each list newest first, as the database gives it', () => {
    const sorted = (dates: string[]) => dates.every((d, i) => i === 0 || dates[i - 1] >= d);
    expect(sorted(SAMPLE_CASH_RECEIPTS.map((r) => r.txn_date))).toBe(true);
    expect(sorted(SAMPLE_PAYMENT_VOUCHERS.map((v) => v.txn_date))).toBe(true);
    expect(sorted(SAMPLE_EXPENSES.map((e) => e.expense_date))).toBe(true);
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm exec vitest run tests/finance-cash-book-views.test.ts`
Expected: FAIL, the file cannot be loaded: `@/lib/finance/cash-book-views` does not exist.

- [ ] **Step 3: Write `src/lib/finance/cash-book-views.ts`**

Create `src/lib/finance/cash-book-views.ts`:

```ts
/**
 * What the Cash Receipts, Payment Vouchers and Expenses screens show, worked
 * out from the rows the data layer reads. Pure, with no server imports, so
 * the client views and the tests both use it. `today` is always a YYYY-MM-DD
 * date. Cash Receipts and Payment Vouchers have a period selector, so their
 * figures are worked out again in the browser when it changes.
 */
import type { Slice } from '@/components/charts';
import type { CashBookStatus, CashReceiptRow, PaymentVoucherKind, PaymentVoucherRow } from './cash-book';
import { toCsv } from './csv';
import type { ExpenseDisplayStatus, ExpenseRow } from './expenses';
import { rmShort } from './format';
import { PAYMENT_METHOD_LABELS } from './money';
import { type Stat, count, lastMonths, monthOf, sum, thousands } from './view-helpers';

/* ---- the period selector ------------------------------------------- */

export const CASH_BOOK_PERIODS = ['month', 'quarter', 'year'] as const;
export type CashBookPeriod = (typeof CASH_BOOK_PERIODS)[number];

/** There is no financial-year setting, so the longest period is the calendar year. */
export const CASH_BOOK_PERIOD_LABELS: Record<CashBookPeriod, string> = {
  month: 'This month',
  quarter: 'This quarter',
  year: 'This year',
};

/** The calendar year a date falls in. */
const yearOf = (iso: string) => iso.slice(0, 4);

/** 2026-10-09 → 2026-Q4 */
const quarterOf = (iso: string) => `${yearOf(iso)}-Q${Math.ceil(Number(iso.slice(5, 7)) / 3)}`;

/** Whether a date falls in the calendar month, quarter or year that today is in. A later date in that period counts too. */
export function inPeriod(iso: string, today: string, period: CashBookPeriod): boolean {
  if (period === 'month') return monthOf(iso) === monthOf(today);
  if (period === 'quarter') return quarterOf(iso) === quarterOf(today);
  return yearOf(iso) === yearOf(today);
}

const SLICE_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-5)', 'var(--chart-3)', 'var(--chart-4)'];

/** How many named slices a donut shows before the rest are added up as one. */
export const DONUT_SLICES = 4;

/**
 * Amounts per label as donut slices, largest first. Past `DONUT_SLICES` the
 * rest are one slice, so a workspace with twenty categories still gets a
 * chart that can be read. Labels with nothing against them are left out.
 */
function slices(totals: Map<string, number>, restLabel: string): Slice[] {
  const ranked = [...totals.entries()]
    .map(([label, value]) => ({ label, value: Math.round(value * 100) / 100 }))
    .filter((entry) => entry.value > 0)
    .sort((x, y) => y.value - x.value || x.label.localeCompare(y.label));
  const named = ranked.slice(0, DONUT_SLICES);
  const rest = ranked.slice(DONUT_SLICES);
  const shown = rest.length ? [...named, { label: restLabel, value: sum(rest, (entry) => entry.value) }] : named;
  return shown.map((entry, i) => ({ key: `slice-${i}`, label: entry.label, value: entry.value, color: SLICE_COLORS[i] }));
}

function totalsBy<T>(rows: T[], label: (row: T) => string, amount: (row: T) => number): Map<string, number> {
  const totals = new Map<string, number>();
  for (const row of rows) totals.set(label(row), (totals.get(label(row)) ?? 0) + amount(row));
  return totals;
}

/* ---- Cash Receipts -------------------------------------------------- */

export type CashReceiptsViewData = {
  stats: Stat[];
  /** The last eight months, oldest first, in RM thousands: what was received into bank accounts and into cash. */
  trend: { label: string; bank: number; cash: number }[];
  /** Whether anything was received in those eight months, however little: a small receipt rounds to 0 in `trend`. */
  hasTrend: boolean;
  /** Received in the period per account, in RM. */
  byAccount: Slice[];
  /** Whether anything was received in the period. */
  hasReceived: boolean;
  received: string;
};

/** A receipt is posted the moment money in is recorded on Payments In; one made here can wait as a draft. */
export const CASH_RECEIPT_STATUS_LABELS: Record<CashBookStatus, string> = {
  draft: 'Draft',
  pending_approval: 'Pending approval',
  scheduled: 'Scheduled',
  posted: 'Posted',
  rejected: 'Rejected',
  void: 'Void',
};

/** What a receipt is for: the invoices it pays, or its income category. */
export function receiptFor(row: CashReceiptRow): string {
  if (row.kind === 'invoice') return row.documents ?? 'Invoices';
  return row.category_name ?? '—';
}

export function cashReceiptsView(rows: CashReceiptRow[], today: string, period: CashBookPeriod): CashReceiptsViewData {
  // Only money that has actually arrived counts: not a draft, not voided.
  const posted = rows.filter((r) => r.status === 'posted');
  const inRange = posted.filter((r) => inPeriod(r.txn_date, today, period));
  const total = sum(inRange, (r) => r.amount);
  const intoBank = sum(inRange.filter((r) => r.account_kind === 'bank'), (r) => r.amount);
  const drafts = rows.filter((r) => r.status === 'draft');
  const span = CASH_BOOK_PERIOD_LABELS[period].toLowerCase();

  let hasTrend = false;
  const trend = lastMonths(today).map(({ key, label }) => {
    const inMonth = posted.filter((r) => monthOf(r.txn_date) === key);
    if (inMonth.length > 0) hasTrend = true;
    return {
      label,
      bank: thousands(sum(inMonth.filter((r) => r.account_kind === 'bank'), (r) => r.amount)),
      cash: thousands(sum(inMonth.filter((r) => r.account_kind === 'cash'), (r) => r.amount)),
    };
  });

  return {
    stats: [
      { label: 'Received', value: rmShort(total), delta: span, deltaTone: 'flat' },
      {
        label: 'Receipts',
        value: String(inRange.length),
        delta: drafts.length ? `${count(drafts.length, 'draft')} not yet posted` : span,
        deltaTone: 'flat',
      },
      { label: 'Average receipt', value: inRange.length ? rmShort(total / inRange.length) : '—', delta: span, deltaTone: 'flat' },
      {
        label: 'Into the bank',
        value: total ? `${Math.round((intoBank / total) * 100)}%` : '—',
        delta: 'the rest is cash in hand',
        deltaTone: 'flat',
      },
    ],
    trend,
    hasTrend,
    byAccount: slices(totalsBy(inRange, (r) => r.account_name, (r) => r.amount), 'Other accounts'),
    hasReceived: inRange.length > 0,
    received: rmShort(total),
  };
}

/** `open` is every receipt that is not void: what the table shows until a status is chosen. */
export type CashReceiptFilter = 'open' | 'draft' | 'posted' | 'void';

/** Receipts matching the status filter whose number, payer, invoices, category or reference contains the search text. */
export function filterCashReceipts(rows: CashReceiptRow[], query: string, filter: CashReceiptFilter): CashReceiptRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter(
    (r) =>
      (filter === 'open' ? r.status !== 'void' : r.status === filter) &&
      `${r.number ?? ''} ${r.party_name ?? ''} ${r.documents ?? ''} ${r.category_name ?? ''} ${r.reference ?? ''}`
        .toLowerCase()
        .includes(q),
  );
}

/** The receipts table as a CSV file, its columns in the table's order. Amounts are numbers, so a spreadsheet can add them up. */
export function cashReceiptsCsv(rows: CashReceiptRow[]): string {
  return toCsv(
    ['Date', 'No.', 'Received from', 'For', 'Account', 'Method', 'Reference', 'Amount', 'Status'],
    rows.map((r) => [
      r.txn_date,
      r.number,
      r.party_name,
      r.kind === 'invoice' ? r.documents : r.category_name,
      r.account_name,
      PAYMENT_METHOD_LABELS[r.method],
      r.reference,
      r.amount,
      CASH_RECEIPT_STATUS_LABELS[r.status],
    ]),
  );
}

/* ---- Payment Vouchers ----------------------------------------------- */

export type PaymentVouchersViewData = {
  stats: Stat[];
  /** The last eight months, oldest first, in RM thousands: what was paid out. */
  trend: { label: string; paid: number }[];
  /** Whether anything was paid out in those eight months, however little. */
  hasTrend: boolean;
  /** Paid out in the period per category, in RM. */
  byCategory: Slice[];
  /** Whether anything was paid out in the period. */
  hasPaid: boolean;
  paid: string;
};

/** Money out is a voucher: `scheduled` is one that may be paid and has not been, `posted` one that was. */
export const PAYMENT_VOUCHER_STATUS_LABELS: Record<CashBookStatus, string> = {
  draft: 'Draft',
  pending_approval: 'Pending approval',
  scheduled: 'To be paid',
  posted: 'Paid',
  rejected: 'Rejected',
  void: 'Void',
};

export const PAYMENT_VOUCHER_KIND_LABELS: Record<PaymentVoucherKind, string> = {
  bill: 'Supplier payment',
  refund: 'Refund',
  expense: 'Expense',
  other: 'Other payment',
};

/**
 * The screen a voucher is changed on, when that is not this one: a payment
 * to a supplier is marked paid, voided or deleted on Payments Out, and a
 * refund on Refunds. Nothing (null) for the two kinds that belong here.
 */
export function voucherHome(kind: PaymentVoucherKind): { label: string; href: string } | null {
  if (kind === 'bill') return { label: 'Payments Out', href: '/finance/payments-out' };
  if (kind === 'refund') return { label: 'Refunds', href: '/finance/refunds' };
  return null;
}

/** The category a voucher counts under: bills and refunds are a category each, the rest carry their own. */
export function voucherCategory(row: PaymentVoucherRow): string {
  if (row.kind === 'bill') return 'Supplier bills';
  if (row.kind === 'refund') return 'Refunds';
  return row.category_name ?? (row.kind === 'expense' ? 'Several categories' : 'No category');
}

/** Waiting for an owner or admin: recorded, and not yet allowed to be paid. */
export function isWaitingVoucher(row: PaymentVoucherRow): boolean {
  return row.status === 'pending_approval';
}

export function paymentVouchersView(rows: PaymentVoucherRow[], today: string, period: CashBookPeriod): PaymentVouchersViewData {
  // Only money that has actually gone out counts: not waiting, not scheduled, not voided.
  const posted = rows.filter((v) => v.status === 'posted');
  const inRange = posted.filter((v) => inPeriod(v.txn_date, today, period));
  const total = sum(inRange, (v) => v.amount);
  // What is waiting is waiting now, whatever date it carries.
  const waiting = rows.filter(isWaitingVoucher);
  const toPay = rows.filter((v) => v.status === 'scheduled');
  const span = CASH_BOOK_PERIOD_LABELS[period].toLowerCase();

  let hasTrend = false;
  const trend = lastMonths(today).map(({ key, label }) => {
    const inMonth = posted.filter((v) => monthOf(v.txn_date) === key);
    if (inMonth.length > 0) hasTrend = true;
    return { label, paid: thousands(sum(inMonth, (v) => v.amount)) };
  });

  return {
    stats: [
      { label: 'Paid', value: rmShort(total), delta: span, deltaTone: 'flat' },
      {
        label: 'Vouchers',
        value: String(inRange.length),
        delta: toPay.length ? `${toPay.length} more to be paid` : span,
        deltaTone: 'flat',
      },
      {
        label: 'Pending approval',
        value: rmShort(sum(waiting, (v) => v.amount)),
        delta: count(waiting.length, 'voucher'),
        deltaTone: waiting.length ? 'down' : 'flat',
      },
      { label: 'Average voucher', value: inRange.length ? rmShort(total / inRange.length) : '—', delta: span, deltaTone: 'flat' },
    ],
    trend,
    hasTrend,
    byCategory: slices(totalsBy(inRange, voucherCategory, (v) => v.amount), 'Other categories'),
    hasPaid: inRange.length > 0,
    paid: rmShort(total),
  };
}

/** `open` is every voucher that is neither void nor rejected: what the table shows until a status is chosen. */
export type PaymentVoucherFilter = 'open' | 'waiting' | 'scheduled' | 'posted' | 'rejected' | 'void';

/**
 * Vouchers matching the status and kind filters whose number, payee,
 * documents, category or reference contains the search text. A voucher still
 * being written (`draft`) shows under `open` only.
 */
export function filterPaymentVouchers(
  rows: PaymentVoucherRow[],
  query: string,
  filter: PaymentVoucherFilter,
  kind: 'all' | PaymentVoucherKind = 'all',
): PaymentVoucherRow[] {
  const q = query.trim().toLowerCase();
  const matches = (v: PaymentVoucherRow) => {
    if (filter === 'open') return v.status !== 'void' && v.status !== 'rejected';
    if (filter === 'waiting') return isWaitingVoucher(v);
    return v.status === filter;
  };
  return rows.filter(
    (v) =>
      matches(v) &&
      (kind === 'all' || v.kind === kind) &&
      `${v.number ?? ''} ${v.party_name ?? ''} ${v.documents ?? ''} ${voucherCategory(v)} ${v.reference ?? ''}`
        .toLowerCase()
        .includes(q),
  );
}

/** The vouchers table as a CSV file. Amounts are numbers. */
export function paymentVouchersCsv(rows: PaymentVoucherRow[]): string {
  return toCsv(
    ['Date', 'No.', 'Paid to', 'Kind', 'Category', 'For', 'Account', 'Method', 'Reference', 'Amount', 'Status'],
    rows.map((v) => [
      v.txn_date,
      v.number,
      v.party_name,
      PAYMENT_VOUCHER_KIND_LABELS[v.kind],
      voucherCategory(v),
      v.documents,
      v.account_name,
      PAYMENT_METHOD_LABELS[v.method],
      v.reference,
      v.amount,
      PAYMENT_VOUCHER_STATUS_LABELS[v.status],
    ]),
  );
}

/* ---- Expenses ------------------------------------------------------- */

export type ExpensesViewData = {
  stats: Stat[];
  /** The last eight months, oldest first, in RM thousands: what was entered (rejected left out) and what of it is approved. */
  trend: { label: string; entered: number; approved: number }[];
  /** Whether any expense that was not rejected is dated in those eight months. */
  hasTrend: boolean;
  /** Approved expenses dated this calendar year, in RM, per category. */
  byCategory: Slice[];
  /** Whether any approved expense is dated this year. */
  hasSpend: boolean;
  spendYtd: string;
};

export const EXPENSE_STATUS_LABELS: Record<ExpenseDisplayStatus, string> = {
  pending: 'Pending approval',
  approved: 'Approved',
  rejected: 'Rejected',
  paid: 'Paid',
};

/** Approved, paid or not: what the workspace has agreed to spend. A pending or rejected expense is not spend yet. */
export function isApprovedExpense(row: ExpenseRow): boolean {
  return row.display_status === 'approved' || row.display_status === 'paid';
}

export function expensesView(rows: ExpenseRow[], today: string): ExpensesViewData {
  const approved = rows.filter(isApprovedExpense);
  const pending = rows.filter((e) => e.display_status === 'pending');
  const ytd = approved.filter((e) => yearOf(e.expense_date) === yearOf(today));
  const mtd = approved.filter((e) => monthOf(e.expense_date) === monthOf(today));
  const ytdTotal = sum(ytd, (e) => e.amount);
  const perCategory = totalsBy(ytd, (e) => e.category_name, (e) => e.amount);
  const top = [...perCategory.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0];

  let hasTrend = false;
  const trend = lastMonths(today).map(({ key, label }) => {
    const entered = rows.filter((e) => e.display_status !== 'rejected' && monthOf(e.expense_date) === key);
    if (entered.length > 0) hasTrend = true;
    return {
      label,
      entered: thousands(sum(entered, (e) => e.amount)),
      approved: thousands(sum(entered.filter(isApprovedExpense), (e) => e.amount)),
    };
  });

  return {
    stats: [
      { label: 'Total expenses (YTD)', value: rmShort(ytdTotal), delta: count(ytd.length, 'approved expense'), deltaTone: 'flat' },
      { label: 'This month', value: rmShort(sum(mtd, (e) => e.amount)), delta: count(mtd.length, 'approved expense'), deltaTone: 'flat' },
      {
        label: 'Top category',
        value: top ? top[0] : '—',
        delta: top && ytdTotal ? `${Math.round((top[1] / ytdTotal) * 100)}% of spend this year` : 'this year',
        deltaTone: 'flat',
      },
      {
        label: 'Pending approval',
        value: rmShort(sum(pending, (e) => e.amount)),
        delta: count(pending.length, 'expense'),
        deltaTone: pending.length ? 'down' : 'flat',
      },
    ],
    trend,
    hasTrend,
    byCategory: slices(perCategory, 'Other categories'),
    hasSpend: ytd.length > 0,
    spendYtd: rmShort(ytdTotal),
  };
}

/** The categories the rows name, by name, for the category filter. Two categories with one name stay two choices. */
export function expenseCategories(rows: ExpenseRow[]): { id: string; name: string }[] {
  const byId = new Map<string, string>();
  for (const row of rows) byId.set(row.category_id, row.category_name);
  return [...byId.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((x, y) => x.name.localeCompare(y.name) || x.id.localeCompare(y.id));
}

/** `open` is every expense that was not rejected: what the table shows until a status is chosen. */
export type ExpenseFilter = 'open' | ExpenseDisplayStatus;

/** Expenses matching the status and category filters whose vendor, category or notes contains the search text. */
export function filterExpenses(rows: ExpenseRow[], query: string, filter: ExpenseFilter, categoryId: string = 'all'): ExpenseRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter(
    (e) =>
      (filter === 'open' ? e.display_status !== 'rejected' : e.display_status === filter) &&
      (categoryId === 'all' || e.category_id === categoryId) &&
      `${e.vendor_name} ${e.category_name} ${e.notes ?? ''}`.toLowerCase().includes(q),
  );
}

/** How an expense was paid, as the table shows it: a dash while nothing has been paid. */
export function expenseMethod(row: ExpenseRow): string {
  return row.method ? PAYMENT_METHOD_LABELS[row.method] : '—';
}

/** The expenses table as a CSV file. Amounts are numbers; Method is empty while nothing has been paid. */
export function expensesCsv(rows: ExpenseRow[]): string {
  return toCsv(
    ['Date', 'Category', 'Vendor', 'Amount', 'SST', 'Paid', 'Method', 'Status', 'Notes'],
    rows.map((e) => [
      e.expense_date,
      e.category_name,
      e.vendor_name,
      e.amount,
      e.sst_amount,
      e.paid,
      e.method ? PAYMENT_METHOD_LABELS[e.method] : null,
      EXPENSE_STATUS_LABELS[e.display_status],
      e.notes,
    ]),
  );
}
```

- [ ] **Step 4: Write the sample**

Create `src/screens/finance/cash-book-sample.ts`:

```ts
/**
 * Sample cash book data (Rimba Ventures Sdn Bhd), shown on Cash Receipts,
 * Payment Vouchers and Expenses when there is no database. Raw rows in the
 * shape the data layer reads, so the screens run them through the same
 * builders as live data. The cash book lists every movement of money, so the
 * sample's payments in are its receipts and the sample's refunds are among
 * its vouchers: the same money on Payments In and on Cash Receipts, once
 * each. Each paid sample expense has the voucher that paid it.
 */
import type { CashReceiptRow, PaymentVoucherKind, PaymentVoucherRow } from '@/lib/finance/cash-book';
import type { ExpenseRow, ExpenseStatus } from '@/lib/finance/expenses';
import type { PaymentMethod } from '@/lib/finance/money';
import { SAMPLE_PAYMENTS_IN, SAMPLE_REFUNDS } from './sales-sample';

const numbered = (prefix: string, n: number) => `${prefix}-${String(n).padStart(4, '0')}`;
const account = (method: PaymentMethod) =>
  method === 'cash'
    ? ({ account_id: 'cash', account_name: 'Cash in hand', account_kind: 'cash' } as const)
    : ({ account_id: 'bank', account_name: 'Main Bank', account_kind: 'bank' } as const);
const newestFirst = <T>(rows: T[], date: (row: T) => string) => [...rows].sort((x, y) => date(y).localeCompare(date(x)));

/* ---- expenses -------------------------------------------------------- */

/** `paidWith` is null for an expense that has not been paid; a paid one was paid on its own date. */
const expense = (
  n: number,
  expense_date: string,
  category_name: string,
  vendor_name: string,
  amount: number,
  status: ExpenseStatus,
  paidWith: PaymentMethod | null = null,
  sst_amount: number = 0,
): ExpenseRow => ({
  id: `sample-expense-${n}`,
  expense_date,
  category_id: category_name,
  category_name,
  vendor_id: null,
  vendor_name,
  amount,
  sst_amount,
  notes: null,
  status,
  display_status: paidWith ? 'paid' : status,
  paid: paidWith ? amount : 0,
  held: 0,
  method: paidWith,
  paid_on: paidWith ? expense_date : null,
});

/** Earlier months, so the trend has a shape: [month, rent, salaries]. All approved and paid. */
const EXPENSE_HISTORY: [string, number, number][] = [
  ['2026-03', 4500, 8300],
  ['2026-04', 4500, 8300],
  ['2026-05', 4500, 8500],
  ['2026-06', 4500, 8500],
  ['2026-07', 4500, 8700],
  ['2026-08', 4500, 8700],
  ['2026-09', 4500, 8900],
];

/** Newest first, as the real list is. */
export const SAMPLE_EXPENSES: ExpenseRow[] = newestFirst(
  [
    expense(12, '2026-10-09', 'Marketing', 'Billboard Kuala Lumpur', 3600, 'pending'),
    expense(11, '2026-10-08', 'Rent', 'Menara Axis Management', 4500, 'approved', 'bank_transfer'),
    expense(10, '2026-10-07', 'Utilities', 'Suria Utilities Sdn Bhd', 1280, 'approved', 'fpx'),
    expense(9, '2026-10-06', 'Marketing', 'Meta Ads Malaysia', 2200, 'pending'),
    expense(8, '2026-10-05', 'Travel', 'Grab Malaysia', 186, 'approved', 'ewallet'),
    expense(7, '2026-10-04', 'Supplies', 'Printhub Solutions', 640, 'approved', 'cash'),
    expense(6, '2026-10-02', 'Utilities', 'Unifi Business', 94, 'approved', 'card', 5.32),
    expense(5, '2026-10-01', 'Travel', 'AirAsia', 420, 'rejected'),
    expense(4, '2026-09-30', 'Services', 'Syarikat Guaman Lee', 1500, 'approved'),
    ...EXPENSE_HISTORY.flatMap(([month, rent, salaries], i) => [
      expense(100 + i * 2, `${month}-03`, 'Rent', 'Menara Axis Management', rent, 'approved', 'bank_transfer'),
      expense(101 + i * 2, `${month}-28`, 'Salaries', `Payroll, ${month}`, salaries, 'approved', 'bank_transfer'),
    ]),
  ],
  (row) => row.expense_date,
);

/* ---- payment vouchers ------------------------------------------------ */

const voucher = (
  id: string,
  number: string | null,
  txn_date: string,
  party_name: string,
  kind: PaymentVoucherKind,
  category_name: string | null,
  documents: string | null,
  method: PaymentMethod,
  amount: number,
  status: PaymentVoucherRow['status'] = 'posted',
): PaymentVoucherRow => ({
  transaction_id: id,
  number,
  txn_date,
  method,
  amount,
  status,
  reference: null,
  notes: null,
  ...account(method),
  contact_id: null,
  party_name,
  kind,
  category_id: category_name,
  category_name,
  documents,
  approved_at: kind === 'other' && status !== 'pending_approval' ? `${txn_date}T02:00:00Z` : null,
});

/** One voucher per paid sample expense, numbered from PV-0200 in date order. */
const EXPENSE_VOUCHERS: PaymentVoucherRow[] = [...SAMPLE_EXPENSES]
  .filter((e) => e.method !== null)
  .sort((x, y) => x.expense_date.localeCompare(y.expense_date) || x.id.localeCompare(y.id))
  .map((e, i) =>
    voucher(`sample-voucher-${e.id}`, numbered('PV', 200 + i), e.expense_date, e.vendor_name, 'expense', e.category_name, null, e.method!, e.amount),
  );

/** The sample's refunds, as the vouchers they are. */
const REFUND_VOUCHERS: PaymentVoucherRow[] = SAMPLE_REFUNDS.map((r) =>
  voucher(r.transaction_id, r.number, r.txn_date, r.customer_name, 'refund', null, r.credit_note_no ?? r.invoice_no, r.method, r.amount, r.status),
);

/** Newest first, as the real list is. */
export const SAMPLE_PAYMENT_VOUCHERS: PaymentVoucherRow[] = newestFirst(
  [
    voucher('sample-voucher-1', null, '2026-10-10', 'Tenaga Nasional Berhad', 'other', 'Utilities', null, 'bank_transfer', 960, 'scheduled'),
    voucher('sample-voucher-2', null, '2026-10-09', 'Syarikat Ramli & Anak', 'other', 'Rent', null, 'bank_transfer', 2200, 'pending_approval'),
    voucher('sample-voucher-3', null, '2026-10-06', 'Kurier Pantas Sdn Bhd', 'other', 'Services', null, 'bank_transfer', 2140, 'pending_approval'),
    voucher('sample-voucher-4', numbered('PV', 120), '2026-10-04', 'Syabas Air Selangor', 'other', 'Utilities', null, 'fpx', 420),
    voucher('sample-voucher-5', numbered('PV', 119), '2026-10-01', 'Majlis Bandaraya Shah Alam', 'other', 'Services', null, 'cash', 380),
    voucher('sample-voucher-6', null, '2026-09-28', 'Kedai Alat Tulis Maju', 'other', 'Supplies', null, 'cash', 75, 'rejected'),
    voucher('sample-voucher-7', numbered('PV', 118), '2026-10-07', 'Nusantara Logistics', 'bill', null, 'BILL-0225', 'fpx', 1180),
    voucher('sample-voucher-8', numbered('PV', 117), '2026-10-06', 'Printhub Enterprise', 'bill', null, 'BILL-0230', 'bank_transfer', 1450),
    voucher('sample-voucher-9', numbered('PV', 116), '2026-10-02', 'Kedai Kertas Ah Seng', 'bill', null, 'BILL-0224', 'cash', 1650),
    voucher('sample-voucher-10', null, '2026-10-12', 'Syarikat Maju Jaya', 'bill', null, 'BILL-0228', 'bank_transfer', 4300, 'scheduled'),
    ...REFUND_VOUCHERS,
    ...EXPENSE_VOUCHERS,
  ],
  (row) => row.txn_date,
);

/* ---- cash receipts --------------------------------------------------- */

const income = (
  n: number,
  number: string | null,
  txn_date: string,
  party_name: string,
  category_name: string,
  method: PaymentMethod,
  amount: number,
): CashReceiptRow => ({
  transaction_id: `sample-income-${n}`,
  number,
  txn_date,
  method,
  amount,
  status: number === null ? 'draft' : 'posted',
  reference: null,
  notes: null,
  ...account(method),
  contact_id: null,
  party_name,
  kind: 'income',
  category_id: category_name,
  category_name,
  documents: null,
});

/** The sample's payments in, as the receipts they are: one row per payment, with the invoices it pays. */
const INVOICE_RECEIPTS: CashReceiptRow[] = [...new Set(SAMPLE_PAYMENTS_IN.map((p) => p.transaction_id))].map((id) => {
  const parts = SAMPLE_PAYMENTS_IN.filter((p) => p.transaction_id === id);
  const first = parts[0];
  return {
    transaction_id: id,
    number: first.number,
    txn_date: first.txn_date,
    method: first.method,
    amount: first.transaction_amount,
    status: first.status,
    reference: first.reference,
    notes: null,
    ...account(first.method),
    contact_id: null,
    party_name: first.customer_name,
    kind: 'invoice',
    category_id: null,
    category_name: null,
    documents: parts
      .map((p) => p.invoice_no ?? '')
      .sort()
      .join(', '),
  };
});

/** Newest first, as the real list is. */
export const SAMPLE_CASH_RECEIPTS: CashReceiptRow[] = newestFirst(
  [
    income(7, null, '2026-10-10', 'Langkawi Fresh', 'Sales', 'cheque', 2180),
    income(6, numbered('RC', 114), '2026-10-09', 'Kedai Runcit Pak Din', 'Sales', 'cash', 850),
    income(5, numbered('RC', 113), '2026-10-06', 'Mei Ling Bakery', 'Sales', 'cash', 900),
    income(4, numbered('RC', 112), '2026-10-04', 'Tan & Sons Enterprise', 'Sales', 'duitnow', 1200),
    income(3, numbered('RC', 111), '2026-09-29', 'Bank Islam, profit paid', 'Other income', 'bank_transfer', 64.2),
    income(2, numbered('RC', 110), '2026-08-31', 'Kedai Runcit Pak Din', 'Sales', 'cash', 780),
    income(1, numbered('RC', 109), '2026-07-30', 'Mei Ling Bakery', 'Sales', 'cash', 650),
    ...INVOICE_RECEIPTS,
  ],
  (row) => row.txn_date,
);
```

- [ ] **Step 5: Run the tests**

Run: `pnpm exec vitest run tests/finance-cash-book-views.test.ts tests/finance-followon-views.test.ts tests/finance-sales-views.test.ts`
Expected: PASS, all three files; the first has 31 tests. The other two are run because they read `sales-sample.ts`, which this task imports from and must not have changed.

- [ ] **Step 6: Type-check, lint and commit**

Run: `pnpm exec tsc --noEmit` then `pnpm lint`
Expected: no errors; lint reports the one warning it had before this branch and nothing new.

Run: `grep -n -E "supabase/server|next/headers|server-only" src/lib/finance/cash-book-views.ts src/screens/finance/cash-book-sample.ts`
Expected: no output.

Run: `git diff --stat -- src/screens/finance/sales-sample.ts`
Expected: no output.

```bash
git add src/lib/finance/cash-book-views.ts src/screens/finance/cash-book-sample.ts tests/finance-cash-book-views.test.ts
git commit -m "feat: figures, charts, filters and CSV for Cash Receipts, Payment Vouchers and Expenses"
```

---

### Task 5: Cash Receipts, Payment Vouchers and Expenses go live, read-only

**Files:**
- Modify: `tests/live-screens.test.ts`, `tests/finance-contact-paths.test.ts`, `tests/finance-sales-actions.test.ts`, `tests/finance-actions.test.ts`, `tests/finance-credit-refund-actions.test.ts`, `tests/finance-quotation-actions.test.ts` (one line)
- Create: `src/components/finance/cash-receipts-view.tsx`, `src/components/finance/payment-vouchers-view.tsx`, `src/components/finance/expenses-view.tsx`
- Replace: `src/screens/finance/cash-receipts.tsx`, `src/screens/finance/payment-vouchers.tsx`, `src/screens/finance/expenses.tsx`
- Modify: `src/config/live-screens.ts`, `src/app/(app)/finance/actions.ts`

**Interfaces:**
- Consumes: `listCashReceipts`, `listPaymentVouchers`, `CashReceiptRow`, `PaymentVoucherRow`, `PaymentVoucherKind` (Task 2, `cash-book.ts`); `listExpenses`, `ExpenseRow`, `ExpenseDisplayStatus` (Task 2, `expenses.ts`); everything Task 4 exports from `cash-book-views.ts`; `SAMPLE_CASH_RECEIPTS`, `SAMPLE_PAYMENT_VOUCHERS`, `SAMPLE_EXPENSES` (Task 4) and `SAMPLE_TODAY` from `sales-sample.ts`; `getViewer`, `hasSupabaseEnv`, `createClient`, `todayUtc`, `LATEST_ROWS`, `displayDate`, `localIsoDate`, `rm`, `csvFileName`, `downloadCsv`, `PAYMENT_METHOD_LABELS`, and the bento, chart, table, select, input, button and live-dot components the other finance views use.
- Produces:
  - `CashReceiptsView({ rows, today }: { rows: CashReceiptRow[]; today: string })`
  - `PaymentVouchersView({ rows, today }: { rows: PaymentVoucherRow[]; today: string })`
  - `ExpensesView({ rows, view }: { rows: ExpenseRow[]; view: ExpensesViewData })`
  - Three screen files whose default export is an async server component with no props, which is what the generated route files under `src/app/(app)/finance/` import.
  - `LIVE_SCREENS` has `finance/cash-receipts`, `finance/payment-vouchers` and `finance/expenses`.
  - In `actions.ts`: `CONTACT_PATHS` has the three new paths; `SALES_PATHS` has `/finance/cash-receipts`; `PURCHASE_PATHS` and `CREDIT_PATHS` have `/finance/payment-vouchers`. No action is added.

Cash Receipts and Payment Vouchers have a period selector, so their figures are worked out in the browser from the rows and `today` each time the period changes; the loader hands over rows, not figures. Expenses has no selector and gets its figures from the loader, as the other finance screens do.

None of the three views takes a `writer`, an action, a form or a row menu. `src/screens/finance/expenses.tsx` is a client component today (`'use client'` on its first line); it becomes a server loader like the other two, and its search and filters move into the client view.

Which existing actions refresh the new screens, and why. A payment in recorded or voided on Payments In is a receipt, so `SALES_PATHS` gains Cash Receipts. A payment to a supplier recorded, marked paid, voided or deleted on Payments Out is a voucher, so `PURCHASE_PATHS` gains Payment Vouchers; a refund at any step is one too, so `CREDIT_PATHS` gains it. A contact's name is the payer on a receipt, the payee on a voucher and the vendor on an expense, so `CONTACT_PATHS` gains all three. Each list is used by more actions than strictly need the new path (saving a bill refreshes Payment Vouchers, issuing a credit note does too): that is how these lists already work, and the note in `docs/bendahara-backend.md` says so.

`tests/finance-quotation-actions.test.ts` gets one line changed, a constant that lists the purchase paths. Another change in flight edits that file's quotation tests; if this replacement no longer finds its line after a rebase, make the same one-word addition by hand.

- [ ] **Step 1: Write the failing tests**

In `tests/live-screens.test.ts`, replace:

```ts
  it('counts Invoices and Payments In as live, and the sales screens not yet connected as sample', () => {
    expect(isSampleScreen('/finance/invoices')).toBe(false);
    expect(isSampleScreen('/finance/payments-in')).toBe(false);
    expect(isSampleScreen('/finance/cash-receipts')).toBe(true);
  });

  it('counts Quotations, Credit Notes and Refunds as live, and the Cash Book screens as sample', () => {
    for (const slug of ['quotations', 'credit-notes', 'refunds']) {
      expect(isSampleScreen(`/finance/${slug}`), slug).toBe(false);
    }
    for (const slug of ['cash-receipts', 'payment-vouchers', 'expenses']) {
      expect(isSampleScreen(`/finance/${slug}`), slug).toBe(true);
    }
  });
```

with:

```ts
  it('counts Invoices and Payments In as live', () => {
    expect(isSampleScreen('/finance/invoices')).toBe(false);
    expect(isSampleScreen('/finance/payments-in')).toBe(false);
  });

  it('counts Quotations, Credit Notes and Refunds as live', () => {
    for (const slug of ['quotations', 'credit-notes', 'refunds']) {
      expect(isSampleScreen(`/finance/${slug}`), slug).toBe(false);
    }
  });

  it('counts Cash Receipts, Payment Vouchers and Expenses as live, and Banking and Receipts Inbox as sample', () => {
    for (const slug of ['cash-receipts', 'payment-vouchers', 'expenses']) {
      expect(isSampleScreen(`/finance/${slug}`), slug).toBe(false);
    }
    for (const slug of ['banking', 'receipts-inbox']) {
      expect(isSampleScreen(`/finance/${slug}`), slug).toBe(true);
    }
  });
```

In `tests/finance-contact-paths.test.ts`, replace:

```ts
        '/finance/credit-notes',
        '/finance/refunds',
      ]);
```

with:

```ts
        '/finance/credit-notes',
        '/finance/refunds',
        // The payer on a receipt, the payee on a voucher and the vendor on an expense.
        '/finance/cash-receipts',
        '/finance/payment-vouchers',
        '/finance/expenses',
      ]);
```

In `tests/finance-sales-actions.test.ts`, replace:

```ts
  '/finance/credit-notes',
  '/finance/refunds',
];
const FORBIDDEN = { ok: false, error: 'You do not have permission to make changes here.' };
```

with:

```ts
  '/finance/credit-notes',
  '/finance/refunds',
  // A payment in is a receipt: Cash Receipts lists every movement of money in.
  '/finance/cash-receipts',
];
const FORBIDDEN = { ok: false, error: 'You do not have permission to make changes here.' };
```

In `tests/finance-sales-actions.test.ts`, replace:

```ts
    expect(ctl.revalidated).toEqual(['/finance/supplier-bills', '/finance/payments-out', '/finance/customers-suppliers']);
```

with:

```ts
    expect(ctl.revalidated).toEqual([
      '/finance/supplier-bills', '/finance/payments-out', '/finance/customers-suppliers', '/finance/payment-vouchers',
    ]);
    expect(ctl.revalidated).not.toContain('/finance/cash-receipts');
```

In `tests/finance-actions.test.ts`, replace:

```ts
const PATHS = ['/finance/supplier-bills', '/finance/payments-out', '/finance/customers-suppliers'];
```

with:

```ts
// A payment to a supplier is a voucher: Payment Vouchers lists every movement of money out.
const PATHS = ['/finance/supplier-bills', '/finance/payments-out', '/finance/customers-suppliers', '/finance/payment-vouchers'];
```

In `tests/finance-quotation-actions.test.ts`, replace:

```ts
const PURCHASES = ['/finance/supplier-bills', '/finance/payments-out', '/finance/customers-suppliers'];
```

with:

```ts
const PURCHASES = ['/finance/supplier-bills', '/finance/payments-out', '/finance/customers-suppliers', '/finance/payment-vouchers'];
```

In `tests/finance-credit-refund-actions.test.ts`, replace:

```ts
/** The five screens where a figure moves when an invoice's balance or a customer's credit does. */
const CREDIT = [
  '/finance/invoices',
  '/finance/payments-in',
  '/finance/customers-suppliers',
  '/finance/credit-notes',
  '/finance/refunds',
];
```

with:

```ts
/**
 * The five screens where a figure moves when an invoice's balance or a customer's credit does, and Payment
 * Vouchers, which lists every refund as the money out it is.
 */
const CREDIT = [
  '/finance/invoices',
  '/finance/payments-in',
  '/finance/customers-suppliers',
  '/finance/credit-notes',
  '/finance/refunds',
  '/finance/payment-vouchers',
];
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm exec vitest run tests/live-screens.test.ts tests/finance-contact-paths.test.ts tests/finance-sales-actions.test.ts tests/finance-actions.test.ts tests/finance-credit-refund-actions.test.ts tests/finance-quotation-actions.test.ts`
Expected: FAIL in all six files: the three Cash Book screens still count as sample, and each action still refreshes the paths it did.

- [ ] **Step 3: Write the Cash Receipts view**

Create `src/components/finance/cash-receipts-view.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { Banknote, Download, Landmark, PieChart, Search, TrendingUp } from 'lucide-react';
import { BentoCard, BentoGrid, BentoStat } from '@/components/bento/bento';
import { AreaTrend, DonutStat, type Series } from '@/components/charts';
import { downloadCsv } from '@/components/finance/download-csv';
import { PageHeader } from '@/components/screen/page-header';
import { ScreenContainer } from '@/components/screen/screen-container';
import { NoMatchesRow } from '@/components/screen/table-filter';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LiveDot } from '@/components/ui/live-dot';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { localIsoDate } from '@/lib/finance/bill-math';
import type { CashReceiptRow } from '@/lib/finance/cash-book';
import {
  CASH_BOOK_PERIODS,
  CASH_BOOK_PERIOD_LABELS,
  CASH_RECEIPT_STATUS_LABELS,
  type CashBookPeriod,
  type CashReceiptFilter,
  cashReceiptsCsv,
  cashReceiptsView,
  filterCashReceipts,
  receiptFor,
} from '@/lib/finance/cash-book-views';
import { csvFileName } from '@/lib/finance/csv';
import { rm } from '@/lib/finance/format';
import { PAYMENT_METHOD_LABELS } from '@/lib/finance/money';
import { LATEST_ROWS, displayDate } from '@/lib/finance/view-helpers';
import { cn } from '@/lib/utils';

const RECEIVED_SERIES: Series[] = [
  { key: 'bank', label: 'Bank (RM k)', color: 'var(--chart-1)' },
  { key: 'cash', label: 'Cash (RM k)', color: 'var(--chart-2)' },
];

const STATUS_STYLES: Record<CashReceiptRow['status'], string> = {
  posted: 'bg-emerald-500/15 text-emerald-600',
  draft: 'bg-muted text-muted-foreground',
  scheduled: 'bg-amber-500/15 text-amber-600',
  pending_approval: 'bg-amber-500/15 text-amber-600',
  rejected: 'bg-red-500/15 text-red-600',
  void: 'bg-muted text-muted-foreground line-through',
};

/**
 * Cash Receipts: every movement of money in, one row each, with figures and
 * charts for the chosen period, search, a status filter, "View all" and
 * Export. Nothing here changes data yet: a payment against invoices is
 * recorded and voided on Payments In, and the receipt form arrives later.
 */
export function CashReceiptsView({
  rows,
  today,
}: {
  /** Every receipt, newest first; drafts and void ones included. */
  rows: CashReceiptRow[];
  /** The date the figures are worked out for, YYYY-MM-DD. */
  today: string;
}) {
  const [period, setPeriod] = useState<CashBookPeriod>('month');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<CashReceiptFilter>('open');
  const [showAll, setShowAll] = useState(false);

  const view = cashReceiptsView(rows, today, period);
  const matching = filterCashReceipts(rows, query, filter);
  const shown = showAll ? matching : matching.slice(0, LATEST_ROWS);
  const span = CASH_BOOK_PERIOD_LABELS[period];

  return (
    <ScreenContainer>
      <PageHeader
        title="Cash Receipts"
        subtitle="Money received into cash and bank, Saudara."
        actions={
          <Select value={period} onValueChange={(v) => setPeriod(v as CashBookPeriod)}>
            <SelectTrigger className="w-40" aria-label="Period">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CASH_BOOK_PERIODS.map((p) => (
                <SelectItem key={p} value={p}>
                  {CASH_BOOK_PERIOD_LABELS[p]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />

      <BentoGrid>
        {view.stats.map((s, i) => (
          <BentoCard key={s.label} tone={i === 0 ? 'primary' : 'default'} className="col-span-1 md:col-span-3">
            <BentoStat label={s.label} value={s.value} delta={s.delta} deltaTone={s.deltaTone} onPrimary={i === 0} />
          </BentoCard>
        ))}

        <BentoCard title="Receipts over time" subtitle="Bank and cash · last 8 months" icon={TrendingUp} className="col-span-2 md:col-span-8">
          {view.hasTrend ? (
            <AreaTrend data={view.trend} series={RECEIVED_SERIES} height={240} stacked showLegend />
          ) : (
            <p className="grid h-60 place-items-center text-sm text-muted-foreground">Nothing received in the last 8 months.</p>
          )}
        </BentoCard>
        <BentoCard title="By account" subtitle={`Received · ${span.toLowerCase()}`} icon={PieChart} className="col-span-2 md:col-span-4">
          {view.hasReceived ? (
            <DonutStat data={view.byAccount} height={240} centerValue={view.received} centerLabel="received" />
          ) : (
            <p className="grid h-60 place-items-center text-sm text-muted-foreground">Nothing received {span.toLowerCase()}.</p>
          )}
        </BentoCard>

        <BentoCard
          title="Receipts"
          subtitle="Every payment in, against invoices or not"
          icon={Banknote}
          flush
          action={
            matching.length > LATEST_ROWS ? (
              <Button variant="outline" size="sm" aria-pressed={showAll} onClick={() => setShowAll((v) => !v)}>
                {showAll ? 'Show latest' : 'View all'}
              </Button>
            ) : undefined
          }
          className="col-span-2 md:col-span-12"
        >
          <div className="flex flex-wrap items-center gap-2 px-4">
            <div className="relative w-full sm:w-72">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                aria-label="Search receipts by payer, number, invoice or category"
                placeholder="Search payers, numbers or invoices…"
                className="pl-8"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <Select value={filter} onValueChange={(v) => setFilter(v as CashReceiptFilter)}>
              <SelectTrigger className="w-40" aria-label="Status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="open">All except void</SelectItem>
                <SelectItem value="draft">Draft</SelectItem>
                <SelectItem value="posted">Posted</SelectItem>
                <SelectItem value="void">Void</SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              disabled={matching.length === 0}
              onClick={() => downloadCsv(csvFileName('cash-receipts', localIsoDate(new Date())), cashReceiptsCsv(matching))}
            >
              <Download className="size-4" />
              Export
            </Button>
          </div>
          <div className="mt-3 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40">
                  <TableHead>Date</TableHead>
                  <TableHead>No.</TableHead>
                  <TableHead>Received from</TableHead>
                  <TableHead>For</TableHead>
                  <TableHead>Account</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.length === 0 &&
                  (rows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={8} className="py-8 text-center text-muted-foreground">
                        No receipts yet. A payment recorded on Payments In shows here too.
                      </TableCell>
                    </TableRow>
                  ) : (
                    <NoMatchesRow colSpan={8} />
                  ))}
                {shown.map((r) => (
                  <TableRow key={r.transaction_id} className={cn(r.status === 'void' && 'opacity-60')}>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{displayDate(r.txn_date)}</TableCell>
                    <TableCell className="whitespace-nowrap font-medium">{r.number ?? '—'}</TableCell>
                    <TableCell className="whitespace-nowrap">{r.party_name ?? '—'}</TableCell>
                    <TableCell className="max-w-64 truncate text-muted-foreground">{receiptFor(r)}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                        {r.account_kind === 'cash' ? <Banknote className="size-3.5" /> : <Landmark className="size-3.5" />}
                        {r.account_name}
                      </span>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{PAYMENT_METHOD_LABELS[r.method]}</TableCell>
                    <TableCell className="whitespace-nowrap text-right tabular-nums">{rm(r.amount)}</TableCell>
                    <TableCell>
                      <span className="flex items-center gap-2">
                        <LiveDot active={r.status === 'posted'} />
                        <span
                          className={cn(
                            'inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold',
                            STATUS_STYLES[r.status],
                          )}
                        >
                          {CASH_RECEIPT_STATUS_LABELS[r.status]}
                        </span>
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="border-t px-4 py-3 text-sm text-muted-foreground">
            Showing {shown.length} of {matching.length} receipts
            {matching.length !== rows.length ? ` (${rows.length} in all)` : ''}
          </div>
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}
```

- [ ] **Step 4: Write the Payment Vouchers view**

The Kind cell of a payment to a supplier or a refund is a link to the screen that changes it. Nothing on this screen changes anything.

Create `src/components/finance/payment-vouchers-view.tsx`:

```tsx
'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Download, PieChart, Search, TrendingUp, Wallet } from 'lucide-react';
import { BentoCard, BentoGrid, BentoStat } from '@/components/bento/bento';
import { AreaTrend, DonutStat, type Series } from '@/components/charts';
import { downloadCsv } from '@/components/finance/download-csv';
import { PageHeader } from '@/components/screen/page-header';
import { ScreenContainer } from '@/components/screen/screen-container';
import { NoMatchesRow } from '@/components/screen/table-filter';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LiveDot } from '@/components/ui/live-dot';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { localIsoDate } from '@/lib/finance/bill-math';
import type { PaymentVoucherKind, PaymentVoucherRow } from '@/lib/finance/cash-book';
import {
  CASH_BOOK_PERIODS,
  CASH_BOOK_PERIOD_LABELS,
  PAYMENT_VOUCHER_KIND_LABELS,
  PAYMENT_VOUCHER_STATUS_LABELS,
  type CashBookPeriod,
  type PaymentVoucherFilter,
  filterPaymentVouchers,
  paymentVouchersCsv,
  paymentVouchersView,
  voucherCategory,
  voucherHome,
} from '@/lib/finance/cash-book-views';
import { csvFileName } from '@/lib/finance/csv';
import { rm } from '@/lib/finance/format';
import { LATEST_ROWS, displayDate } from '@/lib/finance/view-helpers';
import { cn } from '@/lib/utils';

const PAID_SERIES: Series[] = [{ key: 'paid', label: 'Paid out (RM k)', color: 'var(--chart-1)' }];

const KINDS: PaymentVoucherKind[] = ['bill', 'refund', 'expense', 'other'];

const STATUS_STYLES: Record<PaymentVoucherRow['status'], string> = {
  posted: 'bg-emerald-500/15 text-emerald-600',
  scheduled: 'bg-sky-500/15 text-sky-600',
  pending_approval: 'bg-amber-500/15 text-amber-600',
  draft: 'bg-muted text-muted-foreground',
  rejected: 'bg-red-500/15 text-red-600',
  void: 'bg-muted text-muted-foreground line-through',
};

/**
 * Payment Vouchers: every movement of money out, one row each, with figures
 * and charts for the chosen period, search, status and kind filters, "View
 * all" and Export. Nothing here changes data yet. A payment to a supplier is
 * changed on Payments Out and a refund on Refunds, and each such row links
 * there; the voucher form and the approve and reject buttons arrive later.
 */
export function PaymentVouchersView({
  rows,
  today,
}: {
  /** Every voucher, newest first; waiting, rejected and void ones included. */
  rows: PaymentVoucherRow[];
  /** The date the figures are worked out for, YYYY-MM-DD. */
  today: string;
}) {
  const [period, setPeriod] = useState<CashBookPeriod>('month');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<PaymentVoucherFilter>('open');
  const [kind, setKind] = useState<'all' | PaymentVoucherKind>('all');
  const [showAll, setShowAll] = useState(false);

  const view = paymentVouchersView(rows, today, period);
  const matching = filterPaymentVouchers(rows, query, filter, kind);
  const shown = showAll ? matching : matching.slice(0, LATEST_ROWS);
  const span = CASH_BOOK_PERIOD_LABELS[period];

  return (
    <ScreenContainer>
      <PageHeader
        title="Payment Vouchers"
        subtitle="Money paid out to suppliers, customers and expenses, Saudara."
        actions={
          <Select value={period} onValueChange={(v) => setPeriod(v as CashBookPeriod)}>
            <SelectTrigger className="w-40" aria-label="Period">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CASH_BOOK_PERIODS.map((p) => (
                <SelectItem key={p} value={p}>
                  {CASH_BOOK_PERIOD_LABELS[p]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />

      <BentoGrid>
        {view.stats.map((s, i) => (
          <BentoCard key={s.label} tone={i === 0 ? 'primary' : 'default'} className="col-span-1 md:col-span-3">
            <BentoStat label={s.label} value={s.value} delta={s.delta} deltaTone={s.deltaTone} onPrimary={i === 0} />
          </BentoCard>
        ))}

        <BentoCard title="Payments over time" subtitle="Paid out · last 8 months" icon={TrendingUp} className="col-span-2 md:col-span-8">
          {view.hasTrend ? (
            <AreaTrend data={view.trend} series={PAID_SERIES} height={240} />
          ) : (
            <p className="grid h-60 place-items-center text-sm text-muted-foreground">Nothing paid out in the last 8 months.</p>
          )}
        </BentoCard>
        <BentoCard title="By category" subtitle={`Paid · ${span.toLowerCase()}`} icon={PieChart} className="col-span-2 md:col-span-4">
          {view.hasPaid ? (
            <DonutStat data={view.byCategory} height={240} centerValue={view.paid} centerLabel="paid" />
          ) : (
            <p className="grid h-60 place-items-center text-sm text-muted-foreground">Nothing paid out {span.toLowerCase()}.</p>
          )}
        </BentoCard>

        <BentoCard
          title="Vouchers"
          subtitle="Every payment out: suppliers, refunds, expenses and the rest"
          icon={Wallet}
          flush
          action={
            matching.length > LATEST_ROWS ? (
              <Button variant="outline" size="sm" aria-pressed={showAll} onClick={() => setShowAll((v) => !v)}>
                {showAll ? 'Show latest' : 'View all'}
              </Button>
            ) : undefined
          }
          className="col-span-2 md:col-span-12"
        >
          <div className="flex flex-wrap items-center gap-2 px-4">
            <div className="relative w-full sm:w-72">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                aria-label="Search vouchers by payee, number, document or category"
                placeholder="Search payees, numbers or categories…"
                className="pl-8"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <Select value={filter} onValueChange={(v) => setFilter(v as PaymentVoucherFilter)}>
              <SelectTrigger className="w-44" aria-label="Status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="open">All but void and rejected</SelectItem>
                <SelectItem value="waiting">Pending approval</SelectItem>
                <SelectItem value="scheduled">To be paid</SelectItem>
                <SelectItem value="posted">Paid</SelectItem>
                <SelectItem value="rejected">Rejected</SelectItem>
                <SelectItem value="void">Void</SelectItem>
              </SelectContent>
            </Select>
            <Select value={kind} onValueChange={(v) => setKind(v as 'all' | PaymentVoucherKind)}>
              <SelectTrigger className="w-44" aria-label="Kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All kinds</SelectItem>
                {KINDS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {PAYMENT_VOUCHER_KIND_LABELS[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              disabled={matching.length === 0}
              onClick={() => downloadCsv(csvFileName('payment-vouchers', localIsoDate(new Date())), paymentVouchersCsv(matching))}
            >
              <Download className="size-4" />
              Export
            </Button>
          </div>
          <div className="mt-3 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40">
                  <TableHead>Date</TableHead>
                  <TableHead>No.</TableHead>
                  <TableHead>Paid to</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Account</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.length === 0 &&
                  (rows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={8} className="py-8 text-center text-muted-foreground">
                        No vouchers yet. A payment recorded on Payments Out or Refunds shows here too.
                      </TableCell>
                    </TableRow>
                  ) : (
                    <NoMatchesRow colSpan={8} />
                  ))}
                {shown.map((v) => {
                  const home = voucherHome(v.kind);
                  return (
                    <TableRow key={v.transaction_id} className={cn(v.status === 'void' && 'opacity-60')}>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{displayDate(v.txn_date)}</TableCell>
                      <TableCell className="whitespace-nowrap font-medium">{v.number ?? '—'}</TableCell>
                      <TableCell className="whitespace-nowrap">{v.party_name ?? '—'}</TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {home ? (
                          <Link
                            href={home.href}
                            title={`Managed on ${home.label}`}
                            className="font-medium text-primary underline-offset-4 hover:underline"
                          >
                            {PAYMENT_VOUCHER_KIND_LABELS[v.kind]}
                          </Link>
                        ) : (
                          PAYMENT_VOUCHER_KIND_LABELS[v.kind]
                        )}
                        {v.documents ? <span className="ml-1.5">· {v.documents}</span> : null}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{voucherCategory(v)}</TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{v.account_name}</TableCell>
                      <TableCell className="whitespace-nowrap text-right tabular-nums">{rm(v.amount)}</TableCell>
                      <TableCell>
                        <span className="flex items-center gap-2">
                          <LiveDot active={v.status === 'posted'} />
                          <span
                            className={cn(
                              'inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold',
                              STATUS_STYLES[v.status],
                            )}
                          >
                            {PAYMENT_VOUCHER_STATUS_LABELS[v.status]}
                          </span>
                        </span>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          <div className="border-t px-4 py-3 text-sm text-muted-foreground">
            Showing {shown.length} of {matching.length} vouchers
            {matching.length !== rows.length ? ` (${rows.length} in all)` : ''}
          </div>
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}
```

- [ ] **Step 5: Write the Expenses view**

Create `src/components/finance/expenses-view.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { Download, FileText, PieChart, Search, TrendingUp } from 'lucide-react';
import { BentoCard, BentoGrid, BentoStat } from '@/components/bento/bento';
import { AreaTrend, DonutStat, type Series } from '@/components/charts';
import { downloadCsv } from '@/components/finance/download-csv';
import { PageHeader } from '@/components/screen/page-header';
import { ScreenContainer } from '@/components/screen/screen-container';
import { NoMatchesRow } from '@/components/screen/table-filter';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LiveDot } from '@/components/ui/live-dot';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { localIsoDate } from '@/lib/finance/bill-math';
import {
  EXPENSE_STATUS_LABELS,
  type ExpenseFilter,
  type ExpensesViewData,
  expenseCategories,
  expenseMethod,
  expensesCsv,
  filterExpenses,
} from '@/lib/finance/cash-book-views';
import { csvFileName } from '@/lib/finance/csv';
import type { ExpenseDisplayStatus, ExpenseRow } from '@/lib/finance/expenses';
import { rm } from '@/lib/finance/format';
import { LATEST_ROWS, displayDate } from '@/lib/finance/view-helpers';
import { cn } from '@/lib/utils';

const SPEND_SERIES: Series[] = [
  { key: 'entered', label: 'Entered (RM k)', color: 'var(--chart-1)' },
  { key: 'approved', label: 'Approved (RM k)', color: 'var(--chart-2)' },
];

const STATUS_STYLES: Record<ExpenseDisplayStatus, string> = {
  paid: 'bg-emerald-500/15 text-emerald-600',
  approved: 'bg-sky-500/15 text-sky-600',
  pending: 'bg-amber-500/15 text-amber-600',
  rejected: 'bg-red-500/15 text-red-600',
};

/**
 * Expenses: figures, charts and the table, with search, category and status
 * filters, "View all" and Export. Nothing here changes data yet: the expense
 * form, approve and reject, and "mark paid" arrive later.
 */
export function ExpensesView({
  rows,
  view,
}: {
  /** Every expense, newest first; pending and rejected ones included. */
  rows: ExpenseRow[];
  view: ExpensesViewData;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ExpenseFilter>('open');
  const [category, setCategory] = useState('all');
  const [showAll, setShowAll] = useState(false);

  const categories = expenseCategories(rows);
  // A category that is no longer among the rows after a refresh would leave the table empty with nothing to say why.
  const chosen = category === 'all' || categories.some((c) => c.id === category) ? category : 'all';
  const matching = filterExpenses(rows, query, filter, chosen);
  const shown = showAll ? matching : matching.slice(0, LATEST_ROWS);

  return (
    <ScreenContainer>
      <PageHeader title="Expenses" subtitle="Business expenses and spending, Saudara." />

      <BentoGrid>
        {view.stats.map((s, i) => (
          <BentoCard key={s.label} tone={i === 0 ? 'primary' : 'default'} className="col-span-1 md:col-span-3">
            <BentoStat label={s.label} value={s.value} delta={s.delta} deltaTone={s.deltaTone} onPrimary={i === 0} />
          </BentoCard>
        ))}

        <BentoCard title="Expenses over time" subtitle="Entered and approved · last 8 months" icon={TrendingUp} className="col-span-2 md:col-span-8">
          {view.hasTrend ? (
            <AreaTrend data={view.trend} series={SPEND_SERIES} height={240} showLegend />
          ) : (
            <p className="grid h-60 place-items-center text-sm text-muted-foreground">No expenses in the last 8 months.</p>
          )}
        </BentoCard>
        <BentoCard title="Spend by category" subtitle="Approved · this year" icon={PieChart} className="col-span-2 md:col-span-4">
          {view.hasSpend ? (
            <DonutStat data={view.byCategory} height={240} centerValue={view.spendYtd} centerLabel="spend" />
          ) : (
            <p className="grid h-60 place-items-center text-sm text-muted-foreground">Nothing approved this year.</p>
          )}
        </BentoCard>

        <BentoCard
          title="Expenses"
          subtitle="What was spent, and what is waiting for approval"
          icon={FileText}
          flush
          action={
            matching.length > LATEST_ROWS ? (
              <Button variant="outline" size="sm" aria-pressed={showAll} onClick={() => setShowAll((v) => !v)}>
                {showAll ? 'Show latest' : 'View all'}
              </Button>
            ) : undefined
          }
          className="col-span-2 md:col-span-12"
        >
          <div className="flex flex-wrap items-center gap-2 px-4">
            <div className="relative w-full sm:w-72">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                aria-label="Search expenses by vendor, category or notes"
                placeholder="Search vendors or categories…"
                className="pl-8"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <Select value={chosen} onValueChange={setCategory}>
              <SelectTrigger className="w-44" aria-label="Category">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All categories</SelectItem>
                {categories.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={filter} onValueChange={(v) => setFilter(v as ExpenseFilter)}>
              <SelectTrigger className="w-44" aria-label="Status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="open">All except rejected</SelectItem>
                <SelectItem value="pending">Pending approval</SelectItem>
                <SelectItem value="approved">Approved</SelectItem>
                <SelectItem value="paid">Paid</SelectItem>
                <SelectItem value="rejected">Rejected</SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              disabled={matching.length === 0}
              onClick={() => downloadCsv(csvFileName('expenses', localIsoDate(new Date())), expensesCsv(matching))}
            >
              <Download className="size-4" />
              Export
            </Button>
          </div>
          <div className="mt-3 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40">
                  <TableHead>Date</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Vendor</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.length === 0 &&
                  (rows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                        No expenses yet.
                      </TableCell>
                    </TableRow>
                  ) : (
                    <NoMatchesRow colSpan={6} />
                  ))}
                {shown.map((e) => (
                  <TableRow key={e.id} className={cn(e.display_status === 'rejected' && 'opacity-60')}>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{displayDate(e.expense_date)}</TableCell>
                    <TableCell className="whitespace-nowrap font-medium">{e.category_name}</TableCell>
                    <TableCell className="whitespace-nowrap">{e.vendor_name}</TableCell>
                    <TableCell className="whitespace-nowrap text-right tabular-nums">{rm(e.amount)}</TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{expenseMethod(e)}</TableCell>
                    <TableCell>
                      <span className="flex items-center gap-2">
                        <LiveDot active={e.display_status === 'paid'} />
                        <span
                          className={cn(
                            'inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold',
                            STATUS_STYLES[e.display_status],
                          )}
                        >
                          {EXPENSE_STATUS_LABELS[e.display_status]}
                        </span>
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="border-t px-4 py-3 text-sm text-muted-foreground">
            Showing {shown.length} of {matching.length} expenses
            {matching.length !== rows.length ? ` (${rows.length} in all)` : ''}
          </div>
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}
```

- [ ] **Step 6: Replace the three screens with server loaders**

Each reads every row for everyone who can see the workspace. Nothing is read only for writers, because nobody writes here yet.

Replace the whole of `src/screens/finance/cash-receipts.tsx` with:

```tsx
import { CashReceiptsView } from '@/components/finance/cash-receipts-view';
import { getViewer, hasSupabaseEnv } from '@/lib/auth/viewer';
import { listCashReceipts } from '@/lib/finance/cash-book';
import { todayUtc } from '@/lib/finance/view-helpers';
import { createClient } from '@/lib/supabase/server';
import { SAMPLE_CASH_RECEIPTS } from './cash-book-sample';
import { SAMPLE_TODAY } from './sales-sample';

/** Every movement of money in. Read-only for everyone until the receipt form arrives. */
export default async function CashReceiptsScreen() {
  if (!hasSupabaseEnv()) {
    return <CashReceiptsView rows={SAMPLE_CASH_RECEIPTS} today={SAMPLE_TODAY} />;
  }
  const viewer = await getViewer();
  const ctx = { client: await createClient(), orgId: viewer.orgId };
  const rows = await listCashReceipts(ctx);
  return <CashReceiptsView rows={rows} today={todayUtc()} />;
}
```

Replace the whole of `src/screens/finance/payment-vouchers.tsx` with:

```tsx
import { PaymentVouchersView } from '@/components/finance/payment-vouchers-view';
import { getViewer, hasSupabaseEnv } from '@/lib/auth/viewer';
import { listPaymentVouchers } from '@/lib/finance/cash-book';
import { todayUtc } from '@/lib/finance/view-helpers';
import { createClient } from '@/lib/supabase/server';
import { SAMPLE_PAYMENT_VOUCHERS } from './cash-book-sample';
import { SAMPLE_TODAY } from './sales-sample';

/** Every movement of money out. Read-only for everyone until the voucher form and approval arrive. */
export default async function PaymentVouchersScreen() {
  if (!hasSupabaseEnv()) {
    return <PaymentVouchersView rows={SAMPLE_PAYMENT_VOUCHERS} today={SAMPLE_TODAY} />;
  }
  const viewer = await getViewer();
  const ctx = { client: await createClient(), orgId: viewer.orgId };
  const rows = await listPaymentVouchers(ctx);
  return <PaymentVouchersView rows={rows} today={todayUtc()} />;
}
```

Replace the whole of `src/screens/finance/expenses.tsx` with:

```tsx
import { ExpensesView } from '@/components/finance/expenses-view';
import { getViewer, hasSupabaseEnv } from '@/lib/auth/viewer';
import { expensesView } from '@/lib/finance/cash-book-views';
import { listExpenses } from '@/lib/finance/expenses';
import { todayUtc } from '@/lib/finance/view-helpers';
import { createClient } from '@/lib/supabase/server';
import { SAMPLE_EXPENSES } from './cash-book-sample';
import { SAMPLE_TODAY } from './sales-sample';

/** Every expense. Read-only for everyone until the expense form and approval arrive. */
export default async function ExpensesScreen() {
  if (!hasSupabaseEnv()) {
    return <ExpensesView rows={SAMPLE_EXPENSES} view={expensesView(SAMPLE_EXPENSES, SAMPLE_TODAY)} />;
  }
  const viewer = await getViewer();
  const ctx = { client: await createClient(), orgId: viewer.orgId };
  const rows = await listExpenses(ctx);
  return <ExpensesView rows={rows} view={expensesView(rows, todayUtc())} />;
}
```

- [ ] **Step 7: Mark the screens live, and refresh them when what they show changes**

In `src/config/live-screens.ts`, replace:

```ts
  'finance/supplier-bills',
  'finance/payments-out',
]);
```

with:

```ts
  'finance/supplier-bills',
  'finance/payments-out',
  'finance/cash-receipts',
  'finance/payment-vouchers',
  'finance/expenses',
]);
```

In `src/app/(app)/finance/actions.ts`, replace:

```ts
// A contact's name shows on every purchase and sales screen too.
const CONTACT_PATHS = [
  '/finance/customers-suppliers',
  '/finance/supplier-bills',
  '/finance/payments-out',
  '/finance/invoices',
  '/finance/payments-in',
  '/finance/quotations',
  '/finance/credit-notes',
  '/finance/refunds',
];
const PRODUCT_PATHS = ['/finance/products'];
// A bill or a payment changes what is owed, which Customers & Suppliers shows as Payable.
const PURCHASE_PATHS = ['/finance/supplier-bills', '/finance/payments-out', '/finance/customers-suppliers'];
```

with:

```ts
// A contact's name shows on every purchase and sales screen too, and on the cash book: the payer on a
// receipt, the payee on a voucher and the vendor on an expense.
const CONTACT_PATHS = [
  '/finance/customers-suppliers',
  '/finance/supplier-bills',
  '/finance/payments-out',
  '/finance/invoices',
  '/finance/payments-in',
  '/finance/quotations',
  '/finance/credit-notes',
  '/finance/refunds',
  '/finance/cash-receipts',
  '/finance/payment-vouchers',
  '/finance/expenses',
];
const PRODUCT_PATHS = ['/finance/products'];
// A bill or a payment changes what is owed, which Customers & Suppliers shows as Payable. A payment to a
// supplier is also a voucher: Payment Vouchers lists every movement of money out.
const PURCHASE_PATHS = [
  '/finance/supplier-bills',
  '/finance/payments-out',
  '/finance/customers-suppliers',
  '/finance/payment-vouchers',
];
```

In `src/app/(app)/finance/actions.ts`, replace:

```ts
const SALES_PATHS = [
  '/finance/invoices',
  '/finance/payments-in',
  '/finance/customers-suppliers',
  '/finance/quotations',
  '/finance/credit-notes',
  '/finance/refunds',
];
```

with:

```ts
const SALES_PATHS = [
  '/finance/invoices',
  '/finance/payments-in',
  '/finance/customers-suppliers',
  '/finance/quotations',
  '/finance/credit-notes',
  '/finance/refunds',
  // A payment in is a receipt: Cash Receipts lists every movement of money in.
  '/finance/cash-receipts',
];
```

In `src/app/(app)/finance/actions.ts`, replace:

```ts
const CREDIT_PATHS = [
  '/finance/invoices',
  '/finance/payments-in',
  '/finance/customers-suppliers',
  '/finance/credit-notes',
  '/finance/refunds',
];
```

with:

```ts
const CREDIT_PATHS = [
  '/finance/invoices',
  '/finance/payments-in',
  '/finance/customers-suppliers',
  '/finance/credit-notes',
  '/finance/refunds',
  // A refund is a voucher: Payment Vouchers lists every movement of money out. (Payments Out still never shows one.)
  '/finance/payment-vouchers',
];
```

- [ ] **Step 8: Run the tests**

Run: `pnpm exec vitest run tests/live-screens.test.ts tests/finance-contact-paths.test.ts tests/finance-sales-actions.test.ts tests/finance-actions.test.ts tests/finance-credit-refund-actions.test.ts tests/finance-quotation-actions.test.ts tests/screen-routes.test.ts`
Expected: PASS, all seven files.

- [ ] **Step 9: Check the routes, type-check, lint and build**

Run: `pnpm gen:routes --check`
Expected: exit 0, nothing out of date. (The three route files already import these screens' default exports.)

Run, as separate commands: `pnpm exec tsc --noEmit`, `pnpm lint`
Expected: no type errors; lint reports the one warning it had before this branch and nothing new.

Run: `NEXT_PUBLIC_SUPABASE_URL= NEXT_PUBLIC_SUPABASE_ANON_KEY= SUPABASE_SERVICE_ROLE_KEY= pnpm build`
Expected: the build completes and lists `/finance/cash-receipts`, `/finance/payment-vouchers` and `/finance/expenses`. The build is what catches a server-only import reaching a client component. With the three variables emptied on the command's own line it cannot reach a database, whatever the shell has set.

Run: `grep -n "use client\|writer\|Action\|Sparkline\|icon={Receipt}\|icon={TrendingDown}\|icon={Landmark}" src/screens/finance/cash-receipts.tsx src/screens/finance/payment-vouchers.tsx src/screens/finance/expenses.tsx src/components/finance/cash-receipts-view.tsx src/components/finance/payment-vouchers-view.tsx src/components/finance/expenses-view.tsx`
Expected: exactly three lines, the `'use client';` at the top of each view. No `writer`, no action, none of the mock-ups' sparklines, and no `BentoCard` icon outside the seven it is known to draw.

- [ ] **Step 10: Commit**

```bash
git add src/components/finance/cash-receipts-view.tsx src/components/finance/payment-vouchers-view.tsx src/components/finance/expenses-view.tsx src/screens/finance/cash-receipts.tsx src/screens/finance/payment-vouchers.tsx src/screens/finance/expenses.tsx src/config/live-screens.ts "src/app/(app)/finance/actions.ts" tests/live-screens.test.ts tests/finance-contact-paths.test.ts tests/finance-sales-actions.test.ts tests/finance-actions.test.ts tests/finance-credit-refund-actions.test.ts tests/finance-quotation-actions.test.ts
git commit -m "feat: Cash Receipts, Payment Vouchers and Expenses read the workspace's own data, read-only"
```

No browser check and no dev server: the controller checks the screens on production after the merge. This task runs no database test.

---

### Task 6: Document and verify the branch

**Files:**
- Modify: `docs/bendahara-backend.md`

**Interfaces:**
- Consumes: everything Tasks 1 to 5 made. Produces no code.

Every replacement below names text that is in `docs/bendahara-backend.md` on `main` today. Another change in flight edits that file (the Quotations section, the `finance_convert_quotation` row and the "Make invoice" known limits). None of the anchors here is in those places, but if one is no longer found after a rebase, read the section and make the same addition by hand: what matters is what the note says afterwards, which each step states.

- [ ] **Step 1: The table of pure files**

In `docs/bendahara-backend.md`, replace:

```markdown
| `csv.ts` | CSV text for Export: RFC 4180, a UTF-8 byte-order mark, and a guard against spreadsheet formulas |
```

with:

```markdown
| `cash-book-views.ts` | KPI figures, chart data, table filters, status words and CSV rows for Cash Receipts, Payment Vouchers and Expenses; the period selector of the first two (`inPeriod`); which category a voucher counts under (`voucherCategory`) and which screen changes it (`voucherHome`) |
| `csv.ts` | CSV text for Export: RFC 4180, a UTF-8 byte-order mark, and a guard against spreadsheet formulas |
```

- [ ] **Step 2: Which screens an action refreshes**

In `docs/bendahara-backend.md`, replace:

```markdown
each can move what an invoice owes; never Payments Out, which shows no refund,
and not Quotations.
```

with:

```markdown
each can move what an invoice owes; never Payments Out, which shows no refund,
and not Quotations.

The cash book lists every movement of money, so the actions that record one
refresh it as well: an invoice or a payment in also refreshes Cash Receipts; a
bill or a payment out, and a credit note issued or voided or a refund at any
step, also refresh Payment Vouchers; a contact also refreshes Cash Receipts,
Payment Vouchers and Expenses, where it can be the payer, the payee or the
vendor. Cash Receipts, Payment Vouchers and Expenses have no action of their
own yet: they are read-only for everyone.
```

- [ ] **Step 3: The tables**

In `docs/bendahara-backend.md`, replace:

```markdown
| `finance_allocations` | How a movement is split across the documents it pays. Each row names exactly one document: a bill (`bill_id`), an invoice (`invoice_id`) or a credit note (`credit_note_id`). `reason` is what a refund is for. |
```

with:

```markdown
| `finance_allocations` | How a movement is split across the documents it pays. Each row names exactly one document: a bill (`bill_id`), an invoice (`invoice_id`), a credit note (`credit_note_id`) or an expense (`expense_id`). `reason` is what a refund is for. One payment pays one kind of document: bills, or invoices and credit notes, or expenses. |
| `finance_expenses` | An expense: a date, a category, a vendor who is a contact (`vendor_id`) or a typed name (`vendor_name`), never both, and `amount`, which has its SST inside it (`sst_amount` is that part). `status` is `pending`, `approved` or `rejected`; `approved_by` and `approved_at` say who decided and when, whichever way. It has no number. |
```

- [ ] **Step 4: Document numbers**

In `docs/bendahara-backend.md`, replace:

```markdown
it is paid out, from the same counter as a payment to a supplier.
```

with:

```markdown
it is paid out, from the same counter as a payment to a supplier. A payment
voucher of any other kind takes its `PV-` number from that counter too, when
it is paid, and a cash receipt its `RC-` number when it is posted, from the
counter payments in use. An expense has no number.
```

- [ ] **Step 5: Money, the cash book, expenses and approval**

In `docs/bendahara-backend.md`, replace:

```markdown
Statuses of a transaction: `draft` (being written by a database function),
`scheduled` (not yet money out), `posted` (paid or received; numbered
`PV-0001` for money out and `RC-0001` for money in), `void`.
`pending_approval` and `rejected` exist for the approval rule that arrives
with Payment Vouchers and Expenses; nothing sets them yet.
```

with:

```markdown
Statuses of a transaction: `draft` (being written by a database function, or
a cash receipt not yet posted), `pending_approval` (money out waiting for an
owner or admin), `scheduled` (allowed to be paid, not yet money out), `posted`
(paid or received; numbered `PV-0001` for money out and `RC-0001` for money
in), `rejected` (refused by an owner or admin; final), `void`. A payment is
always created as a draft: a direct INSERT with any other status is refused
(`FIN09`).

Who paid or was paid is a contact (`contact_id`) or a typed name
(`party_name`), never both; nobody need be named. `category_id` is for money
that settles no document: an income category on money in, an expense category
on money out.

## The cash book

Cash Receipts and Payment Vouchers list every movement of money, one row
each, whatever it is for. The views are `finance_cash_receipts` (direction
`in`) and `finance_payment_vouchers` (direction `out`); each row is one
`finance_transactions` row, keyed by `transaction_id`, with the account, who
paid or was paid (`party_name`: the contact's name or the typed one), the
category and `documents`, the numbers of what it pays. The two sides of a
transfer between accounts (`transfer_id`) are in neither.

`kind` says what a row is, and therefore which screen changes it:

| View | `kind` | What it is | Also shown on | Changed on |
|---|---|---|---|---|
| `finance_cash_receipts` | `invoice` | Money in against invoices | Payments In, one row per invoice | Payments In |
| `finance_cash_receipts` | `income` | Money in that settles no invoice, with an income category | nowhere else | Cash Receipts (no form yet) |
| `finance_payment_vouchers` | `bill` | A payment to a supplier | Payments Out, one row per bill | Payments Out |
| `finance_payment_vouchers` | `refund` | Money back to a customer | Refunds | Refunds |
| `finance_payment_vouchers` | `expense` | A payment of approved expenses | Expenses, as Paid | Payment Vouchers, Expenses (no form yet) |
| `finance_payment_vouchers` | `other` | Money out that settles no document, with an expense category | nowhere else | Payment Vouchers (no form yet) |

Nothing is counted twice. Payments In, Payments Out and Refunds are views of
allocations joined to their documents, so each shows only its own kind, one
row per document. The cash book views are views of the transactions, so each
shows every kind once. No screen adds one of these up with another. A payment
across two bills is two rows on Payments Out whose amounts come to the one
row's amount on Payment Vouchers.

`voidPaymentIn`, which Payments In calls, reads `finance_payments_in` first
and refuses anything it does not show, so a receipt of kind `income` cannot
be voided through it; `markPaymentPaid`, `voidPayment` and
`deleteScheduledPayment` read `finance_payments_out`, and the refund writes
`finance_refunds`, as before. A voucher of kind `expense` or `other` is in
none of those three views and is reached through none of those functions.

A cash receipt can wait as a draft. `finance_save_cash_receipt` creates one or
replaces a draft's details and split; `finance_post_cash_receipt` gives it its
`RC-` number. It is for one customer's posted invoices, in which case its
amount is the sum of its split and the customer is the payer, or for an
income category, with an amount of its own. While it is a draft, what it is
split across is held: the guard on allocations counts a draft against each
invoice, so nobody else can receive that part. Money in needs nobody's
approval. A payment recorded on Payments In is still
`finance_record_payment_in`, posted at once.

`finance_record_voucher` records money out that pays approved expenses, or
money out that settles no document and carries an expense category. A payment
to a supplier and a refund are not recorded through it.

## Expenses

An expense is one `finance_expenses` row. It is created pending. While it is
pending anyone who may write can edit or delete it. An owner or admin
approves or rejects it: a change of status and nothing else, and the database
writes down who and when. Saved by an owner or admin
(`finance_save_expense`), it is approved in the same call. An approved
expense is locked; an owner or admin can still reject it while no payment
stands against it. A rejected expense can be deleted, or edited, which puts
it back to pending.

The view `finance_expense_totals` adds the category's and the vendor's name,
`paid` (posted money out allocated to the expense), `held` (what payments not
yet posted hold of it), `method` and `paid_on` (of the latest posted payment)
and `display_status`: `pending`, `rejected`, `approved`, or `paid` once
`paid` covers `amount`. Paid is never stored.

Money out pays an approved expense, and everything standing against it never
exceeds its amount; the expense row is locked while that is checked. Paying
an approved expense needs no second approval: the expense was the approval.

## Approval

Decided by the owner: owners and admins approve expenses and payment
vouchers. In the database that is `private.is_org_admin`, asked by the guards
themselves, so no caller gets round it.

- An expense is approved or rejected by an owner or admin only (`FIN14`).
- A payment that is `pending_approval` cannot be changed, and neither can its
  split. An owner or admin approves it, which makes it `scheduled`, or
  rejects it; nothing else changes in that update, and the guard writes
  `approved_by` and `approved_at`. Anyone who may write can delete it.
- A rejected payment is final: it can be deleted, and nothing else.
- Money out that settles no document, which is the part of a payment out
  above its split, needs an owner or admin when the payment becomes scheduled
  or posted, unless one of them approved it already. Recorded by an owner or
  admin it is approved in that step.
  Recorded by anyone else through `finance_record_voucher` it waits as
  `pending_approval`, whatever was asked.
- A scheduled payment that was approved is paid as it was approved: only its
  status, number and date change when it is marked paid, by anyone who may
  write, and its split is locked.

**What approval does not reach yet.** A payment to a supplier recorded on
Payments Out and a refund recorded on Refunds are exactly their split, so the
rule above does not touch them: `finance_record_payment_out` and
`finance_record_refund` are unchanged, and an editor's payment or refund is
posted or scheduled at once, as before. Whether those two should wait for
approval too is the owner's decision; it changes two live screens and has its
own part of stage 5.

A session with no signed-in user is not asked for a role
(`private.finance_may_decide`). That is a migration or the SQL editor, which
could disable the guards anyway, and it is how the demo seed approves its
rows, with `approved_by` left empty. Neither API role can be in that state
and still write: `authenticated` always carries a user, and `anon` and
`service_role` have no rights on these tables.
```

- [ ] **Step 6: The locking rules**

In `docs/bendahara-backend.md`, replace:

```markdown
- Each guard steps aside when the workspace itself is being deleted.
```

with:

```markdown
- An expense is created pending. It is edited and deleted while pending, and
  deleted or edited back to pending once rejected; approved, it is locked, and
  can only be rejected, by an owner or admin, while no payment that is
  posted, scheduled, waiting or in progress is allocated to it (`FIN02`).
  Nothing else changes in the update that approves or rejects it.
- A payment only goes against an approved expense (`FIN04`), only money out
  does, and never for more than is left of it, counting payments that are
  posted, scheduled, waiting or in progress (`FIN05`). The expense row is
  locked while this is checked, so two payments at the same moment are
  checked one after the other, and it cannot be rejected in between.
- One payment pays one kind of document (`FIN06`): a second allocation that
  names another kind than the payment's first is refused.
- A payment starts as a draft (`FIN09`), and the approval rules above hold
  whichever way a status is changed.
- Clearing a deleted user from the `created_by` or `approved_by` of an
  expense is allowed whatever its status.
- Each guard steps aside when the workspace itself is being deleted.
```

- [ ] **Step 7: The database functions**

In `docs/bendahara-backend.md`, replace:

```markdown
| `finance_mark_payment_paid(target_org, target_txn, paid_on)` | Scheduled to paid. Returns the number. |
```

with:

```markdown
| `finance_mark_payment_paid(target_org, target_txn, paid_on)` | Scheduled money out to paid. Returns the number. Refuses money in (`FIN09`). |
```

In `docs/bendahara-backend.md`, replace:

```markdown
| `finance_next_number(target_org, doc)` | The next document number. |
```

with:

```markdown
| `finance_save_cash_receipt(target_org, receipt, allocations)` | Creates a draft cash receipt or replaces a draft's details and split. `receipt` has `id` (to change a draft), `account_id`, `txn_date`, `method`, `reference`, `notes`, and either nothing more, with `allocations` a list of `{ invoice_id, amount }` for one customer's posted invoices, or `category_id` (an income category), `amount`, and `contact_id` or `party_name`, with no allocations. Returns the id. |
| `finance_post_cash_receipt(target_org, target_txn)` | Posts a draft cash receipt and returns its `RC-` number. |
| `finance_record_voucher(target_org, voucher, allocations)` | Records money out for approved expenses or for an expense category. `voucher` has `account_id`, `txn_date`, `method`, `reference`, `notes`, `contact_id` or `party_name`, `status` (`posted`, the default, or `scheduled`), and either nothing more, with `allocations` a list of `{ expense_id, amount }`, or `category_id` and `amount`, with no allocations. A voucher with no allocations recorded by someone who is not an owner or admin is left `pending_approval`. Returns the id. |
| `finance_save_expense(target_org, expense)` | Creates an expense or changes one that is pending or rejected. `expense` has `id` (to change one), `expense_date`, `category_id`, `vendor_id` or `vendor_name`, `amount`, `sst_amount`, `notes`. Saved by an owner or admin it is approved in the same call. Returns the id. |
| `finance_next_number(target_org, doc)` | The next document number. |
```

In `docs/bendahara-backend.md`, replace:

```markdown
Voiding a bill, an invoice or a payment, and deleting a draft bill, a draft
invoice or a scheduled payment, are plain updates and deletes; the guards
decide whether they are allowed.
```

with:

```markdown
Approving or rejecting an expense or a payment, voiding a posted receipt or
voucher, and deleting a draft receipt, a pending or rejected expense, or a
payment that was never paid, are plain updates and deletes as well. No
function of `src/lib/finance/` calls the four functions above or makes those
writes yet: `cash-book.ts` and `expenses.ts` only read, and each write
arrives with its form.

Voiding a bill, an invoice or a payment, and deleting a draft bill, a draft
invoice or a scheduled payment, are plain updates and deletes; the guards
decide whether they are allowed.
```

- [ ] **Step 8: The error codes**

In `docs/bendahara-backend.md`, replace:

```markdown
| `FIN13` | The quotation already has an invoice that is not void: it cannot be converted again, and its answer can no longer change. `quotations.ts` words it |
```

with:

```markdown
| `FIN13` | The quotation already has an invoice that is not void: it cannot be converted again, and its answer can no longer change. `quotations.ts` words it |
| `FIN14` | Approval. Only an owner or admin approves or rejects an expense or a payment; money out that settles no document needs one of them before it is scheduled or paid; a payment waiting for approval, or rejected, cannot be changed; a rejected payment is final; an approved payment is paid as it was approved. Nothing in the app meets it yet |
| `FIN15` | A receipt, a voucher or an expense names the wrong thing: a receipt is for invoices or for an income category, a voucher for expenses or for an expense category, never both and never neither; an expense needs an expense category of its own workspace. Nothing in the app meets it yet |
```

In `docs/bendahara-backend.md`, replace:

```markdown
## Known limits

- A scheduled payment cannot be edited: delete it and schedule it again.
```

with:

```markdown
The cash book reuses the codes above where the meaning is the same. `FIN01`:
an expense is created pending, an approved or rejected one is locked, it is
decided as it stands, and an approved one is not deleted. `FIN02`: an
approved expense with payments cannot be rejected. `FIN04`: a payment only
goes against an approved expense, and only money out does. `FIN05`: more than
is left of the expense, or a draft receipt for more than its invoice owes.
`FIN06`: a voucher names an expense that is not there, a receipt is for two
customers, or one payment names two kinds of document. `FIN09`: a payment is
created as a draft; a posted receipt cannot be saved or posted again; the
split of a payment that is waiting, rejected or approved is locked; money in
is not marked paid. `FIN11`: the receipt or the expense no longer exists, or
is not the caller's to change. `22023`: `finance_record_voucher` was given a
status other than `posted` or `scheduled`. `23514`: an expense with both a
contact and a typed vendor or neither, with more SST than its amount, or of
nothing; a payment with both a contact and a typed name. `23503`: an expense
that a voided payment still names cannot be deleted. None of these has a
sentence yet: the files that word them arrive with the forms.

## Known limits

- A scheduled payment cannot be edited: delete it and schedule it again.
```

- [ ] **Step 9: Known limits that this stage closes or changes**

In `docs/bendahara-backend.md`, replace:

```markdown
- Approval of money out is not enforced yet.
- Posting goes through database functions that run as the caller. An editor
  writing to the tables directly, rather than through the app, could still post
  a bill, an invoice or a payment with a number of their own choosing, or change
  the account of a scheduled payment, or raise its amount above its split, after
  it has been split across bills or invoices. (Lowering the amount below the
  split, or changing the direction, is refused.)
  Numbers stay unique per workspace either way. Closing this needs posting
  functions that run with their own rights, planned with the approval rule.
```

with:

```markdown
- Approval is enforced for expenses and for money out that settles no
  document. A payment to a supplier and a refund are not held for approval;
  see Approval.
- Posting goes through database functions that run as the caller. An editor
  writing to the tables directly, rather than through the app, could still post
  a bill, an invoice, or a payment that is exactly its split, with a number of
  their own choosing, or change the account of a scheduled payment that nobody
  had to approve. (Lowering the amount below the split, or changing the
  direction, is refused. Raising the amount above the split is allowed while
  the payment is a draft or scheduled, but an editor cannot then schedule it
  or pay it: the part above the split needs an owner or admin.) A payment can
  no longer be created already posted. Numbers stay unique per workspace
  either way. Closing the rest needs posting functions that run with their
  own rights.
```

In `docs/bendahara-backend.md`, replace:

```markdown
- Money in is never scheduled, but `finance_mark_payment_paid` does not check
  the direction: a scheduled movement of money in could only come from writing
  to the table directly, and marking it paid would give it a `PV-` number. For
  money out the function is used as it is, for a pending refund as much as for
  a scheduled payment to a supplier: both are payment vouchers. The refund
  functions do not rely on the missing check: `markRefundPaid`, `voidRefund`
  and `deleteRefund` read `finance_refunds` first and refuse anything it does
  not show, so a payment to a supplier is never marked paid, voided or deleted
  through them. The Payments Out functions read `finance_payments_out` first
  in the same way, so a refund is never reached through them. Each is two
  requests, a read and then a write, not one statement: a transaction that
  stopped being a payment to a supplier between the two would still be
  written, and nothing in the app can make one do that.
```

with:

```markdown
- `finance_mark_payment_paid` refuses money in. It is used as it is for every
  kind of money out: a pending refund, a scheduled payment to a supplier and
  an approved voucher are all payment vouchers. The functions of each screen
  do not rely on that: `markRefundPaid`, `voidRefund` and `deleteRefund` read
  `finance_refunds` first and refuse anything it does not show, the Payments
  Out functions read `finance_payments_out` first in the same way, and
  `voidPaymentIn` reads `finance_payments_in`. Each is two requests, a read
  and then a write, not one statement: a transaction that stopped being what
  the view showed between the two would still be written. One payment pays
  one kind of document, so nothing can make one do that.
```

In `docs/bendahara-backend.md`, replace:

```markdown
- `voidPaymentIn` is kept to `direction = 'in'` and reads no view first: every
  movement of money in is a payment in. When cash receipts arrive (stage 5),
  money in gains a second kind and this must be looked at again.
```

with:

```markdown
- A draft cash receipt against invoices is on Payments In with the status
  Draft, and holds its part of each invoice until it is posted or deleted.
  Nothing in the app makes one yet. Payments In offers nothing on such a row;
  sent to `voidPaymentIn` by a direct call it is answered "This payment has
  already been voided.", which is not true of a draft. The part that adds the
  receipt form rewords it.
```

In `docs/bendahara-backend.md`, replace:

```markdown
- A payment that was rejected can still be posted by a direct update; nothing
  in the app sets or leaves `rejected`. For a refund, that update is checked in
  full as above. For a payment to a supplier or a payment in, it is not looked
  at again.
- A rejected refund moved straight to `scheduled` (or back to `draft`) by a
  direct update is not looked at again until it is paid out. Until then the
  refunds waiting on an invoice can add up to more than the credit; none of
  them can be paid out past it.
```

with:

```markdown
- A rejected payment is final: no update moves it to another status, so one
  that held nothing while another payment took its place cannot be brought
  back on top of that one. A rejected refund that is paid out by a direct
  update is still refused by the refund checks first (`FIN04`, `FIN05`), then
  by this rule (`FIN14`).
```

- [ ] **Step 10: Known limits that are new**

In `docs/bendahara-backend.md`, replace:

```markdown
  Payable card is totalled from every open bill, not only the contacts loaded.
  Receivable is the same for invoices that are sent or overdue.
```

with:

```markdown
  Payable card is totalled from every open bill, not only the contacts loaded.
  Receivable is the same for invoices that are sent or overdue.
- Cash Receipts, Payment Vouchers and Expenses are read-only. A receipt for
  income, a voucher that is not a supplier payment or a refund, and an
  expense exist only in the demo workspace until their forms are built; the
  database functions for them are there and nothing calls them.
- A payment to a supplier or a refund recorded by someone who is not an owner
  or admin is not held for approval. The owner decides whether it should be.
- A voucher that settles no document, recorded by someone who is not an owner
  or admin, waits for approval even when it was asked to be paid now. Once
  approved it is scheduled, and is then marked paid with its date.
- A payment waiting for approval cannot be edited or withdrawn: delete it and
  record it again. A rejected one cannot be reopened: delete it.
- An expense's amount has its SST inside it, where a bill line has its SST on
  top. An expense has one category and no lines.
- An approved expense cannot be edited. An owner or admin rejects it, while
  nothing has been paid against it, and it is then edited back to pending.
- An expense that a voided payment still names cannot be deleted: the voided
  payment keeps its split as a record.
- An expense can be paid in parts; it reads Approved until posted money out
  covers it. One voucher can pay several expenses, and they need not share a
  vendor: who is paid is what the voucher says.
- A cash receipt for income and a voucher that settles no document need not
  name who paid or was paid.
- A draft cash receipt is not looked at again when it is posted. If its
  invoice was credited in the meantime, which a credit note's cap allows
  whatever a draft holds, posting it leaves the customer in credit by the
  overlap, as paying first and crediting afterwards does. A refund pays that
  out.
- Whether a receipt names invoices or a category, and whether a category is
  an income or an expense one, is checked by the database functions, not by
  the guards. A direct write to the tables can give money out an income
  category, or post a receipt that is partly split and partly not. The guards
  enforce what protects money and approval; the shape of a document is the
  functions' business.
- "This year" on Cash Receipts and Payment Vouchers is the calendar year:
  there is no financial-year setting.
- Cash Receipts, Payment Vouchers and Expenses load every row and filter in
  the browser, as the other finance screens do. A chart names its four
  largest slices and adds the rest up as one.
- On Payment Vouchers the Kind of a supplier payment or a refund links to the
  screen that changes it; the link does not single the row out there.
- The sample shown with no database has its own four supplier payments on
  Payment Vouchers; they are not the rows of the Payments Out sample.
- The demo workspace's cash book was dated from the day it was seeded, so its
  month-to-date figures empty out as time passes. Its seeded approvals name
  nobody: `approved_by` is empty on them.
- The database tests for this stage, `tests/bendahara-cash-book.test.ts`, run
  against the hosted database as owners only. What an editor and a viewer may
  not do is proved by `supabase/tests/bendahara_cash_book_check.sql`.
```

- [ ] **Step 11: Review the note against the SQL**

Run: `grep -o "errcode = '[A-Z0-9]*'" supabase/migrations/20261028100000_bendahara_cash_book.sql | sort | uniq -c`
Expected: `22023` 1, `FIN01` 7, `FIN02` 1, `FIN03` 2, `FIN04` 12, `FIN05` 7, `FIN06` 3, `FIN09` 12, `FIN11` 4, `FIN14` 16, `FIN15` 7. Every `FIN` code there is in the note, and the note's rows for `FIN14` and `FIN15` exist.

Run: `grep -n "^create or replace function public" supabase/migrations/20261028100000_bendahara_cash_book.sql`
Expected: five lines, with the argument names `target_org, target_txn, paid_on`; `target_org, receipt, allocations`; `target_org, target_txn`; `target_org, voucher, allocations`; `target_org, expense`. The note's function table uses the same names.

Run: `grep -c "FIN14\|FIN15" src/lib/finance/*.ts`
Expected: every file reports `0`. No sentence words either code yet, because nothing in the app can meet them; the forms parts add them.

- [ ] **Step 12: Run everything**

Run, as separate commands: `pnpm exec tsc --noEmit`, `pnpm lint`, `pnpm exec vitest run --exclude 'tests/*.rls.test.ts' --exclude 'tests/bendahara-*.test.ts'`, and `NEXT_PUBLIC_SUPABASE_URL= NEXT_PUBLIC_SUPABASE_ANON_KEY= SUPABASE_SERVICE_ROLE_KEY= pnpm build`.
Expected: no type errors; lint reports the one warning it had before this branch and nothing new; every unit test file passes (two files report skipped tests, as they did before this branch); the build completes.

Do not run `pnpm test`, and do not run `tests/bendahara-cash-book.test.ts`: those reach the hosted production database. The controller runs the database tests (Task 1, steps 13 and 14).

- [ ] **Step 13: Check for banned colours, names and server-only imports**

Run: `git diff origin/main...HEAD -- src | grep -n -i -E "^\+.*(purple|violet|fuchsia|indigo|kuasa\.ai)"`
Expected: no output.

Run: `grep -n -E "supabase/server|next/headers|server-only" src/lib/finance/*.ts src/screens/finance/cash-book-sample.ts src/components/finance/cash-receipts-view.tsx src/components/finance/payment-vouchers-view.tsx src/components/finance/expenses-view.tsx`
Expected: no output.

Run: `git diff origin/main...HEAD --stat -- src/lib/finance/refunds.ts src/lib/finance/bills.ts src/lib/finance/invoices.ts src/lib/finance/sales-views.ts src/lib/finance/purchase-views.ts src/screens/finance/sales-sample.ts src/components/finance/payments-view.tsx src/components/finance/payments-in-view.tsx src/components/finance/refunds-view.tsx supabase/tests/bendahara_followons_check.sql supabase/tests/bendahara_invoices_check.sql`
Expected: no output. None of those files is changed by this branch.

- [ ] **Step 14: Commit**

```bash
git add docs/bendahara-backend.md
git commit -m "docs: describe the cash book, expenses, approval, their guards, functions and error codes"
```

- [ ] **Step 15: Hand back**

Do not push. Report what was built, the result of the four commands in Step 12, and anything that had to differ from this plan.


---

## After the hand-back: the controller's steps and production smoke list

In this order.

1. Confirm Task 1 steps 10 to 14 are done: the schema migration and the seed are applied, the three check scripts pass on the applied schema, the function bodies match, and all five database test files are green. **The code must not be deployed before the schema migration is applied.**
2. On the owner's word: `git fetch`, rebase onto `origin/main`, and re-run `pnpm exec tsc --noEmit`, `pnpm lint` and the unit tests. Two files this branch edits are also edited by the change that gives `finance_convert_quotation` a date: `tests/finance-quotation-actions.test.ts` (one constant here) and `docs/bendahara-backend.md` (sections here that the other change does not touch). Resolve by keeping both. If `main` gained a migration stamped `20261028` or later, the two files here are already applied under their own names: do not rename them.
3. Push, open the PR titled with the branch's name (no close keyword unless `gh issue list` shows a tracking issue for this stage), squash-merge after review.
4. After the deploy, on production with the smoke account (`smoke@openkuasa-test.dev`). Wait for each page to finish loading before reading it.
   - `/finance/cash-receipts`, `/finance/payment-vouchers`, `/finance/expenses` in the smoke workspace: no work-in-progress banner; no button that writes and no row menu; the period selector reads "This month" and changes the four cards and the donut when changed; the last table row clear of the assistant button.
   - `/finance/expenses` in the smoke workspace, which has no expense: four cards of RM 0 or "—"; "No expenses in the last 8 months.", "Nothing approved this year.", "No expenses yet."; Export greyed out.
   - On `/finance/payments-in` record a payment against an open invoice. `/finance/cash-receipts` then shows it as one row: its `RC-` number, the customer, the invoice's number under For, Posted; Received and Receipts have moved. Void it on Payments In: on Cash Receipts it is gone from "All except void" and is under Void, struck through; the cards are back where they were.
   - On `/finance/payments-out` record a payment across two open bills of one supplier, if the smoke workspace has them (one bill otherwise). `/finance/payment-vouchers` shows it as one row: its `PV-` number, the supplier, Kind "Supplier payment" with both bill numbers, Category "Supplier bills", Paid. The Kind is a link and opens Payments Out, where the same payment is two rows. Void it there; on Payment Vouchers it is under Void.
   - If the smoke workspace has a customer in credit, record a refund on `/finance/refunds`: it is on Payment Vouchers with Kind "Refund", linking to Refunds, and not on Payments Out.
   - `/finance/invoices`, `/finance/payments-in`, `/finance/refunds`, `/finance/supplier-bills`, `/finance/payments-out`, `/finance/customers-suppliers`: the same figures as before the deploy.
   - Export downloads a CSV from Cash Receipts and Payment Vouchers; the amounts are numbers.
5. In the demo workspace (the seed is in already):
   - Expenses: 22 rows under "All except rejected", 23 in all; Pending approval RM 5,800 with 2 expenses; Total expenses (YTD) RM 87.9k with 20 approved expenses and Top category Salaries, 59% of spend, if every seeded date is in this calendar year (the oldest is 190 days before the seed); "Syarikat Guaman Lee" reads Approved with a dash under Method; "Unifi Business" reads Paid, Card; "AirAsia" is under Rejected only. The category filter lists seven categories.
   - Payment Vouchers: Pending approval RM 4,340 with 2 vouchers, in amber; "Tenaga Nasional Berhad" reads To be paid with a dash for its number; "Kedai Alat Tulis Maju" is under Rejected only; the Kind filter set to "Expense" shows 19 rows, to "Other payment" 5 (6 with the rejected one, under Rejected), to "Supplier payment" and "Refund" the demo's own payments, each linking to its screen; "By category" has a "Supplier bills" slice if a supplier was paid this month.
   - Cash Receipts: "Langkawi Fresh" is a Draft of RM 2,180.00 with a dash for its number and "Sales" under For; the status filter set to Draft shows that one row; the demo's 14 payments in are there with their invoice numbers under For; "By account" has Main Bank and Cash in hand.
   - Change the period to "This year" on both: Received and Paid grow, and the donuts follow.
   - Invoices, Payments In, Refunds, Supplier Bills, Payments Out, Customers & Suppliers: unchanged.
6. Tell the owner the five decisions that wait on them (1, 4, 5, 9 and 10), and that 5b to 5d can be planned once 1 is answered for the voucher form.

---

## Self-review notes

**Spec coverage, build-order item 5, first part.**

| Spec | Where |
|---|---|
| `finance_expenses`: `expense_date`, category, vendor (a contact or typed text), `amount`, `sst_amount`, notes, `status` (`pending`, `approved`, `rejected`), `approved_by`, `approved_at`, `created_by` | Task 1 (migration) |
| `finance_allocations`: exactly one of `invoice_id`, `bill_id`, `expense_id`, `credit_note_id` | Task 1: `expense_id` added, the check widened to four |
| `finance_transactions`: `contact_id` or `party_name`; `category_id` for money that settles no document; `pending_approval`, `rejected`, `approved_by`, `approved_at` | Task 1: the columns existed; this stage is the first to write them, and adds the check that a payment has a contact or a typed name, not both |
| `number`: RC- for money in, PV- for money out, given on posting | Task 1: `finance_post_cash_receipt`, `finance_record_voucher`, `finance_mark_payment_paid` |
| Cash Receipts = all transactions with direction `in`; Payment Vouchers = all with direction `out` | Task 1, the two views; Task 5 |
| Expense categories are a per-workspace list | Already there (`finance_categories`); the functions check the kind. Managing them is 5c |
| An expense is Paid when posted money out is allocated to it | Task 1, `finance_expense_totals.display_status`; partly paid stays Approved |
| A posted document cannot be updated or deleted; enforced by triggers | Task 1: unchanged for payments; an approved expense is locked by its guard |
| An allocation cannot exceed the transaction amount; only posted transactions change a balance | Unchanged; the expense view counts posted money only and shows what is held apart |
| Approval: created by an owner or admin, approved on saving; otherwise pending, and only an owner or admin approves or rejects; the check is in the database, using the caller's role | Task 1: the expense guard and the payment guard, `finance_save_expense`, `finance_record_voucher`. For expenses and for money out that settles no document; **not** for supplier payments and refunds (Decision 1) |
| Multi-row writes are one `security invoker` function each | Task 1: save receipt, record voucher; the single-row saves are functions too |
| Cash Receipts: New receipt (from whom, account, method, amount, invoices or an income category), edit draft, post, void | Database: Task 1. Screen: read-only here; the form is 5b |
| Payment Vouchers: New voucher (to whom, account, method, amount, bills or expenses or a category), submit, approve or reject, mark paid, void | Database: Task 1, for expenses and a category; bills stay with `finance_record_payment_out`. Screen: read-only here; the form is 5d |
| Expenses: New, edit, approve or reject, mark paid from an account, attach receipt, delete; Pending approval, Approved, Rejected, Paid | Database: Task 1. Screen: read-only with the four states; the forms are 5c; attach receipt is stage 7 |
| Categories managed from Expenses | 5c |
| Layout kept; period selectors work where the mock-up has one; search and filters in the browser; "View all"; Export as CSV | Tasks 4 and 5 |
| Viewers get no buttons; sample view with no actions when there is no database | Task 5: nobody gets any in this part |
| Each write is one function with a Zod schema; server actions | Not in this part (Decision 16): 5b, 5c, 5d |
| Screen added to `live-screens.ts` and its path to the revalidate list | Task 5 |
| Unit tests for every view builder and every schema | Tasks 2 and 4; no schema is added |
| Database tests: isolation and viewer-cannot-write on each new table; the locked rule; numbering under two simultaneous posts; the approval rule | Task 1: the check script (owner, editor, viewer, outsider) and `tests/bendahara-cash-book.test.ts` (isolation, locking, two at once) |
| Dry-run, apply before the code deploys, smoke-test | Task 1 steps 10 to 14; the controller's steps above |

**Handed over by earlier stages, and where each went.**

| Handed over | Where |
|---|---|
| "A refund is money out and will also appear on Payment Vouchers when that screen is built" (4a) | Task 1: `kind = refund` in `finance_payment_vouchers`; Task 5 links the row to Refunds |
| Payments to suppliers take `PV-` numbers too | Task 1: `kind = bill`; Task 5 links the row to Payments Out |
| What Cash Receipts lists beside Payments In | Decision 6; `kind = invoice` and `income` |
| "`voidPaymentIn` … when money in gains a second kind (stage 5)" | Task 3 |
| Payments Out and refund writes read their own view first; a new kind must not be reachable through the wrong screen | Decision 7 (one kind per payment); the table "Every movement of money"; Task 1's check, "a voucher shows on a screen that is not its own" |
| `finance_mark_payment_paid` does not check direction | Task 1: it refuses money in |
| A rejected payment can be moved to scheduled or posted by a direct update; only a refund is re-checked | Task 1: a rejected payment is final, for every kind |
| Retry after a lost response can duplicate a document | Declined (Decision 24); in Known limits for the three new documents |
| Payment date rules, owner decision pending | Flagged, not decided (Decision 24, "Not in this stage") |
| Bill lines have no stored order | Declined (Decision 24) |
| `service_role` has no default privileges | Nothing is granted to it; the check script fails if anything is |
| Live tests through `tests/helpers/live-workspaces.ts` | Task 1, Step 2 |
| The demo seed: data only, idempotent, applied by the controller | Task 1, steps 5, 11 and 14; it goes in before the deploy because it moves no live screen (Decision 20) |

**Placeholder scan.** Every code block in this plan is a whole file or an exact replacement; there is no "similar to", "as above", "TODO" or elided code. The plan was taken apart by a script that reads only its text; the blocks were applied to an untouched copy of the repository's `main`, task by task, and after each task the type-check, the linter and the unit tests were run.

**Type consistency across tasks.**

- `CashReceiptRow` and `PaymentVoucherRow` (Task 2) have exactly the columns `listCashReceipts` and `listPaymentVouchers` select, which are columns of `finance_cash_receipts` and `finance_payment_vouchers` (Task 1); the views' `org_id`, `created_by` and `created_at`, and the receipts view's lack of `approved_at`, are the only differences, and a unit test pins the selected columns to the row type's keys. `kind` is `'invoice' | 'income'` and `'bill' | 'refund' | 'expense' | 'other'` in both the view's `case` and the types.
- `ExpenseRow` (Task 2) has exactly the columns `listExpenses` selects, which are columns of `finance_expense_totals` (Task 1). `ExpenseStatus` matches the table's `status` check; `ExpenseDisplayStatus` adds `paid`, the fourth value the view's `case` produces.
- `CashBookStatus` is `PaymentInRow['status']`, the six statuses of `finance_transactions`, which are the keys of `CASH_RECEIPT_STATUS_LABELS` and `PAYMENT_VOUCHER_STATUS_LABELS` (Task 4) and of `STATUS_STYLES` in the two views (Task 5). `ExpenseDisplayStatus` is the key of `EXPENSE_STATUS_LABELS` and of the Expenses view's `STATUS_STYLES`.
- `cashReceiptsView` and `paymentVouchersView` (Task 4) take `(rows, today, period)` and are called that way by the two client views (Task 5), which are given `rows` and `today` by their loaders. `expensesView` takes `(rows, today)` and is called by the Expenses loader, whose view takes `rows` and `view: ExpensesViewData`. Every field of the three view-data types is used by its component.
- `SAMPLE_CASH_RECEIPTS`, `SAMPLE_PAYMENT_VOUCHERS` and `SAMPLE_EXPENSES` (Task 4) are typed with the row types of Task 2 and are what the three loaders (Task 5) show with no database.
- The function names and argument names in the database test (Task 1), `finance_save_cash_receipt(target_org, receipt, allocations)`, `finance_post_cash_receipt(target_org, target_txn)`, `finance_record_voucher(target_org, voucher, allocations)`, `finance_save_expense(target_org, expense)`, `finance_mark_payment_paid(target_org, target_txn, paid_on)`, are the SQL functions' parameter names, and the keys inside `receipt`, `voucher` and `expense` are the keys those functions read.

**Review Focus mapped to tasks.**

| Focus | Proven by |
|---|---|
| 1. Replaced guards and function on a live database | Task 1 step 10 (before/after comparison of six views and of every payment row; the two existing check scripts in the dry run), step 13 (three check scripts; function bodies; four existing database test files unchanged and green) |
| 2. Money leaving without approval | Task 1 steps 10 and 13, the check script |
| 3. A payment counted twice or reached through the wrong screen | Task 1 steps 10 and 13; Task 3's unit tests; the controller's smoke step 4 |
| 4. Two at the same moment | Task 1 step 13, `tests/bendahara-cash-book.test.ts` |
| 5. A member's supplier payment or refund held up | Task 1 steps 10 and 13, the check script; the controller's step 13 on production |
| 6. Deleting a workspace or a user | Task 1 steps 10 and 13, the check script |
| 7. The demo's live screens moved by the seed | Task 1 steps 11 and 14 |
| 8. Samples agreeing | Task 4, `tests/finance-cash-book-views.test.ts` |

**How this plan was checked before it was handed over, and what was not.**

*TypeScript.* A script that reads only this file applied each task, in order, to a fresh copy of `origin/main` made outside the worktree. After every task: `pnpm exec tsc --noEmit` clean; `pnpm lint` with the one warning `main` has; `pnpm exec vitest run --exclude 'tests/*.rls.test.ts' --exclude 'tests/bendahara-*.test.ts'` green. After the last task one production build, with the three Supabase variables emptied on the command's own line, completed and listed the three routes. Nothing was run against the hosted database, and `tests/bendahara-*.test.ts` and `tests/*.rls.test.ts` were never run.

*SQL.* It could not be run on the hosted database, and was not. It was run on a throwaway local Postgres 16 with stand-ins for `auth` (`auth.users`, `auth.uid()`, `auth.jwt()`, `auth.mfa_factors`), `storage`, `cron` and the three roles, on top of every migration on `main`, applied in order, so on the real tenancy functions, the real `private.mfa_ok`, `is_org_member`, `is_org_writer` and `is_org_admin`, and the demo workspace as the repository's seeds leave it. There: the schema migration applied; the controller's "before" and "after" blocks found six views and every payment row unchanged; the new check script passed inside the dry-run transaction and by itself on the applied schema; `bendahara_followons_check.sql` and `bendahara_invoices_check.sql` passed, unedited, on the applied schema; the seed ran twice and the summary block gave the line step 11 states; the function bodies' `md5` values in step 13 were read from that database. Four races were run in pairs of sessions (two vouchers for the whole of one expense, one draft receipt posted twice, an expense paid while it is being rejected, an expense rejected while it is being paid) and each ended with exactly one winner. The check script was run against twenty-one deliberately broken copies of the migration (an editor allowed to decide an expense or a payment, the rule on money that settles no document removed or narrowed to drafts, no guard on insert, mixed kinds allowed, the expense cap off, an unapproved expense payable, a rejected payment that can come back, a waiting one that can be paid in one step, an approved one that can be changed or paid for more, a waiting payment's split left open, the refund loop taking in expenses, `finance_mark_payment_paid` taking money in, a view without `security_invoker`, a view counting transfers, a receipt accepting any category, a grant to `anon`, a grant to `service_role`, an expense approved and changed in one update) and did not pass on any of them. The before/after comparison was run against three more broken copies (the kinds swapped in the vouchers view, a live view redefined, a receipts view that leaves rows out) and stopped each.

*Not covered by that.* The hosted project's real `auth.users` columns and triggers; the real `auth.uid()` for a session with no claims, which the seed relies on being null; PostgREST's view of the new objects; whether anything has ever written `party_name` on the hosted `finance_transactions`; the demo workspace's real rows; and `tests/bendahara-cash-book.test.ts` itself, which has only been type-checked and read against the behaviour the local runs showed. Steps 10 to 14 of Task 1 are where those are settled. No screen was opened in a browser: the three views were type-checked and built, and the controller's smoke list is their first look.
