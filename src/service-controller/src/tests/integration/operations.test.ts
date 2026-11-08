import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { transaction } from "../../services/operations/transaction";
import { holdQuota, releaseHold } from "../../services/quota";
import {
  applyTaskResult,
  InvalidResult,
} from "../../services/operations/results";
import Tenant from "../../models/Tenant";
import Task from "../../models/Task";
import QuotaHold from "../../models/quota/hold";
import Inbox from "../../models/Inbox";
import Outbox from "../../models/Outbox";
import Idempotency from "../../models/Idempotency";
let mongo: MongoMemoryReplSet;
before(async () => {
  mongo = await MongoMemoryReplSet.create({
    replSet: { count: 1 },
    binary: { version: "7.0.24" },
  });
  await mongoose.connect(mongo.getUri());
  for (const model of [Tenant, Task, QuotaHold, Inbox, Outbox, Idempotency])
    await model.init();
});
after(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});
async function tenant(id: string) {
  return Tenant.create({
    tenantId: id,
    name: id,
    quotas: { storageMB: { used: 10000, limit: 20000 } },
  });
}
test("a transaction rolls back Task, quota, hold and outbox together", async () => {
  const t = await tenant("rollback");
  await assert.rejects(
    transaction(async () => {
      await holdQuota(t._id, { storageMB: 1000 }, "aborted");
      await Task.create({ taskId: "aborted", action: "disk.create" });
      await Outbox.create({
        eventId: "aborted",
        operationId: "aborted",
        payload: {},
      });
      throw new Error("crash before commit");
    }),
  );
  assert.equal((await Tenant.findById(t._id))?.quotas.storageMB?.used, 10000);
  assert.equal(await QuotaHold.countDocuments({ taskId: "aborted" }), 0);
  assert.equal(await Task.countDocuments({ taskId: "aborted" }), 0);
  assert.equal(await Outbox.countDocuments({ operationId: "aborted" }), 0);
});
test("concurrent release of a negative delta restores quota once", async () => {
  const t = await tenant("release");
  await holdQuota(t._id, { storageMB: -1000 }, "delete");
  await Promise.all(Array.from({ length: 8 }, () => releaseHold("delete")));
  assert.equal((await Tenant.findById(t._id))?.quotas.storageMB?.used, 10000);
  assert.equal(
    (await QuotaHold.findOne({ taskId: "delete" }))?.status,
    "released",
  );
});
test("concurrent duplicate results commit a single quota effect; contradictions rejected", async () => {
  const t = await tenant("results");
  await holdQuota(t._id, { storageMB: -1000 }, "result");
  await Task.create({
    taskId: "result",
    action: "disk.delete",
    agentId: "agent-a",
    tenantId: "results",
    hasQuotaHold: true,
  });
  const payload = {
    taskId: "result",
    eventId: "event-result",
    agentId: "agent-a",
    ok: false,
    outcome: "not_applied" as const,
  };
  await Promise.all(
    Array.from({ length: 5 }, () => applyTaskResult(Task, payload)),
  );
  assert.equal((await Tenant.findById(t._id))?.quotas.storageMB?.used, 10000);
  assert.equal(await Inbox.countDocuments({ eventId: "event-result" }), 1);
  assert.equal((await Task.findOne({ taskId: "result" }))?.status, "error");
  await assert.rejects(
    applyTaskResult(Task, { ...payload, eventId: "contradiction", ok: true }),
    InvalidResult,
  );
  assert.equal(await Inbox.countDocuments({ eventId: "contradiction" }), 0);
});

test("deletion does not free quota until success", async () => {
  const t = await tenant("delete-success");
  await holdQuota(t._id, { storageMB: -1000 }, "delete-success");
  assert.equal((await Tenant.findById(t._id))?.quotas.storageMB?.used, 10000);
  await Task.create({
    taskId: "delete-success",
    action: "disk.delete",
    agentId: "agent-a",
    tenantId: "delete-success",
    hasQuotaHold: true,
  });
  await applyTaskResult(Task, {
    taskId: "delete-success",
    agentId: "agent-a",
    ok: true,
  });
  assert.equal((await Tenant.findById(t._id))?.quotas.storageMB?.used, 9000);
});

