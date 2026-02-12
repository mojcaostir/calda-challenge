import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const DEFAULT_SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const DEFAULT_SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
const DEFAULT_SUPABASE_SERVICE_ROLE_KEY = Deno.env.get(
  "SUPABASE_SERVICE_ROLE_KEY",
);

if (import.meta.main) {
  const missing: string[] = [];
  if (!DEFAULT_SUPABASE_URL) missing.push("SUPABASE_URL");
  if (!DEFAULT_SUPABASE_ANON_KEY) missing.push("SUPABASE_ANON_KEY");
  if (!DEFAULT_SUPABASE_SERVICE_ROLE_KEY) {
    missing.push("SUPABASE_SERVICE_ROLE_KEY");
  }
  if (missing.length > 0) {
    throw new Error(
      `Missing required env vars at cold start: ${missing.join(", ")}`,
    );
  }
}

type OrderStatus =
  | "pending"
  | "placed"
  | "paid"
  | "shipped"
  | "delivered"
  | "cancelled"
  | "refunded";

const ORDER_STATUSES: OrderStatus[] = [
  "pending",
  "placed",
  "paid",
  "shipped",
  "delivered",
  "cancelled",
  "refunded",
];
const ORDER_STATUS_SET = new Set<OrderStatus>(ORDER_STATUSES);

type InventoryMode = "reserve" | "purchase" | "none";

type StockQuantity = {
  variant_id: string;
  quantity: number;
};

type InventoryRow = {
  variant_id: string;
  on_hand: number;
  reserved: number;
};

type VariantRow = {
  id: string;
  sku: string;
  price_cents: number;
  currency: string;
  track_inventory: boolean;
  product: { title: string };
};

type NormalizedCreateOrderPayload = {
  shippingAddressId: string;
  billingAddressId: string;
  currency: string;
  shippingCents: number;
  taxCents: number;
  discountCents: number;
  status: OrderStatus;
  items: StockQuantity[];
};

type OrdersCreateDeps = {
  createClientFn?: typeof createClient;
  nowIso?: () => string;
  generateOrderNumber?: () => string;
};

type SupabaseLikeClient = {
  from: (table: string) => any;
  auth: {
    getUser: () => Promise<
      {
        data: { user: { id: string } | null };
        error: { message: string } | null;
      }
    >;
  };
};

type SupabaseLikeAdminClient = {
  from: (table: string) => any;
};

type DbErrorLike = {
  message: string;
  code?: string | null;
};

class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

class InventoryMutationError extends Error {
  appliedQuantities: StockQuantity[];

  constructor(message: string, appliedQuantities: StockQuantity[]) {
    super(message);
    this.name = "InventoryMutationError";
    this.appliedQuantities = appliedQuantities;
  }
}

function json(status: number, body: unknown): Response {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseRequiredString(value: unknown, errorMessage: string): string {
  if (typeof value !== "string") throw new ValidationError(errorMessage);
  const trimmed = value.trim();
  if (!trimmed) throw new ValidationError(errorMessage);
  return trimmed;
}

function parseNonNegativeInteger(value: unknown, fieldName: string): number {
  if (value === undefined || value === null) return 0;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ValidationError(`${fieldName} must be a non-negative integer`);
  }
  return value;
}

function normalizeCurrency(value: unknown): string {
  if (value === undefined || value === null) return "EUR";
  if (typeof value !== "string") {
    throw new ValidationError("currency must be a non-empty string");
  }

  const normalized = value.trim().toUpperCase();
  if (!normalized) {
    throw new ValidationError("currency must be a non-empty string");
  }

  return normalized;
}

function normalizeStatus(value: unknown): OrderStatus {
  if (value === undefined || value === null) return "placed";
  if (typeof value !== "string") {
    throw new ValidationError(
      `status must be one of: ${ORDER_STATUSES.join(", ")}`,
    );
  }

  const normalized = value.trim().toLowerCase();
  if (!ORDER_STATUS_SET.has(normalized as OrderStatus)) {
    throw new ValidationError(
      `status must be one of: ${ORDER_STATUSES.join(", ")}`,
    );
  }

  return normalized as OrderStatus;
}

