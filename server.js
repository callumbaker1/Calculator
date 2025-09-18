// server/index.js
require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// --- CORS --------------------------------------------------------------------
const allowedOrigins = ["https://www.tagshop.co.uk"];
app.use(
  cors({
    origin(origin, cb) {
      if (!origin || allowedOrigins.includes(origin)) cb(null, true);
      else cb(new Error("Not allowed by CORS"));
    },
    credentials: true,
  })
);

// Preflight
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "https://www.tagshop.co.uk");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// --- Shopify -----------------------------------------------------------------
const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const SHOPIFY_API_URL = `https://${SHOPIFY_STORE}/admin/api/2025-01`;

// --- Pricing (mirror of client price(c)) -------------------------------------
/**
 * cfg fields expected (all optional; sensible defaults applied):
 *  - w, h: numbers in mm
 *  - qty: integer
 *  - sides: 'single' | 'double'
 *  - holeMM: number (mm)
 *  - corner: 'rounded' | 'square' | 'luggage'
 *  - cornerR: number (mm radius, if rounded)
 *  - cord: 'none' | ...
 *  - supply: 'loose' | 'attached'  (applies only if cord !== 'none')
 */
function calculatePrice(cfg = {}) {
  const w = Number(cfg.w) || 85;
  const h = Number(cfg.h) || 55;
  const qty = Math.max(0, parseInt(cfg.qty, 10) || 0);

  if (!qty) {
    // If qty is missing/0, return the floor right away (matches client behavior of showing £8.50)
    return 8.5;
  }

  const sides = cfg.sides || "single";
  const holeMM = Number(cfg.holeMM) || 5;
  const corner = cfg.corner || "rounded";
  const cornerR = Number(cfg.cornerR) || 2;
  const cord = cfg.cord || "none";
  const supply = cfg.supply || "loose";

  // Area in cm² (mm² / 100)
  const areaCm2 = (w * h) / 100;

  // Base unit price scales with area
  let unit = 0.012 * areaCm2;

  // Double-sided adds 12%
  if (sides === "double") unit *= 1.12;

  // Larger hole surcharge (7mm+)
  if (holeMM >= 7) unit += 0.002;

  // Rounded corners add based on radius; luggage flat add
  if (corner === "rounded") unit += cornerR * 0.0007;
  if (corner === "luggage") unit += 0.01;

  // Cords & attachment
  if (cord !== "none") {
    unit += 0.02;
    if (supply === "attached") unit += 0.01;
  }

  // Quantity discount tiers
  let disc = 1;
  if (qty >= 250) disc = 0.93;
  if (qty >= 500) disc = 0.88;
  if (qty >= 1000) disc = 0.83;

  const total = unit * qty * disc;
  return Math.max(total, 8.5);
}

// --- Shopify helpers ---------------------------------------------------------
async function getOldestVariant(product_id) {
  try {
    const r = await axios.get(
      `${SHOPIFY_API_URL}/products/${product_id}/variants.json?limit=1`,
      { headers: { "X-Shopify-Access-Token": ACCESS_TOKEN } }
    );
    return r.data.variants[0] || null;
  } catch (err) {
    console.error("❌ Error fetching oldest variant:", err.response?.data || err.message);
    return null;
  }
}

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
  } catch (err) {
    console.error("❌ Error deleting variant:", err.response?.data || err.message);
  }
}

async function findExistingVariant(product_id, title) {
  try {
    const r = await axios.get(
      `${SHOPIFY_API_URL}/products/${product_id}/variants.json?limit=100`,
      { headers: { "X-Shopify-Access-Token": ACCESS_TOKEN } }
    );
    return r.data.variants.find((v) => v.option1 === title) || null;
  } catch (err) {
    console.error("❌ Error finding variant:", err.response?.data || err.message);
    return null;
  }
}

async function createMetafield(variant_id, price) {
  try {
    const r = await axios.post(
      `${SHOPIFY_API_URL}/variants/${variant_id}/metafields.json`,
      {
        metafield: {
          namespace: "custom",
          key: "dynamic_price",
          value: Number(price).toFixed(2),
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
    console.log("✅ Metafield created:", r.data.metafield?.id);
  } catch (err) {
    console.error("❌ Error creating metafield:", err.response?.data || err.message);
  }
}

async function createVariant(product_id, title, price) {
  // delete oldest in background to keep variant count low
  ensureVariantLimit(product_id);

  const variantData = {
    variant: {
      option1: title,
      price: Number(price).toFixed(2),
      inventory_management: null,
      inventory_policy: "continue",
      fulfillment_service: "manual",
    },
  };

  try {
    const r = await axios.post(
      `${SHOPIFY_API_URL}/products/${product_id}/variants.json`,
      variantData,
      { headers: { "X-Shopify-Access-Token": ACCESS_TOKEN } }
    );
    const variant = r.data.variant;
    console.log("✅ Variant created:", variant.id);

    await createMetafield(variant.id, price);
    return variant;
  } catch (err) {
    console.error("❌ Error creating variant:", err.response?.data || err.message);
    return null;
  }
}

// --- API: Create or reuse a variant with new pricing -------------------------
/**
 * POST /create-variant
 * Body:
 *  {
 *    product_id: string (required)
 *    width: number (mm),
 *    height: number (mm),
 *    material: string,          // for your title display
 *    qty: number,
 *    sides: 'single'|'double',
 *    holeMM: number,
 *    corner: 'rounded'|'square'|'luggage',
 *    cornerR: number,
 *    cord: 'none'|...,
 *    supply: 'loose'|'attached'
 *  }
 */
app.post("/create-variant", async (req, res) => {
  try {
    const {
      product_id,
      width,
      height,
      material = "standard",

      // optional config to mirror the front-end
      qty,
      sides,
      holeMM,
      corner,
      cornerR,
      cord,
      supply,
    } = req.body || {};

    if (!product_id) {
      return res.status(400).json({ success: false, error: "Missing product_id" });
    }

    // Build cfg for pricing (same shape as the client)
    const cfg = {
      w: Number(width),
      h: Number(height),
      qty: qty != null ? Number(qty) : 0, // if client forgets to send qty, total will floor to £8.50 (same as client)
      sides,
      holeMM,
      corner,
      cornerR,
      cord,
      supply,
    };

    const total = calculatePrice(cfg);

    // Variant title that encodes the spec (keep stable so we can find/reuse)
    const title = `${cfg.w || 0}x${cfg.h || 0} - ${material}`;

    // Try to reuse an existing variant
    let variant = await findExistingVariant(product_id, title);
    if (!variant) {
      variant = await createVariant(product_id, title, total);
    }

    if (!variant?.id) {
      return res.status(500).json({ success: false, error: "Failed to create or find variant" });
    }

    return res.json({
      success: true,
      variant_id: variant.id,
      price: Number(total).toFixed(2), // echo back for debugging
    });
  } catch (err) {
    console.error("❌ Error in /create-variant:", err.response?.data || err.message);
    return res.status(500).json({ success: false, error: "Internal Server Error" });
  }
});

// --- Test route --------------------------------------------------------------
app.get("/test", (req, res) => {
  res.json({ success: true, message: "CORS is working!" });
});

// --- Boot --------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`🚀 Shopify App running on port ${PORT}`);
});