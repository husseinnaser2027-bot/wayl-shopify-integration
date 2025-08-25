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
  REDIRECT_DELAY = "500",
} = process.env;

// ==================== CONSTANTS ====================
const USD_TO_IQD_RATE = 1320;

const IMAGES = {
  hydrocat: 'https://tryhydrocat.com/cdn/shop/files/9c90033b1a407ed93d5c7854445cc20c.png',
  water: 'https://tryhydrocat.com/cdn/shop/files/9c90033b1a407ed93d5c7854445cc20c.png',
  stainless: 'https://tryhydrocat.com/cdn/shop/files/9c90033b1a407ed93d5c7854445cc20c.png',
  fountain: 'https://tryhydrocat.com/cdn/shop/files/9c90033b1a407ed93d5c7854445cc20c.png',
  filter4: 'https://tryhydrocat.com/cdn/shop/files/4x.png',
  filter8: 'https://tryhydrocat.com/cdn/shop/files/1_189b0f59-a79b-43ef-91c8-6342012c076a.png',
  scraper: 'https://tryhydrocat.com/cdn/shop/files/S4e10ad5ee06f4701bfae29ffe478a666S_1_1.webp',
  shipping: 'https://tryhydrocat.com/cdn/shop/files/free-delivery_d5b4e306-16a1-4d29-85da-859025613537.png',
  free: 'https://tryhydrocat.com/cdn/shop/files/S4e10ad5ee06f4701bfae29ffe478a666S_1_1.webp'
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
  const testCountry = req.headers["x-test-country"];
  if (testCountry) return testCountry;
  const forwardedFor = req.headers["x-forwarded-for"];
  const ip = forwardedFor ? forwardedFor.split(",")[0] : req.connection?.remoteAddress;
  if (ip === "127.0.0.1" || ip === "::1" || (ip && ip.startsWith("192.168."))) return "US";
  return "IQ";
}

function getDisplaySettings(country) {
  const arabicCountries = ['IQ', 'SA', 'AE', 'KW', 'QA', 'BH', 'OM', 'YE', 'SY', 'LB', 'JO', 'PS', 'EG', 'LY', 'TN', 'DZ', 'MA', 'MR', 'SD', 'SS', 'SO', 'DJ', 'KM'];
  if (arabicCountries.includes(country)) {
    return { language: "ar", currency: "usd", displayCurrency: "USD" };
  }
  return { language: "en", currency: "usd", displayCurrency: "USD" };
}

function convertToIQD(amount, fromCurrency = "USD") {
  if (fromCurrency === "IQD") return Math.round(amount);
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
    if (!res.ok || data.errors) throw new Error(JSON.stringify(data));
    return data.data;
  } catch (error) {
    console.error("Shopify GraphQL error:", error);
    throw error;
  }
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

function getImage(title) {
  if (!title) return FALLBACK_IMAGE;
  const t = title.toLowerCase();
  
  if (t.includes('hydrocat')) return IMAGES.hydrocat;
  if (t.includes('water') || t.includes('fountain')) return IMAGES.water;
  if (t.includes('stainless')) return IMAGES.stainless;
  if (t.includes('8 filter')) return IMAGES.filter8;
  if (t.includes('4 filter') || t.includes('filter')) return IMAGES.filter4;
  if (t.includes('scraper')) return IMAGES.scraper;
  if (t.includes('shipping')) return IMAGES.shipping;
  if (t.includes('free')) return IMAGES.free;
  
  return FALLBACK_IMAGE;
}

