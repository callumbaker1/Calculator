const express = require("express");
const fetch = require("node-fetch");
require("dotenv").config();

const app = express();
app.use(express.json());

const SHOPIFY_API_URL = `https://your-shopify-store.myshopify.com/admin/api/2025-01`;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

// Function to create a variant
async function createVariant(product_id, width, height, material, price) {
    console.log(`⏳ Creating new variant for product ${product_id}...`);

    try {
        let response = await fetch(`${SHOPIFY_API_URL}/products/${product_id}/variants.json`, {
            method: "POST",
            headers: { 
                "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN, 
                "Content-Type": "application/json" 
            },
            body: JSON.stringify({
                variant: {
                    option1: `${width}x${height} - ${material}`,
                    price: price.toFixed(2),
                    inventory_management: null,  // Disable inventory tracking
                    inventory_policy: "continue",
                    inventory_quantity: 9999,  // Prevent out-of-stock issues
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

// Function to confirm Shopify has processed the variant price
async function waitForShopifyVariantPrice(variant_id, maxAttempts = 10, delay = 500) {
    console.log(`🔄 Waiting for Shopify to confirm the correct price for variant ${variant_id}...`);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            let response = await fetch(`${SHOPIFY_API_URL}/variants/${variant_id}.json`, {
                method: "GET",
                headers: { 
                    "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
                    "Content-Type": "application/json"
                }
            });

            let data = await response.json();
            if (data.variant && parseFloat(data.variant.price) > 0) {
                console.log(`✅ Shopify confirmed correct price: £${data.variant.price}`);
                return true;
            }
        } catch (error) {
            console.error(`❌ Attempt ${attempt}: Error checking variant price`, error);
        }

        console.log(`⏳ Waiting for Shopify price update... Attempt ${attempt}`);
        await new Promise(resolve => setTimeout(resolve, delay));
    }

    console.error("❌ Shopify did not update the price in time.");
    return false;
}

// API Route: Create a variant and confirm the price
app.post("/create-variant", async (req, res) => {
    try {
        const { width, height, material, product_id } = req.body;
        let price = (width * height * 0.05) + (material === "laminated" ? 5 : material === "recycled" ? 3 : 0);

        let variant = await createVariant(product_id, width, height, material, price);
        if (!variant || !variant.id) {
            return res.status(500).json({ error: "Failed to create variant" });
        }

        let priceConfirmed = await waitForShopifyVariantPrice(variant.id);
        if (!priceConfirmed) {
            return res.status(500).json({ error: "Shopify did not update the price in time." });
        }

        res.json({ success: true, variant_id: variant.id });
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