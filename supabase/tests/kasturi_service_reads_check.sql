-- Kasturi boundary check (20261201090000_kasturi_service_role_grants.sql, issue #431).
-- Leaves nothing behind: the block always ends with RAISE, so every row below is
-- rolled back. Read the message:
--   KASTURI_SERVICE_READS_CHECK PASSED ...   or   ... FAILED (n): <what went wrong>
--
--   begin;
--   \i supabase/migrations/20261201090000_kasturi_service_role_grants.sql
--   \i supabase/tests/kasturi_service_reads_check.sql
--   rollback;
--
-- What it checks:
--   * no crm_ relation of any relkind holds a table privilege for service_role,
--     so the inherited fresh-project grant cannot hide on a relation nobody named;
--   * every column service_role may read on a crm_ relation is pinned, nothing else
--     on that relation is readable, and the private sample (an email, a phone, a
--     note body, a chatbot message, an audit row, the lost-reason setting) is refused;
--   * the only write privilege on the whole schema is the broadcast marking path's
--     four review columns, judged with has_column_privilege on every crm_ column
--     (insert, update, references) so a grant made to PUBLIC cannot hide, and the
--     file proves that sensitivity by granting one column to PUBLIC and rolling it
--     back; a real marking update runs as service_role;
--   * a real read of the pinned columns as service_role, and a refused read, a
--     refused insert and a refused update beside it.
do $$
declare
  fails text[] := '{}';
  pinned text[];
  t text;
  n bigint;
  org uuid := gen_random_uuid();
  bcast uuid := gen_random_uuid();
  rcpt uuid := gen_random_uuid();
  rcpt2 uuid := gen_random_uuid();
  r record;
  -- The write inventory, kept in one place so the assertion below and the PUBLIC
  -- probe judge the schema with the same statement rather than two copies of it.
  inv constant text := $q$
    select string_agg(c.relname || '.' || a.attname || ':' || p.priv,
                      ',' order by c.relname, a.attname, p.priv)
      from pg_catalog.pg_class c
      join pg_catalog.pg_attribute a
        on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
      cross join (values ('INSERT'), ('UPDATE'), ('REFERENCES')) p(priv)
     where c.relnamespace = 'public'::regnamespace
       and c.relname like 'crm\_%'
       and c.relkind in ('r', 'p', 'v', 'm', 'f')
       and has_column_privilege('service_role', c.oid, a.attname, p.priv)$q$;
  expected constant text := 'crm_broadcast_recipients.error:UPDATE,crm_broadcast_recipients.provider_id:UPDATE,'
                          || 'crm_broadcast_recipients.sent_at:UPDATE,crm_broadcast_recipients.status:UPDATE';
begin
  -- ---- 0. nothing to judge? then say so instead of passing quietly ----
  if to_regclass('public.crm_deals') is null then
    raise exception 'there are no crm_ tables, so the boundary was not checked';
  end if;

  -- ---- 1. no table privilege of any kind on a crm_ relation ----
  select string_agg(c.relname, ', ' order by c.relname) into t
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
  if t is not null then fails := fails || format('service_role holds a table privilege on %s', t); end if;

  -- ---- 2. the pin: what the Kasturi worker reads, and why ----
  -- src/lib/crm/agent/context.ts selects, filters, sorts and embeds through these.
  -- src/lib/crm/broadcast-send.ts:321 reads id and status in its own where clause
  -- and writes the four below. A new grant fails here until it is reviewed.
  pinned := array[
    'crm_contacts.id', 'crm_contacts.org_id', 'crm_contacts.first_name', 'crm_contacts.last_name',
    'crm_contacts.status', 'crm_contacts.source', 'crm_contacts.tags', 'crm_contacts.created_at',
    'crm_contacts.company',
    'crm_deals.id', 'crm_deals.org_id', 'crm_deals.title', 'crm_deals.value_cents', 'crm_deals.status',
    'crm_deals.contact_id', 'crm_deals.expected_close_date', 'crm_deals.last_activity_at', 'crm_deals.created_at',
    'crm_activities.id', 'crm_activities.org_id', 'crm_activities.title', 'crm_activities.contact_id',
    'crm_activities.deal_id', 'crm_activities.type', 'crm_activities.due_at', 'crm_activities.completed_at',
    'crm_activities.created_at',
    'crm_notes.id', 'crm_notes.org_id', 'crm_notes.contact_id', 'crm_notes.deal_id', 'crm_notes.created_at',
    'crm_broadcast_recipients.id', 'crm_broadcast_recipients.status'];
  select string_agg(x, ',' order by x) into t from unnest(pinned) x
   where not has_column_privilege('service_role', ('public.' || split_part(x, '.', 1))::regclass,
                                 split_part(x, '.', 2), 'select');
  if t is not null then fails := fails || format('service_role may not read %s', t); end if;

  -- ---- 3. and nothing readable outside the pin ----
  select string_agg(c.table_name || '.' || c.column_name, ',' order by c.table_name, c.column_name) into t
    from information_schema.columns c
    join pg_catalog.pg_class k on k.relname = c.table_name and k.relnamespace = 'public'::regnamespace
   where c.table_schema = 'public'
     and c.table_name like 'crm\_%'
     and has_column_privilege('service_role', k.oid, c.column_name, 'select')
     and (c.table_name || '.' || c.column_name) <> all (pinned);
  if t is not null then fails := fails || format('service_role may also read %s', t); end if;

  -- ---- 4. the private sample, by name, so a reader sees what is closed ----
  for r in
    select * from (values
      ('crm_contacts', 'email'), ('crm_contacts', 'phone'),
      ('crm_deals', 'lost_reason'), ('crm_activities', 'body'), ('crm_notes', 'body'),
      ('crm_broadcasts', 'body'), ('crm_chatbot_messages', 'body'),
      ('crm_chatbot_knowledge', 'body'), ('crm_audit_logs', 'metadata'),
      ('crm_settings', 'require_lost_reason'), ('crm_email_opt_outs', 'email')
    ) v(tbl, col)
  loop
    if to_regclass('public.' || r.tbl) is null then
      fails := fails || format('%s is gone, so its columns were not checked', r.tbl);
    elsif has_column_privilege('service_role', ('public.' || r.tbl)::regclass, r.col, 'select') then
      fails := fails || format('service_role may read %s.%s', r.tbl, r.col);
    end if;
  end loop;

  -- ---- 5. the whole schema's writes, judged per column ----
  -- information_schema.column_privileges filtered on grantee = 'service_role' cannot
  -- see a column grant made to PUBLIC, and service_role inherits that grant, so the
  -- inventory asks has_column_privilege about every crm_ column instead.
  execute inv into t;
  if coalesce(t, '') <> expected then
    fails := fails || format('service_role writes more than the marking path: %s', coalesce(t, 'nothing'));
  end if;

  -- ---- 5b. prove that inventory sees a grant the grantee filter cannot ----
  -- grant update (status) on public.crm_contacts to public records PUBLIC as the
  -- grantee, so the older information_schema query stays blind to it while
  -- service_role can write the column. The block rolls the grant back, and the
  -- inventory is run again after it to prove the state came back.
  begin
    grant update (status) on public.crm_contacts to public;

    select string_agg(table_name || '.' || column_name || ':' || privilege_type, ',')
      into t
      from information_schema.column_privileges
     where table_schema = 'public' and table_name like 'crm\_%' and grantee = 'service_role'
       and privilege_type <> 'SELECT';
    if coalesce(t, '') ~ 'crm_contacts\.status' then
      fails := fails || 'the grantee filter saw the PUBLIC grant, so the probe proves nothing';
    end if;

    execute inv into t;
    if t is distinct from expected || ',crm_contacts.status:UPDATE' then
      fails := fails || format('the write inventory does not see a column grant made to PUBLIC: %s',
                               coalesce(t, 'nothing'));
    end if;

    raise exception using errcode = 'KS001', message = 'roll the probe grant back';
  exception when sqlstate 'KS001' then
    null;
  end;

  execute inv into t;
  if coalesce(t, '') <> expected then
    fails := fails || format('the PUBLIC probe grant was not rolled back: %s', coalesce(t, 'nothing'));
  end if;

  -- ---- 6. a real read of each relation's pinned columns, as service_role ----
  for r in
    select split_part(x, '.', 1) tbl, string_agg(split_part(x, '.', 2), ',') cols
      from unnest(pinned) x group by 1 order by 1
  loop
    begin
      set local role service_role;
      execute format('select %s from public.%I limit 1', r.cols, r.tbl);
      reset role;
    exception when others then
      reset role;
      fails := fails || format('service_role reading %s: %s %s', r.tbl, sqlstate, sqlerrm);
    end;
  end loop;

  -- ---- 7. the marking path, on a real row, as service_role ----
  insert into public.orgs (id, name) values (org, 'Kasturi Boundary Check Sdn Bhd');
  insert into public.crm_broadcasts (id, org_id, name, subject, body, status)
    values (bcast, org, 'Boundary check', 'Subject', 'Body', 'sending');
  insert into public.crm_broadcast_recipients (id, org_id, broadcast_id, email, status)
    values (rcpt, org, bcast, 'qa@example.com', 'pending'),
           (rcpt2, org, bcast, 'retry@example.com', 'pending');

  begin
    set local role service_role;
    -- The two forms src/lib/crm/broadcast-send.ts sends.
    update public.crm_broadcast_recipients
       set status = 'sent', sent_at = now(), provider_id = 'p-1', error = null
     where id = rcpt;
    get diagnostics n = row_count;
    if n <> 1 then fails := fails || format('the marking update matched %s recipients, expected 1', n); end if;
    reset role;
  exception when others then
    reset role;
    fails := fails || format('service_role cannot mark a recipient: %s %s', sqlstate, sqlerrm);
  end;

  -- The retry form, on a recipient that is not marked sent yet. A sent one is
  -- kept sent by crm_broadcast_recipients_keep_sent, so it would match no row.
  begin
    set local role service_role;
    update public.crm_broadcast_recipients set status = 'failed', error = 'refused'
     where id = rcpt2 and status <> 'sent';
    get diagnostics n = row_count;
    if n <> 1 then fails := fails || format('the retry form matched %s recipients, expected 1', n); end if;
    reset role;
  exception when others then
    reset role;
    fails := fails || format('service_role cannot retry a recipient: %s %s', sqlstate, sqlerrm);
  end;

  -- ---- 8. and the refusals beside it ----
  for r in
    select * from (values
      ('select email from public.crm_contacts where false', 'read a contact email'),
      ('select body from public.crm_chatbot_messages where false', 'read a chatbot message'),
      ('select count(*) from public.crm_audit_logs where false', 'read the audit log'),
      ('select count(*) from public.crm_settings where false', 'read the crm settings'),
      ('update public.crm_contacts set email = email where false', 'change a contact email'),
      ('delete from public.crm_broadcast_recipients where false', 'delete a recipient')
    ) v(stmt, what)
  loop
    begin
      set local role service_role;
      execute r.stmt;
      reset role;
      fails := fails || format('service_role could %s', r.what);
    exception when others then
      reset role;
      if sqlstate <> '42501' then fails := fails || format('%s refused with %s, not 42501', r.what, sqlstate); end if;
    end;
  end loop;

  begin
    set local role service_role;
    execute format('insert into public.crm_pipelines (org_id, name) values (%L::uuid, %L)', org, 'Boundary pipeline');
    reset role;
    fails := fails || 'service_role could insert a pipeline'::text;
  exception when others then
    reset role;
    if sqlstate <> '42501' then fails := fails || format('inserting a pipeline refused with %s, not 42501', sqlstate); end if;
  end;

  if cardinality(fails) > 0 then
    raise exception 'KASTURI_SERVICE_READS_CHECK FAILED (%): %', cardinality(fails), array_to_string(fails, ' | ');
  end if;
  raise exception 'KASTURI_SERVICE_READS_CHECK PASSED (everything rolled back)';
end $$;
