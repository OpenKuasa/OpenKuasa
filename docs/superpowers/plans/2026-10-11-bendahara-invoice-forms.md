# Bendahara Invoice and Payment-In Forms Implementation Plan (stage 3b)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stage 3b of the Bendahara CRUD spec: the two live, read-only screens Invoices and Payments In get their forms and actions (new invoice with line items, edit, post, record payment, set e-Invois, void, delete; record and void a payment in), and Customers & Suppliers shows a real Receivable, on the data layer and database that stage 3a shipped.

**Architecture:** No database migration: every write maps to a function or a plain update or delete that the hosted database already allows. An invoice form is a bill form with a customer, and a payment-in form is a payment-out form without scheduling, so the first task turns the two stage 2b cards into one card for both document forms and one for both payment forms. Each card is handed a "kind": the words of one form and its rules, which stay as the pure, tested functions of that form's own module (`bill-form.ts`, `invoice-form.ts`, `payment-form.ts`, `receipt-form.ts`). The bill and payment-out modules keep every name and behaviour their tests pin. After that the stage is the mirror of 2b: data-layer touch-ups, pure form and menu rules with unit tests, server actions that guard, parse, write and refresh, then the two client views and their loaders.

**Tech Stack:** Next.js 16.3 App Router (server components, server actions), React 19, Tailwind v4, shadcn/Radix, Supabase Postgres with RLS, Zod 4, Vitest (node, no DOM), pnpm.

**Spec:** `docs/superpowers/specs/2026-10-10-bendahara-crud-design.md`, sections "Screens → Common behaviour", "Sales" (the Invoices and Payments In rows), "Code", "Errors", "Testing"; build-order item 3, second half. Backend notes: `docs/bendahara-backend.md` (read all of it, Known limits included). First half: `docs/superpowers/plans/2026-10-11-bendahara-invoices.md` (3a). The stage this one mirrors: `docs/superpowers/plans/2026-10-11-bendahara-bill-forms.md` (2b). What the database allows is in `supabase/migrations/20261014100000_bendahara_invoices.sql`, already applied; it is the law here.

## Global Constraints

- `org_id` always comes from the server-side context, never from client input.
- One Zod schema per write; messages are sentences a person can act on. Round first, then validate (`.transform(round).pipe(…)`). Every schema's transforms are idempotent, and every new schema is added to `tests/finance-schemas.test.ts`.
- A posted document cannot be edited or deleted, only voided; a draft has no number. A row's menu offers only what the database allows for the row's status.
- Forms are cards closed by default; confirmations happen in the page (`ConfirmRow`), never `window.confirm` or `alert`; viewers and the demo workspace get no buttons and no menus, and every server action checks again.
- With no Supabase environment the screens show the sample and no actions.
- `src/lib/finance/*.ts` and `src/screens/finance/sales-sample.ts` import nothing server-only (`@/lib/supabase/server`, `next/headers`): client views import types and pure functions from them.
- A `'use server'` file exports only async functions: no constants, no types, no re-exports. Helpers inside it are not exported.
- Vitest runs in node with no DOM: components have no unit tests. Every rule a form or a menu follows is a pure, tested function in `src/lib/finance/`; components only draw.
- Money is shown with `rm()` from `format.ts`. Amounts typed by a person are read with `typedNumber` and never sent as strings; a figure typed with a comma is refused with a sentence. Payment method labels come only from `PAYMENT_METHOD_LABELS` in `money.ts`.
- What the new forms must have from the start, as the purchase forms do: while a form is open or an action is pending, row menus are `inert` and the header button is disabled; a refusal shown in a form clears as soon as the person changes anything; Post from a row asks first; a refused action's message does not outlive its question; Enter inside a line's box or an amount box does not submit the form; form dates default to the person's own date (`localIsoDate`) while figures use `todayUtc`; a lost response says "We could not confirm that was saved. Reload the page and check the list before trying again." (`useFinanceAction`) and nothing calls `router.refresh()` after a failed response (in Next 16.3 a failed refresh hard-navigates and loses the form); `ConfirmRow`'s confirm button stays focusable while pending so Escape still works; list containers keep `pb-24 sm:pb-24`.
- Supplier Bills and Payments Out behave as they do today, for everything a person can do on them (the one exception, an error only a direct call can produce, is Decision 8). The existing test files `tests/finance-bill-form.test.ts`, `tests/finance-payment-form.test.ts`, `tests/finance-bill-math.test.ts`, `tests/finance-bills.test.ts`, `tests/finance-money.test.ts`, `tests/finance-actions.test.ts`, `tests/finance-purchase-views.test.ts`, `tests/finance-touchups.test.ts` and `tests/finance-shared.test.ts` are not edited by any task and pass after every task.
- No purple, violet, indigo or fuchsia anywhere. No Kuasa names in `src/`. Icons from lucide-react only.
- `BentoCard`'s `icon` prop draws through `AnimatedIcon`, which returns nothing for a name that is not in its map. Pass `BentoCard` only these: `FileText`, `Wallet`, `Plus`, `Banknote`, `TrendingUp`, `ChartColumn`, `PieChart`. Icons inside `RowMenu`, `ConfirmRow` and buttons are plain lucide icons and are not limited.
- Radix `SelectItem` throws at runtime for `value=""`. An unchosen `Select` is `value=""` with a `SelectValue placeholder`; every item has a real value (`'all'`, `'none'`, `'posted'`).
- This is Next.js 16.3. No Next API is used here beyond what the purchase screens already use: an async server component as a screen's default export, `revalidatePath` with a literal path inside the existing `'use server'` actions file, `next/link`. If you reach for anything else, read the matching guide in `node_modules/next/dist/docs/` first.
- pnpm only. 2-space indent, single quotes, semicolons, named exports. The only default exports are the screen files under `src/screens/finance/`.
- Every task leaves `pnpm exec tsc --noEmit`, `pnpm lint` and the unit tests green.
- **Unit tests are run with `pnpm exec vitest run --exclude 'tests/*.rls.test.ts' --exclude 'tests/bendahara-*.test.ts'`, or with the files named. Never bare `pnpm test`.** The Supabase variables are set in the shell, so `tests/bendahara-*.test.ts` and `tests/*.rls.test.ts` run against the hosted production database and leave a user and a workspace behind on every run. No step of this plan runs them.
- **Implementers never call a database tool, never change the schema, and never start a dev server or a browser.** There is no migration in this stage. If a task seems to need a database change, stop and report it.
- Branch `feat-106-bendahara-invoice-forms` (already cut from main and checked out; work on it, do not create another). PR title equals the branch name. Do not push or merge until the owner says so. The PR body has no close keyword: issue #41 is broader than this stage.

## Not in this stage

- **Quotations, credit notes and refunds** (stage 4), and with them "issue credit note" on an invoice's row and money out against an invoice.
- **Cash receipts** (stage 5): money in that settles no invoice, drafts of money in, income categories. A payment in here always pays at least one invoice and is posted at once.
- **Printing, PDF and email.** "Sent" means posted; nothing goes out.
- **Submission to LHDN.** The e-Invois status and UUID are what a person types in.
- **Bill line order.** A bill's lines still come back in no particular order after an edit; invoice lines keep theirs (`position`). Fixing bills needs a migration.
- **Approval of money** (stage 5). Managing accounts (stage 6). AI tools for finance.
- **Closing the retry gap.** A retry after a lost response can create a second invoice or a second receipt. Closing it needs a client-generated id on each write and a migration; the limit stays and is written into the backend note.
- **Any migration.**

## Decisions this plan makes (flag to the owner at handoff)

Each is a place where the plan goes beyond, or differs from, the design or the brief it was written to. Most consequential first.

1. **One card for both document forms, one for both payment forms.** `BillFormCard` (225 lines) and `PaymentFormCard` (309 lines) become `DocumentFormCard` and `AllocationFormCard`, each taking a `kind` object: the words of one form, and its rules as references to that form's own functions. `BillFormCard`, `PaymentFormCard` and the new `InvoiceFormCard` and `ReceiptFormCard` are wrappers of about forty lines that keep their props, so `bills-view.tsx` and `payments-view.tsx` do not change. The alternative, a renamed neutral form type shared by bills and invoices, was ruled out because the 2b tests pin `BillForm`'s and `PaymentForm`'s field names (`supplier_id`, `bill_date`, `supplierId`, `bill_no`) with `toEqual`. What a bill and an invoice form share as pure code moves to `document-form.ts`; what the two payment forms share moves to `allocation-form.ts`; `bill-form.ts` and `payment-form.ts` re-export the names their importers use, as `bills.ts` did in 3a.
2. **"Record payment" opens on the Invoices screen,** with the customer chosen and the invoice ticked, exactly as "Pay" on a bill opens the payment form on Supplier Bills (`{ kind: 'pay' }` in `bills-view.tsx`). It does not navigate to Payments In.
3. **A payment in can only be voided: no edit, no delete.** The spec's Sales table says "edit, delete" for Payments In. That conflicts with the owner's decision that a posted document is locked, which stage 3a already applied (money in is posted the moment it is recorded, so there is never an unposted one to edit or delete). The row menu offers Void on a received payment and nothing else.
4. **e-Invois: a "Set e-Invois" choice on a posted invoice's row, opening a small card with a status select and a UUID box.** Its rules: the four statuses; the UUID is free text, trimmed, up to 100 characters, with no format check (LHDN's are 26 characters, but the column is plain text and nothing here talks to LHDN); with status None there is no UUID (choosing None empties and closes the box, and the schema refuses None with a UUID); Validated does not require a UUID. `einvoice_uuid` joins the invoice list row so the card opens on what is recorded; the table shows it as the badge's tooltip. It is not added to the CSV.
5. **New sentences for `FIN01` on an invoice and `FIN09` on a payment in.** `INVOICE_MESSAGES.locked` was "This invoice is posted and can no longer be changed. Void it instead.", which is false when the thing just tried was voiding an invoice someone else had voided a moment before. The menus never offer an action the status forbids, so `FIN01` now reaches a person only when the invoice changed under them, and the sentence is "This invoice has been posted or voided, so that can no longer be done.": true of every such case. For the same reason a payment in's `FIN09` is "This payment has already been voided." `BILL_MESSAGES.locked` and `MONEY_MESSAGES.locked` have the identical flaw and are **left as they are**, because this stage must not change how Supplier Bills and Payments Out behave; the gap is written into Known limits.
6. **`hasPayments` says where:** "This invoice has payments. Void them on Payments In before voiding it." The old "Void them before voiding it." was correct (a receipt cannot be deleted, unlike a scheduled payment out, so the bill sentence's "Void or delete them" would be wrong here); it now also says where.
7. **Voiding money in has its own function and action,** `voidPaymentIn` and `voidPaymentInAction`: the same status change, filtered to `direction = 'in'`, answering from the receipt sentences, refreshing `/finance/invoices`, `/finance/payments-in` and `/finance/customers-suppliers`. `voidPayment` and `voidPaymentAction` are untouched and stay on the purchase paths.
8. **One purchase-side sentence does change, for an error the app cannot produce.** The duplicate check in both payment schemas now compares ids without regard to capitals (one shared `eachOnce`), and a unique violation (23505) while *recording* a payment is worded as the duplicate sentence for both directions: "Each bill can appear once on a payment." where a direct duplicate used to get the general "could not be saved". Marking a payment paid keeps the general message for 23505. This is the same shared code after the fix, so both directions are fixed the same way, as the brief asked.
9. **Void is offered on every posted invoice, paid ones included, and refused with the reason when it has payments,** as on a paid bill. The alternative, hiding Void while anything has been received, would leave a person with no hint of how to void a paid invoice.
10. **Receivable on Customers & Suppliers is included because it is small** (Task 7): one read mirroring `listBillBalances`, one more argument to `contactsView`, one table column. It is its own task so the owner can drop it: skip Task 7 and nothing else changes (the sales actions would still refresh that screen, harmlessly). "Largest open balances" stays a chart of what is owed to suppliers, as its subtitle says.
11. **The stale customer filter is reset in state, during render,** not only hidden: `if (customer !== chosenCustomer) setCustomer(customer)`, React's documented way to adjust state when props change, with the rule in a tested pure function (`customerChoice`). An effect would draw one frame with the stale filter first.
12. **`saveAndPostBillAction` and `getBillAction` are rewritten onto two private helpers** (`saveThenPost`, `draftForEditing`) that the invoice actions share. Their behaviour and their tests are unchanged; the one visible difference is the text of the console line when a draft cannot be read.
13. **A product fills an invoice line at its `price`;** a bill line keeps taking its `cost`. This is why the line editor now takes the fill rule as a prop.
14. **"Save and post" in the form does not ask first; Post on a row does,** as on bills. The form's two buttons are side by side and the person has just read the whole invoice.
15. **The payment-in form takes off what an unposted payment holds of an invoice** (`heldByInvoice`), although the app never creates one, because the database counts them when it checks what is owed.
16. **New tests go in new files** (`finance-document-form`, `finance-allocation-form`, `finance-sales-data`, `finance-invoice-form`, `finance-receipt-form`, `finance-sales-rules`, `finance-sales-actions`, `finance-receivable`). Three stage 3a test files are edited where they pin a sentence or a row shape this plan changes on purpose (`finance-invoices`, `finance-payments-in`, `finance-sales-views`), and `finance-schemas` gains cases.
17. **Choosing a customer while the invoice date box is empty leaves the due date where it was.** The bill form blanks it in that case; that is left alone.

## Review Focus

The cases most likely to bite a person, each pinned by a test in the task that owns the code, or by a line of the controller's smoke test where only a browser can show it.

1. **A draft invoice open in one tab while it is posted, voided or deleted in another.** Expected: Save, Post, Delete, Void and Set e-Invois each answer with a sentence that is true ("has been posted or voided…", "no longer exists"), what was typed stays, and the list behind shows the invoice as it now is. (Task 2, `tests/finance-sales-data.test.ts`: "never tells a person to void what they have just tried to void", "says a draft has no e-Invois yet…"; Task 4, `tests/finance-sales-actions.test.ts`: "refreshes the screens after a refusal too…", "says the invoice was posted…"; smoke step 11.)
2. **A payment split across two invoices, voided from its second row.** Expected: the whole payment is voided whichever row was used, the question names the other invoice, both invoices owe again, and the cards counted it once. (Task 3, `tests/finance-sales-rules.test.ts`: "names the other invoices, whichever row the menu was opened from"; Task 5 sends `transaction_id`; smoke step 9.)
3. **An amount typed as `1,200.50`, a sen more than is owed, and an invoice paid off in another tab while it was ticked here.** Expected: each is refused in the form with a sentence before the database is asked; the paid-off invoice leaves the ticks and the total. (Task 3, `tests/finance-receipt-form.test.ts`: "refuses an empty amount, zero, and one typed with a comma", "refuses more than an invoice is owed, to the sen…", "drops a ticked invoice that was paid off while the form was open".)
4. **The same invoice twice in one payment, its id once in capitals; and a viewer calling a void directly.** Expected: "Each invoice can appear once on a payment." from the schema, and from the data layer if the database is the one to refuse; a viewer gets "You do not have permission…", never "That invoice no longer exists.". (Task 2, `tests/finance-sales-data.test.ts`: "is refused for an invoice whatever the capitals of its id", "is worded the same way when the database is the one to refuse it"; Task 4: "tells a viewer they may not, not that the invoice is gone".)
5. **An e-Invois recorded with a status of None and a UUID, a UUID of 101 characters, or on an invoice that is still a draft.** Expected: a sentence each time; only `einvoice_status`, `einvoice_uuid` and `updated_at` are ever written. (Task 2: "refuses a UUID with no status, after trimming", "changes only the two e-Invois columns and updated_at…"; Task 3, `tests/finance-invoice-form.test.ts`: "the e-Invois form".)
6. **The customer filter after that customer's last invoice is deleted, and then a new one is made for them.** Expected: the filter goes back to "All customers" and stays there; it does not silently re-apply. (Task 3, `tests/finance-sales-rules.test.ts`: "goes back to everyone when the chosen customer’s last invoice is gone"; the state reset is in Task 6; smoke step 12.)

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/finance/document-form.ts` | What the bill form and the invoice form share; `DocumentFormKind` |
| `src/lib/finance/allocation-form.ts` | What the two payment forms share; `AllocationFormKind` |
| `src/lib/finance/bill-form.ts`, `src/lib/finance/payment-form.ts` | (rewritten on the two shared files) same exports as before, plus `BILL_FORM_KIND` and `PAYMENT_OUT_KIND` |
| `src/lib/finance/invoice-form.ts` | The invoice form's rules, `INVOICE_FORM_KIND`, and the e-Invois form's rules |
| `src/lib/finance/receipt-form.ts` | The payment-in form's rules, `PAYMENT_IN_KIND` |
| `src/lib/finance/invoices.ts` | (modified) two sentences, `einvoice_uuid` on the list row, `setEInvoiceInput`, `setEInvoice`, `SaveAndPostInvoiceResult` |
| `src/lib/finance/money.ts` | (modified) duplicate check, 23505, `voidPaymentIn`, one sentence |
| `src/lib/finance/sales-views.ts`, `view-helpers.ts`, `purchase-views.ts` | (modified) menu rules, the customer filter's fallback, the shared "also covers" sentence |
| `src/lib/finance/contacts.ts` | (modified, Task 7) `listInvoiceBalances`, Receivable in `contactsView` |
| `src/app/(app)/finance/actions.ts` | (modified) nine new actions, two shared helpers |
| `src/components/finance/document-form-card.tsx` | The card for a bill or an invoice |
| `src/components/finance/allocation-form-card.tsx` | The card for a payment out or in |
| `src/components/finance/bill-form-card.tsx`, `payment-form-card.tsx` | (rewritten) thin wrappers, same props |
| `src/components/finance/line-items-editor.tsx` | (modified) takes the product fill rule as a prop |
| `src/components/finance/invoice-form-card.tsx`, `receipt-form-card.tsx` | Thin wrappers for the sales side |
| `src/components/finance/einvoice-card.tsx` | The e-Invois card |
| `src/components/finance/invoices-view.tsx`, `payments-in-view.tsx` | (rewritten) interactive client views |
| `src/screens/finance/invoices.tsx`, `payments-in.tsx` | (rewritten) loaders that pass a `writer` only to people who may edit |
| `src/screens/finance/sales-sample.ts`, `customers-suppliers.tsx` | (modified) row shape; Receivable |
| `src/components/finance/contacts-view.tsx` | (modified, Task 7) a Receivable column |
| `src/config/live-screens.ts`, `docs/bendahara-backend.md` | (modified) no longer say the screens are read-only |
| `tests/finance-document-form.test.ts`, `tests/finance-allocation-form.test.ts`, `tests/finance-sales-data.test.ts`, `tests/finance-invoice-form.test.ts`, `tests/finance-receipt-form.test.ts`, `tests/finance-sales-rules.test.ts`, `tests/finance-sales-actions.test.ts`, `tests/finance-receivable.test.ts` | New unit tests |
| `tests/finance-invoices.test.ts`, `tests/finance-payments-in.test.ts`, `tests/finance-sales-views.test.ts`, `tests/finance-schemas.test.ts` | (modified) pinned sentences, row shape, more schemas |

Names used across tasks, spelled once here:

- From `document-form.ts`: `LineDraft`, `emptyLine`, `lineDraft`, `filledFromProduct`, `lineNumbers`, `linePayload`, `defaultDueDate`, `followedDueDate`, `withDueDate`, `savedAsDraft`, `DocumentFormState`, `DocumentParty`, `DocumentFormKind`.
- From `allocation-form.ts`: `Payable`, `AllocationFormState`, `round2`, `sen`, `heldBy`, `partiesOf`, `amountText`, `defaultAccount`, `ticked`, `tickedAll`, `keptOffered`, `amountsTotal`, `typedAmounts`, `amountsError`, `AllocationFormKind`.
- From `invoice-form.ts`: `InvoiceForm`, `newInvoiceForm`, `invoiceFormFromDetail`, `withCustomer`, `withInvoiceDate`, `withSoldProduct`, `invoicePayload`, `invoiceFormError`, `invoiceSavedNotPosted`, `INVOICE_FORM_KIND`, `EInvoiceForm`, `eInvoiceForm`, `withEInvoiceStatus`, `eInvoicePayload`, `eInvoiceFormError`.
- From `receipt-form.ts`: `ReceivableInvoice`, `ReceiptForm`, `heldByInvoice`, `receivableInvoices`, `receiptCustomers`, `invoicesOf`, `newReceiptForm`, `chooseCustomer`, `toggleInvoice`, `toggleAllInvoices`, `keepReceivable`, `receiptTotal`, `receiptPayload`, `receiptFormError`, `PAYMENT_IN_KIND`.
- New in `invoices.ts`: `EINVOICE_STATUSES`, `EINVOICE_UUID_MAX`, `setEInvoiceInput`, `setEInvoice`, `SaveAndPostInvoiceResult`; `InvoiceListRow.einvoice_uuid`. New in `money.ts`: `voidPaymentIn`.
- New in `sales-views.ts`: `customerChoice`, `InvoiceAction`, `invoiceActions`, `paymentInActions`, `siblingInvoices`, `alsoCoversInvoices`. New in `view-helpers.ts`: `alsoCoversSentence`.
- New actions: `saveInvoiceAction`, `postInvoiceAction`, `voidInvoiceAction`, `deleteInvoiceAction`, `setEInvoiceAction`, `saveAndPostInvoiceAction`, `getInvoiceAction`, `recordPaymentInAction`, `voidPaymentInAction`.
- An invoice row's `display_status` is one of `draft`, `sent`, `overdue`, `paid`, `void`; the screen words `sent` "Sent". A payment-in row's `status` is `posted` when received; the screen words it "Received".

## What the database allows, and the sentence for each refusal

Nothing here is new in the database. The sentences in bold are the ones this plan changes or adds.

| Code | When it can reach a person on the sales screens | Sentence |
|---|---|---|
| `FIN01` | Saving, posting or deleting a draft that was posted or voided meanwhile; voiding or setting the e-Invois of an invoice that was voided meanwhile | **"This invoice has been posted or voided, so that can no longer be done."** |
| `FIN02` | Voiding an invoice that has payments | **"This invoice has payments. Void them on Payments In before voiding it."** |
| `FIN05` | Recording more than is still owed (someone else recorded a payment meanwhile) | "That is more than is still owed on an invoice." |
| `FIN04`, `FIN06` | Recording against an invoice that was voided meanwhile; invoices of two customers | "A payment can only go against a posted invoice." / "One payment can only pay invoices from one customer." |
| `FIN09` | Voiding a payment in that was voided meanwhile | **"This payment has already been voided."** |
| `FIN10` | Posting an invoice whose lines total nothing | "An invoice needs at least one line with an amount." |
| `FIN11` | Saving or posting an invoice that was deleted meanwhile | "That invoice no longer exists." |
| `23514` | Setting the e-Invois of a draft (only by a direct call: the menu does not offer it) | **"e-Invois details can be recorded once the invoice is posted."** |
| `23505` | The same invoice twice on one payment (only by a direct call: the schema refuses it first) | **"Each invoice can appear once on a payment."** |
| `42501` | Row-level security refused the write | "You do not have permission to make changes here." |
| no row | Void, delete or set e-Invois matched nothing | "That invoice no longer exists." / "That payment no longer exists." |

A draft can be edited, posted and deleted. A posted invoice can be voided (not while a payment that is posted, scheduled or in progress is allocated to it) and can have `einvoice_status` and `einvoice_uuid` changed, with `updated_at`, and nothing else in the same update. A void invoice can have nothing changed. A payment in is posted by `finance_record_payment_in` in one transaction and can then only be voided.

---

### Task 1: One card for both document forms, one for both payment forms

A refactor. Nothing a person can see changes on Supplier Bills or Payments Out, and no existing test file is edited.

**Files:**
- Create: `src/lib/finance/document-form.ts`
- Create: `src/lib/finance/allocation-form.ts`
- Replace: `src/lib/finance/bill-form.ts`
- Replace: `src/lib/finance/payment-form.ts`
- Create: `src/components/finance/document-form-card.tsx`
- Create: `src/components/finance/allocation-form-card.tsx`
- Replace: `src/components/finance/bill-form-card.tsx`
- Replace: `src/components/finance/payment-form-card.tsx`
- Modify: `src/components/finance/line-items-editor.tsx`
- Create: `tests/finance-document-form.test.ts`
- Create: `tests/finance-allocation-form.test.ts`

**Interfaces:**
- Consumes: `addDaysIso`, `billTotals`, `LineNumbers` from `@/lib/finance/bill-math`; `isIsoDate`, `roundRate`, `DocumentLineRow`, `DOCUMENT_LINES_MAX` from `@/lib/finance/document-lines`; `typedNumber`, `rm` from `@/lib/finance/format`; `saveBillInput`, `BILL_MESSAGES`, `BillDetail`, `BillListRow`, `SaveAndPostResult` from `@/lib/finance/bills`; `recordPaymentOutInput`, `MONEY_MESSAGES`, `FinanceAccount`, `PaymentMethod`, `PaymentOutRow`, `PAYMENT_METHODS`, `PAYMENT_METHOD_LABELS` from `@/lib/finance/money`; `displayDate` from `@/lib/finance/view-helpers`; `useFinanceAction`, `BentoCard`.
- Produces:
  - `@/lib/finance/document-form`: `type LineDraft`, `emptyLine(key: string): LineDraft`, `lineDraft(line: DocumentLineRow): LineDraft`, `filledFromProduct(line: LineDraft, product: FinanceProduct | null, unitPrice: number): LineDraft`, `lineNumbers(line: LineDraft): LineNumbers`, `linePayload(line: LineDraft)`, `defaultDueDate(date: string, termsDays: number | undefined): string`, `followedDueDate(form: { due_date: string; dueEdited: boolean }, date: string, termsDays: number | undefined): string`, `withDueDate<F>(form: F, dueDate: string): F`, `savedAsDraft(noun: 'bill' | 'invoice', error: string): string`, `type DocumentFormState`, `type DocumentParty = { id: string; name: string; payment_terms_days: number }`, `type DocumentFormKind<F>`.
  - `@/lib/finance/allocation-form`: `type Payable = { id: string; due_date: string; overdue: boolean; payable: number }`, `type AllocationFormState`, `round2`, `sen`, `heldBy(payments, documentId)`, `partiesOf(documents, partyId, partyName): { id: string; name: string; open: number }[]`, `amountText(amount: number): string`, `defaultAccount(accounts: FinanceAccount[]): string`, `ticked(form, document, on)`, `tickedAll(form, documents, on)`, `keptOffered(form, offered)`, `amountsTotal(amounts): number`, `typedAmounts(amounts): { id: string; amount: number }[]`, `amountsError(amounts, offered, messages): string | null`, `type AllocationFormKind<F, D>`.
  - `@/lib/finance/bill-form`: every export it has today (`LineDraft`, `BillForm`, `emptyLine`, `newBillForm`, `billFormFromDetail`, `defaultDueDate`, `withSupplier`, `withBillDate`, `withDueDate`, `withProduct`, `lineNumbers`, `billPayload`, `billFormError`, `savedNotPosted`), plus `BILL_FORM_KIND: DocumentFormKind<BillForm>`.
  - `@/lib/finance/payment-form`: every export it has today, plus `PAYMENT_OUT_KIND: AllocationFormKind<PaymentForm, PayableBill>`.
  - `@/components/finance/document-form-card`: `type DocumentFormActions = { save: (input: unknown) => Promise<FinResult<{ id: string }>>; saveAndPost: (input: unknown) => Promise<FinResult<unknown> & { draftId?: string }> }`; `DocumentFormCard<F>({ kind, initial, parties, products, actions, onClose }: { kind: DocumentFormKind<F>; initial: () => F; parties: DocumentParty[]; products: FinanceProduct[]; actions: DocumentFormActions; onClose: () => void })`.
  - `@/components/finance/allocation-form-card`: `type RecordPayment = (input: unknown) => Promise<FinResult<{ id: string }>>`; `AllocationFormCard<F, D>({ kind, documents, accounts, today, preselect, record, onClose }: { kind: AllocationFormKind<F, D>; documents: D[]; accounts: FinanceAccount[]; today: string; preselect?: { partyId: string; documentId: string }; record: RecordPayment; onClose: () => void })`.
  - `@/components/finance/bill-form-card` and `@/components/finance/payment-form-card`: the same exports and props as today (`BillFormCard`, `BillFormActions`, `PaymentFormCard`, `RecordPayment`).
  - `LineItemsEditor` gains a required prop `withProduct: (line: LineDraft, product: FinanceProduct | null) => LineDraft`.

How the sharing works:

- A card knows nothing about suppliers or customers. It asks its `kind` for every word and every rule. A kind is an object of references to the form's own functions (`BILL_FORM_KIND.error` *is* `billFormError`), so the functions the 2b tests pin are the functions the card runs. The new tests check that identity.
- `BillForm` and `PaymentForm` keep their field names. The card reads a form's party and date through `kind.partyId(form)` and `kind.date(form)`.
- `withSupplier` keeps its own line for the due date, not `followedDueDate`: with the bill date box empty it has always blanked the due date, and this task changes no bill behaviour.

- [ ] **Step 1: Write the failing tests**

Create `tests/finance-document-form.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  BILL_FORM_KIND,
  billFormError,
  billPayload,
  emptyLine as billEmptyLine,
  lineNumbers as billLineNumbers,
  newBillForm,
  savedNotPosted,
  withBillDate,
  withDueDate as billWithDueDate,
  withProduct,
  withSupplier,
} from '@/lib/finance/bill-form';
import {
  defaultDueDate,
  emptyLine,
  filledFromProduct,
  followedDueDate,
  lineDraft,
  lineNumbers,
  linePayload,
  savedAsDraft,
  withDueDate,
} from '@/lib/finance/document-form';
import type { FinanceProduct } from '@/lib/finance/products';
import { WRITE_FAILED } from '@/lib/finance/result';

const PRODUCT = '99999999-9999-4999-8999-999999999999';

const gloves: FinanceProduct = {
  id: PRODUCT,
  sku: 'PRD-010',
  name: 'Nitrile Gloves (Box)',
  type: 'product',
  category: 'Consumables',
  uom: 'box',
  price: 24.9,
  cost: 12.5,
  sst_rate: 6,
  active: true,
};

describe('what the bill form and the invoice form share', () => {
  it('is one definition: bill-form.ts hands on the same functions', () => {
    expect(billEmptyLine).toBe(emptyLine);
    expect(billLineNumbers).toBe(lineNumbers);
    expect(billWithDueDate).toBe(withDueDate);
  });

  it('fills a line from a product at the price it is given, keeping the quantity and the pack size', () => {
    const line = { ...emptyLine('k1'), description: 'typed by hand', quantity: '4', unit_price: '9', pack_size: '100 pcs' };
    expect(filledFromProduct(line, gloves, gloves.price)).toEqual({
      key: 'k1',
      product_id: PRODUCT,
      description: 'Nitrile Gloves (Box)',
      quantity: '4',
      uom: 'box',
      pack_size: '100 pcs',
      unit_price: '24.9',
      sst_rate: '6',
    });
    expect(filledFromProduct(line, null, 0)).toEqual({ ...line, product_id: '' });
  });

  it('shows a saved line as text, with nothing for what was left empty', () => {
    expect(
      lineDraft({ id: 'line-2', product_id: null, description: 'Delivery', quantity: 1.5, uom: null, pack_size: null, unit_price: 0, sst_rate: 8, amount: 0, sst_amount: 0 }),
    ).toEqual({ key: 'line-2', product_id: '', description: 'Delivery', quantity: '1.5', uom: '', pack_size: '', unit_price: '0', sst_rate: '8' });
  });

  it('sends a line as numbers, without its key', () => {
    const line = { ...emptyLine('k1'), product_id: PRODUCT, description: ' Gloves ', quantity: '10', uom: 'box', unit_price: '12.50', sst_rate: '6' };
    expect(linePayload(line)).toEqual({
      product_id: PRODUCT,
      description: ' Gloves ',
      uom: 'box',
      pack_size: '',
      quantity: 10,
      unit_price: 12.5,
      sst_rate: 6,
    });
    expect(Number.isNaN(linePayload({ ...line, quantity: '1,000' }).quantity)).toBe(true);
  });

  it('moves the due date with the date and the terms until it is set by hand', () => {
    const following = { due_date: '2026-10-11', dueEdited: false };
    expect(defaultDueDate('2026-10-11', 30)).toBe('2026-11-10');
    expect(followedDueDate(following, '2026-12-15', 30)).toBe('2027-01-14');
    expect(followedDueDate(following, '2026-12-15', undefined)).toBe('2026-12-15');
    // Half typed, or cleared: it stays where it was.
    expect(followedDueDate(following, '', 30)).toBe('2026-10-11');
    expect(followedDueDate(following, '0002-10-11', 30)).toBe('2026-10-11');
    const byHand = withDueDate(following, '2026-10-25');
    expect(byHand).toEqual({ due_date: '2026-10-25', dueEdited: true });
    expect(followedDueDate(byHand, '2026-12-15', 30)).toBe('2026-10-25');
  });

  it('words "saved but not posted" for either document', () => {
    expect(savedAsDraft('invoice', WRITE_FAILED)).toBe('The invoice was saved as a draft, but posting it failed. Please try again.');
    expect(savedAsDraft('invoice', 'Add at least one line.')).toBe('The invoice was saved as a draft, but it was not posted. Add at least one line.');
    expect(savedAsDraft('bill', WRITE_FAILED)).toBe(savedNotPosted(WRITE_FAILED));
  });
});

describe('the bill form, as the shared card draws it', () => {
  const form = withSupplier(newBillForm('2026-10-11', 'k1'), { id: 'lim', payment_terms_days: 30 });

  it('is the bill form’s own rules, not a second set', () => {
    expect(BILL_FORM_KIND.withParty).toBe(withSupplier);
    expect(BILL_FORM_KIND.withDate).toBe(withBillDate);
    expect(BILL_FORM_KIND.withProduct).toBe(withProduct);
    expect(BILL_FORM_KIND.error).toBe(billFormError);
    expect(BILL_FORM_KIND.payload).toBe(billPayload);
    expect(BILL_FORM_KIND.savedNotPosted).toBe(savedNotPosted);
  });

  it('reads the supplier and the bill date, and keeps the supplier’s reference', () => {
    expect(BILL_FORM_KIND.partyId(form)).toBe('lim');
    expect(BILL_FORM_KIND.date(form)).toBe('2026-10-11');
    expect(BILL_FORM_KIND.reference?.set(form, 'INV 88')).toEqual({ ...form, supplier_ref: 'INV 88' });
    expect(BILL_FORM_KIND.reference?.get({ ...form, supplier_ref: 'INV 88' })).toBe('INV 88');
  });

  it('fills a bill line from the product’s cost', () => {
    expect(BILL_FORM_KIND.withProduct(emptyLine('k1'), gloves).unit_price).toBe('12.5');
  });

  it('says supplier and bill', () => {
    expect([BILL_FORM_KIND.noun, BILL_FORM_KIND.party, BILL_FORM_KIND.dateLabel]).toEqual(['bill', 'supplier', 'Bill date']);
  });
});
```

Create `tests/finance-allocation-form.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  amountText,
  amountsError,
  amountsTotal,
  defaultAccount,
  heldBy,
  keptOffered,
  partiesOf,
  ticked,
  tickedAll,
  typedAmounts,
} from '@/lib/finance/allocation-form';
import type { FinanceAccount } from '@/lib/finance/money';
import {
  PAYMENT_OUT_KIND,
  type PayableBill,
  amountText as paymentAmountText,
  billsOf,
  chooseSupplier,
  keepPayable,
  paymentFormError,
  paymentPayload,
  paymentTotal,
  toggleAll,
  toggleBill,
} from '@/lib/finance/payment-form';

const LIM = '11111111-1111-4111-8111-111111111111';
const MAJU = '22222222-2222-4222-8222-222222222222';
const BANK = '66666666-6666-4666-8666-666666666666';
const CASH = '77777777-7777-4777-8777-777777777777';

const accounts: FinanceAccount[] = [
  { id: CASH, name: 'Cash in hand', kind: 'cash', bank_name: null },
  { id: BANK, name: 'Main Bank', kind: 'bank', bank_name: 'Maybank' },
];

const doc = (id: string, payable: number) => ({ id, payable });
const messages = { amount: 'Enter an amount above 0.', tooMuch: 'That is more than is still owed.' };

