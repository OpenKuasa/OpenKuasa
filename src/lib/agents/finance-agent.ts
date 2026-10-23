import { FINANCE_FOCUS } from '@/lib/agents/types';
import { entry, type AgentDefinition } from '@/lib/agents/definition';
import { financeAgentNoteInput, financeCreateAgentNote } from '@/lib/finance/agent/actions';
import { buildFinanceAgentContext, type FinanceAgentRaw } from '@/lib/finance/agent/context';
import { scanFinance } from '@/lib/finance/agent/scan';

/** Days a decided suggestion's key stays decided: effectively forever (spec §4.2). */
const FOREVER_DAYS = 36500;

/**
 * Bendahara's agent: watches the books for what the workspace asked for (the confirmed focus
 * checks) and proposes notes for a person to approve. It never posts, pays, voids, sends or
 * changes a document. No digest, no research, no media: the model only selects from the
 * scan's numbered candidates.
 */
export const financeAgent: AgentDefinition = {
  agentKey: FINANCE_FOCUS,
  product: 'finance',
  buildContext: (service, orgId) => buildFinanceAgentContext(service, orgId),
  scan: (raw, now) => scanFinance(raw as FinanceAgentRaw, now),
  // The monitor-skip has nothing cheap to compare against: always run.
  hasNewData: async () => true,
  actions: {
    createAgentNote: entry(financeAgentNoteInput, financeCreateAgentNote),
  },
  buildWriteContext: (client, orgId, userId) => ({ client, orgId, userId }),
  // The note RPC reads the note from the approved proposal, so the action needs its id.
  writeContextTakesProposal: true,
  proposals: {
    // `context` already carries the read-back of the confirmed checks, never the raw focus text.
    pickPrompt: (context, list) =>
      [
        'You help a small business owner decide which notes about their books are worth queueing for their approval.',
        'Each candidate only leaves a note; nothing is paid, posted, voided or sent.',
        'Choose ONLY from the numbered candidates below. Do not invent new items or change them.',
        'Reply with JSON only: an array of {"index": number, "rationale": string} objects, where rationale is one short sentence.',
        'Choose at most 5. Reply [] if none are worthwhile.',
        '',
        `Books snapshot:\n${context}`,
        '',
        `Candidates:\n${list}`,
      ].join('\n'),
    // Decided stages never come back; a later stage (it got worse) has its own key.
    cooldownDays: FOREVER_DAYS,
    expiresInDays: 7,
    dedupeKey: (action, input, checkKey) => {
      const rec = (input ?? {}) as { target?: string; stage?: string };
      return `${action}:${checkKey}:${rec.target}:${rec.stage}`;
    },
  },
  ui: {
    title: 'AI Agents',
    subtitle: 'Watches your books for what you asked',
    screenPath: '/finance/agents',
    assetKinds: [],
  },
};
