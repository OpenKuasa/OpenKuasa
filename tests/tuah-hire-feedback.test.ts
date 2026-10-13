// tests/tuah-hire-feedback.test.ts
import { describe, expect, it, vi } from 'vitest';
import type { Feedback } from '@/lib/hire/interview-feedback';
import { interviewCardFromLists } from '@/lib/hire/namesakes';
import { createSeedHireData } from '@/lib/hire/seed';
import { createSeedReachData } from '@/lib/reach/seed';
import type { InterviewStatus } from '@/lib/hire/types';

type Call = { tool: string; input: unknown };
const seen = vi.hoisted(() => ({
  calls: [] as { layer: string; prompt: string }[],
  /** What Lekir calls as Tuah's specialist, step by step (the last one repeats). A list is several calls in one step; 'answer' is a report in words, which ends that delegation. */
  workerScript: null as null | (Call | Call[] | 'answer')[],
  workerStep: 0,
  /** What one agent holding the tools calls: its nth model call makes every call of the nth list, and answers in words after the last. */
  singleScript: null as null | Call[][],
  /** Every refusal a specialist's tool answered with (`prepared: false`), in order. */
  refusals: [] as string[],
}));
const feedbackSaved = vi.hoisted(() => vi.fn());
const feedbackCleared = vi.hoisted(() => vi.fn());
const outcomeSet = vi.hoisted(() => vi.fn());

// The real schemas, so a prepared input is checked as it is in the app; only the three writes are recorded.
vi.mock('@/lib/hire/capabilities', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/hire/capabilities')>()),
  saveInterviewFeedback: feedbackSaved,
  clearInterviewFeedback: feedbackCleared,
  setInterviewOutcome: outcomeSet,
}));

// The real `tool`, but a refusal a specialist's tool answers with is noted.
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  type Def = { execute?: (...args: unknown[]) => unknown };
  const noting = (def: Def) => {
    const run = def.execute;
    // A specialist itself streams its progress (a generator): left as it is.
    if (!run || run.constructor.name !== 'AsyncFunction') return def;
    return {
      ...def,
      execute: async (...args: unknown[]) => {
        const output = (await run(...args)) as { prepared?: unknown; error?: unknown } | null;
        if (output?.prepared === false && typeof output.error === 'string') seen.refusals.push(output.error);
        return output;
      },
    };
  };
  return { ...actual, tool: ((def: Def) => (actual.tool as (d: Def) => unknown)(noting(def))) as typeof actual.tool };
});

vi.mock('@/lib/ai/provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/provider')>();
  const { MockLanguageModelV4, simulateReadableStream } = await import('ai/test');
  const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
  const finish = { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage };
  /** Several calls in one step, each with a call id of its own: the tool's name and its place in the step. */
  const callAll = (calls: Call[]): Record<string, unknown>[] => [
    ...calls.map(({ tool, input }, n) => ({ type: 'tool-call', toolCallId: `call-${tool}-${n}`, toolName: tool, input: JSON.stringify(input) })),
    finish,
  ];
  const answer: Record<string, unknown>[] = [
    { type: 'text-start', id: '0' }, { type: 'text-delta', id: '0', delta: 'ok' }, { type: 'text-end', id: '0' },
    { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
  ];
  return {
    ...actual,
    getModel: (layer: string) =>
      new MockLanguageModelV4({
        doStream: async (options: { prompt: unknown }) => {
          seen.calls.push({ layer, prompt: JSON.stringify(options.prompt) });
          let chunks = answer;
          if (seen.singleScript) {
            const step = seen.singleScript[seen.calls.length - 1];
            chunks = step?.length ? callAll(step) : answer;
          } else if (seen.workerScript) {
            if (layer === 'worker') {
              const step = seen.workerScript[Math.min(seen.workerStep++, seen.workerScript.length - 1)];
              chunks = step === 'answer' ? answer : callAll([step].flat());
            } else {
              chunks = callAll([{ tool: 'askLekir', input: { task: 'Do what the user asked about the interview feedback' } }]);
            }
          }
          return { stream: simulateReadableStream({ initialDelayInMs: 0, chunkDelayInMs: 0, chunks }) };
        },
      } as unknown as ConstructorParameters<typeof MockLanguageModelV4>[0]) as never,
  };
});

