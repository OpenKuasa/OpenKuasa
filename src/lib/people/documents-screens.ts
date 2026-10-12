/**
 * The rules behind My Documents and the Employees screen's Documents action that can be said without a browser:
 * which controls a viewer is shown, what the forms offer and check, what each outcome of a save or a download
 * means for the screen, the sentences of the second steps, and the figure on the navigation badge. Pure: no clock,
 * no network, no import of a write path or an action, so a member's page can import it.
 *
 * The rule for owner controls (settled in the previous slice): a component written for members names no
 * owner-only action; a screen renders an owner component only for an owner or admin outside the demo, and that
 * decision is {@link showsOwnerDocumentControls}.
 */
import { type CapResult, WRITE_FAILED, writeOutcome } from './capabilities';
import { pickDocumentFile } from './document-files';
import { type Converted, toDocumentInput } from './document-forms';
import { DOCUMENT_TYPE_LABEL } from './own';
import { type EmployeeDocumentRow, type MyDocumentRow, type MyDocumentsModel, buildEmployeeDocumentsModel, canManageDocuments } from './documents';
import { FILE_UNAVAILABLE } from './documents-refusals';
import { DOCUMENT_TYPES, type DocumentType, EMPLOYEE_DOCUMENT_TYPES, type HrDocument, type PeopleViewer } from './types';

type Who = { isHr: boolean; isDemo: boolean };

// ---- Who sees what ----------------------------------------------------------------

/**
 * Owner components (Add document, Edit, Replace file, Remove, Request / Withdraw) are drawn only for an owner or
 * admin outside the demo. Anything else, including a signed-out or unknown viewer, gets none.
 */
export const showsOwnerDocumentControls = (viewer: Who | null | undefined): boolean =>
  viewer != null && typeof viewer.isHr === 'boolean' && typeof viewer.isDemo === 'boolean' && canManageDocuments(viewer);

/** The Employees screen's "Documents" action: owner controls, the documents loaded, and a workspace to build paths in. */
export const showsEmployeeDocumentsAction = (
  canEdit: boolean,
  documents: unknown | null,
  orgId: string | null,
): boolean => canEdit && documents !== null && orgId !== null && orgId !== '';

/**
 * My Documents: whether the Upload control exists. It is not drawn in the demo at all (not even as a disabled
 * sample), nor without an employee record, nor without a workspace id to build the path in.
 */
export const myDocumentsControls = (
  viewer: Who | null | undefined,
  model: MyDocumentsModel | null,
  orgId: string | null,
): { upload: boolean } => ({
  upload:
    viewer != null &&
    !viewer.isDemo &&
    model !== null &&
    model.linked &&
    model.can_upload &&
    orgId !== null &&
    orgId !== '',
});

// ---- Sentences ---------------------------------------------------------------------

export const ACK_NOTE = 'This records that you have read it. It is not a signature.';
export const ACK_BUTTON = 'I have read this';
export const POPUP_BLOCKED = 'Your browser blocked the new tab. Allow pop-ups for this site and try again.';
export const LINK_FAILED = FILE_UNAVAILABLE;
export const CHOOSE_FILE = 'Choose a file to upload.';
export const RELOAD_HINT = 'Reload the page to see whether it was saved before you try again.';

export const removeMineSentence = (title: string): string => `Remove "${title}"? This cannot be undone.`;
export const removeForSentence = (title: string): string =>
  `Remove "${title}" and its file? This cannot be undone.`;
export const requestAckSentence = (name: string): string => `${name} will be asked to confirm they have read this.`;
export const withdrawAckSentence = (): string => 'The employee will no longer be asked to acknowledge this.';

// ---- Row details -------------------------------------------------------------------

/**
 * The acknowledgement state for a row, from the model's label: `Acknowledged on <date>`, `Awaiting
 * acknowledgement`, or nothing (not asked). The model owns the date; this only words it.
 */
export function ackDetail(label: string | null | undefined, awaiting = false): string | null {
  if (awaiting) return 'Awaiting acknowledgement';
  if (!label) return null;
  if (label === 'Not asked') return null;
  if (label === 'Waiting for the employee') return 'Awaiting acknowledgement';
  return label;
}

/** The line under a My Documents row: "Awaiting acknowledgement" only where the viewer can act on it (the pill says the rest). */
export const myRowAckDetail = (
  row: Pick<MyDocumentRow, 'awaiting_acknowledgement' | 'can_acknowledge' | 'acknowledged_label'>,
): string | null => ackDetail(row.acknowledged_label, row.awaiting_acknowledgement && row.can_acknowledge);

/** The pill for a My Documents row: what needs the person first, then the expiry state. */
export function myRowStatus(
  row: Pick<MyDocumentRow, 'awaiting_acknowledgement' | 'can_acknowledge' | 'expiry'>,
): { tone: 'good' | 'pending' | 'bad' | 'neutral'; label: string } {
  if (row.awaiting_acknowledgement) {
    // A row that asks but cannot be acknowledged is a sample (the demo): a neutral fact, not addressed to the visitor.
    return { tone: 'pending', label: row.can_acknowledge ? 'Needs your acknowledgement' : 'Acknowledgement requested' };
  }
  if (row.expiry === 'expired') return { tone: 'bad', label: 'Expired' };
  if (row.expiry === 'expiring') return { tone: 'bad', label: 'Expiring soon' };
  return { tone: 'neutral', label: 'Available' };
}

/** What stands where Download would be: the button, the sample sentence, or (a letter, a payslip) nothing. */
export function downloadSlot(row: Pick<MyDocumentRow, 'kind' | 'can_download' | 'no_file_label'>): 'download' | 'no-file' | 'none' {
  if (row.kind !== 'document') return 'none';
  if (row.can_download) return 'download';
  return row.no_file_label ? 'no-file' : 'none';
}

