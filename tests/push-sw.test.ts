import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * public/sw.js runs in the browser's service worker. Here it runs in a bare VM context with a
 * stand-in `self`, so the push and notificationclick handlers can be checked without a browser.
 */

const ORIGIN = 'https://openkuasa.com';
const source = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');

type Listener = (event: Record<string, unknown>) => void;
type FakeClient = { url: string; focus: ReturnType<typeof vi.fn>; navigate: ReturnType<typeof vi.fn> };

let listeners: Record<string, Listener>;
let shown: { title: string; options: Record<string, unknown> }[];
let windows: FakeClient[];
let opened: string[];
let posted: { url: string; init: { method: string; credentials: string; body: string } }[];
let current: unknown;
let subscribed: unknown[];

function load() {
  listeners = {};
  shown = [];
  opened = [];
  posted = [];
  subscribed = [];
  const self = {
    location: new URL(`${ORIGIN}/sw.js`),
    addEventListener: (type: string, fn: Listener) => {
      listeners[type] = fn;
    },
    registration: {
      showNotification: async (title: string, options: Record<string, unknown>) => {
        shown.push({ title, options });
      },
      pushManager: {
        getSubscription: async () => current,
        subscribe: async (opts: unknown) => {
          subscribed.push(opts);
          return fakeSub('https://fcm.googleapis.com/fcm/send/fresh');
        },
      },
    },
    clients: {
      matchAll: async () => windows,
      openWindow: async (url: string) => {
        opened.push(url);
        return null;
      },
      claim: async () => {},
    },
    skipWaiting: () => {},
  };
  const fetch = async (url: string, init: { method: string; credentials: string; body: string }) => {
    posted.push({ url, init });
    return new Response('{}');
  };
  runInNewContext(source, { self, URL, Response, fetch });
}

const fakeSub = (endpoint: string, key: unknown = 'server-key') => ({
  endpoint,
  options: { applicationServerKey: key },
  toJSON: () => ({ endpoint, keys: { p256dh: 'p-' + endpoint.slice(-3), auth: 'a' } }),
});

async function renew(event: Record<string, unknown>) {
  const pending: Promise<unknown>[] = [];
  listeners.pushsubscriptionchange({ ...event, waitUntil: (p: Promise<unknown>) => pending.push(p) });
  await Promise.all(pending);
}

async function push(data: unknown) {
  const pending: Promise<unknown>[] = [];
  listeners.push({
    data: data === undefined ? null : { json: () => (typeof data === 'string' ? JSON.parse(data) : data) },
    waitUntil: (p: Promise<unknown>) => pending.push(p),
  });
  await Promise.all(pending);
}

async function click(url: unknown) {
  const pending: Promise<unknown>[] = [];
  const close = vi.fn();
  listeners.notificationclick({
    notification: { data: { url }, close },
    waitUntil: (p: Promise<unknown>) => pending.push(p),
  });
  await Promise.all(pending);
  return close;
}

const client = (url: string, navigateOk = true): FakeClient => ({
  url,
  focus: vi.fn(async () => undefined),
  navigate: vi.fn(async () => {
    if (!navigateOk) throw new TypeError('not controlled');
    return undefined;
  }),
});

beforeEach(() => {
  windows = [];
  current = null;
  load();
});

