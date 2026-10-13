'use client';

import { type FormEvent, useId, useState } from 'react';
import { Archive, ArchiveRestore, ListTree, Pencil } from 'lucide-react';
import { BentoCard } from '@/components/bento/bento';
import { ConfirmRow } from '@/components/finance/confirm-row';
import { RowMenu, type RowMenuItem } from '@/components/finance/row-menu';
import { useFinanceAction } from '@/components/finance/use-finance-action';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { type CategoryKind, type CategoryRow, type SavedCategory } from '@/lib/finance/categories';
import {
  CATEGORY_KIND_LABELS,
  CATEGORY_RENAME_HELP,
  type CategoryAction,
  type CategoryForm,
  categoryActions,
  categoryAddError,
  categoryAddedNote,
  categoryArchiveEffect,
  categoryArchivePayload,
  categoryArchivedNote,
  categoryLists,
  categoryMark,
  categoryPayload,
  categoryRenameError,
  categoryRenamedNote,
  categoryRestorePayload,
  categoryRestoredNote,
  newCategoryForm,
  renameChangesNothing,
} from '@/lib/finance/category-form';
import type { FinResult } from '@/lib/finance/result';
import { cn } from '@/lib/utils';

export type CategoryActions = {
  create: (input: unknown) => Promise<FinResult<SavedCategory>>;
  rename: (input: unknown) => Promise<FinResult<SavedCategory>>;
  setActive: (input: unknown) => Promise<FinResult<SavedCategory>>;
};

/** The one question open in a row: a new name for a category, or whether to archive it. */
type Asking = { kind: 'rename'; id: string; name: string } | { kind: 'archive'; id: string } | null;

const LIST_TITLES: Record<CategoryKind, string> = { expense: 'Expense categories', income: 'Income categories' };
const COLUMNS = 3;

/**
 * Every expense and income category of the workspace, archived ones
 * included, for an owner or admin: add one, rename one, archive or restore
 * one. Nothing is deleted. One thing is open at a time: the add form waits
 * while a row is being asked about, and choosing another row's action takes
 * the question's place. Rename and Archive are asked in the row; Restore
 * loses nothing and is done at once.
 */
