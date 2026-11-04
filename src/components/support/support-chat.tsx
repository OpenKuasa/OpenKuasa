'use client';

/**
 * The support page's Live chat: Sari answering from the guides (POST /api/support/chat).
 * Signed-out visitors and demo guests get a sign-in link instead, and never reach the model.
 */

import { useRef, useState } from 'react';
import Link from 'next/link';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, type UIMessage } from 'ai';
import { ArrowUp, Loader2 } from 'lucide-react';
import { ReplyText } from '@/components/chat/reply-text';
import { Button } from '@/components/ui/button';
import { chatErrorCode } from '@/components/chat/chat-key-notice';

export const SUPPORT_QUESTION_CHARS = 1000;

const textOf = (message: UIMessage) =>
  message.parts.map((part) => (part.type === 'text' ? part.text : '')).join('');

/** The server's `{ error }` sentence, or a plain fallback. */
function errorSentence(error: Error | undefined, email: string): string {
  if (!error) return '';
  try {
    const body = JSON.parse(error.message) as { error?: unknown };
    if (typeof body.error === 'string' && body.error) return body.error;
  } catch {
    // Not one of ours: a dropped connection or the like.
  }
  return `Something went wrong. Please try again, or email us at ${email}.`;
}

export function SupportChat({ canChat, email, limit }: { canChat: boolean; email: string; limit: number }) {
  const [input, setInput] = useState('');
  const [transport] = useState(() => new DefaultChatTransport({ api: '/api/support/chat' }));
  const { messages, sendMessage, status, error } = useChat({ transport, throttle: 50 });
  const endRef = useRef<HTMLDivElement>(null);
  const busy = status === 'submitted' || status === 'streaming';
  const usedUp = chatErrorCode(error) === 'support_limit';

  if (!canChat) {
    return (
      <div className="rounded-xl border border-mk-border bg-mk-bg p-4 text-sm text-mk-muted">
        <p>Sign in to chat with Sari. Answers come from our guides.</p>
        <Button asChild className="mt-3 rounded-full px-4">
          <Link href="/login?next=%2Fsupport">Sign in to chat</Link>
        </Button>
      </div>
    );
  }

  const send = () => {
    const question = input.trim();
    if (!question || busy || usedUp) return;
    setInput('');
    void sendMessage({ text: question }).then(() => endRef.current?.scrollIntoView({ block: 'nearest' }));
  };

  return (
    <div className="space-y-3">
      {messages.length > 0 && (
        <div className="max-h-[28rem] space-y-3 overflow-y-auto" aria-live="polite">
          {messages.map((m, index) =>
            m.role === 'user' ? (
              <p key={m.id} className="ml-auto w-fit max-w-[85%] whitespace-pre-wrap rounded-2xl bg-mk-fg/10 px-3 py-2 text-sm">
                {textOf(m)}
              </p>
            ) : (
              <div key={m.id} className="w-fit max-w-[95%] rounded-2xl bg-primary px-3 py-2 text-sm">
                {textOf(m).trim() ? (
                  <ReplyText text={textOf(m)} arriving={busy && index === messages.length - 1} />
                ) : (
                  <span className="text-primary-foreground/80">Looking in the guides…</span>
                )}
              </div>
            ),
          )}
          {status === 'submitted' && (
            <p className="flex items-center gap-2 text-sm text-mk-muted">
              <Loader2 className="size-4 animate-spin" /> Sari is looking in the guides…
            </p>
          )}
          <div ref={endRef} />
        </div>
      )}

      {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{errorSentence(error, email)}</p>}

      {!usedUp && (
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <label htmlFor="support-question" className="sr-only">Your question</label>
          <textarea
            id="support-question"
            rows={2}
            maxLength={SUPPORT_QUESTION_CHARS}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder="How do I…?"
            className="min-h-11 flex-1 resize-none rounded-xl border border-mk-border bg-mk-bg px-3 py-2 text-base text-mk-fg placeholder:text-mk-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-mk-accent sm:text-sm"
          />
          <button
            type="submit"
            disabled={busy || !input.trim()}
            aria-label="Send question"
            className="grid size-11 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground disabled:opacity-50"
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
          </button>
        </form>
      )}
      <p className="text-xs text-mk-muted">
        Up to {limit} questions a week. A workspace with its own OpenRouter key uses that key instead. Sari can&apos;t see
        your workspace.
      </p>
    </div>
  );
}
