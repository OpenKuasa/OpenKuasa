// Browser side of push: can this device get push, and turning it on or off here.
// Used only from client components. The checks are plain functions of a small
// `PushEnv`, so they can be tested without a browser.

export type PushSupport = 'ok' | 'unsupported' | 'ios-needs-install' | 'not-configured';

/** What `pushSupport` looks at, read from the browser by `browserPushEnv`. */
export type PushEnv = {
  publicKey: string | null | undefined;
  userAgent: string;
  maxTouchPoints: number;
  /** Running as the installed app (Home Screen), not in a browser tab. */
  standalone: boolean;
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  hasNotification: boolean;
};

export type PushResult = { ok: true } | { ok: false; error: string };

const SW_PATH = '/sw.js';
const API = '/api/push/subscriptions';
const REFUSAL_CODES = new Set(['PUSH_DEMO', 'PUSH_TOO_MANY', 'PUSH_NOT_SIGNED_IN', 'PUSH_BAD_SUBSCRIPTION']);

const isIos = (userAgent: string, maxTouchPoints: number) =>
  /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);

/**
 * Whether this device can turn push on. No server key wins over everything else; an
 * iPhone or iPad only gets push once OpenKuasa is on its Home Screen (in a Safari tab
 * there is no push at all, so this is checked before the browser features).
 */
export function pushSupport(env: PushEnv): PushSupport {
  if (!env.publicKey) return 'not-configured';
  if (isIos(env.userAgent, env.maxTouchPoints) && !env.standalone) return 'ios-needs-install';
  if (!env.hasServiceWorker || !env.hasPushManager || !env.hasNotification) return 'unsupported';
  return 'ok';
}

/** Reads `PushEnv` from the running browser. */
export function browserPushEnv(publicKey: string | null | undefined): PushEnv {
  const nav = navigator as Navigator & { standalone?: boolean };
  const standalone =
    nav.standalone === true ||
    (typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches);
  return {
    publicKey,
    userAgent: nav.userAgent,
    maxTouchPoints: nav.maxTouchPoints ?? 0,
    standalone,
    hasServiceWorker: 'serviceWorker' in nav,
    hasPushManager: 'PushManager' in window,
    hasNotification: 'Notification' in window,
  };
}

/** A short name for this device, like "Chrome on Mac" or "Safari on iPhone". */
export function deviceLabel(userAgent: string, maxTouchPoints = 0): string {
  const ua = userAgent;
  const browser = /Edg(e|A|iOS)?\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
      ? 'Opera'
      : /SamsungBrowser\//.test(ua)
        ? 'Samsung Internet'
        : /Firefox\/|FxiOS\//.test(ua)
          ? 'Firefox'
          : /Chrome\/|CriOS\//.test(ua)
            ? 'Chrome'
            : /Safari\//.test(ua)
              ? 'Safari'
              : null;
  const device = /iPhone|iPod/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /CrOS/.test(ua)
          ? 'Chromebook'
          : /Windows/.test(ua)
            ? 'Windows'
            : /Macintosh|Mac OS X/.test(ua)
              ? 'Mac'
              : /Linux/.test(ua)
                ? 'Linux'
                : null;
  if (!browser) return 'Browser';
  return device ? `${browser} on ${device}` : browser;
}

/** Plain words for an error code from /api/push/subscriptions. */
export function pushErrorMessage(code: string | undefined): string {
  switch (code) {
    case 'PUSH_DEMO':
      return 'Push is off in the demo workspace.';
    case 'PUSH_TOO_MANY':
      return 'You can have push on up to 10 devices. Remove one below, then try again.';
    case 'PUSH_NOT_SIGNED_IN':
      return 'Please sign in again, then try again.';
    case 'PUSH_BAD_SUBSCRIPTION':
      return "This browser's push service isn't supported. Try another browser.";
    default:
      return "Couldn't turn push on. Please try again.";
  }
}

