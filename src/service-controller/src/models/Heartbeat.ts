import { Schema, model, type HydratedDocument, type Model } from "mongoose";

export interface Heartbeat {
    agentId: string;
    version?: string;
    capabilities: string[];
    lastSeen: Date;
    host?: string;
    raw?: Record<string, unknown>;
}

export type HeartbeatDocument = HydratedDocument<Heartbeat>;

export type HeartbeatModel = Model<Heartbeat>;

const heartbeatSchema = new Schema<Heartbeat>(
    {
        agentId: { type: String, required: true, index: true },
        version: { type: String },
        capabilities: { type: [String], default: [] },
        lastSeen: { type: Date, required: true },
        host: { type: String, default: "N/A" },
        raw: { type: Object },
    },
    { timestamps: true }
);

heartbeatSchema.index({ agentId: 1 }, { unique: true });

const HeartbeatModel = model<Heartbeat>("Heartbeat", heartbeatSchema);

export default HeartbeatModel;
