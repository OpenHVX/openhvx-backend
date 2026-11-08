import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { commandEnvelope } from "../../services/operations/command";
import { parseTaskResult } from "../../lib/schemas/task-result";

test("the command contract matches the shared Go/TypeScript UTF-8 vector", () => {
  const vector = JSON.parse(
    readFileSync(resolve(__dirname, "../fixtures/task-v2.json"), "utf8"),
  );
  const command = JSON.parse(vector.commandBody);
  assert.deepEqual(commandEnvelope(command), {
    contractVersion: 2,
    commandBody: vector.commandBody,
    commandFingerprint: vector.commandFingerprint,
  });
});
test("v2 results require immutable identity, sequence and explicit host outcome", () => {
  const result = {
    contractVersion: 2,
    taskId: "operation",
    operationId: "operation",
    eventId: "event",
    agentId: "agent",
    tenantId: "tenant",
    action: "echo",
    commandFingerprint: "a".repeat(64),
    sequence: 1,
    outcome: "unknown",
    ok: false,
  };
  assert.ok(parseTaskResult(result));
  for (const field of [
    "operationId",
    "eventId",
    "agentId",
    "tenantId",
    "action",
    "commandFingerprint",
    "sequence",
    "outcome",
  ]) {
    const copy = { ...result } as Record<string, unknown>;
    delete copy[field];
    assert.equal(parseTaskResult(copy), null, field);
  }
  assert.equal(parseTaskResult({ ...result, operationId: "other" }), null);
  assert.equal(parseTaskResult({ ...result, ok: true }), null);
  assert.equal(parseTaskResult({ ...result, sequence: 1.5 }), null);
});

test("host path identifiers reject traversal, drive prefixes and reserved Windows names", async () => {
    const { validPathSegment } = await import("../../services/operations/identifiers");
    for (const name of ["../other", "..\\other", "D:other", "CON", "NUL.txt", "vm.", "vm ", "", "a\u0000b"]) assert.equal(validPathSegment(name), false, name);
    assert.equal(validPathSegment("tenant-1"), true);
    assert.equal(validPathSegment("VM Ubuntu 24.04"), true);
});
