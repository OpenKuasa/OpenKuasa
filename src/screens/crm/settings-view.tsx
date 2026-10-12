'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Bell, Check, Download, FileText, GitBranch, Plug, ShieldCheck, Users } from 'lucide-react';
import { ScreenContainer } from '@/components/screen/screen-container';
import { PageHeader } from '@/components/screen/page-header';
import { BentoGrid, BentoCard } from '@/components/bento/bento';
import { Button } from '@/components/ui/button';
import type { CrmFormAction } from '@/lib/crm/form-state';
import {
  EXPORT_CONTACTS_MAX,
  KASTURI_NOTIFICATIONS,
  type CrmSettings,
  type MyKasturiNotifications,
} from '@/lib/crm/settings';
import { cn } from '@/lib/utils';
import { useCrmForm } from './crm-form';

/** What the screen shows of things that are set elsewhere. A count that could not be read is null. */
export type CrmSettingsOverview = {
  companyName: string;
  registrationNo: string;
  members: number | null;
  contacts: number | null;
  pipelines: { id: string; name: string; isDefault: boolean; stages: number }[];
  hasAiKey: boolean;
  /** The address broadcasts are sent from; null when no email key is set. */
  emailSender: string | null;
  pagesWithChat: number | null;
  automationsOn: number | null;
};

const LINK = 'font-medium text-primary underline-offset-4 hover:underline';

function plural(count: number | null, one: string, many: string) {
  if (count === null) return `Some ${many}`;
  return `${count.toLocaleString('en-MY')} ${count === 1 ? one : many}`;
}

/** A line of the screen that only reports something and says where to change it. */
function Row({
  label,
  value,
  href,
  linkLabel,
  on,
}: {
  label: string;
  value: string;
  href: string;
  linkLabel: string;
  /** Draws the value as a state pill: green when on, grey when not. */
  on?: boolean;
}) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-lg border bg-background/50 px-3 py-2">
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        {on === undefined ? <p className="truncate text-xs text-muted-foreground">{value}</p> : null}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {on === undefined ? null : (
          <span
            className={cn(
              'rounded-full px-2 py-0.5 text-xs font-medium',
              on ? 'bg-emerald-500/15 text-emerald-600' : 'bg-muted text-muted-foreground',
            )}
          >
            {value}
          </span>
        )}
        <Link href={href} className={cn(LINK, 'text-xs')}>
          {linkLabel}
        </Link>
      </div>
    </li>
  );
}

function Saved({ pending, error, saved }: { pending: boolean; error: string | null; saved: boolean }) {
  if (error) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {error}
      </p>
    );
  }
  return saved && !pending ? <p className="text-sm text-muted-foreground">Saved.</p> : null;
}

function RulesForm({ settings, action }: { settings: CrmSettings; action?: CrmFormAction }) {
  const [saved, setSaved] = useState(false);
  // A missing action means the person can only read: the form is shown, not sent.
  const { formAction, pending, error } = useCrmForm(action ?? (async () => undefined), () => setSaved(true));
  const [requireLostReason, setRequireLostReason] = useState(settings.requireLostReason);

  return (
    <form action={action ? formAction : undefined} className="space-y-3">
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          name="requireLostReason"
          checked={requireLostReason}
          disabled={!action}
          onChange={(event) => {
            setSaved(false);
            setRequireLostReason(event.target.checked);
          }}
          className="mt-0.5 size-4 accent-primary"
        />
        <span>
          <span className="font-medium">Require a reason when a deal is marked lost</span>
          <span className="block text-xs text-muted-foreground">
            Applies to everyone, and to Kasturi AI. Deals already lost are not affected.
          </span>
        </span>
      </label>
      {action ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" size="sm" disabled={pending}>
            <Check className="size-4" />
            {pending ? 'Saving…' : 'Save'}
          </Button>
          <Saved pending={pending} error={error} saved={saved} />
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">Only an owner or admin can change this.</p>
      )}
    </form>
  );
}

function NotificationsForm({
  notifications,
  action,
}: {
  notifications: MyKasturiNotifications;
  action?: CrmFormAction;
}) {
  const [saved, setSaved] = useState(false);
  const { formAction, pending, error } = useCrmForm(action ?? (async () => undefined), () => setSaved(true));
  const [choice, setChoice] = useState({ new_leads: notifications.new_leads, deal_stages: notifications.deal_stages });

  return (
    <form action={action ? formAction : undefined} className="space-y-3">
      {notifications.inAppOn ? null : (
        <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
          You have switched all in-app notifications off, so these will not reach you until you switch them back on
          in{' '}
          <Link href="/account/notifications" className={LINK}>
            Account, Notifications
          </Link>
          .
        </p>
      )}
      {KASTURI_NOTIFICATIONS.map((item) => (
        <label key={item.id} className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            name={item.field}
            checked={choice[item.id]}
            disabled={!action}
            onChange={(event) => {
              setSaved(false);
              setChoice((current) => ({ ...current, [item.id]: event.target.checked }));
            }}
            className="mt-0.5 size-4 accent-primary"
          />
          <span>
            <span className="font-medium">{item.name}</span>
            <span className="block text-xs text-muted-foreground">{item.help}</span>
          </span>
        </label>
      ))}
      {action ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" size="sm" disabled={pending}>
            <Check className="size-4" />
            {pending ? 'Saving…' : 'Save'}
          </Button>
          <Saved pending={pending} error={error} saved={saved} />
        </div>
      ) : null}
      <p className="text-xs text-muted-foreground">
        These are yours alone and appear under the bell at the top of the app. Nothing is emailed. The same switches
        are in{' '}
        <Link href="/account/notifications" className={LINK}>
          Account, Notifications
        </Link>
        .
      </p>
    </form>
  );
}

