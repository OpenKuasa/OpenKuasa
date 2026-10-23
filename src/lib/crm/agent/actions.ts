import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { createFollowUp, type CrmFollowUpInsert } from '@/lib/crm/follow-ups';
import type { CapResult } from '@/lib/reach/capabilities';

/** The owner-session context the apply path runs Kasturi's agent actions under. */
export type CrmAgentWriteContext = { client: SupabaseClient; orgId: string; userId: string };

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export const crmFollowUpInput = z.object({
  contactId: z.string().uuid(),
  title: z.string().trim().min(1).max(200),
  dueDay: z.string().regex(DAY).refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), 'Invalid day'),
});

export const crmAgentNoteInput = z
  .object({
    dealId: z.string().uuid().optional(),
    contactId: z.string().uuid().optional(),
    body: z.string().trim().min(1).max(1000),
  })
  .refine((v) => (v.dealId === undefined) !== (v.contactId === undefined), {
    message: 'Give either a deal or a contact, not both',
  });

/** Adds a follow-up task for a contact, reusing the same insert the chat tool and screen use. */
export async function crmCreateFollowUp(
  ctx: CrmAgentWriteContext,
  input: z.infer<typeof crmFollowUpInput>,
): Promise<CapResult<null>> {
  const payload: CrmFollowUpInsert = {
    org_id: ctx.orgId,
    contact_id: input.contactId,
    type: 'task',
    title: input.title,
    due_at: `${input.dueDay}T00:00:00Z`,
    owner_user_id: ctx.userId,
  };
  try {
    await createFollowUp(ctx.client, payload);
    return { ok: true, data: null };
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    console.error('[crm-agent] follow-up failed:', code);
    return { ok: false, error: 'That follow-up could not be added.' };
  }
}

/**
 * Adds a note through the `crm_add_agent_note` RPC, which itself only accepts a note that
 * matches an approved proposal. This function does not decide that.
 */
export async function crmCreateAgentNote(
  ctx: CrmAgentWriteContext,
  input: z.infer<typeof crmAgentNoteInput>,
): Promise<CapResult<{ id: string }>> {
  const { data, error } = await ctx.client.rpc('crm_add_agent_note', {
    p_deal_id: input.dealId ?? null,
    p_contact_id: input.contactId ?? null,
    p_body: input.body,
  });
  if (error || !data) {
    console.error('[crm-agent] note failed:', error?.code);
    return { ok: false, error: 'That note could not be added.' };
  }
  return { ok: true, data: { id: String(data) } };
}
