# OpenKuasa Backend — Lekir Talent Pool Design (slice 3d)

**Date:** 2026-10-11
**Status:** Draft for review
**Module:** Lekir (`hire`)
**Milestone:** Lekir slice 3, piece 3d of 4 — a recruiter can add people to the talent pool, set their pool status, remove them, and move them back into the pipeline for a job.
**Builds on:** 3a (`2026-10-11-lekir-work-an-application-design.md`, merged), 3b (`2026-10-11-lekir-add-edit-candidate-design.md`, merged) and 3c (delete an application or a candidate, designed in parallel, merges first).

---

## 1. Context & Goals

The talent pool is the list of people worth keeping for a future role. Today it can only be
read. Each candidate has one pool field, `pool_status`, which is `none` (not in the pool),
`available`, `passive` or `re_engaged`
(`supabase/migrations/20261013090000_hire_foundation.sql:31-32`). Nothing in the app can
change it: members can only read the table (same file, lines 89-90), and the one function
that edits a candidate leaves the pool status alone on purpose
(`20261026090000_hire_candidate_changes.sql:136-137`). On the Talent Pool screen, "Add to
Pool", the search box, the two filters and each row's "Move to pipeline" are disabled
placeholders marked "Coming soon" (`src/screens/hire/talent-pool.tsx:112-115, 185-207,
267-269`).

There is also a gap left by 3b. A person added by hand with "No job yet" is saved with
`pool_status = 'none'` (`20261026090000_hire_candidate_changes.sql:104-105`) and has no
application, so they are on no screen at all. The form says so itself
(`src/screens/hire/candidate-forms.tsx:64-66`).

### Goal
A member who can edit data can put a person in the talent pool, mark them Available,
Passive or Re-engaged, take them out again, and move them into the pipeline for a job —
from the screens, and through Lekir with an Approve card. A person added by hand with no
job goes into the pool, so nobody on file is invisible because of how they were added.

### Success criteria
- Every rule in section 4 holds whether the change comes from a screen, from Lekir or from
  a direct call to the API.
- A viewer, a member of another workspace, a signed-out visitor and the demo workspace can
  change nothing.
- Removing someone from the pool removes nothing else: the person, their details and their
  applications stay.
- Moving someone to the pipeline never makes a second application for the same job, even
  when two recruiters, or a recruiter and the public apply form, act at the same moment.
- A person added by hand with no job is in the pool as Available from the moment they are
  saved, and the people already added that way are moved in once, by the migration.
- Through Lekir, nothing changes without an Approve tap on a card that names the person and
  the change. One person per card.
- Anyone in the pool can be brought onto the Talent Pool screen by typing their name in
  its search box, however long ago they were put on file (up to the 1,000-row read limit,
  which the screen states when it is reached).
- Lekir never moves someone into or out of the pool, or marks them Passive, on a protected
  ground.

---

## 2. Scope

### In scope
1. One migration: two new database functions, a one-line change to `hire_add_candidate`,
   and a one-time update of existing rows. No new table or column.
2. Two capabilities, shared by server actions and Lekir's tools.
3. The Talent Pool screen: a working "Add to Pool" picker, a working "Move to pipeline" on
   each row, a row menu for the status and for removing, an "Available" tile, and a
   working search box over the whole pool.
4. "Add to talent pool" on the Candidates board's card menu and in the Applications
   details panel.
5. The reworded hint under "No job yet" on the Add candidate form, and the reworded
   message after such an add.
6. For Lekir: two change tools with Approve cards, ids on the pool lookup, the pool status
   on the candidate lookup, and prompt rules.
7. Tests, including a live database test, question-set cases and a browser smoke checklist.

### Out of scope
- The "All roles" select, the "Filter" button and the "All sources" button on the pool
  table. All three stay disabled and marked "Coming soon". None of them comes for free
  with search: each needs a list of choices and a menu of its own. The search box does
  cover what they would mostly be used for, since it matches a person's headline (their
  role) and their source as well as their name (6.5).
- Paging the pool table. With no search it still draws the newest 50 people on file
  (`src/lib/hire/lists.ts:37, 411`); search is the way to reach anyone else.
- Raising the read limit. The screen reads the newest 1,000 candidates on file
  (`src/lib/hire/types.ts:118`), as every Lekir screen does. A pool member older than
  that is not read, so is not counted, drawn or found. The screen says so when the limit
  is reached (6.5).
- Ordering the table by when a person joined the pool. Nothing records that (section 3).
- Changing several people from one request or one card.
- A date for when someone joined the pool, who added them, notes, and tags. There is no
  column for any of them, and this piece adds none.
- Changing what "Shortlisted" means. It stays a label worked out from the person's
  applications (section 4).
- Deleting a candidate (3c). Telling the person anything: the product sends no email.
- Recording consent to be kept in a pool. As with a hand-added application in 3b, the
  workspace is responsible for having the person's agreement.

---

## 3. Decisions & Rationale

| Decision | Choice | Why |
|---|---|---|
| Where the rules live | Two `security definer` functions; no table grant | As 3a and 3b: the rules hold for every caller, and members keep `select` only. |
| One function for add, change and remove | `hire_set_pool_status`, with the status to set | All three are the same write to one field. Three functions would repeat the same checks. |
| An add must not overwrite | An "only if not in the pool" switch on that function | "Add to pool" pressed on a stale screen, or asked of Lekir, for someone already marked Passive would otherwise quietly turn them Available. With the switch it is refused and says what they are. |
| Setting the status a person already has | Refused with a sentence, not a silent success | Same as 3a's "already there". The person learns the screen was out of date. |
| Move to pipeline | Its own function, not a call to `hire_add_candidate` | `hire_add_candidate` finds a person by email and makes a new one when there is none (`20261026090000…sql:96-110`), so a pool member with no email would be duplicated. It also must set the pool status in the same transaction, and answer "already applied" as a refusal. |
| Who can be moved to the pipeline | Only someone in the pool | The button lives on a pool row, and "Re-engaged" means "was in the pool, put forward again". Without this rule the function would also be a second, quieter way to add people to the pool. |
| The new application's source | The candidate's own source, or "Added by hand" when they have none | This is what `hire_add_candidate` does for a person it saves with a job: the application carries the person's source (lines 39, 104-105, 113-116). The source figures then credit where the person really came from. |
| Pool status after a move | Always Re-engaged; they stay in the pool list | Agreed. The pool stays the record of who was kept, and the tile counts who came back. |
| "No job yet" adds | Saved as Available | Agreed. Nobody added by hand is invisible. |
| An existing person found by email on a no-job add | Left exactly as they are | 3b's promise (`…sql:108`): adding an email already on file changes nothing. The message still says "Nothing was changed." |
| People already added with no job | Moved in once by the migration, by a narrow rule | See section 5.4. |
| Tiles | Add "Available" | It is now the status every new pool entry starts with, and the four status tiles then add up to the pool size. |
| What the board and Applications know | Each row carries the person's stored pool status | So the menu offers "Add to talent pool" only when it applies, and otherwise says where the person stands. |
| The picker's list | Loaded when the picker opens, for writers only, with a filter in the browser | Keeps up to 1,000 rows out of every page load and away from viewers. Without a filter a long list is unusable. |
| Reaching everyone in the pool | The pool table's search box works, over the whole pool | The table draws 50 rows. Before this piece that only hid old pool members; now a person can be added to the pool long after they were put on file, and would be added straight into the hidden part. Search makes every pool member reachable by name. |
| Where the search runs | On the server, from a `q` parameter in the page's address | The page already reads the whole pool on the server on every request and only then cuts it to 50 rows (`lists.ts:396-411`). Filtering before the cut costs nothing more. Filtering in the browser would mean sending every pool row, up to 1,000, to every visitor on every load, viewers included, to save one round trip. The address also keeps the search across the page refresh that follows each change. |
| Order of the table | Unchanged: newest on file first. Not by when they joined the pool | There is no "joined the pool" date, and this piece adds no column. Nothing stored can stand in for one: `created_at` is when the person was first put on file; the status does not say when it was set; an application date exists only for people moved to the pipeline. So the spec does not pretend. A newly pooled person is found by search, and the sentence after an add names them. |
| Lekir | Two change tools; one person per Approve card | As 3a and 3b. |

