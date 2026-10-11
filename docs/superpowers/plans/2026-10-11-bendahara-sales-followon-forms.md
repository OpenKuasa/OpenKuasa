# Bendahara Quotation Forms and Actions Implementation Plan (stage 4b, part 1 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The first half of stage 4b of the Bendahara CRUD spec: the live, read-only Quotations screen gets its form and actions (new quotation with line items and live totals, edit a draft, mark as sent, record the customer's answer, delete a draft, make a draft invoice from an accepted quotation), and the loose ends stage 4a's reviews left that do not belong to the credit note and refund forms are tied off. Credit Notes and Refunds stay read-only until part 2.

**Architecture:** No database migration: every write maps to a function or a plain update or delete that stage 4a shipped and unit-tested, and that nothing calls yet. A quotation form is an invoice form whose second date is "Valid until" and whose second button marks it as sent, so the card that draws bills and invoices is taught to take those two things from its "kind" and then draws all three. After that the stage is the mirror of 3b: data-layer touch-ups, pure form and menu rules with unit tests, server actions that guard, parse, write and refresh, then the client view and its loader.

**Tech Stack:** Next.js 16.3 App Router (server components, server actions), React 19, Tailwind v4, shadcn/Radix, Supabase Postgres with RLS, Zod 4, Vitest (node, no DOM), pnpm.

**Spec:** `docs/superpowers/specs/2026-10-10-bendahara-crud-design.md`, sections "Screens → Common behaviour", "Sales" (the Quotations row), "Code", "Errors", "Testing"; build-order item 4, second half. Backend notes: `docs/bendahara-backend.md` (read all of it, Known limits included). First half: `docs/superpowers/plans/2026-10-11-bendahara-sales-followons.md` (4a), lines 1 to 165 for its decisions and error codes. The stage this one mirrors: `docs/superpowers/plans/2026-10-11-bendahara-invoice-forms.md` (3b). What the database allows is in `supabase/migrations/20261022100000_bendahara_sales_followons.sql`, already applied; it is the law here.

## Why this is part 1 of 2

Stage 4b as briefed is three interactive screens, two new form cards (a credit note and a refund fit neither shared card), seventeen server actions and two new choices on an invoice's row. Stage 3b, the closest stage in shape, was two screens, no new card and nine actions, and came to eight tasks. Written as one plan, 4b is about twelve tasks and one pull request too large to review well.

It splits cleanly, on a line the data already draws:

- **Part 1, this plan (six tasks): quotations, and what 4a left that is not about credit note or refund forms.** A quotation touches nothing but its own screen until it becomes a draft invoice. Nothing here depends on part 2.
- **Part 2, its own plan after this merges: credit notes and refunds, and "Issue credit note" and "Refund" on an invoice's row.** These two cannot be split from each other: a customer is only ever in credit because of a credit note (a payment in cannot exceed what is owed), so a refund form cannot be exercised, or smoke-tested, without the credit note form. What part 2 takes, including each review item of 4a that is left to it, is listed under "What part 2 takes" below, so nothing is dropped between the two.

Each part ships something whole and is smoke-tested on its own. After part 1, Credit Notes and Refunds are exactly as they are today, with their "…comes in the next update" lines, which are still true.

## Global Constraints

- **No migration.** No table, view, function, trigger or policy is created or changed. If a task seems to need a database change, stop and report it.
- `org_id` always comes from the server-side context, never from client input.
- One Zod schema per write; messages are sentences a person can act on. This stage adds no schema: `saveQuotationInput` and `quotationIdInput` exist and are already in `tests/finance-schemas.test.ts`.
- A quotation that has been sent cannot be edited or deleted; a draft has no number. A row's menu offers only what the database allows for the row's status.
- Forms are cards closed by default; confirmations happen in the page (`ConfirmRow`), never `window.confirm` or `alert`; viewers and the demo workspace get no buttons and no menus, and every server action checks again, before anything is parsed or read.
- With no Supabase environment the screens show the sample and no actions.
- `src/lib/finance/*.ts` and `src/screens/finance/sales-sample.ts` import nothing server-only (`@/lib/supabase/server`, `next/headers`): client views import types and pure functions from them.
- A `'use server'` file exports only async functions: no constants, no types, no re-exports. Helpers inside it are not exported.
- Vitest runs in node with no DOM: components have no unit tests. Every rule a form or a menu follows is a pure, tested function in `src/lib/finance/`; components only draw.
- Money is shown with `rm()` from `format.ts`. Amounts typed by a person are read with `typedNumber` and never sent as strings; a figure typed with a comma is refused with a sentence.
- What the new form and view must have from the start, as the invoice ones do: while a form is open or an action is pending, row menus are `inert` and the header button is disabled; a refusal shown in a form clears as soon as the person changes anything; every row action asks first; a refused action's message does not outlive its question; Enter inside a line's box does not submit the form; form dates default to the person's own date (`localIsoDate`) while figures use `todayUtc`; a lost response says "We could not confirm that was saved. Reload the page and check the list before trying again." (`useFinanceAction`) and nothing calls `router.refresh()` after a failed response (in Next 16.3 a failed refresh hard-navigates and loses the form); `ConfirmRow`'s confirm button stays focusable while pending so Escape still works; list containers keep `pb-24 sm:pb-24`.
- Supplier Bills, Payments Out, Invoices and Payments In behave as they do today, for everything a person can do on them. The one thing that changes underneath is in Decision 4 (the three Payments Out writes read a view before they write). Of the existing test files, only these are edited, each for a reason given in a decision: `tests/finance-money.test.ts`, `tests/finance-touchups.test.ts`, `tests/finance-quotations.test.ts`, `tests/finance-followon-views.test.ts`, `tests/bendahara-followons.test.ts`. Every other test file passes unedited after every task.
- No purple, violet, indigo or fuchsia anywhere. No Kuasa names in `src/`. Icons from lucide-react only.
- `BentoCard`'s `icon` prop draws through `AnimatedIcon`, which returns nothing for a name that is not in its map. Pass `BentoCard` only these: `FileText`, `Wallet`, `Plus`, `Banknote`, `TrendingUp`, `ChartColumn`, `PieChart`. Icons inside `RowMenu`, `ConfirmRow` and buttons are plain lucide icons and are not limited.
- Radix `SelectItem` throws at runtime for `value=""`. An unchosen `Select` is `value=""` with a `SelectValue placeholder`; every item has a real value (`'all'`, `'draft'`).
- This is Next.js 16.3. No Next API is used here beyond what the invoice screen already uses: an async server component as a screen's default export, `revalidatePath` with a literal path inside the existing `'use server'` actions file, and `next/link`. `Link` is given a `ref` in one place; it passes a `ref` prop on to its `<a>` (`node_modules/next/dist/client/app-dir/link.js`). Nothing uses `useRouter`, `redirect` or `router.push` (Decision 2). If you reach for anything else, read the matching guide in `node_modules/next/dist/docs/` first.
- pnpm only. 2-space indent, single quotes, semicolons, named exports. The only default exports are the screen files under `src/screens/finance/`.
- Every task leaves `pnpm exec tsc --noEmit`, `pnpm lint` and the unit tests green. (In a checkout that has never been built, `tsc` reports `Cannot find name 'LayoutProps'` in `src/app/layout.tsx` until `pnpm exec next typegen` has been run once. That is the checkout, not this plan.)
- **Unit tests are run with `pnpm exec vitest run --exclude 'tests/*.rls.test.ts' --exclude 'tests/bendahara-*.test.ts'`, or with the files named. Never bare `pnpm test`.** The Supabase variables are set in the shell, so `tests/bendahara-*.test.ts` and `tests/*.rls.test.ts` run against the hosted production database and leave a user and a workspace behind on every run. No implementer step runs them. One of them is edited in Task 1 and only type-checked.
- **Implementers never call a database tool, never change the schema, and never start a dev server or a browser.** The production build in Tasks 5 and 6 is run with the Supabase variables emptied on its own command line.
- Branch `feat-119-bendahara-sales-followon-forms` (already cut from main and checked out; work on it, do not create another). PR title equals the branch name. Do not push or merge until the owner says so.

## Not in this stage

- **Credit notes and refunds:** their forms, actions and row menus, "Issue credit note" and "Refund" on an invoice's row, "Refund" on a credit note's row. Part 2.
- **Any migration**, and with it **closing the retry gap** (Decision 8).
- **Editing a quotation after it is sent, and a void for quotations.** Stage 4a's Decision 9: a sent quotation is locked, and one that is no longer wanted is marked declined.
- **Opening the new invoice straight after "Make invoice".** The screen says a draft was made and links to Invoices (Decision 2).
- **Printing, PDF and email.** "Sent" records that the customer has been given the quotation by the person's own means.
- **A setting for how long a quotation is valid.** Thirty days, changed by hand on each quotation (Decision 3).
- **The colour of a draft refund's badge.** Its word is fixed here (Decision 9); `refunds-view.tsx` is rewritten in part 2 and is not touched before.
- Approval of money (stage 5). Managing accounts (stage 6). AI tools for finance.

## Decisions this plan makes (flag to the owner at handoff)

Each is a place where the plan decides something the spec or the brief left open, goes beyond it, or differs from it. Most consequential first.

1. **Stage 4b is two pull requests, and this plan is the first.** The brief allowed for it and gave this split as its example. The reasons are under "Why this is part 1 of 2". The cost: Credit Notes and Refunds stay read-only for one more merge, and the brief's items about them are carried, not done; "What part 2 takes" lists each.
2. **After "Make invoice" the person stays on Quotations and is told where the invoice is; nothing navigates by itself.** The question closes, a card "Draft invoice made" opens at the top of the page with a link to Invoices that takes focus, and the row's Invoice column reads "Draft invoice" and links there too. The alternative was `router.push('/finance/invoices')` after the action answers. It was ruled out because no finance component uses the router today, the plan's code is proved by the type-checker and a build and never by a browser before the production smoke test, and a person converting three accepted quotations in a row is better served by staying. The link goes to the Invoices list, where the draft is dated today; it does not open that draft's form. If the owner prefers landing on Invoices, it is one line in `quotations-view.tsx` and one guide to read first.
3. **A new quotation is valid for thirty days, whatever the customer's payment terms.** The invoice form's due date follows the customer's terms; reusing that for "Valid until" would make a quotation to a cash customer (terms 0) expire the day it is written. The valid-until date follows the quotation date until it is set by hand, as a due date does. Thirty is a constant (`QUOTATION_VALID_DAYS`), not a setting.
4. **The three Payments Out writes now refuse anything that is not a payment to a supplier.** `markPaymentPaid`, `voidPayment` and `deleteScheduledPayment` in `money.ts` read `finance_payments_out` for the workspace and the transaction first, as `refusalUnlessRefund` does for refunds, and answer "That payment no longer exists." without writing when it has no row; the void and the delete also filter on `direction = 'out'`. The app never sends them a refund's id; this closes the direct call. It is a read and then a write, not one statement, which is said in Known limits. It costs one more request on each of those three actions.
5. **Two purchase-side test files are edited, which stage 3b's plan forbade.** Their stand-in clients cannot answer the new read (`limit`). `tests/finance-money.test.ts` moves onto the shared `fakeFinance` and gains six tests; `tests/finance-touchups.test.ts` gains one line. Every sentence those files pin is unchanged.
6. **`voidPaymentIn` is left exactly as it is.** The brief asked whether it needs the same check. It does not: it is kept to `direction = 'in'`; a refund and a payment to a supplier are both money out; and every movement of money in that exists is a payment in. When cash receipts arrive (stage 5), money in will have a second kind and this should be looked at again; that is written into part 2's list.
7. **The quotation's `FIN01` sentence is reworded,** and the 4a test that pinned the old one is replaced. The old sentence ("…Send a draft before it is accepted or declined; a quotation that has been sent can no longer be edited or deleted.") was made true of every case in 4a, but read from a button it is wrong in place: pressing "Mark accepted" on a quotation someone accepted a moment ago answered with advice to send a draft. The new one, "That cannot be done to this quotation as it now stands. It may have been sent, accepted or declined since this page was loaded.", reads sensibly from every button that can meet it and is still not false of a draft answered by a direct call. The table under "What the database allows" gives each button's reachable refusals. The credit note and refund `locked` sentences have the same weakness and are left for part 2, where their buttons are.
8. **The retry-after-lost-response limit is lived with, as in 3b.** Pressing "Save draft" or "Save and mark as sent" again after a lost response can create a second quotation. Closing it needs each write to carry an id the browser made up and the database remembers, which is a column and a migration on every document table, and is better done once for bills, invoices, receipts and quotations together than slipped in here. It matters less for a quotation than for an invoice: a second draft is deleted, and a second sent one is marked declined and is not money owed. "Make invoice" is not affected at all: a quotation has one invoice at a time, so a retry is refused with "This quotation already has an invoice…". Written into Known limits.
9. **Three cheap view fixes are made; one is half made.** The quotations CSV has its columns in the table's order (Total before Valid until). The quotations search also matches the number of the invoice made from a quotation, though not the words "Draft invoice", so that typing "draft" does not return accepted quotations. A refund still being written (`draft`) is worded "Pending", as the filter and the Pending card count it; its badge stays grey until part 2 rewrites that view.
10. **The shared card is changed rather than a quotation card written.** `DocumentFormKind` gains a required `secondDate` (label, get, set) and an optional `words`; `DocumentFormState` stops naming `due_date` and `dueEdited`; the bill and invoice kinds gain one line each. The alternative, a `QuotationForm` with a field called `due_date` holding the valid-until date, would have needed no change to the card and would have been a lie in a type. Bills and invoices read the same words they did; Task 2's tests pin that, and no existing test of either form is edited.
11. **Every row action asks first, in the row, including "Mark accepted" and "Mark declined",** which lose nothing and can be changed back. One reason: the question is where the pending state and a refusal are shown, and a refusal needs a place that does not move. Only Delete is red.
12. **"Save and mark as sent" in the form does not ask first; "Mark as sent" on a row does,** as with Post on an invoice.
13. **The menu says "Make invoice", not "Convert to invoice".** The row menu is 10 rem wide and the longer label would wrap under its icon. The question it opens says what will be made.
14. **Quotation actions refresh Quotations only, and making an invoice refreshes Invoices as well.** Not the six sales screens: no other screen counts or names a quotation, and a draft invoice is not owed. The table under "Which screens each action refreshes" works it out per action, existing actions included.
15. **An expired quotation offers both answers,** and the question before accepting one says it is past its date. **Once an invoice stands for a quotation its menu offers nothing,** rather than offering "Mark declined" and refusing it.
16. **The Invoice column is a link to Invoices for everybody, viewers included.** It changes nothing; it is not a write control.
17. **The live database test is edited without being run.** `tests/bendahara-followons.test.ts` test 3 compared the database's date with this machine's. The edit is type-checked only; the controller runs the file after the merge (smoke step 19).
18. **New tests go in new files** (`finance-document-kind`, `finance-quotation-form`, `finance-quotation-rules`, `finance-quotation-actions`); the existing ones are edited only where they pin something this plan changes on purpose (Decisions 5, 7, 9).

## Review Focus

The cases most likely to bite a person, each pinned by a test in the task that owns the code, or by a line of the controller's smoke list where only a browser can show it.

