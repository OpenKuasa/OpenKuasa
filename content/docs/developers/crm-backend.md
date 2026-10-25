---
title: CRM backend notes
description: Kasturi's CRM tables, its access rules, and how public lead forms write contacts.
order: 12
ask: How are Kasturi's CRM tables and public lead forms built?
---
A short map of Kasturi's backend for contributors. More detail on the Contacts and Deals pages is in [docs/kasturi-crm-backend-spine.md](https://github.com/OpenKuasa/OpenKuasa/blob/main/docs/kasturi-crm-backend-spine.md) in the repository. Where it and the code differ, the code and the migrations are right.

## Who can do this

Anyone changing the CRM code or its migrations.

## The core tables

| Table | Holds |
| --- | --- |
| `crm_contacts` | Contacts. `status` is `lead`, `contacted`, `qualified`, `customer` or `archived`. The person in charge is `owner_user_id`. |
| `crm_pipelines`, `crm_pipeline_stages` | A workspace's pipelines and their stages, in `position` order, each with a win chance. |
| `crm_deals` | Deals. Each belongs to a contact, a pipeline and a stage. Its `status` (`open`, `won`, `lost`) is separate from its stage. Its value is stored in cents (`value_cents`). |
| `crm_activities`, `crm_notes`, `crm_attachments` | What sits on a contact or a deal. A follow-up is an activity of type `task`. |
| `crm_audit_logs` | A record of important CRM changes. |

Appointments use the shared `appointments` table, the same one Jebat uses.

## Consistency rules

- Deals, activities, notes and attachments point at their contact or deal by `(id, org_id)`, so a row cannot point at another workspace's record.
- A deal points at its stage by `(stage_id, pipeline_id)`, so the stage always belongs to the deal's pipeline.

## Access rules

- Every CRM record is scoped by `org_id`.
- Members of the workspace read; writers (owners, admins and members) create, update and delete. The policies use `private.is_org_member(org_id)` and `private.is_org_writer(org_id)`.
- Audit logs can only be inserted and read, and `actor_user_id` must be the signed-in person.
- The tables carry the restrictive `mfa_required` policy and explicit grants to `authenticated`. `anon` has no access.

## Public lead forms

An active lead form has a public page at `/f/<form id>`. It sits outside the signed-in app and is marked `noindex, nofollow`.

A visitor has no rights on `forms`, `form_submissions` or `crm_contacts`. Everything goes through `SECURITY DEFINER` functions with an empty `search_path`: `get_public_form`, `record_form_view` and `submit_public_form`.

`submit_public_form`, in one transaction:

1. Answers `ok` and keeps nothing if the hidden honeypot field was filled in.
2. Checks the fields again: name up to 120 characters, email up to 254 and shaped like `name@example.com`, phone up to 40, message up to 2,000.
3. Locks the form's row, and answers `not_found` or `closed` unless the form is active. The demo workspace never takes submissions.
4. Answers `consent_required` unless the visitor ticked the consent box.
5. Answers `throttled` if the form already has 30 submissions from the last minute, or the workspace has used its 1,000 a day.
6. Links a contact in the workspace with the same email, ignoring case, and leaves it exactly as it is. If there is none, it creates a contact with status `lead` and the tag `lead-form`.
7. Stores the submission with the consent text the visitor saw, and adds one to the form's `submissions_count`.

The answer never carries an id, and is the same `ok` whether the email was new or already a contact.

Jebat sees these leads without a copy: its leads are the rows of `leads` plus every contact tagged `lead-form` or `chatbot` (`src/lib/reach/crm-leads.ts`).

## Related

- [How OpenKuasa is built](/docs/developers/architecture)
- [Finance backend notes](/docs/developers/finance-backend)
- [Keep the database up to date](/docs/developers/database-migrations)
