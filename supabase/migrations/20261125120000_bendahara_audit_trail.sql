-- Bendahara audit trail: the finance documents write their lifecycle to the shared activity log.
--
-- What it does:
--   1. activity_log gains three nullable columns, nothing backfilled: entity_type (e.g. finance_invoice),
--      entity_id (the document's id, no foreign key, so a deleted draft keeps its history) and details (a small
--      jsonb that always names its "event"), two checks on them and an index for the audit trail screen. Row-level
--      security, grants and the mfa_required policy are untouched: clients still only read the log.
--   2. private.finance_log(...): the one writer. It writes nothing when nobody is signed in (a seed, the service
--      role, the agent worker) or when the workspace itself is gone (a workspace being deleted cascades to its
--      drafts; those deletes log nothing and do not make the workspace delete fail).
--   3. AFTER triggers (finance_<table>_audit) on invoices, quotations, credit notes, supplier bills, supplier
--      credit notes, payments and transfers, expenses, contra entries, SST returns, SST return figures and SST
--      settings. They run after every BEFORE guard has passed, so a refused change logs nothing.
--   4. private.finance_journal_log (20261108093000), private.finance_purchase_order_log (20261106090000, its only
--      definition) and public.finance_post_fx_revaluation (20261123100000) are restated from their newest text, with
--      only their activity rows changed to go through private.finance_log with the entity fields; the journals'
--      trigger also fires on DELETE now, for a deleted draft.
--
-- It adds no behaviour beyond logging: every trigger returns null after an AFTER event and nothing it writes is read
-- by a guard. Safe to run once (it creates the triggers and the helper; a second run fails on them).

-- ============================================================================
-- 1. activity_log: the entity and its details
-- ============================================================================
alter table public.activity_log
  add column entity_type text,
  add column entity_id uuid,
  add column details jsonb;
alter table public.activity_log
  add constraint activity_log_entity_type_check check (entity_type is null or entity_type ~ '^[a-z_]+$'),
  add constraint activity_log_entity_details_check check (entity_type is null or (details is not null and details ? 'event'));
create index activity_log_org_entity_created_idx
  on public.activity_log (org_id, entity_type, created_at desc)
  where entity_type is not null;

