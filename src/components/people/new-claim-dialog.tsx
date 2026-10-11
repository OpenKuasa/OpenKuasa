'use client';

import { Plus } from 'lucide-react';
import { Dialog } from 'radix-ui';
import { type ReactNode, useState, useTransition } from 'react';
import { submitOwnClaimAction } from '@/app/(app)/people/pay-actions';
import { Button } from '@/components/ui/button';
import { type CapResult, WRITE_FAILED } from '@/lib/people/capabilities';
import type { ClaimFormInput } from '@/lib/people/claim-forms';
import { uploadReceipt } from '@/lib/people/receipts';
import { createClient } from '@/lib/supabase/client';
import { ClaimForm } from './claim-form';

/**
 * The header button and the dialog around a form. The error clears when the
 * dialog closes, and the dialog closes itself once the server accepts.
 */
export function PayRequestDialog<I>({
  label,
  title,
  description,
  render,
  submit,
}: {
  label: string;
  title: string;
  description: string;
  render: (props: { disabled: boolean; error: string | null; onCancel: () => void; onSubmit: (input: I) => void }) => ReactNode;
  submit: (input: I) => Promise<CapResult<unknown>>;
}) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    setOpen(false);
    setError(null);
  };

  function send(input: I) {
    start(async () => {
      try {
        const result = await submit(input);
        if (result.ok) close();
        else setError(result.error);
      } catch {
        setError(WRITE_FAILED);
      }
    });
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (next) setOpen(true);
        else if (!pending) close();
      }}
    >
      <Dialog.Trigger asChild>
        <Button type="button" size="sm">
          <Plus aria-hidden />
          {label}
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 max-h-[90vh] w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border bg-background p-5 shadow-lg outline-none">
          <Dialog.Title className="text-base font-semibold">{title}</Dialog.Title>
          <Dialog.Description className="mb-4 text-sm text-muted-foreground">{description}</Dialog.Description>
          {render({ disabled: pending, error, onCancel: close, onSubmit: send })}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const UPLOAD_FAILED = 'That file could not be uploaded.';

/** Uploads into the signed-in user's own receipts folder with the browser's client. */
async function uploadOwnReceipt(file: File): Promise<CapResult<{ path: string }>> {
  try {
    const client = createClient();
    const { data } = await client.auth.getUser();
    if (!data.user) return { ok: false, error: UPLOAD_FAILED };
    return await uploadReceipt(client, data.user.id, file, file.type);
  } catch {
    return { ok: false, error: UPLOAD_FAILED };
  }
}

/** "New Claim": the claim form for the signed-in member's own expense claim. */
export function NewClaimDialog() {
  return (
    <PayRequestDialog
      label="New Claim"
      title="New claim"
      description="Say what you spent and attach the receipt if you have one."
      submit={(input: ClaimFormInput) => submitOwnClaimAction(input)}
      render={({ disabled, error, onCancel, onSubmit }) => (
        <ClaimForm disabled={disabled} error={error} onUpload={uploadOwnReceipt} onCancel={onCancel} onSubmit={onSubmit} />
      )}
    />
  );
}
