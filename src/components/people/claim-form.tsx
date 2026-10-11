'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { CapResult } from '@/lib/people/capabilities';
import {
  type ClaimFormInput,
  type ClaimFormValues,
  claimFormDefaults,
  receiptSubmitProblem,
  toClaimInput,
} from '@/lib/people/claim-forms';
import { todayInMalaysia } from '@/lib/people/dates';
import { CLAIM_CATEGORY_LABEL } from '@/lib/people/own';
import { RECEIPT_TYPES, receiptProblem } from '@/lib/people/receipts';
import type { ClaimCategory } from '@/lib/people/types';

const CATEGORIES = Object.keys(CLAIM_CATEGORY_LABEL) as ClaimCategory[];
const ACCEPT = [
  ...Object.keys(RECEIPT_TYPES),
  ...Object.values(RECEIPT_TYPES).map((ext) => `.${ext}`),
  '.jpeg',
  '.heif',
  'image/heif',
].join(',');

type Receipt =
  | { state: 'none' }
  | { state: 'uploading' }
  | { state: 'attached'; name: string }
  | { state: 'failed'; message: string };

/**
 * The form for making an expense claim. It knows nothing about whose claim it
 * is: the screen around it supplies the employee. A receipt is uploaded as soon
 * as it is chosen (by `onUpload`), and the claim carries the path it gets back.
 * An upload the form no longer wants is handed to `onDiscard` (the server removes it, and refuses a file a claim
 * carries): when it is replaced or removed, when the form goes away without having submitted it, and when a submit
 * is refused (the claim can only take a file that is still there, so the person attaches it again).
 * A browser closed mid-form never gets to discard, so that one upload stays in the uploader's folder: accepted.
 * `onSubmit` answers whether the claim was saved; only a definite refusal discards the file.
 */
export function ClaimForm({
  disabled,
  error,
  onUpload,
  onDiscard,
  onSubmit,
  onCancel,
}: {
  disabled: boolean;
  /** What the server said about the last attempt. */
  error: string | null;
  onUpload: (file: File) => Promise<CapResult<{ path: string }>>;
  onDiscard: (path: string) => void;
  /** True: saved. False: definitely refused. Rejects when the call threw or was lost (it may have been saved). */
  onSubmit: (input: ClaimFormInput) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [today] = useState(() => todayInMalaysia(new Date()));
  const [values, setValues] = useState<ClaimFormValues>(() => claimFormDefaults(today));
  const [invalid, setInvalid] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<Receipt>({ state: 'none' });
  const [notice, setNotice] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const statusId = useId();
  // The uploaded path, readable from the cleanup below; the path being submitted, which is the claim's now.
  const uploaded = useRef<string | null>(null);
  const submitting = useRef<string | null>(null);
  const mounted = useRef(false);
  const discard = useRef(onDiscard);
  useEffect(() => {
    discard.current = onDiscard;
  });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Closed, or the employee changed, with a file up and not submitted.
      if (uploaded.current && uploaded.current !== submitting.current) discard.current(uploaded.current);
    };
  }, []);

  const drop = () => {
    if (uploaded.current) discard.current(uploaded.current);
    uploaded.current = null;
  };

  const set = <K extends keyof ClaimFormValues>(field: K, value: ClaimFormValues[K]) => {
    setInvalid(null);
    setValues((state) => ({ ...state, [field]: value }));
  };

  const choose = async (file: File | undefined) => {
    if (!file) return;
    // Replacing a file lets the old one go.
    drop();
    setNotice(null);
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
      if (!mounted.current) {
        // The form went away while the file was going up: nothing will use it.
        onDiscard(result.data.path);
        return;
      }
      uploaded.current = result.data.path;
      set('receipt_path', result.data.path);
      setReceipt({ state: 'attached', name: file.name });
    } else if (mounted.current) {
      setReceipt({ state: 'failed', message: result.error });
    }
  };

  const clear = () => {
    drop();
    setNotice(null);
    set('receipt_path', null);
    setReceipt({ state: 'none' });
  };

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        const blocked = receiptSubmitProblem(receipt.state);
        if (blocked) {
          setInvalid(blocked);
          return;
        }
        const result = toClaimInput(values, today);
        setInvalid(result.ok ? null : result.error);
        if (!result.ok) return;
        setNotice(null);
        const path = uploaded.current;
        submitting.current = path;
        onSubmit(result.input).then(
          (saved) => {
            if (saved || !path || !mounted.current) return;
            // Definitely refused: the claim can only take a file that is still there, so it goes (the server
            // still checks that no claim carries it) and the person attaches it again.
            submitting.current = null;
            drop();
            setValues((state) => ({ ...state, receipt_path: null }));
            setReceipt({ state: 'none' });
            setNotice('The claim was not saved, so its receipt was removed. Attach the receipt again.');
          },
          () => {
            // The call threw or was lost: the claim may have been saved with this file. Keep the file, say
            // nothing about it, and leave the parent's "could not be saved, please try again" showing.
          },
        );
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
          {/* The native input stays for the file dialog; its own "No file chosen" text would contradict
              "Attached: <name>", so the Button below is what a person sees, tabs to and hears. */}
          <input
            ref={fileInput}
            type="file"
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            accept={ACCEPT}
            disabled={disabled || receipt.state === 'uploading'}
            onChange={(event) => {
              void choose(event.target.files?.[0]);
              // Choosing the same file again should run again.
              event.target.value = '';
            }}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-describedby={statusId}
            disabled={disabled || receipt.state === 'uploading'}
            onClick={() => fileInput.current?.click()}
          >
            {receipt.state === 'attached' ? 'Replace file' : receipt.state === 'failed' ? 'Choose another file' : 'Choose file'}
          </Button>
          {receipt.state === 'attached' || receipt.state === 'failed' ? (
            <Button type="button" variant="outline" size="sm" onClick={clear} disabled={disabled}>
              Remove
            </Button>
          ) : null}
        </div>
        <div id={statusId} role="status" aria-live="polite" className="min-h-5 text-sm">
          {receipt.state === 'none' && !notice ? <p className="text-muted-foreground">No receipt attached.</p> : null}
          {receipt.state === 'uploading' ? <p className="text-muted-foreground">Uploading…</p> : null}
          {receipt.state === 'attached' ? <p className="text-muted-foreground">Attached: {receipt.name}</p> : null}
          {receipt.state === 'failed' ? <p className="text-destructive">{receipt.message}</p> : null}
          {notice ? <p className="text-destructive">{notice}</p> : null}
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
