'use client';

import { useEffect, useRef, useState } from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import Link from 'next/link';
import { BookOpen, Bot, Check, MessageSquare, MessagesSquare, Pencil, Plus, Radio, Send, Trash2 } from 'lucide-react';
import {
  ChatKeyNotice,
  DAILY_LIMIT_NOTICE,
  chatErrorCode,
  isChatLocked,
  useChatStatus,
} from '@/components/chat/chat-key-notice';
import { ScreenContainer } from '@/components/screen/screen-container';
import { PageHeader } from '@/components/screen/page-header';
import { BentoGrid, BentoCard, BentoStat } from '@/components/bento/bento';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  BOT_NAME_MAX,
  CHATBOT_TONES,
  DAILY_ANSWER_LIMIT_MAX,
  HANDOFF_AFTER_MAX,
  KNOWLEDGE_BODY_MAX,
  KNOWLEDGE_MAX,
  KNOWLEDGE_TITLE_MAX,
  PAUSE_MESSAGES,
  TONE_LABELS,
  WELCOME_MAX,
  type ChatConversation,
  type ChatbotActivity,
  type ChatbotPause,
  type ChatbotSettings,
  type KnowledgeEntry,
} from '@/lib/crm/chatbot';
import type { CrmFormAction } from '@/lib/crm/form-state';
import { cn } from '@/lib/utils';
import { SELECT_CLASS, useCrmForm } from './crm-form';

type Actions = {
  saveSettings: CrmFormAction;
  saveDailyLimit: CrmFormAction;
  saveEntry: CrmFormAction;
  removeEntry: CrmFormAction;
  resume: CrmFormAction;
};

const PREVIEW_API = '/api/crm/chatbot/preview';

/** Where a bot could answer besides the web chat. Each needs a connection that does not exist yet. */
const OTHER_CHANNELS = [
  { label: 'WhatsApp', state: 'Not connected' },
  { label: 'Instagram DM', state: 'Not connected' },
  { label: 'Messenger', state: 'Not connected' },
];

function Muted({ children }: { children: React.ReactNode }) {
  return (
    <p className="grid min-h-24 place-items-center text-center text-sm text-muted-foreground">
      {children}
    </p>
  );
}