describe('what the two payment forms share', () => {
  it('is one definition: payment-form.ts hands on the same amountText', () => {
    expect(paymentAmountText).toBe(amountText);
    expect(amountText(1200.5)).toBe('1200.50');
  });

  it('adds up what unposted payments hold of each document, to the sen, by whatever id it is given', () => {
    const rows = [
      { status: 'scheduled' as const, amount: 0.1, invoice_id: 'a' },
      { status: 'draft' as const, amount: 0.2, invoice_id: 'a' },
      { status: 'pending_approval' as const, amount: 5, invoice_id: 'b' },
      { status: 'posted' as const, amount: 99, invoice_id: 'a' },
      { status: 'void' as const, amount: 99, invoice_id: 'c' },
      { status: 'rejected' as const, amount: 99, invoice_id: 'c' },
    ];
    expect(heldBy(rows, (r) => r.invoice_id)).toEqual({ a: 0.3, b: 5 });
    expect(heldBy([], () => 'x')).toEqual({});
  });

  it('lists each party once, by name, with how many documents are open', () => {
    const docs = [
      { party: MAJU, name: 'Maju Jaya' },
      { party: LIM, name: 'Lim Hardware' },
      { party: LIM, name: 'Lim Hardware' },
    ];
    expect(partiesOf(docs, (d) => d.party, (d) => d.name)).toEqual([
      { id: LIM, name: 'Lim Hardware', open: 2 },
      { id: MAJU, name: 'Maju Jaya', open: 1 },
    ]);
  });

  it('defaults to the first bank account, then to any account, then to none', () => {
    expect(defaultAccount(accounts)).toBe(BANK);
    expect(defaultAccount([accounts[0]])).toBe(CASH);
    expect(defaultAccount([])).toBe('');
  });

  it('ticks a document for all it can take, unticks it, and ticks or clears them all, keeping the rest of the form', () => {
    const form = { partyId: LIM, amounts: { a: '10.00' } };
    expect(ticked(form, doc('b', 80.1), true)).toEqual({ partyId: LIM, amounts: { a: '10.00', b: '80.10' } });
    expect(ticked(form, doc('a', 10), false)).toEqual({ partyId: LIM, amounts: {} });
    expect(tickedAll(form, [doc('b', 1), doc('c', 2.5)], true).amounts).toEqual({ b: '1.00', c: '2.50' });
    expect(tickedAll(form, [doc('b', 1)], false)).toEqual({ partyId: LIM, amounts: {} });
  });

  it('drops a ticked document that is no longer offered, and is the same form when nothing goes', () => {
    const form = { amounts: { a: '10.00', b: '5.00' } };
    expect(keptOffered(form, [{ id: 'a' }])).toEqual({ amounts: { a: '10.00' } });
    expect(keptOffered(form, [{ id: 'a' }, { id: 'b' }, { id: 'c' }])).toBe(form);
  });

  it('totals in whole sen, counting only amounts that are numbers above 0', () => {
    expect(amountsTotal({ a: '0.10', b: '0.20' })).toBe(0.3);
    expect(amountsTotal({ a: '1,200.50', b: '', c: '-5', d: '7' })).toBe(7);
    expect(amountsTotal({})).toBe(0);
  });

  it('reads the typed amounts as numbers, and a box that is not a number as NaN', () => {
    const typed = typedAmounts({ a: '12.50', b: '1,200.50' });
    expect(typed[0]).toEqual({ id: 'a', amount: 12.5 });
    expect(typed[1].id).toBe('b');
    expect(Number.isNaN(typed[1].amount)).toBe(true);
  });

  it('refuses an amount that is not above 0, one typed with a comma, and a sen more than a document can take', () => {
    const offered = [doc('a', 100), doc('b', 80.1)];
    expect(amountsError({ a: '100.00', b: '80.10' }, offered, messages)).toBeNull();
    expect(amountsError({ a: '' }, offered, messages)).toBe(messages.amount);
    expect(amountsError({ a: '0' }, offered, messages)).toBe(messages.amount);
    expect(amountsError({ a: '0.004' }, offered, messages)).toBe(messages.amount);
    expect(amountsError({ a: '1,200.50' }, offered, messages)).toBe(messages.amount);
    expect(amountsError({ b: '80.11' }, offered, messages)).toBe(messages.tooMuch);
    // Paid off or voided since the form opened: no longer offered.
    expect(amountsError({ c: '1' }, offered, messages)).toBe(messages.tooMuch);
  });
});

