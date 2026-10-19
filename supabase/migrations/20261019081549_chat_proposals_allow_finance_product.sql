-- Finance chat writes could not be recorded: `chat_proposals.product` allowed only reach/crm/hire/people, not
-- 'finance'. So when the Bendahara/Tuah assistant prepared any finance change, recording the proposal failed with a
-- check_violation (SQLSTATE 23514) and the assistant reported it could not prepare the change — it never reached an
-- approval card. This hit every finance write tool (the fifteen added for RFQs, purchase orders and journals, and
-- the pre-existing finance writes). The unit/route tests mock the proposal store, so none caught it.
--
-- Widen the allowed products to include finance. Additive: every existing row is reach/crm/hire/people, all still
-- allowed, so no row is affected (verified: the widened constraint validates against the live table).
alter table public.chat_proposals drop constraint chat_proposals_product_check;
alter table public.chat_proposals add constraint chat_proposals_product_check
  check (product in ('reach', 'crm', 'hire', 'people', 'finance'));
