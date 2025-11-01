// @ts-nocheck
// lib/http-errors.js (CommonJS)
// One shape for all errors: { ok:false, code, message, details?, traceId? }

function make(status, code, message, details) {
    return { status, code, message, details };
}

function send(res, err, req) {
    const traceId =
        (req && (req.id || req.requestId)) ||
        (req && req.headers && (req.headers["x-request-id"] || req.headers["x-correlation-id"])) ||
        undefined;

    const status = err.status || 500;
    return res.status(status).json({
        ok: false,
        code: err.code || "INTERNAL_ERROR",
        message: err.message || "Internal server error",
        ...(err.details !== undefined ? { details: err.details } : {}),
        ...(traceId ? { traceId } : {}),
    });
}

// Convenience factories
const ERR = {
    // generic makers
    notFound: (message = "Not found", details) =>
        make(404, "NOT_FOUND", message, details),

    quotaExceeded: (message = "Quota exceeded", details) =>
        make(409, "QUOTA_EXCEEDED", message, details),

    validationPre: (details) =>
        make(422, "VALIDATION_ERROR", "Invalid request payload", { where: "pre", errors: details }),

    internal: () => make(500, "INTERNAL_ERROR", "Internal server error"),

    // tasks/controller specifics
    missingAction: () =>
        make(400, "MISSING_ACTION", "Missing 'action' in body"),

    missingTargetKind: () =>
        make(400, "MISSING_TARGET_KIND", "Missing target.kind"),

    unknownAction: (action) =>
        make(400, "UNKNOWN_ACTION", `Unknown action '${action}'`, { action }),

    missingTargetRefId: (action) =>
        make(400, "MISSING_TARGET_REFID", "Missing target.refId for this action", { action }),

    tenantIdRequiredForAdmin: () =>
        make(400, "TENANT_ID_REQUIRED", "tenantId is required for admin operations"),

    tenantContextMissing: () =>
        make(400, "TENANT_CONTEXT_MISSING", "Missing tenant context"),

    missingAgentId: () =>
        make(400, "MISSING_AGENT_ID", "Missing target.agentId (no election performed or selection failed)"),

    agentNotFound: (agentId) =>
        make(404, "AGENT_NOT_FOUND", "Agent not found (no heartbeat yet)", { agentId }),

    capabilityUnsupported: (needCap, caps, action, agentId) =>
        make(422, "AGENT_CAPABILITY_UNSUPPORTED", "Capability not supported by agent", {
            requiredCapability: needCap,
            agentCapabilities: caps,
            action,
            agentId,
        }),

    forbiddenOwnership: (tenantId, target) =>
        make(403, "FORBIDDEN_OWNERSHIP", "Resource not owned by this tenant", { tenantId, target }),

    enrichFailed: (msg) =>
        make(400, "ENRICH_FAILED", `enrichment failed: ${msg}`),

    taskNotFound: () =>
        make(404, "TASK_NOT_FOUND", "Task not found"),
};

module.exports = { make, send, ERR };
