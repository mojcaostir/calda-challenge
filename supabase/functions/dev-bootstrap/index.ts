import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function assertEnv(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function getSupabaseUrl(): string {
  const fromEnv = Deno.env.get("SUPABASE_URL");
  if (fromEnv && fromEnv.length > 0) {
    console.log("Using SUPABASE_URL from env:", fromEnv);
    return fromEnv;
  }
  
  console.log("SUPABASE_URL not set in env, using default http://kong:8000");
  return "http://kong:8000";
}

function isLocalEnv(): boolean {
  const isLocal = (Deno.env.get("SUPABASE_ENV") ?? "") !== "production";
  console.log( "Is local =", isLocal);
  return isLocal;
}

function must<T>(v: T | null | undefined, msg: string): T {
  if (v === null || v === undefined) throw new Error(msg);
  return v;
}

serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "Method Not Allowed" });
  if (!isLocalEnv()) return json(403, { error: "Not allowed outside local" });

  const expectedSecret = Deno.env.get("BOOTSTRAP_SECRET") ?? "";
  const providedSecret = req.headers.get("x-bootstrap-secret") ?? "";
  if (!expectedSecret || expectedSecret !== providedSecret) {
    return json(403, { error: "Invalid bootstrap secret" });
  }

  try {
    const supabaseUrl = getSupabaseUrl();
    const serviceKey = assertEnv("SUPABASE_SERVICE_ROLE_KEY");
    console.log("Using SUPABASE_SERVICE_ROLE_KEY from env: ", serviceKey);

    const admin = createClient(supabaseUrl, serviceKey, {
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

    // =========================================================
    // 1) Create/ensure users
    // =========================================================
    const { data: existingUsers, error: listErr } = await admin.auth.admin
      .listUsers({ page: 1, perPage: 1000 });
    if (listErr) throw new Error(`auth.listUsers failed: ${listErr.message}`);

    const userIds: Record<string, string> = {};
    const userResults: any[] = [];

    for (const u of users) {
      const found = existingUsers.users.find(
        (x) => (x.email ?? "").toLowerCase() === u.email.toLowerCase(),
      );

      let userId: string;
      let created = false;

      if (!found) {
        const { data, error } = await admin.auth.admin.createUser({
          email: u.email,
          password: u.password,
          email_confirm: true,
        });
        if (error || !data.user) throw new Error(`createUser(${u.email}) failed: ${error?.message}`);
        userId = data.user.id;
        created = true;
      } else {
        userId = found.id;
        const { error: updErr } = await admin.auth.admin.updateUserById(userId, {
          password: u.password,
          email_confirm: true,
        });
        if (updErr) throw new Error(`updateUserById(${u.email}) failed: ${updErr.message}`);
      }

      userIds[u.email] = userId;
      userResults.push({ email: u.email, user_id: userId, created });

      const { error: profErr } = await admin.from("profiles").upsert(
        { id: userId, full_name: u.full_name, email: u.email },
        { onConflict: "id" },
      );
      if (profErr) throw new Error(`profiles upsert failed for ${u.email}: ${profErr.message}`);


      const { data: addr, error: addrSelErr } = await admin
        .from("addresses")
        .select("id")
        .eq("user_id", userId)
        .eq("is_default_shipping", true)
        .maybeSingle();

      if (addrSelErr) throw new Error(`addresses select failed for ${u.email}: ${addrSelErr.message}`);

      if (!addr) {
        const { error: addrInsErr } = await admin.from("addresses").insert({
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
        if (addrInsErr) throw new Error(`addresses insert failed for ${u.email}: ${addrInsErr.message}`);
      }
    }

    // Sanity: ensure profiles exist
    const { data: profCheck, error: profCheckErr } = await admin
      .from("profiles")
      .select("id, email")
      .in("email", users.map((u) => u.email));
    if (profCheckErr) throw new Error(`profiles sanity check failed: ${profCheckErr.message}`);

    // =========================================================
    // 2) Fetch variants (must exist from seed.sql)
    // =========================================================
    const neededSkus = ["MUG-350", "TSHIRT-BASE", "NOTE-A5", "BOTTLE-750", "STICKERS-10"];

    const { data: variants, error: varErr } = await admin
      .from("product_variants")
      .select("id, sku, price_cents, product:products(title)")
      .in("sku", neededSkus);

    if (varErr) throw new Error(`product_variants select failed: ${varErr.message}`);
    if (!variants || variants.length !== neededSkus.length) {
      const got = new Set((variants ?? []).map((v: any) => v.sku));
      const missing = neededSkus.filter((s) => !got.has(s));
      throw new Error(`Missing variants in DB (did seed.sql run?): ${missing.join(", ")}`);
    }

    const bySku = new Map<string, any>(variants.map((v: any) => [v.sku, v]));
    const mug = bySku.get("MUG-350");
    const tee = bySku.get("TSHIRT-BASE");
    const note = bySku.get("NOTE-A5");
    const bottle = bySku.get("BOTTLE-750");
    const stickers = bySku.get("STICKERS-10");

    // =========================================================
    // 3) Fetch default addresses for the two users
    // =========================================================
    const u1 = must(userIds["mojca.ostir@gmail.com"], "Missing userId for u1");
    const u2 = must(userIds["mojca.ostir+1@gmail.com"], "Missing userId for u2");

    const { data: addresses, error: addrErr } = await admin
      .from("addresses")
      .select("id, user_id")
      .in("user_id", [u1, u2])
      .eq("is_default_shipping", true);

    if (addrErr) throw new Error(`addresses select for users failed: ${addrErr.message}`);

    const a1 = addresses?.find((a) => a.user_id === u1)?.id;
    const a2 = addresses?.find((a) => a.user_id === u2)?.id;

    if (!a1) throw new Error("No default shipping address for user1");
    if (!a2) throw new Error("No default shipping address for user2");

    // =========================================================
    // 4) Upsert 3 orders
    // =========================================================
    const ordersToUpsert = [
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

    const { data: upsertedOrders, error: ordErr } = await admin
      .from("orders")
      .upsert(ordersToUpsert, { onConflict: "order_number" })
      .select("id, order_number");

    if (ordErr) throw new Error(`orders upsert failed: ${ordErr.message}`);

    const orderId: Record<string, string> = Object.fromEntries(
      (upsertedOrders ?? []).map((o) => [o.order_number, o.id]),
    );

    // =========================================================
    // 5) Upsert order lines (ALL 3 orders, ≥2 lines each)
    // =========================================================
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
      .upsert(lines, { onConflict: "order_id,variant_id" });

    if (linesErr) throw new Error(`order_lines upsert failed: ${linesErr.message}`);

    return json(200, {
      ok: true,
      users: userResults,
      profiles: profCheck,
      seeded_orders: Object.keys(orderId),
    });
  } catch (e) {
    return json(500, { ok: false, error: (e as Error).message });
  }
});