// ---- The form -----------------------------------------------------------------------

export type DocumentFormMode = 'add' | 'edit' | 'replace';
export type DocumentFormValues = { title: string; doc_type: string; expires_on: string };

/** The types a form offers: the four an employee may upload, or all seven for an owner or admin. */
export const documentTypeOptions = (owner: boolean): { value: DocumentType; label: string }[] =>
  (owner ? DOCUMENT_TYPES : EMPLOYEE_DOCUMENT_TYPES).map((value) => ({ value, label: DOCUMENT_TYPE_LABEL[value] }));

/** What the form holds when it opens: blank for a new document (the first type offered), the row for an edit. */
export function documentFormDefaults(
  row: Pick<EmployeeDocumentRow, 'title' | 'doc_type' | 'expires_on'> | null,
  owner: boolean,
): DocumentFormValues {
  return {
    title: row?.title ?? '',
    doc_type: row?.doc_type ?? documentTypeOptions(owner)[0].value,
    expires_on: row?.expires_on ?? '',
  };
}

export type DocumentFormPlan = {
  /** The title, type and expiry to save; null when only the file changes. */
  fields: { title: string; doc_type: string; expires_on: string | null } | null;
  /** The file to upload first; null when only the fields change. */
  file: File | null;
};

/**
 * What a submit does, checked before anything is uploaded: the fields (add, edit) first, then the file (add,
 * replace). The first problem is the sentence shown; nothing has been sent when it is one.
 */
export function planDocumentForm(input: {
  mode: DocumentFormMode;
  values: DocumentFormValues;
  file: File | null;
  owner: boolean;
}): Converted<DocumentFormPlan> {
  const { mode, values, file, owner } = input;
  let fields: DocumentFormPlan['fields'] = null;
  if (mode !== 'replace') {
    const converted = toDocumentInput(values, owner ? DOCUMENT_TYPES : EMPLOYEE_DOCUMENT_TYPES);
    if (!converted.ok) return converted;
    fields = converted.input;
  }
  if (mode === 'edit') return { ok: true, input: { fields, file: null } };
  if (file === null) return { ok: false, error: CHOOSE_FILE };
  const picked = pickDocumentFile(file);
  if (!picked.ok) return picked;
  return { ok: true, input: { fields, file: picked.input } };
}

/**
 * What the screen does with the answer to an add or a replace. A definite refusal has already released and removed
 * the uploaded file (the action does it), so the person fixes it and tries again with a new upload. An unknown
 * outcome (the generic failure, or the call was lost) may have saved: the file is kept, so tell the person to
 * reload instead of retrying.
 */
export function saveOutcome(result: CapResult<unknown>): { done: true } | { done: false; message: string; reload: boolean } {
  const outcome = writeOutcome(result);
  if (outcome === 'saved') return { done: true };
  if (outcome === 'refused' && !result.ok) return { done: false, message: result.error, reload: false };
  return { done: false, message: `${WRITE_FAILED} ${RELOAD_HINT}`, reload: true };
}

// ---- Download -----------------------------------------------------------------------

/**
 * What the new tab does with the answer to the link request. The link goes straight to the tab's address; it is not
 * kept, logged or drawn. A failed request closes the tab and shows its sentence (or ours when it has none).
 */
export function downloadStep(
  result: CapResult<{ url: string }> | null,
): { action: 'open'; url: string } | { action: 'fail'; message: string } {
  if (result === null) return { action: 'fail', message: LINK_FAILED };
  if (result.ok) {
    return typeof result.data?.url === 'string' && result.data.url !== ''
      ? { action: 'open', url: result.data.url }
      : { action: 'fail', message: LINK_FAILED };
  }
  return { action: 'fail', message: result.error.trim() === '' ? LINK_FAILED : result.error };
}

// ---- The Employees screen's Documents action -----------------------------------------

/**
 * Each employee's documents as the owner's list shows them, by employee id. Null for anyone but an owner or admin
 * outside the demo, so nothing is read for them and the action is not drawn. Grouped once, then built per employee.
 */
export function employeeDocumentRows(input: {
  documents: HrDocument[];
  employeeIds: string[];
  today: string;
  viewer: PeopleViewer;
}): Record<string, EmployeeDocumentRow[]> | null {
  if (!showsOwnerDocumentControls(input.viewer)) return null;
  const grouped = new Map<string, HrDocument[]>();
  for (const doc of input.documents) grouped.set(doc.employee_id, [...(grouped.get(doc.employee_id) ?? []), doc]);
  const out: Record<string, EmployeeDocumentRow[]> = {};
  for (const id of input.employeeIds) {
    const model = buildEmployeeDocumentsModel({ documents: grouped.get(id) ?? [], employeeId: id, today: input.today, viewer: input.viewer });
    out[id] = model.allowed ? model.rows : [];
  }
  return out;
}

// ---- The navigation badge -----------------------------------------------------------

/** The people layout reads the awaiting count for a signed-in member of a real workspace, and for no one else. */
export const shouldReadAwaiting = (input: { isDemo: boolean; orgId: string | null | undefined }): boolean =>
  !input.isDemo && Boolean(input.orgId);

/** A count from the database: a whole number from 0 up, anything else (null, NaN, negative, text) is 0. */
export const safeCount = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

/** Documents plus letters awaiting the viewer's acknowledgement, each failing to 0 by itself. */
export const awaitingTotal = (documents: unknown, letters: unknown): number => safeCount(documents) + safeCount(letters);
