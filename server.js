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

// ==================== ENV ====================
const {
  SHOPIFY_STORE_DOMAIN,
  SHOPIFY_ADMIN_TOKEN,
  SHOPIFY_WEBHOOK_SECRET,
  WAYL_API_KEY,
  WAYL_API_BASE = "https://api.thewayl.com",
  DEFAULT_CURRENCY = "USD",
  BASE_URL = "http://localhost:3000",
  AUTO_REDIRECT = "false",
  REDIRECT_DELAY = "1500", // تقليل وقت التوجيه
} = process.env;

// ==================== CONSTANTS ====================
const USD_TO_IQD_RATE = 1320;

// صور المنتجات - مبسطة للسرعة القصوى
const REAL_PRODUCT_IMAGES = {
  'hydrocat': 'https://tryhydrocat.com/cdn/shop/files/9c90033b1a407ed93d5c7854445cc20c.png',
  'water fountain': 'https://tryhydrocat.com/cdn/shop/files/9c90033b1a407ed93d5c7854445cc20c.png',
  'stainless steel water fountain': 'https://tryhydrocat.com/cdn/shop/files/9c90033b1a407ed93d5c7854445cc20c.png',
  'cat fountain': 'https://tryhydrocat.com/cdn/shop/files/9c90033b1a407ed93d5c7854445cc20c.png',
  '8 filter sets': 'https://tryhydrocat.com/cdn/shop/files/1_189b0f59-a79b-43ef-91c8-6342012c076a.png',
  '4 filter sets': 'https://tryhydrocat.com/cdn/shop/files/4x.png',
  'cat hair scraper': 'https://tryhydrocat.com/cdn/shop/files/S4e10ad5ee06f4701bfae29ffe478a666S_1_1.webp',
  'free shipping': 'https://tryhydrocat.com/cdn/shop/files/free-delivery_d5b4e306-16a1-4d29-85da-859025613537.png',
  'filter': 'https://tryhydrocat.com/cdn/shop/files/4x.png',
  'free': 'https://tryhydrocat.com/cdn/shop/files/S4e10ad5ee06f4701bfae29ffe478a666S_1_1.webp',
  'shipping': 'https://tryhydrocat.com/cdn/shop/files/free-delivery_d5b4e306-16a1-4d29-85da-859025613537.png'
};

const FALLBACK_IMAGE = 'https://images.unsplash.com/photo-1556742049-0cfed4f6a45d?ixlib=rb-4.0.3&auto=format&fit=crop&w=300&h=300&q=80';

// ==================== HELPERS ====================

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
  const testCountry = req.headers["x-test-country"];
  if (testCountry) return testCountry;
  if (ip === "127.0.0.1" || ip === "::1" || (ip && ip.startsWith("192.168."))) return "US";
  return "IQ";
}

function getDisplaySettings(country) {
  const arabicCountries = [
    'IQ', 'SA', 'AE', 'KW', 'QA', 'BH', 'OM', 'YE', 'SY', 'LB', 'JO', 'PS', 
    'EG', 'LY', 'TN', 'DZ', 'MA', 'MR', 'SD', 'SS', 'SO', 'DJ', 'KM'
  ];
  if (arabicCountries.includes(country)) {
    return { language: "ar", currency: "usd", displayCurrency: "USD" };
  }
  return { language: "en", currency: "usd", displayCurrency: "USD" };
}

function convertToIQD(amount, fromCurrency = "USD") {
  if (fromCurrency === "IQD") return Math.round(amount);
  const rates = { USD: USD_TO_IQD_RATE, EUR: USD_TO_IQD_RATE * 1.1, GBP: USD_TO_IQD_RATE * 1.25 };
  const converted = Math.round(amount * (rates[fromCurrency] || USD_TO_IQD_RATE));
  return Math.max(converted, 1000);
}