const { runLekir, runTuah } = await import('@/lib/ai/agents/orchestrator');
// After this file's mocks are in place: the helpers load the tools too.
const { withLekir, withTuah } = await import('./helpers/approvals');
// What a chat route does before it runs an agent.
const { rejectedIn, recordedProposals } = await import('@/lib/chat/approvals');
const { clientMessages } = await import('@/lib/ai/chat-request');
const { approvalBinding } = await import('@/lib/ai/products');
const { memoryProposalStore } = await import('@/lib/chat/proposal-store');
const { namesIn, proposalsIn } = await import('@/lib/chat/delegation');
const { approvalDetail } = await import('@/lib/chat/change-titles');

type UI = import('ai').UIMessage;
type Model = import('ai').ModelMessage;
type ToolPart = { type: string; state?: string; toolCallId?: string; input?: unknown; approval?: { id: string; approved?: boolean; reason?: string; requestReason?: string; isAutomatic?: boolean } };
type Card = { type: string; isAutomatic?: boolean; approved?: boolean; reason?: string; toolCall?: { toolName?: string; input?: unknown } };

const NOW = new Date('2026-10-10T04:00:00Z');
const APP = '44444444-4444-4444-8444-444444444491';
const IV = '11111111-1111-4111-8111-111111111191';
const IV2 = '22222222-2222-4222-8222-222222222292';
// A name and a job nobody else in the sample data has.
const WHO = 'Putri Maisarah Dahlan';
const JOB = 'Night Auditor';
/** 3:00 pm on Tuesday 6 October 2026 in Kuala Lumpur; the second interview is at 11:00 am on Thursday 22 October. */
const AT = '2026-10-06T07:00:00.000Z';
const LATER = '2026-10-22T03:00:00.000Z';
const STORED: Feedback = { rating: 3, recommendation: 'hold', comments: 'Unsure about night shifts.', recorded_at: '2026-10-07T02:05:40.000Z' };
const LINE = 'This interview: Tue 6 Oct 2026, 3:00 pm · video · 1 hour · No place or link given';
const NONE_YET = `${LINE}\nNow: completed · no feedback yet`;
const HAS = `${LINE}\nNow: completed · feedback 3 out of 5 · Hold · saved Wed 7 Oct 2026, 10:05:40 am`;
const EDITED = `${LINE}\nNow: completed · feedback 3 out of 5 · Hold · saved Wed 7 Oct 2026, 11:30:00 am`;
const ONE_INTERVIEW_CHANGE = 'One interview change at a time. One is already prepared for approval.';
const NOT_COMPLETED =
  'This interview is still marked scheduled, so no feedback was prepared. Feedback is for a completed interview: ask the user whether it took place. ' +
  'If they said it did, prepare it again with mark_completed set to true.';
const EXISTS =
  'This interview already has feedback, so nothing was prepared. Tell the user what the feedback is and ask whether to replace it. ' +
  'If they say yes, prepare it again with replace set to true.';
const LAST = 'This does not move or reject the application.';

type State = { status: InterviewStatus; feedback: Feedback | null; second?: boolean };
/** One application with one interview (and, with `second`, a scheduled one later). The checks read these rows; a test changes `state` to play a colleague. */
const world = (state: State) => {
  const base = createSeedHireData(NOW);
  const interview = (id: string, scheduled_at: string, status: InterviewStatus, feedback: Feedback | null) => ({
    id, application_id: APP, candidate_name: WHO, job_title: JOB, scheduled_at, kind: 'video' as const, interviewer_name: null, status,
    created_at: '2026-09-25T02:00:00.000Z', updated_at: '2026-10-06T08:00:00.000Z', duration_minutes: 60, place: null, notes: null,
    application_stage: 'interview' as const, application_outcome: 'active' as const, ...(feedback ? { feedback } : {}),
  });
  const listInterviews = async () => [interview(IV, AT, state.status, state.feedback), ...(state.second ? [interview(IV2, LATER, 'scheduled', null)] : [])];
  const listApplications = async () =>
    (await base.listApplications()).map((a, n) => (n === 0 ? { ...a, id: APP, candidate_name: WHO, job_title: JOB, stage: 'interview' as const, outcome: 'active' as const } : a));
  const interviewCard = async (id: unknown) => interviewCardFromLists(id, await listInterviews(), await listApplications());
  return { data: { ...base, listInterviews, listApplications, interviewCard }, write: { ctx: { client: {} as never, orgId: 'org1' }, canWrite: true } };
};
type Access = ReturnType<typeof world>;
const reach = () => ({ data: createSeedReachData() });
const listAll: Call = { tool: 'listInterviews', input: {} };
const SAVE = { id: IV, rating: 4, recommendation: 'advance', comments: 'Strong on key accounts.' };
const save = (over: Record<string, unknown> = {}): Call => ({ tool: 'saveInterviewFeedback', input: { ...SAVE, ...over } });
const reset = () => {
  for (const fn of [feedbackSaved, feedbackCleared, outcomeSet]) fn.mockReset();
  feedbackSaved.mockResolvedValue({ ok: true, data: { id: IV, candidate: WHO, job: JOB, message: `Saved feedback on the interview with ${WHO}: 4 out of 5, advance.`, feedback: null, replaced: false, marked_completed: false, confirmed: true } });
  seen.calls = [];
  seen.refusals = [];
  seen.workerStep = 0;
};
const nothingSaved = () => {
  for (const fn of [feedbackSaved, feedbackCleared, outcomeSet]) expect(fn).not.toHaveBeenCalled();
};

