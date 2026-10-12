# Bendahara Credit Note and Refund Forms and Actions Implementation Plan (stage 4b, part 2 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The second half of stage 4b of the Bendahara CRUD spec: the live, read-only Credit Notes and Refunds screens get their forms and actions. A credit note is written against a posted invoice (one amount, a reason, notes, a date), edited while a draft, issued, voided, or deleted as a draft. A refund is recorded against an invoice whose customer is in credit or against an issued credit note, paid out now or left pending; a pending one is marked paid or deleted, a paid one voided. A posted invoice's row offers "Credit note" and, only while its customer is in credit, "Refund"; an issued credit note's row offers "Refund". With this, every screen under Sales is writable.

**Architecture:** No database migration: every write maps to a function or a plain update or delete that stage 4a shipped and unit-tested, and that nothing calls yet. A credit note and a refund fit neither shared card, so each gets a small card of its own, used on more than one screen. As in part 1, the stage is: data-layer touch-ups, pure form and menu rules with unit tests (above all the two caps, which mirror what the database allows to the sen), server actions that guard, parse, write and refresh, then the client views and their loaders.

**Tech Stack:** Next.js 16.3 App Router (server components, server actions), React 19, Tailwind v4, shadcn/Radix, Supabase Postgres with RLS, Zod 4, Vitest (node, no DOM), pnpm.

**Spec:** `docs/superpowers/specs/2026-10-10-bendahara-crud-design.md`, sections "Screens → Common behaviour", "Sales" (the Invoices, Credit Notes and Refunds rows), "Code", "Errors", "Testing"; build-order item 4, second half. Backend notes: `docs/bendahara-backend.md` (read all of it, Known limits included). Part 1: `docs/superpowers/plans/2026-10-11-bendahara-sales-followon-forms.md`, whose section "What part 2 takes" this plan answers item by item (see the self-review at the end). Stage 4a's decisions and error codes: `docs/superpowers/plans/2026-10-11-bendahara-sales-followons.md`, lines 1 to 165. What the database allows is in `supabase/migrations/20261022100000_bendahara_sales_followons.sql`, already applied; it is the law here.

## Why this is one pull request

Part 1 guessed that the whole of 4b was about twelve tasks and split it in two. Written out, part 2 is seven tasks: one more than part 1, and about the same amount of code. It does not split further on any line that leaves something whole on each side. Credit notes and refunds cannot be separated: a customer is only ever in credit because of a credit note (a payment in cannot exceed what is owed), so a refund form cannot be exercised, or smoke-tested, without the credit note form. The two choices on an invoice's row could be held back, but they are thirty lines on top of two cards that already exist by then, and "issue credit note" from an invoice is in the spec's own list for Invoices.

## Global Constraints

- **No migration.** No table, view, function, trigger or policy is created or changed. If a task seems to need a database change, stop and report it. (Decision 1 is about the one change that was considered and left out.)
- `org_id` always comes from the server-side context, never from client input.
- One Zod schema per write; messages are sentences a person can act on. This stage adds no schema: `saveCreditNoteInput`, `creditNoteIdInput` and `recordRefundInput` exist and are already in `tests/finance-schemas.test.ts`, as are `markPaymentPaidInput` and `paymentIdInput`, which a refund's id is parsed with.
- A credit note that has been issued cannot be edited or deleted, only voided; a refund that was paid out can only be voided; a draft credit note and a pending refund have no number. A row's menu offers only what the database allows for the row's status.
- Forms are cards closed by default; confirmations happen in the page (`ConfirmRow`), never `window.confirm` or `alert`; viewers and the demo workspace get no buttons and no menus, and every server action checks again, before anything is parsed or read.
- With no Supabase environment the screens show the sample and no actions.
- `src/lib/finance/*.ts` and `src/screens/finance/sales-sample.ts` import nothing server-only (`@/lib/supabase/server`, `next/headers`): client views import types and pure functions from them.
- A `'use server'` file exports only async functions: no constants, no types, no re-exports. Helpers inside it are not exported.
- Vitest runs in node with no DOM: components have no unit tests. Every rule a form or a menu follows is a pure, tested function in `src/lib/finance/`; components only draw.
- Money is shown with `rm()` from `format.ts`. Amounts typed by a person are read with `typedNumber` and never sent as strings; a figure typed with a comma is refused with a sentence.
- What the new forms and views must have from the start, as the invoice and quotation ones do: while a form is open or an action is pending, row menus are `inert` and the header button is disabled; a refusal shown in a form clears as soon as the person changes anything; every row action asks first; a refused action's message does not outlive its question; Enter inside an amount box does not submit the form; form dates default to the person's own date (`localIsoDate`) while figures use `todayUtc`; a lost response says "We could not confirm that was saved. Reload the page and check the list before trying again." (`useFinanceAction`) and nothing calls `router.refresh()` after a failed response (in Next 16.3 a failed refresh hard-navigates and loses the form); `ConfirmRow`'s confirm button stays focusable while pending so Escape still works; list containers keep `pb-24 sm:pb-24`.
- Quotations, Supplier Bills, Payments Out and Payments In behave as they do today, for everything a person can do on them. Invoices gains two choices on a posted invoice's row and nothing else on it changes. Of the existing test files, only these are edited, each for a reason given in a decision: `tests/finance-credit-notes.test.ts`, `tests/finance-refunds.test.ts`, `tests/finance-sales-rules.test.ts`. Every other test file passes unedited after every task.
- No purple, violet, indigo or fuchsia anywhere. No Kuasa names in `src/`. Icons from lucide-react only.
- `BentoCard`'s `icon` prop draws through `AnimatedIcon`, which returns nothing for a name that is not in its map. Pass `BentoCard` only these: `FileText`, `Wallet`, `Plus`, `Banknote`, `TrendingUp`, `ChartColumn`, `PieChart`. Icons inside `RowMenu`, `ConfirmRow` and buttons are plain lucide icons and are not limited.
- Radix `SelectItem` throws at runtime for `value=""`. An unchosen `Select` is `value=""` with a `SelectValue placeholder`; every item has a real value (`'open'`, `'draft'`, an id, `invoice:<id>`).
- This is Next.js 16.3. No Next API is used here beyond what the invoice and quotation screens already use: an async server component as a screen's default export, `revalidatePath` with a literal path inside the existing `'use server'` actions file, and `next/link`. `Link` is given a `ref` in one new place, as `quotations-view.tsx` already does; it passes a `ref` prop on to its `<a>` (`node_modules/next/dist/client/app-dir/link.js`). Nothing uses `useRouter`, `redirect`, `router.push` or `router.refresh()` (Decision 7). If you reach for anything else, read the matching guide in `node_modules/next/dist/docs/` first.
- pnpm only. 2-space indent, single quotes, semicolons, named exports. The only default exports are the screen files under `src/screens/finance/`.
- Every task leaves `pnpm exec tsc --noEmit`, `pnpm lint` and the unit tests green. (In a checkout that has never been built, `tsc` reports `Cannot find name 'LayoutProps'` in `src/app/layout.tsx` until `pnpm exec next typegen` has been run once. That is the checkout, not this plan. `pnpm lint` reports one warning on `main`, an unused `_p` in `tests/apply-proposal.test.ts`; it is not this plan's and stays.)
- **Unit tests are run with `pnpm exec vitest run --exclude 'tests/*.rls.test.ts' --exclude 'tests/bendahara-*.test.ts'`, or with the files named. Never bare `pnpm test`.** The Supabase variables are set in the shell, so `tests/bendahara-*.test.ts` and `tests/*.rls.test.ts` run against the hosted production database and leave a user and a workspace behind on every run. No implementer step runs them, and this plan edits none of them.
- **Implementers never call a database tool, never change the schema, and never start a dev server or a browser.** The production build in Tasks 5, 6 and 7 is run with the Supabase variables emptied on its own command line.
- Branch `feat-121-bendahara-credit-note-refund-forms` (already cut from main and checked out; work on it, do not create another). PR title equals the branch name. Do not push or merge until the owner says so.

## Not in this stage

- **Any migration**, and with it **a date for "Make invoice"** (Decision 1) and **closing the retry gap** (Decision 18).
- **Editing a refund**, pending or paid. A pending one is deleted and recorded again, as a scheduled payment to a supplier is; `finance_record_refund` has no edit.
- **Editing an issued credit note.** It is voided and a new one written.
- **Lines on a credit note, and SST on a credit note** (stage 4a, Decision 3).
- **One refund across several invoices.** One refund is against one invoice or one credit note.
- **Applying a customer's credit to another invoice.** Refund it, then record a payment in.
- **Going to Credit Notes or Refunds by itself** after a credit note or a refund is made from another screen's row. The page says where it is and links there (Decision 7).
- **Printing, PDF and email** of a credit note.
- **Refunds on Payment Vouchers.** A refund is money out and will also appear there when that screen is built (stage 5).
- **Anything on Quotations.** Part 1 finished it; its note that a draft invoice was made is left as it is drawn there.
- Approval of money (stage 5). Managing accounts (stage 6). AI tools for finance.

## Decisions this plan makes (flag to the owner at handoff)

Each is a place where the plan decides something the spec or the brief left open, goes beyond it, or differs from it. Most consequential first.

1. **"Make invoice" is left dating the new invoice with the database's UTC date: no migration here, and a small pull request of its own is recommended instead.** The brief asked for a decision. Credit notes and refunds do not have the problem: `finance_save_credit_note` and `finance_record_refund` take the date from the form, which is the person's own. `finance_convert_quotation` takes none, so before 08:00 in Malaysia a draft invoice made from a quotation is dated the day before, and due that much earlier. It is left out of this plan for three reasons. It is the only thing in the stage that would touch the database, and adding it would put this whole pull request, which is otherwise free to deploy at any time, behind the dry-run gate and a fixed order (migration first, then code). The order matters more than usual: the new code would call the function with three arguments, so a deploy that got ahead of the migration would not date an invoice wrongly, it would break "Make invoice" outright. And it belongs to quotations, which part 1 finished; a reviewer of credit notes and refunds should not have to hold it in their head. What it costs to leave: the draft is wrong by a day for anyone converting before 08:00, the note that opens says to check its date, and a person who posts without looking has an invoice dated yesterday that can only be voided. That is real, which is why the recommendation is a follow-up and not "never". What that follow-up needs, so that it can be planned as written: one migration, stamped after `20261025090000`, that in one transaction drops `public.finance_convert_quotation(uuid, uuid)` and creates `public.finance_convert_quotation(target_org uuid, target_quotation uuid, invoice_date date default null)` (a `create or replace` with a third argument would leave two functions, and the two-argument call the deployed code makes would then match both, which PostgREST refuses as ambiguous; one function with a default answers both calls, which is to be shown on the local container when that plan is written); `coalesce(invoice_date, current_date)` used for the date and for the due date alike; the revoke and grant repeated for the new signature; the function's entry in `supabase/tests/bendahara_followons_check.sql` (the list at its line 126) changed to the new signature, with one conversion that passes a date and one that does not; the controller's gate as in stage 4a (dry-run in a rolled-back transaction on the hosted database, apply on the owner's go-ahead, then compare `md5(prosrc)` of the applied function with the file's); and `convertQuotationAction` taking the person's date beside the id.
2. **Part 2 is one pull request of seven tasks.** The reasons are under "Why this is one pull request".
3. **Which screens each action refreshes: five, not the six part 1 forecast; and one screen for a draft.** Worked out per action in the table below. A credit note that is issued or voided, and a refund at any step, refresh Invoices, Payments In, Customers & Suppliers, Credit Notes and Refunds. Quotations is not among them: it names an invoice by its number and nothing a credit note or a refund does changes that. A draft credit note saved or deleted refreshes Credit Notes alone, since a draft takes nothing off its invoice. A refund looks as though it could skip Payments In and Customers & Suppliers, because it only exists while a customer is in credit and such an invoice is never receivable; it cannot, because a payment in may be voided after a refund was paid out (stage 4a, Decision 7), the invoice is then owed again with the refund in its balance, and voiding that refund changes what is receivable. Payments Out is never refreshed.
4. **Four sentences are reworded and two are added, and two test files that pin them are edited.** `CREDIT_NOTE_MESSAGES.locked` and `REFUND_MESSAGES.locked` were true of every case in 4a but read wrongly from a button: issuing a credit note someone issued a moment ago answered "…can no longer be edited or deleted", and voiding one already void answered "A draft credit note is deleted, not voided"; voiding a refund already void answered "Void a refund that has been paid out". Each now says what may have happened, in the shape part 1 gave the quotation's. `notInCredit` and `tooMuch` lose their tail "If this refund is waiting to be paid out, delete it.", which the new-refund form would have shown to someone with nothing waiting; paying a pending refund out gets its own two sentences for the same two codes (`cannotPayOut`, `creditGone`), through a second map used by `markRefundPaid` alone. The table under "What the database allows" gives each button's reachable refusals.
5. **A credit note and a refund each get a card of their own, and neither has a "kind".** The allocation card ticks many documents for one party and has an account and a method; a credit note is one invoice, one amount and a reason, and moves no money. The document card is built round lines; a credit note has none. A refund is one payment against exactly one document with a reason; the allocation card splits one payment across many and has no reason. A kind describes one of several forms that one card draws; with one form per card it would be an indirection with nothing to choose between. What is reused: `useFinanceAction`, `ConfirmRow`, `RowMenu`, `saveThenPost`, `run`, `amountText`, `defaultAccount`, `sen`, `typedNumber`, and the write schemas for validation.
6. **Edit opens a draft credit note straight from its row; there is no `getCreditNoteAction`.** A bill, an invoice and a quotation read their lines before the form opens. A credit note has none, and the list row carries every field the form shows. So there is no "Loading…" and one less action. A draft that was issued in another tab meanwhile is caught when it is saved (`FIN01`, with the sentence of Decision 4), and the list behind the form shows it as issued.
7. **A credit note or a refund made from another screen's row does not just close its form: a note at the top says it was saved and links to where it is.** This goes beyond the brief. A draft credit note made from an invoice's row changes nothing on Invoices; a pending refund changes no figure there; a refund made from a credit note's row is on Refunds. Without a word the person would see the form close and nothing happen. It is the pattern part 1 used after "Make invoice" (its Decision 2), drawn once here as `SavedNoteCard`; nothing navigates by itself, for the reasons given there. Quotations' own note is not moved onto the new component: that view is finished and is not touched.
8. **`invoiceActions` takes what the invoice can still take as an object, and a writer's Invoices page reads credit notes and refunds.** The second parameter changes from a boolean to `{ pay, credit, refund }`, which changes on purpose what `tests/finance-sales-rules.test.ts` pins for an invoice in credit (`['einvoice', 'void']` until now). Each of the three is true exactly when the form it opens would offer the invoice, so the menu never offers a refund that the form would refuse. For "Refund" that needs the refunds that are pending, and for the form's picker the credit notes: two more reads on Invoices for a person who may edit, each paged 1,000 rows at a time as the others are. A viewer has no menu and neither is read for them.
9. **The choices on an invoice's row are "Credit note" and "Refund", not "Issue credit note".** The row menu is 10 rem wide and the longer label would wrap under its icon, as "Convert to invoice" would have in part 1. It is also the truer word: the card it opens can save a draft as well as issue.
10. **The refund form has one picker that lists invoices and their credit notes together, each with what can be refunded, and choosing one fills in that amount.** From an invoice's row the refund is put against the invoice; from a credit note's row, against the note. What can be refunded is worked out by one function, `refundTargets`, as the database works it out: the customer's credit on the invoice, less refunds still pending against the invoice or any of its credit notes; and against a credit note also no more than is left of the note. The form therefore refuses a sen too much before the database is asked, and offers nothing once pending refunds hold all of the credit.
11. **The credit note form leaves the amount empty and does not count other drafts.** A credit note is seldom for everything an invoice has left, so nothing is filled in. The form offers the invoice's total less what is issued against it, as the database checks a draft; two drafts for one invoice can together exceed that, and the second to be issued is refused with the reason. Written into Known limits.
12. **A refund's menu: pending is marked as paid or deleted, paid is voided, and that is all.** No edit (see "Not in this stage"). A refund in a state the app never makes (`draft`, `pending_approval`, `rejected`) offers nothing: the database marks only a scheduled payment as paid.
13. **Every row action asks first, in the row: Issue and Mark as paid as well as Void and Delete. "Save and issue" in the form does not ask.** As with Post on an invoice and "Mark as sent" on a quotation. Only Void and Delete are red. "Mark as paid" asks for the date it was paid out, as Payments Out does.
14. **"Void" is offered on every issued credit note, and refused with the reason when a refund depends on it,** as voiding an invoice with payments is. Hiding it would need the menu to repeat the database's rule about which refunds lean on which credit.
15. **The helper for a draft's archived party covers three cards, not the two the brief named.** `bill-form-card.tsx` has the same lines as the invoice and quotation cards. All three now call `withCurrentParty`. The credit note card needs no such helper (it picks an invoice, not a customer), so there is no fourth copy.
16. **A refund still being written (`draft`) is amber,** as the pending refund it is worded and counted as. Left for this stage by part 1.
17. **`voidPaymentIn` is not changed.** Cash receipts have not arrived, so every movement of money in is still a payment in. It is to be looked at again when money in gains a second kind (stage 5); that is written into Known limits.
18. **The retry-after-lost-response limit is lived with, as in 3b and part 1.** Pressing "Save and issue" or "Record refund" again after a lost response can make a second credit note or a second refund. The caps soften it: a second credit note is refused once the two together exceed the invoice's total, and a second refund once they exceed the customer's credit, which a refund of the whole credit always does. Below the caps both go through; a draft or a pending one is deleted, an issued or a paid one voided. Closing it needs a client-made id on every write and a migration, better done once for all document tables.
19. **New tests go in new files** (`finance-current-party`, `finance-credit-note-form`, `finance-credit-note-rules`, `finance-refund-form`, `finance-refund-rules`, `finance-credit-refund-actions`); the three existing ones are edited only where they pin something this plan changes on purpose (Decisions 4 and 8).
20. **A refund's id is parsed by the schema a payment's is,** so an id that is not an id, sent to `voidRefundAction` or `deleteRefundAction`, is answered "That payment no longer exists.". Only a direct call can send one; a schema of its own for one word was not thought worth it.

## Review Focus

The cases most likely to bite a person, each pinned by a test in the task that owns the code, or by a line of the controller's smoke list where only a browser can show it.

1. **The refund form offering a sen more, or a sen less, than the database allows.** Expected: an invoice is offered for its customer's credit less pending refunds, whether those were put against the invoice or against one of its credit notes; a credit note also for no more than is left of it; a refund that was paid out is not taken off twice. (Task 3, `tests/finance-refund-form.test.ts`: "takes a pending refund off what is left, whether it was put against the invoice or against the credit note", "does not count a refund twice once it is paid out…", "caps a refund against a credit note at what is left of the note…", "caps a refund against a credit note at the invoice's credit…", "refuses a sen more than can be refunded…"; smoke steps 9, 10 and 14.)
2. **A credit note or a refund open in one tab while it is issued, paid out, voided or deleted in another.** Expected: Save, Issue, Void, Delete and Mark as paid each answer with a sentence that reads sensibly in place, what was typed stays, and the list behind shows the row as it now is. (Task 1, `tests/finance-credit-notes.test.ts`: "words FIN01 so that it reads sensibly from every button…"; `tests/finance-refunds.test.ts`: "words FIN09 so that it reads sensibly from every button…"; Task 4, `tests/finance-credit-refund-actions.test.ts`: "refreshes the screens after a refusal too…"; smoke step 16.)
3. **A viewer, or anyone in the demo workspace, calling an action directly.** Expected: "You do not have permission to make changes here.", never "That credit note no longer exists." or "That refund no longer exists.", and nothing parsed or read. (Task 4: "refuses a viewer and the demo workspace on every action, before anything is parsed, read or written", "tells a viewer they may not, not that the credit note or the refund is gone".)
4. **A pending refund whose credit has gone, because the payment in behind it was voided.** Expected: Mark as paid is refused with a sentence that says to delete it and record a new one, and the new-refund form never says "delete it". (Task 1, `tests/finance-refunds.test.ts`: "says what to do when paying a pending refund out is refused, and gives no such advice on a new refund"; smoke step 15.)
5. **An amount typed as `1,200.50`, an empty amount, and one sen more than an invoice has left to credit.** Expected: each is refused with a sentence, in the form, before the database is asked. (Task 2, `tests/finance-credit-note-form.test.ts`: "refuses an empty amount, nothing, and a figure typed with a comma", "refuses a sen more than the invoice has left to credit…"; Task 3, the same two for a refund; smoke step 4.)
6. **An invoice's row offering "Refund" when nothing can be refunded, or not offering it when something can.** Expected: offered exactly when `refundTargets` has the invoice; never while the customer owes money or is exactly settled. (Task 6, `tests/finance-sales-rules.test.ts`: "offers a refund, and no payment, on a paid invoice whose balance is below zero", "offers no refund once refunds that are pending hold all of the credit", "never offers a refund while the customer owes money or is exactly settled…"; smoke steps 7 to 10.)
7. **"Save and issue" when the draft was saved and the issue was refused.** Expected: the draft stays, the answer carries its id, the form goes on editing that draft and says "The credit note was saved as a draft, but it was not issued. …"; a second try does not save a second credit note. (Task 4: "keeps the draft when issuing is refused, and says which draft it is"; Task 2: "says the draft was kept, and why it was not issued". It needs a second credit note to be issued between the save and the issue, so no smoke step reaches it.)
8. **The bill, invoice and quotation forms after the party helper replaced their own lines.** Expected: the same picker, an archived party first. (Task 1, `tests/finance-current-party.test.ts`, and the unedited `tests/finance-bill-form.test.ts`, `tests/finance-invoice-form.test.ts`, `tests/finance-quotation-form.test.ts`; smoke step 20.)

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/finance/credit-notes.ts` | (modified) one sentence; `SaveAndIssueCreditNoteResult` |
| `src/lib/finance/refunds.ts` | (modified) three sentences reworded, two added; a second refusal map for paying a refund out |
| `src/lib/finance/document-form.ts` | (modified) `withCurrentParty` |
| `src/components/finance/bill-form-card.tsx`, `invoice-form-card.tsx`, `quotation-form-card.tsx` | (modified) use `withCurrentParty` |
| `src/lib/finance/credit-note-form.ts` | The credit note form's rules: `creditableInvoices`, defaults, validation, payload |
| `src/lib/finance/refund-form.ts` | The refund form's rules: `refundTargets`, defaults, validation, payload |
| `src/lib/finance/sales-followon-views.ts` | (modified) `creditNoteActions`, `creditNoteName`, `refundActions`, `refundName` |
| `src/lib/finance/sales-views.ts` | (modified) `invoiceActions` offers a credit note and a refund; `InvoiceCan` |
| `src/app/(app)/finance/actions.ts` | (modified) nine new actions, two path lists |
| `src/components/finance/saved-note-card.tsx` | The note that something was saved on another screen, with a link there |
| `src/components/finance/credit-note-form-card.tsx` | The credit note form |
| `src/components/finance/refund-form-card.tsx` | The refund form |
| `src/components/finance/credit-notes-view.tsx`, `refunds-view.tsx` | (rewritten) interactive client views |
| `src/components/finance/invoices-view.tsx` | (modified) two more choices on a posted invoice's row; hosts both cards |
| `src/screens/finance/credit-notes.tsx`, `refunds.tsx` | (rewritten) loaders that pass a `writer` only to people who may edit |
| `src/screens/finance/invoices.tsx` | (modified) reads credit notes and refunds for a writer; two more actions |
| `src/config/live-screens.ts`, `docs/bendahara-backend.md` | (modified) nothing under Sales is read-only; the forms, menus, sentences and limits |
| `tests/finance-current-party.test.ts`, `tests/finance-credit-note-form.test.ts`, `tests/finance-credit-note-rules.test.ts`, `tests/finance-refund-form.test.ts`, `tests/finance-refund-rules.test.ts`, `tests/finance-credit-refund-actions.test.ts` | New unit tests |
| `tests/finance-credit-notes.test.ts`, `tests/finance-refunds.test.ts`, `tests/finance-sales-rules.test.ts` | (modified) the pinned sentences; what an invoice's row offers |

Names used across tasks, spelled once here:

- New in `credit-notes.ts`: `SaveAndIssueCreditNoteResult`. Changed: `CREDIT_NOTE_MESSAGES.locked`.
- New in `refunds.ts`: `REFUND_MESSAGES.cannotPayOut`, `REFUND_MESSAGES.creditGone`. Changed: `REFUND_MESSAGES.notInCredit`, `.tooMuch`, `.locked`. `PAY_OUT_REFUSALS` is private.
- New in `document-form.ts`: `withCurrentParty`.
- From `credit-note-form.ts`: `CreditableInvoice`, `CreditNoteForm`, `creditableInvoices`, `creditableLabel`, `newCreditNoteForm`, `creditNoteFormFromRow`, `creditNotePayload`, `creditNoteFormError`, `creditNoteSavedNotIssued`.
- From `refund-form.ts`: `RefundTarget`, `RefundForm`, `invoiceTargetKey`, `noteTargetKey`, `refundTargets`, `refundTargetLabel`, `newRefundForm`, `chooseRefundTarget`, `keepRefundTarget`, `refundPayload`, `refundFormError`.
- New in `sales-followon-views.ts`: `CreditNoteAction`, `creditNoteActions`, `creditNoteName`, `RefundAction`, `refundActions`, `refundName`.
- Changed in `sales-views.ts`: `InvoiceAction` (gains `'credit'` and `'refund'`), `invoiceActions` (second parameter); new: `InvoiceCan`.
- New actions: `saveCreditNoteAction`, `issueCreditNoteAction`, `saveAndIssueCreditNoteAction`, `voidCreditNoteAction`, `deleteCreditNoteAction`, `recordRefundAction`, `markRefundPaidAction`, `voidRefundAction`, `deleteRefundAction`.
- From `saved-note-card.tsx`: `SavedNoteCard`. From `credit-note-form-card.tsx`: `CreditNoteFormCard`, `CreditNoteFormActions`. From `refund-form-card.tsx`: `RefundFormCard`, `RecordRefund`. From `credit-notes-view.tsx`: `CreditNotesView`, `CreditNoteActions`, `CreditNotesWriter`. From `refunds-view.tsx`: `RefundsView`, `RefundActions`, `RefundsWriter`.
- A credit note row's `status` is `draft`, `issued` or `void`. A refund row's `status` is a payment's: `scheduled` is worded "Pending" and `posted` "Refunded"; "pending" in this plan means `scheduled`, and also `draft` and `pending_approval` wherever the database counts those as holding credit (`isPendingRefund`). A refund row is keyed by `allocation_id`, and every action on it is sent its `transaction_id`.

## Which screens each action refreshes

An action refreshes every screen whose figures, rows or menus it can move, after any attempt that reached the database, refused or not. Worked out per action; the first three rows are new, the rest are what exists and are unchanged.

| Action | What it changes | Refreshes | Why no more, and why no less |
|---|---|---|---|
| `saveCreditNoteAction`, `deleteCreditNoteAction` | A draft credit note | Credit Notes | A draft takes nothing off its invoice, is not counted by the cap on other credit notes, and cannot be refunded against. No figure and no menu moves anywhere else. (It does stop its invoice being voided; no screen shows that until Void is pressed, and the refusal says why) |
| `issueCreditNoteAction`, `saveAndIssueCreditNoteAction`, `voidCreditNoteAction` | An invoice's `credited`, so its balance and perhaps its status | Invoices, Payments In, Customers & Suppliers, Credit Notes, Refunds | Invoices: Balance, status, Total receivable, and what the row's menu offers. Payments In: its form offers invoices by what is still owed. Customers & Suppliers: Receivable. Refunds: "In credit", and what the form offers. Not Quotations: it names an invoice by number only |
| `recordRefundAction`, `markRefundPaidAction`, `voidRefundAction`, `deleteRefundAction` | A refund; when it is or was paid out, an invoice's `refunded` and so its balance | The same five | Invoices: the Balance cell, and whether the row offers "Refund" (a pending refund changes that too). Credit Notes: Refunded, and whether a row offers "Refund". Payments In and Customers & Suppliers: usually nothing moves, because an invoice in credit is not receivable; but once a payment in has been voided after a refund was paid out, the invoice is owed again with that refund in its balance, and voiding the refund then changes what is receivable. Never Payments Out: `finance_payments_out` joins each allocation to its bill, and a refund has none |
| Quotation actions (`saveQuotationAction` … `getQuotationAction`) | A quotation | Quotations (unchanged) | |
| `convertQuotationAction` | Adds a draft invoice tied to the quotation | Quotations, Invoices (unchanged) | |
| Invoice actions; `recordPaymentInAction`, `voidPaymentInAction` | An invoice, or money in | Invoices, Payments In, Customers & Suppliers, Quotations, Credit Notes, Refunds (unchanged) | Already covers what the new screens need: a payment in voided, or an invoice voided, moves "In credit" on Refunds and what both new forms offer |
| Contact actions | A contact's name or flags | The eight screens that show a contact's name (unchanged) | |
| Bill actions; the four Payments Out actions | A bill or a payment to a supplier | Supplier Bills, Payments Out, Customers & Suppliers (unchanged) | They cannot reach a refund (part 1, Decision 4), so they never move a sales screen |
| Product actions | A product | Products (unchanged) | |

## What the database allows, and the sentence for each refusal

Nothing here is new in the database. For each button, every refusal that can reach a person through it, and the sentence they read. The sentences in bold are the ones this plan changes or adds.

The two reworded `locked` sentences, in full:

- A credit note, `FIN01`: **"That cannot be done to this credit note as it now stands. It may have been issued or voided since this page was loaded."**
- A refund, `FIN09`: **"That cannot be done to this refund as it now stands. It may have been paid out or voided since this page was loaded."**

| Button | When it can be refused | Code | Sentence |
|---|---|---|---|
| Save draft (credit note) | The draft was issued meanwhile | `FIN01` | **"That cannot be done to this credit note as it now stands…"** (was: "…A draft credit note is deleted, not voided; one that has been issued or voided can no longer be edited or deleted.", which told someone saving a draft about voiding) |
| | The draft was deleted meanwhile | `FIN11` | "That credit note no longer exists." |
| | The invoice was credited meanwhile, and the amount no longer fits | `FIN05` | "That is more than this invoice has left to credit." |
| | The invoice was voided meanwhile (a new credit note only: an invoice with a draft against it cannot be voided) | `FIN04` | "A credit note can only go against a posted invoice." |
| | The invoice is not in the workspace. Not reachable: a posted invoice cannot be deleted | `23503` | "The invoice on this credit note no longer exists." |
| Save and issue | Any of Save draft's; then, the draft saved, any of Issue's | as above and below | "The credit note was saved as a draft, but it was not issued. " and that sentence |
| Issue (row) | It was issued meanwhile | `FIN01` | **"That cannot be done to this credit note as it now stands…"** (was: "…can no longer be edited or deleted", to someone who pressed Issue) |
| | It was deleted meanwhile | `FIN11` | "That credit note no longer exists." |
| | Another credit note for the invoice was issued meanwhile, and this one no longer fits | `FIN05` | "That is more than this invoice has left to credit." |
| Void (credit note) | It was voided meanwhile | `FIN01` | **"That cannot be done to this credit note as it now stands…"** (was: "A draft credit note is deleted, not voided…", of a credit note that was never a draft in that tab) |
| | A refund, pending or paid, is against it; or the refunds on its invoice would not fit in the customer's credit without it | `FIN02` | "A refund depends on this credit note. Void or delete that refund on Refunds before voiding it." (unchanged; true of both cases) |
| Delete (credit note) | It was issued meanwhile | `FIN01` | **"That cannot be done to this credit note as it now stands…"** |
| | It was deleted meanwhile | no row | "That credit note no longer exists." |
| Record refund, Save as pending | The customer is no longer in credit on the invoice (it was refunded in another tab, or the payment in was voided), or the credit note was voided meanwhile | `FIN04` | **"A refund needs a posted invoice, or an issued credit note, whose customer is in credit."** (was: the same, then "If this refund is waiting to be paid out, delete it.", in a form where nothing is waiting) |
| | Another refund was recorded meanwhile, and the amount no longer fits in the credit or in what is left of the credit note | `FIN05` | **"That is more than the customer is in credit, or more than is left of the credit note."** (was: the same, with the same tail) |
| | The invoice or the credit note is not in the workspace. Not reachable: neither can be deleted once posted or issued | `FIN06` | "The invoice or credit note for this refund no longer exists." |
| | The account is not in the workspace. Not reachable: accounts cannot be deleted yet | `23503` | "The account on this refund no longer exists." |
| Mark as paid | It was paid out meanwhile | `FIN09` | **"That cannot be done to this refund as it now stands…"** (was: "…Void a refund that has been paid out, or delete one that is still waiting to be paid out.", to someone who pressed Mark as paid) |
| | It was deleted meanwhile | none (the view has no row) | "That refund no longer exists." |
| | The credit it was recorded against has gone since: the payment in behind it was voided | `FIN05` | **"This refund no longer fits in what the customer is in credit, or in what is left of its credit note, so it cannot be paid out. Delete it, and record a new one for what is left."** (new; `markRefundPaid` only) |
| | Its invoice is no longer posted, or its credit note no longer issued. Not reachable through the app: both are refused while a refund stands | `FIN04` | **"This refund can no longer be paid out: its invoice is no longer posted, or its credit note is no longer issued. Delete it."** (new; `markRefundPaid` only) |
| | The date box was emptied | none (the schema) | "Enter a valid date." |
| Void (refund) | It was voided meanwhile | `FIN09` | **"That cannot be done to this refund as it now stands…"** (was: "…Void a refund that has been paid out…", of one that already was) |
| Delete (refund) | It was paid out meanwhile | `FIN09` | **"That cannot be done to this refund as it now stands…"** |
| | It was deleted meanwhile | none (the view has no row) | "That refund no longer exists." |
| Void (invoice), unchanged | It has a payment or a refund; it has a credit note that is a draft or issued | `FIN02`, `FIN12` | "This invoice has payments or refunds. …", "This invoice has credit notes. Void them on Credit Notes, or delete the drafts, before voiding it." (now reachable by a real workspace for the first time; checked in smoke step 12) |
| Save draft, Record refund | Row-level security refused a new row although the action's own check passed. Not expected: both read the same membership | `42501` | "You do not have permission to make changes here." |
| Any of them, by a viewer or in the demo workspace | The action refuses before the database is asked | none | "You do not have permission to make changes here." |

A draft credit note can be edited, issued and deleted. An issued one can be voided, unless a refund depends on it, and nothing else about it changes. A pending refund can be marked as paid or deleted. A refund that was paid out can be voided, always. A void credit note or refund offers nothing.

---


### Task 1: Data-layer touch-ups: sentences that read rightly from their buttons, the answer to "Save and issue", one party helper

Nothing a person can do changes yet. The credit note and refund sentences for a document that changed in another tab are made to read sensibly from each button that will reach them; paying a pending refund out gets its own two sentences, so the new-refund form no longer tells anyone to delete a refund that does not exist; and the lines that put an archived customer or supplier first in a form's picker, written out three times, become one tested function.

**Files:**
- Modify: `src/lib/finance/credit-notes.ts`
- Modify: `src/lib/finance/refunds.ts`
- Modify: `src/lib/finance/document-form.ts`
- Modify: `src/components/finance/bill-form-card.tsx`, `src/components/finance/invoice-form-card.tsx`, `src/components/finance/quotation-form-card.tsx`
- Modify: `tests/finance-credit-notes.test.ts`, `tests/finance-refunds.test.ts`
- Create: `tests/finance-current-party.test.ts`

**Interfaces:**
- Consumes: `FinResult` from `@/lib/finance/result`; `DocumentParty` from `@/lib/finance/document-form`; the stand-in client `fakeFinance` from `tests/setup/fake-finance.ts`.
- Produces:
  - `@/lib/finance/credit-notes`: `CREDIT_NOTE_MESSAGES.locked` (reworded); `type SaveAndIssueCreditNoteResult = FinResult<{ id: string; credit_note_no: string }> & { draftId?: string }`.
  - `@/lib/finance/refunds`: `REFUND_MESSAGES.notInCredit`, `.tooMuch`, `.locked` (reworded); `REFUND_MESSAGES.cannotPayOut`, `.creditGone` (new, answered only by `markRefundPaid`). No signature changes.
  - `@/lib/finance/document-form`: `withCurrentParty(parties: DocumentParty[], current?: { id: string; name: string }): DocumentParty[]`.

What each sentence is for is in the table "What the database allows, and the sentence for each refusal" near the top of this plan.

- [ ] **Step 1: Write the failing tests**

Two existing tests in each of two files pin the old sentences; they are replaced. One new file pins the helper.

In `tests/finance-credit-notes.test.ts`, replace:

```ts
  it('tells a person a draft credit note is deleted, not voided (FIN01)', async () => {
    const { ctx } = fakeFinance({ data: null, error: { code: 'FIN01' } });
    const result = await voidCreditNote(ctx, { id: ID });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.error).toContain('A draft credit note is deleted, not voided');
      expect(result.error).not.toContain('has been issued or voided, so');
    }
  });
