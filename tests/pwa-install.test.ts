import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import manifest from '@/app/manifest';
import { installStateFor, isAppleMobile } from '@/lib/pwa/install';

describe('install link', () => {
  test('hidden once running as the installed app, even if a prompt is waiting', () => {
    expect(installStateFor({ standalone: true, hasPrompt: true, appleMobile: false })).toBe('hidden');
    expect(installStateFor({ standalone: true, hasPrompt: false, appleMobile: true })).toBe('hidden');
  });

  test("uses the browser's prompt when there is one", () => {
    expect(installStateFor({ standalone: false, hasPrompt: true, appleMobile: false })).toBe('prompt');
  });

  test('shows the Share steps on iPhone and iPad, where Safari has no prompt', () => {
    expect(installStateFor({ standalone: false, hasPrompt: false, appleMobile: true })).toBe('ios-steps');
  });

  test('hidden on browsers that cannot install (no prompt, not Apple mobile)', () => {
    expect(installStateFor({ standalone: false, hasPrompt: false, appleMobile: false })).toBe('hidden');
  });

  test('spots iPhones and iPads, including iPads that say they are a Mac', () => {
    expect(isAppleMobile('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', 5)).toBe(true);
    expect(isAppleMobile('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15', 5)).toBe(true);
    expect(isAppleMobile('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15', 0)).toBe(false);
    expect(isAppleMobile('Mozilla/5.0 (Linux; Android 15) Chrome/130', 5)).toBe(false);
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
