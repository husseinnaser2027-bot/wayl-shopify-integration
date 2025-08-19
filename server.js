import express from "express";
import crypto from "crypto";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();

// إعداد Express للتعامل مع JSON وللاحتفاظ بالـ rawBody للتحقق من HMAC
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
  REDIRECT_DELAY = "3000",
} = process.env;

// ==================== CONSTANTS ====================
const USD_TO_IQD_RATE = 1320;

// ==================== HELPERS ====================

// فحص صحة Webhook من Shopify
function verifyShopifyWebhook(req) {
  try {
    if (!SHOPIFY_WEBHOOK_SECRET) return false;
    const hmacHeader = req.get("X-Shopify-Hmac-Sha256") || "";
    const digest = crypto
      .createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
      .update(req.rawBody || Buffer.from(JSON.stringify(req.body)), "utf8")
      .digest("base64");

    if (Buffer.byteLength(hmacHeader) !== Buffer.byteLength(digest)) return false;
    return crypto.timingSafeEqual(Buffer.from(hmacHeader), Buffer.from(digest));
  } catch (e) {
    console.error("HMAC verify error:", e);
    return false;
  }
}

// كشف البلد من IP العميل (بدائي للتجارب)
function detectCustomerCountry(req) {
  const forwardedFor = req.headers["x-forwarded-for"];
  const ip = forwardedFor ? forwardedFor.split(",")[0] : req.connection?.remoteAddress;

  // للتاست اليدوي
  const testCountry = req.headers["x-test-country"];
  if (testCountry) return testCountry;

  // بيئة محلية
  if (ip === "127.0.0.1" || ip === "::1" || (ip && ip.startsWith("192.168."))) {
    return "US";
  }
  // افتراضي
  return "IQ";
}

// إعدادات العرض حسب البلد - محدث لجميع الدول العربية
function getDisplaySettings(country) {
  // قائمة الدول العربية الـ 22
  const arabicCountries = [
    'IQ', // العراق
    'SA', // السعودية
    'AE', // الإمارات
    'KW', // الكويت
    'QA', // قطر
    'BH', // البحرين
    'OM', // عُمان
    'YE', // اليمن
    'SY', // سوريا
    'LB', // لبنان
    'JO', // الأردن
    'PS', // فلسطين
    'EG', // مصر
    'LY', // ليبيا
    'TN', // تونس
    'DZ', // الجزائر
    'MA', // المغرب
    'MR', // موريتانيا
    'SD', // السودان
    'SS', // جنوب السودان
    'SO', // الصومال
    'DJ', // جيبوتي
    'KM'  // جزر القمر
  ];

  // إعدادات للدول العربية: عربي + دولار للعرض
  if (arabicCountries.includes(country)) {
    return {
      language: "ar",
      currency: "usd",
      displayCurrency: "USD"
    };
  }

  // إعدادات لباقي الدول: إنجليزي + دولار للعرض
  return {
    language: "en",
    currency: "usd",
    displayCurrency: "USD"
  };
}

// تحويل المبلغ إلى دينار عراقي للدفع
function convertToIQD(amount, fromCurrency = "USD") {
  if (fromCurrency === "IQD") return Math.round(amount);
  const rates = {
    USD: USD_TO_IQD_RATE,
    EUR: USD_TO_IQD_RATE * 1.1,
    GBP: USD_TO_IQD_RATE * 1.25,
  };
  const converted = Math.round(amount * (rates[fromCurrency] || USD_TO_IQD_RATE));
  return Math.max(converted, 1000);
}

// استدعاء Shopify GraphQL
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
  if (!res.ok || data.errors) {
    console.error("Shopify GraphQL error:", data);
    throw new Error(JSON.stringify(data));
  }
  return data.data;
}

// يبني رابط WAYL بإضافة lang/currency - محدث لإصلاح رموز URL
function buildWaylUrl(baseUrl, { language, currency }) {
  if (!baseUrl) return null;
  
  try {
    const u = new URL(baseUrl);
    
    // إضافة المعاملات إذا لم تكن موجودة
    if (!u.searchParams.get("lang")) {
      u.searchParams.set("lang", language);
    }
    if (!u.searchParams.get("currency")) {
      u.searchParams.set("currency", currency);
    }
    
    // التأكد من أن الرابط صحيح
    const finalUrl = u.toString();
    console.log(`🔗 بناء رابط WAYL: ${baseUrl} → ${finalUrl}`);
    
    return finalUrl;
  } catch (error) {
    console.error("خطأ في بناء رابط WAYL:", error);
    // في حالة الخطأ، أضف المعاملات بطريقة بسيطة
    const separator = baseUrl.includes('?') ? '&' : '?';
    return `${baseUrl}${separator}lang=${language}&currency=${currency}`;
  }
}

