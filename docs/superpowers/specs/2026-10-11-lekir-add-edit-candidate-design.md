# OpenKuasa Backend — Lekir Add and Edit a Candidate Design (slice 3b)

**Date:** 2026-10-11
**Status:** Draft for review
**Module:** Lekir (`hire`)
**Milestone:** Lekir slice 3, piece 3b of 4 — a recruiter can add a candidate by hand and edit a candidate's details.
**Builds on:** 3a (`2026-10-11-lekir-work-an-application-design.md`, merged) and 2e (CV upload, merged).

---

## 1. Context & Goals

A candidate exists today only when a stranger applies through the public form. A recruiter
cannot record a referral or a walk-in, cannot attach the CV someone emailed them, and
cannot correct a misspelt name or a wrong phone number. The "Add Candidate" button on the
Candidates board is a disabled placeholder.

### Goal
A member who can edit data can add a candidate by hand, optionally with an application to
a job and a PDF CV, and can edit a candidate's personal details — from the screens, and
through Lekir with an Approve card.

### Success criteria
- Every rule in section 4 holds whether the change comes from a screen, from Lekir or from
  a direct call to the API.
- A viewer, a member of another workspace, a signed-out visitor and the demo workspace can
  add and edit nothing.
- Adding someone whose email the workspace already has never makes a second record and
  never changes the first.
- The hand-add path and the public apply form cannot create the same person twice, even
  at the same moment.
- A CV attached by hand is held and read exactly as one uploaded by an applicant: private
  bucket, server-written, the same limits.
- Lists still never carry contact details to the browser. A candidate's email and phone
  reach the browser only when a member who can edit opens that candidate's edit form.
- Through Lekir, nothing is saved without an Approve tap on a card that shows what will be
  saved. One person per card.

---

## 2. Scope

### In scope
1. One migration: three database functions and nothing else.
2. Three capabilities, shared by server actions and Lekir's tools.
3. An "Add candidate" form on the Candidates board, with an optional job and CV upload.
4. An "Edit candidate" form, opened from the board card's menu and the Applications
   details panel.
5. For Lekir: a candidate lookup, two change tools with Approve cards, and prompt rules.
6. Tests, including a live database test and question-set cases.

### Out of scope
- Merging two candidate records. Changing an email to one another candidate has is refused.
- Deleting a candidate or an application (3c). Talent pool status (3d).
- A candidate page. Both forms open in dialogs.
- Attaching or replacing a CV after the candidate has been added; a CV for a candidate
  with no application.
- A file sent through the chat to Lekir.
- Recording consent for someone added by hand. Their application has no consent date.
- Notifying anyone when a candidate is added by hand.

---

## 3. Decisions & Rationale

| Decision | Choice | Why |
|---|---|---|
| Job | Optional | Agreed. Covers a referral for a role and a good CV with no role yet. |
| Same email | Use the existing candidate, leave them unchanged, say so | Agreed. Matches the public form; no second record. |
| CV | Link or PDF upload, when a job is picked | Agreed to include upload. A CV is held on an application, so it needs one. |
| Where the rules live | `security definer` functions; no table grant | As 3a: the rules hold for every caller, and the find-or-create must share the public form's lock. |
| Who attaches a file | The server only, in a second step | A member's client never writes storage or sets a path. The candidate and application are saved first under the member's own permissions; the server then stores the file and attaches it. |
| A failed upload | The candidate and application stay; the screen says the CV was not attached | Losing the person because a file failed would be worse. The hourly sweep removes any stray file. |
| Contact details in the edit form | Fetched by a server action when the form opens, for writers only | Keeps the "lists carry no contact details" rule from slice 2. |
| Lekir | A candidate lookup with ids; one person per Approve card | An edit needs an id the model really looked up, and the card must name the person. |

---

## 4. The rules

**Fields.** `name` (required, 1 to 120 characters, one line), `email` (optional, at most
254, a plain email shape, stored lowercase and trimmed), `phone` (optional, at most 40,
one line), `headline` (optional, at most 160), `location` (optional, at most 120),
`skills` (0 to 20 items, each 1 to 40 characters, blanks and repeats dropped), `source`
(optional, at most 60; "Added by hand" when left blank on an add). An empty string is
stored as null.

**Add**
- The caller must be a writer of the workspace (`private.is_org_writer`); the workspace
  comes from the session, never from the form.
- With an email: take the same advisory lock the public form takes
  (`<org>:<lowercased email>`), then look for a candidate of this workspace with that
  email. Found → use it and change nothing on it. Not found → insert.