describe('the payment-out form, as the shared card draws it', () => {
  const bill = (n: number, b: Partial<PayableBill> = {}): PayableBill => ({
    id: `bill-${n}`,
    bill_no: `BILL-000${n}`,
    supplier_id: LIM,
    supplier_name: 'Lim Hardware',
    due_date: '2026-10-31',
    overdue: false,
    balance: 100,
    scheduled: 0,
    payable: 100,
    ...b,
  });
  const payable = [bill(1), bill(2, { balance: 500, scheduled: 200, payable: 300 }), bill(3, { supplier_id: MAJU, supplier_name: 'Maju Jaya' })];

  it('is the payment form’s own rules, not a second set', () => {
    expect(PAYMENT_OUT_KIND.chooseParty).toBe(chooseSupplier);
    expect(PAYMENT_OUT_KIND.documentsOf).toBe(billsOf);
    expect(PAYMENT_OUT_KIND.toggle).toBe(toggleBill);
    expect(PAYMENT_OUT_KIND.toggleAll).toBe(toggleAll);
    expect(PAYMENT_OUT_KIND.keep).toBe(keepPayable);
    expect(PAYMENT_OUT_KIND.total).toBe(paymentTotal);
    expect(PAYMENT_OUT_KIND.error).toBe(paymentFormError);
    expect(PAYMENT_OUT_KIND.payload).toBe(paymentPayload);
  });

  it('opens from a bill’s row with that supplier chosen and that bill ticked for all it can take', () => {
    const form = PAYMENT_OUT_KIND.newForm(payable, accounts, '2026-10-11', { partyId: LIM, documentId: 'bill-2' });
    expect(form).toMatchObject({ supplierId: LIM, amounts: { 'bill-2': '300.00' }, accountId: BANK, date: '2026-10-11', scheduled: false });
    expect(PAYMENT_OUT_KIND.partyId(form)).toBe(LIM);
    expect(PAYMENT_OUT_KIND.newForm(payable, accounts, '2026-10-11').supplierId).toBe('');
  });

  it('lists the suppliers with how many bills are open', () => {
    expect(PAYMENT_OUT_KIND.parties(payable)).toEqual([
      { id: LIM, name: 'Lim Hardware', open: 2 },
      { id: MAJU, name: 'Maju Jaya', open: 1 },
    ]);
  });

  it('words a bill as the form always has: what it can take, and what is already scheduled', () => {
    expect(PAYMENT_OUT_KIND.number(payable[0])).toBe('BILL-0001');
    expect(PAYMENT_OUT_KIND.owed(payable[0])).toBe('RM 100.00 to pay');
    expect(PAYMENT_OUT_KIND.owed(payable[1])).toBe('RM 300.00 to pay · RM 200.00 of RM 500.00 already scheduled');
    expect(PAYMENT_OUT_KIND.amountLabel(payable[0])).toBe('Amount to pay on BILL-0001');
    expect(PAYMENT_OUT_KIND.words).toMatchObject({
      subtitle: 'Pay a supplier\'s bills, now or later',
      party: 'supplier',
      document: 'bill',
      documents: 'Bills to pay',
      account: 'Paid from',
      date: 'Date paid',
      submit: 'Record payment',
    });
  });

  it('can be scheduled for later', () => {
    const form = PAYMENT_OUT_KIND.newForm(payable, accounts, '2026-10-11');
    const later = PAYMENT_OUT_KIND.schedule?.set(form, true);
    expect(later).toEqual({ ...form, scheduled: true });
    expect(later ? PAYMENT_OUT_KIND.schedule?.is(later) : undefined).toBe(true);
    expect(PAYMENT_OUT_KIND.schedule?.is(form)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm exec vitest run tests/finance-document-form.test.ts tests/finance-allocation-form.test.ts`
Expected: both files FAIL to load, with `Cannot find package '@/lib/finance/document-form'` and `Cannot find package '@/lib/finance/allocation-form'`: neither exists yet.

- [ ] **Step 3: Write the shared rules of the two document forms**

Create `src/lib/finance/document-form.ts`:

```ts
/**
 * What the bill form and the invoice form share: a line as the person typed
 * it, the due date that follows the other party's payment terms, the sentence
 * for "saved but not posted", and the description of one form
 * (`DocumentFormKind`) that the shared card draws. Pure. Every box is held as
 * the text the person typed.
 */
import { addDaysIso, type LineNumbers } from './bill-math';
import { type DocumentLineRow, isIsoDate, roundRate } from './document-lines';
import { typedNumber } from './format';
import type { FinanceProduct } from './products';
import { WRITE_FAILED } from './result';

export type LineDraft = {
  /** Stable for React while the form is open; never sent. */
  key: string;
  product_id: string;
  description: string;
  quantity: string;
  uom: string;
  /** Not shown in the editor; carried so editing a draft does not drop it. */
  pack_size: string;
  unit_price: string;
  sst_rate: string;
};

export function emptyLine(key: string): LineDraft {
  return { key, product_id: '', description: '', quantity: '1', uom: '', pack_size: '', unit_price: '', sst_rate: '0' };
}

/** A saved line, as the form shows it. */
export function lineDraft(line: DocumentLineRow): LineDraft {
  return {
    key: line.id,
    product_id: line.product_id ?? '',
    description: line.description,
    quantity: String(line.quantity),
    uom: line.uom ?? '',
    pack_size: line.pack_size ?? '',
    unit_price: String(line.unit_price),
    sst_rate: String(line.sst_rate),
  };
}

/**
 * Choosing a product fills the line from it: its name, unit, SST rate and
 * `unitPrice`, which is the product's cost on a bill and its price on an
 * invoice. The person can then change any of them. Choosing "no product"
 * only clears the link.
 */
export function filledFromProduct(line: LineDraft, product: FinanceProduct | null, unitPrice: number): LineDraft {
  if (!product) return { ...line, product_id: '' };
  return {
    ...line,
    product_id: product.id,
    description: product.name,
    uom: product.uom,
    unit_price: String(unitPrice),
    sst_rate: String(product.sst_rate),
  };
}

/** An empty SST box means no SST. The rate keeps two decimals, as it is stored. */
function sstRate(text: string): number {
  return text.trim() === '' ? 0 : roundRate(typedNumber(text) ?? Number.NaN);
}

/** The line's figures for the live total; a box that is not a number is NaN, which counts as nothing. */
export function lineNumbers(line: LineDraft): LineNumbers {
  return {
    quantity: typedNumber(line.quantity) ?? Number.NaN,
    unit_price: typedNumber(line.unit_price) ?? Number.NaN,
    sst_rate: sstRate(line.sst_rate),
  };
}

/** One line as it is sent. Figures are numbers; a box that is not a number goes as NaN and is refused. */
export function linePayload(line: LineDraft) {
  return {
    product_id: line.product_id,
    description: line.description,
    uom: line.uom,
    pack_size: line.pack_size,
    ...lineNumbers(line),
  };
}

/** The document's date plus the other party's payment terms; with no party yet, the date itself. */
export function defaultDueDate(date: string, termsDays: number | undefined): string {
  return addDaysIso(date, termsDays ?? 0);
}

/**
 * The due date after the document's date or its party changed: it follows,
 * unless it was set by hand. While the date is half typed it stays where it
 * was.
 */
export function followedDueDate(
  form: { due_date: string; dueEdited: boolean },
  date: string,
  termsDays: number | undefined,
): string {
  return !form.dueEdited && isIsoDate(date) ? defaultDueDate(date, termsDays) : form.due_date;
}

/** Once the person sets the due date by hand, it is no longer recalculated. */
export function withDueDate<F extends { due_date: string; dueEdited: boolean }>(form: F, dueDate: string): F {
  return { ...form, due_date: dueDate, dueEdited: true };
}

/** What a form says when its document was saved as a draft but posting it was refused. */
export function savedAsDraft(noun: 'bill' | 'invoice', error: string): string {
  if (error === WRITE_FAILED) return `The ${noun} was saved as a draft, but posting it failed. Please try again.`;
  return `The ${noun} was saved as a draft, but it was not posted. ${error}`;
}

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

/** The customer or supplier a document is for, as its picker lists it. */
export type DocumentParty = { id: string; name: string; payment_terms_days: number };

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
  /** A second text box beside the party: the supplier's own reference on a bill. An invoice has none. */
  reference?: { label: string; placeholder: string; get: (form: F) => string; set: (form: F, value: string) => F };
  withProduct: (line: LineDraft, product: FinanceProduct | null) => LineDraft;
  /** The first thing wrong with the form, or null. `posting` also refuses a total of nothing. */
  error: (form: F, posting?: boolean) => string | null;
  /** What is sent to the save action. */
  payload: (form: F) => unknown;
  savedNotPosted: (error: string) => string;
};
```

- [ ] **Step 4: Put the bill form on them**

Replace the whole of `src/lib/finance/bill-form.ts` with:

```ts
/**
 * The bill form's rules, kept out of the components so they can be tested:
 * what a new form holds, what choosing a supplier, a date or a product
 * changes, what is wrong with the form, and what is sent to saveBillAction.
 * Pure. What an invoice form shares is in document-form.ts.
 */
import { billTotals } from './bill-math';
import { type BillDetail, BILL_MESSAGES, saveBillInput } from './bills';
import {
  type DocumentFormKind,
  type LineDraft,
  defaultDueDate,
  emptyLine,
  filledFromProduct,
  followedDueDate,
  lineDraft,
  lineNumbers,
  linePayload,
  savedAsDraft,
} from './document-form';
import type { FinanceProduct } from './products';

// Defined in document-form.ts, which the invoice form shares; exported from here for this module's existing importers.
export { type LineDraft, defaultDueDate, emptyLine, lineNumbers, withDueDate } from './document-form';

export type BillForm = {
  /** Present when a saved draft is being changed. */
  id?: string;
  supplier_id: string;
  supplier_ref: string;
  bill_date: string;
  due_date: string;
  /** Once the person sets the due date by hand, it is no longer recalculated. */
  dueEdited: boolean;
  notes: string;
  lines: LineDraft[];
};

/** A new bill dated today with one empty line. The due date follows once a supplier is chosen. */
export function newBillForm(today: string, lineKey: string): BillForm {
  return {
    supplier_id: '',
    supplier_ref: '',
    bill_date: today,
    due_date: today,
    dueEdited: false,
    notes: '',
    lines: [emptyLine(lineKey)],
  };
}

/** A saved draft, as the form shows it. Its due date was chosen already, so it is kept. */
export function billFormFromDetail(bill: BillDetail): BillForm {
  return {
    id: bill.id,
    supplier_id: bill.supplier_id,
    supplier_ref: bill.supplier_ref ?? '',
    bill_date: bill.bill_date,
    due_date: bill.due_date,
    dueEdited: true,
    notes: bill.notes ?? '',
    lines: bill.lines.map(lineDraft),
  };
}

/** Choosing a supplier moves the due date to their terms, unless it was set by hand. */
export function withSupplier(form: BillForm, supplier: { id: string; payment_terms_days: number }): BillForm {
  return {
    ...form,
    supplier_id: supplier.id,
    due_date: form.dueEdited ? form.due_date : defaultDueDate(form.bill_date, supplier.payment_terms_days),
  };
}

/**
 * Changing the bill date moves the due date with it, unless it was set by
 * hand. While the bill date is half typed the due date stays where it was.
 */
export function withBillDate(form: BillForm, billDate: string, termsDays: number | undefined): BillForm {
  return { ...form, bill_date: billDate, due_date: followedDueDate(form, billDate, termsDays) };
}

/**
 * Choosing a product fills the line from it: its name, unit, cost (what the
 * workspace pays for it) and SST rate. The person can then change any of
 * them. Choosing "no product" only clears the link.
 */
export function withProduct(line: LineDraft, product: FinanceProduct | null): LineDraft {
  return filledFromProduct(line, product, product?.cost ?? 0);
}

/** What is sent to saveBillAction. Figures are numbers; a box that is not a number goes as NaN and is refused. */
export function billPayload(form: BillForm) {
  return {
    ...(form.id ? { id: form.id } : {}),
    supplier_id: form.supplier_id,
    supplier_ref: form.supplier_ref,
    bill_date: form.bill_date,
    due_date: form.due_date,
    notes: form.notes,
    lines: form.lines.map(linePayload),
  };
}

/**
 * The first thing wrong with the form, in the schema's own sentence, or null
 * when it can be sent. A draft may total nothing; a bill being posted may not,
 * and saying so here saves a draft the database would then refuse to post.
 */
export function billFormError(form: BillForm, posting = false): string | null {
  const parsed = saveBillInput.safeParse(billPayload(form));
  if (!parsed.success) return parsed.error.issues[0]?.message ?? BILL_MESSAGES.lines;
  if (posting && billTotals(form.lines.map(lineNumbers)).total <= 0) return BILL_MESSAGES.empty;
  return null;
}

/** What the form says when the bill was saved as a draft but posting it was refused. */
export function savedNotPosted(error: string): string {
  return savedAsDraft('bill', error);
}

/** The bill form, as the shared card draws it. */
export const BILL_FORM_KIND: DocumentFormKind<BillForm> = {
  noun: 'bill',
  party: 'supplier',
  dateLabel: 'Bill date',
  partyId: (form) => form.supplier_id,
  date: (form) => form.bill_date,
  withParty: withSupplier,
  withDate: withBillDate,
  reference: {
    label: 'Supplier’s reference',
    placeholder: 'Their invoice no.',
    get: (form) => form.supplier_ref,
    set: (form, value) => ({ ...form, supplier_ref: value }),
  },
  withProduct,
  error: billFormError,
  payload: billPayload,
  savedNotPosted,
};
```

- [ ] **Step 5: Write the shared rules of the two payment forms**

Create `src/lib/finance/allocation-form.ts`:

```ts
/**
 * What the payment-out form and the payment-in form share: one payment from
 * or to one party, split across that party's open documents, each for no
 * more than it can still take. Also the description of one such form
 * (`AllocationFormKind`) that the shared card draws. Pure. Amounts are held
 * as the text the person typed and added up in whole sen.
 */
import { typedNumber } from './format';
import type { FinanceAccount, PaymentMethod, PaymentOutRow } from './money';

/** What the form needs to know of a document that can take a payment. */
export type Payable = {
  id: string;
  due_date: string;
  overdue: boolean;
  /** What a new payment may take. */
  payable: number;
};

/** What every payment form holds, whichever way the money goes. */
export type AllocationFormState = {
  /** The ticked documents, each with the amount as typed. */
  amounts: Record<string, string>;
  accountId: string;
  date: string;
  method: PaymentMethod;
  reference: string;
  notes: string;
};

export const round2 = (n: number) => Math.round(n * 100) / 100;
export const sen = (n: number) => Math.round(n * 100);

/** A payment in one of these states has not paid the document yet, but the database already counts it against the document. */
const HOLDING: ReadonlySet<PaymentOutRow['status']> = new Set(['draft', 'pending_approval', 'scheduled']);

/**
 * What payments that are not yet posted already hold of each document, to the
 * sen, by document id. A document with nothing held is not in the answer.
 */
export function heldBy<R extends { status: PaymentOutRow['status']; amount: number }>(
  payments: R[],
  documentId: (payment: R) => string,
): Record<string, number> {
  const held = new Map<string, number>();
  for (const p of payments) {
    if (HOLDING.has(p.status)) held.set(documentId(p), (held.get(documentId(p)) ?? 0) + sen(p.amount));
  }
  return Object.fromEntries([...held].filter(([, total]) => total > 0).map(([id, total]) => [id, total / 100]));
}

/** The parties that have at least one document to pay, by name, with how many. */
export function partiesOf<D>(
  documents: D[],
  partyId: (document: D) => string,
  partyName: (document: D) => string,
): { id: string; name: string; open: number }[] {
  const parties = new Map<string, { id: string; name: string; open: number }>();
  for (const d of documents) {
    const entry = parties.get(partyId(d)) ?? { id: partyId(d), name: partyName(d), open: 0 };
    entry.open += 1;
    parties.set(entry.id, entry);
  }
  return [...parties.values()].sort((x, y) => x.name.localeCompare(y.name));
}

/** 1200.5 → "1200.50", the way an amount box shows it. */
export function amountText(amount: number): string {
  return amount.toFixed(2);
}

/** The first bank account, or the first account of any kind. */
export function defaultAccount(accounts: FinanceAccount[]): string {
  return (accounts.find((a) => a.kind === 'bank') ?? accounts[0])?.id ?? '';
}

/** Ticks a document for all it can still take, or unticks it. */
export function ticked<F extends { amounts: Record<string, string> }>(
  form: F,
  document: { id: string; payable: number },
  on: boolean,
): F {
  const amounts = { ...form.amounts };
  if (on) amounts[document.id] = amountText(document.payable);
  else delete amounts[document.id];
  return { ...form, amounts };
}

/** Ticks every document given, each for all it can still take, or clears them all. */
export function tickedAll<F extends { amounts: Record<string, string> }>(
  form: F,
  documents: { id: string; payable: number }[],
  on: boolean,
): F {
  return { ...form, amounts: on ? Object.fromEntries(documents.map((d) => [d.id, amountText(d.payable)])) : {} };
}

/**
 * After a refresh, a ticked document that was paid off or voided meanwhile is
 * no longer offered. Its amount goes, so the total, the count and the save
 * stay true to what the person can see. The same form when nothing goes.
 */
export function keptOffered<F extends { amounts: Record<string, string> }>(form: F, offered: { id: string }[]): F {
  const ids = new Set(offered.map((d) => d.id));
  const entries = Object.entries(form.amounts);
  const kept = entries.filter(([id]) => ids.has(id));
  return kept.length === entries.length ? form : { ...form, amounts: Object.fromEntries(kept) };
}

/** The running total: every ticked amount that is a number above 0. */
export function amountsTotal(amounts: Record<string, string>): number {
  let total = 0;
  for (const text of Object.values(amounts)) {
    const amount = typedNumber(text);
    if (amount !== null && amount > 0) total += sen(amount);
  }
  return total / 100;
}

/** The ticked amounts as numbers, by document id; a box that is not a number is NaN, and is refused when sent. */
export function typedAmounts(amounts: Record<string, string>): { id: string; amount: number }[] {
  return Object.entries(amounts).map(([id, text]) => ({ id, amount: typedNumber(text) ?? Number.NaN }));
}

/**
 * The first thing wrong with the ticked amounts, or null: each must be a
 * number above 0 and no more than its document can still take. `offered` is
 * the chosen party's documents; a ticked one that is not among them was paid
 * or voided since the form opened.
 */
export function amountsError(
  amounts: Record<string, string>,
  offered: { id: string; payable: number }[],
  messages: { amount: string; tooMuch: string },
): string | null {
  for (const [id, text] of Object.entries(amounts)) {
    const amount = typedNumber(text);
    if (amount === null || sen(amount) <= 0) return messages.amount;
    const document = offered.find((d) => d.id === id);
    if (!document || sen(amount) > sen(document.payable)) return messages.tooMuch;
  }
  return null;
}

/**
 * One kind of payment form, for the shared card: its words, and its rules as
 * the functions of its own module (`payment-form.ts`, `receipt-form.ts`),
 * which are what the tests pin.
 */
export type AllocationFormKind<F extends AllocationFormState, D extends Payable> = {
  words: {
    subtitle: string;
    party: 'supplier' | 'customer';
    document: 'bill' | 'invoice';
    /** The heading over the list of documents. */
    documents: string;
    /** Shown instead of the form when no document can take a payment. */
    nothing: string;
    account: string;
    /** The date box's label when the payment is not being scheduled. */
    date: string;
    /** The submit button when the payment is not being scheduled. */
    submit: string;
  };
  newForm: (
    documents: D[],
    accounts: FinanceAccount[],
    today: string,
    preselect?: { partyId: string; documentId: string },
  ) => F;
  partyId: (form: F) => string;
  chooseParty: (form: F, partyId: string) => F;
  parties: (documents: D[]) => { id: string; name: string; open: number }[];
  documentsOf: (documents: D[], partyId: string) => D[];
  /** The document's number, as the list shows it. */
  number: (document: D) => string;
  /** The line under a document's number: what it can take, and why that may be less than its balance. */
  owed: (document: D) => string;
  /** Names an amount box for screen readers. */
  amountLabel: (document: D) => string;
  toggle: (form: F, document: D, on: boolean) => F;
  toggleAll: (form: F, documents: D[], on: boolean) => F;
  keep: (form: F, documents: D[]) => F;
  total: (form: F) => number;
  error: (form: F, documents: D[]) => string | null;
  payload: (form: F) => unknown;
  /** Present when the payment can be scheduled for later: only money out. */
  schedule?: { is: (form: F) => boolean; set: (form: F, scheduled: boolean) => F };
};
```

- [ ] **Step 6: Put the payment-out form on them**

Replace the whole of `src/lib/finance/payment-form.ts` with:

```ts
/**
 * The payment-out form's rules, kept out of the component so they can be
 * tested: which bills can still take a payment, what each defaults to, what
 * is wrong with the form, and what is sent to recordPaymentOutAction. Pure.
 * What a payment in shares is in allocation-form.ts.
 */
import {
  type AllocationFormKind,
  amountText,
  amountsError,
  amountsTotal,
  defaultAccount,
  heldBy,
  keptOffered,
  partiesOf,
  round2,
  ticked,
  tickedAll,
  typedAmounts,
} from './allocation-form';
import { BILL_MESSAGES, type BillListRow } from './bills';
import { rm } from './format';
import {
  type FinanceAccount,
  MONEY_MESSAGES,
  type PaymentMethod,
  type PaymentOutRow,
  recordPaymentOutInput,
} from './money';

// Defined in allocation-form.ts, which the payment-in form shares; exported from here for this module's existing importers.
export { amountText } from './allocation-form';

export type PayableBill = {
  id: string;
  bill_no: string;
  supplier_id: string;
  supplier_name: string;
  due_date: string;
  overdue: boolean;
  /** Still owed after every paid payment. */
  balance: number;
  /** Promised by payments that are scheduled but not yet paid. */
  scheduled: number;
  /** What a new payment may take: the balance less what is already scheduled. */
  payable: number;
};

export type PaymentForm = {
  supplierId: string;
  /** The ticked bills, each with the amount as typed. */
  amounts: Record<string, string>;
  accountId: string;
  date: string;
  method: PaymentMethod;
  reference: string;
  notes: string;
  /** False to pay now; true to schedule for later. */
  scheduled: boolean;
};

/**
 * What payments that have not been paid yet already hold of each bill, to the
 * sen, by bill id. A bill with nothing held is not in the answer. Supplier
 * Bills shows it under a balance, so a bill with no Pay choice says why.
 */
export function heldByBill(payments: PaymentOutRow[]): Record<string, number> {
  return heldBy(payments, (p) => p.bill_id);
}

/**
 * The bills a payment can be recorded against: posted, not fully paid, and not
 * already covered by scheduled payments. The database refuses a payment for
 * more than balance − scheduled, so that is what the form offers.
 */
export function payableBills(bills: BillListRow[], payments: PaymentOutRow[]): PayableBill[] {
  const held = heldByBill(payments);
  return bills
    .filter((b) => (b.display_status === 'pending' || b.display_status === 'overdue') && b.balance > 0)
    .map((b) => {
      const scheduled = held[b.id] ?? 0;
      return {
        id: b.id,
        bill_no: b.bill_no ?? '—',
        supplier_id: b.supplier_id,
        supplier_name: b.supplier_name,
        due_date: b.due_date,
        overdue: b.display_status === 'overdue',
        balance: b.balance,
        scheduled,
        payable: round2(b.balance - scheduled),
      };
    })
    .filter((b) => b.payable > 0)
    .sort(
      (x, y) =>
        x.supplier_name.localeCompare(y.supplier_name) ||
        x.due_date.localeCompare(y.due_date) ||
        x.bill_no.localeCompare(y.bill_no),
    );
}

/** The suppliers that have at least one bill to pay, by name. */
export function paymentSuppliers(payable: PayableBill[]): { id: string; name: string; bills: number }[] {
  return partiesOf(
    payable,
    (b) => b.supplier_id,
    (b) => b.supplier_name,
  ).map(({ id, name, open }) => ({ id, name, bills: open }));
}

/** One supplier's payable bills, the earliest due first. */
export function billsOf(payable: PayableBill[], supplierId: string): PayableBill[] {
  return payable.filter((b) => b.supplier_id === supplierId);
}

/**
 * A fresh form. The account defaults to the first bank account. With
 * `preselect` (the Pay choice on a bill row) the supplier is chosen and that
 * bill ticked for all it can still take.
 */
export function newPaymentForm(
  payable: PayableBill[],
  accounts: FinanceAccount[],
  today: string,
  preselect?: { supplierId: string; billId: string },
): PaymentForm {
  const suppliers = paymentSuppliers(payable);
  const bill = preselect ? payable.find((b) => b.id === preselect.billId && b.supplier_id === preselect.supplierId) : undefined;
  return {
    supplierId: preselect?.supplierId ?? (suppliers.length === 1 ? suppliers[0].id : ''),
    amounts: bill ? { [bill.id]: amountText(bill.payable) } : {},
    accountId: defaultAccount(accounts),
    date: today,
    method: 'bank_transfer',
    reference: '',
    notes: '',
    scheduled: false,
  };
}

/** Choosing another supplier starts the ticks again: one payment pays one supplier. */
export function chooseSupplier(form: PaymentForm, supplierId: string): PaymentForm {
  return supplierId === form.supplierId ? form : { ...form, supplierId, amounts: {} };
}

/** Ticks a bill for all it can still take, or unticks it. */
export function toggleBill(form: PaymentForm, bill: PayableBill, on: boolean): PaymentForm {
  return ticked(form, bill, on);
}

/** Ticks every bill of the chosen supplier, or clears them all. */
export function toggleAll(form: PaymentForm, bills: PayableBill[], on: boolean): PaymentForm {
  return tickedAll(form, bills, on);
}

/**
 * After a refresh, a ticked bill that was paid off or voided meanwhile is no
 * longer in `bills`. Its amount goes, so the total, the count and the save
 * stay true to what the person can see. The same form when nothing goes.
 */
export function keepPayable(form: PaymentForm, bills: PayableBill[]): PaymentForm {
  return keptOffered(form, bills);
}

/** The running total: every ticked amount that is a number above 0. */
export function paymentTotal(form: PaymentForm): number {
  return amountsTotal(form.amounts);
}

/** What is sent to recordPaymentOutAction. Amounts are numbers; a box that is not a number goes as NaN and is refused. */
export function paymentPayload(form: PaymentForm) {
  return {
    account_id: form.accountId,
    txn_date: form.date,
    method: form.method,
    reference: form.reference,
    notes: form.notes,
    scheduled: form.scheduled,
    allocations: typedAmounts(form.amounts).map(({ id, amount }) => ({ bill_id: id, amount })),
  };
}

/**
 * The first thing wrong with the form, in the sentence the schema or the
 * database would use, or null when it can be sent.
 */
export function paymentFormError(form: PaymentForm, payable: PayableBill[]): string | null {
  if (!form.supplierId) return BILL_MESSAGES.supplier;
  if (Object.keys(form.amounts).length === 0) return MONEY_MESSAGES.bills;
  // A bill that is no longer payable was paid or voided since the form opened.
  const problem = amountsError(form.amounts, billsOf(payable, form.supplierId), MONEY_MESSAGES);
  if (problem) return problem;
  const parsed = recordPaymentOutInput.safeParse(paymentPayload(form));
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? MONEY_MESSAGES.amount);
}

/** The payment-out form, as the shared card draws it. */
export const PAYMENT_OUT_KIND: AllocationFormKind<PaymentForm, PayableBill> = {
  words: {
    subtitle: 'Pay a supplier\'s bills, now or later',
    party: 'supplier',
    document: 'bill',
    documents: 'Bills to pay',
    nothing: 'There is no bill to pay. A bill can be paid once it is posted, and until payments cover it in full.',
    account: 'Paid from',
    date: 'Date paid',
    submit: 'Record payment',
  },
  newForm: (payable, accounts, today, preselect) =>
    newPaymentForm(
      payable,
      accounts,
      today,
      preselect ? { supplierId: preselect.partyId, billId: preselect.documentId } : undefined,
    ),
  partyId: (form) => form.supplierId,
  chooseParty: chooseSupplier,
  parties: (payable) => paymentSuppliers(payable).map(({ id, name, bills }) => ({ id, name, open: bills })),
  documentsOf: billsOf,
  number: (bill) => bill.bill_no,
  owed: (bill) =>
    `${rm(bill.payable)} to pay${bill.scheduled > 0 ? ` · ${rm(bill.scheduled)} of ${rm(bill.balance)} already scheduled` : ''}`,
  amountLabel: (bill) => `Amount to pay on ${bill.bill_no}`,
  toggle: toggleBill,
  toggleAll,
  keep: keepPayable,
  total: paymentTotal,
  error: paymentFormError,
  payload: paymentPayload,
  schedule: { is: (form) => form.scheduled, set: (form, scheduled) => ({ ...form, scheduled }) },
};
```

- [ ] **Step 7: Run the new tests and the two the refactor must not disturb**

Run: `pnpm exec vitest run tests/finance-document-form.test.ts tests/finance-allocation-form.test.ts tests/finance-bill-form.test.ts tests/finance-payment-form.test.ts`
Expected: PASS, all four files: 10 tests in `finance-document-form`, 14 in `finance-allocation-form`, and every test of the two existing files, which were not edited.

Run: `pnpm exec tsc --noEmit`
Expected: no errors. The two cards still import what they did from `bill-form.ts` and `payment-form.ts`, which still export it.

- [ ] **Step 8: Write the card for a bill or an invoice**

No test comes first for the components of this task: Vitest has no DOM here, and every rule they apply is tested above. Verification is the type-check, the linter and the unchanged unit tests.

Create `src/components/finance/document-form-card.tsx`:

```tsx
'use client';

import { type FormEvent, useId, useState } from 'react';
import Link from 'next/link';
import { FileText, Plus } from 'lucide-react';
import { BentoCard } from '@/components/bento/bento';
import { LineItemsEditor } from '@/components/finance/line-items-editor';
import { useFinanceAction } from '@/components/finance/use-finance-action';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { type DocumentFormKind, type DocumentFormState, type DocumentParty, withDueDate } from '@/lib/finance/document-form';
import type { FinanceProduct } from '@/lib/finance/products';
import type { FinResult } from '@/lib/finance/result';

export type DocumentFormActions = {
  save: (input: unknown) => Promise<FinResult<{ id: string }>>;
  /** When the draft was saved but posting it was refused, the answer carries the draft's id. */
  saveAndPost: (input: unknown) => Promise<FinResult<unknown> & { draftId?: string }>;
};

const capital = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/**
 * A new bill or invoice, or a draft being changed. Saved as a draft, or saved
 * and posted in one go. `kind` says which document it is and carries its
 * rules, which are in src/lib/finance/bill-form.ts and invoice-form.ts.
 */
export function DocumentFormCard<F extends DocumentFormState>({
  kind,
  initial,
  parties,
  products,
  actions,
  onClose,
}: {
  kind: DocumentFormKind<F>;
  /** What the form holds when it opens: a new document, or the draft being changed. */
  initial: () => F;
  /** The suppliers or customers to choose from, by name. */
  parties: DocumentParty[];
  /** Active products and services. */
  products: FinanceProduct[];
  actions: DocumentFormActions;
  onClose: () => void;
}) {
  const id = useId();
  const [form, setForm] = useState(initial);
  const [posting, setPosting] = useState(false);
  const save = useFinanceAction();
  // A change by the person answers the last refusal, so its sentence goes.
  const edit: typeof setForm = (next) => {
    save.clear();
    setForm(next);
  };

  const { noun, party, reference } = kind;
  const terms = parties.find((p) => p.id === kind.partyId(form))?.payment_terms_days;

  const send = (post: boolean) => {
    const problem = kind.error(form, post);
    if (problem) {
      save.fail(problem);
      return;
    }
    const payload = kind.payload(form);
    setPosting(post);
    if (!post) {
      save.run(() => actions.save(payload), onClose);
      return;
    }
    save.run(async () => {
      const result = await actions.saveAndPost(payload);
      // Saved but not posted: go on editing that draft, so a second try does not save a second document.
      if (!result.ok && result.draftId) {
        const draftId = result.draftId;
        setForm((f) => ({ ...f, id: draftId }));
        return { ...result, error: kind.savedNotPosted(result.error) };
      }
      return result;
    }, onClose);
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    // Handled here rather than as a form action, so a refused form keeps what was typed.
    event.preventDefault();
    send(false);
  };

  const title = form.id ? `Edit ${noun}` : `New ${noun}`;
  const subtitle = form.id ? 'A draft: it gets its number when it is posted' : 'Saved as a draft until it is posted';

  if (parties.length === 0) {
    return (
      <BentoCard title={title} subtitle={subtitle} icon={Plus} className="col-span-2 md:col-span-12">
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-muted-foreground">
            Add a {party} under{' '}
            <Link href="/finance/customers-suppliers" className="font-medium text-primary underline-offset-4 hover:underline">
              Customers &amp; Suppliers
            </Link>{' '}
            first.
          </p>
          <Button type="button" variant="outline" size="sm" onClick={onClose} autoFocus data-finance-focus>
            Close
          </Button>
        </div>
      </BentoCard>
    );
  }

  return (
    <BentoCard title={title} subtitle={subtitle} icon={form.id ? FileText : Plus} className="col-span-2 md:col-span-12">
      <form onSubmit={submit} noValidate className="grid gap-3 md:grid-cols-12">
        <div className={reference ? 'space-y-1.5 md:col-span-4' : 'space-y-1.5 md:col-span-6'}>
          <Label htmlFor={`${id}-party`}>{capital(party)}</Label>
          <Select
            value={kind.partyId(form)}
            onValueChange={(v) => {
              const chosen = parties.find((p) => p.id === v);
              if (chosen) edit((f) => kind.withParty(f, chosen));
            }}
          >
            <SelectTrigger id={`${id}-party`} className="w-full" autoFocus data-finance-focus>
              <SelectValue placeholder={`Choose a ${party}`} />
            </SelectTrigger>
            <SelectContent>
              {parties.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {reference ? (
          <div className="space-y-1.5 md:col-span-2">
            <Label htmlFor={`${id}-ref`}>{reference.label}</Label>
            <Input
              id={`${id}-ref`}
              value={reference.get(form)}
              maxLength={200}
              placeholder={reference.placeholder}
              autoComplete="off"
              onChange={(e) => edit((f) => reference.set(f, e.target.value))}
            />
          </div>
        ) : null}
        <div className="space-y-1.5 md:col-span-3">
          <Label htmlFor={`${id}-date`}>{kind.dateLabel}</Label>
          <Input
            id={`${id}-date`}
            type="date"
            value={kind.date(form)}
            required
            onChange={(e) => edit((f) => kind.withDate(f, e.target.value, terms))}
          />
        </div>
        <div className="space-y-1.5 md:col-span-3">
          <Label htmlFor={`${id}-due`}>Due date</Label>
          <Input
            id={`${id}-due`}
            type="date"
            value={form.due_date}
            min={kind.date(form) || undefined}
            required
            onChange={(e) => edit((f) => withDueDate(f, e.target.value))}
          />
        </div>

        <fieldset
          className="space-y-2 md:col-span-12"
          // Enter in a line's box moves on like any other key; it does not save the document half typed.
          onKeyDown={(event) => {
            if (event.key === 'Enter' && event.target instanceof HTMLInputElement) event.preventDefault();
          }}
        >
          <legend className="text-sm font-medium leading-none">Lines</legend>
          <LineItemsEditor
            lines={form.lines}
            products={products}
            withProduct={kind.withProduct}
            onChange={(lines) => edit((f) => ({ ...f, lines }))}
          />
        </fieldset>

        <div className="space-y-1.5 md:col-span-12">
          <Label htmlFor={`${id}-notes`}>Notes</Label>
          <Input
            id={`${id}-notes`}
            value={form.notes}
            maxLength={200}
            autoComplete="off"
            onChange={(e) => edit((f) => ({ ...f, notes: e.target.value }))}
          />
        </div>

        <div className="flex flex-wrap items-center gap-3 md:col-span-12">
          <Button type="submit" size="sm" variant="outline" disabled={save.pending}>
            {save.pending && !posting ? 'Saving…' : 'Save draft'}
          </Button>
          <Button type="button" size="sm" disabled={save.pending} onClick={() => send(true)}>
            {save.pending && posting ? 'Posting…' : 'Save and post'}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={save.pending}>
            Cancel
          </Button>
          {save.error ? (
            <p role="alert" className="text-sm text-destructive">
              {save.error}
            </p>
          ) : null}
        </div>
      </form>
    </BentoCard>
  );
}
```

- [ ] **Step 9: Make the bill form card a wrapper**

Replace the whole of `src/components/finance/bill-form-card.tsx` with:

```tsx
'use client';

import { DocumentFormCard } from '@/components/finance/document-form-card';
import { BILL_FORM_KIND, billFormFromDetail, newBillForm } from '@/lib/finance/bill-form';
import type { BillDetail, SaveAndPostResult } from '@/lib/finance/bills';
import type { FinanceContact } from '@/lib/finance/contacts';
import type { FinanceProduct } from '@/lib/finance/products';
import type { FinResult } from '@/lib/finance/result';

export type BillFormActions = {
  save: (input: unknown) => Promise<FinResult<{ id: string }>>;
  saveAndPost: (input: unknown) => Promise<SaveAndPostResult>;
};

/**
 * A new bill, or a draft being changed (`editing`). The card itself is the
 * one invoices use; the rules are in src/lib/finance/bill-form.ts.
 */
export function BillFormCard({
  editing,
  suppliers,
  products,
  today,
  actions,
  onClose,
}: {
  /** The draft being changed, with its lines; absent for a new bill. */
  editing?: BillDetail;
  /** Active suppliers, by name. */
  suppliers: FinanceContact[];
  /** Active products and services. */
  products: FinanceProduct[];
  /** The default bill date, YYYY-MM-DD. */
  today: string;
  actions: BillFormActions;
  onClose: () => void;
}) {
  return (
    <DocumentFormCard
      kind={BILL_FORM_KIND}
      initial={() => (editing ? billFormFromDetail(editing) : newBillForm(today, 'new-0'))}
      // A supplier archived since the draft was saved is still this bill's supplier.
      parties={
        editing && !suppliers.some((s) => s.id === editing.supplier_id)
          ? [{ id: editing.supplier_id, name: editing.supplier_name, payment_terms_days: 0 }, ...suppliers]
          : suppliers
      }
      products={products}
      actions={actions}
      onClose={onClose}
    />
  );
}
```

- [ ] **Step 10: Give the line editor its product rule as a prop**

Three edits. The editor no longer imports from `bill-form.ts` or `bills.ts`.

In `src/components/finance/line-items-editor.tsx`, replace:

```tsx
import { type LineDraft, emptyLine, lineNumbers, withProduct } from '@/lib/finance/bill-form';
import { billTotals, lineAmounts } from '@/lib/finance/bill-math';
import { BILL_LINES_MAX } from '@/lib/finance/bills';
```

with:

```tsx
import { billTotals, lineAmounts } from '@/lib/finance/bill-math';
import { type LineDraft, emptyLine, lineNumbers } from '@/lib/finance/document-form';
import { DOCUMENT_LINES_MAX } from '@/lib/finance/document-lines';
```

In `src/components/finance/line-items-editor.tsx`, replace:

```tsx
 * The lines of a bill, with live totals. On a phone each line is a card with
 * its fields stacked two to a row; from the md breakpoint a line is one row.
 * Nothing scrolls sideways. The arithmetic is in src/lib/finance/bill-math.ts.
 */
export function LineItemsEditor({
  lines,
  products,
  onChange,
}: {
  lines: LineDraft[];
  /** Active products and services, for the optional picker. */
  products: FinanceProduct[];
  onChange: (lines: LineDraft[]) => void;
}) {
```

with:

```tsx
 * The lines of a bill or an invoice, with live totals. On a phone each line
 * is a card with its fields stacked two to a row; from the md breakpoint a
 * line is one row. Nothing scrolls sideways. The arithmetic is in
 * src/lib/finance/bill-math.ts.
 */
export function LineItemsEditor({
  lines,
  products,
  withProduct,
  onChange,
}: {
  lines: LineDraft[];
  /** Active products and services, for the optional picker. */
  products: FinanceProduct[];
  /** What choosing a product fills in: a bill takes its cost, an invoice its price. */
  withProduct: (line: LineDraft, product: FinanceProduct | null) => LineDraft;
  onChange: (lines: LineDraft[]) => void;
}) {
```

In `src/components/finance/line-items-editor.tsx`, replace:

```tsx
disabled={lines.length >= BILL_LINES_MAX}
```

with:

```tsx
disabled={lines.length >= DOCUMENT_LINES_MAX}
```

- [ ] **Step 11: Write the card for a payment out or in**

Create `src/components/finance/allocation-form-card.tsx`:

```tsx
'use client';

import { type FormEvent, useId, useState } from 'react';
import { Banknote } from 'lucide-react';
import { BentoCard } from '@/components/bento/bento';
import { useFinanceAction } from '@/components/finance/use-finance-action';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { AllocationFormKind, AllocationFormState, Payable } from '@/lib/finance/allocation-form';
import { rm } from '@/lib/finance/format';
import { type FinanceAccount, PAYMENT_METHODS, PAYMENT_METHOD_LABELS, type PaymentMethod } from '@/lib/finance/money';
import type { FinResult } from '@/lib/finance/result';
import { displayDate } from '@/lib/finance/view-helpers';

export type RecordPayment = (input: unknown) => Promise<FinResult<{ id: string }>>;

const capital = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/**
 * Records one payment to a supplier or from a customer, split across their
 * open bills or invoices. `kind` says which it is and carries its rules,
 * which are in src/lib/finance/payment-form.ts and receipt-form.ts.
 */
export function AllocationFormCard<F extends AllocationFormState, D extends Payable>({
  kind,
  documents,
  accounts,
  today,
  preselect,
  record,
  onClose,
}: {
  kind: AllocationFormKind<F, D>;
  /** Every bill or invoice that can still take a payment. */
  documents: D[];
  accounts: FinanceAccount[];
  /** The default payment date, YYYY-MM-DD. */
  today: string;
  /** Opened from a document's row: that party chosen and that document ticked. */
  preselect?: { partyId: string; documentId: string };
  record: RecordPayment;
  onClose: () => void;
}) {
  const id = useId();
  const [typed, setForm] = useState(() => kind.newForm(documents, accounts, today, preselect));
  const save = useFinanceAction();
  // A change by the person answers the last refusal, so its sentence goes.
  const edit: typeof setForm = (next) => {
    save.clear();
    setForm(next);
  };

  const { words } = kind;
  const parties = kind.parties(documents);
  // A ticked document that was paid off since a refresh is dropped from everything below.
  const form = kind.keep(typed, documents);
  const offered = kind.documentsOf(documents, kind.partyId(form));
  const tickedCount = Object.keys(form.amounts).length;
  const scheduled = kind.schedule?.is(form) ?? false;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    // Handled here rather than as a form action, so a refused form keeps what was typed.
    event.preventDefault();
    const problem = kind.error(form, documents);
    if (problem) {
      save.fail(problem);
      return;
    }
    save.run(() => record(kind.payload(form)), onClose);
  };

  if (parties.length === 0) {
    return (
      <BentoCard title="Record payment" subtitle={words.subtitle} icon={Banknote} className="col-span-2 md:col-span-12">
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-muted-foreground">{words.nothing}</p>
          <Button type="button" variant="outline" size="sm" onClick={onClose} autoFocus data-finance-focus>
            Close
          </Button>
        </div>
      </BentoCard>
    );
  }

  return (
    <BentoCard title="Record payment" subtitle={words.subtitle} icon={Banknote} className="col-span-2 md:col-span-12">
      <form onSubmit={submit} noValidate className="grid gap-3 md:grid-cols-12">
        <div className="space-y-1.5 md:col-span-5">
          <Label htmlFor={`${id}-party`}>{capital(words.party)}</Label>
          <Select value={kind.partyId(form)} onValueChange={(v) => edit((f) => kind.chooseParty(f, v))}>
            <SelectTrigger id={`${id}-party`} className="w-full" autoFocus data-finance-focus>
              <SelectValue placeholder={`Choose a ${words.party}`} />
            </SelectTrigger>
            <SelectContent>
              {parties.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name} ({p.open} open)
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <fieldset className="space-y-1.5 md:col-span-12">
          <legend className="text-sm font-medium leading-none">{words.documents}</legend>
          {offered.length === 0 ? (
            <p className="rounded-lg border border-dashed px-3 py-4 text-sm text-muted-foreground">
              Choose a {words.party} to see their open {words.document}s.
            </p>
          ) : (
            // Twenty open documents scroll inside the card rather than pushing the buttons off the page.
            <ul className="max-h-80 divide-y overflow-y-auto rounded-lg border">
              {offered.map((d) => {
                const ticked = d.id in form.amounts;
                return (
                  <li key={d.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2">
                    <label className="flex min-w-0 flex-1 basis-56 items-start gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="mt-0.5 size-4 shrink-0 accent-primary"
                        checked={ticked}
                        onChange={(e) => edit((f) => kind.toggle(f, d, e.target.checked))}
                      />
                      <span className="min-w-0">
                        <span className="font-medium">{kind.number(d)}</span>
                        <span className={d.overdue ? 'ml-2 text-red-600' : 'ml-2 text-muted-foreground'}>
                          {d.overdue ? 'Overdue since' : 'Due'} {displayDate(d.due_date)}
                        </span>
                        <span className="block text-xs text-muted-foreground tabular-nums">{kind.owed(d)}</span>
                      </span>
                    </label>
                    {ticked ? (
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-muted-foreground" aria-hidden>
                          RM
                        </span>
                        <Input
                          type="number"
                          inputMode="decimal"
                          min={0}
                          step="0.01"
                          aria-label={kind.amountLabel(d)}
                          className="w-32 text-right tabular-nums"
                          onWheel={(e) => e.currentTarget.blur()}
                          // Enter in an amount box does not record the payment half typed.
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') e.preventDefault();
                          }}
                          value={form.amounts[d.id]}
                          onChange={(e) => edit((f) => ({ ...f, amounts: { ...f.amounts, [d.id]: e.target.value } }))}
                        />
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm" aria-live="polite">
              Total <span className="font-semibold tabular-nums">{rm(kind.total(form))}</span>
              {tickedCount ? (
                <span className="text-muted-foreground">
                  {' '}
                  across {tickedCount} {tickedCount === 1 ? words.document : `${words.document}s`}
                </span>
              ) : null}
            </p>
            {offered.length > 1 ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => edit((f) => kind.toggleAll(f, offered, tickedCount < offered.length))}
              >
                {tickedCount < offered.length ? 'Tick all' : 'Clear all'}
              </Button>
            ) : null}
          </div>
        </fieldset>

        <div className="space-y-1.5 md:col-span-3">
          <Label htmlFor={`${id}-account`}>{words.account}</Label>
          <Select value={form.accountId} onValueChange={(v) => edit((f) => ({ ...f, accountId: v }))}>
            <SelectTrigger id={`${id}-account`} className="w-full">
              <SelectValue placeholder="Choose an account" />
            </SelectTrigger>
            <SelectContent>
              {accounts.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name}
                  {a.bank_name ? ` · ${a.bank_name}` : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5 md:col-span-3">
          <Label htmlFor={`${id}-date`}>{scheduled ? 'Planned date' : words.date}</Label>
          <Input
            id={`${id}-date`}
            type="date"
            value={form.date}
            required
            onChange={(e) => edit((f) => ({ ...f, date: e.target.value }))}
          />
        </div>
        <div className="space-y-1.5 md:col-span-3">
          <Label htmlFor={`${id}-method`}>Method</Label>
          <Select value={form.method} onValueChange={(v) => edit((f) => ({ ...f, method: v as PaymentMethod }))}>
            <SelectTrigger id={`${id}-method`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAYMENT_METHODS.map((m) => (
                <SelectItem key={m} value={m}>
                  {PAYMENT_METHOD_LABELS[m]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5 md:col-span-3">
          <Label htmlFor={`${id}-reference`}>Reference</Label>
          <Input
            id={`${id}-reference`}
            value={form.reference}
            maxLength={200}
            placeholder="Bank reference or cheque no."
            autoComplete="off"
            onChange={(e) => edit((f) => ({ ...f, reference: e.target.value }))}
          />
        </div>
        <div className={kind.schedule ? 'space-y-1.5 md:col-span-7' : 'space-y-1.5 md:col-span-12'}>
          <Label htmlFor={`${id}-notes`}>Notes</Label>
          <Input
            id={`${id}-notes`}
            value={form.notes}
            maxLength={200}
            autoComplete="off"
            onChange={(e) => edit((f) => ({ ...f, notes: e.target.value }))}
          />
        </div>
        {kind.schedule ? (
          <fieldset className="space-y-1.5 md:col-span-5">
            <legend className="text-sm font-medium leading-none">When</legend>
            <div className="flex h-8 flex-wrap items-center gap-4">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name={`${id}-when`}
                  className="size-4 accent-primary"
                  checked={!scheduled}
                  onChange={() => edit((f) => kind.schedule?.set(f, false) ?? f)}
                />
                Pay now
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name={`${id}-when`}
                  className="size-4 accent-primary"
                  checked={scheduled}
                  onChange={() => edit((f) => kind.schedule?.set(f, true) ?? f)}
                />
                Schedule for later
              </label>
            </div>
          </fieldset>
        ) : null}

        <div className="flex flex-wrap items-center gap-3 md:col-span-12">
          <Button type="submit" size="sm" disabled={save.pending}>
            {save.pending ? 'Saving…' : scheduled ? 'Schedule payment' : words.submit}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={save.pending}>
            Cancel
          </Button>
          {save.error ? (
            <p role="alert" className="text-sm text-destructive">
              {save.error}
            </p>
          ) : null}
        </div>
      </form>
    </BentoCard>
  );
}
```

- [ ] **Step 12: Make the payment form card a wrapper**

Replace the whole of `src/components/finance/payment-form-card.tsx` with:

```tsx
'use client';

import { AllocationFormCard, type RecordPayment } from '@/components/finance/allocation-form-card';
import type { FinanceAccount } from '@/lib/finance/money';
import { PAYMENT_OUT_KIND, type PayableBill } from '@/lib/finance/payment-form';

export type { RecordPayment } from '@/components/finance/allocation-form-card';

/**
 * Records a payment to one supplier, split across their open bills, paid now
 * or scheduled. Used on Payments Out, and on Supplier Bills from a bill's Pay
 * choice (`preselect`). The card itself is the one payments in use; the rules
 * are in src/lib/finance/payment-form.ts.
 */
export function PaymentFormCard({
  payable,
  accounts,
  today,
  preselect,
  record,
  onClose,
}: {
  /** Every bill that can still take a payment, from `payableBills`. */
  payable: PayableBill[];
  accounts: FinanceAccount[];
  /** The default payment date, YYYY-MM-DD. */
  today: string;
  /** Opened from a bill row: that supplier chosen and that bill ticked. */
  preselect?: { supplierId: string; billId: string };
  record: RecordPayment;
  onClose: () => void;
}) {
  return (
    <AllocationFormCard
      kind={PAYMENT_OUT_KIND}
      documents={payable}
      accounts={accounts}
      today={today}
      preselect={preselect ? { partyId: preselect.supplierId, documentId: preselect.billId } : undefined}
      record={record}
      onClose={onClose}
    />
  );
}
```

- [ ] **Step 13: Type-check, lint, test and build**

Run, as separate commands: `pnpm exec tsc --noEmit`, `pnpm lint`, `pnpm exec vitest run --exclude 'tests/*.rls.test.ts' --exclude 'tests/bendahara-*.test.ts'`, `pnpm build`
Expected: no type or lint errors; every unit test passes (24 more than before this task); the build completes.

Run: `git status --short tests`
Expected: exactly two lines, both new files: `?? tests/finance-allocation-form.test.ts` and `?? tests/finance-document-form.test.ts`. No existing test file was changed.

Run: `grep -n -E "bill-form'|bills'" src/components/finance/line-items-editor.tsx src/components/finance/document-form-card.tsx src/components/finance/allocation-form-card.tsx`
Expected: no output. The shared pieces do not know about bills.

- [ ] **Step 14: Commit**

```bash
git add src/lib/finance/document-form.ts src/lib/finance/allocation-form.ts src/lib/finance/bill-form.ts src/lib/finance/payment-form.ts src/components/finance/document-form-card.tsx src/components/finance/allocation-form-card.tsx src/components/finance/bill-form-card.tsx src/components/finance/payment-form-card.tsx src/components/finance/line-items-editor.tsx tests/finance-document-form.test.ts tests/finance-allocation-form.test.ts
git commit -m "refactor: one card for the bill and invoice forms, one for the two payment forms"
```

---

### Task 2: Data-layer touch-ups: sentences, the e-Invois write, voiding money in, duplicates

**Files:**
- Modify: `src/lib/finance/invoices.ts`
- Modify: `src/lib/finance/money.ts`
- Modify: `src/screens/finance/sales-sample.ts`
- Create: `tests/finance-sales-data.test.ts`
- Modify: `tests/finance-invoices.test.ts`
- Modify: `tests/finance-payments-in.test.ts`
- Modify: `tests/finance-sales-views.test.ts`
- Modify: `tests/finance-schemas.test.ts`

**Interfaces:**
- Consumes: `FinanceWriteContext`, `FinResult`, `PG_CHECK`, `PG_UNIQUE`, `pgCode` from `@/lib/finance/result`; `fakeFinance` from `tests/setup/fake-finance.ts` (it already has `update`, `eq`, `select`, `maybeSingle`).
- Produces:
  - `@/lib/finance/invoices`: `EINVOICE_STATUSES = ['none', 'pending', 'validated', 'rejected'] as const`; `EINVOICE_UUID_MAX = 100`; `type EInvoiceStatus = (typeof EINVOICE_STATUSES)[number]` (the same four strings as before); `InvoiceListRow` gains `einvoice_uuid: string | null` (and `InvoiceDetail`, which extends it, no longer declares it a second time); `setEInvoiceInput` (`{ id, einvoice_status, einvoice_uuid }`, output `einvoice_uuid: string | null`); `setEInvoice(ctx: FinanceWriteContext, input: z.input<typeof setEInvoiceInput>): Promise<FinResult<{ id: string }>>`; `type SaveAndPostInvoiceResult = FinResult<{ id: string; invoice_no: string }> & { draftId?: string }`; `INVOICE_MESSAGES.locked`, `.hasPayments` reworded; `INVOICE_MESSAGES.einvoiceStatus`, `.einvoiceUuid`, `.einvoiceNone`, `.einvoiceDraft` added.
  - `@/lib/finance/money`: `voidPaymentIn(ctx: FinanceWriteContext, input: z.input<typeof paymentIdInput>): Promise<FinResult<{ id: string }>>`; `RECEIPT_MESSAGES.locked = 'This payment has already been voided.'`; both payment schemas refuse the same document twice whatever the capitals of its id; `recordPaymentOut` and `recordPaymentIn` word `23505` as their duplicate sentence. `voidPayment` is unchanged.

What changes and why:

- **`FIN01`.** The guard raises it for a posted invoice that someone tries to change, but also for voiding a void invoice. The menus (Task 3) never offer an action a status forbids, so the code reaches a person only when the invoice changed under them. The new sentence is true of every such case.
- **e-Invois.** One plain update of three columns. The guard allows exactly `einvoice_status`, `einvoice_uuid` and `updated_at` to change on a posted invoice. On a draft the table's check constraint refuses it (`23514`), which gets its own sentence; on a void invoice the guard answers `FIN01`.
- **Voiding money in** goes through its own function so that it answers from `RECEIPT_REFUSALS`, and is kept to `direction = 'in'`.
- **Duplicates.** `'ABC…'` and `'abc…'` are one id to Postgres and two to a `Set`. A unique violation while a payment is being recorded can only be the allocation key `(transaction_id, bill_id)` or `(transaction_id, invoice_id)`: the payment's number comes from `finance_next_number` under a lock.

- [ ] **Step 1: Write the failing tests**

Create `tests/finance-sales-data.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INVOICE_MESSAGES, setEInvoice, setEInvoiceInput, voidInvoice } from '@/lib/finance/invoices';
import {
  markPaymentPaid,
  recordPaymentIn,
  recordPaymentInInput,
  recordPaymentOut,
  recordPaymentOutInput,
} from '@/lib/finance/money';
import { fakeFinance } from './setup/fake-finance';

const ID = '33333333-3333-4333-8333-333333333333';
const TXN = '55555555-5555-4555-8555-555555555555';
const ACCOUNT = '66666666-6666-4666-8666-666666666666';
const LOWER = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
const UPPER = LOWER.toUpperCase();

let logged: ReturnType<typeof vi.spyOn>;
beforeEach(() => { logged = vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { logged.mockRestore(); });

describe('setEInvoiceInput', () => {
  const first = (value: unknown) => setEInvoiceInput.safeParse(value).error?.issues[0]?.message;

  it('takes one of the four statuses and nothing else', () => {
    for (const einvoice_status of ['none', 'pending', 'validated', 'rejected']) {
      expect(setEInvoiceInput.safeParse({ id: ID, einvoice_status }).success, einvoice_status).toBe(true);
    }
    expect(first({ id: ID, einvoice_status: 'submitted' })).toBe('Choose an e-Invois status.');
    expect(first({ id: ID })).toBe('Choose an e-Invois status.');
  });
  it('trims the UUID, stores an empty box as null, and keeps it to 100 characters', () => {
    expect(setEInvoiceInput.parse({ id: ID, einvoice_status: 'validated', einvoice_uuid: ' F9D425P6DS7D8IU ' })).toEqual({
      id: ID,
      einvoice_status: 'validated',
      einvoice_uuid: 'F9D425P6DS7D8IU',
    });
    expect(setEInvoiceInput.parse({ id: ID, einvoice_status: 'pending', einvoice_uuid: '   ' }).einvoice_uuid).toBeNull();
    expect(setEInvoiceInput.parse({ id: ID, einvoice_status: 'pending' }).einvoice_uuid).toBeNull();
    expect(first({ id: ID, einvoice_status: 'validated', einvoice_uuid: 'x'.repeat(101) })).toBe('Keep the UUID to 100 characters or fewer.');
    expect(first({ id: ID, einvoice_status: 'validated', einvoice_uuid: 'x'.repeat(100) })).toBeUndefined();
  });
  it('refuses a UUID with no status, after trimming', () => {
    expect(first({ id: ID, einvoice_status: 'none', einvoice_uuid: 'F9D425P6DS7D8IU' })).toBe(
      'An invoice with no e-Invois status has no UUID. Clear the UUID, or choose a status.',
    );
    expect(first({ id: ID, einvoice_status: 'none', einvoice_uuid: '  ' })).toBeUndefined();
  });
  it('asks for a real invoice id and has no place for anything else on the invoice', () => {
    expect(first({ id: 'nope', einvoice_status: 'none' })).toBe('That invoice no longer exists.');
    const parsed = setEInvoiceInput.parse({ id: ID, einvoice_status: 'pending', status: 'void', invoice_no: 'INV-1', org_id: 'x' });
    expect(Object.keys(parsed).sort()).toEqual(['einvoice_status', 'einvoice_uuid', 'id']);
  });
});

describe('setEInvoice', () => {
  const input = { id: ID, einvoice_status: 'validated' as const, einvoice_uuid: 'F9D425P6DS7D8IU' };

  it('changes only the two e-Invois columns and updated_at, scoped to the workspace', async () => {
    const { ctx, calls } = fakeFinance({ data: { id: ID }, error: null });
    expect(await setEInvoice(ctx, input)).toEqual({ ok: true, data: { id: ID } });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: 'finance_invoices', op: 'update', filters: { id: ID, org_id: 'org-1' } });
    expect(Object.keys(calls[0].values!).sort()).toEqual(['einvoice_status', 'einvoice_uuid', 'updated_at']);
    expect(calls[0].values).toMatchObject({ einvoice_status: 'validated', einvoice_uuid: 'F9D425P6DS7D8IU' });
  });
  it('clears the UUID when the status goes back to none', async () => {
    const { ctx, calls } = fakeFinance({ data: { id: ID }, error: null });
    await setEInvoice(ctx, { id: ID, einvoice_status: 'none', einvoice_uuid: '' });
    expect(calls[0].values).toMatchObject({ einvoice_status: 'none', einvoice_uuid: null });
  });
  it('says a draft has no e-Invois yet, a voided invoice can no longer be changed, and a missing one is gone', async () => {
    const refused = async (code: string) => setEInvoice(fakeFinance({ data: null, error: { code } }).ctx, input);
    expect(await refused('23514')).toEqual({ ok: false, error: 'e-Invois details can be recorded once the invoice is posted.' });
    expect(await refused('FIN01')).toEqual({ ok: false, error: 'This invoice has been posted or voided, so that can no longer be done.' });
    expect(await refused('42501')).toEqual({ ok: false, error: 'You do not have permission to make changes here.' });
    expect(await setEInvoice(fakeFinance({ data: null, error: null }).ctx, input)).toEqual({ ok: false, error: 'That invoice no longer exists.' });
    expect(logged).not.toHaveBeenCalled();
  });
  it('hides any other database error behind the general message and logs it', async () => {
    const { ctx } = fakeFinance({ data: null, error: { code: 'XX000' } });
    expect(await setEInvoice(ctx, input)).toEqual({ ok: false, error: 'That change could not be saved. Please try again.' });
    expect(logged).toHaveBeenCalled();
  });
});

describe('the sentence for an invoice that can no longer be changed', () => {
  it('never tells a person to void what they have just tried to void', async () => {
    // Voiding an invoice that someone else voided a moment ago is FIN01.
    const { ctx } = fakeFinance({ data: null, error: { code: 'FIN01' } });
    const result = await voidInvoice(ctx, { id: ID });
    expect(result).toEqual({ ok: false, error: INVOICE_MESSAGES.locked });
    expect(INVOICE_MESSAGES.locked).not.toMatch(/void it/i);
  });
  it('says where the payments of an invoice are voided', () => {
    expect(INVOICE_MESSAGES.hasPayments).toBe('This invoice has payments. Void them on Payments In before voiding it.');
    // A receipt cannot be deleted, so the sentence must not offer that.
    expect(INVOICE_MESSAGES.hasPayments).not.toMatch(/delete/i);
  });
});

describe('the same document twice on one payment', () => {
  const payment = { account_id: ACCOUNT, txn_date: '2026-10-05', method: 'fpx' as const };
  const firstIn = (value: unknown) => recordPaymentInInput.safeParse(value).error?.issues[0]?.message;
  const firstOut = (value: unknown) => recordPaymentOutInput.safeParse(value).error?.issues[0]?.message;

  it('is refused for an invoice whatever the capitals of its id', () => {
    const allocations = [{ invoice_id: LOWER, amount: 1 }, { invoice_id: UPPER, amount: 2 }];
    expect(firstIn({ ...payment, allocations })).toBe('Each invoice can appear once on a payment.');
    expect(firstIn({ ...payment, allocations: [allocations[1]] })).toBeUndefined();
  });
  it('is refused for a bill whatever the capitals of its id', () => {
    const allocations = [{ bill_id: UPPER, amount: 1 }, { bill_id: LOWER, amount: 2 }];
    expect(firstOut({ ...payment, allocations })).toBe('Each bill can appear once on a payment.');
    expect(firstOut({ ...payment, allocations: [allocations[0]] })).toBeUndefined();
  });
  it('is worded the same way when the database is the one to refuse it', async () => {
    const duplicate = { data: null, error: { code: '23505' } };
    expect(await recordPaymentIn(fakeFinance(duplicate).ctx, { ...payment, allocations: [{ invoice_id: LOWER, amount: 1 }] })).toEqual({
      ok: false,
      error: 'Each invoice can appear once on a payment.',
    });
    expect(await recordPaymentOut(fakeFinance(duplicate).ctx, { ...payment, allocations: [{ bill_id: LOWER, amount: 1 }] })).toEqual({
      ok: false,
      error: 'Each bill can appear once on a payment.',
    });
    expect(logged).not.toHaveBeenCalled();
  });
  it('is not what a unique violation means when a payment is marked paid', async () => {
    const { ctx } = fakeFinance({ data: null, error: { code: '23505' } });
    expect(await markPaymentPaid(ctx, { id: TXN, paid_on: '2026-10-09' })).toEqual({
      ok: false,
      error: 'That change could not be saved. Please try again.',
    });
    expect(logged).toHaveBeenCalled();
  });
});
```

Then change what three stage 3a test files pin. In each, the old text occurs once.

In `tests/finance-invoices.test.ts`, replace:

```ts
    display_status: 'sent', einvoice_status: 'none',
  });
```

with:

```ts
    display_status: 'sent', einvoice_status: 'none', einvoice_uuid: null,
  });
```

In `tests/finance-invoices.test.ts`, replace:

```ts
    expect(calls[0].columns).toContain('einvoice_status');
```

with:

```ts
    expect(calls[0].columns).toContain('einvoice_status');
    expect(calls[0].columns).toContain('einvoice_uuid');
```

In `tests/finance-invoices.test.ts`, replace:

```ts
      ['FIN01', 'This invoice is posted and can no longer be changed. Void it instead.'],
      ['FIN02', 'This invoice has payments. Void them before voiding it.'],
```

with:

```ts
      ['FIN01', 'This invoice has been posted or voided, so that can no longer be done.'],
      ['FIN02', 'This invoice has payments. Void them on Payments In before voiding it.'],
```

In `tests/finance-payments-in.test.ts`, replace:

```ts
      ['FIN09', 'This payment is posted and can no longer be changed. Void it instead.'],
      ['FIN11', 'That payment no longer exists.'],
      ['23503', 'The account or an invoice on this payment no longer exists.'],
```

with:

```ts
      ['FIN09', 'This payment has already been voided.'],
      ['FIN11', 'That payment no longer exists.'],
      ['23503', 'The account or an invoice on this payment no longer exists.'],
      ['23505', 'Each invoice can appear once on a payment.'],
```

In `tests/finance-payments-in.test.ts`, replace:

```ts
  recordPaymentOut,
  voidPayment,
} from '@/lib/finance/money';
```

with:

```ts
  recordPaymentOut,
  voidPaymentIn,
} from '@/lib/finance/money';
```

In `tests/finance-payments-in.test.ts`, replace:

```ts
  it('is voided by the same status change as a payment out', async () => {
    const { ctx, calls } = fakeFinance({ data: { id: TXN }, error: null });
    expect(await voidPayment(ctx, { id: TXN })).toEqual({ ok: true, data: { id: TXN } });
    expect(calls[0]).toMatchObject({ name: 'finance_transactions', op: 'update', filters: { id: TXN, org_id: 'org-1' } });
    expect(calls[0].values).toMatchObject({ status: 'void' });
  });
```

with:

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

The invoice row built by the sales views' test factory gains the new column:

In `tests/finance-sales-views.test.ts`, replace:

```ts
    display_status: 'sent',
    einvoice_status: 'none',
    ...i,
```

with:

```ts
    display_status: 'sent',
    einvoice_status: 'none',
    einvoice_uuid: null,
    ...i,
```

And the new schema joins the idempotency test:

In `tests/finance-schemas.test.ts`, replace:

```ts
import { invoiceIdInput, saveInvoiceInput } from '@/lib/finance/invoices';
```

with:

```ts
import { invoiceIdInput, saveInvoiceInput, setEInvoiceInput } from '@/lib/finance/invoices';
```

In `tests/finance-schemas.test.ts`, replace:

```ts
    allocations: [{ invoice_id: ID, amount: 10.005 }, { invoice_id: '22222222-2222-4222-8222-222222222222', amount: 5 }],
  }],
];
```

with:

```ts
    allocations: [{ invoice_id: ID, amount: 10.005 }, { invoice_id: '22222222-2222-4222-8222-222222222222', amount: 5 }],
  }],
  ['setEInvoiceInput', setEInvoiceInput, { id: ID, einvoice_status: 'validated', einvoice_uuid: ' F9D425P6DS7D8IU ' }],
  ['setEInvoiceInput (no status, an empty UUID box)', setEInvoiceInput, { id: ID, einvoice_status: 'none', einvoice_uuid: '  ' }],
  ['setEInvoiceInput (a status and no UUID yet)', setEInvoiceInput, { id: ID, einvoice_status: 'pending' }],
];
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm exec vitest run tests/finance-sales-data.test.ts tests/finance-invoices.test.ts tests/finance-payments-in.test.ts tests/finance-schemas.test.ts`
Expected: FAIL. `setEInvoice is not a function`, `voidPaymentIn is not a function`, `Cannot read properties of undefined (reading 'safeParse')` for `setEInvoiceInput`; the `FIN01`, `FIN02` and `FIN09` cases expect the new sentences and get the old ones; `expected '…einvoice_status' to contain 'einvoice_uuid'`; the two capitals tests get `undefined` where they expect the duplicate sentence. `tests/finance-sales-views.test.ts` still passes: it only gained a field.

- [ ] **Step 3: Change `src/lib/finance/invoices.ts`**

Eight edits, in the order they come in the file.

In `src/lib/finance/invoices.ts`, replace:

```ts
  NOT_ALLOWED,
  PG_FORBIDDEN,
  PG_FOREIGN_KEY,
  PG_OUT_OF_RANGE,
  PG_UNIQUE,
  TOO_LARGE,
  pgCode,
  writeFailed,
} from './result';

export const INVOICE_LINES_MAX = DOCUMENT_LINES_MAX;
/** Invoices loaded for a screen, a page at a time. */
export const INVOICE_PAGE_SIZE = 1000;
```

with:

```ts
  NOT_ALLOWED,
  PG_CHECK,
  PG_FORBIDDEN,
  PG_FOREIGN_KEY,
  PG_OUT_OF_RANGE,
  PG_UNIQUE,
  TOO_LARGE,
  pgCode,
  writeFailed,
} from './result';

export const INVOICE_LINES_MAX = DOCUMENT_LINES_MAX;
/** Invoices loaded for a screen, a page at a time. */
export const INVOICE_PAGE_SIZE = 1000;
/** What a person can record about an invoice's e-Invois at LHDN. Nothing is submitted by this app. */
export const EINVOICE_STATUSES = ['none', 'pending', 'validated', 'rejected'] as const;
/** LHDN's own UUIDs are 26 characters; the column is plain text, so this is only a sane ceiling. */
export const EINVOICE_UUID_MAX = 100;
```

In `src/lib/finance/invoices.ts`, replace:

```ts
  gone: 'That invoice no longer exists.',
  locked: 'This invoice is posted and can no longer be changed. Void it instead.',
  hasPayments: 'This invoice has payments. Void them before voiding it.',
  empty: 'An invoice needs at least one line with an amount.',
  numberTaken: 'That invoice number is already used.',
  missing: 'The customer or a product on this invoice no longer exists.',
} as const;
```

with:

```ts
  gone: 'That invoice no longer exists.',
  // FIN01. The menus offer only what an invoice's status allows, so this reaches a person only when the
  // invoice changed under them: a draft posted or a posted invoice voided in another tab. True of each.
  locked: 'This invoice has been posted or voided, so that can no longer be done.',
  // A receipt is posted the moment it is recorded, so it can only be voided, never deleted.
  hasPayments: 'This invoice has payments. Void them on Payments In before voiding it.',
  empty: 'An invoice needs at least one line with an amount.',
  numberTaken: 'That invoice number is already used.',
  missing: 'The customer or a product on this invoice no longer exists.',
  einvoiceStatus: 'Choose an e-Invois status.',
  einvoiceUuid: `Keep the UUID to ${EINVOICE_UUID_MAX} characters or fewer.`,
  einvoiceNone: 'An invoice with no e-Invois status has no UUID. Clear the UUID, or choose a status.',
  einvoiceDraft: 'e-Invois details can be recorded once the invoice is posted.',
} as const;
```

In `src/lib/finance/invoices.ts`, replace:

```ts
export const invoiceIdInput = z.object({ id: z.string({ error: M.gone }).uuid(M.gone) });
```

with:

```ts
export const invoiceIdInput = z.object({ id: z.string({ error: M.gone }).uuid(M.gone) });

