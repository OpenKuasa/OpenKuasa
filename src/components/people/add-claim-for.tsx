'use client';

import { useState, useTransition } from 'react';
import { Dialog } from 'radix-ui';
import { Plus } from 'lucide-react';
import { submitClaimForAction } from '@/app/(app)/people/pay-actions';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { WRITE_FAILED, writeOutcome } from '@/lib/people/capabilities';
import type { ClaimFormInput } from '@/lib/people/claim-forms';
import type { LeaveEmployee } from './add-leave-for';
import { ClaimForm } from './claim-form';
import { discardUploadedReceipt, uploadOwnReceipt } from './receipt-client';

/**
 * "Add claim for…": an owner or admin picks an active employee, then fills the
 * shared claim form. The receipt goes into the owner's own folder (the only one
 * the bucket lets them write to); the claim then points at it. The employee id
 * travels with the request, and the database checks the caller again.
 */
export function AddClaimFor({ employees, disabled }: { employees: LeaveEmployee[]; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [employeeId, setEmployeeId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();

  const close = () => {
    setOpen(false);
    setEmployeeId('');
    setError(null);
  };

  function onSubmit(input: ClaimFormInput): Promise<boolean> {
    setError(null);
    // True: saved. False: definitely refused. Rejects when the call threw or was lost (it may have been saved).
    return new Promise<boolean>((resolve, reject) => {
      start(async () => {
        try {
          const result = await submitClaimForAction({ ...input, employee_id: employeeId });
          if (result.ok) close();
          else setError(result.error);
          const outcome = writeOutcome(result);
          // An unknown outcome (the generic failure) may have been saved: reject, so the form keeps its file.
          if (outcome === 'unknown') reject(new Error('unknown outcome'));
          else resolve(outcome === 'saved');
        } catch (error) {
          setError(WRITE_FAILED);
          reject(error);
        }
      });
    });
  }

  return (
    <>
      <Button type="button" size="sm" disabled={disabled} onClick={() => {
          setError(null);
          setOpen(true);
        }}>
        <Plus className="size-4" />
        Add claim for…
      </Button>
      <Dialog.Root
        open={open && !disabled}
        onOpenChange={(next) => {
          if (!next && !busy) close();
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
          <Dialog.Content className="fixed top-1/2 left-1/2 z-50 max-h-[90vh] w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border bg-background p-5 shadow-lg outline-none">
            <Dialog.Title className="text-base font-semibold">Add claim for…</Dialog.Title>
            <Dialog.Description className="mb-4 text-sm text-muted-foreground">
              Enter an expense claim on behalf of an employee. It goes into the queue as pending.
            </Dialog.Description>
            <div className="mb-4 space-y-1.5">
              <span className="text-xs font-medium text-muted-foreground">Employee</span>
              <Select
                value={employeeId}
                disabled={busy}
                onValueChange={(next) => {
                  setEmployeeId(next);
                  setError(null);
                }}
              >
                <SelectTrigger aria-label="Employee" className="w-full">
                  <SelectValue placeholder="Choose an employee" />
                </SelectTrigger>
                <SelectContent>
                  {employees.map((employee) => (
                    <SelectItem key={employee.id} value={employee.id}>
                      {employee.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {employeeId ? (
              // key: remount per employee so one person's draft and receipt never carry over to another's claim.
              <ClaimForm
                key={employeeId}
                disabled={busy}
                error={error}
                onUpload={uploadOwnReceipt}
                onDiscard={discardUploadedReceipt}
                onSubmit={onSubmit}
                onCancel={close}
              />
            ) : (
              <p className="text-sm text-muted-foreground">Choose an employee to continue.</p>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
