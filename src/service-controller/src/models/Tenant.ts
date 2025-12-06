import { Schema, model, type HydratedDocument, type Model, type Document } from "mongoose";
import { quota } from "../lib/defaults";
import type { QuotaItem, QuotaKey } from "../types/domain";

export type TenantStatus = "active" | "disabled";

export interface TenantQuota extends QuotaItem {}

export type TenantQuotas = Partial<Record<QuotaKey, TenantQuota>>;

export interface TenantRecord {
    tenantId: string;
    name: string;
    status: TenantStatus;
    quotas: TenantQuotas;
    metadata?: Record<string, unknown>;
    description?: string;
}

export type TenantDocument = HydratedDocument<TenantRecord>;

export type TenantModel = Model<TenantRecord>;

const QuotaItemSchema = new Schema<TenantQuota>(
    {
        limit: {
            type: Number,
            default: 0,
            validate: {
                validator: (value: number) => Number.isInteger(value) && (value === -1 || value >= 0),
                message: "limit must be integer and either -1 or >= 0",
            },
        },
        used: {
            type: Number,
            default: 0,
            min: 0,
            validate: {
                validator: Number.isInteger,
                message: "used must be integer",
            },
        },
    },
    { _id: false }
);

QuotaItemSchema.pre("validate", function (this: TenantQuota & Document) {
    if (typeof this.limit === "string" && /^-?\d+$/.test(this.limit)) {
        this.limit = parseInt(this.limit, 10);
    }
    if (typeof this.used === "string" && /^-?\d+$/.test(this.used)) {
        this.used = parseInt(this.used, 10);
    }
});

const defaultQuota = (key: QuotaKey): TenantQuota => ({
    limit: quota[key],
    used: 0,
});

const QuotasSchema = new Schema<TenantQuotas>(
    {
        cpu: { type: QuotaItemSchema, default: () => defaultQuota("cpu") },
        memoryMB: { type: QuotaItemSchema, default: () => defaultQuota("memoryMB") },
        storageMB: { type: QuotaItemSchema, default: () => defaultQuota("storageMB") },
        vmCount: { type: QuotaItemSchema, default: () => defaultQuota("vmCount") },
        networkCount: { type: QuotaItemSchema, default: () => defaultQuota("networkCount") },
    },
    { _id: false }
);

const tenantSchema = new Schema<TenantRecord>(
    {
        tenantId: { type: String, required: true, unique: true, index: true },
        name: { type: String, required: true },
        status: { type: String, enum: ["active", "disabled"], default: "active", index: true },
        quotas: { type: QuotasSchema, default: () => ({}) },
        metadata: { type: Object },
        description: { type: String },
    },
    { timestamps: true }
);

tenantSchema.pre("save", function (this: TenantDocument) {
    const q = this.quotas || {};
    (Object.keys(q) as QuotaKey[]).forEach((key) => {
        const entry = q[key];
        if (entry && entry.used < 0) entry.used = 0;
    });
});

const Tenant = model<TenantRecord>("Tenant", tenantSchema);

export default Tenant;
