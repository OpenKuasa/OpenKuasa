import { CRM_FOCUS } from '@/lib/agents/types';
import { entry, type AgentDefinition } from '@/lib/agents/definition';
import {
  crmAgentNoteInput,
  crmCreateAgentNote,
  crmCreateFollowUp,
  crmFollowUpInput,
} from '@/lib/crm/agent/actions';
import { buildCrmAgentContext, type CrmAgentRaw } from '@/lib/crm/agent/context';
import { scanCrm } from '@/lib/crm/agent/scan';

/**
 * Kasturi's agent: watches the pipeline for what the workspace asked for (the confirmed
 * focus checks) and proposes follow-ups and notes for the owner to approve. No digest, no
 * research, no media: the model only selects from the scan's numbered candidates.
 */
export const crmAgent: AgentDefinition = {
  agentKey: CRM_FOCUS,
  product: 'crm',
  buildContext: (service, orgId) => buildCrmAgentContext(service, orgId),
  scan: (raw, now) => scanCrm(raw as CrmAgentRaw, now),
  // The monitor-skip has nothing cheap to compare against: always run.
  hasNewData: async () => true,
  actions: {
    createFollowUp: entry(crmFollowUpInput, crmCreateFollowUp),
    createAgentNote: entry(crmAgentNoteInput, crmCreateAgentNote),
  },
  buildWriteContext: (client, orgId, userId) => ({ client, orgId, userId }),
  proposals: {
    // `context` already carries the read-back of the confirmed checks, never the raw focus text.
    pickPrompt: (context, list) =>
      [
        'You help a small business owner decide which suggested CRM changes are worth queueing for their approval.',
        'Choose ONLY from the numbered candidates below. Do not invent new items or change them.',
        'Reply with JSON only: an array of {"index": number, "rationale": string} objects, where rationale is one short sentence.',
        'Choose at most 5. Reply [] if none are worthwhile.',
        '',
        `Pipeline snapshot:\n${context}`,
        '',
        `Candidates:\n${list}`,
      ].join('\n'),
    cooldownDays: 14,
    expiresInDays: 7,
    dedupeKey: (action, input, checkKey) => {
      const rec = (input ?? {}) as { dealId?: string; contactId?: string };
      return `${action}:${checkKey}:${rec.dealId ?? rec.contactId}`;
    },
  },
  ui: {
    title: 'AI Agents',
    subtitle: 'Watches your pipeline for what you asked',
    screenPath: '/crm/agents',
    assetKinds: [],
  },
};
