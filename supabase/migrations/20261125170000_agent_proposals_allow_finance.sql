-- Let agent_proposals hold Bendahara (finance) suggestions as well as Jebat (reach)
-- and Kasturi (crm) ones, and let the decide path mark an approved finance
-- suggestion that no longer applies as rejected.
--
-- Apply ONLY together with (or after) the app code that decides finance proposals
-- (the Bendahara focus agent): until then nothing writes a finance row, and the
-- approval code would not know where to route one.
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. The product check, restated with 'finance'. The newest check is the named
--    agent_proposals_product_check from 20261125150200; drop any product check
--    by what it constrains, as that file did, and add the new one.
-- ---------------------------------------------------------------------------
do $$
declare
  c record;
begin
  for c in
    select con.conname
    from pg_constraint con
    where con.conrelid = 'public.agent_proposals'::regclass
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%product%'
      and pg_get_constraintdef(con.oid) ilike '%reach%'
  loop
    execute format('alter table public.agent_proposals drop constraint %I', c.conname);
  end loop;
end
$$;

alter table public.agent_proposals
  add constraint agent_proposals_product_check
  check (product in ('reach','crm','finance'));

-- ---------------------------------------------------------------------------
-- 2. Proposal guard v5. Every v4 rule (20261125150100) is kept as it was, plus
--    one: an approved FINANCE proposal may become rejected when the decide path
--    finds, after the claim, that it no longer applies (the invoice was paid, the
--    bill voided, the period filed). That update changes only status and result,
--    and result says so with "stale": true. The decision stamps
--    stay frozen (the v4 rule below), and every other column must not change (the
--    v3 rule below). crm and reach proposals behave exactly as before.
-- ---------------------------------------------------------------------------
create or replace function private.agent_proposals_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.status = 'pending' then
    if new.status not in ('approved','rejected','expired','failed') then
      raise exception 'invalid decision' using errcode = 'AGP01';
    end if;
  elsif old.status = 'approved' and new.status in ('approved','failed') then
    null; -- annotate the claimed row (result) or correct a failed apply
  elsif old.status = 'approved' and new.status = 'rejected'
        and old.product = 'finance'
        and new.result->>'stale' = 'true' then
    null; -- a finance approval that no longer applies (see above)
  else
    raise exception 'this proposal is already handled' using errcode = 'AGP01';
  end if;
  if old.status <> 'pending'
     and (new.decided_at is distinct from old.decided_at
          or new.decided_by is distinct from old.decided_by) then
    raise exception 'who decided a proposal, and when, cannot change' using errcode = 'AGP01';
  end if;
  if (to_jsonb(new) - 'status' - 'result' - 'decided_at' - 'decided_by')
     is distinct from (to_jsonb(old) - 'status' - 'result' - 'decided_at' - 'decided_by') then
    raise exception 'only the decision may change' using errcode = 'AGP01';
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Self-check.
-- ---------------------------------------------------------------------------
do $$
declare
  n integer;
  t text;
begin
  select count(*) into n from pg_constraint
   where conrelid = 'public.agent_proposals'::regclass and contype = 'c'
     and pg_get_constraintdef(oid) ilike '%product%';
  select pg_get_constraintdef(oid) into t from pg_constraint
   where conrelid = 'public.agent_proposals'::regclass and conname = 'agent_proposals_product_check';
  if n <> 1 or t is distinct from 'CHECK ((product = ANY (ARRAY[''reach''::text, ''crm''::text, ''finance''::text])))' then
    raise exception 'agent_proposals product check is not as this file needs: % checks, %', n, t;
  end if;
  -- Every existing row still passes (validated by the add above; restated for the reader).
  select count(*) into n from public.agent_proposals where product not in ('reach','crm','finance');
  if n <> 0 then
    raise exception '% proposals have an unknown product', n;
  end if;
  select count(*) into n from pg_trigger
   where tgrelid = 'public.agent_proposals'::regclass and tgname = 'agent_proposals_guard' and tgenabled = 'O';
  if n <> 1 then
    raise exception 'the agent_proposals guard trigger is missing or disabled';
  end if;
  if pg_get_functiondef('private.agent_proposals_guard()'::regprocedure) not like '%old.product = ''finance''%' then
    raise exception 'private.agent_proposals_guard is not v5';
  end if;
end $$;
