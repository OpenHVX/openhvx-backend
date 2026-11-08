import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { submitOperation } from "../../services/operations/submit";
import { dispatchOne } from "../../services/operations/outbox";
import { applyTaskResult } from "../../services/operations/results";
import { parseTaskResult } from "../../lib/schemas/task-result";
import Tenant from "../../models/Tenant";
import Task from "../../models/Task";
import Heartbeat from "../../models/Heartbeat";
import Outbox from "../../models/Outbox";
import Inbox from "../../models/Inbox";
import Idempotency from "../../models/Idempotency";
import QuotaHold from "../../models/quota/hold";
import Resources from "../../models/TenantResource";
const agentSource =
  process.env.AGENT_SOURCE_DIR || resolve("../../../openhvx-agent/src");

test(
  "backend and real Go executor recover a process crash without duplicating a simulated host effect",
  {
    skip: !process.env.CI && !process.env.AGENT_SOURCE_DIR &&
      !existsSync(join(agentSource, "testdata/protocol-probe/main.go")),
    timeout: 60000,
  },
  async () => {
    assert.ok(
      existsSync(join(agentSource, "testdata/protocol-probe/main.go")),
      `Agent protocol sources missing at ${agentSource}; check AGENT_SOURCE_DIR and the CI checkout`,
    );
    const directory = await mkdtemp(join(tmpdir(), "openhvx-contract-"));
    const binary = join(directory, "protocol-probe");
    const journal = join(directory, "operations.db");
    let mongo: MongoMemoryReplSet | undefined;
    try {
      await promisify(execFile)(
        "go",
        ["build", "-o", binary, "./testdata/protocol-probe"],
        { cwd: agentSource, timeout: 45000 },
      );
      process.env.INTERNAL_API_SECRET =
        "cross-language-test-secret-32-characters-minimum";
      mongo = await MongoMemoryReplSet.create({
        replSet: { count: 1 },
        binary: { version: "7.0.24" },
      });
      await mongoose.connect(mongo.getUri());
      for (const model of [
        Tenant,
        Task,
        Heartbeat,
        Outbox,
        Inbox,
        Idempotency,
        QuotaHold,
        Resources,
      ])
        await model.init();
      await Tenant.create({
        tenantId: "contract-tenant",
        name: "contract",
        quotas: { storageMB: { used: 0, limit: 1000 } },
      });
      await Heartbeat.create({
        agentId: "probe-storage",
        lastSeen: new Date(),
        capabilities: ["storage", "task.protocol.v2"],
      });
      const accepted = await submitOperation({
        actorId: "user",
        tenantId: "contract-tenant",
        admin: false,
        key: "request",
        action: "disk.create",
        target: { kind: "storage", agentId: "probe-storage" },
        data: { name: "disk", imageId: "image", sizeMB: 100 },
      });
      let command: Record<string, unknown>;
      const runAgent = (mode: string) =>
        new Promise<string>((resolve, reject) => {
          const child = spawn(binary, ["--journal", journal, "--mode", mode], {
            stdio: ["pipe", "pipe", "pipe"],
          });
          let stdout = "",
            stderr = "";
          child.stdout.on("data", (data) => {
            stdout += data;
          });
          child.stderr.on("data", (data) => {
            stderr += data;
          });
          child.on("error", reject);
          child.on("exit", (code) =>
            code === 0
              ? resolve(stdout)
              : reject(
                  new Error(`Agent test process exited ${code}: ${stderr}`),
                ),
          );
          child.stdin.end(JSON.stringify(command));
        });
      // The first host process dies after its effect, before storing a result.
      await dispatchOne(async (payload) => {
        command = { ...payload, operationId: payload.taskId };
        await runAgent("after-effect");
      });
      assert.equal(
        (await Task.findOne({ taskId: accepted.taskId }))?.status,
        "queued",
      );
      await Outbox.updateOne(
        { operationId: accepted.taskId },
        { $set: { availableAt: new Date(0) } },
      );
      // Another agent process consumes the same command, emits unknown, and
      // leaves the quota held. No external effect is executed again.
      await dispatchOne(async () => {
        const event = parseTaskResult(JSON.parse(await runAgent("normal")));
        assert.ok(event);
        assert.equal(event.outcome, "unknown");
        await applyTaskResult(Task, event);
      });
      assert.equal(
        (await Task.findOne({ taskId: accepted.taskId }))?.status,
        "reconciling",
      );
      assert.equal(
        (await QuotaHold.findOne({ taskId: accepted.taskId }))?.status,
        "held",
      );
      // A read-only observation proves completion and emits a newer sequence.
      const resultBytes = await runAgent("recover");
      const result = parseTaskResult(JSON.parse(resultBytes));
      assert.ok(result);
      assert.equal(result.sequence, 2);
      await applyTaskResult(Task, result);
      await applyTaskResult(Task, result);
      assert.equal(
        (await Task.findOne({ taskId: accepted.taskId }))?.status,
        "done",
      );
      assert.equal(
        (await QuotaHold.findOne({ taskId: accepted.taskId }))?.status,
        "consumed",
      );
      assert.equal(
        await Resources.countDocuments({ tenantId: "contract-tenant" }),
        1,
      );
      assert.equal(
        (await Tenant.findOne({ tenantId: "contract-tenant" }))?.quotas
          .storageMB?.used,
        100,
      );
      assert.equal(await runAgent("normal"), resultBytes);
      assert.equal(
        await readFile(journal + ".effects", "utf8"),
        `${accepted.taskId}\n`,
      );
    } finally {
      await mongoose.disconnect();
      await mongo?.stop();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
