import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_ENV = Deno.env.get("SUPABASE_ENV");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const BOOTSTRAP_SECRET = Deno.env.get("BOOTSTRAP_SECRET");
const IS_LOCAL_ENV = SUPABASE_ENV !== "production";
const FIXED_USER_IDS: Record<string, string> = {
  "mojca.ostir@gmail.com": "11111111-1111-4111-8111-111111111111",
  "mojca.ostir+1@gmail.com": "22222222-2222-4222-8222-222222222222",
};
const FIXED_ADDRESS_IDS: Record<string, string> = {
  "mojca.ostir@gmail.com": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "mojca.ostir+1@gmail.com": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
};

serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "Method Not Allowed" });
  if (!IS_LOCAL_ENV) return json(403, { error: "Not allowed outside local" });

  const providedSecret = req.headers.get("x-bootstrap-secret") ?? "";
  if (BOOTSTRAP_SECRET !== providedSecret) {
    return json(403, { error: "Invalid bootstrap secret" });
  }

  try {
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    const users = [
      {
        email: "mojca.ostir@gmail.com",
        password: "Password123!",
        full_name: "Customer One",
        address: {
          line1: "Main Street 1",
          city: "Ljubljana",
          region: "SI",
          postal_code: "1000",
          country: "Slovenia",
          phone: "+38600000001",
        },
      },
      {
        email: "mojca.ostir+1@gmail.com",
        password: "Password123!",
        full_name: "Customer Two",
        address: {
          line1: "Second Street 5",
          city: "Maribor",
          region: "SI",
          postal_code: "2000",
          country: "Slovenia",
          phone: "+38600000002",
        },
      },
    ] as const;

    // 1) Create users
    const userIds: Record<string, string> = {};

    for (const u of users) {
      const fixedUserId = FIXED_USER_IDS[u.email];
      const fixedAddressId = FIXED_ADDRESS_IDS[u.email];
      const { data, error } = await admin.auth.admin.createUser({
        id: fixedUserId,
        email: u.email,
        password: u.password,
        email_confirm: true,
      });
      if (error || !data.user) {
        throw new Error(`createUser(${u.email}) failed: ${error?.message}`);
      }

      const userId = fixedUserId;
      userIds[u.email] = userId;

      const { error: profErr } = await admin.from("profiles").insert({
        id: userId,
        full_name: u.full_name,
        email: u.email,
      });
      if (profErr) {
        throw new Error(
          `profiles insert failed for ${u.email}: ${profErr.message}`,
        );
      }

      const { error: addrInsErr } = await admin.from("addresses").insert({
        id: fixedAddressId,
        user_id: userId,
        name: u.full_name,
        line1: u.address.line1,
        city: u.address.city,
        region: u.address.region,
        postal_code: u.address.postal_code,
        country: u.address.country,
        phone: u.address.phone,
        is_default_shipping: true,
        is_default_billing: true,
      });
      if (addrInsErr) {
        throw new Error(
          `addresses insert failed for ${u.email}: ${addrInsErr.message}`,
        );
      }
    }

    // 2) Fetch variants
    const neededSkus = [
      "MUG-350",
      "TSHIRT-BASE",
      "NOTE-A5",
      "BOTTLE-750",
      "STICKERS-10",
    ];

    const { data: variants, error: varErr } = await admin
      .from("product_variants")
      .select("id, sku, price_cents, product:products(title)")
      .in("sku", neededSkus);
    if (varErr) {
      throw new Error(`variants select failed: ${varErr.message}`);
    }

    const bySku = new Map<string, any>(variants.map((v: any) => [v.sku, v]));
    const mug = bySku.get("MUG-350");
    const tee = bySku.get("TSHIRT-BASE");
    const note = bySku.get("NOTE-A5");
    const bottle = bySku.get("BOTTLE-750");
    const stickers = bySku.get("STICKERS-10");

    // 3) Use fixed addresses for the two users
    const u1 = userIds["mojca.ostir@gmail.com"]!;
    const u2 = userIds["mojca.ostir+1@gmail.com"]!;
    const a1 = FIXED_ADDRESS_IDS["mojca.ostir@gmail.com"];
    const a2 = FIXED_ADDRESS_IDS["mojca.ostir+1@gmail.com"];

    // 4) Upsert 3 orders
    const ordersToInsert = [
      {
        order_number: "ORD-1001",
        user_id: u1,
        shipping_address_id: a1,
        billing_address_id: a1,
        status: "paid",
        currency: "EUR",
        subtotal_cents: 2 * mug.price_cents + note.price_cents,
        shipping_cents: 499,
        tax_cents: 0,
        discount_cents: 0,
        total_cents: 2 * mug.price_cents + note.price_cents + 499,
      },
      {
        order_number: "ORD-1002",
        user_id: u2,
        shipping_address_id: a2,
        billing_address_id: a2,
        status: "placed",
        currency: "EUR",
        subtotal_cents: tee.price_cents + 2 * stickers.price_cents,
        shipping_cents: 399,
        tax_cents: 0,
        discount_cents: 200,
        total_cents: tee.price_cents + 2 * stickers.price_cents + 399 - 200,
      },
      {
        order_number: "ORD-1003",
        user_id: u1,
        shipping_address_id: a1,
        billing_address_id: a1,
        status: "pending",
        currency: "EUR",
        subtotal_cents: bottle.price_cents + mug.price_cents,
        shipping_cents: 499,
        tax_cents: 0,
        discount_cents: 0,
        total_cents: bottle.price_cents + mug.price_cents + 499,
      },
    ];

    const { data: insertedOrders, error: ordErr } = await admin
      .from("orders")
      .insert(ordersToInsert)
      .select("id, order_number");
    if (ordErr) {
      throw new Error(`orders insert failed: ${ordErr.message}`);
    }


    const orderId: Record<string, string> = Object.fromEntries(
      (insertedOrders ?? []).map((o) => [o.order_number, o.id]),
    );

    // 5) Insert order lines (ALL 3 orders, >=2 lines each)
    const lines = [
      {
        order_id: orderId["ORD-1001"],
        variant_id: mug.id,
        sku_snapshot: mug.sku,
        title_snapshot: mug.product.title,
        quantity: 2,
        unit_price_cents: mug.price_cents,
        line_subtotal_cents: 2 * mug.price_cents,
        line_total_cents: 2 * mug.price_cents,
      },
      {
        order_id: orderId["ORD-1001"],
        variant_id: note.id,
        sku_snapshot: note.sku,
        title_snapshot: note.product.title,
        quantity: 1,
        unit_price_cents: note.price_cents,
        line_subtotal_cents: note.price_cents,
        line_total_cents: note.price_cents,
      },
      {
        order_id: orderId["ORD-1002"],
        variant_id: tee.id,
        sku_snapshot: tee.sku,
        title_snapshot: tee.product.title,
        quantity: 1,
        unit_price_cents: tee.price_cents,
        line_subtotal_cents: tee.price_cents,
        line_total_cents: tee.price_cents,
      },
      {
        order_id: orderId["ORD-1002"],
        variant_id: stickers.id,
        sku_snapshot: stickers.sku,
        title_snapshot: stickers.product.title,
        quantity: 2,
        unit_price_cents: stickers.price_cents,
        line_subtotal_cents: 2 * stickers.price_cents,
        line_total_cents: 2 * stickers.price_cents,
      },
      {
        order_id: orderId["ORD-1003"],
        variant_id: bottle.id,
        sku_snapshot: bottle.sku,
        title_snapshot: bottle.product.title,
        quantity: 1,
        unit_price_cents: bottle.price_cents,
        line_subtotal_cents: bottle.price_cents,
        line_total_cents: bottle.price_cents,
      },
      {
        order_id: orderId["ORD-1003"],
        variant_id: mug.id,
        sku_snapshot: mug.sku,
        title_snapshot: mug.product.title,
        quantity: 1,
        unit_price_cents: mug.price_cents,
        line_subtotal_cents: mug.price_cents,
        line_total_cents: mug.price_cents,
      },
    ];

    const { error: linesErr } = await admin
      .from("order_lines")
      .insert(lines);
    if (linesErr) {
      throw new Error(`order_lines insert failed: ${linesErr.message}`);
    }

    return json(200, { ok: true });
  } catch (e) {
    return json(500, { ok: false, error: (e as Error).message });
  }
});
