# Bendahara backend

How the finance screens read and write. Design:
`docs/superpowers/specs/2026-10-10-bendahara-crud-design.md`.

## Write path

Each write is one Zod schema and one function in `src/lib/finance/`, taking a
`FinanceWriteContext` (`{ client, orgId }`) and returning a `FinResult`. The
server actions in `src/app/(app)/finance/actions.ts` check the viewer may edit,
parse the input with that schema, call the function and revalidate the screens
that show the data. `org_id` never comes from the browser.

A screen file under `src/screens/finance/` is an async server component: it
loads the rows, builds the figures with a pure `…View` function, and passes the
client view its actions only when the viewer can edit. The header "Add" button
is shown only to people who can add. With no Supabase environment it shows
sample data and no actions.

The rules of a screen or a form that need no browser are pure functions beside
the data layer, with unit tests; the client components only draw them.

| File | Holds |
|---|---|
| `purchase-views.ts` | KPI figures, chart data, table filters and CSV rows for Supplier Bills and Payments Out |
| `sales-views.ts` | KPI figures, chart data, table filters, status words and CSV rows for Invoices and Payments In; what each row's menu offers (`invoiceActions`, `paymentInActions`); which customer the filter is on after a refresh (`customerChoice`) |
| `view-helpers.ts` | What those two share: dates, sums to the sen, the eight-month window of a trend chart, how payment methods are grouped and coloured, and the "This payment also covers …" sentence of a split payment |
| `document-lines.ts` | What a bill and an invoice share: the line schema, the real-date and SST-rate rules (`isIsoDate`, `roundRate`), and reading a saved line |
| `bill-math.ts` | Line amounts and bill totals, rounded exactly as the generated columns `amount` and `sst_amount` round them; the SST rate keeps two decimals, as its column does (`roundRate` in `document-lines.ts`) |
| `document-form.ts` | What the bill form and the invoice form share: a line as it was typed, the due date following the other party's payment terms, the sentence for a document that was saved as a draft but not posted, and `DocumentFormKind`, the description of one form that the shared card draws |
| `bill-form.ts` | The bill form: defaults, the due date following the supplier's terms, validation, what is sent. A product fills a line at its cost. `savedNotPosted` words a bill that was saved as a draft but not posted |
| `invoice-form.ts` | The invoice form: the same rules with a customer and no supplier's reference. A product fills a line at its price. Also the small e-Invois form (status and UUID) |
| `allocation-form.ts` | What the two payment forms share: ticking documents, amounts added in whole sen, what payments not yet posted hold of a document, and `AllocationFormKind`, the description of one form that the shared card draws |
| `payment-form.ts` | The payment-out form: which bills can take a payment and how much, defaults, validation, what is sent. `heldByBill` adds up what unpaid payments already hold of each bill; `keepPayable` drops a ticked bill that was paid off while the form was open |
| `receipt-form.ts` | The payment-in form: which invoices can take a payment and how much (`receivableInvoices`), defaults, validation, what is sent. It has no scheduling |
| `csv.ts` | CSV text for Export: RFC 4180, a UTF-8 byte-order mark, and a guard against spreadsheet formulas |

The forms validate by running the write's own Zod schema on what they are about
to send, so the browser and the server say the same sentences.

One card draws both document forms (`document-form-card.tsx`) and one draws
both payment forms (`allocation-form-card.tsx`). `BillFormCard`,
`InvoiceFormCard`, `PaymentFormCard` and `ReceiptFormCard` are thin wrappers
that hand the card their kind (`BILL_FORM_KIND`, `INVOICE_FORM_KIND`,
`PAYMENT_OUT_KIND`, `PAYMENT_IN_KIND`). A rule that differs between a bill and
an invoice, or between money out and money in, belongs in the kind, not in the
card.

A server action refreshes the screens after every attempt that reached the
database, refused or not, so a record someone else changed or removed shows as
it now is. `saveAndPostBillAction` saves a draft and posts it; when only the
post is refused it answers with the draft's id (`draftId`) and the form goes on
editing that draft. `getBillAction` reads one draft with its lines for the Edit
form. `saveAndPostInvoiceAction` and `getInvoiceAction` do the same for an
invoice, through the same two helpers. `src/app/(app)/finance/error.tsx` is
shown when a finance screen's data cannot be read.

