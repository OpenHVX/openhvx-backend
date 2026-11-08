import "dotenv/config";
import mongoose from "mongoose";
import Outbox from "../models/Outbox";
import Task from "../models/Task";
import { unseal } from "../services/operations/secrets";
import type { OutboxPayload } from "../models/Outbox";
async function main() {
    const eventId = process.argv.find(arg => arg.startsWith("--event-id="))?.slice(11);
    if (!eventId || !process.env.MONGO_URL) throw new Error("MONGO_URL and --event-id=<id> required");
    await mongoose.connect(process.env.MONGO_URL, { autoIndex: false });
    const item = await Outbox.findOne({ eventId, state: "quarantined" }).lean();
    if (!item) throw new Error("No quarantined event with this identity");
    const task = await Task.findOne({ taskId: item.operationId }).lean();
    if (!task || ["done", "error"].includes(task.status)) throw new Error("Replay requires an unresolved task");
    const payload = unseal<OutboxPayload>(item.payload);
    if (["console.serial.open", "net.tunnel.open"].includes(payload.action)) throw new Error("Open a new console with fresh tickets instead of replaying a quarantined console");
    console.log(JSON.stringify({ eventId, operationId: item.operationId, action: payload.action, apply: process.argv.includes("--apply") }));
    if (process.argv.includes("--apply")) {
        await Outbox.updateOne({ _id: item._id, state: "quarantined" }, { $set: { state: "pending", attempts: 0, availableAt: new Date() }, $unset: { lastError: 1 } });
    }
}
void main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => mongoose.disconnect());
