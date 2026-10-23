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

/**
 * One numbered document: its prefix and next number, with the number the next one will get shown as it would
 * print. Read-only text without `save`; an inline form with it (greyed out when `disabled`, the sample screen).
 */
export function SequenceRowForm({
  row,
  save,
  disabled = false,
}: {
  row: SequenceRow;
  save?: SaveSequence;
  disabled?: boolean;
}) {
  const id = useId();
  const [prefix, setPrefix] = useState(row.prefix);
  const [next, setNext] = useState(String(row.nextNumber));
  const [saved, setSaved] = useState(false);
  const action = useFinanceAction();
  const off = disabled || action.pending;

  const nextNumber = Number(next);
  const valid = /^\d+$/.test(next.trim()) && Number.isSafeInteger(nextNumber) && nextNumber >= 1;

  if (!save) {
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

  const example = formatSequence({ prefix, nextNumber: valid ? nextNumber : row.nextNumber, pad: row.pad });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (disabled) return;
    setSaved(false);
    if (!valid) {
      action.fail('Enter the next number as a whole number, 1 or more.');
      return;
    }
    action.run(() => save({ doc: row.doc, prefix, nextNumber }), () => setSaved(true));
  };

  return (
    <form onSubmit={submit} className="space-y-2 py-3">
      <div className="grid grid-cols-2 items-end gap-x-3 gap-y-2 sm:grid-cols-[1fr_7rem_7rem_8rem_auto]">
        <span className="col-span-2 text-sm font-medium sm:col-span-1 sm:pb-1.5">{row.label}</span>
        <div className="min-w-0 space-y-1">
          <Label htmlFor={`${id}-prefix`} className="text-xs text-muted-foreground sm:sr-only">
            Prefix
          </Label>
          <Input
            id={`${id}-prefix`}
            aria-label={`${row.label} prefix`}
            value={prefix}
            maxLength={10}
            autoComplete="off"
            disabled={off}
            onChange={(e) => {
              setSaved(false);
              action.clear();
              setPrefix(e.target.value);
            }}
          />
        </div>
        <div className="min-w-0 space-y-1">
          <Label htmlFor={`${id}-next`} className="text-xs text-muted-foreground sm:sr-only">
            Next number
          </Label>
          <Input
            id={`${id}-next`}
            aria-label={`${row.label} next number`}
            value={next}
            inputMode="numeric"
            autoComplete="off"
            disabled={off}
            onChange={(e) => {
              setSaved(false);
              action.clear();
              setNext(e.target.value);
            }}
          />
        </div>
        <span className="font-mono text-sm text-muted-foreground sm:pb-1.5">{example}</span>
        <Button type="submit" size="sm" disabled={off}>
          {action.pending ? 'Saving…' : 'Save'}
        </Button>
      </div>
      {saved ? <p className="text-xs text-muted-foreground">Saved.</p> : null}
      {action.error ? (
        <p role="alert" className="text-sm text-destructive">
          {action.error}
        </p>
      ) : null}
    </form>
  );
}
