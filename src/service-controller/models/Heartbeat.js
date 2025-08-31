// models/Heartbeat.js
const mongoose = require("mongoose");

const heartbeatSchema = new mongoose.Schema(
    {
        agentId: { type: String, required: true, index: true },
        version: String,
        capabilities: { type: [String], default: [] },
        lastSeen: { type: Date, required: true },
        host: { type: String, default: "N/A" },
        raw: { type: Object },
    },
    { timestamps: true }
);

// un heartbeat par agent (le plus récent écrase l'ancien)
heartbeatSchema.index({ agentId: 1 }, { unique: true });

module.exports = mongoose.model("Heartbeat", heartbeatSchema);
