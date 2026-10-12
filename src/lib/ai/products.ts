/**
 * The products Tuah works across, each as one toolkit: what it can look up,
 * and what it can change. An agent is put together from these, so adding a
 * product means adding one entry here rather than touching every agent.
 *
 * `read` tools run on their own. `write` tools change data, and every agent
 * built from a toolkit asks for the user's approval before running one; that
 * rule is taken from which side a tool is on, never from a list kept elsewhere.
 */

import { deletionCheckFor, type DeletionCheck, type DeletionGate } from '@/lib/ai/hire-deletions';
import { poolCheckFor, type PoolCheck } from '@/lib/ai/hire-pool-gate';
import type { ModelMessage, Tool, ToolSet } from 'ai';
import { CRM_WRITE_TOOL_NAMES, createCrmTools, type CrmAccess } from '@/lib/ai/crm-tools';
import { createHireTools, type HeldCv } from '@/lib/ai/hire-tools';
import {
  createPeopleTools,
  PEOPLE_TOOL_NAMES as PEOPLE_READ_TOOL_NAMES,
  type PeopleWrite,
} from '@/lib/ai/people-tools';
import { createReachTools, type ReachWrite } from '@/lib/ai/tools';
import { NOT_PREPARED, NOT_WAITING, memoryProposalStore, type ProposalStore } from '@/lib/chat/proposal-store';
import type { HireWriteContext } from '@/lib/hire/capabilities';
import type { CvReader } from '@/lib/hire/cv-read';
import type { HireData } from '@/lib/hire/types';
import type { PeopleData, PeopleViewer } from '@/lib/people/types';
import type { ReachData } from '@/lib/reach/types';

/** The marketing data an agent works on, and whether this caller may change it. */
export type ReachAccess = {
  data: ReachData;
  write?: ReachWrite;
};

/** Marketing tools that change data. */
export const REACH_WRITE_TOOL_NAMES = [
  'createCampaign',
  'updateCampaign',
  'setCampaignStatus',
  'deleteCampaign',
  'createCreative',
  'updateCreative',
  'deleteCreative',
  'updateAdSettings',
  'createForm',
  'updateForm',
  'setFormStatus',
  'deleteForm',
  'createLead',
  'updateLead',
  'setLeadStage',
  'deleteLead',
  'promoteLeadToContact',
  'createAppointment',
  'updateAppointment',
  'setAppointmentStatus',
  'deleteAppointment',
  'scheduleWeeklyStudio',
] as const;

/** The hiring data an agent reads, and whether this caller may change it. */
export type HireAccess = {
  data: HireData;
  write?: { ctx: HireWriteContext; canWrite: boolean };
  /** The site's own address, for the careers page link. */
  origin?: string | null;
  /** Reads one application's CV as the signed-in member. Lekir can read a CV only when this is given. */
  files?: CvReader;
  /**
   * Where this request's read CVs wait to be shown to the model that asked: a new, empty array
   * per request, given with `files`. A caller that gives `files` alone is made one by
   * `hireProduct`, so a read CV always has a way to its model.
   */
  cvShelf?: HeldCv[];
};

/** Hiring tools that change data. */
export const HIRE_WRITE_TOOL_NAMES = ['createJob', 'updateJob', 'setJobStatus', 'deleteJob', 'updateCareersPage', 'updateApplicationForm', 'moveApplication', 'rejectApplication', 'reopenApplication', 'rateApplication', 'addCandidate', 'updateCandidate', 'deleteApplication', 'deleteCandidate', 'setPoolStatus', 'moveToPipeline'] as const;

/** The HR data an agent reads, who is asking, and whether they may change it. */
export type PeopleAccess = { data: PeopleData; viewer: PeopleViewer; write?: PeopleWrite };

/** HR tools that change data: employees, departments, leave, time-off, claims, overtime, attendance, public holidays, attendance settings, payroll drafts, goals, reviews, training, announcements, and letters and acknowledgement requests. */
export const PEOPLE_WRITE_TOOL_NAMES = [
  'createEmployee',
  'updateEmployee',
  'setEmployeeStatus',
  'deleteEmployee',
  'linkEmployeeToMember',
  'createDepartment',
  'updateDepartment',
  'deleteDepartment',
  'applyLeave',
  'applyTimeOff',
  'cancelLeaveRequest',
  'cancelTimeOffRequest',
  'decideLeave',
  'decideTimeOff',
  'setLeaveEntitlement',
  'submitClaim',
  'cancelClaim',
  'submitOvertime',
  'cancelOvertime',
  'decideClaim',
  'markClaimPaid',
  'unmarkClaimPaid',
  'decideOvertime',
  'clockIn',
  'clockOut',
  'correctAttendance',
  'saveHoliday',
  'removeHoliday',
  'saveAttendanceSettings',
  'runPayroll',
  'recalculatePayroll',
  'savePayslipLine',
  'removePayslipLine',
  'setPayslipStatutory',
  'removePayslip',
  'saveGoal',
  'removeGoal',
  'enrolInTraining',
  'withdrawFromTraining',
  'saveReview',
  'deleteReview',
  'releaseReview',
  'saveTraining',
  'removeTraining',
  'setTrainingCompleted',
  'saveAnnouncement',
  'removeAnnouncement',
  'publishAnnouncement',
  'unpublishAnnouncement',
  'saveLetter',
  'startLetterFromTemplate',
  'issueLetter',
  'requestAcknowledgement',
] as const;

