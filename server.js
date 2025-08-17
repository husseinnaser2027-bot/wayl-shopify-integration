import express from "express";
import crypto from "crypto";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();

// إعداد Express للتعامل مع JSON
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
  DEFAULT_CURRENCY = "USD",
  BASE_URL = "http://localhost:3000"
} = process.env;

// سعر الصرف USD إلى IQD (يمكنك تحديثه حسب السعر الحالي)
const USD_TO_IQD_RATE = 1320;

// فحص صحة Webhook من Shopify
function verifyShopifyWebhook(req) {
  try {
    const hmacHeader = req.get("X-Shopify-Hmac-Sha256") || "";
    const digest = crypto
      .createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
      .update(req.rawBody || Buffer.from(JSON.stringify(req.body)), "utf8")
      .digest("base64");
    
    if (Buffer.byteLength(hmacHeader) != Buffer.byteLength(digest)) return false;
    return crypto.timingSafeEqual(Buffer.from(hmacHeader), Buffer.from(digest));
  } catch (e) {
    console.error("HMAC verify error:", e);
    return false;
  }
}

// كشف البلد من IP العميل (بسيط)
function detectCustomerCountry(req) {
  // يمكن استخدام خدمة IP geolocation هنا
  const forwardedFor = req.headers['x-forwarded-for'];
  const ip = forwardedFor ? forwardedFor.split(',')[0] : req.connection.remoteAddress;
  
  // للاختبار المحلي، استخدم header مخصص أو افتراضي
  const testCountry = req.headers['x-test-country'];
  if (testCountry) return testCountry;
  
  // افتراضي للاختبار
  if (ip === '127.0.0.1' || ip === '::1' || ip.startsWith('192.168.')) {
    return 'US'; // افتراضي للاختبار المحلي
  }
  
  // هنا يمكنك إضافة منطق كشف البلد الحقيقي
  return 'IQ'; // افتراضي عراق
}

// تحديد إعدادات العرض حسب البلد
function getDisplaySettings(country) {
  const settings = {
    'US': { language: 'en', currency: 'usd', displayCurrency: 'USD' },
    'GB': { language: 'en', currency: 'usd', displayCurrency: 'USD' },
    'CA': { language: 'en', currency: 'usd', displayCurrency: 'USD' },
    'AU': { language: 'en', currency: 'usd', displayCurrency: 'USD' },
    'DE': { language: 'en', currency: 'usd', displayCurrency: 'USD' },
    'FR': { language: 'en', currency: 'usd', displayCurrency: 'USD' },
    'IQ': { language: 'ar', currency: 'iqd', displayCurrency: 'IQD' },
    'SA': { language: 'ar', currency: 'iqd', displayCurrency: 'IQD' },
    'AE': { language: 'ar', currency: 'iqd', displayCurrency: 'IQD' }
  };
  
  return settings[country] || settings['US']; // افتراضي إنجليزي ودولار
}

// تحويل العملة إلى دينار عراقي للدفع
function convertToIQD(amount, fromCurrency = "USD") {
  if (fromCurrency === "IQD") return Math.round(amount);
  
  const rates = {
    'USD': USD_TO_IQD_RATE,
    'EUR': USD_TO_IQD_RATE * 1.1,
    'GBP': USD_TO_IQD_RATE * 1.25
  };
  
  const convertedAmount = Math.round(amount * (rates[fromCurrency] || USD_TO_IQD_RATE));
  return Math.max(convertedAmount, 1000); // الحد الأدنى 1000 دينار
}

// تشغيل GraphQL queries على Shopify
async function shopifyGraphQL(query, variables = {}) {
  const res = await fetch(`https://${SHOPIFY_STORE_DOMAIN}/admin/api/2024-07/graphql.json`, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ query, variables })
  });
  
  const data = await res.json();
  if (!res.ok || data.errors) {
    console.error("Shopify GraphQL error:", data);
    throw new Error(JSON.stringify(data));
  }
  return data.data;
}

// صفحة اختبار الحالة
app.get("/health", (req, res) => {
  const country = detectCustomerCountry(req);
  const settings = getDisplaySettings(country);
  
  res.json({ 
    ok: true, 
    timestamp: new Date().toISOString(),
    detected_country: country,
    display_settings: settings,
    conversion_rate: USD_TO_IQD_RATE,
    node_version: process.version
  });
});

