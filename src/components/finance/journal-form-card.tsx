'use client';

import { type FormEvent, useId, useRef, useState } from 'react';
import { BookOpen, Plus, X } from 'lucide-react';
import { BentoCard } from '@/components/bento/bento';
import { useFinanceAction } from '@/components/finance/use-finance-action';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { rm } from '@/lib/finance/format';
import { type JournalDetail, type LedgerAccount, JOURNAL_LINES_MAX, type SaveAndPostJournalResult } from '@/lib/finance/ledger';
import {
  type JournalForm,
  type JournalLineDraft,
  journalFormFromDetail,
  journalTotals,
  newJournalForm,
  submitJournal,
} from '@/lib/finance/ledger-form';
import type { FinResult } from '@/lib/finance/result';
import { cn } from '@/lib/utils';

export type JournalFormActions = {
  save: (input: unknown) => Promise<FinResult<{ id: string }>>;
  saveAndPost: (input: unknown) => Promise<SaveAndPostJournalResult>;
};

/** Typing a figure on one side of a line empties the other side of that line; emptying a box leaves the other alone. */
export function withTypedSide(lines: JournalLineDraft[], key: string, side: 'debit' | 'credit', value: string): JournalLineDraft[] {
  const other = side === 'debit' ? 'credit' : 'debit';
  return lines.map((l) => (l.key === key ? { ...l, [side]: value, ...(value.trim() === '' ? {} : { [other]: '' }) } : l));
}

const byCode = (a: LedgerAccount, b: LedgerAccount) => a.code.localeCompare(b.code, 'en', { numeric: true });

/**
 * A new manual journal, or a saved draft being changed (`editing`): a date, a description and lines of account,
 * debit and credit, with the totals under them. "Save and post" is refused while the sides differ. The rules
 * are in src/lib/finance/ledger-form.ts.
 */