1. **A draft quotation open in one tab while it is sent or deleted in another.** Expected: Save, Mark as sent, Delete and Edit each answer with a sentence that reads sensibly in place ("…as it now stands. It may have been sent, accepted or declined…", "no longer exists"), what was typed stays, and the list behind shows the quotation as it now is. (Task 1, `tests/finance-quotations.test.ts`: "words FIN01 so that it reads sensibly from every button that can meet it…"; Task 4, `tests/finance-quotation-actions.test.ts`: "refreshes the screens after a refusal too…", "says the quotation can no longer be changed…"; smoke step 12.)
2. **One quotation made into an invoice twice: a double click, two tabs, or a retry after a lost response.** Expected: one invoice; the second attempt reads "This quotation already has an invoice. Void that invoice, or delete it if it is a draft, first."; once the list has refreshed the menu offers nothing. (Task 3, `tests/finance-quotation-rules.test.ts`: "offers nothing once an invoice stands for the quotation, a draft invoice included"; `tests/finance-quotations.test.ts`, unchanged: "words two conversions at the same moment as the quotation having an invoice…"; smoke step 12c.)
3. **A viewer, or anyone in the demo workspace, calling an action directly.** Expected: "You do not have permission to make changes here.", never "That quotation no longer exists.", and nothing parsed or read. (Task 4: "refuses a viewer and the demo workspace on every action, before anything is parsed, read or written", "tells a viewer they may not, not that the quotation is gone".)
4. **A refund's transaction id sent to Mark paid, Void or Delete on Payments Out; and a payment split across three bills voided from its second row.** Expected: the first is refused without a write; the second is voided, because the view is asked for one row and not for exactly one. (Task 1, `tests/finance-money.test.ts`: "is refused without a write…", "asks the view for one row only…"; smoke step 17.)
5. **A price typed as `1,200.50`, an empty price, and a draft whose lines total nothing being marked as sent.** Expected: each is refused with a sentence, in the form before the database is asked, and in the row when the draft was saved first. (Task 3, `tests/finance-quotation-form.test.ts`: "refuses a figure typed with a comma, an empty price and a quantity of nothing", "lets a draft total nothing, but not a quotation that is being marked as sent"; `tests/finance-quotation-rules.test.ts`: "offers the same thing whatever the total…"; smoke step 6.)
6. **A quotation accepted after it expired, an answer corrected back and forth, and a customer with payment terms of 0.** Expected: an expired quotation can still be accepted; a declined one can be accepted and an accepted one declined until an invoice stands; a new quotation to a cash customer is still valid for thirty days. (Task 3: "still lets an expired quotation be answered…", "does not move the valid-until date when a customer is chosen, whatever their payment terms"; smoke steps 9 and 13.)
7. **The bill form and the invoice form after the card under them changed.** Expected: the same words, the same due date behaviour, to the letter. (Task 2, `tests/finance-document-kind.test.ts`, and the unedited `tests/finance-bill-form.test.ts`, `tests/finance-invoice-form.test.ts`, `tests/finance-document-form.test.ts`; smoke step 17.)

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/finance/money.ts` | (modified) `markPaymentPaid`, `voidPayment`, `deleteScheduledPayment` refuse what the payments-out view does not show |
| `src/lib/finance/quotations.ts` | (modified) one sentence; `SaveAndSendQuotationResult` |
| `src/lib/finance/sales-followon-views.ts` | (modified) CSV column order, search by invoice number, one label; `quotationActions`, `quotationName` |
| `src/lib/finance/document-form.ts` | (modified) `DocumentFormState` without the due date; `DocumentFormWords`, `POSTING_WORDS`, `documentFormWords`; `secondDate` and `words` on the kind |
| `src/lib/finance/bill-form.ts`, `src/lib/finance/invoice-form.ts` | (modified) each kind names its second date |
| `src/lib/finance/quotation-form.ts` | The quotation form's rules, `QUOTATION_FORM_KIND` |
| `src/app/(app)/finance/actions.ts` | (modified) eight new actions, two path lists |
| `src/components/finance/document-form-card.tsx` | (modified) draws the second date and the posting words from the kind |
| `src/components/finance/quotation-form-card.tsx` | Thin wrapper: the shared card with the quotation kind |
| `src/components/finance/quotations-view.tsx` | (rewritten) interactive client view |
| `src/screens/finance/quotations.tsx` | (rewritten) loader that passes a `writer` only to people who may edit |
| `src/config/live-screens.ts`, `docs/bendahara-backend.md` | (modified) Quotations is no longer read-only; what changed in money out |
| `tests/finance-document-kind.test.ts`, `tests/finance-quotation-form.test.ts`, `tests/finance-quotation-rules.test.ts`, `tests/finance-quotation-actions.test.ts` | New unit tests |
| `tests/finance-money.test.ts` | (rewritten on the shared stand-in) the payments-out check |
| `tests/finance-touchups.test.ts`, `tests/finance-quotations.test.ts`, `tests/finance-followon-views.test.ts` | (modified) one stand-in line; the pinned sentence; search, CSV order, label |
| `tests/bendahara-followons.test.ts` | (modified, not run) test 3 no longer depends on the clock |

Names used across tasks, spelled once here:

- New in `money.ts`: nothing exported. `refusalUnlessPaymentOut` is private.
- New in `quotations.ts`: `SaveAndSendQuotationResult`. Changed: `QUOTATION_MESSAGES.locked`.
- New in `document-form.ts`: `DocumentFormWords`, `POSTING_WORDS`, `documentFormWords`; `DocumentFormKind['secondDate']`, `DocumentFormKind['words']`.
- From `quotation-form.ts`: `QUOTATION_VALID_DAYS`, `QuotationForm`, `defaultValidUntil`, `newQuotationForm`, `quotationFormFromDetail`, `withQuotationCustomer`, `withQuoteDate`, `withValidUntil`, `withQuotedProduct`, `quotationPayload`, `quotationFormError`, `quotationSavedNotSent`, `QUOTATION_FORM_WORDS`, `QUOTATION_FORM_KIND`.
- New in `sales-followon-views.ts`: `QuotationAction`, `quotationActions`, `quotationName`.
- New actions: `saveQuotationAction`, `sendQuotationAction`, `acceptQuotationAction`, `declineQuotationAction`, `deleteQuotationAction`, `convertQuotationAction`, `saveAndSendQuotationAction`, `getQuotationAction`.
- From `quotation-form-card.tsx`: `QuotationFormCard`, `QuotationFormActions`. From `quotations-view.tsx`: `QuotationsView`, `QuotationActions`, `QuotationsWriter`.
- A quotation row's `display_status` is one of `draft`, `sent`, `accepted`, `declined`, `expired`. `expired` is a sent quotation past its valid-until date; it is worked out by the view and its stored status is `sent`.

## Which screens each action refreshes

An action refreshes every screen whose figures or rows it can move, after any attempt that reached the database, refused or not. Worked out per action; the first two rows are new, the rest are what exists, checked against what stage 4a added.

| Action | What it changes | Refreshes | Why no more |
|---|---|---|---|
| `saveQuotationAction`, `sendQuotationAction`, `saveAndSendQuotationAction`, `acceptQuotationAction`, `declineQuotationAction`, `deleteQuotationAction`; `getQuotationAction` when the draft has gone or is locked | A quotation and its lines, its number, its answer | Quotations | A quotation is not money owed. Invoices, Payments In, Customers & Suppliers (Receivable), Credit Notes and Refunds neither count nor name one |
| `convertQuotationAction` | Adds a draft invoice tied to the quotation | Quotations, Invoices | A draft invoice is in the Invoices table and its "by status" chart, and in the quotation's Invoice column. It is not receivable, so Payments In's form, Receivable, Credit Notes and Refunds do not move |
| Invoice actions (`saveInvoiceAction`, `postInvoiceAction`, `voidInvoiceAction`, `deleteInvoiceAction`, `setEInvoiceAction`, `saveAndPostInvoiceAction`, `getInvoiceAction`) | An invoice | Invoices, Payments In, Customers & Suppliers, Quotations, Credit Notes, Refunds (unchanged) | Already covers what a quotation needs: voiding or deleting the invoice made from a quotation, or changing its customer, frees the quotation, and Quotations is in the list |
| `recordPaymentInAction`, `voidPaymentInAction` | Money in | The same six (unchanged) | A payment changes an invoice's balance, which Refunds' "In credit" card reads |
| Contact actions | A contact's name or flags | The eight screens that show a contact's name: Customers & Suppliers, Supplier Bills, Payments Out, Invoices, Payments In, Quotations, Credit Notes, Refunds (unchanged) | Products shows no contact |
| Bill actions; `recordPaymentOutAction`, `markPaymentPaidAction`, `voidPaymentAction`, `deleteScheduledPaymentAction` | A bill or a payment to a supplier | Supplier Bills, Payments Out, Customers & Suppliers (unchanged) | After Task 1 the last three cannot reach a refund, so they never move a sales screen |
| Product actions | A product | Products (unchanged) | Document lines copy a product's details when it is chosen; they do not follow it |

Payments Out is never refreshed by a sales action, and will not be by a refund action in part 2: `finance_payments_out` joins each allocation to its bill, and a refund has none.

## What the database allows, and the sentence for each refusal

Nothing here is new in the database. For each button, every refusal that can reach a person through it, and the sentence they read. The sentence in bold is the one this plan changes.

| Button | When it can be refused | Code | Sentence |
|---|---|---|---|
| Edit (reads the draft) | The quotation was deleted meanwhile | no row | "That quotation no longer exists." |
| | It was sent meanwhile | (the read finds it is not a draft) | **"That cannot be done to this quotation as it now stands. It may have been sent, accepted or declined since this page was loaded."** |
| Save draft | It was sent meanwhile | `FIN01` | **the same** |
| | It was deleted meanwhile | `FIN11` | "That quotation no longer exists." |
| | The customer or a product was deleted meanwhile | `23503` | "The customer or a product on this quotation no longer exists." |
| | Quantity × unit price does not fit | `22003` | "That amount is too large." |
| Save and mark as sent | Any of Save draft's; then, the draft saved, any of Mark as sent's | as above and below | "The quotation was saved as a draft, but it was not marked as sent. " and that sentence |
| Mark as sent (row) | The draft's lines total nothing | `FIN10` | "A quotation needs at least one line with an amount." |
| | It was sent meanwhile | `FIN01` | **"That cannot be done to this quotation as it now stands…"** |
| | It was deleted meanwhile | `FIN11` | "That quotation no longer exists." |
| Mark accepted, Mark declined | The same answer was recorded meanwhile | `FIN01` | **"That cannot be done to this quotation as it now stands…"** |
| | An invoice was made from it meanwhile | `FIN13` | "This quotation already has an invoice. Void that invoice, or delete it if it is a draft, first." |
| Make invoice | It was made into an invoice meanwhile, or at the same moment | `FIN13`, `23505` | "This quotation already has an invoice. Void that invoice, or delete it if it is a draft, first." |
| | It was marked declined meanwhile | `FIN04` | "Only an accepted quotation can be made into an invoice." |
| Delete | It was sent meanwhile | `FIN01` | **"That cannot be done to this quotation as it now stands…"** |
| | It was deleted meanwhile | no row | "That quotation no longer exists." |
| Save draft, Make invoice | Row-level security refused a new row although the action's own check passed. Not expected: both read the same membership | `42501` | "You do not have permission to make changes here." |
| Any of them, by a viewer or in the demo workspace | The action refuses before the database is asked | none | "You do not have permission to make changes here." |
| Mark paid, Void, Delete on Payments Out | The transaction is not a payment to a supplier in this workspace | none (the view has no row) | "That payment no longer exists." |

A draft can be edited, marked as sent and deleted. A sent quotation, expired or not, can have its answer recorded, and nothing else about it changes. An accepted or declined one can have its answer changed to the other until an invoice that is not void is tied to it; then nothing changes. A quotation is made into an invoice only while it is accepted and has no such invoice.

## What part 2 takes

So that nothing from the brief or from 4a's reviews is lost between the two plans. Part 2 is planned after this merges, against the code as it then is.

- **Credit notes:** new against a posted invoice (one amount, a reason, notes), edit a draft, issue, void, delete a draft; "Save and issue" in one go through `saveThenPost`. A new card: the allocation card does not fit (it ticks many documents for one party and has an account and a method; a credit note is one invoice, one amount and a reason, and moves no money), nor does the document card (no lines).
- **Refunds:** record against an invoice in credit or an issued credit note, paid now or pending; mark a pending one paid; void a paid one; delete a pending one. A new card: the allocation card splits one payment across many documents and has no reason; the database takes exactly one document per refund.
- **Entry points:** "Issue credit note" and "Refund" on an invoice's row, "Refund" on a credit note's row. `invoiceActions` gains them, which changes on purpose what `tests/finance-sales-rules.test.ts` pins for an invoice in credit (`['einvoice', 'void']` today).
- **Caps as pure, tested functions, mirroring `receivableInvoices`:** what an invoice has left to credit (its total less what is credited); what can be refunded on an invoice (what the customer is in credit there, which already nets posted refunds, less refunds still pending against the invoice or against any of its credit notes); and against a credit note, also no more than the note's amount less every refund standing against it, pending or paid. `CreditNoteRow.refunded` counts posted refunds only, so what is pending has to come from the refund rows.
- **Refusals before parsing:** every new action through `run`, with the same two tests this plan has for quotations. A viewer's void or delete of a credit note or a refund must read "You do not have permission…".
- **Refresh paths:** every credit note and refund action refreshes the six sales screens (an invoice's balance moves on Invoices, in the payment-in form's list, in Receivable, and in Refunds' "In credit" card); never Payments Out.
- **Sentences:** `CREDIT_NOTE_MESSAGES.locked` (reached by issuing a note twice from two tabs) and `REFUND_MESSAGES.locked` (voiding a refund twice) are each checked from their buttons, as Decision 7 did for quotations; so are `notInCredit` and `tooMuch`, which end "If this refund is waiting to be paid out, delete it." and are also reached from the new-refund form, where nothing is waiting.
- **The retry limit** for the two new forms: the same decision as 8, unless the owner asks for the migration.
- **Small things:** the grey badge of a draft refund; the two "…comes in the next update" lines; the comment in `src/config/live-screens.ts`; looking at `voidPaymentIn` again if cash receipts have arrived by then.
- **Its smoke list** renders Credit Notes and Refunds with rows the smoke workspace made itself. This plan's smoke list renders all three with the demo workspace's seeded rows (step 1), which is the first time any of them is seen in a browser with rows.

---

### Task 1: Data-layer touch-ups: money out kept to supplier payments, one sentence, three small view fixes

Nothing a person can do changes yet. Payments Out's three writes stop accepting any transaction id; the quotation `FIN01` sentence is made to read sensibly from each button that will reach it; the quotations CSV and search, and one refund label, are put right; a live database test stops depending on the clock.

**Files:**
- Modify: `src/lib/finance/money.ts`
- Modify: `src/lib/finance/quotations.ts`
- Modify: `src/lib/finance/sales-followon-views.ts`
- Replace: `tests/finance-money.test.ts`
- Modify: `tests/finance-touchups.test.ts` (one line of its stand-in client)
- Modify: `tests/finance-quotations.test.ts`
- Modify: `tests/finance-followon-views.test.ts`
- Modify: `tests/bendahara-followons.test.ts` (edited and type-checked; **never run by an implementer**)

**Interfaces:**
- Consumes: `FinanceWriteContext`, `FinResult` from `@/lib/finance/result`; `fakeFinance`, `FinanceAnswer`, `FinanceCall` from `tests/setup/fake-finance.ts`; the view `finance_payments_out` (columns `org_id`, `transaction_id`), already live.
- Produces:
  - `markPaymentPaid`, `voidPayment`, `deleteScheduledPayment` in `@/lib/finance/money`: same signatures and answers as before. Each now reads `finance_payments_out` first and answers `{ ok: false, error: 'That payment no longer exists.' }`, writing nothing, when the view has no row for that transaction in the workspace. `voidPayment` and `deleteScheduledPayment` also filter on `direction = 'out'`.
  - `QUOTATION_MESSAGES.locked` in `@/lib/finance/quotations` is now `'That cannot be done to this quotation as it now stands. It may have been sent, accepted or declined since this page was loaded.'`
  - `export type SaveAndSendQuotationResult = FinResult<{ id: string; quotation_no: string }> & { draftId?: string }` in `@/lib/finance/quotations`.
  - `filterQuotations` also matches the number of the invoice made from a quotation. `quotationsCsv` has its columns in the table's order: `No., Date, Customer, Total, Valid until, Status, Invoice`. `REFUND_STATUS_LABELS.draft` is `'Pending'`.

Why each change is safe:

- `finance_payments_out` joins every allocation to its bill, so it shows payments to suppliers and nothing else: a refund (money out against an invoice or a credit note) is never in it. The app never sends a refund's id to these three functions, and after this change a direct call to `markPaymentPaidAction`, `voidPaymentAction` or `deleteScheduledPaymentAction` cannot reach one either. The check costs one extra read per write.
- The read uses `.limit(1)`: a payment split across three bills is three rows in the view, and `.maybeSingle()` would fail on it.
- The view has no filter on status (`supabase/migrations/20261013100000_bendahara_money.sql`, `where t.direction = 'out'` and nothing more, and no later migration replaces it): a scheduled payment, a paid one and a void one are all in it. That is what makes it safe to ask it before marking a *scheduled* payment paid and before deleting one. No unit test can show this, since each stands in for the view; the controller's smoke step 17 marks a scheduled payment paid, voids it and deletes another on the hosted database, and is the proof.
- When the check itself is refused (a database error), the answer is worded by the same map as the write's own refusals, so a viewer still reads "You do not have permission…".
- The stand-in clients in two purchase-side test files have no `limit`, so those files are edited (Decision 5). `tests/finance-money.test.ts` moves onto the shared `fakeFinance`, which records the view read; `tests/finance-touchups.test.ts` gains one line.

- [ ] **Step 1: Write the failing tests for money out**

Replace the whole of `tests/finance-money.test.ts` with:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deleteScheduledPayment,
  markPaymentPaid,
  recordPaymentOut,
  recordPaymentOutInput,
  voidPayment,
} from '@/lib/finance/money';
import { type FinanceAnswer, type FinanceCall, fakeFinance } from './setup/fake-finance';

const TXN = '55555555-5555-4555-8555-555555555555';
const ACCOUNT = '66666666-6666-4666-8666-666666666666';
const BILL_1 = '77777777-7777-4777-8777-777777777777';
const BILL_2 = '88888888-8888-4888-8888-888888888888';

/** The shared stand-in for the Supabase client. One canned answer is given to every request, the payments-out check included. */
const fakeClient = (answer: FinanceAnswer) => fakeFinance(answer);

/**
 * Answers the payments-out check with a row (a payment to a supplier) or none
 * (a refund, or any other money out), and everything else with `other`.
 */
const paymentOr = (isPaymentOut: boolean, other: FinanceAnswer) => (call: FinanceCall) =>
  call.name === 'finance_payments_out' ? { data: isPaymentOut ? [{ transaction_id: TXN }] : [], error: null } : other;

const valid = {
  account_id: ACCOUNT,
  txn_date: '2026-10-05',
  method: 'fpx' as const,
  allocations: [{ bill_id: BILL_1, amount: 100 }],
};

let logged: ReturnType<typeof vi.spyOn>;
beforeEach(() => { logged = vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { logged.mockRestore(); });

const first = (value: unknown) => recordPaymentOutInput.safeParse(value).error?.issues[0]?.message;

describe('recordPaymentOutInput', () => {
  it('asks for an account, a real date and a known method', () => {
    expect(first({ ...valid, account_id: '' })).toBe('Choose the account the money leaves.');
    expect(first({ ...valid, txn_date: '5 Oct' })).toBe('Enter a valid date.');
    expect(first({ ...valid, method: 'barter' })).toBe('Choose how it was paid.');
  });
  it('asks for at least one bill, each once, each with an amount above 0', () => {
    expect(first({ ...valid, allocations: [] })).toBe('Choose at least one bill to pay.');
    expect(first({ ...valid, allocations: [{ bill_id: BILL_1, amount: 0 }] })).toBe('Enter an amount above 0.');
    expect(first({ ...valid, allocations: [{ bill_id: BILL_1, amount: 1 }, { bill_id: BILL_1, amount: 2 }] }))
      .toBe('Each bill can appear once on a payment.');
  });
  it('rounds amounts to two decimals and defaults to a payment made now', () => {
    const parsed = recordPaymentOutInput.parse({ ...valid, reference: ' ', allocations: [{ bill_id: BILL_1, amount: 32.506 }] });
    expect(parsed).toMatchObject({ scheduled: false, reference: null, notes: null });
    expect(parsed.allocations).toEqual([{ bill_id: BILL_1, amount: 32.51 }]);
  });
});

describe('recordPaymentOutInput rounding', () => {
  it('refuses an amount that rounds to 0 and rounds a half cent up', () => {
    expect(first({ ...valid, allocations: [{ bill_id: BILL_1, amount: 0.004 }] })).toBe('Enter an amount above 0.');
    expect(recordPaymentOutInput.parse({ ...valid, allocations: [{ bill_id: BILL_1, amount: 0.005 }] }).allocations)
      .toEqual([{ bill_id: BILL_1, amount: 0.01 }]);
  });
});

describe('payment writes', () => {
  it('records through the database function, in the caller’s workspace', async () => {
    const { ctx, calls } = fakeClient({ data: TXN, error: null });
    const result = await recordPaymentOut(ctx, {
      ...valid,
      allocations: [{ bill_id: BILL_1, amount: 100 }, { bill_id: BILL_2, amount: 32.5 }],
    });
    expect(result).toEqual({ ok: true, data: { id: TXN } });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ kind: 'rpc', name: 'finance_record_payment_out' });
    expect(calls[0].args).toEqual({
      target_org: 'org-1',
      payment: { account_id: ACCOUNT, txn_date: '2026-10-05', method: 'fpx', reference: null, notes: null, status: 'posted' },
      allocations: [{ bill_id: BILL_1, amount: 100 }, { bill_id: BILL_2, amount: 32.5 }],
    });
  });
  it('sends a scheduled payment as scheduled', async () => {
    const { ctx, calls } = fakeClient({ data: TXN, error: null });
    await recordPaymentOut(ctx, { ...valid, scheduled: true });
    expect((calls[0].args!.payment as { status: string }).status).toBe('scheduled');
  });
  it('marks a scheduled payment paid and returns its number, once the payments-out view has shown it', async () => {
    const { ctx, calls } = fakeFinance(paymentOr(true, { data: 'PV-0003', error: null }));
    expect(await markPaymentPaid(ctx, { id: TXN, paid_on: '2026-10-09' })).toEqual({ ok: true, data: { id: TXN, number: 'PV-0003' } });
    expect(calls[0]).toMatchObject({
      name: 'finance_payments_out', op: 'select', filters: { org_id: 'org-1', transaction_id: TXN }, limit: 1,
    });
    expect(calls[0].columns).toBe('transaction_id');
    expect(calls[1]).toMatchObject({ kind: 'rpc', name: 'finance_mark_payment_paid' });
    expect(calls[1].args).toEqual({ target_org: 'org-1', target_txn: TXN, paid_on: '2026-10-09' });
    expect(calls).toHaveLength(2);
  });
  it('voids by setting the status and deletes a scheduled payment, both kept to money out and to the workspace', async () => {
    const voided = fakeFinance(paymentOr(true, { data: { id: TXN }, error: null }));
    expect(await voidPayment(voided.ctx, { id: TXN })).toEqual({ ok: true, data: { id: TXN } });
    expect(voided.calls[0]).toMatchObject({ name: 'finance_payments_out', filters: { org_id: 'org-1', transaction_id: TXN } });
    expect(voided.calls[1]).toMatchObject({ name: 'finance_transactions', op: 'update' });
    expect(Object.keys(voided.calls[1].values!).sort()).toEqual(['status', 'updated_at']);
    expect(voided.calls[1].values).toMatchObject({ status: 'void' });
    expect(voided.calls[1].filters).toEqual({ id: TXN, org_id: 'org-1', direction: 'out' });

    const removed = fakeFinance(paymentOr(true, { data: { id: TXN }, error: null }));
    expect(await deleteScheduledPayment(removed.ctx, { id: TXN })).toEqual({ ok: true, data: { id: TXN } });
    expect(removed.calls[0]).toMatchObject({ name: 'finance_payments_out', filters: { org_id: 'org-1', transaction_id: TXN } });
    expect(removed.calls[1]).toMatchObject({ name: 'finance_transactions', op: 'delete' });
    expect(removed.calls[1].filters).toEqual({ id: TXN, org_id: 'org-1', direction: 'out' });
  });
  it('turns each database refusal into a sentence', async () => {
    const cases: [string, string][] = [
      ['FIN03', 'The amounts against the bills add up to more than the payment.'],
      ['FIN04', 'A payment can only go against a posted bill.'],
      ['FIN05', 'That is more than is still owed on a bill.'],
      ['FIN06', 'One payment can only pay bills from one supplier.'],
      ['FIN09', 'This payment is posted and can no longer be changed. Void it instead.'],
      ['FIN11', 'That payment no longer exists.'],
      ['23503', 'The account or a bill on this payment no longer exists.'],
    ];
    for (const [code, message] of cases) {
      // The view has shown the payment; the write itself is what the database refuses.
      const { ctx } = fakeFinance(paymentOr(true, { data: null, error: { code } }));
      expect(await recordPaymentOut(ctx, valid), code).toEqual({ ok: false, error: message });
      expect(await markPaymentPaid(ctx, { id: TXN, paid_on: '2026-10-09' }), code).toEqual({ ok: false, error: message });
      expect(await voidPayment(ctx, { id: TXN }), code).toEqual({ ok: false, error: message });
      expect(await deleteScheduledPayment(ctx, { id: TXN }), code).toEqual({ ok: false, error: message });
    }
    expect(logged).not.toHaveBeenCalled();
  });
  it('says the payment is gone when void or delete touches no row', async () => {
    const { ctx } = fakeFinance(paymentOr(true, { data: null, error: null }));
    expect(await voidPayment(ctx, { id: TXN })).toEqual({ ok: false, error: 'That payment no longer exists.' });
    expect(await deleteScheduledPayment(ctx, { id: TXN })).toEqual({ ok: false, error: 'That payment no longer exists.' });
  });
});

describe('money out that is not a payment to a supplier', () => {
  const gone = { ok: false, error: 'That payment no longer exists.' };

  it('is refused without a write: a refund’s id marks nothing paid, voids nothing and deletes nothing', async () => {
    // The payments-out view joins each allocation to its bill, so a refund is never in it.
    const marked = fakeFinance(paymentOr(false, { data: 'PV-0007', error: null }));
    expect(await markPaymentPaid(marked.ctx, { id: TXN, paid_on: '2026-10-09' })).toEqual(gone);
    expect(marked.calls.map((c) => c.kind)).toEqual(['table']);
    expect(marked.calls.map((c) => c.name)).toEqual(['finance_payments_out']);

    const voided = fakeFinance(paymentOr(false, { data: { id: TXN }, error: null }));
    expect(await voidPayment(voided.ctx, { id: TXN })).toEqual(gone);
    expect(voided.calls.map((c) => c.name)).toEqual(['finance_payments_out']);
    expect(voided.calls.map((c) => c.op)).toEqual(['select']);

    const removed = fakeFinance(paymentOr(false, { data: { id: TXN }, error: null }));
    expect(await deleteScheduledPayment(removed.ctx, { id: TXN })).toEqual(gone);
    expect(removed.calls.map((c) => c.name)).toEqual(['finance_payments_out']);
    expect(removed.calls.map((c) => c.op)).toEqual(['select']);
  });
  it('is refused the same way when the view answers with nothing at all', async () => {
    const empty = (call: FinanceCall) => (call.name === 'finance_payments_out' ? { data: null, error: null } : { data: { id: TXN }, error: null });
    const { ctx, calls } = fakeFinance(empty);
    expect(await voidPayment(ctx, { id: TXN })).toEqual(gone);
    expect(calls).toHaveLength(1);
  });
  it('asks the view for one row only: a payment split across bills is several rows there', async () => {
    const split = (call: FinanceCall) =>
      call.name === 'finance_payments_out' ? { data: [{ transaction_id: TXN }], error: null } : { data: { id: TXN }, error: null };
    const { ctx, calls } = fakeFinance(split);
    expect(await voidPayment(ctx, { id: TXN })).toEqual({ ok: true, data: { id: TXN } });
    expect(calls[0].limit).toBe(1);
  });
  it('logs and gives the general message when the check cannot be read, and writes nothing', async () => {
    const failing = (call: FinanceCall) =>
      call.name === 'finance_payments_out' ? { data: null, error: { code: 'XX000' } } : { data: { id: TXN }, error: null };
    const general = { ok: false, error: 'That change could not be saved. Please try again.' };
    const { ctx, calls } = fakeFinance(failing);
    expect(await markPaymentPaid(ctx, { id: TXN, paid_on: '2026-10-09' })).toEqual(general);
    expect(await voidPayment(ctx, { id: TXN })).toEqual(general);
    expect(await deleteScheduledPayment(ctx, { id: TXN })).toEqual(general);
    expect(calls.every((c) => c.name === 'finance_payments_out')).toBe(true);
    expect(logged).toHaveBeenCalled();
  });
  it('tells a viewer they may not when row-level security refuses the check itself', async () => {
    const { ctx } = fakeFinance({ data: null, error: { code: '42501' } });
    expect(await voidPayment(ctx, { id: TXN })).toEqual({ ok: false, error: 'You do not have permission to make changes here.' });
  });
  it('still refuses an id that is not an id before anything is asked', async () => {
    const { ctx, calls } = fakeFinance(paymentOr(true, { data: { id: TXN }, error: null }));
    await expect(voidPayment(ctx, { id: 'nope' })).rejects.toThrow();
    await expect(deleteScheduledPayment(ctx, { id: 'nope' })).rejects.toThrow();
    await expect(markPaymentPaid(ctx, { id: 'nope', paid_on: '2026-10-09' })).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});
```

In `tests/finance-touchups.test.ts`, replace:

```ts
    eq: () => builder,
    order: () => builder,
    maybeSingle: async () => answer,
```

with:

```ts
    eq: () => builder,
    order: () => builder,
    // The payment writes ask the payments-out view for one row before they write.
    limit: () => builder,
    maybeSingle: async () => answer,
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run tests/finance-money.test.ts tests/finance-touchups.test.ts`
Expected: FAIL, six tests of sixteen in `tests/finance-money.test.ts`: "marks a scheduled payment paid and returns its number, once the payments-out view has shown it" (the first request is the database function, not the view), "voids by setting the status and deletes a scheduled payment, both kept to money out and to the workspace", and four under "money out that is not a payment to a supplier" ("is refused without a write…", "is refused the same way when the view answers with nothing at all", "asks the view for one row only…", "logs and gives the general message when the check cannot be read…"). `tests/finance-touchups.test.ts` passes: its stand-in answers every request alike.

