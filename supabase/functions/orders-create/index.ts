import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type CreateOrderItem = { variant_id: string; quantity: number };

type CreateOrderRequest = {
  shipping_address_id: string;
  billing_address_id?: string | null;
  currency?: string;
  shipping_cents?: number;
  tax_cents?: number;
  discount_cents?: number;
  status?: string;
  items: CreateOrderItem[];
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function getBearerToken(req: Request): string | null {
  const auth = req.headers.get("Authorization") ?? "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

serve(async (req) => {
  if (req.method !== "POST") {
    console.req("Method not allowed:", req.method);
    return json(405, { error: "Method Not Allowed" });
  }
    
  const token = getBearerToken(req);
  if (!token) return json(401, { error: "Missing Bearer token" });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  console.log("Using SUPABASE_URL from env: ", supabaseUrl);
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  console.log("Using SUPABASE_ANON_KEY from env:", anonKey);


  const supabase = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false },
  });

  // 1) Identify user
  const { data: userData, error: userErr } = await supabase.auth.getUser();
  if (userErr || !userData?.user) {
    console.error("User authentication failed:", userErr);
    return json(401, { error: "Invalid token" });
  }
    
  const userId = userData.user.id;

  // 2) Parse input
  let payload: CreateOrderRequest;
  try {
    payload = await req.json();
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  const items = payload.items ?? [];
  if (!payload.shipping_address_id) {
    return json(400, { error: "shipping_address_id is required" });
  }
  if (!Array.isArray(items) || items.length < 1) {
    return json(400, { error: "items must be a non-empty array" });
  }

  for (const it of items) {
    if (!it?.variant_id) {
      return json(400, { error: "Each item must have variant_id" });
    }
    if (!Number.isInteger(it.quantity) || it.quantity <= 0) {
      return json(400, {
        error: "Each item.quantity must be a positive integer",
      });
    }
  }

  const currency = payload.currency ?? "EUR";
  const shipping_cents = payload.shipping_cents ?? 0;
  const tax_cents = payload.tax_cents ?? 0;
  const discount_cents = payload.discount_cents ?? 0;
  const status = payload.status ?? "placed";

  // 3) Validate addresses belong to user (RLS enforces ownership)
  const { data: shipAddr, error: shipAddrErr } = await supabase
    .from("addresses")
    .select("id")
    .eq("id", payload.shipping_address_id)
    .maybeSingle();

  if (shipAddrErr) {
    return json(500, {
      error: "Address lookup failed",
      detail: shipAddrErr.message,
    });
  }
  if (!shipAddr) {
    return json(403, {
      error: "shipping_address_id not accessible for this user",
    });
  }

  const billingId = payload.billing_address_id ?? payload.shipping_address_id;

  const { data: billAddr, error: billAddrErr } = await supabase
    .from("addresses")
    .select("id")
    .eq("id", billingId)
    .maybeSingle();

  if (billAddrErr) {
    return json(500, {
      error: "Address lookup failed",
      detail: billAddrErr.message,
    });
  }
  if (!billAddr) {
    return json(403, {
      error: "billing_address_id not accessible for this user",
    });
  }

  // 4) Fetch variants + product titles for snapshots
  const variantIds = [...new Set(items.map((i) => i.variant_id))];

  const { data: variants, error: variantsErr } = await supabase
    .from("product_variants")
    .select("id, sku, price_cents, currency, product:products(title)")
    .in("id", variantIds);

  if (variantsErr) {
    return json(500, {
      error: "Variant lookup failed",
      detail: variantsErr.message,
    });
  }

  if (!variants || variants.length !== variantIds.length) {
    return json(400, { error: "One or more variant_id values are invalid" });
  }

  // Enforce single currency
  for (const v of variants) {
    if (v.currency !== currency) {
      return json(400, {
        error: "Currency mismatch",
        detail: `Variant ${v.sku} currency ${v.currency} != ${currency}`,
      });
    }
  }

  // 5) Compute totals and build order_lines payload
  let subtotal = 0;

  const lines = items.map((it) => {
    const v = variants.find((x) => x.id === it.variant_id)!;
    const unit = v.price_cents as number;
    const lineSubtotal = it.quantity * unit;
    subtotal += lineSubtotal;

    return {
      variant_id: v.id,
      sku_snapshot: v.sku,
      title_snapshot: v.product.title,
      quantity: it.quantity,
      unit_price_cents: unit,
      line_subtotal_cents: lineSubtotal,
      line_total_cents: lineSubtotal, // per-line discounts/tax omitted for simplicity
    };
  });

  const total = subtotal + shipping_cents + tax_cents - discount_cents;
  if (total < 0) {
    return json(400, { error: "total_cents must not be negative" });
  }

  // 6) Insert order
  const orderNumber = `ORD-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;

  const { data: order, error: orderErr } = await supabase
    .from("orders")
    .insert({
      order_number: orderNumber,
      user_id: userId,
      shipping_address_id: payload.shipping_address_id,
      billing_address_id: billingId,
      status,
      currency,
      subtotal_cents: subtotal,
      shipping_cents,
      tax_cents,
      discount_cents,
      total_cents: total,
    })
    .select("id, order_number, total_cents")
    .single();

  if (orderErr) {
    return json(500, {
      error: "Order insert failed",
      detail: orderErr.message,
    });
  }

  // 7) Insert order_lines (attach order_id)
  const orderLinesToInsert = lines.map((l) => ({ ...l, order_id: order.id }));

  const { error: linesErr } = await supabase
    .from("order_lines")
    .insert(orderLinesToInsert);

  if (linesErr) {
    // best-effort cleanup: hide partial order from active read paths
    await supabase
      .from("orders")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", order.id);
    return json(500, {
      error: "Order lines insert failed",
      detail: linesErr.message,
    });
  }

  // 8) Compute other orders sum
  const { data: otherOrders, error: otherErr } = await supabase
    .from("orders")
    .select("total_cents")
    .neq("id", order.id);

  if (otherErr) {
    return json(500, { error: "Aggregation failed", detail: otherErr.message });
  }

  const otherTotal = (otherOrders ?? []).reduce(
    (acc, r) => acc + (r.total_cents ?? 0),
    0,
  );

  // 9) Return
  return json(200, {
    order_id: order.id,
    order_number: order.order_number,
    total_cents: order.total_cents,
    other_orders_total_cents: otherTotal,
  });
});
