'use client';

import { useActionState, useState } from 'react';
import { Plug } from 'lucide-react';
import { BentoCard } from '@/components/bento/bento';
import { Button } from '@/components/ui/button';
import { ActionNotice } from '@/components/account/action-notice';
import { ReadOnlyNotice } from '@/components/account/settings-form';
import { disconnectAppAction } from '@/app/account/developers/actions';

/** An AI tool the person connected with "Sign in with OpenKuasa". */
export type ConnectedApp = {
  clientId: string;
  name: string;
  grantedAt: string;
  /** The workspace it acts in; null when none is recorded yet (it records the open one on first use). */
  workspace: string | null;
};

const DATE = new Intl.DateTimeFormat('en-MY', { day: '2-digit', month: 'short', year: 'numeric' });

function connectedOn(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : `Connected ${DATE.format(date)}`;
}

function DisconnectButton({ clientId, name, onNotice }: { clientId: string; name: string; onNotice: (text: string | null) => void }) {
  const [state, formAction, pending] = useActionState(async (prev: Awaited<ReturnType<typeof disconnectAppAction>>, formData: FormData) => {
    onNotice(null);
    const next = await disconnectAppAction(prev, formData);
    // The row is dropped from the list once the app is disconnected, so the card keeps the notice.
    if (next?.notice) onNotice(next.notice);
    return next;
  }, undefined);
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="flex flex-col items-end gap-1">
      <form action={formAction} className="flex items-center gap-2">
        <input type="hidden" name="client_id" value={clientId} />
        {confirming ? (
          <>
            <Button key="cancel" type="button" variant="ghost" size="sm" onClick={() => setConfirming(false)} disabled={pending}>
              Cancel
            </Button>
            <Button key="confirm" type="submit" variant="destructive" size="sm" disabled={pending} aria-label={`Disconnect ${name}`}>
              {pending ? 'Disconnecting…' : 'Disconnect'}
            </Button>
          </>
        ) : (
          <Button key="ask" type="button" variant="outline" size="sm" onClick={() => setConfirming(true)} aria-label={`Disconnect ${name}`}>
            Disconnect
          </Button>
        )}
      </form>
      {state?.error ? (
        <p role="alert" className="text-xs text-destructive">
          {state.error}
        </p>
      ) : null}
    </div>
  );
}

function AppList({ apps, onNotice }: { apps: ConnectedApp[]; onNotice: (text: string | null) => void }) {
  return (
    <ul className="space-y-1">
      {apps.map((app) => (
        <li
          key={app.clientId}
          className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-lg border bg-background/50 px-3 py-2"
        >
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{app.name}</p>
            <p className="truncate text-xs text-muted-foreground">
              {[app.workspace ? `Acts in ${app.workspace}` : 'Workspace set on first use', connectedOn(app.grantedAt)]
                .filter(Boolean)
                .join(' · ')}
            </p>
          </div>
          <DisconnectButton clientId={app.clientId} name={app.name} onNotice={onNotice} />
        </li>
      ))}
    </ul>
  );
}

/**
 * "Connected apps": the person's sign-in connections. `apps` is null when they could not be read. `comingSoon` while
 * sign-in connections are switched off: connections made while they were on are still listed, so they can be
 * disconnected; with none (or none readable) the card says Coming soon.
 */
export function ConnectedAppsCard({
  apps,
  readOnly,
  comingSoon = false,
}: {
  apps: ConnectedApp[] | null;
  readOnly: boolean;
  comingSoon?: boolean;
}) {
  const [notice, setNotice] = useState<string | null>(null);
  return (
    <BentoCard
      title="Connected apps"
      subtitle="AI tools you connected with Sign in with OpenKuasa"
      icon={Plug}
      className="col-span-2 md:col-span-12"
    >
      {readOnly ? null : <ActionNotice text={notice} />}
      {readOnly ? (
        comingSoon ? (
          <p className="text-sm text-muted-foreground">Coming soon.</p>
        ) : (
          <ReadOnlyNotice>The demo workspace is read-only. Sign up to connect AI tools.</ReadOnlyNotice>
        )
      ) : comingSoon ? (
        apps && apps.length > 0 ? (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              New sign-in connections aren&apos;t available. You can still disconnect these.
            </p>
            <AppList apps={apps} onNotice={setNotice} />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Coming soon.</p>
        )
      ) : apps === null ? (
        <p className="grid min-h-16 place-items-center text-sm text-muted-foreground">Couldn&apos;t load</p>
      ) : apps.length === 0 ? (
        <p className="text-sm text-muted-foreground">No apps connected yet.</p>
      ) : (
        <AppList apps={apps} onNotice={setNotice} />
      )}
    </BentoCard>
  );
}
