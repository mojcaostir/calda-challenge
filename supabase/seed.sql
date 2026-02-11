-- =========================================================
-- QUERY F (LOCAL-ONLY): Seed AUTH USERS + PROFILES + ADDRESSES
-- =========================================================

create extension if not exists pgcrypto;

do $$
declare
  user1 uuid := '11111111-1111-1111-1111-111111111111';
  user2 uuid := '22222222-2222-2222-2222-222222222222';
begin
  insert into auth.users (
    id, email, encrypted_password,
    email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data,
    aud, role,
    created_at, updated_at
  )
  values
    (
      user1,
      'mojca.ostir@gmail.com',
      crypt('Password123!', gen_salt('bf')),
      now(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      '{}'::jsonb,
      'authenticated',
      'authenticated',
      now(), now()
    ),
    (
      user2,
      'mojca.ostir+1@gmail.com',
      crypt('Password123!', gen_salt('bf')),
      now(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      '{}'::jsonb,
      'authenticated',
      'authenticated',
      now(), now()
    );


  insert into public.profiles (id, full_name, email)
  values
    (user1, 'Customer One', 'mojca.ostir@gmail.com'),
    (user2, 'Customer Two', 'mojca.ostir+1@gmail.com');

  if not exists (
    select 1 from public.addresses
    where user_id = user1 and is_default_shipping = true
  ) then
    insert into public.addresses (
      user_id, name, line1, city, region, postal_code, country, phone,
      is_default_shipping, is_default_billing
    ) values (
      user1, 'Customer One', 'Main Street 1', 'Ljubljana', 'SI', '1000', 'Slovenia', '+38600000001',
      true, true
    );
  end if;

  if not exists (
    select 1 from public.addresses
    where user_id = user2 and is_default_shipping = true
  ) then
    insert into public.addresses (
      user_id, name, line1, city, region, postal_code, country, phone,
      is_default_shipping, is_default_billing
    ) values (
      user2, 'Customer Two', 'Second Street 5', 'Maribor', 'SI', '2000', 'Slovenia', '+38600000002',
      true, true
    );
  end if;

end $$;


-- =========================================================
-- QUERY G: Seed CATALOG (5 products, 1 variant each, inventory)
-- =========================================================
with products_seed as (
  insert into public.products (title, description, status)
  values
    ('Coffee Mug', 'Ceramic mug, 350ml', 'active'),
    ('T-Shirt', 'Cotton t-shirt', 'active'),
    ('Notebook', 'A5 dotted notebook', 'active'),
    ('Water Bottle', 'Stainless steel bottle', 'active'),
    ('Sticker Pack', '10-pack stickers', 'active')
  returning id, title
),
variants_seed as (
  insert into public.product_variants (
    product_id, sku, title,
    price_cents, currency,
    track_inventory, low_stock_threshold
  )
  select
    p.id,
    case p.title
      when 'Coffee Mug' then 'MUG-350'
      when 'T-Shirt' then 'TSHIRT-BASE'
      when 'Notebook' then 'NOTE-A5'
      when 'Water Bottle' then 'BOTTLE-750'
      when 'Sticker Pack' then 'STICKERS-10'
    end,
    p.title || ' - Default',
    case p.title
      when 'Coffee Mug' then 1299
      when 'T-Shirt' then 1999
      when 'Notebook' then 799
      when 'Water Bottle' then 2499
      when 'Sticker Pack' then 499
    end,
    'EUR',
    true,
    5
  from products_seed p
  returning id, sku
)
insert into public.inventory (variant_id, on_hand, reserved)
select
  v.id,
  case v.sku
    when 'MUG-350' then 50
    when 'TSHIRT-BASE' then 30
    when 'NOTE-A5' then 100
    when 'BOTTLE-750' then 25
    when 'STICKERS-10' then 200
  end,
  0
from variants_seed v;

-- =========================================================
-- QUERY H: Seed ORDERS + ORDER_LINES (3 orders, ≥2 lines each)
-- =========================================================
with
u1 as (select id from public.profiles where email = 'mojca.ostir@gmail.com'),
u2 as (select id from public.profiles where email = 'mojca.ostir+1@gmail.com'),
a1 as (select id from public.addresses where user_id = (select id from u1) and is_default_shipping = true limit 1),
a2 as (select id from public.addresses where user_id = (select id from u2) and is_default_shipping = true limit 1),

mug as (select id, sku, price_cents from public.product_variants where sku = 'MUG-350'),
tee as (select id, sku, price_cents from public.product_variants where sku = 'TSHIRT-BASE'),
note as (select id, sku, price_cents from public.product_variants where sku = 'NOTE-A5'),
bottle as (select id, sku, price_cents from public.product_variants where sku = 'BOTTLE-750'),
stickers as (select id, sku, price_cents from public.product_variants where sku = 'STICKERS-10'),

orders_seed as (
  insert into public.orders (
    order_number, user_id,
    shipping_address_id, billing_address_id,
    status, currency,
    subtotal_cents, shipping_cents,
    tax_cents, discount_cents, total_cents
  )
  values
    (
      'ORD-1001', (select id from u1),
      (select id from a1), (select id from a1),
      'paid', 'EUR',
      2*(select price_cents from mug) + (select price_cents from note),
      499, 0, 0,
      2*(select price_cents from mug) + (select price_cents from note) + 499
    ),
    (
      'ORD-1002', (select id from u2),
      (select id from a2), (select id from a2),
      'placed', 'EUR',
      (select price_cents from tee) + 2*(select price_cents from stickers),
      399, 0, 200,
      (select price_cents from tee) + 2*(select price_cents from stickers) + 399 - 200
    ),
    (
      'ORD-1003', (select id from u1),
      (select id from a1), (select id from a1),
      'pending', 'EUR',
      (select price_cents from bottle) + (select price_cents from mug),
      499, 0, 0,
      (select price_cents from bottle) + (select price_cents from mug) + 499
    )
  returning id, order_number
)
insert into public.order_lines (
  order_id, variant_id,
  sku_snapshot, title_snapshot,
  quantity, unit_price_cents,
  line_subtotal_cents, line_total_cents
)
values
  ((select id from orders_seed where order_number='ORD-1001'), (select id from mug), 'MUG-350', 'Coffee Mug', 2, (select price_cents from mug), 2*(select price_cents from mug), 2*(select price_cents from mug)),
  ((select id from orders_seed where order_number='ORD-1001'), (select id from note), 'NOTE-A5', 'Notebook', 1, (select price_cents from note), (select price_cents from note), (select price_cents from note)),

  ((select id from orders_seed where order_number='ORD-1002'), (select id from tee), 'TSHIRT-BASE', 'T-Shirt', 1, (select price_cents from tee), (select price_cents from tee), (select price_cents from tee)),
  ((select id from orders_seed where order_number='ORD-1002'), (select id from stickers), 'STICKERS-10', 'Sticker Pack', 2, (select price_cents from stickers), 2*(select price_cents from stickers), 2*(select price_cents from stickers)),

  ((select id from orders_seed where order_number='ORD-1003'), (select id from bottle), 'BOTTLE-750', 'Water Bottle', 1, (select price_cents from bottle), (select price_cents from bottle), (select price_cents from bottle)),
  ((select id from orders_seed where order_number='ORD-1003'), (select id from mug), 'MUG-350', 'Coffee Mug', 1, (select price_cents from mug), (select price_cents from mug), (select price_cents from mug));

-- =========================================================
-- QUERY I: Seed PAYMENT (for ORD-1001)
-- =========================================================
insert into public.payments (
  order_id, provider, status,
  provider_payment_id, amount_cents,
  currency, idempotency_key,
  authorized_at, captured_at
)
select
  o.id,
  'stripe',
  'captured',
  'pi_test_123',
  o.total_cents,
  o.currency,
  'idem-ord-1001-1',
  now(), now()
from public.orders o
where o.order_number = 'ORD-1001';
