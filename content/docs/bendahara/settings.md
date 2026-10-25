---
title: Accounting settings
description: Set your financial year end, lock the books up to a date, and change the prefix and next number of each document.
order: 80
ask: How do I lock my books after I close the month?
screen: /finance/settings
---
Accounting Settings holds your financial year, the books lock, document numbering, and links to your company's legal details, SST settings and bank accounts.

## Who can do this

- Only owners and admins can change the financial year, the books lock and the numbering. Others see "Only an owner or admin can change the numbering."
- **Edit in Account** on the legal details is shown to owners and admins.
- Everyone in the workspace can see the settings. In the demo workspace nothing can be changed.

## Steps

### Set the financial year and lock the books

1. Open **Settings** under **Configuration** in the Bendahara menu.
2. In **Financial year & books lock**, choose the month under **Financial year ends in**.
3. Under **Lock the books up to**, pick the last date of the closed period. It cannot be after today.
4. Click **Save**.

The card then shows **Books locked to** and the date. Nothing dated on or before that date can be posted, voided or paid. This covers invoices, credit notes, supplier bills, supplier credit notes, payments, approved expenses, contra entries, journals, FX revaluations and opening balances. Drafts are not checked. To reopen a period, move the date back.

### Change document numbering

1. In **Document numbering**, find the document. Each row shows its **Prefix**, **Next number** and an **Example**.
2. Change the prefix or the next number.
3. Click **Save**.

The next number can only go up, so no number is ever given twice. Each document needs its own prefix.

### Other cards

- **Legal details** shows your SST number, TIN and address, which are printed on invoices and reports. Change them under Account, Company.
- **SST** links to the SST settings.
- **Bank accounts** links to [Banking](/docs/bendahara/banking).
- **Base currency** is MYR (Malaysian ringgit). Every report and the ledger are kept in ringgit.
- **Integrations & notifications** are **Coming soon**: MyInvois integration, auto-submit of validated invoices, FPX auto-reconciliation, e-Invois alerts, overdue reminders and SST due reminders. Their switches are turned off and cannot be used yet.

## Common problems

- **"This date is in a closed period: the books are locked to …"** Shown on any screen when you post, void or pay something dated in the locked period. Move the lock date back, or use a later date.
- **"The books can't be locked to a date in the future."**
- **"The next number can't go back: it must be … or more."**
- **"A prefix is 1 to 10 letters, numbers, dashes or slashes."**
- **"Another document already uses this prefix."**
- **"Only an owner or admin can change accounting settings."**

## Related

- [Drafts, posting and voiding](/docs/bendahara/posting-and-voiding)
- [Banking](/docs/bendahara/banking)
