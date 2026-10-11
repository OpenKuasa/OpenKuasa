# Bendahara Invoices and Payments In Implementation Plan (stage 3a)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stage 3a of the Bendahara CRUD spec: sales invoices and money received against them exist in the database with the rules that lock a posted document, the data layer the invoice and payment forms will call is written and tested, and the Invoices and Payments In screens stop being mock-ups: they read the workspace's own data, read-only, with search, filters, "View all" and CSV export.

**Architecture:** One additive migration creates `finance_invoices` and `finance_invoice_lines`, lets a `finance_allocations` row point at an invoice instead of a bill, adds the views `finance_invoice_totals` and `finance_payments_in`, the guard triggers, and three `security invoker` functions that save, post and receive payment in one transaction. It replaces one live function, the allocation guard, with a version that handles bills exactly as before and invoices as their mirror. A second, data-only migration seeds the demo workspace. Both are applied to the hosted database before the code merges; production's current code is unaffected by either. TypeScript follows stage 2: one Zod schema and one function per write in `src/lib/finance/`, returning `FinResult`; pure view builders with unit tests; each screen a server loader plus a client view. What bills and invoices share is moved into two small shared files first, so nothing is copied.

**Tech Stack:** Supabase Postgres (RLS, plpgsql), Next.js 16.3 App Router (server components), React 19, Tailwind v4, shadcn/Radix, Recharts, Zod 4, Vitest (node, no DOM), pnpm.

**Spec:** `docs/superpowers/specs/2026-10-10-bendahara-crud-design.md`, build-order item 3, "Sales core: Invoices and Payments In". This plan is the first half (database, data layer, both screens live and read-only). The second half, stage 3b (the invoice form with line items, the payment form, row actions, the server actions, setting the e-Invois status), gets its own plan after this merges. Backend notes: `docs/bendahara-backend.md`. Earlier stages: `docs/superpowers/plans/2026-10-11-bendahara-money.md` (2a), `docs/superpowers/plans/2026-10-11-bendahara-bill-forms.md` (2b).

## Global Constraints

