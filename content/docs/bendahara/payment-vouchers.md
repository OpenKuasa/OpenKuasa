---
title: Payment vouchers
description: See every payment out in one list, record money out that settles no bill, and approve, pay or void vouchers.
order: 11
ask: How do I record a payment voucher for office rent in Bendahara?
screen: /finance/payment-vouchers
---
Payment Vouchers lists every movement of money out: payments to suppliers, payments of expenses, money out that settles no bill, and customer refunds (see [Refunds](/docs/bendahara/refunds)). It is part of the cash book. A voucher gets its payment voucher number when it is paid.

## Who can do this

- Owners, admins and members can create vouchers, save drafts, send them for approval, and delete a voucher that has not been paid.
- Only owners and admins can approve or reject a voucher, mark one as paid, or void one.
- When an owner or admin saves a new voucher for an expense category, it is approved at once. They can also choose **Paid now**.
- Viewers can only look. In the demo workspace nothing can be changed.

## Steps

![The Payment Vouchers screen with the period list, totals and the vouchers table](/docs-media/bendahara/payment-vouchers.png)

_Shown from the sample workspace, where editing is switched off._

### Record a voucher for an expense category

Use this for money out that settles no bill and no expense, such as rent.

1. Open **Payment Vouchers** under **Cash Book** in the Bendahara menu.
2. Click **New voucher**.
3. Under **What it is for**, choose **An expense category**.
4. Under **Paid to**, choose a contact, or choose **Not a contact** and type the **Name**.
5. Choose the **Expense category** and enter the **Amount**.
6. Choose the account it is **Paid from**, the date, the **Method** and any **Reference**.
7. If you are an owner or admin, choose **To be paid** or **Paid now** under **When**.
8. Click the first button. It reads **Send for approval** for a member, **Save voucher** for an owner or admin, or **Save as paid** when **Paid now** is chosen. Or click **Save as draft**.

The line above the buttons says what will happen. A member's voucher waits as **Pending approval** until an owner or admin approves or rejects it.

### Send a supplier's bills for approval

1. Click **New voucher** and choose **A supplier's bills** under **What it is for**.
2. Choose the **Supplier** and tick the **Bills to pay**, with the amount for each.
3. Fill in the account, date and method, then click **Send for approval** or **Save as draft**.

Once approved, it is **To be paid** on [Payments out](/docs/bendahara/payments-out). To schedule a supplier payment without approval, record it on Payments Out instead.

### Approve, reject, pay or void

Open a voucher's row menu:

- **Send for approval** on a draft. It then waits and cannot be changed, only approved, rejected or deleted.
- **Approve** or **Reject** on a voucher that is **Pending approval**. Once approved it is **To be paid**, exactly as it stands.
- **Mark as paid** on a voucher that is **To be paid**. Enter the date it was paid.
- **Void** on a paid voucher. The money counts as back in the account and the books reverse it. This cannot be undone.
- **Delete** on a voucher that is a draft, waiting or rejected, or one of this screen's own vouchers that is still to be paid.

Payments to suppliers and refunds are marked paid and voided on their own screens, [Payments out](/docs/bendahara/payments-out) and [Refunds](/docs/bendahara/refunds).

Use the **Period** list to see **This month**, **This quarter**, **This year** or **All time**.

## Common problems

- **"Say who is paid: choose a contact or type a name."**
- **"That is more than is still owed on a bill, counting what payments and vouchers not yet paid already hold."**
- **"A bill in another currency is paid on Payments Out, on the day the money leaves. It cannot wait for approval as a voucher."**
- **"This voucher is no longer a draft, so it cannot be changed. Check it again."**
- **"This date is in a closed period: the books are locked to …"** See [Accounting settings](/docs/bendahara/settings).

## Related

- [Approve and pay expenses](/docs/bendahara/approve-expenses)
- [Payments out](/docs/bendahara/payments-out)
- [Banking](/docs/bendahara/banking)
