import { HIRE_FOCUS } from '@/lib/agents/types';
import { entry, type AgentDefinition } from '@/lib/agents/definition';
import { hireAgentNoteInput, hireCreateAgentNote } from '@/lib/hire/agent/actions';
import { buildHireAgentContext, type HireAgentRaw } from '@/lib/hire/agent/context';
import { scanHire } from '@/lib/hire/agent/scan';

/** Days a decided suggestion's key stays decided: effectively forever (spec §4.2). */
const FOREVER_DAYS = 36500;

/**
 * Lekir's agent: watches the workspace's hiring for what it asked for (the confirmed focus
 * checks) and proposes notes for a person to approve. It never moves a stage, rejects, changes
 * the pool, opens or closes a job, or contacts a candidate. No digest, no research, no media:
 * the model only selects from the scan's numbered candidates.
 */
export const hireAgent: AgentDefinition = {
  agentKey: HIRE_FOCUS,
  product: 'hire',
  buildContext: (service, orgId) => buildHireAgentContext(service, orgId),
  scan: (raw, now) => scanHire(raw as HireAgentRaw, now),
  // The monitor-skip has nothing cheap to compare against: always run.
  hasNewData: async () => true,
  actions: {
    createAgentNote: entry(hireAgentNoteInput, hireCreateAgentNote),
  },
  buildWriteContext: (client, orgId, userId) => ({ client, orgId, userId }),
  // The note RPC reads the note from the approved proposal, so the action needs its id.
  writeContextTakesProposal: true,
  proposals: {
    // `context` already carries the read-back of the confirmed checks, never the raw focus text.
    pickPrompt: (context, list) =>
      [
        'You help a small business owner decide which notes about their hiring are worth queueing for their approval.',
        'Each candidate only leaves a note; nothing is moved, rejected or sent.',
        'Choose ONLY from the numbered candidates below. Do not invent new items or change them.',
        'Reply with JSON only: an array of {"index": number, "rationale": string} objects, where rationale is one short sentence.',
        'Choose at most 5. Reply [] if none are worthwhile.',
        '',
        `Hiring snapshot:\n${context}`,
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
    subtitle: 'Watches your hiring for what you asked',
    screenPath: '/hire/agents',
    assetKinds: [],
  },
};
