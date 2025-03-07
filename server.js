require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// ✅ Allow only your Shopify store (update with your store domain)
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
    if (req.method === "OPTIONS") {
        return res.sendStatus(200);
    }
    next();
});

// ✅ Shopify API Details
const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const SHOPIFY_API_URL = `https://${SHOPIFY_STORE}/admin/api/2025-01`;

// 🔹 Function to Calculate Price
function calculateCustomPrice(width, height, material) {
    const basePricePerCm2 = 0.05;
    const materialPricing = { "kraft": 0, "laminated": 5, "recycled": 3 };

    let area = width * height;
    let materialCost = materialPricing[material] || 0;
    return (area * basePricePerCm2) + materialCost;
}

// 🔹 Function to Get All Variants of a Product
async function getAllVariants(product_id) {
    try {
        const response = await axios.get(`${SHOPIFY_API_URL}/products/${product_id}/variants.json`, {
            headers: { "X-Shopify-Access-Token": ACCESS_TOKEN }
        });
        return response.data.variants || [];
    } catch (error) {
        console.error("❌ Error fetching variants:", error.response?.data || error.message);
        return [];
    }
}

// 🔹 Function to Find an Existing Variant
async function findExistingVariant(product_id, width, height, material) {
    try {
        let variants = await getAllVariants(product_id);
        let variantTitle = `${width}x${height} - ${material}`;
        return variants.find(v => v.option1 === variantTitle) || null;
    } catch (error) {
        console.error("❌ Error finding variant:", error.response?.data || error.message);
        return null;
    }
}

// 🔹 Function to Delete the Oldest Variant **Before** Creating a New One
async function ensureVariantLimit(product_id) {
    let variants = await getAllVariants(product_id);

    if (variants.length >= 100) {
        let oldestVariant = variants[0]; // The first variant is usually the oldest
        try {
            await axios.delete(`${SHOPIFY_API_URL}/products/${product_id}/variants/${oldestVariant.id}.json`, {
                headers: { "X-Shopify-Access-Token": ACCESS_TOKEN }
            });
            console.log("🗑️ Deleted oldest variant:", oldestVariant.id);
        } catch (error) {
            console.error("❌ Error deleting variant:", error.response?.data || error.message);
        }
    }
}

// 🔹 Function to Create a Metafield for a Variant
async function createMetafield(variant_id, price) {
    try {
        const response = await axios.post(`${SHOPIFY_API_URL}/variants/${variant_id}/metafields.json`, {
            metafield: {
                namespace: "custom",
                key: "dynamic_price",
                value: price.toFixed(2),
                type: "string"
            }
        }, {
            headers: { "X-Shopify-Access-Token": ACCESS_TOKEN, "Content-Type": "application/json" }
        });

        console.log("✅ Metafield Created:", response.data.metafield);
    } catch (error) {
        console.error("❌ Error creating metafield:", error.response?.data || error.message);
    }
}

// 🔹 Function to Create a Variant
async function createVariant(product_id, width, height, material, price) {
    await ensureVariantLimit(product_id); // Ensure Shopify allows variant creation

    const variantData = {
        variant: {
            option1: `${width}x${height} - ${material}`,
            price: price.toFixed(2),
            inventory_management: null,
            inventory_policy: "continue",
            fulfillment_service: "manual"
        }
    };

    try {
        const response = await axios.post(`${SHOPIFY_API_URL}/products/${product_id}/variants.json`, variantData, {
            headers: { "X-Shopify-Access-Token": ACCESS_TOKEN }
        });

        let variant = response.data.variant;
        console.log("✅ Variant Created:", variant.id);

        // Attach a Metafield to the Variant
        await createMetafield(variant.id, price);

        return variant;
    } catch (error) {
        console.error("❌ Error creating variant:", error.response?.data || error.message);
        return null;
    }
}

// 🔹 API Endpoint to Create or Use Existing Variant
app.post("/create-variant", async (req, res) => {
    try {
        const { width, height, material, product_id } = req.body;
        let price = calculateCustomPrice(width, height, material);

        // Check if the variant already exists
        let variant = await findExistingVariant(product_id, width, height, material);

        if (!variant) {
            variant = await createVariant(product_id, width, height, material, price);
        }

        if (!variant || !variant.id) {
            return res.status(500).json({ error: "Failed to create or find variant" });
        }

        res.json({ success: true, variant_id: variant.id });
    } catch (error) {
        console.error("❌ Error in /create-variant:", error.response?.data || error.message);
        res.status(500).json({ error: "Internal Server Error", details: error.message });
    }
});

// ✅ Test Route to Check CORS
app.get("/test", (req, res) => {
    res.json({ success: true, message: "CORS is working!" });
});

// Start Server
app.listen(PORT, () => {
    console.log(`🚀 Shopify App running on port ${PORT}`);
});