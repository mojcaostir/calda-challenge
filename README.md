# 🛒 Supabase E-Commerce Challenge

This project implements a simple e-commerce backend using:

- Supabase (Postgres + Auth + Edge Functions)
- Row Level Security (RLS)
- Order aggregation view
- Audit logging via triggers
- Edge Function for order creation
- Dev bootstrap flow for local reproducibility

---

## 🚀 Local Development Setup

### ✅ Prerequisites

- Docker running
- Node.js installed
- Supabase CLI installed (`supabase` works)

---

## 🔧 Step 1 — Start Supabase

```bash
supabase start
```

Verify:

```bash
supabase status
```

You should see:

- API running on `http://127.0.0.1:54321`
- Studio on `http://127.0.0.1:54323`
- Database on `postgresql://postgres:postgres@127.0.0.1:54322/postgres`

---

## 🗄 Step 2 — Apply Migrations + Seed Catalog

This recreates the database from scratch:

```bash
supabase db reset
```

This will:

- Apply all migrations
- Seed **catalog data only** (products, variants, inventory)

> Users and orders are NOT created here.

---

## ⚙️ Step 3 — Serve Edge Functions

Create:

```
supabase/.env
```

and copy the values from

```
supabase/.env.example
```

Then run:

```bash
supabase functions serve
```

Leave this running.

---

## 👤 Step 4 — Bootstrap Dev Users + Orders

Run once:

```bash
curl -X POST http://127.0.0.1:54321/functions/v1/dev-bootstrap \
  -H "x-bootstrap-secret: dev-only-secret"
```

This will create two users
[mojca.ostir@gmail.com](mailto:mojca.ostir@gmail.com),
[mojca.ostir+1@gmail.com](mailto:mojca.ostir+1@gmail.com). Password for both is
`Password123!`.

It will also create 3 orders (≥2 lines each).

This step is idempotent.

---

## 🔐 Step 5 — Login

```bash
curl -sS "http://127.0.0.1:54321/auth/v1/token?grant_type=password" \
  -H "apikey: sb_publishable_eJfB9gfVaiY8W-DlM9DDaw_i8TsVBhP" \
  -H "content-type: application/json" \
  -d '{"email":"mojca.ostir@gmail.com","password":"Password123!"}' \
  | jq -r '.access_token'
```

This prints only `access_token`.

---

## 🧾 Step 6 — Create an Order via Edge Function

AIn the following `curl` command apply `access_token`. Use the fixed shipping
address ID created by `dev-bootstrap`:

- `mojca.ostir@gmail.com` → `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`
- `mojca.ostir+1@gmail.com` → `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`

Use fixed variant IDs from `seed.sql`:

- `MUG-350` → `33333333-3333-4333-8333-333333333333`
- `TSHIRT-BASE` → `44444444-4444-4444-8444-444444444444`
- `NOTE-A5` → `55555555-5555-4555-8555-555555555555`
- `BOTTLE-750` → `66666666-6666-4666-8666-666666666666`
- `STICKERS-10` → `77777777-7777-4777-8777-777777777777`

```bash
curl -X POST http://127.0.0.1:54321/functions/v1/orders-create \
  -H "Authorization: Bearer <ACCESS_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "shipping_address_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "items": [
      { "variant_id": "33333333-3333-4333-8333-333333333333", "quantity": 1 },
      { "variant_id": "55555555-5555-4555-8555-555555555555", "quantity": 2 }
    ],
    "currency": "EUR",
    "shipping_cents": 499,
    "tax_cents": 0,
    "discount_cents": 0
  }'
```

---

## 🧹 Resetting Everything

If anything breaks:

```bash
supabase db reset
```

Then rerun:

```bash
curl -X POST http://127.0.0.1:54321/functions/v1/dev-bootstrap \
  -H "x-bootstrap-secret: dev-only-secret"
```

---

## ✅ Run Tests

Run the orders-create tests with:

```bash
deno test --allow-all supabase/functions/tests/orders-create-test.ts
```

---

## 🛑 Important

`dev-bootstrap` is:

- Local-only
- Secret-protected
- Not intended for production

---