test("outbox reclaims an expired publisher lease and keeps event identity across uncertain delivery", async () => {
  const { dispatchOne } = await import("../../services/operations/outbox");
  const { seal } = await import("../../services/operations/secrets");
  process.env.INTERNAL_API_SECRET =
    "test-internal-secret-32-characters-minimum";
  await Task.create({ taskId: "delivery", action: "echo" });
  await Outbox.create({
    eventId: "stable-event",
    operationId: "delivery",
    state: "sending",
    owner: "dead-process",
    leaseUntil: new Date(0),
    payload: seal({
      taskId: "delivery",
      agentId: "agent-a",
      action: "echo",
      data: {},
    }),
  });
  const delivered: string[] = [];
  await dispatchOne(async (payload) => {
    delivered.push(payload.eventId!);
    throw new Error("crash after broker accepted");
  });
  assert.equal((await Task.findOne({ taskId: "delivery" }))?.status, "queued");
  await Outbox.updateOne(
    { eventId: "stable-event" },
    { $set: { availableAt: new Date(0) } },
  );
  await dispatchOne(async (payload) => {
    delivered.push(payload.eventId!);
  });
  assert.deepEqual(delivered, ["stable-event", "stable-event"]);
  assert.equal((await Task.findOne({ taskId: "delivery" }))?.status, "sent");
  assert.equal(
    (await Outbox.findOne({ eventId: "stable-event" }))?.payload,
    undefined,
  );
});

test("an old inventory cannot overwrite a newer snapshot", async () => {
  const { saveSnapshot } = await import("../../services/operations/snapshots");
  const { default: Inventory } = await import("../../models/Inventory.full");
  await Inventory.init();
  await saveSnapshot(
    Inventory,
    { agentId: "ordered" },
    { agentId: "ordered", ts: new Date(2000), inventory: { marker: "new" } },
  );
  await saveSnapshot(
    Inventory,
    { agentId: "ordered" },
    { agentId: "ordered", ts: new Date(1000), inventory: { marker: "old" } },
  );
  assert.equal(
    (
      (await Inventory.findOne({ agentId: "ordered" }))?.inventory as Record<
        string,
        unknown
      >
    )?.marker,
    "new",
  );
});

test("a resource ownership conflict rolls back the task transition and quota effects", async () => {
  const { default: Resource } = await import("../../models/TenantResource");
  await Resource.init();
  const t = await tenant("conflicting-result");
  await holdQuota(t._id, { storageMB: 100 }, "conflicting-result");
  await Resource.create({
    tenantId: "other-tenant",
    kind: "vm",
    agentId: "agent-a",
    refId: "already-owned",
  });
  await Task.create({
    taskId: "conflicting-result",
    action: "vm.create",
    agentId: "agent-a",
    tenantId: "conflicting-result",
    hasQuotaHold: true,
  });
  await assert.rejects(
    applyTaskResult(Task, {
      taskId: "conflicting-result",
      agentId: "agent-a",
      ok: true,
      result: { vm: { guid: "already-owned" } },
    }),
    InvalidResult,
  );
  assert.equal(
    (await Task.findOne({ taskId: "conflicting-result" }))?.status,
    "queued",
  );
  assert.equal(
    (await QuotaHold.findOne({ taskId: "conflicting-result" }))?.status,
    "held",
  );
  assert.equal(await Inbox.countDocuments({ taskId: "conflicting-result" }), 0);
  assert.equal(
    (await Resource.findOne({ refId: "already-owned" }))?.tenantId,
    "other-tenant",
  );
});

test("v2 unknown execution keeps holds and locks until a matching final observation commits", async () => {
  const { default: Locks } = await import("../../models/ResourceLock");
  await Locks.init();
  const t = await tenant("uncertain-v2");
  const id = "uncertain-v2";
  const hash = "a".repeat(64);
  await holdQuota(t._id, { storageMB: 100 }, id);
  await Task.create({
    taskId: id,
    tenantId: id,
    agentId: "agent-a",
    action: "echo",
    hasQuotaHold: true,
    contractVersion: 2,
    commandFingerprint: hash,
  });
  await Locks.create({
    taskId: id,
    resourceKind: "vm",
    refId: "agent-a:vm",
    expiresAt: new Date(0),
  });
  const uncertain = {
    contractVersion: 2,
    taskId: id,
    operationId: id,
    eventId: "unknown-v2",
    tenantId: id,
    agentId: "agent-a",
    action: "echo",
    commandFingerprint: hash,
    sequence: 1,
    outcome: "unknown" as const,
    ok: false,
  };
  await applyTaskResult(Task, uncertain);
  assert.equal((await Task.findOne({ taskId: id }))?.status, "reconciling");
  assert.equal((await QuotaHold.findOne({ taskId: id }))?.status, "held");
  assert.equal(await Locks.countDocuments({ taskId: id }), 1);
  const final = {
    ...uncertain,
    eventId: "applied-v2",
    sequence: 2,
    outcome: "applied" as const,
    ok: true,
    result: { completed: true },
  };
  await applyTaskResult(Task, final);
  await applyTaskResult(Task, { ...uncertain, eventId: "delayed-v2" });
  assert.equal((await Task.findOne({ taskId: id }))?.status, "done");
  assert.equal((await Task.findOne({ taskId: id }))?.lastAgentSequence, 2);
  assert.equal((await QuotaHold.findOne({ taskId: id }))?.status, "consumed");
  assert.equal(await Locks.countDocuments({ taskId: id }), 0);
  await assert.rejects(
    applyTaskResult(Task, {
      ...final,
      eventId: "wrong-hash-v2",
      commandFingerprint: "b".repeat(64),
    }),
    InvalidResult,
  );
  await assert.rejects(
    applyTaskResult(Task, {
      ...final,
      eventId: "wrong-resource-v2",
      sequence: 3,
      result: { completed: false },
    }),
    InvalidResult,
  );
});

