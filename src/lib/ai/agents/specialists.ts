/**
 * Tuah's team. Tuah itself holds almost no tools: it asks a specialist per
 * product (`askJebat`, `askKasturi`) and carries out what they prepare
 * (`applyChange`). A specialist runs on the cheaper model with its product's
 * lookups, and with "prepare" versions of its change tools: same inputs, but
 * they save nothing and hand back a proposal.
 *
 * The AI SDK does not allow an approval inside a sub-agent, so the approval
 * lives on Tuah: `applyChange` is the only tool that asks for one, and it is
 * the only place a real change tool is ever run.
 */

import {
  stepCountIs,
  streamText,
  tool,
  type LanguageModel,
  type Tool,
  type ToolSet,
} from 'ai';
import { z } from 'zod';
import { subAgentSystem } from '@/lib/ai/agents/prompts';
import { prepareCvStep } from '@/lib/ai/hire-tools';
import type { ProductToolkit } from '@/lib/ai/products';
import { logModelCall, logModelError, modelErrorCode } from '@/lib/ai/call-log';
import { getModel, pickModelId } from '@/lib/ai/provider';
import {
  approvalDetail,
  approvalTitle,
  collectNames,
  nameIn,
  type ItemKind,
  type KnownNames,
  type ToolResult,
} from '@/lib/chat/change-titles';
import {
  APPLY_TOOL,
  ASK_PREFIX,
  isDelegation,
  type AgentStep,
  type Delegation,
  type Proposal,
} from '@/lib/chat/delegation';

export type TeamContext = {
  /** A workspace's own OpenRouter key; omitted for platform-paid turns. */
  apiKey?: string;
  /** The conversation so far, in words, for specialists that only see their task. */
  transcript: string;
  /** Changes prepared earlier in the conversation, by id. New ones are added here. */
  proposals: Map<string, Proposal>;
  /** Names of rows the conversation has come across, by `kind:id`. Added to as it goes. */
  names?: KnownNames;
};

type Execute = (input: unknown, options: unknown) => unknown;
const executeOf = (t: Tool): Execute | undefined =>
  (t as { execute?: Execute }).execute?.bind(t);

/** What a specialist reports back, as Tuah's model reads it. */
export function delegationForModel(output: Delegation): string {
  if (output.status === 'failed') {
    return `${output.agent} could not finish. ${output.answer}`.trim();
  }
  const lines = [output.answer.trim() || `${output.agent} finished without a report.`];
  if (output.proposals.length > 0) {
    lines.push(
      '',
      'Prepared changes, not saved yet. Call applyChange with the id to put each in front of the user:',
      ...output.proposals.map((p) => `- proposalId ${p.id}: ${p.title}`),
    );
  }
  return lines.join('\n');
}

/** The four application changes: the id must have been seen as an application, not just anywhere. */
const APPLICATION_CHANGES = new Set(['moveApplication', 'rejectApplication', 'reopenApplication', 'rateApplication']);
const ONE_APPLICATION_CHANGE = 'One application change at a time. One is already prepared for approval.';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every id a change refers to, wherever it sits in the input. */
export function idsIn(value: unknown, depth = 0): string[] {
  if (typeof value === 'string') return UUID.test(value) ? [value] : [];
  if (!value || typeof value !== 'object' || depth > 4) return [];
  return Object.values(value).flatMap((inner) => idsIn(inner, depth + 1));
}

/**
 * A specialist's tools: its lookups as they are, and its changes as proposals.
 * `given` is everything the specialist was told (its task and the
 * conversation), which is the other place an id may rightly come from.
 */
