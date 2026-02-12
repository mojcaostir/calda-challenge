-- =========================================================
-- QUERY A: Setup (extensions)
-- =========================================================
create extension if not exists pgcrypto;

-- =========================================================
-- QUERY B: Enums
-- =========================================================
do $$
begin
  if not exists (select 1 from pg_type where typname = 'product_status') then
    create type product_status as enum ('draft','active','archived');
  end if;

  if not exists (select 1 from pg_type where typname = 'order_status') then
    create type order_status as enum ('pending','placed','paid','shipped','delivered','cancelled','refunded');
  end if;

  if not exists (select 1 from pg_type where typname = 'inventory_movement_reason') then
    create type inventory_movement_reason as enum ('restock','adjustment','reserve','release','purchase','cancel');
  end if;

  if not exists (select 1 from pg_type where typname = 'audit_entity_type') then
    create type audit_entity_type as enum ('products','product_variants');
  end if;

  if not exists (select 1 from pg_type where typname = 'audit_action') then
    create type audit_action as enum ('INSERT','UPDATE','DELETE');
  end if;
end $$;

-- =========================================================
-- QUERY C: Tables
-- =========================================================

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.addresses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text,
  line1 text not null,
  line2 text,
  city text not null,
  region text,
  postal_code text not null,
  country text not null,
  phone text,
  is_default_shipping boolean not null default false,
  is_default_billing boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  status product_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.product_variants (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  sku text not null,
  title text,
  price_cents int not null check (price_cents >= 0),
  currency text not null,
  track_inventory boolean not null default true,
  low_stock_threshold int,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.inventory (
  variant_id uuid primary key references public.product_variants(id) on delete cascade,
  on_hand int not null check (on_hand >= 0),
  reserved int not null check (reserved >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint reserved_not_more_than_on_hand check (reserved <= on_hand)
);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  order_number text not null,
  user_id uuid not null references auth.users(id) on delete restrict,
  shipping_address_id uuid references public.addresses(id) on delete set null,
  billing_address_id uuid references public.addresses(id) on delete set null,
  status order_status not null default 'pending',
  currency text not null,
  subtotal_cents int not null check (subtotal_cents >= 0),
  shipping_cents int not null check (shipping_cents >= 0),
  tax_cents int not null check (tax_cents >= 0),
  discount_cents int not null check (discount_cents >= 0),
  total_cents int not null check (total_cents >= 0),
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.order_lines (
  id uuid primary key default gen_random_uuid(),
  variant_id uuid not null references public.product_variants(id) on delete restrict,
  order_id uuid not null references public.orders(id) on delete cascade,
  sku_snapshot text not null,
  title_snapshot text not null,
  quantity int not null check (quantity > 0),
  unit_price_cents int not null check (unit_price_cents >= 0),
  line_subtotal_cents int not null check (line_subtotal_cents >= 0),
  line_total_cents int not null check (line_total_cents >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.inventory_movements (
  id bigint generated always as identity primary key,
  variant_id uuid not null references public.product_variants(id) on delete cascade,
  reason inventory_movement_reason not null,
  delta int not null,
  related_order_id uuid references public.orders(id) on delete set null,
  actor_user_id uuid references auth.users(id) on delete set null,
  metadata jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.product_audit_log (
  id bigint generated always as identity primary key,
  entity_type audit_entity_type not null,
  entity_id uuid not null,
  action audit_action not null,
  changed_by uuid references auth.users(id) on delete set null,
  old_row jsonb,
  new_row jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- =========================================================
-- QUERY D: Indexes / unique constraints
-- =========================================================
create unique index if not exists ux_profiles_email on public.profiles(email);

create index if not exists ix_addresses_user_id on public.addresses(user_id);
create unique index if not exists ux_addresses_default_shipping_per_user on public.addresses(user_id) where is_default_shipping = true;
create unique index if not exists ux_addresses_default_billing_per_user on public.addresses(user_id) where is_default_billing = true;
create index if not exists ix_addresses_user_default_shipping on public.addresses(user_id, is_default_shipping);
create index if not exists ix_addresses_user_default_billing on public.addresses(user_id, is_default_billing);

create index if not exists ix_products_status on public.products(status);
create unique index if not exists ux_products_title on public.products(title);
create index if not exists ix_products_deleted_at on public.products(deleted_at);

create unique index if not exists ux_product_variants_sku on public.product_variants(sku);
create index if not exists ix_product_variants_product_id on public.product_variants(product_id);
create index if not exists ix_product_variants_deleted_at on public.product_variants(deleted_at);

create unique index if not exists ux_orders_order_number on public.orders(order_number);
create index if not exists ix_orders_user_id on public.orders(user_id);
create index if not exists ix_orders_status on public.orders(status);
create index if not exists ix_orders_created_at on public.orders(created_at);
create index if not exists ix_orders_user_created_at on public.orders(user_id, created_at);

create index if not exists ix_order_lines_order_id on public.order_lines(order_id);
create index if not exists ix_order_lines_variant_id on public.order_lines(variant_id);
create unique index if not exists ux_order_lines_order_variant on public.order_lines(order_id, variant_id);

create index if not exists ix_inventory_movements_variant_created on public.inventory_movements(variant_id, created_at);
create index if not exists ix_inventory_movements_related_order_id on public.inventory_movements(related_order_id);

create index if not exists ix_product_audit_entity on public.product_audit_log(entity_type, entity_id);
create index if not exists ix_product_audit_created_at on public.product_audit_log(created_at);
create index if not exists ix_product_audit_changed_by on public.product_audit_log(changed_by);


-- =========================================================
-- QUERY E: triggers
-- =========================================================
create or replace function public.set_updated_at()
returns trigger 
language plpgsql 
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_profiles_updated_at on public.profiles;
create trigger trg_profiles_updated_at before update on public.profiles
for each row execute function public.set_updated_at();

drop trigger if exists trg_addresses_updated_at on public.addresses;
create trigger trg_addresses_updated_at before update on public.addresses
for each row execute function public.set_updated_at();

drop trigger if exists trg_products_updated_at on public.products;
create trigger trg_products_updated_at before update on public.products
for each row execute function public.set_updated_at();

drop trigger if exists trg_product_variants_updated_at on public.product_variants;
create trigger trg_product_variants_updated_at before update on public.product_variants
for each row execute function public.set_updated_at();

drop trigger if exists trg_inventory_updated_at on public.inventory;
create trigger trg_inventory_updated_at before update on public.inventory
for each row execute function public.set_updated_at();

drop trigger if exists trg_orders_updated_at on public.orders;
create trigger trg_orders_updated_at before update on public.orders
for each row execute function public.set_updated_at();

drop trigger if exists trg_order_lines_updated_at on public.order_lines;
create trigger trg_order_lines_updated_at before update on public.order_lines
for each row execute function public.set_updated_at();

drop trigger if exists trg_inventory_movements_updated_at on public.inventory_movements;
create trigger trg_inventory_movements_updated_at before update on public.inventory_movements
for each row execute function public.set_updated_at();

drop trigger if exists trg_product_audit_log_updated_at on public.product_audit_log;
create trigger trg_product_audit_log_updated_at before update on public.product_audit_log
for each row execute function public.set_updated_at();

create or replace function public.audit_product_entity()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_entity_type public.audit_entity_type;
  v_action public.audit_action;
  v_user uuid := auth.uid();
begin
  -- Map table name -> audit_entity_type enum
  v_entity_type :=
    case tg_table_name
      when 'products' then 'products'::public.audit_entity_type
      when 'product_variants' then 'product_variants'::public.audit_entity_type
      else null
    end;

  if v_entity_type is null then
    raise exception 'audit_product_entity() attached to unsupported table: %', tg_table_name;
  end if;

  -- Map TG_OP -> audit_action enum
  v_action :=
    case tg_op
      when 'INSERT' then 'INSERT'::public.audit_action
      when 'UPDATE' then 'UPDATE'::public.audit_action
      when 'DELETE' then 'DELETE'::public.audit_action
      else null
    end;

  if v_action is null then
    raise exception 'audit_product_entity() got unsupported TG_OP: %', tg_op;
  end if;

  if tg_op = 'INSERT' then
    insert into public.product_audit_log (
      entity_type, entity_id, action, changed_by, old_row, new_row
    )
    values (
      v_entity_type,
      new.id,
      v_action,
      v_user,
      null,
      to_jsonb(new)
    );
    return new;

  elsif tg_op = 'UPDATE' then
    insert into public.product_audit_log (
      entity_type, entity_id, action, changed_by, old_row, new_row
    )
    values (
      v_entity_type,
      new.id,
      v_action,
      v_user,
      to_jsonb(old),
      to_jsonb(new)
    );
    return new;

  elsif tg_op = 'DELETE' then
    insert into public.product_audit_log (
      entity_type, entity_id, action, changed_by, old_row, new_row
    )
    values (
      v_entity_type,
      old.id,
      v_action,
      v_user,
      to_jsonb(old),
      null
    );
    return old;
  end if;

  return null;
end;
$$;


drop trigger if exists trg_products_audit on public.products;
create trigger trg_products_audit after insert or update or delete on public.products
for each row execute function public.audit_product_entity();

drop trigger if exists trg_product_variants_audit on public.product_variants;
create trigger trg_product_variants_audit after insert or update or delete on public.product_variants
for each row execute function public.audit_product_entity();
