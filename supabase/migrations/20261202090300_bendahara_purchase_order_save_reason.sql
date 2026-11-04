-- Bendahara: save a draft purchase order and its supplier reason in one go (#236).
-- Additive, and safe to apply while the previous code is still deployed: nothing calls it until the app does.
--
-- The order screen saved a draft with finance_save_purchase_order, then wrote award_reason with a second request.
-- If the second write was refused (another tab submitted or cancelled the draft in between, so the reason lock
-- raised FIN01), the user saw a refusal while the new lines, dates and terms were already saved.
--
--   * public.finance_save_purchase_order_with_reason: finance_save_purchase_order, then the reason, in the same
--     transaction, so a refused reason undoes the save too. A null reason leaves the stored one as it is (the app
--     refuses to empty a set reason before it saves, and the reason lock refuses it here as well). The reason is
--     written only when it changes, so an unchanged one fires no trigger. Security invoker, like the save, so the
--     caller's own policies and the save's own checks apply.

create or replace function public.finance_save_purchase_order_with_reason(
  target_org uuid,
  purchase_order jsonb,
  lines jsonb,
  reason text
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  saved uuid;
begin
  saved := public.finance_save_purchase_order(target_org, purchase_order, lines);
  if reason is not null then
    update public.finance_purchase_orders o
       set award_reason = reason
     where o.org_id = target_org
       and o.id = saved
       and o.award_reason is distinct from reason;
  end if;
  return saved;
end $$;

revoke all on function public.finance_save_purchase_order_with_reason(uuid, jsonb, jsonb, text) from public, anon, service_role;
grant execute on function public.finance_save_purchase_order_with_reason(uuid, jsonb, jsonb, text) to authenticated;
