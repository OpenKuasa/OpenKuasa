import { describe, expect, it } from 'vitest';
import {
  deviceLabel,
  pushSupport,
  pushErrorMessage,
  sameKey,
  urlBase64ToUint8Array,
  type PushEnv,
} from '@/lib/push/client';

const UA = {
  chromeMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  safariMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  safariIphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  chromeIphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.0.0 Mobile/15E148 Safari/604.1',
  chromeAndroid:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  samsungAndroid:
    'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36',
  edgeWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
  firefoxWindows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0',
  firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0',
  chromebook:
    'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
};

describe('deviceLabel', () => {
  it('names the browser and the device', () => {
    expect(deviceLabel(UA.chromeMac)).toBe('Chrome on Mac');
    expect(deviceLabel(UA.safariMac)).toBe('Safari on Mac');
    expect(deviceLabel(UA.safariIphone)).toBe('Safari on iPhone');
    expect(deviceLabel(UA.chromeIphone)).toBe('Chrome on iPhone');
    expect(deviceLabel(UA.chromeAndroid)).toBe('Chrome on Android');
    expect(deviceLabel(UA.samsungAndroid)).toBe('Samsung Internet on Android');
    expect(deviceLabel(UA.edgeWindows)).toBe('Edge on Windows');
    expect(deviceLabel(UA.firefoxWindows)).toBe('Firefox on Windows');
    expect(deviceLabel(UA.firefoxLinux)).toBe('Firefox on Linux');
    expect(deviceLabel(UA.chromebook)).toBe('Chrome on Chromebook');
  });

  it('calls an iPad that reports itself as a Mac an iPad', () => {
    expect(deviceLabel(UA.safariMac, 5)).toBe('Safari on iPad');
  });

  it('falls back to a plain name for something it does not know', () => {
    expect(deviceLabel('')).toBe('Browser');
    expect(deviceLabel('curl/8.0')).toBe('Browser');
  });

  it('stays short', () => {
    expect(deviceLabel(UA.samsungAndroid).length).toBeLessThanOrEqual(80);
  });
});

const READY: PushEnv = {
  publicKey: 'BPub',
  userAgent: UA.chromeMac,
  maxTouchPoints: 0,
  standalone: false,
  hasServiceWorker: true,
  hasPushManager: true,
  hasNotification: true,
};

describe('pushSupport', () => {
  it('is ok in a browser with everything push needs', () => {
    expect(pushSupport(READY)).toBe('ok');
  });

  it('says not configured when the server has no key, before anything else', () => {
    expect(pushSupport({ ...READY, publicKey: null })).toBe('not-configured');
    expect(pushSupport({ ...READY, publicKey: '' })).toBe('not-configured');
    expect(
      pushSupport({ ...READY, publicKey: null, userAgent: UA.safariIphone, hasPushManager: false }),
    ).toBe('not-configured');
  });

  it('asks an iPhone or iPad in a browser tab to add the app to the Home Screen first', () => {
    const tab = { ...READY, userAgent: UA.safariIphone, hasPushManager: false, hasNotification: false };
    expect(pushSupport(tab)).toBe('ios-needs-install');
    expect(pushSupport({ ...READY, userAgent: UA.safariMac, maxTouchPoints: 5, hasPushManager: false })).toBe(
      'ios-needs-install',
    );
  });

  it('is ok on an iPhone once the app is on the Home Screen', () => {
    expect(pushSupport({ ...READY, userAgent: UA.safariIphone, standalone: true })).toBe('ok');
  });

  it('is unsupported when the browser lacks a piece', () => {
    expect(pushSupport({ ...READY, hasServiceWorker: false })).toBe('unsupported');
    expect(pushSupport({ ...READY, hasPushManager: false })).toBe('unsupported');
    expect(pushSupport({ ...READY, hasNotification: false })).toBe('unsupported');
    expect(
      pushSupport({ ...READY, userAgent: UA.safariIphone, standalone: true, hasPushManager: false }),
    ).toBe('unsupported');
  });
});

describe('pushErrorMessage', () => {
  it('turns the server codes into plain words', () => {
    expect(pushErrorMessage('PUSH_DEMO')).toMatch(/demo/i);
    expect(pushErrorMessage('PUSH_TOO_MANY')).toMatch(/10 devices/);
    expect(pushErrorMessage('PUSH_NOT_SIGNED_IN')).toMatch(/sign in/i);
    expect(pushErrorMessage('PUSH_BAD_SUBSCRIPTION')).toMatch(/browser/i);
    expect(pushErrorMessage(undefined)).toMatch(/try again/i);
  });
});

describe('urlBase64ToUint8Array', () => {
  it('decodes a url-safe key without padding', () => {
    // 0xfb 0xff 0xfe is "-__-" in base64url and "+//+" in base64.
    expect(Array.from(urlBase64ToUint8Array('-__-'))).toEqual([0xfb, 0xff, 0xfe]);
    expect(Array.from(urlBase64ToUint8Array('AQI'))).toEqual([1, 2]);
  });
});

describe('sameKey', () => {
  it('matches only the same bytes', () => {
    const key = urlBase64ToUint8Array('AQI');
    expect(sameKey(new Uint8Array([1, 2]).buffer, key)).toBe(true);
    expect(sameKey(new Uint8Array([1, 3]).buffer, key)).toBe(false);
    expect(sameKey(new Uint8Array([1, 2, 3]).buffer, key)).toBe(false);
    expect(sameKey(null, key)).toBe(false);
  });
});
