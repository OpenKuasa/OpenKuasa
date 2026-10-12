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
| `sales-views.ts` | KPI figures, chart data, table filters, status words and CSV rows for Invoices and Payments In; what each row's menu offers (`invoiceActions`, `paymentInActions`); which customer the filter is on after a refresh (`customerChoice`); how an invoice's balance is worded, a customer in credit included (`owed`, `inCredit`, `balanceText`) |
| `sales-followon-views.ts` | KPI figures, chart data, table filters, status words and CSV rows for Quotations, Credit Notes and Refunds; what a row's menu offers on each (`quotationActions`, `creditNoteActions`, `refundActions`) |
| `view-helpers.ts` | What those two share: dates, sums to the sen, the eight-month window of a trend chart, how payment methods are grouped and coloured, and the "This payment also covers …" sentence of a split payment |
| `document-lines.ts` | What a bill and an invoice share: the line schema, the real-date and SST-rate rules (`isIsoDate`, `roundRate`), and reading a saved line |
| `bill-math.ts` | Line amounts and bill totals, rounded exactly as the generated columns `amount` and `sst_amount` round them; the SST rate keeps two decimals, as its column does (`roundRate` in `document-lines.ts`) |
| `document-form.ts` | What the bill, invoice and quotation forms share: a line as it was typed and `DocumentFormKind`; and what only the bill and invoice forms use: the due date following the other party's payment terms and the sentence for a document that was saved as a draft but not posted. `DocumentFormKind` is the description of one form that the shared card draws: its nouns, its rules, its second date (`secondDate`: "Due date" or "Valid until") and, for a document that is marked as sent rather than posted, its own words (`words`; otherwise `POSTING_WORDS`) |
| `quotation-form.ts` | The quotation form: defaults, the valid-until date following the quotation date (thirty days, `QUOTATION_VALID_DAYS`, whatever the customer's payment terms), validation, what is sent. A product fills a line at its price. `quotationSavedNotSent` words a quotation that was saved as a draft but not marked as sent |
| `bill-form.ts` | The bill form: defaults, the due date following the supplier's terms, validation, what is sent. A product fills a line at its cost. `savedNotPosted` words a bill that was saved as a draft but not posted |
| `invoice-form.ts` | The invoice form: the same rules with a customer and no supplier's reference. A product fills a line at its price. Also the small e-Invois form (status and UUID) |
| `allocation-form.ts` | What the two payment forms share: ticking documents, amounts added in whole sen, what payments not yet posted hold of a document, and `AllocationFormKind`, the description of one form that the shared card draws |
| `payment-form.ts` | The payment-out form: which bills can take a payment and how much, defaults, validation, what is sent. `heldByBill` adds up what unpaid payments already hold of each bill; `keepPayable` drops a ticked bill that was paid off while the form was open |
| `receipt-form.ts` | The payment-in form: which invoices can take a payment and how much (`receivableInvoices`), defaults, validation, what is sent. It has no scheduling |
| `credit-note-form.ts` | The credit note form: which invoices can take a credit note and how much (`creditableInvoices`: posted, for the total less what is already credited), defaults, validation, what is sent. `creditNoteSavedNotIssued` words a credit note that was saved as a draft but not issued |
| `refund-form.ts` | The refund form: what can be refunded and how much (`refundTargets`: an invoice whose customer is in credit, or one of its issued credit notes, less refunds still to be paid), defaults, validation, what is sent |
| `cash-book.ts` | Reading the cash book: one row per movement of money in (`listCashReceipts`, from the view `finance_cash_receipts`) and out (`listPaymentVouchers`, from `finance_payment_vouchers`), a page at a time, with the row types and the kinds a receipt and a voucher can be. It only reads |
| `expenses.ts` | Reading expenses (`listExpenses`, from the view `finance_expense_totals`), a page at a time, with the row type, the three statuses a person sets and `paid`, which is only how an expense reads. It only reads |
| `cash-book-views.ts` | KPI figures, chart data, table filters, status words and CSV rows for Cash Receipts, Payment Vouchers and Expenses; the period selector of the first two (`inPeriod`), which sets the cards, the donut and the table rows alike (`cashReceiptsInPeriod`, `paymentVouchersInPeriod`: a draft receipt, and a voucher waiting for approval or still to be paid, stay in every period because their cards count them whatever their date; search, filters, "View all" and Export work on top of it); which category a voucher counts under (`voucherCategory`) and which screen changes it (`voucherHome`) |
| `csv.ts` | CSV text for Export: RFC 4180, a UTF-8 byte-order mark, and a guard against spreadsheet formulas |

The forms validate by running the write's own Zod schema on what they are about
to send, so the browser and the server say the same sentences.

One card draws the three document forms (`document-form-card.tsx`) and one
draws both payment forms (`allocation-form-card.tsx`). `BillFormCard`,
`InvoiceFormCard`, `QuotationFormCard`, `PaymentFormCard` and
`ReceiptFormCard` are thin wrappers that hand the card their kind
(`BILL_FORM_KIND`, `INVOICE_FORM_KIND`, `QUOTATION_FORM_KIND`,
`PAYMENT_OUT_KIND`, `PAYMENT_IN_KIND`). A rule or a word that differs between
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
The card hands back what it saved, and the note is worded from that
(`refundSavedNote`, `creditNoteSavedNote`): the amount as the schema rounds
and stores it, the invoice or credit note it went against, the customer, and
whether a refund was paid out or saved to pay later and a credit note issued or kept
as a draft. A card opened from a row has that row chosen but its picker is not
locked, so the note names what was saved, whichever row the card was opened
from.

A server action refreshes the screens after every attempt that reached the
database, refused or not, so a record someone else changed or removed shows as
it now is. `saveAndPostBillAction` saves a draft and posts it; when only the
post is refused it answers with the draft's id (`draftId`) and the form goes on
editing that draft. `getBillAction` reads one draft with its lines for the Edit
form. `saveAndPostInvoiceAction` and `getInvoiceAction` do the same for an
invoice, and `saveAndSendQuotationAction` and `getQuotationAction` for a
quotation, through the same two helpers. `src/app/(app)/finance/error.tsx` is
shown when a finance screen's data cannot be read.

Which screens an action refreshes is every screen whose figures it can move;
some refresh more than they need to. A bill or a payment out: Supplier Bills, Payments Out, Customers
& Suppliers. An invoice or a payment in: Invoices, Payments In, Customers &
Suppliers, Quotations, Credit Notes, Refunds. A contact: the eight
screens that show a contact's name. A
quotation saved, sent, answered or deleted: Quotations only, as nothing else
counts or names a quotation. A quotation made into an invoice: Quotations and
Invoices, as a draft invoice is not yet owed. A draft credit note saved or
deleted: Credit Notes only, as a draft takes nothing off its invoice. A credit
note issued or voided, and a refund recorded, marked paid, voided or deleted:
Invoices, Payments In, Customers & Suppliers, Credit Notes and Refunds, as
each can move what an invoice owes; never Payments Out, which shows no refund,
and not Quotations.

The cash book lists every movement of money, so the actions that record one
refresh it as well: an invoice or a payment in also refreshes Cash Receipts; a
bill or a payment out, and a credit note issued or voided or a refund at any
step, also refresh Payment Vouchers; a contact also refreshes Cash Receipts,
Payment Vouchers and Expenses, where it can be the payer, the payee or the
vendor. Cash Receipts, Payment Vouchers and Expenses have no action of their
own yet: they are read-only for everyone.

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
| `finance_invoices`, `finance_invoice_lines` | Sales invoices and their lines. A draft has no `invoice_no`. Lines keep the order they were entered in (`position`). `quotation_id` is the quotation an invoice was made from, if any. |
| `finance_quotations`, `finance_quotation_lines` | Quotations and their lines, shaped like invoices. A draft has no `quotation_no`. |
| `finance_credit_notes` | A credit against one posted invoice: one amount and a reason, no lines. A draft has no `credit_note_no`. |
| `finance_transactions` | One row per movement of money: direction, account, date, amount, method, status. |
| `finance_allocations` | How a movement is split across the documents it pays. Each row names exactly one document: a bill (`bill_id`), an invoice (`invoice_id`), a credit note (`credit_note_id`) or an expense (`expense_id`). `reason` is what a refund is for. One payment pays one kind of document: bills, or invoices and credit notes, or expenses. |
| `finance_expenses` | An expense: a date, a category, a vendor who is a contact (`vendor_id`) or a typed name (`vendor_name`), never both, and `amount`, which has its SST inside it (`sst_amount` is that part). `status` is `pending`, `approved` or `rejected`; `approved_by` and `approved_at` say who decided and when, whichever way. It has no number. |

## Document numbers

`select public.finance_next_number(target_org, doc)` with `doc` set to
`'invoice'` returns the next number (`INV-0001`) and moves the counter on. It locks the workspace's row for that
type, so simultaneous callers never get the same number. Types: `invoice`,
`quotation`, `credit_note`, `bill`, `receipt`, `voucher`. Call it from inside
the database function that posts a document, so a failed post does not use up a
number.

A quotation takes its `QT-` number when it is sent and a credit note its `CN-`
number when it is issued. A refund is money out and takes a `PV-` number when
it is paid out, from the same counter as a payment to a supplier. A payment
voucher of any other kind takes its `PV-` number from that counter too, when
it is paid, and a cash receipt its `RC-` number when it is posted, from the
counter payments in use. An expense has no number.

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

A bill takes only money out. An invoice takes money in, which pays it, and
money out, which is a refund. A credit note takes only money out.

A refund is one row with direction `out`, allocated to one invoice or to one
credit note, with a `reason` on the allocation (`order_cancelled`,
`damaged_goods`, `wrong_item`, `overpayment`, `other`). It is paid out at once
(`posted`, numbered `PV-`) or left pending (`scheduled`). A pending refund is
marked paid by `finance_mark_payment_paid` or deleted; a refund that was paid
out can only be voided. When a pending refund is paid out, the cap on the
invoice's credit and the credit note's amount are both looked at again,
counting the refund itself, and it is refused with `FIN05` if it no longer
fits, or with `FIN04` if its credit note is no longer issued. These are the function, the delete and the update a
payment to a supplier uses, but `markRefundPaid`, `voidRefund` and
`deleteRefund` in `refunds.ts` first read the view `finance_refunds` for the
workspace and the transaction, and refuse with "That refund no longer exists."
anything it does not show. A payment to a supplier can therefore not be
marked paid, voided or deleted through them. The view `finance_refunds` has one
row per allocation, which for a refund the app records is one row per refund, with `invoice_id` set whichever way it was recorded and
`credit_note_id` when it was put against a credit note.

A refund is not on Payments Out: `finance_payments_out` joins each allocation
to its bill, and a refund has none. `supplier_bill_totals` counts only money
out allocated to a bill, so a refund is never counted as paid to a supplier.
`finance_payments_in` shows only money in.

The reverse holds too. `markPaymentPaid`, `voidPayment` and
`deleteScheduledPayment` in `money.ts`, which Payments Out uses, first read
`finance_payments_out` for the workspace and the transaction and refuse with
"That payment no longer exists." anything it does not show, without writing.
A refund can therefore not be marked paid, voided or deleted through them.
`voidPaymentIn` is kept to `direction = 'in'`, so a refund and a payment to a
supplier, both money out, are out of its reach; it reads `finance_payments_in`
first as well, because money in can also be a receipt for income (see The cash
book).

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

Statuses of a transaction: `draft` (being written by a database function, or
a cash receipt not yet posted), `pending_approval` (waiting for an owner or
admin; the database functions put only money out there, though the guard
lets any draft be submitted, money in included), `scheduled` (allowed to be paid, not yet money out), `posted`
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
stands against it. A rejected expense can be deleted, or edited, and the
edit must itself set its status back to pending, as `finance_save_expense`
does: an update that leaves it rejected is refused (`FIN01`).

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
  write. Its amount, its direction, its account, its category, who is paid
  and every other column are frozen, and so is its split (`FIN09`): what is
  paid is what was approved. It can still be deleted.
- A scheduled payment out that nobody had to approve stays covered by its
  split. Raising its amount above its split where it stands, or turning
  scheduled money in into money out, needs an owner or admin exactly as
  scheduling it would have, and an owner or admin who does it is written down
  as approving it. An allocation of such a payment cannot be deleted, or
  lowered so that the payment is more than its split (`FIN14`): the payment
  is deleted and recorded again. So no signed-in person can leave a
  scheduled payment out that is neither approved by an owner or admin of its
  own workspace nor settling documents for its whole amount. Two kinds of row
  are outside that sentence: one that was already scheduled above its split
  before these rules were applied, and one whose split a session with no
  signed-in user took away. Both are still measured against their split when
  they are paid, and an editor cannot pay them (`FIN14`).
- A payment, an allocation and an expense never change workspace. An update
  that changes `org_id` is refused before anything else is looked at, with
  the code that table gives for "this cannot be changed": `FIN09` for a
  payment and for an allocation, `FIN01` for an expense. `org_id` is an
  ordinary column, and a row's own references (its account, contact and
  category) can be re-pointed in the same statement, so the foreign keys do
  not stop a move. Without the rule, someone who is an editor here and owns
  another workspace could record a payment there, move it here and pay it in
  one update, approved by the rules of the workspace it came from. As a
  second line, every place a guard asks whether the caller may approve asks
  it of the workspace the row is in before the write and of the one it is in
  after it.

