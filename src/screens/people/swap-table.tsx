import type { ReactNode } from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { SwapRow } from '@/lib/people/swaps';
import { StatusPill } from './parts';

/** Shift swaps as a table: who, the two shifts, the status and the note, and an action column when `action` is given. */
export function SwapTable<R extends SwapRow>({ rows, action }: { rows: R[]; action?: (row: R) => ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/40">
            <TableHead>Asked by</TableHead>
            <TableHead>Gives</TableHead>
            <TableHead>Swaps with</TableHead>
            <TableHead>Takes</TableHead>
            <TableHead>Status</TableHead>
            {action ? <TableHead>Action</TableHead> : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell className="font-medium">{row.requester}</TableCell>
              <TableCell className="whitespace-nowrap">{row.gives}</TableCell>
              <TableCell className="font-medium">{row.colleague}</TableCell>
              <TableCell className="whitespace-nowrap">{row.takes}</TableCell>
              <TableCell>
                <div className="flex flex-col items-start gap-1">
                  <StatusPill tone={row.tone}>{row.status_label}</StatusPill>
                  {row.note ? <span className="max-w-56 whitespace-normal break-words text-xs text-muted-foreground">{row.note}</span> : null}
                  {row.decision_note ? (
                    <span className="max-w-56 whitespace-normal break-words text-xs text-muted-foreground">Note: {row.decision_note}</span>
                  ) : null}
                </div>
              </TableCell>
              {action ? <TableCell>{action(row)}</TableCell> : null}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
