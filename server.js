// index.js
require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// --- CORS (allow only your storefronts) ---
const allowedOrigins = [
  "https://www.tagshop.co.uk",
  "https://www.stickershop.co.uk",
  "https://stickershop1.myshopify.com",
];
app.use(
  cors({
    origin(origin, cb) {
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error("Not allowed by CORS"));
    },
    credentials: true,
  })
);

// Preflight headers — reflect the actual request origin (must match one we allow)
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
  }
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// --- Shopify setup: TagShop ---
const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const SHOPIFY_API_URL = `https://${SHOPIFY_STORE}/admin/api/2025-01`;

const SHOPIFY_HEADERS = {
  "X-Shopify-Access-Token": ACCESS_TOKEN,
  "Content-Type": "application/json",
};

// --- Shopify setup: StickerShop (legacy custom app, Basic Auth key/secret) ---
const STICKER_STORE = process.env.STICKER_SHOPIFY_STORE;
const STICKER_API_KEY = process.env.STICKER_API_KEY;
const STICKER_API_SECRET = process.env.STICKER_API_SECRET;
const STICKER_API_URL = `https://${STICKER_STORE}/admin/api/2023-07`;
const STICKER_BASIC_AUTH = Buffer.from(`${STICKER_API_KEY}:${STICKER_API_SECRET}`).toString("base64");

const STICKER_HEADERS = {
  Authorization: `Basic ${STICKER_BASIC_AUTH}`,
  "Content-Type": "application/json",
};

// Keep 1 permanent/base variant, allow up to 99 dynamic ones
const MAX_DYNAMIC_VARIANTS = 99;
const DYNAMIC_SKU_PREFIX = "TAGCFG-";
const STICKER_DYNAMIC_SKU_PREFIX = "STKCFG-";

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
// Sticker pricing — ported exactly from the legacy stickershop.co.uk
// ProductBuilder-ProductPage.liquid CalcPrice() formula. Rates/percentages
// come from the product's `custom.sticker_config` metaobject in Shopify
// (fetched server-side below), never trusted from the client.
// ---------------------------------------------------------------------
function calculateStickerPrice({
  width,
  height,
  qty = 1,
  designs = 1,
  isCustomShape = false,
  sqmRate,
  vatMultiplier,
  setupCharge = 0,
  customShapeSurchargePercent = 0,
  suppliedPricePercent = 0,
  whiteInkPricePercent = 0,
  whiteInkSelected = false,
  dieCutSurchargePercent = 0,
  singlesSurchargePercent = 0,
  pricingMode = "",
}) {
  if (!qty || qty < 1) return 0;

  const w = toNumber(width);
  const h = toNumber(height);
  // Stacks with the die-cut add-on below, as on the live material pages.
  const shapeMultiplier = isCustomShape ? 1 + customShapeSurchargePercent / 100 : 1;

  const sqmTerm = sqmRate * (h + 2) * (w + 2) * 0.000001 + 0.005;
  const form100 = (qty * sqmTerm + 15 + 6.95) * vatMultiplier * shapeMultiplier;

  // Live roll labels page: rounded (not up), no per-design or other add-ons.
  if (pricingMode === "roll") {
    const rollTotal = Math.round(form100 + 2) + setupCharge;
    console.log("[Sticker pricing] roll breakdown:", { width: w, height: h, qty, sqmRate, vatMultiplier, rollTotal });
    return Number(rollTotal.toFixed(2));
  }

  const qtyPrice = Math.ceil(form100);
  const priceBeforeExtras = qtyPrice + (toNumber(designs, 1) - 1);

  const suppliedAddon = suppliedPricePercent
    ? Math.ceil(priceBeforeExtras * suppliedPricePercent)
    : 0;

  const dieCutAddon = dieCutSurchargePercent
    ? Math.ceil(priceBeforeExtras * (dieCutSurchargePercent / 100))
    : 0;

  const singlesAddon = singlesSurchargePercent
    ? Math.ceil(priceBeforeExtras * (singlesSurchargePercent / 100))
    : 0;

  const whiteInkAddon =
    whiteInkSelected && whiteInkPricePercent
      ? Math.ceil(priceBeforeExtras * whiteInkPricePercent)
      : 0;

  const finalTotal =
    priceBeforeExtras + suppliedAddon + dieCutAddon + singlesAddon + setupCharge + whiteInkAddon + 2;

  console.log("[Sticker pricing] breakdown:", {
    width: w,
    height: h,
    qty,
    designs,
    isCustomShape,
    sqmRate,
    vatMultiplier,
    setupCharge,
    suppliedAddon,
    dieCutAddon,
    singlesAddon,
    whiteInkAddon,
    finalTotal,
  });

  return Number(finalTotal.toFixed(2));
}

