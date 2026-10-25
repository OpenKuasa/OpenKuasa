import { beforeEach, expect, test, vi } from 'vitest';

// Turning push on for a device also switches the Push channel on in the person's saved
// preferences. The database and the session are stand-ins; nothing reaches the network.
const { createClient, recordEvent, getViewer, revalidatePath } = vi.hoisted(() => ({
  createClient: vi.fn(),
  recordEvent: vi.fn(),
  getViewer: vi.fn(),
  revalidatePath: vi.fn(),
}));
vi.mock('@/lib/supabase/server', () => ({ createClient }));
vi.mock('@/lib/events', () => ({ recordEvent }));
vi.mock('@/lib/auth/viewer', () => ({ getViewer }));
vi.mock('next/cache', () => ({ revalidatePath }));

import { turnOnPushChannelAction } from '@/app/account/actions';

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function db(stored: unknown, options: { readError?: boolean; updated?: boolean } = {}) {
  const writes: { prefs: Record<string, unknown>; userId: unknown }[] = [];
  const client = {
    from: vi.fn(() => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () =>
            options.readError
              ? { data: null, error: { message: 'boom' } }
              : { data: { notification_prefs: stored }, error: null },
        }),
      }),
      update: (values: { notification_prefs: Record<string, unknown> }) => ({
        eq: (_col: string, userId: unknown) => ({
          select: async () => {
            writes.push({ prefs: values.notification_prefs, userId });
            return { data: options.updated === false ? [] : [{ user_id: USER }], error: null };
          },
        }),
      }),
    })),
  };
  createClient.mockResolvedValue(client);
  return writes;
}

beforeEach(() => {
  vi.clearAllMocks();
  getViewer.mockResolvedValue({ userId: USER, isDemo: false });
});

test('switches the Push channel on and keeps every other saved choice', async () => {
  const writes = db({
    channels: { email: false, push: false, inapp: true },
    events: { new_leads: { email: false, push: false, inapp: false } },
    quiet: { enabled: true, from: '22:00', to: '07:00' },
  });
  const result = await turnOnPushChannelAction();
  expect(result).toEqual({ notice: 'Push is on for this device.' });
  expect(writes).toHaveLength(1);
  expect(writes[0].userId).toBe(USER);
  const prefs = writes[0].prefs as {
    channels: Record<string, boolean>;
    events: Record<string, Record<string, boolean>>;
    quiet: Record<string, unknown>;
  };
  expect(prefs.channels).toEqual({ email: false, push: true, inapp: true });
  expect(prefs.events.new_leads).toEqual({ email: false, push: false, inapp: false });
  expect(prefs.quiet).toEqual({ enabled: true, from: '22:00', to: '07:00' });
  expect(revalidatePath).toHaveBeenCalledWith('/account/notifications');
});

test('works for a person who never saved preferences', async () => {
  const writes = db(null);
  await turnOnPushChannelAction();
  const prefs = writes[0].prefs as { channels: Record<string, boolean>; events: Record<string, Record<string, boolean>> };
  expect(prefs.channels.push).toBe(true);
  expect(prefs.events.hr_request_filed.push).toBe(true);
});

test('refuses in the demo workspace without touching the database', async () => {
  getViewer.mockResolvedValue({ userId: USER, isDemo: true });
  const result = await turnOnPushChannelAction();
  expect(result?.error).toMatch(/demo/i);
  expect(createClient).not.toHaveBeenCalled();
});

test('says so when the preferences cannot be read or saved', async () => {
  db(null, { readError: true });
  expect((await turnOnPushChannelAction())?.error).toMatch(/try again/i);
  db(null, { updated: false });
  expect((await turnOnPushChannelAction())?.error).toMatch(/try again/i);
});
