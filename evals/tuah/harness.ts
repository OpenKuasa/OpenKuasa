/**
 * Runs Tuah the way `/api/chat` does, without the browser: real models, the
 * real tools, a real signed-in user and their workspace. A case asks
 * questions, approves or rejects what Tuah proposes, and is then scored
 * against the database, so "it answered" and "it did the right thing" are
 * checked separately and by code rather than by eye.
 *
 * Everything a case creates carries the tag `EVAL_TAG` and is removed again.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { ModelMessage } from 'ai';
import { runTuah } from '@/lib/ai/agents/orchestrator';
import { getCurrentOrg } from '@/lib/auth/current-org';
import { collectNames, type KnownNames } from '@/lib/chat/change-titles';
import { APPLY_TOOL, ASK_PREFIX, isDelegation, type Proposal } from '@/lib/chat/delegation';
import { createSupabaseHireData } from '@/lib/hire/supabase';
import type { Application, Candidate, Job } from '@/lib/hire/types';
import { createSupabaseReachData } from '@/lib/reach/supabase';

/** Marks every row an eval creates, so cleanup never touches anything else. */
export const EVAL_TAG = 'evalcheck';

export type Account = { email: string; password: string };

/**
 * The account to run as: `EVAL_EMAIL` / `EVAL_PASSWORD`, or a JSON file with
 * `email` and `password` (`EVAL_ACCOUNT_FILE`, default
 * `~/.config/openkuasa/smoke-account.json`). Null when neither is there.
 */
export function evalAccount(): Account | null {
  if (process.env.EVAL_EMAIL && process.env.EVAL_PASSWORD) {
    return { email: process.env.EVAL_EMAIL, password: process.env.EVAL_PASSWORD };
  }
  const file =
    process.env.EVAL_ACCOUNT_FILE ?? `${homedir()}/.config/openkuasa/smoke-account.json`;
  try {
    const { email, password } = JSON.parse(readFileSync(file, 'utf8')) as Partial<Account>;
    return email && password ? { email, password } : null;
  } catch {
    return null;
  }
}

export type Workspace = {
  client: SupabaseClient;
  userId: string;
  orgId: string;
  role: string;
};

/** Signs in as the eval account and finds its workspace. */
export async function openWorkspace(account: Account): Promise<Workspace> {
  const client = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const { data, error } = await client.auth.signInWithPassword(account);
  if (error || !data.user) throw new Error(`Could not sign in the eval account: ${error?.message}`);
  const org = await getCurrentOrg(client);
  if (!org) throw new Error('The eval account has no workspace.');
  return { client, userId: data.user.id, orgId: org.orgId, role: org.role };
}

/**
 * Turns start at least this far apart (`EVAL_TURN_GAP_MS`, default 10 s). A
 * model provider that limits calls per minute otherwise refuses them, and a
 * refused call says nothing about how accurate Tuah is.
 */
let nextTurnAt = 0;
async function turnSlot(): Promise<void> {
  const gap = Number(process.env.EVAL_TURN_GAP_MS ?? 10_000);
  const now = Date.now();
  const at = Math.max(now, nextTurnAt);
  nextTurnAt = at + gap;
  if (at > now) await new Promise((resolve) => setTimeout(resolve, at - now));
}

/** The model provider refused or dropped a call: the run says nothing about accuracy. */
export function isProviderFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no output generated|could not finish|rate limit|credits|\b429\b|\b402\b/i.test(message);
}

/** What happened in one turn, in the terms a case is scored on. */
export type Turn = {
  /** Everything Tuah said this turn. */
  text: string;
  /** The specialists Tuah asked, by name, in order. */
  asked: string[];
  /** The lookups and prepared changes the specialists ran, by tool name. */
  steps: string[];
  /** The changes now waiting for a yes or no. */
  pending: Proposal[];
  /** The line each waiting card carries from the server for the person deciding (which of two same-named people it is), where it has one. */
  notes: string[];
  /** What each change that ran this turn returned. */
  applied: { proposal: Proposal; output: unknown }[];
};

