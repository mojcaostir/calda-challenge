-- =========================================================
-- soft_delete_lifecycle.sql
-- Goals:
--   1) Add hybrid soft-delete lifecycle for orders.
--   2) Hide soft-deleted orders and catalog rows from client read paths.
--   3) Soft-delete old terminal orders, then archive+purge later.
-- =========================================================

create extension if not exists pg_cron;

drop view if exists public.v_orders_with_items;
drop table if exists public.payments;
drop table if exists public.shipments;
drop type if exists payment_status;
drop type if exists shipment_status;

-- ---------------------------------------------------------
-- ORDERS: add soft-delete marker + supporting indexes
-- ---------------------------------------------------------
alter table public.orders
  add column if not exists deleted_at timestamptz;

create index if not exists ix_orders_deleted_at on public.orders(deleted_at);
create index if not exists ix_orders_user_created_active
  on public.orders(user_id, created_at)
  where deleted_at is null;

-- ---------------------------------------------------------
-- ARCHIVE TABLE: currency-aware archive rows for purged orders
-- ---------------------------------------------------------
create table if not exists public.order_cleanup_archive (
  id bigint generated always as identity primary key,
  period_start timestamptz not null,
  period_end timestamptz not null,
  deleted_orders_count int not null,
  total_cents bigint not null,
  currency text not null default 'UNKNOWN',
  executed_at timestamptz not null default now()
);

alter table public.order_cleanup_archive
  drop constraint if exists order_cleanup_archive_deleted_orders_count_nonnegative,
  drop constraint if exists order_cleanup_archive_total_cents_nonnegative,
  add constraint order_cleanup_archive_deleted_orders_count_nonnegative
    check (deleted_orders_count >= 0),
  add constraint order_cleanup_archive_total_cents_nonnegative
    check (total_cents >= 0);

create index if not exists ix_order_cleanup_archive_executed_at
  on public.order_cleanup_archive(executed_at);

create index if not exists ix_order_cleanup_archive_currency_executed_at
  on public.order_cleanup_archive(currency, executed_at);

alter table public.order_cleanup_archive enable row level security;

-- ---------------------------------------------------------
-- RLS: hide soft-deleted orders and related data from clients
-- ---------------------------------------------------------

-- ORDERS

drop policy if exists "orders_select_own" on public.orders;
create policy "orders_select_own"
on public.orders
for select
to authenticated
using (user_id = auth.uid() and deleted_at is null);

drop policy if exists "orders_update_own" on public.orders;
create policy "orders_update_own"
on public.orders
for update
to authenticated
using (user_id = auth.uid() and deleted_at is null)
with check (user_id = auth.uid());

-- Intentionally remove client hard-delete path.
drop policy if exists "orders_delete_own" on public.orders;

-- ORDER_LINES

drop policy if exists "order_lines_select_if_own_order" on public.order_lines;
create policy "order_lines_select_if_own_order"
on public.order_lines
for select
to authenticated
using (
  exists (
    select 1
    from public.orders o
    where o.id = order_lines.order_id
      and o.user_id = auth.uid()
      and o.deleted_at is null
  )
);

drop policy if exists "order_lines_insert_if_own_order" on public.order_lines;
create policy "order_lines_insert_if_own_order"
on public.order_lines
for insert
to authenticated
with check (
  exists (
    select 1
    from public.orders o
    where o.id = order_lines.order_id
      and o.user_id = auth.uid()
      and o.deleted_at is null
  )
);

drop policy if exists "order_lines_update_if_own_order" on public.order_lines;
create policy "order_lines_update_if_own_order"
on public.order_lines
for update
to authenticated
using (
  exists (
    select 1
    from public.orders o
    where o.id = order_lines.order_id
      and o.user_id = auth.uid()
      and o.deleted_at is null
  )
)
with check (
  exists (
    select 1
    from public.orders o
    where o.id = order_lines.order_id
      and o.user_id = auth.uid()
      and o.deleted_at is null
  )
);

drop policy if exists "order_lines_delete_if_own_order" on public.order_lines;
create policy "order_lines_delete_if_own_order"
on public.order_lines
for delete
to authenticated
using (
  exists (
    select 1
    from public.orders o
    where o.id = order_lines.order_id
      and o.user_id = auth.uid()
      and o.deleted_at is null
  )
);

-- CATALOG

drop policy if exists "products_select_authenticated" on public.products;
create policy "products_select_authenticated"
on public.products
for select
to authenticated
using (deleted_at is null);

drop policy if exists "product_variants_select_authenticated" on public.product_variants;
create policy "product_variants_select_authenticated"
on public.product_variants
for select
to authenticated
using (
  deleted_at is null
  and exists (
    select 1
    from public.products p
    where p.id = product_variants.product_id
      and p.deleted_at is null
  )
);

-- ---------------------------------------------------------
-- VIEW: hide soft-deleted orders from aggregated order read model
-- ---------------------------------------------------------

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
) ol on true
where o.deleted_at is null;

-- ---------------------------------------------------------
-- MAINTENANCE FUNCTIONS
-- ---------------------------------------------------------

create or replace function public.soft_delete_old_orders()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows int;
begin
  update public.orders
  set deleted_at = now()
  where deleted_at is null
    and created_at < now() - interval '7 days'
    and status in ('paid', 'shipped', 'delivered', 'cancelled', 'refunded');

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

create or replace function public.archive_and_purge_soft_deleted_orders()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows int;
begin
  with purged_orders as (
    delete from public.orders o
    where o.deleted_at is not null
      and o.deleted_at < now() - interval '90 days'
    returning o.created_at, o.total_cents, o.currency
  ), archived as (
    insert into public.order_cleanup_archive (
      period_start,
      period_end,
      deleted_orders_count,
      total_cents,
      currency,
      executed_at
    )
    select
      min(created_at) as period_start,
      max(created_at) as period_end,
      count(*)::int as deleted_orders_count,
      coalesce(sum(total_cents), 0)::bigint as total_cents,
      currency,
      now() as executed_at
    from purged_orders
    group by currency
    returning deleted_orders_count
  )
  select coalesce(sum(deleted_orders_count), 0)
  into v_rows
  from archived;

  return v_rows;
end;
$$;

revoke all on function public.soft_delete_old_orders() from public;
revoke all on function public.soft_delete_old_orders() from anon;
revoke all on function public.soft_delete_old_orders() from authenticated;
grant execute on function public.soft_delete_old_orders() to service_role;

revoke all on function public.archive_and_purge_soft_deleted_orders() from public;
revoke all on function public.archive_and_purge_soft_deleted_orders() from anon;
revoke all on function public.archive_and_purge_soft_deleted_orders() from authenticated;
grant execute on function public.archive_and_purge_soft_deleted_orders() to service_role;

-- ---------------------------------------------------------
-- CRON JOBS (idempotent)
-- ---------------------------------------------------------
do $$
declare
  v_job_id int;
begin
  for v_job_id in
    select jobid
    from cron.job
    where jobname in ('order_soft_delete_daily', 'order_purge_archive_daily')
  loop
    perform cron.unschedule(v_job_id);
  end loop;

  perform cron.schedule(
    'order_soft_delete_daily',
    '10 0 * * *',
    'select public.soft_delete_old_orders();'
  );

  perform cron.schedule(
    'order_purge_archive_daily',
    '20 0 * * *',
    'select public.archive_and_purge_soft_deleted_orders();'
  );
end;
$$;
