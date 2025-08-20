import express from "express";
import crypto from "crypto";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json({ type: "*/*", verify: (req, res, buf) => { req.rawBody = buf; } }));

const {
  SHOPIFY_STORE_DOMAIN,
  SHOPIFY_ADMIN_TOKEN,
  SHOPIFY_WEBHOOK_SECRET,
  WAYL_API_KEY,
  WAYL_API_BASE = "https://api.thewayl.com",
  BASE_URL = "http://localhost:3000",
  AUTO_REDIRECT = "false",
  REDIRECT_DELAY = "500",
} = process.env;

const USD_TO_IQD_RATE = 1320;

function verifyShopifyWebhook(req) {
  try {
    if (!SHOPIFY_WEBHOOK_SECRET) return false;
    const hmacHeader = req.get("X-Shopify-Hmac-Sha256") || "";
    const digest = crypto.createHmac("sha256", SHOPIFY_WEBHOOK_SECRET).update(req.rawBody || Buffer.from(JSON.stringify(req.body)), "utf8").digest("base64");
    return crypto.timingSafeEqual(Buffer.from(hmacHeader), Buffer.from(digest));
  } catch (e) {
    return false;
  }
}

function getDisplaySettings(country) {
  const arabicCountries = ['IQ', 'SA', 'AE', 'KW', 'QA', 'BH', 'OM', 'YE', 'SY', 'LB', 'JO', 'PS', 'EG', 'LY', 'TN', 'DZ', 'MA', 'MR', 'SD', 'SS', 'SO', 'DJ', 'KM'];
  return arabicCountries.includes(country) ? { language: "ar", currency: "usd" } : { language: "en", currency: "usd" };
}

function convertToIQD(amount) {
  return Math.max(Math.round(amount * USD_TO_IQD_RATE), 1000);
}