Every action refuses a viewer and the demo workspace before the data layer is
reached. Without that, a viewer's void or delete would come back from the
database as "no row", which reads as "That invoice no longer exists.".

## Tables

Every finance table carries `org_id`. A table that other tables point at
exposes a unique `(org_id, id)` and is referenced by that pair. All finance
tables have member-read, writer-write RLS with the restrictive `mfa_required`
policy.

| Table | Holds |
|---|---|
| `finance_contacts` | Customers and suppliers. `is_customer` and `is_supplier` can both be true. |
| `finance_products` | Products and services for document lines. `cost` keeps four decimals, `price` two. |
| `finance_accounts` | Bank and cash accounts. Every workspace starts with "Main Bank" and "Cash in hand". No screen yet. |
| `finance_categories` | Expense and income categories. Every workspace starts with nine. No screen yet. |
| `finance_sequences` | The next document number per type. |
| `supplier_bills`, `supplier_bill_lines` | Supplier bills and their lines. A draft has no `bill_no`. |
| `finance_invoices`, `finance_invoice_lines` | Sales invoices and their lines. A draft has no `invoice_no`. Lines keep the order they were entered in (`position`). |
| `finance_transactions` | One row per movement of money: direction, account, date, amount, method, status. |
| `finance_allocations` | How a movement is split across the documents it pays. Each row names exactly one document: a bill (`bill_id`) or an invoice (`invoice_id`). |

## Document numbers

`select public.finance_next_number(target_org, doc)` with `doc` set to
`'invoice'` returns the next number (`INV-0001`) and moves the counter on. It locks the workspace's row for that
type, so simultaneous callers never get the same number. Types: `invoice`,
`quotation`, `credit_note`, `bill`, `receipt`, `voucher`. Call it from inside
the database function that posts a document, so a failed post does not use up a
number.

## Money

Money is entered once. A payment out is one `finance_transactions` row with
direction `out`, split across one supplier's bills by `finance_allocations`.
The view `finance_payments_out` has one row per bill a payment pays;
`supplier_bill_totals` counts only posted money out as paid.

A payment in is the mirror: one row with direction `in`, split across one
customer's posted invoices. It is posted the moment it is recorded, with an
`RC-` number: money received is never scheduled and needs no approval. The
view `finance_payments_in` has one row per invoice a payment pays, with the
same columns as `finance_payments_out` (`invoice_id`, `invoice_no` and
`customer_name` where that view has the bill and the supplier);
`finance_invoice_totals` counts only posted money in as paid. In both views
`allocation_id` is the row's key: a payment split across documents is several
rows with one `transaction_id`, whose `amount`s add up to
`transaction_amount`.

A bill takes only money out and an invoice only money in. Money out against an
invoice (a refund) arrives with the sales follow-ons.

The payment-in form is opened from Payments In, or from "Record payment" on a
posted invoice's row with that customer chosen and that invoice ticked. It
offers a customer's invoices that are Sent or Overdue, each for its balance
less anything a payment not yet posted holds (`receivableInvoices`); through
the app nothing is ever held, as money in is posted at once.

A bill's `balance` is its total less paid money. What a new payment may take is
less than that when payments are waiting: the allocation guard counts
scheduled, draft and pending-approval payments too, as they hold a bill's
balance. The payment form works this out (`payableBills`) and does not offer a
bill that such payments already cover; Supplier Bills shows what is held under
the bill's balance (`heldByBill`), for viewers too.

Statuses of a transaction: `draft` (being written by a database function),
`scheduled` (not yet money out), `posted` (paid or received; numbered
`PV-0001` for money out and `RC-0001` for money in), `void`.
`pending_approval` and `rejected` exist for the approval rule that arrives
with Payment Vouchers and Expenses; nothing sets them yet.

## Invoices

A sales invoice is a `finance_invoices` row with its lines in
`finance_invoice_lines`, which has the columns of `supplier_bill_lines` plus
`position`, the order the lines were entered in. `status` is what a person
sets: `draft`, `posted` or `void`. A draft has no `invoice_no`; posting gives
it the next `INV-` number. The database checks this: a draft has no number,
any other status has one, and a posted invoice has `posted_at`. A write that
breaks it is refused with a plain check-constraint error (23514).

