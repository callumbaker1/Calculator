// index.js
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
// Pricing — must stay identical to the client price(c) function
// Inputs: millimetres for width/height, qty integer, config object
// Returns a Number (total £) with an £8.50 minimum floor
// ---------------------------------------------------------------------
function calculateCfgPrice({
  width,        // mm
  height,       // mm
  qty = 1,
  sides = "single",        // 'single' | 'double'
  holeMM = 5,              // number (mm)
  corner = "rounded",      // 'rounded' | 'square' | 'luggage'
  cornerR = 2,             // number (mm)
  cord = "none",           // 'none' | 'standard' | 'lux' | etc (any non-'none' counts)
  supply = "loose",        // 'loose' | 'attached'
}) {
  if (!qty || qty < 1) return 0;

  // Area in cm² (mm * mm / 100)
  const areaCm2 = (Number(width) * Number(height)) / 100;

  // base unit price scales with area
  let unit = 0.012 * areaCm2;
  const baseUnit = unit;

  // sides
  let sidesMultApplied = 1;
  if (sides === "double") {
    unit *= 1.12;
    sidesMultApplied = 1.12;
  }

  // hole surcharge
  let holeAdd = 0;
  if (Number(holeMM) >= 7) {
    holeAdd = 0.002;
    unit += holeAdd;
  }

  // corner surcharges
  let roundedAdd = 0;
  let luggageAdd = 0;
  if (corner === "rounded") {
    roundedAdd = Number(cornerR) * 0.0007;
    unit += roundedAdd;
  }
  if (corner === "luggage") {
    luggageAdd = 0.01;
    unit += luggageAdd;
  }

  // cords & supply
  let cordAdd = 0;
  let attachedAdd = 0;
  if (cord && cord !== "none") {
    cordAdd = 0.02;
    unit += cordAdd;
    if (supply === "attached") {
      attachedAdd = 0.01;
      unit += attachedAdd;
    }
  }

  // discount tiers
  let disc = 1;
  if (qty >= 250) disc = 0.93;
  if (qty >= 500) disc = 0.88;
  if (qty >= 1000) disc = 0.83;

  const totalBeforeFloor = unit * qty * disc;
  const totalAfterFloor = Math.max(totalBeforeFloor, 8.5);

  // server-side breakdown log to confirm parity with client
  console.log("[Pricing] breakdown:", {
    "Width (mm)": width,
    "Height (mm)": height,
    "Qty": qty,
    "Area (cm²)": Number(areaCm2.toFixed(2)),
    "Base unit (per item)": Number(baseUnit.toFixed(4)),
    "Sides multiplier": sidesMultApplied,
    "Hole add": holeAdd,
    "Rounded add": Number(roundedAdd.toFixed(4)),
    "Luggage add": luggageAdd,
    "Cord add": cordAdd,
    "Attached add": attachedAdd,
    "Discount factor": disc,
    "Total before floor": Number(totalBeforeFloor.toFixed(2)),
    "Total after floor (returned)": Number(totalAfterFloor.toFixed(2)),
  });

  return Number(totalAfterFloor.toFixed(2));
}

// --------- Shopify helpers (unchanged except minor logging) ----------
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
      console.log(`⚠️ Deleting oldest variant to stay under limits: ${oldest.id}`);
      await axios.delete(
        `${SHOPIFY_API_URL}/products/${product_id}/variants/${oldest.id}.json`,
        { headers: { "X-Shopify-Access-Token": ACCESS_TOKEN } }
      );
      console.log(`🗑️ Deleted variant ${oldest.id}`);
    }
  } catch (err) {
    console.error("❌ Error deleting variant:", err.response?.data || err.message);
  }
}

async function findExistingVariant(product_id, width, height, material) {
  try {
    const r = await axios.get(
      `${SHOPIFY_API_URL}/products/${product_id}/variants.json?limit=100`,
      { headers: { "X-Shopify-Access-Token": ACCESS_TOKEN } }
    );
    const title = `${width}x${height} - ${material}`;
    return r.data.variants.find(v => v.option1 === title) || null;
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
    console.log("✅ Metafield created", r.data.metafield?.id);
  } catch (err) {
    console.error("❌ Error creating metafield:", err.response?.data || err.message);
  }
}

async function createVariant(product_id, width, height, material, price) {
  // delete oldest asynchronously to keep things snappy
  ensureVariantLimit(product_id).catch(() => {});

  const payload = {
    variant: {
      option1: `${width}x${height} - ${material}`,
      price: price.toFixed(2),
      inventory_management: null,
      inventory_policy: "continue",
      fulfillment_service: "manual",
    },
  };

  try {
    const r = await axios.post(
      `${SHOPIFY_API_URL}/products/${product_id}/variants.json`,
      payload,
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

// ---------------------------- Routes ---------------------------------
app.post("/create-variant", async (req, res) => {
  try {
    const {
      width,
      height,
      material = "standard",
      product_id,
      qty = 1,
      config = {}, // { sides, holeMM, corner, cornerR, cord, supply }
    } = req.body || {};

    // Basic validation
    if (!product_id || !width || !height) {
      return res.status(400).json({ success: false, error: "Missing width/height/product_id" });
    }

    console.log("[/create-variant] Incoming:", {
      width,
      height,
      material,
      product_id,
      qty,
      config,
    });

    const price = calculateCfgPrice({
      width: Number(width),
      height: Number(height),
      qty: Number(qty) || 1,
      sides: config.sides || "single",
      holeMM: Number(config.holeMM) || 5,
      corner: config.corner || "rounded",
      cornerR: Number(config.cornerR) || 2,
      cord: config.cord || "none",
      supply: config.supply || "loose",
    });

    console.log("[/create-variant] Calculated price:", price);

    // Reuse existing variant if the exact size/material already exists
    let variant = await findExistingVariant(product_id, width, height, material);
    if (!variant) {
      variant = await createVariant(product_id, width, height, material, price);
    }

    if (!variant?.id) {
      return res.status(500).json({ success: false, error: "Failed to create/find variant" });
    }

    return res.json({
      success: true,
      variant_id: variant.id,
      price, // echoed for client-side debugging
    });
  } catch (err) {
    console.error("❌ Error in /create-variant:", err.response?.data || err.message);
    return res.status(500).json({ success: false, error: "Internal Server Error" });
  }
});

app.get("/test", (req, res) => {
  res.json({ success: true, message: "CORS OK" });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});