// The configurator's price for a custom-size sticker, resolved from the
// product's sticker_config exactly like the theme's estimatePrice
// (StickerConfig.liquid / cart-quick-edit.js / trade-quick-order.js) and the
// live site's per-product CalcPrice. Returns { price, sqmRate } or null.
function stickerPriceFromConfig(config, { width, height, qty, designs, isCustomShape, options = {} }) {
  const sqmRate =
    findMatrixRate(config.rate_matrix, options.colour || options.material, options.finish) ??
    findOptionRate(config.colour_options, options.colour) ??
    findOptionRate(config.material_options, options.material) ??
    findOptionRate(config.finish_options, options.finish) ??
    (config.base_sqm_rate != null ? Number(config.base_sqm_rate) : null);
  if (sqmRate == null) return null;

  const suppliedPricePercent = findOptionPercent(config.supplied_options, options.supplied) ?? 0;
  const whiteInkAvailable = String(config.white_ink_available) === "true";
  // White ink only where the product offers it for the chosen material
  // (an empty list means every material), as the configurator enforces.
  const whiteInkMaterials = parseList(config.white_ink_materials);
  const whiteInkAllowed =
    whiteInkAvailable && (!whiteInkMaterials.length || whiteInkMaterials.includes(options.material));
  const whiteInkPricePercent =
    whiteInkAllowed && config.white_ink_price_percent != null
      ? Number(config.white_ink_price_percent) / 100
      : 0;

  // Per-option overrides: colour, then material, then finish, then the product.
  const vatMultiplier =
    findOptionNumber(config.colour_options, options.colour, "vat_multiplier_override") ??
    findOptionNumber(config.material_options, options.material, "vat_multiplier_override") ??
    findOptionNumber(config.finish_options, options.finish, "vat_multiplier_override") ??
    Number(config.vat_multiplier);
  const customShapeSurchargePercent =
    findOptionNumber(config.material_options, options.material, "custom_shape_surcharge_override") ??
    Number(config.custom_shape_surcharge_percent || 0);
  const dieCutSurchargePercent =
    findOptionNumber(config.material_options, options.material, "die_cut_surcharge_percent") ?? 0;
  // Live material pages charge +15% for die-cut singles over sheets.
  const singlesSurchargePercent =
    options.supplied_format === "Singles" ? Number(config.singles_surcharge_percent || 0) : 0;

  const price = calculateStickerPrice({
    width,
    height,
    qty,
    designs,
    isCustomShape,
    sqmRate,
    vatMultiplier,
    setupCharge: Number(config.setup_charge || 0),
    customShapeSurchargePercent,
    suppliedPricePercent,
    whiteInkPricePercent,
    whiteInkSelected: !!options.white_ink,
    dieCutSurchargePercent,
    singlesSurchargePercent,
    pricingMode: String(config.pricing_mode || ""),
  });
  return { price, sqmRate };
}

// Pre-cut stock sizes (the Premium Paper page's "browse cheaper pre-cut
// sizes" picker). Priced with the live site's pre-cut formula, ported from the
// live theme's snippets/PaperPricing.liquid (CalcPricePaper), NOT the
// custom-size sqm formula above:
//   units = ceil(((67.67 + qty / labelsPerSheet) * 1.25) + 7)
//   price = units * unitRate
// unitRate was the per-finish variant price on the old per-size products
// (0.28 Matt/Uncoated, 0.34 Gloss) and now lives on each finish option as
// precut_unit_rate. The size table is sticker_config.precut_sizes, a list of
// "Label|Shape|Width|Height|PerSheet|ImageURL" strings generated by the
// theme's scripts/sticker-config/generate-precut-paper-sizes.mjs.
const PRECUT_FORMULA = { baseUnits: 67.67, multiplier: 1.25, extraUnits: 7 };

