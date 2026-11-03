-- New tables in public stop giving service_role anything by default (issue #431).
--
-- A fresh Supabase project's default gives service_role ALL on every table a
-- migration creates; the hosted project's default still gives it TRUNCATE,
-- REFERENCES, TRIGGER and MAINTAIN. 20261202090100 closes that on the
-- crm_ relations that exist now, but a table made later would inherit it again.
-- Changing the default closes it at the source.
--
-- This applies to every product, not only Kasturi: from here on, a new table
-- in public gives service_role nothing until a migration grants it what the
-- server uses, which is already the rule each table's migration follows
-- (20261101111500, 20261119150000 and others grant explicitly). Tables that
-- exist now keep what they have. anon and authenticated are not changed here.
--
-- A default belongs to the role that creates the tables. Migrations run as
-- postgres, so this is written without FOR ROLE and applies to that role. The
-- check below makes a table the same way a migration would and looks at it.

alter default privileges in schema public revoke all on tables from service_role;

do $$
declare
  held text;
begin
  create table public.service_role_default_probe (id int);

  select string_agg(p.priv, ', ') into held
    from (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'),
                 ('REFERENCES'), ('TRIGGER'), ('MAINTAIN')) p(priv)
   where has_table_privilege('service_role', 'public.service_role_default_probe'::regclass, p.priv);

  drop table public.service_role_default_probe;

  if held is not null then
    raise exception 'a new table in public still gives service_role: %', held;
  end if;
end $$;
