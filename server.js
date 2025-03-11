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

// ✅ Manually set CORS headers
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

// 🔹 Function to Get All Variants of a Product
async function getAllVariants(product_id) {
    try {
        console.log("🔄 Fetching all variants...");
        const response = await axios.get(`${SHOPIFY_API_URL}/products/${product_id}/variants.json`, {
            headers: { "X-Shopify-Access-Token": ACCESS_TOKEN }
        });

        console.log(`✅ Found ${response.data.variants.length} variants`);
        return response.data.variants || [];
    } catch (error) {
        console.error("❌ Error fetching variants:", error.response?.data || error.message);
        return [];
    }
}

// 🔹 Function to Delete the **Oldest Variant**
async function deleteOldestVariant(product_id) {
    let variants = await getAllVariants(product_id);

    if (variants.length >= 95) {  // ✅ Set max limit to 95 instead of 100
        let oldestVariant = variants[0]; // 🔹 Get the first variant (oldest)
        console.log(`⚠️ Variant limit reached (${variants.length}/100). Deleting oldest variant: ${oldestVariant.id}`);

        try {
            await axios.delete(`${SHOPIFY_API_URL}/products/${product_id}/variants/${oldestVariant.id}.json`, {
                headers: { "X-Shopify-Access-Token": ACCESS_TOKEN }
            });
            console.log(`🗑️ Successfully deleted variant ID: ${oldestVariant.id}`);

            // 🔹 Wait for Shopify to process the deletion before proceeding
            await new Promise(resolve => setTimeout(resolve, 3000));

            // 🔹 Double-check if the variant is really gone
            let updatedVariants = await getAllVariants(product_id);
            if (updatedVariants.length < variants.length) {
                console.log("✅ Variant successfully removed!");
            } else {
                console.error("❌ Variant deletion did not reflect in Shopify.");
            }
        } catch (error) {
            console.error("❌ Error deleting variant:", error.response?.data || error.message);
        }
    }
}

// 🔹 Function to Create a Variant
async function createVariant(product_id, width, height, material, price) {
    await deleteOldestVariant(product_id); // ✅ Ensure space is available

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
        console.log("🛠️ Creating new variant...");
        const response = await axios.post(`${SHOPIFY_API_URL}/products/${product_id}/variants.json`, variantData, {
            headers: { "X-Shopify-Access-Token": ACCESS_TOKEN }
        });

        let variant = response.data.variant;
        console.log("✅ Variant Created:", variant.id);
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

        // 🔹 Check current variant count before proceeding
        let variants = await getAllVariants(product_id);
        console.log(`📦 Current variants count: ${variants.length}/100`);

        // 🔹 Ensure we have space for a new variant
        await deleteOldestVariant(product_id);

        let variant = await createVariant(product_id, width, height, material, 0);

        if (!variant || !variant.id) {
            return res.status(500).json({ error: "Failed to create variant" });
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