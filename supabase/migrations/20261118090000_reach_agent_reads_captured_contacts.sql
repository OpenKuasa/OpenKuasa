-- The Weekly Studio worker may read the contacts Jebat counts as leads.
--
-- Jebat now reads form, landing-page and chatbot leads from crm_contacts
-- (src/lib/reach/crm-leads.ts), and the worker builds its snapshot through the
-- same listLeads() with the service-role client. In this project service_role
-- holds no table grants unless one is written (see
-- 20261015100000_agent_service_role_grants.sql), so without this grant every
-- run fails with permission denied on crm_contacts.
--
-- Read only, and only the columns listLeads selects, filters on and sorts by:
-- the worker never sees a contact's email, phone or notes.

grant select (id, org_id, first_name, last_name, status, source, tags, created_at)
  on public.crm_contacts to service_role;
