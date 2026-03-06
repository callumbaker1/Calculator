// index.js
require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// --- CORS (allow only your storefront) ---
const allowedOrigins = ["https://www.tagshop.co.uk"];
app.use(
  cors({
    origin(origin, cb) {
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error("Not allowed by CORS"));
    },
    credentials: true,
  })
);

// Preflight headers
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "https://www.tagshop.co.uk");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// --- Shopify setup ---
const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const SHOPIFY_API_URL = `https://${SHOPIFY_STORE}/admin/api/2025-01`;

const SHOPIFY_HEADERS = {
  "X-Shopify-Access-Token": ACCESS_TOKEN,
  "Content-Type": "application/json",
};

// Keep 1 permanent/base variant, allow up to 99 dynamic ones
const MAX_DYNAMIC_VARIANTS = 99;
const DYNAMIC_SKU_PREFIX = "TAGCFG-";

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------
function toNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function shortCode(length = 6) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // avoids 0/O/1/I confusion
  let out = "";
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) {
    out += chars[bytes[i] % chars.length];
  }
  return out;
}

function buildConfigCode({
  material = "standard",
  tagType = "standard",
  shape = "rect",
  sides = "single",
  holeMM = 5,
  corner = null,
  cornerR = null,
  cord = "none",
  supply = "loose",
}) {
  const map = (v, len = 3) =>
    String(v || "none")
      .replace(/[^a-z0-9]/gi, "")
      .toUpperCase()
      .slice(0, len) || "NON";

  return [
    `TT-${map(tagType, 3)}`,
    `MAT-${map(material, 3)}`,
    `SH-${map(shape, 3)}`,
    `SI-${map(sides, 3)}`,
    `HO-${String(holeMM ?? 0).replace(/[^0-9.]/g, "") || "0"}`,
    `CO-${map(corner || "none", 3)}`,
    `CR-${cornerR != null ? String(cornerR) : "0"}`,
    `CD-${map(cord, 3)}`,
    `SUP-${map(supply, 3)}`,
  ].join("_");
}

