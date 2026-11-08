import { Schema, model } from "mongoose";
const schema = new Schema(
  {
    scope: { type: String, required: true },
    key: { type: String, required: true },
    fingerprint: { type: String, required: true },
    taskId: { type: String, required: true },
    response: { type: Schema.Types.Mixed, required: true },
  },
  { timestamps: true },
);
// No TTL: automatic eviction would allow an old create to execute again.
schema.index({ scope: 1, key: 1 }, { unique: true });
export default model("Idempotency", schema);
