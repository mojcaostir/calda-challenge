import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  handleOrdersCreate,
  inventoryModeForStatus,
  movementReasonForMode,
} from "../orders-create/index.ts";

function makeValidationCreateClient() {
  const userClient = {
    auth: {
      getUser: async () => ({ data: { user: { id: "user-1" } }, error: null }),
    },
    from: (_table: string) => {
      throw new Error("Unexpected table access in validation path");
    },
  };

  const adminClient = {
    from: (_table: string) => {
      throw new Error("Unexpected admin table access in validation path");
    },
  };

  let callCount = 0;
  return ((_url: string) => {
    callCount += 1;
    if (callCount === 1) return userClient;
    if (callCount === 2) return adminClient;
    throw new Error(`Unexpected createClient call #${callCount}`);
  }) as any;
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

Deno.test("handleOrdersCreate rejects invalid status with 400", async () => {
  const req = new Request("http://localhost/orders-create", {
    method: "POST",
    headers: {
      Authorization: "Bearer token-123",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      shipping_address_id: "addr-1",
      items: [{ variant_id: "v1", quantity: 1 }],
      status: "not-a-real-status",
    }),
  });

  const res = await handleOrdersCreate(req, {
    createClientFn: makeValidationCreateClient(),
  });

  assertEquals(res.status, 400);
  const body = await res.json();
  assertStringIncludes(body.error, "status must be one of");
});

Deno.test("handleOrdersCreate rejects non-integer and negative cents with 400", async () => {
  const cases: Array<{ field: string; value: number }> = [
    { field: "shipping_cents", value: -1 },
    { field: "tax_cents", value: 1.5 },
  ];

  for (const c of cases) {
    const req = new Request("http://localhost/orders-create", {
      method: "POST",
      headers: {
        Authorization: "Bearer token-123",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        shipping_address_id: "addr-1",
        items: [{ variant_id: "v1", quantity: 1 }],
        [c.field]: c.value,
      }),
    });

    const res = await handleOrdersCreate(req, {
      createClientFn: makeValidationCreateClient(),
    });

    assertEquals(res.status, 400);
    assertEquals(await res.json(), {
      error: `${c.field} must be a non-negative integer`,
    });
  }
});

Deno.test("handleOrdersCreate rejects duplicate variant_id values with 400", async () => {
  const req = new Request("http://localhost/orders-create", {
    method: "POST",
    headers: {
      Authorization: "Bearer token-123",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      shipping_address_id: "addr-1",
      items: [
        { variant_id: "v1", quantity: 1 },
        { variant_id: "v1", quantity: 2 },
      ],
    }),
  });

  const res = await handleOrdersCreate(req, {
    createClientFn: makeValidationCreateClient(),
  });

  assertEquals(res.status, 400);
  assertEquals(await res.json(), {
    error: "items must not contain duplicate variant_id values",
  });
});

Deno.test("handleOrdersCreate writes one tracked movement for mixed tracked/untracked items", async () => {
  const calls: {
    inventoryUpdates: Array<
      { variant_id: string; on_hand: number; reserved: number }
    >;
    movementRows: Array<{
      variant_id: string;
      reason: string;
      delta: number;
      related_order_id: string;
      actor_user_id: string;
      metadata: { source: string; order_number: string };
    }>;
    orderLineRows: Array<{ variant_id: string; quantity: number }>;
  } = {
    inventoryUpdates: [],
    movementRows: [],
    orderLineRows: [],
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
          insert: async (
            rows: Array<{ variant_id: string; quantity: number }>,
          ) => {
            calls.orderLineRows = rows;
            return { error: null };
          },
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
            rows: Array<{
              variant_id: string;
              reason: string;
              delta: number;
              related_order_id: string;
              actor_user_id: string;
              metadata: { source: string; order_number: string };
            }>,
          ) => {
            calls.movementRows = rows;
            return { error: null };
          },
        };
      }

      throw new Error(`Unexpected admin table: ${table}`);
    },
  };

  let createClientCallCount = 0;
  const createClientFn = ((_url: string) => {
    createClientCallCount += 1;
    if (createClientCallCount === 1) return userClient;
    if (createClientCallCount === 2) return adminClient;
    throw new Error(`Unexpected createClient call #${createClientCallCount}`);
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
        { variant_id: "v1", quantity: 3 },
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
    generateOrderNumber: () => "ORD-TEST-0001",
    nowIso: () => "2026-02-12T10:00:00.000Z",
  });

  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.order_id, "ord-1");
  assertEquals(body.order_number, "ORD-TEST-0001");

  assertEquals(calls.orderLineRows.length, 2);
  const lineV1 = calls.orderLineRows.find((r) => r.variant_id === "v1");
  const lineV2 = calls.orderLineRows.find((r) => r.variant_id === "v2");
  assert(lineV1);
  assert(lineV2);
  assertEquals(lineV1.quantity, 3);
  assertEquals(lineV2.quantity, 1);

  assertEquals(calls.inventoryUpdates.length, 1);
  assertEquals(calls.inventoryUpdates[0], {
    variant_id: "v1",
    on_hand: 10,
    reserved: 4,
  });

  assertEquals(calls.movementRows.length, 1);
  assertEquals(calls.movementRows[0], {
    variant_id: "v1",
    reason: "reserve",
    delta: -3,
    related_order_id: "ord-1",
    actor_user_id: "user-1",
    metadata: {
      source: "orders-create",
      order_number: "ORD-TEST-0001",
    },
  });
});

