---
title: Journals
description: See every entry in your books, and post manual journals of debits and credits, such as depreciation.
order: 71
ask: How do I post a manual journal entry for depreciation in Bendahara?
screen: /finance/journals
---
Journals shows the ledger: every entry in the books, newest first, whatever made it, from invoices and bills to transfers and opening balances. Owners and admins can also enter manual journals of debits and credits.

## Who can do this

- Everyone in the workspace can read the ledger.
- Only owners and admins can create, post, delete or reverse manual journals. Only they see **New journal** and **Draft journals**.
- In the demo workspace nothing can be changed.

## Steps

![The Journals screen showing ledger entries with their debits and credits](/docs-media/bendahara/journals.png)

_Shown from the sample workspace, where editing is switched off._

### Post a manual journal

1. Open **Journals** under **Analytics** in the Bendahara menu.
2. Click **New journal**.
3. Set the **Date** and type the **Description**.
4. Under **Lines**, choose an account for each line and enter its **Debit (RM)** or **Credit (RM)**, not both. Add a **Note** if you want. A journal needs at least two lines.
5. Check the **Debits**, **Credits** and **Difference** totals. Debits and credits must be equal before the journal is posted.
6. Click **Save draft**, or **Save and post**.

A draft is not in the books. It waits under **Draft journals**, where you can **Edit**, **Post** or **Delete** it. Posting gives the journal its number and puts it in the books. After that it cannot be edited.

### Reverse a posted journal

1. Find the posted manual journal in the **Ledger** and click **Reverse**.
2. Confirm with **Reverse journal**.

This makes a draft dated today with the debits and credits swapped. It reaches the books when you post it. A journal can be reversed once.

### Find an entry

Search the **Ledger**, or filter it by source and by account. Sources include **Invoice**, **Supplier bill**, **Receipt**, **Payment**, **Expense**, **Transfer**, **Opening balance**, **Manual journal** and **Contra entry**.

## Common problems

- **"Debits and credits must be equal before the journal is posted."**
- **"A journal needs at least two lines, each on an active account."**
- **"Each line needs a debit or a credit, not both."**
- **"This journal already has a reversal."**
- **"This date is in a closed period: the books are locked to …"** See [Accounting settings](/docs/bendahara/settings).
- **"Only an owner or admin can change accounts or journals."**

## Related

- [Chart of accounts](/docs/bendahara/chart-of-accounts)
- [Financial reports](/docs/bendahara/financial-reports)
- [Drafts, posting and voiding](/docs/bendahara/posting-and-voiding)