test("a legacy execution error is uncertain rather than proof that the host did nothing", async () => {
  const t = await tenant("legacy-uncertain");
  await holdQuota(t._id, { storageMB: 100 }, "legacy-uncertain");
  await Task.create({
    taskId: "legacy-uncertain",
    tenantId: "legacy-uncertain",
    agentId: "agent-a",
    action: "echo",
    hasQuotaHold: true,
  });
  await applyTaskResult(Task, {
    taskId: "legacy-uncertain",
    agentId: "agent-a",
    ok: false,
  });
  assert.equal(
    (await Task.findOne({ taskId: "legacy-uncertain" }))?.status,
    "reconciling",
  );
  assert.equal(
    (await QuotaHold.findOne({ taskId: "legacy-uncertain" }))?.status,
    "held",
  );
});

test("a missing hold aborts the entire result instead of acknowledging partial effects", async () => {
  await Task.create({
    taskId: "missing-hold",
    action: "echo",
    agentId: "agent-a",
    hasQuotaHold: true,
  });
  await assert.rejects(
    applyTaskResult(Task, {
      taskId: "missing-hold",
      eventId: "missing-hold-result",
      agentId: "agent-a",
      ok: true,
    }),
    InvalidResult,
  );
  assert.equal(
    (await Task.findOne({ taskId: "missing-hold" }))?.status,
    "queued",
  );
  assert.equal(
    await Inbox.countDocuments({ eventId: "missing-hold-result" }),
    0,
  );
});

test("concurrent identical submissions reserve once and replay before resource preconditions", async () => {
  const { submitOperation } = await import("../../services/operations/submit");
  const { default: Heartbeat } = await import("../../models/Heartbeat");
  const { unseal } = await import("../../services/operations/secrets");
  await Heartbeat.init();
  const t = await tenant("submit-once");
  await Heartbeat.create({
    agentId: "storage-v2",
    lastSeen: new Date(),
    capabilities: ["storage", "task.protocol.v2"],
  });
  const input = {
    actorId: "actor",
    tenantId: "submit-once",
    admin: false,
    key: "request",
    action: "disk.create",
    target: { kind: "storage", agentId: "storage-v2" },
    data: { name: "disk", imageId: "image", sizeMB: 100 },
  };
  const replies = await Promise.all(
    Array.from({ length: 8 }, () => submitOperation(input)),
  );
  assert.ok(replies.every((reply) => reply.taskId === replies[0].taskId));
  assert.equal(await Task.countDocuments({ tenantId: "submit-once" }), 1);
  assert.equal(await QuotaHold.countDocuments({ tenantId: t._id }), 1);
  assert.equal((await Tenant.findById(t._id))?.quotas.storageMB?.used, 10100);
  const event = await Outbox.findOne({ operationId: replies[0].taskId }).lean();
  const command = unseal<{ commandBody: string; commandFingerprint: string }>(
    event!.payload,
  );
  assert.equal(JSON.parse(command.commandBody).operationId, replies[0].taskId);
  // Replaying does not depend on a fresh agent or its current capabilities.
  await Heartbeat.deleteOne({ agentId: "storage-v2" });
  assert.deepEqual(await submitOperation(input), replies[0]);
  await assert.rejects(
    submitOperation({ ...input, data: { ...input.data, sizeMB: 200 } }),
  );
});

test("pending host work prevents unclaim or tenant deletion, including expired locks", async () => {
  const { releaseResourceOwnership, deleteTenant, claimResourceOwnership } =
    await import("../../services/operations/ownership");
  const { default: Locks } = await import("../../models/ResourceLock");
  const { default: Resources } = await import("../../models/TenantResource");
  await tenant("ownership-guard");
  await claimResourceOwnership(
    "ownership-guard",
    "vm",
    "agent-a",
    "guarded-vm",
  );
  await Task.create({
    taskId: "guarded-operation",
    tenantId: "ownership-guard",
    agentId: "agent-a",
    action: "vm.delete",
    status: "reconciling",
  });
  await Locks.create({
    taskId: "guarded-operation",
    resourceKind: "vm",
    refId: "agent-a:guarded-vm",
    expiresAt: new Date(0),
  });
  await assert.rejects(
    releaseResourceOwnership("ownership-guard", "vm", "agent-a", "guarded-vm"),
  );
  await assert.rejects(deleteTenant("ownership-guard"));
  assert.equal(
    await Resources.countDocuments({ tenantId: "ownership-guard" }),
    1,
  );
  assert.equal(await Tenant.countDocuments({ tenantId: "ownership-guard" }), 1);
});

