'use client';

import { type FormEvent, useId, useState } from 'react';
import { FileText } from 'lucide-react';
import { BentoCard } from '@/components/bento/bento';
import { useFinanceAction } from '@/components/finance/use-finance-action';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { eInvoiceForm, eInvoiceFormError, eInvoicePayload, withEInvoiceStatus } from '@/lib/finance/invoice-form';
import { EINVOICE_STATUSES, EINVOICE_UUID_MAX, type EInvoiceStatus, type InvoiceListRow } from '@/lib/finance/invoices';
import type { FinResult } from '@/lib/finance/result';
import { EINVOICE_STATUS_LABELS } from '@/lib/finance/sales-views';

/**
 * What a person has recorded about one posted invoice's e-Invois: its status
 * at LHDN and the UUID LHDN gave it. A record only: nothing is submitted from
 * here. The rules are in src/lib/finance/invoice-form.ts.
 */
export function EInvoiceCard({
  invoice,
  save,
  onClose,
}: {
  /** A posted invoice. */
  invoice: InvoiceListRow;
  save: (input: unknown) => Promise<FinResult<{ id: string }>>;
  onClose: () => void;
}) {
  const id = useId();
  const [form, setForm] = useState(() => eInvoiceForm(invoice));
  const action = useFinanceAction();
  // A change by the person answers the last refusal, so its sentence goes.
  const edit: typeof setForm = (next) => {
    action.clear();
    setForm(next);
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    // Handled here rather than as a form action, so a refused form keeps what was typed.
    event.preventDefault();
    const problem = eInvoiceFormError(invoice.id, form);
    if (problem) {
      action.fail(problem);
      return;
    }
    action.run(() => save(eInvoicePayload(invoice.id, form)), onClose);
  };

  return (
    <BentoCard
      title="e-Invois"
      subtitle={`What you have recorded for ${invoice.invoice_no ?? 'this invoice'} at LHDN. Nothing is submitted from here.`}
      icon={FileText}
      className="col-span-2 md:col-span-12"
    >
      <form onSubmit={submit} noValidate className="grid gap-3 md:grid-cols-12">
        <div className="space-y-1.5 md:col-span-3">
          <Label htmlFor={`${id}-status`}>Status</Label>
          <Select value={form.status} onValueChange={(v) => edit((f) => withEInvoiceStatus(f, v as EInvoiceStatus))}>
            <SelectTrigger id={`${id}-status`} className="w-full" autoFocus data-finance-focus>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {EINVOICE_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {s === 'none' ? 'None' : EINVOICE_STATUS_LABELS[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5 md:col-span-6">
          <Label htmlFor={`${id}-uuid`}>LHDN UUID</Label>
          <Input
            id={`${id}-uuid`}
            value={form.uuid}
            maxLength={EINVOICE_UUID_MAX}
            // An invoice with no e-Invois has no UUID.
            disabled={form.status === 'none'}
            placeholder={form.status === 'none' ? 'Choose a status first' : 'As shown on MyInvois'}
            autoComplete="off"
            className="font-mono"
            onChange={(e) => edit((f) => ({ ...f, uuid: e.target.value }))}
          />
        </div>
        <div className="flex flex-wrap items-center gap-3 md:col-span-12">
          <Button type="submit" size="sm" disabled={action.pending}>
            {action.pending ? 'Saving…' : 'Save'}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={action.pending}>
            Cancel
          </Button>
          {action.error ? (
            <p role="alert" className="text-sm text-destructive">
              {action.error}
            </p>
          ) : null}
        </div>
      </form>
    </BentoCard>
  );
}
