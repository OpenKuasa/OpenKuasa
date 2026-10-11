'use client';

import { useState, useTransition } from 'react';
import { Dialog } from 'radix-ui';
import { Plus } from 'lucide-react';
import { previewOvertimeForAction, submitOvertimeForAction } from '@/app/(app)/people/pay-actions';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { type CapResult, WRITE_FAILED } from '@/lib/people/capabilities';
import type { OvertimeFormInput, OvertimePreviewFormInput } from '@/lib/people/overtime-forms';
import type { OvertimePreview } from '@/lib/people/pay-requests';
import type { LeaveEmployee } from './add-leave-for';
import { OvertimeForm } from './overtime-form';

/**
 * "Add overtime for…": an owner or admin picks an active employee, then fills
 * the shared overtime form, remounted per employee so the last one's preview
 * never stays up. The amount shown is the database's own working-out.
 */
export function AddOvertimeFor({ employees, disabled }: { employees: LeaveEmployee[]; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [employeeId, setEmployeeId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();

  const close = () => {
    setOpen(false);
    setEmployeeId('');
    setError(null);
  };

  const onPreview = (input: OvertimePreviewFormInput) =>
    previewOvertimeForAction({ ...input, employee_id: employeeId }) as Promise<CapResult<OvertimePreview>>;

  function onSubmit(input: OvertimeFormInput) {
    setError(null);
    start(async () => {
      try {
        const result = await submitOvertimeForAction({ ...input, employee_id: employeeId });
        if (result.ok) close();
        else setError(result.error);
      } catch {
        setError(WRITE_FAILED);
      }
    });
  }

  return (
    <>
      <Button type="button" size="sm" disabled={disabled} onClick={() => {
          setError(null);
          setOpen(true);
        }}>
        <Plus className="size-4" />
        Add overtime for…
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
            <Dialog.Title className="text-base font-semibold">Add overtime for…</Dialog.Title>
            <Dialog.Description className="mb-4 text-sm text-muted-foreground">
              Enter overtime on behalf of an employee. It goes into the queue as pending.
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
              // key: OvertimeForm only re-previews when its own fields change, so remount it per employee.
              <OvertimeForm
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
