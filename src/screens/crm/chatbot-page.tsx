import { getViewer, hasSupabaseEnv } from '@/lib/auth/viewer';
import {
  createKnowledgeEntry,
  deleteKnowledgeEntry,
  loadChatbot,
  loadChatbotActivity,
  parseChatbotSettingsForm,
  parseKnowledgeForm,
  readKnowledgeId,
  resumeChatbot,
  saveChatbotSettings,
  updateKnowledgeEntry,
  type Chatbot,
  type ChatbotActivity,
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

async function resumeAction(_prev: CrmFormState, formData: FormData) {
  'use server';
  const { orgId, userId } = await getViewer();
  const supabase = await createClient();

  return runCrmWrite(CHATBOT_PATH, formData, 'Could not switch the chat back on.', () =>
    resumeChatbot(supabase, orgId, userId),
  );
}

const ACTIONS = {
  saveSettings: saveSettingsAction,
  saveEntry: saveEntryAction,
  removeEntry: removeEntryAction,
  resume: resumeAction,
};

/**
 * Kasturi's AI Chatbot screen: how the workspace's customer bot behaves, what
 * it knows, a chat to try it, and what customers have asked it on landing
 * pages. Falls back to the sample screen when no database is configured.
 */
export default async function ChatbotPage() {
  if (!hasSupabaseEnv()) return <SampleChatbotScreen />;

  // The layout already loaded the viewer for this request; this reuses it.
  const { orgId, role } = await getViewer();
  const supabase = await createClient();

  let bot: Chatbot | null = null;
  let activity: ChatbotActivity | null = null;
  let hasKey = false;
  try {
    // Fetched together: each trip to the database costs about the same.
    const [loaded, loadedActivity, key] = await Promise.all([
      loadChatbot(supabase, orgId),
      loadChatbotActivity(supabase, orgId, new Date()),
      supabase.rpc('org_ai_key_status'),
    ]);
    bot = loaded;
    activity = loadedActivity;
    // The public chat runs on the workspace's own key or not at all.
    hasKey = Array.isArray(key.data) ? key.data.length > 0 : Boolean(key.data);
  } catch (error) {
    // The migration is applied to a database separately from a deploy, so the
    // tables can be missing for a while. Keep the page up meanwhile.
    console.error('[crm/chatbot] could not load the bot', error);
  }

  if (!bot || !activity) return <SampleChatbotScreen />;
  return (
    <ChatbotView
      settings={bot.settings}
      saved={bot.saved}
      knowledge={bot.knowledge}
      pausedReason={bot.pausedReason}
      activity={activity}
      hasKey={hasKey}
      // Viewers can read the bot but the database refuses their writes.
      actions={role === 'viewer' ? undefined : ACTIONS}
    />
  );
}
