'use client';

import { useRouter } from 'next/navigation';
import { useId, useRef, useState } from 'react';
import { Dialog } from 'radix-ui';
import { Upload } from 'lucide-react';
import { addMyDocumentAction } from '@/app/(app)/people/document-actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { type CapResult, WRITE_FAILED } from '@/lib/people/capabilities';
import type { EmployeeDocumentRow } from '@/lib/people/documents';
import {
  DOCUMENT_FILE_TYPES,
  UPLOAD_FAILED,
  documentFileFacts,
  documentPath,
  uploadDocumentFile,
} from '@/lib/people/document-files';
import {
  type DocumentFormMode,
  type DocumentFormValues,
  documentFormDefaults,
  documentTypeOptions,
  planDocumentForm,
  saveOutcome,
} from '@/lib/people/documents-screens';
import { createClient } from '@/lib/supabase/client';

const ACCEPT = [
  ...Object.keys(DOCUMENT_FILE_TYPES),
  ...Object.values(DOCUMENT_FILE_TYPES).map((ext) => `.${ext}`),
  '.jpeg',
  '.heif',
  'image/heif',
].join(',');

export type SaveDocument = (input: Record<string, unknown>) => Promise<CapResult<unknown>>;

/**
 * The form for adding a document, editing its details or replacing its file. It knows nothing about who is using it:
 * the screen around it passes `save` (an own-record action for an employee, an owner action on the Employees screen)
 * and this file imports no owner action. A submit checks the details and the file first (nothing is sent on a
 * problem), uploads the file with the person's own session, then calls `save` with the path. The path never reaches
 * the page. A refusal shows beside the buttons; a definite one has already removed the upload, so trying again
 * uploads afresh. When the outcome is unknown the change may have saved: the person is told to reload, not to retry.
 */
export function DocumentForm({
  mode,
  orgId,
  employeeId,
  owner,
  initial,
  save,
  onDone,
  onCancel,
}: {
  mode: DocumentFormMode;
  /** The workspace id, to build the file's path. */
  orgId: string;
  /** The employee the file belongs to: the viewer's own, or the one being managed. */
  employeeId: string;
  /** Owners and admins may pick any of the seven types; an employee the four. */
  owner: boolean;
  initial: Pick<EmployeeDocumentRow, 'title' | 'doc_type' | 'expires_on'> | null;
  save: SaveDocument;
  onDone: () => void;
  onCancel: () => void;
}) {
  const router = useRouter();
  const [values, setValues] = useState<DocumentFormValues>(() => documentFormDefaults(initial, owner));
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const ids = useId();

  const set = <K extends keyof DocumentFormValues>(field: K, value: DocumentFormValues[K]) => {
    setProblem(null);
    setValues((state) => ({ ...state, [field]: value }));
  };

  const submit = async () => {
    const plan = planDocumentForm({ mode, values, file, owner });
    if (!plan.ok) {
      setProblem(plan.error);
      return;
    }
    const { fields, file: chosen } = plan.input;
    setBusy(true);
    setProblem(null);
    try {
      let attached: Record<string, unknown> = {};
      if (chosen) {
        const path = documentPath(orgId, employeeId, chosen);
        const up = await uploadDocumentFile(createClient(), path, chosen);
        if (!up.ok) {
          setProblem(up.error);
          return;
        }
        attached = { file_path: path, ...documentFileFacts(chosen) };
      }
      let result: CapResult<unknown>;
      try {
        result = await save({ ...(fields ?? {}), ...attached });
      } catch {
        // The call was lost: it may have been saved.
        result = { ok: false, error: WRITE_FAILED };
      }
      const outcome = saveOutcome(result);
      if (outcome.done) {
        router.refresh();
        onDone();
        return;
      }
      setProblem(outcome.message);
      if (outcome.reload) router.refresh();
    } catch {
      setProblem(UPLOAD_FAILED);
    } finally {
      setBusy(false);
    }
  };

  const withFields = mode !== 'replace';
  const withFile = mode !== 'edit';
  const label = mode === 'add' ? 'Add document' : mode === 'edit' ? 'Save changes' : 'Replace file';

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {withFields ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="space-y-1.5 sm:col-span-3" htmlFor={`${ids}-title`}>
            <span className="text-xs font-medium text-muted-foreground">Title</span>
            <Input
              id={`${ids}-title`}
              type="text"
              maxLength={200}
              required
              disabled={busy}
              value={values.title}
              onChange={(event) => set('title', event.target.value)}
            />
          </label>
          <div className="space-y-1.5 sm:col-span-2">
            <span className="text-xs font-medium text-muted-foreground">Type</span>
            <Select value={values.doc_type} disabled={busy} onValueChange={(value) => set('doc_type', value)}>
              <SelectTrigger aria-label="Type" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {documentTypeOptions(owner).map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <label className="space-y-1.5" htmlFor={`${ids}-expires`}>
            <span className="text-xs font-medium text-muted-foreground">Expires (optional)</span>
            <Input
              id={`${ids}-expires`}
              type="date"
              disabled={busy}
              value={values.expires_on}
              onChange={(event) => set('expires_on', event.target.value)}
            />
          </label>
        </div>
      ) : null}

      {withFile ? (
        <div className="space-y-1.5">
          <span className="text-xs font-medium text-muted-foreground">File (PDF or image, up to 10 MB)</span>
          <div className="flex flex-wrap items-center gap-2">
            {/* The native input stays for the file dialog; the Button is what a person sees, tabs to and hears. */}
            <input
              ref={fileInput}
              type="file"
              className="sr-only"
              tabIndex={-1}
              aria-hidden="true"
              accept={ACCEPT}
              disabled={busy}
              onChange={(event) => {
                setProblem(null);
                setFile(event.target.files?.[0] ?? null);
                // Choosing the same file again should run again.
                event.target.value = '';
              }}
            />
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => fileInput.current?.click()}>
              {file ? 'Choose another file' : 'Choose file'}
            </Button>
            <span role="status" aria-live="polite" className="min-w-0 truncate text-sm text-muted-foreground">
              {file ? `Chosen: ${file.name}` : 'No file chosen.'}
            </span>
          </div>
        </div>
      ) : null}

      {problem ? (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? 'Working…' : label}
        </Button>
      </div>
    </form>
  );
}

/**
 * My Documents' Upload: a button that opens the form in a dialog. For an employee's own record only: the save is
 * `addMyDocumentAction`, which takes the employee from the session and never from the page. The screen draws this
 * only when `myDocumentsControls` says so (never in the sample company).
 */
export function UploadDocumentButton({ orgId, employeeId }: { orgId: string; employeeId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Upload aria-hidden />
        Upload
      </Button>
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
          <Dialog.Content className="fixed top-1/2 left-1/2 z-50 max-h-[90vh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border bg-background p-5 shadow-lg outline-none">
            <Dialog.Title className="text-base font-semibold">Upload a document</Dialog.Title>
            <Dialog.Description className="mb-4 text-sm text-muted-foreground">
              Add an identity, medical, certificate or other document to your record.
            </Dialog.Description>
            {open ? (
              <DocumentForm
                mode="add"
                orgId={orgId}
                employeeId={employeeId}
                owner={false}
                initial={null}
                save={(input) => addMyDocumentAction(input)}
                onDone={() => setOpen(false)}
                onCancel={() => setOpen(false)}
              />
            ) : null}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
