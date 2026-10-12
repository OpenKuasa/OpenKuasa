import { FileText, LayoutTemplate, PieChart } from 'lucide-react';
import { BentoCard, BentoGrid, BentoStat } from '@/components/bento/bento';
import { DonutStat } from '@/components/charts';
import { LetterDialog } from '@/components/people/letter-form';
import { LetterheadProvider } from '@/components/people/letter-head';
import { LetterRowControls } from '@/components/people/letter-row-controls';
import { LetterViewDialog } from '@/components/people/letter-view';
import { RequestRow } from '@/components/people/request-row';
import { TemplatesSection } from '@/components/people/templates-section';
import { PageHeader } from '@/components/screen/page-header';
import { ScreenContainer } from '@/components/screen/screen-container';
import { Badge } from '@/components/ui/badge';
import { LiveDot } from '@/components/ui/live-dot';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { hasSupabaseEnv } from '@/lib/auth/viewer';
import { todayInMalaysia } from '@/lib/people/dates';
import { buildLetterTemplatesModel, buildLettersModel } from '@/lib/people/documents';
import { plainPreview } from '@/lib/people/letter-marks';
import { getLetterhead } from '@/lib/people/letterhead-data';
import { lettersScreenControls, visibleLetterRows } from '@/lib/people/letters-screens';
import { EmployeeCell, HR_ONLY, LOAD_FAILED, Muted, StatusPill, loadPeople } from './parts';

const SAMPLE_WORKSPACE = 'Sample company';

/**
 * HR letters. Owners and admins write, issue and pull back letters and keep the templates; anyone else sees the
 * issued letters addressed to them (awaiting acknowledgement first), which the database has already narrowed. The
 * demo sees the team's letters and templates with no control to change anything.
 */
