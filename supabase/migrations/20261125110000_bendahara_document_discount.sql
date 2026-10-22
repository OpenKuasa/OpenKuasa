-- Bendahara: a discount on a whole sales invoice or quotation (#272). The
-- header keeps the discount as entered (a percentage, or a fixed amount in the
-- document's currency, not both). It is split back across the lines, and each
-- line's money figures are taken after its share, so everything that adds up
-- lines (totals views, ledger, credit notes, the SST return) stays exact with
-- no change to it. Additive: until a header carries a discount every share is
-- 0 and every figure is exactly what it was.
--
--   * finance_invoices and finance_quotations gain doc_discount_pct (0-100,
--     above 0) and doc_discount_amount (above 0), at most one set. Their
--     table-level grants to authenticated cover the new columns, as they
--     covered the line discount of 20261118100000.
--   * finance_invoice_lines and finance_quotation_lines gain
--     doc_discount_share, written only by private.finance_doc_discount_split.
--   * The four generated money columns of each line table are re-expressed in
--     place (ALTER COLUMN ... SET EXPRESSION). With v the line net of its own
--     discount (the CASE of 20261118100000) and s its share:
--       amount          round(v, 2) - s
--       sst_amount      round(greatest(v - s, 0) * sst_rate / 100, 2)
--       amount_myr      round((round(v, 2) - s) * fx_rate, 2)
--       sst_amount_myr  round(round(greatest(v - s, 0) * sst_rate / 100, 2) * fx_rate, 2)
--     amount is round(v, 2) - s rather than round(v - s, 2): a line of
--     0.5 x 0.01 nets 0.01 while v = 0.005, and with its whole net as its share
--     round(v - s, 2) would be -0.01. With s = 0 each is exactly the figure of
--     20261118100000 / 20261119160000 / 20261120100000 (v is never below 0).
--   * The split (the document's lines' nets in sen, integers throughout):
--     D = round(sum * pct / 100, 2) or the fixed amount, at most the sum;
--     share = floor(D * net / sum) to the sen, and the sen left over go one each
--     to the largest remainders, ties to the lower position, then lower id.
--     The shares add up to D exactly and none exceeds its line's net.
--   * Triggers keep the shares right whoever writes (PostgREST or a function):
--       - a share a caller sends is ignored (BEFORE, on each line table);
--       - a line inserted, deleted, moved or with its figures changed re-splits
--         its document (AFTER, per row, immediate, so totals are right before
--         anything later in the same transaction, posting included);
--       - a draft's header discount changed re-splits it (AFTER).
--     The split's own writes set only doc_discount_share, which is not among
--     the columns the AFTER line trigger listens to, so it never re-fires.
--   * FIN62 at commit (a deferred constraint trigger): a draft whose discount
--     takes all of its lines' net (D >= the sum, including any discount on lines
--     that net to 0). Deferred, so a save that deletes its lines and inserts them
--     again is only judged once it has finished. A line inserted queues no check:
--     it only adds to the net; the header's own events and a line's delete or
--     update cover every way the net can fall below D.
--   * A later migration that writes invoice or quotation lines and then ALTERs a
--     line table in the same transaction must run "set constraints all
--     immediate" first, or the ALTER fails on the pending FIN62 events.
--
-- Nothing here is granted to service_role: no worker touches these tables.

-- Fail fast instead of queueing behind a long transaction and stalling sign-ins.
set local lock_timeout = '5s';

-- ---- header columns -------------------------------------------------------------
alter table public.finance_invoices
  add column doc_discount_pct numeric(5,2) check (doc_discount_pct > 0 and doc_discount_pct <= 100),
  add column doc_discount_amount numeric(14,2) check (doc_discount_amount > 0),
  add constraint finance_invoices_one_doc_discount check (num_nonnulls(doc_discount_pct, doc_discount_amount) <= 1);

alter table public.finance_quotations
  add column doc_discount_pct numeric(5,2) check (doc_discount_pct > 0 and doc_discount_pct <= 100),
  add column doc_discount_amount numeric(14,2) check (doc_discount_amount > 0),
  add constraint finance_quotations_one_doc_discount check (num_nonnulls(doc_discount_pct, doc_discount_amount) <= 1);

-- ---- line share ---------------------------------------------------------------------
alter table public.finance_invoice_lines
  add column doc_discount_share numeric(14,2) not null default 0 check (doc_discount_share >= 0);

alter table public.finance_quotation_lines
  add column doc_discount_share numeric(14,2) not null default 0 check (doc_discount_share >= 0);

-- ---- generated columns, after the share -----------------------------------------------
-- One statement per table, so each is rewritten once.
alter table public.finance_invoice_lines
  alter column amount set expression as (
    round(
      case
        when discount_pct is not null then quantity * unit_price * (1 - discount_pct / 100)
        when discount_amount is not null then greatest(quantity * unit_price - discount_amount, 0)
        else quantity * unit_price
      end, 2) - doc_discount_share
  ),
  alter column sst_amount set expression as (
    round(
      greatest(
        (case
          when discount_pct is not null then quantity * unit_price * (1 - discount_pct / 100)
          when discount_amount is not null then greatest(quantity * unit_price - discount_amount, 0)
          else quantity * unit_price
        end) - doc_discount_share, 0) * sst_rate / 100, 2)
  ),
  alter column amount_myr set expression as (
    round(
      (round(
        case
          when discount_pct is not null then quantity * unit_price * (1 - discount_pct / 100)
          when discount_amount is not null then greatest(quantity * unit_price - discount_amount, 0)
          else quantity * unit_price
        end, 2) - doc_discount_share) * fx_rate, 2)
  ),
  alter column sst_amount_myr set expression as (
    round(
      round(
        greatest(
          (case
            when discount_pct is not null then quantity * unit_price * (1 - discount_pct / 100)
            when discount_amount is not null then greatest(quantity * unit_price - discount_amount, 0)
            else quantity * unit_price
          end) - doc_discount_share, 0) * sst_rate / 100, 2) * fx_rate, 2)
  );

alter table public.finance_quotation_lines
  alter column amount set expression as (
    round(
      case
        when discount_pct is not null then quantity * unit_price * (1 - discount_pct / 100)
        when discount_amount is not null then greatest(quantity * unit_price - discount_amount, 0)
        else quantity * unit_price
      end, 2) - doc_discount_share
  ),
  alter column sst_amount set expression as (
    round(
      greatest(
        (case
          when discount_pct is not null then quantity * unit_price * (1 - discount_pct / 100)
          when discount_amount is not null then greatest(quantity * unit_price - discount_amount, 0)
          else quantity * unit_price
        end) - doc_discount_share, 0) * sst_rate / 100, 2)
  ),
  alter column amount_myr set expression as (
    round(
      (round(
        case
          when discount_pct is not null then quantity * unit_price * (1 - discount_pct / 100)
          when discount_amount is not null then greatest(quantity * unit_price - discount_amount, 0)
          else quantity * unit_price
        end, 2) - doc_discount_share) * fx_rate, 2)
  ),
  alter column sst_amount_myr set expression as (
    round(
      round(
        greatest(
          (case
            when discount_pct is not null then quantity * unit_price * (1 - discount_pct / 100)
            when discount_amount is not null then greatest(quantity * unit_price - discount_amount, 0)
            else quantity * unit_price
          end) - doc_discount_share, 0) * sst_rate / 100, 2) * fx_rate, 2)
  );

-- ---- the split ------------------------------------------------------------------------
-- Writes the shares of one document's lines. Does nothing for a document that
-- is gone (deleted, or its workspace deleted) or whose lines are frozen (an
-- invoice or a quotation no longer a draft: finance_invoice_line_guard and
-- finance_quotation_line_guard refuse every other status). Never raises: a
-- discount larger than the lines takes all of them, and FIN62 refuses it at
-- commit. Runs as the caller, so it writes only what the caller may.
create function private.finance_doc_discount_split(p_kind text, p_doc uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  h record;
  tbl text;
  fk text;
  shared boolean;
begin
  -- One split of a document at a time: two transactions writing lines of the
  -- same draft wait here, so the second splits over the first's lines and the
  -- shares always add up to D. Not FOR UPDATE on the header: the line guards
  -- take FOR SHARE on it, and the two would deadlock.
  perform pg_advisory_xact_lock(hashtextextended(p_kind || ':' || p_doc::text, 0));
  if p_kind = 'invoice' then
    select org_id, status, doc_discount_pct, doc_discount_amount into h
      from public.finance_invoices where id = p_doc;
    tbl := 'finance_invoice_lines';
    fk := 'invoice_id';
  elsif p_kind = 'quotation' then
    select org_id, status, doc_discount_pct, doc_discount_amount into h
      from public.finance_quotations where id = p_doc;
    tbl := 'finance_quotation_lines';
    fk := 'quotation_id';
  else
    return;
  end if;
  if not found or h.status <> 'draft' then
    return;
  end if;
  -- No discount and no share left to clear: nothing to do (every document
  -- without a discount, so all that existed before this migration).
  if num_nonnulls(h.doc_discount_pct, h.doc_discount_amount) = 0 then
    execute format('select exists (select 1 from public.%I where org_id = $1 and %I = $2 and doc_discount_share <> 0)', tbl, fk)
      into shared using h.org_id, p_doc;
    if not shared then
      return;
    end if;
  end if;

  -- Lets the share guard pass these writes; cleared straight after.
  perform set_config('openkuasa.doc_discount_split', '1', true);
  -- Everything in sen, as integers: n = a line's net, s = their sum, d = D.
  execute format($q$
    with l as (
      select id, position,
        round(
          case
            when discount_pct is not null then quantity * unit_price * (1 - discount_pct / 100)
            when discount_amount is not null then greatest(quantity * unit_price - discount_amount, 0)
            else quantity * unit_price
          end, 2) * 100 as n
      from public.%I
      where org_id = $1 and %I = $2
    ),
    t as (
      select coalesce(sum(n), 0) as s from l
    ),
    dd as (
      select t.s, least(
        case
          when $3::numeric is not null then round(t.s * $3::numeric / 100)
          when $4::numeric is not null then $4::numeric * 100
          else 0
        end, t.s) as d
      from t
    ),
    f as (
      select l.id, l.position, dd.d,
        case when dd.s > 0 then div(dd.d * l.n, dd.s) else 0 end as fl,
        case when dd.s > 0 then mod(dd.d * l.n, dd.s) else 0 end as rem
      from l cross join dd
    ),
    k as (
      select f.id, f.fl,
        f.d - sum(f.fl) over () as leftover,
        row_number() over (order by f.rem desc, f.position, f.id) as rk
      from f
    ),
    sh as (
      select id, ((fl + case when rk <= leftover then 1 else 0 end) / 100)::numeric(14,2) as share
      from k
    )
    update public.%I x
       set doc_discount_share = sh.share
      from sh
     where x.id = sh.id and x.doc_discount_share is distinct from sh.share
  $q$, tbl, fk, tbl)
  using h.org_id, p_doc, h.doc_discount_pct, h.doc_discount_amount;
  perform set_config('openkuasa.doc_discount_split', '', true);
end $$;

-- ---- a share a caller sends is ignored ------------------------------------------------
-- Named to fire after finance_*_line_guard, so a frozen document still answers
-- FIN01 first.
create function private.finance_doc_discount_share_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- The split's own update runs inside a trigger (depth 2 here); a caller's
  -- statement, or a function it calls, is at depth 1, flag or no flag.
  if coalesce(current_setting('openkuasa.doc_discount_split', true), '') = '1' and pg_trigger_depth() > 1 then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.doc_discount_share := 0;
  else
    new.doc_discount_share := old.doc_discount_share;
  end if;
  return new;
end $$;

create trigger finance_invoice_line_share
  before insert or update of doc_discount_share on public.finance_invoice_lines
  for each row execute function private.finance_doc_discount_share_guard();

create trigger finance_quotation_line_share
  before insert or update of doc_discount_share on public.finance_quotation_lines
  for each row execute function private.finance_doc_discount_share_guard();

-- ---- a line changed: its document is split again -----------------------------------------
create function private.finance_doc_discount_line_split()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  kind text := case when tg_table_name = 'finance_invoice_lines' then 'invoice' else 'quotation' end;
  fk text := case when tg_table_name = 'finance_invoice_lines' then 'invoice_id' else 'quotation_id' end;
  old_doc uuid;
  new_doc uuid;
begin
  -- Read through jsonb: a record field is checked when it is reached, and each
  -- table has only its own document column.
  if tg_op <> 'INSERT' then
    old_doc := (to_jsonb(old) ->> fk)::uuid;
    perform private.finance_doc_discount_split(kind, old_doc);
  end if;
  if tg_op <> 'DELETE' then
    new_doc := (to_jsonb(new) ->> fk)::uuid;
    if new_doc is distinct from old_doc then
      perform private.finance_doc_discount_split(kind, new_doc);
    end if;
  end if;
  return null;
end $$;

create trigger finance_invoice_line_split
  after insert or delete or update of quantity, unit_price, discount_pct, discount_amount, sst_rate, position, invoice_id
  on public.finance_invoice_lines
  for each row execute function private.finance_doc_discount_line_split();

create trigger finance_quotation_line_split
  after insert or delete or update of quantity, unit_price, discount_pct, discount_amount, sst_rate, position, quotation_id
  on public.finance_quotation_lines
  for each row execute function private.finance_doc_discount_line_split();

-- ---- a header's discount changed: its lines are split again ----------------------------
-- Only a draft's discount changes: a posted invoice or a sent quotation is
-- refused by its guard (FIN01) before this. A draft posted or sent in the same
-- update that changes its discount is refused too, as its lines are frozen by
-- then and could not take the new shares.
create function private.finance_doc_discount_header_split()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  kind text := case when tg_table_name = 'finance_invoices' then 'invoice' else 'quotation' end;
begin
  if new.status <> 'draft' then
    raise exception 'change the discount on the draft, then %', case when kind = 'invoice' then 'post it' else 'send it' end
      using errcode = 'FIN01';
  end if;
  perform private.finance_doc_discount_split(kind, new.id);
  return null;
end $$;

create trigger finance_invoice_doc_discount_split
  after update of doc_discount_pct, doc_discount_amount on public.finance_invoices
  for each row
  when (new.doc_discount_pct is distinct from old.doc_discount_pct
        or new.doc_discount_amount is distinct from old.doc_discount_amount)
  execute function private.finance_doc_discount_header_split();

create trigger finance_quotation_doc_discount_split
  after update of doc_discount_pct, doc_discount_amount on public.finance_quotations
  for each row
  when (new.doc_discount_pct is distinct from old.doc_discount_pct
        or new.doc_discount_amount is distinct from old.doc_discount_amount)
  execute function private.finance_doc_discount_header_split();

-- ---- FIN62, at commit -------------------------------------------------------------------
-- Runs as the owner so the document is always seen, whatever role commits.
-- Reads only; a document that is gone, not a draft, or without a discount passes.
create function private.finance_doc_discount_check()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  kind text;
  docs uuid[];
  doc uuid;
  h record;
  s numeric;
  d numeric;
begin
  if tg_table_name in ('finance_invoices', 'finance_invoice_lines') then
    kind := 'invoice';
  else
    kind := 'quotation';
  end if;
  -- A line moved to another document is judged in both.
  if tg_table_name in ('finance_invoices', 'finance_quotations') then
    docs := array[new.id];
  elsif tg_op = 'DELETE' then
    docs := array[(to_jsonb(old) ->> (kind || '_id'))::uuid];
  elsif tg_op = 'UPDATE' then
    docs := array[(to_jsonb(old) ->> (kind || '_id'))::uuid, (to_jsonb(new) ->> (kind || '_id'))::uuid];
  else
    docs := array[(to_jsonb(new) ->> (kind || '_id'))::uuid];
  end if;

  foreach doc in array docs loop
    if kind = 'invoice' then
      select org_id, status, doc_discount_pct, doc_discount_amount into h
        from public.finance_invoices where id = doc;
    else
      select org_id, status, doc_discount_pct, doc_discount_amount into h
        from public.finance_quotations where id = doc;
    end if;
    if not found or h.status <> 'draft' or num_nonnulls(h.doc_discount_pct, h.doc_discount_amount) = 0 then
      continue;
    end if;

    if kind = 'invoice' then
      select coalesce(sum(round(
        case
          when discount_pct is not null then quantity * unit_price * (1 - discount_pct / 100)
          when discount_amount is not null then greatest(quantity * unit_price - discount_amount, 0)
          else quantity * unit_price
        end, 2)), 0) into s
        from public.finance_invoice_lines where org_id = h.org_id and invoice_id = doc;
    else
      select coalesce(sum(round(
        case
          when discount_pct is not null then quantity * unit_price * (1 - discount_pct / 100)
          when discount_amount is not null then greatest(quantity * unit_price - discount_amount, 0)
          else quantity * unit_price
        end, 2)), 0) into s
        from public.finance_quotation_lines where org_id = h.org_id and quotation_id = doc;
    end if;
    d := coalesce(round(s * h.doc_discount_pct / 100, 2), h.doc_discount_amount);
    if d >= s then
      raise exception 'A discount on the whole document must leave something to pay.' using errcode = 'FIN62';
    end if;
  end loop;
  return null;
end $$;

-- A header with no discount queues nothing (WHEN), so a header-only write
-- leaves no pending event on the header table.
create constraint trigger finance_invoice_doc_discount_fits
  after insert or update of doc_discount_pct, doc_discount_amount on public.finance_invoices
  deferrable initially deferred
  for each row
  when (new.doc_discount_pct is not null or new.doc_discount_amount is not null)
  execute function private.finance_doc_discount_check();

create constraint trigger finance_quotation_doc_discount_fits
  after insert or update of doc_discount_pct, doc_discount_amount on public.finance_quotations
  deferrable initially deferred
  for each row
  when (new.doc_discount_pct is not null or new.doc_discount_amount is not null)
  execute function private.finance_doc_discount_check();

create constraint trigger finance_invoice_line_doc_discount_fits
  after delete or update of quantity, unit_price, discount_pct, discount_amount, invoice_id
  on public.finance_invoice_lines
  deferrable initially deferred
  for each row execute function private.finance_doc_discount_check();

create constraint trigger finance_quotation_line_doc_discount_fits
  after delete or update of quantity, unit_price, discount_pct, discount_amount, quotation_id
  on public.finance_quotation_lines
  deferrable initially deferred
  for each row execute function private.finance_doc_discount_check();

-- The split runs as the caller from the line and header triggers, so the
-- signed-in role calls it; the trigger functions themselves are not callable.
revoke all on function private.finance_doc_discount_split(text, uuid) from public, anon, authenticated, service_role;
grant execute on function private.finance_doc_discount_split(text, uuid) to authenticated;
revoke all on function private.finance_doc_discount_share_guard() from public, anon, authenticated, service_role;
revoke all on function private.finance_doc_discount_line_split() from public, anon, authenticated, service_role;
revoke all on function private.finance_doc_discount_header_split() from public, anon, authenticated, service_role;
revoke all on function private.finance_doc_discount_check() from public, anon, authenticated, service_role;

-- ---- self-check ---------------------------------------------------------------------------
do $$
declare
  n integer;
begin
  select count(*) into n from information_schema.columns
   where table_schema = 'public'
     and ((table_name in ('finance_invoices', 'finance_quotations') and column_name in ('doc_discount_pct', 'doc_discount_amount'))
       or (table_name in ('finance_invoice_lines', 'finance_quotation_lines') and column_name = 'doc_discount_share'));
  if n <> 6 then raise exception 'the document discount columns are incomplete (%)', n; end if;

  if not has_column_privilege('authenticated', 'public.finance_invoices', 'doc_discount_pct', 'update')
     or not has_column_privilege('authenticated', 'public.finance_invoices', 'doc_discount_amount', 'insert')
     or not has_column_privilege('authenticated', 'public.finance_quotations', 'doc_discount_pct', 'insert')
     or not has_column_privilege('authenticated', 'public.finance_quotations', 'doc_discount_amount', 'update') then
    raise exception 'authenticated cannot write the document discount';
  end if;

  select count(*) into n from pg_trigger
   where not tgisinternal and tgname in (
     'finance_invoice_line_share', 'finance_quotation_line_share',
     'finance_invoice_line_split', 'finance_quotation_line_split',
     'finance_invoice_doc_discount_split', 'finance_quotation_doc_discount_split');
  if n <> 6 then raise exception 'the document discount triggers are incomplete (%)', n; end if;
  select count(*) into n from pg_trigger
   where tgdeferrable and tginitdeferred and tgname in (
     'finance_invoice_doc_discount_fits', 'finance_quotation_doc_discount_fits',
     'finance_invoice_line_doc_discount_fits', 'finance_quotation_line_doc_discount_fits');
  if n <> 4 then raise exception 'the FIN62 constraint triggers are incomplete (%)', n; end if;

  select count(*) into n
    from pg_attribute a
    join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
   where a.attrelid in ('public.finance_invoice_lines'::regclass, 'public.finance_quotation_lines'::regclass)
     and a.attname in ('amount', 'sst_amount', 'amount_myr', 'sst_amount_myr')
     and a.attgenerated = 's'
     and pg_get_expr(d.adbin, d.adrelid) like '%doc_discount_share%';
  if n <> 8 then raise exception 'the generated money columns do not all take the share (%)', n; end if;
end $$;
