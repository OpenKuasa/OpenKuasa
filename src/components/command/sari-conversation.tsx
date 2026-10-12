'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useChat } from '@ai-sdk/react';
import { convertFileListToFileUIParts, type FileUIPart, type UIMessage } from 'ai';
import {
  Sparkles,
  Plus,
  Mic,
  ArrowUp,
  BarChart3,
  Users,
  Lightbulb,
  Receipt,
  SquareKanban,
  Compass,
  Megaphone,
  UserRound,
  Landmark,
  PanelLeft,
  SquarePen,
  Maximize2,
  X,
  Contact,
  Send,
  FileUp,
  CalendarCheck,
  Wallet,
  ClipboardCheck,
  FileText,
  Briefcase,
  MessageSquareText,
  type LucideIcon,
} from 'lucide-react';
import { ASSISTANT } from '@/config/nav';
import { ReplyCard, type CardType } from '@/components/command/reply-cards';
import { useViewer } from '@/components/app/viewer-context';
import {
  ChatKeyNotice,
  DAILY_LIMIT_NOTICE,
  chatErrorCode,
  isChatLocked,
  useChatStatus,
} from '@/components/chat/chat-key-notice';
import {
  ChatHistory,
  type ChatHistoryState,
} from '@/components/command/chat-history';
import { Skeleton } from '@/components/ui/skeleton';
import {
  deleteChatThreadAction,
  listChatThreadsAction,
  loadChatThreadAction,
  renameChatThreadAction,
} from '@/app/(app)/command/actions';
import {
  isThreadId,
  titleFromText,
  type ChatThread,
} from '@/lib/chat/threads';
import { screenFromPath, screenLabel } from '@/lib/chat/screen';
import { SpecialistCard } from '@/components/chat/specialist-card';
import { ApprovalCard, ToolStepCard } from '@/components/chat/tool-cards';
import {
  changesApplied,
  nameFinder,
  hasVisibleContent,
  isText,
  proposalFor,
  toPendingApproval,
  toSpecialistWork,
  toToolStep,
  type AnyPart,
} from '@/components/chat/tool-parts';
import {
  ATTACH_ACCEPT,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_CHARS,
  attachmentChars,
  attachmentNote,
  isAttachable,
  isFilePart,
  type FilePart,
} from '@/lib/chat/attachments';
import {
  createChat,
  dropChat,
  isAnswering,
  keepChat,
  keptChat,
  panelThread,
  rememberPanelThread,
  type LiveChat,
} from '@/components/command/live-chats';
import { cn } from '@/lib/utils';

type Role = 'user' | 'assistant';
type Message = {
  id: number | string;
  role: Role;
  text: string;
  card?: CardType;
  /** Files sent with a question, while they are still in memory. */
  files?: FilePart[];
  /** A live answer as it was built: words, lookups and changes to approve. */
  parts?: AnyPart[];
};
type Reply = { text: string; card?: CardType };

/** Sample answers for demo guests, who never reach a model: a canned reply + optional data card. */
function getReply(q: string): Reply {
  const t = q.toLowerCase();
  if (/(overdue|unpaid|owe|invoice|collect|receivable)/.test(t))
    return {
      text: 'You have 3 overdue invoices totalling RM 13,450 — the oldest is 18 days out. Want me to send payment reminders from Bendahara?',
      card: 'invoices',
    };
  if (/(payroll|headcount|employee|staff|\bteam\b|\bhr\b|leave|claim|approval)/.test(t))
    return {
      text: 'You have 24 people on board and 3 approvals waiting on you. Payroll for October runs on the 28th — RM 86,400 with statutory already worked out.',
      card: 'team',
    };
  if (/(pipeline|\bdeal|win rate|close rate|opportunit)/.test(t))
    return {
      text: 'RM 56,200 is open across 7 deals, and you’ve won RM 42,000 this month. “Rimba Retail” is your biggest open deal — worth a nudge.',
      card: 'pipeline',
    };
  if (/(\bads?\b|advert|campaign|roas|cost per lead|\bcpl\b|ad spend)/.test(t))
    return {
      text: 'You’ve spent RM 4,820 on ads this month and pulled in 184 leads at RM 26 each — a 3.4× return. Meta Ads is carrying most of it.',
      card: 'ads',
    };
  if (/lead/.test(t))
    return {
      text: '47 new leads this week, up 18% from last week. Meta Ads is your strongest source, with WhatsApp close behind.',
      card: 'leads',
    };
  if (/(focus|priorit|should i|what.*(do|next)|today|attention)/.test(t))
    return {
      text: 'Here’s where your attention moves the needle most right now:',
      card: 'priorities',
    };
  if (
    /(business|doing|overview|month|revenue|cash|runway|margin|perform|sales|how.*going)/.test(
      t,
    )
  )
    return {
      text: 'October’s looking strong — revenue is up 12% month-on-month and your runway is healthy at 7.2 months.',
      card: 'overview',
    };
  return {
    text: 'I pull your numbers across Jebat, Kasturi, Lekiu, Lekir and Bendahara. Try asking about this month’s performance, your sales pipeline, new leads, ad spend, team & payroll, or overdue invoices.',
  };
}