The view `finance_invoice_totals` adds the customer's name, `subtotal`, `sst`,
`total`, `paid` (posted money in allocated to the invoice), `balance` and
`display_status`: `draft`, `void`, `paid` (the total is above zero and nothing
is left to pay), `overdue` (posted and past `due_date` by the database's UTC
date), otherwise `sent`. "Sent" means posted; no email goes out. A part-paid
invoice stays `sent` or `overdue` with a lower balance. Credit notes and
refunds will change the balance when they exist.

`einvoice_status` (`none`, `pending`, `validated`, `rejected`) and
`einvoice_uuid` hold what a person has noted about the invoice's e-Invois at
LHDN. Nothing is submitted from here. A draft has neither; they can be changed
only while the invoice is posted. `setEInvoice` (`setEInvoiceAction`) writes
them, from "Set e-Invois" on a posted invoice's row. The UUID is free text of
up to 100 characters; with no status there is no UUID.

What a row's menu offers follows its status (`invoiceActions`): a draft is
edited, posted or deleted; a posted invoice takes a payment while something is
still owed, has its e-Invois set, and can be voided; a void invoice offers
nothing. Voiding an invoice that has payments is offered and refused with the
reason, as on a paid bill.

## Posted is locked

Triggers enforce it, so no caller can get round it:

- A draft bill can be edited and deleted. A posted bill can only be voided,
  and not while it has payments. Its lines are locked with it.
- A bill is always created as a draft. It can only be posted once its lines
  add up to more than zero, whichever way the status is changed.
- A scheduled payment can be deleted or marked paid; the data layer has no
  function to edit one yet. It cannot be voided: only a paid payment is voided.
  A paid one can only be
  voided, which frees the bills it paid. Its split is locked with it.
- A payment cannot exceed what is still owed on a bill, counting scheduled,
  draft and pending-approval payments. The bill row is locked while this is
  checked, so two payments at
  the same moment are checked one after the other.
- Clearing a deleted user from a payment's `created_by` or `approved_by` is
  allowed on a posted payment.
- An invoice follows the same rules as a bill: created as a draft, edited
  and deleted only as a draft, posted only once its lines add up to more than
  zero, voided only when posted and only while no payment that is posted,
  scheduled or in progress is allocated to it. Its lines are locked with it.
- On a posted invoice two columns may still change, `einvoice_status` and
  `einvoice_uuid` (with `updated_at`), and nothing else in the same update.
- A payment in cannot exceed what is still owed on an invoice. The invoice row
  is locked while this is checked, so two payments at the same moment are
  checked one after the other. A payment in is posted at once, so it can only
  be voided, never deleted; voiding it frees the invoices it paid.
- The guard on payments is replaced by the same migration that adds invoices.
  It refuses everything it refused before, in the same order, and still does
  not look at direction for posted, void or deleted payments. It adds one rule,
  for money out as much as money in: once a payment that is not yet posted has
  been split across documents, its direction cannot change and its amount
  cannot go below the sum of its split. Otherwise a split could be left larger
  than its payment, or pointed at the wrong kind of document, and then posted.
- A contact with invoices cannot have Customer unticked, as one with bills
  cannot have Supplier unticked.
- Clearing a deleted user from an invoice's `created_by` is allowed whatever
  the invoice's status.
- Each guard steps aside when the workspace itself is being deleted.

## Database functions

All run as the caller, so RLS decides who may write.

| Function | Does |
|---|---|
| `finance_save_bill(target_org, bill, lines)` | Creates a draft bill or replaces a draft's header and lines. Returns the id. |
| `finance_post_bill(target_org, target_bill)` | Posts a draft and returns its number. |
| `finance_record_payment_out(target_org, payment, allocations)` | Records a payment; `payment.status` is `posted` (the default) or `scheduled`. Returns the id. |
| `finance_mark_payment_paid(target_org, target_txn, paid_on)` | Scheduled to paid. Returns the number. |
| `finance_save_invoice(target_org, invoice, lines)` | Creates a draft invoice or replaces a draft's header and lines, keeping the lines in the order given. `invoice` has `id` (to change a draft), `customer_id`, `invoice_date`, `due_date`, `notes`. Returns the id. |
| `finance_post_invoice(target_org, target_invoice)` | Posts a draft and returns its number. |
| `finance_record_payment_in(target_org, payment, allocations)` | Records money received from one customer, split across that customer's posted invoices, and posts it at once. `payment` has `account_id`, `txn_date`, `method`, `reference`, `notes`; `allocations` is a list of `{ invoice_id, amount }`. The payment's amount is the sum of the allocation amounts, each rounded to the sen first, as each is when stored. Returns the id. |
| `finance_next_number(target_org, doc)` | The next document number. |

