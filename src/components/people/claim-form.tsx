'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { CapResult } from '@/lib/people/capabilities';
import { type ClaimFormInput, type ClaimFormValues, claimFormDefaults, toClaimInput } from '@/lib/people/claim-forms';
import { todayInMalaysia } from '@/lib/people/dates';
import { CLAIM_CATEGORY_LABEL } from '@/lib/people/own';
import { RECEIPT_TYPES, receiptProblem } from '@/lib/people/receipts';
import type { ClaimCategory } from '@/lib/people/types';

const CATEGORIES = Object.keys(CLAIM_CATEGORY_LABEL) as ClaimCategory[];
const ACCEPT = [...Object.keys(RECEIPT_TYPES), ...Object.values(RECEIPT_TYPES).map((ext) => `.${ext}`)].join(',');

type Receipt =
  | { state: 'none' }
  | { state: 'uploading' }
  | { state: 'attached'; name: string }
  | { state: 'failed'; message: string };

/**
 * The form for making an expense claim. It knows nothing about whose claim it
 * is: the screen around it supplies the employee. A receipt is uploaded as soon
 * as it is chosen (by `onUpload`), and the claim carries the path it gets back.
 * The form cannot remove an upload it no longer wants: a file that ends up
 * unused stays in the uploader's folder.
 */
export function ClaimForm({
  disabled,
  error,
  onUpload,
  onSubmit,
  onCancel,
}: {
  disabled: boolean;
  /** What the server said about the last attempt. */
  error: string | null;
  onUpload: (file: File) => Promise<CapResult<{ path: string }>>;
  onSubmit: (input: ClaimFormInput) => void;
  onCancel: () => void;
}) {
  const [today] = useState(() => todayInMalaysia(new Date()));
  const [values, setValues] = useState<ClaimFormValues>(() => claimFormDefaults(today));
  const [invalid, setInvalid] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<Receipt>({ state: 'none' });

  const set = <K extends keyof ClaimFormValues>(field: K, value: ClaimFormValues[K]) => {
    setInvalid(null);
    setValues((state) => ({ ...state, [field]: value }));
  };

  const choose = async (file: File | undefined) => {
    if (!file) return;
    set('receipt_path', null);
    const problem = receiptProblem(file);
    if (problem) {
      setReceipt({ state: 'failed', message: problem });
      return;
    }
    setReceipt({ state: 'uploading' });
    let result: CapResult<{ path: string }>;
    try {
      result = await onUpload(file);
    } catch {
      result = { ok: false, error: 'That file could not be uploaded.' };
    }
    if (result.ok) {
      set('receipt_path', result.data.path);
      setReceipt({ state: 'attached', name: file.name });
    } else {
      setReceipt({ state: 'failed', message: result.error });
    }
  };

  const clear = () => {
    set('receipt_path', null);
    setReceipt({ state: 'none' });
  };

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        const result = toClaimInput(values, today);
        setInvalid(result.ok ? null : result.error);
        if (result.ok) onSubmit(result.input);
      }}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Category">
          <Select value={values.category} disabled={disabled} onValueChange={(value) => set('category', value as ClaimCategory)}>
            <SelectTrigger aria-label="Category" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CATEGORIES.map((category) => (
                <SelectItem key={category} value={category}>
                  {CLAIM_CATEGORY_LABEL[category]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Amount (RM)">
          <Input
            aria-label="Amount in Ringgit"
            type="text"
            inputMode="decimal"
            autoComplete="off"
            placeholder="85.00"
            required
            disabled={disabled}
            value={values.amount}
            onChange={(event) => set('amount', event.target.value)}
          />
        </Field>
        <Field label="Date of expense">
          <Input
            aria-label="Date of expense"
            type="date"
            required
            max={today}
            disabled={disabled}
            value={values.claim_date}
            onChange={(event) => set('claim_date', event.target.value)}
          />
        </Field>
      </div>

      <Field label="Description (optional)">
        <Input
          aria-label="Description"
          type="text"
          maxLength={500}
          disabled={disabled}
          value={values.description}
          onChange={(event) => set('description', event.target.value)}
        />
      </Field>

      <Field label="Receipt (optional)">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            aria-label="Receipt file"
            type="file"
            accept={ACCEPT}
            disabled={disabled || receipt.state === 'uploading'}
            onChange={(event) => {
              void choose(event.target.files?.[0]);
              // Choosing the same file again should run again.
              event.target.value = '';
            }}
          />
          {receipt.state === 'attached' ? (
            <Button type="button" variant="outline" size="sm" onClick={clear} disabled={disabled}>
              Remove
            </Button>
          ) : null}
        </div>
        <div role="status" aria-live="polite" className="min-h-5 text-sm">
          {receipt.state === 'uploading' ? <p className="text-muted-foreground">Uploading…</p> : null}
          {receipt.state === 'attached' ? <p className="text-muted-foreground">Attached: {receipt.name}</p> : null}
          {receipt.state === 'failed' ? <p className="text-destructive">{receipt.message}</p> : null}
        </div>
      </Field>

      {invalid || error ? (
        <p role="alert" className="text-sm text-destructive">
          {invalid ?? error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onCancel} disabled={disabled}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={disabled || receipt.state === 'uploading'}>
          Submit claim
        </Button>
      </div>
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}
