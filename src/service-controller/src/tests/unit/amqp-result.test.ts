import test from "node:test";
import assert from "node:assert/strict";
import { parseTaskResult } from "../../lib/schemas/task-result";

test("task result parser accepts a valid terminal result", () => {
    assert.deepEqual(
        parseTaskResult({
            taskId: " task-1 ",
            agentId: "agent-1",
            ok: true,
            result: { vm: { guid: "vm-1" } },
            finishedAt: "2026-11-07T12:00:00.000Z",
        }),
        {
            taskId: "task-1",
            agentId: "agent-1",
            ok: true,
            result: { vm: { guid: "vm-1" } },
            finishedAt: "2026-11-07T12:00:00.000Z",
        }
    );
});

test("task result parser rejects malformed or ambiguous results", () => {
    assert.equal(parseTaskResult({ taskId: "task-1" }), null);
    assert.equal(parseTaskResult({ taskId: "task-1", ok: "true" }), null);
    assert.equal(parseTaskResult({ taskId: "task-1", ok: true, finishedAt: "not-a-date" }), null);
    assert.equal(parseTaskResult({ taskId: "", ok: false }), null);
});
