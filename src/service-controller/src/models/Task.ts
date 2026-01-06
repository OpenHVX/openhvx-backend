// src/service-controller/src/models/Task.ts
// Mongoose model for task records

import { Schema, model, type HydratedDocument, type Model } from "mongoose";
import type { TaskStatus } from "../types/domain";

export interface TaskRecord {
    taskId: string;
    tenantId?: string;
    agentId?: string;
    action: string;
    data: Record<string, unknown>;
    status: TaskStatus;
    correlationId?: string;
    queuedAt: Date;
    publishedAt?: Date;
    startedAt?: Date;
    finishedAt?: Date;
    result?: Record<string, unknown> | null;
    error?: string | null;
    hasQuotaHold: boolean;
    routingKey?: string;
}

export type TaskDocument = HydratedDocument<TaskRecord>;

export type TaskModel = Model<TaskRecord>;

const taskSchema = new Schema<TaskRecord>(
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
        startedAt: { type: Date },
        finishedAt: { type: Date },
        result: { type: Object },
        error: { type: String },
        hasQuotaHold: { type: Boolean, default: false, index: true },
        routingKey: { type: String },
    },
    { timestamps: true }
);

taskSchema.index({ tenantId: 1, status: 1, queuedAt: -1 });

const Task = model<TaskRecord>("Task", taskSchema);

export default Task;