/** What a person has recorded about a posted invoice's e-Invois: its status at LHDN and the UUID LHDN gave it. */
export const setEInvoiceInput = z
  .object({
    id: z.string({ error: M.gone }).uuid(M.gone),
    einvoice_status: z.enum(EINVOICE_STATUSES, { error: M.einvoiceStatus }),
    /** Trimmed; an empty box is stored as null. */
    einvoice_uuid: z
      .string({ error: M.einvoiceUuid })
      .trim()
      .max(EINVOICE_UUID_MAX, M.einvoiceUuid)
      .transform((v) => (v === '' ? null : v))
      .nullable()
      .default(null),
  })
  .refine((v) => v.einvoice_status !== 'none' || v.einvoice_uuid === null, {
    message: M.einvoiceNone,
    path: ['einvoice_uuid'],
  });
```

In `src/lib/finance/invoices.ts`, replace:

```ts
/** What a person has recorded about the invoice's e-Invois at LHDN. Nothing is submitted by this app. */
export type EInvoiceStatus = 'none' | 'pending' | 'validated' | 'rejected';
```

with:

```ts
/** What a person has recorded about the invoice's e-Invois at LHDN. Nothing is submitted by this app. */
export type EInvoiceStatus = (typeof EINVOICE_STATUSES)[number];
```

In `src/lib/finance/invoices.ts`, replace:

```ts
  display_status: InvoiceDisplayStatus;
  einvoice_status: EInvoiceStatus;
};

export type InvoiceLine = DocumentLineRow;

export type InvoiceDetail = InvoiceListRow & {
  subtotal: number;
  sst: number;
  notes: string | null;
  einvoice_uuid: string | null;
  lines: InvoiceLine[];
};

const LIST_COLUMNS =
  'id,invoice_no,customer_id,customer_name,invoice_date,due_date,total,paid,balance,display_status,einvoice_status';

function toListRow(row: Record<string, unknown>): InvoiceListRow {
  return {
    ...(row as unknown as InvoiceListRow),
    total: Number(row.total),
    paid: Number(row.paid),
    balance: Number(row.balance),
  };
}
```

with:

```ts
  display_status: InvoiceDisplayStatus;
  einvoice_status: EInvoiceStatus;
  /** The UUID LHDN gave the e-Invois, as a person typed it in; null when none was recorded. */
  einvoice_uuid: string | null;
};

export type InvoiceLine = DocumentLineRow;

export type InvoiceDetail = InvoiceListRow & {
  subtotal: number;
  sst: number;
  notes: string | null;
  lines: InvoiceLine[];
};

/**
 * The answer to "Save and post". When the draft was saved but posting it was
 * refused, `draftId` is that draft, so the form goes on editing it instead of
 * saving a second copy.
 */
export type SaveAndPostInvoiceResult = FinResult<{ id: string; invoice_no: string }> & { draftId?: string };

const LIST_COLUMNS =
  'id,invoice_no,customer_id,customer_name,invoice_date,due_date,total,paid,balance,display_status,einvoice_status,einvoice_uuid';

function toListRow(row: Record<string, unknown>): InvoiceListRow {
  return {
    ...(row as unknown as InvoiceListRow),
    total: Number(row.total),
    paid: Number(row.paid),
    balance: Number(row.balance),
    einvoice_uuid: (row.einvoice_uuid as string | null) ?? null,
  };
}
```

In `src/lib/finance/invoices.ts`, replace:

```ts
    .select(`${LIST_COLUMNS},subtotal,sst,notes,einvoice_uuid`)
```

with:

```ts
    .select(`${LIST_COLUMNS},subtotal,sst,notes`)
```

In `src/lib/finance/invoices.ts`, replace:

```ts
    notes: (header.notes as string | null) ?? null,
    einvoice_uuid: (header.einvoice_uuid as string | null) ?? null,
    lines:
```

with:

```ts
    notes: (header.notes as string | null) ?? null,
    lines:
```

In `src/lib/finance/invoices.ts`, replace:

```ts
  if (error) return invoiceWriteFailed('deleteInvoice', error);
  if (!data) return { ok: false, error: M.gone };
  return { ok: true, data: { id: data.id } };
}
```

with:

```ts
  if (error) return invoiceWriteFailed('deleteInvoice', error);
  if (!data) return { ok: false, error: M.gone };
  return { ok: true, data: { id: data.id } };
}

/**
 * Records what a person knows of a posted invoice's e-Invois. These two
 * columns, with updated_at, are all the database lets change on a posted
 * invoice. Nothing is sent to LHDN.
 */
export async function setEInvoice(
  ctx: FinanceWriteContext,
  input: z.input<typeof setEInvoiceInput>,
): Promise<FinResult<{ id: string }>> {
  const { id, einvoice_status, einvoice_uuid } = setEInvoiceInput.parse(input);
  const { data, error } = await ctx.client
    .from('finance_invoices')
    .update({ einvoice_status, einvoice_uuid, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('org_id', ctx.orgId)
    .select('id')
    .maybeSingle();
  // A draft has not gone anywhere, so the table's check constraint refuses an e-Invois on it.
  if (pgCode(error) === PG_CHECK) return { ok: false, error: M.einvoiceDraft };
  if (error) return invoiceWriteFailed('setEInvoice', error);
  if (!data) return { ok: false, error: M.gone };
  return { ok: true, data: { id: data.id } };
}
```

- [ ] **Step 4: Change `src/lib/finance/money.ts`**

Eight edits, in the order they come in the file. `voidPayment` keeps its body; only its comment changes, since it is no longer the function that voids money in.

In `src/lib/finance/money.ts`, replace:

```ts
  PG_FOREIGN_KEY,
  PG_OUT_OF_RANGE,
  TOO_LARGE,
  pgCode,
  writeFailed,
} from './result';

export const PAYMENT_METHODS
```

with:

```ts
  PG_FOREIGN_KEY,
  PG_OUT_OF_RANGE,
  PG_UNIQUE,
  TOO_LARGE,
  pgCode,
  writeFailed,
} from './result';

export const PAYMENT_METHODS
```

In `src/lib/finance/money.ts`, replace:

```ts
  oneCustomer: 'One payment can only pay invoices from one customer.',
  locked: M.locked,
  missing: 'The account or an invoice on this payment no longer exists.',
} as const;
```

with:

```ts
  oneCustomer: 'One payment can only pay invoices from one customer.',
  // FIN09. Money in is posted at once and has no edit or delete, so through the app this is only ever
  // a second attempt to void a payment someone has already voided.
  locked: 'This payment has already been voided.',
  missing: 'The account or an invoice on this payment no longer exists.',
} as const;
```

In `src/lib/finance/money.ts`, replace:

```ts
const id = z.string({ error: M.gone }).uuid(M.gone);
```

with:

```ts
const id = z.string({ error: M.gone }).uuid(M.gone);

/** True when no id is there twice. The database reads an id whatever its capitals, so they are compared without them. */
function eachOnce(ids: string[]): boolean {
  return new Set(ids.map((value) => value.toLowerCase())).size === ids.length;
}
```

In `src/lib/finance/money.ts`, replace:

```ts
    .refine((rows) => new Set(rows.map((r) => r.bill_id)).size === rows.length, M.duplicate),
```

with:

```ts
    .refine((rows) => eachOnce(rows.map((r) => r.bill_id)), M.duplicate),
```

In `src/lib/finance/money.ts`, replace:

```ts
    .refine((rows) => new Set(rows.map((r) => r.invoice_id)).size === rows.length, R.duplicate),
```

with:

```ts
    .refine((rows) => eachOnce(rows.map((r) => r.invoice_id)), R.duplicate),
```

In `src/lib/finance/money.ts`, replace:

```ts
/** The same database codes, worded for money in: the documents are invoices and the party is a customer. */
const RECEIPT_REFUSALS: Record<string, string> = {
  ...REFUSALS,
  FIN03: R.overSplit,
  FIN04: R.notPosted,
  FIN05: R.tooMuch,
  FIN06: R.oneCustomer,
  [PG_FOREIGN_KEY]: R.missing,
};
```

with:

```ts
/**
 * Recording a payment out. A unique violation here can only be the same bill
 * twice on one payment: the number comes from finance_next_number under a
 * lock. Marking a payment paid or voiding it keeps the plain map.
 */
const RECORD_OUT_REFUSALS: Record<string, string> = { ...REFUSALS, [PG_UNIQUE]: M.duplicate };

/** The same database codes, worded for money in: the documents are invoices and the party is a customer. */
const RECEIPT_REFUSALS: Record<string, string> = {
  ...REFUSALS,
  FIN03: R.overSplit,
  FIN04: R.notPosted,
  FIN05: R.tooMuch,
  FIN06: R.oneCustomer,
  FIN09: R.locked,
  [PG_FOREIGN_KEY]: R.missing,
  // The same invoice twice on one payment; see RECORD_OUT_REFUSALS.
  [PG_UNIQUE]: R.duplicate,
};
```

In `src/lib/finance/money.ts`, replace:

```ts
  if (error || !data) return moneyWriteFailed('recordPaymentOut', error);
```

with:

```ts
  if (error || !data) return moneyWriteFailed('recordPaymentOut', error, RECORD_OUT_REFUSALS);
```

In `src/lib/finance/money.ts`, replace:

```ts
/**
 * Voids a posted payment, money out or money in: it is one status change on
 * finance_transactions whichever way the money went. The bills or invoices it
 * paid owe that amount again.
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
    .from('finance_transactions')
    .update({ status: 'void', updated_at: new Date().toISOString() })
    .eq('id', txnId)
    .eq('org_id', ctx.orgId)
    .eq('direction', 'in')
    .select('id')
    .maybeSingle();
  if (error) return moneyWriteFailed('voidPaymentIn', error, RECEIPT_REFUSALS);
  if (!data) return { ok: false, error: R.gone };
  return { ok: true, data: { id: data.id } };
}
```

- [ ] **Step 5: Give the sample rows the new column**

In `src/screens/finance/sales-sample.ts`, replace:

```ts
  display_status,
  einvoice_status,
});
```

with:

```ts
  display_status,
  einvoice_status,
  einvoice_uuid: null,
});
```

- [ ] **Step 6: Run the tests**

Run: `pnpm exec vitest run tests/finance-sales-data.test.ts tests/finance-invoices.test.ts tests/finance-payments-in.test.ts tests/finance-sales-views.test.ts tests/finance-schemas.test.ts tests/finance-money.test.ts tests/finance-actions.test.ts`
Expected: PASS, all seven files; 14 tests in `finance-sales-data`. `finance-money` and `finance-actions` were not edited and still pass: `voidPayment` filters by `id` and `org_id` only, as before.

- [ ] **Step 7: Type-check, lint and commit**

Run, as separate commands: `pnpm exec tsc --noEmit`, `pnpm lint`, `pnpm exec vitest run --exclude 'tests/*.rls.test.ts' --exclude 'tests/bendahara-*.test.ts'`
Expected: no errors; every unit test passes.

```bash
git add src/lib/finance/invoices.ts src/lib/finance/money.ts src/screens/finance/sales-sample.ts tests/finance-sales-data.test.ts tests/finance-invoices.test.ts tests/finance-payments-in.test.ts tests/finance-sales-views.test.ts tests/finance-schemas.test.ts
git commit -m "feat: set an invoice's e-Invois, void money in with its own sentences, refuse a document twice on a payment"
```

---

### Task 3: The rules of the invoice form, the payment-in form and the row menus

Pure functions and their tests. Nothing on a screen changes yet.

**Files:**
- Create: `src/lib/finance/invoice-form.ts`
- Create: `src/lib/finance/receipt-form.ts`
- Modify: `src/lib/finance/sales-views.ts`
- Modify: `src/lib/finance/view-helpers.ts`
- Modify: `src/lib/finance/purchase-views.ts`
- Create: `tests/finance-invoice-form.test.ts`
- Create: `tests/finance-receipt-form.test.ts`
- Create: `tests/finance-sales-rules.test.ts`

**Interfaces:**
- Consumes: everything `document-form.ts` and `allocation-form.ts` produce (Task 1); `saveInvoiceInput`, `setEInvoiceInput`, `INVOICE_MESSAGES`, `InvoiceDetail`, `InvoiceListRow`, `EInvoiceStatus` from `@/lib/finance/invoices` (Task 2); `recordPaymentInInput`, `RECEIPT_MESSAGES`, `PaymentInRow`, `FinanceAccount`, `PaymentMethod` from `@/lib/finance/money`; `billTotals` from `@/lib/finance/bill-math`.
- Produces:
  - `@/lib/finance/invoice-form`: `type InvoiceForm = { id?: string; customer_id: string; invoice_date: string; due_date: string; dueEdited: boolean; notes: string; lines: LineDraft[] }`; `newInvoiceForm(today: string, lineKey: string): InvoiceForm`; `invoiceFormFromDetail(invoice: InvoiceDetail): InvoiceForm`; `withCustomer(form, customer: { id: string; payment_terms_days: number }): InvoiceForm`; `withInvoiceDate(form, invoiceDate: string, termsDays: number | undefined): InvoiceForm`; `withSoldProduct(line: LineDraft, product: FinanceProduct | null): LineDraft`; `invoicePayload(form)`; `invoiceFormError(form, posting?: boolean): string | null`; `invoiceSavedNotPosted(error: string): string`; `INVOICE_FORM_KIND: DocumentFormKind<InvoiceForm>`; `type EInvoiceForm = { status: EInvoiceStatus; uuid: string }`; `eInvoiceForm(invoice): EInvoiceForm`; `withEInvoiceStatus(form, status): EInvoiceForm`; `eInvoicePayload(invoiceId: string, form)`; `eInvoiceFormError(invoiceId: string, form): string | null`.
  - `@/lib/finance/receipt-form`: `type ReceivableInvoice = { id: string; invoice_no: string; customer_id: string; customer_name: string; due_date: string; overdue: boolean; balance: number; held: number; payable: number }`; `type ReceiptForm = { customerId: string; amounts: Record<string, string>; accountId: string; date: string; method: PaymentMethod; reference: string; notes: string }`; `heldByInvoice(payments: PaymentInRow[]): Record<string, number>`; `receivableInvoices(invoices: InvoiceListRow[], payments: PaymentInRow[]): ReceivableInvoice[]`; `receiptCustomers`, `invoicesOf`, `newReceiptForm(receivable, accounts, today, preselect?: { customerId: string; invoiceId: string })`, `chooseCustomer`, `toggleInvoice`, `toggleAllInvoices`, `keepReceivable`, `receiptTotal`, `receiptPayload`, `receiptFormError(form, receivable): string | null`; `PAYMENT_IN_KIND: AllocationFormKind<ReceiptForm, ReceivableInvoice>`.
  - `@/lib/finance/sales-views`: `customerChoice(chosen: string, customers: { id: string }[]): string`; `type InvoiceAction = 'edit' | 'post' | 'delete' | 'pay' | 'einvoice' | 'void'`; `invoiceActions(invoice: InvoiceListRow, canTakePayment: boolean): InvoiceAction[]`; `paymentInActions(row: PaymentInRow): 'void'[]`; `siblingInvoices(rows, row): string[]`; `alsoCoversInvoices(rows: PaymentInRow[], row: PaymentInRow): string`.
  - `@/lib/finance/view-helpers`: `alsoCoversSentence(others: string[]): string`. `alsoCovers` in `purchase-views.ts` is rewritten on it and answers exactly as before.

The rules, in words:

- **Invoice form.** As the bill form, with a customer: the due date follows the customer's payment terms and the invoice date until it is set by hand; a product fills a line at its *price*; "Save and post" is refused in the form when the lines total nothing.
- **e-Invois form.** It opens on what the invoice has. Choosing None empties the UUID. What is wrong with it is whatever `setEInvoiceInput` says.
- **Payment-in form.** It offers one customer's invoices that are Sent or Overdue and still owed something, each for no more than is owed. There is no "scheduled": the payload has no such key and the kind has no `schedule`.
- **Invoice row menu** (`invoiceActions`): draft → Edit, Post, Delete. Sent, Overdue or Paid → Record payment (only while a payment could still be taken), Set e-Invois, Void. Void → nothing. A draft is never offered Void and a posted invoice is never offered Edit or Delete: those are the `FIN01` cases.
- **Payment-in row menu** (`paymentInActions`): a received payment → Void. Anything else → nothing.
- **Customer filter** (`customerChoice`): the chosen customer if they still have an invoice, otherwise `'all'`.

- [ ] **Step 1: Write the failing tests for the invoice form**

Create `tests/finance-invoice-form.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { billTotals } from '@/lib/finance/bill-math';
import { emptyLine, lineNumbers } from '@/lib/finance/document-form';
import {
  INVOICE_FORM_KIND,
  type InvoiceForm,
  eInvoiceForm,
  eInvoiceFormError,
  eInvoicePayload,
  invoiceFormError,
  invoiceFormFromDetail,
  invoicePayload,
  invoiceSavedNotPosted,
  newInvoiceForm,
  withCustomer,
  withEInvoiceStatus,
  withInvoiceDate,
  withSoldProduct,
} from '@/lib/finance/invoice-form';
import { INVOICE_MESSAGES, type InvoiceDetail, saveInvoiceInput, setEInvoiceInput } from '@/lib/finance/invoices';
import type { FinanceProduct } from '@/lib/finance/products';
import { WRITE_FAILED } from '@/lib/finance/result';

const INVOICE = '33333333-3333-4333-8333-333333333333';
const CUSTOMER = '44444444-4444-4444-8444-444444444444';
const PRODUCT = '99999999-9999-4999-8999-999999999999';
const today = '2026-10-11';

const gloves: FinanceProduct = {
  id: PRODUCT,
  sku: 'PRD-010',
  name: 'Nitrile Gloves (Box)',
  type: 'product',
  category: 'Consumables',
  uom: 'box',
  price: 24.9,
  cost: 12.5,
  sst_rate: 6,
  active: true,
};

/** A form that can be saved: a customer and one line of 10 at RM 24.90. */
const filled = (f: Partial<InvoiceForm> = {}): InvoiceForm => ({
  ...newInvoiceForm(today, 'k1'),
  customer_id: CUSTOMER,
  due_date: '2026-11-10',
  lines: [{ ...emptyLine('k1'), description: 'Gloves', quantity: '10', unit_price: '24.90' }],
  ...f,
});

describe('newInvoiceForm', () => {
  it('is dated today with one empty line of quantity 1 and no SST, and has no supplier reference', () => {
    expect(newInvoiceForm(today, 'k1')).toEqual({
      customer_id: '',
      invoice_date: today,
      due_date: today,
      dueEdited: false,
      notes: '',
      lines: [{ key: 'k1', product_id: '', description: '', quantity: '1', uom: '', pack_size: '', unit_price: '', sst_rate: '0' }],
    });
  });
});

describe('the due date', () => {
  const customer = { id: CUSTOMER, payment_terms_days: 30 };

  it('follows the customer’s payment terms and the invoice date', () => {
    const chosen = withCustomer(newInvoiceForm(today, 'k1'), customer);
    expect(chosen).toMatchObject({ customer_id: CUSTOMER, due_date: '2026-11-10', dueEdited: false });
    expect(withInvoiceDate(chosen, '2026-12-15', 30)).toMatchObject({ invoice_date: '2026-12-15', due_date: '2027-01-14' });
    expect(withCustomer(chosen, { id: 'other', payment_terms_days: 7 }).due_date).toBe('2026-10-18');
    expect(withCustomer(chosen, { id: 'cash', payment_terms_days: 0 }).due_date).toBe(today);
  });
  it('stops following once the person sets it by hand', () => {
    const edited = { ...withCustomer(newInvoiceForm(today, 'k1'), customer), due_date: '2026-10-25', dueEdited: true };
    expect(withInvoiceDate(edited, '2026-10-12', 30).due_date).toBe('2026-10-25');
    expect(withCustomer(edited, { id: 'other', payment_terms_days: 7 })).toMatchObject({ customer_id: 'other', due_date: '2026-10-25' });
  });
  it('stays where it was while the invoice date is half typed or cleared', () => {
    const chosen = withCustomer(newInvoiceForm(today, 'k1'), customer);
    expect(withInvoiceDate(chosen, '', 30)).toMatchObject({ invoice_date: '', due_date: '2026-11-10' });
    expect(withInvoiceDate(chosen, '0002-10-11', 30).due_date).toBe('2026-11-10');
    // A customer chosen while the date box is empty does not blank the due date either.
    expect(withCustomer({ ...chosen, invoice_date: '' }, { id: 'other', payment_terms_days: 7 }).due_date).toBe('2026-11-10');
  });
});

describe('withSoldProduct', () => {
  const line = { ...emptyLine('k1'), description: 'typed by hand', quantity: '4', unit_price: '9', pack_size: '100 pcs' };

  it('fills the unit price from the product’s price, not its cost', () => {
    expect(withSoldProduct(line, gloves)).toEqual({
      key: 'k1',
      product_id: PRODUCT,
      description: 'Nitrile Gloves (Box)',
      quantity: '4',
      uom: 'box',
      pack_size: '100 pcs',
      unit_price: '24.9',
      sst_rate: '6',
    });
  });
  it('only clears the link when "no product" is chosen', () => {
    const linked = withSoldProduct(line, gloves);
    expect(withSoldProduct(linked, null)).toEqual({ ...linked, product_id: '' });
  });
});

describe('invoiceFormError', () => {
  it('passes a form that can be saved', () => {
    expect(invoiceFormError(filled())).toBeNull();
  });
  it('asks for a customer first', () => {
    expect(invoiceFormError(filled({ customer_id: '' }))).toBe('Choose a customer.');
  });
  it('asks for real dates, the due date not before the invoice date', () => {
    expect(invoiceFormError(filled({ invoice_date: '' }))).toBe('Enter a valid date.');
    expect(invoiceFormError(filled({ due_date: '20261-11-10' }))).toBe('Enter a valid date.');
    expect(invoiceFormError(filled({ due_date: '2026-10-10' }))).toBe('The due date cannot be before the invoice date.');
  });
  it('checks each line in the schema’s words, and refuses a figure typed with a comma', () => {
    const line = filled().lines[0];
    const withLine = (l: Partial<typeof line>) => filled({ lines: [{ ...line, ...l }] });
    expect(invoiceFormError(withLine({ description: '  ' }))).toBe('Describe each line.');
    expect(invoiceFormError(withLine({ quantity: '0' }))).toBe('Enter a quantity above 0.');
    expect(invoiceFormError(withLine({ quantity: '1,000' }))).toBe('Enter a quantity above 0.');
    expect(invoiceFormError(withLine({ unit_price: '' }))).toBe('Enter a unit price of 0 or more.');
    expect(invoiceFormError(withLine({ unit_price: '1,250.00' }))).toBe('Enter a unit price of 0 or more.');
    expect(invoiceFormError(withLine({ sst_rate: '101' }))).toBe('Enter an SST rate between 0 and 100.');
    expect(invoiceFormError(withLine({ sst_rate: '' }))).toBeNull();
  });
  it('asks for at least one line, and at most 100', () => {
    const line = filled().lines[0];
    expect(invoiceFormError(filled({ lines: [] }))).toBe('Add at least one line.');
    expect(invoiceFormError(filled({ lines: Array.from({ length: 101 }, (_, i) => ({ ...line, key: `k${i}` })) }))).toBe(
      'An invoice can have at most 100 lines.',
    );
  });
  it('lets a draft total nothing, but not an invoice that is being posted', () => {
    const free = filled({ lines: [{ ...filled().lines[0], unit_price: '0' }] });
    expect(invoiceFormError(free)).toBeNull();
    expect(invoiceFormError(free, true)).toBe('An invoice needs at least one line with an amount.');
    expect(invoiceFormError(filled(), true)).toBeNull();
  });
});

describe('invoicePayload', () => {
  it('sends numbers, never the text that was typed, with the lines in the order they are on the form', () => {
    const payload = invoicePayload(
      filled({
        notes: ' Net 30 ',
        lines: [
          { key: 'k1', product_id: PRODUCT, description: ' Gloves ', quantity: '10', uom: 'box', pack_size: '', unit_price: '24.90', sst_rate: '6' },
          { ...emptyLine('k2'), description: 'Delivery', unit_price: '20' },
        ],
      }),
    );
    expect(payload).toEqual({
      customer_id: CUSTOMER,
      invoice_date: today,
      due_date: '2026-11-10',
      notes: ' Net 30 ',
      lines: [
        { product_id: PRODUCT, description: ' Gloves ', uom: 'box', pack_size: '', quantity: 10, unit_price: 24.9, sst_rate: 6 },
        { product_id: '', description: 'Delivery', uom: '', pack_size: '', quantity: 1, unit_price: 20, sst_rate: 0 },
      ],
    });
    expect('id' in payload).toBe(false);
    expect(saveInvoiceInput.parse(payload)).toMatchObject({ notes: 'Net 30', lines: [{ description: 'Gloves' }, { description: 'Delivery', product_id: null }] });
  });
  it('sends the id when a draft is being changed, and never the line keys, the dueEdited flag or a workspace', () => {
    const payload = invoicePayload(filled({ id: INVOICE }));
    expect(payload.id).toBe(INVOICE);
    expect(Object.keys(payload).sort()).toEqual(['customer_id', 'due_date', 'id', 'invoice_date', 'lines', 'notes']);
    expect(Object.keys(payload.lines[0]).sort()).toEqual(['description', 'pack_size', 'product_id', 'quantity', 'sst_rate', 'unit_price', 'uom']);
  });
});

describe('invoiceFormFromDetail', () => {
  const detail: InvoiceDetail = {
    id: INVOICE,
    invoice_no: null,
    customer_id: CUSTOMER,
    customer_name: 'Aisyah Trading',
    invoice_date: '2026-10-01',
    due_date: '2026-10-15',
    total: 263.94,
    paid: 0,
    balance: 263.94,
    display_status: 'draft',
    einvoice_status: 'none',
    einvoice_uuid: null,
    subtotal: 249,
    sst: 14.94,
    notes: 'Net 14',
    lines: [
      { id: 'line-1', product_id: PRODUCT, description: 'Nitrile Gloves (Box)', quantity: 10, uom: 'box', pack_size: '100 pcs', unit_price: 24.9, sst_rate: 6, amount: 249, sst_amount: 14.94 },
      { id: 'line-2', product_id: null, description: 'Delivery', quantity: 1, uom: null, pack_size: null, unit_price: 0, sst_rate: 0, amount: 0, sst_amount: 0 },
    ],
  };

  it('shows a saved draft as it was saved, in the order of its lines, and keeps its due date', () => {
    const form = invoiceFormFromDetail(detail);
    expect(form).toMatchObject({ id: INVOICE, customer_id: CUSTOMER, invoice_date: '2026-10-01', due_date: '2026-10-15', dueEdited: true, notes: 'Net 14' });
    expect(form.lines.map((l) => [l.key, l.description, l.unit_price])).toEqual([
      ['line-1', 'Nitrile Gloves (Box)', '24.9'],
      ['line-2', 'Delivery', '0'],
    ]);
  });
  it('saves back what it loaded: nothing is lost by opening and saving a draft', () => {
    const form = invoiceFormFromDetail(detail);
    expect(invoiceFormError(form)).toBeNull();
    const parsed = saveInvoiceInput.parse(invoicePayload(form));
    expect(parsed.id).toBe(INVOICE);
    expect(parsed.lines).toEqual([
      { product_id: PRODUCT, description: 'Nitrile Gloves (Box)', quantity: 10, uom: 'box', pack_size: '100 pcs', unit_price: 24.9, sst_rate: 6 },
      { product_id: null, description: 'Delivery', quantity: 1, uom: null, pack_size: null, unit_price: 0, sst_rate: 0 },
    ]);
    expect(billTotals(form.lines.map(lineNumbers))).toEqual({ subtotal: 249, sst: 14.94, total: 263.94 });
  });
});

describe('invoiceSavedNotPosted', () => {
  it('says the draft was saved, then why it was not posted', () => {
    expect(invoiceSavedNotPosted(WRITE_FAILED)).toBe('The invoice was saved as a draft, but posting it failed. Please try again.');
    expect(invoiceSavedNotPosted(INVOICE_MESSAGES.empty)).toBe(
      `The invoice was saved as a draft, but it was not posted. ${INVOICE_MESSAGES.empty}`,
    );
  });
});

describe('the invoice form, as the shared card draws it', () => {
  it('is the invoice form’s own rules, with no second reference box', () => {
    expect(INVOICE_FORM_KIND.withParty).toBe(withCustomer);
    expect(INVOICE_FORM_KIND.withDate).toBe(withInvoiceDate);
    expect(INVOICE_FORM_KIND.withProduct).toBe(withSoldProduct);
    expect(INVOICE_FORM_KIND.error).toBe(invoiceFormError);
    expect(INVOICE_FORM_KIND.payload).toBe(invoicePayload);
    expect(INVOICE_FORM_KIND.savedNotPosted).toBe(invoiceSavedNotPosted);
    expect(INVOICE_FORM_KIND.reference).toBeUndefined();
  });
  it('reads the customer and the invoice date, and says customer and invoice', () => {
    expect(INVOICE_FORM_KIND.partyId(filled())).toBe(CUSTOMER);
    expect(INVOICE_FORM_KIND.date(filled())).toBe(today);
    expect([INVOICE_FORM_KIND.noun, INVOICE_FORM_KIND.party, INVOICE_FORM_KIND.dateLabel]).toEqual(['invoice', 'customer', 'Invoice date']);
  });
});

describe('the e-Invois form', () => {
  it('opens on what the invoice has now', () => {
    expect(eInvoiceForm({ einvoice_status: 'none', einvoice_uuid: null })).toEqual({ status: 'none', uuid: '' });
    expect(eInvoiceForm({ einvoice_status: 'validated', einvoice_uuid: 'F9D425P6DS7D8IU' })).toEqual({ status: 'validated', uuid: 'F9D425P6DS7D8IU' });
  });
  it('keeps the UUID while the status moves between pending, validated and rejected, and empties it for None', () => {
    const form = { status: 'pending' as const, uuid: 'F9D425P6DS7D8IU' };
    expect(withEInvoiceStatus(form, 'validated')).toEqual({ status: 'validated', uuid: 'F9D425P6DS7D8IU' });
    expect(withEInvoiceStatus(form, 'rejected')).toEqual({ status: 'rejected', uuid: 'F9D425P6DS7D8IU' });
    expect(withEInvoiceStatus(form, 'none')).toEqual({ status: 'none', uuid: '' });
  });
  it('sends the invoice, the status and the UUID as typed; the schema trims it', () => {
    const payload = eInvoicePayload(INVOICE, { status: 'validated', uuid: ' F9D425P6DS7D8IU ' });
    expect(payload).toEqual({ id: INVOICE, einvoice_status: 'validated', einvoice_uuid: ' F9D425P6DS7D8IU ' });
    expect(setEInvoiceInput.parse(payload).einvoice_uuid).toBe('F9D425P6DS7D8IU');
  });
  it('says what is wrong in the schema’s words', () => {
    expect(eInvoiceFormError(INVOICE, { status: 'pending', uuid: '' })).toBeNull();
    expect(eInvoiceFormError(INVOICE, { status: 'validated', uuid: 'x'.repeat(101) })).toBe('Keep the UUID to 100 characters or fewer.');
    expect(eInvoiceFormError(INVOICE, { status: 'none', uuid: 'F9D425P6DS7D8IU' })).toBe(
      'An invoice with no e-Invois status has no UUID. Clear the UUID, or choose a status.',
    );
    expect(eInvoiceFormError('nope', { status: 'pending', uuid: '' })).toBe('That invoice no longer exists.');
  });
});
```

- [ ] **Step 2: Write the failing tests for the payment-in form**

Create `tests/finance-receipt-form.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { InvoiceListRow } from '@/lib/finance/invoices';
import { type FinanceAccount, type PaymentInRow, recordPaymentInInput } from '@/lib/finance/money';
import {
  PAYMENT_IN_KIND,
  type ReceiptForm,
  type ReceivableInvoice,
  chooseCustomer,
  heldByInvoice,
  invoicesOf,
  keepReceivable,
  newReceiptForm,
  receiptCustomers,
  receiptFormError,
  receiptPayload,
  receiptTotal,
  receivableInvoices,
  toggleAllInvoices,
  toggleInvoice,
} from '@/lib/finance/receipt-form';

const AISYAH = '11111111-1111-4111-8111-111111111111';
const ZAKI = '22222222-2222-4222-8222-222222222222';
const BANK = '66666666-6666-4666-8666-666666666666';
const CASH = '77777777-7777-4777-8777-777777777777';
const today = '2026-10-11';

/** 1 → a valid uuid ending in 000000000001. */
const invoiceId = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;

const invoice = (n: number, i: Partial<InvoiceListRow> = {}): InvoiceListRow => ({
  id: invoiceId(n),
  invoice_no: `INV-${String(n).padStart(4, '0')}`,
  customer_id: AISYAH,
  customer_name: 'Aisyah Trading',
  invoice_date: '2026-10-01',
  due_date: '2026-10-31',
  total: 100,
  paid: 0,
  balance: 100,
  display_status: 'sent',
  einvoice_status: 'none',
  einvoice_uuid: null,
  ...i,
});

const received = (n: number, p: Partial<PaymentInRow> = {}): PaymentInRow => ({
  allocation_id: `alloc-${n}-${p.status ?? 'posted'}-${p.amount ?? 100}`,
  transaction_id: `txn-${n}`,
  number: 'RC-0001',
  txn_date: '2026-10-05',
  method: 'fpx',
  amount: 100,
  transaction_amount: 100,
  status: 'posted',
  reference: null,
  account_id: BANK,
  account_name: 'Main Bank',
  invoice_id: invoiceId(n),
  invoice_no: `INV-${String(n).padStart(4, '0')}`,
  customer_name: 'Aisyah Trading',
  ...p,
});

const accounts: FinanceAccount[] = [
  { id: CASH, name: 'Cash in hand', kind: 'cash', bank_name: null },
  { id: BANK, name: 'Main Bank', kind: 'bank', bank_name: 'Maybank' },
];

const form = (receivable: ReceivableInvoice[], f: Partial<ReceiptForm> = {}): ReceiptForm => ({
  ...newReceiptForm(receivable, accounts, today),
  customerId: AISYAH,
  ...f,
});

describe('receivableInvoices', () => {
  it('offers posted invoices that still owe something, and no others', () => {
    const receivable = receivableInvoices(
      [
        invoice(1),
        invoice(2, { display_status: 'overdue', due_date: '2026-10-04' }),
        invoice(3, { display_status: 'draft', invoice_no: null }),
        invoice(4, { display_status: 'paid', balance: 0, paid: 100 }),
        invoice(5, { display_status: 'void' }),
        invoice(6, { balance: 0 }),
      ],
      [],
    );
    expect(receivable.map((i) => [i.invoice_no, i.overdue, i.payable])).toEqual([
      ['INV-0002', true, 100],
      ['INV-0001', false, 100],
    ]);
  });

  it('offers a part-paid invoice for what is left, to the sen', () => {
    const receivable = receivableInvoices([invoice(1, { total: 3500, paid: 1000.1, balance: 2499.9 })], [received(1, { amount: 1000.1 })]);
    expect(receivable[0]).toMatchObject({ balance: 2499.9, held: 0, payable: 2499.9 });
  });

  it('takes off what a payment not yet posted holds, as the database does, and drops an invoice it covers', () => {
    const receivable = receivableInvoices(
      [invoice(1, { balance: 500 }), invoice(2, { balance: 300 }), invoice(3, { balance: 80.1 })],
      [
        received(1, { status: 'draft', amount: 150 }),
        received(1, { status: 'pending_approval', amount: 50 }),
        received(2, { status: 'scheduled', amount: 300 }),
        // A voided payment holds nothing.
        received(3, { status: 'void', amount: 80.1 }),
      ],
    );
    expect(receivable.map((i) => [i.invoice_no, i.balance, i.held, i.payable])).toEqual([
      ['INV-0001', 500, 200, 300],
      ['INV-0003', 80.1, 0, 80.1],
    ]);
    expect(heldByInvoice([received(1, { status: 'draft', amount: 0.1 }), received(1, { status: 'scheduled', amount: 0.2 })])).toEqual({
      [invoiceId(1)]: 0.3,
    });
  });

  it('sorts by customer, then the earliest due date', () => {
    const receivable = receivableInvoices(
      [
        invoice(1, { customer_id: ZAKI, customer_name: 'Zaki Enterprise', due_date: '2026-10-01' }),
        invoice(2, { due_date: '2026-11-15' }),
        invoice(3, { due_date: '2026-10-20' }),
      ],
      [],
    );
    expect(receivable.map((i) => i.invoice_no)).toEqual(['INV-0003', 'INV-0002', 'INV-0001']);
  });
});

describe('receiptCustomers and invoicesOf', () => {
  const receivable = receivableInvoices(
    [invoice(1), invoice(2), invoice(3, { customer_id: ZAKI, customer_name: 'Zaki Enterprise' })],
    [],
  );

  it('lists each customer once with how many invoices are open, and one customer’s invoices', () => {
    expect(receiptCustomers(receivable)).toEqual([
      { id: AISYAH, name: 'Aisyah Trading', open: 2 },
      { id: ZAKI, name: 'Zaki Enterprise', open: 1 },
    ]);
    expect(invoicesOf(receivable, AISYAH).map((i) => i.invoice_no)).toEqual(['INV-0001', 'INV-0002']);
    expect(invoicesOf(receivable, 'nobody')).toEqual([]);
  });
});

