require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cors());

const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const SHOPIFY_API_URL = `https://${SHOPIFY_STORE}/admin/api/2025-01`;

// Function to Calculate Price
function calculateCustomPrice(width, height, material) {
    const basePricePerCm2 = 0.05;
    const materialPricing = { "kraft": 0, "laminated": 5, "recycled": 3 };

    let area = width * height;
    let materialCost = materialPricing[material] || 0;
    return (area * basePricePerCm2) + materialCost;
}

// Function to Get All Variants
async function getVariants(product_id) {
    try {
        const response = await axios.get(`${SHOPIFY_API_URL}/products/${product_id}/variants.json`, {
            headers: { "X-Shopify-Access-Token": ACCESS_TOKEN }
        });
        return response.data.variants;
    } catch (error) {
        console.error("❌ Error fetching variants:", error.response?.data || error.message);
        return [];
    }
}

// Function to Delete the Oldest Variant
async function deleteOldestVariant(product_id) {
    try {
        let variants = await getVariants(product_id);

        if (variants.length >= 100) {
            // Sort by `created_at` (oldest first)
            let oldestVariant = variants.sort((a, b) => new Date(a.created_at) - new Date(b.created_at))[0];

            console.log(`⚠️ Deleting oldest variant: ${oldestVariant.id}`);
            await axios.delete(`${SHOPIFY_API_URL}/variants/${oldestVariant.id}.json`, {
                headers: { "X-Shopify-Access-Token": ACCESS_TOKEN }
            });

            console.log(`✅ Deleted variant ${oldestVariant.id}`);
            return true;
        }

        return false;
    } catch (error) {
        console.error("❌ Error deleting oldest variant:", error.response?.data || error.message);
        return false;
    }
}

// Function to Find an Existing Variant
async function findExistingVariant(product_id, width, height, material) {
    try {
        let variants = await getVariants(product_id);
        let variantTitle = `${width}x${height} - ${material}`;

        let existingVariant = variants.find(v => v.option1 === variantTitle);

        if (existingVariant) {
            console.log("✅ Existing Variant Found:", existingVariant.id);
            return existingVariant;
        } else {
            console.log("❌ No existing variant found, creating a new one.");
            return null;
        }
    } catch (error) {
        console.error("❌ Error finding variant:", error.response?.data || error.message);
        return null;
    }
}

// Function to Create a Metafield for a Variant
async function createMetafield(variant_id, price) {
    try {
        await axios.post(`${SHOPIFY_API_URL}/variants/${variant_id}/metafields.json`, {
            metafield: {
                namespace: "custom",
                key: "dynamic_price",
                value: price.toFixed(2),
                type: "string"
            }
        }, {
            headers: { "X-Shopify-Access-Token": ACCESS_TOKEN, "Content-Type": "application/json" }
        });

        console.log("✅ Metafield Created");
    } catch (error) {
        console.error("❌ Error creating metafield:", error.response?.data || error.message);
    }
}

// Function to Create a Variant
async function createVariant(product_id, width, height, material, price) {
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
            headers: { "X-Shopify-Access-Token": ACCESS_TOKEN, "Content-Type": "application/json" }
        });

        let variant = response.data.variant;
        console.log("✅ Variant Created:", variant);

        // Attach a Metafield to the Variant
        await createMetafield(variant.id, price);

        return variant;
    } catch (error) {
        console.error("❌ Error creating variant:", error.response?.data || error.message);
        return null;
    }
}

// API Endpoint to Create Variant or Use Existing One
app.post("/create-variant", async (req, res) => {
    try {
        const { width, height, material, product_id } = req.body;
        let price = calculateCustomPrice(width, height, material);

        // Check if the variant already exists
        let variant = await findExistingVariant(product_id, width, height, material);

        // If variant does NOT exist, check variant count
        if (!variant) {
            let variants = await getVariants(product_id);
            if (variants.length >= 100) {
                console.log("⚠️ Maximum variants reached. Deleting the oldest variant...");
                await deleteOldestVariant(product_id);
            }

            // Now create a new variant
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

// Start Server
app.listen(PORT, () => {
    console.log(`🚀 Shopify App running on port ${PORT}`);
});