/**
 * HR lookups that `createPeopleTools` adds only for some viewers (a linked
 * member, or anyone who may preview a request): not in the always-present read
 * list, but still HR tools for the privacy check below.
 */
const CONDITIONAL_PEOPLE_READ_TOOL_NAMES = [
  'previewLeave',
  'previewOvertime',
  'getMyAttendanceToday',
  'getAttendanceSettings',
  'listLetterTemplates',
] as const;

/**
 * Every HR tool name, read or write. Used to tell when a chat turn touched HR
 * data, so it can be kept out of history and out of the other specialists'
 * context. A test asserts this covers every tool `createPeopleTools` can return.
 */
export const ALL_PEOPLE_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
  ...PEOPLE_READ_TOOL_NAMES,
  ...CONDITIONAL_PEOPLE_READ_TOOL_NAMES,
  ...PEOPLE_WRITE_TOOL_NAMES,
]);

export type ProductKey = 'reach' | 'crm' | 'hire' | 'people';

export type ProductToolkit = {
  /** The product's route segment, as in the navigation. */
  key: ProductKey;
  /** The name its assistant goes by. */
  name: string;
  /** Lookups: run without asking. */
  read: ToolSet;
  /** Changes: each waits for the user's approval. Empty for someone who may not change anything. */
  write: ToolSet;
  /** Hiring only: the CVs this request has read, for whichever agent runs these tools to hand to its model. */
  cvShelf?: HeldCv[];
  /** Hiring only: the server read asked before a deletion is put to the user (see hire-deletions.ts). */
  checkDeletion?: DeletionCheck;
  /** Hiring only: the server read asked before a talent pool change is put to the user (see hire-pool-gate.ts). */
  checkPoolChange?: PoolCheck;
};

function split(all: ToolSet, writeNames: readonly string[]): Pick<ProductToolkit, 'read' | 'write'> {
  const read: ToolSet = {};
  const write: ToolSet = {};
  for (const [name, tool] of Object.entries(all)) {
    (writeNames.includes(name) ? write : read)[name] = tool;
  }
  return { read, write };
}

/** Jebat: ads, leads, lead forms, creatives and ad settings. */
export function reachProduct(reach: ReachAccess): ProductToolkit {
  const all = createReachTools(reach.data, () => new Date(), reach.write);
  return { key: 'reach', name: 'Jebat', ...split(all, REACH_WRITE_TOOL_NAMES) };
}

/** Kasturi: CRM contacts, deals, pipelines, follow-ups and the calendar. */
export function crmProduct(crm: CrmAccess): ProductToolkit {
  return { key: 'crm', name: 'Kasturi', ...split(createCrmTools(crm), CRM_WRITE_TOOL_NAMES) };
}

/** Lekir: jobs, candidates, applications and interviews. */
export function hireProduct(hire: HireAccess): ProductToolkit {
  // One shelf per call of this function, which is once per request: the caller's, or one made here.
  // Either way it is the one the tools fill and the one the agent reads from, so a read CV cannot be stranded.
  const cvShelf = hire.files ? (hire.cvShelf ?? []) : undefined;
  const all = createHireTools(
    hire.data, () => new Date(), hire.write, { origin: hire.origin ?? null }, hire.files, cvShelf,
  );
  return { key: 'hire', name: 'Lekir', ...split(all, HIRE_WRITE_TOOL_NAMES), cvShelf, checkDeletion: deletionCheckFor(hire.data), checkPoolChange: poolCheckFor(hire.data) };
}

/** Lekiu: staff, leave, claims, overtime, attendance, payroll and performance. */
export function peopleProduct(people: PeopleAccess): ProductToolkit {
  return {
    key: 'people',
    name: 'Lekiu',
    ...split(createPeopleTools(people.data, people.viewer, () => new Date(), people.write), PEOPLE_WRITE_TOOL_NAMES),
  };
}

/**
 * The marketing tools for the two screens Kasturi shares with Jebat:
 * Appointments and Lead Forms.
 */
export const KASTURI_SHARED_TOOL_NAMES = [
  'getUpcomingAppointments',
  'createAppointment',
  'updateAppointment',
  'setAppointmentStatus',
  'deleteAppointment',
  'listForms',
  'createForm',
  'updateForm',
  'setFormStatus',
  'deleteForm',
] as const;

/**
 * Appointments and lead forms for Ask-Kasturi. Tuah already holds these
 * through Jebat's toolkit, so this one is never combined with `reachProduct`.
 */