// النظام المحسن الجديد للكشف عن المنتجات المجانية - يحل مشكلة "4 filter sets"
function isReallyFreeProduct(item) {
  const price = parseFloat(item.price || 0);
  const comparePrice = parseFloat(item.compare_at_price || 0);
  const title = (item.title || '').toLowerCase();
  
  console.log(`فحص المنتج: ${item.title}`);
  console.log(`السعر: ${price}, السعر المقارن: ${comparePrice}`);
  
  // القاعدة الأولى: أي منتج سعره 0 = مجاني مؤكد
  if (price === 0) {
    console.log(`منتج مجاني - السعر = 0`);
    return true;
  }
  
  // القاعدة الثانية: إذا العنوان يحتوي على كلمة free = مجاني
  if (title.includes('free') || title.includes('+ free') || title.includes('+free')) {
    console.log(`منتج مجاني - العنوان يحتوي على FREE`);
    return true;
  }
  
  // القاعدة الثالثة الجديدة: إذا هناك compare_at_price والمنتج مخصوم 100%
  if (comparePrice > 0 && price === 0) {
    console.log(`منتج مجاني - مخصوم 100%`);
    return true;
  }
  
  // القاعدة الرابعة: البندل - إذا compare_at_price موجود وسعر المنتج قليل نسبياً
  if (comparePrice > 0 && price > 0) {
    const discountPercent = ((comparePrice - price) / comparePrice) * 100;
    console.log(`نسبة الخصم: ${discountPercent}%`);
    
    // إذا كان الخصم أكبر من 70% وسعر المنتج أقل من 25$ = يعتبر مجاني في البندل
    if (discountPercent >= 70 && price <= 25) {
      console.log(`منتج مجاني - خصم عالي في البندل`);
      return true;
    }
  }
  
  // القاعدة الخامسة الخاصة: منتجات معينة نعرفها مجانية
  const knownFreeProducts = ['4 filter sets', 'cat hair scraper'];
  for (const freeProduct of knownFreeProducts) {
    if (title.includes(freeProduct.toLowerCase())) {
      console.log(`منتج مجاني - من القائمة المعروفة`);
      return true;
    }
  }
  
  console.log(`منتج مدفوع`);
  return false;
}

function getCorrectPrice(item, currency) {
  if (isReallyFreeProduct(item)) {
    return 1; // 1 IQD للمنتجات المجانية
  }
  
  const price = parseFloat(item.price || 0);
  const quantity = item.quantity || 1;
  const totalUSD = price * quantity;
  return convertToIQD(totalUSD, currency);
}

function getCorrectLabel(item) {
  const title = item.title || "Product";
  
  if (isReallyFreeProduct(item)) {
    // إذا لم يحتوي العنوان على FREE، أضفها
    if (!title.toLowerCase().includes('free')) {
      return `FREE ${title}`;
    }
    // إذا كان يحتوي على FREE، استخدمه كما هو
    return title;
  }
  
  return title;
}

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
    redirect_delay: REDIRECT_DELAY
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
      waylApiStatus: testRes.ok ? "متصل" : "خطأ",
      statusCode: testRes.status,
      response: testData,
      detected_country: country,
      display_settings: settings,
      conversion_rate: USD_TO_IQD_RATE,
    });
  } catch (e) {
    res.status(500).json({ error: "فشل الاتصال بـ WAYL API", details: e.message });
  }
});

