// models/Tenant.js
const mongoose = require("mongoose");

const tenantSchema = new mongoose.Schema(
    {
        tenantId: { type: String, required: true, unique: true, index: true },
        name: { type: String, required: true },
        status: { type: String, enum: ["active", "disabled"], default: "active", index: true },
        quotas: {
            maxVMs: { type: Number },
            maxCPU: { type: Number },
            maxRAM: { type: Number },      // MB
            maxStorage: { type: Number },  // GB
        },
        metadata: { type: Object },
    },
    { timestamps: true }
);

module.exports = mongoose.model("Tenant", tenantSchema);