async function shopifyGraphQL(query, variables = {}) {
  const res = await fetch(`https://${SHOPIFY_STORE_DOMAIN}/admin/api/2024-07/graphql.json`, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const data = await res.json();
  if (!res.ok || data.errors) throw new Error("GraphQL Error");
  return data.data;
}

function buildWaylUrl(baseUrl, { language, currency }) {
  try {
    const u = new URL(baseUrl);
    u.searchParams.set("lang", language);
    u.searchParams.set("currency", currency);
    return u.toString();
  } catch (error) {
    return `${baseUrl}?lang=${language}&currency=${currency}`;
  }
}

app.get("/", (req, res) => res.send("WAYL-Shopify Integration"));
app.get("/health", (req, res) => res.json({ ok: true, conversion_rate: USD_TO_IQD_RATE }));

app.post("/webhooks/shopify/orders/create", async (req, res) => {
  try {
    if (process.env.NODE_ENV === "production" && !verifyShopifyWebhook(req)) {
      return res.status(401).send("Invalid HMAC");
    }

    const order = req.body;
    const orderId = order.id;
    const orderName = order.name;
    const totalAmount = parseFloat(order.total_price);
    const customerCountry = order.shipping_address?.country_code || order.billing_address?.country_code || "IQ";
    const displaySettings = getDisplaySettings(customerCountry);

    const lineItems = [];
    let freeCount = 0;

    // Products
    if (order.line_items) {
      for (const item of order.line_items) {
        const price = parseFloat(item.price || 0);
        const title = item.title || "Product";
        const titleLower = title.toLowerCase();
        
        // Simple check: price = 0 OR title contains "free"
        if (price === 0 || titleLower.includes('free')) {
          freeCount++;
          lineItems.push({
            label: titleLower.includes('free') ? title : `FREE ${title}`,
            amount: 1,
            type: "increase",
            image: "https://tryhydrocat.com/cdn/shop/files/4x.png",
          });
        } else {
          lineItems.push({
            label: title,
            amount: convertToIQD(price * (item.quantity || 1)),
            type: "increase",
            image: "https://tryhydrocat.com/cdn/shop/files/9c90033b1a407ed93d5c7854445cc20c.png",
          });
        }
      }
    }

    // Shipping
    if (order.shipping_lines) {
      for (const shipping of order.shipping_lines) {
        const shippingPrice = parseFloat(shipping.price || 0);
        if (shippingPrice === 0) {
          freeCount++;
          lineItems.push({
            label: "Free Shipping",
            amount: 1,
            type: "increase",
            image: "https://tryhydrocat.com/cdn/shop/files/free-delivery_d5b4e306-16a1-4d29-85da-859025613537.png",
          });
        } else {
          lineItems.push({
            label: "Shipping",
            amount: convertToIQD(shippingPrice),
            type: "increase",
            image: "https://tryhydrocat.com/cdn/shop/files/free-delivery_d5b4e306-16a1-4d29-85da-859025613537.png",
          });
        }
      }
    }

    // Taxes
    if (order.tax_lines) {
      for (const tax of order.tax_lines) {
        const taxPrice = parseFloat(tax.price || 0);
        if (taxPrice > 0) {
          lineItems.push({
            label: `Tax`,
            amount: convertToIQD(taxPrice),
            type: "increase",
            image: "https://images.unsplash.com/photo-1556742049-0cfed4f6a45d?ixlib=rb-4.0.3&auto=format&fit=crop&w=300&h=300&q=80",
          });
        }
      }
    }

    if (lineItems.length === 0) {
      lineItems.push({
        label: `Order ${orderName}`,
        amount: convertToIQD(totalAmount),
        type: "increase",
        image: "https://tryhydrocat.com/cdn/shop/files/9c90033b1a407ed93d5c7854445cc20c.png",
      });
    }

    const referenceId = `SHOPIFY-${orderId}-${Date.now()}`;
    const totalInIQD = lineItems.reduce((sum, item) => sum + item.amount, 0);

    const waylPayload = {
      referenceId,
      total: totalInIQD,
      currency: "IQD",
      lineItem: lineItems,
      webhookUrl: `${BASE_URL}/webhooks/wayl/payment`,
      webhookSecret: crypto.createHash("sha256").update(`${orderId}-${Date.now()}`).digest("hex"),
      redirectionUrl: order.order_status_url || `https://${SHOPIFY_STORE_DOMAIN}/account`,
    };

    const waylRes = await fetch(`${WAYL_API_BASE}/api/v1/links`, {
      method: "POST",
      headers: { "X-WAYL-AUTHENTICATION": WAYL_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify(waylPayload),
    });

    const waylResponse = await waylRes.json();
    if (!waylRes.ok || waylRes.status !== 201) throw new Error(`WAYL Error: ${waylRes.status}`);

    let payUrl = buildWaylUrl(waylResponse.data.url, displaySettings);

    // Save to Shopify
    const orderGID = `gid://shopify/Order/${orderId}`;
    const metafields = [
      { ownerId: orderGID, namespace: "wayl", key: "pay_url", type: "single_line_text_field", value: payUrl },
    ];

    try {
      await shopifyGraphQL(`mutation SetPaymentMetafields($metafields: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $metafields) { metafields { key value } userErrors { field message } } }`, { metafields });
    } catch (error) {
      // Ignore metafields errors
    }

    if (req.headers['x-shopify-topic'] || req.query.redirect === 'true' || AUTO_REDIRECT === 'true') {
      const isArabic = displaySettings.language === 'ar';
      return res.status(200).send(`
        <!DOCTYPE html>
        <html>
        <head><meta charset="UTF-8"><title>Payment</title>
        <style>body{font-family:sans-serif;text-align:center;padding:50px;background:#667eea;color:white}.container{background:rgba(255,255,255,0.1);padding:30px;border-radius:15px;max-width:400px;margin:0 auto}.btn{background:#4CAF50;color:white;padding:12px 25px;text-decoration:none;border-radius:8px}</style>
        </head>
        <body>
        <div class="container">
        <h2>${isArabic ? 'جاري التحويل للدفع' : 'Redirecting to Payment'}</h2>
        <p><strong>${isArabic ? 'طلب:' : 'Order:'}</strong> ${orderName}</p>
        <p><strong>${isArabic ? 'المبلغ:' : 'Amount:'}</strong> $${totalAmount}</p>
        <p><strong>${isArabic ? 'مجاني:' : 'Free:'}</strong> ${freeCount}</p>
        <a href="${payUrl}" class="btn">${isArabic ? 'ادفع الآن' : 'Pay Now'}</a>
        </div>
        <script>setTimeout(() => window.location.href = "${payUrl}", ${REDIRECT_DELAY});</script>
        </body></html>
      `);
    }

    res.json({
      success: true,
      message: `Payment link created for ${orderName}`,
      order_id: orderId,
      pay_url: payUrl,
      free_items: freeCount,
      total_items: lineItems.length,
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/orders/:orderId/pay", async (req, res) => {
  try {
    const orderGID = `gid://shopify/Order/${req.params.orderId}`;
    const data = await shopifyGraphQL(`query GetPaymentUrl($id: ID!) { order(id: $id) { payUrl: metafield(namespace: "wayl", key: "pay_url") { value } } }`, { id: orderGID });
    const payUrl = data?.order?.payUrl?.value;
    if (payUrl) return res.redirect(payUrl);
    res.status(404).json({ error: "Payment link not found" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/pay', async (req, res) => {
  try {
    const data = await shopifyGraphQL(`query GetRecentOrders { orders(first: 3, query: "financial_status:pending", sortKey: CREATED_AT, reverse: true) { edges { node { id name payUrl: metafield(namespace: "wayl", key: "pay_url") { value } } } } }`);
    const orders = data?.orders?.edges || [];
    if (orders.length === 0) return res.send('<h2>No pending orders</h2>');
    const payUrl = orders[0].node.payUrl?.value;
    if (payUrl) return res.redirect(payUrl);
    res.send('<h2>Payment link not available</h2>');
  } catch (error) {
    res.status(500).send('<h2>Error loading payment</h2>');
  }
});

app.get('/payment', (req, res) => {
  const orderId = req.query.order_id;
  if (orderId) {
    const cleanOrderId = orderId.includes('/') ? orderId.split('/').pop() : orderId;
    return res.redirect(`/orders/${cleanOrderId}/pay`);
  }
  res.redirect('/pay');
});

app.post("/webhooks/wayl/payment", async (req, res) => {
  try {
    const { status, referenceId } = req.body || {};
    if (!referenceId) return res.status(400).send("Missing referenceId");
    const match = referenceId.match(/SHOPIFY-(\d+)-/);
    if (!match) return res.status(400).send("Invalid referenceId");
    const orderGID = `gid://shopify/Order/${match[1]}`;
    if (status === "Completed") {
      try {
        await shopifyGraphQL(`mutation orderMarkAsPaid($input: OrderMarkAsPaidInput!) { orderMarkAsPaid(input: $input) { order { id } userErrors { field message } } }`, { input: { id: orderGID } });
      } catch (error) {
        // Ignore payment errors
      }
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Shopify: ${SHOPIFY_STORE_DOMAIN}`);
  console.log(`WAYL API: ${WAYL_API_BASE}`);
  console.log(`1 USD = ${USD_TO_IQD_RATE} IQD`);
  console.log(`FREE detection: price = 0 OR title contains 'free'`);
});