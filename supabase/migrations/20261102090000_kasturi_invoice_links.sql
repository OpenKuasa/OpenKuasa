-- Kasturi's links to Bendahara's invoices. Both live in Kasturi's own tables;
-- no Bendahara table, view, function or trigger is changed.
--
--   1. crm_contacts.finance_customer_id: the Bendahara customer a contact is
--      billed through. Several contacts (people at one company) can share one
--      customer. A contact's invoices are that customer's invoices.
--   2. crm_deal_invoices: which invoices belong to which deal. An invoice
--      belongs to at most one deal; a deal can have several. This is a table
--      of its own, not a column on finance_invoices, because a posted invoice
--      is locked by Bendahara's guard and could not take the link.
--
-- Both point at their target with (org_id, id), so a link can never reach
-- another workspace's record. Additive only; safe before or after the app
-- release that uses it.

alter table public.crm_contacts
  add column finance_customer_id uuid;

-- Deleting the customer in Bendahara unlinks the contact; only the link column
-- is cleared (the contact keeps its org_id).
alter table public.crm_contacts
  add constraint crm_contacts_finance_customer_fkey
  foreign key (org_id, finance_customer_id)
  references public.finance_contacts(org_id, id)
  on delete set null (finance_customer_id);

create index crm_contacts_finance_customer_id_idx
  on public.crm_contacts(finance_customer_id)
  where finance_customer_id is not null;

create table public.crm_deal_invoices (
  org_id uuid not null references public.orgs(id) on delete cascade,
  deal_id uuid not null,
  invoice_id uuid not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (invoice_id),
  foreign key (deal_id, org_id) references public.crm_deals(id, org_id) on delete cascade,
  -- A draft invoice deleted in Bendahara takes its link with it.
  foreign key (org_id, invoice_id) references public.finance_invoices(org_id, id) on delete cascade
);
alter table public.crm_deal_invoices enable row level security;

create index crm_deal_invoices_org_id_idx on public.crm_deal_invoices(org_id);
create index crm_deal_invoices_deal_id_idx on public.crm_deal_invoices(deal_id);

-- Same shape as the other crm_ tables: members read, writers change. A link
-- is replaced by deleting and inserting, so there is no update policy.
create policy crm_deal_invoices_select on public.crm_deal_invoices
  for select to authenticated using (private.is_org_member(org_id));
create policy crm_deal_invoices_insert on public.crm_deal_invoices
  for insert to authenticated with check (private.is_org_writer(org_id));
create policy crm_deal_invoices_delete on public.crm_deal_invoices
  for delete to authenticated using (private.is_org_writer(org_id));
create policy mfa_required on public.crm_deal_invoices as restrictive for all to authenticated
  using ((select private.mfa_ok())) with check ((select private.mfa_ok()));

revoke all on public.crm_deal_invoices from anon, authenticated;
grant select, insert, delete on public.crm_deal_invoices to authenticated;