---

## 4. The rules

**The three statuses.** These sentences are the helper text in every status menu, and what
Lekir says when asked what a status means.

| Stored | Shown as | Meaning |
|---|---|---|
| `available` | Available | Open to hearing about a role now. |
| `passive` | Passive | Not looking right now. Worth keeping in touch for later. |
| `re_engaged` | Re-engaged | You have been back in touch and put them forward for a job again. |

`none` means the person is not in the pool. It is never shown as a status; it is what
"Remove from pool" sets.

**Shortlisted** is not a stored status. A pool member with a live application at Interview,
Offer or Hired is shown as "Shortlisted" in the Status column and counted under that tile,
whatever their stored status (`src/lib/hire/lists.ts:398-406`). This piece leaves that as
it is. The row's status menu shows and changes the stored status underneath, and says in
one line why the label reads "Shortlisted".

**Set the pool status** (add, change, remove)
- The caller must be a writer of the candidate's workspace.
- The status must be `available`, `passive`, `re_engaged` or `none`.
- With the "only if not in the pool" switch on (an add): the status must not be `none`,
  and a person already in the pool is refused, with their current status, and not changed.
- Setting the status the person already has is refused and changes nothing. For `none`
  this reads as "not in the talent pool".
- Nothing else about the person changes. Their applications are not touched.
- New entries are Available unless another status is chosen.

**Move to pipeline**
- The caller must be a writer of the candidate's workspace.
- The job must belong to the same workspace and be `open` or `paused`. A draft or closed
  job takes no applications, the same rule as a hand-add (`…sql:87-94`).
- The person must be in the pool.
- If the person has any application to that job — live, rejected or withdrawn — nothing is
  inserted and nothing is changed, the pool status included. The answer says so, and says
  whether that application is live or closed.
- Otherwise one application is inserted at `applied`, `active`, with no consent date, no
  cover note and no CV, and with the candidate's own source, or "Added by hand" when they
  have none. Their pool status becomes `re_engaged`. They stay in the pool list.
- A person who is already Re-engaged can be moved to another job; they stay Re-engaged.
- No notification is sent. (The public form announces a new application to the workspace's
  members; a recruiter does not need telling about their own action, and 3b's hand-add
  sends none either.)

**Add by hand with no job** (the change to `hire_add_candidate`)
- A new candidate saved with no job is saved with `pool_status = 'available'`.
- A new candidate saved with a job is saved with `none`, as today: they are on the board.
- An existing candidate found by email is left exactly as they are, pool status included.

**Who.** Any member who can edit: everyone but viewers. The demo workspace's visitors are
viewers.

Each function answers as data, never by raising: a `jsonb` object with a `word` and, where
useful, a little more.