function SettingsForm({ settings, action }: { settings: ChatbotSettings; action?: CrmFormAction }) {
  const [saved, setSaved] = useState(false);
  // A missing action means the person can only read: the form is shown, not sent.
  const { onSubmit, pending, error } = useCrmForm(action ?? (async () => undefined), () => setSaved(true));
  // Held here so a rejected save keeps what was typed.
  const [botName, setBotName] = useState(settings.botName);
  const [tone, setTone] = useState<string>(settings.tone);
  const [welcome, setWelcome] = useState(settings.welcome);
  const [handoffEnabled, setHandoffEnabled] = useState(settings.handoffEnabled);
  const [handoffAfter, setHandoffAfter] = useState(String(settings.handoffAfter));
  const edit = <T,>(set: (value: T) => void) => (value: T) => {
    setSaved(false);
    set(value);
  };

  return (
    <form onSubmit={action ? onSubmit : undefined} className="grid gap-4 sm:grid-cols-2">
      <fieldset disabled={!action} className="contents">
        <div className="space-y-1.5">
          <Label htmlFor="bot-name">Bot name</Label>
          <Input
            id="bot-name"
            name="botName"
            value={botName}
            onChange={(event) => edit(setBotName)(event.target.value)}
            maxLength={BOT_NAME_MAX}
            required
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="bot-tone">Tone</Label>
          <select
            id="bot-tone"
            name="tone"
            value={tone}
            onChange={(event) => edit(setTone)(event.target.value)}
            className={SELECT_CLASS}
          >
            {CHATBOT_TONES.map((value) => (
              <option key={value} value={value}>
                {TONE_LABELS[value]}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="bot-welcome">Welcome message</Label>
          <Textarea
            id="bot-welcome"
            name="welcome"
            value={welcome}
            onChange={(event) => edit(setWelcome)(event.target.value)}
            maxLength={WELCOME_MAX}
            rows={2}
            required
          />
        </div>
        <div className="space-y-2 sm:col-span-2">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="handoffEnabled"
              checked={handoffEnabled}
              onChange={(event) => edit(setHandoffEnabled)(event.target.checked)}
              className="size-4 accent-primary"
            />
            Offer a person when the bot cannot help
          </label>
          {handoffEnabled ? (
            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <Label htmlFor="bot-handoff-after" className="font-normal">
                After this many questions in a row it could not answer
              </Label>
              <Input
                id="bot-handoff-after"
                name="handoffAfter"
                type="number"
                inputMode="numeric"
                min="1"
                max={HANDOFF_AFTER_MAX}
                step="1"
                value={handoffAfter}
                onChange={(event) => edit(setHandoffAfter)(event.target.value)}
                className="w-20"
                required
              />
            </div>
          ) : null}
        </div>
      </fieldset>
      {action ? (
        <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
          <Button type="submit" disabled={pending}>
            <Check className="size-4" />
            {pending ? 'Saving…' : 'Save'}
          </Button>
          {saved && !pending && !error ? <p className="text-sm text-muted-foreground">Saved.</p> : null}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}

/** What the Daily answers field holds, and the saved number it was last taken from. */
export type DailyLimitField = { value: string; from: number };

/**
 * The field once the saved number is `limit`: a new saved number (after a save
 * goes through, or someone else's) replaces what is shown; otherwise what was
 * typed stays, so a refused save keeps it.
 */
export function syncDailyLimitField(field: DailyLimitField, limit: number): DailyLimitField {
  return field.from === limit ? field : { value: String(limit), from: limit };
}

/**
 * How many answers the chat on landing pages gives a day. Owners and admins
 * change it; everyone else sees the number. Without an action it is only shown.
 */
export function DailyLimitForm({ limit, action }: { limit: number; action?: CrmFormAction }) {
  const [saved, setSaved] = useState(false);
  const { formAction, pending, error } = useCrmForm(action ?? (async () => undefined), () => setSaved(true));
  // Held here so a rejected save keeps what was typed. Not remounted when the
  // saved number changes, so "Saved." stays after a save goes through.
  const [field, setField] = useState<DailyLimitField>({ value: String(limit), from: limit });
  const synced = syncDailyLimitField(field, limit);
  if (synced !== field) setField(synced);
  const value = synced.value;

  return (
    <form action={action ? formAction : undefined} className="mt-3 space-y-1.5 border-t pt-3">
      <Label htmlFor="bot-daily-limit">Daily answers</Label>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id="bot-daily-limit"
          name="dailyAnswerLimit"
          type="number"
          inputMode="numeric"
          min="1"
          max={DAILY_ANSWER_LIMIT_MAX}
          step="1"
          value={value}
          onChange={(event) => {
            setSaved(false);
            setField({ value: event.target.value, from: limit });
          }}
          readOnly={!action}
          aria-describedby="bot-daily-limit-help"
          className="w-28"
          required
        />
        {action ? (
          <Button type="submit" size="sm" variant="outline" disabled={pending}>
            <Check className="size-4" />
            {pending ? 'Saving…' : 'Save'}
          </Button>
        ) : null}
        {saved && !pending && !error ? <p className="text-sm text-muted-foreground">Saved.</p> : null}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <p id="bot-daily-limit-help" className="text-xs text-muted-foreground">
        Each answer uses your workspace&rsquo;s AI key. Once the day&rsquo;s answers are used, visitors are told the
        chat is busy and to try again later. The count starts again at 8 am Malaysia time.
        {action ? null : ' Only an owner or admin can change it.'}
      </p>
    </form>
  );
}

function EntryForm({
  action,
  editing,
  onClose,
}: {
  action: CrmFormAction;
  /** The entry being edited; null to add a new one. */
  editing: KnowledgeEntry | null;
  onClose: () => void;
}) {
  const { formAction, pending, error } = useCrmForm(action, onClose);
  const [title, setTitle] = useState(editing?.title ?? '');
  const [body, setBody] = useState(editing?.body ?? '');

  return (
    <form action={formAction} className="space-y-3 rounded-lg border bg-background/50 p-3">
      {editing ? <input type="hidden" name="entryId" value={editing.id} /> : null}
      <div className="space-y-1.5">
        <Label htmlFor="entry-title">Title</Label>
        <Input
          id="entry-title"
          name="title"
          placeholder="Delivery and COD"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={KNOWLEDGE_TITLE_MAX}
          autoFocus
          required
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="entry-body">What the bot should know</Label>
        <Textarea
          id="entry-body"
          name="body"
          placeholder="We deliver across Peninsular Malaysia in 2 to 4 working days. COD is available in Johor Bahru for RM8."
          value={body}
          onChange={(event) => setBody(event.target.value)}
          maxLength={KNOWLEDGE_BODY_MAX}
          rows={7}
          required
        />
        <p className="text-xs text-muted-foreground tabular-nums">
          {body.length.toLocaleString('en-MY')} of {KNOWLEDGE_BODY_MAX.toLocaleString('en-MY')} characters. Write it
          as you would tell a new member of staff. Customers may be told anything written here.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="sm" disabled={pending}>
          <Check className="size-4" />
          {pending ? 'Saving…' : editing ? 'Save changes' : 'Save entry'}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={pending}>
          Cancel
        </Button>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    </form>
  );
}

function DeleteEntry({
  entry,
  action,
  onClose,
}: {
  entry: KnowledgeEntry;
  action: CrmFormAction;
  onClose: () => void;
}) {
  const { formAction, pending, error } = useCrmForm(action, onClose);
  return (
    <form action={formAction} className="flex flex-wrap items-center gap-3 rounded-lg border bg-destructive/5 p-3">
      <input type="hidden" name="entryId" value={entry.id} />
      <p className="min-w-0 flex-1 text-sm">
        Delete <span className="font-medium">{entry.title}</span>? The bot will no longer answer from it. This
        cannot be undone.
      </p>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button type="submit" variant="destructive" size="sm" disabled={pending}>
        <Trash2 className="size-4" />
        {pending ? 'Deleting…' : 'Delete entry'}
      </Button>
      <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={pending}>
        Cancel
      </Button>
    </form>
  );
}

/** What the server said went wrong with a preview question, as a sentence. */
function previewError(error: Error | undefined): string | null {
  if (!error) return null;
  const code = chatErrorCode(error);
  // The line under the box already says how to add a key.
  if (code === 'key_required') return null;
  if (code === 'daily_limit') return DAILY_LIMIT_NOTICE;
  try {
    const body = JSON.parse(error.message) as { error?: unknown };
    if (typeof body.error === 'string' && body.error.trim()) return body.error;
  } catch {
    // Not one of the server's own refusals.
  }
  return 'The bot could not answer just now. Please try again.';
}

/** A real chat with the saved bot. Nothing typed here is kept. */
function PreviewChat({ settings }: { settings: ChatbotSettings }) {
  const [input, setInput] = useState('');
  const [transport] = useState(() => new DefaultChatTransport({ api: PREVIEW_API }));
  const { messages, sendMessage, setMessages, status, error, clearError } = useChat({ transport, throttle: 50 });

  // Who is paying: the workspace's own key, or the person's free weekly questions.
  const { status: chatStatus, refresh } = useChatStatus(true);
  const locked = isChatLocked(chatStatus) || chatErrorCode(error) === 'key_required';
  useEffect(() => {
    if (status === 'ready' || status === 'error') void refresh();
  }, [status, refresh]);

  const busy = status === 'submitted' || status === 'streaming';
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, status]);

  const problem = previewError(error);
  const demo = chatStatus?.isDemo === true;

  return (
    <div className="flex flex-col gap-3">
      <div ref={scrollRef} className="flex h-72 flex-col gap-2 overflow-y-auto rounded-lg border bg-background/50 p-3">
        <Bubble from="bot">{settings.welcome}</Bubble>
        {messages.map((message) => {
          const text = message.parts
            .map((part) => (part.type === 'text' ? part.text : ''))
            .join('');
          if (!text) return null;
          return (
            <Bubble key={message.id} from={message.role === 'user' ? 'user' : 'bot'}>
              {text}
            </Bubble>
          );
        })}
        {status === 'submitted' ? <Bubble from="bot">…</Bubble> : null}
      </div>
      {problem ? (
        <p role="alert" className="text-xs text-destructive">
          {problem}
        </p>
      ) : null}
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const text = input.trim();
          if (!text || busy || locked || demo) return;
          clearError();
          void sendMessage({ text });
          setInput('');
        }}
      >
        <Input
          aria-label={`Ask ${settings.botName} a question`}
          placeholder="Ask what a customer would ask"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          maxLength={500}
          disabled={locked || demo}
        />
        <Button type="submit" size="icon" aria-label="Send" disabled={busy || locked || demo || !input.trim()}>
          <Send className="size-4" />
        </Button>
      </form>
      <ChatKeyNotice status={chatStatus} />
      <div className="flex items-start justify-between gap-3 text-xs text-muted-foreground">
        <p>
          {demo
            ? 'The preview is not available in the demo workspace.'
            : 'Answers from what is saved. Each question is a real AI question; nothing typed here is kept.'}
        </p>
        {messages.length > 0 ? (
          <button
            type="button"
            className="shrink-0 font-medium text-primary hover:underline disabled:opacity-50"
            disabled={busy}
            onClick={() => {
              clearError();
              setMessages([]);
            }}
          >
            Start again
          </button>
        ) : null}
      </div>
    </div>
  );
}

function Bubble({ from, children }: { from: 'bot' | 'user'; children: React.ReactNode }) {
  return (
    <div className={cn('flex', from === 'user' ? 'justify-end' : 'justify-start')}>
      <span
        className={cn(
          'max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm leading-snug',
          from === 'user' ? 'rounded-br-sm bg-muted text-foreground' : 'rounded-bl-sm bg-primary/10 text-foreground',
        )}
      >
        {children}
      </span>
    </div>
  );
}

/** '12 Oct, 3:04 pm' in Malaysia. */
function when(iso: string) {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'Asia/Kuala_Lumpur',
  }).format(new Date(iso));
}

