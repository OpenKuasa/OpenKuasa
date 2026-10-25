---
title: Customers and suppliers
description: Add, change, archive and delete the customers and suppliers you bill and buy from in Bendahara.
order: 60
ask: How do I add a new supplier in Bendahara?
screen: /finance/customers-suppliers
---
Customers & Suppliers holds everyone you send invoices to or buy from. One contact can be both a customer and a supplier.

## Who can do this

Owners, admins and members can add, edit, archive and delete contacts. Viewers can only look. In the demo workspace nothing can be changed.

## Steps

![The Customers and Suppliers screen with counts, open balances and the contacts table](/docs-media/bendahara/customers-suppliers.png)

_Shown from the sample workspace, where editing is switched off._

### Add a contact

1. Open **Customers & Suppliers** under **Records** in the Bendahara menu.
2. Click **Add Contact**.
3. Type the **Name**.
4. Under **This contact is a**, tick **Customer**, **Supplier** or both.
5. Fill in what you have: **Email**, **Phone**, **SSM No.**, **Tax number (TIN)** and **Payment terms (days)**. Payment terms start at 30 days.
6. Pick a **Default currency** if this contact deals in another currency. A new quotation for this contact starts in it. Leave it at **None (ringgit)** otherwise.
7. Click **Add contact**.

### Change, archive or delete a contact

1. Find the contact in **All contacts**. You can search by name, email, SSM number or TIN, and use the **Show** list to see **All active**, **Customers**, **Suppliers** or **Archived**.
2. Open the row's menu and choose **Edit**, **Archive** (or **Restore**), or **Delete**.
3. For **Edit**, change the details and click **Save changes**.
4. For **Delete**, confirm with **Delete contact**. This cannot be undone.

The **Receivable** and **Payable** columns show what each contact owes you from invoices and what you owe them on open bills.

## Common problems

- **"Tick Customer, Supplier or both."** A contact needs at least one of the two.
- **"Payment terms must be between 0 and 365 days."** Enter a whole number of days from 0 to 365.
- **"This contact is used on bills or other documents. Archive it instead."** A contact on any document cannot be deleted. Archive it, and it leaves your active lists.
- **"This contact has supplier bills, so it has to stay a supplier."** You cannot untick **Supplier** once the contact has bills.
- **"This contact has invoices or quotations, so it has to stay a customer."** You cannot untick **Customer** once the contact has invoices or quotations.
- The list shows up to 1,000 contacts, the first 1,000 by name.

## Related

- [Products and services](/docs/bendahara/products)
- [Who can do what in Bendahara](/docs/bendahara/roles-and-sign-off)