export default async function LettersScreen() {
  const { model: loaded, viewer } = await loadPeople('letters', async (data, now, ctx) => {
    const team = ctx.viewer.isHr || ctx.viewer.isDemo;
    const [letters, templates, employees, letterhead] = await Promise.all([
      data.listLetters(),
      team ? data.listLetterTemplates() : Promise.resolve([]),
      ctx.viewer.isHr && !ctx.viewer.isDemo ? data.listEmployees() : Promise.resolve([]),
      // One read of the workspace's details: the name for the letters and the letterhead for the view and the previews.
      hasSupabaseEnv() && ctx.orgId
        ? getLetterhead({ client: ctx.client, orgId: ctx.orgId, isDemo: ctx.viewer.isDemo })
        : Promise.resolve(null),
    ]);
    const hasWorkspace = hasSupabaseEnv() && Boolean(ctx.orgId);
    return {
      letters: buildLettersModel(letters, ctx.viewer, todayInMalaysia(now)),
      templates: buildLetterTemplatesModel(templates, ctx.viewer),
      people: employees.filter((e) => e.status === 'active').map((e) => ({ id: e.id, name: e.name })),
      letterhead,
      workspaceName: letterhead ? letterhead.name : hasWorkspace ? '' : SAMPLE_WORKSPACE,
    };
  });

  const model = loaded?.letters ?? null;
  const templates = loaded?.templates ?? null;
  const workspaceName = loaded?.workspaceName ?? '';
  const letterhead = loaded?.letterhead ?? null;
  // The controls that change a letter or a template are drawn for an owner or admin outside the demo only.
  const editing = lettersScreenControls(viewer, loaded !== null).write;
  const rows = model ? visibleLetterRows(model) : [];
  const totals = model?.totals ?? null;
  const dash = '—';
  const templateOptions =
    templates && templates.allowed ? templates.rows.map((t) => ({ id: t.id, name: t.name, type_label: t.type_label })) : [];

  return (
    <LetterheadProvider head={letterhead} workspaceName={workspaceName}>
    <ScreenContainer>
      <PageHeader
        className="mb-3"
        title="HR Letters"
        subtitle={model && !model.team ? 'Your letters' : 'Letters to employees'}
        actions={editing && loaded ? <LetterDialog employees={loaded.people} templates={templateOptions} /> : null}
      />

      <BentoGrid>
        {model && !model.team ? null : (
          <>
            <BentoCard tone="primary" className="col-span-1 md:col-span-4">
              <BentoStat label="Issued this year" value={totals ? totals.issued_this_year : dash} onPrimary />
            </BentoCard>
            <BentoCard className="col-span-1 md:col-span-4">
              <BentoStat label="Drafts" value={totals ? totals.drafts : dash} />
            </BentoCard>
            <BentoCard className="col-span-2 md:col-span-4">
              <BentoStat label="Issued this month" value={totals ? totals.issued_this_month : dash} />
            </BentoCard>
            <BentoCard
              title="Letters by type"
              subtitle="Issued this year"
              icon={PieChart}
              className="col-span-2 md:col-span-12"
            >
              {!model ? (
                LOAD_FAILED
              ) : !model.by_type ? (
                HR_ONLY
              ) : model.by_type.length === 0 ? (
                <Muted>No letters issued this year</Muted>
              ) : (
                <DonutStat
                  data={model.by_type}
                  height={240}
                  centerValue={String(totals?.issued_this_year ?? 0)}
                  centerLabel="issued"
                />
              )}
            </BentoCard>
          </>
        )}

        <BentoCard
          title={model && !model.team ? 'Your letters' : 'Recent letters'}
          subtitle={
            model && !model.team
              ? 'Newest first, letters waiting for you at the top'
              : 'Drafts first · a pulsing dot marks a draft in progress'
          }
          icon={FileText}
          flush
          className="col-span-2 md:col-span-12"
        >
          {!model ? (
            LOAD_FAILED
          ) : rows.length === 0 ? (
            <Muted>{model.team ? 'No letters yet' : 'No letters addressed to you yet'}</Muted>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/40">
                    <TableHead>Letter</TableHead>
                    <TableHead>Employee</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => {
                    const cells = (
                      <>
                        <TableCell className="whitespace-nowrap font-medium">{row.title}</TableCell>
                        <TableCell>
                          <EmployeeCell name={row.employee_name} />
                        </TableCell>
                        <TableCell>
                          <Badge variant="secondary">{row.type_label}</Badge>
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-muted-foreground">{row.date_label}</TableCell>
                        <TableCell>
                          <span className="flex flex-wrap items-center gap-2">
                            <LiveDot active={row.status === 'draft'} />
                            <StatusPill tone={row.status === 'issued' ? 'good' : 'pending'}>
                              {row.status === 'issued' ? 'Issued' : 'Draft'}
                            </StatusPill>
                            {row.status === 'issued' && row.awaiting_acknowledgement ? (
                              <StatusPill tone="pending">Awaiting acknowledgement</StatusPill>
                            ) : null}
                            {row.status === 'issued' && row.acknowledged_label ? (
                              <span className="text-xs text-muted-foreground">{row.acknowledged_label}</span>
                            ) : null}
                          </span>
                        </TableCell>
                        <TableCell>
                          {editing ? (
                            <LetterRowControls letter={row} workspaceName={workspaceName} />
                          ) : (
                            <LetterViewDialog letter={row} workspaceName={workspaceName} />
                          )}
                        </TableCell>
                      </>
                    );
                    return editing ? (
                      <RequestRow key={row.id} columns={6}>
                        {cells}
                      </RequestRow>
                    ) : (
                      <TableRow key={row.id}>{cells}</TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </BentoCard>

        {templates && templates.allowed ? (
          <BentoCard
            title="Templates"
            subtitle="Starting points for letters, with the employee's details filled in"
            icon={LayoutTemplate}
            className="col-span-2 md:col-span-12"
          >
            {editing ? (
              <TemplatesSection rows={templates.rows} />
            ) : templates.rows.length === 0 ? (
              <Muted>No templates yet</Muted>
            ) : (
              <ul className="divide-y">
                {templates.rows.map((t) => (
                  <li key={t.id} className="space-y-1 py-3 first:pt-0 last:pb-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-semibold">{t.name}</h3>
                      <Badge variant="secondary">{t.type_label}</Badge>
                      <Badge variant="outline">{t.lang_label}</Badge>
                    </div>
                    <p className="text-sm text-muted-foreground">{t.title}</p>
                    <p className="line-clamp-3 whitespace-pre-line text-xs text-muted-foreground">{plainPreview(t.body)}</p>
                  </li>
                ))}
              </ul>
            )}
          </BentoCard>
        ) : null}
      </BentoGrid>
    </ScreenContainer>
    </LetterheadProvider>
  );
}
