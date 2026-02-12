# 🛒 Supabase E-Commerce Challenge

This project implements a simple e-commerce backend using:

* Supabase (Postgres + Auth + Edge Functions)
* Row Level Security (RLS)
* Order aggregation view
* Audit logging via triggers
* Edge Function for order creation
* Dev bootstrap flow for local reproducibility

---

## 🚀 Local Development Setup

### ✅ Prerequisites

* Docker running
* Node.js installed
* Supabase CLI installed (`npx supabase` works)

---

## 🔧 Step 1 — Start Supabase

```bash
npx supabase start
```

Verify:

```bash
npx supabase status
```

You should see:

* API running on `http://127.0.0.1:54321`
* Studio on `http://127.0.0.1:54323`
* Database on `postgresql://postgres:postgres@127.0.0.1:54322/postgres`

---

## 🗄 Step 2 — Apply Migrations + Seed Catalog

This recreates the database from scratch:

```bash
npx supabase db reset
```

This will:

* Apply all migrations
* Seed **catalog data only** (products, variants, inventory)

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
npx supabase functions serve
```

Leave this running.

---

## 👤 Step 4 — Bootstrap Dev Users + Orders

Run once:

```bash
curl -X POST http://127.0.0.1:54321/functions/v1/dev-bootstrap \
  -H "x-bootstrap-secret: dev-only-secret"
```

This will create two users [mojca.ostir@gmail.com](mailto:mojca.ostir@gmail.com), [mojca.ostir+1@gmail.com](mailto:mojca.ostir+1@gmail.com). Password for both is `Password123!`.

It will also create 3 orders (≥2 lines each).

This step is idempotent.

---

## 🔐 Step 5 — Login

```bash
curl -sS "http://127.0.0.1:54321/auth/v1/token?grant_type=password" \
  -H "apikey: sb_publishable_eJfB9gfVaiY8W-DlM9DDaw_i8TsVBhP" \
  -H "content-type: application/json" \
  -d '{"email":"mojca.ostir@gmail.com","password":"Password123!"}'
```

Copy `access_token`.

---

## 🧾 Step 6 — Create an Order via Edge Function

Apply `access_token` and find order data in your local database.

```bash
curl -X POST http://127.0.0.1:54321/functions/v1/orders-create \
  -H "Authorization: Bearer <ACCESS_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "shipping_address_id": "<SHIPPINGING_ADRESS>",
    "items": [
      { "variant_id": "<VARIANT_ID_1>", "quantity": 1 },
      { "variant_id": "<VARIANT_ID_2>", "quantity": 2 }
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
npx supabase db reset
```

Then rerun:

```bash
curl -X POST http://127.0.0.1:54321/functions/v1/dev-bootstrap \
  -H "x-bootstrap-secret: dev-only-secret"
```

---

## 🧪 Useful Local URLs

Studio:

```
http://127.0.0.1:54323
```

REST:

```
http://127.0.0.1:54321/rest/v1
```

Edge Functions:

```
http://127.0.0.1:54321/functions/v1
```

---

## 🛑 Important

`dev-bootstrap` is:

* Local-only
* Secret-protected
* Not intended for production

---
