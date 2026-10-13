# Kasturi CRM backend spine

This slice turns Kasturi from a screen-only CRM shell into a database-ready module.

## Scope

Tables added:

- `crm_pipelines`
- `crm_pipeline_stages`
- `crm_contacts`
- `crm_deals`
- `crm_activities`
- `crm_notes`
- `crm_attachments`
- `crm_audit_logs`

## Workflow covered

1. A user belongs to an organisation through `org_members`.
2. The organisation owns pipelines and stages.
3. Contacts belong to the organisation.
4. Deals belong to contacts, pipelines and stages.
5. Activities, notes and attachments can sit on a contact or a deal.
6. Audit logs record important CRM changes.

## How the tables map to the Kasturi pages

The columns follow what the screens already show.

| Page | Backed by | Notes |
|---|---|---|
| Contacts | `crm_contacts` | `first_name`, `last_name`, `company`, `email`, `phone`, `country`, `status`, `lead_score`, `last_interaction_at`. The person in charge is `owner_user_id`; the display name comes from `profiles.full_name`. |
| Contacts: follow-ups | `crm_activities` | A follow-up is an activity of `type = 'task'` on a contact, with a `title` and an optional `due_at`. Marking it done sets `completed_at`. The page lists the open ones under each contact. |
| Deals | `crm_deals`, `crm_pipelines`, `crm_pipeline_stages` | A board column is a stage of the selected pipeline, in `position` order, empty ones included. A card shows the contact's `company`, `title`, `value_cents`, `tag`, the owner (`owner_user_id`, named from `profiles` like a contact's person in charge), `last_activity_at` and `expected_close_date`. People who can write add, edit, move (by dragging or from the card's menu), mark as lost, reopen and delete deals from the page, create, rename and delete pipelines, and add, edit (name and win chance), reorder and remove a pipeline's stages. |
| Overview, Reports | read from the tables above | No tables of their own. |
| Appointments, Calendar | `appointments` (Jebat foundation) | Already on `main`; Kasturi should read the same table and not add a second one. |
| Lead Forms, Broadcast, AI Chatbot, Automations, Landing Page, Billings, Plugins, Settings, AI Agents | not in this slice | Each gets its own table when its page is wired up. |

Money is stored in cents (`value_cents bigint`), the same as `campaigns.spend_cents`.

Contact `status` values are `lead`, `contacted`, `qualified`, `customer` and `archived`. The screen labels them New Leads, Contacted, Qualified and Customer.

## How the Contacts page finds and filters

The page loads the 500 most recent contacts and their open follow-ups. Views, search, the lead score, person-in-charge, country and tag filters, and the follow-up filter all run in the browser over those rows (`src/lib/crm/contact-filters.ts`). This keeps the page quick while each database call is slow, and it works on the sample screens too.

It stops being enough once a workspace has more than 500 contacts. The next step is to move search and filtering into the database with paging, backed by indexes: a trigram or full-text index for search, a GIN index on `tags`, and composite indexes on `(org_id, status)` and `(org_id, created_at)`.

Import reads a CSV or Excel (`.xlsx`) file in the browser, lets the person match columns to fields, and sends only the matched columns. The server validates every row again, skips rows whose email is already in the workspace, and inserts the rest (`src/lib/crm/import.ts`). One file can bring in up to 500 rows.

## How the Deals page works

**Pipeline.** A workspace needs a pipeline before it can hold deals. The first time someone who can write opens the page in a workspace with none, the page creates "Sales pipeline" (`is_default`) with the stages Lead (10%), Qualified (30%), Proposal (50%), Negotiation (70%) and Won (100%) (`ensureDefaultPipeline` in `src/lib/crm/pipelines.ts`). Two tabs doing this at once is safe: a unique violation means the other one got there first. If it fails the page still loads and says so. A viewer in a workspace with no pipeline sees an explanation and no board.

**More pipelines.** People who can write get a "Manage pipelines" button beside the pipeline select. It opens a card that lists every pipeline with its stages, its number of loaded deals and a "Default" marker, and offers (`src/lib/crm/pipelines.ts`, `src/screens/crm/deal-pipelines.tsx`):

- New pipeline: a name (required, unique in the workspace, at most 60 characters) and its stages as one line of names separated by commas, prefilled with the starting five. Two to twelve stages, each 1 to 30 characters, no repeats ignoring capitals. Positions follow the order typed. Probabilities are spread evenly and end at 100 (five stages get 20, 40, 60, 80, 100); this one rule applies whatever the names, so a new pipeline with the starting names does not get the starting pipeline's 10 to 100. The pipeline is inserted first and its stages second, in one statement; if the stages fail the pipeline is deleted again. The board then switches to the new pipeline.
- Rename. A name already in use (Postgres `23505`) becomes "Another pipeline already uses that name."
- Make default. Nothing in the database limits a workspace to one default, so this is two updates: the chosen pipeline is marked first, the others are cleared second. A failure in between leaves two defaults, never none; the page then opens on the older of the two, the card marks only that one, and Make default on the other puts it right.
- Delete, after a confirmation in the card. Refused for the last pipeline and for one that still has deals: the card says so from the loaded deals, the write counts the pipeline's deals itself, and a foreign-key error from a deal added meanwhile (`23503`) becomes the same message. Deleting the default first makes the oldest other pipeline the default, and undoes that if the delete fails. Stages go with their pipeline through the table's cascade.
- Edit stages, which opens that pipeline's stages in the card (one pipeline at a time; `src/screens/crm/deal-stages.tsx`). Every change shows on the board as soon as it is saved, whatever search or filter is on.
  - Add: a name, 1 to 30 characters, not used in the pipeline whatever its capitals. The new stage goes just before the stage named Won when there is one, so Won stays the end of the pipeline, and last otherwise. At most twelve stages.
  - Edit: the stage's name and its "Win chance (%)" in one form, prefilled (`updateCrmPipelineStage`). The name follows the same rule: the database only refuses an exact duplicate, so other capitals are checked in the app first, and a unique violation (`23505`) becomes "Another stage in this pipeline already uses that name." The win chance is a whole number from 0 to 100 (`parseStageProbability`), checked in the form before it is sent and again by the write. Only what changed is written; with nothing changed, nothing is.
  - Move up and Move down: buttons, so they work from the keyboard and on touch screens. Moving the first stage up or the last one down does nothing.
  - Remove, after a confirmation in the card. Refused when the pipeline would be left with fewer than two stages, and when the stage still has deals (lost ones included): the card says so from the loaded deals, the write counts the stage's deals itself, and the foreign-key error from a deal it did not see (`23503`) becomes the same message.

**Stages named Won.** "Won" is recognised by name (`isWonStage`, any capitals), not by a column. Renaming the Won stage to something else, or removing it, means moving a deal in that pipeline no longer marks it as won; renaming another stage to Won gives that stage the behaviour. None of this is blocked, the card says so in one line under the edit form's fields and in the remove confirmation, and two stages can never both be called Won because names are unique ignoring capitals. Deals are not rewritten: a deal already won keeps its status, and a deal already sitting in a stage that is renamed to Won stays as it was.

**Stage probabilities.** A stage's probability belongs to the stage and travels with it: reordering and removing change positions only and never write `probability_percent`, so the starting pipeline's 10, 30, 50, 70, 100 stay with their stages. A new stage starts at the rounded midpoint between its neighbours where it lands (`newStageProbability`: between 70 and 100 it gets 85; with no stage after it, halfway to 100; with none before it, half of the next one's), and from then on it is whatever is typed into Edit. Nothing compares probabilities across stages, so they may be out of order, and only a brand-new pipeline gets the even spread (`stageProbabilities`).

**How stage positions are written.** The table allows one stage per position in a pipeline, checked row by row, and the app's writes are separate statements with no transaction around them, so two stages cannot simply swap numbers. `renumberStages` in `src/lib/crm/pipelines.ts` therefore works in two passes over the stages from the first one that has to move: it parks them above the highest position in use (last stage first, keeping their order), then settles each on its final position (first stage first). Stages before that point are not written at all, and no probability is written by any of this. Every step leaves a valid list. If a write fails part-way, sorting by position (which is all the page ever does with it) still gives the old order or, for a move of one stage past its neighbour, the new one; positions may be left with gaps or high numbers, and the next successful add, remove or move numbers them 1, 2, 3 again, because these functions work from a stage's place in the sorted list and never from the stored number. Adding inserts the new stage after the last one and then renumbers; if the renumbering fails the stage exists at the end and the message says the order may not be right. Removing deletes the stage and then closes the gap; if closing the gap fails the removal still counts and it is only logged. A stage action that fails reloads the page's data too, so what is shown is what was left.

Not guarded by the database, only by the app's checks, so two people editing the same pipeline's stages at the same moment can get past them: the two-stage minimum, the twelve-stage maximum, and names differing only in capitals.

**Dragging.** People who can write can drag a card to another stage column (the browser's own drag and drop, no library). The column under the card is highlighted; dropping on the card's own column does nothing. The move goes through the same action as "Move to", so the status rules below apply unchanged. The card shows in its new column at once (`useOptimistic` over the loaded deals, computed by `applyDealMove` in `src/lib/crm/deal-board.ts` with the same status rule as the write) and the page's fresh deals take over when the server answers. If the move fails the card goes back and shows the message. A card cannot be dragged by its "⋯" button, while it has a move on its way, or while a confirmation has taken its place. Drag and drop does not work on touch screens or from the keyboard: "Move to" in the card's menu is the way there, and it behaves as before (the card stays put and says "Moving…" until the server answers).

**Status and stage.** A deal's `status` (`open`, `won`, `lost`) is separate from its stage.

- Moving a deal into the stage named "Won" (any capitals) sets `status = 'won'` and `won_at`. This also applies when the edit form changes the stage, and when a deal is added straight into Won.
- Moving a won deal to any other stage sets it back to `open` and clears `won_at`.
- Mark as lost sets `status = 'lost'`, `lost_at` and an optional `lost_reason` (at most 200 characters), and clears `won_at`. The deal stays in its stage.
- Reopen clears `lost_at` and `lost_reason` and sets the deal back to `open`. A lost deal that sits in the Won stage becomes `won` again, so no open deal sits in Won.
- A lost deal moved between other stages stays lost; moved into Won it is won.

**Writes.** Every write is scoped by `id` and `org_id` and sets `updated_at` and `last_activity_at`. A new deal's `pipeline_id` is read from the stage that was chosen, never taken from the form, and its creator becomes `owner_user_id`. A stage from another pipeline is refused. A contact or stage deleted meanwhile (Postgres `23503`) becomes a message beside the form. Deleting a deal also deletes its activities, notes and attachment rows, through the tables' cascades. Value is typed in ringgit and stored in cents.

**What the page loads.** The pipelines with their stages, the 500 most recent deals across every pipeline, and up to 1,000 contacts for the form's contact select. Switching pipeline, search (title, company, contact name, tag, owner), the owner filter and the status view (Open and won by default, which hides only lost deals; then Open, Won, Lost, All deals) all run in the browser over those deals (`src/lib/crm/deal-filters.ts`). Past 500 deals the page says how many it covers; the next step is the same as for Contacts, moving filtering into the database.

**Figures.** All computed from the loaded deals of the selected pipeline, not narrowed by search, owner or status view (`src/lib/crm/deal-stats.ts`): pipeline value, open deals and average deal size count open deals; win rate is won ÷ (won + lost). "Deals created vs won" covers the last eight weeks from `created_at` and `won_at`, a week being seven days ending today. The Daily Report shows deals created today, deals won today and their value, open pipeline value, and open deals whose `expected_close_date` falls within the next seven days. "Today" is the calendar day in Asia/Kuala_Lumpur.

## Consistency rules

- Deals, activities, notes and attachments reference their contact or deal by `(id, org_id)`, so a row cannot point at another workspace's record.
- A deal references its stage by `(stage_id, pipeline_id)`, so the stage always belongs to the deal's pipeline.

## Access rule

All CRM records are scoped by `org_id`.

- Org members can read.
- Org writers can create, update and delete.
- Audit logs are insert and read only, and `actor_user_id` must be the signed-in user.
- Every table carries the restrictive `mfa_required` policy and explicit grants to `authenticated`, the same shape as the Jebat foundation migration. `anon` has no access.

The migration reuses the private tenancy helper functions:

- `private.is_org_member(org_id)`
- `private.is_org_writer(org_id)`

## Public lead forms

A lead form (`public.forms`, shown at `/reach/lead-forms` and `/crm/lead-forms`) has a public page while it is active. Migration: `20261012110000_reach_form_submissions.sql`.

### The link

`/f/<form id>`: the form's uuid. A workspace has no public identifier of its own (`orgs.slug` is empty for every workspace except the demo), so the link does not name the workspace, and a form's slug is not part of it. The Lead Forms table shows the full link for an active form, with Copy link and Open; a draft or paused form shows "Activate this form to get its link."

The page sits outside the signed-in app (`src/app/f/[formId]/`). Nothing gates it: the proxy only refreshes a session, and sign-in is enforced by the app layouts, which this route is not under. It is marked `noindex, nofollow`.

| The form is | The page shows |
| --- | --- |
| active | The workspace's display name, the form's name, and the fields |
| draft or paused | "This form is not accepting responses." and no names |
| in the demo workspace | The same as a draft: the demo never takes public submissions |
| unknown, or the link is not a form id | 404 |

### What a visitor can reach

A visitor is not signed in and has no grant on `forms`, `form_submissions` or `crm_contacts`. Everything goes through three `SECURITY DEFINER` functions with an empty, pinned `search_path`, executable by `anon` and `authenticated` only:

| Function | Answers with |
| --- | --- |
| `get_public_form(p_form_id uuid)` | `(form_name, org_name, accepting)`. No row for an unknown id. Both names are null unless the form is accepting. |
| `record_form_view(p_form_id uuid)` | Nothing. Adds one to `views_count` for an active form, unless the caller is a signed-in member of the form's workspace. |
| `submit_public_form(p_form_id uuid, p_name text, p_email text, p_phone text, p_message text, p_honeypot text)` | One word: `ok`, `not_found`, `closed`, `throttled`, or which field was refused. Never an id, and the same `ok` whether the email was new or already a contact. |

### What a submission does

Every form asks for the same four fields: name and email (required), phone and message (optional). In one transaction, `submit_public_form`:

1. Returns `ok` and stores nothing if the hidden field was filled in.
2. Checks the fields again (the page has already checked them, but anyone can call the function): name up to 120 characters, email up to 254 and shaped like `name@example.com`, phone up to 40, message up to 2,000.
3. Locks the form's row. Answers `not_found` or `closed` unless the form is active.
4. Answers `throttled` if the form already has 30 submissions from the last minute.
5. Looks for a contact in the workspace with the same email, ignoring case. If there is one, it is linked and left exactly as it is. If not, a contact is created: first and last name split on the first space, email in lower case, phone, `source` = `Lead form: <form name>`, status `lead`, tag `lead-form`, no owner, no country.
6. Inserts the `form_submissions` row (`payload` holds name, email, phone and message) linked to that contact.
7. Adds one to the form's `submissions_count`.

`submissions_count` is a running total of what was received: deleting a submission does not lower it. Deleting a form deletes its submissions but not the contacts they made. Deleting a contact keeps its submissions and clears their link. Members read their workspace's submissions, writers can delete one, and nobody can insert or edit one through the API. No IP address, user agent or referrer is stored.

On the Lead Forms page, "New today" and "Submissions over time" are counted from `form_submissions.created_at`, with a day being the calendar day in Asia/Kuala_Lumpur. They count stored rows, so a deleted submission leaves them, while "Total leads" is the sum of `submissions_count` and does not go down; the two can differ after a deletion. The funnel stays hidden: a form start is not recorded.

**Jebat sees these leads without a copy.** The contact is the only record. Jebat's leads (Overview, Lead Funnel, Reports, CSV export and Jebat's AI) are the rows of `leads` plus every contact tagged `lead-form` or `chatbot`, which covers lead forms, landing pages and the chatbot (`src/lib/reach/crm-leads.ts`). Such a contact shows up under the channel `web` ("Website"). Its stage comes from its Kasturi status (customer is Won), and an archived contact is left out. Jebat never changes or promotes it: the Lead Funnel links to Kasturi instead.

### Abuse limits, and what they do not stop

- **Honeypot.** A field people cannot see. A script that fills in every field is thanked and discarded. A script written for this form simply leaves it empty.
- **Length caps**, enforced in SQL.
- **Throttle: 30 submissions per form per minute.** This caps how fast one form can fill a workspace with junk. It is per form, not per visitor (nothing identifies a visitor), so someone flooding a form also locks out real people for that minute, and a patient script can still add 30 contacts a minute, about 43,000 a day, to each active form.
- There is no CAPTCHA, no email confirmation and no per-IP limit. An email address is not proven to belong to whoever typed it.
- **Views are a soft number.** Each render of an active form's page counts one, including bots, link previews, reloads, and the re-render after a submission sent without JavaScript. `record_form_view` is also a public function, so a script can raise the count directly. Members of the form's workspace are not counted while signed in.
- Because an existing contact is matched by email, a visitor who knows a contact's email can attach a submission (and its message) to that contact. They cannot read or change the contact.

If a form is abused, pausing it stops submissions at once. The next steps, if needed, are a per-IP limit at the edge and a challenge on the page.

## Not included yet

- A form builder with custom fields (the four fields are fixed; `payload` is `jsonb` so more can be added later)
- A link from a submission straight to its contact (the panel links to the Contacts page)
- Notifying anyone when a submission arrives, or adding the message to the contact as a note

- UI wiring and server actions for pages other than Contacts and Deals
- Database rules for the stage limits and for stage names that differ only in capitals (the write paths check them)
- Moving a deal to another pipeline
- A database rule for one default pipeline per workspace (the write paths keep to it)
- Changing a deal's owner
- Dragging on touch screens, and reordering cards within a stage
- Activities and notes on a deal
- Supabase Storage bucket policies
- Audit trigger functions
- Keeping `updated_at`, `last_interaction_at` and `last_activity_at` current (the write paths set them)
- Turning a Jebat lead into a Kasturi contact
- Seed demo CRM data

Those should come as smaller follow-up slices.
