---
title: Payments in
description: Record money a customer paid you against one or more of their posted invoices, and void a payment recorded by mistake.
order: 23
ask: A customer paid two invoices in one transfer. How do I record it?
screen: /finance/payments-in
---
Payments In shows the money your customers have paid you against their invoices. One payment can pay several posted invoices from the same customer. The table shows one row for each invoice a payment pays. A payment in is posted the moment it is recorded, with its own number. It needs no approval.

## Who can do this

- Only owners and admins can record or void a payment in. Only they see **Record Payment** and the row menus.
- Members and viewers can see the payments. In the demo workspace nothing can be changed.

## Before you start

The invoices must be posted. See [Invoices](/docs/bendahara/invoices).

## Steps

### Record a payment

1. Open **Payments In** under **Sales** in the Bendahara menu.
2. Click **Record Payment**. You can also choose **Record payment** on a posted invoice's row in Invoices.
3. Choose the **Customer**. Their invoices that can still take money appear under **Invoices paid**.
4. Tick each invoice the payment covers and check the amount beside it. **Tick all** ticks every invoice.
5. Choose the account it was **Paid into**, the **Date received**, the **Method** and, if you have one, a **Reference**.
6. Click **Record payment**.

If the invoices are in another currency, type the amounts in that currency. The form then asks for **Ringgit received**: what arrived in the account, in RM. It shows about how much the invoices carry for what is paid, and the realised exchange gain or loss. See [Foreign currency](/docs/bendahara/foreign-currency).

### Void a payment

1. Open the payment's row menu and choose **Void**.
2. Confirm with **Void payment**. The invoices it paid will owe that amount again. This cannot be undone. A payment split across invoices is voided whole.

Payments in are not deleted, only voided.

## Common problems

- **"There is no invoice to take a payment for."** An invoice can be paid once it is posted, and until payments cover it in full.
- **"That is more than is still owed on an invoice."**
- **"One payment can only pay invoices from one customer."**
- **"A credit note on this invoice was issued after this payment. Void the credit note first, then the payment; issue the credit note again after."** This applies to invoices in another currency.
- **"The account this is on has been archived. …"** Restore it on Banking, or use another account.
- **"This date is in a closed period: the books are locked to …"** See [Accounting settings](/docs/bendahara/settings).

## Related

- [Invoices](/docs/bendahara/invoices)
- [Cash receipts](/docs/bendahara/cash-receipts)
- [Refunds](/docs/bendahara/refunds)
