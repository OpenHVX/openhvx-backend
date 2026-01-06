import { Router, type NextFunction, type Request, type Response } from "express";
import type { ServerResponse } from "http";
import { createProxyMiddleware } from "http-proxy-middleware";
import antiSpoof from "../middlewares/antiSpoof";
import resolveTenantFromToken from "../middlewares/resolveTenantFromToken";
import applyPolicy from "../middlewares/applyPolicy";

interface RouterOptions {
    CONTROLLER_URL: string;
}

const ensureAnyRole = (allowed: string[]) => {
    return (req: Request, res: Response, next: NextFunction): void => {
        const roles = req.user?.roles ?? [];
        if (roles.some((role) => allowed.includes(role))) {
            next();
            return;
        }
        res.status(403).json({ error: "Forbidden: role not allowed" });
    };
};

const requireTenantInJWT = (req: Request, res: Response, next: NextFunction): void => {
    const tenantId = req.tenantId ?? req.user?.tenantId ?? null;
    if (!tenantId) {
        res.status(400).json({ error: "Missing tenant in token" });
        return;
    }
    req.tenantId = tenantId;
    next();
};

export default ({ CONTROLLER_URL }: RouterOptions) => {
    const router = Router();

    const normLower = (value?: string | null) => {
        if (!value) return "";
        const s = value.trim();
        return s ? s.toLowerCase() : "";
    };

    const baseProxy = createProxyMiddleware<Request, Response>({
        target: CONTROLLER_URL,
        changeOrigin: true,
        proxyTimeout: 60_000,
        timeout: 61_000,
        pathRewrite: (path) => `/api/v1/tenant${path}`,
        on: {
            proxyReq: (proxyReq, req) => {
                const tenantId = normLower(req.tenantId ?? req.user?.tenantId ?? "");

                proxyReq.setHeader("x-request-id", req.id ?? "");
                proxyReq.setHeader("x-user-id", req.user?.sub ?? "");
                proxyReq.setHeader("x-roles", (req.user?.roles ?? []).join(","));
                proxyReq.setHeader("x-tenant-id", tenantId);
                proxyReq.setHeader("accept", "application/json");

                const hasBodyObject =
                    req.method !== "GET" &&
                    req.method !== "HEAD" &&
                    req.body &&
                    typeof req.body === "object" &&
                    Object.keys(req.body as Record<string, unknown>).length > 0;

                if (hasBodyObject) {
                    const bodyData = JSON.stringify(req.body);
                    proxyReq.setHeader("content-type", "application/json");
                    proxyReq.setHeader("content-length", Buffer.byteLength(bodyData));
                    proxyReq.write(bodyData);
                }
            },
            error: (_err, _req, res) => {
                const serverRes = res as ServerResponse;
                serverRes.writeHead(502, { "content-type": "application/json" });
                serverRes.end(JSON.stringify({ error: "Upstream controller unavailable" }));
            },
        },
    });

    router.use(antiSpoof());
    router.use(resolveTenantFromToken({ required: true }));

    const readRoles = ["tenant-user-r", "tenant-user-rw", "tenant-admin"];
    const writeRoles = ["tenant-user-rw", "tenant-admin"];

    /**
     * @openapi
     * tags:
     *   - name: Tenant Tasks
     *   - name: Tenant Resources
     *   - name: Tenant Metrics
     *   - name: Tenant Images
     */

    /**
     * @openapi
     * /api/v1/tenant/tasks:
     *   post:
     *     summary: Enqueue a task for the current tenant
     *     tags: [Tenant Tasks]
     *     security:
     *       - bearerAuth: []
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               action: { type: string }
     *               target:
     *                 type: object
     *                 properties:
     *                   kind: { type: string }
     *                   refId: { type: string }
     *                   agentId: { type: string }
     *               data: { type: object }
     *     responses:
     *       200: { description: Task enqueued }
     */
    router.post(
        "/tasks",
        requireTenantInJWT,
        applyPolicy("TenantPolicy.json"),
        ensureAnyRole(writeRoles),
        baseProxy,
    );
    router.get("/tasks/:taskId", requireTenantInJWT, ensureAnyRole(readRoles), baseProxy);

    /**
     * @openapi
     * /api/v1/tenant/resources:
     *   get:
     *     summary: List resources assigned to the current tenant
     *     tags: [Tenant Resources]
     *     responses:
     *       200: { description: OK }
     */
    router.get("/resources", requireTenantInJWT, ensureAnyRole(readRoles), baseProxy);

    /**
     * @openapi
     * /api/v1/tenant/images:
     *   get:
     *     summary: Image catalog for the tenant
     *     tags: [Tenant Images]
     *     parameters:
     *       - in: query
     *         name: q
     *         schema: { type: string }
     *     responses:
     *       200: { description: OK }
     */
    router.get("/images", requireTenantInJWT, ensureAnyRole(readRoles), baseProxy);

    /**
     * @openapi
     * /api/v1/tenant/metrics/overview:
     *   get:
     *     summary: Overview of tenant tasks and resources
     *     tags: [Tenant Metrics]
     *     responses:
     *       200: { description: OK }
     */
    router.get("/metrics/overview", requireTenantInJWT, ensureAnyRole(readRoles), baseProxy);

    /**
     * @openapi
     * /api/v1/tenant/images/{imageId}:
     *   get:
     *     summary: Get image details
     *     tags: [Tenant Images]
     */
    router.get("/images/:imageId", requireTenantInJWT, ensureAnyRole(readRoles), baseProxy);

    /**
     * @openapi
     * /api/v1/tenant/images/{imageId}/resolve:
     *   get:
     *     summary: Resolve an image alias
     *     tags: [Tenant Images]
     */
    router.get("/images/:imageId/resolve", requireTenantInJWT, ensureAnyRole(readRoles), baseProxy);

    return router;
};
