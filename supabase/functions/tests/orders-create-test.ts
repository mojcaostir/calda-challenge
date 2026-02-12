import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  aggregateStockQuantities,
  handleOrdersCreate,
  inventoryModeForStatus,
  movementReasonForMode,
} from "../orders-create/index.ts";

function makeEnv(values: Record<string, string | undefined>) {
  return {
    get: (key: string) => values[key],
  };
}

Deno.test("inventoryModeForStatus maps statuses correctly", () => {
  assertEquals(inventoryModeForStatus("pending"), "reserve");
  assertEquals(inventoryModeForStatus("placed"), "reserve");
  assertEquals(inventoryModeForStatus("paid"), "purchase");
  assertEquals(inventoryModeForStatus("shipped"), "purchase");
  assertEquals(inventoryModeForStatus("delivered"), "purchase");
  assertEquals(inventoryModeForStatus("cancelled"), "none");
});

Deno.test("movementReasonForMode maps modes correctly", () => {
  assertEquals(movementReasonForMode("reserve"), "reserve");
  assertEquals(movementReasonForMode("purchase"), "purchase");
  assertEquals(movementReasonForMode("none"), null);
});

Deno.test("aggregateStockQuantities aggregates by variant", () => {
  const aggregated = aggregateStockQuantities([
    { variant_id: "v1", quantity: 2 },
    { variant_id: "v2", quantity: 1 },
    { variant_id: "v1", quantity: 3 },
  ]);

  assertEquals(aggregated, [
    { variant_id: "v1", quantity: 5 },
    { variant_id: "v2", quantity: 1 },
  ]);
});

Deno.test("handleOrdersCreate returns 405 for non-POST", async () => {
  const res = await handleOrdersCreate(
    new Request("http://localhost/orders-create", { method: "GET" }),
  );

  assertEquals(res.status, 405);
  assertEquals(await res.json(), { error: "Method Not Allowed" });
});

Deno.test("handleOrdersCreate returns 401 when bearer token is missing", async () => {
  const res = await handleOrdersCreate(
    new Request("http://localhost/orders-create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }),
  );

  assertEquals(res.status, 401);
  assertEquals(await res.json(), { error: "Missing Bearer token" });
});

Deno.test("handleOrdersCreate returns 500 when service role key is missing", async () => {
  const req = new Request("http://localhost/orders-create", {
    method: "POST",
    headers: {
      Authorization: "Bearer token-123",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      shipping_address_id: "addr-1",
      items: [{ variant_id: "v1", quantity: 1 }],
    }),
  });

  const createClientFn = (() => ({})) as any;
  const res = await handleOrdersCreate(req, {
    createClientFn,
    env: makeEnv({
      SUPABASE_URL: "http://localhost:54321",
      SUPABASE_ANON_KEY: "anon-key",
      SUPABASE_SERVICE_ROLE_KEY: undefined,
    }),
  });

  assertEquals(res.status, 500);
  assertEquals(await res.json(), {
    error: "SUPABASE_SERVICE_ROLE_KEY is not configured",
  });
});

