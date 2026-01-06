// Tasks controller:
// - validates and enqueues agent tasks
// - performs capability + ownership checks
// - manages quota holds around long-running actions
// - auto-selects agentId in a few cases (vm.create via election, refId-based via TenantResource)
import type { Response } from "express";
import { randomUUID } from "node:crypto";
import { publishTask, type PublishTaskPayload } from "../services/amqp";
import Task from "../models/Task";
import Heartbeat from "../models/Heartbeat";
import TenantResource from "../models/TenantResource";
import InventoryFull from "../models/Inventory.full";
import { enrich } from "../lib/enrich";
import { election } from "../services/election";
import { isKnownAction, preValidate } from "../lib/schemas/task";
import { ERR, send, type HttpErrorPayload } from "../lib/errors/http-errors";
import logger from "../lib/logger";
import {
    computeDeltas,
    DEFAULT_HOLD_TTL_MS,
    getTenantObjectIdOrThrow,
    holdQuota,
} from "../services/quota";
import { acquireResourceLock, releaseLocksForTask, isHttpErrorPayload } from "../services/resourceLocks";
import type { ControllerRequest } from "../types/express";
import { respondEnvelope } from "../middlewares/addEnveloppe";

type Handler = (req: ControllerRequest, res: Response) => Promise<Response | void>;
const log = logger.child(["controller", "tasks"]);

const STORAGE_CONTROLLER_ROUTE = process.env.STORAGE_CONTROLLER_AGENT_ID || process.env.STORAGE_CONTROLLER_ROUTE;

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

