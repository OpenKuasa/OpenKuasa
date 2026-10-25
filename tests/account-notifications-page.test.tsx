import { afterEach, describe, expect, it, vi } from 'vitest';

/** The Notifications page only offers push when all three VAPID values are set. */

const form = vi.fn<(props: unknown) => null>(() => null);
vi.mock('@/components/account/notifications-form', () => ({ NotificationsForm: (p: unknown) => form(p) }));
vi.mock('@/lib/account/data', () => ({
  getProfile: async () => ({ notificationPrefs: {}, email: 'a@b.co', timezone: 'Asia/Kuala_Lumpur' }),
}));
vi.mock('@/lib/auth/viewer', () => ({
  getViewer: async () => ({ isDemo: true }),
  hasSupabaseEnv: () => false,
}));
vi.mock('@/lib/push/devices', () => ({ listPushDevices: async () => [] }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({}) }));

import NotificationsPage from '@/app/account/notifications/page';

async function pushKeyProp(): Promise<unknown> {
  form.mockClear();
  const tree = (await NotificationsPage()) as { props: { children: unknown } };
  const kids = ([] as unknown[]).concat(tree.props.children);
  const el = kids.find((k) => (k as { type?: unknown })?.type === form.constructor || typeof (k as { type?: unknown })?.type === 'function') as
    | { props: { pushKey: unknown } }
    | undefined;
  return el?.props.pushKey;
}

describe('NotificationsPage push key', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('passes the public key only when the private key and subject are set too', async () => {
    vi.stubEnv('NEXT_PUBLIC_VAPID_PUBLIC_KEY', 'pub');
    vi.stubEnv('VAPID_PRIVATE_KEY', '');
    vi.stubEnv('VAPID_SUBJECT', 'mailto:ops@example.com');
    expect(await pushKeyProp()).toBeNull();

    vi.stubEnv('VAPID_PRIVATE_KEY', 'priv');
    expect(await pushKeyProp()).toBe('pub');

    vi.stubEnv('VAPID_SUBJECT', 'nonsense');
    expect(await pushKeyProp()).toBeNull();
  });
});
