import "dotenv/config";
import mongoose, { Schema } from "mongoose";
import { randomUUID } from "node:crypto";

const leaseSchema = new Schema({
  _id: String,
  tunnelId: String,
  owner: String,
  incarnation: String,
  expiresAt: Date,
  closed: { type: Boolean, default: false },
});
const Lease = mongoose.model("ConsoleLease", leaseSchema);
const usedSchema = new Schema({ _id: String, expiresAt: Date });
usedSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
const Used = mongoose.model("ConsoleTicket", usedSchema);
const incarnation = randomUUID();
const id = process.env.BROKER_ID || "local";
const peers: Record<string, string> = JSON.parse(
  process.env.BROKER_PEERS || '{"local":"http://ws-broker:8081"}',
);
const LEASE_MS = 15000;
const deadlines = new Map<string, number>();
export const ownsTunnel = (tunnelId: string) =>
  (deadlines.get(tunnelId) || 0) > performance.now();
let ready = false;
export async function connectOwnership() {
  if (!peers[id]) throw new Error("BROKER_ID must exist in BROKER_PEERS");
  for (const value of Object.values(peers)) {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== "/"
    )
      throw new Error("Invalid broker peer URL");
  }
  await mongoose.connect(
    process.env.MONGO_URL || "mongodb://mongo:27017/hvwm?replicaSet=rs0",
    { serverSelectionTimeoutMS: 5000, socketTimeoutMS: 5000, writeConcern: { w: "majority", wtimeoutMS: 5000 }, readConcern: { level: "majority" } },
  );
  await Lease.init();
  await Used.init();
  ready = true;
}
export const ownershipReady = () =>
  ready && mongoose.connection.readyState === 1;
export async function routeTunnel(
  payload: { tunnelId: string; tenantId?: string; vmId?: string; exp?: number },
  side: string,
): Promise<string | null> {
  if (!ownershipReady() || !payload.tenantId || !payload.vmId || !payload.exp)
    throw new Error("Invalid console context");
  const key = JSON.stringify([payload.tenantId, payload.vmId]);
  // MongoDB's clock arbitrates expiration. Local monotonic deadlines fence
  // forwarding, including after a process pause or a wall-clock correction.
  const free = { $and: [
    { $lte: [{ $ifNull: ["$expiresAt", new Date(0)] }, "$$NOW"] },
    { $ne: [{ $ifNull: ["$tunnelId", ""] }, { $literal: payload.tunnelId }] },
  ] };
  const update = [{ $set: {
    tunnelId: { $cond: [free, { $literal: payload.tunnelId }, "$tunnelId"] },
    owner: { $cond: [free, { $literal: id }, "$owner"] },
    incarnation: { $cond: [free, { $literal: incarnation }, "$incarnation"] },
    closed: { $cond: [free, false, "$closed"] },
    expiresAt: { $cond: [free, { $add: ["$$NOW", LEASE_MS] }, "$expiresAt"] },
  } }];
  let lease;
  try {
    lease = await Lease.findOneAndUpdate({ _id: key }, update, { upsert: true, new: true }).lean();
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
    lease = await Lease.findOneAndUpdate({ _id: key }, update, { new: true }).lean();
  }
  if (!lease || lease.closed || lease.tunnelId !== payload.tunnelId) throw new Error("Console already owned or expired");
  if (lease.owner !== id) {
    const target = peers[lease.owner || ""];
    if (!target) throw new Error("Unknown console owner");
    return target;
  }
  if (lease.incarnation !== incarnation)
    throw new Error("Previous broker incarnation; reopen console");
  const began = performance.now();
  const current = await Lease.updateOne(
    {
      _id: key,
      tunnelId: payload.tunnelId,
      owner: id,
      incarnation,
      closed: false,
      $expr: { $gt: ["$expiresAt", "$$NOW"] },
    },
    [{ $set: { expiresAt: { $add: ["$$NOW", LEASE_MS] } } }],
  );
  if (!current.matchedCount) throw new Error("Console ownership lost");
  deadlines.set(payload.tunnelId, began + 10000);
  // Consume each side's ticket once, before upgrading. A lost handshake needs
  // a new tunnel: it cannot displace a previously authenticated connection.
  await Used.create({
    _id: `${payload.tunnelId}:${side}`,
    expiresAt: new Date(payload.exp * 1000 + 60000),
  });
  if (!ownsTunnel(payload.tunnelId))
    throw new Error("Console lease check timed out");
  return null;
}
export async function renewOwnership(
  tunnelIds: string[],
): Promise<Set<string>> {
  const live = new Set<string>();
  for (const tunnelId of tunnelIds) {
    const began = performance.now();
    const lease = await Lease.findOneAndUpdate(
      {
        tunnelId,
        owner: id,
        incarnation,
        closed: false,
        $expr: { $gt: ["$expiresAt", "$$NOW"] },
      },
      [{ $set: { expiresAt: { $add: ["$$NOW", LEASE_MS] } } }],
      { new: true },
    ).lean();
    if (lease) {
      deadlines.set(tunnelId, began + 10000);
      if (ownsTunnel(tunnelId)) live.add(tunnelId);
    }
  }
  return live;
}
export async function closeOwnership(tunnelId: string) {
  deadlines.delete(tunnelId);
  await Lease.updateOne(
    { tunnelId, owner: id, incarnation },
    [{ $set: { closed: true, expiresAt: "$$NOW" } }],
  );
}
export async function stopOwnership() {
  ready = false;
  await mongoose.disconnect();
}