describe('newReceiptForm', () => {
  const receivable = receivableInvoices(
    [invoice(1, { balance: 250.5 }), invoice(2), invoice(3, { customer_id: ZAKI, customer_name: 'Zaki Enterprise' })],
    [],
  );

  it('starts with no customer, nothing ticked, the bank account, today, and no scheduling', () => {
    expect(newReceiptForm(receivable, accounts, today)).toEqual({
      customerId: '',
      amounts: {},
      accountId: BANK,
      date: today,
      method: 'bank_transfer',
      reference: '',
      notes: '',
    });
  });
  it('chooses the customer when there is only one', () => {
    expect(newReceiptForm(invoicesOf(receivable, ZAKI), accounts, today).customerId).toBe(ZAKI);
  });
  it('opens from an invoice’s row with that customer chosen and that invoice ticked for all it is owed', () => {
    const opened = newReceiptForm(receivable, accounts, today, { customerId: AISYAH, invoiceId: invoiceId(1) });
    expect(opened).toMatchObject({ customerId: AISYAH, amounts: { [invoiceId(1)]: '250.50' } });
  });
  it('ticks nothing when the invoice from the row is no longer receivable, or belongs to someone else', () => {
    expect(newReceiptForm(receivable, accounts, today, { customerId: AISYAH, invoiceId: invoiceId(9) }).amounts).toEqual({});
    expect(newReceiptForm(receivable, accounts, today, { customerId: AISYAH, invoiceId: invoiceId(3) }).amounts).toEqual({});
  });
  it('falls back to any account, then to none', () => {
    expect(newReceiptForm(receivable, [accounts[0]], today).accountId).toBe(CASH);
    expect(newReceiptForm(receivable, [], today).accountId).toBe('');
  });
});

describe('ticking invoices', () => {
  const receivable = receivableInvoices([invoice(1, { balance: 250.5 }), invoice(2)], []);

  it('ticks an invoice for all it is owed, unticks it, ticks all and clears all', () => {
    const one = toggleInvoice(form(receivable), receivable[0], true);
    expect(one.amounts).toEqual({ [invoiceId(1)]: '250.50' });
    expect(toggleInvoice(one, receivable[0], false).amounts).toEqual({});
    const all = toggleAllInvoices(form(receivable), receivable, true);
    expect(all.amounts).toEqual({ [invoiceId(1)]: '250.50', [invoiceId(2)]: '100.00' });
    expect(receiptTotal(all)).toBe(350.5);
    expect(toggleAllInvoices(all, receivable, false).amounts).toEqual({});
  });
  it('starts the ticks again when another customer is chosen, and keeps them when the same one is chosen', () => {
    const one = toggleInvoice(form(receivable), receivable[0], true);
    expect(chooseCustomer(one, ZAKI)).toMatchObject({ customerId: ZAKI, amounts: {} });
    expect(chooseCustomer(one, AISYAH)).toBe(one);
  });
  it('drops a ticked invoice that was paid off while the form was open', () => {
    const all = toggleAllInvoices(form(receivable), receivable, true);
    const left = keepReceivable(all, [receivable[1]]);
    expect(left.amounts).toEqual({ [invoiceId(2)]: '100.00' });
    expect(receiptTotal(left)).toBe(100);
    expect(keepReceivable(all, receivable)).toBe(all);
  });
});

describe('receiptFormError', () => {
  const receivable = receivableInvoices(
    [invoice(1, { balance: 250.5 }), invoice(2), invoice(3, { customer_id: ZAKI, customer_name: 'Zaki Enterprise' })],
    [],
  );
  const ready = toggleInvoice(form(receivable), receivable[0], true);

  it('passes a form that can be sent', () => {
    expect(receiptFormError(ready, receivable)).toBeNull();
  });
  it('asks for a customer, then at least one invoice', () => {
    expect(receiptFormError(form(receivable, { customerId: '' }), receivable)).toBe('Choose a customer.');
    expect(receiptFormError(form(receivable), receivable)).toBe('Choose at least one invoice this payment is for.');
  });
  it('refuses an empty amount, zero, and one typed with a comma', () => {
    const typed = (text: string) => receiptFormError({ ...ready, amounts: { [invoiceId(1)]: text } }, receivable);
    expect(typed('')).toBe('Enter an amount above 0.');
    expect(typed('0')).toBe('Enter an amount above 0.');
    expect(typed('0.004')).toBe('Enter an amount above 0.');
    expect(typed('1,200.50')).toBe('Enter an amount above 0.');
  });
  it('refuses more than an invoice is owed, to the sen, and takes exactly what is owed', () => {
    const typed = (text: string) => receiptFormError({ ...ready, amounts: { [invoiceId(1)]: text } }, receivable);
    expect(typed('250.51')).toBe('That is more than is still owed on an invoice.');
    expect(typed('250.50')).toBeNull();
    expect(typed('0.01')).toBeNull();
  });
  it('refuses an invoice that is no longer receivable, or that belongs to another customer', () => {
    expect(receiptFormError(ready, invoicesOf(receivable, 'nobody'))).toBe('That is more than is still owed on an invoice.');
    expect(receiptFormError({ ...ready, amounts: { [invoiceId(3)]: '1' } }, receivable)).toBe('That is more than is still owed on an invoice.');
  });
  it('asks for an account and a real date in the schema’s words', () => {
    expect(receiptFormError({ ...ready, accountId: '' }, receivable)).toBe('Choose the account the money went into.');
    expect(receiptFormError({ ...ready, date: '' }, receivable)).toBe('Enter a valid date.');
    expect(receiptFormError({ ...ready, reference: 'x'.repeat(201) }, receivable)).toBe('That is too long. Keep it to 200 characters or fewer.');
  });
  it('takes fifty invoices in one payment and refuses fifty-one', () => {
    const many = Array.from({ length: 51 }, (_, n) => invoice(n + 1));
    const offered = receivableInvoices(many, []);
    expect(receiptFormError(toggleAllInvoices(form(offered), offered.slice(0, 50), true), offered)).toBeNull();
    expect(receiptFormError(toggleAllInvoices(form(offered), offered, true), offered)).toBe('One payment can cover at most 50 invoices.');
  });
});

describe('receiptPayload', () => {
  const receivable = receivableInvoices([invoice(1, { balance: 250.5 }), invoice(2)], []);

  it('sends numbers, one allocation per ticked invoice, and nothing about scheduling', () => {
    const all = { ...toggleAllInvoices(form(receivable), receivable, true), reference: ' TT 88 ', notes: '' };
    const payload = receiptPayload(all);
    expect(payload).toEqual({
      account_id: BANK,
      txn_date: today,
      method: 'bank_transfer',
      reference: ' TT 88 ',
      notes: '',
      allocations: [
        { invoice_id: invoiceId(1), amount: 250.5 },
        { invoice_id: invoiceId(2), amount: 100 },
      ],
    });
    expect('scheduled' in payload).toBe(false);
    expect(recordPaymentInInput.parse(payload)).toMatchObject({ reference: 'TT 88', notes: null });
  });
  it('never carries the customer or a workspace: the database works the customer out from the invoices', () => {
    expect(Object.keys(receiptPayload(form(receivable))).sort()).toEqual(['account_id', 'allocations', 'method', 'notes', 'reference', 'txn_date']);
  });
});

describe('the payment-in form, as the shared card draws it', () => {
  const receivable = receivableInvoices(
    [invoice(1, { balance: 250.5 }), invoice(2, { balance: 500 })],
    [received(2, { status: 'draft', amount: 200 })],
  );

  it('is the payment-in form’s own rules, and cannot be scheduled', () => {
    expect(PAYMENT_IN_KIND.chooseParty).toBe(chooseCustomer);
    expect(PAYMENT_IN_KIND.parties).toBe(receiptCustomers);
    expect(PAYMENT_IN_KIND.documentsOf).toBe(invoicesOf);
    expect(PAYMENT_IN_KIND.toggle).toBe(toggleInvoice);
    expect(PAYMENT_IN_KIND.toggleAll).toBe(toggleAllInvoices);
    expect(PAYMENT_IN_KIND.keep).toBe(keepReceivable);
    expect(PAYMENT_IN_KIND.total).toBe(receiptTotal);
    expect(PAYMENT_IN_KIND.error).toBe(receiptFormError);
    expect(PAYMENT_IN_KIND.payload).toBe(receiptPayload);
    expect(PAYMENT_IN_KIND.schedule).toBeUndefined();
  });
  it('opens from an invoice’s row with that customer chosen and that invoice ticked', () => {
    const opened = PAYMENT_IN_KIND.newForm(receivable, accounts, today, { partyId: AISYAH, documentId: invoiceId(1) });
    expect(opened).toMatchObject({ customerId: AISYAH, amounts: { [invoiceId(1)]: '250.50' } });
    expect(PAYMENT_IN_KIND.partyId(opened)).toBe(AISYAH);
  });
  it('words an invoice: its number, what is owed, and what an unposted payment holds', () => {
    expect(PAYMENT_IN_KIND.number(receivable[0])).toBe('INV-0001');
    expect(PAYMENT_IN_KIND.owed(receivable[0])).toBe('RM 250.50 owed');
    expect(PAYMENT_IN_KIND.owed(receivable[1])).toBe('RM 300.00 owed · RM 200.00 of RM 500.00 held by a payment not yet posted');
    expect(PAYMENT_IN_KIND.amountLabel(receivable[0])).toBe('Amount received for INV-0001');
    expect(PAYMENT_IN_KIND.words).toMatchObject({ party: 'customer', document: 'invoice', documents: 'Invoices paid', account: 'Paid into', date: 'Date received', submit: 'Record payment' });
  });
});
```

- [ ] **Step 3: Write the failing tests for the menus, the filter and split payments**

Create `tests/finance-sales-rules.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { InvoiceDisplayStatus, InvoiceListRow } from '@/lib/finance/invoices';
import type { PaymentInRow } from '@/lib/finance/money';
import { alsoCovers } from '@/lib/finance/purchase-views';
import {
  alsoCoversInvoices,
  customerChoice,
  invoiceActions,
  invoiceCustomers,
  paymentInActions,
  siblingInvoices,
} from '@/lib/finance/sales-views';
import { alsoCoversSentence } from '@/lib/finance/view-helpers';

const invoice = (display_status: InvoiceDisplayStatus, i: Partial<InvoiceListRow> = {}): InvoiceListRow => ({
  id: `invoice-${display_status}`,
  invoice_no: display_status === 'draft' ? null : 'INV-0001',
  customer_id: 'aisyah',
  customer_name: 'Aisyah Trading',
  invoice_date: '2026-10-01',
  due_date: '2026-10-31',
  total: 100,
  paid: 0,
  balance: 100,
  display_status,
  einvoice_status: 'none',
  einvoice_uuid: null,
  ...i,
});

const row = (allocation: string, p: Partial<PaymentInRow> = {}): PaymentInRow => ({
  allocation_id: allocation,
  transaction_id: 'txn-1',
  number: 'RC-0001',
  txn_date: '2026-10-05',
  method: 'fpx',
  amount: 100,
  transaction_amount: 300,
  status: 'posted',
  reference: null,
  account_id: 'bank',
  account_name: 'Main Bank',
  invoice_id: `invoice-${allocation}`,
  invoice_no: 'INV-0007',
  customer_name: 'Aisyah Trading',
  ...p,
});

describe('invoiceActions', () => {
  it('lets a draft be edited, posted or deleted, and never voided or paid', () => {
    expect(invoiceActions(invoice('draft'), false)).toEqual(['edit', 'post', 'delete']);
    expect(invoiceActions(invoice('draft'), true)).toEqual(['edit', 'post', 'delete']);
  });
  it('lets a posted invoice take a payment while it can, have its e-Invois set, and be voided', () => {
    expect(invoiceActions(invoice('sent'), true)).toEqual(['pay', 'einvoice', 'void']);
    expect(invoiceActions(invoice('overdue'), true)).toEqual(['pay', 'einvoice', 'void']);
    // Nothing left that a new payment could take.
    expect(invoiceActions(invoice('sent'), false)).toEqual(['einvoice', 'void']);
    expect(invoiceActions(invoice('paid', { paid: 100, balance: 0 }), false)).toEqual(['einvoice', 'void']);
  });
  it('offers nothing on a void invoice', () => {
    expect(invoiceActions(invoice('void'), false)).toEqual([]);
    expect(invoiceActions(invoice('void'), true)).toEqual([]);
  });
  it('never offers what the database refuses for the status: no editing or deleting once posted, no voiding a draft', () => {
    for (const status of ['sent', 'overdue', 'paid', 'void'] as const) {
      const offered = invoiceActions(invoice(status), true);
      expect(offered, status).not.toContain('edit');
      expect(offered, status).not.toContain('post');
      expect(offered, status).not.toContain('delete');
    }
    expect(invoiceActions(invoice('draft'), true)).not.toContain('void');
    expect(invoiceActions(invoice('draft'), true)).not.toContain('einvoice');
  });
});

describe('customerChoice', () => {
  const customers = invoiceCustomers([invoice('sent'), invoice('sent', { customer_id: 'zaki', customer_name: 'Zaki Enterprise' })]);

  it('keeps a customer who still has an invoice, and "all"', () => {
    expect(customerChoice('zaki', customers)).toBe('zaki');
    expect(customerChoice('all', customers)).toBe('all');
    expect(customerChoice('all', [])).toBe('all');
  });
  it('goes back to everyone when the chosen customer’s last invoice is gone', () => {
    expect(customerChoice('nurul', customers)).toBe('all');
    expect(customerChoice('zaki', [])).toBe('all');
  });
});

describe('paymentInActions', () => {
  it('lets a received payment be voided, and offers nothing else on any row', () => {
    expect(paymentInActions(row('a'))).toEqual(['void']);
    for (const status of ['void', 'draft', 'pending_approval', 'scheduled', 'rejected'] as const) {
      expect(paymentInActions(row('a', { status })), status).toEqual([]);
    }
  });
});

describe('a payment split across invoices', () => {
  const rows = [
    row('a', { invoice_no: 'INV-0007' }),
    row('b', { invoice_no: 'INV-0009' }),
    row('c', { invoice_no: 'INV-0008' }),
    row('d', { transaction_id: 'txn-2', invoice_no: 'INV-0001' }),
  ];

  it('names the other invoices, whichever row the menu was opened from', () => {
    expect(siblingInvoices(rows, rows[0])).toEqual(['INV-0008', 'INV-0009']);
    expect(siblingInvoices(rows, rows[1])).toEqual(['INV-0007', 'INV-0008']);
    expect(alsoCoversInvoices(rows, rows[1])).toBe('This payment also covers INV-0007 and INV-0008.');
    expect(alsoCoversInvoices(rows.slice(0, 2), rows[0])).toBe('This payment also covers INV-0009.');
  });
  it('says nothing for a payment against one invoice', () => {
    expect(siblingInvoices(rows, rows[3])).toEqual([]);
    expect(alsoCoversInvoices(rows, rows[3])).toBe('');
  });
  it('is the sentence a payment out uses', () => {
    expect(alsoCoversSentence([])).toBe('');
    expect(alsoCoversSentence(['A'])).toBe('This payment also covers A.');
    expect(alsoCoversSentence(['A', 'B', 'C'])).toBe('This payment also covers A, B and C.');
    expect(alsoCovers([], { transaction_id: 't', allocation_id: 'x' } as never)).toBe('');
  });
});
```

- [ ] **Step 4: Run to see them fail**

Run: `pnpm exec vitest run tests/finance-invoice-form.test.ts tests/finance-receipt-form.test.ts tests/finance-sales-rules.test.ts`
Expected: FAIL. The first two files do not load (`Cannot find package '@/lib/finance/invoice-form'`, and the same for `receipt-form`). `finance-sales-rules` loads and its tests fail with `invoiceActions is not a function`, `customerChoice is not a function` and the like.

- [ ] **Step 5: Write `src/lib/finance/invoice-form.ts`**

Create `src/lib/finance/invoice-form.ts`:

```ts
/**
 * The invoice form's rules, kept out of the components so they can be
 * tested: what a new form holds, what choosing a customer, a date or a
 * product changes, what is wrong with the form, and what is sent to
 * saveInvoiceAction. Also the small e-Invois form. Pure. What a bill form
 * shares is in document-form.ts.
 */
import { billTotals } from './bill-math';
import {
  type DocumentFormKind,
  type LineDraft,
  emptyLine,
  filledFromProduct,
  followedDueDate,
  lineDraft,
  lineNumbers,
  linePayload,
  savedAsDraft,
} from './document-form';
import {
  type EInvoiceStatus,
  INVOICE_MESSAGES,
  type InvoiceDetail,
  type InvoiceListRow,
  saveInvoiceInput,
  setEInvoiceInput,
} from './invoices';
import type { FinanceProduct } from './products';

export type InvoiceForm = {
  /** Present when a saved draft is being changed. */
  id?: string;
  customer_id: string;
  invoice_date: string;
  due_date: string;
  /** Once the person sets the due date by hand, it is no longer recalculated. */
  dueEdited: boolean;
  notes: string;
  lines: LineDraft[];
};

/** A new invoice dated today with one empty line. The due date follows once a customer is chosen. */
export function newInvoiceForm(today: string, lineKey: string): InvoiceForm {
  return {
    customer_id: '',
    invoice_date: today,
    due_date: today,
    dueEdited: false,
    notes: '',
    lines: [emptyLine(lineKey)],
  };
}

/** A saved draft, as the form shows it. Its due date was chosen already, so it is kept. */
export function invoiceFormFromDetail(invoice: InvoiceDetail): InvoiceForm {
  return {
    id: invoice.id,
    customer_id: invoice.customer_id,
    invoice_date: invoice.invoice_date,
    due_date: invoice.due_date,
    dueEdited: true,
    notes: invoice.notes ?? '',
    lines: invoice.lines.map(lineDraft),
  };
}

/** Choosing a customer moves the due date to their payment terms, unless it was set by hand. */
export function withCustomer(form: InvoiceForm, customer: { id: string; payment_terms_days: number }): InvoiceForm {
  return {
    ...form,
    customer_id: customer.id,
    due_date: followedDueDate(form, form.invoice_date, customer.payment_terms_days),
  };
}

/**
 * Changing the invoice date moves the due date with it, unless it was set by
 * hand. While the invoice date is half typed the due date stays where it was.
 */
export function withInvoiceDate(form: InvoiceForm, invoiceDate: string, termsDays: number | undefined): InvoiceForm {
  return { ...form, invoice_date: invoiceDate, due_date: followedDueDate(form, invoiceDate, termsDays) };
}

/**
 * Choosing a product fills the line from it: its name, unit, price (what the
 * workspace sells it for) and SST rate. The person can then change any of
 * them. Choosing "no product" only clears the link.
 */
export function withSoldProduct(line: LineDraft, product: FinanceProduct | null): LineDraft {
  return filledFromProduct(line, product, product?.price ?? 0);
}

/** What is sent to saveInvoiceAction. Figures are numbers; a box that is not a number goes as NaN and is refused. */
export function invoicePayload(form: InvoiceForm) {
  return {
    ...(form.id ? { id: form.id } : {}),
    customer_id: form.customer_id,
    invoice_date: form.invoice_date,
    due_date: form.due_date,
    notes: form.notes,
    lines: form.lines.map(linePayload),
  };
}

/**
 * The first thing wrong with the form, in the schema's own sentence, or null
 * when it can be sent. A draft may total nothing; an invoice being posted may
 * not, and saying so here saves a draft the database would then refuse to
 * post.
 */
export function invoiceFormError(form: InvoiceForm, posting = false): string | null {
  const parsed = saveInvoiceInput.safeParse(invoicePayload(form));
  if (!parsed.success) return parsed.error.issues[0]?.message ?? INVOICE_MESSAGES.lines;
  if (posting && billTotals(form.lines.map(lineNumbers)).total <= 0) return INVOICE_MESSAGES.empty;
  return null;
}

/** What the form says when the invoice was saved as a draft but posting it was refused. */
export function invoiceSavedNotPosted(error: string): string {
  return savedAsDraft('invoice', error);
}

/** The invoice form, as the shared card draws it. An invoice has no second reference box. */
export const INVOICE_FORM_KIND: DocumentFormKind<InvoiceForm> = {
  noun: 'invoice',
  party: 'customer',
  dateLabel: 'Invoice date',
  partyId: (form) => form.customer_id,
  date: (form) => form.invoice_date,
  withParty: withCustomer,
  withDate: withInvoiceDate,
  withProduct: withSoldProduct,
  error: invoiceFormError,
  payload: invoicePayload,
  savedNotPosted: invoiceSavedNotPosted,
};

/* ---- e-Invois ----------------------------------------------------------- */

/** What a person has recorded about one posted invoice's e-Invois, as its small form holds it. */
export type EInvoiceForm = { status: EInvoiceStatus; uuid: string };

/** The form opens on what the invoice has now. */
export function eInvoiceForm(invoice: Pick<InvoiceListRow, 'einvoice_status' | 'einvoice_uuid'>): EInvoiceForm {
  return { status: invoice.einvoice_status, uuid: invoice.einvoice_uuid ?? '' };
}

/** Choosing "None" empties the UUID box: an invoice with no e-Invois has no UUID, and the box is then closed. */
export function withEInvoiceStatus(form: EInvoiceForm, status: EInvoiceStatus): EInvoiceForm {
  return status === 'none' ? { status, uuid: '' } : { ...form, status };
}

/** What is sent to setEInvoiceAction. */
export function eInvoicePayload(invoiceId: string, form: EInvoiceForm) {
  return { id: invoiceId, einvoice_status: form.status, einvoice_uuid: form.uuid };
}

/** The first thing wrong with the form, in the schema's own sentence, or null when it can be sent. */
export function eInvoiceFormError(invoiceId: string, form: EInvoiceForm): string | null {
  const parsed = setEInvoiceInput.safeParse(eInvoicePayload(invoiceId, form));
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? INVOICE_MESSAGES.einvoiceStatus);
}
```

- [ ] **Step 6: Write `src/lib/finance/receipt-form.ts`**

Create `src/lib/finance/receipt-form.ts`:

```ts
/**
 * The payment-in form's rules, kept out of the component so they can be
 * tested: which invoices can still take a payment, what each defaults to,
 * what is wrong with the form, and what is sent to recordPaymentInAction.
 * Pure. Money in is recorded once it has arrived, so there is no scheduling.
 * What a payment out shares is in allocation-form.ts.
 */
import {
  type AllocationFormKind,
  amountText,
  amountsError,
  amountsTotal,
  defaultAccount,
  heldBy,
  keptOffered,
  partiesOf,
  round2,
  ticked,
  tickedAll,
  typedAmounts,
} from './allocation-form';
import { rm } from './format';
import { INVOICE_MESSAGES, type InvoiceListRow } from './invoices';
import {
  type FinanceAccount,
  type PaymentInRow,
  type PaymentMethod,
  RECEIPT_MESSAGES,
  recordPaymentInInput,
} from './money';

export type ReceivableInvoice = {
  id: string;
  invoice_no: string;
  customer_id: string;
  customer_name: string;
  due_date: string;
  overdue: boolean;
  /** Still owed after every payment received. */
  balance: number;
  /** Held by payments that are not yet posted. The app never makes one; the database counts them all the same. */
  held: number;
  /** What a new payment may take: the balance less what is held. */
  payable: number;
};

export type ReceiptForm = {
  customerId: string;
  /** The ticked invoices, each with the amount as typed. */
  amounts: Record<string, string>;
  accountId: string;
  date: string;
  method: PaymentMethod;
  reference: string;
  notes: string;
};

/** What payments in that are not yet posted hold of each invoice, to the sen, by invoice id. */
export function heldByInvoice(payments: PaymentInRow[]): Record<string, number> {
  return heldBy(payments, (p) => p.invoice_id);
}

/**
 * The invoices a payment can be recorded against: posted ("Sent" or
 * "Overdue"), not paid in full, and not already covered by a payment that is
 * not yet posted. The database refuses a payment for more than is still owed,
 * so that is what the form offers.
 */
export function receivableInvoices(invoices: InvoiceListRow[], payments: PaymentInRow[]): ReceivableInvoice[] {
  const heldNow = heldByInvoice(payments);
  return invoices
    .filter((i) => (i.display_status === 'sent' || i.display_status === 'overdue') && i.balance > 0)
    .map((i) => {
      const held = heldNow[i.id] ?? 0;
      return {
        id: i.id,
        invoice_no: i.invoice_no ?? '—',
        customer_id: i.customer_id,
        customer_name: i.customer_name,
        due_date: i.due_date,
        overdue: i.display_status === 'overdue',
        balance: i.balance,
        held,
        payable: round2(i.balance - held),
      };
    })
    .filter((i) => i.payable > 0)
    .sort(
      (x, y) =>
        x.customer_name.localeCompare(y.customer_name) ||
        x.due_date.localeCompare(y.due_date) ||
        x.invoice_no.localeCompare(y.invoice_no),
    );
}

/** The customers that have at least one invoice to pay, by name, with how many. */
export function receiptCustomers(receivable: ReceivableInvoice[]): { id: string; name: string; open: number }[] {
  return partiesOf(
    receivable,
    (i) => i.customer_id,
    (i) => i.customer_name,
  );
}

/** One customer's receivable invoices, the earliest due first. */
export function invoicesOf(receivable: ReceivableInvoice[], customerId: string): ReceivableInvoice[] {
  return receivable.filter((i) => i.customer_id === customerId);
}

/**
 * A fresh form. The account defaults to the first bank account. With
 * `preselect` (the Record payment choice on an invoice row) the customer is
 * chosen and that invoice ticked for all it can still take.
 */
export function newReceiptForm(
  receivable: ReceivableInvoice[],
  accounts: FinanceAccount[],
  today: string,
  preselect?: { customerId: string; invoiceId: string },
): ReceiptForm {
  const customers = receiptCustomers(receivable);
  const invoice = preselect
    ? receivable.find((i) => i.id === preselect.invoiceId && i.customer_id === preselect.customerId)
    : undefined;
  return {
    customerId: preselect?.customerId ?? (customers.length === 1 ? customers[0].id : ''),
    amounts: invoice ? { [invoice.id]: amountText(invoice.payable) } : {},
    accountId: defaultAccount(accounts),
    date: today,
    method: 'bank_transfer',
    reference: '',
    notes: '',
  };
}

/** Choosing another customer starts the ticks again: one payment is from one customer. */
export function chooseCustomer(form: ReceiptForm, customerId: string): ReceiptForm {
  return customerId === form.customerId ? form : { ...form, customerId, amounts: {} };
}

/** Ticks an invoice for all it can still take, or unticks it. */
export function toggleInvoice(form: ReceiptForm, invoice: ReceivableInvoice, on: boolean): ReceiptForm {
  return ticked(form, invoice, on);
}

/** Ticks every invoice of the chosen customer, or clears them all. */
export function toggleAllInvoices(form: ReceiptForm, invoices: ReceivableInvoice[], on: boolean): ReceiptForm {
  return tickedAll(form, invoices, on);
}

/**
 * After a refresh, a ticked invoice that was paid off or voided meanwhile is
 * no longer in `invoices`. Its amount goes, so the total, the count and the
 * save stay true to what the person can see. The same form when nothing goes.
 */
export function keepReceivable(form: ReceiptForm, invoices: ReceivableInvoice[]): ReceiptForm {
  return keptOffered(form, invoices);
}

/** The running total: every ticked amount that is a number above 0. */
export function receiptTotal(form: ReceiptForm): number {
  return amountsTotal(form.amounts);
}

/** What is sent to recordPaymentInAction. Amounts are numbers; a box that is not a number goes as NaN and is refused. */
export function receiptPayload(form: ReceiptForm) {
  return {
    account_id: form.accountId,
    txn_date: form.date,
    method: form.method,
    reference: form.reference,
    notes: form.notes,
    allocations: typedAmounts(form.amounts).map(({ id, amount }) => ({ invoice_id: id, amount })),
  };
}

/**
 * The first thing wrong with the form, in the sentence the schema or the
 * database would use, or null when it can be sent.
 */
export function receiptFormError(form: ReceiptForm, receivable: ReceivableInvoice[]): string | null {
  if (!form.customerId) return INVOICE_MESSAGES.customer;
  if (Object.keys(form.amounts).length === 0) return RECEIPT_MESSAGES.invoices;
  // An invoice that is no longer receivable was paid or voided since the form opened.
  const problem = amountsError(form.amounts, invoicesOf(receivable, form.customerId), RECEIPT_MESSAGES);
  if (problem) return problem;
  const parsed = recordPaymentInInput.safeParse(receiptPayload(form));
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? RECEIPT_MESSAGES.amount);
}

/** The payment-in form, as the shared card draws it. It has no `schedule`: money in is never scheduled. */
export const PAYMENT_IN_KIND: AllocationFormKind<ReceiptForm, ReceivableInvoice> = {
  words: {
    subtitle: 'Money received from a customer, against their invoices',
    party: 'customer',
    document: 'invoice',
    documents: 'Invoices paid',
    nothing:
      'There is no invoice to take a payment for. An invoice can be paid once it is posted, and until payments cover it in full.',
    account: 'Paid into',
    date: 'Date received',
    submit: 'Record payment',
  },
  newForm: (receivable, accounts, today, preselect) =>
    newReceiptForm(
      receivable,
      accounts,
      today,
      preselect ? { customerId: preselect.partyId, invoiceId: preselect.documentId } : undefined,
    ),
  partyId: (form) => form.customerId,
  chooseParty: chooseCustomer,
  parties: receiptCustomers,
  documentsOf: invoicesOf,
  number: (invoice) => invoice.invoice_no,
  owed: (invoice) =>
    `${rm(invoice.payable)} owed${invoice.held > 0 ? ` · ${rm(invoice.held)} of ${rm(invoice.balance)} held by a payment not yet posted` : ''}`,
  amountLabel: (invoice) => `Amount received for ${invoice.invoice_no}`,
  toggle: toggleInvoice,
  toggleAll: toggleAllInvoices,
  keep: keepReceivable,
  total: receiptTotal,
  error: receiptFormError,
  payload: receiptPayload,
};
```

- [ ] **Step 7: Share the "also covers" sentence, and add the menu rules and the filter's fallback**

Six edits: one in `view-helpers.ts`, two in `purchase-views.ts`, three in `sales-views.ts`.

In `src/lib/finance/view-helpers.ts`, replace:

```ts
/** How many payments the rows belong to: a payment split across documents is one payment. */
```

with:

```ts
/**
 * "This payment also covers BILL-0007 and BILL-0008." for a payment split
 * across documents, given the numbers of the other ones; empty when there are
 * none. Voiding from any row of a split payment acts on the whole payment, so
 * the question names the others.
 */
export function alsoCoversSentence(others: string[]): string {
  if (others.length === 0) return '';
  const list = others.length === 1 ? others[0] : `${others.slice(0, -1).join(', ')} and ${others[others.length - 1]}`;
  return `This payment also covers ${list}.`;
}

/** How many payments the rows belong to: a payment split across documents is one payment. */
```

In `src/lib/finance/purchase-views.ts`, replace:

```ts
  type Stat,
  addDays,
  count,
```

with:

```ts
  type Stat,
  addDays,
  alsoCoversSentence,
  count,
```

In `src/lib/finance/purchase-views.ts`, replace:

```ts
export function alsoCovers(rows: PaymentOutRow[], row: PaymentOutRow): string {
  const others = siblingBills(rows, row);
  if (others.length === 0) return '';
  const list = others.length === 1 ? others[0] : `${others.slice(0, -1).join(', ')} and ${others[others.length - 1]}`;
  return `This payment also covers ${list}.`;
}
```

with:

```ts
export function alsoCovers(rows: PaymentOutRow[], row: PaymentOutRow): string {
  return alsoCoversSentence(siblingBills(rows, row));
}
```

In `src/lib/finance/sales-views.ts`, replace:

```ts
  type Stat,
  addDays,
  count,
```

with:

```ts
  type Stat,
  addDays,
  alsoCoversSentence,
  count,
```

In `src/lib/finance/sales-views.ts`, replace:

```ts
/** The invoices table as a CSV file. Amounts are numbers, so a spreadsheet can add them up. */
```

with:

```ts
/**
 * The customer the filter is on. A refresh can remove the chosen customer
 * (their last invoice was deleted): the answer is then `all`, and the view
 * stores that, so the old choice does not come back by itself when that
 * customer has an invoice again.
 */
export function customerChoice(chosen: string, customers: { id: string }[]): string {
  return chosen === 'all' || customers.some((c) => c.id === chosen) ? chosen : 'all';
}

export type InvoiceAction = 'edit' | 'post' | 'delete' | 'pay' | 'einvoice' | 'void';

/**
 * What an invoice's row menu offers, in order: only what the database allows
 * for its status. A draft is edited, posted or deleted, never voided. A
 * posted invoice ("Sent", "Overdue", "Paid") has its e-Invois details set and
 * can be voided, and takes a payment while `canTakePayment`. Voiding one that
 * has payments is offered and refused with the reason, as on a paid bill. A
 * void invoice offers nothing.
 */
export function invoiceActions(invoice: InvoiceListRow, canTakePayment: boolean): InvoiceAction[] {
  if (invoice.display_status === 'draft') return ['edit', 'post', 'delete'];
  if (invoice.display_status === 'void') return [];
  const pay: InvoiceAction[] = canTakePayment ? ['pay'] : [];
  return [...pay, 'einvoice', 'void'];
}

/** The invoices table as a CSV file. Amounts are numbers, so a spreadsheet can add them up. */
```

In `src/lib/finance/sales-views.ts`, replace:

```ts
/** The payments table as a CSV file: one line per invoice a payment pays. Amounts are numbers. */
```

with:

```ts
/** What a payment-in row's menu offers: a received payment can be voided, and that is all. There is no edit and no delete. */
export function paymentInActions(row: PaymentInRow): 'void'[] {
  return row.status === 'posted' ? ['void'] : [];
}

/** The other invoices the same payment pays, by number. A payment split across invoices shows one row per invoice. */
export function siblingInvoices(rows: PaymentInRow[], row: PaymentInRow): string[] {
  return rows
    .filter((other) => other.transaction_id === row.transaction_id && other.allocation_id !== row.allocation_id)
    .map((other) => other.invoice_no ?? 'a draft invoice')
    .sort();
}

/** "This payment also covers INV-0007 and INV-0008." for a split payment; empty for a payment against one invoice. */
export function alsoCoversInvoices(rows: PaymentInRow[], row: PaymentInRow): string {
  return alsoCoversSentence(siblingInvoices(rows, row));
}

/** The payments table as a CSV file: one line per invoice a payment pays. Amounts are numbers. */
```

- [ ] **Step 8: Run the tests**

Run: `pnpm exec vitest run tests/finance-invoice-form.test.ts tests/finance-receipt-form.test.ts tests/finance-sales-rules.test.ts tests/finance-purchase-views.test.ts tests/finance-sales-views.test.ts tests/finance-shared.test.ts`
Expected: PASS, all six files: 23 tests in `finance-invoice-form`, 25 in `finance-receipt-form`, 10 in `finance-sales-rules`. `finance-purchase-views` was not edited: `alsoCovers` words a split payment out as it did.

- [ ] **Step 9: Type-check, lint and commit**

Run, as separate commands: `pnpm exec tsc --noEmit`, `pnpm lint`, `pnpm exec vitest run --exclude 'tests/*.rls.test.ts' --exclude 'tests/bendahara-*.test.ts'`
Expected: no errors; every unit test passes.

Run: `grep -l -E "supabase/server|next/headers" src/lib/finance/*.ts`
Expected: no output.

```bash
git add src/lib/finance/invoice-form.ts src/lib/finance/receipt-form.ts src/lib/finance/sales-views.ts src/lib/finance/view-helpers.ts src/lib/finance/purchase-views.ts tests/finance-invoice-form.test.ts tests/finance-receipt-form.test.ts tests/finance-sales-rules.test.ts
git commit -m "feat: rules of the invoice form, the payment-in form and the sales row menus"
```

---

### Task 4: Server actions for invoices and payments in

**Files:**
- Modify: `src/app/(app)/finance/actions.ts`
- Create: `tests/finance-sales-actions.test.ts`

**Interfaces:**
- Consumes: `saveInvoice`, `postInvoice`, `voidInvoice`, `deleteInvoice`, `getInvoice`, `setEInvoice`, `saveInvoiceInput`, `invoiceIdInput`, `setEInvoiceInput`, `INVOICE_MESSAGES`, `InvoiceDetail`, `SaveAndPostInvoiceResult` from `@/lib/finance/invoices`; `recordPaymentIn`, `recordPaymentInInput`, `voidPaymentIn`, `paymentIdInput` from `@/lib/finance/money`; the existing `writeCtx`, `run`, `refresh`, `firstMessage`, `FORBIDDEN` in the actions file.
- Produces, all in `@/app/(app)/finance/actions`, each taking `input: unknown`:
  - `saveInvoiceAction` → `Promise<FinResult<{ id: string }>>`
  - `postInvoiceAction` → `Promise<FinResult<{ id: string; invoice_no: string }>>`
  - `voidInvoiceAction`, `deleteInvoiceAction`, `setEInvoiceAction` → `Promise<FinResult<{ id: string }>>`
  - `saveAndPostInvoiceAction` → `Promise<SaveAndPostInvoiceResult>`
  - `getInvoiceAction` → `Promise<FinResult<InvoiceDetail>>`
  - `recordPaymentInAction`, `voidPaymentInAction` → `Promise<FinResult<{ id: string }>>`

How they behave:

- Every one goes through `writeCtx`: a viewer and the demo workspace are answered "You do not have permission to make changes here." before anything is parsed, read or written. This is what stops a viewer's void coming back as "That invoice no longer exists." (the database refuses a viewer's update as zero rows).
- Every write refreshes `SALES_PATHS` (`/finance/invoices`, `/finance/payments-in`, `/finance/customers-suppliers`) after any attempt that reached the database, refused or not.
- `voidPaymentInAction` calls `voidPaymentIn`. `voidPaymentAction` still calls `voidPayment` and refreshes the purchase paths.
- `saveAndPostBillAction` and `getBillAction` move onto two private helpers that the invoice actions share. Not exported: a `'use server'` file exports only async functions that are actions.

- [ ] **Step 1: Write the failing tests**

Create `tests/finance-sales-actions.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const INVOICE = '33333333-3333-4333-8333-333333333333';
const CUSTOMER = '44444444-4444-4444-8444-444444444444';
const TXN = '55555555-5555-4555-8555-555555555555';
const ACCOUNT = '66666666-6666-4666-8666-666666666666';

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
  /** What getInvoice returns, or an Error for it to throw. */
  invoice: null as unknown,
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

