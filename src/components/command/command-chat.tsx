'use client';

import { useSearchParams } from 'next/navigation';
import { SariConversation } from '@/components/command/sari-conversation';
import { cleanAsk } from '@/lib/docs/ask';
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
  const searchParams = useSearchParams();
  const urlThreadId = searchParams.get('chat');
  // A question sent from the docs; it only fills the input.
  const askedQuestion = cleanAsk(searchParams.get('ask'));
  return (
    <SariConversation
      showSidebar
      urlThreadId={urlThreadId}
      askedQuestion={askedQuestion}
      initialThreads={initialThreads}
      listedAt={listedAt}
      greeting={greeting}
    />
  );
}
