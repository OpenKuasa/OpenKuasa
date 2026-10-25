---
title: SST report
description: Set your SST taxable periods and registration numbers, see a summary of your SST-02 return to copy into MySST, and mark returns as filed.
order: 51
ask: How much service tax do I owe for this taxable period?
screen: /finance/sst-report
---
The SST Report is a summary of your SST-02 return, to copy into MySST. Nothing is sent to Customs (JKDM) from here. You also keep your SST settings on this screen.

## Who can do this

- Everyone in the workspace can see the SST settings and the return.
- Only owners and admins can change the SST settings, the typed-in figures, and mark a return as filed. Others see "Only an owner or admin can change SST settings."
- In the demo workspace nothing can be changed.

## Steps

### Set up SST

1. Open **SST Report** under **Compliance** in the Bendahara menu.
2. In **SST settings**, choose the pair of months under **Periods follow**: the two months of each taxable period, from your Customs (JKDM) registration.
3. Under **Service tax counted on**, choose **Payment received** or **Invoice issued (approved by Customs)**. **Payment received** is the default, so a workspace that never changes it gets **Not ready yet** for service tax (see below).
4. Type your **Service tax no.** and **Sales tax no.** If your company details have an SST number and both numbers here are still empty, you can click **Use for service tax** or **Use for sales tax**.
5. Click **Save**.

Until the taxable period is set, the screen asks you to set it to see your return.

### Read the return

1. Choose **Service tax** or **Sales tax**, and the **Taxable period**, at the top.
2. The return shows **Part A** (the business and the period), **Part B1** (taxable services or goods, by kind), **Part B2** (value and tax at each rate) and **Deductions and tax payable** (items 13 and 14).
3. Sales tax is counted when the goods are sold, by the invoice date. Service tax is counted on the basis you chose.

**Payment basis is not ready yet.** If service tax is counted on **Payment received**, the service tax return shows **Not ready yet** in place of Parts B1 and B2 and items 12 to 14, with the note "Not ready yet: service tax on payment basis is counted from payments received, which comes in the next step." Its payable amount in **Periods** also reads "not ready yet".

Part D (exempt items) is worked out once invoice lines can carry an exemption reason. Imported services and debit notes are not counted yet. Items 15 and 16 (late payment penalty) are worked out by Customs in MySST, so they are not shown.

### Before you file

Under the return, Bendahara may show "Not on the form" notes. Check each one before you copy the figures into MySST:

- "… at a rate with no item on this return. Fix their rate or tax type before you file."
- "… no SST tax type. Set one before you file."
- "13(a) is below zero because a credit note counted in an earlier return was voided this period."
- "13(a) includes … of tax on invoices from earlier returns that were voided this period."
- "item 14 is below zero because this period's deductions are more than its tax. Check with Customs (JKDM) how to claim it before you file."

### Type in figures from Customs

In **Typed-in figures**, owners and admins can enter figures from Customs' approvals and your own records, then click **Save**:

- Service tax: **11(e) Credit and charge cards (number)**, **13(c) Approved service tax deduction (RM)** and **13(d) Bad debt relief (approved) (RM)**.
- Sales tax: **13(b) Sales tax deduction (RM)**, **13A Adjustment under sales tax deduction (RM)** and **13(d) Bad debt relief (approved) (RM)**.

This card is not shown while the service tax return is not ready.

### Mark a return as filed

Bendahara cannot see MySST, so you mark a return as filed yourself. In **Periods**, each period shows its due date and what is payable, with **Open**, **Not filed** or **Marked filed**. Once a period has ended, click **Mark as filed**. Click **Undo** to take the mark off.

## Common problems

- **"You can mark a return as filed once its period has ended."**
- **"This return is marked filed. Undo the mark to change its figures."**
- **"Only an owner or admin can mark a return as filed."**

## Related

- [Products and services](/docs/bendahara/products)
- [Invoices](/docs/bendahara/invoices)
- [Accounting settings](/docs/bendahara/settings)
