---
title: Drafts, posting and voiding
description: How Bendahara keeps your books safe: drafts can change, posted documents are locked, and mistakes are voided, not edited.
order: 5
ask: I posted a supplier bill with the wrong amount. How do I fix it?
---
Bendahara keeps a clear line between work in progress and your books. These rules are enforced by the database, so they hold on every screen and for the assistant too.

## Who can do this

Owners, admins and members can work on drafts. Only owners and admins can post, pay and void. See [Who can do what in Bendahara](/docs/bendahara/roles-and-sign-off).

## Drafts

- A new bill, journal, contra entry or supplier credit note starts as a draft. A draft can be edited and deleted.
- A draft has no number yet and is not in your books.
- Saving a draft never uses up a document number.

## Posting

- Posting gives a document its number, such as BILL-0001, and puts it in your books.
- A bill can only be posted once its lines add up to more than zero.
- Some documents are sent or submitted rather than posted: a purchase order gets its number when it is submitted for approval, and an RFQ when it is marked as sent.
- Prefixes and next numbers are set in [Accounting settings](/docs/bendahara/settings). A number is never given twice.

## Posted documents are locked

Once posted, a document cannot be edited or deleted. Its lines are locked with it. If you try, you see a message such as "This bill is posted and can no longer be changed. Void it instead."

## Voiding

To undo a posted document, void it. It stays in the list as **Void**, and the books reverse it. Voiding cannot be undone. If the document was wrong, void it and enter it again.

Some things must be undone first:

- A bill with payments cannot be voided until they are voided or deleted.
- A bill or invoice set off by a contra entry cannot be voided until the contra entry is voided.
- A bill with a supplier credit note against it, or credit applied to it, cannot be voided until that is voided, deleted or taken off.
- A posted manual journal is not voided. It is reversed: see [Journals](/docs/bendahara/journals).

## The books lock

An owner or admin can lock the books up to a date in [Accounting settings](/docs/bendahara/settings). Nothing dated on or before that date can then be posted, voided or paid. You see "This date is in a closed period: the books are locked to …". Drafts are not affected.

## Related

- [Who can do what in Bendahara](/docs/bendahara/roles-and-sign-off)
- [Supplier bills](/docs/bendahara/supplier-bills)
- [Audit trail](/docs/bendahara/audit-trail)
