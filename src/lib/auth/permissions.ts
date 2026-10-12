import type { OrgRole } from './current-org';

export type Capability =
  | 'view'
  | 'edit-data'
  | 'approve'
  | 'sign-off-finance'
  | 'manage-company'
  | 'manage-billing'
  | 'manage-members'
  | 'manage-ai-key'
  | 'manage-email-key'
  | 'send-broadcasts'
  | 'manage-agents'
  | 'manage-developers'
  | 'delete-workspace';

export const ROLES: OrgRole[] = ['owner', 'admin', 'member', 'viewer'];

/** The single source for what each role may do; the Team page renders it. */
export const PERMISSIONS: {
  capability: Capability;
  label: string;
  allow: OrgRole[];
}[] = [
  { capability: 'view', label: 'View dashboards', allow: ['owner', 'admin', 'member', 'viewer'] },
  { capability: 'edit-data', label: 'Manage contacts & deals', allow: ['owner', 'admin', 'member'] },
  { capability: 'approve', label: 'Approve leave & claims', allow: ['owner', 'admin'] },
  // Kept in step with private.finance_may_sign_off in the database, which is what enforces it.
  { capability: 'sign-off-finance', label: 'Post, pay & void finance documents', allow: ['owner', 'admin'] },
  { capability: 'manage-company', label: 'Edit company details', allow: ['owner', 'admin'] },
  { capability: 'manage-billing', label: 'Manage billing & plan', allow: ['owner', 'admin'] },
  { capability: 'manage-members', label: 'Invite & manage members', allow: ['owner', 'admin'] },
  { capability: 'manage-ai-key', label: 'Manage the workspace AI key', allow: ['owner', 'admin'] },
  { capability: 'manage-email-key', label: 'Manage the workspace email key', allow: ['owner', 'admin'] },
  // Kept in step with public.crm_begin_broadcast_send in the database, which is what enforces it.
  { capability: 'send-broadcasts', label: 'Send broadcasts by email', allow: ['owner', 'admin'] },
  { capability: 'manage-agents', label: 'Manage AI agents & their spend', allow: ['owner', 'admin'] },
  { capability: 'manage-developers', label: 'Manage API keys & webhooks', allow: ['owner'] },
  { capability: 'delete-workspace', label: 'Delete workspace', allow: ['owner'] },
];

export function can(role: OrgRole, capability: Capability): boolean {
  const rule = PERMISSIONS.find((p) => p.capability === capability);
  return rule ? rule.allow.includes(role) : false;
}

export function roleLabel(role: OrgRole): string {
  return role[0].toUpperCase() + role.slice(1);
}

/**
 * Whether a screen should be shown at all. Demo guests may look at everything
 * (read-only) so the demo still tours the whole product; real members only see
 * what their role covers.
 */
export function canSee(
  viewer: { role: OrgRole; isDemo: boolean },
  capability: Capability | undefined,
): boolean {
  if (!capability || viewer.isDemo) return true;
  return can(viewer.role, capability);
}