function normalizeItems(value: unknown): StockQuantity[] {
  if (!Array.isArray(value) || value.length < 1) {
    throw new ValidationError("items must be a non-empty array");
  }

  const parsedItems: StockQuantity[] = [];
  const seenVariantIds = new Set<string>();
  for (const rawItem of value) {
    if (!isRecord(rawItem)) {
      throw new ValidationError("Each item must have variant_id");
    }

    const variantId = parseRequiredString(
      rawItem.variant_id,
      "Each item must have variant_id",
    );
    if (seenVariantIds.has(variantId)) {
      throw new ValidationError(
        "items must not contain duplicate variant_id values",
      );
    }
    seenVariantIds.add(variantId);

    const quantity = rawItem.quantity;
    if (
      typeof quantity !== "number" || !Number.isInteger(quantity) ||
      quantity <= 0
    ) {
      throw new ValidationError(
        "Each item.quantity must be a positive integer",
      );
    }

    parsedItems.push({
      variant_id: variantId,
      quantity,
    });
  }

  return parsedItems;
}

function normalizeCreateOrderPayload(
  payload: unknown,
): NormalizedCreateOrderPayload {
  if (!isRecord(payload)) {
    throw new ValidationError("JSON body must be an object");
  }

  const shippingAddressId = parseRequiredString(
    payload.shipping_address_id,
    "shipping_address_id is required",
  );
  const billingAddressId = payload.billing_address_id == null
    ? shippingAddressId
    : parseRequiredString(
      payload.billing_address_id,
      "billing_address_id must be a non-empty string when provided",
    );

  return {
    shippingAddressId,
    billingAddressId,
    currency: normalizeCurrency(payload.currency),
    shippingCents: parseNonNegativeInteger(
      payload.shipping_cents,
      "shipping_cents",
    ),
    taxCents: parseNonNegativeInteger(payload.tax_cents, "tax_cents"),
    discountCents: parseNonNegativeInteger(
      payload.discount_cents,
      "discount_cents",
    ),
    status: normalizeStatus(payload.status),
    items: normalizeItems(payload.items),
  };
}

function asDbErrorLike(error: unknown): DbErrorLike {
  if (isRecord(error) && typeof error.message === "string") {
    const code = typeof error.code === "string" ? error.code : null;
    return { message: error.message, code };
  }

  return { message: "Unknown database error" };
}

function isClientInputDbError(error: DbErrorLike): boolean {
  return error.code === "22P02" || error.code === "23502" ||
    error.code === "23503" ||
    error.code === "23505" || error.code === "23514";
}

function dbErrorResponse(message: string, error: unknown): Response {
  const dbError = asDbErrorLike(error);
  const status = isClientInputDbError(dbError) ? 400 : 500;
  return json(status, {
    error: message,
    detail: dbError.message,
  });
}

async function softDeleteOrder(
  supabase: SupabaseLikeClient,
  orderId: string,
  nowIso: () => string,
) {
  const { error } = await supabase
    .from("orders")
    .update({ deleted_at: nowIso() })
    .eq("id", orderId);

  if (error) {
    throw new Error(error.message);
  }
}

async function cleanupPartialOrder(
  supabase: SupabaseLikeClient,
  orderId: string,
  nowIso: () => string,
) {
  try {
    await softDeleteOrder(supabase, orderId, nowIso);
  } catch (error) {
    const detail = error instanceof Error
      ? error.message
      : "Unknown cleanup error";
    console.error(`Failed to soft-delete partial order ${orderId}:`, detail);
  }
}

export function inventoryModeForStatus(status: string): InventoryMode {
  if (status === "pending" || status === "placed") return "reserve";
  if (status === "paid" || status === "shipped" || status === "delivered") {
    return "purchase";
  }
  return "none";
}

export function movementReasonForMode(
  mode: InventoryMode,
): "reserve" | "purchase" | null {
  if (mode === "reserve") return "reserve";
  if (mode === "purchase") return "purchase";
  return null;
}