**Who writes `approved_by` and `approved_at`.** The guards do, and nobody
else. On a payment they are written in four cases: when an owner or admin
approves a waiting payment, when one of them rejects a payment, when one of
them schedules or pays money out that is above its split, and when one of
them changes a scheduled payment that nobody approved so that it is then
money out above its split, which is what raising its amount or turning
scheduled money in into money out does. On an
expense they are written when an owner or admin approves or rejects it. In
each case, when the caller is a signed-in person, the guard writes the
caller's own id and the time of the update; for a session with no signed-in
user it leaves `approved_by` as it is and keeps an `approved_at` that was
given, writing the time only when none was. An
update from a signed-in person that changes either column by hand is
refused, whoever sends it and whatever else it changes. The code is `FIN14`
unless an earlier rule of the guard refuses the update first, as `FIN09`
does on a posted or void payment and `FIN01` on an approved or rejected
expense whose status is left as it was. So an editor cannot
fill them in on a draft, an owner cannot back-date an approval, and nobody
approves in another person's name. An INSERT that carries them has them
cleared, on a payment and on an expense. This matters because the rules above
ask "was this approved" by reading `approved_at`; if a caller could write it,
the payment's own maker could approve it.

The two columns are cleared in two other ways. The first is on an expense:
when a rejected expense goes back to pending, the guard clears both. The
second is a deleted user. `approved_by`, like
`created_by`, points at a user, and its foreign key sets it to null when that
user is deleted. The guards let that update through whatever the status of
the row, in three cases only. The first is an update made from inside another
trigger, which is what the guard tests (`pg_trigger_depth() > 1`): the
foreign key clears a deleted user from its own trigger, and today no other
trigger updates these tables, so in effect it is the foreign key. If a later
trigger ever updates a payment or an expense, it inherits this and nothing
more: it could blank these two columns. The second is a session with no
signed-in user. The third is an update that changes nothing at all. A
signed-in person who blanks `approved_by` or
`created_by` by hand meets the ordinary rules: `FIN09` on a posted or void
payment, `FIN14` on an approved or waiting one, `FIN01` on an approved or
rejected expense. `approved_at` is never cleared by the foreign key, so a row
keeps the fact and the time of its approval after its approver is gone. An
expense loses them in the first way, when it was rejected and goes back to
pending.

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
rows, with `approved_by` left empty and `approved_at` given a date of the
seed's choosing. Three roles can reach the database through the API with no
user: `anon`, which has no rights on any finance table; `authenticated` with
a token that names no user, which passes no row-level policy and so reaches
no row; and `service_role`, which this project gives no rights on these
tables (it has no default privileges here, and no migration grants it any).
If `service_role` were ever granted them, whoever holds the service key could
approve, as they could already read and write every table past row-level
security; nothing in the app writes finance tables with that key.

