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

// قاموس الصور الحقيقية لمنتجات متجرك - محدث مع الصور الجديدة
const REAL_PRODUCT_IMAGES = {
  // HydroCat Products - الصور الحقيقية من متجرك
  'hydrocat': {
    main: 'https://tryhydrocat.com/cdn/shop/files/9c90033b1a407ed93d5c7854445cc20c.png',
    gallery: [
      'https://tryhydrocat.com/cdn/shop/files/1_7bf74595-ff6c-44fa-85c5-4e53e1f080d9.png',
      'https://tryhydrocat.com/cdn/shop/files/8.png',
      'https://tryhydrocat.com/cdn/shop/files/7.png',
      'https://tryhydrocat.com/cdn/shop/files/10.png',
      'https://tryhydrocat.com/cdn/shop/files/9.png'
    ]
  },
  
  // Water Fountain variations
  'water fountain': {
    main: 'https://tryhydrocat.com/cdn/shop/files/9c90033b1a407ed93d5c7854445cc20c.png',
    gallery: ['https://tryhydrocat.com/cdn/shop/files/1_7bf74595-ff6c-44fa-85c5-4e53e1f080d9.png']
  },
  
  // Stainless Steel variations
  'stainless steel water fountain': {
    main: 'https://tryhydrocat.com/cdn/shop/files/9c90033b1a407ed93d5c7854445cc20c.png',
    gallery: ['https://tryhydrocat.com/cdn/shop/files/8.png']
  },
  
  // Cat Fountain variations
  'cat fountain': {
    main: 'https://tryhydrocat.com/cdn/shop/files/9c90033b1a407ed93d5c7854445cc20c.png',
    gallery: ['https://tryhydrocat.com/cdn/shop/files/7.png']
  },
  
  // الصور الجديدة المضافة
  '8 filter sets': {
    main: 'https://tryhydrocat.com/cdn/shop/files/1_189b0f59-a79b-43ef-91c8-6342012c076a.png',
    gallery: ['https://tryhydrocat.com/cdn/shop/files/1_189b0f59-a79b-43ef-91c8-6342012c076a.png']
  },
  
  '4 filter sets': {
    main: 'https://tryhydrocat.com/cdn/shop/files/4x.png',
    gallery: ['https://tryhydrocat.com/cdn/shop/files/4x.png']
  },
  
  'cat hair scraper': {
    main: 'https://tryhydrocat.com/cdn/shop/files/S4e10ad5ee06f4701bfae29ffe478a666S_1_1.webp',
    gallery: ['https://tryhydrocat.com/cdn/shop/files/S4e10ad5ee06f4701bfae29ffe478a666S_1_1.webp']
  },
  
  'free shipping': {
    main: 'https://tryhydrocat.com/cdn/shop/files/free-delivery_d5b4e306-16a1-4d29-85da-859025613537.png',
    gallery: ['https://tryhydrocat.com/cdn/shop/files/free-delivery_d5b4e306-16a1-4d29-85da-859025613537.png']
  },
  
  // Filter Sets عامة
  'filter': {
    main: 'https://tryhydrocat.com/cdn/shop/files/4x.png',
    gallery: ['https://tryhydrocat.com/cdn/shop/files/1_189b0f59-a79b-43ef-91c8-6342012c076a.png']
  },
  
  // FREE items وShipping
  'free': {
    main: 'https://tryhydrocat.com/cdn/shop/files/S4e10ad5ee06f4701bfae29ffe478a666S_1_1.webp',
    gallery: ['https://tryhydrocat.com/cdn/shop/files/S4e10ad5ee06f4701bfae29ffe478a666S_1_1.webp']
  },
  
  'shipping': {
    main: 'https://tryhydrocat.com/cdn/shop/files/free-delivery_d5b4e306-16a1-4d29-85da-859025613537.png',
    gallery: ['https://tryhydrocat.com/cdn/shop/files/free-delivery_d5b4e306-16a1-4d29-85da-859025613537.png']
  }
};

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