```

with:

```ts
  it('words FIN01 so that it reads sensibly from every button that can meet it: Save, Issue, Void and Delete', async () => {
    const sentence =
      'That cannot be done to this credit note as it now stands. It may have been issued or voided since this page was loaded.';
    const { ctx } = fakeFinance({ data: null, error: { code: 'FIN01' } });
    // Save and Delete on a draft that was issued in another tab; Issue on one issued a moment ago; Void on one already void.
    expect(await saveCreditNote(ctx, { ...valid, id: ID })).toEqual({ ok: false, error: sentence });
    expect(await issueCreditNote(ctx, { id: ID })).toEqual({ ok: false, error: sentence });
    expect(await voidCreditNote(ctx, { id: ID })).toEqual({ ok: false, error: sentence });
    expect(await deleteCreditNote(ctx, { id: ID })).toEqual({ ok: false, error: sentence });
    // It gives no advice, because no advice is right from all four: "deleted, not voided" was wrong from Issue and from a second Void.
    expect(sentence).not.toMatch(/deleted, not voided|edited or deleted/);
  });
```

In `tests/finance-credit-notes.test.ts`, replace:

```ts
      ['FIN01', 'That cannot be done to this credit note as it stands. A draft credit note is deleted, not voided; one that has been issued or voided can no longer be edited or deleted.'],
```

with:

```ts
      ['FIN01', 'That cannot be done to this credit note as it now stands. It may have been issued or voided since this page was loaded.'],
```

In `tests/finance-refunds.test.ts`, replace:

```ts
  it('turns each database refusal into a sentence about a refund', async () => {
    const cases: [string, string][] = [
      ['FIN04', 'A refund needs a posted invoice, or an issued credit note, whose customer is in credit. If this refund is waiting to be paid out, delete it.'],
      ['FIN05', 'That is more than the customer is in credit, or more than is left of the credit note. If this refund is waiting to be paid out, delete it.'],
      ['FIN06', 'The invoice or credit note for this refund no longer exists.'],
      ['FIN09', 'That cannot be done to this refund as it stands. Void a refund that has been paid out, or delete one that is still waiting to be paid out.'],
      ['FIN11', 'That refund no longer exists.'],
      ['23503', 'The account on this refund no longer exists.'],
      ['42501', 'You do not have permission to make changes here.'],
      ['22003', 'That amount is too large.'],
    ];
    for (const [code, message] of cases) {
      const { ctx } = fakeFinance(refundOr(true, { data: null, error: { code } }));
      expect(await recordRefund(ctx, valid), code).toEqual({ ok: false, error: message });
      expect(await markRefundPaid(ctx, { id: TXN, paid_on: '2026-10-09' }), code).toEqual({ ok: false, error: message });
      expect(await voidRefund(ctx, { id: TXN }), code).toEqual({ ok: false, error: message });
      expect(await deleteRefund(ctx, { id: TXN }), code).toEqual({ ok: false, error: message });
    }
    expect(logged).not.toHaveBeenCalled();
  });
  it('tells a person a refund never paid out is deleted, and what to do when paying one out is refused (FIN09, FIN04, FIN05)', async () => {
    const voidPending = fakeFinance(refundOr(true, { data: null, error: { code: 'FIN09' } }));
    const voided = await voidRefund(voidPending.ctx, { id: TXN });
    expect(voided).toMatchObject({ ok: false });
    if (!voided.ok) expect(voided.error).toContain('delete one that is still waiting to be paid out');
    for (const code of ['FIN04', 'FIN05']) {
      const { ctx } = fakeFinance(refundOr(true, { data: null, error: { code } }));
      const paid = await markRefundPaid(ctx, { id: TXN, paid_on: '2026-10-09' });
      expect(paid, code).toMatchObject({ ok: false });
      if (!paid.ok) expect(paid.error, code).toContain('delete it');
    }
    const { ctx } = fakeFinance(refundOr(true, { data: null, error: { code: 'FIN05' } }));
    const over = await recordRefund(ctx, valid);
    expect(over).toMatchObject({ ok: false });
    if (!over.ok) expect(over.error).toContain('left of the credit note');
  });
```

with:

```ts
  it('turns each database refusal into a sentence about a refund', async () => {
    const cases: [string, string][] = [
      ['FIN04', 'A refund needs a posted invoice, or an issued credit note, whose customer is in credit.'],
      ['FIN05', 'That is more than the customer is in credit, or more than is left of the credit note.'],
      ['FIN06', 'The invoice or credit note for this refund no longer exists.'],
      ['FIN09', 'That cannot be done to this refund as it now stands. It may have been paid out or voided since this page was loaded.'],
      ['FIN11', 'That refund no longer exists.'],
      ['23503', 'The account on this refund no longer exists.'],
      ['42501', 'You do not have permission to make changes here.'],
      ['22003', 'That amount is too large.'],
    ];
    for (const [code, message] of cases) {
      const { ctx } = fakeFinance(refundOr(true, { data: null, error: { code } }));
      expect(await recordRefund(ctx, valid), code).toEqual({ ok: false, error: message });
      expect(await voidRefund(ctx, { id: TXN }), code).toEqual({ ok: false, error: message });
      expect(await deleteRefund(ctx, { id: TXN }), code).toEqual({ ok: false, error: message });
      // Paying a pending refund out has its own sentences for the two codes that mean its credit has gone.
      if (code !== 'FIN04' && code !== 'FIN05') {
        expect(await markRefundPaid(ctx, { id: TXN, paid_on: '2026-10-09' }), code).toEqual({ ok: false, error: message });
      }
    }
    expect(logged).not.toHaveBeenCalled();
  });
  it('says what to do when paying a pending refund out is refused, and gives no such advice on a new refund', async () => {
    const paidOut = (code: string) =>
      markRefundPaid(fakeFinance(refundOr(true, { data: null, error: { code } })).ctx, { id: TXN, paid_on: '2026-10-09' });
    // The payment in behind the credit was voided while the refund waited.
    expect(await paidOut('FIN05')).toEqual({
      ok: false,
      error:
        'This refund no longer fits in what the customer is in credit, or in what is left of its credit note, so it cannot be paid out. Delete it, and record a new one for what is left.',
    });
    expect(await paidOut('FIN04')).toEqual({
      ok: false,
      error: 'This refund can no longer be paid out: its invoice is no longer posted, or its credit note is no longer issued. Delete it.',
    });
    // The new-refund form meets the same two codes with nothing waiting: nobody is told to delete a refund that does not exist.
    for (const code of ['FIN04', 'FIN05']) {
      const { ctx } = fakeFinance(refundOr(true, { data: null, error: { code } }));
      const recorded = await recordRefund(ctx, valid);
      expect(recorded, code).toMatchObject({ ok: false });
      if (!recorded.ok) expect(recorded.error, code).not.toMatch(/delete|waiting/i);
    }
  });
  it('words FIN09 so that it reads sensibly from every button that can meet it: Mark as paid, Void and Delete', async () => {
    const sentence = 'That cannot be done to this refund as it now stands. It may have been paid out or voided since this page was loaded.';
    const { ctx } = fakeFinance(refundOr(true, { data: null, error: { code: 'FIN09' } }));
    // Mark as paid and Delete on a refund that was paid out in another tab; Void on one already void.
    expect(await markRefundPaid(ctx, { id: TXN, paid_on: '2026-10-09' })).toEqual({ ok: false, error: sentence });
    expect(await voidRefund(ctx, { id: TXN })).toEqual({ ok: false, error: sentence });
    expect(await deleteRefund(ctx, { id: TXN })).toEqual({ ok: false, error: sentence });
    // "Void a refund that has been paid out" was wrong from a second Void, and from Mark as paid.
    expect(sentence).not.toMatch(/Void a refund|delete one/);
  });
```

Create `tests/finance-current-party.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { type DocumentParty, withCurrentParty } from '@/lib/finance/document-form';

const active: DocumentParty[] = [
  { id: 'aisyah', name: 'Aisyah Trading', payment_terms_days: 14 },
  { id: 'zaki', name: 'Zaki Enterprise', payment_terms_days: 30 },
];

