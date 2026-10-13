# Bendahara backend

How the finance screens read and write.

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
| `cash-receipts.ts` | A receipt's writes, and the one read its form needs: the Zod schema of a draft receipt (`saveCashReceiptInput`, for invoices or for income, told apart by `kind`), saving a draft (`saveCashReceipt`), posting it (`postCashReceipt`), voiding a posted one (`voidCashReceipt`), deleting a draft (`deleteCashReceipt`), the sentence for each database code (`CASH_RECEIPT_MESSAGES`), and the active income categories (`listIncomeCategories`). Every write given an id asks `finance_cash_receipts` first, so one side of a transfer is never reached |
| `cash-receipt-form.ts` | The receipt form: defaults, the form for a draft being changed (`editCashReceiptForm`, from its row and its Payments In rows), which invoices it can go against (`receivableFor`: the payment-in rule, without counting what the draft being changed holds itself), validation, what is sent (the chosen side only), a picker's list with a draft's archived choice in it (`withCurrent`). `receiptSavedNotPosted` words a receipt that was saved as a draft but not posted. `receiptInvoicesForForm` and `receiptPaymentsForForm` trim what the loader sends the form to the invoices that can still take money and the payments that hold part of one. `leftOutInvoicesNote` says when ticked invoices were left out. `afterRefusedReceiptSave` makes the form forget the id of a draft that was deleted meanwhile |
| `expenses.ts` | Expenses: reading them (`listExpenses`, from the view `finance_expense_totals`, a page at a time; `listExpenseCategories`), the row type, the three statuses a person sets and `paid`, which is only how an expense reads; and the writes of the Expenses screen: `saveExpenseInput`, `saveExpense` (`finance_save_expense`, then a read of the status the database left), `approveExpense` and `rejectExpense` (one update of `status`), `deleteExpense`, and `EXPENSE_MESSAGES` |
| `expense-form.ts` | The Expenses screen's rules, pure: the form (`newExpenseForm`, `editExpenseForm`, `expensePayload`, `expenseFormError`, `expenseSaveHint`), what a row's menu offers each person (`expenseActions`), what is left of an expense (`expenseLeft`), how a part-paid expense reads (`isPartPaid`, `expensePaymentNote`), and the note for an expense just written that is not in the list |
| `expense-payment.ts` | Marking an approved expense paid: `markExpensePaidInput`, `markExpensePaid` (a read of the expense as it was shown, then `finance_record_voucher` with status `posted` and one allocation, then a read of the voucher's number), `EXPENSE_PAYMENT_MESSAGES`, and the Mark paid card's rules, pure (`newExpensePayForm`, `expensePayPayload`, `expensePayError`, `expensePayHint`, the words of the note afterwards) |
| `cash-book-views.ts` | KPI figures, chart data, table filters, status words and CSV rows for Cash Receipts, Payment Vouchers and Expenses; the period selector of the first two (`inPeriod`), which sets the cards, the donut and the table rows alike (`cashReceiptsInPeriod`, `paymentVouchersInPeriod`: a draft receipt, a draft voucher, and a voucher waiting for approval or still to be paid, stay in every period (their cards count a draft receipt and what is waiting whatever the date; no card counts a draft voucher, which is kept so that what it holds of a bill can be found); search, filters, "View all" and Export work on top of it); which category a voucher counts under (`voucherCategory`) and which screen changes it (`voucherHome`); what a receipt's row menu offers, by its status and by whether the person may sign off (`cashReceiptActions`), and the words of its questions (`receiptName`, `receiptVoidEffect`, `receiptDeleteEffect`) |
| `receipts.ts` | Reading the Receipts Inbox (`listInboxReceipts`, from the view `finance_receipt_inbox`), a page at a time, with the row type and the bucket's name, size limit and five file types. An inbox receipt is an uploaded photo or PDF, not a cash receipt: everything exported says `Inbox`. It never reads `file_path`: only `getReceiptFile` in `receipt-inbox.ts` does, on the server |
| `receipt-views.ts` | The three counts, the donut, the status and type words, the "Matched to" words (`inboxDocument`), whether a row says anything about AI reading and what (`inboxReadingNote`, `INBOX_READING_NOTES`), the filter and the CSV rows of the Receipts Inbox |
| `receipt-files.ts` | What is decided about a file before it is uploaded: its type from its first bytes (`sniffReceiptType`), the path it is stored at, the name kept to show (`cleanFileName`), what a refused upload means, and the upload queue's states |
| `receipt-inbox.ts` | The inbox's writes and its review form: record an upload (`registerReceipt`), review (`reviewReceipt`), delete (`deleteInboxReceipt`), read a receipt's path and sign a download link, and the sentences for `FIN11`, `FIN23`, `FIN24` |
| `receipt-files-server.ts` | Server only: reads a stored file's first bytes before it is opened (`storedFileCheck`), removes a deleted receipt's file (`removeReleasedReceiptFile`) and runs the clean-up (`cleanReceiptFiles`) |
| `receipt-match.ts` | Matching a receipt: the schemas and writes that make an expense or a draft bill from one (`receiptToExpense`, `receiptToBill`), tie it to a document that exists (`attachReceipt`) and untie it (`detachReceipt`); the read behind the paperclip on Expenses and Supplier Bills (`listAttachedReceipts`, `receiptsByDocument`); how a matched receipt's document stands (`matchedDocuments`), what a row offers (`receiptMatchActions`), the two forms pre-filled from a receipt, the attach picker's list, and the three lists of screens its actions refresh |
| `rfqs.ts` | RFQs (requests for quotation). Described here only for the link a copied RFQ keeps: `saveRfqInput` takes `source_rfq_id`, the RFQ a new draft was copied from, which must be an id, and `saveRfq` sends it to `finance_save_rfq`; a list row carries `source_rfq_id` (the first RFQ of its group, or null) and `quoted_at` (when the supplier's answer was recorded; until then the list and its export show no total, as prices the buyer typed are not a quote); `getRfqGroup` reads the RFQs of one RFQ's group that have gone to their supplier, with their lines, in the order they were made. `saveRfq` words `FIN11` on a new copy with a sentence of its own (`RFQ_MESSAGES.copiedFromGone`) |
| `rfq-form.ts` | The RFQ form. A form opened by Copy to another supplier (`rfqFormCopiedFrom`) remembers the RFQ it was copied from, and `rfqPayload` sends it with the new draft. When that save is refused because the RFQ it was copied from is gone, `rfqFormAfterRefusal` drops the link, so saving again saves the RFQ on its own; the shared card applies it through `DocumentFormKind.afterRefusal`, which no other form has |
| `rfq-compare.ts` | Compare quotes, pure. A group is the first RFQ and every RFQ that names it (`rfqGroupId`); an RFQ can be compared once it and at least one other of its group have gone to their supplier (`comparableRfqIds`), and `rfqActions(row, comparable)` in `purchase-views.ts` then offers Compare quotes in every status but draft. `compareQuotes` lays the group out as a row for each item and a cell for each RFQ: lines are matched by product, or else by description, in the same unit and pack size; only an RFQ whose answer was recorded (`quoted_at`) has prices; the lowest price is for one unit with SST added, compared to four decimals, marked on every supplier tied at it and only when at least two priced the line; a cell worded differently from its row keeps its own description. Also the question the card asks before making an order (`orderableRfq`) and what deleting a draft costs the RFQs copied from it (`rfqCopyCount`, `rfqDeleteWarning`) |
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
vendor. Every cash receipt action (save, save and post, post, void, delete)
refreshes what an invoice or a payment in refreshes, whatever the receipt is
for: one against invoices moves what they owe, or holds part of them while it
is a draft, and one save can turn a draft of one kind into the other. The
five expense actions (`saveExpenseAction`, `approveExpenseAction`,
`rejectExpenseAction`, `deleteExpenseAction`, `markExpensePaidAction`) refresh `EXPENSE_PATHS`:
Expenses, Receipts Inbox (which names the expense a receipt is tied to),
Payment Vouchers and Banking (which name the category of the expenses a
voucher pays), then Chart of Accounts, Journals and Reports (`LEDGER_PATHS`): an
approved expense is two lines of the books, so approving or rejecting one
moves them. Approve and reject are refused to anyone who may not sign off,
before anything is read, in the expense's own sentence. Payment Vouchers has
no action of its own yet: it is read-only for everyone.

The Receipts Inbox has its own actions file,
`src/app/(app)/finance/receipt-inbox-actions.ts`: `registerReceiptAction`,
`reviewReceiptAction`, `deleteReceiptAction` and `receiptLinkAction`. The
first three use the same guard as every finance action and refresh
`/finance/receipts-inbox` only; the last is a read, open to anyone who can see
the receipt. Four more match a receipt, behind the same guard:
`receiptToExpenseAction` refreshes what saving an expense refreshes
(`RECEIPT_EXPENSE_PATHS`), `receiptToBillAction` what saving a bill refreshes
(`RECEIPT_BILL_PATHS`), and `attachReceiptAction` and `detachReceiptAction`
the inbox, Expenses and Supplier Bills (`RECEIPT_TIE_PATHS`). A `'use server'`
file may export only async functions, so the first two lists are written a
second time in `receipt-match.ts`; `tests/finance-receipt-match.test.ts` fails
if either differs from `EXPENSE_PATHS` or `BILL_PATHS` in `actions.ts`.
`BILL_PATHS` includes `/finance/receipts-inbox`: posting a bill gives it the
number the inbox shows, and deleting a draft sends its receipt back to
Unmatched (`EXPENSE_PATHS` has had the inbox since the expense forms).

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
| `finance_accounts` | Bank and cash accounts. Every workspace starts with "Main Bank" and "Cash in hand". Banking lists them with their balances; they have no form yet. |
| `finance_categories` | Expense and income categories, each with a ledger account of its own. Every workspace starts with ten. Every member reads them; only an owner or admin adds, changes or deletes one (three restrictive policies beside the writer ones: `finance_categories_sign_off_insert`, `_update`, `_delete`). A name is 1 to 80 characters with no space at either end (`finance_categories_name_check`). No screen yet. |
| `finance_sequences` | The next document number per type. |
| `supplier_bills`, `supplier_bill_lines` | Supplier bills and their lines. A draft has no `bill_no`. |
| `finance_invoices`, `finance_invoice_lines` | Sales invoices and their lines. A draft has no `invoice_no`. Lines keep the order they were entered in (`position`). `quotation_id` is the quotation an invoice was made from, if any. |
| `finance_quotations`, `finance_quotation_lines` | Quotations and their lines, shaped like invoices. A draft has no `quotation_no`. |
| `finance_credit_notes` | A credit against one posted invoice: one amount and a reason, no lines. A draft has no `credit_note_no`. |
| `finance_transactions` | One row per movement of money: direction, account, date, amount, method, status. |
| `finance_allocations` | How a movement is split across the documents it pays. Each row names exactly one document: a bill (`bill_id`), an invoice (`invoice_id`), a credit note (`credit_note_id`) or an expense (`expense_id`). `reason` is what a refund is for. One payment pays one kind of document: bills, or invoices and credit notes, or expenses. |
| `finance_expenses` | An expense: a date, a category, a vendor who is a contact (`vendor_id`) or a typed name (`vendor_name`), never both, and `amount`, which has its SST inside it (`sst_amount` is that part). `status` is `pending`, `approved` or `rejected`; `approved_by` and `approved_at` say who decided and when, whichever way. It has no number. |
| `finance_receipts` | A receipt in the inbox: `file_path` (the object's name in the private bucket `finance-receipts`, empty only on the demo's seeded rows), `file_name` (what the uploader's device called it, for display only), `mime_type` and `size_bytes` (the database's reading of the stored object), what was read from it (`vendor`, `receipt_date`, `amount` with its SST inside, `sst_amount`, `extraction_error`, and `extracted_at`, the time a model read it and got something), `status` (`review`, `unmatched`, `matched`), and `expense_id` or `bill_id`: one of them exactly while it is matched. `uploaded_by` is written by the database. |
| `private.finance_receipt_deletions` | The paths of files to remove from the bucket. Written by a trigger when a receipt is deleted and by the clean-up function that finds unrecorded uploads; reachable by nobody but four `service_role` functions. |
| `finance_statement_imports` | One row per bank statement file imported for one account: `account_id`, `file_name`, `created_by`. |
| `finance_statement_lines` | One row per line of a statement, in the file's order (`position`): `line_date`, `description`, and `money_in` or `money_out`, never both. `transaction_id` is the movement of money a person matched it to; a movement is matched by at most one line. A line belongs to its import's account. |
| `finance_rfqs` | RFQs. Described here only for `source_rfq_id`: the first RFQ of the group a copied RFQ belongs to, and null for the first RFQ itself and for an RFQ that was not copied from another. It is set once, when the copy is first saved, and a copy of a copy names the first RFQ, so a group is one RFQ and every RFQ that names it, with no chain to follow. The foreign key is on `(org_id, source_rfq_id)`, so the link never leaves the workspace, and there is an index on the same pair. After that the link does not change from a signed-in caller, except that deleting the first RFQ, which only a draft allows, clears it on every copy (`on delete set null (source_rfq_id)`). |

## Document numbers

`select public.finance_next_number(target_org, doc)` with `doc` set to
`'invoice'` returns the next number (`INV-0001`) and moves the counter on. It locks the workspace's row for that
type, so simultaneous callers never get the same number. Types: `invoice`,
`quotation`, `credit_note`, `bill`, `receipt`, `voucher`, `transfer`. Call it from inside
the database function that posts a document, so a failed post does not use up a
number.

A quotation takes its `QT-` number when it is sent and a credit note its `CN-`
number when it is issued. A refund is money out and takes a `PV-` number when
it is paid out, from the same counter as a payment to a supplier. A payment
voucher of any other kind takes its `PV-` number from that counter too, when
it is paid, and a cash receipt its `RC-` number when it is posted, from the
counter payments in use. An expense has no number. A transfer between
accounts takes one `TR-` number for both of its sides, from a counter of its
own, so a transfer leaves no gap in the receipt or voucher numbers. A
payment's number is unique in its workspace; the two sides of a transfer are
the one case of two rows with one number.

`finance_next_number` runs as its owner (`security definer`) and is the only
writer of `finance_sequences`: since `20261030123000_finance_write_guards` the
table is read-only to a signed-in person, and the function begins by asking
whether the caller may write in the workspace (`42501` for a viewer and for
anyone outside it). `20261031090000_bendahara_banking`, written before that
file and applied after it, replaced the function to add the `transfer` type
and declared it `security invoker` again, as it had been; run as the caller
it could not write the counters, and every numbered document was refused
until `20261031090200_bendahara_banking_next_number_definer` put it back. A
later migration that replaces this function, or any function listed as
running as its owner under Database functions, must keep `security definer`
and the test of the caller it begins with.

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
| `finance_cash_receipts` | `invoice` | Money in against invoices | Payments In, one row per invoice | Payments In (recorded and posted at once; void) and Cash Receipts (a draft: edit, post, delete; void) |
| `finance_cash_receipts` | `income` | Money in that settles no invoice, with an income category | nowhere else | Cash Receipts |
| `finance_payment_vouchers` | `bill` | A payment to a supplier | Payments Out, one row per bill | Payments Out |
| `finance_payment_vouchers` | `refund` | Money back to a customer | Refunds | Refunds |
| `finance_payment_vouchers` | `expense` | A payment of approved expenses | Expenses, as Paid | Payment Vouchers (delete before it is paid; approve and reject if it waits) |
| `finance_payment_vouchers` | `other` | Money out that settles no document, with an expense category | nowhere else | Payment Vouchers (record, approve, reject, delete before it is paid) |

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

### The receipt form

Cash Receipts is writable. `cash-receipts.ts` holds the writes and
`cash-receipt-form.ts` the form's rules; `cash-receipt-form-card.tsx` draws
the form, a card of its own. A receipt is saved as a draft, posted, and after
that only voided; a draft is deleted. Who may do which is the database's
rule (`20261030123000_finance_write_guards`), and the screen offers each
person only what it will let them do:

| | Owner, admin | Member | Viewer, demo |
|---|---|---|---|
| New receipt, Save draft, Edit a draft, Delete a draft | Yes | Yes, anyone's draft | No button, no menu; the action answers "You do not have permission to make changes here." |
| Post (the form's "Post receipt", a draft's Post) | Yes | Not offered. `postCashReceiptAction` (a draft's Post) answers "Only an owner or admin can post, pay or void. Ask one of them to do this." without reading or writing. `saveAndPostCashReceiptAction` (the form's "Post receipt") saves the draft and answers "Saved as a draft. Only an owner or admin can post or issue it."; nothing is posted. The database answers `FIN14` and uses up no number | No |
| Void a posted receipt, of either kind | Yes | Not offered; the same sentence, `FIN14` | No |

The screen loader works `canSignOff` out from the viewer's role
(`can(role, 'sign-off-finance')`) and hands it to the view with the actions;
the server actions ask again (`SIGN_OFF` in `actions.ts`), and the trigger
`finance_transaction_sign_off` has the last word. A member's form has "Save
draft" only and says an owner or admin posts it. "Post receipt" saves and
then posts (`saveAndPostCashReceiptAction`); when only the post is refused
the draft is kept and the form goes on editing it.

A receipt for invoices is sent its split and nothing else: the database
makes its amount the sum of the split and its payer the invoices' customer. A
receipt for income is sent a category, an amount, and a contact or a typed
name or neither, never both (`finance_transactions_party_check`). The form
holds both sides while it is open and sends only the one chosen.

A draft being changed is not read again: the form is built from the draft's
row on the screen and, for its split, from the rows `finance_payments_in` has
for it. What it holds of its own invoices is not counted against it
(`receivableFor`), as the database deletes the old split before it checks the
new one. Saving replaces the draft whole; a draft that was posted or deleted
meanwhile answers with that sentence (`FIN09`, `FIN11`); after "That receipt no longer exists." the form forgets the draft's id and says "Save again to record it as a new receipt.", so what was typed can be saved as a new one. A ticked invoice that can no longer take money is left out, and the form says so.

Void is offered on every posted receipt, a payment recorded on Payments In
included: it is the same status change `voidPaymentIn` makes, asked of
`finance_cash_receipts` instead of `finance_payments_in`, so it also reaches a
receipt for income, which `voidPaymentIn` refuses.

### The voucher form

Payment Vouchers is writable for anyone who may edit (`can(role, 'edit-data')`,
never the demo workspace). The writes are in `src/lib/finance/vouchers.ts`, the
screen's rules in `src/lib/finance/voucher-form.ts`, the actions
(`recordVoucherAction`, `approveVoucherAction`, `rejectVoucherAction`,
`deleteVoucherAction`) in `actions.ts`. No migration came with it: every write
is one the database already allowed.

**New voucher** records money out that settles no document: who is paid (a
contact or a typed name, exactly one), an expense category, an amount, the
account, the date, the method, a reference and notes. It calls
`finance_record_voucher` asking for "To be paid" and sends no status of the
person's choosing. The database decides by who is recording: an owner's or
admin's voucher is approved in the same call and reads "To be paid"; anyone
else's waits as "Pending approval". The status is read back and the screen says
which it was. A voucher that waits cannot be edited (the guard refuses any
change of one, `FIN14`), so a mistake in one is deleted and recorded again; one
saved as a draft first can be (next section). Nothing is paid here yet: "Paid
now", Mark as paid and Void are part 5d-2.

**Approve** and **Reject** are offered to an owner or admin on every voucher
that is waiting, whatever it pays. Each is one update of `status`
(`scheduled` or `rejected`) and nothing else; the guard writes who decided and
when. The update is matched on the voucher as the person's row showed it:
`status = 'pending_approval'`, amount, date, method, account, contact, typed
name, category, reference and notes, each compared with `eq`, or with `is null`
where the row showed nothing. `finance_transactions.updated_at` is not moved by
the database, so it is not what is compared. When no row matches, one read of
`finance_payment_vouchers` words the answer: "That voucher no longer exists.",
"This voucher has already been approved.", "This voucher has already been
rejected.", or "This voucher is not as it was shown to you. Check it again
before you decide." A rejected voucher is final (the guard refuses to bring
one back): it is deleted and recorded again.
"Already been approved" is said only of a voucher that an owner or admin did
approve (`approved_at` is set); one that is "To be paid" and was never approved
(a supplier payment a member scheduled, reached by a direct call) gets "not as
it was shown". The Approve and the Reject question add one line under their
sentence with what the table does not draw: the category, the method, and the
reference and notes when they hold something, drawn as text.

At **Approve**, a voucher that pays supplier bills shows the same advice
Payments Out shows before a payment is marked paid: `OrderNotes` with the
sentences of `orderNotesForBills`, for each purchase order behind its bills
that is billed for more than its total or for more than has been received
(`orderNotesByVoucher`). That advice is worked out only for someone who may
approve, and only while such a voucher is waiting (`voucherAccess`); the bills
and purchase orders themselves are read for anyone who may write, because the
form offers them. Such a voucher is made on this screen: "New voucher" for a
supplier's bills, sent for approval (next section).

**Delete** is offered, to anyone who may write and whoever recorded the
voucher, on any voucher that is a draft, waiting or rejected, and on one that
is "To be paid" when it is of kind `expense` or `other`. It is one delete matched on the status the row
showed, so a voucher approved meanwhile is not deleted by someone who saw it
waiting ("This voucher has changed since you opened it, so it was not deleted.
Check it again."). A payment to a supplier and a refund are, from "To be paid"
onward, marked paid, voided and deleted on Payments Out and Refunds
(`voucherHome`), so their rows offer nothing here then; before that those two
screens offer nothing on them, so the delete is here.

What each role is answered by the database, and what the screen offers:

| Write | Owner, admin | Member | Viewer | Outsider |
|---|---|---|---|---|
| `finance_record_voucher` for a category | recorded, approved by them, "To be paid" | recorded, "Pending approval" whatever status was asked | `42501` "not allowed" | `42501` |
| Approve or reject a waiting voucher | done; `approved_by` and `approved_at` written by the guard | `FIN14` "only an owner or admin approves or rejects a payment" | no row changed | no row changed |
| Reject one that is "To be paid"; bring a rejected one back | `FIN14` | `FIN14` | no row changed | no row changed |
| Delete one that is not paid | done | done | no row changed | no row changed |
| Delete a paid one | `FIN09` | `FIN09` | no row changed | no row changed |

| On the screen | Owner, admin | Member | Viewer, demo, sample |
|---|---|---|---|
| New voucher | Yes: "Save voucher", approved on saving | Yes: "Send for approval" | No button |
| Approve, Reject on a waiting voucher | Yes | Not offered. The actions answer "Only an owner or admin can approve or reject a voucher. Ask one of them to do this." before anything is read | No menu |
| Delete on a draft, waiting or rejected voucher of any kind, and on a "To be paid" one of kind `expense` or `other` | Yes | Yes | No menu |
| A supplier payment or a refund that is "To be paid" or paid | A link to Payments Out or Refunds | The link | The link |

### A saved draft, and a voucher for a supplier's bills

Migration `20261117100000_bendahara_save_voucher.sql` adds one function and
nothing else: `finance_save_voucher(target_org, voucher, allocations)`. It
creates a draft voucher, or replaces the details and split of one that is
still a draft (`voucher.id`), and with `voucher.status = 'pending_approval'`
sends it for approval in the same call. A voucher is for one supplier's posted
bills (`allocations: [{bill_id, amount}]`; its amount is the sum of its split,
each part rounded to the sen, and its payee is the bills' supplier whatever
was sent) or for an expense category (an amount and a payee of its own). It
never schedules and never pays (`22023` if asked), takes no expenses (`FIN06`;
`finance_record_voucher` records those), and refuses an amount that is `NaN`
by name (`23514`). It runs as the caller, like `finance_save_cash_receipt`: it
writes no closed column, so the row policies decide who may write and every
guard runs on every row. It takes no error code of its own. Check script:
`supabase/tests/bendahara_save_voucher_check.sql`.

On the screen, "New voucher" asks what it is for. For an expense category the
first button is as before (an owner's or admin's save is approved at once; a
member's waits) and "Save as draft" is beside it. For a supplier's bills the
person chooses the supplier and ticks the bills (`voucherPayableBills`: what is
owed on each less what payments, drafts and waiting vouchers already hold),
sees under them the same over-billing advice the Payments Out form shows
(`OrderNotes`, `orderNotesForBills`), and has "Send for approval" and "Save as
draft", whoever they are. **Approval of a supplier payment is a choice**:
Payments Out still schedules one without it, and the form says so. This screen
never schedules a supplier payment, so the two screens do not offer the same
thing. An owner or admin who sends a voucher for approval may approve it
themselves.

A draft of kind Supplier payment or Other payment has **Edit** (the form, with
its bills ticked for what it holds), **Send for approval** and **Delete** in
its row, for anyone who may write, whoever saved it. Send is one update of
`status` to `pending_approval`, matched on the row as shown like a decision
("This draft is not as it was shown to you, so it was not sent. Check it
again."), and its question carries the same line of what the table does not
draw; the bills behind a draft are not part of that match, which is why
approval is matched again on a voucher that can no longer change. A draft is
always sent for approval, also by an owner or admin. A draft holds its part
of each bill (`FIN05` counts it), and so does a voucher that waits; a rejected
one holds nothing.

Once a voucher waits, its fields (`FIN14`) and its split (`FIN09` from the
guard on allocations) cannot be changed by anyone, so what an approver's row
and question showed is what is approved. Approved, a voucher for bills is a
payment "To be paid" on Payments Out (`voucherHome`), where it is marked paid,
voided or deleted; the Kind cell links there at every status and says "Managed
on Payments Out" from then on and not before (`voucherKindLink`).

A draft stays in the table in every period, as a draft receipt does
(`paymentVouchersInPeriod`): it holds its part of a bill until it is sent or
deleted, so it must be findable however old its date. No card or chart counts a
draft, and the line under the table counts one dated outside the period among
the rows it kept ("2 earlier ones still waiting or in draft").

The actions are `saveVoucherAction` and `submitVoucherAction`; neither needs a
sign-off, and both refresh the screens every voucher action refreshes
(`VOUCHER_PATHS`).

| Write | Owner, admin | Member | Viewer | Outsider |
|---|---|---|---|---|
| `finance_save_voucher`, a draft for bills or for a category | saved | saved | `42501` | `FIN06` (bills) or `FIN15` (category) |
| The same, sent for approval in the call | waits, approved by nobody | waits | `42501` | `FIN06` or `FIN15` |
| Edit a draft, whoever saved it | saved | saved | `FIN11` | `FIN06` or `FIN15` |
| Edit a voucher that is no longer a draft | `FIN09` | `FIN09` | `FIN11` | `FIN06` or `FIN15` |
| Send a draft for approval by its row | done | done | no row changed | no row changed |
| Change a waiting voucher's split | `FIN09` | `FIN09` | no row changed | no row changed |

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

An approved expense is an entry in the books: through the view
`finance_ledger_lines` (nothing is stored for it) it is a debit to its
category's ledger account and a credit to Accrued Expenses, for the whole
amount, SST included. Rejecting it removes that entry again, with no reversing
entry and no trace in Journals.

An expense's `amount` and `sst_amount` cannot be NaN
(`finance_expenses_amount_not_nan`, `finance_expenses_sst_amount_not_nan`,
from `20261114100000_bendahara_expense_amounts.sql`): NaN is a numeric that
passes `> 0`, and one saved expense of NaN would turn every total it is added
into NaN. `supabase/tests/bendahara_expense_amounts_check.sql` proves it.

Three columns of an expense are the database's to write
(`20261116120000_bendahara_expense_stamp_and_category_writers.sql`).
`updated_at` is set to the database's clock by the trigger
`finance_expense_stamp` on every insert and on every update that changes
anything, whatever the caller sent; it is left alone by an update that
changes nothing, by a session with nobody signed in (a migration, a seed) and
by the foreign key that clears a deleted user. The trigger's name sorts after
`finance_expense_guard`, so the guard answers first and is not replaced.
`created_by` and `created_at` are closed to the `authenticated` role by
column grants: an insert or update that names either is refused (`42501`),
whatever value it carries, and a new expense takes the person signed in and
the time from the columns' defaults. `approved_by` and `approved_at` stay
granted and are the guard's (`FIN14`, `FIN01`).
`supabase/tests/bendahara_expense_rules_check.sql` proves all of it.

### The expense form

`/finance/expenses` is writable for anyone who may edit. "New expense" opens
a card (`expense-form-card.tsx`): date, category, vendor (a contact, or "Not
a contact" and a typed name: exactly one), the amount with its SST inside it,
the SST, notes. There is one button. Who is saving decides what happens, in
the database: saved by an owner or admin the expense is approved in the same
call, **whoever entered it**, so an owner who edits a member's pending
expense approves it; saved by anyone else it waits as Pending approval. The
form says which before the save, and `saveExpense` reads the status back
after it. The status, the workspace and the two approval columns are never
taken from input.

Who is offered what is `expenseActions(row, canDecide)`, and `canDecide` is
worked out once, on the server, in `src/screens/finance/expenses.tsx`
(`can(role, 'sign-off-finance')`, the same people as the database's
`private.finance_may_decide`):

| Expense | Owner, admin | Member |
|---|---|---|
| Pending | Edit, Approve, Reject, Delete | Edit, Delete |
| Rejected | Edit (it is sent for approval again), Delete | the same |
| Approved, nothing paid, nothing held by a payment | Mark paid, Reject | nothing |
| Approved with a payment against it, and something left to pay | Mark paid | nothing |
| Approved with payments that cover all of it; Paid | nothing | nothing |

Approving and rejecting are checked by the expense's own guard
(`private.finance_expense_guard`), not by the sign-off trigger, which is not
on this table: a member's direct update answers `FIN14` "only an owner or
admin approves or rejects an expense". `FIN01` means five things on this
table and is worded by what was being done (`locked`, `cannotApprove`,
`cannotReject`, `cannotDelete`); `FIN02` is a rejection of an expense with a
payment against it; `23503` on a delete is an expense that a voided payment
still names, which is kept.

Approving and rejecting decide the expense the person was shown. The update
is filtered by everything the row showed, as the view returned it: `id`,
`updated_at` (the text the database gave, never reformatted), `status`,
`amount`, `sst_amount` (compared as numbers, so `120` and `120.00` are the
same), `expense_date`, `category_id`, the vendor (a contact by `vendor_id`,
with the table's own `vendor_name` empty; a typed vendor by `vendor_name`,
with `vendor_id` empty) and `notes` (`is null` when there are none). The
database moves `updated_at` on every change a signed-in person makes (the
stamp above), so it alone would now tell a changed expense from the one
shown; the fields are compared as well and stay compared, because the
comparison costs nothing, was proved field by field, and does not lean on a
trigger being there. When no row
matches, one more read tells what happened: the expense is gone ("That expense
no longer exists."); it now holds another status than the row showed ("This
expense has already been approved.", "...rejected." or "This expense is
pending again."); or it was changed ("This expense was changed after you
opened it. Check it again, then approve or reject it."). The screen refreshes
and, for the last, the question closes and the row shows what it now holds.
Not compared: a contact or a category renamed after the screen was drawn.

A money box (the amount and the SST are both text boxes) that holds a comma, a
`$` or RM in front is told "Enter the amount as a number, without commas or
RM: 1200.50." (the SST box: "Enter the SST as a number, without commas or RM:
72.00."); one with three or more decimals is told "Enter the amount to two
decimal places." (the SST box: "Enter the SST to two decimal places.") instead
of being rounded.

An approved expense that is paid in part reads "Part paid", with a line
under its status: what was paid, what payments not yet made hold, and what
has no payment yet (`expensePaymentNote`). The view's `display_status` is
still `approved` for it, and the status filter's Approved includes it. An
approved expense with only a payment waiting shows the same line under an
"Approved" chip.

### Mark paid

An owner or admin marks an approved expense paid from its row ("Mark paid",
offered while anything is left of it: `expenseLeft`, its amount less what is
paid and less what payments not yet made hold). The card
(`expense-pay-card.tsx`) asks for the account the money leaves, the date
paid, the method, a reference and the amount, which starts as all that is
left and may be lowered to pay part. Who is paid is not a field: it is the
expense's vendor, read from the database when the payment is recorded.

`markExpensePaid` (`expense-payment.ts`) reads the expense as the card
showed it (`id`, `status = approved`, `updated_at`), then calls
`finance_record_voucher(target_org, { account_id, txn_date, method,
reference, status: 'posted', contact_id | party_name }, [{ expense_id,
amount }])`, then reads the voucher's number. So a payment made here is an
ordinary payment voucher: one `finance_transactions` row, direction `out`,
status `posted`, numbered `PV-`, with one allocation to the expense, no
category of its own, and the expense's vendor as its payee. It shows on
Payment Vouchers as kind `expense` and on Banking, it debits Accrued Expenses
in the books, and it is voided as any voucher is: one change of status by an
owner or admin (from the app once Payment Vouchers has its row actions; see
Known limits). Voiding it makes the expense read Approved again (only posted
money counts as paid).

Paying is a sign-off: the action refuses anyone who may not sign off before
anything is read, and the database refuses them on the voucher (`FIN14`, with
nothing left behind). The database also has the last word on the amount
(`FIN05`: more than is left, counting payments not made yet) and on the
expense (`FIN04`: not approved; `FIN06`: not there). When the first read
finds nothing, one more read tells why: "That expense no longer exists.",
"This expense is not approved any more, so it cannot be paid." or "This
expense was changed after you opened it. Check it again, then mark it paid."
An amount of NaN is refused by the payment's own check
(`finance_transactions_amount_number_check`); the schema refuses it first.
Not checked by the database: that the account is active (the card offers
active accounts only).

For the Receipts Inbox (stage 7d): `ExpenseFormCard` takes `initial` (fields
to start a new form with) and `actions.save` (whatever saves it), so "Create
expense" opens the same card pre-filled and saves through
`finance_receipt_to_expense`; `saveExpenseInput` without its `id` is what
that function is given. That is built: see "Matching, on the screen" under
Receipts Inbox. Attaching starts from the receipt, in the inbox; an expense's
row shows a paperclip for each receipt tied to it and has no "Attach receipt"
item of its own.

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
- A scheduled payment out that nobody had to approve (a payment for a
  supplier's bills, a pending refund, a voucher for approved expenses: money
  out that is exactly its split) is held still too, since
  `20261117090000_bendahara_payment_held_still`: see "A payment that has left
  draft is held still" below. Before that file anyone who may write could
  edit it where it stood or send it back to draft, and an owner or admin who
  raised its amount above its split was written down as approving the rest;
  that path is now closed to every signed-in person (`FIN28`). An allocation
  of such a payment cannot be deleted, or lowered so that the payment is more
  than its split (`FIN14`), or changed in any other way (`FIN28`, or the older
  guard's `FIN03` or `FIN09` where it answers first): the payment
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

**A payment that has left draft is held still**
(`20261117090000_bendahara_payment_held_still`). Once a payment is not a
draft (`pending_approval`, `scheduled`, `posted`, `rejected`, `void`), for
every signed-in person and by whatever path:

- only its status moves. `direction`, `account_id`, `txn_date`, `amount`,
  `method`, `reference`, `contact_id`, `party_name`, `category_id` and `notes`
  stay as they are, with or without a change of status. The one exception is
  `txn_date` in the move from `scheduled` to `posted`, which is how
  `finance_mark_payment_paid` writes the day it was paid;
- it does not go back to `draft`, whoever asks: an owner and an admin are
  held as a member is. No screen ever offered it; the way to change a payment
  that is to be paid is to delete it and record it again;
- its split is not changed: no row of `finance_allocations` is added to it,
  taken from it, moved onto or off it, or edited.

`FIN28`, from `private.finance_transaction_still_guard` (trigger
`finance_transaction_still`, BEFORE UPDATE with a WHEN clause that names
those columns) and `private.finance_allocation_still_guard` (trigger
`finance_allocation_still`, BEFORE INSERT, UPDATE and DELETE). Both run as
their owner, change nothing, and step aside when nobody is signed in; the
split's also steps aside when its payment is being deleted with it and when
the workspace is. Posted, void, waiting, rejected and approved payments were
held already and still answer `FIN09` or `FIN14` first, because each new
trigger sorts after the guards that were there
(`finance_transaction_still` after `finance_transaction_sign_off`,
`finance_allocation_still` after `finance_allocation_guard`): the one payment
`FIN28` is new for is the scheduled payment nobody had to approve.
`finance_transaction_still` sorts before `finance_use_account_update`, so an
edit it refuses never takes the lock on the account that an archive waits
for. A change of nothing but `updated_at` is let through by both new triggers
(the older guards still refuse it on a waiting, rejected, paid or void payment
and on the split of every payment but a draft and a scheduled one nobody
approved). `finance_allocation_guard` runs as the caller and fires first, so
someone who cannot write the workspace is answered `FIN04` there and never
reaches `finance_allocation_still_guard`; if that guard is ever made a definer
or renamed to sort later, this function must ask `private.is_org_writer(new.org_id)`
itself before it reads the payment.
What the database itself writes on a payment that is not a draft (`number`,
`approved_by`, `approved_at`, `voided_at`, and `created_by` cleared when a
user is deleted) is in neither list and never calls the function.

Nothing the app does is refused: every function that records money inserts a
draft, writes its split while it is a draft and then moves its status once;
approving, rejecting, marking paid and voiding change status and nothing
else; deleting is not an update. `result.ts` names the code and a sentence
for it (`FIN_HELD_STILL`, `HELD_STILL`: "This is waiting to be paid, so it
can no longer be changed. Delete it and record it again."); no map lists it,
because no write in `src/lib/finance` can meet it, and
`tests/finance-payment-held-still.test.ts` fails if one starts to edit a
payment with a direct `.from('finance_transactions').update(…)`, and pins how
many `.update(` calls each file that names the table makes. `supabase/tests/bendahara_payment_held_still_check.sql`
goes through every column, role and status.

**Who writes `approved_by` and `approved_at`.** The guards do, and nobody
else. On a payment they are written in three cases: when an owner or admin
approves a waiting payment, when one of them rejects a payment, and when one
of them schedules or pays money out that is above its split. (The guard still
holds a fourth, for a scheduled payment that nobody approved and that is
changed so that it is then money out above its split. Since
`20261117090000` no signed-in person can make that change: `FIN28`.) On an
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

## Banking

Banking shows the workspace's accounts and every movement of money on them.
It reads two views. `finance_account_balances` has one row per account,
archived ones included: `balance` is the opening balance, plus every posted
movement in, less every posted movement out, whatever its date (`opening_date`
is a label and takes no part in the sum); `to_be_paid` is scheduled money out;
`last_import_at` and `unmatched_lines` come from the account's statements.
It has the bank's name and no account number: `finance_accounts.account_no`
is not readable by a signed-in person through the table
(`20261030123000_finance_write_guards`), the view runs as its reader, and
Banking's cards show no account number; the Accounts table shows the last four
characters, and only to someone who may write. A screen that needs one calls
`finance_account_numbers(target_org)`, which answers only to someone who may
write in the workspace. (The view first had the column and could be read by
nobody; `20261031090300_bendahara_banking_write_guards_fit` made it again
without.)
`finance_bank_transactions` has one row per `finance_transactions` row, either
direction, any status: `kind` is what the cash book calls it (`invoice`,
`income`, `bill`, `refund`, `expense`, `other`) or `transfer`;
`other_account_name` is the account at the other end of a transfer;
`reconciled` says a statement line is matched to it. The screen lists posted
rows only, and works out the running balance in the browser
(`withRunningBalance` in `banking-views.ts`): per account, from the opening
balance, in the order date, time recorded, id. The newest row of an account
therefore carries the balance the view gives; the table's "Account balance"
column is the balance of that row's account after it. The cards show exact
amounts, to the sen, as a bank statement does. The table's count line is left
out when no posted movement exists at all.

`banking.ts` only reads. Accounts can be added, edited, archived and restored
(see "Accounts" below), and a transfer recorded and voided (see "The transfer
form"); statements get their forms later. Every action that records,
pays, voids or deletes money refreshes `/finance/banking`; an action added
later must do the same.

**A transfer between accounts** is two `finance_transactions` rows that share
a `transfer_id`: money out of one account and the same money in to another,
on one date, with one `TR-` number, no payee, no category and no split.
Neither side is a receipt or a voucher: `finance_cash_receipts` and
`finance_payment_vouchers` leave rows with a `transfer_id` out, and a
transfer moves the total of the accounts nowhere.
`finance_record_transfer` makes both sides and posts them at once;
`finance_void_transfer` voids both.

Only an owner or admin can record a transfer. The side that leaves an account
is money out that settles no document, and the guard on payments holds that
to an owner or admin (see Approval): the function says so first (`FIN14`).
The guard writes the owner or admin down as approving the money out, and both
sides are recorded as made by them (`created_by`).

`finance_record_transfer` runs as its owner (`security definer`), like the
six functions that number a payment: a payment's `number` is a column no
signed-in person writes, so only a function that runs as the owner can post.
It begins by asking whether the caller may write in the workspace, which
row-level security no longer asks for it: a viewer, a session that still owes
a second factor and anyone outside the workspace get `42501`, whatever they
sent. A writer who is not an owner or admin gets `FIN16` for a transfer that
is wrong in itself and `FIN14` otherwise. Every read and write in it names
the workspace, so it cannot reach another's accounts. For the same reason two
sides inserted by hand cannot be posted by hand, by anyone signed in: an
update that names `number` is `42501`, and one that posts without a number
is `23514`. The function is the only way a transfer is posted.

Only an owner or admin can void a transfer. Voiding any posted payment is a
sign-off since `20261030123000_finance_write_guards`, and the trigger that
asks for one answers `FIN14` to anyone else, through `finance_void_transfer`
or by a plain update. `finance_void_transfer` still runs as the caller: it
writes only `status`, and row-level security decides which transfers it can
find (`FIN11` for a viewer or another workspace; `FIN11` and `FIN09` are
answered before `FIN14`).

The pair is kept whole by triggers that run after each statement on
`finance_transactions` (`private.finance_transfer_pair_check`). Once any side
of a transfer is posted or void there must be exactly two sides, one in and
one out, on different accounts, with the same amount, date, status and
number, naming nobody, carrying no category and split across nothing, and
both posted or both void; anything else is `FIN16`. So one side cannot be
posted, voided or changed alone, and both are posted or voided by one UPDATE.
Sides that are all still drafts are not looked at: a draft moves no money. A
payment never joins or leaves a transfer: an UPDATE that changes
`transfer_id` is `FIN16`. A transfer has at most one side in each direction
(a unique index, `23505`), and a side carries a number only once it is posted
or void (`23514`), so a draft nobody sees cannot sit on the next `TR-` number.
The pair check is the one finance trigger function that runs as its owner
(`security definer`): when a user is deleted the foreign keys clear
`created_by` and `approved_by`, and Postgres runs that update's statement
triggers at the end of the delete as whoever issued it, which for Supabase
Auth is a role with no rights on `public` tables.

An amount is a number. `'NaN'` is a valid `numeric` in Postgres, is greater
than every number and would turn every balance it is added into to NaN, so
`finance_transactions.amount` and both amounts of a statement line refuse it
(`23514`), whichever function or direct write it comes through;
`finance_record_transfer` and `finance_import_statement` refuse it first
(`FIN16`, `FIN17`).

**A bank charge and interest** are not special. A charge is money out for an
expense category, recorded by `finance_record_voucher`: from someone who is
not an owner or admin it waits for approval like any other, and paying it is
an owner's or admin's. Interest is money in for an income category, a cash
receipt: anyone who may write saves it as a draft, it needs no approval, and
posting it is a sign-off like posting any receipt (`FIN14` for anyone who is
not an owner or admin). A statement
line is something a person imported, so matching a line approves nothing, and
a line cannot be matched to a payment that is not posted.

**Statements.** `finance_import_statement` stores one file's lines for one
account, at most 1,000, each unmatched. A line is what the bank said: once it
is in, only its match changes (`FIN17`). Matching is a plain update of
`transaction_id`, and unmatching sets it back to null; anyone who may write
can do both. The guard on lines (`private.finance_statement_line_guard`)
holds a match to a posted payment of the line's account, in its direction,
for its amount. How far apart the two dates may be is not the database's
business: the three days in the design limit what is proposed. A payment is
matched by at most one line (`23505`). A matched line, or an import that has
one, is unmatched before it is deleted (`FIN17`). When a payment is voided, a
line matched to it goes back to unmatched
(`private.finance_transaction_unmatch`). So a member can match and unmatch
lines and import a statement (`finance_import_statement` runs as the caller;
the two statement tables are not among the ones the write guards closed),
and cannot void the payment a line is matched to. A cash account can be given a
statement, but the screen shows a dash instead of a reconciliation status for
a cash movement and for a movement on a bank account that has never had a
statement imported, and leaves both out of the gauge. While no bank account
has had a statement imported, the Reconciliation card says "No statement
imported yet." and shows no count.

### Accounts

Accounts are managed on Banking: "Add account" in the header, and Edit,
Archive and Restore in the Accounts table, which lists every account,
archived ones included. `bank-accounts.ts` has one schema and one function per
write (`createBankAccount`, `updateBankAccount`, `setBankAccountActive`) and
`listBankAccountNumbers`. A change always writes the bank name and number: one
that is left out is cleared, and the form always sends both. `bank-account-form.ts`
has the form's rules and what the table shows. The three actions refresh `BANK_ACCOUNT_PATHS`: Banking, every
screen whose forms offer an account or whose rows name one, and the three ledger
screens (Chart of Accounts, Journals and Reports), since each account has a ledger
account and an opening balance is an entry in the books.

**The ledger account.** Every bank or cash account has an account in the Chart
of Accounts (`finance_ledger_accounts.bank_account_id`), made with it by the
ledger's own triggers. Renaming the bank account renames the ledger account
(unless that one was renamed in the Chart of Accounts) and the description of
the opening entry; archiving and restoring it archives and restores the ledger
account. An opening balance is an entry in the books dated `opening_date`
(debit the account, credit Opening Balance Equity; reversed for an overdraft).
The sync runs one way: archiving or renaming the ledger account in the Chart
of Accounts does not touch the bank account. The form says so on edit ("Renaming
it also renames its account in the Chart of Accounts, unless that one was
renamed there.") and the archive question says it for archiving. After a save
that set or changed an opening balance, Banking says that Total cash and the
Chart of Accounts changed with it.

What each role sees and is answered (`FIN14` is from the guard, a BEFORE
trigger, so it answers before the row policy does):

| | Owner, admin | Member | Viewer, demo |
|---|---|---|---|
| Header and row menu | Add account; Edit, Archive, Restore | the same | none |
| Form | opening balance and "As at" boxes; account number whole | no opening balance boxes (it reads the balance as text on edit); account number whole | no form |
| Insert with an opening balance | taken | `FIN14` | `FIN14` (never reached through the screen: the action refuses first) |
| Change of balance or date, delete of an account holding one | taken | `FIN14` | refused by the row policy (`42501`, or no row changed) |
| Insert without one, rename, archive, restore | taken | taken | refused by the row policy (`42501`, or no row changed) |
| Account numbers | read | read | not read |

An outsider, and a member who owes a second factor, are answered as a viewer:
an insert with an opening balance is `FIN14`, anything else is `42501` or changes no row. An owner
at `aal1` with a verified factor also gets `FIN14` on an insert with an opening
balance, which is why the sentence for it does not say the person is not an
owner.

What the database holds an account to (`20261114110000_bendahara_bank_account_rules`):

- **An opening balance is an owner's or admin's.** Adding an account with
  one, changing an account's opening balance or opening date, and deleting an
  account that has one are refused for any other writer (`FIN14`, from
  `private.finance_bank_account_guard`, which asks `private.finance_may_sign_off`).
  A member's form has no opening balance box and sends neither column; the
  server action refuses an input that carries one before anything is written.
  An opening balance is a number (`23514` for NaN).
- **Bank or cash is chosen once.** `kind`, `org_id`, `id` and `created_at`
  are not columns a signed-in person can update (`42501`); `id` and
  `created_at` cannot be inserted either.
- **An account is archived, not deleted,** and not while a payment on it, money
  out or money in, is to be paid (`scheduled`) or waits for approval
  (`pending_approval`): `FIN30`. Drafts and posted payments do not hold it.
  The archive question warns only about money out that is to be paid
  (`to_be_paid`); the refusal covers the rest. An archived account
  keeps its movements and its balance, stays in Total cash, is no longer
  offered by any payment form, and cannot take or send a transfer. The screen
  offers no Delete; the database still lets an unused account be deleted, and
  refuses any other with `23503`.
- **The account number** is written with the row and read back only through
  `finance_account_numbers`, by someone who may write. The loader reads the
  numbers only for them; the table shows the last four characters of a number
  of eight or more (spaces and dashes not counted; a shorter one shows
  nothing), and the form the whole number. A viewer sees the bank's name.

The guard steps aside when nobody is signed in (a migration, the demo seeds)
and, on a delete, when the workspace itself is being deleted.

**No money on an archived account** (`20261116110000_bendahara_archived_account_rule`).
The database refuses it for every signed-in person, by whatever path
(`FIN37`, from `private.finance_transaction_account_guard` on two triggers of
`finance_transactions`, `finance_use_account_insert` and
`finance_use_account_update`):

- a payment is not started on an archived account, not even a draft;
- a payment is not moved onto one, whatever its status;
- a payment whose account is archived is not sent for approval, approved,
  scheduled, posted or marked paid. A draft that was on the account when it
  was archived is still edited there, and is posted once the account is
  restored or the draft is pointed at an active account.

Voiding, rejecting and deleting go on working on an archived account, in both
directions and for both sides of a transfer. The two triggers sort after
every guard that was there (`finance_transaction_guard`,
`finance_transaction_insert_guard`, `finance_transaction_sign_off`,
`finance_transfer_id_guard`), so a single statement those refuse keeps its
code, and before `finance_void_stamp`, which must stay the last BEFORE
trigger. A member posting a draft, approving or marking paid on an archived
account is therefore still answered `FIN14`, not `FIN37`. A function that
inserts a draft before it posts is the exception: a member recording a payment
in, a refund or a paid-now payment out on an archived account is answered
`FIN37`, because the draft is refused before the sign-off rule is reached,
where before this rule they were answered `FIN14`. A BEFORE trigger answers before the row policy: a viewer or an
outsider who names an archived account of a workspace in an insert gets
`FIN37` where an active account gives `42501`; nothing is written either way.

The same trigger locks the account's row (`for share`) until the payment's
transaction ends, and an archive is an update of that row, so the two wait for
each other: an archive that meets a payment being scheduled is refused
(`FIN30`) once that payment is in, and a payment that meets an archive under
way is refused (`FIN37`) once the account is archived. An archived account
therefore never holds a payment that is scheduled or waits for approval.
Renaming an account waits the same few milliseconds for a payment in flight.
One statement that archives two accounts while a transfer between those two
is being recorded can deadlock; Postgres ends one of them (`40P01`) and a
retry works. The function runs as its owner so that it can take the lock
whoever is writing; it steps aside when nobody is signed in.

`money.ts`, `refunds.ts` and `cash-receipts.ts` word `FIN37` with one
sentence from `result.ts` (`ACCOUNT_ARCHIVED`): "The account this is on has
been archived. Restore it on Banking, or use another account, then try again."
A person meets it when the account was archived after their form was opened,
or when they post, from Cash Receipts, a draft whose account was archived
after the draft was saved. A stage that adds a write of `finance_transactions`
adds the code to its own map.

`service_role` holds no privilege on any finance table or view since the same
migration. On hosted it had been left TRUNCATE, REFERENCES, TRIGGER and
MAINTAIN on the 32 whose migrations revoked "from anon, authenticated" only;
it never held a read or a write on them. A migration that adds a finance
table revokes "from anon, authenticated, service_role".

On `finance_statement_imports`, `created_by`, `id` and `created_at` are the
database's to write since the same migration (`42501`): an import is recorded
as made by the person signed in, and "Last import" cannot be moved.

### The transfer form

"Transfer" in Banking's header opens a form at the top of the page: From and
To (two different active accounts, each shown with its balance; To leaves out
the account chosen in From), an amount, a date (the person's own date when
the form opens), a reference and notes. `transfers.ts` has one schema and one
function per write: `recordTransfer` calls `finance_record_transfer` and then
reads the `TR-` number back from one side (a transfer whose number could not
be read back is still a success, without a number); `voidTransfer` calls
`finance_void_transfer`. `transfer-form.ts` has the form's rules and every
sentence the screen says. Nothing in the database changed for this: both
functions are used as stage 6a left them.

Recording and voiding are an owner's or admin's. The loader hands the two
actions (`writer.transfers`) to nobody else, so a member sees no "Transfer"
button and no menu in the Transactions table; the actions refuse a member
before anything is read ("Only an owner or admin can record or void a transfer
between accounts. Ask one of them to do this."), and the database answers
`FIN14`. The button is also absent while the workspace has fewer than two
active accounts.

| | Owner, admin | Member | Viewer, demo |
|---|---|---|---|
| Header | New receipt, Transfer, Add account | New receipt, Add account | none |
| Transactions table | a menu on each side of a transfer: Void transfer | no Actions column | no Actions column |
| `recordTransferAction`, `voidTransferAction` | run | refused before anything is read | "You do not have permission to make changes here." |
| `finance_record_transfer` | recorded | `FIN16` for what is wrong with it first, then `FIN14` | `42501` |
| `finance_void_transfer` | voided | `FIN14` | `FIN11` (the rows are not theirs to see or lock) |

`FIN16` is three messages under one code, so the schema refuses the two a
form can cause first (the same account twice; an amount that is not above 0)
and `FIN16` from the database is worded for what is left: "One of those
accounts has been archived or no longer exists. Choose another, then try
again." The archived-account rule on `finance_transactions` raises `FIN37` when
an account is archived in the moment between `finance_record_transfer`'s own
question (which answers `FIN16`) and the write, and `transfers.ts` gives it the
same sentence as `FIN16`. `FIN09` is "This transfer has already been voided." and
`FIN11` "That transfer no longer exists." Both leave the row, which the refresh
after a refusal takes out of the table (it lists posted movements only), so a
refused void is also said at the top of the page in a note titled "Transfer not
voided", where it outlasts the question it was asked in.

A transfer for more than the From account holds is taken; the form says what
it leaves the account at before it is recorded ("Main Bank holds RM 300.00.
This transfer leaves it overdrawn by RM 200.00."). A transfer is not edited:
it is voided and recorded again. "Void transfer" is asked in the row of either
side and says what it does, including that a statement line matched to either
side goes back to unmatched; both sides then leave the table, which lists
posted movements only, and a note says so. A voided transfer keeps its number.

Both actions refresh `TRANSFER_PATHS`: Banking and the three ledger screens. In
the books a posted transfer is one entry (debit the account it reached, credit
the one it left) and a voided one is that entry and its reversal; Reports
leaves transfers out of money in and money out, since nothing entered or left
the business. A transfer is on no other screen.

Banking keeps one thing open at a time: the account form, the transfer form,
an archive question or a void question. The header's buttons wait while any of
them is open or a void is under way, a menu choice replaces a question with
what it opens, and a void question whose row has left the table (a search or
filter hid it, or the refresh took it away) is closed for good: it does not
come back when the filter is cleared. A void that finishes closes only its own
question. Who is given the transfer actions is `bankingAccess` in
`banking-access.ts`: an owner or admin, never the demo workspace.

## Receipts Inbox

A receipt is a photo or a PDF in the private storage bucket
`finance-receipts`, and one row of `finance_receipts` that says what was read
from it and what it backs. The screen uploads, opens, reviews, matches and
deletes; nothing reads a receipt with a model yet (stage 7c). The migration
creates new objects only: it replaces nothing the write guards or Banking
defined, and no function here posts, numbers, pays or voids.

**What a signed-in person may write.** As on payments since the write
guards, by column-level grants: on insert `org_id`, `file_path` and
`file_name`; on update `vendor`, `receipt_date`, `amount`, `sst_amount`,
`status`, `expense_id`, `bill_id`, `extraction_error`, `extracted_at` and
`updated_at`. Everything else (`mime_type`, `size_bytes`, `uploaded_by`,
`created_at`, `id`, and after the insert the workspace, the path and the
name) is refused with `42501` before a trigger runs, and written by the guard.
`service_role` has no right on the table.

**The bucket.** JPEG, PNG, PDF, HEIC and HEIF, 10 MB a file. An object's name is
`<workspace id>/<random uuid>.<jpg|png|pdf|heic|heif>`, lower case, and nothing
else. (The app is to turn a HEIC or HEIF into a JPEG in the browser whenever
it can, so an original is stored only when that fails.) Three rules on
`storage.objects`, each limited to this bucket:

- `finance_receipt_files_select`: a member of the workspace named by the first
  folder reads (signs a link for) the file.
- `finance_receipt_files_insert`: whoever may write in that workspace uploads,
  when the name has exactly that shape, they are signed up (not anonymous),
  the workspace is not the shared demo, and there is room
  (`private.finance_receipt_room`: under 1 GB for the workspace and under
  20 GB for the bucket).
- `finance_receipt_files_mfa_required`, restrictive: a session that owes a
  second factor gets nothing.

There is no update and no delete rule: nobody signed in replaces or removes a
file. The server removes files, with the service client, and only the ones the
database has let go.

**Recording.** `finance_register_receipt` inserts the row, and the guard
(`private.finance_receipt_guard`) refuses it unless the object is in the
bucket, uploaded in the last 30 minutes, not already a receipt, not waiting to
be removed, and of the type its extension names (`FIN24`). That the path is
under the row's own workspace is not the guard's check but the table's
(`finance_receipts_file_path_check`, `23514`). `mime_type`, `size_bytes` and `uploaded_by` are the
database's to write. Someone who may not write in the workspace is answered
`42501` before anything is said about a file.

**After that** the file, its name, type, size, uploader, upload time and
workspace never change: `42501` from the grants for a signed-in person, and
`FIN23` from the guard for any write that gets past them. `vendor`, `receipt_date`, `amount` and
`sst_amount` can be written at any time by anyone who may edit:
`finance_set_receipt_extraction` is for a model's reading, writes only
while the receipt is in review, and stamps `extracted_at` when the reading
worked (a failed one clears it): the screen says "Read by AI" from that stamp
alone, and only until it leaves review; `finance_review_receipt` is a person's and
moves a receipt in review to unmatched.

**Matching.** A receipt names one expense or one bill of its workspace, or
neither, and its status is `matched` exactly while it names one (a check
constraint; the guard sets the status as the receipt is tied and untied). A
document can have several receipts. `finance_receipt_to_expense` makes a new
expense through `finance_save_expense` and ties the receipt to it in one
transaction, so the expense waits for approval or is approved as any expense
would be. `finance_receipt_to_bill` does the same through `finance_save_bill`
and leaves a draft bill: nothing posts it. Any writer may make the draft;
posting it is a sign-off (an owner or admin). A void bill takes no receipt (`FIN25`). Untying a receipt from an
approved expense or a posted bill is for an owner or admin
(`private.finance_may_decide`, `FIN14`); from a pending or rejected expense or
a draft bill, for anyone who may edit. A matched receipt is untied before it
is deleted (`FIN23`).

**Matching, on the screen.** `receipt-match.ts` holds the writes and the
rules, `receipt-match-cards.tsx` the cards, and the inbox's row menu offers
them. A receipt tied to nothing (in review or unmatched) offers "Create
expense", "Create draft bill" and "Attach to expense or bill"; a matched one
offers "Untie". None of this needed a migration.

| | Owner, admin | Member | Viewer, demo |
|---|---|---|---|
| Create expense from a receipt | Yes: approved in the same call | Yes: waits as Pending approval | No menu; the action answers "You do not have permission to make changes here." |
| Create draft bill from a receipt | Yes, a draft | Yes, a draft; posting it on Supplier Bills is refused (`FIN14`) | No |
| Attach to a pending or approved expense, or a draft or posted bill | Yes | Yes; told that an approved expense or a posted bill keeps the receipt | No |
| Untie from a pending or rejected expense, or a draft or void bill | Yes | Yes | No |
| Untie from an approved expense or a posted bill | Yes | Not offered; one line above the table says who can. A direct call answers `FIN14`: "Only an owner or admin can untie a receipt from an approved expense or a posted bill. Ask one of them to do this." | No |
| Download a receipt from its expense's or bill's row (the paperclip) | Yes | Yes | A viewer yes; the demo's receipts have no file |

- "Create expense" opens the expense form (`ExpenseFormCard`) started from the
  receipt (`expenseFormFromReceipt`: its date, or the person's own today; its
  vendor as a typed name, or as the contact when exactly one active contact
  has that very name; its amount and SST) and saves through
  `finance_receipt_to_expense`. The schema is the expense's own
  (`saveExpenseInput`), so `NaN`, an amount of 0 and SST over the amount are
  refused in the expense's sentences before the database is asked; an `id` is
  never sent.
- "Create draft bill" opens the bill form (`BillFormCard`, with `initial` and
  `draftOnly`) with one line: unit price the receipt's amount, SST rate 0
  (a receipt's amount has its SST inside it, a bill line's goes on top), the
  supplier chosen when exactly one active supplier has the vendor's name. It
  saves through `finance_receipt_to_bill`. **Nothing made from a receipt is
  posted:** the form has no second button (`draftOnly` on
  `DocumentFormCard`), and neither `receipt-match.ts` nor the actions file
  names a function that posts (a unit test reads both files).
- "Attach to expense or bill" lists expenses that are pending or approved and
  bills that are not void (`attachCandidates`), those of the receipt's own
  amount first. A rejected expense is not offered though the database would
  take it.
- A receipt in review can be matched without being reviewed first: the form
  is the review. The receipt keeps its own four details as they were.
- Under "Matched to", a second line says how the document stands
  (`matchedDocuments`: Pending approval, Approved, Paid, Rejected, Draft,
  Posted, Posted, overdue, Void). For that the inbox's loader reads the
  workspace's expenses and bills for everyone, once the inbox holds a receipt.
- Expenses and Supplier Bills each make one more read
  (`listAttachedReceipts`) and draw `AttachedReceipts` in the vendor's and the
  bill number's cell. The paperclip calls `receiptLinkAction`: the same
  one-minute link, signed as the person, after the server has read the file's
  first bytes, saved as a download.
- When a pending or rejected expense or a draft bill is deleted, its receipts
  go back to Unmatched (the foreign key clears the column and the guard sets
  the status); the receipts and their files are kept. An approved expense and
  a posted bill cannot be deleted. A bill that is voided keeps its receipts,
  which anyone who may edit can then untie.

**When the document goes.** The two foreign keys are
`ON DELETE SET NULL (expense_id)` and `(bill_id)`: deleting a pending or
rejected expense, or a draft bill, is never held up by a receipt, and the
receipt goes back to Unmatched.

**Removing files.** A deleted receipt's path is written to
`private.finance_receipt_deletions` by a trigger, whoever deleted it and
however, a deleted workspace included. `finance_receipt_queue_orphans` adds
every object in the bucket that no receipt holds and that is an hour old: a
file can be recorded for 30 minutes after its upload, so the two never meet.
`finance_receipt_deletions_due` and `finance_receipt_deletion_queued` read
the list, and `finance_receipt_deletions_done` takes a path off it only when
its object is really gone. These four are the only things granted to
`service_role` in finance, and they are functions: it has no right on any
finance table.

**Uploading.** The browser puts the file straight into the bucket as the
signed-in person (`src/components/finance/receipt-upload.ts`), so the bucket's
own rule decides and no file passes through the app's server; the server
action body limit is not raised. Before anything is sent the browser reads the
file's first bytes (`sniffReceiptType` in `receipt-files.ts`): the type is
what the bytes say, never the name or what the device reports, and anything
that is not a JPG, PNG, PDF, HEIC or HEIF is refused there. The path is
`<workspace id>/<uuid>.<ext>`; the browser makes the uuid, the action refuses
a path that is not of that shape in the caller's own workspace
(`isInboxReceiptPath`), and the guard refuses one with no object behind it.
The upload is a plain one, not a resumable one: there is no percentage, only
"Uploading", and a dropped connection fails that file, which starts again
when the person presses Try again.
`registerReceiptAction` then
records the row; called twice for one file it answers with the same receipt.
Files go one at a time through a queue of at most twenty
(`queueAdd`, `queueNext`, `retryPlan`), each with its own state and sentence.
A file that was stored and not recorded is retried without a second upload
for 25 minutes, and uploaded again after that.

**HEIC.** A HEIC or HEIF is turned into a JPG before upload
(`receipt-heic.ts`): by the browser's own decoder when it has one (Safari),
otherwise by `heic-to` (LGPL-3.0, libheif inside), whose `heic-to/csp` build
is plain JavaScript and runs under the Content-Security-Policy without
`wasm-unsafe-eval`. It is loaded with a dynamic `import()` the first time it
is needed, about 0.8 MB compressed, and by nobody else. When neither works
the original is stored and is a download only.

**Opening a file.** `receiptLinkAction` reads the path and signs a 60-second
link as the caller, always with a download name of ours (`receipt.jpg`), so
storage serves an attachment. Before it hands the link out it reads the
file's first 64 bytes through a ranged request (`storedFileCheck` in
`receipt-files-server.ts`) and refuses a file that is not the type its
receipt says. A JPG or PNG is previewed in the review card from bytes the
browser fetches and checks itself, as an object URL: no image, frame or new
tab is ever pointed at a stored file. A download also goes through the
page's own copy of the bytes (it does not check their first bytes again; the
server did): the browser fetches them through the link, with a 60-second limit,
and saves its own copy, typed `application/octet-stream`, from an object URL, so the page never navigates to storage. A PDF and a stored HEIC
are downloads only.

**Reviewing.** `reviewReceiptInput` and `finance_review_receipt`: vendor (200
characters), a real date, an amount above 0 with its SST inside it, SST from 0
to the amount and not without one. Every field may be empty. A receipt in
review becomes unmatched. Any writer may review; the screen offers it on a
receipt that is tied to nothing.

**Deleting, and the clean-up run.** `deleteReceiptAction` deletes the row as
the caller and gets the deleted row's path back in the same statement; the
path stays on the server. `removeReleasedReceiptFile` then asks
`finance_receipt_deletion_queued` for that path, removes the object with the
service client and calls `finance_receipt_deletions_done`. If that fails the
receipt is still deleted and the file waits for the run.
`POST /api/finance/receipt-cleanup` (`cleanReceiptFiles`) queues orphans,
reads up to 100 due paths, asks about each again immediately before removing
it, and marks done only what the database sees is gone. It is authorized like
the other scheduled endpoints (`isTriggerAuthorized`) and must be called by
the operator's scheduler; it stops after 20 seconds and takes up the rest on
the next call. It answers `{"ok", "queued", "removed"}`: how many unrecorded
uploads it put on the list, and how many files it took off it. `ok: false` means
something was left for the next call (the list could not be read, a file could
not be removed, or the 20 seconds ran out); it is not an error to alert on
unless it stays false for many calls in a row. A `401` means the secret is
wrong, unset or shorter than 32 characters.

**The demo** has eight receipts with no file (a migration cannot upload), so
`has_file` is false on them and the screen says so. Its guests are anonymous
accounts, which the bucket refuses, so the demo has no upload area and a
sentence saying why.

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
  expense is allowed whatever its status, when the foreign key does it, and
  does not move the expense's `updated_at`. By hand, `approved_by` on an
  approved or rejected expense is `FIN01`, and `created_by` is `42501` on any
  expense: the column is closed.
- Each guard steps aside when the workspace itself is being deleted.

## Database functions

Most run as the caller, so RLS decides who may write. Eight run as their
owner (`security definer`), because each writes something no signed-in person
may write directly: a payment's `number`, or the counters. They are
`finance_record_payment_out`, `finance_mark_payment_paid`,
`finance_record_payment_in`, `finance_record_refund`,
`finance_post_cash_receipt`, `finance_record_voucher`
(`20261030123000_finance_write_guards`), `finance_record_transfer`
(`20261031090300_bendahara_banking_write_guards_fit`) and
`finance_next_number`. Each begins by asking whether the caller may write in
`target_org` and answers `42501` if not; each reads and writes by
`target_org` only; and the guards and the sign-off trigger still see the
person signed in, because that comes from the request and not from the role
a function runs as. `finance_account_numbers(target_org)` runs as its owner
too and returns the workspace's account numbers to a writer, and no row to
anyone else.

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
| `finance_register_receipt(target_org, file)` | Records an uploaded file as a receipt in review and returns its id. `file` has `path` and `name`. The guard checks the file. |
| `finance_set_receipt_extraction(target_org, target_receipt, details)` | Writes what a model read (`vendor`, `receipt_date`, `amount`, `sst_amount`) or why it could not (`error`), only while the receipt is in review. Answers whether it wrote. |
| `finance_review_receipt(target_org, target_receipt, details)` | Saves what a person typed; a receipt in review becomes unmatched. |
| `finance_attach_receipt(target_org, target_receipt, target_expense, target_bill)` | Ties an unmatched or in-review receipt to an expense or to a bill: exactly one of the two. |
| `finance_detach_receipt(target_org, target_receipt)` | Unties a matched receipt. |
| `finance_receipt_to_expense(target_org, target_receipt, expense)` | Makes a new expense from a receipt and ties the receipt to it. `expense` is what `finance_save_expense` takes; an `id` in it is ignored. Returns the expense's id. |
| `finance_receipt_to_bill(target_org, target_receipt, bill, lines)` | Makes a new draft supplier bill from a receipt and ties the receipt to it. `bill` and `lines` are what `finance_save_bill` takes; an `id` in `bill` is ignored. Never posts. Returns the bill's id. |
| `finance_receipt_queue_orphans()`, `finance_receipt_deletions_due(p_limit)`, `finance_receipt_deletion_queued(p_path)`, `finance_receipt_deletions_done(p_paths)` | The clean-up run's. `service_role` only. |
| `finance_record_transfer(target_org, transfer)` | Moves money between two active accounts of the workspace: two posted payments with one `TR-` number. `transfer` has `from_account_id`, `to_account_id`, `amount`, `txn_date`, `reference`, `notes`. An owner or admin only (`FIN14`); runs as its owner, and anyone who may not write in the workspace is `42501`. Returns the transfer's id. |
| `finance_void_transfer(target_org, target_transfer)` | Voids both sides of a posted transfer. An owner or admin only (`FIN14`, from the sign-off trigger); runs as the caller. |
| `finance_import_statement(target_org, target_account, file_name, lines)` | Stores one statement for one account. `lines` is a list of `{ line_date, description, money_in, money_out }` in the file's order, at most 1,000. Returns the import's id. |
| `finance_next_number(target_org, doc)` | The next document number. Runs as its owner; the only writer of `finance_sequences`. |
| `finance_account_numbers(target_org)` | The account numbers of the workspace, one row per account, for someone who may write there; nobody else gets a row. |
| `finance_save_rfq(target_org, rfq, lines)` | Creates a draft RFQ or replaces a draft's header and lines, and returns the id. Since `20261116090000_bendahara_rfq_source` it writes `rfq.source_rfq_id` when it creates a draft. Saving a draft again leaves the link as it is, whatever is sent. |

The same migration changes two more things. The RFQ guard
(`private.finance_rfq_guard`, the trigger on `finance_rfqs`) sets the link
when an RFQ is inserted: it follows a copy of a copy back to the first RFQ,
and refuses a source it cannot find in the RFQ's own workspace (`FIN11`), so
a new RFQ cannot name another workspace's RFQ, or itself. On an update from
a signed-in caller it refuses any change to the link (`FIN01`); the one change it lets through is
the foreign key clearing the link because the first RFQ was deleted. The view
`finance_rfq_totals` lists its columns by name and ends with a new one,
`source_rfq_id`; the columns before it are the same, in the same order.

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
payment that was never paid, are plain updates and deletes as well.
`cash-receipts.ts` calls `finance_save_cash_receipt` and
`finance_post_cash_receipt`, and voids and deletes a receipt, each after
asking `finance_cash_receipts` whether the payment is one. `expenses.ts`
calls `finance_save_expense`, approves and rejects an expense with one
update of `status`, and deletes one. `expense-payment.ts` calls
`finance_record_voucher`, for one approved expense, paid now, and for nothing
else. No function of `src/lib/finance/` records a voucher for a category,
schedules one, or approves or rejects a payment: `cash-book.ts`
only reads, and each of those writes arrives
with its form. The other voids and deletes that exist are those of Payments
In, Payments Out and Refunds, and reach only what those screens show.

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
| `FIN11` | The bill, invoice, quotation, credit note or payment no longer exists. `finance_post_invoice`, `finance_send_quotation`, `finance_convert_quotation` and `finance_issue_credit_note` also answer this to a viewer: each locks its row first, and a viewer may not, so to them it is not there. Five receipt functions (`finance_review_receipt`, `finance_attach_receipt`, `finance_detach_receipt`, `finance_receipt_to_expense`, `finance_receipt_to_bill`) answer it when the receipt no longer exists, or is another workspace's; a viewer of the same workspace is answered it too, because under the writer-only policies the functions see no row |
| `FIN12` | The invoice has a credit note that is a draft or issued, so it cannot be voided. `invoices.ts` words it: "This invoice has credit notes. Void them on Credit Notes, or delete the drafts, before voiding it." |
| `FIN13` | The quotation already has an invoice that is not void: it cannot be converted again, and its answer can no longer change. `quotations.ts` words it |
| `FIN14` | Approval. Only an owner or admin approves or rejects an expense or a payment; a payment is submitted for approval only from a draft and rejected only before it is approved; money out that settles no document needs one of them before it is scheduled or paid; a payment waiting for approval, or rejected, cannot be changed; a rejected payment is final; an approved payment is paid as it was approved, with nothing but its status, number and date changing. Also: `approved_by` and `approved_at` on a payment or an expense are written by the database, and an update from a signed-in person that changes either by hand is this code, unless an earlier rule refuses it first (`FIN09` on a posted or void payment, `FIN01` on an approved or rejected expense whose status is left as it was); a scheduled payment out that nobody approved cannot be raised above its split, or made from scheduled money in, by someone who is not an owner or admin, and its split cannot be deleted or lowered below the payment by any signed-in person. Also a member's post or void of a cash receipt: Cash Receipts offers a member no Post and no Void, and if one is sent anyway the action answers "Only an owner or admin can post, pay or void. Ask one of them to do this." before reading or writing, and the database answers this code and uses up no number. Only an owner or admin unties a receipt from an approved expense or a posted bill. |
| `FIN15` | A receipt, a voucher or an expense names the wrong thing: a receipt is for invoices or for an income category, a voucher for expenses or for an expense category, never both and never neither; a receipt for invoices that is being posted must be exactly its split and carry no category; an expense needs an expense category of its own workspace. `cash-receipts.ts` words it for a receipt: "A receipt needs either invoices that add up to its amount, or an income category that still exists. Edit it and try again." The voucher and the expense meet it with their forms |
| `FIN23` | A receipt's state does not allow it: it starts in review, tied to nothing; it does not move to another workspace; its file, name, type, size, uploader and upload time do not change; a matched receipt is untied before it is deleted (the guard, for any delete), and `finance_attach_receipt`, `finance_receipt_to_expense` and `finance_receipt_to_bill` refuse a receipt that is already matched. A plain update of `expense_id` or `bill_id` by a writer is allowed by the grants, and the guard moves the receipt to the new document (with `FIN14` when it leaves an approved expense or a posted bill and the writer cannot decide). `receipt-inbox.ts` words it for deleting a matched receipt. |
| `FIN24` | The file of a receipt: there is none; it is not in the bucket; it was uploaded more than 30 minutes ago or is waiting to be removed; it is already a receipt; it is not the type its name says; its path names none of the five types. `receipt-inbox.ts` words it for recording an upload. |
| `FIN25` | A void bill takes no receipt. `receipt-match.ts`: "A void bill takes no receipt. Choose another bill." |
| `FIN28` | A payment that has left draft is held still (`20261117090000`): none of its direction, account, date, amount, method, reference, payee, category or notes changes (the date may, as a scheduled payment is marked paid); it does not go back to draft, whoever asks; and its split is not added to, taken from, moved or edited. Raised only for a scheduled payment nobody had to approve: every other payment that is not a draft answers `FIN09` or `FIN14` first. `result.ts` has a sentence for it (`HELD_STILL`); no data layer lists it, because no write of the app can meet it. |
| `FIN30` | An account with payments still to be paid or waiting for approval is not archived. `bank-accounts.ts`: "This account has payments that are still to be paid or waiting for approval. Pay, reject or delete them, then archive it." (`FIN14` on an account is an opening balance from someone who is not an owner or admin, or an owner who has not given their second factor: "Only an owner or admin can set or change an opening balance. If you are one, sign in again with your second step." The guard counts payments in both directions; the screen's archive question warns about money out only.) |
| `FIN37` | Money does not move on an archived account: a payment is not started on one, moved onto one, or sent for approval, approved, scheduled, posted or marked paid while its account is archived. `result.ts` has the one sentence (`ACCOUNT_ARCHIVED`), which `money.ts`, `refunds.ts` and `cash-receipts.ts` each list in their own map; `transfers.ts` words it as it words `FIN16`. A member recording a payment in, a refund or a paid-now payment out on an archived account is answered `FIN37` (the draft is refused before the sign-off rule), where before this rule they were answered `FIN14`; posting, approving and marking paid by a member still answer `FIN14`. |

`FIN23`, `FIN24` and `FIN25` are not the Receipts Inbox's alone. The ledger
migrations (`20261108091500` to `20261108094500`) raise `FIN23` to `FIN27` with
meanings of their own, for journals and a bill's category, and are not in this
table yet. A code is read by the function that made the call, so each data
layer words the codes its own functions can answer; a sentence for one of these
codes must never go in a map that both share.

For an RFQ's link to the RFQ it was copied from, the RFQ guard raises two of
the codes above, and `rfqs.ts` words them. `FIN11`: the RFQ a new RFQ names
is not there to copy. It was deleted, or it is another workspace's, or the
caller may not read it, or the new RFQ names itself; all are answered alike.
On saving a new copy
`rfqs.ts` says "The RFQ this was copied from can no longer be found. Save
again to keep this one on its own.", and the form drops the link; any other `FIN11`
on an RFQ stays "That RFQ no longer exists." `FIN01`: the link was changed
after it was set, cleared by hand or pointed at the RFQ itself included.
`rfqs.ts` has the RFQ's `FIN01` sentence for it, but no screen can reach it,
because `finance_save_rfq` does not write the link when a draft is saved
again.

| Code | Meaning (continued) |
|---|---|
| `42501` | Row-level security refused the write: "You do not have permission to make changes here." |
| `22003` | A number does not fit its column (quantity × unit price can overflow): "That amount is too large." An expense's amount or SST of `Infinity` answers it too (the schema refuses it first). |
| `22023` | `finance_record_refund` was given a status other than `posted` or `scheduled`. The app always sends one of the two, so only a direct call reaches it; `refunds.ts` has no sentence for it. `finance_attach_receipt` answers it when it is given neither an expense nor a bill, or both: a receipt is tied to exactly one. |
| `23514` | A check constraint refused the write. The one to know: an invoice's number must match its status (a draft has none, any other status has one, a posted invoice has `posted_at`); a quotation's and a credit note's number follow the same rule. Only a direct write can break it; the app never does. Others include the due date before the invoice date, a quotation valid until before its date, a line's quantity, price or SST rate out of range, a credit note of nothing, a refund reason outside the five, and an allocation naming more than one document, or none; `invoices.ts` has no sentence for them. One has a sentence: e-Invois set on a draft, which `setEInvoice` words as "e-Invois details can be recorded once the invoice is posted." Receipts: the table's checks refuse an amount that is not above zero or is NaN, an SST above the amount or below zero or NaN, a vendor longer than 200 characters, a file name with a slash, a backslash or a control character or longer than 200, a path outside the receipt's own workspace or of no known shape, and a receipt tied to two documents or a status that disagrees with its tie; `finance_receipt_to_expense` also answers it for an amount or SST of NaN. Not worded yet: no button reaches them. |
| `22007`, `22008`, `22P02` | A date or a number that cannot be read: the receipt functions cast `details` and `expense` with `::date` and `::numeric` (`finance_set_receipt_extraction`, `finance_review_receipt`, `finance_receipt_to_expense`), so an unparsable `receipt_date` is `22007`, an out-of-range one such as `2026-13-45` is `22008`, and a bad `amount` or `sst_amount` is `22P02`. The schemas of the parts that call them must refuse these first. |
| `23502` | A required value is missing: `finance_register_receipt` without a `name` (or with a `path` that is missing or empty), since the table does not accept a null file name or path. The schema of the part that calls it must refuse this first. |
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
just voided included. `FIN09` on voiding a payment in is "This payment cannot
be voided as it now stands: it has already been voided, or it is still a
draft.": the first for the same reason, the second for a draft receipt against
invoices sent to `voidPaymentIn` by a direct call. A receipt has three
sentences for the code, by what was being done (`CASH_RECEIPT_MESSAGES`:
`locked` for a save or a post, `cannotVoid`, `cannotDelete`). Bills and
payments out still say "Void it instead."; see Known limits.

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

Banking adds two codes. `FIN16` is a
transfer: it is between two different, active accounts of the workspace and
has an amount; a payment does not join or leave a transfer; once a side is
posted, a transfer is two matching sides. `transfers.ts` words it for the one
case its schema leaves ("One of those accounts has been archived or no longer
exists. Choose another, then try again."). `FIN17` has no sentence yet; it is a statement: an import
has between 1 and 1,000 lines; a line starts unmatched and only its match
changes; it is matched to a posted payment of its account, direction and
amount; a matched line is unmatched before it is deleted; an import stays
with its account. Banking reuses `FIN14` (recording or voiding a transfer
needs an owner or admin), `FIN11` (the transfer no longer exists, or is not
the caller's to void), `FIN09` (only a posted transfer is voided), `42501`
(`finance_record_transfer` called by someone who may not write in the
workspace; a statement imported by one; and any direct write by a signed-in
person that names a payment's `number`, so posting two sides by hand),
`23505` (a second line on one payment, or a third side on a transfer),
`23514` (a line with money in and money out, or neither; an amount of NaN on
a payment or a line; a payment posted with no number; a draft side of a
transfer given a number, which only the database owner can now try), `23503`
(a statement for an account that is not the workspace's) and `23502` (a line
with no date).

## Known limits

- Payment Vouchers: a voucher that waits or is "To be paid" can be deleted by
  any writer, whoever recorded or approved it: the guard on payments refuses a
  delete only once the payment is paid or void. An approved voucher cannot be
  marked paid on Payment Vouchers yet (part 5d-2).
- Payment Vouchers: approval of a supplier payment is a choice. A member can
  still schedule one on Payments Out with no approval, so the Approve step is
  a second look for those who ask for one, not a control on those who do not.
- Payment Vouchers: through the app a voucher for bills is always paid to the
  bills' supplier for exactly its split (`finance_save_voucher` sets both). By
  a direct update a writer can re-point a draft's payee, or raise its amount
  above its split, while it is still a draft (a draft is freely editable; the
  hold of `FIN28` begins when a payment leaves draft), and no rule looks again
  when it is sent or approved. The approver's question shows the payee, the
  amount and the bills' numbers as they then are.
- Payment Vouchers: sending a draft from its row is matched on the row's
  fields, not on its bills: a draft's split can be changed by any writer until
  it is sent. From then on nothing of it can change (`FIN09` for its split,
  `FIN14` or `FIN28` for its fields).
- Payment Vouchers: an owner's or admin's draft is not approved by saving it;
  it is sent for approval and approved from its row, in two steps.
- **A payment that is to be paid is held still as a row, not as an intention**
  (`20261117090000`). Anyone who may write can still delete a payment that
  is to be paid and record another in its place, for another amount or on
  another account, which is what Payments Out, Refunds and Payment Vouchers
  offer. The new row says who made it and when (`created_by` and `created_at`
  are the database's), and paying it is still an owner's or admin's.
  `finance_mark_payment_paid` still
  compares nothing with what the person was shown: it does not need to while
  the row cannot change between the list and the click, and a payment deleted
  and recorded again has another id. Whether a voucher for bills names the
  bills' supplier and is exactly its split is still only what the functions
  write, not something the database asks when it is sent for approval. A
  session with no signed-in user (a migration, the SQL editor) is not held.
  A change of `transfer_id` together with a held column on a scheduled payment
  is answered `FIN28` now, where `FIN16` answered it before, because the new
  trigger sorts first. The migration is applied as one call: it takes its table
  locks with `nowait`, so behind a payment writer, or an autovacuum of either
  table, it fails at once with `55P03` and nothing is created; send it again.
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
- A payment form left open while its account is archived is refused when it
  is sent (`FIN37`), and so is posting a draft whose account was archived
  since: the person restores the account or picks another. The forms do not
  say an account is archived before that, except that a draft's own archived
  account is still listed in its picker. The balance of an archived account
  still shows on Banking while it is not zero.
- A payment that was scheduled or waiting for approval on an account before
  `20261116110000` and whose account had been archived by a direct write is
  not approved or marked paid until the account is restored. The archive rule
  (`FIN30`) has refused such an archive since `20261114110000`, so none is
  expected.
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
  It is made, changed, posted and deleted on Cash Receipts. Payments In
  offers nothing on such a row, and shows it under the status "All" only.
- Nothing on Invoices says what a draft receipt holds of an invoice (the
  payment forms do, under each invoice), and nothing on a draft receipt's row
  says when its invoice was credited since and no longer owes what the draft
  holds.
- A receipt against invoices can be voided on Payments In or on Cash
  Receipts. A receipt for income can be voided on Cash Receipts only.
- Anyone who may write can change or delete any draft receipt, whoever saved
  it. `created_by` stays the person who first saved it, and nothing records
  who posted it. Two people saving the same draft at once: the later save
  replaces the earlier, with no warning.
- A draft receipt keeps the date it was given when it is posted later:
  posting does not move it to the day it is posted. The Post question shows
  the date.
- A draft receipt stays in the table in every period; once posted it is
  listed by its date, so posting a draft dated outside the chosen period
  takes it out of the table until a longer period is chosen. The screen says
  so when it happens, from the form's "Post receipt" and from a row's Post
  ("Receipt RC-0012 dated 30 Oct 2026 was posted. It is outside this month:
  choose a longer period to see it."; never for All time, which holds every
  date). It says too when a posted receipt is hidden by the Draft or Void
  status filter, and when a receipt is voided and the filter is "All except
  void" or Posted ("Receipt RC-0012 was voided. Choose Void in the status
  filter to see it."). A draft saved with a date outside the period needs no
  note: drafts show in every period. A draft is hidden by the Posted or Void
  status filter, by search text, or by the ten-row limit until "View all", and
  no note is given then (saving a draft is not posting it). A receipt just
  posted or voided that search text or the ten-row limit hides gets the note
  too ("Receipt RC-0012 was posted. Clear the search or choose View all to see
  it."). The note is worked out each time the screen draws, from the rows
  listed then, so changing the period, the filter or the search updates or
  removes it; Close and the next action remove it too.
- Categories cannot be added, renamed or archived from the app yet: every
  workspace has the ten it started with until the Categories card on Expenses
  is built. The database is ready for it: only an owner or admin may change
  one.
- A category name that ends in a tab, or is made of a newline, is accepted:
  the rule trims spaces only (`finance_categories_name_check`).
- An expense whose typed vendor is an empty string can be made only by a
  direct write to the table, and paying it records a voucher to nobody. A
  later rule should refuse an empty vendor name.
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
- Payment Vouchers is read-only. A voucher that is not a supplier payment or
  a refund exists only in the demo workspace until its form is built, with
  one exception: "Mark paid" on Expenses records a voucher for one approved
  expense, paid now. That voucher shows on Payment Vouchers and cannot be
  voided from the app until Payment Vouchers has its row actions: until then
  a wrong "Mark paid" is undone only in the database, by an owner or admin
  (`update finance_transactions set status = 'void'`).
- A member is offered nothing on an approved expense: scheduling a payment of
  it is the voucher form's.
- A payment from an account archived after the Mark paid card was opened is
  refused by the database (`FIN37`), and the card shows the shared sentence
  for it: "The account this is on has been archived. Restore it on Banking, or
  use another account, then try again." The card offers active accounts only.
- Two part payments of one expense made at the same moment that together fit
  what is left both go through: the database checks each payment against what
  is left when it runs (`FIN05`), so too much together is refused, but a
  deposit paid twice for a total that has room for both is not caught. The
  second person finds the list changed once it refreshes.
- Any writer may change or delete any pending or rejected expense, whoever
  entered it: the database does not look at `created_by`, and neither does
  the screen.
- An owner or admin who saves over someone else's pending expense approves
  it. To change it and leave it waiting is not possible for them.
- A rejection carries no reason: the table has no column for one.
- Two people changing one expense at once: the later save wins without a
  warning. An expense approved meanwhile answers that it is locked.
- An expense's `id` and `org_id` can still be chosen by whoever inserts it,
  and `approved_by` and `approved_at` are still granted to the
  `authenticated` role: the guard, not the grants, refuses a hand-written
  value there.
- A decision on an expense, and a payment of one, do not compare the names
  shown: a contact renamed after the screen was drawn is approved or paid
  under its new name. (A category can no longer be renamed by a member.)
- An expense's category can be one that was archived since; the form keeps
  it in its picker for that expense only. `finance_save_expense` accepts an
  archived expense category from a direct call, for a new expense too: it
  checks the category's kind, not whether it is active. Categories have no
  screen yet, and only an owner or admin can archive one.
- A rejected expense that a voided payment still names cannot be deleted
  (the allocation's foreign key); it stays in the list.
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
- Banking can add and change accounts and move money between them, but no
  statement can be imported until its form is built; the database function is
  there and nothing calls it. A statement exists only in the demo workspace.
- Only an owner or admin can record a transfer between accounts, and only an
  owner or admin can void one. Nothing waits for approval: anyone else is
  refused (`FIN14`), and a member has no way to ask for either and is shown
  neither.
- A voided transfer is on no screen but the ledger's: Banking's table lists
  posted movements only. A transfer cannot be edited, and no other row of
  that table has a menu or a link to the screen that recorded it.
- A transfer's date is not restricted: a future date moves both balances at
  once, as it does for any payment.
- `finance_account_balances` has no account number. A writer reads account
  numbers with `finance_account_numbers(target_org)`; a viewer cannot read
  them at all. The Banking loader calls that function for a writer only.
- `finance_record_transfer` runs as its owner, so row-level security does not
  check what it does: its own first test (may the caller write in
  `target_org`) and the workspace named in each of its statements do. A
  change to it must keep both. The same is true of the six functions that
  number a payment and of `finance_next_number`.
- A bank charge recorded by someone who is not an owner or admin waits for
  approval, though the bank has already taken the money.
- An account's balance counts every posted movement, whatever its date. The
  opening date is a label. A movement dated before it still counts.
- A movement is reconciled only by a statement line matched to it. Cash
  accounts, and bank accounts that have never had a statement imported, show a
  dash instead of a reconciliation status, and the "Reconciled" and
  "Unreconciled" filters leave those rows out. One bank line that covers two
  payments, or two lines for one payment, cannot be matched.
- The same statement can be imported twice; nothing warns.
- Sides of a transfer that are all drafts are not checked: a direct write can
  leave a lone draft side. It moves no money, shows on no screen, and cannot
  be posted.
- Banking loads every movement and filters in the browser. The running
  balance orders two movements on one day by when they were recorded, which
  need not be the order the bank had them in.
- The reconciliation gauge counts posted movements dated in the current month
  on bank accounts that have had a statement imported. It reads 99% while one
  is unmatched and 1% while one is matched, however close the figures are to
  all or none. The cash position chart is today's total with later
  movements taken back out, so a changed opening balance moves every month.
- No signed-in person can post the two sides of a transfer by hand: the
  number column is closed to them. The database owner still can (a migration
  or the SQL editor, as the demo seed does), may give the two sides any
  number, one another kind of payment already has included (`RC-0001`), and
  may use an archived account; the pair check is the only rule such a write
  meets. Rows are keyed by id, and no code looks a payment up by number.
- An opening balance is an owner's or admin's to set, change or remove, but
  no record is kept of a change: the account's `updated_at` moves and nothing
  says what the balance was before or who changed it.
- Any writer may rename, archive or restore any account, an owner's included,
  and two people editing one account at once: the later save wins.
- A bank account and its ledger account are kept in step one way only: a
  rename, archive or restore of the bank account is followed by the ledger
  account, but a rename or archive done to the ledger account in the Chart of
  Accounts leaves the bank account as it was. Sign-up gives the seeded
  accounts no opening balance, and must keep doing so: the guard would refuse
  one (`FIN14`), because the new user is not yet an owner while the seed runs.
- An account's kind cannot be corrected once it is added. An account made as
  the wrong kind is archived (or deleted by hand if nothing used it) and
  added again.
- The 1,000-line limit is the import function's, not the tables': a direct
  insert can add more lines to an import. Nothing reads the count for a rule.
- An account, a category and a contact that nothing refers to can still be
  moved to another workspace by someone who writes in both; the two
  statement tables refuse it.
- The database tests for Banking, `tests/bendahara-banking.test.ts`, run
  against the hosted database as owners, with one member in one test and the
  demo's viewer in another. What an admin, an editor and a viewer may and may
  not do, at length, is proved by
  `supabase/tests/bendahara_banking_check.sql`, which needs every finance
  migration up to `20261031090300` applied. Two parts of it run as the
  database owner with a person's id in the claims, because posting two sides
  by hand is no longer something a signed-in person can try.
- The Receipts Inbox uploads, opens, reviews, matches and deletes. Nothing
  reads a receipt with a model yet: `finance_set_receipt_extraction` is proven
  by `supabase/tests/bendahara_receipts_check.sql` and nothing in TypeScript
  calls it.
- Matching: a receipt matched while still in review keeps whatever its four
  details held, so a matched row can show dashes. The picker lists eight
  documents at a time and searches what the page loaded. An expense's row has
  no "Attach receipt" item: attaching starts from the receipt. Two people
  matching one receipt at the same moment: the second is told "This receipt is
  already matched. Untie it first." A receipt can stay matched to a rejected
  expense or a void bill until someone unties it; the second line under
  "Matched to" is what shows it. The inbox's loader reads every expense and
  every bill of the workspace once the inbox holds a receipt.
- The browser's check of a file's first bytes can be skipped by someone who
  calls the storage API themselves. Such a file is stored under one of the
  five types; the server's own check then refuses to open it, and it is never
  previewed. Nobody is shown it as a page: it is only ever a download.
- No virus scan. A PDF is opened by the person's own viewer.
- An upload refused by the bucket's rule says the workspace may be out of
  room or the person may no longer write: storage gives one answer for both.
- A second tab does not see what the first one added or deleted until it is
  reloaded. Closing or reloading the tab while files are on their way asks
  first; moving to another screen of the app does not, and the queue keeps
  going in the background. Files that were stored and not recorded are removed
  by the clean-up run.
- A JPG or PNG is uploaded as the person's device made it, so its metadata
  stays in it, a phone's location included. Only a HEIC that was converted to a
  JPG loses its metadata, because that JPG is drawn afresh from the pixels.
- There is no upload percentage, and a dropped connection fails that file;
  Try again then uploads it from the beginning (resumable uploads were left out
  on purpose).
- "Try again" on failed files can put more than twenty in the queue: a failed
  file does not count toward the twenty, and the retry does not ask for a
  place. Files still go one at a time and nothing is dropped.
- The download name on a signed link is added to the link by the client and is
  not covered by the link's signature: whoever holds a link can drop it, and
  storage then serves the file inline with its declared type. Nothing in the app
  relies on "a link is always an attachment" as a guarantee. What protects a
  file is that the bucket only stores the five declared types, none of which a
  browser runs as a page or script, and that it is served from the storage
  origin, where the app has no session.
- A signed-up member of the demo workspace (not a guest: an account the
  operator made a member) can review and delete the demo's sample receipts,
  as with every finance table. Uploading there is refused for everyone.
- An image larger than about 10 MB cannot be stored, so a preview fetches at
  most that; nothing makes thumbnails.
- `Permissions-Policy: camera=()` is sent on every page. "Take photo" is a
  file input that opens the phone's own camera app, which that policy does
  not govern; it is checked on a phone in the smoke test.
- The guard reads what the storage service writes about an object:
  `created_at`, and `metadata` (`size`, `mimetype`). If storage leaves
  `metadata` empty the receipt is recorded with no size and its type is taken
  from its extension alone. What is inside a file is not looked at by the
  database: a file is whatever the uploader's browser said it was, within the
  five types.
- Room (1 GB a workspace, 20 GB the bucket) is a soft limit: the upload rule
  is asked before the bytes are stored, so uploads in flight at the same moment
  can each pass, and the overshoot is the number of them times 10 MB.
- A member can untie a receipt from a pending expense or a draft bill while an
  owner's approval of that expense, or posting of that bill, is in flight, and
  both succeed: the guard reads the document's status without locking it. It is
  the same outcome as untying a moment before the approval. Locking the document
  in the guard would add a deadlock with "delete the pending expense".
- A stored type is the type the uploader declared (the `Content-Type` of the
  upload); the storage service and the database check that the extension, that
  type and the bucket's list agree, and the server reads the first bytes
  when the app opens the file (`storedFileCheck`), not when it is recorded.
- A signed link to a file is served by the storage service with the stored
  type and no `X-Content-Type-Options: nosniff` header (seen on the hosted
  project on 2026-10-12), so nothing tells a browser not to guess at the
  bytes. With a download name the link is served as an attachment. The part
  that lets a person open a file must therefore always ask for the download
  (or serve the bytes itself with `nosniff`), never link to the file inline.
- A deleted receipt's path cannot be recorded while it is waiting to be
  removed. Once the server has removed the file and taken the path off the list,
  the same name can be uploaded and recorded again: that is a new file.
- If the service key removes a file behind a receipt, the row stays with
  `has_file` true and its link fails. Nothing signed-in can cause it.
- `finance_expenses.amount` accepts `NaN` through `finance_save_expense` (on
  `main` before this stage); `finance_receipt_to_expense` refuses it itself. The
  expense table wants its own one-line constraint.
- Anyone who may write in a workspace can record a colleague's upload as a
  receipt during the 30 minutes after it was uploaded, if they learn its path.
  It is recorded in the same workspace either way.
- Someone who may write in workspace A and names a path under workspace B when recording a receipt is answered
  `FIN24` when no such file is there and `23514` when one is. A path is a random uuid, so there is nothing to
  guess; a check of the folder before the file is looked up would close it.
- A receipt stays matched to a bill that is voided afterwards (by an owner or
  admin: voiding is a sign-off). Nobody unties it for them.
- `extracted_at` and `extraction_error` are writable by anyone who may edit,
  directly as well as through `finance_set_receipt_extraction`: the function
  runs as the caller, so the columns cannot be closed without making it run as
  its owner, and it could then be called by hand all the same.
- `finance_set_receipt_extraction` stamps `extracted_at` for any reading given
  with no error, an empty one included. Whoever calls it (the reader, when it
  exists) must report a reading that found nothing as a failure.
- `finance_set_receipt_extraction` runs as the caller, like every finance
  function, so someone who may edit can call it by hand and a receipt would
  then read "Read by AI". The app only calls it with a model's answer.
- A HEIC or HEIF that could not be turned into a JPEG is stored as it is. No
  browser but Safari draws one, so it is a download, and it is not read by a
  model unless the configured model is known to take it.
- A bill made from a receipt is a draft with no number, so the inbox reads
  "Draft bill" until it is posted.
- The demo's receipts have no file.
- A file put in the bucket through the API and never recorded stays until
  the clean-up run takes it, an hour after its upload. That needs the
  operator's scheduler to call `/api/finance/receipt-cleanup`; until it does,
  only the file of a receipt deleted through the app is removed.
- A receipt that leaves review without a person's review (tied by
  `finance_attach_receipt`, or turned into an expense or a bill) stops saying
  "Read by AI", so a model's figures can sit on a matched row with no caution.
  Stage 7d makes this the usual path for an expense or a bill made from a
  receipt, where the person has just checked the figures in the form; for a
  plain attach nobody has. Stage 7c decides whether the caution should stay.
- The room limits (1 GB a workspace, 20 GB the bucket) add up every object in
  the bucket on each upload. That is one index scan today; it wants a stored
  total if the bucket grows to hundreds of thousands of files.
- The database tests for this stage run as owners only, and their owners are
  confirmed email users, not anonymous ones, because the bucket refuses
  anonymous accounts. They remove their own files; a run that is killed
  half-way can leave files in the bucket, which the clean-up run takes
  after an hour.
- An RFQ can be compared only with the RFQs copied from it, directly or
  through another copy, with Copy to another supplier after
  `20261116090000_bendahara_rfq_source`, and those copies with each other.
  RFQs copied before it, and RFQs typed separately for the same request, carry
  no link to each other, and nothing joins them afterwards.
- Compare quotes matches lines by unit and pack size as they were typed. A
  carton of 12 is not compared with singles: they are two rows, each with one
  price and no mark. `pcs` and `pc` are two rows as well; a capital or a
  stray space is not a difference.
- Deleting the first RFQ of a group, which only a draft allows, clears the
  link on its copies for good: they cannot be compared with each other
  after that. The delete question says so when RFQs were copied from the draft. A
  copy made afterwards from one of them starts a new group of those two.
- Viewers and the demo cannot open the comparison, although it only reads:
  `getRfqComparisonAction` answers a person who may edit, and the row menu it
  is opened from is drawn only for them.
- `20261116090000_bendahara_rfq_source` must be applied before this code is
  deployed. The RFQs list reads `source_rfq_id` from `finance_rfq_totals`,
  and without the column the screen does not load. The other order is safe:
  the code before it sends no link and reads the view's columns by name.
