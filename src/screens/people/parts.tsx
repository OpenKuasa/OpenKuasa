import type { SupabaseClient } from '@supabase/supabase-js';
import type { LucideIcon } from 'lucide-react';
import { UserRoundX } from 'lucide-react';
import type { ReactNode } from 'react';
import { BentoCard, BentoGrid } from '@/components/bento/bento';
import { PageHeader } from '@/components/screen/page-header';
import { ScreenContainer } from '@/components/screen/screen-container';
import { Button } from '@/components/ui/button';
import { isLiveChatAllowed } from '@/lib/ai/access';
import { getCurrentOrg } from '@/lib/auth/current-org';
import { hasSupabaseEnv } from '@/lib/auth/viewer';
import { createSupabasePeopleData, getPeopleData } from '@/lib/people/supabase';
import type { ClaimStatus, PeopleData, PeopleViewer } from '@/lib/people/types';
import { NO_WORKSPACE_VIEWER, getPeopleViewer } from '@/lib/people/viewer';
import { createClient } from '@/lib/supabase/server';
import { cn } from '@/lib/utils';

export function Muted({ children }: { children: ReactNode }) {
  return (
    <p className="grid min-h-24 place-items-center text-center text-sm text-muted-foreground">
      {children}
    </p>
  );
}

export const LOAD_FAILED = <Muted>Couldn&apos;t load your HR data — please refresh</Muted>;
export const HR_ONLY = <Muted>Shown to HR admins</Muted>;
export const NOT_AVAILABLE = <Muted>Not available yet</Muted>;

/** The one palette for a department's slice, shared by the Overview and Employees charts. No purple. */
export const DEPARTMENT_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--muted-foreground)'];

/** What a screen's builder is told besides the data: the session, the workspace and who is looking. */
export type PeopleLoadContext = { client: SupabaseClient; orgId: string | null; viewer: PeopleViewer };

/**
 * Loads one Lekiu screen's model for the signed-in viewer. `model` is null
 * when the read failed, so the screen can say so on its cards instead of
 * crashing. `viewer` says who is looking (for wording only: the database has
 * already decided which rows came back). `hasWorkspace` is false when the user is in no workspace (or the read failed before one
 * was resolved). `chatDemo` is true for a demo or
 * signed-out visitor, who gets the canned chat answer.
 */
export async function loadPeople<T>(
  tag: string,
  build: (data: PeopleData, now: Date, ctx: PeopleLoadContext) => Promise<T>,
): Promise<{ model: T | null; viewer: PeopleViewer; chatDemo: boolean; hasWorkspace: boolean }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  let model: T | null = null;
  let viewer: PeopleViewer = NO_WORKSPACE_VIEWER;
  let hasWorkspace = false;
  try {
    // Resolve the workspace once; the provider and the viewer share it.
    const org = hasSupabaseEnv() ? await getCurrentOrg(supabase) : null;
    // No project configured: the sample company stands in for a workspace.
    hasWorkspace = org !== null || !hasSupabaseEnv();
    const data = org ? createSupabasePeopleData(supabase, org.orgId) : await getPeopleData(supabase);
    viewer = await getPeopleViewer(supabase, org);
    model = await build(data, new Date(), { client: supabase, orgId: org?.orgId ?? null, viewer });
  } catch (error) {
    console.error(`[people/${tag}] data error:`, error);
  }
  return { model, viewer, chatDemo: !isLiveChatAllowed(user), hasWorkspace };
}

type Tone = 'good' | 'pending' | 'bad' | 'neutral';

const TONE_CLASS: Record<Tone, string> = {
  good: 'bg-emerald-500/15 text-emerald-600',
  pending: 'bg-amber-500/15 text-amber-600',
  bad: 'bg-red-500/15 text-red-600',
  neutral: 'bg-muted text-muted-foreground',
};

/** A small coloured label for a status: good emerald, pending amber, bad red, neutral muted. */
export function StatusPill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium',
        TONE_CLASS[tone],
      )}
    >
      {children}
    </span>
  );
}

/** The pill tone for a request's status. */
export function requestTone(status: ClaimStatus): Tone {
  switch (status) {
    case 'approved':
    case 'paid':
      return 'good';
    case 'pending':
      return 'pending';
    case 'rejected':
      return 'bad';
    default:
      return 'neutral';
  }
}

const initialsOf = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join('') || '?';

/** An initials avatar and a name, with an optional second line. */
export function EmployeeCell({ name, sub }: { name: string; sub?: string | null }) {
  return (
    <span className="flex items-center gap-2">
      <span className="grid size-7 shrink-0 place-items-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
        {initialsOf(name)}
      </span>
      <span className="flex flex-col leading-tight">
        <span className="whitespace-nowrap font-medium">{name}</span>
        {sub ? <span className="whitespace-nowrap text-xs text-muted-foreground">{sub}</span> : null}
      </span>
    </span>
  );
}

export const LATER_NOTE = 'Available in a later update';

/**
 * A control for something not built yet: a real disabled button that submits
 * nothing. A disabled button shows no tooltip on hover, so the note is also
 * printed beside it in small muted text (`compact` hides it visually).
 */
export function LaterButton({
  children,
  icon: Icon,
  variant = 'default',
  size = 'default',
  compact = false,
}: {
  children: ReactNode;
  icon?: LucideIcon;
  variant?: 'default' | 'outline' | 'ghost';
  size?: 'sm' | 'default';
  /** For table rows: the note is kept for screen readers and the tooltip, not printed. */
  compact?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap" title={LATER_NOTE}>
      <Button type="button" variant={variant} size={size} disabled>
        {Icon ? <Icon aria-hidden /> : null}
        {children}
      </Button>
      <span className={compact ? 'sr-only' : 'text-xs text-muted-foreground'}>{LATER_NOTE}</span>
    </span>
  );
}

/** Replaces a personal screen's cards when the account is linked to no employee record. */
export function NotLinkedCard() {
  return (
    <BentoCard
      title="Your HR record isn't linked yet"
      icon={UserRoundX}
      className="col-span-2 md:col-span-12"
    >
      <p className="text-sm text-muted-foreground">
        You can see the team, but your own leave, claims and payslips will appear only once your
        account is linked to your employee record. Ask an owner or admin of this workspace to link it on the Employees screen.
      </p>
    </BentoCard>
  );
}

/** The whole body of an HR-only screen for someone who is not an owner or admin. */
export function HrOnlyScreen({ title }: { title: string }) {
  return (
    <ScreenContainer>
      <PageHeader title={title} />
      <BentoGrid>
        <BentoCard className="col-span-2 md:col-span-12">
          <p className="text-sm text-muted-foreground">This page is for owners and admins of the workspace.</p>
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}
