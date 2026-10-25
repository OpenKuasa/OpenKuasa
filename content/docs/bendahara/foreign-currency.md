---
title: Foreign currency
description: How Bendahara handles documents, payments and bank accounts in another currency, and which Bank Negara Malaysia rate it uses.
order: 6
ask: How does Bendahara work out the ringgit value of a USD bill?
---
Your books are kept in ringgit (MYR). You can still raise documents, pay and hold bank accounts in another currency. Bendahara turns each amount into ringgit at an exchange rate, and keeps that rate with the document.

## Who can do this

Anyone who can create a document can choose its currency. The usual role rules apply to posting, paying and revaluing. See [Who can do what in Bendahara](/docs/bendahara/roles-and-sign-off).

## The exchange rate

- On a quotation, invoice, supplier bill, RFQ or purchase order, choose the **Currency**. You then type the amounts in that currency.
- The **Exchange rate** box is ringgit per one unit of the currency, or per 100 units for some currencies, as Bank Negara Malaysia publishes them. The label says which, for example "Exchange rate (RM per 100 JPY)".
- The box fills with Bank Negara Malaysia's 5 pm selling rate for the document's date: the newest rate on or before that date. The note under the box says so, with the date.
- Rates are fetched from Bank Negara Malaysia every working day after 5:30 pm, when your host runs the daily rates job. Bank Negara does not publish a rate for every currency. For one it does not, type the rate yourself.
- You can type a different rate. The note then reads "Typed by hand." On a bill you must also say **Where this rate comes from**, and for some sources the bank's name or the approval reference.
- If your rate is more than 20% away from Bank Negara Malaysia's, you are asked once. Save again to keep it.
- A document in another currency needs a rate before it is posted, sent or submitted.
- For a currency with no cents, such as JPY, enter whole amounts.

A contact's **Default currency** fills the currency of a new document for them. See [Customers and suppliers](/docs/bendahara/customers-suppliers). A bill against a purchase order is always in the order's currency.

## Paying in another currency

- Paying foreign bills from a ringgit account: type the amounts in the bills' currency, then the **Ringgit paid out**. The form shows the realised exchange gain or loss. Such a payment is recorded as paid now, never scheduled. See [Payments out](/docs/bendahara/payments-out).
- A bank account can hold another currency. Choose it when you add the account; it cannot be changed later. See [Banking](/docs/bendahara/banking).
- A transfer goes between a ringgit account and another account. Both are booked at the ringgit amount, and a transfer records no exchange gain or loss.

## What stays in ringgit

- Supplier credit notes and contra entries work only on ringgit bills and invoices.
- Expenses are paid from a ringgit account.
- Every report and the ledger are in ringgit.

## Month end

At a month end, an owner or admin can revalue what is still open in other currencies at the closing rates. See [FX revaluation](/docs/bendahara/fx-revaluation).

The **Exchange rates** card on Banking shows Bank Negara Malaysia's latest 5 pm middle rates, for reference. It appears only for a workspace that deals in another currency.

## Related

- [FX revaluation](/docs/bendahara/fx-revaluation)
- [Banking](/docs/bendahara/banking)
- [Supplier bills](/docs/bendahara/supplier-bills)
