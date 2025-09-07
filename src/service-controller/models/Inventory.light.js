const mongoose = require("mongoose");

const InventoryLightSchema = new mongoose.Schema({
    agentId: { type: String, index: true },
    ts: { type: Date, index: true },
    inventory: { type: Object },
    raw: { type: Object },
}, { minimize: false });

module.exports = mongoose.model("InventoryLight", InventoryLightSchema);

