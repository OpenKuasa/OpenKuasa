# Bendahara: full CRUD for Cash Book, Sales and Purchases

Date: 2026-10-10
Status: design, awaiting review

## Goal

Every screen under Cash Book, Sales and Purchases in Bendahara (`finance`) works
on the workspace's own data, with create, edit and delete. A signed-in workspace
can run its quotations, invoices, bills, expenses and cash through these screens
with no sample data left. Viewers see everything and change nothing. Signed-out
visitors keep seeing the sample data.

Screens in scope:

- Cash Book: Cash Receipts, Payment Vouchers
- Sales: Invoices, Quotations, Credit Notes, Payments In, Refunds
- Purchases: Expenses, Receipts Inbox, Supplier Bills, Payments Out, Banking
- Records, because the rest depend on them: Customers & Suppliers, Products

## Decisions

Made by the owner during brainstorming:

1. One spec covers all twelve screens; it is built in stages.
2. Money is entered once and shown on several screens.
3. Receipt auto-extraction and bank statement import are in scope. Submission to
   LHDN is not: e-Invois is a status a person sets.
4. Drafts can be edited and deleted. A posted document is locked and can only
   be voided.
5. Owners and admins approve expenses and payment vouchers.

Assumptions, to be corrected if wrong:

- A contact can be both a customer and a supplier.
- Expense categories are a per-workspace list, not the Chart of Accounts.
- Everything is in ringgit.
- SST is a rate per line, as on supplier bills today.
- There is no live bank connection.

## Where things stand

- Supplier Bills and Payments Out read real data (`src/lib/finance/purchases.ts`,
  migration `20261012160000_bendahara_purchases.sql`) but have no forms.
- The other ten screens are mock-ups with hard-coded arrays. No screen has a
  detail view, a form, row actions or line items.
- Existing tables: `finance_contacts`, `finance_products`, `supplier_bills`,
  `supplier_bill_lines`, `payments_out`, view `supplier_bill_totals`.
- `payments_out` holds only demo rows.

## Data model

Every new table follows the existing finance tables: `org_id` on every row,
composite `(org_id, id)` foreign keys, `numeric(14,2)` ringgit, `created_at` and
`updated_at`, select for members (`private.is_org_member`), writes for writers
(`private.is_org_writer`), the restrictive `mfa_required` policy, explicit
grants to `authenticated` and none to `anon`. New tables are prefixed
`finance_`.

### Shared records

- `finance_contacts` (changed): `type` is replaced by `is_customer` and
  `is_supplier` booleans, at least one true. Adds `tin`.
- `finance_products`: unchanged.
- `finance_accounts` (new): `name`, `kind` (`bank` | `cash`), `bank_name`,
  `account_no`, `opening_balance`, `opening_date`, `active`.
- `finance_categories` (new): `name`, `kind` (`expense` | `income`), `active`.
  A new workspace gets the categories shown in the mock-ups: Rent, Utilities,
  Marketing, Travel, Supplies, Salaries, Services.
- `finance_sequences` (new): one row per workspace per document type, holding
  `prefix` and `next_number`. Types: `invoice` (INV-), `quotation` (QT-),
  `credit_note` (CN-), `bill` (BILL-), `receipt` (RC-), `voucher` (PV-).
  A number is taken inside the database function that posts the document, under
  a row lock, so two people never get the same number and drafts leave no gaps.

### Documents

- `finance_quotations` + `finance_quotation_lines`: customer, date,
  `valid_until`, notes, `status` (`draft` | `sent` | `accepted` | `declined`),
  `accepted_at`. Expired is derived from `valid_until`.
- `finance_invoices` + `finance_invoice_lines`: customer, `invoice_date`,
  `due_date`, notes, `status` (`draft` | `posted` | `void`), `quotation_id`
  (the quotation it came from, if any), `einvoice_status` (`none` | `pending` |
  `validated` | `rejected`), `einvoice_uuid`.
- Lines on quotations and invoices match `supplier_bill_lines`: optional
  product, description, quantity, uom, unit price, SST rate, generated `amount`
  and `sst_amount`.
- `supplier_bills` + `supplier_bill_lines`: unchanged.
- `finance_credit_notes`: one invoice, `reason` (`returns` |
  `pricing_adjustment` | `overbilling` | `goodwill` | `other`), `amount`,
  notes, `status` (`draft` | `issued` | `void`).
- `finance_expenses`: `expense_date`, category, vendor (a contact or typed
  text), `amount`, `sst_amount`, notes, `status` (`pending` | `approved` |
  `rejected`), `approved_by`, `approved_at`, `created_by`.

### Money

