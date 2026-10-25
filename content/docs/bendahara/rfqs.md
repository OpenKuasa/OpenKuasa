---
title: RFQs
description: Ask suppliers to quote, record their prices, compare quotes side by side and turn the best one into a purchase order.
order: 34
ask: How do I compare quotes from three suppliers in Bendahara?
screen: /finance/rfqs
---
RFQs (requests for quotation) keep track of what you have asked suppliers to quote, and the prices they came back with. Bendahara does not email the RFQ for you. You send it yourself and mark it as sent.

## Who can do this

Owners, admins and members can do everything on this screen. Viewers can only look. In the demo workspace nothing can be changed.

## Before you start

The supplier must be in [Customers and suppliers](/docs/bendahara/customers-suppliers) with **Supplier** ticked.

## Steps

![The RFQs screen listing requests for quotation and their status](/docs-media/bendahara/rfqs.png)

_Shown from the sample workspace, where editing is switched off._

### Ask for a quote

1. Open **RFQs** under **Purchases** in the Bendahara menu.
2. Click **New RFQ**.
3. Choose the **Supplier**, the **RFQ date** and, if you want, **Reply by (optional)**. The reply-by date cannot be before the RFQ date.
4. Choose a **Currency** if the supplier quotes in another currency.
5. Fill in the **Lines** with what you want quoted.
6. Click **Save draft**, or **Save and mark as sent**.

**Mark as sent** gives the RFQ its number. After that it can no longer be edited or deleted. Only the supplier's answer is recorded. A sent RFQ whose reply-by date has passed shows **Reply overdue**.

### Ask more suppliers for the same items

Open the RFQ's row menu and choose **Copy to another supplier**. You get a new draft with the same lines, for the supplier you choose. Copies of one RFQ form a group you can compare.

### Record the supplier's prices

1. On a sent RFQ, choose **Record prices**.
2. Type the **Supplier reference**, such as their quotation number.
3. Under **Prices quoted**, enter the unit price and SST rate for every line.
4. Click **Save prices**. The RFQ is marked as **Quoted**.

### Compare quotes

When an RFQ and at least one other in its group have been sent, choose **Compare quotes**. Each item is a row and each supplier a column. **Lowest** marks the lowest price for one unit once SST is added. A supplier who gave no price for a line shows **Not quoted**.

### Make a purchase order

On a quoted RFQ, choose **Make purchase order**, from the row menu or from the comparison. You get a draft purchase order with the same supplier and lines, at the prices quoted. It stays a draft on [Purchase orders](/docs/bendahara/purchase-orders) until it is submitted for approval. The other RFQs stay as they are.

### Close an RFQ

Choose **Close RFQ** for an RFQ that is no longer wanted, or one that has been dealt with. A closed RFQ cannot be changed or reopened.

## Common problems

- **"Enter a price for every line before marking the RFQ as quoted."**
- **"This RFQ already has a purchase order. Cancel that order first to make another."**
- **"The RFQ this was copied from can no longer be found. Save again to keep this one on its own."** The first RFQ was deleted while you were copying it.
- **"There are no other quotes for this request to compare it with."**

## Related

- [Purchase orders](/docs/bendahara/purchase-orders)
- [Products and services](/docs/bendahara/products)