vi.mock('@/lib/finance/invoices', async (orig) => {
  const actual = await orig<typeof import('@/lib/finance/invoices')>();
  return {
    ...actual,
    saveInvoice: recorder('saveInvoice', { id: '33333333-3333-4333-8333-333333333333' }),
    postInvoice: recorder('postInvoice', { id: '33333333-3333-4333-8333-333333333333', invoice_no: 'INV-0007' }),
    voidInvoice: recorder('voidInvoice', { id: '33333333-3333-4333-8333-333333333333' }),
    deleteInvoice: recorder('deleteInvoice', { id: '33333333-3333-4333-8333-333333333333' }),
    setEInvoice: recorder('setEInvoice', { id: '33333333-3333-4333-8333-333333333333' }),
    getInvoice: async (ctx: { orgId: string }, id: string) => {
      ctl.calls.push({ fn: 'getInvoice', orgId: ctx.orgId, input: id });
      if (ctl.invoice instanceof Error) throw ctl.invoice;
      return ctl.invoice;
    },
  };
});

vi.mock('@/lib/finance/money', async (orig) => {
  const actual = await orig<typeof import('@/lib/finance/money')>();
  return {
    ...actual,
    recordPaymentIn: recorder('recordPaymentIn', { id: '55555555-5555-4555-8555-555555555555' }),
    voidPaymentIn: recorder('voidPaymentIn', { id: '55555555-5555-4555-8555-555555555555' }),
    voidPayment: recorder('voidPayment', { id: '55555555-5555-4555-8555-555555555555' }),
  };
});

const actions = await import('@/app/(app)/finance/actions');

const PATHS = ['/finance/invoices', '/finance/payments-in', '/finance/customers-suppliers'];
const FORBIDDEN = { ok: false, error: 'You do not have permission to make changes here.' };

const invoice = {
  customer_id: CUSTOMER,
  invoice_date: '2026-10-01',
  due_date: '2026-10-31',
  lines: [{ description: 'Design work', quantity: 10, unit_price: 12.5 }],
};
const payment = {
  account_id: ACCOUNT,
  txn_date: '2026-10-05',
  method: 'fpx',
  allocations: [{ invoice_id: INVOICE, amount: 100 }],
};
const einvoice = { id: INVOICE, einvoice_status: 'validated', einvoice_uuid: 'F9D425P6DS7D8IU' };

/** Every write action with an input its schema accepts, and the data-layer function it must call. */
const writes: [string, (input: unknown) => Promise<Answer>, unknown, string][] = [
  ['saveInvoiceAction', actions.saveInvoiceAction, invoice, 'saveInvoice'],
  ['postInvoiceAction', actions.postInvoiceAction, { id: INVOICE }, 'postInvoice'],
  ['voidInvoiceAction', actions.voidInvoiceAction, { id: INVOICE }, 'voidInvoice'],
  ['deleteInvoiceAction', actions.deleteInvoiceAction, { id: INVOICE }, 'deleteInvoice'],
  ['setEInvoiceAction', actions.setEInvoiceAction, einvoice, 'setEInvoice'],
  ['recordPaymentInAction', actions.recordPaymentInAction, payment, 'recordPaymentIn'],
  ['voidPaymentInAction', actions.voidPaymentInAction, { id: TXN }, 'voidPaymentIn'],
];

beforeEach(() => {
  ctl.viewer = { userId: 'u1', orgId: 'org1', role: 'member', isDemo: false };
  ctl.calls = [];
  ctl.revalidated = [];
  ctl.answers = {};
  ctl.invoice = null;
});

describe('who may write', () => {
  it('refuses a viewer and the demo workspace on every action, before anything is read or written', async () => {
    for (const viewer of [
      { userId: 'u1', orgId: 'org1', role: 'viewer', isDemo: false },
      { userId: 'u1', orgId: 'org1', role: 'owner', isDemo: true },
    ]) {
      ctl.viewer = viewer;
      for (const [name, action, input] of writes) expect(await action(input), name).toEqual(FORBIDDEN);
      expect(await actions.saveAndPostInvoiceAction(invoice)).toEqual(FORBIDDEN);
      expect(await actions.getInvoiceAction({ id: INVOICE })).toEqual(FORBIDDEN);
    }
    expect(ctl.calls).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
  });

  it('tells a viewer they may not, not that the invoice is gone', async () => {
    ctl.viewer = { userId: 'u1', orgId: 'org1', role: 'viewer', isDemo: false };
    // The database would refuse a viewer's void as "no row", which reads as "no longer exists".
    ctl.answers.voidInvoice = { ok: false, error: 'That invoice no longer exists.' };
    ctl.answers.deleteInvoice = { ok: false, error: 'That invoice no longer exists.' };
    expect(await actions.voidInvoiceAction({ id: INVOICE })).toEqual(FORBIDDEN);
    expect(await actions.deleteInvoiceAction({ id: INVOICE })).toEqual(FORBIDDEN);
    expect(await actions.voidPaymentInAction({ id: TXN })).toEqual(FORBIDDEN);
    expect(ctl.calls).toEqual([]);
  });
});

describe('each write action', () => {
  it('calls its own data-layer function in the viewer’s workspace and refreshes the three sales screens', async () => {
    for (const [name, action, input, fn] of writes) {
      ctl.calls = [];
      ctl.revalidated = [];
      expect((await action(input)).ok, name).toBe(true);
      expect(ctl.calls.map((c) => [c.fn, c.orgId]), name).toEqual([[fn, 'org1']]);
      expect(ctl.revalidated, name).toEqual(PATHS);
    }
  });

  it('voids a payment in through the money-in function, never the money-out one', async () => {
    await actions.voidPaymentInAction({ id: TXN });
    expect(ctl.calls.map((c) => c.fn)).toEqual(['voidPaymentIn']);
    expect(ctl.revalidated).toContain('/finance/invoices');
    expect(ctl.revalidated).toContain('/finance/payments-in');
    expect(ctl.revalidated).not.toContain('/finance/supplier-bills');
  });

  it('leaves voiding a payment out refreshing the purchase screens', async () => {
    await actions.voidPaymentAction({ id: TXN });
    expect(ctl.calls.map((c) => c.fn)).toEqual(['voidPayment']);
    expect(ctl.revalidated).toEqual(['/finance/supplier-bills', '/finance/payments-out', '/finance/customers-suppliers']);
  });

  it('never takes the workspace from the input', async () => {
    await actions.saveInvoiceAction({ ...invoice, org_id: 'someone-else' });
    await actions.recordPaymentInAction({ ...payment, org_id: 'someone-else' });
    await actions.setEInvoiceAction({ ...einvoice, org_id: 'someone-else' });
    expect(ctl.calls.map((c) => c.orgId)).toEqual(['org1', 'org1', 'org1']);
    expect(JSON.stringify(ctl.calls)).not.toContain('someone-else');
  });

  it('answers with the schema’s sentence, touching nothing, when the input is refused', async () => {
    expect(await actions.saveInvoiceAction({ ...invoice, lines: [] })).toEqual({ ok: false, error: 'Add at least one line.' });
    expect(await actions.postInvoiceAction({ id: 'nope' })).toEqual({ ok: false, error: 'That invoice no longer exists.' });
    expect(await actions.recordPaymentInAction({ ...payment, allocations: [] })).toEqual({
      ok: false,
      error: 'Choose at least one invoice this payment is for.',
    });
    expect(
      await actions.recordPaymentInAction({
        ...payment,
        // The same invoice twice, its id once in capitals.
        allocations: [
          { invoice_id: 'abcdefab-cdef-4abc-8def-abcdefabcdef', amount: 1 },
          { invoice_id: 'ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF', amount: 1 },
        ],
      }),
    ).toEqual({ ok: false, error: 'Each invoice can appear once on a payment.' });
    expect(await actions.setEInvoiceAction({ id: INVOICE, einvoice_status: 'sent' })).toEqual({ ok: false, error: 'Choose an e-Invois status.' });
    expect(await actions.voidPaymentInAction(null)).toMatchObject({ ok: false });
    expect(ctl.calls).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
  });

  it('hands the data layer the parsed input: text trimmed, empties as null', async () => {
    await actions.setEInvoiceAction({ id: INVOICE, einvoice_status: 'pending', einvoice_uuid: '  ' });
    expect(ctl.calls[0].input).toEqual({ id: INVOICE, einvoice_status: 'pending', einvoice_uuid: null });
  });

  it('refreshes the screens after a refusal too, so a record someone else changed shows as it now is', async () => {
    // The invoice was posted in another tab while this one still had its draft open.
    ctl.answers.saveInvoice = { ok: false, error: 'This invoice has been posted or voided, so that can no longer be done.' };
    expect(await actions.saveInvoiceAction({ ...invoice, id: INVOICE })).toEqual(ctl.answers.saveInvoice);
    expect(ctl.revalidated).toEqual(PATHS);

    ctl.revalidated = [];
    ctl.answers.voidInvoice = { ok: false, error: 'This invoice has payments. Void them on Payments In before voiding it.' };
    expect(await actions.voidInvoiceAction({ id: INVOICE })).toEqual(ctl.answers.voidInvoice);
    expect(ctl.revalidated).toEqual(PATHS);
  });
});

describe('saveAndPostInvoiceAction', () => {
  it('saves, then posts what it saved, and answers with the number', async () => {
    expect(await actions.saveAndPostInvoiceAction(invoice)).toEqual({ ok: true, data: { id: INVOICE, invoice_no: 'INV-0007' } });
    expect(ctl.calls.map((c) => c.fn)).toEqual(['saveInvoice', 'postInvoice']);
    expect(ctl.calls[1].input).toEqual({ id: INVOICE });
    expect(ctl.revalidated).toEqual(PATHS);
  });

  it('does not post when the save is refused', async () => {
    ctl.answers.saveInvoice = { ok: false, error: 'The customer or a product on this invoice no longer exists.' };
    expect(await actions.saveAndPostInvoiceAction(invoice)).toEqual(ctl.answers.saveInvoice);
    expect(ctl.calls.map((c) => c.fn)).toEqual(['saveInvoice']);
    expect(ctl.revalidated).toEqual(PATHS);
  });

  it('keeps the draft when the post is refused, and says which draft it is', async () => {
    ctl.answers.postInvoice = { ok: false, error: 'An invoice needs at least one line with an amount.' };
    expect(await actions.saveAndPostInvoiceAction(invoice)).toEqual({
      ok: false,
      error: 'An invoice needs at least one line with an amount.',
      draftId: INVOICE,
    });
    expect(ctl.calls.map((c) => c.fn)).toEqual(['saveInvoice', 'postInvoice']);
    expect(ctl.revalidated).toEqual(PATHS);
  });

  it('answers with the schema’s sentence and saves nothing when the form is refused', async () => {
    expect(await actions.saveAndPostInvoiceAction({ ...invoice, customer_id: '' })).toEqual({ ok: false, error: 'Choose a customer.' });
    expect(ctl.calls).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
  });
});

describe('getInvoiceAction', () => {
  const draft = { id: INVOICE, display_status: 'draft', lines: [] };

  it('returns a draft with its lines, without refreshing anything', async () => {
    ctl.invoice = draft;
    expect(await actions.getInvoiceAction({ id: INVOICE })).toEqual({ ok: true, data: draft });
    expect(ctl.calls).toEqual([{ fn: 'getInvoice', orgId: 'org1', input: INVOICE }]);
    expect(ctl.revalidated).toEqual([]);
  });

  it('says the invoice is gone, and refreshes the list, when it was deleted meanwhile', async () => {
    expect(await actions.getInvoiceAction({ id: INVOICE })).toEqual({ ok: false, error: 'That invoice no longer exists.' });
    expect(ctl.revalidated).toEqual(PATHS);
  });

  it('says the invoice was posted, and refreshes the list, when it was posted meanwhile', async () => {
    ctl.invoice = { ...draft, display_status: 'sent' };
    expect(await actions.getInvoiceAction({ id: INVOICE })).toEqual({
      ok: false,
      error: 'This invoice has been posted or voided, so that can no longer be done.',
    });
    expect(ctl.revalidated).toEqual(PATHS);
  });

  it('says the invoice is gone for an id that is not an id, without reading', async () => {
    expect(await actions.getInvoiceAction({ id: 'nope' })).toEqual({ ok: false, error: 'That invoice no longer exists.' });
    expect(await actions.getInvoiceAction(undefined)).toEqual({ ok: false, error: 'That invoice no longer exists.' });
    expect(ctl.calls).toEqual([]);
  });

  it('answers with a sentence when the read fails, and logs the cause', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    ctl.invoice = new Error('connection reset');
    expect(await actions.getInvoiceAction({ id: INVOICE })).toEqual({ ok: false, error: 'That could not be loaded. Please try again.' });
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm exec vitest run tests/finance-sales-actions.test.ts`
Expected: FAIL, 17 of 18 tests, with `action is not a function` and `actions.saveInvoiceAction is not a function` (and the like). The one that passes already is "leaves voiding a payment out refreshing the purchase screens".

- [ ] **Step 3: Add the actions**

Five edits to `src/app/(app)/finance/actions.ts`, in the order they come in the file.

In `src/app/(app)/finance/actions.ts`, replace:

```ts
import {
  deleteScheduledPayment,
  markPaymentPaid,
  markPaymentPaidInput,
  paymentIdInput,
  recordPaymentOut,
  recordPaymentOutInput,
  voidPayment,
} from '@/lib/finance/money';
```

with:

```ts
import {
  INVOICE_MESSAGES,
  type InvoiceDetail,
  type SaveAndPostInvoiceResult,
  deleteInvoice,
  getInvoice,
  invoiceIdInput,
  postInvoice,
  saveInvoice,
  saveInvoiceInput,
  setEInvoice,
  setEInvoiceInput,
  voidInvoice,
} from '@/lib/finance/invoices';
import {
  deleteScheduledPayment,
  markPaymentPaid,
  markPaymentPaidInput,
  paymentIdInput,
  recordPaymentIn,
  recordPaymentInInput,
  recordPaymentOut,
  recordPaymentOutInput,
  voidPayment,
  voidPaymentIn,
} from '@/lib/finance/money';
```

In `src/app/(app)/finance/actions.ts`, replace:

```ts
// A bill or a payment changes what is owed, which Customers & Suppliers shows as Payable.
const PURCHASE_PATHS = ['/finance/supplier-bills', '/finance/payments-out', '/finance/customers-suppliers'];
```

with:

```ts
// A bill or a payment changes what is owed, which Customers & Suppliers shows as Payable.
const PURCHASE_PATHS = ['/finance/supplier-bills', '/finance/payments-out', '/finance/customers-suppliers'];
// An invoice or a payment in changes what customers owe, which Customers & Suppliers shows as Receivable.
const SALES_PATHS = ['/finance/invoices', '/finance/payments-in', '/finance/customers-suppliers'];

/**
 * Saves a document as a draft, then posts it. When the save works and the
 * post is refused, the draft stays: the answer carries the post's message and
 * the draft's id, so the form goes on editing that draft.
 */
async function saveThenPost<I, O>(
  paths: string[],
  schema: ZodType<I>,
  input: unknown,
  save: (ctx: FinanceWriteContext, parsed: I) => Promise<FinResult<{ id: string }>>,
  post: (ctx: FinanceWriteContext, saved: { id: string }) => Promise<FinResult<O>>,
): Promise<FinResult<O> & { draftId?: string }> {
  const ctx = await writeCtx();
  if (!ctx) return FORBIDDEN;
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstMessage(parsed.error) };
  const saved = await save(ctx, parsed.data);
  if (!saved.ok) {
    refresh(paths);
    return saved;
  }
  const posted = await post(ctx, { id: saved.data.id });
  refresh(paths);
  return posted.ok ? posted : { ok: false, error: posted.error, draftId: saved.data.id };
}

/**
 * One draft with its lines, for an Edit form. A read, but only people who may
 * edit have a use for it. A document that has gone, or been posted since the
 * list was loaded, answers with that sentence and refreshes the list.
 */
async function draftForEditing<D extends { display_status: string }>(
  paths: string[],
  schema: ZodType<{ id: string }>,
  input: unknown,
  get: (ctx: FinanceWriteContext, id: string) => Promise<D | null>,
  messages: { gone: string; locked: string },
): Promise<FinResult<D>> {
  const ctx = await writeCtx();
  if (!ctx) return FORBIDDEN;
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: messages.gone };
  try {
    const document = await get(ctx, parsed.data.id);
    if (document?.display_status === 'draft') return { ok: true, data: document };
    refresh(paths);
    return { ok: false, error: document ? messages.locked : messages.gone };
  } catch (error) {
    console.error('[finance] a draft could not be read:', error);
    return { ok: false, error: READ_FAILED };
  }
}
```

In `src/app/(app)/finance/actions.ts`, replace:

```ts
export async function saveAndPostBillAction(input: unknown): Promise<SaveAndPostResult> {
  const ctx = await writeCtx();
  if (!ctx) return FORBIDDEN;
  const parsed = saveBillInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstMessage(parsed.error) };
  const saved = await saveBill(ctx, parsed.data);
  if (!saved.ok) {
    refresh(PURCHASE_PATHS);
    return saved;
  }
  const posted = await postBill(ctx, { id: saved.data.id });
  refresh(PURCHASE_PATHS);
  return posted.ok ? posted : { ok: false, error: posted.error, draftId: saved.data.id };
}
```

with:

```ts
export async function saveAndPostBillAction(input: unknown): Promise<SaveAndPostResult> {
  return saveThenPost(PURCHASE_PATHS, saveBillInput, input, saveBill, postBill);
}
```

In `src/app/(app)/finance/actions.ts`, replace:

```ts
export async function getBillAction(input: unknown): Promise<FinResult<BillDetail>> {
  const ctx = await writeCtx();
  if (!ctx) return FORBIDDEN;
  const parsed = billIdInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: BILL_MESSAGES.gone };
  try {
    const bill = await getBill(ctx, parsed.data.id);
    if (bill?.display_status === 'draft') return { ok: true, data: bill };
    refresh(PURCHASE_PATHS);
    return { ok: false, error: bill ? BILL_MESSAGES.locked : BILL_MESSAGES.gone };
  } catch (error) {
    console.error('[finance] getBill failed:', error);
    return { ok: false, error: READ_FAILED };
  }
}
```

with:

```ts
export async function getBillAction(input: unknown): Promise<FinResult<BillDetail>> {
  return draftForEditing(PURCHASE_PATHS, billIdInput, input, getBill, BILL_MESSAGES);
}
```

In `src/app/(app)/finance/actions.ts`, replace:

```ts
export async function deleteScheduledPaymentAction(input: unknown) {
  return run(PURCHASE_PATHS, paymentIdInput, input, deleteScheduledPayment);
}
```

with:

```ts
export async function deleteScheduledPaymentAction(input: unknown) {
  return run(PURCHASE_PATHS, paymentIdInput, input, deleteScheduledPayment);
}

/* ---- invoices ---------------------------------------------------------- */

export async function saveInvoiceAction(input: unknown) {
  return run(SALES_PATHS, saveInvoiceInput, input, saveInvoice);
}
export async function postInvoiceAction(input: unknown) {
  return run(SALES_PATHS, invoiceIdInput, input, postInvoice);
}
export async function voidInvoiceAction(input: unknown) {
  return run(SALES_PATHS, invoiceIdInput, input, voidInvoice);
}
export async function deleteInvoiceAction(input: unknown) {
  return run(SALES_PATHS, invoiceIdInput, input, deleteInvoice);
}
/** What a person has recorded about a posted invoice's e-Invois. Nothing is sent to LHDN. */
export async function setEInvoiceAction(input: unknown) {
  return run(SALES_PATHS, setEInvoiceInput, input, setEInvoice);
}

/** Saves the invoice as a draft, then posts it; see `saveThenPost`. */
export async function saveAndPostInvoiceAction(input: unknown): Promise<SaveAndPostInvoiceResult> {
  return saveThenPost(SALES_PATHS, saveInvoiceInput, input, saveInvoice, postInvoice);
}

/** One draft invoice with its lines, for the Edit form; see `draftForEditing`. */
export async function getInvoiceAction(input: unknown): Promise<FinResult<InvoiceDetail>> {
  return draftForEditing(SALES_PATHS, invoiceIdInput, input, getInvoice, INVOICE_MESSAGES);
}

/* ---- payments in ------------------------------------------------------- */

export async function recordPaymentInAction(input: unknown) {
  return run(SALES_PATHS, recordPaymentInInput, input, recordPaymentIn);
}
/** Voiding money in refreshes the sales screens, and answers in the sentences of a payment in. */
export async function voidPaymentInAction(input: unknown) {
  return run(SALES_PATHS, paymentIdInput, input, voidPaymentIn);
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vitest run tests/finance-sales-actions.test.ts tests/finance-actions.test.ts tests/finance-contact-paths.test.ts`
Expected: PASS, all three files; 18 tests in `finance-sales-actions`. `finance-actions` was not edited: the bill actions answer and refresh exactly as before.

- [ ] **Step 5: Type-check, lint, check the file's exports, and commit**

Run, as separate commands: `pnpm exec tsc --noEmit`, `pnpm lint`, `pnpm exec vitest run --exclude 'tests/*.rls.test.ts' --exclude 'tests/bendahara-*.test.ts'`
Expected: no errors; every unit test passes.

Run: `grep -n "^export" "src/app/(app)/finance/actions.ts" | grep -v "export async function"`
Expected: no output.

```bash
git add "src/app/(app)/finance/actions.ts" tests/finance-sales-actions.test.ts
git commit -m "feat: server actions for invoices and payments in"
```

---

### Task 5: Payments In goes interactive

**Files:**
- Create: `src/components/finance/receipt-form-card.tsx`
- Replace: `src/components/finance/payments-in-view.tsx`
- Replace: `src/screens/finance/payments-in.tsx`

**Interfaces:**
- Consumes: `AllocationFormCard`, `RecordPayment` (Task 1); `PAYMENT_IN_KIND`, `ReceivableInvoice`, `receivableInvoices` (Task 3); `paymentInActions`, `alsoCoversInvoices` (Task 3); `recordPaymentInAction`, `voidPaymentInAction` (Task 4); `listInvoices`, `listAccounts`, `listPaymentsIn`; `ConfirmRow`, `RowMenu`, `useFinanceAction`, `downloadCsv`.
- Produces:
  - `@/components/finance/receipt-form-card`: `ReceiptFormCard({ receivable, accounts, today, preselect, record, onClose }: { receivable: ReceivableInvoice[]; accounts: FinanceAccount[]; today: string; preselect?: { customerId: string; invoiceId: string }; record: RecordPayment; onClose: () => void })`. Task 6 renders it too.
  - `@/components/finance/payments-in-view`: `type PaymentInActions = { record: RecordPayment; voidPayment: (input: unknown) => Promise<FinResult<{ id: string }>> }`; `type PaymentsInWriter = { actions: PaymentInActions; invoices: InvoiceListRow[]; accounts: FinanceAccount[] }`; `PaymentsInView({ rows, view, writer }: { rows: PaymentInRow[]; view: PaymentsInViewData; writer?: PaymentsInWriter })`.

How the screen behaves:

- The loader reads the payment rows for everybody, and the invoices and accounts only for a person who may edit. `writer` is passed only to them; without it there is no header button, no "⋯" column and no form.
- One thing is open at a time, held in one piece of state: the payment form, or the void question in one row.
- A received row offers Void. Any other row has no menu. There is no Edit and no Delete.
- A payment split across invoices is several rows. Void is sent the payment's `transaction_id`, so it acts on the whole payment from whichever row was used, and the question names the other invoices.
- While the form is open or the void is running, the row menus are `inert` and the header button is disabled. Opening or closing anything clears the last refusal, so a message never outlives its question.
- If the question's row disappears in a refresh (someone else voided the payment and the filter hides void rows), the refusal is shown beside the filters instead.
- Export is shown to everybody.

- [ ] **Step 1: Write the payment-in form card**

No test comes first for the three files of this task: Vitest has no DOM here, and every rule the components apply is tested in Tasks 1 and 3. Verification is the type-check, the linter and the build.

Create `src/components/finance/receipt-form-card.tsx`:

```tsx
'use client';

import { AllocationFormCard, type RecordPayment } from '@/components/finance/allocation-form-card';
import type { FinanceAccount } from '@/lib/finance/money';
import { PAYMENT_IN_KIND, type ReceivableInvoice } from '@/lib/finance/receipt-form';

/**
 * Records a payment received from one customer, split across their open
 * invoices. It is posted at once: there is no scheduling. Used on Payments
 * In, and on Invoices from an invoice's Record payment choice (`preselect`).
 * The card itself is the one payments out use; the rules are in
 * src/lib/finance/receipt-form.ts.
 */
export function ReceiptFormCard({
  receivable,
  accounts,
  today,
  preselect,
  record,
  onClose,
}: {
  /** Every invoice that can still take a payment, from `receivableInvoices`. */
  receivable: ReceivableInvoice[];
  accounts: FinanceAccount[];
  /** The default payment date, YYYY-MM-DD. */
  today: string;
  /** Opened from an invoice row: that customer chosen and that invoice ticked. */
  preselect?: { customerId: string; invoiceId: string };
  record: RecordPayment;
  onClose: () => void;
}) {
  return (
    <AllocationFormCard
      kind={PAYMENT_IN_KIND}
      documents={receivable}
      accounts={accounts}
      today={today}
      preselect={preselect ? { partyId: preselect.customerId, documentId: preselect.invoiceId } : undefined}
      record={record}
      onClose={onClose}
    />
  );
}
```

- [ ] **Step 2: Replace the Payments In client view**

Replace the whole of `src/components/finance/payments-in-view.tsx` with:

```tsx
'use client';

import { useState } from 'react';
import { Ban, Banknote, Download, PieChart, Plus, Search, TrendingUp } from 'lucide-react';
import { BentoCard, BentoGrid, BentoStat } from '@/components/bento/bento';
import { AreaTrend, DonutStat, type Series } from '@/components/charts';
import type { RecordPayment } from '@/components/finance/allocation-form-card';
import { ConfirmRow } from '@/components/finance/confirm-row';
import { downloadCsv } from '@/components/finance/download-csv';
import { ReceiptFormCard } from '@/components/finance/receipt-form-card';
import { RowMenu, type RowMenuItem } from '@/components/finance/row-menu';
import { useFinanceAction } from '@/components/finance/use-finance-action';
import { PageHeader } from '@/components/screen/page-header';
import { ScreenContainer } from '@/components/screen/screen-container';
import { NoMatchesRow } from '@/components/screen/table-filter';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LiveDot } from '@/components/ui/live-dot';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { localIsoDate } from '@/lib/finance/bill-math';
import { csvFileName } from '@/lib/finance/csv';
import { rm } from '@/lib/finance/format';
import type { InvoiceListRow } from '@/lib/finance/invoices';
import { type FinanceAccount, PAYMENT_METHODS, PAYMENT_METHOD_LABELS, type PaymentInRow } from '@/lib/finance/money';
import { receivableInvoices } from '@/lib/finance/receipt-form';
import type { FinResult } from '@/lib/finance/result';
import {
  PAYMENT_IN_STATUS_LABELS,
  type PaymentInMethodFilter,
  type PaymentInStatusFilter,
  type PaymentsInViewData,
  alsoCoversInvoices,
  filterPaymentsIn,
  paymentInActions,
  paymentsInCsv,
} from '@/lib/finance/sales-views';
import { LATEST_ROWS, displayDate } from '@/lib/finance/view-helpers';
import { cn } from '@/lib/utils';

export type PaymentInActions = {
  record: RecordPayment;
  voidPayment: (input: unknown) => Promise<FinResult<{ id: string }>>;
};

/** What only a person who may edit is given: the actions, and what the payment form offers. */
export type PaymentsInWriter = {
  actions: PaymentInActions;
  /** Every invoice, to find the ones that can still take a payment. */
  invoices: InvoiceListRow[];
  accounts: FinanceAccount[];
};

const RECEIVED_SERIES: Series[] = [{ key: 'received', label: 'Received (RM k)', color: 'var(--chart-2)' }];

const STATUS_STYLES: Record<PaymentInRow['status'], string> = {
  posted: 'bg-emerald-500/15 text-emerald-600',
  scheduled: 'bg-amber-500/15 text-amber-600',
  pending_approval: 'bg-amber-500/15 text-amber-600',
  draft: 'bg-muted text-muted-foreground',
  rejected: 'bg-muted text-muted-foreground',
  void: 'bg-muted text-muted-foreground line-through',
};

/** One thing open at a time: the payment form, or the void question in one row. */
type Open = { kind: 'form'; today: string } | { kind: 'void'; row: PaymentInRow } | null;

/**
 * Payments In: figures, charts and the table, with search, filters, "View
 * all" and Export for everybody. A person who may edit (`writer`) also gets
 * Record Payment and, on a received payment, Void. There is no edit and no
 * delete: money in is posted the moment it is recorded.
 */
