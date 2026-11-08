import { Schema, model } from "mongoose";
const schema = new Schema(
  {
    producer: { type: String, required: true },
    eventId: { type: String, required: true },
    taskId: { type: String, required: true },
    fingerprint: { type: String, required: true },
  },
  { timestamps: true },
);
schema.index({ producer: 1, eventId: 1 }, { unique: true });
export default model("Inbox", schema);