async function applyInventoryMutation(
  admin: SupabaseLikeAdminClient,
  quantities: StockQuantity[],
  mode: InventoryMode,
) {
  if (mode === "none" || quantities.length === 0) return;

  const appliedQuantities: StockQuantity[] = [];

  try {
    const variantIds = quantities.map((q) => q.variant_id);
    const { data: inventoryRows, error: inventoryErr } = await admin
      .from("inventory")
      .select("variant_id, on_hand, reserved")
      .in("variant_id", variantIds);

    if (inventoryErr) {
      throw new Error(`Inventory lookup failed: ${inventoryErr.message}`);
    }
    if (!inventoryRows || inventoryRows.length !== variantIds.length) {
      throw new Error("Inventory row missing for one or more variants");
    }

    const typedRows = inventoryRows as InventoryRow[];
    const byVariant = new Map(
      typedRows.map((r: InventoryRow) => [
        r.variant_id,
        { on_hand: r.on_hand, reserved: r.reserved },
      ]),
    );

    for (const q of quantities) {
      const current = byVariant.get(q.variant_id);
      if (!current) {
        throw new Error(`Inventory row missing for variant ${q.variant_id}`);
      }

      const available = current.on_hand - current.reserved;
      if (available < q.quantity) {
        throw new Error(`Insufficient stock for variant ${q.variant_id}`);
      }

      const nextOnHand = mode === "purchase"
        ? current.on_hand - q.quantity
        : current.on_hand;
      const nextReserved = mode === "reserve"
        ? current.reserved + q.quantity
        : current.reserved;

      const { data: updatedRow, error: updErr } = await admin
        .from("inventory")
        .update({ on_hand: nextOnHand, reserved: nextReserved })
        .eq("variant_id", q.variant_id)
        .eq("on_hand", current.on_hand)
        .eq("reserved", current.reserved)
        .select("variant_id")
        .maybeSingle();

      if (updErr) {
        throw new Error(
          `Inventory update failed for ${q.variant_id}: ${updErr.message}`,
        );
      }
      if (!updatedRow) {
        throw new Error(
          `Inventory changed concurrently for ${q.variant_id}; retry request`,
        );
      }

      appliedQuantities.push(q);
    }
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : "Inventory update failed";
    throw new InventoryMutationError(message, appliedQuantities);
  }
}

async function rollbackInventoryMutation(
  admin: SupabaseLikeAdminClient,
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

  const typedRows = inventoryRows as InventoryRow[];
  const byVariant = new Map(
    typedRows.map((r: InventoryRow) => [
      r.variant_id,
      { on_hand: r.on_hand, reserved: r.reserved },
    ]),
  );

  for (const q of quantities) {
    const current = byVariant.get(q.variant_id);
    if (!current) continue;

    const nextOnHand = mode === "purchase"
      ? current.on_hand + q.quantity
      : current.on_hand;
    const nextReserved = mode === "reserve"
      ? Math.max(0, current.reserved - q.quantity)
      : current.reserved;

    const { error: updErr } = await admin
      .from("inventory")
      .update({ on_hand: nextOnHand, reserved: nextReserved })
      .eq("variant_id", q.variant_id);

    if (updErr) {
      console.error(
        `Inventory rollback failed for ${q.variant_id}:`,
        updErr.message,
      );
    }
  }
}

