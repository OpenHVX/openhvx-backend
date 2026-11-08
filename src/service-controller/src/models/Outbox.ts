import { Schema, model } from "mongoose";
import type { PublishTaskPayload } from "../services/amqp";
const schema = new Schema(
  {
    eventId: { type: String, required: true, unique: true },
    operationId: { type: String, required: true, unique: true },
    contractVersion: { type: Number, default: 1 },
    payload: { type: Schema.Types.Mixed, required: true },
    state: {
      type: String,
      enum: ["pending", "sending", "delivered", "quarantined"],
      default: "pending",
    },
    attempts: { type: Number, default: 0 },
    availableAt: { type: Date, default: Date.now },
    leaseUntil: Date,
    owner: String,
    deliveredAt: Date,
    lastError: String,
  },
  { timestamps: true },
);
schema.index({ state: 1, availableAt: 1, leaseUntil: 1 });
export default model("Outbox", schema);
export type OutboxPayload = PublishTaskPayload;
