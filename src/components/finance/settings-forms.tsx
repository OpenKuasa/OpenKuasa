'use client';

import { type FormEvent, useId, useState } from 'react';
import { useFinanceAction } from '@/components/finance/use-finance-action';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { FinResult } from '@/lib/finance/result';
import { MONTHS, type SequenceDoc, type SequenceRow, formatSequence } from '@/lib/finance/settings';

const SELECT_CLASS =
  'h-8 w-full rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 dark:bg-input/30';

export type SaveFinanceSettings = (input: { yearEndMonth: number; lockDate: string | null }) => Promise<FinResult<unknown>>;
export type SaveSequence = (input: { doc: SequenceDoc; prefix: string; nextNumber: number }) => Promise<FinResult<unknown>>;

/**
 * The financial year's end month and the books lock date. Given `save` for an owner or admin outside the demo;
 * `disabled` shows it greyed out (the sample screen). The date cannot be picked past `today` (Malaysia), and the
 * database refuses it too. Clearing the date reopens the books.
 */
export function FinanceYearLockForm({
  yearEndMonth,
  lockDate,
  today,
  save,
  disabled = false,
}: {
  yearEndMonth: number;
  lockDate: string | null;
  /** YYYY-MM-DD: today in Malaysia, the latest date the books can be locked to. */
  today: string;
  save: SaveFinanceSettings;
  disabled?: boolean;
}) {
  const id = useId();
  const [month, setMonth] = useState(yearEndMonth);
  const [lock, setLock] = useState(lockDate ?? '');
  const [saved, setSaved] = useState(false);
  const action = useFinanceAction();
  const off = disabled || action.pending;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (disabled) return;
    setSaved(false);
    action.run(() => save({ yearEndMonth: month, lockDate: lock === '' ? null : lock }), () => setSaved(true));
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-month`}>Financial year ends in</Label>
          <select
            id={`${id}-month`}
            className={SELECT_CLASS}
            value={month}
            disabled={off}
            onChange={(e) => {
              setSaved(false);
              action.clear();
              setMonth(Number(e.target.value));
            }}
          >
            {MONTHS.map((name, i) => (
              <option key={name} value={i + 1}>
                {name}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-lock`}>Lock the books up to</Label>
          <Input
            id={`${id}-lock`}
            type="date"
            value={lock}
            max={today}
            disabled={off}
            onChange={(e) => {
              setSaved(false);
              action.clear();
              setLock(e.target.value);
            }}
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="sm" disabled={off}>
          {action.pending ? 'Saving…' : 'Save'}
        </Button>
        {saved ? <span className="text-sm text-muted-foreground">Saved.</span> : null}
        {action.error ? (
          <p role="alert" className="text-sm text-destructive">
            {action.error}
          </p>
        ) : null}
      </div>
    </form>
  );
}

/** A whole number, 1 or more, as typed; null when it is not one. */
function parseNext(text: string): number | null {
  const n = Number(text);
  return /^\d+$/.test(text.trim()) && Number.isSafeInteger(n) && n >= 1 ? n : null;
}

/** One numbered document as plain text: name, prefix, next number and how the next one will print. */
function SequenceRowText({ row }: { row: SequenceRow }) {
  return (
    <div className="grid grid-cols-3 gap-x-3 gap-y-1 py-3 text-sm sm:grid-cols-4">
      <span className="col-span-3 font-medium sm:col-span-1">{row.label}</span>
      {/* On a phone the three values sit under the name, each with a small label; the header row names them on wider screens. */}
      <span className="min-w-0">
        <span className="block text-xs text-muted-foreground sm:sr-only">Prefix</span>
        <span className="font-mono">{row.prefix}</span>
      </span>
      <span className="min-w-0">
        <span className="block text-xs text-muted-foreground sm:sr-only">Next number</span>
        <span className="font-mono">{row.nextNumber}</span>
      </span>
      <span className="min-w-0">
        <span className="block text-xs text-muted-foreground sm:sr-only">Example</span>
        <span className="font-mono text-muted-foreground">{formatSequence(row)}</span>
      </span>
    </div>
  );
}

export type SequenceDraft = { prefix: string; next: string };
type Draft = SequenceDraft;

const NEXT_NUMBER_HELP = 'Enter the next number as a whole number, 1 or more.';

/**
 * What a Save of the numbering table would send: only the rows whose prefix or next number changed, or, when any
 * changed row has a next number that is not a whole number of 1 or more, nothing and an error for each such row.
 */
export function planSequenceSave(
  rows: SequenceRow[],
  drafts: Record<string, SequenceDraft>,
): { send: { doc: SequenceDoc; prefix: string; nextNumber: number }[]; invalid: Record<string, string> } {
  const changed = rows.filter((row) => {
    const d = drafts[row.doc];
    return d !== undefined && (d.prefix !== row.prefix || d.next.trim() !== String(row.nextNumber));
  });
  const invalid = Object.fromEntries(
    changed.filter((row) => parseNext(drafts[row.doc].next) === null).map((row) => [row.doc, NEXT_NUMBER_HELP]),
  );
  if (Object.keys(invalid).length > 0) return { send: [], invalid };
  return {
    send: changed.map((row) => ({ doc: row.doc, prefix: drafts[row.doc].prefix, nextNumber: parseNext(drafts[row.doc].next)! })),
    invalid,
  };
}