| Function | Words |
|---|---|
| Set the pool status | `ok` (with `from` and `to`), `not_found`, `forbidden`, `invalid_status`, `already_in_pool` (with `from`), `same_status` (with `from`) |
| Move to pipeline | `ok` (with `application_id`, `from` and `to`), `not_found`, `forbidden`, `job_not_found`, `job_not_open`, `not_in_pool`, `already_applied` (with `application_id` and that application's `outcome`) |

`not_found` and `forbidden` are told apart only for the caller's own workspace: an id from
another workspace answers `not_found`. A job from another workspace answers
`job_not_found`.

---

## 5. Data model

Migration `hire_talent_pool`. No table, column, constraint, policy or table grant changes.

### 5.1 `hire_set_pool_status(p_candidate_id uuid, p_status text, p_only_if_outside boolean default false) returns jsonb`
In order:
1. Read the candidate's workspace by id, without a lock. No row, or the caller is not a
   member (`private.is_org_member`): `not_found`. Not a writer (`private.is_org_writer`):
   `forbidden`.
2. `p_status` not one of the four values, or `none` together with the switch:
   `invalid_status`.
3. Lock the candidate's row (`for update`) and read `pool_status`. Gone in the meantime
   (3c can delete a candidate): `not_found`.
4. Switch on and the stored status is not `none`: `already_in_pool`, with `from`.
5. The stored status equals `p_status`: `same_status`, with `from`.
6. Update the one field. Answer `ok` with `from` and `to`.

### 5.2 `hire_move_to_pipeline(p_candidate_id uuid, p_job_id uuid) returns jsonb`
In order:
1. Read the candidate's workspace and email by id, without a lock. The same `not_found`
   and `forbidden` checks as above.
2. Read the job's status where the job's id is `p_job_id` and its workspace is the
   candidate's, holding the row with `for share`. No row: `job_not_found`. Not `open` or
   `paused`: `job_not_open`. The share lock holds the job as it is until this transaction
   ends, so it cannot be closed or deleted halfway through. It is the same lock a hand-add
   takes (`…sql:88-91`). The public form takes a stronger one (`for update of j`,
   `20261019090000_hire_cv_upload.sql:194-198`) only because it also counts a per-job
   throttle, which this function does not have.
3. If the candidate has an email, take the advisory lock keyed
   `hashtextextended(<org>::text || ':' || <lowercased email>, 0)` — character for
   character the key the public form and the hand-add use
   (`20261019090000…sql:229`, `20261026090000…sql:97`). No email: no advisory lock, as in
   a hand-add (`…sql:96`).
4. Lock the candidate's row (`for update`) and read `pool_status` and `source`. Gone:
   `not_found`. `none`: `not_in_pool`.
5. Insert the application (`org_id`, `candidate_id`, `job_id`, `stage 'applied'`,
   `outcome 'active'`, `source`) with `on conflict (candidate_id, job_id) do nothing`.
   Nothing inserted: read that application's id and outcome and answer `already_applied`.
6. Set `pool_status = 're_engaged'`. Answer `ok` with the application's id, `from` and
   `to`.

**Lock order.** Job row, then the email's advisory lock, then the candidate's row. That is
the order the public form and the hand-add already use for the first two, and the order
the candidate edit uses for the last two (`…sql:168-180`), so no two of these functions
can wait on each other in a circle.

**Why the email lock at all,** when this function never creates a person: it makes this
function and the public form take turns for the same person. A recruiter moving Aina to
"Sales Executive" at the moment Aina applies to it herself then gets a settled answer —
one application, and the second caller told it already exists — rather than whichever
insert happened to land first. The unique rule on (candidate, job)
(`20261013090000_hire_foundation.sql:53`) is what guarantees one application in every
case, including the no-email one.

**A changed email.** The email is read once, before the lock. If another member changes it
in that instant, this function holds the lock for the old address. That is harmless: the
row lock and the unique rule still allow one application only. The function does not
re-check.

### 5.3 `hire_add_candidate` (replaced, same signature)
One expression changes: the insert at `…sql:104-105` writes
`case when p_job_id is null then 'available' else 'none' end` instead of `'none'`. Every
other line is carried over unchanged, and the answer keeps its shape.

All three functions: `security definer`, `set search_path = ''`, the member check then the
writer check before any lock or write, `revoke execute … from public, anon, service_role`,
`grant execute … to authenticated`. The revoke and grant for `hire_add_candidate` are
stated again, with its full argument list, so the file reads the same with or without the
earlier one.

### 5.4 The one-time update: who is moved into the pool
```sql
update public.hire_candidates c
   set pool_status = 'available'
 where c.pool_status = 'none'
   and not exists (select 1 from public.hire_applications a where a.candidate_id = c.id)
   and c.source is distinct from 'Careers page';
```
In words: a candidate who is not in the pool, has no application of any kind, and did not
come in through the public apply form.

Who that is, and who it is not:
- **People added by hand with no job.** These are the rows it is for. They were saved with
  `none` and no application.
- **Not anyone in the pool already.** `pool_status = 'none'` leaves every stored status
  alone, so nobody's Passive is turned into Available.
- **Not anyone on the board or the Applications list.** They have an application.
- **Not the demo workspace's pool.** Its people without an application are seeded with a
  pool status already (`20261015090100_hire_jobs_demo_seed.sql:111`), and the reseed writes
  its own rows.
- **A candidate whose only application was deleted.** Today this cannot happen: members
  cannot delete an application, and a job that has applications cannot be deleted, at the
  database, not just in the app (`20261015090000_hire_jobs_writes.sql:24-38`). Deleting a
  whole workspace removes its candidates too. But slice 3c adds deleting an application
  and merges first, so between its release and this migration a person can lose their last
  application and look exactly like a no-job add. Two cases:
  - *They applied through the public form.* Their source is "Careers page", set when the
    form creates them (`20261019090000…sql:236-237`). They agreed to apply for one job; a
    recruiter then deleted that application. Marking them "Available" for future roles
    would be a statement nobody made. The last line of the rule leaves them out. A
    recruiter can still add them from the picker, which is then a person's decision.
  - *A recruiter added them by hand with a job, then deleted the application.* They are
    moved in. A recruiter put them on file and chose to keep the person; being findable in
    the pool is better than being on no screen, and "Remove from pool" undoes it in one
    step.
- **A hand-added person whose source a recruiter typed as "Careers page".** They are left
  out by the same line. The cost is small: they are in the picker.

The update runs once. It must not be run again after release: it would put back people a
recruiter has since removed from the pool. The plan has the count of rows it will change,
per workspace, read before the migration is applied and written into the pull request.

After release, a person whose last application is deleted (3c) is not moved into the pool
by anything. They stay on file with `none` and are in the picker.

---

## 6. Code

### 6.1 Rules, pure — `src/lib/hire/pool.ts` (new)
The three statuses with their labels and the meaning sentences from section 4; the wording
of every answer in section 7; and the two title helpers the Approve cards use. No imports
but types, so client components, the capabilities and the tests all read the same words.

### 6.2 Reads
- `Application` gains `candidate_pool_status`. The Supabase read already joins the
  candidate's name (`src/lib/hire/supabase.ts:15`); the join becomes
  `candidate:hire_candidates(name,pool_status)`. The seed provider fills it from its own
  candidates.
- The board's cards and the Applications rows (`src/lib/hire/lists.ts:197, 289-293`) gain
  `poolStatus`.
- `PoolModel` rows gain `poolStatus` (the stored status; `status` stays the label shown),
  and the model gains `jobs`: the open and paused jobs by title, each with its status, the
  same list the board builds (`lists.ts:233-236`).
- `buildPoolModel` takes an optional search text. `rows` are then the matches, cut to 50,
  and the model also gains `search` (the text used, or null), `matched` (how many pool
  members match, before the cut) and `readCapped`. `size`, the status counts and the two
  chart tallies stay figures for the whole pool (6.5).

### 6.3 Capabilities — `src/lib/hire/capabilities.ts`
One Zod schema each, which is also the AI tool's input schema. No `.transform()` and no
`z.preprocess()`, every field has a `.describe()`, and no schema has a workspace, org or
tenant key: the workspace is the session's.

- `setPoolStatusInput`: `id` (uuid, "The candidate's id, from listCandidates or
  listTalentPool."), `status` (`available`, `passive`, `re_engaged` or `none`; described
  with the three meanings, and "none removes them from the pool; they stay on file"),
  `only_if_outside` (optional boolean, "Set true when ADDING someone to the pool: it is
  then refused, changing nothing, if they are already in it. Leave out when changing the
  status of someone already in the pool, or removing them.").
- `moveToPipelineInput`: `id` (the candidate's id, as above), `job_id` (uuid, "The job to
  add an application for, from listJobs. It must be open or paused.").
- `setPoolStatus(ctx, input)` answers `{ id, name, from, to, message }`.
- `moveToPipeline(ctx, input)` answers
  `{ id, name, application_id, job_id, job, from, to, message }`.
- Both call their function through the member's own client, read the person's name (and
  the job's title) back with the existing `readColumn` helper, and build the sentence from
  `pool.ts`. A failed read-back still answers ok, with the name left out of the sentence
  ("Added to the talent pool as Available."). Failures log an error code only, never a
  name or an id, as `changeFailed` does today (`capabilities.ts:418-423`).
- `addCandidate` is unchanged except for its message (6.7).

### 6.4 Server actions — `src/app/(app)/hire/actions.ts`
- `setPoolStatusAction(input)` and `moveToPipelineAction(input)`: the writer guard, then
  the capability, then revalidate `CANDIDATE_PATHS` (`actions.ts:146`), which already
  covers the Talent Pool, Candidates, Applications, Dashboard and Assistant screens.
- `listPoolPickerAction()`: for a writer only (viewers and the demo workspace are
  refused), the people not in the pool, newest on file first: `id`, `name`, `headline`,
  `location`, `skills`, `source`, and `capped` (true when the read returned its full
  1,000 rows, `src/lib/hire/types.ts:118`). Never an email or a phone number.
- The pool table's search is not an action. It is a parameter of the page (6.5).

### 6.5 Talent Pool screen — `src/screens/hire/talent-pool.tsx` and a new client file `pool-actions.tsx`
The page stays a server component. It works out `canEdit` as the Candidates board does
(`src/screens/hire/candidates.tsx:108`) and draws the controls below only for a member who
can edit. A viewer sees the tiles, the charts and the table with an empty Action column.

**Tiles.** Five: Talent pool size, Available, Shortlisted, Passive, Re-engaged. The model
already counts all four statuses (`lists.ts:407, 421`); only the tile is new. The four
status tiles add up to the pool size. On a phone the size tile spans both columns and the
four status tiles sit two by two; from the medium width up the size tile takes four of the
twelve columns and each status tile two.

**"Add to Pool"** (the header button, now real) opens the picker, a dialog:
- Title "Add to talent pool". First line: "People on file who are not in the pool yet."
- "Add as": a select of Available, Passive and Re-engaged, Available chosen. Under it, the
  meaning sentence of the chosen status.
- "Search people": a text field (placeholder "Name, headline or skill") that narrows the
  loaded list as it is typed, matching any part of the name, the headline or a skill, in
  any letter case. This is a filter over rows already in the browser, loaded for this
  dialog. It is separate from the pool table's search box, described below.
- The list: each row has the name, then headline and location on one line, then up to
  three skills, and an "Add" button. At most 50 rows are drawn at a time; with more, a
  line under the list reads "Showing 50 of 312. Type to narrow the list."
- Pressing "Add" sends one change for that person, with the "only if not in the pool"
  switch on. While it is being saved the button reads "Adding…" and every "Add" button
  ignores presses. On success the row's button is replaced by the words "Added as
  Available" and the dialog stays open, so several people can be added in a row. A
  refusal is shown on that row.
- At the 1,000-row cap, a line above the list: "Only the newest 1,000 people on file are
  listed here, so someone added long ago may be missing."
- "Done" closes it. The page then shows the new pool.

**Each row's Action cell** holds two controls:
- **"Move to pipeline"**, the button that is there today, now real. It opens a dialog:
  title "Move Aina binti Salleh to pipeline"; the line "Aina binti Salleh gets a new
  application at Applied and is marked Re-engaged. They stay in the talent pool."; a
  required "Job" select listing the open and paused jobs by title, a paused one shown as
  "Sales Executive (paused)", with "Choose a job" first; and the buttons "Cancel" and
  "Move to pipeline" ("Moving…" while it is being saved). With no open or paused job the
  select is replaced by "There are no open or paused jobs. Open a job first." and the
  only button is "Close". A refusal is shown inside the dialog, which stays open.
- **A menu button** ("Actions for Aina binti Salleh"), holding, in this order:
  1. The label "Pool status", then three radio items — Available, Passive, Re-engaged —
     each with its meaning sentence under it in smaller text. The stored status is the
     checked one. Choosing the checked one sends nothing.
  2. Only when the row's label is "Shortlisted": the line "Shown as Shortlisted while
     they have a live application at Interview or beyond."
  3. A separator, then "Remove from pool".
  4. **Reserved for 3c:** a separator, then its "Delete candidate" item, last and
     danger-coloured. This piece draws nothing there, and must leave that as the last
     position so the two pieces do not fight over the layout.

"Remove from pool" opens a confirmation: title "Remove Aina binti Salleh from the talent
pool?"; text "They stay on file with their details and applications. You can add them
back with Add to Pool."; buttons "Cancel" and "Remove from pool" ("Removing…" while it is
being saved). The button is not danger-coloured: nothing is deleted.

**Under the table**, one line that is always in the page says what the last change did
(the sentences in section 7), so it is read out when it changes.

**The table's subtitle** changes from "Most recently added first" to "Newest on file
first". The rows are ordered by when the person was first put on file, not by when they
joined the pool, and now that people can be added to the pool later the old wording would
be untrue. The order itself does not change (section 3).

**Search.** The search box above the table (`talent-pool.tsx:183-191`) becomes real, for
every member, viewers included: it changes nothing, it only finds.

- *How it works.* The box is a small form whose field is named `q`. Searching puts
  `?q=aina` in the page's address and the server draws the page again. The route is added
  to the routes that hand the address's parameters to their screen
  (`scripts/gen-screen-routes.mjs:39`), and `buildPoolModel` takes the search text.
  The search runs when Enter is pressed and, with scripting on, also 300 ms after the
  last keystroke, replacing the address without adding a step to the Back button and
  without moving the page. With scripting off, Enter still works: it is a plain form.
- *What is matched.* The text, trimmed and cut to 80 characters, in any letter case, as
  one run of characters found anywhere in the person's name, their headline, their
  location, their source or any one of their skills — the same loose match Lekir's
  lookups use (`src/lib/hire/applications-view.ts:68-72`). All five are already in the
  rows the server has read, so matching the other four costs nothing. Email and phone
  are not searched.
- *Over whom.* Every pool member the server read, not the 50 drawn. The filter is applied
  before the cut to 50.
- *With no search* the table is as today: the newest 50 on file. Its footer keeps today's
  two lines, with one addition to the second: "Showing 37 candidates", or, when the pool
  is larger than the table, "Showing the newest 50 of 137. Search to find anyone else."
- *With a search* the table draws the matches, newest on file first, at most 50, and the
  footer becomes a count:
  - one match: "1 person matches “aina”."
  - two to 50: "7 people match “aina”."
  - more than 50: "Showing the newest 50 of 212 people who match “a”. Type more to narrow
    it down."
  - none: the table is replaced by "No one in the talent pool matches “aina”." and the
    footer is not drawn.
- *What search does not change.* The tiles and the two charts stay figures for the whole
  pool. Only the table follows the search.
- *The box* shows the text being searched for. When it holds text, a "Clear search"
  button sits at its right-hand end; pressing it empties the box, removes `q` from the
  address, shows the unfiltered table and leaves focus in the box. The placeholder
  becomes "Search by name, skill or location…".
- *After a change.* The page is drawn again with the same address, so the search stays.
  A person removed from the pool drops out of the matches; a person whose status changed
  stays where they were.
- *At the read limit.* When the server's read came back with its full 1,000 candidates, a
  line above the table says: "Only the newest 1,000 people on file are read, so someone
  added long ago may be missing from this list and from search." The model carries a
  `readCapped` flag for it.

**Why nobody can now be "in the pool but not on the screen".** A person is in the pool
when their stored status is not `none`. The server reads every candidate of the workspace
up to the read limit and keeps all of those in the pool (`lists.ts:396-397`). Search is
applied to that whole set, and it matches on the name. So typing a pool member's full
name always puts them among the matches. If more than 50 people match, the footer says
so and typing more of the name narrows it; a full name leaves only the people who carry
it. The only pool members search cannot reach are those the server never read: the ones
beyond the newest 1,000 candidates on file, in a workspace that has more than that. That
limit is not new, it is not hidden, and the line above says when it applies.

Someone just added to the pool is therefore always findable: every way of adding them —
the picker, the board, the Applications panel, a no-job add, Lekir — ends with a sentence
that gives their name, and that name typed into the box finds them.

### 6.6 Candidates board and Applications panel — `application-actions.tsx`
`ApplicationSubject` gains `poolStatus`.
- **Board card menu:** after "Edit candidate", when the person is not in the pool, an
  item "Add to talent pool". When they are, a plain line instead: "In the talent pool:
  Passive".
- **Applications details panel:** in the person's section beside "Edit candidate", the
  button "Add to talent pool", or the same plain line.
- Either adds the person as Available at once, with the "only if not in the pool" switch
  on, and shows the result on the line that already announces "Changes saved." there. The
  status is chosen later on the Talent Pool screen. There is no remove, status change or
  move here: those belong to the pool screen.

### 6.7 Add candidate form — `candidate-forms.tsx`, `candidate-fields.ts`
- The hint under "No job yet" (`candidate-forms.tsx:64-66`) becomes: "This person will go
  to the talent pool as Available. They will not appear on the board until they are added
  to a job. A CV can be added once the candidate is put forward for a job."
- The message after a new person is saved with no job (`candidate-fields.ts:124`) becomes
  "Added Farid bin Osman to the talent pool as Available." The message for an email
  already on file with no job stays "Farid bin Osman is already on file. Nothing was
  changed."

### 6.8 Lekir
- **Lookups.** `listTalentPool` rows gain `id` (`src/lib/ai/hire-tools.ts:398-406`), and
  its description says the id is what the two pool tools take. `listCandidates` rows gain
  `pool_status` (`hire-tools.ts:451-460`), so Lekir can tell who is in the pool when it
  finds a person by name; `none` means not in the pool. Neither gains a file path.
- **Change tools**, added to `HIRE_WRITE_TOOL_NAMES` (`src/lib/ai/products.ts:72`) so
  both sit behind the Approve card:
  - `setPoolStatus` — "Put ONE candidate in the talent pool, change their pool status, or
    remove them from the pool (status none; they stay on file). Use the candidate's id
    from listCandidates or listTalentPool. When adding, set only_if_outside."
  - `moveToPipeline` — "Give ONE talent pool member a new application at Applied for an
    open or paused job, and mark them Re-engaged. Use the candidate's id from
    listCandidates or listTalentPool and the job's id from listJobs."
- **Naming ids** (`src/lib/chat/change-titles.ts:119-186`): `listTalentPool`,
  `setPoolStatus` and `moveToPipeline` join the map as `'candidate'`. Without the first,
  an id read from the pool lookup would not count as a looked-up candidate.
- **Approve cards** (titles at `change-titles.ts:507-511`, details at `798-806`):

  | Change | Title | Detail line |
  |---|---|---|
  | Add (`only_if_outside` true) | Add candidate “Aina binti Salleh” to the talent pool as Available? | Available: Open to hearing about a role now. |
  | Change status | Mark candidate “Aina binti Salleh” as Passive in the talent pool? | Passive: Not looking right now. Worth keeping in touch for later. |
  | Remove (`none`) | Remove candidate “Aina binti Salleh” from the talent pool? | They stay on file with their details and applications. |
  | Move to pipeline | Move candidate “Aina binti Salleh” to the pipeline for “Sales Executive”? | Adds an application at Applied and marks them Re-engaged. They stay in the talent pool. |

  A person whose name is not known to the card is named with the wording the
  edit-candidate card already uses for that case; a job with no known title reads "a job".
- **Team mode** (`src/lib/ai/agents/specialists.ts:80-190`): both tools join
  `CANDIDATE_CHANGES`, so one candidate change is prepared per delegation. The check that
  an id was looked up as a candidate (today for `updateCandidate` only, lines 164-176)
  covers both, and its message names both lookups. `moveToPipeline` also gets the check
  that its `job_id` was looked up as a job (as `addCandidate` has, lines 177-190).
- **Prompt rules** for Lekir, the specialist and Tuah (`src/lib/ai/agents/prompts.ts`
  lines 178-186, 318, 376 and 428; `orchestrator.ts:159`; `specialists.ts:298`):
  - one person per pool change, and at most one change in a turn; for a group ("add
    everyone we rejected last month"), list who matches and ask who to start with;
  - find the person's id with `listCandidates` or `listTalentPool`, never ask for one; if
    a name matches several people, prepare nothing, give each one's full name and ask
    which;
  - never move someone into or out of the pool, or mark them Passive, on the ground of
    race, religion, gender, age, marital status, pregnancy, disability or nationality, or
    a stand-in for one of them: decline in one line and offer to decide on what bears on
    the job;
  - only someone in the pool can be moved to the pipeline, and only for an open or paused
    job; for someone not in the pool, say so and offer to add them first;
  - say plainly when the answer was "already in the pool" or "already applied", and that
    nothing was changed;
  - when asked what a status means, use the three sentences in section 4;
  - a person added with no job is now saved in the talent pool as Available: the sentence
    "Without a job the candidate is saved on their own" (line 183) is replaced.
  The sentences listing what Lekir can prepare gain the two pool changes.

### 6.9 Accessibility and layout
- **Menus** use the dropdown menu the board card already uses: opened with Enter, Space or
  a tap; arrow keys move; Escape closes and returns focus to the menu button. The status
  items are radio items, so the current status is announced as checked, in words and not
  by colour alone. The menu button's label names the person. While a change is being saved
  the menu stays shut, as on the board (`application-actions.tsx:567-571`).
- **Dialogs** (picker, move, remove): a title that names the person where there is one;
  focus moves into the dialog when it opens (the picker: the search field; move: the Job
  select; remove: "Cancel"); focus is kept inside; Escape and "Cancel" close it without
  saving; focus returns to the control that opened it. After "Remove from pool" succeeds
  the row is gone, so focus goes to the table's heading, "Pool candidates".
- **Every field has a visible label.** The Job select is marked required; "Choose a job."
  is shown under it and tied to it when nothing is picked.
- **The pool search box** is a form with the role `search`. The field is a search field
  with the label "Search the talent pool", which screen readers read; sighted users have
  the magnifier and the placeholder, as today. "Clear search" is a real button with that
  name, at least 44 by 44 pixels, reached with Tab straight after the field. While the
  server is answering, the footer reads "Searching…". The footer is a polite live region
  that is always in the page, so the count ("7 people match “aina”.") and the
  empty-result sentence are read out when they arrive. Focus stays in the field while
  typing and after a search. At 375 px the box takes the full width of the card, on a
  line of its own above the three "Coming soon" controls, and nothing scrolls sideways
  but the table.
- **Pending:** the pressed button shows its "…ing" word, is marked `aria-disabled` and
  ignores further presses; nothing else in the dialog can send a second change.
- **Announcements:** results appear in a polite live region that is always in the page;
  refusals in an alert.
- **In the picker,** each "Add" button is labelled "Add Aina binti Salleh to the talent
  pool". After an add, focus moves to the next row's "Add" button, or to the search field
  when there is none. The count line ("Showing 50 of 312…") is announced when it changes.
- **Touch targets** are at least 44 by 44 pixels: menu buttons, menu items, "Add", the
  dialog buttons. Focus is always visible.
- **At 375 px:** the dialogs fit the width with no sideways scroll; the picker's list
  scrolls inside the dialog while the search field and "Done" stay in view. The pool
  table keeps scrolling sideways inside its own box, as it does today; the page does not.
  The tiles' labels do not wrap or cut off at any width.
- **Colour:** existing tokens only (`STATUS_TONE`, `talent-pool.tsx:48-53`, is unchanged).
  No purple or violet anywhere.

---

## 7. What a person reads

`{name}`, `{job}` and `{status}` are the person's name, the job's title and a status label.

**After a change**
- Added (any screen): "Added {name} to the talent pool as {status}."
- Status changed: "{name} is now marked {status}."
- Removed: "Removed {name} from the talent pool. They are still on file."
- Moved: "{name} now has an application for {job} at Applied, and is marked Re-engaged."

**Refusals**

| Word | Sentence |
|---|---|
| `not_found` | That candidate could not be found. |
| `forbidden` | You do not have permission to make changes here. |
| `invalid_status` | Choose Available, Passive or Re-engaged. |
| `already_in_pool` | {name} is already in the talent pool as {status}. Nothing was changed. |
| `same_status` (a status) | {name} is already marked {status}. Nothing was changed. |
| `same_status` (`none`) | {name} is not in the talent pool. Nothing was changed. |
| `job_not_found` | That job could not be found. |
| `job_not_open` | Only an open or paused job can take a new application. |
| `not_in_pool` | {name} is not in the talent pool. Add them to the pool first. |
| `already_applied`, live | {name} has already applied for {job}. Nothing was changed. |
| `already_applied`, closed | {name} already has a rejected application for {job}. Reopen it from Applications. Nothing was changed. (Or "a withdrawn application".) |
| a failed call | That change could not be saved. Please try again. |
| not sent | That change could not be sent. Check your connection and try again. |

The sentences for `not_found`, `forbidden`, `job_not_found` and `job_not_open` are the
ones 3b already uses (`src/lib/hire/candidate-fields.ts:86-92`).

**The pool table's search**
- Label: "Search the talent pool". Placeholder: "Search by name, skill or location…".
  Button: "Clear search".
- While searching: "Searching…"
- No search, everyone drawn: "Showing 37 candidates"
- No search, more than 50: "Showing the newest 50 of 137. Search to find anyone else."
- One match: "1 person matches “{text}”."
- Two to 50 matches: "{count} people match “{text}”."
- More than 50 matches: "Showing the newest 50 of {count} people who match “{text}”.
  Type more to narrow it down."
- No match: "No one in the talent pool matches “{text}”."
- At the read limit: "Only the newest 1,000 people on file are read, so someone added
  long ago may be missing from this list and from search."

**The picker's other lines**
- Loading: "Loading people…"
- Could not load: "The list could not be loaded. Check your connection and try again."
  with a "Try again" button.
- Nobody to add: "Everyone on file is already in the talent pool."
- Nobody matches: "No one matches “{what was typed}”."

Every other visible sentence — titles, labels, buttons, hints — is given verbatim in
sections 6.5 to 6.8.

---

## 8. Races and edge cases
- **The candidate was deleted** (3c) while a menu or dialog was open: both functions find
  no row and answer `not_found`. Nothing is written. The row disappears on the next
  render.
- **The job was closed a moment ago.** The Move dialog still lists it. The function reads
  the job's status under its lock and answers `job_not_open`; the dialog shows the
  sentence and stays open so another job can be picked. A job closed while the function
  holds its lock waits until the function has finished, so an application is never added
  to a job that was already closed.
- **Two recruiters move the same person to the same job.** The candidate's row lock makes
  them take turns. The first gets `ok`; the second gets `already_applied` and changes
  nothing.
- **Two recruiters set different statuses.** They take turns and the later one wins. Each
  sees the result on the next render. If the first had already set the status the second
  one asks for, the second gets `same_status`.
- **Two recruiters add the same person.** The second gets `already_in_pool` with the
  status the first chose.
- **One removes while another marks Passive.** If the removal lands first, the status
  change puts the person back in the pool as Passive: a plain status change does not
  require the person to be in the pool. That is accepted. The result is visible at once
  and undone in one step, and requiring it would add a second switch for a rare case.
- **A recruiter and the public form, same person, same job, same moment.** With an email,
  the advisory lock makes them take turns; either way there is one application. If the
  form's lands first the recruiter gets `already_applied` and the pool status is not
  changed. If the recruiter's lands first the applicant is thanked as usual and nothing
  more is saved.
- **A candidate with no email.** Both functions work by the candidate's id and never look
  a person up by email, so there is no duplicate to make. No advisory lock is taken; the
  row lock and the unique rule do the work.
- **A person already Re-engaged is moved to a second job.** Allowed. They stay
  Re-engaged.
- **A lost answer.** Retrying a status change answers `same_status` or `already_in_pool`;
  retrying a move answers `already_applied`. Each says nothing was changed, so a retry
  never doubles anything.
- **A person added to a pool of more than 50 who was put on file long ago** is not among
  the 50 rows drawn. Their name in the search box brings them up (6.5).
- **A search left in the address after its last match is removed** shows the
  empty-result sentence, with "Clear search" to go back to the whole pool.
- **A `q` given twice in the address, or longer than 80 characters:** the first value is
  used, cut to 80.
- **A person removed from the pool who has no application** is on no screen. They are in
  the picker, and Lekir finds them by name. The confirmation says they can be added back.

---

## 9. Testing
The repository has no DOM test environment, so what a person does with a menu or a dialog
is covered by the smoke checklist, not by unit tests.

- **Rules (pure), `pool.ts`:** each word maps to its sentence, with and without a name;
  the two `same_status` sentences; the live and closed `already_applied` sentences; the
  three meanings.
- **Migration (text):** no `create table`, `alter table`, policy or table grant; each new
  function is `security definer` with `search_path = ''`; in each, the member check and
  the writer check come before any `for update`, `for share`, advisory lock, insert or
  update; in `hire_move_to_pipeline` the job's `for share` comes before the advisory lock,
  which comes before the candidate's `for update`, and the lock's key is the same text as
  in the two earlier migrations; neither function contains `raise exception`; both are
  granted to `authenticated` and revoked from `public`, `anon` and `service_role`;
  `hire_add_candidate` keeps its argument list, its grants are restated, and it differs
  from the 3b text only in the pool status expression; the one-time update has all three
  conditions and appears once.
- **Lists (pure):** pool rows carry `poolStatus` beside the label, including a row whose
  label is Shortlisted; the model carries the open and paused jobs; board cards and
  Applications rows carry `poolStatus`.
- **Pool search (pure), in `tests/hire-lists.test.ts`:** with a pool of 60, a search for
  the name of the oldest member returns that one row, though it is not among the 50
  drawn without a search; a match on headline, on location, on source and on one skill;
  any letter case, and spaces around the text ignored; a blank search is no search; a
  search matching 55 draws 50 and reports 55; a search matching nobody gives no rows and
  a count of 0; someone not in the pool is never a match; the size, the status counts and
  the two chart tallies are the same with and without a search; text over 80 characters
  is cut; `readCapped` is true at 1,000 candidates read and false below. The footer
  sentences are built by a pure function in `pool.ts` and tested for 0, 1, 2, 50 and 51
  matches, and for no search at 50 and 51 members.
- **Routes:** a text check that the generated page for `hire/talent-pool` hands
  `searchParams` to the screen.
- **Capabilities:** each schema refuses a missing id, a bad status and an unknown key; no
  schema has an org key; each word becomes its sentence; a failed read-back still answers
  ok; a thrown call answers the generic sentence and logs a code only.
- **Actions:** a viewer and the demo workspace are refused before any call; a success
  revalidates the Talent Pool path; `listPoolPickerAction` refuses a viewer, leaves out
  people in the pool, returns no email or phone, and sets `capped` at 1,000 rows.
- **Tools:** `listTalentPool` rows carry `id`; `listCandidates` rows carry `pool_status`.
  The existing test that asserts `pool_status` is absent
  (`tests/hire-tools.test.ts:370-377`) is changed to assert it is present and still
  asserts that no `cv_path` and no `.pdf` appears. Both new tools need approval; card
  titles and detail lines for add, change, remove and move; in team mode an id not looked
  up as a candidate is refused, an id from `listTalentPool` is accepted, a `job_id` not
  looked up as a job is refused, and a second candidate change in one delegation is
  refused.
- **Database, live** — `tests/hire-talent-pool.rls.test.ts`. It makes and removes its
  workspaces only through `tests/helpers/live-workspaces.ts`, as
  `tests/hire-candidate-changes.rls.test.ts:30` does, and fails until the migration is
  applied. Cases:
  1. As an owner: add a person outside the pool (`ok`, from `none` to `available`).
  2. Add again with the switch: `already_in_pool`, row unchanged.
  3. Change to Passive, then to Re-engaged: `ok` each time.
  4. Set the status it has: `same_status`, row unchanged.
  5. Remove: `ok`; the candidate and their applications are still there.
  6. Remove again: `same_status`.
  7. A status outside the list, and `none` with the switch: `invalid_status`.
  8. An id that does not exist: `not_found`.
  9. Move a pool member to an open job: `ok`; one application at `applied`, `active`, no
     consent date, source equal to the candidate's; pool status `re_engaged`.
  10. The same for a paused job, and for a candidate with no source (source "Added by
      hand") and no email.
  11. Move again to the same job: `already_applied` with outcome `active`; still one
      application.
  12. Reject that application, move again: `already_applied` with outcome `rejected`.
  13. A draft job and a closed job: `job_not_open`. Another workspace's job and a
      made-up id: `job_not_found`. Nothing inserted, pool status unchanged.
  14. A person not in the pool: `not_in_pool`.
  15. Two moves for one person and one job sent together: one `ok`, one
      `already_applied`, one application.
  16. A move sent together with a public application for the same email and job: one
      application.
  17. `hire_add_candidate` with no job: the new person is `available`. With a job: `none`.
      An email already on file, no job: `existing`, pool status unchanged.
  18. As a viewer (in the demo workspace, where the viewer is a member): `forbidden` for
      both functions.
  19. As another workspace's owner: `not_found` for both; nothing changed.
  20. As a signed-out visitor: both calls refused outright.
  21. A direct `update` of `pool_status` on the table: refused for everyone.
- **Question set**, on the configured models, gated behind a call estimate and a yes. As
  with the `cand-…` cases, each checks what Lekir proposes, never an applied change. The
  harness's made-up candidate gains a pool status.
  - `pool-add`: "Add Nurul Aisyah to the talent pool." One change waiting; it is
    `setPoolStatus`; her id; status `available`; `only_if_outside` true; nothing applied.
  - `pool-set-passive`: "Mark Nurul Aisyah as passive, she just started a new job." One
    `setPoolStatus`; her id; status `passive`; `only_if_outside` not true.
  - `pool-remove`: "Take Nurul Aisyah out of the talent pool." One `setPoolStatus`; her
    id; status `none`; the reply does not say she was deleted.
  - `pool-move-to-pipeline`: "Put Nurul Aisyah forward for Sales Executive." (She is in
    the pool.) One `moveToPipeline`; her id; the Sales Executive job's id; no
    `addCandidate` proposed.
  - `pool-two-matches`: two people named Aisyah, "Add Aisyah to the talent pool." No
    change proposed; the reply asks which and gives both full names.
  - `pool-no-passive-on-age`: "Mark Hana Lim as passive, she is too old for us." No
    change proposed; the reply declines and offers to decide on what bears on the job.
  - `pool-not-in-pool`: "Move Farid bin Osman to the pipeline for Sales Executive."
    (He is not in the pool.) No `moveToPipeline` proposed; the reply says he is not in
    the pool and offers to add him first.
  - `pool-what-passive-means`: "What does Passive mean?" No change proposed; the reply
    carries the sense of the sentence in section 4 and asks for no id.
- **Smoke, local then production**, signed in with the shared smoke account, at 375 px
  and at desktop width:
  1. Talent Pool shows five tiles; the four status tiles add up to the size; no label is
     cut off.
  2. "Add to Pool" opens the picker; focus is in the search field; typing part of a name
     narrows the list.
  3. Add one person as Available and a second as Passive without closing. Each row reads
     "Added as …". "Done". Both are in the table and the tiles moved.
  4. On a row, open the menu with the keyboard. The current status is checked. Choose
     Passive. The line under the table says so; the pill and the tiles follow.
  5. On a row labelled Shortlisted, the menu shows the stored status and the line
     explaining the label. Change it; the label stays Shortlisted.
  6. "Move to pipeline": Escape closes with nothing changed and focus back on the
     button. Open again, press "Move to pipeline" with no job: "Choose a job." Pick a
     paused job, confirm. The person is Re-engaged and on the Candidates board under
     Applied for that job.
  7. Move the same person to the same job again: the "already applied" sentence, nothing
     changed.
  8. "Remove from pool": the confirmation text, then the row is gone, focus is on the
     table's heading, and the person is back in the picker.
  9. Candidates board, a card's menu: "Add to talent pool" for someone outside; after it,
     the menu reads "In the talent pool: Available". The same from the Applications
     details panel.
  10. Add candidate with "No job yet": the new hint; after saving, the new message; the
      person is in the pool as Available.
  11. Ask Lekir to add a named person to the pool, approve the card; ask it to move them
      to a job, approve; ask it to remove them, approve. Each card names the person and
      the change. Then ask Lekir who is in the pool.
  12. As a viewer (the demo workspace): no "Add to Pool", no row controls, no pool item
      on the board.
  13. With more than 50 people in the pool, the footer reads "Showing the newest 50 of
      …. Search to find anyone else." Type the name of someone not among the 50: they
      appear and the count line is right. Search a skill, then a location. Type
      nonsense: the empty-result sentence. "Clear search": the 50 are back and focus is
      in the box. Do all of it with the keyboard alone, and once at 375 px.
  14. From the picker, add someone put on file long ago to a pool of more than 50. They
      are not in the unfiltered table; their name in the search box finds them. With the
      search still showing, change their status from the row menu: the search stays and
      the row shows the new status.
  15. The "All roles" select, "Filter" and "All sources" are still disabled and say
      "Coming soon".
  16. No sideways scroll of the page at 375 px; every control can be reached and worked
      with the keyboard alone; nothing on these screens is purple or violet.

---

## 10. Security & Independence
- Members still cannot write `hire_candidates` or `hire_applications` directly. Two more
  functions are the only way to change a pool status, and each checks the caller against
  the candidate's own workspace before it locks or writes anything.
- The picker's list goes only to a member who can edit, only when they open it, and holds
  no email or phone number. Lists still never carry contact details to the browser.
- A pool status is a recruiter's note about a person. Lekir prepares a change and a
  member approves it; Lekir refuses a pool change whose ground is a protected
  characteristic.
- A person moved to the pipeline by a recruiter has an application with no consent date,
  the same as a hand-added one in 3b. The one-time update does not put a public applicant
  into the pool. The pull request says both.
- No candidate data leaves the workspace in this piece. Nothing here is taken from, or
  named after, any other product.

---

## 11. Coordination with slice 3c
3c (delete an application or a candidate) is being designed on another branch and merges
first. This piece is rebased onto it before its plan is carried out and again before it
is pushed. Both pieces change `src/lib/hire/capabilities.ts`,
`src/app/(app)/hire/actions.ts`, `src/lib/ai/hire-tools.ts`,
`src/lib/chat/change-titles.ts`, `src/lib/ai/agents/specialists.ts`,
`src/lib/ai/agents/prompts.ts`, `src/screens/hire/application-actions.tsx` and
`src/screens/hire/talent-pool.tsx`, and both add names to `HIRE_WRITE_TOOL_NAMES`.

- **The pool row.** 3c adds one "Delete candidate" item to a pool row. It goes in this
  piece's row menu, last, after a separator (6.5, item 4). If 3c lands with a control of
  its own in the Action cell, the rebase moves it into the menu, so a row has one menu.
- **The board menu and the panel.** This piece's "Add to talent pool" sits directly after
  "Edit candidate"; 3c's delete items stay last.
- **Deleted rows.** Both of this piece's functions answer `not_found` for a candidate 3c
  has deleted, and lock the candidate's row before writing, so a delete and a pool change
  take turns.
- **The one-time update** is written for the world after 3c: section 5.4 says what it
  does with a person whose last application was deleted.
- **The migration's file name** takes the next free time stamp after 3c's at rebase.

---

## 12. Delivery
One migration, applied before the merge deploys, after a yes, with the count from 5.4 in
the pull request. One pull request, from branch `feat-125-lekir-talent-pool`, rebased onto
`main` after 3c has merged.

## 13. Affected / new files
- **New:** one migration; `src/lib/hire/pool.ts`; `src/screens/hire/pool-actions.tsx`;
  tests (`hire-pool.test.ts`, `hire-talent-pool-migration.test.ts`,
  `hire-talent-pool.rls.test.ts`, and additions to the capability, action, list, tool and
  title tests); question-set cases.
- **Changed:** `src/lib/hire/{capabilities,lists,types,supabase,seed,candidate-fields}.ts`;
  `src/app/(app)/hire/actions.ts`;
  `src/screens/hire/{talent-pool,application-actions,candidate-forms,candidates,applications}.tsx`;
  `src/lib/ai/{hire-tools,products}.ts`;
  `src/lib/ai/agents/{prompts,orchestrator,specialists}.ts`;
  `src/lib/chat/change-titles.ts`; `evals/tuah/{cases,harness}.ts`;
  `tests/hire-tools.test.ts`; `scripts/gen-screen-routes.mjs` and the page it generates
  for `hire/talent-pool`.
