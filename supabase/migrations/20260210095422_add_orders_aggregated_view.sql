-- =========================================================
-- VIEW: public.v_orders_with_items
-- Purpose:
--   - 1 row per order
--   - includes order columns (o.*)
--   - includes:
--       shipping_address (jsonb object)
--       billing_address  (jsonb object)
--       items     (jsonb array of order_lines)
-- Security:
--   - SECURITY INVOKER so underlying table RLS policies apply
-- =========================================================

drop view if exists public.v_orders_with_items;

create view public.v_orders_with_items
with (security_invoker = true)
as
select
  o.*,
  case
    when sa.id is null then null::jsonb
    else jsonb_build_object(
      'id', sa.id,
      'name', sa.name,
      'line1', sa.line1,
      'line2', sa.line2,
      'city', sa.city,
      'region', sa.region,
      'postal_code', sa.postal_code,
      'country', sa.country,
      'phone', sa.phone,
      'is_default_shipping', sa.is_default_shipping,
      'is_default_billing', sa.is_default_billing,
      'created_at', sa.created_at,
      'updated_at', sa.updated_at
    )
  end as shipping_address,

  case
    when ba.id is null then null::jsonb
    else jsonb_build_object(
      'id', ba.id,
      'name', ba.name,
      'line1', ba.line1,
      'line2', ba.line2,
      'city', ba.city,
      'region', ba.region,
      'postal_code', ba.postal_code,
      'country', ba.country,
      'phone', ba.phone,
      'is_default_shipping', ba.is_default_shipping,
      'is_default_billing', ba.is_default_billing,
      'created_at', ba.created_at,
      'updated_at', ba.updated_at
    )
  end as billing_address,
  ol.items

from public.orders o
left join public.addresses sa on sa.id = o.shipping_address_id
left join public.addresses ba on ba.id = o.billing_address_id

-- LATERAL: order_lines aggregation (avoids cartesian product with other 1:N joins)
left join lateral (
  select
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'order_line_id', l.id,
          'variant_id', l.variant_id,
          'sku', l.sku_snapshot,
          'title', l.title_snapshot,
          'quantity', l.quantity,
          'unit_price_cents', l.unit_price_cents,
          'line_subtotal_cents', l.line_subtotal_cents,
          'line_total_cents', l.line_total_cents,
          'created_at', l.created_at,
          'updated_at', l.updated_at
        )
        order by l.created_at
      ) filter (where l.id is not null),
      '[]'::jsonb
    ) as items
  from public.order_lines l
  where l.order_id = o.id
) ol on true;
