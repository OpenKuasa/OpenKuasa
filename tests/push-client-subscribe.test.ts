import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { subscribeThisDevice } from '@/lib/push/client';

// A 65-byte-ish public key in base64url; only its bytes matter here.
const PUBLIC_KEY = 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U';

type Hooks = {
  order: string[];
  unsubscribe: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  fetchMock: ReturnType<typeof vi.fn>;
};

function setup(opts: {
  existing?: boolean;
  registered?: boolean;
  response?: () => Promise<Response>;
}): Hooks {
  const order: string[] = [];
  const unsubscribe = vi.fn(async () => true);
  const makeSub = () => ({
    endpoint: 'https://push.example/abc',
    options: { applicationServerKey: null },
    toJSON: () => ({ keys: { p256dh: 'p', auth: 'a' } }),
    unsubscribe,
  });
  const subscribe = vi.fn(async () => {
    order.push('subscribe');
    return makeSub();
  });
  const reused = { ...makeSub(), options: { applicationServerKey: null as ArrayBuffer | null } };
  const pushManager = {
    getSubscription: vi.fn(async () => (opts.existing ? reused : null)),
    subscribe,
  };
  const reg = { pushManager };
  const serviceWorker = {
    getRegistration: vi.fn(async () => (opts.registered ? reg : undefined)),
    register: vi.fn(async () => {
      order.push('register');
      return reg;
    }),
    get ready() {
      order.push('ready');
      return Promise.resolve(reg);
    },
  };
  const fetchMock = vi.fn(opts.response ?? (async () => new Response('{}', { status: 200 })));
  vi.stubGlobal('Notification', {
    requestPermission: vi.fn(async () => {
      order.push('permission');
      return 'granted';
    }),
  });
  vi.stubGlobal('navigator', { serviceWorker, userAgent: 'Chrome/130 Macintosh', maxTouchPoints: 0 });
  vi.stubGlobal('fetch', fetchMock);
  return { order, unsubscribe, subscribe, fetchMock };
}

const json = (status: number, code?: string) => async () =>
  new Response(JSON.stringify(code ? { code } : {}), { status });

describe('subscribeThisDevice', () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it('asks for permission first, then waits for the worker before subscribing', async () => {
    const h = setup({});
    expect(await subscribeThisDevice(PUBLIC_KEY)).toEqual({ ok: true });
    expect(h.order).toEqual(['permission', 'register', 'ready', 'subscribe']);
  });

  it('also waits for the worker when it was already registered', async () => {
    const h = setup({ registered: true });
    await subscribeThisDevice(PUBLIC_KEY);
    expect(h.order).toEqual(['permission', 'ready', 'subscribe']);
  });

  it.each(['PUSH_DEMO', 'PUSH_TOO_MANY', 'PUSH_NOT_SIGNED_IN', 'PUSH_BAD_SUBSCRIPTION'])(
    'unsubscribes the new subscription on a %s refusal',
    async (code) => {
      const h = setup({ response: json(403, code) });
      const result = await subscribeThisDevice(PUBLIC_KEY);
      expect(result.ok).toBe(false);
      expect(h.unsubscribe).toHaveBeenCalledTimes(1);
    },
  );

  it('unsubscribes the new subscription when the request fails to send', async () => {
    const h = setup({ response: async () => Promise.reject(new TypeError('offline')) });
    const result = await subscribeThisDevice(PUBLIC_KEY);
    expect(result.ok).toBe(false);
    expect(h.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it.each([429, 500])('leaves the subscription on a %s', async (status) => {
    const h = setup({ response: json(status) });
    const result = await subscribeThisDevice(PUBLIC_KEY);
    expect(result.ok).toBe(false);
    expect(h.unsubscribe).not.toHaveBeenCalled();
  });

  it('leaves a coded refusal 4xx alone when it is not one of the four', async () => {
    const h = setup({ response: json(400, 'SOMETHING_ELSE') });
    await subscribeThisDevice(PUBLIC_KEY);
    expect(h.unsubscribe).not.toHaveBeenCalled();
  });
});
