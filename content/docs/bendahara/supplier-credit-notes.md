---
title: Supplier credit notes
description: Record credit a supplier gives you against a posted bill, and apply any credit left over to their later bills.
order: 38
ask: My supplier gave me a credit note for returned goods. How do I record it?
screen: /finance/supplier-credit-notes
---
Supplier Credit Notes holds the credit your suppliers give you against their bills. A credit note comes off what its bill owes. Whatever is left is open credit that you can put on a later bill from the same supplier.

## Who can do this

- Owners, admins and members can create, edit and delete draft credit notes.
- Only owners and admins can issue a credit note, void one, apply its credit to a bill, or take credit off a bill. A member sees this note under the page title: "An owner or admin issues them, voids them and applies their credit." A member who clicks **Save and issue** gets a saved draft.
- Viewers can only look. In the demo workspace nothing can be changed.

## Before you start

You need a posted supplier bill in ringgit that has not been fully credited. See [Supplier bills](/docs/bendahara/supplier-bills).

## Steps

### Record a credit note

1. Open **Supplier Credit Notes** under **Purchases** in the Bendahara menu.
2. Click **New credit note**. You can also choose **Credit note** on a posted bill's row in Supplier Bills.
3. Choose the bill under **Against bill**. The form shows the bill's total, what is already credited, and what is left to credit. What has been paid on the bill does not limit a credit note.
4. Set the **Credit note date** and the **Amount (RM)**.
5. Choose a **Reason**: **Overpaid**, **Returned goods**, **Short delivery** or **Other**.
6. Type the **Supplier's credit note no.** and any **Notes**.
7. Click **Save draft**, or **Save and issue**.

When a credit note is issued, it gets its number, goes in the books, and comes off what its bill still owes. After that it can no longer be edited or deleted, only voided.

### Apply open credit to another bill

1. Find an issued credit note with credit in the **Open** column.
2. Open the row's menu and choose **Apply to a bill**.
3. Choose the bill and the amount, then click **Apply credit**. That bill owes that much less. It makes no new entry in the books.

To undo it, choose **Take off** followed by the bill's number in the row's menu, then confirm with **Take off**.

### Void a credit note

Open the row's menu, choose **Void**, and confirm with **Void credit note**. Its entry is reversed on the day you void it, and the bill owes again what the credit note took off. It stays in the list as Void. This cannot be undone.

## Common problems

- **"There is no bill to credit."** A supplier credit note goes against a posted bill in ringgit, for no more than its total less what has already been credited.
- **"That is more than this bill has left to credit."**
- **"That is more than the credit note has left, or more than the bill still owes."** You tried to apply too much.
- **"Credit can only go on a bill from the same supplier."**
- **"Its credit is on a later bill. Take it off that bill first, then void the credit note."**
- **"Some of this credit is already on that bill. Take it off first, then apply the new amount."**

## Related

- [Supplier bills](/docs/bendahara/supplier-bills)
- [Payments out](/docs/bendahara/payments-out)
