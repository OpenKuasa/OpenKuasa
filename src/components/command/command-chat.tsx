'use client';

import { useSearchParams } from 'next/navigation';
import { SariConversation } from '@/components/command/sari-conversation';
import type { ChatThread } from '@/lib/chat/threads';
import type { ServerGreeting } from '@/lib/greeting/types';

export function CommandChat({
  initialThreads,
  listedAt,
  greeting,
}: {
  /** The viewer's chats as the page was rendered; `null` if they could not be read. */
  initialThreads: ChatThread[] | null;
  listedAt: string;
  /** The personal greeting, when the page computed one. */
  greeting?: ServerGreeting;
}) {
  const urlThreadId = useSearchParams().get('chat');
  return (
    <SariConversation
      showSidebar
      urlThreadId={urlThreadId}
      initialThreads={initialThreads}
      listedAt={listedAt}
      greeting={greeting}
    />
  );
}
