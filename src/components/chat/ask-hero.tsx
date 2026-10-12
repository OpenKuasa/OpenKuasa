'use client';

/**
 * The in-card chat on a product's Overview screen: Ask-Jebat on marketing,
 * Ask-Kasturi on the CRM.
 *
 * A product's own assistant lives INSIDE its card (the cross-app assistant is
 * the separate right-docked "Sari"). The conversation expands in place — the
 * card grows and pushes the dashboard grid down, with a smooth transition —
 * and shows live tool-call cards, changes waiting for approval, and image /
 * PDF / text attachments. Signed-in members stream from the persona's `api`;
 * demo / anonymous viewers get a canned answer + a sign-up gate (never POST,
 * $0 LLM).
 */

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useChat } from '@ai-sdk/react';
import {
  ChatKeyNotice,
  DAILY_LIMIT_NOTICE,
  chatErrorCode,
  isChatLocked,
  useChatStatus,
} from '@/components/chat/chat-key-notice';
import {
  convertFileListToFileUIParts,
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  type FileUIPart,
  type UIMessage,
} from 'ai';
import {
  ArrowUp,
  Check,
  FileText,
  ImageIcon,
  Loader2,
  Mic,
  Paperclip,
  Sparkles,
  X,
} from 'lucide-react';
import {
  approvalDetail,
  approvalTitle,
  hasVisibleContent,
  isText,
  nameFinder,
  receiptStateFor,
  toPendingApproval,
  toToolStep,
  toolMeta,
  type AnyPart,
  type ToolStep,
} from '@/components/chat/tool-parts';

/** Who answers in the card, and where its questions go. Plain strings, so a server screen can pass it. */
export type AskPersona = {
  /** The assistant's name, as in "Ask Jebat anything…". */
  name: string;
  /** What it is to the owner, shown after the name: "your CMO". */
  role: string;
  heading: string;
  /** The endpoint its questions stream from. */
  api: string;
  /** What a demo or anonymous visitor is shown instead of a live answer. */
  demoAnswer: string;
};

function isFile(p: AnyPart): p is Extract<AnyPart, { type: 'file' }> {
  return p.type === 'file';
}
function textOf(message: UIMessage): string {
  return message.parts.filter(isText).map((p) => p.text).join('');
}

