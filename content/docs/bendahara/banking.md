---
title: Banking
description: Add your bank and cash accounts, see their balances and every movement of money, and move money between accounts.
order: 40
ask: How do I add my bank account and its opening balance in Bendahara?
screen: /finance/banking
---
Banking shows a balance for each bank and cash account, your cash position over the last eight months, and every posted movement of money with the account's balance after it.

## Who can do this

- Owners, admins and members can add, edit, archive and restore accounts.
- Only owners and admins can set or change an opening balance. A member sees "An owner or admin sets an opening balance." in the form.
- Only owners and admins can record a transfer between accounts or void one. Only they see **Transfer**.
- Viewers can only look. In the demo workspace nothing can be changed.

## Steps

![The Banking screen with account balances, cash position and reconciliation](/docs-media/bendahara/banking.png)

_Shown from the sample workspace, where editing is switched off._

### Add an account

1. Open **Banking** under **Purchases** in the Bendahara menu.
2. Click **Add account**.
3. Type the **Name**, and choose the **Kind**: **Bank account** or **Cash**. The kind is set when the account is added.
4. Choose the **Currency** the account holds. It cannot be changed once the account is added.
5. For a bank account, type the **Bank** and the **Account number**.
6. If you are an owner or admin, enter the **Opening balance** and the date it was true under **As at**. Use a minus sign for an overdraft. An account in another currency also needs the exchange rate for its opening balance.
7. Click **Add account**.

### Edit, archive or restore an account

1. In the **Accounts** card, open the account's row menu.
2. Choose **Edit**, change the details and click **Save changes**. Renaming an account also renames its account in the Chart of Accounts, unless that one was renamed there.
3. Or choose **Archive** and confirm with **Archive account**. An archived account shows **Restore**.

### Move money between accounts

1. Click **Transfer**.
2. Choose the account it leaves under **From** and the account it goes to under **To**.
3. Enter the **Amount**, the **Date**, and any **Reference** and **Notes**. If the two accounts are in different currencies, the form asks for the **Amount leaving** and the **Amount arriving**, each in its account's currency. Both accounts are booked at the ringgit amount, and a transfer records no exchange gain or loss.
4. Click **Record transfer**.

Both accounts change at once and the transfer gets a TR- number. It cannot be edited afterwards, only voided. To void one, open the menu on either side of it in **Transactions** and choose **Void transfer**.

### Find a movement

Use the search box, the account list and the **Reconciliation** list in **Transactions**. **View all** shows every row and **Export** downloads them. The **Status** column shows **Reconciled** or **Unreconciled** only for a bank account that has a bank statement in Bendahara. Importing statements is not on this screen yet.

Other payments are changed on the screen that recorded them. **New receipt** takes you to Cash Receipts.

## Common problems

- **"Only an owner or admin can set or change an opening balance. If you are one, sign in again with your second step."**
- **"This account has payments that are still to be paid or waiting for approval. Pay, reject or delete them, then archive it."**
- **"Another bank or cash account already has that name. Archived accounts keep their names."**
- **"Choose two different accounts."**
- **"A transfer goes between a ringgit account and another account. …"** To move money between two accounts in other currencies, go through a ringgit account.
- **"The account this is on has been archived. Restore it on Banking, or use another account, then try again."** This appears on other screens when money is recorded on an archived account.

## Related

- [Payments out](/docs/bendahara/payments-out)
- [Payment vouchers](/docs/bendahara/payment-vouchers)
- [Foreign currency](/docs/bendahara/foreign-currency)
