import test from "node:test";
import assert from "node:assert/strict";
import { buildQuotaReleaseSet } from "../../services/quota";

test("quota release subtracts a positive reservation", () => {
  assert.deepEqual(buildQuotaReleaseSet({ storageMB: 1000 }), {
    "quotas.storageMB.used": {
      $max: [
        0,
        { $subtract: [{ $ifNull: ["$quotas.storageMB.used", 0] }, 1000] },
      ],
    },
  });
});

test("quota release reverses a negative delete delta", () => {
  assert.deepEqual(buildQuotaReleaseSet({ storageMB: -1000 }), {
    "quotas.storageMB.used": {
      $max: [
        0,
        { $subtract: [{ $ifNull: ["$quotas.storageMB.used", 0] }, -1000] },
      ],
    },
  });
});

test("an existing disk is charged once; dynamic VM memory reserves its upper bound", async () => {
  const { computeDeltas } = await import("../../services/quota");
  const deltas = computeDeltas("vm.create", {
    cpu: 2,
    ram: "1GB",
    dynamic_memory: true,
    max_ram: "4GB",
    storageMB: 10240,
    diskId: "existing-disk",
  });
  assert.equal(deltas?.storageMB, 0);
  assert.equal(deltas?.memoryMB, 4096);
  assert.equal(deltas?.cpu, 2);
});