- New tables are prefixed `finance_`, carry `org_id`, use composite `(org_id, id)` foreign keys, `numeric(14,2)` ringgit, `created_at` and `updated_at`.
- Every table: select for `private.is_org_member(org_id)`, writes for `private.is_org_writer(org_id)`, the restrictive `mfa_required` policy, `revoke all … from anon, authenticated` then explicit grants to `authenticated`. Views are `security_invoker = true` with select granted to `authenticated` only.
- Database functions callable by the app are `security invoker` with `set search_path = ''` and every name schema-qualified; execute is revoked from `public` and `anon`.
- A posted document cannot be edited or deleted, only voided. A draft has no number; the number is given when it is posted. Guards never block deleting a workspace or a user. A direct INSERT cannot create a posted document, and a direct UPDATE cannot post an empty one.
- `org_id` always comes from the server-side context, never from client input.
- One Zod schema per write; messages are sentences a person can act on. Round first, then validate (`.transform(round).pipe(…)`). Every schema's transforms are idempotent, and every new schema is added to `tests/finance-schemas.test.ts`.
- A table row is keyed by a database id (an invoice's `id`, a payment row's `allocation_id`), never by a number that can be null or repeat. A payment split across several invoices is several rows with one `transaction_id`: amounts add up, the payment is counted once.
- "Is there anything to show" flags (`hasTrend`, `hasReceived`, `invoiceCount`) are worked out from the rows, never from a rounded chart series. Every chart and table has an empty state.
- `src/lib/finance/*.ts` must not import `@/lib/supabase/server`, `next/headers` or anything else server-only: client views import types and pure functions from them. `src/screens/finance/sales-sample.ts` is pure too.
- A `'use server'` file exports only async functions.
- Nothing in this stage writes from the browser: the two new views take no `writer`, no actions, and render no button or menu that changes data. Search, filters, "View all" and Export are included because they change nothing.
- Money is shown with `rm()` and `rmShort()` from `format.ts`. Payment method labels come from `PAYMENT_METHOD_LABELS` in `money.ts`; do not define a second map.
- No purple, violet, indigo or fuchsia anywhere. No Kuasa names in `src/`. Icons from lucide-react only.
- `BentoCard`'s `icon` prop is typed `LucideIcon`, but it draws the icon through `AnimatedIcon`, which returns nothing for a name that is not in its map. Pass `BentoCard` only these: `FileText`, `Wallet`, `Plus`, `Banknote`, `TrendingUp`, `ChartColumn`, `PieChart`. The mock-ups pass `Receipt`, which is not in the map; do not carry it over.
- Radix `SelectItem` throws at runtime for `value=""`. Every select here has a real default value (`'open'`, `'all'`, `'posted'`).
- This is Next.js 16.3. No Next API is used here beyond what `src/screens/finance/supplier-bills.tsx` already uses (an async server component as the screen's default export; `revalidatePath` in the existing actions file). If you reach for anything else, read the matching guide in `node_modules/next/dist/docs/` first.
- pnpm only. 2-space indent, single quotes, semicolons, named exports. The only default exports are the two screen files under `src/screens/finance/`, which Next's generated route files import by default.
- Vitest runs in node with no DOM: components have no unit tests. Everything that can be a pure function is one, in `src/lib/finance/`, with tests; components only draw.
- Every task leaves `pnpm exec tsc --noEmit`, `pnpm lint` and the unit tests green.
- Branch `feat-099-bendahara-invoices` (already cut from main and checked out; work on it, do not create another); PR title equals the branch name; do not push or merge until asked.
- **The hosted database is shared with production. Implementers never call a database tool, never change the schema, and never start a dev server or a browser.** The controller dry-runs each migration inside a rolled-back transaction and applies it only on the owner's explicit go-ahead.
- **Order is fixed:** Task 1's files are written and committed → the controller dry-runs and applies the schema migration (Task 1, steps 9 to 12) → Tasks 2 to 7 → the controller applies the seed any time after the schema (Task 1, step 13) → merge and deploy. The migration is additive, so production's current code keeps working once it is applied; the new code must not be deployed before it.
- **Database tests** (`tests/bendahara-*.test.ts`) run against the hosted project, skip themselves when `.env.local` is absent, and leave an anonymous user and a test workspace behind on every run. Run them only where a step says so. `tests/bendahara-sales.test.ts` cannot pass until the controller has applied the schema migration, and its last test not until the seed is applied; each later task says which of them it may run.

## Not in this stage

- **Forms and row actions** on Invoices and Payments In (new invoice with line items, edit draft, post, record payment, void, delete draft), the server actions for them, and the action that sets an invoice's e-Invois status: stage 3b. The column, the guard allowance and the data-layer functions are here; nothing calls the write functions yet.
- **`quotation_id` on invoices.** Quotations are stage 4; that stage adds the column with its foreign key when the table it points at exists.
- **Credit notes and refunds.** The invoice balance is total less posted money in. Stage 4 extends `finance_invoice_totals` (one marked line) and lets money out be allocated to an invoice.
- **Cash Receipts.** Money in that settles no invoice, drafts of money in, and income categories are stage 5. A payment in here always pays at least one invoice and is posted at once.
- **Receivable on Customers & Suppliers.** That screen keeps showing 0 for Receivable; wiring it to `finance_invoice_totals` is small but is its own change with its own tests, and is listed for the owner in Decisions.
- Approval of money (stage 5). Managing accounts (stage 6). Printing, PDF, email. Submission to LHDN. AI tools for finance.

## Decisions this plan makes (flag to the owner at handoff)

Each is a place where the plan goes beyond, or differs from, the design it was written to. Most consequential first.

1. **Invoice lines store their order (`position`); bill lines do not.** The design says invoice lines mirror `supplier_bill_lines` exactly, and bills order their lines by `created_at` then `id`. But every line of one save shares the same `created_at` (it is the transaction's time) and `id` is random, so that order is no order: a bill's lines can come back shuffled after an edit. An invoice is a document a customer reads, so `finance_invoice_lines` gets `position integer`, filled by `finance_save_invoice` from the order of the `lines` array, and `getInvoice` sorts by it. Bills are left as they are (changing them is outside this stage) and the gap is written into the backend note's known limits.
2. **The demo seed posts by plain UPDATE, not through the new functions.** `finance_post_invoice` and `finance_record_payment_in` take their numbers from `finance_next_number`, which refuses anyone who is not a signed-in editor of the workspace, and a migration has no signed-in user. So the seed inserts each invoice as a draft, adds its line, and posts it in one UPDATE that also sets its number (the guard's draft-to-posted branch allows exactly that, and still checks the total is above zero); each payment is inserted as a draft, split, then posted with its number. Nothing is disabled. The demo's counters are then moved past the numbers used (`INV-1043`, `RC-0109`).
3. **What the seed contains.** The nine invoices and eight receipts the mock-ups show, with these changes forced by the rules: the draft has no number (the mock-up showed `INV-1043`); the mock-up's "Pending" receipt of RM 1,000 becomes a posted part-payment of `INV-1041`, which therefore shows Sent with RM 2,500 owing; the three receipts that named invoices absent from the mock-up's invoice list (`INV-1030`, `INV-1032`, `INV-1033`) get those invoices, paid; six earlier monthly invoices, paid, give the eight-month charts a shape. 18 invoices and 14 receipts in all. Lim Hardware Sdn Bhd and Nusantara Logistics, already suppliers in the demo, are ticked as customers too rather than duplicated. Dates are relative to the day the seed runs.
4. **A new error code, `FIN08`:** "the contact has invoices, so Customer cannot be unticked". `FIN07` means the same for Supplier, but the data layer turns a code into one sentence, and "it has to stay a supplier" would be wrong here. `FIN08` was unused.
5. **A draft cannot carry an e-Invois status; a void invoice's cannot change.** The design says the status and reference may change on a posted invoice and nothing else. This plan adds a check constraint that a draft has `einvoice_status = 'none'` and no `einvoice_uuid` (a draft has not gone anywhere), and allows the change only while the invoice is posted, not after it is voided.
6. **The dry run makes its own workspace and people** instead of acting as an existing owner. `supabase/tests/bendahara_invoices_check.sql` creates an owner, an editor, a viewer and an outsider inside the transaction, acts as each through `request.jwt.claims` and `set local role authenticated` (the pattern of `supabase/tests/people_rls_check.sql`, which has run on the hosted project), and ends by deleting those users and the workspace. Nobody's real data is touched and a real user is never deleted, even inside a rollback. The stage 2a plan's dry run ran as the database owner and did not use this pattern.
7. **`finance_invoice_totals` lists its columns** instead of `i.*`, and works the balance out in one lateral (`v`), so stage 4 can `create or replace` it, changing that one line and adding columns at the end, without dropping the view.
8. **Quantity is `numeric(14,3)`,** as `supplier_bill_lines.quantity` actually is. The design text said `numeric(12,3)`; mirroring the bill column keeps the shared line schema's upper limit true for both.
9. **Shared code is moved, not copied, in Task 2.** `document-lines.ts` (the line schema, `isIsoDate`, `roundRate`, reading a saved line) and `view-helpers.ts` (`Stat`, `LATEST_ROWS`, `displayDate`, `todayUtc`, sums, the eight-month window, method groups and colours). `bills.ts` and `purchase-views.ts` re-export the names their importers use, so no other file changes and their tests pass unchanged. `listPaymentsOut` and the new `listPaymentsIn` share one private paging function.
10. **Money in has its own sentences, `RECEIPT_MESSAGES`,** because the same codes mean "bill" and "supplier" for money out and "invoice" and "customer" for money in. `voidPayment` is reused as it is: voiding is one status change on `finance_transactions` whichever way the money went, and the transaction guard never looks at the direction.
11. **Screen changes beyond "keep the layout":** the KPI cards are the four the design names (Total receivable, Due this week, Overdue, Received MTD) in place of the mock-up's invoiced/paid/outstanding/overdue; sparklines and hand-written deltas go, as they did on the purchases screens; the Invoices table gains a Due column (Overdue means little without it) and its customer filter lists the customers of the loaded invoices, by id; the header buttons "New Invoice" and "Record Payment" are removed until 3b gives them something to do.
12. **Payments In has a fourth card, "Average payment".** The design names three figures (received MTD, number of payments, share by method); the grid has four slots and the mock-up's fourth was the average. It is received MTD divided by the number of payments, each counted once.
13. **Payments In's status filter has three choices,** Received (the default), Void, All. Money in has no scheduled state.
14. **One shared sample file,** `src/screens/finance/sales-sample.ts`, feeds both screens when there is no database, so their figures agree with each other. A test checks every sample payment against its invoice.
15. **Both screen loaders read the same thing for every viewer.** There is no role check in them yet because there is nothing a role would unlock. The Invoices loader also reads payments in: "Received (MTD)" and the trend need them.
16. **Migration file names.** The two files are stamped `20261014100000` and `20261014100100` as the design asks. Three files for other products already carry later stamps (`20261015…`). This is harmless here: the hosted project records the moment a migration is applied, not the file's stamp, and a rebuild from files runs these after `20261013100000_bendahara_money.sql`, which they need, and before files that do not touch finance.
17. **Saving an invoice does not check the contact is ticked Customer,** exactly as saving a bill does not check Supplier. The forms will offer only customers. Once a contact has invoices, Customer cannot be unticked. Noted as a known limit.

## Review Focus

The cases most likely to hurt, each pinned by a test or by the controller's check.

1. **The allocation guard is a live production function, and this replaces it.** A bill must behave exactly as before: same checks, same order, same code first. Expected: `tests/bendahara-purchases.test.ts` passes unchanged after the migration; the check script pays, over-pays, schedules and voids a bill through the new guard; money in against a bill and money out against an invoice are both `FIN04`. (Task 1: check script, sections "a bill takes only money out…" and "the bill flow…"; `tests/bendahara-sales.test.ts`, "an invoice takes only money in…" and "a bill is still paid, held, over-paid and voided as before…".)
2. **Two people record the full payment of one invoice at the same moment.** Expected: exactly one succeeds; the other is told it is more than is still owed; the invoice reads paid once. (Task 1, `tests/bendahara-sales.test.ts`, "two full payments in at the same moment: only one goes through".)
3. **A workspace, or a user, is deleted while posted invoices and receipts exist.** Expected: both deletes go through; `created_by` is cleared on posted and void invoices and on posted payments; no finance row of the workspace is left. (Task 1, check script, its last two sections.)
4. **A posted invoice, written to directly.** Expected: `einvoice_status` and `einvoice_uuid` can change; any other column, alone or in the same update, is `FIN01`; an invoice cannot be inserted already posted, and an empty one cannot be posted by a plain UPDATE. (Task 1, `tests/bendahara-sales.test.ts`, "the e-Invois status and reference of a posted invoice can be set, and nothing else with them", "an invoice cannot be created already posted…", "an invoice needs a line…".)
5. **One payment split across three invoices, and a payment of one sen.** Expected: three table rows with three keys; the cards add the parts and count one payment; the average is per payment; the charts' empty states do not show while the sen exists, though the chart rounds it to nothing. (Task 5, `tests/finance-sales-views.test.ts`, "counts a payment split across three invoices once…", "are true for one payment of one sen this month…"; Task 1, "one payment in can cover two invoices of one customer…".)
6. **An exported CSV when a customer is called `=cmd|calc` or `Lim, Tan & Co`, and a draft with no number.** Expected: no formula runs, the comma does not split the column, the draft's number cell is empty and searching for "null" finds nothing. (Task 5, "writes the invoices table, with a formula-looking customer name made harmless", "does not match a draft on the word null".)

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/20261014100000_bendahara_invoices.sql` | Invoices, invoice lines, allocations to invoices, two views, guards, three functions |
| `supabase/migrations/20261014100100_bendahara_invoices_seed.sql` | Demo invoices and receipts; data only |
| `supabase/tests/bendahara_invoices_check.sql` | The controller's check: acts as owner, editor, viewer and outsider; always rolls back |
| `tests/bendahara-sales.test.ts` | Invoices, payments in and guards against the hosted database |
| `src/lib/finance/document-lines.ts` | What a bill and an invoice share: line schema, date and SST-rate rules, reading a saved line |
| `src/lib/finance/view-helpers.ts` | What the purchase and sales figures share |
| `src/lib/finance/bills.ts`, `src/lib/finance/purchase-views.ts` | (modified) use the two shared files; same exports as before |
| `src/lib/finance/invoices.ts` | Invoice schemas, reads, writes |
| `src/lib/finance/money.ts` | (modified) payment-in schema, read and write; shared paging |
| `src/lib/finance/contacts.ts` | (modified) sentence for unticking Customer on a contact with invoices |
| `src/lib/finance/sales-views.ts` | KPI figures, chart data, filters, status words and CSV rows for both screens |
| `src/screens/finance/sales-sample.ts` | Sample invoices and receipts for when there is no database |
| `src/components/finance/invoices-view.tsx`, `src/components/finance/payments-in-view.tsx` | Client views, read-only |
| `src/screens/finance/invoices.tsx`, `src/screens/finance/payments-in.tsx` | (replaced) server loaders |
| `src/config/live-screens.ts`, `src/app/(app)/finance/actions.ts` | (modified) both screens are live; a contact change refreshes them |
| `docs/bendahara-backend.md` | (modified) invoices, money in, guards, functions, error codes |
| `tests/setup/fake-finance.ts` | A stand-in Supabase client for data-layer tests that read |
| `tests/finance-shared.test.ts`, `tests/finance-invoices.test.ts`, `tests/finance-payments-in.test.ts`, `tests/finance-sales-views.test.ts`, `tests/finance-contact-paths.test.ts` | New unit tests |
| `tests/finance-schemas.test.ts`, `tests/finance-contacts.test.ts`, `tests/live-screens.test.ts` | (modified) more cases |

Names used across tasks, spelled once here:

- From `document-lines.ts`: `DOCUMENT_LINES_MAX`, `LINE_MESSAGES`, `isIsoDate`, `roundRate`, `isoDate`, `optionalText`, `documentLine`, `DocumentLineRow`, `DOCUMENT_LINE_COLUMNS`, `toDocumentLine`.
- From `view-helpers.ts`: `Stat`, `LATEST_ROWS`, `TREND_MONTHS`, `ELECTRONIC`, `METHOD_COLORS`, `displayDate`, `todayUtc`, `addDays`, `count`, `round2`, `sum`, `thousands`, `monthOf`, `lastMonths`, `paymentCount`.
- From `invoices.ts`: `INVOICE_LINES_MAX`, `INVOICE_PAGE_SIZE`, `INVOICE_MESSAGES`, `saveInvoiceInput`, `invoiceIdInput`, `InvoiceDisplayStatus`, `EInvoiceStatus`, `InvoiceListRow`, `InvoiceLine`, `InvoiceDetail`, `listInvoices`, `getInvoice`, `saveInvoice`, `postInvoice`, `voidInvoice`, `deleteInvoice`.
- New in `money.ts`: `PAYMENT_INVOICES_MAX`, `RECEIPT_MESSAGES`, `recordPaymentInInput`, `PaymentInRow`, `listPaymentsIn`, `recordPaymentIn`. Unchanged and reused: `voidPayment`, `paymentIdInput`, `PAYMENT_METHODS`, `PAYMENT_METHOD_LABELS`, `PaymentMethod`, `PAYMENT_PAGE_SIZE`.
- From `sales-views.ts`: `InvoicesViewData`, `PaymentsInViewData`, `INVOICE_STATUS_LABELS`, `EINVOICE_STATUS_LABELS`, `PAYMENT_IN_STATUS_LABELS`, `invoicesView`, `InvoiceFilter`, `filterInvoices`, `invoiceCustomers`, `invoicesCsv`, `paymentsInView`, `PaymentInStatusFilter`, `PaymentInMethodFilter`, `filterPaymentsIn`, `paymentsInCsv`.
- An invoice row's `display_status` is one of `draft`, `sent`, `overdue`, `paid`, `void`; the screen words `sent` "Sent". A payment-in row's `status` is `posted` when received; the screen words it "Received".

## Database error codes

Raised by the guards and functions with these SQLSTATEs. The same code is worded for a bill or for an invoice by the data-layer file that made the call. `FIN08` is new; the others gain the invoice meaning beside the bill meaning they had.

| Code | Meaning for an invoice or a payment in | Sentence |
|---|---|---|
| `FIN01` | The invoice is posted or void and cannot be changed or deleted; an invoice must be created as a draft; a draft cannot be voided; only a draft can be posted; the lines of a posted or void invoice are locked. On a posted invoice only `einvoice_status` and `einvoice_uuid` may change | `INVOICE_MESSAGES.locked` |
| `FIN02` | The invoice has payments (posted, scheduled or in progress), so it cannot be voided | `INVOICE_MESSAGES.hasPayments` |
| `FIN03` | The allocations add up to more than the payment | `RECEIPT_MESSAGES.overSplit` |
| `FIN04` | A payment can only go against a posted invoice, and only money in pays an invoice (only money out pays a bill) | `RECEIPT_MESSAGES.notPosted` |
| `FIN05` | The amount is more than is still owed on the invoice, counting payments that are posted, scheduled, draft or pending approval | `RECEIPT_MESSAGES.tooMuch` |
| `FIN06` | No invoice was chosen or found in the workspace, or the invoices belong to different customers | `RECEIPT_MESSAGES.oneCustomer` |
| `FIN07` | (unchanged) The contact has bills, so Supplier cannot be unticked | `CONTACT_MESSAGES.hasBills` |
| `FIN08` | The contact has invoices, so Customer cannot be unticked | `CONTACT_MESSAGES.hasInvoices` |
| `FIN09` | The payment is posted or void and cannot be changed or deleted, or its split cannot be changed; a payment that was never posted cannot be voided | `RECEIPT_MESSAGES.locked` |
| `FIN10` | The invoice has no lines, or its lines total nothing; it cannot be saved without a line or posted without an amount | `INVOICE_MESSAGES.empty` |
| `FIN11` | The invoice or payment no longer exists. `finance_post_invoice` also answers this to a viewer, who may not lock the row | `INVOICE_MESSAGES.gone`, `RECEIPT_MESSAGES.gone` |

---

### Task 1: Migration, seed, check script and database tests

**Files:**
- Create: `tests/bendahara-sales.test.ts`
- Create: `supabase/migrations/20261014100000_bendahara_invoices.sql`
- Create: `supabase/migrations/20261014100100_bendahara_invoices_seed.sql`
- Create: `supabase/tests/bendahara_invoices_check.sql`

**Interfaces:**
- Consumes (already in the database): `public.finance_contacts`, `public.finance_products`, `public.finance_accounts`, `public.finance_transactions`, `public.finance_allocations`, `public.finance_sequences`, `public.finance_next_number(target_org uuid, doc text) returns text` (which already answers `'invoice'` with `INV-` and `'receipt'` with `RC-`, so no sequence definition is added), `private.finance_seed_accounts(target_org uuid)`, `private.is_org_member`, `private.is_org_writer`, `private.mfa_ok`, the trigger `finance_allocation_guard` on `finance_allocations` and `finance_contact_guard` on `finance_contacts` (their functions are replaced; the triggers stay).
- Produces tables `finance_invoices`, `finance_invoice_lines`; column `finance_allocations.invoice_id`; views `finance_invoice_totals` and `finance_payments_in`.
- Produces functions:
  - `public.finance_save_invoice(target_org uuid, invoice jsonb, lines jsonb) returns uuid`
  - `public.finance_post_invoice(target_org uuid, target_invoice uuid) returns text`
  - `public.finance_record_payment_in(target_org uuid, payment jsonb, allocations jsonb) returns uuid`
- `finance_invoice_totals` columns: `id, org_id, customer_id, customer_name, invoice_no, invoice_date, due_date, notes, status, posted_at, einvoice_status, einvoice_uuid, created_by, created_at, updated_at, subtotal, sst, total, paid, balance, display_status`.
- `finance_payments_in` columns: `allocation_id, transaction_id, org_id, number, txn_date, method, amount, transaction_amount, status, reference, account_id, account_name, invoice_id, invoice_no, customer_name, created_at`.

**The implementer writes the four files and commits (steps 1 to 8). Steps 9 to 13 are the controller's and are not run by an implementer.**

Why the transaction guard is not in this migration: `private.finance_transaction_guard()` fires on update and delete only and never reads `direction`. A payment in is inserted as a draft, split, then updated to `posted` with its number, and later updated from `posted` to `void`; the guard already allows exactly those moves for any direction, and refuses the rest. No change is needed.

- [ ] **Step 1: Check the file names are free**

Run: `ls supabase/migrations | grep -c 2026101410`
Expected: `0`. (Files stamped `20261015…` exist for other products; that is expected, see Decision 16. If the count is not 0, stop and report: another migration has taken the stamp.)

- [ ] **Step 2: Write the database test**

Create `tests/bendahara-sales.test.ts`:

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

type Org = { c: SupabaseClient; orgId: string; bank: string; cash: string; customer: string; supplier: string };

async function anonUserWithOrg(orgName: string): Promise<Org> {
  const c = client();
  const { error: authErr } = await c.auth.signInAnonymously();
  expect(authErr, authErr?.message).toBeNull();
  const { data: orgId, error } = await c.rpc('create_org_for_current_user', { org_name: orgName });
  expect(error, error?.message).toBeNull();
  const { data: accounts } = await c.from('finance_accounts').select('id, name').eq('org_id', orgId);
  const bank = accounts?.find((a) => a.name === 'Main Bank')?.id as string;
  const cash = accounts?.find((a) => a.name === 'Cash in hand')?.id as string;
  const { data: customer, error: customerErr } = await c
    .from('finance_contacts')
    .insert({ org_id: orgId, name: `Customer of ${orgName}`, is_customer: true })
    .select('id')
    .single();
  expect(customerErr, customerErr?.message).toBeNull();
  const { data: supplier, error: supplierErr } = await c
    .from('finance_contacts')
    .insert({ org_id: orgId, name: `Supplier of ${orgName}`, is_supplier: true })
    .select('id')
    .single();
  expect(supplierErr, supplierErr?.message).toBeNull();
  return { c, orgId: orgId as string, bank, cash, customer: customer!.id as string, supplier: supplier!.id as string };
}

function daysFromToday(days: number) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const DESIGN = { description: 'Design work', quantity: 10, unit_price: 12.5, sst_rate: 6 }; // 125.00 + 7.50 SST = 132.50

async function saveInvoice(o: Org, lines: object[] = [DESIGN], extra: object = {}) {
  return o.c.rpc('finance_save_invoice', {
    target_org: o.orgId,
    invoice: { customer_id: o.customer, invoice_date: daysFromToday(0), due_date: daysFromToday(30), ...extra },
    lines,
  });
}

/** A posted invoice of RM 132.50. */
async function postedInvoice(o: Org, extra: object = {}) {
  const saved = await saveInvoice(o, [DESIGN], extra);
  expect(saved.error, saved.error?.message).toBeNull();
  const posted = await o.c.rpc('finance_post_invoice', { target_org: o.orgId, target_invoice: saved.data });
  expect(posted.error, posted.error?.message).toBeNull();
  return { id: saved.data as string, invoiceNo: posted.data as string };
}

function receive(o: Org, allocations: { invoice_id: string; amount: number }[], method = 'fpx') {
  return o.c.rpc('finance_record_payment_in', {
    target_org: o.orgId,
    payment: { account_id: o.bank, txn_date: daysFromToday(0), method },
    allocations,
  });
}

async function totals(c: SupabaseClient, invoiceId: string) {
  const { data, error } = await c
    .from('finance_invoice_totals')
    .select('invoice_no, subtotal, sst, total, paid, balance, display_status')
    .eq('id', invoiceId)
    .single();
  expect(error, error?.message).toBeNull();
  return data!;
}

/** A posted bill of RM 132.50, to prove the bill side still works beside invoices. */
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

/** A draft movement of money written straight to the table, as no screen does. */
async function strayTransaction(o: Org, direction: 'in' | 'out', amount: number) {
  const { data, error } = await o.c
    .from('finance_transactions')
    .insert({ org_id: o.orgId, direction, account_id: o.bank, amount, method: 'cash' })
    .select('id')
    .single();
  expect(error, error?.message).toBeNull();
  return data!.id as string;
}

let a: Org;
let b: Org;

beforeAll(async () => {
  if (!hasSupabaseEnv) return;
  a = await anonUserWithOrg('Sales A Sdn Bhd');
  b = await anonUserWithOrg('Sales B Sdn Bhd');
});

testWithSupabase('a draft invoice has no number, and saving it again replaces its lines in the order given', async () => {
  const saved = await saveInvoice(a);
  expect(saved.error, saved.error?.message).toBeNull();
  expect(await totals(a.c, saved.data)).toEqual({
    invoice_no: null, subtotal: 125, sst: 7.5, total: 132.5, paid: 0, balance: 132.5, display_status: 'draft',
  });

  const again = await a.c.rpc('finance_save_invoice', {
    target_org: a.orgId,
    invoice: { id: saved.data, customer_id: a.customer, invoice_date: daysFromToday(0), due_date: daysFromToday(14), notes: 'Changed' },
    lines: [
      { description: 'Zebra crossing paint', quantity: 2, unit_price: 5 },
      { description: 'Apple crates', quantity: 1, unit_price: 5 },
      { description: 'Mango pulp', quantity: 1, unit_price: 5 },
    ],
  });
  expect(again.error, again.error?.message).toBeNull();
  expect(again.data).toBe(saved.data);
  expect(await totals(a.c, saved.data)).toMatchObject({ total: 20, display_status: 'draft' });
  const { data: lines } = await a.c
    .from('finance_invoice_lines')
    .select('description, position')
    .eq('invoice_id', saved.data)
    .order('position', { ascending: true });
  expect(lines).toEqual([
    { description: 'Zebra crossing paint', position: 1 },
    { description: 'Apple crates', position: 2 },
    { description: 'Mango pulp', position: 3 },
  ]);

  const { error } = await a.c.from('finance_invoices').delete().eq('id', saved.data);
  expect(error, error?.message).toBeNull();
  const { data: left } = await a.c.from('finance_invoice_lines').select('id').eq('invoice_id', saved.data);
  expect(left).toEqual([]);
});

testWithSupabase('an invoice needs a line before it can be saved, and an amount before it can be posted', async () => {
  const none = await saveInvoice(a, []);
  expect(none.error?.code).toBe('FIN10');
  const free = await saveInvoice(a, [{ description: 'Sample', quantity: 1, unit_price: 0 }]);
  expect(free.error, free.error?.message).toBeNull();
  const posted = await a.c.rpc('finance_post_invoice', { target_org: a.orgId, target_invoice: free.data });
  expect(posted.error?.code).toBe('FIN10');
  // Behind the function too: a plain update cannot post it either.
  const sneak = await a.c.from('finance_invoices').update({ status: 'posted', invoice_no: 'INV-SNEAKY' }).eq('id', free.data);
  expect(sneak.error?.code).toBe('FIN10');
});

testWithSupabase('posting gives the invoice the next number and it shows as sent', async () => {
  const first = await postedInvoice(a);
  const second = await postedInvoice(a);
  expect(first.invoiceNo).toBe('INV-0001');
  expect(second.invoiceNo).toBe('INV-0002');
  expect(await totals(a.c, first.id)).toEqual({
    invoice_no: 'INV-0001', subtotal: 125, sst: 7.5, total: 132.5, paid: 0, balance: 132.5, display_status: 'sent',
  });
});

testWithSupabase('an invoice cannot be created already posted, and a draft cannot be voided or carry an e-Invois status', async () => {
  const direct = await a.c.from('finance_invoices').insert({
    org_id: a.orgId, customer_id: a.customer, invoice_no: 'INV-SNEAKY', due_date: daysFromToday(30), status: 'posted',
  });
  expect(direct.error?.code).toBe('FIN01');

  const draft = await saveInvoice(a);
  const voided = await a.c.from('finance_invoices').update({ status: 'void' }).eq('id', draft.data);
  expect(voided.error?.code).toBe('FIN01');
  const stamped = await a.c.from('finance_invoices').update({ einvoice_status: 'validated' }).eq('id', draft.data);
  expect(stamped.error?.code).toBe('23514');
});

testWithSupabase('a posted invoice cannot be edited, re-saved, given lines, deleted or posted again', async () => {
  const invoice = await postedInvoice(a);
  const edit = await a.c.from('finance_invoices').update({ notes: 'Sneaky' }).eq('id', invoice.id);
  expect(edit.error?.code).toBe('FIN01');
  const due = await a.c.from('finance_invoices').update({ due_date: daysFromToday(90) }).eq('id', invoice.id);
  expect(due.error?.code).toBe('FIN01');
  const resave = await a.c.rpc('finance_save_invoice', {
    target_org: a.orgId,
    invoice: { id: invoice.id, customer_id: a.customer, invoice_date: daysFromToday(0), due_date: daysFromToday(30), notes: 'Changed' },
    lines: [DESIGN],
  });
  expect(resave.error?.code).toBe('FIN01');
  const line = await a.c
    .from('finance_invoice_lines')
    .insert({ org_id: a.orgId, invoice_id: invoice.id, description: 'Extra', quantity: 1, unit_price: 1 });
  expect(line.error?.code).toBe('FIN01');
  const lineEdit = await a.c.from('finance_invoice_lines').update({ unit_price: 1 }).eq('invoice_id', invoice.id);
  expect(lineEdit.error?.code).toBe('FIN01');
  const remove = await a.c.from('finance_invoices').delete().eq('id', invoice.id);
  expect(remove.error?.code).toBe('FIN01');
  const again = await a.c.rpc('finance_post_invoice', { target_org: a.orgId, target_invoice: invoice.id });
  expect(again.error?.code).toBe('FIN01');
  const back = await a.c.from('finance_invoices').update({ status: 'draft' }).eq('id', invoice.id);
  expect(back.error?.code).toBe('FIN01');
  expect(await totals(a.c, invoice.id)).toMatchObject({ total: 132.5, display_status: 'sent' });
});

testWithSupabase('the e-Invois status and reference of a posted invoice can be set, and nothing else with them', async () => {
  const invoice = await postedInvoice(a);
  const set = await a.c
    .from('finance_invoices')
    .update({ einvoice_status: 'pending', einvoice_uuid: 'LHDN-TEST-1', updated_at: new Date().toISOString() })
    .eq('id', invoice.id)
    .select('einvoice_status, einvoice_uuid')
    .single();
  expect(set.error, set.error?.message).toBeNull();
  expect(set.data).toEqual({ einvoice_status: 'pending', einvoice_uuid: 'LHDN-TEST-1' });

  const withMore = await a.c.from('finance_invoices').update({ einvoice_status: 'validated', notes: 'Sneaky' }).eq('id', invoice.id);
  expect(withMore.error?.code).toBe('FIN01');
  const unknown = await a.c.from('finance_invoices').update({ einvoice_status: 'approved' }).eq('id', invoice.id);
  expect(unknown.error?.code).toBe('23514');
  const { data: row } = await a.c.from('finance_invoice_totals').select('einvoice_status').eq('id', invoice.id).single();
  expect(row).toEqual({ einvoice_status: 'pending' });
});

testWithSupabase('a posted invoice past its due date shows as overdue, until it is paid', async () => {
  const invoice = await postedInvoice(a, { invoice_date: daysFromToday(-40), due_date: daysFromToday(-10) });
  expect(await totals(a.c, invoice.id)).toMatchObject({ balance: 132.5, display_status: 'overdue' });
  const paid = await receive(a, [{ invoice_id: invoice.id, amount: 132.5 }]);
  expect(paid.error, paid.error?.message).toBeNull();
  expect(await totals(a.c, invoice.id)).toMatchObject({ balance: 0, display_status: 'paid' });
});

testWithSupabase('money received reduces the balance at once: part-paid stays sent, paid in full is paid', async () => {
  const invoice = await postedInvoice(a);
  const part = await receive(a, [{ invoice_id: invoice.id, amount: 100 }]);
  expect(part.error, part.error?.message).toBeNull();
  expect(await totals(a.c, invoice.id)).toMatchObject({ paid: 100, balance: 32.5, display_status: 'sent' });

  const { data: txn } = await a.c
    .from('finance_transactions')
    .select('direction, status, amount, contact_id, account_id, number')
    .eq('id', part.data)
    .single();
  expect(txn).toEqual({
    direction: 'in', status: 'posted', amount: 100, contact_id: a.customer, account_id: a.bank,
    number: expect.stringMatching(/^RC-\d{4}$/),
  });

  const rest = await receive(a, [{ invoice_id: invoice.id, amount: 32.5 }], 'cash');
  expect(rest.error, rest.error?.message).toBeNull();
  expect(await totals(a.c, invoice.id)).toMatchObject({ paid: 132.5, balance: 0, display_status: 'paid' });

  const { data: rows } = await a.c
    .from('finance_payments_in')
    .select('allocation_id, transaction_id, number, method, amount, transaction_amount, status, invoice_no, customer_name, account_name')
    .eq('invoice_id', invoice.id)
    .order('amount', { ascending: false });
  expect(rows).toEqual([
    {
      allocation_id: expect.any(String), transaction_id: part.data, number: expect.stringMatching(/^RC-\d{4}$/), method: 'fpx',
      amount: 100, transaction_amount: 100, status: 'posted', invoice_no: invoice.invoiceNo,
      customer_name: 'Customer of Sales A Sdn Bhd', account_name: 'Main Bank',
    },
    {
      allocation_id: expect.any(String), transaction_id: rest.data, number: expect.stringMatching(/^RC-\d{4}$/), method: 'cash',
      amount: 32.5, transaction_amount: 32.5, status: 'posted', invoice_no: invoice.invoiceNo,
      customer_name: 'Customer of Sales A Sdn Bhd', account_name: 'Main Bank',
    },
  ]);
  expect(rows![0].number).not.toBe(rows![1].number);
});

testWithSupabase('a payment in cannot be more than is still owed, to the sen', async () => {
  const invoice = await postedInvoice(a);
  const over = await receive(a, [{ invoice_id: invoice.id, amount: 132.51 }]);
  expect(over.error?.code).toBe('FIN05');
  const part = await receive(a, [{ invoice_id: invoice.id, amount: 100 }]);
  expect(part.error, part.error?.message).toBeNull();
  const second = await receive(a, [{ invoice_id: invoice.id, amount: 32.51 }]);
  expect(second.error?.code).toBe('FIN05');
  const exact = await receive(a, [{ invoice_id: invoice.id, amount: 32.5 }]);
  expect(exact.error, exact.error?.message).toBeNull();
  // A refused payment leaves nothing behind: no half-written movement of money.
  const { data: drafts } = await a.c.from('finance_transactions').select('id').eq('org_id', a.orgId).eq('status', 'draft');
  expect(drafts).toEqual([]);
});

testWithSupabase('two full payments in at the same moment: only one goes through', async () => {
  const invoice = await postedInvoice(a);
  const results = await Promise.all([
    receive(a, [{ invoice_id: invoice.id, amount: 132.5 }]),
    receive(a, [{ invoice_id: invoice.id, amount: 132.5 }]),
  ]);
  expect(results.filter((r) => r.error === null)).toHaveLength(1);
  expect(results.find((r) => r.error)?.error?.code).toBe('FIN05');
  expect(await totals(a.c, invoice.id)).toMatchObject({ paid: 132.5, balance: 0, display_status: 'paid' });
});

testWithSupabase('a payment in cannot go against a draft or a void invoice, or with no invoice at all', async () => {
  const draft = await saveInvoice(a);
  const onDraft = await receive(a, [{ invoice_id: draft.data, amount: 10 }]);
  expect(onDraft.error?.code).toBe('FIN04');

  const invoice = await postedInvoice(a);
  const voided = await a.c.from('finance_invoices').update({ status: 'void' }).eq('id', invoice.id);
  expect(voided.error, voided.error?.message).toBeNull();
  const onVoid = await receive(a, [{ invoice_id: invoice.id, amount: 10 }]);
  expect(onVoid.error?.code).toBe('FIN04');

  const none = await receive(a, []);
  expect(none.error?.code).toBe('FIN06');
});

testWithSupabase('a payment in cannot be edited or deleted, only voided; an invoice with money on it cannot be voided', async () => {
  const invoice = await postedInvoice(a);
  const paid = await receive(a, [{ invoice_id: invoice.id, amount: 132.5 }]);
  const edit = await a.c.from('finance_transactions').update({ amount: 1 }).eq('id', paid.data);
  expect(edit.error?.code).toBe('FIN09');
  const remove = await a.c.from('finance_transactions').delete().eq('id', paid.data);
  expect(remove.error?.code).toBe('FIN09');
  const split = await a.c.from('finance_allocations').update({ amount: 1 }).eq('transaction_id', paid.data);
  expect(split.error?.code).toBe('FIN09');

  const voidInvoice = await a.c.from('finance_invoices').update({ status: 'void' }).eq('id', invoice.id);
  expect(voidInvoice.error?.code).toBe('FIN02');

  const voidPayment = await a.c.from('finance_transactions').update({ status: 'void' }).eq('id', paid.data);
  expect(voidPayment.error, voidPayment.error?.message).toBeNull();
  expect(await totals(a.c, invoice.id)).toMatchObject({ paid: 0, balance: 132.5, display_status: 'sent' });
  // The voided payment still shows on Payments In, as void.
  const { data: rows } = await a.c.from('finance_payments_in').select('status').eq('invoice_id', invoice.id);
  expect(rows).toEqual([{ status: 'void' }]);

  const voidAgain = await a.c.from('finance_invoices').update({ status: 'void' }).eq('id', invoice.id);
  expect(voidAgain.error, voidAgain.error?.message).toBeNull();
  expect(await totals(a.c, invoice.id)).toMatchObject({ display_status: 'void' });
  const revive = await a.c.from('finance_invoices').update({ status: 'posted' }).eq('id', invoice.id);
  expect(revive.error?.code).toBe('FIN01');
});

testWithSupabase('one payment in can cover two invoices of one customer, but not two customers', async () => {
  const first = await postedInvoice(a);
  const second = await postedInvoice(a);
  const both = await receive(a, [{ invoice_id: first.id, amount: 132.5 }, { invoice_id: second.id, amount: 32.5 }]);
  expect(both.error, both.error?.message).toBeNull();
  const { data: txn } = await a.c.from('finance_transactions').select('amount, contact_id, direction').eq('id', both.data).single();
  expect(txn).toEqual({ amount: 165, contact_id: a.customer, direction: 'in' });
  expect(await totals(a.c, first.id)).toMatchObject({ paid: 132.5, balance: 0, display_status: 'paid' });
  expect(await totals(a.c, second.id)).toMatchObject({ paid: 32.5, balance: 100, display_status: 'sent' });

  // Two rows, one payment: the amounts add up to it, and each row has its own key.
  const { data: rows } = await a.c
    .from('finance_payments_in')
    .select('allocation_id, transaction_id, number, amount, transaction_amount')
    .eq('transaction_id', both.data);
  expect(rows).toHaveLength(2);
  expect(new Set(rows!.map((r) => r.allocation_id)).size).toBe(2);
  expect(new Set(rows!.map((r) => r.number)).size).toBe(1);
  expect(rows!.reduce((sum, r) => sum + Number(r.amount), 0)).toBe(165);
  expect(rows!.every((r) => Number(r.transaction_amount) === 165)).toBe(true);

  const { data: other } = await a.c
    .from('finance_contacts')
    .insert({ org_id: a.orgId, name: 'Another customer', is_customer: true })
    .select('id')
    .single();
  const theirs = await postedInvoice({ ...a, customer: other!.id });
  const mixed = await receive(a, [{ invoice_id: second.id, amount: 10 }, { invoice_id: theirs.id, amount: 10 }]);
  expect(mixed.error?.code).toBe('FIN06');
});

testWithSupabase('an invoice takes only money in and a bill only money out; an allocation names exactly one of them', async () => {
  const invoice = await postedInvoice(a);
  const billId = await postedBill(a);

  const out = await strayTransaction(a, 'out', 20);
  const outOnInvoice = await a.c
    .from('finance_allocations')
    .insert({ org_id: a.orgId, transaction_id: out, invoice_id: invoice.id, amount: 10 });
  expect(outOnInvoice.error?.code).toBe('FIN04');
  const both = await a.c
    .from('finance_allocations')
    .insert({ org_id: a.orgId, transaction_id: out, bill_id: billId, invoice_id: invoice.id, amount: 10 });
  expect(both.error?.code).toBe('23514');
  const neither = await a.c.from('finance_allocations').insert({ org_id: a.orgId, transaction_id: out, amount: 10 });
  expect(neither.error).not.toBeNull();
  const tooMuch = await a.c
    .from('finance_allocations')
    .insert({ org_id: a.orgId, transaction_id: out, bill_id: billId, amount: 20.01 });
  expect(tooMuch.error?.code).toBe('FIN03');

  const moneyIn = await strayTransaction(a, 'in', 20);
  const inOnBill = await a.c
    .from('finance_allocations')
    .insert({ org_id: a.orgId, transaction_id: moneyIn, bill_id: billId, amount: 10 });
  expect(inOnBill.error?.code).toBe('FIN04');
  const tooMuchIn = await a.c
    .from('finance_allocations')
    .insert({ org_id: a.orgId, transaction_id: moneyIn, invoice_id: invoice.id, amount: 20.01 });
  expect(tooMuchIn.error?.code).toBe('FIN03');
  // Money that was never received cannot be voided: it is deleted.
  const voided = await a.c.from('finance_transactions').update({ status: 'void' }).eq('id', moneyIn);
  expect(voided.error?.code).toBe('FIN09');

  for (const id of [out, moneyIn]) {
    const removed = await a.c.from('finance_transactions').delete().eq('id', id);
    expect(removed.error, removed.error?.message).toBeNull();
  }
});

testWithSupabase('a bill is still paid, held, over-paid and voided as before, beside an invoice that is not touched', async () => {
  const invoice = await postedInvoice(a);
  const billId = await postedBill(a);
  const pay = (amount: number, status: 'posted' | 'scheduled' = 'posted') =>
    a.c.rpc('finance_record_payment_out', {
      target_org: a.orgId,
      payment: { account_id: a.bank, txn_date: daysFromToday(0), method: 'fpx', status },
      allocations: [{ bill_id: billId, amount }],
    });
  const bill = async () => {
    const { data } = await a.c.from('supplier_bill_totals').select('paid, balance, display_status').eq('id', billId).single();
    return data;
  };

  const scheduled = await pay(100, 'scheduled');
  expect(scheduled.error, scheduled.error?.message).toBeNull();
  expect((await pay(32.51)).error?.code).toBe('FIN05');
  const paid = await pay(32.5);
  expect(paid.error, paid.error?.message).toBeNull();
  expect(await bill()).toEqual({ paid: 32.5, balance: 100, display_status: 'pending' });

  const voidBill = await a.c.from('supplier_bills').update({ status: 'void' }).eq('id', billId);
  expect(voidBill.error?.code).toBe('FIN02');

  // The two views stay apart: a payment out is not a payment in, and the invoice owes what it owed.
  const { data: outRows } = await a.c.from('finance_payments_out').select('bill_id').eq('bill_id', billId);
  expect(outRows).toHaveLength(2);
  const { data: inRows } = await a.c
    .from('finance_payments_in')
    .select('allocation_id')
    .in('transaction_id', [scheduled.data, paid.data]);
  expect(inRows).toEqual([]);
  expect(await totals(a.c, invoice.id)).toMatchObject({ paid: 0, balance: 132.5, display_status: 'sent' });
});

testWithSupabase('another workspace cannot see or touch invoices, their lines or payments in', async () => {
  const invoice = await postedInvoice(a);
  const paid = await receive(a, [{ invoice_id: invoice.id, amount: 10 }]);

  for (const table of ['finance_invoices', 'finance_invoice_lines', 'finance_invoice_totals', 'finance_payments_in']) {
    const { data } = await b.c.from(table).select('org_id').eq('org_id', a.orgId);
    expect(data ?? [], table).toEqual([]);
  }

  const save = await b.c.rpc('finance_save_invoice', {
    target_org: a.orgId,
    invoice: { customer_id: a.customer, invoice_date: daysFromToday(0), due_date: daysFromToday(30) },
    lines: [DESIGN],
  });
  expect(save.error?.code).toBe('42501');
  const post = await b.c.rpc('finance_post_invoice', { target_org: a.orgId, target_invoice: invoice.id });
  expect(post.error).not.toBeNull();
  // B's own workspace, A's invoice: the invoice is not found there.
  const theirs = await receive(b, [{ invoice_id: invoice.id, amount: 10 }]);
  expect(theirs.error?.code).toBe('FIN06');
  const { data: changed } = await b.c.from('finance_invoices').update({ status: 'void' }).eq('id', invoice.id).select('id');
  expect(changed ?? []).toEqual([]);
  const { data: voided } = await b.c.from('finance_transactions').update({ status: 'void' }).eq('id', paid.data).select('id');
  expect(voided ?? []).toEqual([]);
});

testWithSupabase('a customer with invoices cannot be deleted or stop being a customer', async () => {
  await postedInvoice(a);
  const remove = await a.c.from('finance_contacts').delete().eq('id', a.customer);
  expect(remove.error?.code).toBe('23503');
  const untick = await a.c.from('finance_contacts').update({ is_customer: false, is_supplier: true }).eq('id', a.customer);
  expect(untick.error?.code).toBe('FIN08');
  // Becoming a supplier as well is fine.
  const both = await a.c.from('finance_contacts').update({ is_supplier: true }).eq('id', a.customer);
  expect(both.error, both.error?.message).toBeNull();
});

testWithSupabase('a demo viewer cannot write an invoice, its lines or a payment in', async () => {
  const c = client();
  const { error: authErr } = await c.auth.signInAnonymously();
  expect(authErr, authErr?.message).toBeNull();
  const { data: demoId, error } = await c.rpc('join_demo_org');
  expect(error, error?.message).toBeNull();
  const { data: contacts } = await c.from('finance_contacts').select('id').eq('org_id', demoId).limit(1);
  const anyContact = contacts![0].id as string;

  const direct = await c
    .from('finance_invoices')
    .insert({ org_id: demoId, customer_id: anyContact, due_date: daysFromToday(30) });
  expect(direct.error?.code).toBe('42501');
  const save = await c.rpc('finance_save_invoice', {
    target_org: demoId,
    invoice: { customer_id: anyContact, invoice_date: daysFromToday(0), due_date: daysFromToday(30) },
    lines: [DESIGN],
  });
  expect(save.error?.code).toBe('42501');
  const line = await c
    .from('finance_invoice_lines')
    .insert({ org_id: demoId, invoice_id: crypto.randomUUID(), description: 'Viewer', quantity: 1, unit_price: 1 });
  expect(line.error?.code).toBe('42501');
});

// Needs 20261014100100_bendahara_invoices_seed.sql: until the controller has applied it, this one test fails.
testWithSupabase('a demo viewer reads the seeded invoices and payments in', async () => {
  const c = client();
  const { error: authErr } = await c.auth.signInAnonymously();
  expect(authErr, authErr?.message).toBeNull();
  const { data: demoId, error } = await c.rpc('join_demo_org');
  expect(error, error?.message).toBeNull();

  const { data: invoices } = await c
    .from('finance_invoice_totals')
    .select('id, invoice_no, customer_id, display_status, balance')
    .eq('org_id', demoId);
  // The seed's dates are relative to the day it ran, so Sent turns into Overdue as time passes: only what cannot drift is asserted.
  const statuses = new Set((invoices ?? []).map((i) => i.display_status));
  for (const status of ['draft', 'paid']) expect(statuses.has(status), status).toBe(true);
  expect((invoices ?? []).filter((i) => i.display_status === 'draft').every((i) => i.invoice_no === null)).toBe(true);
  expect((invoices ?? []).filter((i) => i.display_status !== 'draft').every((i) => /^INV-\d+$/.test(i.invoice_no))).toBe(true);

  const { data: payments } = await c.from('finance_payments_in').select('number, status, invoice_no').eq('org_id', demoId);
  expect((payments ?? []).length).toBeGreaterThan(0);
  expect((payments ?? []).every((p) => p.status !== 'posted' || /^RC-\d+$/.test(p.number))).toBe(true);

  const open = (invoices ?? []).find((i) => i.display_status === 'sent' || i.display_status === 'overdue')!;
  expect(open, 'an invoice that is still owed').toBeTruthy();
  expect(Number(open.balance)).toBeGreaterThan(0);
  const post = await c.rpc('finance_post_invoice', { target_org: demoId, target_invoice: open.id });
  expect(post.error).not.toBeNull();
  const pay = await c.rpc('finance_record_payment_in', {
    target_org: demoId,
    payment: { account_id: crypto.randomUUID(), txn_date: daysFromToday(0), method: 'fpx' },
    allocations: [{ invoice_id: open.id, amount: 1 }],
  });
  expect(pay.error?.code).toBe('42501');
  const { data: voided } = await c.from('finance_invoices').update({ status: 'void' }).eq('id', open.id).select('id');
  expect(voided ?? []).toEqual([]);
});
```

- [ ] **Step 3: See it fail, or skip**

Run: `pnpm exec vitest run tests/bendahara-sales.test.ts`
Expected, with `.env.local` present: FAIL. The first test fails because `finance_save_invoice` does not exist (PostgREST code `PGRST202`); most others fail the same way. Expected without `.env.local`: every test is skipped, with the warning `Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local`. Either is fine. Do not try to make it pass: it cannot until the controller applies the migration.

- [ ] **Step 4: Write the schema migration**

Create `supabase/migrations/20261014100000_bendahara_invoices.sql`:

```sql
-- Bendahara sales core, database half (additive; safe to apply while the
-- previous code is still deployed).
--   * finance_invoices + finance_invoice_lines: sales invoices.
--   * finance_allocations can now point at an invoice instead of a bill.
--   * Views: finance_invoice_totals (balance and display status) and
--     finance_payments_in (one row per invoice a payment in pays).
--   * Guards: a posted invoice is locked and can only be voided; a bill takes
--     only money out, an invoice only money in.
--   * Functions that save, post and receive payment in one transaction.
--
-- The code deployed while this is applied only ever inserts allocations with
-- bill_id set, so swapping "bill_id is not null" for "exactly one of bill_id
-- and invoice_id" refuses nothing that code does.

-- Fail fast instead of queueing behind a long transaction and stalling sign-ins.
set local lock_timeout = '5s';

-- ---- invoices ---------------------------------------------------------------
-- status is what a person sets; Sent, Paid and Overdue are derived from
-- payments and due_date in finance_invoice_totals.
create table public.finance_invoices (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  customer_id uuid not null,
  -- INV-0001; given when the invoice is posted.
  invoice_no text,
  invoice_date date not null default current_date,
  due_date date not null,
  notes text,
  status text not null default 'draft' check (status in ('draft','posted','void')),
  posted_at timestamptz,
  -- What a person has recorded about the e-Invois at LHDN. Nothing is submitted from here.
  einvoice_status text not null default 'none' check (einvoice_status in ('none','pending','validated','rejected')),
  einvoice_uuid text,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, invoice_no),
  constraint finance_invoices_dates_check check (due_date >= invoice_date),
  constraint finance_invoices_number_check check (status = 'draft' or invoice_no is not null),
  -- A draft has not gone anywhere, so it has no e-Invois yet.
  constraint finance_invoices_draft_einvoice_check
    check (status <> 'draft' or (einvoice_status = 'none' and einvoice_uuid is null)),
  foreign key (org_id, customer_id) references public.finance_contacts(org_id, id)
);
create index finance_invoices_customer_idx on public.finance_invoices (org_id, customer_id);
create index finance_invoices_date_idx on public.finance_invoices (org_id, invoice_date);

-- Same shape as supplier_bill_lines, plus position: the lines of one save all
-- share created_at, so the order they were entered in has to be stored.
create table public.finance_invoice_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  invoice_id uuid not null,
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
  foreign key (org_id, invoice_id) references public.finance_invoices(org_id, id) on delete cascade,
  foreign key (org_id, product_id) references public.finance_products(org_id, id)
);
create index finance_invoice_lines_invoice_idx on public.finance_invoice_lines (org_id, invoice_id);
create index finance_invoice_lines_product_idx on public.finance_invoice_lines (org_id, product_id);

do $$
declare t text;
begin
  foreach t in array array['finance_invoices','finance_invoice_lines'] loop
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

-- ---- allocations: a bill or an invoice --------------------------------------
alter table public.finance_allocations add column invoice_id uuid;

-- The old rule was an unnamed check, so it is found by what it says. If it is
-- not found the migration stops: with it left in place no invoice could ever
-- be paid.
do $$
declare
  c record;
  dropped integer := 0;
begin
  for c in
    select conname
    from pg_catalog.pg_constraint
    where conrelid = 'public.finance_allocations'::regclass
      and contype = 'c'
      and pg_catalog.pg_get_constraintdef(oid) ilike '%bill_id is not null%'
  loop
    execute format('alter table public.finance_allocations drop constraint %I', c.conname);
    dropped := dropped + 1;
  end loop;
  if dropped <> 1 then
    raise exception 'expected one "bill_id is not null" check on finance_allocations, found %', dropped;
  end if;
end $$;

alter table public.finance_allocations
  add constraint finance_allocations_one_document_check check (num_nonnulls(bill_id, invoice_id) = 1),
  add constraint finance_allocations_transaction_invoice_key unique (transaction_id, invoice_id),
  add constraint finance_allocations_invoice_fkey
    foreign key (org_id, invoice_id) references public.finance_invoices(org_id, id);
create index finance_allocations_invoice_idx on public.finance_allocations (org_id, invoice_id);

-- ---- views ------------------------------------------------------------------
-- Columns are listed one by one, so a later stage can add to the end with
-- "create or replace view". The balance is worked out in one place (v):
-- stage 4 changes that line to take off issued credit notes and add back
-- refunds, and nothing else here.
-- Overdue uses the database's current_date (UTC), as supplier_bill_totals does.
create view public.finance_invoice_totals with (security_invoker = true) as
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
  end as display_status
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
cross join lateral (
  select
    coalesce(l.subtotal, 0) + coalesce(l.sst, 0) as total,
    coalesce(p.paid, 0) as paid,
    coalesce(l.subtotal, 0) + coalesce(l.sst, 0) - coalesce(p.paid, 0) as balance
) v;
revoke all on public.finance_invoice_totals from anon, authenticated;
grant select on public.finance_invoice_totals to authenticated;

-- One row per invoice a payment in pays. Same columns as finance_payments_out,
-- with the invoice and the customer where that view has the bill and the supplier.
create view public.finance_payments_in with (security_invoker = true) as
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
  t.account_id,
  acc.name as account_name,
  i.id as invoice_id,
  i.invoice_no,
  c.name as customer_name,
  t.created_at
from public.finance_allocations a
join public.finance_transactions t on t.org_id = a.org_id and t.id = a.transaction_id
join public.finance_invoices i on i.org_id = a.org_id and i.id = a.invoice_id
join public.finance_contacts c on c.org_id = i.org_id and c.id = i.customer_id
join public.finance_accounts acc on acc.org_id = t.org_id and acc.id = t.account_id
where t.direction = 'in';
revoke all on public.finance_payments_in from anon, authenticated;
grant select on public.finance_payments_in to authenticated;

-- ---- guards -----------------------------------------------------------------
-- Each guard steps aside when its workspace is being deleted: by the time a
-- cascade reaches these rows the orgs row is already gone.

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
    if exists (
      select 1
      from public.finance_allocations a
      join public.finance_transactions t on t.org_id = a.org_id and t.id = a.transaction_id
      where a.org_id = old.org_id and a.invoice_id = old.id
        and t.status in ('draft','pending_approval','scheduled','posted')
    ) then
      raise exception 'the invoice has payments' using errcode = 'FIN02';
    end if;
    return new;
  end if;

  raise exception 'a posted invoice cannot be changed' using errcode = 'FIN01';
end $$;

create trigger finance_invoice_guard
  before insert or update or delete on public.finance_invoices
  for each row execute function private.finance_invoice_guard();

create or replace function private.finance_invoice_line_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  s text;
begin
  -- The workspace is being deleted: its invoices and their lines all go.
  if tg_op = 'DELETE' and not exists (select 1 from public.orgs where id = old.org_id) then
    return old;
  end if;
  if tg_op <> 'INSERT' then
    select status into s from public.finance_invoices where org_id = old.org_id and id = old.invoice_id for share;
    -- No parent row: the invoice itself is being deleted, and its lines go with it.
    if s is not null and s <> 'draft' then
      raise exception 'the lines of a posted invoice cannot be changed' using errcode = 'FIN01';
    end if;
  end if;
  if tg_op <> 'DELETE' then
    select status into s from public.finance_invoices where org_id = new.org_id and id = new.invoice_id for share;
    if s is not null and s <> 'draft' then
      raise exception 'the lines of a posted invoice cannot be changed' using errcode = 'FIN01';
    end if;
    return new;
  end if;
  return old;
end $$;

create trigger finance_invoice_line_guard
  before insert or update or delete on public.finance_invoice_lines
  for each row execute function private.finance_invoice_line_guard();

-- Replaces the guard that knew only bills. The bill path is the same checks in
-- the same order as before, so the same refusal comes first: posted payment
-- (FIN09), wrong direction (FIN04), split above the payment (FIN03), document
-- not posted (FIN04, under a row lock), more than is owed (FIN05). The invoice
-- path is its mirror, with money in where a bill has money out.
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

  -- An invoice takes money in; everything else is a bill and takes money out.
  -- (A row naming both, or neither, is refused by the table's check
  -- constraint, which runs after this trigger.)
  if new.bill_id is null and new.invoice_id is not null then
    if has_txn and t.direction <> 'in' then
      raise exception 'only money in pays an invoice' using errcode = 'FIN04';
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

  if new.bill_id is null and new.invoice_id is not null then
    -- Lock the invoice, so two payments at the same moment are checked one after the other.
    select status into doc_status from public.finance_invoices
    where org_id = new.org_id and id = new.invoice_id for update;
    if doc_status is distinct from 'posted' then
      raise exception 'a payment can only go against a posted invoice' using errcode = 'FIN04';
    end if;

    select coalesce(sum(amount + sst_amount), 0) into doc_total
    from public.finance_invoice_lines where org_id = new.org_id and invoice_id = new.invoice_id;
    select coalesce(sum(a.amount), 0) into taken
    from public.finance_allocations a
    join public.finance_transactions x on x.org_id = a.org_id and x.id = a.transaction_id
    where a.org_id = new.org_id and a.invoice_id = new.invoice_id and a.id <> new.id
      and x.status in ('draft','pending_approval','scheduled','posted');
    if taken + new.amount > doc_total then
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
     and exists (select 1 from public.finance_invoices where org_id = old.org_id and customer_id = old.id) then
    raise exception 'the contact has invoices' using errcode = 'FIN08';
  end if;
  return new;
end $$;

-- finance_transaction_guard is not touched: it fires on update and delete
-- only and never reads direction, so money in is drafted, posted and voided
-- under the rules money out already has.

revoke all on function private.finance_invoice_guard() from public, anon, authenticated;
revoke all on function private.finance_invoice_line_guard() from public, anon, authenticated;
revoke all on function private.finance_allocation_guard() from public, anon, authenticated;
revoke all on function private.finance_contact_guard() from public, anon, authenticated;

-- ---- functions --------------------------------------------------------------
-- All run as the caller, so RLS decides who may write and to which workspace.

-- Creates a draft invoice, or replaces a draft's header and lines. Returns its id.
create or replace function public.finance_save_invoice(target_org uuid, invoice jsonb, lines jsonb)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  iid uuid := nullif(invoice->>'id', '')::uuid;
  n integer;
begin
  if jsonb_typeof(lines) is distinct from 'array' or jsonb_array_length(lines) = 0 then
    raise exception 'an invoice needs at least one line' using errcode = 'FIN10';
  end if;

  if iid is null then
    insert into public.finance_invoices (org_id, customer_id, invoice_date, due_date, notes, status)
    values (
      target_org,
      (invoice->>'customer_id')::uuid,
      (invoice->>'invoice_date')::date,
      (invoice->>'due_date')::date,
      nullif(invoice->>'notes', ''),
      'draft'
    )
    returning id into iid;
  else
    update public.finance_invoices
       set customer_id = (invoice->>'customer_id')::uuid,
           invoice_date = (invoice->>'invoice_date')::date,
           due_date = (invoice->>'due_date')::date,
           notes = nullif(invoice->>'notes', ''),
           updated_at = now()
     where org_id = target_org and id = iid;
    get diagnostics n = row_count;
    if n = 0 then
      raise exception 'the invoice no longer exists' using errcode = 'FIN11';
    end if;
    delete from public.finance_invoice_lines where org_id = target_org and invoice_id = iid;
  end if;

  insert into public.finance_invoice_lines
    (org_id, invoice_id, position, product_id, description, quantity, uom, pack_size, unit_price, sst_rate)
  select
    target_org, iid,
    l.ord::integer,
    nullif(l.line->>'product_id', '')::uuid,
    l.line->>'description',
    (l.line->>'quantity')::numeric,
    nullif(l.line->>'uom', ''),
    nullif(l.line->>'pack_size', ''),
    (l.line->>'unit_price')::numeric,
    coalesce((l.line->>'sst_rate')::numeric, 0)
  from jsonb_array_elements(lines) with ordinality as l(line, ord);

  return iid;
end $$;

-- Posts a draft invoice and returns its number. The number is taken here, so
-- a failed post does not use one up.
create or replace function public.finance_post_invoice(target_org uuid, target_invoice uuid)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  i record;
  total numeric;
  no text;
begin
  select status, invoice_no into i from public.finance_invoices
  where org_id = target_org and id = target_invoice for update;
  if not found then
    raise exception 'the invoice no longer exists' using errcode = 'FIN11';
  end if;
  if i.status <> 'draft' then
    raise exception 'the invoice is already posted' using errcode = 'FIN01';
  end if;
  select coalesce(sum(amount + sst_amount), 0) into total
  from public.finance_invoice_lines where org_id = target_org and invoice_id = target_invoice;
  if total <= 0 then
    raise exception 'an invoice needs an amount before it is posted' using errcode = 'FIN10';
  end if;

  no := coalesce(i.invoice_no, public.finance_next_number(target_org, 'invoice'));
  update public.finance_invoices
     set status = 'posted', invoice_no = no, posted_at = now(), updated_at = now()
   where org_id = target_org and id = target_invoice;
  return no;
end $$;

-- Records one payment in, split across one customer's posted invoices. Money
-- received is posted at once with an RC- number: it is never scheduled and
-- needs no approval. Returns its id.
create or replace function public.finance_record_payment_in(target_org uuid, payment jsonb, allocations jsonb)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  tid uuid;
  total numeric;
  customers uuid[];
  no text;
begin
  if jsonb_typeof(allocations) is distinct from 'array' or jsonb_array_length(allocations) = 0 then
    raise exception 'no invoice was chosen' using errcode = 'FIN06';
  end if;

  select coalesce(sum((a->>'amount')::numeric), 0) into total from jsonb_array_elements(allocations) as a;
  select array_agg(distinct i.customer_id) into customers
  from jsonb_array_elements(allocations) as a
  join public.finance_invoices i on i.org_id = target_org and i.id = (a->>'invoice_id')::uuid;
  if customers is null or array_length(customers, 1) <> 1 then
    raise exception 'one payment is from one customer' using errcode = 'FIN06';
  end if;

  insert into public.finance_transactions
    (org_id, direction, account_id, txn_date, amount, method, reference, contact_id, notes, status)
  values (
    target_org, 'in',
    (payment->>'account_id')::uuid,
    coalesce((payment->>'txn_date')::date, current_date),
    total,
    payment->>'method',
    nullif(payment->>'reference', ''),
    customers[1],
    nullif(payment->>'notes', ''),
    'draft'
  )
  returning id into tid;

  -- In id order, so two payments that share invoices lock them in the same order.
  insert into public.finance_allocations (org_id, transaction_id, invoice_id, amount)
  select target_org, tid, (a->>'invoice_id')::uuid, (a->>'amount')::numeric
  from jsonb_array_elements(allocations) as a
  order by (a->>'invoice_id')::uuid;

  no := public.finance_next_number(target_org, 'receipt');
  update public.finance_transactions
     set status = 'posted', number = no, updated_at = now()
   where org_id = target_org and id = tid;
  return tid;
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.finance_save_invoice(uuid, jsonb, jsonb)',
    'public.finance_post_invoice(uuid, uuid)',
    'public.finance_record_payment_in(uuid, jsonb, jsonb)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
```

- [ ] **Step 5: Write the seed migration**

Create `supabase/migrations/20261014100100_bendahara_invoices_seed.sql`:

```sql
-- Demo data for Bendahara Invoices and Payments In in the shared demo org.
-- Mirrors the sample the two screens show without a database. Dates are
-- relative to today so the Sent and Overdue examples stay meaningful. Skips
-- when the demo org is missing or already has invoices.
--
-- Nothing is disabled: every row goes in the way the guards allow. An invoice
-- is inserted as a draft, given its lines, then posted with its number in one
-- update. A payment is inserted as a draft, split, then posted with its number.
-- The posting functions are not used because they take their numbers from
-- finance_next_number, which answers only to a signed-in editor of the
-- workspace, and a migration has no signed-in user.

do $$
declare
  demo uuid;
  bank uuid;
  cash uuid;
  customer uuid;
  inv uuid;
  txn uuid;
  amt numeric;
  r record;
begin
  select id into demo from public.orgs where slug = 'rimba-ventures-demo';
  if demo is null or exists (select 1 from public.finance_invoices where org_id = demo) then
    return;
  end if;

  -- The accounts money is received into. Seeding them again changes nothing if they are there.
  perform private.finance_seed_accounts(demo);
  select id into bank from public.finance_accounts
   where org_id = demo and kind = 'bank'
   order by (lower(name) = 'main bank') desc, created_at, id limit 1;
  select id into cash from public.finance_accounts
   where org_id = demo and kind = 'cash'
   order by (lower(name) = 'cash in hand') desc, created_at, id limit 1;
  -- A demo org whose cash account was archived or renamed still gets its receipts.
  cash := coalesce(cash, bank);
  bank := coalesce(bank, cash);
  if bank is null then
    raise exception 'the demo org has no account to receive money into';
  end if;

  -- Customers: a contact that is already there (some are suppliers too) is
  -- ticked as a customer; the rest are added.
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

  -- ---- invoices: a draft, its one line, then posted with its number ---------
  -- no is null for the invoice that stays a draft. days_ago and due_in are
  -- counted from today; due_in below zero is an invoice past its due date.
  for r in
    select * from (values
      (null,       'Seri Mutiara Enterprise',   2,  28, 'Website refresh, phase 1',            1::numeric, 2750::numeric,  0::numeric, 'none'),
      ('INV-1042', 'Aisyah Trading',            3,  27, 'Monthly retainer, October',           1,          1240,           0,          'validated'),
      ('INV-1041', 'Zaki Enterprise',           5,  25, 'Point-of-sale setup and training',    1,          3500,           0,          'pending'),
      ('INV-1040', 'Nurul Boutique',            9,  -2, 'Product photography, 89 items',      89,           100,           0,          'validated'),
      ('INV-1039', 'Lim Hardware Sdn Bhd',     12,  18, 'Stock-take support, 3 days',          3,           700,           0,          'validated'),
      ('INV-1038', 'Siti Decor',               15,  15, 'Showroom signage design',             1,          4200,           0,          'validated'),
      ('INV-1037', 'Nusantara Logistics',      20,   5, 'Route planning workshop',             2,          3200,           0,          'pending'),
      ('INV-1036', 'Langkawi Fresh',           26,   4, 'Online store build',                  1,          5600,           0,          'validated'),
      ('INV-1035', 'Lim Hardware Sdn Bhd',     30, -16, 'Catalogue design',                    1,          3000,           6,          'validated'),
      ('INV-1033', 'Nurul Boutique',           35,  -5, 'Lookbook layout',                     1,           850,           0,          'validated'),
      ('INV-1032', 'Seri Mutiara Enterprise',  37,  -7, 'Brand guidelines',                    1,          3000,           6,          'validated'),
      ('INV-1030', 'Nusantara Logistics',      41, -11, 'Fleet tracking dashboard',            1,          6800,           0,          'validated'),
      -- Earlier months, so the trend chart has a shape.
      ('INV-1006', 'Aisyah Trading',           58, -44, 'Monthly retainer and campaign work',  1,         41200,           0,          'validated'),
      ('INV-1005', 'Aisyah Trading',           89, -75, 'Monthly retainer and campaign work',  1,         46000,           0,          'validated'),
      ('INV-1004', 'Aisyah Trading',          119, -105, 'Monthly retainer and campaign work', 1,         43000,           0,          'validated'),
      ('INV-1003', 'Aisyah Trading',          150, -136, 'Monthly retainer and campaign work', 1,         36000,           0,          'validated'),
      ('INV-1002', 'Aisyah Trading',          180, -166, 'Monthly retainer and campaign work', 1,         38000,           0,          'validated'),
      ('INV-1001', 'Aisyah Trading',          211, -197, 'Monthly retainer and campaign work', 1,         34000,           0,          'validated')
    ) as v(no, customer_name, days_ago, due_in, description, quantity, unit_price, sst_rate, einvoice)
  loop
    select id into customer from public.finance_contacts
     where org_id = demo and name = r.customer_name
     order by created_at, id limit 1;

    insert into public.finance_invoices (org_id, customer_id, invoice_date, due_date, status)
    values (demo, customer, current_date - r.days_ago, current_date + r.due_in, 'draft')
    returning id into inv;
    insert into public.finance_invoice_lines (org_id, invoice_id, position, description, quantity, uom, unit_price, sst_rate)
    values (demo, inv, 1, r.description, r.quantity, 'job', r.unit_price, r.sst_rate);

    if r.no is not null then
      update public.finance_invoices
         set status = 'posted', invoice_no = r.no, posted_at = now(),
             einvoice_status = r.einvoice, updated_at = now()
       where id = inv;
    end if;
  end loop;

  -- ---- payments in: a draft, its split, then posted with its number ---------
  -- amount is null for a payment of the invoice's whole total.
  for r in
    select * from (values
      ('RC-0108', 'INV-1042',   2, 'fpx',           null::numeric),
      ('RC-0107', 'INV-1041',   2, 'fpx',           1000),
      ('RC-0106', 'INV-1036',   3, 'fpx',           null),
      ('RC-0105', 'INV-1039',   5, 'bank_transfer', null),
      ('RC-0104', 'INV-1038',   6, 'card',          null),
      ('RC-0103', 'INV-1032',   7, 'duitnow',       null),
      ('RC-0102', 'INV-1033',   8, 'cash',          null),
      ('RC-0101', 'INV-1030',  10, 'bank_transfer', null),
      ('RC-0096', 'INV-1006',  46, 'bank_transfer', null),
      ('RC-0095', 'INV-1005',  77, 'bank_transfer', null),
      ('RC-0094', 'INV-1004', 107, 'bank_transfer', null),
      ('RC-0093', 'INV-1003', 138, 'bank_transfer', null),
      ('RC-0092', 'INV-1002', 168, 'bank_transfer', null),
      ('RC-0091', 'INV-1001', 199, 'bank_transfer', null)
    ) as v(no, invoice_no, days_ago, method, amount)
  loop
    select t.id, t.customer_id, coalesce(r.amount, t.total)
      into inv, customer, amt
      from public.finance_invoice_totals t
     where t.org_id = demo and t.invoice_no = r.invoice_no;

    insert into public.finance_transactions
      (org_id, direction, account_id, txn_date, amount, method, contact_id, status)
    values (
      demo, 'in',
      case when r.method = 'cash' then cash else bank end,
      current_date - r.days_ago, amt, r.method, customer, 'draft'
    )
    returning id into txn;
    insert into public.finance_allocations (org_id, transaction_id, invoice_id, amount)
    values (demo, txn, inv, amt);
    update public.finance_transactions
       set status = 'posted', number = r.no, updated_at = now()
     where id = txn;
  end loop;

  -- The demo's counters start after the numbers used above.
  insert into public.finance_sequences (org_id, doc_type, prefix, next_number)
  values (demo, 'invoice', 'INV-', 1043), (demo, 'receipt', 'RC-', 109)
  on conflict (org_id, doc_type)
    do update set next_number = greatest(public.finance_sequences.next_number, excluded.next_number);
end $$;
```

- [ ] **Step 6: Write the check script**

Create `supabase/tests/bendahara_invoices_check.sql`:

```sql
-- Bendahara invoices check. Run it after 20261014100000_bendahara_invoices.sql,
-- in the same transaction for a dry run, or by itself once the migration is
-- applied. It leaves nothing behind either way: the block always ends with
-- RAISE, so every row and the helper function below are rolled back. Read the
-- message:
--   BENDAHARA_INVOICES_CHECK PASSED ...   or   BENDAHARA_INVOICES_CHECK FAILED: <what went wrong>
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
   where schemaname = 'public' and tablename in ('finance_invoices','finance_invoice_lines');
  if n <> 10 then fails := fails || format('expected 10 policies on the two new tables, found %s', n); end if;
  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename in ('finance_invoices','finance_invoice_lines')
     and policyname = 'mfa_required' and permissive = 'RESTRICTIVE';
  if n <> 2 then fails := fails || format('expected 2 restrictive mfa_required policies, found %s', n); end if;
  select count(*) into n from pg_class c join pg_namespace s on s.oid = c.relnamespace
   where s.nspname = 'public' and c.relname in ('finance_invoice_totals','finance_payments_in')
     and c.reloptions::text ilike '%security_invoker=true%';
  if n <> 2 then fails := fails || format('expected 2 security_invoker views, found %s', n); end if;
  select string_agg(conname, ',' order by conname) into t from pg_constraint
   where conrelid = 'public.finance_allocations'::regclass and contype = 'c';
  if t is distinct from 'finance_allocations_amount_check,finance_allocations_one_document_check' then
    fails := fails || format('check constraints on finance_allocations are: %s', t);
  end if;
  foreach t in array array[
    'public.finance_save_invoice(uuid, jsonb, jsonb)',
    'public.finance_post_invoice(uuid, uuid)',
    'public.finance_record_payment_in(uuid, jsonb, jsonb)'
  ] loop
    if has_function_privilege('anon', t, 'execute') then fails := fails || format('anon can execute %s', t); end if;
    if not has_function_privilege('authenticated', t, 'execute') then fails := fails || format('authenticated cannot execute %s', t); end if;
  end loop;
  foreach t in array array['finance_invoices','finance_invoice_lines','finance_invoice_totals','finance_payments_in'] loop
    if has_table_privilege('anon', 'public.' || t, 'select') then fails := fails || format('anon can read %s', t); end if;
  end loop;

  -- ---- people and two workspaces -------------------------------------------
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_anonymous)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    u.id || '@invoices-check.openkuasa-test.dev', '', now(), now(), now(), '{}'::jsonb, '{}'::jsonb, false
  from unnest(array[owner_id, editor_id, viewer_id, outsider]) as u(id);

  -- The trigger on orgs gives each workspace its accounts and categories.
  insert into public.orgs (id, name) values (org, 'Invoices Check Sdn Bhd'), (other_org, 'Invoices Other Sdn Bhd');
  insert into public.org_members (org_id, user_id, role)
  values (org, owner_id, 'owner'), (org, editor_id, 'member'), (org, viewer_id, 'viewer'), (other_org, outsider, 'owner');
  select id into bank from public.finance_accounts where org_id = org and kind = 'bank' order by created_at limit 1;
  if bank is null then raise exception 'BENDAHARA_INVOICES_CHECK cannot run: the new workspace has no bank account'; end if;

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
  delete from public.finance_transactions where id = stray;
  insert into public.finance_transactions (org_id, direction, account_id, amount, method)
  values (org, 'in', bank, 20, 'cash') returning id into stray;
  fails := fails || public.bendahara_check_try('money in is put against a bill', 'FIN04',
    format('insert into public.finance_allocations (org_id, transaction_id, bill_id, amount) values (%L, %L, %L, 10)', org, stray, bill));
  fails := fails || public.bendahara_check_try('an unposted payment in is voided', 'FIN09',
    format('update public.finance_transactions set status = %L where id = %L', 'void', stray));
  delete from public.finance_transactions where id = stray;

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
  reset role;
  select count(*) into n from public.finance_invoices where id = draft and created_by = editor_id;
  if n <> 1 then fails := array_append(fails, 'an invoice does not record who made it'); end if;

  -- ==== as the viewer: reads everything, changes nothing =====================
  perform set_config('request.jwt.claims', json_build_object('sub', viewer_id, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  set local role authenticated;
  select count(*) into n from public.finance_invoice_totals where org_id = org;
  if n <> 5 then fails := fails || format('a viewer reads %s of 5 invoices', n); end if;
  select count(*) into n from public.finance_payments_in where org_id = org;
  if n <> 5 then fails := fails || format('a viewer reads %s of 5 payment-in rows', n); end if;
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
  foreach t in array array['finance_invoices','finance_invoice_lines','finance_invoice_totals','finance_payments_in'] loop
    execute format('select count(*) from public.%I where org_id = %L', t, org) into n;
    if n <> 0 then fails := fails || format('another workspace reads %s rows of %s', n, t); end if;
  end loop;
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
  end;
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
  end;
  select count(*) into n from public.finance_invoices where id = inv and status = 'void' and created_by is null;
  if n <> 1 then fails := array_append(fails, 'deleting a user did not clear created_by on their void invoice'); end if;

  -- ==== the workspace is deleted, posted invoices, payments and all ==========
  delete from public.orgs where id = org;
  select (select count(*) from public.finance_invoices where org_id = org)
       + (select count(*) from public.finance_invoice_lines where org_id = org)
       + (select count(*) from public.finance_allocations where org_id = org)
       + (select count(*) from public.finance_transactions where org_id = org)
       + (select count(*) from public.supplier_bills where org_id = org) into n;
  if n <> 0 then fails := fails || format('deleting the workspace left %s finance rows', n); end if;

  fails := array_remove(fails, null);
  if array_length(fails, 1) is null then
    raise exception 'BENDAHARA_INVOICES_CHECK PASSED (everything rolled back)%',
      case when array_length(notes, 1) is null then '' else ' NOTE: ' || array_to_string(notes, ' | ') end;
  end if;
  raise exception 'BENDAHARA_INVOICES_CHECK FAILED: %', array_to_string(fails, ' | ');
end $$;
```

- [ ] **Step 7: Type-check and lint**

Run: `pnpm exec tsc --noEmit` then `pnpm lint`
Expected: no errors. (Only the test file is TypeScript; the SQL is checked by the controller.)

- [ ] **Step 8: Commit**

```bash
git add supabase/migrations/20261014100000_bendahara_invoices.sql supabase/migrations/20261014100100_bendahara_invoices_seed.sql supabase/tests/bendahara_invoices_check.sql tests/bendahara-sales.test.ts
git commit -m "feat: invoices and money in for finance, with posted invoices locked in the database"
```

**Controller gate. Tasks 2 to 7 can be built while it is open, but nothing merges until step 12 has passed.**

- [ ] **Step 9 (controller): Dry-run the schema migration on the hosted database**

First confirm the database role can act as a signed-in user. With the `openkuasa-supabase` MCP `execute_sql`:

```sql
do $$ begin set local role authenticated; reset role; raise exception 'ROLE_SWITCH_OK'; end $$;
```

Expected: an error whose message is `ROLE_SWITCH_OK`. A permission error instead means the check cannot run this way: stop and tell the owner.

Then send, in one `execute_sql` call: `begin;`, the "before" block, the whole of `supabase/migrations/20261014100000_bendahara_invoices.sql`, the "after" block, the whole of `supabase/tests/bendahara_invoices_check.sql`, and `rollback;`.

Before the migration:

```sql
create temp table before_bills on commit drop as
select id, total, paid, balance, display_status from public.supplier_bill_totals;
create temp table before_out on commit drop as
select allocation_id, amount, status, bill_no from public.finance_payments_out;
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
  where (t.amount, t.status, t.bill_no) is distinct from (x.amount, x.status, x.bill_no);
  if n <> 0 then raise exception 'DRYRUN FAILED: % payment-out rows read differently after the migration', n; end if;
end $$;
```

Expected: an error whose message is `BENDAHARA_INVOICES_CHECK PASSED (everything rolled back)`. A `NOTE:` after it means deleting the check's own users was stopped by something outside finance and `created_by` was cleared by hand instead; read it, it is not a failure.

- `DRYRUN FAILED: …` means existing bills or payments out read differently after the migration. Stop: the allocation guard or a view is wrong.
- `BENDAHARA_INVOICES_CHECK FAILED: …` lists each expectation that did not hold, separated by ` | `.
- `expected one "bill_id is not null" check on finance_allocations, found 0` means the old check constraint is worded differently on the hosted database. Run `select conname, pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.finance_allocations'::regclass and contype = 'c';`, and change the migration's lookup to match.
- Any other error is the migration or the script failing outright; the message names the statement. An error on the insert into `auth.users` or `public.orgs` is the script's own set-up, not the migration: add the column the message names and run again.

On any failure: fix the file on the branch, commit the fix, and dry-run again from the top. Nothing has been applied, so the migration file itself is edited.

Then confirm nothing was left: `select to_regclass('public.finance_invoices') is null;` → `true`.

What the check covers, for the record: save → post → pay in part → pay the rest → void a payment → void refused with money on it → void once it is free → delete a draft; one payment across two invoices, and refused across two customers; money out against an invoice and money in against a bill; the whole bill flow (schedule, over-pay refused, pay, mark paid, void refused, void) through the rewritten guard; an editor, a viewer and another workspace's owner; deleting the users who made posted and void documents; deleting the workspace with all of it inside.

- [ ] **Step 10 (controller): Dry-run the seed**

Send, in one `execute_sql` call: `begin;`, the whole schema migration, the whole of `supabase/migrations/20261014100100_bendahara_invoices_seed.sql` **twice**, this block, and `rollback;`.

```sql
do $$
declare
  demo uuid;
  r text;
begin
  select id into demo from public.orgs where slug = 'rimba-ventures-demo';
  select format(
    'invoices=%s (%s) | receivable=%s overdue=%s | payments in=%s rows, RM %s, %s | sequences: %s | customers=%s | bills=%s',
    (select count(*) from public.finance_invoice_totals where org_id = demo),
    (select string_agg(display_status || '=' || n, ', ' order by display_status)
       from (select display_status, count(*) n from public.finance_invoice_totals where org_id = demo group by 1) s),
    (select sum(balance) from public.finance_invoice_totals where org_id = demo and display_status in ('sent','overdue')),
    (select sum(balance) from public.finance_invoice_totals where org_id = demo and display_status = 'overdue'),
    (select count(*) from public.finance_payments_in where org_id = demo),
    (select sum(amount) from public.finance_payments_in where org_id = demo),
    (select string_agg(distinct status, ',') from public.finance_payments_in where org_id = demo),
    (select string_agg(doc_type || '=' || next_number, ', ' order by doc_type)
       from public.finance_sequences where org_id = demo and doc_type in ('invoice','receipt')),
    (select count(*) from public.finance_contacts where org_id = demo and is_customer),
    (select count(*) from public.supplier_bill_totals where org_id = demo))
  into r;
  raise exception 'SEED DRYRUN, rolling back: %', r;
end $$;
```

Expected: an error starting `SEED DRYRUN, rolling back:` with `invoices=18 (draft=1, overdue=2, paid=13, sent=2) | receivable=20980.00 overdue=12080.00 | payments in=14 rows, RM 263170.00, posted | sequences: invoice=1043, receipt=109`, then `customers=` 8 or more and `bills=` the number of bills the demo workspace has today (`select count(*) from public.supplier_bill_totals t join public.orgs o on o.id = t.org_id where o.slug = 'rimba-ventures-demo';`). Running the seed twice and still counting 18 is the proof it does nothing the second time. `invoices=0` means the demo workspace was not found by its slug.

- [ ] **Step 11 (controller): Apply the schema migration, on the owner's explicit go-ahead**

Stop and ask the owner first. Apply `20261014100000_bendahara_invoices.sql` with `apply_migration`, name `bendahara_invoices`. One `apply_migration` call at a time. Do not apply the seed in the same breath.

- [ ] **Step 12 (controller): Check the applied schema**

Send the whole of `supabase/tests/bendahara_invoices_check.sql` by itself with `execute_sql`.
Expected: `BENDAHARA_INVOICES_CHECK PASSED (everything rolled back)`.

Run: `pnpm exec vitest run tests/bendahara-purchases.test.ts tests/bendahara-foundation.rls.test.ts tests/bendahara-sales.test.ts`
Expected: every test in the first two files passes, **unchanged from before this stage**: that is the proof the rewritten allocation guard treats bills as it did. In `tests/bendahara-sales.test.ts` every test passes except the last, 'a demo viewer reads the seeded invoices and payments in', which fails until step 13.

If a test fails for a reason in the SQL: the migration is applied now, so the fix is a new corrective migration file, never an edit to the applied one.

- [ ] **Step 13 (controller): Apply the seed**

Any time after step 11, with the owner's go-ahead: apply `20261014100100_bendahara_invoices_seed.sql` with `apply_migration`, name `bendahara_invoices_seed`.

Run: `pnpm exec vitest run tests/bendahara-sales.test.ts`
Expected: PASS, every test.

Until the new code is deployed, production's Invoices and Payments In are still the mock-ups, so the seeded rows are not visible there yet; that is expected.

---

### Task 2: Move what bills and invoices share into two shared files

**Files:**
- Create: `tests/finance-shared.test.ts`
- Create: `src/lib/finance/document-lines.ts`
- Create: `src/lib/finance/view-helpers.ts`
- Modify: `src/lib/finance/bills.ts` (whole file replaced; same exports, plus nothing new)
- Modify: `src/lib/finance/purchase-views.ts` (whole file replaced; same exports)

**Interfaces:**
- Consumes: `PaymentMethod` (type) from `./money`.
- Produces, from `document-lines.ts`:
  - `DOCUMENT_LINES_MAX = 100`
  - `LINE_MESSAGES: { date, lines, description, quantity, price, sst, tooLong, product }`
  - `isIsoDate(value: string): boolean`
  - `roundRate(value: number): number`
  - `isoDate`, `optionalText`, `documentLine` (Zod schemas)
  - `type DocumentLineRow = { id; product_id; description; quantity; uom; pack_size; unit_price; sst_rate; amount; sst_amount }`
  - `DOCUMENT_LINE_COLUMNS: string`
  - `toDocumentLine(row: Record<string, unknown>): DocumentLineRow`
- Produces, from `view-helpers.ts`:
  - `type Stat = { label: string; value: string; delta?: string; deltaTone?: 'up' | 'down' | 'flat' }`
  - `LATEST_ROWS = 10`, `TREND_MONTHS = 8`
  - `ELECTRONIC: ReadonlySet<PaymentMethod>`, `METHOD_COLORS: Record<PaymentMethod, string>`
  - `displayDate(iso: string): string`, `todayUtc(): string`, `addDays(iso: string, days: number): string`
  - `count(n: number, noun: string): string`, `round2(n: number): number`, `sum<T>(rows: T[], pick: (row: T) => number): number`, `thousands(amount: number): number`
  - `monthOf(iso: string): string`, `lastMonths(today: string, months?: number): { key: string; label: string }[]`
  - `paymentCount(rows: { transaction_id: string }[]): number`
- `bills.ts` keeps exporting `isIsoDate`, `roundRate`, `BILL_LINES_MAX`, `BILL_MESSAGES` (same keys, same sentences), `BillLine` and everything else it exported. `purchase-views.ts` keeps exporting `Stat`, `LATEST_ROWS`, `displayDate`, `todayUtc` and everything else it exported. No importer of either file changes.

This task changes no behaviour. The proof is that every existing finance test passes without being touched.

- [ ] **Step 1: Write the failing test**

Create `tests/finance-shared.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { BILL_LINES_MAX, BILL_MESSAGES, isIsoDate as isIsoDateFromBills, roundRate as roundRateFromBills } from '@/lib/finance/bills';
import {
  DOCUMENT_LINES_MAX,
  LINE_MESSAGES,
  documentLine,
  isIsoDate,
  isoDate,
  optionalText,
  roundRate,
  toDocumentLine,
} from '@/lib/finance/document-lines';
import * as purchaseViews from '@/lib/finance/purchase-views';
import {
  ELECTRONIC,
  LATEST_ROWS,
  METHOD_COLORS,
  addDays,
  count,
  displayDate,
  lastMonths,
  monthOf,
  paymentCount,
  sum,
  thousands,
  todayUtc,
} from '@/lib/finance/view-helpers';

describe('what bills and invoices share', () => {
  it('is one definition: bills.ts hands on the same functions, limit and sentences', () => {
    expect(isIsoDateFromBills).toBe(isIsoDate);
    expect(roundRateFromBills).toBe(roundRate);
    expect(BILL_LINES_MAX).toBe(DOCUMENT_LINES_MAX);
    for (const key of Object.keys(LINE_MESSAGES) as (keyof typeof LINE_MESSAGES)[]) {
      expect(BILL_MESSAGES[key], key).toBe(LINE_MESSAGES[key]);
    }
  });

  it('parses a line: rounds first, then checks, and parsing its own output changes nothing', () => {
    const once = documentLine.parse({ description: ' Gloves ', quantity: 1.23456, unit_price: 0.123456, sst_rate: 1.005, uom: ' box ', product_id: '' });
    expect(once).toEqual({
      product_id: null, description: 'Gloves', quantity: 1.235, uom: 'box', pack_size: null, unit_price: 0.1235, sst_rate: 1.01,
    });
    expect(documentLine.parse(once)).toEqual(once);
    expect(documentLine.safeParse({ description: 'Gloves', quantity: 0.0004, unit_price: 1 }).error?.issues[0]?.message).toBe('Enter a quantity above 0.');
    expect(documentLine.safeParse({ description: 'Gloves', quantity: 1, unit_price: 1, sst_rate: 100.005 }).error?.issues[0]?.message)
      .toBe('Enter an SST rate between 0 and 100.');
  });

  it('accepts only real calendar dates, and turns an empty box into null', () => {
    expect(isoDate.safeParse('2026-02-29').success).toBe(false);
    expect(isoDate.safeParse('2028-02-29').success).toBe(true);
    expect(isoDate.safeParse('0202-10-01').error?.issues[0]?.message).toBe('Enter a valid date.');
    expect(optionalText.parse('  ')).toBeNull();
    expect(optionalText.parse(' Net 30 ')).toBe('Net 30');
    expect(optionalText.parse(null)).toBeNull();
    expect(optionalText.safeParse('x'.repeat(201)).error?.issues[0]?.message).toBe('That is too long. Keep it to 200 characters or fewer.');
  });

  it('reads a saved line with its figures as numbers', () => {
    expect(
      toDocumentLine({
        id: 'l1', product_id: null, description: 'Gloves', quantity: '10.000', uom: null, pack_size: 'box of 4',
        unit_price: '12.5000', sst_rate: '6.00', amount: '125.00', sst_amount: '7.50',
      }),
    ).toEqual({
      id: 'l1', product_id: null, description: 'Gloves', quantity: 10, uom: null, pack_size: 'box of 4',
      unit_price: 12.5, sst_rate: 6, amount: 125, sst_amount: 7.5,
    });
  });
});

describe('what the purchase and sales figures share', () => {
  it('is one definition: purchase-views.ts hands on the same helpers', () => {
    expect(purchaseViews.displayDate).toBe(displayDate);
    expect(purchaseViews.todayUtc).toBe(todayUtc);
    expect(purchaseViews.LATEST_ROWS).toBe(LATEST_ROWS);
    expect(LATEST_ROWS).toBe(10);
  });

  it('names the last eight months, oldest first, across a year end', () => {
    expect(lastMonths('2026-10-09').map((m) => m.key)).toEqual([
      '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10',
    ]);
    expect(lastMonths('2026-02-28')).toEqual([
      { key: '2025-07', label: 'Jul' }, { key: '2025-08', label: 'Aug' }, { key: '2025-09', label: 'Sep' }, { key: '2025-10', label: 'Oct' },
      { key: '2025-11', label: 'Nov' }, { key: '2025-12', label: 'Dec' }, { key: '2026-01', label: 'Jan' }, { key: '2026-02', label: 'Feb' },
    ]);
    // The 31st has no counterpart in a shorter month; the window is counted in months, not days.
    expect(lastMonths('2026-03-31', 3).map((m) => m.key)).toEqual(['2026-01', '2026-02', '2026-03']);
  });

  it('adds days across a month end, and takes the month of a date', () => {
    expect(addDays('2026-10-28', 7)).toBe('2026-11-04');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(monthOf('2026-10-09')).toBe('2026-10');
  });

  it('adds sen without drift, and rounds a chart figure to RM thousands with one decimal', () => {
    expect(sum([0.1, 0.2], (n) => n)).toBe(0.3);
    expect(sum([], (n: number) => n)).toBe(0);
    expect(thousands(4000)).toBe(4);
    expect(thousands(2549.99)).toBe(2.5);
    expect(thousands(30)).toBe(0);
  });

  it('counts a payment split across documents once, and words a count', () => {
    expect(paymentCount([{ transaction_id: 'a' }, { transaction_id: 'a' }, { transaction_id: 'b' }])).toBe(2);
    expect(paymentCount([])).toBe(0);
    expect(count(1, 'invoice')).toBe('1 invoice');
    expect(count(0, 'invoice')).toBe('0 invoices');
  });

  it('groups five methods as electronic and gives all seven a colour', () => {
    expect([...ELECTRONIC].sort()).toEqual(['bank_transfer', 'card', 'duitnow', 'ewallet', 'fpx']);
    expect(Object.keys(METHOD_COLORS).sort()).toEqual(['bank_transfer', 'card', 'cash', 'cheque', 'duitnow', 'ewallet', 'fpx']);
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `pnpm exec vitest run tests/finance-shared.test.ts`
Expected: FAIL. The file cannot be loaded: `@/lib/finance/document-lines` does not exist.

- [ ] **Step 3: Write `src/lib/finance/document-lines.ts`**

Create `src/lib/finance/document-lines.ts`:

```ts
/**
 * What supplier bills and invoices share: a document dated with a real
 * calendar date, carrying lines of quantity × unit price with an SST rate.
 * The schemas round first and validate after, so parsing their own output
 * changes nothing. Pure, with no server imports.
 */
import { z } from 'zod';

export const DOCUMENT_LINES_MAX = 100;

export const LINE_MESSAGES = {
  date: 'Enter a valid date.',
  lines: 'Add at least one line.',
  description: 'Describe each line.',
  quantity: 'Enter a quantity above 0.',
  price: 'Enter a unit price of 0 or more.',
  sst: 'Enter an SST rate between 0 and 100.',
  tooLong: 'That is too long. Keep it to 200 characters or fewer.',
  product: 'Choose a product from the list, or leave it empty.',
} as const;

const M = LINE_MESSAGES;

/** YYYY-MM-DD that is a real calendar date from 1900 to 2200; a slipped key gives year 0202. */
export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  if (year < 1900 || year > 2200) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

const round = (places: number) => (v: number) => {
  const f = 10 ** places;
  return Math.round(v * f) / f;
};

/**
 * An SST rate as the column numeric(5,2) stores it: two decimals, half away
 * from zero, rounded on the figure as written. 1.005 is 1.01 here and in the
 * database, where `Math.round(1.005 * 100)` and `(1.005).toFixed(2)` both
 * give 1.00, because the nearest floating point number is a hair below 1.005.
 * Something that is not a number comes back as it was.
 */
export function roundRate(value: number): number {
  if (!Number.isFinite(value)) return value;
  // The shortest digits that give this number back, e.g. "1.005e+0": shift the point two places in the text.
  const [digits, exponent] = Math.abs(value).toExponential().split('e');
  const hundredths = Math.round(Number(`${digits}e${Number(exponent) + 2}`));
  return (Math.sign(value) * hundredths) / 100;
}

export const isoDate = z.string({ error: M.date }).refine(isIsoDate, M.date);

/** Optional text: trimmed, at most 200 characters, and an empty box is stored as null. */
export const optionalText = z
  .string({ error: M.tooLong })
  .trim()
  .max(200, M.tooLong)
  .transform((v) => (v === '' ? null : v))
  .nullable();

/** An id, or nothing chosen (an empty string from a select). */
const optionalId = z
  .union([z.string().uuid(M.product), z.literal(''), z.null()], { error: M.product })
  .transform((v) => (v === '' ? null : v));

/** One line of a bill or an invoice, as the database functions take it. */
export const documentLine = z.object({
  product_id: optionalId.default(null),
  description: z.string({ error: M.description }).trim().min(1, M.description).max(200, M.tooLong),
  quantity: z.number({ error: M.quantity }).transform(round(3)).pipe(z.number().gt(0, M.quantity).max(99_999_999, M.quantity)),
  uom: optionalText.default(null),
  pack_size: optionalText.default(null),
  unit_price: z.number({ error: M.price }).min(0, M.price).max(999_999_999, M.price).transform(round(4)),
  sst_rate: z.number({ error: M.sst }).transform(roundRate).pipe(z.number().min(0, M.sst).max(100, M.sst)).default(0),
});

/** A saved line, as it is read back: the amounts are the database's generated columns. */
export type DocumentLineRow = {
  id: string;
  product_id: string | null;
  description: string;
  quantity: number;
  uom: string | null;
  pack_size: string | null;
  unit_price: number;
  sst_rate: number;
  amount: number;
  sst_amount: number;
};

export const DOCUMENT_LINE_COLUMNS = 'id,product_id,description,quantity,uom,pack_size,unit_price,sst_rate,amount,sst_amount';

/** A line as read from the database, with its figures as numbers whatever form they arrived in. */
export function toDocumentLine(row: Record<string, unknown>): DocumentLineRow {
  return {
    ...(row as unknown as DocumentLineRow),
    quantity: Number(row.quantity),
    unit_price: Number(row.unit_price),
    sst_rate: Number(row.sst_rate),
    amount: Number(row.amount),
    sst_amount: Number(row.sst_amount),
  };
}
```

- [ ] **Step 4: Write `src/lib/finance/view-helpers.ts`**

Create `src/lib/finance/view-helpers.ts`:

```ts
/**
 * What the purchase and sales screens' figures share: dates, sums that do not
 * drift, the month window of a trend chart, and how payment methods are
 * grouped and coloured. Pure, with no server imports. `today` and every date
 * here is a YYYY-MM-DD string.
 */
import type { PaymentMethod } from './money';

export type Stat = {
  label: string;
  value: string;
  delta?: string;
  deltaTone?: 'up' | 'down' | 'flat';
};

/** Rows a table shows before "View all" is pressed. */
export const LATEST_ROWS = 10;

/** Months a trend chart covers, the current one included. */
export const TREND_MONTHS = 8;

/** Money that moved without a note or a cheque changing hands. */
export const ELECTRONIC: ReadonlySet<PaymentMethod> = new Set(['bank_transfer', 'fpx', 'duitnow', 'card', 'ewallet']);

/** Seven methods, five chart colours: Cash and Cheque get a fixed green and a fixed brown. */
export const METHOD_COLORS: Record<PaymentMethod, string> = {
  bank_transfer: 'var(--chart-1)',
  fpx: 'var(--chart-2)',
  duitnow: 'var(--chart-5)',
  card: 'var(--chart-3)',
  ewallet: 'var(--chart-4)',
  cash: 'oklch(0.7 0.13 130)',
  cheque: 'oklch(0.6 0.09 55)',
};

// Fixed names: Intl's short months vary by ICU version ('Sep' vs 'Sept').
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 2026-10-08 → 08 Oct 2026 */
export function displayDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d} ${MONTHS[Number(m) - 1]} ${y}`;
}

/** Today's date in UTC, the date the database uses to decide what is overdue. */
export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 1 bill, 2 bills */
export function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

export const round2 = (n: number) => Math.round(n * 100) / 100;

/** A total in ringgit, rounded to the sen so 0.1 + 0.2 is 0.3. */
export function sum<T>(rows: T[], pick: (row: T) => number): number {
  return round2(rows.reduce((total, row) => total + pick(row), 0));
}

/** An amount in RM thousands with one decimal, for a trend chart's axis. */
export function thousands(amount: number): number {
  return Math.round(amount / 100) / 10;
}

/** The YYYY-MM a date falls in. */
export function monthOf(iso: string): string {
  return iso.slice(0, 7);
}

/** The last `months` months up to and including today's, oldest first: its YYYY-MM key and its short name. */
export function lastMonths(today: string, months: number = TREND_MONTHS): { key: string; label: string }[] {
  const [y, m] = monthOf(today).split('-').map(Number);
  return Array.from({ length: months }, (_, i) => {
    const start = new Date(Date.UTC(y, m - months + i, 1));
    return { key: start.toISOString().slice(0, 7), label: MONTHS[start.getUTCMonth()] };
  });
}

/** How many payments the rows belong to: a payment split across documents is one payment. */
export function paymentCount(rows: { transaction_id: string }[]): number {
  return new Set(rows.map((row) => row.transaction_id)).size;
}
```

- [ ] **Step 5: Make `bills.ts` use the shared file**

The definitions of `isIsoDate`, `round`, `roundRate`, the `date`, `text` and `optionalId` schemas, the `line` schema and the `BillLine` type leave this file; `getBill` reads lines through `toDocumentLine`. Everything else is as it was.

Replace the whole of `src/lib/finance/bills.ts` with:

```ts
/**
 * Supplier bills. A bill and its lines are saved by one database function, so
 * a failure cannot leave half a bill. Posting gives the bill its number and
 * locks it; after that it can only be voided. org_id comes from the context.
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

// Defined in document-lines.ts, which invoices share; exported from here for this module's existing importers.
export { isIsoDate, roundRate } from './document-lines';

export const BILL_LINES_MAX = DOCUMENT_LINES_MAX;
/** Bills loaded for a screen, a page at a time. */
export const BILL_PAGE_SIZE = 1000;

export const BILL_MESSAGES = {
  supplier: 'Choose a supplier.',
  date: LINE_MESSAGES.date,
  dates: 'The due date cannot be before the bill date.',
  lines: LINE_MESSAGES.lines,
  tooManyLines: `A bill can have at most ${BILL_LINES_MAX} lines.`,
  description: LINE_MESSAGES.description,
  quantity: LINE_MESSAGES.quantity,
  price: LINE_MESSAGES.price,
  sst: LINE_MESSAGES.sst,
  tooLong: LINE_MESSAGES.tooLong,
  gone: 'That bill no longer exists.',
  locked: 'This bill is posted and can no longer be changed. Void it instead.',
  hasPayments: 'This bill has payments. Void or delete them before voiding it.',
  empty: 'A bill needs at least one line with an amount.',
  numberTaken: 'That bill number is already used.',
  missing: 'The supplier or a product on this bill no longer exists.',
  product: LINE_MESSAGES.product,
} as const;

const M = BILL_MESSAGES;

export const saveBillInput = z
  .object({
    /** Present to change a draft; absent to create one. */
    id: z.string({ error: M.gone }).uuid(M.gone).optional(),
    supplier_id: z.string({ error: M.supplier }).uuid(M.supplier),
    supplier_ref: optionalText.default(null),
    bill_date: isoDate,
    due_date: isoDate,
    notes: optionalText.default(null),
    lines: z.array(documentLine, { error: M.lines }).min(1, M.lines).max(BILL_LINES_MAX, M.tooManyLines),
  })
  .refine((v) => v.due_date >= v.bill_date, { message: M.dates, path: ['due_date'] });

export const billIdInput = z.object({ id: z.string({ error: M.gone }).uuid(M.gone) });

const REFUSALS: Record<string, string> = {
  FIN01: M.locked,
  FIN02: M.hasPayments,
  FIN10: M.empty,
  FIN11: M.gone,
  [PG_UNIQUE]: M.numberTaken,
  [PG_FOREIGN_KEY]: M.missing,
  [PG_FORBIDDEN]: NOT_ALLOWED,
  [PG_OUT_OF_RANGE]: TOO_LARGE,
};

function billWriteFailed(fnName: string, error: unknown): { ok: false; error: string } {
  const refusal = REFUSALS[pgCode(error) ?? ''];
  return refusal ? { ok: false, error: refusal } : writeFailed(fnName, error);
}

/* ---- reads ------------------------------------------------------------ */

export type BillDisplayStatus = 'draft' | 'pending' | 'overdue' | 'paid' | 'void';

export type BillListRow = {
  id: string;
  bill_no: string | null;
  supplier_id: string;
  supplier_name: string;
  bill_date: string;
  due_date: string;
  total: number;
  paid: number;
  balance: number;
  display_status: BillDisplayStatus;
};

export type BillLine = DocumentLineRow;

export type BillDetail = BillListRow & { supplier_ref: string | null; notes: string | null; lines: BillLine[] };

/**
 * The answer to "Save and post". When the draft was saved but posting it was
 * refused, `draftId` is that draft, so the form goes on editing it instead of
 * saving a second copy.
 */
export type SaveAndPostResult = FinResult<{ id: string; bill_no: string }> & { draftId?: string };

const LIST_COLUMNS = 'id,bill_no,supplier_id,supplier_name,bill_date,due_date,total,paid,balance,display_status';

function toListRow(row: Record<string, unknown>): BillListRow {
  return {
    ...(row as unknown as BillListRow),
    total: Number(row.total),
    paid: Number(row.paid),
    balance: Number(row.balance),
  };
}

/** Every bill in the workspace, newest first, read a page at a time. */
export async function listBills(ctx: FinanceWriteContext): Promise<BillListRow[]> {
  const rows: BillListRow[] = [];
  for (let from = 0; ; from += BILL_PAGE_SIZE) {
    const { data, error } = await ctx.client
      .from('supplier_bill_totals')
      .select(LIST_COLUMNS)
      .eq('org_id', ctx.orgId)
      .order('bill_date', { ascending: false })
      .order('id', { ascending: true })
      .range(from, from + BILL_PAGE_SIZE - 1);
    if (error) throw error;
    const page = (data ?? []) as unknown as Record<string, unknown>[];
    rows.push(...page.map(toListRow));
    if (page.length < BILL_PAGE_SIZE) return rows;
  }
}

/** One bill with its lines, for the form; null when it is not in this workspace or the id is not an id. */
export async function getBill(ctx: FinanceWriteContext, id: string): Promise<BillDetail | null> {
  // The database would throw on casting it; there is simply no such bill.
  if (!billIdInput.safeParse({ id }).success) return null;
  const { data: bill, error } = await ctx.client
    .from('supplier_bill_totals')
    .select(`${LIST_COLUMNS},supplier_ref,notes`)
    .eq('org_id', ctx.orgId)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!bill) return null;
  const { data: lines, error: linesError } = await ctx.client
    .from('supplier_bill_lines')
    .select(DOCUMENT_LINE_COLUMNS)
    .eq('org_id', ctx.orgId)
    .eq('bill_id', id)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true });
  if (linesError) throw linesError;
  const header = bill as unknown as Record<string, unknown>;
  return {
    ...toListRow(header),
    supplier_ref: (header.supplier_ref as string | null) ?? null,
    notes: (header.notes as string | null) ?? null,
    lines: ((lines ?? []) as unknown as Record<string, unknown>[]).map(toDocumentLine),
  };
}

/* ---- writes ----------------------------------------------------------- */

/** Creates a draft bill, or replaces a draft's header and lines. */
export async function saveBill(
  ctx: FinanceWriteContext,
  input: z.input<typeof saveBillInput>,
): Promise<FinResult<{ id: string }>> {
  const { lines, ...bill } = saveBillInput.parse(input);
  const { data, error } = await ctx.client.rpc('finance_save_bill', {
    target_org: ctx.orgId,
    bill,
    lines,
  });
  if (error || !data) return billWriteFailed('saveBill', error);
  return { ok: true, data: { id: data as string } };
}

/** Posts a draft: it gets its number and can no longer be edited. */
export async function postBill(
  ctx: FinanceWriteContext,
  input: z.input<typeof billIdInput>,
): Promise<FinResult<{ id: string; bill_no: string }>> {
  const { id } = billIdInput.parse(input);
  const { data, error } = await ctx.client.rpc('finance_post_bill', {
    target_org: ctx.orgId,
    target_bill: id,
  });
  if (error || !data) return billWriteFailed('postBill', error);
  return { ok: true, data: { id, bill_no: data as string } };
}

/** Voids a posted bill. Refused while it has payments. */
export async function voidBill(
  ctx: FinanceWriteContext,
  input: z.input<typeof billIdInput>,
): Promise<FinResult<{ id: string }>> {
  const { id } = billIdInput.parse(input);
  const { data, error } = await ctx.client
    .from('supplier_bills')
    .update({ status: 'void', updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('org_id', ctx.orgId)
    .select('id')
    .maybeSingle();
  if (error) return billWriteFailed('voidBill', error);
  if (!data) return { ok: false, error: M.gone };
  return { ok: true, data: { id: data.id } };
}

/** Deletes a draft bill and its lines. */
export async function deleteBill(
  ctx: FinanceWriteContext,
  input: z.input<typeof billIdInput>,
): Promise<FinResult<{ id: string }>> {
  const { id } = billIdInput.parse(input);
  const { data, error } = await ctx.client
    .from('supplier_bills')
    .delete()
    .eq('id', id)
    .eq('org_id', ctx.orgId)
    .select('id')
    .maybeSingle();
  if (error) return billWriteFailed('deleteBill', error);
  if (!data) return { ok: false, error: M.gone };
  return { ok: true, data: { id: data.id } };
}
```

- [ ] **Step 6: Make `purchase-views.ts` use the shared file**

`Stat`, `LATEST_ROWS`, `ELECTRONIC`, `METHOD_COLORS`, the month names, `displayDate`, `todayUtc`, `addDays`, `count`, `round2`, `sum` and `paymentCount` leave this file, and the trend's month window comes from `lastMonths`. Everything else is as it was.

Replace the whole of `src/lib/finance/purchase-views.ts` with:

```ts
/**
 * What the Supplier Bills and Payments Out screens show, worked out from the
 * rows the data layer reads. Pure, with no server imports, so the client views
 * and the tests both use it. `today` is always a YYYY-MM-DD date.
 */
import type { Slice } from '@/components/charts';
import type { BillDisplayStatus, BillListRow } from './bills';
import { toCsv } from './csv';
import { rmShort } from './format';
import { PAYMENT_METHODS, PAYMENT_METHOD_LABELS, type PaymentMethod, type PaymentOutRow } from './money';
import {
  ELECTRONIC,
  METHOD_COLORS,
  type Stat,
  addDays,
  count,
  lastMonths,
  monthOf,
  paymentCount,
  round2,
  sum,
  thousands,
} from './view-helpers';

// Defined in view-helpers.ts, which the sales screens share; exported from here for this module's existing importers.
export { LATEST_ROWS, type Stat, displayDate, todayUtc } from './view-helpers';

export type BillsViewData = {
  stats: Stat[];
  /** Open balance per supplier, the five largest. */
  bySupplier: { label: string; value: number }[];
  /** How many bills are in each status. Void bills are left out. */
  byStatus: Slice[];
};

export type PaymentsViewData = {
  stats: Stat[];
  /** The last eight months, oldest first, in RM thousands. */
  trend: { label: string; electronic: number; cash: number }[];
  /** Whether anything was paid in those eight months, however little: a small payment rounds to 0 in `trend`. */
  hasTrend: boolean;
  /** Paid this month per method, in RM. */
  byMethod: Slice[];
  paidMtd: string;
};

export const BILL_STATUS_LABELS: Record<BillDisplayStatus, string> = {
  draft: 'Draft',
  pending: 'Pending',
  overdue: 'Overdue',
  paid: 'Paid',
  void: 'Void',
};

export const PAYMENT_STATUS_LABELS: Record<PaymentOutRow['status'], string> = {
  draft: 'Draft',
  pending_approval: 'Pending approval',
  scheduled: 'Scheduled',
  posted: 'Paid',
  rejected: 'Rejected',
  void: 'Void',
};

/* ---- Supplier Bills ----------------------------------------------- */

export function billsView(bills: BillListRow[], paid: PaymentOutRow[], today: string): BillsViewData {
  const open = bills.filter((b) => b.display_status === 'pending' || b.display_status === 'overdue');
  const overdue = open.filter((b) => b.display_status === 'overdue');
  const weekEnd = addDays(today, 7);
  const dueThisWeek = open.filter((b) => b.display_status === 'pending' && b.due_date <= weekEnd);
  // Only money that has actually left counts: not scheduled, not voided.
  const paidMtd = paid.filter((p) => p.status === 'posted' && p.txn_date.slice(0, 7) === today.slice(0, 7));

  const owed = new Map<string, { label: string; value: number }>();
  for (const b of open) {
    const entry = owed.get(b.supplier_id) ?? { label: b.supplier_name, value: 0 };
    entry.value += b.balance;
    owed.set(b.supplier_id, entry);
  }
  const bySupplier = [...owed.values()]
    .map((entry) => ({ label: entry.label, value: round2(entry.value) }))
    .sort((x, y) => y.value - x.value || x.label.localeCompare(y.label))
    .slice(0, 5);

  const statusCount = (status: BillDisplayStatus) => bills.filter((b) => b.display_status === status).length;

  return {
    stats: [
      { label: 'Total payable', value: rmShort(sum(open, (b) => b.balance)), delta: count(open.length, 'open bill'), deltaTone: 'flat' },
      { label: 'Due this week', value: rmShort(sum(dueThisWeek, (b) => b.balance)), delta: count(dueThisWeek.length, 'bill'), deltaTone: 'flat' },
      { label: 'Overdue', value: rmShort(sum(overdue, (b) => b.balance)), delta: count(overdue.length, 'bill'), deltaTone: overdue.length ? 'down' : 'flat' },
      { label: 'Paid (MTD)', value: rmShort(sum(paidMtd, (p) => p.amount)), delta: count(paymentCount(paidMtd), 'payment'), deltaTone: 'flat' },
    ],
    bySupplier,
    byStatus: [
      { key: 'pending', label: 'Pending', value: statusCount('pending'), color: 'var(--chart-1)' },
      { key: 'paid', label: 'Paid', value: statusCount('paid'), color: 'var(--chart-2)' },
      { key: 'overdue', label: 'Overdue', value: statusCount('overdue'), color: 'var(--chart-4)' },
      { key: 'draft', label: 'Draft', value: statusCount('draft'), color: 'var(--chart-3)' },
    ],
  };
}

/** `open` is every bill that is not void: what the table shows until a status is chosen. */
export type BillFilter = 'open' | BillDisplayStatus;

/** Bills matching the status filter whose number or supplier contains the search text. */
export function filterBills(bills: BillListRow[], query: string, filter: BillFilter): BillListRow[] {
  const q = query.trim().toLowerCase();
  return bills.filter(
    (b) =>
      (filter === 'open' ? b.display_status !== 'void' : b.display_status === filter) &&
      `${b.bill_no ?? ''} ${b.supplier_name}`.toLowerCase().includes(q),
  );
}

/** The bills table as a CSV file. Amounts are numbers, so a spreadsheet can add them up. */
export function billsCsv(bills: BillListRow[]): string {
  return toCsv(
    ['No.', 'Date', 'Supplier', 'Due', 'Total', 'Balance', 'Status'],
    bills.map((b) => [b.bill_no, b.bill_date, b.supplier_name, b.due_date, b.total, b.balance, BILL_STATUS_LABELS[b.display_status]]),
  );
}

/* ---- Payments Out ------------------------------------------------- */

export function paymentsView(rows: PaymentOutRow[], today: string): PaymentsViewData {
  const month = today.slice(0, 7);
  const paid = rows.filter((p) => p.status === 'posted');
  const paidMtd = paid.filter((p) => p.txn_date.slice(0, 7) === month);
  const paidMtdTotal = sum(paidMtd, (p) => p.amount);
  const electronicMtd = sum(paidMtd.filter((p) => ELECTRONIC.has(p.method)), (p) => p.amount);
  const scheduled = rows.filter((p) => p.status === 'scheduled');

  // Last 8 months, oldest first, in RM thousands.
  const paidK = (list: PaymentOutRow[]) => thousands(sum(list, (p) => p.amount));
  let hasTrend = false;
  const trend = lastMonths(today).map(({ key, label }) => {
    const inMonth = paid.filter((p) => monthOf(p.txn_date) === key);
    if (inMonth.length > 0) hasTrend = true;
    return {
      label,
      electronic: paidK(inMonth.filter((p) => ELECTRONIC.has(p.method))),
      cash: paidK(inMonth.filter((p) => !ELECTRONIC.has(p.method))),
    };
  });

  const methods: Slice[] = PAYMENT_METHODS.map((method) => ({
    key: method,
    label: PAYMENT_METHOD_LABELS[method],
    value: sum(paidMtd.filter((p) => p.method === method), (p) => p.amount),
    color: METHOD_COLORS[method],
  }));
  const used = methods.filter((slice) => slice.value > 0);

  return {
    stats: [
      { label: 'Paid (MTD)', value: rmShort(paidMtdTotal), delta: 'this month', deltaTone: 'flat' },
      { label: 'Payments', value: String(paymentCount(paidMtd)), delta: 'this month', deltaTone: 'flat' },
      {
        label: 'Via bank / FPX',
        value: paidMtdTotal ? `${Math.round((electronicMtd / paidMtdTotal) * 100)}%` : '—',
        delta: 'of paid MTD',
        deltaTone: 'flat',
      },
      { label: 'Scheduled', value: rmShort(sum(scheduled, (p) => p.amount)), delta: count(paymentCount(scheduled), 'payment'), deltaTone: 'flat' },
    ],
    trend,
    hasTrend,
    // Seven empty slices would be noise; with nothing paid, all seven stay so the legend still shows.
    byMethod: used.length ? used : methods,
    paidMtd: rmShort(paidMtdTotal),
  };
}

/** `current` is paid and scheduled together: what the table shows until a status is chosen. */
export type PaymentStatusFilter = 'current' | 'all' | 'posted' | 'scheduled' | 'void';
export type PaymentMethodFilter = 'all' | PaymentMethod;

/** Rows matching both filters whose supplier, bill number, voucher number or reference contains the search text. */
export function filterPayments(
  rows: PaymentOutRow[],
  query: string,
  status: PaymentStatusFilter,
  method: PaymentMethodFilter,
): PaymentOutRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter((p) => {
    const statusOk =
      status === 'all' || (status === 'current' ? p.status === 'posted' || p.status === 'scheduled' : p.status === status);
    return (
      statusOk &&
      (method === 'all' || p.method === method) &&
      `${p.supplier_name} ${p.bill_no ?? ''} ${p.number ?? ''} ${p.reference ?? ''}`.toLowerCase().includes(q)
    );
  });
}

/**
 * The other bills the same payment pays. A payment split across bills shows
 * one row per bill, and voiding, deleting or marking paid from any of them
 * acts on the whole payment, so the question names the others.
 */
export function siblingBills(rows: PaymentOutRow[], row: PaymentOutRow): string[] {
  return rows
    .filter((other) => other.transaction_id === row.transaction_id && other.allocation_id !== row.allocation_id)
    .map((other) => other.bill_no ?? 'a draft bill')
    .sort();
}

/** "This payment also covers BILL-0007 and BILL-0008." for a split payment; empty for a payment against one bill. */
export function alsoCovers(rows: PaymentOutRow[], row: PaymentOutRow): string {
  const others = siblingBills(rows, row);
  if (others.length === 0) return '';
  const list = others.length === 1 ? others[0] : `${others.slice(0, -1).join(', ')} and ${others[others.length - 1]}`;
  return `This payment also covers ${list}.`;
}

/** The payments table as a CSV file. Amounts are numbers, so a spreadsheet can add them up. */
export function paymentsCsv(rows: PaymentOutRow[]): string {
  return toCsv(
    ['Date', 'No.', 'Supplier', 'Bill', 'Account', 'Method', 'Amount', 'Status'],
    rows.map((p) => [
      p.txn_date,
      p.number,
      p.supplier_name,
      p.bill_no,
      p.account_name,
      PAYMENT_METHOD_LABELS[p.method],
      p.amount,
      PAYMENT_STATUS_LABELS[p.status],
    ]),
  );
}
```

- [ ] **Step 7: Run the new test and every existing finance unit test**

Run: `pnpm exec vitest run tests/finance-shared.test.ts tests/finance-bills.test.ts tests/finance-money.test.ts tests/finance-schemas.test.ts tests/finance-purchase-views.test.ts tests/finance-bill-math.test.ts tests/finance-bill-form.test.ts tests/finance-payment-form.test.ts tests/finance-touchups.test.ts tests/finance-actions.test.ts`
Expected: PASS, all ten files. None of the nine existing files was edited: if one fails, the move changed behaviour; fix the moved code, not the test.

Run: `git status --short tests`
Expected: only `?? tests/finance-shared.test.ts`.

- [ ] **Step 8: Type-check, lint and commit**

Run: `pnpm exec tsc --noEmit` then `pnpm lint`
Expected: no errors.

```bash
git add src/lib/finance/document-lines.ts src/lib/finance/view-helpers.ts src/lib/finance/bills.ts src/lib/finance/purchase-views.ts tests/finance-shared.test.ts
git commit -m "refactor: share the document line schema and the view helpers between bills and invoices"
```

This task runs no database test.

---

### Task 3: Invoices data layer

**Files:**
- Create: `tests/setup/fake-finance.ts`
- Create: `tests/finance-invoices.test.ts`
- Create: `src/lib/finance/invoices.ts`

**Interfaces:**
- Consumes: `DOCUMENT_LINES_MAX`, `DOCUMENT_LINE_COLUMNS`, `DocumentLineRow`, `LINE_MESSAGES`, `documentLine`, `isoDate`, `optionalText`, `toDocumentLine` from `./document-lines`; `FinResult`, `FinanceWriteContext`, `NOT_ALLOWED`, `PG_FORBIDDEN`, `PG_FOREIGN_KEY`, `PG_OUT_OF_RANGE`, `PG_UNIQUE`, `TOO_LARGE`, `pgCode`, `writeFailed` from `./result`; the view `finance_invoice_totals`, the tables `finance_invoices` and `finance_invoice_lines`, and the functions `finance_save_invoice` and `finance_post_invoice` from Task 1.
- Produces:
  - `INVOICE_LINES_MAX = 100`, `INVOICE_PAGE_SIZE = 1000`, `INVOICE_MESSAGES`
  - `saveInvoiceInput`: `{ id?: string; customer_id: string; invoice_date: string; due_date: string; notes?: string | null; lines: DocumentLine[] }`
  - `invoiceIdInput`: `{ id: string }`
  - `type InvoiceDisplayStatus = 'draft' | 'sent' | 'overdue' | 'paid' | 'void'`
  - `type EInvoiceStatus = 'none' | 'pending' | 'validated' | 'rejected'`
  - `type InvoiceListRow = { id: string; invoice_no: string | null; customer_id: string; customer_name: string; invoice_date: string; due_date: string; total: number; paid: number; balance: number; display_status: InvoiceDisplayStatus; einvoice_status: EInvoiceStatus }`
  - `type InvoiceLine = DocumentLineRow`
  - `type InvoiceDetail = InvoiceListRow & { subtotal: number; sst: number; notes: string | null; einvoice_uuid: string | null; lines: InvoiceLine[] }`
  - `listInvoices(ctx: FinanceWriteContext): Promise<InvoiceListRow[]>`
  - `getInvoice(ctx: FinanceWriteContext, id: string): Promise<InvoiceDetail | null>`
  - `saveInvoice(ctx, input): Promise<FinResult<{ id: string }>>`
  - `postInvoice(ctx, input): Promise<FinResult<{ id: string; invoice_no: string }>>`
  - `voidInvoice(ctx, input): Promise<FinResult<{ id: string }>>`
  - `deleteInvoice(ctx, input): Promise<FinResult<{ id: string }>>`
- Produces, for tests: `fakeFinance(answer)` returning `{ ctx, calls }`, with types `FinanceCall` and `FinanceAnswer`.

There is no `set_einvoice_status` here and no server action: stage 3b adds them. Nothing in this stage calls the four write functions; they are written and tested now so 3b is forms only.

- [ ] **Step 1: Write the test helper**

The existing data-layer tests each carry a small fake client that cannot answer a paged read. This one can, and both new test files use it.

Create `tests/setup/fake-finance.ts`:

```ts
import type { FinanceWriteContext } from '@/lib/finance/result';

/** One request the data layer made: a database function, or a statement on a table or view. */
export type FinanceCall = {
  kind: 'rpc' | 'table';
  name: string;
  op: 'rpc' | 'select' | 'update' | 'delete';
  args?: Record<string, unknown>;
  values?: Record<string, unknown>;
  columns?: string;
  filters: Record<string, unknown>;
  order: string[];
  range?: [number, number];
};

export type FinanceAnswer = { data: unknown; error: unknown };

/**
 * A stand-in for the Supabase client the finance data layer is given. It
 * records every request and answers it: with the same canned answer each
 * time, or with whatever `answer(call)` returns, for reads that page or that
 * touch two tables.
 */
export function fakeFinance(answer: FinanceAnswer | ((call: FinanceCall) => FinanceAnswer)) {
  const calls: FinanceCall[] = [];
  const reply = (call: FinanceCall) => (typeof answer === 'function' ? answer(call) : answer);
  const client = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      const call: FinanceCall = { kind: 'rpc', name, op: 'rpc', args, filters: {}, order: [] };
      calls.push(call);
      return reply(call);
    },
    from(name: string) {
      const call: FinanceCall = { kind: 'table', name, op: 'select', filters: {}, order: [] };
      calls.push(call);
      const builder = {
        select(columns?: string) {
          call.columns = columns;
          return builder;
        },
        update(values: Record<string, unknown>) {
          call.op = 'update';
          call.values = values;
          return builder;
        },
        delete() {
          call.op = 'delete';
          return builder;
        },
        eq(column: string, value: unknown) {
          call.filters[column] = value;
          return builder;
        },
        order(column: string, options?: { ascending?: boolean }) {
          call.order.push(`${column} ${options?.ascending === false ? 'desc' : 'asc'}`);
          return builder;
        },
        range(from: number, to: number) {
          call.range = [from, to];
          return builder;
        },
        maybeSingle: async () => reply(call),
        then<A, B>(resolve: (value: FinanceAnswer) => A, reject?: (reason: unknown) => B) {
          return Promise.resolve(reply(call)).then(resolve, reject);
        },
      };
      return builder;
    },
  };
  return { ctx: { client: client as never, orgId: 'org-1' } satisfies FinanceWriteContext, calls };
}
```

- [ ] **Step 2: Write the failing tests**

Create `tests/finance-invoices.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  INVOICE_PAGE_SIZE,
  deleteInvoice,
  getInvoice,
  listInvoices,
  postInvoice,
  saveInvoice,
  saveInvoiceInput,
  voidInvoice,
} from '@/lib/finance/invoices';
import { fakeFinance } from './setup/fake-finance';

const ID = '33333333-3333-4333-8333-333333333333';
const CUSTOMER = '44444444-4444-4444-8444-444444444444';

const line = { description: 'Design work', quantity: 10, unit_price: 12.5 };
const valid = { customer_id: CUSTOMER, invoice_date: '2026-10-01', due_date: '2026-10-31', lines: [line] };

let logged: ReturnType<typeof vi.spyOn>;
beforeEach(() => { logged = vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { logged.mockRestore(); });

const first = (value: unknown) => saveInvoiceInput.safeParse(value).error?.issues[0]?.message;

describe('saveInvoiceInput', () => {
  it('asks for a customer', () => {
    expect(first({ ...valid, customer_id: '' })).toBe('Choose a customer.');
    expect(first({ ...valid, customer_id: undefined })).toBe('Choose a customer.');
  });
  it('asks for real dates, with the due date not before the invoice date', () => {
    expect(first({ ...valid, invoice_date: '01/10/2026' })).toBe('Enter a valid date.');
    expect(first({ ...valid, invoice_date: '2026-02-30' })).toBe('Enter a valid date.');
    expect(first({ ...valid, due_date: '2026-09-30' })).toBe('The due date cannot be before the invoice date.');
    expect(first({ ...valid, due_date: '2026-10-01' })).toBeUndefined();
  });
  it('asks for at least one line, and not more than 100', () => {
    expect(first({ ...valid, lines: [] })).toBe('Add at least one line.');
    expect(first({ ...valid, lines: Array.from({ length: 101 }, () => line) })).toBe('An invoice can have at most 100 lines.');
  });
  it('checks each line with the sentences a bill line uses', () => {
    expect(first({ ...valid, lines: [{ ...line, description: '  ' }] })).toBe('Describe each line.');
    expect(first({ ...valid, lines: [{ ...line, quantity: 0 }] })).toBe('Enter a quantity above 0.');
    expect(first({ ...valid, lines: [{ ...line, quantity: 0.0004 }] })).toBe('Enter a quantity above 0.');
    expect(first({ ...valid, lines: [{ ...line, unit_price: -1 }] })).toBe('Enter a unit price of 0 or more.');
    expect(first({ ...valid, lines: [{ ...line, sst_rate: 100.005 }] })).toBe('Enter an SST rate between 0 and 100.');
    expect(first({ ...valid, lines: [{ ...line, product_id: 'ink' }] })).toBe('Choose a product from the list, or leave it empty.');
  });
  it('rounds first, then checks: quantities to 3 decimals, prices to 4, the SST rate to 2; empties become null', () => {
    const parsed = saveInvoiceInput.parse({
      ...valid,
      notes: '  ',
      lines: [{ description: ' Design work ', quantity: 1.23456, unit_price: 0.123456, sst_rate: 1.005, uom: '', product_id: '' }],
    });
    expect(parsed.notes).toBeNull();
    expect(parsed.lines[0]).toEqual({
      product_id: null, description: 'Design work', quantity: 1.235, uom: null, pack_size: null, unit_price: 0.1235, sst_rate: 1.01,
    });
    expect(saveInvoiceInput.parse({ ...valid, lines: [{ ...line, quantity: 0.0005 }] }).lines[0].quantity).toBe(0.001);
  });
  it('has no place for an invoice number, a status or an e-Invois status: the database gives those', () => {
    const parsed = saveInvoiceInput.parse({ ...valid, invoice_no: 'INV-9999', status: 'posted', einvoice_status: 'validated' });
    expect(Object.keys(parsed).sort()).toEqual(['customer_id', 'due_date', 'invoice_date', 'lines', 'notes']);
  });
});

describe('invoice reads', () => {
  const row = (n: number) => ({
    id: `inv-${n}`, invoice_no: `INV-${n}`, customer_id: 'c1', customer_name: 'Aisyah Trading',
    invoice_date: '2026-10-01', due_date: '2026-10-31', total: '132.50', paid: '100.00', balance: '32.50',
    display_status: 'sent', einvoice_status: 'none',
  });

  it('lists from the totals view, in the caller’s workspace, newest first, with amounts as numbers', async () => {
    const { ctx, calls } = fakeFinance({ data: [row(1)], error: null });
    expect(await listInvoices(ctx)).toEqual([{ ...row(1), total: 132.5, paid: 100, balance: 32.5 }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      name: 'finance_invoice_totals',
      op: 'select',
      filters: { org_id: 'org-1' },
      order: ['invoice_date desc', 'id asc'],
      range: [0, INVOICE_PAGE_SIZE - 1],
    });
    expect(calls[0].columns).toContain('einvoice_status');
  });
  it('reads on past a full page, so a long book is never cut short', async () => {
    const full = Array.from({ length: INVOICE_PAGE_SIZE }, (_, n) => row(n));
    const { ctx, calls } = fakeFinance((call) => ({ data: call.range?.[0] === 0 ? full : [row(-1)], error: null }));
    expect(await listInvoices(ctx)).toHaveLength(INVOICE_PAGE_SIZE + 1);
    expect(calls.map((c) => c.range)).toEqual([[0, INVOICE_PAGE_SIZE - 1], [INVOICE_PAGE_SIZE, 2 * INVOICE_PAGE_SIZE - 1]]);
  });
  it('throws a read error for the screen’s error page', async () => {
    const { ctx } = fakeFinance({ data: null, error: { code: 'XX000', message: 'boom' } });
    await expect(listInvoices(ctx)).rejects.toMatchObject({ code: 'XX000' });
  });
  it('reads one invoice with its lines in the order they were entered', async () => {
    const lines = [
      { id: 'l1', product_id: null, description: 'Design work', quantity: '10.000', uom: null, pack_size: null, unit_price: '12.5000', sst_rate: '6.00', amount: '125.00', sst_amount: '7.50' },
    ];
    const { ctx, calls } = fakeFinance((call) =>
      call.name === 'finance_invoice_totals'
        ? { data: { ...row(1), subtotal: '125.00', sst: '7.50', notes: null, einvoice_uuid: null }, error: null }
        : { data: lines, error: null },
    );
    const invoice = await getInvoice(ctx, ID);
    expect(invoice).toMatchObject({ id: 'inv-1', total: 132.5, subtotal: 125, sst: 7.5, notes: null, einvoice_uuid: null });
    expect(invoice?.lines).toEqual([{ ...lines[0], quantity: 10, unit_price: 12.5, sst_rate: 6, amount: 125, sst_amount: 7.5 }]);
    expect(calls[0].filters).toEqual({ org_id: 'org-1', id: ID });
    expect(calls[1]).toMatchObject({ name: 'finance_invoice_lines', filters: { org_id: 'org-1', invoice_id: ID }, order: ['position asc', 'id asc'] });
  });
  it('answers null for an invoice that is not there, and for an id that is not an id, without asking the database', async () => {
    const missing = fakeFinance({ data: null, error: null });
    expect(await getInvoice(missing.ctx, ID)).toBeNull();
    const bad = fakeFinance({ data: null, error: null });
    expect(await getInvoice(bad.ctx, 'nope')).toBeNull();
    expect(bad.calls).toEqual([]);
  });
});

describe('invoice writes', () => {
  it('saves through the database function, in the caller’s workspace', async () => {
    const { ctx, calls } = fakeFinance({ data: ID, error: null });
    expect(await saveInvoice(ctx, { ...valid, id: ID })).toEqual({ ok: true, data: { id: ID } });
    expect(calls[0]).toMatchObject({ kind: 'rpc', name: 'finance_save_invoice' });
    expect(calls[0].args).toEqual({
      target_org: 'org-1',
      invoice: { id: ID, customer_id: CUSTOMER, invoice_date: '2026-10-01', due_date: '2026-10-31', notes: null },
      lines: [{ product_id: null, description: 'Design work', quantity: 10, uom: null, pack_size: null, unit_price: 12.5, sst_rate: 0 }],
    });
  });
  it('posts and returns the number', async () => {
    const { ctx, calls } = fakeFinance({ data: 'INV-0007', error: null });
    expect(await postInvoice(ctx, { id: ID })).toEqual({ ok: true, data: { id: ID, invoice_no: 'INV-0007' } });
    expect(calls[0]).toMatchObject({ kind: 'rpc', name: 'finance_post_invoice' });
    expect(calls[0].args).toEqual({ target_org: 'org-1', target_invoice: ID });
  });
  it('voids by setting the status and deletes a draft, both scoped to the workspace', async () => {
    const voided = fakeFinance({ data: { id: ID }, error: null });
    expect(await voidInvoice(voided.ctx, { id: ID })).toEqual({ ok: true, data: { id: ID } });
    expect(voided.calls[0]).toMatchObject({ name: 'finance_invoices', op: 'update', filters: { id: ID, org_id: 'org-1' } });
    expect(voided.calls[0].values).toMatchObject({ status: 'void' });
    expect(Object.keys(voided.calls[0].values!).sort()).toEqual(['status', 'updated_at']);

    const removed = fakeFinance({ data: { id: ID }, error: null });
    expect(await deleteInvoice(removed.ctx, { id: ID })).toEqual({ ok: true, data: { id: ID } });
    expect(removed.calls[0]).toMatchObject({ name: 'finance_invoices', op: 'delete', filters: { id: ID, org_id: 'org-1' } });
  });
  it('turns each database refusal into a sentence', async () => {
    const cases: [string, string][] = [
      ['FIN01', 'This invoice is posted and can no longer be changed. Void it instead.'],
      ['FIN02', 'This invoice has payments. Void them before voiding it.'],
      ['FIN10', 'An invoice needs at least one line with an amount.'],
      ['FIN11', 'That invoice no longer exists.'],
      ['23505', 'That invoice number is already used.'],
      ['23503', 'The customer or a product on this invoice no longer exists.'],
      ['42501', 'You do not have permission to make changes here.'],
      ['22003', 'That amount is too large.'],
    ];
    for (const [code, message] of cases) {
      const { ctx } = fakeFinance({ data: null, error: { code } });
      expect(await saveInvoice(ctx, valid), code).toEqual({ ok: false, error: message });
      expect(await postInvoice(ctx, { id: ID }), code).toEqual({ ok: false, error: message });
      expect(await voidInvoice(ctx, { id: ID }), code).toEqual({ ok: false, error: message });
      expect(await deleteInvoice(ctx, { id: ID }), code).toEqual({ ok: false, error: message });
    }
    expect(logged).not.toHaveBeenCalled();
  });
  it('says the invoice is gone when void or delete touches no row', async () => {
    const { ctx } = fakeFinance({ data: null, error: null });
    expect(await voidInvoice(ctx, { id: ID })).toEqual({ ok: false, error: 'That invoice no longer exists.' });
    expect(await deleteInvoice(ctx, { id: ID })).toEqual({ ok: false, error: 'That invoice no longer exists.' });
  });
  it('hides any other database error behind the general message and logs it', async () => {
    const { ctx } = fakeFinance({ data: null, error: { code: 'XX000' } });
    expect(await saveInvoice(ctx, valid)).toEqual({ ok: false, error: 'That change could not be saved. Please try again.' });
    expect(logged).toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run to see them fail**

Run: `pnpm exec vitest run tests/finance-invoices.test.ts`
Expected: FAIL. The file cannot be loaded: `@/lib/finance/invoices` does not exist.

- [ ] **Step 4: Write `src/lib/finance/invoices.ts`**

Create `src/lib/finance/invoices.ts`:

```ts
/**
 * Sales invoices. An invoice and its lines are saved by one database
 * function, so a failure cannot leave half an invoice. Posting gives the
 * invoice its number and locks it; after that it can only be voided, and only
 * while no money is allocated to it. org_id comes from the context.
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

export const INVOICE_LINES_MAX = DOCUMENT_LINES_MAX;
/** Invoices loaded for a screen, a page at a time. */
export const INVOICE_PAGE_SIZE = 1000;

export const INVOICE_MESSAGES = {
  customer: 'Choose a customer.',
  date: LINE_MESSAGES.date,
  dates: 'The due date cannot be before the invoice date.',
  lines: LINE_MESSAGES.lines,
  tooManyLines: `An invoice can have at most ${INVOICE_LINES_MAX} lines.`,
  description: LINE_MESSAGES.description,
  quantity: LINE_MESSAGES.quantity,
  price: LINE_MESSAGES.price,
  sst: LINE_MESSAGES.sst,
  tooLong: LINE_MESSAGES.tooLong,
  product: LINE_MESSAGES.product,
  gone: 'That invoice no longer exists.',
  locked: 'This invoice is posted and can no longer be changed. Void it instead.',
  hasPayments: 'This invoice has payments. Void them before voiding it.',
  empty: 'An invoice needs at least one line with an amount.',
  numberTaken: 'That invoice number is already used.',
  missing: 'The customer or a product on this invoice no longer exists.',
} as const;

const M = INVOICE_MESSAGES;

export const saveInvoiceInput = z
  .object({
    /** Present to change a draft; absent to create one. */
    id: z.string({ error: M.gone }).uuid(M.gone).optional(),
    customer_id: z.string({ error: M.customer }).uuid(M.customer),
    invoice_date: isoDate,
    due_date: isoDate,
    notes: optionalText.default(null),
    lines: z.array(documentLine, { error: M.lines }).min(1, M.lines).max(INVOICE_LINES_MAX, M.tooManyLines),
  })
  .refine((v) => v.due_date >= v.invoice_date, { message: M.dates, path: ['due_date'] });

export const invoiceIdInput = z.object({ id: z.string({ error: M.gone }).uuid(M.gone) });

const REFUSALS: Record<string, string> = {
  FIN01: M.locked,
  FIN02: M.hasPayments,
  FIN10: M.empty,
  FIN11: M.gone,
  [PG_UNIQUE]: M.numberTaken,
  [PG_FOREIGN_KEY]: M.missing,
  [PG_FORBIDDEN]: NOT_ALLOWED,
  [PG_OUT_OF_RANGE]: TOO_LARGE,
};

function invoiceWriteFailed(fnName: string, error: unknown): { ok: false; error: string } {
  const refusal = REFUSALS[pgCode(error) ?? ''];
  return refusal ? { ok: false, error: refusal } : writeFailed(fnName, error);
}

/* ---- reads ------------------------------------------------------------ */

/** `sent` is a posted invoice that is not yet paid in full and not past its due date. */
export type InvoiceDisplayStatus = 'draft' | 'sent' | 'overdue' | 'paid' | 'void';

/** What a person has recorded about the invoice's e-Invois at LHDN. Nothing is submitted by this app. */
export type EInvoiceStatus = 'none' | 'pending' | 'validated' | 'rejected';

export type InvoiceListRow = {
  id: string;
  /** null while the invoice is a draft. */
  invoice_no: string | null;
  customer_id: string;
  customer_name: string;
  invoice_date: string;
  due_date: string;
  total: number;
  paid: number;
  balance: number;
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

/** Every invoice in the workspace, newest first, read a page at a time. Drafts and void ones are included. */
export async function listInvoices(ctx: FinanceWriteContext): Promise<InvoiceListRow[]> {
  const rows: InvoiceListRow[] = [];
  for (let from = 0; ; from += INVOICE_PAGE_SIZE) {
    const { data, error } = await ctx.client
      .from('finance_invoice_totals')
      .select(LIST_COLUMNS)
      .eq('org_id', ctx.orgId)
      .order('invoice_date', { ascending: false })
      .order('id', { ascending: true })
      .range(from, from + INVOICE_PAGE_SIZE - 1);
    if (error) throw error;
    const page = (data ?? []) as unknown as Record<string, unknown>[];
    rows.push(...page.map(toListRow));
    if (page.length < INVOICE_PAGE_SIZE) return rows;
  }
}

/** One invoice with its lines in the order they were entered; null when it is not in this workspace or the id is not an id. */
export async function getInvoice(ctx: FinanceWriteContext, id: string): Promise<InvoiceDetail | null> {
  // The database would throw on casting it; there is simply no such invoice.
  if (!invoiceIdInput.safeParse({ id }).success) return null;
  const { data: invoice, error } = await ctx.client
    .from('finance_invoice_totals')
    .select(`${LIST_COLUMNS},subtotal,sst,notes,einvoice_uuid`)
    .eq('org_id', ctx.orgId)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!invoice) return null;
  const { data: lines, error: linesError } = await ctx.client
    .from('finance_invoice_lines')
    .select(DOCUMENT_LINE_COLUMNS)
    .eq('org_id', ctx.orgId)
    .eq('invoice_id', id)
    .order('position', { ascending: true })
    .order('id', { ascending: true });
  if (linesError) throw linesError;
  const header = invoice as unknown as Record<string, unknown>;
  return {
    ...toListRow(header),
    subtotal: Number(header.subtotal),
    sst: Number(header.sst),
    notes: (header.notes as string | null) ?? null,
    einvoice_uuid: (header.einvoice_uuid as string | null) ?? null,
    lines: ((lines ?? []) as unknown as Record<string, unknown>[]).map(toDocumentLine),
  };
}

/* ---- writes ----------------------------------------------------------- */

/** Creates a draft invoice, or replaces a draft's header and lines. */
export async function saveInvoice(
  ctx: FinanceWriteContext,
  input: z.input<typeof saveInvoiceInput>,
): Promise<FinResult<{ id: string }>> {
  const { lines, ...invoice } = saveInvoiceInput.parse(input);
  const { data, error } = await ctx.client.rpc('finance_save_invoice', {
    target_org: ctx.orgId,
    invoice,
    lines,
  });
  if (error || !data) return invoiceWriteFailed('saveInvoice', error);
  return { ok: true, data: { id: data as string } };
}

/** Posts a draft: it gets its number and can no longer be edited. */
export async function postInvoice(
  ctx: FinanceWriteContext,
  input: z.input<typeof invoiceIdInput>,
): Promise<FinResult<{ id: string; invoice_no: string }>> {
  const { id } = invoiceIdInput.parse(input);
  const { data, error } = await ctx.client.rpc('finance_post_invoice', {
    target_org: ctx.orgId,
    target_invoice: id,
  });
  if (error || !data) return invoiceWriteFailed('postInvoice', error);
  return { ok: true, data: { id, invoice_no: data as string } };
}

/** Voids a posted invoice. Refused while it has payments. */
export async function voidInvoice(
  ctx: FinanceWriteContext,
  input: z.input<typeof invoiceIdInput>,
): Promise<FinResult<{ id: string }>> {
  const { id } = invoiceIdInput.parse(input);
  const { data, error } = await ctx.client
    .from('finance_invoices')
    .update({ status: 'void', updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('org_id', ctx.orgId)
    .select('id')
    .maybeSingle();
  if (error) return invoiceWriteFailed('voidInvoice', error);
  if (!data) return { ok: false, error: M.gone };
  return { ok: true, data: { id: data.id } };
}

/** Deletes a draft invoice and its lines. */
export async function deleteInvoice(
  ctx: FinanceWriteContext,
  input: z.input<typeof invoiceIdInput>,
): Promise<FinResult<{ id: string }>> {
  const { id } = invoiceIdInput.parse(input);
  const { data, error } = await ctx.client
    .from('finance_invoices')
    .delete()
    .eq('id', id)
    .eq('org_id', ctx.orgId)
    .select('id')
    .maybeSingle();
  if (error) return invoiceWriteFailed('deleteInvoice', error);
  if (!data) return { ok: false, error: M.gone };
  return { ok: true, data: { id: data.id } };
}
```

- [ ] **Step 5: Run the tests**

Run: `pnpm exec vitest run tests/finance-invoices.test.ts`
Expected: PASS, every test.

- [ ] **Step 6: Type-check, lint and commit**

Run: `pnpm exec tsc --noEmit` then `pnpm lint`
Expected: no errors.

```bash
git add src/lib/finance/invoices.ts tests/setup/fake-finance.ts tests/finance-invoices.test.ts
git commit -m "feat: invoices data layer: list, read, save, post, void and delete"
```

Database tests this task may run: none are needed. If the controller has confirmed Task 1 step 12, `pnpm exec vitest run tests/bendahara-sales.test.ts` may be run and passes (all but its last test until step 13).

---

### Task 4: Payments in data layer, the Customer sentence, and the schema test

**Files:**
- Create: `tests/finance-payments-in.test.ts`
- Modify: `src/lib/finance/money.ts` (whole file replaced)
- Modify: `src/lib/finance/contacts.ts` (two lines added)
- Modify: `tests/finance-contacts.test.ts` (one test added)
- Modify: `tests/finance-schemas.test.ts` (imports and seven cases added)

**Interfaces:**
- Consumes: the view `finance_payments_in` and the function `finance_record_payment_in` from Task 1; `saveInvoiceInput`, `invoiceIdInput` from Task 3 (in the schema test).
- Produces, new in `money.ts`:
  - `PAYMENT_INVOICES_MAX = 50`
  - `RECEIPT_MESSAGES: { account, date, method, invoices, tooManyInvoices, amount, duplicate, tooLong, gone, overSplit, notPosted, tooMuch, oneCustomer, locked, missing }`
  - `recordPaymentInInput`: `{ account_id: string; txn_date: string; method: PaymentMethod; reference?: string | null; notes?: string | null; allocations: { invoice_id: string; amount: number }[] }`
  - `type PaymentInRow = { allocation_id: string; transaction_id: string; number: string | null; txn_date: string; method: PaymentMethod; amount: number; transaction_amount: number; status: 'draft' | 'pending_approval' | 'scheduled' | 'posted' | 'rejected' | 'void'; reference: string | null; account_id: string; account_name: string; invoice_id: string; invoice_no: string | null; customer_name: string }`
  - `listPaymentsIn(ctx: FinanceWriteContext): Promise<PaymentInRow[]>`
  - `recordPaymentIn(ctx, input): Promise<FinResult<{ id: string }>>`
- Unchanged in `money.ts`: every existing export, with the same behaviour. `PaymentOutRow` is the same type; `listPaymentsOut` selects the same columns from the same view in the same order.
- **Voiding a payment in is `voidPayment(ctx, { id })`, unchanged.** It sets `status = 'void'` on `finance_transactions` by id and workspace and never mentions a direction; the database's transaction guard allows posted to void for any direction. Its sentences (`MONEY_MESSAGES.locked`, `.gone`) speak of "payment", not of bills, so they read correctly for money in. There is no `deletePaymentIn`: a payment in is never anything but posted or void.
- Produces: `CONTACT_MESSAGES.hasInvoices`; `FIN08` mapped to it in `contactWriteFailed`.

- [ ] **Step 1: Write the failing tests**

Create `tests/finance-payments-in.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PAYMENT_PAGE_SIZE,
  listPaymentsIn,
  listPaymentsOut,
  recordPaymentIn,
  recordPaymentInInput,
  recordPaymentOut,
  voidPayment,
} from '@/lib/finance/money';
import { fakeFinance } from './setup/fake-finance';

const TXN = '55555555-5555-4555-8555-555555555555';
const ACCOUNT = '66666666-6666-4666-8666-666666666666';
const INVOICE_1 = '77777777-7777-4777-8777-777777777777';
const INVOICE_2 = '88888888-8888-4888-8888-888888888888';

const valid = {
  account_id: ACCOUNT,
  txn_date: '2026-10-05',
  method: 'fpx' as const,
  allocations: [{ invoice_id: INVOICE_1, amount: 100 }],
};

let logged: ReturnType<typeof vi.spyOn>;
beforeEach(() => { logged = vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { logged.mockRestore(); });

const first = (value: unknown) => recordPaymentInInput.safeParse(value).error?.issues[0]?.message;

describe('recordPaymentInInput', () => {
  it('asks for an account, a real date and a known method', () => {
    expect(first({ ...valid, account_id: '' })).toBe('Choose the account the money went into.');
    expect(first({ ...valid, txn_date: '5 Oct' })).toBe('Enter a valid date.');
    expect(first({ ...valid, method: 'barter' })).toBe('Choose how it was paid.');
  });
  it('asks for at least one invoice, each once, each with an amount above 0, and at most 50', () => {
    expect(first({ ...valid, allocations: [] })).toBe('Choose at least one invoice this payment is for.');
    expect(first({ ...valid, allocations: [{ invoice_id: 'x', amount: 1 }] })).toBe('Choose at least one invoice this payment is for.');
    expect(first({ ...valid, allocations: [{ invoice_id: INVOICE_1, amount: 0 }] })).toBe('Enter an amount above 0.');
    expect(first({ ...valid, allocations: [{ invoice_id: INVOICE_1, amount: 1 }, { invoice_id: INVOICE_1, amount: 2 }] }))
      .toBe('Each invoice can appear once on a payment.');
    const many = Array.from({ length: 51 }, (_, n) => ({
      invoice_id: `99999999-9999-4999-8999-${String(n).padStart(12, '0')}`,
      amount: 1,
    }));
    expect(first({ ...valid, allocations: many })).toBe('One payment can cover at most 50 invoices.');
  });
  it('rounds first, then checks: an amount that rounds to 0 is refused and half a sen rounds up', () => {
    expect(first({ ...valid, allocations: [{ invoice_id: INVOICE_1, amount: 0.004 }] })).toBe('Enter an amount above 0.');
    const parsed = recordPaymentInInput.parse({ ...valid, reference: ' ', allocations: [{ invoice_id: INVOICE_1, amount: 0.005 }] });
    expect(parsed.allocations).toEqual([{ invoice_id: INVOICE_1, amount: 0.01 }]);
    expect(parsed).toMatchObject({ reference: null, notes: null });
  });
  it('has no "scheduled": money in is recorded once it has arrived', () => {
    expect(Object.keys(recordPaymentInInput.parse({ ...valid, scheduled: true, status: 'scheduled' })).sort()).toEqual([
      'account_id', 'allocations', 'method', 'notes', 'reference', 'txn_date',
    ]);
  });
});

describe('payments in', () => {
  it('records through the database function, in the caller’s workspace, split across two invoices', async () => {
    const { ctx, calls } = fakeFinance({ data: TXN, error: null });
    const result = await recordPaymentIn(ctx, {
      ...valid,
      allocations: [{ invoice_id: INVOICE_1, amount: 100 }, { invoice_id: INVOICE_2, amount: 32.5 }],
    });
    expect(result).toEqual({ ok: true, data: { id: TXN } });
    expect(calls[0]).toMatchObject({ kind: 'rpc', name: 'finance_record_payment_in' });
    expect(calls[0].args).toEqual({
      target_org: 'org-1',
      payment: { account_id: ACCOUNT, txn_date: '2026-10-05', method: 'fpx', reference: null, notes: null },
      allocations: [{ invoice_id: INVOICE_1, amount: 100 }, { invoice_id: INVOICE_2, amount: 32.5 }],
    });
  });
  it('words each database refusal for invoices and customers', async () => {
    const cases: [string, string][] = [
      ['FIN03', 'The amounts against the invoices add up to more than the payment.'],
      ['FIN04', 'A payment can only go against a posted invoice.'],
      ['FIN05', 'That is more than is still owed on an invoice.'],
      ['FIN06', 'One payment can only pay invoices from one customer.'],
      ['FIN09', 'This payment is posted and can no longer be changed. Void it instead.'],
      ['FIN11', 'That payment no longer exists.'],
      ['23503', 'The account or an invoice on this payment no longer exists.'],
      ['42501', 'You do not have permission to make changes here.'],
      ['22003', 'That amount is too large.'],
    ];
    for (const [code, message] of cases) {
      const { ctx } = fakeFinance({ data: null, error: { code } });
      expect(await recordPaymentIn(ctx, valid), code).toEqual({ ok: false, error: message });
    }
    expect(logged).not.toHaveBeenCalled();
  });
  it('leaves a payment out’s sentences about bills and suppliers as they were', async () => {
    const out = { account_id: ACCOUNT, txn_date: '2026-10-05', method: 'fpx' as const, allocations: [{ bill_id: INVOICE_1, amount: 1 }] };
    const refused = async (code: string) => recordPaymentOut(fakeFinance({ data: null, error: { code } }).ctx, out);
    expect(await refused('FIN04')).toEqual({ ok: false, error: 'A payment can only go against a posted bill.' });
    expect(await refused('FIN06')).toEqual({ ok: false, error: 'One payment can only pay bills from one supplier.' });
  });
  it('is voided by the same status change as a payment out', async () => {
    const { ctx, calls } = fakeFinance({ data: { id: TXN }, error: null });
    expect(await voidPayment(ctx, { id: TXN })).toEqual({ ok: true, data: { id: TXN } });
    expect(calls[0]).toMatchObject({ name: 'finance_transactions', op: 'update', filters: { id: TXN, org_id: 'org-1' } });
    expect(calls[0].values).toMatchObject({ status: 'void' });
  });
  it('hides any other database error behind the general message and logs it', async () => {
    const { ctx } = fakeFinance({ data: null, error: { code: 'XX000' } });
    expect(await recordPaymentIn(ctx, valid)).toEqual({ ok: false, error: 'That change could not be saved. Please try again.' });
    expect(logged).toHaveBeenCalled();
  });
});

describe('payment reads', () => {
  const row = (n: number) => ({
    allocation_id: `alloc-${n}`, transaction_id: 'txn-1', number: 'RC-0001', txn_date: '2026-10-05', method: 'fpx',
    amount: '60.00', transaction_amount: '100.00', status: 'posted', reference: null, account_id: 'bank',
    account_name: 'Main Bank', invoice_id: `inv-${n}`, invoice_no: `INV-000${n}`, customer_name: 'Aisyah Trading',
  });

  it('lists payments in from their view, one row per invoice, with amounts as numbers', async () => {
    const { ctx, calls } = fakeFinance({ data: [row(1), row(2)], error: null });
    const rows = await listPaymentsIn(ctx);
    expect(rows).toEqual([
      { ...row(1), amount: 60, transaction_amount: 100 },
      { ...row(2), amount: 60, transaction_amount: 100 },
    ]);
    expect(calls[0]).toMatchObject({
      name: 'finance_payments_in',
      filters: { org_id: 'org-1' },
      order: ['txn_date desc', 'allocation_id asc'],
      range: [0, PAYMENT_PAGE_SIZE - 1],
    });
    expect(calls[0].columns).toBe(
      'allocation_id,transaction_id,number,txn_date,method,amount,transaction_amount,status,reference,account_id,account_name,invoice_id,invoice_no,customer_name',
    );
  });
  it('reads on past a full page', async () => {
    const full = Array.from({ length: PAYMENT_PAGE_SIZE }, (_, n) => row(n));
    const { ctx, calls } = fakeFinance((call) => ({ data: call.range?.[0] === 0 ? full : [], error: null }));
    expect(await listPaymentsIn(ctx)).toHaveLength(PAYMENT_PAGE_SIZE);
    expect(calls).toHaveLength(2);
  });
  it('still lists payments out from their own view with the same columns as before', async () => {
    const { ctx, calls } = fakeFinance({ data: [], error: null });
    expect(await listPaymentsOut(ctx)).toEqual([]);
    expect(calls[0]).toMatchObject({ name: 'finance_payments_out', order: ['txn_date desc', 'allocation_id asc'] });
    expect(calls[0].columns).toBe(
      'allocation_id,transaction_id,number,txn_date,method,amount,transaction_amount,status,reference,account_id,account_name,bill_id,bill_no,supplier_name',
    );
  });
  it('throws a read error for the screen’s error page', async () => {
    const { ctx } = fakeFinance({ data: null, error: { code: 'XX000', message: 'boom' } });
    await expect(listPaymentsIn(ctx)).rejects.toMatchObject({ code: 'XX000' });
  });
});
```

Add a test to `tests/finance-contacts.test.ts`, inside `describe('contact writes', …)`, above the test that hides other database errors.

In `tests/finance-contacts.test.ts`, replace:

```ts
  it('hides any other database error behind a general message and logs it', async () => {
    const { ctx } = fakeClient({ data: null, error: { code: 'XX000', message: 'boom' } });
```

with:

```ts
  it('explains that a customer with invoices cannot stop being a customer', async () => {
    const { ctx } = fakeClient({ data: null, error: { code: 'FIN08' } });
    expect(await updateContact(ctx, { id: ID, is_customer: false, is_supplier: true })).toEqual({
      ok: false,
      error: 'This contact has invoices, so it has to stay a customer.',
    });
    expect(logged).not.toHaveBeenCalled();
  });
  it('hides any other database error behind a general message and logs it', async () => {
    const { ctx } = fakeClient({ data: null, error: { code: 'XX000', message: 'boom' } });
```

Add the new schemas to `tests/finance-schemas.test.ts`: the imports, then seven cases at the end of the `cases` list.

In `tests/finance-schemas.test.ts`, replace:

```ts
import { createContactInput, updateContactInput } from '@/lib/finance/contacts';
import { markPaymentPaidInput, paymentIdInput, recordPaymentOutInput } from '@/lib/finance/money';
```

with:

```ts
import { createContactInput, updateContactInput } from '@/lib/finance/contacts';
import { invoiceIdInput, saveInvoiceInput } from '@/lib/finance/invoices';
import { markPaymentPaidInput, paymentIdInput, recordPaymentInInput, recordPaymentOutInput } from '@/lib/finance/money';
```

In `tests/finance-schemas.test.ts`, replace:

```ts
    lines: [{ description: 'Gloves', quantity: 1, unit_price: 10, sst_rate: 1.005 }, { description: 'Ink', quantity: 1, unit_price: 10, sst_rate: 0.145 }],
  }],
];
```

with:

```ts
    lines: [{ description: 'Gloves', quantity: 1, unit_price: 10, sst_rate: 1.005 }, { description: 'Ink', quantity: 1, unit_price: 10, sst_rate: 0.145 }],
  }],
  ['saveInvoiceInput', saveInvoiceInput, {
    customer_id: ID, invoice_date: '2026-10-01', due_date: '2026-10-31', notes: '',
    lines: [{ description: ' Design work ', quantity: 1.23456, unit_price: 0.123456, uom: '', product_id: '' }],
  }],
  ['saveInvoiceInput (smallest quantity, an SST rate with three decimals)', saveInvoiceInput, {
    customer_id: ID, invoice_date: '2026-10-01', due_date: '2026-10-31',
    lines: [{ description: 'Design work', quantity: 0.0005, unit_price: 10, sst_rate: 1.005 }, { description: 'Hosting', quantity: 1, unit_price: 10, sst_rate: 0.145 }],
  }],
  ['saveInvoiceInput (a draft being changed, with a product)', saveInvoiceInput, {
    id: ID, customer_id: ID, invoice_date: '2026-10-01', due_date: '2026-10-01', notes: ' Net 30 ',
    lines: [{ product_id: ID, description: 'Ink', quantity: 2, uom: ' box ', pack_size: ' box of 4 ', unit_price: 14.5, sst_rate: 6 }],
  }],
  ['invoiceIdInput', invoiceIdInput, { id: ID }],
  ['recordPaymentInInput', recordPaymentInInput, {
    account_id: ID, txn_date: '2026-10-05', method: 'fpx', reference: ' ',
    allocations: [{ invoice_id: ID, amount: 32.506 }],
  }],
  ['recordPaymentInInput (smallest amount)', recordPaymentInInput, {
    account_id: ID, txn_date: '2026-10-05', method: 'fpx',
    allocations: [{ invoice_id: ID, amount: 0.005 }],
  }],
  ['recordPaymentInInput (two invoices, a reference and a note)', recordPaymentInInput, {
    account_id: ID, txn_date: '2026-10-20', method: 'cheque', reference: ' CHQ 001 ', notes: ' banked ',
    allocations: [{ invoice_id: ID, amount: 10.005 }, { invoice_id: '22222222-2222-4222-8222-222222222222', amount: 5 }],
  }],
];
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm exec vitest run tests/finance-payments-in.test.ts tests/finance-contacts.test.ts tests/finance-schemas.test.ts`
Expected: FAIL. In `finance-payments-in` and `finance-schemas`, every test that uses `recordPaymentInInput`, `recordPaymentIn` or `listPaymentsIn` fails: `money.ts` does not export them yet, so they are `undefined`. The new contacts test fails with the general message in place of the sentence.

- [ ] **Step 3: Replace `src/lib/finance/money.ts`**

What changes: the header comment; `PAYMENT_INVOICES_MAX`; `RECEIPT_MESSAGES`; `recordPaymentInInput`; a second refusal map and an optional third argument on `moneyWriteFailed`; `PaymentInRow`; `listPaymentsOut` now calls a private `listPaymentRows` that `listPaymentsIn` shares; `recordPaymentIn`; the comment on `voidPayment`. Nothing an existing caller sees is different.

Replace the whole of `src/lib/finance/money.ts` with:

```ts
/**
 * Money moving in and out. Each movement is one finance_transactions row,
 * split across the documents it pays by finance_allocations: a payment out
 * against one supplier's bills, or a payment in against one customer's
 * invoices. A posted payment is locked and can only be voided; a scheduled
 * payment out can be deleted. Money in is never scheduled: it is recorded
 * once it has arrived.
 */
import { z } from 'zod';
import { isIsoDate } from './bills';
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

export const PAYMENT_METHODS = ['bank_transfer', 'fpx', 'duitnow', 'card', 'ewallet', 'cash', 'cheque'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  bank_transfer: 'Bank Transfer',
  fpx: 'FPX',
  duitnow: 'DuitNow',
  card: 'Card',
  ewallet: 'E-Wallet',
  cash: 'Cash',
  cheque: 'Cheque',
};

export const PAYMENT_BILLS_MAX = 50;
export const PAYMENT_INVOICES_MAX = 50;
export const PAYMENT_PAGE_SIZE = 1000;

export const MONEY_MESSAGES = {
  account: 'Choose the account the money leaves.',
  date: 'Enter a valid date.',
  method: 'Choose how it was paid.',
  bills: 'Choose at least one bill to pay.',
  tooManyBills: `One payment can cover at most ${PAYMENT_BILLS_MAX} bills.`,
  amount: 'Enter an amount above 0.',
  duplicate: 'Each bill can appear once on a payment.',
  tooLong: 'That is too long. Keep it to 200 characters or fewer.',
  gone: 'That payment no longer exists.',
  overSplit: 'The amounts against the bills add up to more than the payment.',
  notPosted: 'A payment can only go against a posted bill.',
  tooMuch: 'That is more than is still owed on a bill.',
  oneSupplier: 'One payment can only pay bills from one supplier.',
  locked: 'This payment is posted and can no longer be changed. Void it instead.',
  missing: 'The account or a bill on this payment no longer exists.',
} as const;

const M = MONEY_MESSAGES;

/** The sentences of a payment in. Where a payment out says the same thing, it is the same sentence. */
export const RECEIPT_MESSAGES = {
  account: 'Choose the account the money went into.',
  date: M.date,
  method: M.method,
  invoices: 'Choose at least one invoice this payment is for.',
  tooManyInvoices: `One payment can cover at most ${PAYMENT_INVOICES_MAX} invoices.`,
  amount: M.amount,
  duplicate: 'Each invoice can appear once on a payment.',
  tooLong: M.tooLong,
  gone: M.gone,
  overSplit: 'The amounts against the invoices add up to more than the payment.',
  notPosted: 'A payment can only go against a posted invoice.',
  tooMuch: 'That is more than is still owed on an invoice.',
  oneCustomer: 'One payment can only pay invoices from one customer.',
  locked: M.locked,
  missing: 'The account or an invoice on this payment no longer exists.',
} as const;

const R = RECEIPT_MESSAGES;

const date = z.string({ error: M.date }).refine(isIsoDate, M.date);
const text = z
  .string({ error: M.tooLong })
  .trim()
  .max(200, M.tooLong)
  .transform((v) => (v === '' ? null : v))
  .nullable();
const amount = z
  .number({ error: M.amount })
  .transform((v) => Math.round(v * 100) / 100)
  .pipe(z.number().gt(0, M.amount).max(999_999_999_999.99, M.amount));
const id = z.string({ error: M.gone }).uuid(M.gone);

export const recordPaymentOutInput = z.object({
  account_id: z.string({ error: M.account }).uuid(M.account),
  txn_date: date,
  method: z.enum(PAYMENT_METHODS, { error: M.method }),
  reference: text.default(null),
  notes: text.default(null),
  /** True for a payment to be made later; it does not reduce the bill until marked paid. */
  scheduled: z.boolean().default(false),
  allocations: z
    .array(z.object({ bill_id: z.string({ error: M.bills }).uuid(M.bills), amount }), { error: M.bills })
    .min(1, M.bills)
    .max(PAYMENT_BILLS_MAX, M.tooManyBills)
    .refine((rows) => new Set(rows.map((r) => r.bill_id)).size === rows.length, M.duplicate),
});

/** Money received from one customer, split across that customer's posted invoices. It is posted at once. */
export const recordPaymentInInput = z.object({
  account_id: z.string({ error: R.account }).uuid(R.account),
  txn_date: date,
  method: z.enum(PAYMENT_METHODS, { error: R.method }),
  reference: text.default(null),
  notes: text.default(null),
  allocations: z
    .array(z.object({ invoice_id: z.string({ error: R.invoices }).uuid(R.invoices), amount }), { error: R.invoices })
    .min(1, R.invoices)
    .max(PAYMENT_INVOICES_MAX, R.tooManyInvoices)
    .refine((rows) => new Set(rows.map((r) => r.invoice_id)).size === rows.length, R.duplicate),
});

export const markPaymentPaidInput = z.object({ id, paid_on: date });
export const paymentIdInput = z.object({ id });

const REFUSALS: Record<string, string> = {
  FIN03: M.overSplit,
  FIN04: M.notPosted,
  FIN05: M.tooMuch,
  FIN06: M.oneSupplier,
  FIN09: M.locked,
  FIN11: M.gone,
  [PG_FOREIGN_KEY]: M.missing,
  [PG_FORBIDDEN]: NOT_ALLOWED,
  [PG_OUT_OF_RANGE]: TOO_LARGE,
};

/** The same database codes, worded for money in: the documents are invoices and the party is a customer. */
const RECEIPT_REFUSALS: Record<string, string> = {
  ...REFUSALS,
  FIN03: R.overSplit,
  FIN04: R.notPosted,
  FIN05: R.tooMuch,
  FIN06: R.oneCustomer,
  [PG_FOREIGN_KEY]: R.missing,
};

function moneyWriteFailed(
  fnName: string,
  error: unknown,
  refusals: Record<string, string> = REFUSALS,
): { ok: false; error: string } {
  const refusal = refusals[pgCode(error) ?? ''];
  return refusal ? { ok: false, error: refusal } : writeFailed(fnName, error);
}

/* ---- reads ------------------------------------------------------------ */

export type FinanceAccount = { id: string; name: string; kind: 'bank' | 'cash'; bank_name: string | null };

/** The workspace's active accounts, for the "paid from" picker. */
export async function listAccounts(ctx: FinanceWriteContext): Promise<FinanceAccount[]> {
  const { data, error } = await ctx.client
    .from('finance_accounts')
    .select('id,name,kind,bank_name')
    .eq('org_id', ctx.orgId)
    .eq('active', true)
    .order('kind', { ascending: true })
    .order('name', { ascending: true });
  if (error) throw error;
  return (data ?? []) as unknown as FinanceAccount[];
}

type TransactionStatus = 'draft' | 'pending_approval' | 'scheduled' | 'posted' | 'rejected' | 'void';

/** One row per bill a payment out pays. A voided payment is included; callers filter. */
export type PaymentOutRow = {
  allocation_id: string;
  transaction_id: string;
  number: string | null;
  txn_date: string;
  method: PaymentMethod;
  amount: number;
  transaction_amount: number;
  status: TransactionStatus;
  reference: string | null;
  account_id: string;
  account_name: string;
  bill_id: string;
  bill_no: string | null;
  supplier_name: string;
};

/**
 * One row per invoice a payment in pays. `allocation_id` is the row's key: a
 * payment split across invoices is several rows with one `transaction_id`,
 * whose amounts add up to `transaction_amount`. A voided payment is included;
 * callers filter.
 */
export type PaymentInRow = {
  allocation_id: string;
  transaction_id: string;
  number: string | null;
  txn_date: string;
  method: PaymentMethod;
  amount: number;
  transaction_amount: number;
  status: TransactionStatus;
  reference: string | null;
  account_id: string;
  account_name: string;
  invoice_id: string;
  invoice_no: string | null;
  customer_name: string;
};

const PAYMENT_COLUMNS =
  'allocation_id,transaction_id,number,txn_date,method,amount,transaction_amount,status,reference,account_id,account_name';
const PAYMENT_OUT_COLUMNS = `${PAYMENT_COLUMNS},bill_id,bill_no,supplier_name`;
const PAYMENT_IN_COLUMNS = `${PAYMENT_COLUMNS},invoice_id,invoice_no,customer_name`;

/** Every row of one of the two payment views, newest first, read a page at a time. */
async function listPaymentRows<T extends { amount: number; transaction_amount: number }>(
  ctx: FinanceWriteContext,
  view: 'finance_payments_out' | 'finance_payments_in',
  columns: string,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAYMENT_PAGE_SIZE) {
    const { data, error } = await ctx.client
      .from(view)
      .select(columns)
      .eq('org_id', ctx.orgId)
      .order('txn_date', { ascending: false })
      .order('allocation_id', { ascending: true })
      .range(from, from + PAYMENT_PAGE_SIZE - 1);
    if (error) throw error;
    const page = (data ?? []) as unknown as Record<string, unknown>[];
    rows.push(
      ...page.map((r) => ({
        ...(r as unknown as T),
        amount: Number(r.amount),
        transaction_amount: Number(r.transaction_amount),
      })),
    );
    if (page.length < PAYMENT_PAGE_SIZE) return rows;
  }
}

export async function listPaymentsOut(ctx: FinanceWriteContext): Promise<PaymentOutRow[]> {
  return listPaymentRows<PaymentOutRow>(ctx, 'finance_payments_out', PAYMENT_OUT_COLUMNS);
}

export async function listPaymentsIn(ctx: FinanceWriteContext): Promise<PaymentInRow[]> {
  return listPaymentRows<PaymentInRow>(ctx, 'finance_payments_in', PAYMENT_IN_COLUMNS);
}

/* ---- writes ----------------------------------------------------------- */

/** Records a payment out, paid now or scheduled, split across one supplier's bills. */
export async function recordPaymentOut(
  ctx: FinanceWriteContext,
  input: z.input<typeof recordPaymentOutInput>,
): Promise<FinResult<{ id: string }>> {
  const { allocations, scheduled, ...payment } = recordPaymentOutInput.parse(input);
  const { data, error } = await ctx.client.rpc('finance_record_payment_out', {
    target_org: ctx.orgId,
    payment: { ...payment, status: scheduled ? 'scheduled' : 'posted' },
    allocations,
  });
  if (error || !data) return moneyWriteFailed('recordPaymentOut', error);
  return { ok: true, data: { id: data as string } };
}

/** Records money received from one customer, split across that customer's posted invoices. It is posted at once. */
export async function recordPaymentIn(
  ctx: FinanceWriteContext,
  input: z.input<typeof recordPaymentInInput>,
): Promise<FinResult<{ id: string }>> {
  const { allocations, ...payment } = recordPaymentInInput.parse(input);
  const { data, error } = await ctx.client.rpc('finance_record_payment_in', {
    target_org: ctx.orgId,
    payment,
    allocations,
  });
  if (error || !data) return moneyWriteFailed('recordPaymentIn', error, RECEIPT_REFUSALS);
  return { ok: true, data: { id: data as string } };
}

/** A scheduled payment has now been made: it gets its number and reduces the bill. */
export async function markPaymentPaid(
  ctx: FinanceWriteContext,
  input: z.input<typeof markPaymentPaidInput>,
): Promise<FinResult<{ id: string; number: string }>> {
  const { id: txnId, paid_on } = markPaymentPaidInput.parse(input);
  const { data, error } = await ctx.client.rpc('finance_mark_payment_paid', {
    target_org: ctx.orgId,
    target_txn: txnId,
    paid_on,
  });
  if (error || !data) return moneyWriteFailed('markPaymentPaid', error);
  return { ok: true, data: { id: txnId, number: data as string } };
}

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
  if (error) return moneyWriteFailed('deleteScheduledPayment', error);
  if (!data) return { ok: false, error: M.gone };
  return { ok: true, data: { id: data.id } };
}
```

- [ ] **Step 4: Add the Customer sentence to `src/lib/finance/contacts.ts`**

In `src/lib/finance/contacts.ts`, replace:

```ts
  hasBills: 'This contact has supplier bills, so it has to stay a supplier.',
