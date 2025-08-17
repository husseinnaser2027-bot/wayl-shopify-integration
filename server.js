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

// إعدادات العرض حسب البلد
function getDisplaySettings(country) {
  const settings = {
    US: { language: "en", currency: "usd", displayCurrency: "USD" },
    GB: { language: "en", currency: "usd", displayCurrency: "USD" },
    CA: { language: "en", currency: "usd", displayCurrency: "USD" },
    AU: { language: "en", currency: "usd", displayCurrency: "USD" },
    DE: { language: "en", currency: "usd", displayCurrency: "USD" },
    FR: { language: "en", currency: "usd", displayCurrency: "USD" },
    IQ: { language: "ar", currency: "iqd", displayCurrency: "IQD" },
    SA: { language: "ar", currency: "iqd", displayCurrency: "IQD" },
    AE: { language: "ar", currency: "iqd", displayCurrency: "IQD" },
  };
  return settings[country] || settings.US;
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

// يبني رابط WAYL بإضافة lang/currency
function buildWaylUrl(baseUrl, { language, currency }) {
  if (!baseUrl) return null;
  const u = new URL(baseUrl);
  if (!u.searchParams.get("lang")) u.searchParams.set("lang", language);
  if (!u.searchParams.get("currency")) u.searchParams.set("currency", currency);
  return u.toString();
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

    // افتراضي إنجليزي/دولار للواجهات الدولية
    const displaySettings = getDisplaySettings("US");
    console.log(`🌍 إعدادات العرض: ${displaySettings.language}, ${displaySettings.currency}`);

    // بناء line items
    const lineItems = [];
    if (order.line_items?.length) {
      order.line_items.forEach((item) => {
        const itemPriceUSD = parseFloat(item.price);
        const itemQuantity = item.quantity;
        const totalItemUSD = itemPriceUSD * itemQuantity;
        const amountInIQD = convertToIQD(totalItemUSD, currency);

        lineItems.push({
          label: item.title || "Product",
          amount: amountInIQD,
          type: "increase",
          image:
            item.variant_image_url ||
            item.image_url ||
            "https://via.placeholder.com/150/4CAF50/ffffff?text=Product",
        });
      });
    }

    // الشحن
    if (order.shipping_lines?.length) {
      order.shipping_lines.forEach((shipping) => {
        const shippingAmountUSD = parseFloat(shipping.price);
        if (shippingAmountUSD > 0) {
          lineItems.push({
            label: `Shipping - ${shipping.title}`,
            amount: convertToIQD(shippingAmountUSD, currency),
            type: "increase",
            image: "https://via.placeholder.com/150/2196F3/ffffff?text=Shipping",
          });
        }
      });
    }

    // الضرائب
    if (order.tax_lines?.length) {
      order.tax_lines.forEach((tax) => {
        const taxAmountUSD = parseFloat(tax.price);
        if (taxAmountUSD > 0) {
          lineItems.push({
            label: `Tax - ${tax.title}`,
            amount: convertToIQD(taxAmountUSD, currency),
            type: "increase",
            image: "https://via.placeholder.com/150/FF9800/ffffff?text=Tax",
          });
        }
      });
    }

    // إذا ماكو عناصر، خلي عنصر واحد بالمجموع
    if (lineItems.length === 0) {
      const totalInIQDOnly = convertToIQD(totalAmount, currency);
      lineItems.push({
        label: `Order ${orderName}`,
        amount: totalInIQDOnly,
        type: "increase",
        image: "https://via.placeholder.com/150/4CAF50/ffffff?text=Order",
      });
    }

    const referenceId = `SHOPIFY-${orderId}-${Date.now()}`;
    const orderGID = `gid://shopify/Order/${orderId}`;
    const totalInIQD = lineItems.reduce((sum, i) => sum + i.amount, 0);

    console.log(`🔗 إنشاء رابط WAYL للطلب ${orderName}...`);
    console.log(`💰 للعرض: ${totalAmount} ${currency}`);
    console.log(`💰 للدفع: ${totalInIQD} IQD`);

    const waylPayload = {
      referenceId,
      total: totalInIQD,
      currency: "IQD",
      lineItem: lineItems,
      webhookUrl: `${BASE_URL}/webhooks/wayl/payment`,
      webhookSecret: crypto.createHash("sha256").update(`${orderId}-${Date.now()}`).digest("hex"),
      redirectionUrl: order.order_status_url || `https://${SHOPIFY_STORE_DOMAIN}/account`,
    };

    console.log("📤 إرسال البيانات إلى WAYL:", JSON.stringify(waylPayload, null, 2));

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

      // أضف lang/currency للعرض (للزائر الدولي)
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
        `🌍 Language: ${displaySettings.language}\n` +
        `💱 Currency Display: ${displaySettings.currency}\n` +
        `📊 Status: Pending Payment`;

      await shopifyGraphQL(noteUpdateMutation, { input: { id: orderGID, note: currentNote + waylNote } });

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
        conversion_rate: USD_TO_IQD_RATE,
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
          payUrlBase: metafield(namespace: "wayl", key: "pay_url_base") { value }
          payUrl: metafield(namespace: "wayl", key: "pay_url") { value }
          display: metafield(namespace: "wayl", key: "display_settings") { value }
        }
      }
    `;

    const data = await shopifyGraphQL(query, { id: orderGID });
    const order = data?.order;

    const base = order?.payUrlBase?.value || order?.payUrl?.value;
    if (!base) {
      return res.status(404).json({ ok: false, message: "لم يتم العثور على رابط WAYL لهذا الطلب." });
    }

    // إذا موجود display_settings محفوظ، استخدمه للعرض
    let effSettings = settings;
    if (order?.display?.value) {
      try {
        const saved = JSON.parse(order.display.value);
        effSettings = { language: saved.language || settings.language, currency: saved.currency || settings.currency };
      } catch (_) {}
    }

    const finalUrl = buildWaylUrl(base, effSettings);
    return res.redirect(finalUrl);
  } catch (e) {
    console.error("Error redirecting order to WAYL:", e);
    res.status(500).json({ ok: false, error: e.message });
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

// ==================== START ====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 سيرفر WAYL-Shopify يعمل على المنفذ ${PORT}`);
  console.log(`🔗 BASE_URL: ${BASE_URL}`);
  console.log(`🛍️ Shopify: ${SHOPIFY_STORE_DOMAIN}`);
  console.log(`💳 WAYL API: ${WAYL_API_BASE}`);
  console.log(`💱 1 USD = ${USD_TO_IQD_RATE} IQD`);
});
