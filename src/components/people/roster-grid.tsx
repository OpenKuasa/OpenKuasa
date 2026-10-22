'use client';

import { useMemo, useState, useTransition } from 'react';
import { saveRosterAction } from '@/app/(app)/people/attendance-actions';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { type CapResult, WRITE_FAILED } from '@/lib/people/capabilities';
import {
  type Cell,
  type RosterEdits,
  cellKey,
  cellValue,
  changedCells,
  copyLastWeek,
  pickCell,
} from '@/lib/people/roster';
import type { ShiftKind } from '@/lib/people/types';
import { cn } from '@/lib/utils';
import { useUnsavedGuard } from './use-unsaved-guard';

const LABEL: Record<ShiftKind, string> = { morning: 'Morning', night: 'Night', off: 'Off' };

const SHIFT_CLASS: Record<ShiftKind, string> = {
  morning: 'bg-primary/10 text-primary',
  night: 'bg-slate-500/10 text-slate-600',
  off: 'bg-muted text-muted-foreground',
};

const SELECT_CLASS =
  'h-7 w-[5.5rem] rounded-lg border border-input bg-transparent px-1.5 text-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30';

export type RosterGridRow = {
  employee_id: string;
  name: string;
  department: string | null;
  cells: Cell[];
  editable: boolean;
};

/**
 * The roster for owners and admins: each cell of an active employee is a picker (Morning, Night, Off or none).
 * Changes stay in the grid, marked as unsaved, until "Save week" sends the changed cells in one call. "Copy last
 * week" fills only empty cells from last week's pattern, unsaved. Leaving with unsaved changes asks first.
 * `disabled` switches every control off. The sample company never gets this grid: its roster is read only.
 */
export function RosterGrid({
  weekStart,
  days,
  rows,
  previous,
  disabled,
}: {
  weekStart: string;
  days: { date: string; label: string }[];
  rows: RosterGridRow[];
  previous: Record<string, ShiftKind>;
  disabled: boolean;
}) {
  const [edits, setEdits] = useState<RosterEdits>({});
  const [busy, start] = useTransition();
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  // What was saved, by cell key, from the rows the server drew.
  const saved = useMemo(() => {
    const map: Record<string, Cell> = {};
    for (const row of rows) row.cells.forEach((cell, i) => (map[cellKey(row.employee_id, days[i].date)] = cell));
    return map;
  }, [rows, days]);

  const changed = Object.keys(edits).length;
  useUnsavedGuard(changed > 0);
  const off = disabled || busy;

  function pick(key: string, value: Cell) {
    setNotice(null);
    setEdits((current) => pickCell(saved, current, key, value));
  }

  function copy() {
    const result = copyLastWeek({
      employeeIds: rows.filter((r) => r.editable).map((r) => r.employee_id),
      weekStart,
      saved,
      edits,
      previous,
    });
    setEdits(result.edits);
    setNotice({
      tone: 'ok',
      text:
        result.filled === 0
          ? 'Nothing to copy: last week has no shifts for the empty cells.'
          : `Copied ${result.filled} ${result.filled === 1 ? 'shift' : 'shifts'} from last week. Save the week to keep them.`,
    });
  }

  function save() {
    if (changed === 0 || off) return;
    setNotice(null);
    const cells = changedCells(edits);
    start(async () => {
      let result: CapResult<{ saved: number; removed: number }>;
      try {
        result = await saveRosterAction({ week_start: weekStart, cells });
      } catch {
        result = { ok: false, error: WRITE_FAILED };
      }
      if (result.ok) {
        setEdits({});
        const { saved: n, removed } = result.data;
        setNotice({
          tone: 'ok',
          text: `Week saved: ${n} ${n === 1 ? 'shift' : 'shifts'} set${removed > 0 ? `, ${removed} cleared` : ''}.`,
        });
      } else setNotice({ tone: 'error', text: result.error });
    });
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <span className="mr-auto text-sm text-muted-foreground" aria-live="polite">
          {changed === 0 ? 'No unsaved changes' : `${changed} unsaved ${changed === 1 ? 'change' : 'changes'}`}
        </span>
        <Button type="button" variant="outline" size="sm" disabled={off} onClick={copy}>
          Copy last week
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={off || changed === 0}
          onClick={() => {
            setEdits({});
            setNotice(null);
          }}
        >
          Discard
        </Button>
        <Button type="button" size="sm" disabled={off || changed === 0} onClick={save}>
          {busy ? 'Saving…' : 'Save week'}
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
      {rows.length === 0 ? (
        <p className="grid min-h-24 place-items-center text-center text-sm text-muted-foreground">No active employees</p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40">
                <TableHead>Employee</TableHead>
                {days.map((d) => (
                  <TableHead key={d.date}>{d.label}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.employee_id}>
                  <TableCell>
                    <div className="min-w-32">
                      <p className="font-medium">{row.name}</p>
                      {row.department ? <p className="text-xs text-muted-foreground">{row.department}</p> : null}
                      {!row.editable ? <p className="text-xs text-muted-foreground">Inactive</p> : null}
                    </div>
                  </TableCell>
                  {days.map((d, i) => {
                    const key = cellKey(row.employee_id, d.date);
                    const value = cellValue(saved, edits, key);
                    const unsaved = Object.hasOwn(edits, key);
                    if (!row.editable) {
                      const cell = row.cells[i];
                      return (
                        <TableCell key={d.date}>
                          {cell ? (
                            <span className={cn('inline-flex rounded px-1.5 py-0.5 text-xs font-medium', SHIFT_CLASS[cell])}>
                              {LABEL[cell]}
                            </span>
                          ) : null}
                        </TableCell>
                      );
                    }
                    return (
                      <TableCell key={d.date}>
                        <div className="relative inline-flex">
                          <select
                            aria-label={`${row.name}, ${d.label} ${d.date}${unsaved ? ' (unsaved)' : ''}`}
                            className={cn(
                              SELECT_CLASS,
                              value ? SHIFT_CLASS[value] : null,
                              unsaved && 'border-amber-500 ring-2 ring-amber-500/30',
                            )}
                            value={value ?? ''}
                            disabled={off}
                            onChange={(event) => pick(key, (event.target.value || null) as Cell)}
                          >
                            <option value="">—</option>
                            <option value="morning">Morning</option>
                            <option value="night">Night</option>
                            <option value="off">Off</option>
                          </select>
                          {unsaved ? (
                            <span aria-hidden className="absolute -right-1 -top-1 size-2 rounded-full bg-amber-500" />
                          ) : null}
                        </div>
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