export function kasturiSharedProduct(reach: ReachAccess): ProductToolkit {
  const all: ToolSet = createReachTools(reach.data, () => new Date(), reach.write);
  const shared: ToolSet = {};
  for (const [name, tool] of Object.entries(all)) {
    if ((KASTURI_SHARED_TOOL_NAMES as readonly string[]).includes(name)) shared[name] = tool;
  }
  return { key: 'reach', name: 'Kasturi', ...split(shared, REACH_WRITE_TOOL_NAMES) };
}

/**
 * One agent's tools from several products. Two products must not use the same
 * tool name: the second would silently replace the first.
 */
export function combineToolkits(products: ProductToolkit[]): {
  tools: ToolSet;
  toolApproval: Record<string, 'user-approval'> | undefined;
} {
  const tools: ToolSet = {};
  const toolApproval: Record<string, 'user-approval'> = {};
  for (const product of products) {
    for (const [name, tool] of Object.entries({ ...product.read, ...product.write })) {
      if (name in tools) throw new Error(`Two products both have a tool called ${name}.`);
      tools[name] = tool;
    }
    for (const name of Object.keys(product.write)) toolApproval[name] = 'user-approval';
  }
  return {
    tools,
    toolApproval: Object.keys(toolApproval).length > 0 ? toolApproval : undefined,
  };
}

/**
 * What ties an approval to the change the server proposed. `store` is where
 * proposed changes are kept; `incoming` is every model call the conversation
 * already held when this request arrived. A call that is not among them was
 * made by the model in this request, and only such a call is ever recorded as
 * a proposal: the browser cannot make one look new.
 */
export type ApprovalBinding = { store: ProposalStore; incoming: ReadonlySet<string> };

export function approvalBinding(store: ProposalStore, messages: readonly ModelMessage[]): ApprovalBinding {
  const incoming = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const part of message.content as { type?: unknown; toolCallId?: unknown }[]) {
      if (part?.type === 'tool-call' && typeof part.toolCallId === 'string') incoming.add(part.toolCallId);
    }
  }
  return { store, incoming };
}

/**
 * The binding of a run that was given none: a store that lives for this one
 * request. A change proposed in it is recorded, but nothing can be approved in
 * a later request, since that request starts with an empty store. A chat route
 * always passes its own (see `chatApprovals`).
 */
export const requestOnlyBinding = (messages: readonly ModelMessage[]): ApprovalBinding =>
  approvalBinding(memoryProposalStore(), messages);

type Approval = 'user-approval' | DeletionGate;
type Run = (input: unknown, options: unknown) => unknown;

/**
 * Binds an agent's change tools to the store, for an agent that holds them
 * itself. Two things change, and no tool is left out: every change tool of
 * every product is wrapped.
 *
 * Proposing: when the model calls a change tool and nothing else refuses it,
 * the call is recorded (its id, the product, the tool and its arguments) before
 * the card goes out. A change that cannot be recorded is not shown at all.
 *
 * Applying: when the user's yes arrives, the tool does not run on what the
 * request carried. It takes the record for that call and those arguments, once,
 * and runs on the arguments the server kept. No record (never proposed here,
 * already answered, lapsed, another person's) means nothing runs.
 *
 * `toolApproval` is passed in after any other gate has been put on it (the
 * deletion rules), so a call those refuse is never recorded.
 */
export function bindApprovals(
  kit: { tools: ToolSet; toolApproval: Record<string, Approval> | undefined },
  products: ProductToolkit[],
  binding: ApprovalBinding,
): { tools: ToolSet; toolApproval: Record<string, Approval> | undefined } {
  if (!kit.toolApproval) return kit;
  const tools: ToolSet = { ...kit.tools };
  const toolApproval: Record<string, Approval> = { ...kit.toolApproval };
  for (const product of products) {
    for (const name of Object.keys(product.write)) {
      const change = kit.tools[name];
      const run = (change as { execute?: Run }).execute?.bind(change);
      const inner = kit.toolApproval[name] ?? 'user-approval';

      toolApproval[name] = async (input, options) => {
        const decision = typeof inner === 'function' ? await inner(input, options) : inner;
        if (typeof decision === 'object' && decision.type === 'denied') return decision;
        // The user's answer to a call the conversation already held: nothing new is proposed here.
        // Whether that call was ever recorded is settled when the change runs.
        if (binding.incoming.has(options.toolCallId)) return decision;
        const kept = await binding.store.record({ toolCallId: options.toolCallId, product: product.key, action: name, input });
        return kept ? decision : { type: 'denied', reason: NOT_PREPARED };
      };

      tools[name] = {
        ...change,
        execute: async (input: unknown, options: unknown) => {
          const toolCallId = (options as { toolCallId?: unknown } | null)?.toolCallId;
          const stored = typeof toolCallId === 'string' ? await binding.store.claim({ toolCallId, input }) : null;
          if (!stored || !run || stored.product !== product.key || stored.action !== name) {
            return { ok: false, error: NOT_WAITING };
          }
          // The arguments the server kept when it proposed the change, not the ones this request carried.
          return run(stored.input, options);
        },
      } as Tool;
    }
  }
  return { tools, toolApproval };
}
