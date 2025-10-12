"use strict";
const mongoose = require("mongoose");

const QuotaHoldSchema = new mongoose.Schema({
    tenantId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    taskId: { type: String, required: true, unique: true, index: true }, // id message broker
    deltas: {
        cpu: Number,
        memoryMB: Number,
        storageMB: Number,
        vmCount: Number,
        networkCount: Number,
    },
    status: { type: String, enum: ["held", "consumed", "released"], default: "held", index: true },
    expiresAt: { type: Date, required: true, index: true },
}, { timestamps: true });

module.exports = mongoose.model("QuotaHold", QuotaHoldSchema);
