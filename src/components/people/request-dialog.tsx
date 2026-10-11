'use client';

import { Plus } from 'lucide-react';
import { Dialog } from 'radix-ui';
import { type ReactNode, useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { type CapResult, WRITE_FAILED } from '@/lib/people/capabilities';

/**
 * The header button and the dialog around a form. The error clears when the
 * dialog closes, and the dialog closes itself once the server accepts.
 */
export function RequestDialog<I>({
  label,
  title,
  description,
  render,
  submit,
}: {
  label: string;
  title: string;
  description: string;
  /** `onSubmit` answers whether the server accepted, for a form that has something to undo when it did not. */
  render: (props: { disabled: boolean; error: string | null; onCancel: () => void; onSubmit: (input: I) => Promise<boolean> }) => ReactNode;
  submit: (input: I) => Promise<CapResult<unknown>>;
}) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    setOpen(false);
    setError(null);
  };

  function send(input: I): Promise<boolean> {
    return new Promise((resolve) => {
      start(async () => {
        let saved = false;
        try {
          const result = await submit(input);
          saved = result.ok;
          if (result.ok) close();
          else setError(result.error);
        } catch {
          setError(WRITE_FAILED);
        }
        resolve(saved);
      });
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
