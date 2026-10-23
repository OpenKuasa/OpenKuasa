import Link from 'next/link';
import type { ReactNode } from 'react';
import { Globe, Workflow } from 'lucide-react';
import { BentoCard } from '@/components/bento/bento';
import { careersPath } from '@/lib/hire/public-careers';
import type { SettingsModel } from '@/lib/hire/settings-model';
import { cn } from '@/lib/utils';

/**
 * The Settings cards beside the Application form. Each shows the workspace's
 * own data and links to the screen where it is changed. Plain markup, no state:
 * these stay server components.
 */

const LINK = 'inline-flex min-h-11 items-center font-medium text-primary underline-offset-4 hover:underline';
const ROW = 'flex min-h-11 items-center justify-between gap-3 rounded-lg border bg-background/50 px-3 py-2';
const NOTE = 'text-xs text-muted-foreground';

function SettingsCard({
  title,
  subtitle,
  icon,
  children,
}: {
  title: string;
  subtitle: string;
  icon: typeof Workflow;
  children: ReactNode;
}) {
  return (
    <BentoCard
      // BentoCard truncates its header text; a wrapping child lets it use a second line instead.
      title={<span className="block whitespace-normal break-words">{title}</span>}
      subtitle={<span className="block whitespace-normal break-words">{subtitle}</span>}
      icon={icon}
      className="col-span-2 md:col-span-6"
    >
      {children}
    </BentoCard>
  );
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/* ---- Hiring pipeline -------------------------------------------------- */

export function PipelineCard({ stages, failed }: { stages: SettingsModel['stages'] | null; failed: ReactNode }) {
  return (
    <SettingsCard title="Hiring pipeline" subtitle="Stages candidates move through" icon={Workflow}>
      {stages ? (
        <>
          <ol className="space-y-1.5" aria-label="Live applications in each stage">
            {stages.map((s) => (
              <li key={s.stage} className={ROW}>
                <span className="text-sm font-medium">{s.label}</span>
                <span className="text-sm tabular-nums text-muted-foreground">{s.count}</span>
              </li>
            ))}
          </ol>
          <p className={cn(NOTE, 'mt-3')}>
            The five stages are the same in every workspace. The numbers are live applications in each stage now.
          </p>
        </>
      ) : (
        failed
      )}
      <Link href="/hire/applications" className={cn(LINK, 'text-sm')}>
        Open Applications
      </Link>
    </SettingsCard>
  );
}

/* ---- Careers page ----------------------------------------------------- */

export function CareersBoardCard({ board, failed }: { board: SettingsModel['board'] | null; failed: ReactNode }) {
  return (
    <SettingsCard title="Careers page" subtitle="Your own public job board" icon={Globe}>
      {board ? (
        <div className="space-y-2">
          <div className={ROW}>
            <span className="text-sm font-medium">Careers page</span>
            <span
              className={cn(
                'rounded-full px-2 py-0.5 text-xs font-medium',
                board.enabled ? 'bg-emerald-500/15 text-emerald-600' : 'bg-muted text-muted-foreground',
              )}
            >
              {board.enabled ? 'On' : 'Off'}
            </span>
          </div>
          {board.enabled ? (
            <p className="text-sm">{plural(board.listed, 'job is', 'jobs are')} showing on it.</p>
          ) : (
            <p className="text-sm">No one outside your workspace can see it.</p>
          )}
          {board.hiddenOpen > 0 ? (
            <p className={NOTE}>
              {plural(board.hiddenOpen, 'open job has', 'open jobs have')} no description, so the page{' '}
              {board.enabled ? 'leaves' : 'would leave'} {board.hiddenOpen === 1 ? 'it' : 'them'} out.
            </p>
          ) : null}
          <div className="flex flex-wrap gap-x-4">
            {board.enabled && board.orgId ? (
              <Link href={careersPath(board.orgId)} className={cn(LINK, 'text-sm')}>
                View the public page
              </Link>
            ) : null}
            <Link href="/hire/careers-page" className={cn(LINK, 'text-sm')}>
              Manage careers page
            </Link>
          </div>
        </div>
      ) : (
        <>
          {failed}
          <Link href="/hire/careers-page" className={cn(LINK, 'text-sm')}>
            Manage careers page
          </Link>
        </>
      )}
    </SettingsCard>
  );
}

/* ---- greeting --------------------------------------------------------- */

const DEMO_COMPANY = 'Rimba Ventures';

/** The Settings subtitle: the viewer's own workspace, the demo company for a demo, or no company at all. */
export function settingsGreeting(orgName: string | null | undefined, demo: boolean): string {
  const name = demo ? DEMO_COMPANY : (orgName ?? '').trim();
  return name ? `Recruiting preferences for ${name}.` : 'Recruiting preferences.';
}
