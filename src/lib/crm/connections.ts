import type { SupabaseClient } from '@supabase/supabase-js';
import { getEmailKeyStatus } from '@/lib/crm/email-key';

/** What Kasturi's sending and AI features run on, as Settings and Plugins show it. */
export type CrmConnections = {
  hasAiKey: boolean;
  /** The Resend sender address, or null when no email key is saved. */
  emailSender: string | null;
  /** Published landing pages with the chatbot on; null when it could not be counted. */
  pagesWithChat: number | null;
  /** Automations switched on; null when they could not be counted. */
  automationsOn: number | null;
};

/** A count that cannot be read is unknown (null), never zero. */
async function count(query: PromiseLike<{ count: number | null; error: unknown }>): Promise<number | null> {
  const { count: total, error } = await query;
  return error ? null : (total ?? 0);
}

/**
 * Reads the workspace's connections in one round of requests. A failed AI key
 * check throws: "Not set" could lead an owner to replace a working key.
 */
export async function loadCrmConnections(supabase: SupabaseClient, orgId: string): Promise<CrmConnections> {
  const [pagesWithChat, automationsOn, aiKey, emailKey] = await Promise.all([
    count(
      supabase
        .from('crm_landing_pages')
        .select('id', { count: 'exact', head: true })
        .eq('org_id', orgId)
        .eq('chat_enabled', true)
        .eq('status', 'published'),
    ),
    count(
      supabase.from('crm_automations').select('id', { count: 'exact', head: true }).eq('org_id', orgId).eq('enabled', true),
    ),
    supabase.rpc('org_ai_key_status'),
    getEmailKeyStatus(supabase),
  ]);
  if (aiKey.error) throw aiKey.error;
  return {
    hasAiKey: Array.isArray(aiKey.data) ? aiKey.data.length > 0 : Boolean(aiKey.data),
    emailSender: emailKey?.senderEmail ?? null,
    pagesWithChat,
    automationsOn,
  };
}
