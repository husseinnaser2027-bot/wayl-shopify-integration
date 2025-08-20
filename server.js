import express from "express";
import crypto from "crypto";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();

app.use(express.json({
  type: "*/*",
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

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

const IMAGES = {
  hydrocat: 'https://tryhydrocat.com/cdn/shop/files/9c90033b1a407ed93d5c7854445cc20c.png',
  water: 'https://tryhydrocat.com/cdn/shop/files/9c90033b1a407ed93d5c7854445cc20c.png',
  fountain: 'https://tryhydrocat.com/cdn/shop/files/9c90033b1a407ed93d5c7854445cc20c.png',
  filter: 'https://tryhydrocat.com/cdn/shop/files/4x.png',
  shipping: 'https://tryhydrocat.com/cdn/shop/files/free-delivery_d5b4e306-16a1-4d29-85da-859025613537.png',
};

const FALLBACK_IMAGE = 'https://images.unsplash.com/photo-1556742049-0cfed4f6a45d?ixlib=rb-4.0.3&auto=format&fit=crop&w=300&h=300&q=80';

function verifyShopifyWebhook(req) {
  try {
    if (!SHOPIFY_WEBHOOK_SECRET) return false;
    const hmacHeader = req.get("X-Shopify-Hmac-Sha256") || "";
    const digest = crypto
      .createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
      .update(req.rawBody || Buffer.from(JSON.stringify(req.body)), "utf8")
      .digest("base64");
    return crypto.timingSafeEqual(Buffer.from(hmacHeader), Buffer.from(digest));
  } catch (e) {
    return false;
  }
}

function detectCustomerCountry(req) {
  const forwardedFor = req.headers["x-forwarded-for"];
  const ip = forwardedFor ? forwardedFor.split(",")[0] : req.connection?.remoteAddress;
  if (ip === "127.0.0.1" || ip === "::1" || (ip && ip.startsWith("192.168."))) return "US";
  return "IQ";
}

function getDisplaySettings(country) {
  const arabicCountries = ['IQ', 'SA', 'AE', 'KW', 'QA', 'BH', 'OM', 'YE', 'SY', 'LB', 'JO', 'PS', 'EG', 'LY', 'TN', 'DZ', 'MA', 'MR', 'SD', 'SS', 'SO', 'DJ', 'KM'];
  return arabicCountries.includes(country) 
    ? { language: "ar", currency: "usd" }
    : { language: "en", currency: "usd" };
}

function convertToIQD(amount) {
  const converted = Math.round(amount * USD_TO_IQD_RATE);
  return Math.max(converted, 1000);
}

async function shopifyGraphQL(query, variables = {}) {
  try {
    const res = await fetch(`https://${SHOPIFY_STORE_DOMAIN}/admin/api/2024-07/graphql.json`, {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });
    const data = await res.json();
    if (!res.ok || data.errors) throw new Error("GraphQL Error");
    return data.data;
  } catch (error) {
    console.error("Shopify error:", error.message);
    throw error;
  }
}

function buildWaylUrl(baseUrl, { language, currency }) {
  if (!baseUrl) return null;
  try {
    const u = new URL(baseUrl);
    u.searchParams.set("lang", language);
    u.searchParams.set("currency", currency);
    return u.toString();
  } catch (error) {
    return `${baseUrl}?lang=${language}&currency=${currency}`;
  }
}

function getImage(title) {
  if (!title) return FALLBACK_IMAGE;
  const t = title.toLowerCase();
  
  if (t.includes('hydrocat') || t.includes('water') || t.includes('fountain')) return IMAGES.hydrocat;
  if (t.includes('filter')) return IMAGES.filter;
  if (t.includes('shipping')) return IMAGES.shipping;
  
  return FALLBACK_IMAGE;
}

app.get("/", (req, res) => {
  res.send("WAYL-Shopify Integration is running");
});

app.get("/health", (req, res) => {
  res.json({ 
    ok: true, 
    timestamp: new Date().toISOString(),
    conversion_rate: USD_TO_IQD_RATE 
  });
});

app.post("/webhooks/shopify/orders/create", async (req, res) => {
  try {
    console.log("New order received");

    if (process.env.NODE_ENV === "production" && !verifyShopifyWebhook(req)) {
      return res.status(401).send("Invalid HMAC");
    }

    const order = req.body;
    const orderId = order.id;
    const orderName = order.name;
    const totalAmount = parseFloat(order.total_price);

    console.log(`Order: ${orderName}, Total: $${totalAmount}`);

    const customerCountry = order.shipping_address?.country_code || 
                           order.billing_address?.country_code || 
                           detectCustomerCountry(req);
    const displaySettings = getDisplaySettings(customerCountry);

    const lineItems = [];
    let freeCount = 0;

    // Process products
    if (order.line_items && order.line_items.length > 0) {
      for (const item of order.line_items) {
        const price = parseFloat(item.price || 0);
        const quantity = parseInt(item.quantity || 1);
        const title = item.title || "Product";
        
        console.log(`Item: ${title}, Price: $${price}`);
        
        if (price === 0) {
          // Free item
          freeCount++;
          lineItems.push({
            label: title.toLowerCase().includes('free') ? title : `FREE ${title}`,
            amount: 1,
            type: "increase",
            image: getImage(title),
          });
          console.log(`Free item: ${title}`);
        } else {
          // Paid item
          const totalUSD = price * quantity;
          const totalIQD = convertToIQD(totalUSD);
          lineItems.push({
            label: title,
            amount: totalIQD,
            type: "increase",
            image: getImage(title),
          });
          console.log(`Paid item: ${title} = ${totalIQD} IQD`);
        }
      }
    }

    // Process shipping
    if (order.shipping_lines && order.shipping_lines.length > 0) {
      for (const shipping of order.shipping_lines) {
        const shippingPrice = parseFloat(shipping.price || 0);
        let shippingLabel = shipping.title || "Shipping";
        
        if (shippingPrice === 0) {
          freeCount++;
          if (!shippingLabel.toLowerCase().includes('free')) {
            shippingLabel = `Free ${shippingLabel}`;
          }
          lineItems.push({
            label: shippingLabel,
            amount: 1,
            type: "increase",
            image: IMAGES.shipping,
          });
        } else {
          lineItems.push({
            label: shippingLabel,
            amount: convertToIQD(shippingPrice),
            type: "increase",
            image: IMAGES.shipping,
          });
        }
      }
    }

    // Process taxes
    if (order.tax_lines && order.tax_lines.length > 0) {
      for (const tax of order.tax_lines) {
        const taxPrice = parseFloat(tax.price || 0);
        if (taxPrice > 0) {
          lineItems.push({
            label: `Tax - ${tax.title}`,
            amount: convertToIQD(taxPrice),
            type: "increase",
            image: FALLBACK_IMAGE,
          });
        }
      }
    }

    // Fallback
    if (lineItems.length === 0) {
      lineItems.push({
        label: `Order ${orderName}`,
        amount: convertToIQD(totalAmount),
        type: "increase",
        image: FALLBACK_IMAGE,
      });
    }

    const referenceId = `SHOPIFY-${orderId}-${Date.now()}`;
    const totalInIQD = lineItems.reduce((sum, item) => sum + item.amount, 0);

    console.log(`Free items: ${freeCount}, Total items: ${lineItems.length}, Total: ${totalInIQD} IQD`);

    const waylPayload = {
      referenceId,
      total: totalInIQD,
      currency: "IQD",
      lineItem: lineItems,
      webhookUrl: `${BASE_URL}/webhooks/wayl/payment`,
      webhookSecret: crypto.createHash("sha256").update(`${orderId}-${Date.now()}`).digest("hex"),
      redirectionUrl: order.order_status_url || `https://${SHOPIFY_STORE_DOMAIN}/account`,
    };

    console.log("Sending to WAYL...");

    const waylRes = await fetch(`${WAYL_API_BASE}/api/v1/links`, {
      method: "POST",
      headers: {
        "X-WAYL-AUTHENTICATION": WAYL_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(waylPayload),
    });

    const waylResponse = await waylRes.json();

    if (!waylRes.ok || waylRes.status !== 201) {
      console.error("WAYL error:", waylResponse);
      throw new Error(`WAYL Error: ${waylRes.status}`);
    }

    let payUrl = waylResponse.data.url;
    payUrl = buildWaylUrl(payUrl, displaySettings);

    console.log("WAYL link created:", payUrl);

    // Save to Shopify
    const orderGID = `gid://shopify/Order/${orderId}`;
    const metafields = [
      { ownerId: orderGID, namespace: "wayl", key: "pay_url", type: "single_line_text_field", value: payUrl },
      { ownerId: orderGID, namespace: "wayl", key: "reference_id", type: "single_line_text_field", value: referenceId },
    ];

    try {
      await shopifyGraphQL(`
        mutation SetPaymentMetafields($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            metafields { key value }
            userErrors { field message }
          }
        }
      `, { metafields });
      console.log("Saved to Shopify");
    } catch (error) {
      console.error("Metafields error:", error.message);
    }

    const shouldRedirect = req.headers['x-shopify-topic'] || 
                           req.query.redirect === 'true' || 
                           AUTO_REDIRECT === 'true';

    if (shouldRedirect) {
      const isArabic = displaySettings.language === 'ar';
      return res.status(200).send(`
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <title>Payment Redirect</title>
          <style>
            body { font-family: sans-serif; text-align: center; padding: 50px; background: #667eea; color: white; }
            .container { background: rgba(255,255,255,0.1); padding: 30px; border-radius: 15px; max-width: 400px; margin: 0 auto; }
            .btn { background: #4CAF50; color: white; padding: 12px 25px; text-decoration: none; border-radius: 8px; }
          </style>
        </head>
        <body>
          <div class="container">
            <h2>${isArabic ? 'جاري التحويل للدفع' : 'Redirecting to Payment'}</h2>
            <p><strong>${isArabic ? 'طلب:' : 'Order:'}</strong> ${orderName}</p>
            <p><strong>${isArabic ? 'المبلغ:' : 'Amount:'}</strong> $${totalAmount}</p>
            <a href="${payUrl}" class="btn">${isArabic ? 'ادفع الآن' : 'Pay Now'}</a>
          </div>
          <script>
            setTimeout(() => window.location.href = "${payUrl}", ${REDIRECT_DELAY});
          </script>
        </body>
        </html>
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
    console.error("Order processing error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get("/orders/:orderId/pay", async (req, res) => {
  try {
    const { orderId } = req.params;
    const orderGID = `gid://shopify/Order/${orderId}`;

    const data = await shopifyGraphQL(`
      query GetPaymentUrl($id: ID!) {
        order(id: $id) {
          payUrl: metafield(namespace: "wayl", key: "pay_url") { value }
        }
      }
    `, { id: orderGID });

    const payUrl = data?.order?.payUrl?.value;
    if (payUrl) return res.redirect(payUrl);
    
    res.status(404).json({ error: "Payment link not found" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/pay', async (req, res) => {
  try {
    const data = await shopifyGraphQL(`
      query GetRecentOrders {
        orders(first: 3, query: "financial_status:pending", sortKey: CREATED_AT, reverse: true) {
          edges {
            node {
              id name
              payUrl: metafield(namespace: "wayl", key: "pay_url") { value }
            }
          }
        }
      }
    `);
    
    const orders = data?.orders?.edges || [];
    if (orders.length === 0) {
      return res.send('<h2>No pending orders</h2>');
    }
    
    const latestOrder = orders[0].node;
    const payUrl = latestOrder.payUrl?.value;
    
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

    const orderId = match[1];
    const orderGID = `gid://shopify/Order/${orderId}`;

    if (status === "Completed") {
      try {
        await shopifyGraphQL(`
          mutation orderMarkAsPaid($input: OrderMarkAsPaidInput!) {
            orderMarkAsPaid(input: $input) {
              order { id }
              userErrors { field message }
            }
          }
        `, { input: { id: orderGID } });
        console.log(`Order ${orderId} marked as paid`);
      } catch (error) {
        console.error("Payment marking error:", error.message);
      }
    }

    res.json({ success: true });
  } catch (error) {
    console.error("Payment webhook error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Shopify: ${SHOPIFY_STORE_DOMAIN}`);
  console.log(`WAYL API: ${WAYL_API_BASE}`);
  console.log(`Conversion: 1 USD = ${USD_TO_IQD_RATE} IQD`);
  console.log(`Free items: price = 0 → 1 IQD`);
  console.log(`Paid items: price > 0 → convert to IQD`);
});