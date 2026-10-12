import { z } from 'zod';
import { friendlyRpcError } from '@/lib/account/invites';

// The rules for a new workspace's name, shared by the sign-up form and checked
// again by public.create_org_for_current_user. KEEP IN STEP with
// supabase/migrations/20261030131500_demo_guests_cannot_create_workspaces.sql:
// tests/demo-guests-migration.test.ts checks the length there against this one.

export const WORKSPACE_NAME_MAX = 120;

const NAME_REQUIRED = 'Please enter your business name.';
const NAME_TOO_LONG = `Business name must be ${WORKSPACE_NAME_MAX} characters or fewer.`;

export const workspaceNameSchema = z
  .string()
  .trim()
  .min(1, NAME_REQUIRED)
  .max(WORKSPACE_NAME_MAX, NAME_TOO_LONG);

// Messages raised by create_org_for_current_user itself. The sign-in ones it
// shares with the invite functions come from friendlyRpcError.
const CREATE_MESSAGES: Record<string, string> = {
  'demo guests cannot create a workspace':
    'The demo is read-only. Sign up with your email to create your own workspace.',
  'workspace name required': NAME_REQUIRED,
  'workspace name too long': NAME_TOO_LONG,
};

/** Turns a failed create_org_for_current_user call into a sentence that is safe to show. */
export function createWorkspaceError(
  error: { message?: string | null } | null | undefined,
): string {
  const message = error?.message?.trim().toLowerCase() ?? '';
  return (
    CREATE_MESSAGES[message] ??
    friendlyRpcError(error, 'Could not create your workspace. Please try again.')
  );
}
