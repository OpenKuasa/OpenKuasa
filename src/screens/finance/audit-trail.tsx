import Link from 'next/link';
import { Activity, PieChart, ScrollText, Search } from 'lucide-react';
import { ScreenContainer } from '@/components/screen/screen-container';
import { PageHeader } from '@/components/screen/page-header';
import { BentoGrid, BentoCard, BentoStat } from '@/components/bento/bento';
import { AreaTrend, DonutStat, Sparkline, type Series, type Slice } from '@/components/charts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { getViewer, hasSupabaseEnv } from '@/lib/auth/viewer';
import {
  AUDIT_ENTITY_TYPES,
  AUDIT_PERIODS,
  AUDIT_SUMMARY_DAYS,
  buildAuditSummary,
  listFinanceAudit,
  parseAuditFilters,
  readAuditSummaryRows,
  type AuditEntry,
  type AuditFilters,
  type AuditSummary,
} from '@/lib/finance/audit';
import { money, rm } from '@/lib/finance/format';
import { displayDate } from '@/lib/finance/view-helpers';
import { addDays, clockTime, malaysiaDate, todayInMalaysia } from '@/lib/people/dates';
import { createClient } from '@/lib/supabase/server';
import { SAMPLE_AUDIT_ENTRIES, SAMPLE_TODAY } from './audit-sample';

const ACTIVITY_SERIES: Series[] = [{ key: 'events', label: 'Events', color: 'var(--chart-1)' }];
const SLICE_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-5)', 'var(--chart-3)', 'var(--chart-4)', 'var(--muted-foreground)'];

const CANT_LOAD = "Couldn't load the audit trail — please refresh";
const STARTS = 'The audit trail starts on 23 Oct 2026; earlier changes were not recorded.';
const NOTHING_YET = `Nothing recorded yet. ${STARTS}`;
const NO_MATCH = 'No events match these filters.';
const DEFAULT_PERIOD = parseAuditFilters({}).period;
const DEFAULT_PERIOD_DAYS = AUDIT_PERIODS.find((p) => p.value === DEFAULT_PERIOD)?.days ?? AUDIT_SUMMARY_DAYS;
const NOTHING_IN_PERIOD = `Nothing recorded in the last ${DEFAULT_PERIOD_DAYS} days. ${STARTS}`;
/** The KPI strip and the charts count every finance event of these days, whatever the table's filters. */
const SUMMARY_SPAN = `Last ${AUDIT_SUMMARY_DAYS} days`;

const SELECT_CLASS =
  'h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 sm:w-44';

type Loaded = { entries: AuditEntry[]; nextBefore: string | null; summary: AuditSummary };

const toSummaryRows = (entries: AuditEntry[]) =>
  entries.map((e) => ({ created_at: e.createdAt, entity_type: e.entityType, actor_name: e.actorName, event: e.details.event }));

/** Without a database: the sample log, narrowed by the same filters the database applies (search: the target only). */
function sampleLoad(filters: AuditFilters): Loaded {
  const days = AUDIT_PERIODS.find((p) => p.value === filters.period)?.days ?? null;
  const from = days === null ? null : addDays(SAMPLE_TODAY, -days);
  const q = filters.q.toLowerCase();
  const entries = SAMPLE_AUDIT_ENTRIES.filter(
    (e) =>
      (!filters.type || e.entityType === filters.type) &&
      (!filters.actor || e.actorName === filters.actor) &&
      (from === null || malaysiaDate(e.createdAt) >= from) &&
      (!q || (e.target ?? '').toLowerCase().includes(q)),
  );
  return { entries, nextBefore: null, summary: buildAuditSummary(toSummaryRows(SAMPLE_AUDIT_ENTRIES), SAMPLE_TODAY) };
}

/** The log page and the summary; null when either could not be read. */
async function load(filters: AuditFilters): Promise<Loaded | null> {
  if (!hasSupabaseEnv()) return sampleLoad(filters);
  try {
    const viewer = await getViewer();
    const ctx = { client: await createClient(), orgId: viewer.orgId };
    const [page, rows] = await Promise.all([listFinanceAudit(ctx, filters), readAuditSummaryRows(ctx)]);
    return { ...page, summary: buildAuditSummary(rows, todayInMalaysia(new Date())) };
  } catch (error) {
    console.error('[finance] the audit trail could not be read:', error);
    return null;
  }
}

/** What an empty table says: nothing at all, nothing in the default period, or nothing matching the filters. */
function emptyMessage(f: AuditFilters): string {
  const narrowed = f.type !== null || f.actor !== null || f.q !== '' || f.before !== null;
  if (!narrowed && f.period === 'all') return NOTHING_YET;
  if (!narrowed && f.period === DEFAULT_PERIOD) return NOTHING_IN_PERIOD;
  return NO_MATCH;
}

/** The link to the next older page, keeping the filters. */
function olderHref(f: AuditFilters, before: string) {
  const p = new URLSearchParams();
  if (f.type) p.set('type', f.type);
  if (f.actor) p.set('actor', f.actor);
  if (f.period !== DEFAULT_PERIOD) p.set('period', f.period);
  if (f.q) p.set('q', f.q);
  p.set('before', before);
  return `/finance/audit-trail?${p.toString()}`;
}

function Details({ entry }: { entry: AuditEntry }) {
  const { party, amount, amount_myr: amountMyr, currency } = entry.details;
  const foreign = !!currency && currency !== 'MYR';
  const parts: string[] = [];
  if (party) parts.push(party);
  if (typeof amountMyr === 'number') {
    parts.push(`${rm(amountMyr)}${foreign && typeof amount === 'number' ? ` (${money(amount, currency)})` : ''}`);
  } else if (typeof amount === 'number') {
    parts.push(money(amount, foreign ? currency : 'MYR'));
  }
  return <>{parts.join(' · ')}</>;
}