/** The pause notice, with the button that ends it for people who may. */
function PausedNotice({ reason, action }: { reason: ChatbotPause; action?: CrmFormAction }) {
  const { formAction, pending, error } = useCrmForm(action ?? (async () => undefined));
  return (
    <form
      action={action ? formAction : undefined}
      className="col-span-2 flex flex-wrap items-center gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 md:col-span-12"
    >
      <p role="status" className="min-w-0 flex-1 text-sm">
        {PAUSE_MESSAGES[reason]}
      </p>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {action ? (
        <Button type="submit" size="sm" variant="outline" disabled={pending}>
          {pending ? 'Switching on…' : 'Switch the chat back on'}
        </Button>
      ) : null}
    </form>
  );
}

/** One conversation: a line that opens to show what was said. */
function ConversationItem({ conversation }: { conversation: ChatConversation }) {
  const first = conversation.messages.find((message) => message.role === 'visitor');
  return (
    <li className="rounded-lg border bg-background/50">
      <details>
        <summary className="flex cursor-pointer items-center gap-3 px-3 py-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{first?.body ?? 'A conversation'}</p>
            <p className="truncate text-xs text-muted-foreground">
              {conversation.pageName ?? 'A page since deleted'} · {when(conversation.lastMessageAt)} ·{' '}
              {conversation.messages.length} {conversation.messages.length === 1 ? 'message' : 'messages'}
            </p>
          </div>
          {conversation.handedOff ? (
            <span className="shrink-0 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-semibold text-amber-600">
              Asked for a person
            </span>
          ) : null}
        </summary>
        <div className="space-y-2 border-t px-3 py-3">
          {conversation.person ? (
            <p className="text-xs text-muted-foreground">
              {conversation.person.name} · {conversation.person.email}
              {conversation.person.phone ? ` · ${conversation.person.phone}` : ''}. A follow-up was added to their
              contact.
            </p>
          ) : null}
          {conversation.messages.map((message) => (
            <Bubble key={message.id} from={message.role === 'visitor' ? 'user' : 'bot'}>
              {message.body}
            </Bubble>
          ))}
        </div>
      </details>
    </li>
  );
}

