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

// الصور الصحيحة من شوبيفاي
const IMAGES = {
  // HydroCat Products
  hydrocat: 'https://tryhydrocat.com/cdn/shop/files/9c90033b1a407ed93d5c7854445cc20c.png',
  water: 'https://tryhydrocat.com/cdn/shop/files/9c90033b1a407ed93d5c7854445cc20c.png',
  fountain: 'https://tryhydrocat.com/cdn/shop/files/9c90033b1a407ed93d5c7854445cc20c.png',
  
  // Filter Sets - الصور الصحيحة
  '8 filter': 'https://tryhydrocat.com/cdn/shop/files/1_189b0f59-a79b-43ef-91c8-6342012c076a.png',
  '4 filter': 'https://tryhydrocat.com/cdn/shop/files/4x.png',
  'filter': 'https://tryhydrocat.com/cdn/shop/files/4x.png',
  
  // Cat Hair Scraper - الصورة الصحيحة
  'scraper': 'https://tryhydrocat.com/cdn/shop/files/S4e10ad5ee06f4701bfae29ffe478a666S_1_1.webp',
  'cat hair': 'https://tryhydrocat.com/cdn/shop/files/S4e10ad5ee06f4701bfae29ffe478a666S_1_1.webp',
  
  // Shipping
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

function getCorrectImage(title) {
  if (!title) return FALLBACK_IMAGE;
  const t = title.toLowerCase();
  
  // بحث دقيق للصور
  if (t.includes('hydrocat') || t.includes('water') || t.includes('fountain')) return IMAGES.hydrocat;
  if (t.includes('8 filter')) return IMAGES['8 filter'];
  if (t.includes('4 filter')) return IMAGES['4 filter'];
  if (t.includes('filter')) return IMAGES.filter;
  if (t.includes('scraper') || t.includes('cat hair')) return IMAGES.scraper;
  if (t.includes('shipping')) return IMAGES.shipping;
  
  return FALLBACK_IMAGE;
}

// الدالة المحسنة للكشف عن المنتجات المجانية
function isProductFree(item) {
  const price = parseFloat(item.price || 0);
  const title = (item.title || '').toLowerCase();
  
  console.log(`Checking product: ${item.title}`);
  console.log(`Price: ${price}, Title: ${title}`);
  
  // القاعدة الأولى: إذا السعر = 0 في شوبيفاي = مجاني
  if (price === 0) {
    console.log(`FREE by price: ${item.title}`);
    return true;
  }
  
  // القاعدة الثانية: إذا العنوان يحتوي على كلمة FREE = مجاني (مهما كان السعر)
  if (title.includes('free ') || title.includes('+ free') || title.includes('+free') || title.startsWith('free')) {
    console.log(`FREE by title: ${item.title}`);
    return true;
  }
  
  // القاعدة الثالثة: منتجات معروفة مجانية في البندل
  const knownFreeInBundle = [
    '4 filter sets',
    '8 filter sets', 
    'cat hair scraper',
    'filter sets'
  ];
  
  for (const freeProduct of knownFreeInBundle) {
    if (title.includes(freeProduct.toLowerCase())) {
      console.log(`FREE by known bundle product: ${item.title}`);
      return true;
    }
  }
  
  console.log(`PAID product: ${item.title}`);
  return false;
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
    console.log("=== New Order Processing ===");

    if (process.env.NODE_ENV === "production" && !verifyShopifyWebhook(req)) {
      return res.status(401).send("Invalid HMAC");
    }

    const order = req.body;
    const orderId = order.id;
    const orderName = order.name;
    const totalAmount = parseFloat(order.total_price);

    console.log(`Order: ${orderName}, Shopify Total: $${totalAmount}`);

    const customerCountry = order.shipping_address?.country_code || 
                           order.billing_address?.country_code || 
                           detectCustomerCountry(req);
    const displaySettings = getDisplaySettings(customerCountry);

    const lineItems = [];
    let freeCount = 0;

    // معالجة المنتجات مع الكشف المحسن
    if (order.line_items && order.line_items.length > 0) {
      console.log("\n=== Processing Products ===");
      
      for (const item of order.line_items) {
        const price = parseFloat(item.price || 0);
        const quantity = parseInt(item.quantity || 1);
        const title = item.title || "Product";
        
        console.log(`\nProcessing: ${title}`);
        console.log(`Shopify Price: $${price}, Quantity: ${quantity}`);
        
        const isFree = isProductFree(item);
        const correctImage = getCorrectImage(title);
        
        if (isFree) {
          // منتج مجاني - أرسل 1 IQD
          freeCount++;
          const freeLabel = title.toLowerCase().includes('free') ? title : `FREE ${title}`;
          
          lineItems.push({
            label: freeLabel,
            amount: 1,
            type: "increase",
            image: correctImage,
          });
          
          console.log(`✅ FREE ITEM: ${freeLabel} → 1 IQD`);
        } else {
          // منتج مدفوع - حول السعر
          const totalUSD = price * quantity;
          const totalIQD = convertToIQD(totalUSD);
          
          lineItems.push({
            label: title,
            amount: totalIQD,
            type: "increase",
            image: correctImage,
          });
          
          console.log(`💰 PAID ITEM: ${title} → $${totalUSD} → ${totalIQD} IQD`);
        }
      }
    }

    // معالجة الشحن
    if (order.shipping_lines && order.shipping_lines.length > 0) {
      console.log("\n=== Processing Shipping ===");
      
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
          console.log(`🚚 FREE SHIPPING: ${shippingLabel}`);
        } else {
          lineItems.push({
            label: shippingLabel,
            amount: convertToIQD(shippingPrice),
            type: "increase",
            image: IMAGES.shipping,
          });
          console.log(`🚚 PAID SHIPPING: ${shippingLabel} → ${convertToIQD(shippingPrice)} IQD`);
        }
      }
    }

    // معالجة الضرائب
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

    // احتياط إذا لم توجد عناصر
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

    console.log(`\n=== Order Summary ===`);
    console.log(`Free Items: ${freeCount}`);
    console.log(`Total Items: ${lineItems.length}`);
    console.log(`Shopify Total: $${totalAmount}`);
    console.log(`WAYL Total: ${totalInIQD} IQD`);

    console.log(`\n=== Items for WAYL ===`);
    lineItems.forEach((item, index) => {
      console.log(`${index + 1}. ${item.label} → ${item.amount} IQD`);
    });

    const waylPayload = {
      referenceId,
      total: totalInIQD,
      currency: "IQD",
      lineItem: lineItems,
      webhookUrl: `${BASE_URL}/webhooks/wayl/payment`,
      webhookSecret: crypto.createHash("sha256").update(`${orderId}-${Date.now()}`).digest("hex"),
      redirectionUrl: order.order_status_url || `https://${SHOPIFY_STORE_DOMAIN}/account`,
    };

    console.log("\n=== Sending to WAYL ===");

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
      console.error("WAYL API Error:", waylResponse);
      throw new Error(`WAYL Error: ${waylRes.status}`);
    }

    let payUrl = waylResponse.data.url;
    payUrl = buildWaylUrl(payUrl, displaySettings);

    console.log(`✅ WAYL Link Created: ${payUrl}`);

    // حفظ البيانات في شوبيفاي
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
      console.log("✅ Data saved to Shopify");
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
            <p><strong>${isArabic ? 'مجاني:' : 'Free:'}</strong> ${freeCount}</p>
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
      shopify_total: `$${totalAmount}`,
      wayl_total: `${totalInIQD} IQD`,
      free_items: freeCount,
      total_items: lineItems.length,
      detection_method: "ENHANCED_FREE_DETECTION"
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
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🔗 Shopify: ${SHOPIFY_STORE_DOMAIN}`);
  console.log(`💳 WAYL API: ${WAYL_API_BASE}`);
  console.log(`💱 Conversion: 1 USD = ${USD_TO_IQD_RATE} IQD`);
  console.log(`✅ ENHANCED FREE DETECTION:`);
  console.log(`   - Price = 0 → FREE (1 IQD)`);
  console.log(`   - Title contains 'FREE' → FREE (1 IQD)`);
  console.log(`   - Known bundle items → FREE (1 IQD)`);
  console.log(`🖼️ CORRECT IMAGES: Updated with real Shopify product images`);
});