```

with:

```ts
  hasBills: 'This contact has supplier bills, so it has to stay a supplier.',
  hasInvoices: 'This contact has invoices, so it has to stay a customer.',
```

In `src/lib/finance/contacts.ts`, replace:

```ts
  if (code === 'FIN07') return { ok: false, error: M.hasBills };
```

with:

```ts
  if (code === 'FIN07') return { ok: false, error: M.hasBills };
  if (code === 'FIN08') return { ok: false, error: M.hasInvoices };
```

- [ ] **Step 5: Run the tests**

Run: `pnpm exec vitest run tests/finance-payments-in.test.ts tests/finance-contacts.test.ts tests/finance-schemas.test.ts tests/finance-money.test.ts tests/finance-touchups.test.ts tests/finance-actions.test.ts tests/finance-payment-form.test.ts tests/finance-purchase-views.test.ts`
Expected: PASS, all eight files. `tests/finance-money.test.ts` was not edited and still passes: money out is unchanged. If a `finance-schemas` case fails, a transform is not idempotent; fix the schema, not the test.

- [ ] **Step 6: Type-check, lint and commit**

Run: `pnpm exec tsc --noEmit` then `pnpm lint`
Expected: no errors.

```bash
git add src/lib/finance/money.ts src/lib/finance/contacts.ts tests/finance-payments-in.test.ts tests/finance-contacts.test.ts tests/finance-schemas.test.ts
git commit -m "feat: money in data layer: list and record payments in; refuse unticking Customer on a contact with invoices"
```

Database tests this task may run: `tests/bendahara-purchases.test.ts`, at any time (its schema has been live since stage 2; it proves money out is untouched). `tests/bendahara-sales.test.ts` only once the controller has confirmed Task 1 step 12.

---

### Task 5: What the two screens show

**Files:**
- Create: `tests/finance-sales-views.test.ts`
- Create: `src/screens/finance/sales-sample.ts`
- Create: `src/lib/finance/sales-views.ts`

**Interfaces:**
- Consumes: `InvoiceListRow`, `InvoiceDisplayStatus`, `EInvoiceStatus` from `./invoices`; `PaymentInRow`, `PaymentMethod`, `PAYMENT_METHODS`, `PAYMENT_METHOD_LABELS` from `./money`; `ELECTRONIC`, `METHOD_COLORS`, `Stat`, `addDays`, `count`, `lastMonths`, `monthOf`, `paymentCount`, `sum`, `thousands` from `./view-helpers`; `toCsv` from `./csv`; `rmShort` from `./format`; `Slice` (type) from `@/components/charts`.
- Produces, from `sales-views.ts`:
  - `type InvoicesViewData = { stats: Stat[]; trend: { label: string; invoiced: number; received: number }[]; hasTrend: boolean; byStatus: Slice[]; invoiceCount: number }`
  - `type PaymentsInViewData = { stats: Stat[]; trend: { label: string; received: number }[]; hasTrend: boolean; byMethod: Slice[]; hasReceived: boolean; receivedMtd: string }`
  - `INVOICE_STATUS_LABELS: Record<InvoiceDisplayStatus, string>`, `EINVOICE_STATUS_LABELS: Record<EInvoiceStatus, string>`, `PAYMENT_IN_STATUS_LABELS: Record<PaymentInRow['status'], string>`
  - `invoicesView(invoices: InvoiceListRow[], payments: PaymentInRow[], today: string): InvoicesViewData`
  - `type InvoiceFilter = 'open' | InvoiceDisplayStatus`
  - `filterInvoices(invoices: InvoiceListRow[], query: string, filter: InvoiceFilter, customerId?: string): InvoiceListRow[]` (`customerId` defaults to `'all'`)
  - `invoiceCustomers(invoices: InvoiceListRow[]): { id: string; name: string }[]`
  - `invoicesCsv(invoices: InvoiceListRow[]): string`
  - `paymentsInView(rows: PaymentInRow[], today: string): PaymentsInViewData`
  - `type PaymentInStatusFilter = 'posted' | 'void' | 'all'`, `type PaymentInMethodFilter = 'all' | PaymentMethod`
  - `filterPaymentsIn(rows: PaymentInRow[], query: string, status: PaymentInStatusFilter, method: PaymentInMethodFilter): PaymentInRow[]`
  - `paymentsInCsv(rows: PaymentInRow[]): string`
- Produces, from `sales-sample.ts`: `SAMPLE_TODAY = '2026-10-10'`, `SAMPLE_INVOICES: InvoiceListRow[]`, `SAMPLE_PAYMENTS_IN: PaymentInRow[]`.

The figures, for the record. Invoices: *Total receivable* is the balance of every Sent and Overdue invoice; *Due this week* is the balance of Sent invoices due within seven days of today; *Overdue* is the balance of Overdue invoices; *Received (MTD)* is posted money in dated this month, with the number of payments, each counted once. The trend charts what was invoiced (posted invoices that are not void, by invoice date) against what was received (posted money in, by payment date). Payments In: *Received (MTD)*, *Payments* (once per transaction), *Average payment* (the first divided by the second), *Via bank / FPX* (the share that was not cash or cheque).

- [ ] **Step 1: Write the failing tests**

Create `tests/finance-sales-views.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { InvoiceListRow } from '@/lib/finance/invoices';
import type { PaymentInRow } from '@/lib/finance/money';
import {
  EINVOICE_STATUS_LABELS,
  INVOICE_STATUS_LABELS,
  PAYMENT_IN_STATUS_LABELS,
  filterInvoices,
  filterPaymentsIn,
  invoiceCustomers,
  invoicesCsv,
  invoicesView,
  paymentsInCsv,
  paymentsInView,
} from '@/lib/finance/sales-views';
import { SAMPLE_INVOICES, SAMPLE_PAYMENTS_IN, SAMPLE_TODAY } from '@/screens/finance/sales-sample';