/** Kasturi's settings. */
export function CrmSettingsView({
  settings,
  notifications,
  overview,
  saveRules,
  saveNotifications,
  canExport,
}: {
  settings: CrmSettings;
  notifications: MyKasturiNotifications;
  overview: CrmSettingsOverview;
  /** Present only for owners and admins. */
  saveRules?: CrmFormAction;
  /** Absent for a demo guest. */
  saveNotifications?: CrmFormAction;
  canExport: boolean;
}) {
  const defaultPipeline = overview.pipelines.find((pipeline) => pipeline.isDefault);

  return (
    <ScreenContainer>
      <PageHeader title="Settings" subtitle="Kasturi's own rules and notifications, and where the rest of your workspace is set." />

      <BentoGrid>
        <BentoCard
          title="Deal rules"
          subtitle="Rules everyone in the workspace works to"
          icon={ShieldCheck}
          className="col-span-2 md:col-span-6"
        >
          <RulesForm settings={settings} action={saveRules} />
        </BentoCard>

        <BentoCard
          title="My notifications"
          subtitle="What Kasturi tells you about"
          icon={Bell}
          className="col-span-2 md:col-span-6"
        >
          <NotificationsForm notifications={notifications} action={saveNotifications} />
        </BentoCard>

        <BentoCard
          title="Workspace"
          subtitle="Set in your account, used across every product"
          // The card's icon chip only draws icons from the animated set.
          icon={Users}
          className="col-span-2 md:col-span-6"
        >
          <ul className="space-y-1">
            <Row
              label={overview.companyName}
              value={overview.registrationNo ? `Reg. no ${overview.registrationNo}` : 'No registration number yet'}
              href="/account/company"
              linkLabel="Edit company"
            />
            <Row
              label="Team"
              value={plural(overview.members, 'person has', 'people have') + ' access to this workspace'}
              href="/account/team"
              linkLabel="Manage team"
            />
          </ul>
        </BentoCard>

        <BentoCard
          title="Pipelines"
          subtitle="Pipelines and their stages are changed on the Deals screen"
          icon={GitBranch}
          className="col-span-2 md:col-span-6"
        >
          {overview.pipelines.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No pipeline yet.{' '}
              <Link href="/crm/deals" className={LINK}>
                Open Deals to set one up
              </Link>
              .
            </p>
          ) : (
            <ul className="space-y-1">
              {overview.pipelines.map((pipeline) => (
                <Row
                  key={pipeline.id}
                  label={pipeline.name}
                  value={`${plural(pipeline.stages, 'stage', 'stages')}${pipeline.isDefault ? ' · the default for new deals' : ''}`}
                  href="/crm/deals"
                  linkLabel="Open Deals"
                />
              ))}
            </ul>
          )}
          {overview.pipelines.length > 0 && !defaultPipeline ? (
            <p className="mt-2 text-xs text-muted-foreground">No pipeline is marked as the default.</p>
          ) : null}
        </BentoCard>

        <BentoCard
          title="Connections"
          subtitle="What Kasturi's sending and AI features run on"
          icon={Plug}
          className="col-span-2 md:col-span-6"
        >
          <ul className="space-y-1">
            <Row
              label="AI key (OpenRouter)"
              value={overview.hasAiKey ? 'Set' : 'Not set'}
              on={overview.hasAiKey}
              href="/account/ai"
              linkLabel={overview.hasAiKey ? 'Manage' : 'Add a key'}
            />
            <Row
              label="Email sending (Resend)"
              value={overview.emailSender ? `From ${overview.emailSender}` : 'Not set'}
              on={overview.emailSender !== null}
              href="/crm/broadcast"
              linkLabel={overview.emailSender ? 'Manage' : 'Set up'}
            />
            <Row
              label="Chatbot on landing pages"
              value={
                overview.pagesWithChat === null
                  ? 'Unknown'
                  : overview.pagesWithChat === 0
                    ? 'Off'
                    : `On for ${plural(overview.pagesWithChat, 'page', 'pages')}`
              }
              on={(overview.pagesWithChat ?? 0) > 0}
              href="/crm/chatbot"
              linkLabel="Open"
            />
            <Row
              label="Automations"
              value={
                overview.automationsOn === null
                  ? 'Unknown'
                  : overview.automationsOn === 0
                    ? 'None on'
                    : `${overview.automationsOn} on`
              }
              on={(overview.automationsOn ?? 0) > 0}
              href="/crm/automations"
              linkLabel="Open"
            />
          </ul>
        </BentoCard>

        <BentoCard
          title="Your data"
          subtitle="Take a copy of the workspace's contacts"
          icon={FileText}
          className="col-span-2 md:col-span-6"
        >
          <div className="space-y-3">
            <p className="text-sm">
              {overview.contacts === null
                ? 'Your contacts'
                : `${plural(overview.contacts, 'contact', 'contacts')} in this workspace`}
              . The file has each contact&rsquo;s name, email, phone, company, country, status, source, tags and
              the day they were added.
            </p>
            {canExport ? (
              <Button asChild size="sm" variant="outline">
                {/* A plain link: the browser saves the file the server sends. */}
                <a href="/api/crm/contacts/export" download>
                  <Download className="size-4" />
                  Export contacts (CSV)
                </a>
              </Button>
            ) : (
              <p className="text-xs text-muted-foreground">Only an owner or admin can export the contacts.</p>
            )}
            <p className="text-xs text-muted-foreground">
              One file holds up to {EXPORT_CONTACTS_MAX.toLocaleString('en-MY')} contacts. Chatbot conversations are
              deleted 90 days after their last message; nothing else is deleted automatically.
            </p>
          </div>
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}