describe('one request, one agent holding the tools', () => {
  /** One request: the model's nth step makes every call of the nth list. The cards put in front of the user, and what a gate denied. */
  const request = async (steps: Call[][], agent: 'tuah' | 'lekir', access: Access, said: string) => {
    reset();
    const messages: Model[] = [{ role: 'user', content: said }];
    seen.singleScript = steps;
    try {
      const result = agent === 'lekir' ? runLekir(...withLekir(messages, access)) : runTuah(...withTuah(messages, reach(), undefined, undefined, null, null, null, access));
      await result.consumeStream();
      const content = ((await result.steps) as unknown as { content: Card[] }[]).flatMap((s) => s.content);
      return {
        cards: content.filter((p) => p.type === 'tool-approval-request' && !p.isAutomatic),
        denials: content.filter((p) => p.type === 'tool-approval-response' && p.approved === false).map((p) => p.reason),
      };
    } finally {
      seen.singleScript = null;
    }
  };
  const agents = ['tuah', 'lekir'] as const;
  // A filler lookup first, so the call that follows gets a call id of its own.
  const filler: Call = { tool: 'listJobs', input: {} };

  it.each(agents)('%s: feedback for an interview it looked up reaches one card, with the server\'s two lines, everything that will be saved, and nothing saved', async (agent) => {
    const run = await request([[listAll], [save()]], agent, world({ status: 'completed', feedback: null }), `Record feedback for ${WHO}: 4 out of 5, advance, strong on key accounts`);
    expect(run.denials).toEqual([]);
    expect(run.cards).toHaveLength(1);
    expect(run.cards[0].toolCall).toMatchObject({ toolName: 'saveInterviewFeedback', input: SAVE });
    expect(run.cards[0].reason).toBe(NONE_YET);
    expect(approvalDetail('saveInterviewFeedback', run.cards[0].toolCall!.input)).toBe(`4 out of 5 · Recommendation: Advance · Comments: Strong on key accounts. · ${LAST}`);
    nothingSaved();
  });
  it.each(agents)('%s: feedback beside an outcome in one step is one card, whichever comes first', async (agent) => {
    const outcome: Call = { tool: 'setInterviewOutcome', input: { id: IV2, outcome: 'completed' } };
    const both = { status: 'completed' as const, feedback: null, second: true };
    const first = await request([[listAll], [outcome, save()]], agent, world(both), 'Mark the second one completed and record 4, advance for the first');
    expect(first.cards).toHaveLength(1);
    expect(first.cards[0].toolCall).toMatchObject({ toolName: 'setInterviewOutcome' });
    expect(first.denials).toEqual([ONE_INTERVIEW_CHANGE]);
    const reverse = await request([[listAll], [save(), outcome]], agent, world(both), 'Record 4, advance for the first and mark the second one completed');
    expect(reverse.cards).toHaveLength(1);
    expect(reverse.cards[0].toolCall).toMatchObject({ toolName: 'saveInterviewFeedback' });
    expect(reverse.denials).toEqual([ONE_INTERVIEW_CHANGE]);
    nothingSaved();
  });
  it.each(agents)('%s: an interview still marked scheduled gets no card until the change says it took place; the refused call is not the turn\'s one', async (agent) => {
    const run = await request([[listAll], [save()], [filler, save({ mark_completed: true })]], agent, world({ status: 'scheduled', feedback: null }), `We met ${WHO} today. 4 out of 5, advance, strong on key accounts`);
    expect(run.denials).toEqual([NOT_COMPLETED]);
    expect(run.cards).toHaveLength(1);
    expect(run.cards[0].toolCall).toMatchObject({ toolName: 'saveInterviewFeedback', input: { mark_completed: true } });
    expect(run.cards[0].reason).toBe(`${LINE}\nNow: scheduled · no feedback yet`);
    expect(approvalDetail('saveInterviewFeedback', run.cards[0].toolCall!.input)).toContain(' · Also marks the interview completed. · ');
    nothingSaved();
  });
  it.each(agents)('%s: feedback that would overwrite gets no card until the change says replace; then the card says it REPLACES, and shows what is there now', async (agent) => {
    const run = await request([[listAll], [save()], [filler, save({ replace: true })]], agent, world({ status: 'completed', feedback: STORED }), `Change ${WHO}'s interview feedback to 4, advance`);
    expect(run.denials).toEqual([EXISTS]);
    expect(run.cards).toHaveLength(1);
    expect(run.cards[0].reason).toBe(HAS);
    expect(approvalDetail('saveInterviewFeedback', run.cards[0].toolCall!.input)).toContain(' · Replaces the feedback already recorded. · ');
    nothingSaved();
  });
  it.each(agents)('%s: a call the tool\'s own input check refused (a rating of 9) is not the turn\'s one: sent again in range, it gets its card', async (agent) => {
    const run = await request([[listAll], [save({ rating: 9 })], [filler, save()]], agent, world({ status: 'completed', feedback: null }), `Record 9 for ${WHO}, advance`);
    expect(run.denials).toEqual([]);
    expect(run.cards).toHaveLength(1);
    expect(run.cards[0].toolCall).toMatchObject({ toolName: 'saveInterviewFeedback', input: { rating: 4 } });
  });
});