// اختبار الاتصال بـ WAYL API
app.get("/test/wayl", async (req, res) => {
  try {
    const country = detectCustomerCountry(req);
    const settings = getDisplaySettings(country);
    
    const testRes = await fetch(`${WAYL_API_BASE}/api/v1/verify-auth-key`, {
      headers: {
        "X-WAYL-AUTHENTICATION": WAYL_API_KEY
      }
    });
    
    const testData = await testRes.json();
    
    res.json({
      waylApiStatus: testRes.ok ? "✅ متصل" : "❌ خطأ",
      statusCode: testRes.status,
      response: testData,
      detected_country: country,
      display_settings: settings,
      conversion_rate: USD_TO_IQD_RATE
    });
    
  } catch (e) {
    res.status(500).json({ 
      error: "❌ فشل الاتصال بـ WAYL API", 
      details: e.message 
    });
  }
});

// استقبال Webhook من Shopify عند إنشاء طلب جديد
app.post("/webhooks/shopify/orders/create", async (req, res) => {
  try {
    console.log("📦 تم استقبال طلب جديد من Shopify");
    
    // التحقق من صحة الـ webhook (في الإنتاج فقط)
    if (process.env.NODE_ENV === 'production' && !verifyShopifyWebhook(req)) {
      console.error("❌ HMAC غير صحيح");
      return res.status(401).send("Invalid HMAC");
    }

    const order = req.body;
    const orderId = order.id;
    const orderName = order.name;
    const totalAmount = parseFloat(order.total_price);
    const currency = order.currency;

    console.log(`طلب رقم: ${orderName}`);
    console.log(`💰 المبلغ الأصلي: ${totalAmount} ${currency}`);

    // تحديد إعدادات العرض (افتراضياً للدوليين)
    const displaySettings = getDisplaySettings('US'); // افتراضي إنجليزي ودولار
    
    console.log(`🌍 إعدادات العرض: ${displaySettings.language}, ${displaySettings.currency}`);

    // إنشاء Line Items
    const lineItems = [];

    // إضافة المنتجات
    if (order.line_items && order.line_items.length > 0) {
      order.line_items.forEach(item => {
        const itemPriceUSD = parseFloat(item.price);
        const itemQuantity = item.quantity;
        const totalItemUSD = itemPriceUSD * itemQuantity;
        
        // تحويل للدينار للدفع الفعلي
        const amountInIQD = convertToIQD(totalItemUSD, currency);
        
        lineItems.push({
          label: item.title || "Product",
          amount: amountInIQD,
          type: "increase",
          image: item.variant_image_url || item.image_url || "https://via.placeholder.com/150/4CAF50/ffffff?text=Product"
        });
      });
    }

    // إضافة الشحن إذا وجد
    if (order.shipping_lines && order.shipping_lines.length > 0) {
      order.shipping_lines.forEach(shipping => {
        const shippingAmountUSD = parseFloat(shipping.price);
        if (shippingAmountUSD > 0) {
          const shippingInIQD = convertToIQD(shippingAmountUSD, currency);
          
          lineItems.push({
            label: `Shipping - ${shipping.title}`,
            amount: shippingInIQD,
            type: "increase",
            image: "https://via.placeholder.com/150/2196F3/ffffff?text=Shipping"
          });
        }
      });
    }

    // إضافة الضرائب إذا وجدت
    if (order.tax_lines && order.tax_lines.length > 0) {
      order.tax_lines.forEach(tax => {
        const taxAmountUSD = parseFloat(tax.price);
        if (taxAmountUSD > 0) {
          const taxInIQD = convertToIQD(taxAmountUSD, currency);
          
          lineItems.push({
            label: `Tax - ${tax.title}`,
            amount: taxInIQD,
            type: "increase",
            image: "https://via.placeholder.com/150/FF9800/ffffff?text=Tax"
          });
        }
      });
    }

    // إذا لم تكن هناك عناصر، أضف عنصر واحد
    if (lineItems.length === 0) {
      const totalInIQD = convertToIQD(totalAmount, currency);
      lineItems.push({
        label: `Order ${orderName}`,
        amount: totalInIQD,
        type: "increase",
        image: "https://via.placeholder.com/150/4CAF50/ffffff?text=Order"
      });
    }

    const referenceId = `SHOPIFY-${orderId}-${Date.now()}`;
    const orderGID = `gid://shopify/Order/${orderId}`;

    // حساب المجموع الكلي بالدينار العراقي للدفع الفعلي
    const totalInIQD = lineItems.reduce((sum, item) => sum + item.amount, 0);

    console.log(`🔗 إنشاء رابط WAYL للطلب ${orderName}...`);
    console.log(`💰 للعرض: ${totalAmount} ${currency}`);
    console.log(`💰 للدفع: ${totalInIQD} IQD`);

    // إنشاء رابط WAYL
    const waylPayload = {
      referenceId: referenceId,
      total: totalInIQD, // المبلغ الفعلي للدفع بالدينار
      currency: "IQD", // عملة الدفع الفعلية
      lineItem: lineItems,
      webhookUrl: `${BASE_URL}/webhooks/wayl/payment`,
      webhookSecret: crypto.createHash('sha256').update(`${orderId}-${Date.now()}`).digest('hex'),
      redirectionUrl: order.order_status_url || `https://${SHOPIFY_STORE_DOMAIN}/account`
    };

    console.log("📤 إرسال البيانات إلى WAYL:", JSON.stringify(waylPayload, null, 2));

    try {
      const waylRes = await fetch(`${WAYL_API_BASE}/api/v1/links`, {
        method: "POST",
        headers: {
          "X-WAYL-AUTHENTICATION": WAYL_API_KEY,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(waylPayload)
      });
      
      const waylResponse = await waylRes.json();
      
      if (!waylRes.ok || waylRes.status !== 201) {
        console.error("❌ خطأ في إنشاء رابط WAYL:", waylResponse);
        throw new Error(`فشل إنشاء رابط WAYL: ${JSON.stringify(waylResponse)}`);
      }
      
      let payUrl = waylResponse.data.url;
      const waylLinkId = waylResponse.data.id;

      // إضافة معاملات اللغة والعملة للرابط
      const urlParams = new URLSearchParams();
      urlParams.append('lang', displaySettings.language);
      urlParams.append('currency', displaySettings.currency);
      
      // إضافة المعاملات للرابط
      const separator = payUrl.includes('?') ? '&' : '?';
      payUrl = `${payUrl}${separator}${urlParams.toString()}`;

      console.log(`✅ تم إنشاء رابط WAYL: ${payUrl}`);

      // حفظ رابط الدفع في Shopify Metafields
      const metafieldsMutation = `
        mutation SetPaymentMetafields($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            metafields {
              key
              value
            }
            userErrors {
              field
              message
            }
          }
        }
      `;
      
      const metafields = [
        {
          ownerId: orderGID,
          namespace: "wayl",
          key: "pay_url",
          type: "single_line_text_field",
          value: payUrl
        },
        {
          ownerId: orderGID,
          namespace: "wayl",
          key: "pay_url_base",
          type: "single_line_text_field",
          value: waylResponse.data.url // الرابط الأصلي بدون معاملات
        },
        {
          ownerId: orderGID,
          namespace: "wayl",
          key: "reference_id",
          type: "single_line_text_field", 
          value: referenceId
        },
        {
          ownerId: orderGID,
          namespace: "wayl",
          key: "link_id",
          type: "single_line_text_field",
          value: waylLinkId
        },
        {
          ownerId: orderGID,
          namespace: "wayl",
          key: "display_amount",
          type: "single_line_text_field",
          value: `${totalAmount} ${currency}`
        },
        {
          ownerId: orderGID,
          namespace: "wayl",
          key: "payment_amount",
          type: "single_line_text_field",
          value: `${totalInIQD} IQD`
        },
        {
          ownerId: orderGID,
          namespace: "wayl",
          key: "display_settings",
          type: "single_line_text_field",
          value: JSON.stringify(displaySettings)
        }
      ];
      
      await shopifyGraphQL(metafieldsMutation, { metafields });

      // إضافة ملاحظة للطلب
      const noteUpdateMutation = `
        mutation orderUpdate($input: OrderInput!) {
          orderUpdate(input: $input) {
            order {
              id
              note
            }
            userErrors {
              field
              message
            }
          }
        }
      `;
      
      const currentNote = order.note || "";
      const waylNote = `\n\n--- WAYL Payment Link ---\n🔗 Pay URL: ${payUrl}\n📋 Reference: ${referenceId}\n💰 Display: ${totalAmount} ${currency}\n💰 Payment: ${totalInIQD} IQD\n🌍 Language: ${displaySettings.language}\n💱 Currency Display: ${displaySettings.currency}\n📊 Status: Pending Payment`;
      
      await shopifyGraphQL(noteUpdateMutation, {
        input: {
          id: orderGID,
          note: currentNote + waylNote
        }
      });

      console.log(`✅ تم حفظ بيانات الدفع في Shopify للطلب ${orderName}`);

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
        conversion_rate: USD_TO_IQD_RATE
      });

    } catch (waylError) {
      console.error("❌ خطأ في WAYL API:", waylError);
      
      res.status(200).json({ 
        success: false,
        message: `تم استقبال الطلب ${orderName} لكن فشل إنشاء رابط الدفع`,
        error: waylError.message,
        order_id: orderId
      });
    }
    
  } catch (e) {
    console.error("❌ خطأ في معالجة الطلب:", e);
    res.status(500).json({ error: e.message });
  }
});

