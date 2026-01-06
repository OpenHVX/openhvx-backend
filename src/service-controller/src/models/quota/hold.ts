// src/service-controller/src/models/quota/hold.ts
// Mongoose model for quota hold records

import { Schema, model, Types, type HydratedDocument, type Model } from "mongoose";
import type { QuotaDeltas } from "../../types/domain";

export type QuotaHoldStatus = "held" | "consumed" | "released";

export interface QuotaHoldRecord {
    tenantId: Types.ObjectId;
    taskId: string;
    deltas: QuotaDeltas;
    status: QuotaHoldStatus;
    expiresAt: Date;
}

export type QuotaHoldDocument = HydratedDocument<QuotaHoldRecord>;

export type QuotaHoldModel = Model<QuotaHoldRecord>;

const QuotaHoldSchema = new Schema<QuotaHoldRecord>(
    {
        tenantId: { type: Schema.Types.ObjectId, required: true, index: true },
        taskId: { type: String, required: true, unique: true, index: true },
        deltas: {
            cpu: Number,
            memoryMB: Number,
            storageMB: Number,
            vmCount: Number,
            networkCount: Number,
        },
        status: { type: String, enum: ["held", "consumed", "released"], default: "held", index: true },
        expiresAt: { type: Date, required: true, index: true },
    },
    { timestamps: true }
);

const QuotaHold = model<QuotaHoldRecord>("QuotaHold", QuotaHoldSchema);

export default QuotaHold;