export function CategoriesCard({ rows, actions, onClose }: { rows: CategoryRow[]; actions: CategoryActions; onClose: () => void }) {
  const id = useId();
  const [form, setForm] = useState<CategoryForm>(() => newCategoryForm());
  const [asking, setAsking] = useState<Asking>(null);
  const [note, setNote] = useState<string | null>(null);
  const add = useFinanceAction();
  const write = useFinanceAction();
  const restore = useFinanceAction();

  const lists = categoryLists(rows);
  // A category that is gone after a refresh takes its question with it.
  const asked = asking && rows.some((r) => r.id === asking.id) ? asking : null;
  const busy = add.pending || write.pending || restore.pending;

  /** Opens a question in a row, in place of whatever was open, dropping the last message. */
  const ask = (next: Asking) => {
    add.clear();
    write.clear();
    restore.clear();
    setNote(null);
    setAsking(next);
  };

  const submitAdd = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || asked) return;
    setNote(null);
    restore.clear();
    const problem = categoryAddError(form, rows);
    if (problem) {
      add.fail(problem);
      return;
    }
    add.run(
      () => actions.create(categoryPayload(form)),
      (saved) => {
        setNote(categoryAddedNote(saved));
        // The next one is most likely of the same kind.
        setForm(newCategoryForm(saved.kind));
      },
    );
  };

  const submitRename = (row: CategoryRow, typed: string) => {
    if (write.pending) return;
    if (renameChangesNothing(row, typed)) {
      ask(null);
      return;
    }
    const problem = categoryRenameError(row, typed, rows);
    if (problem) {
      write.fail(problem);
      return;
    }
    write.run(
      () => actions.rename({ id: row.id, name: typed }),
      (saved) => {
        setAsking(null);
        setNote(categoryRenamedNote(row.name, saved));
      },
    );
  };

  const menuItem = (row: CategoryRow, action: CategoryAction): RowMenuItem => {
    switch (action) {
      case 'rename':
        return { label: 'Rename', icon: Pencil, opens: true, onSelect: () => ask({ kind: 'rename', id: row.id, name: row.name }) };
      case 'archive':
        return { label: 'Archive', icon: Archive, opens: true, onSelect: () => ask({ kind: 'archive', id: row.id }) };
      case 'restore':
        return {
          label: 'Restore',
          icon: ArchiveRestore,
          onSelect: () => {
            ask(null);
            restore.run(
              () => actions.setActive(categoryRestorePayload(row)),
              (saved) => setNote(categoryRestoredNote(saved)),
            );
          },
        };
    }
  };

  const question = (row: CategoryRow) => {
    if (!asked || asked.id !== row.id) return null;
    if (asked.kind === 'rename') {
      return (
        <ConfirmRow
          key={row.id}
          colSpan={COLUMNS}
          label={`Rename ${row.name}`}
          confirmLabel="Save name"
          pendingLabel="Saving…"
          pending={write.pending}
          error={write.error}
          tone="default"
          icon={Pencil}
          onConfirm={() => submitRename(row, asked.name)}
          onCancel={() => ask(null)}
        >
          <Label htmlFor={`${id}-rename`}>
            New name for <span className="font-medium [overflow-wrap:anywhere]">{row.name}</span>
          </Label>
          <Input
            id={`${id}-rename`}
            className="mt-1.5"
            value={asked.name}
            autoComplete="off"
            // The menu hands focus to the first element that carries this: the box, not the Cancel button after it.
            data-finance-focus
            aria-describedby={`${id}-rename-help`}
            onChange={(e) => setAsking({ kind: 'rename', id: row.id, name: e.target.value })}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              submitRename(row, asked.name);
            }}
          />
          <p id={`${id}-rename-help`} className="mt-1.5 text-xs text-muted-foreground">
            {CATEGORY_RENAME_HELP}
          </p>
        </ConfirmRow>
      );
    }
    return (
      <ConfirmRow
        key={row.id}
        colSpan={COLUMNS}
        label={`Archive ${row.name}`}
        confirmLabel="Archive category"
        pendingLabel="Archiving…"
        pending={write.pending}
        error={write.error}
        tone="default"
        icon={Archive}
        onConfirm={() =>
          write.run(
            () => actions.setActive(categoryArchivePayload(row)),
            (saved) => {
              setAsking(null);
              setNote(categoryArchivedNote(saved));
            },
          )
        }
        onCancel={() => ask(null)}
      >
        Archive <span className="font-medium [overflow-wrap:anywhere]">{row.name}</span>? {categoryArchiveEffect(row)}
      </ConfirmRow>
    );
  };

  const list = (kind: CategoryKind) => (
    <section aria-labelledby={`${id}-${kind}`} className="min-w-0">
      <h4 id={`${id}-${kind}`} className="px-4 pb-2 text-sm font-medium">
        {LIST_TITLES[kind]}
      </h4>
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/40">
            <TableHead>Name</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="w-10">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {lists[kind].length === 0 ? (
            <TableRow>
              <TableCell colSpan={COLUMNS} className="py-6 text-center text-muted-foreground">
                No {kind} categories yet.
              </TableCell>
            </TableRow>
          ) : null}
          {lists[kind].map((row) => {
            const inRow = question(row);
            if (inRow) return inRow;
            const mark = categoryMark(row);
            return (
              <TableRow key={row.id} className={cn(!row.active && 'opacity-60')}>
                {/* A long name wraps, even one with no space in it; it is never cut off behind a tooltip. */}
                <TableCell className="min-w-32 whitespace-normal font-medium [overflow-wrap:anywhere]">
                  {row.name}
                  {mark ? <span className="block text-xs font-normal text-muted-foreground">{mark}</span> : null}
                </TableCell>
                <TableCell>
                  <span
                    className={cn(
                      'inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium',
                      row.active ? 'bg-emerald-500/15 text-emerald-600' : 'bg-muted text-muted-foreground',
                    )}
                  >
                    {row.active ? 'Active' : 'Archived'}
                  </span>
                </TableCell>
                <TableCell>{busy ? null : <RowMenu label={row.name} items={categoryActions(row).map((action) => menuItem(row, action))} />}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </section>
  );

  return (
    <BentoCard
      title="Categories"
      subtitle={<span className="block whitespace-normal">Both kinds, archived ones included</span>}
      icon={ListTree}
      flush
      action={
        <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={busy}>
          Done
        </Button>
      }
      className="col-span-2 md:col-span-12"
    >
      {/* The add form waits while a row is being asked about: one thing is open at a time. */}
      <form onSubmit={submitAdd} noValidate inert={asked !== null} className={cn('grid gap-3 p-4 md:grid-cols-12', asked && 'opacity-50')}>
        <div className="space-y-1.5 md:col-span-6">
          <Label htmlFor={`${id}-name`}>New category</Label>
          <Input
            id={`${id}-name`}
            value={form.name}
            placeholder="Fuel"
            autoComplete="off"
            autoFocus
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          />
        </div>
        <div className="space-y-1.5 md:col-span-3">
          <Label htmlFor={`${id}-kind`}>Kind</Label>
          <Select value={form.kind} onValueChange={(v) => setForm((f) => ({ ...f, kind: v as CategoryKind }))}>
            <SelectTrigger id={`${id}-kind`} className="w-full" aria-describedby={`${id}-kind-help`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="expense">{CATEGORY_KIND_LABELS.expense}</SelectItem>
              <SelectItem value="income">{CATEGORY_KIND_LABELS.income}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-end md:col-span-3">
          <Button type="submit" size="sm" disabled={busy}>
            {add.pending ? 'Adding…' : 'Add category'}
          </Button>
        </div>
        <p id={`${id}-kind-help`} className="text-xs text-muted-foreground md:col-span-12">
          The kind is chosen when a category is added and does not change afterwards.
        </p>
        {add.error ? (
          <p role="alert" className="text-sm text-destructive md:col-span-12">
            {add.error}
          </p>
        ) : null}
      </form>
      {/* What just happened is said here, under the form the person was using, not at the foot of two long lists. */}
      {restore.error ? (
        <p role="alert" className="px-4 pb-4 text-sm text-destructive">
          {restore.error}
        </p>
      ) : null}
      {note ? (
        <p role="status" className="px-4 pb-4 text-sm text-muted-foreground">
          {note}
        </p>
      ) : null}
      <div className="grid gap-6 border-t pt-4 md:grid-cols-2 md:gap-0 md:divide-x">
        {list('expense')}
        {list('income')}
      </div>
    </BentoCard>
  );
}