async function shopifyGraphQL(query, variables = {}) {
  const res = await fetch(`https://${SHOPIFY_STORE_DOMAIN}/admin/api/2024-07/graphql.json`, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const data = await res.json();
  if (!res.ok || data.errors) throw new Error(JSON.stringify(data));
  return data.data;
}

function buildWaylUrl(baseUrl, { language, currency }) {
  if (!baseUrl) return null;
  try {
    const u = new URL(baseUrl);
    if (!u.searchParams.get("lang")) u.searchParams.set("lang", language);
    if (!u.searchParams.get("currency")) u.searchParams.set("currency", currency);
    return u.toString();
  } catch (error) {
    const separator = baseUrl.includes('?') ? '&' : '?';
    return `${baseUrl}${separator}lang=${language}&currency=${currency}`;
  }
}

// دالة سريعة لاستخراج الصور - محسنة للسرعة
function getProductImage(item) {
  const title = (item.title || '').toLowerCase();
  
  // صور Shopify أولاً (سريع)
  if (item.variant_image_url && item.variant_image_url.includes('tryhydrocat.com')) return item.variant_image_url;
  if (item.image_url && item.image_url.includes('tryhydrocat.com')) return item.image_url;
  if (item.featured_image && item.featured_image.includes('tryhydrocat.com')) return item.featured_image;
  
  // البحث السريع في الصور المحفوظة
  for (const keyword in REAL_PRODUCT_IMAGES) {
    if (title.includes(keyword)) return REAL_PRODUCT_IMAGES[keyword];
  }
  
  return FALLBACK_IMAGE;
}

// الإصلاح الرئيسي: دالة ذكية للمنتجات المجانية مع أولوية للعنوان
function isItemFree(item) {
  const title = (item.title || '').toLowerCase();
  const price = parseFloat(item.price || 0);
  const comparePrice = parseFloat(item.compare_at_price || 0);
  
  // الأولوية الأولى: إذا العنوان يحتوي على FREE أو + FREE = مجاني مهما كان السعر
  if (title.includes('+ free') || title.includes('+free') || 
      title.includes('free ') || title.startsWith('free')) {
    return true;
  }
  
  // الأولوية الثانية: إذا السعر = 0 والـ compare_at_price > 0 = هدية
  if (price === 0 && comparePrice > 0) {
    return true;
  }
  
  // الأولوية الثالثة: إذا السعر = 0 فقط
  if (price === 0) {
    return true;
  }
  
  return false;
}

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

// ==================== ROUTES ====================

app.get("/", (_req, res) => {
  res.type("text/plain").send("WAYL-Shopify Integration is running. Try /health");
});

app.get("/health", (req, res) => {
  const country = detectCustomerCountry(req);
  const settings = getDisplaySettings(country);
  res.json({
    ok: true,
    timestamp: new Date().toISOString(),
    detected_country: country,
    display_settings: settings,
    conversion_rate: USD_TO_IQD_RATE,
    node_version: process.version,
    base_url: BASE_URL,
    auto_redirect: AUTO_REDIRECT,
    redirect_delay: REDIRECT_DELAY,
    arabic_countries_supported: 22,
    real_product_images: Object.keys(REAL_PRODUCT_IMAGES).length,
  });
});

app.get("/test/wayl", async (req, res) => {
  try {
    const country = detectCustomerCountry(req);
    const settings = getDisplaySettings(country);
    const testRes = await fetch(`${WAYL_API_BASE}/api/v1/verify-auth-key`, {
      headers: { "X-WAYL-AUTHENTICATION": WAYL_API_KEY },
    });
    const testData = await testRes.json();
    res.json({
      waylApiStatus: testRes.ok ? "✅ متصل" : "❌ خطأ",
      statusCode: testRes.status,
      response: testData,
      detected_country: country,
      display_settings: settings,
      conversion_rate: USD_TO_IQD_RATE,
    });
  } catch (e) {
    res.status(500).json({ error: "❌ فشل الاتصال بـ WAYL API", details: e.message });
  }
});

// Webhook محسن للسرعة القصوى - إزالة جميع console.log غير الضرورية
app.post("/webhooks/shopify/orders/create", async (req, res) => {
  try {
    if (process.env.NODE_ENV === "production") {
      if (!verifyShopifyWebhook(req)) {
        return res.status(401).send("Invalid HMAC");
      }
    }

    const order = req.body;
    const orderId = order.id;
    const orderName = order.name;
    const totalAmount = parseFloat(order.total_price);
    const currency = order.currency;

    const customerCountry = order.shipping_address?.country_code || 
                           order.billing_address?.country_code || 
                           detectCustomerCountry(req);
    const displaySettings = getDisplaySettings(customerCountry);

    const lineItems = [];
    let freeItemsCount = 0;
    
    // معالجة المنتجات - محسنة للسرعة
    if (order.line_items?.length) {
      for (const item of order.line_items) {
        const isFree = isItemFree(item);
        const productImage = getProductImage(item);
        
        if (isFree) {
          freeItemsCount++;
          lineItems.push({
            label: item.title || "Free Product",
            amount: 1, // 1 IQD للمنتجات المجانية فقط
            type: "increase",
            image: productImage,
          });
        } else {
          const itemPriceUSD = parseFloat(item.price);
          const itemQuantity = item.quantity;
          const totalItemUSD = itemPriceUSD * itemQuantity;
          const amountInIQD = convertToIQD(totalItemUSD, currency);

          lineItems.push({
            label: item.title || "Product",
            amount: amountInIQD,
            type: "increase",
            image: productImage,
          });
        }
      }
    }

    // معالجة الشحن - سريعة
    if (order.shipping_lines?.length) {
      for (const shipping of order.shipping_lines) {
        const shippingAmountUSD = parseFloat(shipping.price);
        const shippingImage = getProductImage({ title: shipping.title || "Shipping" });
        
        if (shippingAmountUSD === 0) {
          freeItemsCount++;
          lineItems.push({
            label: shipping.title || "Free Shipping",
            amount: 1,
            type: "increase",
            image: shippingImage,
          });
        } else {
          lineItems.push({
            label: `Shipping - ${shipping.title}`,
            amount: convertToIQD(shippingAmountUSD, currency),
            type: "increase",
            image: shippingImage,
          });
        }
      }
    }

    // معالجة الضرائب - سريعة
    if (order.tax_lines?.length) {
      for (const tax of order.tax_lines) {
        const taxAmountUSD = parseFloat(tax.price);
        if (taxAmountUSD > 0) {
          lineItems.push({
            label: `Tax - ${tax.title}`,
            amount: convertToIQD(taxAmountUSD, currency),
            type: "increase",
            image: FALLBACK_IMAGE,
          });
        }
      }
    }

    // إذا لا توجد عناصر
    if (lineItems.length === 0) {
      const totalInIQDOnly = convertToIQD(totalAmount, currency);
      lineItems.push({
        label: `Order ${orderName}`,
        amount: totalInIQDOnly,
        type: "increase",
        image: FALLBACK_IMAGE,
      });
    }

    const referenceId = `SHOPIFY-${orderId}-${Date.now()}`;
    const orderGID = `gid://shopify/Order/${orderId}`;
    const totalInIQD = lineItems.reduce((sum, i) => sum + i.amount, 0);

    const waylPayload = {
      referenceId,
      total: totalInIQD,
      currency: "IQD",
      lineItem: lineItems,
      webhookUrl: `${BASE_URL}/webhooks/wayl/payment`,
      webhookSecret: crypto.createHash("sha256").update(`${orderId}-${Date.now()}`).digest("hex"),
      redirectionUrl: order.order_status_url || `https://${SHOPIFY_STORE_DOMAIN}/account`,
    };

    // استدعاء WAYL بدون معالجة أخطاء معقدة للسرعة
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
      throw new Error(`WAYL API Error: ${waylRes.status}`);
    }

    let payUrl = waylResponse.data.url;
    const waylLinkId = waylResponse.data.id;

    payUrl = buildWaylUrl(payUrl, displaySettings);

    // حفظ البيانات في Shopify - بأسرع طريقة ممكنة
    const metafields = [
      { ownerId: orderGID, namespace: "wayl", key: "pay_url", type: "single_line_text_field", value: payUrl },
      { ownerId: orderGID, namespace: "wayl", key: "pay_url_base", type: "single_line_text_field", value: waylResponse.data.url },
      { ownerId: orderGID, namespace: "wayl", key: "reference_id", type: "single_line_text_field", value: referenceId },
      { ownerId: orderGID, namespace: "wayl", key: "link_id", type: "single_line_text_field", value: waylLinkId },
      { ownerId: orderGID, namespace: "wayl", key: "display_amount", type: "single_line_text_field", value: `${totalAmount} ${currency}` },
      { ownerId: orderGID, namespace: "wayl", key: "payment_amount", type: "single_line_text_field", value: `${totalInIQD} IQD` },
      { ownerId: orderGID, namespace: "wayl", key: "display_settings", type: "single_line_text_field", value: JSON.stringify(displaySettings) },
      { ownerId: orderGID, namespace: "wayl", key: "customer_country", type: "single_line_text_field", value: customerCountry },
    ];

    // استدعاءات Shopify متوازية للسرعة القصوى
    const [metafieldsResult, noteResult] = await Promise.all([
      shopifyGraphQL(`
        mutation SetPaymentMetafields($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            metafields { key value }
            userErrors { field message }
          }
        }
      `, { metafields }),
      
      shopifyGraphQL(`
        mutation orderUpdate($input: OrderInput!) {
          orderUpdate(input: $input) {
            order { id note }
            userErrors { field message }
          }
        }
      `, { 
        input: { 
          id: orderGID, 
          note: (order.note || "") + `\n\n--- WAYL Payment ---\nURL: ${payUrl}\nRef: ${referenceId}\nDisplay: ${totalAmount} ${currency}\nPayment: ${totalInIQD} IQD\nFree: ${freeItemsCount}` 
        } 
      })
    ]);

    const shouldRedirect = req.headers['x-shopify-topic'] || 
                           req.query.redirect === 'true' || 
                           AUTO_REDIRECT === 'true';

    if (shouldRedirect) {
      const isArabic = displaySettings.language === 'ar';
      return res.status(200).send(`
        <!DOCTYPE html>
        <html lang="${displaySettings.language}" dir="${isArabic ? 'rtl' : 'ltr'}">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>${isArabic ? `تحويل للدفع - ${orderName}` : `Redirecting - ${orderName}`}</title>
          <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body { 
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              color: white; min-height: 100vh; display: flex; align-items: center; justify-content: center;
              direction: ${isArabic ? 'rtl' : 'ltr'};
            }
            .container {
              background: rgba(255, 255, 255, 0.1); backdrop-filter: blur(10px);
              border-radius: 20px; padding: 40px; text-align: center; max-width: 450px; width: 90%;
              box-shadow: 0 20px 40px rgba(0,0,0,0.1); border: 1px solid rgba(255,255,255,0.2);
            }
            .emoji { font-size: 3rem; margin-bottom: 20px; animation: bounce 2s infinite; }
            h2 { font-size: 1.5rem; margin-bottom: 20px; font-weight: 600; }
            .order-info {
              background: rgba(255,255,255,0.1); padding: 15px; border-radius: 10px;
              margin: 20px 0; border: 1px solid rgba(255,255,255,0.2);
            }
            .loader { 
              margin: 20px auto; border: 4px solid rgba(255,255,255,0.3); 
              border-top: 4px solid #fff; border-radius: 50%; 
              width: 50px; height: 50px; animation: spin 1s linear infinite; 
            }
            .countdown { font-size: 2rem; font-weight: bold; color: #FFD700; margin: 10px 0; }
            .btn {
              background: linear-gradient(45deg, #4CAF50, #45a049); color: white;
              border: none; padding: 15px 30px; border-radius: 10px; cursor: pointer;
              font-size: 16px; font-weight: 600; margin-top: 20px; text-decoration: none;
              display: inline-block; transition: all 0.3s ease;
            }
            @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
            @keyframes bounce {
              0%, 20%, 50%, 80%, 100% { transform: translateY(0); }
              40% { transform: translateY(-10px); } 60% { transform: translateY(-5px); }
            }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="emoji">💳</div>
            <h2>${isArabic ? 'جاري تحويلك لإكمال الدفع' : 'Redirecting to Payment'}</h2>
            <div class="order-info">
              <strong>${isArabic ? 'طلب رقم:' : 'Order:'}</strong> ${orderName}<br>
              <strong>${isArabic ? 'المبلغ:' : 'Amount:'}</strong> $${totalAmount}
            </div>
            <div class="loader"></div>
            <p>${isArabic ? 'سيتم التحويل خلال:' : 'Redirecting in:'} <span class="countdown" id="countdown">2</span> ${isArabic ? 'ثانية' : 'seconds'}</p>
            <a href="${payUrl}" class="btn" onclick="redirectNow()">${isArabic ? 'اذهب للدفع الآن' : 'Go to Payment'}</a>
          </div>
          <script>
            let timeLeft = 2;
            const countdownElement = document.getElementById('countdown');
            const paymentUrl = "${payUrl}";
            function updateCountdown() {
              countdownElement.textContent = timeLeft;
              if (timeLeft <= 0) { redirectNow(); return; }
              timeLeft--; setTimeout(updateCountdown, 1000);
            }
            function redirectNow() { window.location.href = paymentUrl; }
            updateCountdown();
            setTimeout(redirectNow, ${REDIRECT_DELAY});
            document.addEventListener('click', redirectNow);
            document.addEventListener('keydown', function(e) {
              if (e.key === 'Enter' || e.key === ' ') redirectNow();
            });
          </script>
        </body>
        </html>
      `);
    }

    res.status(200).json({
      success: true,
      message: `Payment link created for ${orderName}`,
      order_id: orderId,
      reference_id: referenceId,
      pay_url: payUrl,
      pay_url_base: waylResponse.data.url,
      display_amount: `${totalAmount} ${currency}`,
      payment_amount: `${totalInIQD} IQD`,
      display_settings: displaySettings,
      customer_country: customerCountry,
      conversion_rate: USD_TO_IQD_RATE,
      free_items: freeItemsCount,
      total_items: lineItems.length,
    });

  } catch (e) {
    console.error("❌ Error:", e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/pay/:referenceId", (req, res) => {
  try {
    const { referenceId } = req.params;
    const country = req.query.country || detectCustomerCountry(req);
    const settings = getDisplaySettings(country);
    const baseUrl = req.query.base_url || `https://link.thewayl.com/pay?id=${referenceId}`;
    const finalUrl = buildWaylUrl(baseUrl, settings);
    return res.redirect(finalUrl);
  } catch (e) {
    res.status(500).send("Error creating payment link");
  }
});

app.get("/orders/:orderId/pay", async (req, res) => {
  try {
    const { orderId } = req.params;
    const country = req.query.country || detectCustomerCountry(req);
    const settings = getDisplaySettings(country);
    const orderGID = `gid://shopify/Order/${orderId}`;

    const query = `
      query GetWaylLinks($id: ID!) {
        order(id: $id) {
          id name
          payUrlBase: metafield(namespace: "wayl", key: "pay_url_base") { value }
          payUrl: metafield(namespace: "wayl", key: "pay_url") { value }
          display: metafield(namespace: "wayl", key: "display_settings") { value }
          savedCountry: metafield(namespace: "wayl", key: "customer_country") { value }
        }
      }
    `;

    const data = await shopifyGraphQL(query, { id: orderGID });
    const order = data?.order;
    const base = order?.payUrlBase?.value || order?.payUrl?.value;
    
    if (!base) {
      return res.status(404).json({ ok: false, message: "Payment link not found" });
    }

    const effectiveCountry = order?.savedCountry?.value || country;
    let effSettings = getDisplaySettings(effectiveCountry);
    
    if (order?.display?.value) {
      try {
        const saved = JSON.parse(order.display.value);
        effSettings = { 
          language: saved.language || effSettings.language, 
          currency: saved.currency || effSettings.currency 
        };
      } catch (_) {}
    }

    const finalUrl = buildWaylUrl(base, effSettings);
    return res.redirect(finalUrl);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/redirect-to-payment/:orderId', async (req, res) => {
  try {
    const orderId = req.params.orderId;
    const orderGID = `gid://shopify/Order/${orderId}`;
    
    const query = `
      query GetPaymentUrl($id: ID!) {
        order(id: $id) {
          name
          payUrl: metafield(namespace: "wayl", key: "pay_url") { value }
        }
      }
    `;
    
    const data = await shopifyGraphQL(query, { id: orderGID });
    const payUrl = data?.order?.payUrl?.value;
    
    if (payUrl) return res.redirect(payUrl);
    res.status(404).send('Payment link not found');
  } catch (e) {
    res.status(500).send('Error: ' + e.message);
  }
});

app.get('/pay', async (req, res) => {
    try {
        const query = `
            query GetRecentPendingOrders {
                orders(first: 3, query: "financial_status:pending", sortKey: CREATED_AT, reverse: true) {
                    edges {
                        node {
                            id name
                            payUrl: metafield(namespace: "wayl", key: "pay_url") { value }
                            payUrlBase: metafield(namespace: "wayl", key: "pay_url_base") { value }
                            savedCountry: metafield(namespace: "wayl", key: "customer_country") { value }
                            display: metafield(namespace: "wayl", key: "display_settings") { value }
                        }
                    }
                }
            }
        `;
        
        const data = await shopifyGraphQL(query);
        const orders = data?.orders?.edges || [];
        
        if (orders.length === 0) {
            return res.send(`
                <!DOCTYPE html>
                <html><head><meta charset="UTF-8"><title>No Orders</title>
                <style>body{font-family:sans-serif;text-align:center;padding:50px;background:#f5f7fa;min-height:100vh;display:flex;align-items:center;justify-content:center}.container{background:white;padding:40px;border-radius:15px;box-shadow:0 10px 30px rgba(0,0,0,0.1);max-width:500px}.btn{background:#4CAF50;color:white;padding:12px 24px;text-decoration:none;border-radius:8px;display:inline-block;margin-top:20px;font-weight:600}.emoji{font-size:3rem;margin-bottom:20px}</style></head>
                <body><div class="container"><div class="emoji">❌</div>
                <h2>No pending orders</h2>
                <p>All orders are paid or no recent orders found</p>
                <a href="https://${SHOPIFY_STORE_DOMAIN}" class="btn">Back to Store</a>
                </div></body></html>
            `);
        }
        
        const latestOrder = orders[0].node;
        const detectedCountry = detectCustomerCountry(req);
        const savedCountry = latestOrder.savedCountry?.value;
        const effectiveCountry = savedCountry || detectedCountry;
        let settings = getDisplaySettings(effectiveCountry);
        
        if (latestOrder.display?.value) {
            try {
                const savedSettings = JSON.parse(latestOrder.display.value);
                settings = {
                    language: savedSettings.language || settings.language,
                    currency: savedSettings.currency || settings.currency
                };
            } catch (_) {}
        }
        
        if (latestOrder.payUrl?.value || latestOrder.payUrlBase?.value) {
            const baseUrl = latestOrder.payUrlBase?.value || latestOrder.payUrl?.value;
            const finalUrl = buildWaylUrl(baseUrl, settings);
            return res.redirect(finalUrl);
        }
        
        return res.send(`
            <!DOCTYPE html>
            <html><head><meta charset="UTF-8"><title>Payment Link Not Found</title>
            <style>body{font-family:sans-serif;text-align:center;padding:50px;background:#ff6b6b;min-height:100vh;display:flex;align-items:center;justify-content:center;color:white}.container{background:rgba(255,255,255,0.1);padding:40px;border-radius:15px;backdrop-filter:blur(10px);max-width:500px}.btn{background:white;color:#333;padding:12px 24px;text-decoration:none;border-radius:8px;display:inline-block;margin-top:20px;font-weight:600}.emoji{font-size:3rem;margin-bottom:20px}</style></head>
            <body><div class="container"><div class="emoji">⚠️</div>
            <h2>Payment link not available</h2>
            <p>Order ${latestOrder.name} found but payment link not created yet.</p>
            <a href="https://${SHOPIFY_STORE_DOMAIN}" class="btn">Back to Store</a>
            </div></body></html>
        `);
        
    } catch (error) {
        res.status(500).send(`
            <!DOCTYPE html>
            <html><head><meta charset="UTF-8"><title>Error</title>
            <style>body{font-family:sans-serif;text-align:center;padding:50px;background:#ff6b6b;min-height:100vh;display:flex;align-items:center;justify-content:center;color:white}.container{background:rgba(255,255,255,0.1);padding:40px;border-radius:15px;backdrop-filter:blur(10px);max-width:500px}.btn{background:white;color:#333;padding:12px 24px;text-decoration:none;border-radius:8px;display:inline-block;margin-top:20px;font-weight:600}.emoji{font-size:3rem;margin-bottom:20px}</style></head>
            <body><div class="container"><div class="emoji">❌</div>
            <h2>Payment processing error</h2>
            <p>Sorry, an error occurred while accessing the payment link</p>
            <a href="https://${SHOPIFY_STORE_DOMAIN}" class="btn">Back to Store</a>
            </div></body></html>
        `);
    }
});

app.get('/payment', async (req, res) => {
    try {
        const orderId = req.query.order_id;
        if (orderId) {
            const cleanOrderId = orderId.includes('/') ? orderId.split('/').pop() : orderId;
            return res.redirect(`/orders/${cleanOrderId}/pay`);
        }
        res.redirect('/pay');
    } catch (error) {
        res.redirect('/pay');
    }
});

app.post("/webhooks/wayl/payment", async (req, res) => {
  try {
    const { status, referenceId, id: transactionId, completedAt } = req.body || {};

    if (!referenceId) return res.status(400).send("Missing referenceId");

    const match = referenceId.match(/SHOPIFY-(\d+)-/);
    if (!match) return res.status(400).send("Invalid referenceId format");

    const orderId = match[1];
    const orderGID = `gid://shopify/Order/${orderId}`;

    if (status === "Completed") {
      await Promise.all([
        shopifyGraphQL(`
          mutation orderMarkAsPaid($input: OrderMarkAsPaidInput!) {
            orderMarkAsPaid(input: $input) {
              order { id displayFinancialStatus }
              userErrors { field message }
            }
          }
        `, { input: { id: orderGID } }),
        
        shopifyGraphQL(`
          mutation SetPaymentMetafields($metafields: [MetafieldsSetInput!]!) {
            metafieldsSet(metafields: $metafields) {
              metafields { key value }
              userErrors { field message }
            }
          }
        `, { 
          metafields: [
            { ownerId: orderGID, namespace: "wayl", key: "payment_status", type: "single_line_text_field", value: "completed" },
            { ownerId: orderGID, namespace: "wayl", key: "transaction_id", type: "single_line_text_field", value: transactionId || "" },
            { ownerId: orderGID, namespace: "wayl", key: "completed_at", type: "single_line_text_field", value: completedAt || new Date().toISOString() },
          ]
        }),
        
        shopifyGraphQL(`
          mutation tagsAdd($id: ID!, $tags: [String!]!) {
            tagsAdd(id: $id, tags: $tags) {
              node { id }
              userErrors { field message }
            }
          }
        `, { id: orderGID, tags: ["WAYL-PAID", transactionId ? `WAYL-TX-${transactionId}` : "WAYL-TX-UNKNOWN", "WAYL-USD-DISPLAY"] })
      ]);
    }

    res.status(200).json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== START ====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 WAYL-Shopify Server running on port ${PORT}`);
  console.log(`🔗 BASE_URL: ${BASE_URL}`);
  console.log(`🛍️ Shopify: ${SHOPIFY_STORE_DOMAIN}`);
  console.log(`💳 WAYL API: ${WAYL_API_BASE}`);
  console.log(`💱 1 USD = ${USD_TO_IQD_RATE} IQD`);
  console.log(`🔄 AUTO_REDIRECT: ${AUTO_REDIRECT}`);
  console.log(`⏱️ REDIRECT_DELAY: ${REDIRECT_DELAY}ms`);
  console.log(`💰 Payment Route: ${BASE_URL}/pay`);
  console.log(`🎯 Smart Payment Route: ${BASE_URL}/payment?order_id=ORDER_ID`);
  console.log(`🌍 Arabic Countries: 22 supported`);
  console.log(`🗣️ Languages: Arabic (ar) + English (en)`);
  console.log(`💵 Display Currency: USD for all countries`);
  console.log(`💰 Payment Currency: IQD (Iraqi Dinar)`);
  console.log(`🖼️ Real Store Images: ${Object.keys(REAL_PRODUCT_IMAGES).length} products`);
  console.log(`🎁 FREE Items: Title-based detection - ANY item with FREE in title = free`);
});