describe('withCurrentParty', () => {
  it('is the same list for a new document, which has no party yet', () => {
    expect(withCurrentParty(active)).toBe(active);
    expect(withCurrentParty(active, undefined)).toBe(active);
    expect(withCurrentParty([])).toEqual([]);
  });
  it('is the same list when the draft’s party is still offered, with that party’s own terms', () => {
    expect(withCurrentParty(active, { id: 'zaki', name: 'Zaki Enterprise' })).toBe(active);
  });
  it('puts a party archived since the draft was saved first, so the picker can show it', () => {
    expect(withCurrentParty(active, { id: 'lim', name: 'Lim Hardware' })).toEqual([
      { id: 'lim', name: 'Lim Hardware', payment_terms_days: 0 },
      ...active,
    ]);
    // The form must not open on "Add a customer first" when the only customer was archived.
    expect(withCurrentParty([], { id: 'lim', name: 'Lim Hardware' })).toEqual([
      { id: 'lim', name: 'Lim Hardware', payment_terms_days: 0 },
    ]);
  });
  it('does not change the list it was given', () => {
    const before = [...active];
    withCurrentParty(active, { id: 'lim', name: 'Lim Hardware' });
    expect(active).toEqual(before);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run tests/finance-credit-notes.test.ts tests/finance-refunds.test.ts tests/finance-current-party.test.ts`
Expected: FAIL. In `finance-credit-notes.test.ts`, two tests ("words FIN01 so that…" and "turns each database refusal into a sentence"); in `finance-refunds.test.ts`, three ("turns each database refusal into a sentence about a refund", "says what to do when paying a pending refund out is refused…", "words FIN09 so that…"); in `finance-current-party.test.ts`, all four: `withCurrentParty is not a function`. Nine failures in all.

- [ ] **Step 3: The credit note sentence, and the answer to "Save and issue"**

In `src/lib/finance/credit-notes.ts`, replace:

```ts
  // FIN01. A menu offers only what a credit note's status allows, so this reaches a person only when it
  // changed under them in another tab. True of both cases: a draft voided, and a credit note already
  // issued or voided being edited or deleted.
  locked:
    'That cannot be done to this credit note as it stands. A draft credit note is deleted, not voided; one that has been issued or voided can no longer be edited or deleted.',
```

with:

```ts
  // FIN01. A menu offers only what a credit note's status allows, so this reaches a person only when the
  // credit note changed in another tab: a draft that was issued meanwhile being saved, issued or deleted, or
  // an issued one that was voided meanwhile being voided again. It says what may have happened, not what
  // did, so it reads sensibly from all four buttons and is not false of a draft voided by a direct call.
  locked: 'That cannot be done to this credit note as it now stands. It may have been issued or voided since this page was loaded.',
```

In `src/lib/finance/credit-notes.ts`, replace:

```ts
const LIST_COLUMNS =
  'id,credit_note_no,invoice_id,invoice_no,customer_id,customer_name,credit_date,reason,amount,refunded,status,notes';
```

with:

```ts
/**
 * The answer to "Save and issue". When the draft was saved but issuing it was
 * refused, `draftId` is that draft, so the form goes on editing it instead of
 * saving a second copy.
 */
export type SaveAndIssueCreditNoteResult = FinResult<{ id: string; credit_note_no: string }> & { draftId?: string };

const LIST_COLUMNS =
  'id,credit_note_no,invoice_id,invoice_no,customer_id,customer_name,credit_date,reason,amount,refunded,status,notes';
```

- [ ] **Step 4: The refund sentences, and a second map for paying one out**

`recordRefund`, `voidRefund` and `deleteRefund` keep one map. `markRefundPaid` gets its own for `FIN04` and `FIN05`, as `recordPaymentOut` has its own for a unique violation in `money.ts`: the same code means something different to the person, depending on the button.

In `src/lib/finance/refunds.ts`, replace:

```ts
  // FIN04. Also raised when a pending refund is paid out and its credit note is no longer issued.
  notInCredit:
    'A refund needs a posted invoice, or an issued credit note, whose customer is in credit. If this refund is waiting to be paid out, delete it.',
  // FIN05. Raised when the amount is more than the customer's credit on the invoice, or more than is left
  // of the credit note; also when a pending refund is paid out and that credit has gone or been used up.
  tooMuch:
    'That is more than the customer is in credit, or more than is left of the credit note. If this refund is waiting to be paid out, delete it.',
  // FIN06
  notFound: 'The invoice or credit note for this refund no longer exists.',
  // FIN09. A menu offers only what a refund's status allows, so this reaches a person only when the
  // refund changed under them in another tab, or when a refund that was never paid out is voided. True of
  // each: only a paid refund is voided, a waiting one is deleted, and a paid or voided one is not edited.
  locked:
    'That cannot be done to this refund as it stands. Void a refund that has been paid out, or delete one that is still waiting to be paid out.',
```

with:

```ts
  // FIN04, when a refund is recorded: the customer is not in credit on the invoice, the invoice is not
  // posted, or the credit note is not issued. The form offers only what can be refunded, so this reaches a
  // person when that changed in another tab.
  notInCredit: 'A refund needs a posted invoice, or an issued credit note, whose customer is in credit.',
  // FIN05, when a refund is recorded: more than the customer's credit on the invoice, counting refunds
  // that are pending, or more than is left of the credit note.
  tooMuch: 'That is more than the customer is in credit, or more than is left of the credit note.',
  // FIN04, when a pending refund is paid out. Only markRefundPaid answers with it.
  cannotPayOut: 'This refund can no longer be paid out: its invoice is no longer posted, or its credit note is no longer issued. Delete it.',
  // FIN05, when a pending refund is paid out: the credit it was recorded against has gone since, most
  // often because the payment in behind it was voided. Only markRefundPaid answers with it.
  creditGone:
    'This refund no longer fits in what the customer is in credit, or in what is left of its credit note, so it cannot be paid out. Delete it, and record a new one for what is left.',
  // FIN06
  notFound: 'The invoice or credit note for this refund no longer exists.',
  // FIN09. A menu offers only what a refund's status allows, so this reaches a person only when the refund
  // changed in another tab: a pending one that was paid out meanwhile being marked paid or deleted, or a
  // paid one that was voided meanwhile being voided again. It says what may have happened, not what did,
  // so it reads sensibly from all three buttons and is not false of a pending refund voided by a direct call.
  locked: 'That cannot be done to this refund as it now stands. It may have been paid out or voided since this page was loaded.',
```

In `src/lib/finance/refunds.ts`, replace:

```ts
function refundWriteFailed(fnName: string, error: unknown): { ok: false; error: string } {
  const refusal = REFUSALS[pgCode(error) ?? ''];
  return refusal ? { ok: false, error: refusal } : writeFailed(fnName, error);
}
```

with:

```ts
/**
 * Paying a pending refund out. The database looks at the credit again, and
 * the two codes then mean "this refund no longer fits", which a person fixes
 * by deleting it, not by typing a smaller amount.
 */
const PAY_OUT_REFUSALS: Record<string, string> = { ...REFUSALS, FIN04: M.cannotPayOut, FIN05: M.creditGone };

function refundWriteFailed(
  fnName: string,
  error: unknown,
  refusals: Record<string, string> = REFUSALS,
): { ok: false; error: string } {
  const refusal = refusals[pgCode(error) ?? ''];
  return refusal ? { ok: false, error: refusal } : writeFailed(fnName, error);
}
```

In `src/lib/finance/refunds.ts`, replace:

```ts
  if (error || !data) return refundWriteFailed('markRefundPaid', error);
```

with:

```ts
  if (error || !data) return refundWriteFailed('markRefundPaid', error, PAY_OUT_REFUSALS);
```

- [ ] **Step 5: One function for the party a draft already has**

In `src/lib/finance/document-form.ts`, replace:

```ts
/** The customer or supplier a document is for, as its picker lists it. */
export type DocumentParty = { id: string; name: string; payment_terms_days: number };
```

with:

```ts
/** The customer or supplier a document is for, as its picker lists it. */
export type DocumentParty = { id: string; name: string; payment_terms_days: number };

/**
 * The parties a form's picker offers. `parties` are the active ones; a draft
 * being changed may be for one that was archived since it was saved, and that
 * party (`current`) is still the draft's: it goes first, so the picker can
 * show it. Its payment terms are not known here and count as none, which only
 * matters if the person changes the date and has not set the second date by
 * hand. The same list when `current` is absent or already offered.
 */
export function withCurrentParty(parties: DocumentParty[], current?: { id: string; name: string }): DocumentParty[] {
  if (!current || parties.some((p) => p.id === current.id)) return parties;
  return [{ id: current.id, name: current.name, payment_terms_days: 0 }, ...parties];
}
```

Then the three cards that wrote those lines out use it.

In `src/components/finance/bill-form-card.tsx`, replace:

```tsx
import { BILL_FORM_KIND, billFormFromDetail, newBillForm } from '@/lib/finance/bill-form';
```

with:

```tsx
import { BILL_FORM_KIND, billFormFromDetail, newBillForm } from '@/lib/finance/bill-form';
import { withCurrentParty } from '@/lib/finance/document-form';
```

In `src/components/finance/bill-form-card.tsx`, replace:

```tsx
      parties={
        editing && !suppliers.some((s) => s.id === editing.supplier_id)
          ? [{ id: editing.supplier_id, name: editing.supplier_name, payment_terms_days: 0 }, ...suppliers]
          : suppliers
      }
```

with:

```tsx
      parties={withCurrentParty(suppliers, editing && { id: editing.supplier_id, name: editing.supplier_name })}
```

In `src/components/finance/invoice-form-card.tsx`, replace:

```tsx
import type { FinanceContact } from '@/lib/finance/contacts';
import { INVOICE_FORM_KIND, invoiceFormFromDetail, newInvoiceForm } from '@/lib/finance/invoice-form';
```

with:

```tsx
import type { FinanceContact } from '@/lib/finance/contacts';
import { withCurrentParty } from '@/lib/finance/document-form';
import { INVOICE_FORM_KIND, invoiceFormFromDetail, newInvoiceForm } from '@/lib/finance/invoice-form';
```

In `src/components/finance/invoice-form-card.tsx`, replace:

```tsx
      parties={
        editing && !customers.some((c) => c.id === editing.customer_id)
          ? [{ id: editing.customer_id, name: editing.customer_name, payment_terms_days: 0 }, ...customers]
          : customers
      }
```

with:

```tsx
      parties={withCurrentParty(customers, editing && { id: editing.customer_id, name: editing.customer_name })}
```

In `src/components/finance/quotation-form-card.tsx`, replace:

```tsx
import type { FinanceContact } from '@/lib/finance/contacts';
import type { FinanceProduct } from '@/lib/finance/products';
```

with:

```tsx
import type { FinanceContact } from '@/lib/finance/contacts';
import { withCurrentParty } from '@/lib/finance/document-form';
import type { FinanceProduct } from '@/lib/finance/products';
```

In `src/components/finance/quotation-form-card.tsx`, replace:

```tsx
      parties={
        editing && !customers.some((c) => c.id === editing.customer_id)
          ? [{ id: editing.customer_id, name: editing.customer_name, payment_terms_days: 0 }, ...customers]
          : customers
      }
```

with:

```tsx
      parties={withCurrentParty(customers, editing && { id: editing.customer_id, name: editing.customer_name })}
```

- [ ] **Step 6: Run the tests to see them pass**

Run: `pnpm exec vitest run tests/finance-credit-notes.test.ts tests/finance-refunds.test.ts tests/finance-current-party.test.ts tests/finance-bill-form.test.ts tests/finance-invoice-form.test.ts tests/finance-quotation-form.test.ts`
Expected: PASS, all six files. The three form files are unedited: the forms' own rules did not move.

- [ ] **Step 7: Type-check, lint, and run the unit tests**

Run, as separate commands: `pnpm exec tsc --noEmit`, `pnpm lint`, `pnpm exec vitest run --exclude 'tests/*.rls.test.ts' --exclude 'tests/bendahara-*.test.ts'`
Expected: no type errors; no lint errors (one warning, in `tests/apply-proposal.test.ts`, is on `main` and stays); every unit test passes, 4,082 in all.

- [ ] **Step 8: Commit**

```bash
git add src/lib/finance/credit-notes.ts src/lib/finance/refunds.ts src/lib/finance/document-form.ts src/components/finance/bill-form-card.tsx src/components/finance/invoice-form-card.tsx src/components/finance/quotation-form-card.tsx tests/finance-credit-notes.test.ts tests/finance-refunds.test.ts tests/finance-current-party.test.ts
git commit -m "fix: credit note and refund refusals read rightly from each button; one helper for a draft's archived party"
```

---


### Task 2: The rules of the credit note form and of a credit note's row menu

Pure functions and their tests; no component yet. The cap is the database's own (stage 4a, Decision 5): all the issued credit notes of an invoice together never exceed its total, and what has been paid does not limit it.

**Files:**
- Create: `src/lib/finance/credit-note-form.ts`
- Modify: `src/lib/finance/sales-followon-views.ts`
- Create: `tests/finance-credit-note-form.test.ts`, `tests/finance-credit-note-rules.test.ts`

**Interfaces:**
- Consumes: `CREDIT_NOTE_MESSAGES`, `CreditNoteReason`, `CreditNoteRow`, `saveCreditNoteInput` from `@/lib/finance/credit-notes`; `InvoiceListRow` from `@/lib/finance/invoices`; `amountText`, `round2`, `sen` from `@/lib/finance/allocation-form`; `rm`, `typedNumber` from `@/lib/finance/format`; `WRITE_FAILED` from `@/lib/finance/result`.
- Produces, from `@/lib/finance/credit-note-form`:
  - `type CreditableInvoice = { id: string; invoice_no: string; customer_id: string; customer_name: string; total: number; credited: number; creditable: number }`
  - `type CreditNoteForm = { id?: string; invoiceId: string; date: string; reason: CreditNoteReason | ''; amount: string; notes: string }`
  - `creditableInvoices(invoices: InvoiceListRow[], keepId?: string): CreditableInvoice[]`
  - `creditableLabel(invoice: CreditableInvoice): string`
  - `newCreditNoteForm(creditable: CreditableInvoice[], today: string, invoiceId?: string): CreditNoteForm`
  - `creditNoteFormFromRow(note: CreditNoteRow): CreditNoteForm`
  - `creditNotePayload(form: CreditNoteForm)`: what `saveCreditNoteAction` takes
  - `creditNoteFormError(form: CreditNoteForm, creditable: CreditableInvoice[]): string | null`
  - `creditNoteSavedNotIssued(error: string): string`
- Produces, from `@/lib/finance/sales-followon-views`:
  - `type CreditNoteAction = 'edit' | 'issue' | 'delete' | 'refund' | 'void'`
  - `creditNoteActions(note: CreditNoteRow, canRefund: boolean): CreditNoteAction[]`
  - `creditNoteName(note: CreditNoteRow): string`

Why there is no "kind" object here, as bills, invoices and quotations have: a kind describes one of several forms that one card draws. Nothing else is shaped like a credit note (one invoice, one amount, a reason, no lines, no account), so its card is its own and its rules are plain functions.

- [ ] **Step 1: Write the failing tests**

Create `tests/finance-credit-note-form.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  type CreditNoteForm,
  creditNoteFormError,
  creditNoteFormFromRow,
  creditNotePayload,
  creditNoteSavedNotIssued,
  creditableInvoices,
  creditableLabel,
  newCreditNoteForm,
} from '@/lib/finance/credit-note-form';
import { type CreditNoteRow, saveCreditNoteInput } from '@/lib/finance/credit-notes';
import type { InvoiceListRow } from '@/lib/finance/invoices';
import { WRITE_FAILED } from '@/lib/finance/result';

const SENT = '11111111-1111-4111-8111-111111111111';
const PAID = '22222222-2222-4222-8222-222222222222';
const DRAFT_NOTE = '33333333-3333-4333-8333-333333333333';

const invoice = (i: Partial<InvoiceListRow> = {}): InvoiceListRow => ({
  id: SENT,
  invoice_no: 'INV-0007',
  customer_id: 'aisyah',
  customer_name: 'Aisyah Trading',
  invoice_date: '2026-10-01',
  due_date: '2026-10-31',
  total: 100,
  paid: 0,
  credited: 0,
  refunded: 0,
  balance: 100,
  display_status: 'sent',
  einvoice_status: 'none',
  einvoice_uuid: null,
  ...i,
});

const form = (f: Partial<CreditNoteForm> = {}): CreditNoteForm => ({
  invoiceId: SENT,
  date: '2026-10-06',
  reason: 'returns',
  amount: '30',
  notes: '',
  ...f,
});

describe('creditableInvoices', () => {
  it('offers posted invoices only: sent, overdue or paid, never a draft or a void one', () => {
    const offered = creditableInvoices([
      invoice({ id: 'a', invoice_no: 'INV-0001', display_status: 'sent' }),
      invoice({ id: 'b', invoice_no: 'INV-0002', display_status: 'overdue' }),
      invoice({ id: 'c', invoice_no: 'INV-0003', display_status: 'paid', paid: 100, balance: 0 }),
      invoice({ id: 'd', invoice_no: null, display_status: 'draft' }),
      invoice({ id: 'e', invoice_no: 'INV-0005', display_status: 'void' }),
    ]);
    expect(offered.map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });
  it('offers the total less what is already credited, whatever has been paid', () => {
    // What was paid does not limit a credit note: crediting a paid invoice is what leaves the customer in credit.
    const [paid] = creditableInvoices([invoice({ id: PAID, display_status: 'paid', paid: 100, balance: 0 })]);
    expect(paid).toMatchObject({ total: 100, credited: 0, creditable: 100 });
    const [part] = creditableInvoices([invoice({ credited: 30.1, balance: 69.9 })]);
    expect(part.creditable).toBe(69.9);
    // To the sen: 0.3 − 0.1 is not 0.19999999999999998.
    expect(creditableInvoices([invoice({ total: 0.3, credited: 0.1, balance: 0.2 })])[0].creditable).toBe(0.2);
  });
  it('leaves out an invoice credited for its whole total, unless the form is on it', () => {
    const full = invoice({ id: PAID, credited: 100, balance: 0, display_status: 'paid' });
    expect(creditableInvoices([full])).toEqual([]);
    expect(creditableInvoices([full], PAID)).toMatchObject([{ id: PAID, creditable: 0 }]);
    // An invoice that was voided is not kept: a credit note cannot go against it at all.
    expect(creditableInvoices([invoice({ id: PAID, display_status: 'void' })], PAID)).toEqual([]);
    // More credited than billed can only come from a direct write; it is never offered as a negative amount.
    expect(creditableInvoices([invoice({ id: PAID, credited: 120 })], PAID)[0].creditable).toBe(0);
  });
  it('lists them by customer, then by number', () => {
    const offered = creditableInvoices([
      invoice({ id: 'z2', invoice_no: 'INV-0009', customer_name: 'Zaki Enterprise' }),
      invoice({ id: 'a2', invoice_no: 'INV-0008', customer_name: 'Aisyah Trading' }),
      invoice({ id: 'a1', invoice_no: 'INV-0002', customer_name: 'Aisyah Trading' }),
    ]);
    expect(offered.map((i) => i.id)).toEqual(['a1', 'a2', 'z2']);
  });
  it('names an invoice in the picker with what it has left', () => {
    expect(creditableLabel(creditableInvoices([invoice({ total: 1240, credited: 240 })])[0])).toBe(
      'INV-0007 · Aisyah Trading · RM 1,000.00 left to credit',
    );
  });
});

describe('a new credit note form', () => {
  const offered = creditableInvoices([invoice()]);

  it('is dated today with nothing chosen and nothing typed', () => {
    expect(newCreditNoteForm(offered, '2026-10-09')).toEqual({ invoiceId: '', date: '2026-10-09', reason: '', amount: '', notes: '' });
  });
  it('opens on the invoice whose row it was started from, when that invoice can take a credit note', () => {
    expect(newCreditNoteForm(offered, '2026-10-09', SENT).invoiceId).toBe(SENT);
    expect(newCreditNoteForm(offered, '2026-10-09', PAID).invoiceId).toBe('');
    // The amount is the person's to type: a credit note is seldom for everything that is left.
    expect(newCreditNoteForm(offered, '2026-10-09', SENT).amount).toBe('');
  });
});

describe('a draft being changed', () => {
  const note: CreditNoteRow = {
    id: DRAFT_NOTE,
    credit_note_no: null,
    invoice_id: SENT,
    invoice_no: 'INV-0007',
    customer_id: 'aisyah',
    customer_name: 'Aisyah Trading',
    credit_date: '2026-10-02',
    reason: 'pricing_adjustment',
    amount: 30.5,
    refunded: 0,
    status: 'draft',
    notes: null,
  };

  it('opens with what was saved, the amount as an amount box shows it', () => {
    expect(creditNoteFormFromRow(note)).toEqual({
      id: DRAFT_NOTE,
      invoiceId: SENT,
      date: '2026-10-02',
      reason: 'pricing_adjustment',
      amount: '30.50',
      notes: '',
    });
    expect(creditNoteFormFromRow({ ...note, notes: 'Two returned' }).notes).toBe('Two returned');
  });
  it('is sent with its id, so the draft is changed and no second one is made', () => {
    expect(creditNotePayload(creditNoteFormFromRow(note))).toEqual({
      id: DRAFT_NOTE,
      invoice_id: SENT,
      credit_date: '2026-10-02',
      reason: 'pricing_adjustment',
      amount: 30.5,
      notes: '',
    });
  });
});

describe('creditNotePayload', () => {
  it('sends the amount as a number, and no id for a new credit note', () => {
    expect(creditNotePayload(form({ amount: ' 30.50 ', notes: 'Two returned' }))).toEqual({
      invoice_id: SENT,
      credit_date: '2026-10-06',
      reason: 'returns',
      amount: 30.5,
      notes: 'Two returned',
    });
  });
  it('is what the write’s own schema accepts', () => {
    expect(saveCreditNoteInput.safeParse(creditNotePayload(form())).success).toBe(true);
  });
});

describe('creditNoteFormError', () => {
  const offered = creditableInvoices([invoice({ credited: 20, balance: 80 })], SENT);

  it('lets a form through that can be saved', () => {
    expect(creditNoteFormError(form(), offered)).toBeNull();
    // All that is left, to the sen.
    expect(creditNoteFormError(form({ amount: '80' }), offered)).toBeNull();
    expect(creditNoteFormError(form({ amount: '80.00' }), offered)).toBeNull();
  });
  it('asks for an invoice, a real date and a reason, in the schema’s own sentences', () => {
    expect(creditNoteFormError(form({ invoiceId: '' }), offered)).toBe('Choose the invoice this credit note is against.');
    expect(creditNoteFormError(form({ date: '2026-02-30' }), offered)).toBe('Enter a valid date.');
    expect(creditNoteFormError(form({ date: '' }), offered)).toBe('Enter a valid date.');
    expect(creditNoteFormError(form({ reason: '' }), offered)).toBe('Choose a reason.');
    expect(creditNoteFormError(form({ notes: 'x'.repeat(201) }), offered)).toBe('That is too long. Keep it to 200 characters or fewer.');
  });
  it('refuses an empty amount, nothing, and a figure typed with a comma', () => {
    for (const amount of ['', ' ', '0', '0.004', '-5', '1,200.50', 'abc']) {
      expect(creditNoteFormError(form({ amount }), offered), amount).toBe('Enter an amount above 0.');
    }
  });
  it('refuses a sen more than the invoice has left to credit, before the database is asked', () => {
    expect(creditNoteFormError(form({ amount: '80.01' }), offered)).toBe('That is more than this invoice has left to credit.');
    // Rounded to the sen first, as the schema rounds: 80.004 is 80.00.
    expect(creditNoteFormError(form({ amount: '80.004' }), offered)).toBeNull();
    expect(creditNoteFormError(form({ amount: '80.005' }), offered)).toBe('That is more than this invoice has left to credit.');
  });
  it('says so when the invoice was credited in full, or voided, while the form was open', () => {
    const full = creditableInvoices([invoice({ credited: 100, balance: 0, display_status: 'paid' })], SENT);
    expect(creditNoteFormError(form({ amount: '0.01' }), full)).toBe('That is more than this invoice has left to credit.');
    const voided = creditableInvoices([invoice({ display_status: 'void' })], SENT);
    expect(creditNoteFormError(form(), voided)).toBe('A credit note can only go against a posted invoice.');
  });
});

describe('creditNoteSavedNotIssued', () => {
  it('says the draft was kept, and why it was not issued', () => {
    expect(creditNoteSavedNotIssued('That is more than this invoice has left to credit.')).toBe(
      'The credit note was saved as a draft, but it was not issued. That is more than this invoice has left to credit.',
    );
  });
  it('does not repeat the general failure sentence', () => {
    expect(creditNoteSavedNotIssued(WRITE_FAILED)).toBe('The credit note was saved as a draft, but issuing it failed. Please try again.');
  });
});
```

Create `tests/finance-credit-note-rules.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { CreditNoteRow, CreditNoteStatus } from '@/lib/finance/credit-notes';
import { creditNoteActions, creditNoteName } from '@/lib/finance/sales-followon-views';

const note = (status: CreditNoteStatus, n: Partial<CreditNoteRow> = {}): CreditNoteRow => ({
  id: `note-${status}`,
  credit_note_no: status === 'draft' ? null : 'CN-0003',
  invoice_id: 'invoice-1',
  invoice_no: 'INV-0007',
  customer_id: 'aisyah',
  customer_name: 'Aisyah Trading',
  credit_date: '2026-10-06',
  reason: 'returns',
  amount: 30,
  refunded: 0,
  status,
  notes: null,
  ...n,
});

describe('creditNoteActions', () => {
  it('lets a draft be edited, issued or deleted, and never voided or refunded', () => {
    expect(creditNoteActions(note('draft'), false)).toEqual(['edit', 'issue', 'delete']);
    // Whatever the flag says: a draft has credited nothing, so there is nothing to refund against it.
    expect(creditNoteActions(note('draft'), true)).toEqual(['edit', 'issue', 'delete']);
  });
  it('lets an issued credit note be voided, and refunded while something of it can be', () => {
    expect(creditNoteActions(note('issued'), true)).toEqual(['refund', 'void']);
    expect(creditNoteActions(note('issued'), false)).toEqual(['void']);
  });
  it('offers nothing on a void credit note', () => {
    expect(creditNoteActions(note('void'), false)).toEqual([]);
    expect(creditNoteActions(note('void'), true)).toEqual([]);
  });
  it('never offers what the database refuses for the status: no editing, issuing or deleting once issued', () => {
    for (const status of ['issued', 'void'] as const) {
      const offered = creditNoteActions(note(status), true);
      expect(offered, status).not.toContain('edit');
      expect(offered, status).not.toContain('issue');
      expect(offered, status).not.toContain('delete');
    }
  });
  it('offers Void on an issued credit note that has been refunded: the refusal says what to do first', () => {
    expect(creditNoteActions(note('issued', { refunded: 30 }), false)).toEqual(['void']);
  });
});

describe('creditNoteName', () => {
  it('names a credit note by its number and customer, and a draft as the draft', () => {
    expect(creditNoteName(note('issued'))).toBe('CN-0003 to Aisyah Trading');
    expect(creditNoteName(note('draft'))).toBe('the draft credit note to Aisyah Trading');
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run tests/finance-credit-note-form.test.ts tests/finance-credit-note-rules.test.ts`
Expected: FAIL, both files: `@/lib/finance/credit-note-form` does not exist, and `creditNoteActions` is not exported from `sales-followon-views`.

- [ ] **Step 3: Write the credit note form's rules**

Create `src/lib/finance/credit-note-form.ts`:

```ts
/**
 * The credit note form's rules, kept out of the component so they can be
 * tested: which invoices can take a credit note and for how much, what a new
 * form holds, what is wrong with the form, and what is sent to
 * saveCreditNoteAction. Pure. A credit note is one amount against one posted
 * invoice, with a reason: it has no lines and moves no money, so it shares
 * neither the document card nor the payment card.
 */
import { amountText, round2, sen } from './allocation-form';
import { CREDIT_NOTE_MESSAGES, type CreditNoteReason, type CreditNoteRow, saveCreditNoteInput } from './credit-notes';
import { rm, typedNumber } from './format';
import type { InvoiceListRow } from './invoices';
import { WRITE_FAILED } from './result';

const M = CREDIT_NOTE_MESSAGES;

export type CreditableInvoice = {
  id: string;
  invoice_no: string;
  customer_id: string;
  customer_name: string;
  total: number;
  /** What the invoice's issued credit notes already come to. */
  credited: number;
  /** What a new credit note may be for: the total less what is already credited. */
  creditable: number;
};

export type CreditNoteForm = {
  /** Present when a saved draft is being changed. */
  id?: string;
  invoiceId: string;
  date: string;
  /** Empty until a reason is chosen. */
  reason: CreditNoteReason | '';
  /** The amount as typed. */
  amount: string;
  notes: string;
};

/**
 * The invoices a credit note can go against: posted ("Sent", "Overdue" or
 * "Paid"), and not yet credited for their whole total. All the issued credit
 * notes of an invoice together never exceed its total; what has been paid
 * does not limit it, since crediting a paid invoice is what leaves a customer
 * in credit. A draft credit note is not counted, as the database does not
 * count one until it is issued. `keepId` is the invoice the form is on: it
 * stays in the list with nothing left to credit, so the form can say so,
 * unless it is no longer posted.
 */
export function creditableInvoices(invoices: InvoiceListRow[], keepId?: string): CreditableInvoice[] {
  return invoices
    .filter((i) => i.display_status === 'sent' || i.display_status === 'overdue' || i.display_status === 'paid')
    .map((i) => ({
      id: i.id,
      invoice_no: i.invoice_no ?? '—',
      customer_id: i.customer_id,
      customer_name: i.customer_name,
      total: i.total,
      credited: i.credited,
      creditable: Math.max(round2(i.total - i.credited), 0),
    }))
    .filter((i) => i.creditable > 0 || i.id === keepId)
    .sort((x, y) => x.customer_name.localeCompare(y.customer_name) || x.invoice_no.localeCompare(y.invoice_no));
}

/** How the form's picker lists an invoice: its number, its customer, and what it has left to credit. */
export function creditableLabel(invoice: CreditableInvoice): string {
  return `${invoice.invoice_no} · ${invoice.customer_name} · ${rm(invoice.creditable)} left to credit`;
}

/**
 * A new credit note dated today, with nothing chosen. With `invoiceId` (the
 * Credit note choice on an invoice's row) that invoice is chosen, when it can
 * still take a credit note. The amount is left for the person: a credit note
 * is seldom for everything an invoice has left.
 */
export function newCreditNoteForm(creditable: CreditableInvoice[], today: string, invoiceId?: string): CreditNoteForm {
  return {
    invoiceId: invoiceId && creditable.some((i) => i.id === invoiceId) ? invoiceId : '',
    date: today,
    reason: '',
    amount: '',
    notes: '',
  };
}

/** A saved draft, as the form shows it. The list row carries everything a credit note has, so nothing more is read. */
export function creditNoteFormFromRow(note: CreditNoteRow): CreditNoteForm {
  return {
    id: note.id,
    invoiceId: note.invoice_id,
    date: note.credit_date,
    reason: note.reason,
    amount: amountText(note.amount),
    notes: note.notes ?? '',
  };
}

/** What is sent to saveCreditNoteAction. The amount is a number; a box that is not a number goes as NaN and is refused. */
export function creditNotePayload(form: CreditNoteForm) {
  return {
    ...(form.id ? { id: form.id } : {}),
    invoice_id: form.invoiceId,
    credit_date: form.date,
    reason: form.reason,
    amount: typedNumber(form.amount) ?? Number.NaN,
    notes: form.notes,
  };
}

/**
 * The first thing wrong with the form, in the sentence the schema or the
 * database would use, or null when it can be sent. `creditable` is
 * `creditableInvoices` with the form's own invoice kept: an invoice that is
 * not in it was voided since the form opened, and one with less left than
 * the amount was credited meanwhile.
 */
export function creditNoteFormError(form: CreditNoteForm, creditable: CreditableInvoice[]): string | null {
  const parsed = saveCreditNoteInput.safeParse(creditNotePayload(form));
  if (!parsed.success) return parsed.error.issues[0]?.message ?? M.amount;
  const invoice = creditable.find((i) => i.id === form.invoiceId);
  if (!invoice) return M.notPosted;
  return sen(parsed.data.amount) > sen(invoice.creditable) ? M.tooMuch : null;
}

/** What the form says when the credit note was saved as a draft but issuing it was refused. */
export function creditNoteSavedNotIssued(error: string): string {
  if (error === WRITE_FAILED) return 'The credit note was saved as a draft, but issuing it failed. Please try again.';
  return `The credit note was saved as a draft, but it was not issued. ${error}`;
}
```

- [ ] **Step 4: Write the menu's rule**

In `src/lib/finance/sales-followon-views.ts`, replace:

```ts
/** What has been refunded against an issued credit note; nothing to show (null) for a draft or a void one. */
export function refundedOnNote(note: CreditNoteRow): number | null {
  return note.status === 'issued' ? note.refunded : null;
}
```

with:

```ts
/** What has been refunded against an issued credit note; nothing to show (null) for a draft or a void one. */
export function refundedOnNote(note: CreditNoteRow): number | null {
  return note.status === 'issued' ? note.refunded : null;
}

export type CreditNoteAction = 'edit' | 'issue' | 'delete' | 'refund' | 'void';

/**
 * What a credit note's row menu offers, in order: only what the database
 * allows for its status. A draft is edited, issued or deleted, never voided.
 * An issued credit note is locked: it can be voided, and refunded while
 * `canRefund`, which is when something of it can still be paid out. Voiding
 * one that a refund depends on is offered and refused with the reason, as
 * voiding a paid invoice is. A void credit note offers nothing.
 */
export function creditNoteActions(note: CreditNoteRow, canRefund: boolean): CreditNoteAction[] {
  if (note.status === 'draft') return ['edit', 'issue', 'delete'];
  if (note.status === 'issued') return canRefund ? ['refund', 'void'] : ['void'];
  return [];
}

/** How a question or a menu names one credit note: its number, or "the draft credit note", and its customer. */
export function creditNoteName(note: CreditNoteRow): string {
  return `${note.credit_note_no ?? 'the draft credit note'} to ${note.customer_name}`;
}
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `pnpm exec vitest run tests/finance-credit-note-form.test.ts tests/finance-credit-note-rules.test.ts tests/finance-followon-views.test.ts`
Expected: PASS, all three files.

- [ ] **Step 6: Type-check, lint, and run the unit tests**

Run, as separate commands: `pnpm exec tsc --noEmit`, `pnpm lint`, `pnpm exec vitest run --exclude 'tests/*.rls.test.ts' --exclude 'tests/bendahara-*.test.ts'`
Expected: no type errors; no lint errors; every unit test passes, 4,106 in all.

- [ ] **Step 7: Commit**

```bash
git add src/lib/finance/credit-note-form.ts src/lib/finance/sales-followon-views.ts tests/finance-credit-note-form.test.ts tests/finance-credit-note-rules.test.ts
git commit -m "feat: the rules of the credit note form and of a credit note's row menu"
```

---


### Task 3: The rules of the refund form and of a refund's row menu

Pure functions and their tests; no component yet. `refundTargets` is to refunds what `receivableInvoices` is to payments in: the one place that works out what the form may offer, to the sen, from the rows the screens already read. It mirrors three checks the database makes (stage 4a, Decision 6): the customer must be in credit on the invoice; refunds still pending hold that credit; and against a credit note a refund is also no more than is left of the note.

**Files:**
- Create: `src/lib/finance/refund-form.ts`
- Modify: `src/lib/finance/sales-followon-views.ts`
- Create: `tests/finance-refund-form.test.ts`, `tests/finance-refund-rules.test.ts`

**Interfaces:**
- Consumes: `REFUND_MESSAGES`, `RefundReason`, `RefundRow`, `recordRefundInput` from `@/lib/finance/refunds` (sentences as Task 1 left them); `CreditNoteRow` from `@/lib/finance/credit-notes`; `InvoiceListRow` from `@/lib/finance/invoices`; `FinanceAccount`, `PaymentMethod` from `@/lib/finance/money`; `inCredit` from `@/lib/finance/sales-views`; `isPendingRefund` from `@/lib/finance/sales-followon-views`; `amountText`, `defaultAccount`, `sen` from `@/lib/finance/allocation-form`; `rm`, `typedNumber` from `@/lib/finance/format`.
- Produces, from `@/lib/finance/refund-form`:
  - `type RefundTarget = { key: string; kind: 'invoice' | 'credit_note'; id: string; number: string; invoice_id: string; invoice_no: string; customer_name: string; refundable: number }`
  - `type RefundForm = { target: string; amount: string; reason: RefundReason | ''; accountId: string; date: string; method: PaymentMethod; reference: string; notes: string; scheduled: boolean }`
  - `invoiceTargetKey(invoiceId: string): string`, `noteTargetKey(creditNoteId: string): string`
  - `refundTargets(invoices: InvoiceListRow[], creditNotes: CreditNoteRow[], refunds: RefundRow[]): RefundTarget[]`
  - `refundTargetLabel(target: RefundTarget): string`
  - `newRefundForm(targets: RefundTarget[], accounts: FinanceAccount[], today: string, preselect?: string): RefundForm`
  - `chooseRefundTarget(form: RefundForm, target: RefundTarget): RefundForm`
  - `keepRefundTarget(form: RefundForm, targets: RefundTarget[]): RefundForm`
  - `refundPayload(form: RefundForm, targets: RefundTarget[])`: what `recordRefundAction` takes
  - `refundFormError(form: RefundForm, targets: RefundTarget[]): string | null`
- Produces, from `@/lib/finance/sales-followon-views`:
  - `type RefundAction = 'markPaid' | 'delete' | 'void'`
  - `refundActions(row: RefundRow): RefundAction[]`
  - `refundName(row: RefundRow): string`

Where each figure comes from, since two of them are easy to count twice:

| Figure | Read from | Why |
|---|---|---|
| What the customer is in credit on an invoice | `inCredit(invoice)`: the invoice's `balance` below zero | The view's balance is total, less paid, less credited, plus refunds that were paid out. A paid-out refund is already in it and is not taken off again |
| Refunds pending on an invoice | The refund rows that are pending, by `invoice_id` | A refund row names its invoice whichever way it was recorded, so refunds put against the invoice's credit notes are in the same sum, as they are in the database's `finance_refunds_held` |
| What is left of a credit note | `amount − refunded − pending against the note` | `CreditNoteRow.refunded` counts refunds that were paid out only, so what is pending comes from the refund rows, by `credit_note_id` |

- [ ] **Step 1: Write the failing tests**

Create `tests/finance-refund-form.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { CreditNoteRow } from '@/lib/finance/credit-notes';
import type { InvoiceListRow } from '@/lib/finance/invoices';
import type { FinanceAccount } from '@/lib/finance/money';
import {
  type RefundForm,
  chooseRefundTarget,
  invoiceTargetKey,
  keepRefundTarget,
  newRefundForm,
  noteTargetKey,
  refundFormError,
  refundPayload,
  refundTargetLabel,
  refundTargets,
} from '@/lib/finance/refund-form';
import { type RefundRow, recordRefundInput } from '@/lib/finance/refunds';

const INVOICE = '11111111-1111-4111-8111-111111111111';
const NOTE = '22222222-2222-4222-8222-222222222222';
const NOTE_2 = '33333333-3333-4333-8333-333333333333';
const BANK = '44444444-4444-4444-8444-444444444444';
const CASH = '55555555-5555-4555-8555-555555555555';

/** RM 100 invoiced and paid, then RM 30 credited: the customer is RM 30 in credit. */
const invoice = (i: Partial<InvoiceListRow> = {}): InvoiceListRow => ({
  id: INVOICE,
  invoice_no: 'INV-0007',
  customer_id: 'aisyah',
  customer_name: 'Aisyah Trading',
  invoice_date: '2026-10-01',
  due_date: '2026-10-31',
  total: 100,
  paid: 100,
  credited: 30,
  refunded: 0,
  balance: -30,
  display_status: 'paid',
  einvoice_status: 'none',
  einvoice_uuid: null,
  ...i,
});

const note = (n: Partial<CreditNoteRow> = {}): CreditNoteRow => ({
  id: NOTE,
  credit_note_no: 'CN-0003',
  invoice_id: INVOICE,
  invoice_no: 'INV-0007',
  customer_id: 'aisyah',
  customer_name: 'Aisyah Trading',
  credit_date: '2026-10-06',
  reason: 'returns',
  amount: 30,
  refunded: 0,
  status: 'issued',
  notes: null,
  ...n,
});

const refund = (r: Partial<RefundRow> = {}): RefundRow => ({
  allocation_id: 'a-1',
  transaction_id: 't-1',
  number: null,
  txn_date: '2026-10-07',
  method: 'fpx',
  amount: 10,
  transaction_amount: 10,
  status: 'scheduled',
  reference: null,
  reason: 'damaged_goods',
  notes: null,
  account_id: BANK,
  account_name: 'Main Bank',
  invoice_id: INVOICE,
  invoice_no: 'INV-0007',
  credit_note_id: null,
  credit_note_no: null,
  customer_id: 'aisyah',
  customer_name: 'Aisyah Trading',
  ...r,
});

const accounts: FinanceAccount[] = [
  { id: CASH, name: 'Cash in hand', kind: 'cash', bank_name: null },
  { id: BANK, name: 'Main Bank', kind: 'bank', bank_name: 'Maybank' },
];

const refundable = (invoices: InvoiceListRow[], notes: CreditNoteRow[], refunds: RefundRow[]) =>
  Object.fromEntries(refundTargets(invoices, notes, refunds).map((t) => [t.key, t.refundable]));

describe('refundTargets: what can be refunded, and how much', () => {
  it('offers an invoice whose customer is in credit, and its issued credit note, each for the credit', () => {
    expect(refundTargets([invoice()], [note()], [])).toEqual([
      {
        key: invoiceTargetKey(INVOICE), kind: 'invoice', id: INVOICE, number: 'INV-0007',
        invoice_id: INVOICE, invoice_no: 'INV-0007', customer_name: 'Aisyah Trading', refundable: 30,
      },
      {
        key: noteTargetKey(NOTE), kind: 'credit_note', id: NOTE, number: 'CN-0003',
        invoice_id: INVOICE, invoice_no: 'INV-0007', customer_name: 'Aisyah Trading', refundable: 30,
      },
    ]);
  });
  it('offers nothing while the customer owes money, is exactly settled, or the invoice is a draft or void', () => {
    expect(refundTargets([invoice({ paid: 0, credited: 30, balance: 70, display_status: 'sent' })], [note()], [])).toEqual([]);
    expect(refundTargets([invoice({ paid: 70, balance: 0 })], [note()], [])).toEqual([]);
    expect(refundTargets([invoice({ display_status: 'void' })], [note()], [])).toEqual([]);
    expect(refundTargets([invoice({ display_status: 'draft' })], [], [])).toEqual([]);
  });
  it('takes a pending refund off what is left, whether it was put against the invoice or against the credit note', () => {
    // A refund row names its invoice whichever way it was recorded, so both hold the invoice's credit.
    const onInvoice = refund();
    expect(refundable([invoice()], [note()], [onInvoice])).toEqual({ [invoiceTargetKey(INVOICE)]: 20, [noteTargetKey(NOTE)]: 20 });
    const onNote = refund({ credit_note_id: NOTE, credit_note_no: 'CN-0003' });
    expect(refundable([invoice()], [note()], [onNote])).toEqual({ [invoiceTargetKey(INVOICE)]: 20, [noteTargetKey(NOTE)]: 20 });
    // A refund still being written, or waiting for approval, holds the credit as a scheduled one does.
    for (const status of ['draft', 'pending_approval'] as const) {
      expect(refundable([invoice()], [note()], [refund({ status })])[invoiceTargetKey(INVOICE)], status).toBe(20);
    }
  });
  it('does not count a refund twice once it is paid out: the balance already has it', () => {
    // RM 10 paid out against the note: the view shows the customer RM 20 in credit and the note RM 10 refunded.
    const paidOut = refund({ status: 'posted', number: 'PV-0004', credit_note_id: NOTE, credit_note_no: 'CN-0003' });
    expect(
      refundable([invoice({ refunded: 10, balance: -20 })], [note({ refunded: 10 })], [paidOut]),
    ).toEqual({ [invoiceTargetKey(INVOICE)]: 20, [noteTargetKey(NOTE)]: 20 });
  });
  it('ignores refunds that were voided or rejected: they hold nothing', () => {
    for (const status of ['void', 'rejected'] as const) {
      expect(refundable([invoice()], [note()], [refund({ status })]), status).toEqual({
        [invoiceTargetKey(INVOICE)]: 30,
        [noteTargetKey(NOTE)]: 30,
      });
    }
  });
  it('offers nothing once pending refunds hold all of the credit', () => {
    expect(refundTargets([invoice()], [note()], [refund({ amount: 30 })])).toEqual([]);
    expect(refundTargets([invoice()], [note()], [refund({ amount: 20 }), refund({ allocation_id: 'a-2', transaction_id: 't-2' })])).toEqual([]);
  });
  it('caps a refund against a credit note at what is left of the note, counting pending refunds against it', () => {
    // Two credit notes, RM 30 and RM 50, on a paid invoice: RM 80 in credit.
    const inv = invoice({ credited: 80, balance: -80 });
    const notes = [note(), note({ id: NOTE_2, credit_note_no: 'CN-0004', amount: 50 })];
    expect(refundable([inv], notes, [])).toEqual({
      [invoiceTargetKey(INVOICE)]: 80,
      [noteTargetKey(NOTE)]: 30,
      [noteTargetKey(NOTE_2)]: 50,
    });
    // RM 10 pending against the first note: the invoice has RM 70 free, the first note RM 20, the second still RM 50.
    const pending = refund({ credit_note_id: NOTE, credit_note_no: 'CN-0003' });
    expect(refundable([inv], notes, [pending])).toEqual({
      [invoiceTargetKey(INVOICE)]: 70,
      [noteTargetKey(NOTE)]: 20,
      [noteTargetKey(NOTE_2)]: 50,
    });
    // RM 45 pending against the invoice itself: RM 35 free, which now limits the second note too.
    expect(refundable([inv], notes, [refund({ amount: 45 })])).toEqual({
      [invoiceTargetKey(INVOICE)]: 35,
      [noteTargetKey(NOTE)]: 30,
      [noteTargetKey(NOTE_2)]: 35,
    });
  });
  it('caps a refund against a credit note at the invoice’s credit when the note is larger than it', () => {
    // RM 100 invoiced, RM 60 paid, RM 50 credited: the customer is RM 10 in credit, not RM 50.
    const inv = invoice({ paid: 60, credited: 50, balance: -10 });
    expect(refundable([inv], [note({ amount: 50 })], [])).toEqual({ [invoiceTargetKey(INVOICE)]: 10, [noteTargetKey(NOTE)]: 10 });
  });
  it('leaves out a credit note that is a draft, void, or already refunded in full', () => {
    const inv = invoice({ credited: 80, balance: -50, refunded: 30 });
    const notes = [
      note({ refunded: 30 }),
      note({ id: NOTE_2, credit_note_no: 'CN-0004', amount: 50 }),
      note({ id: 'draft', credit_note_no: null, status: 'draft' }),
      note({ id: 'void', credit_note_no: 'CN-0002', status: 'void' }),
    ];
    expect(refundTargets([inv], notes, []).map((t) => t.key)).toEqual([invoiceTargetKey(INVOICE), noteTargetKey(NOTE_2)]);
  });
  it('works in whole sen', () => {
    const inv = invoice({ total: 1, paid: 1, credited: 0.3, balance: -0.3 });
    expect(refundable([inv], [note({ amount: 0.3 })], [refund({ amount: 0.1 })])).toEqual({
      [invoiceTargetKey(INVOICE)]: 0.2,
      [noteTargetKey(NOTE)]: 0.2,
    });
  });
  it('lists by customer, then invoice, each invoice before its credit notes', () => {
    const zaki = invoice({ id: 'z', invoice_no: 'INV-0002', customer_id: 'zaki', customer_name: 'Zaki Enterprise' });
    const targets = refundTargets(
      [zaki, invoice()],
      [note(), note({ id: 'zn', credit_note_no: 'CN-0001', invoice_id: 'z', customer_name: 'Zaki Enterprise' })],
      [],
    );
    expect(targets.map((t) => t.number)).toEqual(['INV-0007', 'CN-0003', 'INV-0002', 'CN-0001']);
  });
  it('names a target in the picker: a credit note with its invoice', () => {
    const [onInvoice, onNote] = refundTargets([invoice({ credited: 1240, balance: -1240 })], [note({ amount: 1240 })], []);
    expect(refundTargetLabel(onInvoice)).toBe('INV-0007 · Aisyah Trading · RM 1,240.00 can be refunded');
    expect(refundTargetLabel(onNote)).toBe('CN-0003 on INV-0007 · Aisyah Trading · RM 1,240.00 can be refunded');
  });
});

describe('a new refund form', () => {
  const two = refundTargets(
    [invoice(), invoice({ id: 'z', invoice_no: 'INV-0002', customer_name: 'Zaki Enterprise', credited: 50, balance: -50 })],
    [],
    [],
  );

  it('is paid out now, from the first bank account, by bank transfer, with nothing chosen', () => {
    expect(newRefundForm(two, accounts, '2026-10-09')).toEqual({
      target: '',
      amount: '',
      reason: '',
      accountId: BANK,
      date: '2026-10-09',
      method: 'bank_transfer',
      reference: '',
      notes: '',
      scheduled: false,
    });
    expect(newRefundForm(two, [], '2026-10-09').accountId).toBe('');
  });
  it('opens on the row it was started from, for all that can be refunded there', () => {
    const fromInvoice = newRefundForm(two, accounts, '2026-10-09', invoiceTargetKey(INVOICE));
    expect(fromInvoice).toMatchObject({ target: invoiceTargetKey(INVOICE), amount: '30.00' });
    const targets = refundTargets([invoice()], [note()], [refund()]);
    expect(newRefundForm(targets, accounts, '2026-10-09', noteTargetKey(NOTE))).toMatchObject({ target: noteTargetKey(NOTE), amount: '20.00' });
  });
  it('chooses the only thing that can be refunded, and nothing when the row it was started from can no longer be', () => {
    const [only] = refundTargets([invoice()], [], []);
    expect(newRefundForm([only], accounts, '2026-10-09')).toMatchObject({ target: only.key, amount: '30.00' });
    expect(newRefundForm(two, accounts, '2026-10-09', noteTargetKey(NOTE))).toMatchObject({ target: '', amount: '' });
    expect(newRefundForm([], accounts, '2026-10-09', invoiceTargetKey(INVOICE))).toMatchObject({ target: '', amount: '' });
  });
});

describe('choosing what to refund', () => {
  const targets = refundTargets([invoice({ credited: 80, balance: -80 })], [note()], []);
  const [onInvoice, onNote] = targets;
  const open = newRefundForm(targets, accounts, '2026-10-09', onInvoice.key);

  it('sets the amount to all the new choice can take, and keeps everything else', () => {
    const typed = { ...open, amount: '12', reason: 'overpayment' as const, notes: 'By cheque' };
    expect(chooseRefundTarget(typed, onNote)).toEqual({ ...typed, target: onNote.key, amount: '30.00' });
  });
  it('changes nothing when the same thing is chosen again', () => {
    const typed = { ...open, amount: '12' };
    expect(chooseRefundTarget(typed, onInvoice)).toBe(typed);
  });
  it('drops a choice that is no longer offered after a refresh, and keeps one that is', () => {
    expect(keepRefundTarget(open, targets)).toBe(open);
    expect(keepRefundTarget(open, [onNote])).toEqual({ ...open, target: '' });
    const empty = newRefundForm([], accounts, '2026-10-09');
    expect(keepRefundTarget(empty, [])).toBe(empty);
  });
});

describe('refundPayload', () => {
  const targets = refundTargets([invoice()], [note()], []);
  const form = (f: Partial<RefundForm> = {}): RefundForm => ({
    ...newRefundForm(targets, accounts, '2026-10-09', invoiceTargetKey(INVOICE)),
    reason: 'overpayment',
    ...f,
  });

  it('names the invoice, or the credit note, never both', () => {
    expect(refundPayload(form(), targets)).toEqual({
      invoice_id: INVOICE,
      credit_note_id: null,
      account_id: BANK,
      txn_date: '2026-10-09',
      method: 'bank_transfer',
      reason: 'overpayment',
      amount: 30,
      reference: '',
      notes: '',
      scheduled: false,
    });
    expect(refundPayload(form({ target: noteTargetKey(NOTE), scheduled: true }), targets)).toMatchObject({
      invoice_id: null,
      credit_note_id: NOTE,
      scheduled: true,
    });
  });
  it('names nothing when the choice is no longer offered, so the schema refuses it', () => {
    const sent = refundPayload(form({ target: noteTargetKey(NOTE_2) }), targets);
    expect(sent).toMatchObject({ invoice_id: null, credit_note_id: null });
    expect(recordRefundInput.safeParse(sent).success).toBe(false);
  });
  it('is what the write’s own schema accepts', () => {
    expect(recordRefundInput.safeParse(refundPayload(form(), targets)).success).toBe(true);
    expect(recordRefundInput.safeParse(refundPayload(form({ target: noteTargetKey(NOTE) }), targets)).success).toBe(true);
  });
});

describe('refundFormError', () => {
  const targets = refundTargets([invoice()], [note()], [refund()]);
  const form = (f: Partial<RefundForm> = {}): RefundForm => ({
    ...newRefundForm(targets, accounts, '2026-10-09', invoiceTargetKey(INVOICE)),
    reason: 'overpayment',
    ...f,
  });

  it('lets a form through that can be saved, for all that can be refunded or less', () => {
    expect(form().amount).toBe('20.00');
    expect(refundFormError(form(), targets)).toBeNull();
    expect(refundFormError(form({ amount: '0.01' }), targets)).toBeNull();
    expect(refundFormError(form({ scheduled: true }), targets)).toBeNull();
  });
  it('asks first what the refund is for, also when the choice went while the form was open', () => {
    const sentence = 'Choose the invoice or the credit note this refund is for.';
    expect(refundFormError(form({ target: '', accountId: '', reason: '' }), targets)).toBe(sentence);
    expect(refundFormError(form({ target: noteTargetKey(NOTE_2) }), targets)).toBe(sentence);
    expect(refundFormError(keepRefundTarget(form(), []), [])).toBe(sentence);
  });
  it('asks for an account, a real date and a reason, in the schema’s own sentences', () => {
    expect(refundFormError(form({ accountId: '' }), targets)).toBe('Choose the account the money leaves.');
    expect(refundFormError(form({ date: '2026-02-30' }), targets)).toBe('Enter a valid date.');
    expect(refundFormError(form({ reason: '' }), targets)).toBe('Choose a reason.');
    expect(refundFormError(form({ reference: 'x'.repeat(201) }), targets)).toBe('That is too long. Keep it to 200 characters or fewer.');
  });
  it('refuses an empty amount, nothing, and a figure typed with a comma', () => {
    for (const amount of ['', '0', '0.004', '-5', '1,200.50', 'abc']) {
      expect(refundFormError(form({ amount }), targets), amount).toBe('Enter an amount above 0.');
    }
  });
  it('refuses a sen more than can be refunded, counting the refund that is pending, before the database is asked', () => {
    // RM 30 in credit, RM 10 of it held by a pending refund.
    expect(refundFormError(form({ amount: '20.01' }), targets)).toBe(
      'That is more than the customer is in credit, or more than is left of the credit note.',
    );
    expect(refundFormError(form({ amount: '30' }), targets)).toBe(
      'That is more than the customer is in credit, or more than is left of the credit note.',
    );
    expect(refundFormError(form({ amount: '20.004' }), targets)).toBeNull();
  });
});
```

Create `tests/finance-refund-rules.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { RefundRow } from '@/lib/finance/refunds';
import { REFUND_STATUS_LABELS, isPendingRefund, refundActions, refundName } from '@/lib/finance/sales-followon-views';

const refund = (status: RefundRow['status'], r: Partial<RefundRow> = {}): RefundRow => ({
  allocation_id: 'a-1',
  transaction_id: 't-1',
  number: status === 'posted' || status === 'void' ? 'PV-0004' : null,
  txn_date: '2026-10-07',
  method: 'fpx',
  amount: 30,
  transaction_amount: 30,
  status,
  reference: null,
  reason: 'damaged_goods',
  notes: null,
  account_id: 'bank',
  account_name: 'Main Bank',
  invoice_id: 'invoice-1',
  invoice_no: 'INV-0007',
  credit_note_id: null,
  credit_note_no: null,
  customer_id: 'aisyah',
  customer_name: 'Aisyah Trading',
  ...r,
});

describe('refundActions', () => {
  it('lets a pending refund be marked as paid or deleted, and never voided', () => {
    expect(refundActions(refund('scheduled'))).toEqual(['markPaid', 'delete']);
  });
  it('lets a refund that was paid out be voided, and nothing else: it is locked', () => {
    expect(refundActions(refund('posted'))).toEqual(['void']);
  });
  it('offers nothing on a void refund, nor on one in a state the app never makes', () => {
    // The database marks only a scheduled payment as paid; a draft or one waiting for approval is refused (FIN09).
    for (const status of ['void', 'draft', 'pending_approval', 'rejected'] as const) {
      expect(refundActions(refund(status)), status).toEqual([]);
    }
  });
  it('has no edit on any refund: a pending one is deleted and recorded again', () => {
    for (const status of ['scheduled', 'posted', 'void', 'draft', 'pending_approval', 'rejected'] as const) {
      expect(refundActions(refund(status)) as string[], status).not.toContain('edit');
    }
  });
});

describe('refundName', () => {
  it('names a refund by its voucher number and customer, and one not yet paid out as pending', () => {
    expect(refundName(refund('posted'))).toBe('PV-0004 to Aisyah Trading');
    expect(refundName(refund('scheduled'))).toBe('the pending refund to Aisyah Trading');
  });
});

describe('a refund still being written', () => {
  it('counts and reads as pending, like a scheduled one', () => {
    expect(isPendingRefund(refund('draft'))).toBe(true);
    expect(REFUND_STATUS_LABELS.draft).toBe(REFUND_STATUS_LABELS.scheduled);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run tests/finance-refund-form.test.ts tests/finance-refund-rules.test.ts`
Expected: FAIL, both files: `@/lib/finance/refund-form` does not exist, and `refundActions` is not exported from `sales-followon-views`.

- [ ] **Step 3: Write the refund form's rules**

Create `src/lib/finance/refund-form.ts`:

```ts
/**
 * The refund form's rules, kept out of the component so they can be tested:
 * what can be refunded and for how much, what a new form holds, what is
 * wrong with the form, and what is sent to recordRefundAction. Pure. A
 * refund is one payment out against one invoice or one credit note, with a
 * reason, so it does not share the payment card, which splits one payment
 * across many documents.
 */
import { amountText, defaultAccount, sen } from './allocation-form';
import type { CreditNoteRow } from './credit-notes';
import { rm, typedNumber } from './format';
import type { InvoiceListRow } from './invoices';
import type { FinanceAccount, PaymentMethod } from './money';
import { REFUND_MESSAGES, type RefundReason, type RefundRow, recordRefundInput } from './refunds';
import { isPendingRefund } from './sales-followon-views';
import { inCredit } from './sales-views';

const M = REFUND_MESSAGES;

/** One thing a refund can be put against: an invoice whose customer is in credit, or one of its issued credit notes. */
export type RefundTarget = {
  /** The value of the form's picker: `invoice:<id>` or `note:<id>`. */
  key: string;
  kind: 'invoice' | 'credit_note';
  /** The invoice's id or the credit note's id, by `kind`. */
  id: string;
  /** INV-0007 or CN-0003. */
  number: string;
  /** The invoice the credit sits on, whichever the refund is put against. */
  invoice_id: string;
  invoice_no: string;
  customer_name: string;
  /** The most a new refund against it may be. */
  refundable: number;
};

export type RefundForm = {
  /** The key of what the refund is put against; empty until chosen. */
  target: string;
  /** The amount as typed. */
  amount: string;
  /** Empty until a reason is chosen. */
  reason: RefundReason | '';
  accountId: string;
  date: string;
  method: PaymentMethod;
  reference: string;
  notes: string;
  /** True for a refund still to be paid out: it holds the customer's credit until it is marked paid or deleted. */
  scheduled: boolean;
};

export const invoiceTargetKey = (invoiceId: string) => `invoice:${invoiceId}`;
export const noteTargetKey = (creditNoteId: string) => `note:${creditNoteId}`;

/** What refunds not yet paid out add up to, in sen, by whatever `of` picks from each. */
function pendingSen(refunds: RefundRow[], of: (refund: RefundRow) => string | null): Map<string, number> {
  const held = new Map<string, number>();
  for (const refund of refunds) {
    const id = of(refund);
    if (id !== null && isPendingRefund(refund)) held.set(id, (held.get(id) ?? 0) + sen(refund.amount));
  }
  return held;
}

/**
 * Everything a refund can be recorded against, and the most each can take:
 * exactly what the database allows, so the form offers nothing it would
 * refuse.
 *
 * An invoice: what its customer is in credit there (its balance below zero,
 * which already has every refund that was paid out in it), less refunds that
 * are still pending against the invoice or against any of its credit notes.
 * A refund row names its invoice whichever of the two it was put against, so
 * one sum covers both.
 *
 * An issued credit note of such an invoice: the same figure, and also no more
 * than the note's amount less every refund standing against the note itself,
 * paid out (`refunded`) or pending.
 *
 * Listed by customer, then invoice; an invoice first, then its credit notes.
 */
export function refundTargets(invoices: InvoiceListRow[], creditNotes: CreditNoteRow[], refunds: RefundRow[]): RefundTarget[] {
  const pendingOnInvoice = pendingSen(refunds, (r) => r.invoice_id);
  const pendingOnNote = pendingSen(refunds, (r) => r.credit_note_id);
  const targets: RefundTarget[] = [];
  const ordered = [...invoices].sort(
    (x, y) => x.customer_name.localeCompare(y.customer_name) || (x.invoice_no ?? '').localeCompare(y.invoice_no ?? ''),
  );
  for (const invoice of ordered) {
    const free = sen(inCredit(invoice)) - (pendingOnInvoice.get(invoice.id) ?? 0);
    if (free <= 0) continue;
    const shared = { invoice_id: invoice.id, invoice_no: invoice.invoice_no ?? '—', customer_name: invoice.customer_name };
    targets.push({
      key: invoiceTargetKey(invoice.id),
      kind: 'invoice',
      id: invoice.id,
      number: shared.invoice_no,
      ...shared,
      refundable: free / 100,
    });
    const notes = creditNotes
      .filter((n) => n.invoice_id === invoice.id && n.status === 'issued')
      .sort((x, y) => (x.credit_note_no ?? '').localeCompare(y.credit_note_no ?? ''));
    for (const note of notes) {
      const left = sen(note.amount) - sen(note.refunded) - (pendingOnNote.get(note.id) ?? 0);
      const refundable = Math.min(free, left);
      if (refundable <= 0) continue;
      targets.push({
        key: noteTargetKey(note.id),
        kind: 'credit_note',
        id: note.id,
        number: note.credit_note_no ?? '—',
        ...shared,
        refundable: refundable / 100,
      });
    }
  }
  return targets;
}

/** How the form's picker lists a target: its number (a credit note with its invoice), the customer, and what can be refunded. */
export function refundTargetLabel(target: RefundTarget): string {
  const number = target.kind === 'invoice' ? target.number : `${target.number} on ${target.invoice_no}`;
  return `${number} · ${target.customer_name} · ${rm(target.refundable)} can be refunded`;
}

/**
 * A fresh form: paid out now, from the first bank account, by bank transfer.
 * With `preselect` (the Refund choice on an invoice's or a credit note's
 * row), or when only one thing can be refunded, that is chosen and the
 * amount is all it can take, which is what a refund most often is.
 */
export function newRefundForm(targets: RefundTarget[], accounts: FinanceAccount[], today: string, preselect?: string): RefundForm {
  const chosen = targets.find((t) => t.key === preselect) ?? (targets.length === 1 ? targets[0] : undefined);
  return {
    target: chosen?.key ?? '',
    amount: chosen ? amountText(chosen.refundable) : '',
    reason: '',
    accountId: defaultAccount(accounts),
    date: today,
    method: 'bank_transfer',
    reference: '',
    notes: '',
    scheduled: false,
  };
}

/** Choosing what to refund sets the amount to all it can take; the person can then lower it. */
export function chooseRefundTarget(form: RefundForm, target: RefundTarget): RefundForm {
  return target.key === form.target ? form : { ...form, target: target.key, amount: amountText(target.refundable) };
}

/**
 * After a refresh, the chosen target may no longer be offered: its credit was
 * refunded or went in another tab. The choice goes, so the picker does not
 * show something that cannot be saved. The same form when it is still there.
 */
export function keepRefundTarget(form: RefundForm, targets: RefundTarget[]): RefundForm {
  return form.target === '' || targets.some((t) => t.key === form.target) ? form : { ...form, target: '' };
}

/**
 * What is sent to recordRefundAction: the invoice or the credit note, never
 * both. The amount is a number; a box that is not a number goes as NaN and
 * is refused.
 */
export function refundPayload(form: RefundForm, targets: RefundTarget[]) {
  const target = targets.find((t) => t.key === form.target);
  return {
    invoice_id: target?.kind === 'invoice' ? target.id : null,
    credit_note_id: target?.kind === 'credit_note' ? target.id : null,
    account_id: form.accountId,
    txn_date: form.date,
    method: form.method,
    reason: form.reason,
    amount: typedNumber(form.amount) ?? Number.NaN,
    reference: form.reference,
    notes: form.notes,
    scheduled: form.scheduled,
  };
}

/**
 * The first thing wrong with the form, in the sentence the schema or the
 * database would use, or null when it can be sent. What is being refunded
 * comes first, as it is first on the form.
 */
export function refundFormError(form: RefundForm, targets: RefundTarget[]): string | null {
  const target = targets.find((t) => t.key === form.target);
  if (!target) return M.document;
  const parsed = recordRefundInput.safeParse(refundPayload(form, targets));
  if (!parsed.success) return parsed.error.issues[0]?.message ?? M.amount;
  return sen(parsed.data.amount) > sen(target.refundable) ? M.tooMuch : null;
}
```

`refund-form.ts` imports `sales-followon-views.ts`, which must never import it back: the menu's rule below takes a row and nothing from the form.

- [ ] **Step 4: Write the menu's rule**

In `src/lib/finance/sales-followon-views.ts`, replace:

```ts
/** Recorded but not yet money out: it holds the customer's credit. */
export function isPendingRefund(row: RefundRow): boolean {
  return row.status === 'scheduled' || row.status === 'draft' || row.status === 'pending_approval';
}
```

with:

```ts
/** Recorded but not yet money out: it holds the customer's credit. */
export function isPendingRefund(row: RefundRow): boolean {
  return row.status === 'scheduled' || row.status === 'draft' || row.status === 'pending_approval';
}

export type RefundAction = 'markPaid' | 'delete' | 'void';

/**
 * What a refund's row menu offers, in order: only what the database allows
 * for its status. A pending refund (`scheduled`) is marked as paid or
 * deleted, never voided. One that was paid out is locked and can only be
 * voided. There is no edit: a pending refund is deleted and recorded again,
 * as a scheduled payment to a supplier is. A void refund offers nothing, and
 * neither does one in a state the app never makes (`draft`,
 * `pending_approval`, `rejected`): the database marks only a scheduled
 * payment as paid.
 */
export function refundActions(row: RefundRow): RefundAction[] {
  if (row.status === 'scheduled') return ['markPaid', 'delete'];
  if (row.status === 'posted') return ['void'];
  return [];
}

/** How a question or a menu names one refund: its voucher number, or "the pending refund", and its customer. */
export function refundName(row: RefundRow): string {
  return `${row.number ?? 'the pending refund'} to ${row.customer_name}`;
}
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `pnpm exec vitest run tests/finance-refund-form.test.ts tests/finance-refund-rules.test.ts tests/finance-followon-views.test.ts`
Expected: PASS, all three files.

- [ ] **Step 6: Type-check, lint, and run the unit tests**

Run, as separate commands: `pnpm exec tsc --noEmit`, `pnpm lint`, `pnpm exec vitest run --exclude 'tests/*.rls.test.ts' --exclude 'tests/bendahara-*.test.ts'`
Expected: no type errors; no lint errors; every unit test passes, 4,138 in all.

- [ ] **Step 7: Commit**

```bash
git add src/lib/finance/refund-form.ts src/lib/finance/sales-followon-views.ts tests/finance-refund-form.test.ts tests/finance-refund-rules.test.ts
git commit -m "feat: the rules of the refund form and of a refund's row menu"
```

---


### Task 4: Server actions for credit notes and refunds

**Files:**
- Modify: `src/app/(app)/finance/actions.ts`
- Create: `tests/finance-credit-refund-actions.test.ts`

**Interfaces:**
- Consumes: `saveCreditNote`, `issueCreditNote`, `voidCreditNote`, `deleteCreditNote`, `saveCreditNoteInput`, `creditNoteIdInput`, `SaveAndIssueCreditNoteResult` (Task 1) from `@/lib/finance/credit-notes`; `recordRefund`, `markRefundPaid`, `voidRefund`, `deleteRefund`, `recordRefundInput` from `@/lib/finance/refunds`; `markPaymentPaidInput`, `paymentIdInput` from `@/lib/finance/money` (already imported in the actions file); the existing `writeCtx`, `run`, `saveThenPost`, `refresh`, `firstMessage`, `FORBIDDEN` in the actions file.
- Produces, all in `@/app/(app)/finance/actions`, each taking `input: unknown`:
  - `saveCreditNoteAction`, `voidCreditNoteAction`, `deleteCreditNoteAction` → `Promise<FinResult<{ id: string }>>`
  - `issueCreditNoteAction` → `Promise<FinResult<{ id: string; credit_note_no: string }>>`
  - `saveAndIssueCreditNoteAction` → `Promise<SaveAndIssueCreditNoteResult>`
  - `recordRefundAction`, `voidRefundAction`, `deleteRefundAction` → `Promise<FinResult<{ id: string }>>`
  - `markRefundPaidAction` → `Promise<FinResult<{ id: string; number: string }>>`

How they behave:

- Every one goes through `writeCtx` (inside `run` or `saveThenPost`): a viewer and the demo workspace are answered "You do not have permission to make changes here." before anything is parsed, read or written. Without that, a viewer's Void or Delete would read "That credit note no longer exists." or "That refund no longer exists.": the database answers a viewer's update or delete with no row, `finance_issue_credit_note` answers a viewer with `FIN11` because a viewer may not lock the row, and the three refund writes read the view `finance_refunds` first.
- Every write refreshes its screens after any attempt that reached the database, refused or not. Which screens is the table under "Which screens each action refreshes" near the top of this plan: Credit Notes alone for a draft saved or deleted; five screens for everything else. Never Payments Out, and never Quotations.
- `saveAndIssueCreditNoteAction` is `saveThenPost` with the credit note's save and issue: when the save works and the issue is refused, the draft stays and the answer carries its id.
- There is no `getCreditNoteAction` (Decision 6): a credit note has no lines, and the list row carries everything the Edit form shows.
- A refund's id is a payment's: `markRefundPaidAction`, `voidRefundAction` and `deleteRefundAction` parse with `markPaymentPaidInput` and `paymentIdInput`, as the data layer does. An id that is not an id is answered "That payment no longer exists." by those schemas; only a direct call can send one.
- No constant, type or helper is exported: a `'use server'` file exports only async functions.

- [ ] **Step 1: Write the failing tests**

Create `tests/finance-credit-refund-actions.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const NOTE = '33333333-3333-4333-8333-333333333333';
const INVOICE = '55555555-5555-4555-8555-555555555555';
const TXN = '66666666-6666-4666-8666-666666666666';
const ACCOUNT = '77777777-7777-4777-8777-777777777777';

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

vi.mock('@/lib/finance/credit-notes', async (orig) => {
  const actual = await orig<typeof import('@/lib/finance/credit-notes')>();
  return {
    ...actual,
    saveCreditNote: recorder('saveCreditNote', { id: '33333333-3333-4333-8333-333333333333' }),
    issueCreditNote: recorder('issueCreditNote', { id: '33333333-3333-4333-8333-333333333333', credit_note_no: 'CN-0007' }),
    voidCreditNote: recorder('voidCreditNote', { id: '33333333-3333-4333-8333-333333333333' }),
    deleteCreditNote: recorder('deleteCreditNote', { id: '33333333-3333-4333-8333-333333333333' }),
  };
});

vi.mock('@/lib/finance/refunds', async (orig) => {
  const actual = await orig<typeof import('@/lib/finance/refunds')>();
  return {
    ...actual,
    recordRefund: recorder('recordRefund', { id: '66666666-6666-4666-8666-666666666666' }),
    markRefundPaid: recorder('markRefundPaid', { id: '66666666-6666-4666-8666-666666666666', number: 'PV-0004' }),
    voidRefund: recorder('voidRefund', { id: '66666666-6666-4666-8666-666666666666' }),
    deleteRefund: recorder('deleteRefund', { id: '66666666-6666-4666-8666-666666666666' }),
  };
});

const actions = await import('@/app/(app)/finance/actions');

/** Credit Notes alone: a draft credit note takes nothing off its invoice. */
const DRAFTS = ['/finance/credit-notes'];
/** The five screens where a figure moves when an invoice's balance or a customer's credit does. */
const CREDIT = [
  '/finance/invoices',
  '/finance/payments-in',
  '/finance/customers-suppliers',
  '/finance/credit-notes',
  '/finance/refunds',
];
const FORBIDDEN = { ok: false, error: 'You do not have permission to make changes here.' };
const NOTE_LOCKED =
  'That cannot be done to this credit note as it now stands. It may have been issued or voided since this page was loaded.';
const REFUND_LOCKED =
  'That cannot be done to this refund as it now stands. It may have been paid out or voided since this page was loaded.';

const note = { invoice_id: INVOICE, credit_date: '2026-10-06', reason: 'returns', amount: 30 };
const refund = {
  invoice_id: INVOICE,
  account_id: ACCOUNT,
  txn_date: '2026-10-07',
  method: 'bank_transfer',
  reason: 'overpayment',
  amount: 30,
};

/** Every write action with an input its schema accepts, the data-layer function it must call, and the screens it refreshes. */
const writes: [string, (input: unknown) => Promise<Answer>, unknown, string, string[]][] = [
  ['saveCreditNoteAction', actions.saveCreditNoteAction, note, 'saveCreditNote', DRAFTS],
  ['issueCreditNoteAction', actions.issueCreditNoteAction, { id: NOTE }, 'issueCreditNote', CREDIT],
  ['voidCreditNoteAction', actions.voidCreditNoteAction, { id: NOTE }, 'voidCreditNote', CREDIT],
  ['deleteCreditNoteAction', actions.deleteCreditNoteAction, { id: NOTE }, 'deleteCreditNote', DRAFTS],
  ['recordRefundAction', actions.recordRefundAction, refund, 'recordRefund', CREDIT],
  ['markRefundPaidAction', actions.markRefundPaidAction, { id: TXN, paid_on: '2026-10-09' }, 'markRefundPaid', CREDIT],
  ['voidRefundAction', actions.voidRefundAction, { id: TXN }, 'voidRefund', CREDIT],
  ['deleteRefundAction', actions.deleteRefundAction, { id: TXN }, 'deleteRefund', CREDIT],
];

beforeEach(() => {
  ctl.viewer = { userId: 'u1', orgId: 'org1', role: 'member', isDemo: false };
  ctl.calls = [];
  ctl.revalidated = [];
  ctl.answers = {};
});

describe('who may write', () => {
  it('refuses a viewer and the demo workspace on every action, before anything is parsed, read or written', async () => {
    for (const viewer of [
      { userId: 'u1', orgId: 'org1', role: 'viewer', isDemo: false },
      { userId: 'u1', orgId: 'org1', role: 'owner', isDemo: true },
    ]) {
      ctl.viewer = viewer;
      for (const [name, action, input] of writes) expect(await action(input), name).toEqual(FORBIDDEN);
      expect(await actions.saveAndIssueCreditNoteAction(note)).toEqual(FORBIDDEN);
      // Not even a malformed input gets a schema's sentence: the refusal comes first.
      expect(await actions.saveCreditNoteAction({ amount: 'lots' })).toEqual(FORBIDDEN);
      expect(await actions.recordRefundAction(null)).toEqual(FORBIDDEN);
      expect(await actions.markRefundPaidAction({ id: 'nope' })).toEqual(FORBIDDEN);
    }
    expect(ctl.calls).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
  });

  it('tells a viewer they may not, not that the credit note or the refund is gone', async () => {
    ctl.viewer = { userId: 'u1', orgId: 'org1', role: 'viewer', isDemo: false };
    // The database would answer a viewer's update or delete with no row, and the issue function with FIN11;
    // the refund writes read a view first. All of it would read "no longer exists".
    for (const fn of ['issueCreditNote', 'voidCreditNote', 'deleteCreditNote']) {
      ctl.answers[fn] = { ok: false, error: 'That credit note no longer exists.' };
    }
    for (const fn of ['markRefundPaid', 'voidRefund', 'deleteRefund']) {
      ctl.answers[fn] = { ok: false, error: 'That refund no longer exists.' };
    }
    expect(await actions.issueCreditNoteAction({ id: NOTE })).toEqual(FORBIDDEN);
    expect(await actions.voidCreditNoteAction({ id: NOTE })).toEqual(FORBIDDEN);
    expect(await actions.deleteCreditNoteAction({ id: NOTE })).toEqual(FORBIDDEN);
    expect(await actions.markRefundPaidAction({ id: TXN, paid_on: '2026-10-09' })).toEqual(FORBIDDEN);
    expect(await actions.voidRefundAction({ id: TXN })).toEqual(FORBIDDEN);
    expect(await actions.deleteRefundAction({ id: TXN })).toEqual(FORBIDDEN);
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

  it('never refreshes Payments Out or Quotations: a refund is not on the first, and neither names a credit note', async () => {
    for (const [name, action, input] of writes) {
      ctl.revalidated = [];
      await action(input);
      expect(ctl.revalidated, name).not.toContain('/finance/payments-out');
      expect(ctl.revalidated, name).not.toContain('/finance/supplier-bills');
      expect(ctl.revalidated, name).not.toContain('/finance/quotations');
    }
  });

  it('refreshes Credit Notes alone for a draft, and the five screens once an invoice’s balance can move', async () => {
    for (const [name, action, input, fn] of writes) {
      ctl.revalidated = [];
      await action(input);
      const draftOnly = fn === 'saveCreditNote' || fn === 'deleteCreditNote';
      expect(ctl.revalidated.includes('/finance/invoices'), name).toBe(!draftOnly);
      expect(ctl.revalidated, name).toContain('/finance/credit-notes');
    }
  });

  it('never takes the workspace from the input', async () => {
    await actions.saveCreditNoteAction({ ...note, org_id: 'someone-else' });
    await actions.recordRefundAction({ ...refund, org_id: 'someone-else', target_org: 'someone-else' });
    await actions.voidRefundAction({ id: TXN, org_id: 'someone-else' });
    expect(ctl.calls.map((c) => c.orgId)).toEqual(['org1', 'org1', 'org1']);
    expect(JSON.stringify(ctl.calls)).not.toContain('someone-else');
  });

  it('answers with the schema’s sentence, touching nothing, when the input is refused', async () => {
    expect(await actions.saveCreditNoteAction({ ...note, invoice_id: '' })).toEqual({
      ok: false,
      error: 'Choose the invoice this credit note is against.',
    });
    expect(await actions.saveCreditNoteAction({ ...note, reason: '' })).toEqual({ ok: false, error: 'Choose a reason.' });
    expect(await actions.saveCreditNoteAction({ ...note, amount: Number.NaN })).toEqual({ ok: false, error: 'Enter an amount above 0.' });
    expect(await actions.recordRefundAction({ ...refund, invoice_id: null })).toEqual({
      ok: false,
      error: 'Choose the invoice or the credit note this refund is for.',
    });
    expect(await actions.recordRefundAction({ ...refund, credit_note_id: NOTE })).toEqual({
      ok: false,
      error: 'Choose the invoice or the credit note this refund is for.',
    });
    expect(await actions.recordRefundAction({ ...refund, account_id: '' })).toEqual({
      ok: false,
      error: 'Choose the account the money leaves.',
    });
    expect(await actions.markRefundPaidAction({ id: TXN, paid_on: '2026-02-30' })).toEqual({ ok: false, error: 'Enter a valid date.' });
    for (const action of [actions.issueCreditNoteAction, actions.voidCreditNoteAction, actions.deleteCreditNoteAction]) {
      expect(await action({ id: 'nope' })).toEqual({ ok: false, error: 'That credit note no longer exists.' });
      expect(await action(null)).toMatchObject({ ok: false });
    }
    for (const action of [actions.voidRefundAction, actions.deleteRefundAction]) {
      expect(await action({ id: 'nope' })).toEqual({ ok: false, error: 'That payment no longer exists.' });
      expect(await action(null)).toMatchObject({ ok: false });
    }
    expect(ctl.calls).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
  });

  it('hands the data layer the parsed input: text trimmed, empties as null, amounts to the sen', async () => {
    await actions.saveCreditNoteAction({ ...note, amount: 30.005, notes: '  ' });
    expect(ctl.calls[0].input).toEqual({ ...note, amount: 30.01, notes: null });
    await actions.recordRefundAction({ ...refund, invoice_id: '', credit_note_id: NOTE, reference: ' TT 88 ', scheduled: true });
    expect(ctl.calls[1].input).toEqual({
      ...refund,
      invoice_id: null,
      credit_note_id: NOTE,
      reference: 'TT 88',
      notes: null,
      scheduled: true,
    });
  });

  it('refreshes the screens after a refusal too, so what someone else changed shows as it now is', async () => {
    // Issued in another tab while this one still offered Issue.
    ctl.answers.issueCreditNote = { ok: false, error: NOTE_LOCKED };
    expect(await actions.issueCreditNoteAction({ id: NOTE })).toEqual(ctl.answers.issueCreditNote);
    expect(ctl.revalidated).toEqual(CREDIT);

    // A refund was recorded against it in another tab: voiding it here is refused, and the screens show the refund.
    ctl.revalidated = [];
    ctl.answers.voidCreditNote = {
      ok: false,
      error: 'A refund depends on this credit note. Void or delete that refund on Refunds before voiding it.',
    };
    expect(await actions.voidCreditNoteAction({ id: NOTE })).toEqual(ctl.answers.voidCreditNote);
    expect(ctl.revalidated).toEqual(CREDIT);

    // Paid out in another tab while this one still offered Delete.
    ctl.revalidated = [];
    ctl.answers.deleteRefund = { ok: false, error: REFUND_LOCKED };
    expect(await actions.deleteRefundAction({ id: TXN })).toEqual(ctl.answers.deleteRefund);
    expect(ctl.revalidated).toEqual(CREDIT);

    // The credit went while the form was open.
    ctl.revalidated = [];
    ctl.answers.recordRefund = {
      ok: false,
      error: 'That is more than the customer is in credit, or more than is left of the credit note.',
    };
    expect(await actions.recordRefundAction(refund)).toEqual(ctl.answers.recordRefund);
    expect(ctl.revalidated).toEqual(CREDIT);
  });
});

describe('saveAndIssueCreditNoteAction', () => {
  it('saves, then issues what it saved, answers with the number, and refreshes the five screens', async () => {
    expect(await actions.saveAndIssueCreditNoteAction(note)).toEqual({ ok: true, data: { id: NOTE, credit_note_no: 'CN-0007' } });
    expect(ctl.calls.map((c) => c.fn)).toEqual(['saveCreditNote', 'issueCreditNote']);
    expect(ctl.calls[1].input).toEqual({ id: NOTE });
    expect(ctl.revalidated).toEqual(CREDIT);
  });

  it('does not issue when the save is refused', async () => {
    ctl.answers.saveCreditNote = { ok: false, error: 'That is more than this invoice has left to credit.' };
    expect(await actions.saveAndIssueCreditNoteAction(note)).toEqual(ctl.answers.saveCreditNote);
    expect(ctl.calls.map((c) => c.fn)).toEqual(['saveCreditNote']);
    expect(ctl.revalidated).toEqual(CREDIT);
  });

  it('keeps the draft when issuing is refused, and says which draft it is', async () => {
    // Another credit note for the same invoice was issued between the save and the issue.
    ctl.answers.issueCreditNote = { ok: false, error: 'That is more than this invoice has left to credit.' };
    expect(await actions.saveAndIssueCreditNoteAction(note)).toEqual({
      ok: false,
      error: 'That is more than this invoice has left to credit.',
      draftId: NOTE,
    });
    expect(ctl.calls.map((c) => c.fn)).toEqual(['saveCreditNote', 'issueCreditNote']);
    expect(ctl.revalidated).toEqual(CREDIT);
  });

  it('answers with the schema’s sentence and saves nothing when the form is refused', async () => {
    expect(await actions.saveAndIssueCreditNoteAction({ ...note, reason: 'because' })).toEqual({ ok: false, error: 'Choose a reason.' });
    expect(ctl.calls).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run tests/finance-credit-refund-actions.test.ts`
Expected: FAIL, every test: `actions.saveCreditNoteAction` and the other eight are not functions.

- [ ] **Step 3: Write the actions**

Four edits to `src/app/(app)/finance/actions.ts`.

In `src/app/(app)/finance/actions.ts`, replace:

```ts
import {
  INVOICE_MESSAGES,
  type InvoiceDetail,
```

with:

```ts
import {
  type SaveAndIssueCreditNoteResult,
  creditNoteIdInput,
  deleteCreditNote,
  issueCreditNote,
  saveCreditNote,
  saveCreditNoteInput,
  voidCreditNote,
} from '@/lib/finance/credit-notes';
import {
  INVOICE_MESSAGES,
  type InvoiceDetail,
```

In `src/app/(app)/finance/actions.ts`, replace:

```ts
import { type FinResult, type FinanceWriteContext, NOT_ALLOWED, READ_FAILED } from '@/lib/finance/result';
```

with:

```ts
import { deleteRefund, markRefundPaid, recordRefund, recordRefundInput, voidRefund } from '@/lib/finance/refunds';
import { type FinResult, type FinanceWriteContext, NOT_ALLOWED, READ_FAILED } from '@/lib/finance/result';
```

In `src/app/(app)/finance/actions.ts`, replace:

```ts
const CONVERT_PATHS = ['/finance/quotations', '/finance/invoices'];
```

with:

```ts
const CONVERT_PATHS = ['/finance/quotations', '/finance/invoices'];
// A credit note that is issued or voided, and a refund at any step, change what an invoice owes or what its
// customer is in credit. That shows on Invoices (Balance, status, Total receivable, and whether a row offers
// a payment, a credit note or a refund), in the payment form on Payments In (which invoices can be paid, and
// for how much), on Customers & Suppliers (Receivable), on Credit Notes (Refunded, and whether a row offers
// a refund) and on Refunds. Quotations names an invoice by its number only, and Payments Out never shows a
// refund: neither is here.
const CREDIT_PATHS = [
  '/finance/invoices',
  '/finance/payments-in',
  '/finance/customers-suppliers',
  '/finance/credit-notes',
  '/finance/refunds',
];
// A draft credit note takes nothing off its invoice and nothing can be refunded against it: saving or
// deleting one moves no figure and no menu anywhere but on Credit Notes.
const CREDIT_NOTE_DRAFT_PATHS = ['/finance/credit-notes'];
```

In `src/app/(app)/finance/actions.ts`, replace:

```ts
/* ---- payments in ------------------------------------------------------- */

export async function recordPaymentInAction(input: unknown) {
```

with:

```ts
/* ---- credit notes ------------------------------------------------------ */

/** Creates a draft credit note, or changes one. A draft moves nothing but its own list. */
export async function saveCreditNoteAction(input: unknown) {
  return run(CREDIT_NOTE_DRAFT_PATHS, saveCreditNoteInput, input, saveCreditNote);
}
/** Issues a draft: it gets its number and is locked, and its invoice owes that much less. */
export async function issueCreditNoteAction(input: unknown) {
  return run(CREDIT_PATHS, creditNoteIdInput, input, issueCreditNote);
}
/** Voids an issued credit note: its invoice owes the amount again. Refused while a refund depends on it. */
export async function voidCreditNoteAction(input: unknown) {
  return run(CREDIT_PATHS, creditNoteIdInput, input, voidCreditNote);
}
export async function deleteCreditNoteAction(input: unknown) {
  return run(CREDIT_NOTE_DRAFT_PATHS, creditNoteIdInput, input, deleteCreditNote);
}

/** Saves the credit note as a draft, then issues it; see `saveThenPost`. */
export async function saveAndIssueCreditNoteAction(input: unknown): Promise<SaveAndIssueCreditNoteResult> {
  return saveThenPost(CREDIT_PATHS, saveCreditNoteInput, input, saveCreditNote, issueCreditNote);
}

/* ---- refunds ----------------------------------------------------------- */

/** Records a refund against one invoice or one credit note, paid out now or left pending. */
export async function recordRefundAction(input: unknown) {
  return run(CREDIT_PATHS, recordRefundInput, input, recordRefund);
}
/** A pending refund has been paid out. The database looks at the customer's credit again and may refuse. */
export async function markRefundPaidAction(input: unknown) {
  return run(CREDIT_PATHS, markPaymentPaidInput, input, markRefundPaid);
}
/** Voids a refund that was paid out: the customer is in credit by that amount again. */
export async function voidRefundAction(input: unknown) {
  return run(CREDIT_PATHS, paymentIdInput, input, voidRefund);
}
export async function deleteRefundAction(input: unknown) {
  return run(CREDIT_PATHS, paymentIdInput, input, deleteRefund);
}

/* ---- payments in ------------------------------------------------------- */

export async function recordPaymentInAction(input: unknown) {
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm exec vitest run tests/finance-credit-refund-actions.test.ts tests/finance-quotation-actions.test.ts tests/finance-sales-actions.test.ts tests/finance-actions.test.ts`
Expected: PASS, all four files. The last three are unedited: no existing action changed.

- [ ] **Step 5: Check the file still exports only async functions**

Run: `grep -n "^export" "src/app/(app)/finance/actions.ts" | grep -v "export async function"`
Expected: no output.

- [ ] **Step 6: Type-check, lint, and run the unit tests**

Run, as separate commands: `pnpm exec tsc --noEmit`, `pnpm lint`, `pnpm exec vitest run --exclude 'tests/*.rls.test.ts' --exclude 'tests/bendahara-*.test.ts'`
Expected: no type errors; no lint errors; every unit test passes, 4,151 in all.

- [ ] **Step 7: Commit**

```bash
git add "src/app/(app)/finance/actions.ts" tests/finance-credit-refund-actions.test.ts
git commit -m "feat: server actions for credit notes and refunds"
```

---


### Task 5: The two form cards, and Credit Notes goes interactive

Components only draw: every rule they follow was written and tested in Tasks 1 to 4, so this task has no unit tests of its own. What proves it here is the type-checker, the linter and the build; what proves it to a person is the controller's smoke list.

Both form cards are written here, although Refunds itself goes interactive in Task 6: a credit note's row offers "Refund", so Credit Notes needs the refund card.

**Files:**
- Create: `src/components/finance/saved-note-card.tsx`
- Create: `src/components/finance/credit-note-form-card.tsx`
- Create: `src/components/finance/refund-form-card.tsx`
- Replace: `src/components/finance/credit-notes-view.tsx`
- Replace: `src/screens/finance/credit-notes.tsx`

**Interfaces:**
- Consumes: the rules of Tasks 2 and 3 (`@/lib/finance/credit-note-form`, `@/lib/finance/refund-form`, `creditNoteActions`, `creditNoteName` from `@/lib/finance/sales-followon-views`); the actions of Task 4; `SaveAndIssueCreditNoteResult` (Task 1); the existing `ConfirmRow`, `RowMenu`, `useFinanceAction`, `BentoCard`, `listInvoices`, `listRefunds`, `listAccounts`, `listCreditNotes`.
- Produces:
  - `@/components/finance/saved-note-card`: `SavedNoteCard({ title, subtitle, children, href, linkLabel, onClose })`
  - `@/components/finance/credit-note-form-card`: `type CreditNoteFormActions = { save; saveAndIssue }`; `CreditNoteFormCard({ editing?: CreditNoteRow; invoices: InvoiceListRow[]; today: string; invoiceId?: string; actions: CreditNoteFormActions; onClose: () => void; onSaved?: () => void })`
  - `@/components/finance/refund-form-card`: `type RecordRefund = (input: unknown) => Promise<FinResult<{ id: string }>>`; `RefundFormCard({ targets: RefundTarget[]; accounts: FinanceAccount[]; today: string; preselect?: string; record: RecordRefund; onClose: () => void; onSaved?: () => void })`
  - `@/components/finance/credit-notes-view`: `type CreditNoteActions = CreditNoteFormActions & { issue; voidNote; remove; recordRefund }`; `type CreditNotesWriter = { actions: CreditNoteActions; invoices: InvoiceListRow[]; refunds: RefundRow[]; accounts: FinanceAccount[] }`; `CreditNotesView({ rows, view, writer? })`

What the cards and the view must do, beyond drawing:

- Both cards keep what was typed when a save is refused; a refusal clears as soon as the person changes anything; Enter in an amount box saves nothing; dates default to `today`, which the view takes from `localIsoDate`.
- "Save and issue" in the form does not ask first; "Issue" on a row does, as with Post on an invoice. When the draft was saved and only the issue was refused, the form goes on editing that draft.
- Edit opens at once from the row: a credit note has no lines, so nothing is read first (Decision 6). A draft that was issued in another tab meanwhile is refused on Save with the sentence of Task 1.
- While a form is open or an action is pending, the row menus are `inert` and the header button is disabled. A note that something was saved is not a form: it locks nothing.
- A refund recorded from a credit note's row lands on Refunds, and this row's Refunded figure moves only once it is paid out. So the form does not just close: a card at the top says the refund was recorded and links to Refunds, with focus on the link (`SavedNoteCard`). Nothing navigates by itself.
- Without a `writer` the view renders no header button, no menu column, no form and no question.

- [ ] **Step 1: Write the note that something was saved on another screen**

Create `src/components/finance/saved-note-card.tsx`:

```tsx
'use client';

import { type ReactNode, useEffect, useId, useRef } from 'react';
import Link from 'next/link';
import { FileText } from 'lucide-react';
import { BentoCard } from '@/components/bento/bento';
import { Button } from '@/components/ui/button';

/**
 * Says that something was saved which shows on another screen, and links
 * there: a credit note made from an invoice's row is on Credit Notes, and a
 * refund made from an invoice's or a credit note's row is on Refunds. Without
 * it the form would close and the page the person is on might show nothing
 * new. It opens at the top of the page, away from the row that was used, so
 * its link takes focus once, which also scrolls it into view. Nothing
 * navigates by itself.
 */
export function SavedNoteCard({
  title,
  subtitle,
  children,
  href,
  linkLabel,
  onClose,
}: {
  title: string;
  subtitle: string;
  /** What was saved and what can be done with it there; the link follows it. */
  children: ReactNode;
  /** The screen that shows what was saved. */
  href: string;
  linkLabel: string;
  onClose: () => void;
}) {
  const id = useId();
  const link = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    link.current?.focus();
  }, []);

  return (
    <BentoCard title={title} subtitle={subtitle} icon={FileText} className="col-span-2 md:col-span-12">
      <div className="flex flex-wrap items-center gap-3">
        <p id={id} role="status" className="text-sm text-muted-foreground">
          {children}{' '}
          <Link
            ref={link}
            href={href}
            aria-describedby={id}
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            {linkLabel}
          </Link>
          .
        </p>
        <Button type="button" variant="outline" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>
    </BentoCard>
  );
}
```

`Link` is given a `ref`, as `quotations-view.tsx` already does: it passes a `ref` prop on to its `<a>` (`node_modules/next/dist/client/app-dir/link.js`). The note on Quotations that a draft invoice was made is drawn in that view and is left as it is.

- [ ] **Step 2: Write the credit note form card**

Create `src/components/finance/credit-note-form-card.tsx`:

```tsx
'use client';

import { type FormEvent, useId, useState } from 'react';
import { FileText, Plus } from 'lucide-react';
import { BentoCard } from '@/components/bento/bento';
import { useFinanceAction } from '@/components/finance/use-finance-action';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  creditNoteFormError,
  creditNoteFormFromRow,
  creditNotePayload,
  creditNoteSavedNotIssued,
  creditableInvoices,
  creditableLabel,
  newCreditNoteForm,
} from '@/lib/finance/credit-note-form';
import {
  CREDIT_NOTE_REASONS,
  CREDIT_NOTE_REASON_LABELS,
  type CreditNoteReason,
  type CreditNoteRow,
  type SaveAndIssueCreditNoteResult,
} from '@/lib/finance/credit-notes';
import { rm } from '@/lib/finance/format';
import type { InvoiceListRow } from '@/lib/finance/invoices';
import type { FinResult } from '@/lib/finance/result';

export type CreditNoteFormActions = {
  save: (input: unknown) => Promise<FinResult<{ id: string }>>;
  /** Saves the draft, then issues it. When only the issue was refused, the answer carries the draft's id. */
  saveAndIssue: (input: unknown) => Promise<SaveAndIssueCreditNoteResult>;
};

/**
 * A new credit note against one posted invoice, or a draft being changed
 * (`editing`). Saved as a draft, or saved and issued in one go. Used on
 * Credit Notes, and on Invoices from an invoice's Credit note choice
 * (`invoiceId`). A credit note is one amount with a reason: it has no lines
 * and moves no money, so it has its own card. The rules are in
 * src/lib/finance/credit-note-form.ts.
 */
export function CreditNoteFormCard({
  editing,
  invoices,
  today,
  invoiceId,
  actions,
  onClose,
  onSaved,
}: {
  /** The draft being changed; absent for a new credit note. */
  editing?: CreditNoteRow;
  /** Every invoice of the workspace; the card offers the ones that can still take a credit note. */
  invoices: InvoiceListRow[];
  /** The default credit note date, YYYY-MM-DD. */
  today: string;
  /** Opened from an invoice's row: that invoice chosen. */
  invoiceId?: string;
  actions: CreditNoteFormActions;
  onClose: () => void;
  /** Called instead of `onClose` once the credit note is saved, where the page has something to say about it. */
  onSaved?: () => void;
}) {
  const id = useId();
  const [form, setForm] = useState(() =>
    editing ? creditNoteFormFromRow(editing) : newCreditNoteForm(creditableInvoices(invoices), today, invoiceId),
  );
  const [issuing, setIssuing] = useState(false);
  const save = useFinanceAction();
  // A change by the person answers the last refusal, so its sentence goes.
  const edit: typeof setForm = (next) => {
    save.clear();
    setForm(next);
  };

  // The form's own invoice stays offered with nothing left, so the form can say that is why.
  const offered = creditableInvoices(invoices, form.invoiceId);
  const chosen = offered.find((i) => i.id === form.invoiceId);
  const saved = onSaved ?? onClose;

  const send = (issue: boolean) => {
    const problem = creditNoteFormError(form, offered);
    if (problem) {
      save.fail(problem);
      return;
    }
    const payload = creditNotePayload(form);
    setIssuing(issue);
    if (!issue) {
      save.run(() => actions.save(payload), saved);
      return;
    }
    save.run(async () => {
      const result = await actions.saveAndIssue(payload);
      // Saved but not issued: go on editing that draft, so a second try does not save a second credit note.
      if (!result.ok && result.draftId) {
        const draftId = result.draftId;
        setForm((f) => ({ ...f, id: draftId }));
        return { ...result, error: creditNoteSavedNotIssued(result.error) };
      }
      return result;
    }, saved);
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    // Handled here rather than as a form action, so a refused form keeps what was typed.
    event.preventDefault();
    send(false);
  };

  const title = form.id ? 'Edit credit note' : 'New credit note';
  const subtitle = form.id ? 'A draft: it gets its number when it is issued' : 'Saved as a draft until it is issued';

  if (offered.length === 0) {
    return (
      <BentoCard title={title} subtitle={subtitle} icon={Plus} className="col-span-2 md:col-span-12">
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-muted-foreground">
            There is no invoice to credit. A credit note goes against a posted invoice, for no more than its total less
            what has already been credited.
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
        <div className="space-y-1.5 md:col-span-6">
          <Label htmlFor={`${id}-invoice`}>Against invoice</Label>
          <Select value={form.invoiceId} onValueChange={(v) => edit((f) => ({ ...f, invoiceId: v }))}>
            <SelectTrigger id={`${id}-invoice`} className="w-full" autoFocus data-finance-focus>
              <SelectValue placeholder="Choose an invoice" />
            </SelectTrigger>
            <SelectContent>
              {offered.map((i) => (
                <SelectItem key={i.id} value={i.id}>
                  {creditableLabel(i)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground tabular-nums" aria-live="polite">
            {chosen
              ? `Total ${rm(chosen.total)} · ${rm(chosen.credited)} already credited · ${rm(chosen.creditable)} left to credit`
              : 'A posted invoice. What has been paid on it does not limit a credit note.'}
          </p>
        </div>
        <div className="space-y-1.5 md:col-span-3">
          <Label htmlFor={`${id}-date`}>Credit note date</Label>
          <Input
            id={`${id}-date`}
            type="date"
            value={form.date}
            required
            onChange={(e) => edit((f) => ({ ...f, date: e.target.value }))}
          />
        </div>
        <div className="space-y-1.5 md:col-span-3">
          <Label htmlFor={`${id}-amount`}>Amount (RM)</Label>
          <Input
            id={`${id}-amount`}
            type="number"
            inputMode="decimal"
            min={0}
            step="0.01"
            className="text-right tabular-nums"
            onWheel={(e) => e.currentTarget.blur()}
            // Enter in the amount box does not save the credit note half typed.
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.preventDefault();
            }}
            value={form.amount}
            onChange={(e) => edit((f) => ({ ...f, amount: e.target.value }))}
          />
        </div>
        <div className="space-y-1.5 md:col-span-4">
          <Label htmlFor={`${id}-reason`}>Reason</Label>
          <Select value={form.reason} onValueChange={(v) => edit((f) => ({ ...f, reason: v as CreditNoteReason }))}>
            <SelectTrigger id={`${id}-reason`} className="w-full">
              <SelectValue placeholder="Choose a reason" />
            </SelectTrigger>
            <SelectContent>
              {CREDIT_NOTE_REASONS.map((r) => (
                <SelectItem key={r} value={r}>
                  {CREDIT_NOTE_REASON_LABELS[r]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5 md:col-span-8">
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
            {save.pending && !issuing ? 'Saving…' : 'Save draft'}
          </Button>
          <Button type="button" size="sm" disabled={save.pending} onClick={() => send(true)}>
            {save.pending && issuing ? 'Issuing…' : 'Save and issue'}
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

- [ ] **Step 3: Write the refund form card**

Create `src/components/finance/refund-form-card.tsx`:

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
import { rm } from '@/lib/finance/format';
import { type FinanceAccount, PAYMENT_METHODS, PAYMENT_METHOD_LABELS, type PaymentMethod } from '@/lib/finance/money';
import {
  type RefundTarget,
  chooseRefundTarget,
  keepRefundTarget,
  newRefundForm,
  refundFormError,
  refundPayload,
  refundTargetLabel,
} from '@/lib/finance/refund-form';
import { REFUND_REASONS, REFUND_REASON_LABELS, type RefundReason } from '@/lib/finance/refunds';
import type { FinResult } from '@/lib/finance/result';

export type RecordRefund = (input: unknown) => Promise<FinResult<{ id: string }>>;

const SUBTITLE = 'Money paid back to a customer who is in credit';

/**
 * Records one refund against one invoice whose customer is in credit, or
 * against one of its issued credit notes: paid out now, or left pending.
 * Used on Refunds, on Invoices from an invoice's Refund choice and on Credit
 * Notes from a credit note's (`preselect`). A refund is one payment for one
 * document with a reason, so it has its own card. The rules are in
 * src/lib/finance/refund-form.ts.
 */
export function RefundFormCard({
  targets,
  accounts,
  today,
  preselect,
  record,
  onClose,
  onSaved,
}: {
  /** Everything that can be refunded, from `refundTargets`. */
  targets: RefundTarget[];
  accounts: FinanceAccount[];
  /** The default refund date, YYYY-MM-DD. */
  today: string;
  /** Opened from a row: the key of that invoice or credit note. */
  preselect?: string;
  record: RecordRefund;
  onClose: () => void;
  /** Called instead of `onClose` once the refund is recorded, where the page has something to say about it. */
  onSaved?: () => void;
}) {
  const id = useId();
  const [typed, setForm] = useState(() => newRefundForm(targets, accounts, today, preselect));
  const save = useFinanceAction();
  // A change by the person answers the last refusal, so its sentence goes.
  const edit: typeof setForm = (next) => {
    save.clear();
    setForm(next);
  };

  // A choice that was refunded in another tab since a refresh is dropped from everything below.
  const form = keepRefundTarget(typed, targets);
  const chosen = targets.find((t) => t.key === form.target);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    // Handled here rather than as a form action, so a refused form keeps what was typed.
    event.preventDefault();
    const problem = refundFormError(form, targets);
    if (problem) {
      save.fail(problem);
      return;
    }
    save.run(() => record(refundPayload(form, targets)), onSaved ?? onClose);
  };

  if (targets.length === 0) {
    return (
      <BentoCard title="Record refund" subtitle={SUBTITLE} icon={Banknote} className="col-span-2 md:col-span-12">
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-muted-foreground">
            There is nothing to refund. A refund pays out what a customer is in credit on a posted invoice: more paid
            and credited than the invoice came to, less any refund that is already waiting to be paid out.
          </p>
          <Button type="button" variant="outline" size="sm" onClick={onClose} autoFocus data-finance-focus>
            Close
          </Button>
          {save.error ? (
            <p role="alert" className="text-sm text-destructive">
              {save.error}
            </p>
          ) : null}
        </div>
      </BentoCard>
    );
  }

  return (
    <BentoCard title="Record refund" subtitle={SUBTITLE} icon={Banknote} className="col-span-2 md:col-span-12">
      <form onSubmit={submit} noValidate className="grid gap-3 md:grid-cols-12">
        <div className="space-y-1.5 md:col-span-6">
          <Label htmlFor={`${id}-target`}>Refund for</Label>
          <Select
            value={form.target}
            onValueChange={(v) => {
              const target = targets.find((t) => t.key === v);
              if (target) edit((f) => chooseRefundTarget(f, target));
            }}
          >
            <SelectTrigger id={`${id}-target`} className="w-full" autoFocus data-finance-focus>
              <SelectValue placeholder="Choose an invoice or a credit note" />
            </SelectTrigger>
            <SelectContent>
              {targets.map((t) => (
                <SelectItem key={t.key} value={t.key}>
                  {refundTargetLabel(t)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground tabular-nums" aria-live="polite">
            {chosen
              ? `Up to ${rm(chosen.refundable)}: what the customer is in credit on ${chosen.invoice_no}, less refunds that are pending${chosen.kind === 'credit_note' ? `, and no more than is left of ${chosen.number}` : ''}.`
              : 'An invoice whose customer is in credit, or one of its issued credit notes.'}
          </p>
        </div>
        <div className="space-y-1.5 md:col-span-3">
          <Label htmlFor={`${id}-amount`}>Amount (RM)</Label>
          <Input
            id={`${id}-amount`}
            type="number"
            inputMode="decimal"
            min={0}
            step="0.01"
            className="text-right tabular-nums"
            onWheel={(e) => e.currentTarget.blur()}
            // Enter in the amount box does not record the refund half typed.
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.preventDefault();
            }}
            value={form.amount}
            onChange={(e) => edit((f) => ({ ...f, amount: e.target.value }))}
          />
        </div>
        <div className="space-y-1.5 md:col-span-3">
          <Label htmlFor={`${id}-reason`}>Reason</Label>
          <Select value={form.reason} onValueChange={(v) => edit((f) => ({ ...f, reason: v as RefundReason }))}>
            <SelectTrigger id={`${id}-reason`} className="w-full">
              <SelectValue placeholder="Choose a reason" />
            </SelectTrigger>
            <SelectContent>
              {REFUND_REASONS.map((r) => (
                <SelectItem key={r} value={r}>
                  {REFUND_REASON_LABELS[r]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5 md:col-span-3">
          <Label htmlFor={`${id}-account`}>Paid from</Label>
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
          <Label htmlFor={`${id}-date`}>{form.scheduled ? 'Planned date' : 'Date paid out'}</Label>
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
        <div className="space-y-1.5 md:col-span-7">
          <Label htmlFor={`${id}-notes`}>Notes</Label>
          <Input
            id={`${id}-notes`}
            value={form.notes}
            maxLength={200}
            autoComplete="off"
            onChange={(e) => edit((f) => ({ ...f, notes: e.target.value }))}
          />
        </div>
        <fieldset className="space-y-1.5 md:col-span-5">
          <legend className="text-sm font-medium leading-none">When</legend>
          <div className="flex h-8 flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name={`${id}-when`}
                className="size-4 accent-primary"
                checked={!form.scheduled}
                onChange={() => edit((f) => ({ ...f, scheduled: false }))}
              />
              Pay out now
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name={`${id}-when`}
                className="size-4 accent-primary"
                checked={form.scheduled}
                onChange={() => edit((f) => ({ ...f, scheduled: true }))}
              />
              Leave pending
            </label>
          </div>
        </fieldset>

        <div className="flex flex-wrap items-center gap-3 md:col-span-12">
          <Button type="submit" size="sm" disabled={save.pending}>
            {save.pending ? 'Saving…' : form.scheduled ? 'Save as pending' : 'Record refund'}
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

- [ ] **Step 4: Rewrite the Credit Notes view**

Replace the whole of `src/components/finance/credit-notes-view.tsx` with:

```tsx
'use client';

import { useState } from 'react';
import { Ban, Download, FileCheck, FileText, Pencil, PieChart, Plus, Search, Trash2, TrendingUp, Undo2 } from 'lucide-react';
import { BentoCard, BentoGrid, BentoStat } from '@/components/bento/bento';
import { AreaTrend, DonutStat, type Series } from '@/components/charts';
import { ConfirmRow } from '@/components/finance/confirm-row';
import { CreditNoteFormCard, type CreditNoteFormActions } from '@/components/finance/credit-note-form-card';
import { downloadCsv } from '@/components/finance/download-csv';
import { RefundFormCard, type RecordRefund } from '@/components/finance/refund-form-card';
import { RowMenu, type RowMenuItem } from '@/components/finance/row-menu';
import { SavedNoteCard } from '@/components/finance/saved-note-card';
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
import { CREDIT_NOTE_REASON_LABELS, type CreditNoteRow, type CreditNoteStatus } from '@/lib/finance/credit-notes';
import { csvFileName } from '@/lib/finance/csv';
import { rm } from '@/lib/finance/format';
import type { InvoiceListRow } from '@/lib/finance/invoices';
import type { FinanceAccount } from '@/lib/finance/money';
import { noteTargetKey, refundTargets } from '@/lib/finance/refund-form';
import type { RefundRow } from '@/lib/finance/refunds';
import type { FinResult } from '@/lib/finance/result';
import {
  CREDIT_NOTE_STATUS_LABELS,
  type CreditNoteAction,
  type CreditNoteFilter,
  type CreditNotesViewData,
  creditNoteActions,
  creditNoteName,
  creditNotesCsv,
  filterCreditNotes,
  refundedOnNote,
} from '@/lib/finance/sales-followon-views';
import { LATEST_ROWS, displayDate } from '@/lib/finance/view-helpers';
import { cn } from '@/lib/utils';

export type CreditNoteActions = CreditNoteFormActions & {
  issue: (input: unknown) => Promise<FinResult<{ id: string; credit_note_no: string }>>;
  voidNote: (input: unknown) => Promise<FinResult<{ id: string }>>;
  remove: (input: unknown) => Promise<FinResult<{ id: string }>>;
  /** Records a refund against a credit note, from its row. */
  recordRefund: RecordRefund;
};

/** What only a person who may edit is given: the actions, and what the two forms offer. */
export type CreditNotesWriter = {
  actions: CreditNoteActions;
  /** Every invoice, to find the ones that can take a credit note and the ones whose customer is in credit. */
  invoices: InvoiceListRow[];
  /** Every refund, to know what refunds that are pending already hold. */
  refunds: RefundRow[];
  accounts: FinanceAccount[];
};

const CREDITED_SERIES: Series[] = [{ key: 'credited', label: 'Credited (RM k)', color: 'var(--chart-3)' }];

const STATUS_STYLES: Record<CreditNoteStatus, string> = {
  issued: 'bg-emerald-500/15 text-emerald-600',
  draft: 'bg-muted text-muted-foreground',
  void: 'bg-muted text-muted-foreground line-through',
};

/** A draft or a void credit note has refunded nothing: a dash, as a draft's number is. */
const formatRefunded = (amount: number | null) => (amount === null ? '—' : rm(amount));

/** A question asked in a credit note's own row. `edit` and `refund` are not questions: they open a form card. */
type Question = Exclude<CreditNoteAction, 'edit' | 'refund'>;

/** One thing open at a time: a form card, the note that a refund was recorded, or a question in one row. */
type Open =
  | { kind: 'new'; today: string; nonce: number }
  | { kind: 'edit'; note: CreditNoteRow; today: string }
  | { kind: 'refund'; note: CreditNoteRow; today: string }
  /** A refund has just been recorded against this credit note. */
  | { kind: 'refunded'; note: CreditNoteRow }
  | { kind: Question; note: CreditNoteRow }
  | null;

/**
 * Credit Notes: figures, charts and the table, with search, a status filter,
 * "View all" and Export for everybody. A person who may edit (`writer`) also
 * gets New Credit Note and a menu on each row that offers what its status
 * allows.
 */
export function CreditNotesView({
  rows,
  view,
  writer,
}: {
  /** Every credit note, newest first; drafts and void ones included. */
  rows: CreditNoteRow[];
  view: CreditNotesViewData;
  writer?: CreditNotesWriter;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<CreditNoteFilter>('open');
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState<Open>(null);
  const confirm = useFinanceAction();

  const matching = filterCreditNotes(rows, query, filter);
  const shown = showAll ? matching : matching.slice(0, LATEST_ROWS);
  const columns = writer ? 9 : 8;
  const targets = writer ? refundTargets(writer.invoices, rows, writer.refunds) : [];
  const asking = open && (open.kind === 'issue' || open.kind === 'void' || open.kind === 'delete') ? open : null;
  // A form holds what was typed, so nothing else opens over it: it is closed with its own Cancel first.
  const formOpen = open?.kind === 'new' || open?.kind === 'edit' || open?.kind === 'refund';
  // A row that is gone after a refresh takes its question with it; the message still has to be seen.
  const askingInView = asking ? shown.some((n) => n.id === asking.note.id) : false;
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

  const menuItem = (note: CreditNoteRow, action: CreditNoteAction): RowMenuItem => {
    switch (action) {
      case 'edit':
        return { label: 'Edit', icon: Pencil, opens: true, onSelect: () => ask({ kind: 'edit', note, today: now() }) };
      case 'issue':
        return { label: 'Issue', icon: FileCheck, opens: true, onSelect: () => ask({ kind: 'issue', note }) };
      case 'delete':
        return { label: 'Delete', icon: Trash2, destructive: true, opens: true, onSelect: () => ask({ kind: 'delete', note }) };
      case 'refund':
        return { label: 'Refund', icon: Undo2, opens: true, onSelect: () => ask({ kind: 'refund', note, today: now() }) };
      case 'void':
        return { label: 'Void', icon: Ban, destructive: true, opens: true, onSelect: () => ask({ kind: 'void', note }) };
    }
  };

  const menu = (note: CreditNoteRow): RowMenuItem[] =>
    creditNoteActions(
      note,
      targets.some((t) => t.key === noteTargetKey(note.id)),
    ).map((action) => menuItem(note, action));

  const question = (note: CreditNoteRow) => {
    if (!writer || !asking || asking.note.id !== note.id) return null;
    const { actions } = writer;
    const id = { id: note.id };
    const name = creditNoteName(note);
    const who = <span className="font-medium">{note.customer_name}</span>;
    const invoice = <span className="font-medium">{note.invoice_no ?? 'its invoice'}</span>;
    const amount = <span className="font-medium">{rm(note.amount)}</span>;
    const shared = { colSpan: columns, pending: confirm.pending, error: confirm.error, onCancel: close };
    switch (asking.kind) {
      case 'issue':
        return (
          <ConfirmRow
            key={note.id}
            {...shared}
            tone="default"
            icon={FileCheck}
            label={`Issue ${name}`}
            confirmLabel="Issue"
            pendingLabel="Issuing…"
            onConfirm={() => confirm.run(() => actions.issue(id), close)}
          >
            Issue this credit note of {amount} to {who}? It gets its number, and {invoice} owes that much less from
            then on; if that is more than is still owed, the customer is in credit and can be refunded. After this it
            can no longer be edited or deleted, only voided.
          </ConfirmRow>
        );
      case 'void':
        return (
          <ConfirmRow
            key={note.id}
            {...shared}
            icon={Ban}
            label={`Void ${name}`}
            confirmLabel="Void credit note"
            pendingLabel="Voiding…"
            onConfirm={() => confirm.run(() => actions.voidNote(id), close)}
          >
            Void <span className="font-medium">{note.credit_note_no}</span> of {amount} to {who}? {invoice} owes that
            amount again. It stays in the list as Void, and this cannot be undone. A credit note cannot be voided
            while a refund depends on it: void or delete that refund on Refunds first.
          </ConfirmRow>
        );
      case 'delete':
        return (
          <ConfirmRow
            key={note.id}
            {...shared}
            label={`Delete ${name}`}
            confirmLabel="Delete draft"
            pendingLabel="Deleting…"
            onConfirm={() => confirm.run(() => actions.remove(id), close)}
          >
            Delete the draft credit note of {amount} against {invoice} to {who}? This cannot be undone.
          </ConfirmRow>
        );
    }
  };

  const card = () => {
    if (!writer || !open) return null;
    const { actions } = writer;
    if (open.kind === 'new') {
      return <CreditNoteFormCard key={open.nonce} invoices={writer.invoices} today={open.today} actions={actions} onClose={close} />;
    }
    if (open.kind === 'edit') {
      return (
        <CreditNoteFormCard
          // A different draft gets a fresh form.
          key={open.note.id}
          editing={open.note}
          invoices={writer.invoices}
          today={open.today}
          actions={actions}
          onClose={close}
        />
      );
    }
    if (open.kind === 'refund') {
      const { note } = open;
      return (
        <RefundFormCard
          key={note.id}
          targets={targets}
          accounts={writer.accounts}
          today={open.today}
          preselect={noteTargetKey(note.id)}
          record={actions.recordRefund}
          onClose={close}
          // The refund is on Refunds; this row's Refunded figure moves only once it is paid out.
          onSaved={() => ask({ kind: 'refunded', note })}
        />
      );
    }
    if (open.kind === 'refunded') {
      return (
        <SavedNoteCard
          title="Refund recorded"
          subtitle={`For ${open.note.customer_name}`}
          href="/finance/refunds"
          linkLabel="Refunds"
          onClose={close}
        >
          It was put against {open.note.credit_note_no ?? 'the credit note'}. A refund left pending is marked as paid or
          deleted, and one that was paid out can be voided, on
        </SavedNoteCard>
      );
    }
    return null;
  };

  // The question's own message shows in its row; beside the filters only while its row is out of view.
  const tableError = confirm.error && asking && !askingInView ? confirm.error : null;

  return (
    <ScreenContainer className="pb-24 sm:pb-24">
      <PageHeader
        title="Credit Notes"
        subtitle="Credits issued against customer invoices, Saudara."
        actions={
          writer ? (
            <Button
              size="sm"
              aria-expanded={open?.kind === 'new'}
              disabled={locked}
              onClick={() => ask({ kind: 'new', today: now(), nonce: Date.now() })}
            >
              <Plus className="size-4" />
              New Credit Note
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
              onClick={() => downloadCsv(csvFileName('credit-notes', now()), creditNotesCsv(matching))}
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
                  <TableHead>Against invoice</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead className="text-right">Refunded</TableHead>
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
                        No credit notes yet.{writer ? ' Add the first one with New Credit Note.' : ''}
                      </TableCell>
                    </TableRow>
                  ) : (
                    <NoMatchesRow colSpan={columns} />
                  ))}
                {shown.map((n) => {
                  const asked = question(n);
                  if (asked) return asked;
                  const items = writer ? menu(n) : [];
                  return (
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
                              'inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold',
                              STATUS_STYLES[n.status],
                            )}
                          >
                            {CREDIT_NOTE_STATUS_LABELS[n.status]}
                          </span>
                        </span>
                      </TableCell>
                      {writer ? (
                        <TableCell>
                          {items.length ? (
                            // RowMenu has no disabled prop; an inert wrapper keeps its button from being used while an action runs or a form is open.
                            <span inert={locked} className={cn(locked && 'opacity-50')}>
                              <RowMenu label={creditNoteName(n)} items={items} />
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
            Showing {shown.length} of {matching.length} credit notes
            {matching.length !== rows.length ? ` (${rows.length} in all)` : ''}
          </div>
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}
```

- [ ] **Step 5: Rewrite the loader**

Replace the whole of `src/screens/finance/credit-notes.tsx` with:

```tsx
import {
  deleteCreditNoteAction,
  issueCreditNoteAction,
  recordRefundAction,
  saveAndIssueCreditNoteAction,
  saveCreditNoteAction,
  voidCreditNoteAction,
} from '@/app/(app)/finance/actions';
import { type CreditNoteActions, CreditNotesView } from '@/components/finance/credit-notes-view';
import { can } from '@/lib/auth/permissions';
import { getViewer, hasSupabaseEnv } from '@/lib/auth/viewer';
import { listCreditNotes } from '@/lib/finance/credit-notes';
import { listInvoices } from '@/lib/finance/invoices';
import { listAccounts } from '@/lib/finance/money';
import { listRefunds } from '@/lib/finance/refunds';
import { creditNotesView } from '@/lib/finance/sales-followon-views';
import { todayUtc } from '@/lib/finance/view-helpers';
import { createClient } from '@/lib/supabase/server';
import { SAMPLE_CREDIT_NOTES, SAMPLE_TODAY } from './sales-sample';

const ACTIONS: CreditNoteActions = {
  save: saveCreditNoteAction,
  saveAndIssue: saveAndIssueCreditNoteAction,
  issue: issueCreditNoteAction,
  voidNote: voidCreditNoteAction,
  remove: deleteCreditNoteAction,
  recordRefund: recordRefundAction,
};

export default async function CreditNotesScreen() {
  if (!hasSupabaseEnv()) {
    return <CreditNotesView rows={SAMPLE_CREDIT_NOTES} view={creditNotesView(SAMPLE_CREDIT_NOTES, SAMPLE_TODAY)} />;
  }
  const viewer = await getViewer();
  const ctx = { client: await createClient(), orgId: viewer.orgId };
  const canEdit = !viewer.isDemo && can(viewer.role, 'edit-data');
  // The credit note form offers posted invoices; the refund form, opened from a credit note's row, needs the
  // invoices' credit, the refunds that are pending and the accounts. A viewer has no form, so none is read for them.
  const [rows, invoices, refunds, accounts] = await Promise.all([
    listCreditNotes(ctx),
    canEdit ? listInvoices(ctx) : [],
    canEdit ? listRefunds(ctx) : [],
    canEdit ? listAccounts(ctx) : [],
  ]);
  return (
    <CreditNotesView
      rows={rows}
      view={creditNotesView(rows, todayUtc())}
      writer={canEdit ? { actions: ACTIONS, invoices, refunds, accounts } : undefined}
    />
  );
}
```

- [ ] **Step 6: Check what the type-checker cannot**

Run: `grep -n -E "window\.confirm|alert\(|router\.|useRouter|redirect\(|comes in the next update" src/components/finance/credit-notes-view.tsx src/components/finance/credit-note-form-card.tsx src/components/finance/refund-form-card.tsx src/components/finance/saved-note-card.tsx src/screens/finance/credit-notes.tsx`
Expected: no output.

Run: `grep -n -i -E "purple|violet|fuchsia|indigo|kuasa" src/components/finance/credit-notes-view.tsx src/components/finance/credit-note-form-card.tsx src/components/finance/refund-form-card.tsx src/components/finance/saved-note-card.tsx src/screens/finance/credit-notes.tsx src/lib/finance/credit-note-form.ts src/lib/finance/refund-form.ts`
Expected: no output.

Run: `grep -n "value=\"\"" src/components/finance/credit-notes-view.tsx src/components/finance/credit-note-form-card.tsx src/components/finance/refund-form-card.tsx`
Expected: no output. Every `SelectItem` has a real value; an unchosen invoice, reason or refund target is an empty `Select` value with a placeholder.

Run: `grep -n -E "icon=\{" src/components/finance/credit-notes-view.tsx src/components/finance/credit-note-form-card.tsx src/components/finance/refund-form-card.tsx src/components/finance/saved-note-card.tsx`
Expected: every `BentoCard` line names `FileText`, `Plus`, `Banknote`, `TrendingUp` or `PieChart` (the form card's is `form.id ? FileText : Plus`), which are in `AnimatedIcon`'s map; the other matches are `ConfirmRow` icons (`FileCheck`, `Ban`), which are plain lucide icons and not limited.

Run: `grep -c "writer" src/components/finance/credit-notes-view.tsx`
Expected: a number above 10. Then read the file once for this: every `Button` that changes data, every `RowMenu`, `card()` and `question()` is reached only through `writer`.

- [ ] **Step 7: Type-check, lint, run the unit tests, and build**

Run, as separate commands: `pnpm exec tsc --noEmit`, `pnpm lint`, `pnpm exec vitest run --exclude 'tests/*.rls.test.ts' --exclude 'tests/bendahara-*.test.ts'`, `NEXT_PUBLIC_SUPABASE_URL= NEXT_PUBLIC_SUPABASE_ANON_KEY= SUPABASE_SERVICE_ROLE_KEY= pnpm build`
Expected: no type errors; no lint errors; every unit test passes, 4,151 in all (this task adds none); the build completes and lists `/finance/credit-notes`.

The build is run with the three Supabase variables emptied on its own command line, so that nothing in it can reach the hosted database. Do **not** run `pnpm dev`, and do not open a browser.

- [ ] **Step 8: Commit**

```bash
git add src/components/finance/saved-note-card.tsx src/components/finance/credit-note-form-card.tsx src/components/finance/refund-form-card.tsx src/components/finance/credit-notes-view.tsx src/screens/finance/credit-notes.tsx
git commit -m "feat: credit notes get their form and row menus, and a refund from a credit note's row"
```

---


### Task 6: Refunds goes interactive, and an invoice's row offers a credit note and a refund

Two screens. Refunds gets its header button and its row menus. Invoices gets two more choices on a posted invoice's row: "Credit note" whenever the invoice can still be credited, and "Refund" only while its customer is in credit and something of that credit is not already held by a pending refund. The one rule that changes, `invoiceActions`, is changed test-first; the rest is drawing.

**Files:**
- Replace: `src/components/finance/refunds-view.tsx`
- Replace: `src/screens/finance/refunds.tsx`
- Modify: `src/lib/finance/sales-views.ts`
- Modify: `tests/finance-sales-rules.test.ts`
- Modify: `src/components/finance/invoices-view.tsx`
- Modify: `src/screens/finance/invoices.tsx`

**Interfaces:**
- Consumes: `RefundFormCard`, `RecordRefund`, `CreditNoteFormCard`, `CreditNoteFormActions`, `SavedNoteCard` (Task 5); `refundTargets`, `invoiceTargetKey` (Task 3); `creditableInvoices` (Task 2); `refundActions`, `refundName` (Task 3); the actions of Task 4; `inCredit` in `sales-views.ts`; `markPaymentPaidInput` from `@/lib/finance/money`.
- Produces:
  - `@/components/finance/refunds-view`: `type RefundActions = { record: RecordRefund; markPaid; voidRefund; remove }`; `type RefundsWriter = { actions: RefundActions; invoices: InvoiceListRow[]; creditNotes: CreditNoteRow[]; accounts: FinanceAccount[] }`; `RefundsView({ rows, view, writer? })`
  - `@/lib/finance/sales-views`: `type InvoiceAction = 'edit' | 'post' | 'delete' | 'pay' | 'credit' | 'refund' | 'einvoice' | 'void'`; `type InvoiceCan = { pay: boolean; credit: boolean; refund: boolean }`; `invoiceActions(invoice: InvoiceListRow, can: InvoiceCan): InvoiceAction[]` (**the second parameter changes** from a boolean to this object)
  - `@/components/finance/invoices-view`: `InvoiceActions` gains `creditNote: CreditNoteFormActions` and `recordRefund: RecordRefund`; `InvoicesWriter` gains `creditNotes: CreditNoteRow[]` and `refunds: RefundRow[]`

What the Refunds view must do, beyond drawing:

- A pending refund's menu offers "Mark as paid" and "Delete"; a refund that was paid out offers "Void"; a void one offers nothing. There is no Edit.
- "Mark as paid" asks in the row for the date it was paid out, defaulting to the person's own date, exactly as Payments Out does; Enter in the date box confirms.
- A refund still being written (`draft`) is worded "Pending" and is now amber, as a scheduled one is. The app never leaves one in that state.
- A row is keyed by `allocation_id`; every action is sent the row's `transaction_id`.

- [ ] **Step 1: Rewrite the Refunds view**

Replace the whole of `src/components/finance/refunds-view.tsx` with:

```tsx
'use client';

import { useState } from 'react';
import { Ban, Banknote, CircleCheck, Download, PieChart, Plus, Search, Trash2, TrendingUp } from 'lucide-react';
import { BentoCard, BentoGrid, BentoStat } from '@/components/bento/bento';
import { AreaTrend, DonutStat, type Series } from '@/components/charts';
import { ConfirmRow } from '@/components/finance/confirm-row';
import { downloadCsv } from '@/components/finance/download-csv';
import { RefundFormCard, type RecordRefund } from '@/components/finance/refund-form-card';
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
import type { CreditNoteRow } from '@/lib/finance/credit-notes';
import { csvFileName } from '@/lib/finance/csv';
import { rm } from '@/lib/finance/format';
import type { InvoiceListRow } from '@/lib/finance/invoices';
import { type FinanceAccount, markPaymentPaidInput } from '@/lib/finance/money';
import { refundTargets } from '@/lib/finance/refund-form';
import { REFUND_REASON_LABELS, type RefundRow } from '@/lib/finance/refunds';
import type { FinResult } from '@/lib/finance/result';
import {
  REFUND_STATUS_LABELS,
  type RefundAction,
  type RefundFilter,
  type RefundsViewData,
  filterRefunds,
  refundActions,
  refundName,
  refundsCsv,
} from '@/lib/finance/sales-followon-views';
import { LATEST_ROWS, displayDate } from '@/lib/finance/view-helpers';
import { cn } from '@/lib/utils';

export type RefundActions = {
  record: RecordRefund;
  markPaid: (input: unknown) => Promise<FinResult<{ id: string; number: string }>>;
  voidRefund: (input: unknown) => Promise<FinResult<{ id: string }>>;
  remove: (input: unknown) => Promise<FinResult<{ id: string }>>;
};

/** What only a person who may edit is given: the actions, and what the refund form offers. */
export type RefundsWriter = {
  actions: RefundActions;
  /** Every invoice, to find the ones whose customer is in credit. */
  invoices: InvoiceListRow[];
  /** Every credit note, so a refund can be put against an issued one. */
  creditNotes: CreditNoteRow[];
  accounts: FinanceAccount[];
};

const REFUNDED_SERIES: Series[] = [{ key: 'refunded', label: 'Refunded (RM k)', color: 'var(--chart-3)' }];

/** A refund still being written (`draft`) is worded "Pending" and counted as pending, so it is amber as one is. */
const STATUS_STYLES: Record<RefundRow['status'], string> = {
  posted: 'bg-emerald-500/15 text-emerald-600',
  scheduled: 'bg-amber-500/15 text-amber-600',
  pending_approval: 'bg-amber-500/15 text-amber-600',
  draft: 'bg-amber-500/15 text-amber-600',
  rejected: 'bg-red-500/15 text-red-600',
  void: 'bg-muted text-muted-foreground line-through',
};

/** One thing open at a time: the refund form, or a question in one row. */
type Open =
  | { kind: 'form'; today: string; nonce: number }
  | { kind: 'markPaid'; row: RefundRow; paidOn: string }
  | { kind: 'void'; row: RefundRow }
  | { kind: 'delete'; row: RefundRow }
  | null;

/**
 * Refunds: figures, charts and the table, with search, a status filter,
 * "View all" and Export for everybody. A person who may edit (`writer`) also
 * gets New Refund and a menu on each row that offers what its status allows.
 */
export function RefundsView({
  rows,
  view,
  writer,
}: {
  /** Every refund, newest first; pending and void ones included. */
  rows: RefundRow[];
  view: RefundsViewData;
  writer?: RefundsWriter;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<RefundFilter>('open');
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState<Open>(null);
  const confirm = useFinanceAction();

  const matching = filterRefunds(rows, query, filter);
  const shown = showAll ? matching : matching.slice(0, LATEST_ROWS);
  const columns = writer ? 9 : 8;
  const asking = open && open.kind !== 'form' ? open : null;
  // The form holds what was typed, so nothing else opens over it: it is closed with its own Cancel first.
  const locked = confirm.pending || open?.kind === 'form';
  // A row that is gone after a refresh takes its question with it; the message still has to be seen.
  const askingInView = asking ? shown.some((r) => r.allocation_id === asking.row.allocation_id) : false;
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

  const menuItem = (row: RefundRow, action: RefundAction): RowMenuItem => {
    switch (action) {
      case 'markPaid':
        return {
          label: 'Mark as paid',
          icon: CircleCheck,
          opens: true,
          onSelect: () => ask({ kind: 'markPaid', row, paidOn: now() }),
        };
      case 'delete':
        return { label: 'Delete', icon: Trash2, destructive: true, opens: true, onSelect: () => ask({ kind: 'delete', row }) };
      case 'void':
        return { label: 'Void', icon: Ban, destructive: true, opens: true, onSelect: () => ask({ kind: 'void', row }) };
    }
  };

  const question = (row: RefundRow) => {
    if (!writer || !asking || asking.row.allocation_id !== row.allocation_id) return null;
    const { actions } = writer;
    const id = row.transaction_id;
    const name = refundName(row);
    const who = <span className="font-medium">{row.customer_name}</span>;
    const amount = <span className="font-medium">{rm(row.amount)}</span>;
    const invoice = <span className="font-medium">{row.invoice_no ?? 'the invoice'}</span>;
    const shared = { colSpan: columns, pending: confirm.pending, error: confirm.error, onCancel: close };
    const confirmPaid = () => {
      if (asking.kind !== 'markPaid' || confirm.pending) return;
      const parsed = markPaymentPaidInput.safeParse({ id, paid_on: asking.paidOn });
      if (!parsed.success) {
        confirm.fail(parsed.error.issues[0]?.message ?? 'Enter a valid date.');
        return;
      }
      confirm.run(() => actions.markPaid(parsed.data), close);
    };

    if (asking.kind === 'markPaid') {
      const paidOn = asking.paidOn;
      return (
        <ConfirmRow
          key={row.allocation_id}
          {...shared}
          tone="default"
          icon={CircleCheck}
          label={`Mark ${name} as paid`}
          confirmLabel="Mark as paid"
          pendingLabel="Saving…"
          onConfirm={confirmPaid}
        >
          <label className="flex flex-wrap items-center gap-2">
            <span>
              The refund of {amount} to {who} on {invoice} was paid out on
            </span>
            <Input
              type="date"
              className="w-40"
              value={paidOn}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                confirmPaid();
              }}
              onChange={(e) => setOpen({ kind: 'markPaid', row, paidOn: e.target.value })}
            />
          </label>
          <p className="mt-1 text-muted-foreground">
            It gets its payment voucher number and can then only be voided. The customer’s credit is looked at again
            first.
          </p>
        </ConfirmRow>
      );
    }
    if (asking.kind === 'void') {
      return (
        <ConfirmRow
          key={row.allocation_id}
          {...shared}
          icon={Ban}
          label={`Void refund ${name}`}
          confirmLabel="Void refund"
          pendingLabel="Voiding…"
          onConfirm={() => confirm.run(() => actions.voidRefund({ id }), close)}
        >
          Void refund <span className="font-medium">{row.number}</span> of {amount} to {who}? The customer is in credit
          by that amount on {invoice} again. It stays in the list as Void, and this cannot be undone.
        </ConfirmRow>
      );
    }
    return (
      <ConfirmRow
        key={row.allocation_id}
        {...shared}
        label={`Delete ${name}`}
        confirmLabel="Delete refund"
        pendingLabel="Deleting…"
        onConfirm={() => confirm.run(() => actions.remove({ id }), close)}
      >
        Delete the pending refund of {amount} to {who}? Nothing has been paid out, so the customer stays in credit on{' '}
        {invoice}.
      </ConfirmRow>
    );
  };

  // The question's own message shows in its row; beside the filters only while its row is out of view.
  const tableError = confirm.error && asking && !askingInView ? confirm.error : null;

  return (
    <ScreenContainer className="pb-24 sm:pb-24">
      <PageHeader
        title="Refunds"
        subtitle="Money paid back to customers who are in credit, Saudara."
        actions={
          writer ? (
            <Button
              size="sm"
              aria-expanded={open?.kind === 'form'}
              disabled={locked}
              onClick={() => ask({ kind: 'form', today: now(), nonce: Date.now() })}
            >
              <Plus className="size-4" />
              New Refund
            </Button>
          ) : undefined
        }
      />

      <BentoGrid>
        {writer && open?.kind === 'form' ? (
          <RefundFormCard
            key={open.nonce}
            targets={refundTargets(writer.invoices, writer.creditNotes, rows)}
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
              onClick={() => downloadCsv(csvFileName('refunds', now()), refundsCsv(matching))}
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
                  <TableHead>Date</TableHead>
                  <TableHead>No.</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Invoice</TableHead>
                  <TableHead>Credit note</TableHead>
                  <TableHead>Reason</TableHead>
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
                        No refunds yet.{writer ? ' Record the first one with New Refund, once a customer is in credit.' : ''}
                      </TableCell>
                    </TableRow>
                  ) : (
                    <NoMatchesRow colSpan={columns} />
                  ))}
                {shown.map((r) => {
                  const asked = question(r);
                  if (asked) return asked;
                  const items = writer ? refundActions(r).map((action) => menuItem(r, action)) : [];
                  return (
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
                              'inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold',
                              STATUS_STYLES[r.status],
                            )}
                          >
                            {REFUND_STATUS_LABELS[r.status]}
                          </span>
                        </span>
                      </TableCell>
                      {writer ? (
                        <TableCell>
                          {items.length ? (
                            // RowMenu has no disabled prop; an inert wrapper keeps its button from being used while an action runs or a form is open.
                            <span inert={locked} className={cn(locked && 'opacity-50')}>
                              <RowMenu label={refundName(r)} items={items} />
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
            Showing {shown.length} of {matching.length} refunds
            {matching.length !== rows.length ? ` (${rows.length} in all)` : ''}
          </div>
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}
```

- [ ] **Step 2: Rewrite the Refunds loader**

Replace the whole of `src/screens/finance/refunds.tsx` with:

```tsx
import {
  deleteRefundAction,
  markRefundPaidAction,
  recordRefundAction,
  voidRefundAction,
} from '@/app/(app)/finance/actions';
import { type RefundActions, RefundsView } from '@/components/finance/refunds-view';
import { can } from '@/lib/auth/permissions';
import { getViewer, hasSupabaseEnv } from '@/lib/auth/viewer';
import { listCreditNotes } from '@/lib/finance/credit-notes';
import { listInvoices } from '@/lib/finance/invoices';
import { listAccounts } from '@/lib/finance/money';
import { listRefunds } from '@/lib/finance/refunds';
import { refundsView } from '@/lib/finance/sales-followon-views';
import { todayUtc } from '@/lib/finance/view-helpers';
import { createClient } from '@/lib/supabase/server';
import { SAMPLE_INVOICES, SAMPLE_REFUNDS, SAMPLE_TODAY } from './sales-sample';

const ACTIONS: RefundActions = {
  record: recordRefundAction,
  markPaid: markRefundPaidAction,
  voidRefund: voidRefundAction,
  remove: deleteRefundAction,
};

export default async function RefundsScreen() {
  if (!hasSupabaseEnv()) {
    return <RefundsView rows={SAMPLE_REFUNDS} view={refundsView(SAMPLE_REFUNDS, SAMPLE_INVOICES, SAMPLE_TODAY)} />;
  }
  const viewer = await getViewer();
  const ctx = { client: await createClient(), orgId: viewer.orgId };
  const canEdit = !viewer.isDemo && can(viewer.role, 'edit-data');
  // The invoices feed the "In credit" card for everyone. The refund form also offers issued credit notes and
  // accounts; a viewer has no form, so neither is read for them.
  const [rows, invoices, creditNotes, accounts] = await Promise.all([
    listRefunds(ctx),
    listInvoices(ctx),
    canEdit ? listCreditNotes(ctx) : [],
    canEdit ? listAccounts(ctx) : [],
  ]);
  return (
    <RefundsView
      rows={rows}
      view={refundsView(rows, invoices, todayUtc())}
      writer={canEdit ? { actions: ACTIONS, invoices, creditNotes, accounts } : undefined}
    />
  );
}
```

- [ ] **Step 3: Write the failing tests for what an invoice's row offers**

`tests/finance-sales-rules.test.ts` pins `['einvoice', 'void']` for an invoice whose customer is in credit. That changes on purpose: such an invoice now offers a refund. The two `invoiceActions` blocks are replaced; nothing else in the file is touched.

In `tests/finance-sales-rules.test.ts`, replace:

```ts
describe('invoiceActions, for a customer in credit', () => {
  it('offers no payment on a paid invoice whose balance is below zero', () => {
    const inCredit = invoice('paid', { paid: 100, credited: 30, balance: -30 });
    expect(invoiceActions(inCredit, true)).toEqual(['einvoice', 'void']);
  });
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
  it('never offers a payment on a paid invoice, whatever the flag says', () => {
    expect(invoiceActions(invoice('paid', { paid: 100, balance: 0 }), true)).toEqual(['einvoice', 'void']);
    expect(invoiceActions(invoice('sent'), true)).toContain('pay');
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
```

with:

```ts
/** What the forms' own rules say an invoice can still take; the menu rule is given it. */
const NOTHING = { pay: false, credit: false, refund: false };
const EVERYTHING = { pay: true, credit: true, refund: true };

describe('invoiceActions, for a customer in credit', () => {
  // RM 100 invoiced and paid, then RM 30 credited: the customer is RM 30 in credit.
  const inCredit = invoice('paid', { paid: 100, credited: 30, balance: -30 });

  it('offers a refund, and no payment, on a paid invoice whose balance is below zero', () => {
    expect(invoiceActions(inCredit, EVERYTHING)).toEqual(['credit', 'refund', 'einvoice', 'void']);
    expect(invoiceActions(inCredit, { pay: true, credit: false, refund: true })).toEqual(['refund', 'einvoice', 'void']);
  });
  it('offers no refund once refunds that are pending hold all of the credit', () => {
    expect(invoiceActions(inCredit, { pay: false, credit: true, refund: false })).toEqual(['credit', 'einvoice', 'void']);
    expect(invoiceActions(inCredit, NOTHING)).toEqual(['einvoice', 'void']);
  });
  it('never offers a refund while the customer owes money or is exactly settled, whatever the flag says', () => {
    expect(invoiceActions(invoice('sent'), EVERYTHING)).not.toContain('refund');
    expect(invoiceActions(invoice('overdue', { credited: 30, balance: 70 }), EVERYTHING)).not.toContain('refund');
    expect(invoiceActions(invoice('paid', { paid: 100, balance: 0 }), EVERYTHING)).not.toContain('refund');
  });
});

describe('invoiceActions', () => {
  it('lets a draft be edited, posted or deleted, and never voided, paid, credited or refunded', () => {
    expect(invoiceActions(invoice('draft'), NOTHING)).toEqual(['edit', 'post', 'delete']);
    expect(invoiceActions(invoice('draft'), EVERYTHING)).toEqual(['edit', 'post', 'delete']);
  });
  it('lets a posted invoice take a payment and a credit note while it can, have its e-Invois set, and be voided', () => {
    expect(invoiceActions(invoice('sent'), EVERYTHING)).toEqual(['pay', 'credit', 'einvoice', 'void']);
    expect(invoiceActions(invoice('overdue'), EVERYTHING)).toEqual(['pay', 'credit', 'einvoice', 'void']);
    expect(invoiceActions(invoice('sent'), { pay: true, credit: false, refund: false })).toEqual(['pay', 'einvoice', 'void']);
    // Nothing left that a new payment or a new credit note could take.
    expect(invoiceActions(invoice('sent'), NOTHING)).toEqual(['einvoice', 'void']);
    expect(invoiceActions(invoice('paid', { paid: 100, balance: 0 }), NOTHING)).toEqual(['einvoice', 'void']);
  });
  it('offers a credit note on a paid invoice: what was paid does not limit one', () => {
    expect(invoiceActions(invoice('paid', { paid: 100, balance: 0 }), EVERYTHING)).toEqual(['credit', 'einvoice', 'void']);
  });
  it('never offers a payment on a paid invoice, whatever the flag says', () => {
    expect(invoiceActions(invoice('paid', { paid: 100, balance: 0 }), EVERYTHING)).not.toContain('pay');
    expect(invoiceActions(invoice('sent'), EVERYTHING)).toContain('pay');
  });
  it('offers nothing on a void invoice', () => {
    expect(invoiceActions(invoice('void'), NOTHING)).toEqual([]);
    expect(invoiceActions(invoice('void'), EVERYTHING)).toEqual([]);
  });
  it('never offers what the database refuses for the status: no editing or deleting once posted, no voiding a draft', () => {
    for (const status of ['sent', 'overdue', 'paid', 'void'] as const) {
      const offered = invoiceActions(invoice(status), EVERYTHING);
      expect(offered, status).not.toContain('edit');
      expect(offered, status).not.toContain('post');
      expect(offered, status).not.toContain('delete');
    }
    expect(invoiceActions(invoice('draft'), EVERYTHING)).not.toContain('void');
    expect(invoiceActions(invoice('draft'), EVERYTHING)).not.toContain('einvoice');
  });
});
```

- [ ] **Step 4: Run them to see them fail**

Run: `pnpm exec vitest run tests/finance-sales-rules.test.ts`
Expected: FAIL, four tests, each of which expects `credit` or `refund` in a menu: "offers a refund, and no payment…", "offers no refund once refunds that are pending hold all of the credit", "lets a posted invoice take a payment and a credit note…" and "offers a credit note on a paid invoice…". The function still takes a boolean, and an object counts as true. The other eleven tests of the file pass. (`pnpm exec tsc --noEmit` also fails from here until Step 6 is done; that is expected between these steps.)

- [ ] **Step 5: The rule**

In `src/lib/finance/sales-views.ts`, replace:

```ts
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
  const pay: InvoiceAction[] = canTakePayment && invoice.display_status !== 'paid' ? ['pay'] : [];
  return [...pay, 'einvoice', 'void'];
}
```

with:

```ts
export type InvoiceAction = 'edit' | 'post' | 'delete' | 'pay' | 'credit' | 'refund' | 'einvoice' | 'void';

/**
 * What a posted invoice can still take. Each is worked out by the rule of the
 * form it opens, from rows this file does not see: payments not yet posted,
 * credit notes, and refunds that are pending.
 */
export type InvoiceCan = {
  /** A payment in: `receivableInvoices` offers the invoice. */
  pay: boolean;
  /** A credit note: `creditableInvoices` offers the invoice. */
  credit: boolean;
  /** A refund: `refundTargets` offers the invoice. */
  refund: boolean;
};

/**
 * What an invoice's row menu offers, in order: only what the database allows
 * for its status. A draft is edited, posted or deleted, never voided. A
 * posted invoice ("Sent", "Overdue", "Paid") has its e-Invois details set and
 * can be voided; it takes a payment while `can.pay` and it is not paid, a
 * credit note while `can.credit`, paid or not, and a refund while
 * `can.refund` and its customer is in credit, which only a paid invoice is.
 * Voiding one that has payments, credit notes or refunds is offered and
 * refused with the reason, as on a paid bill. A void invoice offers nothing.
 */
export function invoiceActions(invoice: InvoiceListRow, can: InvoiceCan): InvoiceAction[] {
  if (invoice.display_status === 'draft') return ['edit', 'post', 'delete'];
  if (invoice.display_status === 'void') return [];
  const offered: InvoiceAction[] = [];
  if (can.pay && invoice.display_status !== 'paid') offered.push('pay');
  if (can.credit) offered.push('credit');
  if (can.refund && inCredit(invoice) > 0) offered.push('refund');
  return [...offered, 'einvoice', 'void'];
}
```

Run: `pnpm exec vitest run tests/finance-sales-rules.test.ts`
Expected: PASS.

- [ ] **Step 6: The Invoices view offers both, and hosts the two cards**

Eight edits to `src/components/finance/invoices-view.tsx`, in the order they come in the file. The menu says "Credit note", not "Issue credit note": the row menu is 10 rem wide and the longer label would wrap under its icon (Decision 9).

In `src/components/finance/invoices-view.tsx`, replace:

```tsx
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
```

with:

```tsx
  Download,
  FileCheck,
  FileMinus,
  FileText,
  Pencil,
  PieChart,
  Plus,
  Search,
  Trash2,
  TrendingUp,
  Undo2,
} from 'lucide-react';
```

In `src/components/finance/invoices-view.tsx`, replace:

```tsx
import { ConfirmRow } from '@/components/finance/confirm-row';
import { downloadCsv } from '@/components/finance/download-csv';
import { EInvoiceCard } from '@/components/finance/einvoice-card';
import { InvoiceFormCard, type InvoiceFormActions } from '@/components/finance/invoice-form-card';
import { ReceiptFormCard } from '@/components/finance/receipt-form-card';
import { RowMenu, type RowMenuItem } from '@/components/finance/row-menu';
import { useFinanceAction } from '@/components/finance/use-finance-action';
```

with:

```tsx
import { ConfirmRow } from '@/components/finance/confirm-row';
import { CreditNoteFormCard, type CreditNoteFormActions } from '@/components/finance/credit-note-form-card';
import { downloadCsv } from '@/components/finance/download-csv';
import { EInvoiceCard } from '@/components/finance/einvoice-card';
import { InvoiceFormCard, type InvoiceFormActions } from '@/components/finance/invoice-form-card';
import { ReceiptFormCard } from '@/components/finance/receipt-form-card';
import { RefundFormCard, type RecordRefund } from '@/components/finance/refund-form-card';
import { RowMenu, type RowMenuItem } from '@/components/finance/row-menu';
import { SavedNoteCard } from '@/components/finance/saved-note-card';
import { useFinanceAction } from '@/components/finance/use-finance-action';
```

In `src/components/finance/invoices-view.tsx`, replace:

```tsx
import type { FinanceContact } from '@/lib/finance/contacts';
import { csvFileName } from '@/lib/finance/csv';
import { rm } from '@/lib/finance/format';
import type { EInvoiceStatus, InvoiceDetail, InvoiceDisplayStatus, InvoiceListRow } from '@/lib/finance/invoices';
import type { FinanceAccount, PaymentInRow } from '@/lib/finance/money';
import type { FinanceProduct } from '@/lib/finance/products';
import { receivableInvoices } from '@/lib/finance/receipt-form';
import type { FinResult } from '@/lib/finance/result';
```

with:

```tsx
import type { FinanceContact } from '@/lib/finance/contacts';
import { creditableInvoices } from '@/lib/finance/credit-note-form';
import type { CreditNoteRow } from '@/lib/finance/credit-notes';
import { csvFileName } from '@/lib/finance/csv';
import { rm } from '@/lib/finance/format';
import type { EInvoiceStatus, InvoiceDetail, InvoiceDisplayStatus, InvoiceListRow } from '@/lib/finance/invoices';
import type { FinanceAccount, PaymentInRow } from '@/lib/finance/money';
import type { FinanceProduct } from '@/lib/finance/products';
import { receivableInvoices } from '@/lib/finance/receipt-form';
import { invoiceTargetKey, refundTargets } from '@/lib/finance/refund-form';
import type { RefundRow } from '@/lib/finance/refunds';
import type { FinResult } from '@/lib/finance/result';
```

In `src/components/finance/invoices-view.tsx`, replace:

```tsx
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
```

with:

```tsx
  recordPayment: RecordPayment;
  setEInvoice: (input: unknown) => Promise<FinResult<{ id: string }>>;
  /** A credit note against an invoice, from its row: saved as a draft, or saved and issued. */
  creditNote: CreditNoteFormActions;
  /** A refund of what a customer is in credit on an invoice, from its row. */
  recordRefund: RecordRefund;
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
  /** Every credit note, so a refund can also be put against an issued one. */
  creditNotes: CreditNoteRow[];
  /** Every refund, to know what refunds that are pending already hold of a customer's credit. */
  refunds: RefundRow[];
};
```

In `src/components/finance/invoices-view.tsx`, replace:

```tsx
/** One thing open at a time: a form card, or a question in one row. */
type Open =
  | { kind: 'new'; today: string; nonce: number }
  /** `detail` is null while the draft's lines are being read. */
  | { kind: 'edit'; invoice: InvoiceListRow; detail: InvoiceDetail | null; today: string }
  | { kind: 'pay'; invoice: InvoiceListRow; today: string }
  | { kind: 'einvoice'; invoice: InvoiceListRow }
```

with:

```tsx
/** One thing open at a time: a form card, the note that something was saved, or a question in one row. */
type Open =
  | { kind: 'new'; today: string; nonce: number }
  /** `detail` is null while the draft's lines are being read. */
  | { kind: 'edit'; invoice: InvoiceListRow; detail: InvoiceDetail | null; today: string }
  | { kind: 'pay'; invoice: InvoiceListRow; today: string }
  | { kind: 'credit'; invoice: InvoiceListRow; today: string }
  | { kind: 'refund'; invoice: InvoiceListRow; today: string }
  /** A credit note or a refund has just been saved from this invoice's row. It shows on its own screen. */
  | { kind: 'saved'; what: 'credit' | 'refund'; invoice: InvoiceListRow }
  | { kind: 'einvoice'; invoice: InvoiceListRow }
```

In `src/components/finance/invoices-view.tsx`, replace:

```tsx
  const receivable = writer ? receivableInvoices(rows, writer.payments) : [];
  const asking = open && (open.kind === 'post' || open.kind === 'void' || open.kind === 'delete') ? open : null;
  // A form holds what was typed, so nothing else opens over it: it is closed with its own Cancel first.
  const formOpen = open !== null && !asking;
```

with:

```tsx
  const receivable = writer ? receivableInvoices(rows, writer.payments) : [];
  const creditable = writer ? creditableInvoices(rows) : [];
  const targets = writer ? refundTargets(rows, writer.creditNotes, writer.refunds) : [];
  const asking = open && (open.kind === 'post' || open.kind === 'void' || open.kind === 'delete') ? open : null;
  // A form holds what was typed, so nothing else opens over it: it is closed with its own Cancel first.
  // The note that something was saved holds nothing, and locks nothing.
  const formOpen = open !== null && !asking && open.kind !== 'saved';
```

In `src/components/finance/invoices-view.tsx`, replace:

```tsx
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
```

with:

```tsx
      case 'credit':
        return { label: 'Credit note', icon: FileMinus, opens: true, onSelect: () => ask({ kind: 'credit', invoice, today: now() }) };
      case 'refund':
        return { label: 'Refund', icon: Undo2, opens: true, onSelect: () => ask({ kind: 'refund', invoice, today: now() }) };
      case 'einvoice':
        return { label: 'Set e-Invois', icon: BadgeCheck, opens: true, onSelect: () => ask({ kind: 'einvoice', invoice }) };
      case 'void':
        return { label: 'Void', icon: Ban, destructive: true, opens: true, onSelect: () => ask({ kind: 'void', invoice }) };
    }
  };

  // Each choice is offered exactly when the form it opens would offer this invoice.
  const menu = (invoice: InvoiceListRow, actions: InvoiceActions): RowMenuItem[] =>
    invoiceActions(invoice, {
      pay: receivable.some((r) => r.id === invoice.id),
      credit: creditable.some((c) => c.id === invoice.id),
      refund: targets.some((t) => t.key === invoiceTargetKey(invoice.id)),
    }).map((action) => menuItem(invoice, action, actions));
```

In `src/components/finance/invoices-view.tsx`, replace:

```tsx
    if (open.kind === 'einvoice') {
      return <EInvoiceCard key={open.invoice.id} invoice={open.invoice} save={actions.setEInvoice} onClose={close} />;
    }
    return null;
  };
```

with:

```tsx
    if (open.kind === 'einvoice') {
      return <EInvoiceCard key={open.invoice.id} invoice={open.invoice} save={actions.setEInvoice} onClose={close} />;
    }
    if (open.kind === 'credit') {
      const { invoice } = open;
      return (
        <CreditNoteFormCard
          key={invoice.id}
          invoices={rows}
          today={open.today}
          invoiceId={invoice.id}
          actions={actions.creditNote}
          onClose={close}
          // The credit note is on Credit Notes; as a draft it changes nothing on this screen.
          onSaved={() => ask({ kind: 'saved', what: 'credit', invoice })}
        />
      );
    }
    if (open.kind === 'refund') {
      const { invoice } = open;
      return (
        <RefundFormCard
          key={invoice.id}
          targets={targets}
          accounts={writer.accounts}
          today={open.today}
          preselect={invoiceTargetKey(invoice.id)}
          record={actions.recordRefund}
          onClose={close}
          // The refund is on Refunds; left pending it changes no figure on this screen.
          onSaved={() => ask({ kind: 'saved', what: 'refund', invoice })}
        />
      );
    }
    if (open.kind === 'saved') {
      const subtitle = `${open.invoice.invoice_no ?? 'The invoice'} to ${open.invoice.customer_name}`;
      return open.what === 'credit' ? (
        <SavedNoteCard
          key={`credit-${open.invoice.id}`}
          title="Credit note saved"
          subtitle={subtitle}
          href="/finance/credit-notes"
          linkLabel="Credit Notes"
          onClose={close}
        >
          A draft is issued, changed or deleted, and an issued credit note can be voided or refunded, on
        </SavedNoteCard>
      ) : (
        <SavedNoteCard
          key={`refund-${open.invoice.id}`}
          title="Refund recorded"
          subtitle={subtitle}
          href="/finance/refunds"
          linkLabel="Refunds"
          onClose={close}
        >
          A refund left pending is marked as paid or deleted, and one that was paid out can be voided, on
        </SavedNoteCard>
      );
    }
    return null;
  };
```

- [ ] **Step 7: The Invoices loader reads what the two forms need**

Four edits to `src/screens/finance/invoices.tsx`. A writer's Invoices page now reads credit notes and refunds as well: two more reads, each a page of 1,000 rows at a time, so that a row offers "Refund" exactly when the refund form would accept it. A viewer has no menu, so neither is read for them.

In `src/screens/finance/invoices.tsx`, replace:

```tsx
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
```

with:

```tsx
  recordPaymentInAction,
  recordRefundAction,
  saveAndIssueCreditNoteAction,
  saveAndPostInvoiceAction,
  saveCreditNoteAction,
  saveInvoiceAction,
  setEInvoiceAction,
  voidInvoiceAction,
} from '@/app/(app)/finance/actions';
import { type InvoiceActions, InvoicesView } from '@/components/finance/invoices-view';
import { can } from '@/lib/auth/permissions';
import { getViewer, hasSupabaseEnv } from '@/lib/auth/viewer';
import { listContacts } from '@/lib/finance/contacts';
import { listCreditNotes } from '@/lib/finance/credit-notes';
import { listInvoices } from '@/lib/finance/invoices';
import { listAccounts, listPaymentsIn } from '@/lib/finance/money';
import { listProducts } from '@/lib/finance/products';
import { listRefunds } from '@/lib/finance/refunds';
```

In `src/screens/finance/invoices.tsx`, replace:

```tsx
  recordPayment: recordPaymentInAction,
  setEInvoice: setEInvoiceAction,
};
```

with:

```tsx
  recordPayment: recordPaymentInAction,
  setEInvoice: setEInvoiceAction,
  creditNote: { save: saveCreditNoteAction, saveAndIssue: saveAndIssueCreditNoteAction },
  recordRefund: recordRefundAction,
};
```

In `src/screens/finance/invoices.tsx`, replace:

```tsx
  // The payments feed "Received (MTD)" and the trend for everyone. The forms offer customers, products
  // and accounts; a viewer has no form, so none of them is read for them.
  const [rows, payments, contacts, products, accounts] = await Promise.all([
    listInvoices(ctx),
    listPaymentsIn(ctx),
    canEdit ? listContacts(ctx) : [],
    canEdit ? listProducts(ctx) : [],
    canEdit ? listAccounts(ctx) : [],
  ]);
```

with:

```tsx
  // The payments feed "Received (MTD)" and the trend for everyone. The forms offer customers, products
  // and accounts, and a row offers a refund by what credit notes and pending refunds leave of a customer's
  // credit; a viewer has no form and no menu, so none of them is read for them.
  const [rows, payments, contacts, products, accounts, creditNotes, refunds] = await Promise.all([
    listInvoices(ctx),
    listPaymentsIn(ctx),
    canEdit ? listContacts(ctx) : [],
    canEdit ? listProducts(ctx) : [],
    canEdit ? listAccounts(ctx) : [],
    canEdit ? listCreditNotes(ctx) : [],
    canEdit ? listRefunds(ctx) : [],
  ]);
```

In `src/screens/finance/invoices.tsx`, replace:

```tsx
              accounts,
              payments,
            }
```

with:

```tsx
              accounts,
              payments,
              creditNotes,
              refunds,
            }
```

- [ ] **Step 8: Check what the type-checker cannot**

Run: `grep -rn "comes in the next update" src`
Expected: no output. Both lines are gone.

Run: `grep -n -E "window\.confirm|alert\(|router\.|useRouter|redirect\(" src/components/finance/refunds-view.tsx src/components/finance/invoices-view.tsx src/screens/finance/refunds.tsx src/screens/finance/invoices.tsx`
Expected: no output.

Run: `grep -n -i -E "purple|violet|fuchsia|indigo|kuasa" src/components/finance/refunds-view.tsx src/components/finance/invoices-view.tsx src/screens/finance/refunds.tsx src/screens/finance/invoices.tsx`
Expected: no output.

Run: `grep -n "value=\"\"" src/components/finance/refunds-view.tsx src/components/finance/invoices-view.tsx`
Expected: no output.

Run: `grep -n -E "icon=\{" src/components/finance/refunds-view.tsx`
Expected: the `BentoCard` lines name `TrendingUp`, `PieChart` and `Banknote`; the others are `ConfirmRow` icons (`CircleCheck`, `Ban`).

Run: `grep -c "writer" src/components/finance/refunds-view.tsx`
Expected: a number above 10. Then read the file once for this: the header button, the form, every `RowMenu` and `question()` are reached only through `writer`.

Run: `grep -rn -E "invoiceActions\(.*, (true|false)\)" src tests`
Expected: no output. Every call passes an object as its second argument; none passes a boolean any more.

- [ ] **Step 9: Type-check, lint, run the unit tests, and build**

Run, as separate commands: `pnpm exec tsc --noEmit`, `pnpm lint`, `pnpm exec vitest run --exclude 'tests/*.rls.test.ts' --exclude 'tests/bendahara-*.test.ts'`, `NEXT_PUBLIC_SUPABASE_URL= NEXT_PUBLIC_SUPABASE_ANON_KEY= SUPABASE_SERVICE_ROLE_KEY= pnpm build`
Expected: no type errors; no lint errors; every unit test passes, 4,154 in all; the build completes and lists `/finance/refunds`, `/finance/credit-notes` and `/finance/invoices`.

Do **not** run `pnpm dev`, and do not open a browser.

- [ ] **Step 10: Commit**

```bash
git add src/components/finance/refunds-view.tsx src/screens/finance/refunds.tsx src/lib/finance/sales-views.ts tests/finance-sales-rules.test.ts src/components/finance/invoices-view.tsx src/screens/finance/invoices.tsx
git commit -m "feat: refunds get their form and row menus; an invoice's row offers a credit note and a refund"
```

---


### Task 7: Document, verify the branch, hand back

**Files:**
- Modify: `src/config/live-screens.ts` (a comment)
- Modify: `docs/bendahara-backend.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing new.

- [ ] **Step 1: Correct the comment in `src/config/live-screens.ts`**

Nothing under Sales is read-only any more.

In `src/config/live-screens.ts`, replace:

```ts
  'finance/quotations',
  // Read-only so far: their forms and row actions join in the next slice.
  'finance/credit-notes',
```

with:

```ts
  'finance/quotations',
  'finance/credit-notes',
```

- [ ] **Step 2: Update the backend note**

Eleven edits to `docs/bendahara-backend.md`, in the order they come in the file: the table of pure files and the paragraphs after it ("Write path"), "Invoices", "Credit notes", "Database functions", "Error codes", then "Known limits". Each old text occurs once.

In `docs/bendahara-backend.md`, replace:

```markdown
| `sales-followon-views.ts` | KPI figures, chart data, table filters, status words and CSV rows for Quotations, Credit Notes and Refunds; what a quotation's row menu offers (`quotationActions`) |
```

with:

```markdown
| `sales-followon-views.ts` | KPI figures, chart data, table filters, status words and CSV rows for Quotations, Credit Notes and Refunds; what a row's menu offers on each (`quotationActions`, `creditNoteActions`, `refundActions`) |
```

In `docs/bendahara-backend.md`, replace:

```markdown
| `receipt-form.ts` | The payment-in form: which invoices can take a payment and how much (`receivableInvoices`), defaults, validation, what is sent. It has no scheduling |
```

with:

```markdown
| `receipt-form.ts` | The payment-in form: which invoices can take a payment and how much (`receivableInvoices`), defaults, validation, what is sent. It has no scheduling |
| `credit-note-form.ts` | The credit note form: which invoices can take a credit note and how much (`creditableInvoices`: posted, for the total less what is already credited), defaults, validation, what is sent. `creditNoteSavedNotIssued` words a credit note that was saved as a draft but not issued |
| `refund-form.ts` | The refund form: what can be refunded and how much (`refundTargets`: an invoice whose customer is in credit, or one of its issued credit notes, less refunds that are pending), defaults, validation, what is sent |
```

In `docs/bendahara-backend.md`, replace:

```markdown
a bill, an invoice and a quotation, or between money out and money in, belongs
in the kind, not in the card.
```

with:

```markdown
a bill, an invoice and a quotation, or between money out and money in, belongs
in the kind, not in the card. `withCurrentParty` in `document-form.ts` gives
all three document cards their picker's list: the active customers or
suppliers, with a draft's own party first when it was archived since.

A credit note and a refund each have a card of their own
(`credit-note-form-card.tsx`, `refund-form-card.tsx`), and no kind. A credit
note is one invoice, one amount and a reason: no lines, so not the document
card; no account and no method, so not the payment card. A refund is one
payment against exactly one invoice or one credit note, with a reason; the
payment card splits one payment across many documents. Both cards are used on
more than one screen: the credit note card on Credit Notes and from an
invoice's row, the refund card on Refunds and from an invoice's or a credit
note's row. Where the thing saved shows on another screen than the one the
person is on, a note at the top says so and links there (`saved-note-card.tsx`).
```

In `docs/bendahara-backend.md`, replace:

```markdown
counts or names a quotation. A quotation made into an invoice: Quotations and
Invoices, as a draft invoice is not yet owed.
```

with:

```markdown
counts or names a quotation. A quotation made into an invoice: Quotations and
Invoices, as a draft invoice is not yet owed. A draft credit note saved or
deleted: Credit Notes only, as a draft takes nothing off its invoice. A credit
note issued or voided, and a refund recorded, marked paid, voided or deleted:
Invoices, Payments In, Customers & Suppliers, Credit Notes and Refunds, as
each can move what an invoice owes; never Payments Out, which shows no refund,
and not Quotations.
```

In `docs/bendahara-backend.md`, replace:

```markdown
What a row's menu offers follows its status (`invoiceActions`): a draft is
edited, posted or deleted; a posted invoice takes a payment while something is
still owed, has its e-Invois set, and can be voided; a void invoice offers
nothing. Voiding an invoice that has payments is offered and refused with the
reason, as on a paid bill.
```

with:

```markdown
What a row's menu offers follows its status (`invoiceActions`): a draft is
edited, posted or deleted; a posted invoice takes a payment while something is
still owed, a credit note while its total is not yet credited in full, and a
refund while its customer is in credit and pending refunds do not already hold
all of that credit; it has its e-Invois set, and can be voided; a void invoice
offers nothing. Each of the three is offered exactly when the form it opens
would offer the invoice (`receivableInvoices`, `creditableInvoices`,
`refundTargets`), so a writer's Invoices page also reads the credit notes and
the refunds. Voiding an invoice that has payments, credit notes or refunds is
offered and refused with the reason, as on a paid bill. "Credit note" and
"Refund" open their cards on Invoices with that invoice chosen; what is saved
shows on Credit Notes or Refunds, and a note at the top links there.
```

In `docs/bendahara-backend.md`, replace:

```markdown
The view `finance_credit_note_totals` adds the invoice's number, the customer
and `refunded`: posted refunds put against the note itself.
```

with:

```markdown
The view `finance_credit_note_totals` adds the invoice's number, the customer
and `refunded`: posted refunds put against the note itself.

The form offers posted invoices, each for its total less what is already
credited (`creditableInvoices`); a draft credit note is not counted, as the
database does not count one until it is issued. It is saved as a draft, or
saved and issued in one go (`saveAndIssueCreditNoteAction`, through
`saveThenPost`). Edit opens from the list row, which carries everything a
credit note has: there is no read action for one draft. What a row's menu
offers follows its status (`creditNoteActions`): a draft is edited, issued or
deleted; an issued credit note is voided, and refunded while something of it
can still be; a void one offers nothing.

## Refunds

The form offers what `refundTargets` works out from the invoices, the credit
notes and the refunds, to the sen, and it is what the database allows. An
invoice: what its customer is in credit there (`balance` below zero, which
already has every refund that was paid out in it), less refunds that are
pending against the invoice or against any of its credit notes. An issued
credit note of such an invoice: the same figure, and no more than the note's
amount less every refund standing against the note, paid out or pending.
Choosing one fills the amount with all it can take. The refund is paid out now
or left pending.

What a row's menu offers follows its status (`refundActions`): a pending
refund is marked as paid, with the date it was paid out, or deleted; one that
was paid out is voided; a void one offers nothing. A refund has no edit. A
refund still being written (`draft`) reads "Pending" and is counted as
pending; the app never leaves one in that state.
```

In `docs/bendahara-backend.md`, replace:

```markdown
`acceptQuotationAction`, `declineQuotationAction`, `deleteQuotationAction` and
`convertQuotationAction`; no server action calls the credit note or refund
writes yet.
```

with:

```markdown
`acceptQuotationAction`, `declineQuotationAction`, `deleteQuotationAction` and
`convertQuotationAction`; the credit note writes by `saveCreditNoteAction`,
`issueCreditNoteAction`, `saveAndIssueCreditNoteAction`,
`voidCreditNoteAction` and `deleteCreditNoteAction`; the refund writes by
`recordRefundAction`, `markRefundPaidAction`, `voidRefundAction` and
`deleteRefundAction`.
```

In `docs/bendahara-backend.md`, replace:

```markdown
either. The credit note and refund sentences for `FIN01` and `FIN09` are
checked the same way when their buttons are built.
```

with:

```markdown
either.

The sentence for `FIN01` on a credit note is "That cannot be done to this
credit note as it now stands. It may have been issued or voided since this
page was loaded.", and for `FIN09` on a refund "That cannot be done to this
refund as it now stands. It may have been paid out or voided since this page
was loaded.". Each was checked from every button that can meet it: Save,
Issue, Void and Delete on a credit note; Mark as paid, Void and Delete on a
refund.

`FIN04` and `FIN05` are worded twice for a refund, by the button. Recording
one: "A refund needs a posted invoice, or an issued credit note, whose
customer is in credit." and "That is more than the customer is in credit, or
more than is left of the credit note.". Paying a pending one out
(`markRefundPaid` only), where the same codes mean the credit has gone since
it was recorded: "This refund can no longer be paid out: its invoice is no
longer posted, or its credit note is no longer issued. Delete it." and "This
refund no longer fits in what the customer is in credit, or in what is left of
its credit note, so it cannot be paid out. Delete it, and record a new one for
what is left.".
```

In `docs/bendahara-backend.md`, replace:

```markdown
  invoice, a second quotation, a second part-payment or a second receipt,
  until writes carry a client-generated id (which needs a migration). A second
```

with:

```markdown
  invoice, a second quotation, a second credit note, a second part-payment, a
  second receipt or a second refund,
  until writes carry a client-generated id (which needs a migration). A second
  credit note is refused once the two together exceed the invoice's total, and
  a second refund once the two together exceed the customer's credit; below
  those caps both go through. A second draft credit note or pending refund is
  deleted; a second issued credit note or paid refund is voided. A second
```

In `docs/bendahara-backend.md`, replace:

```markdown
- Credit Notes and Refunds are read-only so far: search, filters, "View all"
  and Export, but no forms and no row actions. The data layer for them is in
  `credit-notes.ts` and `refunds.ts`.
```

with:

```markdown
- A refund cannot be edited, pending or paid: delete a pending one and record
  it again; void a paid one.
- An issued credit note cannot be edited: void it and write a new one. It
  cannot be voided while a refund depends on it; "Void" is offered all the
  same and refused with the reason.
- The credit note form offers an invoice for its total less what is issued
  against it. Two drafts for the same invoice can together exceed that; the
  second to be issued is then refused.
- "Refund" is offered on an invoice's row and on a credit note's row only
  while something can be refunded there. A customer is only ever in credit
  because of a credit note: a payment in cannot exceed what is owed.
- A credit note or a refund made from an invoice's row is saved on its own
  screen; Invoices says so in a note with a link and does not go there by
  itself.
- An id that is not an id sent to `voidRefundAction` or `deleteRefundAction`
  is answered "That payment no longer exists.": a refund's id is parsed by the
  schema a payment's is. Only a direct call can send one.
- `voidPaymentIn` is kept to `direction = 'in'` and reads no view first: every
  movement of money in is a payment in. When cash receipts arrive (stage 5),
  money in gains a second kind and this must be looked at again.
- "Make invoice" dates the new invoice with the database's date (UTC), which
  before 08:00 in Malaysia is the day before; credit notes and refunds take
  their dates from the form and do not have this. Closing it needs
  `finance_convert_quotation` to take a date, which is a migration of its own.
```

In `docs/bendahara-backend.md`, replace:

```markdown
- The reason of a refund is one of five words; anything more is in the
  payment's notes.
```

with:

```markdown
- The reason of a refund is one of five words; anything more is in the
  payment's notes. The Refunds table shows neither the notes nor the account;
  the CSV has the account.
```

- [ ] **Step 3: Run everything**

Run, as separate commands: `pnpm exec tsc --noEmit`, `pnpm lint`, `pnpm exec vitest run --exclude 'tests/*.rls.test.ts' --exclude 'tests/bendahara-*.test.ts'`, `NEXT_PUBLIC_SUPABASE_URL= NEXT_PUBLIC_SUPABASE_ANON_KEY= SUPABASE_SERVICE_ROLE_KEY= pnpm build`
Expected: no type or lint errors (the one warning in `tests/apply-proposal.test.ts` is on `main`); every unit test passes, 4,154 in all (77 more than the 4,077 on `main` when this plan was written); the build completes.

Do **not** run `pnpm test`, `tests/bendahara-*.test.ts` or `tests/*.rls.test.ts`: they write to the hosted production database. This branch changes no table, view, function or policy, and edits none of those files.

- [ ] **Step 4: Check the boundaries the build does not check**

Run: `grep -n "^export" "src/app/(app)/finance/actions.ts" | grep -v "export async function"`
Expected: no output. A `'use server'` file exports only async functions.

Run: `grep -l -E "supabase/server|next/headers" src/lib/finance/*.ts src/screens/finance/sales-sample.ts`
Expected: no output.

Run: `git diff main -- src | grep -n -i -E "^\+.*(purple|violet|fuchsia|indigo|kuasa)"`
Expected: no output.

Run: `grep -rn -E "window\.confirm|alert\(|router\.refresh|useRouter|redirect\(" src/components/finance src/screens/finance/credit-notes.tsx src/screens/finance/refunds.tsx src/screens/finance/invoices.tsx`
Expected: no output.

Run: `git diff main --stat -- supabase`
Expected: no output. There is no migration in this stage.

Run: `git diff main --stat -- tests/finance-bill-form.test.ts tests/finance-payment-form.test.ts tests/finance-bill-math.test.ts tests/finance-bills.test.ts tests/finance-actions.test.ts tests/finance-purchase-views.test.ts tests/finance-shared.test.ts tests/finance-document-form.test.ts tests/finance-document-kind.test.ts tests/finance-allocation-form.test.ts tests/finance-invoice-form.test.ts tests/finance-receipt-form.test.ts tests/finance-sales-actions.test.ts tests/finance-sales-views.test.ts tests/finance-money.test.ts tests/finance-quotations.test.ts tests/finance-quotation-form.test.ts tests/finance-quotation-rules.test.ts tests/finance-quotation-actions.test.ts tests/finance-followon-views.test.ts tests/finance-schemas.test.ts`
Expected: no output. Of the existing test files only three were edited, each for a reason given in a decision: `tests/finance-credit-notes.test.ts` and `tests/finance-refunds.test.ts` (the sentences, Decision 4) and `tests/finance-sales-rules.test.ts` (what an invoice's row offers, Decision 8).

Run: `git diff main --stat -- src/components/finance/quotations-view.tsx src/components/finance/bills-view.tsx src/components/finance/payments-view.tsx src/components/finance/payments-in-view.tsx src/components/finance/document-form-card.tsx src/components/finance/allocation-form-card.tsx src/lib/finance/money.ts src/lib/finance/quotations.ts src/lib/finance/invoices.ts`
Expected: no output. Quotations, Supplier Bills, Payments Out and Payments In are untouched, as are both shared cards and `voidPaymentIn`.

Run: `grep -rn "comes in the next update" src`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add src/config/live-screens.ts docs/bendahara-backend.md
git commit -m "docs: credit notes and refunds are writable"
```

- [ ] **Step 6: Hand back**

Do not push. Report what was built, the result of the four commands in Step 3, and anything that had to differ from this plan. The controller pushes and opens the PR (title `feat-121-bendahara-credit-note-refund-forms`; the body has no close keyword unless `gh issue list` shows an issue that is exactly this stage, and no issue is opened for the purpose) when the owner says so.

---


## Controller: production smoke test after the merge

Not a task for an implementer. Run on `https://openkuasa.com` after the merge has deployed, in the Chrome session that is already signed in as the smoke account `smoke@openkuasa-test.dev`, workspace "Smoke Test Co" (`~/.config/openkuasa/smoke-account.json`). **The tester never types a password.** If the session is signed out, stop and ask the owner to sign in. After each navigation wait and take a screenshot before clicking: a background tab stays on the loading skeleton. There is no migration to apply before or after this deploy.

Everything below is created in the smoke workspace. An issued credit note and a refund that was paid out cannot be deleted, and a credit note that a refund depends on cannot be voided: what this test issues and pays out stays there. The steps are written so that both invoices end settled, with nobody in credit, nothing pending and no draft. Put `Smoke 4b2` in the Notes box of every credit note and refund so they are recognisable. The figures in each step follow from the steps before it; if one does not match, stop there and work out why before going on.

1. **Open, as a writer.** `/finance/credit-notes` has a "New Credit Note" button and `/finance/refunds` a "New Refund" button. If the workspace has no credit notes or refunds yet, the tables read "No credit notes yet. Add the first one with New Credit Note." and "No refunds yet. Record the first one with New Refund, once a customer is in credit."; nothing anywhere says "next update".
2. **An invoice to work on.** Reuse the customer `=Smoke 3b, Customer 林` (payment terms 14) from the earlier tests; add it on Customers & Suppliers if it is gone. On Invoices: New Invoice, that customer, one line "Smoke 4b2 service", Qty 1, unit price 100, SST 0, "Save and post". Call it **invoice A**: it has an `INV-` number, Total RM 100.00, Balance RM 100.00, Sent. Its "⋯" offers Record payment, Credit note, Set e-Invois and Void, each on one line beside its icon, and no Refund.
3. **Nothing to refund.** On Refunds, "New Refund". If no customer of the workspace is in credit, the card reads "There is nothing to refund. A refund pays out what a customer is in credit on a posted invoice…" with a Close button, and no form. Close.
4. **A draft credit note, and what the form refuses.** On Credit Notes, "New Credit Note". The card is titled "New credit note" and says "Saved as a draft until it is issued". "Against invoice" lists invoice A as "INV-… · =Smoke 3b, Customer 林 · RM 100.00 left to credit" (the customer's name as text, no formula run). Choose it: the line under the picker reads "Total RM 100.00 · RM 0.00 already credited · RM 100.00 left to credit". "Save draft" at once: "Choose a reason.". Choose Returns: the sentence goes at once; "Save draft": "Enter an amount above 0.". Type 100.01, "Save draft": "That is more than this invoice has left to credit.". Type `1,200.50`: Chrome drops the comma, the box holds 1200.50 and the same sentence comes back; pasted, or in another browser, the answer is "Enter an amount above 0."; either is right, and nothing was saved. Type 30, press Enter in the amount box: nothing is saved. Type `Smoke 4b2` in Notes. "Save draft": the card closes; the table has a Draft row with "—" for its number, invoice A's number under "Against invoice", Returns, RM 30.00 and "—" under Refunded. The Drafts card went up by one; "Credited (MTD)" did not move. On Invoices, invoice A still owes RM 100.00.
5. **Edit it.** The draft's "⋯" offers Edit, Issue and Delete, and nothing else. Edit: the form opens at once (there is no "Loading…"), titled "Edit credit note", with the invoice, the date, Returns, 30.00 and the note. While it is open "New Credit Note" is disabled and the other rows' "⋯" do nothing. Change the amount to 40, "Save draft": the row shows RM 40.00.
6. **Issue it.** "⋯" → Issue: the question is not red, names RM 40.00, the customer and invoice A, and focus is on Cancel; Escape closes it. Open it again and confirm. The row gets a `CN-` number and reads Issued with a green dot; Refunded reads RM 0.00; its "⋯" offers Void only (the customer is not in credit, so no Refund). "Credited (MTD)" went up by RM 40. On Invoices, invoice A's Balance is RM 60.00 and it is still Sent; Total receivable went down by RM 40. On Customers & Suppliers the customer's Receivable went down by RM 40. On Payments In, "Record Payment" offers invoice A with "RM 60.00 owed"; cancel.
7. **Pay the rest.** On Invoices, invoice A → Record payment → RM 60.00 → "Record payment". It reads Paid with Balance RM 0.00. Its "⋯" now offers Credit note, Set e-Invois and Void: no Record payment, and no Refund, since the customer is exactly settled.
8. **A credit note from the invoice's row, saved and issued in one go.** Invoice A → "⋯" → Credit note. The card opens on Invoices with invoice A already chosen and the line "Total RM 100.00 · RM 40.00 already credited · RM 60.00 left to credit". Reason Goodwill, amount 25, `Smoke 4b2`, "Save and issue" (the button reads "Issuing…" while it works). The form closes; a card "Credit note saved" is at the top of the page, in view, with focus on its "Credit Notes" link; the menus behind it work while it is open. Invoice A's Balance reads "RM 25.00 in credit", never a negative amount; it is still Paid; Total receivable did not move. Close the note. Invoice A's "⋯" now offers Credit note, Refund, Set e-Invois and Void.
9. **A refund left pending, from the invoice's row.** Invoice A → "⋯" → Refund. The card "Record refund" opens with "Refund for" on invoice A, the amount 25.00, and under the picker "Up to RM 25.00: what the customer is in credit on INV-…, less refunds that are pending.". Open the picker: it lists invoice A and both credit notes ("CN-… on INV-… · … · RM 25.00 can be refunded"), each at RM 25.00: the invoice's credit limits all three. Leave invoice A chosen. "Record refund" at once: "Choose a reason.". Choose Overpayment. Type 25.01: "That is more than the customer is in credit, or more than is left of the credit note."; no word about deleting anything. Type 10. Choose "Leave pending": the date's label becomes "Planned date" and the button "Save as pending". `Smoke 4b2` in Notes. Save. A card "Refund recorded" is at the top with focus on its "Refunds" link. Invoice A still reads "RM 25.00 in credit": a pending refund is not money out. Follow the link: Refunds has a row with "—" for its number, invoice A, "—" under Credit note, Overpayment, RM 10.00 and "Pending" in amber. The cards read Pending RM 10 (1 refund) and In credit RM 25 (1 invoice), if nothing else in the workspace is in credit.
10. **A refund paid out now, from a credit note's row.** On Credit Notes both issued rows offer Refund and Void. On the RM 25.00 credit note → Refund: the card opens with that credit note chosen ("CN-… on INV-…"), the amount 15.00 (the RM 25.00 credit less the RM 10.00 that is pending), and the line under the picker ends "and no more than is left of CN-….". Reason Other, "Pay out now", `Smoke 4b2`, "Record refund". A card "Refund recorded" is at the top. Close it. That credit note's Refunded reads RM 15.00. Neither credit note offers Refund any more (RM 15.00 is paid out and RM 10.00 is held: nothing is free). On Refunds the new row has a `PV-` number, the credit note's number under Credit note, and reads Refunded with a green dot; "Refunded (MTD)" went up by RM 15. On Invoices, invoice A reads "RM 10.00 in credit" and its "⋯" has no Refund.
11. **A credit note that refunds depend on cannot be voided.** On Credit Notes, the RM 25.00 credit note → Void: the question is red and says a credit note cannot be voided while a refund depends on it. Confirm: refused in the row with "A refund depends on this credit note. Void or delete that refund on Refunds before voiding it.". Cancel: the sentence goes with the question. The RM 40.00 credit note → Void → confirm: the same sentence (no refund is against it, but the refunds on the invoice would not fit in the customer's credit without it). Cancel.
12. **Nor can the invoice.** On Invoices, invoice A → Void → confirm: "This invoice has payments or refunds. Void the payments on Payments In, and void or delete the refunds on Refunds, before voiding it.". Cancel.
13. **Mark the pending refund as paid.** On Refunds, the Pending row's "⋯" offers Mark as paid and Delete. Mark as paid: the question is not red and has a date box holding today's date on this computer. Empty the date and confirm: "Enter a valid date.". Put today's date back and confirm. The row gets a `PV-` number and reads Refunded. Its "⋯" offers Void only. On Invoices, invoice A's Balance is RM 0.00. On Refunds "In credit" is back to what it was before step 8.
14. **Void a refund; record one from Refunds; delete it.** On Refunds, the RM 10.00 refund → Void: the question is red and says the customer will be in credit again. Confirm. The row leaves the list (choose Void in the status filter: it is there, struck through). Invoice A reads "RM 10.00 in credit" again. On Refunds, "New Refund": nothing is chosen, and the picker lists invoice A and both credit notes, each at RM 10.00. Choose invoice A: the amount fills in as 10.00. Reason Other, "Leave pending", save: the row appears in the table behind, Pending, and no note card opens (this is its own screen). On that row "⋯" → Delete: the question is red and says nothing has been paid out. Confirm: the row goes.
15. **A pending refund whose credit has gone.** Record the same pending refund again (invoice A, RM 10.00, "Leave pending"). On Payments In, void the RM 60.00 payment from step 7. On Invoices, invoice A is owed again: Balance RM 50.00 (its RM 100.00, less RM 65.00 credited, plus the RM 15.00 refund that was paid out), Sent; Customers & Suppliers shows RM 50 more receivable. On Refunds, the pending row → Mark as paid → confirm: refused in the row with "This refund no longer fits in what the customer is in credit, or in what is left of its credit note, so it cannot be paid out. Delete it, and record a new one for what is left.". Cancel, and delete it from its row. On Invoices, invoice A → Record payment → RM 50.00 → record: Paid, Balance RM 0.00.
16. **Two tabs.** Make **invoice B** as in step 2 with a unit price of 200, and record a payment of RM 200.00 on it: Paid. (a) Save a draft credit note of RM 20 against invoice B. In tab A open it with Edit and change the amount to 21. In tab B issue it from its row. In tab A press "Save draft": the form shows "That cannot be done to this credit note as it now stands. It may have been issued or voided since this page was loaded.", 21 is still in the box, and the row behind the form reads Issued. Cancel. (b) Save a draft of RM 30 against invoice B and reload both tabs. In tab B issue it. In tab A, where the row still reads Draft, "⋯" → Issue → confirm: the same sentence, and no word about editing or deleting; after Cancel the row reads Issued. Invoice B reads "RM 50.00 in credit". (c) Record a pending refund of RM 50.00 against invoice B and reload both tabs on Refunds. In tab B mark it as paid. In tab A → Mark as paid → confirm: "That cannot be done to this refund as it now stands. It may have been paid out or voided since this page was loaded."; after Cancel the row reads Refunded. Reload both tabs. In tab B void it. In tab A → Void → confirm: the same sentence, and no advice to void a refund; after Cancel the row has left the list. (d) In tab A, "New Refund", choose invoice B (RM 50.00), reason Other. In tab B record a refund of RM 50.00 against invoice B, paid out now. In tab A press "Record refund": "A refund needs a posted invoice, or an issued credit note, whose customer is in credit.", and if nothing else in the workspace is in credit the card now reads "There is nothing to refund…" beside that sentence. Close. Invoice B's Balance is RM 0.00.
17. **A stale credit note form, and settling invoice A.** Invoice A has RM 35.00 left to credit (RM 100.00 less RM 65.00). In tab A, "New Credit Note", invoice A, Goodwill, 35; do not save. In tab B, the same, and "Save and issue". In tab A press "Save and issue": "That is more than this invoice has left to credit."; 35 is still in the box, invoice A is still chosen, and the line under the picker now reads "Total RM 100.00 · RM 100.00 already credited · RM 0.00 left to credit". Cancel. On Invoices, invoice A reads "RM 35.00 in credit" and its "⋯" offers Refund and no Credit note. Refund → RM 35.00, Other, "Pay out now", record. Invoice A's Balance is RM 0.00; its "⋯" offers Set e-Invois and Void only.
18. **Not a writer.** In the demo workspace (or signed in as a viewer): Credit Notes and Refunds show the figures, charts, tables, search, filters and Export, with no header button and no "⋯"; a pending refund reads "Pending" in amber. Invoices has no "⋯" either.
19. **Export, 390 px and dark mode.** Export on Credit Notes and on Refunds: the files (`credit-notes-YYYY-MM-DD.csv`, `refunds-YYYY-MM-DD.csv`) open; the customer reads `'=Smoke 3b, Customer 林` in one cell and no formula has run; Amount is a number that can be summed; a draft's and a pending refund's No. is empty. At 390 px wide, in light and in dark: both screens with rows; the credit note form and the refund form (every box usable, nothing scrolls sideways, the picker's long lines readable or cut off cleanly); a row's "⋯" open on each of the three screens, every label on one line beside its icon ("Record payment", "Credit note", "Refund", "Mark as paid"); a question open in a row, readable with the table scrolled sideways; the "Credit note saved" and "Refund recorded" cards. No purple anywhere.
20. **The forms whose picker was touched, and Quotations.** New Bill, New Invoice and New Quotation each open with their supplier or customer list as before. If a draft exists whose customer has since been archived, open it with Edit: that customer is chosen and first in the list. (If none exists: save a draft quotation for "Smoke 3b Second", archive that contact on Customers & Suppliers, Edit the draft, see the name in the picker, cancel, delete the draft and restore the contact.) Quotations otherwise behaves as part 1's smoke test left it.

**What this leaves behind,** to list for the owner, who decides whether it stays:

- Invoices: A (RM 100.00) and B (RM 200.00), both posted, both with Balance RM 0.00. Neither can be voided while its credit notes and refunds stand.
- Credit notes, all issued, all with `Smoke 4b2` in their notes: three against invoice A (RM 40.00, RM 25.00, RM 35.00) and two against invoice B (RM 20.00, RM 30.00). None can be deleted, and none voided while the refunds depend on them.
- Refunds: paid out and standing, RM 15.00 and RM 35.00 on invoice A and RM 50.00 on invoice B; voided, RM 10.00 on invoice A and RM 50.00 on invoice B. None can be deleted.
- Payments in: RM 60.00 (void) and RM 50.00 on invoice A, RM 200.00 on invoice B.
- Document numbers used: two `INV-`, five `CN-`, five `PV-`, three `RC-`.
- Nobody is left in credit, no refund is left pending, and no draft credit note is left: delete any the test did not. Step 20's draft quotation is deleted and its contact restored.

---

## Self-review notes

**Spec coverage for this part.**

- Common behaviour: layout kept (the stage 4a views are extended, not redrawn); the forms as cards closed by default (Tasks 5, 6); a "⋯" menu per row with the actions that apply (Tasks 2, 3, 5, 6); delete and void confirmed in the page, and every other row action too (5, 6); search, filters, "View all" and Export unchanged; viewers get no buttons and no menus and the actions check again (4, 5, 6, with tests in 4); sample data with no actions when there is no Supabase environment (5, 6).
- Sales, Credit Notes: "New against an invoice, edit draft, issue, refund, void" (Tasks 2, 4, 5), and delete draft, with the three states.
- Sales, Refunds: "New against an invoice or credit note with a reason, mark paid out, delete" (Tasks 3, 4, 6), and void for one that was paid out, with Pending and Refunded.
- Sales, Invoices: "issue credit note" (Task 6), and a refund from the row while the customer is in credit.
- Code: one schema and one function per write (4a), called by actions that guard, parse, call and revalidate (Task 4); view and form rules as pure functions (Tasks 1 to 3, 6); loader screens that pass actions only to writers (5, 6).
- Errors: messages beside the form with typed values kept (5); refusals as sentences (Task 1, and the table near the top); "a record changed or removed by someone else: the form says so and reloads" (Task 4, and smoke step 16).
- Testing: unit tests for every rule (Tasks 1 to 4, 6); the smoke list above. No database test is added or edited: nothing in the database changes.

**Each thing part 1 left to part 2 ("What part 2 takes"), and where it is settled.**

| Left by part 1 | Settled in |
|---|---|
| Credit notes: new, edit, issue, void, delete; "Save and issue" through `saveThenPost`; a card of its own | Tasks 2, 4, 5; Decision 5 |
| Refunds: record, paid now or pending; mark paid; void; delete; a card of its own | Tasks 3, 4, 5, 6; Decision 5 |
| "Issue credit note" and "Refund" on an invoice's row; "Refund" on a credit note's row; `invoiceActions` and the test that pins it | Task 6 (invoice), Task 5 (credit note); Decisions 8 and 9 |
| The caps as pure, tested functions mirroring `receivableInvoices`; pending refunds from the refund rows | `creditableInvoices` (Task 2), `refundTargets` (Task 3), with the table in Task 3 of where each figure is read |
| Every new action refuses a viewer before parsing, with the same two tests | Task 4, the first two tests of `tests/finance-credit-refund-actions.test.ts` |
| Refresh paths: "the six sales screens; never Payments Out" | Five, and one for a draft: Decision 3 and the table; pinned per action in Task 4. Never Payments Out: pinned |
| `CREDIT_NOTE_MESSAGES.locked`, `REFUND_MESSAGES.locked`, `notInCredit`, `tooMuch` checked from their buttons | Task 1, Decision 4, the per-button table |
| The retry limit for the two new forms | Lived with: Decision 18; Known limits (Task 7) |
| The grey badge of a draft refund | Task 6 (amber), Decision 16 |
| The two "…comes in the next update" lines | Tasks 5 and 6; checked by grep in Tasks 6 and 7 |
| The comment in `src/config/live-screens.ts` | Task 7 |
| `voidPaymentIn`, if cash receipts have arrived | They have not: Decision 17; Known limits (Task 7) |
| A smoke list with rows the smoke workspace made itself | Steps 2 to 17 |

Also carried from the brief: the lines that put an archived customer first, made one helper (Task 1, Decision 15); the open question about "Make invoice" and its date (Decision 1); that a number box drops a typed comma in Chrome (smoke step 4 says what to expect either way).

**Checked by running, not only by reading.** Every file this plan creates or replaces was written once, outside the working tree, and this document was assembled from those files and from the edits as written here. Then every code block of this document was applied, task by task, to a fresh copy of the repository outside the working tree, by a script that reads only this file: "Create", "Replace the whole of" and "In …, replace: … with:" are the three instructions it understands, and it stops if a text to replace does not occur exactly once. (A task ends at the next heading that is not inside a code block: Task 7 replaces text in `docs/bendahara-backend.md` that holds a `## ` line of its own.) After each task there: `tsc --noEmit` clean, `eslint` clean but for the one warning that is on `main`, and the unit suite passing with the two excludes (4,077 tests on `main` when this was written; 4,082 after Task 1, 4,106 after Task 2, 4,138 after Task 3, 4,151 after Tasks 4 and 5, 4,154 after Tasks 6 and 7). The edited and new tests of Task 1, and the edited tests of Task 6, were also run against the code as it stood before each change, to see the failures their "run them to see them fail" steps name (nine and four). At the end a production build completed with the three Supabase variables emptied and listed the three routes. The two new views, the Invoices view and the three new cards were also rendered once on the server with the sample rows, for a viewer and for a writer, to see that they do not throw and that a viewer's page has no button and no menu; `refundTargets` was run over the sample and offered RM 600.00 of the sample's RM 1,600.00 of credit, the other RM 1,000.00 being held by its two pending refunds, as stage 4a's notes say. No database was touched, no live test was run, and no browser was used: there is no SQL in this plan to run anywhere. Layout at 390 px, focus moving to the note after a save, the Radix menus and selects opening, and the downloads are first seen in the smoke test.

**Unsure about, stated plainly.**

1. Decision 1. Leaving "Make invoice" as it is was a judgement about what belongs in this pull request; the owner raised it and may want it sooner than a follow-up.
2. Whether focus reliably lands on the link in the "Credit note saved" and "Refund recorded" cards and scrolls them into view when the row used was far down the page. It is done in an effect that runs once when the card mounts, as on Quotations; smoke steps 8 to 10 show it.
3. That the form closing and the list refreshing arrive in one paint. If the refresh lands first, the refund card would for a moment show its choice dropped, or "There is nothing to refund", before it closes. The rules make that harmless (nothing is sent twice); smoke steps 9, 10 and 17 are where it would be seen.
4. Refreshing Credit Notes alone for a draft (Decision 3). It rests on nothing outside that screen reading a draft credit note; that is true of every view builder today, and a later screen that lists drafts would need the list widened.
5. "Credit note" as a menu label is a noun where its neighbours are verbs. It fits the menu's width; "Issue credit note" does not, and "New credit note" is not what it does to the row.
6. The refund picker is a plain list with no search, and its lines are long ("CN-0003 on INV-0007 · customer · RM … can be refunded"). With many customers in credit it will be unwieldy, and at 390 px a line may be cut off; the amount and the hint under the picker repeat what matters.
7. Neither form restricts its date: a credit note can be dated before its invoice, and "pay out now" accepts a future date, as payments do today. The database does not restrict them either.
8. `Void` is offered on an issued credit note that cannot be voided (Decision 14). The refusal says what to do; a person may still wonder why it was offered.
9. A writer's Invoices page now makes seven reads where it made five. Each is paged; nothing was measured.
10. The sentence for `FIN05` when a pending refund is paid out says to "record a new one for what is left". After the payment in was voided there is usually nothing left, and the sentence does not say so.