const SUGGESTIONS: { label: string; icon: LucideIcon }[] = [
  { label: 'How is my business doing this month?', icon: BarChart3 },
  { label: 'What’s in my sales pipeline?', icon: SquareKanban },
  { label: 'How many new leads this week?', icon: Users },
  { label: 'Show me overdue invoices', icon: Receipt },
  { label: 'What should I focus on right now?', icon: Lightbulb },
];

/**
 * Starters for the floating assistant, by the product it was opened from.
 * They are things Tuah can do today: explain the product and draft words.
 */
const SCREEN_SUGGESTIONS: Record<string, { label: string; icon: LucideIcon }[]> = {
  reach: [
    { label: 'How do I launch my first ad campaign?', icon: Megaphone },
    { label: 'Write three ad headlines for my business', icon: MessageSquareText },
    { label: 'How do lead forms work?', icon: ClipboardCheck },
    { label: 'What makes a good ad creative?', icon: Lightbulb },
  ],
  crm: [
    { label: 'How do I import my contacts?', icon: FileUp },
    { label: 'Draft a follow-up message to a new lead', icon: Send },
    { label: 'How should I set up my deal stages?', icon: SquareKanban },
    { label: 'What should I record about each contact?', icon: Contact },
  ],
  people: [
    { label: 'How do I set up leave types?', icon: CalendarCheck },
    { label: 'Explain EPF and SOCSO contributions simply', icon: Wallet },
    { label: 'Draft an announcement for a public holiday', icon: Megaphone },
    { label: 'What goes into a monthly payroll run?', icon: Receipt },
  ],
  hire: [
    { label: 'Write a job post for a sales executive', icon: Briefcase },
    { label: 'Suggest interview questions for a first round', icon: MessageSquareText },
    { label: 'How do I move a candidate between stages?', icon: SquareKanban },
    { label: 'Draft a polite rejection email', icon: Send },
  ],
  finance: [
    { label: 'How do I create and send an invoice?', icon: FileText },
    { label: 'Explain e-Invoice LHDN in simple terms', icon: ClipboardCheck },
    { label: 'Draft a payment reminder for an overdue invoice', icon: Send },
    { label: 'When do I need to charge SST?', icon: Receipt },
  ],
};

const AGENTS: { label: string; icon: LucideIcon; prompt: string }[] = [
  { label: 'CEO', icon: Compass, prompt: 'How is my business doing this month?' },
  { label: 'CMO', icon: Megaphone, prompt: 'How are my ads performing?' },
  { label: 'CHRO', icon: UserRound, prompt: 'What’s pending with my team?' },
  { label: 'CFO', icon: Landmark, prompt: 'Show me overdue invoices' },
];

/** The chat on screen: a saved thread being read back, or a new one. */
type Session = {
  id: string;
  status: 'ready' | 'loading' | 'error';
  /** The conversation itself; absent only while a saved thread is being read. */
  chat: LiveChat | null;
  /** False until the first question is sent, so an untouched chat has no URL. */
  saved: boolean;
  /** How the last question stands when a thread is read back without its answer. */
  answer: AnswerState;
};

/** `coming`: asked moments ago, the reply may still be on its way. `lost`: it never arrived. */
type AnswerState = 'settled' | 'coming' | 'lost';

/** How long after a question its answer can still be expected to turn up. */
const ANSWER_WINDOW_MS = 90_000;
const ANSWER_POLL_MS = 2_500;
const ANSWER_POLL_TRIES = 30;

/**
 * Lists this tab has already shown. Back and forward bring a page back with
 * the list it had then, which is how an out-of-date one is told apart.
 */
const shownLists = new WeakSet<ChatThread[]>();

function freshSession(): Session {
  const id = crypto.randomUUID();
  return { id, status: 'ready', chat: createChat(id), saved: false, answer: 'settled' };
}

/** A saved thread: straight from memory if it is still open here, else read back. */
function savedSession(userId: string, id: string): Session {
  const chat = keptChat(userId, id) ?? null;
  return {
    id,
    status: chat ? 'ready' : 'loading',
    chat,
    saved: true,
    answer: 'settled',
  };
}

/**
 * Whether Tuah answers with its team of specialists, which it does unless
 * switched off for this browser: open any page with `?team=0` (and `?team=1`
 * to switch it back on).
 */
function teamMode(): boolean {
  try {
    const asked = new URL(window.location.href).searchParams.get('team');
    if (asked === '1' || asked === '0') window.localStorage.setItem('ok.tuah.team', asked);
    return window.localStorage.getItem('ok.tuah.team') !== '0';
  } catch {
    return true;
  }
}

/** `?chat=<id>` keeps a saved thread on screen across refresh and back. */
function showInUrl(threadId: string | null, mode: 'push' | 'replace') {
  const url = new URL(window.location.href);
  if (threadId) url.searchParams.set('chat', threadId);
  else url.searchParams.delete('chat');
  const next = `${url.pathname}${url.search}`;
  if (mode === 'push') window.history.pushState(null, '', next);
  else window.history.replaceState(null, '', next);
}

