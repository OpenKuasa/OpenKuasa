-- Bendahara multi-currency, stage 1: Bank Negara Malaysia's exchange rates
-- (docs/superpowers/specs/2026-10-15-bendahara-multi-currency-design.md,
-- "Rates" and "Fetching the rates"). Additive: two new tables and one view,
-- which no deployed code reads until this stage's code is deployed. No
-- finance figure, document or ledger line changes.
--
--   * finance_fx_rates: BNM's published rates, one row per currency, rate
--     date and session. One table for every workspace: the rates are public.
--     Every signed-in person reads it. Only service_role writes it, and only
--     by INSERT (POST /api/finance/fx-rates/fetch inserts with ON CONFLICT DO
--     NOTHING); it has no UPDATE, DELETE or TRUNCATE, so a stored rate, which
--     a document may already have used, never changes under it.
--   * finance_fx_latest_rates: the newest 1700 rate of each currency, for the
--     Banking card and for the route's "what is missing" question.
--   * finance_fx_fetch_state: one row, the route's memory between calls: when
--     it last asked BNM for the latest rates, and the next month each
--     currency's back-fill will fetch. service_role only; no signed-in person
--     reads or writes it.
--
-- service_role has no default privileges on public tables in this project, so
-- each is granted below by name. Until now service_role held nothing on any
-- finance relation (20261116110000 revoked it from all of them);
-- supabase/tests/bendahara_archived_account_check.sql is changed in the same
-- pull request to name these three as the only finance relations it may hold
-- anything on.

-- Fail fast instead of queueing behind a long transaction and stalling sign-ins.
set local lock_timeout = '5s';

-- ---- rates ---------------------------------------------------------------------
-- rate_date is the date BNM gives the rate for (rate.date), not the day it was
-- fetched. buying_rate, selling_rate and middle_rate are ringgit per `unit`,
-- as published (SDR has no buying or selling rate). rate is ringgit per ONE
-- unit: middle_rate / unit, to 10 decimals, since 1 VND is about RM 0.000158.
-- NaN is greater than every number in Postgres, so each "above 0" names it.
create table public.finance_fx_rates (
  source text not null default 'bnm' check (source = 'bnm'),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  rate_date date not null,
  session text not null check (session in ('0900', '1130', '1200', '1700')),
  unit integer not null check (unit > 0),
  buying_rate numeric(14,6) check (buying_rate > 0 and buying_rate <> 'NaN'),
  selling_rate numeric(14,6) check (selling_rate > 0 and selling_rate <> 'NaN'),
  middle_rate numeric(14,6) not null check (middle_rate > 0 and middle_rate <> 'NaN'),
  rate numeric(20,10) not null check (rate > 0 and rate <> 'NaN'),
  fetched_at timestamptz not null default now(),
  primary key (source, currency, rate_date, session)
);

alter table public.finance_fx_rates enable row level security;
-- Public data: any signed-in person, of any workspace, demo guests included.
create policy finance_fx_rates_select on public.finance_fx_rates
  for select to authenticated using (true);
create policy mfa_required on public.finance_fx_rates as restrictive
  for all to authenticated using ((select private.mfa_ok())) with check ((select private.mfa_ok()));
revoke all on public.finance_fx_rates from anon, authenticated, service_role;
grant select on public.finance_fx_rates to authenticated;
grant select, insert on public.finance_fx_rates to service_role;

-- ---- the newest rate of each currency --------------------------------------------
create view public.finance_fx_latest_rates with (security_invoker = true) as
select distinct on (r.currency)
  r.currency,
  r.rate_date,
  r.unit,
  r.buying_rate,
  r.selling_rate,
  r.middle_rate,
  r.rate,
  r.fetched_at
from public.finance_fx_rates r
where r.source = 'bnm' and r.session = '1700'
order by r.currency, r.rate_date desc;
revoke all on public.finance_fx_latest_rates from anon, authenticated, service_role;
grant select on public.finance_fx_latest_rates to authenticated, service_role;

-- ---- the route's memory ------------------------------------------------------------
-- One row (id is always true). backfill maps a currency code to the next
-- month to fetch, 'YYYY-MM'; a currency leaves it once its back-fill is done.
create table public.finance_fx_fetch_state (
  id boolean primary key default true check (id),
  last_attempt_at timestamptz,
  backfill jsonb not null default '{}'::jsonb check (jsonb_typeof(backfill) = 'object'),
  updated_at timestamptz not null default now()
);
-- Row-level security on and no policy: nobody signed in has a row. service_role bypasses it.
alter table public.finance_fx_fetch_state enable row level security;
revoke all on public.finance_fx_fetch_state from anon, authenticated, service_role;
grant select, insert, update on public.finance_fx_fetch_state to service_role;

-- ---- nothing was left out ------------------------------------------------------------
-- has_table_privilege, not the grants view: it answers what the role can do.
do $$
declare
  wrong text[] := '{}';
  t text;
  p text;
begin
  foreach t in array array['public.finance_fx_rates', 'public.finance_fx_latest_rates', 'public.finance_fx_fetch_state'] loop
    foreach p in array array['insert', 'update', 'delete', 'truncate', 'references', 'trigger'] loop
      if has_table_privilege('authenticated', t, p) then wrong := wrong || format('authenticated may %s %s', p, t); end if;
    end loop;
    foreach p in array array['select', 'insert', 'update', 'delete', 'truncate'] loop
      if has_table_privilege('anon', t, p) then wrong := wrong || format('anon may %s %s', p, t); end if;
    end loop;
    foreach p in array array['delete', 'truncate', 'references', 'trigger'] loop
      if has_table_privilege('service_role', t, p) then wrong := wrong || format('service_role may %s %s', p, t); end if;
    end loop;
  end loop;
  if has_table_privilege('service_role', 'public.finance_fx_rates', 'update') then wrong := wrong || 'service_role may update finance_fx_rates'::text; end if;
  if has_table_privilege('authenticated', 'public.finance_fx_fetch_state', 'select') then wrong := wrong || 'authenticated may read finance_fx_fetch_state'::text; end if;
  if not (has_table_privilege('service_role', 'public.finance_fx_rates', 'insert')
          and has_table_privilege('service_role', 'public.finance_fx_rates', 'select')
          and has_table_privilege('service_role', 'public.finance_fx_latest_rates', 'select')
          and has_table_privilege('service_role', 'public.finance_fx_fetch_state', 'update')
          and has_table_privilege('authenticated', 'public.finance_fx_latest_rates', 'select')) then
    wrong := wrong || 'a grant this file makes is missing'::text;
  end if;
  if array_length(wrong, 1) is not null then
    raise exception 'finance_fx privileges are not what this file sets: %', array_to_string(wrong, '; ');
  end if;
end $$;
