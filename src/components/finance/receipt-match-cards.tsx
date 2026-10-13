'use client';

import { type FormEvent, useId, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { BentoCard } from '@/components/bento/bento';
import { BillFormCard } from '@/components/finance/bill-form-card';
import { ExpenseFormCard } from '@/components/finance/expense-form-card';
import { useFinanceAction } from '@/components/finance/use-finance-action';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { FinanceContact } from '@/lib/finance/contacts';
import type { ExpenseCategory, SavedExpense } from '@/lib/finance/expenses';
import { rm } from '@/lib/finance/format';
import type { FinanceProduct } from '@/lib/finance/products';
import {
  ATTACH_LIST_MAX,
  type AttachCandidate,
  type MatchWritten,
  RECEIPT_MATCH_MESSAGES,
  attachLockNote,
  billFormFromReceipt,
  expenseFormFromReceipt,
  filterAttachCandidates,
  sameAmount,
} from '@/lib/finance/receipt-match';
import { type SuggestedCategory, readingCaution } from '@/lib/finance/receipt-reading';
import type { InboxReceiptRow } from '@/lib/finance/receipts';
import type { FinResult } from '@/lib/finance/result';
import { displayDate } from '@/lib/finance/view-helpers';

export type ReceiptMatchActions = {
  toExpense: (input: unknown) => Promise<FinResult<SavedExpense>>;
  toBill: (input: unknown) => Promise<FinResult<{ id: string }>>;
  attach: (input: unknown) => Promise<FinResult<{ id: string }>>;
  detach: (input: unknown) => Promise<FinResult<{ id: string }>>;
};

/** What someone who may edit needs to match a receipt: the actions, and what the two forms and the picker offer. */
export type ReceiptMatchData = {
  actions: ReceiptMatchActions;
  /** True for an owner or admin: an expense they save is approved, and they untie from an approved expense or a posted bill. */
  canDecide: boolean;
  /** Active contacts, for the expense form's vendor. */
  contacts: { id: string; name: string }[];
  /** Active expense categories, for both forms. */
  categories: ExpenseCategory[];
  /** Active suppliers, for the bill form. */
  suppliers: FinanceContact[];
  /** Active products and services, for the bill form's lines. */
  products: FinanceProduct[];
  /** The category a new bill starts in. */
  defaultCategoryId: string;
  /** The expenses and bills a receipt can be attached to. */
  candidates: AttachCandidate[];
};

/** The card that is open for one receipt. `today` is the person's own date when it opened. */
export type MatchOpen = { kind: 'expense' | 'bill' | 'attach'; row: InboxReceiptRow; today: string };

/** What the receipt shows, in one line, above the form made from it. */
function receiptLine(row: InboxReceiptRow): string {
  const parts = [row.vendor ?? 'no vendor', row.amount === null ? 'no amount' : rm(row.amount)];
  if (row.receipt_date) parts.push(displayDate(row.receipt_date));
  return parts.join(' · ');
}

/** The bill form for a receipt. It only ever saves a draft: there is no way to post from here. */
function BillFromReceipt({ open, match, onClose, onDone }: { open: MatchOpen; match: ReceiptMatchData; onClose: () => void; onDone: (written: MatchWritten) => void }) {
  const { row, today } = open;
  // The shared card calls `onClose` after a save and for Cancel alike: this says which it was.
  const saved = useRef(false);
  return (
    <BillFormCard
      initial={billFormFromReceipt(row, match.suppliers, today, match.defaultCategoryId)}
      draftOnly
      suppliers={match.suppliers}
      products={match.products}
      categories={match.categories}
      defaultCategoryId={match.defaultCategoryId}
      today={today}
      actions={{
        save: async (payload) => {
          const result = await match.actions.toBill({ receipt_id: row.id, bill: payload });
          if (result.ok) saved.current = true;
          return result;
        },
        // Never called: a draft-only form draws no second button.
        saveAndPost: async () => ({ ok: false, error: 'A bill made from a receipt is saved as a draft.' }),
      }}
      onClose={() => (saved.current ? onDone({ kind: 'bill', receiptId: row.id, fileName: row.file_name }) : onClose())}
    />
  );
}

/**
 * The picker: the expenses or the bills of the workspace that a receipt can
 * be attached to, searched, with those of the receipt's own amount first.
 * One is chosen and "Attach" ties the receipt to it. Text from the database
 * (a vendor, a supplier, a category) is drawn as text.
 */
function ReceiptAttachCard({ open, match, onClose, onDone }: { open: MatchOpen; match: ReceiptMatchData; onClose: () => void; onDone: (written: MatchWritten) => void }) {
  const { row } = open;
  const id = useId();
  const [kind, setKind] = useState<'expense' | 'bill'>('expense');
  const [query, setQuery] = useState('');
  const [chosenId, setChosenId] = useState<string | null>(null);
  const attach = useFinanceAction();

  const ofKind = match.candidates.filter((c) => c.kind === kind);
  const found = filterAttachCandidates(match.candidates, kind, query, row.amount);
  const listed = found.slice(0, ATTACH_LIST_MAX);
  // A choice that the search or the other tab has taken off the list is no longer a choice.
  const chosen = listed.find((c) => c.id === chosenId);
  const lockNote = attachLockNote(chosen, match.canDecide);
  const noun = kind === 'expense' ? 'expense' : 'bill';

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!chosen) {
      attach.fail(RECEIPT_MATCH_MESSAGES.choose);
      return;
    }
    attach.run(
      () => match.actions.attach({ receipt_id: row.id, kind: chosen.kind, document_id: chosen.id }),
      () => onDone({ kind: 'attached', receiptId: row.id, fileName: row.file_name, title: chosen.title }),
    );
  };

  return (
    <BentoCard title="Attach receipt" subtitle="Tie this receipt to an expense or a bill that is already entered" icon={Plus} className="col-span-2 md:col-span-12">
      <form onSubmit={submit} noValidate className="grid gap-3 md:grid-cols-12">
        <div className="md:col-span-12">
          <p className="whitespace-normal break-words text-sm font-medium">{row.file_name}</p>
          <p className="whitespace-normal break-words text-xs text-muted-foreground">{receiptLine(row)}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 md:col-span-5">
          {(['expense', 'bill'] as const).map((k) => (
            <Button
              key={k}
              type="button"
              size="sm"
              variant={kind === k ? 'default' : 'outline'}
              aria-pressed={kind === k}
              disabled={attach.pending}
              onClick={() => {
                attach.clear();
                setKind(k);
                setChosenId(null);
              }}
            >
              {k === 'expense' ? 'Expenses' : 'Bills'} ({match.candidates.filter((c) => c.kind === k).length})
            </Button>
          ))}
        </div>
        <div className="space-y-1.5 md:col-span-7">
          <Label htmlFor={`${id}-search`} className="sr-only">
            Search {noun}s by name, date or amount
          </Label>
          <Input
            id={`${id}-search`}
            type="search"
            placeholder={kind === 'expense' ? 'Search vendor, category or amount…' : 'Search supplier, bill number or amount…'}
            autoComplete="off"
            autoFocus
            data-finance-focus
            value={query}
            onChange={(e) => {
              attach.clear();
              setQuery(e.target.value);
            }}
          />
        </div>

        <fieldset className="md:col-span-12">
          <legend className="sr-only">Choose the {noun} this receipt belongs to</legend>
          {ofKind.length === 0 ? (
            <p className="rounded-lg border border-dashed px-3 py-4 text-sm text-muted-foreground">
              {kind === 'expense'
                ? 'There is no pending or approved expense to attach to. Close this and choose Create expense on the receipt instead.'
                : 'There is no draft or posted bill to attach to. Close this and choose Create draft bill on the receipt instead.'}
            </p>
          ) : listed.length === 0 ? (
            <p className="rounded-lg border border-dashed px-3 py-4 text-sm text-muted-foreground">No {noun} matches that search.</p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {listed.map((c) => (
                <li key={c.id}>
                  <label className="flex cursor-pointer items-start gap-3 px-3 py-2 text-sm has-[:checked]:bg-muted/60">
                    <input
                      type="radio"
                      name={`${id}-document`}
                      className="mt-1 shrink-0"
                      checked={chosenId === c.id}
                      disabled={attach.pending}
                      onChange={() => {
                        attach.clear();
                        setChosenId(c.id);
                      }}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block whitespace-normal break-words font-medium">{c.title}</span>
                      <span className="block whitespace-normal break-words text-xs text-muted-foreground">{c.detail}</span>
                    </span>
                    <span className="shrink-0 text-right">
                      <span className="block whitespace-nowrap font-medium tabular-nums">{rm(c.amount)}</span>
                      {sameAmount(c, row.amount) ? (
                        <span className="inline-flex whitespace-nowrap rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-semibold text-emerald-600">
                          Same amount
                        </span>
                      ) : null}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          {found.length > listed.length ? (
            <p className="mt-2 text-xs text-muted-foreground">
              {found.length - listed.length} more not shown: search to narrow the list.
            </p>
          ) : null}
        </fieldset>

        {lockNote ? (
          <p role="status" className="text-sm text-muted-foreground md:col-span-12">
            {lockNote}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-3 md:col-span-12">
          <Button type="submit" size="sm" disabled={attach.pending}>
            {attach.pending ? 'Attaching…' : 'Attach'}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={attach.pending}>
            Cancel
          </Button>
          {attach.error ? (
            <p role="alert" className="text-sm text-destructive">
              {attach.error}
            </p>
          ) : null}
        </div>
      </form>
    </BentoCard>
  );
}

/**
 * The card for whichever way a receipt is being matched: the expense form or
 * the bill form, each started from what the receipt shows and saved through
 * the function that makes the document and the match in one transaction, or
 * the picker of documents that exist. Above a form, one line says which
 * receipt it is for, and when its figures were read by AI or its category
 * was suggested by AI, says so. `suggestion` is a category a reading
 * suggested: the expense form starts with it chosen, for the person to
 * check or change. `onDone` is told what was written; `onClose` is Cancel.
 */
export function ReceiptMatchCard({
  open,
  match,
  suggestion = null,
  onClose,
  onDone,
}: {
  open: MatchOpen;
  match: ReceiptMatchData;
  /** A category a reading by AI suggested for this receipt, if one still stands. */
  suggestion?: SuggestedCategory | null;
  onClose: () => void;
  onDone: (written: MatchWritten) => void;
}) {
  const { row, today } = open;
  if (open.kind === 'attach') return <ReceiptAttachCard open={open} match={match} onClose={onClose} onDone={onDone} />;
  const caution = readingCaution(row, open.kind, suggestion);
  return (
    <>
      <p className="col-span-2 rounded-xl border border-dashed px-4 py-3 text-sm text-muted-foreground md:col-span-12">
        {open.kind === 'expense' ? 'Making an expense from the receipt ' : 'Making a draft bill from the receipt '}
        <span className="break-words font-medium text-foreground">{row.file_name}</span> ({receiptLine(row)}).{' '}
        {open.kind === 'expense'
          ? 'Check the figures against the receipt: saving the expense matches the receipt to it.'
          : 'The receipt’s amount is on one line, with its SST inside it. Choose the supplier and finish the lines: saving makes a draft and matches the receipt to it. Nothing is posted from here.'}
        {caution ? ` ${caution}` : ''}
      </p>
      {open.kind === 'expense' ? (
        <ExpenseFormCard
          initial={{ ...expenseFormFromReceipt(row, match.contacts, today), ...(suggestion ? { categoryId: suggestion.id } : {}) }}
          contacts={match.contacts}
          categories={match.categories}
          today={today}
          canDecide={match.canDecide}
          actions={{ save: (payload) => match.actions.toExpense({ receipt_id: row.id, expense: payload }) }}
          onClose={(saved) =>
            saved ? onDone({ kind: 'expense', receiptId: row.id, fileName: row.file_name, status: saved.status }) : onClose()
          }
        />
      ) : (
        <BillFromReceipt open={open} match={match} onClose={onClose} onDone={onDone} />
      )}
    </>
  );
}
