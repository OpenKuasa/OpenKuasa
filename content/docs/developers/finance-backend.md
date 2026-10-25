---
title: Finance backend notes
description: How Bendahara's finance screens read and write, and the database rules a change must keep.
order: 11
ask: How does the Bendahara finance backend write to the database?
---
A short map of Bendahara's backend for contributors. The full reference, table by table and function by function, is [docs/bendahara-backend.md](https://github.com/OpenKuasa/OpenKuasa/blob/main/docs/bendahara-backend.md) in the repository.

## Who can do this

Anyone changing the finance code or its migrations.

## The write path

- Each write is one Zod schema and one function in `src/lib/finance/`. The function takes a `FinanceWriteContext` (`{ client, orgId }`) and returns a `FinResult`.
- The server actions in `src/app/(app)/finance/actions.ts` check the person may edit, parse the input with that schema, call the function, and refresh the screens that show the data.
- `org_id` never comes from the browser.
- Every action refuses a viewer and the demo workspace before the data layer is reached.
- A screen under `src/screens/finance/` is an async server component. It loads the rows, builds its figures with a pure function, and gives the client its actions only when the person can edit. With no Supabase project it shows sample data and no actions.
- Rules that need no browser are pure functions beside the data layer, with unit tests. The client components only draw them.

## The tables

- Every finance table carries `org_id`. A table other tables point at exposes a unique `(org_id, id)` and is referenced by that pair, so a row never points into another workspace.
- Every finance table has member-read, writer-write row-level security, with the restrictive `mfa_required` policy.
- Some steps are for owners and admins only. In the app this is the `sign-off-finance` capability in `src/lib/auth/permissions.ts` ("Post, pay & void finance documents"). It is kept in step with `private.finance_may_sign_off` in the database, which the policies and guards of the tables that need it call.

## Money is entered once

A movement of money is one row in `finance_transactions`, with a direction, an account, a date, an amount and a status. `finance_allocations` splits it across the documents it pays. Each allocation names exactly one document. Views such as `finance_payments_in` and `finance_payments_out` show one row per document a payment pays.

## Document numbers

`public.finance_next_number(target_org, doc)` returns the next number for a document type and moves the counter on. It locks the workspace's counter for that type, so two callers never get the same number. Call it from inside the database function that posts a document, so a failed post does not use up a number.

It runs as its owner (`security definer`) and is the only writer of `finance_sequences`.

## Posted is locked

Triggers enforce it, so no caller can get round it. A bill or an invoice is always created as a draft. A draft can be edited and deleted. A posted one can only be voided, and not while it has payments (posted, scheduled or in progress). Its lines are locked with it. A paid payment can only be voided. The full reference lists the rule for each document.

## Rules for a new migration

- **Keep `security definer` where it is.** A few functions run as their owner because they write something no signed-in person may write directly, such as a payment's number or the counters. Each begins by checking that the caller may write in `target_org` and answers `42501` if not. A migration that replaces one of them must keep `security definer` and that check. The list is under "Database functions" in the full reference.
- **Errors are `FINxx` codes.** The guards and functions raise SQLSTATEs `FIN01`, `FIN02` and so on, and the data layer turns each into a sentence. A new code takes the next number not yet used anywhere in the code.
- **Exchange rates are written only by the service role, and only inserted.** A stored rate never changes under a document that used it. They are fetched by a scheduled endpoint; see [Scheduled jobs](/docs/developers/scheduled-jobs).

## Related

- [How OpenKuasa is built](/docs/developers/architecture)
- [Keep the database up to date](/docs/developers/database-migrations)
- [CRM backend notes](/docs/developers/crm-backend)
