import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  LOGO_REMOVE_PROMPT,
  logoButtonLabels,
  logoCardMode,
  logoShowsImage,
} from '@/lib/account/logo-screens';

describe('logoCardMode', () => {
  it('lets an owner and an admin edit', () => {
    expect(logoCardMode({ role: 'owner', isDemo: false })).toBe('edit');
    expect(logoCardMode({ role: 'admin', isDemo: false })).toBe('edit');
  });
  it('shows a member and a viewer the logo and no control', () => {
    expect(logoCardMode({ role: 'member', isDemo: false })).toBe('view');
    expect(logoCardMode({ role: 'viewer', isDemo: false })).toBe('view');
  });
  it('shows the demo the sample and no control, even for an owner', () => {
    expect(logoCardMode({ role: 'owner', isDemo: true })).toBe('demo');
    expect(logoCardMode({ role: 'viewer', isDemo: true })).toBe('demo');
  });
  it('gives no control for unknown or malformed input', () => {
    for (const bad of [
      null,
      undefined,
      'owner',
      42,
      {},
      { role: 'owner' },
      { role: 'OWNER', isDemo: false },
      { role: 'root', isDemo: false },
      { role: 'owner', isDemo: 'false' },
      { role: 'owner', isDemo: 0 },
      { role: ['owner'], isDemo: false },
    ]) {
      expect(logoCardMode(bad)).toBe('view');
    }
  });
});

describe('logoButtonLabels', () => {
  it('says Upload with no logo and Replace with one', () => {
    expect(logoButtonLabels({ hasLogo: false, working: 'idle' })).toEqual({ pick: 'Upload logo', remove: null });
    expect(logoButtonLabels({ hasLogo: true, working: 'idle' })).toEqual({ pick: 'Replace logo', remove: 'Remove logo' });
  });
  it('names what is happening on the acting button', () => {
    expect(logoButtonLabels({ hasLogo: true, working: 'saving' })).toEqual({ pick: 'Saving…', remove: 'Remove logo' });
    expect(logoButtonLabels({ hasLogo: true, working: 'removing' })).toEqual({ pick: 'Replace logo', remove: 'Removing…' });
    expect(logoButtonLabels({ hasLogo: false, working: 'saving' }).pick).toBe('Saving…');
  });
});

describe('logoShowsImage', () => {
  it('shows an image only for a url that has not failed', () => {
    expect(logoShowsImage({ url: '/a.png', failed: false })).toBe(true);
    expect(logoShowsImage({ url: '/a.png', failed: true })).toBe(false);
    expect(logoShowsImage({ url: null, failed: false })).toBe(false);
    expect(logoShowsImage({ url: '', failed: false })).toBe(false);
  });
});

describe('the remove step', () => {
  it('uses the agreed sentence', () => {
    expect(LOGO_REMOVE_PROMPT).toBe('Remove the workspace logo? Letters will show the company name only.');
  });
});

describe('who names the logo actions', () => {
  const read = (p: string) => readFileSync(p, 'utf8');
  it('only the editing card imports them, and only from the actions file', () => {
    const card = read('src/components/account/logo-card.tsx');
    expect(card).toMatch(/from '@\/app\/account\/logo-actions'/);
    for (const m of card.matchAll(/from '([^']*logo-actions[^']*)'/g)) expect(m[1]).toBe('@/app/account/logo-actions');
    expect(card).not.toMatch(/logo-server/);
    for (const f of [
      'src/components/account/logo-card-view.tsx',
      'src/components/account/logo-picture.tsx',
      'src/lib/account/logo-screens.ts',
      'src/app/account/company/page.tsx',
    ]) {
      const src = read(f);
      expect(src, f).not.toMatch(/setLogoAction|clearLogoAction|logo-actions|uploadLogoFile/);
    }
  });
  it('the page decides with the pure function and renders the editor only for edit', () => {
    const page = read('src/app/account/company/page.tsx');
    expect(page).toContain('logoCardMode');
    expect(page).toMatch(/mode === 'edit'/);
  });
});
