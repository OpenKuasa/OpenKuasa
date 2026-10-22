'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { getViewer } from '@/lib/auth/viewer';
import { can } from '@/lib/auth/permissions';
import { approveProposal, rejectProposal, screensToRefresh, type DecideResult } from '@/lib/agents/decide-proposal';

const proposalIdInput = z.object({ id: z.string().uuid() });
const INVALID = 'That input was not valid.';
const FORBIDDEN = 'You do not have permission to make changes here.';

/** Parse → guard → decide (routed by the proposal's product) → revalidate its screen. */
async function decide(
  input: unknown,
  fn: (...args: Parameters<typeof approveProposal>) => Promise<DecideResult>,
): Promise<{ ok: boolean; error?: string }> {
  const parsed = proposalIdInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: INVALID };
  const viewer = await getViewer();
  if (viewer.isDemo || !can(viewer.role, 'edit-data')) return { ok: false, error: FORBIDDEN };
  const client = await createClient();
  const { screenPath, ...result } = await fn(client, viewer.orgId, viewer.userId, parsed.data.id);
  for (const path of screensToRefresh({ screenPath })) revalidatePath(path);
  return result;
}

/** Approve a queued suggestion; the agent that owns its product applies it. */
export async function applyProposalAction(input: unknown): Promise<{ ok: boolean; error?: string }> {
  return decide(input, approveProposal);
}

/** Dismiss a queued suggestion: mark it rejected, apply nothing. */
export async function rejectProposalAction(input: unknown): Promise<{ ok: boolean; error?: string }> {
  return decide(input, rejectProposal);
}
