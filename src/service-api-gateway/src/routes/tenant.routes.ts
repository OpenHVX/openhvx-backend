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

    const baseProxy = createProxyMiddleware<Request, Response>({
        target: CONTROLLER_URL,
        changeOrigin: true,
        proxyTimeout: 60_000,
        timeout: 61_000,
        pathRewrite: (path) => `/api/v1/tenant${path}`,
        on: {
            proxyReq: (proxyReq, req) => {
                const tenantId = req.tenantId ?? req.user?.tenantId ?? "";

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

    router.post(
        "/tasks",
        requireTenantInJWT,
        applyPolicy("TenantPolicy.json"),
        ensureAnyRole(writeRoles),
        baseProxy,
    );
    router.get("/tasks/:taskId", requireTenantInJWT, ensureAnyRole(readRoles), baseProxy);
    router.get("/resources", requireTenantInJWT, ensureAnyRole(readRoles), baseProxy);
    router.get("/images", requireTenantInJWT, ensureAnyRole(readRoles), baseProxy);

    router.get("/metrics/overview", requireTenantInJWT, ensureAnyRole(readRoles), baseProxy);

    router.get("/images/:imageId", requireTenantInJWT, ensureAnyRole(readRoles), baseProxy);
    router.get("/images/:imageId/resolve", requireTenantInJWT, ensureAnyRole(readRoles), baseProxy);

    return router;
};
