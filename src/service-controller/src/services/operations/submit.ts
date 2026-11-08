import { validPathSegment } from "./identifiers";
import { fenceTenant } from "./ownership";
import { isKnownAction, preValidate } from "../../lib/schemas/task";
import { commandEnvelope, TASK_PROTOCOL_CAPABILITY } from "./command";
import { randomUUID } from "node:crypto";
import Task from "../../models/Task";
import Idempotency from "../../models/Idempotency";
import Outbox from "../../models/Outbox";
import Heartbeat from "../../models/Heartbeat";
import TenantResource from "../../models/TenantResource";
import InventoryFull from "../../models/Inventory.full";
import { enrich } from "../../lib/enrich";
import { ERR, make } from "../../lib/errors/http-errors";
import {
  AGENT_ELECTION_FRESHNESS_SEC,
  AGENT_STALE_MS,
} from "../../lib/config/agents";
import { election } from "../election";
import {
  parseSizeToMB,
  computeDeltas,
  DEFAULT_HOLD_TTL_MS,
  getTenantObjectIdOrThrow,
  holdQuota,
} from "../quota";
import { acquireResourceLock } from "../resourceLocks";
import type { PublishTaskPayload } from "../amqp";
import { transaction } from "./transaction";
import { fingerprint } from "./idempotency";
import { seal, unseal } from "./secrets";
import logger from "../../lib/logger";
const log = logger.child("submit-operation");
const STORAGE_CONTROLLER_ROUTE =
  process.env.STORAGE_CONTROLLER_AGENT_ID ||
  process.env.STORAGE_CONTROLLER_ROUTE;

const hasCapability = (declared: string[], needed: string) =>
  declared.some((cap) => needed === cap || needed.startsWith(`${cap}.`));

const requiredCapability = (action: string) => {
  const map: Record<string, string> = {
    "inventory.refresh": "inventory",
    "vm.power": "vm.power",
    "vm.delete": "vm.delete",
    "vm.create": "vm.create",
    "vm.clone": "vm.clone",
    "console.serial.open": "console",
    "net.tunnel.open": "console",
    "disk.create": "storage",
    "disk.delete": "storage",
    "storage.create": "storage",
    "storage.delete": "storage",
    echo: "echo",
  };
  if (map[action]) return map[action];
  const dot = action.indexOf(".");
  const prefix = dot > 0 ? action.slice(0, dot) : action;
  return prefix;
};

export const requiresReference = (action: string) => {
  if (/^console\.serial\.open$/i.test(action)) return true;
  if (/^net\.tunnel\.open$/i.test(action)) return true;
  if (/^(disk|storage)\.(delete|attach|detach|resize)$/i.test(action))
    return true;
  return /^vm\.(delete|power|start|stop|restart|resize|attach|detach|snapshot|revert|rename|clone)$/i.test(
    action,
  );
};

const ttlForAction = (action: string) => {
  switch (action) {
    case "vm.create":
    case "vm.edit":
      return 30 * 60 * 1000;
    case "vm.clone":
      return 45 * 60 * 1000;
    default:
      return DEFAULT_HOLD_TTL_MS;
  }
};