function calculatePrecutPrice({ qty = 1, perSheet, unitRate }) {
  const q = toNumber(qty, 1);
  if (q < 1 || !perSheet || unitRate == null) return 0;
  const units = Math.ceil(
    (PRECUT_FORMULA.baseUnits + q / perSheet) * PRECUT_FORMULA.multiplier + PRECUT_FORMULA.extraUnits
  );
  const finalTotal = Math.round(units * unitRate * 100) / 100;
  console.log("[Pre-cut pricing] breakdown:", { qty: q, perSheet, unitRate, units, finalTotal });
  return finalTotal;
}

function parsePrecutSizes(config) {
  let raw = config?.precut_sizes;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = [];
    }
  }
  if (!Array.isArray(raw)) return [];
  return raw
    .map((line) => {
      const [label, shape, width, height, perSheet] = String(line).split("|");
      return {
        label: (label || "").trim(),
        shape: (shape || "").trim(),
        width: toNumber(width),
        height: toNumber(height),
        perSheet: toNumber(perSheet),
      };
    })
    .filter((p) => p.label && p.width > 0 && p.height > 0 && p.perSheet > 0);
}

function findOptionNumber(options, value, key) {
  if (!options || !value) return null;
  const match = options.find((o) => o.value === value);
  if (!match || match[key] == null || match[key] === "") return null;
  return Number(match[key]);
}

