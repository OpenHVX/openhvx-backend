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

    const baseProxy = createProxyMiddleware<Request, Response>({
        target: CONTROLLER_URL,
        changeOrigin: true,
        proxyTimeout: 60_000,
        timeout: 61_000,
        pathRewrite: (path) => `/api/v1/admin${path}`,
        on: {
            proxyReq: (proxyReq, req) => {
                const tenantId = req.params?.tenantId ?? "";

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

    router.post("/tasks", baseProxy);
    router.get("/tasks/:taskId", baseProxy);

    router.get("/tenants/:tenantId/resources", baseProxy);
    router.post("/tenants/:tenantId/resources/claim", baseProxy);
    router.delete("/tenants/:tenantId/resources/:resourceId", baseProxy);

    router.get("/resources/unassigned", baseProxy);

    router.get("/agents", baseProxy);
    router.get("/agents/:agentId/status", baseProxy);
    router.get("/agents/:agentId/inventory", baseProxy);

    router.post("/tenants", baseProxy);
    router.get("/tenants", baseProxy);
    router.get("/tenants/:tenantId", baseProxy);
    router.patch("/tenants/:tenantId", baseProxy);
    router.delete("/tenants/:tenantId", baseProxy);

    router.get("/tenants/:tenantId/quotas", baseProxy);
    router.patch("/tenants/:tenantId/quotas", baseProxy);
    router.post("/tenants/:tenantId/quotas/reserve", baseProxy);
    router.post("/tenants/:tenantId/quotas/release", baseProxy);
    router.post("/tenants/:tenantId/quotas/recalculate", baseProxy);

    router.get("/metrics/overview", baseProxy);
    router.get("/metrics/compute", baseProxy);
    router.get("/metrics/datastores", baseProxy);
    router.get("/metrics/vms", baseProxy);
    router.get("/metrics/tenant/overview", baseProxy);

    router.get("/images", baseProxy);
    router.get("/images/:imageId", baseProxy);
    router.get("/images/:imageId/resolve", baseProxy);

    return router;
};