// ---------------------------------------------------------------------
// Pricing — matches frontend logic
// ---------------------------------------------------------------------
function calculateCfgPrice({
  width,
  height,
  qty = 1,
  material = "standard",
  tagType = "standard",
  shape = "rect",
  sides = "single",
  holeMM = 5,
  corner = null,
  cornerR = null,
  cord = "none",
  supply = "loose",
}) {
  if (!qty || qty < 1) return 0;

  const PRICING = {
    minOrderTotal: 30.0,
    baseRatePerCm2: {
      standard: {
        standard: 0.012,
        recycled: 0.013,
        waterproof: 0.016,
        luxury: 0.018,
        kraft: 0.014,
      },
      folded: {
        standard: 0.012,
        recycled: 0.013,
        waterproof: 0.016,
        luxury: 0.018,
        kraft: 0.014,
      },
      perforated: {
        standard: 0.012,
        recycled: 0.013,
        waterproof: 0.016,
        luxury: 0.018,
        kraft: 0.014,
      },
    },
    tagTypeUplift: {
      standard: 0.0,
      folded: 0.15,
      perforated: 0.1,
    },
    sidesUplift: {
      single: 0.0,
      double: 0.12,
    },
    customShapeUplift: 0.18,
    cornerUplift: {
      square: 0.0,
      rounded: 0.08,
      luggage: 0.1,
    },
    roundedRadiusPerMm: 0.0007,
    holeSurcharge: {
      enabled: true,
      mmAtOrAbove: 7,
      addPerTag: 0.002,
    },
    cords: {
      none: { price: 0 },
      recycled: { price: 0.03 },
      laminated: { price: 0.035 },
      jute: { price: 0.04 },
      gold: { price: 0.045 },
    },
    attachFeePerTag: 1.015,
    discounts: [
      { minQty: 2000, mult: 0.75 },
      { minQty: 1000, mult: 0.83 },
      { minQty: 500, mult: 0.88 },
      { minQty: 250, mult: 0.93 },
      { minQty: 0, mult: 1.0 },
    ],
  };

  const areaCm2 = (toNumber(width) * toNumber(height)) / 100;

  const basePerCm2 =
    PRICING.baseRatePerCm2?.[tagType]?.[material] ??
    PRICING.baseRatePerCm2?.standard?.standard ??
    0.012;

  let unit = basePerCm2 * areaCm2;

  unit *= 1 + (PRICING.tagTypeUplift?.[tagType] ?? 0);
  unit *= 1 + (PRICING.sidesUplift?.[sides] ?? 0);

  if (shape === "custom") {
    unit *= 1 + PRICING.customShapeUplift;
  }

  if (corner && PRICING.cornerUplift?.[corner] != null) {
    unit *= 1 + PRICING.cornerUplift[corner];
  }

  if (corner === "rounded" && cornerR != null) {
    unit += toNumber(cornerR) * PRICING.roundedRadiusPerMm;
  }

  if (
    PRICING.holeSurcharge.enabled &&
    toNumber(holeMM) >= PRICING.holeSurcharge.mmAtOrAbove
  ) {
    unit += PRICING.holeSurcharge.addPerTag;
  }

  unit += PRICING.cords?.[cord]?.price ?? 0;

  if (cord !== "none" && supply === "attached") {
    unit += PRICING.attachFeePerTag;
  }

  const discountMultiplier =
    PRICING.discounts.find((d) => qty >= d.minQty)?.mult ?? 1;

  const totalBeforeMinimum = unit * qty * discountMultiplier;
  const finalTotal = Math.max(totalBeforeMinimum, PRICING.minOrderTotal);

  console.log("[Pricing] breakdown:", {
    width,
    height,
    qty,
    material,
    tagType,
    shape,
    sides,
    holeMM,
    corner,
    cornerR,
    cord,
    supply,
    areaCm2: Number(areaCm2.toFixed(2)),
    basePerCm2,
    unitBeforeDiscount: Number(unit.toFixed(4)),
    discountMultiplier,
    totalBeforeMinimum: Number(totalBeforeMinimum.toFixed(2)),
    finalTotal: Number(finalTotal.toFixed(2)),
  });

  return Number(finalTotal.toFixed(2));
}

// ---------------------------------------------------------------------
// Shopify helpers
// ---------------------------------------------------------------------
async function getAllVariants(productId) {
  try {
    const r = await axios.get(
      `${SHOPIFY_API_URL}/products/${productId}/variants.json?limit=250`,
      { headers: SHOPIFY_HEADERS }
    );
    return r.data.variants || [];
  } catch (err) {
    console.error("❌ Error fetching variants:", err.response?.data || err.message);
    return [];
  }
}

async function deleteVariant(productId, variantId) {
  try {
    await axios.delete(
      `${SHOPIFY_API_URL}/products/${productId}/variants/${variantId}.json`,
      { headers: SHOPIFY_HEADERS }
    );
    console.log(`🗑️ Deleted variant ${variantId}`);
  } catch (err) {
    console.error("❌ Error deleting variant:", err.response?.data || err.message);
  }
}

async function ensureVariantCapacity(productId) {
  const variants = await getAllVariants(productId);

  const dynamicVariants = variants
    .filter((v) => String(v.sku || "").startsWith(DYNAMIC_SKU_PREFIX))
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  if (dynamicVariants.length < MAX_DYNAMIC_VARIANTS) return;

  const oldestDynamic = dynamicVariants[0];
  if (!oldestDynamic) return;

  console.log(`⚠️ Deleting oldest dynamic variant to stay under limit: ${oldestDynamic.id}`);
  await deleteVariant(productId, oldestDynamic.id);
}

