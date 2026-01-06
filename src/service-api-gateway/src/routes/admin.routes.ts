
import { Router, type NextFunction, type Request, type Response } from "express";
import type { ServerResponse } from "http";
import { createProxyMiddleware } from "http-proxy-middleware";
import antiSpoof from "../middlewares/antiSpoof";
import resolveTenantFromToken from "../middlewares/resolveTenantFromToken";

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

export default ({ CONTROLLER_URL }: RouterOptions) => {
    const router = Router();

    const normLower = (value?: string) => {
        if (!value) return "";
        const s = value.trim();
        return s ? s.toLowerCase() : "";
    };

    const baseProxy = createProxyMiddleware<Request, Response>({
        target: CONTROLLER_URL,
        changeOrigin: true,
        proxyTimeout: 60_000,
        timeout: 61_000,
        pathRewrite: (path) => `/api/v1/admin${path}`,
        on: {
            proxyReq: (proxyReq, req) => {
                const tenantId = normLower(req.params?.tenantId);

                proxyReq.setHeader("x-request-id", req.id ?? "");
                proxyReq.setHeader("x-user-id", req.user?.sub ?? "");
                proxyReq.setHeader("x-roles", (req.user?.roles ?? []).join(","));
                if (tenantId) proxyReq.setHeader("x-tenant-id", tenantId);
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
    router.use(resolveTenantFromToken({ required: false }));
    router.use(ensureAnyRole(["global-admin"]));

    /**
     * @openapi
     * tags:
     *   - name: Admin Auth
     *   - name: Tenants
     *   - name: Quotas
     *   - name: Resources
     *   - name: Tasks
     *   - name: Agents
     *   - name: Metrics
     *   - name: Images
     */

    /**
     * @openapi
     * /api/v1/admin/tasks:
     *   post:
     *     summary: Enqueue a task as admin
     *     tags: [Tasks]
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               action:
     *                 type: string
     *                 example: vm.create
     *               target:
     *                 type: object
     *                 properties:
     *                   kind:
     *                     type: string
     *                     enum: [vm, storage, network]
     *                   refId:
     *                     type: string
     *                   agentId:
     *                     type: string
     *               data:
     *                 type: object
     *               tenantId:
     *                 type: string
     *     responses:
     *       200:
     *         description: Task enqueued
     */
    router.post("/tasks", baseProxy);
    router.get("/tasks/:taskId", baseProxy);

    /**
     * @openapi
     * /api/v1/admin/tenants/{tenantId}/resources:
     *   get:
     *     summary: List resources assigned to a tenant
     *     tags: [Resources]
     *     parameters:
     *       - in: path
     *         name: tenantId
     *         required: true
     *         schema: { type: string }
     *       - in: query
     *         name: kind
     *         schema: { type: string, enum: [vm, switch, storage] }
     *       - in: query
     *         name: agentId
     *         schema: { type: string }
     *       - in: query
     *         name: includeOrphans
     *         schema: { type: string, enum: ["true", "false"] }
     *     responses:
     *       200:
     *         description: Liste des ressources du tenant
     */
    router.get("/tenants/:tenantId/resources", baseProxy);

    /**
     * @openapi
     * /api/v1/admin/tenants/{tenantId}/resources/claim:
     *   post:
     *     summary: Assign resources to a tenant
     *     tags: [Resources]
     *     parameters:
     *       - in: path
     *         name: tenantId
     *         required: true
     *         schema: { type: string }
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               kind:
     *                 type: string
     *                 enum: [vm, switch, storage]
     *               agentId:
     *                 type: string
     *               refIds:
     *                 type: array
     *                 items: { type: string }
     *               ha:
     *                 type: boolean
     *     responses:
     *       200: { description: OK }
     */
    router.post("/tenants/:tenantId/resources/claim", baseProxy);

    /**
     * @openapi
     * /api/v1/admin/tenants/{tenantId}/resources/{resourceId}:
     *   delete:
     *     summary: Unassign a resource from a tenant
     *     tags: [Resources]
     *     parameters:
     *       - in: path
     *         name: tenantId
     *         required: true
     *         schema: { type: string }
     *       - in: path
     *         name: resourceId
     *         required: true
     *         schema: { type: string }
     *       - in: query
     *         name: kind
     *         required: true
     *         schema: { type: string, enum: [vm, switch, storage] }
     *       - in: query
     *         name: agentId
     *         required: true
     *         schema: { type: string }
     *     responses:
     *       200: { description: OK }
     */
    router.delete("/tenants/:tenantId/resources/:resourceId", baseProxy);

    /**
     * @openapi
     * /api/v1/admin/resources/unassigned:
     *   get:
     *     summary: List unassigned resources
     *     tags: [Resources]
     *     parameters:
     *       - in: query
     *         name: kind
     *         schema: { type: string, enum: [vm, switch, storage] }
     *       - in: query
     *         name: agentId
     *         schema: { type: string }
     *       - in: query
     *         name: limit
     *         schema: { type: integer }
     *     responses:
     *       200: { description: OK }
     */
    router.get("/resources/unassigned", baseProxy);

    /**
     * @openapi
     * /api/v1/admin/agents:
     *   get:
     *     summary: List known agents
     *     tags: [Agents]
     *     responses:
     *       200: { description: OK }
     */
    router.get("/agents", baseProxy);
    router.get("/agents/:agentId/status", baseProxy);
    router.get("/agents/:agentId/inventory", baseProxy);

    /**
     * @openapi
     * /api/v1/admin/tenants:
     *   get:
     *     summary: List tenants
     *     tags: [Tenants]
     *   post:
     *     summary: Create a tenant
     *     tags: [Tenants]
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               tenantId: { type: string }
     *               name: { type: string }
     *               status: { type: string }
     */
    router.post("/tenants", baseProxy);
    router.get("/tenants", baseProxy);

    /**
     * @openapi
     * /api/v1/admin/tenants/{tenantId}:
     *   get:
     *     summary: Get a tenant
     *     tags: [Tenants]
     *   patch:
     *     summary: Update a tenant
     *     tags: [Tenants]
     *   delete:
     *     summary: Delete a tenant (if no assigned resources)
     *     tags: [Tenants]
     *     parameters:
     *       - in: path
     *         name: tenantId
     *         required: true
     *         schema: { type: string }
     */
    router.get("/tenants/:tenantId", baseProxy);
    router.patch("/tenants/:tenantId", baseProxy);
    router.delete("/tenants/:tenantId", baseProxy);

    /**
     * @openapi
     * /api/v1/admin/tenants/{tenantId}/quotas:
     *   get:
     *     summary: Get quotas for a tenant
     *     tags: [Quotas]
     *   patch:
     *     summary: Update quota limits
     *     tags: [Quotas]
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               limits:
     *                 type: object
     *                 properties:
     *                   cpu: { type: integer }
     *                   memoryMB: { type: integer }
     *                   storageMB: { type: integer }
     *                   vmCount: { type: integer }
     *                   networkCount: { type: integer }
     */
    router.get("/tenants/:tenantId/quotas", baseProxy);
    router.patch("/tenants/:tenantId/quotas", baseProxy);

    /**
     * @openapi
     * /api/v1/admin/tenants/{tenantId}/quotas/reserve:
     *   post:
     *     summary: Reserve quotas (hold) for a taskId
     *     tags: [Quotas]
     */
    router.post("/tenants/:tenantId/quotas/reserve", baseProxy);

    /**
     * @openapi
     * /api/v1/admin/tenants/{tenantId}/quotas/release:
     *   post:
     *     summary: Release a quota reservation
     *     tags: [Quotas]
     */
    router.post("/tenants/:tenantId/quotas/release", baseProxy);

    /**
     * @openapi
     * /api/v1/admin/tenants/{tenantId}/quotas/recalculate:
     *   post:
     *     summary: Recalculate used quotas from inventories
     *     tags: [Quotas]
     */
    router.post("/tenants/:tenantId/quotas/recalculate", baseProxy);

    /**
     * @openapi
     * /api/v1/admin/metrics/overview:
     *   get:
     *     summary: Overview (agents, compute, storage, tasks)
     *     tags: [Metrics]
     */
    router.get("/metrics/overview", baseProxy);

    /**
     * @openapi
     * /api/v1/admin/metrics/compute:
     *   get:
     *     summary: Aggregated compute capacity and per-agent details
     *     tags: [Metrics]
     */
    router.get("/metrics/compute", baseProxy);

    /**
     * @openapi
     * /api/v1/admin/metrics/datastores:
     *   get:
     *     summary: Storage capacities
     *     tags: [Metrics]
     */
    router.get("/metrics/datastores", baseProxy);

    /**
     * @openapi
     * /api/v1/admin/metrics/vms:
     *   get:
     *     summary: List VMs per agent
     *     tags: [Metrics]
     */
    router.get("/metrics/vms", baseProxy);

    /**
     * @openapi
     * /api/v1/admin/metrics/tenant/overview:
     *   get:
     *     summary: Tenant overview (quotas + tasks)
     *     tags: [Metrics]
     *     parameters:
     *       - in: query
     *         name: tenantId
     *         schema: { type: string }
     */
    router.get("/metrics/tenant/overview", baseProxy);

    /**
     * @openapi
     * /api/v1/admin/images:
     *   get:
     *     summary: Image catalog
     *     tags: [Images]
     *     parameters:
     *       - in: query
     *         name: q
     *         schema: { type: string }
     */
    router.get("/images", baseProxy);

    /**
     * @openapi
     * /api/v1/admin/images/{imageId}:
     *   get:
     *     summary: Get an image by id
     *     tags: [Images]
     */
    router.get("/images/:imageId", baseProxy);

    /**
     * @openapi
     * /api/v1/admin/images/{imageId}/resolve:
     *   get:
     *     summary: Resolve an image alias
     *     tags: [Images]
     */
    router.get("/images/:imageId/resolve", baseProxy);

    return router;
};
