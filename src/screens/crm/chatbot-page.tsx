import { getViewer, hasSupabaseEnv } from '@/lib/auth/viewer';
import {
  createKnowledgeEntry,
  deleteKnowledgeEntry,
  loadChatbot,
  parseChatbotSettingsForm,
  parseKnowledgeForm,
  readKnowledgeId,
  saveChatbotSettings,
  updateKnowledgeEntry,
  type Chatbot,
} from '@/lib/crm/chatbot';
import type { CrmFormState } from '@/lib/crm/form-state';
import { runCrmWrite } from '@/lib/crm/run-write';
import { createClient } from '@/lib/supabase/server';
import SampleChatbotScreen from './chatbot';
import { ChatbotView } from './chatbot-view';

const CHATBOT_PATH = '/crm/chatbot';

async function saveSettingsAction(_prev: CrmFormState, formData: FormData) {
  'use server';
  const { orgId, userId } = await getViewer();
  const supabase = await createClient();

  return runCrmWrite(CHATBOT_PATH, formData, 'Could not save the bot.', () =>
    saveChatbotSettings(supabase, orgId, parseChatbotSettingsForm(formData), userId),
  );
}

async function saveEntryAction(_prev: CrmFormState, formData: FormData) {
  'use server';
  const { orgId, userId } = await getViewer();
  const supabase = await createClient();

  return runCrmWrite(CHATBOT_PATH, formData, 'Could not save the entry.', async () => {
    if (formData.has('entryId')) {
      await updateKnowledgeEntry(supabase, orgId, readKnowledgeId(formData), parseKnowledgeForm(formData));
    } else {
      await createKnowledgeEntry(supabase, orgId, parseKnowledgeForm(formData), userId);
    }
  });
}

async function removeEntryAction(_prev: CrmFormState, formData: FormData) {
  'use server';
  const { orgId } = await getViewer();
  const supabase = await createClient();

  return runCrmWrite(CHATBOT_PATH, formData, 'Could not delete the entry.', () =>
    deleteKnowledgeEntry(supabase, orgId, readKnowledgeId(formData)),
  );
}

const ACTIONS = {
  saveSettings: saveSettingsAction,
  saveEntry: saveEntryAction,
  removeEntry: removeEntryAction,
};

/**
 * Kasturi's AI Chatbot screen: how the workspace's customer bot behaves, what
 * it knows, and a chat to try it. Falls back to the sample screen when no
 * database is configured.
 */
export default async function ChatbotPage() {
  if (!hasSupabaseEnv()) return <SampleChatbotScreen />;

  // The layout already loaded the viewer for this request; this reuses it.
  const { orgId, role } = await getViewer();
  const supabase = await createClient();

  let bot: Chatbot | null = null;
  try {
    bot = await loadChatbot(supabase, orgId);
  } catch (error) {
    // The migration is applied to a database separately from a deploy, so the
    // tables can be missing for a while. Keep the page up meanwhile.
    console.error('[crm/chatbot] could not load the bot', error);
  }

  if (!bot) return <SampleChatbotScreen />;
  return (
    <ChatbotView
      settings={bot.settings}
      saved={bot.saved}
      knowledge={bot.knowledge}
      // Viewers can read the bot but the database refuses their writes.
      actions={role === 'viewer' ? undefined : ACTIONS}
    />
  );
}
