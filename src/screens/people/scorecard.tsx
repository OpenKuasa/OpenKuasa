import { ChartColumn, Radar, Users } from 'lucide-react';
import { BentoCard, BentoGrid, BentoStat } from '@/components/bento/bento';
import { BarGroup, RadarSpread, type Series } from '@/components/charts';
import { PageHeader } from '@/components/screen/page-header';
import { ScreenContainer } from '@/components/screen/screen-container';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { buildScorecardModel } from '@/lib/people/performance';
import { scoreCell, scorecardTiles, visibleScorecardRows } from '@/lib/people/reviews-announcements';
import { EmployeeCell, HR_ONLY, LOAD_FAILED, Muted, StatusPill, loadPeople } from './parts';

const COMPETENCY_SERIES: Series[] = [{ key: 'score', label: 'Average score', color: 'var(--chart-1)' }];
const DEPT_SERIES: Series[] = [{ key: 'score', label: 'Avg score', color: 'var(--chart-1)' }];

export default async function ScorecardScreen() {
  const { model } = await loadPeople('scorecard', async (data, _now, ctx) => {
    const [reviews, employees] = await Promise.all([data.listReviews(), data.listEmployees()]);
    return buildScorecardModel(reviews, employees, ctx.viewer);
  });
  const team = model?.team ?? true;

  const tiles = scorecardTiles(model);
  const rows = model ? visibleScorecardRows(model) : [];
  const span = tiles.length === 2 ? 'md:col-span-6' : 'md:col-span-4';

  return (
    <ScreenContainer>
      <PageHeader
        title="Scorecards"
        subtitle={team ? 'Performance scores out of 5 across the team' : 'Your performance scores out of 5'}
      />

      <BentoGrid>
        {tiles.map((tile, index) => (
          <BentoCard
            key={tile.label}
            tone={index === 0 ? 'primary' : 'default'}
            className={`col-span-2 ${span}`}
          >
            <BentoStat label={tile.label} value={tile.value} delta={tile.caption} deltaTone="flat" onPrimary={index === 0} />
          </BentoCard>
        ))}

        <BentoCard
          title={team ? 'Competencies' : 'Your competencies'}
          subtitle={team ? 'Team average per competency, out of 5' : 'Out of 5'}
          icon={Radar}
          className="col-span-2 md:col-span-6"
        >
          {!model ? (
            LOAD_FAILED
          ) : model.competencies.length === 0 ? (
            <Muted>No competency scores yet</Muted>
          ) : (
            <RadarSpread
              data={model.competencies.map((c) => ({ label: c.label, score: c.score }))}
              series={COMPETENCY_SERIES}
              height={260}
            />
          )}
        </BentoCard>
        <BentoCard
          title="Scores by department"
          subtitle="Average score out of 5"
          icon={ChartColumn}
          className="col-span-2 md:col-span-6"
        >
          {!model ? (
            LOAD_FAILED
          ) : !model.team ? (
            HR_ONLY
          ) : model.department_averages.length === 0 ? (
            <Muted>No scorecards yet</Muted>
          ) : (
            <BarGroup
              data={model.department_averages.map((d) => ({ label: d.department, score: d.average }))}
              series={DEPT_SERIES}
              horizontal
              height={260}
            />
          )}
        </BentoCard>

        <BentoCard
          title="Employee scorecards"
          subtitle={team ? 'Score and competencies, highest first' : 'Your records'}
          icon={Users}
          flush
          className="col-span-2 md:col-span-12"
        >
          {!model ? (
            LOAD_FAILED
          ) : rows.length === 0 ? (
            <Muted>No scorecards yet</Muted>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/40">
                    <TableHead>Employee</TableHead>
                    <TableHead>Period</TableHead>
                    <TableHead className="text-right">Score</TableHead>
                    <TableHead>Competencies</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell>
                        <EmployeeCell name={row.employee} />
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {row.period}
                        {row.draft ? (
                          <span className="ml-2">
                            <StatusPill tone="pending">Draft</StatusPill>
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right font-semibold tabular-nums">
                        {scoreCell(row.score)}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{row.competencies || '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}
