import { Suspense } from 'react';
import { CommandChat } from '@/components/command/command-chat';
import { getViewer } from '@/lib/auth/viewer';
import { loadServerGreeting } from '@/lib/greeting/server';
import { listThreads } from '@/lib/chat/store';
import { createClient } from '@/lib/supabase/server';

export default async function CommandPage() {
  // The list of chats comes with the page, so it is on screen at first paint
  // instead of after a second request. Demo guests have no saved chats.
  const viewer = await getViewer();
  const threads = viewer.isDemo
    ? []
    : await listThreads(await createClient(), viewer.orgId);
  const listedAt = new Date().toISOString();

  // The chat reads `?chat=` from the address bar, which needs a boundary.
  return (
    <Suspense fallback={null}>
      <CommandChat
        initialThreads={threads}
        listedAt={listedAt}
        greeting={await loadServerGreeting('tuah')}
      />
    </Suspense>
  );
}
