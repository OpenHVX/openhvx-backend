import type { NextFunction, Request, Response } from "express";
import type { RequestHandler } from "express";
import type { ServerResponse } from "http";
import { createProxyMiddleware } from "http-proxy-middleware";

export type HostKind = "admin" | "tenant" | "unknown";

export const hostKind = (req: Request): HostKind => {
    const host = (req.headers.host ?? "").toLowerCase();
    if (host.startsWith("admin-api.")) return "admin";
    if (host.startsWith("api.")) return "tenant";
    return "unknown";
};

export const ensureHost = (expected: Exclude<HostKind, "unknown">): RequestHandler => {
    return (req: Request, res: Response, next: NextFunction) => {
        const kind = hostKind(req);
        if (kind !== expected) {
            return res.status(404).json({ error: "not found" });
        }
        return next();
    };
};

export const stripSpoofable: RequestHandler = (req, _res, next) => {
    const headers = req.headers as Record<string, unknown>;
    delete headers["x-tenant-id"];
    delete headers["x-tenant"];
    delete headers["x-roles"];
    delete headers["x-user-id"];
    next();
};

export const ensureBearer: RequestHandler = (req, res, next) => {
    const authorization = req.headers.authorization ?? "";
    if (!/^Bearer\s+\S+/.test(authorization)) {
        return res.status(401).json({ error: "Missing Bearer token" });
    }
    return next();
};

export const ensureApiKey: RequestHandler = (req, res, next) => {
    if (!req.headers["x-api-key"]) {
        return res.status(401).json({ error: "Missing x-api-key" });
    }
    return next();
};

type RewritePath =
    | string
    | ((origPath: string, req: Request) => string);

export const mkProxy = (authUrl: string, rewritePathFn?: RewritePath): RequestHandler =>
    createProxyMiddleware<Request, Response>({
        target: authUrl,
        changeOrigin: true,
        proxyTimeout: 60_000,
        timeout: 61_000,
        pathRewrite: (origPath, req) => {
            const upstreamPath =
                typeof rewritePathFn === "function"
                    ? rewritePathFn(origPath, req)
                    : rewritePathFn ?? origPath;

            const originalUrl = req.originalUrl ?? "";
            const queryIndex = originalUrl.indexOf("?");
            const search = queryIndex >= 0 ? originalUrl.slice(queryIndex) : "";

            return `${upstreamPath}${search}`;
        },
        on: {
            proxyReq: (proxyReq, req) => {
                proxyReq.setHeader("x-request-id", req.id ?? "");
                proxyReq.setHeader("accept", "application/json");

                const hasBodyObject =
                    req.body &&
                    typeof req.body === "object" &&
                    Object.keys(req.body as Record<string, unknown>).length > 0;

                if (req.method !== "GET" && req.method !== "HEAD" && hasBodyObject) {
                    const body = JSON.stringify(req.body);
                    proxyReq.setHeader("content-type", "application/json");
                    proxyReq.setHeader("content-length", Buffer.byteLength(body));
                    proxyReq.write(body);
                    // When upstream middleware has already consumed the request body,
                    // explicitly end the proxied request after re-sending the payload.
                    proxyReq.end();
                }

                if (process.env.GW_DEBUG === "true") {
                    try {
                        // eslint-disable-next-line no-console
                        console.info("[gw] →", proxyReq.method, proxyReq.path);
                    } catch {
                        // ignore logging errors
                    }
                }
            },
            error: (_err, _req, res) => {
                const serverRes = res as ServerResponse;
                serverRes.writeHead(502, { "content-type": "application/json" });
                serverRes.end(JSON.stringify({ error: "Upstream auth service unavailable" }));
            },
        },
    });
