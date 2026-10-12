import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  LOGO_REMOVE_PROMPT,
  logoButtonLabels,
  logoCardMode,
  focusAfterConfirmClose,
  isSampleLogo,
  logoShowsImage,
  runLogoSave,
} from '@/lib/account/logo-screens';

describe('focusAfterConfirmClose', () => {
  it('goes to Remove while a logo remains, else to the pick button', () => {
    expect(focusAfterConfirmClose({ hasLogo: true })).toBe('remove');
    expect(focusAfterConfirmClose({ hasLogo: false })).toBe('pick');
  });
});

describe('isSampleLogo', () => {
  it('is true only for the demo asset', () => {
    expect(isSampleLogo('/demo-logo.png')).toBe(true);
    expect(isSampleLogo('https://x.supabase.co/storage/v1/object/public/org-logos/a/b.png')).toBe(false);
    expect(isSampleLogo(null)).toBe(false);
  });
});

describe('runLogoSave', () => {
  const file = new File(['x'], 'a.png', { type: 'image/png' });
  type Deps = Parameters<typeof runLogoSave>[1];
  const make = (over: Partial<Deps> = {}) => {
    const calls: string[] = [];
    const deps: Deps = {
      prepare: async () => (calls.push('prepare'), { ok: true as const, input: file }),
      pathFor: () => (calls.push('path'), 'org/p.png'),
      upload: async () => (calls.push('upload'), { ok: true as const, data: { path: 'org/p.png' } }),
      attach: async () => (calls.push('attach'), { ok: true as const, data: { logo_path: 'org/p.png' } }),
      urlOf: (p) => `u:${p}`,
      ...over,
    };
    return { calls, deps };
  };
  it('runs prepare, path, upload, attach in order and returns the new url', async () => {
    const { calls, deps } = make();
    expect(await runLogoSave(file, deps)).toEqual({ ok: true, url: 'u:org/p.png' });
    expect(calls).toEqual(['prepare', 'path', 'upload', 'attach']);
  });
  it('uploads nothing when prepare refuses', async () => {
    const { calls, deps } = make({ prepare: async () => ({ ok: false as const, error: 'not image' }) });
    expect(await runLogoSave(file, deps)).toEqual({ ok: false, error: 'not image' });
    expect(calls).toEqual([]);
  });
  it('calls no action when the upload fails', async () => {
    const { calls, deps } = make({ upload: async () => ({ ok: false as const, error: 'up failed' }) });
    expect(await runLogoSave(file, deps)).toEqual({ ok: false, error: 'up failed' });
    expect(calls).not.toContain('attach');
  });
  it('reports the sentence and no new logo when the attach is refused', async () => {
    const { deps } = make({ attach: async () => ({ ok: false as const, error: 'nope' }) });
    const r = await runLogoSave(file, deps);
    expect(r).toEqual({ ok: false, error: 'nope' });
    expect('url' in r).toBe(false);
  });
});

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
