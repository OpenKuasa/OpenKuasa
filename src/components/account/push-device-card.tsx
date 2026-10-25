'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { turnOnPushChannelAction } from '@/app/account/actions';
import {
  browserPushEnv,
  pushSupport,
  removePushDevice,
  subscribeThisDevice,
  thisDeviceEndpoint,
  unsubscribeThisDevice,
  type PushSupport,
} from '@/lib/push/client';
import type { PushDevice } from '@/lib/push/devices';

type Support = PushSupport | 'checking';

const SUPPORT_NOTES: Partial<Record<Support, string>> = {
  'not-configured': "Push isn't set up on this server.",
  'ios-needs-install':
    'Add OpenKuasa to your Home Screen first (Share → Add to Home Screen), then turn push on here.',
  unsupported: "This browser can't get push notifications. Try Chrome, Edge, Firefox or Safari.",
};

/** The card as it looks for a given state. The browser work is in `PushDeviceCard`. */
export function PushDeviceCardView({
  support,
  subscribed,
  thisEndpoint,
  devices,
  readOnly,
  busy,
  message,
  onTurnOn,
  onTurnOff,
  onRemove,
}: {
  support: Support;
  subscribed: boolean;
  thisEndpoint: string | null;
  devices: PushDevice[];
  readOnly: boolean;
  busy: boolean;
  message: string | null;
  onTurnOn: () => void;
  onTurnOff: () => void;
  onRemove: (endpoint: string) => void;
}) {
  const note = SUPPORT_NOTES[support];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Push on this device</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="font-medium">
              {subscribed ? 'Push is on here' : 'Get notifications on this device'}
            </p>
            <p className="text-sm text-muted-foreground">
              {note ??
                'Turn push on for each phone or computer you use. Push follows the Push ticks above.'}
            </p>
          </div>
          {support === 'ok' &&
            (subscribed ? (
              <Button type="button" variant="outline" onClick={onTurnOff} disabled={readOnly || busy}>
                Turn off
              </Button>
            ) : (
              <Button type="button" onClick={onTurnOn} disabled={readOnly || busy}>
                Turn on
              </Button>
            ))}
        </div>
        {message && (
          <p role="status" className="text-sm text-muted-foreground">
            {message}
          </p>
        )}

        <Separator />

        <div className="space-y-2">
          <p className="text-sm font-medium">Your devices</p>
          {devices.length === 0 ? (
            <p className="text-sm text-muted-foreground">No devices have push on yet.</p>
          ) : (
            <ul className="divide-y">
              {devices.map((d) => {
                const label = d.label || 'Unknown device';
                return (
                  <li key={d.id} className="flex items-center justify-between gap-4 py-2">
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 truncate font-medium">
                        {label}
                        {d.endpoint === thisEndpoint && <Badge variant="secondary">This device</Badge>}
                      </p>
                      <p className="text-sm text-muted-foreground">Added {d.added}</p>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => onRemove(d.endpoint)}
                      disabled={readOnly || busy}
                      aria-label={`Remove ${label}`}
                    >
                      Remove
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Turns push on or off for this browser and lists the person's devices. Turning it on
 * also switches the Push channel on (`onTurnedOn` lets the form show that).
 */
export function PushDeviceCard({
  pushKey,
  devices,
  readOnly,
  onTurnedOn,
}: {
  pushKey: string | null;
  devices: PushDevice[];
  readOnly: boolean;
  onTurnedOn: () => void;
}) {
  const router = useRouter();
  const [support, setSupport] = useState<Support>(pushKey ? 'checking' : 'not-configured');
  const [thisEndpoint, setThisEndpoint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const found = pushSupport(browserPushEnv(pushKey));
    void (async () => {
      const endpoint = found === 'ok' ? await thisDeviceEndpoint() : null;
      if (!live) return;
      setSupport(found);
      setThisEndpoint(endpoint);
    })();
    return () => {
      live = false;
    };
  }, [pushKey]);

  // This browser counts as on only when it's one of this person's devices: someone else
  // may have turned push on in the same browser.
  const subscribed = thisEndpoint !== null && devices.some((d) => d.endpoint === thisEndpoint);

  const run = async (work: () => Promise<string | null>) => {
    setBusy(true);
    setMessage(null);
    try {
      setMessage(await work());
    } finally {
      setBusy(false);
      router.refresh();
    }
  };

  const turnOn = () =>
    run(async () => {
      if (!pushKey) return null;
      const result = await subscribeThisDevice(pushKey);
      if (!result.ok) return result.error;
      setThisEndpoint(await thisDeviceEndpoint());
      const saved = await turnOnPushChannelAction();
      if (saved?.error) return saved.error;
      onTurnedOn();
      return 'Push is on for this device.';
    });

  const turnOff = () =>
    run(async () => {
      const result = await unsubscribeThisDevice();
      setThisEndpoint(null);
      return result.ok ? 'Push is off for this device.' : result.error;
    });

  const remove = (endpoint: string) => {
    if (endpoint === thisEndpoint) return turnOff();
    return run(async () =>
      (await removePushDevice(endpoint)) ? 'Device removed.' : "Couldn't remove that device. Please try again.",
    );
  };

  return (
    <PushDeviceCardView
      support={support}
      subscribed={subscribed}
      thisEndpoint={thisEndpoint}
      devices={devices}
      readOnly={readOnly}
      busy={busy}
      message={message}
      onTurnOn={() => void turnOn()}
      onTurnOff={() => void turnOff()}
      onRemove={(endpoint) => void remove(endpoint)}
    />
  );
}