// 🆕 دالة بسيطة لتوليد صور جميلة حسب اسم المنتج
function generateProductImage(productTitle, price = 0) {
  const title = (productTitle || 'Product').toLowerCase();
  
  // صور مخصصة حسب نوع المنتج
  const productImages = {
    // منتجات المياه والنوافير
    water: 'https://images.unsplash.com/photo-1550583724-b2692b85b150?w=150&h=150&fit=crop&crop=center',
    fountain: 'https://images.unsplash.com/photo-1544551763-46a013bb70d5?w=150&h=150&fit=crop&crop=center',
    hydro: 'https://images.unsplash.com/photo-1544551763-46a013bb70d5?w=150&h=150&fit=crop&crop=center',
    
    // منتجات القطط والحيوانات الأليفة
    cat: 'https://images.unsplash.com/photo-1514888286974-6c03e2ca1dba?w=150&h=150&fit=crop&crop=center',
    pet: 'https://images.unsplash.com/photo-1601758228041-f3b2795255f1?w=150&h=150&fit=crop&crop=center',
    
    // الفلاتر والتنظيف
    filter: 'https://images.unsplash.com/photo-1563453392212-326f5e854473?w=150&h=150&fit=crop&crop=center',
    clean: 'https://images.unsplash.com/photo-1563453392212-326f5e854473?w=150&h=150&fit=crop&crop=center',
    
    // منتجات الستانلس ستيل
    steel: 'https://images.unsplash.com/photo-1571019613454-1cb2f99b2d8b?w=150&h=150&fit=crop&crop=center',
    stainless: 'https://images.unsplash.com/photo-1571019613454-1cb2f99b2d8b?w=150&h=150&fit=crop&crop=center',
    
    // منتجات عامة
    scraper: 'https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=150&h=150&fit=crop&crop=center',
    tool: 'https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=150&h=150&fit=crop&crop=center'
  };
  
  // البحث عن كلمة مفتاحية في اسم المنتج
  for (const [keyword, imageUrl] of Object.entries(productImages)) {
    if (title.includes(keyword)) {
      console.log(`✅ تم العثور على صورة مناسبة للمنتج "${productTitle}" - نوع: ${keyword}`);
      return imageUrl;
    }
  }
  
  // إذا لم نجد كلمة مفتاحية، استخدم صورة ملونة حسب السعر
  const colors = ['4CAF50', '2196F3', 'FF9800', '9C27B0', 'F44336', '795548', '607D8B'];
  const colorIndex = Math.floor((price * 10) % colors.length);
  const productName = encodeURIComponent(productTitle.slice(0, 15));
  
  console.log(`💡 استخدام صورة ملونة للمنتج "${productTitle}" - لون: ${colors[colorIndex]}`);
  return `https://via.placeholder.com/150/${colors[colorIndex]}/ffffff?text=${productName}`;
}

// 🆕 دالة محسنة لاستخراج صور المنتجات (بسيطة وسريعة)
function extractProductImageEnhanced(item) {
  console.log(`🖼️ معالجة صورة المنتج: ${item.title || 'منتج غير معرف'}`);
  
  // أولاً: محاولة استخراج الصورة من بيانات الـ webhook
  const webhookSources = [
    item.variant_image_url,
    item.image_url,
    item.featured_image,
    item.variant?.image_url,
    item.variant?.featured_image,
    item.product?.featured_image,
    item.product?.images?.[0]?.src,
    item.product?.images?.[0]?.url,
    item.product?.images?.[0]?.original_src
  ];
  
  for (const source of webhookSources) {
    if (source && typeof source === 'string' && source.includes('http')) {
      console.log(`✅ تم العثور على صورة من webhook: ${source}`);
      return source;
    }
  }
  
  // ثانياً: توليد صورة جميلة حسب اسم ونوع المنتج
  const price = parseFloat(item.price) || 0;
  return generateProductImage(item.title, price);
}

// ==================== ROUTES ====================

// صفحة رئيسية بسيطة
app.get("/", (_req, res) => {
  res.type("text/plain").send("WAYL-Shopify Integration is running. Try /health");
});

// صفحة اختبار الصحة
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
  });
});

// اختبار الاتصال بـ WAYL
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