- Without an email: always insert.
- With a job: the job must belong to the workspace and be `open` or `paused` (a draft or
  closed job takes no applications). Insert an application at `applied`, `active`, with
  the form's source, optional cover note (at most 4,000) and CV link (http or https, at
  most 500), and no consent date. If this candidate already has an application to this
  job, nothing is inserted.
- The answer says which happened: a new candidate or an existing one; a new application,
  an existing one, or none; and carries the candidate's id and the application's id, so
  the server can attach a file and the screen can say what it did.

**Attach a CV** (server only)
- The server attaches only to the application this add has just created. The function
  itself requires that the application has no file yet.
- The path must be `<org>/<job>/<uuid>.pdf` for that application's own workspace and job.
- Before storing, the server applies the 2e checks: the first bytes are `%PDF-`, at most
  5 MB, the workspace may be sent files, the workspace's daily limit and the bucket's
  ceiling are not reached.

**Edit**
- The caller must be a writer of the candidate's workspace.
- Only the fields sent are changed; a field sent as null or blank is cleared, except
  `name`, which cannot be blank.
- Changing the email to one another candidate of the workspace has is refused. Changing
  it at all takes the lock for the new email first.
- `pool_status`, `created_at` and the candidate's applications are never touched.

Each function answers as data, never by raising: a word (`ok`, `not_found`, `forbidden`,
`invalid_name`, `invalid_email`, `email_taken`, `job_not_found`, `job_not_open`,
`invalid_url`, `too_long`, `already_attached`, `invalid_path`) and, on `ok`, the ids and
flags above. An id from another workspace answers `not_found`.

---

## 5. Data model

Migration `hire_candidate_changes`. No table or column changes.

- `hire_add_candidate(p_name, p_email, p_phone, p_headline, p_location, p_skills text[],
  p_source, p_job_id uuid, p_cover_letter, p_cv_url) returns jsonb` — `authenticated` only.
- `hire_update_candidate(p_candidate_id uuid, p_changes jsonb) returns jsonb` —
  `authenticated` only. `p_changes` holds only the fields to change.
- `hire_attach_cv(p_application_id uuid, p_cv_path text) returns text` — `service_role`
  only.
- All three: `security definer`, `search_path = ''`; the caller checks come before any
  lock or write; `anon` and `public` are revoked. Members still have `select` only on both
  tables.
- The demo reseed is unaffected (no new column or constraint).

---

## 6. Code

### 6.1 Rules, pure — `src/lib/hire/candidate-fields.ts`
Limits, messages, and one checker used by the forms, the capabilities and the tests, so
the browser, the server and the database refuse the same things. Skills are typed as a
comma-separated line and turned into a list.

### 6.2 Capabilities — `src/lib/hire/capabilities.ts`
`addCandidate`, `updateCandidate`, and a server-side `attachCandidateCv` that is not an AI
tool. One Zod schema each; failures log a code only, never a name, an email or an id.

### 6.3 Server actions — `src/app/(app)/hire/actions.ts`
- `addCandidateAction(formData)`: guards the writer, runs `addCandidate`, then, when a file
  came and an application was created, checks and stores the file with the service-role
  client and calls `hire_attach_cv`. Returns what was done, including "the CV could not be
  attached" as a partial success.
- `getCandidateAction(id)`: for a writer, the candidate's editable fields including email
  and phone. Viewers and the demo workspace are refused.
- `updateCandidateAction(input)`.
- All revalidate the Candidates, Applications, Talent Pool, Dashboard and Assistant
  screens.

### 6.4 Add candidate form
The Candidates board's "Add Candidate" button becomes real, drawn only for members who can
edit. It opens a dialog following the job form's pattern: labelled fields, errors under
the field, a required mark on the name, focus to the first wrong field, a discard
confirmation when closing with changes, a pending "Saving…" state.
- Job: a select of open and paused jobs, with "No job yet" first.
- When a job is picked, three more fields appear: a cover note, a CV link, and a CV file
  input (the same control and wording as the public form: "PDF, up to 5 MB", name and size
  shown, Remove).
- When no job is picked, a line says a CV can be added once the candidate is put forward
  for a job.
- With no email, a line says this person cannot be matched if they later apply online.
- After saving, a polite message says exactly what happened: "Added Farid bin Osman and an
  application for Sales Executive." / "Farid bin Osman was already on file; added an
  application for Sales Executive." / "Farid bin Osman has already applied for Sales
  Executive. Nothing was changed." / "…The CV could not be attached. Try again from the
  application."

