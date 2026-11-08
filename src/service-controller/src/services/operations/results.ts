import QuotaHold from "../../models/quota/hold";
import type { Model } from "mongoose";
import type { TaskRecord } from "../../models/Task";
import TenantResource from "../../models/TenantResource";
import Inbox from "../../models/Inbox";
import {
  parseTaskResult,
  type TaskResultPayload,
} from "../../lib/schemas/task-result";
import * as quota from "../quota";
import { releaseLocksForTask } from "../resourceLocks";
import { transaction } from "./transaction";
import { fingerprint } from "./idempotency";
import logger from "../../lib/logger";
const logRes = logger.child("results");
type TaskModelInput = Model<TaskRecord>;

async function onTaskSucceededUpsertTenantLink(
  TaskModel: TaskModelInput,
  payload: TaskResultPayload,
) {
  const task = await TaskModel.findOne(
    { taskId: payload.taskId },
    { action: 1, tenantId: 1, agentId: 1, data: 1 },
  ).lean<{
    action: string;
    tenantId?: string;
    agentId?: string;
    data?: Record<string, unknown>;
  } | null>();
  if (!task?.tenantId || !task?.agentId) return;

  const normTenantId =
    typeof task.tenantId === "string"
      ? task.tenantId.trim().toLowerCase()
      : task.tenantId;
  const { action, agentId, data } = task;
  const hold = await QuotaHold.findOne({ taskId: payload.taskId }).lean();
  const allocation = hold?.reservationVersion === 2 ? hold.deltas : undefined;

  const target = data?.target as { refId?: string } | undefined;
  if (
    target?.refId &&
    ["vm.delete", "vm.power", "disk.delete", "storage.delete"].includes(action)
  ) {
    const result = payload.result as
      | {
          vm?: { guid?: string; id?: string };
          disk?: { refId?: string; id?: string };
        }
      | undefined;
    const returned = action.startsWith("vm.")
      ? result?.vm?.guid || result?.vm?.id
      : result?.disk?.refId || result?.disk?.id;
    if (returned && returned !== target.refId)
      throw new InvalidResult(
        "Result identifies a different resource from the accepted target",
      );
  }
  const haRequested =
    typeof data?.ha === "boolean" ? (data.ha as boolean) : undefined;

  const vmResult = (
    payload.result as { vm?: { guid?: string; name?: string } } | undefined
  )?.vm;
  const vmRefId =
    vmResult?.guid ||
    vmResult?.name ||
    (typeof data?.id === "string"
      ? data.id
      : typeof data?.refId === "string"
        ? data.refId
        : undefined);

  if ((action === "vm.create" || action === "vm.clone") && !vmRefId)
    throw new InvalidResult(
      "Successful VM creation requires a stable resource identity",
    );
  if ((action === "vm.create" || action === "vm.clone") && vmRefId) {
    // Link tenant to VM inventory entry.
    const set: Record<string, unknown> = {};
    if (haRequested !== undefined) set.ha = haRequested;
    if (vmResult?.name) set.name = vmResult.name;

    const update: Record<string, unknown> = {
      $setOnInsert: {
        tenantId: normTenantId,
        assignedAt: new Date(),
        ...(allocation ? { quotaAllocation: allocation } : {}),
      },
      $set: set,
    };
    await TenantResource.updateOne(
      { tenantId: normTenantId, kind: "vm", agentId, refId: vmRefId },
      update,
      { upsert: true },
    );

    if (action === "vm.create") {
      const diskId = typeof data?.diskId === "string" ? data.diskId : "";
      if (diskId) {
        const diskQuery: Record<string, unknown> = {
          tenantId: normTenantId,
          kind: "storage",
          attachedVmRefId: { $in: [null, "", vmRefId] },
          attachedVmAgentId: { $in: [null, "", agentId] },
          $or: [{ refId: diskId }, { name: diskId }],
        };
        if (typeof data?.storageId === "string" && data.storageId) {
          diskQuery.agentId = data.storageId;
        }
        const diskUpdate: Record<string, unknown> = {
          attachedVmRefId: vmRefId,
          attachedVmAgentId: agentId,
          attachedVmName:
            vmResult?.name ||
            (typeof data?.name === "string" ? data.name : undefined),
          attachedAt: new Date(),
        };
        const res = await TenantResource.updateOne(diskQuery, {
          $set: diskUpdate,
        });
        if (!res.matchedCount)
          throw new InvalidResult(
            "VM result references an unowned storage disk",
          );
      }
    }

    return;
  }

  if (action === "vm.delete" && vmRefId) {
    await TenantResource.deleteOne({
      tenantId: normTenantId,
      kind: "vm",
      agentId,
      refId: vmRefId,
    });
    await TenantResource.updateMany(
      {
        tenantId: normTenantId,
        kind: "storage",
        attachedVmAgentId: agentId,
        attachedVmRefId: vmRefId,
      },
      {
        $unset: {
          attachedVmRefId: 1,
          attachedVmAgentId: 1,
          attachedVmName: 1,
          attachedAt: 1,
        },
      },
    );
    return;
  }

  const looksLikeIqn = (value?: string | null) =>
    /^iqn\./i.test(String(value || "").trim());

  if (action === "disk.create" || action === "storage.create") {
    const diskResult = (
      payload.result as
        { disk?: { refId?: string; id?: string; name?: string } } | undefined
    )?.disk;
    const diskRef =
      diskResult?.id ||
      diskResult?.name ||
      (!looksLikeIqn(diskResult?.refId) ? diskResult?.refId : undefined);
    if (!diskRef)
      throw new InvalidResult(
        "Successful disk creation requires a stable resource identity",
      );

    const set: Record<string, unknown> = {};
    if (diskResult?.name) set.name = diskResult.name;
    const res = await TenantResource.updateOne(
      { tenantId: normTenantId, kind: "storage", agentId, refId: diskRef },
      {
        $setOnInsert: {
          tenantId: normTenantId,
          assignedAt: new Date(),
          ...(allocation ? { quotaAllocation: allocation } : {}),
        },
        ...(Object.keys(set).length ? { $set: set } : {}),
      },
      { upsert: true },
    );
    logRes.info("tenant resource upsert (storage create)", {
      taskId: payload.taskId,
      tenantId: normTenantId,
      agentId,
      action,
      diskRef,
      result: diskResult,
      upserted: res.upsertedCount ?? 0,
      matched: res.matchedCount ?? 0,
    });
    return;
  }

  if (action === "disk.delete" || action === "storage.delete") {
    const diskResult = (
      payload.result as
        { disk?: { refId?: string; id?: string; name?: string } } | undefined
    )?.disk;
    const diskRef =
      diskResult?.id ||
      diskResult?.name ||
      (!looksLikeIqn(diskResult?.refId) ? diskResult?.refId : undefined);
    const ref =
      target?.refId ||
      diskRef ||
      (data?.id as string | undefined) ||
      (data?.refId as string | undefined);
    if (!ref) return;
    await TenantResource.deleteOne({
      tenantId: normTenantId,
      kind: "storage",
      agentId,
      refId: ref,
    });
    return;
  }

  if (action === "switch.create") {
    const sw = (payload.result as { switch?: { name?: string } } | undefined)
      ?.switch;
    const switchRef = sw?.name;
    if (!switchRef)
      throw new InvalidResult(
        "Successful switch creation requires a resource identity",
      );
    await TenantResource.updateOne(
      { tenantId: normTenantId, kind: "switch", agentId, refId: switchRef },
      {
        $setOnInsert: {
          tenantId: normTenantId,
          assignedAt: new Date(),
          ...(allocation ? { quotaAllocation: allocation } : {}),
        },
      },
      { upsert: true },
    );
  }
}

