require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// ✅ Allow only your Shopify store
const allowedOrigins = ["https://www.tagshop.co.uk"];
app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
  credentials: true
}));

// ✅ Manually set CORS headers for preflight requests
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "https://www.tagshop.co.uk");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ✅ Shopify API details
const SHOPIFY_STORE = process.env.SHOPIFY_STORE; // e.g. my-shop.myshopify.com
const ACCESS_TOKEN  = process.env.ACCESS_TOKEN;
const SHOPIFY_API_URL = `https://${SHOPIFY_STORE}/admin/api/2025-01`;

/* -----------------------------------------------------------------------------
   PRICING ENGINE (matches front-end exactly)
----------------------------------------------------------------------------- */
function computePrice(cfg) {
  // Normalize with sensible defaults
  const w       = Number(cfg.w ?? cfg.width ?? 85);
  const h       = Number(cfg.h ?? cfg.height ?? 55);
  const qty     = Math.max(1, Number(cfg.qty ?? 1));           // whole order qty
  const sides   = (cfg.sides || "single");                     // 'single' | 'double'
  const holeMM  = Number(cfg.holeMM ?? 5);                     // hole diameter
  const corner  = (cfg.corner || "rounded");                   // 'rounded' | 'square' | 'luggage'
  const cornerR = Number(cfg.cornerR ?? 2);                    // mm radius when rounded
  const cord    = (cfg.cord || "none");                        // 'none' | other cord types
  const supply  = (cfg.supply || "loose");                     // 'loose' | 'attached'

  // area: mm × mm -> cm²
  const areaCm2 = (w * h) / 100;

  // Base unit scales with area
  let unit = 0.012 * areaCm2;

  // Double-sided adds 12%
  if (sides === "double") unit *= 1.12;

  // Large hole surcharge
  if (holeMM >= 7) unit += 0.002;

  // Corner surcharges
  if (corner === "rounded") unit += cornerR * 0.0007;
  if (corner === "luggage") unit += 0.01;

  // Cords
  if (cord !== "none") {
    unit += 0.02;
    if (supply === "attached") unit += 0.01;
  }

  // Quantity discount tiers
  let disc = 1;
  if (qty >= 250)  disc = 0.93;
  if (qty >= 500)  disc = 0.88;
  if (qty >= 1000) disc = 0.83;

  const total = unit * qty * disc;

  // Minimum order total
  return Math.max(total, 8.50);
}

/* -----------------------------------------------------------------------------
   REQUEST NORMALIZER (supports old & new payloads)
----------------------------------------------------------------------------- */
// Accepts either:
// - { width, height, material, qty? }  (legacy)
// - { config: { w,h,qty,sides,holeMM,corner,cornerR,cord,supply,material } } (new)
function normalizeConfigFromBody(body) {
  if (body && body.config && typeof body.config === "object") {
    return {
      w:        body.config.w,
      h:        body.config.h,
      qty:      body.config.qty,
      sides:    body.config.sides,
      holeMM:   body.config.holeMM,
      corner:   body.config.corner,
      cornerR:  body.config.cornerR,
      cord:     body.config.cord,
      supply:   body.config.supply,
      material: body.config.material || "standard",
    };
  }
  // Legacy fallback
  return {
    w: Number(body.width),
    h: Number(body.height),
    qty: Number(body.qty ?? 1),
    sides: "single",
    holeMM: 5,
    corner: "rounded",
    cornerR: 2,
    cord: "none",
    supply: "loose",
    material: body.material || "standard",
  };
}

/* -----------------------------------------------------------------------------
   SHOPIFY HELPERS
----------------------------------------------------------------------------- */

// Oldest variant (for rotation / cleanup)
async function getOldestVariant(product_id) {
  try {
    const resp = await axios.get(
      `${SHOPIFY_API_URL}/products/${product_id}/variants.json?limit=1`,
      { headers: { "X-Shopify-Access-Token": ACCESS_TOKEN } }
    );
    return resp.data.variants[0] || null;
  } catch (error) {
    console.error("❌ Error fetching oldest variant:", error.response?.data || error.message);
    return null;
  }
}

