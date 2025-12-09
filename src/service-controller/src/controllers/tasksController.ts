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
import type { ControllerRequest } from "../types/express";
import { respondEnvelope } from "../middlewares/addEnveloppe";

type Handler = (req: ControllerRequest, res: Response) => Promise<Response | void>;
const log = logger.child(["controller", "tasks"]);

const requiredCapability = (action: string) => {
    const map: Record<string, string> = {
        "inventory.refresh": "inventory",
        "vm.power": "vm.power",
        "vm.delete": "vm.delete",
        "vm.create": "vm.create",
        "vm.clone": "vm.clone",
        "console.serial.open": "console",
        "net.tunnel.open": "console",
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

export const enqueueTask: Handler = async (req, res) => {
    let action: string | undefined;
    let agentId: string | undefined;
    let tenantId: string | null | undefined;
    try {
        // Parse + validate request ------------------------------------------------
        const admin = !!req.isAdmin;
        const body = (req.body || {}) as Record<string, unknown>;

        action = String(body.action || "").trim();
        if (!action) return send(res, ERR.missingAction(), req);

        const target = (body.target && typeof body.target === "object" ? body.target : null) as Record<string, unknown> | null;
        if (!target?.kind) return send(res, ERR.missingTargetKind(), req);

        if (!isKnownAction(action)) return send(res, ERR.unknownAction(action), req);

        const needsRefId = actionRequiresRefId(action);
        if (needsRefId && !target.refId) {
            return send(res, ERR.missingTargetRefId(action), req);
        }

        const pre = preValidate(action, body.data || {});
        if (!pre.ok) return send(res, ERR.validationPre(pre.errors), req);
        const userData = pre.value as Record<string, unknown>;

        tenantId = admin ? ((body.tenantId as string) || getTenantIdFromReq(req)) : getTenantIdFromJWT(req);
        if (!tenantId) {
            return send(res, admin ? ERR.tenantIdRequiredForAdmin() : ERR.tenantContextMissing(), req);
        }

        // Resolve target agent ---------------------------------------------------
        if (action === "vm.create" && !target.agentId) {
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
                refId: target.refId,
                kind: target.kind,
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
                    kind: target.kind,
                    agentId,
                });
            }
        }

        if (!agentId) return send(res, ERR.missingAgentId(), req);

        if (!admin && needsRefId) {
            const link = await TenantResource.findOne({
                tenantId,
                kind: target.kind,
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

        const caps = Array.isArray(hb.capabilities) ? hb.capabilities : [];
        if (!caps.includes(needCap)) {
            return send(res, ERR.capabilityUnsupported(needCap, caps, action, agentId), req);
        }

        const staleMs = Number(process.env.AGENT_STALE_MS || 120000);
        const lastSeen = hb.lastSeen ? new Date(hb.lastSeen).getTime() : 0;
        const agentOnline = !!(lastSeen && Date.now() - lastSeen < staleMs);

        // Enrich payload for agent + quota hold if needed ------------------------
        const data: Record<string, unknown> = { ...userData };
        if (needsRefId && !data.id && target.refId) data.id = target.refId;
        type AgentPayload = Record<string, unknown> & { _console?: unknown };
        let dataForAgent: AgentPayload = { ...data, target };

        let consoleMeta: Record<string, unknown> | undefined;
        const enr = await enrich(action, {
            operation: "auto",
            object: dataForAgent,
            ctx: {
                user: (req.user || undefined) as Record<string, unknown> | undefined,
                refId: (target.refId as string) || undefined,
                tenantId,
                agentId,
            },
        });

        if (enr.ok && enr.data) {
            dataForAgent = enr.data as AgentPayload;
            if (dataForAgent._console) {
                consoleMeta = dataForAgent._console as Record<string, unknown>;
                delete dataForAgent._console;
            }
        } else {
            const isUnsupported =
                enr.error?.startsWith("unsupported action:") || enr.error?.includes("unsupported operation");
            if (!isUnsupported) return send(res, ERR.enrichFailed(enr.error || "unknown"), req);
        }

        const taskId = randomUUID();
        let hasQuotaHold = false;

        const deltas = computeDeltas(action, dataForAgent);
        if (deltas) {
            const tenantObjectId = await getTenantObjectIdOrThrow(tenantId);
            try {
                await holdQuota(tenantObjectId, deltas, taskId, { ttlMs: ttlForAction(action) });
                hasQuotaHold = true;
            } catch (error) {
                const err = error as HttpErrorPayload | undefined;
                if (err?.code === "QUOTA_EXCEEDED" || err?.status === 409) {
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
            data: dataForAgent,
            correlationId: taskId,
            status: "queued",
            queuedAt: new Date(),
            hasQuotaHold,
        });

        const payload: PublishTaskPayload = {
            taskId: doc.taskId,
            tenantId: doc.tenantId,
            agentId: doc.agentId!,
            action: doc.action,
            data: doc.data,
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
        const err = error as Error;
        log.error("enqueueTask error", {
            error: err?.message || err,
            stack: err?.stack,
            action,
            agentId,
            tenantId,
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