type Approval = { approvalId: string; proposal: Proposal | undefined };

type ContentPart = {
  type: string;
  approvalId?: string;
  /** Set on a request the server answered itself: that one is not waiting for anybody. */
  isAutomatic?: boolean;
  /** A line the server put on the request for the person deciding. */
  reason?: string;
  toolCall?: { toolName?: string; input?: unknown };
};

/** One chat with Tuah. */
export class Conversation {
  private messages: ModelMessage[] = [];
  private proposals = new Map<string, Proposal>();
  private names: KnownNames = {};
  private lines: string[] = [];
  private approvals: Approval[] = [];

  constructor(
    private workspace: Workspace,
    /** Run as someone who can look but not change, whatever the account's role. */
    private viewer = false,
    /**
     * Extra applications, candidates, jobs and one CV a case supplies, so no
     * row or file is written anywhere. Without a CV, Lekir gets no CV reader.
     */
    private hire?: { applications?: Application[]; cv?: Uint8Array; candidates?: Candidate[]; jobs?: Job[] },
  ) {}

  async ask(text: string): Promise<Turn> {
    this.messages.push({ role: 'user', content: text });
    this.lines.push(`User: ${text}`);
    return this.run();
  }

  /** Answers every change that is waiting, the same way. */
  async decide(approved: boolean): Promise<Turn> {
    if (this.approvals.length === 0) throw new Error('Nothing is waiting for a decision.');
    this.messages.push({
      role: 'tool',
      content: this.approvals.map((a) => ({
        type: 'tool-approval-response' as const,
        approvalId: a.approvalId,
        approved,
      })),
    });
    return this.run();
  }

  private async run(): Promise<Turn> {
    await turnSlot();
    const { client, orgId, userId } = this.workspace;
    const canWrite = !this.viewer && this.workspace.role !== 'viewer';
    const realHire = createSupabaseHireData(client, orgId);
    const extra = this.hire;
    const extraApplications = extra?.applications ?? [];
    const extraCv = extra?.cv;
    const result = runTuah(
      this.messages,
      {
        data: createSupabaseReachData(client, orgId),
        write: canWrite ? { ctx: { client, orgId }, canWrite: true } : undefined,
      },
      AbortSignal.timeout(90_000),
      undefined,
      null,
      { client, orgId, userId, canWrite },
      {
        transcript: this.lines.slice(-8).join('\n').slice(-2_000),
        proposals: this.proposals,
        names: this.names,
      },
      {
        data: extra
          ? {
              ...realHire,
              // The made-up rows are in no database: the same-name check before a deletion must read these lists, not the database.
              namesakes: undefined,
              // The same for a person's pool status: read from the lists below, which hold the made-up people.
              poolStatusOf: undefined,
              listJobs: async () => [...(extra.jobs ?? []), ...(await realHire.listJobs())],
              listApplications: async () => [...extraApplications, ...(await realHire.listApplications())],
              // An application has a candidate behind it: a lookup by name must find the person too.
              listCandidates: async () => [
                ...(extra.candidates ?? []),
                ...extraApplications.map((a) => ({
                  id: a.candidate_id, name: a.candidate_name, email: null, phone: null, headline: null, location: null,
                  skills: [], source: a.source, pool_status: 'none' as const, created_at: a.created_at,
                })),
                ...(await realHire.listCandidates()),
              ],
            }
          : realHire,
        files: extraCv
          ? {
              readCv: async (id) => {
                const found = extraApplications.find((a) => a.id === id);
                return found
                  ? { state: 'ok', bytes: extraCv, candidate: found.candidate_name, job: found.job_title }
                  : { state: 'missing' };
              },
            }
          : undefined,
        origin: 'https://example.test',
        write: canWrite ? { ctx: { client, orgId }, canWrite: true } : undefined,
      },
    );
    // A model call that breaks partway leaves a half answer; that is not Tuah's answer.
    let broke: unknown;
    await result.consumeStream({ onError: (error) => { broke = error; } });
    if (broke) throw new Error(`A model call could not finish: ${broke instanceof Error ? broke.message : String(broke)}`);
    const steps = await result.steps;
    // Each step reports only its own messages; the conversation needs them all.
    for (const step of steps) this.messages.push(...step.response.messages);

    const text = steps
      .map((step) => step.text.trim())
      .filter(Boolean)
      .join('\n');
    if (text) this.lines.push(`Tuah: ${text.replace(/\s+/g, ' ')}`);

    const turn: Turn = { text, asked: [], steps: [], pending: [], notes: [], applied: [] };
    this.approvals = [];
    for (const step of steps) {
      for (const result of step.toolResults as { toolName: string; input: unknown; output: unknown }[]) {
        if (result.toolName === APPLY_TOOL) {
          const id = (result.input as { proposalId?: string } | null)?.proposalId;
          const proposal = id ? this.proposals.get(id) : undefined;
          if (proposal) {
            turn.applied.push({ proposal, output: result.output });
            collectNames([{ tool: proposal.action, output: result.output }], this.names);
          }
        } else if (result.toolName.startsWith(ASK_PREFIX) && isDelegation(result.output)) {
          // A specialist whose model call broke: Tuah's answer to that is not what is scored.
          if (result.output.status === 'failed') {
            throw new Error(`${result.output.agent} could not finish its model call.`);
          }
          // `EVAL_DEBUG=1` shows what Tuah asked and what came back, to trace a wrong answer.
          if (process.env.EVAL_DEBUG) {
            console.log('task:', JSON.stringify(result.input));
            console.log('report:', result.output.agent, result.output.answer);
          }
          turn.asked.push(result.output.agent);
          turn.steps.push(...result.output.steps.map((s) => s.tool));
          Object.assign(this.names, result.output.names ?? {});
        }
      }
      for (const part of step.content as ContentPart[]) {
        if (part.type !== 'tool-approval-request' || !part.approvalId || part.isAutomatic) continue;
        if (part.reason) turn.notes.push(part.reason);
        const id = (part.toolCall?.input as { proposalId?: string } | null)?.proposalId;
        const proposal = id ? this.proposals.get(id) : undefined;
        this.approvals.push({ approvalId: part.approvalId, proposal });
        if (proposal) turn.pending.push(proposal);
      }
    }
    return turn;
  }
}

