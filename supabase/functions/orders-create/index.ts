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

type InventoryMode = "reserve" | "purchase" | "none";

type StockQuantity = {
  variant_id: string;
  quantity: number;
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

async function softDeleteOrder(
  supabase: ReturnType<typeof createClient>,
  orderId: string,
) {
  await supabase
    .from("orders")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", orderId);
}

function inventoryModeForStatus(status: string): InventoryMode {
  if (status === "pending" || status === "placed") return "reserve";
  if (status === "paid" || status === "shipped" || status === "delivered") {
    return "purchase";
  }
  return "none";
}

function movementReasonForMode(mode: InventoryMode): "reserve" | "purchase" | null {
  if (mode === "reserve") return "reserve";
  if (mode === "purchase") return "purchase";
  return null;
}

function aggregateStockQuantities(lines: Array<{ variant_id: string; quantity: number }>): StockQuantity[] {
  const byVariant = new Map<string, number>();
  for (const l of lines) {
    byVariant.set(l.variant_id, (byVariant.get(l.variant_id) ?? 0) + l.quantity);
  }

  return Array.from(byVariant, ([variant_id, quantity]) => ({ variant_id, quantity }));
}

async function applyInventoryMutation(
  admin: ReturnType<typeof createClient>,
  quantities: StockQuantity[],
  mode: InventoryMode,
) {
  if (mode === "none" || quantities.length === 0) return;

  const variantIds = quantities.map((q) => q.variant_id);
  const { data: inventoryRows, error: inventoryErr } = await admin
    .from("inventory")
    .select("variant_id, on_hand, reserved")
    .in("variant_id", variantIds);

  if (inventoryErr) throw new Error(`Inventory lookup failed: ${inventoryErr.message}`);
  if (!inventoryRows || inventoryRows.length !== variantIds.length) {
    throw new Error("Inventory row missing for one or more variants");
  }

  const byVariant = new Map(
    inventoryRows.map((r) => [
      r.variant_id,
      { on_hand: r.on_hand as number, reserved: r.reserved as number },
    ]),
  );

  for (const q of quantities) {
    const current = byVariant.get(q.variant_id);
    if (!current) throw new Error(`Inventory row missing for variant ${q.variant_id}`);

    const available = current.on_hand - current.reserved;
    if (available < q.quantity) {
      throw new Error(`Insufficient stock for variant ${q.variant_id}`);
    }

    const nextOnHand = mode === "purchase" ? current.on_hand - q.quantity : current.on_hand;
    const nextReserved = mode === "reserve" ? current.reserved + q.quantity : current.reserved;

    const { data: updatedRow, error: updErr } = await admin
      .from("inventory")
      .update({ on_hand: nextOnHand, reserved: nextReserved })
      .eq("variant_id", q.variant_id)
      .eq("on_hand", current.on_hand)
      .eq("reserved", current.reserved)
      .select("variant_id")
      .maybeSingle();

    if (updErr) throw new Error(`Inventory update failed for ${q.variant_id}: ${updErr.message}`);
    if (!updatedRow) {
      throw new Error(`Inventory changed concurrently for ${q.variant_id}; retry request`);
    }
  }
}

async function rollbackInventoryMutation(
  admin: ReturnType<typeof createClient>,
  quantities: StockQuantity[],
  mode: InventoryMode,
) {
  if (mode === "none" || quantities.length === 0) return;

  const variantIds = quantities.map((q) => q.variant_id);
  const { data: inventoryRows, error: inventoryErr } = await admin
    .from("inventory")
    .select("variant_id, on_hand, reserved")
    .in("variant_id", variantIds);

  if (inventoryErr || !inventoryRows) {
    console.error("Inventory rollback lookup failed", inventoryErr?.message);
    return;
  }

  const byVariant = new Map(
    inventoryRows.map((r) => [
      r.variant_id,
      { on_hand: r.on_hand as number, reserved: r.reserved as number },
    ]),
  );

  for (const q of quantities) {
    const current = byVariant.get(q.variant_id);
    if (!current) continue;

    const nextOnHand = mode === "purchase" ? current.on_hand + q.quantity : current.on_hand;
    const nextReserved = mode === "reserve"
      ? Math.max(0, current.reserved - q.quantity)
      : current.reserved;

    const { error: updErr } = await admin
      .from("inventory")
      .update({ on_hand: nextOnHand, reserved: nextReserved })
      .eq("variant_id", q.variant_id);

    if (updErr) {
      console.error(`Inventory rollback failed for ${q.variant_id}:`, updErr.message);
    }
  }
}

serve(async (req) => {
  if (req.method !== "POST") {
    console.log("Method not allowed:", req.method);
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

  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!serviceRoleKey) {
    return json(500, { error: "SUPABASE_SERVICE_ROLE_KEY is not configured" });
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
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
    .select("id, sku, price_cents, currency, track_inventory, product:products(title)")
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
  const variantById = new Map((variants ?? []).map((v) => [v.id, v]));

  const lines = items.map((it) => {
    const v = variantById.get(it.variant_id)!;
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
    await softDeleteOrder(supabase, order.id);
    return json(500, {
      error: "Order lines insert failed",
      detail: linesErr.message,
    });
  }

  // 8) Apply inventory stock checks/updates for tracked variants.
  const inventoryMode = inventoryModeForStatus(status);
  const trackedLines = lines.filter((l) => {
    const v = variantById.get(l.variant_id);
    return v?.track_inventory ?? true;
  });
  const stockQuantities = aggregateStockQuantities(trackedLines);

  try {
    await applyInventoryMutation(admin, stockQuantities, inventoryMode);
  } catch (e) {
    await softDeleteOrder(supabase, order.id);
    return json(409, {
      error: "Inventory update failed",
      detail: (e as Error).message,
    });
  }

  // 9) Write inventory movement audit entries for this order
  const movementReason = movementReasonForMode(inventoryMode);
  if (movementReason && trackedLines.length > 0) {
    const movementRows = trackedLines.map((l) => ({
      variant_id: l.variant_id,
      reason: movementReason,
      delta: -l.quantity,
      related_order_id: order.id,
      actor_user_id: userId,
      metadata: {
        source: "orders-create",
        order_number: order.order_number,
      },
    }));

    const { error: movementErr } = await admin
      .from("inventory_movements")
      .insert(movementRows);

    if (movementErr) {
      await rollbackInventoryMutation(admin, stockQuantities, inventoryMode);
      await softDeleteOrder(supabase, order.id);
      return json(500, {
        error: "Inventory movement insert failed",
        detail: movementErr.message,
      });
    }
  }

  // 10) Compute other orders sum
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

  // 11) Return
  return json(200, {
    order_id: order.id,
    order_number: order.order_number,
    total_cents: order.total_cents,
    other_orders_total_cents: otherTotal,
  });
});
