import { ChartColumn, PieChart, Users } from 'lucide-react';
import { BentoCard, BentoGrid, BentoStat } from '@/components/bento/bento';
import { BarGroup, DonutStat, type Series, type Slice } from '@/components/charts';
import { PageHeader } from '@/components/screen/page-header';
import { ScreenContainer } from '@/components/screen/screen-container';
import { ReviewDialog } from '@/components/people/review-form';
import { ReviewRowControls } from '@/components/people/review-row-controls';
import { RequestRow } from '@/components/people/request-row';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatDate, todayInMalaysia } from '@/lib/people/dates';
import { RATING_LABEL, buildReviewsModel } from '@/lib/people/performance';
import { reviewPeriods } from '@/lib/people/performance-forms';
import {
  competencyLine,
  reviewMark,
  reviewTiles,
  scoreCell,
  reviewScreenControls,
  visibleReviewRows,
} from '@/lib/people/reviews-announcements';
import { EmployeeCell, HR_ONLY, LOAD_FAILED, Muted, StatusPill, loadPeople } from './parts';

const DEPT_SERIES: Series[] = [{ key: 'rating', label: 'Avg score', color: 'var(--chart-1)' }];
const RATING_TONE = { exceeds: 'good', meets: 'pending', below: 'bad' } as const;

export default async function ReviewScoresScreen() {
  const { model: loaded, viewer } = await loadPeople('review-scores', async (data, now, ctx) => {
    const [reviews, employees] = await Promise.all([data.listReviews(), data.listEmployees()]);
    return {
      reviews: buildReviewsModel(reviews, employees, ctx.viewer),
      people: employees.filter((e) => e.status === 'active').map((e) => ({ id: e.id, name: e.name })),
      periods: reviewPeriods(todayInMalaysia(now)),
    };
  });
  const model = loaded?.reviews ?? null;
  const dash = '—';
  const team = model?.team ?? true;
  // The controls that change a review are drawn for an owner or admin outside the demo only.
  const editing = reviewScreenControls(viewer, loaded !== null).write;
  const rows = model ? visibleReviewRows(model) : [];
  const reviewed = rows.map((r) => ({ id: r.id, employee_id: r.employee_id, period: r.period }));

  const tiles = reviewTiles(model);
  const ratings = model?.ratings ?? null;
  const span = tiles.length === 2 ? 'md:col-span-6' : 'md:col-span-3';

  const mix: Slice[] = ratings
    ? [
        { key: 'exceeds', label: RATING_LABEL.exceeds, value: ratings.exceeds, color: 'var(--chart-2)' },
        { key: 'meets', label: RATING_LABEL.meets, value: ratings.meets, color: 'var(--chart-1)' },
        { key: 'below', label: RATING_LABEL.below, value: ratings.below, color: 'var(--chart-4)' },
      ]
    : [];
  const rated = ratings ? ratings.exceeds + ratings.meets + ratings.below : 0;

  return (
    <ScreenContainer>
      <PageHeader
        title="Review Scores"
        subtitle={team ? 'Performance review results across the team' : 'Your performance review results'}
        actions={
          editing && loaded ? (
            <ReviewDialog employees={loaded.people} periods={loaded.periods} reviewed={reviewed} />
          ) : null
        }
      />

      <BentoGrid>
        {tiles.map((tile, index) => (
          <BentoCard
            key={tile.label}
            tone={index === 0 ? 'primary' : 'default'}
            className={`col-span-1 ${span}`}
          >
            <BentoStat label={tile.label} value={tile.value} delta={tile.caption} deltaTone="flat" onPrimary={index === 0} />
          </BentoCard>
        ))}

        <BentoCard
          title="Rating distribution"
          subtitle="Reviews by rating"
          icon={PieChart}
          className="col-span-2 md:col-span-4"
        >
          {!model ? (
            LOAD_FAILED
          ) : !model.team ? (
            HR_ONLY
          ) : rated === 0 ? (
            <Muted>No reviews yet</Muted>
          ) : (
            <DonutStat data={mix} height={240} centerValue={String(rated)} centerLabel="rated" />
          )}
        </BentoCard>
        <BentoCard
          title="Average score by department"
          subtitle="Review score out of 5"
          icon={ChartColumn}
          className="col-span-2 md:col-span-8"
        >
          {!model ? (
            LOAD_FAILED
          ) : !model.team ? (
            HR_ONLY
          ) : model.department_averages.length === 0 ? (
            <Muted>No reviews yet</Muted>
          ) : (
            <BarGroup
              data={model.department_averages.map((d) => ({ label: d.department, rating: d.average }))}
              series={DEPT_SERIES}
              horizontal
              height={240}
            />
          )}
        </BentoCard>

        <BentoCard
          title="Review scores"
          subtitle={team ? 'Score, rating and reviewer, highest first' : 'Your records'}
          icon={Users}
          flush
          className="col-span-2 md:col-span-12"
        >
          {!model ? (
            LOAD_FAILED
          ) : rows.length === 0 ? (
            <Muted>No reviews yet</Muted>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/40">
                    <TableHead>Employee</TableHead>
                    <TableHead>Period</TableHead>
                    {team ? <TableHead>Status</TableHead> : null}
                    <TableHead>Rating</TableHead>
                    <TableHead className="text-right">Score</TableHead>
                    <TableHead>Competencies</TableHead>
                    <TableHead>Reviewer</TableHead>
                    <TableHead>Reviewed on</TableHead>
                    <TableHead>Comment</TableHead>
                    {editing ? <TableHead>Actions</TableHead> : null}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => {
                    const mark = reviewMark(row, team);
                    const cells = (
                      <>
                        <TableCell>
                          <EmployeeCell name={row.employee} />
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-muted-foreground">{row.period}</TableCell>
                        {team ? (
                          <TableCell>
                            <StatusPill tone={mark === 'Draft' ? 'pending' : 'good'}>{mark}</StatusPill>
                          </TableCell>
                        ) : null}
                        <TableCell>
                          <StatusPill tone={RATING_TONE[row.rating]}>{RATING_LABEL[row.rating]}</StatusPill>
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-right font-semibold tabular-nums">
                          {scoreCell(row.score)}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                          {competencyLine(row.competencies)}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-muted-foreground">{row.reviewer ?? dash}</TableCell>
                        <TableCell className="whitespace-nowrap text-muted-foreground">
                          {row.reviewed_at ? formatDate(row.reviewed_at) : dash}
                        </TableCell>
                        <TableCell className="min-w-48 max-w-sm whitespace-normal text-muted-foreground">
                          {row.comment || dash}
                        </TableCell>
                        {editing && loaded ? (
                          <TableCell>
                            <ReviewRowControls
                              review={{
                                id: row.id,
                                employee_id: row.employee_id,
                                employee: row.employee,
                                period: row.period,
                                rating: row.rating,
                                comment: row.comment,
                                competencies: row.competencies,
                              }}
                              draft={row.draft}
                              employees={loaded.people}
                              periods={loaded.periods}
                              reviewed={reviewed.filter((r) => r.employee_id === row.employee_id)}
                            />
                          </TableCell>
                        ) : null}
                      </>
                    );
                    // The controls' questions open in a row under this one, which needs a row that can hold them.
                    return editing ? (
                      <RequestRow key={row.id} columns={team ? 10 : 9}>
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
      </BentoGrid>
    </ScreenContainer>
  );
}
