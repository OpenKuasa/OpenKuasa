-- The Kasturi agent worker may read the deal, contact, activity and note
-- columns it scans.
--
-- The worker builds its snapshot (src/lib/crm/agent/context.ts) with the
-- service-role client. In this project service_role holds no table grants
-- unless one is written (see 20261015100000_agent_service_role_grants.sql), so
-- without this grant every run fails with permission denied on crm_deals.
-- crm_contacts already grants id, org_id, first_name, last_name, status,
-- source, tags and created_at (20261118090000); only company is added here.
--
-- Read only, and only the columns context.ts selects, filters on, sorts by
-- and embeds through (deal -> contact and activity -> contact join on
-- contact_id, org_id): the worker never sees a contact's email or phone, a
-- deal's notes, an activity's body or a note's body.

grant select (id, org_id, title, value_cents, status, contact_id, expected_close_date, last_activity_at, created_at)
  on public.crm_deals to service_role;

grant select (company)
  on public.crm_contacts to service_role;

grant select (id, org_id, title, contact_id, deal_id, type, due_at, completed_at, created_at)
  on public.crm_activities to service_role;

grant select (id, org_id, contact_id, deal_id, created_at)
  on public.crm_notes to service_role;