export function AskHero({
  persona,
  prompts,
  isDemo,
}: {
  persona: AskPersona;
  prompts: string[];
  isDemo: boolean;
}) {
  const [input, setInput] = useState('');
  const [demoAsked, setDemoAsked] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pinnedOpen, setPinnedOpen] = useState(false);
  const [attachments, setAttachments] = useState<FileUIPart[]>([]);
  const [openSteps, setOpenSteps] = useState<Record<string, boolean>>({});

  const [transport] = useState(() => new DefaultChatTransport({ api: persona.api }));
  const { messages, sendMessage, status, error, addToolApprovalResponse } = useChat({
    transport,
    throttle: 50,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
  });

  // Who is paying: the workspace's own key, or the user's free weekly questions.
  const { status: chatStatus, refresh: refreshChatStatus } = useChatStatus(!isDemo);
  const locked = isChatLocked(chatStatus) || chatErrorCode(error) === 'key_required';
  // Re-read the allowance after each turn, whether it answered or was refused.
  useEffect(() => {
    if (status === 'ready' || status === 'error') void refreshChatStatus();
  }, [status, refreshChatStatus]);

  const busy = status === 'submitted' || status === 'streaming';
  const hasConversation = isDemo ? demoAsked : messages.length > 0;
  // Forced open while typing or streaming, or pinned via the button; otherwise it
  // expands on hover (CSS group-hover) — a reliable, always-animated transition
  // between two fixed heights.
  const pinned = busy || focused || pinnedOpen;

  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Escape unpins (back to hover behaviour).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPinnedOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Keep the newest message in view as it streams / when it opens.
  useEffect(() => {
    const pin = () => {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    };
    pin();
    const t = setTimeout(pin, 320);
    return () => clearTimeout(t);
  }, [messages, status, pinned, attachments]);

  function submit(text: string) {
    const t = text.trim();
    if ((!t && attachments.length === 0) || busy) return;
    if (locked) return;
    if (isDemo) {
      setDemoAsked(true);
      setInput('');
      return;
    }
    sendMessage(attachments.length > 0 ? { text: t, files: attachments } : { text: t });
    setInput('');
    setAttachments([]);
  }

  async function onPickFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    const parts = await convertFileListToFileUIParts(list);
    setAttachments((prev) => [...prev, ...parts].slice(0, 4));
    if (fileRef.current) fileRef.current.value = '';
  }

  return (
    <div className="group flex flex-col gap-4">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs font-medium text-primary-foreground/70">
            <Sparkles className="size-3.5 animate-twinkle" />
            {persona.name} · {persona.role}
          </div>
          <h1 className="mt-1 text-2xl font-bold tracking-tight">
            {persona.heading}
          </h1>
          <div className="mt-3 flex flex-wrap gap-2">
            {prompts.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => submit(p)}
                disabled={busy || locked}
                className="rounded-full bg-primary-foreground/10 px-3 py-1 text-xs font-medium text-primary-foreground ring-1 ring-inset ring-primary-foreground/20 transition hover:bg-primary-foreground/20 disabled:opacity-50"
              >
                {p}
              </button>
            ))}
          </div>
        </div>

        <div className="w-full lg:w-96">
          {attachments.length > 0 && (
            <div className="mb-2 flex flex-wrap justify-end gap-1.5">
              {attachments.map((a, i) => (
                <span
                  key={`${a.filename ?? 'file'}-${i}`}
                  className="flex items-center gap-1 rounded-lg bg-primary-foreground/15 px-2 py-1 text-xs text-primary-foreground"
                >
                  {a.mediaType?.startsWith('image/') ? (
                    <ImageIcon className="size-3.5" />
                  ) : (
                    <FileText className="size-3.5" />
                  )}
                  <span className="max-w-28 truncate">{a.filename ?? 'attachment'}</span>
                  <button
                    type="button"
                    aria-label="Remove attachment"
                    onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                    className="opacity-70 transition hover:opacity-100"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submit(input);
            }}
            className="flex w-full items-center gap-2 rounded-2xl bg-primary-foreground/10 p-2 ring-1 ring-inset ring-primary-foreground/20"
          >
            <input
              ref={fileRef}
              type="file"
              multiple
              accept="image/*,application/pdf,.txt,.csv,.md"
              className="hidden"
              onChange={(e) => onPickFiles(e.target.files)}
            />
            <button
              type="button"
              aria-label="Add attachment"
              onClick={() => fileRef.current?.click()}
              className="grid size-8 shrink-0 place-items-center rounded-full bg-primary-foreground/15 text-primary-foreground transition hover:bg-primary-foreground/25"
            >
              <Paperclip className="size-4" />
            </button>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              placeholder={`Ask ${persona.name} anything…`}
              aria-label={`Ask ${persona.name} anything`}
              className="min-w-0 flex-1 bg-transparent text-sm text-primary-foreground placeholder:text-primary-foreground/60 focus:outline-none"
            />
            <span
              aria-hidden="true"
              className="grid size-8 shrink-0 place-items-center rounded-full bg-primary-foreground/15 text-primary-foreground/60"
            >
              <Mic className="size-4" />
            </span>
            <button
              type="submit"
              disabled={busy || locked || (!input.trim() && attachments.length === 0)}
              aria-label="Send"
              className="grid size-8 shrink-0 place-items-center rounded-full bg-primary-foreground text-primary transition hover:opacity-90 disabled:opacity-50"
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
            </button>
          </form>
          <ChatKeyNotice status={chatStatus} tone="onPrimary" className="mt-2" />
        </div>
      </div>

      {hasConversation && (
        <div className="relative">
          <div
            ref={scrollRef}
            className={`overflow-y-auto overscroll-contain rounded-2xl bg-primary-foreground/10 p-3 pr-10 ring-1 ring-inset transition-[height] duration-300 ease-out motion-reduce:transition-none ${
              pinned
                ? 'h-[60vh] ring-primary-foreground/25'
                : 'h-52 ring-primary-foreground/15 group-hover:h-[60vh] group-hover:ring-primary-foreground/25'
            }`}
          >
            <Thread
              persona={persona}
              isDemo={isDemo}
              demoAsked={demoAsked}
              messages={messages}
              busy={busy}
              error={error}
              openSteps={openSteps}
              onToggleStep={(k) => setOpenSteps((s) => ({ ...s, [k]: !s[k] }))}
              onApproval={(id, approved) => addToolApprovalResponse({ id, approved })}
            />
          </div>
          <button
            type="button"
            onClick={() => setPinnedOpen((v) => !v)}
            aria-label={pinnedOpen ? 'Collapse chat' : 'Keep chat expanded'}
            className="absolute right-2 top-2 grid size-7 place-items-center rounded-lg bg-primary-foreground/15 text-primary-foreground transition hover:bg-primary-foreground/25"
          >
            <ArrowUp className={`size-3.5 transition-transform ${pinnedOpen ? 'rotate-180' : ''}`} />
          </button>
        </div>
      )}
    </div>
  );
}

function Thread({
  persona,
  isDemo,
  demoAsked,
  messages,
  busy,
  error,
  openSteps,
  onToggleStep,
  onApproval,
}: {
  persona: AskPersona;
  isDemo: boolean;
  demoAsked: boolean;
  messages: UIMessage[];
  busy: boolean;
  error: Error | undefined;
  openSteps: Record<string, boolean>;
  onToggleStep: (key: string) => void;
  onApproval: (approvalId: string, approved: boolean) => void;
}) {
  if (isDemo) return demoAsked ? <DemoBubble persona={persona} /> : null;
  // A change names its item by id; the name comes from the lookup that found it.
  const named = nameFinder(messages);

  return (
    <div className="flex flex-col gap-4">
      {messages.map((m) => {
        if (m.role === 'user') {
          const files = m.parts.filter(isFile);
          return (
            <div key={m.id} className="text-sm">
              <div className="mb-0.5 text-xs font-semibold text-primary-foreground/60">You</div>
              {files.length > 0 && (
                <div className="mb-1.5 flex flex-wrap gap-1.5">
                  {files.map((f, i) =>
                    f.mediaType?.startsWith('image/') ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        key={i}
                        src={f.url}
                        alt={f.filename ?? 'attachment'}
                        className="max-h-28 rounded-lg object-cover ring-1 ring-inset ring-primary-foreground/20"
                      />
                    ) : (
                      <span
                        key={i}
                        className="flex items-center gap-1 rounded-lg bg-primary-foreground/15 px-2 py-1 text-xs text-primary-foreground"
                      >
                        <FileText className="size-3.5" />
                        {f.filename ?? 'file'}
                      </span>
                    ),
                  )}
                </div>
              )}
              {textOf(m).trim() && (
                <div className="whitespace-pre-wrap leading-relaxed text-primary-foreground">
                  {textOf(m)}
                </div>
              )}
            </div>
          );
        }

        return (
          <div key={m.id} className="text-sm">
            <div className="mb-1 text-xs font-semibold text-primary-foreground/60">{persona.name}</div>
            <div className="flex flex-col gap-2">
              {m.parts.map((part, i) => {
                if (isText(part)) {
                  return part.text.trim() ? (
                    <div key={i} className="whitespace-pre-wrap leading-relaxed text-primary-foreground">
                      {part.text}
                    </div>
                  ) : null;
                }
                const pending = toPendingApproval(part);
                if (pending) {
                  const detail = approvalDetail(pending.toolName, pending.input, receiptStateFor(messages, pending.approvalId), named);
                  return (
                    <div
                      key={`appr-${pending.approvalId}`}
                      className="rounded-lg border border-border bg-card p-3 text-sm text-card-foreground"
                    >
                      <p className="font-medium">{approvalTitle(pending.toolName, pending.input, named)}</p>
                      {detail && <p className="mt-1 text-muted-foreground">{detail}</p>}
                      <div className="mt-3 flex gap-2">
                        <button
                          type="button"
                          onClick={() => onApproval(pending.approvalId, true)}
                          className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground"
                        >
                          Approve
                        </button>
                        <button
                          type="button"
                          onClick={() => onApproval(pending.approvalId, false)}
                          className="rounded-md bg-muted px-3 py-1.5 text-xs font-medium text-muted-foreground"
                        >
                          Reject
                        </button>
                      </div>
                    </div>
                  );
                }
                const step = toToolStep(part, m.id, i);
                return step ? (
                  <ToolCard
                    key={step.key}
                    step={step}
                    open={!!openSteps[step.key]}
                    onToggle={() => onToggleStep(step.key)}
                  />
                ) : null;
              })}
              {!hasVisibleContent(m) && busy && (
                <div className="flex items-center gap-2 text-xs text-primary-foreground/70">
                  <Loader2 className="size-3.5 animate-spin" />
                  {persona.name} is thinking…
                </div>
              )}
            </div>
          </div>
        );
      })}
      {error && (
        <div className="text-xs text-primary-foreground/80">
          {chatErrorCode(error) === 'key_required'
            ? 'That question was not sent: your free questions are used up. Add an OpenRouter key to keep chatting.'
            : chatErrorCode(error) === 'no_workspace'
              ? `${persona.name} needs a workspace to look at. Create or join one first.`
              : chatErrorCode(error) === 'daily_limit'
                ? DAILY_LIMIT_NOTICE
              : `${persona.name} couldn’t respond just now. Please try again.`}
        </div>
      )}
    </div>
  );
}

