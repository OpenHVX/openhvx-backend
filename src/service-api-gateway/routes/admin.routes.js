// api-gateway/src/routes/admin.routes.js
"use strict";

const { createProxyMiddleware } = require("http-proxy-middleware");
const antiSpoof = require("../middlewares/antiSpoof");
const resolveTenantFromToken = require("../middlewares/resolveTenantFromToken");

module.exports = ({ CONTROLLER_URL }) => {
    const router = require("express").Router();

    // --- Local middlewares -----------------------------------------------------
    const ensureAnyRole = (allowed) => (req, res, next) => {
        const u = req.user || {};
        const roles = Array.isArray(u.roles)
            ? u.roles
            : Array.isArray(u.scope)
                ? u.scope
                : typeof u.role === "string"
                    ? [u.role]
                    : [];
        if (roles.some((r) => allowed.includes(r))) return next();
        return res.status(403).json({ error: "Forbidden: role not allowed" });
    };

    // --- Shared proxy (to controller service) ----------------------------------
    const baseProxy = createProxyMiddleware({
        target: CONTROLLER_URL,
        changeOrigin: true,
        proxyTimeout: 60000,
        timeout: 61000,
        // The controller expects paths prefixed with /api/v1/admin/*
        pathRewrite: (path) => `/api/v1/admin${path}`,
        on: {
            proxyReq: (proxyReq, req) => {
                const u = req.user || {};
                const tid = req.params?.tenantId || "";

                proxyReq.setHeader("x-request-id", req.id || "");
                proxyReq.setHeader("x-user-id", u.sub || "");
                proxyReq.setHeader("x-roles", (u.roles || []).join(","));
                if (tid) proxyReq.setHeader("x-tenant-id", tid);
                proxyReq.setHeader("accept", "application/json");

                // Re-stream parsed body from gateway to controller
                if (
                    req.method !== "GET" &&
                    req.method !== "HEAD" &&
                    req.body &&
                    Object.keys(req.body).length
                ) {
                    const bodyData = JSON.stringify(req.body);
                    proxyReq.setHeader("content-type", "application/json");
                    proxyReq.setHeader("content-length", Buffer.byteLength(bodyData));
                    proxyReq.write(bodyData);
                }
            },
            error: (_err, _req, res) => {
                res.writeHead(502, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: "Upstream controller unavailable" }));
            },
        },
    });

    // --- Explicit routes only (no catch-all) -----------------------------------
    router.use(antiSpoof());
    router.use(resolveTenantFromToken({ required: false }));
    // All these routes require the global-admin role
    router.use(ensureAnyRole(["global-admin"]));

    // ---------------------------------------------------------------------------
    // Tasks (admin scope, no tenant restriction)
    // ---------------------------------------------------------------------------
    router.post("/tasks", baseProxy);
    router.get("/tasks/:taskId", baseProxy);

    // ---------------------------------------------------------------------------
    // Tenant resources (scoped by tenantId in path)
    // ---------------------------------------------------------------------------
    router.get("/tenants/:tenantId/resources", baseProxy);
    router.post("/tenants/:tenantId/resources/claim", baseProxy);
    router.delete("/tenants/:tenantId/resources/:resourceId", baseProxy);

    // ---------------------------------------------------------------------------
    // Unassigned resources (global admin only)
    // ---------------------------------------------------------------------------
    router.get("/resources/unassigned", baseProxy);

    // ---------------------------------------------------------------------------
    // Agents (global)
    // ---------------------------------------------------------------------------
    router.get("/agents", baseProxy);
    router.get("/agents/:agentId/status", baseProxy);
    router.get("/agents/:agentId/inventory", baseProxy);

    // ---------------------------------------------------------------------------
    // Tenants (CRUD)
    // ---------------------------------------------------------------------------
    router.post("/tenants", baseProxy);
    router.get("/tenants", baseProxy);
    router.get("/tenants/:tenantId", baseProxy);
    router.patch("/tenants/:tenantId", baseProxy);
    router.delete("/tenants/:tenantId", baseProxy);

    // ---------------------------------------------------------------------------
    // Tenants > Quotas (nested)
    // ---------------------------------------------------------------------------
    router.get("/tenants/:tenantId/quotas", baseProxy);
    router.patch("/tenants/:tenantId/quotas", baseProxy);
    router.post("/tenants/:tenantId/quotas/reserve", baseProxy);
    router.post("/tenants/:tenantId/quotas/release", baseProxy);
    router.post("/tenants/:tenantId/quotas/recalculate", baseProxy);

    // ---------------------------------------------------------------------------
    // Metrics
    // ---------------------------------------------------------------------------
    router.get("/metrics/overview", baseProxy);
    router.get("/metrics/compute", baseProxy);
    router.get("/metrics/datastores", baseProxy);
    router.get("/metrics/vms", baseProxy);
    router.get("/metrics/tenant/overview", baseProxy);

    // ---------------------------------------------------------------------------
    // Images
    // ---------------------------------------------------------------------------
    router.get("/images", baseProxy);
    router.get("/images/:imageId", baseProxy);
    router.get("/images/:imageId/resolve", baseProxy);

    return router;
};
