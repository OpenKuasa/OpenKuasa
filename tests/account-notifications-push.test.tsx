import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * Account → Notifications: the "Push on this device" card and the banner above the form.
 * The browser parts (permission, subscribe) can't run here, so the card's states are rendered
 * from the plain view component.
 */

vi.mock('@/app/account/actions', () => ({
  updateNotificationsAction: vi.fn(),
  turnOnPushChannelAction: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { PushDeviceCardView, type PushDevice } from '@/components/account/push-device-card';
import { NotificationsForm } from '@/components/account/notifications-form';
import { DEFAULT_NOTIFICATION_PREFS } from '@/config/account';

const noop = () => {};
const handlers = { onTurnOn: noop, onTurnOff: noop, onRemove: noop };

const PHONE: PushDevice = {
  id: 'd1',
  endpoint: 'https://fcm.googleapis.com/fcm/send/phone',
  label: 'Chrome on Android',
  added: '3 Oct 2026',
};
const LAPTOP: PushDevice = {
  id: 'd2',
  endpoint: 'https://web.push.apple.com/laptop',
  label: 'Safari on Mac',
  added: '20 Oct 2026',
};

type ViewProps = Parameters<typeof PushDeviceCardView>[0];
const view = (p: Partial<ViewProps>) =>
  renderToStaticMarkup(
    <PushDeviceCardView
      support="ok"
      subscribed={false}
      thisEndpoint={null}
      devices={[]}
      readOnly={false}
      busy={false}
      message={null}
      {...handlers}
      {...p}
    />,
  );

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');

describe('the Push on this device card', () => {
  it('offers Turn on when this device is not on', () => {
    const html = view({});
    expect(html).toContain('Push on this device');
    expect(html).toMatch(/<button[^>]*type="button"[^>]*>Turn on<\/button>/);
    expect(html).not.toContain('Turn off');
  });

  it('offers Turn off when this device is on', () => {
    const html = view({ subscribed: true, thisEndpoint: PHONE.endpoint, devices: [PHONE] });
    expect(html).toMatch(/>Turn off<\/button>/);
    expect(html).not.toMatch(/>Turn on<\/button>/);
  });

  it('says push is not set up when the server has no keys, with no button', () => {
    const html = view({ support: 'not-configured' });
    expect(text(html)).toContain("Push isn't set up on this server");
    expect(html).not.toMatch(/>Turn on<\/button>/);
  });

  it('tells an iPhone in a browser tab to add the app to the Home Screen first', () => {
    const html = view({ support: 'ios-needs-install' });
    expect(text(html)).toContain(
      'Add OpenKuasa to your Home Screen first (Share → Add to Home Screen), then turn push on here.',
    );
    expect(html).not.toMatch(/>Turn on<\/button>/);
  });

  it('says when this browser cannot do push', () => {
    const html = view({ support: 'unsupported' });
    expect(text(html)).toMatch(/This browser can.t get push notifications/);
    expect(html).not.toMatch(/>Turn on<\/button>/);
  });

  it('shows nothing to press while it is still checking the browser', () => {
    const html = view({ support: 'checking' });
    expect(html).not.toMatch(/>Turn on<\/button>/);
    expect(html).not.toMatch(/>Turn off<\/button>/);
  });

  it('disables the button in the demo workspace', () => {
    const html = view({ readOnly: true });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Turn on<\/button>/);
  });

  it('disables the button while it works', () => {
    expect(view({ busy: true })).toMatch(/<button[^>]*disabled=""[^>]*>[^<]*<\/button>/);
  });

  it('shows a message from the last try', () => {
    expect(view({ message: 'Notifications are blocked for this site.' })).toContain(
      'Notifications are blocked for this site.',
    );
  });

  it('lists your devices with when each was added, a Remove button, and marks this one', () => {
    const html = view({ subscribed: true, thisEndpoint: LAPTOP.endpoint, devices: [PHONE, LAPTOP] });
    const t = text(html);
    expect(t).toContain('Chrome on Android');
    expect(t).toContain('Added 3 Oct 2026');
    expect(t).toContain('Safari on Mac');
    expect(t).toContain('This device');
    expect(html.match(/>Remove<\/button>/g)).toHaveLength(2);
    expect(html).toContain('aria-label="Remove Chrome on Android"');
  });

  it('names a device with no label plainly', () => {
    const html = view({ devices: [{ ...PHONE, label: null }] });
    expect(text(html)).toContain('Unknown device');
  });

  it('says when no device has push on', () => {
    expect(text(view({}))).toContain('No devices have push on yet.');
  });

  it('keeps the device list even where this browser cannot do push, and disables Remove in the demo', () => {
    const html = view({ support: 'unsupported', devices: [PHONE], readOnly: true });
    expect(text(html)).toContain('Chrome on Android');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Remove<\/button>/);
  });
});

describe('the notifications banner', () => {
  const form = (readOnly = false) =>
    text(
      renderToStaticMarkup(
        <NotificationsForm
          prefs={DEFAULT_NOTIFICATION_PREFS}
          email="a@example.com"
          timezone="Asia/Kuala_Lumpur"
          readOnly={readOnly}
          pushKey="BPub"
          devices={[PHONE]}
        />,
      ),
    );

  it('no longer says push is not connected; email is still saved for later', () => {
    const t = form();
    expect(t).not.toMatch(/push[^.]*not connected yet/i);
    expect(t).toMatch(/Email[^.]*isn.t connected yet/);
    expect(t).toContain('saved for later');
  });

  it('shows the push card and the device list inside the page', () => {
    const t = form();
    expect(t).toContain('Push on this device');
    expect(t).toContain('Chrome on Android');
  });
});