export async function handleOrdersCreate(
  req: Request,
  deps: OrdersCreateDeps = {},
): Promise<Response> {
  if (req.method !== "POST") {
    console.log("Method not allowed:", req.method);
    return json(405, { error: "Method Not Allowed" });
  }

  const token = getBearerToken(req);
  if (!token) return json(401, { error: "Missing Bearer token" });

  try {
    const createClientFn = deps.createClientFn ?? createClient;
    const nowIso = deps.nowIso ?? (() => new Date().toISOString());
    const generateOrderNumber = deps.generateOrderNumber ??
      (() => `ORD-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`);

    const supabaseUrl = DEFAULT_SUPABASE_URL!;
    const anonKey = DEFAULT_SUPABASE_ANON_KEY!;

    const supabase = createClientFn(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false },
    }) as unknown as SupabaseLikeClient;

    const serviceRoleKey = DEFAULT_SUPABASE_SERVICE_ROLE_KEY!;

    const admin = createClientFn(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false },
    }) as unknown as SupabaseLikeAdminClient;

    // 1) Identify user
    const { data: userData, error: userErr } = await supabase.auth.getUser();
    if (userErr || !userData?.user) {
      console.error("User authentication failed:", userErr);
      return json(401, { error: "Invalid token" });
    }

    const userId = userData.user.id;

    // 2) Parse input
    let rawPayload: unknown;
    try {
      rawPayload = await req.json();
    } catch {
      return json(400, { error: "Invalid JSON body" });
    }

    const payload = normalizeCreateOrderPayload(rawPayload);

    // 3) Validate addresses belong to user (RLS enforces ownership)
    const { data: shipAddr, error: shipAddrErr } = await supabase
      .from("addresses")
      .select("id")
      .eq("id", payload.shippingAddressId)
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

    const { data: billAddr, error: billAddrErr } = await supabase
      .from("addresses")
      .select("id")
      .eq("id", payload.billingAddressId)
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
    const variantIds = payload.items.map((i) => i.variant_id);

    const { data: variants, error: variantsErr } = await supabase
      .from("product_variants")
      .select(
        "id, sku, price_cents, currency, track_inventory, product:products(title)",
      )
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
      if (v.currency !== payload.currency) {
        return json(400, {
          error: "Currency mismatch",
          detail:
            `Variant ${v.sku} currency ${v.currency} != ${payload.currency}`,
        });
      }
    }

    // 5) Compute totals and build order_lines payload
    let subtotal = 0;
    const typedVariants = variants as VariantRow[];
    const variantById = new Map(
      typedVariants.map((v: VariantRow) => [v.id, v]),
    );

    const lines = payload.items.map((it) => {
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

    const total = subtotal + payload.shippingCents + payload.taxCents -
      payload.discountCents;
    if (total < 0) {
      return json(400, { error: "total_cents must not be negative" });
    }

    // 6) Insert order
    const orderNumber = generateOrderNumber();

    const { data: order, error: orderErr } = await supabase
      .from("orders")
      .insert({
        order_number: orderNumber,
        user_id: userId,
        shipping_address_id: payload.shippingAddressId,
        billing_address_id: payload.billingAddressId,
        status: payload.status,
        currency: payload.currency,
        subtotal_cents: subtotal,
        shipping_cents: payload.shippingCents,
        tax_cents: payload.taxCents,
        discount_cents: payload.discountCents,
        total_cents: total,
      })
      .select("id, order_number, total_cents")
      .single();

    if (orderErr) {
      return dbErrorResponse("Order insert failed", orderErr);
    }

    // 7) Insert order_lines (attach order_id)
    const orderLinesToInsert = lines.map((l) => ({ ...l, order_id: order.id }));

    const { error: linesErr } = await supabase
      .from("order_lines")
      .insert(orderLinesToInsert);

    if (linesErr) {
      await cleanupPartialOrder(supabase, order.id, nowIso);
      return dbErrorResponse("Order lines insert failed", linesErr);
    }

    // 8) Apply inventory stock checks/updates for tracked variants.
    const inventoryMode = inventoryModeForStatus(payload.status);
    const trackedLines = lines.filter((l) => {
      const v = variantById.get(l.variant_id);
      return v?.track_inventory ?? true;
    });
    const stockQuantities: StockQuantity[] = trackedLines.map((l) => ({
      variant_id: l.variant_id,
      quantity: l.quantity,
    }));

    try {
      await applyInventoryMutation(admin, stockQuantities, inventoryMode);
    } catch (error) {
      if (
        error instanceof InventoryMutationError &&
        error.appliedQuantities.length > 0
      ) {
        await rollbackInventoryMutation(
          admin,
          error.appliedQuantities,
          inventoryMode,
        );
      }
      await cleanupPartialOrder(supabase, order.id, nowIso);
      return json(409, {
        error: "Inventory update failed",
        detail: error instanceof Error
          ? error.message
          : "Inventory update failed",
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
        await cleanupPartialOrder(supabase, order.id, nowIso);
        return dbErrorResponse("Inventory movement insert failed", movementErr);
      }
    }

    // 10) Compute other orders sum
    const { data: otherOrders, error: otherErr } = await supabase
      .from("orders")
      .select("total_cents")
      .neq("id", order.id);

    if (otherErr) {
      return json(500, {
        error: "Aggregation failed",
        detail: otherErr.message,
      });
    }

    const otherTotal =
      ((otherOrders ?? []) as Array<{ total_cents: number | null }>).reduce(
        (acc: number, r) => acc + (r.total_cents ?? 0),
        0,
      );

    // 11) Return
    return json(200, {
      order_id: order.id,
      order_number: order.order_number,
      total_cents: order.total_cents,
      other_orders_total_cents: otherTotal,
    });
  } catch (error) {
    if (error instanceof ValidationError) {
      return json(400, { error: error.message });
    }

    console.error("Unhandled orders-create error:", error);
    return json(500, { error: "Internal Server Error" });
  }
}

if (import.meta.main) {
  serve((req) => handleOrdersCreate(req));
}
