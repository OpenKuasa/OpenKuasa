import { PEOPLE_FOCUS } from '@/lib/agents/types';
import { entry, type AgentDefinition } from '@/lib/agents/definition';
import { peopleAgentNoteInput, peopleCreateAgentNote } from '@/lib/people/agent/actions';
import { buildPeopleAgentContext, type PeopleAgentRaw } from '@/lib/people/agent/context';
import { scanPeople } from '@/lib/people/agent/scan';

/** Days a decided suggestion's key stays decided: effectively forever (spec §4.2). */
const FOREVER_DAYS = 36500;

/**
 * Lekiu's agent: watches the team's HR records for what HR asked for (the confirmed focus
 * checks) and proposes private notes for HR to approve. It never approves, rejects, issues, pays
 * or messages anyone. No digest, no research, no media: the model only selects from the scan's
 * numbered candidates, whose titles carry no personal details (spec §5).
 */
export const peopleAgent: AgentDefinition = {
  agentKey: PEOPLE_FOCUS,
  product: 'people',
  buildContext: (service, orgId) => buildPeopleAgentContext(service, orgId),
  scan: (raw, now) => scanPeople(raw as PeopleAgentRaw, now),
  // The monitor-skip has nothing cheap to compare against: always run.
  hasNewData: async () => true,
  actions: {
    createAgentNote: entry(peopleAgentNoteInput, peopleCreateAgentNote),
  },
  buildWriteContext: (client, orgId, userId) => ({ client, orgId, userId }),
  // The note RPC reads the note from the approved proposal, so the action needs its id.
  writeContextTakesProposal: true,
  proposals: {
    // `context` carries counts and the read-back of the confirmed checks, never the raw focus text.
    pickPrompt: (context, list) =>
      [
        'You help a small business HR team decide which follow-ups on their team records are worth queueing for their approval.',
        'Nothing is approved, rejected, issued, paid or sent: each candidate only leaves a private note for HR.',
        'Choose ONLY from the numbered candidates below. Do not invent new items or change them.',
        'Reply with JSON only: an array of {"index": number, "rationale": string} objects, where rationale is one short sentence.',
        'Choose at most 5. Reply [] if none are worthwhile.',
        '',
        `Team snapshot:\n${context}`,
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
    subtitle: 'Watches your team records for what you asked',
    screenPath: '/people/agents',
    assetKinds: [],
  },
};
