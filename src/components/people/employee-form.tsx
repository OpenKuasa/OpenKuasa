'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  EMPLOYMENT_LABEL,
  EMPLOYMENT_TYPES,
  type EmployeeFormValues,
  employeeFormValues,
  toEmployeeInput,
} from '@/lib/people/employees';
import type { Department, Employee, EmployeePrivate, EmployeeStatus, EmploymentType } from '@/lib/people/types';
import {
  type EntitlementChange,
  EntitlementsFields,
  type EntitlementType,
  type LoadedEntitlement,
  entitlementChanges,
  entitlementValues,
} from './entitlements-fields';

/** The employee being edited, with their private details as loaded when the form opened. */
export type EditingEmployee = {
  employee: Employee;
  private: EmployeePrivate | null;
  privateLoaded: boolean;
  /** This year's annual, medical and emergency balances, loaded with the private details. */
  entitlements: { year: number; rows: LoadedEntitlement[]; loaded: boolean };
};

const NO_DEPARTMENT = 'none';

type TextKey = {
  [K in keyof EmployeeFormValues]: EmployeeFormValues[K] extends string ? K : never;
}[keyof EmployeeFormValues];

export function EmployeeForm({
  initial,
  departments,
  disabled,
  error,
  onCancel,
  onSubmit,
}: {
  initial: EditingEmployee | null;
  departments: Department[];
  disabled: boolean;
  /** What the server said about the last attempt. */
  error: string | null;
  onCancel: () => void;
  onSubmit: (input: Record<string, unknown>, entitlements: EntitlementChange[]) => void;
}) {
  const [values, setValues] = useState<EmployeeFormValues>(() =>
    employeeFormValues(initial?.employee ?? null, initial?.private ?? null),
  );
  const [invalid, setInvalid] = useState<string | null>(null);
  const [initialEntitlements] = useState(() =>
    initial ? entitlementValues(initial.entitlements.rows, initial.entitlements.year) : null,
  );
  const [entitlements, setEntitlements] = useState(initialEntitlements);
  // A new employee can always be given private details. For an edit, only when they loaded:
  // sending them unloaded would blank what is saved.
  const includePrivate = initial ? initial.privateLoaded : true;

  const set = <K extends keyof EmployeeFormValues>(key: K, value: EmployeeFormValues[K]) =>
    setValues((current) => ({ ...current, [key]: value }));

  const text = (key: TextKey, label: string, props: { type?: string; placeholder?: string; required?: boolean } = {}) => (
    <Field label={label}>
      <Input
        aria-label={label}
        type={props.type ?? 'text'}
        placeholder={props.placeholder}
        required={props.required}
        value={values[key]}
        onChange={(event) => set(key, event.target.value as EmployeeFormValues[typeof key])}
      />
    </Field>
  );

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        const result = toEmployeeInput(values, { includePrivate });
        if (!result.ok) return setInvalid(result.error);
        let changes: EntitlementChange[] = [];
        if (initial && initial.entitlements.loaded && initialEntitlements && entitlements) {
          const checked = entitlementChanges(initialEntitlements, entitlements, initial.entitlements.year);
          if (!checked.ok) return setInvalid(checked.error);
          changes = checked.changes;
        }
        setInvalid(null);
        onSubmit(result.input, changes);
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {text('name', 'Name', { required: true })}
        {text('employee_no', 'Employee no.', { placeholder: initial ? undefined : 'Assigned if left blank' })}
        {text('work_email', 'Work email', { type: 'email' })}
        {text('designation', 'Designation')}
        <Field label="Department">
          <Select
            value={values.department_id || NO_DEPARTMENT}
            onValueChange={(value) => set('department_id', value === NO_DEPARTMENT ? '' : value)}
          >
            <SelectTrigger aria-label="Department" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_DEPARTMENT}>No department</SelectItem>
              {departments.map((department) => (
                <SelectItem key={department.id} value={department.id}>
                  {department.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Employment type">
          <Select value={values.employment_type} onValueChange={(value) => set('employment_type', value as EmploymentType)}>
            <SelectTrigger aria-label="Employment type" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {EMPLOYMENT_TYPES.map((type) => (
                <SelectItem key={type} value={type}>
                  {EMPLOYMENT_LABEL[type]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        {text('join_date', 'Join date', { type: 'date' })}
        {initial ? (
          <Field label="Status">
            <Select value={values.status} onValueChange={(value) => set('status', value as EmployeeStatus)}>
              <SelectTrigger aria-label="Status" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="inactive">Inactive</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        ) : null}
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="size-4 accent-primary"
          checked={values.is_manager}
          onChange={(event) => set('is_manager', event.target.checked)}
        />
        Manages other people
      </label>

      <div className="space-y-3 border-t pt-4">
        <div>
          <p className="text-sm font-medium">Private details</p>
          <p className="text-xs text-muted-foreground">
            Seen only by owners, admins and the employee themselves. Never shown in the staff directory.
          </p>
        </div>
        {includePrivate ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {text('base_salary', 'Monthly base salary (RM)', { placeholder: '3500' })}
            {text('nric', 'NRIC / passport no.')}
            {text('date_of_birth', 'Date of birth', { type: 'date' })}
            {text('phone', 'Phone')}
            <div className="sm:col-span-2">{text('address', 'Home address')}</div>
            {text('bank_name', 'Bank')}
            {text('bank_account', 'Bank account no.')}
            {text('epf_no', 'KWSP (EPF) no.')}
            {text('socso_no', 'PERKESO (SOCSO) no.')}
            {text('tax_no', 'LHDN tax no.')}
            {text('emergency_contact_name', 'Emergency contact')}
            {text('emergency_contact_phone', 'Emergency contact phone')}
          </div>
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            The private details could not be loaded, so they are left as they are. Close this and open it again to edit
            them.
          </p>
        )}
      </div>

      {initial && entitlements ? (
        <EntitlementsFields
          year={initial.entitlements.year}
          loaded={initial.entitlements.loaded}
          values={entitlements}
          disabled={disabled}
          onChange={(type: EntitlementType, value: string) => setEntitlements((current) => (current ? { ...current, [type]: value } : current))}
        />
      ) : null}

      {invalid || error ? (
        <p role="alert" className="text-sm text-destructive">
          {invalid ?? error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onCancel} disabled={disabled}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={disabled}>
          {initial ? 'Save changes' : 'Add employee'}
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