// دالة للبحث عن صورة حقيقية للمنتج
function findRealProductImage(productTitle) {
  if (!productTitle) return null;
  
  const title = productTitle.toLowerCase();
  console.log(`🔍 البحث عن صورة حقيقية للمنتج: "${productTitle}"`);
  
  // البحث الدقيق أولاً
  for (const [keyword, imageData] of Object.entries(REAL_PRODUCT_IMAGES)) {
    if (title.includes(keyword)) {
      console.log(`✅ تم العثور على مطابقة دقيقة: ${keyword}`);
      console.log(`🖼️ الصورة الرئيسية: ${imageData.main}`);
      return imageData.main;
    }
  }
  
  // البحث المرن بالكلمات المفردة
  const keywords = title.split(' ');
  for (const keyword of keywords) {
    if (keyword.length > 3) { // تجنب الكلمات القصيرة
      for (const [productKey, imageData] of Object.entries(REAL_PRODUCT_IMAGES)) {
        if (productKey.includes(keyword) || keyword.includes(productKey)) {
          console.log(`✅ تم العثور على مطابقة مرنة: ${keyword} → ${productKey}`);
          console.log(`🖼️ الصورة المختارة: ${imageData.main}`);
          return imageData.main;
        }
      }
    }
  }
  
  console.log(`⚠️ لم يتم العثور على صورة حقيقية للمنتج: ${productTitle}`);
  return null;
}

// النظام المحسن لاستخراج الصور مع الأولوية للصور الحقيقية
function getOptimalProductImage(item) {
  console.log(`🖼️ معالجة صورة المنتج: ${item.title || 'منتج غير معرف'}`);
  
  // الأولوية الأولى: صور Shopify الأصلية من متجرك
  const shopifyImageSources = [
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
  
  for (const source of shopifyImageSources) {
    if (source && typeof source === 'string' && source.includes('http')) {
      // تحقق إضافي: هل الرابط من متجرك؟
      if (source.includes('tryhydrocat.com') || source.includes('ati0hg-ap.myshopify.com')) {
        console.log(`✅ صورة Shopify أصلية من متجرك: ${source}`);
        return source;
      }
    }
  }
  
  // الأولوية الثانية: الصور الحقيقية المحفوظة
  const realImage = findRealProductImage(item.title);
  if (realImage) {
    return realImage;
  }
  
  // الأولوية الثالثة: صور Unsplash مخصصة
  const title = (item.title || 'Product').toLowerCase();
  const price = parseFloat(item.price) || 0;
  
  // صور احترافية مخصصة حسب نوع المنتج
  const categoryImages = {
    // منتجات المياه والنوافير
    water: 'https://images.unsplash.com/photo-1544551763-46a013bb70d5?ixlib=rb-4.0.3&auto=format&fit=crop&w=300&h=300&q=80',
    fountain: 'https://images.unsplash.com/photo-1544551763-46a013bb70d5?ixlib=rb-4.0.3&auto=format&fit=crop&w=300&h=300&q=80',
    hydro: 'https://images.unsplash.com/photo-1550583724-b2692b85b150?ixlib=rb-4.0.3&auto=format&fit=crop&w=300&h=300&q=80',
    
    // منتجات القطط
    cat: 'https://images.unsplash.com/photo-1514888286974-6c03e2ca1dba?ixlib=rb-4.0.3&auto=format&fit=crop&w=300&h=300&q=80',
    pet: 'https://images.unsplash.com/photo-1601758228041-f3b2795255f1?ixlib=rb-4.0.3&auto=format&fit=crop&w=300&h=300&q=80',
    
    // الفلاتر
    filter: 'https://images.unsplash.com/photo-1563453392212-326f5e854473?ixlib=rb-4.0.3&auto=format&fit=crop&w=300&h=300&q=80',
    
    // الستانلس ستيل
    steel: 'https://images.unsplash.com/photo-1571019613454-1cb2f99b2d8b?ixlib=rb-4.0.3&auto=format&fit=crop&w=300&h=300&q=80',
    stainless: 'https://images.unsplash.com/photo-1571019613454-1cb2f99b2d8b?ixlib=rb-4.0.3&auto=format&fit=crop&w=300&h=300&q=80'
  };
  
  // البحث عن كلمة مفتاحية
  for (const [keyword, imageUrl] of Object.entries(categoryImages)) {
    if (title.includes(keyword)) {
      console.log(`✅ صورة Unsplash مخصصة للنوع: ${keyword}`);
      console.log(`🔗 الرابط: ${imageUrl}`);
      return imageUrl;
    }
  }
  
  // الأولوية الأخيرة: صورة عامة مخصصة
  const genericImages = [
    'https://images.unsplash.com/photo-1556742049-0cfed4f6a45d?ixlib=rb-4.0.3&auto=format&fit=crop&w=300&h=300&q=80',
    'https://images.unsplash.com/photo-1550583724-b2692b85b150?ixlib=rb-4.0.3&auto=format&fit=crop&w=300&h=300&q=80',
    'https://images.unsplash.com/photo-1572981779307-38b8cabb2407?ixlib=rb-4.0.3&auto=format&fit=crop&w=300&h=300&q=80'
  ];
  
  const imageIndex = Math.floor((price * 10) % genericImages.length);
  const finalImage = genericImages[imageIndex];
  
  console.log(`💡 صورة عامة للمنتج "${item.title}" - السعر: $${price}`);
  console.log(`🔗 الصورة النهائية: ${finalImage}`);
  
  return finalImage;
}

// دالة محسنة للتحقق من المنتجات المجانية - أسرع وأدق
function analyzeItem(item) {
  const title = item.title ? item.title.toLowerCase() : '';
  const price = parseFloat(item.price || 0);
  const comparePrice = parseFloat(item.compare_at_price || 0);
  
  // هدايا مجانية حقيقية (تظهر $0.00)
  if (title.includes('free') && (title.includes('gift') || title.includes('scraper') || title.includes('bonus'))) {
    return { isFree: true, isGift: true };
  }
  
  // شحن مجاني (يظهر $0.00)
  if (title.includes('shipping') && price === 0) {
    return { isFree: true, isGift: true };
  }
  
  // منتجات بسعر 0 لكن ليست هدايا (منتجات اختيارية مخفضة 100%)
  if (price === 0 && comparePrice > 0 && !title.includes('free')) {
    return { isFree: false, isGift: false }; // منتج عادي بسعر مخفض للصفر
  }
  
  return { isFree: false, isGift: false };
}

// معالجة الأخطاء العامة لتجنب تعطل السيرفر
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  // لا نوقف السيرفر، فقط نسجل الخطأ
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
  // لا نوقف السيرفر، فقط نسجل الخطأ
});

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
    real_product_images: Object.keys(REAL_PRODUCT_IMAGES).length,
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

