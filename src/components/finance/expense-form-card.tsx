'use client';

import { type FormEvent, useId, useState } from 'react';
import { FileText } from 'lucide-react';
import { BentoCard } from '@/components/bento/bento';
import { useFinanceAction } from '@/components/finance/use-finance-action';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { withCurrent } from '@/lib/finance/cash-receipt-form';
import {
  type ExpenseForm,
  TYPED_VENDOR,
  afterRefusedExpenseSave,
  editExpenseForm,
  expenseFormError,
  expensePayload,
  expenseSaveHint,
  newExpenseForm,
} from '@/lib/finance/expense-form';
import type { ExpenseCategory, ExpenseRow, SavedExpense } from '@/lib/finance/expenses';
import type { FinResult } from '@/lib/finance/result';

export type ExpenseFormActions = {
  save: (input: unknown) => Promise<FinResult<SavedExpense>>;
};

/** What the card hands back after a save: the expense, how the database left it, and what was typed, for the screen's note. */
export type SavedExpenseNote = SavedExpense & { vendor: string; amount: number; date: string };

/**
 * One expense, new or one being changed (pending, or rejected and being sent
 * again): a date, a category, a vendor who is a contact or a typed name, an
 * amount with its SST inside it, and notes. There is one button, "Save
 * expense": the database approves the expense when the person saving is an
 * owner or admin (`canDecide`) and leaves it pending otherwise, and the card
 * says which it will be before the save. A card of its own, opened by the
 * Expenses screen; the rules are in src/lib/finance/expense-form.ts.
 * `initial` pre-fills a new form (a receipt's details); `actions.save` is
 * whatever saves it.
 */
