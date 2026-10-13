'use client';

import type { ReactNode } from 'react';
import { Trash2, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { TableCell, TableRow } from '@/components/ui/table';

/** Replaces a table row while asking whether to really go ahead. Never a browser dialog. */
export function ConfirmRow({
  colSpan,
  label,
  children,
  confirmLabel,
  pendingLabel,
  pending,
  error,
  onConfirm,
  onCancel,
  tone = 'destructive',
  icon: Icon = Trash2,
}: {
  colSpan: number;
  /** Names the question for screen readers, e.g. "Delete Lim Hardware". */
  label: string;
  /** The question itself. It may hold a field, such as the date a payment was made. */
  children: ReactNode;
  confirmLabel: string;
  pendingLabel: string;
  pending: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
  /** `destructive` (the default) for deleting and voiding; `default` for a step that loses nothing. */
  tone?: 'destructive' | 'default';
  /** The icon on the confirm button; a bin unless given. */
  icon?: LucideIcon;
}) {
  const destructive = tone === 'destructive';
  return (
    <TableRow className={destructive ? 'bg-destructive/5 hover:bg-destructive/5' : 'bg-muted/40 hover:bg-muted/40'}>
      <TableCell colSpan={colSpan}>
        <div
          role="group"
          aria-label={label}
          // Stays in view when the table has been scrolled sideways, at any width: never wider than
          // the part of the table that shows (cqw is measured on the table's scrolling box).
          className="sticky left-2 flex max-w-[calc(100cqw-1rem)] flex-wrap items-center gap-3 py-1 whitespace-normal"
          onKeyDown={(event) => {
            if (event.key !== 'Escape' || pending) return;
            event.stopPropagation();
            onCancel();
          }}
        >
          {/* The refusal sits under the question, so a long sentence cannot squeeze the question into a narrow column. */}
          <div className="min-w-48 flex-1 space-y-1 text-sm">
            <div>{children}</div>
            {error ? (
              <p role="alert" className="text-destructive">
                {error}
              </p>
            ) : null}
          </div>
          {/* aria-disabled rather than disabled: a disabled button drops focus to the page, and Escape then no longer reaches this row. */}
          <Button
            type="button"
            variant={destructive ? 'destructive' : 'default'}
            size="sm"
            aria-disabled={pending}
            className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
            onClick={() => {
              if (!pending) onConfirm();
            }}
          >
            <Icon className="size-4" />
            {pending ? pendingLabel : confirmLabel}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={onCancel} disabled={pending} autoFocus data-finance-focus>
            Cancel
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}
