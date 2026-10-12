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
