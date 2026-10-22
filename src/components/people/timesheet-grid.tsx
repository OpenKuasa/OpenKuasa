'use client';

import { useState, useTransition } from 'react';
import { saveHoursAction } from '@/app/(app)/people/attendance-actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { type CapResult, WRITE_FAILED } from '@/lib/people/capabilities';
import { cellKey, hoursText, toHoursInput } from '@/lib/people/roster';
import { cn } from '@/lib/utils';
import { useUnsavedGuard } from './use-unsaved-guard';

export type TimesheetGridRow = {
  employee_id: string;
  name: string;
  per_day: (number | null)[];
  billable_per_day: (number | null)[];
  billable: number;
  total: number;
  own: boolean;
  editable: boolean[];
};

type Draft = { hours: string; billable: string };

const shown = (value: number | null) => (value === null ? '—' : value.toFixed(1));

/**
 * The week's hours with inputs where the viewer may type: their own row for this week and last (up to today), or
 * any row and day up to today for an owner or admin. Each day has hours and, below, billable hours. Changed days
 * are marked and saved together with "Save hours", one day at a time; an empty hours box clears that day.
 */
export function TimesheetGrid({
  days,
  rows,
}: {
  days: { date: string; label: string }[];
  rows: TimesheetGridRow[];
}) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [busy, start] = useTransition();
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const changed = Object.keys(drafts).length;
  useUnsavedGuard(changed > 0);

  const savedDraft = (row: TimesheetGridRow, i: number): Draft => ({
    hours: hoursText(row.per_day[i]),
    billable: row.per_day[i] === null ? '' : hoursText(row.billable_per_day[i]),
  });

  function edit(row: TimesheetGridRow, i: number, field: keyof Draft, value: string) {
    setNotice(null);
    const key = cellKey(row.employee_id, days[i].date);
    setDrafts((current) => {
      const before = savedDraft(row, i);
      const next = { ...(current[key] ?? before), [field]: value };
      const copy = { ...current };
      if (next.hours.trim() === before.hours && next.billable.trim() === before.billable) delete copy[key];
      else copy[key] = next;
      return copy;
    });
  }

  function save() {
    if (changed === 0 || busy) return;
    setNotice(null);
    // Checked here first, so nothing is sent while any day is wrong.
    const inputs: { key: string; input: { employee_id: string; work_date: string; hours: number | null; billable_hours: number | null } }[] = [];
    for (const key of Object.keys(drafts).sort()) {
      const [employeeId, date] = key.split('|');
      const converted = toHoursInput(employeeId, date, drafts[key].hours, drafts[key].billable);
      if (!converted.ok) {
        const name = rows.find((r) => r.employee_id === employeeId)?.name ?? 'Someone';
        setNotice({ tone: 'error', text: `${name}, ${date}: ${converted.error}` });
        return;
      }
      inputs.push({ key, input: converted.input });
    }
    start(async () => {
      let done = 0;
      for (const { key, input } of inputs) {
        let result: CapResult<unknown>;
        try {
          result = await saveHoursAction(input);
        } catch {
          result = { ok: false, error: WRITE_FAILED };
        }
        if (!result.ok) {
          setNotice({ tone: 'error', text: `${input.work_date}: ${result.error}${done > 0 ? ` (${done} saved before this)` : ''}` });
          return;
        }
        done += 1;
        setDrafts((current) => {
          const copy = { ...current };
          delete copy[key];
          return copy;
        });
      }
      setNotice({ tone: 'ok', text: `Saved ${done} ${done === 1 ? 'day' : 'days'}.` });
    });
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <span className="mr-auto text-sm text-muted-foreground" aria-live="polite">
          {changed === 0 ? 'Type hours in a day, then save. Leave a day empty to clear it.' : `${changed} unsaved ${changed === 1 ? 'day' : 'days'}`}
        </span>
        <Button type="button" variant="outline" size="sm" disabled={busy || changed === 0} onClick={() => setDrafts({})}>
          Discard
        </Button>
        <Button type="button" size="sm" disabled={busy || changed === 0} onClick={save}>
          {busy ? 'Saving…' : 'Save hours'}
        </Button>
      </div>
      {notice ? (
        <p
          role={notice.tone === 'error' ? 'alert' : 'status'}
          className={cn('px-4 pt-3 text-sm', notice.tone === 'error' ? 'text-destructive' : 'text-muted-foreground')}
        >
          {notice.text}
        </p>
      ) : null}
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/40">
              <TableHead>Employee</TableHead>
              {days.map((d) => (
                <TableHead key={d.date} className="text-right">
                  {d.label}
                </TableHead>
              ))}
              <TableHead className="text-right">Billable</TableHead>
              <TableHead className="text-right">Total</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.employee_id}>
                <TableCell>
                  <p className="min-w-28 font-medium">
                    {row.name}
                    {row.own ? <span className="ml-1 text-xs font-normal text-muted-foreground">(you)</span> : null}
                  </p>
                </TableCell>
                {days.map((d, i) => {
                  if (!row.editable[i]) {
                    return (
                      <TableCell key={d.date} className="text-right tabular-nums">
                        {shown(row.per_day[i])}
                      </TableCell>
                    );
                  }
                  const key = cellKey(row.employee_id, d.date);
                  const draft = drafts[key] ?? savedDraft(row, i);
                  const unsaved = Object.hasOwn(drafts, key);
                  return (
                    <TableCell key={d.date} className="text-right">
                      <div className="ml-auto flex w-16 flex-col gap-1">
                        <Input
                          inputMode="decimal"
                          aria-label={`${row.name}, hours on ${d.label} ${d.date}${unsaved ? ' (unsaved)' : ''}`}
                          placeholder="0"
                          value={draft.hours}
                          disabled={busy}
                          onChange={(event) => edit(row, i, 'hours', event.target.value)}
                          className={cn('h-7 px-1.5 text-right text-xs tabular-nums', unsaved && 'border-amber-500 ring-2 ring-amber-500/30')}
                        />
                        <Input
                          inputMode="decimal"
                          aria-label={`${row.name}, billable hours on ${d.label} ${d.date}`}
                          placeholder="bill."
                          title="Billable hours"
                          value={draft.billable}
                          disabled={busy}
                          onChange={(event) => edit(row, i, 'billable', event.target.value)}
                          className={cn('h-6 px-1.5 text-right text-[0.7rem] tabular-nums text-muted-foreground', unsaved && 'border-amber-500')}
                        />
                      </div>
                    </TableCell>
                  );
                })}
                <TableCell className="text-right tabular-nums text-muted-foreground">{shown(row.billable)}</TableCell>
                <TableCell className="text-right font-semibold tabular-nums">{shown(row.total)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
