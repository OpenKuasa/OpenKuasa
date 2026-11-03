-- A brand-new Supabase project grants its API roles ALL on every relation it
-- creates (Supabase's own `alter default privileges in schema public grant all on
-- tables to anon, authenticated, service_role`). So the column grants the Kasturi
-- migrations write narrow nothing on a fresh project: service_role keeps DELETE,
-- INSERT, TRUNCATE and UPDATE on all 21 crm_ relations, and reads every column of
-- them, including a contact's email and phone and every chatbot message. The HR,
-- Hire and finance schemas already close this for themselves (issue #431).
--
-- Revoking a table privilege drops the column grants held on that relation too.
-- Measured on postgres:17-alpine: after `grant select (status)`, has_column_privilege
-- reads true and has_table_privilege reads false; after `revoke all on <table>`,
-- both read false even though no column was named. So the revoke comes first and
-- the pin below is the whole story, not an addition to what is already there.
--
-- The loop is a snapshot of today's relations. A later migration that creates
-- another crm_ relation inherits the defaults again; the boundary that catches it
-- is supabase/tests/kasturi_service_reads_check.sql, which asserts this shape for
-- every crm_ relation rather than for the ones named here.

do $$
declare
  r record;
begin
  for r in
    select c.relname
      from pg_catalog.pg_class c
     where c.relnamespace = 'public'::regnamespace
       and c.relname like 'crm\_%'
       and c.relkind in ('r', 'p', 'v', 'm', 'f')
     order by c.relname
  loop
    execute format('revoke all on public.%I from service_role', r.relname);
  end loop;
end $$;

-- Read only, and only the columns src/lib/crm/agent/context.ts selects, filters
-- on, sorts by and embeds through (deal -> contact and activity -> contact join on
-- contact_id, org_id): the worker never sees a contact's email or phone, a deal's
-- notes, an activity's body or a note's body. These are the same sets
-- 20261118090000 and 20261125150300 grant; they are restated here because the
-- revoke above removed them.
grant select (id, org_id, first_name, last_name, status, source, tags, created_at, company)
  on public.crm_contacts to service_role;

grant select (id, org_id, title, value_cents, status, contact_id, expected_close_date, last_activity_at, created_at)
  on public.crm_deals to service_role;

grant select (id, org_id, title, contact_id, deal_id, type, due_at, completed_at, created_at)
  on public.crm_activities to service_role;

grant select (id, org_id, contact_id, deal_id, created_at)
  on public.crm_notes to service_role;

-- The broadcast sender is the only service-role path that writes a crm_ table
-- (src/lib/crm/broadcast-send.ts:321): it marks each recipient with
-- .update(patch).eq('id', row.id), and on a retry .neq('status', 'sent'). The
-- where clause reads id and status, and PostgreSQL refuses the update
-- (permission denied for table crm_broadcast_recipients) without select on the two
-- columns it filters on, so the select is pinned to them rather than dropped. The
-- four writable columns are the ones that migration's own grant names.
grant select (id, status) on public.crm_broadcast_recipients to service_role;
grant update (status, provider_id, error, sent_at) on public.crm_broadcast_recipients to service_role;

-- The final shape, judged with has_table_privilege and has_column_privilege
-- rather than aclexplode: a privilege granted to PUBLIC has no grantee row for
-- service_role, so an aclexplode filter would pass on a writable relation. The
-- same reason rules out information_schema.column_privileges filtered on
-- grantee = 'service_role': a column grant made to PUBLIC is recorded once, with
-- PUBLIC as the grantee, while service_role inherits it and section below only
-- samples columns. So the write inventory asks has_column_privilege about every
-- column of every crm_ relation.
do $$
declare
  left_over text;
  missing text;
  readable text;
  writable text;
begin
  select string_agg(c.relname, ', ' order by c.relname) into left_over
    from pg_catalog.pg_class c
   where c.relnamespace = 'public'::regnamespace
     and c.relname like 'crm\_%'
     and c.relkind in ('r', 'p', 'v', 'm', 'f')
     and (has_table_privilege('service_role', c.oid, 'select')
       or has_table_privilege('service_role', c.oid, 'insert')
       or has_table_privilege('service_role', c.oid, 'update')
       or has_table_privilege('service_role', c.oid, 'delete')
       or has_table_privilege('service_role', c.oid, 'truncate')
       or has_table_privilege('service_role', c.oid, 'references')
       or has_table_privilege('service_role', c.oid, 'trigger'));
  if left_over is not null then
    raise exception 'service_role still holds a table privilege on: %', left_over;
  end if;

  select string_agg(v.tbl || '.' || v.col, ', ') into missing
    from (values
      ('crm_contacts', 'id'), ('crm_contacts', 'company'),
      ('crm_deals', 'id'), ('crm_deals', 'value_cents'),
      ('crm_activities', 'id'), ('crm_activities', 'due_at'),
      ('crm_notes', 'id'),
      ('crm_broadcast_recipients', 'id'), ('crm_broadcast_recipients', 'status')
    ) v(tbl, col)
   where not has_column_privilege('service_role', ('public.' || v.tbl)::regclass, v.col, 'select');
  if missing is not null then
    raise exception 'service_role may not read: %', missing;
  end if;

  select string_agg(v.tbl || '.' || v.col, ', ') into readable
    from (values
      ('crm_contacts', 'email'), ('crm_contacts', 'phone'),
      ('crm_deals', 'lost_reason'), ('crm_activities', 'body'), ('crm_notes', 'body'),
      ('crm_chatbot_messages', 'body'), ('crm_audit_logs', 'metadata'),
      ('crm_settings', 'require_lost_reason')
    ) v(tbl, col)
   where has_column_privilege('service_role', ('public.' || v.tbl)::regclass, v.col, 'select');
  if readable is not null then
    raise exception 'service_role may read private crm_ columns: %', readable;
  end if;

  select string_agg(c.relname || '.' || a.attname || ':' || p.priv,
                    ',' order by c.relname, a.attname, p.priv) into writable
    from pg_catalog.pg_class c
    join pg_catalog.pg_attribute a
      on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    cross join (values ('INSERT'), ('UPDATE'), ('REFERENCES')) p(priv)
   where c.relnamespace = 'public'::regnamespace
     and c.relname like 'crm\_%'
     and c.relkind in ('r', 'p', 'v', 'm', 'f')
     and has_column_privilege('service_role', c.oid, a.attname, p.priv);
  if coalesce(writable, '') <> 'crm_broadcast_recipients.error:UPDATE,crm_broadcast_recipients.provider_id:UPDATE,'
                             || 'crm_broadcast_recipients.sent_at:UPDATE,crm_broadcast_recipients.status:UPDATE' then
    raise exception 'service_role may write more than the marking columns: %', coalesce(writable, 'nothing');
  end if;
end $$;
