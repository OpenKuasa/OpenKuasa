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

-- Fresh Supabase projects grant service_role table privileges by default. The
-- earlier Jebat migration already narrowed crm_contacts; narrow the other three
-- tables before adding Kasturi's column grants.
revoke all on
  public.crm_deals,
  public.crm_activities,
  public.crm_notes
  from service_role;

grant select (id, org_id, title, value_cents, status, contact_id, expected_close_date, last_activity_at, created_at)
  on public.crm_deals to service_role;

grant select (company)
  on public.crm_contacts to service_role;

grant select (id, org_id, title, contact_id, deal_id, type, due_at, completed_at, created_at)
  on public.crm_activities to service_role;

grant select (id, org_id, contact_id, deal_id, created_at)
  on public.crm_notes to service_role;

-- Prove the final privilege shape, not only that the grants above exist. In
-- particular, a fresh project's table-wide defaults must not survive.
do $$
declare
  r record;
  missing text;
begin
  for r in
    select * from (values
      ('crm_contacts', 'id,org_id,first_name,last_name,company,status,source,tags,created_at'),
      ('crm_deals', 'id,org_id,title,value_cents,status,contact_id,expected_close_date,last_activity_at,created_at'),
      ('crm_activities', 'id,org_id,title,contact_id,deal_id,type,due_at,completed_at,created_at'),
      ('crm_notes', 'id,org_id,contact_id,deal_id,created_at')
    ) v(tbl, cols)
  loop
    select string_agg(c, ',') into missing from unnest(string_to_array(r.cols, ',')) c
     where not has_column_privilege('service_role', ('public.' || r.tbl)::regclass, c, 'select');
    if missing is not null then
      raise exception 'service_role may not read %.%', r.tbl, missing;
    end if;
    if has_table_privilege('service_role', ('public.' || r.tbl)::regclass, 'select')
       or has_table_privilege('service_role', ('public.' || r.tbl)::regclass, 'insert')
       or has_table_privilege('service_role', ('public.' || r.tbl)::regclass, 'update')
       or has_table_privilege('service_role', ('public.' || r.tbl)::regclass, 'delete') then
      raise exception 'service_role has broad privileges on %', r.tbl;
    end if;
  end loop;

  select string_agg(v.tbl || '.' || v.col, ', ') into missing
    from (values
      ('crm_contacts', 'email'),
      ('crm_contacts', 'phone'),
      ('crm_activities', 'body'),
      ('crm_notes', 'body')
    ) v(tbl, col)
   where has_column_privilege('service_role', ('public.' || v.tbl)::regclass, v.col, 'select');
  if missing is not null then
    raise exception 'service_role may read private CRM columns: %', missing;
  end if;
end $$;