function specialistTools(
  product: ProductToolkit,
  team: TeamContext,
  results: ToolResult[],
  prepared: Proposal[],
  given: string,
): ToolSet {
  const tools: ToolSet = {};

  for (const [name, lookup] of Object.entries(product.read)) {
    const run = executeOf(lookup);
    tools[name] = {
      ...lookup,
      // Remembered so a prepared change can be worded with the item's name.
      execute: async (input: unknown, options: unknown) => {
        const output = await run?.(input, options);
        results.push({ tool: name, output });
        return output;
      },
    } as Tool;
  }

  for (const [name, change] of Object.entries(product.write)) {
    tools[name] = tool({
      description:
        `${change.description ?? name} ` +
        'Calling this only PREPARES the change: the user is shown an Approve card and nothing is saved until they approve.',
      inputSchema: change.inputSchema as z.ZodType,
      execute: async (input: unknown) => {
        // A specialist stops after the step in which it prepared a change, but one step can hold
        // several calls. Each card is a decision about one person: only the first is prepared.
        if (APPLICATION_CHANGES.has(name) && prepared.length > 0) {
          return { prepared: false, error: ONE_APPLICATION_CHANGE };
        }
        // An id must have come from somewhere: a lookup just now, an earlier
        // turn, or the task. One that appears nowhere was made up, and a
        // change prepared with it would fail after the user approved it.
        const seen = JSON.stringify(results);
        const known = Object.keys(team.names ?? {}).join(' ');
        const invented = idsIn(input).filter(
          (id) => !seen.includes(id) && !known.includes(id) && !given.includes(id),
        );
        if (invented.length > 0) {
          return {
            prepared: false,
            error:
              `You have not looked up ${invented.join(', ')}. Never guess an id: use a lookup tool ` +
              'to list the item and get its real id, then prepare the change again.',
          };
        }
        if (APPLICATION_CHANGES.has(name)) {
          const id = (input as { id?: unknown } | null)?.id;
          const asApplication =
            typeof id === 'string' && (team.names?.[`application:${id}`] || nameIn(results)(id, 'application'));
          if (!asApplication) {
            return {
              prepared: false,
              error:
                `You have not looked up ${String(id)} as an application. Never guess an id: use listApplications ` +
                'to find the application and get its real id, then prepare the change again.',
            };
          }
        }
        const proposal: Proposal = {
          id: crypto.randomUUID().slice(0, 8),
          product: product.key,
          action: name,
          input,
          // Named from what this specialist just looked up, else from earlier turns.
          title: approvalTitle(
            name,
            input,
            (id: unknown, kind?: ItemKind) =>
              nameIn(results)(id, kind) ??
              (kind && typeof id === 'string' ? (team.names?.[`${kind}:${id}`] ?? null) : null),
          ),
          detail: approvalDetail(name, input),
        };
        team.proposals.set(proposal.id, proposal);
        prepared.push(proposal);
        return { prepared: true, proposalId: proposal.id, card: proposal.title };
      },
    });
  }
  return tools;
}

/** The tool Tuah uses to hand a task to one specialist. */
function askTool(product: ProductToolkit, team: TeamContext): Tool {
  const canChange = Object.keys(product.write).length > 0;
  return tool({
    description:
      `Ask ${product.name}, the specialist for ${AREA[product.key]}, to look things up` +
      (canChange ? ' or to prepare a change' : '') +
      `. Give ${product.name} a complete task, with the names, amounts and details the user gave.`,
    inputSchema: z.object({
      task: z.string().min(1).describe('What to find out or prepare, in full.'),
    }),
    execute: async function* ({ task }, { abortSignal }) {
      const steps: AgentStep[] = [];
      const prepared: Proposal[] = [];
      const results: ToolResult[] = [];
      let answer = '';
      const snapshot = (status: Delegation['status']): Delegation => ({
        agent: product.name,
        product: product.key,
        status,
        steps: steps.map((step) => ({ ...step })),
        answer:
          answer.trim() || status === 'working' || prepared.length === 0
            ? answer
            : `Prepared: ${prepared.map((p) => p.title).join(' ')}`,
        proposals: [...prepared],
        ...(status === 'working' ? {} : { names: collectNames(results) }),
      });

      const given =
        (team.transcript ? `The conversation so far:\n${team.transcript}\n\n` : '') +
        `Task from Tuah: ${task}`;

      yield snapshot('working');
      try {
        const result = streamText({
          model: getModel('worker', team.apiKey),
          system: subAgentSystem(product.key, canChange),
          prompt: given,
          tools: specialistTools(product, team, results, prepared, given),
          // A CV this specialist reads reaches its own model as a user file in the next step:
          // only a run whose messages hold the read is given the file, so never Tuah, never another delegation.
          prepareStep: prepareCvStep(product.cvShelf),
          // A prepared change is the whole report: stop there rather than
          // spend another call having the specialist describe it.
          stopWhen: [stepCountIs(8), () => prepared.length > 0],
          maxOutputTokens: 900,
          abortSignal,
          onLanguageModelCallEnd: logModelCall(product.name.toLowerCase(), pickModelId('worker')),
          // After a CV read the request holds the file: a failure is logged by its code, never whole.
          onError: logModelError(product.name.toLowerCase()),
        });
        for await (const part of result.fullStream) {
          if (part.type === 'tool-call') {
            steps.push({ tool: part.toolName, done: false });
            // Words said before a lookup are not the report.
            answer = '';
            yield snapshot('working');
          } else if (part.type === 'tool-result' || part.type === 'tool-error') {
            const open = steps.find((step) => step.tool === part.toolName && !step.done);
            if (open) open.done = true;
            yield snapshot('working');
          } else if (part.type === 'text-delta') {
            answer += part.text;
          } else if (part.type === 'error') {
            throw part.error;
          }
        }
        yield snapshot('done');
      } catch (error) {
        // The code only: a provider's message can quote the request, and a non-Error can be anything.
        console.error(`[tuah] ${product.name} could not finish:`, modelErrorCode(error));
        answer = 'Something went wrong while working on this. Try again in a moment.';
        yield snapshot('failed');
      }
    },
    toModelOutput: ({ output }) => ({
      type: 'text',
      value: delegationForModel(output as Delegation),
    }),
  }) as Tool;
}