-- ============================================================================
-- 2. the one writer
-- ============================================================================
-- Runs as the owner: the activity log is closed to the signed-in. The person is whoever is signed in; with nobody
-- signed in nothing is written (the rule of the three earlier emitters). A workspace that no longer exists (its
-- delete cascading to its drafts) gets nothing either: the row would fail its foreign key.
create function private.finance_log(p_org uuid, p_entity_type text, p_entity_id uuid, p_action text, p_target text,
  p_details jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
begin
  if me is null or not exists (select 1 from public.orgs o where o.id = p_org) then
    return;
  end if;
  insert into public.activity_log
    (org_id, actor_id, actor_name, action, target, category, audience, entity_type, entity_id, details)
  values (p_org, me, private.display_name(me), p_action, left(p_target, 200), 'data', 'members',
          p_entity_type, p_entity_id, p_details);
end $$;
revoke all on function private.finance_log(uuid, text, uuid, text, text, jsonb) from public, anon, authenticated, service_role;

-- ============================================================================
-- 3. the documents
-- ============================================================================

-- ---- sales invoices: posted, voided, a draft deleted ------------------------------------------------------------
create function private.finance_invoices_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.finance_invoices;
  what text;
  ev text;
  party text;
  tot numeric;
  tot_myr numeric;
begin
  if (select auth.uid()) is null then
    return null;
  end if;
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      return null;
    end if;
    r := old; what := 'Deleted a draft invoice'; ev := 'deleted';
  elsif new.status is not distinct from old.status then
    return null;
  elsif old.status = 'draft' and new.status = 'posted' then
    r := new; what := 'Posted an invoice'; ev := 'posted';
  elsif new.status = 'void' then
    r := new; what := 'Voided an invoice'; ev := 'voided';
  else
    return null;
  end if;

  select c.name into party from public.finance_contacts c where c.org_id = r.org_id and c.id = r.customer_id;
  if ev <> 'deleted' then
    select t.total, t.total_myr into tot, tot_myr from public.finance_invoice_totals t where t.org_id = r.org_id and t.id = r.id;
  end if;
  perform private.finance_log(r.org_id, 'finance_invoice', r.id, what, coalesce(r.invoice_no, party, 'a draft'),
    jsonb_strip_nulls(jsonb_build_object('event', ev, 'number', r.invoice_no, 'party', party, 'date', r.invoice_date,
      'amount', tot, 'currency', r.currency, 'amount_myr', tot_myr)));
  return null;
end $$;
revoke all on function private.finance_invoices_audit() from public, anon, authenticated, service_role;
create trigger finance_invoices_audit
  after update or delete on public.finance_invoices
  for each row execute function private.finance_invoices_audit();

-- ---- quotations: sent, accepted, declined, a draft deleted ------------------------------------------------------
-- An answer can be changed from one to the other until an invoice is made; each change is logged.
create function private.finance_quotations_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.finance_quotations;
  what text;
  ev text;
  party text;
begin
  if (select auth.uid()) is null then
    return null;
  end if;
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      return null;
    end if;
    r := old; what := 'Deleted a draft quotation'; ev := 'deleted';
  elsif new.status is not distinct from old.status then
    return null;
  elsif old.status = 'draft' and new.status = 'sent' then
    r := new; what := 'Sent a quotation'; ev := 'sent';
  elsif new.status = 'accepted' then
    r := new; what := 'Accepted a quotation'; ev := 'accepted';
  elsif new.status = 'declined' then
    r := new; what := 'Marked a quotation declined'; ev := 'declined';
  else
    return null;
  end if;

  select c.name into party from public.finance_contacts c where c.org_id = r.org_id and c.id = r.customer_id;
  perform private.finance_log(r.org_id, 'finance_quotation', r.id, what, coalesce(r.quotation_no, party, 'a draft'),
    jsonb_strip_nulls(jsonb_build_object('event', ev, 'number', r.quotation_no, 'party', party, 'date', r.quote_date)));
  return null;
end $$;
revoke all on function private.finance_quotations_audit() from public, anon, authenticated, service_role;
create trigger finance_quotations_audit
  after update or delete on public.finance_quotations
  for each row execute function private.finance_quotations_audit();

-- ---- credit notes: issued, voided, a draft deleted --------------------------------------------------------------
-- amount_myr is stored only for a note in another currency; a ringgit note's is its amount.
create function private.finance_credit_notes_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.finance_credit_notes;
  what text;
  ev text;
begin
  if (select auth.uid()) is null then
    return null;
  end if;
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      return null;
    end if;
    r := old; what := 'Deleted a draft credit note'; ev := 'deleted';
  elsif new.status is not distinct from old.status then
    return null;
  elsif old.status = 'draft' and new.status = 'issued' then
    r := new; what := 'Issued a credit note'; ev := 'issued';
  elsif new.status = 'void' then
    r := new; what := 'Voided a credit note'; ev := 'voided';
  else
    return null;
  end if;

  perform private.finance_log(r.org_id, 'finance_credit_note', r.id, what, coalesce(r.credit_note_no, 'a draft'),
    jsonb_strip_nulls(jsonb_build_object('event', ev, 'number', r.credit_note_no, 'amount', r.amount, 'currency', r.currency,
      'amount_myr', coalesce(r.amount_myr, case when r.currency = 'MYR' then r.amount end), 'date', r.credit_date)));
  return null;
end $$;
revoke all on function private.finance_credit_notes_audit() from public, anon, authenticated, service_role;
create trigger finance_credit_notes_audit
  after update or delete on public.finance_credit_notes
  for each row execute function private.finance_credit_notes_audit();

-- ---- supplier bills: posted, voided, a draft deleted ------------------------------------------------------------
create function private.finance_supplier_bills_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.supplier_bills;
  what text;
  ev text;
  party text;
begin
  if (select auth.uid()) is null then
    return null;
  end if;
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      return null;
    end if;
    r := old; what := 'Deleted a draft supplier bill'; ev := 'deleted';
  elsif new.status is not distinct from old.status then
    return null;
  elsif old.status = 'draft' and new.status = 'posted' then
    r := new; what := 'Posted a supplier bill'; ev := 'posted';
  elsif new.status = 'void' then
    r := new; what := 'Voided a supplier bill'; ev := 'voided';
  else
    return null;
  end if;

  select c.name into party from public.finance_contacts c where c.org_id = r.org_id and c.id = r.supplier_id;
  perform private.finance_log(r.org_id, 'finance_supplier_bill', r.id, what, coalesce(r.bill_no, party, 'a draft'),
    jsonb_strip_nulls(jsonb_build_object('event', ev, 'number', r.bill_no, 'party', party, 'date', r.bill_date)));
  return null;
end $$;
revoke all on function private.finance_supplier_bills_audit() from public, anon, authenticated, service_role;
create trigger finance_supplier_bills_audit
  after update or delete on public.supplier_bills
  for each row execute function private.finance_supplier_bills_audit();

-- ---- supplier credit notes: issued, voided, a draft deleted -----------------------------------------------------
create function private.finance_supplier_credit_notes_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.finance_supplier_credit_notes;
  what text;
  ev text;
begin
  if (select auth.uid()) is null then
    return null;
  end if;
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      return null;
    end if;
    r := old; what := 'Deleted a draft supplier credit note'; ev := 'deleted';
  elsif new.status is not distinct from old.status then
    return null;
  elsif old.status = 'draft' and new.status = 'issued' then
    r := new; what := 'Issued a supplier credit note'; ev := 'issued';
  elsif new.status = 'void' then
    r := new; what := 'Voided a supplier credit note'; ev := 'voided';
  else
    return null;
  end if;

  perform private.finance_log(r.org_id, 'finance_supplier_credit_note', r.id, what, coalesce(r.credit_note_no, 'a draft'),
    jsonb_strip_nulls(jsonb_build_object('event', ev, 'number', r.credit_note_no, 'amount', r.amount, 'date', r.credit_date)));
  return null;
end $$;
revoke all on function private.finance_supplier_credit_notes_audit() from public, anon, authenticated, service_role;
create trigger finance_supplier_credit_notes_audit
  after update or delete on public.finance_supplier_credit_notes
  for each row execute function private.finance_supplier_credit_notes_audit();

-- ---- payments and transfers -------------------------------------------------------------------------------------
-- A payment (transfer_id null) logs: recorded (written posted, or posted from draft or pending approval), paid
-- (scheduled to posted), submitted (written or moved to pending approval), approved (pending approval to scheduled),
-- rejected, voided, and the delete of one that was never posted. Most RPCs write a draft and post it in the same
-- call; either way it is one "recorded".
-- A transfer is two rows sharing transfer_id; only its 'out' row logs, so a transfer is one row: recorded, voided.
-- amount_myr is stored only for money in another currency; a ringgit movement's is its amount.
create function private.finance_transactions_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.finance_transactions;
  what text;
  ev text;
  party text;
  prior text := case when tg_op = 'UPDATE' then old.status end;
begin
  if (select auth.uid()) is null then
    return null;
  end if;
  r := case when tg_op = 'DELETE' then old else new end;

  if r.transfer_id is not null then
    if r.direction <> 'out' or tg_op = 'DELETE' then
      return null;
    end if;
    if r.status = 'posted' and prior is distinct from 'posted' then
      what := 'Recorded a transfer'; ev := 'recorded';
    elsif r.status = 'void' and prior is distinct from 'void' then
      what := 'Voided a transfer'; ev := 'voided';
    else
      return null;
    end if;
    perform private.finance_log(r.org_id, 'finance_transfer', r.id, what, coalesce(r.number, 'a transfer'),
      jsonb_strip_nulls(jsonb_build_object('event', ev, 'number', r.number, 'amount', r.amount, 'currency', r.currency,
        'date', r.txn_date)));
    return null;
  end if;

  if tg_op = 'DELETE' then
    if old.status not in ('draft', 'pending_approval', 'rejected') then
      return null;
    end if;
    what := 'Deleted a payment that was not posted'; ev := 'deleted';
  elsif r.status is not distinct from prior then
    return null;
  elsif r.status = 'posted' and (tg_op = 'INSERT' or prior in ('draft', 'pending_approval')) then
    what := case when r.direction = 'in' then 'Recorded money in' else 'Recorded money out' end; ev := 'recorded';
  elsif r.status = 'posted' and prior = 'scheduled' then
    what := 'Marked a payment paid'; ev := 'paid';
  elsif r.status = 'pending_approval' then
    what := 'Submitted a payment for approval'; ev := 'submitted';
  elsif r.status = 'scheduled' and prior = 'pending_approval' then
    what := 'Approved a payment'; ev := 'approved';
  elsif r.status = 'rejected' then
    what := 'Rejected a payment'; ev := 'rejected';
  elsif r.status = 'void' then
    what := case when r.direction = 'in' then 'Voided money in' else 'Voided money out' end; ev := 'voided';
  else
    return null;
  end if;

  select coalesce(r.party_name, c.name) into party
    from (select 1) one
    left join public.finance_contacts c on c.org_id = r.org_id and c.id = r.contact_id;
  perform private.finance_log(r.org_id, 'finance_payment', r.id, what, coalesce(r.number, party, 'a payment'),
    jsonb_strip_nulls(jsonb_build_object('event', ev, 'number', r.number, 'party', party, 'direction', r.direction,
      'date', r.txn_date, 'amount', r.amount, 'currency', r.currency,
      'amount_myr', coalesce(r.amount_myr, case when r.currency = 'MYR' then r.amount end))));
  return null;
end $$;
revoke all on function private.finance_transactions_audit() from public, anon, authenticated, service_role;
create trigger finance_transactions_audit
  after insert or update or delete on public.finance_transactions
  for each row execute function private.finance_transactions_audit();

-- ---- expenses: approved, rejected, a pending claim deleted ------------------------------------------------------
create function private.finance_expenses_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.finance_expenses;
  what text;
  ev text;
  party text;
begin
  if (select auth.uid()) is null then
    return null;
  end if;
  if tg_op = 'DELETE' then
    if old.status <> 'pending' then
      return null;
    end if;
    r := old; what := 'Deleted an expense claim'; ev := 'deleted';
  elsif new.status is not distinct from old.status then
    return null;
  elsif old.status = 'pending' and new.status = 'approved' then
    r := new; what := 'Approved an expense'; ev := 'approved';
  elsif old.status = 'pending' and new.status = 'rejected' then
    r := new; what := 'Rejected an expense'; ev := 'rejected';
  else
    return null;
  end if;

  select coalesce(r.vendor_name, c.name) into party
    from (select 1) one
    left join public.finance_contacts c on c.org_id = r.org_id and c.id = r.vendor_id;
  perform private.finance_log(r.org_id, 'finance_expense', r.id, what, coalesce(party, 'an expense'),
    jsonb_strip_nulls(jsonb_build_object('event', ev, 'party', party, 'amount', r.amount, 'date', r.expense_date)));
  return null;
end $$;
revoke all on function private.finance_expenses_audit() from public, anon, authenticated, service_role;
create trigger finance_expenses_audit
  after update or delete on public.finance_expenses
  for each row execute function private.finance_expenses_audit();

-- ---- contra entries: posted, voided, a draft deleted ------------------------------------------------------------
create function private.finance_contras_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.finance_contras;
  what text;
  ev text;
begin
  if (select auth.uid()) is null then
    return null;
  end if;
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      return null;
    end if;
    r := old; what := 'Deleted a draft contra entry'; ev := 'deleted';
  elsif new.status is not distinct from old.status then
    return null;
  elsif new.status = 'posted' then
    r := new; what := 'Posted a contra entry'; ev := 'posted';
  elsif new.status = 'void' then
    r := new; what := 'Voided a contra entry'; ev := 'voided';
  else
    return null;
  end if;

  perform private.finance_log(r.org_id, 'finance_contra', r.id, what, coalesce(r.contra_no, 'a draft'),
    jsonb_strip_nulls(jsonb_build_object('event', ev, 'number', r.contra_no, 'amount', r.amount, 'date', r.contra_date)));
  return null;
end $$;
revoke all on function private.finance_contras_audit() from public, anon, authenticated, service_role;
create trigger finance_contras_audit
  after update or delete on public.finance_contras
  for each row execute function private.finance_contras_audit();

-- ---- journals (restated from 20261108093000): posted, reversed; and now a draft deleted --------------------------
-- The pattern of private.finance_purchase_order_log (20261106090000): runs
-- after the guard has allowed the change, as the table's owner, because the
-- activity log is closed to the authenticated role. The person is whoever is
-- signed in; with nobody signed in (a migration) nothing is written.
create or replace function private.finance_journal_log()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
  what text := 'Posted a journal';
  about text := new.journal_no;
  original text;
begin
  -- 20261125120000: a draft deleted. Before, the trigger fired on update only.
  if tg_op = 'DELETE' then
    if me is null or old.status <> 'draft' then
      return null;
    end if;
    perform private.finance_log(old.org_id, 'finance_journal', old.id, 'Deleted a draft journal',
      coalesce(old.journal_no, 'a draft'),
      jsonb_strip_nulls(jsonb_build_object('event', 'deleted', 'number', old.journal_no, 'date', old.journal_date)));
    return null;
  end if;

  if me is null or new.status is not distinct from old.status or new.status <> 'posted' then
    return null;
  end if;
  if new.reverses_journal_id is not null then
    select j.journal_no into original from public.finance_journals j
    where j.org_id = new.org_id and j.id = new.reverses_journal_id;
    what := 'Reversed a journal';
    about := coalesce(original, 'a journal') || ', with ' || new.journal_no;
  end if;

  perform private.finance_log(new.org_id, 'finance_journal', new.id, what, about,
    jsonb_strip_nulls(jsonb_build_object('event', case when new.reverses_journal_id is not null then 'reversed' else 'posted' end,
      'number', new.journal_no, 'date', new.journal_date)));
  return null;
end $$;
revoke all on function private.finance_journal_log() from public, anon, authenticated, service_role;

drop trigger finance_journal_log on public.finance_journals;
create trigger finance_journal_log
  after update or delete on public.finance_journals
  for each row execute function private.finance_journal_log();

-- ---- purchase orders (restated from 20261106090000): the same six sentences ---------------------------------------
-- Runs after the guard has allowed the change, as the table's owner: the
-- activity log is closed to the authenticated role. The person is whoever is
-- signed in; with nobody signed in (a migration) nothing is written.
create or replace function private.finance_purchase_order_log()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
  what text;
  ev text;
  about text := coalesce(new.po_no, 'a draft');
  party text;
begin
  if me is null or new.status is not distinct from old.status then
    return null;
  end if;
  -- A draft that was never submitted has no number and nobody else saw it.
  if new.status = 'cancelled' and old.po_no is null then
    return null;
  end if;

  if old.status = 'draft' and new.status = 'pending_approval' then
    what := 'Submitted a purchase order for approval'; ev := 'submitted';
  elsif old.status = 'pending_approval' and new.status = 'approved' then
    what := 'Approved a purchase order'; ev := 'approved';
  elsif old.status = 'pending_approval' and new.status = 'draft' and new.rejected_at is distinct from old.rejected_at then
    what := 'Rejected a purchase order'; ev := 'rejected';
    about := about || ': ' || coalesce(new.rejection_reason, '');
  elsif old.status = 'pending_approval' and new.status = 'draft' then
    what := 'Withdrew a purchase order from approval'; ev := 'withdrew';
  elsif new.status = 'closed' then
    what := 'Closed a purchase order'; ev := 'closed';
  elsif new.status = 'cancelled' then
    what := 'Cancelled a purchase order'; ev := 'cancelled';
  else
    return null;
  end if;

  select c.name into party from public.finance_contacts c where c.org_id = new.org_id and c.id = new.supplier_id;
  perform private.finance_log(new.org_id, 'finance_purchase_order', new.id, what, about,
    jsonb_strip_nulls(jsonb_build_object('event', ev, 'number', new.po_no, 'party', party)));
  return null;
end $$;
revoke all on function private.finance_purchase_order_log() from public, anon, authenticated;

-- ---- SST returns: marked filed, unmarked ------------------------------------------------------------------------
-- No id: the row is the workspace, tax type and period. The target names them, e.g. "Service tax, Sep–Oct 2026".
create function private.finance_sst_return_label(p_tax_type text, p_period_start date)
returns text
language sql
stable
set search_path = ''
as $$
  select initcap(p_tax_type) || ' tax, '
      || case when extract(year from p_period_start) = extract(year from p_period_start + interval '1 month')
              then to_char(p_period_start, 'Mon') || chr(8211) || to_char(p_period_start + interval '1 month', 'Mon YYYY')
              else to_char(p_period_start, 'Mon YYYY') || chr(8211) || to_char(p_period_start + interval '1 month', 'Mon YYYY') end
$$;
revoke all on function private.finance_sst_return_label(text, date) from public, anon, authenticated, service_role;

create function private.finance_sst_returns_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.finance_sst_returns;
begin
  if (select auth.uid()) is null then
    return null;
  end if;
  r := case when tg_op = 'DELETE' then old else new end;
  perform private.finance_log(r.org_id, 'finance_sst_return', null,
    case when tg_op = 'DELETE' then 'Unmarked an SST return' else 'Marked an SST return filed' end,
    private.finance_sst_return_label(r.tax_type, r.period_start),
    jsonb_strip_nulls(jsonb_build_object('event', case when tg_op = 'DELETE' then 'unfiled' else 'filed' end,
      'tax_type', r.tax_type, 'period', r.period_start, 'filed_on', r.filed_on)));
  return null;
end $$;
revoke all on function private.finance_sst_returns_audit() from public, anon, authenticated, service_role;
create trigger finance_sst_returns_audit
  after insert or delete on public.finance_sst_returns
  for each row execute function private.finance_sst_returns_audit();

-- ---- SST return figures: saved (an update that changes no figure is skipped) ------------------------------------
-- updated_by and updated_at are stamped on every save, so only the figures are compared.
create function private.finance_sst_return_figures_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    return null;
  end if;
  if tg_op = 'UPDATE'
     and (new.cards_11e, new.deduction_13b, new.deduction_13c, new.bad_debt_13d, new.adjustment_13a)
         is not distinct from (old.cards_11e, old.deduction_13b, old.deduction_13c, old.bad_debt_13d, old.adjustment_13a) then
    return null;
  end if;
  perform private.finance_log(new.org_id, 'finance_sst_return', null, 'Saved SST return figures',
    private.finance_sst_return_label(new.tax_type, new.period_start),
    jsonb_build_object('event', 'saved', 'tax_type', new.tax_type, 'period', new.period_start));
  return null;
end $$;
revoke all on function private.finance_sst_return_figures_audit() from public, anon, authenticated, service_role;
create trigger finance_sst_return_figures_audit
  after insert or update on public.finance_sst_return_figures
  for each row execute function private.finance_sst_return_figures_audit();

-- ---- SST settings: changed (an update that changes no setting is skipped) ---------------------------------------
-- details.changed = {column: {from, to}} for each setting that changed (on the first save, from null).
create function private.finance_sst_settings_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  was jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) else '{}'::jsonb end;
  now_is jsonb := to_jsonb(new);
  changed jsonb;
