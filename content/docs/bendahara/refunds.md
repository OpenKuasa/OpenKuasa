---
title: Refunds
description: Pay money back to a customer who is in credit on an invoice or a credit note, now or later, and void a refund paid by mistake.
order: 24
ask: My customer overpaid an invoice. How do I refund them?
screen: /finance/refunds
---
Refunds holds the money you pay back to customers who are in credit. A customer is in credit on an invoice when more was paid and credited than the invoice came to. A refund is paid out now, with a payment voucher number, or saved to pay later.

## Who can do this

- Owners, admins and members can save a refund to pay later and delete one that is still to be paid.
- Only owners and admins can pay a refund out now, mark a waiting one as paid, or void one. A member who chooses **Pay out now** is told: "Only an owner or admin can record this as paid. Save it as scheduled or pending instead."
- Viewers can only look. In the demo workspace nothing can be changed.

## Before you start

You need a posted invoice whose customer is in credit on it: more paid and credited than the invoice came to. The refund goes against that invoice, or against one of its issued credit notes. A credit note on an invoice that is not yet paid only lowers what is still owed; it leaves nothing to refund. See [Credit notes](/docs/bendahara/credit-notes).

## Steps

### Record a refund

1. Open **Refunds** under **Sales** in the Bendahara menu.
2. Click **New Refund**. You can also choose **Refund** on an invoice's row in Invoices, or on an issued credit note's row in Credit Notes. Both show only while the customer is in credit.
3. Choose what it is for under **Refund for**: an invoice or a credit note.
4. Enter the **Amount refunded** and choose a **Reason**: **Order cancelled**, **Damaged goods**, **Wrong item**, **Overpayment** or **Other**.
5. Choose the account it is **Paid from**, the **Date paid out** (or **Planned date** when paying later), the **Method** and any **Reference** and **Notes**.
6. Under **When**, choose **Pay out now** or **Pay later**.
7. Click **Record refund**, or **Save to pay later**.

A refund on an invoice in another currency is always paid out now. The form then asks for the **Ringgit paid out**.

### Mark as paid, delete or void

From the row menu:

- **Mark as paid** on a refund that is **To be paid**.
- **Delete** on a refund that is still to be paid. Nothing has been paid out, so the customer stays in credit.
- **Void** on a refund that was paid out. Confirm with **Void refund**. The customer is in credit by that amount on the invoice again. It stays in the list as Void. This cannot be undone.

## Common problems

- **"There is nothing to refund."** A refund pays out what a customer is in credit on a posted invoice, less any refund already waiting to be paid out.
- **"That is more than the customer is in credit, or more than is left of the credit note."**
- **"This refund can no longer be paid out: its invoice is no longer posted, or its credit note is no longer issued. Delete it."**
- **"This refund no longer fits in what the customer is in credit, … so it cannot be paid out. Delete it. …"** The credit has gone since the refund was saved, often because a payment was voided.
- **"This date is in a closed period: the books are locked to …"** See [Accounting settings](/docs/bendahara/settings).
- **"Only an owner or admin can post, pay or void. Ask one of them to do this."** Members still see **Mark as paid** and **Void** in the row menus, but only an owner or admin can use them.

## Related

- [Credit notes](/docs/bendahara/credit-notes)
- [Payment vouchers](/docs/bendahara/payment-vouchers)