- `finance_transactions` (new): one row per movement of money.
  - `direction` (`in` | `out`), `account_id`, `txn_date`, `amount`
  - `method` (`bank_transfer` | `fpx` | `duitnow` | `card` | `ewallet` |
    `cash` | `cheque`), `reference`
  - `number` (RC- for money in, PV- for money out), given on posting
  - `contact_id` or `party_name` for a payer or payee who is not a contact
  - `category_id` for money that settles no document
  - `status` (`draft` | `pending_approval` | `scheduled` | `posted` |
    `rejected` | `void`), `approved_by`, `approved_at`, `created_by`
  - `transfer_id` pairs the two sides of a transfer between accounts
- `finance_allocations` (new): splits one transaction across documents. Each
  row has `transaction_id`, `amount` and exactly one of `invoice_id`,
  `bill_id`, `expense_id`, `credit_note_id`. For refunds it also carries
  `reason`.
- `payments_out` is moved into these two tables and dropped.
  `supplier_bill_totals` is rewritten to read allocations.

What each screen shows:

| Screen | Rows |
|---|---|
| Cash Receipts | all transactions with direction `in` |
| Payment Vouchers | all transactions with direction `out` |
| Payments In | money in allocated to invoices |
| Payments Out | money out allocated to bills |
| Refunds | money out allocated to an invoice or credit note |
| Banking | every transaction, per account, with a running balance |

### Bank statements and receipts

- `finance_statement_lines` (new): `account_id`, `line_date`, `description`,
  `money_in`, `money_out`, `import_id`, `transaction_id` (the match). A line
  with a match is Reconciled.
- `finance_receipts` (new): `file_path`, `file_name`, `mime_type`, extracted
  `vendor`, `receipt_date`, `amount`, `sst_amount`, `status` (`review` |
  `matched` | `unmatched`), `expense_id` or `bill_id`, `extraction_error`.
- Storage: a private bucket `finance-receipts`, with objects under
  `<org_id>/...` and policies that check org membership for reads and writer
  role for writes.

### Derived values

Views with `security_invoker = true`, in the style of `supplier_bill_totals`:

- Invoice balance = total − posted money in allocated to it − issued credit
  notes + posted refunds allocated to it. Display status: Draft, Void, Paid
  (balance ≤ 0 and total > 0), Overdue (past `due_date`), otherwise Sent.
- Bill balance: as today, read from allocations.
- Account balance = opening balance + posted money in − posted money out.

Paid, Overdue and Outstanding are never stored.

### Rules the database enforces

- A posted or issued document cannot be updated or deleted; only its status can
  move to `void`. Enforced by triggers, not only by the app.
- A document with posted money allocated to it cannot be voided.
- An allocation cannot exceed the transaction amount in total.
- Only posted transactions change a balance.
- Approval: a transaction or expense created by an owner or admin is approved
  on saving. Otherwise it waits as pending, and only an owner or admin can
  approve or reject it. The check is in the database function, using the
  caller's role.

### Multi-row writes

Saving a document with its lines, posting with a number, recording a payment
with its allocations, and a transfer between accounts each run as one
`security invoker` database function, so a failure cannot leave half a record.

## Screens

### Common behaviour

- The layout of each mock-up is kept: KPI cards, charts and a table, calculated
  from the workspace's data. Period selectors work where the mock-up has one.
- Forms open as a card at the top of the page, closed by default.
- Each row has a "⋯" menu with the actions that apply to it.
- Delete and void are confirmed in the page, never with a browser dialog.
- Search and filters run in the browser over the loaded rows. "View all" shows
  the full list instead of the latest ten.
- Export downloads the filtered rows as CSV.
- Viewers get no buttons and no menus. The server actions check the role again.
- With no Supabase environment or no signed-in workspace, the sample view is
  shown with no actions.

### Records

- Customers & Suppliers: add, edit, archive. Delete is refused while documents
  exist.
- Products: add, edit, archive.
- Accounts are managed from Banking; categories from Expenses.

### Sales

