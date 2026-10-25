---
title: Supplier bills
description: Record the bills your suppliers send you, post them to your books, and pay or void them.
order: 37
ask: How do I record and post a supplier bill in Bendahara?
screen: /finance/supplier-bills
---
Supplier Bills holds what your suppliers have billed you. A bill starts as a draft. It gets its number and reaches your books when it is posted.

## Who can do this

- Owners, admins and members can create, edit and delete draft bills.
- Only owners and admins can post a bill or void one. A member who clicks **Save and post** gets the bill saved as a draft, with a message that only an owner or admin can post it.
- Viewers can only look. In the demo workspace nothing can be changed.

## Before you start

The supplier must be in [Customers and suppliers](/docs/bendahara/customers-suppliers) with **Supplier** ticked. Without one, the form asks you to add a supplier first.

## Steps

![The Supplier Bills screen with payable totals, charts and the bills table](/docs-media/bendahara/supplier-bills.png)

_Shown from the sample workspace, where editing is switched off._

### Add a bill

1. Open **Supplier Bills** under **Purchases** in the Bendahara menu.
2. Click **New Bill**.
3. Choose the **Supplier**. The **Due date** follows the supplier's payment terms until you change it.
4. Type the **Supplier's reference**, such as their invoice number, if you have it.
5. Set the **Bill date** and check the **Due date**. The due date cannot be before the bill date.
6. If the bill is in another currency, choose its **Currency**. See [Foreign currency](/docs/bendahara/foreign-currency) for how the rate works.
7. If the bill is for an approved purchase order, choose it under **Purchase order**. The bill then takes the order's currency. You get a warning, not a refusal, if the bills for that order go over its total or over what has been received.
8. Pick a **Category**, or leave **Default category**.
9. Fill in the **Lines**: pick a **Product** to fill the line at its cost, or type a **Description**, **Qty**, **Unit**, **Unit price** and **SST %**. Use **Add line** for more.
10. Click **Save draft** to keep it as a draft, or **Save and post** to post it now.

### Edit, post or delete a draft

1. Find the draft in **Bills**. Use the **Status** list or search by number or supplier.
2. Open the row's menu and choose **Edit**, **Post** or **Delete**.
3. **Post** asks you to confirm: the bill gets its number and can no longer be edited, only voided.

### Pay, credit or void a posted bill

From a posted bill's row menu:

- **Pay** opens **Record payment** with this bill ticked. See [Payments out](/docs/bendahara/payments-out).
- **Credit note** records a credit from the supplier against this bill. See [Supplier credit notes](/docs/bendahara/supplier-credit-notes).
- **Void** asks you to confirm with **Void bill**. The bill stays in the list as Void and nothing more is owed on it. This cannot be undone.

Use **Export** to download the bills you are looking at.

## Common problems

- **"A bill needs at least one line with an amount."** A bill cannot be posted until its lines add up to more than zero.
- **"This bill is posted and can no longer be changed. Void it instead."** Posted bills are locked.
- **"This bill has payments. Void or delete them before voiding it."** Void or delete its payments on Payments Out first.
- **"A contra entry sets this off. Void the contra entry first."** See [Contra entries](/docs/bendahara/contra-entries).
- **"A supplier credit note is against this bill, or credit is applied to it. …"** Void or delete that credit note, or take the credit off, on Supplier Credit Notes first.
- **"Choose an approved purchase order from this supplier, or none."** Only approved orders from the same supplier can be chosen.
- **"This date is in a closed period: the books are locked to …"** The bill date is on or before the books lock date. See [Accounting settings](/docs/bendahara/settings).
- **"Only an owner or admin can post, pay or void. Ask one of them to do this."** You are a member.

## Related

- [Purchase orders](/docs/bendahara/purchase-orders)
- [Receipts inbox](/docs/bendahara/receipts-inbox)
- [Drafts, posting and voiding](/docs/bendahara/posting-and-voiding)