/** Sends each change in turn; returns why each refused row was refused. A row that saved is not undone. */
export async function sendSequenceChanges(
  send: { doc: SequenceDoc; prefix: string; nextNumber: number }[],
  save: SaveSequence,
): Promise<Record<string, string>> {
  const refused: Record<string, string> = {};
  for (const change of send) {
    try {
      const result = await save(change);
      if (!result.ok) refused[change.doc] = result.error || 'That change could not be saved. Please try again.';
    } catch {
      refused[change.doc] = 'We could not confirm this was saved. Reload the page and check it before trying again.';
    }
  }
  return refused;
}

/**
 * Every numbered document in one form with one Save, like every other settings card. Read-only text without
 * `save`; greyed out when `disabled` (the sample screen). Save sends only the rows that changed, one at a time,
 * and a row that is refused keeps what was typed and says why beside it; the rows that saved stay saved.
 */
export function SequencesForm({
  rows,
  save,
  disabled = false,
}: {
  rows: SequenceRow[];
  save?: SaveSequence;
  disabled?: boolean;
}) {
  const id = useId();
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() =>
    Object.fromEntries(rows.map((r) => [r.doc, { prefix: r.prefix, next: String(r.nextNumber) }])),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [note, setNote] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const off = disabled || pending;

  if (!save) return <div className="divide-y">{rows.map((row) => <SequenceRowText key={row.doc} row={row} />)}</div>;

  const draftOf = (row: SequenceRow): Draft => drafts[row.doc] ?? { prefix: row.prefix, next: String(row.nextNumber) };
  const edit = (doc: string, change: Partial<Draft>, row: SequenceRow) => {
    setNote(null);
    setErrors((all) => Object.fromEntries(Object.entries(all).filter(([key]) => key !== doc)));
    setDrafts((d) => ({ ...d, [doc]: { ...draftOf(row), ...change } }));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (disabled) return;
    setNote(null);
    const { send, invalid } = planSequenceSave(rows, Object.fromEntries(rows.map((row) => [row.doc, draftOf(row)])));
    setErrors(invalid);
    if (Object.keys(invalid).length > 0) return;
    if (send.length === 0) {
      setNote('Nothing has changed.');
      return;
    }
    setPending(true);
    const refused = await sendSequenceChanges(send, save);
    setPending(false);
    setErrors(refused);
    const savedCount = send.length - Object.keys(refused).length;
    if (savedCount > 0) setNote(Object.keys(refused).length ? `Saved ${savedCount} of ${send.length}.` : 'Saved.');
  };

  return (
    <form onSubmit={submit}>
      <div className="divide-y">
        {rows.map((row) => {
          const d = draftOf(row);
          const n = parseNext(d.next);
          const example = formatSequence({ prefix: d.prefix, nextNumber: n ?? row.nextNumber, pad: row.pad });
          const error = errors[row.doc];
          return (
            <div key={row.doc} className="space-y-2 py-3">
              <div className="grid grid-cols-2 items-end gap-x-3 gap-y-2 sm:grid-cols-4">
                <span className="col-span-2 text-sm font-medium sm:col-span-1 sm:pb-1.5">{row.label}</span>
                <div className="min-w-0 space-y-1">
                  <Label htmlFor={`${id}-${row.doc}-prefix`} className="text-xs text-muted-foreground sm:sr-only">
                    Prefix
                  </Label>
                  <Input
                    id={`${id}-${row.doc}-prefix`}
                    aria-label={`${row.label} prefix`}
                    value={d.prefix}
                    maxLength={10}
                    autoComplete="off"
                    disabled={off}
                    aria-invalid={error ? true : undefined}
                    onChange={(e) => edit(row.doc, { prefix: e.target.value }, row)}
                  />
                </div>
                <div className="min-w-0 space-y-1">
                  <Label htmlFor={`${id}-${row.doc}-next`} className="text-xs text-muted-foreground sm:sr-only">
                    Next number
                  </Label>
                  <Input
                    id={`${id}-${row.doc}-next`}
                    aria-label={`${row.label} next number`}
                    value={d.next}
                    inputMode="numeric"
                    autoComplete="off"
                    disabled={off}
                    aria-invalid={error ? true : undefined}
                    onChange={(e) => edit(row.doc, { next: e.target.value }, row)}
                  />
                </div>
                <span className="font-mono text-sm text-muted-foreground sm:pb-1.5">{example}</span>
              </div>
              {error ? (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-3 pt-3">
        <Button type="submit" size="sm" disabled={off}>
          {pending ? 'Saving…' : 'Save'}
        </Button>
        {note ? <span className="text-sm text-muted-foreground">{note}</span> : null}
      </div>
    </form>
  );
}
