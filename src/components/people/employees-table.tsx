'use client';

import { useMemo, useState, useTransition } from 'react';
import { Dialog } from 'radix-ui';
import { FileText, Pencil, Plus, Search, Target, Trash2, UserCheck, UserX } from 'lucide-react';
import {
  createEmployeeAction,
  deleteEmployeeAction,
  linkEmployeeToMemberAction,
  loadEmployeePrivateAction,
  setEmployeeStatusAction,
  setReportsToAction,
  updateEmployeeAction,
} from '@/app/(app)/people/actions';
import { loadLeaveEntitlementsAction, setLeaveEntitlementAction } from '@/app/(app)/people/leave-actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatDay, todayInMalaysia } from '@/lib/people/dates';
import type { EmployeeDocumentRow } from '@/lib/people/documents';
import { showsEmployeeDocumentsAction } from '@/lib/people/documents-screens';
import { type GoalLike, showGoalsAction } from '@/lib/people/goals-training';
import {
  EMPLOYMENT_LABEL,
  type EmployeeFilter,
  type EmployeesControls,
  directoryExtras,
  filterEmployees,
  linkableMembers,
  type StepResult,
  reportsToBaseline,
  reportsToRefusal,
  runSave,
  suggestedMember,
} from '@/lib/people/employees';
import type { WorkspaceMember } from '@/lib/people/members';
import type { Department, Employee } from '@/lib/people/types';
import { cn } from '@/lib/utils';
import { type EditingEmployee, EmployeeForm } from './employee-form';
import { EmployeeDocuments } from './employee-documents';
import { EmployeeGoals } from './employee-goals';
import type { EntitlementChange } from './entitlements-fields';

type ActionResult = {
  ok: boolean;
  error?: string;
  /** Shown after the form has closed: the employee was added, but the reporting line was refused. */
  notice?: string;
  /** The reporting line was refused on an edit; the form's control goes back to the saved value. */
  lineRefused?: boolean;
  /** The reporting line was saved though a later step failed: the manager now in the database (null for nobody). */
  baseline?: string | null;
};
type ReportsToChange = { changed: boolean; managerId: string | null };

const NOT_LINKED = 'none';

const initials = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0] ?? '')
    .join('')
    .toUpperCase();

/**
 * The staff directory. Everyone in the workspace sees the list and its
 * filters; an owner or admin (`canEdit`) also gets add, edit, deactivate,
 * delete and the account link. Nothing private is ever in `employees`.
 */
