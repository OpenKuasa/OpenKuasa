-- Let agent_proposals hold Kasturi (crm) suggestions as well as Jebat (reach) ones.
--
-- Apply ONLY after the product-routed approval path (PR #345) is live: until then
-- the approval code assumes every proposal is a reach one, so a crm row would be
-- decided by the wrong path.

-- The original CHECK is inline and unnamed in 20261022090000_agent_proposals.sql,
-- so find it by what it constrains and drop whatever it is called.
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
  check (product in ('reach','crm'));