// Webhook محسن مع نظام كشف محسن للمنتجات المجانية
app.post("/webhooks/shopify/orders/create", async (req, res) => {
  try {
    console.log("=== استقبال طلب جديد ===");

    if (process.env.NODE_ENV === "production" && !verifyShopifyWebhook(req)) {
      return res.status(401).send("Invalid HMAC");
    }

    const order = req.body;
    const orderId = order.id;
    const orderName = order.name;
    const totalAmount = parseFloat(order.total_price);
    const currency = order.currency;

    console.log(`طلب رقم: ${orderName}, المبلغ الإجمالي: ${totalAmount} ${currency}`);

    const customerCountry = order.shipping_address?.country_code || 
                           order.billing_address?.country_code || 
                           detectCustomerCountry(req);
    const displaySettings = getDisplaySettings(customerCountry);

    const lineItems = [];
    let freeItemsCount = 0;
    
    // معالجة المنتجات مع نظام كشف محسن
    if (order.line_items && order.line_items.length > 0) {
      console.log(`=== معالجة ${order.line_items.length} منتج ===`);
      
      for (const item of order.line_items) {
        console.log(`\n--- معالجة منتج: ${item.title} ---`);
        
        const isItemFree = isReallyFreeProduct(item);
        const correctPrice = getCorrectPrice(item, currency);
        const correctLabel = getCorrectLabel(item);
        const productImage = getImage(item.title);
        
        if (isItemFree) {
          freeItemsCount++;
          console.log(`✅ تم تحديد المنتج كمجاني: ${correctLabel} - ${correctPrice} IQD`);
        } else {
          console.log(`💰 منتج مدفوع: ${correctLabel} - ${correctPrice} IQD`);
        }
        
        lineItems.push({
          label: correctLabel,
          amount: correctPrice,
          type: "increase",
          image: productImage,
        });
      }
    }

    // معالجة الشحن
    if (order.shipping_lines && order.shipping_lines.length > 0) {
      console.log(`=== معالجة ${order.shipping_lines.length} خط شحن ===`);
      
      for (const shipping of order.shipping_lines) {
        const shippingAmount = parseFloat(shipping.price || 0);
        const shippingImage = getImage('shipping');
        
        let shippingLabel = shipping.title || "Shipping";
        if (!shippingLabel.toLowerCase().includes('shipping')) {
          shippingLabel = `Shipping - ${shippingLabel}`;
        }
        
        if (shippingAmount === 0) {
          freeItemsCount++;
          console.log(`🚚 شحن مجاني: ${shippingLabel}`);
          lineItems.push({
            label: shippingLabel.includes('Free') ? shippingLabel : `Free ${shippingLabel}`,
            amount: 1,
            type: "increase",
            image: shippingImage,
          });
        } else {
          console.log(`🚚 شحن مدفوع: ${shippingLabel} - ${shippingAmount} USD`);
          lineItems.push({
            label: shippingLabel,
            amount: convertToIQD(shippingAmount, currency),
            type: "increase",
            image: shippingImage,
          });
        }
      }
    }

    // معالجة الضرائب
    if (order.tax_lines && order.tax_lines.length > 0) {
      for (const tax of order.tax_lines) {
        const taxAmount = parseFloat(tax.price || 0);
        if (taxAmount > 0) {
          lineItems.push({
            label: `Tax - ${tax.title}`,
            amount: convertToIQD(taxAmount, currency),
            type: "increase",
            image: FALLBACK_IMAGE,
          });
        }
      }
    }

    // إذا لا توجد عناصر - احتياط
    if (lineItems.length === 0) {
      const totalInIQD = convertToIQD(totalAmount, currency);
      lineItems.push({
        label: `Order ${orderName}`,
        amount: totalInIQD,
        type: "increase",
        image: FALLBACK_IMAGE,
      });
    }

    const referenceId = `SHOPIFY-${orderId}-${Date.now()}`;
    const orderGID = `gid://shopify/Order/${orderId}`;
    const totalInIQD = lineItems.reduce((sum, item) => sum + item.amount, 0);

    console.log(`=== ملخص الطلب ===`);
    console.log(`المنتجات المجانية: ${freeItemsCount}`);
    console.log(`إجمالي العناصر: ${lineItems.length}`);
    console.log(`المبلغ النهائي: ${totalInIQD} IQD`);

    const waylPayload = {
      referenceId,
      total: totalInIQD,
      currency: "IQD",
      lineItem: lineItems,
      webhookUrl: `${BASE_URL}/webhooks/wayl/payment`,
      webhookSecret: crypto.createHash("sha256").update(`${orderId}-${Date.now()}`).digest("hex"),
      redirectionUrl: order.order_status_url || `https://${SHOPIFY_STORE_DOMAIN}/account`,
    };

    console.log("=== إرسال البيانات إلى WAYL ===");
    console.log("العناصر المرسلة:");
    lineItems.forEach((item, index) => {
      console.log(`${index + 1}. ${item.label} - ${item.amount} IQD`);
    });

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
      console.error("خطأ في WAYL API:", waylResponse);
      throw new Error(`WAYL API Error: ${waylRes.status}`);
    }

    let payUrl = waylResponse.data.url;
    payUrl = buildWaylUrl(payUrl, displaySettings);

    console.log(`✅ تم إنشاء رابط WAYL: ${payUrl}`);

    // حفظ البيانات الأساسية
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
      console.log("✅ تم حفظ البيانات في Shopify");
    } catch (metafieldsError) {
      console.error("خطأ في حفظ metafields:", metafieldsError);
    }

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
          <title>${isArabic ? `دفع - ${orderName}` : `Pay - ${orderName}`}</title>
          <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body { 
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              color: white; min-height: 100vh; display: flex;
              align-items: center; justify-content: center;
              direction: ${isArabic ? 'rtl' : 'ltr'};
            }
            .container {
              background: rgba(255,255,255,0.1); backdrop-filter: blur(10px);
              border-radius: 20px; padding: 30px; text-align: center;
              max-width: 400px; width: 90%;
            }
            .emoji { font-size: 2.5rem; margin-bottom: 15px; }
            h2 { font-size: 1.3rem; margin-bottom: 15px; font-weight: 600; }
            .order-info {
              background: rgba(255,255,255,0.1); padding: 10px;
              border-radius: 8px; margin: 15px 0; font-size: 0.9rem;
            }
            .loader {
              margin: 15px auto; border: 3px solid rgba(255,255,255,0.3);
              border-top: 3px solid #fff; border-radius: 50%;
              width: 40px; height: 40px; animation: spin 0.8s linear infinite;
            }
            .btn {
              background: linear-gradient(45deg,#4CAF50,#45a049); color: white;
              border: none; padding: 12px 25px; border-radius: 8px; cursor: pointer;
              font-size: 14px; font-weight: 600; margin-top: 15px;
              text-decoration: none; display: inline-block;
            }
            @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="emoji">💳</div>
            <h2>${isArabic ? 'جاري التحويل للدفع' : 'Redirecting to Payment'}</h2>
            <div class="order-info">
              <strong>${isArabic ? 'طلب:' : 'Order:'}</strong> ${orderName}<br>
              <strong>${isArabic ? 'المبلغ:' : 'Amount:'}</strong> $${totalAmount}<br>
              <strong>${isArabic ? 'المجانية:' : 'Free Items:'}</strong> ${freeItemsCount}
            </div>
            <div class="loader"></div>
            <a href="${payUrl}" class="btn">${isArabic ? 'ادفع الآن' : 'Pay Now'}</a>
          </div>
          <script>
            setTimeout(function() {
              window.location.href = "${payUrl}";
            }, ${REDIRECT_DELAY});
            document.addEventListener('click', function() {
              window.location.href = "${payUrl}";
            });
          </script>
        </body>
        </html>
      `);
    }

    res.status(200).json({
      success: true,
      message: `تم إنشاء رابط الدفع للطلب ${orderName}`,
      order_id: orderId,
      reference_id: referenceId,
      pay_url: payUrl,
      display_amount: `${totalAmount} ${currency}`,
      payment_amount: `${totalInIQD} IQD`,
      free_items: freeItemsCount,
      total_items: lineItems.length,
      debug_info: "Advanced free product detection enabled"
    });

  } catch (e) {
    console.error("خطأ في معالجة الطلب:", e);
    res.status(500).json({ error: e.message || "خطأ في الخادم" });
  }
});

app.get("/orders/:orderId/pay", async (req, res) => {
  try {
    const { orderId } = req.params;
    const orderGID = `gid://shopify/Order/${orderId}`;

    const data = await shopifyGraphQL(`
      query GetWaylLinks($id: ID!) {
        order(id: $id) {
          payUrl: metafield(namespace: "wayl", key: "pay_url") { value }
        }
      }
    `, { id: orderGID });

    const payUrl = data?.order?.payUrl?.value;
    if (!payUrl) {
      return res.status(404).json({ ok: false, message: "Payment link not found" });
    }

    return res.redirect(payUrl);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/check-payment-link", async (req, res) => {
  try {
    const data = await shopifyGraphQL(`
      query GetRecentPendingOrders {
        orders(first: 1, query: "financial_status:pending", sortKey: CREATED_AT, reverse: true) {
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
      return res.json({ ready: false, message: "No pending orders" });
    }
    
    const payUrl = orders[0].node.payUrl?.value;
    if (payUrl) {
      return res.json({ ready: true, payUrl: payUrl });
    }
    
    return res.json({ ready: false, orderName: orders[0].node.name });
  } catch (error) {
    return res.json({ ready: false, error: error.message });
  }
});

app.get('/pay', async (req, res) => {
    try {
        const data = await shopifyGraphQL(`
            query GetRecentPendingOrders {
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
            return res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>No Orders</title><style>body{font-family:sans-serif;text-align:center;padding:50px;background:#f5f7fa;min-height:100vh;display:flex;align-items:center;justify-content:center}.container{background:white;padding:40px;border-radius:15px;max-width:500px}.btn{background:#4CAF50;color:white;padding:12px 24px;text-decoration:none;border-radius:8px;margin-top:20px;font-weight:600}</style></head><body><div class="container"><h2>No pending orders</h2><p>All orders are paid</p><a href="https://${SHOPIFY_STORE_DOMAIN}" class="btn">Back to Store</a></div></body></html>`);
        }
        
        const latestOrder = orders[0].node;
        const payUrl = latestOrder.payUrl?.value;
        
        // إذا كان payment link موجود، redirect مباشرة
        if (payUrl) return res.redirect(payUrl);
        
        // إذا لم يوجد payment link، اعرض صفحة انتظار ذكية
        return res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Preparing Payment</title><style>body{font-family:sans-serif;text-align:center;padding:50px;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);min-height:100vh;display:flex;align-items:center;justify-content:center;color:white}.container{background:rgba(255,255,255,0.1);backdrop-filter:blur(10px);padding:40px;border-radius:15px;max-width:500px}.loader{margin:20px auto;border:4px solid rgba(255,255,255,0.3);border-top:4px solid #fff;border-radius:50%;width:50px;height:50px;animation:spin 1s linear infinite}.btn{background:white;color:#333;padding:12px 24px;text-decoration:none;border-radius:8px;margin-top:20px;font-weight:600;display:inline-block}@keyframes spin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}</style></head><body><div class="container"><h2>Preparing your payment link...</h2><div class="loader"></div><p>Order ${latestOrder.name} is being processed</p><div id="countdown">Checking in 2 seconds...</div><a href="https://${SHOPIFY_STORE_DOMAIN}" class="btn">Back to Store</a></div><script>let attempt=0;const countdownEl=document.getElementById('countdown');function startCountdown(){let countdown=2;const timer=setInterval(()=>{if(countdown>0){countdownEl.textContent='Checking in '+countdown+' seconds...';countdown--}else{clearInterval(timer);countdownEl.textContent='Checking now...';checkPayment()}},1000);countdownEl.textContent='Checking in '+countdown+' seconds...'}function checkPayment(){attempt++;fetch('/check-payment-link').then(res=>res.json()).then(data=>{if(data.ready&&data.payUrl){window.location.href=data.payUrl}else if(attempt<10){setTimeout(startCountdown,1000)}else{countdownEl.textContent='Taking longer than expected...';setTimeout(()=>window.location.reload(),3000)}}).catch(()=>{if(attempt<10){setTimeout(startCountdown,1000)}})}setTimeout(startCountdown,0)</script></body></html>`);
        
    } catch (error) {
        res.status(500).send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Error</title><style>body{font-family:sans-serif;text-align:center;padding:50px;background:#ff6b6b;min-height:100vh;display:flex;align-items:center;justify-content:center;color:white}.container{background:rgba(255,255,255,0.1);padding:40px;border-radius:15px;max-width:500px}.btn{background:white;color:#333;padding:12px 24px;text-decoration:none;border-radius:8px;margin-top:20px;font-weight:600}</style></head><body><div class="container"><h2>Error</h2><p>Payment processing error</p><a href="https://${SHOPIFY_STORE_DOMAIN}" class="btn">Back to Store</a></div></body></html>`);
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
    const { status, referenceId, id: transactionId } = req.body || {};

    if (!referenceId) return res.status(400).send("Missing referenceId");
    const match = referenceId.match(/SHOPIFY-(\d+)-/);
    if (!match) return res.status(400).send("Invalid referenceId format");

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
        
        console.log(`✅ تم تحديد الطلب ${orderId} كمدفوع`);
      } catch (paymentError) {
        console.error("خطأ في تحديد الدفع:", paymentError);
      }
    }

    res.status(200).json({ success: true });
  } catch (e) {
    console.error("خطأ في webhook الدفع:", e);
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
  console.log(`🤖 ADVANCED FREE DETECTION: Bundle-aware + Known products`);
  console.log(`🎁 Known Free Products: 4 filter sets, cat hair scraper`);
  console.log(`⚡ FAST MODE: 500ms redirect`);
  console.log(`🔍 DEBUG MODE: Detailed logging enabled`);
});