const today = '2026-10-09';

let seq = 0;
const invoice = (i: Partial<InvoiceListRow>): InvoiceListRow => {
  seq += 1;
  return {
    id: `invoice-${seq}`,
    invoice_no: `INV-${String(seq).padStart(4, '0')}`,
    customer_id: 'aisyah',
    customer_name: 'Aisyah Trading',
    invoice_date: '2026-10-01',
    due_date: '2026-10-31',
    total: 100,
    paid: 0,
    balance: 100,
    display_status: 'sent',
    einvoice_status: 'none',
    ...i,
  };
};

const payment = (p: Partial<PaymentInRow>): PaymentInRow => {
  seq += 1;
  return {
    allocation_id: `alloc-${seq}`,
    transaction_id: `txn-${seq}`,
    number: `RC-${String(seq).padStart(4, '0')}`,
    txn_date: '2026-10-05',
    method: 'fpx',
    amount: 100,
    transaction_amount: 100,
    status: 'posted',
    reference: null,
    account_id: 'bank',
    account_name: 'Main Bank',
    invoice_id: 'invoice-x',
    invoice_no: 'INV-0001',
    customer_name: 'Aisyah Trading',
    ...p,
  };
};

describe('status words', () => {
  it('calls a posted invoice Sent and a posted payment in Received', () => {
    expect(INVOICE_STATUS_LABELS).toEqual({ draft: 'Draft', sent: 'Sent', overdue: 'Overdue', paid: 'Paid', void: 'Void' });
    expect(PAYMENT_IN_STATUS_LABELS.posted).toBe('Received');
    expect(PAYMENT_IN_STATUS_LABELS.void).toBe('Void');
    expect(EINVOICE_STATUS_LABELS).toEqual({ none: '', pending: 'Pending', validated: 'Validated', rejected: 'Rejected' });
  });
});

