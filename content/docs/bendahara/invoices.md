---
title: Invoices
description: Raise sales invoices with SST and discounts, post them to your books, and record payments, credit notes and refunds against them.
order: 21
ask: How do I create and post a sales invoice in Bendahara?
screen: /finance/invoices
---
Invoices holds what you have billed your customers. An invoice starts as a draft. It gets its number and reaches your books when it is posted. Once posted it shows as **Sent**, or **Overdue** after its due date, until it is **Paid**.

## Who can do this

- Owners, admins and members can create, edit and delete draft invoices, record a credit note as a draft, and record the e-Invois status.
- Only owners and admins can post or void an invoice, and record a payment against one. A member who clicks **Save and post** gets the invoice saved as a draft, with a message that only an owner or admin can post it.
- Viewers can only look. In the demo workspace nothing can be changed.

## Before you start

The customer must be in [Customers and suppliers](/docs/bendahara/customers-suppliers) with **Customer** ticked.

## Steps

![The Invoices screen with receivable totals, charts and the invoices table](/docs-media/bendahara/invoices.png)

### Raise an invoice

1. Open **Invoices** under **Sales** in the Bendahara menu.
2. Click **New Invoice**.
3. Choose the **Customer**. The **Due date** follows the customer's payment terms until you change it.
4. Set the **Invoice date** and check the **Due date**. The due date cannot be before the invoice date.
5. If the goods were sold or the service provided on another day, set the **Date of supply (if not the invoice date)**. It sets the exchange rate on a foreign invoice and, for service tax, when the 12 months for an unpaid invoice start.
6. If the invoice is in another currency, choose its **Currency**. See [Foreign currency](/docs/bendahara/foreign-currency).
7. Fill in the **Lines**: pick a **Product** to fill the line at its selling price, or type a **Description**, **Qty**, **Unit**, **Unit price** and **SST %**. Each line can have a **Discount**, in % or in the invoice's currency.
8. To take something off the whole invoice, use **Discount on the whole invoice**.
9. Click **Save draft**, or **Save and post**.

### Edit, post or delete a draft

Open the draft's row menu and choose **Edit**, **Post** or **Delete**. **Post** asks you to confirm: the invoice gets its number and can no longer be edited, only voided.

### After posting

From a posted invoice's row menu:

- **Record payment** opens the payment form with this invoice ticked. See [Payments in](/docs/bendahara/payments-in).
- **Credit note** credits part or all of the invoice. See [Credit notes](/docs/bendahara/credit-notes).
- **Refund** appears when the customer is in credit on the invoice. See [Refunds](/docs/bendahara/refunds).
- **Set e-Invois** records the status and LHDN UUID you have for the invoice. Nothing is submitted to LHDN from here. See [e-Invoice LHDN](/docs/bendahara/e-invoice).
- **Void** asks you to confirm with **Void invoice**. It stays in the list as Void and nothing more is owed on it. This cannot be undone.

Use the status and customer lists and the search box to find invoices, and **Export** to download them.

## Common problems

- **"An invoice needs at least one line with an amount."**
- **"A discount on the whole document must leave something to pay."**
- **"This invoice has been posted or voided, so that can no longer be done."** It changed since the page was loaded.
- **"This invoice has payments or refunds. Void the payments on Payments In, and void or delete the refunds on Refunds, before voiding it."**
- **"This invoice has credit notes. Void them on Credit Notes, or delete the drafts, before voiding it."**
- **"A contra entry sets this off. Void the contra entry first."**
- **"e-Invois details can be recorded once the invoice is posted."**
- **"This date is in a closed period: the books are locked to …"** See [Accounting settings](/docs/bendahara/settings).

## Related

- [Quotations](/docs/bendahara/quotations)
- [Payments in](/docs/bendahara/payments-in)
- [Drafts, posting and voiding](/docs/bendahara/posting-and-voiding)
