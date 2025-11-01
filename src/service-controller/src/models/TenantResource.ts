// @ts-nocheck
// models/TenantResource.js
const mongoose = require("mongoose");

// compact key = (kind, agentId, refId) to avoid string concatenation
const schema = new mongoose.Schema(
    {
        tenantId: { type: String, required: true, index: true },
        kind: { type: String, required: true, enum: ["vm", "switch", "disk", "nic", "other"] },
        agentId: { type: String, required: true, index: true },
        refId: { type: String, required: true, index: true }, // ex: VM GUID, switch name, etc.
        assignedAt: { type: Date, default: () => new Date() },
    },
    { timestamps: true }
);

// A resource may belong to a single tenant only:
schema.index({ kind: 1, agentId: 1, refId: 1 }, { unique: true });

module.exports = mongoose.model("TenantResource", schema);