export function JournalFormCard({
  editing,
  accounts,
  today,
  actions,
  onClose,
}: {
  editing?: JournalDetail;
  /** Every account; the picker offers the active ones, and any a saved draft's lines already use. */
  accounts: LedgerAccount[];
  /** The default journal date, YYYY-MM-DD. */
  today: string;
  actions: JournalFormActions;
  onClose: () => void;
}) {
  const id = useId();
  const addButton = useRef<HTMLButtonElement>(null);
  /** The line just added, so its first box can take focus once it is on the page. */
  const justAdded = useRef<string | null>(null);
  const [form, setForm] = useState<JournalForm>(() => (editing ? journalFormFromDetail(editing) : newJournalForm(today, 'new-0')));
  const [posting, setPosting] = useState(false);
  const save = useFinanceAction();
  // A change by the person answers the last refusal, so its sentence goes.
  const edit = (next: (f: JournalForm) => JournalForm) => {
    save.clear();
    setForm(next);
  };
  const setLines = (next: (lines: JournalLineDraft[]) => JournalLineDraft[]) => edit((f) => ({ ...f, lines: next(f.lines) }));

  const used = new Set(editing?.lines.map((l) => l.account_id));
  const choices = accounts.filter((a) => a.active || used.has(a.id)).sort(byCode);
  const totals = journalTotals(form);

  const send = (post: boolean) => {
    const outcome = submitJournal(form, post);
    if ('error' in outcome) {
      save.fail(outcome.error);
      return;
    }
    setPosting(post);
    if (!post) {
      save.run(() => actions.save(outcome.payload), onClose);
      return;
    }
    save.run(async () => {
      const result = await actions.saveAndPost(outcome.payload);
      // Saved but not posted: go on editing that draft, so a second try does not save a second journal.
      if (!result.ok && result.draftId) {
        const draftId = result.draftId;
        setForm((f) => ({ ...f, id: draftId }));
        return { ...result, error: `Saved as a draft, but not posted. ${result.error}` };
      }
      return result;
    }, onClose);
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    // Handled here rather than as a form action, so a refused form keeps what was typed.
    event.preventDefault();
    send(false);
  };

  const add = () => {
    const key = `new-${Date.now()}-${form.lines.length}`;
    justAdded.current = key;
    setLines((lines) => [...lines, { key, account_id: '', debit: '', credit: '', note: '' }]);
  };
  const remove = (key: string) => {
    setLines((lines) => lines.filter((l) => l.key !== key));
    // The button that was pressed is gone; keep the keyboard somewhere useful.
    addButton.current?.focus();
  };

  return (
    <BentoCard
      title={form.id ? 'Edit journal' : 'New journal'}
      subtitle={form.id ? 'A draft: nothing reaches the books until it is posted' : 'Debits and credits you enter by hand'}
      icon={form.id ? BookOpen : Plus}
      className="col-span-2 md:col-span-12"
    >
      <form onSubmit={submit} noValidate className="grid gap-3 md:grid-cols-12">
        <div className="space-y-1.5 md:col-span-3">
          <Label htmlFor={`${id}-date`}>Date</Label>
          <Input
            id={`${id}-date`}
            type="date"
            value={form.journal_date}
            required
            autoFocus
            data-finance-focus
            onChange={(e) => edit((f) => ({ ...f, journal_date: e.target.value }))}
          />
        </div>
        <div className="space-y-1.5 md:col-span-9">
          <Label htmlFor={`${id}-description`}>Description</Label>
          <Input
            id={`${id}-description`}
            value={form.description}
            maxLength={200}
            placeholder="Depreciation of office equipment"
            autoComplete="off"
            required
            onChange={(e) => edit((f) => ({ ...f, description: e.target.value }))}
          />
        </div>

        <fieldset
          className="space-y-2 md:col-span-12"
          // Enter in a line's box moves on like any other key; it does not save the journal half typed.
          onKeyDown={(event) => {
            if (event.key === 'Enter' && event.target instanceof HTMLInputElement) event.preventDefault();
          }}
        >
          <legend className="text-sm font-medium leading-none">Lines</legend>
          <ol className="space-y-3 md:space-y-2">
            {form.lines.map((line, index) => {
              const n = index + 1;
              const field = (name: string) => `${id}-${line.key}-${name}`;
              // From md up only the first line shows its labels, like a table's header row.
              const label = cn('text-xs text-muted-foreground', index > 0 && 'md:sr-only');
              return (
                <li
                  key={line.key}
                  aria-label={`Line ${n}`}
                  className="grid grid-cols-2 gap-2 rounded-lg border p-3 md:grid-cols-12 md:items-end md:border-0 md:p-0"
                >
                  <div className="col-span-2 space-y-1 md:col-span-4">
                    <Label htmlFor={field('account')} className={label}>
                      Account
                    </Label>
                    <Select value={line.account_id} onValueChange={(v) => setLines((ls) => ls.map((l) => (l.key === line.key ? { ...l, account_id: v } : l)))}>
                      <SelectTrigger id={field('account')} className="w-full" aria-label={`Account for line ${n}`}>
                        <SelectValue placeholder="Choose an account" />
                      </SelectTrigger>
                      <SelectContent>
                        {choices.map((a) => (
                          <SelectItem key={a.id} value={a.id}>
                            {a.code} {a.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {(['debit', 'credit'] as const).map((side) => (
                    <div key={side} className="space-y-1 md:col-span-2">
                      <Label htmlFor={field(side)} className={label}>
                        {side === 'debit' ? 'Debit (RM)' : 'Credit (RM)'}
                      </Label>
                      <Input
                        id={field(side)}
                        ref={(input) => {
                          if (!input || side !== 'debit' || justAdded.current !== line.key) return;
                          justAdded.current = null;
                          input.focus();
                        }}
                        type="number"
                        onWheel={(e) => e.currentTarget.blur()}
                        inputMode="decimal"
                        min={0}
                        step="any"
                        placeholder="0.00"
                        className="tabular-nums"
                        value={line[side]}
                        aria-label={`${side === 'debit' ? 'Debit' : 'Credit'} for line ${n}`}
                        onChange={(e) => setLines((ls) => withTypedSide(ls, line.key, side, e.target.value))}
                      />
                    </div>
                  ))}
                  <div className="col-span-2 flex items-end gap-2 md:col-span-4">
                    <div className="min-w-0 flex-1 space-y-1">
                      <Label htmlFor={field('note')} className={label}>
                        Note
                      </Label>
                      <Input
                        id={field('note')}
                        value={line.note}
                        maxLength={200}
                        autoComplete="off"
                        aria-label={`Note for line ${n}`}
                        onChange={(e) => setLines((ls) => ls.map((l) => (l.key === line.key ? { ...l, note: e.target.value } : l)))}
                      />
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove line ${n}`}
                      disabled={form.lines.length === 1}
                      onClick={() => remove(line.key)}
                    >
                      <X className="size-4" />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ol>

          <div className="flex flex-wrap items-start justify-between gap-3">
            <Button ref={addButton} type="button" variant="outline" size="sm" disabled={form.lines.length >= JOURNAL_LINES_MAX} onClick={add}>
              <Plus className="size-4" />
              Add line
            </Button>
            <dl className="grid w-full grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-sm sm:w-64" aria-live="polite">
              <dt className="text-muted-foreground">Debits</dt>
              <dd className="text-right tabular-nums">{rm(totals.debit)}</dd>
              <dt className="text-muted-foreground">Credits</dt>
              <dd className="text-right tabular-nums">{rm(totals.credit)}</dd>
              <dt className="font-semibold">Difference</dt>
              <dd className={cn('text-right font-semibold tabular-nums', totals.difference > 0 && 'text-amber-600')}>{rm(totals.difference)}</dd>
            </dl>
          </div>
        </fieldset>

        <div className="flex flex-wrap items-center gap-3 md:col-span-12">
          <Button type="submit" size="sm" variant="outline" disabled={save.pending}>
            {save.pending && !posting ? 'Saving…' : 'Save draft'}
          </Button>
          <Button type="button" size="sm" disabled={save.pending} onClick={() => send(true)}>
            {save.pending && posting ? 'Posting…' : 'Save and post'}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={save.pending}>
            Cancel
          </Button>
          {save.error ? (
            <p role="alert" className="text-sm text-destructive">
              {save.error}
            </p>
          ) : null}
        </div>
      </form>
    </BentoCard>
  );
}
