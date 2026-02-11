-- =========================================================
-- QUERY F (LOCAL-ONLY): Seed AUTH USERS + PROFILES + ADDRESSES
-- =========================================================




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

