'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { KeyRound } from 'lucide-react';
import {
  getChatStatusAction,
  type ChatStatusForViewer,
} from '@/app/account/ai/actions';
import { cn } from '@/lib/utils';

const AI_KEY_HREF = '/account/ai';

/**
 * Loads who is paying for chat (workspace key or free questions) and lets the
 * chat refresh it after each turn. `null` until the first load.
 */
export function useChatStatus(enabled: boolean) {
  const [status, setStatus] = useState<ChatStatusForViewer | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await getChatStatusAction());
    } catch {
      // Keep the last known status; the server still enforces the rule.
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let current = true;
    const load = async () => {
      try {
        const next = await getChatStatusAction();
        if (current) setStatus(next);
      } catch {
        // The chat still works; the server enforces the rule either way.
      }
    };
    void load();
    return () => {
      current = false;
    };
  }, [enabled]);

  return { status, refresh };
}

/** True when the next question would be refused until a key is added. */
export function isChatLocked(status: ChatStatusForViewer | null): boolean {
  return (
    !!status && !status.isDemo && !status.hasKey && status.freeRemaining <= 0
  );
}

/** Shown when a turn is refused with code `daily_limit` (the per-user limit on a workspace key). */
export const DAILY_LIMIT_NOTICE =
  'That question was not sent: you have reached today\u2019s chat limit. It resets at midnight UTC (8 am Malaysia time).';

/** The chat endpoints answer `{ error, code }`; the SDK surfaces that body as the error message. */
export function chatErrorCode(error: Error | undefined): string | null {
  if (!error) return null;
  try {
    const body = JSON.parse(error.message) as { code?: unknown };
    return typeof body.code === 'string' ? body.code : null;
  } catch {
    return null;
  }
}

/**
 * The one line every chat shows while the workspace has no OpenRouter key:
 * how many free questions are left, and how to get unlimited chat.
 */
export function ChatKeyNotice({
  status,
  tone = 'default',
  className,
}: {
  status: ChatStatusForViewer | null;
  /** `onPrimary` for chats drawn on the brand-coloured hero. */
  tone?: 'default' | 'onPrimary';
  className?: string;
}) {
  if (!status || status.isDemo || status.hasKey) return null;

  const locked = status.freeRemaining <= 0;
  const linkClass =
    tone === 'onPrimary'
      ? 'font-semibold underline underline-offset-2 hover:opacity-90'
      : 'font-semibold text-primary hover:underline';

  return (
    <p
      role={locked ? 'alert' : 'note'}
      className={cn(
        'flex items-start gap-2 rounded-lg px-3 py-2 text-xs',
        tone === 'onPrimary'
          ? 'bg-primary-foreground/10 text-primary-foreground ring-1 ring-inset ring-primary-foreground/20'
          : 'border bg-muted/50 text-muted-foreground',
        className,
      )}
    >
      <KeyRound className="mt-0.5 size-3.5 shrink-0" />
      <span>
        {locked
          ? status.freeLimit > 0
            ? `You have used your ${status.freeLimit} free questions this week. `
            : 'Chat needs an OpenRouter key. '
          : `${status.freeRemaining} of ${status.freeLimit} free questions left this week. `}
        {status.canManageKey ? (
          <>
            <Link href={AI_KEY_HREF} className={linkClass}>
              Add your OpenRouter key
            </Link>{' '}
            {locked ? 'to keep chatting.' : 'for unlimited chat.'}
          </>
        ) : (
          <>
            Ask a workspace owner or admin to add an OpenRouter key
            {locked ? ' to keep chatting.' : ' for unlimited chat.'}
          </>
        )}
      </span>
    </p>
  );
}
