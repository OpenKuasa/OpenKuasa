import {
  BarChart3,
  ChevronDown,
  Filter,
  MapPin,
  PieChart,
  Plus,
  Search,
  Star,
  Users,
} from 'lucide-react';
import { ScreenContainer } from '@/components/screen/screen-container';
import { PageHeader } from '@/components/screen/page-header';
import { BentoGrid, BentoCard, BentoStat } from '@/components/bento/bento';
import { BarGroup, DonutStat, type Series, type Slice } from '@/components/charts';
import { LiveDot } from '@/components/ui/live-dot';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { can } from '@/lib/auth/permissions';
import { getViewer } from '@/lib/auth/viewer';
import { CandidateRowMenu, DeletionNotice } from '@/screens/hire/delete-dialog';
import { buildPoolModel, type PoolModel } from '@/lib/hire/lists';
import { LOAD_FAILED, Muted, loadHire, topSlices } from '@/screens/hire/parts';

type Candidate = PoolModel['rows'][number];
type Status = Candidate['status'];

const SKILL_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)'];

const SOURCE_SERIES: Series[] = [
  { key: 'count', label: 'Candidates', color: 'var(--chart-2)' },
];

const STATUS_TONE: Record<Status, string> = {
  Available: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  Shortlisted: 'bg-primary/10 text-primary',
  'Re-engaged': 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  Passive: 'bg-muted text-muted-foreground',
};

function StatusPill({ status }: { status: Status }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium',
        STATUS_TONE[status],
      )}
    >
      <LiveDot active={status !== 'Passive'} />
      {status}
    </span>
  );
}

function Rating({ value }: { value: number | null }) {
  if (value === null) return <span className="text-xs text-muted-foreground">—</span>;
  const filled = Math.round(value);
  return (
    <span className="inline-flex items-center gap-1" title={`Rated ${value} of 5`}>
      <span className="flex">
        {Array.from({ length: 5 }).map((_, i) => (
          <Star
            key={i}
            className={cn(
              'size-3.5',
              i < filled
                ? 'fill-amber-400 text-amber-400'
                : 'fill-transparent text-muted-foreground/40',
            )}
          />
        ))}
      </span>
      <span className="text-xs font-medium tabular-nums text-muted-foreground">
        {value.toFixed(1)}
      </span>
    </span>
  );
}

