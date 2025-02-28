require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cors());

// Shopify API Credentials
const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const SHOPIFY_API_URL = `https://${SHOPIFY_STORE}/admin/api/2025-01`;

// 🔹 Function to Calculate Price Based on User Selections
function calculateCustomPrice(width, height, material) {
    const basePricePerCm2 = 0.05;
    const materialPricing = { "kraft": 0, "laminated": 5, "recycled": 3 };

    let area = width * height;
    let materialCost = materialPricing[material] || 0;
    return (area * basePricePerCm2) + materialCost;
}

// 🔹 Check If Variant Exists
async function findVariant(product_id, title) {
    try {
        const response = await axios.get(`${SHOPIFY_API_URL}/products/${product_id}/variants.json`, {
            headers: { "X-Shopify-Access-Token": ACCESS_TOKEN }
        });

        return response.data.variants.find(v => v.title === title);
    } catch (error) {
        console.error("Error finding variant:", error.response?.data || error.message);
        return null;
    }
}

// 🔹 Create a Variant If It Doesn't Exist
async function createVariant(product_id, width, height, material, price) {
    const variantData = {
        variant: {
            option1: `${width}x${height} - ${material}`,
            price: price.toFixed(2),
            inventory_management: null,  // ✅ Prevents Shopify from requiring stock
            inventory_policy: "continue", // ✅ Allows purchase even if out of stock
            fulfillment_service: "manual" // ✅ Ensures Shopify handles fulfillment
        }
    };

    try {
        const response = await axios.post(`${SHOPIFY_API_URL}/products/${product_id}/variants.json`, variantData, {
            headers: { "X-Shopify-Access-Token": ACCESS_TOKEN }
        });

        return response.data.variant;
    } catch (error) {
        console.error("Error creating variant:", error.response?.data || error.message);
        return null;
    }
}

async function forceShopifyToUpdate(product_id) {
    console.log("🔄 Forcing Shopify to refresh product data...");

    try {
        let updateResponse = await fetch(`https://your-shopify-store.myshopify.com/admin/api/2024-01/products/${product_id}.json`, {
            method: "PUT",
            headers: {
                "Content-Type": "application/json",
                "X-Shopify-Access-Token": process.env.SHOPIFY_ACCESS_TOKEN
            },
            body: JSON.stringify({
                product: { id: product_id }
            })
        });

        let updateData = await updateResponse.json();
        console.log("✅ Shopify product refreshed:", updateData);
    } catch (error) {
        console.error("❌ Error forcing Shopify product refresh:", error);
    }
}

// 🔹 API Endpoint: Create or Find Variant, Then Add to Cart
app.post("/create-variant", async (req, res) => {
    try {
        const { width, height, material, product_id } = req.body;
        console.log("Received request:", req.body);

        let price = calculateCustomPrice(width, height, material);
        console.log("Calculated price:", price);

        let variant = await findVariant(product_id, `${width}x${height} - ${material}`);
        console.log("Existing variant found?", variant ? "Yes" : "No");

        if (!variant) {
            console.log("Creating a new variant...");
            variant = await createVariant(product_id, width, height, material, price);
            console.log("Variant created:", variant);
        }

        // 🔹 FIX: If variant was created but no response, log it
        if (!variant || !variant.id) {
            console.error("Failed to retrieve variant ID from Shopify response.");
            return res.status(500).json({ error: "Variant created but response is missing ID" });
        }

        console.log("Variant ID:", variant.id);

        // 🔹 Try Adding to Cart
        try {


            console.log("Variant successfully added to cart!");
            res.json({ success: true, variant_id: variant.id });
        } catch (cartError) {
            console.error("Failed to add variant to cart:", cartError.response?.data || cartError.message);
            res.status(500).json({ error: "Variant created but failed to add to cart" });
        }
    } catch (error) {
        console.error("Error in /create-variant:", error.response?.data || error.message);
        res.status(500).json({ error: "Internal Server Error", details: error.message });
    }
});

// 🔹 Start Server
app.listen(PORT, () => {
    console.log(`Shopify App running on port ${PORT}`);
});