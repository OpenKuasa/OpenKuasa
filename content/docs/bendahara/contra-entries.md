---
title: Contra entries
description: Set off what a contact owes you against what you owe them, when they are both your customer and your supplier.
order: 73
ask: A customer is also my supplier. How do I set off their invoice against their bill?
screen: /finance/contra-entries
---
A contra entry sets a contact's invoices off against their bills. No money moves. Both sides go down by the same amount, and the entry goes in your books.

## Who can do this

- Only owners and admins can record, post, void or delete contra entries. A member sees "Only an owner or admin can record contra entries." under the page title.
- Everyone in the workspace can see the list.
- In the demo workspace nothing can be changed.

## Before you start

- The contact must be both a customer and a supplier. See [Customers and suppliers](/docs/bendahara/customers-suppliers).
- They need at least one posted invoice and one posted bill, both in ringgit, that still owe something.

## Steps

### Record a contra entry

1. Open **Contra Entries** under **Analytics** in the Bendahara menu.
2. Click **New contra entry**.
3. Choose the **Contact**, set the **Date**, and enter the **Amount set off (RM)**.
4. Under **Invoices they owe you**, choose the invoices and how much of each to set off. Do the same under **Bills you owe them**. Each side must add up to the amount.
5. Add a **Reference**, such as their agreement or letter number, and a **Note** if you want.
6. Click **Save draft**, or **Save and post**.

### Post, edit, delete or void

From the row menu:

- **Edit** or **Delete** a draft.
- **Post** a draft. It gets its number and cannot be edited after. The contact owes you that much less on the invoices, and you owe them that much less on the bills.
- **Void** a posted contra entry. What it set off is owed again, both ways, and the books reverse it. This cannot be undone.

While a posted contra entry sets off an invoice or bill, that invoice or bill cannot be voided. Void the contra entry first.

## Common problems

- **"Choose a contact who is both a customer and a supplier."**
- **"Before posting, choose at least one invoice and one bill, and make each side add up to the contra entry's amount."**
- **"A contra entry can only set off invoices and bills in ringgit."**
- **"One of the invoices or bills owes less than the amount set off against it now. …"** Reload the page to see what each still owes.
- **"Refunds paid on one of its invoices depend on this contra entry, so it cannot be voided."**
- **"Only an owner or admin can record, post or void contra entries."**

## Related

- [Supplier bills](/docs/bendahara/supplier-bills)
- [Customers and suppliers](/docs/bendahara/customers-suppliers)
