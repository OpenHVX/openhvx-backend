import { ensureOperationIndexes } from "../services/operations/indexes";
import "dotenv/config";
import mongoose from "mongoose";
import ResourceLock from "../models/ResourceLock";
import Task from "../models/Task";
import Outbox from "../models/Outbox";
import QuotaHold from "../models/quota/hold";
import Heartbeat from "../models/Heartbeat";
async function main() {
  if (!process.env.MONGO_URL) throw new Error("MONGO_URL required");
  await mongoose.connect(process.env.MONGO_URL, {
    autoIndex: false,
    autoCreate: false,
  });
  const apply = process.argv.includes("--apply");
  const db = mongoose.connection.db!;
  const collections = await db
    .listCollections({}, { nameOnly: true })
    .toArray();
  const names = new Set(collections.map((item) => item.name));
  const lockIndexes = names.has(ResourceLock.collection.name)
    ? await ResourceLock.collection.indexes()
    : [];
  const ttl = lockIndexes.filter(
    (index) => index.expireAfterSeconds !== undefined,
  );
  const releasing = names.has(QuotaHold.collection.name)
    ? await QuotaHold.countDocuments({ status: "releasing" })
    : 0;
  const orphanHolds = names.has(QuotaHold.collection.name)
    ? await QuotaHold.aggregate([
        { $match: { status: { $in: ["held", "releasing"] } } },
        {
          $lookup: {
            from: Task.collection.name,
            localField: "taskId",
            foreignField: "taskId",
            as: "tasks",
          },
        },
        { $match: { tasks: { $size: 0 } } },
        { $count: "count" },
      ])
    : [];
  const legacyProtocol = names.has(Task.collection.name)
    ? await Task.countDocuments({
        status: { $in: ["queued", "sent", "reconciling"] },
        contractVersion: { $ne: 2 },
      })
    : 0;
  const legacyTasks = names.has(Task.collection.name)
    ? await Task.aggregate([
        { $match: { status: { $in: ["queued", "sent", "reconciling"] } } },
        {
          $lookup: {
            from: Outbox.collection.name,
            localField: "taskId",
            foreignField: "operationId",
            as: "outbox",
          },
        },
        { $match: { outbox: { $size: 0 } } },
        { $count: "count" },
      ])
    : [];
  const terminalHolds = names.has(QuotaHold.collection.name)
    ? await QuotaHold.aggregate([
        { $match: { status: "held" } },
        {
          $lookup: {
            from: Task.collection.name,
            localField: "taskId",
            foreignField: "taskId",
            as: "tasks",
          },
        },
        { $match: { "tasks.status": { $in: ["done", "error"] } } },
        { $count: "count" },
      ])
    : [];
  console.log(
    JSON.stringify({
      apply,
      legacyReleasing: releasing,
      legacyProtocolOperations: legacyProtocol,
      legacyUnresolvedTasks: legacyTasks[0]?.count || 0,
      terminalUnresolvedHolds: terminalHolds[0]?.count || 0,
      orphanHolds: orphanHolds[0]?.count || 0,
      ttlIndexesToDrop: ttl.map((index) => index.name),
    }),
  );
  if (!apply) return;
  // Never guess whether a legacy releasing hold already changed its counter.
  if (
    legacyProtocol ||
    releasing ||
    orphanHolds[0]?.count ||
    legacyTasks[0]?.count ||
    terminalHolds[0]?.count
  )
    throw new Error(
      "Reconcile ambiguous legacy holds against agents and tenant counters before applying migration",
    );
  for (const index of ttl) await ResourceLock.collection.dropIndex(index.name!);
  if (names.has(Heartbeat.collection.name)) {
    const indexes = await Heartbeat.collection.indexes();
    for (const index of indexes)
      if (index.key.agentId === 1 && !index.unique)
        await Heartbeat.collection.dropIndex(index.name!);
  }
  await ensureOperationIndexes();
  await db
    .collection<{ _id: string; appliedAt?: Date }>("backendmigrations")
    .updateOne(
      { _id: "distributed-v1" },
      { $setOnInsert: { appliedAt: new Date() } },
      { upsert: true },
    );
  await db
    .collection<{ _id: string; appliedAt?: Date }>("backendmigrations")
    .updateOne(
      { _id: "task-protocol-v2" },
      { $setOnInsert: { appliedAt: new Date() } },
      { upsert: true },
    );
  console.log(
    "distributed-v1 applied; expired locks are retained for reconciliation",
  );
}
void main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