/** Kasturi's chatbot: how the bot behaves, what it knows, a chat to try it, and what customers asked. */
export function ChatbotView({
  settings,
  saved,
  dailyAnswerLimit,
  canSetDailyLimit,
  knowledge,
  pausedReason,
  activity,
  hasKey,
  actions,
}: {
  settings: ChatbotSettings;
  /** False until the workspace has saved its settings once. */
  saved: boolean;
  /** How many answers the chat on landing pages gives a day. */
  dailyAnswerLimit: number;
  /** Whether the signed-in person is an owner or admin, who alone may change the daily answers. */
  canSetDailyLimit: boolean;
  knowledge: KnowledgeEntry[];
  /** Set while the server has stopped the chat on landing pages. */
  pausedReason: ChatbotPause | null;
  activity: ChatbotActivity;
  /** Whether the workspace has its own AI key: the chat on landing pages needs one. */
  hasKey: boolean;
  /** Present only when the signed-in person may change the bot. */
  actions?: Actions;
}) {
  // One thing is open at a time: the entry form, or a delete question.
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const close = () => {
    setAdding(false);
    setEditingId(null);
    setDeletingId(null);
  };
  const characters = knowledge.reduce((sum, entry) => sum + entry.body.length, 0);
  const full = knowledge.length >= KNOWLEDGE_MAX;
  const webChat = pausedReason
    ? 'Paused'
    : !hasKey
      ? 'Needs an AI key'
      : activity.pagesWithChat === 0
        ? 'Not switched on yet'
        : `On for ${activity.pagesWithChat} ${activity.pagesWithChat === 1 ? 'page' : 'pages'}`;
  const webChatOn = !pausedReason && hasKey && activity.pagesWithChat > 0;

  return (
    <ScreenContainer>
      <PageHeader
        title="AI Chatbot"
        subtitle="A bot that answers your customers from what you write here, on the landing pages you switch it on for."
      />

      <BentoGrid>
        {pausedReason ? <PausedNotice reason={pausedReason} action={actions?.resume} /> : null}

        <BentoCard tone="primary" className="col-span-1 md:col-span-3">
          <BentoStat
            label="Knowledge entries"
            value={String(knowledge.length)}
            delta={`of ${KNOWLEDGE_MAX}`}
            onPrimary
          />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat label="Characters written" value={characters.toLocaleString('en-MY')} />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat
            label="Conversations this month"
            value={activity.conversationsThisMonth.toLocaleString('en-MY')}
          />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat label="Asked for a person" value={activity.handedOffThisMonth.toLocaleString('en-MY')} />
        </BentoCard>

        <BentoCard
          title="Behaviour"
          subtitle={
            !actions?.saveSettings
              ? 'How the bot greets and responds. Only an owner or admin can change it.'
              : saved
                ? 'How the bot greets and responds'
                : 'These are the starting settings. Save to make them yours.'
          }
          icon={Bot}
          className="col-span-2 md:col-span-7"
        >
          <SettingsForm settings={settings} action={actions?.saveSettings} />
        </BentoCard>

        <BentoCard
          title="Try it"
          subtitle={`Chat with ${settings.botName} as a customer would`}
          icon={MessageSquare}
          className="col-span-2 md:col-span-5"
        >
          {/* A new chat when the saved bot changes, so old answers are not mistaken for the new bot's. */}
          <PreviewChat key={JSON.stringify(settings)} settings={settings} />
        </BentoCard>

        <BentoCard
          title="Knowledge"
          subtitle="Everything the bot may answer from. It knows nothing else about your business."
          icon={BookOpen}
          className="col-span-2 md:col-span-8"
          action={
            actions && !adding && !full ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  close();
                  setAdding(true);
                }}
              >
                <Plus className="size-4" />
                Add entry
              </Button>
            ) : null
          }
        >
          <div className="space-y-2">
            {actions && adding ? <EntryForm action={actions.saveEntry} editing={null} onClose={close} /> : null}
            {knowledge.length === 0 && !adding ? (
              <Muted>
                {actions
                  ? 'Nothing written yet. Add your FAQ, prices and delivery terms, one entry per subject.'
                  : 'Nothing written yet.'}
              </Muted>
            ) : null}
            {knowledge.map((entry) => {
              if (actions && editingId === entry.id) {
                return <EntryForm key={entry.id} action={actions.saveEntry} editing={entry} onClose={close} />;
              }
              if (actions && deletingId === entry.id) {
                return <DeleteEntry key={entry.id} entry={entry} action={actions.removeEntry} onClose={close} />;
              }
              return (
                <div key={entry.id} className="flex items-start gap-3 rounded-lg border bg-background/50 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{entry.title}</p>
                    <p className="line-clamp-2 whitespace-pre-line text-xs text-muted-foreground">{entry.body}</p>
                  </div>
                  <span className="shrink-0 pt-0.5 text-xs text-muted-foreground tabular-nums">
                    {entry.body.length.toLocaleString('en-MY')}
                  </span>
                  {actions ? (
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Edit ${entry.title}`}
                        onClick={() => {
                          close();
                          setEditingId(entry.id);
                        }}
                      >
                        <Pencil className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Delete ${entry.title}`}
                        onClick={() => {
                          close();
                          setDeletingId(entry.id);
                        }}
                      >
                        <Trash2 className="size-4 text-destructive" />
                      </Button>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
          {full ? (
            <p className="mt-3 text-xs text-muted-foreground">
              You have the most entries a workspace can keep ({KNOWLEDGE_MAX}). Delete one, or add to an existing
              entry.
            </p>
          ) : null}
        </BentoCard>

        <BentoCard title="Channels" subtitle="Where the bot can answer" icon={Radio} className="col-span-2 md:col-span-4">
          <ul className="space-y-1">
            <li className="flex items-center justify-between gap-3 rounded-lg border bg-background/50 px-3 py-2">
              <span className="text-sm">Web chat</span>
              <span
                className={cn(
                  'shrink-0 rounded-full px-2 py-0.5 text-xs font-medium',
                  webChatOn ? 'bg-emerald-500/15 text-emerald-600' : 'bg-muted text-muted-foreground',
                )}
              >
                {webChat}
              </span>
            </li>
            {OTHER_CHANNELS.map((channel) => (
              <li
                key={channel.label}
                className="flex items-center justify-between gap-3 rounded-lg border bg-background/50 px-3 py-2"
              >
                <span className="text-sm">{channel.label}</span>
                <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                  {channel.state}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-muted-foreground">
            {hasKey ? (
              <>
                Switch the chat on for a page when you edit it on{' '}
                <Link href="/crm/landing-page" className="font-medium text-primary underline-offset-4 hover:underline">
                  Landing Page
                </Link>
                . Each customer question is an AI question on your workspace&rsquo;s key.
              </>
            ) : (
              <>
                The chat answers customers on your workspace&rsquo;s own AI key.{' '}
                <Link href="/account/ai" className="font-medium text-primary underline-offset-4 hover:underline">
                  Add an OpenRouter key
                </Link>{' '}
                to use it.
              </>
            )}
          </p>
          <DailyLimitForm
            limit={dailyAnswerLimit}
            action={canSetDailyLimit ? actions?.saveDailyLimit : undefined}
          />
        </BentoCard>

        <BentoCard
          title="Conversations"
          subtitle={
            activity.conversations.length === 0
              ? 'What customers asked, and what the bot said'
              : 'The latest, newest first. Kept for 90 days.'
          }
          icon={MessagesSquare}
          className="col-span-2 md:col-span-12"
        >
          {activity.conversations.length === 0 ? (
            <Muted>No conversations yet. They appear here once a customer asks the bot something on a landing page.</Muted>
          ) : (
            <ul className="space-y-2">
              {activity.conversations.map((conversation) => (
                <ConversationItem key={conversation.id} conversation={conversation} />
              ))}
            </ul>
          )}
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}