Deno.test("handleOrdersCreate reserves stock and writes inventory movements", async () => {
  const calls: {
    inventoryUpdates: Array<
      { variant_id: string; on_hand: number; reserved: number }
    >;
    movementRows: Array<{ variant_id: string; reason: string; delta: number }>;
  } = {
    inventoryUpdates: [],
    movementRows: [],
  };

  const inventoryState = new Map<string, { on_hand: number; reserved: number }>(
    [
      ["v1", { on_hand: 10, reserved: 1 }],
    ],
  );

  const userClient = {
    auth: {
      getUser: async () => ({ data: { user: { id: "user-1" } }, error: null }),
    },
    from: (table: string) => {
      if (table === "addresses") {
        return {
          select: (_: string) => ({
            eq: (_col: string, _val: string) => ({
              maybeSingle: async () => ({
                data: { id: "addr-1" },
                error: null,
              }),
            }),
          }),
        };
      }

      if (table === "product_variants") {
        return {
          select: (_: string) => ({
            in: async (_col: string, _vals: string[]) => ({
              data: [
                {
                  id: "v1",
                  sku: "SKU-1",
                  price_cents: 100,
                  currency: "EUR",
                  track_inventory: true,
                  product: { title: "Tracked Product" },
                },
                {
                  id: "v2",
                  sku: "SKU-2",
                  price_cents: 300,
                  currency: "EUR",
                  track_inventory: false,
                  product: { title: "Untracked Product" },
                },
              ],
              error: null,
            }),
          }),
        };
      }

      if (table === "orders") {
        return {
          insert: (row: Record<string, unknown>) => ({
            select: (_: string) => ({
              single: async () => ({
                data: {
                  id: "ord-1",
                  order_number: row.order_number,
                  total_cents: row.total_cents,
                },
                error: null,
              }),
            }),
          }),
          select: (_: string) => ({
            neq: async (_col: string, _val: string) => ({
              data: [{ total_cents: 500 }],
              error: null,
            }),
          }),
          update: (_row: Record<string, unknown>) => ({
            eq: async (_col: string, _val: string) => ({
              data: null,
              error: null,
            }),
          }),
        };
      }

      if (table === "order_lines") {
        return {
          insert: async (_rows: unknown[]) => ({ error: null }),
        };
      }

      throw new Error(`Unexpected user table: ${table}`);
    },
  };

  const adminClient = {
    from: (table: string) => {
      if (table === "inventory") {
        return {
          select: (_: string) => ({
            in: async (_col: string, vals: string[]) => ({
              data: vals.map((id) => ({
                variant_id: id,
                ...inventoryState.get(id)!,
              })),
              error: null,
            }),
          }),
          update: (values: { on_hand: number; reserved: number }) => {
            const where: Record<string, string | number> = {};
            const chain = {
              eq: (col: string, val: string | number) => {
                where[col] = val;
                return chain;
              },
              select: (_cols: string) => chain,
              maybeSingle: async () => {
                const variantId = String(where.variant_id);
                const current = inventoryState.get(variantId);
                if (!current) return { data: null, error: null };

                if (
                  current.on_hand !== where.on_hand ||
                  current.reserved !== where.reserved
                ) {
                  return { data: null, error: null };
                }

                inventoryState.set(variantId, {
                  on_hand: values.on_hand,
                  reserved: values.reserved,
                });

                calls.inventoryUpdates.push({
                  variant_id: variantId,
                  on_hand: values.on_hand,
                  reserved: values.reserved,
                });

                return { data: { variant_id: variantId }, error: null };
              },
            };
            return chain;
          },
        };
      }

      if (table === "inventory_movements") {
        return {
          insert: async (
            rows: Array<{ variant_id: string; reason: string; delta: number }>,
          ) => {
            calls.movementRows = rows;
            return { error: null };
          },
        };
      }

      throw new Error(`Unexpected admin table: ${table}`);
    },
  };

  const createClientFn = ((_url: string, key: string) => {
    if (key === "anon-key") return userClient;
    if (key === "service-role-key") return adminClient;
    throw new Error(`Unexpected key ${key}`);
  }) as any;

  const req = new Request("http://localhost/orders-create", {
    method: "POST",
    headers: {
      Authorization: "Bearer token-123",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      shipping_address_id: "addr-1",
      items: [
        { variant_id: "v1", quantity: 2 },
        { variant_id: "v1", quantity: 1 },
        { variant_id: "v2", quantity: 1 },
      ],
      currency: "EUR",
      shipping_cents: 100,
      tax_cents: 0,
      discount_cents: 0,
      status: "placed",
    }),
  });

  const res = await handleOrdersCreate(req, {
    createClientFn,
    env: makeEnv({
      SUPABASE_URL: "http://localhost:54321",
      SUPABASE_ANON_KEY: "anon-key",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    }),
    generateOrderNumber: () => "ORD-TEST-0001",
    nowIso: () => "2026-02-12T10:00:00.000Z",
  });

  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.order_id, "ord-1");
  assertEquals(body.order_number, "ORD-TEST-0001");

  assertEquals(calls.inventoryUpdates.length, 1);
  assertEquals(calls.inventoryUpdates[0], {
    variant_id: "v1",
    on_hand: 10,
    reserved: 4,
  });

  assert(calls.movementRows.length > 0);
  assertEquals(calls.movementRows.every((r) => r.variant_id === "v1"), true);
  assertEquals(calls.movementRows.every((r) => r.reason === "reserve"), true);
});
