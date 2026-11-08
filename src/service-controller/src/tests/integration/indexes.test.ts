import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import TenantResource from "../../models/TenantResource";
import { ensureOperationIndexes } from "../../services/operations/indexes";

let mongo: MongoMemoryReplSet;
before(async () => {
  mongo = await MongoMemoryReplSet.create({
    replSet: { count: 1 }, binary: { version: "7.0.24" },
  });
  await mongoose.connect(mongo.getUri(), { autoIndex: false, autoCreate: false });
});
after(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

test("startup creates ownership uniqueness even with automatic indexing disabled", async () => {
  await ensureOperationIndexes();
  const resource = { kind: "vm", agentId: "host-a", refId: "vm-a" };
  const outcomes = await Promise.allSettled([
    TenantResource.create({ ...resource, tenantId: "tenant-a" }),
    TenantResource.create({ ...resource, tenantId: "tenant-b" }),
  ]);
  assert.equal(outcomes.filter(result => result.status === "fulfilled").length, 1);
  const rejected = outcomes.find(result => result.status === "rejected");
  assert.equal(rejected?.status === "rejected" && rejected.reason.code, 11000);
});

test("startup refuses existing conflicting ownership instead of admitting traffic", async () => {
  await TenantResource.collection.dropIndexes();
  await TenantResource.collection.insertMany([
    { tenantId: "tenant-c", kind: "vm", agentId: "host-b", refId: "vm-b" },
    { tenantId: "tenant-d", kind: "vm", agentId: "host-b", refId: "vm-b" },
  ]);
  await assert.rejects(ensureOperationIndexes(), (error: any) => error.code === 11000);
});