/** The VAPID public key (base64url) as bytes for `pushManager.subscribe`. */
export function urlBase64ToUint8Array(value: string): Uint8Array<ArrayBuffer> {
  const padded = value + '='.repeat((4 - (value.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** Whether a subscription's server key is this one. */
export function sameKey(current: ArrayBuffer | null | undefined, key: Uint8Array): boolean {
  if (!current) return false;
  const bytes = new Uint8Array(current);
  return bytes.length === key.length && bytes.every((b, i) => b === key[i]);
}

/**
 * The service worker. It's registered on every page in production only, so in
 * development the first Turn on registers it here.
 */
async function registration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration('/');
  if (!existing) await navigator.serviceWorker.register(SW_PATH, { scope: '/', updateViaCache: 'none' });
  // Subscribing needs an active worker; right after register() it is still installing.
  return navigator.serviceWorker.ready;
}

async function currentSubscription(): Promise<PushSubscription | null> {
  if (!('serviceWorker' in navigator)) return null;
  const reg = await navigator.serviceWorker.getRegistration('/');
  if (!reg?.pushManager) return null;
  return reg.pushManager.getSubscription();
}

/** This browser's push endpoint when push is on here, otherwise null. */
export async function thisDeviceEndpoint(): Promise<string | null> {
  try {
    return (await currentSubscription())?.endpoint ?? null;
  } catch {
    return null;
  }
}

/** Whether push is on for this browser. */
export async function thisDeviceSubscribed(): Promise<boolean> {
  return (await thisDeviceEndpoint()) !== null;
}

/** Asks for permission, subscribes this browser and saves it on the server. */
export async function subscribeThisDevice(publicKey: string): Promise<PushResult> {
  let permission: NotificationPermission;
  try {
    permission = await Notification.requestPermission();
  } catch {
    return { ok: false, error: "Couldn't ask for permission. Please try again." };
  }
  if (permission === 'default') {
    return { ok: false, error: 'Allow notifications when your browser asks, to turn push on.' };
  }
  if (permission !== 'granted') {
    return {
      ok: false,
      error: 'Notifications are blocked for this site. Allow them in your browser settings, then try again.',
    };
  }

  let sub: PushSubscription;
  // Only a subscription made by this call is undone when saving fails; a reused one was on already.
  let created = false;
  try {
    const reg = await registration();
    const key = urlBase64ToUint8Array(publicKey);
    const existing = await reg.pushManager.getSubscription();
    // A subscription made with an older server key can't receive anything now.
    if (existing && !sameKey(existing.options.applicationServerKey, key)) {
      await existing.unsubscribe().catch(() => false);
    }
    if (existing && sameKey(existing.options.applicationServerKey, key)) {
      sub = existing;
    } else {
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      created = true;
    }
  } catch {
    return { ok: false, error: "This browser couldn't turn push on. Please try again." };
  }

  const json = sub.toJSON();
  let res: Response;
  try {
    res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        endpoint: sub.endpoint,
        keys: { p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' },
        label: deviceLabel(navigator.userAgent, navigator.maxTouchPoints ?? 0),
      }),
    });
  } catch {
    // No answer at all: don't leave a subscription the server never heard of.
    if (created) await sub.unsubscribe().catch(() => false);
    return { ok: false, error: "Couldn't reach OpenKuasa. Check your connection and try again." };
  }
  if (res.ok) return { ok: true };

  // A coded refusal means the server won't keep this device, so don't leave the browser
  // subscribed on its own. Other failures (429, 500) are temporary and leave it for a retry.
  const body = (await res.json().catch(() => null)) as { code?: string } | null;
  if (created && body?.code && REFUSAL_CODES.has(body.code)) await sub.unsubscribe().catch(() => false);
  return { ok: false, error: pushErrorMessage(body?.code) };
}

/** Removes a device from the server by its endpoint. */
export async function removePushDevice(endpoint: string): Promise<boolean> {
  try {
    const res = await fetch(API, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Turns push off for this browser: removes it on the server, then unsubscribes here
 * either way (a dead subscription is cleared by the server on its next send).
 */
export async function unsubscribeThisDevice(): Promise<PushResult> {
  let sub: PushSubscription | null;
  try {
    sub = await currentSubscription();
  } catch {
    sub = null;
  }
  if (!sub) return { ok: true };
  const removed = await removePushDevice(sub.endpoint);
  await sub.unsubscribe().catch(() => false);
  return removed ? { ok: true } : { ok: false, error: "Push is off here, but the device list didn't update. Please refresh." };
}