test("VM deletion reverses the persisted allocation once and retains its independently charged disk", async () => {
  const { default: Resource } = await import("../../models/TenantResource");
  const { default: Heartbeat } = await import("../../models/Heartbeat");
  const { submitOperation } = await import("../../services/operations/submit");
  const t = await tenant("vm-allocation");
  const createId = "allocated-vm-create";
  await Resource.create({
    kind: "storage",
    agentId: "storage-a",
    tenantId: "vm-allocation",
    refId: "allocated-disk",
  });
  await holdQuota(
    t._id,
    { cpu: 2, memoryMB: 1024, storageMB: 0, vmCount: 1 },
    createId,
  );
  await Task.create({
    taskId: createId,
    tenantId: "vm-allocation",
    agentId: "compute-a",
    action: "vm.create",
    hasQuotaHold: true,
    data: { diskId: "allocated-disk", storageId: "storage-a" },
  });
  await applyTaskResult(Task, {
    taskId: createId,
    agentId: "compute-a",
    ok: true,
    result: { vm: { guid: "11111111-1111-4111-8111-111111111111", name: "vm" } },
  });
  assert.equal(
    (await Resource.findOne({ refId: "11111111-1111-4111-8111-111111111111" }))?.quotaAllocation?.cpu,
    2,
  );
  await Heartbeat.create({
    agentId: "compute-a",
    lastSeen: new Date(),
    capabilities: ["vm.delete", "task.protocol.v2"],
  });
  const accepted = await submitOperation({
    tenantId: "vm-allocation",
    actorId: "actor",
    admin: false,
    action: "vm.delete",
    key: "delete-allocated-vm",
    target: { kind: "vm", refId: "11111111-1111-4111-8111-111111111111", agentId: "compute-a" },
    data: {},
  });
  const deletion = await Task.findOne({ taskId: accepted.taskId }).lean();
  assert.ok(deletion);
  const result = {
    contractVersion: 2,
    taskId: deletion.taskId,
    operationId: deletion.taskId,
    eventId: "delete-allocated-result",
    agentId: "compute-a",
    tenantId: "vm-allocation",
    action: "vm.delete",
    commandFingerprint: deletion.commandFingerprint,
    sequence: 1,
    outcome: "applied" as const,
    ok: true,
    result: { vm: { guid: "11111111-1111-4111-8111-111111111111" } },
  };
  await applyTaskResult(Task, result);
  await applyTaskResult(Task, result);
  const quotas = (await Tenant.findById(t._id))?.quotas;
  assert.equal(quotas?.cpu?.used, 0);
  assert.equal(quotas?.memoryMB?.used, 0);
  assert.equal(quotas?.vmCount?.used, 0);
  assert.equal(quotas?.storageMB?.used, 10000);
  assert.equal(await Resource.countDocuments({ refId: "11111111-1111-4111-8111-111111111111" }), 0);
  assert.equal(await Resource.countDocuments({ refId: "allocated-disk" }), 1);
  assert.equal(
    (await Resource.findOne({ refId: "allocated-disk" }))?.attachedVmRefId,
    undefined,
  );
});

test("contradictory VM aliases and invalid storage sizes cannot leave accepted operations", async () => {
    const { submitOperation } = await import("../../services/operations/submit");
    await tenant("alias-guard");
    await assert.rejects(submitOperation({ actorId: "actor", tenantId: "alias-guard", admin: false, key: "contradiction", action: "vm.power", target: { kind: "vm", agentId: "agent-a", refId: "11111111-1111-4111-8111-111111111111" }, data: { guid: "22222222-2222-4222-8222-222222222222", state: "start" } }));
    assert.equal(await Idempotency.countDocuments({ scope: JSON.stringify(["alias-guard", "actor", false, "vm.power"]) }), 0);
    assert.equal(await Task.countDocuments({ tenantId: "alias-guard" }), 0);
    for (const sizeMB of [0, -1]) await assert.rejects(submitOperation({ actorId: "actor", tenantId: "alias-guard", admin: false, key: "invalid-size", action: "disk.create", target: { kind: "storage", agentId: "agent-a" }, data: { name: "disk", imageId: "image", sizeMB } }));
});
