import { headers } from 'next/headers';
import {
  Briefcase,
  Filter,
  Globe,
  Palette,
  PieChart,
  TrendingUp,
} from 'lucide-react';
import { ScreenContainer } from '@/components/screen/screen-container';
import { PageHeader } from '@/components/screen/page-header';
import { BentoGrid, BentoCard, BentoStat } from '@/components/bento/bento';
import {
  AreaTrend,
  DonutStat,
  FunnelFlow,
  Sparkline,
  type Series,
  type Slice,
} from '@/components/charts';
import { LiveDot } from '@/components/ui/live-dot';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { can } from '@/lib/auth/permissions';
import { getViewer } from '@/lib/auth/viewer';
import { buildCareersModel } from '@/lib/hire/lists';
import { DEFAULT_HEADLINE, careersPath, careersUrl } from '@/lib/hire/public-careers';
import { originFromHeaders } from '@/lib/reach/form-submissions';
import { cn } from '@/lib/utils';
import { CareersBrandingForm, CareersHeaderControls } from '@/screens/hire/careers-controls';
import { LOAD_FAILED, Muted, NOT_AVAILABLE, loadHire } from '@/screens/hire/parts';
import { PublishButton } from '@/screens/hire/publish-button';

/* ---- sample look for widgets with no source yet (demo visitors only) -- */

const VIEWS_TREND = [
  { label: 'Wk1', views: 420, applies: 12 },
  { label: 'Wk2', views: 460, applies: 13 },
  { label: 'Wk3', views: 510, applies: 15 },
  { label: 'Wk4', views: 540, applies: 16 },
  { label: 'Wk5', views: 560, applies: 17 },
  { label: 'Wk6', views: 580, applies: 18 },
  { label: 'Wk7', views: 600, applies: 18 },
  { label: 'Wk8', views: 610, applies: 19 },
];
const VIEWS_SERIES: Series[] = [
  { key: 'views', label: 'Views', color: 'var(--chart-1)' },
  { key: 'applies', label: 'Applies', color: 'var(--chart-2)' },
];

/* Views → applies funnel (top = page views, 2nd = applies ⇒ 3.0%) ---- */
const FUNNEL: Slice[] = [
  { key: 'views', label: 'Views', value: 4280, color: 'var(--chart-1)' },
  { key: 'applies', label: 'Applies', value: 128, color: 'var(--chart-2)' },
  { key: 'interviews', label: 'Interviews', value: 42, color: 'var(--chart-4)' },
  { key: 'hires', label: 'Hires', value: 8, color: 'var(--chart-3)' },
];

/* Applies by source — sums to the 128 applies ------------------------ */
const APPLY_SOURCE: Slice[] = [
  { key: 'jobstreet', label: 'JobStreet', value: 46, color: 'var(--chart-1)' },
  { key: 'linkedin', label: 'LinkedIn', value: 38, color: 'var(--chart-2)' },
  { key: 'referral', label: 'Referral', value: 22, color: 'var(--chart-4)' },
  { key: 'direct', label: 'Direct', value: 14, color: 'var(--chart-3)' },
  { key: 'other', label: 'Other', value: 8, color: 'var(--muted-foreground)' },
];

type JobStatus = 'Published' | 'Open' | 'Closed' | 'Draft';

const STATUS_TONE: Record<JobStatus, string> = {
  Published: 'text-emerald-600 dark:text-emerald-400',
  Open: 'text-foreground',
  Closed: 'text-muted-foreground',
  Draft: 'text-amber-600 dark:text-amber-400',
};

/* ------------------------------------------------------------------ */