/** One thing a case checked, and whether it held. */
export type Check = { what: string; pass: boolean; detail?: string };

export const check = (what: string, pass: boolean, detail?: string): Check => ({
  what,
  pass,
  ...(pass || !detail ? {} : { detail }),
});

/** A short unique word for names, so runs side by side never collide. */
export function tag(): string {
  return Math.random().toString(36).slice(2, 7);
}

/** Removes everything evals created in this workspace. Safe to run at any time. */
export async function cleanUp({ client, orgId }: Workspace): Promise<void> {
  const like = `%${EVAL_TAG}%`;
  // Deals go with their contacts.
  await client.from('crm_contacts').delete().eq('org_id', orgId).ilike('email', like);
  // A contact made by promoting a lead has no email; it is found through its lead.
  const { data: promoted } = await client
    .from('leads')
    .select('promoted_contact_id')
    .eq('org_id', orgId)
    .eq('source', EVAL_TAG)
    .not('promoted_contact_id', 'is', null);
  const ids = (promoted ?? []).map((row) => (row as { promoted_contact_id: string }).promoted_contact_id);
  if (ids.length > 0) await client.from('crm_contacts').delete().eq('org_id', orgId).in('id', ids);
  await client.from('leads').delete().eq('org_id', orgId).ilike('name', like);
  await client.from('leads').delete().eq('org_id', orgId).eq('source', EVAL_TAG);
  await client.from('campaigns').delete().eq('org_id', orgId).ilike('name', like);
  await client.from('hire_jobs').delete().eq('org_id', orgId).ilike('title', like);
  await client.from('hire_settings').update({ careers_enabled: false, require_cv: false, require_cover_letter: false, ask_portfolio: false, ask_expected_salary: false }).eq('org_id', orgId);
  await client.from('forms').delete().eq('org_id', orgId).ilike('name', like);
}
