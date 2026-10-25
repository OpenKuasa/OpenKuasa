---
title: Payments out
description: Pay one supplier's posted bills now or schedule the payment for later, then mark it paid or void it.
order: 39
ask: How do I pay several bills from one supplier in Bendahara?
screen: /finance/payments-out
---
Payments Out shows the money you pay to suppliers. One payment can pay several posted bills from the same supplier. The table shows one row for each bill a payment pays.

## Who can do this

- Owners and admins can pay now, mark a scheduled payment as paid, and void a payment.
- Members can schedule a payment for later and delete a payment that is still to be paid. If a member chooses **Pay now**, they are told: "Only an owner or admin can record this as paid. Save it as scheduled or pending instead."
- Viewers can only look. In the demo workspace nothing can be changed.

## Before you start

The bills must be posted. See [Supplier bills](/docs/bendahara/supplier-bills).

## Steps

### Record a payment

1. Open **Payments Out** under **Purchases** in the Bendahara menu.
2. Click **Record Payment**. You can also choose **Pay** on a bill's row in Supplier Bills.
3. Choose the **Supplier**. Their open bills appear under **Bills to pay**.
4. Tick each bill you are paying and check the amount beside it. **Tick all** ticks every bill.
5. Choose the account it is **Paid from**, the **Date paid**, the **Method** and, if you have one, a **Reference**.
6. Under **When**, choose **Pay now** or **Schedule for later**. A scheduled payment asks for a **Planned date**.
7. Click **Record payment**, or **Schedule payment**.

### Mark a scheduled payment as paid, or delete it

1. Find the row with the status **To be paid**.
2. Open the row's menu and choose **Mark as paid**. Enter the date it was paid and confirm with **Mark as paid**.
3. Or choose **Delete** and confirm with **Delete payment**. Nothing was paid, so the bills stay as they are.

### Void a paid payment

1. Find the row with the status **Paid**.
2. Open the row's menu, choose **Void**, and confirm with **Void payment**. The bills it paid will owe that amount again. This cannot be undone.

## Bills in another currency

If the bills are in another currency, you type the amounts in that currency. The form then asks for **Ringgit paid out**: what left the account, in RM. Such a payment is always paid now, never scheduled. The form shows about how much the bills carry for what is paid, and the realised exchange gain or loss. See [Foreign currency](/docs/bendahara/foreign-currency).

## Common problems

- **"That is more than is still owed on a bill."** A payment cannot pay more than a bill still owes. Payments still to be paid count too.
- **"One payment can only pay bills from one supplier."** Record a separate payment for each supplier.
- **"One payment can cover at most 50 bills."**
- **"The account this is on has been archived. …"** Restore the account on Banking, or use another account.
- **"This date is in a closed period: the books are locked to …"** See [Accounting settings](/docs/bendahara/settings).

## Related

- [Supplier bills](/docs/bendahara/supplier-bills)
- [Payment vouchers](/docs/bendahara/payment-vouchers)
- [Banking](/docs/bendahara/banking)
