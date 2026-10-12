import { describe, expect, it } from 'vitest';
import { DEFAULT_NOTIFICATION_PREFS, NOTIFY_EVENTS, resolveNotificationPrefs } from '@/config/account';

// The ids are the two event names the database passes to private.deliver_notification.
const FILED = 'hr_request_filed';
const DECIDED = 'hr_request_decided';

describe('the manager notification events', () => {
  it('lists both in the preferences screen', () => {
    const ids = NOTIFY_EVENTS.map((e) => e.id) as string[];
    expect(ids).toContain(FILED);
    expect(ids).toContain(DECIDED);
  });

  it('defaults both to in-app only', () => {
    for (const id of [FILED, DECIDED] as const) {
      expect(DEFAULT_NOTIFICATION_PREFS.events[id]).toEqual({ email: false, push: false, inapp: true });
    }
  });

  it('resolves both on for a workspace that stored nothing', () => {
    const prefs = resolveNotificationPrefs({});
    expect(prefs.events[FILED].inapp).toBe(true);
    expect(prefs.events[DECIDED].inapp).toBe(true);
  });

  it('keeps a stored switch-off', () => {
    const prefs = resolveNotificationPrefs({ events: { hr_request_decided: { inapp: false } } });
    expect(prefs.events[DECIDED].inapp).toBe(false);
    expect(prefs.events[FILED].inapp).toBe(true);
  });

  it('resolves a value stored before this release (no key for either) to on', () => {
    const prefs = resolveNotificationPrefs({
      channels: { email: true, push: false, inapp: true },
      events: { new_leads: { email: true, push: true, inapp: true } },
    });
    expect(prefs.events[FILED]).toEqual({ email: false, push: false, inapp: true });
    expect(prefs.events[DECIDED]).toEqual({ email: false, push: false, inapp: true });
  });
});