// استقبال Webhook من Shopify عند إنشاء الطلب
app.post("/webhooks/shopify/orders/create", async (req, res) => {
  try {
    console.log("📦 تم استقبال طلب جديد من Shopify");

    // التحقق من صحة الـ webhook في الإنتاج فقط
    if (process.env.NODE_ENV === "production") {
      if (!verifyShopifyWebhook(req)) {
        console.error("❌ HMAC غير صحيح");
        return res.status(401).send("Invalid HMAC");
      }
    }

    const order = req.body;
    const orderId = order.id;
    const orderName = order.name;
    const totalAmount = parseFloat(order.total_price);
    const currency = order.currency;

    console.log(`طلب رقم: ${orderName}`);
    console.log(`💰 المبلغ الأصلي: ${totalAmount} ${currency}`);

    // تحديد إعدادات العرض حسب دولة العميل (من IP أو بيانات الطلب)
    const customerCountry = order.shipping_address?.country_code || 
                           order.billing_address?.country_code || 
                           detectCustomerCountry(req);
    const displaySettings = getDisplaySettings(customerCountry);
    console.log(`🌍 الدولة المكتشفة: ${customerCountry} | إعدادات العرض: ${displaySettings.language}, ${displaySettings.currency}`);

    // بناء line items مع استخراج محسن للصور
    const lineItems = [];
    if (order.line_items?.length) {
      console.log(`🛍️ معالجة ${order.line_items.length} عنصر في الطلب...`);
      
      order.line_items.forEach((item, index) => {
        const itemPriceUSD = parseFloat(item.price);
        const itemQuantity = item.quantity;
        const totalItemUSD = itemPriceUSD * itemQuantity;
        const amountInIQD = convertToIQD(totalItemUSD, currency);

        // 🆕 استخدام الدالة المحسنة البسيطة للصور
        const productImage = extractProductImageEnhanced(item);
        
        console.log(`📦 العنصر ${index + 1}: ${item.title} - $${totalItemUSD} - صورة: ${productImage && !productImage.includes('placeholder') ? '✅' : '🎨'}`);

        lineItems.push({
          label: item.title || "Product",
          amount: amountInIQD,
          type: "increase",
          image: productImage,
        });
      });
    }

    // الشحن
    if (order.shipping_lines?.length) {
      console.log(`🚚 معالجة ${order.shipping_lines.length} خط شحن...`);
      
      order.shipping_lines.forEach((shipping) => {
        const shippingAmountUSD = parseFloat(shipping.price);
        if (shippingAmountUSD > 0) {
          lineItems.push({
            label: `Shipping - ${shipping.title}`,
            amount: convertToIQD(shippingAmountUSD, currency),
            type: "increase",
            image: "https://images.unsplash.com/photo-1566576912321-d58ddd7a6088?w=150&h=150&fit=crop&crop=center",
          });
        }
      });
    }

    // الضرائب
    if (order.tax_lines?.length) {
      console.log(`💰 معالجة ${order.tax_lines.length} خط ضرائب...`);
      
      order.tax_lines.forEach((tax) => {
        const taxAmountUSD = parseFloat(tax.price);
        if (taxAmountUSD > 0) {
          lineItems.push({
            label: `Tax - ${tax.title}`,
            amount: convertToIQD(taxAmountUSD, currency),
            type: "increase",
            image: "https://images.unsplash.com/photo-1554224155-6726b3ff858f?w=150&h=150&fit=crop&crop=center",
          });
        }
      });
    }

    // إذا ماكو عناصر، خلي عنصر واحد بالمجموع
    if (lineItems.length === 0) {
      console.log(`⚠️ لا توجد عناصر منفصلة - إنشاء عنصر واحد للطلب الكامل`);
      
      const totalInIQDOnly = convertToIQD(totalAmount, currency);
      lineItems.push({
        label: `Order ${orderName}`,
        amount: totalInIQDOnly,
        type: "increase",
        image: "https://images.unsplash.com/photo-1556742049-0cfed4f6a45d?w=150&h=150&fit=crop&crop=center",
      });
    }

    const referenceId = `SHOPIFY-${orderId}-${Date.now()}`;
    const orderGID = `gid://shopify/Order/${orderId}`;
    const totalInIQD = lineItems.reduce((sum, i) => sum + i.amount, 0);

    console.log(`🔗 إنشاء رابط WAYL للطلب ${orderName}...`);
    console.log(`💰 للعرض: ${totalAmount} ${currency}`);
    console.log(`💰 للدفع: ${totalInIQD} IQD`);
    console.log(`🖼️ عدد العناصر مع صور مخصصة: ${lineItems.filter(item => item.image && !item.image.includes('placeholder')).length}/${lineItems.length}`);

    const waylPayload = {
      referenceId,
      total: totalInIQD,
      currency: "IQD",
      lineItem: lineItems,
      webhookUrl: `${BASE_URL}/webhooks/wayl/payment`,
      webhookSecret: crypto.createHash("sha256").update(`${orderId}-${Date.now()}`).digest("hex"),
      redirectionUrl: order.order_status_url || `https://${SHOPIFY_STORE_DOMAIN}/account`,
    };

    console.log("📤 إرسال البيانات إلى WAYL:");
    console.log("📋 المنتجات:", lineItems.map(item => `${item.label} - ${item.image && !item.image.includes('placeholder') ? 'CUSTOM_IMAGE' : 'PLACEHOLDER'}`));

    try {
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
        console.error("❌ خطأ في إنشاء رابط WAYL:", waylResponse);
        throw new Error(`فشل إنشاء رابط WAYL: ${JSON.stringify(waylResponse)}`);
      }

      let payUrl = waylResponse.data.url; // base
      const waylLinkId = waylResponse.data.id;

      // أضف lang/currency للعرض حسب دولة العميل
      payUrl = buildWaylUrl(payUrl, displaySettings);
      console.log(`✅ تم إنشاء رابط WAYL: ${payUrl}`);

      // حفظ الـ Metafields
      const metafieldsMutation = `
        mutation SetPaymentMetafields($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            metafields { key value }
            userErrors { field message }
          }
        }
      `;

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

      await shopifyGraphQL(metafieldsMutation, { metafields });

      // تحديث ملاحظة الطلب
      const noteUpdateMutation = `
        mutation orderUpdate($input: OrderInput!) {
          orderUpdate(input: $input) {
            order { id note }
            userErrors { field message }
          }
        }
      `;
      const currentNote = order.note || "";
      const waylNote =
        `\n\n--- WAYL Payment Link ---\n` +
        `🔗 Pay URL: ${payUrl}\n` +
        `📋 Reference: ${referenceId}\n` +
        `💰 Display: ${totalAmount} ${currency}\n` +
        `💰 Payment: ${totalInIQD} IQD\n` +
        `🌍 Country: ${customerCountry}\n` +
        `🗣️ Language: ${displaySettings.language}\n` +
        `💱 Currency Display: ${displaySettings.currency}\n` +
        `🖼️ Custom Images: ${lineItems.filter(item => item.image && !item.image.includes('placeholder')).length}/${lineItems.length}\n` +
        `📊 Status: Pending Payment`;

      await shopifyGraphQL(noteUpdateMutation, { input: { id: orderGID, note: currentNote + waylNote } });

      console.log(`✅ تم حفظ بيانات الدفع في Shopify للطلب ${orderName}`);

      // ✅ التحقق من header للتوجيه التلقائي أو إذا كان AUTO_REDIRECT مفعل
      const shouldRedirect = req.headers['x-shopify-topic'] || 
                           req.query.redirect === 'true' || 
                           AUTO_REDIRECT === 'true';

      if (shouldRedirect) {
        console.log(`🔄 إرسال صفحة توجيه HTML للطلب ${orderName}`);
        
        // تحديد النص حسب اللغة
        const isArabic = displaySettings.language === 'ar';
        const redirectText = {
          title: isArabic ? `تحويل للدفع - ${orderName}` : `Redirecting to Payment - ${orderName}`,
          heading: isArabic ? 'جاري تحويلك لإكمال الدفع' : 'Redirecting you to complete payment',
          orderLabel: isArabic ? 'طلب رقم:' : 'Order:',
          amountLabel: isArabic ? 'المبلغ:' : 'Amount:',
          countdownText: isArabic ? 'سيتم التحويل خلال:' : 'Redirecting in:',
          secondText: isArabic ? 'ثانية' : 'seconds',
          buttonText: isArabic ? '🚀 اذهب للدفع الآن' : '🚀 Go to Payment Now',
          noteText: isArabic ? '💡 إذا لم يتم التحويل تلقائياً، اضغط الزر أعلاه' : '💡 If redirect fails, click the button above'
        };
        
        // إرجاع HTML مع توجيه فوري
        return res.status(200).send(`
          <!DOCTYPE html>
          <html lang="${displaySettings.language}" dir="${isArabic ? 'rtl' : 'ltr'}">
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>${redirectText.title}</title>
            <style>
              * {
                margin: 0;
                padding: 0;
                box-sizing: border-box;
              }
              body { 
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Cairo', sans-serif;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                color: white;
                min-height: 100vh;
                display: flex;
                align-items: center;
                justify-content: center;
                direction: ${isArabic ? 'rtl' : 'ltr'};
              }
              .container {
                background: rgba(255, 255, 255, 0.1);
                backdrop-filter: blur(10px);
                border-radius: 20px;
                padding: 40px;
                text-align: center;
                max-width: 450px;
                width: 90%;
                box-shadow: 0 20px 40px rgba(0,0,0,0.1);
                border: 1px solid rgba(255,255,255,0.2);
              }
              .emoji {
                font-size: 3rem;
                margin-bottom: 20px;
                animation: bounce 2s infinite;
              }
              h2 {
                font-size: 1.5rem;
                margin-bottom: 20px;
                font-weight: 600;
              }
              .order-info {
                background: rgba(255,255,255,0.1);
                padding: 15px;
                border-radius: 10px;
                margin: 20px 0;
                border: 1px solid rgba(255,255,255,0.2);
              }
              .loader { 
                margin: 20px auto; 
                border: 4px solid rgba(255,255,255,0.3); 
                border-top: 4px solid #fff; 
                border-radius: 50%; 
                width: 50px; 
                height: 50px; 
                animation: spin 1s linear infinite; 
              }
              .countdown {
                font-size: 2rem;
                font-weight: bold;
                color: #FFD700;
                margin: 10px 0;
              }
              .btn {
                background: linear-gradient(45deg, #4CAF50, #45a049);
                color: white;
                border: none;
                padding: 15px 30px;
                border-radius: 10px;
                cursor: pointer;
                font-size: 16px;
                font-weight: 600;
                margin-top: 20px;
                text-decoration: none;
                display: inline-block;
                transition: all 0.3s ease;
                box-shadow: 0 4px 15px rgba(76, 175, 80, 0.3);
              }
              .btn:hover {
                transform: translateY(-2px);
                box-shadow: 0 6px 20px rgba(76, 175, 80, 0.4);
              }
              @keyframes spin { 
                0% { transform: rotate(0deg); } 
                100% { transform: rotate(360deg); } 
              }
              @keyframes bounce {
                0%, 20%, 50%, 80%, 100% { transform: translateY(0); }
                40% { transform: translateY(-10px); }
                60% { transform: translateY(-5px); }
              }
              .progress-bar {
                width: 100%;
                height: 4px;
                background: rgba(255,255,255,0.3);
                border-radius: 2px;
                margin: 20px 0;
                overflow: hidden;
              }
              .progress-fill {
                height: 100%;
                background: linear-gradient(90deg, #4CAF50, #FFD700);
                border-radius: 2px;
                width: 0%;
                animation: progress ${REDIRECT_DELAY}ms linear forwards;
              }
              @keyframes progress {
                from { width: 0%; }
                to { width: 100%; }
              }
            </style>
          </head>
          <body>
            <div class="container">
              <div class="emoji">💳</div>
              <h2>${redirectText.heading}</h2>
              
              <div class="order-info">
                <strong>📋 ${redirectText.orderLabel}</strong> ${orderName}<br>
                <strong>💰 ${redirectText.amountLabel}</strong> $${totalAmount}
              </div>
              
              <div class="loader"></div>
              
              <div class="progress-bar">
                <div class="progress-fill"></div>
              </div>
              
              <p>${redirectText.countdownText} <span class="countdown" id="countdown">3</span> ${redirectText.secondText}</p>
              
              <a href="${payUrl}" class="btn" onclick="redirectNow()">
                ${redirectText.buttonText}
              </a>
              
              <p style="font-size: 0.9rem; margin-top: 20px; opacity: 0.8;">
                ${redirectText.noteText}
              </p>
            </div>
            
            <script>
              let timeLeft = 3;
              const countdownElement = document.getElementById('countdown');
              const paymentUrl = "${payUrl}";
              
              function updateCountdown() {
                countdownElement.textContent = timeLeft;
                if (timeLeft <= 0) {
                  redirectNow();
                  return;
                }
                timeLeft--;
                setTimeout(updateCountdown, 1000);
              }
              
              function redirectNow() {
                window.location.href = paymentUrl;
              }
              
              // بدء العد التنازلي
              updateCountdown();
              
              // توجيه فوري بعد المدة المحددة
              setTimeout(redirectNow, ${REDIRECT_DELAY});
              
              // توجيه عند الضغط على أي مكان في الصفحة
              document.addEventListener('click', function(e) {
                if (e.target.tagName !== 'A') {
                  redirectNow();
                }
              });
              
              // توجيه عند الضغط على مفتاح Enter أو Space
              document.addEventListener('keydown', function(e) {
                if (e.key === 'Enter' || e.key === ' ') {
                  redirectNow();
                }
              });
            </script>
          </body>
          </html>
        `);
      }

      // إرجاع JSON عادي إذا لم يكن هناك حاجة للتوجيه
      res.status(200).json({
        success: true,
        message: `تم إنشاء رابط الدفع للطلب ${orderName}`,
        order_id: orderId,
        reference_id: referenceId,
        pay_url: payUrl,
        pay_url_base: waylResponse.data.url,
        display_amount: `${totalAmount} ${currency}`,
        payment_amount: `${totalInIQD} IQD`,
        display_settings: displaySettings,
        customer_country: customerCountry,
        conversion_rate: USD_TO_IQD_RATE,
        custom_images_found: lineItems.filter(item => item.image && !item.image.includes('placeholder')).length,
        total_items: lineItems.length,
      });
    } catch (waylError) {
      console.error("❌ خطأ في WAYL API:", waylError);
      res.status(200).json({
        success: false,
        message: `تم استقبال الطلب ${orderName} لكن فشل إنشاء رابط الدفع`,
        error: waylError.message,
        order_id: orderId,
      });
    }
  } catch (e) {
    console.error("❌ خطأ في معالجة الطلب:", e);
    res.status(500).json({ error: e.message });
  }
});

