// @ts-nocheck
// models/Tenant.js
"use strict";

const mongoose = require("mongoose");
const { quota } = require("../lib/defaults");

/**
 * Subschema for each quota item.
 */

const QuotaItemSchema = new mongoose.Schema(
    {
        // -1 means unlimited, otherwise enforce non-negative integers
        limit: {
            type: Number,
            default: 0,
            validate: {
                validator: (v) => Number.isInteger(v) && (v === -1 || v >= 0),
                message: 'limit must be integer and either -1 or >= 0',
            }
        },
        used: {
            type: Number,
            default: 0,
            min: 0,
            validate: {
                validator: Number.isInteger,
                message: 'used must be integer',
            }
        },
    },
    { _id: false }
);

// Optional: normalize incoming strings to integers (guards against "1.2", etc.)
QuotaItemSchema.pre('validate', function () {
    if (typeof this.limit === 'string' && /^-?\d+$/.test(this.limit)) {
        this.limit = parseInt(this.limit, 10);
    }
    if (typeof this.used === 'string' && /^-?\d+$/.test(this.used)) {
        this.used = parseInt(this.used, 10);
    }
});


/**
 * Quotas schema (grouped by resource type)
 */
const QuotasSchema = new mongoose.Schema(
    {
        cpu: { type: QuotaItemSchema, default: () => ({ limit: quota.cpu, used: 0 }) },
        memoryMB: { type: QuotaItemSchema, default: () => ({ limit: quota.memoryMB, used: 0 }) },
        storageMB: { type: QuotaItemSchema, default: () => ({ limit: quota.storageMB, used: 0 }) },
        vmCount: { type: QuotaItemSchema, default: () => ({ limit: quota.vmCount, used: 0 }) },
        networkCount: { type: QuotaItemSchema, default: () => ({ limit: quota.networkCount, used: 0 }) },
    },
    { _id: false }
);

const tenantSchema = new mongoose.Schema(
    {
        tenantId: { type: String, required: true, unique: true, index: true },
        name: { type: String, required: true },
        status: { type: String, enum: ["active", "disabled"], default: "active", index: true },
        quotas: { type: QuotasSchema, default: () => ({}) },
        metadata: { type: Object },
    },
    { timestamps: true }
);

tenantSchema.pre("save", function () {
    const q = this.quotas || {};
    for (const k of Object.keys(q)) {
        if (q[k] && q[k].used < 0) q[k].used = 0;
    }
});

module.exports = mongoose.model("Tenant", tenantSchema);