// استقبال Webhook من Shopify عند إنشاء الطلب - محدث مع المنتجات المجانية
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

    // بناء line items مع استخراج الصور الحقيقية ومعالجة المنتجات المجانية
    const lineItems = [];
    let freeItemsCount = 0;
    
    if (order.line_items?.length) {
      console.log(`🛍️ معالجة ${order.line_items.length} عنصر في الطلب...`);
      
      order.line_items.forEach((item, index) => {
        const isFree = isFreeItem(item);
        const productImage = getOptimalProductImage(item);
        
        if (isFree) {
          // منتج مجاني - نرسله بقيمة 1 IQD مع اسمه الأصلي
          freeItemsCount++;
          console.log(`🎁 منتج مجاني: ${item.title}`);
          
          lineItems.push({
            label: item.title || "Free Product",
            amount: 1, // 1 IQD minimum للمنتجات المجانية
            type: "increase",
            image: productImage,
          });
        } else {
          // منتج عادي بسعر
          const itemPriceUSD = parseFloat(item.price);
          const itemQuantity = item.quantity;
          const totalItemUSD = itemPriceUSD * itemQuantity;
          const amountInIQD = convertToIQD(totalItemUSD, currency);

          console.log(`📦 العنصر ${index + 1}: ${item.title} - $${totalItemUSD} - صورة: ${productImage.includes('tryhydrocat.com') ? '🏪 (متجرك)' : '📸'}`);

          lineItems.push({
            label: item.title || "Product",
            amount: amountInIQD,
            type: "increase",
            image: productImage,
          });
        }
      });
    }

    // الشحن - مع معالجة الشحن المجاني
    if (order.shipping_lines?.length) {
      console.log(`🚚 معالجة ${order.shipping_lines.length} خط شحن...`);
      
      order.shipping_lines.forEach((shipping) => {
        const shippingAmountUSD = parseFloat(shipping.price);
        const shippingImage = getOptimalProductImage({ title: shipping.title || "Shipping" });
        
        if (shippingAmountUSD === 0) {
          // شحن مجاني - نرسله بقيمة 1 IQD مع اسمه الأصلي
          freeItemsCount++;
          console.log(`🚚 شحن مجاني: ${shipping.title}`);
          lineItems.push({
            label: shipping.title || "Free Shipping",
            amount: 1, // 1 IQD minimum
            type: "increase",
            image: shippingImage,
          });
        } else {
          // شحن مدفوع
          console.log(`🚚 شحن مدفوع: ${shipping.title} - $${shippingAmountUSD}`);
          lineItems.push({
            label: `Shipping - ${shipping.title}`,
            amount: convertToIQD(shippingAmountUSD, currency),
            type: "increase",
            image: shippingImage,
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
            image: "https://images.unsplash.com/photo-1554224155-6726b3ff858f?ixlib=rb-4.0.3&auto=format&fit=crop&w=300&h=300&q=80",
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
        image: "https://images.unsplash.com/photo-1556742049-0cfed4f6a45d?ixlib=rb-4.0.3&auto=format&fit=crop&w=300&h=300&q=80",
      });
    }

    const referenceId = `SHOPIFY-${orderId}-${Date.now()}`;
    const orderGID = `gid://shopify/Order/${orderId}`;
    const totalInIQD = lineItems.reduce((sum, i) => sum + i.amount, 0);

    console.log(`🔗 إنشاء رابط WAYL للطلب ${orderName}...`);
    console.log(`💰 للعرض: ${totalAmount} ${currency}`);
    console.log(`💰 للدفع: ${totalInIQD} IQD`);
    console.log(`🎁 عناصر مجانية: ${freeItemsCount}`);
    console.log(`🖼️ صور حقيقية من متجرك: ${lineItems.filter(item => item.image.includes('tryhydrocat.com')).length}/${lineItems.length}`);

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
    console.log("📋 المنتجات:", lineItems.map(item => `${item.label} - ${item.image.includes('tryhydrocat.com') ? 'REAL_STORE_IMAGE' : 'FALLBACK_IMAGE'}`));

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
        `🎁 Free Items: ${freeItemsCount}\n` +
        `🖼️ Real Store Images: ${lineItems.filter(item => item.image.includes('tryhydrocat.com')).length}/${lineItems.length}\n` +
        `📊 Status: Pending Payment`;

      await shopifyGraphQL(noteUpdateMutation, { input: { id: orderGID, note: currentNote + waylNote } });

      console.log(`✅ تم حفظ بيانات الدفع في Shopify للطلب ${orderName}`);

      // التحقق من header للتوجيه التلقائي أو إذا كان AUTO_REDIRECT مفعل
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
        free_items: freeItemsCount,
        real_store_images: lineItems.filter(item => item.image.includes('tryhydrocat.com')).length,
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

// المسار الجديد: تحويل للـ WAYL باستخدام رقم الطلب في Shopify
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

// ROUTE الجديد: الدفع العام - محدث لعدم إنشاء طلبات وهمية
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

// Route مرادف للدفع - محدث لدعم order_id
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
console.log('🖼️ تم تحسين نظام الصور مع الصور الحقيقية من متجر tryhydrocat.com');
console.log('🎁 تم إضافة دعم المنتجات المجانية (تظهر بـ 1 IQD مع كلمة FREE)');

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
  console.log(`🖼️ Product Images: Real images from tryhydrocat.com + Unsplash fallback`);
  console.log(`🏪 Store Images Available: ${Object.keys(REAL_PRODUCT_IMAGES).length} products mapped`);
  console.log(`🎁 Free Items: Display as FREE with 1 IQD (WAYL API compatible)`);
});