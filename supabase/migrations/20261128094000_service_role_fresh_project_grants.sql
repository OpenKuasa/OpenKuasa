-- The same tightening, for databases that already ran the agent service-read migrations.
--
-- A fresh Supabase project grants service_role table-wide privileges by default. The
-- agent service-read migrations (20261118090000, 20261125150300, 20261125170200,
-- 20261125190200, 20261125200200) now remove those before granting their pinned columns,
-- but a database that ran an earlier copy of them keeps whatever it had. This runs on
-- every database once and leaves each relation below with the same boundary: service_role
-- reads only the columns it was already given, and has no table-wide way to read or change
-- data (REFERENCES and TRIGGER grant neither, and are left as they are).
--
-- Revoking a table-level privilege also drops that privilege on every column, so each
-- relation's existing service_role column reads are read first and given back. A relation
-- with no table-wide data privilege is not touched (the case on the hosted project).
-- Also closes service_role's execute on finance_record_refund, as 20261120120000 now does.

do $$
declare
  r record;
  cols text;
  missing text;
begin
  for r in
    select c.oid, c.relname
      from pg_catalog.pg_class c
     where c.relnamespace = 'public'::regnamespace
       and c.relkind in ('r', 'p', 'v', 'm')
       and (c.relname like 'hire\_%' or c.relname like 'hr\_%'
            or c.relname in ('crm_contacts', 'crm_deals', 'crm_activities', 'crm_notes',
                             'finance_settings', 'finance_sst_return_figures',
                             'finance_sst_settings', 'finance_sst_returns'))
       and has_table_privilege('service_role', c.oid, 'select,insert,update,delete,truncate')
     order by c.relname
  loop
    select string_agg(quote_ident(a.attname), ', ' order by a.attnum) into cols
      from pg_catalog.pg_attribute a, aclexplode(a.attacl) x
     where a.attrelid = r.oid and a.attnum > 0 and not a.attisdropped
       and x.grantee = 'service_role'::regrole and x.privilege_type = 'SELECT';
    execute format('revoke select, insert, update, delete, truncate on public.%I from service_role', r.relname);
    if cols is not null then
      execute format('grant select (%s) on public.%I to service_role', cols, r.relname);
    end if;
  end loop;

  -- What is left can only come through PUBLIC, which this does not change for everyone
  -- else: stop instead of leaving the agent worker with table-wide access.
  select string_agg(c.relname, ',' order by c.relname) into missing
    from pg_catalog.pg_class c
   where c.relnamespace = 'public'::regnamespace
     and c.relkind in ('r', 'p', 'v', 'm')
     and (c.relname like 'hire\_%' or c.relname like 'hr\_%'
          or c.relname in ('crm_contacts', 'crm_deals', 'crm_activities', 'crm_notes',
                           'finance_settings', 'finance_sst_return_figures',
                           'finance_sst_settings', 'finance_sst_returns'))
     and has_table_privilege('service_role', c.oid, 'select,insert,update,delete,truncate');
  if missing is not null then
    raise exception 'service_role still holds table-wide data privileges (through PUBLIC?) on: %', missing;
  end if;
end $$;

revoke all on function public.finance_record_refund(uuid, jsonb) from service_role;
