'use client';

import { useState } from 'react';
import { AppWindow, Mail, Smartphone, type LucideIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import {
  NOTIFY_CHANNELS,
  NOTIFY_EVENTS,
  QUIET_TIMES,
  type NotificationPrefs,
  type NotifyChannel,
} from '@/config/account';
import { updateNotificationsAction } from '@/app/account/actions';
import { PushDeviceCard } from './push-device-card';
import type { PushDevice } from '@/lib/push/devices';
import { ReadOnlyNotice, SaveBar, useSettingsForm } from './settings-form';

const CHANNEL_LABELS: Record<NotifyChannel, string> = {
  email: 'Email',
  push: 'Push',
  inapp: 'In-app',
};

export function NotificationsForm({
  prefs,
  email,
  timezone,
  readOnly,
  pushKey,
  devices,
}: {
  prefs: NotificationPrefs;
  email: string | null;
  timezone: string;
  readOnly: boolean;
  /** The server's VAPID public key, or null when push isn't set up. */
  pushKey: string | null;
  devices: PushDevice[];
}) {
  const { state, onSubmit, pending } = useSettingsForm(
    updateNotificationsAction,
  );
  // Turning push on for this device also switches this channel on.
  const [pushChannel, setPushChannel] = useState(prefs.channels.push);

  const channels: { id: NotifyChannel; icon: LucideIcon; help: string }[] = [
    {
      id: 'email',
      icon: Mail,
      help: email ? `Sent to ${email}` : 'Sent to your sign-in email',
    },
    {
      id: 'push',
      icon: Smartphone,
      help: 'On the phones and computers where you turn push on below',
    },
    {
      id: 'inapp',
      icon: AppWindow,
      help: 'The notification bell inside your dashboard',
    },
  ];

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      {readOnly ? (
        <ReadOnlyNotice>
          You&apos;re exploring the demo workspace, so these preferences are
          read-only.
        </ReadOnlyNotice>
      ) : (
        <ReadOnlyNotice>
          In-app and push notifications are live and follow these choices.
          Email isn&apos;t connected yet, so that column is saved for later.
        </ReadOnlyNotice>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Delivery channels</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {channels.map((c) => {
            const Icon = c.icon;
            return (
              <div
                key={c.id}
                className="flex items-center justify-between gap-4"
              >
                <div className="flex items-center gap-3">
                  <div className="grid size-9 place-items-center rounded-lg bg-muted text-muted-foreground">
                    <Icon className="size-4" />
                  </div>
                  <div>
                    <p className="font-medium">{CHANNEL_LABELS[c.id]}</p>
                    <p className="text-sm text-muted-foreground">{c.help}</p>
                  </div>
                </div>
                <Switch
                  name={`channel.${c.id}`}
                  {...(c.id === 'push'
                    ? { checked: pushChannel, onCheckedChange: setPushChannel }
                    : { defaultChecked: prefs.channels[c.id] })}
                  disabled={readOnly}
                  aria-label={CHANNEL_LABELS[c.id]}
                />
              </div>
            );
          })}
        </CardContent>
      </Card>

      <PushDeviceCard
        pushKey={pushKey}
        devices={devices}
        readOnly={readOnly}
        onTurnedOn={() => setPushChannel(true)}
      />

      <Card>
        <CardHeader>
          <CardTitle>What you get notified about</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <div className="min-w-[28rem]">
              <div className="flex items-center gap-4 pb-2">
                <div className="min-w-0 flex-1" />
                <div className="flex shrink-0 gap-1 text-xs font-medium text-muted-foreground">
                  {NOTIFY_CHANNELS.map((c) => (
                    <span key={c} className="w-14 text-center">
                      {CHANNEL_LABELS[c]}
                    </span>
                  ))}
                </div>
              </div>
              <Separator />
              <div className="divide-y">
                {NOTIFY_EVENTS.map((e) => (
                  <div key={e.id} className="flex items-center gap-4 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">{e.name}</p>
                      <p className="text-sm text-muted-foreground">{e.help}</p>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      {NOTIFY_CHANNELS.map((c) => (
                        <div key={c} className="flex w-14 justify-center">
                          <Checkbox
                            name={`event.${e.id}.${c}`}
                            defaultChecked={prefs.events[e.id][c]}
                            disabled={readOnly}
                            aria-label={`${e.name} — ${CHANNEL_LABELS[c]}`}
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <p className="mt-4 text-xs text-muted-foreground">
            Security alerts are always on and can&apos;t be turned off.
          </p>
        </CardContent>
      </Card>

      <Card>
        {/* Nothing reads these yet: the choice is saved, and the controls stay in the form for the one Save. */}
        <CardHeader>
          <CardTitle>Quiet hours</CardTitle>
          <CardAction>
            <Badge variant="secondary">Coming soon</Badge>
          </CardAction>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="font-medium">Pause notifications overnight</p>
              <p className="text-sm text-muted-foreground">
                Saved for later. Quiet hours don&apos;t hold or pause any
                notifications yet.
              </p>
            </div>
            <Switch
              name="quietEnabled"
              defaultChecked={prefs.quiet.enabled}
              disabled={readOnly}
              aria-label="Enable quiet hours"
            />
          </div>
          <Separator />
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="quiet-from">From</Label>
              <Select
                name="quietFrom"
                defaultValue={prefs.quiet.from}
                disabled={readOnly}
              >
                <SelectTrigger id="quiet-from" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {QUIET_TIMES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="quiet-to">To</Label>
              <Select
                name="quietTo"
                defaultValue={prefs.quiet.to}
                disabled={readOnly}
              >
                <SelectTrigger id="quiet-to" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {QUIET_TIMES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <p className="text-sm text-muted-foreground">
            Times shown in {timezone}.
          </p>
        </CardContent>
      </Card>

      <SaveBar state={state} pending={pending} disabled={readOnly} />
    </form>
  );
}