| Screen | Actions | States shown |
|---|---|---|
| Quotations | New, edit draft, send, mark accepted or declined, convert to invoice, delete draft | Draft, Sent, Accepted, Declined, Expired |
| Invoices | New with line items, edit draft, post, record payment, issue credit note, set e-Invois status, void, delete draft | Draft, Sent, Paid, Overdue, Void |
| Credit Notes | New against an invoice, edit draft, issue, refund, void | Draft, Issued, Void |
| Payments In | Record payment against one or more open invoices; a payment in can only be voided (a posted document is locked: owner's decision, applied in stages 3a and 3b) | Received |
| Refunds | New against an invoice or credit note with a reason, mark paid out, delete | Pending, Refunded |

- "Sent" means posted. No email is sent.
- A part-paid invoice stays Sent or Overdue with a lower balance.
- Converting an accepted quotation creates a draft invoice with the same lines.
- The quotation funnel drops its "Viewed" step: nothing tracks a customer
  opening a quote.
- A pending refund is a transaction with status `scheduled`.

### Purchases

| Screen | Actions | States shown |
|---|---|---|
| Supplier Bills | New with line items, edit draft, post, pay, void, delete draft | Draft, Pending, Paid, Overdue, Void |
| Payments Out | Record payment against one or more open bills, schedule for a later date, mark paid, delete | Scheduled, Paid |
| Expenses | New, edit, approve or reject, mark paid from an account, attach receipt, delete | Pending approval, Approved, Rejected, Paid |
| Receipts Inbox | Upload by drag, browse or phone camera; review extracted details; create expense; attach to bill; delete | To review, Matched, Unmatched |
| Banking | Add or edit account, add transaction, transfer between accounts, import statement, match, reconcile | Reconciled, Unreconciled |

- An expense is Paid when posted money out is allocated to it.
- Receipts Inbox: JPG, PNG or PDF, up to 10 MB. Extraction uses the workspace's
  OpenRouter key through the existing BYOK path. With no key, or when
  extraction fails, the receipt lands in "To review" with empty fields.
  "Unmatched" means reviewed but not yet tied to an expense or bill.
- Banking: statement import reads CSV or Excel in the browser, proposes a
  column mapping, previews, and posts only the mapped columns, as the Contacts
  import does. Limit 1,000 lines per import. A line is matched to a posted
  transaction with the same account and amount within three days; a person
  confirms. An unmatched line can create the missing transaction.
- "Synced 2h ago" becomes "Last import" with a date.

### Cash Book

- Cash Receipts: New receipt (from whom, account, method, amount, and either
  the invoices it pays or an income category), edit draft, post, void.
- Payment Vouchers: New voucher (to whom, account, method, amount, and either
  the bills or expenses it pays or a category), submit, approve or reject, mark
  paid, void.

## Code

- Pattern: the Jebat one. Each write is one function in `src/lib/finance/` with
  a Zod schema, returning a result object; server actions in
  `src/app/(app)/finance/actions.ts` guard, parse, call it and revalidate.
  Chosen over the Kasturi form-data pattern because line items and split
  payments do not fit a flat form, and AI tools can reuse the schemas later.
- `src/lib/finance/`: `contacts.ts`, `products.ts`, `accounts.ts`,
  `categories.ts`, `sales.ts`, `purchases.ts`, `money.ts`, `banking.ts`,
  `receipts.ts`, plus view builders kept as pure functions.
- `src/screens/finance/<screen>.tsx`: a server loader that reads the data and
  passes actions only to writers.
- `src/components/finance/`: client views and shared parts: line-items editor,
  document form card, row menu, money input, contact, product and account
  pickers, allocation editor.
- Each screen is added to `src/config/live-screens.ts` when it goes live, and
  its path to the revalidate list.

## Errors

- Validation messages appear beside the form; typed values are kept.
- Database refusals become plain sentences, for example "This invoice has
  payments. Remove them before voiding it."
- A record changed or removed by someone else: the form says so and reloads.
- A failed extraction or an unreadable statement file never loses the upload.

## Testing

- Unit tests for every view builder and every schema.
- Database tests against the hosted project: workspace isolation and
  viewer-cannot-write on each new table; the locked-after-posting rule;
  numbering under two simultaneous posts; balances after part payments, credit
  notes and refunds; the approval rule; storage policies.
- A browser smoke test on prod with the smoke account after each merge.

## Build order

One pull request each. Every migration is dry-run on the hosted database,
applied before the code deploys, and each merge is smoke-tested.

1. Foundation: contacts change, accounts, categories, numbering, shared form
   parts. Customers & Suppliers and Products go live.
2. Money table: transactions and allocations, `payments_out` moved into them.
   Supplier Bills and Payments Out get full CRUD.
3. Sales core: Invoices and Payments In.
4. Sales follow-ons: Quotations, Credit Notes, Refunds.
5. Cash Book: Cash Receipts, Payment Vouchers, Expenses with approval.
6. Banking: accounts, transactions, transfers, statement import and
   reconciliation.
7. Receipts Inbox: storage, upload, extraction, review, create expense or
   attach to bill.

## Not in this spec

- Sending documents by email; printing or PDF.
- Submission to LHDN MyInvois.
- Live bank feeds.
- Currencies other than ringgit.
- Chart of Accounts, journals and the rest of the Analytics section.
- AI assistant tools for finance.
- The People product's own Payment Vouchers screen.

## Risks

- Size: about seven pull requests, each comparable to the Contacts or Deals
  work.
- Extraction accuracy on Malaysian receipts is unknown until tried. Every
  extracted receipt is reviewed by a person before it becomes an expense.
- Bank statement layouts differ per bank. The import maps columns by hand with
  guesses and hard-codes no bank's format.
- Overdue uses the database's date (UTC), so it flips at 08:00 Malaysia time,
  as it does for bills today.
