const mongoose = require("mongoose");
module.exports = mongoose.model("InventoryFull", new mongoose.Schema({
    agentId: { type: String, index: true },
    ts: { type: Date, index: true },
    inventory: { type: Object },
    raw: { type: Object },
}, { minimize: false }));