-- A brand-new Supabase project grants its API roles ALL on every relation it
-- creates (Supabase's own `alter default privileges in schema public grant all on
-- tables to anon, authenticated, service_role`). So the column grants the Kasturi
-- migrations write narrow nothing on a fresh project: service_role keeps DELETE,
-- INSERT, TRUNCATE and UPDATE on every crm_ relation, and reads every column of
-- them, including a contact's email and phone and every chatbot message. The
-- hosted project has the same gap in part: its default for new tables still gives
-- service_role TRUNCATE, REFERENCES, TRIGGER and MAINTAIN, so most crm_ relations
-- there hold those table-wide, and crm_broadcast_recipients a table-wide SELECT
-- as well (issue #431).
--
-- This file closes it for the crm_ relations that exist now. The next migration
-- (20261202090200) changes the default, so a crm_ relation made later starts with
-- nothing for service_role instead of inheriting this gap again.
--
-- Revoking a table privilege drops the column grants held on that relation too.
-- Measured on postgres:17-alpine: after `grant select (status)`, has_column_privilege
-- reads true and has_table_privilege reads false; after `revoke all on <table>`,
-- both read false even though no column was named. So the revoke comes first and
-- the grants after it are the whole of what service_role holds, not an addition.
--
-- `revoke all` also takes REFERENCES and TRIGGER, which the sibling migration
-- 20261128094000 (#430) leaves on the hr_, hire_ and finance_ relations. Here they
-- go on purpose: the app needs neither, a trigger service_role attached to a crm_
-- table would run on every write the app makes, and REFERENCES lets it add a
-- constraint that tells it which values a column holds. Tightening #430 the same
-- way is a separate change.

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

-- The pin. supabase/tests/kasturi_service_reads_check.sql keeps the same list in
-- its `pinned` array, and tests/crm-service-role-grants-migration.test.ts fails
-- when the two disagree.
--
-- Read only, and only the columns src/lib/crm/agent/context.ts selects, filters
-- on, sorts by and embeds through (deal -> contact and activity -> contact join on
-- contact_id, org_id): the worker never sees a contact's email or phone, a deal's
-- notes, an activity's body or a note's body. These are the same sets
-- 20261118090000 and 20261125150300 grant. They are written out rather than read
-- back from the catalog and re-granted (as 20261128094000 does) because this file
-- also narrows one of them, and because what service_role may read should be
-- spelled out where it is reviewed.
grant select (id, org_id, first_name, last_name, status, source, tags, created_at, company)
  on public.crm_contacts to service_role;

grant select (id, org_id, title, value_cents, status, contact_id, expected_close_date, last_activity_at, created_at)
  on public.crm_deals to service_role;

grant select (id, org_id, title, contact_id, deal_id, type, due_at, completed_at, created_at)
  on public.crm_activities to service_role;

grant select (id, org_id, contact_id, deal_id, created_at)
  on public.crm_notes to service_role;

-- The broadcast sender is the only service-role path that writes a crm_ table
-- (src/lib/crm/broadcast-send.ts, `mark`). Every other service-role call into
-- crm_ data is a security definer function. The sender's update, as PostgREST
-- sends it, sets only the columns in the patch, filters on id (and on status
-- for a retry) and returns a constant, so it needs select on id and status and
-- nothing else; the table-wide select 20261106093000 gave is narrowed to those
-- two. The four writable columns are the ones that migration's own grant names.
grant select (id, status) on public.crm_broadcast_recipients to service_role;
grant update (status, provider_id, error, sent_at) on public.crm_broadcast_recipients to service_role;

-- Everything service_role can do on a crm_ relation, judged by effective privilege
-- (has_table_privilege, has_column_privilege) so a grant made to PUBLIC, which
-- service_role inherits and which names no service_role grantee, still shows.
-- Used by the self-check below and by supabase/tests/kasturi_service_reads_check.sql,
-- so the two judge the boundary with the same statement.
create or replace function private.crm_service_role_access()
returns table (relation name, col name, privilege text)
language sql
stable
set search_path = ''
as $$
  select c.relname, null::name, p.priv
    from pg_catalog.pg_class c
    cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'),
                       ('REFERENCES'), ('TRIGGER'), ('MAINTAIN')) p(priv)
   where c.relnamespace = 'public'::regnamespace
     and c.relname like 'crm\_%'
     and c.relkind in ('r', 'p', 'v', 'm', 'f')
     and pg_catalog.has_table_privilege('service_role', c.oid, p.priv)
  union all
  select c.relname, a.attname, p.priv
    from pg_catalog.pg_class c
    join pg_catalog.pg_attribute a
      on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')) p(priv)
   where c.relnamespace = 'public'::regnamespace
     and c.relname like 'crm\_%'
     and c.relkind in ('r', 'p', 'v', 'm', 'f')
     and pg_catalog.has_column_privilege('service_role', c.oid, a.attname, p.priv)
$$;

revoke all on function private.crm_service_role_access() from public;

-- The self-check: no table privilege is left, and what service_role can reach,
-- column by column, is exactly what the grants above gave it by name. Anything
-- more (a column grant to PUBLIC, a grant to a role service_role belongs to)
-- stops the migration, naming the extra columns.
do $$
declare
  table_wide text;
  extra text;
  unreached text;
begin
  select string_agg(a.relation || ':' || a.privilege, ', ' order by a.relation, a.privilege)
    into table_wide
    from private.crm_service_role_access() a
   where a.col is null;
  if table_wide is not null then
    raise exception 'service_role still holds a table privilege on: %', table_wide;
  end if;

  create temporary table crm_service_role_granted on commit drop as
  select c.relname::text || '.' || att.attname::text || ':' || x.privilege_type as grant_key
    from pg_catalog.pg_class c
    join pg_catalog.pg_attribute att
      on att.attrelid = c.oid and att.attnum > 0 and not att.attisdropped
    cross join lateral pg_catalog.aclexplode(att.attacl) x
   where c.relnamespace = 'public'::regnamespace
     and c.relname like 'crm\_%'
     and x.grantee = 'service_role'::regrole;

  select string_agg(k, ', ' order by k) into extra
    from (select a.relation::text || '.' || a.col::text || ':' || a.privilege as k
            from private.crm_service_role_access() a
          except
          select grant_key from crm_service_role_granted) d;
  if extra is not null then
    raise exception 'service_role can reach crm_ columns it was not granted here: %', extra;
  end if;

  select string_agg(grant_key, ', ' order by grant_key) into unreached
    from (select grant_key from crm_service_role_granted
          except
          select a.relation::text || '.' || a.col::text || ':' || a.privilege
            from private.crm_service_role_access() a) d;
  if unreached is not null or not exists (select 1 from crm_service_role_granted) then
    raise exception 'the pin did not take: %', coalesce(unreached, 'nothing was granted');
  end if;
end $$;