export function ExpenseFormCard({
  editing,
  initial,
  contacts,
  categories,
  today,
  canDecide,
  actions,
  onClose,
}: {
  /** The expense being changed; absent for a new one. */
  editing?: ExpenseRow;
  /** Fields to start a new form with, over the defaults. */
  initial?: Partial<ExpenseForm>;
  /** Active contacts, and active expense categories. */
  contacts: { id: string; name: string }[];
  categories: ExpenseCategory[];
  /** The default date, YYYY-MM-DD: the person's own local date. */
  today: string;
  /** True for an owner or admin: what they save is approved. */
  canDecide: boolean;
  actions: ExpenseFormActions;
  /** Called when the card should go: after a save (told what was saved), or Cancel. */
  onClose: (saved?: SavedExpenseNote) => void;
}) {
  const id = useId();
  const [form, setForm] = useState<ExpenseForm>(() =>
    editing ? editExpenseForm(editing) : { ...newExpenseForm(categories, today), ...initial },
  );
  const save = useFinanceAction();
  // A change by the person answers the last refusal, so its sentence goes.
  const edit: typeof setForm = (next) => {
    save.clear();
    setForm(next);
  };

  // An expense may name a contact or a category that was archived since it was saved: it stays the expense's.
  const vendorChoices = withCurrent(contacts, editing?.vendor_id ? { id: editing.vendor_id, name: editing.vendor_name } : null);
  const categoryChoices = withCurrent(categories, editing ? { id: editing.category_id, name: editing.category_name } : null);
  const typed = form.vendor === TYPED_VENDOR;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    // Handled here rather than as a form action, so a refused form keeps what was typed.
    event.preventDefault();
    const problem = expenseFormError(form);
    if (problem) {
      save.fail(problem);
      return;
    }
    const payload = expensePayload(form);
    const vendor = typed ? form.vendorName.trim() : (vendorChoices.find((c) => c.id === form.vendor)?.name ?? '—');
    save.run(
      async () => {
        const result = await actions.save(payload);
        if (result.ok) return result;
        // An expense that someone deleted meanwhile is offered again as a new one.
        const after = afterRefusedExpenseSave(form, result.error);
        // Only the id is forgotten: anything typed while the save was pending is kept.
        if (after.form !== form) setForm((f) => ({ ...f, id: undefined }));
        return { ...result, error: after.error };
      },
      (saved) => onClose({ ...saved, vendor, amount: payload.amount, date: payload.expense_date }),
    );
  };

  return (
    <BentoCard
      title={form.id ? 'Edit expense' : 'New expense'}
      subtitle={
        editing?.status === 'rejected' && form.id
          ? 'It was rejected: change it and send it again'
          : 'What was spent, with any SST inside the amount'
      }
      icon={FileText}
      className="col-span-2 md:col-span-12"
    >
      <form onSubmit={submit} noValidate className="grid gap-3 md:grid-cols-12">
        <div className="space-y-1.5 md:col-span-3">
          <Label htmlFor={`${id}-date`}>Date</Label>
          <Input
            id={`${id}-date`}
            type="date"
            value={form.date}
            required
            autoFocus
            data-finance-focus
            onChange={(e) => edit((f) => ({ ...f, date: e.target.value }))}
          />
        </div>
        <div className="space-y-1.5 md:col-span-3">
          <Label htmlFor={`${id}-category`}>Category</Label>
          <Select value={form.categoryId} onValueChange={(v) => edit((f) => ({ ...f, categoryId: v }))}>
            <SelectTrigger id={`${id}-category`} className="w-full">
              <SelectValue placeholder={categoryChoices.length ? 'Choose a category' : 'No expense category'} />
            </SelectTrigger>
            <SelectContent>
              {categoryChoices.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5 md:col-span-3">
          <Label htmlFor={`${id}-vendor`}>Vendor</Label>
          <Select value={form.vendor} onValueChange={(v) => edit((f) => ({ ...f, vendor: v }))}>
            <SelectTrigger id={`${id}-vendor`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {/* Radix refuses an empty value, so "not a contact" has one of its own. */}
              <SelectItem value={TYPED_VENDOR}>Not a contact</SelectItem>
              {vendorChoices.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {typed ? (
          <div className="space-y-1.5 md:col-span-3">
            <Label htmlFor={`${id}-vendor-name`}>Vendor name</Label>
            <Input
              id={`${id}-vendor-name`}
              value={form.vendorName}
              maxLength={200}
              placeholder="Who was paid"
              autoComplete="off"
              onChange={(e) => edit((f) => ({ ...f, vendorName: e.target.value }))}
            />
          </div>
        ) : null}
        <div className="space-y-1.5 md:col-span-3">
          <Label htmlFor={`${id}-amount`}>Amount (RM), SST included</Label>
          {/* A text box, like the SST: a number box hands back nothing for "1,200.50", and the form could not say why. */}
          <Input
            id={`${id}-amount`}
            type="text"
            inputMode="decimal"
            className="text-right tabular-nums"
            placeholder="0.00"
            autoComplete="off"
            value={form.amount}
            onChange={(e) => edit((f) => ({ ...f, amount: e.target.value }))}
          />
        </div>
        <div className="space-y-1.5 md:col-span-3">
          <Label htmlFor={`${id}-sst`}>SST inside it (RM)</Label>
          {/*
            A text box, not a number box: a number box hands back nothing for "1,0", and nothing here means
            "no SST", so a mistyped figure would be saved as 0 without a word. As text it is refused instead.
          */}
          <Input
            id={`${id}-sst`}
            type="text"
            inputMode="decimal"
            className="text-right tabular-nums"
            placeholder="0.00"
            autoComplete="off"
            value={form.sst}
            onChange={(e) => edit((f) => ({ ...f, sst: e.target.value }))}
          />
        </div>
        <div className="space-y-1.5 md:col-span-6">
          <Label htmlFor={`${id}-notes`}>Notes</Label>
          <Input
            id={`${id}-notes`}
            value={form.notes}
            maxLength={200}
            autoComplete="off"
            onChange={(e) => edit((f) => ({ ...f, notes: e.target.value }))}
          />
        </div>

        <p className="text-xs text-muted-foreground md:col-span-12">{expenseSaveHint(canDecide, form.id ? editing : undefined)}</p>

        <div className="flex flex-wrap items-center gap-3 md:col-span-12">
          <Button type="submit" size="sm" disabled={save.pending}>
            {save.pending ? 'Saving…' : 'Save expense'}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => onClose()} disabled={save.pending}>
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
