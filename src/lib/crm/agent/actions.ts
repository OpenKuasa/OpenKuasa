import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { CrmContactFormError } from '@/lib/crm/contacts';
import { klDay } from '@/lib/crm/deal-stats';
import { createFollowUp, parseDueDate, type CrmFollowUpInsert } from '@/lib/crm/follow-ups';
import type { CapResult } from '@/lib/reach/capabilities';

/** The owner-session context the apply path runs Kasturi's agent actions under. */
export type CrmAgentWriteContext = { client: SupabaseClient; orgId: string; userId: string };

/** True for a `YYYY-MM-DD` that exists (rejects 2026-02-30), using the follow-up form's own parser. */
function isRealDay(value: string): boolean {
  try {
    parseDueDate(value);
    return true;
  } catch {
    return false;
  }
}

export const crmFollowUpInput = z.object({
  contactId: z.string().uuid(),
  title: z.string().trim().min(1).max(200),
  dueDay: z.string().refine(isRealDay, 'Invalid day'),
});

export const crmAgentNoteInput = z
  .object({
    dealId: z.string().uuid().optional(),
    contactId: z.string().uuid().optional(),
    // Never trimmed: crm_add_agent_note matches the approved proposal's exact text.
    body: z
      .string()
      .min(1)
      .max(1000)
      .refine((s) => s.trim().length > 0, 'Write a note'),
  })
  .refine((v) => (v.dealId === undefined) !== (v.contactId === undefined), {
    message: 'Give either a deal or a contact, not both',
  });

/**
 * Adds a follow-up task for a contact, reusing the same insert the chat tool and screen use.
 * A proposed due day that has already come (the suggestion waited) moves to the next
 * Kuala Lumpur day, so approving never creates a task that is already overdue.
 */
export async function crmCreateFollowUp(
  ctx: CrmAgentWriteContext,
  input: z.infer<typeof crmFollowUpInput>,
): Promise<CapResult<null>> {
  const tomorrow = klDay(new Date(Date.now() + 86_400_000));
  const dueDay = input.dueDay < tomorrow ? tomorrow : input.dueDay;
  const payload: CrmFollowUpInsert = {
    org_id: ctx.orgId,
    contact_id: input.contactId,
    type: 'task',
    title: input.title,
    due_at: `${dueDay}T00:00:00Z`,
    owner_user_id: ctx.userId,
  };
  try {
    await createFollowUp(ctx.client, payload);
    return { ok: true, data: null };
  } catch (error) {
    if (error instanceof CrmContactFormError) return { ok: false, error: error.message };
    console.error('[crm-agent] follow-up failed:', (error as { code?: string } | null)?.code ?? 'unknown');
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