- [ ] **Step 3: Keep the three writes to payments to suppliers**

In `src/lib/finance/money.ts`, replace:

```ts
/* ---- writes ----------------------------------------------------------- */

/** Records a payment out, paid now or scheduled, split across one supplier's bills. */
```

with:

```ts
/**
 * The transaction must be a payment to a supplier: money out against a bill,
 * which the payments-out view shows. A refund is money out too, and it is
 * never in that view, which joins each allocation to its bill. The three
 * writes below ask the view first and refuse anything it does not show,
 * without writing. A refund has its own writes, in refunds.ts, which ask the
 * refunds view the same way. One row is asked for: a payment split across
 * bills is several rows there.
 */
async function refusalUnlessPaymentOut(
  ctx: FinanceWriteContext,
  fnName: string,
  txnId: string,
): Promise<{ ok: false; error: string } | null> {
  const { data, error } = await ctx.client
    .from('finance_payments_out')
    .select('transaction_id')
    .eq('org_id', ctx.orgId)
    .eq('transaction_id', txnId)
    .limit(1);
  if (error) return moneyWriteFailed(fnName, error);
  if (!data || data.length === 0) return { ok: false, error: M.gone };
  return null;
}

/* ---- writes ----------------------------------------------------------- */

/** Records a payment out, paid now or scheduled, split across one supplier's bills. */
```

In `src/lib/finance/money.ts`, replace:

```ts
  const { id: txnId, paid_on } = markPaymentPaidInput.parse(input);
  const { data, error } = await ctx.client.rpc('finance_mark_payment_paid', {
```

with:

```ts
  const { id: txnId, paid_on } = markPaymentPaidInput.parse(input);
  const refusal = await refusalUnlessPaymentOut(ctx, 'markPaymentPaid', txnId);
  if (refusal) return refusal;
  const { data, error } = await ctx.client.rpc('finance_mark_payment_paid', {
```

In `src/lib/finance/money.ts`, replace:

```ts
/**
 * Voids a posted payment out: one status change on finance_transactions. The
 * bills it paid owe that amount again.
 */
export async function voidPayment(
  ctx: FinanceWriteContext,
  input: z.input<typeof paymentIdInput>,
): Promise<FinResult<{ id: string }>> {
  const { id: txnId } = paymentIdInput.parse(input);
  const { data, error } = await ctx.client
    .from('finance_transactions')
    .update({ status: 'void', updated_at: new Date().toISOString() })
    .eq('id', txnId)
    .eq('org_id', ctx.orgId)
    .select('id')
    .maybeSingle();
  if (error) return moneyWriteFailed('voidPayment', error);
  if (!data) return { ok: false, error: M.gone };
  return { ok: true, data: { id: data.id } };
}
```

with:

```ts
/**
 * Voids a posted payment to a supplier: one status change on
 * finance_transactions, kept to money out. The bills it paid owe that amount
 * again. Anything the payments-out view does not show is refused first.
 */
export async function voidPayment(
  ctx: FinanceWriteContext,
  input: z.input<typeof paymentIdInput>,
): Promise<FinResult<{ id: string }>> {
  const { id: txnId } = paymentIdInput.parse(input);
  const refusal = await refusalUnlessPaymentOut(ctx, 'voidPayment', txnId);
  if (refusal) return refusal;
  const { data, error } = await ctx.client
    .from('finance_transactions')
    .update({ status: 'void', updated_at: new Date().toISOString() })
    .eq('id', txnId)
    .eq('org_id', ctx.orgId)
    .eq('direction', 'out')
    .select('id')
    .maybeSingle();
  if (error) return moneyWriteFailed('voidPayment', error);
  if (!data) return { ok: false, error: M.gone };
  return { ok: true, data: { id: data.id } };
}
```

In `src/lib/finance/money.ts`, replace:

```ts
/** Deletes a payment that has not been made yet. A paid one is refused: void it. */
export async function deleteScheduledPayment(
  ctx: FinanceWriteContext,
  input: z.input<typeof paymentIdInput>,
): Promise<FinResult<{ id: string }>> {
  const { id: txnId } = paymentIdInput.parse(input);
  const { data, error } = await ctx.client
    .from('finance_transactions')
    .delete()
    .eq('id', txnId)
    .eq('org_id', ctx.orgId)
    .select('id')
    .maybeSingle();
```

with:

```ts
/**
 * Deletes a payment to a supplier that has not been made yet. A paid one is
 * refused: void it. Anything the payments-out view does not show is refused
 * first.
 */
export async function deleteScheduledPayment(
  ctx: FinanceWriteContext,
  input: z.input<typeof paymentIdInput>,
): Promise<FinResult<{ id: string }>> {
  const { id: txnId } = paymentIdInput.parse(input);
  const refusal = await refusalUnlessPaymentOut(ctx, 'deleteScheduledPayment', txnId);
  if (refusal) return refusal;
  const { data, error } = await ctx.client
    .from('finance_transactions')
    .delete()
    .eq('id', txnId)
    .eq('org_id', ctx.orgId)
    .eq('direction', 'out')
    .select('id')
    .maybeSingle();
```

`voidPaymentIn` is not changed: it is already kept to `direction = 'in'`, a refund and a payment to a supplier are both money out, and every movement of money in that exists is a payment in (Decision 6).

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm exec vitest run tests/finance-money.test.ts tests/finance-touchups.test.ts tests/finance-sales-data.test.ts tests/finance-actions.test.ts tests/finance-refunds.test.ts`
Expected: PASS, all five files.

- [ ] **Step 5: Write the failing tests for the quotation sentence and the three view fixes**

In `tests/finance-quotations.test.ts`, replace:

```ts
  it('does not say a quotation was sent or answered when a draft is accepted or declined (FIN01)', async () => {
    const { ctx } = fakeFinance({ data: null, error: { code: 'FIN01' } });
    for (const result of [await acceptQuotation(ctx, { id: ID }), await declineQuotation(ctx, { id: ID })]) {
      expect(result).toMatchObject({ ok: false });
      if (!result.ok) {
        expect(result.error).toContain('Send a draft before it is accepted or declined');
        expect(result.error).not.toContain('already been sent or answered');
      }
    }
  });
```

with:

```ts
  it('words FIN01 so that it reads sensibly from every button that can meet it, and claims nothing false (FIN01)', async () => {
    const { ctx } = fakeFinance({ data: null, error: { code: 'FIN01' } });
    const sentence =
      'That cannot be done to this quotation as it now stands. It may have been sent, accepted or declined since this page was loaded.';
    // Through the app it is met only when the quotation changed in another tab: Save, Mark as sent or Delete
    // on a draft that has been sent meanwhile; Mark accepted on one already accepted; Mark declined on one
    // already declined. Only a direct call can answer a draft, and the sentence is not false of that either.
    for (const result of [
      await saveQuotation(ctx, { ...valid, id: ID }),
      await sendQuotation(ctx, { id: ID }),
      await acceptQuotation(ctx, { id: ID }),
      await declineQuotation(ctx, { id: ID }),
      await deleteQuotation(ctx, { id: ID }),
    ]) {
      expect(result).toEqual({ ok: false, error: sentence });
    }
    // It does not say what happened, only what may have: a draft answered by a direct call was never sent.
    expect(sentence).not.toContain('already been sent or answered');
    expect(sentence).not.toContain('has been sent');
    // It does not tell a person looking at an accepted quotation to send a draft.
    expect(sentence).not.toContain('Send a draft');
  });
```

In `tests/finance-quotations.test.ts`, replace:

```ts
      ['FIN01', 'That cannot be done to this quotation as it stands. Send a draft before it is accepted or declined; a quotation that has been sent can no longer be edited or deleted.'],
```

with:

```ts
      ['FIN01', 'That cannot be done to this quotation as it now stands. It may have been sent, accepted or declined since this page was loaded.'],
```

In `tests/finance-followon-views.test.ts`, replace:

```ts
  it('does not match a draft on the word null', () => {
    expect(filterQuotations(rows, 'null', 'all')).toEqual([]);
  });
```

with:

```ts
  it('does not match a draft on the word null', () => {
    expect(filterQuotations(rows, 'null', 'all')).toEqual([]);
  });
  it('searches the Invoice column too: the number of the invoice made from a quotation', () => {
    const converted = [...rows, quotation({ quotation_no: 'QT-0230', display_status: 'accepted', invoice_id: 'i1', invoice_no: 'INV-0044' })];
    expect(filterQuotations(converted, 'inv-0044', 'all').map((q) => q.quotation_no)).toEqual(['QT-0230']);
    expect(filterQuotations(converted, ' INV ', 'all')).toHaveLength(1);
    expect(filterQuotations(converted, 'inv-0044', 'sent')).toEqual([]);
    // A draft invoice has no number yet: its quotation is not matched on "draft", nor on the word null.
    const drafted = [quotation({ quotation_no: 'QT-0231', display_status: 'accepted', invoice_id: 'i2', invoice_no: null })];
    expect(filterQuotations(drafted, 'draft', 'all')).toEqual([]);
    expect(filterQuotations(drafted, 'null', 'all')).toEqual([]);
  });
```

In `tests/finance-followon-views.test.ts`, replace:

```ts
    expect(csv).toBe(
      '﻿No.,Date,Customer,Valid until,Total,Status,Invoice\r\n' +
        "QT-0007,2026-10-01,'=cmd|calc,2026-10-31,1250.5,Accepted,INV-0044\r\n" +
        ',2026-10-01,"Lim, Tan & Co",2026-10-31,80,Draft,\r\n',
    );
```

with:

```ts
    // The columns are in the order the table shows them: Total before Valid until.
    expect(csv).toBe(
      '﻿No.,Date,Customer,Total,Valid until,Status,Invoice\r\n' +
        "QT-0007,2026-10-01,'=cmd|calc,1250.5,2026-10-31,Accepted,INV-0044\r\n" +
        ',2026-10-01,"Lim, Tan & Co",80,2026-10-31,Draft,\r\n',
    );
```

(The first character inside the quotes of the header line is the invisible byte-order mark the file already has there. Change the column order only; leave that character where it is.)

In `tests/finance-followon-views.test.ts`, replace:

```ts
  it('words scheduled as Pending and posted as Refunded', () => {
    expect(REFUND_STATUS_LABELS).toMatchObject({ scheduled: 'Pending', posted: 'Refunded', void: 'Void' });
  });
```

with:

```ts
  it('words scheduled as Pending and posted as Refunded', () => {
    expect(REFUND_STATUS_LABELS).toMatchObject({ scheduled: 'Pending', posted: 'Refunded', void: 'Void' });
  });
  it('words a refund that is still being written as Pending, since the Pending filter and the Pending card count it', () => {
    const draft = refund({ status: 'draft', number: null });
    expect(isPendingRefund(draft)).toBe(true);
    expect(filterRefunds([draft], '', 'pending')).toHaveLength(1);
    expect(REFUND_STATUS_LABELS.draft).toBe('Pending');
    expect(refundsCsv([draft])).toContain(',Pending\r\n');
  });
```

- [ ] **Step 6: Run them to see them fail**

Run: `pnpm exec vitest run tests/finance-quotations.test.ts tests/finance-followon-views.test.ts`
Expected: FAIL, five tests: "words FIN01 so that it reads sensibly…" and "turns each database refusal into a sentence" in the first file; "searches the Invoice column too…", "writes the table as CSV, with a formula-looking customer name made harmless and a draft’s number empty" and "words a refund that is still being written as Pending…" in the second.

- [ ] **Step 7: The quotation sentence, and the answer to "Save and mark as sent"**

In `src/lib/finance/quotations.ts`, replace:

```ts
  // FIN01. A menu offers only what a quotation's status allows, so this reaches a person only when the
  // quotation changed under them in another tab. True of both cases: a draft accepted or declined, and a
  // quotation already sent, accepted or declined being edited or deleted.
  locked:
    'That cannot be done to this quotation as it stands. Send a draft before it is accepted or declined; a quotation that has been sent can no longer be edited or deleted.',
```

with:

```ts
  // FIN01. A menu offers only what a quotation's status allows, so this reaches a person only when the
  // quotation changed under them in another tab: a draft that was sent meanwhile being saved, sent or
  // deleted, or an answer being recorded that is already the answer. It says what may have happened, not
  // what did, so it is not false of a draft answered by a direct call either; the list behind the message
  // has been refreshed and shows the quotation as it is.
  locked:
    'That cannot be done to this quotation as it now stands. It may have been sent, accepted or declined since this page was loaded.',
```

In `src/lib/finance/quotations.ts`, replace:

```ts
export type QuotationDetail = QuotationListRow & {
  subtotal: number;
  sst: number;
  notes: string | null;
  lines: QuotationLine[];
};
```

with:

```ts
export type QuotationDetail = QuotationListRow & {
  subtotal: number;
  sst: number;
  notes: string | null;
  lines: QuotationLine[];
};

/**
 * The answer to "Save and mark as sent". When the draft was saved but sending
 * it was refused, `draftId` is that draft, so the form goes on editing it
 * instead of saving a second copy.
 */
