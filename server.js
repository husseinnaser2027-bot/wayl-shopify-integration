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
  REDIRECT_DELAY = "500", // تسريع أكثر - نصف ثانية فقط
} = process.env;

// ==================== CONSTANTS ====================
const USD_TO_IQD_RATE = 1320;

// صور مبسطة للسرعة القصوى
const PRODUCT_IMAGES = {
  'hydrocat': 'https://tryhydrocat.com/cdn/shop/files/9c90033b1a407ed93d5c7854445cc20c.png',
  'water': 'https://tryhydrocat.com/cdn/shop/files/9c90033b1a407ed93d5c7854445cc20c.png',
  'stainless': 'https://tryhydrocat.com/cdn/shop/files/9c90033b1a407ed93d5c7854445cc20c.png',
  'fountain': 'https://tryhydrocat.com/cdn/shop/files/9c90033b1a407ed93d5c7854445cc20c.png',
  '8 filter': 'https://tryhydrocat.com/cdn/shop/files/1_189b0f59-a79b-43ef-91c8-6342012c076a.png',
  '4 filter': 'https://tryhydrocat.com/cdn/shop/files/4x.png',
  'scraper': 'https://tryhydrocat.com/cdn/shop/files/S4e10ad5ee06f4701bfae29ffe478a666S_1_1.webp',
  'shipping': 'https://tryhydrocat.com/cdn/shop/files/free-delivery_d5b4e306-16a1-4d29-85da-859025613537.png',
  'filter': 'https://tryhydrocat.com/cdn/shop/files/4x.png',
  'free': 'https://tryhydrocat.com/cdn/shop/files/S4e10ad5ee06f4701bfae29ffe478a666S_1_1.webp'
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

// دالة فائقة السرعة لاستخراج الصور
function getImage(title) {
  if (!title) return FALLBACK_IMAGE;
  const t = title.toLowerCase();
  
  // بحث سريع بدون حلقات
  if (t.includes('hydrocat')) return PRODUCT_IMAGES['hydrocat'];
  if (t.includes('water') || t.includes('fountain')) return PRODUCT_IMAGES['water'];
  if (t.includes('stainless')) return PRODUCT_IMAGES['stainless'];
  if (t.includes('8 filter')) return PRODUCT_IMAGES['8 filter'];
  if (t.includes('4 filter')) return PRODUCT_IMAGES['4 filter'];
  if (t.includes('scraper')) return PRODUCT_IMAGES['scraper'];
  if (t.includes('shipping')) return PRODUCT_IMAGES['shipping'];
  if (t.includes('filter')) return PRODUCT_IMAGES['filter'];
  if (t.includes('free')) return PRODUCT_IMAGES['free'];
  
  return FALLBACK_IMAGE;
}

// النظام الذكي الجديد للكشف عن المنتجات المجانية - يعمل تلقائياً
function isSmartFree(item) {
  const price = parseFloat(item.price || 0);
  const comparePrice = parseFloat(item.compare_at_price || 0);
  const title = (item.title || '').toLowerCase();
  
  // القاعدة الأولى: أي منتج سعره 0 = مجاني (مهما كان العنوان)
  if (price === 0) {
    return true;
  }
  
  // القاعدة الثانية: إذا كان هناك compare_at_price وسعر المنتج أقل بنسبة 100% = مجاني
  if (comparePrice > 0 && price === 0) {
    return true;
  }
  
  // القاعدة الثالثة: إذا كان العنوان يحتوي على كلمات مجانية مع خصم 100%
  if ((title.includes('free') || title.includes('+ free') || title.includes('+free')) && 
      comparePrice > 0 && price < (comparePrice * 0.1)) {
    return true;
  }
  
  // القاعدة الرابعة: منتجات Shopify التي تظهر كـ "FREE" في العنوان
  if (title.includes('free') && price <= 1) {
    return true;
  }
  
  return false;
}

// دالة ذكية للكشف عن المنتجات المخصومة (تظهر بسعرها المخصوم)
function getSmartPrice(item, currency) {
  const price = parseFloat(item.price || 0);
  const comparePrice = parseFloat(item.compare_at_price || 0);
  
  // إذا كان المنتج مجاني
  if (isSmartFree(item)) {
    return 1; // 1 IQD للمنتجات المجانية
  }
  
  // إذا كان المنتج له سعر عادي
  if (price > 0) {
    const quantity = item.quantity || 1;
    const totalItemUSD = price * quantity;
    return convertToIQD(totalItemUSD, currency);
  }
  
  // احتياط - إذا لم يتطابق مع أي قاعدة
  return convertToIQD(price || 1, currency);
}

// دالة ذكية لتسمية المنتجات المجانية
function getSmartLabel(item) {
  const title = item.title || "Product";
  
  if (isSmartFree(item)) {
    // إذا كان العنوان لا يحتوي على FREE، أضفها
    if (!title.toLowerCase().includes('free')) {
      return `FREE ${title}`;
    }
    // إذا كان يحتوي على FREE، استخدمه كما هو
    return title;
  }
  
  return title;
}

process.on('uncaughtException', (error) => console.error('❌ Uncaught Exception:', error));
process.on('unhandledRejection', (reason) => console.error('❌ Unhandled Rejection:', reason));

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
    real_product_images: Object.keys(PRODUCT_IMAGES).length,
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

// Webhook فائق السرعة مع النظام الذكي الجديد
app.post("/webhooks/shopify/orders/create", async (req, res) => {
  try {
    // تحقق سريع من HMAC في الإنتاج فقط
    if (process.env.NODE_ENV === "production" && !verifyShopifyWebhook(req)) {
      return res.status(401).send("Invalid HMAC");
    }

    const order = req.body;
    const orderId = order.id;
    const orderName = order.name;
    const totalAmount = parseFloat(order.total_price);
    const currency = order.currency;

    // كشف سريع للدولة
    const customerCountry = order.shipping_address?.country_code || 
                           order.billing_address?.country_code || 
                           detectCustomerCountry(req);
    const displaySettings = getDisplaySettings(customerCountry);

    const lineItems = [];
    let freeItemsCount = 0;
    
    // معالجة المنتجات - النظام الذكي الجديد
    if (order.line_items?.length) {
      for (const item of order.line_items) {
        const isFreeItem = isSmartFree(item);
        const smartPrice = getSmartPrice(item, currency);
        const smartLabel = getSmartLabel(item);
        const productImage = getImage(item.title);
        
        if (isFreeItem) {
          freeItemsCount++;
        }
        
        lineItems.push({
          label: smartLabel,
          amount: smartPrice,
          type: "increase",
          image: productImage,
        });
      }
    }

    // معالجة الشحن - سريعة ومحسنة
    if (order.shipping_lines?.length) {
      for (const shipping of order.shipping_lines) {
        const shippingAmountUSD = parseFloat(shipping.price);
        const shippingImage = getImage('shipping');
        
        // إصلاح مشكلة تكرار كلمة shipping
        let shippingLabel = shipping.title || "Shipping";
        if (!shippingLabel.toLowerCase().includes('shipping')) {
          shippingLabel = `Shipping - ${shippingLabel}`;
        }
        
        if (shippingAmountUSD === 0) {
          freeItemsCount++;
          lineItems.push({
            label: shippingLabel.includes('Free') ? shippingLabel : `Free ${shippingLabel}`,
            amount: 1,
            type: "increase",
            image: shippingImage,
          });
        } else {
          lineItems.push({
            label: shippingLabel,
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

    // إذا لا توجد عناصر - احتياط
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

    // إعداد payload لـ WAYL
    const waylPayload = {
      referenceId,
      total: totalInIQD,
      currency: "IQD",
      lineItem: lineItems,
      webhookUrl: `${BASE_URL}/webhooks/wayl/payment`,
      webhookSecret: crypto.createHash("sha256").update(`${orderId}-${Date.now()}`).digest("hex"),
      redirectionUrl: order.order_status_url || `https://${SHOPIFY_STORE_DOMAIN}/account`,
    };

    // استدعاء WAYL - فائق السرعة
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
    payUrl = buildWaylUrl(payUrl, displaySettings);

    // حفظ البيانات الأساسية فقط للسرعة القصوى
    const metafields = [
      { ownerId: orderGID, namespace: "wayl", key: "pay_url", type: "single_line_text_field", value: payUrl },
      { ownerId: orderGID, namespace: "wayl", key: "reference_id", type: "single_line_text_field", value: referenceId },
      { ownerId: orderGID, namespace: "wayl", key: "payment_amount", type: "single_line_text_field", value: `${totalInIQD} IQD` },
    ];

    // عمليات Shopify متوازية للسرعة الفائقة
    await Promise.all([
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
          note: (order.note || "") + `\n\n--- WAYL ---\nURL: ${payUrl}\nRef: ${referenceId}\nAmount: ${totalAmount} ${currency} -> ${totalInIQD} IQD\nFree: ${freeItemsCount}` 
        } 
      })
    ]);

    // التحقق من التوجيه
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
            *{margin:0;padding:0;box-sizing:border-box}
            body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:white;min-height:100vh;display:flex;align-items:center;justify-content:center;direction:${isArabic ? 'rtl' : 'ltr'}}
            .container{background:rgba(255,255,255,0.1);backdrop-filter:blur(10px);border-radius:20px;padding:40px;text-align:center;max-width:450px;width:90%;box-shadow:0 20px 40px rgba(0,0,0,0.1);border:1px solid rgba(255,255,255,0.2)}
            .emoji{font-size:3rem;margin-bottom:20px;animation:bounce 2s infinite}
            h2{font-size:1.5rem;margin-bottom:20px;font-weight:600}
            .order-info{background:rgba(255,255,255,0.1);padding:15px;border-radius:10px;margin:20px 0;border:1px solid rgba(255,255,255,0.2)}
            .loader{margin:20px auto;border:4px solid rgba(255,255,255,0.3);border-top:4px solid #fff;border-radius:50%;width:50px;height:50px;animation:spin 1s linear infinite}
            .countdown{font-size:2rem;font-weight:bold;color:#FFD700;margin:10px 0}
            .btn{background:linear-gradient(45deg,#4CAF50,#45a049);color:white;border:none;padding:15px 30px;border-radius:10px;cursor:pointer;font-size:16px;font-weight:600;margin-top:20px;text-decoration:none;display:inline-block;transition:all 0.3s ease}
            @keyframes spin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}
            @keyframes bounce{0%,20%,50%,80%,100%{transform:translateY(0)}40%{transform:translateY(-10px)}60%{transform:translateY(-5px)}}
          </style>
        </head>
        <body>
          <div class="container">
            <div class="emoji">💳</div>
            <h2>${isArabic ? 'جاري التحويل للدفع' : 'Redirecting to Payment'}</h2>
            <div class="order-info">
              <strong>${isArabic ? 'طلب:' : 'Order:'}</strong> ${orderName}<br>
              <strong>${isArabic ? 'المبلغ:' : 'Amount:'}</strong> $${totalAmount}
            </div>
            <div class="loader"></div>
            <p>${isArabic ? 'التحويل خلال:' : 'Redirecting in:'} <span class="countdown" id="countdown">1</span></p>
            <a href="${payUrl}" class="btn" onclick="redirectNow()">${isArabic ? 'ادفع الآن' : 'Pay Now'}</a>
          </div>
          <script>
            const paymentUrl="${payUrl}";
            function redirectNow(){window.location.href=paymentUrl}
            setTimeout(redirectNow,${REDIRECT_DELAY});
            document.addEventListener('click',redirectNow);
            document.addEventListener('keydown',function(e){if(e.key==='Enter'||e.key===' ')redirectNow()});
            let timeLeft=1;
            const countdownElement=document.getElementById('countdown');
            function updateCountdown(){
              if(timeLeft<=0){redirectNow();return}
              countdownElement.textContent=timeLeft;
              timeLeft--;setTimeout(updateCountdown,500)
            }
            updateCountdown();
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
      display_amount: `${totalAmount} ${currency}`,
      payment_amount: `${totalInIQD} IQD`,
      display_settings: displaySettings,
      customer_country: customerCountry,
      free_items: freeItemsCount,
      total_items: lineItems.length,
      smart_detection: "enabled"
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

app.get('/redirect-to-payment/:orderId', async (req, res) => {
  try {
    const orderId = req.params.orderId;
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
    res.status(404).send('Payment link not found');
  } catch (e) {
    res.status(500).send('Error: ' + e.message);
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
            return res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>No Orders</title><style>body{font-family:sans-serif;text-align:center;padding:50px;background:#f5f7fa;min-height:100vh;display:flex;align-items:center;justify-content:center}.container{background:white;padding:40px;border-radius:15px;max-width:500px}.btn{background:#4CAF50;color:white;padding:12px 24px;text-decoration:none;border-radius:8px;margin-top:20px;font-weight:600}.emoji{font-size:3rem;margin-bottom:20px}</style></head><body><div class="container"><div class="emoji">❌</div><h2>No pending orders</h2><p>All orders are paid</p><a href="https://${SHOPIFY_STORE_DOMAIN}" class="btn">Back to Store</a></div></body></html>`);
        }
        
        const latestOrder = orders[0].node;
        const payUrl = latestOrder.payUrl?.value;
        
        if (payUrl) return res.redirect(payUrl);
        
        return res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Payment Link Not Found</title><style>body{font-family:sans-serif;text-align:center;padding:50px;background:#ff6b6b;min-height:100vh;display:flex;align-items:center;justify-content:center;color:white}.container{background:rgba(255,255,255,0.1);padding:40px;border-radius:15px;max-width:500px}.btn{background:white;color:#333;padding:12px 24px;text-decoration:none;border-radius:8px;margin-top:20px;font-weight:600}.emoji{font-size:3rem;margin-bottom:20px}</style></head><body><div class="container"><div class="emoji">⚠️</div><h2>Payment link not available</h2><p>Order ${latestOrder.name} found but payment link not created yet.</p><a href="https://${SHOPIFY_STORE_DOMAIN}" class="btn">Back to Store</a></div></body></html>`);
        
    } catch (error) {
        res.status(500).send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Error</title><style>body{font-family:sans-serif;text-align:center;padding:50px;background:#ff6b6b;min-height:100vh;display:flex;align-items:center;justify-content:center;color:white}.container{background:rgba(255,255,255,0.1);padding:40px;border-radius:15px;max-width:500px}.btn{background:white;color:#333;padding:12px 24px;text-decoration:none;border-radius:8px;margin-top:20px;font-weight:600}.emoji{font-size:3rem;margin-bottom:20px}</style></head><body><div class="container"><div class="emoji">❌</div><h2>Error</h2><p>Payment processing error</p><a href="https://${SHOPIFY_STORE_DOMAIN}" class="btn">Back to Store</a></div></body></html>`);
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
        shopifyGraphQL(`mutation orderMarkAsPaid($input: OrderMarkAsPaidInput!) { orderMarkAsPaid(input: $input) { order { id } userErrors { field message } } }`, { input: { id: orderGID } }),
        shopifyGraphQL(`mutation SetPaymentMetafields($metafields: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $metafields) { metafields { key value } userErrors { field message } } }`, { metafields: [{ ownerId: orderGID, namespace: "wayl", key: "payment_status", type: "single_line_text_field", value: "completed" }, { ownerId: orderGID, namespace: "wayl", key: "transaction_id", type: "single_line_text_field", value: transactionId || "" }] }),
        shopifyGraphQL(`mutation tagsAdd($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { node { id } userErrors { field message } } }`, { id: orderGID, tags: ["WAYL-PAID", transactionId ? `WAYL-TX-${transactionId}` : "WAYL-TX-UNKNOWN"] })
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
  console.log(`⏱️ REDIRECT_DELAY: ${REDIRECT_DELAY}ms (ULTRA FAST)`);
  console.log(`💰 Payment Route: ${BASE_URL}/pay`);
  console.log(`🎯 Smart Payment Route: ${BASE_URL}/payment?order_id=ORDER_ID`);
  console.log(`🌍 Arabic Countries: 22 supported`);
  console.log(`🗣️ Languages: Arabic (ar) + English (en)`);
  console.log(`💵 Display Currency: USD for all countries`);
  console.log(`💰 Payment Currency: IQD (Iraqi Dinar)`);
  console.log(`🖼️ Real Store Images: ${Object.keys(PRODUCT_IMAGES).length} products`);
  console.log(`🤖 SMART FREE DETECTION: Automatic detection of free/discounted items from Shopify cart`);
  console.log(`⚡ ULTRA FAST MODE: Optimized for maximum speed - no customer loss`);
  console.log(`✅ ZERO CONFIGURATION: Works automatically without manual code changes`);
});