export function EmployeesTable({
  employees,
  departments,
  members,
  goals = null,
  documents = null,
  orgId = null,
  canEdit,
  controls,
  viewerEmployeeId = null,
}: {
  employees: Employee[];
  departments: Department[];
  /** The workspace's members, for the account link. Empty for someone who cannot edit. */
  members: WorkspaceMember[];
  /** Each employee's goals, by employee id, for the "Goals" action (owners and admins). Null hides the action. */
  goals?: Record<string, GoalLike[]> | null;
  /** Each employee's documents, by employee id, for the "Documents" action (owners and admins). Null hides the action. */
  documents?: Record<string, EmployeeDocumentRow[]> | null;
  /** The workspace id, to build a file's path. */
  orgId?: string | null;
  canEdit: boolean;
  /** What this viewer is offered beyond the list: the "Reports to" field and the "My team" filter. */
  controls: EmployeesControls;
  /** The viewer's own employee record, for "My team". */
  viewerEmployeeId?: string | null;
}) {
  const [pending, start] = useTransition();
  const [filter, setFilter] = useState<EmployeeFilter>({ query: '', departmentId: 'all', status: 'all', team: 'all' });
  const [reportsToResets, setReportsToResets] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<EditingEmployee | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [goalsFor, setGoalsFor] = useState<Employee | null>(null);
  const [documentsFor, setDocumentsFor] = useState<Employee | null>(null);
  const showDocuments = showsEmployeeDocumentsAction(canEdit, documents, orgId);

  const shown = useMemo(() => filterEmployees(employees, filter, viewerEmployeeId), [employees, filter, viewerEmployeeId]);
  const extras = useMemo(() => directoryExtras(employees), [employees]);
  const formOpen = canEdit && (creating || editing !== null);
  const columns = canEdit ? 10 : 8;

  function act(result: Promise<ActionResult>) {
    start(async () => {
      const res = await result;
      setError(res.ok ? (res.notice ?? null) : (res.error ?? 'Something went wrong.'));
      if (res.lineRefused) setReportsToResets((count) => count + 1);
      if (res.baseline !== undefined) {
        const managerId = res.baseline;
        setEditing((current) =>
          current ? { ...current, employee: { ...current.employee, reports_to: managerId } } : current,
        );
      }
      if (res.ok) {
        setCreating(false);
        setEditing(null);
      }
    });
  }

  /** Fetches the private details first, so they never travel with the directory. */
  function openEdit(employee: Employee) {
    setError(null);
    start(async () => {
      const [res, balances] = await Promise.all([
        loadEmployeePrivateAction({ id: employee.id }),
        loadLeaveEntitlementsAction({ employee_id: employee.id }),
      ]);
      setEditing({
        employee,
        private: res.ok ? res.data : null,
        privateLoaded: res.ok,
        entitlements: {
          year: Number(todayInMalaysia(new Date()).slice(0, 4)),
          rows: balances.ok ? balances.data : [],
          loaded: balances.ok,
        },
      });
    });
  }

  /** The reporting line, a separate request: only run when it changed, so a phone-number edit never takes its lock. */
  async function lineStep(id: string, managerId: string | null): Promise<StepResult> {
    const res = await setReportsToAction({ id, manager_id: managerId });
    return res.ok ? { ok: true } : { ok: false, error: reportsToRefusal(res.error, id, managerId ?? '', employees) };
  }

  /** Saves in SAVE_ORDER (details, the reporting line when it changed, each changed entitlement), stopping at the first refusal. */
  async function saveEdit(
    id: string,
    input: Record<string, unknown>,
    changes: EntitlementChange[],
    reportsTo: ReportsToChange,
  ): Promise<ActionResult> {
    const outcome = await runSave(reportsTo.changed, {
      details: async () => {
        const res = await updateEmployeeAction({ id, ...input });
        return res.ok ? { ok: true } : { ok: false, error: res.error };
      },
      reports_to: () => lineStep(id, reportsTo.managerId),
      entitlements: async () => {
        for (const change of changes) {
          const res = await setLeaveEntitlementAction({ employee_id: id, ...change });
          if (!res.ok) return { ok: false, error: res.error };
        }
        return { ok: true };
      },
    });
    if (outcome.ok) return { ok: true };
    const lineSaved = outcome.done.includes('reports_to');
    return {
      ok: false,
      error: outcome.error,
      lineRefused: outcome.step === 'reports_to',
      // The line is in the database now, so the form's baseline moves with it.
      ...(lineSaved ? { baseline: reportsToBaseline(null, outcome, reportsTo.managerId) } : {}),
    };
  }

  /** Adds the employee, then sets the reporting line. A refusal there never undoes the new employee: the form closes and the table says so. */
  async function saveNew(input: Record<string, unknown>, reportsTo: ReportsToChange): Promise<ActionResult> {
    let createdId = '';
    let createError = 'Something went wrong.';
    const outcome = await runSave(reportsTo.changed, {
      details: async () => {
        const created = await createEmployeeAction(input);
        if (!created.ok) {
          createError = created.error;
          return { ok: false, error: created.error };
        }
        createdId = created.data.id;
        return { ok: true };
      },
      reports_to: () => lineStep(createdId, reportsTo.managerId),
      entitlements: async () => ({ ok: true }),
    });
    if (outcome.ok) return { ok: true };
    return outcome.step === 'details' ? { ok: false, error: createError } : { ok: true, notice: outcome.error };
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-3 px-4 sm:flex-row sm:items-center">
        <div className="relative w-full sm:max-w-md">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Search employees"
            placeholder="Search name, email, employee no…"
            className="pl-9"
            value={filter.query}
            onChange={(event) => setFilter((current) => ({ ...current, query: event.target.value }))}
          />
        </div>
        <Select
          value={filter.departmentId}
          onValueChange={(value) => setFilter((current) => ({ ...current, departmentId: value }))}
        >
          <SelectTrigger aria-label="Department" className="w-full sm:w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All departments</SelectItem>
            {departments.map((department) => (
              <SelectItem key={department.id} value={department.id}>
                {department.name}
              </SelectItem>
            ))}
            <SelectItem value="none">No department</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={filter.status}
          onValueChange={(value) => setFilter((current) => ({ ...current, status: value as EmployeeFilter['status'] }))}
        >
          <SelectTrigger aria-label="Status" className="w-full sm:w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="inactive">Inactive</SelectItem>
          </SelectContent>
        </Select>
        {controls.myTeamFilter ? (
          <Select
            value={filter.team}
            onValueChange={(value) => setFilter((current) => ({ ...current, team: value as EmployeeFilter['team'] }))}
          >
            <SelectTrigger aria-label="Team" className="w-full sm:w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Everyone</SelectItem>
              <SelectItem value="mine">My team</SelectItem>
            </SelectContent>
          </Select>
        ) : null}
        {canEdit ? (
          <Button
            type="button"
            size="sm"
            className="shrink-0 sm:ml-auto"
            disabled={pending}
            onClick={() => {
              setError(null);
              setCreating(true);
            }}
          >
            <Plus className="size-4" />
            Add employee
          </Button>
        ) : null}
      </div>

      {error && !formOpen ? (
        <p
          role="alert"
          className="mx-4 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/40">
              <TableHead>Employee</TableHead>
              <TableHead>Employee no.</TableHead>
              <TableHead>Department</TableHead>
              <TableHead>Designation</TableHead>
              <TableHead>Reports to</TableHead>
              <TableHead>Type</TableHead>
              <TableHead className="whitespace-nowrap">Join date</TableHead>
              <TableHead>Status</TableHead>
              {canEdit ? <TableHead>Account</TableHead> : null}
              {canEdit ? <TableHead className="text-right">Actions</TableHead> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((employee) => {
              const suggestion = canEdit ? suggestedMember(members, employees, employee) : null;
              return (
              <TableRow key={employee.id}>
                <TableCell>
                  <div className="flex items-center gap-3">
                    <span className="grid size-8 shrink-0 place-items-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                      {initials(employee.name)}
                    </span>
                    <div className="min-w-0">
                      <p className="truncate font-medium">
                        {employee.name}
                        {extras.get(employee.id)?.manages ? (
                          <span className="ml-2 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                            Manager
                          </span>
                        ) : null}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">{employee.work_email ?? '—'}</p>
                    </div>
                  </div>
                </TableCell>
                <TableCell className="whitespace-nowrap tabular-nums">{employee.employee_no}</TableCell>
                <TableCell className="whitespace-nowrap">{employee.department_name ?? '—'}</TableCell>
                <TableCell className="whitespace-nowrap">{employee.designation ?? '—'}</TableCell>
                <TableCell className="whitespace-nowrap">{extras.get(employee.id)?.reportsTo ?? '—'}</TableCell>
                <TableCell className="whitespace-nowrap">{EMPLOYMENT_LABEL[employee.employment_type]}</TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">
                  {employee.join_date ? `${formatDay(employee.join_date)} ${employee.join_date.slice(0, 4)}` : '—'}
                </TableCell>
                <TableCell>
                  <span
                    className={cn(
                      'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium',
                      employee.status === 'active'
                        ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                        : 'bg-muted text-muted-foreground',
                    )}
                  >
                    {employee.status === 'active' ? 'Active' : 'Inactive'}
                  </span>
                </TableCell>
                {canEdit ? (
                  <TableCell>
                    <Select
                      value={employee.user_id ?? NOT_LINKED}
                      disabled={pending}
                      onValueChange={(value) => {
                        const next = value === NOT_LINKED ? null : value;
                        if (next === employee.user_id) return;
                        act(linkEmployeeToMemberAction({ id: employee.id, user_id: next }));
                      }}
                    >
                      <SelectTrigger aria-label={`Account for ${employee.name}`} size="sm" className="w-44">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NOT_LINKED}>Not linked</SelectItem>
                        {linkableMembers(members, employees, employee).map((member) => (
                          <SelectItem key={member.userId} value={member.userId}>
                            {member.email}
                          </SelectItem>
                        ))}
                        {/* A linked account that is not in the member list (no email on file) still has to show. */}
                        {employee.user_id && !members.some((member) => member.userId === employee.user_id) ? (
                          <SelectItem value={employee.user_id}>Linked account</SelectItem>
                        ) : null}
                      </SelectContent>
                    </Select>
                    {/* A member who signs in with this record's work email: offered, never linked without a click. */}
                    {suggestion ? (
                      <Button
                        type="button"
                        variant="link"
                        size="sm"
                        className="mt-1 h-auto max-w-44 justify-start p-0 text-xs"
                        disabled={pending}
                        title={`${suggestion.email} signs in with this employee's work email`}
                        onClick={() => act(linkEmployeeToMemberAction({ id: employee.id, user_id: suggestion.userId }))}
                      >
                        <span className="truncate">Link {suggestion.email}</span>
                      </Button>
                    ) : null}
                  </TableCell>
                ) : null}
                {canEdit ? (
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => openEdit(employee)}>
                        <Pencil className="size-4" />
                        Edit
                      </Button>
                      {showGoalsAction(canEdit, goals) ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={pending}
                          aria-label={`Goals for ${employee.name}`}
                          onClick={() => setGoalsFor(employee)}
                        >
                          <Target className="size-4" />
                          Goals
                        </Button>
                      ) : null}
                      {showDocuments ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={pending}
                          aria-label={`Documents for ${employee.name}`}
                          onClick={() => setDocumentsFor(employee)}
                        >
                          <FileText className="size-4" />
                          Documents
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={pending}
                        onClick={() =>
                          act(
                            setEmployeeStatusAction({
                              id: employee.id,
                              status: employee.status === 'active' ? 'inactive' : 'active',
                            }),
                          )
                        }
                      >
                        {employee.status === 'active' ? <UserX className="size-4" /> : <UserCheck className="size-4" />}
                        {employee.status === 'active' ? 'Deactivate' : 'Reactivate'}
                      </Button>
                      {confirmingId === employee.id ? (
                        <>
                          <Button
                            type="button"
                            variant="destructive"
                            size="sm"
                            disabled={pending}
                            onClick={() => {
                              setConfirmingId(null);
                              act(deleteEmployeeAction({ id: employee.id }));
                            }}
                          >
                            <Trash2 className="size-4" />
                            Delete for good
                          </Button>
                          <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => setConfirmingId(null)}>
                            Cancel
                          </Button>
                        </>
                      ) : (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          disabled={pending}
                          onClick={() => setConfirmingId(employee.id)}
                        >
                          <Trash2 className="size-4" />
                          Delete
                        </Button>
                      )}
                    </div>
                    {confirmingId === employee.id ? (
                      <p role="alert" className="mt-1 text-right text-xs text-destructive">
                        Their leave, claims, draft payslips and every other HR record are deleted too, including their documents, the files attached to them and their letters. This cannot be undone. Someone with a paid payslip cannot be deleted: make them inactive instead.
                      </p>
                    ) : null}
                  </TableCell>
                ) : null}
              </TableRow>
              );
            })}
            {shown.length === 0 ? (
              <TableRow>
                <TableCell colSpan={columns} className="py-8 text-center text-sm text-muted-foreground">
                  {employees.length === 0
                    ? canEdit
                      ? 'No employees yet. Add your first one above.'
                      : 'No employees have been added yet.'
                    : 'No employees match these filters.'}
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </div>
      <div className="flex items-center justify-between border-t px-4 py-3 text-sm text-muted-foreground">
        <span>
          {shown.length} of {employees.length} employees
        </span>
        <span>{employees.filter((employee) => employee.status === 'active').length} active</span>
      </div>

      <Dialog.Root
        open={formOpen}
        onOpenChange={(open) => {
          if (!open && !pending) {
            setCreating(false);
            setEditing(null);
            setError(null);
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
          <Dialog.Content className="fixed top-1/2 left-1/2 z-50 max-h-[90vh] w-[calc(100%-2rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border bg-background p-5 shadow-lg outline-none">
            <Dialog.Title className="text-base font-semibold">{editing ? 'Edit employee' : 'Add employee'}</Dialog.Title>
            <Dialog.Description className="mb-4 text-sm text-muted-foreground">
              {editing ? `Update ${editing.employee.name}’s record.` : 'Add someone to the staff directory.'}
            </Dialog.Description>
            {formOpen ? (
              <EmployeeForm
                key={editing?.employee.id ?? 'new'}
                initial={editing}
                departments={departments}
                employees={employees}
                showReportsTo={controls.reportsToField}
                reportsToResets={reportsToResets}
                disabled={pending}
                error={error}
                onCancel={() => {
                  setCreating(false);
                  setEditing(null);
                  setError(null);
                }}
                onSubmit={(input, changes, reportsTo) =>
                  act(editing ? saveEdit(editing.employee.id, input, changes, reportsTo) : saveNew(input, reportsTo))
                }
              />
            ) : null}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={showGoalsAction(canEdit, goals) && goalsFor !== null} onOpenChange={(open) => !open && setGoalsFor(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
          <Dialog.Content className="fixed top-1/2 left-1/2 z-50 max-h-[90vh] w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border bg-background p-5 shadow-lg outline-none">
            <Dialog.Title className="text-base font-semibold">{goalsFor ? `${goalsFor.name}’s goals` : 'Goals'}</Dialog.Title>
            <Dialog.Description className="mb-4 text-sm text-muted-foreground">
              Add, change or remove this employee’s goals.
            </Dialog.Description>
            {goalsFor && goals ? (
              <EmployeeGoals key={goalsFor.id} employeeId={goalsFor.id} name={goalsFor.name} goals={goals[goalsFor.id] ?? []} />
            ) : null}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={showDocuments && documentsFor !== null} onOpenChange={(open) => !open && setDocumentsFor(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
          <Dialog.Content className="fixed top-1/2 left-1/2 z-50 max-h-[90vh] w-[calc(100%-2rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border bg-background p-5 shadow-lg outline-none">
            <Dialog.Title className="text-base font-semibold">
              {documentsFor ? `${documentsFor.name}’s documents` : 'Documents'}
            </Dialog.Title>
            <Dialog.Description className="mb-4 text-sm text-muted-foreground">
              Add, change, replace or remove this employee’s documents, and ask them to acknowledge one.
            </Dialog.Description>
            {documentsFor && documents && orgId ? (
              <EmployeeDocuments
                key={documentsFor.id}
                orgId={orgId}
                employeeId={documentsFor.id}
                name={documentsFor.name}
                rows={documents[documentsFor.id] ?? []}
              />
            ) : null}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
