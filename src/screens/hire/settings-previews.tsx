import Link from 'next/link';
import type { ReactNode } from 'react';
import { Bell, GripVertical, Mail, Pencil, Plug, Plus, Users, Workflow } from 'lucide-react';
import { BentoCard } from '@/components/bento/bento';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';

/**
 * The five Settings cards that are not built yet. They are previews: every control
 * is disabled, nothing is saved, and no number, person or brand is made up.
 * Plain markup, no state: this stays a server component.
 */

type CardKey = 'pipeline' | 'boards' | 'templates' | 'team' | 'notifications';

const SOON_LINE = 'A preview of what is planned. Nothing here works or is saved yet.';
/** 44 pixels of hit area on every button. */
const TARGET = 'min-h-11 min-w-11';
const ROW = 'flex items-center justify-between gap-3 rounded-lg border bg-background/50 p-2.5';

const soonId = (card: CardKey) => `settings-soon-${card}`;

/** The card shell: header with the "Coming soon" badge, then the one line that says why nothing works. */
function PreviewCard({
  card,
  title,
  subtitle,
  icon,
  children,
}: {
  card: CardKey;
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
      action={
        <Badge variant="outline" className="shrink-0 whitespace-nowrap">
          Coming soon
        </Badge>
      }
    >
      <p id={soonId(card)} className="mb-3 text-xs text-muted-foreground">
        {SOON_LINE}
      </p>
      {children}
    </BentoCard>
  );
}

const STAGES = ['Applied', 'Screening', 'Interview', 'Offer', 'Hired'];

export function PipelinePreview() {
  const describedBy = soonId('pipeline');
  return (
    <PreviewCard card="pipeline" title="Hiring pipeline" subtitle="Stages candidates move through" icon={Workflow}>
      <div className="space-y-2">
        {STAGES.map((stage) => (
          <div key={stage} className={ROW}>
            <span className="text-sm font-medium">{stage}</span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={TARGET}
              disabled
              aria-describedby={describedBy}
              aria-label={`Move ${stage} (coming soon)`}
            >
              <GripVertical className="size-4 text-muted-foreground" aria-hidden="true" />
            </Button>
          </div>
        ))}
      </div>
      <Button type="button" variant="outline" size="sm" className={`mt-3 ${TARGET}`} disabled aria-describedby={describedBy}>
        <Plus className="size-4" aria-hidden="true" />
        Add stage
      </Button>
    </PreviewCard>
  );
}

const BOARDS = ['A', 'B', 'C'];

export function JobBoardsPreview() {
  const describedBy = soonId('boards');
  return (
    <PreviewCard card="boards" title="Job board integrations" subtitle="Where your roles get posted" icon={Plug}>
      <div className="space-y-2">
        {BOARDS.map((letter) => (
          <div key={letter} className={ROW}>
            <div className="flex min-w-0 items-center gap-3">
              <span
                aria-hidden="true"
                className="grid size-10 shrink-0 place-items-center rounded-lg bg-muted text-sm font-bold text-muted-foreground"
              >
                {letter}
              </span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-medium">Example job board {letter}</p>
                  <Badge variant="outline">Not connected</Badge>
                </div>
                <p className="text-xs text-muted-foreground">Post your open roles here automatically</p>
              </div>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={`shrink-0 ${TARGET}`}
              disabled
              aria-describedby={describedBy}
              aria-label={`Connect Example job board ${letter}`}
            >
              Connect
            </Button>
          </div>
        ))}
      </div>
    </PreviewCard>
  );
}

const TEMPLATES = ['Application received', 'Interview invitation', 'Offer letter', 'Not selected'];

export function EmailTemplatesPreview() {
  const describedBy = soonId('templates');
  return (
    <PreviewCard card="templates" title="Email templates" subtitle="Automated candidate messages" icon={Mail}>
      <div className="space-y-2">
        {TEMPLATES.map((name) => (
          <div key={name} className={ROW}>
            <div className="min-w-0">
              <p className="text-sm font-medium">{name}</p>
              <p className="text-xs text-muted-foreground">Example template</p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={`shrink-0 ${TARGET}`}
              disabled
              aria-describedby={describedBy}
              aria-label={`Edit ${name} (coming soon)`}
            >
              <Pencil className="size-4" aria-hidden="true" />
            </Button>
          </div>
        ))}
      </div>
    </PreviewCard>
  );
}

const ROLES = ['Admin', 'Hiring manager', 'Interviewer', 'Recruiter'];

export function HiringTeamPreview() {
  const describedBy = soonId('team');
  return (
    <PreviewCard card="team" title="Hiring team" subtitle="Managers and interviewers" icon={Users}>
      <div className="space-y-2">
        {ROLES.map((role) => (
          <div key={role} className={ROW}>
            <div className="flex min-w-0 items-center gap-3">
              <div
                aria-hidden="true"
                className="grid size-8 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground"
              >
                <Users className="size-4" />
              </div>
              <span className="text-sm font-medium">{role}</span>
            </div>
            <Badge variant="secondary" className="shrink-0">
              Example
            </Badge>
          </div>
        ))}
      </div>
      <Button type="button" variant="outline" size="sm" className={`mt-3 ${TARGET}`} disabled aria-describedby={describedBy}>
        <Plus className="size-4" aria-hidden="true" />
        Invite member
      </Button>
      <p className="mt-3 text-xs text-muted-foreground">
        To add people to your workspace today, use{' '}
        <Link href="/account/team" className="font-medium text-foreground underline underline-offset-2">
          Team in your account
        </Link>
        .
      </p>
    </PreviewCard>
  );
}

const NOTIFICATIONS = [
  { id: 'notify-new', label: 'Email me on new applications' },
  { id: 'notify-digest', label: 'Daily applicant digest' },
  { id: 'notify-interview', label: 'Interview reminders' },
];

export function NotificationsPreview() {
  const describedBy = soonId('notifications');
  return (
    <PreviewCard card="notifications" title="Notifications" subtitle="Choose what you get notified about" icon={Bell}>
      {NOTIFICATIONS.map((row) => (
        <div key={row.id} className="flex min-h-11 items-center justify-between gap-4 py-2">
          <Label htmlFor={row.id} className="font-medium">
            {row.label}
          </Label>
          <Switch id={row.id} checked={false} disabled aria-describedby={describedBy} />
        </div>
      ))}
    </PreviewCard>
  );
}

const DEMO_COMPANY = 'Rimba Ventures';

/** The Settings subtitle: the viewer's own workspace, the demo company for a demo, or no company at all. */
export function settingsGreeting(orgName: string | null | undefined, demo: boolean): string {
  const name = demo ? DEMO_COMPANY : (orgName ?? '').trim();
  return name ? `Recruiting preferences for ${name}, Saudara.` : 'Recruiting preferences, Saudara.';
}