Deno.test("handleOrdersCreate returns 409 and soft-deletes order on inventory concurrency conflict", async () => {
  const cleanupCalls: Array<{ id: string; deleted_at: string }> = [];

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
              ],
              error: null,
            }),
          }),
        };
      }

      if (table === "orders") {
        return {
          insert: (_row: Record<string, unknown>) => ({
            select: (_: string) => ({
              single: async () => ({
                data: {
                  id: "ord-1",
                  order_number: "ORD-TEST-0001",
                  total_cents: 100,
                },
                error: null,
              }),
            }),
          }),
          update: (row: Record<string, unknown>) => ({
            eq: async (_col: string, val: string) => {
              cleanupCalls.push({
                id: val,
                deleted_at: String(row.deleted_at),
              });
              return { data: null, error: null };
            },
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
                on_hand: 10,
                reserved: 1,
              })),
              error: null,
            }),
          }),
          update: (_values: { on_hand: number; reserved: number }) => {
            const chain = {
              eq: (_col: string, _val: string | number) => chain,
              select: (_cols: string) => chain,
              maybeSingle: async () => ({ data: null, error: null }),
            };
            return chain;
          },
        };
      }

      throw new Error(`Unexpected admin table: ${table}`);
    },
  };

  let createClientCallCount = 0;
  const createClientFn = ((_url: string) => {
    createClientCallCount += 1;
    if (createClientCallCount === 1) return userClient;
    if (createClientCallCount === 2) return adminClient;
    throw new Error(`Unexpected createClient call #${createClientCallCount}`);
  }) as any;

  const req = new Request("http://localhost/orders-create", {
    method: "POST",
    headers: {
      Authorization: "Bearer token-123",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      shipping_address_id: "addr-1",
      items: [{ variant_id: "v1", quantity: 3 }],
      status: "placed",
    }),
  });

  const res = await handleOrdersCreate(req, {
    createClientFn,
    generateOrderNumber: () => "ORD-TEST-0001",
    nowIso: () => "2026-02-12T10:00:00.000Z",
  });

  assertEquals(res.status, 409);
  const body = await res.json();
  assertEquals(body.error, "Inventory update failed");
  assertEquals(cleanupCalls.length, 1);
  assertEquals(cleanupCalls[0], {
    id: "ord-1",
    deleted_at: "2026-02-12T10:00:00.000Z",
  });
});

Deno.test("handleOrdersCreate rolls back inventory and soft-deletes order when movement insert fails", async () => {
  const inventoryState = new Map<string, { on_hand: number; reserved: number }>(
    [
      ["v1", { on_hand: 10, reserved: 1 }],
    ],
  );
  const inventoryUpdates: Array<
    {
      variant_id: string;
      on_hand: number;
      reserved: number;
      optimistic: boolean;
    }
  > = [];
  const cleanupCalls: string[] = [];

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
              ],
              error: null,
            }),
          }),
        };
      }

      if (table === "orders") {
        return {
          insert: (_row: Record<string, unknown>) => ({
            select: (_: string) => ({
              single: async () => ({
                data: {
                  id: "ord-1",
                  order_number: "ORD-TEST-0001",
                  total_cents: 300,
                },
                error: null,
              }),
            }),
          }),
          update: (_row: Record<string, unknown>) => ({
            eq: async (_col: string, val: string) => {
              cleanupCalls.push(val);
              return { data: null, error: null };
            },
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
            const chain: any = {
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
                inventoryUpdates.push({
                  variant_id: variantId,
                  on_hand: values.on_hand,
                  reserved: values.reserved,
                  optimistic: true,
                });

                return { data: { variant_id: variantId }, error: null };
              },
              then: (
                resolve: (
                  value: { data: { variant_id: string }; error: null },
                ) => void,
                _reject?: (reason?: unknown) => void,
              ) => {
                const variantId = String(where.variant_id);
                inventoryState.set(variantId, {
                  on_hand: values.on_hand,
                  reserved: values.reserved,
                });
                inventoryUpdates.push({
                  variant_id: variantId,
                  on_hand: values.on_hand,
                  reserved: values.reserved,
                  optimistic: false,
                });
                resolve({ data: { variant_id: variantId }, error: null });
              },
            };
            return chain;
          },
        };
      }

      if (table === "inventory_movements") {
        return {
          insert: async (_rows: unknown[]) => ({
            error: { message: "movement insert failed", code: "XX000" },
          }),
        };
      }

      throw new Error(`Unexpected admin table: ${table}`);
    },
  };

  let createClientCallCount = 0;
  const createClientFn = ((_url: string) => {
    createClientCallCount += 1;
    if (createClientCallCount === 1) return userClient;
    if (createClientCallCount === 2) return adminClient;
    throw new Error(`Unexpected createClient call #${createClientCallCount}`);
  }) as any;

  const req = new Request("http://localhost/orders-create", {
    method: "POST",
    headers: {
      Authorization: "Bearer token-123",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      shipping_address_id: "addr-1",
      items: [{ variant_id: "v1", quantity: 3 }],
      status: "placed",
    }),
  });

  const res = await handleOrdersCreate(req, {
    createClientFn,
    generateOrderNumber: () => "ORD-TEST-0001",
    nowIso: () => "2026-02-12T10:00:00.000Z",
  });

  assertEquals(res.status, 500);
  const body = await res.json();
  assertEquals(body.error, "Inventory movement insert failed");

  assertEquals(inventoryUpdates.length, 2);
  assertEquals(inventoryUpdates[0], {
    variant_id: "v1",
    on_hand: 10,
    reserved: 4,
    optimistic: true,
  });
  assertEquals(inventoryUpdates[1], {
    variant_id: "v1",
    on_hand: 10,
    reserved: 1,
    optimistic: false,
  });

  assertEquals(inventoryState.get("v1"), { on_hand: 10, reserved: 1 });
  assertEquals(cleanupCalls, ["ord-1"]);
});
