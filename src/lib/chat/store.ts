/**
 * Reads and writes the signed-in user's saved threads. Runs as the user, so
 * row level security decides what may be read or written. Saving is best
 * effort: a failure is logged and the conversation carries on unsaved.
 */

import { errorCodeOf } from '@/lib/ai/call-log';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getCurrentOrg } from '@/lib/auth/current-org';
import { storeQuestionFiles } from '@/lib/chat/attachment-store';
import { storedParts, type StoredPart } from '@/lib/chat/stored-parts';
import { questionTitle, textParts, type ChatThread } from '@/lib/chat/threads';

type Role = 'user' | 'assistant';

const THREAD_LIMIT = 200;

/** The user's threads in one workspace, newest first. `null` on failure. */
export async function listThreads(
  supabase: SupabaseClient,
  orgId: string,
): Promise<ChatThread[] | null> {
  const { data, error } = await supabase
    .from('chat_threads')
    .select('id, title, updated_at')
    .eq('org_id', orgId)
    .order('updated_at', { ascending: false })
    .limit(THREAD_LIMIT);
  if (error) {
    console.error('[chat] could not list threads:', errorCodeOf(error));
    return null;
  }
  return (data ?? []).map((row) => ({
    id: row.id as string,
    title: row.title as string,
    updatedAt: row.updated_at as string,
  }));
}

async function insertMessage(
  supabase: SupabaseClient,
  threadId: string,
  role: Role,
  parts: StoredPart[],
): Promise<boolean> {
  const { error } = await supabase
    .from('chat_messages')
    .insert({ thread_id: threadId, role, parts });
  if (error) console.error('[chat] could not save a message:', errorCodeOf(error));
  return !error;
}

/**
 * Saves the question that starts this turn, creating the thread on its first
 * question. Resolves to whether the thread is usable for the answer.
 */
export async function saveQuestion(
  supabase: SupabaseClient,
  userId: string,
  threadId: string,
  parts: unknown,
): Promise<boolean> {
  try {
    // Files go to storage and are saved as pointers; one that could not be
    // kept is remembered by name, as all of them were before files were stored.
    const words = textParts(parts);
    const { kept, lost } = await storeQuestionFiles(supabase, userId, threadId, parts);
    const question: StoredPart[] = [...kept, ...words];
    if (lost.length > 0) {
      const note = `[Attached: ${lost.join(', ')}]`;
      question.push({ type: 'text', text: question.length > 0 ? `\n\n${note}` : note });
    }
    if (question.length === 0) return false;

    const { data: existing, error: readErr } = await supabase
      .from('chat_threads')
      .select('id')
      .eq('id', threadId)
      .maybeSingle();
    if (readErr) throw readErr;

    if (existing) {
      // Asking again moves the thread back to the top of the list.
      const { error } = await supabase
        .from('chat_threads')
        .update({ updated_at: new Date().toISOString() })
        .eq('id', threadId);
      if (error) throw error;
    } else {
      const org = await getCurrentOrg(supabase);
      if (!org) return false;
      const { error } = await supabase.from('chat_threads').insert({
        id: threadId,
        org_id: org.orgId,
        user_id: userId,
        title: questionTitle(parts),
      });
      if (error) throw error;
    }

    return await insertMessage(supabase, threadId, 'user', question);
  } catch (error) {
    console.error('[chat] could not save the question:', errorCodeOf(error));
    return false;
  }
}

/**
 * Saves the assistant's reply: its words, and the lookups and changes it went
 * through, so a chat opened again shows the same cards. A change still
 * waiting for approval is saved as waiting, and can be answered later.
 */
export async function saveAnswer(
  supabase: SupabaseClient,
  threadId: string,
  parts: unknown,
): Promise<void> {
  const answer = storedParts(parts).filter((part) => part.type !== 'file');
  if (answer.length === 0) return;
  await insertMessage(supabase, threadId, 'assistant', answer);
}