describe('one request, Tuah\'s team', () => {
  /** One request: what Lekir prepared, the refusals its tools gave, and the cards put in front of the user. */
  const prepare = async (script: NonNullable<typeof seen.workerScript>, access: Access, said: string) => {
    reset();
    const context = { transcript: '', proposals: new Map<string, { action: string; input: unknown; title: string; detail: string | null }>(), names: {} };
    seen.workerScript = script;
    try {
      const result = runTuah(...withTuah([{ role: 'user' as const, content: said }], reach(), undefined, undefined, null, null, context as never, access));
      await result.consumeStream();
      const cards = ((await result.steps) as unknown as { content: Card[] }[]).flatMap((s) => s.content).filter((p) => p.type === 'tool-approval-request' && !p.isAutomatic);
      return { proposals: [...context.proposals.values()], cards, refusals: [...seen.refusals] };
    } finally {
      seen.workerScript = null;
    }
  };

  it('prepares one card for feedback on an interview Lekir looked up: the title, everything that will be saved, the server\'s two lines, and nothing saved', async () => {
    const run = await prepare([listAll, save()], world({ status: 'completed', feedback: null }), `Record feedback for ${WHO}: 4 out of 5, advance, strong on key accounts`);
    expect(run.refusals).toEqual([]);
    expect(run.proposals).toHaveLength(1);
    expect(run.proposals[0]).toMatchObject({
      action: 'saveInterviewFeedback', input: SAVE,
      title: `Record feedback on the interview with ${WHO} (${JOB})?`,
      detail: `4 out of 5 · Recommendation: Advance · Comments: Strong on key accounts. · ${LAST}`,
    });
    expect(run.cards).toHaveLength(1);
    expect(run.cards[0].reason).toBe(NONE_YET);
    // The line is on the card only: no proposal holds it.
    expect(JSON.stringify(run.proposals)).not.toContain('This interview');
    nothingSaved();
  });
  it('feedback beside an outcome in one step: only the first is prepared, whichever it is', async () => {
    const outcome: Call = { tool: 'setInterviewOutcome', input: { id: IV2, outcome: 'completed' } };
    const both = { status: 'completed' as const, feedback: null, second: true };
    const first = await prepare([listAll, [outcome, save()]], world(both), 'Mark the second one completed and record 4, advance for the first');
    expect(first.proposals.map((p) => p.action)).toEqual(['setInterviewOutcome']);
    expect(first.refusals).toEqual([ONE_INTERVIEW_CHANGE]);
    const reverse = await prepare([listAll, [save(), outcome]], world(both), 'Record 4, advance for the first and mark the second one completed');
    expect(reverse.proposals.map((p) => p.action)).toEqual(['saveInterviewFeedback']);
    expect(reverse.refusals).toEqual([ONE_INTERVIEW_CHANGE]);
    nothingSaved();
  });
  it('a scheduled interview, and feedback that would overwrite, are refused when preparing, in the rule\'s own words; sent again as told, each is prepared', async () => {
    const scheduled = await prepare([listAll, save(), save({ mark_completed: true })], world({ status: 'scheduled', feedback: null }), `We met ${WHO} today. 4, advance`);
    expect(scheduled.refusals).toEqual([NOT_COMPLETED]);
    expect(scheduled.proposals).toHaveLength(1);
    expect(scheduled.proposals[0].detail).toContain(' · Also marks the interview completed. · ');
    expect(scheduled.cards[0].reason).toBe(`${LINE}\nNow: scheduled · no feedback yet`);
    const rated = await prepare([listAll, save(), save({ replace: true })], world({ status: 'completed', feedback: STORED }), `Change ${WHO}'s feedback to 4, advance`);
    expect(rated.refusals).toEqual([EXISTS]);
    expect(rated.proposals[0].detail).toContain(' · Replaces the feedback already recorded. · ');
    expect(rated.cards[0].reason).toBe(HAS);
    nothingSaved();
  });
});