export function SariConversation({
  showSidebar = false,
  compact = false,
  urlThreadId = null,
  initialThreads = null,
  listedAt,
  pathname,
  onClose,
}: {
  /** The full page: saved chats in a column beside the conversation. */
  showSidebar?: boolean;
  /** The floating assistant: a narrow panel with its own header. */
  compact?: boolean;
  /** The thread named in the address bar, on the page that keeps history. */
  urlThreadId?: string | null;
  /** The saved chats sent with the page; without them the list is read here. */
  initialThreads?: ChatThread[] | null;
  /** When the page read that list. */
  listedAt?: string;
  /** The screen the floating assistant was opened from. */
  pathname?: string;
  /** Closes the floating assistant. */
  onClose?: () => void;
}) {
  const viewer = useViewer();
  const userId = viewer.userId;
  // Demo guests chat with sample answers and nothing of theirs is saved.
  const hasHistory = showSidebar || compact;
  const keepsHistory = hasHistory && !viewer.isDemo;
  // Only the full page names its thread in the address bar. The floating
  // assistant sits on top of other screens, so it remembers its thread itself.
  const wanted =
    showSidebar && keepsHistory && isThreadId(urlThreadId) ? urlThreadId : null;

  const [session, setSession] = useState<Session>(() => {
    const open = wanted ?? (compact && keepsHistory ? panelThread(userId) : null);
    return open && isThreadId(open) ? savedSession(userId, open) : freshSession();
  });
  const [threads, setThreads] = useState<ChatThread[]>(
    () => (keepsHistory && initialThreads) || [],
  );
  const [listState, setListState] = useState<ChatHistoryState>(
    keepsHistory && !initialThreads ? 'loading' : 'ready',
  );
  const [notice, setNotice] = useState<string | null>(null);
  // Picks up `?team=1` / `?team=0` as soon as the page opens, not at the first question.
  useEffect(() => {
    teamMode();
  }, []);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // The address bar leads: back, forward and picking a thread all arrive here.
  const [seenWanted, setSeenWanted] = useState(wanted);
  if (wanted !== seenWanted) {
    setSeenWanted(wanted);
    if (wanted && wanted !== session.id) setSession(savedSession(userId, wanted));
    else if (!wanted && session.saved) setSession(freshSession());
  }

  /** Records which thread is on screen: in the URL, or in the panel's memory. */
  const pointTo = useCallback(
    (threadId: string | null, mode: 'push' | 'replace') => {
      if (showSidebar) showInUrl(threadId, mode);
      else if (compact) rememberPanelThread(userId, threadId);
    },
    [showSidebar, compact, userId],
  );

  const sessionId = session.id;
  const sessionStatus = session.status;
  useEffect(() => {
    if (sessionStatus !== 'loading') return;
    let current = true;
    const load = async () => {
      const loaded = await loadChatThreadAction(sessionId).catch(
        () => ({ ok: false, reason: 'error' }) as const,
      );
      if (!current) return;
      if (loaded.ok) {
        const chat = createChat(sessionId, loaded.messages);
        keepChat(userId, chat);
        const last = loaded.messages[loaded.messages.length - 1];
        const age = Date.now() - new Date(loaded.thread.updatedAt).getTime();
        setSession({
          id: sessionId,
          status: 'ready',
          chat,
          saved: true,
          answer:
            last?.role !== 'user'
              ? 'settled'
              : age < ANSWER_WINDOW_MS
                ? 'coming'
                : 'lost',
        });
      } else if (loaded.reason === 'missing') {
        setNotice('That chat is no longer available, so here is a new one.');
        setSession(freshSession());
        pointTo(null, 'replace');
      } else {
        setSession((s) => (s.id === sessionId ? { ...s, status: 'error' } : s));
      }
    };
    void load();
    return () => {
      current = false;
    };
  }, [sessionId, sessionStatus, userId, pointTo]);

  // A list read can land after a question was asked but before its thread
  // was saved. Threads still being answered here are kept on top, so a slow
  // read never makes a chat vanish from the list.
  const applyThreads = useCallback(
    (fromServer: ChatThread[]) => {
      setThreads((local) => {
        const saved = new Set(fromServer.map((t) => t.id));
        const inFlight = local.filter(
          (t) => !saved.has(t.id) && isAnswering(userId, t.id),
        );
        return [...inFlight, ...fromServer];
      });
    },
    [userId],
  );

  const refreshThreads = useCallback(async () => {
    const next = await listChatThreadsAction().catch(() => null);
    if (next) {
      applyThreads(next);
      setListState('ready');
    } else {
      setListState((state) => (state === 'loading' ? 'error' : state));
    }
  }, [applyThreads]);

  useEffect(() => {
    if (!keepsHistory) return;
    // A list that came with the page is current the first time it is shown.
    if (initialThreads && !shownLists.has(initialThreads)) {
      shownLists.add(initialThreads);
      return;
    }
    let current = true;
    const load = async () => {
      const next = await listChatThreadsAction().catch(() => null);
      if (!current) return;
      if (next) {
        applyThreads(next);
        setListState('ready');
      } else {
        setListState((state) => (state === 'loading' ? 'error' : state));
      }
    };
    void load();
    return () => {
      current = false;
    };
  }, [keepsHistory, applyThreads, initialThreads]);

  // Escape closes the list of chats first, and only then whatever holds it.
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setDrawerOpen(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [drawerOpen]);

  function openDrawer() {
    setDrawerOpen(true);
    // Chats asked elsewhere since this list was read belong in it too.
    if (keepsHistory) void refreshThreads();
  }

  const handleAsk = useCallback(
    (text: string) => {
      if (!keepsHistory) return;
      setNotice(null);
      // Show the thread at the top straight away; the server copy follows.
      setThreads((list) => {
        const existing = list.find((t) => t.id === sessionId);
        const thread: ChatThread = {
          id: sessionId,
          title: existing?.title ?? titleFromText(text),
          updatedAt: new Date().toISOString(),
        };
        return [thread, ...list.filter((t) => t.id !== sessionId)];
      });
      setSession((s) => (s.id === sessionId ? { ...s, saved: true } : s));
      pointTo(sessionId, 'replace');
    },
    [keepsHistory, sessionId, pointTo],
  );

  const handleSettled = useCallback(() => {
    if (keepsHistory) void refreshThreads();
  }, [keepsHistory, refreshThreads]);

  function newChat() {
    setDrawerOpen(false);
    setNotice(null);
    setSession(freshSession());
    pointTo(null, 'push');
  }

  function selectThread(id: string) {
    setDrawerOpen(false);
    setNotice(null);
    if (id === session.id) return;
    setSession(savedSession(userId, id));
    pointTo(id, 'push');
  }

  async function renameThread(id: string, title: string): Promise<boolean> {
    const saved = await renameChatThreadAction(id, title).catch(() => null);
    if (!saved) return false;
    setThreads((list) => list.map((t) => (t.id === id ? { ...t, title: saved } : t)));
    return true;
  }

  async function deleteThread(id: string): Promise<boolean> {
    const gone = await deleteChatThreadAction(id).catch(() => false);
    if (!gone) return false;
    dropChat(userId, id);
    setThreads((list) => list.filter((t) => t.id !== id));
    if (id === session.id) {
      setSession(freshSession());
      pointTo(null, 'replace');
    }
    return true;
  }

  const activeTitle = threads.find((t) => t.id === session.id)?.title ?? 'New chat';
  const screen = compact ? screenFromPath(pathname) : null;
  // The assistant's own name until the chat has a title of its own.
  const panelTitle = threads.find((t) => t.id === session.id)?.title ?? ASSISTANT.name;
  const history = (
    <ChatHistory
      threads={threads}
      state={listState}
      listedAt={listedAt}
      activeId={session.saved ? session.id : null}
      isDemo={viewer.isDemo}
      onNew={newChat}
      onSelect={selectThread}
      onRename={renameThread}
      onDelete={deleteThread}
      onRetry={() => {
        setListState('loading');
        void refreshThreads();
      }}
    />
  );

  return (
    <div className="relative flex h-full">
      {showSidebar ? (
        <aside className="hidden w-72 shrink-0 border-r bg-sidebar lg:block">
          {history}
        </aside>
      ) : null}

      {hasHistory && drawerOpen ? (
        <div
          className={cn('z-50', compact ? 'absolute inset-0' : 'fixed inset-0 lg:hidden')}
          role="dialog"
          aria-modal="true"
          aria-label="Your chats"
        >
          <button
            type="button"
            aria-label="Close your chats"
            onClick={() => setDrawerOpen(false)}
            className="absolute inset-0 cursor-default bg-black/50 animate-in fade-in-0 duration-200"
          />
          <div
            className={cn(
              'absolute inset-y-0 left-0 w-80 border-r bg-sidebar shadow-xl animate-in slide-in-from-left duration-200',
              compact ? 'max-w-[85%]' : 'max-w-[85vw]',
            )}
          >
            {history}
          </div>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col bg-background">
        {compact ? (
          <div className="flex h-14 shrink-0 items-center gap-0.5 border-b px-2">
            <button
              type="button"
              onClick={openDrawer}
              aria-label="Open your chats"
              aria-expanded={drawerOpen}
              title="Your chats"
              className={PANEL_BUTTON}
            >
              <PanelLeft className="size-5" aria-hidden />
            </button>
            <span
              className="hidden size-8 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground min-[400px]:grid"
              aria-hidden
            >
              <Sparkles className="size-4" />
            </span>
            <div className="min-w-0 flex-1 px-2">
              <p className="truncate text-sm font-bold leading-tight" title={panelTitle}>
                {panelTitle}
              </p>
              <p className="truncate text-xs leading-tight text-muted-foreground">
                {screen ? `Asking from ${screenLabel(screen)}` : 'Ask anything about your business'}
              </p>
            </div>
            <button
              type="button"
              onClick={newChat}
              aria-label="New chat"
              title="New chat"
              className={PANEL_BUTTON}
            >
              <SquarePen className="size-5" aria-hidden />
            </button>
            <Link
              href={session.saved ? `/command?chat=${session.id}` : '/command'}
              onClick={onClose}
              aria-label="Open in Tuah"
              title="Open in Tuah"
              className={PANEL_BUTTON}
            >
              <Maximize2 className="size-[18px]" aria-hidden />
            </Link>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              title="Close"
              className={PANEL_BUTTON}
            >
              <X className="size-5" aria-hidden />
            </button>
          </div>
        ) : showSidebar ? (
          <div className="flex h-12 shrink-0 items-center gap-1 border-b px-2 lg:hidden">
            <button
              type="button"
              onClick={openDrawer}
              aria-label="Open your chats"
              className="grid size-11 shrink-0 cursor-pointer place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <PanelLeft className="size-5" aria-hidden />
            </button>
            <p className="min-w-0 flex-1 truncate text-center text-sm font-medium">
              {activeTitle}
            </p>
            <button
              type="button"
              onClick={newChat}
              aria-label="New chat"
              className="grid size-11 shrink-0 cursor-pointer place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <SquarePen className="size-5" aria-hidden />
            </button>
          </div>
        ) : null}

        {notice ? (
          <p
            role="status"
            className="border-b bg-muted/60 px-4 py-2 text-center text-xs text-muted-foreground"
          >
            {notice}
          </p>
        ) : null}

        {session.status === 'error' ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
            <p className="text-sm font-medium">This chat could not be opened</p>
            <p className="max-w-xs text-sm text-muted-foreground">
              It is still saved. Check your connection and try again.
            </p>
            <button
              type="button"
              onClick={() => setSession(savedSession(userId, session.id))}
              className="h-10 cursor-pointer rounded-lg border bg-background px-4 text-sm font-medium transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Try again
            </button>
          </div>
        ) : session.status === 'loading' || !session.chat ? (
          <ThreadSkeleton compact={compact} />
        ) : (
          <ChatPane
            key={session.id}
            chat={session.chat}
            answer={session.answer}
            keep={keepsHistory}
            compact={compact}
            pathname={compact ? pathname : undefined}
            onAsk={handleAsk}
            onSettled={handleSettled}
          />
        )}
      </div>
    </div>
  );
}

const PANEL_BUTTON =
  'grid size-11 shrink-0 cursor-pointer place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

function ThreadSkeleton({ compact }: { compact: boolean }) {
  return (
    <div className="flex-1 overflow-hidden" aria-busy="true" aria-label="Opening chat">
      <div
        className={cn('space-y-6 px-4 py-6 sm:px-6', compact ? '' : 'mx-auto max-w-2xl')}
      >
        <div className="flex justify-end">
          <Skeleton className="h-10 w-48 rounded-2xl" />
        </div>
        <div className="flex gap-3">
          <Skeleton className="size-8 shrink-0 rounded-full" />
          <div className="flex-1 space-y-2 pt-1">
            <Skeleton className="h-3.5 w-11/12" />
            <Skeleton className="h-3.5 w-4/5" />
            <Skeleton className="h-3.5 w-2/3" />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * One conversation on screen. The chat itself is owned by the page, not by
 * this component, so leaving for another thread does not stop an answer.
 */
function ChatPane({
  chat: liveChat,
  answer,
  keep,
  compact,
  pathname,
  onAsk,
  onSettled,
}: {
  chat: LiveChat;
  /** Where the last question stood when this thread was read back. */
  answer: AnswerState;
  /** Keep the chat alive after this screen moves on (the page with history). */
  keep: boolean;
  compact: boolean;
  /** The screen the question is asked from; sent along so the answer fits it. */
  pathname?: string;
  /** A question was sent to the live assistant. */
  onAsk: (text: string) => void;
  /** A live turn finished, whether it answered or was refused. */
  onSettled: () => void;
}) {
  const viewer = useViewer();
  const firstName = viewer.isDemo ? null : viewer.name.split(' ')[0];
  // Signed-up users talk to the real assistant; demo guests get sample answers.
  const live = !viewer.isDemo;
  const [demoMessages, setDemoMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [demoThinking, setDemoThinking] = useState(false);
  const idRef = useRef(1);
  const endRef = useRef<HTMLDivElement>(null);

  const chat = useChat({ chat: liveChat, throttle: 50 });
  const busy = chat.status === 'submitted' || chat.status === 'streaming';

  // Who is paying: the workspace's own key, or the user's free weekly questions.
  const { status: chatStatus, refresh: refreshChatStatus } = useChatStatus(live);
  const keyRequired = chatErrorCode(chat.error) === 'key_required';
  const locked = live && (isChatLocked(chatStatus) || keyRequired);
  // Re-read the allowance after each turn, whether it answered or was refused.
  const chatState = chat.status;
  useEffect(() => {
    if (chatState === 'ready' || chatState === 'error') void refreshChatStatus();
  }, [chatState, refreshChatStatus]);

  // A change that ran is shown by the screen behind the chat as well: its
  // data is read again, without losing what the user has open on it.
  const router = useRouter();
  const applied = live ? changesApplied(chat.messages) : 0;
  const appliedSeen = useRef({ chat: liveChat, count: applied });
  useEffect(() => {
    const seen = appliedSeen.current;
    // Another thread's finished changes are history, not news.
    if (seen.chat === liveChat && applied > seen.count) router.refresh();
    appliedSeen.current = { chat: liveChat, count: applied };
  }, [applied, liveChat, router]);

  // Tell the history list once per turn, after the answer (or refusal) lands.
  const turnOpen = useRef(false);
  useEffect(() => {
    if (chatState === 'submitted' || chatState === 'streaming') {
      turnOpen.current = true;
    } else if (turnOpen.current) {
      turnOpen.current = false;
      onSettled();
    }
  }, [chatState, onSettled]);

  const liveMessages: Message[] = chat.messages
    .map((m) => ({
      id: m.id,
      role: (m.role === 'user' ? 'user' : 'assistant') as Role,
      text: m.parts
        .map((part) => (part.type === 'text' ? part.text : ''))
        .join(''),
      files: m.role === 'user' ? m.parts.filter(isFilePart) : [],
      parts: m.role === 'user' ? undefined : m.parts,
      shown: hasVisibleContent(m),
    }))
    .filter((m) => m.shown || m.files.length > 0);

  // A change Tuah proposed is waiting for a yes or no.
  const lastRaw = chat.messages[chat.messages.length - 1];
  const lastParts = lastRaw?.role === 'assistant' ? lastRaw.parts : [];
  const needsDecision = live && !busy && lastParts.some((p) => toPendingApproval(p));
  // Words are arriving, or a lookup is showing its own spinner.
  const lastPart = lastParts[lastParts.length - 1];
  const midAnswer =
    !!lastPart &&
    ((isText(lastPart) && lastPart.text.trim().length > 0) ||
      // A specialist's card shows its own progress for as long as it works.
      (toSpecialistWork(lastPart, '', 0)?.running ??
        toToolStep(lastPart, '', 0)?.running ??
        false));
  const messages = live ? liveMessages : demoMessages;

  // A thread read back moments after its question (a reload mid-answer): the
  // server is still finishing the reply, so look for it until it is saved.
  const [awaiting, setAwaiting] = useState<AnswerState>(answer);
  const threadId = liveChat.id;
  const { setMessages } = chat;
  useEffect(() => {
    if (awaiting !== 'coming') return;
    let current = true;
    let tries = 0;
    const timer = window.setInterval(async () => {
      tries += 1;
      const loaded = await loadChatThreadAction(threadId).catch(() => null);
      if (!current) return;
      const last = loaded?.ok ? loaded.messages[loaded.messages.length - 1] : null;
      if (loaded?.ok && last?.role === 'assistant') {
        setMessages(loaded.messages as UIMessage[]);
        setAwaiting('settled');
      } else if (tries >= ANSWER_POLL_TRIES) {
        setAwaiting('lost');
      }
    }, ANSWER_POLL_MS);
    return () => {
      current = false;
      window.clearInterval(timer);
    };
  }, [awaiting, threadId, setMessages]);

  // Show the dots whenever Tuah is working with nothing on screen to show it.
  const thinking = live ? (busy && !midAnswer) || awaiting === 'coming' : demoThinking;

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, thinking]);

  // Files waiting to go with the next question.
  const [attachments, setAttachments] = useState<FileUIPart[]>([]);
  const [attachNote, setAttachNote] = useState<string | null>(null);

  async function pickFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    const picked = await convertFileListToFileUIParts(list);
    const usable = picked.filter(isAttachable);
    const next = [...attachments, ...usable].slice(0, MAX_ATTACHMENTS);
    // Earlier files stay in the conversation and travel with every question.
    const carried = attachmentChars(chat.messages) + attachmentChars([{ parts: next }]);
    if (carried > MAX_ATTACHMENT_CHARS) {
      setAttachNote(
        'That is too much to attach in one chat (about 7 MB in total). Try a smaller file, or start a new chat.',
      );
      return;
    }
    setAttachments(next);
    setAttachNote(
      usable.length < picked.length
        ? 'Only pictures, PDFs and text files (.txt, .csv, .md) can be attached.'
        : attachments.length + usable.length > MAX_ATTACHMENTS
          ? `Up to ${MAX_ATTACHMENTS} files can go with one question.`
          : null,
    );
  }

  function send(raw: string) {
    const q = raw.trim();
    if (live) {
      if (!q && attachments.length === 0) return;
      // A reply still on its way must land before the next question goes out.
      if (busy || locked || awaiting === 'coming') return;
      if (needsDecision) {
        setAttachNote('Approve or reject the change above first.');
        return;
      }
      if (keep) keepChat(viewer.userId, liveChat);
      setAwaiting('settled');
      // The team is the default; only switching it off needs saying.
      const solo = !teamMode();
      const options =
        pathname || solo
          ? { body: { ...(pathname ? { pathname } : {}), ...(solo ? { team: false } : {}) } }
          : undefined;
      void chat.sendMessage(
        attachments.length === 0
          ? { text: q }
          : q
            ? { text: q, files: attachments }
            : { files: attachments },
        options,
      );
      onAsk(q || (attachmentNote(attachments) ?? ''));
      setInput('');
      setAttachments([]);
      setAttachNote(null);
      return;
    }
    if (!q) return;
    if (demoThinking) return;
    setDemoMessages((m) => [...m, { id: idRef.current++, role: 'user', text: q }]);
    setInput('');
    setDemoThinking(true);
    window.setTimeout(() => {
      const r = getReply(q);
      setDemoMessages((m) => [
        ...m,
        { id: idRef.current++, role: 'assistant', text: r.text, card: r.card },
      ]);
      setDemoThinking(false);
    }, 800);
  }

  const empty = messages.length === 0;
  const width = compact ? '' : 'mx-auto max-w-2xl';
  // Demo guests keep the starters their sample answers are written for.
  const screenKey = screenFromPath(pathname)?.key;
  const suggestions = !compact
    ? SUGGESTIONS
    : ((live && screenKey && SCREEN_SUGGESTIONS[screenKey]) || SUGGESTIONS.slice(0, 4));

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        {empty ? (
          <div
            className={cn(
              'flex flex-1 flex-col items-center overflow-y-auto px-4 py-8',
              compact ? 'justify-start pt-10' : 'justify-center px-6 py-10',
            )}
          >
            <div className={cn('w-full', width)}>
              <div className="flex flex-col items-center text-center">
                <div
                  className={cn(
                    'mb-4 grid place-items-center rounded-2xl bg-primary text-primary-foreground shadow-sm',
                    compact ? 'size-12' : 'size-16',
                  )}
                >
                  <Sparkles className={compact ? 'size-6' : 'size-7'} />
                </div>
                <h1
                  className={cn(
                    'font-bold tracking-tight',
                    compact ? 'text-xl' : 'text-3xl',
                  )}
                >
                  {firstName ? `How can I help, ${firstName}?` : 'How can I help?'}
                </h1>
                <p className="mt-2 text-sm text-muted-foreground">
                  I’m Tuah, powered by {ASSISTANT.name}
                </p>
              </div>

              <div className="mt-6">
                <Composer
                  value={input}
                  onChange={setInput}
                  onSend={() => send(input)}
                  disabled={locked}
                  attachments={live ? attachments : undefined}
                  attachNote={attachNote}
                  onPickFiles={pickFiles}
                  onRemoveFile={(index) => {
                    setAttachments((files) => files.filter((_, i) => i !== index));
                    setAttachNote(null);
                  }}
                />
                <ChatKeyNotice status={chatStatus} className="mt-2" />
                <p className="mt-2 text-center text-xs text-muted-foreground">
                  AI can make mistakes. Check important info.
                </p>
              </div>

              {!compact ? (
                <div className="mt-6 flex flex-wrap justify-center gap-2">
                  {AGENTS.map((a) => {
                    const Icon = a.icon;
                    return (
                      <button
                        key={a.label}
                        type="button"
                        onClick={() => send(a.prompt)}
                        className="inline-flex items-center gap-1.5 rounded-full border bg-background px-3 py-1.5 text-xs font-medium shadow-sm transition-colors hover:bg-accent"
                      >
                        <Icon className="size-3.5 text-primary" />
                        Ask the {a.label}
                      </button>
                    );
                  })}
                </div>
              ) : null}

              <div className="mt-5 space-y-1">
                {suggestions.map((s) => {
                  const Icon = s.icon;
                  return (
                    <button
                      key={s.label}
                      type="button"
                      onClick={() => send(s.label)}
                      className="flex min-h-11 w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-medium transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <Icon className="size-4 shrink-0 text-muted-foreground" />
                      {s.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        ) : (
          <>
            <div className="flex-1 overflow-y-auto">
              <div className={cn('space-y-6 px-4 py-6 sm:px-6', width)}>
                {messages.map((m) =>
                  m.role === 'user' ? (
                    <div key={m.id} className="flex flex-col items-end gap-1.5">
                      {m.files && m.files.length > 0 ? (
                        <div className="flex max-w-[80%] flex-wrap justify-end gap-1.5">
                          {m.files.map((file, i) =>
                            file.mediaType.startsWith('image/') ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                key={i}
                                src={file.url}
                                alt={file.filename ?? 'Attached picture'}
                                className="max-h-40 max-w-full rounded-xl border object-cover"
                              />
                            ) : (
                              <span
                                key={i}
                                className="flex max-w-full items-center gap-1.5 rounded-xl border bg-muted px-3 py-2 text-xs font-medium"
                              >
                                <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                                <span className="truncate">{file.filename ?? 'File'}</span>
                              </span>
                            ),
                          )}
                        </div>
                      ) : null}
                      {m.text.trim() ? (
                        <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-sm text-primary-foreground">
                          {m.text.trim()}
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <div key={m.id} className="flex gap-3">
                      <SariAvatar />
                      <div className="min-w-0 flex-1 space-y-3 pt-1">
                        {m.parts ? (
                          m.parts.map((part, i) => {
                            if (isText(part)) {
                              return part.text.trim() ? (
                                <p key={i} className="whitespace-pre-wrap text-sm leading-relaxed">
                                  {part.text.trim()}
                                </p>
                              ) : null;
                            }
                            const asked = toSpecialistWork(part, String(m.id), i);
                            if (asked) {
                              return (
                                <SpecialistCard
                                  key={asked.key}
                                  agent={asked.agent}
                                  work={asked.work}
                                  failed={asked.failed}
                                />
                              );
                            }
                            const pending = toPendingApproval(part);
                            if (pending) {
                              return (
                                <ApprovalCard
                                  key={pending.approvalId}
                                  approval={pending}
                                  named={nameFinder(chat.messages)}
                                  proposal={proposalFor(pending.input, chat.messages)}
                                  onDecide={(approved) => {
                                    setAttachNote(null);
                                    void chat.addToolApprovalResponse({
                                      id: pending.approvalId,
                                      approved,
                                    });
                                  }}
                                />
                              );
                            }
                            const step = toToolStep(part, String(m.id), i);
                            if (!step) return null;
                            const input = 'input' in part ? part.input : undefined;
                            return (
                              <ToolStepCard
                                key={step.key}
                                step={step}
                                as={proposalFor(input, chat.messages)?.action}
                              />
                            );
                          })
                        ) : (
                          <p className="whitespace-pre-wrap text-sm leading-relaxed">
                            {m.text}
                          </p>
                        )}
                        {m.card ? <ReplyCard type={m.card} /> : null}
                      </div>
                    </div>
                  ),
                )}
                {thinking ? (
                  <div className="flex gap-3">
                    <SariAvatar />
                    <div className="flex items-center gap-1 pt-3">
                      {[0, 150, 300].map((d) => (
                        <span
                          key={d}
                          className="size-2 animate-bounce rounded-full bg-muted-foreground/50"
                          style={{ animationDelay: `${d}ms` }}
                        />
                      ))}
                    </div>
                  </div>
                ) : null}
                {live && awaiting === 'lost' && !busy && !chat.error ? (
                  <p role="status" className="text-sm text-muted-foreground">
                    This question did not get an answer. Ask it again to try once more.
                  </p>
                ) : null}
                {live && chat.error ? (
                  <p role="alert" className="text-sm text-muted-foreground">
                    {keyRequired
                      ? 'That question was not sent: your free questions are used up.'
                      : chatErrorCode(chat.error) === 'daily_limit'
                        ? DAILY_LIMIT_NOTICE
                        : 'Tuah could not respond just now. Please try again.'}
                  </p>
                ) : null}
                <div ref={endRef} />
              </div>
            </div>

            <div className="shrink-0 border-t bg-background px-4 py-4 sm:px-6">
              <div className={width}>
                <Composer
                  value={input}
                  onChange={setInput}
                  onSend={() => send(input)}
                  disabled={locked}
                  attachments={live ? attachments : undefined}
                  attachNote={attachNote}
                  onPickFiles={pickFiles}
                  onRemoveFile={(index) => {
                    setAttachments((files) => files.filter((_, i) => i !== index));
                    setAttachNote(null);
                  }}
                />
                <ChatKeyNotice status={chatStatus} className="mt-2" />
                <p className="mt-2 text-center text-xs text-muted-foreground">
                  AI can make mistakes. Check important info.
                </p>
              </div>
            </div>
          </>
        )}
    </div>
  );
}

function SariAvatar() {
  return (
    <span className="grid size-8 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground">
      <Sparkles className="size-4" />
    </span>
  );
}

function Composer({
  value,
  onChange,
  onSend,
  disabled = false,
  attachments,
  attachNote = null,
  onPickFiles,
  onRemoveFile,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  disabled?: boolean;
  /** Files waiting to be sent. Left out where files cannot be sent (the demo). */
  attachments?: FileUIPart[];
  /** Why a picked file was not added, if one was not. */
  attachNote?: string | null;
  onPickFiles?: (files: FileList | null) => void;
  onRemoveFile?: (index: number) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const canAttach = !!attachments && !disabled;
  const files = attachments ?? [];
  const hasFiles = files.length > 0;

  return (
    <div>
      <div className="rounded-2xl border bg-background p-2 shadow-sm focus-within:ring-2 focus-within:ring-ring">
        {hasFiles ? (
          <ul className="mb-1 flex flex-wrap gap-1.5 px-1 pt-1" aria-label="Files to send">
            {files.map((file, i) => (
              <li
                key={`${file.filename ?? 'file'}-${i}`}
                className="flex max-w-full items-center gap-1.5 rounded-lg border bg-muted py-1 pl-2 pr-1 text-xs font-medium"
              >
                {file.mediaType.startsWith('image/') ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={file.url} alt="" className="size-6 shrink-0 rounded object-cover" />
                ) : (
                  <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                )}
                <span className="max-w-40 truncate">{file.filename ?? 'File'}</span>
                <button
                  type="button"
                  onClick={() => onRemoveFile?.(i)}
                  aria-label={`Remove ${file.filename ?? 'file'}`}
                  className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex items-end gap-2">
          {attachments ? (
            <>
              <input
                ref={fileRef}
                type="file"
                multiple
                accept={ATTACH_ACCEPT}
                className="hidden"
                tabIndex={-1}
                onChange={(e) => {
                  onPickFiles?.(e.target.files);
                  e.target.value = '';
                }}
              />
              <button
                type="button"
                aria-label="Attach files"
                title="Attach pictures, PDFs or text files"
                disabled={!canAttach}
                onClick={() => fileRef.current?.click()}
                className="grid size-9 shrink-0 cursor-pointer place-items-center rounded-full bg-muted text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Plus className="size-4" aria-hidden />
              </button>
            </>
          ) : null}
          <textarea
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                onSend();
              }
            }}
            rows={1}
            placeholder={
              disabled ? 'Add an OpenRouter key to keep chatting' : 'Ask anything…'
            }
            disabled={disabled}
            aria-label="Ask anything"
            className={cn(
              'max-h-40 flex-1 resize-none bg-transparent py-2 text-sm outline-none placeholder:text-muted-foreground',
              attachments ? 'px-1' : 'px-3',
            )}
          />
          <button
            type="button"
            aria-label="Voice"
            className="grid size-9 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground transition-colors hover:bg-accent"
          >
            <Mic className="size-4" />
          </button>
          <button
            type="button"
            aria-label="Send"
            onClick={onSend}
            disabled={disabled || (!value.trim() && !hasFiles)}
            className="grid size-9 shrink-0 place-items-center rounded-full bg-foreground text-background transition-opacity disabled:opacity-40"
          >
            <ArrowUp className="size-4" />
          </button>
        </div>
      </div>
      {attachNote ? (
        <p role="status" className="mt-1.5 px-1 text-xs text-muted-foreground">
          {attachNote}
        </p>
      ) : null}
    </div>
  );
}
