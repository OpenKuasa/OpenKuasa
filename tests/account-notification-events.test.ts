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

  it('defaults a request waiting for you to in-app and push, and a decision to in-app only', () => {
    expect(DEFAULT_NOTIFICATION_PREFS.events[FILED]).toEqual({ email: false, push: true, inapp: true });
    expect(DEFAULT_NOTIFICATION_PREFS.events[DECIDED]).toEqual({ email: false, push: false, inapp: true });
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
    expect(prefs.events[FILED]).toEqual({ email: false, push: true, inapp: true });
    expect(prefs.events[DECIDED]).toEqual({ email: false, push: false, inapp: true });
  });

  it('keeps a stored push switch-off for requests waiting for you', () => {
    const prefs = resolveNotificationPrefs({ events: { hr_request_filed: { push: false } } });
    expect(prefs.events[FILED]).toEqual({ email: false, push: false, inapp: true });
  });
});

// The two Lekiu roster events the database passes to private.deliver_notification
// (20261125090400_people_roster_notify_swaps.sql).
describe('the roster and shift swap notification events', () => {
  const ROSTER = 'hr_roster_changed';
  const SWAP = 'hr_shift_swap';

  it('lists both in the preferences screen, in-app only by default', () => {
    const ids = NOTIFY_EVENTS.map((e) => e.id) as string[];
    for (const id of [ROSTER, SWAP] as const) {
      expect(ids).toContain(id);
      expect(DEFAULT_NOTIFICATION_PREFS.events[id]).toEqual({ email: false, push: false, inapp: true });
    }
  });

  it('resolves both on for a value stored before this release, and keeps a switch-off', () => {
    const before = resolveNotificationPrefs({ events: { hr_request_filed: { email: false, push: false, inapp: true } } });
    expect(before.events[ROSTER].inapp).toBe(true);
    expect(before.events[SWAP].inapp).toBe(true);
    const off = resolveNotificationPrefs({ events: { hr_shift_swap: { inapp: false } } });
    expect(off.events[SWAP].inapp).toBe(false);
    expect(off.events[ROSTER].inapp).toBe(true);
  });
});