// إنشاء رابط دفع مخصص بالـ reference
app.get("/pay/:referenceId", (req, res) => {
  try {
    const { referenceId } = req.params;
    const country = req.query.country || detectCustomerCountry(req);
    const settings = getDisplaySettings(country);

    const baseUrl = req.query.base_url || `https://link.thewayl.com/pay?id=${referenceId}`;
    const finalUrl = buildWaylUrl(baseUrl, settings);

    console.log(`🔗 توجيه دفع مخصص: ${referenceId} → ${finalUrl}`);
    return res.redirect(finalUrl);
  } catch (e) {
    console.error("Error creating custom payment link:", e);
    res.status(500).send("Error creating payment link");
  }
});

// ✅ المسار الجديد: تحويل للـ WAYL باستخدام رقم الطلب في Shopify
app.get("/orders/:orderId/pay", async (req, res) => {
  try {
    const { orderId } = req.params;
    const country = req.query.country || detectCustomerCountry(req);
    const settings = getDisplaySettings(country);

    const orderGID = `gid://shopify/Order/${orderId}`;

    const query = `
      query GetWaylLinks($id: ID!) {
        order(id: $id) {
          id
          name
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
      return res.status(404).json({ ok: false, message: "لم يتم العثور على رابط WAYL لهذا الطلب." });
    }

    // استخدم الدولة المحفوظة أولاً، ثم المكتشفة
    const effectiveCountry = order?.savedCountry?.value || country;
    let effSettings = getDisplaySettings(effectiveCountry);
    
    // إذا موجود display_settings محفوظ، استخدمه
    if (order?.display?.value) {
      try {
        const saved = JSON.parse(order.display.value);
        effSettings = { 
          language: saved.language || effSettings.language, 
          currency: saved.currency || effSettings.currency 
        };
      } catch (_) {
        console.warn("فشل في قراءة إعدادات العرض المحفوظة");
      }
    }

    const finalUrl = buildWaylUrl(base, effSettings);
    console.log(`🔗 تحويل الطلب ${order?.name || orderId} إلى WAYL: ${finalUrl}`);
    console.log(`🌍 الدولة الفعالة: ${effectiveCountry} | الإعدادات: ${JSON.stringify(effSettings)}`);
    
    return res.redirect(finalUrl);
  } catch (e) {
    console.error("Error redirecting order to WAYL:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// حل بديل للتوجيه المباشر
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
    
    if (payUrl) {
      console.log(`🚀 توجيه مباشر للطلب ${data.order.name}: ${payUrl}`);
      return res.redirect(payUrl);
    }
    
    res.status(404).send('Payment link not found');
  } catch (e) {
    console.error("Error in redirect-to-payment:", e);
    res.status(500).send('Error: ' + e.message);
  }
});

// 🚀 ROUTE الجديد: الدفع العام - محدث لعدم إنشاء طلبات وهمية
app.get('/pay', async (req, res) => {
    try {
        console.log('🔍 طلب دفع عام - البحث عن آخر طلب معلق...');
        
        // البحث عن آخر 5 طلبات معلقة - بدون customer field لتجنب خطأ الصلاحيات
        const query = `
            query GetRecentPendingOrders {
                orders(first: 5, query: "financial_status:pending", sortKey: CREATED_AT, reverse: true) {
                    edges {
                        node {
                            id
                            name
                            totalPriceSet { shopMoney { amount currencyCode } }
                            createdAt
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
                <html>
                <head>
                    <meta charset="UTF-8">
                    <title>No Pending Orders</title>
                    <style>
                        body { 
                            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; 
                            text-align: center; padding: 50px;
                            background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%);
                            min-height: 100vh; display: flex; align-items: center; justify-content: center;
                        }
                        .container { 
                            background: white; padding: 40px; border-radius: 15px; 
                            box-shadow: 0 10px 30px rgba(0,0,0,0.1); max-width: 500px;
                        }
                        .btn { 
                            background: #4CAF50; color: white; padding: 12px 24px; 
                            text-decoration: none; border-radius: 8px; 
                            display: inline-block; margin-top: 20px; font-weight: 600;
                        }
                        .emoji { font-size: 3rem; margin-bottom: 20px; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <div class="emoji">❌</div>
                        <h2>لا توجد طلبات معلقة للدفع</h2>
                        <p>جميع طلباتك مكتملة الدفع أو لا توجد طلبات حديثة تحتاج دفع</p>
                        <a href="https://${SHOPIFY_STORE_DOMAIN}" class="btn">العودة للمتجر</a>
                    </div>
                </body>
                </html>
            `);
        }
        
        // استخدام آخر طلب والتوجيه المباشر لرابط WAYL الموجود
        const latestOrder = orders[0].node;
        const orderId = latestOrder.id.split('/').pop();
        
        console.log(`✅ تم العثور على طلب معلق: ${latestOrder.name} (ID: ${orderId})`);
        
        // تحديد الدولة والإعدادات
        const detectedCountry = detectCustomerCountry(req);
        const savedCountry = latestOrder.savedCountry?.value;
        const effectiveCountry = savedCountry || detectedCountry;
        let settings = getDisplaySettings(effectiveCountry);
        
        // استخدام الإعدادات المحفوظة إذا وُجدت
        if (latestOrder.display?.value) {
            try {
                const savedSettings = JSON.parse(latestOrder.display.value);
                settings = {
                    language: savedSettings.language || settings.language,
                    currency: savedSettings.currency || settings.currency
                };
            } catch (_) {
                console.warn("فشل في قراءة الإعدادات المحفوظة، استخدام الافتراضية");
            }
        }
        
        console.log(`🌍 الدولة الفعالة: ${effectiveCountry} | الإعدادات: ${JSON.stringify(settings)}`);
        
        // إذا كان هناك رابط دفع محفوظ، استخدمه مع الإعدادات الصحيحة
        if (latestOrder.payUrl?.value || latestOrder.payUrlBase?.value) {
            const baseUrl = latestOrder.payUrlBase?.value || latestOrder.payUrl?.value;
            const finalUrl = buildWaylUrl(baseUrl, settings);
            
            console.log('🔗 استخدام رابط WAYL المحفوظ مع إعدادات محدثة');
            console.log(`📎 الرابط النهائي: ${finalUrl}`);
            
            return res.redirect(finalUrl);
        }
        
        // إذا لم يوجد رابط محفوظ، اعرض رسالة
        return res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <title>Payment Link Not Found</title>
                <style>
                    body { 
                        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; 
                        text-align: center; padding: 50px;
                        background: linear-gradient(135deg, #ff6b6b 0%, #ee5a6f 100%);
                        min-height: 100vh; display: flex; align-items: center; justify-content: center;
                        color: white;
                    }
                    .container { 
                        background: rgba(255,255,255,0.1); padding: 40px; border-radius: 15px; 
                        backdrop-filter: blur(10px); max-width: 500px;
                    }
                    .btn { 
                        background: white; color: #333; padding: 12px 24px; text-decoration: none; 
                        border-radius: 8px; display: inline-block; margin-top: 20px; font-weight: 600;
                    }
                    .emoji { font-size: 3rem; margin-bottom: 20px; }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="emoji">⚠️</div>
                    <h2>رابط الدفع غير متوفر</h2>
                    <p>تم العثور على طلب ${latestOrder.name} لكن لم يتم إنشاء رابط دفع له بعد.</p>
                    <p>يرجى المحاولة مرة أخرى بعد قليل أو التواصل مع الدعم.</p>
                    <a href="https://${SHOPIFY_STORE_DOMAIN}" class="btn">العودة للمتجر</a>
                </div>
            </body>
            </html>
        `);
        
    } catch (error) {
        console.error('❌ خطأ في /pay:', error);
        
        res.status(500).send(`
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <title>Payment Error</title>
                <style>
                    body { 
                        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; 
                        text-align: center; padding: 50px;
                        background: linear-gradient(135deg, #ff6b6b 0%, #ee5a6f 100%);
                        min-height: 100vh; display: flex; align-items: center; justify-content: center;
                        color: white;
                    }
                    .container { 
                        background: rgba(255,255,255,0.1); padding: 40px; border-radius: 15px; 
                        backdrop-filter: blur(10px); max-width: 500px;
                    }
                    .btn { 
                        background: white; color: #333; padding: 12px 24px; text-decoration: none; 
                        border-radius: 8px; display: inline-block; margin-top: 20px; font-weight: 600;
                    }
                    details { margin-top: 20px; text-align: left; }
                    pre { 
                        background: rgba(0,0,0,0.3); padding: 10px; border-radius: 5px; 
                        font-size: 12px; white-space: pre-wrap; word-wrap: break-word;
                    }
                    .emoji { font-size: 3rem; margin-bottom: 20px; }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="emoji">❌</div>
                    <h2>خطأ في معالجة الدفع</h2>
                    <p>نعتذر، حدث خطأ أثناء محاولة الوصول لرابط الدفع</p>
                    <details>
                        <summary>تفاصيل الخطأ (للدعم الفني)</summary>
                        <pre>${error.message}</pre>
                    </details>
                    <a href="https://${SHOPIFY_STORE_DOMAIN}" class="btn">العودة للمتجر</a>
                    <br><br>
                    <small>إذا استمرت المشكلة، تواصل مع الدعم الفني</small>
                </div>
            </body>
            </html>
        `);
    }
});

// Route مرادف للدفع - محدث لدعم order_id 🆕
app.get('/payment', async (req, res) => {
    try {
        const orderId = req.query.order_id;
        
        if (orderId) {
            console.log(`🎯 طلب دفع محدد للطلب: ${orderId}`);
            
            // استخراج رقم الطلب من gid
            const cleanOrderId = orderId.includes('/') ? orderId.split('/').pop() : orderId;
            
            // توجيه للطلب المحدد
            return res.redirect(`/orders/${cleanOrderId}/pay`);
        }
        
        console.log('🔄 طلب دفع عام - توجيه لـ /pay');
        // إذا لم يكن هناك order_id، استخدم الطريقة العامة
        res.redirect('/pay');
        
    } catch (error) {
        console.error('خطأ في /payment:', error);
        // في حالة أي خطأ، استخدم الطريقة العامة كـ fallback
        res.redirect('/pay');
    }
});

// Webhook من WAYL لإكمال الدفع
app.post("/webhooks/wayl/payment", async (req, res) => {
  try {
    console.log("💰 تم استقبال إشعار دفع من WAYL");
    console.log("Payload:", JSON.stringify(req.body, null, 2));

    const { status, referenceId, id: transactionId, completedAt } = req.body || {};

    if (!referenceId) {
      console.error("Missing referenceId in WAYL webhook");
      return res.status(400).send("Missing referenceId");
    }

    const match = referenceId.match(/SHOPIFY-(\d+)-/);
    if (!match) {
      console.error("Invalid referenceId format:", referenceId);
      return res.status(400).send("Invalid referenceId format");
    }

    const orderId = match[1];
    const orderGID = `gid://shopify/Order/${orderId}`;
    console.log(`Processing WAYL payment for order ${orderId}: ${status}`);

    if (status === "Completed") {
      // تحديد الطلب كمدفوع
      const markPaidMutation = `
        mutation orderMarkAsPaid($input: OrderMarkAsPaidInput!) {
          orderMarkAsPaid(input: $input) {
            order { id displayFinancialStatus displayFulfillmentStatus }
            userErrors { field message }
          }
        }
      `;
      await shopifyGraphQL(markPaidMutation, { input: { id: orderGID } });

      // تحديث Metafields
      const updateMetafieldsMutation = `
        mutation SetPaymentMetafields($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            metafields { key value }
            userErrors { field message }
          }
        }
      `;
      const completionMetafields = [
        { ownerId: orderGID, namespace: "wayl", key: "payment_status", type: "single_line_text_field", value: "completed" },
        { ownerId: orderGID, namespace: "wayl", key: "transaction_id", type: "single_line_text_field", value: transactionId || "" },
        { ownerId: orderGID, namespace: "wayl", key: "completed_at", type: "single_line_text_field", value: completedAt || new Date().toISOString() },
      ];
      await shopifyGraphQL(updateMetafieldsMutation, { metafields: completionMetafields });

      // إضافة تاغات
      const addTagMutation = `
        mutation tagsAdd($id: ID!, $tags: [String!]!) {
          tagsAdd(id: $id, tags: $tags) {
            node { id }
            userErrors { field message }
          }
        }
      `;
      const tags = ["WAYL-PAID", transactionId ? `WAYL-TX-${transactionId}` : "WAYL-TX-UNKNOWN", "WAYL-USD-DISPLAY"];
      await shopifyGraphQL(addTagMutation, { id: orderGID, tags });
      console.log(`✅ Order ${orderId} marked as paid via WAYL`);
    }

    res.status(200).json({ success: true });
  } catch (e) {
    console.error("❌ خطأ في معالجة إشعار الدفع:", e);
    res.status(500).json({ error: e.message });
  }
});

console.log('🚀 تم إضافة route الدفع البسيط مع دعم جميع الدول العربية والـ order_id: /payment');
console.log('🖼️ تم تحسين نظام الصور مع Unsplash والصور المخصصة حسب نوع المنتج');

// ==================== START ====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 سيرفر WAYL-Shopify يعمل على المنفذ ${PORT}`);
  console.log(`🔗 BASE_URL: ${BASE_URL}`);
  console.log(`🛍️ Shopify: ${SHOPIFY_STORE_DOMAIN}`);
  console.log(`💳 WAYL API: ${WAYL_API_BASE}`);
  console.log(`💱 1 USD = ${USD_TO_IQD_RATE} IQD`);
  console.log(`🔄 AUTO_REDIRECT: ${AUTO_REDIRECT}`);
  console.log(`⏱️ REDIRECT_DELAY: ${REDIRECT_DELAY}ms`);
  console.log(`💰 Payment Route: ${BASE_URL}/pay`);
  console.log(`🎯 Smart Payment Route: ${BASE_URL}/payment?order_id=ORDER_ID`);
  console.log(`🌍 Arabic Countries Supported: 22`);
  console.log(`🗣️ Languages: Arabic (ar) + English (en)`);
  console.log(`💵 Display Currency: USD for all countries`);
  console.log(`💰 Payment Currency: IQD (Iraqi Dinar)`);
  console.log(`🖼️ Product Images: Smart image generation with Unsplash + custom matching`);
});