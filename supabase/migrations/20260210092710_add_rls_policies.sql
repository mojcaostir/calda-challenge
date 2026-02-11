-- =========================================================
-- add_rls_policies.sql
-- Goals:
--   1) Only authenticated users can access data.
--   2) Orders (and dependent tables) are only visible/editable by the user who created them.
--   3) Catalog is readable to authenticated users; writes are blocked for authenticated users.
-- =========================================================

-- ---------------------------------------------------------
-- PROFILES (owner = auth.uid())
-- ---------------------------------------------------------
alter table public.profiles enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
on public.profiles
for select
to authenticated
using (id = auth.uid());

drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own"
on public.profiles
for insert
to authenticated
with check (id = auth.uid());

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
on public.profiles
for update
to authenticated
using (id = auth.uid())
with check (id = auth.uid());

drop policy if exists "profiles_delete_own" on public.profiles;
create policy "profiles_delete_own"
on public.profiles
for delete
to authenticated
using (id = auth.uid());


-- ---------------------------------------------------------
-- ADDRESSES (owner = auth.uid())
-- ---------------------------------------------------------
alter table public.addresses enable row level security;

drop policy if exists "addresses_select_own" on public.addresses;
create policy "addresses_select_own"
on public.addresses
for select
to authenticated
using (user_id = auth.uid());

drop policy if exists "addresses_insert_own" on public.addresses;
create policy "addresses_insert_own"
on public.addresses
for insert
to authenticated
with check (user_id = auth.uid());

drop policy if exists "addresses_update_own" on public.addresses;
create policy "addresses_update_own"
on public.addresses
for update
to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

drop policy if exists "addresses_delete_own" on public.addresses;
create policy "addresses_delete_own"
on public.addresses
for delete
to authenticated
using (user_id = auth.uid());


-- ---------------------------------------------------------
-- ORDERS (only creator can CRUD)
-- ---------------------------------------------------------
alter table public.orders enable row level security;

drop policy if exists "orders_select_own" on public.orders;
create policy "orders_select_own"
on public.orders
for select
to authenticated
using (user_id = auth.uid());

drop policy if exists "orders_insert_own" on public.orders;
create policy "orders_insert_own"
on public.orders
for insert
to authenticated
with check (user_id = auth.uid());

drop policy if exists "orders_update_own" on public.orders;
create policy "orders_update_own"
on public.orders
for update
to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

drop policy if exists "orders_delete_own" on public.orders;
create policy "orders_delete_own"
on public.orders
for delete
to authenticated
using (user_id = auth.uid());


-- ---------------------------------------------------------
-- ORDER_LINES (only for orders owned by user)
-- ---------------------------------------------------------
alter table public.order_lines enable row level security;

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
  )
)
with check (
  exists (
    select 1
    from public.orders o
    where o.id = order_lines.order_id
      and o.user_id = auth.uid()
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
  )
);


-- ---------------------------------------------------------
-- PAYMENTS (only for orders owned by user)
-- ---------------------------------------------------------
alter table public.payments enable row level security;

drop policy if exists "payments_select_if_own_order" on public.payments;
create policy "payments_select_if_own_order"
on public.payments
for select
to authenticated
using (
  exists (
    select 1
    from public.orders o
    where o.id = payments.order_id
      and o.user_id = auth.uid()
  )
);

drop policy if exists "payments_insert_if_own_order" on public.payments;
create policy "payments_insert_if_own_order"
on public.payments
for insert
to authenticated
with check (
  exists (
    select 1
    from public.orders o
    where o.id = payments.order_id
      and o.user_id = auth.uid()
  )
);

drop policy if exists "payments_update_if_own_order" on public.payments;
create policy "payments_update_if_own_order"
on public.payments
for update
to authenticated
using (
  exists (
    select 1
    from public.orders o
    where o.id = payments.order_id
      and o.user_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.orders o
    where o.id = payments.order_id
      and o.user_id = auth.uid()
  )
);

drop policy if exists "payments_delete_if_own_order" on public.payments;
create policy "payments_delete_if_own_order"
on public.payments
for delete
to authenticated
using (
  exists (
    select 1
    from public.orders o
    where o.id = payments.order_id
      and o.user_id = auth.uid()
  )
);


-- ---------------------------------------------------------
-- SHIPMENTS (only for orders owned by user)
-- ---------------------------------------------------------
alter table public.shipments enable row level security;

drop policy if exists "shipments_select_if_own_order" on public.shipments;
create policy "shipments_select_if_own_order"
on public.shipments
for select
to authenticated
using (
  exists (
    select 1
    from public.orders o
    where o.id = shipments.order_id
      and o.user_id = auth.uid()
  )
);

drop policy if exists "shipments_insert_if_own_order" on public.shipments;
create policy "shipments_insert_if_own_order"
on public.shipments
for insert
to authenticated
with check (
  exists (
    select 1
    from public.orders o
    where o.id = shipments.order_id
      and o.user_id = auth.uid()
  )
);

drop policy if exists "shipments_update_if_own_order" on public.shipments;
create policy "shipments_update_if_own_order"
on public.shipments
for update
to authenticated
using (
  exists (
    select 1
    from public.orders o
    where o.id = shipments.order_id
      and o.user_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.orders o
    where o.id = shipments.order_id
      and o.user_id = auth.uid()
  )
);

drop policy if exists "shipments_delete_if_own_order" on public.shipments;
create policy "shipments_delete_if_own_order"
on public.shipments
for delete
to authenticated
using (
  exists (
    select 1
    from public.orders o
    where o.id = shipments.order_id
      and o.user_id = auth.uid()
  )
);


-- ---------------------------------------------------------
-- CATALOG: authenticated users can READ only
-- (Writes should be done via backend/service role, not clients.)
-- ---------------------------------------------------------
alter table public.products enable row level security;

drop policy if exists "products_select_authenticated" on public.products;
create policy "products_select_authenticated"
on public.products
for select
to authenticated
using (true);

alter table public.product_variants enable row level security;

drop policy if exists "product_variants_select_authenticated" on public.product_variants;
create policy "product_variants_select_authenticated"
on public.product_variants
for select
to authenticated
using (true);

-- Inventory: choose READ-only for authenticated.
alter table public.inventory enable row level security;

drop policy if exists "inventory_select_authenticated" on public.inventory;
create policy "inventory_select_authenticated"
on public.inventory
for select
to authenticated
using (true);

-- Inventory movements: internal. No policies => authenticated cannot access.
alter table public.inventory_movements enable row level security;

drop policy if exists "inventory_movements_select_authenticated" on public.inventory_movements;
-- (intentionally no SELECT policy)

-- Product audit log: internal. No policies => authenticated cannot access.
alter table public.product_audit_log enable row level security;

drop policy if exists "product_audit_log_select_authenticated" on public.product_audit_log;
-- (intentionally no SELECT policy)