export class InvalidResult extends Error {}
export async function applyTaskResult(
  TaskModel: TaskModelInput,
  payload: TaskResultPayload,
  rk = "task.result",
) {
  if (!parseTaskResult(payload))
    throw new InvalidResult("Invalid result schema");
  return transaction(async () => {
    const existing = await TaskModel.findOne({ taskId: payload.taskId }).lean();

    if (!existing) {
      logRes.warn("task result for unknown taskId (ignored)", {
        taskId: payload.taskId,
        rk,
      });
      throw new InvalidResult("Result references an unknown operation");
    }

    if (
      payload.agentId &&
      existing.agentId &&
      payload.agentId !== existing.agentId
    ) {
      logRes.error("task result agent mismatch (dead-lettered)", {
        taskId: payload.taskId,
        expectedAgentId: existing.agentId,
        receivedAgentId: payload.agentId,
        rk,
      });
      throw new InvalidResult("Invalid result producer");
    }

    if (
      (payload.tenantId && payload.tenantId !== existing.tenantId) ||
      (payload.action && payload.action !== existing.action)
    )
      throw new InvalidResult("Result context mismatch");
    if (!payload.agentId || payload.agentId !== existing.agentId)
      throw new InvalidResult("Missing or mismatched agent identity");
    if (
      existing.contractVersion === 2 &&
      (payload.contractVersion !== 2 ||
        payload.operationId !== existing.taskId ||
        payload.commandFingerprint !== existing.commandFingerprint ||
        payload.tenantId !== existing.tenantId ||
        payload.action !== existing.action)
    )
      throw new InvalidResult("Result does not match the accepted command");
    const outcome = payload.outcome || (payload.ok ? "applied" : "unknown");
    const nextStatus =
      outcome === "applied"
        ? "done"
        : outcome === "not_applied"
          ? "error"
          : "reconciling";
    const producer = existing.agentId || "legacy";
    const eventId = payload.eventId || fingerprint(payload);
    const digest = fingerprint(payload);
    const seen = await Inbox.findOne({ producer, eventId }).lean();
    if (seen) {
      if (seen.fingerprint !== digest)
        throw new InvalidResult("Event identity reused with different payload");
      return;
    }
    await Inbox.create({
      producer,
      eventId,
      taskId: payload.taskId,
      fingerprint: digest,
    });
    if (
      payload.contractVersion === 2 &&
      payload.sequence! <= (existing.lastAgentSequence || 0)
    ) {
      if (
        payload.sequence === existing.lastAgentSequence &&
        digest !== existing.lastResultFingerprint
      )
        throw new InvalidResult("Conflicting observation sequence");
      return;
    }
    if (existing.status === "done" || existing.status === "error") {
      if (
        existing.status !== nextStatus ||
        fingerprint(existing.result ?? null) !==
          fingerprint(payload.result ?? null)
      )
        throw new InvalidResult("Contradictory terminal result");
      logRes.info("duplicate terminal task result ignored", {
        taskId: payload.taskId,
        status: existing.status,
        rk,
      });
      return;
    }

    const updateResult = await TaskModel.updateOne(
      {
        taskId: payload.taskId,
        status: { $in: ["queued", "sent", "reconciling"] },
      },
      {
        $set: {
          status: nextStatus,
          outcome,
          ...(payload.sequence
            ? {
                lastAgentSequence: payload.sequence,
                lastResultFingerprint: digest,
              }
            : {}),
          finishedAt:
            outcome === "unknown"
              ? undefined
              : payload.finishedAt
                ? new Date(payload.finishedAt)
                : new Date(),
          result: payload.result ?? null,
          error: payload.error ?? null,
          agentId: payload.agentId || existing.agentId || undefined,
          routingKey: rk,
        },
      },
    );

    if (!updateResult.matchedCount) {
      logRes.info("task result lost terminal transition race (ignored)", {
        taskId: payload.taskId,
        rk,
      });
      return;
    }

    logRes.debug("task result stored", {
      taskId: payload.taskId,
      ok: !!payload.ok,
      rk,
      hadHold: !!existing.hasQuotaHold,
    });

    if (outcome === "applied")
      await onTaskSucceededUpsertTenantLink(TaskModel, payload);

    if (payload.ok && existing.tenantId && existing.agentId) {
      const action = existing.action || "";
      const isCreate = /\.create$/i.test(action);
      if (!isCreate) {
        logRes.info("quota recalc deferred until next inventory refresh", {
          taskId: payload.taskId,
          tenantId: existing.tenantId,
          agentId: existing.agentId,
          action,
        });
      }
    }

    if (outcome === "unknown") return;
    if (existing.hasQuotaHold) {
      const hold = payload.ok
        ? await quota.consumeHold(payload.taskId)
        : await quota.releaseHold(payload.taskId);
      if (!hold || hold.status !== (payload.ok ? "consumed" : "released"))
        throw new InvalidResult(
          "Quota hold is missing or inconsistent with the result",
        );
    }
    await releaseLocksForTask(payload.taskId);
  }).catch(async (error) => {
    if ((error as { code?: number }).code !== 11000) throw error;
    const seen = await Inbox.findOne({
      taskId: payload.taskId,
      eventId: payload.eventId || fingerprint(payload),
    }).lean();
    if (seen && seen.fingerprint === fingerprint(payload)) return;
    throw new InvalidResult(
      "Result conflicts with a unique event or resource identity",
    );
  });
}
