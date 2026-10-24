import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import manifest from '@/app/manifest';
import { installGuideFor, installStateFor, isAppleMobile } from '@/lib/pwa/install';

const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
  ipadAsMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15',
  macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15',
  macChrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/155.0.0.0 Safari/537.36',
  winEdge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0',
  android: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/155.0.0.0 Mobile Safari/537.36',
  firefox: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.0; rv:140.0) Gecko/20100101 Firefox/140.0',
};

describe('Get the app button', () => {
  test('hidden only inside the installed app', () => {
    expect(installStateFor({ standalone: true, hasPrompt: true })).toBe('hidden');
    expect(installStateFor({ standalone: true, hasPrompt: false })).toBe('hidden');
  });

  test("opens the browser's prompt when there is one, otherwise shows the steps", () => {
    expect(installStateFor({ standalone: false, hasPrompt: true })).toBe('prompt');
    expect(installStateFor({ standalone: false, hasPrompt: false })).toBe('steps');
  });

  test('picks the steps for each browser', () => {
    expect(installGuideFor(UA.iphone, 5)).toBe('ios');
    expect(installGuideFor(UA.ipadAsMac, 5)).toBe('ios');
    expect(installGuideFor(UA.macSafari, 0)).toBe('mac-safari');
    expect(installGuideFor(UA.macChrome, 0)).toBe('chrome-desktop');
    expect(installGuideFor(UA.winEdge, 0)).toBe('edge-desktop');
    expect(installGuideFor(UA.android, 5)).toBe('android');
    expect(installGuideFor(UA.firefox, 0)).toBe('other');
  });

  test('spots iPads that say they are a Mac only when they have touch', () => {
    expect(isAppleMobile(UA.ipadAsMac, 5)).toBe(true);
    expect(isAppleMobile(UA.macSafari, 0)).toBe(false);
  });
});

describe('app manifest', () => {
  const m = manifest();

  test('opens in its own window on the Tuah home', () => {
    expect(m.name).toBe('OpenKuasa');
    expect(m.display).toBe('standalone');
    expect(m.start_url).toBe('/command');
  });

  test('has the icon sizes browsers need, including a maskable one, and every file exists', () => {
    const icons = m.icons ?? [];
    expect(icons.map((i) => i.sizes)).toEqual(expect.arrayContaining(['192x192', '512x512']));
    expect(icons.some((i) => i.purpose === 'maskable')).toBe(true);
    for (const icon of icons) expect(existsSync(join('public', icon.src)), icon.src).toBe(true);
    expect(existsSync('src/app/apple-icon.png')).toBe(true);
    expect(existsSync('public/sw.js')).toBe(true);
  });

  test('no purple or violet in the app colours', () => {
    expect([m.theme_color, m.background_color]).toEqual(['#007a55', '#ffffff']);
  });
});
