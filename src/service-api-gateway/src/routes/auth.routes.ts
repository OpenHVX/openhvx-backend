import { Router, type NextFunction, type Request, type Response } from "express";
import type { ServerResponse } from "http";
import { createProxyMiddleware } from "http-proxy-middleware";

interface RouterOptions {
    AUTH_URL: string;
}

const stripSpoofableHeaders = (req: Request, _res: Response, next: NextFunction): void => {
    const headers = req.headers as Record<string, unknown>;
    delete headers["x-tenant-id"];
    delete headers["x-tenant"];
    delete headers["x-roles"];
    delete headers["x-user-id"];
    next();
};

const ensureBearer = (req: Request, res: Response, next: NextFunction): void => {
    const auth = req.headers.authorization ?? "";
    if (!/^Bearer\s+\S+/.test(auth)) {
        res.status(401).json({ error: "Missing Bearer token" });
        return;
    }
    next();
};

const ensureApiKey = (req: Request, res: Response, next: NextFunction): void => {
    if (!req.headers["x-api-key"]) {
        res.status(401).json({ error: "Missing x-api-key" });
        return;
    }
    next();
};

const makeProxy = (authUrl: string, rewritePath: (path: string, req: Request) => string) =>
    createProxyMiddleware<Request, Response>({
        target: authUrl,
        changeOrigin: true,
        proxyTimeout: 60_000,
        timeout: 61_000,
        pathRewrite: (path, req) => rewritePath(path, req),
        on: {
            proxyReq: (proxyReq, req) => {
                proxyReq.setHeader("x-request-id", req.id ?? "");
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
                serverRes.end(JSON.stringify({ error: "Upstream auth service unavailable" }));
            },
        },
    });

export default ({ AUTH_URL }: RouterOptions) => {
    const router = Router();

    router.post(
        "/login",
        stripSpoofableHeaders,
        (req, _res, next) => {
            delete (req.headers as Record<string, unknown>).authorization;
            next();
        },
        makeProxy(AUTH_URL, () => "/auth/login"),
    );

    router.post("/register", stripSpoofableHeaders, ensureApiKey, makeProxy(AUTH_URL, () => "/auth/register"));

    router.get("/me", stripSpoofableHeaders, ensureBearer, makeProxy(AUTH_URL, () => "/users/me"));

    router.get("/userinfo", stripSpoofableHeaders, ensureBearer, makeProxy(AUTH_URL, () => "/auth/userinfo"));

    router.post("/introspect", stripSpoofableHeaders, makeProxy(AUTH_URL, () => "/auth/introspect"));

    return router;
};