describe('invoicesView', () => {
  it('sums what is owed, what is due this week, what is overdue and what was received this month', () => {
    const view = invoicesView(
      [
        invoice({ balance: 2600, due_date: '2026-10-13' }),
        invoice({ balance: 4300, customer_id: 'zaki', customer_name: 'Zaki Enterprise', due_date: '2026-11-01' }),
        invoice({ balance: 1800, display_status: 'overdue', due_date: '2026-10-04' }),
        invoice({ balance: 0, paid: 100, display_status: 'paid' }),
        invoice({ balance: 780, display_status: 'draft', invoice_no: null }),
        invoice({ balance: 999, display_status: 'void' }),
      ],
      [payment({ amount: 1450 }), payment({ amount: 500, txn_date: '2026-09-30' })],
      today,
    );
    expect(view.stats.map((s) => [s.label, s.value, s.delta])).toEqual([
      ['Total receivable', 'RM 8,700', '3 open invoices'],
      ['Due this week', 'RM 2,600', '1 invoice'],
      ['Overdue', 'RM 1,800', '1 invoice'],
      ['Received (MTD)', 'RM 1,450', '1 payment'],
    ]);
    expect(view.stats[2].deltaTone).toBe('down');
  });

  it('keeps a part-paid invoice in what is owed, at its lower balance', () => {
    const view = invoicesView([invoice({ total: 3500, paid: 1000, balance: 2500 })], [payment({ amount: 1000 })], today);
    expect([view.stats[0].value, view.stats[0].delta]).toEqual(['RM 2,500', '1 open invoice']);
  });

  it('counts a due date exactly a week away as due this week, and the day after as not', () => {
    const due = (due_date: string) => invoicesView([invoice({ due_date })], [], today).stats[1].delta;
    expect(due('2026-10-16')).toBe('1 invoice');
    expect(due('2026-10-17')).toBe('0 invoices');
  });

  it('counts a payment split across two invoices once, and adds both parts', () => {
    const view = invoicesView(
      [],
      [
        payment({ transaction_id: 'split', amount: 60 }),
        payment({ transaction_id: 'split', amount: 40 }),
        payment({ amount: 25 }),
      ],
      today,
    );
    expect([view.stats[3].value, view.stats[3].delta]).toEqual(['RM 125', '2 payments']);
  });

  it('does not count a voided or half-written payment as received', () => {
    const view = invoicesView([], [payment({ status: 'void' }), payment({ status: 'draft', number: null })], today);
    expect([view.stats[3].value, view.stats[3].delta]).toEqual(['RM 0', '0 payments']);
    expect(view.hasTrend).toBe(false);
  });

  it('leaves void invoices out of the status donut and its count', () => {
    const view = invoicesView(
      [invoice({}), invoice({}), invoice({ display_status: 'paid' }), invoice({ display_status: 'overdue' }), invoice({ display_status: 'draft' }), invoice({ display_status: 'void' })],
      [],
      today,
    );
    expect(view.byStatus.map((s) => [s.label, s.value])).toEqual([
      ['Sent', 2],
      ['Paid', 1],
      ['Overdue', 1],
      ['Draft', 1],
    ]);
    expect(view.invoiceCount).toBe(5);
  });

  it('charts what was invoiced and what was received over the last 8 months, in RM thousands', () => {
    const view = invoicesView(
      [
        invoice({ total: 3000 }),
        invoice({ total: 1500, display_status: 'paid' }),
        invoice({ total: 2500, invoice_date: '2026-03-02', display_status: 'overdue' }),
        invoice({ total: 999, invoice_date: '2026-02-27' }), // older than 8 months
        invoice({ total: 7000, display_status: 'draft', invoice_no: null }), // not issued
        invoice({ total: 8000, display_status: 'void' }),
      ],
      [payment({ amount: 1500 }), payment({ amount: 700, txn_date: '2026-09-30' })],
      today,
    );
    expect(view.trend.map((t) => t.label)).toEqual(['Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct']);
    expect(view.trend[0]).toEqual({ label: 'Mar', invoiced: 2.5, received: 0 });
    expect(view.trend[6]).toEqual({ label: 'Sep', invoiced: 0, received: 0.7 });
    expect(view.trend[7]).toEqual({ label: 'Oct', invoiced: 4.5, received: 1.5 });
    expect(view.hasTrend).toBe(true);
  });

  describe('hasTrend', () => {
    it('is true for one small invoice this month, although the chart rounds it to nothing', () => {
      const view = invoicesView([invoice({ total: 30 })], [], today);
      expect(view.hasTrend).toBe(true);
      expect(view.trend.every((t) => t.invoiced === 0 && t.received === 0)).toBe(true);
    });
    it('is true for one small payment at the oldest month the trend covers', () => {
      expect(invoicesView([], [payment({ amount: 30, txn_date: '2026-03-01' })], today).hasTrend).toBe(true);
    });
    it('is false when everything is older than the eight months, a draft or void', () => {
      const view = invoicesView(
        [invoice({ invoice_date: '2026-02-28' }), invoice({ display_status: 'draft', invoice_no: null }), invoice({ display_status: 'void' })],
        [payment({ txn_date: '2026-01-09' })],
        today,
      );
      expect(view.hasTrend).toBe(false);
    });
  });

  it('adds sen without floating point drift', () => {
    const view = invoicesView([invoice({ balance: 0.1 }), invoice({ balance: 0.2 }), invoice({ balance: 9999.7 })], [], today);
    expect(view.stats[0].value).toBe('RM 10.0k');
  });

  it('is all zeros for a workspace with nothing yet', () => {
    const view = invoicesView([], [], today);
    expect(view.stats.map((s) => s.value)).toEqual(['RM 0', 'RM 0', 'RM 0', 'RM 0']);
    expect(view.stats[2].deltaTone).toBe('flat');
    expect(view.hasTrend).toBe(false);
    expect(view.invoiceCount).toBe(0);
    expect(view.byStatus.map((s) => s.value)).toEqual([0, 0, 0, 0]);
  });
});