export type SaveAndSendQuotationResult = FinResult<{ id: string; quotation_no: string }> & { draftId?: string };
```

- [ ] **Step 8: The three view fixes**

In `src/lib/finance/sales-followon-views.ts`, replace:

```ts
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
```

with:

```ts
/**
 * Quotations matching the status and customer filters whose number, customer
 * or invoice number contains the search text. The invoice is the one made
 * from the quotation; while that is a draft it has no number to match.
 */
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
      `${row.quotation_no ?? ''} ${row.customer_name} ${row.invoice_no ?? ''}`.toLowerCase().includes(q),
  );
}
```

In `src/lib/finance/sales-followon-views.ts`, replace:

```ts
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
```

with:

```ts
/** The quotations table as a CSV file, its columns in the table's order. The total is a number, so a spreadsheet can add it up. */
export function quotationsCsv(rows: QuotationListRow[]): string {
  return toCsv(
    ['No.', 'Date', 'Customer', 'Total', 'Valid until', 'Status', 'Invoice'],
    rows.map((q) => [
      q.quotation_no,
      q.quote_date,
      q.customer_name,
      q.total,
      q.valid_until,
      QUOTATION_STATUS_LABELS[q.display_status],
      quotationInvoice(q),
    ]),
  );
}
```

In `src/lib/finance/sales-followon-views.ts`, replace:

```ts
/** A refund is a payment out: scheduled reads "Pending" here and posted reads "Refunded". */
export const REFUND_STATUS_LABELS: Record<RefundRow['status'], string> = {
  draft: 'Draft',
```

with:

```ts
/**
 * A refund is a payment out: scheduled reads "Pending" here and posted reads
 * "Refunded". One still being written (`draft`) is counted as pending by the
 * filter and the Pending card, so it reads "Pending" too.
 */
export const REFUND_STATUS_LABELS: Record<RefundRow['status'], string> = {
  draft: 'Pending',
```

- [ ] **Step 9: Run them to see them pass**

Run: `pnpm exec vitest run tests/finance-quotations.test.ts tests/finance-followon-views.test.ts`
Expected: PASS, both files.

- [ ] **Step 10: Take the clock out of the live conversion test**

`tests/bendahara-followons.test.ts` runs against the hosted database and is never run by an implementer. Its third test compares the invoice a conversion makes, dated by the database's `current_date` (UTC), with this machine's own idea of today; run within a moment of midnight UTC the two differ. The edit below reads the day before and after the call and checks the due date from the row that came back. Only `pnpm exec tsc --noEmit` checks this edit here; the controller runs the file after the merge.

In `tests/bendahara-followons.test.ts`, replace:

```ts
function daysFromToday(days: number) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
```

with:

```ts
function daysFromToday(days: number) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The YYYY-MM-DD date `days` after another. */
function daysAfter(iso: string, days: number) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
```

In `tests/bendahara-followons.test.ts`, replace:

```ts
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
```

with:

```ts
  const dayBefore = daysFromToday(0);
  const converted = await a.c.rpc('finance_convert_quotation', { target_org: a.orgId, target_quotation: quotation.id });
  expect(converted.error, converted.error?.message).toBeNull();
  const dayAfter = daysFromToday(0);
  const { data: invoice } = await a.c
    .from('finance_invoices')
    .select('status, customer_id, quotation_id, invoice_no, invoice_date, due_date')
    .eq('id', converted.data)
    .single();
  // The invoice is dated by the database's UTC date at the moment it converted. Across midnight UTC that
  // is one of the two days this machine saw either side of the call, so neither is assumed.
  expect([dayBefore, dayAfter]).toContain(invoice!.invoice_date);
  // The customer's payment terms are 14 days, counted from the invoice's own date.
  expect(invoice).toEqual({
    status: 'draft', customer_id: a.customer, quotation_id: quotation.id, invoice_no: null,
    invoice_date: invoice!.invoice_date, due_date: daysAfter(invoice!.invoice_date, 14),
  });
```

- [ ] **Step 11: Type-check, lint, and run the unit tests**

Run, as separate commands: `pnpm exec tsc --noEmit`, `pnpm lint`, `pnpm exec vitest run --exclude 'tests/*.rls.test.ts' --exclude 'tests/bendahara-*.test.ts'`
Expected: no type errors; no lint errors (the one warning about `_p` in `tests/apply-proposal.test.ts` was there before); every unit test passes, 3,678 in all (3,670 on `main` when this plan was written).

- [ ] **Step 12: Commit**

```bash
git add src/lib/finance/money.ts src/lib/finance/quotations.ts src/lib/finance/sales-followon-views.ts tests/finance-money.test.ts tests/finance-touchups.test.ts tests/finance-quotations.test.ts tests/finance-followon-views.test.ts tests/bendahara-followons.test.ts
git commit -m "fix: keep payments-out writes to supplier payments; quotation sentence and view fixes"
```

---

### Task 2: The shared document card can draw a quotation

A refactor. Nothing a person can see changes on Supplier Bills or Invoices: the card still says "Due date", "Save and post" and "A draft: it gets its number when it is posted" for both. Two things that the card had fixed become part of the kind, so that Task 3 can describe a quotation, whose second date is "Valid until" and which is marked as sent rather than posted.

**Files:**
- Modify: `src/lib/finance/document-form.ts`
- Modify: `src/lib/finance/bill-form.ts`
- Modify: `src/lib/finance/invoice-form.ts`
- Modify: `src/components/finance/document-form-card.tsx`
- Create: `tests/finance-document-kind.test.ts`

**Interfaces:**
- Consumes: `withDueDate`, `LineDraft`, `DocumentParty` from `@/lib/finance/document-form`; `BILL_FORM_KIND`, `INVOICE_FORM_KIND` and the two forms' own functions.
- Produces, all in `@/lib/finance/document-form`:
  - `type DocumentFormState = { id?: string; notes: string; lines: LineDraft[] }`. It no longer names `due_date` and `dueEdited`: a form's second date is reached through its kind. `BillForm` and `InvoiceForm` keep both fields.
  - `type DocumentFormWords = { newSubtitle: string; draftSubtitle: string; post: string; posting: string }`
  - `const POSTING_WORDS: DocumentFormWords` (the four strings the card has always shown)
  - `function documentFormWords(kind: { words?: DocumentFormWords }): DocumentFormWords`
  - `DocumentFormKind<F>` gains `secondDate: { label: string; get: (form: F) => string; set: (form: F, value: string) => F }` (required) and `words?: DocumentFormWords` (optional). `noun` becomes `'bill' | 'invoice' | 'quotation'`.
  - `BILL_FORM_KIND.secondDate` and `INVOICE_FORM_KIND.secondDate` are `{ label: 'Due date', get: (form) => form.due_date, set: withDueDate }`. Neither has `words`.
- `DocumentFormCard`'s props do not change. `BillFormCard`, `InvoiceFormCard`, `bills-view.tsx` and `invoices-view.tsx` are not edited.

`savedAsDraft(noun, error)` keeps its `'bill' | 'invoice'` parameter: it says "posted", which is not a quotation's word, so the quotation form brings its own sentence in Task 3.

- [ ] **Step 1: Write the failing tests**

Create `tests/finance-document-kind.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { BILL_FORM_KIND, newBillForm, withSupplier } from '@/lib/finance/bill-form';
import { POSTING_WORDS, documentFormWords, withDueDate } from '@/lib/finance/document-form';
import { INVOICE_FORM_KIND, newInvoiceForm, withCustomer } from '@/lib/finance/invoice-form';

const today = '2026-10-11';

describe('the second date of a document form', () => {
  it('is the due date on a bill: read from the form, and set by hand through withDueDate', () => {
    const bill = withSupplier(newBillForm(today, 'k1'), { id: 'lim', payment_terms_days: 30 });
    expect(BILL_FORM_KIND.secondDate.label).toBe('Due date');
    expect(BILL_FORM_KIND.secondDate.get(bill)).toBe('2026-11-10');
    expect(BILL_FORM_KIND.secondDate.set).toBe(withDueDate);
    expect(BILL_FORM_KIND.secondDate.set(bill, '2026-12-01')).toEqual({ ...bill, due_date: '2026-12-01', dueEdited: true });
  });
  it('is the due date on an invoice, the same way', () => {
    const invoice = withCustomer(newInvoiceForm(today, 'k1'), { id: 'aisyah', payment_terms_days: 14 });
    expect(INVOICE_FORM_KIND.secondDate.label).toBe('Due date');
    expect(INVOICE_FORM_KIND.secondDate.get(invoice)).toBe('2026-10-25');
    expect(INVOICE_FORM_KIND.secondDate.set).toBe(withDueDate);
    expect(INVOICE_FORM_KIND.secondDate.set(invoice, '2026-12-01')).toEqual({ ...invoice, due_date: '2026-12-01', dueEdited: true });
  });
  it('stops following the date once it is set through the card, as it always did', () => {
    const invoice = INVOICE_FORM_KIND.secondDate.set(newInvoiceForm(today, 'k1'), '2026-12-01');
    expect(INVOICE_FORM_KIND.withDate(invoice, '2026-10-20', 14).due_date).toBe('2026-12-01');
    const bill = BILL_FORM_KIND.secondDate.set(newBillForm(today, 'k1'), '2026-12-01');
    expect(BILL_FORM_KIND.withDate(bill, '2026-10-20', 30).due_date).toBe('2026-12-01');
  });
});

describe('the words of a document form', () => {
  it('are the posting words on a bill and an invoice, exactly as the card has always said them', () => {
    expect(BILL_FORM_KIND.words).toBeUndefined();
    expect(INVOICE_FORM_KIND.words).toBeUndefined();
    expect(documentFormWords(BILL_FORM_KIND)).toBe(POSTING_WORDS);
    expect(documentFormWords(INVOICE_FORM_KIND)).toEqual({
      newSubtitle: 'Saved as a draft until it is posted',
      draftSubtitle: 'A draft: it gets its number when it is posted',
      post: 'Save and post',
      posting: 'Posting…',
    });
  });
  it('are a kind’s own words when it has them', () => {
    const words = { newSubtitle: 'a', draftSubtitle: 'b', post: 'c', posting: 'd' };
    expect(documentFormWords({ words })).toBe(words);
    expect(documentFormWords({})).toBe(POSTING_WORDS);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run tests/finance-document-kind.test.ts`
Expected: FAIL: `POSTING_WORDS` and `documentFormWords` are not exported from `@/lib/finance/document-form`, and `secondDate` is not on either kind.

- [ ] **Step 3: The kind describes its second date and its words**

In `src/lib/finance/document-form.ts`, replace:

```ts
/** What every document form holds, whatever it calls its party and its date. */
export type DocumentFormState = {
  /** Present when a saved draft is being changed. */
  id?: string;
  due_date: string;
  /** Once the person sets the due date by hand, it is no longer recalculated. */
  dueEdited: boolean;
  notes: string;
  lines: LineDraft[];
};
```

with:

```ts
/**
 * What every document form holds, whatever it calls its party and its dates.
 * The second date (a due date, or a quotation's valid-until date) is not
 * named here: the card reads and sets it through the kind's `secondDate`.
 */
export type DocumentFormState = {
  /** Present when a saved draft is being changed. */
  id?: string;
  notes: string;
  lines: LineDraft[];
};

/** The words of the card that differ between a document that is posted and one that is marked as sent. */
export type DocumentFormWords = {
  /** Under the title of a new document. */
  newSubtitle: string;
  /** Under the title of a draft being changed. */
  draftSubtitle: string;
  /** The second button: save the draft and take the next step in one go. */
  post: string;
  /** That button while it is working. */
  posting: string;
};

/** What the card says for a bill or an invoice. */
export const POSTING_WORDS: DocumentFormWords = {
  newSubtitle: 'Saved as a draft until it is posted',
  draftSubtitle: 'A draft: it gets its number when it is posted',
  post: 'Save and post',
  posting: 'Posting…',
};

/** A kind's own words, or the posting words when it has none. */
export function documentFormWords(kind: { words?: DocumentFormWords }): DocumentFormWords {
  return kind.words ?? POSTING_WORDS;
}
```

In `src/lib/finance/document-form.ts`, replace:

```ts
/**
 * One kind of document form, for the shared card: its words, and its rules as
 * the functions of its own module (`bill-form.ts`, `invoice-form.ts`), which
 * are what the tests pin.
 */
export type DocumentFormKind<F extends DocumentFormState> = {
  noun: 'bill' | 'invoice';
  party: 'supplier' | 'customer';
  dateLabel: string;
  partyId: (form: F) => string;
  date: (form: F) => string;
  withParty: (form: F, party: { id: string; payment_terms_days: number }) => F;
  withDate: (form: F, date: string, termsDays: number | undefined) => F;
```

with:

```ts
/**
 * One kind of document form, for the shared card: its words, and its rules as
 * the functions of its own module (`bill-form.ts`, `invoice-form.ts`,
 * `quotation-form.ts`), which are what the tests pin.
 */
export type DocumentFormKind<F extends DocumentFormState> = {
  noun: 'bill' | 'invoice' | 'quotation';
  party: 'supplier' | 'customer';
  dateLabel: string;
  partyId: (form: F) => string;
  date: (form: F) => string;
  withParty: (form: F, party: { id: string; payment_terms_days: number }) => F;
  withDate: (form: F, date: string, termsDays: number | undefined) => F;
  /** The second date box: when a bill or an invoice is due, or until when a quotation is valid. */
  secondDate: { label: string; get: (form: F) => string; set: (form: F, value: string) => F };
  /** Present when the document is not posted but marked as sent. Absent, the card uses `POSTING_WORDS`. */
  words?: DocumentFormWords;
```

In `src/lib/finance/bill-form.ts`, replace:

```ts
  savedAsDraft,
} from './document-form';
import type { FinanceProduct } from './products';
```

with:

```ts
  savedAsDraft,
  withDueDate,
} from './document-form';
import type { FinanceProduct } from './products';
```

(The line `export { type LineDraft, defaultDueDate, emptyLine, lineNumbers, withDueDate } from './document-form';` below it stays as it is: the purchase-side tests import those names from this module.)

In `src/lib/finance/bill-form.ts`, replace:

```ts
  withParty: withSupplier,
  withDate: withBillDate,
  reference: {
```

with:

```ts
  withParty: withSupplier,
  withDate: withBillDate,
  secondDate: { label: 'Due date', get: (form) => form.due_date, set: withDueDate },
  reference: {
```

In `src/lib/finance/invoice-form.ts`, replace:

```ts
  savedAsDraft,
} from './document-form';
```

with:

```ts
  savedAsDraft,
  withDueDate,
} from './document-form';
```

In `src/lib/finance/invoice-form.ts`, replace:

```ts
  withParty: withCustomer,
  withDate: withInvoiceDate,
  withProduct: withSoldProduct,
```

with:

```ts
  withParty: withCustomer,
  withDate: withInvoiceDate,
  secondDate: { label: 'Due date', get: (form) => form.due_date, set: withDueDate },
  withProduct: withSoldProduct,
```

- [ ] **Step 4: The card draws what the kind describes**

Six edits to `src/components/finance/document-form-card.tsx`. After them the card holds no word and no field name of its own for the second date or the posting step.

In `src/components/finance/document-form-card.tsx`, replace:

```tsx
import { type DocumentFormKind, type DocumentFormState, type DocumentParty, withDueDate } from '@/lib/finance/document-form';
```

with:

```tsx
import { type DocumentFormKind, type DocumentFormState, type DocumentParty, documentFormWords } from '@/lib/finance/document-form';
```

In `src/components/finance/document-form-card.tsx`, replace:

```tsx
/**
 * A new bill or invoice, or a draft being changed. Saved as a draft, or saved
 * and posted in one go. `kind` says which document it is and carries its
 * rules, which are in src/lib/finance/bill-form.ts and invoice-form.ts.
 */
```

with:

```tsx
/**
 * A new bill, invoice or quotation, or a draft being changed. Saved as a
 * draft, or saved and posted (a quotation: marked as sent) in one go. `kind`
 * says which document it is and carries its words and its rules, which are in
 * src/lib/finance/bill-form.ts, invoice-form.ts and quotation-form.ts.
 */
```

In `src/components/finance/document-form-card.tsx`, replace:

```tsx
  const { noun, party, reference } = kind;
```

with:

```tsx
  const { noun, party, reference, secondDate } = kind;
  const words = documentFormWords(kind);
```

In `src/components/finance/document-form-card.tsx`, replace:

```tsx
  const subtitle = form.id ? 'A draft: it gets its number when it is posted' : 'Saved as a draft until it is posted';
```

with:

```tsx
  const subtitle = form.id ? words.draftSubtitle : words.newSubtitle;
```

In `src/components/finance/document-form-card.tsx`, replace:

```tsx
          <Label htmlFor={`${id}-due`}>Due date</Label>
          <Input
            id={`${id}-due`}
            type="date"
            value={form.due_date}
            min={kind.date(form) || undefined}
            required
            onChange={(e) => edit((f) => withDueDate(f, e.target.value))}
          />
```

with:

```tsx
          <Label htmlFor={`${id}-due`}>{secondDate.label}</Label>
          <Input
            id={`${id}-due`}
            type="date"
            value={secondDate.get(form)}
            min={kind.date(form) || undefined}
            required
            onChange={(e) => edit((f) => secondDate.set(f, e.target.value))}
          />
```

In `src/components/finance/document-form-card.tsx`, replace:

```tsx
            {save.pending && posting ? 'Posting…' : 'Save and post'}
```

with:

```tsx
            {save.pending && posting ? words.posting : words.post}
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `pnpm exec vitest run tests/finance-document-kind.test.ts tests/finance-document-form.test.ts tests/finance-bill-form.test.ts tests/finance-invoice-form.test.ts`
Expected: PASS, all four files. The three that existed before are not edited.

- [ ] **Step 6: Check that the card kept its words**

Run: `grep -n -E "Due date|Save and post|Posting…|it is posted" src/components/finance/document-form-card.tsx`
Expected: no output. Each of those strings now comes from `POSTING_WORDS` or a kind's `secondDate.label`.

Run: `grep -c -E "'Due date'" src/lib/finance/bill-form.ts src/lib/finance/invoice-form.ts`
Expected: two lines, one for each file, each ending `:1`.

- [ ] **Step 7: Type-check, lint, and run the unit tests**

Run, as separate commands: `pnpm exec tsc --noEmit`, `pnpm lint`, `pnpm exec vitest run --exclude 'tests/*.rls.test.ts' --exclude 'tests/bendahara-*.test.ts'`
Expected: no type errors (this is what proves `bill-form-card.tsx`, `invoice-form-card.tsx` and the two views still fit the card); no lint errors; every unit test passes, 3,683 in all.

- [ ] **Step 8: Commit**

```bash
git add src/lib/finance/document-form.ts src/lib/finance/bill-form.ts src/lib/finance/invoice-form.ts src/components/finance/document-form-card.tsx tests/finance-document-kind.test.ts
git commit -m "refactor: the document card takes its second date and its posting words from the kind"
```

---

### Task 3: The rules of the quotation form and of a quotation's row menu

Pure functions and their tests. No component and no action yet.

**Files:**
- Create: `src/lib/finance/quotation-form.ts`
- Modify: `src/lib/finance/sales-followon-views.ts`
- Create: `tests/finance-quotation-form.test.ts`
- Create: `tests/finance-quotation-rules.test.ts`

**Interfaces:**
- Consumes: `addDaysIso`, `billTotals` from `@/lib/finance/bill-math`; `DocumentFormKind`, `DocumentFormWords`, `LineDraft`, `emptyLine`, `filledFromProduct`, `lineDraft`, `lineNumbers`, `linePayload`, `documentFormWords` from `@/lib/finance/document-form` (Task 2); `isIsoDate` from `@/lib/finance/document-lines`; `QUOTATION_MESSAGES`, `QuotationDetail`, `QuotationListRow`, `saveQuotationInput` from `@/lib/finance/quotations`; `FinanceProduct` from `@/lib/finance/products`; `WRITE_FAILED` from `@/lib/finance/result`.
- Produces, in `@/lib/finance/quotation-form`:
  - `const QUOTATION_VALID_DAYS = 30`
  - `type QuotationForm = { id?: string; customer_id: string; quote_date: string; valid_until: string; validEdited: boolean; notes: string; lines: LineDraft[] }`
  - `defaultValidUntil(quoteDate: string): string`
  - `newQuotationForm(today: string, lineKey: string): QuotationForm`
  - `quotationFormFromDetail(quotation: QuotationDetail): QuotationForm`
  - `withQuotationCustomer(form: QuotationForm, customer: { id: string }): QuotationForm`
  - `withQuoteDate(form: QuotationForm, quoteDate: string): QuotationForm`
  - `withValidUntil(form: QuotationForm, validUntil: string): QuotationForm`
  - `withQuotedProduct(line: LineDraft, product: FinanceProduct | null): LineDraft`
  - `quotationPayload(form: QuotationForm)`: what `saveQuotationInput` takes
  - `quotationFormError(form: QuotationForm, sending?: boolean): string | null`
  - `quotationSavedNotSent(error: string): string`
  - `const QUOTATION_FORM_WORDS: DocumentFormWords`
  - `const QUOTATION_FORM_KIND: DocumentFormKind<QuotationForm>`
- Produces, in `@/lib/finance/sales-followon-views`:
  - `type QuotationAction = 'edit' | 'send' | 'delete' | 'accept' | 'decline' | 'convert'`
  - `quotationActions(row: QuotationListRow): QuotationAction[]`
  - `quotationName(row: QuotationListRow): string`

What the menu offers, and why. It is what the guard `private.finance_quotation_guard()` and the three functions allow for each status, and nothing they would refuse:

| The row reads | Offered, in order | Not offered, and the refusal it would meet |
|---|---|---|
| Draft | Edit, Mark as sent, Delete | Accept, Decline (`FIN01`: a quotation is sent before it is answered); Make invoice (`FIN04`) |
| Sent | Mark accepted, Mark declined | Edit, Delete, Mark as sent (`FIN01`: locked); Make invoice (`FIN04`: not accepted) |
| Expired (sent, past its date) | Mark accepted, Mark declined | The same. Accepting late is allowed: the stored status is `sent` |
| Accepted, no invoice | Make invoice, Mark declined | Mark accepted again (`FIN01`); Edit, Delete (`FIN01`) |
| Accepted, an invoice stands (draft or posted) | nothing | Make invoice and Mark declined (`FIN13`) |
| Declined | Mark accepted | Make invoice (`FIN04`); Mark declined again (`FIN01`) |

"Mark as sent" is offered on a draft whatever its total. A draft whose lines total nothing is refused when sent, with "A quotation needs at least one line with an amount." (`FIN10`), as Post is on an invoice.

- [ ] **Step 1: Write the failing tests**

Create `tests/finance-quotation-form.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { documentFormWords, emptyLine } from '@/lib/finance/document-form';
import type { FinanceProduct } from '@/lib/finance/products';
import {
  QUOTATION_FORM_KIND,
  QUOTATION_FORM_WORDS,
  QUOTATION_VALID_DAYS,
  type QuotationForm,
  defaultValidUntil,
  newQuotationForm,
  quotationFormError,
  quotationFormFromDetail,
  quotationPayload,
  quotationSavedNotSent,
  withQuotationCustomer,
  withQuoteDate,
  withQuotedProduct,
  withValidUntil,
} from '@/lib/finance/quotation-form';
import { type QuotationDetail, saveQuotationInput } from '@/lib/finance/quotations';
import { WRITE_FAILED } from '@/lib/finance/result';

const CUSTOMER = '44444444-4444-4444-8444-444444444444';
const PRODUCT = '99999999-9999-4999-8999-999999999999';
const today = '2026-10-11';

const gloves: FinanceProduct = {
  id: PRODUCT, sku: 'GLV', name: 'Gloves', type: 'product', category: null, uom: 'box', price: 24.9, cost: 12.5, sst_rate: 6, active: true,
};

/** A form a person has filled in: a customer and one line of 10 × 12.50. */
const filled = (form: Partial<QuotationForm> = {}): QuotationForm => ({
  ...withQuotationCustomer(newQuotationForm(today, 'k1'), { id: CUSTOMER }),
  lines: [{ ...emptyLine('k1'), description: 'Design work', quantity: '10', unit_price: '12.5' }],
  ...form,
});

describe('a new quotation form', () => {
  it('is dated today, valid for thirty days, with one empty line and no customer', () => {
    expect(QUOTATION_VALID_DAYS).toBe(30);
    expect(newQuotationForm(today, 'k1')).toEqual({
      customer_id: '',
      quote_date: '2026-10-11',
      valid_until: '2026-11-10',
      validEdited: false,
      notes: '',
      lines: [emptyLine('k1')],
    });
    expect(defaultValidUntil('2026-01-31')).toBe('2026-03-02');
  });
  it('does not move the valid-until date when a customer is chosen, whatever their payment terms', () => {
    const form = newQuotationForm(today, 'k1');
    const chosen = QUOTATION_FORM_KIND.withParty(form, { id: CUSTOMER, payment_terms_days: 90 });
    expect(chosen).toEqual({ ...form, customer_id: CUSTOMER });
  });
});

describe('the valid-until date', () => {
  it('follows the quotation date until it is set by hand', () => {
    const moved = withQuoteDate(newQuotationForm(today, 'k1'), '2026-12-01');
    expect([moved.quote_date, moved.valid_until]).toEqual(['2026-12-01', '2026-12-31']);
    const byHand = withValidUntil(moved, '2026-12-15');
    expect(byHand).toMatchObject({ valid_until: '2026-12-15', validEdited: true });
    expect(withQuoteDate(byHand, '2027-01-05')).toMatchObject({ quote_date: '2027-01-05', valid_until: '2026-12-15' });
  });
  it('stays where it was while the quotation date is half typed or emptied', () => {
    const form = newQuotationForm(today, 'k1');
    expect(withQuoteDate(form, '').valid_until).toBe('2026-11-10');
    expect(withQuoteDate(form, '2026-1').valid_until).toBe('2026-11-10');
    expect(withQuoteDate(form, '2026-02-30').valid_until).toBe('2026-11-10');
  });
  it('is kept as it was saved when a draft is opened, and no longer follows the date', () => {
    const detail: QuotationDetail = {
      id: '33333333-3333-4333-8333-333333333333', quotation_no: null, customer_id: CUSTOMER, customer_name: 'Aisyah Trading',
      quote_date: '2026-10-01', valid_until: '2026-10-08', total: 132.5, display_status: 'draft', accepted_on: null,
      invoice_id: null, invoice_no: null, subtotal: 125, sst: 7.5, notes: null,
      lines: [{ id: 'line-1', product_id: null, description: 'Design work', quantity: 10, uom: null, pack_size: 'box of 4', unit_price: 12.5, sst_rate: 6, amount: 125, sst_amount: 7.5 }],
    };
    const form = quotationFormFromDetail(detail);
    expect(form).toEqual({
      id: detail.id, customer_id: CUSTOMER, quote_date: '2026-10-01', valid_until: '2026-10-08', validEdited: true, notes: '',
      lines: [{ key: 'line-1', product_id: '', description: 'Design work', quantity: '10', uom: '', pack_size: 'box of 4', unit_price: '12.5', sst_rate: '6' }],
    });
    expect(withQuoteDate(form, '2026-10-05').valid_until).toBe('2026-10-08');
  });
});

describe('what the quotation form sends', () => {
  it('is what saveQuotationInput takes, with figures as numbers and the id only when a draft is being changed', () => {
    expect(quotationPayload(filled({ notes: ' Valid 30 days ' }))).toEqual({
      customer_id: CUSTOMER,
      quote_date: '2026-10-11',
      valid_until: '2026-11-10',
      notes: ' Valid 30 days ',
      lines: [{ product_id: '', description: 'Design work', uom: '', pack_size: '', quantity: 10, unit_price: 12.5, sst_rate: 0 }],
    });
    expect(quotationPayload(filled())).not.toHaveProperty('id');
    expect(quotationPayload(filled({ id: 'abc' }))).toMatchObject({ id: 'abc' });
    expect(saveQuotationInput.safeParse(quotationPayload(filled())).success).toBe(true);
  });
  it('never sends what only the form knows: whether the date was set by hand, and each line’s key', () => {
    const sent = JSON.stringify(quotationPayload(filled()));
    expect(sent).not.toContain('validEdited');
    expect(sent).not.toContain('"key"');
  });
  it('fills a line from a product at its price, not its cost', () => {
    expect(withQuotedProduct(emptyLine('k1'), gloves)).toMatchObject({
      product_id: PRODUCT, description: 'Gloves', uom: 'box', unit_price: '24.9', sst_rate: '6', quantity: '1',
    });
    expect(withQuotedProduct({ ...emptyLine('k1'), product_id: PRODUCT, description: 'Gloves' }, null)).toMatchObject({
      product_id: '', description: 'Gloves',
    });
  });
});

describe('what is wrong with a quotation form', () => {
  it('says so in the schema’s own sentences, the first thing first', () => {
    expect(quotationFormError(filled())).toBeNull();
    expect(quotationFormError(filled({ customer_id: '' }))).toBe('Choose a customer.');
    expect(quotationFormError(filled({ quote_date: '' }))).toBe('Enter a valid date.');
    expect(quotationFormError(filled({ valid_until: '2026-10-10' }))).toBe('The valid-until date cannot be before the quotation date.');
    expect(quotationFormError(filled({ lines: [] }))).toBe('Add at least one line.');
    expect(quotationFormError(filled({ lines: [{ ...emptyLine('k1'), quantity: '1', unit_price: '5' }] }))).toBe('Describe each line.');
    expect(quotationFormError(filled({ notes: 'x'.repeat(201) }))).toBe('That is too long. Keep it to 200 characters or fewer.');
  });
  it('refuses a figure typed with a comma, an empty price and a quantity of nothing', () => {
    const line = (l: Partial<ReturnType<typeof emptyLine>>) => filled({ lines: [{ ...emptyLine('k1'), description: 'Design work', ...l }] });
    expect(quotationFormError(line({ quantity: '1', unit_price: '1,200.50' }))).toBe('Enter a unit price of 0 or more.');
    expect(quotationFormError(line({ quantity: '1', unit_price: '' }))).toBe('Enter a unit price of 0 or more.');
    expect(quotationFormError(line({ quantity: '0', unit_price: '5' }))).toBe('Enter a quantity above 0.');
    expect(quotationFormError(line({ quantity: '1', unit_price: '5', sst_rate: '101' }))).toBe('Enter an SST rate between 0 and 100.');
  });
  it('lets a draft total nothing, but not a quotation that is being marked as sent', () => {
    const free = filled({ lines: [{ ...emptyLine('k1'), description: 'Sample pack', quantity: '1', unit_price: '0' }] });
    expect(quotationFormError(free)).toBeNull();
    expect(quotationFormError(free, true)).toBe('A quotation needs at least one line with an amount.');
    expect(quotationFormError(filled(), true)).toBeNull();
  });
  it('accepts a quotation valid only on its own date', () => {
    expect(quotationFormError(filled({ valid_until: today }))).toBeNull();
  });
});

describe('saved, but not marked as sent', () => {
  it('says the draft is safe and passes on the database’s sentence', () => {
    expect(quotationSavedNotSent('A quotation needs at least one line with an amount.')).toBe(
      'The quotation was saved as a draft, but it was not marked as sent. A quotation needs at least one line with an amount.',
    );
  });
  it('does not say "could not be saved" about a quotation that was saved', () => {
    expect(quotationSavedNotSent(WRITE_FAILED)).toBe('The quotation was saved as a draft, but marking it as sent failed. Please try again.');
  });
});

describe('the quotation form, as the shared card draws it', () => {
  it('is the quotation form’s own rules, not a second set', () => {
    expect(QUOTATION_FORM_KIND.withParty).toBe(withQuotationCustomer);
    expect(QUOTATION_FORM_KIND.withDate).toBe(withQuoteDate);
    expect(QUOTATION_FORM_KIND.withProduct).toBe(withQuotedProduct);
    expect(QUOTATION_FORM_KIND.error).toBe(quotationFormError);
    expect(QUOTATION_FORM_KIND.payload).toBe(quotationPayload);
    expect(QUOTATION_FORM_KIND.savedNotPosted).toBe(quotationSavedNotSent);
    expect(QUOTATION_FORM_KIND.secondDate.set).toBe(withValidUntil);
    expect(QUOTATION_FORM_KIND.reference).toBeUndefined();
  });
  it('says customer and quotation, and calls its second date Valid until', () => {
    expect([QUOTATION_FORM_KIND.noun, QUOTATION_FORM_KIND.party, QUOTATION_FORM_KIND.dateLabel]).toEqual([
      'quotation', 'customer', 'Quotation date',
    ]);
    expect(QUOTATION_FORM_KIND.secondDate.label).toBe('Valid until');
    expect(QUOTATION_FORM_KIND.partyId(filled())).toBe(CUSTOMER);
    expect(QUOTATION_FORM_KIND.date(filled())).toBe(today);
    expect(QUOTATION_FORM_KIND.secondDate.get(filled())).toBe('2026-11-10');
  });
  it('is marked as sent, never posted, in every word the card shows', () => {
    const words = documentFormWords(QUOTATION_FORM_KIND);
    expect(words).toBe(QUOTATION_FORM_WORDS);
    expect(words).toEqual({
      newSubtitle: 'Saved as a draft until it is marked as sent',
      draftSubtitle: 'A draft: it gets its number when it is marked as sent',
      post: 'Save and mark as sent',
      posting: 'Marking as sent…',
    });
    expect(Object.values(words).join(' ').toLowerCase()).not.toContain('post');
  });
  it('ignores the customer’s payment terms when the date changes', () => {
    expect(QUOTATION_FORM_KIND.withDate(newQuotationForm(today, 'k1'), '2026-12-01', 90).valid_until).toBe('2026-12-31');
  });
});
```

Create `tests/finance-quotation-rules.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { QuotationDisplayStatus, QuotationListRow } from '@/lib/finance/quotations';
import { type QuotationAction, quotationActions, quotationName } from '@/lib/finance/sales-followon-views';

const quotation = (display_status: QuotationDisplayStatus, q: Partial<QuotationListRow> = {}): QuotationListRow => ({
  id: `quotation-${display_status}`,
  quotation_no: display_status === 'draft' ? null : 'QT-0007',
  customer_id: 'aisyah',
  customer_name: 'Aisyah Trading',
  quote_date: '2026-10-01',
  valid_until: '2026-10-31',
  total: 132.5,
  display_status,
  accepted_on: display_status === 'accepted' ? '2026-10-08' : null,
  invoice_id: null,
  invoice_no: null,
  ...q,
});

describe('quotationActions', () => {
  it('lets a draft be edited, marked as sent or deleted, and never answered or made into an invoice', () => {
    expect(quotationActions(quotation('draft'))).toEqual(['edit', 'send', 'delete']);
  });
  it('lets a sent quotation be answered either way, and nothing else: it is locked', () => {
    expect(quotationActions(quotation('sent'))).toEqual(['accept', 'decline']);
  });
  it('still lets an expired quotation be answered: accepting it late is the seller’s call', () => {
    expect(quotationActions(quotation('expired'))).toEqual(['accept', 'decline']);
  });
  it('lets an accepted quotation be made into an invoice, or the answer be corrected', () => {
    expect(quotationActions(quotation('accepted'))).toEqual(['convert', 'decline']);
  });
  it('lets a declined quotation be corrected to accepted, and not made into an invoice', () => {
    expect(quotationActions(quotation('declined'))).toEqual(['accept']);
  });
  it('offers nothing once an invoice stands for the quotation, a draft invoice included', () => {
    expect(quotationActions(quotation('accepted', { invoice_id: 'i1', invoice_no: 'INV-0044' }))).toEqual([]);
    expect(quotationActions(quotation('accepted', { invoice_id: 'i1', invoice_no: null }))).toEqual([]);
    // The database never leaves these standing; if one is met, nothing is offered that it would refuse.
    expect(quotationActions(quotation('declined', { invoice_id: 'i1' }))).toEqual([]);
    expect(quotationActions(quotation('sent', { invoice_id: 'i1' }))).toEqual([]);
  });
  it('never offers editing or deleting once a quotation has its number', () => {
    for (const status of ['sent', 'expired', 'accepted', 'declined'] as const) {
      const offered: QuotationAction[] = quotationActions(quotation(status));
      expect(offered, status).not.toContain('edit');
      expect(offered, status).not.toContain('delete');
      expect(offered, status).not.toContain('send');
    }
  });
  it('offers the same thing whatever the total: a draft of nothing is refused with a sentence when it is sent', () => {
    expect(quotationActions(quotation('draft', { total: 0 }))).toEqual(['edit', 'send', 'delete']);
  });
});

describe('quotationName', () => {
  it('names a quotation by its number and customer, and a draft as the draft', () => {
    expect(quotationName(quotation('sent'))).toBe('QT-0007 to Aisyah Trading');
    expect(quotationName(quotation('draft'))).toBe('the draft quotation to Aisyah Trading');
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run tests/finance-quotation-form.test.ts tests/finance-quotation-rules.test.ts`
Expected: FAIL, both files: `@/lib/finance/quotation-form` does not exist, and `quotationActions` and `quotationName` are not exported from `@/lib/finance/sales-followon-views`.

- [ ] **Step 3: Write the quotation form's rules**

Create `src/lib/finance/quotation-form.ts`:

```ts
/**
 * The quotation form's rules, kept out of the components so they can be
 * tested: what a new form holds, what choosing a customer, a date or a
 * product changes, what is wrong with the form, and what is sent to
 * saveQuotationAction. Pure. What a bill and an invoice form share with it is
 * in document-form.ts.
 */
import { addDaysIso, billTotals } from './bill-math';
import {
  type DocumentFormKind,
  type DocumentFormWords,
  type LineDraft,
  emptyLine,
  filledFromProduct,
  lineDraft,
  lineNumbers,
  linePayload,
} from './document-form';
import { isIsoDate } from './document-lines';
import type { FinanceProduct } from './products';
import { QUOTATION_MESSAGES, type QuotationDetail, saveQuotationInput } from './quotations';
import { WRITE_FAILED } from './result';

/** How long a new quotation is valid for, until the person says otherwise. */
export const QUOTATION_VALID_DAYS = 30;

export type QuotationForm = {
  /** Present when a saved draft is being changed. */
  id?: string;
  customer_id: string;
  quote_date: string;
  valid_until: string;
  /** Once the person sets the valid-until date by hand, it no longer follows the quotation date. */
  validEdited: boolean;
  notes: string;
  lines: LineDraft[];
};

/** The quotation date plus thirty days. A customer's payment terms say when an invoice is due, not how long a price holds. */
export function defaultValidUntil(quoteDate: string): string {
  return addDaysIso(quoteDate, QUOTATION_VALID_DAYS);
}

/** A new quotation dated today, valid for thirty days, with one empty line. */
export function newQuotationForm(today: string, lineKey: string): QuotationForm {
  return {
    customer_id: '',
    quote_date: today,
    valid_until: defaultValidUntil(today),
    validEdited: false,
    notes: '',
    lines: [emptyLine(lineKey)],
  };
}

/** A saved draft, as the form shows it. Its valid-until date was chosen already, so it is kept. */
export function quotationFormFromDetail(quotation: QuotationDetail): QuotationForm {
  return {
    id: quotation.id,
    customer_id: quotation.customer_id,
    quote_date: quotation.quote_date,
    valid_until: quotation.valid_until,
    validEdited: true,
    notes: quotation.notes ?? '',
    lines: quotation.lines.map(lineDraft),
  };
}

/** Choosing a customer changes nothing else: how long the quotation is valid does not depend on who it is for. */
export function withQuotationCustomer(form: QuotationForm, customer: { id: string }): QuotationForm {
  return { ...form, customer_id: customer.id };
}

/**
 * Changing the quotation date moves the valid-until date with it, unless it
 * was set by hand. While the quotation date is half typed the valid-until
 * date stays where it was.
 */
export function withQuoteDate(form: QuotationForm, quoteDate: string): QuotationForm {
  return {
    ...form,
    quote_date: quoteDate,
    valid_until: !form.validEdited && isIsoDate(quoteDate) ? defaultValidUntil(quoteDate) : form.valid_until,
  };
}

/** Once the person sets the valid-until date by hand, it is no longer recalculated. */
export function withValidUntil(form: QuotationForm, validUntil: string): QuotationForm {
  return { ...form, valid_until: validUntil, validEdited: true };
}

/**
 * Choosing a product fills the line from it: its name, unit, price (what the
 * workspace sells it for) and SST rate, as on an invoice. The person can then
 * change any of them. Choosing "no product" only clears the link.
 */
export function withQuotedProduct(line: LineDraft, product: FinanceProduct | null): LineDraft {
  return filledFromProduct(line, product, product?.price ?? 0);
}

/** What is sent to saveQuotationAction. Figures are numbers; a box that is not a number goes as NaN and is refused. */
export function quotationPayload(form: QuotationForm) {
  return {
    ...(form.id ? { id: form.id } : {}),
    customer_id: form.customer_id,
    quote_date: form.quote_date,
    valid_until: form.valid_until,
    notes: form.notes,
    lines: form.lines.map(linePayload),
  };
}

/**
 * The first thing wrong with the form, in the schema's own sentence, or null
 * when it can be sent. A draft may total nothing; a quotation being marked as
 * sent may not, and saying so here saves a draft the database would then
 * refuse to send.
 */
export function quotationFormError(form: QuotationForm, sending = false): string | null {
  const parsed = saveQuotationInput.safeParse(quotationPayload(form));
  if (!parsed.success) return parsed.error.issues[0]?.message ?? QUOTATION_MESSAGES.lines;
  if (sending && billTotals(form.lines.map(lineNumbers)).total <= 0) return QUOTATION_MESSAGES.empty;
  return null;
}

/** What the form says when the quotation was saved as a draft but marking it as sent was refused. */
export function quotationSavedNotSent(error: string): string {
  if (error === WRITE_FAILED) return 'The quotation was saved as a draft, but marking it as sent failed. Please try again.';
  return `The quotation was saved as a draft, but it was not marked as sent. ${error}`;
}

/** A quotation is marked as sent, not posted: the shared card says so. */
export const QUOTATION_FORM_WORDS: DocumentFormWords = {
  newSubtitle: 'Saved as a draft until it is marked as sent',
  draftSubtitle: 'A draft: it gets its number when it is marked as sent',
  post: 'Save and mark as sent',
  posting: 'Marking as sent…',
};

/** The quotation form, as the shared card draws it. Its second date is how long the price holds, not when money is due. */
export const QUOTATION_FORM_KIND: DocumentFormKind<QuotationForm> = {
  noun: 'quotation',
  party: 'customer',
  dateLabel: 'Quotation date',
  partyId: (form) => form.customer_id,
  date: (form) => form.quote_date,
  withParty: withQuotationCustomer,
  withDate: withQuoteDate,
  secondDate: { label: 'Valid until', get: (form) => form.valid_until, set: withValidUntil },
  words: QUOTATION_FORM_WORDS,
  withProduct: withQuotedProduct,
  error: quotationFormError,
  payload: quotationPayload,
  savedNotPosted: quotationSavedNotSent,
};
```

- [ ] **Step 4: Write the menu's rule**

In `src/lib/finance/sales-followon-views.ts`, replace:

```ts
/** The invoice made from a quotation: its number, "Draft invoice" while it has none, or nothing (null). */
export function quotationInvoice(row: QuotationListRow): string | null {
  if (row.invoice_id === null) return null;
  return row.invoice_no ?? 'Draft invoice';
}
```

with:

```ts
/** The invoice made from a quotation: its number, "Draft invoice" while it has none, or nothing (null). */
export function quotationInvoice(row: QuotationListRow): string | null {
  if (row.invoice_id === null) return null;
  return row.invoice_no ?? 'Draft invoice';
}

export type QuotationAction = 'edit' | 'send' | 'delete' | 'accept' | 'decline' | 'convert';

/**
 * What a quotation's row menu offers, in order: only what the database allows
 * for its status. A draft is edited, marked as sent or deleted. Once sent it
 * is locked, and only the customer's answer is recorded: accepted or
 * declined, on an expired quotation too, since accepting late is the seller's
 * call. An accepted quotation is made into an invoice, or its answer is
 * corrected; a declined one can be corrected to accepted. Once an invoice
 * stands for the quotation the answer is frozen and it cannot be converted
 * again, so nothing is offered.
 */
export function quotationActions(row: QuotationListRow): QuotationAction[] {
  if (row.display_status === 'draft') return ['edit', 'send', 'delete'];
  if (row.invoice_id !== null) return [];
  switch (row.display_status) {
    case 'sent':
    case 'expired':
      return ['accept', 'decline'];
    case 'accepted':
      return ['convert', 'decline'];
    case 'declined':
      return ['accept'];
  }
}

/** How a question or a menu names one quotation: its number, or "the draft quotation", and its customer. */
export function quotationName(row: QuotationListRow): string {
  return `${row.quotation_no ?? 'the draft quotation'} to ${row.customer_name}`;
}
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `pnpm exec vitest run tests/finance-quotation-form.test.ts tests/finance-quotation-rules.test.ts tests/finance-followon-views.test.ts`
Expected: PASS, all three files.

- [ ] **Step 6: Type-check, lint, and run the unit tests**

Run, as separate commands: `pnpm exec tsc --noEmit`, `pnpm lint`, `pnpm exec vitest run --exclude 'tests/*.rls.test.ts' --exclude 'tests/bendahara-*.test.ts'`
Expected: no type errors; no lint errors; every unit test passes, 3,710 in all.

- [ ] **Step 7: Commit**

```bash
git add src/lib/finance/quotation-form.ts src/lib/finance/sales-followon-views.ts tests/finance-quotation-form.test.ts tests/finance-quotation-rules.test.ts
git commit -m "feat: the rules of the quotation form and a quotation's row menu"
```

---

### Task 4: Server actions for quotations

**Files:**
- Modify: `src/app/(app)/finance/actions.ts`
- Create: `tests/finance-quotation-actions.test.ts`

**Interfaces:**
- Consumes: `saveQuotation`, `sendQuotation`, `acceptQuotation`, `declineQuotation`, `deleteQuotation`, `convertQuotation`, `getQuotation`, `saveQuotationInput`, `quotationIdInput`, `QUOTATION_MESSAGES`, `QuotationDetail`, `SaveAndSendQuotationResult` (Task 1) from `@/lib/finance/quotations`; the existing `writeCtx`, `run`, `saveThenPost`, `draftForEditing`, `refresh`, `firstMessage`, `FORBIDDEN` in the actions file.
- Produces, all in `@/app/(app)/finance/actions`, each taking `input: unknown`:
  - `saveQuotationAction` → `Promise<FinResult<{ id: string }>>`
  - `sendQuotationAction` → `Promise<FinResult<{ id: string; quotation_no: string }>>`
  - `acceptQuotationAction`, `declineQuotationAction`, `deleteQuotationAction` → `Promise<FinResult<{ id: string }>>`
  - `convertQuotationAction` → `Promise<FinResult<{ id: string; invoice_id: string }>>`
  - `saveAndSendQuotationAction` → `Promise<SaveAndSendQuotationResult>`
  - `getQuotationAction` → `Promise<FinResult<QuotationDetail>>`

How they behave:

- Every one goes through `writeCtx` (inside `run`, `saveThenPost` or `draftForEditing`): a viewer and the demo workspace are answered "You do not have permission to make changes here." before anything is parsed, read or written. This is what stops a viewer's Decline or Delete coming back as "That quotation no longer exists.": the database answers a viewer's update or delete with no row, and `finance_send_quotation` and `finance_convert_quotation` answer a viewer with `FIN11`, because a viewer may not lock the row.
- Every write refreshes its screens after any attempt that reached the database, refused or not. Which screens is the table under "Which screens each action refreshes" near the top of this plan: `/finance/quotations` for all of them, and `/finance/invoices` as well when an invoice is made.
- `saveAndSendQuotationAction` is `saveThenPost` with the quotation's save and send: when the save works and the send is refused, the draft stays and the answer carries its id.
- `getQuotationAction` is `draftForEditing`: a quotation that has gone answers "That quotation no longer exists."; one that was sent, accepted or declined since the list was loaded answers with `QUOTATION_MESSAGES.locked`; both refresh the list.
- No constant, type or helper is exported: a `'use server'` file exports only async functions.

- [ ] **Step 1: Write the failing tests**

Create `tests/finance-quotation-actions.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const QUOTATION = '33333333-3333-4333-8333-333333333333';
const CUSTOMER = '44444444-4444-4444-8444-444444444444';
const INVOICE = '55555555-5555-4555-8555-555555555555';
const TXN = '66666666-6666-4666-8666-666666666666';

type Answer = { ok: true; data: unknown } | { ok: false; error: string };

const ctl = vi.hoisted(() => ({
  viewer: { userId: 'u1', orgId: 'org1', role: 'member', isDemo: false } as {
    userId: string; orgId: string; role: string; isDemo: boolean;
  },
  /** Every data-layer call, in order: the function, the workspace it was given, and its input. */
  calls: [] as { fn: string; orgId: string; input: unknown }[],
  revalidated: [] as string[],
  /** What each data-layer function answers; a function with no entry succeeds. */
  answers: {} as Record<string, unknown>,
  /** What getQuotation returns, or an Error for it to throw. */
  quotation: null as unknown,
}));

vi.mock('@/lib/auth/viewer', () => ({ getViewer: async () => ctl.viewer }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({}) }));
vi.mock('next/cache', () => ({
  revalidatePath: (path: string) => {
    ctl.revalidated.push(path);
  },
}));

function recorder(fn: string, ok: unknown) {
  return async (ctx: { orgId: string }, input: unknown) => {
    ctl.calls.push({ fn, orgId: ctx.orgId, input });
    return ctl.answers[fn] ?? { ok: true, data: ok };
  };
}

vi.mock('@/lib/finance/quotations', async (orig) => {
  const actual = await orig<typeof import('@/lib/finance/quotations')>();
  return {
    ...actual,
    saveQuotation: recorder('saveQuotation', { id: '33333333-3333-4333-8333-333333333333' }),
    sendQuotation: recorder('sendQuotation', { id: '33333333-3333-4333-8333-333333333333', quotation_no: 'QT-0007' }),
    acceptQuotation: recorder('acceptQuotation', { id: '33333333-3333-4333-8333-333333333333' }),
    declineQuotation: recorder('declineQuotation', { id: '33333333-3333-4333-8333-333333333333' }),
    deleteQuotation: recorder('deleteQuotation', { id: '33333333-3333-4333-8333-333333333333' }),
    convertQuotation: recorder('convertQuotation', {
      id: '33333333-3333-4333-8333-333333333333',
      invoice_id: '55555555-5555-4555-8555-555555555555',
    }),
    getQuotation: async (ctx: { orgId: string }, id: string) => {
      ctl.calls.push({ fn: 'getQuotation', orgId: ctx.orgId, input: id });
      if (ctl.quotation instanceof Error) throw ctl.quotation;
      return ctl.quotation;
    },
  };
});

vi.mock('@/lib/finance/money', async (orig) => {
  const actual = await orig<typeof import('@/lib/finance/money')>();
  return {
    ...actual,
    markPaymentPaid: recorder('markPaymentPaid', { id: '66666666-6666-4666-8666-666666666666', number: 'PV-0003' }),
    voidPayment: recorder('voidPayment', { id: '66666666-6666-4666-8666-666666666666' }),
    deleteScheduledPayment: recorder('deleteScheduledPayment', { id: '66666666-6666-4666-8666-666666666666' }),
  };
});

const actions = await import('@/app/(app)/finance/actions');

const QUOTATIONS = ['/finance/quotations'];
const QUOTATIONS_AND_INVOICES = ['/finance/quotations', '/finance/invoices'];
const PURCHASES = ['/finance/supplier-bills', '/finance/payments-out', '/finance/customers-suppliers'];
const FORBIDDEN = { ok: false, error: 'You do not have permission to make changes here.' };
const LOCKED =
  'That cannot be done to this quotation as it now stands. It may have been sent, accepted or declined since this page was loaded.';

const quotation = {
  customer_id: CUSTOMER,
  quote_date: '2026-10-01',
  valid_until: '2026-10-31',
  lines: [{ description: 'Design work', quantity: 10, unit_price: 12.5 }],
};

/** Every write action with an input its schema accepts, the data-layer function it must call, and the screens it refreshes. */
const writes: [string, (input: unknown) => Promise<Answer>, unknown, string, string[]][] = [
  ['saveQuotationAction', actions.saveQuotationAction, quotation, 'saveQuotation', QUOTATIONS],
  ['sendQuotationAction', actions.sendQuotationAction, { id: QUOTATION }, 'sendQuotation', QUOTATIONS],
  ['acceptQuotationAction', actions.acceptQuotationAction, { id: QUOTATION }, 'acceptQuotation', QUOTATIONS],
  ['declineQuotationAction', actions.declineQuotationAction, { id: QUOTATION }, 'declineQuotation', QUOTATIONS],
  ['deleteQuotationAction', actions.deleteQuotationAction, { id: QUOTATION }, 'deleteQuotation', QUOTATIONS],
  ['convertQuotationAction', actions.convertQuotationAction, { id: QUOTATION }, 'convertQuotation', QUOTATIONS_AND_INVOICES],
];

beforeEach(() => {
  ctl.viewer = { userId: 'u1', orgId: 'org1', role: 'member', isDemo: false };
  ctl.calls = [];
  ctl.revalidated = [];
  ctl.answers = {};
  ctl.quotation = null;
});

describe('who may write', () => {
  it('refuses a viewer and the demo workspace on every action, before anything is parsed, read or written', async () => {
    for (const viewer of [
      { userId: 'u1', orgId: 'org1', role: 'viewer', isDemo: false },
      { userId: 'u1', orgId: 'org1', role: 'owner', isDemo: true },
    ]) {
      ctl.viewer = viewer;
      for (const [name, action, input] of writes) expect(await action(input), name).toEqual(FORBIDDEN);
      expect(await actions.saveAndSendQuotationAction(quotation)).toEqual(FORBIDDEN);
      expect(await actions.getQuotationAction({ id: QUOTATION })).toEqual(FORBIDDEN);
      // Not even a malformed input gets a schema's sentence: the refusal comes first.
      expect(await actions.saveQuotationAction({ lines: [] })).toEqual(FORBIDDEN);
      expect(await actions.convertQuotationAction(null)).toEqual(FORBIDDEN);
    }
    expect(ctl.calls).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
  });

  it('tells a viewer they may not, not that the quotation is gone', async () => {
    ctl.viewer = { userId: 'u1', orgId: 'org1', role: 'viewer', isDemo: false };
    // The database would answer a viewer's update or delete with no row, and the functions with FIN11: both read "no longer exists".
    for (const fn of ['sendQuotation', 'acceptQuotation', 'declineQuotation', 'deleteQuotation', 'convertQuotation']) {
      ctl.answers[fn] = { ok: false, error: 'That quotation no longer exists.' };
    }
    expect(await actions.sendQuotationAction({ id: QUOTATION })).toEqual(FORBIDDEN);
    expect(await actions.acceptQuotationAction({ id: QUOTATION })).toEqual(FORBIDDEN);
    expect(await actions.declineQuotationAction({ id: QUOTATION })).toEqual(FORBIDDEN);
    expect(await actions.deleteQuotationAction({ id: QUOTATION })).toEqual(FORBIDDEN);
    expect(await actions.convertQuotationAction({ id: QUOTATION })).toEqual(FORBIDDEN);
    expect(ctl.calls).toEqual([]);
  });
});

describe('each write action', () => {
  it('calls its own data-layer function in the viewer’s workspace and refreshes the screens it moves', async () => {
    for (const [name, action, input, fn, paths] of writes) {
      ctl.calls = [];
      ctl.revalidated = [];
      expect((await action(input)).ok, name).toBe(true);
      expect(ctl.calls.map((c) => [c.fn, c.orgId]), name).toEqual([[fn, 'org1']]);
      expect(ctl.revalidated, name).toEqual(paths);
    }
  });

  it('refreshes Invoices only when an invoice is made: no other quotation action moves a figure there', async () => {
    for (const [name, action, input, fn] of writes) {
      ctl.revalidated = [];
      await action(input);
      expect(ctl.revalidated.includes('/finance/invoices'), name).toBe(fn === 'convertQuotation');
      expect(ctl.revalidated, name).not.toContain('/finance/payments-out');
    }
  });

  it('answers a conversion with the new invoice’s id', async () => {
    expect(await actions.convertQuotationAction({ id: QUOTATION })).toEqual({ ok: true, data: { id: QUOTATION, invoice_id: INVOICE } });
  });

  it('never takes the workspace from the input', async () => {
    await actions.saveQuotationAction({ ...quotation, org_id: 'someone-else' });
    await actions.convertQuotationAction({ id: QUOTATION, org_id: 'someone-else', target_org: 'someone-else' });
    expect(ctl.calls.map((c) => c.orgId)).toEqual(['org1', 'org1']);
    expect(JSON.stringify(ctl.calls)).not.toContain('someone-else');
  });

  it('answers with the schema’s sentence, touching nothing, when the input is refused', async () => {
    expect(await actions.saveQuotationAction({ ...quotation, lines: [] })).toEqual({ ok: false, error: 'Add at least one line.' });
    expect(await actions.saveQuotationAction({ ...quotation, customer_id: '' })).toEqual({ ok: false, error: 'Choose a customer.' });
    expect(await actions.saveQuotationAction({ ...quotation, valid_until: '2026-09-30' })).toEqual({
      ok: false,
      error: 'The valid-until date cannot be before the quotation date.',
    });
    for (const action of [
      actions.sendQuotationAction,
      actions.acceptQuotationAction,
      actions.declineQuotationAction,
      actions.deleteQuotationAction,
      actions.convertQuotationAction,
    ]) {
      expect(await action({ id: 'nope' })).toEqual({ ok: false, error: 'That quotation no longer exists.' });
      expect(await action(null)).toMatchObject({ ok: false });
    }
    expect(ctl.calls).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
  });

  it('hands the data layer the parsed input: text trimmed, empties as null, figures rounded', async () => {
    await actions.saveQuotationAction({
      ...quotation,
      notes: '  ',
      lines: [{ description: ' Design work ', quantity: 1.23456, unit_price: 12.5, uom: '', product_id: '' }],
    });
    expect(ctl.calls[0].input).toEqual({
      ...quotation,
      notes: null,
      lines: [{ product_id: null, description: 'Design work', quantity: 1.235, uom: null, pack_size: null, unit_price: 12.5, sst_rate: 0 }],
    });
  });

  it('refreshes the screens after a refusal too, so a quotation someone else changed shows as it now is', async () => {
    // Sent in another tab while this one still had the draft open.
    ctl.answers.saveQuotation = { ok: false, error: LOCKED };
    expect(await actions.saveQuotationAction({ ...quotation, id: QUOTATION })).toEqual(ctl.answers.saveQuotation);
    expect(ctl.revalidated).toEqual(QUOTATIONS);

    // Made into an invoice in another tab: converting it again here is refused, and both screens show it as it is.
    ctl.revalidated = [];
    ctl.answers.convertQuotation = {
      ok: false,
      error: 'This quotation already has an invoice. Void that invoice, or delete it if it is a draft, first.',
    };
    expect(await actions.convertQuotationAction({ id: QUOTATION })).toEqual(ctl.answers.convertQuotation);
    expect(ctl.revalidated).toEqual(QUOTATIONS_AND_INVOICES);
  });
});

describe('saveAndSendQuotationAction', () => {
  it('saves, then marks what it saved as sent, and answers with the number', async () => {
    expect(await actions.saveAndSendQuotationAction(quotation)).toEqual({ ok: true, data: { id: QUOTATION, quotation_no: 'QT-0007' } });
    expect(ctl.calls.map((c) => c.fn)).toEqual(['saveQuotation', 'sendQuotation']);
    expect(ctl.calls[1].input).toEqual({ id: QUOTATION });
    expect(ctl.revalidated).toEqual(QUOTATIONS);
  });

  it('does not send when the save is refused', async () => {
    ctl.answers.saveQuotation = { ok: false, error: 'The customer or a product on this quotation no longer exists.' };
    expect(await actions.saveAndSendQuotationAction(quotation)).toEqual(ctl.answers.saveQuotation);
    expect(ctl.calls.map((c) => c.fn)).toEqual(['saveQuotation']);
    expect(ctl.revalidated).toEqual(QUOTATIONS);
  });

  it('keeps the draft when sending is refused, and says which draft it is', async () => {
    ctl.answers.sendQuotation = { ok: false, error: 'A quotation needs at least one line with an amount.' };
    expect(await actions.saveAndSendQuotationAction(quotation)).toEqual({
      ok: false,
      error: 'A quotation needs at least one line with an amount.',
      draftId: QUOTATION,
    });
    expect(ctl.calls.map((c) => c.fn)).toEqual(['saveQuotation', 'sendQuotation']);
    expect(ctl.revalidated).toEqual(QUOTATIONS);
  });

  it('answers with the schema’s sentence and saves nothing when the form is refused', async () => {
    expect(await actions.saveAndSendQuotationAction({ ...quotation, customer_id: '' })).toEqual({ ok: false, error: 'Choose a customer.' });
    expect(ctl.calls).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
  });
});

describe('getQuotationAction', () => {
  const draft = { id: QUOTATION, display_status: 'draft', lines: [] };

  it('returns a draft with its lines, without refreshing anything', async () => {
    ctl.quotation = draft;
    expect(await actions.getQuotationAction({ id: QUOTATION })).toEqual({ ok: true, data: draft });
    expect(ctl.calls).toEqual([{ fn: 'getQuotation', orgId: 'org1', input: QUOTATION }]);
    expect(ctl.revalidated).toEqual([]);
  });

  it('says the quotation is gone, and refreshes the list, when it was deleted meanwhile', async () => {
    expect(await actions.getQuotationAction({ id: QUOTATION })).toEqual({ ok: false, error: 'That quotation no longer exists.' });
    expect(ctl.revalidated).toEqual(QUOTATIONS);
  });

  it('says the quotation can no longer be changed, and refreshes the list, when it was sent or answered meanwhile', async () => {
    for (const display_status of ['sent', 'expired', 'accepted', 'declined']) {
      ctl.revalidated = [];
      ctl.quotation = { ...draft, display_status };
      expect(await actions.getQuotationAction({ id: QUOTATION }), display_status).toEqual({ ok: false, error: LOCKED });
      expect(ctl.revalidated, display_status).toEqual(QUOTATIONS);
    }
  });

  it('says the quotation is gone for an id that is not an id, without reading', async () => {
    expect(await actions.getQuotationAction({ id: 'nope' })).toEqual({ ok: false, error: 'That quotation no longer exists.' });
    expect(await actions.getQuotationAction(undefined)).toEqual({ ok: false, error: 'That quotation no longer exists.' });
    expect(ctl.calls).toEqual([]);
  });

  it('answers with a sentence when the read fails, and logs the cause', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    ctl.quotation = new Error('connection reset');
    expect(await actions.getQuotationAction({ id: QUOTATION })).toEqual({ ok: false, error: 'That could not be loaded. Please try again.' });
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});

describe('the Payments Out actions, now that refunds are money out too', () => {
  it('still refresh the purchase screens only: a refund cannot be reached through them', async () => {
    for (const [action, input] of [
      [actions.markPaymentPaidAction, { id: TXN, paid_on: '2026-10-09' }],
      [actions.voidPaymentAction, { id: TXN }],
      [actions.deleteScheduledPaymentAction, { id: TXN }],
    ] as const) {
      ctl.revalidated = [];
      expect((await action(input)).ok).toBe(true);
      expect(ctl.revalidated).toEqual(PURCHASES);
    }
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run tests/finance-quotation-actions.test.ts`
Expected: FAIL: `actions.saveQuotationAction` and the other seven are not functions. The last test, "still refresh the purchase screens only…", passes.

- [ ] **Step 3: Write the actions**

Four edits to `src/app/(app)/finance/actions.ts`.

In `src/app/(app)/finance/actions.ts`, replace:

```ts
import { type FinResult, type FinanceWriteContext, NOT_ALLOWED, READ_FAILED } from '@/lib/finance/result';
```

with:

```ts
import {
  QUOTATION_MESSAGES,
  type QuotationDetail,
  type SaveAndSendQuotationResult,
  acceptQuotation,
  convertQuotation,
  declineQuotation,
  deleteQuotation,
  getQuotation,
  quotationIdInput,
  saveQuotation,
  saveQuotationInput,
  sendQuotation,
} from '@/lib/finance/quotations';
import { type FinResult, type FinanceWriteContext, NOT_ALLOWED, READ_FAILED } from '@/lib/finance/result';
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
];
// A quotation is on its own screen and moves no figure anywhere else: it is not money owed, and no other
// screen counts or names it. So saving, sending, answering and deleting one refresh Quotations only.
const QUOTATION_PATHS = ['/finance/quotations'];
// Making an invoice from a quotation adds a draft to Invoices (its table and its "by status" chart) and puts
// that invoice in the quotation's Invoice column. A draft is not receivable, so nothing else moves.
const CONVERT_PATHS = ['/finance/quotations', '/finance/invoices'];
```

In `src/app/(app)/finance/actions.ts`, replace:

```ts
  messages: { gone: string; locked: string },
  label: 'bill' | 'invoice',
): Promise<FinResult<D>> {
```

with:

```ts
  messages: { gone: string; locked: string },
  label: 'bill' | 'invoice' | 'quotation',
): Promise<FinResult<D>> {
```

In `src/app/(app)/finance/actions.ts`, replace:

```ts
/* ---- payments in ------------------------------------------------------- */

export async function recordPaymentInAction(input: unknown) {
```

with:

```ts
/* ---- quotations -------------------------------------------------------- */

export async function saveQuotationAction(input: unknown) {
  return run(QUOTATION_PATHS, saveQuotationInput, input, saveQuotation);
}
/** Marks a draft as sent: it gets its number and is locked. Nothing is emailed. */
export async function sendQuotationAction(input: unknown) {
  return run(QUOTATION_PATHS, quotationIdInput, input, sendQuotation);
}
/** The customer's answer. It can be corrected from one to the other until an invoice is made. */
export async function acceptQuotationAction(input: unknown) {
  return run(QUOTATION_PATHS, quotationIdInput, input, acceptQuotation);
}
export async function declineQuotationAction(input: unknown) {
  return run(QUOTATION_PATHS, quotationIdInput, input, declineQuotation);
}
export async function deleteQuotationAction(input: unknown) {
  return run(QUOTATION_PATHS, quotationIdInput, input, deleteQuotation);
}
/** Makes a draft invoice from an accepted quotation, and refreshes Invoices as well. */
export async function convertQuotationAction(input: unknown) {
  return run(CONVERT_PATHS, quotationIdInput, input, convertQuotation);
}

/** Saves the quotation as a draft, then marks it as sent; see `saveThenPost`. */
export async function saveAndSendQuotationAction(input: unknown): Promise<SaveAndSendQuotationResult> {
  return saveThenPost(QUOTATION_PATHS, saveQuotationInput, input, saveQuotation, sendQuotation);
}

/** One draft quotation with its lines, for the Edit form; see `draftForEditing`. */
export async function getQuotationAction(input: unknown): Promise<FinResult<QuotationDetail>> {
  return draftForEditing(QUOTATION_PATHS, quotationIdInput, input, getQuotation, QUOTATION_MESSAGES, 'quotation');
}

/* ---- payments in ------------------------------------------------------- */

export async function recordPaymentInAction(input: unknown) {
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm exec vitest run tests/finance-quotation-actions.test.ts tests/finance-sales-actions.test.ts tests/finance-actions.test.ts`
Expected: PASS, all three files.

- [ ] **Step 5: Check the file still exports only async functions**

Run: `grep -n "^export" "src/app/(app)/finance/actions.ts" | grep -v "export async function"`
Expected: no output.

- [ ] **Step 6: Type-check, lint, and run the unit tests**

Run, as separate commands: `pnpm exec tsc --noEmit`, `pnpm lint`, `pnpm exec vitest run --exclude 'tests/*.rls.test.ts' --exclude 'tests/bendahara-*.test.ts'`
Expected: no type errors; no lint errors; every unit test passes, 3,729 in all.

- [ ] **Step 7: Commit**

```bash
git add "src/app/(app)/finance/actions.ts" tests/finance-quotation-actions.test.ts
git commit -m "feat: server actions for quotations"
```

---

### Task 5: Quotations goes interactive

Components only draw: every rule they follow was written and tested in Tasks 1 to 4, so this task has no unit tests of its own. What proves it here is the type-checker, the linter and the build; what proves it to a person is the controller's smoke list.

**Files:**
- Create: `src/components/finance/quotation-form-card.tsx`
- Replace: `src/components/finance/quotations-view.tsx`
- Replace: `src/screens/finance/quotations.tsx`

**Interfaces:**
- Consumes: `DocumentFormCard` (Task 2); `QUOTATION_FORM_KIND`, `newQuotationForm`, `quotationFormFromDetail` (Task 3); `quotationActions`, `quotationName`, `QuotationAction` (Task 3) and `customersOf`, `filterQuotations`, `quotationInvoice`, `quotationsCsv`, `QUOTATION_STATUS_LABELS`, `QuotationFilter`, `QuotationsViewData`, `quotationsView` from `@/lib/finance/sales-followon-views`; `customerChoice` from `@/lib/finance/sales-views`; the eight actions of Task 4; `ConfirmRow`, `RowMenu`, `useFinanceAction`, `downloadCsv`; `listContacts`, `listProducts`, `listQuotations`; `getViewer`, `hasSupabaseEnv`, `can`.
- Produces:
  - `QuotationFormCard` and `type QuotationFormActions = { save; saveAndPost }` in `@/components/finance/quotation-form-card`.
  - `QuotationsView({ rows, view, writer? })`, `type QuotationActions`, `type QuotationsWriter = { actions: QuotationActions; customers: FinanceContact[]; products: FinanceProduct[] }` in `@/components/finance/quotations-view`.
  - The default export of `src/screens/finance/quotations.tsx`, which passes `writer` only to a person who may edit a workspace that is not the demo.

What the view must do, each of which is a line of the smoke list:

- **No `writer`, no write control.** Without `writer` (a viewer, the demo workspace, or no Supabase environment) the view renders no "New Quotation" button, no Actions column, no menu, no card and no question. Search, the two filters, "View all", Export and the link in the Invoice column are for everybody: they change nothing.
- **One thing open at a time.** A form card (`new`, `edit`), the note that an invoice was made (`converted`), or a question in one row (`send`, `accept`, `decline`, `convert`, `delete`). While a form is open or an action is pending, the row menus are `inert` and "New Quotation" is disabled. The note does not lock anything: it holds nothing a person typed.
- **Every question is asked in the row** (`ConfirmRow`), never in a browser dialog. Delete is the only red one. A refusal shows under the question and goes when the question is closed; if the row has left the filtered list, the refusal shows beside the filters instead.
- **After "Make invoice" the person is told where the invoice is.** The question closes and a card opens at the top of the page, "Draft invoice made", with a link to Invoices that takes focus (so the page scrolls to it) and a Close button. The row's Invoice column now reads "Draft invoice", and is itself a link to Invoices. Nothing navigates by itself (Decision 2).
- **Edit reads the draft first.** "Loading…" in a card, then the form with the lines in the order they were entered. If the quotation was sent or deleted meanwhile, the card says so and the list behind it has been refreshed.
- **The form's dates default to the person's own date** (`localIsoDate`), while the figures use `todayUtc`.
- **The menu's label for converting is "Make invoice".** The menu is 10 rem wide; "Convert to invoice" does not fit on one line beside its icon. The question it opens says in full what will happen.

- [ ] **Step 1: Write the form card**

Create `src/components/finance/quotation-form-card.tsx`:

```tsx
'use client';

import { DocumentFormCard } from '@/components/finance/document-form-card';
import type { FinanceContact } from '@/lib/finance/contacts';
import type { FinanceProduct } from '@/lib/finance/products';
import { QUOTATION_FORM_KIND, newQuotationForm, quotationFormFromDetail } from '@/lib/finance/quotation-form';
import type { QuotationDetail, SaveAndSendQuotationResult } from '@/lib/finance/quotations';
import type { FinResult } from '@/lib/finance/result';

export type QuotationFormActions = {
  save: (input: unknown) => Promise<FinResult<{ id: string }>>;
  /** Saves the draft, then marks it as sent. The shared card calls its second button's action `saveAndPost`. */
  saveAndPost: (input: unknown) => Promise<SaveAndSendQuotationResult>;
};

/**
 * A new quotation, or a draft being changed (`editing`). The card itself is
 * the one bills and invoices use; the rules are in
 * src/lib/finance/quotation-form.ts.
 */
export function QuotationFormCard({
  editing,
  customers,
  products,
  today,
  actions,
  onClose,
}: {
  /** The draft being changed, with its lines; absent for a new quotation. */
  editing?: QuotationDetail;
  /** Active customers, by name. */
  customers: FinanceContact[];
  /** Active products and services. */
  products: FinanceProduct[];
  /** The default quotation date, YYYY-MM-DD. */
  today: string;
  actions: QuotationFormActions;
  onClose: () => void;
}) {
  return (
    <DocumentFormCard
      kind={QUOTATION_FORM_KIND}
      initial={() => (editing ? quotationFormFromDetail(editing) : newQuotationForm(today, 'new-0'))}
      // A customer archived since the draft was saved is still this quotation's customer.
      parties={
        editing && !customers.some((c) => c.id === editing.customer_id)
          ? [{ id: editing.customer_id, name: editing.customer_name, payment_terms_days: 0 }, ...customers]
          : customers
      }
      products={products}
      actions={actions}
      onClose={onClose}
    />
  );
}
```

- [ ] **Step 2: Rewrite the view**

Replace the whole of `src/components/finance/quotations-view.tsx` with:

```tsx
'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ChartColumn, Check, Download, FilePlus, FileText, Pencil, Plus, Search, Send, Trash2, TrendingUp, X } from 'lucide-react';
import { BentoCard, BentoGrid, BentoStat } from '@/components/bento/bento';
import { AreaTrend, FunnelFlow, type Series } from '@/components/charts';
import { ConfirmRow } from '@/components/finance/confirm-row';
import { downloadCsv } from '@/components/finance/download-csv';
import { QuotationFormCard, type QuotationFormActions } from '@/components/finance/quotation-form-card';
import { RowMenu, type RowMenuItem } from '@/components/finance/row-menu';
import { useFinanceAction } from '@/components/finance/use-finance-action';
import { PageHeader } from '@/components/screen/page-header';
import { ScreenContainer } from '@/components/screen/screen-container';
import { NoMatchesRow } from '@/components/screen/table-filter';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LiveDot } from '@/components/ui/live-dot';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { localIsoDate } from '@/lib/finance/bill-math';
import type { FinanceContact } from '@/lib/finance/contacts';
import { csvFileName } from '@/lib/finance/csv';
import { rm } from '@/lib/finance/format';
import type { FinanceProduct } from '@/lib/finance/products';
import type { QuotationDetail, QuotationDisplayStatus, QuotationListRow } from '@/lib/finance/quotations';
import type { FinResult } from '@/lib/finance/result';
import {
  QUOTATION_STATUS_LABELS,
  type QuotationAction,
  type QuotationFilter,
  type QuotationsViewData,
  customersOf,
  filterQuotations,
  quotationActions,
  quotationInvoice,
  quotationName,
  quotationsCsv,
} from '@/lib/finance/sales-followon-views';
import { customerChoice } from '@/lib/finance/sales-views';
import { LATEST_ROWS, displayDate } from '@/lib/finance/view-helpers';
import { cn } from '@/lib/utils';

export type QuotationActions = QuotationFormActions & {
  send: (input: unknown) => Promise<FinResult<{ id: string; quotation_no: string }>>;
  accept: (input: unknown) => Promise<FinResult<{ id: string }>>;
  decline: (input: unknown) => Promise<FinResult<{ id: string }>>;
  remove: (input: unknown) => Promise<FinResult<{ id: string }>>;
  /** Reads one draft with its lines, for the Edit form. */
  get: (input: unknown) => Promise<FinResult<QuotationDetail>>;
  convert: (input: unknown) => Promise<FinResult<{ id: string; invoice_id: string }>>;
};

/** What only a person who may edit is given: the actions, and what the form offers. */
export type QuotationsWriter = {
  actions: QuotationActions;
  /** Active customers, by name. */
  customers: FinanceContact[];
  /** Active products and services. */
  products: FinanceProduct[];
};

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

/** A question asked in a quotation's own row. `edit` is not one: it opens the form card. */
type Question = Exclude<QuotationAction, 'edit'>;

/** One thing open at a time: the form card, the note that an invoice was made, or a question in one row. */
type Open =
  | { kind: 'new'; today: string; nonce: number }
  /** `detail` is null while the draft's lines are being read. */
  | { kind: 'edit'; quotation: QuotationListRow; detail: QuotationDetail | null; today: string }
  /** A draft invoice has just been made from this quotation. */
  | { kind: 'converted'; quotation: QuotationListRow }
  | { kind: Question; quotation: QuotationListRow }
  | null;

/**
 * Quotations: figures, charts and the table, with search, filters, "View all"
 * and Export for everybody. A person who may edit (`writer`) also gets New
 * Quotation and a menu on each row that offers what its status allows.
 */
export function QuotationsView({
  rows,
  view,
  writer,
}: {
  /** Every quotation, newest first; drafts included. */
  rows: QuotationListRow[];
  view: QuotationsViewData;
  writer?: QuotationsWriter;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<QuotationFilter>('all');
  const [chosenCustomer, setCustomer] = useState('all');
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState<Open>(null);
  const confirm = useFinanceAction();
  const loader = useFinanceAction('read');
  const invoicesLink = useRef<HTMLAnchorElement>(null);
  // The note that an invoice was made opens at the top of the page, away from the row that was used:
  // its link takes focus once, when the note opens, which also scrolls it into view.
  const converted = open?.kind === 'converted' ? open.quotation.id : null;
  useEffect(() => {
    if (converted) invoicesLink.current?.focus();
  }, [converted]);

  const customers = customersOf(rows);
  // A refresh can take the chosen customer's last quotation away: the filter then goes back to everyone, and stays there.
  const customer = customerChoice(chosenCustomer, customers);
  if (customer !== chosenCustomer) setCustomer(customer);
  const matching = filterQuotations(rows, query, filter, customer);
  const shown = showAll ? matching : matching.slice(0, LATEST_ROWS);
  const columns = writer ? 8 : 7;
  const asking = open && open.kind !== 'new' && open.kind !== 'edit' && open.kind !== 'converted' ? open : null;
  // A form holds what was typed, so nothing else opens over it: it is closed with its own Cancel first.
  const formOpen = open?.kind === 'new' || open?.kind === 'edit';
  // A row that is gone after a refresh takes its question with it; the message still has to be seen.
  const askingInView = asking ? shown.some((q) => q.id === asking.quotation.id) : false;
  const locked = confirm.pending || formOpen;
  const now = () => localIsoDate(new Date());
  /** Opens one thing, dropping whatever message the last question left behind. */
  const ask = (next: Exclude<Open, null>) => {
    confirm.clear();
    setOpen(next);
  };
  /** Closes whatever is open, and the message that went with it. */
  const close = () => {
    confirm.clear();
    setOpen(null);
  };

  const menuItem = (quotation: QuotationListRow, action: QuotationAction, actions: QuotationActions): RowMenuItem => {
    switch (action) {
      case 'edit':
        return {
          label: 'Edit',
          icon: Pencil,
          opens: true,
          onSelect: () => {
            loader.clear();
            ask({ kind: 'edit', quotation, detail: null, today: now() });
            loader.run(
              () => actions.get({ id: quotation.id }),
              // Still waiting on this quotation? Something else may have been opened meanwhile.
              (detail) =>
                setOpen((cur) => (cur?.kind === 'edit' && cur.quotation.id === quotation.id ? { ...cur, detail } : cur)),
            );
          },
        };
      case 'send':
        return { label: 'Mark as sent', icon: Send, opens: true, onSelect: () => ask({ kind: 'send', quotation }) };
      case 'delete':
        return { label: 'Delete', icon: Trash2, destructive: true, opens: true, onSelect: () => ask({ kind: 'delete', quotation }) };
      case 'accept':
        return { label: 'Mark accepted', icon: Check, opens: true, onSelect: () => ask({ kind: 'accept', quotation }) };
      case 'decline':
        return { label: 'Mark declined', icon: X, opens: true, onSelect: () => ask({ kind: 'decline', quotation }) };
      case 'convert':
        return { label: 'Make invoice', icon: FilePlus, opens: true, onSelect: () => ask({ kind: 'convert', quotation }) };
    }
  };

  const question = (quotation: QuotationListRow) => {
    if (!writer || !asking || asking.quotation.id !== quotation.id) return null;
    const { actions } = writer;
    const id = { id: quotation.id };
    const name = quotationName(quotation);
    const who = <span className="font-medium">{quotation.customer_name}</span>;
    const number = <span className="font-medium">{quotation.quotation_no}</span>;
    const shared = { colSpan: columns, pending: confirm.pending, error: confirm.error, onCancel: close };
    switch (asking.kind) {
      case 'send':
        return (
          <ConfirmRow
            key={quotation.id}
            {...shared}
            tone="default"
            icon={Send}
            label={`Mark ${name} as sent`}
            confirmLabel="Mark as sent"
            pendingLabel="Marking…"
            onConfirm={() => confirm.run(() => actions.send(id), close)}
          >
            Mark this quotation to {who} ({rm(quotation.total)}) as sent? It gets its number and can no longer be edited or
            deleted: after this, only the customer’s answer is recorded. Nothing is emailed from here.
          </ConfirmRow>
        );
      case 'accept':
        return (
          <ConfirmRow
            key={quotation.id}
            {...shared}
            tone="default"
            icon={Check}
            label={`Mark ${name} as accepted`}
            confirmLabel="Mark accepted"
            pendingLabel="Saving…"
            onConfirm={() => confirm.run(() => actions.accept(id), close)}
          >
            Record that {who} accepted {number} ({rm(quotation.total)})?
            {quotation.display_status === 'expired' ? ' It is past its valid-until date; accepting it is still your call.' : ''}{' '}
            The answer can be changed until an invoice is made from the quotation.
          </ConfirmRow>
        );
      case 'decline':
        return (
          <ConfirmRow
            key={quotation.id}
            {...shared}
            tone="default"
            icon={X}
            label={`Mark ${name} as declined`}
            confirmLabel="Mark declined"
            pendingLabel="Saving…"
            onConfirm={() => confirm.run(() => actions.decline(id), close)}
          >
            Record {number} to {who} ({rm(quotation.total)}) as declined? Use this too for a quotation that is no longer
            wanted: a quotation cannot be voided. The answer can be changed until an invoice is made from the quotation.
          </ConfirmRow>
        );
      case 'convert':
        return (
          <ConfirmRow
            key={quotation.id}
            {...shared}
            tone="default"
            icon={FilePlus}
            label={`Make an invoice from ${name}`}
            confirmLabel="Make invoice"
            pendingLabel="Making…"
            onConfirm={() =>
              confirm.run(
                () => actions.convert(id),
                // The row's question goes; the note at the top of the page says where the invoice is.
                () => ask({ kind: 'converted', quotation }),
              )
            }
          >
            Make a draft invoice from {number} to {who} ({rm(quotation.total)})? It gets the same customer, notes and
            lines, is dated today, and stays a draft on Invoices until it is posted.
          </ConfirmRow>
        );
      case 'delete':
        return (
          <ConfirmRow
            key={quotation.id}
            {...shared}
            label={`Delete ${name}`}
            confirmLabel="Delete draft"
            pendingLabel="Deleting…"
            onConfirm={() => confirm.run(() => actions.remove(id), close)}
          >
            Delete the draft quotation to {who} ({rm(quotation.total)})? This cannot be undone.
          </ConfirmRow>
        );
    }
  };

  const card = () => {
    if (!writer || !open) return null;
    const { actions } = writer;
    if (open.kind === 'new') {
      return (
        <QuotationFormCard
          key={open.nonce}
          customers={writer.customers}
          products={writer.products}
          today={open.today}
          actions={actions}
          onClose={close}
        />
      );
    }
    if (open.kind === 'edit') {
      return open.detail ? (
        <QuotationFormCard
          // A different draft gets a fresh form.
          key={open.detail.id}
          editing={open.detail}
          customers={writer.customers}
          products={writer.products}
          today={open.today}
          actions={actions}
          onClose={close}
        />
      ) : (
        <BentoCard
          title="Edit quotation"
          subtitle={`The draft to ${open.quotation.customer_name}`}
          icon={FileText}
          className="col-span-2 md:col-span-12"
        >
          <div className="flex flex-wrap items-center gap-3">
            {loader.error ? (
              <p role="alert" className="text-sm text-destructive">
                {loader.error}
              </p>
            ) : (
              <p role="status" className="text-sm text-muted-foreground">
                Loading…
              </p>
            )}
            <Button type="button" variant="outline" size="sm" onClick={close} autoFocus data-finance-focus>
              {loader.error ? 'Close' : 'Cancel'}
            </Button>
          </div>
        </BentoCard>
      );
    }
    if (open.kind === 'converted') {
      return (
        <BentoCard
          title="Draft invoice made"
          subtitle={`From ${open.quotation.quotation_no ?? 'the quotation'} to ${open.quotation.customer_name}`}
          icon={FileText}
          className="col-span-2 md:col-span-12"
        >
          <div className="flex flex-wrap items-center gap-3">
            <p role="status" className="text-sm text-muted-foreground">
              It has the quotation’s customer, notes and lines, and is dated today. It is a draft: check it, then post
              it, on{' '}
              <Link
                ref={invoicesLink}
                href="/finance/invoices"
                className="font-medium text-primary underline-offset-4 hover:underline"
              >
                Invoices
              </Link>
              .
            </p>
            <Button type="button" variant="outline" size="sm" onClick={close}>
              Close
            </Button>
          </div>
        </BentoCard>
      );
    }
    return null;
  };

  // The question's own message shows in its row; beside the filters only while its row is out of view.
  const tableError = confirm.error && asking && !askingInView ? confirm.error : null;

  return (
    <ScreenContainer className="pb-24 sm:pb-24">
      <PageHeader
        title="Quotations"
        subtitle="Quotes you have given your customers, and their answers, Saudara."
        actions={
          writer ? (
            <Button
              size="sm"
              aria-expanded={open?.kind === 'new'}
              disabled={locked}
              onClick={() => ask({ kind: 'new', today: now(), nonce: Date.now() })}
            >
              <Plus className="size-4" />
              New Quotation
            </Button>
          ) : undefined
        }
      />

      <BentoGrid>
        {card()}

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
                aria-label="Search quotations by number, customer or invoice"
                placeholder="Search quotations, customers or invoices…"
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
              onClick={() => downloadCsv(csvFileName('quotations', now()), quotationsCsv(matching))}
            >
              <Download className="size-4" />
              Export
            </Button>
            {tableError ? (
              <p role="alert" className="text-sm text-destructive">
                {tableError}
              </p>
            ) : null}
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
                  {writer ? (
                    <TableHead className="w-10">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  ) : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.length === 0 &&
                  (rows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={columns} className="py-8 text-center text-muted-foreground">
                        No quotations yet.{writer ? ' Add the first one with New Quotation.' : ''}
                      </TableCell>
                    </TableRow>
                  ) : (
                    <NoMatchesRow colSpan={columns} />
                  ))}
                {shown.map((q) => {
                  const asked = question(q);
                  if (asked) return asked;
                  const items = writer ? quotationActions(q).map((action) => menuItem(q, action, writer.actions)) : [];
                  const invoice = quotationInvoice(q);
                  return (
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
                              'inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold',
                              STATUS_STYLES[q.display_status],
                            )}
                          >
                            {QUOTATION_STATUS_LABELS[q.display_status]}
                          </span>
                        </span>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {invoice ? (
                          // The invoice made from this quotation is on Invoices; this only goes there.
                          <Link href="/finance/invoices" className="underline-offset-4 hover:underline">
                            {invoice}
                          </Link>
                        ) : (
                          '—'
                        )}
                      </TableCell>
                      {writer ? (
                        <TableCell>
                          {items.length ? (
                            // RowMenu has no disabled prop; an inert wrapper keeps its button from being used while an action runs or a form is open.
                            <span inert={locked} className={cn(locked && 'opacity-50')}>
                              <RowMenu label={quotationName(q)} items={items} />
                            </span>
                          ) : null}
                        </TableCell>
                      ) : null}
                    </TableRow>
                  );
                })}
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

- [ ] **Step 3: Rewrite the loader**

Replace the whole of `src/screens/finance/quotations.tsx` with:

```tsx
import {
  acceptQuotationAction,
  convertQuotationAction,
  declineQuotationAction,
  deleteQuotationAction,
  getQuotationAction,
  saveAndSendQuotationAction,
  saveQuotationAction,
  sendQuotationAction,
} from '@/app/(app)/finance/actions';
import { type QuotationActions, QuotationsView } from '@/components/finance/quotations-view';
import { can } from '@/lib/auth/permissions';
import { getViewer, hasSupabaseEnv } from '@/lib/auth/viewer';
import { listContacts } from '@/lib/finance/contacts';
import { listProducts } from '@/lib/finance/products';
import { listQuotations } from '@/lib/finance/quotations';
import { quotationsView } from '@/lib/finance/sales-followon-views';
import { todayUtc } from '@/lib/finance/view-helpers';
import { createClient } from '@/lib/supabase/server';
import { SAMPLE_QUOTATIONS, SAMPLE_TODAY } from './sales-sample';

const ACTIONS: QuotationActions = {
  save: saveQuotationAction,
  saveAndPost: saveAndSendQuotationAction,
  send: sendQuotationAction,
  accept: acceptQuotationAction,
  decline: declineQuotationAction,
  remove: deleteQuotationAction,
  get: getQuotationAction,
  convert: convertQuotationAction,
};

export default async function QuotationsScreen() {
  if (!hasSupabaseEnv()) {
    return <QuotationsView rows={SAMPLE_QUOTATIONS} view={quotationsView(SAMPLE_QUOTATIONS, SAMPLE_TODAY)} />;
  }
  const viewer = await getViewer();
  const ctx = { client: await createClient(), orgId: viewer.orgId };
  const canEdit = !viewer.isDemo && can(viewer.role, 'edit-data');
  // The form offers customers and products; a viewer has no form, so neither is read for them.
  const [rows, contacts, products] = await Promise.all([
    listQuotations(ctx),
    canEdit ? listContacts(ctx) : [],
    canEdit ? listProducts(ctx) : [],
  ]);
  return (
    <QuotationsView
      rows={rows}
      view={quotationsView(rows, todayUtc())}
      writer={
        canEdit
          ? {
              actions: ACTIONS,
              customers: contacts.filter((c) => c.is_customer && c.active),
              products: products.filter((p) => p.active),
            }
          : undefined
      }
    />
  );
}
```

- [ ] **Step 4: Check what the type-checker cannot**

Run: `grep -n -E "window\.confirm|alert\(|router\.|useRouter|comes in the next update" src/components/finance/quotations-view.tsx src/components/finance/quotation-form-card.tsx src/screens/finance/quotations.tsx`
Expected: no output.

Run: `grep -n -i -E "purple|violet|fuchsia|indigo|kuasa" src/components/finance/quotations-view.tsx src/components/finance/quotation-form-card.tsx src/screens/finance/quotations.tsx src/lib/finance/quotation-form.ts`
Expected: no output.

Run: `grep -n "value=\"\"" src/components/finance/quotations-view.tsx`
Expected: no output. Every `SelectItem` has a real value.

Run: `grep -n -E "icon=\{" src/components/finance/quotations-view.tsx`
Expected: every `BentoCard` line names `FileText`, `TrendingUp` or `ChartColumn`, which are in `AnimatedIcon`'s map; the other matches are `ConfirmRow` icons (`Send`, `Check`, `X`, `FilePlus`), which are plain lucide icons and not limited.

Run: `grep -c "writer" src/components/finance/quotations-view.tsx`
Expected: a number above 10. Then read the file once for this: every `Button` that changes data, every `RowMenu`, `card()` and `question()` is reached only through `writer`.

- [ ] **Step 5: Type-check, lint, run the unit tests, and build**

Run, as separate commands: `pnpm exec tsc --noEmit`, `pnpm lint`, `pnpm exec vitest run --exclude 'tests/*.rls.test.ts' --exclude 'tests/bendahara-*.test.ts'`, `NEXT_PUBLIC_SUPABASE_URL= NEXT_PUBLIC_SUPABASE_ANON_KEY= SUPABASE_SERVICE_ROLE_KEY= pnpm build`
Expected: no type errors; no lint errors; every unit test passes, 3,729 in all (this task adds none); the build completes and lists `/finance/quotations`.

The build is run with the three Supabase variables emptied on its own command line, so that nothing in it can reach the hosted database. Do **not** run `pnpm dev`, and do not open a browser.

- [ ] **Step 6: Commit**

```bash
git add src/components/finance/quotation-form-card.tsx src/components/finance/quotations-view.tsx src/screens/finance/quotations.tsx
git commit -m "feat: quotations get their form, row menus and conversion to an invoice"
```

---

### Task 6: Document, verify the branch, hand back

**Files:**
- Modify: `src/config/live-screens.ts` (a comment)
- Modify: `docs/bendahara-backend.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing new.

- [ ] **Step 1: Correct the comment in `src/config/live-screens.ts`**

Quotations is no longer read-only; Credit Notes and Refunds still are, until part 2.

In `src/config/live-screens.ts`, replace:

```ts
  // Read-only so far: their forms and row actions join in the next slice.
  'finance/quotations',
  'finance/credit-notes',
```

with:

```ts
  'finance/quotations',
  // Read-only so far: their forms and row actions join in the next slice.
  'finance/credit-notes',
```

- [ ] **Step 2: Update the backend note**

Twelve edits to `docs/bendahara-backend.md`, in the order they come in the file: the table of pure files and the paragraphs after it ("Write path"), "Money", "Quotations", "Database functions", "Error codes", then "Known limits". Each old text occurs once.

In `docs/bendahara-backend.md`, replace:

```markdown
| `sales-followon-views.ts` | KPI figures, chart data, table filters, status words and CSV rows for Quotations, Credit Notes and Refunds |
```

with:

```markdown
| `sales-followon-views.ts` | KPI figures, chart data, table filters, status words and CSV rows for Quotations, Credit Notes and Refunds; what a quotation's row menu offers (`quotationActions`) |
```

In `docs/bendahara-backend.md`, replace:

```markdown
| `document-form.ts` | What the bill form and the invoice form share: a line as it was typed, the due date following the other party's payment terms, the sentence for a document that was saved as a draft but not posted, and `DocumentFormKind`, the description of one form that the shared card draws |
```

with:

```markdown
| `document-form.ts` | What the bill, invoice and quotation forms share: a line as it was typed, the due date following the other party's payment terms, the sentence for a document that was saved as a draft but not posted, and `DocumentFormKind`, the description of one form that the shared card draws: its nouns, its rules, its second date (`secondDate`: "Due date" or "Valid until") and, for a document that is marked as sent rather than posted, its own words (`words`; otherwise `POSTING_WORDS`) |
| `quotation-form.ts` | The quotation form: defaults, the valid-until date following the quotation date (thirty days, `QUOTATION_VALID_DAYS`, whatever the customer's payment terms), validation, what is sent. A product fills a line at its price. `quotationSavedNotSent` words a quotation that was saved as a draft but not marked as sent |
```

In `docs/bendahara-backend.md`, replace:

```markdown
One card draws both document forms (`document-form-card.tsx`) and one draws
both payment forms (`allocation-form-card.tsx`). `BillFormCard`,
`InvoiceFormCard`, `PaymentFormCard` and `ReceiptFormCard` are thin wrappers
that hand the card their kind (`BILL_FORM_KIND`, `INVOICE_FORM_KIND`,
`PAYMENT_OUT_KIND`, `PAYMENT_IN_KIND`). A rule that differs between a bill and
an invoice, or between money out and money in, belongs in the kind, not in the
card.
```

with:

```markdown
One card draws the three document forms (`document-form-card.tsx`) and one
draws both payment forms (`allocation-form-card.tsx`). `BillFormCard`,
`InvoiceFormCard`, `QuotationFormCard`, `PaymentFormCard` and
`ReceiptFormCard` are thin wrappers that hand the card their kind
(`BILL_FORM_KIND`, `INVOICE_FORM_KIND`, `QUOTATION_FORM_KIND`,
`PAYMENT_OUT_KIND`, `PAYMENT_IN_KIND`). A rule or a word that differs between
a bill, an invoice and a quotation, or between money out and money in, belongs
in the kind, not in the card.
```

In `docs/bendahara-backend.md`, replace:

```markdown
form. `saveAndPostInvoiceAction` and `getInvoiceAction` do the same for an
invoice, through the same two helpers. `src/app/(app)/finance/error.tsx` is
shown when a finance screen's data cannot be read.
```

with:

```markdown
form. `saveAndPostInvoiceAction` and `getInvoiceAction` do the same for an
invoice, and `saveAndSendQuotationAction` and `getQuotationAction` for a
quotation, through the same two helpers. `src/app/(app)/finance/error.tsx` is
shown when a finance screen's data cannot be read.

Which screens an action refreshes is every screen whose figures it can move,
and no more. A bill or a payment out: Supplier Bills, Payments Out, Customers
& Suppliers. An invoice or a payment in: Invoices, Payments In, Customers &
Suppliers, Quotations, Credit Notes, Refunds. A contact: all eight. A
quotation saved, sent, answered or deleted: Quotations only, as nothing else
counts or names a quotation. A quotation made into an invoice: Quotations and
Invoices, as a draft invoice is not yet owed.
```

In `docs/bendahara-backend.md`, replace:

```markdown
A refund is not on Payments Out: `finance_payments_out` joins each allocation
to its bill, and a refund has none. `supplier_bill_totals` counts only money
out allocated to a bill, so a refund is never counted as paid to a supplier.
`finance_payments_in` shows only money in.
```

with:

```markdown
A refund is not on Payments Out: `finance_payments_out` joins each allocation
to its bill, and a refund has none. `supplier_bill_totals` counts only money
out allocated to a bill, so a refund is never counted as paid to a supplier.
`finance_payments_in` shows only money in.

The reverse holds too. `markPaymentPaid`, `voidPayment` and
`deleteScheduledPayment` in `money.ts`, which Payments Out uses, first read
`finance_payments_out` for the workspace and the transaction and refuse with
"That payment no longer exists." anything it does not show, without writing.
A refund can therefore not be marked paid, voided or deleted through them.
`voidPaymentIn` needs no such read: it is kept to `direction = 'in'`, and a
refund and a payment to a supplier are both money out.
```

In `docs/bendahara-backend.md`, replace:

```markdown
an invoice that belongs to another customer. The funnel on the screen
has three steps, created, sent and accepted: nothing tracks a customer opening
a quotation.
```

with:

```markdown
an invoice that belongs to another customer. The funnel on the screen
has three steps, created, sent and accepted: nothing tracks a customer opening
a quotation.

What a row's menu offers follows its status (`quotationActions`): a draft is
edited, marked as sent or deleted; a sent quotation, expired or not, is marked
accepted or declined; an accepted one is made into an invoice or marked
declined; a declined one can be marked accepted; and once an invoice stands
for the quotation the menu offers nothing. The form is the card bills and
invoices use, with "Valid until" as its second date and "Save and mark as
sent" as its second button. After "Make invoice" the screen stays on
Quotations and a note at the top says a draft invoice was made, with a link to
Invoices, where it is checked and posted; the row's Invoice column links there
too.
```

In `docs/bendahara-backend.md`, replace:

```markdown
updates and deletes too. The data layer for all of it is in `quotations.ts`,
`credit-notes.ts` and `refunds.ts`; no server action calls the write functions
yet.
```

with:

```markdown
updates and deletes too. The data layer for all of it is in `quotations.ts`,
`credit-notes.ts` and `refunds.ts`. The quotation writes are called by
`saveQuotationAction`, `sendQuotationAction`, `saveAndSendQuotationAction`,
`acceptQuotationAction`, `declineQuotationAction`, `deleteQuotationAction` and
`convertQuotationAction`; no server action calls the credit note or refund
writes yet.
```

In `docs/bendahara-backend.md`, replace:

```markdown
void one is locked; a draft is deleted, not voided). Their sentences are in
`quotations.ts` and `credit-notes.ts`.
```

with:

```markdown
void one is locked; a draft is deleted, not voided). Their sentences are in
`quotations.ts` and `credit-notes.ts`.

The sentence for `FIN01` on a quotation is "That cannot be done to this
quotation as it now stands. It may have been sent, accepted or declined since
this page was loaded.". The row menu offers only what a status allows, so the
code reaches a person only when the quotation changed in another tab: a draft
that was sent meanwhile being saved, sent or deleted, or an answer being
recorded that is already the answer. The sentence says what may have happened
and not what did, so it is not false of a draft answered by a direct call
either. The credit note and refund sentences for `FIN01` and `FIN09` are
checked the same way when their buttons are built.
```

In `docs/bendahara-backend.md`, replace:

```markdown
  form. A retry after a save that did land can create a second bill, a second
  invoice, a second part-payment or a second receipt, until writes carry a
  client-generated id (which needs a migration).
```

with:

```markdown
  form. A retry after a save that did land can create a second bill, a second
  invoice, a second quotation, a second part-payment or a second receipt,
  until writes carry a client-generated id (which needs a migration). A second
  draft quotation can be deleted; a second one that was marked as sent cannot,
  and is marked declined. Making an invoice from a quotation is not affected:
  a quotation has one invoice at a time, so a retry is refused.
```

In `docs/bendahara-backend.md`, replace:

```markdown
  a scheduled payment to a supplier: both are payment vouchers. The refund
  functions do not rely on the missing check: `markRefundPaid`, `voidRefund`
  and `deleteRefund` read `finance_refunds` first and refuse anything it does
  not show, so a payment to a supplier is never marked paid, voided or deleted
  through them.
```

with:

```markdown
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

In `docs/bendahara-backend.md`, replace:

```markdown
- Quotations, Credit Notes and Refunds are read-only so far: search, filters,
  "View all" and Export, but no forms and no row actions. The data layer for
  them is in `quotations.ts`, `credit-notes.ts` and `refunds.ts`.
```

with:

```markdown
- Credit Notes and Refunds are read-only so far: search, filters, "View all"
  and Export, but no forms and no row actions. The data layer for them is in
  `credit-notes.ts` and `refunds.ts`.
- A sent quotation cannot be edited: mark it declined and write a new one.
  "Mark as sent" is offered on a draft whatever its total, and refused with
  the reason when its lines total nothing, as Post is on an invoice.
- A new quotation is valid for thirty days until the person changes the date;
  the thirty is not a setting.
- Making an invoice from a quotation does not open that invoice: the screen
  says a draft was made and links to Invoices, where the draft is dated today
  and so is among the newest rows. The link does not single the draft out.
```

In `docs/bendahara-backend.md`, replace:

```markdown
- A quotation has no void. One that was sent by mistake is marked declined,
  and then counts as declined in the conversion figure.
```

with:

```markdown
- A quotation has no void. One that was sent by mistake is marked declined,
  and then counts as declined in the conversion figure. The question asked
  before marking one declined says that a quotation cannot be voided.
```

- [ ] **Step 3: Run everything**

Run, as separate commands: `pnpm exec tsc --noEmit`, `pnpm lint`, `pnpm exec vitest run --exclude 'tests/*.rls.test.ts' --exclude 'tests/bendahara-*.test.ts'`, `NEXT_PUBLIC_SUPABASE_URL= NEXT_PUBLIC_SUPABASE_ANON_KEY= SUPABASE_SERVICE_ROLE_KEY= pnpm build`
Expected: no type or lint errors; every unit test passes, 3,729 in all (59 more than the 3,670 on `main` when this plan was written); the build completes.

Do **not** run `pnpm test`, `tests/bendahara-*.test.ts` or `tests/*.rls.test.ts`: they write to the hosted production database. This branch changes no table, view, function or policy. It edits one of those files, `tests/bendahara-followons.test.ts` (Task 1, Step 10); the controller runs it after the merge.

- [ ] **Step 4: Check the boundaries the build does not check**

Run: `grep -n "^export" "src/app/(app)/finance/actions.ts" | grep -v "export async function"`
Expected: no output. A `'use server'` file exports only async functions.

Run: `grep -l -E "supabase/server|next/headers" src/lib/finance/*.ts src/screens/finance/sales-sample.ts`
Expected: no output.

Run: `git diff main -- src | grep -n -i -E "^\+.*(purple|violet|fuchsia|indigo|kuasa)"`
Expected: no output.

Run: `grep -rn -E "window\.confirm|alert\(|router\.refresh" src/components/finance src/screens/finance/quotations.tsx`
Expected: no output.

Run: `git diff main --stat -- supabase`
Expected: no output. There is no migration in this stage.

Run: `git diff main --stat -- tests/finance-bill-form.test.ts tests/finance-payment-form.test.ts tests/finance-bill-math.test.ts tests/finance-bills.test.ts tests/finance-actions.test.ts tests/finance-purchase-views.test.ts tests/finance-shared.test.ts tests/finance-document-form.test.ts tests/finance-allocation-form.test.ts tests/finance-invoice-form.test.ts tests/finance-receipt-form.test.ts tests/finance-sales-actions.test.ts tests/finance-sales-rules.test.ts tests/finance-sales-views.test.ts tests/finance-refunds.test.ts tests/finance-credit-notes.test.ts`
Expected: no output. Of the purchase side's tests, only `tests/finance-money.test.ts` and `tests/finance-touchups.test.ts` were edited (Decision 5), and nothing that pins the invoice form, the payment forms, credit notes or refunds was.

Run: `git diff main --stat -- src/components/finance/bills-view.tsx src/components/finance/invoices-view.tsx src/components/finance/bill-form-card.tsx src/components/finance/invoice-form-card.tsx src/components/finance/credit-notes-view.tsx src/components/finance/refunds-view.tsx src/screens/finance/credit-notes.tsx src/screens/finance/refunds.tsx`
Expected: no output. The shared card changed under the bill and invoice forms; nothing that uses it did. Credit Notes and Refunds are untouched until part 2.

Run: `grep -rn "comes in the next update" src/components/finance`
Expected: two lines, in `credit-notes-view.tsx` and `refunds-view.tsx`. They are still true and go in part 2. `quotations-view.tsx` no longer has one.

- [ ] **Step 5: Commit**

```bash
git add src/config/live-screens.ts docs/bendahara-backend.md
git commit -m "docs: quotations are writable; payments-out writes keep to supplier payments"
```

- [ ] **Step 6: Hand back**

Do not push. Report what was built, the result of the four commands in Step 3, and anything that had to differ from this plan. The controller pushes and opens the PR (title `feat-119-bendahara-sales-followon-forms`; the body has no close keyword unless `gh issue list` shows an issue that is exactly this stage: issue #41, the one open when stage 3b was written, is broader than it, and no issue is opened for the purpose) when the owner says so.

---

## Controller: production smoke test after the merge

Not a task for an implementer. Run on `https://openkuasa.com` after the merge has deployed, in the Chrome session that is already signed in as the smoke account `smoke@openkuasa-test.dev`, workspace "Smoke Test Co" (`~/.config/openkuasa/smoke-account.json`). **The tester never types a password.** If the session is signed out, stop and ask the owner to sign in. After each navigation wait and take a screenshot before clicking: a background tab stays on the loading skeleton. There is no migration to apply before or after this deploy.

Everything below is created in the smoke workspace. A quotation that has been marked as sent cannot be deleted, and cannot be voided: the ones this test sends stay there, marked declined at the end. Put `Smoke 4b` in the Notes box of every quotation so they are recognisable, and reuse the same customer and product on later runs rather than adding new ones.

1. **The three screens with rows, read-only.** In the demo workspace (or signed in as a viewer), open `/finance/quotations`, `/finance/credit-notes` and `/finance/refunds`. This is the first time any of them is seen in a browser with rows. On each: the four cards have figures; both charts draw (Quotations: the trend and the three-step funnel; the other two: the trend and the by-reason donut with its total in the middle); the table has rows with their status badges; search narrows the rows and "No matches" shows for nonsense; each status filter works; "View all" appears when there are more than ten rows and shows them; Export downloads a file that opens. There is no header button and no "⋯" on any row. On Quotations, a draft shows "—" for its number, a declined row is dimmed and struck through, and a quotation with an invoice shows the invoice's number as a link that goes to Invoices. On Refunds, a pending refund reads "Pending" in amber and has "—" for its number. Repeat the three at 390 px wide, and in dark mode: nothing overlaps, each table scrolls sideways inside its card, no purple. If the demo workspace shows no quotations, credit notes or refunds at all, stage 4a's seed has not been applied: stop and tell the owner; do not apply it as part of this test.
2. **Open, as a writer.** In the smoke workspace `/finance/quotations` loads with no work-in-progress banner and a "New Quotation" button. With no quotations yet the table reads "No quotations yet. Add the first one with New Quotation." and nothing about a next update. `/finance/credit-notes` and `/finance/refunds` still have no header button and still say "…comes in the next update".
3. **Customer and product.** Reuse `=Smoke 3b, Customer 林` (ticked Customer, payment terms 14) and "Smoke 3b Gloves" (unit `box`, price 24.90, cost 12.50, SST 6) from the stage 3b test. If they are gone, add them on Customers & Suppliers and Products.
4. **Draft quotation with two lines.** New Quotation. The card is titled "New quotation", says "Saved as a draft until it is marked as sent", and has Customer, Quotation date and Valid until; there is no "Due date" and no "Supplier's reference". Valid until is the quotation date + 30 days. Choose the customer: Valid until does **not** move (their terms are 14 days). Change the Quotation date: Valid until follows it by 30 days. Set Valid until by hand, then change the Quotation date again: Valid until stays. Line 1: choose the product; description, unit, unit price **24.9** (the price, not the cost 12.5) and SST 6 fill in; set Qty 10. Press "Add line": focus is in the new line's Description. Line 2: "Delivery", Qty 1, unit price 20. The totals read Subtotal RM 269.00, SST RM 14.94, Total RM 283.94. Type `Smoke 4b` in Notes. Press Enter inside a quantity box: nothing is saved. "Save draft": the card closes; the quotation is in the table as Draft with "—" for its number, Total RM 283.94, "—" under Invoice. "Pipeline value" has gone up by about RM 284; "Open quotes" has not moved.
5. **Edit it.** "⋯" offers Edit, Mark as sent, Delete and nothing else. Edit: "Loading…", then the form titled "Edit quotation" with both lines in the order they were entered and the Valid until date as it was saved. While it is open, "New Quotation" is disabled and the other rows' "⋯" do nothing. Change line 1's Qty to 20: Total RM 547.88. "Save draft". The row shows RM 547.88.
6. **A comma, and a quotation of nothing.** New Quotation, choose the customer, describe a line, and type `1,200.50` as its unit price (paste it if the browser will not let it be typed), "Save draft": the box is empty or the form answers "Enter a unit price of 0 or more."; change the price and the sentence goes at once. Set the price to 0 and press "Save and mark as sent": "A quotation needs at least one line with an amount.", and nothing was saved. Press "Save draft" instead: it saves (a draft may total nothing). On that row, "⋯" → Mark as sent → confirm: refused in the row with the same sentence. Cancel: the sentence goes with the question. Delete that draft: the question is red, names the customer, and the row goes.
7. **Mark as sent.** On the RM 547.88 draft, "⋯" → Mark as sent: the question is not red, names the customer and the total, says nothing is emailed, and focus is on Cancel; Escape closes it. Open it again and confirm. The row gets a `QT-` number and becomes Sent. "Open quotes" has gone up by RM 548, and the funnel's Sent step by one.
8. **Sent is locked.** "⋯" now offers Mark accepted and Mark declined, and nothing else: no Edit, no Delete, no Make invoice.
9. **An answer, corrected.** Mark declined → the question is not red and says a quotation cannot be voided → confirm: the row reads Declined, dimmed and struck through, and "⋯" offers only Mark accepted. Mark accepted → confirm: the row reads Accepted with a green dot; "Accepted (MTD)" has gone up by RM 548 and Conversion is no longer "—". "⋯" now offers Make invoice and Mark declined.
10. **Make an invoice.** "⋯" → Make invoice: the question says a draft invoice will be made with the same customer, notes and lines, dated today. Confirm. The question closes; a card "Draft invoice made" is at the top of the page, in view, with focus on its "Invoices" link; the row's Invoice column reads "Draft invoice", underlined on hover; that row has no "⋯" any more. Follow the link: Invoices shows a Draft for that customer, Total RM 547.88, dated today by the database's UTC date (before 08:00 in Malaysia that is yesterday's date), due 14 days after that. Edit it: both lines, in order, and `Smoke 4b` in Notes. Cancel.
11. **The invoice and its quotation.** Post that invoice. Back on Quotations the Invoice column shows its `INV-` number; typing that number in the search box finds the quotation. On Invoices void the invoice. On Quotations the Invoice column is "—" again and "⋯" offers Make invoice and Mark declined. Make invoice once more, then delete the new draft on Invoices: the quotation is free again.
12. **Two tabs.** (a) Save a new draft. In tab A open it with Edit and change a quantity. In tab B mark the same quotation as sent. In tab A press "Save draft": the form shows "That cannot be done to this quotation as it now stands. It may have been sent, accepted or declined since this page was loaded.", what was typed is still there, and the row behind the form now reads Sent. Cancel. (b) With a second draft, open tab A's list, delete the draft in tab B, and choose Edit in tab A: the card says "That quotation no longer exists." and the row has gone. (c) With the accepted quotation of step 11 open in two tabs, choose Make invoice in tab B and confirm; in tab A, where the row still offers it, choose Make invoice and confirm: "This quotation already has an invoice. Void that invoice, or delete it if it is a draft, first.", and after Cancel the row shows "Draft invoice" and no "⋯". Only one draft invoice was made: check on Invoices, then delete it. (d) With the quotation sent in (a) open in two tabs, mark it accepted in tab B, then choose Mark accepted in tab A: the "as it now stands" sentence, never advice to send a draft; after Cancel the row reads Accepted.
13. **Expired.** New Quotation for the same customer with the Quotation date and Valid until both three days ago, one line of RM 10, `Smoke 4b` in Notes, "Save and mark as sent" (the button reads "Marking as sent…" while it works). The row reads Expired, in red, with a `QT-` number; it is not counted in "Open quotes". "⋯" offers Mark accepted and Mark declined. Mark accepted: the question says it is past its valid-until date. Confirm: it reads Accepted.
14. **The customer filter.** Add a second customer "Smoke 3b Second" if it is not there, and save one draft quotation for them. Choose that customer in the filter: one row. Delete that draft: the filter reads "All customers" and the whole list is back. Save a new draft for the same customer: the list still shows every customer. Delete the draft.
15. **Export.** Press Export with "All statuses", then with the status filter on Declined. Open the files (`quotations-YYYY-MM-DD.csv`): the columns are No., Date, Customer, Total, Valid until, Status, Invoice, in that order, as on the screen; the customer reads `'=Smoke 3b, Customer 林` in one cell, no formula has run, 林 is readable; Total is a number that can be summed; a draft's No. is empty.
16. **390 px and dark mode.** At 390 px wide, in light and in dark: the Quotations screen with rows; the new-quotation form with three lines (each line is a card with its boxes two to a row; nothing scrolls sideways); a row's "⋯" open, with "Mark as sent", "Mark accepted", "Mark declined" or "Make invoice" each on one line beside its icon; a question open in a row, readable with the table scrolled sideways; the "Draft invoice made" card. No purple anywhere.
17. **Supplier Bills, Invoices and Payments Out still work.** New Bill: the card has "Supplier's reference" and "Due date", says "Saved as a draft until it is posted", its second button reads "Save and post", and choosing a product fills the unit price from its **cost**. New Invoice: "Due date" follows the customer's 14 days and the second button reads "Save and post". Then the three Payments Out writes, which now read a view first: with "Save and post", make two bills for one supplier (RM 30.00 and RM 20.00); on Payments Out, "Record Payment", tick both, "Schedule for later", save: two rows, Scheduled. On the second row "⋯" → Mark as paid → confirm: both rows read Paid with one `PV-` number. On the second row "⋯" → Void → confirm: both rows are Void (choose Void in the status filter if they have left the list) and both bills are Pending again. Schedule a payment for one of them and delete it from its row: it goes. Each of the three worked, on a payment split across two bills, from its second row. This is the only place the new check meets the real view: if Mark as paid or Delete answers "That payment no longer exists." for a payment that is plainly in the list, the view is not showing scheduled payments to that read, and Task 1 has to be looked at again before anything else. Void the two bills.
18. **Not a writer.** In the demo workspace (or signed in as a viewer): Quotations shows the figures, charts, table, search, filters, Export and the links in the Invoice column, with no header button and no "⋯".
19. **The edited database test, once.** From the worktree, with the Supabase variables of the shell as they are: `pnpm exec vitest run tests/bendahara-followons.test.ts`. Expected: every test passes, the third included ("an accepted quotation becomes one draft invoice with the same lines, and only one"). The file makes its own users and workspaces and deletes them when it finishes. It is run by the controller only, and only this once.

**What this leaves behind,** to list for the owner, who decides whether it stays:

- Contacts: `=Smoke 3b, Customer 林`, "Smoke 3b Second" and the supplier used in step 17. Product: "Smoke 3b Gloves". All may be from the stage 3b test.
- Quotations, all with `Smoke 4b` in their notes: the one sent in step 7 (accepted, no invoice), the one sent in step 12a (accepted), the one of step 13 (accepted). Mark each declined before finishing, so that they read as closed; none can be deleted. Their conversion figure counts them as declined.
- Invoices: the one posted and voided in step 11, which cannot be deleted. The two draft invoices of steps 11 and 12c were deleted.
- Bills and payments out: the two bills of step 17 (void) and one payment (void). Neither can be deleted.
- Document numbers: three `QT-` numbers, one `INV-` number, two `BILL-` numbers and one `PV-` number were used.
- No draft quotation and no draft invoice should be left: delete any the test did not.

---

## Self-review notes

**Spec coverage for this part.**

- Common behaviour: layout kept (the stage 4a view is extended, not redrawn); the form as a card closed by default (Task 5); a "⋯" menu per row with the actions that apply (Tasks 3, 5); delete confirmed in the page, and every other row action too (5); search, filters, "View all" and Export unchanged but for the two fixes of Task 1; viewers get no buttons and no menus and the actions check again (4, 5, with tests in 4); sample data with no actions when there is no Supabase environment (5).
- Sales, Quotations: "New, edit draft, send, mark accepted or declined, convert to invoice, delete draft" (Tasks 3 to 5), with the five states. "Converting an accepted quotation creates a draft invoice with the same lines" is the database's (4a) and is reached by `convertQuotationAction`.
- Sales, Credit Notes and Refunds, and "issue credit note" on Invoices: part 2.
- Code: one schema and one function per write (4a), called by actions that guard, parse, call and revalidate (Task 4); view rules as pure functions (Tasks 1, 3); a loader screen that passes actions only to writers (5); the shared document form card (2).
- Errors: messages beside the form with typed values kept (the shared card, and Task 5); refusals as sentences (Task 1, and the table near the top); "a record changed or removed by someone else: the form says so and reloads" (Task 4, and smoke step 12).
- Testing: unit tests for every rule (Tasks 1 to 4); the smoke list above. No database test is added: nothing in the database changes. One is edited (Task 1, Step 10).

**Each thing stage 4a's reviews left, and where it is settled.**

| Left by 4a | Settled in |
|---|---|
| The Payments Out data functions accept any transaction id | Task 1 (`refusalUnlessPaymentOut`), Decision 4; tests under "money out that is not a payment to a supplier"; smoke step 17 |
| Whether `voidPaymentIn` needs anything | No: Decision 6; written into the backend note (Task 6) |
| A viewer's update or delete reads "no longer exists" | Task 4 for the eight quotation actions, with two tests; Task 5 renders no write control without a `writer`. Credit note and refund actions: part 2 |
| Refresh paths, per action, in a table | "Which screens each action refreshes"; pinned per action in `tests/finance-quotation-actions.test.ts`. Credit note and refund actions: part 2, with the answer already worked out in "What part 2 takes" |
| The retry-after-lost-response limit | Lived with: Decision 8; Known limits (Task 6) |
| Quotations CSV order; search does not match the Invoice column; a draft refund labelled Draft | Task 1, Decision 9. The draft refund's badge colour: part 2 |
| Refusal sentences read sensibly from their buttons | Quotations: Task 1 and the table "What the database allows", Decision 7. Credit notes and refunds: part 2 |
| `tests/bendahara-followons.test.ts` test 3 can flake across UTC midnight | Task 1, Step 10; run once by the controller, smoke step 19 |
| Nothing has rendered the three screens with rows in a browser | Smoke step 1 (all three, read-only, with the demo's rows), then steps 2 to 16 for Quotations with rows the test makes |

**Checked by running, not only by reading.** Every file this plan creates or replaces was written once, outside the working tree, and this document was assembled from those files and from the edits as written here. Then every code block of this document was applied, task by task, to a fresh clone of the repository outside the working tree, by a script that reads only this file: "Create", "Replace the whole of" and "In …, replace: … with:" are the three instructions it understands, and it stops if a text to replace does not occur exactly once. After each task there: `tsc --noEmit` clean, `eslint` clean but for the one warning that is on `main`, and the unit suite passing with the two excludes (3,670 tests on `main` when this was written; 3,678 after Task 1, 3,683 after Task 2, 3,710 after Task 3, 3,729 after Tasks 4 to 6). The new money tests were also run against the unchanged code first, to see the six failures Task 1's Step 2 names. At the end a production build completed with the three Supabase variables emptied. The new view and the three document forms were also rendered once on the server with sample props, for a viewer and for a writer, to see that they do not throw and that a viewer's page has no button and no menu. No database was touched, no live test was run, and no browser was used: layout at 390 px, focus moving to the note after "Make invoice", the Radix menus and selects opening, and the download are first seen in the smoke test.

**Unsure about, stated plainly.**

1. Whether focus reliably lands on the "Invoices" link in the "Draft invoice made" card, and scrolls it into view, when the question was confirmed far down the page. It is done in an effect that runs once when the card opens; smoke step 10 is what shows it. If it does not, the card is still there at the top of the page, but a person on a long list may not see it.
2. "Make invoice" as a menu label. It fits; it is also not the spec's word ("convert to invoice"). The question it opens uses neither word alone and says what happens.
3. That staying on Quotations is what the owner means by landing "somewhere sensible" (Decision 2).
4. The reworded `FIN01` sentence hedges ("It may have been…"). That is what keeps it true of every case; a sentence per case would need the action to know which button was pressed.
5. The Payments Out check is a read followed by a write. Nothing the app does can change what a transaction is between the two, but it is not the single statement a database function would be. Making it one needs a migration.
6. With the "All statuses" filter a declined quotation stays in the list, dimmed. Quotations has no "All except declined" default as Invoices has "All except void"; 4a chose that and this plan does not change it.
7. A person who marks a quotation as sent by mistake has no way back but "Mark declined". The question before sending says it can no longer be edited or deleted; it does not say that.
8. The estimate that the whole of 4b is about twelve tasks is a count of part 2's work from reading, not from a written plan.
