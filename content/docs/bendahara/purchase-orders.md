---
title: Purchase orders
description: Raise a purchase order, send it for approval, record what is delivered, and make the supplier's bill from it.
order: 35
ask: How do I raise a purchase order and get it approved in Bendahara?
screen: /finance/purchase-orders
---
Purchase Orders follows an order to a supplier from approval to delivery and billing. An order starts as a draft. It gets its number when it is submitted for approval.

## Who can do this

- Owners, admins and members can create and edit drafts, submit them for approval, record deliveries and create a bill from an approved order.
- Only owners and admins can approve, reject or close an order. See [Approve purchase orders](/docs/bendahara/approve-purchase-orders).
- The person who raised an order can withdraw or cancel it. Owners and admins can withdraw or cancel anyone's.
- Viewers can only look. In the demo workspace nothing can be changed.

## Before you start

The supplier must be in [Customers and suppliers](/docs/bendahara/customers-suppliers) with **Supplier** ticked.

## Steps

![The Purchase Orders screen listing orders by status](/docs-media/bendahara/purchase-orders.png)

### Raise an order

1. Open **Purchase Orders** under **Purchases** in the Bendahara menu.
2. Click **New purchase order**.
3. Choose the **Supplier**, and set the **Order date**. **Expected delivery (optional)** cannot be before the order date.
4. If the order is in another currency, choose its **Currency**. See [Foreign currency](/docs/bendahara/foreign-currency).
5. Enter **Payment terms (days)**, or leave it empty to use the supplier's terms. Add a **Delivery address (optional)** if it is not your usual address.
6. Fill in the **Lines**, as on a bill.
7. Click **Save draft**, or **Save and submit for approval**.

### Submit, withdraw or delete a draft

- **Submit for approval** gives the order its number. An owner or admin other than you then has to approve it before anything is bought.
- **Withdraw** takes an order that is awaiting approval back to a draft, so it can be changed and submitted again.
- **Delete** removes a draft that has never been submitted. A draft that already has a number cannot be deleted; choose **Cancel order** instead. A cancelled order cannot be changed or reopened, and its number is not used again.

### Record a delivery

1. On an approved order, open the row's menu and choose **Record delivery**.
2. Under **Received so far**, enter the total received so far for each line, not just this delivery. A line shows **More than ordered** if you enter more than was ordered.
3. Click **Save delivery**.

### Create the bill

1. On an approved order, choose **Create bill**. If the order already has bills, you are asked whether to make another draft bill for the full order.
2. A draft bill is made with the order's supplier and lines, dated today. Check it and post it on [Supplier bills](/docs/bendahara/supplier-bills).

### Print an order

Choose **Print** on an approved or closed order. It prints with your letterhead, who prepared it and who approved it.

## Common problems

- **"A purchase order needs at least one line with an amount."**
- **"Only an owner or admin can do that to a purchase order."** Approving, rejecting and closing are for owners and admins, and so are withdrawing or cancelling someone else's order.
- **"This purchase order has bills against it. Void those bills, or delete them if they are drafts, first."**
- **"Enter the exchange rate before submitting the order."** An order in another currency needs a rate before it is submitted.
- **"That cannot be done to this purchase order as it now stands. …"** It changed since the page was loaded. Reload and check its status.

## Related

- [Approve purchase orders](/docs/bendahara/approve-purchase-orders)
- [RFQs](/docs/bendahara/rfqs)
- [Supplier bills](/docs/bendahara/supplier-bills)