begin
  if (select auth.uid()) is null then
    return null;
  end if;
  select jsonb_object_agg(k, jsonb_build_object('from', coalesce(was->k, 'null'::jsonb), 'to', now_is->k))
    into changed
    from unnest(array['period_start_month', 'service_tax_no', 'sales_tax_no', 'service_tax_basis']) as k
   where coalesce(was->k, 'null'::jsonb) is distinct from now_is->k;
  if changed is null then
    return null;
  end if;
  perform private.finance_log(new.org_id, 'finance_settings', null, 'Changed the SST settings', 'SST settings',
    jsonb_build_object('event', 'changed', 'changed', changed));
  return null;
end $$;
revoke all on function private.finance_sst_settings_audit() from public, anon, authenticated, service_role;
create trigger finance_sst_settings_audit
  after insert or update on public.finance_sst_settings
  for each row execute function private.finance_sst_settings_audit();

-- ============================================================================
-- 4. finance_post_fx_revaluation (restated from 20261123100000): its activity row gains the entity fields
-- ============================================================================
-- Posts a run: run = {"period_end": "2026-10-31", "rates": {...as above, BNM's or typed, never filled in here},
-- "expected": {"lines": 5, "net_gain": "-52.40", "digest": "<the preview's digest>"}}. Works the items out again, under a lock, and posts them only if
-- they are what the caller saw. Every figure stored is worked out here; the caller sends only the month end, the
-- rates (rounded to the ten places the tables keep) and what it expects (compared, never stored).
create or replace function public.finance_post_fx_revaluation(target_org uuid, run jsonb)
returns table (id uuid, revaluation_no text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  me uuid := (select auth.uid());
  pe date;
  later_no text;
  later_end date;
  items jsonb;
  missing text;
  exp_lines text;
  exp_net text;
  exp_digest text;
  dig text;
  net numeric;
  rid uuid := gen_random_uuid();
  no text;
  n integer;
begin
  -- Runs as the owner: who the caller is, first.
  if not private.is_org_writer(target_org) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not private.finance_may_sign_off(target_org) then
    raise exception 'an FX revaluation is posted by an owner or admin' using errcode = 'FIN14';
  end if;

  begin
    pe := nullif(run->>'period_end', '')::date;
  exception when others then
    pe := null;
  end;
  if pe is null or not isfinite(pe)
     or pe <> (date_trunc('month', pe) + interval '1 month' - interval '1 day')::date
     or pe > (now() at time zone 'Asia/Kuala_Lumpur')::date then
    raise exception 'a revaluation is at a month end on or before today' using errcode = 'FIN53';
  end if;

  -- Two posts for one workspace, one after the other; every statement below sees the other's run.
  perform pg_advisory_xact_lock(hashtextextended('finance_fx_revaluation:' || target_org::text, 0));

  -- Month ends are revalued in order (spec).
  select r.revaluation_no, r.period_end into later_no, later_end
  from public.finance_fx_revaluations r
  where r.org_id = target_org and r.period_end > pe
  order by r.period_end desc, r.posted_at desc
  limit 1;
  if later_no is not null then
    raise exception '% for % is already posted', later_no, later_end using errcode = 'FIN54';
  end if;

  -- One statement, so one snapshot: every step below reads items, never the books again.
  select coalesce(jsonb_agg(to_jsonb(x) order by x.kind, x.currency, x.reference, x.item_id), '[]'::jsonb),
         md5(coalesce(string_agg(private.finance_fx_digest_line(x.kind, x.item_id, x.currency, x.foreign_balance,
                                   x.carried_myr, x.revalued_myr, x.posted_myr), ',' order by x.kind, x.item_id::text), ''))
    into items, dig
  from private.finance_fx_revaluation_items(target_org, pe, run->'rates', false) x;

  select string_agg(distinct e->>'currency', ', ') into missing
  from jsonb_array_elements(items) e
  where (e->>'foreign_balance')::numeric <> 0 and e->>'rate' is null;
  if missing is not null then
    raise exception 'enter the closing rate for %', missing using errcode = 'FIN38';
  end if;

  if not exists (select 1 from jsonb_array_elements(items) e where (e->>'posted_myr')::numeric <> 0) then
    raise exception 'nothing to post: every foreign balance at % is already at these rates', pe using errcode = 'FIN56';
  end if;

  -- What the caller saw: the digest of every item (the preview's), the number of lines and the net gain, to the sen.
  -- Missing, or not an md5, a whole number and a signed amount of at most two decimals, is the same answer as
  -- different (FIN55).
  exp_lines := run->'expected'->>'lines';
  exp_net := run->'expected'->>'net_gain';
  exp_digest := run->'expected'->>'digest';
  select sum(case when e->>'kind' = 'bill' then -(e->>'posted_myr')::numeric else (e->>'posted_myr')::numeric end)
    into net
  from jsonb_array_elements(items) e;
  if jsonb_typeof(run->'expected') is distinct from 'object'
     or not coalesce(exp_lines ~ '^[0-9]{1,6}$', false)
     or not coalesce(exp_net ~ '^-?[0-9]{1,12}(\.[0-9]{1,2})?$', false)
     or not coalesce(exp_digest ~ '^[0-9a-f]{32}$', false)
     or exp_lines::integer <> jsonb_array_length(items)
     or exp_net::numeric <> net
     or exp_digest <> dig then
    raise exception 'the figures changed since they were shown' using errcode = 'FIN55';
  end if;

  no := public.finance_next_number(target_org, 'fx_revaluation');
  insert into public.finance_fx_revaluations (id, org_id, revaluation_no, period_end, posted_by)
  values (rid, target_org, no, pe, me);

  -- The rate of each currency with a foreign balance (every item of a currency carries the same one).
  insert into public.finance_fx_revaluation_rates (org_id, revaluation_id, currency, rate, rate_source, rate_date)
  select distinct target_org, rid, e->>'currency', (e->>'rate')::numeric, e->>'rate_source', (e->>'rate_date')::date
  from jsonb_array_elements(items) e
  where (e->>'foreign_balance')::numeric <> 0;

  -- The lines; the table's checks re-prove every figure.
  insert into public.finance_fx_revaluation_lines
    (org_id, revaluation_id, kind, invoice_id, bill_id, account_id, reference, party, currency,
     foreign_balance, rate, carried_myr, revalued_myr, difference, earlier_myr, posted_myr)
  select target_org, rid, x.kind,
         case when x.kind = 'invoice' then x.item_id end,
         case when x.kind = 'bill' then x.item_id end,
         case when x.kind = 'account' then x.item_id end,
         left(x.reference, 200), left(x.party, 200), x.currency,
         x.foreign_balance, x.rate, x.carried_myr, x.revalued_myr, x.difference, x.earlier_myr, x.posted_myr
  from jsonb_to_recordset(items) as x(kind text, item_id uuid, reference text, party text, currency text,
                                      foreign_balance numeric, rate numeric, carried_myr numeric,
                                      revalued_myr numeric, difference numeric, earlier_myr numeric, posted_myr numeric);

  -- Backstop: read back as stored, the run is what was shown (its digest, lines and net gain), and, for each of its
  -- items, every run for this month end together posted exactly the item's full difference.
  select count(*), coalesce(sum(ln.gain), 0),
         md5(coalesce(string_agg(private.finance_fx_digest_line(ln.kind, coalesce(ln.invoice_id, ln.bill_id, ln.account_id),
                                   ln.currency, ln.foreign_balance, ln.carried_myr, ln.revalued_myr, ln.posted_myr),
                                 ',' order by ln.kind, coalesce(ln.invoice_id, ln.bill_id, ln.account_id)::text), ''))
    into n, net, dig
  from public.finance_fx_revaluation_lines ln
  where ln.org_id = target_org and ln.revaluation_id = rid;
  if n <> exp_lines::integer or net <> exp_net::numeric or dig <> exp_digest or exists (
    select 1
    from public.finance_fx_revaluation_lines ln
    where ln.org_id = target_org and ln.revaluation_id = rid
      and ln.difference <> (
        select sum(o.posted_myr)
        from public.finance_fx_revaluation_lines o
        join public.finance_fx_revaluations rv on rv.org_id = o.org_id and rv.id = o.revaluation_id
        where o.org_id = target_org and rv.period_end = pe and o.kind = ln.kind
          and coalesce(o.invoice_id, o.bill_id, o.account_id) = coalesce(ln.invoice_id, ln.bill_id, ln.account_id))
  ) then
    raise exception 'the revaluation does not add up as stored' using errcode = 'FIN55';
  end if;

  -- The activity log is closed to the signed-in; private.finance_log runs as the owner (20261125120000: with the
  -- entity fields).
  perform private.finance_log(target_org, 'finance_fx_revaluation', rid, 'Posted an FX revaluation',
    no || ' for ' || to_char(pe, 'YYYY-MM-DD'),
    jsonb_build_object('event', 'posted', 'number', no, 'date', pe));

  return query select rid, no;
end $$;
revoke all on function public.finance_post_fx_revaluation(uuid, jsonb) from public, anon, service_role;
grant execute on function public.finance_post_fx_revaluation(uuid, jsonb) to authenticated;