describe('through the user\'s answer, as a chat route runs each request', () => {
  type Store = ReturnType<typeof memoryProposalStore>;
  /** One conversation as a chat route runs each of its requests, with one store for the conversation (see tests/tuah-hire.test.ts, `asRoute`). */
  const asRoute = (mode: 'lekir' | 'tuah' | 'team', access: Access, store: Store = memoryProposalStore()) => async (chat: UI[]) => {
    const { convertToModelMessages } = await import('ai');
    const sent = clientMessages(chat) as typeof chat;
    const messages = await convertToModelMessages(sent);
    const rejected = rejectedIn(sent as never);
    if (rejected.length > 0) await store.reject(rejected);
    const approvals = approvalBinding(store, messages);
    if (mode === 'lekir') return runLekir(messages, access, undefined, undefined, approvals);
    const teamContext = mode === 'team' ? { transcript: '', proposals: await recordedProposals(store, sent as never), names: namesIn(sent) } : null;
    return runTuah(messages, reach(), undefined, undefined, null, null, teamContext, access, null, null, approvals);
  };
  type Runner = ReturnType<typeof asRoute>;
  const say = (id: string, text: string): UI => ({ id, role: 'user', parts: [{ type: 'text', text }] });
  /** `calls` is what the one agent's model calls, one list per step. The team's specialist follows `seen.workerScript`. */
  const exchange = async (chat: UI[], run: Runner, calls: Call[][] | null): Promise<UI[]> => {
    const { readUIMessageStream } = await import('ai');
    const last = chat[chat.length - 1];
    const paused = last.role === 'assistant' ? structuredClone(last) : undefined;
    seen.calls = [];
    seen.singleScript = calls;
    try {
      const result = await run(chat);
      let answer: UI | undefined;
      for await (const message of readUIMessageStream({ message: paused, stream: result.toUIMessageStream() as never })) answer = message as UI;
      return paused ? [...chat.slice(0, -1), answer!] : [...chat, answer!];
    } finally {
      seen.singleScript = null;
    }
  };
  const toolParts = (chat: UI[]) => chat.flatMap((m) => m.parts as unknown as ToolPart[]).filter((p) => p.type.startsWith('tool-'));
  const waiting = (chat: UI[]) => toolParts(chat).filter((p) => p.state === 'approval-requested' && !p.approval?.isAutomatic);
  /** The parts the user said yes to that then did not run. */
  const stopped = (chat: UI[]) => toolParts(chat).filter((p) => p.state === 'output-denied' && p.approval?.approved === true);
  const decide = (chat: UI[], approved: boolean): UI[] => {
    const next = structuredClone(chat);
    const [card] = waiting(next);
    card.state = 'approval-responded';
    card.approval = { ...card.approval!, approved };
    return next;
  };
  /** What a waiting card would do, whichever agent shows it: the tool and its input. */
  const asks = (chat: UI[], card: ToolPart): { action: string; input: unknown } => {
    if (card.type !== 'tool-applyChange') return { action: card.type.slice('tool-'.length), input: card.input };
    const proposal = proposalsIn(chat).get((card.input as { proposalId: string }).proposalId)!;
    return { action: proposal.action, input: proposal.input };
  };
  /** True when a model in the last request was told this, in the conversation and not in its own instructions. */
  const told = (words: string) =>
    seen.calls.some((call) => JSON.stringify((JSON.parse(call.prompt) as { role: string }[]).filter((m) => m.role !== 'system')).includes(words));

  describe.each(['lekir', 'tuah', 'team'] as const)('%s', (mode) => {
    const own = mode !== 'team';

    it.each([true, false])('one card for the feedback; answered (approved: %s), it is saved once with exactly what the card showed, or not at all', async (approved) => {
      reset();
      const run = asRoute(mode, world({ status: 'completed', feedback: null }));
      seen.workerScript = own ? null : [listAll, save(), 'answer'];
      try {
        const shown = await exchange([say('u1', `Record feedback for ${WHO}: 4 out of 5, advance, strong on key accounts`)], run, own ? [[listAll], [save()]] : null);
        expect(waiting(shown)).toHaveLength(1);
        expect(asks(shown, waiting(shown)[0])).toEqual({ action: 'saveInterviewFeedback', input: SAVE });
        expect(waiting(shown)[0].approval?.requestReason).toBe(NONE_YET);
        nothingSaved();

        const after = await exchange(decide(shown, approved), run, own ? [] : null);
        expect(feedbackSaved).toHaveBeenCalledTimes(approved ? 1 : 0);
        // The arguments the server kept when it proposed the change.
        if (approved) expect(feedbackSaved.mock.calls[0][1]).toEqual(SAVE);
        expect(waiting(after)).toEqual([]);
        expect(stopped(after)).toEqual([]);
      } finally {
        seen.workerScript = null;
      }
    });

    it('a colleague changes the feedback between the card and the yes: the approved replacement is stopped, and the one prepared in its place shows the feedback as it is now and runs once', async () => {
      reset();
      const state: State = { status: 'completed', feedback: STORED };
      const run = asRoute(mode, world(state));
      const replace = save({ replace: true });
      seen.workerScript = own ? null : [listAll, replace, replace, 'answer'];
      try {
        const shown = await exchange([say('u1', `Change ${WHO}'s interview feedback to 4, advance, strong on key accounts`)], run, own ? [[listAll], [replace]] : null);
        expect(waiting(shown)).toHaveLength(1);
        expect(waiting(shown)[0].approval?.requestReason).toBe(HAS);

        // A colleague saves an edit while the card waits: the same rating and recommendation, a later time.
        state.feedback = { ...STORED, comments: 'Fine with night shifts after all.', recorded_at: '2026-10-07T03:30:00.000Z' };
        const retried = await exchange(decide(shown, true), run, own ? [[{ tool: 'listJobs', input: {} }, replace]] : null);
        expect(feedbackSaved).not.toHaveBeenCalled();
        expect(stopped(retried)).toHaveLength(1);
        expect(told('This interview was changed after the card was shown')).toBe(true);
        // It was not the turn's one: the card prepared in its place is shown, with the feedback as it is now.
        expect(waiting(retried)).toHaveLength(1);
        expect(asks(retried, waiting(retried)[0])).toEqual({ action: 'saveInterviewFeedback', input: { ...SAVE, replace: true } });
        expect(waiting(retried)[0].approval?.requestReason).toBe(EDITED);

        const done = await exchange(decide(retried, true), run, own ? [] : null);
        expect(feedbackSaved).toHaveBeenCalledTimes(1);
        expect(feedbackSaved.mock.calls[0][1]).toEqual({ ...SAVE, replace: true });
        expect(waiting(done)).toEqual([]);
      } finally {
        seen.workerScript = null;
      }
    });

    it('a colleague clears the feedback between the card and the yes: the approved replacement is stopped, in that outcome\'s own words', async () => {
      reset();
      const state: State = { status: 'completed', feedback: STORED };
      const run = asRoute(mode, world(state));
      const replace = save({ replace: true });
      seen.workerScript = own ? null : [listAll, replace, 'answer'];
      try {
        const shown = await exchange([say('u1', `Change ${WHO}'s interview feedback to 4, advance`)], run, own ? [[listAll], [replace]] : null);
        expect(waiting(shown)).toHaveLength(1);
        state.feedback = null;
        const after = await exchange(decide(shown, true), run, own ? [] : null);
        expect(feedbackSaved).not.toHaveBeenCalled();
        expect(stopped(after)).toHaveLength(1);
        expect(told('This interview has no feedback yet, so there is nothing to replace')).toBe(true);
        expect(told('I could not check')).toBe(false);
      } finally {
        seen.workerScript = null;
      }
    });
  });
});
