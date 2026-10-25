---
title: Credit notes
description: Credit a customer against a posted invoice for returns, pricing, overbilling or goodwill, and refund any credit left over.
order: 22
ask: How do I issue a credit note against an invoice in Bendahara?
screen: /finance/credit-notes
---
Credit Notes holds the credits you give customers against their invoices. A credit note is one invoice, one amount and a reason. It starts as a draft and gets its number when it is issued.

## Who can do this

- Owners, admins and members can create, edit and delete draft credit notes.
- Only owners and admins can issue or void a credit note. A member who clicks **Save and issue** gets a saved draft, with a message that only an owner or admin can post or issue it.
- Viewers can only look. In the demo workspace nothing can be changed.

## Before you start

You need a posted invoice that has not been fully credited. See [Invoices](/docs/bendahara/invoices).

## Steps

### Record a credit note

1. Open **Credit Notes** under **Sales** in the Bendahara menu.
2. Click **New Credit Note**. You can also choose **Credit note** on a posted invoice's row in Invoices.
3. Choose the invoice under **Against invoice**. The form shows its total, what is already credited, and what is left to credit.
4. Set the **Credit note date** and the **Amount**. For an invoice in another currency the amount is in that currency.
5. Choose a **Reason**: **Returns**, **Pricing adjustment**, **Overbilling**, **Goodwill** or **Other**. Add any **Notes**.
6. Click **Save draft**, or **Save and issue**.

When it is issued, the credit note gets its number and the invoice owes that much less from then on. If that is more than is still owed, the customer is in credit and can be refunded. After this it can no longer be edited or deleted, only voided.

### Refund, void or delete

From the row menu:

- **Refund** on an issued credit note pays the credit back. It shows only while the customer is in credit, so something can still be paid out. See [Refunds](/docs/bendahara/refunds).
- **Void** on an issued credit note, confirmed with **Void credit note**. The invoice owes that amount again. It stays in the list as Void. This cannot be undone.
- **Edit**, **Issue** or **Delete** on a draft.

## Common problems

- **"There is no invoice to credit."** A credit note goes against a posted invoice, for no more than its total less what has already been credited.
- **"That is more than this invoice has left to credit."**
- **"A refund depends on this credit note. Void or delete that refund on Refunds before voiding it."**
- **"That cannot be done to this credit note as it now stands. …"** It was issued or voided since the page was loaded.
- **"This date is in a closed period: the books are locked to …"** See [Accounting settings](/docs/bendahara/settings).
- **"Only an owner or admin can post, pay or void. Ask one of them to do this."** Members still see **Issue** and **Void** in the row menus, but only an owner or admin can use them.

## Related

- [Invoices](/docs/bendahara/invoices)
- [Refunds](/docs/bendahara/refunds)
