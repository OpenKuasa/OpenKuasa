'use client';

import { useState, useTransition } from 'react';
import { Dialog } from 'radix-ui';
import { Plus } from 'lucide-react';
import { applyLeaveForAction, previewLeaveForAction } from '@/app/(app)/people/leave-actions';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { CapResult } from '@/lib/people/capabilities';
import type { LeavePreview } from '@/lib/people/leave';
import type { LeaveFormInput, LeavePreviewFormInput } from '@/lib/people/leave-forms';
import { LeaveForm } from './leave-form';

export type LeaveEmployee = { id: string; name: string };

/**
 * "Add leave for…": an owner or admin picks an active employee, then fills
 * the shared leave form. The employee id travels with the request here; the
 * database checks the caller is an owner or admin again.
 */
export function AddLeaveFor({ employees, disabled }: { employees: LeaveEmployee[]; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [employeeId, setEmployeeId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();

  const close = () => {
    setOpen(false);
    setEmployeeId('');
    setError(null);
  };

  const onPreview = (input: LeavePreviewFormInput) =>
    previewLeaveForAction({ ...input, employee_id: employeeId }) as Promise<CapResult<LeavePreview>>;

  function onSubmit(input: LeaveFormInput) {
    setError(null);
    start(async () => {
      try {
        const result = await applyLeaveForAction({ ...input, employee_id: employeeId });
        if (result.ok) close();
        else setError(result.error);
      } catch {
        setError('That change could not be saved. Please try again.');
      }
    });
  }

  return (
    <>
      <Button type="button" size="sm" disabled={disabled} onClick={() => setOpen(true)}>
        <Plus className="size-4" />
        Add leave for…
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
            <Dialog.Title className="text-base font-semibold">Add leave for…</Dialog.Title>
            <Dialog.Description className="mb-4 text-sm text-muted-foreground">
              Enter leave on behalf of an employee. It goes into the queue as pending.
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
              // key: LeaveForm only re-previews when its own fields change, so remount it per employee or the last one's preview stays up.
              <LeaveForm
                key={employeeId}
                disabled={busy}
                error={error}
                onPreview={onPreview}
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
