import { BriefcaseBusiness, Building2, ChartColumn, PieChart, UserPlus } from 'lucide-react';
import { BentoCard, BentoGrid, BentoStat } from '@/components/bento/bento';
import { BarGroup, DonutStat, type Series, type Slice } from '@/components/charts';
import { DepartmentsManager } from '@/components/people/departments-manager';
import { EmployeesTable } from '@/components/people/employees-table';
import { PageHeader } from '@/components/screen/page-header';
import { ScreenContainer } from '@/components/screen/screen-container';
import { todayInMalaysia } from '@/lib/people/dates';
import { employeeDocumentRows, showsOwnerDocumentControls } from '@/lib/people/documents-screens';
import { buildEmployeesModel } from '@/lib/people/employees';
import { type GoalLike, goalsByEmployee } from '@/lib/people/goals-training';
import { type WorkspaceMember, listWorkspaceMembers } from '@/lib/people/members';
import { DEPARTMENT_COLORS, LOAD_FAILED, Muted, loadPeople } from './parts';

const TENURE_SERIES: Series[] = [{ key: 'count', label: 'Employees', color: 'var(--chart-2)' }];

/**
 * The staff directory. Every member of the workspace sees the list (directory
 * details only: the database keeps pay and identity details in another table).
 * An owner or admin also adds, edits, deactivates and deletes employees,
 * manages departments, and links an employee record to a member's account.
 */
export default async function EmployeesScreen() {
  const { model, viewer } = await loadPeople('employees', async (data, now, ctx) => {
    const [employees, departments] = await Promise.all([data.listEmployees(), data.listDepartments()]);
    // Only someone who can link accounts needs the member list. Without it the screen still works.
    let members: WorkspaceMember[] = [];
    if (ctx.viewer.isHr && ctx.orgId) {
      try {
        members = await listWorkspaceMembers(ctx.client, ctx.orgId);
      } catch (error) {
        console.error('[people/employees] could not list members:', error instanceof Error ? error.message : 'error');
      }
    }
    // Each employee's goals, only for someone who can open them from the "Goals" action. A failed read hides the action.
    let goals: Record<string, GoalLike[]> | null = null;
    if (showsOwnerDocumentControls(ctx.viewer)) {
      try {
        goals = goalsByEmployee(await data.listGoals());
      } catch (error) {
        console.error('[people/employees] could not list goals:', error instanceof Error ? error.message : 'error');
      }
    }
    // Each employee's documents, only for an owner or admin outside the demo (null for anyone else, and nothing is
    // read for them). A failed read hides the action.
    let documents: ReturnType<typeof employeeDocumentRows> = null;
    if (showsOwnerDocumentControls(ctx.viewer)) {
      try {
        documents = employeeDocumentRows({
          documents: await data.listDocuments(),
          employeeIds: employees.map((employee) => employee.id),
          today: todayInMalaysia(now),
          viewer: ctx.viewer,
        });
      } catch (error) {
        console.error('[people/employees] could not list documents:', error instanceof Error ? error.message : 'error');
      }
    }
    return { ...buildEmployeesModel(employees, departments, todayInMalaysia(now)), members, goals, documents, orgId: ctx.orgId };
  });

  // Owner or admin, and not the demo workspace (the server refuses changes there). The actions and the database both check again.
  const canEdit = showsOwnerDocumentControls(viewer);
  const totals = model?.totals;
  const departmentMix: Slice[] = (model?.by_department ?? []).map((d, index) => ({
    key: d.department,
    label: d.department,
    value: d.headcount,
    color: DEPARTMENT_COLORS[index % DEPARTMENT_COLORS.length],
  }));
  const dash = '—';

  return (
    <ScreenContainer>
      <PageHeader
        title="Employees"
        subtitle={
          totals ? `${totals.headcount} active · ${totals.departments} departments` : 'Your staff directory'
        }
      />

      <BentoGrid>
        <BentoCard tone="primary" className="col-span-1 md:col-span-3">
          <BentoStat label="Headcount" value={totals ? totals.headcount : dash} onPrimary />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat label="Departments" value={totals ? totals.departments : dash} />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat label="New joiners" value={totals ? totals.new_joiners_90d : dash} delta="last 90 days" deltaTone="flat" />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat
            label="Average tenure"
            value={totals?.avg_tenure_years == null ? dash : `${totals.avg_tenure_years} yr`}
            delta={totals && totals.inactive > 0 ? `${totals.inactive} inactive` : undefined}
            deltaTone="flat"
          />
        </BentoCard>

        <BentoCard
          title="Headcount by department"
          subtitle="Active staff"
          icon={PieChart}
          className="col-span-2 md:col-span-5"
        >
          {!model ? (
            LOAD_FAILED
          ) : departmentMix.length === 0 ? (
            <Muted>No employees yet</Muted>
          ) : (
            <DonutStat data={departmentMix} height={240} centerValue={String(model.totals.headcount)} centerLabel="employees" />
          )}
        </BentoCard>
        <BentoCard
          title="Headcount by tenure"
          subtitle="Years since joining"
          icon={ChartColumn}
          className="col-span-2 md:col-span-7"
        >
          {!model ? (
            LOAD_FAILED
          ) : model.tenure.every((band) => band.count === 0) ? (
            <Muted>No join dates recorded yet</Muted>
          ) : (
            <BarGroup data={model.tenure} series={TENURE_SERIES} height={240} />
          )}
        </BentoCard>

        <BentoCard
          title="Employment mix"
          subtitle="Active staff by type"
          icon={BriefcaseBusiness}
          className="col-span-2 md:col-span-5"
        >
          {!model ? (
            LOAD_FAILED
          ) : (
            <ul className="divide-y text-sm">
              {model.employment.map((entry) => (
                <li key={entry.type} className="flex items-center justify-between py-2">
                  <span>{entry.label}</span>
                  <span className="tabular-nums text-muted-foreground">{entry.count}</span>
                </li>
              ))}
            </ul>
          )}
        </BentoCard>
        <BentoCard
          title="Departments"
          subtitle={canEdit ? 'Add, rename or delete' : 'How the team is organised'}
          icon={Building2}
          className="col-span-2 md:col-span-7"
        >
          {!model ? LOAD_FAILED : <DepartmentsManager departments={model.departments} canEdit={canEdit} />}
        </BentoCard>

        <BentoCard
          title="All employees"
          subtitle="Staff directory"
          icon={UserPlus}
          flush
          className="col-span-2 md:col-span-12"
        >
          {!model ? (
            LOAD_FAILED
          ) : (
            <EmployeesTable
              employees={model.employees}
              departments={model.departments}
              members={model.members}
              goals={model.goals}
              documents={model.documents}
              orgId={model.orgId}
              canEdit={canEdit}
            />
          )}
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}