describe('paymentsInView', () => {
  it('counts only received money: the total, how many payments, their average and the electronic share', () => {
    const view = paymentsInView(
      [
        payment({ amount: 3000, method: 'bank_transfer' }),
        payment({ amount: 1000, method: 'cash' }),
        payment({ amount: 700, status: 'void' }),
        payment({ amount: 2500, txn_date: '2026-03-02' }),
        payment({ amount: 999, txn_date: '2026-02-27' }), // older than 8 months
      ],
      today,
    );
    expect(view.stats.map((s) => [s.label, s.value, s.delta])).toEqual([
      ['Received (MTD)', 'RM 4,000', 'this month'],
      ['Payments', '2', 'this month'],
      ['Average payment', 'RM 2,000', 'this month'],
      ['Via bank / FPX', '75%', 'of received MTD'],
    ]);
    expect(view.receivedMtd).toBe('RM 4,000');
    expect(view.hasReceived).toBe(true);
    expect(view.trend.map((t) => t.label)).toEqual(['Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct']);
    expect(view.trend[0]).toEqual({ label: 'Mar', received: 2.5 });
    expect(view.trend[7]).toEqual({ label: 'Oct', received: 4 });
  });

  it('counts a payment split across three invoices once: the parts add up, the average is per payment', () => {
    const view = paymentsInView(
      [
        payment({ transaction_id: 'split', amount: 60, transaction_amount: 150 }),
        payment({ transaction_id: 'split', amount: 40, transaction_amount: 150 }),
        payment({ transaction_id: 'split', amount: 50, transaction_amount: 150 }),
        payment({ amount: 50 }),
      ],
      today,
    );
    expect(view.stats.map((s) => s.value)).toEqual(['RM 200', '2', 'RM 100', '100%']);
  });

  it('shows only the methods used this month, with their own labels and amounts in RM', () => {
    const view = paymentsInView(
      [
        payment({ amount: 120.5, method: 'duitnow' }),
        payment({ amount: 40, method: 'cheque' }),
        payment({ amount: 900, method: 'fpx', txn_date: '2026-09-30' }),
      ],
      today,
    );
    expect(view.byMethod.map((s) => [s.key, s.label, s.value])).toEqual([
      ['duitnow', 'DuitNow', 120.5],
      ['cheque', 'Cheque', 40],
    ]);
  });

  it('keeps all seven methods at zero, with dashes for the ratios, when nothing was received this month', () => {
    const view = paymentsInView([payment({ status: 'void' }), payment({ txn_date: '2026-09-30' })], today);
    expect(view.byMethod.map((s) => s.label)).toEqual(['Bank Transfer', 'FPX', 'DuitNow', 'Card', 'E-Wallet', 'Cash', 'Cheque']);
    expect(view.byMethod.every((s) => s.value === 0)).toBe(true);
    expect(view.hasReceived).toBe(false);
    expect(view.stats.map((s) => s.value)).toEqual(['RM 0', '0', '—', '—']);
    expect(view.hasTrend).toBe(true);
  });

  describe('hasTrend and hasReceived', () => {
    it('are true for one payment of one sen this month, although the chart rounds it to nothing', () => {
      const view = paymentsInView([payment({ amount: 0.01 })], today);
      expect(view.hasTrend).toBe(true);
      expect(view.hasReceived).toBe(true);
      expect(view.trend.every((t) => t.received === 0)).toBe(true);
    });
    it('are false with only voided payments, and with no rows', () => {
      expect(paymentsInView([payment({ status: 'void' })], today)).toMatchObject({ hasTrend: false, hasReceived: false });
      expect(paymentsInView([], today)).toMatchObject({ hasTrend: false, hasReceived: false });
    });
    it('hasTrend is false when the only payment is older than the eight months', () => {
      expect(paymentsInView([payment({ amount: 5000, txn_date: '2026-02-28' })], today).hasTrend).toBe(false);
    });
  });

  it('uses no purple, violet, indigo or fuchsia for a method', () => {
    for (const slice of paymentsInView([], today).byMethod) {
      expect(slice.color, slice.label).toMatch(/^(var\(--chart-[1-5]\)|oklch\(0\.\d+ 0\.\d+ (\d+)\))$/);
      const hue = /oklch\([\d.]+ [\d.]+ (\d+)\)/.exec(slice.color ?? '')?.[1];
      // Violet to fuchsia sits between hue 270 and 350.
      if (hue) expect(Number(hue) < 270 || Number(hue) > 350, slice.label).toBe(true);
    }
  });
});