// Fetch a product's sticker_config metaobject (with its option lists resolved)
// via GraphQL, using the StickerShop store's Basic Auth credentials.
async function fetchStickerConfig(productId) {
  const gid = `gid://shopify/Product/${productId}`;
  const query = `
    query($id: ID!) {
      product(id: $id) {
        metafield(namespace: "custom", key: "sticker_config") {
          value
          reference {
            ... on Metaobject {
              fields {
                key
                value
                references(first: 20) {
                  nodes {
                    ... on Metaobject {
                      id
                      fields { key value }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;
  const res = await axios.post(
    `${STICKER_API_URL}/graphql.json`,
    { query, variables: { id: gid } },
    { headers: STICKER_HEADERS }
  );
  if (res.data.errors) {
    throw new Error(`GraphQL error fetching sticker_config: ${JSON.stringify(res.data.errors)}`);
  }
  const ref = res.data.data?.product?.metafield?.reference;
  if (!ref) return null;

  const config = {};
  for (const f of ref.fields) {
    if (f.references) {
      config[f.key] = f.references.nodes.map((n) => {
        const opt = {};
        for (const of of n.fields) opt[of.key] = of.value;
        return opt;
      });
    } else {
      config[f.key] = f.value;
    }
  }
  return config;
}

function findOptionRate(options, value) {
  if (!options || !value) return null;
  const match = options.find((o) => o.value === value);
  if (!match) return null;
  if (match.sqm_rate_override != null) return Number(match.sqm_rate_override);
  return null;
}

// For products where the rate depends on TWO selections together (e.g. Paper
// Foil: colour x finish) rather than a single option's own override.
function findMatrixRate(matrix, colourValue, finishValue) {
  if (!Array.isArray(matrix) || !colourValue || !finishValue) return null;
  const match = matrix.find(
    (m) => m.colour_value === colourValue && m.finish_value === finishValue
  );
  return match ? Number(match.sqm_rate) : null;
}

// A list field (e.g. white_ink_materials) arrives as a JSON string.
function parseList(value) {
  if (Array.isArray(value)) return value;
  if (value == null || value === "") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [String(parsed)];
  } catch (e) {
    return [String(value)];
  }
}

function findOptionPercent(options, value) {
  if (!options || !value) return null;
  const match = options.find((o) => o.value === value);
  if (!match || match.price_percent == null) return null;
  return Number(match.price_percent);
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
// Sticker Shopify helpers (StickerShop store — separate credentials)
// ---------------------------------------------------------------------
async function getAllStickerVariants(productId) {
  try {
    const r = await axios.get(
      `${STICKER_API_URL}/products/${productId}/variants.json?limit=250`,
      { headers: STICKER_HEADERS }
    );
    return r.data.variants || [];
  } catch (err) {
    console.error("❌ Error fetching sticker variants:", err.response?.data || err.message);
    return [];
  }
}

async function deleteStickerVariant(productId, variantId) {
  try {
    await axios.delete(
      `${STICKER_API_URL}/products/${productId}/variants/${variantId}.json`,
      { headers: STICKER_HEADERS }
    );
    console.log(`🗑️ Deleted sticker variant ${variantId}`);
  } catch (err) {
    console.error("❌ Error deleting sticker variant:", err.response?.data || err.message);
  }
}

async function ensureStickerVariantCapacity(productId) {
  const variants = await getAllStickerVariants(productId);

  const dynamicVariants = variants
    .filter((v) => String(v.sku || "").startsWith(STICKER_DYNAMIC_SKU_PREFIX))
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  if (dynamicVariants.length < MAX_DYNAMIC_VARIANTS) return;

  const oldestDynamic = dynamicVariants[0];
  if (!oldestDynamic) return;

  console.log(`⚠️ Deleting oldest dynamic sticker variant to stay under limit: ${oldestDynamic.id}`);
  await deleteStickerVariant(productId, oldestDynamic.id);
}

async function createStickerMetafields(variantId, { price, configJson }) {
  const metafields = [
    {
      namespace: "custom",
      key: "dynamic_price",
      value: price.toFixed(2),
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
        `${STICKER_API_URL}/variants/${variantId}/metafields.json`,
        { metafield },
        { headers: STICKER_HEADERS }
      );
    }
    console.log(`✅ Metafields created for sticker variant ${variantId}`);
  } catch (err) {
    console.error("❌ Error creating sticker variant metafields:", err.response?.data || err.message);
  }
}

async function createStickerVariant(productId, { width, height, shape, price, configJson }) {
  await ensureStickerVariantCapacity(productId);

  const code = shortCode(6);
  const sku = `${STICKER_DYNAMIC_SKU_PREFIX}${code}`;
  const option1 = `${width}x${height}mm - ${shape} - ${code}`;

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
      `${STICKER_API_URL}/products/${productId}/variants.json`,
      payload,
      { headers: STICKER_HEADERS }
    );

    const variant = r.data.variant;
    console.log("✅ Sticker variant created:", variant.id, option1, sku);

    await createStickerMetafields(variant.id, { price, configJson });

    return variant;
  } catch (err) {
    console.error("❌ Error creating sticker variant:", err.response?.data || err.message);
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

// Sticker equivalent of /create-variant. Client sends the SELECTED option
// VALUES only (never rates/prices) — this route looks up the product's real
// sticker_config metaobject in Shopify and computes price server-side, so a
// tampered client request can't change what gets charged.
// Prices one custom-size or pre-cut sticker line from the product's
// sticker_config. Shared by /create-sticker-variant (the site) and
// /price-sticker (the trade API's quotes), so both always agree.
// Returns { ok: true, ... } or { ok: false, status, error }.
async function priceStickerRequest(body) {
  const {
    product_id,
    width,
    height,
    qty = 1,
    designs = 1,
    shape = "Square",
    options = {},
  } = body || {};

  if (!product_id || !width || !height) {
    return { ok: false, status: 400, error: "Missing width/height/product_id" };
  }

  const config = await fetchStickerConfig(product_id);
  if (!config) {
    return { ok: false, status: 404, error: "No sticker_config found for this product" };
  }

  const isCustomShape = shape === "Custom";

  // Pre-cut stock size (Premium Paper): the size's own dimensions and
  // labels-per-sheet come from the product's config - never from the
  // client - and it is priced with the pre-cut formula instead.
  let precut = null;
  let precutUnitRate = null;
  if (options.precut) {
    precut = parsePrecutSizes(config).find((p) => p.label === String(options.precut)) || null;
    if (!precut) {
      return { ok: false, status: 400, error: `Unknown pre-cut size '${options.precut}' for this product` };
    }
    precutUnitRate = findOptionNumber(config.finish_options, options.finish, "precut_unit_rate");
    if (precutUnitRate == null) {
      return { ok: false, status: 500, error: "No pre-cut unit rate is configured for the selected finish" };
    }
  }

  let sqmRate = null;
  let custom = null;
  if (!precut) {
    custom = stickerPriceFromConfig(config, {
      width: toNumber(width),
      height: toNumber(height),
      qty: toNumber(qty, 1),
      designs: toNumber(designs, 1),
      isCustomShape,
      options,
    });
    if (!custom) {
      return { ok: false, status: 500, error: "Could not resolve an SQM rate for this product/option combination" };
    }
    sqmRate = custom.sqmRate;
  }

  const effectiveWidth = precut ? precut.width : toNumber(width);
  const effectiveHeight = precut ? precut.height : toNumber(height);
  const effectiveShape = precut ? precut.shape : shape;
  const pricing = precut ? "precut" : "custom";

  const price = precut
    ? calculatePrecutPrice({
        qty: toNumber(qty, 1),
        perSheet: precut.perSheet,
        unitRate: precutUnitRate,
      })
    : custom.price;

  return {
    ok: true,
    product_id,
    price,
    pricing,
    sqmRate,
    precut,
    precutUnitRate,
    width: effectiveWidth,
    height: effectiveHeight,
    shape: effectiveShape,
    qty: toNumber(qty, 1),
    designs: toNumber(designs, 1),
    options,
  };
}

// The options a product can be ordered with (for the trade API's product
// list): read from sticker_config like the pricing, rates left out.
app.get("/sticker-options/:product_id", async (req, res) => {
  try {
    const config = await fetchStickerConfig(req.params.product_id);
    if (!config) return res.status(404).json({ success: false, error: "No sticker_config found for this product" });
    const opts = (list) => (Array.isArray(list) ? list : [])
      .filter((o) => o && o.value)
      .map((o) => ({ value: o.value, label: o.label || o.value }));
    return res.json({
      success: true,
      shapes: parseList(config.shapes),
      size_max_mm: config.size_max_mm != null ? Number(config.size_max_mm) : null,
      finishes: opts(config.finish_options),
      materials: opts(config.material_options),
      colours: opts(config.colour_options),
      adhesives: opts(config.adhesive_options),
      white_ink: config.white_ink_available === "true" || config.white_ink_available === true,
      pricing_mode: config.pricing_mode || null,
    });
  } catch (err) {
    console.error("❌ Error in /sticker-options:", err.response?.data || err.message);
    return res.status(500).json({ success: false, error: "Internal Server Error" });
  }
});

// Price only - creates nothing in Shopify. Used by the trade API for quotes.
app.post("/price-sticker", async (req, res) => {
  try {
    const r = await priceStickerRequest(req.body);
    if (!r.ok) return res.status(r.status).json({ success: false, error: r.error });
    return res.json({
      success: true,
      price: r.price,
      pricing: r.pricing,
      width: r.width,
      height: r.height,
      shape: r.shape,
    });
  } catch (err) {
    console.error("❌ Error in /price-sticker:", err.response?.data || err.message);
    return res.status(500).json({ success: false, error: "Internal Server Error" });
  }
});

app.post("/create-sticker-variant", async (req, res) => {
  try {
    const r = await priceStickerRequest(req.body);
    if (!r.ok) return res.status(r.status).json({ success: false, error: r.error });
    const { product_id, price, pricing, sqmRate, precut, precutUnitRate } = r;

    console.log("[/create-sticker-variant] Incoming:", {
      ...req.body,
      pricing,
      resolvedSqmRate: sqmRate,
      precut,
    });
    console.log("[/create-sticker-variant] Calculated price:", price);

    const variant = await createStickerVariant(product_id, {
      width: r.width,
      height: r.height,
      shape: precut ? `${r.shape} Pre-cut` : r.shape,
      price,
      configJson: {
        width: r.width,
        height: r.height,
        qty: r.qty,
        designs: r.designs,
        shape: r.shape,
        options: r.options,
        pricing,
        resolvedSqmRate: sqmRate,
        precut: precut
          ? { label: precut.label, perSheet: precut.perSheet, unitRate: precutUnitRate }
          : null,
      },
    });

    if (!variant?.id) {
      return res
        .status(500)
        .json({ success: false, error: "Failed to create sticker variant" });
    }

    return res.json({
      success: true,
      variant_id: variant.id,
      price,
      pricing,
      sku: variant.sku,
      title: variant.title,
    });
  } catch (err) {
    console.error("❌ Error in /create-sticker-variant:", err.response?.data || err.message);
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