'use client';

import { useEffect, useRef, useState } from 'react';
import { MessageSquare, Send, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

type Message = { from: 'bot' | 'visitor'; text: string };

/** The same limit as the server's; the server is the one that enforces it. */
const MESSAGE_MAX = 500;
const UNAVAILABLE = 'The chat is not available at the moment. Please try again later.';

/** A made-up value only this browser holds: it is what lets it continue its own conversation. */
function newSecret(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function post(url: string, body: unknown): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: response.ok, data };
  } catch {
    return { ok: false, data: {} };
  }
}

/**
 * The chatbot on a public landing page: a button in the corner that opens a
 * small chat with the workspace's bot. The conversation lives on the server;
 * this only shows it. Closing the page ends it.
 */
export function PublicChat({
  pageId,
  botName,
  welcome,
  handoffEnabled,
}: {
  pageId: string;
  botName: string;
  welcome: string;
  /** Whether the visitor can ask for a person. */
  handoffEnabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set once the conversation can take no more questions.
  const [ended, setEnded] = useState(false);
  const [person, setPerson] = useState<'closed' | 'open' | 'sending' | 'sent'>('closed');
  const [personError, setPersonError] = useState<string | null>(null);
  const conversation = useRef<{ id: string | null; secret: string } | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, busy, person, open]);

  async function send() {
    const text = input.trim();
    if (!text || busy || ended) return;
    conversation.current ??= { id: null, secret: newSecret() };
    setError(null);
    setInput('');
    setMessages((current) => [...current, { from: 'visitor', text }]);
    setBusy(true);
    const { ok, data } = await post(`/api/p/${pageId}/chat`, {
      conversationId: conversation.current.id,
      secret: conversation.current.secret,
      text,
    });
    setBusy(false);
    if (ok && typeof data.reply === 'string' && typeof data.conversationId === 'string') {
      conversation.current.id = data.conversationId;
      setMessages((current) => [...current, { from: 'bot', text: data.reply as string }]);
      return;
    }
    // The question was not taken: put it back so it is not lost.
    setMessages((current) => current.slice(0, -1));
    setInput(text);
    setError(typeof data.error === 'string' ? data.error : UNAVAILABLE);
    if (data.code === 'full' || data.code === 'not_found' || data.code === 'closed') setEnded(true);
  }

  async function askForPerson(form: HTMLFormElement) {
    if (!conversation.current?.id) return;
    const fields = new FormData(form);
    setPerson('sending');
    setPersonError(null);
    const { ok, data } = await post(`/api/p/${pageId}/chat/person`, {
      conversationId: conversation.current.id,
      secret: conversation.current.secret,
      name: String(fields.get('name') ?? ''),
      email: String(fields.get('email') ?? ''),
      phone: String(fields.get('phone') ?? ''),
    });
    if (ok) {
      setPerson('sent');
      return;
    }
    setPerson('open');
    setPersonError(typeof data.error === 'string' ? data.error : UNAVAILABLE);
  }

  if (!open) {
    return (
      <Button
        type="button"
        size="lg"
        className="fixed right-4 bottom-4 z-40 rounded-full shadow-lg"
        onClick={() => setOpen(true)}
      >
        <MessageSquare className="size-4" />
        Chat with us
      </Button>
    );
  }

  // A person can be asked for once there is a conversation to hand over.
  const canAskForPerson = handoffEnabled && person === 'closed' && messages.some((m) => m.from === 'bot');

  return (
    <section
      aria-label={`Chat with ${botName}`}
      className="fixed right-4 bottom-4 z-40 flex max-h-[min(34rem,calc(100dvh-2rem))] w-[min(22rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border bg-card text-card-foreground shadow-xl"
    >
      <header className="flex items-center justify-between gap-3 border-b px-4 py-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{botName}</p>
          <p className="text-xs text-muted-foreground">Automated assistant</p>
        </div>
        <Button type="button" variant="ghost" size="icon" aria-label="Close the chat" onClick={() => setOpen(false)}>
          <X className="size-4" />
        </Button>
      </header>

      <div ref={scrollRef} className="flex min-h-40 flex-1 flex-col gap-2 overflow-y-auto p-3" aria-live="polite">
        <Bubble from="bot">{welcome}</Bubble>
        {messages.map((message, index) => (
          <Bubble key={index} from={message.from}>
            {message.text}
          </Bubble>
        ))}
        {busy ? <Bubble from="bot">…</Bubble> : null}

        {person === 'sent' ? (
          <p className="rounded-lg border bg-muted/50 px-3 py-2 text-sm">
            Thank you. Someone will get in touch with you.
          </p>
        ) : null}
        {person === 'open' || person === 'sending' ? (
          <form
            className="space-y-2 rounded-lg border bg-muted/50 p-3"
            onSubmit={(event) => {
              event.preventDefault();
              void askForPerson(event.currentTarget);
            }}
          >
            <p className="text-sm font-medium">Leave your details and someone will get in touch.</p>
            <div className="space-y-1">
              <Label htmlFor="chat-person-name">Name</Label>
              <Input id="chat-person-name" name="name" autoComplete="name" maxLength={120} required />
            </div>
            <div className="space-y-1">
              <Label htmlFor="chat-person-email">Email</Label>
              <Input id="chat-person-email" name="email" type="email" autoComplete="email" maxLength={254} required />
            </div>
            <div className="space-y-1">
              <Label htmlFor="chat-person-phone">Phone (optional)</Label>
              <Input id="chat-person-phone" name="phone" type="tel" autoComplete="tel" maxLength={40} />
            </div>
            {personError ? (
              <p role="alert" className="text-xs text-destructive">
                {personError}
              </p>
            ) : null}
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={person === 'sending'}>
                {person === 'sending' ? 'Sending…' : 'Send'}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={person === 'sending'}
                onClick={() => setPerson('closed')}
              >
                Cancel
              </Button>
            </div>
          </form>
        ) : null}
      </div>

      <div className="space-y-2 border-t p-3">
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <Input
            aria-label="Your question"
            placeholder={ended ? 'This conversation has ended' : 'Type your question'}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            maxLength={MESSAGE_MAX}
            disabled={ended}
          />
          <Button type="submit" size="icon" aria-label="Send" disabled={busy || ended || !input.trim()}>
            <Send className="size-4" />
          </Button>
        </form>
        <div className="flex items-start justify-between gap-3 text-xs text-muted-foreground">
          <p>Answers are written by AI and can be wrong. This chat is saved.</p>
          {canAskForPerson ? (
            <button
              type="button"
              className="shrink-0 font-medium text-primary underline-offset-4 hover:underline"
              onClick={() => setPerson('open')}
            >
              Talk to a person
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function Bubble({ from, children }: { from: 'bot' | 'visitor'; children: React.ReactNode }) {
  return (
    <div className={cn('flex', from === 'visitor' ? 'justify-end' : 'justify-start')}>
      <span
        className={cn(
          'max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm leading-snug',
          from === 'visitor' ? 'rounded-br-sm bg-muted text-foreground' : 'rounded-bl-sm bg-primary/10 text-foreground',
        )}
      >
        {children}
      </span>
    </div>
  );
}
