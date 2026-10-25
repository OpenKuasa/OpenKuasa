---
title: Quotations
description: Give customers quotations, record whether they accepted or declined, and turn an accepted one into a draft invoice.
order: 20
ask: How do I turn an accepted quotation into an invoice?
screen: /finance/quotations
---
Quotations holds the quotes you have given your customers and their answers. A quotation starts as a draft. It gets its number when you mark it as sent. Bendahara does not email it for you.

## Who can do this

Owners, admins and members can create, send, answer, delete and convert quotations. Viewers can only look. In the demo workspace nothing can be changed.

## Before you start

The customer must be in [Customers and suppliers](/docs/bendahara/customers-suppliers) with **Customer** ticked.

## Steps

![The Quotations screen with open quotes, the acceptance funnel and the quotations table](/docs-media/bendahara/quotations.png)

### Give a quotation

1. Open **Quotations** under **Sales** in the Bendahara menu.
2. Click **New Quotation**.
3. Choose the **Customer** and set the **Quotation date**. **Valid until** starts 30 days after the quotation date. It cannot be before the quotation date.
4. If you quote in another currency, choose the **Currency**. A customer's **Default currency** fills it for you. See [Foreign currency](/docs/bendahara/foreign-currency).
5. Fill in the **Lines**, with any line **Discount** or **Discount on the whole quotation**. A product fills a line at its selling price.
6. Click **Save draft**, or **Save and mark as sent**.

**Mark as sent** gives the quotation its number. After that it can no longer be edited or deleted. Only the customer's answer is recorded.

### Record the customer's answer

From the row menu of a sent quotation:

- **Mark accepted**. You can do this even after its valid-until date; it then shows **Expired** until answered.
- **Mark declined**. Use this too for a quotation that is no longer wanted: a quotation cannot be voided.

The answer can be changed until an invoice is made from the quotation.

### Make an invoice

1. On an accepted quotation, choose **Make invoice**.
2. Confirm with **Make invoice**. A draft invoice is made with the same customer, notes and lines, dated today.
3. Check it and post it on [Invoices](/docs/bendahara/invoices). The quotation's **Invoice** column shows it.

A quotation in another currency becomes an invoice in that currency, at Bank Negara Malaysia's selling rate for the new invoice's date. The note says "Invoice drafted in … at Bank Negara Malaysia's selling rate of …", or, when Bank Negara has no rate, "Invoice drafted in …. Enter its exchange rate before posting."

## Common problems

- **"A quotation needs at least one line with an amount."**
- **"Only an accepted quotation can be made into an invoice."**
- **"This quotation already has an invoice. Void that invoice, or delete it if it is a draft, first."**
- **"Enter the exchange rate before marking it as sent."**
- **"That cannot be done to this quotation as it now stands. …"** It was sent, accepted or declined since the page was loaded.

## Related

- [Invoices](/docs/bendahara/invoices)
- [Products and services](/docs/bendahara/products)
