'use client';

import { Plus } from 'lucide-react';
import { Dialog } from 'radix-ui';
import { type ReactNode, useState, useTransition } from 'react';
import {
  applyOwnLeaveAction,
  applyOwnTimeOffAction,
  previewOwnLeaveAction,
} from '@/app/(app)/people/leave-actions';
import { Button } from '@/components/ui/button';
import { type CapResult, WRITE_FAILED } from '@/lib/people/capabilities';
import type { LeaveFormInput } from '@/lib/people/leave-forms';
import type { TimeOffFormInput } from '@/lib/people/time-off-forms';
import { LeaveForm } from './leave-form';
import { TimeOffForm } from './time-off-form';

/**
 * The header button and the dialog around a form. The error clears when the
 * dialog closes, and the dialog closes itself once the server accepts.
 */
function RequestDialog<I>({
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

/** "Apply Leave": the leave form for the signed-in member's own leave. */
export function ApplyLeaveDialog() {
  return (
    <RequestDialog
      label="Apply Leave"
      title="Apply for leave"
      description="Choose the dates. Working days are counted for you."
      submit={(input: LeaveFormInput) => applyOwnLeaveAction(input)}
      render={({ disabled, error, onCancel, onSubmit }) => (
        <LeaveForm
          disabled={disabled}
          error={error}
          onCancel={onCancel}
          onPreview={(input) => previewOwnLeaveAction(input)}
          onSubmit={onSubmit}
        />
      )}
    />
  );
}

/** "Request Time-Off": the time-off form for the signed-in member. */
export function ApplyTimeOffDialog() {
  return (
    <RequestDialog
      label="Request Time-Off"
      title="Request time-off"
      description="Ask for a few hours off on one day."
      submit={(input: TimeOffFormInput) => applyOwnTimeOffAction(input)}
      render={({ disabled, error, onCancel, onSubmit }) => (
        <TimeOffForm disabled={disabled} error={error} onCancel={onCancel} onSubmit={onSubmit} />
      )}
    />
  );
}