export interface Submission {
  actorId: string;
  tenantId: string;
  admin: boolean;
  key: string;
  action: string;
  target: Record<string, unknown> & { kind: string };
  data: Record<string, unknown>;
  user?: Record<string, unknown>;
}
export async function submitOperation(
  input: Submission,
): Promise<Record<string, unknown>> {
  const { actorId, tenantId, admin, key, action, user } = input;
  if (!actorId || !tenantId || !key || key.length > 200)
    throw ERR.validationPre(["actor, tenant and idempotency key are required"]);
  if (!validPathSegment(tenantId)) throw ERR.validationPre(["tenantId must be a valid host path component"]);
  if (["disk.create", "storage.create"].includes(action) && (!Number.isSafeInteger(input.data.sizeMB) || Number(input.data.sizeMB) <= 0)) throw ERR.validationPre(["Storage sizeMB must be a positive integer"]);
  if (!isKnownAction(action)) throw ERR.unknownAction(action);
  const parsed = preValidate(action, input.data);
  if (!parsed.ok) throw ERR.validationPre(parsed.errors);
  const expectedKind = /^(disk|storage)\./.test(action) ? "storage" : "vm";
  if (input.target.kind !== expectedKind)
    throw ERR.validationPre(["target.kind does not match the action"]);
  if (requiresReference(action) && !input.target.refId)
    throw ERR.missingTargetRefId(action);
  if (["vm.delete", "vm.power"].includes(action) && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(input.target.refId))) throw ERR.validationPre(["VM commands require the canonical Hyper-V GUID"]);
  if (action === "vm.create") {
    if (!validPathSegment(input.data.name)) throw ERR.validationPre(["VM name must be a valid host path component"]);
    const ram = parseSizeToMB(input.data.ram as string);
    if (
      !ram ||
      ram < 32 ||
      (input.data.cpu !== undefined &&
        (!Number.isInteger(input.data.cpu) || Number(input.data.cpu) < 1))
    )
      throw ERR.validationPre([
        "vm.create requires positive CPU and at least 32 MiB RAM",
      ]);
    for (const field of ["min_ram", "max_ram"])
      if (
        input.data[field] !== undefined &&
        !parseSizeToMB(input.data[field] as string)
      )
        throw ERR.validationPre([`Invalid ${field}`]);
    if (
      input.data.dynamic_memory &&
      (!input.data.max_ram ||
        parseSizeToMB(input.data.max_ram as string) < ram ||
        (input.data.min_ram &&
          parseSizeToMB(input.data.min_ram as string) > ram))
    )
      throw ERR.validationPre([
        "Dynamic memory requires max_ram >= ram and min_ram <= ram",
      ]);
  }

  const scope = JSON.stringify([tenantId, actorId, admin, action]);
  const digest = fingerprint({
    action,
    target: input.target,
    data: input.data,
  });
  const taskId = randomUUID();
  const eventId = randomUUID();
  const replay = (entry: { fingerprint: string; response: any }) => {
    if (entry.fingerprint !== digest)
      throw make(
        409,
        "IDEMPOTENCY_CONFLICT",
        "Idempotency key reused with different content",
      );
    return unseal<Record<string, unknown>>(entry.response);
  };
  try {
    return await transaction(async () => {
      const existing = await Idempotency.findOne({ scope, key }).lean();
      if (existing) return replay(existing);
      // Acquire the logical request before reading resources or choosing an
      // agent. An identical concurrent loser returns the committed winner.
      await Idempotency.create({
        scope,
        key,
        fingerprint: digest,
        taskId,
        response: seal({}),
      });
      await fenceTenant(tenantId, admin);
      const target = structuredClone(input.target);
      const targetKind = target.kind;
      const userData = structuredClone(input.data);
      const needsRefId = requiresReference(action);
      if (needsRefId) {
        for (const alias of ["id", "guid", "refId"]) {
          if (userData[alias] !== undefined && userData[alias] !== target.refId)
            throw ERR.validationPre([
              { path: `data.${alias}`, message: "must match target.refId" },
            ]);
        }
      }

      let agentId: string | undefined;
      let storageAgentIdForDisk: string | null = null;
      let storageRefIdForDisk: string | null = null;
      let ownedAllocation: Record<string, number> | undefined;
      // Resolve target agent ---------------------------------------------------
      // Storage controller is a singleton for now; default to its route if caller did not specify.
      if (
        targetKind === "storage" &&
        !target.agentId &&
        STORAGE_CONTROLLER_ROUTE
      ) {
        target.agentId = STORAGE_CONTROLLER_ROUTE;
      }

      // Compute: elect a fresh agent with required capability when none is provided.
      if (targetKind === "vm" && action === "vm.create" && !target.agentId) {
        const freshness = AGENT_ELECTION_FRESHNESS_SEC;
        const needCap = requiredCapability(action);
        const agentIdSelected = await election({
          freshness,
          capabilities: [needCap, TASK_PROTOCOL_CAPABILITY],
        });
        if (!agentIdSelected) {
          throw ERR.noEligibleAgent(needCap, { freshness, targetKind, action });
        }
        target.agentId = agentIdSelected;
      }

      agentId = target?.agentId as string | undefined;
      if (!agentId && needsRefId) {
        // Auto-pick agentId from TenantResource when there is a single match for this refId/kind.
        const linkQuery: Record<string, unknown> = {
          kind: targetKind,
          refId: target.refId,
        };
        if (tenantId) linkQuery.tenantId = tenantId;
        const links = await TenantResource.find(linkQuery, { agentId: 1 })
          .limit(2)
          .lean<Array<{ agentId?: string }>>();
        if (links.length === 1 && links[0].agentId) {
          agentId = links[0].agentId;
          target.agentId = agentId;
          log.debug("auto-selected agentId from TenantResource", {
            tenantId,
            refId: target.refId,
            kind: targetKind,
            agentId,
          });
        }
      }

      if (!agentId) throw ERR.missingAgentId();

      if (needsRefId) {
        // Tenants can only act on resources they own (link exists for tenant/kind/agent/refId).
        const link = await TenantResource.findOne({
          tenantId,
          kind: targetKind,
          agentId,
          refId: target.refId,
        }).lean();
        if (!link) {
          throw ERR.forbiddenOwnership(tenantId, target);
        }
        ownedAllocation = link.quotaAllocation;
      }

      const needCap = requiredCapability(action);
      const hb = await Heartbeat.findOne({ agentId }).lean();
      if (!hb) throw ERR.agentNotFound(agentId);

      // Capability gate: agent must declare support for the requested action prefix.
      const caps = Array.isArray(hb.capabilities) ? hb.capabilities : [];
      if (!caps.includes(TASK_PROTOCOL_CAPABILITY))
        throw ERR.capabilityUnsupported(
          TASK_PROTOCOL_CAPABILITY,
          caps,
          action,
          agentId,
        );
      if (!hasCapability(caps.map(String), needCap)) {
        throw ERR.capabilityUnsupported(needCap, caps, action, agentId);
      }

      if (action === "vm.create") {
        // Enforce disk ownership + exclusivity before enqueue:
        const diskId =
          typeof userData.diskId === "string" ? userData.diskId : "";
        if (!diskId) {
          throw ERR.validationPre([
            { path: "data.diskId", message: "diskId is required" },
          ]);
        }

        const storageLinks = await TenantResource.find({
          tenantId,
          kind: "storage",
          $or: [{ refId: diskId }, { name: diskId }],
        })
          .limit(2)
          .lean();
        if (storageLinks.length > 1)
          throw ERR.validationPre([
            "Ambiguous storage disk identity; provide its canonical refId",
          ]);
        const storageLink = storageLinks[0];
        if (!storageLink) {
          throw ERR.validationPre([
            {
              path: "data.diskId",
              message: "storage disk not found or not assigned to tenant",
            },
          ]);
        }
        if (storageLink.attachedVmRefId || storageLink.attachedVmAgentId) {
          const vmHint =
            storageLink.attachedVmName || storageLink.attachedVmRefId;
          throw ERR.validationPre([
            {
              path: "data.diskId",
              message: vmHint
                ? `disk already attached to vm ${vmHint}`
                : "disk already attached to a vm",
            },
          ]);
        }
        storageAgentIdForDisk = storageLink.agentId || null;
        storageRefIdForDisk = storageLink.refId;

        // A disk can be attached to only one VM (checked from latest inventory snapshot).
        const inv = await InventoryFull.findOne(
          { agentId },
          { inventory: 1 },
        ).lean<{
          inventory?: {
            vms?: Array<{
              disks?: Array<{ storageRefId?: string; storageId?: string }>;
            }>;
          };
        }>();
        const vms = (inv?.inventory?.vms || []) as Array<{
          disks?: Array<{ storageRefId?: string; storageId?: string }>;
        }>;
        const inUse = vms.some((vm) =>
          (vm.disks || []).some((disk) => {
            const ids = [disk.storageRefId, disk.storageId]
              .filter(Boolean)
              .map((v) => String(v));
            return ids.includes(diskId);
          }),
        );
        if (inUse) {
          throw ERR.validationPre([
            { path: "data.diskId", message: "disk already attached to a VM" },
          ]);
        }
      }

      const staleMs = AGENT_STALE_MS;
      const lastSeen = hb.lastSeen ? new Date(hb.lastSeen).getTime() : 0;
      const agentOnline = !!(lastSeen && Date.now() - lastSeen < staleMs);

      // Enrich payload for agent + quota hold if needed ------------------------
      const data: Record<string, unknown> = { ...userData };
      if (action === "vm.create") data.diskId = storageRefIdForDisk;
      if (needsRefId && !data.id && target.refId) data.id = target.refId;
      type AgentPayload = Record<string, unknown> & { _console?: unknown };
      let dataForTask: AgentPayload = { ...data, target };
      let dataForAgent: AgentPayload = dataForTask;

      let consoleMeta: Record<string, unknown> | undefined;
      const enr = await enrich(action, {
        operation: "auto",
        object: dataForAgent,
        ctx: {
          user: user as Record<string, unknown> | undefined,
          refId: (target.refId as string) || undefined,
          tenantId,
          agentId,
          storageAgentId: storageAgentIdForDisk || undefined,
        },
      });

      if (enr.ok && enr.data) {
        dataForTask = enr.data as AgentPayload;
        dataForAgent = dataForTask;
        if (dataForTask._console) {
          consoleMeta = dataForTask._console as Record<string, unknown>;
          delete dataForTask._console;
        }
      } else {
        const isUnsupported =
          enr.error?.startsWith("unsupported action:") ||
          enr.error?.includes("unsupported operation");
        if (!isUnsupported) throw ERR.enrichFailed(enr.error || "unknown");
      }

      if (action === "vm.create") {
        if (!dataForTask.storageId && storageAgentIdForDisk) {
          dataForTask.storageId = storageAgentIdForDisk;
        }
        const iqn = typeof dataForTask.iqn === "string" ? dataForTask.iqn : "";
        if (!iqn) {
          throw ERR.validationPre([
            {
              path: "data.diskId",
              message: "storage disk IQN not found for provided diskId",
            },
          ]);
        }
        const portalCandidate = dataForTask.portal;
        const portal =
          portalCandidate && typeof portalCandidate === "object"
            ? {
                ...(typeof (portalCandidate as Record<string, unknown>).host ===
                "string"
                  ? {
                      host: (portalCandidate as Record<string, unknown>)
                        .host as string,
                    }
                  : {}),
                ...(typeof (portalCandidate as Record<string, unknown>).ip ===
                "string"
                  ? {
                      ip: (portalCandidate as Record<string, unknown>)
                        .ip as string,
                    }
                  : {}),
              }
            : undefined;
        delete dataForTask.iqn;
        delete dataForTask.portal;
        dataForAgent = { ...dataForTask, iqn, ...(portal ? { portal } : {}) };
      }

      if (consoleMeta) {
        dataForAgent = { ...dataForAgent };
        dataForTask = { ...dataForTask };
        delete dataForTask.ticket;
        delete dataForTask.agentWsUrl;
      }

      const deltas =
        /^(vm|disk|storage)\.delete$/.test(action) && ownedAllocation
          ? Object.fromEntries(
              Object.entries(ownedAllocation).map(([key, value]) => [
                key,
                -value,
              ]),
            )
          : computeDeltas(action, dataForTask);

      const base = admin ? "/api/v1/admin" : "/api/v1/tenant";
      const resp: Record<string, unknown> = {
        accepted: true,
        delivery: "pending",
        queued: true,
        taskId,
        agentOnline,
        statusUrl: `${base}/tasks/${taskId}`,
      };
      if (consoleMeta) resp.console = consoleMeta;

      if (needsRefId) {
        const owned = await TenantResource.updateOne(
          { tenantId, kind: targetKind, agentId, refId: target.refId },
          { $inc: { __v: 1 } },
        );
        if (!owned.matchedCount)
          throw ERR.forbiddenOwnership(tenantId!, target);
      }
      if (
        needsRefId &&
        !action!.startsWith("console.") &&
        action !== "net.tunnel.open"
      )
        await acquireResourceLock({
          resourceKind: targetKind,
          refId: `${agentId}:${target.refId}`,
          taskId: taskId!,
          tenantId: tenantId!,
          agentId,
          action,
          ttlMs: ttlForAction(action),
        });
      if (action === "vm.create") {
        const available = await TenantResource.updateOne(
          {
            tenantId,
            kind: "storage",
            agentId: storageAgentIdForDisk,
            refId: storageRefIdForDisk,
            attachedVmRefId: { $in: [null, ""] },
            attachedVmAgentId: { $in: [null, ""] },
          },
          { $inc: { __v: 1 } },
        );
        if (!available.matchedCount)
          throw ERR.resourceLocked("storage", String(userData.diskId));
        await acquireResourceLock({
          resourceKind: "storage",
          refId: `${storageAgentIdForDisk}:${storageRefIdForDisk}`,
          taskId: taskId!,
          tenantId: tenantId!,
          agentId,
          action,
          ttlMs: ttlForAction(action),
        });
      }
      if (deltas) {
        const tenantObjectId = await getTenantObjectIdOrThrow(tenantId!);
        await holdQuota(tenantObjectId, deltas, taskId!, {
          ttlMs: ttlForAction(action),
        });
      }
      const envelope = commandEnvelope({
        operationId: taskId,
        tenantId,
        agentId,
        action,
        data: dataForAgent,
      });
      await Task.create({
        taskId,
        tenantId,
        agentId,
        action,
        data: dataForTask,
        contractVersion: 2,
        commandFingerprint: envelope.commandFingerprint,
        correlationId: taskId,
        status: "queued",
        queuedAt: new Date(),
        hasQuotaHold: !!deltas,
      });
      const payload: PublishTaskPayload = {
        taskId,
        tenantId,
        agentId,
        action,
        data: dataForAgent,
        correlationId: taskId,
        ...envelope,
      };
      await Outbox.create({
        eventId,
        operationId: taskId,
        contractVersion: 2,
        payload: seal(payload),
      });
      await Idempotency.updateOne(
        { scope, key },
        { $set: { response: seal(resp) } },
      );
      return resp;
    });
  } catch (error) {
    if ((error as { code?: number }).code === 11000) {
      const existing = await Idempotency.findOne({ scope, key }).lean();
      if (existing) return replay(existing);
    }
    throw error;
  }
}
