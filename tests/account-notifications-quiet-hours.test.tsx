import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * Account → Notifications: nothing holds notifications during quiet hours yet, so the card says so. The choice is
 * still saved: the controls stay switched on and in the form, or the one Save would lose (and reject) them.
 */

vi.mock('@/app/account/actions', () => ({ updateNotificationsAction: vi.fn(), turnOnPushChannelAction: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { NotificationsForm } from '@/components/account/notifications-form';
import { DEFAULT_NOTIFICATION_PREFS } from '@/config/account';

const screen = () =>
  renderToStaticMarkup(
    <NotificationsForm prefs={DEFAULT_NOTIFICATION_PREFS} email={null} timezone="Asia/Kuala_Lumpur" readOnly={false} pushKey={null} devices={[]} />,
  );

describe('the quiet hours card', () => {
  it('marks quiet hours as coming soon instead of promising to hold alerts', () => {
    const html = screen();
    expect(html).not.toContain('hold non-urgent alerts');
    expect(html).toContain('Coming soon');
    expect(html).toContain('Saved for later. Quiet hours don&#x27;t hold or pause any notifications yet.');
  });

  it('keeps the quiet-hours choices in the form so Save still sends them', () => {
    const html = screen();
    expect(html).toMatch(/<button[^>]*aria-label="Enable quiet hours"(?![^>]*disabled)[^>]*>/);
    expect(html).not.toMatch(/id="quiet-from"[^>]*disabled/);
    expect(html).not.toMatch(/id="quiet-to"[^>]*disabled/);
  });
});
