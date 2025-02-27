require("dotenv").config();
const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Basic test route
app.get("/", (req, res) => {
    res.send("Shopify App is Running!");
});

// Start server
app.listen(PORT, () => {
    console.log(`Shopify App running on port ${PORT}`);
});