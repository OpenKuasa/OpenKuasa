import { NotificationsForm } from '@/components/account/notifications-form';
import { getProfile } from '@/lib/account/data';
import { getViewer, hasSupabaseEnv } from '@/lib/auth/viewer';
import { listPushDevices } from '@/lib/push/devices';
import { pushConfig } from '@/lib/push/config';
import { createClient } from '@/lib/supabase/server';

export default async function NotificationsPage() {
  const [viewer, profile] = await Promise.all([getViewer(), getProfile()]);
  const devices =
    hasSupabaseEnv() && !viewer.isDemo
      ? await listPushDevices(await createClient(), profile.timezone)
      : [];

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Notifications</h1>
        <p className="text-sm text-muted-foreground">
          Choose what we tell you and how.
        </p>
      </div>

      <NotificationsForm
        prefs={profile.notificationPrefs}
        email={profile.email}
        timezone={profile.timezone}
        readOnly={viewer.isDemo}
        pushKey={pushConfig()?.publicKey ?? null}
        devices={devices}
      />
    </div>
  );
}
