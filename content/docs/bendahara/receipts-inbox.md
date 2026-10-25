---
title: Receipts inbox
description: Upload photos and PDFs of receipts, check their details, and turn them into expenses or draft bills, or attach them to ones you already entered.
order: 33
ask: How do I upload a receipt and turn it into an expense?
screen: /finance/receipts-inbox
---
The Receipts Inbox holds the photos and PDFs of receipts you upload. You check each one's details, then match it to an expense or a bill. A receipt here is a file, not a cash receipt.

## Who can do this

- Owners, admins and members can upload, review, read with AI, match and delete receipts.
- Anyone who can open the screen can download a receipt's file.
- Only owners and admins can untie a receipt from an approved expense or a posted bill. A member sees: "Only an owner or admin can untie a receipt from an approved expense or a posted bill."
- Viewers can only look. Uploading is switched off in the demo workspace.

## Steps

### Upload receipts

1. Open **Receipts Inbox** under **Purchases** in the Bendahara menu.
2. In **Add receipts**, drop the files in, or click **Browse files**. On a phone you can also use **Take photo**.
3. Files can be JPG, PNG, PDF or HEIC, up to 10 MB each. A new receipt waits as **To review**.

### Review a receipt

1. Open the receipt's row menu and choose **Review**.
2. Type what the receipt shows: **Vendor**, **Receipt date**, **Amount (RM), SST included** and **SST (RM)**. Leave a box empty if the receipt does not say.
3. Click **Save and mark reviewed**.

### Read a receipt with AI

You can have an AI model fill in the vendor, date, amount and SST for you to check. This uses your workspace's own AI key and its credit. The free chat questions are not used for receipts. See [Add your OpenRouter key](/docs/getting-started/openrouter-key).

1. On a receipt that is **To review**, choose **Read with AI**.
2. Read what will be sent, then click **Send to be read**.
3. What comes back fills the boxes as a suggestion and may suggest a category. Nothing is saved to an expense or a bill until you check the figures.

### Match a receipt

From the row menu:

- **Create expense** opens the expense form filled from the receipt. See [Record an expense](/docs/bendahara/expenses).
- **Create draft bill** opens the bill form filled from the receipt. It can only be saved as a draft.
- **Attach to expense or bill** ties the receipt to one you already entered. Choose it and click **Attach**.
- **Untie** takes a matched receipt off its expense or bill.

A matched receipt shows a paperclip on its expense or bill.

## Common problems

- **"That file is no longer waiting to be added: it did not arrive, or it waited more than 30 minutes. Upload it again."**
- **"A receipt cannot be dated after today."**
- **"This receipt is matched. Untie it from its expense or bill first."** A matched receipt cannot be deleted or changed.
- **"A HEIC photo cannot be read here. Type the details in, or upload it again as a JPG or PNG."**
- **"Receipts are read on your workspace's own AI key, and it has none yet. …"** An owner or admin can add one.
- **"The AI provider says your workspace's AI key has no credit left. Top it up, then try again."**
- **"You have reached today's limit for AI on your workspace's key. It resets at midnight UTC. You can still type the details in."**

## Related

- [Record an expense](/docs/bendahara/expenses)
- [Supplier bills](/docs/bendahara/supplier-bills)
