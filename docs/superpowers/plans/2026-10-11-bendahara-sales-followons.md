# Bendahara Quotations, Credit Notes and Refunds Implementation Plan (stage 4a)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stage 4a of the Bendahara CRUD spec: quotations, credit notes and refunds exist in the database with the rules that lock a sent or issued document, an invoice's balance takes credit notes and refunds into account everywhere it is shown, the data layer the three forms will call is written and tested, and the Quotations, Credit Notes and Refunds screens stop being mock-ups: they read the workspace's own data, read-only, with search, filters, "View all" and CSV export.

**Architecture:** One additive migration creates `finance_quotations`, `finance_quotation_lines` and `finance_credit_notes`, adds `finance_invoices.quotation_id`, lets a `finance_allocations` row point at a credit note, and extends the live view `finance_invoice_totals` so that the balance is the spec's: total, less posted money in, less issued credit notes, plus posted refunds. That view becomes the one place the balance is worked out; the guards read it. Four live guard functions are replaced (invoices, allocations, payments, contacts); each handles everything that exists today exactly as before. A refund is money out allocated to an invoice or a credit note, capped at what the customer is in credit. A second, data-only migration seeds the demo workspace. TypeScript follows stage 3a: one Zod schema and one function per write in `src/lib/finance/`, returning `FinResult`; pure view builders with unit tests; each screen a server loader plus a client view. Nothing calls the write functions until stage 4b.

**Tech Stack:** Supabase Postgres (RLS, plpgsql), Next.js 16.3 App Router (server components), React 19, Tailwind v4, shadcn/Radix, Recharts, Zod 4, Vitest (node, no DOM), pnpm.

**Spec:** `docs/superpowers/specs/2026-10-10-bendahara-crud-design.md`, build-order item 4, "Sales follow-ons: Quotations, Credit Notes, Refunds". This plan is the first half (database, data layer, three screens live and read-only, and what the new documents change on screens that are already live). The second half, stage 4b (the three forms, row actions, server actions, "issue credit note" and "refund" from an invoice's row, "convert to invoice" on a quotation), gets its own plan after this merges. Backend notes: `docs/bendahara-backend.md` (read all of it, Known limits included). The stage this one mirrors: `docs/superpowers/plans/2026-10-11-bendahara-invoices.md` (3a). What exists now: `docs/superpowers/plans/2026-10-11-bendahara-invoice-forms.md` (3b). What the database allows today: `supabase/migrations/20261013100000_bendahara_money.sql` and `supabase/migrations/20261014100000_bendahara_invoices.sql`.

## Global Constraints

- New tables are prefixed `finance_`, carry `org_id`, use composite `(org_id, id)` foreign keys, `numeric(14,2)` ringgit, `created_at` and `updated_at`.
- Every table: select for `private.is_org_member(org_id)`, writes for `private.is_org_writer(org_id)`, the restrictive `mfa_required` policy, `revoke all … from anon, authenticated` then explicit grants to `authenticated`. Views are `security_invoker = true` with select granted to `authenticated` only. Nothing is granted to `service_role`: it has no default privileges in this project and nothing here is written by a worker.
- Database functions callable by the app are `security invoker` with `set search_path = ''` and every name schema-qualified; execute is revoked from `public` and `anon`.
- A document that has been posted, sent or issued cannot be edited or deleted. A draft has no number and any other status has one, enforced by a check constraint; the number is given when the document is posted, sent or issued, and that moment is stored. Guards never block deleting a workspace or a user. A direct INSERT cannot create a sent or issued document, and a direct UPDATE cannot send an empty quotation.
- A payment's amount is the sum of its allocations, each rounded to the sen first. Once a payment is split it cannot change direction or go below its split (already enforced; nothing here weakens it).
- `org_id` always comes from the server-side context, never from client input.
- One Zod schema per write; messages are sentences a person can act on. Round first, then validate (`.transform(round).pipe(…)`). Every schema's transforms are idempotent, and every new schema is added to `tests/finance-schemas.test.ts`.
- A table row is keyed by a database id (a quotation's or credit note's `id`, a refund row's `allocation_id`), never by a number that can be null or repeat.
- "Is there anything to show" flags (`hasTrend`, `hasReasons`, `funnelCount`) are worked out from the rows, never from a rounded chart series. Every chart and table has an empty state. A draft or void row shows a dash where an issued one shows a figure that only an issued document has.
- `src/lib/finance/*.ts` must not import `@/lib/supabase/server`, `next/headers` or anything else server-only: client views import types and pure functions from them. `src/screens/finance/sales-sample.ts` is pure too.
- A `'use server'` file exports only async functions. This stage adds no server action.
- Nothing in this stage writes from the browser: the three new views take no `writer`, no actions, and render no button or menu that changes data. Search, filters, "View all" and Export are included because they change nothing.
- Money is shown with `rm()` and `rmShort()` from `format.ts`. Payment method labels come from `PAYMENT_METHOD_LABELS` in `money.ts`; do not define a second map.
- No purple, violet, indigo or fuchsia anywhere. No Kuasa names in `src/`. Icons from lucide-react only.
- `BentoCard`'s `icon` prop is typed `LucideIcon`, but it draws the icon through `AnimatedIcon`, which returns nothing for a name that is not in its map. Pass `BentoCard` only these: `FileText`, `Wallet`, `Plus`, `Banknote`, `TrendingUp`, `ChartColumn`, `PieChart`. The mock-ups pass `Filter`, `FileMinus` and `Undo2`, which are not in the map; do not carry them over.
- Radix `SelectItem` throws at runtime for `value=""`. Every select here has a real default value (`'all'`, `'open'`).
- This is Next.js 16.3. No Next API is used here beyond what `src/screens/finance/invoices.tsx` already uses (an async server component as the screen's default export; `revalidatePath` in the existing actions file). If you reach for anything else, read the matching guide in `node_modules/next/dist/docs/` first.
- pnpm only. 2-space indent, single quotes, semicolons, named exports. The only default exports are the three screen files under `src/screens/finance/`, which Next's generated route files import by default.
- Vitest runs in node with no DOM: components have no unit tests. Everything that can be a pure function is one, in `src/lib/finance/`, with tests; components only draw.
- Every task leaves `pnpm exec tsc --noEmit`, `pnpm lint` and the unit tests green.
- **Unit tests are run with `pnpm exec vitest run --exclude 'tests/*.rls.test.ts' --exclude 'tests/bendahara-*.test.ts'`, or with the files named. Never bare `pnpm test`.** The Supabase variables are set in the implementers' shell, so `tests/bendahara-*.test.ts` and `tests/*.rls.test.ts` run against the hosted production database and leave a user and a workspace behind on every run. No implementer step runs them. `tests/bendahara-followons.test.ts` is written in Task 1 and run only by the controller, after the migration is applied.
- **The hosted database is shared with production. Implementers never call a database tool, never apply or dry-run SQL, and never start a dev server or a browser.** The controller dry-runs each migration inside a rolled-back transaction on the hosted database and applies it only on the owner's explicit go-ahead.
- **Order is fixed:** Task 1's files are written and committed → the controller dry-runs and applies the schema migration (Task 1, steps 10 to 13) → Tasks 2 to 8 → merge and deploy → the controller applies the seed (Task 1, step 14). The schema migration is additive, so production's current code keeps working once it is applied; the new code must not be deployed before it, because the Invoices list reads the view's two new columns. The seed goes in after the deploy because it changes what a live screen shows: under the old code the demo's Invoices table would print three balances as negative amounts.
- Branch `feat-110-bendahara-sales-followons` (already cut from main and checked out; work on it, do not create another). PR title equals the branch name. The PR body has no close keyword. Do not push or merge until the owner says so.

## Not in this stage

- **Forms and row actions** on Quotations, Credit Notes and Refunds, the server actions for them, "issue credit note" and "refund" on an invoice's row, and "convert to invoice" on a quotation's row: stage 4b. The database functions and the data-layer functions are here, with unit tests; nothing calls the write functions yet.
- **Payment Vouchers.** A refund is money out and will also appear there when that screen is built (stage 5). Payments Out stays "money out allocated to bills" and never shows a refund.
- **Applying a customer's credit to another invoice.** Credit sits on the invoice it arose on until it is refunded. Using it against another invoice is: refund it, then record a payment in.
- **Lines on a credit note, and SST on a credit note.** A credit note is one amount, as the spec's data model has it (Decision 3).
- **A void for quotations** (Decision 9), and editing a quotation after it is sent.
- **Fixing `finance_mark_payment_paid`'s missing direction check.** It is used as it is (Decision 7).
- Approval of money (stage 5). Managing accounts (stage 6). Printing, PDF, email. Submission to LHDN. AI tools for finance.

## Decisions this plan makes (flag to the owner at handoff)

Each is a place where the plan decides something the spec left open, goes beyond it, or differs from the brief it was written to. Most consequential first.

1. **What an invoice owes is worked out in one place, the view, and the guards read it.** `finance_invoice_totals.balance` becomes `total − paid − credited + refunded`: posted money in, issued credit notes, posted refunds. Until now the allocation guard added up the invoice's lines and allocations by itself for its "more than is owed" check (`FIN05`); if it kept doing that it would have to repeat the new formula, and the two could drift. It now locks the invoice row and reads `balance` from the view, adding only what the view leaves out on purpose: payments in that are not yet posted. The credit-note guard and the refund checks read the same row. With no credit note and no refund in the database, the figures are what they were; the controller's dry run proves that row for row.
2. **A refund put against a credit note counts on that credit note's invoice.** The spec's formula says "plus posted refunds allocated to it". Read strictly, a refund recorded against a credit note would never close the invoice: paid RM 100, credited RM 30, refunded RM 30 against the note would read RM 30 in credit for ever. So `refunded` on an invoice is posted money out against the invoice itself or against any of its credit notes, and the cap on a refund is always the invoice's credit, whichever of the two the refund names.
3. **A credit note is one amount with a reason, and has no lines.** The brief for this plan said "`finance_credit_notes` + lines"; the spec's data model gives a credit note `reason`, `amount`, `notes` and `status`, and the mock-up shows one Amount column and a chart by reason. This plan follows the spec. The cost: a credit note does not say how much of it is SST, which the SST report (not in this spec) will need. Adding lines later is an additive change.
4. **A balance below zero means the customer is in credit, and the invoice reads Paid.** No new display status: `paid` already means "total above zero and nothing left to pay", and a `credit` status would ripple through every label, style, filter, chart and menu on a live screen. How it shows: the Balance cell on Invoices reads "RM 240.00 in credit" instead of a negative amount; the CSV has Credited and Refunded columns and a Balance below zero, so the columns add up in a spreadsheet; the payment-in form does not offer the invoice; Refunds has an "In credit" card that adds up every invoice's credit. **Credit is not netted:** Total receivable on Invoices and Receivable on Customers & Suppliers add up invoices that are Sent or Overdue, as today, so a customer's credit on one invoice does not reduce what they owe on another. The owner may prefer net figures; that is one line in two functions and is left as a question.
5. **The cap on credit notes: all the issued credit notes of an invoice together never exceed the invoice's total.** Not "what the invoice still owes": that would forbid crediting a paid invoice, which is exactly the case the mock-ups show (a credit note and then a refund on a paid invoice). Not "total plus what was paid": more cannot be credited than was billed. A credit note on a paid invoice leaves the customer in credit, and a refund pays it out. A draft credit note is checked against the same cap when it is saved, so the refusal comes early, and again under a row lock when it is issued.
6. **The cap on refunds: never more than the customer is in credit on that invoice, counting refunds that are still pending; against a credit note, also never more than the note.** A refund while the customer still owes money, or is exactly settled, is refused with `FIN04`, the code money out against an invoice has always had; more than the credit is `FIN05`. Keeping `FIN04` for the first case means every refusal the stage 3a database tests and check script pin stays the same. The cap is checked when the refund is recorded, under a lock on the invoice row, **and again when a pending refund is paid out**, because the credit can go in between (see 7). That second look is the one rule added to the guard on payments.
7. **Voiding a payment in is not blocked by a refund.** If a customer's cheque bounces after they were refunded, the receipt has to be voidable, and the invoice then shows them owing again, refund included, which is the true position. What is blocked: a credit note cannot be voided while a refund is allocated to it, or while the refunds on its invoice would no longer fit in the credit without it; an invoice cannot be voided while it has a refund on it (`FIN02`, as with a payment) or a credit note that is a draft or issued (`FIN12`, new). A pending refund whose credit has gone can no longer be marked paid (`FIN05`); it is deleted.
8. **A refund takes a `PV-` number, and `finance_mark_payment_paid`, `voidPayment`'s update and the delete of a scheduled payment are reused as they are.** A refund is money out, the spec numbers money out `PV-`, and `finance_sequences` allows six document types; a seventh would mean altering a live check constraint and a live function for no gain. Marking a pending refund paid is therefore the existing function, which gives a `PV-` number: used deliberately, not fixed. The known limit that it does not check direction stays, and stays about money in only. The refund functions in the data layer (`markRefundPaid`, `voidRefund`, `deleteRefund`) call the same function, update and delete, kept to money out and worded for a refund, as `voidPaymentIn` does for money in.
9. **Quotations: `draft`, `sent`, `accepted`, `declined` are stored; Expired is derived; there is no void.** "Send" is "mark as sent": the person has given the customer the quotation by their own means, nothing is emailed. It takes the `QT-` number and locks the header and lines, because what the customer holds must stay what the database holds: **a sent quotation cannot be edited.** The owner's rule "a posted document is locked and can only be voided" maps onto a quotation, which is not an accounting document, as: locked on sending; the only thing recorded afterwards is the customer's answer; a quotation that is no longer wanted is marked Declined rather than voided. The answer can be corrected from accepted to declined and back until an invoice is made from the quotation, since without a void there must be a way to undo a slip. A quotation can be accepted after it expired: that is the seller's call. Cost: a quotation sent by mistake counts as declined in the conversion figure.
10. **Convert: one invoice per quotation at a time; a void invoice does not count.** `finance_convert_quotation` makes a draft invoice from an accepted quotation with the same customer, notes and lines, dated today and due after the customer's payment terms. A partial unique index on `finance_invoices (org_id, quotation_id)` where the invoice is not void backs it, so two conversions at once cannot both succeed. If that invoice is voided, or deleted while a draft, the quotation can be converted again. Once an invoice stands, the quotation's answer is frozen (`FIN13`, new). `finance_invoices.quotation_id` is guarded when the tie is made (the quotation must be accepted and for the same customer, `FIN04`). Afterwards the invoice is an ordinary draft: `finance_save_invoice` leaves the column alone and a person may change its lines freely. Changing its customer unties the invoice from the quotation: the guard on invoices clears `quotation_id` in that update, the invoice carries on as a draft with no quotation behind it, and the quotation can be converted again. (Changed after the review of Task 1; the migration on the branch is the authority, and the copies of its SQL and of the check script further down this plan predate that review.)
11. **Four live functions are replaced.** `private.finance_invoice_guard`, `finance_allocation_guard`, `finance_transaction_guard` and `finance_contact_guard`. For every write the deployed code makes, each runs the same checks in the same order and answers with the same code. One thing differs for a write only a direct call can make: money out against an invoice with a split larger than the payment is now `FIN03` (the split is checked before the invoice is read) where it was `FIN04`. Nothing pins that order.
12. **Refunds have their own view and are not on Payments Out.** `finance_payments_out` joins each allocation to its bill, so a refund, which has no bill, cannot appear there, and `supplier_bill_totals` counts only allocations to a bill. Neither view is touched. "Paid (MTD)" on Supplier Bills and Payments Out is built from `finance_payments_out`, so a refund cannot leak into it. The check script and the database test pin this.
13. **A refund's reason is one of five words on the allocation.** `finance_allocations.reason` already exists as free text that nothing writes; it gains a check constraint: `order_cancelled`, `damaged_goods`, `wrong_item`, `overpayment`, `other`. The spec's "with a reason" could be free text, but the mock-up's "Refunds by reason" chart needs categories. Anything more goes in the payment's notes. One refund is against one invoice or one credit note; there is no split.
14. **The demo seed, and what it does to the demo.** 15 quotations, 9 credit notes, 6 refunds, built from the mock-ups. Forced changes: drafts have no number; the mock-ups' credit notes and refunds against invoices that were never seeded (`INV-1029`, `INV-1031`, `INV-1034`) are re-pointed at seeded ones; every refund has a credit note behind it, because a refund needs credit (the mock-up's RM 680 pending refund on a paid invoice had none); the RM 900 refund's credit note is RM 900, not the mock-up's RM 320; one declined quotation and five from earlier months are added so every status and the eight-month chart have something. One credit note is against an invoice that is still owed, `INV-1037`, so **the demo's receivable goes from RM 20,980.00 to RM 20,460.00**; three paid invoices end up in credit by RM 1,600.00 in all, RM 1,000.00 of it held by two pending refunds. Posted by plain UPDATE, as in 3a, because the functions need a signed-in editor. `tests/bendahara-sales.test.ts` is not edited: its seed test pins only what cannot drift (a draft and a paid invoice exist, an open invoice owes something), and that stays true.
15. **Screen changes beyond "keep the layout".** Sparklines and hand-written deltas go, as on every live finance screen. Quotations: Open quotes, Accepted (MTD), Conversion (accepted out of accepted, declined and expired), Pipeline value (drafts and open quotes); the funnel has three steps (Created, Sent, Accepted) over this calendar quarter; the table gains an Invoice column. Credit Notes: Credited (MTD), Issued, Drafts, Invoices affected; "Credits by reason" covers this calendar year; the table gains Reason and Refunded columns. Refunds: Refunded (MTD), Pending, In credit (replacing the mock-up's "Completed"), Invoices refunded; the table gains No. and Credit note columns. The header buttons "New Quotation", "New Credit Note" and "New Refund" are removed until 4b gives them something to do.
16. **A contact with quotations cannot have Customer unticked** (`FIN08`, as with invoices), and the sentence becomes "This contact has invoices or quotations, so it has to stay a customer."
17. **Two sentences on live screens change.** `FIN02` on an invoice becomes "This invoice has payments or refunds. Void the payments on Payments In, and void or delete the refunds on Refunds, before voiding it."; the question asked before voiding an invoice mentions refunds and credit notes. Until 4b ships, no real workspace can have a refund or a credit note, so nobody meets the new cases yet.
18. **One shared sample, and it changes two sample figures.** `sales-sample.ts` gains the sample quotations, credit notes and refunds, and the sample invoices are credited and refunded by exactly those rows; a test checks it. Because one sample credit note is on an unpaid invoice, the Invoices sample's Total receivable becomes RM 20.5k (was RM 21.0k), and the Customers & Suppliers sample's Receivable is changed to match.
19. **Task order differs from the brief's.** The changes to already-live code (Task 5) come before the view rules of the three screens (Task 6), not after the screens, because the sample's agreement test needs `credited` and `refunded` on invoice rows.
20. **The stage 3a check script gets a one-line change** (the list of check constraints on `finance_allocations` has one more), so it still passes after this migration and can be run beside the new one as a second proof that nothing it covers moved.
21. **The seed is applied after the deploy, not before** (see Global Constraints). In 3a it could go in at any time, because nothing live showed the seeded rows.
22. **Migration file names.** `20261022100000` and `20261022100100`: after every file in the folder, which ends at `20261021090000`. (Restamped by the controller after main gained `20261020100000_people_receipt_release.sql`.)

## Review Focus

The cases most likely to hurt, each pinned by a test or by the controller's check.

1. **Three live guards and a live view are replaced, on a database production is using.** Every bill, payment out, invoice and payment in must behave exactly as before. Expected: `tests/bendahara-purchases.test.ts` and `tests/bendahara-sales.test.ts` pass unchanged after the migration; the check script re-runs the whole invoice flow and the whole bill flow through the new guards; the dry run finds `supplier_bill_totals`, `finance_payments_out`, `finance_invoice_totals` and `finance_payments_in` the same, row for row. (Task 1, steps 10 and 13.)
2. **The guards and the screens disagreeing about what an invoice owes, by a sen.** Expected: on one invoice, after every step (credit note, payment in, second credit note, pending refund, refund, voided refund, voided payment), a payment in or a refund of exactly what the view shows is accepted and one sen more is refused. (Task 1, check script, sections "the guards and the view agree…" to "a pending refund is looked at again…"; `tests/bendahara-followons.test.ts`, "a refund pays out a customer's credit, to the sen…".)
3. **Two people refund the same credit, issue two credit notes for the whole invoice, or convert one quotation, at the same moment.** Expected: exactly one succeeds each time. (Task 1, `tests/bendahara-followons.test.ts`, the three "at the same moment" tests.)
4. **A refund counted as a payment to a supplier, or as money received.** Expected: `finance_payments_out` and `finance_payments_in` never show it; no bill's `paid` moves. (Task 1, check script, "paid out: the same function and number series…"; the database test.)
5. **An invoice in credit on the live Invoices screen.** Expected: the Balance cell says "RM 30.00 in credit", never "RM -30.00"; the invoice is Paid, is not offered a payment, and does not lower Total receivable or a contact's Receivable; the CSV's columns add up. (Task 5, `tests/finance-sales-views.test.ts`, "an invoice whose customer is in credit"; `tests/finance-receipt-form.test.ts`; `tests/finance-receivable.test.ts`.)
6. **A workspace, or a user, deleted while sent quotations, issued credit notes and refunds exist.** Expected: both deletes go through; `created_by` is cleared whatever the status; no finance row of the workspace is left. (Task 1, check script, its last two sections.)
7. **A sample screen disagreeing with another sample screen.** Expected: each sample invoice is credited and refunded by exactly the sample credit notes and refunds; no sample refund exceeds its credit. (Task 6, `tests/finance-followon-views.test.ts`, "the sample shown when there is no database".)

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/20261022100000_bendahara_sales_followons.sql` | Quotations, credit notes, allocations to credit notes, four views, guards, six functions |
| `supabase/migrations/20261022100100_bendahara_sales_followons_seed.sql` | Demo quotations, credit notes and refunds; data only |
| `supabase/tests/bendahara_followons_check.sql` | The controller's check: the invoice flow, the bill flow and the three new documents, as owner, editor, viewer and outsider; always rolls back |
| `supabase/tests/bendahara_invoices_check.sql` | (one line changed) the 3a check, kept passing |
| `tests/bendahara-followons.test.ts` | The three new documents against the hosted database; run by the controller only |
| `src/lib/finance/quotations.ts` | Quotation schemas, reads, writes |
| `src/lib/finance/credit-notes.ts` | Credit note schemas, reads, writes |
| `src/lib/finance/refunds.ts` | Refund schema, reads, writes |
| `src/lib/finance/document-lines.ts` | (modified) `ringgitAmount`, the amount schema credit notes and refunds share |
| `src/lib/finance/invoices.ts`, `contacts.ts`, `sales-views.ts` | (modified) `credited` and `refunded` on an invoice row; two sentences; `inCredit`, `balanceText`; CSV columns |
| `src/lib/finance/sales-followon-views.ts` | KPI figures, chart data, filters, status words and CSV rows for the three screens |
| `src/screens/finance/sales-sample.ts` | (rewritten) sample invoices credited and refunded; sample quotations, credit notes and refunds |
| `src/components/finance/quotations-view.tsx`, `credit-notes-view.tsx`, `refunds-view.tsx` | Client views, read-only |
| `src/components/finance/invoices-view.tsx` | (modified) the Balance cell and the void question |
| `src/screens/finance/quotations.tsx`, `credit-notes.tsx`, `refunds.tsx` | (replaced) server loaders |
| `src/screens/finance/customers-suppliers.tsx` | (modified) one sample figure |
| `src/config/live-screens.ts`, `src/app/(app)/finance/actions.ts` | (modified) three screens are live; contact and sales actions refresh them |
| `docs/bendahara-backend.md` | (modified) the three documents, the balance, guards, functions, error codes, known limits |
| `tests/finance-quotations.test.ts`, `tests/finance-credit-notes.test.ts`, `tests/finance-refunds.test.ts`, `tests/finance-followon-views.test.ts` | New unit tests |
| `tests/finance-schemas.test.ts`, `tests/finance-invoices.test.ts`, `tests/finance-sales-data.test.ts`, `tests/finance-sales-views.test.ts`, `tests/finance-receipt-form.test.ts`, `tests/finance-sales-rules.test.ts`, `tests/finance-invoice-form.test.ts`, `tests/finance-receivable.test.ts`, `tests/finance-contacts.test.ts`, `tests/finance-contact-paths.test.ts`, `tests/finance-sales-actions.test.ts`, `tests/live-screens.test.ts` | (modified) more cases, new row fields, pinned sentences and paths |

Names used across tasks, spelled once here:

- From `quotations.ts`: `QUOTATION_LINES_MAX`, `QUOTATION_PAGE_SIZE`, `QUOTATION_MESSAGES`, `saveQuotationInput`, `quotationIdInput`, `QuotationStatus`, `QuotationDisplayStatus`, `QuotationListRow`, `QuotationLine`, `QuotationDetail`, `listQuotations`, `getQuotation`, `saveQuotation`, `sendQuotation`, `acceptQuotation`, `declineQuotation`, `deleteQuotation`, `convertQuotation`.
- From `credit-notes.ts`: `CREDIT_NOTE_REASONS`, `CreditNoteReason`, `CREDIT_NOTE_REASON_LABELS`, `CREDIT_NOTE_PAGE_SIZE`, `CREDIT_NOTE_MESSAGES`, `saveCreditNoteInput`, `creditNoteIdInput`, `CreditNoteStatus`, `CreditNoteRow`, `listCreditNotes`, `saveCreditNote`, `issueCreditNote`, `voidCreditNote`, `deleteCreditNote`.
- From `refunds.ts`: `REFUND_REASONS`, `RefundReason`, `REFUND_REASON_LABELS`, `REFUND_MESSAGES`, `recordRefundInput`, `RefundRow`, `listRefunds`, `recordRefund`, `markRefundPaid`, `voidRefund`, `deleteRefund`. Reused from `money.ts`, unchanged: `PAYMENT_METHODS`, `PAYMENT_METHOD_LABELS`, `PaymentMethod`, `PAYMENT_PAGE_SIZE`, `markPaymentPaidInput`, `paymentIdInput`, `PaymentInRow`.
- New in `document-lines.ts`: `ringgitAmount`. New in `invoices.ts`: `InvoiceListRow.credited`, `InvoiceListRow.refunded`, `INVOICE_MESSAGES.hasCreditNotes`. New in `sales-views.ts`: `inCredit`, `balanceText`.
- From `sales-followon-views.ts`: `customersOf`, `QuotationsViewData`, `QUOTATION_STATUS_LABELS`, `quotationsView`, `QuotationFilter`, `filterQuotations`, `quotationInvoice`, `quotationsCsv`, `CreditNotesViewData`, `CREDIT_NOTE_STATUS_LABELS`, `creditNotesView`, `CreditNoteFilter`, `filterCreditNotes`, `refundedOnNote`, `creditNotesCsv`, `RefundsViewData`, `REFUND_STATUS_LABELS`, `isPendingRefund`, `refundsView`, `RefundFilter`, `filterRefunds`, `refundsCsv`.
- From `sales-sample.ts`: `SAMPLE_TODAY`, `SAMPLE_INVOICES`, `SAMPLE_PAYMENTS_IN` (as before), `SAMPLE_QUOTATIONS`, `SAMPLE_CREDIT_NOTES`, `SAMPLE_REFUNDS`.
- A quotation row's `display_status` is one of `draft`, `sent`, `accepted`, `declined`, `expired`. A credit note row's `status` is `draft`, `issued` or `void`. A refund row's `status` is a payment's: `scheduled` is worded "Pending" and `posted` "Refunded".

## What an invoice still owes: every place that says so

All of them must agree after this stage. The first is the definition; the rest read it.

| Where | What it does | After this stage |
|---|---|---|
| `finance_invoice_totals` (SQL view), lateral `v` | Works out `total`, `paid`, `balance`, `display_status` | Adds `credited` and `refunded`; `balance = total − paid − credited + refunded`. The only place the formula is written |
| `private.finance_allocation_guard()`, invoice branch (`FIN05`) | Added up lines and every allocation on the invoice, with no direction filter | Reads `balance` from the view. Money in: payments in not yet posted, plus the new amount, must not exceed `balance`. Money out: refunds not yet paid out, plus the new amount, must not exceed `−balance` |
| `private.finance_invoice_guard()`, void (`FIN02`) | "Has any allocation whose payment is not void" | Unchanged, and now also true of a refund on the invoice. Adds `FIN12` for credit notes |
| `private.finance_credit_note_guard()` (new) | — | Reads `total` and `credited` from the view for the cap; `paid`, `credited`, `refunded` for the void rule |
| `private.finance_transaction_guard()`, a refund being paid out (new) | — | Reads `balance` from the view for each invoice the refund names |
| `listInvoices`, `getInvoice` (`invoices.ts`) | Read `total`, `paid`, `balance` from the view | Also read `credited`, `refunded`. No arithmetic |
| `owed`, `invoicesView`, `invoicesCsv` (`sales-views.ts`) | Use `balance` of issued invoices; sum `balance` of Sent and Overdue | Unchanged logic. `inCredit` and `balanceText` word a balance below zero; the CSV gains two columns |
| `receivableInvoices` (`receipt-form.ts`), the payment-in form's "owed" | `balance` less what unposted payments in hold, for invoices that are Sent or Overdue with `balance > 0` | Unchanged, and equal to what the guard allows: both are `balance` less unposted money in. An invoice in credit is Paid, so it is never offered |
| `listInvoiceBalances`, `contactsView` (`contacts.ts`), Receivable | Sum `balance` of invoices that are Sent or Overdue | Unchanged. An invoice in credit is Paid, so credit is never netted (Decision 4) |
| `sales-sample.ts`, the sample invoices | Computed `balance: total - paid` by hand | `total − paid − credited + refunded`, with a test that the sample credit notes and refunds add up to those figures |
| `refundsView` (`sales-followon-views.ts`, new), "In credit" | — | Sums `inCredit` over every invoice |

## Database error codes

Raised by the guards and functions with these SQLSTATEs. Existing codes are reused where the meaning is the same; the file that made the call words them. **Two codes are new: `FIN12` and `FIN13`.** `FIN12` must be added to the message map of a file that is already live, `REFUSALS` in `src/lib/finance/invoices.ts` (Task 5); `FIN13` is in the new `quotations.ts` (Task 2).

| Code | New meaning in this stage | Sentence |
|---|---|---|
| `FIN01` | A quotation must be created as a draft; one that has been sent cannot be edited, deleted or sent again, and its lines are locked; a draft cannot be accepted or declined. A credit note must be created as a draft; an issued or void one cannot be edited or deleted; a draft cannot be voided | `QUOTATION_MESSAGES.locked`, `CREDIT_NOTE_MESSAGES.locked` |
| `FIN02` | An invoice with a refund on it cannot be voided (as with a payment). A credit note cannot be voided while a refund is allocated to it, or while refunds on its invoice depend on its credit | `INVOICE_MESSAGES.hasPayments` (reworded), `CREDIT_NOTE_MESSAGES.hasRefunds` |
| `FIN04` | Money out against an invoice whose customer is not in credit (as before: "only money in pays an invoice"); a refund against a credit note that is not issued, or an invoice that is not posted; money in against a credit note; a credit note against an invoice that is not posted; converting a quotation that is not accepted; tying an invoice to a quotation that is not accepted or is another customer's | `REFUND_MESSAGES.notInCredit`, `CREDIT_NOTE_MESSAGES.notPosted`, `QUOTATION_MESSAGES.notAccepted` |
| `FIN05` | A refund of more than the customer is in credit, counting pending refunds, or of more than is left of its credit note; a pending refund paid out after the credit has gone; a credit note of more than the invoice's total less what is already credited. Money in against an invoice is unchanged, and now counts credit notes and refunds through the view | `REFUND_MESSAGES.tooMuch`, `CREDIT_NOTE_MESSAGES.tooMuch` |
| `FIN06` | A refund that names no document, or an invoice and a credit note at once, or one that is not in the workspace | `REFUND_MESSAGES.notFound` |
| `FIN08` | The contact has invoices **or quotations**, so Customer cannot be unticked | `CONTACT_MESSAGES.hasInvoices` (reworded) |
| `FIN09` | (unchanged) A refund that was paid out cannot be changed or deleted; one that is not scheduled cannot be marked paid; one that was never paid out cannot be voided | `REFUND_MESSAGES.locked` |
| `FIN10` | A quotation has no lines, or its lines total nothing: it cannot be saved without a line or sent without an amount | `QUOTATION_MESSAGES.empty` |
| `FIN11` | The quotation or credit note no longer exists. `finance_send_quotation`, `finance_convert_quotation` and `finance_issue_credit_note` also answer this to a viewer, who may not lock the row | `QUOTATION_MESSAGES.gone`, `CREDIT_NOTE_MESSAGES.gone`, `REFUND_MESSAGES.gone` |
| **`FIN12`** | **New.** The invoice has a credit note that is a draft or issued, so it cannot be voided | `INVOICE_MESSAGES.hasCreditNotes` |
| **`FIN13`** | **New.** The quotation already has an invoice that is not void: it cannot be converted again and its answer can no longer change | `QUOTATION_MESSAGES.hasInvoice` |
| `23505` | Converting: two conversions at the same moment met the one-invoice-per-quotation index | `QUOTATION_MESSAGES.hasInvoice` |
| `23514` | A check constraint: a draft with a number, a sent quotation without `sent_at`, `accepted_at` not matching the status, an unknown reason, an allocation naming two documents. Only a direct write can break them | none |
| `23503` | The invoice of a credit note, or the account of a refund, is not in the workspace | `CREDIT_NOTE_MESSAGES.missing`, `REFUND_MESSAGES.missing` |

`FIN03`, `FIN07` and every existing meaning of the codes above are unchanged.

---
### Task 1: Migration, seed, check script and database tests

**Files:**
- Create: `tests/bendahara-followons.test.ts`
- Create: `supabase/migrations/20261022100000_bendahara_sales_followons.sql`
- Create: `supabase/migrations/20261022100100_bendahara_sales_followons_seed.sql`
- Create: `supabase/tests/bendahara_followons_check.sql`
- Modify: `supabase/tests/bendahara_invoices_check.sql` (one line)

**Interfaces:**
- Consumes (already in the database): `public.finance_contacts`, `public.finance_products`, `public.finance_accounts`, `public.finance_invoices`, `public.finance_invoice_lines`, `public.finance_transactions`, `public.finance_allocations` (with its check constraint `finance_allocations_one_document_check` and its free-text column `reason`), `public.finance_sequences`, `public.finance_next_number(target_org uuid, doc text) returns text` (which already answers `'quotation'` with `QT-`, `'credit_note'` with `CN-` and `'voucher'` with `PV-`, so no sequence definition is added), `public.finance_mark_payment_paid(target_org uuid, target_txn uuid, paid_on date) returns text` (used as it is for a pending refund), `private.finance_seed_accounts(target_org uuid)`, `private.is_org_member`, `private.is_org_writer`, `private.mfa_ok`, and the triggers `finance_invoice_guard`, `finance_allocation_guard`, `finance_transaction_guard` and `finance_contact_guard` (their functions are replaced; the triggers stay).
- Produces tables `finance_quotations`, `finance_quotation_lines`, `finance_credit_notes`; columns `finance_invoices.quotation_id` and `finance_allocations.credit_note_id`; views `finance_quotation_totals`, `finance_credit_note_totals`, `finance_refunds`; two more columns on `finance_invoice_totals`.
- Produces functions:
  - `public.finance_save_quotation(target_org uuid, quotation jsonb, lines jsonb) returns uuid`
  - `public.finance_send_quotation(target_org uuid, target_quotation uuid) returns text`
  - `public.finance_convert_quotation(target_org uuid, target_quotation uuid) returns uuid` (the new invoice's id)
  - `public.finance_save_credit_note(target_org uuid, note jsonb) returns uuid`
  - `public.finance_issue_credit_note(target_org uuid, target_note uuid) returns text`
  - `public.finance_record_refund(target_org uuid, refund jsonb) returns uuid`
- `finance_invoice_totals` columns, in order: `id, org_id, customer_id, customer_name, invoice_no, invoice_date, due_date, notes, status, posted_at, einvoice_status, einvoice_uuid, created_by, created_at, updated_at, subtotal, sst, total, paid, balance, display_status, credited, refunded`. The first 21 are as they were; `create or replace view` only allows adding at the end.
- `finance_quotation_totals` columns: `id, org_id, customer_id, customer_name, quotation_no, quote_date, valid_until, notes, status, sent_at, accepted_at, created_by, created_at, updated_at, subtotal, sst, total, display_status, invoice_id, invoice_no`.
- `finance_credit_note_totals` columns: `id, org_id, invoice_id, invoice_no, customer_id, customer_name, credit_note_no, credit_date, reason, amount, notes, status, issued_at, created_by, created_at, updated_at, refunded`.
- `finance_refunds` columns: `allocation_id, transaction_id, org_id, number, txn_date, method, amount, transaction_amount, status, reference, reason, notes, account_id, account_name, invoice_id, invoice_no, credit_note_id, credit_note_no, customer_id, customer_name, created_at`.

**The implementer writes the five files and commits (steps 1 to 9). Steps 10 to 14 are the controller's and are not run by an implementer. No step of this task runs anything against a database.**

What is replaced and what is left alone, so nobody has to rediscover it:

- `finance_payments_out`, `finance_payments_in`, `supplier_bill_totals`, the bill guards, and the functions `finance_record_payment_out`, `finance_record_payment_in`, `finance_mark_payment_paid`, `finance_save_invoice`, `finance_post_invoice` and `finance_next_number` are **not touched**.
- `finance_invoice_totals` is replaced in place (`create or replace view`), same columns in the same order plus two at the end.
- `private.finance_invoice_guard()`: the 3a function, plus the `quotation_id` rule on insert and on a draft update, plus the `FIN12` check when voiding.
- `private.finance_allocation_guard()`: the 3a function with the invoice branch rewritten to read the view, a credit-note branch, and the refund checks. The bill branch is the 3a text.
- `private.finance_transaction_guard()`: the 3a function with one block added before its final `return new`.
- `private.finance_contact_guard()`: the 3a function with quotations added to the `FIN08` test.

- [ ] **Step 1: Check the file names are free**

Run: `ls supabase/migrations | grep -c 2026102010`
Expected: `0`. Then `ls supabase/migrations | tail -1` shows `20261019090000_hire_cv_upload.sql`: the two new files sort after everything there. If the count is not 0, or a later stamp has appeared, stop and report: another migration has taken the stamp.

- [ ] **Step 2: Write the database test**

Create `tests/bendahara-followons.test.ts`:

```ts
import { beforeAll, expect, test } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';

const testWithSupabase = hasSupabaseEnv ? test : test.skip;

if (!hasSupabaseEnv) console.warn(supabaseEnvSkipReason);

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

function client(): SupabaseClient {
  return createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
}

type Org = { c: SupabaseClient; orgId: string; bank: string; customer: string };

async function anonUserWithOrg(orgName: string): Promise<Org> {
  const c = client();
  const { error: authErr } = await c.auth.signInAnonymously();
  expect(authErr, authErr?.message).toBeNull();
  const { data: orgId, error } = await c.rpc('create_org_for_current_user', { org_name: orgName });
  expect(error, error?.message).toBeNull();
  const { data: accounts } = await c.from('finance_accounts').select('id, name').eq('org_id', orgId);
  const bank = accounts?.find((a) => a.name === 'Main Bank')?.id as string;
  const { data: customer, error: customerErr } = await c
    .from('finance_contacts')
    .insert({ org_id: orgId, name: `Customer of ${orgName}`, is_customer: true, payment_terms_days: 14 })
    .select('id')
    .single();
  expect(customerErr, customerErr?.message).toBeNull();
  return { c, orgId: orgId as string, bank, customer: customer!.id as string };
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

function receive(o: Org, invoiceId: string, amount: number) {
  return o.c.rpc('finance_record_payment_in', {
    target_org: o.orgId,
    payment: { account_id: o.bank, txn_date: daysFromToday(0), method: 'fpx' },
    allocations: [{ invoice_id: invoiceId, amount }],
  });
}

function saveQuotation(o: Org, lines: object[] = [DESIGN], extra: object = {}) {
  return o.c.rpc('finance_save_quotation', {
    target_org: o.orgId,
    quotation: { customer_id: o.customer, quote_date: daysFromToday(0), valid_until: daysFromToday(30), ...extra },
    lines,
  });
}

/** A sent quotation of RM 132.50. */
async function sentQuotation(o: Org, extra: object = {}) {
  const saved = await saveQuotation(o, [DESIGN], extra);
  expect(saved.error, saved.error?.message).toBeNull();
  const sent = await o.c.rpc('finance_send_quotation', { target_org: o.orgId, target_quotation: saved.data });
  expect(sent.error, sent.error?.message).toBeNull();
  return { id: saved.data as string, quotationNo: sent.data as string };
}

function answer(o: Org, id: string, status: 'accepted' | 'declined') {
  const now = new Date().toISOString();
  return o.c
    .from('finance_quotations')
    .update({ status, accepted_at: status === 'accepted' ? now : null, updated_at: now })
    .eq('id', id)
    .select('id');
}

function saveCreditNote(o: Org, invoiceId: string, amount: number, extra: object = {}) {
  return o.c.rpc('finance_save_credit_note', {
    target_org: o.orgId,
    note: { invoice_id: invoiceId, credit_date: daysFromToday(0), reason: 'returns', amount, ...extra },
  });
}

/** An issued credit note. */
async function issuedCreditNote(o: Org, invoiceId: string, amount: number) {
  const saved = await saveCreditNote(o, invoiceId, amount);
  expect(saved.error, saved.error?.message).toBeNull();
  const issued = await o.c.rpc('finance_issue_credit_note', { target_org: o.orgId, target_note: saved.data });
  expect(issued.error, issued.error?.message).toBeNull();
  return { id: saved.data as string, creditNoteNo: issued.data as string };
}

function refund(o: Org, against: { invoice_id?: string; credit_note_id?: string }, amount: number, status: 'posted' | 'scheduled' = 'posted') {
  return o.c.rpc('finance_record_refund', {
    target_org: o.orgId,
    refund: { ...against, account_id: o.bank, txn_date: daysFromToday(0), method: 'fpx', reason: 'damaged_goods', amount, status },
  });
}

async function totals(c: SupabaseClient, invoiceId: string) {
  const { data, error } = await c
    .from('finance_invoice_totals')
    .select('total, paid, credited, refunded, balance, display_status')
    .eq('id', invoiceId)
    .single();
  expect(error, error?.message).toBeNull();
  return data!;
}

let a: Org;
let b: Org;

beforeAll(async () => {
  if (!hasSupabaseEnv) return;
  a = await anonUserWithOrg('Follow-ons A Sdn Bhd');
  b = await anonUserWithOrg('Follow-ons B Sdn Bhd');
});

testWithSupabase('a draft quotation has no number; sending gives it the next one and locks it', async () => {
  const saved = await saveQuotation(a);
  expect(saved.error, saved.error?.message).toBeNull();
  const { data: draft } = await a.c
    .from('finance_quotation_totals')
    .select('quotation_no, total, display_status, invoice_id')
    .eq('id', saved.data)
    .single();
  expect(draft).toEqual({ quotation_no: null, total: 132.5, display_status: 'draft', invoice_id: null });

  const none = await saveQuotation(a, []);
  expect(none.error?.code).toBe('FIN10');
  const direct = await a.c.from('finance_quotations').insert({
    org_id: a.orgId, customer_id: a.customer, quotation_no: 'QT-SNEAKY', valid_until: daysFromToday(30), status: 'sent',
    sent_at: new Date().toISOString(),
  });
  expect(direct.error?.code).toBe('FIN01');
  expect((await answer(a, saved.data, 'accepted')).error?.code).toBe('FIN01');

  const sent = await a.c.rpc('finance_send_quotation', { target_org: a.orgId, target_quotation: saved.data });
  expect(sent.error, sent.error?.message).toBeNull();
  expect(sent.data).toMatch(/^QT-\d{4}$/);

  const edit = await a.c.from('finance_quotations').update({ notes: 'Sneaky' }).eq('id', saved.data);
  expect(edit.error?.code).toBe('FIN01');
  const line = await a.c
    .from('finance_quotation_lines')
    .insert({ org_id: a.orgId, quotation_id: saved.data, description: 'Extra', quantity: 1, unit_price: 1 });
  expect(line.error?.code).toBe('FIN01');
  const remove = await a.c.from('finance_quotations').delete().eq('id', saved.data);
  expect(remove.error?.code).toBe('FIN01');
  const again = await a.c.rpc('finance_send_quotation', { target_org: a.orgId, target_quotation: saved.data });
  expect(again.error?.code).toBe('FIN01');
});

testWithSupabase('a sent quotation past its date shows as expired, and can still be accepted', async () => {
  const quotation = await sentQuotation(a, { quote_date: daysFromToday(-40), valid_until: daysFromToday(-10) });
  const status = async () =>
    (await a.c.from('finance_quotation_totals').select('display_status').eq('id', quotation.id).single()).data?.display_status;
  expect(await status()).toBe('expired');
  const noDate = await a.c.from('finance_quotations').update({ status: 'accepted' }).eq('id', quotation.id);
  expect(noDate.error?.code).toBe('23514');
  expect((await answer(a, quotation.id, 'accepted')).error).toBeNull();
  expect(await status()).toBe('accepted');
  expect((await answer(a, quotation.id, 'declined')).error).toBeNull();
  expect(await status()).toBe('declined');
});

testWithSupabase('an accepted quotation becomes one draft invoice with the same lines, and only one', async () => {
  const quotation = await sentQuotation(a);
  const early = await a.c.rpc('finance_convert_quotation', { target_org: a.orgId, target_quotation: quotation.id });
  expect(early.error?.code).toBe('FIN04');
  expect((await answer(a, quotation.id, 'accepted')).error).toBeNull();

  const converted = await a.c.rpc('finance_convert_quotation', { target_org: a.orgId, target_quotation: quotation.id });
  expect(converted.error, converted.error?.message).toBeNull();
  const { data: invoice } = await a.c
    .from('finance_invoices')
    .select('status, customer_id, quotation_id, invoice_no, invoice_date, due_date')
    .eq('id', converted.data)
    .single();
  // The customer's payment terms are 14 days.
  expect(invoice).toEqual({
    status: 'draft', customer_id: a.customer, quotation_id: quotation.id, invoice_no: null,
    invoice_date: daysFromToday(0), due_date: daysFromToday(14),
  });
  const { data: lines } = await a.c.from('finance_invoice_lines').select('description, amount, sst_amount').eq('invoice_id', converted.data);
  expect(lines).toEqual([{ description: 'Design work', amount: 125, sst_amount: 7.5 }]);
  const { data: linked } = await a.c.from('finance_quotation_totals').select('invoice_id, invoice_no').eq('id', quotation.id).single();
  expect(linked).toEqual({ invoice_id: converted.data, invoice_no: null });

  const twice = await a.c.rpc('finance_convert_quotation', { target_org: a.orgId, target_quotation: quotation.id });
  expect(twice.error?.code).toBe('FIN13');
  expect((await answer(a, quotation.id, 'declined')).error?.code).toBe('FIN13');
  const byHand = await a.c
    .from('finance_invoices')
    .insert({ org_id: a.orgId, customer_id: a.customer, due_date: daysFromToday(30), quotation_id: quotation.id });
  expect(byHand.error?.code).toBe('23505');

  // Deleting the draft invoice frees the quotation.
  const removed = await a.c.from('finance_invoices').delete().eq('id', converted.data);
  expect(removed.error, removed.error?.message).toBeNull();
  const again = await a.c.rpc('finance_convert_quotation', { target_org: a.orgId, target_quotation: quotation.id });
  expect(again.error, again.error?.message).toBeNull();
});

testWithSupabase('two conversions of one quotation at the same moment: only one invoice is made', async () => {
  const quotation = await sentQuotation(a);
  expect((await answer(a, quotation.id, 'accepted')).error).toBeNull();
  const convert = () => a.c.rpc('finance_convert_quotation', { target_org: a.orgId, target_quotation: quotation.id });
  const results = await Promise.all([convert(), convert()]);
  expect(results.filter((r) => r.error === null)).toHaveLength(1);
  expect(['FIN13', '23505']).toContain(results.find((r) => r.error)?.error?.code);
  const { data: invoices } = await a.c.from('finance_invoices').select('id').eq('quotation_id', quotation.id);
  expect(invoices).toHaveLength(1);
});

testWithSupabase('an issued credit note lowers what the invoice owes; a draft does not', async () => {
  const invoice = await postedInvoice(a);
  const saved = await saveCreditNote(a, invoice, 30);
  expect(saved.error, saved.error?.message).toBeNull();
  expect(await totals(a.c, invoice)).toMatchObject({ credited: 0, balance: 132.5, display_status: 'sent' });
  const tooMuch = await saveCreditNote(a, invoice, 132.51);
  expect(tooMuch.error?.code).toBe('FIN05');
  const direct = await a.c.from('finance_credit_notes').insert({
    org_id: a.orgId, invoice_id: invoice, credit_note_no: 'CN-SNEAKY', amount: 1, status: 'issued', issued_at: new Date().toISOString(),
  });
  expect(direct.error?.code).toBe('FIN01');

  const issued = await a.c.rpc('finance_issue_credit_note', { target_org: a.orgId, target_note: saved.data });
  expect(issued.error, issued.error?.message).toBeNull();
  expect(issued.data).toMatch(/^CN-\d{4}$/);
  expect(await totals(a.c, invoice)).toEqual({ total: 132.5, paid: 0, credited: 30, refunded: 0, balance: 102.5, display_status: 'sent' });

  const edit = await a.c.from('finance_credit_notes').update({ amount: 1 }).eq('id', saved.data);
  expect(edit.error?.code).toBe('FIN01');
  const remove = await a.c.from('finance_credit_notes').delete().eq('id', saved.data);
  expect(remove.error?.code).toBe('FIN01');

  // What a payment in may take is what the screen shows as owed: a sen more is refused.
  expect((await receive(a, invoice, 102.51)).error?.code).toBe('FIN05');
  expect((await receive(a, invoice, 102.5)).error).toBeNull();
  expect(await totals(a.c, invoice)).toMatchObject({ paid: 102.5, balance: 0, display_status: 'paid' });

  // An invoice with a credit note cannot be voided, whatever else is on it.
  const voidInvoice = await a.c.from('finance_invoices').update({ status: 'void' }).eq('id', invoice);
  expect(['FIN02', 'FIN12']).toContain(voidInvoice.error?.code);
});

testWithSupabase('an invoice with a credit note, and no money on it, cannot be voided until the note is', async () => {
  const invoice = await postedInvoice(a);
  const note = await issuedCreditNote(a, invoice, 32.5);
  const held = await a.c.from('finance_invoices').update({ status: 'void' }).eq('id', invoice);
  expect(held.error?.code).toBe('FIN12');
  const voided = await a.c.from('finance_credit_notes').update({ status: 'void', updated_at: new Date().toISOString() }).eq('id', note.id);
  expect(voided.error, voided.error?.message).toBeNull();
  expect(await totals(a.c, invoice)).toMatchObject({ credited: 0, balance: 132.5 });
  const free = await a.c.from('finance_invoices').update({ status: 'void' }).eq('id', invoice);
  expect(free.error, free.error?.message).toBeNull();
});

testWithSupabase('a refund pays out a customer’s credit, to the sen, and a pending refund holds it', async () => {
  const invoice = await postedInvoice(a);
  expect((await receive(a, invoice, 132.5)).error).toBeNull();
  // Paid in full and owed nothing: there is nothing to refund yet.
  expect((await refund(a, { invoice_id: invoice }, 1)).error?.code).toBe('FIN04');

  const note = await issuedCreditNote(a, invoice, 30);
  expect(await totals(a.c, invoice)).toEqual({ total: 132.5, paid: 132.5, credited: 30, refunded: 0, balance: -30, display_status: 'paid' });
  expect((await receive(a, invoice, 0.01)).error?.code).toBe('FIN05');
  expect((await refund(a, { invoice_id: invoice }, 30.01)).error?.code).toBe('FIN05');

  const pending = await refund(a, { credit_note_id: note.id }, 20, 'scheduled');
  expect(pending.error, pending.error?.message).toBeNull();
  expect(await totals(a.c, invoice)).toMatchObject({ refunded: 0, balance: -30 });
  expect((await refund(a, { invoice_id: invoice }, 10.01)).error?.code).toBe('FIN05');
  const now = await refund(a, { invoice_id: invoice }, 10);
  expect(now.error, now.error?.message).toBeNull();
  expect(await totals(a.c, invoice)).toMatchObject({ refunded: 10, balance: -20 });

  const { data: rows } = await a.c
    .from('finance_refunds')
    .select('transaction_id, number, amount, status, reason, invoice_id, credit_note_no, customer_name')
    .eq('invoice_id', invoice)
    .order('amount', { ascending: false });
  expect(rows).toEqual([
    {
      transaction_id: pending.data, number: null, amount: 20, status: 'scheduled', reason: 'damaged_goods',
      invoice_id: invoice, credit_note_no: note.creditNoteNo, customer_name: 'Customer of Follow-ons A Sdn Bhd',
    },
    {
      transaction_id: now.data, number: expect.stringMatching(/^PV-\d{4}$/), amount: 10, status: 'posted', reason: 'damaged_goods',
      invoice_id: invoice, credit_note_no: null, customer_name: 'Customer of Follow-ons A Sdn Bhd',
    },
  ]);

  // Nothing a refund leans on can be voided.
  const voidNote = await a.c.from('finance_credit_notes').update({ status: 'void' }).eq('id', note.id);
  expect(voidNote.error?.code).toBe('FIN02');
  const voidInvoice = await a.c.from('finance_invoices').update({ status: 'void' }).eq('id', invoice);
  expect(voidInvoice.error?.code).toBe('FIN02');

  const paid = await a.c.rpc('finance_mark_payment_paid', { target_org: a.orgId, target_txn: pending.data, paid_on: daysFromToday(0) });
  expect(paid.error, paid.error?.message).toBeNull();
  expect(paid.data).toMatch(/^PV-\d{4}$/);
  expect(await totals(a.c, invoice)).toEqual({ total: 132.5, paid: 132.5, credited: 30, refunded: 30, balance: 0, display_status: 'paid' });

  // A refund is not a payment to a supplier and not a payment in.
  const { data: out } = await a.c.from('finance_payments_out').select('allocation_id').in('transaction_id', [pending.data, now.data]);
  expect(out).toEqual([]);
  const { data: moneyIn } = await a.c.from('finance_payments_in').select('allocation_id').in('transaction_id', [pending.data, now.data]);
  expect(moneyIn).toEqual([]);

  // Paid out, it can only be voided, which puts the credit back.
  const remove = await a.c.from('finance_transactions').delete().eq('id', now.data);
  expect(remove.error?.code).toBe('FIN09');
  const voided = await a.c.from('finance_transactions').update({ status: 'void' }).eq('id', now.data);
  expect(voided.error, voided.error?.message).toBeNull();
  expect(await totals(a.c, invoice)).toMatchObject({ refunded: 20, balance: -10 });
});

testWithSupabase('a refund against a credit note needs the customer to be in credit, and is never more than the note', async () => {
  const unpaid = await postedInvoice(a);
  const onUnpaid = await issuedCreditNote(a, unpaid, 30);
  // The invoice still owes RM 102.50: a credit note alone is not money to give back.
  expect((await refund(a, { credit_note_id: onUnpaid.id }, 30)).error?.code).toBe('FIN04');

  const paid = await postedInvoice(a);
  expect((await receive(a, paid, 132.5)).error).toBeNull();
  const small = await issuedCreditNote(a, paid, 20);
  await issuedCreditNote(a, paid, 50);
  // RM 70 in credit, but the small note is RM 20.
  expect((await refund(a, { credit_note_id: small.id }, 20.01)).error?.code).toBe('FIN05');
  expect((await refund(a, { credit_note_id: small.id }, 20)).error).toBeNull();
  expect((await refund(a, { credit_note_id: small.id }, 0.01)).error?.code).toBe('FIN05');
  expect(await totals(a.c, paid)).toMatchObject({ credited: 70, refunded: 20, balance: -50 });
});

testWithSupabase('two refunds of the whole credit at the same moment: only one goes through', async () => {
  const invoice = await postedInvoice(a);
  expect((await receive(a, invoice, 132.5)).error).toBeNull();
  await issuedCreditNote(a, invoice, 30);
  const results = await Promise.all([refund(a, { invoice_id: invoice }, 30), refund(a, { invoice_id: invoice }, 30)]);
  expect(results.filter((r) => r.error === null)).toHaveLength(1);
  expect(['FIN04', 'FIN05']).toContain(results.find((r) => r.error)?.error?.code);
  expect(await totals(a.c, invoice)).toMatchObject({ refunded: 30, balance: 0 });
});

testWithSupabase('two credit notes for the whole invoice at the same moment: only one is issued', async () => {
  const invoice = await postedInvoice(a);
  const first = await saveCreditNote(a, invoice, 132.5);
  const second = await saveCreditNote(a, invoice, 132.5);
  expect(first.error ?? second.error).toBeNull();
  const issue = (id: string) => a.c.rpc('finance_issue_credit_note', { target_org: a.orgId, target_note: id });
  const results = await Promise.all([issue(first.data), issue(second.data)]);
  expect(results.filter((r) => r.error === null)).toHaveLength(1);
  expect(results.find((r) => r.error)?.error?.code).toBe('FIN05');
  expect(await totals(a.c, invoice)).toMatchObject({ credited: 132.5, balance: 0, display_status: 'paid' });
});

testWithSupabase('another workspace cannot see or touch quotations, credit notes or refunds', async () => {
  const quotation = await sentQuotation(a);
  const invoice = await postedInvoice(a);
  expect((await receive(a, invoice, 132.5)).error).toBeNull();
  const note = await issuedCreditNote(a, invoice, 30);
  expect((await refund(a, { credit_note_id: note.id }, 10)).error).toBeNull();

  for (const table of [
    'finance_quotations', 'finance_quotation_lines', 'finance_quotation_totals',
    'finance_credit_notes', 'finance_credit_note_totals', 'finance_refunds',
  ]) {
    const { data } = await b.c.from(table).select('org_id').eq('org_id', a.orgId);
    expect(data ?? [], table).toEqual([]);
  }

  const save = await b.c.rpc('finance_save_quotation', {
    target_org: a.orgId,
    quotation: { customer_id: a.customer, quote_date: daysFromToday(0), valid_until: daysFromToday(30) },
    lines: [DESIGN],
  });
  expect(save.error?.code).toBe('42501');
  const convert = await b.c.rpc('finance_convert_quotation', { target_org: a.orgId, target_quotation: quotation.id });
  expect(convert.error?.code).toBe('FIN11');
  // B's own workspace, A's invoice: the invoice is not found there.
  expect((await saveCreditNote(b, invoice, 1)).error?.code).toBe('23503');
  expect((await refund(b, { invoice_id: invoice }, 1)).error?.code).toBe('FIN06');
  const { data: voided } = await b.c.from('finance_credit_notes').update({ status: 'void' }).eq('id', note.id).select('id');
  expect(voided ?? []).toEqual([]);
  const { data: answered } = await answer(b, quotation.id, 'accepted');
  expect(answered ?? []).toEqual([]);
});

testWithSupabase('a customer with quotations cannot stop being a customer', async () => {
  const { data: prospect } = await a.c
    .from('finance_contacts')
    .insert({ org_id: a.orgId, name: 'Prospect with a quotation', is_customer: true })
    .select('id')
    .single();
  const saved = await saveQuotation({ ...a, customer: prospect!.id });
  expect(saved.error, saved.error?.message).toBeNull();
  const untick = await a.c.from('finance_contacts').update({ is_customer: false, is_supplier: true }).eq('id', prospect!.id);
  expect(untick.error?.code).toBe('FIN08');
});

// Needs 20261022100100_bendahara_sales_followons_seed.sql: until the controller has applied it, this one test fails.
testWithSupabase('a demo viewer reads the seeded quotations, credit notes and refunds, and can write none', async () => {
  const c = client();
  const { error: authErr } = await c.auth.signInAnonymously();
  expect(authErr, authErr?.message).toBeNull();
  const { data: demoId, error } = await c.rpc('join_demo_org');
  expect(error, error?.message).toBeNull();

  const { data: quotations } = await c.from('finance_quotation_totals').select('id, quotation_no, display_status').eq('org_id', demoId);
  // Dates are relative to the day the seed ran, so Sent turns into Expired as time passes: only what cannot drift is asserted.
  expect((quotations ?? []).length).toBe(15);
  expect((quotations ?? []).filter((q) => q.display_status === 'accepted')).toHaveLength(6);
  expect((quotations ?? []).filter((q) => q.display_status === 'draft').every((q) => q.quotation_no === null)).toBe(true);

  const { data: notes } = await c.from('finance_credit_note_totals').select('id, credit_note_no, status, amount').eq('org_id', demoId);
  expect((notes ?? []).filter((n) => n.status === 'issued')).toHaveLength(8);
  expect((notes ?? []).filter((n) => n.status === 'issued').reduce((sum, n) => sum + Number(n.amount), 0)).toBe(3890);

  const { data: refunds } = await c.from('finance_refunds').select('status, amount, number').eq('org_id', demoId);
  expect((refunds ?? []).filter((r) => r.status === 'posted').reduce((sum, r) => sum + Number(r.amount), 0)).toBe(1770);
  expect((refunds ?? []).filter((r) => r.status === 'scheduled').reduce((sum, r) => sum + Number(r.amount), 0)).toBe(1000);
  expect((refunds ?? []).every((r) => (r.status === 'posted') === /^PV-\d+$/.test(r.number ?? ''))).toBe(true);

  // No seeded customer is refunded beyond their credit, and three invoices are still in credit.
  const { data: invoices } = await c.from('finance_invoice_totals').select('balance, status').eq('org_id', demoId).lt('balance', 0);
  expect((invoices ?? []).reduce((sum, i) => sum - Number(i.balance), 0)).toBe(1600);

  const sent = (quotations ?? []).find((q) => q.display_status !== 'draft')!;
  const save = await c.rpc('finance_save_quotation', {
    target_org: demoId,
    quotation: { customer_id: crypto.randomUUID(), quote_date: daysFromToday(0), valid_until: daysFromToday(30) },
    lines: [DESIGN],
  });
  expect(save.error?.code).toBe('42501');
  const convert = await c.rpc('finance_convert_quotation', { target_org: demoId, target_quotation: sent.id });
  expect(convert.error?.code).toBe('FIN11');
  const pay = await c.rpc('finance_record_refund', {
    target_org: demoId,
    refund: { credit_note_id: notes![0].id, account_id: crypto.randomUUID(), method: 'fpx', amount: 1 },
  });
  expect(pay.error?.code).toBe('42501');
  const { data: voided } = await c.from('finance_credit_notes').update({ status: 'void' }).eq('id', notes![0].id).select('id');
  expect(voided ?? []).toEqual([]);
});
```

- [ ] **Step 3: Do not run it**

This file talks to the hosted production database and leaves a user and two workspaces behind every time it runs, and it cannot pass until the controller has applied the migration. It is only type-checked here (Step 8). The controller runs it in Step 13.

- [ ] **Step 4: Write the schema migration**

Create `supabase/migrations/20261022100000_bendahara_sales_followons.sql`:

```sql
-- Bendahara sales follow-ons, database half (additive; safe to apply while the
-- previous code is still deployed).
--   * finance_quotations + finance_quotation_lines: quotations, numbered QT-.
--   * finance_invoices.quotation_id: the quotation an invoice was made from.
--   * finance_credit_notes: a credit against one posted invoice, numbered CN-.
--   * finance_allocations can now point at a credit note, and carries the
--     reason of a refund.
--   * A refund is money out allocated to an invoice or to a credit note.
--   * Views: finance_invoice_totals now takes issued credit notes off the
--     balance and adds posted refunds back; finance_quotation_totals,
--     finance_credit_note_totals and finance_refunds are new.
--   * Guards: the ones on invoices, allocations, payments and contacts are
--     replaced; quotations and credit notes get their own.
--   * Functions that save, send, convert, issue and refund in one transaction.
--
-- The code deployed while this is applied writes no quotation, no credit note
-- and no money out against an invoice. For everything it does write, every
-- guard below answers as it did before: same checks, same order, same codes.
-- With no credit note and no refund in the database, finance_invoice_totals
-- reads the same, row for row.
--
-- Nothing here is granted to service_role: every write is made by a signed-in
-- person through the authenticated role, and no worker touches these tables.

-- Fail fast instead of queueing behind a long transaction and stalling sign-ins.
set local lock_timeout = '5s';

-- ---- quotations -------------------------------------------------------------
-- status is what a person sets. Expired is derived from valid_until in
-- finance_quotation_totals, as Overdue is for an invoice.
create table public.finance_quotations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  customer_id uuid not null,
  -- QT-0001; given when the quotation is sent.
  quotation_no text,
  quote_date date not null default current_date,
  valid_until date not null,
  notes text,
  status text not null default 'draft' check (status in ('draft','sent','accepted','declined')),
  sent_at timestamptz,
  accepted_at timestamptz,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, quotation_no),
  constraint finance_quotations_dates_check check (valid_until >= quote_date),
  -- A draft has no number; a quotation that has been sent has one and says when.
  constraint finance_quotations_number_check
    check ((status = 'draft') = (quotation_no is null) and (status = 'draft' or sent_at is not null)),
  -- An accepted quotation says when; no other status carries that date.
  constraint finance_quotations_accepted_check check ((status = 'accepted') = (accepted_at is not null)),
  foreign key (org_id, customer_id) references public.finance_contacts(org_id, id)
);
create index finance_quotations_customer_idx on public.finance_quotations (org_id, customer_id);
create index finance_quotations_date_idx on public.finance_quotations (org_id, quote_date);

-- Same shape as finance_invoice_lines, position included.
create table public.finance_quotation_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  quotation_id uuid not null,
  position integer not null default 0,
  product_id uuid,
  description text not null,
  quantity numeric(14,3) not null check (quantity > 0),
  uom text,
  pack_size text,
  unit_price numeric(14,4) not null check (unit_price >= 0),
  sst_rate numeric(5,2) not null default 0 check (sst_rate between 0 and 100),
  amount numeric(14,2) generated always as (round(quantity * unit_price, 2)) stored,
  sst_amount numeric(14,2) generated always as (round(quantity * unit_price * sst_rate / 100, 2)) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (org_id, quotation_id) references public.finance_quotations(org_id, id) on delete cascade,
  foreign key (org_id, product_id) references public.finance_products(org_id, id)
);
create index finance_quotation_lines_quotation_idx on public.finance_quotation_lines (org_id, quotation_id);
create index finance_quotation_lines_product_idx on public.finance_quotation_lines (org_id, product_id);

-- ---- invoices: the quotation an invoice came from ---------------------------
alter table public.finance_invoices
  add column quotation_id uuid,
  add constraint finance_invoices_quotation_fkey
    foreign key (org_id, quotation_id) references public.finance_quotations(org_id, id);
-- One invoice per quotation. A void invoice does not count, so a quotation
-- whose invoice was voided (or whose draft invoice was deleted) can be
-- converted again.
create unique index finance_invoices_quotation_key
  on public.finance_invoices (org_id, quotation_id)
  where quotation_id is not null and status <> 'void';

-- ---- credit notes -----------------------------------------------------------
-- One amount against one invoice, as the design has it: no lines. The customer
-- is the invoice's customer.
create table public.finance_credit_notes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  invoice_id uuid not null,
  -- CN-0001; given when the credit note is issued.
  credit_note_no text,
  credit_date date not null default current_date,
  reason text not null default 'other'
    check (reason in ('returns','pricing_adjustment','overbilling','goodwill','other')),
  amount numeric(14,2) not null check (amount > 0),
  notes text,
  status text not null default 'draft' check (status in ('draft','issued','void')),
  issued_at timestamptz,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, credit_note_no),
  -- A draft has no number; an issued or void credit note has one, and an
  -- issued one says when it was issued.
  constraint finance_credit_notes_number_check
    check ((status = 'draft') = (credit_note_no is null) and (status <> 'issued' or issued_at is not null)),
  foreign key (org_id, invoice_id) references public.finance_invoices(org_id, id)
);
create index finance_credit_notes_invoice_idx on public.finance_credit_notes (org_id, invoice_id);
create index finance_credit_notes_date_idx on public.finance_credit_notes (org_id, credit_date);

do $$
declare t text;
begin
  foreach t in array array['finance_quotations','finance_quotation_lines','finance_credit_notes'] loop
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

-- ---- allocations: a bill, an invoice or a credit note -----------------------
-- reason is what a refund is for. It was a free column nothing wrote; it now
-- takes one of five words, or nothing.
alter table public.finance_allocations add column credit_note_id uuid;
alter table public.finance_allocations
  drop constraint finance_allocations_one_document_check,
  add constraint finance_allocations_one_document_check
    check (num_nonnulls(bill_id, invoice_id, credit_note_id) = 1),
  add constraint finance_allocations_reason_check
    check (reason is null or reason in ('order_cancelled','damaged_goods','wrong_item','overpayment','other')),
  add constraint finance_allocations_transaction_credit_note_key unique (transaction_id, credit_note_id),
  add constraint finance_allocations_credit_note_fkey
    foreign key (org_id, credit_note_id) references public.finance_credit_notes(org_id, id);
create index finance_allocations_credit_note_idx on public.finance_allocations (org_id, credit_note_id);

-- ---- views ------------------------------------------------------------------
-- The same columns in the same order as before, with credited and refunded
-- added at the end. The balance is the design's: total, less posted money in,
-- less issued credit notes, plus posted refunds. A refund counts whether it
-- was put against the invoice itself or against one of its credit notes.
-- A balance below zero is the customer in credit; the invoice then reads
-- 'paid', as it does at zero. The guards below read their figures from this
-- view, so there is one definition of what an invoice owes.
create or replace view public.finance_invoice_totals with (security_invoker = true) as
select
  i.id,
  i.org_id,
  i.customer_id,
  c.name as customer_name,
  i.invoice_no,
  i.invoice_date,
  i.due_date,
  i.notes,
  i.status,
  i.posted_at,
  i.einvoice_status,
  i.einvoice_uuid,
  i.created_by,
  i.created_at,
  i.updated_at,
  coalesce(l.subtotal, 0)::numeric(14,2) as subtotal,
  coalesce(l.sst, 0)::numeric(14,2) as sst,
  v.total::numeric(14,2) as total,
  v.paid::numeric(14,2) as paid,
  v.balance::numeric(14,2) as balance,
  case
    when i.status in ('draft','void') then i.status
    when v.total > 0 and v.balance <= 0 then 'paid'
    when i.due_date < current_date then 'overdue'
    else 'sent'
  end as display_status,
  v.credited::numeric(14,2) as credited,
  v.refunded::numeric(14,2) as refunded
from public.finance_invoices i
join public.finance_contacts c on c.org_id = i.org_id and c.id = i.customer_id
left join lateral (
  select sum(amount) as subtotal, sum(sst_amount) as sst
  from public.finance_invoice_lines
  where org_id = i.org_id and invoice_id = i.id
) l on true
left join lateral (
  -- Only posted money in counts as paid.
  select sum(a.amount) as paid
  from public.finance_allocations a
  join public.finance_transactions t on t.org_id = a.org_id and t.id = a.transaction_id
  where a.org_id = i.org_id and a.invoice_id = i.id and t.direction = 'in' and t.status = 'posted'
) p on true
left join lateral (
  -- Only issued credit notes reduce what is owed.
  select sum(n.amount) as credited
  from public.finance_credit_notes n
  where n.org_id = i.org_id and n.invoice_id = i.id and n.status = 'issued'
) k on true
left join lateral (
  -- Posted money out against the invoice itself.
  select sum(a.amount) as refunded
  from public.finance_allocations a
  join public.finance_transactions t on t.org_id = a.org_id and t.id = a.transaction_id
  where a.org_id = i.org_id and a.invoice_id = i.id and t.direction = 'out' and t.status = 'posted'
) ri on true
left join lateral (
  -- Posted money out against one of the invoice's credit notes.
  select sum(a.amount) as refunded
  from public.finance_credit_notes n
  join public.finance_allocations a on a.org_id = n.org_id and a.credit_note_id = n.id
  join public.finance_transactions t on t.org_id = a.org_id and t.id = a.transaction_id
  where n.org_id = i.org_id and n.invoice_id = i.id and t.direction = 'out' and t.status = 'posted'
) rn on true
cross join lateral (
  select
    coalesce(l.subtotal, 0) + coalesce(l.sst, 0) as total,
    coalesce(p.paid, 0) as paid,
    coalesce(k.credited, 0) as credited,
    coalesce(ri.refunded, 0) + coalesce(rn.refunded, 0) as refunded,
    coalesce(l.subtotal, 0) + coalesce(l.sst, 0) - coalesce(p.paid, 0) - coalesce(k.credited, 0)
      + coalesce(ri.refunded, 0) + coalesce(rn.refunded, 0) as balance
) v;
revoke all on public.finance_invoice_totals from anon, authenticated;
grant select on public.finance_invoice_totals to authenticated;

-- Expired uses the database's current_date (UTC), as Overdue does. invoice_id
-- and invoice_no are the invoice made from the quotation, if one stands (a
-- void invoice does not count); invoice_no is null while that invoice is a draft.
create view public.finance_quotation_totals with (security_invoker = true) as
select
  q.id,
  q.org_id,
  q.customer_id,
  c.name as customer_name,
  q.quotation_no,
  q.quote_date,
  q.valid_until,
  q.notes,
  q.status,
  q.sent_at,
  q.accepted_at,
  q.created_by,
  q.created_at,
  q.updated_at,
  coalesce(l.subtotal, 0)::numeric(14,2) as subtotal,
  coalesce(l.sst, 0)::numeric(14,2) as sst,
  (coalesce(l.subtotal, 0) + coalesce(l.sst, 0))::numeric(14,2) as total,
  case
    when q.status = 'sent' and q.valid_until < current_date then 'expired'
    else q.status
  end as display_status,
  x.id as invoice_id,
  x.invoice_no
from public.finance_quotations q
join public.finance_contacts c on c.org_id = q.org_id and c.id = q.customer_id
left join lateral (
  select sum(amount) as subtotal, sum(sst_amount) as sst
  from public.finance_quotation_lines
  where org_id = q.org_id and quotation_id = q.id
) l on true
left join public.finance_invoices x
  on x.org_id = q.org_id and x.quotation_id = q.id and x.status <> 'void';
revoke all on public.finance_quotation_totals from anon, authenticated;
grant select on public.finance_quotation_totals to authenticated;

-- A credit note with its invoice, its customer and what has been refunded
-- against the note itself (posted money out).
create view public.finance_credit_note_totals with (security_invoker = true) as
select
  n.id,
  n.org_id,
  n.invoice_id,
  i.invoice_no,
  i.customer_id,
  c.name as customer_name,
  n.credit_note_no,
  n.credit_date,
  n.reason,
  n.amount,
  n.notes,
  n.status,
  n.issued_at,
  n.created_by,
  n.created_at,
  n.updated_at,
  coalesce(r.refunded, 0)::numeric(14,2) as refunded
from public.finance_credit_notes n
join public.finance_invoices i on i.org_id = n.org_id and i.id = n.invoice_id
join public.finance_contacts c on c.org_id = i.org_id and c.id = i.customer_id
left join lateral (
  select sum(a.amount) as refunded
  from public.finance_allocations a
  join public.finance_transactions t on t.org_id = a.org_id and t.id = a.transaction_id
  where a.org_id = n.org_id and a.credit_note_id = n.id and t.direction = 'out' and t.status = 'posted'
) r on true;
revoke all on public.finance_credit_note_totals from anon, authenticated;
grant select on public.finance_credit_note_totals to authenticated;

-- One row per refund: money out against an invoice or against a credit note.
-- invoice_id is the invoice either way. Money out against a bill is not here
-- (it is in finance_payments_out, which joins bills and so never shows a
-- refund), and money in is not here.
create view public.finance_refunds with (security_invoker = true) as
select
  a.id as allocation_id,
  t.id as transaction_id,
  t.org_id,
  t.number,
  t.txn_date,
  t.method,
  a.amount,
  t.amount as transaction_amount,
  t.status,
  t.reference,
  coalesce(a.reason, 'other') as reason,
  t.notes,
  t.account_id,
  acc.name as account_name,
  i.id as invoice_id,
  i.invoice_no,
  n.id as credit_note_id,
  n.credit_note_no,
  i.customer_id,
  c.name as customer_name,
  t.created_at
from public.finance_allocations a
join public.finance_transactions t on t.org_id = a.org_id and t.id = a.transaction_id
left join public.finance_credit_notes n on n.org_id = a.org_id and n.id = a.credit_note_id
join public.finance_invoices i on i.org_id = a.org_id and i.id = coalesce(a.invoice_id, n.invoice_id)
join public.finance_contacts c on c.org_id = i.org_id and c.id = i.customer_id
join public.finance_accounts acc on acc.org_id = t.org_id and acc.id = t.account_id
where t.direction = 'out';
revoke all on public.finance_refunds from anon, authenticated;
grant select on public.finance_refunds to authenticated;

-- ---- guards -----------------------------------------------------------------
-- Each guard steps aside when its workspace is being deleted: by the time a
-- cascade reaches these rows the orgs row is already gone.

-- Refunds not yet paid out (draft, waiting for approval or scheduled) that are
-- held against an invoice, directly or through one of its credit notes. skip
-- leaves one allocation out: the row a guard is checking. Runs as the caller,
-- from inside the guards; the private schema is not reachable through the API.
create or replace function private.finance_refunds_held(target_org uuid, target_invoice uuid, skip uuid)
returns numeric
language sql
stable
security invoker
set search_path = ''
as $$
  select
    coalesce((
      select sum(a.amount)
      from public.finance_allocations a
      join public.finance_transactions x on x.org_id = a.org_id and x.id = a.transaction_id
      where a.org_id = target_org and a.invoice_id = target_invoice
        and (skip is null or a.id <> skip)
        and x.direction = 'out' and x.status in ('draft','pending_approval','scheduled')
    ), 0)
    + coalesce((
      select sum(a.amount)
      from public.finance_credit_notes n
      join public.finance_allocations a on a.org_id = n.org_id and a.credit_note_id = n.id
      join public.finance_transactions x on x.org_id = a.org_id and x.id = a.transaction_id
      where n.org_id = target_org and n.invoice_id = target_invoice
        and (skip is null or a.id <> skip)
        and x.direction = 'out' and x.status in ('draft','pending_approval','scheduled')
    ), 0);
$$;
revoke all on function private.finance_refunds_held(uuid, uuid, uuid) from public, anon;
grant execute on function private.finance_refunds_held(uuid, uuid, uuid) to authenticated;

create or replace function private.finance_quotation_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'a quotation starts as a draft' using errcode = 'FIN01';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    if old.status <> 'draft' and exists (select 1 from public.orgs where id = old.org_id) then
      raise exception 'a quotation that has been sent cannot be deleted' using errcode = 'FIN01';
    end if;
    return old;
  end if;

  -- A deleted user is cleared from created_by by its foreign key, whatever
  -- the quotation's status. Nothing else may change with it.
  if new.status = old.status
     and (to_jsonb(new) - 'created_by') = (to_jsonb(old) - 'created_by')
     and (new.created_by is null or new.created_by = old.created_by) then
    return new;
  end if;

  if old.status = 'draft' then
    if new.status not in ('draft','sent') then
      raise exception 'a quotation is sent before it is accepted or declined' using errcode = 'FIN01';
    end if;
    if new.status = 'sent' and coalesce((
      select sum(amount + sst_amount) from public.finance_quotation_lines
      where org_id = new.org_id and quotation_id = new.id
    ), 0) <= 0 then
      raise exception 'a quotation needs an amount before it is sent' using errcode = 'FIN10';
    end if;
    return new;
  end if;

  -- Sent, accepted or declined: what the customer was given is locked. Only
  -- their answer is recorded, and it can be corrected from one to the other.
  if (to_jsonb(new) - 'status' - 'accepted_at' - 'updated_at')
     is distinct from (to_jsonb(old) - 'status' - 'accepted_at' - 'updated_at') then
    raise exception 'a quotation that has been sent cannot be changed' using errcode = 'FIN01';
  end if;
  if new.status = old.status or new.status not in ('accepted','declined') then
    raise exception 'a quotation that has been sent cannot be changed' using errcode = 'FIN01';
  end if;
  if exists (
    select 1 from public.finance_invoices
    where org_id = old.org_id and quotation_id = old.id and status <> 'void'
  ) then
    raise exception 'the quotation has an invoice' using errcode = 'FIN13';
  end if;
  return new;
end $$;

create trigger finance_quotation_guard
  before insert or update or delete on public.finance_quotations
  for each row execute function private.finance_quotation_guard();

create or replace function private.finance_quotation_line_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  s text;
begin
  -- The workspace is being deleted: its quotations and their lines all go.
  if tg_op = 'DELETE' and not exists (select 1 from public.orgs where id = old.org_id) then
    return old;
  end if;
  if tg_op <> 'INSERT' then
    select status into s from public.finance_quotations where org_id = old.org_id and id = old.quotation_id for share;
    -- No parent row: the quotation itself is being deleted, and its lines go with it.
    if s is not null and s <> 'draft' then
      raise exception 'the lines of a quotation that has been sent cannot be changed' using errcode = 'FIN01';
    end if;
  end if;
  if tg_op <> 'DELETE' then
    select status into s from public.finance_quotations where org_id = new.org_id and id = new.quotation_id for share;
    if s is not null and s <> 'draft' then
      raise exception 'the lines of a quotation that has been sent cannot be changed' using errcode = 'FIN01';
    end if;
    return new;
  end if;
  return old;
end $$;

create trigger finance_quotation_line_guard
  before insert or update or delete on public.finance_quotation_lines
  for each row execute function private.finance_quotation_line_guard();

-- A credit note is written against a posted invoice, and all the issued
-- credit notes of an invoice together never exceed the invoice's total: more
-- cannot be credited than was billed. What was paid does not limit it; a
-- credit note on a paid invoice leaves the customer in credit, and a refund
-- pays that out.
create or replace function private.finance_credit_note_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  doc_status text;
  pos record;
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' and exists (select 1 from public.orgs where id = old.org_id) then
      raise exception 'an issued credit note cannot be deleted' using errcode = 'FIN01';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'a credit note starts as a draft' using errcode = 'FIN01';
    end if;
  else
    -- A deleted user is cleared from created_by by its foreign key, whatever
    -- the credit note's status. Nothing else may change with it.
    if new.status = old.status
       and (to_jsonb(new) - 'created_by') = (to_jsonb(old) - 'created_by')
       and (new.created_by is null or new.created_by = old.created_by) then
      return new;
    end if;

    if old.status = 'issued' and new.status = 'void' then
      if (to_jsonb(new) - 'status' - 'updated_at') is distinct from (to_jsonb(old) - 'status' - 'updated_at') then
        raise exception 'an issued credit note cannot be changed' using errcode = 'FIN01';
      end if;
      if exists (
        select 1
        from public.finance_allocations a
        join public.finance_transactions t on t.org_id = a.org_id and t.id = a.transaction_id
        where a.org_id = old.org_id and a.credit_note_id = old.id
          and t.status in ('draft','pending_approval','scheduled','posted')
      ) then
        raise exception 'the credit note has refunds' using errcode = 'FIN02';
      end if;
      -- Lock the invoice, so a refund against it at the same moment is checked after this.
      perform 1 from public.finance_invoices where org_id = old.org_id and id = old.invoice_id for update;
      select total, paid, credited, refunded into pos
      from public.finance_invoice_totals where org_id = old.org_id and id = old.invoice_id;
      -- Refunds against the invoice itself lean on this credit too: without
      -- the note, they must still fit in what the customer is in credit.
      if pos.refunded + private.finance_refunds_held(old.org_id, old.invoice_id, null)
         > greatest(pos.paid + pos.credited - old.amount - pos.total, 0) then
        raise exception 'refunds on the invoice depend on this credit note' using errcode = 'FIN02';
      end if;
      return new;
    end if;

    if old.status <> 'draft' then
      raise exception 'an issued credit note cannot be changed' using errcode = 'FIN01';
    end if;
    if new.status = 'void' then
      raise exception 'a draft credit note is deleted, not voided' using errcode = 'FIN01';
    end if;
  end if;

  -- A draft being written, or a draft being issued. Lock the invoice, so two
  -- credit notes at the same moment are checked one after the other.
  select status into doc_status from public.finance_invoices
  where org_id = new.org_id and id = new.invoice_id for update;
  if not found then
    -- Not there, or not this caller's to change: the foreign key or row-level
    -- security refuses the write and says which.
    return new;
  end if;
  if doc_status <> 'posted' then
    raise exception 'a credit note can only go against a posted invoice' using errcode = 'FIN04';
  end if;
  select total, credited into pos
  from public.finance_invoice_totals where org_id = new.org_id and id = new.invoice_id;
  if new.amount > pos.total - pos.credited then
    raise exception 'more than the invoice has left to credit' using errcode = 'FIN05';
  end if;
  return new;
end $$;

create trigger finance_credit_note_guard
  before insert or update or delete on public.finance_credit_notes
  for each row execute function private.finance_credit_note_guard();

-- Replaces the guard on invoices. Everything it refused before it refuses the
-- same way, in the same order. Two rules are new, and neither can be met by a
-- row that exists today: quotation_id may only name an accepted quotation of
-- the same customer (FIN04), and an invoice with a credit note that is a draft
-- or issued cannot be voided (FIN12).
create or replace function private.finance_invoice_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'an invoice starts as a draft' using errcode = 'FIN01';
    end if;
    if new.quotation_id is not null and not exists (
      select 1 from public.finance_quotations q
      where q.org_id = new.org_id and q.id = new.quotation_id
        and q.status = 'accepted' and q.customer_id = new.customer_id
    ) then
      raise exception 'an invoice is made from an accepted quotation of the same customer' using errcode = 'FIN04';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    if old.status <> 'draft' and exists (select 1 from public.orgs where id = old.org_id) then
      raise exception 'a posted invoice cannot be deleted' using errcode = 'FIN01';
    end if;
    return old;
  end if;

  -- A deleted user is cleared from created_by by its foreign key, whatever
  -- the invoice's status. Nothing else may change with it.
  if new.status = old.status
     and (to_jsonb(new) - 'created_by') = (to_jsonb(old) - 'created_by')
     and (new.created_by is null or new.created_by = old.created_by) then
    return new;
  end if;

  if old.status = 'draft' then
    if new.status not in ('draft','posted') then
      raise exception 'a draft invoice is deleted, not voided' using errcode = 'FIN01';
    end if;
    if new.status = 'posted' and coalesce((
      select sum(amount + sst_amount) from public.finance_invoice_lines
      where org_id = new.org_id and invoice_id = new.id
    ), 0) <= 0 then
      raise exception 'an invoice needs an amount before it is posted' using errcode = 'FIN10';
    end if;
    -- A draft may be tied to a quotation, or untied; it is checked when the tie is made.
    if new.quotation_id is not null and new.quotation_id is distinct from old.quotation_id and not exists (
      select 1 from public.finance_quotations q
      where q.org_id = new.org_id and q.id = new.quotation_id
        and q.status = 'accepted' and q.customer_id = new.customer_id
    ) then
      raise exception 'an invoice is made from an accepted quotation of the same customer' using errcode = 'FIN04';
    end if;
    return new;
  end if;

  -- A person records the e-Invois status after posting; nothing else moves.
  if old.status = 'posted' and new.status = 'posted' then
    if (to_jsonb(new) - 'einvoice_status' - 'einvoice_uuid' - 'updated_at')
       is distinct from (to_jsonb(old) - 'einvoice_status' - 'einvoice_uuid' - 'updated_at') then
      raise exception 'a posted invoice cannot be changed' using errcode = 'FIN01';
    end if;
    return new;
  end if;

  if old.status = 'posted' and new.status = 'void' then
    if (to_jsonb(new) - 'status' - 'updated_at') is distinct from (to_jsonb(old) - 'status' - 'updated_at') then
      raise exception 'a posted invoice cannot be changed' using errcode = 'FIN01';
    end if;
    -- Money in or a refund, against the invoice itself.
    if exists (
      select 1
      from public.finance_allocations a
      join public.finance_transactions t on t.org_id = a.org_id and t.id = a.transaction_id
      where a.org_id = old.org_id and a.invoice_id = old.id
        and t.status in ('draft','pending_approval','scheduled','posted')
    ) then
      raise exception 'the invoice has payments' using errcode = 'FIN02';
    end if;
    if exists (
      select 1 from public.finance_credit_notes
      where org_id = old.org_id and invoice_id = old.id and status in ('draft','issued')
    ) then
      raise exception 'the invoice has credit notes' using errcode = 'FIN12';
    end if;
    return new;
  end if;

  raise exception 'a posted invoice cannot be changed' using errcode = 'FIN01';
end $$;

-- Replaces the guard on allocations. A bill is handled by the same checks in
-- the same order as before: posted payment (FIN09), wrong direction (FIN04),
-- split above the payment (FIN03), bill not posted (FIN04, under a row lock),
-- more than is owed (FIN05). Money in against an invoice is refused for the
-- same reasons as before; what it may take is now read from
-- finance_invoice_totals, so the guard and the screens cannot disagree.
--
-- New: money out against an invoice or a credit note is a refund. It needs
-- the customer to be in credit on that invoice (FIN04 when they are not, as
-- money out against an invoice always was), and it can be no more than that
-- credit, counting refunds that are waiting to be paid out (FIN05).
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
begin
  -- The workspace is being deleted: its payments and their splits all go.
  if tg_op = 'DELETE' and not exists (select 1 from public.orgs where id = old.org_id) then
    return old;
  end if;
  if tg_op <> 'INSERT' then
    select status into t from public.finance_transactions where org_id = old.org_id and id = old.transaction_id;
    -- No parent row: the payment itself is being deleted.
    if found and t.status in ('posted','void') then
      raise exception 'the split of a posted payment cannot be changed' using errcode = 'FIN09';
    end if;
    if tg_op = 'DELETE' then return old; end if;
  end if;

  select amount, status, direction into t from public.finance_transactions where org_id = new.org_id and id = new.transaction_id;
  has_txn := found;
  if has_txn and t.status in ('posted','void') then
    raise exception 'the split of a posted payment cannot be changed' using errcode = 'FIN09';
  end if;

  -- A credit note takes only money out. An invoice takes money in (a
  -- payment) or money out (a refund). Everything else is a bill and takes
  -- money out. (A row naming two documents, or none, is refused by the
  -- table's check constraint, which runs after this trigger.)
  if new.bill_id is null and new.credit_note_id is not null then
    if has_txn and t.direction <> 'out' then
      raise exception 'only money out refunds a credit note' using errcode = 'FIN04';
    end if;
  elsif new.bill_id is null and new.invoice_id is not null then
    null;
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

-- Replaces the guard on payments. Everything it refused before it refuses the
-- same way, in the same order. One rule is new and concerns only money out
-- that is split across invoices or credit notes, which is to say a refund: at
-- the moment it is paid out, the refunds waiting on each of its invoices must
-- still fit in what the customer is in credit there (FIN05). A refund is
-- checked when it is recorded; this second look is for a refund that was
-- scheduled and then lost its footing, because the payment it refunds was
-- voided in between. A payment out against bills has no such rows, so for it
-- the loop does nothing.
create or replace function private.finance_transaction_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  allocated numeric;
  r record;
  owing numeric;
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

  -- A refund being paid out: look again at each invoice it refunds.
  if new.status = 'posted' and new.direction = 'out' then
    for r in
      select coalesce(a.invoice_id, n.invoice_id) as invoice_id
      from public.finance_allocations a
      left join public.finance_credit_notes n on n.org_id = a.org_id and n.id = a.credit_note_id
      where a.org_id = old.org_id and a.transaction_id = old.id and a.bill_id is null
      group by 1
    loop
      select balance into owing from public.finance_invoice_totals
      where org_id = old.org_id and id = r.invoice_id;
      -- This payment is not posted yet, so it is still among the refunds held.
      if private.finance_refunds_held(old.org_id, r.invoice_id, null) > greatest(-owing, 0) then
        raise exception 'more than the customer is in credit' using errcode = 'FIN05';
      end if;
    end loop;
  end if;
  return new;
end $$;

create or replace function private.finance_contact_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.is_supplier and not new.is_supplier
     and exists (select 1 from public.supplier_bills where org_id = old.org_id and supplier_id = old.id) then
    raise exception 'the contact has bills' using errcode = 'FIN07';
  end if;
  if old.is_customer and not new.is_customer
     and (exists (select 1 from public.finance_invoices where org_id = old.org_id and customer_id = old.id)
       or exists (select 1 from public.finance_quotations where org_id = old.org_id and customer_id = old.id)) then
    raise exception 'the contact has invoices or quotations' using errcode = 'FIN08';
  end if;
  return new;
end $$;

revoke all on function private.finance_quotation_guard() from public, anon, authenticated;
revoke all on function private.finance_quotation_line_guard() from public, anon, authenticated;
revoke all on function private.finance_credit_note_guard() from public, anon, authenticated;
revoke all on function private.finance_invoice_guard() from public, anon, authenticated;
revoke all on function private.finance_allocation_guard() from public, anon, authenticated;
revoke all on function private.finance_transaction_guard() from public, anon, authenticated;
revoke all on function private.finance_contact_guard() from public, anon, authenticated;

-- ---- functions --------------------------------------------------------------
-- All run as the caller, so RLS decides who may write and to which workspace.

-- Creates a draft quotation, or replaces a draft's header and lines. Returns its id.
create or replace function public.finance_save_quotation(target_org uuid, quotation jsonb, lines jsonb)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  qid uuid := nullif(quotation->>'id', '')::uuid;
  n integer;
begin
  if jsonb_typeof(lines) is distinct from 'array' or jsonb_array_length(lines) = 0 then
    raise exception 'a quotation needs at least one line' using errcode = 'FIN10';
  end if;

  if qid is null then
    insert into public.finance_quotations (org_id, customer_id, quote_date, valid_until, notes, status)
    values (
      target_org,
      (quotation->>'customer_id')::uuid,
      (quotation->>'quote_date')::date,
      (quotation->>'valid_until')::date,
      nullif(quotation->>'notes', ''),
      'draft'
    )
    returning id into qid;
  else
    update public.finance_quotations
       set customer_id = (quotation->>'customer_id')::uuid,
           quote_date = (quotation->>'quote_date')::date,
           valid_until = (quotation->>'valid_until')::date,
           notes = nullif(quotation->>'notes', ''),
           updated_at = now()
     where org_id = target_org and id = qid;
    get diagnostics n = row_count;
    if n = 0 then
      raise exception 'the quotation no longer exists' using errcode = 'FIN11';
    end if;
    delete from public.finance_quotation_lines where org_id = target_org and quotation_id = qid;
  end if;

  insert into public.finance_quotation_lines
    (org_id, quotation_id, position, product_id, description, quantity, uom, pack_size, unit_price, sst_rate)
  select
    target_org, qid,
    l.ord::integer,
    nullif(l.line->>'product_id', '')::uuid,
    l.line->>'description',
    (l.line->>'quantity')::numeric,
    nullif(l.line->>'uom', ''),
    nullif(l.line->>'pack_size', ''),
    (l.line->>'unit_price')::numeric,
    coalesce((l.line->>'sst_rate')::numeric, 0)
  from jsonb_array_elements(lines) with ordinality as l(line, ord);

  return qid;
end $$;

-- Marks a draft quotation as sent and returns its number. Nothing is emailed:
-- "sent" records that the customer has been given it. The number is taken
-- here, so a failed send does not use one up.
create or replace function public.finance_send_quotation(target_org uuid, target_quotation uuid)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  q record;
  total numeric;
  no text;
begin
  select status, quotation_no into q from public.finance_quotations
  where org_id = target_org and id = target_quotation for update;
  if not found then
    raise exception 'the quotation no longer exists' using errcode = 'FIN11';
  end if;
  if q.status <> 'draft' then
    raise exception 'the quotation has already been sent' using errcode = 'FIN01';
  end if;
  select coalesce(sum(amount + sst_amount), 0) into total
  from public.finance_quotation_lines where org_id = target_org and quotation_id = target_quotation;
  if total <= 0 then
    raise exception 'a quotation needs an amount before it is sent' using errcode = 'FIN10';
  end if;

  no := coalesce(q.quotation_no, public.finance_next_number(target_org, 'quotation'));
  update public.finance_quotations
     set status = 'sent', quotation_no = no, sent_at = now(), updated_at = now()
   where org_id = target_org and id = target_quotation;
  return no;
end $$;

-- Makes a draft invoice from an accepted quotation: the same customer, notes
-- and lines, dated today and due after the customer's payment terms. Returns
-- the invoice's id. A quotation has one invoice at a time; once that invoice
-- is voided, or deleted while still a draft, the quotation can be converted again.
create or replace function public.finance_convert_quotation(target_org uuid, target_quotation uuid)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  q record;
  terms integer;
  iid uuid;
begin
  select status, customer_id, notes into q from public.finance_quotations
  where org_id = target_org and id = target_quotation for update;
  if not found then
    raise exception 'the quotation no longer exists' using errcode = 'FIN11';
  end if;
  if q.status <> 'accepted' then
    raise exception 'only an accepted quotation becomes an invoice' using errcode = 'FIN04';
  end if;
  if exists (
    select 1 from public.finance_invoices
    where org_id = target_org and quotation_id = target_quotation and status <> 'void'
  ) then
    raise exception 'the quotation has an invoice' using errcode = 'FIN13';
  end if;

  select payment_terms_days into terms from public.finance_contacts
  where org_id = target_org and id = q.customer_id;

  insert into public.finance_invoices (org_id, customer_id, invoice_date, due_date, notes, status, quotation_id)
  values (target_org, q.customer_id, current_date, current_date + coalesce(terms, 30), q.notes, 'draft', target_quotation)
  returning id into iid;

  insert into public.finance_invoice_lines
    (org_id, invoice_id, position, product_id, description, quantity, uom, pack_size, unit_price, sst_rate)
  select target_org, iid, l.position, l.product_id, l.description, l.quantity, l.uom, l.pack_size, l.unit_price, l.sst_rate
  from public.finance_quotation_lines l
  where l.org_id = target_org and l.quotation_id = target_quotation
  order by l.position, l.id;

  return iid;
end $$;

-- Creates a draft credit note, or replaces a draft. Returns its id.
create or replace function public.finance_save_credit_note(target_org uuid, note jsonb)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  nid uuid := nullif(note->>'id', '')::uuid;
  n integer;
begin
  if nid is null then
    insert into public.finance_credit_notes (org_id, invoice_id, credit_date, reason, amount, notes, status)
    values (
      target_org,
      (note->>'invoice_id')::uuid,
      coalesce((note->>'credit_date')::date, current_date),
      coalesce(nullif(note->>'reason', ''), 'other'),
      (note->>'amount')::numeric,
      nullif(note->>'notes', ''),
      'draft'
    )
    returning id into nid;
  else
    update public.finance_credit_notes
       set invoice_id = (note->>'invoice_id')::uuid,
           credit_date = coalesce((note->>'credit_date')::date, current_date),
           reason = coalesce(nullif(note->>'reason', ''), 'other'),
           amount = (note->>'amount')::numeric,
           notes = nullif(note->>'notes', ''),
           updated_at = now()
     where org_id = target_org and id = nid;
    get diagnostics n = row_count;
    if n = 0 then
      raise exception 'the credit note no longer exists' using errcode = 'FIN11';
    end if;
  end if;
  return nid;
end $$;

-- Issues a draft credit note and returns its number. From this moment it
-- reduces what the invoice owes. The number is taken here, so a failed issue
-- does not use one up.
create or replace function public.finance_issue_credit_note(target_org uuid, target_note uuid)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  c record;
  no text;
begin
  select status, credit_note_no into c from public.finance_credit_notes
  where org_id = target_org and id = target_note for update;
  if not found then
    raise exception 'the credit note no longer exists' using errcode = 'FIN11';
  end if;
  if c.status <> 'draft' then
    raise exception 'the credit note is already issued' using errcode = 'FIN01';
  end if;

  no := coalesce(c.credit_note_no, public.finance_next_number(target_org, 'credit_note'));
  update public.finance_credit_notes
     set status = 'issued', credit_note_no = no, issued_at = now(), updated_at = now()
   where org_id = target_org and id = target_note;
  return no;
end $$;

-- Records one refund: money out to a customer against one invoice, or against
-- one credit note. status is 'posted' (paid out now, numbered PV-) or
-- 'scheduled' (pending: not yet money out). Returns its id. A pending refund
-- is paid out by finance_mark_payment_paid, as a scheduled payment to a
-- supplier is.
create or replace function public.finance_record_refund(target_org uuid, refund jsonb)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  tid uuid;
  inv uuid := nullif(refund->>'invoice_id', '')::uuid;
  note uuid := nullif(refund->>'credit_note_id', '')::uuid;
  customer uuid;
  -- Rounded to the sen first, as the allocation is when it is stored, so the
  -- payment is exactly its split.
  amt numeric := round((refund->>'amount')::numeric, 2);
  want text := coalesce(refund->>'status', 'posted');
  no text;
begin
  if want not in ('posted','scheduled') then
    raise exception 'unknown refund status %', want using errcode = '22023';
  end if;
  if num_nonnulls(inv, note) <> 1 then
    raise exception 'a refund is against one invoice or one credit note' using errcode = 'FIN06';
  end if;
  if note is not null then
    select i.customer_id into customer
    from public.finance_credit_notes n
    join public.finance_invoices i on i.org_id = n.org_id and i.id = n.invoice_id
    where n.org_id = target_org and n.id = note;
  else
    select customer_id into customer from public.finance_invoices where org_id = target_org and id = inv;
  end if;
  if customer is null then
    raise exception 'no invoice or credit note was found' using errcode = 'FIN06';
  end if;

  insert into public.finance_transactions
    (org_id, direction, account_id, txn_date, amount, method, reference, contact_id, notes, status)
  values (
    target_org, 'out',
    (refund->>'account_id')::uuid,
    coalesce((refund->>'txn_date')::date, current_date),
    amt,
    refund->>'method',
    nullif(refund->>'reference', ''),
    customer,
    nullif(refund->>'notes', ''),
    'draft'
  )
  returning id into tid;

  insert into public.finance_allocations (org_id, transaction_id, invoice_id, credit_note_id, amount, reason)
  values (target_org, tid, inv, note, amt, coalesce(nullif(refund->>'reason', ''), 'other'));

  if want = 'posted' then
    no := public.finance_next_number(target_org, 'voucher');
  end if;
  update public.finance_transactions
     set status = want, number = no, updated_at = now()
   where org_id = target_org and id = tid;
  return tid;
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.finance_save_quotation(uuid, jsonb, jsonb)',
    'public.finance_send_quotation(uuid, uuid)',
    'public.finance_convert_quotation(uuid, uuid)',
    'public.finance_save_credit_note(uuid, jsonb)',
    'public.finance_issue_credit_note(uuid, uuid)',
    'public.finance_record_refund(uuid, jsonb)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
```

- [ ] **Step 5: Write the seed migration**

Create `supabase/migrations/20261022100100_bendahara_sales_followons_seed.sql`:

```sql
-- Demo data for Bendahara Quotations, Credit Notes and Refunds in the shared
-- demo org, built from what the three mock-up screens showed. Dates are
-- relative to today. Skips when the demo org is missing or already has a
-- quotation or a credit note, and touches no other workspace.
--
-- Nothing is disabled: every row goes in the way the guards allow. A
-- quotation is inserted as a draft, given its line, sent with its number, and
-- then accepted or declined. A credit note is inserted as a draft against an
-- invoice the invoices seed posted, then issued with its number. A refund is
-- a draft payment out, split against its credit note or invoice, then paid
-- out with its number or left scheduled. The functions are not used because
-- they take their numbers from finance_next_number, which answers only to a
-- signed-in editor of the workspace, and a migration has no signed-in user.
--
-- The credit notes hang off the demo's seeded invoices. One of them is
-- against an invoice that is still owed (INV-1037), so the demo's receivable
-- goes down by its RM 520.00; the rest are against paid invoices and leave
-- those customers in credit until refunded. A credit note or refund whose
-- invoice is not there, or is not posted, is left out.

do $$
declare
  demo uuid;
  bank uuid;
  cash uuid;
  customer uuid;
  qid uuid;
  inv uuid;
  note uuid;
  txn uuid;
  pv integer;
  r record;
begin
  select id into demo from public.orgs where slug = 'rimba-ventures-demo';
  if demo is null
     or exists (select 1 from public.finance_quotations where org_id = demo)
     or exists (select 1 from public.finance_credit_notes where org_id = demo) then
    return;
  end if;

  -- The accounts refunds are paid from. Seeding them again changes nothing if they are there.
  perform private.finance_seed_accounts(demo);
  select id into bank from public.finance_accounts
   where org_id = demo and kind = 'bank'
   order by (lower(name) = 'main bank') desc, created_at, id limit 1;
  select id into cash from public.finance_accounts
   where org_id = demo and kind = 'cash'
   order by (lower(name) = 'cash in hand') desc, created_at, id limit 1;
  cash := coalesce(cash, bank);
  bank := coalesce(bank, cash);
  if bank is null then
    raise exception 'the demo org has no account to pay refunds from';
  end if;

  -- Customers: the same eight the invoices seed uses. One that is already
  -- there is ticked as a customer; one that is missing is added.
  update public.finance_contacts
     set is_customer = true, updated_at = now()
   where org_id = demo and not is_customer
     and name in ('Aisyah Trading', 'Zaki Enterprise', 'Nurul Boutique', 'Lim Hardware Sdn Bhd',
                  'Siti Decor', 'Nusantara Logistics', 'Langkawi Fresh', 'Seri Mutiara Enterprise');
  insert into public.finance_contacts (org_id, name, is_customer, email, payment_terms_days)
  select demo, v.name, true, v.email, v.terms
  from (values
    ('Aisyah Trading', 'accounts@aisyahtrading.my', 30),
    ('Zaki Enterprise', 'zaki@zakient.my', 30),
    ('Nurul Boutique', 'hello@nurulboutique.my', 7),
    ('Lim Hardware Sdn Bhd', 'sales@limhardware.com.my', 30),
    ('Siti Decor', 'akaun@sitidecor.my', 30),
    ('Nusantara Logistics', 'orders@nusantara.my', 30),
    ('Langkawi Fresh', 'billing@langkawifresh.my', 30),
    ('Seri Mutiara Enterprise', 'admin@serimutiara.my', 30)
  ) as v(name, email, terms)
  where not exists (
    select 1 from public.finance_contacts c where c.org_id = demo and c.name = v.name
  );

  -- ---- quotations: a draft, its one line, sent, then the customer's answer ---
  -- no is null for the quotation that stays a draft. days_ago and valid_in are
  -- counted from today; valid_in below zero is a quotation past its date, which
  -- reads Expired while it is still only sent. answered_ago is how many days
  -- ago an accepted quotation was accepted.
  for r in
    select * from (values
      (null,      'Nurul Boutique',            1,  29, 'Seasonal lookbook, 24 pages',       1::numeric, 2400::numeric, 'draft',    null::integer),
      ('QT-0227', 'Seri Mutiara Enterprise',   2,  28, 'Website refresh, phase 2',          1,          6200,          'sent',     null),
      ('QT-0226', 'Langkawi Fresh',            3,  27, 'Loyalty programme set-up',          1,          4800,          'sent',     null),
      ('QT-0225', 'Aisyah Trading',            4,  26, 'Year-end campaign',                 1,         12000,          'accepted', 2),
      ('QT-0224', 'Zaki Enterprise',           6,  24, 'Second outlet point-of-sale',       1,          9500,          'sent',     null),
      ('QT-0223', 'Lim Hardware Sdn Bhd',     11,  19, 'Product catalogue, 2027 edition',   1,          7500,          'accepted', 8),
      ('QT-0222', 'Siti Decor',               28, -13, 'Showroom lighting plan',            1,          3200,          'sent',     null),
      ('QT-0221', 'Nusantara Logistics',      38, -23, 'Driver training, 2 days',           2,          2900,          'sent',     null),
      ('QT-0220', 'Aisyah Trading',           20,  10, 'Social media retainer, 3 months',   3,          2800,          'accepted', 15),
      ('QT-0219', 'Langkawi Fresh',           24,   6, 'Delivery app prototype',            1,          3600,          'declined', null),
      -- Earlier months, so the trend chart has a shape.
      ('QT-0212', 'Aisyah Trading',           58, -28, 'Mid-year campaign',                 1,         18000,          'accepted', 50),
      ('QT-0208', 'Zaki Enterprise',          89, -59, 'Stock system review',               1,          9000,          'declined', null),
      ('QT-0205', 'Siti Decor',              119, -89, 'Showroom refit drawings',           1,         14000,          'accepted', 110),
      ('QT-0203', 'Lim Hardware Sdn Bhd',    150, -120, 'Trade counter signage',            1,         11000,          'accepted', 141),
      ('QT-0201', 'Nusantara Logistics',     180, -150, 'Warehouse layout study',           1,          7500,          'sent',     null)
    ) as v(no, customer_name, days_ago, valid_in, description, quantity, unit_price, status, answered_ago)
  loop
    select id into customer from public.finance_contacts
     where org_id = demo and name = r.customer_name
     order by created_at, id limit 1;

    insert into public.finance_quotations (org_id, customer_id, quote_date, valid_until, status)
    values (demo, customer, current_date - r.days_ago, current_date + r.valid_in, 'draft')
    returning id into qid;
    insert into public.finance_quotation_lines (org_id, quotation_id, position, description, quantity, uom, unit_price)
    values (demo, qid, 1, r.description, r.quantity, 'job', r.unit_price);

    if r.no is not null then
      update public.finance_quotations
         set status = 'sent', quotation_no = r.no, sent_at = now() - make_interval(days => r.days_ago), updated_at = now()
       where id = qid;
    end if;
    if r.status in ('accepted', 'declined') then
      update public.finance_quotations
         set status = r.status,
             accepted_at = case when r.status = 'accepted' then now() - make_interval(days => r.answered_ago) end,
             updated_at = now()
       where id = qid;
    end if;
  end loop;

  -- ---- credit notes: a draft against a posted invoice, then issued -----------
  -- no is null for the credit note that stays a draft.
  for r in
    select * from (values
      (null,      'INV-1041', 1, 'pricing_adjustment', 300::numeric),
      ('CN-0037', 'INV-1037', 2, 'goodwill',           520),
      ('CN-0036', 'INV-1032', 3, 'returns',            900),
      ('CN-0035', 'INV-1036', 2, 'returns',            180),
      ('CN-0034', 'INV-1042', 1, 'returns',            240),
      ('CN-0033', 'INV-1039', 4, 'overbilling',        450),
      ('CN-0032', 'INV-1038', 4, 'pricing_adjustment', 600),
      ('CN-0031', 'INV-1033', 3, 'returns',            680),
      ('CN-0030', 'INV-1030', 6, 'overbilling',        320)
    ) as v(no, invoice_no, days_ago, reason, amount)
  loop
    select id into inv from public.finance_invoices
     where org_id = demo and invoice_no = r.invoice_no and status = 'posted';
    continue when inv is null;

    insert into public.finance_credit_notes (org_id, invoice_id, credit_date, reason, amount, status)
    values (demo, inv, current_date - r.days_ago, r.reason, r.amount, 'draft')
    returning id into note;
    if r.no is not null then
      update public.finance_credit_notes
         set status = 'issued', credit_note_no = r.no, issued_at = now() - make_interval(days => r.days_ago), updated_at = now()
       where id = note;
    end if;
  end loop;

  -- ---- refunds: a draft payment out, its split, then paid out or left pending -
  -- Vouchers are numbered after any the demo already has.
  select greatest(
           coalesce((select next_number from public.finance_sequences where org_id = demo and doc_type = 'voucher'), 1),
           coalesce((select max(substring(number from '^PV-([0-9]{1,9})$')::integer) + 1
                       from public.finance_transactions where org_id = demo and number ~ '^PV-[0-9]{1,9}$'), 1))
    into pv;

  -- against is a credit note's number, or an invoice's for a refund put against the invoice itself.
  for r in
    select * from (values
      ('CN-0036',  2, 'bank_transfer', 'order_cancelled', 900::numeric, 'posted'),
      ('CN-0035',  1, 'fpx',           'damaged_goods',   180,          'posted'),
      ('CN-0034',  0, 'fpx',           'damaged_goods',   240,          'posted'),
      ('INV-1039', 3, 'bank_transfer', 'overpayment',     450,          'posted'),
      ('CN-0031',  0, 'duitnow',       'wrong_item',      680,          'scheduled'),
      ('CN-0030',  1, 'bank_transfer', 'overpayment',     320,          'scheduled')
    ) as v(against, days_ago, method, reason, amount, status)
  loop
    note := null;
    inv := null;
    if r.against like 'CN-%' then
      select n.id, i.customer_id into note, customer
        from public.finance_credit_notes n
        join public.finance_invoices i on i.org_id = n.org_id and i.id = n.invoice_id
       where n.org_id = demo and n.credit_note_no = r.against and n.status = 'issued';
      continue when note is null;
    else
      select t.id, t.customer_id into inv, customer
        from public.finance_invoice_totals t
       where t.org_id = demo and t.invoice_no = r.against and t.status = 'posted' and t.balance < 0;
      continue when inv is null;
    end if;

    insert into public.finance_transactions
      (org_id, direction, account_id, txn_date, amount, method, contact_id, status)
    values (
      demo, 'out',
      case when r.method = 'cash' then cash else bank end,
      current_date - r.days_ago, r.amount, r.method, customer, 'draft'
    )
    returning id into txn;
    insert into public.finance_allocations (org_id, transaction_id, invoice_id, credit_note_id, amount, reason)
    values (demo, txn, inv, note, r.amount, r.reason);
    if r.status = 'posted' then
      update public.finance_transactions
         set status = 'posted', number = 'PV-' || lpad(pv::text, greatest(4, length(pv::text)), '0'), updated_at = now()
       where id = txn;
      pv := pv + 1;
    else
      update public.finance_transactions set status = 'scheduled', updated_at = now() where id = txn;
    end if;
  end loop;

  -- The demo's counters start after the numbers used above.
  insert into public.finance_sequences (org_id, doc_type, prefix, next_number)
  values (demo, 'quotation', 'QT-', 228), (demo, 'credit_note', 'CN-', 38), (demo, 'voucher', 'PV-', pv)
  on conflict (org_id, doc_type)
    do update set next_number = greatest(public.finance_sequences.next_number, excluded.next_number);
end $$;
```

- [ ] **Step 6: Write the check script**

It is the stage 3a check script from its first line to the end of its contacts section, unchanged but for its name and its structure assertions, followed by the new documents. The 3a part is kept whole on purpose: it is the proof that an invoice and a bill go through the replaced guards as they did.

Create `supabase/tests/bendahara_followons_check.sql`:

```sql
-- Bendahara sales follow-ons check. Run it after
-- 20261022100000_bendahara_sales_followons.sql, in the same transaction for a
-- dry run, or by itself once the migration is applied. It goes through the
-- whole invoice flow and the whole bill flow again, because that migration
-- replaces the guards they run under, and then through quotations, credit
-- notes and refunds. It leaves nothing behind either way: the block always ends with
-- RAISE, so every row and the helper function below are rolled back. Read the
-- message:
--   BENDAHARA_FOLLOWONS_CHECK PASSED ...   or   BENDAHARA_FOLLOWONS_CHECK FAILED: <what went wrong>
-- It makes its own workspace, with an owner, an editor, a viewer and an
-- outsider, and acts as each of them the way the app does: the authenticated
-- role with that person's id in request.jwt.claims.
do $$
declare
  org uuid := gen_random_uuid();
  other_org uuid := gen_random_uuid();
  owner_id uuid := gen_random_uuid();
  editor_id uuid := gen_random_uuid();
  viewer_id uuid := gen_random_uuid();
  outsider uuid := gen_random_uuid();
  bank uuid;
  cust uuid;
  cust2 uuid;
  sup uuid;
  inv uuid;
  inv2 uuid;
  inv3 uuid;
  theirs uuid;
  draft uuid;
  bill uuid;
  rc1 uuid;
  rc2 uuid;
  rc3 uuid;
  pv1 uuid;
  pv2 uuid;
  stray uuid;
  cust3 uuid;
  qt uuid;
  qt2 uuid;
  qinv uuid;
  ci uuid;
  ci2 uuid;
  cn uuid;
  cn2 uuid;
  cna uuid;
  cnb uuid;
  cnt uuid;
  rc uuid;
  rf1 uuid;
  rf2 uuid;
  rf3 uuid;
  rf4 uuid;
  eq uuid;
  ecn uuid;
  no text;
  n integer;
  t text;
  r record;
  -- 10 x 12.50 = 125.00, plus 6% SST 7.50: RM 132.50.
  one_line jsonb := '[{"description":"Check","quantity":10,"unit_price":12.5,"sst_rate":6}]';
  two_lines jsonb := '[{"description":"Second typed first","quantity":1,"unit_price":5},{"description":"First typed second","quantity":1,"unit_price":5}]';
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
  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename in ('finance_quotations','finance_quotation_lines','finance_credit_notes');
  if n <> 15 then fails := fails || format('expected 15 policies on the three new tables, found %s', n); end if;
  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename in ('finance_quotations','finance_quotation_lines','finance_credit_notes')
     and policyname = 'mfa_required' and permissive = 'RESTRICTIVE';
  if n <> 3 then fails := fails || format('expected 3 restrictive mfa_required policies, found %s', n); end if;
  select count(*) into n from pg_class c join pg_namespace s on s.oid = c.relnamespace
   where s.nspname = 'public'
     and c.relname in ('finance_invoice_totals','finance_payments_in','finance_payments_out','supplier_bill_totals',
                       'finance_quotation_totals','finance_credit_note_totals','finance_refunds')
     and c.reloptions::text ilike '%security_invoker=true%';
  if n <> 7 then fails := fails || format('expected 7 security_invoker views, found %s', n); end if;
  select string_agg(conname, ',' order by conname) into t from pg_constraint
   where conrelid = 'public.finance_allocations'::regclass and contype = 'c';
  if t is distinct from 'finance_allocations_amount_check,finance_allocations_one_document_check,finance_allocations_reason_check' then
    fails := fails || format('check constraints on finance_allocations are: %s', t);
  end if;
  -- The live view keeps its columns in their order; the two new ones are at the end.
  select string_agg(attname, ',' order by attnum) into t from pg_attribute
   where attrelid = 'public.finance_invoice_totals'::regclass and attnum > 0 and not attisdropped;
  if t is distinct from 'id,org_id,customer_id,customer_name,invoice_no,invoice_date,due_date,notes,status,posted_at,'
       || 'einvoice_status,einvoice_uuid,created_by,created_at,updated_at,subtotal,sst,total,paid,balance,display_status,credited,refunded' then
    fails := fails || format('finance_invoice_totals has the columns: %s', t);
  end if;
  foreach t in array array[
    'public.finance_save_invoice(uuid, jsonb, jsonb)',
    'public.finance_post_invoice(uuid, uuid)',
    'public.finance_record_payment_in(uuid, jsonb, jsonb)',
    'public.finance_save_quotation(uuid, jsonb, jsonb)',
    'public.finance_send_quotation(uuid, uuid)',
    'public.finance_convert_quotation(uuid, uuid)',
    'public.finance_save_credit_note(uuid, jsonb)',
    'public.finance_issue_credit_note(uuid, uuid)',
    'public.finance_record_refund(uuid, jsonb)',
    'private.finance_refunds_held(uuid, uuid, uuid)'
  ] loop
    if has_function_privilege('anon', t, 'execute') then fails := fails || format('anon can execute %s', t); end if;
    if not has_function_privilege('authenticated', t, 'execute') then fails := fails || format('authenticated cannot execute %s', t); end if;
  end loop;
  foreach t in array array[
    'private.finance_quotation_guard()', 'private.finance_quotation_line_guard()', 'private.finance_credit_note_guard()',
    'private.finance_invoice_guard()', 'private.finance_allocation_guard()', 'private.finance_transaction_guard()',
    'private.finance_contact_guard()'
  ] loop
    if has_function_privilege('authenticated', t, 'execute') or has_function_privilege('anon', t, 'execute') then
      fails := fails || format('a guard can be called directly: %s', t);
    end if;
  end loop;
  foreach t in array array['finance_quotations','finance_quotation_lines','finance_credit_notes','finance_invoice_totals',
                           'finance_quotation_totals','finance_credit_note_totals','finance_refunds','finance_payments_in'] loop
    if has_table_privilege('anon', 'public.' || t, 'select') then fails := fails || format('anon can read %s', t); end if;
    if not has_table_privilege('authenticated', 'public.' || t, 'select') then fails := fails || format('authenticated cannot read %s', t); end if;
  end loop;

  -- ---- people and two workspaces -------------------------------------------
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_anonymous)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    u.id || '@followons-check.openkuasa-test.dev', '', now(), now(), now(), '{}'::jsonb, '{}'::jsonb, false
  from unnest(array[owner_id, editor_id, viewer_id, outsider]) as u(id);

  -- The trigger on orgs gives each workspace its accounts and categories.
  insert into public.orgs (id, name) values (org, 'Follow-ons Check Sdn Bhd'), (other_org, 'Follow-ons Other Sdn Bhd');
  insert into public.org_members (org_id, user_id, role)
  values (org, owner_id, 'owner'), (org, editor_id, 'member'), (org, viewer_id, 'viewer'), (other_org, outsider, 'owner');
  select id into bank from public.finance_accounts where org_id = org and kind = 'bank' order by created_at limit 1;
  if bank is null then raise exception 'BENDAHARA_FOLLOWONS_CHECK cannot run: the new workspace has no bank account'; end if;

  -- ==== as the owner =========================================================
  perform set_config('request.jwt.claims', json_build_object('sub', owner_id, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  set local role authenticated;

  insert into public.finance_contacts (org_id, name, is_customer) values (org, 'Check Customer', true) returning id into cust;
  insert into public.finance_contacts (org_id, name, is_customer) values (org, 'Check Customer Two', true) returning id into cust2;
  insert into public.finance_contacts (org_id, name, is_supplier) values (org, 'Check Supplier', true) returning id into sup;

  -- ---- save: a draft has no number, and its lines keep the order typed ------
  inv := public.finance_save_invoice(org,
    jsonb_build_object('customer_id', cust, 'invoice_date', current_date, 'due_date', current_date + 30), two_lines);
  select string_agg(description, '|' order by position, id) into t
    from public.finance_invoice_lines where invoice_id = inv;
  if t is distinct from 'Second typed first|First typed second' then fails := fails || format('line order: %s', t); end if;
  if public.finance_save_invoice(org,
       jsonb_build_object('id', inv, 'customer_id', cust, 'invoice_date', current_date, 'due_date', current_date + 30, 'notes', 'Changed'),
       one_line) is distinct from inv then
    fails := array_append(fails, 'saving a draft again did not keep its id');
  end if;
  select * into r from public.finance_invoice_totals where id = inv;
  if (r.invoice_no, r.subtotal, r.sst, r.total, r.paid, r.balance, r.display_status, r.customer_name, r.notes)
     is distinct from (null::text, 125.00, 7.50, 132.50, 0.00, 132.50, 'draft', 'Check Customer', 'Changed') then
    fails := fails || format('a draft reads as %s', row_to_json(r));
  end if;

  -- ---- what a draft refuses -------------------------------------------------
  fails := fails || public.bendahara_check_try('an invoice with no line is saved', 'FIN10',
    format('select public.finance_save_invoice(%L, %L, %L)', org,
      jsonb_build_object('customer_id', cust, 'invoice_date', current_date, 'due_date', current_date), '[]'::jsonb));
  fails := fails || public.bendahara_check_try('an invoice is created already posted', 'FIN01',
    format('insert into public.finance_invoices (org_id, customer_id, invoice_no, due_date, status) values (%L, %L, %L, current_date, %L)',
      org, cust, 'INV-SNEAKY', 'posted'));
  fails := fails || public.bendahara_check_try('a draft is voided', 'FIN01',
    format('update public.finance_invoices set status = %L where id = %L', 'void', inv));
  fails := fails || public.bendahara_check_try('a draft carries an e-Invois status', '23514',
    format('update public.finance_invoices set einvoice_status = %L where id = %L', 'validated', inv));
  fails := fails || public.bendahara_check_try('a draft is given a number', '23514',
    format('update public.finance_invoices set invoice_no = %L where id = %L', 'INV-SNEAKY', inv));
  fails := fails || public.bendahara_check_try('an invoice is created as a draft with a number', '23514',
    format('insert into public.finance_invoices (org_id, customer_id, invoice_no, due_date) values (%L, %L, %L, current_date)',
      org, cust, 'INV-SNEAKY'));
  fails := fails || public.bendahara_check_try('a payment goes against a draft invoice', 'FIN04',
    format('select public.finance_record_payment_in(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx'), jsonb_build_array(jsonb_build_object('invoice_id', inv, 'amount', 10))));
  draft := public.finance_save_invoice(org,
    jsonb_build_object('customer_id', cust, 'invoice_date', current_date, 'due_date', current_date),
    '[{"description":"Free sample","quantity":1,"unit_price":0}]');
  fails := fails || public.bendahara_check_try('an invoice of nothing is posted', 'FIN10',
    format('select public.finance_post_invoice(%L, %L)', org, draft));
  fails := fails || public.bendahara_check_try('an invoice of nothing is posted behind the function', 'FIN10',
    format('update public.finance_invoices set status = %L, invoice_no = %L where id = %L', 'posted', 'INV-SNEAKY', draft));
  fails := fails || public.bendahara_check_try('a draft is deleted', 'ok',
    format('delete from public.finance_invoices where id = %L', draft));
  if exists (select 1 from public.finance_invoice_lines where invoice_id = draft) then
    fails := array_append(fails, 'deleting a draft left its lines');
  end if;

  -- ---- post -----------------------------------------------------------------
  no := public.finance_post_invoice(org, inv);
  if no is distinct from 'INV-0001' then fails := fails || format('the first invoice was numbered %s', no); end if;
  select * into r from public.finance_invoice_totals where id = inv;
  if (r.invoice_no, r.display_status, r.status) is distinct from ('INV-0001', 'sent', 'posted') or r.posted_at is null then
    fails := fails || format('a posted invoice reads as %s', row_to_json(r));
  end if;

  -- ---- what a posted invoice refuses, and the one thing it allows -----------
  fails := fails || public.bendahara_check_try('a posted invoice is edited', 'FIN01',
    format('update public.finance_invoices set notes = %L where id = %L', 'Sneaky', inv));
  fails := fails || public.bendahara_check_try('a posted invoice is saved again', 'FIN01',
    format('select public.finance_save_invoice(%L, %L, %L)', org,
      jsonb_build_object('id', inv, 'customer_id', cust, 'invoice_date', current_date, 'due_date', current_date + 30, 'notes', 'Changed'), one_line));
  fails := fails || public.bendahara_check_try('a posted invoice is given a line', 'FIN01',
    format('insert into public.finance_invoice_lines (org_id, invoice_id, description, quantity, unit_price) values (%L, %L, %L, 1, 1)', org, inv, 'Extra'));
  fails := fails || public.bendahara_check_try('a line of a posted invoice is changed', 'FIN01',
    format('update public.finance_invoice_lines set unit_price = 1 where invoice_id = %L', inv));
  fails := fails || public.bendahara_check_try('a posted invoice is deleted', 'FIN01',
    format('delete from public.finance_invoices where id = %L', inv));
  fails := fails || public.bendahara_check_try('a posted invoice is posted again', 'FIN01',
    format('select public.finance_post_invoice(%L, %L)', org, inv));
  fails := fails || public.bendahara_check_try('a posted invoice goes back to draft', 'FIN01',
    format('update public.finance_invoices set status = %L where id = %L', 'draft', inv));
  fails := fails || public.bendahara_check_try('the e-Invois status of a posted invoice is set', 'ok',
    format('update public.finance_invoices set einvoice_status = %L, einvoice_uuid = %L, updated_at = now() where id = %L', 'validated', 'LHDN-CHECK-1', inv));
  fails := fails || public.bendahara_check_try('the e-Invois status is set together with something else', 'FIN01',
    format('update public.finance_invoices set einvoice_status = %L, due_date = current_date + 90 where id = %L', 'rejected', inv));
  select einvoice_status || '/' || einvoice_uuid into t from public.finance_invoices where id = inv;
  if t is distinct from 'validated/LHDN-CHECK-1' then fails := fails || format('e-Invois reads %s', t); end if;

  -- ---- pay in part, then the rest -------------------------------------------
  rc1 := public.finance_record_payment_in(org,
    jsonb_build_object('account_id', bank, 'txn_date', current_date, 'method', 'fpx', 'reference', 'CHK 1'),
    jsonb_build_array(jsonb_build_object('invoice_id', inv, 'amount', 100)));
  select * into r from public.finance_invoice_totals where id = inv;
  if (r.paid, r.balance, r.display_status) is distinct from (100.00, 32.50, 'sent') then
    fails := fails || format('after a part payment the invoice reads %s', row_to_json(r));
  end if;
  select * into r from public.finance_transactions where id = rc1;
  if (r.direction, r.status, r.number, r.amount, r.contact_id, r.created_by)
     is distinct from ('in', 'posted', 'RC-0001', 100.00, cust, owner_id) then
    fails := fails || format('a payment in is stored as %s', row_to_json(r));
  end if;
  fails := fails || public.bendahara_check_try('a payment in of a sen too much', 'FIN05',
    format('select public.finance_record_payment_in(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx'), jsonb_build_array(jsonb_build_object('invoice_id', inv, 'amount', 32.51))));
  rc2 := public.finance_record_payment_in(org,
    jsonb_build_object('account_id', bank, 'method', 'cash'),
    jsonb_build_array(jsonb_build_object('invoice_id', inv, 'amount', 32.5)));
  select * into r from public.finance_invoice_totals where id = inv;
  if (r.paid, r.balance, r.display_status) is distinct from (132.50, 0.00, 'paid') then
    fails := fails || format('after the rest is paid the invoice reads %s', row_to_json(r));
  end if;
  select count(*) as row_count, sum(amount) as total, min(invoice_no) as invoice_no, min(customer_name) as customer_name,
         min(account_name) as account_name, count(distinct transaction_id) as payments, min(number) as first_number
    into r from public.finance_payments_in where invoice_id = inv;
  if (r.row_count, r.total, r.invoice_no, r.customer_name, r.account_name, r.payments, r.first_number)
     is distinct from (2::bigint, 132.50, 'INV-0001', 'Check Customer', 'Main Bank', 2::bigint, 'RC-0001') then
    fails := fails || format('finance_payments_in reads %s', row_to_json(r));
  end if;

  -- ---- a payment in is locked; an invoice with money on it cannot be voided --
  fails := fails || public.bendahara_check_try('a payment in is edited', 'FIN09',
    format('update public.finance_transactions set amount = 1 where id = %L', rc1));
  fails := fails || public.bendahara_check_try('a payment in is deleted', 'FIN09',
    format('delete from public.finance_transactions where id = %L', rc1));
  fails := fails || public.bendahara_check_try('the split of a payment in is changed', 'FIN09',
    format('update public.finance_allocations set amount = 1 where transaction_id = %L', rc1));
  fails := fails || public.bendahara_check_try('a paid invoice is voided', 'FIN02',
    format('update public.finance_invoices set status = %L where id = %L', 'void', inv));
  fails := fails || public.bendahara_check_try('a payment in is voided', 'ok',
    format('update public.finance_transactions set status = %L, updated_at = now() where id = %L', 'void', rc2));
  select * into r from public.finance_invoice_totals where id = inv;
  if (r.paid, r.balance, r.display_status) is distinct from (100.00, 32.50, 'sent') then
    fails := fails || format('after voiding a payment the invoice reads %s', row_to_json(r));
  end if;
  fails := fails || public.bendahara_check_try('an invoice with one payment left is voided', 'FIN02',
    format('update public.finance_invoices set status = %L where id = %L', 'void', inv));
  fails := fails || public.bendahara_check_try('the other payment in is voided', 'ok',
    format('update public.finance_transactions set status = %L, updated_at = now() where id = %L', 'void', rc1));
  fails := fails || public.bendahara_check_try('an invoice with no money on it is voided', 'ok',
    format('update public.finance_invoices set status = %L, updated_at = now() where id = %L', 'void', inv));
  select display_status into t from public.finance_invoice_totals where id = inv;
  if t is distinct from 'void' then fails := fails || format('a void invoice reads %s', t); end if;
  fails := fails || public.bendahara_check_try('a void invoice is changed', 'FIN01',
    format('update public.finance_invoices set status = %L where id = %L', 'posted', inv));

  -- ---- one payment, two invoices; one customer only -------------------------
  inv2 := public.finance_save_invoice(org,
    jsonb_build_object('customer_id', cust, 'invoice_date', current_date - 40, 'due_date', current_date - 10), one_line);
  perform public.finance_post_invoice(org, inv2);
  inv3 := public.finance_save_invoice(org,
    jsonb_build_object('customer_id', cust, 'invoice_date', current_date, 'due_date', current_date + 30), one_line);
  perform public.finance_post_invoice(org, inv3);
  theirs := public.finance_save_invoice(org,
    jsonb_build_object('customer_id', cust2, 'invoice_date', current_date, 'due_date', current_date + 30), one_line);
  perform public.finance_post_invoice(org, theirs);
  select display_status into t from public.finance_invoice_totals where id = inv2;
  if t is distinct from 'overdue' then fails := fails || format('an invoice past its due date reads %s', t); end if;

  fails := fails || public.bendahara_check_try('one payment for two customers', 'FIN06',
    format('select public.finance_record_payment_in(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx'),
      jsonb_build_array(jsonb_build_object('invoice_id', inv2, 'amount', 10), jsonb_build_object('invoice_id', theirs, 'amount', 10))));
  fails := fails || public.bendahara_check_try('a payment with no invoice', 'FIN06',
    format('select public.finance_record_payment_in(%L, %L, %L)', org, jsonb_build_object('account_id', bank, 'method', 'fpx'), '[]'::jsonb));
  rc3 := public.finance_record_payment_in(org,
    jsonb_build_object('account_id', bank, 'method', 'bank_transfer'),
    jsonb_build_array(jsonb_build_object('invoice_id', inv3, 'amount', 32.5), jsonb_build_object('invoice_id', inv2, 'amount', 132.5)));
  select amount into r from public.finance_transactions where id = rc3;
  if r.amount is distinct from 165.00 then fails := fails || format('a split payment in totals %s', r.amount); end if;
  select string_agg(display_status || ' ' || balance, ', ' order by invoice_no) into t
    from public.finance_invoice_totals where id in (inv2, inv3);
  if t is distinct from 'paid 0.00, sent 100.00' then fails := fails || format('after a split payment: %s', t); end if;

  -- ---- a bill takes only money out, an invoice only money in ----------------
  bill := public.finance_save_bill(org,
    jsonb_build_object('supplier_id', sup, 'bill_date', current_date, 'due_date', current_date + 30), one_line);
  perform public.finance_post_bill(org, bill);
  insert into public.finance_transactions (org_id, direction, account_id, amount, method)
  values (org, 'out', bank, 20, 'cash') returning id into stray;
  fails := fails || public.bendahara_check_try('money out is put against an invoice', 'FIN04',
    format('insert into public.finance_allocations (org_id, transaction_id, invoice_id, amount) values (%L, %L, %L, 10)', org, stray, theirs));
  fails := fails || public.bendahara_check_try('one allocation names a bill and an invoice', '23514',
    format('insert into public.finance_allocations (org_id, transaction_id, bill_id, invoice_id, amount) values (%L, %L, %L, %L, 10)', org, stray, bill, theirs));
  fails := fails || public.bendahara_check_try('an allocation names no document', 'FIN04',
    format('insert into public.finance_allocations (org_id, transaction_id, amount) values (%L, %L, 10)', org, stray));
  fails := fails || public.bendahara_check_try('the split is more than the payment', 'FIN03',
    format('insert into public.finance_allocations (org_id, transaction_id, bill_id, amount) values (%L, %L, %L, 20.01)', org, stray, bill));
  -- A draft payment out that is split across a bill cannot be changed
  -- underneath its split. Before it is split it may be changed freely.
  fails := fails || public.bendahara_check_try('an unsplit draft payment out is made smaller', 'ok',
    format('update public.finance_transactions set amount = 15, updated_at = now() where id = %L', stray));
  fails := fails || public.bendahara_check_try('an unsplit draft payment out is made larger again', 'ok',
    format('update public.finance_transactions set amount = 20, updated_at = now() where id = %L', stray));
  fails := fails || public.bendahara_check_try('a draft payment out is split across a bill', 'ok',
    format('insert into public.finance_allocations (org_id, transaction_id, bill_id, amount) values (%L, %L, %L, 10)', org, stray, bill));
  fails := fails || public.bendahara_check_try('a split draft payment out is made smaller than its split', 'FIN03',
    format('update public.finance_transactions set amount = 9.99 where id = %L', stray));
  fails := fails || public.bendahara_check_try('a split draft payment out is shrunk and posted at once', 'FIN03',
    format('update public.finance_transactions set amount = 1, status = %L, number = %L where id = %L', 'posted', 'PV-SNEAKY', stray));
  fails := fails || public.bendahara_check_try('a split draft payment out is turned into money in', 'FIN04',
    format('update public.finance_transactions set direction = %L where id = %L', 'in', stray));
  fails := fails || public.bendahara_check_try('a split draft payment out is brought down to its split', 'ok',
    format('update public.finance_transactions set amount = 10, updated_at = now() where id = %L', stray));
  select amount || ' ' || direction || ' ' || status into t from public.finance_transactions where id = stray;
  if t is distinct from '10.00 out draft' then fails := fails || format('a split draft payment out reads %s', t); end if;
  -- Deleting the draft takes its split with it, so the bill flow below starts clean.
  delete from public.finance_transactions where id = stray;
  select count(*) into n from public.finance_allocations where org_id = org and bill_id = bill;
  if n <> 0 then fails := fails || format('deleting a draft payment out left %s rows of its split', n); end if;
  insert into public.finance_transactions (org_id, direction, account_id, amount, method)
  values (org, 'in', bank, 20, 'cash') returning id into stray;
  fails := fails || public.bendahara_check_try('money in is put against a bill', 'FIN04',
    format('insert into public.finance_allocations (org_id, transaction_id, bill_id, amount) values (%L, %L, %L, 10)', org, stray, bill));
  fails := fails || public.bendahara_check_try('an unposted payment in is voided', 'FIN09',
    format('update public.finance_transactions set status = %L where id = %L', 'void', stray));
  -- The same for money in: split it across a posted invoice, then try to
  -- shrink it or turn it round before posting.
  fails := fails || public.bendahara_check_try('a draft payment in is split across an invoice', 'ok',
    format('insert into public.finance_allocations (org_id, transaction_id, invoice_id, amount) values (%L, %L, %L, 20)', org, stray, theirs));
  fails := fails || public.bendahara_check_try('a split draft payment in is made smaller than its split', 'FIN03',
    format('update public.finance_transactions set amount = 1 where id = %L', stray));
  fails := fails || public.bendahara_check_try('a split draft payment in is shrunk and posted at once', 'FIN03',
    format('update public.finance_transactions set amount = 1, status = %L, number = %L where id = %L', 'posted', 'RC-SNEAKY', stray));
  fails := fails || public.bendahara_check_try('a split draft payment in is turned into money out', 'FIN04',
    format('update public.finance_transactions set direction = %L where id = %L', 'out', stray));
  fails := fails || public.bendahara_check_try('a split draft payment in is turned round and posted at once', 'FIN04',
    format('update public.finance_transactions set direction = %L, status = %L, number = %L where id = %L', 'out', 'posted', 'RC-SNEAKY', stray));
  fails := fails || public.bendahara_check_try('a split draft payment in is made larger', 'ok',
    format('update public.finance_transactions set amount = 25, updated_at = now() where id = %L', stray));
  select amount || ' ' || direction || ' ' || status into t from public.finance_transactions where id = stray;
  if t is distinct from '25.00 in draft' then fails := fails || format('a split draft payment in reads %s', t); end if;
  -- A draft payment is not money received: the invoice owes what it owed.
  select display_status || ' ' || balance into t from public.finance_invoice_totals where id = theirs;
  if t is distinct from 'sent 132.50' then fails := fails || format('an invoice with only a draft payment on it reads %s', t); end if;
  delete from public.finance_transactions where id = stray;
  select count(*) into n from public.finance_allocations where org_id = org and invoice_id = theirs;
  if n <> 0 then fails := fails || format('deleting a draft payment in left %s rows of its split', n); end if;

  -- ---- the bill flow, through the rewritten allocation guard ----------------
  pv1 := public.finance_record_payment_out(org,
    jsonb_build_object('account_id', bank, 'method', 'fpx', 'status', 'scheduled'),
    jsonb_build_array(jsonb_build_object('bill_id', bill, 'amount', 100)));
  fails := fails || public.bendahara_check_try('a bill is paid beyond what scheduled payments leave', 'FIN05',
    format('select public.finance_record_payment_out(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx'), jsonb_build_array(jsonb_build_object('bill_id', bill, 'amount', 32.51))));
  pv2 := public.finance_record_payment_out(org,
    jsonb_build_object('account_id', bank, 'method', 'fpx'),
    jsonb_build_array(jsonb_build_object('bill_id', bill, 'amount', 32.5)));
  select * into r from public.supplier_bill_totals where id = bill;
  if (r.paid, r.balance, r.display_status) is distinct from (32.50, 100.00, 'pending') then
    fails := fails || format('a part-paid bill reads %s', row_to_json(r));
  end if;
  no := public.finance_mark_payment_paid(org, pv1, current_date);
  select * into r from public.supplier_bill_totals where id = bill;
  if (r.paid, r.balance, r.display_status) is distinct from (132.50, 0.00, 'paid') or no not like 'PV-%' then
    fails := fails || format('a paid bill reads %s (voucher %s)', row_to_json(r), no);
  end if;
  select count(*) into n from public.finance_payments_out where bill_id = bill;
  if n <> 2 then fails := fails || format('finance_payments_out has %s rows for the bill', n); end if;
  select count(*) into n from public.finance_payments_out where org_id = org;
  if n <> 2 then fails := fails || format('finance_payments_out shows %s rows; payments in must not appear there', n); end if;
  fails := fails || public.bendahara_check_try('a paid bill is voided', 'FIN02',
    format('update public.supplier_bills set status = %L where id = %L', 'void', bill));
  fails := fails || public.bendahara_check_try('a paid payment out is deleted', 'FIN09',
    format('delete from public.finance_transactions where id = %L', pv2));
  update public.finance_transactions set status = 'void', updated_at = now() where id in (pv1, pv2);
  fails := fails || public.bendahara_check_try('a bill with no money on it is voided', 'ok',
    format('update public.supplier_bills set status = %L, updated_at = now() where id = %L', 'void', bill));

  -- ---- contacts -------------------------------------------------------------
  fails := fails || public.bendahara_check_try('Customer is unticked on a contact with invoices', 'FIN08',
    format('update public.finance_contacts set is_customer = false, is_supplier = true where id = %L', cust));
  fails := fails || public.bendahara_check_try('Supplier is unticked on a contact with bills', 'FIN07',
    format('update public.finance_contacts set is_supplier = false, is_customer = true where id = %L', sup));
  fails := fails || public.bendahara_check_try('a customer with invoices is deleted', '23503',
    format('delete from public.finance_contacts where id = %L', cust));

  -- ==== quotations ============================================================
  -- ---- save: a draft has no number, and its lines keep the order typed ------
  qt := public.finance_save_quotation(org,
    jsonb_build_object('customer_id', cust, 'quote_date', current_date, 'valid_until', current_date + 30), two_lines);
  select string_agg(description, '|' order by position, id) into t
    from public.finance_quotation_lines where quotation_id = qt;
  if t is distinct from 'Second typed first|First typed second' then fails := fails || format('quotation line order: %s', t); end if;
  if public.finance_save_quotation(org,
       jsonb_build_object('id', qt, 'customer_id', cust, 'quote_date', current_date, 'valid_until', current_date + 30, 'notes', 'Quoted'),
       one_line) is distinct from qt then
    fails := array_append(fails, 'saving a draft quotation again did not keep its id');
  end if;
  select * into r from public.finance_quotation_totals where id = qt;
  if (r.quotation_no, r.subtotal, r.sst, r.total, r.display_status, r.customer_name, r.notes, r.invoice_id)
     is distinct from (null::text, 125.00, 7.50, 132.50, 'draft', 'Check Customer', 'Quoted', null::uuid) then
    fails := fails || format('a draft quotation reads as %s', row_to_json(r));
  end if;

  -- ---- what a draft quotation refuses ----------------------------------------
  fails := fails || public.bendahara_check_try('a quotation with no line is saved', 'FIN10',
    format('select public.finance_save_quotation(%L, %L, %L)', org,
      jsonb_build_object('customer_id', cust, 'quote_date', current_date, 'valid_until', current_date), '[]'::jsonb));
  fails := fails || public.bendahara_check_try('a quotation is created already sent', 'FIN01',
    format('insert into public.finance_quotations (org_id, customer_id, quotation_no, valid_until, status, sent_at) values (%L, %L, %L, current_date, %L, now())',
      org, cust, 'QT-SNEAKY', 'sent'));
  fails := fails || public.bendahara_check_try('a draft quotation is accepted', 'FIN01',
    format('update public.finance_quotations set status = %L, accepted_at = now() where id = %L', 'accepted', qt));
  fails := fails || public.bendahara_check_try('a draft quotation is given a number', '23514',
    format('update public.finance_quotations set quotation_no = %L where id = %L', 'QT-SNEAKY', qt));
  fails := fails || public.bendahara_check_try('a draft quotation is converted', 'FIN04',
    format('select public.finance_convert_quotation(%L, %L)', org, qt));
  qt2 := public.finance_save_quotation(org,
    jsonb_build_object('customer_id', cust, 'quote_date', current_date, 'valid_until', current_date),
    '[{"description":"Free sample","quantity":1,"unit_price":0}]');
  fails := fails || public.bendahara_check_try('a quotation of nothing is sent', 'FIN10',
    format('select public.finance_send_quotation(%L, %L)', org, qt2));
  fails := fails || public.bendahara_check_try('a quotation of nothing is sent behind the function', 'FIN10',
    format('update public.finance_quotations set status = %L, quotation_no = %L, sent_at = now() where id = %L', 'sent', 'QT-SNEAKY', qt2));
  fails := fails || public.bendahara_check_try('a draft quotation is deleted', 'ok',
    format('delete from public.finance_quotations where id = %L', qt2));
  if exists (select 1 from public.finance_quotation_lines where quotation_id = qt2) then
    fails := array_append(fails, 'deleting a draft quotation left its lines');
  end if;

  -- ---- send -----------------------------------------------------------------
  no := public.finance_send_quotation(org, qt);
  if no is distinct from 'QT-0001' then fails := fails || format('the first quotation was numbered %s', no); end if;
  select * into r from public.finance_quotation_totals where id = qt;
  if (r.quotation_no, r.display_status, r.status) is distinct from ('QT-0001', 'sent', 'sent') or r.sent_at is null then
    fails := fails || format('a sent quotation reads as %s', row_to_json(r));
  end if;

  -- ---- what a sent quotation refuses, and the answer it takes ---------------
  fails := fails || public.bendahara_check_try('a sent quotation is edited', 'FIN01',
    format('update public.finance_quotations set notes = %L where id = %L', 'Sneaky', qt));
  fails := fails || public.bendahara_check_try('a sent quotation is saved again', 'FIN01',
    format('select public.finance_save_quotation(%L, %L, %L)', org,
      jsonb_build_object('id', qt, 'customer_id', cust, 'quote_date', current_date, 'valid_until', current_date + 30), one_line));
  fails := fails || public.bendahara_check_try('a sent quotation is given a line', 'FIN01',
    format('insert into public.finance_quotation_lines (org_id, quotation_id, description, quantity, unit_price) values (%L, %L, %L, 1, 1)', org, qt, 'Extra'));
  fails := fails || public.bendahara_check_try('a line of a sent quotation is changed', 'FIN01',
    format('update public.finance_quotation_lines set unit_price = 1 where quotation_id = %L', qt));
  fails := fails || public.bendahara_check_try('a sent quotation is deleted', 'FIN01',
    format('delete from public.finance_quotations where id = %L', qt));
  fails := fails || public.bendahara_check_try('a sent quotation is sent again', 'FIN01',
    format('select public.finance_send_quotation(%L, %L)', org, qt));
  fails := fails || public.bendahara_check_try('a sent quotation goes back to draft', 'FIN01',
    format('update public.finance_quotations set status = %L where id = %L', 'draft', qt));
  fails := fails || public.bendahara_check_try('a sent quotation is converted before it is accepted', 'FIN04',
    format('select public.finance_convert_quotation(%L, %L)', org, qt));
  fails := fails || public.bendahara_check_try('a sent quotation is accepted and edited in one update', 'FIN01',
    format('update public.finance_quotations set status = %L, accepted_at = now(), notes = %L where id = %L', 'accepted', 'Sneaky', qt));
  fails := fails || public.bendahara_check_try('a quotation is accepted without saying when', '23514',
    format('update public.finance_quotations set status = %L where id = %L', 'accepted', qt));
  fails := fails || public.bendahara_check_try('a sent quotation is accepted', 'ok',
    format('update public.finance_quotations set status = %L, accepted_at = now(), updated_at = now() where id = %L', 'accepted', qt));
  fails := fails || public.bendahara_check_try('an accepted quotation is accepted again', 'FIN01',
    format('update public.finance_quotations set accepted_at = now() + interval %L where id = %L', '1 hour', qt));
  fails := fails || public.bendahara_check_try('an accepted quotation is changed to declined', 'ok',
    format('update public.finance_quotations set status = %L, accepted_at = null, updated_at = now() where id = %L', 'declined', qt));
  fails := fails || public.bendahara_check_try('a declined quotation is converted', 'FIN04',
    format('select public.finance_convert_quotation(%L, %L)', org, qt));
  fails := fails || public.bendahara_check_try('a declined quotation is changed to accepted', 'ok',
    format('update public.finance_quotations set status = %L, accepted_at = now(), updated_at = now() where id = %L', 'accepted', qt));

  -- ---- convert: one draft invoice with the same lines ------------------------
  qinv := public.finance_convert_quotation(org, qt);
  select i.status, i.customer_id, i.due_date - i.invoice_date as terms, i.quotation_id, i.notes, v.total, v.invoice_no
    into r from public.finance_invoices i join public.finance_invoice_totals v on v.id = i.id where i.id = qinv;
  if (r.status, r.customer_id, r.terms, r.quotation_id, r.notes, r.total, r.invoice_no)
     is distinct from ('draft', cust, 30, qt, 'Quoted', 132.50, null::text) then
    fails := fails || format('an invoice made from a quotation reads %s', row_to_json(r));
  end if;
  select invoice_id into r from public.finance_quotation_totals where id = qt;
  if r.invoice_id is distinct from qinv then fails := array_append(fails, 'a converted quotation does not name its invoice'); end if;
  fails := fails || public.bendahara_check_try('a quotation is converted twice', 'FIN13',
    format('select public.finance_convert_quotation(%L, %L)', org, qt));
  fails := fails || public.bendahara_check_try('a converted quotation is declined', 'FIN13',
    format('update public.finance_quotations set status = %L, accepted_at = null where id = %L', 'declined', qt));
  fails := fails || public.bendahara_check_try('a second invoice is tied to the quotation by hand', '23505',
    format('insert into public.finance_invoices (org_id, customer_id, due_date, quotation_id) values (%L, %L, current_date, %L)', org, cust, qt));
  fails := fails || public.bendahara_check_try('an invoice is tied to another customer''s quotation', 'FIN04',
    format('insert into public.finance_invoices (org_id, customer_id, due_date, quotation_id) values (%L, %L, current_date, %L)', org, cust2, qt));
  -- The invoice is an ordinary draft: saved again it keeps its tie; deleted, it frees the quotation.
  perform public.finance_save_invoice(org,
    jsonb_build_object('id', qinv, 'customer_id', cust, 'invoice_date', current_date, 'due_date', current_date + 14), one_line);
  select count(*) into n from public.finance_invoices where id = qinv and quotation_id = qt;
  if n <> 1 then fails := array_append(fails, 'saving the draft invoice again lost its quotation'); end if;
  delete from public.finance_invoices where id = qinv;
  select invoice_id into r from public.finance_quotation_totals where id = qt;
  if r.invoice_id is not null then fails := array_append(fails, 'deleting the draft invoice did not free the quotation'); end if;
  -- Converted again, posted, then voided: a void invoice does not hold the quotation either.
  qinv := public.finance_convert_quotation(org, qt);
  perform public.finance_post_invoice(org, qinv);
  fails := fails || public.bendahara_check_try('a quotation whose invoice is posted is converted', 'FIN13',
    format('select public.finance_convert_quotation(%L, %L)', org, qt));
  update public.finance_invoices set status = 'void', updated_at = now() where id = qinv;
  fails := fails || public.bendahara_check_try('a quotation whose invoice was voided is converted again', 'ok',
    format('select public.finance_convert_quotation(%L, %L)', org, qt));
  delete from public.finance_invoices where org_id = org and quotation_id = qt and status = 'draft';
  get diagnostics n = row_count;
  if n <> 1 then fails := fails || format('converting again left %s draft invoices', n); end if;

  -- ---- expired is worked out from the date; a late yes is still a yes --------
  insert into public.finance_contacts (org_id, name, is_customer) values (org, 'Check Customer Three', true) returning id into cust3;
  qt2 := public.finance_save_quotation(org,
    jsonb_build_object('customer_id', cust3, 'quote_date', current_date - 40, 'valid_until', current_date - 10), one_line);
  perform public.finance_send_quotation(org, qt2);
  select display_status || '/' || status into t from public.finance_quotation_totals where id = qt2;
  if t is distinct from 'expired/sent' then fails := fails || format('a quotation past its date reads %s', t); end if;
  update public.finance_quotations set status = 'accepted', accepted_at = now(), updated_at = now() where id = qt2;
  select display_status into t from public.finance_quotation_totals where id = qt2;
  if t is distinct from 'accepted' then fails := fails || format('a quotation accepted late reads %s', t); end if;
  fails := fails || public.bendahara_check_try('Customer is unticked on a contact with quotations', 'FIN08',
    format('update public.finance_contacts set is_customer = false, is_supplier = true where id = %L', cust3));

  -- ==== credit notes and refunds, on one invoice from start to finish =========
  -- An invoice of RM 132.50. What it owes is read from finance_invoice_totals
  -- after every step, and each guard is tried a sen either side of that figure.
  ci := public.finance_save_invoice(org,
    jsonb_build_object('customer_id', cust, 'invoice_date', current_date, 'due_date', current_date + 30), one_line);
  perform public.finance_post_invoice(org, ci);
  draft := public.finance_save_invoice(org,
    jsonb_build_object('customer_id', cust, 'invoice_date', current_date, 'due_date', current_date + 30), one_line);

  cn := public.finance_save_credit_note(org,
    jsonb_build_object('invoice_id', ci, 'credit_date', current_date, 'reason', 'returns', 'amount', 50, 'notes', 'Two returned'));
  if public.finance_save_credit_note(org,
       jsonb_build_object('id', cn, 'invoice_id', ci, 'credit_date', current_date, 'reason', 'returns', 'amount', 30, 'notes', 'Two returned'))
     is distinct from cn then
    fails := array_append(fails, 'saving a draft credit note again did not keep its id');
  end if;
  select * into r from public.finance_credit_note_totals where id = cn;
  if (r.credit_note_no, r.amount, r.reason, r.status, r.customer_name, r.refunded, r.notes) is distinct from
     (null::text, 30.00, 'returns', 'draft', 'Check Customer', 0.00, 'Two returned') or r.invoice_no is null then
    fails := fails || format('a draft credit note reads as %s', row_to_json(r));
  end if;
  select * into r from public.finance_invoice_totals where id = ci;
  if (r.credited, r.refunded, r.balance, r.display_status) is distinct from (0.00, 0.00, 132.50, 'sent') then
    fails := fails || format('a draft credit note changed its invoice: %s', row_to_json(r));
  end if;

  -- ---- what a draft credit note refuses --------------------------------------
  fails := fails || public.bendahara_check_try('a credit note is created already issued', 'FIN01',
    format('insert into public.finance_credit_notes (org_id, invoice_id, credit_note_no, amount, status, issued_at) values (%L, %L, %L, 1, %L, now())',
      org, ci, 'CN-SNEAKY', 'issued'));
  fails := fails || public.bendahara_check_try('a draft credit note is voided', 'FIN01',
    format('update public.finance_credit_notes set status = %L where id = %L', 'void', cn));
  fails := fails || public.bendahara_check_try('a draft credit note is given a number', '23514',
    format('update public.finance_credit_notes set credit_note_no = %L where id = %L', 'CN-SNEAKY', cn));
  fails := fails || public.bendahara_check_try('a credit note is issued behind the function without a number', '23514',
    format('update public.finance_credit_notes set status = %L where id = %L', 'issued', cn));
  fails := fails || public.bendahara_check_try('a credit note goes against a draft invoice', 'FIN04',
    format('select public.finance_save_credit_note(%L, %L)', org, jsonb_build_object('invoice_id', draft, 'amount', 10)));
  fails := fails || public.bendahara_check_try('a credit note for a sen more than the invoice', 'FIN05',
    format('select public.finance_save_credit_note(%L, %L)', org, jsonb_build_object('invoice_id', ci, 'amount', 132.51)));
  fails := fails || public.bendahara_check_try('a credit note with an unknown reason', '23514',
    format('select public.finance_save_credit_note(%L, %L)', org, jsonb_build_object('invoice_id', ci, 'amount', 10, 'reason', 'because')));
  fails := fails || public.bendahara_check_try('a refund goes against a draft credit note', 'FIN04',
    format('select public.finance_record_refund(%L, %L)', org,
      jsonb_build_object('credit_note_id', cn, 'account_id', bank, 'method', 'fpx', 'amount', 10)));
  delete from public.finance_invoices where id = draft;

  -- ---- issue: the invoice owes less from this moment --------------------------
  no := public.finance_issue_credit_note(org, cn);
  if no is distinct from 'CN-0001' then fails := fails || format('the first credit note was numbered %s', no); end if;
  select * into r from public.finance_credit_note_totals where id = cn;
  if (r.credit_note_no, r.status) is distinct from ('CN-0001', 'issued') or r.issued_at is null then
    fails := fails || format('an issued credit note reads as %s', row_to_json(r));
  end if;
  select * into r from public.finance_invoice_totals where id = ci;
  if (r.total, r.paid, r.credited, r.refunded, r.balance, r.display_status) is distinct from (132.50, 0.00, 30.00, 0.00, 102.50, 'sent') then
    fails := fails || format('after a credit note the invoice reads %s', row_to_json(r));
  end if;

  -- ---- an issued credit note is locked ----------------------------------------
  fails := fails || public.bendahara_check_try('an issued credit note is edited', 'FIN01',
    format('update public.finance_credit_notes set amount = 1 where id = %L', cn));
  fails := fails || public.bendahara_check_try('an issued credit note is saved again', 'FIN01',
    format('select public.finance_save_credit_note(%L, %L)', org, jsonb_build_object('id', cn, 'invoice_id', ci, 'amount', 1)));
  fails := fails || public.bendahara_check_try('an issued credit note is deleted', 'FIN01',
    format('delete from public.finance_credit_notes where id = %L', cn));
  fails := fails || public.bendahara_check_try('an issued credit note is issued again', 'FIN01',
    format('select public.finance_issue_credit_note(%L, %L)', org, cn));
  fails := fails || public.bendahara_check_try('an issued credit note goes back to draft', 'FIN01',
    format('update public.finance_credit_notes set status = %L, credit_note_no = null where id = %L', 'draft', cn));

  -- ---- the guards and the view agree on what is owed --------------------------
  fails := fails || public.bendahara_check_try('a payment in of a sen more than is owed after the credit', 'FIN05',
    format('select public.finance_record_payment_in(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx'), jsonb_build_array(jsonb_build_object('invoice_id', ci, 'amount', 102.51))));
  fails := fails || public.bendahara_check_try('a refund while the customer still owes money', 'FIN04',
    format('select public.finance_record_refund(%L, %L)', org,
      jsonb_build_object('invoice_id', ci, 'account_id', bank, 'method', 'fpx', 'amount', 10)));
  fails := fails || public.bendahara_check_try('a refund against a credit note while the customer still owes money', 'FIN04',
    format('select public.finance_record_refund(%L, %L)', org,
      jsonb_build_object('credit_note_id', cn, 'account_id', bank, 'method', 'fpx', 'amount', 10)));
  rc := public.finance_record_payment_in(org,
    jsonb_build_object('account_id', bank, 'method', 'fpx'),
    jsonb_build_array(jsonb_build_object('invoice_id', ci, 'amount', 102.5)));
  select * into r from public.finance_invoice_totals where id = ci;
  if (r.paid, r.credited, r.balance, r.display_status) is distinct from (102.50, 30.00, 0.00, 'paid') then
    fails := fails || format('paid after a credit note, the invoice reads %s', row_to_json(r));
  end if;
  fails := fails || public.bendahara_check_try('a refund on an invoice that is settled exactly', 'FIN04',
    format('select public.finance_record_refund(%L, %L)', org,
      jsonb_build_object('invoice_id', ci, 'account_id', bank, 'method', 'fpx', 'amount', 0.01)));
  fails := fails || public.bendahara_check_try('credit notes for a sen more than the invoice between them', 'FIN05',
    format('select public.finance_save_credit_note(%L, %L)', org, jsonb_build_object('invoice_id', ci, 'amount', 102.51)));

  -- A second credit note on the paid invoice leaves the customer RM 30 in credit.
  cn2 := public.finance_save_credit_note(org, jsonb_build_object('invoice_id', ci, 'reason', 'goodwill', 'amount', 30));
  no := public.finance_issue_credit_note(org, cn2);
  select * into r from public.finance_invoice_totals where id = ci;
  if (r.paid, r.credited, r.refunded, r.balance, r.display_status) is distinct from (102.50, 60.00, 0.00, -30.00, 'paid') or no <> 'CN-0002' then
    fails := fails || format('in credit, the invoice reads %s (credit note %s)', row_to_json(r), no);
  end if;
  fails := fails || public.bendahara_check_try('a payment in while the customer is in credit', 'FIN05',
    format('select public.finance_record_payment_in(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx'), jsonb_build_array(jsonb_build_object('invoice_id', ci, 'amount', 0.01))));
  fails := fails || public.bendahara_check_try('a refund of a sen more than the credit', 'FIN05',
    format('select public.finance_record_refund(%L, %L)', org,
      jsonb_build_object('invoice_id', ci, 'account_id', bank, 'method', 'fpx', 'amount', 30.01)));
  fails := fails || public.bendahara_check_try('a refund against no document', 'FIN06',
    format('select public.finance_record_refund(%L, %L)', org, jsonb_build_object('account_id', bank, 'method', 'fpx', 'amount', 1)));
  fails := fails || public.bendahara_check_try('a refund against an invoice and a credit note at once', 'FIN06',
    format('select public.finance_record_refund(%L, %L)', org,
      jsonb_build_object('invoice_id', ci, 'credit_note_id', cn2, 'account_id', bank, 'method', 'fpx', 'amount', 1)));
  fails := fails || public.bendahara_check_try('a refund with an unknown reason', '23514',
    format('select public.finance_record_refund(%L, %L)', org,
      jsonb_build_object('invoice_id', ci, 'account_id', bank, 'method', 'fpx', 'amount', 1, 'reason', 'because')));

  -- ---- a pending refund holds the credit and moves no money -------------------
  rf1 := public.finance_record_refund(org,
    jsonb_build_object('credit_note_id', cn2, 'account_id', bank, 'txn_date', current_date, 'method', 'bank_transfer',
                       'reason', 'damaged_goods', 'amount', 20, 'status', 'scheduled', 'notes', 'Cracked on arrival'));
  select * into r from public.finance_transactions where id = rf1;
  if (r.direction, r.status, r.number, r.amount, r.contact_id, r.created_by)
     is distinct from ('out', 'scheduled', null::text, 20.00, cust, owner_id) then
    fails := fails || format('a pending refund is stored as %s', row_to_json(r));
  end if;
  select * into r from public.finance_refunds where transaction_id = rf1;
  if (r.status, r.reason, r.amount, r.transaction_amount, r.credit_note_no, r.customer_name, r.account_name, r.notes, r.invoice_id)
     is distinct from ('scheduled', 'damaged_goods', 20.00, 20.00, 'CN-0002', 'Check Customer', 'Main Bank', 'Cracked on arrival', ci) then
    fails := fails || format('finance_refunds reads a pending refund as %s', row_to_json(r));
  end if;
  select * into r from public.finance_invoice_totals where id = ci;
  if (r.refunded, r.balance) is distinct from (0.00, -30.00) then
    fails := fails || format('a pending refund moved the invoice: %s', row_to_json(r));
  end if;
  fails := fails || public.bendahara_check_try('a refund of a sen more than a pending refund leaves', 'FIN05',
    format('select public.finance_record_refund(%L, %L)', org,
      jsonb_build_object('invoice_id', ci, 'account_id', bank, 'method', 'fpx', 'amount', 10.01)));
  fails := fails || public.bendahara_check_try('a refund of a sen more than is left of the credit note', 'FIN05',
    format('select public.finance_record_refund(%L, %L)', org,
      jsonb_build_object('credit_note_id', cn2, 'account_id', bank, 'method', 'fpx', 'amount', 10.01)));
  fails := fails || public.bendahara_check_try('a pending refund of a sen more than a pending refund leaves', 'FIN05',
    format('select public.finance_record_refund(%L, %L)', org,
      jsonb_build_object('invoice_id', ci, 'account_id', bank, 'method', 'fpx', 'amount', 10.01, 'status', 'scheduled')));
  rf2 := public.finance_record_refund(org,
    jsonb_build_object('invoice_id', ci, 'account_id', bank, 'method', 'fpx', 'reason', 'overpayment', 'amount', 10));
  select * into r from public.finance_transactions where id = rf2;
  if (r.direction, r.status, r.amount) is distinct from ('out', 'posted', 10.00) or r.number not like 'PV-%' then
    fails := fails || format('a refund paid out at once is stored as %s', row_to_json(r));
  end if;
  select * into r from public.finance_invoice_totals where id = ci;
  if (r.refunded, r.balance, r.display_status) is distinct from (10.00, -20.00, 'paid') then
    fails := fails || format('after one refund the invoice reads %s', row_to_json(r));
  end if;
  fails := fails || public.bendahara_check_try('a refund when the credit is all spoken for', 'FIN05',
    format('select public.finance_record_refund(%L, %L)', org,
      jsonb_build_object('invoice_id', ci, 'account_id', bank, 'method', 'fpx', 'amount', 0.01)));

  -- ---- nothing a refund leans on can be voided --------------------------------
  fails := fails || public.bendahara_check_try('a credit note with a refund on it is voided', 'FIN02',
    format('update public.finance_credit_notes set status = %L where id = %L', 'void', cn2));
  fails := fails || public.bendahara_check_try('a credit note the invoice''s refunds lean on is voided', 'FIN02',
    format('update public.finance_credit_notes set status = %L where id = %L', 'void', cn));
  fails := fails || public.bendahara_check_try('an invoice with a refund on it is voided', 'FIN02',
    format('update public.finance_invoices set status = %L where id = %L', 'void', ci));

  -- ---- paid out: the same function and number series as a payment out ---------
  no := public.finance_mark_payment_paid(org, rf1, current_date);
  select * into r from public.finance_invoice_totals where id = ci;
  if (r.refunded, r.balance, r.display_status) is distinct from (30.00, 0.00, 'paid') or no not like 'PV-%' then
    fails := fails || format('refunded in full, the invoice reads %s (voucher %s)', row_to_json(r), no);
  end if;
  select refunded into r from public.finance_credit_note_totals where id = cn2;
  if r.refunded is distinct from 20.00 then fails := fails || format('the credit note shows %s refunded against it', r.refunded); end if;
  -- A refund is on Refunds and nowhere else: not a payment to a supplier, not a payment in.
  select count(*) into n from public.finance_refunds where org_id = org;
  if n <> 2 then fails := fails || format('finance_refunds shows %s rows, expected 2', n); end if;
  select count(*) into n from public.finance_payments_out where org_id = org;
  if n <> 2 then fails := fails || format('finance_payments_out shows %s rows; refunds must not appear there', n); end if;
  select count(*) into n from public.finance_payments_in where transaction_id in (rf1, rf2);
  if n <> 0 then fails := fails || format('finance_payments_in shows %s refund rows', n); end if;
  select count(*) into n from public.finance_refunds where transaction_id = rc;
  if n <> 0 then fails := array_append(fails, 'a payment in shows on finance_refunds'); end if;
  select coalesce(sum(paid), 0) as paid into r from public.supplier_bill_totals where org_id = org;
  if r.paid is distinct from 0.00 then fails := fails || format('refunds were counted as paid on bills: %s', r.paid); end if;

  -- ---- a refund that was paid out is locked; voided, it puts the credit back --
  fails := fails || public.bendahara_check_try('a refund that was paid out is edited', 'FIN09',
    format('update public.finance_transactions set amount = 1 where id = %L', rf2));
  fails := fails || public.bendahara_check_try('a refund that was paid out is deleted', 'FIN09',
    format('delete from public.finance_transactions where id = %L', rf2));
  fails := fails || public.bendahara_check_try('the reason of a refund that was paid out is changed', 'FIN09',
    format('update public.finance_allocations set reason = %L where transaction_id = %L', 'other', rf2));
  fails := fails || public.bendahara_check_try('a refund that was paid out is voided', 'ok',
    format('update public.finance_transactions set status = %L, updated_at = now() where id = %L', 'void', rf2));
  select * into r from public.finance_invoice_totals where id = ci;
  if (r.refunded, r.balance) is distinct from (20.00, -10.00) then
    fails := fails || format('after voiding a refund the invoice reads %s', row_to_json(r));
  end if;

  -- ---- a pending refund is looked at again when it is paid out ----------------
  rf3 := public.finance_record_refund(org,
    jsonb_build_object('invoice_id', ci, 'account_id', bank, 'method', 'cash', 'reason', 'other', 'amount', 10, 'status', 'scheduled'));
  -- The payment the credit came from is voided: the customer owes again.
  update public.finance_transactions set status = 'void', updated_at = now() where id = rc;
  select * into r from public.finance_invoice_totals where id = ci;
  if (r.paid, r.credited, r.refunded, r.balance, r.display_status) is distinct from (0.00, 60.00, 20.00, 92.50, 'sent') then
    fails := fails || format('with its payment voided the invoice reads %s', row_to_json(r));
  end if;
  -- The pending refund holds credit, not debt: a payment in may still take all that is owed, and no more.
  fails := fails || public.bendahara_check_try('a payment in of a sen more than is owed, with a refund pending', 'FIN05',
    format('select public.finance_record_payment_in(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx'), jsonb_build_array(jsonb_build_object('invoice_id', ci, 'amount', 92.51))));
  rc := public.finance_record_payment_in(org,
    jsonb_build_object('account_id', bank, 'method', 'fpx'),
    jsonb_build_array(jsonb_build_object('invoice_id', ci, 'amount', 92.5)));
  update public.finance_transactions set status = 'void', updated_at = now() where id = rc;
  fails := fails || public.bendahara_check_try('a pending refund is paid out after the credit has gone', 'FIN05',
    format('select public.finance_mark_payment_paid(%L, %L, current_date)', org, rf3));
  fails := fails || public.bendahara_check_try('a pending refund is deleted', 'ok',
    format('delete from public.finance_transactions where id = %L', rf3));
  select count(*) into n from public.finance_allocations where transaction_id = rf3;
  if n <> 0 then fails := array_append(fails, 'deleting a pending refund left its allocation'); end if;

  -- ---- a refund is never more than its credit note; direct writes ------------
  -- A second invoice, paid in full, with two credit notes: RM 70 in credit.
  ci2 := public.finance_save_invoice(org,
    jsonb_build_object('customer_id', cust, 'invoice_date', current_date, 'due_date', current_date + 30), one_line);
  perform public.finance_post_invoice(org, ci2);
  perform public.finance_record_payment_in(org,
    jsonb_build_object('account_id', bank, 'method', 'fpx'),
    jsonb_build_array(jsonb_build_object('invoice_id', ci2, 'amount', 132.5)));
  cna := public.finance_save_credit_note(org, jsonb_build_object('invoice_id', ci2, 'reason', 'overbilling', 'amount', 20));
  perform public.finance_issue_credit_note(org, cna);
  cnb := public.finance_save_credit_note(org, jsonb_build_object('invoice_id', ci2, 'reason', 'pricing_adjustment', 'amount', 50));
  perform public.finance_issue_credit_note(org, cnb);
  select balance into r from public.finance_invoice_totals where id = ci2;
  if r.balance is distinct from -70.00 then fails := fails || format('two credit notes on a paid invoice leave %s', r.balance); end if;

  insert into public.finance_transactions (org_id, direction, account_id, amount, method)
  values (org, 'out', bank, 5, 'cash') returning id into stray;
  fails := fails || public.bendahara_check_try('one allocation names an invoice and a credit note', '23514',
    format('insert into public.finance_allocations (org_id, transaction_id, invoice_id, credit_note_id, amount) values (%L, %L, %L, %L, 5)', org, stray, ci2, cna));
  fails := fails || public.bendahara_check_try('an allocation carries a reason that is not on the list', '23514',
    format('insert into public.finance_allocations (org_id, transaction_id, invoice_id, amount, reason) values (%L, %L, %L, 5, %L)', org, stray, ci2, 'because'));
  delete from public.finance_transactions where id = stray;
  insert into public.finance_transactions (org_id, direction, account_id, amount, method)
  values (org, 'in', bank, 5, 'cash') returning id into stray;
  fails := fails || public.bendahara_check_try('money in is put against a credit note', 'FIN04',
    format('insert into public.finance_allocations (org_id, transaction_id, credit_note_id, amount) values (%L, %L, %L, 5)', org, stray, cna));
  delete from public.finance_transactions where id = stray;

  cnt := public.finance_save_credit_note(org, jsonb_build_object('invoice_id', ci2, 'amount', 5));
  fails := fails || public.bendahara_check_try('a refund goes against a draft credit note, though the customer is in credit', 'FIN04',
    format('select public.finance_record_refund(%L, %L)', org,
      jsonb_build_object('credit_note_id', cnt, 'account_id', bank, 'method', 'fpx', 'amount', 5)));
  delete from public.finance_credit_notes where id = cnt;
  fails := fails || public.bendahara_check_try('a refund of a sen more than its credit note, though the customer is in credit for more', 'FIN05',
    format('select public.finance_record_refund(%L, %L)', org,
      jsonb_build_object('credit_note_id', cna, 'account_id', bank, 'method', 'fpx', 'amount', 20.01)));
  rf4 := public.finance_record_refund(org,
    jsonb_build_object('credit_note_id', cna, 'account_id', bank, 'method', 'fpx', 'reason', 'overpayment', 'amount', 20));
  fails := fails || public.bendahara_check_try('one more sen against a credit note that is refunded in full', 'FIN05',
    format('select public.finance_record_refund(%L, %L)', org,
      jsonb_build_object('credit_note_id', cna, 'account_id', bank, 'method', 'fpx', 'amount', 0.01)));
  rf3 := public.finance_record_refund(org,
    jsonb_build_object('invoice_id', ci2, 'account_id', bank, 'method', 'fpx', 'reason', 'order_cancelled', 'amount', 50, 'status', 'scheduled'));
  -- The other credit note has no refund of its own, but the pending refund on the invoice needs its credit.
  fails := fails || public.bendahara_check_try('a credit note a pending refund on the invoice needs is voided', 'FIN02',
    format('update public.finance_credit_notes set status = %L where id = %L', 'void', cnb));
  delete from public.finance_transactions where id = rf3;
  -- Without the refunded note the customer would still be RM 50 in credit, more than the RM 20 refunded. It is refused all the same.
  fails := fails || public.bendahara_check_try('a credit note with a refund on it is voided, though the other note covers the refund', 'FIN02',
    format('update public.finance_credit_notes set status = %L where id = %L', 'void', cna));
  fails := fails || public.bendahara_check_try('a credit note nothing leans on is voided', 'ok',
    format('update public.finance_credit_notes set status = %L, updated_at = now() where id = %L', 'void', cnb));
  select * into r from public.finance_invoice_totals where id = ci2;
  if (r.paid, r.credited, r.refunded, r.balance, r.display_status) is distinct from (132.50, 20.00, 20.00, 0.00, 'paid') then
    fails := fails || format('credited and refunded RM 20, the invoice reads %s', row_to_json(r));
  end if;
  fails := fails || public.bendahara_check_try('a void credit note is changed', 'FIN01',
    format('update public.finance_credit_notes set status = %L where id = %L', 'issued', cnb));

  -- ---- an invoice with a credit note cannot be voided -------------------------
  -- "theirs" has no money on it. A draft credit note is enough to hold it.
  cnt := public.finance_save_credit_note(org, jsonb_build_object('invoice_id', theirs, 'amount', 32.5));
  fails := fails || public.bendahara_check_try('an invoice with a draft credit note is voided', 'FIN12',
    format('update public.finance_invoices set status = %L where id = %L', 'void', theirs));
  perform public.finance_issue_credit_note(org, cnt);
  select balance || ' ' || display_status into t from public.finance_invoice_totals where id = theirs;
  if t is distinct from '100.00 sent' then fails := fails || format('a part-credited unpaid invoice reads %s', t); end if;
  fails := fails || public.bendahara_check_try('an invoice with an issued credit note is voided', 'FIN12',
    format('update public.finance_invoices set status = %L where id = %L', 'void', theirs));
  fails := fails || public.bendahara_check_try('a credit note with no refund is voided', 'ok',
    format('update public.finance_credit_notes set status = %L, updated_at = now() where id = %L', 'void', cnt));
  select balance || ' ' || display_status into t from public.finance_invoice_totals where id = theirs;
  if t is distinct from '132.50 sent' then fails := fails || format('with its credit note voided the invoice reads %s', t); end if;
  reset role;

  -- ==== as the editor: writes, and leaves their name on what they make =======
  perform set_config('request.jwt.claims', json_build_object('sub', editor_id, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  set local role authenticated;
  draft := public.finance_save_invoice(org,
    jsonb_build_object('customer_id', cust2, 'invoice_date', current_date, 'due_date', current_date + 30), one_line);
  perform public.finance_post_invoice(org, draft);
  rc1 := public.finance_record_payment_in(org,
    jsonb_build_object('account_id', bank, 'method', 'duitnow'),
    jsonb_build_array(jsonb_build_object('invoice_id', draft, 'amount', 50)));
  eq := public.finance_save_quotation(org,
    jsonb_build_object('customer_id', cust2, 'quote_date', current_date, 'valid_until', current_date + 14), one_line);
  perform public.finance_send_quotation(org, eq);
  ecn := public.finance_save_credit_note(org, jsonb_build_object('invoice_id', draft, 'reason', 'goodwill', 'amount', 10));
  perform public.finance_issue_credit_note(org, ecn);
  reset role;
  select count(*) into n from public.finance_invoices where id = draft and created_by = editor_id;
  if n <> 1 then fails := array_append(fails, 'an invoice does not record who made it'); end if;
  select (select count(*) from public.finance_quotations where id = eq and created_by = editor_id)
       + (select count(*) from public.finance_credit_notes where id = ecn and created_by = editor_id) into n;
  if n <> 2 then fails := array_append(fails, 'a quotation or a credit note does not record who made it'); end if;

  -- ==== as the viewer: reads everything, changes nothing =====================
  perform set_config('request.jwt.claims', json_build_object('sub', viewer_id, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  set local role authenticated;
  select count(*) into n from public.finance_invoice_totals where org_id = org;
  if n <> 8 then fails := fails || format('a viewer reads %s of 8 invoices', n); end if;
  select count(*) into n from public.finance_payments_in where org_id = org;
  if n <> 8 then fails := fails || format('a viewer reads %s of 8 payment-in rows', n); end if;
  select count(*) into n from public.finance_quotation_totals where org_id = org;
  if n <> 3 then fails := fails || format('a viewer reads %s of 3 quotations', n); end if;
  select count(*) into n from public.finance_credit_note_totals where org_id = org;
  if n <> 6 then fails := fails || format('a viewer reads %s of 6 credit notes', n); end if;
  select count(*) into n from public.finance_refunds where org_id = org;
  if n <> 3 then fails := fails || format('a viewer reads %s of 3 refunds', n); end if;
  fails := fails || public.bendahara_check_try('a viewer saves a quotation', '42501',
    format('select public.finance_save_quotation(%L, %L, %L)', org,
      jsonb_build_object('customer_id', cust, 'quote_date', current_date, 'valid_until', current_date), one_line));
  -- These three lock the row before they act, which a viewer may not do, so to them it is not there.
  fails := fails || public.bendahara_check_try('a viewer sends a quotation', 'FIN11',
    format('select public.finance_send_quotation(%L, %L)', org, eq));
  fails := fails || public.bendahara_check_try('a viewer converts a quotation', 'FIN11',
    format('select public.finance_convert_quotation(%L, %L)', org, qt2));
  fails := fails || public.bendahara_check_try('a viewer issues a credit note', 'FIN11',
    format('select public.finance_issue_credit_note(%L, %L)', org, ecn));
  fails := fails || public.bendahara_check_try('a viewer saves a credit note', '42501',
    format('select public.finance_save_credit_note(%L, %L)', org, jsonb_build_object('invoice_id', theirs, 'amount', 1)));
  fails := fails || public.bendahara_check_try('a viewer records a refund', '42501',
    format('select public.finance_record_refund(%L, %L)', org,
      jsonb_build_object('invoice_id', ci, 'account_id', bank, 'method', 'fpx', 'amount', 1)));
  update public.finance_quotations set status = 'declined', accepted_at = null where id = qt2;
  get diagnostics n = row_count;
  if n <> 0 then fails := array_append(fails, 'a viewer changed a quotation'); end if;
  update public.finance_credit_notes set status = 'void' where id = ecn;
  get diagnostics n = row_count;
  if n <> 0 then fails := array_append(fails, 'a viewer voided a credit note'); end if;
  delete from public.finance_quotation_lines where quotation_id = eq;
  get diagnostics n = row_count;
  if n <> 0 then fails := array_append(fails, 'a viewer deleted quotation lines'); end if;
  fails := fails || public.bendahara_check_try('a viewer saves an invoice', '42501',
    format('select public.finance_save_invoice(%L, %L, %L)', org,
      jsonb_build_object('customer_id', cust, 'invoice_date', current_date, 'due_date', current_date), one_line));
  fails := fails || public.bendahara_check_try('a viewer records a payment in', '42501',
    format('select public.finance_record_payment_in(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx'), jsonb_build_array(jsonb_build_object('invoice_id', theirs, 'amount', 1))));
  -- The function locks the invoice for update, which a viewer may not do, so to them it is not there.
  fails := fails || public.bendahara_check_try('a viewer posts an invoice', 'FIN11',
    format('select public.finance_post_invoice(%L, %L)', org, theirs));
  update public.finance_invoices set status = 'void' where id = theirs;
  get diagnostics n = row_count;
  if n <> 0 then fails := array_append(fails, 'a viewer voided an invoice'); end if;
  delete from public.finance_invoice_lines where invoice_id = theirs;
  get diagnostics n = row_count;
  if n <> 0 then fails := array_append(fails, 'a viewer deleted invoice lines'); end if;
  reset role;

  -- ==== as the owner of another workspace: sees and touches nothing ==========
  perform set_config('request.jwt.claims', json_build_object('sub', outsider, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  set local role authenticated;
  foreach t in array array['finance_invoices','finance_invoice_lines','finance_invoice_totals','finance_payments_in',
                           'finance_quotations','finance_quotation_lines','finance_quotation_totals',
                           'finance_credit_notes','finance_credit_note_totals','finance_refunds'] loop
    execute format('select count(*) from public.%I where org_id = %L', t, org) into n;
    if n <> 0 then fails := fails || format('another workspace reads %s rows of %s', n, t); end if;
  end loop;
  fails := fails || public.bendahara_check_try('another workspace saves a quotation here', '42501',
    format('select public.finance_save_quotation(%L, %L, %L)', org,
      jsonb_build_object('customer_id', cust, 'quote_date', current_date, 'valid_until', current_date), one_line));
  fails := fails || public.bendahara_check_try('another workspace converts a quotation here', 'FIN11',
    format('select public.finance_convert_quotation(%L, %L)', org, qt2));
  -- Their own workspace, an invoice from this one: the invoice is not found there.
  fails := fails || public.bendahara_check_try('another workspace credits an invoice here', '23503',
    format('select public.finance_save_credit_note(%L, %L)', other_org, jsonb_build_object('invoice_id', theirs, 'amount', 1)));
  fails := fails || public.bendahara_check_try('another workspace refunds an invoice here', 'FIN06',
    format('select public.finance_record_refund(%L, %L)', other_org,
      jsonb_build_object('invoice_id', ci, 'account_id', bank, 'method', 'fpx', 'amount', 1)));
  fails := fails || public.bendahara_check_try('another workspace saves an invoice here', '42501',
    format('select public.finance_save_invoice(%L, %L, %L)', org,
      jsonb_build_object('customer_id', cust, 'invoice_date', current_date, 'due_date', current_date), one_line));
  fails := fails || public.bendahara_check_try('another workspace posts an invoice here', 'FIN11',
    format('select public.finance_post_invoice(%L, %L)', org, theirs));
  fails := fails || public.bendahara_check_try('another workspace is paid for an invoice here', 'FIN06',
    format('select public.finance_record_payment_in(%L, %L, %L)', other_org,
      jsonb_build_object('account_id', bank, 'method', 'fpx'), jsonb_build_array(jsonb_build_object('invoice_id', theirs, 'amount', 1))));
  reset role;

  -- ==== a user is deleted: created_by is cleared on posted and void rows =====
  -- If the delete is stopped by something outside finance, the clearing its
  -- foreign keys would have done is done by hand, and the message says so.
  begin
    delete from auth.users where id = editor_id;
  exception when others then
    if sqlstate like 'FIN%' then raise; end if;
    notes := array_append(notes, format('deleting a user was stopped outside finance (%s: %s), so created_by was cleared by hand', sqlstate, sqlerrm));
    update public.finance_invoices set created_by = null where created_by = editor_id;
    update public.finance_transactions set created_by = null where created_by = editor_id;
    update public.finance_quotations set created_by = null where created_by = editor_id;
    update public.finance_credit_notes set created_by = null where created_by = editor_id;
  end;
  select (select count(*) from public.finance_quotations where id = eq and status = 'sent' and created_by is null)
       + (select count(*) from public.finance_credit_notes where id = ecn and status = 'issued' and created_by is null) into n;
  if n <> 2 then fails := array_append(fails, 'deleting a user did not clear created_by on their sent quotation and issued credit note'); end if;
  select count(*) into n from public.finance_invoices where id = draft and status = 'posted' and created_by is null;
  if n <> 1 then fails := array_append(fails, 'deleting a user did not clear created_by on their posted invoice'); end if;
  select count(*) into n from public.finance_transactions where id = rc1 and status = 'posted' and created_by is null;
  if n <> 1 then fails := array_append(fails, 'deleting a user did not clear created_by on their posted payment in'); end if;
  begin
    delete from auth.users where id = owner_id;
  exception when others then
    if sqlstate like 'FIN%' then raise; end if;
    update public.finance_invoices set created_by = null where created_by = owner_id;
    update public.finance_transactions set created_by = null where created_by = owner_id;
    update public.finance_quotations set created_by = null where created_by = owner_id;
    update public.finance_credit_notes set created_by = null where created_by = owner_id;
  end;
  select (select count(*) from public.finance_quotations where id = qt and status = 'accepted' and created_by is null)
       + (select count(*) from public.finance_credit_notes where id = cnb and status = 'void' and created_by is null)
       + (select count(*) from public.finance_transactions where id = rf4 and status = 'posted' and created_by is null) into n;
  if n <> 3 then fails := array_append(fails, 'deleting a user did not clear created_by on their accepted quotation, void credit note and refund'); end if;
  select count(*) into n from public.finance_invoices where id = inv and status = 'void' and created_by is null;
  if n <> 1 then fails := array_append(fails, 'deleting a user did not clear created_by on their void invoice'); end if;

  -- ==== the workspace is deleted, with everything in it =======================
  delete from public.orgs where id = org;
  select (select count(*) from public.finance_invoices where org_id = org)
       + (select count(*) from public.finance_invoice_lines where org_id = org)
       + (select count(*) from public.finance_allocations where org_id = org)
       + (select count(*) from public.finance_transactions where org_id = org)
       + (select count(*) from public.finance_quotations where org_id = org)
       + (select count(*) from public.finance_quotation_lines where org_id = org)
       + (select count(*) from public.finance_credit_notes where org_id = org)
       + (select count(*) from public.supplier_bills where org_id = org) into n;
  if n <> 0 then fails := fails || format('deleting the workspace left %s finance rows', n); end if;

  fails := array_remove(fails, null);
  if array_length(fails, 1) is null then
    raise exception 'BENDAHARA_FOLLOWONS_CHECK PASSED (everything rolled back)%',
      case when array_length(notes, 1) is null then '' else ' NOTE: ' || array_to_string(notes, ' | ') end;
  end if;
  raise exception 'BENDAHARA_FOLLOWONS_CHECK FAILED: %', array_to_string(fails, ' | ');
end $$;
```

- [ ] **Step 7: Keep the stage 3a check script passing**

The 3a script lists the check constraints on `finance_allocations` by name. This migration adds one. Everything else that script expects still holds after the migration, so this one line is all that changes.

In `supabase/tests/bendahara_invoices_check.sql`, replace:

```sql
  if t is distinct from 'finance_allocations_amount_check,finance_allocations_one_document_check' then
```

with:

```sql
  -- The sales follow-ons migration adds the third; without it the list is the first two.
  if t is distinct from 'finance_allocations_amount_check,finance_allocations_one_document_check,finance_allocations_reason_check' then
```

- [ ] **Step 8: Type-check and lint**

Run: `pnpm exec tsc --noEmit` then `pnpm lint`
Expected: no errors and no warnings. (Only the test file is TypeScript; the SQL is checked by the controller.)

Run: `grep -c "errcode = 'FIN1[23]'" supabase/migrations/20261022100000_bendahara_sales_followons.sql`
Expected: `3` (one `FIN12`, two `FIN13`).

- [ ] **Step 9: Commit**

```bash
git add supabase/migrations/20261022100000_bendahara_sales_followons.sql supabase/migrations/20261022100100_bendahara_sales_followons_seed.sql supabase/tests/bendahara_followons_check.sql supabase/tests/bendahara_invoices_check.sql tests/bendahara-followons.test.ts
git commit -m "feat: quotations, credit notes and refunds for finance, with one definition of what an invoice owes"
```

**Controller gate. Tasks 2 to 8 can be built while it is open, but nothing merges until step 13 has passed.**

- [ ] **Step 10 (controller): Dry-run the schema migration on the hosted database**

First confirm the database role can act as a signed-in user. With the `openkuasa-supabase` MCP `execute_sql`:

```sql
do $$ begin set local role authenticated; reset role; raise exception 'ROLE_SWITCH_OK'; end $$;
```

Expected: an error whose message is `ROLE_SWITCH_OK`. A permission error instead means the check cannot run this way: stop and tell the owner.

Then send, in one `execute_sql` call: `begin;`, the "before" block, the whole of `supabase/migrations/20261022100000_bendahara_sales_followons.sql`, the "after" block, the whole of `supabase/tests/bendahara_followons_check.sql`, and `rollback;`.

Before the migration:

```sql
create temp table before_bills on commit drop as
select id, total, paid, balance, display_status from public.supplier_bill_totals;
create temp table before_out on commit drop as
select allocation_id, amount, transaction_amount, status, number, bill_no from public.finance_payments_out;
create temp table before_invoices on commit drop as
select id, subtotal, sst, total, paid, balance, display_status, status, invoice_no, einvoice_status from public.finance_invoice_totals;
create temp table before_in on commit drop as
select allocation_id, amount, transaction_amount, status, number, invoice_no from public.finance_payments_in;
```

After the migration:

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
  where (t.subtotal, t.sst, t.total, t.paid, t.balance, t.display_status, t.status, t.invoice_no, t.einvoice_status)
        is distinct from (x.subtotal, x.sst, x.total, x.paid, x.balance, x.display_status, x.status, x.invoice_no, x.einvoice_status);
  if n <> 0 then raise exception 'DRYRUN FAILED: % invoices read differently after the migration', n; end if;
  select count(*) into n
  from before_in x full join public.finance_payments_in t on t.allocation_id = x.allocation_id
  where (t.amount, t.transaction_amount, t.status, t.number, t.invoice_no)
        is distinct from (x.amount, x.transaction_amount, x.status, x.number, x.invoice_no);
  if n <> 0 then raise exception 'DRYRUN FAILED: % payment-in rows read differently after the migration', n; end if;
  -- Nothing is credited or refunded yet, and no refund row exists.
  select count(*) into n from public.finance_invoice_totals where credited <> 0 or refunded <> 0;
  if n <> 0 then raise exception 'DRYRUN FAILED: % invoices show a credit or a refund before any exists', n; end if;
  select count(*) into n from public.finance_refunds;
  if n <> 0 then raise exception 'DRYRUN FAILED: finance_refunds shows % rows before any refund exists', n; end if;
end $$;
```

Expected: an error whose message is `BENDAHARA_FOLLOWONS_CHECK PASSED (everything rolled back)`. A `NOTE:` after it means deleting the check's own users was stopped by something outside finance and `created_by` was cleared by hand instead; read it, it is not a failure.

- `DRYRUN FAILED: …` means existing bills, payments out, invoices or payments in read differently after the migration, or the new columns are not zero where nothing has been credited or refunded. Stop: a guard or the view is wrong. This is the comparison that protects production's live screens; do not go on with it failing.
- `BENDAHARA_FOLLOWONS_CHECK FAILED: …` lists each expectation that did not hold, separated by ` | `.
- `constraint "finance_allocations_one_document_check" of relation "finance_allocations" does not exist` means the hosted constraint has another name. Run `select conname, pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.finance_allocations'::regclass and contype = 'c';` and change the migration's `drop constraint` to match.
- `check constraint "finance_allocations_reason_check" of relation "finance_allocations" is violated by some row` means something has written a `reason` that is not one of the five words. Nothing in the app does. Run `select reason, count(*) from public.finance_allocations where reason is not null group by 1;` and take the result to the owner before changing anything.
- Any other error is the migration or the script failing outright; the message names the statement. An error on the insert into `auth.users` or `public.orgs` is the script's own set-up, not the migration: add the column the message names and run again.

On any failure: fix the file on the branch, commit the fix, and dry-run again from the top. Nothing has been applied, so the migration file itself is edited.

Then confirm nothing was left: `select to_regclass('public.finance_quotations') is null;` → `true`.

What the check covers, for the record. The 3a flows through the new guards: save → post → pay in part → pay the rest → void a payment → void refused with money on it → void once it is free → delete a draft; one payment across two invoices; money out against an invoice that is owed and money in against a bill (both `FIN04`, as before); a split payment that cannot shrink or turn round; the whole bill flow (schedule, over-pay refused, pay, mark paid, void refused, void). Then: a quotation saved, sent, locked, accepted, declined, accepted again, converted, converted again after its invoice is deleted and after it is voided, and expired; a credit note saved, capped, issued, locked; on one invoice, a payment in and a refund tried a sen either side of what the view says after each step; a pending refund that holds credit, is paid out, voided, and refused once its credit has gone; refunds kept off Payments Out and Payments In; voids refused while anything leans on the document; an editor, a viewer and another workspace's owner; deleting the users who made the documents; deleting the workspace with all of it inside.

- [ ] **Step 11 (controller): Dry-run the seed**

Send, in one `execute_sql` call: `begin;`, the whole schema migration, the whole of `supabase/migrations/20261022100100_bendahara_sales_followons_seed.sql` **twice**, this block, and `rollback;`.

```sql
do $$
declare
  demo uuid;
  r text;
begin
  select id into demo from public.orgs where slug = 'rimba-ventures-demo';
  select format(
    'quotations=%s (%s) open=%s | credit notes=%s (%s) credited=%s | refunds=%s rows (%s) | in credit=%s | '
    || 'invoices=%s receivable=%s | payments in=%s rows, payments out=%s rows, bills paid=%s | sequences: %s',
    (select count(*) from public.finance_quotation_totals where org_id = demo),
    (select string_agg(display_status || '=' || n, ', ' order by display_status)
       from (select display_status, count(*) n from public.finance_quotation_totals where org_id = demo group by 1) s),
    (select sum(total) from public.finance_quotation_totals where org_id = demo and display_status = 'sent'),
    (select count(*) from public.finance_credit_note_totals where org_id = demo),
    (select string_agg(status || '=' || n, ', ' order by status)
       from (select status, count(*) n from public.finance_credit_note_totals where org_id = demo group by 1) s),
    (select sum(amount) from public.finance_credit_note_totals where org_id = demo and status = 'issued'),
    (select count(*) from public.finance_refunds where org_id = demo),
    (select string_agg(status || '=' || n || ' RM ' || total, ', ' order by status)
       from (select status, count(*) n, sum(amount) total from public.finance_refunds where org_id = demo group by 1) s),
    (select coalesce(sum(-balance), 0) from public.finance_invoice_totals where org_id = demo and status = 'posted' and balance < 0),
    (select count(*) from public.finance_invoice_totals where org_id = demo),
    (select sum(balance) from public.finance_invoice_totals where org_id = demo and display_status in ('sent','overdue')),
    (select count(*) from public.finance_payments_in where org_id = demo),
    (select count(*) from public.finance_payments_out where org_id = demo),
    (select sum(paid) from public.supplier_bill_totals where org_id = demo),
    (select string_agg(doc_type || '=' || next_number, ', ' order by doc_type)
       from public.finance_sequences where org_id = demo and doc_type in ('quotation','credit_note','voucher')))
  into r;
  raise exception 'SEED DRYRUN, rolling back: %', r;
end $$;
```

Expected: an error starting `SEED DRYRUN, rolling back:` with

`quotations=15 (accepted=6, declined=2, draft=1, expired=3, sent=3) open=20500.00 | credit notes=9 (draft=1, issued=8) credited=3890.00 | refunds=6 rows (posted=4 RM 1770.00, scheduled=2 RM 1000.00) | in credit=1600.00 | invoices=18 receivable=20460.00 |`

then `payments in=14 rows`, and `payments out=` and `bills paid=` exactly what the demo workspace has today (run `select count(*) from public.finance_payments_out p join public.orgs o on o.id = p.org_id where o.slug = 'rimba-ventures-demo';` and `select sum(paid) from public.supplier_bill_totals t join public.orgs o on o.id = t.org_id where o.slug = 'rimba-ventures-demo';` first: the seed must not move either), then `sequences: credit_note=38, quotation=228, voucher=5` (`voucher` is 4 more than the demo's next `PV-` number was; 5 when it has never had one).

Running the seed twice and still counting 15, 9 and 6 is the proof it does nothing the second time. Other readings:

- `quotations=0` means the demo workspace was not found by its slug.
- `receivable=20980.00` with fewer credit notes means `INV-1037` is not there or not posted, so its credit note was left out; fewer than 8 issued credit notes means the same for another invoice. The seed leaves out what it cannot attach rather than failing. Tell the owner which invoices are missing before applying.
- `receivable=` anything else: the demo's invoices are not what stage 3a seeded. Stop and compare with `select invoice_no, total, paid, balance, display_status from public.finance_invoice_totals t join public.orgs o on o.id = t.org_id where o.slug = 'rimba-ventures-demo' order by 1;`.
- The seed ending in `FIN04` or `FIN05` means a guard refused a seeded row: a seeded invoice has been paid or voided differently on the hosted database. The message names the rule.

The receivable was `20980.00` after stage 3a. It is `20460.00` here because one seeded credit note, RM 520.00, is against `INV-1037`, which is still owed. That is intended (Decision 14).

- [ ] **Step 12 (controller): Apply the schema migration, on the owner's explicit go-ahead**

Stop and ask the owner first. Apply `20261022100000_bendahara_sales_followons.sql` with `apply_migration`, name `bendahara_sales_followons`. One `apply_migration` call at a time. Do not apply the seed yet: it goes in after the deploy (Step 14).

- [ ] **Step 13 (controller): Check the applied schema**

Send the whole of `supabase/tests/bendahara_followons_check.sql` by itself with `execute_sql`.
Expected: `BENDAHARA_FOLLOWONS_CHECK PASSED (everything rolled back)`.

Send the whole of `supabase/tests/bendahara_invoices_check.sql` by itself with `execute_sql`.
Expected: `BENDAHARA_INVOICES_CHECK PASSED (everything rolled back)`. This is the 3a script with one line changed (Step 7); it passing is a second proof that invoices and bills behave as they did.

Open production's Invoices, Payments In, Supplier Bills and Payments Out in the demo workspace: the same figures as before the migration. (Total receivable is still RM 21.0k: the seed is not in yet.)

Run: `pnpm exec vitest run tests/bendahara-purchases.test.ts tests/bendahara-foundation.rls.test.ts tests/bendahara-sales.test.ts tests/bendahara-followons.test.ts`
Expected: every test in the first three files passes, **unchanged from before this stage**: that is the proof the rewritten guards treat bills and invoices as they did. In `tests/bendahara-followons.test.ts` every test passes except the last, 'a demo viewer reads the seeded quotations, credit notes and refunds, and can write none', which fails until Step 14.

If a test fails for a reason in the SQL: the migration is applied now, so the fix is a new corrective migration file, never an edit to the applied one.

- [ ] **Step 14 (controller): Apply the seed, after the new code is deployed**

Once the branch is merged and production serves the new code (Task 8, the hand-back step), with the owner's go-ahead: apply `20261022100100_bendahara_sales_followons_seed.sql` with `apply_migration`, name `bendahara_sales_followons_seed`.

Run: `pnpm exec vitest run tests/bendahara-followons.test.ts tests/bendahara-sales.test.ts`
Expected: PASS, every test, in both files.

Why after the deploy: the seed puts three of the demo's paid invoices in credit. The code deployed before this stage prints a balance as it is, so until the new code is live the demo's Invoices table would show "RM -600.00". If the deploy is ever rolled back after the seed, that is what the demo shows; nothing else is affected.

---

### Task 2: Quotations data layer

**Files:**
- Create: `tests/finance-quotations.test.ts`
- Create: `src/lib/finance/quotations.ts`
- Modify: `tests/finance-schemas.test.ts`

**Interfaces:**
- Consumes: `DOCUMENT_LINES_MAX`, `DOCUMENT_LINE_COLUMNS`, `DocumentLineRow`, `LINE_MESSAGES`, `documentLine`, `isoDate`, `optionalText`, `toDocumentLine` from `./document-lines`; `FinResult`, `FinanceWriteContext`, `NOT_ALLOWED`, `PG_FORBIDDEN`, `PG_FOREIGN_KEY`, `PG_OUT_OF_RANGE`, `PG_UNIQUE`, `TOO_LARGE`, `pgCode`, `writeFailed` from `./result`; `fakeFinance` from `tests/setup/fake-finance.ts`; the view `finance_quotation_totals`, the table `finance_quotation_lines` and the functions `finance_save_quotation`, `finance_send_quotation`, `finance_convert_quotation` (Task 1).
- Produces:
  - `saveQuotationInput` (`{ id?, customer_id, quote_date, valid_until, notes, lines }`), `quotationIdInput` (`{ id }`)
  - `type QuotationStatus = 'draft' | 'sent' | 'accepted' | 'declined'`, `type QuotationDisplayStatus = QuotationStatus | 'expired'`
  - `type QuotationListRow = { id; quotation_no: string | null; customer_id; customer_name; quote_date; valid_until; total: number; display_status: QuotationDisplayStatus; accepted_on: string | null; invoice_id: string | null; invoice_no: string | null }`
  - `type QuotationDetail = QuotationListRow & { subtotal; sst; notes; lines: QuotationLine[] }`
  - `listQuotations(ctx): Promise<QuotationListRow[]>`, `getQuotation(ctx, id): Promise<QuotationDetail | null>`
  - `saveQuotation(ctx, input): Promise<FinResult<{ id: string }>>`
  - `sendQuotation(ctx, { id }): Promise<FinResult<{ id: string; quotation_no: string }>>`
  - `acceptQuotation(ctx, { id })`, `declineQuotation(ctx, { id })`, `deleteQuotation(ctx, { id })`: `Promise<FinResult<{ id: string }>>`
  - `convertQuotation(ctx, { id }): Promise<FinResult<{ id: string; invoice_id: string }>>`

`accepted_on` is a date, not the view's timestamp: the view's `accepted_at` is cut to its first ten characters, which is the UTC date because the database answers in UTC. "Accepted (MTD)" and the trend use it.

- [ ] **Step 1: Write the failing tests**

Create `tests/finance-quotations.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  QUOTATION_PAGE_SIZE,
  acceptQuotation,
  convertQuotation,
  declineQuotation,
  deleteQuotation,
  getQuotation,
  listQuotations,
  saveQuotation,
  saveQuotationInput,
  sendQuotation,
} from '@/lib/finance/quotations';
import { fakeFinance } from './setup/fake-finance';

const ID = '33333333-3333-4333-8333-333333333333';
const CUSTOMER = '44444444-4444-4444-8444-444444444444';
const INVOICE = '55555555-5555-4555-8555-555555555555';

const line = { description: 'Design work', quantity: 10, unit_price: 12.5 };
const valid = { customer_id: CUSTOMER, quote_date: '2026-10-01', valid_until: '2026-10-31', lines: [line] };

let logged: ReturnType<typeof vi.spyOn>;
beforeEach(() => { logged = vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { logged.mockRestore(); });

const first = (value: unknown) => saveQuotationInput.safeParse(value).error?.issues[0]?.message;

describe('saveQuotationInput', () => {
  it('asks for a customer', () => {
    expect(first({ ...valid, customer_id: '' })).toBe('Choose a customer.');
    expect(first({ ...valid, customer_id: undefined })).toBe('Choose a customer.');
  });
  it('asks for real dates, with the valid-until date not before the quotation date', () => {
    expect(first({ ...valid, quote_date: '01/10/2026' })).toBe('Enter a valid date.');
    expect(first({ ...valid, valid_until: '2026-02-30' })).toBe('Enter a valid date.');
    expect(first({ ...valid, valid_until: '2026-09-30' })).toBe('The valid-until date cannot be before the quotation date.');
    expect(first({ ...valid, valid_until: '2026-10-01' })).toBeUndefined();
  });
  it('asks for at least one line, and not more than 100, with the sentences an invoice line uses', () => {
    expect(first({ ...valid, lines: [] })).toBe('Add at least one line.');
    expect(first({ ...valid, lines: Array.from({ length: 101 }, () => line) })).toBe('A quotation can have at most 100 lines.');
    expect(first({ ...valid, lines: [{ ...line, description: '  ' }] })).toBe('Describe each line.');
    expect(first({ ...valid, lines: [{ ...line, quantity: 0.0004 }] })).toBe('Enter a quantity above 0.');
    expect(first({ ...valid, lines: [{ ...line, sst_rate: 100.005 }] })).toBe('Enter an SST rate between 0 and 100.');
  });
  it('has no place for a number, a status or the date it was accepted: the database gives those', () => {
    const parsed = saveQuotationInput.parse({ ...valid, notes: '  ', quotation_no: 'QT-9999', status: 'accepted', accepted_at: '2026-10-02' });
    expect(Object.keys(parsed).sort()).toEqual(['customer_id', 'lines', 'notes', 'quote_date', 'valid_until']);
    expect(parsed.notes).toBeNull();
  });
});

describe('quotation reads', () => {
  const row = (n: number, extra: Record<string, unknown> = {}) => ({
    id: `qt-${n}`, quotation_no: `QT-${n}`, customer_id: 'c1', customer_name: 'Aisyah Trading',
    quote_date: '2026-10-01', valid_until: '2026-10-31', total: '132.50', display_status: 'sent',
    accepted_at: null, invoice_id: null, invoice_no: null, ...extra,
  });
  /** The row as the data layer hands it on: `accepted_at` becomes the date `accepted_on`. */
  const read = (n: number, extra: Record<string, unknown> = {}) => {
    const rest: Record<string, unknown> = { ...row(n) };
    delete rest.accepted_at;
    return { ...rest, total: 132.5, accepted_on: null, ...extra };
  };

  it('lists from the totals view, in the caller’s workspace, newest first, with the total as a number', async () => {
    const { ctx, calls } = fakeFinance({ data: [row(1)], error: null });
    expect(await listQuotations(ctx)).toEqual([read(1)]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      name: 'finance_quotation_totals',
      op: 'select',
      filters: { org_id: 'org-1' },
      order: ['quote_date desc', 'id asc'],
      range: [0, QUOTATION_PAGE_SIZE - 1],
    });
  });
  it('gives the day a quotation was accepted as a UTC date, and the invoice made from it', async () => {
    const accepted = row(2, { display_status: 'accepted', accepted_at: '2026-10-08T23:30:00+00:00', invoice_id: INVOICE, invoice_no: null });
    const { ctx } = fakeFinance({ data: [accepted], error: null });
    expect(await listQuotations(ctx)).toEqual([
      read(2, { display_status: 'accepted', accepted_on: '2026-10-08', invoice_id: INVOICE, invoice_no: null }),
    ]);
  });
  it('reads on past a full page, so a long book is never cut short', async () => {
    const full = Array.from({ length: QUOTATION_PAGE_SIZE }, (_, n) => row(n));
    const { ctx, calls } = fakeFinance((call) => ({ data: call.range?.[0] === 0 ? full : [row(-1)], error: null }));
    expect(await listQuotations(ctx)).toHaveLength(QUOTATION_PAGE_SIZE + 1);
    expect(calls.map((c) => c.range)).toEqual([[0, QUOTATION_PAGE_SIZE - 1], [QUOTATION_PAGE_SIZE, 2 * QUOTATION_PAGE_SIZE - 1]]);
  });
  it('throws a read error for the screen’s error page', async () => {
    const { ctx } = fakeFinance({ data: null, error: { code: 'XX000', message: 'boom' } });
    await expect(listQuotations(ctx)).rejects.toMatchObject({ code: 'XX000' });
  });
  it('reads one quotation with its lines in the order they were entered', async () => {
    const lines = [
      { id: 'l1', product_id: null, description: 'Design work', quantity: '10.000', uom: null, pack_size: null, unit_price: '12.5000', sst_rate: '6.00', amount: '125.00', sst_amount: '7.50' },
    ];
    const { ctx, calls } = fakeFinance((call) =>
      call.name === 'finance_quotation_totals'
        ? { data: { ...row(1), subtotal: '125.00', sst: '7.50', notes: 'Valid for 30 days' }, error: null }
        : { data: lines, error: null },
    );
    const quotation = await getQuotation(ctx, ID);
    expect(quotation).toEqual({
      ...read(1), subtotal: 125, sst: 7.5, notes: 'Valid for 30 days',
      lines: [{ ...lines[0], quantity: 10, unit_price: 12.5, sst_rate: 6, amount: 125, sst_amount: 7.5 }],
    });
    expect(calls[0].filters).toEqual({ org_id: 'org-1', id: ID });
    expect(calls[1]).toMatchObject({ name: 'finance_quotation_lines', filters: { org_id: 'org-1', quotation_id: ID }, order: ['position asc', 'id asc'] });
  });
  it('answers null for a quotation that is not there, and for an id that is not an id, without asking the database', async () => {
    const missing = fakeFinance({ data: null, error: null });
    expect(await getQuotation(missing.ctx, ID)).toBeNull();
    const bad = fakeFinance({ data: null, error: null });
    expect(await getQuotation(bad.ctx, 'nope')).toBeNull();
    expect(bad.calls).toEqual([]);
  });
});

describe('quotation writes', () => {
  it('saves through the database function, in the caller’s workspace', async () => {
    const { ctx, calls } = fakeFinance({ data: ID, error: null });
    expect(await saveQuotation(ctx, { ...valid, id: ID })).toEqual({ ok: true, data: { id: ID } });
    expect(calls[0]).toMatchObject({ kind: 'rpc', name: 'finance_save_quotation' });
    expect(calls[0].args).toEqual({
      target_org: 'org-1',
      quotation: { id: ID, customer_id: CUSTOMER, quote_date: '2026-10-01', valid_until: '2026-10-31', notes: null },
      lines: [{ product_id: null, description: 'Design work', quantity: 10, uom: null, pack_size: null, unit_price: 12.5, sst_rate: 0 }],
    });
  });
  it('sends and returns the number', async () => {
    const { ctx, calls } = fakeFinance({ data: 'QT-0007', error: null });
    expect(await sendQuotation(ctx, { id: ID })).toEqual({ ok: true, data: { id: ID, quotation_no: 'QT-0007' } });
    expect(calls[0]).toMatchObject({ kind: 'rpc', name: 'finance_send_quotation' });
    expect(calls[0].args).toEqual({ target_org: 'org-1', target_quotation: ID });
  });
  it('records a yes with the moment it was given, and a no with none', async () => {
    const yes = fakeFinance({ data: { id: ID }, error: null });
    expect(await acceptQuotation(yes.ctx, { id: ID })).toEqual({ ok: true, data: { id: ID } });
    expect(yes.calls[0]).toMatchObject({ name: 'finance_quotations', op: 'update', filters: { id: ID, org_id: 'org-1' } });
    expect(Object.keys(yes.calls[0].values!).sort()).toEqual(['accepted_at', 'status', 'updated_at']);
    expect(yes.calls[0].values).toMatchObject({ status: 'accepted' });
    expect(yes.calls[0].values!.accepted_at).toBe(yes.calls[0].values!.updated_at);
    expect(String(yes.calls[0].values!.accepted_at)).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const no = fakeFinance({ data: { id: ID }, error: null });
    expect(await declineQuotation(no.ctx, { id: ID })).toEqual({ ok: true, data: { id: ID } });
    expect(no.calls[0].values).toMatchObject({ status: 'declined', accepted_at: null });
  });
  it('deletes a draft, scoped to the workspace', async () => {
    const { ctx, calls } = fakeFinance({ data: { id: ID }, error: null });
    expect(await deleteQuotation(ctx, { id: ID })).toEqual({ ok: true, data: { id: ID } });
    expect(calls[0]).toMatchObject({ name: 'finance_quotations', op: 'delete', filters: { id: ID, org_id: 'org-1' } });
  });
  it('converts through the database function and answers with the new invoice', async () => {
    const { ctx, calls } = fakeFinance({ data: INVOICE, error: null });
    expect(await convertQuotation(ctx, { id: ID })).toEqual({ ok: true, data: { id: ID, invoice_id: INVOICE } });
    expect(calls[0]).toMatchObject({ kind: 'rpc', name: 'finance_convert_quotation' });
    expect(calls[0].args).toEqual({ target_org: 'org-1', target_quotation: ID });
  });
  it('turns each database refusal into a sentence', async () => {
    const cases: [string, string][] = [
      ['FIN01', 'This quotation has already been sent or answered, so that can no longer be done.'],
      ['FIN04', 'Only an accepted quotation can be made into an invoice.'],
      ['FIN10', 'A quotation needs at least one line with an amount.'],
      ['FIN11', 'That quotation no longer exists.'],
      ['FIN13', 'This quotation already has an invoice. Void that invoice, or delete it if it is a draft, first.'],
      ['23505', 'That quotation number is already used.'],
      ['23503', 'The customer or a product on this quotation no longer exists.'],
      ['42501', 'You do not have permission to make changes here.'],
      ['22003', 'That amount is too large.'],
    ];
    for (const [code, message] of cases) {
      const { ctx } = fakeFinance({ data: null, error: { code } });
      expect(await saveQuotation(ctx, valid), code).toEqual({ ok: false, error: message });
      expect(await sendQuotation(ctx, { id: ID }), code).toEqual({ ok: false, error: message });
      expect(await acceptQuotation(ctx, { id: ID }), code).toEqual({ ok: false, error: message });
      expect(await declineQuotation(ctx, { id: ID }), code).toEqual({ ok: false, error: message });
      expect(await deleteQuotation(ctx, { id: ID }), code).toEqual({ ok: false, error: message });
      if (code !== '23505') expect(await convertQuotation(ctx, { id: ID }), code).toEqual({ ok: false, error: message });
    }
    expect(logged).not.toHaveBeenCalled();
  });
  it('words two conversions at the same moment as the quotation having an invoice, not as a number being used', async () => {
    const { ctx } = fakeFinance({ data: null, error: { code: '23505' } });
    expect(await convertQuotation(ctx, { id: ID })).toEqual({
      ok: false,
      error: 'This quotation already has an invoice. Void that invoice, or delete it if it is a draft, first.',
    });
  });
  it('says the quotation is gone when an answer or a delete touches no row', async () => {
    const { ctx } = fakeFinance({ data: null, error: null });
    for (const write of [acceptQuotation, declineQuotation, deleteQuotation]) {
      expect(await write(ctx, { id: ID })).toEqual({ ok: false, error: 'That quotation no longer exists.' });
    }
  });
  it('hides any other database error behind the general message and logs it', async () => {
    const { ctx } = fakeFinance({ data: null, error: { code: 'XX000' } });
    expect(await saveQuotation(ctx, valid)).toEqual({ ok: false, error: 'That change could not be saved. Please try again.' });
    expect(logged).toHaveBeenCalled();
  });
});
```

Add the two quotation schemas to the test that every schema parses its own output unchanged.

In `tests/finance-schemas.test.ts`, replace:

```ts
import { createProductInput, updateProductInput } from '@/lib/finance/products';
```

with:

```ts
import { createProductInput, updateProductInput } from '@/lib/finance/products';
import { quotationIdInput, saveQuotationInput } from '@/lib/finance/quotations';
```

In `tests/finance-schemas.test.ts`, replace:

```ts
  ['setEInvoiceInput (a status and no UUID yet)', setEInvoiceInput, { id: ID, einvoice_status: 'pending' }],
];
```

with:

```ts
  ['setEInvoiceInput (a status and no UUID yet)', setEInvoiceInput, { id: ID, einvoice_status: 'pending' }],
  ['saveQuotationInput', saveQuotationInput, {
    customer_id: ID, quote_date: '2026-10-01', valid_until: '2026-10-31', notes: '',
    lines: [{ description: ' Design work ', quantity: 1.23456, unit_price: 0.123456, uom: '', product_id: '' }],
  }],
  ['saveQuotationInput (a draft being changed, valid for the day, an SST rate with three decimals)', saveQuotationInput, {
    id: ID, customer_id: ID, quote_date: '2026-10-01', valid_until: '2026-10-01', notes: ' Valid 30 days ',
    lines: [{ product_id: ID, description: 'Ink', quantity: 0.0005, uom: ' box ', unit_price: 14.5, sst_rate: 1.005 }],
  }],
  ['quotationIdInput', quotationIdInput, { id: ID }],
];
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm exec vitest run tests/finance-quotations.test.ts tests/finance-schemas.test.ts`
Expected: FAIL. Neither file can be loaded: `@/lib/finance/quotations` does not exist.

- [ ] **Step 3: Write `src/lib/finance/quotations.ts`**

Create `src/lib/finance/quotations.ts`:

```ts
/**
 * Quotations. A quotation and its lines are saved by one database function.
 * Sending gives it its number and locks what the customer was given; nothing
 * is emailed. After that only the customer's answer is recorded: accepted or
 * declined. An accepted quotation becomes a draft invoice with the same
 * lines. org_id comes from the context.
 */
import { z } from 'zod';
import {
  DOCUMENT_LINES_MAX,
  DOCUMENT_LINE_COLUMNS,
  type DocumentLineRow,
  LINE_MESSAGES,
  documentLine,
  isoDate,
  optionalText,
  toDocumentLine,
} from './document-lines';
import {
  type FinResult,
  type FinanceWriteContext,
  NOT_ALLOWED,
  PG_FORBIDDEN,
  PG_FOREIGN_KEY,
  PG_OUT_OF_RANGE,
  PG_UNIQUE,
  TOO_LARGE,
  pgCode,
  writeFailed,
} from './result';

export const QUOTATION_LINES_MAX = DOCUMENT_LINES_MAX;
/** Quotations loaded for a screen, a page at a time. */
export const QUOTATION_PAGE_SIZE = 1000;

export const QUOTATION_MESSAGES = {
  customer: 'Choose a customer.',
  date: LINE_MESSAGES.date,
  dates: 'The valid-until date cannot be before the quotation date.',
  lines: LINE_MESSAGES.lines,
  tooManyLines: `A quotation can have at most ${QUOTATION_LINES_MAX} lines.`,
  description: LINE_MESSAGES.description,
  quantity: LINE_MESSAGES.quantity,
  price: LINE_MESSAGES.price,
  sst: LINE_MESSAGES.sst,
  tooLong: LINE_MESSAGES.tooLong,
  product: LINE_MESSAGES.product,
  gone: 'That quotation no longer exists.',
  // FIN01. A menu offers only what a quotation's status allows, so this reaches a person only when the
  // quotation changed under them: sent, accepted or declined in another tab. True of each.
  locked: 'This quotation has already been sent or answered, so that can no longer be done.',
  // FIN04
  notAccepted: 'Only an accepted quotation can be made into an invoice.',
  // FIN13
  hasInvoice: 'This quotation already has an invoice. Void that invoice, or delete it if it is a draft, first.',
  empty: 'A quotation needs at least one line with an amount.',
  numberTaken: 'That quotation number is already used.',
  missing: 'The customer or a product on this quotation no longer exists.',
} as const;

const M = QUOTATION_MESSAGES;

export const saveQuotationInput = z
  .object({
    /** Present to change a draft; absent to create one. */
    id: z.string({ error: M.gone }).uuid(M.gone).optional(),
    customer_id: z.string({ error: M.customer }).uuid(M.customer),
    quote_date: isoDate,
    valid_until: isoDate,
    notes: optionalText.default(null),
    lines: z.array(documentLine, { error: M.lines }).min(1, M.lines).max(QUOTATION_LINES_MAX, M.tooManyLines),
  })
  .refine((v) => v.valid_until >= v.quote_date, { message: M.dates, path: ['valid_until'] });

export const quotationIdInput = z.object({ id: z.string({ error: M.gone }).uuid(M.gone) });

const REFUSALS: Record<string, string> = {
  FIN01: M.locked,
  FIN04: M.notAccepted,
  FIN10: M.empty,
  FIN11: M.gone,
  FIN13: M.hasInvoice,
  [PG_UNIQUE]: M.numberTaken,
  [PG_FOREIGN_KEY]: M.missing,
  [PG_FORBIDDEN]: NOT_ALLOWED,
  [PG_OUT_OF_RANGE]: TOO_LARGE,
};

/**
 * Converting. A unique violation here is not a number (a draft invoice has
 * none): it is the index that allows one invoice per quotation, met by two
 * conversions at the same moment.
 */
const CONVERT_REFUSALS: Record<string, string> = { ...REFUSALS, [PG_UNIQUE]: M.hasInvoice };

function quotationWriteFailed(
  fnName: string,
  error: unknown,
  refusals: Record<string, string> = REFUSALS,
): { ok: false; error: string } {
  const refusal = refusals[pgCode(error) ?? ''];
  return refusal ? { ok: false, error: refusal } : writeFailed(fnName, error);
}

/* ---- reads ------------------------------------------------------------ */

/** What a person sets. */
export type QuotationStatus = 'draft' | 'sent' | 'accepted' | 'declined';

/** `expired` is a sent quotation past its valid-until date; it is worked out, never stored. */
export type QuotationDisplayStatus = QuotationStatus | 'expired';

export type QuotationListRow = {
  id: string;
  /** null while the quotation is a draft. */
  quotation_no: string | null;
  customer_id: string;
  customer_name: string;
  quote_date: string;
  valid_until: string;
  total: number;
  display_status: QuotationDisplayStatus;
  /** The UTC date an accepted quotation was accepted on; null for every other status. */
  accepted_on: string | null;
  /** The invoice made from this quotation, if one stands: a void invoice does not count. */
  invoice_id: string | null;
  /** null when there is no invoice, and while that invoice is still a draft. */
  invoice_no: string | null;
};

export type QuotationLine = DocumentLineRow;

export type QuotationDetail = QuotationListRow & {
  subtotal: number;
  sst: number;
  notes: string | null;
  lines: QuotationLine[];
};

const LIST_COLUMNS =
  'id,quotation_no,customer_id,customer_name,quote_date,valid_until,total,display_status,accepted_at,invoice_id,invoice_no';

function toListRow(row: Record<string, unknown>): QuotationListRow {
  const { accepted_at, ...rest } = row;
  return {
    ...(rest as unknown as QuotationListRow),
    total: Number(row.total),
    // A timestamp such as 2026-10-08T03:15:00+00:00: the database answers in UTC, so its first ten characters are the UTC date.
    accepted_on: typeof accepted_at === 'string' ? accepted_at.slice(0, 10) : null,
    invoice_id: (row.invoice_id as string | null) ?? null,
    invoice_no: (row.invoice_no as string | null) ?? null,
  };
}

/** Every quotation in the workspace, newest first, read a page at a time. Drafts are included. */
export async function listQuotations(ctx: FinanceWriteContext): Promise<QuotationListRow[]> {
  const rows: QuotationListRow[] = [];
  for (let from = 0; ; from += QUOTATION_PAGE_SIZE) {
    const { data, error } = await ctx.client
      .from('finance_quotation_totals')
      .select(LIST_COLUMNS)
      .eq('org_id', ctx.orgId)
      .order('quote_date', { ascending: false })
      .order('id', { ascending: true })
      .range(from, from + QUOTATION_PAGE_SIZE - 1);
    if (error) throw error;
    const page = (data ?? []) as unknown as Record<string, unknown>[];
    rows.push(...page.map(toListRow));
    if (page.length < QUOTATION_PAGE_SIZE) return rows;
  }
}

/** One quotation with its lines in the order they were entered; null when it is not in this workspace or the id is not an id. */
export async function getQuotation(ctx: FinanceWriteContext, id: string): Promise<QuotationDetail | null> {
  // The database would throw on casting it; there is simply no such quotation.
  if (!quotationIdInput.safeParse({ id }).success) return null;
  const { data: quotation, error } = await ctx.client
    .from('finance_quotation_totals')
    .select(`${LIST_COLUMNS},subtotal,sst,notes`)
    .eq('org_id', ctx.orgId)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!quotation) return null;
  const { data: lines, error: linesError } = await ctx.client
    .from('finance_quotation_lines')
    .select(DOCUMENT_LINE_COLUMNS)
    .eq('org_id', ctx.orgId)
    .eq('quotation_id', id)
    .order('position', { ascending: true })
    .order('id', { ascending: true });
  if (linesError) throw linesError;
  const { subtotal, sst, notes, ...header } = quotation as unknown as Record<string, unknown>;
  return {
    ...toListRow(header),
    subtotal: Number(subtotal),
    sst: Number(sst),
    notes: (notes as string | null) ?? null,
    lines: ((lines ?? []) as unknown as Record<string, unknown>[]).map(toDocumentLine),
  };
}

/* ---- writes ----------------------------------------------------------- */

/** Creates a draft quotation, or replaces a draft's header and lines. */
export async function saveQuotation(
  ctx: FinanceWriteContext,
  input: z.input<typeof saveQuotationInput>,
): Promise<FinResult<{ id: string }>> {
  const { lines, ...quotation } = saveQuotationInput.parse(input);
  const { data, error } = await ctx.client.rpc('finance_save_quotation', {
    target_org: ctx.orgId,
    quotation,
    lines,
  });
  if (error || !data) return quotationWriteFailed('saveQuotation', error);
  return { ok: true, data: { id: data as string } };
}

/** Marks a draft as sent: it gets its number and can no longer be edited. Nothing is emailed. */
export async function sendQuotation(
  ctx: FinanceWriteContext,
  input: z.input<typeof quotationIdInput>,
): Promise<FinResult<{ id: string; quotation_no: string }>> {
  const { id } = quotationIdInput.parse(input);
  const { data, error } = await ctx.client.rpc('finance_send_quotation', {
    target_org: ctx.orgId,
    target_quotation: id,
  });
  if (error || !data) return quotationWriteFailed('sendQuotation', error);
  return { ok: true, data: { id, quotation_no: data as string } };
}

/** Records the customer's answer. The database lets it be changed from one answer to the other until an invoice is made. */
async function answerQuotation(
  ctx: FinanceWriteContext,
  fnName: string,
  input: z.input<typeof quotationIdInput>,
  status: 'accepted' | 'declined',
): Promise<FinResult<{ id: string }>> {
  const { id } = quotationIdInput.parse(input);
  const now = new Date().toISOString();
  const { data, error } = await ctx.client
    .from('finance_quotations')
    .update({ status, accepted_at: status === 'accepted' ? now : null, updated_at: now })
    .eq('id', id)
    .eq('org_id', ctx.orgId)
    .select('id')
    .maybeSingle();
  if (error) return quotationWriteFailed(fnName, error);
  if (!data) return { ok: false, error: M.gone };
  return { ok: true, data: { id: data.id } };
}

/** The customer said yes. Allowed on a sent quotation, expired or not, and on a declined one. */
export async function acceptQuotation(
  ctx: FinanceWriteContext,
  input: z.input<typeof quotationIdInput>,
): Promise<FinResult<{ id: string }>> {
  return answerQuotation(ctx, 'acceptQuotation', input, 'accepted');
}

/** The customer said no, or the quotation was withdrawn. Refused once the quotation has an invoice. */
export async function declineQuotation(
  ctx: FinanceWriteContext,
  input: z.input<typeof quotationIdInput>,
): Promise<FinResult<{ id: string }>> {
  return answerQuotation(ctx, 'declineQuotation', input, 'declined');
}

/** Deletes a draft quotation and its lines. */
export async function deleteQuotation(
  ctx: FinanceWriteContext,
  input: z.input<typeof quotationIdInput>,
): Promise<FinResult<{ id: string }>> {
  const { id } = quotationIdInput.parse(input);
  const { data, error } = await ctx.client
    .from('finance_quotations')
    .delete()
    .eq('id', id)
    .eq('org_id', ctx.orgId)
    .select('id')
    .maybeSingle();
  if (error) return quotationWriteFailed('deleteQuotation', error);
  if (!data) return { ok: false, error: M.gone };
  return { ok: true, data: { id: data.id } };
}

/** Makes a draft invoice from an accepted quotation, with the same lines. Answers with the invoice's id. */
export async function convertQuotation(
  ctx: FinanceWriteContext,
  input: z.input<typeof quotationIdInput>,
): Promise<FinResult<{ id: string; invoice_id: string }>> {
  const { id } = quotationIdInput.parse(input);
  const { data, error } = await ctx.client.rpc('finance_convert_quotation', {
    target_org: ctx.orgId,
    target_quotation: id,
  });
  if (error || !data) return quotationWriteFailed('convertQuotation', error, CONVERT_REFUSALS);
  return { ok: true, data: { id, invoice_id: data as string } };
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vitest run tests/finance-quotations.test.ts tests/finance-schemas.test.ts`
Expected: PASS, both files.

- [ ] **Step 5: Type-check, lint and commit**

Run: `pnpm exec tsc --noEmit` then `pnpm lint`
Expected: no errors and no warnings.

```bash
git add src/lib/finance/quotations.ts tests/finance-quotations.test.ts tests/finance-schemas.test.ts
git commit -m "feat: the data layer for quotations"
```

---

### Task 3: Credit notes data layer

**Files:**
- Create: `tests/finance-credit-notes.test.ts`
- Create: `src/lib/finance/credit-notes.ts`
- Modify: `src/lib/finance/document-lines.ts` (one function added)
- Modify: `tests/finance-schemas.test.ts`

**Interfaces:**
- Consumes: `LINE_MESSAGES`, `isoDate`, `optionalText` from `./document-lines`; the names from `./result` listed in Task 2; `fakeFinance`; the view `finance_credit_note_totals` and the functions `finance_save_credit_note`, `finance_issue_credit_note` (Task 1).
- Produces, in `document-lines.ts`: `ringgitAmount(message: string)`, a Zod schema for an amount of money: rounded to the sen, then above zero and at most 999,999,999,999.99. Task 4 uses it too.
- Produces, in `credit-notes.ts`:
  - `CREDIT_NOTE_REASONS = ['returns', 'pricing_adjustment', 'overbilling', 'goodwill', 'other']`, `type CreditNoteReason`, `CREDIT_NOTE_REASON_LABELS: Record<CreditNoteReason, string>`
  - `saveCreditNoteInput` (`{ id?, invoice_id, credit_date, reason, amount, notes }`), `creditNoteIdInput` (`{ id }`)
  - `type CreditNoteStatus = 'draft' | 'issued' | 'void'`
  - `type CreditNoteRow = { id; credit_note_no: string | null; invoice_id; invoice_no: string | null; customer_id; customer_name; credit_date; reason: CreditNoteReason; amount: number; refunded: number; status: CreditNoteStatus; notes: string | null }`
  - `listCreditNotes(ctx): Promise<CreditNoteRow[]>`
  - `saveCreditNote(ctx, input): Promise<FinResult<{ id: string }>>`
  - `issueCreditNote(ctx, { id }): Promise<FinResult<{ id: string; credit_note_no: string }>>`
  - `voidCreditNote(ctx, { id })`, `deleteCreditNote(ctx, { id })`: `Promise<FinResult<{ id: string }>>`

There is no `getCreditNote`: a credit note has no lines, so the list row is everything a form needs to edit a draft.

- [ ] **Step 1: Write the failing tests**

Create `tests/finance-credit-notes.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CREDIT_NOTE_PAGE_SIZE,
  CREDIT_NOTE_REASONS,
  CREDIT_NOTE_REASON_LABELS,
  deleteCreditNote,
  issueCreditNote,
  listCreditNotes,
  saveCreditNote,
  saveCreditNoteInput,
  voidCreditNote,
} from '@/lib/finance/credit-notes';
import { fakeFinance } from './setup/fake-finance';

const ID = '33333333-3333-4333-8333-333333333333';
const INVOICE = '55555555-5555-4555-8555-555555555555';

const valid = { invoice_id: INVOICE, credit_date: '2026-10-06', reason: 'returns' as const, amount: 240 };

let logged: ReturnType<typeof vi.spyOn>;
beforeEach(() => { logged = vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { logged.mockRestore(); });

const first = (value: unknown) => saveCreditNoteInput.safeParse(value).error?.issues[0]?.message;

describe('saveCreditNoteInput', () => {
  it('asks for the invoice, a real date and a reason from the list', () => {
    expect(first({ ...valid, invoice_id: '' })).toBe('Choose the invoice this credit note is against.');
    expect(first({ ...valid, invoice_id: undefined })).toBe('Choose the invoice this credit note is against.');
    expect(first({ ...valid, credit_date: '2026-02-30' })).toBe('Enter a valid date.');
    expect(first({ ...valid, reason: 'because' })).toBe('Choose a reason.');
    expect(first({ ...valid, reason: undefined })).toBe('Choose a reason.');
  });
  it('rounds the amount to the sen first, then asks for more than nothing', () => {
    expect(saveCreditNoteInput.parse({ ...valid, amount: 240.005 }).amount).toBe(240.01);
    expect(saveCreditNoteInput.parse({ ...valid, amount: 0.005 }).amount).toBe(0.01);
    expect(first({ ...valid, amount: 0.004 })).toBe('Enter an amount above 0.');
    expect(first({ ...valid, amount: 0 })).toBe('Enter an amount above 0.');
    expect(first({ ...valid, amount: -5 })).toBe('Enter an amount above 0.');
    expect(first({ ...valid, amount: '240' })).toBe('Enter an amount above 0.');
    expect(first({ ...valid, amount: 1e12 })).toBe('Enter an amount above 0.');
  });
  it('keeps a note to 200 characters, and stores an empty one as nothing', () => {
    expect(saveCreditNoteInput.parse({ ...valid, notes: '  ' }).notes).toBeNull();
    expect(saveCreditNoteInput.parse(valid).notes).toBeNull();
    expect(first({ ...valid, notes: 'x'.repeat(201) })).toBe('That is too long. Keep it to 200 characters or fewer.');
  });
  it('has no place for a number or a status: the database gives those', () => {
    const parsed = saveCreditNoteInput.parse({ ...valid, credit_note_no: 'CN-9999', status: 'issued' });
    expect(Object.keys(parsed).sort()).toEqual(['amount', 'credit_date', 'invoice_id', 'notes', 'reason']);
  });
  it('has a label for every reason', () => {
    expect(Object.keys(CREDIT_NOTE_REASON_LABELS).sort()).toEqual([...CREDIT_NOTE_REASONS].sort());
  });
});

describe('credit note reads', () => {
  const row = (n: number) => ({
    id: `cn-${n}`, credit_note_no: `CN-${n}`, invoice_id: 'inv-1', invoice_no: 'INV-1042', customer_id: 'c1',
    customer_name: 'Aisyah Trading', credit_date: '2026-10-06', reason: 'returns', amount: '240.00', refunded: '100.00',
    status: 'issued', notes: null,
  });

  it('lists from the totals view, in the caller’s workspace, newest first, with amounts as numbers', async () => {
    const { ctx, calls } = fakeFinance({ data: [row(1)], error: null });
    expect(await listCreditNotes(ctx)).toEqual([{ ...row(1), amount: 240, refunded: 100 }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      name: 'finance_credit_note_totals',
      op: 'select',
      filters: { org_id: 'org-1' },
      order: ['credit_date desc', 'id asc'],
      range: [0, CREDIT_NOTE_PAGE_SIZE - 1],
    });
  });
  it('reads on past a full page', async () => {
    const full = Array.from({ length: CREDIT_NOTE_PAGE_SIZE }, (_, n) => row(n));
    const { ctx, calls } = fakeFinance((call) => ({ data: call.range?.[0] === 0 ? full : [row(-1)], error: null }));
    expect(await listCreditNotes(ctx)).toHaveLength(CREDIT_NOTE_PAGE_SIZE + 1);
    expect(calls).toHaveLength(2);
  });
  it('throws a read error for the screen’s error page', async () => {
    const { ctx } = fakeFinance({ data: null, error: { code: 'XX000', message: 'boom' } });
    await expect(listCreditNotes(ctx)).rejects.toMatchObject({ code: 'XX000' });
  });
});

describe('credit note writes', () => {
  it('saves through the database function, in the caller’s workspace', async () => {
    const { ctx, calls } = fakeFinance({ data: ID, error: null });
    expect(await saveCreditNote(ctx, { ...valid, id: ID, notes: ' Two returned ' })).toEqual({ ok: true, data: { id: ID } });
    expect(calls[0]).toMatchObject({ kind: 'rpc', name: 'finance_save_credit_note' });
    expect(calls[0].args).toEqual({
      target_org: 'org-1',
      note: { id: ID, invoice_id: INVOICE, credit_date: '2026-10-06', reason: 'returns', amount: 240, notes: 'Two returned' },
    });
  });
  it('issues and returns the number', async () => {
    const { ctx, calls } = fakeFinance({ data: 'CN-0007', error: null });
    expect(await issueCreditNote(ctx, { id: ID })).toEqual({ ok: true, data: { id: ID, credit_note_no: 'CN-0007' } });
    expect(calls[0]).toMatchObject({ kind: 'rpc', name: 'finance_issue_credit_note' });
    expect(calls[0].args).toEqual({ target_org: 'org-1', target_note: ID });
  });
  it('voids by setting the status and deletes a draft, both scoped to the workspace', async () => {
    const voided = fakeFinance({ data: { id: ID }, error: null });
    expect(await voidCreditNote(voided.ctx, { id: ID })).toEqual({ ok: true, data: { id: ID } });
    expect(voided.calls[0]).toMatchObject({ name: 'finance_credit_notes', op: 'update', filters: { id: ID, org_id: 'org-1' } });
    expect(Object.keys(voided.calls[0].values!).sort()).toEqual(['status', 'updated_at']);
    expect(voided.calls[0].values).toMatchObject({ status: 'void' });

    const removed = fakeFinance({ data: { id: ID }, error: null });
    expect(await deleteCreditNote(removed.ctx, { id: ID })).toEqual({ ok: true, data: { id: ID } });
    expect(removed.calls[0]).toMatchObject({ name: 'finance_credit_notes', op: 'delete', filters: { id: ID, org_id: 'org-1' } });
  });
  it('turns each database refusal into a sentence', async () => {
    const cases: [string, string][] = [
      ['FIN01', 'This credit note has been issued or voided, so that can no longer be done.'],
      ['FIN02', 'A refund depends on this credit note. Void or delete that refund on Refunds before voiding it.'],
      ['FIN04', 'A credit note can only go against a posted invoice.'],
      ['FIN05', 'That is more than this invoice has left to credit.'],
      ['FIN11', 'That credit note no longer exists.'],
      ['23505', 'That credit note number is already used.'],
      ['23503', 'The invoice on this credit note no longer exists.'],
      ['42501', 'You do not have permission to make changes here.'],
      ['22003', 'That amount is too large.'],
    ];
    for (const [code, message] of cases) {
      const { ctx } = fakeFinance({ data: null, error: { code } });
      expect(await saveCreditNote(ctx, valid), code).toEqual({ ok: false, error: message });
      expect(await issueCreditNote(ctx, { id: ID }), code).toEqual({ ok: false, error: message });
      expect(await voidCreditNote(ctx, { id: ID }), code).toEqual({ ok: false, error: message });
      expect(await deleteCreditNote(ctx, { id: ID }), code).toEqual({ ok: false, error: message });
    }
    expect(logged).not.toHaveBeenCalled();
  });
  it('says the credit note is gone when void or delete touches no row', async () => {
    const { ctx } = fakeFinance({ data: null, error: null });
    expect(await voidCreditNote(ctx, { id: ID })).toEqual({ ok: false, error: 'That credit note no longer exists.' });
    expect(await deleteCreditNote(ctx, { id: ID })).toEqual({ ok: false, error: 'That credit note no longer exists.' });
  });
  it('hides any other database error behind the general message and logs it', async () => {
    const { ctx } = fakeFinance({ data: null, error: { code: 'XX000' } });
    expect(await saveCreditNote(ctx, valid)).toEqual({ ok: false, error: 'That change could not be saved. Please try again.' });
    expect(logged).toHaveBeenCalled();
  });
});
```

In `tests/finance-schemas.test.ts`, replace:

```ts
import { createContactInput, updateContactInput } from '@/lib/finance/contacts';
```

with:

```ts
import { createContactInput, updateContactInput } from '@/lib/finance/contacts';
import { creditNoteIdInput, saveCreditNoteInput } from '@/lib/finance/credit-notes';
```

In `tests/finance-schemas.test.ts`, replace:

```ts
  ['quotationIdInput', quotationIdInput, { id: ID }],
];
```

with:

```ts
  ['quotationIdInput', quotationIdInput, { id: ID }],
  ['saveCreditNoteInput', saveCreditNoteInput, { invoice_id: ID, credit_date: '2026-10-06', reason: 'returns', amount: 240.005, notes: ' ' }],
  ['saveCreditNoteInput (a draft being changed, the smallest amount)', saveCreditNoteInput, {
    id: ID, invoice_id: ID, credit_date: '2026-10-06', reason: 'other', amount: 0.005, notes: ' Two returned ',
  }],
  ['creditNoteIdInput', creditNoteIdInput, { id: ID }],
];
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm exec vitest run tests/finance-credit-notes.test.ts tests/finance-schemas.test.ts`
Expected: FAIL. Neither file can be loaded: `@/lib/finance/credit-notes` does not exist.

- [ ] **Step 3: Add the shared amount schema**

In `src/lib/finance/document-lines.ts`, replace:

```ts
/** An id, or nothing chosen (an empty string from a select). */
const optionalId = z
```

with:

```ts
/**
 * An amount of money typed by a person: rounded to the sen first, then it must
 * be above zero and fit the column numeric(14,2). `message` is the sentence
 * for anything else.
 */
export function ringgitAmount(message: string) {
  return z
    .number({ error: message })
    .transform(round(2))
    .pipe(z.number().gt(0, message).max(999_999_999_999.99, message));
}

/** An id, or nothing chosen (an empty string from a select). */
const optionalId = z
```

`round` is the helper already in that file, a few lines above. The payment schemas in `money.ts` keep their own private `amount`; that file is not touched.

- [ ] **Step 4: Write `src/lib/finance/credit-notes.ts`**

Create `src/lib/finance/credit-notes.ts`:

```ts
/**
 * Credit notes. A credit note is one amount against one posted invoice, with
 * a reason. Issuing gives it its number and takes its amount off what the
 * invoice owes; after that it can only be voided, and not while a refund
 * depends on it. All the issued credit notes of an invoice together never
 * exceed the invoice's total. org_id comes from the context.
 */
import { z } from 'zod';
import { LINE_MESSAGES, isoDate, optionalText, ringgitAmount } from './document-lines';
import {
  type FinResult,
  type FinanceWriteContext,
  NOT_ALLOWED,
  PG_FORBIDDEN,
  PG_FOREIGN_KEY,
  PG_OUT_OF_RANGE,
  PG_UNIQUE,
  TOO_LARGE,
  pgCode,
  writeFailed,
} from './result';

export const CREDIT_NOTE_REASONS = ['returns', 'pricing_adjustment', 'overbilling', 'goodwill', 'other'] as const;
export type CreditNoteReason = (typeof CREDIT_NOTE_REASONS)[number];

export const CREDIT_NOTE_REASON_LABELS: Record<CreditNoteReason, string> = {
  returns: 'Returns',
  pricing_adjustment: 'Pricing adjustment',
  overbilling: 'Overbilling',
  goodwill: 'Goodwill',
  other: 'Other',
};

/** Credit notes loaded for a screen, a page at a time. */
export const CREDIT_NOTE_PAGE_SIZE = 1000;

export const CREDIT_NOTE_MESSAGES = {
  invoice: 'Choose the invoice this credit note is against.',
  date: LINE_MESSAGES.date,
  reason: 'Choose a reason.',
  amount: 'Enter an amount above 0.',
  tooLong: LINE_MESSAGES.tooLong,
  gone: 'That credit note no longer exists.',
  // FIN01. A menu offers only what a credit note's status allows, so this reaches a person only when it
  // changed under them: issued or voided in another tab. True of each.
  locked: 'This credit note has been issued or voided, so that can no longer be done.',
  // FIN02
  hasRefunds: 'A refund depends on this credit note. Void or delete that refund on Refunds before voiding it.',
  // FIN04
  notPosted: 'A credit note can only go against a posted invoice.',
  // FIN05
  tooMuch: 'That is more than this invoice has left to credit.',
  numberTaken: 'That credit note number is already used.',
  missing: 'The invoice on this credit note no longer exists.',
} as const;

const M = CREDIT_NOTE_MESSAGES;

export const saveCreditNoteInput = z.object({
  /** Present to change a draft; absent to create one. */
  id: z.string({ error: M.gone }).uuid(M.gone).optional(),
  invoice_id: z.string({ error: M.invoice }).uuid(M.invoice),
  credit_date: isoDate,
  reason: z.enum(CREDIT_NOTE_REASONS, { error: M.reason }),
  amount: ringgitAmount(M.amount),
  notes: optionalText.default(null),
});

export const creditNoteIdInput = z.object({ id: z.string({ error: M.gone }).uuid(M.gone) });

const REFUSALS: Record<string, string> = {
  FIN01: M.locked,
  FIN02: M.hasRefunds,
  FIN04: M.notPosted,
  FIN05: M.tooMuch,
  FIN11: M.gone,
  [PG_UNIQUE]: M.numberTaken,
  [PG_FOREIGN_KEY]: M.missing,
  [PG_FORBIDDEN]: NOT_ALLOWED,
  [PG_OUT_OF_RANGE]: TOO_LARGE,
};

function creditNoteWriteFailed(fnName: string, error: unknown): { ok: false; error: string } {
  const refusal = REFUSALS[pgCode(error) ?? ''];
  return refusal ? { ok: false, error: refusal } : writeFailed(fnName, error);
}

/* ---- reads ------------------------------------------------------------ */

export type CreditNoteStatus = 'draft' | 'issued' | 'void';

export type CreditNoteRow = {
  id: string;
  /** null while the credit note is a draft. */
  credit_note_no: string | null;
  invoice_id: string;
  /** The invoice is posted, so it always has a number; the type allows for one that somehow has none. */
  invoice_no: string | null;
  customer_id: string;
  customer_name: string;
  credit_date: string;
  reason: CreditNoteReason;
  amount: number;
  /** Posted refunds put against this credit note itself. A refund put against its invoice is not counted here. */
  refunded: number;
  status: CreditNoteStatus;
  notes: string | null;
};

const LIST_COLUMNS =
  'id,credit_note_no,invoice_id,invoice_no,customer_id,customer_name,credit_date,reason,amount,refunded,status,notes';

/** Every credit note in the workspace, newest first, read a page at a time. Drafts and void ones are included. */
export async function listCreditNotes(ctx: FinanceWriteContext): Promise<CreditNoteRow[]> {
  const rows: CreditNoteRow[] = [];
  for (let from = 0; ; from += CREDIT_NOTE_PAGE_SIZE) {
    const { data, error } = await ctx.client
      .from('finance_credit_note_totals')
      .select(LIST_COLUMNS)
      .eq('org_id', ctx.orgId)
      .order('credit_date', { ascending: false })
      .order('id', { ascending: true })
      .range(from, from + CREDIT_NOTE_PAGE_SIZE - 1);
    if (error) throw error;
    const page = (data ?? []) as unknown as Record<string, unknown>[];
    rows.push(
      ...page.map((row) => ({
        ...(row as unknown as CreditNoteRow),
        amount: Number(row.amount),
        refunded: Number(row.refunded),
        notes: (row.notes as string | null) ?? null,
      })),
    );
    if (page.length < CREDIT_NOTE_PAGE_SIZE) return rows;
  }
}

/* ---- writes ----------------------------------------------------------- */

/** Creates a draft credit note, or replaces a draft. */
export async function saveCreditNote(
  ctx: FinanceWriteContext,
  input: z.input<typeof saveCreditNoteInput>,
): Promise<FinResult<{ id: string }>> {
  const note = saveCreditNoteInput.parse(input);
  const { data, error } = await ctx.client.rpc('finance_save_credit_note', { target_org: ctx.orgId, note });
  if (error || !data) return creditNoteWriteFailed('saveCreditNote', error);
  return { ok: true, data: { id: data as string } };
}

/** Issues a draft: it gets its number, and the invoice owes that much less. */
export async function issueCreditNote(
  ctx: FinanceWriteContext,
  input: z.input<typeof creditNoteIdInput>,
): Promise<FinResult<{ id: string; credit_note_no: string }>> {
  const { id } = creditNoteIdInput.parse(input);
  const { data, error } = await ctx.client.rpc('finance_issue_credit_note', {
    target_org: ctx.orgId,
    target_note: id,
  });
  if (error || !data) return creditNoteWriteFailed('issueCreditNote', error);
  return { ok: true, data: { id, credit_note_no: data as string } };
}

/** Voids an issued credit note: the invoice owes its amount again. Refused while a refund depends on it. */
export async function voidCreditNote(
  ctx: FinanceWriteContext,
  input: z.input<typeof creditNoteIdInput>,
): Promise<FinResult<{ id: string }>> {
  const { id } = creditNoteIdInput.parse(input);
  const { data, error } = await ctx.client
    .from('finance_credit_notes')
    .update({ status: 'void', updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('org_id', ctx.orgId)
    .select('id')
    .maybeSingle();
  if (error) return creditNoteWriteFailed('voidCreditNote', error);
  if (!data) return { ok: false, error: M.gone };
  return { ok: true, data: { id: data.id } };
}

/** Deletes a draft credit note. */
export async function deleteCreditNote(
  ctx: FinanceWriteContext,
  input: z.input<typeof creditNoteIdInput>,
): Promise<FinResult<{ id: string }>> {
  const { id } = creditNoteIdInput.parse(input);
  const { data, error } = await ctx.client
    .from('finance_credit_notes')
    .delete()
    .eq('id', id)
    .eq('org_id', ctx.orgId)
    .select('id')
    .maybeSingle();
  if (error) return creditNoteWriteFailed('deleteCreditNote', error);
  if (!data) return { ok: false, error: M.gone };
  return { ok: true, data: { id: data.id } };
}
```

- [ ] **Step 5: Run the tests**

Run: `pnpm exec vitest run tests/finance-credit-notes.test.ts tests/finance-schemas.test.ts tests/finance-shared.test.ts`
Expected: PASS, all three files. `tests/finance-shared.test.ts` was not edited: `document-lines.ts` only gained an export.

- [ ] **Step 6: Type-check, lint and commit**

Run: `pnpm exec tsc --noEmit` then `pnpm lint`
Expected: no errors and no warnings.

```bash
git add src/lib/finance/credit-notes.ts src/lib/finance/document-lines.ts tests/finance-credit-notes.test.ts tests/finance-schemas.test.ts
git commit -m "feat: the data layer for credit notes"
```

---

### Task 4: Refunds data layer

**Files:**
- Create: `tests/finance-refunds.test.ts`
- Create: `src/lib/finance/refunds.ts`
- Modify: `tests/finance-schemas.test.ts`

**Interfaces:**
- Consumes: `LINE_MESSAGES`, `isoDate`, `optionalText`, `ringgitAmount` (Task 3) from `./document-lines`; `PAYMENT_METHODS`, `PAYMENT_PAGE_SIZE`, `PaymentInRow`, `PaymentMethod`, `markPaymentPaidInput`, `paymentIdInput` from `./money` (unchanged); the names from `./result`; `fakeFinance`; the view `finance_refunds` and the function `finance_record_refund` (Task 1); the existing function `finance_mark_payment_paid`.
- Produces:
  - `REFUND_REASONS = ['order_cancelled', 'damaged_goods', 'wrong_item', 'overpayment', 'other']`, `type RefundReason`, `REFUND_REASON_LABELS: Record<RefundReason, string>`
  - `recordRefundInput` (`{ invoice_id, credit_note_id, account_id, txn_date, method, reason, amount, reference, notes, scheduled }`, exactly one of the first two set)
  - `type RefundRow = { allocation_id; transaction_id; number: string | null; txn_date; method: PaymentMethod; amount: number; transaction_amount: number; status: PaymentInRow['status']; reference: string | null; reason: RefundReason; notes: string | null; account_id; account_name; invoice_id; invoice_no: string | null; credit_note_id: string | null; credit_note_no: string | null; customer_id; customer_name }`
  - `listRefunds(ctx): Promise<RefundRow[]>`
  - `recordRefund(ctx, input): Promise<FinResult<{ id: string }>>`
  - `markRefundPaid(ctx, { id, paid_on }): Promise<FinResult<{ id: string; number: string }>>`
  - `voidRefund(ctx, { id })`, `deleteRefund(ctx, { id })`: `Promise<FinResult<{ id: string }>>`

`markRefundPaid`, `voidRefund` and `deleteRefund` are the database function, the update and the delete that `markPaymentPaid`, `voidPayment` and `deleteScheduledPayment` in `money.ts` use. They are separate functions for the reason `voidPaymentIn` is: they are kept to money out by a `direction` filter and answer in the sentences of a refund. `money.ts` is not edited by this task or any other.

- [ ] **Step 1: Write the failing tests**

Create `tests/finance-refunds.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PAYMENT_PAGE_SIZE } from '@/lib/finance/money';
import {
  REFUND_REASONS,
  REFUND_REASON_LABELS,
  deleteRefund,
  listRefunds,
  markRefundPaid,
  recordRefund,
  recordRefundInput,
  voidRefund,
} from '@/lib/finance/refunds';
import { fakeFinance } from './setup/fake-finance';

const TXN = '33333333-3333-4333-8333-333333333333';
const INVOICE = '55555555-5555-4555-8555-555555555555';
const NOTE = '66666666-6666-4666-8666-666666666666';
const ACCOUNT = '77777777-7777-4777-8777-777777777777';

const valid = {
  invoice_id: INVOICE, account_id: ACCOUNT, txn_date: '2026-10-06', method: 'fpx' as const, reason: 'damaged_goods' as const, amount: 240,
};

let logged: ReturnType<typeof vi.spyOn>;
beforeEach(() => { logged = vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { logged.mockRestore(); });

const first = (value: unknown) => recordRefundInput.safeParse(value).error?.issues[0]?.message;

describe('recordRefundInput', () => {
  it('asks for exactly one document: an invoice or a credit note', () => {
    const sentence = 'Choose the invoice or the credit note this refund is for.';
    expect(first({ ...valid, invoice_id: undefined })).toBe(sentence);
    expect(first({ ...valid, invoice_id: '' })).toBe(sentence);
    expect(first({ ...valid, invoice_id: null, credit_note_id: null })).toBe(sentence);
    expect(first({ ...valid, credit_note_id: NOTE })).toBe(sentence);
    expect(first({ ...valid, invoice_id: 'INV-1042' })).toBe(sentence);
    expect(first(valid)).toBeUndefined();
    expect(first({ ...valid, invoice_id: '', credit_note_id: NOTE })).toBeUndefined();
    expect(recordRefundInput.parse({ ...valid, invoice_id: '', credit_note_id: NOTE })).toMatchObject({ invoice_id: null, credit_note_id: NOTE });
  });
  it('asks for an account, a real date, a method and a reason from the list', () => {
    expect(first({ ...valid, account_id: '' })).toBe('Choose the account the money leaves.');
    expect(first({ ...valid, txn_date: '2026-02-30' })).toBe('Enter a valid date.');
    expect(first({ ...valid, method: 'barter' })).toBe('Choose how it was paid.');
    expect(first({ ...valid, reason: 'because' })).toBe('Choose a reason.');
    expect(first({ ...valid, reason: undefined })).toBe('Choose a reason.');
  });
  it('rounds the amount to the sen first, then asks for more than nothing', () => {
    expect(recordRefundInput.parse({ ...valid, amount: 240.005 }).amount).toBe(240.01);
    expect(first({ ...valid, amount: 0.004 })).toBe('Enter an amount above 0.');
    expect(first({ ...valid, amount: '240' })).toBe('Enter an amount above 0.');
  });
  it('is paid out now unless it is said to be pending, and stores empty boxes as nothing', () => {
    expect(recordRefundInput.parse({ ...valid, reference: ' ', notes: '' })).toEqual({
      invoice_id: INVOICE, credit_note_id: null, account_id: ACCOUNT, txn_date: '2026-10-06', method: 'fpx',
      reason: 'damaged_goods', amount: 240, reference: null, notes: null, scheduled: false,
    });
    expect(first({ ...valid, notes: 'x'.repeat(201) })).toBe('That is too long. Keep it to 200 characters or fewer.');
  });
  it('has a label for every reason', () => {
    expect(Object.keys(REFUND_REASON_LABELS).sort()).toEqual([...REFUND_REASONS].sort());
  });
});

describe('refund reads', () => {
  const row = (n: number) => ({
    allocation_id: `a-${n}`, transaction_id: `t-${n}`, number: `PV-${n}`, txn_date: '2026-10-06', method: 'fpx',
    amount: '240.00', transaction_amount: '240.00', status: 'posted', reference: null, reason: 'damaged_goods', notes: null,
    account_id: 'bank', account_name: 'Main Bank', invoice_id: 'inv-1', invoice_no: 'INV-1042',
    credit_note_id: 'cn-1', credit_note_no: 'CN-0034', customer_id: 'c1', customer_name: 'Aisyah Trading',
  });

  it('lists from the refunds view, in the caller’s workspace, newest first, with amounts as numbers', async () => {
    const { ctx, calls } = fakeFinance({ data: [row(1)], error: null });
    expect(await listRefunds(ctx)).toEqual([{ ...row(1), amount: 240, transaction_amount: 240 }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      name: 'finance_refunds',
      op: 'select',
      filters: { org_id: 'org-1' },
      order: ['txn_date desc', 'allocation_id asc'],
      range: [0, PAYMENT_PAGE_SIZE - 1],
    });
    for (const column of ['reason', 'credit_note_no', 'invoice_no', 'customer_id']) expect(calls[0].columns).toContain(column);
  });
  it('reads on past a full page', async () => {
    const full = Array.from({ length: PAYMENT_PAGE_SIZE }, (_, n) => row(n));
    const { ctx, calls } = fakeFinance((call) => ({ data: call.range?.[0] === 0 ? full : [row(-1)], error: null }));
    expect(await listRefunds(ctx)).toHaveLength(PAYMENT_PAGE_SIZE + 1);
    expect(calls).toHaveLength(2);
  });
  it('throws a read error for the screen’s error page', async () => {
    const { ctx } = fakeFinance({ data: null, error: { code: 'XX000', message: 'boom' } });
    await expect(listRefunds(ctx)).rejects.toMatchObject({ code: 'XX000' });
  });
});

describe('refund writes', () => {
  it('records a refund paid out now through the database function, in the caller’s workspace', async () => {
    const { ctx, calls } = fakeFinance({ data: TXN, error: null });
    expect(await recordRefund(ctx, { ...valid, reference: ' TT 88 ' })).toEqual({ ok: true, data: { id: TXN } });
    expect(calls[0]).toMatchObject({ kind: 'rpc', name: 'finance_record_refund' });
    expect(calls[0].args).toEqual({
      target_org: 'org-1',
      refund: {
        invoice_id: INVOICE, credit_note_id: null, account_id: ACCOUNT, txn_date: '2026-10-06', method: 'fpx',
        reason: 'damaged_goods', amount: 240, reference: 'TT 88', notes: null, status: 'posted',
      },
    });
  });
  it('records a pending refund against a credit note as scheduled', async () => {
    const { ctx, calls } = fakeFinance({ data: TXN, error: null });
    await recordRefund(ctx, { ...valid, invoice_id: null, credit_note_id: NOTE, scheduled: true });
    expect(calls[0].args!.refund).toMatchObject({ invoice_id: null, credit_note_id: NOTE, status: 'scheduled' });
    expect(calls[0].args!.refund).not.toHaveProperty('scheduled');
  });
  it('marks a pending refund paid with the function a payment out uses, and returns the number', async () => {
    const { ctx, calls } = fakeFinance({ data: 'PV-0007', error: null });
    expect(await markRefundPaid(ctx, { id: TXN, paid_on: '2026-10-09' })).toEqual({ ok: true, data: { id: TXN, number: 'PV-0007' } });
    expect(calls[0]).toMatchObject({ kind: 'rpc', name: 'finance_mark_payment_paid' });
    expect(calls[0].args).toEqual({ target_org: 'org-1', target_txn: TXN, paid_on: '2026-10-09' });
  });
  it('voids and deletes money out only, scoped to the workspace', async () => {
    const voided = fakeFinance({ data: { id: TXN }, error: null });
    expect(await voidRefund(voided.ctx, { id: TXN })).toEqual({ ok: true, data: { id: TXN } });
    expect(voided.calls[0]).toMatchObject({
      name: 'finance_transactions', op: 'update', filters: { id: TXN, org_id: 'org-1', direction: 'out' },
    });
    expect(Object.keys(voided.calls[0].values!).sort()).toEqual(['status', 'updated_at']);

    const removed = fakeFinance({ data: { id: TXN }, error: null });
    expect(await deleteRefund(removed.ctx, { id: TXN })).toEqual({ ok: true, data: { id: TXN } });
    expect(removed.calls[0]).toMatchObject({
      name: 'finance_transactions', op: 'delete', filters: { id: TXN, org_id: 'org-1', direction: 'out' },
    });
  });
  it('turns each database refusal into a sentence about a refund', async () => {
    const cases: [string, string][] = [
      ['FIN04', 'A refund needs a posted invoice, or an issued credit note, whose customer is in credit.'],
      ['FIN05', 'That is more than the customer is in credit.'],
      ['FIN06', 'The invoice or credit note for this refund no longer exists.'],
      ['FIN09', 'This refund has already been paid out or voided, so that can no longer be done.'],
      ['FIN11', 'That refund no longer exists.'],
      ['23503', 'The account on this refund no longer exists.'],
      ['42501', 'You do not have permission to make changes here.'],
      ['22003', 'That amount is too large.'],
    ];
    for (const [code, message] of cases) {
      const { ctx } = fakeFinance({ data: null, error: { code } });
      expect(await recordRefund(ctx, valid), code).toEqual({ ok: false, error: message });
      expect(await markRefundPaid(ctx, { id: TXN, paid_on: '2026-10-09' }), code).toEqual({ ok: false, error: message });
      expect(await voidRefund(ctx, { id: TXN }), code).toEqual({ ok: false, error: message });
      expect(await deleteRefund(ctx, { id: TXN }), code).toEqual({ ok: false, error: message });
    }
    expect(logged).not.toHaveBeenCalled();
  });
  it('says the refund is gone when void or delete touches no row', async () => {
    const { ctx } = fakeFinance({ data: null, error: null });
    expect(await voidRefund(ctx, { id: TXN })).toEqual({ ok: false, error: 'That refund no longer exists.' });
    expect(await deleteRefund(ctx, { id: TXN })).toEqual({ ok: false, error: 'That refund no longer exists.' });
  });
  it('hides any other database error behind the general message and logs it', async () => {
    const { ctx } = fakeFinance({ data: null, error: { code: 'XX000' } });
    expect(await recordRefund(ctx, valid)).toEqual({ ok: false, error: 'That change could not be saved. Please try again.' });
    expect(logged).toHaveBeenCalled();
  });
});
```

In `tests/finance-schemas.test.ts`, replace:

```ts
import { quotationIdInput, saveQuotationInput } from '@/lib/finance/quotations';
```

with:

```ts
import { quotationIdInput, saveQuotationInput } from '@/lib/finance/quotations';
import { recordRefundInput } from '@/lib/finance/refunds';
```

In `tests/finance-schemas.test.ts`, replace:

```ts
  ['creditNoteIdInput', creditNoteIdInput, { id: ID }],
];
```

with:

```ts
  ['creditNoteIdInput', creditNoteIdInput, { id: ID }],
  ['recordRefundInput (against an invoice)', recordRefundInput, {
    invoice_id: ID, account_id: ID, txn_date: '2026-10-06', method: 'fpx', reason: 'damaged_goods', amount: 240.005, reference: ' ',
  }],
  ['recordRefundInput (pending, against a credit note, the invoice box left empty)', recordRefundInput, {
    invoice_id: '', credit_note_id: ID, account_id: ID, txn_date: '2026-10-06', method: 'cheque', reason: 'other', amount: 0.005,
    reference: ' CHQ 001 ', notes: ' Collected in person ', scheduled: true,
  }],
];
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm exec vitest run tests/finance-refunds.test.ts tests/finance-schemas.test.ts`
Expected: FAIL. Neither file can be loaded: `@/lib/finance/refunds` does not exist.

- [ ] **Step 3: Write `src/lib/finance/refunds.ts`**

Create `src/lib/finance/refunds.ts`:

```ts
/**
 * Refunds. A refund is money out to a customer: one finance_transactions row
 * with direction `out`, allocated to one invoice or to one credit note, with
 * a reason. It can be no more than the customer is in credit on that invoice.
 * Pending is a scheduled payment; refunded is a posted one, numbered PV- like
 * any other money out. A pending refund is marked paid or deleted; a refund
 * that was paid out can only be voided. These are the same database function,
 * update and delete a payment to a supplier uses, kept to money out and
 * worded for a refund. org_id comes from the context.
 */
import { z } from 'zod';
import { LINE_MESSAGES, isoDate, optionalText, ringgitAmount } from './document-lines';
import {
  PAYMENT_METHODS,
  PAYMENT_PAGE_SIZE,
  type PaymentInRow,
  type PaymentMethod,
  markPaymentPaidInput,
  paymentIdInput,
} from './money';
import {
  type FinResult,
  type FinanceWriteContext,
  NOT_ALLOWED,
  PG_FORBIDDEN,
  PG_FOREIGN_KEY,
  PG_OUT_OF_RANGE,
  TOO_LARGE,
  pgCode,
  writeFailed,
} from './result';

export const REFUND_REASONS = ['order_cancelled', 'damaged_goods', 'wrong_item', 'overpayment', 'other'] as const;
export type RefundReason = (typeof REFUND_REASONS)[number];

export const REFUND_REASON_LABELS: Record<RefundReason, string> = {
  order_cancelled: 'Order cancelled',
  damaged_goods: 'Damaged goods',
  wrong_item: 'Wrong item',
  overpayment: 'Overpayment',
  other: 'Other',
};

export const REFUND_MESSAGES = {
  document: 'Choose the invoice or the credit note this refund is for.',
  account: 'Choose the account the money leaves.',
  date: LINE_MESSAGES.date,
  method: 'Choose how it was paid.',
  reason: 'Choose a reason.',
  amount: 'Enter an amount above 0.',
  tooLong: LINE_MESSAGES.tooLong,
  gone: 'That refund no longer exists.',
  // FIN04
  notInCredit: 'A refund needs a posted invoice, or an issued credit note, whose customer is in credit.',
  // FIN05
  tooMuch: 'That is more than the customer is in credit.',
  // FIN06
  notFound: 'The invoice or credit note for this refund no longer exists.',
  // FIN09. A menu offers only what a refund's status allows, so this reaches a person only when the
  // refund changed under them: paid out or voided in another tab. True of each.
  locked: 'This refund has already been paid out or voided, so that can no longer be done.',
  missing: 'The account on this refund no longer exists.',
} as const;

const M = REFUND_MESSAGES;

/** An invoice's or a credit note's id, or nothing chosen (null, or an empty string from a select). */
const optionalDocument = z
  .union([z.string().uuid(M.document), z.literal(''), z.null()], { error: M.document })
  .transform((v) => (v === '' ? null : v))
  .default(null);

/** Money out to a customer against one invoice or one credit note: paid out now, or pending. */
export const recordRefundInput = z
  .object({
    invoice_id: optionalDocument,
    credit_note_id: optionalDocument,
    account_id: z.string({ error: M.account }).uuid(M.account),
    txn_date: isoDate,
    method: z.enum(PAYMENT_METHODS, { error: M.method }),
    reason: z.enum(REFUND_REASONS, { error: M.reason }),
    amount: ringgitAmount(M.amount),
    reference: optionalText.default(null),
    notes: optionalText.default(null),
    /** True for a refund still to be paid out; it holds the customer's credit until it is marked paid or deleted. */
    scheduled: z.boolean().default(false),
  })
  .refine((v) => (v.invoice_id === null) !== (v.credit_note_id === null), { message: M.document, path: ['invoice_id'] });

const REFUSALS: Record<string, string> = {
  FIN04: M.notInCredit,
  FIN05: M.tooMuch,
  FIN06: M.notFound,
  FIN09: M.locked,
  FIN11: M.gone,
  [PG_FOREIGN_KEY]: M.missing,
  [PG_FORBIDDEN]: NOT_ALLOWED,
  [PG_OUT_OF_RANGE]: TOO_LARGE,
};

function refundWriteFailed(fnName: string, error: unknown): { ok: false; error: string } {
  const refusal = REFUSALS[pgCode(error) ?? ''];
  return refusal ? { ok: false, error: refusal } : writeFailed(fnName, error);
}

/* ---- reads ------------------------------------------------------------ */

/**
 * One refund. `allocation_id` is the row's key. `invoice_id` is the invoice
 * whichever way the refund was recorded; `credit_note_id` is set when it was
 * put against a credit note. A voided refund is included; callers filter.
 */
export type RefundRow = {
  allocation_id: string;
  transaction_id: string;
  number: string | null;
  txn_date: string;
  method: PaymentMethod;
  amount: number;
  transaction_amount: number;
  status: PaymentInRow['status'];
  reference: string | null;
  reason: RefundReason;
  notes: string | null;
  account_id: string;
  account_name: string;
  invoice_id: string;
  invoice_no: string | null;
  credit_note_id: string | null;
  credit_note_no: string | null;
  customer_id: string;
  customer_name: string;
};

const REFUND_COLUMNS =
  'allocation_id,transaction_id,number,txn_date,method,amount,transaction_amount,status,reference,reason,notes,' +
  'account_id,account_name,invoice_id,invoice_no,credit_note_id,credit_note_no,customer_id,customer_name';

/** Every refund in the workspace, newest first, read a page at a time. */
export async function listRefunds(ctx: FinanceWriteContext): Promise<RefundRow[]> {
  const rows: RefundRow[] = [];
  for (let from = 0; ; from += PAYMENT_PAGE_SIZE) {
    const { data, error } = await ctx.client
      .from('finance_refunds')
      .select(REFUND_COLUMNS)
      .eq('org_id', ctx.orgId)
      .order('txn_date', { ascending: false })
      .order('allocation_id', { ascending: true })
      .range(from, from + PAYMENT_PAGE_SIZE - 1);
    if (error) throw error;
    const page = (data ?? []) as unknown as Record<string, unknown>[];
    rows.push(
      ...page.map((row) => ({
        ...(row as unknown as RefundRow),
        amount: Number(row.amount),
        transaction_amount: Number(row.transaction_amount),
      })),
    );
    if (page.length < PAYMENT_PAGE_SIZE) return rows;
  }
}

/* ---- writes ----------------------------------------------------------- */

/** Records a refund, paid out now or pending, against one invoice or one credit note. */
export async function recordRefund(
  ctx: FinanceWriteContext,
  input: z.input<typeof recordRefundInput>,
): Promise<FinResult<{ id: string }>> {
  const { scheduled, ...refund } = recordRefundInput.parse(input);
  const { data, error } = await ctx.client.rpc('finance_record_refund', {
    target_org: ctx.orgId,
    refund: { ...refund, status: scheduled ? 'scheduled' : 'posted' },
  });
  if (error || !data) return refundWriteFailed('recordRefund', error);
  return { ok: true, data: { id: data as string } };
}

/**
 * A pending refund has now been paid out: it gets its PV- number and the
 * invoice shows it. The database looks at the customer's credit once more,
 * and refuses if it has gone since the refund was recorded.
 */
export async function markRefundPaid(
  ctx: FinanceWriteContext,
  input: z.input<typeof markPaymentPaidInput>,
): Promise<FinResult<{ id: string; number: string }>> {
  const { id, paid_on } = markPaymentPaidInput.parse(input);
  const { data, error } = await ctx.client.rpc('finance_mark_payment_paid', {
    target_org: ctx.orgId,
    target_txn: id,
    paid_on,
  });
  if (error || !data) return refundWriteFailed('markRefundPaid', error);
  return { ok: true, data: { id, number: data as string } };
}

/** Voids a refund that was paid out: the customer is in credit by that amount again. */
export async function voidRefund(
  ctx: FinanceWriteContext,
  input: z.input<typeof paymentIdInput>,
): Promise<FinResult<{ id: string }>> {
  const { id } = paymentIdInput.parse(input);
  const { data, error } = await ctx.client
    .from('finance_transactions')
    .update({ status: 'void', updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('org_id', ctx.orgId)
    .eq('direction', 'out')
    .select('id')
    .maybeSingle();
  if (error) return refundWriteFailed('voidRefund', error);
  if (!data) return { ok: false, error: M.gone };
  return { ok: true, data: { id: data.id } };
}

/** Deletes a pending refund. One that was paid out is refused: void it. */
export async function deleteRefund(
  ctx: FinanceWriteContext,
  input: z.input<typeof paymentIdInput>,
): Promise<FinResult<{ id: string }>> {
  const { id } = paymentIdInput.parse(input);
  const { data, error } = await ctx.client
    .from('finance_transactions')
    .delete()
    .eq('id', id)
    .eq('org_id', ctx.orgId)
    .eq('direction', 'out')
    .select('id')
    .maybeSingle();
  if (error) return refundWriteFailed('deleteRefund', error);
  if (!data) return { ok: false, error: M.gone };
  return { ok: true, data: { id: data.id } };
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vitest run tests/finance-refunds.test.ts tests/finance-schemas.test.ts tests/finance-money.test.ts tests/finance-payments-in.test.ts`
Expected: PASS, all four files. The last two were not edited: `money.ts` is as it was.

- [ ] **Step 5: Type-check, lint and commit**

Run: `pnpm exec tsc --noEmit` then `pnpm lint`
Expected: no errors and no warnings.

```bash
git add src/lib/finance/refunds.ts tests/finance-refunds.test.ts tests/finance-schemas.test.ts
git commit -m "feat: the data layer for refunds"
```

---

### Task 5: The live Invoices code learns about credit notes and refunds

**Files:**
- Modify: `tests/finance-invoices.test.ts`, `tests/finance-sales-data.test.ts`, `tests/finance-contacts.test.ts`, `tests/finance-sales-views.test.ts`, `tests/finance-receipt-form.test.ts`, `tests/finance-sales-rules.test.ts`, `tests/finance-invoice-form.test.ts`, `tests/finance-receivable.test.ts`
- Modify: `src/lib/finance/invoices.ts`, `src/lib/finance/contacts.ts`, `src/lib/finance/sales-views.ts`
- Modify: `src/components/finance/invoices-view.tsx`
- Replace: `src/screens/finance/sales-sample.ts`
- Modify: `src/screens/finance/customers-suppliers.tsx` (one sample figure)

**Interfaces:**
- Consumes: the columns `credited` and `refunded` of `finance_invoice_totals` and the code `FIN12` (Task 1).
- Produces:
  - `InvoiceListRow` gains `credited: number` and `refunded: number`. `balance` is `total − paid − credited + refunded` and may be below zero. `InvoiceDetail` extends it, so it has them too.
  - `INVOICE_MESSAGES.hasCreditNotes` (for `FIN12`); `INVOICE_MESSAGES.hasPayments` and `CONTACT_MESSAGES.hasInvoices` reworded.
  - `inCredit(invoice: InvoiceListRow): number`: how much the customer is in credit on the invoice; 0 unless it is issued and its balance is below zero.
  - `balanceText(invoice: InvoiceListRow): string`: the Balance cell: `'—'` for a draft or void invoice, `'RM 30.00 in credit'` below zero, otherwise `rm(balance)`.
  - `invoicesCsv` writes eleven columns: `Credited` and `Refunded` come after `Paid`.
  - `SAMPLE_INVOICES` rows carry `credited` and `refunded`. Their figures are the sample credit notes and refunds Task 6 adds to the same file.

**This task changes code that production serves.** Read "What an invoice still owes: every place that says so" above first. Nothing here works the balance out again: every place goes on reading `balance`, and the only new behaviour is how a balance below zero is worded. `receivableInvoices`, `invoicesView`, `invoiceActions` and `contactsView` are not edited; the tests added for them pin that they already do the right thing with a credited invoice, so a later change cannot quietly break it.

After this task the Invoices list asks the database for `credited` and `refunded`. That is why the code must not deploy before the migration is applied.

- [ ] **Step 1: Write the failing tests**

Every fixture that builds an `InvoiceListRow` gains the two fields; the cases that matter are added beside them.

In `tests/finance-invoices.test.ts`, replace:

```ts
    invoice_date: '2026-10-01', due_date: '2026-10-31', total: '132.50', paid: '100.00', balance: '32.50',
    display_status: 'sent', einvoice_status: 'none', einvoice_uuid: null,
  });
```

with:

```ts
    invoice_date: '2026-10-01', due_date: '2026-10-31', total: '132.50', paid: '100.00', credited: '20.00', refunded: '0.00',
    balance: '12.50', display_status: 'sent', einvoice_status: 'none', einvoice_uuid: null,
  });
```

In `tests/finance-invoices.test.ts`, replace:

```ts
    expect(await listInvoices(ctx)).toEqual([{ ...row(1), total: 132.5, paid: 100, balance: 32.5 }]);
```

with:

```ts
    expect(await listInvoices(ctx)).toEqual([{ ...row(1), total: 132.5, paid: 100, credited: 20, refunded: 0, balance: 12.5 }]);
```

In `tests/finance-invoices.test.ts`, replace:

```ts
    expect(calls[0].columns).toContain('einvoice_uuid');
  });
```

with:

```ts
    expect(calls[0].columns).toContain('einvoice_uuid');
    expect(calls[0].columns).toContain('credited');
    expect(calls[0].columns).toContain('refunded');
  });
  it('reads a customer in credit as a balance below zero', async () => {
    const inCredit = { ...row(2), paid: '132.50', credited: '30.00', refunded: '10.00', balance: '-20.00', display_status: 'paid' };
    const { ctx } = fakeFinance({ data: [inCredit], error: null });
    expect(await listInvoices(ctx)).toMatchObject([{ paid: 132.5, credited: 30, refunded: 10, balance: -20, display_status: 'paid' }]);
  });
```

In `tests/finance-invoices.test.ts`, replace:

```ts
      ['FIN02', 'This invoice has payments. Void them on Payments In before voiding it.'],
```

with:

```ts
      ['FIN02', 'This invoice has payments or refunds. Void the payments on Payments In, and void or delete the refunds on Refunds, before voiding it.'],
      ['FIN12', 'This invoice has credit notes. Void them on Credit Notes, or delete the drafts, before voiding it.'],
```

In `tests/finance-sales-data.test.ts`, replace:

```ts
  it('says where the payments of an invoice are voided', () => {
    expect(INVOICE_MESSAGES.hasPayments).toBe('This invoice has payments. Void them on Payments In before voiding it.');
    // A receipt cannot be deleted, so the sentence must not offer that.
    expect(INVOICE_MESSAGES.hasPayments).not.toMatch(/delete/i);
  });
```

with:

```ts
  it('says where the payments and the refunds of an invoice are voided', () => {
    // A receipt cannot be deleted, so deleting is offered for refunds only: a pending refund has no void.
    expect(INVOICE_MESSAGES.hasPayments).toBe(
      'This invoice has payments or refunds. Void the payments on Payments In, and void or delete the refunds on Refunds, before voiding it.',
    );
    expect(INVOICE_MESSAGES.hasPayments).not.toMatch(/delete the payments/i);
  });
  it('has its own sentence for an invoice that credit notes hold', async () => {
    const { ctx } = fakeFinance({ data: null, error: { code: 'FIN12' } });
    expect(await voidInvoice(ctx, { id: ID })).toEqual({
      ok: false,
      error: 'This invoice has credit notes. Void them on Credit Notes, or delete the drafts, before voiding it.',
    });
  });
```

In `tests/finance-contacts.test.ts`, replace:

```ts
      error: 'This contact has invoices, so it has to stay a customer.',
```

with:

```ts
      error: 'This contact has invoices or quotations, so it has to stay a customer.',
```

In `tests/finance-receipt-form.test.ts`, replace:

```ts
  total: 100,
  paid: 0,
  balance: 100,
  display_status: 'sent',
```

with:

```ts
  total: 100,
  paid: 0,
  credited: 0,
  refunded: 0,
  balance: 100,
  display_status: 'sent',
```

In `tests/finance-sales-rules.test.ts`, replace:

```ts
  total: 100,
  paid: 0,
  balance: 100,
  display_status,
```

with:

```ts
  total: 100,
  paid: 0,
  credited: 0,
  refunded: 0,
  balance: 100,
  display_status,
```

In `tests/finance-invoice-form.test.ts`, replace:

```ts
    total: 263.94,
    paid: 0,
    balance: 263.94,
```

with:

```ts
    total: 263.94,
    paid: 0,
    credited: 0,
    refunded: 0,
    balance: 263.94,
```

In `tests/finance-sales-views.test.ts`, replace:

```ts
    total: 100,
    paid: 0,
    balance: 100,
    display_status: 'sent',
```

with:

```ts
    total: 100,
    paid: 0,
    credited: 0,
    refunded: 0,
    balance: 100,
    display_status: 'sent',
```

In `tests/finance-sales-views.test.ts`, replace:

```ts
  PAYMENT_IN_STATUS_LABELS,
  filterInvoices,
```

with:

```ts
  PAYMENT_IN_STATUS_LABELS,
  balanceText,
  filterInvoices,
```

In `tests/finance-sales-views.test.ts`, replace:

```ts
  invoiceCustomers,
  invoicesCsv,
  owed,
```

with:

```ts
  inCredit,
  invoiceCustomers,
  invoicesCsv,
  owed,
```

In `tests/finance-sales-views.test.ts`, replace:

```ts
describe('CSV export', () => {
  it('writes the invoices table, with a formula-looking customer name made harmless', () => {
```

with:

```ts
describe('an invoice whose customer is in credit', () => {
  // RM 100 invoiced and paid, then RM 30 credited: the customer is RM 30 in credit until it is refunded.
  const credit = () => invoice({ total: 100, paid: 100, credited: 30, balance: -30, display_status: 'paid' });

  it('keeps its balance below zero, and says how much the customer is in credit', () => {
    expect(owed(credit())).toBe(-30);
    expect(inCredit(credit())).toBe(30);
    expect(balanceText(credit())).toBe('RM 30.00 in credit');
  });
  it('is in credit by nothing when it is owed, settled, a draft or void', () => {
    expect(inCredit(invoice({ balance: 40 }))).toBe(0);
    expect(inCredit(invoice({ total: 100, paid: 70, credited: 30, balance: 0, display_status: 'paid' }))).toBe(0);
    // A draft or a void invoice has no balance to speak of, whatever the row says.
    expect(inCredit(invoice({ balance: -30, display_status: 'draft' }))).toBe(0);
    expect(inCredit(invoice({ balance: -30, display_status: 'void' }))).toBe(0);
    expect(inCredit(invoice({ balance: -0.1 - 0.2, display_status: 'paid' }))).toBe(0.3);
  });
  it('words every other balance as before: an amount, or a dash on a draft and a void invoice', () => {
    expect(balanceText(invoice({ balance: 1250.5 }))).toBe('RM 1,250.50');
    expect(balanceText(invoice({ balance: 0, display_status: 'paid' }))).toBe('RM 0.00');
    expect(balanceText(invoice({ balance: 80, display_status: 'draft' }))).toBe('—');
    expect(balanceText(invoice({ balance: 80, display_status: 'void' }))).toBe('—');
    expect(balanceText(invoice({ balance: -0.01, display_status: 'paid' }))).toBe('RM 0.01 in credit');
  });
  it('counts as paid, and never lowers what the other invoices are owed', () => {
    const view = invoicesView([credit(), invoice({ balance: 100 }), invoice({ balance: 50, display_status: 'overdue' })], [], today);
    expect(view.stats.map((s) => [s.label, s.value, s.delta])).toEqual([
      ['Total receivable', 'RM 150', '2 open invoices'],
      ['Due this week', 'RM 0', '0 invoices'],
      ['Overdue', 'RM 50', '1 invoice'],
      ['Received (MTD)', 'RM 0', '0 payments'],
    ]);
    expect(view.byStatus.find((s) => s.key === 'paid')?.value).toBe(1);
  });
  it('owes less, and stays open, when it is credited before it is paid', () => {
    const partCredited = invoice({ total: 100, credited: 30, balance: 70 });
    expect(balanceText(partCredited)).toBe('RM 70.00');
    expect(invoicesView([partCredited], [], today).stats[0]).toMatchObject({ value: 'RM 70', delta: '1 open invoice' });
  });
  it('is found by the Paid filter like any other paid invoice', () => {
    const rows = [credit(), invoice({ balance: 100 })];
    expect(filterInvoices(rows, '', 'paid')).toHaveLength(1);
    expect(filterInvoices(rows, '', 'open')).toHaveLength(2);
  });
});

describe('CSV export', () => {
  it('writes the invoices table, with a formula-looking customer name made harmless', () => {
```

In `tests/finance-sales-views.test.ts`, replace:

```ts
      '\uFEFFNo.,Date,Customer,Due,Total,Paid,Balance,Status,e-Invois\r\n' +
        "INV-0007,2026-10-01,'=cmd|calc,2026-10-31,1250.5,1000,250.5,Sent,Validated\r\n" +
        ',2026-10-01,"Lim, Tan & Co",2026-10-31,80,0,,Draft,\r\n',
    );
  });
```

with:

```ts
      '\uFEFFNo.,Date,Customer,Due,Total,Paid,Credited,Refunded,Balance,Status,e-Invois\r\n' +
        "INV-0007,2026-10-01,'=cmd|calc,2026-10-31,1250.5,1000,0,0,250.5,Sent,Validated\r\n" +
        ',2026-10-01,"Lim, Tan & Co",2026-10-31,80,0,0,0,,Draft,\r\n',
    );
  });

  it('writes what was credited and refunded, and a balance below zero for a customer in credit, so the columns add up', () => {
    const csv = invoicesCsv([
      invoice({ invoice_no: 'INV-0008', total: 100, paid: 100, credited: 30, refunded: 10, balance: -20, display_status: 'paid' }),
      invoice({ invoice_no: 'INV-0009', total: 100, credited: 30, balance: 70 }),
    ]);
    expect(csv.split('\r\n').slice(1, 3)).toEqual([
      'INV-0008,2026-10-01,Aisyah Trading,2026-10-31,100,100,30,10,-20,Paid,',
      'INV-0009,2026-10-01,Aisyah Trading,2026-10-31,100,0,30,0,70,Sent,',
    ]);
  });
```

In `tests/finance-sales-views.test.ts`, replace:

```ts
      ',2026-10-01,Aisyah Trading,2026-10-31,80,0,,Draft,',
      'INV-0002,2026-10-01,Aisyah Trading,2026-10-31,90,0,,Void,',
      'INV-0003,2026-10-01,Aisyah Trading,2026-10-31,70,20,50,Overdue,',
      'INV-0004,2026-10-01,Aisyah Trading,2026-10-31,60,60,0,Paid,',
```

with:

```ts
      ',2026-10-01,Aisyah Trading,2026-10-31,80,0,0,0,,Draft,',
      'INV-0002,2026-10-01,Aisyah Trading,2026-10-31,90,0,0,0,,Void,',
      'INV-0003,2026-10-01,Aisyah Trading,2026-10-31,70,20,0,0,50,Overdue,',
      'INV-0004,2026-10-01,Aisyah Trading,2026-10-31,60,60,0,0,0,Paid,',
```

In `tests/finance-sales-views.test.ts`, replace:

```ts
      expect(paid, i.invoice_no ?? 'draft').toBe(i.paid);
      expect(i.balance, i.invoice_no ?? 'draft').toBe(i.total - i.paid);
    }
  });
```

with:

```ts
      expect(paid, i.invoice_no ?? 'draft').toBe(i.paid);
      expect(i.balance, i.invoice_no ?? 'draft').toBe(i.total - i.paid - i.credited + i.refunded);
      // An open invoice is owed something; one with nothing left to pay reads Paid, in credit or not.
      if (i.display_status === 'sent' || i.display_status === 'overdue') expect(i.balance, i.invoice_no ?? '').toBeGreaterThan(0);
      if (i.display_status === 'paid') expect(i.balance, i.invoice_no ?? '').toBeLessThanOrEqual(0);
    }
  });
```

In `tests/finance-sales-views.test.ts`, replace:

```ts
      ['Total receivable', 'RM 21.0k', '4 open invoices'],
      ['Due this week', 'RM 6,400', '1 invoice'],
```

with:

```ts
      // INV-1037 is owed RM 5,880: its RM 6,400 less a credit note of RM 520.
      ['Total receivable', 'RM 20.5k', '4 open invoices'],
      ['Due this week', 'RM 5,880', '1 invoice'],
```

In `tests/finance-receipt-form.test.ts`, replace:

```ts
describe('receivableInvoices', () => {
```

with:

```ts
describe('receivableInvoices, with credit notes', () => {
  it('offers a part-credited invoice for what it still owes, which is its balance', () => {
    const offered = receivableInvoices([invoice(1, { total: 100, credited: 30, balance: 70 })], []);
    expect(offered).toMatchObject([{ balance: 70, held: 0, payable: 70 }]);
  });
  it('does not offer an invoice whose customer is in credit, or one that credit notes settled', () => {
    const inCredit = invoice(2, { total: 100, paid: 100, credited: 30, balance: -30, display_status: 'paid' });
    const settled = invoice(3, { total: 100, credited: 100, balance: 0, display_status: 'paid' });
    expect(receivableInvoices([inCredit, settled], [])).toEqual([]);
  });
});

describe('receivableInvoices', () => {
```

In `tests/finance-sales-rules.test.ts`, replace:

```ts
describe('invoiceActions', () => {
```

with:

```ts
describe('invoiceActions, for a customer in credit', () => {
  it('offers no payment on a paid invoice whose balance is below zero', () => {
    const inCredit = invoice('paid', { paid: 100, credited: 30, balance: -30 });
    expect(invoiceActions(inCredit, true)).toEqual(['einvoice', 'void']);
  });
});

describe('invoiceActions', () => {
```

In `tests/finance-receivable.test.ts`, replace:

```ts
describe('listInvoiceBalances', () => {
```

with:

```ts
describe('Receivable and a customer in credit', () => {
  it('does not take a customer’s credit on one invoice off what they owe on another', () => {
    const view = contactsView(
      [contact({ id: 'c1' })],
      [],
      [
        { customer_id: 'c1', balance: 500, display_status: 'sent' },
        // Only open invoices are read; if a paid one in credit arrived anyway it would not be counted.
        { customer_id: 'c1', balance: -200, display_status: 'paid' },
      ],
    );
    expect(view.stats.receivable).toBe(500);
    expect(view.rows[0].receivable).toBe(500);
  });
});

describe('listInvoiceBalances', () => {
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm exec vitest run tests/finance-invoices.test.ts tests/finance-sales-data.test.ts tests/finance-contacts.test.ts tests/finance-sales-views.test.ts`
Expected: FAIL in all four. `finance-invoices`: the row comes back with `credited: '20.00'` as text, and `FIN12` gets the general message. `finance-sales-data` and `finance-contacts`: the old sentences. `finance-sales-views`: `balanceText` and `inCredit` are not functions, and the CSV has nine columns.

`tests/finance-receipt-form.test.ts`, `tests/finance-sales-rules.test.ts`, `tests/finance-receivable.test.ts` and `tests/finance-invoice-form.test.ts` pass already: their new cases pin behaviour that is already right. `pnpm exec tsc --noEmit` reports that `credited` does not exist on `InvoiceListRow` until Step 3.

- [ ] **Step 3: `src/lib/finance/invoices.ts`: two more figures on a row, and the new refusal**

In `src/lib/finance/invoices.ts`, replace:

```ts
  // A receipt is posted the moment it is recorded, so it can only be voided, never deleted.
  hasPayments: 'This invoice has payments. Void them on Payments In before voiding it.',
```

with:

```ts
  // FIN02. Money in against the invoice, or a refund put against the invoice itself.
  hasPayments: 'This invoice has payments or refunds. Void the payments on Payments In, and void or delete the refunds on Refunds, before voiding it.',
  // FIN12. A draft credit note holds the invoice as much as an issued one does.
  hasCreditNotes: 'This invoice has credit notes. Void them on Credit Notes, or delete the drafts, before voiding it.',
```

In `src/lib/finance/invoices.ts`, replace:

```ts
  FIN11: M.gone,
  [PG_UNIQUE]: M.numberTaken,
```

with:

```ts
  FIN11: M.gone,
  FIN12: M.hasCreditNotes,
  [PG_UNIQUE]: M.numberTaken,
```

In `src/lib/finance/invoices.ts`, replace:

```ts
/** `sent` is a posted invoice that is not yet paid in full and not past its due date. */
```

with:

```ts
/**
 * `sent` is a posted invoice that is still owed and not past its due date.
 * `paid` is a posted invoice with nothing left to pay: settled by money in,
 * by credit notes, or both. Its balance is zero, or below zero when the
 * customer is in credit.
 */
```

In `src/lib/finance/invoices.ts`, replace:

```ts
  total: number;
  paid: number;
  balance: number;
  display_status: InvoiceDisplayStatus;
```

with:

```ts
  total: number;
  /** Posted money in. */
  paid: number;
  /** Issued credit notes. */
  credited: number;
  /** Posted refunds, put against the invoice itself or against one of its credit notes. */
  refunded: number;
  /** total − paid − credited + refunded. Below zero, the customer is in credit by that much. */
  balance: number;
  display_status: InvoiceDisplayStatus;
```

In `src/lib/finance/invoices.ts`, replace:

```ts
  'id,invoice_no,customer_id,customer_name,invoice_date,due_date,total,paid,balance,display_status,einvoice_status,einvoice_uuid';
```

with:

```ts
  'id,invoice_no,customer_id,customer_name,invoice_date,due_date,total,paid,credited,refunded,balance,display_status,einvoice_status,einvoice_uuid';
```

In `src/lib/finance/invoices.ts`, replace:

```ts
    paid: Number(row.paid),
    balance: Number(row.balance),
```

with:

```ts
    paid: Number(row.paid),
    credited: Number(row.credited),
    refunded: Number(row.refunded),
    balance: Number(row.balance),
```

- [ ] **Step 4: `src/lib/finance/contacts.ts`: the Customer sentence**

In `src/lib/finance/contacts.ts`, replace:

```ts
  hasInvoices: 'This contact has invoices, so it has to stay a customer.',
```

with:

```ts
  hasInvoices: 'This contact has invoices or quotations, so it has to stay a customer.',
```

- [ ] **Step 5: `src/lib/finance/sales-views.ts`: wording a balance below zero, and the CSV**

In `src/lib/finance/sales-views.ts`, replace:

```ts
import { rmShort } from './format';
```

with:

```ts
import { rm, rmShort } from './format';
```

In `src/lib/finance/sales-views.ts`, replace:

```ts
  paymentCount,
  sum,
```

with:

```ts
  paymentCount,
  round2,
  sum,
```

In `src/lib/finance/sales-views.ts`, replace:

```ts
/** What a customer still owes on an invoice: its balance once it has gone out, nothing (null) on a draft or a void one. */
export function owed(invoice: InvoiceListRow): number | null {
  return isIssued(invoice) ? invoice.balance : null;
}
```

with:

```ts
/**
 * What a customer still owes on an invoice: its balance once it has gone out,
 * nothing (null) on a draft or a void one. Below zero, the customer is in
 * credit: they have paid, or been credited, more than the invoice came to.
 */
export function owed(invoice: InvoiceListRow): number | null {
  return isIssued(invoice) ? invoice.balance : null;
}

/** How much the customer is in credit on an invoice: 0 unless its balance is below zero. */
export function inCredit(invoice: InvoiceListRow): number {
  const balance = owed(invoice);
  return balance !== null && balance < 0 ? round2(-balance) : 0;
}

/**
 * The Balance cell of an invoice row. A draft or a void invoice owes nothing
 * and shows a dash. A customer in credit is never shown as a negative amount:
 * the cell says how much they are in credit.
 */
export function balanceText(invoice: InvoiceListRow): string {
  const balance = owed(invoice);
  if (balance === null) return '—';
  return balance < 0 ? `${rm(-balance)} in credit` : rm(balance);
}
```

In `src/lib/finance/sales-views.ts`, replace:

```ts
/** The invoices table as a CSV file. Amounts are numbers, so a spreadsheet can add them up. */
export function invoicesCsv(invoices: InvoiceListRow[]): string {
  return toCsv(
    ['No.', 'Date', 'Customer', 'Due', 'Total', 'Paid', 'Balance', 'Status', 'e-Invois'],
    invoices.map((i) => [
      i.invoice_no,
      i.invoice_date,
      i.customer_name,
      i.due_date,
      i.total,
      i.paid,
      owed(i),
```

with:

```ts
/**
 * The invoices table as a CSV file. Amounts are numbers, so a spreadsheet can
 * add them up: Total − Paid − Credited + Refunded is the Balance, which is
 * below zero for a customer in credit.
 */
export function invoicesCsv(invoices: InvoiceListRow[]): string {
  return toCsv(
    ['No.', 'Date', 'Customer', 'Due', 'Total', 'Paid', 'Credited', 'Refunded', 'Balance', 'Status', 'e-Invois'],
    invoices.map((i) => [
      i.invoice_no,
      i.invoice_date,
      i.customer_name,
      i.due_date,
      i.total,
      i.paid,
      i.credited,
      i.refunded,
      owed(i),
```

- [ ] **Step 6: `src/components/finance/invoices-view.tsx`: the Balance cell and the void question**

The view stops formatting the balance itself.

In `src/components/finance/invoices-view.tsx`, replace:

```tsx
/** A draft or void invoice owes nothing: a dash, as a draft's number is. */
const formatOwed = (balance: number | null) => (balance === null ? '—' : rm(balance));

/** One thing open at a time: a form card, or a question in one row. */
```

with:

```tsx
/** One thing open at a time: a form card, or a question in one row. */
```

In `src/components/finance/invoices-view.tsx`, replace:

```tsx
{formatOwed(owed(i))}
```

with:

```tsx
{balanceText(i)}
```

In `src/components/finance/invoices-view.tsx`, replace:

```tsx
  type InvoicesViewData,
  customerChoice,
```

with:

```tsx
  type InvoicesViewData,
  balanceText,
  customerChoice,
```

In `src/components/finance/invoices-view.tsx`, replace:

```tsx
  invoicesCsv,
  owed,
} from '@/lib/finance/sales-views';
```

with:

```tsx
  invoicesCsv,
} from '@/lib/finance/sales-views';
```

In `src/components/finance/invoices-view.tsx`, replace:

```tsx
          Void and nothing more is owed on it. This cannot be undone. An invoice that has payments cannot be voided
          until they are voided on Payments In.
```

with:

```tsx
          Void and nothing more is owed on it. This cannot be undone. An invoice that has payments, refunds or credit
          notes cannot be voided until they are voided.
```

`rm` is still imported there: the Total cell and the questions use it.

- [ ] **Step 7: The sample**

The sample invoices get the two fields, with the figures the sample credit notes and refunds of Task 6 will add up to. One of them, the credit note on `INV-1037`, is on an invoice that is still owed, so the sample's receivable changes; the Customers & Suppliers sample is changed to match.

Replace the whole of `src/screens/finance/sales-sample.ts` with:

```ts
/**
 * Sample invoices and payments in (Rimba Ventures Sdn Bhd), shown on Invoices
 * and Payments In when there is no database. Raw rows in the shape the data
 * layer reads, so both screens run them through the same builders as live
 * data and their figures agree with each other. What is credited and refunded
 * on an invoice here is what the sample credit notes and refunds come to;
 * those rows join this file with the screens that show them.
 */
import type { EInvoiceStatus, InvoiceDisplayStatus, InvoiceListRow } from '@/lib/finance/invoices';
import type { PaymentInRow, PaymentMethod } from '@/lib/finance/money';

/** The sample is a fixed month, so its figures do not drain away as the calendar moves on. */
export const SAMPLE_TODAY = '2026-10-10';

const numbered = (prefix: string, n: number) => `${prefix}-${String(n).padStart(4, '0')}`;

/** `credited` is what the sample's issued credit notes on the invoice come to; `refunded` its refunds that were paid out. */
const invoice = (
  n: number,
  invoice_date: string,
  customer_name: string,
  due_date: string,
  total: number,
  display_status: InvoiceDisplayStatus,
  einvoice_status: EInvoiceStatus,
  paid: number = display_status === 'paid' ? total : 0,
  credited: number = 0,
  refunded: number = 0,
): InvoiceListRow => ({
  id: `sample-invoice-${n}`,
  invoice_no: display_status === 'draft' ? null : numbered('INV', n),
  customer_id: customer_name,
  customer_name,
  invoice_date,
  due_date,
  total,
  paid,
  credited,
  refunded,
  balance: total - paid - credited + refunded,
  display_status,
  einvoice_status,
  einvoice_uuid: null,
});

/** Earlier months, so the trend has a shape: [month, invoiced and since paid in full]. */
const SAMPLE_HISTORY: [string, number][] = [
  ['2026-03', 34000],
  ['2026-04', 38000],
  ['2026-05', 36000],
  ['2026-06', 43000],
  ['2026-07', 46000],
  ['2026-08', 41200],
];

export const SAMPLE_INVOICES: InvoiceListRow[] = [
  invoice(1043, '2026-10-08', 'Seri Mutiara Enterprise', '2026-11-07', 2750, 'draft', 'none'),
  // Credited RM 240 and refunded in full.
  invoice(1042, '2026-10-07', 'Aisyah Trading', '2026-11-06', 1240, 'paid', 'validated', 1240, 240, 240),
  invoice(1041, '2026-10-05', 'Zaki Enterprise', '2026-11-04', 3500, 'sent', 'pending', 1000),
  invoice(1040, '2026-10-01', 'Nurul Boutique', '2026-10-08', 8900, 'overdue', 'validated'),
  invoice(1039, '2026-09-28', 'Lim Hardware Sdn Bhd', '2026-10-28', 2100, 'paid', 'validated', 2100, 450, 450),
  // Credited RM 600 and not refunded: the customer is in credit.
  invoice(1038, '2026-09-25', 'Siti Decor', '2026-10-25', 4200, 'paid', 'validated', 4200, 600),
  // Not paid yet: the credit note of RM 520 lowers what is owed.
  invoice(1037, '2026-09-20', 'Nusantara Logistics', '2026-10-15', 6400, 'sent', 'pending', 0, 520),
  invoice(1036, '2026-09-14', 'Langkawi Fresh', '2026-10-14', 5600, 'paid', 'validated', 5600, 180, 180),
  invoice(1035, '2026-09-10', 'Lim Hardware Sdn Bhd', '2026-09-24', 3180, 'overdue', 'validated'),
  // In credit while their refunds are pending.
  invoice(1033, '2026-09-05', 'Nurul Boutique', '2026-10-05', 850, 'paid', 'validated', 850, 680),
  invoice(1032, '2026-09-03', 'Seri Mutiara Enterprise', '2026-10-03', 3180, 'paid', 'validated', 3180, 900, 900),
  invoice(1030, '2026-08-30', 'Nusantara Logistics', '2026-09-29', 6800, 'paid', 'validated', 6800, 320),
  // Newest first, as the real list is: the history is stored oldest first.
  ...SAMPLE_HISTORY.map(([month, total], i) =>
    invoice(1006 - i, `${month}-12`, 'Aisyah Trading', `${month}-26`, total, 'paid', 'validated'),
  ).reverse(),
];

const invoiceNumbered = (n: number): InvoiceListRow => {
  const found = SAMPLE_INVOICES.find((i) => i.id === `sample-invoice-${n}`);
  if (!found) throw new Error(`no sample invoice ${n}`);
  return found;
};

const receipt = (n: number, txn_date: string, invoiceNo: number, method: PaymentMethod, amount?: number): PaymentInRow => {
  const paid = invoiceNumbered(invoiceNo);
  return {
    allocation_id: `sample-receipt-${n}`,
    transaction_id: `sample-receipt-${n}`,
    number: numbered('RC', n),
    txn_date,
    method,
    amount: amount ?? paid.total,
    transaction_amount: amount ?? paid.total,
    status: 'posted',
    reference: null,
    account_id: method === 'cash' ? 'cash' : 'bank',
    account_name: method === 'cash' ? 'Cash in hand' : 'Main Bank',
    invoice_id: paid.id,
    invoice_no: paid.invoice_no,
    customer_name: paid.customer_name,
  };
};

export const SAMPLE_PAYMENTS_IN: PaymentInRow[] = [
  receipt(108, '2026-10-08', 1042, 'fpx'),
  receipt(107, '2026-10-08', 1041, 'fpx', 1000),
  receipt(106, '2026-10-07', 1036, 'fpx'),
  receipt(105, '2026-10-05', 1039, 'bank_transfer'),
  receipt(104, '2026-10-04', 1038, 'card'),
  receipt(103, '2026-10-03', 1032, 'duitnow'),
  receipt(102, '2026-10-02', 1033, 'cash'),
  receipt(101, '2026-09-30', 1030, 'bank_transfer'),
  // Newest first, as the real list is: the history is stored oldest first.
  ...SAMPLE_HISTORY.map(([month], i) => receipt(96 - i, `${month}-24`, 1006 - i, 'bank_transfer')).reverse(),
];
```

In `src/screens/finance/customers-suppliers.tsx`, replace:

```tsx
// screens show the same total receivable.
```

with:

```tsx
// screens show the same total receivable. An invoice in credit is not open
// and is not here: a customer's credit is not taken off what they owe elsewhere.
```

In `src/screens/finance/customers-suppliers.tsx`, replace:

```tsx
  { customer_id: '8', balance: 6400, display_status: 'sent' }, // Nusantara Logistics, INV-1037
```

with:

```tsx
  { customer_id: '8', balance: 5880, display_status: 'sent' }, // Nusantara Logistics, INV-1037 less a credit note of RM 520
```

- [ ] **Step 8: Run the tests**

Run: `pnpm exec vitest run tests/finance-invoices.test.ts tests/finance-sales-data.test.ts tests/finance-contacts.test.ts tests/finance-sales-views.test.ts tests/finance-receipt-form.test.ts tests/finance-sales-rules.test.ts tests/finance-invoice-form.test.ts tests/finance-receivable.test.ts tests/finance-sales-actions.test.ts tests/finance-touchups.test.ts`
Expected: PASS, all ten files. `tests/finance-sales-actions.test.ts` and `tests/finance-touchups.test.ts` were not edited.

- [ ] **Step 9: Type-check, lint and commit**

Run: `pnpm exec tsc --noEmit` then `pnpm lint`
Expected: no errors and no warnings.

Run: `grep -n "formatOwed\|i.balance\b" src/components/finance/invoices-view.tsx`
Expected: no output. The view never prints `balance` itself.

```bash
git add src/lib/finance/invoices.ts src/lib/finance/contacts.ts src/lib/finance/sales-views.ts src/components/finance/invoices-view.tsx src/screens/finance/sales-sample.ts src/screens/finance/customers-suppliers.tsx tests/finance-invoices.test.ts tests/finance-sales-data.test.ts tests/finance-contacts.test.ts tests/finance-sales-views.test.ts tests/finance-receipt-form.test.ts tests/finance-sales-rules.test.ts tests/finance-invoice-form.test.ts tests/finance-receivable.test.ts
git commit -m "feat: invoices show what was credited and refunded, and a customer in credit"
```

---

### Task 6: What the three screens show

**Files:**
- Create: `tests/finance-followon-views.test.ts`
- Create: `src/lib/finance/sales-followon-views.ts`
- Modify: `src/screens/finance/sales-sample.ts`

**Interfaces:**
- Consumes: `QuotationListRow`, `QuotationDisplayStatus` (Task 2); `CreditNoteRow`, `CreditNoteStatus`, `CreditNoteReason`, `CREDIT_NOTE_REASONS`, `CREDIT_NOTE_REASON_LABELS` (Task 3); `RefundRow`, `RefundReason`, `REFUND_REASONS`, `REFUND_REASON_LABELS` (Task 4); `InvoiceListRow`, `inCredit` (Task 5); `PAYMENT_METHOD_LABELS` from `./money`; `toCsv` from `./csv`; `rmShort` from `./format`; `Stat`, `count`, `lastMonths`, `monthOf`, `paymentCount`, `sum`, `thousands` from `./view-helpers`; `Slice` (type) from `@/components/charts`.
- Produces:
  - `customersOf(rows: { customer_id: string; customer_name: string }[]): { id: string; name: string }[]`
  - `type QuotationsViewData = { stats: Stat[]; trend: { label: string; quoted: number; accepted: number }[]; hasTrend: boolean; funnel: Slice[]; funnelCount: number }`
  - `quotationsView(rows: QuotationListRow[], today: string): QuotationsViewData`
  - `type QuotationFilter = 'all' | QuotationDisplayStatus`; `filterQuotations(rows, query, filter, customerId = 'all')`; `quotationInvoice(row): string | null`; `quotationsCsv(rows): string`; `QUOTATION_STATUS_LABELS`
  - `type CreditNotesViewData = { stats: Stat[]; trend: { label: string; credited: number }[]; hasTrend: boolean; byReason: Slice[]; hasReasons: boolean; creditedYtd: string }`
  - `creditNotesView(rows: CreditNoteRow[], today: string): CreditNotesViewData`
  - `type CreditNoteFilter = 'open' | CreditNoteStatus`; `filterCreditNotes(rows, query, filter)`; `refundedOnNote(note): number | null`; `creditNotesCsv(rows): string`; `CREDIT_NOTE_STATUS_LABELS`
  - `type RefundsViewData = { stats: Stat[]; trend: { label: string; refunded: number }[]; hasTrend: boolean; byReason: Slice[]; hasReasons: boolean; refundedYtd: string }`
  - `refundsView(rows: RefundRow[], invoices: InvoiceListRow[], today: string): RefundsViewData`
  - `type RefundFilter = 'open' | 'pending' | 'posted' | 'void'`; `filterRefunds(rows, query, filter)`; `isPendingRefund(row): boolean`; `refundsCsv(rows): string`; `REFUND_STATUS_LABELS`
  - `SAMPLE_QUOTATIONS: QuotationListRow[]`, `SAMPLE_CREDIT_NOTES: CreditNoteRow[]`, `SAMPLE_REFUNDS: RefundRow[]` in `sales-sample.ts`

What each figure means, decided here so the view and its tests agree:

- **Open quotes**: quotations that are Sent and not expired. **Accepted (MTD)**: accepted this UTC month, by the day they were accepted. **Conversion**: accepted, out of accepted, declined and expired; a dash until one of those exists. **Pipeline value**: drafts and open quotes. The trend charts what was quoted (everything but drafts) by quotation date and what was accepted by the day it was accepted. The funnel is this calendar quarter's quotations by quotation date: created, sent (everything but drafts), accepted.
- **Credited (MTD)**, the trend and "by reason" count issued credit notes only, by their date; "by reason" covers this calendar year. **Invoices affected**: invoices with at least one issued credit note.
- **Refunded (MTD)**, the trend and "by reason" count refunds that were paid out only. **Pending**: refunds not yet paid out. **In credit**: what customers are in credit across every invoice; a pending refund has not left the bank, so its amount is still in this figure. **Invoices refunded**: invoices with at least one refund paid out.

- [ ] **Step 1: Write the failing tests**

Create `tests/finance-followon-views.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { CreditNoteRow } from '@/lib/finance/credit-notes';
import type { InvoiceListRow } from '@/lib/finance/invoices';
import type { QuotationListRow } from '@/lib/finance/quotations';
import type { RefundRow } from '@/lib/finance/refunds';
import {
  CREDIT_NOTE_STATUS_LABELS,
  QUOTATION_STATUS_LABELS,
  REFUND_STATUS_LABELS,
  creditNotesCsv,
  creditNotesView,
  customersOf,
  filterCreditNotes,
  filterQuotations,
  filterRefunds,
  isPendingRefund,
  quotationInvoice,
  quotationsCsv,
  quotationsView,
  refundedOnNote,
  refundsCsv,
  refundsView,
} from '@/lib/finance/sales-followon-views';
import { invoicesView } from '@/lib/finance/sales-views';
import {
  SAMPLE_CREDIT_NOTES,
  SAMPLE_INVOICES,
  SAMPLE_PAYMENTS_IN,
  SAMPLE_QUOTATIONS,
  SAMPLE_REFUNDS,
  SAMPLE_TODAY,
} from '@/screens/finance/sales-sample';

const today = '2026-10-09';

let seq = 0;
const quotation = (q: Partial<QuotationListRow> = {}): QuotationListRow => {
  seq += 1;
  return {
    id: `quotation-${seq}`,
    quotation_no: `QT-${String(seq).padStart(4, '0')}`,
    customer_id: 'aisyah',
    customer_name: 'Aisyah Trading',
    quote_date: '2026-10-01',
    valid_until: '2026-10-31',
    total: 100,
    display_status: 'sent',
    accepted_on: null,
    invoice_id: null,
    invoice_no: null,
    ...q,
  };
};

const note = (n: Partial<CreditNoteRow> = {}): CreditNoteRow => {
  seq += 1;
  return {
    id: `note-${seq}`,
    credit_note_no: `CN-${String(seq).padStart(4, '0')}`,
    invoice_id: 'invoice-1',
    invoice_no: 'INV-0001',
    customer_id: 'aisyah',
    customer_name: 'Aisyah Trading',
    credit_date: '2026-10-05',
    reason: 'returns',
    amount: 100,
    refunded: 0,
    status: 'issued',
    notes: null,
    ...n,
  };
};

const refund = (r: Partial<RefundRow> = {}): RefundRow => {
  seq += 1;
  return {
    allocation_id: `alloc-${seq}`,
    transaction_id: `txn-${seq}`,
    number: `PV-${String(seq).padStart(4, '0')}`,
    txn_date: '2026-10-05',
    method: 'fpx',
    amount: 100,
    transaction_amount: 100,
    status: 'posted',
    reference: null,
    reason: 'damaged_goods',
    notes: null,
    account_id: 'bank',
    account_name: 'Main Bank',
    invoice_id: 'invoice-1',
    invoice_no: 'INV-0001',
    credit_note_id: null,
    credit_note_no: null,
    customer_id: 'aisyah',
    customer_name: 'Aisyah Trading',
    ...r,
  };
};

const invoice = (i: Partial<InvoiceListRow> = {}): InvoiceListRow => {
  seq += 1;
  return {
    id: `invoice-${seq}`,
    invoice_no: `INV-${String(seq).padStart(4, '0')}`,
    customer_id: 'aisyah',
    customer_name: 'Aisyah Trading',
    invoice_date: '2026-10-01',
    due_date: '2026-10-31',
    total: 100,
    paid: 100,
    credited: 0,
    refunded: 0,
    balance: 0,
    display_status: 'paid',
    einvoice_status: 'none',
    einvoice_uuid: null,
    ...i,
  };
};

describe('quotationsView', () => {
  it('adds up open quotes, what was accepted this month, the conversion and the pipeline', () => {
    const view = quotationsView(
      [
        quotation({ total: 6200 }),
        quotation({ total: 4800 }),
        quotation({ total: 2400, display_status: 'draft', quotation_no: null }),
        quotation({ total: 12000, display_status: 'accepted', accepted_on: '2026-10-08' }),
        // Accepted last month: accepted, but not this month's figure.
        quotation({ total: 8400, display_status: 'accepted', accepted_on: '2026-09-25', quote_date: '2026-09-20' }),
        quotation({ total: 3600, display_status: 'declined' }),
        quotation({ total: 3200, display_status: 'expired', quote_date: '2026-09-12', valid_until: '2026-09-27' }),
      ],
      today,
    );
    expect(view.stats.map((s) => [s.label, s.value, s.delta])).toEqual([
      ['Open quotes', 'RM 11.0k', '2 open quotes'],
      ['Accepted (MTD)', 'RM 12.0k', '1 quotation'],
      // 2 accepted of 4 decided: accepted, accepted, declined, expired.
      ['Conversion', '50%', '2 of 4 decided'],
      ['Pipeline value', 'RM 13.4k', '3 quotations, drafts included'],
    ]);
  });
  it('shows a dash for the conversion until a quotation has been decided', () => {
    const view = quotationsView([quotation(), quotation({ display_status: 'draft' })], today);
    expect(view.stats[2]).toMatchObject({ value: '—', delta: '0 of 0 decided' });
  });
  it('does not count an expired quotation as open, though it is still only sent', () => {
    const view = quotationsView([quotation({ display_status: 'expired' })], today);
    expect(view.stats[0]).toMatchObject({ value: 'RM 0', delta: '0 open quotes' });
    expect(view.stats[3]).toMatchObject({ value: 'RM 0' });
  });
  it('charts what was quoted by the quotation’s date and what was accepted by the day it was accepted, drafts left out', () => {
    const view = quotationsView(
      [
        quotation({ total: 4000, quote_date: '2026-09-20', display_status: 'accepted', accepted_on: '2026-10-02' }),
        quotation({ total: 2000, quote_date: '2026-10-03' }),
        quotation({ total: 9000, quote_date: '2026-10-04', display_status: 'draft' }),
      ],
      today,
    );
    expect(view.trend.map((t) => t.label)).toEqual(['Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct']);
    expect(view.trend.slice(-2)).toEqual([
      { label: 'Sep', quoted: 4, accepted: 0 },
      { label: 'Oct', quoted: 2, accepted: 4 },
    ]);
    expect(view.hasTrend).toBe(true);
  });
  it('knows there is something to chart from the rows, not from the rounded figures', () => {
    expect(quotationsView([quotation({ total: 0.01 })], today)).toMatchObject({ hasTrend: true });
    expect(quotationsView([quotation({ total: 0.01 })], today).trend.at(-1)).toMatchObject({ quoted: 0 });
    expect(quotationsView([quotation({ display_status: 'draft' })], today)).toMatchObject({ hasTrend: false });
    expect(quotationsView([quotation({ quote_date: '2025-10-01' })], today)).toMatchObject({ hasTrend: false });
    expect(quotationsView([], today)).toMatchObject({ hasTrend: false, funnelCount: 0 });
  });
  it('follows this calendar quarter’s quotations from created to sent to accepted, with no viewed step', () => {
    const view = quotationsView(
      [
        quotation({ quote_date: '2026-10-01', display_status: 'draft' }),
        quotation({ quote_date: '2026-10-02' }),
        quotation({ quote_date: '2026-10-03', display_status: 'declined' }),
        quotation({ quote_date: '2026-10-04', display_status: 'accepted', accepted_on: '2026-10-05' }),
        // Last quarter: not in the funnel, even though it was accepted this quarter.
        quotation({ quote_date: '2026-09-30', display_status: 'accepted', accepted_on: '2026-10-02' }),
      ],
      today,
    );
    expect(view.funnel.map((s) => [s.key, s.label, s.value])).toEqual([
      ['created', 'Created', 4],
      ['sent', 'Sent', 3],
      ['accepted', 'Accepted', 1],
    ]);
    expect(view.funnelCount).toBe(4);
    // January to March is a quarter of its own.
    expect(quotationsView([quotation({ quote_date: '2026-03-31' })], '2026-01-01').funnelCount).toBe(1);
    expect(quotationsView([quotation({ quote_date: '2026-04-01' })], '2026-03-31').funnelCount).toBe(0);
  });
});

describe('filtering and exporting quotations', () => {
  const rows = [
    quotation({ quotation_no: 'QT-0227', customer_id: 'seri', customer_name: 'Seri Mutiara Enterprise' }),
    quotation({ quotation_no: 'QT-0225', display_status: 'accepted', accepted_on: '2026-10-08' }),
    quotation({ quotation_no: null, display_status: 'draft' }),
    quotation({ quotation_no: 'QT-0222', display_status: 'expired' }),
  ];

  it('filters by status, by customer id and by number or customer name', () => {
    expect(filterQuotations(rows, '', 'all')).toHaveLength(4);
    expect(filterQuotations(rows, '', 'expired').map((q) => q.quotation_no)).toEqual(['QT-0222']);
    expect(filterQuotations(rows, '', 'sent').map((q) => q.quotation_no)).toEqual(['QT-0227']);
    expect(filterQuotations(rows, '', 'all', 'seri').map((q) => q.quotation_no)).toEqual(['QT-0227']);
    expect(filterQuotations(rows, ' qt-0225 ', 'all')).toHaveLength(1);
    expect(filterQuotations(rows, 'mutiara', 'all')).toHaveLength(1);
  });
  it('does not match a draft on the word null', () => {
    expect(filterQuotations(rows, 'null', 'all')).toEqual([]);
  });
  it('lists each customer once, by name, and keeps two customers with one name apart', () => {
    expect(customersOf(rows)).toEqual([
      { id: 'aisyah', name: 'Aisyah Trading' },
      { id: 'seri', name: 'Seri Mutiara Enterprise' },
    ]);
    expect(customersOf([quotation({ customer_id: 'b' }), quotation({ customer_id: 'a' })])).toEqual([
      { id: 'a', name: 'Aisyah Trading' },
      { id: 'b', name: 'Aisyah Trading' },
    ]);
  });
  it('names the invoice made from a quotation, or says it is still a draft', () => {
    expect(quotationInvoice(quotation())).toBeNull();
    expect(quotationInvoice(quotation({ invoice_id: 'i1', invoice_no: 'INV-0044' }))).toBe('INV-0044');
    expect(quotationInvoice(quotation({ invoice_id: 'i1', invoice_no: null }))).toBe('Draft invoice');
  });
  it('writes the table as CSV, with a formula-looking customer name made harmless and a draft’s number empty', () => {
    const csv = quotationsCsv([
      quotation({ quotation_no: 'QT-0007', customer_name: '=cmd|calc', total: 1250.5, display_status: 'accepted', invoice_id: 'i1', invoice_no: 'INV-0044' }),
      quotation({ quotation_no: null, customer_name: 'Lim, Tan & Co', total: 80, display_status: 'draft' }),
    ]);
    expect(csv).toBe(
      '﻿No.,Date,Customer,Valid until,Total,Status,Invoice\r\n' +
        "QT-0007,2026-10-01,'=cmd|calc,2026-10-31,1250.5,Accepted,INV-0044\r\n" +
        ',2026-10-01,"Lim, Tan & Co",2026-10-31,80,Draft,\r\n',
    );
  });
  it('has a label for every status', () => {
    expect(QUOTATION_STATUS_LABELS).toEqual({ draft: 'Draft', sent: 'Sent', accepted: 'Accepted', declined: 'Declined', expired: 'Expired' });
  });
});

describe('creditNotesView', () => {
  it('counts only issued credit notes as credited: not drafts, not void ones', () => {
    const view = creditNotesView(
      [
        note({ amount: 240, invoice_id: 'a' }),
        note({ amount: 180, invoice_id: 'a', reason: 'goodwill' }),
        note({ amount: 900, invoice_id: 'b', credit_date: '2026-09-28' }),
        note({ amount: 300, status: 'draft', credit_note_no: null, invoice_id: 'c' }),
        note({ amount: 5000, status: 'void', invoice_id: 'd' }),
      ],
      today,
    );
    expect(view.stats.map((s) => [s.label, s.value, s.delta])).toEqual([
      ['Credited (MTD)', 'RM 420', '2 credit notes'],
      ['Issued', '3', 'in all'],
      ['Drafts', '1', 'not yet issued'],
      ['Invoices affected', '2', 'with an issued credit note'],
    ]);
    expect(view.trend.slice(-2)).toEqual([
      { label: 'Sep', credited: 0.9 },
      { label: 'Oct', credited: 0.4 },
    ]);
    expect(view.creditedYtd).toBe('RM 1,320');
  });
  it('splits this year’s credit by reason, leaving out reasons with nothing and last year’s notes', () => {
    const view = creditNotesView(
      [
        note({ amount: 240 }),
        note({ amount: 100, reason: 'overbilling' }),
        note({ amount: 60, reason: 'overbilling' }),
        note({ amount: 999, reason: 'goodwill', credit_date: '2025-12-31' }),
      ],
      today,
    );
    expect(view.byReason.map((s) => [s.key, s.label, s.value])).toEqual([
      ['returns', 'Returns', 240],
      ['overbilling', 'Overbilling', 160],
    ]);
    expect(view.hasReasons).toBe(true);
  });
  it('has nothing to chart with no issued credit note, and says so from the rows', () => {
    const empty = creditNotesView([note({ status: 'draft' })], today);
    expect(empty).toMatchObject({ hasTrend: false, hasReasons: false, creditedYtd: 'RM 0' });
    // With nothing credited, every reason stays so the legend still shows.
    expect(empty.byReason).toHaveLength(5);
    const oneSen = creditNotesView([note({ amount: 0.01 })], today);
    expect(oneSen).toMatchObject({ hasTrend: true, hasReasons: true });
    expect(oneSen.trend.at(-1)).toMatchObject({ credited: 0 });
  });
});

describe('filtering and exporting credit notes', () => {
  const rows = [
    note({ credit_note_no: 'CN-0036', invoice_no: 'INV-1032', customer_name: 'Seri Mutiara Enterprise', refunded: 900, amount: 900 }),
    note({ credit_note_no: null, status: 'draft', invoice_no: 'INV-1041', refunded: 0 }),
    note({ credit_note_no: 'CN-0010', status: 'void', invoice_no: 'INV-1001' }),
  ];

  it('shows everything but void ones until a status is chosen, and searches number, customer and invoice', () => {
    expect(filterCreditNotes(rows, '', 'open')).toHaveLength(2);
    expect(filterCreditNotes(rows, '', 'void').map((n) => n.credit_note_no)).toEqual(['CN-0010']);
    expect(filterCreditNotes(rows, '', 'draft')).toHaveLength(1);
    expect(filterCreditNotes(rows, 'inv-1032', 'open')).toHaveLength(1);
    expect(filterCreditNotes(rows, 'mutiara', 'open')).toHaveLength(1);
    expect(filterCreditNotes(rows, 'cn-0036', 'issued')).toHaveLength(1);
    expect(filterCreditNotes(rows, 'null', 'open')).toEqual([]);
  });
  it('shows what was refunded against an issued credit note, and nothing for a draft or a void one', () => {
    expect(rows.map(refundedOnNote)).toEqual([900, null, null]);
  });
  it('writes the table as CSV, with the reason as the screen words it', () => {
    expect(creditNotesCsv(rows)).toBe(
      '﻿No.,Date,Customer,Invoice,Reason,Amount,Refunded,Status\r\n' +
        'CN-0036,2026-10-05,Seri Mutiara Enterprise,INV-1032,Returns,900,900,Issued\r\n' +
        ',2026-10-05,Aisyah Trading,INV-1041,Returns,100,,Draft\r\n' +
        'CN-0010,2026-10-05,Aisyah Trading,INV-1001,Returns,100,,Void\r\n',
    );
  });
  it('has a label for every status', () => {
    expect(CREDIT_NOTE_STATUS_LABELS).toEqual({ draft: 'Draft', issued: 'Issued', void: 'Void' });
  });
});

describe('refundsView', () => {
  it('counts only refunds that were paid out as refunded, and pending ones apart', () => {
    const view = refundsView(
      [
        refund({ amount: 240, invoice_id: 'a' }),
        refund({ amount: 180, invoice_id: 'a' }),
        refund({ amount: 900, invoice_id: 'b', txn_date: '2026-09-26' }),
        refund({ amount: 680, status: 'scheduled', number: null, invoice_id: 'c' }),
        refund({ amount: 5000, status: 'void', invoice_id: 'd' }),
      ],
      [],
      today,
    );
    expect(view.stats.map((s) => [s.label, s.value, s.delta, s.deltaTone])).toEqual([
      ['Refunded (MTD)', 'RM 420', '2 refunds', 'flat'],
      ['Pending', 'RM 680', '1 refund', 'down'],
      ['In credit', 'RM 0', '0 invoices', 'flat'],
      ['Invoices refunded', '2', 'in all', 'flat'],
    ]);
    expect(view.trend.slice(-2)).toEqual([
      { label: 'Sep', refunded: 0.9 },
      { label: 'Oct', refunded: 0.4 },
    ]);
    expect(view.refundedYtd).toBe('RM 1,320');
  });
  it('adds up what customers are in credit from the invoices, pending refunds included', () => {
    const view = refundsView(
      [refund({ amount: 680, status: 'scheduled', number: null })],
      [
        invoice({ credited: 600, balance: -600 }),
        invoice({ credited: 680, balance: -680 }),
        // Refunded in full, owed, a draft: none of them is in credit.
        invoice({ credited: 240, refunded: 240, balance: 0 }),
        invoice({ paid: 0, balance: 100, display_status: 'sent' }),
        invoice({ paid: 0, balance: -5, display_status: 'draft' }),
      ],
      today,
    );
    expect(view.stats[2]).toMatchObject({ label: 'In credit', value: 'RM 1,280', delta: '2 invoices' });
    expect(view.stats[1]).toMatchObject({ value: 'RM 680', deltaTone: 'down' });
  });
  it('splits this year’s refunds by reason, and has nothing to chart when none was paid out', () => {
    const view = refundsView(
      [refund({ amount: 240 }), refund({ amount: 450, reason: 'overpayment' }), refund({ amount: 99, reason: 'other', txn_date: '2025-12-31' })],
      [],
      today,
    );
    expect(view.byReason.map((s) => [s.key, s.label, s.value])).toEqual([
      ['damaged_goods', 'Damaged goods', 240],
      ['overpayment', 'Overpayment', 450],
    ]);
    const pendingOnly = refundsView([refund({ status: 'scheduled' })], [], today);
    expect(pendingOnly).toMatchObject({ hasTrend: false, hasReasons: false, refundedYtd: 'RM 0' });
    expect(pendingOnly.byReason).toHaveLength(5);
    expect(refundsView([refund({ amount: 0.01 })], [], today)).toMatchObject({ hasTrend: true, hasReasons: true });
    expect(refundsView([], [], today).stats.map((s) => s.value)).toEqual(['RM 0', 'RM 0', 'RM 0', '0']);
  });
});

describe('filtering and exporting refunds', () => {
  const rows = [
    refund({ number: 'PV-0003', invoice_no: 'INV-1042', credit_note_no: 'CN-0034', credit_note_id: 'n1', reference: 'TT 88' }),
    refund({ number: null, status: 'scheduled', invoice_no: 'INV-1033', customer_name: 'Nurul Boutique', reason: 'wrong_item', method: 'duitnow' }),
    refund({ number: 'PV-0001', status: 'void', invoice_no: 'INV-1001' }),
  ];

  it('shows everything but void ones until a status is chosen', () => {
    expect(filterRefunds(rows, '', 'open')).toHaveLength(2);
    expect(filterRefunds(rows, '', 'pending').map((r) => r.invoice_no)).toEqual(['INV-1033']);
    expect(filterRefunds(rows, '', 'posted').map((r) => r.number)).toEqual(['PV-0003']);
    expect(filterRefunds(rows, '', 'void').map((r) => r.number)).toEqual(['PV-0001']);
  });
  it('searches customer, invoice, credit note, voucher number and reference, and never matches on null', () => {
    expect(filterRefunds(rows, 'nurul', 'open')).toHaveLength(1);
    expect(filterRefunds(rows, 'inv-1042', 'open')).toHaveLength(1);
    expect(filterRefunds(rows, 'cn-0034', 'open')).toHaveLength(1);
    expect(filterRefunds(rows, 'pv-0003', 'open')).toHaveLength(1);
    expect(filterRefunds(rows, 'tt 88', 'open')).toHaveLength(1);
    expect(filterRefunds(rows, 'null', 'open')).toEqual([]);
  });
  it('treats a refund that is not yet money out as pending', () => {
    expect((['scheduled', 'draft', 'pending_approval', 'posted', 'void', 'rejected'] as const).map((status) => isPendingRefund(refund({ status })))).toEqual([
      true, true, true, false, false, false,
    ]);
  });
  it('writes the table as CSV, with the reason, method and status as the screen words them', () => {
    expect(refundsCsv(rows.slice(0, 2))).toBe(
      '﻿Date,No.,Customer,Invoice,Credit note,Reason,Account,Method,Amount,Status\r\n' +
        '2026-10-05,PV-0003,Aisyah Trading,INV-1042,CN-0034,Damaged goods,Main Bank,FPX,100,Refunded\r\n' +
        '2026-10-05,,Nurul Boutique,INV-1033,,Wrong item,Main Bank,DuitNow,100,Pending\r\n',
    );
  });
  it('words scheduled as Pending and posted as Refunded', () => {
    expect(REFUND_STATUS_LABELS).toMatchObject({ scheduled: 'Pending', posted: 'Refunded', void: 'Void' });
  });
});

describe('the sample shown when there is no database', () => {
  it('gives every row an id of its own', () => {
    expect(new Set(SAMPLE_QUOTATIONS.map((q) => q.id)).size).toBe(SAMPLE_QUOTATIONS.length);
    expect(new Set(SAMPLE_CREDIT_NOTES.map((n) => n.id)).size).toBe(SAMPLE_CREDIT_NOTES.length);
    expect(new Set(SAMPLE_REFUNDS.map((r) => r.allocation_id)).size).toBe(SAMPLE_REFUNDS.length);
  });
  it('agrees with the sample invoices: each one is credited and refunded by exactly its credit notes and refunds', () => {
    for (const i of SAMPLE_INVOICES) {
      const credited = SAMPLE_CREDIT_NOTES.filter((n) => n.invoice_id === i.id && n.status === 'issued').reduce((total, n) => total + n.amount, 0);
      const refunded = SAMPLE_REFUNDS.filter((r) => r.invoice_id === i.id && r.status === 'posted').reduce((total, r) => total + r.amount, 0);
      const pending = SAMPLE_REFUNDS.filter((r) => r.invoice_id === i.id && isPendingRefund(r)).reduce((total, r) => total + r.amount, 0);
      expect(i.credited, `${i.invoice_no} credited`).toBe(credited);
      expect(i.refunded, `${i.invoice_no} refunded`).toBe(refunded);
      // What the database would allow: never more credited than invoiced, never more refunded than the customer is in credit.
      expect(credited, `${i.invoice_no} credit cap`).toBeLessThanOrEqual(i.total);
      expect(pending, `${i.invoice_no} refund cap`).toBeLessThanOrEqual(Math.max(0, -i.balance));
    }
  });
  it('names real sample invoices and credit notes, and refunds no credit note beyond its amount', () => {
    for (const n of SAMPLE_CREDIT_NOTES) {
      const against = SAMPLE_INVOICES.find((i) => i.id === n.invoice_id);
      expect(against, n.id).toBeTruthy();
      expect([n.invoice_no, n.customer_name], n.id).toEqual([against!.invoice_no, against!.customer_name]);
      const onNote = SAMPLE_REFUNDS.filter((r) => r.credit_note_id === n.id && r.status === 'posted').reduce((total, r) => total + r.amount, 0);
      expect(n.refunded, n.id).toBe(onNote);
      expect(onNote, n.id).toBeLessThanOrEqual(n.amount);
    }
    for (const r of SAMPLE_REFUNDS) {
      expect(SAMPLE_INVOICES.some((i) => i.id === r.invoice_id), r.allocation_id).toBe(true);
      if (r.credit_note_id) expect(SAMPLE_CREDIT_NOTES.some((n) => n.id === r.credit_note_id && n.status === 'issued'), r.allocation_id).toBe(true);
      expect(r.number === null, r.allocation_id).toBe(r.status !== 'posted');
    }
  });
  it('fills every card and chart on the three screens, and agrees with the Invoices sample', () => {
    const quotations = quotationsView(SAMPLE_QUOTATIONS, SAMPLE_TODAY);
    expect(quotations.stats.map((s) => [s.label, s.value, s.delta])).toEqual([
      ['Open quotes', 'RM 20.5k', '3 open quotes'],
      ['Accepted (MTD)', 'RM 19.5k', '2 quotations'],
      ['Conversion', '55%', '6 of 11 decided'],
      ['Pipeline value', 'RM 22.9k', '4 quotations, drafts included'],
    ]);
    expect(quotations.hasTrend).toBe(true);
    // October's five: one draft, four sent, of which one accepted.
    expect(quotations.funnel.map((s) => s.value)).toEqual([5, 4, 1]);

    const notes = creditNotesView(SAMPLE_CREDIT_NOTES, SAMPLE_TODAY);
    expect(notes.stats.map((s) => s.value)).toEqual(['RM 3,890', '8', '1', '8']);
    expect(notes).toMatchObject({ hasTrend: true, hasReasons: true, creditedYtd: 'RM 3,890' });

    const refunds = refundsView(SAMPLE_REFUNDS, SAMPLE_INVOICES, SAMPLE_TODAY);
    expect(refunds.stats.map((s) => [s.label, s.value, s.delta])).toEqual([
      ['Refunded (MTD)', 'RM 1,770', '4 refunds'],
      ['Pending', 'RM 1,000', '2 refunds'],
      // Siti Decor RM 600, and the two pending refunds' RM 680 and RM 320.
      ['In credit', 'RM 1,600', '3 invoices'],
      ['Invoices refunded', '4', 'in all'],
    ]);
    expect(refunds).toMatchObject({ hasTrend: true, hasReasons: true, refundedYtd: 'RM 1,770' });

    // The credit note on the unpaid invoice is what moved the Invoices sample's receivable.
    expect(invoicesView(SAMPLE_INVOICES, SAMPLE_PAYMENTS_IN, SAMPLE_TODAY).stats[0]).toMatchObject({ value: 'RM 20.5k' });
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm exec vitest run tests/finance-followon-views.test.ts`
Expected: FAIL. The file cannot be loaded: `@/lib/finance/sales-followon-views` does not exist.

- [ ] **Step 3: Write `src/lib/finance/sales-followon-views.ts`**

Create `src/lib/finance/sales-followon-views.ts`:

```ts
/**
 * What the Quotations, Credit Notes and Refunds screens show, worked out from
 * the rows the data layer reads. Pure, with no server imports, so the client
 * views and the tests both use it. `today` is always a YYYY-MM-DD date.
 */
import type { Slice } from '@/components/charts';
import { CREDIT_NOTE_REASONS, CREDIT_NOTE_REASON_LABELS, type CreditNoteReason, type CreditNoteRow, type CreditNoteStatus } from './credit-notes';
import { toCsv } from './csv';
import { rmShort } from './format';
import type { InvoiceListRow } from './invoices';
import { PAYMENT_METHOD_LABELS } from './money';
import type { QuotationDisplayStatus, QuotationListRow } from './quotations';
import { REFUND_REASONS, REFUND_REASON_LABELS, type RefundReason, type RefundRow } from './refunds';
import { inCredit } from './sales-views';
import { type Stat, count, lastMonths, monthOf, paymentCount, sum, thousands } from './view-helpers';

/** The customers the rows name, by name, for a customer filter. Two customers with one name stay two choices. */
export function customersOf(rows: { customer_id: string; customer_name: string }[]): { id: string; name: string }[] {
  const byId = new Map<string, string>();
  for (const row of rows) byId.set(row.customer_id, row.customer_name);
  return [...byId.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((x, y) => x.name.localeCompare(y.name) || x.id.localeCompare(y.id));
}

/** The calendar year a date falls in. */
const yearOf = (iso: string) => iso.slice(0, 4);

/** One slice per reason that has an amount; with nothing at all, every reason stays so the legend still shows. */
function reasonSlices<R extends string>(
  reasons: readonly R[],
  labels: Record<R, string>,
  colors: Record<R, string>,
  amountOf: (reason: R) => number,
): Slice[] {
  const all = reasons.map((reason) => ({ key: reason, label: labels[reason], value: amountOf(reason), color: colors[reason] }));
  const used = all.filter((slice) => slice.value > 0);
  return used.length ? used : all;
}

/* ---- Quotations ---------------------------------------------------- */

export type QuotationsViewData = {
  stats: Stat[];
  /** The last eight months, oldest first, in RM thousands: what was quoted (and sent) and what was accepted. */
  trend: { label: string; quoted: number; accepted: number }[];
  /** Whether anything was quoted or accepted in those eight months, however little: a small amount rounds to 0 in `trend`. */
  hasTrend: boolean;
  /** This calendar quarter's quotations by how far they got: created, sent, accepted. */
  funnel: Slice[];
  /** How many quotations are dated this quarter. */
  funnelCount: number;
};

export const QUOTATION_STATUS_LABELS: Record<QuotationDisplayStatus, string> = {
  draft: 'Draft',
  sent: 'Sent',
  accepted: 'Accepted',
  declined: 'Declined',
  expired: 'Expired',
};

/** 2026-10-09 → 2026-Q4 */
function quarterOf(iso: string): string {
  return `${yearOf(iso)}-Q${Math.ceil(Number(iso.slice(5, 7)) / 3)}`;
}

/** Sent at some point: everything but a draft. */
const wasSent = (q: QuotationListRow) => q.display_status !== 'draft';

export function quotationsView(rows: QuotationListRow[], today: string): QuotationsViewData {
  const open = rows.filter((q) => q.display_status === 'sent');
  const drafts = rows.filter((q) => q.display_status === 'draft');
  const accepted = rows.filter((q) => q.display_status === 'accepted');
  const acceptedMtd = accepted.filter((q) => q.accepted_on !== null && monthOf(q.accepted_on) === monthOf(today));
  // An answer, or the time for one ran out. Open quotations and drafts are still undecided.
  const decided = rows.filter((q) => ['accepted', 'declined', 'expired'].includes(q.display_status));
  const pipeline = [...drafts, ...open];

  let hasTrend = false;
  const trend = lastMonths(today).map(({ key, label }) => {
    const quotedInMonth = rows.filter((q) => wasSent(q) && monthOf(q.quote_date) === key);
    const acceptedInMonth = accepted.filter((q) => q.accepted_on !== null && monthOf(q.accepted_on) === key);
    if (quotedInMonth.length > 0 || acceptedInMonth.length > 0) hasTrend = true;
    return {
      label,
      quoted: thousands(sum(quotedInMonth, (q) => q.total)),
      accepted: thousands(sum(acceptedInMonth, (q) => q.total)),
    };
  });

  const thisQuarter = rows.filter((q) => quarterOf(q.quote_date) === quarterOf(today));

  return {
    stats: [
      { label: 'Open quotes', value: rmShort(sum(open, (q) => q.total)), delta: count(open.length, 'open quote'), deltaTone: 'flat' },
      { label: 'Accepted (MTD)', value: rmShort(sum(acceptedMtd, (q) => q.total)), delta: count(acceptedMtd.length, 'quotation'), deltaTone: 'flat' },
      {
        label: 'Conversion',
        value: decided.length ? `${Math.round((accepted.length / decided.length) * 100)}%` : '—',
        delta: `${accepted.length} of ${decided.length} decided`,
        deltaTone: 'flat',
      },
      { label: 'Pipeline value', value: rmShort(sum(pipeline, (q) => q.total)), delta: `${count(pipeline.length, 'quotation')}, drafts included`, deltaTone: 'flat' },
    ],
    trend,
    hasTrend,
    // No "Viewed" step: nothing tracks a customer opening a quotation.
    funnel: [
      { key: 'created', label: 'Created', value: thisQuarter.length, color: 'var(--chart-5)' },
      { key: 'sent', label: 'Sent', value: thisQuarter.filter(wasSent).length, color: 'var(--chart-1)' },
      { key: 'accepted', label: 'Accepted', value: thisQuarter.filter((q) => q.display_status === 'accepted').length, color: 'var(--chart-2)' },
    ],
    funnelCount: thisQuarter.length,
  };
}

export type QuotationFilter = 'all' | QuotationDisplayStatus;

/** Quotations matching the status and customer filters whose number or customer contains the search text. */
export function filterQuotations(
  rows: QuotationListRow[],
  query: string,
  filter: QuotationFilter,
  customerId: string = 'all',
): QuotationListRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter(
    (row) =>
      (filter === 'all' || row.display_status === filter) &&
      (customerId === 'all' || row.customer_id === customerId) &&
      `${row.quotation_no ?? ''} ${row.customer_name}`.toLowerCase().includes(q),
  );
}

/** The invoice made from a quotation: its number, "Draft invoice" while it has none, or nothing (null). */
export function quotationInvoice(row: QuotationListRow): string | null {
  if (row.invoice_id === null) return null;
  return row.invoice_no ?? 'Draft invoice';
}

/** The quotations table as a CSV file. The total is a number, so a spreadsheet can add it up. */
export function quotationsCsv(rows: QuotationListRow[]): string {
  return toCsv(
    ['No.', 'Date', 'Customer', 'Valid until', 'Total', 'Status', 'Invoice'],
    rows.map((q) => [
      q.quotation_no,
      q.quote_date,
      q.customer_name,
      q.valid_until,
      q.total,
      QUOTATION_STATUS_LABELS[q.display_status],
      quotationInvoice(q),
    ]),
  );
}

/* ---- Credit Notes -------------------------------------------------- */

export type CreditNotesViewData = {
  stats: Stat[];
  /** The last eight months, oldest first, in RM thousands: issued credit notes by their date. */
  trend: { label: string; credited: number }[];
  /** Whether anything was credited in those eight months, however little. */
  hasTrend: boolean;
  /** Issued credit notes dated this calendar year, in RM, per reason. */
  byReason: Slice[];
  /** Whether any credit note was issued this year. */
  hasReasons: boolean;
  creditedYtd: string;
};

export const CREDIT_NOTE_STATUS_LABELS: Record<CreditNoteStatus, string> = {
  draft: 'Draft',
  issued: 'Issued',
  void: 'Void',
};

const CREDIT_REASON_COLORS: Record<CreditNoteReason, string> = {
  returns: 'var(--chart-1)',
  pricing_adjustment: 'var(--chart-4)',
  overbilling: 'var(--chart-3)',
  goodwill: 'var(--chart-5)',
  other: 'var(--chart-2)',
};

export function creditNotesView(rows: CreditNoteRow[], today: string): CreditNotesViewData {
  // Only an issued credit note has credited anything: not a draft, not a void one.
  const issued = rows.filter((n) => n.status === 'issued');
  const drafts = rows.filter((n) => n.status === 'draft');
  const mtd = issued.filter((n) => monthOf(n.credit_date) === monthOf(today));
  const ytd = issued.filter((n) => yearOf(n.credit_date) === yearOf(today));

  let hasTrend = false;
  const trend = lastMonths(today).map(({ key, label }) => {
    const inMonth = issued.filter((n) => monthOf(n.credit_date) === key);
    if (inMonth.length > 0) hasTrend = true;
    return { label, credited: thousands(sum(inMonth, (n) => n.amount)) };
  });

  return {
    stats: [
      { label: 'Credited (MTD)', value: rmShort(sum(mtd, (n) => n.amount)), delta: count(mtd.length, 'credit note'), deltaTone: 'flat' },
      { label: 'Issued', value: String(issued.length), delta: 'in all', deltaTone: 'flat' },
      { label: 'Drafts', value: String(drafts.length), delta: 'not yet issued', deltaTone: 'flat' },
      { label: 'Invoices affected', value: String(new Set(issued.map((n) => n.invoice_id)).size), delta: 'with an issued credit note', deltaTone: 'flat' },
    ],
    trend,
    hasTrend,
    byReason: reasonSlices(CREDIT_NOTE_REASONS, CREDIT_NOTE_REASON_LABELS, CREDIT_REASON_COLORS, (reason) =>
      sum(ytd.filter((n) => n.reason === reason), (n) => n.amount),
    ),
    hasReasons: ytd.length > 0,
    creditedYtd: rmShort(sum(ytd, (n) => n.amount)),
  };
}

/** `open` is every credit note that is not void: what the table shows until a status is chosen. */
export type CreditNoteFilter = 'open' | CreditNoteStatus;

/** Credit notes matching the status filter whose number, customer or invoice number contains the search text. */
export function filterCreditNotes(rows: CreditNoteRow[], query: string, filter: CreditNoteFilter): CreditNoteRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter(
    (n) =>
      (filter === 'open' ? n.status !== 'void' : n.status === filter) &&
      `${n.credit_note_no ?? ''} ${n.customer_name} ${n.invoice_no ?? ''}`.toLowerCase().includes(q),
  );
}

/** What has been refunded against an issued credit note; nothing to show (null) for a draft or a void one. */
export function refundedOnNote(note: CreditNoteRow): number | null {
  return note.status === 'issued' ? note.refunded : null;
}

/** The credit notes table as a CSV file. Amounts are numbers. */
export function creditNotesCsv(rows: CreditNoteRow[]): string {
  return toCsv(
    ['No.', 'Date', 'Customer', 'Invoice', 'Reason', 'Amount', 'Refunded', 'Status'],
    rows.map((n) => [
      n.credit_note_no,
      n.credit_date,
      n.customer_name,
      n.invoice_no,
      CREDIT_NOTE_REASON_LABELS[n.reason],
      n.amount,
      refundedOnNote(n),
      CREDIT_NOTE_STATUS_LABELS[n.status],
    ]),
  );
}

/* ---- Refunds ------------------------------------------------------- */

export type RefundsViewData = {
  stats: Stat[];
  /** The last eight months, oldest first, in RM thousands: refunds that were paid out, by their date. */
  trend: { label: string; refunded: number }[];
  /** Whether anything was refunded in those eight months, however little. */
  hasTrend: boolean;
  /** Refunds paid out this calendar year, in RM, per reason. */
  byReason: Slice[];
  /** Whether any refund was paid out this year. */
  hasReasons: boolean;
  refundedYtd: string;
};

/** A refund is a payment out: scheduled reads "Pending" here and posted reads "Refunded". */
export const REFUND_STATUS_LABELS: Record<RefundRow['status'], string> = {
  draft: 'Draft',
  pending_approval: 'Pending approval',
  scheduled: 'Pending',
  posted: 'Refunded',
  rejected: 'Rejected',
  void: 'Void',
};

const REFUND_REASON_COLORS: Record<RefundReason, string> = {
  order_cancelled: 'var(--chart-1)',
  damaged_goods: 'var(--chart-4)',
  wrong_item: 'var(--chart-3)',
  overpayment: 'var(--chart-5)',
  other: 'var(--chart-2)',
};

/** Recorded but not yet money out: it holds the customer's credit. */
export function isPendingRefund(row: RefundRow): boolean {
  return row.status === 'scheduled' || row.status === 'draft' || row.status === 'pending_approval';
}

/**
 * `invoices` is every invoice of the workspace: the "In credit" card adds up
 * what customers are in credit across them, pending refunds included, since a
 * pending refund has not left the bank yet.
 */
export function refundsView(rows: RefundRow[], invoices: InvoiceListRow[], today: string): RefundsViewData {
  // Only money that has actually gone out counts as refunded: not pending, not voided.
  const paid = rows.filter((r) => r.status === 'posted');
  const pending = rows.filter(isPendingRefund);
  const mtd = paid.filter((r) => monthOf(r.txn_date) === monthOf(today));
  const ytd = paid.filter((r) => yearOf(r.txn_date) === yearOf(today));
  const credits = invoices.map(inCredit).filter((amount) => amount > 0);

  let hasTrend = false;
  const trend = lastMonths(today).map(({ key, label }) => {
    const inMonth = paid.filter((r) => monthOf(r.txn_date) === key);
    if (inMonth.length > 0) hasTrend = true;
    return { label, refunded: thousands(sum(inMonth, (r) => r.amount)) };
  });

  return {
    stats: [
      { label: 'Refunded (MTD)', value: rmShort(sum(mtd, (r) => r.amount)), delta: count(paymentCount(mtd), 'refund'), deltaTone: 'flat' },
      {
        label: 'Pending',
        value: rmShort(sum(pending, (r) => r.amount)),
        delta: count(paymentCount(pending), 'refund'),
        deltaTone: pending.length ? 'down' : 'flat',
      },
      { label: 'In credit', value: rmShort(sum(credits, (amount) => amount)), delta: count(credits.length, 'invoice'), deltaTone: 'flat' },
      { label: 'Invoices refunded', value: String(new Set(paid.map((r) => r.invoice_id)).size), delta: 'in all', deltaTone: 'flat' },
    ],
    trend,
    hasTrend,
    byReason: reasonSlices(REFUND_REASONS, REFUND_REASON_LABELS, REFUND_REASON_COLORS, (reason) =>
      sum(ytd.filter((r) => r.reason === reason), (r) => r.amount),
    ),
    hasReasons: ytd.length > 0,
    refundedYtd: rmShort(sum(ytd, (r) => r.amount)),
  };
}

/** `open` is every refund that is not void: what the table shows until a status is chosen. */
export type RefundFilter = 'open' | 'pending' | 'posted' | 'void';

/** Refunds matching the status filter whose customer, invoice, credit note, voucher number or reference contains the search text. */
export function filterRefunds(rows: RefundRow[], query: string, filter: RefundFilter): RefundRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter(
    (r) =>
      (filter === 'open' ? r.status !== 'void' : filter === 'pending' ? isPendingRefund(r) : r.status === filter) &&
      `${r.customer_name} ${r.invoice_no ?? ''} ${r.credit_note_no ?? ''} ${r.number ?? ''} ${r.reference ?? ''}`
        .toLowerCase()
        .includes(q),
  );
}

/** The refunds table as a CSV file. Amounts are numbers. */
export function refundsCsv(rows: RefundRow[]): string {
  return toCsv(
    ['Date', 'No.', 'Customer', 'Invoice', 'Credit note', 'Reason', 'Account', 'Method', 'Amount', 'Status'],
    rows.map((r) => [
      r.txn_date,
      r.number,
      r.customer_name,
      r.invoice_no,
      r.credit_note_no,
      REFUND_REASON_LABELS[r.reason],
      r.account_name,
      PAYMENT_METHOD_LABELS[r.method],
      r.amount,
      REFUND_STATUS_LABELS[r.status],
    ]),
  );
}
```

- [ ] **Step 4: Add the sample quotations, credit notes and refunds**

They join the sample invoices in one file, so a test can hold them to each other.

In `src/screens/finance/sales-sample.ts`, replace:

```ts
/**
 * Sample invoices and payments in (Rimba Ventures Sdn Bhd), shown on Invoices
 * and Payments In when there is no database. Raw rows in the shape the data
 * layer reads, so both screens run them through the same builders as live
 * data and their figures agree with each other. What is credited and refunded
 * on an invoice here is what the sample credit notes and refunds come to;
 * those rows join this file with the screens that show them.
 */
import type { EInvoiceStatus, InvoiceDisplayStatus, InvoiceListRow } from '@/lib/finance/invoices';
import type { PaymentInRow, PaymentMethod } from '@/lib/finance/money';
```

with:

```ts
/**
 * Sample sales data (Rimba Ventures Sdn Bhd), shown on Invoices, Payments In,
 * Quotations, Credit Notes and Refunds when there is no database. Raw rows in
 * the shape the data layer reads, so every screen runs them through the same
 * builders as live data and their figures agree with each other: a credit
 * note here is taken off its invoice here, and a refund here is added back.
 */
import type { CreditNoteReason, CreditNoteRow, CreditNoteStatus } from '@/lib/finance/credit-notes';
import type { EInvoiceStatus, InvoiceDisplayStatus, InvoiceListRow } from '@/lib/finance/invoices';
import type { PaymentInRow, PaymentMethod } from '@/lib/finance/money';
import type { QuotationDisplayStatus, QuotationListRow } from '@/lib/finance/quotations';
import type { RefundReason, RefundRow } from '@/lib/finance/refunds';
```

In `src/screens/finance/sales-sample.ts`, replace:

```ts
  ...SAMPLE_HISTORY.map(([month], i) => receipt(96 - i, `${month}-24`, 1006 - i, 'bank_transfer')).reverse(),
];
```

with:

```ts
  ...SAMPLE_HISTORY.map(([month], i) => receipt(96 - i, `${month}-24`, 1006 - i, 'bank_transfer')).reverse(),
];

/* ---- quotations ------------------------------------------------------ */

const quotation = (
  n: number,
  quote_date: string,
  customer_name: string,
  valid_until: string,
  total: number,
  display_status: QuotationDisplayStatus,
  accepted_on: string | null = null,
): QuotationListRow => ({
  id: `sample-quotation-${n}`,
  quotation_no: display_status === 'draft' ? null : numbered('QT', n),
  customer_id: customer_name,
  customer_name,
  quote_date,
  valid_until,
  total,
  display_status,
  accepted_on,
  invoice_id: null,
  invoice_no: null,
});

/** Newest first, as the real list is. */
export const SAMPLE_QUOTATIONS: QuotationListRow[] = [
  quotation(228, '2026-10-09', 'Nurul Boutique', '2026-11-08', 2400, 'draft'),
  quotation(227, '2026-10-08', 'Seri Mutiara Enterprise', '2026-11-07', 6200, 'sent'),
  quotation(226, '2026-10-07', 'Langkawi Fresh', '2026-11-06', 4800, 'sent'),
  quotation(225, '2026-10-06', 'Aisyah Trading', '2026-11-05', 12000, 'accepted', '2026-10-08'),
  quotation(224, '2026-10-04', 'Zaki Enterprise', '2026-11-03', 9500, 'sent'),
  quotation(223, '2026-09-29', 'Lim Hardware Sdn Bhd', '2026-10-29', 7500, 'accepted', '2026-10-02'),
  quotation(220, '2026-09-20', 'Aisyah Trading', '2026-10-20', 8400, 'accepted', '2026-09-25'),
  quotation(219, '2026-09-16', 'Langkawi Fresh', '2026-10-16', 3600, 'declined'),
  quotation(222, '2026-09-12', 'Siti Decor', '2026-09-27', 3200, 'expired'),
  quotation(221, '2026-09-02', 'Nusantara Logistics', '2026-09-17', 5800, 'expired'),
  // Earlier months, so the trend has a shape.
  quotation(212, '2026-08-12', 'Aisyah Trading', '2026-09-11', 18000, 'accepted', '2026-08-20'),
  quotation(208, '2026-07-12', 'Zaki Enterprise', '2026-08-11', 9000, 'declined'),
  quotation(205, '2026-06-12', 'Siti Decor', '2026-07-12', 14000, 'accepted', '2026-06-21'),
  quotation(203, '2026-05-12', 'Lim Hardware Sdn Bhd', '2026-06-11', 11000, 'accepted', '2026-05-20'),
  quotation(201, '2026-04-12', 'Nusantara Logistics', '2026-05-12', 7500, 'expired'),
];

/* ---- credit notes ---------------------------------------------------- */

/** `refunded` is what was paid out against the note itself; a refund put against the invoice is not counted on the note. */
const creditNote = (
  n: number,
  credit_date: string,
  invoiceNo: number,
  reason: CreditNoteReason,
  amount: number,
  status: CreditNoteStatus,
  refunded: number = 0,
): CreditNoteRow => {
  const against = invoiceNumbered(invoiceNo);
  return {
    id: `sample-credit-note-${n}`,
    credit_note_no: status === 'draft' ? null : numbered('CN', n),
    invoice_id: against.id,
    invoice_no: against.invoice_no,
    customer_id: against.customer_id,
    customer_name: against.customer_name,
    credit_date,
    reason,
    amount,
    refunded,
    status,
    notes: null,
  };
};

/** Newest first, as the real list is. */
export const SAMPLE_CREDIT_NOTES: CreditNoteRow[] = [
  creditNote(38, '2026-10-09', 1041, 'pricing_adjustment', 300, 'draft'),
  creditNote(34, '2026-10-09', 1042, 'returns', 240, 'issued', 240),
  creditNote(37, '2026-10-08', 1037, 'goodwill', 520, 'issued'),
  creditNote(35, '2026-10-08', 1036, 'returns', 180, 'issued', 180),
  creditNote(36, '2026-10-07', 1032, 'returns', 900, 'issued', 900),
  creditNote(31, '2026-10-07', 1033, 'returns', 680, 'issued'),
  // Refunded against its invoice, INV-1039, not against the note.
  creditNote(33, '2026-10-06', 1039, 'overbilling', 450, 'issued'),
  creditNote(32, '2026-10-06', 1038, 'pricing_adjustment', 600, 'issued'),
  creditNote(30, '2026-10-04', 1030, 'overbilling', 320, 'issued'),
];

/* ---- refunds --------------------------------------------------------- */

/** `voucher` is null for a refund that is still pending. `noteNo` is null for a refund put against the invoice itself. */
const refund = (
  n: number,
  voucher: number | null,
  txn_date: string,
  invoiceNo: number,
  noteNo: number | null,
  method: PaymentMethod,
  reason: RefundReason,
  amount: number,
): RefundRow => {
  const against = invoiceNumbered(invoiceNo);
  return {
    allocation_id: `sample-refund-${n}`,
    transaction_id: `sample-refund-${n}`,
    number: voucher === null ? null : numbered('PV', voucher),
    txn_date,
    method,
    amount,
    transaction_amount: amount,
    status: voucher === null ? 'scheduled' : 'posted',
    reference: null,
    reason,
    notes: null,
    account_id: 'bank',
    account_name: 'Main Bank',
    invoice_id: against.id,
    invoice_no: against.invoice_no,
    credit_note_id: noteNo === null ? null : `sample-credit-note-${noteNo}`,
    credit_note_no: noteNo === null ? null : numbered('CN', noteNo),
    customer_id: against.customer_id,
    customer_name: against.customer_name,
  };
};

/** Newest first, as the real list is. */
export const SAMPLE_REFUNDS: RefundRow[] = [
  refund(6, null, '2026-10-10', 1033, 31, 'duitnow', 'wrong_item', 680),
  refund(5, 4, '2026-10-10', 1042, 34, 'fpx', 'damaged_goods', 240),
  refund(4, null, '2026-10-09', 1030, 30, 'bank_transfer', 'overpayment', 320),
  refund(3, 3, '2026-10-09', 1036, 35, 'fpx', 'damaged_goods', 180),
  refund(2, 2, '2026-10-08', 1032, 36, 'bank_transfer', 'order_cancelled', 900),
  refund(1, 1, '2026-10-07', 1039, null, 'bank_transfer', 'overpayment', 450),
];
```

- [ ] **Step 5: Run the tests**

Run: `pnpm exec vitest run tests/finance-followon-views.test.ts tests/finance-sales-views.test.ts`
Expected: PASS, both files. The second proves the sample invoices of Task 5 still fill the Invoices screen.

- [ ] **Step 6: Type-check, lint and commit**

Run: `pnpm exec tsc --noEmit` then `pnpm lint`
Expected: no errors and no warnings.

Run: `grep -n -E "supabase/server|next/headers|server-only" src/lib/finance/sales-followon-views.ts src/screens/finance/sales-sample.ts`
Expected: no output.

```bash
git add src/lib/finance/sales-followon-views.ts src/screens/finance/sales-sample.ts tests/finance-followon-views.test.ts
git commit -m "feat: figures, filters and CSV for quotations, credit notes and refunds"
```

---

### Task 7: Quotations, Credit Notes and Refunds go live, read-only

**Files:**
- Create: `src/components/finance/quotations-view.tsx`
- Create: `src/components/finance/credit-notes-view.tsx`
- Create: `src/components/finance/refunds-view.tsx`
- Replace: `src/screens/finance/quotations.tsx`
- Replace: `src/screens/finance/credit-notes.tsx`
- Replace: `src/screens/finance/refunds.tsx`
- Modify: `src/config/live-screens.ts`
- Modify: `src/app/(app)/finance/actions.ts` (two constants)
- Modify: `tests/live-screens.test.ts`, `tests/finance-contact-paths.test.ts`, `tests/finance-sales-actions.test.ts`

**Interfaces:**
- Consumes: `listQuotations` (Task 2), `listCreditNotes` (Task 3), `listRefunds` (Task 4), `listInvoices` from `@/lib/finance/invoices`; everything Task 6 produces; `customerChoice` from `@/lib/finance/sales-views`; `LATEST_ROWS`, `displayDate`, `todayUtc` from `@/lib/finance/view-helpers`; `getViewer`, `hasSupabaseEnv` from `@/lib/auth/viewer`; `createClient` from `@/lib/supabase/server`; `downloadCsv` from `@/components/finance/download-csv`; `csvFileName` from `@/lib/finance/csv`; `localIsoDate` from `@/lib/finance/bill-math`; `rm` from `@/lib/finance/format`; the existing `BentoCard`, `BentoGrid`, `BentoStat`, `AreaTrend`, `DonutStat`, `FunnelFlow`, `PageHeader`, `ScreenContainer`, `NoMatchesRow`, `Button`, `Input`, `LiveDot`, `Select…`, `Table…` components.
- Produces:
  - `QuotationsView({ rows, view }: { rows: QuotationListRow[]; view: QuotationsViewData })`
  - `CreditNotesView({ rows, view }: { rows: CreditNoteRow[]; view: CreditNotesViewData })`
  - `RefundsView({ rows, view }: { rows: RefundRow[]; view: RefundsViewData })`
  - default exports `QuotationsScreen`, `CreditNotesScreen`, `RefundsScreen` (async server components; the generated route files `src/app/(app)/finance/quotations/page.tsx`, `…/credit-notes/page.tsx` and `…/refunds/page.tsx` already import them by default and need no change).
- **No view takes a `writer` prop or an action.** Stage 4b adds them in the way `InvoicesView` has them; the loaders will then pass a `writer` only to people who may edit.

The three screens were `'use client'` mock-ups with their own state. They become server components that read; the state moves into the client views. `ScreenContainer` gets `className="pb-24 sm:pb-24"` on all three, as on every live finance screen: without it the floating assistant button covers the table's last row.

Two revalidate lists grow. A contact change can rename a customer, which all three screens show. A change to an invoice or a payment in shows on all three as well: Quotations names the invoice made from a quotation, Credit Notes names each note's invoice, and Refunds adds up credit from the invoices. Stage 4b will give the three screens' own actions their paths.

- [ ] **Step 1: Write the failing tests**

In `tests/live-screens.test.ts`, replace:

```ts
    for (const slug of ['quotations', 'credit-notes', 'refunds', 'cash-receipts']) {
      expect(isSampleScreen(`/finance/${slug}`), slug).toBe(true);
    }
  });
```

with:

```ts
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

In `tests/finance-contact-paths.test.ts`, replace:

```ts
  it('refreshes every screen that shows a contact’s name, Invoices and Payments In included', async () => {
```

with:

```ts
  it('refreshes every screen that shows a contact’s name, the five sales screens included', async () => {
```

In `tests/finance-contact-paths.test.ts`, replace:

```ts
        '/finance/invoices',
        '/finance/payments-in',
      ]);
```

with:

```ts
        '/finance/invoices',
        '/finance/payments-in',
        '/finance/quotations',
        '/finance/credit-notes',
        '/finance/refunds',
      ]);
```

In `tests/finance-sales-actions.test.ts`, replace:

```ts
const PATHS = ['/finance/invoices', '/finance/payments-in', '/finance/customers-suppliers'];
```

with:

```ts
// A change to an invoice or a payment in shows on the three follow-on screens too.
const PATHS = [
  '/finance/invoices',
  '/finance/payments-in',
  '/finance/customers-suppliers',
  '/finance/quotations',
  '/finance/credit-notes',
  '/finance/refunds',
];
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm exec vitest run tests/live-screens.test.ts tests/finance-contact-paths.test.ts tests/finance-sales-actions.test.ts`
Expected: FAIL in all three. `/finance/quotations` is still a sample screen; a contact change refreshes five paths, not eight; an invoice action refreshes three, not six.

- [ ] **Step 3: Write the Quotations view**

The customer filter falls back to "All customers" when a refresh removes the chosen customer, in the way `InvoicesView` does it: state adjusted during render, with the rule in the tested function `customerChoice`.

Create `src/components/finance/quotations-view.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { ChartColumn, Download, FileText, Search, TrendingUp } from 'lucide-react';
import { BentoCard, BentoGrid, BentoStat } from '@/components/bento/bento';
import { AreaTrend, FunnelFlow, type Series } from '@/components/charts';
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
import { csvFileName } from '@/lib/finance/csv';
import { rm } from '@/lib/finance/format';
import type { QuotationDisplayStatus, QuotationListRow } from '@/lib/finance/quotations';
import {
  QUOTATION_STATUS_LABELS,
  type QuotationFilter,
  type QuotationsViewData,
  customersOf,
  filterQuotations,
  quotationInvoice,
  quotationsCsv,
} from '@/lib/finance/sales-followon-views';
import { customerChoice } from '@/lib/finance/sales-views';
import { LATEST_ROWS, displayDate } from '@/lib/finance/view-helpers';
import { cn } from '@/lib/utils';

const TREND_SERIES: Series[] = [
  { key: 'quoted', label: 'Quoted (RM k)', color: 'var(--chart-1)' },
  { key: 'accepted', label: 'Accepted (RM k)', color: 'var(--chart-2)' },
];

const STATUS_STYLES: Record<QuotationDisplayStatus, string> = {
  accepted: 'bg-emerald-500/15 text-emerald-600',
  sent: 'bg-amber-500/15 text-amber-600',
  expired: 'bg-red-500/15 text-red-600',
  declined: 'bg-muted text-muted-foreground line-through',
  draft: 'bg-muted text-muted-foreground',
};

const COLUMNS = 7;

/**
 * Quotations, read-only: figures, charts and the table, with search, filters,
 * "View all" and Export. Nothing here writes; the form and the row actions
 * (send, mark accepted or declined, convert to invoice) come with the next stage.
 */
export function QuotationsView({
  rows,
  view,
}: {
  /** Every quotation, newest first; drafts included. */
  rows: QuotationListRow[];
  view: QuotationsViewData;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<QuotationFilter>('all');
  const [chosenCustomer, setCustomer] = useState('all');
  const [showAll, setShowAll] = useState(false);

  const customers = customersOf(rows);
  // A refresh can take the chosen customer's last quotation away: the filter then goes back to everyone, and stays there.
  const customer = customerChoice(chosenCustomer, customers);
  if (customer !== chosenCustomer) setCustomer(customer);
  const matching = filterQuotations(rows, query, filter, customer);
  const shown = showAll ? matching : matching.slice(0, LATEST_ROWS);

  return (
    <ScreenContainer className="pb-24 sm:pb-24">
      <PageHeader title="Quotations" subtitle="Quotes you have given your customers, and their answers, Saudara." />

      <BentoGrid>
        {view.stats.map((s, i) => (
          <BentoCard key={s.label} tone={i === 0 ? 'primary' : 'default'} className="col-span-1 md:col-span-3">
            <BentoStat label={s.label} value={s.value} delta={s.delta} deltaTone={s.deltaTone} onPrimary={i === 0} />
          </BentoCard>
        ))}

        <BentoCard
          title="Quoted value over time"
          subtitle="Quoted vs accepted · last 8 months"
          icon={TrendingUp}
          className="col-span-2 md:col-span-8"
        >
          {view.hasTrend ? (
            <AreaTrend data={view.trend} series={TREND_SERIES} height={240} showLegend />
          ) : (
            <p className="grid h-60 place-items-center text-sm text-muted-foreground">
              Nothing quoted or accepted in the last 8 months.
            </p>
          )}
        </BentoCard>
        <BentoCard title="Acceptance funnel" subtitle="This quarter" icon={ChartColumn} className="col-span-2 md:col-span-4">
          {view.funnelCount === 0 ? (
            <p className="grid h-60 place-items-center text-sm text-muted-foreground">No quotations this quarter.</p>
          ) : (
            <FunnelFlow data={view.funnel} height={240} />
          )}
        </BentoCard>

        <BentoCard
          title="Quotations"
          subtitle="What you have quoted your customers"
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
            <div className="relative w-full sm:w-64">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                aria-label="Search quotations by number or customer"
                placeholder="Search quotations or customers…"
                className="pl-8"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <Select value={filter} onValueChange={(v) => setFilter(v as QuotationFilter)}>
              <SelectTrigger className="w-40" aria-label="Status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="draft">Draft</SelectItem>
                <SelectItem value="sent">Sent</SelectItem>
                <SelectItem value="accepted">Accepted</SelectItem>
                <SelectItem value="declined">Declined</SelectItem>
                <SelectItem value="expired">Expired</SelectItem>
              </SelectContent>
            </Select>
            <Select value={customer} onValueChange={setCustomer}>
              <SelectTrigger className="w-48" aria-label="Customer">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All customers</SelectItem>
                {customers.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              disabled={matching.length === 0}
              onClick={() => downloadCsv(csvFileName('quotations', localIsoDate(new Date())), quotationsCsv(matching))}
            >
              <Download className="size-4" />
              Export
            </Button>
          </div>
          <div className="mt-3 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40">
                  <TableHead>No.</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead>Valid until</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Invoice</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.length === 0 &&
                  (rows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={COLUMNS} className="py-8 text-center text-muted-foreground">
                        No quotations yet.
                      </TableCell>
                    </TableRow>
                  ) : (
                    <NoMatchesRow colSpan={COLUMNS} />
                  ))}
                {shown.map((q) => (
                  <TableRow key={q.id} className={cn(q.display_status === 'declined' && 'opacity-60')}>
                    <TableCell className="whitespace-nowrap font-medium">{q.quotation_no ?? '—'}</TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{displayDate(q.quote_date)}</TableCell>
                    <TableCell className="whitespace-nowrap">{q.customer_name}</TableCell>
                    <TableCell className="whitespace-nowrap text-right tabular-nums">{rm(q.total)}</TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{displayDate(q.valid_until)}</TableCell>
                    <TableCell>
                      <span className="flex items-center gap-2">
                        <LiveDot active={q.display_status === 'accepted'} />
                        <span
                          className={cn(
                            'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold',
                            STATUS_STYLES[q.display_status],
                          )}
                        >
                          {QUOTATION_STATUS_LABELS[q.display_status]}
                        </span>
                      </span>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{quotationInvoice(q) ?? '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="border-t px-4 py-3 text-sm text-muted-foreground">
            Showing {shown.length} of {matching.length} quotations
            {matching.length !== rows.length ? ` (${rows.length} in all)` : ''}
          </div>
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}
```

- [ ] **Step 4: Write the Credit Notes view**

Create `src/components/finance/credit-notes-view.tsx`:

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
import { CREDIT_NOTE_REASON_LABELS, type CreditNoteRow, type CreditNoteStatus } from '@/lib/finance/credit-notes';
import { csvFileName } from '@/lib/finance/csv';
import { rm } from '@/lib/finance/format';
import {
  CREDIT_NOTE_STATUS_LABELS,
  type CreditNoteFilter,
  type CreditNotesViewData,
  creditNotesCsv,
  filterCreditNotes,
  refundedOnNote,
} from '@/lib/finance/sales-followon-views';
import { LATEST_ROWS, displayDate } from '@/lib/finance/view-helpers';
import { cn } from '@/lib/utils';

const CREDITED_SERIES: Series[] = [{ key: 'credited', label: 'Credited (RM k)', color: 'var(--chart-3)' }];

const STATUS_STYLES: Record<CreditNoteStatus, string> = {
  issued: 'bg-emerald-500/15 text-emerald-600',
  draft: 'bg-muted text-muted-foreground',
  void: 'bg-muted text-muted-foreground line-through',
};

const COLUMNS = 8;

/** A draft or a void credit note has refunded nothing: a dash, as a draft's number is. */
const formatRefunded = (amount: number | null) => (amount === null ? '—' : rm(amount));

/**
 * Credit Notes, read-only: figures, charts and the table, with search, a
 * status filter, "View all" and Export. Nothing here writes; the form and the
 * row actions (issue, refund, void) come with the next stage.
 */
export function CreditNotesView({
  rows,
  view,
}: {
  /** Every credit note, newest first; drafts and void ones included. */
  rows: CreditNoteRow[];
  view: CreditNotesViewData;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<CreditNoteFilter>('open');
  const [showAll, setShowAll] = useState(false);

  const matching = filterCreditNotes(rows, query, filter);
  const shown = showAll ? matching : matching.slice(0, LATEST_ROWS);

  return (
    <ScreenContainer className="pb-24 sm:pb-24">
      <PageHeader title="Credit Notes" subtitle="Credits issued against customer invoices, Saudara." />

      <BentoGrid>
        {view.stats.map((s, i) => (
          <BentoCard key={s.label} tone={i === 0 ? 'primary' : 'default'} className="col-span-1 md:col-span-3">
            <BentoStat label={s.label} value={s.value} delta={s.delta} deltaTone={s.deltaTone} onPrimary={i === 0} />
          </BentoCard>
        ))}

        <BentoCard title="Credited over time" subtitle="Last 8 months" icon={TrendingUp} className="col-span-2 md:col-span-8">
          {view.hasTrend ? (
            <AreaTrend data={view.trend} series={CREDITED_SERIES} height={240} />
          ) : (
            <p className="grid h-60 place-items-center text-sm text-muted-foreground">Nothing credited in the last 8 months.</p>
          )}
        </BentoCard>
        <BentoCard title="Credits by reason" subtitle="This year" icon={PieChart} className="col-span-2 md:col-span-4">
          {view.hasReasons ? (
            <DonutStat data={view.byReason} height={240} centerValue={view.creditedYtd} centerLabel="credited" />
          ) : (
            <p className="grid h-60 place-items-center text-sm text-muted-foreground">Nothing credited this year.</p>
          )}
        </BentoCard>

        <BentoCard
          title="Credit notes"
          subtitle="What you have credited your customers"
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
                aria-label="Search credit notes by number, customer or invoice"
                placeholder="Search credit notes, customers or invoices…"
                className="pl-8"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <Select value={filter} onValueChange={(v) => setFilter(v as CreditNoteFilter)}>
              <SelectTrigger className="w-40" aria-label="Status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="open">All except void</SelectItem>
                <SelectItem value="draft">Draft</SelectItem>
                <SelectItem value="issued">Issued</SelectItem>
                <SelectItem value="void">Void</SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              disabled={matching.length === 0}
              onClick={() => downloadCsv(csvFileName('credit-notes', localIsoDate(new Date())), creditNotesCsv(matching))}
            >
              <Download className="size-4" />
              Export
            </Button>
          </div>
          <div className="mt-3 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40">
                  <TableHead>No.</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Against invoice</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead className="text-right">Refunded</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.length === 0 &&
                  (rows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={COLUMNS} className="py-8 text-center text-muted-foreground">
                        No credit notes yet.
                      </TableCell>
                    </TableRow>
                  ) : (
                    <NoMatchesRow colSpan={COLUMNS} />
                  ))}
                {shown.map((n) => (
                  <TableRow key={n.id} className={cn(n.status === 'void' && 'opacity-60')}>
                    <TableCell className="whitespace-nowrap font-medium">{n.credit_note_no ?? '—'}</TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{displayDate(n.credit_date)}</TableCell>
                    <TableCell className="whitespace-nowrap">{n.customer_name}</TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{n.invoice_no ?? '—'}</TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{CREDIT_NOTE_REASON_LABELS[n.reason]}</TableCell>
                    <TableCell className="whitespace-nowrap text-right tabular-nums">{rm(n.amount)}</TableCell>
                    <TableCell className="whitespace-nowrap text-right tabular-nums">{formatRefunded(refundedOnNote(n))}</TableCell>
                    <TableCell>
                      <span className="flex items-center gap-2">
                        <LiveDot active={n.status === 'issued'} />
                        <span
                          className={cn(
                            'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold',
                            STATUS_STYLES[n.status],
                          )}
                        >
                          {CREDIT_NOTE_STATUS_LABELS[n.status]}
                        </span>
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="border-t px-4 py-3 text-sm text-muted-foreground">
            Showing {shown.length} of {matching.length} credit notes
            {matching.length !== rows.length ? ` (${rows.length} in all)` : ''}
          </div>
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}
```

- [ ] **Step 5: Write the Refunds view**

Create `src/components/finance/refunds-view.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { Banknote, Download, PieChart, Search, TrendingUp } from 'lucide-react';
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
import { csvFileName } from '@/lib/finance/csv';
import { rm } from '@/lib/finance/format';
import { REFUND_REASON_LABELS, type RefundRow } from '@/lib/finance/refunds';
import {
  REFUND_STATUS_LABELS,
  type RefundFilter,
  type RefundsViewData,
  filterRefunds,
  refundsCsv,
} from '@/lib/finance/sales-followon-views';
import { LATEST_ROWS, displayDate } from '@/lib/finance/view-helpers';
import { cn } from '@/lib/utils';

const REFUNDED_SERIES: Series[] = [{ key: 'refunded', label: 'Refunded (RM k)', color: 'var(--chart-3)' }];

const STATUS_STYLES: Record<RefundRow['status'], string> = {
  posted: 'bg-emerald-500/15 text-emerald-600',
  scheduled: 'bg-amber-500/15 text-amber-600',
  pending_approval: 'bg-amber-500/15 text-amber-600',
  draft: 'bg-muted text-muted-foreground',
  rejected: 'bg-red-500/15 text-red-600',
  void: 'bg-muted text-muted-foreground line-through',
};

const COLUMNS = 8;

/**
 * Refunds, read-only: figures, charts and the table, with search, a status
 * filter, "View all" and Export. Nothing here writes; the form and the row
 * actions (mark paid out, delete, void) come with the next stage.
 */
export function RefundsView({
  rows,
  view,
}: {
  /** Every refund, newest first; pending and void ones included. */
  rows: RefundRow[];
  view: RefundsViewData;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<RefundFilter>('open');
  const [showAll, setShowAll] = useState(false);

  const matching = filterRefunds(rows, query, filter);
  const shown = showAll ? matching : matching.slice(0, LATEST_ROWS);

  return (
    <ScreenContainer className="pb-24 sm:pb-24">
      <PageHeader title="Refunds" subtitle="Money paid back to customers who are in credit, Saudara." />

      <BentoGrid>
        {view.stats.map((s, i) => (
          <BentoCard key={s.label} tone={i === 0 ? 'primary' : 'default'} className="col-span-1 md:col-span-3">
            <BentoStat label={s.label} value={s.value} delta={s.delta} deltaTone={s.deltaTone} onPrimary={i === 0} />
          </BentoCard>
        ))}

        <BentoCard title="Refunded over time" subtitle="Last 8 months" icon={TrendingUp} className="col-span-2 md:col-span-8">
          {view.hasTrend ? (
            <AreaTrend data={view.trend} series={REFUNDED_SERIES} height={240} />
          ) : (
            <p className="grid h-60 place-items-center text-sm text-muted-foreground">Nothing refunded in the last 8 months.</p>
          )}
        </BentoCard>
        <BentoCard title="Refunds by reason" subtitle="This year" icon={PieChart} className="col-span-2 md:col-span-4">
          {view.hasReasons ? (
            <DonutStat data={view.byReason} height={240} centerValue={view.refundedYtd} centerLabel="refunded" />
          ) : (
            <p className="grid h-60 place-items-center text-sm text-muted-foreground">Nothing refunded this year.</p>
          )}
        </BentoCard>

        <BentoCard
          title="Refunds"
          subtitle="What you have paid back, and what is waiting to be paid"
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
                aria-label="Search refunds by customer, invoice, credit note or number"
                placeholder="Search customers, invoices or numbers…"
                className="pl-8"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <Select value={filter} onValueChange={(v) => setFilter(v as RefundFilter)}>
              <SelectTrigger className="w-40" aria-label="Status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="open">All except void</SelectItem>
                <SelectItem value="pending">Pending</SelectItem>
                <SelectItem value="posted">Refunded</SelectItem>
                <SelectItem value="void">Void</SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              disabled={matching.length === 0}
              onClick={() => downloadCsv(csvFileName('refunds', localIsoDate(new Date())), refundsCsv(matching))}
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
                  <TableHead>Customer</TableHead>
                  <TableHead>Invoice</TableHead>
                  <TableHead>Credit note</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.length === 0 &&
                  (rows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={COLUMNS} className="py-8 text-center text-muted-foreground">
                        No refunds yet.
                      </TableCell>
                    </TableRow>
                  ) : (
                    <NoMatchesRow colSpan={COLUMNS} />
                  ))}
                {shown.map((r) => (
                  <TableRow key={r.allocation_id} className={cn(r.status === 'void' && 'opacity-60')}>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{displayDate(r.txn_date)}</TableCell>
                    <TableCell className="whitespace-nowrap font-medium">{r.number ?? '—'}</TableCell>
                    <TableCell className="whitespace-nowrap">{r.customer_name}</TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{r.invoice_no ?? '—'}</TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{r.credit_note_no ?? '—'}</TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{REFUND_REASON_LABELS[r.reason]}</TableCell>
                    <TableCell className="whitespace-nowrap text-right tabular-nums">{rm(r.amount)}</TableCell>
                    <TableCell>
                      <span className="flex items-center gap-2">
                        <LiveDot active={r.status === 'posted'} />
                        <span
                          className={cn(
                            'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold',
                            STATUS_STYLES[r.status],
                          )}
                        >
                          {REFUND_STATUS_LABELS[r.status]}
                        </span>
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="border-t px-4 py-3 text-sm text-muted-foreground">
            Showing {shown.length} of {matching.length} refunds
            {matching.length !== rows.length ? ` (${rows.length} in all)` : ''}
          </div>
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}
```

- [ ] **Step 6: Replace the three screens with server loaders**

Replace the whole of `src/screens/finance/quotations.tsx` with:

```tsx
import { QuotationsView } from '@/components/finance/quotations-view';
import { getViewer, hasSupabaseEnv } from '@/lib/auth/viewer';
import { listQuotations } from '@/lib/finance/quotations';
import { quotationsView } from '@/lib/finance/sales-followon-views';
import { todayUtc } from '@/lib/finance/view-helpers';
import { createClient } from '@/lib/supabase/server';
import { SAMPLE_QUOTATIONS, SAMPLE_TODAY } from './sales-sample';

/**
 * Quotations, read-only for everyone in this stage: the view takes no
 * actions, so nothing here depends on the viewer's role. The form and the row
 * actions arrive with the next stage, given only to people who may edit, as
 * on Invoices.
 */
export default async function QuotationsScreen() {
  if (!hasSupabaseEnv()) {
    return <QuotationsView rows={SAMPLE_QUOTATIONS} view={quotationsView(SAMPLE_QUOTATIONS, SAMPLE_TODAY)} />;
  }
  const viewer = await getViewer();
  const ctx = { client: await createClient(), orgId: viewer.orgId };
  const rows = await listQuotations(ctx);
  return <QuotationsView rows={rows} view={quotationsView(rows, todayUtc())} />;
}
```

Replace the whole of `src/screens/finance/credit-notes.tsx` with:

```tsx
import { CreditNotesView } from '@/components/finance/credit-notes-view';
import { getViewer, hasSupabaseEnv } from '@/lib/auth/viewer';
import { listCreditNotes } from '@/lib/finance/credit-notes';
import { creditNotesView } from '@/lib/finance/sales-followon-views';
import { todayUtc } from '@/lib/finance/view-helpers';
import { createClient } from '@/lib/supabase/server';
import { SAMPLE_CREDIT_NOTES, SAMPLE_TODAY } from './sales-sample';

/**
 * Credit Notes, read-only for everyone in this stage: the view takes no
 * actions, so nothing here depends on the viewer's role. The form and the row
 * actions arrive with the next stage.
 */
export default async function CreditNotesScreen() {
  if (!hasSupabaseEnv()) {
    return <CreditNotesView rows={SAMPLE_CREDIT_NOTES} view={creditNotesView(SAMPLE_CREDIT_NOTES, SAMPLE_TODAY)} />;
  }
  const viewer = await getViewer();
  const ctx = { client: await createClient(), orgId: viewer.orgId };
  const rows = await listCreditNotes(ctx);
  return <CreditNotesView rows={rows} view={creditNotesView(rows, todayUtc())} />;
}
```

Replace the whole of `src/screens/finance/refunds.tsx` with:

```tsx
import { RefundsView } from '@/components/finance/refunds-view';
import { getViewer, hasSupabaseEnv } from '@/lib/auth/viewer';
import { listInvoices } from '@/lib/finance/invoices';
import { listRefunds } from '@/lib/finance/refunds';
import { refundsView } from '@/lib/finance/sales-followon-views';
import { todayUtc } from '@/lib/finance/view-helpers';
import { createClient } from '@/lib/supabase/server';
import { SAMPLE_INVOICES, SAMPLE_REFUNDS, SAMPLE_TODAY } from './sales-sample';

/**
 * Refunds, read-only for everyone in this stage: the view takes no actions,
 * so nothing here depends on the viewer's role. The form and the row actions
 * arrive with the next stage.
 */
export default async function RefundsScreen() {
  if (!hasSupabaseEnv()) {
    return <RefundsView rows={SAMPLE_REFUNDS} view={refundsView(SAMPLE_REFUNDS, SAMPLE_INVOICES, SAMPLE_TODAY)} />;
  }
  const viewer = await getViewer();
  const ctx = { client: await createClient(), orgId: viewer.orgId };
  // The invoices feed the "In credit" card; the table shows refunds only.
  const [rows, invoices] = await Promise.all([listRefunds(ctx), listInvoices(ctx)]);
  return <RefundsView rows={rows} view={refundsView(rows, invoices, todayUtc())} />;
}
```

- [ ] **Step 7: Mark the screens live, and refresh them when a contact or an invoice changes**

In `src/config/live-screens.ts`, replace:

```ts
  'finance/invoices',
  'finance/payments-in',
```

with:

```ts
  'finance/invoices',
  'finance/payments-in',
  // Read-only so far: their forms and row actions join in the next slice.
  'finance/quotations',
  'finance/credit-notes',
  'finance/refunds',
```

In `src/app/(app)/finance/actions.ts`, replace:

```ts
// A contact's name shows on the bills, invoices and payments screens too.
const CONTACT_PATHS = [
  '/finance/customers-suppliers',
  '/finance/supplier-bills',
  '/finance/payments-out',
  '/finance/invoices',
  '/finance/payments-in',
];
```

with:

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
```

In `src/app/(app)/finance/actions.ts`, replace:

```ts
// An invoice or a payment in changes what customers owe, which Customers & Suppliers shows as Receivable.
const SALES_PATHS = ['/finance/invoices', '/finance/payments-in', '/finance/customers-suppliers'];
```

with:

```ts
// An invoice or a payment in changes what customers owe, which Customers & Suppliers shows as Receivable.
// It also shows on the three follow-on screens: Quotations names the invoice made from a quotation, Credit
// Notes names each note's invoice, and Refunds adds up what customers are in credit from the invoices.
const SALES_PATHS = [
  '/finance/invoices',
  '/finance/payments-in',
  '/finance/customers-suppliers',
  '/finance/quotations',
  '/finance/credit-notes',
  '/finance/refunds',
];
```

- [ ] **Step 8: Run the tests**

Run: `pnpm exec vitest run tests/live-screens.test.ts tests/finance-contact-paths.test.ts tests/finance-sales-actions.test.ts tests/finance-actions.test.ts tests/screen-routes.test.ts`
Expected: PASS, all five files. `tests/finance-actions.test.ts` was not edited: the bill and payment-out actions still refresh the three purchase paths.

- [ ] **Step 9: Check the routes, type-check, lint and build**

Run: `pnpm gen:routes --check`
Expected: exit 0, nothing out of date. (The three route files already import these screens' default exports.)

Run, as separate commands: `pnpm exec tsc --noEmit`, `pnpm lint`, `pnpm build`
Expected: no type or lint errors, no warnings; the build completes and lists `/finance/quotations`, `/finance/credit-notes` and `/finance/refunds`. The build is what catches a server-only import reaching a client component. It reads no data.

Run: `grep -n "use client\|writer\|Action\|icon={Filter}\|FileMinus\|Undo2\|Sparkline" src/screens/finance/quotations.tsx src/screens/finance/credit-notes.tsx src/screens/finance/refunds.tsx src/components/finance/quotations-view.tsx src/components/finance/credit-notes-view.tsx src/components/finance/refunds-view.tsx`
Expected: exactly three lines, the `'use client';` at the top of each view. No `writer`, no action, none of the mock-ups' icons or sparklines.

- [ ] **Step 10: Commit**

```bash
git add src/components/finance/quotations-view.tsx src/components/finance/credit-notes-view.tsx src/components/finance/refunds-view.tsx src/screens/finance/quotations.tsx src/screens/finance/credit-notes.tsx src/screens/finance/refunds.tsx src/config/live-screens.ts "src/app/(app)/finance/actions.ts" tests/live-screens.test.ts tests/finance-contact-paths.test.ts tests/finance-sales-actions.test.ts
git commit -m "feat: Quotations, Credit Notes and Refunds read the workspace's own data, read-only"
```

No browser check and no dev server: the controller checks the screens on production after the merge. This task runs no database test.

---

### Task 8: Document and verify the branch

**Files:**
- Modify: `docs/bendahara-backend.md`

Every function is written with its real argument names and every code with its full meaning. After editing, read the note beside `supabase/migrations/20261022100000_bendahara_sales_followons.sql` once: each `raise exception … using errcode` in the migration must be covered by the meaning the note gives that code, and each function's arguments in the note must be the names in its `create or replace function` line.

- [ ] **Step 1: The table of pure files**

In `docs/bendahara-backend.md`, replace:

```markdown
| `sales-views.ts` | KPI figures, chart data, table filters, status words and CSV rows for Invoices and Payments In; what each row's menu offers (`invoiceActions`, `paymentInActions`); which customer the filter is on after a refresh (`customerChoice`) |
```

with:

```markdown
| `sales-views.ts` | KPI figures, chart data, table filters, status words and CSV rows for Invoices and Payments In; what each row's menu offers (`invoiceActions`, `paymentInActions`); which customer the filter is on after a refresh (`customerChoice`); how an invoice's balance is worded, a customer in credit included (`owed`, `inCredit`, `balanceText`) |
| `sales-followon-views.ts` | KPI figures, chart data, table filters, status words and CSV rows for Quotations, Credit Notes and Refunds |
```

- [ ] **Step 2: The tables**

In `docs/bendahara-backend.md`, replace:

```markdown
| `finance_invoices`, `finance_invoice_lines` | Sales invoices and their lines. A draft has no `invoice_no`. Lines keep the order they were entered in (`position`). |
```

with:

```markdown
| `finance_invoices`, `finance_invoice_lines` | Sales invoices and their lines. A draft has no `invoice_no`. Lines keep the order they were entered in (`position`). `quotation_id` is the quotation an invoice was made from, if any. |
| `finance_quotations`, `finance_quotation_lines` | Quotations and their lines, shaped like invoices. A draft has no `quotation_no`. |
| `finance_credit_notes` | A credit against one posted invoice: one amount and a reason, no lines. A draft has no `credit_note_no`. |
```

In `docs/bendahara-backend.md`, replace:

```markdown
| `finance_allocations` | How a movement is split across the documents it pays. Each row names exactly one document: a bill (`bill_id`) or an invoice (`invoice_id`). |
```

with:

```markdown
| `finance_allocations` | How a movement is split across the documents it pays. Each row names exactly one document: a bill (`bill_id`), an invoice (`invoice_id`) or a credit note (`credit_note_id`). `reason` is what a refund is for. |
```

- [ ] **Step 3: Document numbers**

In `docs/bendahara-backend.md`, replace:

```markdown
the database function that posts a document, so a failed post does not use up a
number.
```

with:

```markdown
the database function that posts a document, so a failed post does not use up a
number.

A quotation takes its `QT-` number when it is sent and a credit note its `CN-`
number when it is issued. A refund is money out and takes a `PV-` number when
it is paid out, from the same counter as a payment to a supplier.
```

- [ ] **Step 4: Money**

In `docs/bendahara-backend.md`, replace:

```markdown
A bill takes only money out and an invoice only money in. Money out against an
invoice (a refund) arrives with the sales follow-ons.
```

with:

```markdown
A bill takes only money out. An invoice takes money in, which pays it, and
money out, which is a refund. A credit note takes only money out.

A refund is one row with direction `out`, allocated to one invoice or to one
credit note, with a `reason` on the allocation (`order_cancelled`,
`damaged_goods`, `wrong_item`, `overpayment`, `other`). It is paid out at once
(`posted`, numbered `PV-`) or left pending (`scheduled`). A pending refund is
marked paid by `finance_mark_payment_paid` or deleted; a refund that was paid
out can only be voided. These are the function, the delete and the update a
payment to a supplier uses. The view `finance_refunds` has one row per refund,
with `invoice_id` set whichever way it was recorded and `credit_note_id` when
it was put against a credit note.

A refund is not on Payments Out: `finance_payments_out` joins each allocation
to its bill, and a refund has none. `supplier_bill_totals` counts only money
out allocated to a bill, so a refund is never counted as paid to a supplier.
`finance_payments_in` shows only money in.
```

- [ ] **Step 5: Invoices, quotations, credit notes**

In `docs/bendahara-backend.md`, replace:

```markdown
The view `finance_invoice_totals` adds the customer's name, `subtotal`, `sst`,
`total`, `paid` (posted money in allocated to the invoice), `balance` and
`display_status`: `draft`, `void`, `paid` (the total is above zero and nothing
is left to pay), `overdue` (posted and past `due_date` by the database's UTC
date), otherwise `sent`. "Sent" means posted; no email goes out. A part-paid
invoice stays `sent` or `overdue` with a lower balance. Credit notes and
refunds will change the balance when they exist.
```

with:

```markdown
The view `finance_invoice_totals` adds the customer's name, `subtotal`, `sst`,
`total`, `paid` (posted money in allocated to the invoice), `credited` (its
issued credit notes), `refunded` (posted refunds, put against the invoice
itself or against one of its credit notes), `balance` and `display_status`:
`draft`, `void`, `paid` (the total is above zero and nothing is left to pay),
`overdue` (posted and past `due_date` by the database's UTC date), otherwise
`sent`. "Sent" means posted; no email goes out. A part-paid invoice stays
`sent` or `overdue` with a lower balance.

`balance` is `total − paid − credited + refunded`. This view is the one place
it is worked out: the guards read their figures from it, and the screens read
`balance` and never work it out again. **A balance below zero means the
customer is in credit:** they have paid, or been credited, more than the
invoice came to. Such an invoice reads `paid`. It takes no more money in, and
a refund can pay the credit out, which brings the balance back to zero.

How a customer in credit shows: on Invoices the Balance cell reads
"RM 240.00 in credit" (`balanceText`), never a negative amount, and the CSV
has Credited and Refunded columns beside a Balance that is below zero. The
payment-in form does not offer the invoice. Total receivable on Invoices and
Receivable on Customers & Suppliers add up only invoices that are `sent` or
`overdue`, so a customer's credit on one invoice is not taken off what they
owe on another. Refunds has a card, "In credit", that adds up every invoice's
credit, pending refunds included.
```

In `docs/bendahara-backend.md`, replace:

```markdown
## Posted is locked

Triggers enforce it, so no caller can get round it:
```

with:

```markdown
## Quotations

A quotation is a `finance_quotations` row with its lines in
`finance_quotation_lines`, which has the columns of `finance_invoice_lines`.
`status` is what a person sets: `draft`, `sent`, `accepted` or `declined`.
"Sent" records that the customer has been given the quotation; nothing is
emailed. Sending gives it the next `QT-` number and locks its header and
lines. After that only the customer's answer is recorded (`status`,
`accepted_at`), and it can be corrected from one answer to the other until an
invoice is made from the quotation. There is no void: a quotation that is no
longer wanted is marked declined. The database checks that a draft has no
number, any other status has one with `sent_at`, and that `accepted_at` is set
exactly when the status is `accepted`.

The view `finance_quotation_totals` adds the customer's name, `subtotal`,
`sst`, `total`, `display_status` (`expired` for a sent quotation past
`valid_until` by the database's UTC date, otherwise the status) and
`invoice_id` and `invoice_no`: the invoice made from the quotation, if one
stands. An accepted quotation stays `accepted` after its date; a sent one can
still be accepted after it expired.

`finance_convert_quotation` makes a draft invoice from an accepted quotation:
the same customer, notes and lines, dated today, due after the customer's
payment terms, with `quotation_id` set. A quotation has one invoice at a time
(a unique index on `finance_invoices`); a void invoice does not count, so a
quotation whose invoice was voided, or deleted as a draft, can be converted
again. The invoice is an ordinary draft afterwards. The funnel on the screen
has three steps, created, sent and accepted: nothing tracks a customer opening
a quotation.

## Credit notes

A credit note is one `finance_credit_notes` row: one amount against one posted
invoice, a `reason` (`returns`, `pricing_adjustment`, `overbilling`,
`goodwill`, `other`), and a `status` of `draft`, `issued` or `void`. Issuing
gives it the next `CN-` number, and from that moment its amount is taken off
what the invoice owes. All the issued credit notes of an invoice together
never exceed the invoice's total. What has been paid does not limit a credit
note: one issued on a paid invoice leaves the customer in credit, and a refund
pays that out.

The view `finance_credit_note_totals` adds the invoice's number, the customer
and `refunded`: posted refunds put against the note itself.

## Posted is locked

Triggers enforce it, so no caller can get round it:
```

- [ ] **Step 6: The locking rules**

In `docs/bendahara-backend.md`, replace:

```markdown
- An invoice follows the same rules as a bill: created as a draft, edited
  and deleted only as a draft, posted only once its lines add up to more than
  zero, voided only when posted and only while no payment that is posted,
  scheduled or in progress is allocated to it. Its lines are locked with it.
```

with:

```markdown
- An invoice follows the same rules as a bill: created as a draft, edited
  and deleted only as a draft, posted only once its lines add up to more than
  zero, voided only when posted and only while no payment or refund that is
  posted, scheduled or in progress is allocated to it. Its lines are locked
  with it. An invoice with a credit note that is a draft or issued cannot be
  voided either.
- `quotation_id` on an invoice may only name an accepted quotation of the
  same customer, checked when the tie is made; a draft invoice can be untied.
- A quotation is created as a draft, edited and deleted only as a draft, and
  sent only once its lines add up to more than zero. Sent, accepted or
  declined, nothing on it changes but the answer; once an invoice stands for
  it, the answer cannot change either.
- A credit note is created as a draft against a posted invoice, edited and
  deleted only as a draft, and voided only when issued. It cannot be voided
  while a refund is allocated to it, or while the refunds on its invoice
  would no longer fit in the customer's credit without it.
- A refund needs the customer to be in credit on the invoice and can be no
  more than that credit, counting refunds that are pending; against a credit
  note it is also never more than the note. The invoice row is locked while
  this is checked. It is checked again when a pending refund is paid out.
```

In `docs/bendahara-backend.md`, replace:

```markdown
- A contact with invoices cannot have Customer unticked, as one with bills
  cannot have Supplier unticked.
- Clearing a deleted user from an invoice's `created_by` is allowed whatever
  the invoice's status.
```

with:

```markdown
- A contact with invoices or quotations cannot have Customer unticked, as one
  with bills cannot have Supplier unticked.
- Clearing a deleted user from the `created_by` of an invoice, a quotation or
  a credit note is allowed whatever its status.
```

- [ ] **Step 7: The database functions**

In `docs/bendahara-backend.md`, replace:

```markdown
| `finance_next_number(target_org, doc)` | The next document number. |

Voiding a bill, an invoice or a payment, and deleting a draft bill, a draft
invoice or a scheduled payment, are plain updates and deletes; the guards
decide whether they are allowed.
```

with:

```markdown
| `finance_save_quotation(target_org, quotation, lines)` | Creates a draft quotation or replaces a draft's header and lines, keeping the lines in the order given. `quotation` has `id` (to change a draft), `customer_id`, `quote_date`, `valid_until`, `notes`. Returns the id. |
| `finance_send_quotation(target_org, target_quotation)` | Marks a draft as sent and returns its number. |
| `finance_convert_quotation(target_org, target_quotation)` | Makes a draft invoice from an accepted quotation. Returns the invoice's id. |
| `finance_save_credit_note(target_org, note)` | Creates a draft credit note or replaces a draft. `note` has `id` (to change a draft), `invoice_id`, `credit_date`, `reason`, `amount`, `notes`. Returns the id. |
| `finance_issue_credit_note(target_org, target_note)` | Issues a draft and returns its number. |
| `finance_record_refund(target_org, refund)` | Records one refund against one invoice or one credit note. `refund` has `invoice_id` or `credit_note_id`, `account_id`, `txn_date`, `method`, `reason`, `amount`, `reference`, `notes`, and `status`: `posted` (the default) or `scheduled`. Returns the id. |
| `finance_next_number(target_org, doc)` | The next document number. |

Accepting or declining a quotation, voiding a credit note or a refund, and
deleting a draft quotation, a draft credit note or a pending refund, are plain
updates and deletes too. The data layer for all of it is in `quotations.ts`,
`credit-notes.ts` and `refunds.ts`; no server action calls the write functions
yet.

Voiding a bill, an invoice or a payment, and deleting a draft bill, a draft
invoice or a scheduled payment, are plain updates and deletes; the guards
decide whether they are allowed.
```

- [ ] **Step 8: The error codes**

In `docs/bendahara-backend.md`, replace:

```markdown
The guards and functions raise these SQLSTATEs. `bills.ts`, `invoices.ts`,
`money.ts` and `contacts.ts` turn them into sentences; the same code is worded
for a bill or for an invoice by the file that made the call.
```

with:

```markdown
The guards and functions raise these SQLSTATEs. `bills.ts`, `invoices.ts`,
`money.ts`, `contacts.ts`, `quotations.ts`, `credit-notes.ts` and `refunds.ts`
turn them into sentences; the same code is worded for a bill, an invoice, a
quotation, a credit note or a refund by the file that made the call.
```

In `docs/bendahara-backend.md`, replace:

```markdown
| `FIN02` | The bill or invoice has payments (posted, scheduled or in progress), so it cannot be voided |
```

with:

```markdown
| `FIN02` | The bill or invoice has payments (posted, scheduled or in progress), so it cannot be voided; for an invoice a refund put against it counts as one. Also: a credit note cannot be voided while a refund is allocated to it, or while the refunds on its invoice would not fit in the customer's credit without it |
```

In `docs/bendahara-backend.md`, replace:

```markdown
| `FIN04` | A payment can only go against a posted bill or a posted invoice; only money out pays a bill, and only money in pays an invoice. Also: a payment that has been split across documents cannot change direction (money out or money in, while it is not yet posted) |
| `FIN05` | The amount is more than is still owed on the bill or the invoice, counting payments that are posted, scheduled, draft or pending approval |
| `FIN06` | No bill was chosen or found, or the bills belong to different suppliers; for money in, no invoice was chosen or found, or the invoices belong to different customers |
```

with:

```markdown
| `FIN04` | A payment can only go against a posted bill or a posted invoice; only money out pays a bill, and only money in pays an invoice. Money out against an invoice is a refund, and is this code unless the customer is in credit on that invoice; a refund against a credit note needs the note to be issued, and money in never goes against a credit note. Also: a payment that has been split across documents cannot change direction (money out or money in, while it is not yet posted); a credit note can only go against a posted invoice; only an accepted quotation becomes an invoice, and an invoice can only be tied to an accepted quotation of the same customer |
| `FIN05` | The amount is more than is still owed on the bill or the invoice, counting payments that are posted, scheduled, draft or pending approval. For a refund: more than the customer is in credit on the invoice, counting pending refunds, or more than is left of the credit note; also when a pending refund is paid out after that credit has gone. For a credit note: more than the invoice's total less what is already credited |
| `FIN06` | No bill was chosen or found, or the bills belong to different suppliers; for money in, no invoice was chosen or found, or the invoices belong to different customers; for a refund, it names no document, or an invoice and a credit note at once, or one that is not in the workspace |
```

In `docs/bendahara-backend.md`, replace:

```markdown
| `FIN08` | The contact has invoices, so Customer cannot be unticked |
```

with:

```markdown
| `FIN08` | The contact has invoices or quotations, so Customer cannot be unticked |
```

In `docs/bendahara-backend.md`, replace:

```markdown
| `FIN11` | The bill, invoice or payment no longer exists. `finance_post_invoice` also answers this to a viewer: it locks the invoice before posting, and a viewer may not, so to them it is not there |
```

with:

```markdown
| `FIN11` | The bill, invoice, quotation, credit note or payment no longer exists. `finance_post_invoice`, `finance_send_quotation`, `finance_convert_quotation` and `finance_issue_credit_note` also answer this to a viewer: each locks its row first, and a viewer may not, so to them it is not there |
| `FIN12` | The invoice has a credit note that is a draft or issued, so it cannot be voided. `invoices.ts` words it: "This invoice has credit notes. Void them on Credit Notes, or delete the drafts, before voiding it." |
| `FIN13` | The quotation already has an invoice that is not void: it cannot be converted again, and its answer can no longer change. `quotations.ts` words it |
```

- [ ] **Step 9: The same codes for a quotation and a credit note**

`FIN01` and `FIN10` are raised for a quotation and a credit note as they are for an invoice. Say so where the two codes are described.

In `docs/bendahara-backend.md`, replace:

```markdown
| `FIN10` | The bill or invoice has no lines, or its lines total nothing; it cannot be saved without a line or posted without an amount |
```

with:

```markdown
| `FIN10` | The bill, invoice or quotation has no lines, or its lines total nothing; it cannot be saved without a line, and a bill or an invoice cannot be posted, nor a quotation sent, without an amount |
```

In `docs/bendahara-backend.md`, replace:

```markdown
The sentence for `FIN01` on an invoice is "This invoice has been posted or
voided, so that can no longer be done.".
```

with:

```markdown
`FIN01` is also raised for a quotation (created as a draft; one that has been
sent is locked but for its answer, and its lines with it; a draft is not
accepted or declined) and for a credit note (created as a draft; an issued or
void one is locked; a draft is deleted, not voided). Their sentences are in
`quotations.ts` and `credit-notes.ts`.

The sentence for `FIN01` on an invoice is "This invoice has been posted or
voided, so that can no longer be done.".
```

- [ ] **Step 10: Known limits**

In `docs/bendahara-backend.md`, replace:

```markdown
- Money in is never scheduled, but `finance_mark_payment_paid` does not check
  the direction: a scheduled movement of money in could only come from writing
  to the table directly, and marking it paid would give it a `PV-` number.
```

with:

```markdown
- Money in is never scheduled, but `finance_mark_payment_paid` does not check
  the direction: a scheduled movement of money in could only come from writing
  to the table directly, and marking it paid would give it a `PV-` number. For
  money out the function is used as it is, for a pending refund as much as for
  a scheduled payment to a supplier: both are payment vouchers.
- Quotations, Credit Notes and Refunds are read-only so far: search, filters,
  "View all" and Export, but no forms and no row actions. The data layer for
  them is in `quotations.ts`, `credit-notes.ts` and `refunds.ts`.
- A credit note is one amount with a reason. It has no lines and does not say
  how much of it is SST.
- A quotation has no void. One that was sent by mistake is marked declined,
  and then counts as declined in the conversion figure.
- A customer's credit on one invoice is not taken off what they owe on
  another, in any total. To use it against another invoice, refund it and
  record a payment in.
- Voiding a payment in after its invoice was credited and refunded is allowed:
  the invoice then shows the customer owing again, the refund included, which
  is what is true. A refund that was still pending at that moment can no
  longer be marked paid (`FIN05`); delete it.
- That second look at a pending refund reads the invoice without locking it. A
  payment in voided at the very moment a pending refund on the same invoice is
  marked paid can slip past it; the invoice then shows the customer owing.
- A refund is to one customer against one invoice or one credit note. One
  payment out that refunds several invoices is not recorded as one refund.
- The reason of a refund is one of five words; anything more is in the
  payment's notes.
- A void invoice does not hold its quotation: the quotation can be converted
  again, and the void invoice keeps `quotation_id` as a record of where it
  came from.
- Editing the draft invoice made from a quotation can change its customer; the
  tie to the quotation is checked only when it is made.
- The demo workspace's quotations, credit notes and refunds were dated from
  the day they were seeded, so its Sent quotations turn Expired as time passes
  and its month-to-date figures empty out.
```

- [ ] **Step 11: Review the note against the SQL**

Run: `grep -o "errcode = '[A-Z0-9]*'" supabase/migrations/20261022100000_bendahara_sales_followons.sql | sort | uniq -c`
Expected: `22023` 1, `FIN01` 20, `FIN02` 3, `FIN03` 2, `FIN04` 11, `FIN05` 6, `FIN06` 2, `FIN07` 1, `FIN08` 1, `FIN09` 5, `FIN10` 4, `FIN11` 5, `FIN12` 1, `FIN13` 2. Every `FIN` code there has a row in the note's table, and the note's rows for `FIN12` and `FIN13` exist.

Run: `grep -n "^create or replace function public" supabase/migrations/20261022100000_bendahara_sales_followons.sql`
Expected: six lines, with the argument names `target_org, quotation, lines`; `target_org, target_quotation` (twice); `target_org, note`; `target_org, target_note`; `target_org, refund`. The note's function table uses the same names.

Run: `grep -c "FIN12" src/lib/finance/invoices.ts` and `grep -c "FIN13" src/lib/finance/quotations.ts`
Expected: `2` and `2` (a comment and the map entry in each). A new code with no sentence would reach a person as "That change could not be saved."

- [ ] **Step 12: Run everything**

Run, as separate commands: `pnpm exec tsc --noEmit`, `pnpm lint`, `pnpm exec vitest run --exclude 'tests/*.rls.test.ts' --exclude 'tests/bendahara-*.test.ts'`, `pnpm build`.
Expected: no type or lint errors and no warnings; every unit test file passes (one file reports a skipped test, as it did before this branch); the build completes.

Do not run `pnpm test`, and do not run `tests/bendahara-followons.test.ts`: those reach the hosted production database. The controller runs the database tests (Task 1, steps 13 and 14).

- [ ] **Step 13: Check for banned colours, names and server-only imports**

Run: `git diff origin/main...HEAD -- src | grep -n -i -E "^\+.*(purple|violet|fuchsia|indigo|kuasa\.ai)"`
Expected: no output.

Run: `grep -n -E "supabase/server|next/headers|server-only" src/lib/finance/*.ts src/screens/finance/sales-sample.ts src/components/finance/quotations-view.tsx src/components/finance/credit-notes-view.tsx src/components/finance/refunds-view.tsx`
Expected: no output.

Run: `git diff origin/main...HEAD --stat -- src/lib/finance/money.ts src/lib/finance/bills.ts src/lib/finance/purchase-views.ts src/lib/finance/receipt-form.ts src/components/finance/bills-view.tsx src/components/finance/payments-view.tsx src/components/finance/payments-in-view.tsx`
Expected: no output. None of those files is changed by this branch.

- [ ] **Step 14: Commit**

```bash
git add docs/bendahara-backend.md
git commit -m "docs: describe quotations, credit notes, refunds, the invoice balance, their guards and error codes"
```

- [ ] **Step 15: Hand back**

Do not push. Report what was built, the result of the four commands in Step 12, and anything that had to differ from this plan.

The controller then, in this order:

1. Confirms Task 1 steps 10 to 13 are done: the schema migration is applied, both check scripts pass, the database tests are green but for the one that waits for the seed. **The code must not be deployed before the schema migration is applied.**
2. On the owner's word: `git fetch`, rebase onto `origin/main`, push, open the PR titled `feat-110-bendahara-sales-followons` (no close keyword unless `gh issue list` shows a tracking issue for this stage; issue #41 is broader than it), squash-merge after review.
3. After the deploy, on production with the smoke account (`smoke@openkuasa-test.dev`), before the seed. Wait for each page to finish loading before reading it.
   - `/finance/quotations`, `/finance/credit-notes`, `/finance/refunds` in the smoke workspace: no work-in-progress banner; four cards of RM 0, 0 or "—"; the empty states "Nothing quoted or accepted in the last 8 months.", "No quotations this quarter.", "No quotations yet."; "Nothing credited in the last 8 months.", "Nothing credited this year.", "No credit notes yet."; "Nothing refunded in the last 8 months.", "Nothing refunded this year.", "No refunds yet."; no button that writes; Export greyed out; the last table row clear of the assistant button.
   - `/finance/invoices` and `/finance/payments-in` in the smoke workspace: as they were. Record a payment on an open invoice and void it: both still work. Export the invoices: the CSV has Credited and Refunded columns, both 0.
   - `/finance/supplier-bills`, `/finance/payments-out`, `/finance/customers-suppliers`: the same figures as before the deploy.
4. Applies the seed (Task 1, Step 14), then in the demo workspace:
   - Quotations: 15 quotations; a draft with "—" for its number at the top; Open quotes RM 20.5k with 3 open quotes (the split between Sent and Expired drifts with the calendar; on the day of the seed it is 3 and 3); the funnel and the trend are drawn.
   - Credit Notes: Issued 8, Drafts 1, Invoices affected 8; `CN-0037` against `INV-1037`; the draft has "—" for its number and for Refunded.
   - Refunds: Pending RM 1,000 with 2 refunds; In credit RM 1,600 with 3 invoices; Invoices refunded 4; four rows with `PV-` numbers and two Pending rows with "—".
   - Invoices: Total receivable RM 20.5k (was RM 21.0k) with 4 open invoices; `INV-1038` reads "RM 600.00 in credit", `INV-1033` "RM 680.00 in credit", `INV-1030` "RM 320.00 in credit", all three Paid; `INV-1037` owes RM 5,880.00; no balance anywhere starts with a minus sign.
   - Customers & Suppliers: Receivable RM 20.5k.
   - Payments Out and Supplier Bills: unchanged; no `PV-` refund in either.
   - Export downloads a CSV from each of the three new screens.

---

## Self-review notes

**Spec coverage, build-order item 4, first half.**

| Spec | Where |
|---|---|
| `finance_quotations` + `finance_quotation_lines`: customer, date, `valid_until`, notes, status, `accepted_at`; Expired derived | Task 1 (migration), plus `sent_at` and `quotation_no` |
| Lines on quotations match invoice lines | Task 1, `position` included |
| `finance_invoices.quotation_id` | Task 1 (deferred from 3a) |
| `finance_credit_notes`: one invoice, reason, amount, notes, status | Task 1, plus `credit_date`, `credit_note_no`, `issued_at` |
| `finance_allocations`: exactly one of the document ids; `reason` for refunds | Task 1: bill, invoice or credit note; expenses add theirs later |
| Sequences `quotation` (QT-), `credit_note` (CN-) | Already defined by `finance_next_number`; used by Task 1's functions |
| Refunds = money out allocated to an invoice or credit note; pending is `scheduled` | Task 1, `finance_refunds`, `finance_record_refund` |
| Invoice balance = total − posted money in − issued credit notes + posted refunds; Paid when balance ≤ 0 and total > 0 | Task 1, `finance_invoice_totals` |
| A posted or issued document cannot be updated or deleted; enforced by triggers | Task 1, the quotation and credit-note guards |
| A document with posted money allocated to it cannot be voided | Task 1 (`FIN02` on a credit note and on an invoice; `FIN12`) |
| Only posted transactions change a balance | Task 1: the view counts posted money only; pending refunds are held by the guards |
| Multi-row writes are one `security invoker` function each | Task 1: save quotation, convert, record refund; the single-row saves are functions too, for one way in |
| Converting an accepted quotation creates a draft invoice with the same lines | Task 1, `finance_convert_quotation`; the button is 4b |
| The funnel drops its "Viewed" step | Task 6, `quotationsView` |
| One Zod schema and one function per write, returning a result | Tasks 2, 3, 4 |
| Database refusals become plain sentences | Tasks 2 to 5 |
| Pure view builders | Task 6 |
| Layout kept; search and filters in the browser; "View all"; Export as CSV | Task 7 |
| Viewers get no buttons; sample view with no actions when there is no database | Task 7: nobody gets any in this stage |
| Screen added to `live-screens.ts` and its path to the revalidate list | Task 7 |
| Unit tests for every view builder and every schema | Tasks 2 to 6; `tests/finance-schemas.test.ts` in Tasks 2, 3, 4 |
| Database tests: isolation and viewer-cannot-write on each new table; locked after posting; balances after part payments, credit notes and refunds | Task 1 (`tests/bendahara-followons.test.ts` and the check script) |
| Dry-run, apply before the code deploys, smoke-test | Task 1 steps 10 to 14; Task 8, hand back |
| Left for 4b | The three forms, row actions, server actions; "issue credit note", "refund" and "convert to invoice" buttons |

**Placeholder scan.** Every code block in this plan is a whole file or an exact replacement; there is no "similar to", "as above", "TODO" or elided code. The plan was taken apart by a script that reads only its text; the blocks were applied to an untouched copy of the repository task by task, and after each task the type-check, the linter and the unit tests were run.

**Type consistency across tasks.**

- `QuotationListRow` (Task 2) is what `quotationsView`, `filterQuotations`, `quotationInvoice`, `quotationsCsv`, `customersOf` (Task 6), `SAMPLE_QUOTATIONS` (Task 6) and `QuotationsView`'s `rows` (Task 7) take. Its `display_status` values are the keys of `QUOTATION_STATUS_LABELS` (Task 6) and `STATUS_STYLES` (Task 7), and the values the view in Task 1 produces: `draft`, `sent`, `accepted`, `declined`, `expired`.
- `CreditNoteRow` (Task 3) has exactly the columns `listCreditNotes` selects, which are columns of `finance_credit_note_totals` (Task 1). `CREDIT_NOTE_REASONS` matches the table's check constraint; `CreditNoteStatus` matches its `status` check.
- `RefundRow` (Task 4) has exactly the columns `listRefunds` selects, which are columns of `finance_refunds` (Task 1). `REFUND_REASONS` matches `finance_allocations_reason_check`. `RefundRow['status']` is `PaymentInRow['status']`, the six statuses of `finance_transactions`, which are the keys of `REFUND_STATUS_LABELS` (Task 6) and `STATUS_STYLES` (Task 7).
- `InvoiceListRow.credited` and `.refunded` (Task 5) are columns of `finance_invoice_totals` (Task 1) and are in `LIST_COLUMNS`; `SAMPLE_INVOICES` (Task 5) sets them; `refundsView`'s second argument (Task 6) and the Refunds loader (Task 7) use the same row type.
- The rpc argument names in Tasks 2, 3 and 4 (`target_org`, `quotation`, `lines`; `target_org`, `target_quotation`; `target_org`, `note`; `target_org`, `target_note`; `target_org`, `refund`; `target_org`, `target_txn`, `paid_on`) are the SQL functions' parameter names, and the keys inside `quotation`, `note` and `refund` (`id`, `customer_id`, `quote_date`, `valid_until`, `notes`; `id`, `invoice_id`, `credit_date`, `reason`, `amount`, `notes`; `invoice_id`, `credit_note_id`, `account_id`, `txn_date`, `method`, `reason`, `amount`, `reference`, `notes`, `status`) are the keys those functions read.
- `QuotationsViewData`, `CreditNotesViewData` and `RefundsViewData` (Task 6) are the `view` props of the three components (Task 7); every field they have is used there.
- `ringgitAmount` (Task 3) is used by `credit-notes.ts` (Task 3) and `refunds.ts` (Task 4).

**Review Focus mapped to tasks.**

| Focus | Proven by |
|---|---|
| 1. Replaced guards and view on a live database | Task 1 step 10 (before/after comparison of four views; the check script's 3a flows), step 13 (both check scripts; `tests/bendahara-purchases.test.ts` and `tests/bendahara-sales.test.ts` unchanged and green) |
| 2. Guards and view agreeing to the sen | Task 1 steps 10 and 13, the check script; `tests/bendahara-followons.test.ts` |
| 3. Three races | Task 1 step 13, `tests/bendahara-followons.test.ts` |
| 4. A refund kept off Payments Out and Payments In | Task 1 steps 10 and 13 |
| 5. An invoice in credit on the live screen | Task 5, four test files; Task 8, smoke step 4 |
| 6. Deleting a workspace or a user | Task 1 steps 10 and 13, the check script |
| 7. Samples agreeing | Task 6, `tests/finance-followon-views.test.ts`; Task 5, `tests/finance-sales-views.test.ts` |

**How the SQL in this plan was checked before the plan was written, and what was not.** It could not be run on the hosted database, and was not. It was run on a throwaway local Postgres 16 with stand-ins for `auth` (`auth.users`, `auth.uid()`, `auth.jwt()`, `auth.mfa_factors`) and the three roles, on top of the repository's real tenancy migrations (`20261009090000` to `20261009090600`), the real `private.mfa_ok`, `is_org_member` and `is_org_writer`, and all seven shipped Bendahara migrations with their seeds. There: the schema migration applied; the controller's "before" and "after" blocks found the four views unchanged over the seeded demo data; the new check script passed in the dry-run transaction, by itself on the applied schema, and again with the seed in; the 3a check script, with its one changed line, passed on the applied schema; the seed ran twice and the report block gave the figures step 11 states; five races were run in pairs of sessions (two refunds of one credit, two credit notes for one invoice, two conversions of one quotation, a refund against the voiding of its credit note, an invoice voided against a credit note being issued) and each ended with exactly one winner and a consistent invoice. The check script was also run against thirty-six deliberately broken copies of the migration (a view that forgets credit notes, a refund cap that ignores pending refunds, a guard with a rule removed, a missing check constraint, a view without `security_invoker`, and so on) and failed on every one. Not covered by that: the hosted project's real `auth.users` columns and triggers, PostgREST's view of the new objects, the demo workspace's real invoices and contacts, whether a `reason` has ever been written on the hosted `finance_allocations`, and `tests/bendahara-followons.test.ts` itself, which has only been type-checked and read against the behaviour the local runs showed. Steps 10 to 14 of Task 1 are where those are settled.