## Invoices

A sales invoice is a `finance_invoices` row with its lines in
`finance_invoice_lines`, which has the columns of `supplier_bill_lines` plus
`position`, the order the lines were entered in. `status` is what a person
sets: `draft`, `posted` or `void`. A draft has no `invoice_no`; posting gives
it the next `INV-` number. The database checks this: a draft has no number,
any other status has one, and a posted invoice has `posted_at`. A write that
breaks it is refused with a plain check-constraint error (23514).

The view `finance_invoice_totals` adds the customer's name, `subtotal`, `sst`,
`total`, `paid` (posted money in allocated to the invoice), `credited` (its
issued credit notes), `refunded` (posted refunds, put against the invoice
itself or against one of its credit notes), `balance` and `display_status`:
`draft`, `void`, `paid` (the total is above zero and nothing is left to pay),
`overdue` (posted and past `due_date` by the database's UTC date), otherwise
`sent`. "Sent" means posted; no email goes out. A part-paid invoice stays
`sent` or `overdue` with a lower balance.

`balance` is the total, less what was paid, less what was credited, plus what
was refunded. This view is the one place it is worked out: the guards read
their figures from it, and the screens read `balance` and never work it out
again. **A balance below zero means the customer is in credit:** they have
paid, or been credited, more than the invoice came to. Such an invoice reads
`paid`. It takes no more money in, and a refund can pay the credit out, which
brings the balance back to zero.

How a customer in credit shows: on Invoices the Balance cell reads
"RM 240.00 in credit" (`balanceText`), never a negative amount, and the CSV
has Credited and Refunded columns beside a Balance that is below zero. The
payment-in form does not offer the invoice. Total receivable on Invoices and
Receivable on Customers & Suppliers add up only invoices that are `sent` or
`overdue`, so a customer's credit on one invoice is not taken off what they
owe on another. Refunds has a card, "In credit", that adds up every invoice's
credit, pending refunds included.

`einvoice_status` (`none`, `pending`, `validated`, `rejected`) and
`einvoice_uuid` hold what a person has noted about the invoice's e-Invois at
LHDN. Nothing is submitted from here. A draft has neither; they can be changed
only while the invoice is posted. `setEInvoice` (`setEInvoiceAction`) writes
them, from "Set e-Invois" on a posted invoice's row. The UUID is free text of
up to 100 characters; with no status there is no UUID.

What a row's menu offers follows its status (`invoiceActions`): a draft is
edited, posted or deleted; a posted invoice takes a payment while something is
still owed, a credit note while its total is not yet credited in full, and a
refund while its customer is in credit and pending refunds do not already hold
all of that credit; it has its e-Invois set, and can be voided; a void invoice
offers nothing. Each of the three is offered exactly when the form it opens
would offer the invoice (`receivableInvoices`, `creditableInvoices`,
`refundTargets`, put together by `invoiceCan`), so a writer's Invoices page
also reads the credit notes and the refunds. If either of those two reads
fails, the failure is logged and the page still shows, with no row offering
"Refund": the lists are not taken as empty, which would offer a refund that no
pending refund had been counted against. "Credit note" is still offered, since
it is decided from the invoice rows and its card needs neither list. A refund
card that was open on Invoices when a refresh lost the two reads is closed,
not drawn with nothing to refund. Any other read that
fails is the page's failure, as before, and a viewer's page reads neither.
Voiding an invoice that has payments, credit notes or refunds is offered and
refused with the reason, as on a paid bill. "Credit note" and "Refund" open
their cards on Invoices with that invoice chosen; what is saved shows on
Credit Notes or Refunds, and a note at the top links there.

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
the same customer, notes and lines, dated with the date it is given
(`invoice_date`), due after the customer's payment terms counted from that
date, with `quotation_id` set. "Make invoice" sends the date on the person's
own calendar (`localIsoDate`, as the forms' default dates are), so the invoice
is dated today for the person who made it, at any hour. The database's own
date is UTC, which before 08:00 in Malaysia is the day before; the function
uses it only when it is given no date, which the app never does. The function
puts no limit on the date: the invoice is a draft and its date can be changed
on the invoice form before it is posted, and `finance_save_invoice` puts no
limit on a date either. The app's schema (`convertQuotationInput`) takes only
a real calendar date. A quotation has one invoice at a time
(a unique index on `finance_invoices`); a void invoice does not count, so a
quotation whose invoice was voided, or deleted as a draft, can be converted
again. The invoice is an ordinary draft afterwards, and it stays tied to the
quotation while its customer stays the same. Changing the invoice's customer
removes the tie: the database clears `quotation_id` in the same update, the
invoice carries on as a draft with no quotation behind it, the quotation shows
no invoice, and it can be converted again. A quotation therefore never shows
an invoice that belongs to another customer. The funnel on the screen
has three steps, created, sent and accepted: nothing tracks a customer opening
a quotation.

What a row's menu offers follows its status (`quotationActions`): a draft is
edited, marked as sent or deleted; a sent quotation, expired or not, is marked
accepted or declined; an accepted one is made into an invoice or marked
declined; a declined one can be marked accepted; and once an invoice stands
for the quotation the menu offers nothing. The form is the card bills and
invoices use, with "Valid until" as its second date and "Save and mark as
sent" as its second button. The question asked before "Make invoice" says the
draft will be dated today. After "Make invoice" the screen stays on
Quotations and a note at the top says a draft invoice was made and gives its
date, with a link to Invoices, where it is checked and posted; the row's
Invoice column links there too.

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
or saved to pay later.

What a row's menu offers follows its status (`refundActions`): a
refund still to be paid is marked as paid, with the date it was paid out, or deleted; one that
was paid out is voided; a void one offers nothing. A refund has no edit. A
refund still being written (`draft`) reads "To be paid" and is
counted as still to be paid; the app never leaves one in that state.

Money out that may be paid and has not been (`status = 'scheduled'`) reads
"To be paid" on every screen that shows it: the status badge, the card and the
filter on Refunds ("Pending" before) and on Payments Out ("Scheduled" before),
and the badge and filter on Payment Vouchers, with the same words in their CSV
status column and in the questions and menus. The names in code (`scheduled`,
`isPendingRefund`, the `pending` filter key) are unchanged. A supplier bill's
own "Pending" and "Pending approval" are different states and keep their words.

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
  allowed on a posted payment, when the foreign key does it. The same update
  made by hand by a signed-in person is refused as any other change to a
  posted payment is (`FIN09`); see Approval.
- An invoice follows the same rules as a bill: created as a draft, edited
  and deleted only as a draft, posted only once its lines add up to more than
  zero, voided only when posted and only while no payment or refund that is
  posted, scheduled or in progress is allocated to it. Its lines are locked
  with it. An invoice with a credit note that is a draft or issued cannot be
  voided either.
- `quotation_id` on an invoice may only name an accepted quotation of the
  same customer, checked when the tie is made; a draft invoice can be untied.
  When a draft's customer is changed and the tie is left as it was, the guard
  on invoices clears `quotation_id` itself, so the tie never outlives the
  customer it was checked for.
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
  this is checked. When a refund that was not yet paid out becomes `posted`,
  the cap and the credit note's amount are both looked at again, counting the
  refund itself: the refund, plus the refunds of other payments that are still
  waiting, must fit in what the customer is in credit on the invoice (`FIN05`);
  a refund against a credit note needs the note to be issued still (`FIN04`)
  and, with every other refund standing against that note, must not exceed
  the note's amount (`FIN05`). The refund's own amount is counted whatever
  status it comes from, so a refund that was rejected, and so held no credit
  while another refund took it, cannot be paid out on top of that one. The
  credit notes and then the invoices are locked while this is read, and what
  the refund itself amounts to on a credit note or an invoice is read after
  that row is locked, so a split added to the payment while it is being paid
  out is counted too.
- The guards on allocations, credit notes and payments read what an invoice
  owes from `finance_invoice_totals`. If the view gives them no row for the
  invoice, they refuse the write with `FIN04` instead of letting it through
  unchecked.
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
- A contact with invoices or quotations cannot have Customer unticked, as one
  with bills cannot have Supplier unticked.
- Clearing a deleted user from the `created_by` of an invoice, a quotation or
  a credit note is allowed whatever its status.
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
- Changing a payment's split locks the payment. The guard on allocations
  reads the payment's row with a share lock on insert, update and delete, and
  keeps it until the transaction ends. Only two tests come before that read:
  whether the workspace itself is being deleted, in which case the guard
  steps aside, and whether the update changes `org_id`, which is refused
  (`FIN09`). The
  guard on payments runs with the payment's row already locked by its own
  update, and reads the split. So a change to a payment (paid, scheduled,
  submitted, approved, lowered) and a change to its split cannot both go
  through at the same moment, each having seen the other as it was: one waits
  for the other and then sees what it did. Without it, a voucher could be
  paid while its split was taken away, leaving a paid payment that settles
  nothing and that nobody approved.
- Locks are always taken in the same order: the payment first, then the
  document. The guard on allocations locks the payment, then the credit note
  and the invoice, or the expense, or the bill. `finance_mark_payment_paid`
  and the guard on payments lock the payment, then for a refund its credit
  notes and its invoices. So a change to a payment and a change to its
  split, each sent as one request, queue and do not deadlock; this was run
  with two sessions for paying against deleting the split, lowering against
  adding to the split, and paying out a refund against adding to its split.
  It is not a promise about every direct write: see Known limits for two
  that can still deadlock. The functions the app records payments with insert the
  payment and its split in one transaction, so the row they lock is one no
  other session can see yet, and they wait for nothing. Deleting a payment
  deletes its split with it; the guard on allocations finds no payment row by
  then and locks nothing.
- Clearing a deleted user from the `created_by` or `approved_by` of an
  expense is allowed whatever its status, when the foreign key does it. By
  hand, on an approved or rejected expense, it is `FIN01`.
- Each guard steps aside when the workspace itself is being deleted.

## Database functions

All run as the caller, so RLS decides who may write.

| Function | Does |
|---|---|
| `finance_save_bill(target_org, bill, lines)` | Creates a draft bill or replaces a draft's header and lines. Returns the id. |
| `finance_post_bill(target_org, target_bill)` | Posts a draft and returns its number. |
| `finance_record_payment_out(target_org, payment, allocations)` | Records a payment; `payment.status` is `posted` (the default) or `scheduled`. Returns the id. |
| `finance_mark_payment_paid(target_org, target_txn, paid_on)` | Scheduled money out to paid. Returns the number. Refuses money in (`FIN09`). |
| `finance_save_invoice(target_org, invoice, lines)` | Creates a draft invoice or replaces a draft's header and lines, keeping the lines in the order given. `invoice` has `id` (to change a draft), `customer_id`, `invoice_date`, `due_date`, `notes`. Returns the id. |
| `finance_post_invoice(target_org, target_invoice)` | Posts a draft and returns its number. |
| `finance_record_payment_in(target_org, payment, allocations)` | Records money received from one customer, split across that customer's posted invoices, and posts it at once. `payment` has `account_id`, `txn_date`, `method`, `reference`, `notes`; `allocations` is a list of `{ invoice_id, amount }`. The payment's amount is the sum of the allocation amounts, each rounded to the sen first, as each is when stored. Returns the id. |
| `finance_save_quotation(target_org, quotation, lines)` | Creates a draft quotation or replaces a draft's header and lines, keeping the lines in the order given. `quotation` has `id` (to change a draft), `customer_id`, `quote_date`, `valid_until`, `notes`. Returns the id. |
| `finance_send_quotation(target_org, target_quotation)` | Marks a draft as sent and returns its number. |
| `finance_convert_quotation(target_org, target_quotation, invoice_date)` | Makes a draft invoice from an accepted quotation, dated `invoice_date` and due after the customer's payment terms counted from it. `invoice_date` may be left out or null, and the database's UTC date is then used. It is one function with a default, not two: a second function of the same name would make the two-argument call ambiguous. Returns the invoice's id. |
| `finance_save_credit_note(target_org, note)` | Creates a draft credit note or replaces a draft. `note` has `id` (to change a draft), `invoice_id`, `credit_date`, `reason`, `amount`, `notes`. Returns the id. |
| `finance_issue_credit_note(target_org, target_note)` | Issues a draft and returns its number. |
| `finance_record_refund(target_org, refund)` | Records one refund against one invoice or one credit note. `refund` has `invoice_id` or `credit_note_id`, `account_id`, `txn_date`, `method`, `reason`, `amount`, `reference`, `notes`, and `status`: `posted` (the default) or `scheduled`. Returns the id. |
| `finance_save_cash_receipt(target_org, receipt, allocations)` | Creates a draft cash receipt or replaces a draft's details and split. `receipt` has `id` (to change a draft), `account_id`, `txn_date`, `method`, `reference`, `notes`, and either nothing more, with `allocations` a list of `{ invoice_id, amount }` for one customer's posted invoices, or `category_id` (an income category), `amount`, and `contact_id` or `party_name`, with no allocations. Returns the id. |
| `finance_post_cash_receipt(target_org, target_txn)` | Posts a draft cash receipt and returns its `RC-` number. |
| `finance_record_voucher(target_org, voucher, allocations)` | Records money out for approved expenses or for an expense category. `voucher` has `account_id`, `txn_date`, `method`, `reference`, `notes`, `contact_id` or `party_name`, `status` (`posted`, the default, or `scheduled`), and either nothing more, with `allocations` a list of `{ expense_id, amount }`, or `category_id` and `amount`, with no allocations. A voucher with no allocations recorded by someone who is not an owner or admin is left `pending_approval`. Returns the id. |
| `finance_save_expense(target_org, expense)` | Creates an expense or changes one that is pending or rejected. `expense` has `id` (to change one), `expense_date`, `category_id`, `vendor_id` or `vendor_name`, `amount`, `sst_amount`, `notes`. Saved by an owner or admin it is approved in the same call. Returns the id. |
| `finance_next_number(target_org, doc)` | The next document number. |

Accepting or declining a quotation, voiding a credit note or a refund, and
deleting a draft quotation, a draft credit note or a pending refund, are plain
updates and deletes too. The data layer for all of it is in `quotations.ts`,
`credit-notes.ts` and `refunds.ts`. The quotation writes are called by
`saveQuotationAction`, `sendQuotationAction`, `saveAndSendQuotationAction`,
`acceptQuotationAction`, `declineQuotationAction`, `deleteQuotationAction` and
`convertQuotationAction`; the credit note writes by `saveCreditNoteAction`,
`issueCreditNoteAction`, `saveAndIssueCreditNoteAction`,
`voidCreditNoteAction` and `deleteCreditNoteAction`; the refund writes by
`recordRefundAction`, `markRefundPaidAction`, `voidRefundAction` and
`deleteRefundAction`.

Approving or rejecting an expense or a payment, voiding a posted receipt or
voucher, and deleting a draft receipt, a pending or rejected expense, or a
payment that was never paid, are plain updates and deletes as well. No
function of `src/lib/finance/` calls the four functions above, approves or
rejects an expense or a payment, or touches an expense or a draft receipt:
`cash-book.ts` and `expenses.ts` only read, and each write arrives with its
form. The voids and deletes that exist are those of Payments In, Payments Out
and Refunds, and reach only what those screens show.

Voiding a bill, an invoice or a payment, and deleting a draft bill, a draft
invoice or a scheduled payment, are plain updates and deletes; the guards
decide whether they are allowed. A payment in is voided by the same update as
a payment out, through its own function (`voidPaymentIn` in `money.ts`): it is
kept to money in, answers in the sentences of a payment in, and its action
refreshes the sales screens. A payment in has no edit and no delete.

## Error codes

The guards and functions raise these SQLSTATEs. `bills.ts`, `invoices.ts`,
`money.ts`, `contacts.ts`, `quotations.ts`, `credit-notes.ts` and `refunds.ts`
turn them into sentences; the same code is worded for a bill, an invoice, a
quotation, a credit note or a refund by the file that made the call.

| Code | Meaning |
|---|---|
| `FIN01` | The bill or invoice is posted or void and cannot be changed or deleted. Also: a bill or an invoice must be created as a draft, a draft cannot be voided (delete it), and only a draft can be posted; the lines of a posted or void bill or invoice are locked with it. On a posted invoice only `einvoice_status` and `einvoice_uuid` may change; changing anything else, alone or with them, is this code. |
| `FIN02` | The bill or invoice has payments (posted, scheduled or in progress), so it cannot be voided; for an invoice a refund put against it counts as one. Also: a credit note cannot be voided while a refund is allocated to it, or while the refunds on its invoice would not fit in the customer's credit without it |
| `FIN03` | The allocations add up to more than the payment. Also: a payment that has been split across documents cannot be changed to an amount below the sum of its split (money out or money in, while it is not yet posted) |
| `FIN04` | A payment can only go against a posted bill or a posted invoice; only money out pays a bill, and only money in pays an invoice. Money out against an invoice is a refund, and is this code unless the customer is in credit on that invoice; a refund against a credit note needs the note to be issued, and money in never goes against a credit note. Also: a payment that has been split across documents cannot change direction (money out or money in, while it is not yet posted); a credit note can only go against a posted invoice; only an accepted quotation becomes an invoice, and an invoice can only be tied to an accepted quotation of the same customer |
| `FIN05` | The amount is more than is still owed on the bill or the invoice, counting payments that are posted, scheduled, draft or pending approval. For a refund: more than the customer is in credit on the invoice, counting pending refunds, or more than is left of the credit note; also when a refund is paid out later and no longer fits in that credit or in its credit note, the refund itself counted. For a credit note: more than the invoice's total less what is already credited |
| `FIN06` | No bill was chosen or found, or the bills belong to different suppliers; for money in, no invoice was chosen or found, or the invoices belong to different customers; for a refund, it names no document, or an invoice and a credit note at once, or one that is not in the workspace |
| `FIN07` | The contact has bills, so Supplier cannot be unticked |
| `FIN08` | The contact has invoices or quotations, so Customer cannot be unticked |
| `FIN09` | The payment, money out or money in, is posted or void and cannot be changed or deleted, its split cannot be changed, or it is not scheduled and so cannot be marked paid; a payment that was never posted cannot be voided (delete it). Also: a payment or an allocation does not move to another workspace (an update that changes `org_id`) |
| `FIN10` | The bill, invoice or quotation has no lines, or its lines total nothing; it cannot be saved without a line, and a bill or an invoice cannot be posted, nor a quotation sent, without an amount |
| `FIN11` | The bill, invoice, quotation, credit note or payment no longer exists. `finance_post_invoice`, `finance_send_quotation`, `finance_convert_quotation` and `finance_issue_credit_note` also answer this to a viewer: each locks its row first, and a viewer may not, so to them it is not there |
| `FIN12` | The invoice has a credit note that is a draft or issued, so it cannot be voided. `invoices.ts` words it: "This invoice has credit notes. Void them on Credit Notes, or delete the drafts, before voiding it." |
| `FIN13` | The quotation already has an invoice that is not void: it cannot be converted again, and its answer can no longer change. `quotations.ts` words it |
| `FIN14` | Approval. Only an owner or admin approves or rejects an expense or a payment; a payment is submitted for approval only from a draft and rejected only before it is approved; money out that settles no document needs one of them before it is scheduled or paid; a payment waiting for approval, or rejected, cannot be changed; a rejected payment is final; an approved payment is paid as it was approved, with nothing but its status, number and date changing. Also: `approved_by` and `approved_at` on a payment or an expense are written by the database, and an update from a signed-in person that changes either by hand is this code, unless an earlier rule refuses it first (`FIN09` on a posted or void payment, `FIN01` on an approved or rejected expense whose status is left as it was); a scheduled payment out that nobody approved cannot be raised above its split, or made from scheduled money in, by someone who is not an owner or admin, and its split cannot be deleted or lowered below the payment by any signed-in person. Nothing in the app meets it yet |
| `FIN15` | A receipt, a voucher or an expense names the wrong thing: a receipt is for invoices or for an income category, a voucher for expenses or for an expense category, never both and never neither; a receipt for invoices that is being posted must be exactly its split and carry no category; an expense needs an expense category of its own workspace. Nothing in the app meets it yet |
| `42501` | Row-level security refused the write: "You do not have permission to make changes here." |
| `22003` | A number does not fit its column (quantity × unit price can overflow): "That amount is too large." |
| `22023` | `finance_record_refund` was given a status other than `posted` or `scheduled`. The app always sends one of the two, so only a direct call reaches it; `refunds.ts` has no sentence for it. |
| `23514` | A check constraint refused the write. The one to know: an invoice's number must match its status (a draft has none, any other status has one, a posted invoice has `posted_at`); a quotation's and a credit note's number follow the same rule. Only a direct write can break it; the app never does. Others include the due date before the invoice date, a quotation valid until before its date, a line's quantity, price or SST rate out of range, a credit note of nothing, a refund reason outside the five, and an allocation naming more than one document, or none; `invoices.ts` has no sentence for them. One has a sentence: e-Invois set on a draft, which `setEInvoice` words as "e-Invois details can be recorded once the invoice is posted." |
| `23505` | A unique constraint refused the write. `invoices.ts` words it as "That invoice number is already used.". When a payment is recorded it can only be the same bill or invoice twice on one payment (numbers are taken under a lock), so `recordPaymentOut` and `recordPaymentIn` word it as "Each bill can appear once on a payment." and "Each invoice can appear once on a payment."; the schemas refuse it first, comparing ids without regard to capitals. |

`FIN01` is also raised for a quotation (created as a draft; one that has been
sent is locked but for its answer, and its lines with it; a draft is not
accepted or declined) and for a credit note (created as a draft; an issued or
void one is locked; a draft is deleted, not voided). Their sentences are in
`quotations.ts` and `credit-notes.ts`.

The sentence for `FIN01` on a quotation is "That cannot be done to this
quotation as it now stands. It may have been sent, accepted or declined since
this page was loaded.". The row menu offers only what a status allows, so the
code reaches a person only when the quotation changed in another tab: a draft
that was sent meanwhile being saved, sent or deleted, or an answer being
recorded that is already the answer. The sentence says what may have happened
and not what did, so it is not false of a draft answered by a direct call
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
its credit note, so it cannot be paid out. Delete it. If the customer is still
in credit, a new refund can be recorded for no more than that.". The second
does not promise a new refund, because nothing may be left of the credit.

The sentence for `FIN01` on an invoice is "This invoice has been posted or
voided, so that can no longer be done.". The row menus offer only what a
status allows, so the code reaches a person only when the invoice changed under
them, and the sentence is true of every such case, voiding an invoice that was
just voided included. `FIN09` on a payment in is "This payment has already been
voided." for the same reason. Bills and payments out still say "Void it
instead."; see Known limits.

The cash book reuses the codes above where the meaning is the same. `FIN01`:
an expense is created pending, an approved or rejected one is locked, it is
decided as it stands, an approved one is not deleted, who approved or
entered an approved or rejected one is not blanked by hand, and an expense
does not move to another workspace. `FIN02`: an
approved expense with payments cannot be rejected. `FIN04`: a payment only
goes against an approved expense, and only money out does. `FIN05`: more than
is left of the expense, or a draft receipt for more than its invoice owes.
`FIN06`: a voucher names an expense that is not there, a receipt names no
invoice that is there or is for two customers, or one payment names two kinds
of document. `FIN09`: a payment is
created as a draft; a posted receipt cannot be saved or posted again; the
split of a payment that is waiting, rejected or approved is locked; money in
is not marked paid. `FIN11`: the receipt or the expense no longer exists, or
is not the caller's to change. `22023`: `finance_record_voucher` was given a
status other than `posted` or `scheduled`. `23514`: an expense with both a
contact and a typed vendor or neither, with more SST than its amount, or of
nothing; a payment with both a contact and a typed name. `23503`: an expense
that a voided or rejected payment still names cannot be deleted. For these cases none of
the codes has a sentence yet: the files that word them arrive with the forms.

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
  invoice, a second quotation, a second credit note, a second part-payment, a
  second receipt or a second refund,
  until writes carry a client-generated id (which needs a migration). A second
  credit note is refused when it is issued (by Save and issue, or by Issue)
  once the two together exceed the invoice's total; a second draft is not
  refused, since a draft is not counted. A second refund is refused once the
  two together exceed the customer's credit. Below those caps both go through. A second draft credit note or pending refund is
  deleted; a second issued credit note or paid refund is voided. A second
  draft quotation can be deleted; a second one that was marked as sent cannot,
  and is marked declined. Making an invoice from a quotation is not affected:
  a quotation has one invoice at a time, so a retry is refused.
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
- Approval is enforced for expenses and for money out that settles no
  document. A payment to a supplier and a refund are not held for approval;
  see Approval.
- Posting goes through database functions that run as the caller. An editor
  writing to the tables directly, rather than through the app, could still post
  a bill, an invoice, or a payment that is exactly its split, with a number of
  their own choosing, or change the account of a scheduled payment that nobody
  had to approve. (Lowering the amount below the split, or changing the
  direction of a payment that is split, is refused. Raising the amount above
  the split is allowed while the payment is a draft, but an editor cannot
  then schedule it or pay it, and cannot raise a scheduled one: the part
  above the split needs an owner or admin.) A payment can no longer be
  created already posted. Numbers stay unique per workspace
  either way. Closing the rest needs posting functions that run with their
  own rights.
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
- `finance_mark_payment_paid` refuses money in. It is used as it is for every
  kind of money out: a pending refund, a scheduled payment to a supplier and
  an approved voucher are all payment vouchers. The functions of each screen
  do not rely on that: `markRefundPaid`, `voidRefund` and `deleteRefund` read
  `finance_refunds` first and refuse anything it does not show, the Payments
  Out functions read `finance_payments_out` first in the same way, and
  `voidPaymentIn` reads `finance_payments_in`. Each is two requests, a read
  and then a write, not one statement: a transaction that stopped being what
  the view showed between the two would still be written. One payment pays
  one kind of document, and nothing in the app can make a payment stop being
  what the view showed.
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
  screen; once the card's save succeeds, Invoices says so in a note with a
  link and does not go there by itself. There is one case with no note: Save
  and issue saved the draft but could not issue it, the card stays open with
  the reason, and the person then cancels. The draft is on Credit Notes and
  nothing on Invoices says so.
- An id that is not an id sent to `markRefundPaidAction`, `voidRefundAction`
  or `deleteRefundAction` is answered "That payment no longer exists.": a refund's id is parsed by the
  schema a payment's is. Only a direct call can send one.
- A draft cash receipt against invoices is on Payments In with the status
  Draft, and holds its part of each invoice until it is posted or deleted.
  Nothing in the app makes one yet. Payments In offers nothing on such a row;
  sent to `voidPaymentIn` by a direct call it is answered "This payment has
  already been voided.", which is not true of a draft. The part that adds the
  receipt form rewords it.
- A sent quotation cannot be edited: mark it declined and write a new one.
  "Mark as sent" is offered on a draft whatever its total, and refused with
  the reason when its lines total nothing, as Post is on an invoice.
- A new quotation is valid for thirty days until the person changes the date;
  the thirty is not a setting.
- Making an invoice from a quotation does not open that invoice: the screen
  says a draft was made and links to Invoices, where the draft carries the
  person's own date of that day and so is among the newest rows. The link does
  not single the draft out.
- "Make invoice" takes the date from the browser's clock, as every form's
  default date does. A device whose clock or time zone is wrong dates the
  draft wrongly; the note says which date it was given, and the date can be
  changed on the invoice form before the invoice is posted.
- A credit note is one amount with a reason. It has no lines and does not say
  how much of it is SST.
- A quotation has no void. One that was sent by mistake is marked declined,
  and then counts as declined in the conversion figure. The question asked
  before marking one declined says that a quotation cannot be voided.
- A customer's credit on one invoice is not taken off what they owe on
  another, in any total. To use it against another invoice, refund it and
  record a payment in.
- Voiding a payment in after its invoice was credited and refunded is allowed:
  the invoice then shows the customer owing again, the refund included, which
  is what is true. A refund that was still pending at that moment can no
  longer be marked paid (`FIN05`); delete it.
- That second look at a pending refund locks the invoice, so two refunds paid
  out at the same moment are checked one after the other. Voiding a payment in
  does not take that lock, so a payment in voided at the very moment a pending
  refund on the same invoice is marked paid can slip past it; the invoice then
  shows the customer owing.
- A rejected payment is final: no update moves it to another status, so one
  that held nothing while another payment took its place cannot be brought
  back on top of that one. A rejected refund that is paid out by a direct
  update is still refused by the refund checks first (`FIN04`, `FIN05`), then
  by this rule (`FIN14`).
- `finance_mark_payment_paid` locks the payment and then, for a refund, its
  credit note and invoice. A direct insert of an allocation on that same
  payment at that moment used to lock the invoice first and then wait for the
  payment, so the two could deadlock. The guard on allocations now locks the
  payment first, so the insert waits for the payment and is then refused,
  because the payment is paid (`FIN09`). The app never adds an allocation to
  a payment that already exists.
- Two direct writes that each add an allocation to the same existing payment
  at the same moment both hold a share lock on it and do not wait for each
  other. Each is checked against its own document under that document's lock,
  but the two together can exceed the payment (the check that a split is no
  more than its payment reads the other allocations without a lock). The
  payment is then less than its split, never more, so no money leaves that
  was not approved. Not possible through the app, which splits a payment only
  in the transaction that inserts it.
- An approval is sent by id, and approves the row as it is at that moment,
  not as the approver last saw it. A pending expense can be edited in place
  by anyone who may write, up to the moment an owner or admin approves it: if
  the edit lands first, the approval is of the edited amount. A waiting
  payment cannot be edited, but someone who may write can delete it and
  record another under the same id. The parts that add the Approve buttons,
  for expenses and for vouchers, should send what the approver saw (the
  amount at least) with the update, and approve only if it still matches.
- Two direct transactions that each add an allocation to the same existing
  payment and then update that payment can deadlock, each holding a share
  lock the other's update waits for. An allocation moved from one payment to
  another locks both, the old one first, so two direct updates that swap
  allocations between the same two payments in opposite directions can
  deadlock too. Postgres ends one of the two with an error. Neither can be
  sent as one request through the API, and the app does neither.
- When a scheduled payment is paid, its amount is measured against its split
  once more. No signed-in person can now build a scheduled payment that
  fails that test, so it is a safeguard for rows that were scheduled before
  these rules and for a split changed by a session with no signed-in user;
  the check script reaches it that way.
- A session with no signed-in user (a migration, a seed) may delete or lower
  the split of a scheduled payment out, which a signed-in person may not.
  The payment it leaves is not approved, and is refused when an editor pays
  it.
- `finance_record_payment_out` adds up the amounts it is given before
  rounding, and each allocation is rounded when it is stored. A direct call
  with fractions of a sen can leave the payment a sen above its split: from
  an editor it is refused (`FIN14`), and from an owner or admin the payment
  is recorded as approved by them and then locked. The app rounds each
  amount first, so it cannot meet this.
- The rule that a row never changes workspace is on payments, allocations
  and expenses only. The older finance tables (bills, invoices, quotations,
  credit notes, their lines, contacts, accounts, categories, products) have
  no such rule; none of them carries an approval.
- A split can no longer be added by a direct write to a refund at the very
  moment it is paid out: the insert waits for the payment's row and is then
  refused, because the refund is paid (`FIN09`). Added just before, it is
  committed by the time the refund is paid out and is counted, whichever
  invoice or credit note it names.
- A refund is to one customer against one invoice or one credit note. One
  payment out that refunds several invoices is not recorded as one refund.
- The reason of a refund is one of five words; anything more is in the
  payment's notes. The Refunds table shows neither the notes nor the account;
  the CSV has the account.
- A void invoice does not hold its quotation: the quotation can be converted
  again, and the void invoice keeps `quotation_id` as a record of where it
  came from.
- Editing the draft invoice made from a quotation can change its customer.
  The invoice is then untied from the quotation without a word to the person
  editing it; the quotation shows no invoice and can be converted again.
- The demo workspace's quotations, credit notes and refunds were dated from
  the day they were seeded, so its Sent quotations turn Expired as time passes
  and its month-to-date figures empty out.
- The database tests for this stage, `tests/bendahara-followons.test.ts`, run
  against the hosted database. The one that converts a quotation passes a date,
  so it needs `20261027100000_bendahara_convert_quotation_date.sql` applied
  there first. They create their users and workspaces through
  `tests/helpers/live-workspaces.ts` and delete them when the file finishes.
- The demo workspace's invoices were dated from the day they were seeded, so
  its Sent examples turn Overdue as time passes, as its bills do.
- The checks between a payment and its split used to read each other without
  a lock, so two direct writes at the same moment, one lowering the payment
  and one adding to its split, could both pass and leave a payment smaller
  than its split. The guard on allocations now locks the payment's row (see
  Posted is locked), so one of the two waits and is refused with `FIN03`.
- Paying the same invoice twice in one payment is refused by the payment
  form's schema, whatever the capitals of the two ids. A direct call to
  `finance_record_payment_in` gets a unique violation (23505), which the data
  layer words the same way, unless the two amounts together exceed what is
  owed, in which case it is FIN05.
- Stock and revenue per item are not tracked.
- A contact's Payable counts bills that are pending or overdue, and the
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
- A payment waiting for approval cannot be edited: it is approved, rejected
  or deleted, and a deleted one is recorded again. A rejected one cannot be
  reopened: delete it.
- An expense's amount has its SST inside it, where a bill line has its SST on
  top. An expense has one category and no lines.
- An approved expense cannot be edited. An owner or admin rejects it, while
  nothing has been paid against it, and it is then edited back to pending.
- An expense that a voided or rejected payment still names cannot be deleted:
  the voided payment keeps its split as a record, and a rejected one keeps
  its split until it is deleted.
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
