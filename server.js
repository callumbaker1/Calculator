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
const SHOPIFY_API_URL = `https://${SHOPIFY_STORE}/admin/api/2024-01`;

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
            inventory_management: "shopify",
            inventory_policy: "deny"
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
            variant = await createVariant(product_id, width, height, material, price);
            console.log("Created new variant:", variant);
        }

        if (!variant) {
            console.error("Failed to create variant");
            return res.status(500).json({ error: "Failed to create variant" });
        }

        // Add Variant to Shopify Cart
        const cartData = { items: [{ id: variant.id, quantity: 1 }] };
        await axios.post(`https://${SHOPIFY_STORE}/cart/add.js`, cartData, {
            headers: { "Content-Type": "application/json" }
        });

        res.json({ success: true, variant_id: variant.id });
    } catch (error) {
        console.error("Error in /create-variant:", error.response?.data || error.message);
        res.status(500).json({ error: "Internal Server Error", details: error.message });
    }
});

// 🔹 Start Server
app.listen(PORT, () => {
    console.log(`Shopify App running on port ${PORT}`);
});