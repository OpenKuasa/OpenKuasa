import { DEMO_LOGO_PATH } from '@/lib/account/logo-url';
import { can } from '@/lib/auth/permissions';
import type { OrgRole } from '@/lib/auth/current-org';

// Pure rules for the Logo card on the company details page. No imports of any action: a component drawn for
// members must be able to use this file.

export const LOGO_REMOVE_PROMPT = 'Remove the workspace logo? Letters will show the company name only.';
export const LOGO_EMPTY = 'No logo yet';
export const LOGO_DEMO_NOTE = 'Sample logo';

export type LogoCardMode = 'edit' | 'view' | 'demo';
export type LogoWorking = 'idle' | 'saving' | 'removing';

/**
 * Who gets which card. Only a real owner or admin outside the demo edits; the demo shows the sample with no
 * control whoever is looking; anything unknown or malformed (no role, a role not in the list, a flag that is not
 * a plain boolean) gets the read-only view. The server actions and the database check the role again.
 */
export function logoCardMode(viewer: unknown): LogoCardMode {
  if (typeof viewer !== 'object' || viewer === null) return 'view';
  const { role, isDemo } = viewer as { role?: unknown; isDemo?: unknown };
  if (isDemo === true) return 'demo';
  if (isDemo !== false) return 'view';
  if (role !== 'owner' && role !== 'admin') return 'view';
  return can(role as OrgRole, 'manage-company') ? 'edit' : 'view';
}

/** The two buttons' words for the current state; `remove: null` means there is nothing to remove. */
export function logoButtonLabels(state: { hasLogo: boolean; working: LogoWorking }): {
  pick: string;
  remove: string | null;
} {
  return {
    pick: state.working === 'saving' ? 'Saving…' : state.hasLogo ? 'Replace logo' : 'Upload logo',
    remove: !state.hasLogo ? null : state.working === 'removing' ? 'Removing…' : 'Remove logo',
  };
}

/** The picture shows only for a web address that has not failed to load; otherwise the empty state does. */
export function logoShowsImage(state: { url: string | null; failed: boolean }): boolean {
  return Boolean(state.url) && !state.failed;
}

/** Which control takes focus when the Remove confirmation closes: Remove while a logo remains, else the pick button. */
export function focusAfterConfirmClose(state: { hasLogo: boolean }): 'remove' | 'pick' {
  return state.hasLogo ? 'remove' : 'pick';
}

/** True only for the demo's shipped sample asset, not for a demo workspace's own logo. */
export function isSampleLogo(url: string | null): boolean {
  return url === DEMO_LOGO_PATH;
}

type Outcome<T> = { ok: true; data: T } | { ok: false; error: string };

/**
 * The save sequence with its collaborators passed in: check the file (nothing is uploaded when it is refused),
 * build the path, upload, then attach. An upload failure calls no action; a refused attach returns its sentence
 * and no url, so the caller keeps the old logo.
 */
export async function runLogoSave(
  chosen: File,
  deps: {
    prepare: (file: File) => Promise<{ ok: true; input: File } | { ok: false; error: string }>;
    pathFor: (file: File) => string;
    upload: (path: string, file: File) => Promise<Outcome<{ path: string }>>;
    attach: (path: string) => Promise<Outcome<{ logo_path: string }>>;
    urlOf: (path: string) => string | null;
  },
): Promise<{ ok: true; url: string | null } | { ok: false; error: string }> {
  const prepared = await deps.prepare(chosen);
  if (!prepared.ok) return { ok: false, error: prepared.error };
  const path = deps.pathFor(prepared.input);
  const up = await deps.upload(path, prepared.input);
  if (!up.ok) return { ok: false, error: up.error };
  const set = await deps.attach(path);
  if (!set.ok) return { ok: false, error: set.error };
  return { ok: true, url: deps.urlOf(set.data.logo_path) };
}