const AREA: Record<ProductToolkit['key'], string> = {
  reach: 'marketing (ads, campaigns, creatives, leads, lead forms, appointments, ad settings)',
  crm: 'the CRM (contacts, deals, pipelines and their stages)',
  hire: 'hiring (jobs, candidates, applications, the hiring funnel, interviews, the talent pool; it can read one candidate\'s uploaded CV and give a verdict on it; it can prepare moving, rejecting, reopening or rating one application at a time)',
  people: 'HR (existing staff, leave, claims, overtime, attendance, payroll, performance)',
};

/** Runs a prepared change through the product's own change tool, after checking its input again. */
async function apply(
  products: ProductToolkit[],
  team: TeamContext,
  proposal: Proposal | undefined,
  options: unknown,
): Promise<unknown> {
  if (!proposal) {
    return {
      ok: false,
      error: 'That prepared change was not found. Ask the specialist to prepare it again.',
    };
  }
  const product = products.find((p) => p.key === proposal.product);
  const change =
    product && Object.hasOwn(product.write, proposal.action)
      ? product.write[proposal.action]
      : undefined;
  const run = change ? executeOf(change) : undefined;
  if (!change || !run) {
    return { ok: false, error: 'You are not able to make that change in this workspace.' };
  }
  // A proposal read back from the conversation is checked like any other input.
  const parsed = (change.inputSchema as z.ZodType).safeParse(proposal.input);
  if (!parsed.success) {
    return { ok: false, error: 'That prepared change is no longer valid. Ask for it again.' };
  }
  const output = await run(parsed.data, options);
  if (team.names) collectNames([{ tool: proposal.action, output }], team.names);
  return output;
}

/**
 * Stands in for Tuah's model on the one step whose outcome is already
 * decided: a specialist has just prepared a single change, and the rule is to
 * put it in front of the user at once. It makes that `applyChange` call
 * without a round trip to a model, which is about two seconds the user would
 * otherwise wait for the Approve card.
 */
function applyStep(proposalId: string): LanguageModel {
  const usage = {
    inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 0, text: 0, reasoning: 0 },
  };
  const chunks = [
    {
      type: 'tool-call',
      toolCallId: `apply-${proposalId}`,
      toolName: APPLY_TOOL,
      input: JSON.stringify({ proposalId }),
    },
    { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage },
  ];
  return {
    specificationVersion: 'v4',
    provider: 'openkuasa',
    modelId: 'apply-prepared-change',
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error('apply-prepared-change only streams.');
    },
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      }),
    }),
  } as unknown as LanguageModel;
}

type StepLike = { toolResults: { toolName: string; output: unknown; preliminary?: boolean }[] };

/**
 * The single change to apply straight away after a step, if that is what the
 * step produced: every specialist asked has finished, and between them they
 * prepared exactly one change. Anything else is left to Tuah to think about.
 */
export function changeToApply(step: StepLike | undefined): Proposal | null {
  if (!step) return null;
  const reports = step.toolResults
    .filter((r) => r.toolName.startsWith(ASK_PREFIX) && r.toolName !== APPLY_TOOL && !r.preliminary)
    .map((r) => r.output);
  if (reports.length === 0 || !reports.every((r) => isDelegation(r) && r.status === 'done')) {
    return null;
  }
  const proposals = reports.flatMap((r) => (isDelegation(r) ? r.proposals : []));
  return proposals.length === 1 ? proposals[0] : null;
}

/** Tuah's tools when it works through its team, and which of them need approval. */
export function createTeamTools(
  products: ProductToolkit[],
  team: TeamContext,
): {
  tools: ToolSet;
  toolApproval: Record<string, 'user-approval'> | undefined;
  /** Chooses the model for a step: the scripted one when a single change is ready to apply. */
  prepareStep?: (options: { steps: StepLike[] }) => { model: LanguageModel } | undefined;
} {
  const tools: ToolSet = {};
  for (const product of products) {
    tools[`${ASK_PREFIX}${product.name}`] = askTool(product, team);
  }

  const anyChanges = products.some((p) => Object.keys(p.write).length > 0);
  if (!anyChanges) return { tools, toolApproval: undefined };

  tools[APPLY_TOOL] = tool({
    description:
      'Carry out a change a specialist prepared, by its proposalId. This shows the user an ' +
      'Approve / Reject card; nothing is saved until they approve. Needs approval.',
    inputSchema: z.object({
      proposalId: z.string().min(1).describe('The id the specialist reported.'),
    }),
    execute: async ({ proposalId }, options) =>
      apply(products, team, team.proposals.get(proposalId), options),
  });
  return {
    tools,
    toolApproval: { [APPLY_TOOL]: 'user-approval' },
    prepareStep: ({ steps }) => {
      const proposal = changeToApply(steps[steps.length - 1]);
      return proposal ? { model: applyStep(proposal.id) } : undefined;
    },
  };
}
