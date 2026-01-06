// src/service-controller/src/models/ResourceLock.ts

import { Schema, model, type HydratedDocument, type Model } from "mongoose";

// Generic lock document to serialize access to shared resources (disks, VMs, network...).
// One doc per (resourceKind, refId); TTL is enforced via expiresAt to avoid permanent deadlocks.

export type ResourceKind = "storage" | "vm" | "network" | string;

export interface ResourceLockRecord {
    resourceKind: ResourceKind;
    refId: string;
    taskId: string;
    tenantId?: string;
    agentId?: string;
    action?: string;
    expiresAt: Date;
}

export type ResourceLockDocument = HydratedDocument<ResourceLockRecord>;

export type ResourceLockModel = Model<ResourceLockRecord>;

const ResourceLockSchema = new Schema<ResourceLockRecord>(
    {
        resourceKind: { type: String, required: true },
        refId: { type: String, required: true },
        taskId: { type: String, required: true, index: true },
        tenantId: { type: String },
        agentId: { type: String },
        action: { type: String },
        expiresAt: { type: Date, required: true, index: true },
    },
    { timestamps: true }
);

// One active lock per resource (disk, vm, network...)
ResourceLockSchema.index({ resourceKind: 1, refId: 1 }, { unique: true });
// Auto-expire stale locks if a task never reports back.
ResourceLockSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const ResourceLock = model<ResourceLockRecord>("ResourceLock", ResourceLockSchema);

export default ResourceLock;