describe('filterInvoices', () => {
  const rows = [
    invoice({ id: 's', invoice_no: 'INV-0007', customer_id: 'aisyah', customer_name: 'Aisyah Trading' }),
    invoice({ id: 'o', invoice_no: 'INV-0008', customer_id: 'zaki', customer_name: 'Zaki Enterprise', display_status: 'overdue' }),
    invoice({ id: 'd', invoice_no: null, customer_id: 'aisyah', customer_name: 'Aisyah Trading', display_status: 'draft' }),
    invoice({ id: 'p', invoice_no: 'INV-0009', customer_id: 'zaki', customer_name: 'Zaki Enterprise', display_status: 'paid' }),
    invoice({ id: 'v', invoice_no: 'INV-0010', customer_id: 'aisyah', customer_name: 'Aisyah Trading', display_status: 'void' }),
  ];
  const ids = (list: InvoiceListRow[]) => list.map((i) => i.id);

  it('shows everything except void invoices until a status is chosen', () => {
    expect(ids(filterInvoices(rows, '', 'open'))).toEqual(['s', 'o', 'd', 'p']);
  });
  it('shows one status when chosen, void included', () => {
    expect(ids(filterInvoices(rows, '', 'sent'))).toEqual(['s']);
    expect(ids(filterInvoices(rows, '', 'draft'))).toEqual(['d']);
    expect(ids(filterInvoices(rows, '', 'void'))).toEqual(['v']);
  });
  it('narrows to one customer by id, together with the status', () => {
    expect(ids(filterInvoices(rows, '', 'open', 'zaki'))).toEqual(['o', 'p']);
    expect(ids(filterInvoices(rows, '', 'paid', 'aisyah'))).toEqual([]);
    expect(ids(filterInvoices(rows, '', 'open', 'all'))).toEqual(['s', 'o', 'd', 'p']);
  });
  it('searches the number and the customer, ignoring case and spaces around', () => {
    expect(ids(filterInvoices(rows, '  zaki ', 'open'))).toEqual(['o', 'p']);
    expect(ids(filterInvoices(rows, 'inv-0007', 'open'))).toEqual(['s']);
    expect(filterInvoices(rows, 'nobody', 'open')).toEqual([]);
  });
  it('does not match a draft on the word null', () => {
    expect(filterInvoices(rows, 'null', 'open')).toEqual([]);
  });
});

describe('invoiceCustomers', () => {
  it('lists each customer once, by name, and keeps two customers with one name apart', () => {
    expect(
      invoiceCustomers([
        invoice({ customer_id: 'z', customer_name: 'Zaki Enterprise' }),
        invoice({ customer_id: 'a2', customer_name: 'Ali Trading' }),
        invoice({ customer_id: 'a1', customer_name: 'Ali Trading' }),
        invoice({ customer_id: 'z', customer_name: 'Zaki Enterprise' }),
      ]),
    ).toEqual([
      { id: 'a1', name: 'Ali Trading' },
      { id: 'a2', name: 'Ali Trading' },
      { id: 'z', name: 'Zaki Enterprise' },
    ]);
    expect(invoiceCustomers([])).toEqual([]);
  });
});

describe('filterPaymentsIn', () => {
  const rows = [
    payment({ allocation_id: 'got', number: 'RC-0003', invoice_no: 'INV-0007', reference: 'MBB 8841' }),
    payment({ allocation_id: 'cash', number: 'RC-0004', method: 'cash', customer_name: 'Zaki Enterprise', invoice_no: 'INV-0008' }),
    payment({ allocation_id: 'gone', number: 'RC-0002', status: 'void', method: 'cash' }),
  ];
  const ids = (list: PaymentInRow[]) => list.map((p) => p.allocation_id);

  it('shows received payments until a status is chosen', () => {
    expect(ids(filterPaymentsIn(rows, '', 'posted', 'all'))).toEqual(['got', 'cash']);
    expect(ids(filterPaymentsIn(rows, '', 'void', 'all'))).toEqual(['gone']);
    expect(ids(filterPaymentsIn(rows, '', 'all', 'all'))).toEqual(['got', 'cash', 'gone']);
  });
  it('narrows by method', () => {
    expect(ids(filterPaymentsIn(rows, '', 'posted', 'cash'))).toEqual(['cash']);
    expect(ids(filterPaymentsIn(rows, '', 'all', 'cash'))).toEqual(['cash', 'gone']);
    expect(ids(filterPaymentsIn(rows, '', 'posted', 'cheque'))).toEqual([]);
  });
  it('searches customer, invoice number, receipt number and reference', () => {
    expect(ids(filterPaymentsIn(rows, 'zaki', 'all', 'all'))).toEqual(['cash']);
    expect(ids(filterPaymentsIn(rows, 'inv-0007', 'all', 'all'))).toEqual(['got']);
    expect(ids(filterPaymentsIn(rows, 'rc-0002', 'all', 'all'))).toEqual(['gone']);
    expect(ids(filterPaymentsIn(rows, 'mbb', 'all', 'all'))).toEqual(['got']);
    expect(filterPaymentsIn(rows, 'null', 'all', 'all')).toEqual([]);
  });
});

describe('CSV export', () => {
  it('writes the invoices table, with a formula-looking customer name made harmless', () => {
    const csv = invoicesCsv([
      invoice({ invoice_no: 'INV-0007', customer_name: '=cmd|calc', total: 1250.5, paid: 1000, balance: 250.5, einvoice_status: 'validated' }),
      invoice({ invoice_no: null, customer_name: 'Lim, Tan & Co', total: 80, balance: 80, display_status: 'draft' }),
    ]);
    expect(csv).toBe(
      '\uFEFFNo.,Date,Customer,Due,Total,Paid,Balance,Status,e-Invois\r\n' +
        "INV-0007,2026-10-01,'=cmd|calc,2026-10-31,1250.5,1000,250.5,Sent,Validated\r\n" +
        ',2026-10-01,"Lim, Tan & Co",2026-10-31,80,0,80,Draft,\r\n',
    );
  });

  it('writes the payments table, one line per invoice paid, with the method and status as the screen words them', () => {
    const csv = paymentsInCsv([
      payment({ number: 'RC-0003', transaction_id: 't', invoice_no: 'INV-0007', amount: 132.5, method: 'bank_transfer' }),
      payment({ number: 'RC-0003', transaction_id: 't', invoice_no: 'INV-0008', amount: 40, method: 'bank_transfer', customer_name: '+60 Trading' }),
      payment({ number: 'RC-0001', status: 'void', invoice_no: 'INV-0001', amount: 5, method: 'ewallet' }),
    ]);
    expect(csv).toBe(
      '\uFEFFDate,No.,Customer,Invoice,Account,Method,Amount,Status\r\n' +
        '2026-10-05,RC-0003,Aisyah Trading,INV-0007,Main Bank,Bank Transfer,132.5,Received\r\n' +
        "2026-10-05,RC-0003,'+60 Trading,INV-0008,Main Bank,Bank Transfer,40,Received\r\n" +
        '2026-10-05,RC-0001,Aisyah Trading,INV-0001,Main Bank,E-Wallet,5,Void\r\n',
    );
  });
});