export default async function AuditTrailScreen({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = searchParams ? await searchParams : {};
  const filters = parseAuditFilters(params);
  const data = await load(filters);

  return (
    <ScreenContainer>
      <PageHeader title="Audit Trail" subtitle="Every change to the books, logged for you." />

      {data === null ? (
        <BentoGrid>
          <BentoCard className="col-span-2 md:col-span-12">
            <p className="text-sm text-muted-foreground">{CANT_LOAD}</p>
          </BentoCard>
        </BentoGrid>
      ) : (
        <AuditBody data={data} filters={filters} />
      )}
    </ScreenContainer>
  );
}

function AuditBody({ data, filters }: { data: Loaded; filters: AuditFilters }) {
  const { entries, nextBefore, summary } = data;
  const trend = summary.daily.map((d) => ({ label: d.label, events: d.count }));
  const slices: Slice[] = summary.byType.map((t, i) => ({
    key: t.type,
    label: t.label,
    value: t.count,
    color: SLICE_COLORS[i % SLICE_COLORS.length],
  }));
  const typeLabel = new Map(AUDIT_ENTITY_TYPES.map((t) => [t.value, t]));
  const total = summary.byType.reduce((n, t) => n + t.count, 0);

  return (
    <BentoGrid>
      <BentoCard tone="primary" className="col-span-1 md:col-span-3">
        <BentoStat
          label="Events today"
          value={String(summary.today)}
          onPrimary
          chart={<Sparkline data={summary.daily.map((d) => d.count)} color="var(--primary-foreground)" height={36} />}
        />
      </BentoCard>
      <BentoCard className="col-span-1 md:col-span-3">
        <BentoStat label="This week" value={String(summary.week)} />
      </BentoCard>
      <BentoCard className="col-span-1 md:col-span-3">
        <BentoStat label="Voids this month" value={String(summary.voidsThisMonth)} />
      </BentoCard>
      <BentoCard className="col-span-1 md:col-span-3">
        <BentoStat label="Deletions this month" value={String(summary.deletionsThisMonth)} />
      </BentoCard>

      <BentoCard
        title="Activity over time"
        subtitle={`${SUMMARY_SPAN} · all documents and people`}
        icon={Activity}
        className="col-span-2 md:col-span-8"
      >
        <AreaTrend data={trend} series={ACTIVITY_SERIES} height={240} />
      </BentoCard>
      <BentoCard title="By document type" subtitle={`${SUMMARY_SPAN} · all documents and people`} icon={PieChart} className="col-span-2 md:col-span-4">
        {slices.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing recorded in the last {AUDIT_SUMMARY_DAYS} days.</p>
        ) : (
          <DonutStat data={slices} height={240} centerValue={String(total)} centerLabel="events" />
        )}
      </BentoCard>

      <BentoCard title="Activity log" subtitle="Who changed what, and when" icon={ScrollText} className="col-span-2 md:col-span-12">
        <form method="get" action="/finance/audit-trail" className="mb-4 flex flex-wrap items-center gap-2">
          <select name="type" aria-label="Document type" defaultValue={filters.type ?? ''} className={SELECT_CLASS}>
            <option value="">All document types</option>
            {AUDIT_ENTITY_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
          <select name="actor" aria-label="Person" defaultValue={filters.actor ?? ''} className={SELECT_CLASS}>
            <option value="">All people</option>
            {summary.actors.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
          <select name="period" aria-label="Period" defaultValue={filters.period} className={SELECT_CLASS}>
            {AUDIT_PERIODS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
          <div className="relative w-full sm:w-64">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input type="search" name="q" aria-label="Search document numbers" placeholder="Search document numbers…" defaultValue={filters.q} className="pl-8" />
          </div>
          <Button type="submit">Apply</Button>
          <Link href="/finance/audit-trail" className="text-sm text-muted-foreground underline-offset-4 hover:underline">
            Clear
          </Link>
        </form>

        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40">
                <TableHead className="whitespace-nowrap">When</TableHead>
                <TableHead>Who</TableHead>
                <TableHead>What</TableHead>
                <TableHead>Document</TableHead>
                <TableHead>Details</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-sm text-muted-foreground">
                    {emptyMessage(filters)}
                  </TableCell>
                </TableRow>
              )}
              {entries.map((e) => {
                const path = typeLabel.get(e.entityType)?.path ?? null;
                const label = e.target ?? typeLabel.get(e.entityType)?.label ?? e.entityType;
                return (
                  <TableRow key={e.id}>
                    <TableCell className="whitespace-nowrap tabular-nums text-muted-foreground">
                      {displayDate(malaysiaDate(e.createdAt))} {clockTime(e.createdAt)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap font-medium">{e.actorName}</TableCell>
                    <TableCell className="whitespace-nowrap">{e.action}</TableCell>
                    <TableCell className="whitespace-nowrap font-mono text-xs">
                      {path ? (
                        <Link href={path} className="underline-offset-4 hover:underline">
                          {label}
                        </Link>
                      ) : (
                        label
                      )}
                    </TableCell>
                    <TableCell className="min-w-48 text-muted-foreground">
                      <Details entry={e} />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
        {nextBefore && (
          <div className="mt-4">
            <Link href={olderHref(filters, nextBefore)} className="text-sm font-medium underline-offset-4 hover:underline">
              Older
            </Link>
          </div>
        )}
      </BentoCard>
    </BentoGrid>
  );
}
