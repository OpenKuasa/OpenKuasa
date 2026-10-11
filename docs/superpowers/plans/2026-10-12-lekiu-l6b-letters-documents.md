# Lekiu L6b: Letters and Documents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan. Tasks 1 and 2 run one after the other. Tasks 3, 4 and 5 run in parallel after Task 2 (superpowers:dispatching-parallel-agents), each on its own files. Task 6 is run by the coordinator and stops for the owner. Steps use checkbox (`- [ ]`) syntax for tracking.

**Start condition:** L6a (`feat-128-lekiu-performance`) is merged into `main`. This plan is executed on a new branch cut from `main` after that merge, because it edits the same files (Lekiu's tools and prompt, the approval cards, the provider, the demo re-seed, the navigation badges).

**Goal:** Each employee's documents are real files they can download; owners and admins write letters in the product, from templates or from scratch, and issue them when ready; an employee can be asked to acknowledge a document or a letter; My Documents lists an employee's documents, issued letters and paid payslips; on the screens and through Ask-Lekiu.

**Architecture:** As L2 to L6a. The rules live in the database: one `security definer` function per action, no write grant on any table. Files live in a private storage bucket whose policies tie every object to a document row, as L3's claim receipts do. `src/lib/people/document-writes.ts` and `letter-writes.ts` wrap each function; `document-files.ts` / `document-files-server.ts` handle upload, signed links and removal. Server actions and Lekiu's tools call those and nothing else. Lekiu never handles a file.

**Tech Stack:** Supabase Postgres and Storage (plpgsql, RLS, storage policies), Next.js 16 App Router, AI SDK v7, Zod v4, Vitest, pnpm.

**Spec:** `docs/superpowers/specs/2026-10-12-lekiu-letters-documents-design.md`. It is the authority: §4 gives every column, table, bucket, read rule, rule, placeholder, function with its refusals, and the codes; §5 gives the sentences, the screens and Lekiu's tools.

**How this plan is written:** like L2 to L6a, it gives interfaces, rules and required tests, not every line of code. Patterns to imitate: for files, L3 (`supabase/migrations/20261020090000_people_claims_overtime_writes.sql` from the bucket onward, `20261020100000_people_receipt_release.sql`, `src/lib/people/receipts.ts`, `receipts-server.ts`, `src/components/people/receipt-link.tsx`, `claim-form.tsx`); for draft-then-released records and their screens, cards and tools, L6a's reviews and announcements; for everything else, L5 payroll.

## Global Constraints

- pnpm only. One test file: `pnpm vitest run --dir tests <exact-file-name>.test`. **Always the exact file name.** Never run a file whose name contains `.rls.` or `.live.`, and never `pnpm test`, except the coordinator in Task 6.
- Before writing a server action, route change or client component, read the matching page under `node_modules/next/dist/docs/`.
- **Nothing in this plan is applied to the live database or its storage** until Task 6, and then only with the owner's explicit go-ahead. Task 1 verifies on a local scratch Postgres only. No subagent uses any Supabase MCP tool.
- No table gets an insert, update or delete grant. Every write is a function call. The bucket has select and insert policies only; no update or delete policy.
- **A file is reachable only through a document the caller may read.** A path is never trusted from a form: the database checks it is inside the caller's workspace and that employee's folder, unattached and unreleased. A path or a signed link is never logged, never returned to Lekiu, and never put in a URL the app builds itself.
- Files are removed only by the app's service client, and only for a path the database has released or returned from a remove or replace. Nothing deletes by a pattern or a folder.
- The acting user always comes from the session; the workspace from the row named. **A member's own `employee_id` comes from the viewer, never from a form field, a URL or the model.**
- Owner and admin actions: `private.is_org_admin` in the database, `can(role, 'approve')` in the app, checked before any read. The demo is read-only and refused before any database call.
- **A draft letter never reaches the person it is addressed to**: not a row, not a count, not a sentence from Lekiu. The database decides; every model a member's screen uses filters again to `issued`.
- An acknowledgement is recorded only by the employee it concerns, through their own action. No owner control, no Lekiu tool and no other function can set it. Nothing in the product calls it a signature.
- Expiry state is worked out by ONE pure helper used everywhere (Malaysia time, `src/lib/people/dates.ts`). Placeholder detection is ONE pure helper mirroring the database's rule.
- Never log a title, a letter's body, a template, or a file's name. Log the database's code and the function's name only.
- Refusal sentences live in one leaf module with no imports (`src/lib/people/documents-refusals.ts`).
- Ids are validated with `z.guid()`. An optional id a model may send is `.nullish()`, and `''` means none. A non-string, non-null id is refused.
- A card states exactly what will be saved, in full, every time (a letter's whole body included); anything the conversation suggests about the row's state is a hedged second sentence. Card facts follow changes made earlier in the same chat. An input that can only fail is refused at the tool's schema, before any card.
- Every new change tool is added to `PEOPLE_WRITE_TOOL_NAMES` in `src/lib/ai/products.ts`. Uploading, replacing or removing a file, deleting a letter, pulling a letter back, acknowledging, and anything on templates are never tools.
- A component written for members names no owner-only action, and a screen renders an owner component only for an owner or admin outside the demo, decided by a pure function tested for every kind of viewer (the rule L6a settled on).
- The language block at the top of `LEKIU_SYSTEM` stays first and unchanged.
- No model call in any automated test. No change to Tuah. No Kuasa names in `src/`. No purple or violet.
- A live test creates its users, workspaces and files through `tests/helpers/live-workspaces.ts`, and removes every file it uploads.
- 2-space indent, single quotes, semicolons, named exports (screens keep `export default`).
- Three migrations, each a safe transaction on its own, versions `20261029090000`, `20261029090100`, `20261029090200` unless `main` has taken them by then (re-check when the branch is cut and again just before the PR).

## Review Focus

1. **Reading someone else's file**: by a guessed or copied path, an expired or shared link, a document id from another employee or workspace, a path attached twice, a path under another employee's folder at upload; as a member, a viewer, a demo visitor, a signed-out caller. Tasks 1, 2.
2. **A draft leaking**: a draft letter to the employee through the API, Letters, My Documents, its count, or Lekiu's wording. Tasks 1, 2, 4, 5.
3. **Orphaned and lost files**: an upload abandoned before saving; a replace or remove that fails half-way (the row gone and the file left, or the file gone and the row left); a deleted employee's files. Tasks 1, 2.
4. **Placeholders**: a letter issued with `{designation}` in it; a known placeholder with a missing value; unknown braces left alone; a placeholder in the title; filling that injects one employee's details into another's letter. Tasks 1, 2, 4.
5. **Acknowledgement**: recorded by anyone but the employee; recorded twice; surviving a replaced file or a pulled-back letter; requested on an employee's own upload; shown as a signature anywhere. Tasks 1, 3, 4, 5.

---

### Task 1: The database and storage (most capable model)

**Files:**
- Create: the three migrations (documents, acknowledgement and the bucket; letters and templates; the demo re-seed, replaced: copy the latest `private.reseed_demo_people()` from L6a's seed migration and change only what spec §4.5 says; the file does not call it)
- Create: `supabase/tests/people_documents_check.sql`, `tests/people-documents-schema.test.ts`
- Modify: `supabase/tests/people_rls_check.sql`

**Interfaces (produced; Tasks 2 to 5 rely on these exact names and shapes):**

```
hr_add_document(p_employee uuid, p_title text, p_doc_type text, p_expires_on date,
                p_file_path text, p_file_name text, p_file_size bigint, p_file_type text)      -> jsonb <document>
hr_update_document(p_document uuid, p_title text, p_doc_type text, p_expires_on date)           -> jsonb <document>
hr_replace_document_file(p_document uuid, p_file_path text, p_file_name text, p_file_size bigint, p_file_type text)
  -> jsonb { document: <document>, old_path: text | null }
hr_remove_document(p_document uuid)                         -> jsonb { id, employee_id, path: text | null }
hr_release_document_file(p_path text)                       -> boolean
hr_request_document_ack(p_document uuid, p_requested boolean)   -> jsonb <document>
hr_acknowledge_document(p_document uuid)                    -> jsonb <document>
hr_save_letter(p_employee uuid, p_letter uuid, p_letter_type text, p_title text, p_body text, p_ack_requested boolean)
  -> jsonb <letter>
hr_start_letter_from_template(p_employee uuid, p_template uuid) -> jsonb { letter: <letter>, unfilled: text[] }
hr_issue_letter(p_letter uuid)                              -> jsonb <letter>
hr_unissue_letter(p_letter uuid)                            -> jsonb <letter>
hr_delete_letter(p_letter uuid)                             -> jsonb { id, employee_id }
hr_acknowledge_letter(p_letter uuid)                        -> jsonb <letter>
hr_save_letter_template(p_org uuid, p_template uuid, p_name text, p_letter_type text, p_title text, p_body text)
  -> jsonb { id, name, letter_type, title, body }
hr_delete_letter_template(p_template uuid)                  -> jsonb { id }
private.hr_orphaned_document_files(p_org uuid)              -> setof text      (service role only; for the sweep)

<document> = { id, employee_id, title, doc_type, expires_on, file_name, file_size, file_type, source,
               ack_requested, acknowledged_at, created_at }            (never the path)
<letter>   = { id, employee_id, letter_type, title, body, status, issued_on, ack_requested, acknowledged_at }
```

Columns, tables, the bucket, read rules, rules, placeholders, refusals and codes: spec §4.1 to §4.6, exactly.

Points the spec leaves to this plan:
- **Deleting an employee returns their files' paths.** The existing employee-delete function (read its latest definition; it already refuses an employee with a paid payslip) is replaced so that its result also carries `document_paths: text[]`, collected before the cascade. Its other behaviour and its existing result fields do not change.
- **The sweep's function** is named `private.hr_orphaned_document_files(p_org)`: the bucket's object names under that workspace's folder that are no document's `file_path`. The spec asks for "a private function"; the name is this plan's.
- **`service_role` has no default rights in this project** (it cost a whole feature once). The migrations grant it, explicitly: execute on `private.hr_orphaned_document_files`, and whatever the service client's file removal reads (`private.hr_released_documents`, as the receipts migration does for `private.hr_released_receipts`: copy its grants exactly). The schema test asserts each grant, and the access check proves them with `has_function_privilege` / `has_table_privilege`.
- **The starter templates** (the backfill for every workspace with none, and the trigger for a new workspace) go in the second file, the one that creates `hr_letter_templates`. The spec's "first migration" is read as "the migration that creates the table".
- **Rows that already exist in a real workspace.** None are expected (Task 6 checks). The migrations are still safe if one exists: a document of an old type becomes `other`, a letter of an old type becomes `other` and keeps its status, and nothing of a real workspace is deleted. Only the demo's `payslip` and `letter` documents are deleted.
- **Asking for acknowledgement of a letter** is part of the letter itself (`p_ack_requested` on `hr_save_letter`), so it can change only while the letter is a draft. There is no separate function for it.

- [ ] **Step 1: The schema test first** (reads the three files as text, as `tests/people-performance-schema.test.ts` does): names, order and unique versions; every column, check and table; the bucket's size and type limits; the storage policies (select through a readable document's `file_path`; insert only under the caller's workspace and, for a non-admin, their own employee folder; the second factor; never the demo; no update or delete policy); every public function `security definer`, `set search_path = public`, revoked from `public` and `anon`, refusing the demo; every code bare; the starter-template trigger on new workspaces; the third file holds exactly the re-seed and does not call it. Run it and watch it fail.
- [ ] **Step 2: Write the three migrations.** Each applies cleanly after the previous one with the deployed (L6a) app still running: new columns nullable or defaulted; the old `doc_type` and `letter_type` values in existing rows handled before a check is tightened (the demo's rows only: delete or re-map them inside the same file).
- [ ] **Step 3: Run the schema test** until it passes.
- [ ] **Step 4: Write the access check**, one `do` block, rolled back, ending `PEOPLE_DOCUMENTS_CHECK PASSED (everything rolled back)`, independent of the day it runs, counting only rows it planted, and as short as it can be (it is later retyped into a SQL tool in one call; state its size). It proves at least:
  - each function for an owner and an admin (succeed), the employee concerned (only where spec §4.5 says "own"), another member, a viewer, an owner of another workspace, a demo member and no session (refused with the code spec §4.6 gives);
  - documents: each type an employee may and may not add; the 201st; a path outside the workspace, outside the employee's folder, already attached, or released; update and replace by an admin only; replace returns the old path and clears the acknowledgement; remove by an admin for any, by the employee only for their own upload; release refuses an attached path;
  - storage, by inserting rows into `storage.objects` as each role (as L3's check does): a member selects only objects on documents they may read; inserts only under their own folder; cannot update or delete; an admin inserts under any employee of their workspace and none of another's; the demo and `anon` nothing;
  - acknowledgement of a document and of a letter: only the employee; only when requested; once; cleared by a replaced file, a withdrawn request and a pulled-back letter; never on an employee's own upload;
  - letters: draft invisible to its employee and visible once issued; edit and delete only as a draft; issue refused when empty and when the title or body holds a known placeholder, allowed with unknown braces; issue sets the Malaysia date and the issuer; pull back clears them;
  - templates: the name unique per workspace; the 51st; filling each placeholder from a fixed employee and workspace; a missing designation, department and join date left as placeholders and reported in `unfilled`; a template of another workspace refused; a new workspace gets the starter set;
  - reading: templates for owners and admins only; a member reads no colleague's document or letter; the demo member reads everything in the demo;
  - `private.hr_orphaned_document_files` lists exactly the planted orphan, and no ordinary caller can run it;
  - deleting an employee returns exactly their documents' paths, and still refuses one with a paid payslip;
  - `service_role` holds each right the migrations grant it, and no more on these tables;
  - nothing can be written to any table directly.
- [ ] **Step 5: Run everything on a scratch Postgres** with a `storage` schema faithful enough for the policies (as L3's Task 1 built it), on Postgres 14 and 17: this check and every earlier people check, all `PASSED`; the old re-seed still runs after file 1 alone and after files 1 and 2; a mutation pass of at least 50 rule-breaks across the caller tests, the storage policies, the path rules, the placeholder rule and the acknowledgement rules. Delete the scratch database afterwards.
- [ ] **Step 6: Commit** the six files. The report carries "Facts for Tasks 2 to 5": argument forms, returned shapes, the code each caller gets, the exact path shape, the placeholder rule as a regular expression, and the foreign-key names an embed needs.

---

### Task 2: The app's write path and files

**Files:**
- Create: `src/lib/people/document-writes.ts`, `letter-writes.ts`, `documents-refusals.ts`, `document-files.ts`, `document-files-server.ts`, `letter-placeholders.ts`, `document-forms.ts`, `src/app/(app)/people/document-actions.ts`, `letter-actions.ts`
- Modify: `src/lib/people/types.ts`, `supabase.ts`, `seed.ts`, `documents.ts`, `tests/setup/people-member-view.ts`
- Test: `tests/people-document-writes.test.ts`, `tests/people-letter-writes.test.ts`, `tests/people-document-files.test.ts`, `tests/people-letter-placeholders.test.ts`, `tests/people-document-forms.test.ts`, `tests/people-document-actions.test.ts`, extend the model tests for `documents.ts`, `tests/people-documents.rls.test.ts` (write, do not run)

**Interfaces (produced; Tasks 3 to 5 rely on these):**

```ts
// types.ts
export const DOCUMENT_TYPES = ['contract','tax','benefits','identity','medical','certificate','other'] as const;
export const EMPLOYEE_DOCUMENT_TYPES = ['identity','medical','certificate','other'] as const;
export const LETTER_TYPES = ['offer','confirmation','promotion','warning','contract_renewal','other'] as const;
// HrDocument: title, doc_type, expires_on, file_name, file_size, file_type, source, ack_requested, acknowledged_at, created_at, has_file
// Letter gains: body, ack_requested, acknowledged_at; LetterTemplate { id, name, letter_type, title, body }

// document-files.ts (client-safe, pure where possible)
export const DOCUMENT_MAX_BYTES, DOCUMENT_FILE_TYPES;
export function pickDocumentFile(file: File): Converted<File>;          // size and type, with the spec's three sentences
export function documentPath(orgId: string, employeeId: string, file: File): string;    // <org>/<employee>/<uuid>.<ext>
export function isDocumentPath(path: string, orgId: string, employeeId: string): boolean;
export function uploadDocumentFile(client, path: string, file: File): Promise<CapResult<{ path: string }>>;
// document-files-server.ts ('server-only')
export function documentLink(ctx, documentId: string): Promise<CapResult<{ url: string }>>;   // one minute; only for a document the caller can read
export function removeDocumentFile(path: string): Promise<void>;       // service client; path-shape guard; never throws
export function releaseDocumentFile(ctx, path: string): Promise<void>;

// letter-placeholders.ts (pure)
export const PLACEHOLDERS: readonly string[];                           // the seven names
export function unfilledPlaceholders(text: string): string[];           // known ones still present, in order, de-duplicated

// document-forms.ts (pure)
export function expiryState(expires_on: string | null, today: string): 'none' | 'expiring' | 'expired';
export function toDocumentInput(values, allowedTypes), toLetterInput(values), toTemplateInput(values);  // Converted<...>

// documents.ts (models)
buildMyDocumentsModel({ documents, letters, payslips, today, viewer })  // documents + issued letters + paid payslips; awaiting-acknowledgement first
buildEmployeeDocumentsModel(...), buildLettersModel(...)               // a member gets issued letters of their own only
awaitingAcknowledgement(documents, letters): number

// actions: own — addMyDocumentAction, removeMyDocumentAction, acknowledgeDocumentAction, acknowledgeLetterAction,
//   discardDocumentFileAction, documentLinkAction;  owner/admin — addDocumentForAction, updateDocumentAction,
//   replaceDocumentFileAction, removeDocumentAction, requestDocumentAckAction, saveLetterAction,
//   startLetterFromTemplateAction, issueLetterAction, unissueLetterAction, deleteLetterAction,
//   saveLetterTemplateAction, deleteLetterTemplateAction
```

Rules:
- Upload happens in the browser straight to storage under a path the app builds; the action then asks the database to attach it. If attaching is refused or the person cancels, `discardDocumentFileAction` releases the path and the file is removed. Replace and remove: the database first, then the old file is removed with the path it returned; a failure to remove a file never fails the action (the sweep will find it).
- File removal copies `receipts-server.ts` exactly (the same service client, the same path-shape guard before any call, the same "never throws"): that path is proven on live. Do not write a new way to delete from storage.
- Deleting an employee: the existing action removes each path in the `document_paths` the database returns, after the delete succeeds, one path at a time; a failure to remove one is logged by code only and does not fail the action.
- `documentLinkAction` checks nothing itself: it asks storage for a signed link with the caller's own session, so the storage policy decides. It returns the link to the browser only.
- The provider never selects `file_path` for the app's models; `has_file` is whether one is attached. `listLetters` applies no status filter (the database decides); models filter again for a member.
- The sweep: a script `scripts/sweep-document-files.mjs` (service client; lists `private.hr_orphaned_document_files` per workspace and removes exactly those paths; dry run by default). It is not scheduled and not run in this plan except against the scratch setup.
- `tests/people-documents.rls.test.ts` (live; first run in Task 6): an owner and a confirmed member in a fresh workspace; a real small PDF uploaded by the owner to the member's record and by the member to their own; the member downloads their own through a signed link and is refused a file on the owner's own record by path; a viewer of another workspace is refused; a draft letter invisible, then issued and acknowledged; a letter from the starter template with a missing designation refused at issue; every owner-only write refused for the member with the sentence from the refusals module; every file it uploaded is removed at the end, and it asserts the bucket holds nothing under its workspace.

- [ ] **Step 1: Tests first** for `letter-placeholders.ts` (each known name; unknown braces; nested and adjacent braces; a name in the title; repeated names), `document-forms.ts` (expiry at today, yesterday, day 90 and day 91), `document-files.ts` (the path shape and its guard against `..`, another workspace, another employee, upper case, a missing extension; size and type sentences), both write paths with a fake client (exact argument names; each code to its sentence; nothing typed logged), and the actions (own-record actions take the employee from the viewer; owner-only refused before any read; a failed attach releases the file). Run them and watch them fail.
- [ ] **Step 2: Write the code** until those pass; then the model tests and the live test file.
- [ ] **Step 3:** `pnpm tsc --noEmit` and `pnpm lint` clean. Commit. The report carries "Facts for Tasks 3 to 5".

---

## Parallel tasks: 3, 4 and 5 (after Task 2)

Each touches only its own files, does not commit, and does not run `pnpm tsc`, `pnpm lint`, `pnpm build` or `pnpm test`. Each runs its own test files by exact name and `pnpm eslint <its files>`. Every rule that can be pure goes in a tested pure function; each report ends with the component-only behaviours left for the browser pass, worst first.

### Task 3: Documents

**Files:** modify `src/screens/people/my-documents.tsx`, `src/screens/people/employees.tsx` and `src/components/people/employees-table.tsx` (the Documents action only), the people layout that fills the Lekiu nav badges and `src/config/nav.ts` (a badge on My Documents); create `src/components/people/document-form.tsx`, `document-row.tsx`, `document-download.tsx`, `employee-documents.tsx`, `acknowledge-button.tsx`; pure rules in `src/lib/people/documents-screens.ts`; tests `tests/people-documents-screens.test.ts`.

Spec §5.2 rows "My Documents", "Employees", "Navigation". Rules: the four tiles; awaiting-acknowledgement items first, with the button and the line "This records that you have read it. It is not a signature."; Upload offers only the four employee types; Download opens the one-minute link in a new tab and says so when it fails; Remove only on one's own uploads, with a second step; the employee's issued letters and paid payslips listed with links to the Letters page and My Payslips; the owner's Documents action lists who uploaded each and its acknowledgement state, with Add, Edit, Replace file, Remove (second step) and Request / Withdraw; in the demo, Download reads "Sample document, no file" and every control is absent; the My Documents badge is the count awaiting the viewer's acknowledgement.

### Task 4: Letters and templates

**Files:** modify `src/screens/people/letters.tsx`; create `src/components/people/letter-form.tsx`, `letter-view.tsx`, `letter-row-controls.tsx`, `template-form.tsx`, `templates-section.tsx`; pure rules in `src/lib/people/letters-screens.ts`; tests `tests/people-letters-screens.test.ts`.

Spec §5.2 rows "Letters" and "Letters, Templates section". Rules: a member sees their issued letters only and no "New letter"; the letter view is a printable layout (workspace name, date, employee's name, title, body as text with line breaks; print styles hide the app chrome) with the acknowledge button when asked; owners and admins: New letter (employee, then blank or from a template: the draft opens with placeholders filled, and any left are highlighted and named); Edit, Issue and Delete on a draft; View and Pull back on an issued one; Issue and Pull back take a second step with "<Name> will be able to see this letter." / "<Name> will no longer see this letter, and any acknowledgement is cleared."; Issue is disabled with the reason while `unfilledPlaceholders` is not empty or the body is empty; the template editor lists the seven placeholders and inserts one at the cursor.

### Task 5: Lekiu

**Files:** modify `src/lib/ai/people-tools.ts`, `src/lib/ai/products.ts`, `src/lib/ai/agents/prompts.ts`, `src/lib/chat/change-titles.ts`; tests `tests/people-documents-tools.test.ts`, `tests/people-documents-approval.test.ts`, extend `tests/people-change-titles.test.ts`, `tests/lekiu-prompt.test.ts`, `tests/people-chat-route.test.ts`, `tests/people-tools.test.ts`, `tests/people-change-tools.test.ts`.

Spec §5.3. `requestAcknowledgement` on a document calls `hr_request_document_ack`; on a letter it saves the draft again with the request changed, so it is offered only for a draft (the card says "A draft: the employee will be asked when it is issued."); for an issued letter Lekiu says, at once, that it is pulled back on the Letters screen first. Rules: four change tools (`saveLetter`, `startLetterFromTemplate`, `issueLetter`, `requestAcknowledgement`) for the `hr` tier only, absent otherwise and in the demo; cards carry the whole letter every time; an issue card for a draft the conversation shows with a placeholder states the letter in full and adds that it will be refused, and which placeholder; lookups by tier (`listDocuments` never returns a path, a link or a file's contents; a member gets no ids; `listLetters` gives a member their own issued letters; `listLetterTemplates` for the `hr` tier); the prompt lines of spec §5.3, with an explicit line for each thing that is not a tool (upload, replace, remove a document; delete a letter; pull back; acknowledge; templates) saying where it is done, at once, without offering; a member is never told a draft letter exists; Lekiu says it does not read what is inside a file; for an owner or admin a drafted letter is offered as a saved draft. Approval tests drive every tool through the SDK's input parsing and assert one write after approval.

---

### Task 6: Bring it together (coordinator)

- [ ] **Step 1:** Commit Tasks 3 to 5 by path, `pnpm tsc --noEmit`, `pnpm lint`, `pnpm build`, the full `pnpm test` (expected red until the migrations are applied: the two live tests), confirming the live workspace count is unchanged.
- [ ] **Step 2:** Whole-branch review on the most capable model, one fix wave, one scoped re-review.
- [ ] **Step 3:** Read-only live pre-check: migrations not applied; no real workspace has a document or a letter (if one does, stop and tell the owner what the migrations will do to it before asking to apply); the bucket does not exist; the Postgres version; foreign-key names for the provider's embeds.
- [ ] **Step 4: Stop for the owner's go-ahead to apply the three migrations** (the first creates a storage bucket). Apply one at a time, in order, not at minutes :00 to :02; after each, confirm function bodies by hash, and policies, checks, the bucket's limits and its policies from the catalogue. The third goes on immediately before the merge, followed by one manual run of the demo re-seed.
- [ ] **Step 5:** `people_documents_check.sql` and `people_rls_check.sql` on live (rolled back), one fresh agent per script, window :05 to :52, never two at once. Then the full `pnpm test`, and confirm the bucket holds nothing the live test made.
- [ ] **Step 6:** Browser passes: a demo visitor first; the owner (upload to an employee, replace, request acknowledgement; a letter from a template with a missing detail, fix, issue, pull back, issue again; a template edited); the member test account (upload their own, download both, acknowledge a document and a letter, print view, no owner control, no draft visible). The owner signs each account in.
- [ ] **Step 7:** Real Lekiu questions in English and Bahasa Malaysia: as owner "write a confirmation letter for <employee>" (card with the whole letter), "issue it" (card; refused when a placeholder is left), "who hasn't acknowledged the handbook?", "upload this" (declined, pointed to the screen); as the member "what documents do I have?", "acknowledge it for me" (declined). About five billed calls.
- [ ] **Step 8:** Remove the test documents, files and letters from the owner's workspace unless the owner wants them kept; run the sweep in dry run and report what it lists. Execution Notes; rebase; re-check versions; push; PR. Merge only on the owner's say.

## Not in this plan

Everything in the spec's "Out" list (to be planned in a later round, with L6a's): PDFs and letterheads, e-signature, rich text, a salary placeholder, email, versions and a recycle bin, AI reading of files, bulk upload, an approval step for employee uploads, Bahasa Malaysia starter templates. Also: scheduling the sweep; dropping `hr_documents.status`.