describe('the sample shown when there is no database', () => {
  it('gives every invoice and every payment row an id of its own', () => {
    expect(new Set(SAMPLE_INVOICES.map((i) => i.id)).size).toBe(SAMPLE_INVOICES.length);
    expect(new Set(SAMPLE_PAYMENTS_IN.map((p) => p.allocation_id)).size).toBe(SAMPLE_PAYMENTS_IN.length);
  });
  it('agrees with itself: what is paid on each invoice is what the payments against it add up to', () => {
    for (const i of SAMPLE_INVOICES) {
      const paid = SAMPLE_PAYMENTS_IN.filter((p) => p.invoice_id === i.id).reduce((total, p) => total + p.amount, 0);
      expect(paid, i.invoice_no ?? 'draft').toBe(i.paid);
      expect(i.balance, i.invoice_no ?? 'draft').toBe(i.total - i.paid);
    }
  });
  it('fills every card and chart on both screens', () => {
    const invoices = invoicesView(SAMPLE_INVOICES, SAMPLE_PAYMENTS_IN, SAMPLE_TODAY);
    expect(invoices.stats.map((s) => [s.label, s.value, s.delta])).toEqual([
      ['Total receivable', 'RM 21.0k', '4 open invoices'],
      ['Due this week', 'RM 6,400', '1 invoice'],
      ['Overdue', 'RM 12.1k', '2 invoices'],
      ['Received (MTD)', 'RM 18.2k', '7 payments'],
    ]);
    expect(invoices.hasTrend).toBe(true);
    expect(invoices.trend.every((t) => t.invoiced > 0 && t.received > 0)).toBe(true);
    expect(invoices.invoiceCount).toBe(18);

    const payments = paymentsInView(SAMPLE_PAYMENTS_IN, SAMPLE_TODAY);
    expect(payments.stats.map((s) => s.value)).toEqual(['RM 18.2k', '7', 'RM 2,596', '95%']);
    expect(payments.hasReceived).toBe(true);
    expect(payments.byMethod.map((s) => s.label)).toEqual(['Bank Transfer', 'FPX', 'DuitNow', 'Card', 'Cash']);
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm exec vitest run tests/finance-sales-views.test.ts`
Expected: FAIL. The file cannot be loaded: `@/lib/finance/sales-views` does not exist.

- [ ] **Step 3: Write the sample**

Create `src/screens/finance/sales-sample.ts`:

```ts
/**
 * Sample invoices and payments in (Rimba Ventures Sdn Bhd), shown on Invoices
 * and Payments In when there is no database. Raw rows in the shape the data
 * layer reads, so both screens run them through the same builders as live
 * data and their figures agree with each other.
 */
import type { EInvoiceStatus, InvoiceDisplayStatus, InvoiceListRow } from '@/lib/finance/invoices';
import type { PaymentInRow, PaymentMethod } from '@/lib/finance/money';

/** The sample is a fixed month, so its figures do not drain away as the calendar moves on. */
export const SAMPLE_TODAY = '2026-10-10';

const invoice = (
  n: number,
  invoice_date: string,
  customer_name: string,
  due_date: string,
  total: number,
  display_status: InvoiceDisplayStatus,
  einvoice_status: EInvoiceStatus,
  paid: number = display_status === 'paid' ? total : 0,
): InvoiceListRow => ({
  id: `sample-invoice-${n}`,
  invoice_no: display_status === 'draft' ? null : `INV-${String(n).padStart(4, '0')}`,
  customer_id: customer_name,
  customer_name,
  invoice_date,
  due_date,
  total,
  paid,
  balance: total - paid,
  display_status,
  einvoice_status,
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
  invoice(1042, '2026-10-07', 'Aisyah Trading', '2026-11-06', 1240, 'paid', 'validated'),
  invoice(1041, '2026-10-05', 'Zaki Enterprise', '2026-11-04', 3500, 'sent', 'pending', 1000),
  invoice(1040, '2026-10-01', 'Nurul Boutique', '2026-10-08', 8900, 'overdue', 'validated'),
  invoice(1039, '2026-09-28', 'Lim Hardware Sdn Bhd', '2026-10-28', 2100, 'paid', 'validated'),
  invoice(1038, '2026-09-25', 'Siti Decor', '2026-10-25', 4200, 'paid', 'validated'),
  invoice(1037, '2026-09-20', 'Nusantara Logistics', '2026-10-15', 6400, 'sent', 'pending'),
  invoice(1036, '2026-09-14', 'Langkawi Fresh', '2026-10-14', 5600, 'paid', 'validated'),
  invoice(1035, '2026-09-10', 'Lim Hardware Sdn Bhd', '2026-09-24', 3180, 'overdue', 'validated'),
  invoice(1033, '2026-09-05', 'Nurul Boutique', '2026-10-05', 850, 'paid', 'validated'),
  invoice(1032, '2026-09-03', 'Seri Mutiara Enterprise', '2026-10-03', 3180, 'paid', 'validated'),
  invoice(1030, '2026-08-30', 'Nusantara Logistics', '2026-09-29', 6800, 'paid', 'validated'),
  ...SAMPLE_HISTORY.map(([month, total], i) =>
    invoice(1006 - i, `${month}-12`, 'Aisyah Trading', `${month}-26`, total, 'paid', 'validated'),
  ),
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
    number: `RC-${String(n).padStart(4, '0')}`,
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
  ...SAMPLE_HISTORY.map(([month], i) => receipt(96 - i, `${month}-24`, 1006 - i, 'bank_transfer')),
];
```

- [ ] **Step 4: Write `src/lib/finance/sales-views.ts`**

Create `src/lib/finance/sales-views.ts`:

```ts
/**
 * What the Invoices and Payments In screens show, worked out from the rows
 * the data layer reads. Pure, with no server imports, so the client views and
 * the tests both use it. `today` is always a YYYY-MM-DD date.
 */
import type { Slice } from '@/components/charts';
import { toCsv } from './csv';
import { rmShort } from './format';
import type { EInvoiceStatus, InvoiceDisplayStatus, InvoiceListRow } from './invoices';
import { PAYMENT_METHODS, PAYMENT_METHOD_LABELS, type PaymentInRow, type PaymentMethod } from './money';
import {
  ELECTRONIC,
  METHOD_COLORS,
  type Stat,
  addDays,
  count,
  lastMonths,
  monthOf,
  paymentCount,
  sum,
  thousands,
} from './view-helpers';

export type InvoicesViewData = {
  stats: Stat[];
  /** The last eight months, oldest first, in RM thousands: what was invoiced and what was received. */
  trend: { label: string; invoiced: number; received: number }[];
  /** Whether anything was invoiced or received in those eight months, however little: a small amount rounds to 0 in `trend`. */
  hasTrend: boolean;
  /** How many invoices are in each status. Void invoices are left out. */
  byStatus: Slice[];
  /** How many invoices `byStatus` counts. */
  invoiceCount: number;
};

export type PaymentsInViewData = {
  stats: Stat[];
  /** The last eight months, oldest first, in RM thousands. */
  trend: { label: string; received: number }[];
  /** Whether anything was received in those eight months, however little: a small payment rounds to 0 in `trend`. */
  hasTrend: boolean;
  /** Received this month per method, in RM. */
  byMethod: Slice[];
  /** Whether anything was received this month. */
  hasReceived: boolean;
  receivedMtd: string;
};

/** A posted invoice is "Sent": no email goes out, the word says it is out of the workspace's hands. */
export const INVOICE_STATUS_LABELS: Record<InvoiceDisplayStatus, string> = {
  draft: 'Draft',
  sent: 'Sent',
  overdue: 'Overdue',
  paid: 'Paid',
  void: 'Void',
};

/** `none` has no label: the table shows a dash. */
export const EINVOICE_STATUS_LABELS: Record<EInvoiceStatus, string> = {
  none: '',
  pending: 'Pending',
  validated: 'Validated',
  rejected: 'Rejected',
};

/** Money in is posted the moment it is recorded, and the screen words that "Received". */
export const PAYMENT_IN_STATUS_LABELS: Record<PaymentInRow['status'], string> = {
  draft: 'Draft',
  pending_approval: 'Pending approval',
  scheduled: 'Scheduled',
  posted: 'Received',
  rejected: 'Rejected',
  void: 'Void',
};

/** Posted and not void: an invoice that has gone out, paid or not. */
function isIssued(invoice: InvoiceListRow): boolean {
  return invoice.display_status === 'sent' || invoice.display_status === 'overdue' || invoice.display_status === 'paid';
}

/** Only money that has actually arrived counts: not voided, not half-written. */
function received(rows: PaymentInRow[]): PaymentInRow[] {
  return rows.filter((p) => p.status === 'posted');
}

/* ---- Invoices ------------------------------------------------------ */

export function invoicesView(invoices: InvoiceListRow[], payments: PaymentInRow[], today: string): InvoicesViewData {
  const open = invoices.filter((i) => i.display_status === 'sent' || i.display_status === 'overdue');
  const overdue = open.filter((i) => i.display_status === 'overdue');
  const weekEnd = addDays(today, 7);
  const dueThisWeek = open.filter((i) => i.display_status === 'sent' && i.due_date <= weekEnd);
  const posted = received(payments);
  const receivedMtd = posted.filter((p) => monthOf(p.txn_date) === monthOf(today));
  const issued = invoices.filter(isIssued);

  let hasTrend = false;
  const trend = lastMonths(today).map(({ key, label }) => {
    const invoicedInMonth = issued.filter((i) => monthOf(i.invoice_date) === key);
    const receivedInMonth = posted.filter((p) => monthOf(p.txn_date) === key);
    if (invoicedInMonth.length > 0 || receivedInMonth.length > 0) hasTrend = true;
    return {
      label,
      invoiced: thousands(sum(invoicedInMonth, (i) => i.total)),
      received: thousands(sum(receivedInMonth, (p) => p.amount)),
    };
  });

  const statusCount = (status: InvoiceDisplayStatus) => invoices.filter((i) => i.display_status === status).length;

  return {
    stats: [
      { label: 'Total receivable', value: rmShort(sum(open, (i) => i.balance)), delta: count(open.length, 'open invoice'), deltaTone: 'flat' },
      { label: 'Due this week', value: rmShort(sum(dueThisWeek, (i) => i.balance)), delta: count(dueThisWeek.length, 'invoice'), deltaTone: 'flat' },
      { label: 'Overdue', value: rmShort(sum(overdue, (i) => i.balance)), delta: count(overdue.length, 'invoice'), deltaTone: overdue.length ? 'down' : 'flat' },
      { label: 'Received (MTD)', value: rmShort(sum(receivedMtd, (p) => p.amount)), delta: count(paymentCount(receivedMtd), 'payment'), deltaTone: 'flat' },
    ],
    trend,
    hasTrend,
    byStatus: [
      { key: 'sent', label: 'Sent', value: statusCount('sent'), color: 'var(--chart-1)' },
      { key: 'paid', label: 'Paid', value: statusCount('paid'), color: 'var(--chart-2)' },
      { key: 'overdue', label: 'Overdue', value: statusCount('overdue'), color: 'var(--chart-4)' },
      { key: 'draft', label: 'Draft', value: statusCount('draft'), color: 'var(--chart-3)' },
    ],
    invoiceCount: invoices.filter((i) => i.display_status !== 'void').length,
  };
}

/** `open` is every invoice that is not void: what the table shows until a status is chosen. */
export type InvoiceFilter = 'open' | InvoiceDisplayStatus;

/** Invoices matching the status and customer filters whose number or customer contains the search text. */
export function filterInvoices(
  invoices: InvoiceListRow[],
  query: string,
  filter: InvoiceFilter,
  customerId: string = 'all',
): InvoiceListRow[] {
  const q = query.trim().toLowerCase();
  return invoices.filter(
    (i) =>
      (filter === 'open' ? i.display_status !== 'void' : i.display_status === filter) &&
      (customerId === 'all' || i.customer_id === customerId) &&
      `${i.invoice_no ?? ''} ${i.customer_name}`.toLowerCase().includes(q),
  );
}

/** The customers that have an invoice, by name, for the customer filter. Two customers with one name stay two choices. */
export function invoiceCustomers(invoices: InvoiceListRow[]): { id: string; name: string }[] {
  const byId = new Map<string, string>();
  for (const i of invoices) byId.set(i.customer_id, i.customer_name);
  return [...byId.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((x, y) => x.name.localeCompare(y.name) || x.id.localeCompare(y.id));
}

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
      i.balance,
      INVOICE_STATUS_LABELS[i.display_status],
      EINVOICE_STATUS_LABELS[i.einvoice_status],
    ]),
  );
}

/* ---- Payments In --------------------------------------------------- */

export function paymentsInView(rows: PaymentInRow[], today: string): PaymentsInViewData {
  const posted = received(rows);
  const mtd = posted.filter((p) => monthOf(p.txn_date) === monthOf(today));
  const mtdTotal = sum(mtd, (p) => p.amount);
  const mtdCount = paymentCount(mtd);
  const electronicMtd = sum(mtd.filter((p) => ELECTRONIC.has(p.method)), (p) => p.amount);

  let hasTrend = false;
  const trend = lastMonths(today).map(({ key, label }) => {
    const inMonth = posted.filter((p) => monthOf(p.txn_date) === key);
    if (inMonth.length > 0) hasTrend = true;
    return { label, received: thousands(sum(inMonth, (p) => p.amount)) };
  });

  const methods: Slice[] = PAYMENT_METHODS.map((method) => ({
    key: method,
    label: PAYMENT_METHOD_LABELS[method],
    value: sum(mtd.filter((p) => p.method === method), (p) => p.amount),
    color: METHOD_COLORS[method],
  }));
  const used = methods.filter((slice) => slice.value > 0);

  return {
    stats: [
      { label: 'Received (MTD)', value: rmShort(mtdTotal), delta: 'this month', deltaTone: 'flat' },
      // A payment split across invoices is several rows and one payment.
      { label: 'Payments', value: String(mtdCount), delta: 'this month', deltaTone: 'flat' },
      { label: 'Average payment', value: mtdCount ? rmShort(mtdTotal / mtdCount) : '—', delta: 'this month', deltaTone: 'flat' },
      {
        label: 'Via bank / FPX',
        value: mtdTotal ? `${Math.round((electronicMtd / mtdTotal) * 100)}%` : '—',
        delta: 'of received MTD',
        deltaTone: 'flat',
      },
    ],
    trend,
    hasTrend,
    // Seven empty slices would be noise; with nothing received, all seven stay so the legend still shows.
    byMethod: used.length ? used : methods,
    hasReceived: mtd.length > 0,
    receivedMtd: rmShort(mtdTotal),
  };
}

/** `posted` is what the table shows until a status is chosen: money that was received and still stands. */
export type PaymentInStatusFilter = 'posted' | 'void' | 'all';
export type PaymentInMethodFilter = 'all' | PaymentMethod;

/** Rows matching both filters whose customer, invoice number, receipt number or reference contains the search text. */
export function filterPaymentsIn(
  rows: PaymentInRow[],
  query: string,
  status: PaymentInStatusFilter,
  method: PaymentInMethodFilter,
): PaymentInRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter(
    (p) =>
      (status === 'all' || p.status === status) &&
      (method === 'all' || p.method === method) &&
      `${p.customer_name} ${p.invoice_no ?? ''} ${p.number ?? ''} ${p.reference ?? ''}`.toLowerCase().includes(q),
  );
}

/** The payments table as a CSV file: one line per invoice a payment pays. Amounts are numbers. */
export function paymentsInCsv(rows: PaymentInRow[]): string {
  return toCsv(
    ['Date', 'No.', 'Customer', 'Invoice', 'Account', 'Method', 'Amount', 'Status'],
    rows.map((p) => [
      p.txn_date,
      p.number,
      p.customer_name,
      p.invoice_no,
      p.account_name,
      PAYMENT_METHOD_LABELS[p.method],
      p.amount,
      PAYMENT_IN_STATUS_LABELS[p.status],
    ]),
  );
}
```

- [ ] **Step 5: Run the tests**

Run: `pnpm exec vitest run tests/finance-sales-views.test.ts`
Expected: PASS, every test.

- [ ] **Step 6: Type-check, lint and commit**

Run: `pnpm exec tsc --noEmit` then `pnpm lint`
Expected: no errors.

```bash
git add src/lib/finance/sales-views.ts src/screens/finance/sales-sample.ts tests/finance-sales-views.test.ts
git commit -m "feat: figures, filters and CSV for Invoices and Payments In, with their sample data"
```

This task runs no database test.

---

### Task 6: Invoices and Payments In go live, read-only

**Files:**
- Create: `src/components/finance/invoices-view.tsx`
- Create: `src/components/finance/payments-in-view.tsx`
- Replace: `src/screens/finance/invoices.tsx`
- Replace: `src/screens/finance/payments-in.tsx`
- Modify: `src/config/live-screens.ts`
- Modify: `src/app/(app)/finance/actions.ts` (one constant)
- Modify: `tests/live-screens.test.ts` (one test added)
- Create: `tests/finance-contact-paths.test.ts`

**Interfaces:**
- Consumes: `listInvoices` from `@/lib/finance/invoices`; `listPaymentsIn` from `@/lib/finance/money`; `invoicesView`, `paymentsInView`, the filters, labels and CSV builders from `@/lib/finance/sales-views`; `LATEST_ROWS`, `displayDate`, `todayUtc` from `@/lib/finance/view-helpers`; `SAMPLE_INVOICES`, `SAMPLE_PAYMENTS_IN`, `SAMPLE_TODAY` from `./sales-sample`; `getViewer`, `hasSupabaseEnv` from `@/lib/auth/viewer`; `createClient` from `@/lib/supabase/server`; `downloadCsv` from `@/components/finance/download-csv`; `csvFileName` from `@/lib/finance/csv`; `localIsoDate` from `@/lib/finance/bill-math`; `rm` from `@/lib/finance/format`; the existing `BentoCard`, `BentoGrid`, `BentoStat`, `AreaTrend`, `DonutStat`, `PageHeader`, `ScreenContainer`, `NoMatchesRow`, `Badge`, `Button`, `Input`, `LiveDot`, `Select…`, `Table…` components.
- Produces:
  - `InvoicesView({ rows, view }: { rows: InvoiceListRow[]; view: InvoicesViewData })`
  - `PaymentsInView({ rows, view }: { rows: PaymentInRow[]; view: PaymentsInViewData })`
  - default exports `InvoicesScreen` and `PaymentsInScreen` (async server components; the generated route files `src/app/(app)/finance/invoices/page.tsx` and `…/payments-in/page.tsx` already import them by default and need no change).
- **Neither view takes a `writer` prop or an action.** Stage 3b adds `writer?: InvoicesWriter` and `writer?: PaymentsInWriter` in the way `BillsView` and `PaymentsView` have them; the loaders will then pass it only to people who may edit.

Both screens were `'use client'` mock-ups with their own state. They become server components that read; the state moves into the two client views. `ScreenContainer` gets `className="pb-24 sm:pb-24"` on both: without the extra bottom padding the floating assistant button covers the table's last row. Both classes are needed because the container sets `py-5` and `sm:py-6`.

What 3b will add to the revalidate lists, noted here so it is not rediscovered: a `SALES_PATHS` constant (`/finance/invoices`, `/finance/payments-in`, and `/finance/customers-suppliers` once that screen shows Receivable) for the invoice and payment-in actions. In this stage nothing writes an invoice or a payment in from the app, so the only change is that a contact change, which can rename a customer, refreshes the two new screens.

- [ ] **Step 1: Write the failing tests**

Add a test to `tests/live-screens.test.ts`, above the test that ignores paths that are not a screen.

In `tests/live-screens.test.ts`, replace:

```ts
  it('ignores paths that are not a screen', () => {
```

with:

```ts
  it('counts Invoices and Payments In as live, and the sales screens not yet connected as sample', () => {
    expect(isSampleScreen('/finance/invoices')).toBe(false);
    expect(isSampleScreen('/finance/payments-in')).toBe(false);
    for (const slug of ['quotations', 'credit-notes', 'refunds', 'cash-receipts']) {
      expect(isSampleScreen(`/finance/${slug}`), slug).toBe(true);
    }
  });

  it('ignores paths that are not a screen', () => {
```

Create `tests/finance-contact-paths.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ID = '11111111-1111-4111-8111-111111111111';

const ctl = vi.hoisted(() => ({ revalidated: [] as string[] }));

vi.mock('@/lib/auth/viewer', () => ({
  getViewer: async () => ({ userId: 'u1', orgId: 'org1', role: 'member', isDemo: false }),
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({}) }));
vi.mock('next/cache', () => ({
  revalidatePath: (path: string) => {
    ctl.revalidated.push(path);
  },
}));
vi.mock('@/lib/finance/contacts', async (orig) => {
  const actual = await orig<typeof import('@/lib/finance/contacts')>();
  const done = async () => ({ ok: true, data: { id: '11111111-1111-4111-8111-111111111111' } });
  return { ...actual, createContact: done, updateContact: done, setContactActive: done, deleteContact: done };
});

const actions = await import('@/app/(app)/finance/actions');

beforeEach(() => {
  ctl.revalidated = [];
});

describe('a change to a contact', () => {
  const writes: [string, (input: unknown) => Promise<unknown>, unknown][] = [
    ['createContactAction', actions.createContactAction, { name: 'Aisyah Trading', is_customer: true, is_supplier: false }],
    ['updateContactAction', actions.updateContactAction, { id: ID, name: 'Aisyah Trading Sdn Bhd' }],
    ['setContactActiveAction', actions.setContactActiveAction, { id: ID, active: false }],
    ['deleteContactAction', actions.deleteContactAction, { id: ID }],
  ];

  it('refreshes every screen that shows a contact’s name, Invoices and Payments In included', async () => {
    for (const [name, action, input] of writes) {
      ctl.revalidated = [];
      expect(await action(input), name).toMatchObject({ ok: true });
      expect(ctl.revalidated, name).toEqual([
        '/finance/customers-suppliers',
        '/finance/supplier-bills',
        '/finance/payments-out',
        '/finance/invoices',
        '/finance/payments-in',
      ]);
    }
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm exec vitest run tests/live-screens.test.ts tests/finance-contact-paths.test.ts`
Expected: FAIL. `/finance/invoices` is still a sample screen; a contact change refreshes three paths, not five.

- [ ] **Step 3: Write the Invoices view**

Create `src/components/finance/invoices-view.tsx`:

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
import { csvFileName } from '@/lib/finance/csv';
import { rm } from '@/lib/finance/format';
import type { EInvoiceStatus, InvoiceDisplayStatus, InvoiceListRow } from '@/lib/finance/invoices';
import {
  EINVOICE_STATUS_LABELS,
  INVOICE_STATUS_LABELS,
  type InvoiceFilter,
  type InvoicesViewData,
  filterInvoices,
  invoiceCustomers,
  invoicesCsv,
} from '@/lib/finance/sales-views';
import { LATEST_ROWS, displayDate } from '@/lib/finance/view-helpers';
import { cn } from '@/lib/utils';

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

const COLUMNS = 8;

/**
 * Invoices, read-only: figures, charts and the table, with search, filters,
 * "View all" and Export. Nothing here writes; the forms and row actions come
 * with the next stage.
 */
export function InvoicesView({
  rows,
  view,
}: {
  /** Every invoice, newest first; drafts and void ones included. */
  rows: InvoiceListRow[];
  view: InvoicesViewData;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<InvoiceFilter>('open');
  const [customer, setCustomer] = useState('all');
  const [showAll, setShowAll] = useState(false);

  const customers = invoiceCustomers(rows);
  const matching = filterInvoices(rows, query, filter, customer);
  const shown = showAll ? matching : matching.slice(0, LATEST_ROWS);

  return (
    <ScreenContainer className="pb-24 sm:pb-24">
      <PageHeader title="Invoices" subtitle="Sales invoices and their e-Invois status, Saudara." />

      <BentoGrid>
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
            <p className="grid h-60 place-items-center text-sm text-muted-foreground">No invoices yet.</p>
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
              onClick={() => downloadCsv(csvFileName('invoices', localIsoDate(new Date())), invoicesCsv(matching))}
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
                  <TableHead>Due</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">Balance</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>e-Invois</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.length === 0 &&
                  (rows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={COLUMNS} className="py-8 text-center text-muted-foreground">
                        No invoices yet.
                      </TableCell>
                    </TableRow>
                  ) : (
                    <NoMatchesRow colSpan={COLUMNS} />
                  ))}
                {shown.map((i) => (
                  <TableRow key={i.id} className={cn(i.display_status === 'void' && 'opacity-60')}>
                    <TableCell className="whitespace-nowrap font-medium">{i.invoice_no ?? '—'}</TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{displayDate(i.invoice_date)}</TableCell>
                    <TableCell className="whitespace-nowrap">{i.customer_name}</TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{displayDate(i.due_date)}</TableCell>
                    <TableCell className="whitespace-nowrap text-right tabular-nums">{rm(i.total)}</TableCell>
                    <TableCell className="whitespace-nowrap text-right tabular-nums">{rm(i.balance)}</TableCell>
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
                        >
                          {EINVOICE_STATUS_LABELS[i.einvoice_status]}
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
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

- [ ] **Step 4: Write the Payments In view**

Create `src/components/finance/payments-in-view.tsx`:

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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LiveDot } from '@/components/ui/live-dot';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { localIsoDate } from '@/lib/finance/bill-math';
import { csvFileName } from '@/lib/finance/csv';
import { rm } from '@/lib/finance/format';
import { PAYMENT_METHODS, PAYMENT_METHOD_LABELS, type PaymentInRow } from '@/lib/finance/money';
import {
  PAYMENT_IN_STATUS_LABELS,
  type PaymentInMethodFilter,
  type PaymentInStatusFilter,
  type PaymentsInViewData,
  filterPaymentsIn,
  paymentsInCsv,
} from '@/lib/finance/sales-views';
import { LATEST_ROWS, displayDate } from '@/lib/finance/view-helpers';
import { cn } from '@/lib/utils';

const RECEIVED_SERIES: Series[] = [{ key: 'received', label: 'Received (RM k)', color: 'var(--chart-2)' }];

const STATUS_STYLES: Record<PaymentInRow['status'], string> = {
  posted: 'bg-emerald-500/15 text-emerald-600',
  scheduled: 'bg-amber-500/15 text-amber-600',
  pending_approval: 'bg-amber-500/15 text-amber-600',
  draft: 'bg-muted text-muted-foreground',
  rejected: 'bg-muted text-muted-foreground',
  void: 'bg-muted text-muted-foreground line-through',
};

const COLUMNS = 8;

/**
 * Payments In, read-only: figures, charts and the table, with search,
 * filters, "View all" and Export. Nothing here writes; recording and voiding
 * a payment come with the next stage.
 */
export function PaymentsInView({
  rows,
  view,
}: {
  /** One row per invoice a payment pays, newest first; void ones included. */
  rows: PaymentInRow[];
  view: PaymentsInViewData;
}) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<PaymentInStatusFilter>('posted');
  const [method, setMethod] = useState<PaymentInMethodFilter>('all');
  const [showAll, setShowAll] = useState(false);

  const matching = filterPaymentsIn(rows, query, status, method);
  const shown = showAll ? matching : matching.slice(0, LATEST_ROWS);

  return (
    <ScreenContainer className="pb-24 sm:pb-24">
      <PageHeader title="Payments In" subtitle="Payments received from your customers, Saudara." />

      <BentoGrid>
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
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.length === 0 &&
                  (rows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={COLUMNS} className="py-8 text-center text-muted-foreground">
                        No payments yet.
                      </TableCell>
                    </TableRow>
                  ) : (
                    <NoMatchesRow colSpan={COLUMNS} />
                  ))}
                {shown.map((p) => (
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
                  </TableRow>
                ))}
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

- [ ] **Step 5: Replace the Invoices screen with a server loader**

Replace the whole of `src/screens/finance/invoices.tsx` with:

```tsx
import { InvoicesView } from '@/components/finance/invoices-view';
import { getViewer, hasSupabaseEnv } from '@/lib/auth/viewer';
import { listInvoices } from '@/lib/finance/invoices';
import { listPaymentsIn } from '@/lib/finance/money';
import { invoicesView } from '@/lib/finance/sales-views';
import { todayUtc } from '@/lib/finance/view-helpers';
import { createClient } from '@/lib/supabase/server';
import { SAMPLE_INVOICES, SAMPLE_PAYMENTS_IN, SAMPLE_TODAY } from './sales-sample';

/**
 * Invoices, read-only for everyone in this stage: the view takes no actions,
 * so nothing here depends on the viewer's role. The forms and row actions
 * arrive with the next stage, given only to people who may edit, as on
 * Supplier Bills.
 */
export default async function InvoicesScreen() {
  if (!hasSupabaseEnv()) {
    return <InvoicesView rows={SAMPLE_INVOICES} view={invoicesView(SAMPLE_INVOICES, SAMPLE_PAYMENTS_IN, SAMPLE_TODAY)} />;
  }
  const viewer = await getViewer();
  const ctx = { client: await createClient(), orgId: viewer.orgId };
  // The payments feed "Received (MTD)" and the trend; the table shows invoices only.
  const [rows, payments] = await Promise.all([listInvoices(ctx), listPaymentsIn(ctx)]);
  return <InvoicesView rows={rows} view={invoicesView(rows, payments, todayUtc())} />;
}
```

- [ ] **Step 6: Replace the Payments In screen with a server loader**

Replace the whole of `src/screens/finance/payments-in.tsx` with:

```tsx
import { PaymentsInView } from '@/components/finance/payments-in-view';
import { getViewer, hasSupabaseEnv } from '@/lib/auth/viewer';
import { listPaymentsIn } from '@/lib/finance/money';
import { paymentsInView } from '@/lib/finance/sales-views';
import { todayUtc } from '@/lib/finance/view-helpers';
import { createClient } from '@/lib/supabase/server';
import { SAMPLE_PAYMENTS_IN, SAMPLE_TODAY } from './sales-sample';

/**
 * Payments In, read-only for everyone in this stage: the view takes no
 * actions, so nothing here depends on the viewer's role. Recording and voiding
 * a payment arrive with the next stage.
 */
export default async function PaymentsInScreen() {
  if (!hasSupabaseEnv()) {
    return <PaymentsInView rows={SAMPLE_PAYMENTS_IN} view={paymentsInView(SAMPLE_PAYMENTS_IN, SAMPLE_TODAY)} />;
  }
  const viewer = await getViewer();
  const ctx = { client: await createClient(), orgId: viewer.orgId };
  const rows = await listPaymentsIn(ctx);
  return <PaymentsInView rows={rows} view={paymentsInView(rows, todayUtc())} />;
}
```

- [ ] **Step 7: Mark both screens live**

In `src/config/live-screens.ts`, replace:

```ts
  'finance/products',
```

with:

```ts
  'finance/products',
  // Read-only so far: their forms and row actions join in the next slice.
  'finance/invoices',
  'finance/payments-in',
```

- [ ] **Step 8: Refresh both screens when a contact changes**

In `src/app/(app)/finance/actions.ts`, replace:

```ts
// Supplier names and balances show on the bills and payments screens too.
const CONTACT_PATHS = ['/finance/customers-suppliers', '/finance/supplier-bills', '/finance/payments-out'];
```

with:

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

- [ ] **Step 9: Run the tests**

Run: `pnpm exec vitest run tests/live-screens.test.ts tests/finance-contact-paths.test.ts tests/finance-actions.test.ts tests/screen-routes.test.ts`
Expected: PASS, all four files. `tests/finance-actions.test.ts` was not edited: the bill and payment actions still refresh the three purchase paths.

- [ ] **Step 10: Check the routes, type-check, lint and build**

Run: `pnpm gen:routes --check`
Expected: exit 0, nothing out of date. (The two route files already import these screens' default exports.)

Run, as separate commands: `pnpm exec tsc --noEmit`, `pnpm lint`, `pnpm build`
Expected: no type or lint errors; the build completes. The build is what catches a server-only import reaching a client component.

Run: `grep -n "use client\|writer\|Action\|Receipt\b" src/screens/finance/invoices.tsx src/screens/finance/payments-in.tsx src/components/finance/invoices-view.tsx src/components/finance/payments-in-view.tsx`
Expected: exactly two lines, the `'use client';` at the top of each view. No `writer`, no action, no `Receipt` icon.

- [ ] **Step 11: Commit**

```bash
git add src/components/finance/invoices-view.tsx src/components/finance/payments-in-view.tsx src/screens/finance/invoices.tsx src/screens/finance/payments-in.tsx src/config/live-screens.ts "src/app/(app)/finance/actions.ts" tests/live-screens.test.ts tests/finance-contact-paths.test.ts
git commit -m "feat: Invoices and Payments In read the workspace's own data, read-only"
```

No browser check and no dev server: the controller checks both screens on production after the merge. This task runs no database test.

---

### Task 7: Document and verify the branch

**Files:**
- Modify: `docs/bendahara-backend.md`

Every function is written with its real argument names and every code with its full meaning. After editing, read the note beside `supabase/migrations/20261014100000_bendahara_invoices.sql` once: each `raise exception … using errcode` in the migration must be covered by the meaning the note gives that code, and each function's arguments in the note must be the names in its `create or replace function` line.

- [ ] **Step 1: The table of pure files**

In `docs/bendahara-backend.md`, replace:

```markdown
| `purchase-views.ts` | KPI figures, chart data, table filters and CSV rows for Supplier Bills and Payments Out |
| `bill-math.ts` | Line amounts and bill totals, rounded exactly as the generated columns `amount` and `sst_amount` round them; the SST rate keeps two decimals, as its column does (`roundRate` in `bills.ts`) |
```

with:

```markdown
| `purchase-views.ts` | KPI figures, chart data, table filters and CSV rows for Supplier Bills and Payments Out |
| `sales-views.ts` | KPI figures, chart data, table filters, status words and CSV rows for Invoices and Payments In |
| `view-helpers.ts` | What those two share: dates, sums to the sen, the eight-month window of a trend chart, how payment methods are grouped and coloured |
| `document-lines.ts` | What a bill and an invoice share: the line schema, the real-date and SST-rate rules (`isIsoDate`, `roundRate`), and reading a saved line |
| `bill-math.ts` | Line amounts and bill totals, rounded exactly as the generated columns `amount` and `sst_amount` round them; the SST rate keeps two decimals, as its column does (`roundRate` in `document-lines.ts`) |
```

- [ ] **Step 2: The tables**

In `docs/bendahara-backend.md`, replace:

```markdown
| `finance_transactions` | One row per movement of money: direction, account, date, amount, method, status. |
| `finance_allocations` | How a movement is split across the documents it pays. Only bills so far. |
```

with:

```markdown
| `finance_invoices`, `finance_invoice_lines` | Sales invoices and their lines. A draft has no `invoice_no`. Lines keep the order they were entered in (`position`). |
| `finance_transactions` | One row per movement of money: direction, account, date, amount, method, status. |
| `finance_allocations` | How a movement is split across the documents it pays. Each row names exactly one document: a bill (`bill_id`) or an invoice (`invoice_id`). |
```

- [ ] **Step 3: Money**

In `docs/bendahara-backend.md`, replace:

```markdown
Money is entered once. A payment out is one `finance_transactions` row with
direction `out`, split across one supplier's bills by `finance_allocations`.
The view `finance_payments_out` has one row per bill a payment pays;
`supplier_bill_totals` counts only posted money out as paid.
```

with:

```markdown
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
```

In `docs/bendahara-backend.md`, replace:

```markdown
`scheduled` (not yet money out), `posted` (paid; numbered `PV-0001`), `void`.
```

with:

```markdown
`scheduled` (not yet money out), `posted` (paid or received; numbered
`PV-0001` for money out and `RC-0001` for money in), `void`.
```

- [ ] **Step 4: A section on invoices, and the locking rules**

In `docs/bendahara-backend.md`, replace:

```markdown
## Posted is locked

Triggers enforce it, so no caller can get round it:
```

with:

```markdown
## Invoices

A sales invoice is a `finance_invoices` row with its lines in
`finance_invoice_lines`, which has the columns of `supplier_bill_lines` plus
`position`, the order the lines were entered in. `status` is what a person
sets: `draft`, `posted` or `void`. A draft has no `invoice_no`; posting gives
it the next `INV-` number.

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
only while the invoice is posted. No function or action sets them yet.

## Posted is locked

Triggers enforce it, so no caller can get round it:
```

In `docs/bendahara-backend.md`, replace:

```markdown
- Each guard steps aside when the workspace itself is being deleted.
```

with:

```markdown
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
- A contact with invoices cannot have Customer unticked, as one with bills
  cannot have Supplier unticked.
- Clearing a deleted user from an invoice's `created_by` is allowed whatever
  the invoice's status.
- Each guard steps aside when the workspace itself is being deleted.
```

- [ ] **Step 5: The database functions**

In `docs/bendahara-backend.md`, replace:

```markdown
| `finance_next_number(target_org, doc)` | The next document number. |

Voiding a bill or a payment, and deleting a draft bill or a scheduled payment,
are plain updates and deletes; the guards decide whether they are allowed.
```

with:

```markdown
| `finance_save_invoice(target_org, invoice, lines)` | Creates a draft invoice or replaces a draft's header and lines, keeping the lines in the order given. `invoice` has `id` (to change a draft), `customer_id`, `invoice_date`, `due_date`, `notes`. Returns the id. |
| `finance_post_invoice(target_org, target_invoice)` | Posts a draft and returns its number. |
| `finance_record_payment_in(target_org, payment, allocations)` | Records money received from one customer, split across that customer's posted invoices, and posts it at once. `payment` has `account_id`, `txn_date`, `method`, `reference`, `notes`; `allocations` is a list of `{ invoice_id, amount }`. Returns the id. |
| `finance_next_number(target_org, doc)` | The next document number. |

Voiding a bill, an invoice or a payment, and deleting a draft bill, a draft
invoice or a scheduled payment, are plain updates and deletes; the guards
decide whether they are allowed. A payment in is voided by the same update as
a payment out (`voidPayment` in `money.ts`).
```

- [ ] **Step 6: The error codes**

In `docs/bendahara-backend.md`, replace the section that starts at the line `## Error codes` and ends just before the line `## Known limits` with:

```markdown
## Error codes

The guards and functions raise these SQLSTATEs. `bills.ts`, `invoices.ts`,
`money.ts` and `contacts.ts` turn them into sentences; the same code is worded
for a bill or for an invoice by the file that made the call.

| Code | Meaning |
|---|---|
| `FIN01` | The bill or invoice is posted or void and cannot be changed or deleted. Also: a bill or an invoice must be created as a draft, a draft cannot be voided (delete it), and only a draft can be posted; the lines of a posted or void bill or invoice are locked with it. On a posted invoice only `einvoice_status` and `einvoice_uuid` may change; changing anything else, alone or with them, is this code. |
| `FIN02` | The bill or invoice has payments (posted, scheduled or in progress), so it cannot be voided |
| `FIN03` | The allocations add up to more than the payment |
| `FIN04` | A payment can only go against a posted bill or a posted invoice; only money out pays a bill, and only money in pays an invoice |
| `FIN05` | The amount is more than is still owed on the bill or the invoice, counting payments that are posted, scheduled, draft or pending approval |
| `FIN06` | No bill was chosen or found, or the bills belong to different suppliers; for money in, no invoice was chosen or found, or the invoices belong to different customers |
| `FIN07` | The contact has bills, so Supplier cannot be unticked |
| `FIN08` | The contact has invoices, so Customer cannot be unticked |
| `FIN09` | The payment, money out or money in, is posted or void and cannot be changed or deleted, its split cannot be changed, or it is not scheduled and so cannot be marked paid; a payment that was never posted cannot be voided (delete it) |
| `FIN10` | The bill or invoice has no lines, or its lines total nothing; it cannot be saved without a line or posted without an amount |
| `FIN11` | The bill, invoice or payment no longer exists. `finance_post_invoice` also answers this to a viewer: it locks the invoice before posting, and a viewer may not, so to them it is not there |
| `42501` | Row-level security refused the write: "You do not have permission to make changes here." |
| `22003` | A number does not fit its column (quantity × unit price can overflow): "That amount is too large." |
```

- [ ] **Step 7: Known limits**

In `docs/bendahara-backend.md`, replace:

```markdown
- Receivable is 0 until invoices exist.
```

with:

```markdown
- Invoices and Payments In are read-only so far: search, filters, "View all"
  and Export, but no forms and no row actions. The data layer for them is in
  `invoices.ts` and `money.ts`.
- Receivable on Customers & Suppliers is still 0: that screen does not read
  invoices yet.
- Nothing sets an invoice's e-Invois status yet; the columns, and the rule
  that lets them change on a posted invoice, are in place.
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
```

- [ ] **Step 8: Review the note against the SQL**

Run: `grep -o "errcode = '[A-Z0-9]*'" supabase/migrations/20261014100000_bendahara_invoices.sql | sort | uniq -c`
Expected: `FIN01` 9, `FIN02` 1, `FIN03` 1, `FIN04` 4, `FIN05` 2, `FIN06` 2, `FIN07` 1, `FIN08` 1, `FIN09` 2, `FIN10` 3, `FIN11` 2. Every one of those codes has a row in the note's table.

Run: `grep -n "^create or replace function public" supabase/migrations/20261014100000_bendahara_invoices.sql`
Expected: three lines, with the argument names `target_org`, `invoice`, `lines`; `target_org`, `target_invoice`; `target_org`, `payment`, `allocations`. The note's function table uses the same names.

- [ ] **Step 9: Run everything**

Run, as separate commands: `pnpm exec tsc --noEmit`, `pnpm lint`, `pnpm test`, `pnpm build`.
Expected: no type or lint errors; the build completes. `pnpm test` runs the database tests too when `.env.local` is present:
- If the controller has applied both migrations: every test passes.
- If only the schema migration is applied: exactly one test fails, 'a demo viewer reads the seeded invoices and payments in' in `tests/bendahara-sales.test.ts`.
- If neither is applied: `tests/bendahara-sales.test.ts` fails and nothing else.

With no `.env.local` and no Supabase variables in the shell, the database tests skip themselves instead, and one existing test file that is not finance's, `tests/reach-form-submissions.rls.test.ts`, fails to load ("supabaseUrl is required"): it builds a client as it loads. That failure is not caused by this branch; every other file passes.

Report which of these it was.

- [ ] **Step 10: Check for banned colours, names and server-only imports**

Run: `git diff origin/main...HEAD -- src | grep -n -i -E "^\+.*(purple|violet|fuchsia|indigo|kuasa\.ai)"`
Expected: no output.

Run: `grep -n -E "supabase/server|next/headers|server-only" src/lib/finance/*.ts src/screens/finance/sales-sample.ts src/components/finance/invoices-view.tsx src/components/finance/payments-in-view.tsx`
Expected: no output.

- [ ] **Step 11: Commit**

```bash
git add docs/bendahara-backend.md
git commit -m "docs: describe invoices, money in, their guards, functions and error codes"
```

- [ ] **Step 12: Hand back**

Do not push. Report what was built, the result of the four commands in Step 9 (and which of its three cases applied), and anything that had to differ from this plan.

The controller then, in this order:

1. Confirms Task 1 steps 9 to 13 are done (both migrations applied, the database tests green). The code must not be deployed before the schema migration is applied.
2. On the owner's word: `git fetch`, rebase onto `origin/main`, push, open the PR titled `feat-099-bendahara-invoices` (no close keyword unless `gh issue list` shows a tracking issue for this stage), squash-merge after review.
3. After the deploy, on production with the smoke account (`smoke@openkuasa-test.dev`): open `/finance/invoices` and `/finance/payments-in`. In the smoke workspace both show their empty states (four cards of RM 0, "Nothing invoiced or received in the last 8 months.", "No invoices yet.", "No payments yet."), no work-in-progress banner, no button that writes, and the last table row clear of the assistant button. In the demo workspace Invoices shows Total receivable RM 21.0k with 4 open invoices and a draft with "—" for its number; Payments In has `RC-0108` and `RC-0107` at the top. (The demo's Sent and Overdue split drifts with the calendar; the receivable total does not.) Export downloads a CSV from each. Wait for each page to finish loading before reading it.
4. Checks Supplier Bills and Payments Out on production once more: same figures as before the deploy.

---

## Self-review notes

**Spec coverage, build-order item 3, first half.**

| Spec | Where |
|---|---|
| `finance_invoices` + `finance_invoice_lines`: customer, dates, notes, status, e-Invois status and reference | Task 1 (migration). `quotation_id` deliberately left for stage 4 |
| Lines match `supplier_bill_lines` | Task 1, plus `position` (Decision 1) |
| `finance_allocations`: exactly one of the document ids | Task 1: `bill_id` or `invoice_id`; expenses and credit notes add theirs later |
| Sequences `invoice` (INV-), `receipt` (RC-) | Already defined by `finance_next_number`; used by Task 1's functions |
| Invoice balance and display status, never stored | Task 1, `finance_invoice_totals` (credit notes and refunds: stage 4) |
| Payments In = money in allocated to invoices | Task 1, `finance_payments_in` |
| A posted document is locked, only voided; enforced by triggers | Task 1, `finance_invoice_guard`, `finance_invoice_line_guard` |
| A document with posted money allocated cannot be voided | Task 1 (`FIN02`) |
| An allocation cannot exceed the transaction in total | Task 1 (`FIN03`, unchanged) and cannot exceed what the invoice owes (`FIN05`) |
| Only posted transactions change a balance | Task 1, the view's `t.status = 'posted'` |
| Multi-row writes are one `security invoker` function each | Task 1: save, post, record payment in |
| One Zod schema and one function per write, returning a result | Tasks 3 and 4 |
| Database refusals become plain sentences | Tasks 3 and 4 (`INVOICE_MESSAGES`, `RECEIPT_MESSAGES`, `CONTACT_MESSAGES.hasInvoices`) |
| Pure view builders | Task 5 |
| Layout kept; search and filters in the browser; "View all"; Export as CSV | Task 6 |
| Viewers get no buttons and no menus; sample view with no actions when there is no database | Task 6: nobody gets any in this stage |
| Screen added to `live-screens.ts` and its path to the revalidate list | Task 6 |
| Unit tests for every view builder and every schema | Tasks 2 to 6; `tests/finance-schemas.test.ts` in Task 4 |
| Database tests: isolation and viewer-cannot-write on each new table; locked after posting; balances after part payments | Task 1 (`tests/bendahara-sales.test.ts` and the check script) |
| "Numbering under two simultaneous posts" | Covered for the counter itself by the existing `tests/bendahara-foundation.rls.test.ts`; two simultaneous payments in are in Task 1 |
| Dry-run, apply before the code deploys, smoke-test | Task 1 steps 9 to 13; Task 7 step 12 |
| Left for 3b | Invoice and payment forms, row actions, server actions, "set e-Invois status", "record payment" from an invoice row |

**Placeholder scan.** Every code block in this plan is a whole file or an exact replacement; there is no "similar to", "as above", "TODO" or elided code. Each whole-file block was copied from a file that compiled, linted and passed its tests; the plan was then taken apart again, its blocks applied to an untouched copy of the repository task by task, and the result compared with those files.

**Type consistency across tasks.**

- `DocumentLineRow` (Task 2) is `BillLine` in `bills.ts` and `InvoiceLine` in `invoices.ts` (Task 3); `toDocumentLine` produces it for both.
- `InvoiceListRow` (Task 3) is what `invoicesView`, `filterInvoices`, `invoiceCustomers`, `invoicesCsv` (Task 5), `SAMPLE_INVOICES` (Task 5) and `InvoicesView`'s `rows` (Task 6) take. Its `display_status` values are the keys of `INVOICE_STATUS_LABELS` (Task 5) and `STATUS_STYLES` (Task 6), and the values the view in Task 1 produces: `draft`, `sent`, `overdue`, `paid`, `void`.
- `EInvoiceStatus` (Task 3) matches the check constraint in Task 1 and the keys of `EINVOICE_STATUS_LABELS` (Task 5); `EINVOICE_STYLES` (Task 6) covers the three that are shown.
- `PaymentInRow` (Task 4) has exactly the columns `listPaymentsIn` selects, which are columns of `finance_payments_in` (Task 1); it is what `paymentsInView`, `filterPaymentsIn`, `paymentsInCsv`, `invoicesView`'s second argument, `SAMPLE_PAYMENTS_IN` and `PaymentsInView`'s `rows` take.
- `LIST_COLUMNS` in `invoices.ts` and the extra columns `getInvoice` asks for (`subtotal`, `sst`, `notes`, `einvoice_uuid`) are all columns of `finance_invoice_totals`; `DOCUMENT_LINE_COLUMNS` are all columns of `finance_invoice_lines`, as is `position`, which `getInvoice` sorts by.
- The rpc argument names in Tasks 3 and 4 (`target_org`, `invoice`, `lines`; `target_org`, `target_invoice`; `target_org`, `payment`, `allocations`) are the SQL functions' parameter names in Task 1, and the keys inside `invoice`, `payment` and each allocation (`customer_id`, `invoice_date`, `due_date`, `notes`, `id`; `account_id`, `txn_date`, `method`, `reference`, `notes`; `invoice_id`, `amount`) are the keys those functions read.
- `InvoicesViewData` and `PaymentsInViewData` (Task 5) are the `view` props of the two components (Task 6); every field they have is used there (`stats`, `trend`, `hasTrend`, `byStatus`, `invoiceCount`; `stats`, `trend`, `hasTrend`, `byMethod`, `hasReceived`, `receivedMtd`).
- `Stat`, `LATEST_ROWS`, `displayDate`, `todayUtc` come from `view-helpers.ts` in the new files and, re-exported, from `purchase-views.ts` in the old ones: one definition.

**Review Focus mapped to tasks.**

| Focus | Proven by |
|---|---|
| 1. The rewritten allocation guard and bills | Task 1 step 9 (before/after comparison; check script's bill flow and cross-direction refusals), step 12 (`tests/bendahara-purchases.test.ts` unchanged and green; two tests in `tests/bendahara-sales.test.ts`) |
| 2. Two full payments at once | Task 1 step 12, `tests/bendahara-sales.test.ts` |
| 3. Deleting a workspace or a user | Task 1 steps 9 and 12, the check script |
| 4. A posted invoice written to directly | Task 1 steps 9 and 12, the check script and `tests/bendahara-sales.test.ts` |
| 5. A split payment and a payment of one sen | Task 5, `tests/finance-sales-views.test.ts`; Task 1, the split-payment database test |
| 6. CSV with hostile names; a draft's missing number | Task 5, `tests/finance-sales-views.test.ts` |

**How the SQL in this plan was checked before the plan was written, and what was not.** It could not be run on the hosted database. It was run on a throwaway local Postgres 17 with stand-ins for `auth`, `orgs`, `org_members` and the `private` helpers, on top of the repository's real finance migrations: the schema migration, the seed (twice), the check script (dry-run and applied), the controller's before/after and seed-report blocks, and a race of two full payments against one invoice all gave the results this plan states. The check script was also run against eighteen deliberately broken copies of the migration and failed on every one. Not covered by that: the hosted project's real `auth.users` columns and triggers, its real `mfa_ok`, PostgREST's view of the new objects, the demo workspace's real contacts, and `tests/bendahara-sales.test.ts` itself, which has only been type-checked. Steps 9 to 13 of Task 1 are where those are settled.
