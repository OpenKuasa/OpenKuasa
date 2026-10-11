/**
 * The products Tuah works across, each as one toolkit: what it can look up,
 * and what it can change. An agent is put together from these, so adding a
 * product means adding one entry here rather than touching every agent.
 *
 * `read` tools run on their own. `write` tools change data, and every agent
 * built from a toolkit asks for the user's approval before running one; that
 * rule is taken from which side a tool is on, never from a list kept elsewhere.
 */

import type { ToolSet } from 'ai';
import { CRM_WRITE_TOOL_NAMES, createCrmTools, type CrmAccess } from '@/lib/ai/crm-tools';
import { createHireTools } from '@/lib/ai/hire-tools';
import { createPeopleTools, type PeopleWrite } from '@/lib/ai/people-tools';
import { createReachTools } from '@/lib/ai/tools';
import type { HireWriteContext } from '@/lib/hire/capabilities';
import type { ReachWriteContext } from '@/lib/reach/capabilities';
import type { HireData } from '@/lib/hire/types';
import type { PeopleData, PeopleViewer } from '@/lib/people/types';
import type { ReachData } from '@/lib/reach/types';

/** The marketing data an agent works on, and whether this caller may change it. */
export type ReachAccess = {
  data: ReachData;
  write?: { ctx: ReachWriteContext; canWrite: boolean };
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
};

/** Hiring tools that change data. */
export const HIRE_WRITE_TOOL_NAMES = ['createJob', 'updateJob', 'setJobStatus', 'deleteJob', 'updateCareersPage', 'updateApplicationForm'] as const;

/** The HR data an agent reads, who is asking, and whether they may change it. */
export type PeopleAccess = { data: PeopleData; viewer: PeopleViewer; write?: PeopleWrite };

/** HR tools that change data: employees, departments, leave and time-off. */
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
] as const;

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
  const all = createHireTools(hire.data, () => new Date(), hire.write, { origin: hire.origin ?? null });
  return { key: 'hire', name: 'Lekir', ...split(all, HIRE_WRITE_TOOL_NAMES) };
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
