const express = require("express");
const fetch = require("node-fetch");
require("dotenv").config();

const app = express();
app.use(express.json());

const SHOPIFY_API_URL = `https://your-shopify-store.myshopify.com/admin/api/2025-01`;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

// Function to check if a variant with the same attributes already exists
async function checkIfVariantExists(product_id, width, height, material) {
    console.log(`🔍 Checking for existing variant in product ${product_id}...`);

    try {
        let response = await fetch(`${SHOPIFY_API_URL}/products/${product_id}.json`, {
            method: "GET",
            headers: { "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN, "Content-Type": "application/json" }
        });

        let data = await response.json();
        if (!data.product) return null;

        let existingVariant = data.product.variants.find(variant => {
            return variant.option1 === `${width}x${height} - ${material}`;
        });

        if (existingVariant) {
            console.log("✅ Existing variant found:", existingVariant.id);
            return existingVariant;
        } else {
            console.log("⚠ No existing variant found.");
            return null;
        }
    } catch (error) {
        console.error("❌ Error checking existing variant:", error);
        return null;
    }
}

// Function to create a new variant in Shopify
async function createVariant(product_id, width, height, material, price) {
    console.log(`⏳ Creating new variant for product ${product_id}...`);

    try {
        let response = await fetch(`${SHOPIFY_API_URL}/products/${product_id}/variants.json`, {
            method: "POST",
            headers: { "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN, "Content-Type": "application/json" },
            body: JSON.stringify({
                variant: {
                    option1: `${width}x${height} - ${material}`,
                    price: price.toFixed(2),
                    inventory_management: "shopify",
                    inventory_policy: "deny",
                    inventory_quantity: 9999, // Prevents it from showing as "out of stock"
                    taxable: true
                }
            })
        });

        let data = await response.json();
        if (data.variant) {
            console.log("✅ Variant successfully created:", data.variant.id);
            return data.variant;
        } else {
            console.error("❌ Shopify API Error:", data);
            return null;
        }
    } catch (error) {
        console.error("❌ Error creating variant:", error);
        return null;
    }
}

// Function to force Shopify to refresh product data
async function forceShopifyToUpdate(product_id) {
    console.log("🔄 Forcing Shopify to refresh product data...");

    try {
        let response = await fetch(`${SHOPIFY_API_URL}/products/${product_id}.json`, {
            method: "PUT",
            headers: { "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN, "Content-Type": "application/json" },
            body: JSON.stringify({ product: { id: product_id } })
        });

        let data = await response.json();
        console.log("✅ Shopify product refreshed:", data);
    } catch (error) {
        console.error("❌ Error forcing Shopify product refresh:", error);
    }
}

// Route to handle variant creation
app.post("/create-variant", async (req, res) => {
    try {
        const { width, height, material, product_id } = req.body;

        // 🔹 Calculate the price dynamically
        let price = (width * height * 0.05) + (material === "laminated" ? 5 : material === "recycled" ? 3 : 0);
        console.log(`💰 Calculated price: ${price}`);

        // 🔍 Check if a variant already exists
        let existingVariant = await checkIfVariantExists(product_id, width, height, material);
        if (existingVariant) {
            console.log("✅ Using existing variant:", existingVariant.id);
            return res.json({ success: true, variant_id: existingVariant.id });
        }

        // ⏳ Create a new variant if it doesn't exist
        let newVariant = await createVariant(product_id, width, height, material, price);
        if (!newVariant || !newVariant.id) {
            return res.status(500).json({ error: "Failed to create variant" });
        }

        // 🔄 Force Shopify to update product data
        await forceShopifyToUpdate(product_id);

        console.log("✅ Variant successfully created and Shopify updated:", newVariant.id);
        res.json({ success: true, variant_id: newVariant.id });

    } catch (error) {
        console.error("❌ Error in /create-variant:", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// Start the Express server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});