export function PaymentsInView({
  rows,
  view,
  writer,
}: {
  /** One row per invoice a payment pays, newest first; void ones included. */
  rows: PaymentInRow[];
  view: PaymentsInViewData;
  writer?: PaymentsInWriter;
}) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<PaymentInStatusFilter>('posted');
  const [method, setMethod] = useState<PaymentInMethodFilter>('all');
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState<Open>(null);
  const confirm = useFinanceAction();

  const matching = filterPaymentsIn(rows, query, status, method);
  const shown = showAll ? matching : matching.slice(0, LATEST_ROWS);
  const columns = writer ? 9 : 8;
  const asking = open?.kind === 'void' ? open : null;
  // The form holds what was typed, so nothing else opens over it: it is closed with its own Cancel first.
  const locked = confirm.pending || open?.kind === 'form';
  // A row that is gone after a refresh takes its question with it; the message still has to be seen.
  const askingInView = asking ? shown.some((r) => r.allocation_id === asking.row.allocation_id) : false;

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

  const menu = (row: PaymentInRow): RowMenuItem[] =>
    paymentInActions(row).map(() => ({
      label: 'Void',
      icon: Ban,
      destructive: true,
      opens: true,
      onSelect: () => ask({ kind: 'void', row }),
    }));

  const question = (row: PaymentInRow) => {
    if (!writer || !asking || asking.row.allocation_id !== row.allocation_id) return null;
    const { actions } = writer;
    return (
      <ConfirmRow
        key={row.allocation_id}
        colSpan={columns}
        icon={Ban}
        label={`Void payment ${row.number ?? ''} from ${row.customer_name}`}
        confirmLabel="Void payment"
        pendingLabel="Voiding…"
        pending={confirm.pending}
        error={confirm.error}
        // Sent the payment's own id, so the whole payment is voided whichever of its rows was used.
        onConfirm={() => confirm.run(() => actions.voidPayment({ id: row.transaction_id }), close)}
        onCancel={close}
      >
        Void payment <span className="font-medium">{row.number}</span> of{' '}
        <span className="font-medium">{rm(row.transaction_amount)}</span> from{' '}
        <span className="font-medium">{row.customer_name}</span>? The invoices it paid will owe that amount again. This
        cannot be undone. {alsoCoversInvoices(rows, row)}
      </ConfirmRow>
    );
  };

  return (
    <ScreenContainer className="pb-24 sm:pb-24">
      <PageHeader
        title="Payments In"
        subtitle="Payments received from your customers, Saudara."
        actions={
          writer ? (
            <Button
              size="sm"
              aria-expanded={open?.kind === 'form'}
              disabled={locked}
              onClick={() => ask({ kind: 'form', today: localIsoDate(new Date()) })}
            >
              <Plus className="size-4" />
              Record Payment
            </Button>
          ) : undefined
        }
      />

      <BentoGrid>
        {writer && open?.kind === 'form' ? (
          <ReceiptFormCard
            receivable={receivableInvoices(writer.invoices, rows)}
            accounts={writer.accounts}
            today={open.today}
            record={writer.actions.record}
            onClose={close}
          />
        ) : null}

        {view.stats.map((s, i) => (
          <BentoCard key={s.label} tone={i === 0 ? 'primary' : 'default'} className="col-span-1 md:col-span-3">
            <BentoStat label={s.label} value={s.value} delta={s.delta} deltaTone={s.deltaTone} onPrimary={i === 0} />
          </BentoCard>
        ))}

        <BentoCard title="Received over time" subtitle="Last 8 months" icon={TrendingUp} className="col-span-2 md:col-span-8">
          {view.hasTrend ? (
            <AreaTrend data={view.trend} series={RECEIVED_SERIES} height={240} />
          ) : (
            <p className="grid h-60 place-items-center text-sm text-muted-foreground">Nothing received in the last 8 months.</p>
          )}
        </BentoCard>
        <BentoCard title="Received by method" subtitle="Month to date · RM" icon={PieChart} className="col-span-2 md:col-span-4">
          {view.hasReceived ? (
            <DonutStat data={view.byMethod} height={240} centerValue={view.receivedMtd} centerLabel="received" />
          ) : (
            <p className="grid h-60 place-items-center text-sm text-muted-foreground">Nothing received yet this month.</p>
          )}
        </BentoCard>

        <BentoCard
          title="Payments"
          subtitle="One row for each invoice a payment pays"
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
            <div className="relative w-full sm:w-64">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                aria-label="Search payments by customer, invoice, receipt number or reference"
                placeholder="Search payments…"
                className="pl-8"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <Select value={status} onValueChange={(v) => setStatus(v as PaymentInStatusFilter)}>
              <SelectTrigger className="w-40" aria-label="Status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="posted">Received</SelectItem>
                <SelectItem value="void">Void</SelectItem>
                <SelectItem value="all">All</SelectItem>
              </SelectContent>
            </Select>
            <Select value={method} onValueChange={(v) => setMethod(v as PaymentInMethodFilter)}>
              <SelectTrigger className="w-40" aria-label="Method">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All methods</SelectItem>
                {PAYMENT_METHODS.map((m) => (
                  <SelectItem key={m} value={m}>
                    {PAYMENT_METHOD_LABELS[m]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              disabled={matching.length === 0}
              onClick={() => downloadCsv(csvFileName('payments-in', localIsoDate(new Date())), paymentsInCsv(matching))}
            >
              <Download className="size-4" />
              Export
            </Button>
            {/* The question's own message shows in its row; here only while its row is out of view. */}
            {confirm.error && asking && !askingInView ? (
              <p role="alert" className="text-sm text-destructive">
                {confirm.error}
              </p>
            ) : null}
          </div>
          <div className="mt-3 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40">
                  <TableHead>Date</TableHead>
                  <TableHead>No.</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Invoice</TableHead>
                  <TableHead>Account</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Status</TableHead>
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
                        No payments yet.{writer ? ' Record one against a posted invoice.' : ''}
                      </TableCell>
                    </TableRow>
                  ) : (
                    <NoMatchesRow colSpan={columns} />
                  ))}
                {shown.map((p) => {
                  const asked = question(p);
                  if (asked) return asked;
                  const items = writer ? menu(p) : [];
                  return (
                    // A payment split across invoices is several rows; the allocation is what each row is.
                    <TableRow key={p.allocation_id} className={cn(p.status === 'void' && 'opacity-60')}>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{displayDate(p.txn_date)}</TableCell>
                      <TableCell className="whitespace-nowrap font-mono text-xs">{p.number ?? '—'}</TableCell>
                      <TableCell className="whitespace-nowrap font-medium">{p.customer_name}</TableCell>
                      <TableCell className="whitespace-nowrap">{p.invoice_no ?? '—'}</TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{p.account_name}</TableCell>
                      <TableCell>
                        <Badge variant="secondary" className="whitespace-nowrap">
                          {PAYMENT_METHOD_LABELS[p.method]}
                        </Badge>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right tabular-nums">{rm(p.amount)}</TableCell>
                      <TableCell>
                        <span className="flex items-center gap-2">
                          <LiveDot active={p.status === 'posted'} />
                          <span
                            className={cn(
                              'inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold',
                              STATUS_STYLES[p.status],
                            )}
                          >
                            {PAYMENT_IN_STATUS_LABELS[p.status]}
                          </span>
                        </span>
                      </TableCell>
                      {writer ? (
                        <TableCell>
                          {items.length ? (
                            // RowMenu has no disabled prop; an inert wrapper keeps its button from being used while an action runs or the form is open.
                            <span inert={locked} className={cn(locked && 'opacity-50')}>
                              <RowMenu label={`${p.number ?? 'the payment'} from ${p.customer_name}`} items={items} />
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
            Showing {shown.length} of {matching.length} rows
            {matching.length !== rows.length ? ` (${rows.length} in all)` : ''}
          </div>
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}
```

- [ ] **Step 3: Replace the screen with a loader that knows who may edit**

Replace the whole of `src/screens/finance/payments-in.tsx` with:

```tsx
import { recordPaymentInAction, voidPaymentInAction } from '@/app/(app)/finance/actions';
import { type PaymentInActions, PaymentsInView } from '@/components/finance/payments-in-view';
import { can } from '@/lib/auth/permissions';
import { getViewer, hasSupabaseEnv } from '@/lib/auth/viewer';
import { listInvoices } from '@/lib/finance/invoices';
import { listAccounts, listPaymentsIn } from '@/lib/finance/money';
import { paymentsInView } from '@/lib/finance/sales-views';
import { todayUtc } from '@/lib/finance/view-helpers';
import { createClient } from '@/lib/supabase/server';
import { SAMPLE_PAYMENTS_IN, SAMPLE_TODAY } from './sales-sample';

const ACTIONS: PaymentInActions = {
  record: recordPaymentInAction,
  voidPayment: voidPaymentInAction,
};

export default async function PaymentsInScreen() {
  if (!hasSupabaseEnv()) {
    return <PaymentsInView rows={SAMPLE_PAYMENTS_IN} view={paymentsInView(SAMPLE_PAYMENTS_IN, SAMPLE_TODAY)} />;
  }
  const viewer = await getViewer();
  const ctx = { client: await createClient(), orgId: viewer.orgId };
  const canEdit = !viewer.isDemo && can(viewer.role, 'edit-data');
  // The payment form offers open invoices and accounts; a viewer has no form, so neither is read for them.
  const [rows, invoices, accounts] = await Promise.all([
    listPaymentsIn(ctx),
    canEdit ? listInvoices(ctx) : [],
    canEdit ? listAccounts(ctx) : [],
  ]);
  return (
    <PaymentsInView
      rows={rows}
      view={paymentsInView(rows, todayUtc())}
      writer={canEdit ? { actions: ACTIONS, invoices, accounts } : undefined}
    />
  );
}
```

- [ ] **Step 4: Type-check, lint, test and build**

Run, as separate commands: `pnpm exec tsc --noEmit`, `pnpm lint`, `pnpm exec vitest run --exclude 'tests/*.rls.test.ts' --exclude 'tests/bendahara-*.test.ts'`, `pnpm build`
Expected: no type or lint errors; every unit test passes; the build completes.

If the linter reports `react-hooks/set-state-in-effect` or a rule about refs, the file was changed from what is written here: this view has no effect and no ref.

- [ ] **Step 5: Check for banned colours, names and dialogs**

Run: `git diff main -- src | grep -n -i -E "^\+.*(purple|violet|fuchsia|indigo|kuasa\.ai)"`
Expected: no output.

Run: `grep -n -E "window\.confirm|alert\(|router\.refresh" src/components/finance/payments-in-view.tsx src/components/finance/receipt-form-card.tsx src/components/finance/allocation-form-card.tsx`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add src/components/finance/receipt-form-card.tsx src/components/finance/payments-in-view.tsx src/screens/finance/payments-in.tsx
git commit -m "feat: record and void payments in"
```

---

### Task 6: Invoices goes interactive

**Files:**
- Create: `src/components/finance/invoice-form-card.tsx`
- Create: `src/components/finance/einvoice-card.tsx`
- Replace: `src/components/finance/invoices-view.tsx`
- Replace: `src/screens/finance/invoices.tsx`

**Interfaces:**
- Consumes: `DocumentFormCard` (Task 1); `INVOICE_FORM_KIND`, `invoiceFormFromDetail`, `newInvoiceForm`, `eInvoiceForm`, `eInvoiceFormError`, `eInvoicePayload`, `withEInvoiceStatus` (Task 3); `invoiceActions`, `customerChoice`, `InvoiceAction` (Task 3); `receivableInvoices` (Task 3); `ReceiptFormCard` (Task 5); the seven invoice actions and `recordPaymentInAction` (Task 4); `EINVOICE_STATUSES`, `EINVOICE_UUID_MAX`, `InvoiceListRow.einvoice_uuid` (Task 2); `listContacts`, `listProducts`, `listAccounts`, `listInvoices`, `listPaymentsIn`.
- Produces:
  - `@/components/finance/invoice-form-card`: `type InvoiceFormActions = { save: (input: unknown) => Promise<FinResult<{ id: string }>>; saveAndPost: (input: unknown) => Promise<SaveAndPostInvoiceResult> }`; `InvoiceFormCard({ editing, customers, products, today, actions, onClose })`.
  - `@/components/finance/einvoice-card`: `EInvoiceCard({ invoice, save, onClose }: { invoice: InvoiceListRow; save: (input: unknown) => Promise<FinResult<{ id: string }>>; onClose: () => void })`.
  - `@/components/finance/invoices-view`: `type InvoiceActions = InvoiceFormActions & { post; voidInvoice; remove; get; recordPayment: RecordPayment; setEInvoice }`; `type InvoicesWriter = { actions: InvoiceActions; customers: FinanceContact[]; products: FinanceProduct[]; accounts: FinanceAccount[]; payments: PaymentInRow[] }`; `InvoicesView({ rows, view, writer }: { rows: InvoiceListRow[]; view: InvoicesViewData; writer?: InvoicesWriter })`.

How the screen behaves:

- The loader reads invoices and payments in for everybody (the cards and the trend need both), and customers, products and accounts only for a person who may edit. `writer` is passed only to them; without it there is no "New Invoice", no "⋯" column and no card.
- One thing is open at a time: a card at the top (new invoice, edit draft, record payment, e-Invois) or a question in one row (post, void, delete).
- Each row's menu is `invoiceActions` turned into menu items, so it offers exactly what the row's status allows.
- **New / Edit.** The invoice form, as the bill form. Edit reads the draft with its lines first and shows "Loading…"; if the draft was posted or deleted meanwhile the card says so and the list has been refreshed.
- **Post** asks first, in the row, in the neutral tone: it locks the invoice.
- **Record payment** opens the payment form on this screen with the customer chosen and the invoice ticked (`preselect`), as Pay does on a bill.
- **Set e-Invois** opens the small card. Its subtitle says nothing is submitted.
- **Void** asks first, in red, and says an invoice with payments cannot be voided until they are voided on Payments In. **Delete** asks first, in red.
- While a card is open or an action is running, the row menus are `inert` and "New Invoice" is disabled. Opening or closing anything clears the last refusal.
- **The customer filter.** `customerChoice` gives the customer the filter is really on. When that differs from what is stored (the chosen customer has no invoice left), the stored choice is reset during render. This is React's documented way to adjust state to new props; it is not an effect, and the linter accepts it as written.
- The e-Invois badge carries the recorded UUID as its tooltip.

- [ ] **Step 1: Write the invoice form card**

No test comes first for the four files of this task: Vitest has no DOM here, and every rule the components apply is tested in Tasks 1 to 4. Verification is the type-check, the linter and the build.

Create `src/components/finance/invoice-form-card.tsx`:

```tsx
'use client';

import { DocumentFormCard } from '@/components/finance/document-form-card';
import type { FinanceContact } from '@/lib/finance/contacts';
import { INVOICE_FORM_KIND, invoiceFormFromDetail, newInvoiceForm } from '@/lib/finance/invoice-form';
import type { InvoiceDetail, SaveAndPostInvoiceResult } from '@/lib/finance/invoices';
import type { FinanceProduct } from '@/lib/finance/products';
import type { FinResult } from '@/lib/finance/result';

export type InvoiceFormActions = {
  save: (input: unknown) => Promise<FinResult<{ id: string }>>;
  saveAndPost: (input: unknown) => Promise<SaveAndPostInvoiceResult>;
};

/**
 * A new invoice, or a draft being changed (`editing`). The card itself is the
 * one bills use; the rules are in src/lib/finance/invoice-form.ts.
 */
export function InvoiceFormCard({
  editing,
  customers,
  products,
  today,
  actions,
  onClose,
}: {
  /** The draft being changed, with its lines; absent for a new invoice. */
  editing?: InvoiceDetail;
  /** Active customers, by name. */
  customers: FinanceContact[];
  /** Active products and services. */
  products: FinanceProduct[];
  /** The default invoice date, YYYY-MM-DD. */
  today: string;
  actions: InvoiceFormActions;
  onClose: () => void;
}) {
  return (
    <DocumentFormCard
      kind={INVOICE_FORM_KIND}
      initial={() => (editing ? invoiceFormFromDetail(editing) : newInvoiceForm(today, 'new-0'))}
      // A customer archived since the draft was saved is still this invoice's customer.
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

- [ ] **Step 2: Write the e-Invois card**

`BentoCard` is given `FileText`, which is in its icon map.

Create `src/components/finance/einvoice-card.tsx`:

```tsx
'use client';

import { type FormEvent, useId, useState } from 'react';
import { FileText } from 'lucide-react';
import { BentoCard } from '@/components/bento/bento';
import { useFinanceAction } from '@/components/finance/use-finance-action';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { eInvoiceForm, eInvoiceFormError, eInvoicePayload, withEInvoiceStatus } from '@/lib/finance/invoice-form';
import { EINVOICE_STATUSES, EINVOICE_UUID_MAX, type EInvoiceStatus, type InvoiceListRow } from '@/lib/finance/invoices';
import type { FinResult } from '@/lib/finance/result';
import { EINVOICE_STATUS_LABELS } from '@/lib/finance/sales-views';

/**
 * What a person has recorded about one posted invoice's e-Invois: its status
 * at LHDN and the UUID LHDN gave it. A record only: nothing is submitted from
 * here. The rules are in src/lib/finance/invoice-form.ts.
 */
export function EInvoiceCard({
  invoice,
  save,
  onClose,
}: {
  /** A posted invoice. */
  invoice: InvoiceListRow;
  save: (input: unknown) => Promise<FinResult<{ id: string }>>;
  onClose: () => void;
}) {
  const id = useId();
  const [form, setForm] = useState(() => eInvoiceForm(invoice));
  const action = useFinanceAction();
  // A change by the person answers the last refusal, so its sentence goes.
  const edit: typeof setForm = (next) => {
    action.clear();
    setForm(next);
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    // Handled here rather than as a form action, so a refused form keeps what was typed.
    event.preventDefault();
    const problem = eInvoiceFormError(invoice.id, form);
    if (problem) {
      action.fail(problem);
      return;
    }
    action.run(() => save(eInvoicePayload(invoice.id, form)), onClose);
  };

  return (
    <BentoCard
      title="e-Invois"
      subtitle={`What you have recorded for ${invoice.invoice_no ?? 'this invoice'} at LHDN. Nothing is submitted from here.`}
      icon={FileText}
      className="col-span-2 md:col-span-12"
    >
      <form onSubmit={submit} noValidate className="grid gap-3 md:grid-cols-12">
        <div className="space-y-1.5 md:col-span-3">
          <Label htmlFor={`${id}-status`}>Status</Label>
          <Select value={form.status} onValueChange={(v) => edit((f) => withEInvoiceStatus(f, v as EInvoiceStatus))}>
            <SelectTrigger id={`${id}-status`} className="w-full" autoFocus data-finance-focus>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {EINVOICE_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {s === 'none' ? 'None' : EINVOICE_STATUS_LABELS[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5 md:col-span-6">
          <Label htmlFor={`${id}-uuid`}>LHDN UUID</Label>
          <Input
            id={`${id}-uuid`}
            value={form.uuid}
            maxLength={EINVOICE_UUID_MAX}
            // An invoice with no e-Invois has no UUID.
            disabled={form.status === 'none'}
            placeholder={form.status === 'none' ? 'Choose a status first' : 'As shown on MyInvois'}
            autoComplete="off"
            className="font-mono"
            onChange={(e) => edit((f) => ({ ...f, uuid: e.target.value }))}
          />
        </div>
        <div className="flex flex-wrap items-center gap-3 md:col-span-12">
          <Button type="submit" size="sm" disabled={action.pending}>
            {action.pending ? 'Saving…' : 'Save'}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={action.pending}>
            Cancel
          </Button>
          {action.error ? (
            <p role="alert" className="text-sm text-destructive">
              {action.error}
            </p>
          ) : null}
        </div>
      </form>
    </BentoCard>
  );
}
```

- [ ] **Step 3: Replace the Invoices client view**

Replace the whole of `src/components/finance/invoices-view.tsx` with:

```tsx
'use client';

import { useState } from 'react';
import {
  BadgeCheck,
  Ban,
  Banknote,
  Download,
  FileCheck,
  FileText,
  Pencil,
  PieChart,
  Plus,
  Search,
  Trash2,
  TrendingUp,
} from 'lucide-react';
import { BentoCard, BentoGrid, BentoStat } from '@/components/bento/bento';
import { AreaTrend, DonutStat, type Series } from '@/components/charts';
import type { RecordPayment } from '@/components/finance/allocation-form-card';
import { ConfirmRow } from '@/components/finance/confirm-row';
import { downloadCsv } from '@/components/finance/download-csv';
import { EInvoiceCard } from '@/components/finance/einvoice-card';
import { InvoiceFormCard, type InvoiceFormActions } from '@/components/finance/invoice-form-card';
import { ReceiptFormCard } from '@/components/finance/receipt-form-card';
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
import type { EInvoiceStatus, InvoiceDetail, InvoiceDisplayStatus, InvoiceListRow } from '@/lib/finance/invoices';
import type { FinanceAccount, PaymentInRow } from '@/lib/finance/money';
import type { FinanceProduct } from '@/lib/finance/products';
import { receivableInvoices } from '@/lib/finance/receipt-form';
import type { FinResult } from '@/lib/finance/result';
import {
  EINVOICE_STATUS_LABELS,
  INVOICE_STATUS_LABELS,
  type InvoiceAction,
  type InvoiceFilter,
  type InvoicesViewData,
  customerChoice,
  filterInvoices,
  invoiceActions,
  invoiceCustomers,
  invoicesCsv,
  owed,
} from '@/lib/finance/sales-views';
import { LATEST_ROWS, displayDate } from '@/lib/finance/view-helpers';
import { cn } from '@/lib/utils';

export type InvoiceActions = InvoiceFormActions & {
  post: (input: unknown) => Promise<FinResult<{ id: string; invoice_no: string }>>;
  voidInvoice: (input: unknown) => Promise<FinResult<{ id: string }>>;
  remove: (input: unknown) => Promise<FinResult<{ id: string }>>;
  /** Reads one draft with its lines, for the Edit form. */
  get: (input: unknown) => Promise<FinResult<InvoiceDetail>>;
  recordPayment: RecordPayment;
  setEInvoice: (input: unknown) => Promise<FinResult<{ id: string }>>;
};

/** What only a person who may edit is given: the actions, and what the forms offer. */
export type InvoicesWriter = {
  actions: InvoiceActions;
  /** Active customers, by name. */
  customers: FinanceContact[];
  /** Active products and services. */
  products: FinanceProduct[];
  accounts: FinanceAccount[];
  /** Every payment-in row, to know what an invoice can still take. */
  payments: PaymentInRow[];
};

const TREND_SERIES: Series[] = [
  { key: 'invoiced', label: 'Invoiced (RM k)', color: 'var(--chart-1)' },
  { key: 'received', label: 'Received (RM k)', color: 'var(--chart-2)' },
];

const STATUS_STYLES: Record<InvoiceDisplayStatus, string> = {
  paid: 'bg-emerald-500/15 text-emerald-600',
  sent: 'bg-amber-500/15 text-amber-600',
  overdue: 'bg-red-500/15 text-red-600',
  draft: 'bg-muted text-muted-foreground',
  void: 'bg-muted text-muted-foreground line-through',
};

const EINVOICE_STYLES: Record<Exclude<EInvoiceStatus, 'none'>, string> = {
  validated: 'bg-emerald-500/15 text-emerald-600',
  pending: 'bg-amber-500/15 text-amber-600',
  rejected: 'bg-red-500/15 text-red-600',
};

/** A draft or void invoice owes nothing: a dash, as a draft's number is. */
const formatOwed = (balance: number | null) => (balance === null ? '—' : rm(balance));

/** One thing open at a time: a form card, or a question in one row. */
type Open =
  | { kind: 'new'; today: string; nonce: number }
  /** `detail` is null while the draft's lines are being read. */
  | { kind: 'edit'; invoice: InvoiceListRow; detail: InvoiceDetail | null; today: string }
  | { kind: 'pay'; invoice: InvoiceListRow; today: string }
  | { kind: 'einvoice'; invoice: InvoiceListRow }
  | { kind: 'post'; invoice: InvoiceListRow }
  | { kind: 'void'; invoice: InvoiceListRow }
  | { kind: 'delete'; invoice: InvoiceListRow }
  | null;

const invoiceName = (invoice: InvoiceListRow) => `${invoice.invoice_no ?? 'the draft invoice'} to ${invoice.customer_name}`;

/**
 * Invoices: figures, charts and the table, with search, filters, "View all"
 * and Export for everybody. A person who may edit (`writer`) also gets New
 * Invoice and a menu on each row that offers what its status allows.
 */
export function InvoicesView({
  rows,
  view,
  writer,
}: {
  /** Every invoice, newest first; drafts and void ones included. */
  rows: InvoiceListRow[];
  view: InvoicesViewData;
  writer?: InvoicesWriter;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<InvoiceFilter>('open');
  const [chosenCustomer, setCustomer] = useState('all');
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState<Open>(null);
  const confirm = useFinanceAction();
  const loader = useFinanceAction('read');

  const customers = invoiceCustomers(rows);
  const customer = customerChoice(chosenCustomer, customers);
  // The chosen customer has no invoice left after a refresh. The choice is dropped, not only hidden,
  // so it does not come back by itself when that customer is invoiced again.
  if (customer !== chosenCustomer) setCustomer(customer);
  const matching = filterInvoices(rows, query, filter, customer);
  const shown = showAll ? matching : matching.slice(0, LATEST_ROWS);
  const columns = writer ? 9 : 8;
  const receivable = writer ? receivableInvoices(rows, writer.payments) : [];
  const asking = open && (open.kind === 'post' || open.kind === 'void' || open.kind === 'delete') ? open : null;
  // A form holds what was typed, so nothing else opens over it: it is closed with its own Cancel first.
  const formOpen = open !== null && !asking;
  // A row that is gone after a refresh takes its question with it; the message still has to be seen.
  const askingInView = asking ? shown.some((i) => i.id === asking.invoice.id) : false;
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

  const menuItem = (invoice: InvoiceListRow, action: InvoiceAction, actions: InvoiceActions): RowMenuItem => {
    switch (action) {
      case 'edit':
        return {
          label: 'Edit',
          icon: Pencil,
          opens: true,
          onSelect: () => {
            loader.clear();
            ask({ kind: 'edit', invoice, detail: null, today: now() });
            loader.run(
              () => actions.get({ id: invoice.id }),
              // Still waiting on this invoice? Something else may have been opened meanwhile.
              (detail) =>
                setOpen((cur) => (cur?.kind === 'edit' && cur.invoice.id === invoice.id ? { ...cur, detail } : cur)),
            );
          },
        };
      case 'post':
        return { label: 'Post', icon: FileCheck, opens: true, onSelect: () => ask({ kind: 'post', invoice }) };
      case 'delete':
        return { label: 'Delete', icon: Trash2, destructive: true, opens: true, onSelect: () => ask({ kind: 'delete', invoice }) };
      case 'pay':
        return { label: 'Record payment', icon: Banknote, opens: true, onSelect: () => ask({ kind: 'pay', invoice, today: now() }) };
      case 'einvoice':
        return { label: 'Set e-Invois', icon: BadgeCheck, opens: true, onSelect: () => ask({ kind: 'einvoice', invoice }) };
      case 'void':
        return { label: 'Void', icon: Ban, destructive: true, opens: true, onSelect: () => ask({ kind: 'void', invoice }) };
    }
  };

  const menu = (invoice: InvoiceListRow, actions: InvoiceActions): RowMenuItem[] =>
    invoiceActions(
      invoice,
      receivable.some((r) => r.id === invoice.id),
    ).map((action) => menuItem(invoice, action, actions));

  const question = (invoice: InvoiceListRow) => {
    if (!writer || !asking || asking.invoice.id !== invoice.id) return null;
    const { actions } = writer;
    if (asking.kind === 'post') {
      return (
        <ConfirmRow
          key={invoice.id}
          colSpan={columns}
          tone="default"
          icon={FileCheck}
          label={`Post ${invoiceName(invoice)}`}
          confirmLabel="Post"
          pendingLabel="Posting…"
          pending={confirm.pending}
          error={confirm.error}
          onConfirm={() => confirm.run(() => actions.post({ id: invoice.id }), close)}
          onCancel={close}
        >
          Post this invoice to <span className="font-medium">{invoice.customer_name}</span> ({rm(invoice.total)})? It
          gets its number and can no longer be edited, only voided.
        </ConfirmRow>
      );
    }
    if (asking.kind === 'void') {
      return (
        <ConfirmRow
          key={invoice.id}
          colSpan={columns}
          icon={Ban}
          label={`Void ${invoiceName(invoice)}`}
          confirmLabel="Void invoice"
          pendingLabel="Voiding…"
          pending={confirm.pending}
          error={confirm.error}
          onConfirm={() => confirm.run(() => actions.voidInvoice({ id: invoice.id }), close)}
          onCancel={close}
        >
          Void <span className="font-medium">{invoice.invoice_no}</span> to{' '}
          <span className="font-medium">{invoice.customer_name}</span> ({rm(invoice.total)})? It stays in the list as
          Void and nothing more is owed on it. This cannot be undone. An invoice that has payments cannot be voided
          until they are voided on Payments In.
        </ConfirmRow>
      );
    }
    return (
      <ConfirmRow
        key={invoice.id}
        colSpan={columns}
        label={`Delete ${invoiceName(invoice)}`}
        confirmLabel="Delete draft"
        pendingLabel="Deleting…"
        pending={confirm.pending}
        error={confirm.error}
        onConfirm={() => confirm.run(() => actions.remove({ id: invoice.id }), close)}
        onCancel={close}
      >
        Delete the draft invoice to <span className="font-medium">{invoice.customer_name}</span> ({rm(invoice.total)})?
        This cannot be undone.
      </ConfirmRow>
    );
  };

  const card = () => {
    if (!writer || !open) return null;
    const { actions } = writer;
    if (open.kind === 'new') {
      return (
        <InvoiceFormCard
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
        <InvoiceFormCard
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
          title="Edit invoice"
          subtitle={`The draft to ${open.invoice.customer_name}`}
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
    if (open.kind === 'pay') {
      return (
        <ReceiptFormCard
          key={open.invoice.id}
          receivable={receivable}
          accounts={writer.accounts}
          today={open.today}
          preselect={{ customerId: open.invoice.customer_id, invoiceId: open.invoice.id }}
          record={actions.recordPayment}
          onClose={close}
        />
      );
    }
    if (open.kind === 'einvoice') {
      return <EInvoiceCard key={open.invoice.id} invoice={open.invoice} save={actions.setEInvoice} onClose={close} />;
    }
    return null;
  };

  // The question's own message shows in its row; beside the filters only while its row is out of view.
  const tableError = confirm.error && asking && !askingInView ? confirm.error : null;

  return (
    <ScreenContainer className="pb-24 sm:pb-24">
      <PageHeader
        title="Invoices"
        subtitle="Sales invoices and their e-Invois status, Saudara."
        actions={
          writer ? (
            <Button
              size="sm"
              aria-expanded={open?.kind === 'new'}
              disabled={locked}
              onClick={() => ask({ kind: 'new', today: now(), nonce: Date.now() })}
            >
              <Plus className="size-4" />
              New Invoice
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
          title="Invoiced over time"
          subtitle="Invoiced vs received · last 8 months"
          icon={TrendingUp}
          className="col-span-2 md:col-span-8"
        >
          {view.hasTrend ? (
            <AreaTrend data={view.trend} series={TREND_SERIES} height={240} showLegend />
          ) : (
            <p className="grid h-60 place-items-center text-sm text-muted-foreground">
              Nothing invoiced or received in the last 8 months.
            </p>
          )}
        </BentoCard>
        <BentoCard title="Invoices by status" subtitle="Current book" icon={PieChart} className="col-span-2 md:col-span-4">
          {view.invoiceCount === 0 ? (
            <p className="grid h-60 place-items-center text-sm text-muted-foreground">
              {rows.length === 0 ? 'No invoices yet.' : 'No open invoices.'}
            </p>
          ) : (
            <DonutStat data={view.byStatus} height={240} centerValue={String(view.invoiceCount)} centerLabel="invoices" />
          )}
        </BentoCard>

        <BentoCard
          title="Invoices"
          subtitle="What you have billed your customers"
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
                aria-label="Search invoices by number or customer"
                placeholder="Search invoices or customers…"
                className="pl-8"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <Select value={filter} onValueChange={(v) => setFilter(v as InvoiceFilter)}>
              <SelectTrigger className="w-40" aria-label="Status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="open">All except void</SelectItem>
                <SelectItem value="draft">Draft</SelectItem>
                <SelectItem value="sent">Sent</SelectItem>
                <SelectItem value="overdue">Overdue</SelectItem>
                <SelectItem value="paid">Paid</SelectItem>
                <SelectItem value="void">Void</SelectItem>
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
              onClick={() => downloadCsv(csvFileName('invoices', now()), invoicesCsv(matching))}
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
                  <TableHead>Due</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">Balance</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>e-Invois</TableHead>
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
                        No invoices yet.{writer ? ' Add the first one with New Invoice.' : ''}
                      </TableCell>
                    </TableRow>
                  ) : (
                    <NoMatchesRow colSpan={columns} />
                  ))}
                {shown.map((i) => {
                  const asked = question(i);
                  if (asked) return asked;
                  const items = writer ? menu(i, writer.actions) : [];
                  return (
                    <TableRow key={i.id} className={cn(i.display_status === 'void' && 'opacity-60')}>
                      <TableCell className="whitespace-nowrap font-medium">{i.invoice_no ?? '—'}</TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{displayDate(i.invoice_date)}</TableCell>
                      <TableCell className="whitespace-nowrap">{i.customer_name}</TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{displayDate(i.due_date)}</TableCell>
                      <TableCell className="whitespace-nowrap text-right tabular-nums">{rm(i.total)}</TableCell>
                      <TableCell className="whitespace-nowrap text-right tabular-nums">{formatOwed(owed(i))}</TableCell>
                      <TableCell>
                        <span className="flex items-center gap-2">
                          <LiveDot active={i.display_status === 'paid'} />
                          <span
                            className={cn(
                              'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold',
                              STATUS_STYLES[i.display_status],
                            )}
                          >
                            {INVOICE_STATUS_LABELS[i.display_status]}
                          </span>
                        </span>
                      </TableCell>
                      <TableCell>
                        {i.einvoice_status === 'none' ? (
                          <span className="text-sm text-muted-foreground">—</span>
                        ) : (
                          <span
                            className={cn(
                              'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold',
                              EINVOICE_STYLES[i.einvoice_status],
                            )}
                            // The UUID a person recorded, for whoever needs to quote it.
                            title={i.einvoice_uuid ?? undefined}
                          >
                            {EINVOICE_STATUS_LABELS[i.einvoice_status]}
                          </span>
                        )}
                      </TableCell>
                      {writer ? (
                        <TableCell>
                          {items.length ? (
                            // RowMenu has no disabled prop; an inert wrapper keeps its button from being used while an action runs or a form is open.
                            <span inert={locked} className={cn(locked && 'opacity-50')}>
                              <RowMenu label={invoiceName(i)} items={items} />
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
            Showing {shown.length} of {matching.length} invoices
            {matching.length !== rows.length ? ` (${rows.length} in all)` : ''}
          </div>
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}
```

- [ ] **Step 4: Replace the screen with a loader that knows who may edit**

Replace the whole of `src/screens/finance/invoices.tsx` with:

```tsx
import {
  deleteInvoiceAction,
  getInvoiceAction,
  postInvoiceAction,
  recordPaymentInAction,
  saveAndPostInvoiceAction,
  saveInvoiceAction,
  setEInvoiceAction,
  voidInvoiceAction,
} from '@/app/(app)/finance/actions';
import { type InvoiceActions, InvoicesView } from '@/components/finance/invoices-view';
import { can } from '@/lib/auth/permissions';
import { getViewer, hasSupabaseEnv } from '@/lib/auth/viewer';
import { listContacts } from '@/lib/finance/contacts';
import { listInvoices } from '@/lib/finance/invoices';
import { listAccounts, listPaymentsIn } from '@/lib/finance/money';
import { listProducts } from '@/lib/finance/products';
import { invoicesView } from '@/lib/finance/sales-views';
import { todayUtc } from '@/lib/finance/view-helpers';
import { createClient } from '@/lib/supabase/server';
import { SAMPLE_INVOICES, SAMPLE_PAYMENTS_IN, SAMPLE_TODAY } from './sales-sample';

const ACTIONS: InvoiceActions = {
  save: saveInvoiceAction,
  saveAndPost: saveAndPostInvoiceAction,
  post: postInvoiceAction,
  voidInvoice: voidInvoiceAction,
  remove: deleteInvoiceAction,
  get: getInvoiceAction,
  recordPayment: recordPaymentInAction,
  setEInvoice: setEInvoiceAction,
};

export default async function InvoicesScreen() {
  if (!hasSupabaseEnv()) {
    return <InvoicesView rows={SAMPLE_INVOICES} view={invoicesView(SAMPLE_INVOICES, SAMPLE_PAYMENTS_IN, SAMPLE_TODAY)} />;
  }
  const viewer = await getViewer();
  const ctx = { client: await createClient(), orgId: viewer.orgId };
  const canEdit = !viewer.isDemo && can(viewer.role, 'edit-data');
  // The payments feed "Received (MTD)" and the trend for everyone. The forms offer customers, products
  // and accounts; a viewer has no form, so none of them is read for them.
  const [rows, payments, contacts, products, accounts] = await Promise.all([
    listInvoices(ctx),
    listPaymentsIn(ctx),
    canEdit ? listContacts(ctx) : [],
    canEdit ? listProducts(ctx) : [],
    canEdit ? listAccounts(ctx) : [],
  ]);
  return (
    <InvoicesView
      rows={rows}
      view={invoicesView(rows, payments, todayUtc())}
      writer={
        canEdit
          ? {
              actions: ACTIONS,
              customers: contacts.filter((c) => c.is_customer && c.active),
              products: products.filter((p) => p.active),
              accounts,
              payments,
            }
          : undefined
      }
    />
  );
}
```

- [ ] **Step 5: Type-check, lint, test and build**

Run, as separate commands: `pnpm exec tsc --noEmit`, `pnpm lint`, `pnpm exec vitest run --exclude 'tests/*.rls.test.ts' --exclude 'tests/bendahara-*.test.ts'`, `pnpm build`
Expected: no type or lint errors; every unit test passes; the build completes.

If the linter objects to `setCustomer` being called while rendering, the condition around it was removed: it must only run when `customer !== chosenCustomer`, which is false again on the very next render.

- [ ] **Step 6: Check for banned colours, names and dialogs**

Run: `git diff main -- src | grep -n -i -E "^\+.*(purple|violet|fuchsia|indigo|kuasa\.ai)"`
Expected: no output.

Run: `grep -n -E "window\.confirm|alert\(|router\.refresh" src/components/finance/invoices-view.tsx src/components/finance/invoice-form-card.tsx src/components/finance/einvoice-card.tsx src/components/finance/document-form-card.tsx`
Expected: no output.

Run: `grep -n "value=\"\"" src/components/finance/invoices-view.tsx src/components/finance/einvoice-card.tsx`
Expected: no output. No `SelectItem` has an empty value.

- [ ] **Step 7: Commit**

```bash
git add src/components/finance/invoice-form-card.tsx src/components/finance/einvoice-card.tsx src/components/finance/invoices-view.tsx src/screens/finance/invoices.tsx
git commit -m "feat: new, edit, post, pay, void and delete invoices; set an invoice's e-Invois"
```

---

### Task 7: Receivable on Customers & Suppliers

Included because it is small; see Decision 10. **The owner may drop this task.** If it is dropped, skip it whole, its documentation step included: nothing in Tasks 1 to 6 or 8 depends on it.

**Files:**
- Modify: `src/lib/finance/contacts.ts`
- Modify: `src/components/finance/contacts-view.tsx`
- Modify: `src/screens/finance/customers-suppliers.tsx`
- Modify: `docs/bendahara-backend.md`
- Create: `tests/finance-receivable.test.ts`

**Interfaces:**
- Consumes: the view `finance_invoice_totals` (columns `customer_id`, `balance`, `display_status`, `org_id`, `id`), already in the database; `contactsView`, `listBillBalances`, `BillBalance`, `FinanceContact`.
- Produces, in `@/lib/finance/contacts`: `type InvoiceBalance = { customer_id: string; balance: number; display_status: string }`; `listInvoiceBalances(ctx: FinanceWriteContext): Promise<InvoiceBalance[]>`; `contactsView(contacts: FinanceContact[], bills: BillBalance[], invoices?: InvoiceBalance[]): ContactsViewData`, where `stats.receivable` is now real; `ContactRow` gains `receivable: number`.

How Payable is worked out today, and how Receivable mirrors it:

- `listBillBalances` reads `supplier_id, balance, display_status` of every bill that is `pending` or `overdue` from `supplier_bill_totals`, a page of 1,000 at a time. `contactsView` adds the balances up per supplier, gives each contact its `payable`, and totals the card from every open bill, not only the contacts loaded.
- `listInvoiceBalances` reads `customer_id, balance, display_status` of every invoice that is `sent` or `overdue` from `finance_invoice_totals`, the same way, through one shared private function. `contactsView` takes them as a third argument that defaults to none, so every existing caller and test is unaffected.
- The table gains a Receivable column before Payable: a figure for a contact ticked Customer, a dash otherwise.
- "Largest open balances" is left as it is: its subtitle says "Suppliers you owe".

- [ ] **Step 1: Write the failing tests**

Create `tests/finance-receivable.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { type FinanceContact, contactsView, listBillBalances, listInvoiceBalances } from '@/lib/finance/contacts';
import type { FinanceWriteContext } from '@/lib/finance/result';

type Page = { data: unknown[] | null; error: unknown };
type Request = { view: string; columns: string; filters: Record<string, unknown>; within: Record<string, unknown[]>; range: [number, number] };

/** A stand-in list query: from → select → eq → in → order → range, answering one canned page per range call. */
function fakeListClient(pages: Page[]) {
  const requests: Request[] = [];
  const client = {
    from(view: string) {
      const request: Request = { view, columns: '', filters: {}, within: {}, range: [0, 0] };
      const builder = {
        select(columns: string) { request.columns = columns; return builder; },
        eq(column: string, value: unknown) { request.filters[column] = value; return builder; },
        in(column: string, values: unknown[]) { request.within[column] = values; return builder; },
        order() { return builder; },
        range(from: number, to: number) {
          request.range = [from, to];
          requests.push(request);
          return Promise.resolve(pages[requests.length - 1] ?? { data: [], error: null });
        },
      };
      return builder;
    },
  };
  return { ctx: { client: client as never, orgId: 'org-1' } satisfies FinanceWriteContext, requests };
}

const contact = (c: Partial<FinanceContact>): FinanceContact => ({
  id: 'c1',
  name: 'Aisyah Trading',
  is_customer: true,
  is_supplier: false,
  email: null,
  phone: null,
  ssm_no: null,
  tin: null,
  payment_terms_days: 30,
  active: true,
  ...c,
});

describe('listInvoiceBalances', () => {
  const invoice = (n: number) => ({ customer_id: 'c1', balance: String(n), display_status: 'sent' });

  it('reads the open invoices of the caller’s workspace from the totals view, with balances as numbers', async () => {
    const { ctx, requests } = fakeListClient([{ data: [invoice(12.5), { ...invoice(7), display_status: 'overdue' }], error: null }]);
    expect(await listInvoiceBalances(ctx)).toEqual([
      { customer_id: 'c1', balance: 12.5, display_status: 'sent' },
      { customer_id: 'c1', balance: 7, display_status: 'overdue' },
    ]);
    expect(requests).toEqual([
      {
        view: 'finance_invoice_totals',
        columns: 'customer_id, balance, display_status',
        filters: { org_id: 'org-1' },
        within: { display_status: ['sent', 'overdue'] },
        range: [0, 999],
      },
    ]);
  });
  it('keeps reading until a short page, so no invoice is left out', async () => {
    const full = Array.from({ length: 1000 }, (_, i) => invoice(i + 1));
    const { ctx, requests } = fakeListClient([{ data: full, error: null }, { data: [invoice(5)], error: null }]);
    const rows = await listInvoiceBalances(ctx);
    expect(requests.map((r) => r.range)).toEqual([[0, 999], [1000, 1999]]);
    expect(rows).toHaveLength(1001);
    expect(rows.every((r) => typeof r.balance === 'number')).toBe(true);
  });
  it('throws a database error instead of swallowing it', async () => {
    const failure = { code: 'XX000', message: 'boom' };
    const { ctx } = fakeListClient([{ data: null, error: failure }]);
    await expect(listInvoiceBalances(ctx)).rejects.toBe(failure);
  });
  it('leaves the bills read as it was: its own view, its own column, its own statuses', async () => {
    const { ctx, requests } = fakeListClient([{ data: [], error: null }]);
    expect(await listBillBalances(ctx)).toEqual([]);
    expect(requests[0]).toMatchObject({
      view: 'supplier_bill_totals',
      columns: 'supplier_id, balance, display_status',
      within: { display_status: ['pending', 'overdue'] },
    });
  });
});

describe('contactsView with invoices', () => {
  const aisyah = contact({});
  const both = contact({ id: 'b1', name: 'Lim Hardware Sdn Bhd', is_supplier: true });
  const archived = contact({ id: 'c2', name: 'Old Customer', active: false });
  const bills = [{ supplier_id: 'b1', balance: 300, display_status: 'pending' }];
  const invoices = [
    { customer_id: 'c1', balance: 2499.9, display_status: 'sent' },
    { customer_id: 'c1', balance: 0.1, display_status: 'overdue' },
    { customer_id: 'c1', balance: 780.4, display_status: 'draft' },
    { customer_id: 'c1', balance: 0, display_status: 'paid' },
    { customer_id: 'c1', balance: 999, display_status: 'void' },
    { customer_id: 'b1', balance: 120, display_status: 'sent' },
    { customer_id: 'c2', balance: 50, display_status: 'overdue' },
  ];

  it('sums what customers owe on sent and overdue invoices only, to the sen', () => {
    const view = contactsView([aisyah, both, archived], bills, invoices);
    expect(view.stats).toEqual({ customers: 2, suppliers: 1, receivable: 2670, payable: 300 });
  });
  it('gives each contact its receivable beside its payable, including an archived one and one that is both', () => {
    const view = contactsView([aisyah, both, archived], bills, invoices);
    expect(Object.fromEntries(view.rows.map((r) => [r.id, [r.receivable, r.payable]]))).toEqual({
      c1: [2500, 0],
      b1: [120, 300],
      c2: [50, 0],
    });
  });
  it('counts a receivable from a customer that is not among the loaded contacts', () => {
    const view = contactsView([aisyah], [], [...invoices, { customer_id: 'not-loaded', balance: 10, display_status: 'sent' }]);
    expect(view.stats.receivable).toBe(2680);
  });
  it('is 0 with no invoices, and when none are given', () => {
    expect(contactsView([aisyah], bills, []).stats.receivable).toBe(0);
    const view = contactsView([aisyah], bills);
    expect(view.stats.receivable).toBe(0);
    expect(view.rows[0].receivable).toBe(0);
  });
  it('leaves the largest-balances chart to what is owed to suppliers', () => {
    expect(contactsView([aisyah, both], bills, invoices).topBalances).toEqual([{ label: 'Lim Hardware Sdn Bhd', balance: 300 }]);
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm exec vitest run tests/finance-receivable.test.ts`
Expected: FAIL, 7 of 9 tests: `listInvoiceBalances is not a function` three times, and the four `contactsView` tests that expect a receivable get 0 or `undefined`. The two that pass already are the ones that pin what must not change: the bills read, and the largest-balances chart.

- [ ] **Step 3: Read the invoice balances and add them up**

Three edits to `src/lib/finance/contacts.ts`.

In `src/lib/finance/contacts.ts`, replace:

```ts
export type BillBalance = { supplier_id: string; balance: number; display_status: string };

/** Bills read per request; the database caps one response, so we page. */
export const BILL_PAGE_SIZE = 1000;

/**
 * What is still owed on each supplier bill, for the Payable figures. Reads
 * every open bill, a page at a time, so the money figures are never cut short.
 */
export async function listBillBalances(ctx: FinanceWriteContext): Promise<BillBalance[]> {
  const bills: BillBalance[] = [];
  for (let from = 0; ; from += BILL_PAGE_SIZE) {
    const { data, error } = await ctx.client
      .from('supplier_bill_totals')
      .select('supplier_id, balance, display_status')
      .eq('org_id', ctx.orgId)
      .in('display_status', ['pending', 'overdue'])
      .order('id', { ascending: true })
      .range(from, from + BILL_PAGE_SIZE - 1);
    if (error) throw error;
    const page = data ?? [];
    for (const row of page) bills.push({ ...row, balance: Number(row.balance) } as BillBalance);
    if (page.length < BILL_PAGE_SIZE) return bills;
  }
}
```

with:

```ts
export type BillBalance = { supplier_id: string; balance: number; display_status: string };
export type InvoiceBalance = { customer_id: string; balance: number; display_status: string };

/** Bills or invoices read per request; the database caps one response, so we page. */
export const BILL_PAGE_SIZE = 1000;

/** Every open document of one totals view with its balance as a number, read a page at a time so no figure is cut short. */
async function listOpenBalances<T extends { balance: number }>(
  ctx: FinanceWriteContext,
  view: 'supplier_bill_totals' | 'finance_invoice_totals',
  columns: string,
  open: string[],
): Promise<T[]> {
  const balances: T[] = [];
  for (let from = 0; ; from += BILL_PAGE_SIZE) {
    const { data, error } = await ctx.client
      .from(view)
      .select(columns)
      .eq('org_id', ctx.orgId)
      .in('display_status', open)
      .order('id', { ascending: true })
      .range(from, from + BILL_PAGE_SIZE - 1);
    if (error) throw error;
    const page = (data ?? []) as unknown as Record<string, unknown>[];
    for (const row of page) balances.push({ ...row, balance: Number(row.balance) } as unknown as T);
    if (page.length < BILL_PAGE_SIZE) return balances;
  }
}

/**
 * What is still owed on each supplier bill, for the Payable figures. Reads
 * every open bill, a page at a time, so the money figures are never cut short.
 */
export async function listBillBalances(ctx: FinanceWriteContext): Promise<BillBalance[]> {
  return listOpenBalances<BillBalance>(ctx, 'supplier_bill_totals', 'supplier_id, balance, display_status', ['pending', 'overdue']);
}

/**
 * What customers still owe on each posted invoice, for the Receivable
 * figures: the invoices that are "Sent" or "Overdue", read the same way.
 */
export async function listInvoiceBalances(ctx: FinanceWriteContext): Promise<InvoiceBalance[]> {
  return listOpenBalances<InvoiceBalance>(ctx, 'finance_invoice_totals', 'customer_id, balance, display_status', ['sent', 'overdue']);
}
```

In `src/lib/finance/contacts.ts`, replace:

```ts
export type ContactRow = FinanceContact & { payable: number };
```

with:

```ts
export type ContactRow = FinanceContact & { payable: number; receivable: number };
```

In `src/lib/finance/contacts.ts`, replace:

```ts
/**
 * Receivable stays 0 until invoices exist (the sales stage). Payable counts
 * bills that are pending or overdue; an archived supplier still owes what it owes.
 */
export function contactsView(contacts: FinanceContact[], bills: BillBalance[]): ContactsViewData {
  const owed = new Map<string, number>();
  for (const bill of bills) {
    if (bill.display_status !== 'pending' && bill.display_status !== 'overdue') continue;
    owed.set(bill.supplier_id, (owed.get(bill.supplier_id) ?? 0) + bill.balance);
  }
  const rows = [...contacts]
    .sort((x, y) => x.name.localeCompare(y.name))
    .map((c) => ({ ...c, payable: round2(owed.get(c.id) ?? 0) }));
  const active = rows.filter((c) => c.active);
  return {
    stats: {
      customers: active.filter((c) => c.is_customer).length,
      suppliers: active.filter((c) => c.is_supplier).length,
      receivable: 0,
      payable: round2([...owed.values()].reduce((sum, v) => sum + v, 0)),
    },
```

with:

```ts
/**
 * Payable counts bills that are pending or overdue; Receivable counts
 * invoices that are sent or overdue. An archived contact still owes, and is
 * still owed, what it was. Both cards are totalled from every open document,
 * not only the contacts loaded.
 */
export function contactsView(
  contacts: FinanceContact[],
  bills: BillBalance[],
  invoices: InvoiceBalance[] = [],
): ContactsViewData {
  const owed = new Map<string, number>();
  for (const bill of bills) {
    if (bill.display_status !== 'pending' && bill.display_status !== 'overdue') continue;
    owed.set(bill.supplier_id, (owed.get(bill.supplier_id) ?? 0) + bill.balance);
  }
  const due = new Map<string, number>();
  for (const invoice of invoices) {
    if (invoice.display_status !== 'sent' && invoice.display_status !== 'overdue') continue;
    due.set(invoice.customer_id, (due.get(invoice.customer_id) ?? 0) + invoice.balance);
  }
  const rows = [...contacts]
    .sort((x, y) => x.name.localeCompare(y.name))
    .map((c) => ({ ...c, payable: round2(owed.get(c.id) ?? 0), receivable: round2(due.get(c.id) ?? 0) }));
  const active = rows.filter((c) => c.active);
  return {
    stats: {
      customers: active.filter((c) => c.is_customer).length,
      suppliers: active.filter((c) => c.is_supplier).length,
      receivable: round2([...due.values()].reduce((sum, v) => sum + v, 0)),
      payable: round2([...owed.values()].reduce((sum, v) => sum + v, 0)),
    },
```

- [ ] **Step 4: Show the column**

Three edits to `src/components/finance/contacts-view.tsx`.

In `src/components/finance/contacts-view.tsx`, replace:

```tsx
  const columns = actions ? 8 : 7;
```

with:

```tsx
  const columns = actions ? 9 : 8;
```

In `src/components/finance/contacts-view.tsx`, replace:

```tsx
                  <TableHead className="text-right">Payable</TableHead>
```

with:

```tsx
                  <TableHead className="text-right">Receivable</TableHead>
                  <TableHead className="text-right">Payable</TableHead>
```

In `src/components/finance/contacts-view.tsx`, replace:

```tsx
                      <TableCell className="whitespace-nowrap text-right tabular-nums">
                        {c.is_supplier ? rm(c.payable) : '—'}
                      </TableCell>
```

with:

```tsx
                      <TableCell className="whitespace-nowrap text-right tabular-nums">
                        {c.is_customer ? rm(c.receivable) : '—'}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right tabular-nums">
                        {c.is_supplier ? rm(c.payable) : '—'}
                      </TableCell>
```

- [ ] **Step 5: Read them in the loader, and give the sample some**

Three edits to `src/screens/finance/customers-suppliers.tsx`. The sample ids `'1'`, `'3'` and `'5'` are the sample's three active customers.

In `src/screens/finance/customers-suppliers.tsx`, replace:

```tsx
  type BillBalance,
  type FinanceContact,
  contactsView,
  listBillBalances,
  listContacts,
} from '@/lib/finance/contacts';
```

with:

```tsx
  type BillBalance,
  type FinanceContact,
  type InvoiceBalance,
  contactsView,
  listBillBalances,
  listContacts,
  listInvoiceBalances,
} from '@/lib/finance/contacts';
```

In `src/screens/finance/customers-suppliers.tsx`, replace:

```tsx
const ACTIONS: ContactActions = {
```

with:

```tsx
const SAMPLE_INVOICES: InvoiceBalance[] = [
  { customer_id: '1', balance: 1240, display_status: 'sent' },
  { customer_id: '3', balance: 2500, display_status: 'sent' },
  { customer_id: '5', balance: 8900, display_status: 'overdue' },
];

const ACTIONS: ContactActions = {
```

In `src/screens/finance/customers-suppliers.tsx`, replace:

```tsx
    return <ContactsView view={contactsView(SAMPLE_CONTACTS, SAMPLE_BILLS)} />;
  }
  const viewer = await getViewer();
  const ctx = { client: await createClient(), orgId: viewer.orgId };
  const [contacts, bills] = await Promise.all([listContacts(ctx), listBillBalances(ctx)]);
  const canEdit = !viewer.isDemo && can(viewer.role, 'edit-data');
  return <ContactsView view={contactsView(contacts, bills)} actions={canEdit ? ACTIONS : undefined} />;
```

with:

```tsx
    return <ContactsView view={contactsView(SAMPLE_CONTACTS, SAMPLE_BILLS, SAMPLE_INVOICES)} />;
  }
  const viewer = await getViewer();
  const ctx = { client: await createClient(), orgId: viewer.orgId };
  const [contacts, bills, invoices] = await Promise.all([
    listContacts(ctx),
    listBillBalances(ctx),
    listInvoiceBalances(ctx),
  ]);
  const canEdit = !viewer.isDemo && can(viewer.role, 'edit-data');
  return <ContactsView view={contactsView(contacts, bills, invoices)} actions={canEdit ? ACTIONS : undefined} />;
```

- [ ] **Step 6: Run the tests**

Run: `pnpm exec vitest run tests/finance-receivable.test.ts tests/finance-contacts.test.ts`
Expected: PASS, both files; 9 tests in `finance-receivable`. `finance-contacts` was not edited: with no invoices given, Receivable is 0 and Payable is as it was.

- [ ] **Step 7: Say so in the backend note**

Three edits to `docs/bendahara-backend.md`, all under "Known limits".

In `docs/bendahara-backend.md`, replace:

```markdown
- Receivable on Customers & Suppliers is still 0: that screen does not read
  invoices yet.
```

with:

```markdown
- "Largest open balances" on Customers & Suppliers charts what is owed to
  suppliers only; Receivable is in the card, the donut and the table.
```

In `docs/bendahara-backend.md`, replace:

```markdown
  Only the contact list is capped this way: a contact's Payable is read by
  paging through every open bill, 1,000 at a time, so it is never cut short.
```

with:

```markdown
  Only the contact list is capped this way: a contact's Payable is read by
  paging through every open bill, and its Receivable through every open
  invoice, 1,000 at a time, so neither is cut short.
```

In `docs/bendahara-backend.md`, replace:

```markdown
- A contact's Payable counts bills that are pending or overdue, and the
  Payable card is totalled from every open bill, not only the contacts loaded.
```

with:

```markdown
- A contact's Payable counts bills that are pending or overdue, and the
  Payable card is totalled from every open bill, not only the contacts loaded.
  Receivable is the same for invoices that are sent or overdue.
```

- [ ] **Step 8: Type-check, lint, test, build and commit**

Run, as separate commands: `pnpm exec tsc --noEmit`, `pnpm lint`, `pnpm exec vitest run --exclude 'tests/*.rls.test.ts' --exclude 'tests/bendahara-*.test.ts'`, `pnpm build`
Expected: no errors; every unit test passes; the build completes.

```bash
git add src/lib/finance/contacts.ts src/components/finance/contacts-view.tsx src/screens/finance/customers-suppliers.tsx docs/bendahara-backend.md tests/finance-receivable.test.ts
git commit -m "feat: Receivable on Customers & Suppliers, from open invoices"
```

---

### Task 8: Document, verify the branch, hand back

**Files:**
- Modify: `src/config/live-screens.ts` (a comment)
- Modify: `docs/bendahara-backend.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing new.

- [ ] **Step 1: Correct the comment in `src/config/live-screens.ts`**

In `src/config/live-screens.ts`, replace:

```ts
  // Read-only so far: their forms and row actions join in the next slice.
  'finance/invoices',
```

with:

```ts
  'finance/invoices',
```

- [ ] **Step 2: Update the backend note**

Thirteen edits to `docs/bendahara-backend.md`, in the order they come in the file: the table of pure files and the paragraphs after it ("Write path"), "Money", "Invoices", "Database functions", "Error codes", then "Known limits". Each old text occurs once. They do not touch the three bullets Task 7 changed, so they apply whether or not Task 7 was done.

In `docs/bendahara-backend.md`, replace:

```markdown
| `sales-views.ts` | KPI figures, chart data, table filters, status words and CSV rows for Invoices and Payments In |
| `view-helpers.ts` | What those two share: dates, sums to the sen, the eight-month window of a trend chart, how payment methods are grouped and coloured |
```

with:

```markdown
| `sales-views.ts` | KPI figures, chart data, table filters, status words and CSV rows for Invoices and Payments In; what each row's menu offers (`invoiceActions`, `paymentInActions`); which customer the filter is on after a refresh (`customerChoice`) |
| `view-helpers.ts` | What those two share: dates, sums to the sen, the eight-month window of a trend chart, how payment methods are grouped and coloured, and the "This payment also covers …" sentence of a split payment |
```

In `docs/bendahara-backend.md`, replace:

```markdown
| `bill-form.ts` | The bill form: defaults, the due date following the supplier's terms, validation, what is sent. `savedNotPosted` words a bill that was saved as a draft but not posted |
| `payment-form.ts` | The payment form: which bills can take a payment and how much, defaults, validation, what is sent. `heldByBill` adds up what unpaid payments already hold of each bill; `keepPayable` drops a ticked bill that was paid off while the form was open |
```

with:

```markdown
| `document-form.ts` | What the bill form and the invoice form share: a line as it was typed, the due date following the other party's payment terms, the "saved as a draft, but not posted" sentence, and `DocumentFormKind`, the description of one form that the shared card draws |
| `bill-form.ts` | The bill form: defaults, the due date following the supplier's terms, validation, what is sent. A product fills a line at its cost. `savedNotPosted` words a bill that was saved as a draft but not posted |
| `invoice-form.ts` | The invoice form: the same rules with a customer and no supplier's reference. A product fills a line at its price. Also the small e-Invois form (status and UUID) |
| `allocation-form.ts` | What the two payment forms share: ticking documents, amounts added in whole sen, what payments not yet posted hold of a document, and `AllocationFormKind`, the description of one form that the shared card draws |
| `payment-form.ts` | The payment-out form: which bills can take a payment and how much, defaults, validation, what is sent. `heldByBill` adds up what unpaid payments already hold of each bill; `keepPayable` drops a ticked bill that was paid off while the form was open |
| `receipt-form.ts` | The payment-in form: which invoices can take a payment and how much (`receivableInvoices`), defaults, validation, what is sent. It has no scheduling |
```

In `docs/bendahara-backend.md`, replace:

```markdown
The forms validate by running the write's own Zod schema on what they are about
to send, so the browser and the server say the same sentences.
```

with:

```markdown
The forms validate by running the write's own Zod schema on what they are about
to send, so the browser and the server say the same sentences.

One card draws both document forms (`document-form-card.tsx`) and one draws
both payment forms (`allocation-form-card.tsx`). `BillFormCard`,
`InvoiceFormCard`, `PaymentFormCard` and `ReceiptFormCard` are thin wrappers
that hand the card their kind (`BILL_FORM_KIND`, `INVOICE_FORM_KIND`,
`PAYMENT_OUT_KIND`, `PAYMENT_IN_KIND`). A rule that differs between a bill and
an invoice, or between money out and money in, belongs in the kind, not in the
card.
```

In `docs/bendahara-backend.md`, replace:

```markdown
editing that draft. `getBillAction` reads one draft with its lines for the Edit
form. `src/app/(app)/finance/error.tsx` is shown when a finance screen's data
cannot be read.
```

with:

```markdown
editing that draft. `getBillAction` reads one draft with its lines for the Edit
form. `saveAndPostInvoiceAction` and `getInvoiceAction` do the same for an
invoice, through the same two helpers. `src/app/(app)/finance/error.tsx` is
shown when a finance screen's data cannot be read.

Every action refuses a viewer and the demo workspace before the data layer is
reached. Without that, a viewer's void or delete would come back from the
database as "no row", which reads as "That invoice no longer exists.".
```

In `docs/bendahara-backend.md`, replace:

```markdown
A bill takes only money out and an invoice only money in. Money out against an
invoice (a refund) arrives with the sales follow-ons.
```

with:

```markdown
A bill takes only money out and an invoice only money in. Money out against an
invoice (a refund) arrives with the sales follow-ons.

The payment-in form is opened from Payments In, or from "Record payment" on a
posted invoice's row with that customer chosen and that invoice ticked. It
offers a customer's invoices that are Sent or Overdue, each for its balance
less anything a payment not yet posted holds (`receivableInvoices`); through
the app nothing is ever held, as money in is posted at once.
```

In `docs/bendahara-backend.md`, replace:

```markdown
only while the invoice is posted. No function or action sets them yet.
```

with:

```markdown
only while the invoice is posted. `setEInvoice` (`setEInvoiceAction`) writes
them, from "Set e-Invois" on a posted invoice's row. The UUID is free text of
up to 100 characters; with no status there is no UUID.

What a row's menu offers follows its status (`invoiceActions`): a draft is
edited, posted or deleted; a posted invoice takes a payment while something is
still owed, has its e-Invois set, and can be voided; a void invoice offers
nothing. Voiding an invoice that has payments is offered and refused with the
reason, as on a paid bill.
```

In `docs/bendahara-backend.md`, replace:

```markdown
decide whether they are allowed. A payment in is voided by the same update as
a payment out (`voidPayment` in `money.ts`).
```

with:

```markdown
decide whether they are allowed. A payment in is voided by the same update as
a payment out, through its own function (`voidPaymentIn` in `money.ts`): it is
kept to money in, answers in the sentences of a payment in, and its action
refreshes the sales screens. A payment in has no edit and no delete.
```

In `docs/bendahara-backend.md`, replace:

```markdown
| `23514` | A check constraint refused the write. The one to know: an invoice's number must match its status (a draft has none, any other status has one, a posted invoice has `posted_at`). Only a direct write can break it; the app never does. Others include the due date before the invoice date, e-Invois set on a draft, a line's quantity, price or SST rate out of range, and an allocation naming both a bill and an invoice; `invoices.ts` has no sentence for them. |
| `23505` | A unique constraint refused the write. `invoices.ts` words it as "That invoice number is already used."; `money.ts` has no sentence for it. Through the app it does not happen for an allocation; see Known limits. |
```

with:

```markdown
| `23514` | A check constraint refused the write. The one to know: an invoice's number must match its status (a draft has none, any other status has one, a posted invoice has `posted_at`). Only a direct write can break it; the app never does. Others include the due date before the invoice date, a line's quantity, price or SST rate out of range, and an allocation naming both a bill and an invoice; `invoices.ts` has no sentence for them. One has a sentence: e-Invois set on a draft, which `setEInvoice` words as "e-Invois details can be recorded once the invoice is posted." |
| `23505` | A unique constraint refused the write. `invoices.ts` words it as "That invoice number is already used.". When a payment is recorded it can only be the same bill or invoice twice on one payment (numbers are taken under a lock), so `recordPaymentOut` and `recordPaymentIn` word it as "Each bill can appear once on a payment." and "Each invoice can appear once on a payment."; the schemas refuse it first, comparing ids without regard to capitals. |

The sentence for `FIN01` on an invoice is "This invoice has been posted or
voided, so that can no longer be done.". The row menus offer only what a
status allows, so the code reaches a person only when the invoice changed under
them, and the sentence is true of every such case, voiding an invoice that was
just voided included. `FIN09` on a payment in is "This payment has already been
voided." for the same reason. Bills and payments out still say "Void it
instead."; see Known limits.
```

In `docs/bendahara-backend.md`, replace:

```markdown
  form. A retry after a save that did land can create a second bill or a second
  part-payment, until writes carry a client-generated id.
```

with:

```markdown
  form. A retry after a save that did land can create a second bill, a second
  invoice, a second part-payment or a second receipt, until writes carry a
  client-generated id (which needs a migration).
```

In `docs/bendahara-backend.md`, replace:

```markdown
- Voiding a paid bill is offered and refused until its payments are voided.
- Posted and void bills, invoices and payments cannot be deleted, by design.
```

with:

```markdown
- Voiding a paid bill is offered and refused until its payments are voided.
  The same goes for an invoice that has payments.
- Posted and void bills, invoices and payments cannot be deleted, by design.
- A bill's `FIN01` sentence and a payment out's `FIN09` sentence end "Void it
  instead.", which is wrong when the thing just tried was a void of something
  already void. Invoices and payments in have sentences that are true in that
  case too; the purchase side was left as it shipped.
```

In `docs/bendahara-backend.md`, replace:

```markdown
- Invoices and Payments In are read-only so far: search, filters, "View all"
  and Export, but no forms and no row actions. The data layer for them is in
  `invoices.ts` and `money.ts`.
```

with:

```markdown
- A payment in cannot be edited or deleted, only voided, and a posted invoice
  only voided. To correct one, void it and record it again.
- Invoices and Payments In load every invoice and payment and filter in the
  browser, as the purchase screens do.
```

In `docs/bendahara-backend.md`, replace:

```markdown
- Nothing sets an invoice's e-Invois status yet; the columns, and the rule
  that lets them change on a posted invoice, are in place.
```

with:

```markdown
- An invoice's e-Invois status and UUID are what a person typed. Nothing checks
  them against LHDN, and the UUID's format is not checked. "Validated" does not
  require a UUID.
```

In `docs/bendahara-backend.md`, replace:

```markdown
- Paying the same invoice twice in one payment is refused by the payment
  form's schema. A direct call to `finance_record_payment_in` gets a plain
  unique-violation error (23505) rather than a sentence, unless the two
  amounts together exceed what is owed, in which case it is FIN05.
```

with:

```markdown
- Paying the same invoice twice in one payment is refused by the payment
  form's schema, whatever the capitals of the two ids. A direct call to
  `finance_record_payment_in` gets a unique violation (23505), which the data
  layer words the same way, unless the two amounts together exceed what is
  owed, in which case it is FIN05.
```

If Task 7 was dropped, the bullet "Receivable on Customers & Suppliers is still 0: that screen does not read invoices yet." is still in Known limits. Leave it there: it is still true.

- [ ] **Step 3: Run everything**

Run, as separate commands: `pnpm exec tsc --noEmit`, `pnpm lint`, `pnpm exec vitest run --exclude 'tests/*.rls.test.ts' --exclude 'tests/bendahara-*.test.ts'`, `pnpm build`
Expected: no type or lint errors; every unit test passes (128 more than on `main` with Task 7, 119 without); the build completes.

Do **not** run `pnpm test`, `tests/bendahara-*.test.ts` or `tests/*.rls.test.ts`: they write to the hosted production database. This branch changes no table, view, function or policy, so they have nothing new to check.

- [ ] **Step 4: Check the boundaries the build does not check**

Run: `grep -n "^export" "src/app/(app)/finance/actions.ts" | grep -v "export async function"`
Expected: no output. A `'use server'` file exports only async functions.

Run: `grep -l -E "supabase/server|next/headers" src/lib/finance/*.ts src/screens/finance/sales-sample.ts`
Expected: no output.

Run: `git diff main -- src | grep -n -i -E "^\+.*(purple|violet|fuchsia|indigo|kuasa)"`
Expected: no output.

Run: `grep -rn -E "window\.confirm|alert\(|router\.refresh" src/components/finance src/screens/finance/invoices.tsx src/screens/finance/payments-in.tsx`
Expected: no output.

Run: `git diff main --stat -- supabase`
Expected: no output. There is no migration in this stage.

Run: `git diff main --stat -- tests/finance-bill-form.test.ts tests/finance-payment-form.test.ts tests/finance-bill-math.test.ts tests/finance-bills.test.ts tests/finance-money.test.ts tests/finance-actions.test.ts tests/finance-purchase-views.test.ts tests/finance-touchups.test.ts tests/finance-shared.test.ts`
Expected: no output. The purchase side's tests, and the tests of what the two sides share, were not edited.

- [ ] **Step 5: Commit**

```bash
git add src/config/live-screens.ts docs/bendahara-backend.md
git commit -m "docs: the invoice and payment-in forms"
```

- [ ] **Step 6: Hand back**

Do not push. Report what was built, the result of the four commands in Step 3, whether Task 7 was done, and anything that had to differ from this plan. The controller pushes and opens the PR (title `feat-106-bendahara-invoice-forms`, no close keyword in the body) when the owner says so.

---

## Controller: production smoke test after the merge

Not a task for an implementer. Run on `https://openkuasa.com` after the merge has deployed, in the Chrome session that is already signed in as the smoke account `smoke@openkuasa-test.dev`, workspace "Smoke Test Co" (`~/.config/openkuasa/smoke-account.json`). **The tester never types a password.** If the session is signed out, stop and ask the owner to sign in. After each navigation wait and take a screenshot before clicking: a background tab stays on the loading skeleton.

Everything below is created in the smoke workspace. Posted and void invoices and payments cannot be deleted, by design, so the records this test posts stay there. Name them so they are recognisable, and reuse the same customer and product on later runs rather than adding new ones.

1. **Open.** `/finance/invoices` and `/finance/payments-in` load with no work-in-progress banner. Both show "New Invoice" / "Record Payment", a "⋯" on each row that has actions, and an Export button.
2. **Customer and product.** On Customers & Suppliers add a customer named `=Smoke 3b, Customer 林` (ticked Customer, payment terms 14). On Products add "Smoke 3b Gloves": unit `box`, price 24.90, cost 12.50, SST 6. (If they exist from an earlier run, reuse them.)
3. **Draft invoice with two lines.** New Invoice. The card has Customer, Invoice date and Due date, and no "Supplier's reference". Choose the customer: the due date becomes the invoice date + 14 days. Line 1: choose the product; description, unit, unit price **24.9** (the price, not the cost 12.5) and SST 6 fill in; set Qty 10. Press "Add line": focus is in the new line's Description. Line 2: "Delivery", Qty 1, unit price 20. The totals read Subtotal RM 269.00, SST RM 14.94, Total RM 283.94. Press Enter inside a quantity box: nothing is saved. "Save draft": the card closes; the invoice is in the table as Draft with "—" for its number and for its Balance, Total RM 283.94.
4. **Edit it.** "⋯" offers Edit, Post, Delete and nothing else. Edit: "Loading…", then the form with both lines in the order they were entered. While it is open, "New Invoice" is disabled and the other rows' "⋯" do nothing. Change line 1's Qty to 20: Total RM 547.88. "Save draft". The row shows RM 547.88.
5. **Post it.** "⋯" → Post: the question is not red, names the customer and the total, and focus is on Cancel; Escape closes it. Open it again and confirm. The row gets an `INV-` number and becomes Sent, Balance RM 547.88. "Total receivable" has gone up by RM 548.
6. **Record part of it.** "⋯" now offers Record payment, Set e-Invois, Void. Record payment: the payment card opens at the top of the Invoices screen with the customer chosen and this invoice ticked for 547.88. It says "Paid into" and "Date received", and has no "Schedule for later". Change the amount to 100, "Record payment". The invoice's Balance is RM 447.88 and it is still Sent. On Payments In there is a Received row with an `RC-` number for RM 100.00, and "Received (MTD)" has gone up by RM 100.
7. **A comma.** On Payments In, "Record Payment": choose the customer; the invoice shows "RM 447.88 owed". Tick it and type `1,200.50` as the amount (paste it if the browser will not let it be typed): the box is empty or the form answers "Enter an amount above 0."; change the amount and the sentence goes at once. Type 447.89: "That is more than is still owed on an invoice." Cancel.
8. **Set e-Invois.** On the invoice, "⋯" → Set e-Invois. The card says nothing is submitted. With status None the UUID box is closed. Choose Pending, type `SMOKE3B0000000000000000001`, Save: the row shows a Pending badge, and hovering it shows the UUID. Open it again: it opens on Pending and that UUID. Choose Validated, Save: the badge reads Validated. Choose None: the UUID box empties and closes; Cancel (leave it Validated).
9. **A split payment, voided from its second row.** Add two more invoices for the same customer with "Save and post" (one line each, RM 50.00 and RM 30.00). On Payments In note the "Payments" figure. "Record Payment", choose the customer, tick the two new invoices only, "Record payment": two rows appear with the same `RC-` number, and "Payments" has gone up by one, not two. On the second of the two rows "⋯" offers only Void. Void: the question says "This payment also covers INV-…". Confirm. Both rows leave the default list; choosing Void in the status filter shows both, struck through, with no "⋯"; both invoices are Sent again with their full balance.
10. **Void an invoice.** On the invoice from step 6, "⋯" → Void → confirm: refused in the row with "This invoice has payments. Void them on Payments In before voiding it." Cancel: the sentence goes with the question. On Payments In void its RM 100.00 payment. Back on the invoice, Void → confirm: it becomes Void, leaves the default list, and has no "⋯" under the Void filter. Void one of the step 9 invoices too (it has no standing payments): it works first time.
11. **Two tabs.** Save a new draft. In tab A open it with Edit and change a quantity. In tab B post the same invoice. In tab A press "Save draft": the form shows "This invoice has been posted or voided, so that can no longer be done.", what was typed is still there, and the row behind the form now reads Sent. Cancel. Then, with a second draft, open tab A's list, delete the draft in tab B, and choose Edit in tab A: the card says "That invoice no longer exists." and the row has gone. Then, with the remaining step 9 invoice open in two tabs, void it in tab B and choose Void in tab A (the row still reads Sent there): the answer is "This invoice has been posted or voided, so that can no longer be done.", never "Void it instead".
12. **The customer filter.** Add a second customer "Smoke 3b Second" and save one draft invoice for them. On Invoices choose that customer in the filter: one row. Delete that draft: the filter reads "All customers" and the whole list is back. Save a new draft for the same customer: the list still shows every customer; the filter has not gone back by itself. Delete the draft.
13. **Customers & Suppliers** (skip if Task 7 was dropped). The Receivable card is no longer RM 0: it equals "Total receivable" on Invoices. The table has a Receivable column; the smoke customer's row shows what its Sent and Overdue invoices still owe; a contact that is only a supplier shows "—".
14. **Export.** On each screen press Export with the default filter, then with the status filter on Void. Open the files (`invoices-YYYY-MM-DD.csv`, `payments-in-YYYY-MM-DD.csv`): the customer reads `'=Smoke 3b, Customer 林` in one cell, no formula has run, 林 is readable, and Total, Balance and Amount are numbers that can be summed.
15. **390 px and dark mode.** At 390 px wide, in light and in dark: both screens, the new-invoice form with three lines, the payment form, and the e-Invois card. The forms do not scroll sideways; each invoice line is a card with its boxes two to a row; the payment form's amount box sits under its invoice. No purple anywhere.
16. **Supplier Bills and Payments Out still work.** New Bill: the card has "Supplier's reference", choosing a product fills the unit price from its **cost**, and "Save draft" then Delete works. On Payments Out, "Record Payment" still has "Pay now" and "Schedule for later"; Cancel.
17. **Not a writer.** In the demo workspace (or signed in as a viewer): both screens show the figures, charts, table, search, filters and Export, with no header button and no "⋯".

**What this leaves behind,** to list for the owner, who decides whether it stays:

- Contacts: `=Smoke 3b, Customer 林` and "Smoke 3b Second". Product: "Smoke 3b Gloves".
- Invoices: the three posted in steps 5 and 9, all void by the end of step 11, and the one posted in tab B in step 11 (Sent, with no payment). None can be deleted.
- Payments in: the RM 100.00 receipt and the split receipt, both void. Neither can be deleted.
- Document numbers: four `INV-` numbers and two `RC-` numbers were used.
- No draft should be left: delete any the test did not.

---

## Self-review notes

**Spec coverage for this stage.**

- Common behaviour: layout kept (the stage 3a views are extended, not redrawn); forms as cards closed by default (Tasks 5, 6); a "⋯" menu per row with the actions that apply (3, 5, 6); delete and void confirmed in the page (5, 6); search, filters, "View all" and Export unchanged; viewers get no buttons and no menus and the actions check again (4, 5, 6, with a test in 4); sample data with no actions when there is no Supabase environment (5, 6).
- Sales, Invoices: "New with line items, edit draft, post, record payment, set e-Invois status, void, delete draft" (6), with the five states. "Issue credit note" is stage 4.
- Sales, Payments In: "Record payment against one or more open invoices" (5). "Edit, delete" are replaced by Void; see Decision 3.
- Code: one schema and one function per write (2), called by actions that guard, parse, call and revalidate (4); view rules as pure functions (3); loader screens that pass actions only to writers (5, 6); shared line-items editor, document form card and allocation editor (1).
- Errors: messages beside the form with typed values kept (1, 5, 6); refusals as sentences, the spec's own example among them (2); "a record changed or removed by someone else: the form says so and reloads" (4, and the two-tab step of the smoke test).
- Testing: unit tests for every schema and every rule (1, 2, 3, 4, 7); the smoke test above. No database test is added: nothing in the database changes.

**Each thing stage 3a left to settle, and where it is settled.**

| Left by 3a | Settled in |
|---|---|
| Voiding a payment in refreshes the sales screens and uses the receipt wording | Task 2 (`voidPaymentIn`), Task 4 (`voidPaymentInAction`); tests in both |
| Duplicate ids compared without capitals; 23505 worded | Task 2, both directions; tests "the same document twice on one payment" |
| `FIN01` sentence true in every case | Task 2; test "never tells a person to void what they have just tried to void"; menus in Task 3 never offer the forbidden actions |
| `hasPayments` wording | Task 2; kept correct, now says where |
| A viewer's void reads as "no longer exists" | Task 4; test "tells a viewer they may not, not that the invoice is gone" |
| Stale customer filter | Task 3 (`customerChoice`), Task 6 (state reset) |
| The 2b lessons | Inherited from the shared cards (Task 1) and written into the two views (Tasks 5, 6); listed in Global Constraints |
| Retry after a lost response can duplicate | Not fixed; Known limits (Task 8) |

**Checked by running, not only by reading.** The plan was generated from a scratch copy of the repository, outside the working tree, in which every file was written and every edit applied; then every code block of this document was applied, task by task, to a second fresh copy by a script that reads only this file. After each task there: `tsc --noEmit` clean, `eslint` clean, the unit suite passing with the two excludes (2,519 tests on `main` when this was written; 2,543 after Task 1, 2,562 after Task 2, 2,620 after Task 3, 2,638 after Tasks 4 to 6, 2,647 after Task 7). At the end a webpack production build completed with the Supabase variables unset; the default Turbopack build cannot run from a copy with a linked `node_modules`, so `pnpm build` itself is first run by Task 1's implementer. The new and changed components were also rendered once on the server with sample props, for a viewer and for a writer, to see that they do not throw. No database was touched and no browser was used: layout at 390 px, focus movement, the Radix selects opening, the tooltip and the download are first seen in the smoke test.

**Unsure about, stated plainly.**

1. Whether resetting the customer filter during render is free of a visible flicker in every case. React re-renders at once without painting the stale state; smoke step 12 is what shows it.
2. `title` as the way to show the UUID on the badge: it does not show on touch screens. The card opened by "Set e-Invois" shows it to anyone who may edit; a viewer on a phone cannot see it.
3. "Set e-Invois" is offered on a paid invoice and on one that is overdue alike; nothing ties the status to whether LHDN has really validated it.
4. `voidPaymentIn` filters on `direction = 'in'`. A stale id of a payment out sent to it answers "That payment no longer exists.", which is not quite true, but nothing in the app sends one.
5. The Record payment choice is hidden, not disabled, on an invoice that nothing more can be taken on. Through the app that is only a paid invoice, which says Paid.
6. With the default filter, an invoice or payment that has just been voided leaves the list at once. That is what the filter says, but it can look like a deletion; the footer's "(N in all)" is the only cue. The purchase screens behave the same way.
7. The generic cards take a `kind` of about fifteen members. That is more indirection than one concrete card, and the price of not keeping two 300-line near-copies in step by hand.