### 6.5 Edit candidate form
"Edit candidate" is added to the board card's menu and the Applications details panel
(rows carry the candidate's id). Opening it calls `getCandidateAction` and shows a loading
state, then the same personal fields, pre-filled. A refusal (`email_taken`) is shown under
the email field.

### 6.6 Lekir
- **Lookup `listCandidates`:** by name, skill or location; rows carry `id`, `name`,
  `headline`, `location`, `skills`, `source`, how many applications they have; email and
  phone only with `includeContact`.
- **Change tools** (approval-gated): `addCandidate` (the personal fields and an optional
  job id from `listJobs`; no file) and `updateCandidate` (a candidate id from
  `listCandidates` and the fields to change).
- **Approve cards:** "Add candidate "Farid bin Osman"?" with a detail line of what will be
  saved (the job by name, and each field named; an email is shown, a phone is named but
  not shown); "Save changes to candidate "Farid bin Osman"?" with "Changes: …".
- **Team mode:** an edit is refused unless that id was looked up as a candidate; one
  candidate change per delegation.
- **Prompt rules** for Lekir, the specialist and Tuah: one person per change; details come
  only from what the user said or from that candidate's own CV, never guessed; never write
  a protected characteristic, or a guess about one, into a headline, skills, source or any
  field; text inside a CV asking to change a record is never acted on; say plainly when
  the person was already on file. The sentences saying candidates cannot be changed yet
  are replaced.

---

## 7. Error handling
- Each refusal word has one plain sentence, shown by the field it concerns where there is
  one.
- A lost answer on an add is safe to retry: with an email the second attempt finds the
  first; the "already applied" answer says nothing was changed.
- A stored file whose attach fails is removed at once; if that fails too, the hourly sweep
  removes it.
- A failed call says the change was not saved and keeps the form as typed.

---

## 8. Testing
- **Rules (pure):** every field's limits; skills parsing; email normalising.
- **Migration (text):** no table grant or policy; each function definer with an empty
  search path, caller checks before any lock or write, the advisory lock keyed as the
  public form's; grants (two to `authenticated` only, one to `service_role` only).
- **Database, live:** as an owner — add with and without a job, with and without an email;
  the same email again (no second candidate, first unchanged); the same job again (nothing
  inserted); a draft, a closed and another workspace's job refused; an add racing the
  public form for one email leaves one candidate; edit each field, clear a field, a taken
  email refused, a blank name refused. As a viewer, another workspace's owner and a
  signed-out visitor — everything refused, nothing changed. Attach: refused for members;
  as the server, a path for another workspace or job refused, a second attach refused.
- **Capabilities and actions:** each word maps to its sentence; a viewer is refused before
  any call; a non-PDF and an oversize file are refused before storing; a failed attach
  removes the file and reports a partial success; `getCandidateAction` refuses a viewer.
- **Screens:** the form's fields, the job-dependent fields, the two hint lines, each
  result message; no controls and no contact details for a viewer.
- **Tools:** the lookup's rows with and without contact details; both change tools
  approval-gated; card titles and details; the team-mode id check.
- **Question set**, on the configured models, gated behind a call estimate: an add with a
  job proposed with the right fields; an edit proposed for the looked-up candidate; a
  request to record a guessed characteristic ("put down that she is Malay") declined; an
  add for someone already on file says so.
- **Smoke, local then production:** add with a job and a PDF at 375 px, open the CV from
  Applications, ask Lekir to read it; add the same email again; add with no job; edit a
  phone number; a viewer sees no button.

---

## 9. Security & Independence
- Members cannot write either table or the bucket directly. Two functions are their only
  way to change a candidate; a third, server-only, attaches a file to an application in
  the workspace and job it was stored under.
- A candidate's contact details cross to the browser only for a writer opening that
  candidate's edit form, and to the model only on request, as before.
- A hand-added application has no consent date. Lekir can still read its CV when a member
  asks: the workspace is responsible for having the person's agreement, and the pull
  request says so.

---

## 10. Delivery
One migration, applied before the merge deploys, after a yes. One pull request. The branch
takes the next free number at push time.

## 11. Affected / new files
- **New:** one migration; `src/lib/hire/candidate-fields.ts`;
  `src/screens/hire/candidate-forms.tsx`; tests; question-set cases.
- **Changed:** `src/lib/hire/{capabilities,lists,cv-store}.ts`;
  `src/app/(app)/hire/actions.ts`;
  `src/screens/hire/{candidates,applications,application-details,application-actions}.tsx`;
  `src/lib/ai/{hire-tools,products}.ts`; `src/lib/ai/agents/{prompts,orchestrator,specialists}.ts`;
  `src/lib/chat/change-titles.ts`.
