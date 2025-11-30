import { Schema, model, type HydratedDocument, type Model } from "mongoose";
import type { ResourceKind } from "../types/domain";

export interface TenantResourceLink {
    tenantId: string;
    kind: ResourceKind;
    agentId: string;
    refId: string;
    assignedAt: Date;
    name?: string;
    guid?: string;
}

export type TenantResourceDocument = HydratedDocument<TenantResourceLink>;

export type TenantResourceModel = Model<TenantResourceLink>;

const schema = new Schema<TenantResourceLink>(
    {
        tenantId: { type: String, required: true, index: true },
        kind: { type: String, required: true, enum: ["vm", "switch", "disk", "nic", "other"] },
        agentId: { type: String, required: true, index: true },
        refId: { type: String, required: true, index: true },
        assignedAt: { type: Date, default: () => new Date() },
        name: { type: String },
        guid: { type: String },
    },
    { timestamps: true }
);

schema.index({ kind: 1, agentId: 1, refId: 1 }, { unique: true });

const TenantResource = model<TenantResourceLink>("TenantResource", schema);

export default TenantResource;