// إنشاء رابط دفع مخصص حسب البلد
app.get("/pay/:referenceId", (req, res) => {
  try {
    const { referenceId } = req.params;
    const country = req.query.country || detectCustomerCountry(req);
    const settings = getDisplaySettings(country);
    
    // البحث عن الطلب والحصول على الرابط الأساسي
    // (هذا مبسط - في الواقع تحتاج للبحث في Shopify)
    const baseUrl = req.query.base_url || `https://link.thewayl.com/pay?id=${referenceId}`;
    
    // إضافة معاملات اللغة والعملة
    const urlParams = new URLSearchParams();
    urlParams.append('lang', settings.language);
    urlParams.append('currency', settings.currency);
    
    const separator = baseUrl.includes('?') ? '&' : '?';
    const finalUrl = `${baseUrl}${separator}${urlParams.toString()}`;
    
    // إعادة توجيه للرابط النهائي
    res.redirect(finalUrl);
    
  } catch (e) {
    console.error("Error creating custom payment link:", e);
    res.status(500).send("Error creating payment link");
  }
});

// استقبال Webhook من WAYL عند اكتمال الدفع
app.post("/webhooks/wayl/payment", async (req, res) => {
  try {
    console.log("💰 تم استقبال إشعار دفع من WAYL");
    console.log("البيانات:", JSON.stringify(req.body, null, 2));
    
    const webhookData = req.body;
    const { status, referenceId, id: transactionId, total, completedAt } = webhookData;
    
    if (!referenceId) {
      console.error("Missing referenceId in WAYL webhook");
      return res.status(400).send("Missing referenceId");
    }
    
    // استخراج Shopify order ID من referenceId
    const orderIdMatch = referenceId.match(/SHOPIFY-(\d+)-/);
    if (!orderIdMatch) {
      console.error("Invalid referenceId format:", referenceId);
      return res.status(400).send("Invalid referenceId format");
    }
    
    const orderId = orderIdMatch[1];
    const orderGID = `gid://shopify/Order/${orderId}`;
    
    console.log(`Processing WAYL payment for order ${orderId}: ${status}`);

    if (status === "Completed") {
      // تحديد الطلب كمدفوع
      const markPaidMutation = `
        mutation orderMarkAsPaid($input: OrderMarkAsPaidInput!) {
          orderMarkAsPaid(input: $input) {
            order {
              id
              displayFinancialStatus
              displayFulfillmentStatus
            }
            userErrors {
              field
              message
            }
          }
        }
      `;
      
      await shopifyGraphQL(markPaidMutation, { 
        input: { id: orderGID }
      });

      // تحديث metafields مع معلومات اكتمال الدفع
      const updateMetafieldsMutation = `
        mutation SetPaymentMetafields($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            metafields {
              key
              value
            }
            userErrors {
              field
              message
            }
          }
        }
      `;
      
      const completionMetafields = [
        {
          ownerId: orderGID,
          namespace: "wayl",
          key: "payment_status",
          type: "single_line_text_field",
          value: "completed"
        },
        {
          ownerId: orderGID,
          namespace: "wayl",
          key: "transaction_id",
          type: "single_line_text_field",
          value: transactionId || ""
        },
        {
          ownerId: orderGID,
          namespace: "wayl",
          key: "completed_at",
          type: "single_line_text_field",
          value: completedAt || new Date().toISOString()
        }
      ];
      
      await shopifyGraphQL(updateMetafieldsMutation, { 
        metafields: completionMetafields 
      });

      // إضافة تاغ اكتمال الدفع
      const addTagMutation = `
        mutation tagsAdd($id: ID!, $tags: [String!]!) {
          tagsAdd(id: $id, tags: $tags) {
            node {
              id
            }
            userErrors {
              field
              message
            }
          }
        }
      `;
      
      const tags = [
        "WAYL-PAID",
        `WAYL-TX-${transactionId}`,
        "WAYL-USD-DISPLAY"
      ].filter(Boolean);
      
      await shopifyGraphQL(addTagMutation, { 
        id: orderGID, 
        tags 
      });

      console.log(`✅ Order ${orderId} marked as paid via WAYL`);
    }
    
    res.status(200).json({ success: true });
    
  } catch (e) {
    console.error("❌ خطأ في معالجة إشعار الدفع:", e);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 سيرفر WAYL-Shopify يعمل على المنفذ ${PORT}`);
  console.log(`💰 العملة للعرض: يتم تحديدها حسب البلد`);
  console.log(`💳 العملة للدفع: IQD`);
  console.log(`🔗 WAYL API: ${WAYL_API_BASE}`);
  console.log(`🛍️  متجر Shopify: ${SHOPIFY_STORE_DOMAIN}`);
  console.log(`💱 سعر الصرف: 1 USD = ${USD_TO_IQD_RATE} IQD`);
  console.log(`🌍 دعم اللغات: العربية والإنجليزية`);
  console.log(`📱 للاختبار: http://localhost:${PORT}/health`);
});