export default async function TalentPoolScreen() {
  const [{ model }, viewer] = await Promise.all([loadHire('talent-pool', (data) => buildPoolModel(data)), getViewer()]);
  // Worked out once for the screen. The action checks again on the server, so this only decides what is drawn.
  const canEdit = !viewer.isDemo && can(viewer.role, 'edit-data');
  const capped = model ? model.size > model.rows.length : false;
  const roleSlices: Slice[] = topSlices(
    model?.byTitle ?? [],
    (r) => r.value,
    (r) => r.label,
  ).map((slice, index) => ({ ...slice, color: SKILL_COLORS[index % SKILL_COLORS.length] }));
  const statusCount = (key: Status) =>
    model ? (model.statusCounts.find((s) => s.key === key)?.value ?? 0) : '—';

  return (
    <ScreenContainer>
      <PageHeader
        className="mb-3"
        title="Talent Pool"
        subtitle="Saved candidates for future roles, Saudara."
        actions={
          <Button size="sm" disabled title="Coming soon">
            <Plus className="size-4" />
            Add to Pool
          </Button>
        }
      />

      <BentoGrid>
        {/* KPI row: every figure is counted over the whole pool */}
        <BentoCard tone="primary" className="col-span-1 md:col-span-3">
          <BentoStat
            label="Talent pool size"
            value={model ? model.size.toLocaleString() : '—'}
            onPrimary
          />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat label="Shortlisted" value={statusCount('Shortlisted')} />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat label="Passive" value={statusCount('Passive')} />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat label="Re-engaged" value={statusCount('Re-engaged')} />
        </BentoCard>

        {/* Skill mix + source breakdown */}
        <BentoCard
          title="Talent by skill / role"
          subtitle="Across the pool"
          icon={PieChart}
          className="col-span-2 md:col-span-4"
        >
          {!model ? LOAD_FAILED : model.size === 0 ? (
            <Muted>No one in the talent pool yet</Muted>
          ) : (
            <DonutStat
              data={roleSlices}
              height={240}
              centerValue={model.size.toLocaleString()}
              centerLabel="candidates"
            />
          )}
        </BentoCard>
        <BentoCard
          title="Candidates by source"
          subtitle="Where talent comes from"
          icon={BarChart3}
          className="col-span-2 md:col-span-8"
        >
          {!model ? LOAD_FAILED : model.size === 0 ? (
            <Muted>No one in the talent pool yet</Muted>
          ) : (
            <BarGroup
              data={model.bySource.slice(0, 6).map((r) => ({ label: r.label, count: r.value }))}
              series={SOURCE_SERIES}
              horizontal
              height={240}
            />
          )}
        </BentoCard>

        {/* Candidate table */}
        <BentoCard
          title="Pool candidates"
          subtitle="Most recently added first"
          icon={Users}
          flush
          className="col-span-2 md:col-span-12"
        >
          {/* Where "Deleted …" is said: the row it was said about has gone. Only for someone who may edit. */}
          {canEdit ? <DeletionNotice className="px-4 pb-2" /> : null}
          <div className="flex flex-wrap items-center gap-2 px-4">
            <div className="relative w-full sm:max-w-xs">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search by name or skill…"
                className="h-8 pl-8 text-sm"
                disabled
                title="Coming soon"
              />
            </div>
            <Select defaultValue="all" disabled>
              <SelectTrigger size="sm" title="Coming soon" className="w-full sm:w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All roles</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" disabled title="Coming soon">
              <Filter className="size-4" />
              Filter
            </Button>
            <Button variant="outline" size="sm" disabled title="Coming soon">
              All sources
              <ChevronDown className="size-4" />
            </Button>
          </div>
          {!model ? LOAD_FAILED : model.rows.length === 0 ? (
            <Muted>No one in the talent pool yet</Muted>
          ) : (
          <>
            <div className="mt-3 overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/40">
                    <TableHead>Candidate</TableHead>
                    <TableHead>Skills</TableHead>
                    <TableHead>Location</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead>Rating</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {model.rows.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <div className="grid size-9 shrink-0 place-items-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
                            {c.name.charAt(0)}
                          </div>
                          <div className="min-w-0">
                            <p className="truncate font-medium">{c.name}</p>
                            <p className="truncate text-xs text-muted-foreground">
                              {c.title}
                            </p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex max-w-[220px] flex-wrap gap-1">
                          {c.skills.map((s) => (
                            <Badge key={s} variant="secondary">
                              {s}
                            </Badge>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        <span className="flex items-center gap-1 text-sm text-muted-foreground">
                          <MapPin className="size-3.5" />
                          {c.location}
                        </span>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-sm">
                        {c.source}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        <Rating value={c.rating} />
                      </TableCell>
                      <TableCell>
                        <StatusPill status={c.status} />
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-2">
                          <Button variant="outline" size="sm" disabled title="Coming soon">
                            Move to pipeline
                          </Button>
                          {/* The candidate's id and name, nothing else. Only for someone who may edit; the action checks again. */}
                          {canEdit ? <CandidateRowMenu candidate={{ id: c.id, name: c.name }} /> : null}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="border-t px-4 py-3 text-sm text-muted-foreground">
              {capped ? (
                <span className="text-xs text-muted-foreground">
                  Showing the newest {model.rows.length} of {model.size.toLocaleString()}
                </span>
              ) : (
                `Showing ${model.rows.length} candidates`
              )}
            </div>
          </>
          )}
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}