async function createMetafields(variantId, { price, configCode, configJson }) {
  const metafields = [
    {
      namespace: "custom",
      key: "dynamic_price",
      value: price.toFixed(2),
      type: "single_line_text_field",
    },
    {
      namespace: "custom",
      key: "config_code",
      value: configCode,
      type: "single_line_text_field",
    },
    {
      namespace: "custom",
      key: "config_json",
      value: JSON.stringify(configJson),
      type: "json",
    },
  ];

  try {
    for (const metafield of metafields) {
      await axios.post(
        `${SHOPIFY_API_URL}/variants/${variantId}/metafields.json`,
        { metafield },
        { headers: SHOPIFY_HEADERS }
      );
    }
    console.log(`✅ Metafields created for variant ${variantId}`);
  } catch (err) {
    console.error("❌ Error creating metafields:", err.response?.data || err.message);
  }
}

async function createVariant(productId, { width, height, material, price, configCode, configJson }) {
  await ensureVariantCapacity(productId);

  const code = shortCode(6);
  const sku = `${DYNAMIC_SKU_PREFIX}${code}`;
  const option1 = `${width}x${height} - ${material} - ${code}`;

  const payload = {
    variant: {
      option1,
      sku,
      price: price.toFixed(2),
      inventory_management: null,
      inventory_policy: "continue",
      fulfillment_service: "manual",
      taxable: true,
    },
  };

  try {
    const r = await axios.post(
      `${SHOPIFY_API_URL}/products/${productId}/variants.json`,
      payload,
      { headers: SHOPIFY_HEADERS }
    );

    const variant = r.data.variant;
    console.log("✅ Variant created:", variant.id, option1, sku);

    await createMetafields(variant.id, {
      price,
      configCode,
      configJson,
    });

    return variant;
  } catch (err) {
    console.error("❌ Error creating variant:", err.response?.data || err.message);
    return null;
  }
}

// ---------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------
app.post("/create-variant", async (req, res) => {
  try {
    const {
      width,
      height,
      material = "standard",
      product_id,
      qty = 1,
      config = {},
    } = req.body || {};

    if (!product_id || !width || !height) {
      return res
        .status(400)
        .json({ success: false, error: "Missing width/height/product_id" });
    }

    const cleanConfig = {
      material: material || "standard",
      tagType: config.tagType ?? "standard",
      shape: config.shape ?? "rect",
      sides: config.sides ?? "single",
      holeMM: config.holeMM != null ? toNumber(config.holeMM, 5) : 5,
      corner: config.corner ?? null,
      cornerR: config.cornerR != null ? toNumber(config.cornerR, 0) : null,
      cord: config.cord ?? "none",
      supply: config.cordSupply ?? "loose",
    };

    console.log("[/create-variant] Incoming:", {
      product_id,
      width,
      height,
      qty,
      ...cleanConfig,
    });

    const price = calculateCfgPrice({
      width: toNumber(width),
      height: toNumber(height),
      qty: toNumber(qty, 1),
      ...cleanConfig,
    });

    console.log("[/create-variant] Calculated price:", price);

    const configCode = buildConfigCode(cleanConfig);
    console.log("[/create-variant] Config code:", configCode);

    const variant = await createVariant(product_id, {
      width: toNumber(width),
      height: toNumber(height),
      material,
      price,
      configCode,
      configJson: {
        width: toNumber(width),
        height: toNumber(height),
        qty: toNumber(qty, 1),
        ...cleanConfig,
      },
    });

    if (!variant?.id) {
      return res
        .status(500)
        .json({ success: false, error: "Failed to create variant" });
    }

    return res.json({
      success: true,
      variant_id: variant.id,
      price,
      sku: variant.sku,
      title: variant.title,
    });
  } catch (err) {
    console.error("❌ Error in /create-variant:", err.response?.data || err.message);
    return res.status(500).json({
      success: false,
      error: "Internal Server Error",
    });
  }
});

app.get("/test", (req, res) => {
  res.json({ success: true, message: "CORS OK" });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});