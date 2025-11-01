// @ts-nocheck
//models/Task.js
const mongoose = require("mongoose");

const taskSchema = new mongoose.Schema(
    {
        taskId: { type: String, required: true, unique: true, index: true },
        tenantId: { type: String, index: true },
        agentId: { type: String, index: true },
        action: { type: String, required: true },
        data: { type: Object, default: {} },

        status: { type: String, enum: ["queued", "sent", "done", "error"], default: "queued", index: true },
        correlationId: { type: String },

        queuedAt: { type: Date, default: () => new Date() },
        publishedAt: { type: Date },
        startedAt: { type: Date },     // handy if we ever add an "ack start"
        finishedAt: { type: Date },

        result: { type: Object },   // payload returned by the agent
        error: { type: String },   // possible error message
        hasQuotaHold: { type: Boolean, default: false, index: true },
        routingKey: { type: String },   // routing key used on the results exchange (debug helper)
    },
    { timestamps: true }
);

taskSchema.index({ tenantId: 1, status: 1, queuedAt: -1 });

module.exports = mongoose.model("Task", taskSchema);