export default async function CareersPageScreen() {
  const [{ model, isDemo }, viewer, requestHeaders] = await Promise.all([
    loadHire('careers-page', (data) => buildCareersModel(data)),
    getViewer(),
    headers(),
  ]);
  const canEdit = !viewer.isDemo && can(viewer.role, 'edit-data');
  /** A demo visitor sees the sample page and can switch nothing. */
  const demo = isDemo || viewer.isDemo;
  const settings = model?.settings;
  /** Whether the public board is on. The demo workspace never has one. */
  const boardOn = !demo && settings?.careers_enabled === true;
  /**
   * Whether the Status column and the card subtitle say "Published". The demo workspace has no board, yet its
   * sample screen shows its open jobs as published (every open demo job has a description), so for the label
   * only the demo counts as on.
   */
  const boardLabelOn = demo || boardOn;
  const rows = (model?.rows ?? []).map((j) => ({
    ...j,
    status: demo && j.status === 'Open' ? ('Published' as const) : j.status,
  }));
  const publishedRoles = rows.filter((j) => j.status === 'Published').length;
  const boardPath = careersPath(viewer.orgId);
  const origin = demo ? null : originFromHeaders((name) => requestHeaders.get(name));
  /** The first three jobs a visitor would see, in the board's own order. */
  const showing = (model?.showing ?? []).slice(0, 3);
  const brand = demo
    ? { name: 'Rimba Ventures', headline: 'Join our team', tagline: 'Build the future with us' }
    : { name: viewer.orgName, headline: settings?.careers_headline || DEFAULT_HEADLINE, tagline: settings?.careers_tagline || null };

  return (
    <ScreenContainer>
      <PageHeader
        title="Careers Page"
        subtitle="Your public job board."
        actions={
          // Not shown when the settings could not be read: a switch must never show a state it does not know.
          settings ? (
            <CareersHeaderControls
              enabled={boardOn}
              mode={demo ? 'demo' : canEdit ? 'edit' : 'view'}
              previewPath={boardPath}
              shareUrl={origin ? careersUrl(origin, viewer.orgId) : null}
            />
          ) : undefined
        }
      />

      <BentoGrid>
        {/* KPI row */}
        <BentoCard tone="primary" className="col-span-1 md:col-span-3">
          {isDemo ? (
            <BentoStat
              label="Page views"
              value="4,280"
              onPrimary
              chart={
                <Sparkline
                  data={[420, 460, 510, 540, 560, 580, 600, 610]}
                  color="var(--primary-foreground)"
                  height={36}
                />
              }
            />
          ) : (
            <>
              <p className="text-sm text-primary-foreground/80">Page views</p>
              {NOT_AVAILABLE}
            </>
          )}
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          {isDemo ? (
            <BentoStat
              label="Applies"
              value="128"
              chart={
                <Sparkline
                  data={[12, 13, 15, 16, 17, 18, 18, 19]}
                  color="var(--chart-2)"
                  height={36}
                />
              }
            />
          ) : (
            <>
              <p className="text-sm text-muted-foreground">Applies</p>
              {NOT_AVAILABLE}
            </>
          )}
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          {isDemo ? (
            <BentoStat
              label="Conversion"
              value="3.0%"
              chart={
                <Sparkline
                  data={[2.6, 2.7, 2.8, 2.8, 2.9, 2.9, 3.0, 3.0]}
                  color="var(--chart-3)"
                  height={36}
                />
              }
            />
          ) : (
            <>
              <p className="text-sm text-muted-foreground">Conversion</p>
              {NOT_AVAILABLE}
            </>
          )}
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat label="Open roles" value={model ? String(model.openRoles) : '—'} />
        </BentoCard>

        {/* Page preview (browser frame) */}
        <BentoCard
          title="Careers page"
          subtitle="How visitors see it"
          icon={Globe}
          className="col-span-2 md:col-span-4"
        >
          <div className="flex min-h-[240px] items-center justify-center">
            <div className="w-full max-w-[240px] overflow-hidden rounded-xl border bg-background shadow-sm">
              <div className="flex items-center gap-1.5 border-b bg-muted/40 px-3 py-2">
                <span className="size-2 shrink-0 rounded-full bg-red-400/70" />
                <span className="size-2 shrink-0 rounded-full bg-amber-400/70" />
                <span className="size-2 shrink-0 rounded-full bg-emerald-400/70" />
                <span className="ml-2 truncate text-[10px] text-muted-foreground">
                  {demo ? 'careers.openkuasa.com' : boardPath}
                </span>
              </div>
              <div className="flex flex-col gap-2 bg-gradient-to-br from-primary/10 to-muted px-4 py-5">
                {!model ? LOAD_FAILED : !demo && !boardOn ? (
                  <Muted>Your careers page is off</Muted>
                ) : (
                  <>
                    <span className="w-fit max-w-full truncate rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-semibold text-primary">
                      {brand.name}
                    </span>
                    <p className="text-sm font-bold leading-tight break-words">{brand.headline}</p>
                    {brand.tagline && (
                      <p className="text-[10px] break-words text-muted-foreground">{brand.tagline}</p>
                    )}
                    <div className="mt-1 space-y-1.5">
                      {showing.length === 0 ? (
                        <Muted>No open roles right now</Muted>
                      ) : (
                        showing.map((j, index) => (
                          <div
                            key={`${j.title}-${index}`}
                            className="flex items-center justify-between gap-2 rounded-md border bg-background/70 px-2 py-1"
                          >
                            <span className="truncate text-[10px] font-medium">{j.title}</span>
                            {j.location && (
                              <span className="max-w-[50%] shrink-0 truncate text-[9px] text-muted-foreground">
                                {j.location.split(' · ')[0]}
                              </span>
                            )}
                          </div>
                        ))
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </BentoCard>

        {/* Views & applies trend */}
        <BentoCard
          title="Views & applies over time"
          subtitle="Last 8 weeks"
          icon={TrendingUp}
          className="col-span-2 md:col-span-8"
        >
          {isDemo ? (
            <AreaTrend data={VIEWS_TREND} series={VIEWS_SERIES} height={240} showLegend />
          ) : (
            NOT_AVAILABLE
          )}
        </BentoCard>

        {/* Funnel + applies source + branding */}
        <BentoCard
          title="Views → applies → hires"
          subtitle="Careers page funnel"
          icon={Filter}
          className="col-span-2 md:col-span-4"
        >
          {isDemo ? <FunnelFlow data={FUNNEL} height={200} /> : NOT_AVAILABLE}
        </BentoCard>
        <BentoCard
          title="Applies by source"
          subtitle="This period"
          icon={PieChart}
          className="col-span-2 md:col-span-4"
        >
          {isDemo ? (
            <DonutStat
              data={APPLY_SOURCE}
              height={200}
              centerValue="128"
              centerLabel="applies"
            />
          ) : (
            NOT_AVAILABLE
          )}
        </BentoCard>
        <BentoCard
          title="Page branding"
          subtitle="How your page looks"
          icon={Palette}
          className="col-span-2 md:col-span-4"
        >
          {!settings ? LOAD_FAILED : demo ? (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="headline">Headline</Label>
                <Input id="headline" disabled defaultValue="Join our team" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="tagline">Tagline</Label>
                <Input id="tagline" disabled defaultValue="Build the future with us" />
              </div>
            </div>
          ) : (
            <CareersBrandingForm
              headline={settings.careers_headline}
              tagline={settings.careers_tagline}
              canEdit={canEdit}
              defaultHeadline={DEFAULT_HEADLINE}
            />
          )}
        </BentoCard>

        {/* Job listings table */}
        <BentoCard
          title="Job listings"
          subtitle={
            model
              ? `${boardLabelOn ? `${publishedRoles} published` : `${model.openRoles} open`} · ${model.rows.length} total`
              : undefined
          }
          icon={Briefcase}
          className="col-span-2 md:col-span-12"
        >
          {!model ? LOAD_FAILED : model.isEmpty ? (
            <Muted>No jobs yet</Muted>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/40">
                    <TableHead>Role</TableHead>
                    <TableHead>Location</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead className="text-right">Applicants</TableHead>
                    <TableHead>Status</TableHead>
                    {canEdit && <TableHead className="text-right">Actions</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((j) => (
                    <TableRow key={j.id}>
                      <TableCell className="whitespace-nowrap font-medium">
                        {j.title}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {j.location}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">{j.type}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {j.applicants > 0 ? j.applicants : '—'}
                      </TableCell>
                      <TableCell>
                        <span
                          className={cn(
                            'inline-flex items-center gap-2 text-sm font-medium',
                            STATUS_TONE[j.status],
                          )}
                        >
                          <LiveDot active={j.status === 'Published'} />
                          {j.status}
                        </span>
                      </TableCell>
                      {canEdit && (
                        <TableCell className="text-right">
                          <PublishButton id={j.id} title={j.title} published={j.jobStatus === 'open'} />
                        </TableCell>
                      )}
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