describe('the service worker', () => {
  it('keeps the offline fallback', () => {
    expect(listeners.fetch).toBeTypeOf('function');
    expect(source).toContain("You're offline");
  });

  it('shows one notification per request, tagged with its id', async () => {
    await push({ title: 'Leave request', body: 'Aina asked for 2 days', url: '/people/leave', tag: 'n-1' });
    await push({ title: 'Leave request', body: 'Ben asked for 1 day', url: '/people/leave', tag: 'n-2' });
    expect(shown).toHaveLength(2);
    expect(shown[0].title).toBe('Leave request');
    expect(shown[0].options).toMatchObject({
      body: 'Aina asked for 2 days',
      tag: 'n-1',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { url: '/people/leave' },
    });
    expect(shown[1].options.tag).toBe('n-2');
  });

  it('still shows something for an empty or broken push', async () => {
    await push(undefined);
    await push('{not json');
    expect(shown).toHaveLength(2);
    expect(shown[0].title).toBe('OpenKuasa');
    expect(shown[1].options.data).toEqual({ url: '/command' });
  });

  it('replaces a link that leaves the site with /command', async () => {
    for (const url of ['https://evil.example/x', '//evil.example/x', '/\\evil.example', 'javascript:alert(1)', 42]) {
      await push({ title: 't', body: 'b', url, tag: 'x' });
    }
    expect(shown.map((s) => (s.options.data as { url: string }).url)).toEqual(Array(5).fill('/command'));
  });

  it('on click, focuses an open window and takes it to the link', async () => {
    const tab = client(`${ORIGIN}/command`);
    windows = [client('https://other.example/'), tab];
    const close = await click('/people/leave?id=1');
    expect(close).toHaveBeenCalled();
    expect(tab.navigate).toHaveBeenCalledWith(`${ORIGIN}/people/leave?id=1`);
    expect(tab.focus).toHaveBeenCalled();
    expect(opened).toEqual([]);
  });

  it('on click, opens a new window when none is open', async () => {
    await click('/people/leave');
    expect(opened).toEqual([`${ORIGIN}/people/leave`]);
  });

  it('on click, opens a new window when the open one cannot be moved', async () => {
    windows = [client(`${ORIGIN}/command`, false)];
    await click('/people/leave');
    expect(opened).toEqual([`${ORIGIN}/people/leave`]);
  });

  it('on click, never goes off the site', async () => {
    await click('https://evil.example/');
    await click('//evil.example/');
    expect(opened).toEqual([`${ORIGIN}/command`, `${ORIGIN}/command`]);
  });

  it('when the browser renews its push address, saves the new one in place of the old', async () => {
    const OLD = 'https://fcm.googleapis.com/fcm/send/old';
    const NEW = 'https://fcm.googleapis.com/fcm/send/new';
    await renew({ oldSubscription: fakeSub(OLD), newSubscription: fakeSub(NEW) });
    expect(posted).toHaveLength(1);
    expect(posted[0].url).toBe('/api/push/subscriptions');
    expect(posted[0].init.method).toBe('POST');
    expect(posted[0].init.credentials).toBe('same-origin');
    expect(JSON.parse(posted[0].init.body)).toEqual({ endpoint: NEW, keys: { p256dh: 'p-new', auth: 'a' }, replaces: OLD });
  });

  it('re-subscribes with the old server key when the browser gives no new address', async () => {
    const OLD = 'https://fcm.googleapis.com/fcm/send/old';
    await renew({ oldSubscription: fakeSub(OLD, 'the-key'), newSubscription: null });
    expect(subscribed).toEqual([{ userVisibleOnly: true, applicationServerKey: 'the-key' }]);
    expect(JSON.parse(posted[0].init.body)).toMatchObject({ endpoint: 'https://fcm.googleapis.com/fcm/send/fresh', replaces: OLD });
  });

  it('uses the subscription the browser already has, with no old address to replace', async () => {
    current = fakeSub('https://fcm.googleapis.com/fcm/send/cur');
    await renew({});
    expect(subscribed).toEqual([]);
    expect(JSON.parse(posted[0].init.body)).toMatchObject({ endpoint: 'https://fcm.googleapis.com/fcm/send/cur', replaces: null });
  });

  it('does nothing when there is nothing to save', async () => {
    await renew({});
    const same = fakeSub('https://fcm.googleapis.com/fcm/send/same');
    await renew({ oldSubscription: same, newSubscription: same });
    expect(posted).toEqual([]);
  });
});