Voiding a bill, an invoice or a payment, and deleting a draft bill, a draft
invoice or a scheduled payment, are plain updates and deletes; the guards
decide whether they are allowed. A payment in is voided by the same update as
a payment out, through its own function (`voidPaymentIn` in `money.ts`): it is
kept to money in, answers in the sentences of a payment in, and its action
refreshes the sales screens. A payment in has no edit and no delete.

## Error codes

The guards and functions raise these SQLSTATEs. `bills.ts`, `invoices.ts`,
`money.ts` and `contacts.ts` turn them into sentences; the same code is worded
for a bill or for an invoice by the file that made the call.

| Code | Meaning |
|---|---|
| `FIN01` | The bill or invoice is posted or void and cannot be changed or deleted. Also: a bill or an invoice must be created as a draft, a draft cannot be voided (delete it), and only a draft can be posted; the lines of a posted or void bill or invoice are locked with it. On a posted invoice only `einvoice_status` and `einvoice_uuid` may change; changing anything else, alone or with them, is this code. |
| `FIN02` | The bill or invoice has payments (posted, scheduled or in progress), so it cannot be voided |
| `FIN03` | The allocations add up to more than the payment. Also: a payment that has been split across documents cannot be changed to an amount below the sum of its split (money out or money in, while it is not yet posted) |
| `FIN04` | A payment can only go against a posted bill or a posted invoice; only money out pays a bill, and only money in pays an invoice. Also: a payment that has been split across documents cannot change direction (money out or money in, while it is not yet posted) |
| `FIN05` | The amount is more than is still owed on the bill or the invoice, counting payments that are posted, scheduled, draft or pending approval |
| `FIN06` | No bill was chosen or found, or the bills belong to different suppliers; for money in, no invoice was chosen or found, or the invoices belong to different customers |
| `FIN07` | The contact has bills, so Supplier cannot be unticked |
| `FIN08` | The contact has invoices, so Customer cannot be unticked |
| `FIN09` | The payment, money out or money in, is posted or void and cannot be changed or deleted, its split cannot be changed, or it is not scheduled and so cannot be marked paid; a payment that was never posted cannot be voided (delete it) |
| `FIN10` | The bill or invoice has no lines, or its lines total nothing; it cannot be saved without a line or posted without an amount |
| `FIN11` | The bill, invoice or payment no longer exists. `finance_post_invoice` also answers this to a viewer: it locks the invoice before posting, and a viewer may not, so to them it is not there |
| `42501` | Row-level security refused the write: "You do not have permission to make changes here." |
| `22003` | A number does not fit its column (quantity × unit price can overflow): "That amount is too large." |
| `23514` | A check constraint refused the write. The one to know: an invoice's number must match its status (a draft has none, any other status has one, a posted invoice has `posted_at`). Only a direct write can break it; the app never does. Others include the due date before the invoice date, a line's quantity, price or SST rate out of range, and an allocation naming both a bill and an invoice; `invoices.ts` has no sentence for them. One has a sentence: e-Invois set on a draft, which `setEInvoice` words as "e-Invois details can be recorded once the invoice is posted." |
| `23505` | A unique constraint refused the write. `invoices.ts` words it as "That invoice number is already used.". When a payment is recorded it can only be the same bill or invoice twice on one payment (numbers are taken under a lock), so `recordPaymentOut` and `recordPaymentIn` word it as "Each bill can appear once on a payment." and "Each invoice can appear once on a payment."; the schemas refuse it first, comparing ids without regard to capitals. |

The sentence for `FIN01` on an invoice is "This invoice has been posted or
voided, so that can no longer be done.". The row menus offer only what a
status allows, so the code reaches a person only when the invoice changed under
them, and the sentence is true of every such case, voiding an invoice that was
just voided included. `FIN09` on a payment in is "This payment has already been
voided." for the same reason. Bills and payments out still say "Void it
instead."; see Known limits.

