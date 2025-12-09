import type { Response } from "express";
import type { ControllerRequest } from "../../types/express";
import { envelope, scopeForReq } from "../../middlewares/addEnveloppe";

export interface HttpErrorPayload {
    status: number;
    code: string;
    message: string;
    details?: unknown;
}

export type HttpErrorFactory<T extends unknown[] = []> = (...args: T) => HttpErrorPayload;

export function make(status: number, code: string, message: string, details?: unknown): HttpErrorPayload {
    return { status, code, message, details };
}

export function send(res: Response, err: HttpErrorPayload, req?: ControllerRequest) {
    const traceId =
        req?.id ||
        (req?.headers &&
            (req.headers["x-request-id"] ||
                req.headers["x-correlation-id"])) ||
        undefined;

    const status = err.status || 500;
    const kind = (req as { envelopeKind?: string } | undefined)?.envelopeKind || "Errors";
    const scope = req ? scopeForReq(req) : "tenant";
    return res.status(status).json(envelope(scope, kind, {
        ok: false,
        code: err.code || "INTERNAL_ERROR",
        message: err.message || "Internal server error",
        ...(err.details !== undefined ? { details: err.details } : {}),
        ...(traceId ? { traceId } : {}),
    }));
}

export const ERR = {
    notFound: (message = "Not found", details?: unknown) => make(404, "NOT_FOUND", message, details),

    quotaExceeded: (message = "Quota exceeded", details?: unknown) =>
        make(409, "QUOTA_EXCEEDED", message, details),

    validationPre: (details: unknown) =>
        make(422, "VALIDATION_ERROR", "Invalid request payload", { where: "pre", errors: details }),

    internal: () => make(500, "INTERNAL_ERROR", "Internal server error"),

    missingAction: () => make(400, "MISSING_ACTION", "Missing 'action' in body"),

    missingTargetKind: () => make(400, "MISSING_TARGET_KIND", "Missing target.kind"),

    unknownAction: (action: string) => make(400, "UNKNOWN_ACTION", `Unknown action '${action}'`, { action }),

    missingTargetRefId: (action: string) =>
        make(400, "MISSING_TARGET_REFID", "Missing target.refId for this action", { action }),

    tenantIdRequiredForAdmin: () => make(400, "TENANT_ID_REQUIRED", "tenantId is required for admin operations"),

    tenantContextMissing: () => make(400, "TENANT_CONTEXT_MISSING", "Missing tenant context"),

    missingAgentId: () => make(400, "MISSING_AGENT_ID", "Missing target.agentId (no election performed or selection failed)"),

    agentNotFound: (agentId: string) =>
        make(404, "AGENT_NOT_FOUND", "Agent not found (no heartbeat yet)", { agentId }),

    capabilityUnsupported: (needCap: string, caps: string[], action: string, agentId: string) =>
        make(422, "AGENT_CAPABILITY_UNSUPPORTED", "Capability not supported by agent", {
            requiredCapability: needCap,
            agentCapabilities: caps,
            action,
            agentId,
        }),

    forbiddenOwnership: (tenantId: string, target: unknown) =>
        make(403, "FORBIDDEN_OWNERSHIP", "Resource not owned by this tenant", { tenantId, target }),

    enrichFailed: (msg: string) => make(400, "ENRICH_FAILED", `enrichment failed: ${msg}`),

    taskNotFound: () => make(404, "TASK_NOT_FOUND", "Task not found"),
} as const;
