require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");

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

// ---------------------------------------------------------------------
// Pricing config - MUST match frontend
// ---------------------------------------------------------------------
const TAGCFG_PRICING = {
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

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------
function roundMoney(n) {
  return Number((Math.round(n * 100) / 100).toFixed(2));
}

function createConfigCode({
  tagType = "standard",
  material = "standard",
  shape = "rect",
  sides = "single",
  holeMM = 0,
  corner = "none",
  cornerR = 0,
  cord = "none",
  supply = "loose",
}) {
  const parts = [
    `TT-${String(tagType).slice(0, 3).toUpperCase()}`,
    `MAT-${String(material).slice(0, 3).toUpperCase()}`,
    `SH-${String(shape).slice(0, 3).toUpperCase()}`,
    `SI-${String(sides).slice(0, 3).toUpperCase()}`,
    `HO-${String(holeMM).replace(/[^0-9.]/g, "") || "0"}`,
    `CO-${String(corner).slice(0, 3).toUpperCase()}`,
    `CR-${cornerR ?? 0}`,
    `CD-${String(cord).slice(0, 3).toUpperCase()}`,
    `SUP-${String(supply).slice(0, 3).toUpperCase()}`,
  ];

  return parts.join("_");
}

function createUniqueSuffix() {
  const ts = Date.now().toString(36).toUpperCase();
  const rnd = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${ts}-${rnd}`;
}

// ---------------------------------------------------------------------
// Pricing — mirrors frontend price(c)
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

  const P = TAGCFG_PRICING;

  const areaCm2 = (Number(width) * Number(height)) / 100;

  const basePerCm2 =
    P.baseRatePerCm2?.[tagType]?.[material] ??
    P.baseRatePerCm2?.standard?.standard ??
    0;

  let unit = basePerCm2 * areaCm2;

  unit *= 1 + (P.tagTypeUplift?.[tagType] ?? 0);
  unit *= 1 + (P.sidesUplift?.[sides] ?? 0);

  if (shape === "custom") {
    unit *= 1 + (P.customShapeUplift ?? 0);
  }

  if (corner && P.cornerUplift?.[corner] != null) {
    unit *= 1 + P.cornerUplift[corner];
  }

  if (corner === "rounded" && (P.roundedRadiusPerMm || 0) > 0) {
    unit += Number(cornerR || 0) * P.roundedRadiusPerMm;
  }

  if (P.holeSurcharge?.enabled && Number(holeMM || 0) >= (P.holeSurcharge.mmAtOrAbove || 7)) {
    unit += P.holeSurcharge.addPerTag || 0;
  }

  unit += P.cords?.[cord]?.price ?? 0;

  if (cord !== "none" && supply === "attached") {
    unit += P.attachFeePerTag ?? 0;
  }

  const discMult =
    (P.discounts || []).find((d) => Number(qty) >= d.minQty)?.mult ?? 1;

  const total = unit * Number(qty) * discMult;
  const finalTotal = Math.max(total, P.minOrderTotal ?? 0);

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
    areaCm2: roundMoney(areaCm2),
    basePerCm2,
    unitBeforeDiscount: roundMoney(unit),
    discountMultiplier: discMult,
    totalBeforeMinimum: roundMoney(total),
    finalTotal: roundMoney(finalTotal),
  });

  return roundMoney(finalTotal);
}

// ---------------------------------------------------------------------
// Shopify helpers
// ---------------------------------------------------------------------
async function getOldestVariant(product_id) {
  try {
    const r = await axios.get(
      `${SHOPIFY_API_URL}/products/${product_id}/variants.json?limit=1&order=created_at asc`,
      {
        headers: {
          "X-Shopify-Access-Token": ACCESS_TOKEN,
        },
      }
    );
    return r.data.variants?.[0] || null;
  } catch (err) {
    console.error("❌ Error fetching oldest variant:", err.response?.data || err.message);
    return null;
  }
}

async function ensureVariantLimit(product_id) {
  try {
    const oldest = await getOldestVariant(product_id);
    if (oldest) {
      console.log(`⚠️ Deleting oldest variant to stay under limits: ${oldest.id}`);
      await axios.delete(
        `${SHOPIFY_API_URL}/products/${product_id}/variants/${oldest.id}.json`,
        {
          headers: {
            "X-Shopify-Access-Token": ACCESS_TOKEN,
          },
        }
      );
      console.log(`🗑️ Deleted variant ${oldest.id}`);
    }
  } catch (err) {
    console.error("❌ Error deleting variant:", err.response?.data || err.message);
  }
}

async function createMetafield(variant_id, price, configCode) {
  try {
    await axios.post(
      `${SHOPIFY_API_URL}/variants/${variant_id}/metafields.json`,
      {
        metafield: {
          namespace: "custom",
          key: "dynamic_price",
          value: price.toFixed(2),
          type: "string",
        },
      },
      {
        headers: {
          "X-Shopify-Access-Token": ACCESS_TOKEN,
          "Content-Type": "application/json",
        },
      }
    );

    await axios.post(
      `${SHOPIFY_API_URL}/variants/${variant_id}/metafields.json`,
      {
        metafield: {
          namespace: "custom",
          key: "config_code",
          value: configCode,
          type: "single_line_text_field",
        },
      },
      {
        headers: {
          "X-Shopify-Access-Token": ACCESS_TOKEN,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("✅ Metafields created for variant", variant_id);
  } catch (err) {
    console.error("❌ Error creating metafield:", err.response?.data || err.message);
  }
}

async function createVariant({
  product_id,
  width,
  height,
  material,
  price,
  configCode,
}) {
  ensureVariantLimit(product_id).catch(() => {});

  const uniqueSuffix = createUniqueSuffix();
  const optionTitle = `${width}x${height} - ${material} - ${configCode} - ${uniqueSuffix}`;

  const payload = {
    variant: {
      option1: optionTitle,
      price: price.toFixed(2),
      inventory_management: null,
      inventory_policy: "continue",
      fulfillment_service: "manual",
      sku: `TAGCFG-${uniqueSuffix}`,
    },
  };

  try {
    const r = await axios.post(
      `${SHOPIFY_API_URL}/products/${product_id}/variants.json`,
      payload,
      {
        headers: {
          "X-Shopify-Access-Token": ACCESS_TOKEN,
          "Content-Type": "application/json",
        },
      }
    );

    const variant = r.data.variant;
    console.log("✅ Variant created:", variant.id, optionTitle);

    await createMetafield(variant.id, price, configCode);

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
      return res.status(400).json({
        success: false,
        error: "Missing width/height/product_id",
      });
    }

    const parsed = {
      width: Number(width),
      height: Number(height),
      qty: Number(qty) || 1,
      material: material ?? "standard",
      tagType: config.tagType ?? "standard",
      shape: config.shape ?? "rect",
      sides: config.sides ?? "single",
      holeMM: config.holeMM != null ? Number(config.holeMM) : 5,
      corner: config.corner ?? null,
      cornerR: config.cornerR != null ? Number(config.cornerR) : null,
      cord: config.cord ?? "none",
      supply: config.cordSupply ?? "loose",
    };

    console.log("[/create-variant] Incoming:", {
      product_id,
      ...parsed,
    });

    const price = calculateCfgPrice(parsed);

    const configCode = createConfigCode({
      tagType: parsed.tagType,
      material: parsed.material,
      shape: parsed.shape,
      sides: parsed.sides,
      holeMM: parsed.holeMM,
      corner: parsed.corner || "none",
      cornerR: parsed.cornerR || 0,
      cord: parsed.cord,
      supply: parsed.supply,
    });

    console.log("[/create-variant] Calculated price:", price);
    console.log("[/create-variant] Config code:", configCode);

    const variant = await createVariant({
      product_id,
      width: parsed.width,
      height: parsed.height,
      material: parsed.material,
      price,
      configCode,
    });

    if (!variant?.id) {
      return res.status(500).json({
        success: false,
        error: "Failed to create variant",
      });
    }

    return res.json({
      success: true,
      variant_id: variant.id,
      price,
      config_code: configCode,
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