## Known limits

- A scheduled payment cannot be edited: delete it and schedule it again.
- Supplier Bills and Payments Out load every bill and payment and filter in the
  browser. The product picker on a bill line is a plain list with no search.
- KPI figures and Overdue use the UTC date; the forms' default dates use the
  person's own calendar date.
- Month-to-date figures use the UTC month, so on the 1st before 08:00 Malaysia
  time a payment dated today does not count yet.
- A lost response cannot be told from a failed save. The screen says it could
  not confirm the change and asks the person to reload the page and check the
  list; it does not refresh by itself, which could reload the tab and lose the
  form. A retry after a save that did land can create a second bill, a second
  invoice, a second part-payment or a second receipt, until writes carry a
  client-generated id (which needs a migration).
- Payment dates are not restricted: "pay now" accepts a future date and
  "schedule for later" a past one.
- A payment's account must be active when it is chosen (only active accounts
  are offered), but the database does not refuse an archived account yet.
- Voiding a paid bill is offered and refused until its payments are voided.
  The same goes for an invoice that has payments.
- Posted and void bills, invoices and payments cannot be deleted, by design.
- A bill's `FIN01` sentence and a payment out's `FIN09` sentence end "Void it
  instead.", which is wrong when the thing just tried was a void of something
  already void. Invoices and payments in have sentences that are true in that
  case too; the purchase side was left as it shipped.
- A unique-violation (23505) while recording a payment is worded "Each
  bill/invoice can appear once on a payment." That is true while document
  numbers only ever come from the counter. Once a later stage lets a person
  change a prefix or reset a counter, a number collision would get that
  sentence wrongly and needs its own.
- Approval of money out is not enforced yet.
- Posting goes through database functions that run as the caller. An editor
  writing to the tables directly, rather than through the app, could still post
  a bill, an invoice or a payment with a number of their own choosing, or change
  the account of a scheduled payment, or raise its amount above its split, after
  it has been split across bills or invoices. (Lowering the amount below the
  split, or changing the direction, is refused.)
  Numbers stay unique per workspace either way. Closing this needs posting
  functions that run with their own rights, planned with the approval rule.
- Contacts and products load the first 1,000 by name; search is in the browser.
  Only the contact list is capped this way: a contact's Payable is read by
  paging through every open bill, and its Receivable through every open
  invoice, 1,000 at a time, so neither is cut short.
- A payment in cannot be edited or deleted, only voided, and a posted invoice
  only voided. To correct one, void it and record it again.
- Invoices and Payments In load every invoice and payment and filter in the
  browser, as the purchase screens do.
- "Largest open balances" on Customers & Suppliers charts what is owed to
  suppliers only; Receivable is in the card, the donut and the table.
- An invoice's e-Invois status and UUID are what a person typed. Nothing checks
  them against LHDN, and the UUID's format is not checked. "Validated" does not
  require a UUID.
- Saving an invoice does not check that its customer is ticked as a customer,
  as saving a bill does not check its supplier; the forms offer only the right
  contacts.
- A bill's lines are read back by `created_at` then `id`, which for lines
  saved together is no particular order. Invoice lines store their `position`.
- Money in is never scheduled, but `finance_mark_payment_paid` does not check
  the direction: a scheduled movement of money in could only come from writing
  to the table directly, and marking it paid would give it a `PV-` number.
- The demo workspace's invoices were dated from the day they were seeded, so
  its Sent examples turn Overdue as time passes, as its bills do.
- The checks between a payment and its split read each other without a lock.
  When a payment is lowered, the guard reads its split; when an allocation is
  added, the guard reads the payment row. Two direct writes to the tables made
  at the same moment (not possible through the app), one lowering the payment
  and one adding to its split, can both pass and leave a payment smaller than
  its split.
- Paying the same invoice twice in one payment is refused by the payment
  form's schema, whatever the capitals of the two ids. A direct call to
  `finance_record_payment_in` gets a unique violation (23505), which the data
  layer words the same way, unless the two amounts together exceed what is
  owed, in which case it is FIN05.
- Stock and revenue per item are not tracked.
- A contact's Payable counts bills that are pending or overdue, and the
  Payable card is totalled from every open bill, not only the contacts loaded.
  Receivable is the same for invoices that are sent or overdue.