function ToolCard({
  step,
  open,
  onToggle,
}: {
  step: ToolStep;
  open: boolean;
  onToggle: () => void;
}) {
  const { label, Icon, detail } = toolMeta(step.name);
  const about = detail?.(step.output) ?? null;
  const canExpand = !step.running && step.output != null;
  return (
    <div
      className={`rounded-xl ring-1 ring-inset transition-colors ${
        step.running
          ? 'bg-primary-foreground/15 ring-primary-foreground/20'
          : 'bg-primary-foreground/10 ring-primary-foreground/10'
      }`}
    >
      <button
        type="button"
        onClick={canExpand ? onToggle : undefined}
        aria-expanded={canExpand ? open : undefined}
        className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs ${
          canExpand ? 'cursor-pointer' : 'cursor-default'
        }`}
      >
        <span className="grid size-5 shrink-0 place-items-center rounded-md bg-primary-foreground/15">
          <Icon className="size-3" />
        </span>
        <span className="font-medium text-primary-foreground">{label}</span>
        {about ? <span className="min-w-0 truncate text-primary-foreground">{about}</span> : null}
        <span className="min-w-0 flex-1 truncate text-primary-foreground/60">
          {step.running ? 'running…' : 'done'}
        </span>
        {step.running ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-primary-foreground/70" />
        ) : (
          <Check className="size-3.5 shrink-0 text-primary-foreground/70" />
        )}
      </button>
      {canExpand && open && (
        <pre className="max-h-40 overflow-auto border-t border-primary-foreground/10 px-2.5 py-2 text-[11px] leading-relaxed text-primary-foreground/80">
          {JSON.stringify(step.output, null, 2)}
        </pre>
      )}
    </div>
  );
}

function DemoBubble({ persona }: { persona: AskPersona }) {
  return (
    <div className="flex flex-col gap-2 text-sm">
      <div>
        <div className="mb-0.5 text-xs font-semibold text-primary-foreground/60">{persona.name} (demo)</div>
        <div className="leading-relaxed text-primary-foreground">{persona.demoAnswer}</div>
      </div>
      <Link
        href="/onboarding"
        className="inline-flex w-fit items-center rounded-full bg-primary-foreground px-3 py-1 text-xs font-semibold text-primary transition hover:opacity-90"
      >
        Sign up free to chat with {persona.name}
      </Link>
    </div>
  );
}