// Ensure we’re under variant limit by deleting the oldest
async function ensureVariantLimit(product_id) {
  try {
    const oldest = await getOldestVariant(product_id);
    if (oldest) {
      console.log(`⚠️ Deleting oldest variant: ${oldest.id}`);
      await axios.delete(
        `${SHOPIFY_API_URL}/products/${product_id}/variants/${oldest.id}.json`,
        { headers: { "X-Shopify-Access-Token": ACCESS_TOKEN } }
      );
      console.log(`🗑️ Deleted variant ID: ${oldest.id}`);
    }
  } catch (error) {
    console.error("❌ Error deleting variant:", error.response?.data || error.message);
  }
}

// Try to find an existing variant by exact option1 title
async function findExistingVariantByTitle(product_id, optionTitle) {
  try {
    // Pull first 100. (If you expect >100, add pagination here.)
    const resp = await axios.get(
      `${SHOPIFY_API_URL}/products/${product_id}/variants.json?limit=100`,
      { headers: { "X-Shopify-Access-Token": ACCESS_TOKEN } }
    );
    const variants = resp.data.variants || [];
    return variants.find(v => v.option1 === optionTitle) || null;
  } catch (error) {
    console.error("❌ Error finding variant:", error.response?.data || error.message);
    return null;
  }
}

// Create a metafield on a variant (stores computed total)
async function createMetafield(variant_id, price) {
  try {
    const resp = await axios.post(
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
    console.log("✅ Metafield Created:", resp.data.metafield?.id);
  } catch (error) {
    console.error("❌ Error creating metafield:", error.response?.data || error.message);
  }
}

// Create a variant (option1 contains a descriptive, deterministic title)
async function createVariant(product_id, optionTitle, price) {
  // fire-and-forget cleanup
  ensureVariantLimit(product_id);

  const variantData = {
    variant: {
      option1: optionTitle,
      price: price.toFixed(2),
      inventory_management: null,
      inventory_policy: "continue",
      fulfillment_service: "manual",
    }
  };

  try {
    const resp = await axios.post(
      `${SHOPIFY_API_URL}/products/${product_id}/variants.json`,
      variantData,
      { headers: { "X-Shopify-Access-Token": ACCESS_TOKEN } }
    );
    const variant = resp.data.variant;
    console.log("✅ Variant Created:", variant.id);

    await createMetafield(variant.id, price);
    return variant;
  } catch (error) {
    console.error("❌ Error creating variant:", error.response?.data || error.message);
    return null;
  }
}

/* -----------------------------------------------------------------------------
   API
----------------------------------------------------------------------------- */

app.post("/create-variant", async (req, res) => {
  try {
    const { product_id } = req.body;
    if (!product_id) {
      return res.status(400).json({ error: "Missing product_id" });
    }

    // Build a normalized configurator object
    const cfg = normalizeConfigFromBody(req.body);
    const price = computePrice(cfg);

    // Descriptive option title to prevent collisions
    // Example: "85x55 - standard - single - hole 5mm - rounded 2mm - cord none"
    const optionTitle = [
      `${cfg.w}x${cfg.h}`,
      cfg.material || "standard",
      cfg.sides || "single",
      `hole ${cfg.holeMM ?? 5}mm`,
      cfg.corner === "rounded" ? `rounded ${cfg.cornerR ?? 2}mm` : (cfg.corner || "square"),
      `cord ${cfg.cord || "none"}${cfg.cord && cfg.cord !== "none" ? ` (${cfg.supply || "loose"})` : ""}`
    ].join(" - ");

    // Reuse existing variant when possible
    let variant = await findExistingVariantByTitle(product_id, optionTitle);

    if (!variant) {
      variant = await createVariant(product_id, optionTitle, price);
    }

    if (!variant || !variant.id) {
      return res.status(500).json({ error: "Failed to create or find variant" });
    }

    res.json({ success: true, variant_id: variant.id, price: Number(price.toFixed(2)) });
  } catch (error) {
    console.error("❌ Error in /create-variant:", error.response?.data || error.message);
    res.status(500).json({ error: "Internal Server Error", details: error.message });
  }
});

// ✅ Simple test route
app.get("/test", (req, res) => {
  res.json({ success: true, message: "CORS is working!" });
});

// 🚀 Start server
app.listen(PORT, () => {
  console.log(`🚀 Shopify app running on port ${PORT}`);
});