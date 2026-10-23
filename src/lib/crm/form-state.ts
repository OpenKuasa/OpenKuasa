import type { RecordNote } from '@/lib/crm/notes';

/** What a Kasturi form action hands back to the form that called it. */
export type CrmFormState =
  | {
      ok: true;
      message?: string;
      /** The id of what was created, when the form needs it. */
      id?: string;
    }
  | { ok: false; error: string; values: Record<string, string> }
  | undefined;

/** Hands back a deal's or contact's notes for its pop-up, or null when they cannot be had. */
export type CrmNotesLoader = (id: string) => Promise<RecordNote[] | null>;

export type CrmFormAction = (
  prev: CrmFormState,
  formData: FormData,
) => Promise<CrmFormState>;

/** The writes the Contacts page offers. Absent for people who can only read. */
export type CrmContactActions = {
  /** Creates a contact, or updates one when the form carries `contactId`. */
  save: CrmFormAction;
  remove: CrmFormAction;
  addFollowUp: CrmFormAction;
  completeFollowUp: CrmFormAction;
  /** Takes `payload`: JSON of `{ table, mapping }` from the import card. */
  importContacts: CrmFormAction;
  /** Takes a contact's id; read-only. */
  notes: CrmNotesLoader;
};

/** The writes the Deals page offers. Absent for people who can only read. */
export type CrmDealActions = {
  /** Takes a deal's id; read-only. */
  notes: CrmNotesLoader;
  /** Creates a deal, or updates one when the form carries `dealId`. */
  save: CrmFormAction;
  /** Takes `dealId` and `stageId`. */
  move: CrmFormAction;
  /** Takes `dealId` and an optional `lostReason`. */
  markLost: CrmFormAction;
  reopen: CrmFormAction;
  remove: CrmFormAction;
  /** Takes `name` and `stages` (comma-separated). Hands back the new pipeline's `id`. */
  createPipeline: CrmFormAction;
  /** Takes `pipelineId` and `name`. */
  renamePipeline: CrmFormAction;
  /** Takes `pipelineId`. */
  makeDefaultPipeline: CrmFormAction;
  /** Takes `pipelineId`. */
  removePipeline: CrmFormAction;
  /** Takes `pipelineId` and `name`. The stage goes before Won, or last. */
  addStage: CrmFormAction;
  /** Takes `pipelineId`, `stageId`, `name` and `probability` (a whole number, 0 to 100). */
  updateStage: CrmFormAction;
  /** Takes `pipelineId`, `stageId` and `direction` ('up' or 'down'). */
  moveStage: CrmFormAction;
  /** Takes `pipelineId` and `stageId`. */
  removeStage: CrmFormAction;
};