const actionRequiresRefId = (action: string) => {
    if (/^console\.serial\.open$/i.test(action)) return true;
    if (/^net\.tunnel\.open$/i.test(action)) return true;
    if (/^(disk|storage)\.(delete|attach|detach|resize)$/i.test(action)) return true;
    return /^vm\.(delete|power|start|stop|restart|resize|attach|detach|snapshot|revert|rename|clone)$/i.test(action);
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

const getTenantIdFromReq = (req: ControllerRequest): string | null => {
    return (
        req?.tenant?.tenantId ||
        req?.tenantId ||
        (req.body?.tenantId as string | undefined) ||
        (req.query?.tenantId as string | undefined) ||
        null
    );
};

const getTenantIdFromJWT = (req: ControllerRequest) => req?.tenant?.tenantId || req?.tenantId || null;
const normalizeTenantId = (id: string | null | undefined) =>
    typeof id === "string" ? id.trim().toLowerCase() || null : null;

export const enqueueTask: Handler = async (req, res) => {
    let action: string | undefined;
    let agentId: string | undefined;
    let tenantId: string | null | undefined;
    let taskId: string | undefined;
    let targetSnapshot: Record<string, unknown> | null = null;
    let dataSnapshot: Record<string, unknown> | null = null;
    let hasResourceLock = false;
    let storageAgentIdForDisk: string | null = null;
    try {
        // Parse + validate request ------------------------------------------------
        const admin = !!req.isAdmin;
        const body = (req.body || {}) as Record<string, unknown>;

        action = String(body.action || "").trim();
        if (!action) return send(res, ERR.missingAction(), req);

        const target = (body.target && typeof body.target === "object" ? body.target : null) as Record<string, unknown> | null;
        if (!target?.kind) return send(res, ERR.missingTargetKind(), req);
        const targetKind = String(target.kind).toLowerCase();
        const knownKinds = new Set(["vm", "storage", "network"]);
        if (!knownKinds.has(targetKind)) return send(res, ERR.missingTargetKind(), req);
        targetSnapshot = target as Record<string, unknown>;

        if (!isKnownAction(action)) return send(res, ERR.unknownAction(action), req);

        const needsRefId = actionRequiresRefId(action);
        if (needsRefId && !target.refId) {
            return send(res, ERR.missingTargetRefId(action), req);
        }

        const pre = preValidate(action, body.data || {});
        if (!pre.ok) return send(res, ERR.validationPre(pre.errors), req);
        const userData = pre.value as Record<string, unknown>;
        dataSnapshot = userData;

        tenantId = normalizeTenantId(
            admin ? ((body.tenantId as string) || getTenantIdFromReq(req)) : getTenantIdFromJWT(req)
        );
        if (!tenantId) {
            return send(res, admin ? ERR.tenantIdRequiredForAdmin() : ERR.tenantContextMissing(), req);
        }

        // Resolve target agent ---------------------------------------------------
        // Storage controller is a singleton for now; default to its route if caller did not specify.
        if (targetKind === "storage" && !target.agentId && STORAGE_CONTROLLER_ROUTE) {
            target.agentId = STORAGE_CONTROLLER_ROUTE;
            body.target = { ...target };
        }

        // Compute: elect a fresh agent with required capability when none is provided.
        if (targetKind === "vm" && action === "vm.create" && !target.agentId) {
            const freshness = Number(process.env.AGENT_FRESHNESS_SEC || 60);
            const needCap = requiredCapability(action);
            const agentIdSelected = await election({ freshness, capabilities: [needCap] });
            target.agentId = agentIdSelected;
            body.target = { ...target };
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
                body.target = { ...target };
                log.debug("auto-selected agentId from TenantResource", {
                    tenantId,
                    refId: target.refId,
                    kind: targetKind,
                    agentId,
                });
            }
        }

        if (!agentId) return send(res, ERR.missingAgentId(), req);

        if (!admin && needsRefId) {
            // Tenants can only act on resources they own (link exists for tenant/kind/agent/refId).
            const link = await TenantResource.findOne({
                tenantId,
                kind: targetKind,
                agentId,
                refId: target.refId,
            }).lean();
            if (!link) {
                return send(res, ERR.forbiddenOwnership(tenantId, target), req);
            }
        }

        const needCap = requiredCapability(action);
        const hb = await Heartbeat.findOne({ agentId }).lean();
        if (!hb) return send(res, ERR.agentNotFound(agentId), req);

        // Capability gate: agent must declare support for the requested action prefix.
        const caps = Array.isArray(hb.capabilities) ? hb.capabilities : [];
        if (!caps.includes(needCap)) {
            return send(res, ERR.capabilityUnsupported(needCap, caps, action, agentId), req);
        }

        taskId = randomUUID();

        if (action === "vm.create") {
            // Enforce disk ownership + exclusivity before enqueue:
            const diskId = typeof userData.diskId === "string" ? userData.diskId : "";
            if (!diskId) {
                return send(res, ERR.validationPre([{ path: "data.diskId", message: "diskId is required" }]), req);
            }

            const storageLink = await TenantResource.findOne({
                tenantId,
                kind: "storage",
                $or: [{ refId: diskId }, { name: diskId }],
            }).lean();
            if (!storageLink) {
                return send(
                    res,
                    ERR.validationPre([{ path: "data.diskId", message: "storage disk not found or not assigned to tenant" }]),
                    req
                );
            }
            if (storageLink.attachedVmRefId || storageLink.attachedVmAgentId) {
                const vmHint = storageLink.attachedVmName || storageLink.attachedVmRefId;
                return send(
                    res,
                    ERR.validationPre([
                        {
                            path: "data.diskId",
                            message: vmHint
                                ? `disk already attached to vm ${vmHint}`
                                : "disk already attached to a vm",
                        },
                    ]),
                    req
                );
            }
            storageAgentIdForDisk = storageLink.agentId || null;

            // A disk can be attached to only one VM (checked from latest inventory snapshot).
            const inv = await InventoryFull.findOne({ agentId }, { inventory: 1 }).lean<{
                inventory?: { vms?: Array<{ disks?: Array<{ storageRefId?: string; storageId?: string }> }> };
            }>();
            const vms = (inv?.inventory?.vms || []) as Array<{ disks?: Array<{ storageRefId?: string; storageId?: string }> }>;
            const inUse = vms.some((vm) =>
                (vm.disks || []).some((disk) => {
                    const ids = [disk.storageRefId, disk.storageId].filter(Boolean).map((v) => String(v));
                    return ids.includes(diskId);
                })
            );
            if (inUse) {
                return send(res, ERR.validationPre([{ path: "data.diskId", message: "disk already attached to a VM" }]), req);
            }

            const lockTtl = ttlForAction(action);
            // Hard lock the disk so concurrent vm.create on the same diskId fail immediately.
            try {
                await acquireResourceLock({
                    resourceKind: "storage",
                    refId: diskId,
                    taskId,
                    tenantId: tenantId || undefined,
                    agentId,
                    action,
                    ttlMs: lockTtl,
                });
                hasResourceLock = true;
            } catch (error) {
                if (isHttpErrorPayload(error)) {
                    return send(res, error, req);
                }
                throw error;
            }
        }

        const staleMs = Number(process.env.AGENT_STALE_MS || 120000);
        const lastSeen = hb.lastSeen ? new Date(hb.lastSeen).getTime() : 0;
        const agentOnline = !!(lastSeen && Date.now() - lastSeen < staleMs);

        // Enrich payload for agent + quota hold if needed ------------------------
        const data: Record<string, unknown> = { ...userData };
        if (needsRefId && !data.id && target.refId) data.id = target.refId;
        type AgentPayload = Record<string, unknown> & { _console?: unknown };
        let dataForTask: AgentPayload = { ...data, target };
        let dataForAgent: AgentPayload = dataForTask;

        let consoleMeta: Record<string, unknown> | undefined;
        const enr = await enrich(action, {
            operation: "auto",
            object: dataForAgent,
            ctx: {
                user: (req.user || undefined) as Record<string, unknown> | undefined,
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
                enr.error?.startsWith("unsupported action:") || enr.error?.includes("unsupported operation");
            if (!isUnsupported) return send(res, ERR.enrichFailed(enr.error || "unknown"), req);
        }

        if (action === "vm.create") {
            if (!dataForTask.storageId && storageAgentIdForDisk) {
                dataForTask.storageId = storageAgentIdForDisk;
            }
            const iqn = typeof dataForTask.iqn === "string" ? dataForTask.iqn : "";
            if (!iqn) {
                return send(
                    res,
                    ERR.validationPre([
                        { path: "data.diskId", message: "storage disk IQN not found for provided diskId" },
                    ]),
                    req
                );
            }
            const portalCandidate = dataForTask.portal;
            const portal =
                portalCandidate && typeof portalCandidate === "object"
                    ? {
                          ...(typeof (portalCandidate as Record<string, unknown>).host === "string"
                              ? { host: (portalCandidate as Record<string, unknown>).host as string }
                              : {}),
                          ...(typeof (portalCandidate as Record<string, unknown>).ip === "string"
                              ? { ip: (portalCandidate as Record<string, unknown>).ip as string }
                              : {}),
                      }
                    : undefined;
            delete dataForTask.iqn;
            delete dataForTask.portal;
            dataForAgent = { ...dataForTask, iqn, ...(portal ? { portal } : {}) };
        }

        let hasQuotaHold = false;

        const deltas = computeDeltas(action, dataForTask);
        if (deltas) {
            // Hold tenant quota before enqueue to avoid overcommit; released/consumed via task results.
            try {
                const tenantObjectId = await getTenantObjectIdOrThrow(tenantId);
                await holdQuota(tenantObjectId, deltas, taskId, { ttlMs: ttlForAction(action) });
                hasQuotaHold = true;
            } catch (error) {
                const err = error as HttpErrorPayload | undefined;
                if (err?.code === "QUOTA_EXCEEDED" || err?.status === 409 || err?.status === 404) {
                    // Quota failure after we locked the disk: release the lock to avoid leaving it blocked.
                    if (hasResourceLock && taskId) {
                        try {
                            await releaseLocksForTask(taskId);
                        } catch (releaseError) {
                            log.warn("failed to release resource lock after quota error", {
                                taskId,
                                error: (releaseError as Error)?.message || releaseError,
                            });
                        }
                    }
                    return send(res, err, req);
                }
                throw error;
            }
        }

        const doc = await Task.create({
            taskId,
            tenantId,
            agentId,
            action,
            data: dataForTask,
            correlationId: taskId,
            status: "queued",
            queuedAt: new Date(),
            hasQuotaHold,
        });

        // Persist, publish to agent queue, update status for tracking.
        const payload: PublishTaskPayload = {
            taskId: doc.taskId,
            tenantId: doc.tenantId,
            agentId: doc.agentId!,
            action: doc.action,
            data: dataForAgent,
            correlationId: doc.correlationId || undefined,
        };
        await publishTask(payload);
        await Task.updateOne({ taskId }, { $set: { status: "sent", publishedAt: new Date() } });

        const base = admin ? "/api/v1/admin" : "/api/v1/tenant";
        const resp: Record<string, unknown> = {
            queued: true,
            taskId,
            agentOnline,
            statusUrl: `${base}/tasks/${taskId}`,
        };
        if (consoleMeta) resp.console = consoleMeta;

        return respondEnvelope(res.status(202), req, "Tasks", resp);
    } catch (error) {
        // Any failure during enqueue: release held resource locks to keep resources usable.
        if (hasResourceLock && taskId) {
            try {
                await releaseLocksForTask(taskId);
            } catch (releaseError) {
                log.warn("failed to release resource lock after enqueue error", {
                    taskId,
                    error: (releaseError as Error)?.message || releaseError,
                });
            }
        }
        const err = error as Error;
        log.error("enqueueTask error", {
            error: err?.message || err,
            stack: err?.stack,
            action,
            agentId,
            tenantId,
            admin: !!req.isAdmin,
            target: targetSnapshot,
            dataKeys: dataSnapshot ? Object.keys(dataSnapshot) : null,
        });
        return send(res, ERR.internal(), req);
    }
};

export const getTask: Handler = async (req, res) => {
    try {
        const admin = !!req.isAdmin;
        const { taskId } = req.params;

        if (admin) {
            const doc = await Task.findOne({ taskId }).lean();
            if (!doc) return send(res, ERR.taskNotFound(), req);
            return respondEnvelope(res, req, "Tasks", { success: true, data: doc });
        }

        const tenantId = getTenantIdFromJWT(req);
        if (!tenantId) return send(res, ERR.tenantContextMissing(), req);

        const doc = await Task.findOne({ taskId, tenantId }).lean();
        if (!doc) return send(res, ERR.taskNotFound(), req);

        return respondEnvelope(res, req, "Tasks", { success: true, data: doc });
    } catch (error) {
        log.error("getTask error", { error });
        return send(res, ERR.internal(), req);
    }
};
