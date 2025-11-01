import { Router, type Request, type Response } from "express";
import type { ServerResponse } from "http";
import { createProxyMiddleware } from "http-proxy-middleware";

interface RouterOptions {
    CONTROLLER_URL: string;
}

export default ({ CONTROLLER_URL }: RouterOptions) => {
    const router = Router();

    const proxy = createProxyMiddleware<Request, Response>({
        target: CONTROLLER_URL,
        changeOrigin: true,
        proxyTimeout: 20_000,
        pathRewrite: (path) => `/api/v1${path}`,
        on: {
            proxyReq: (proxyReq, req: Request) => {
                proxyReq.setHeader("x-request-id", req.id ?? "");
                proxyReq.setHeader("accept", "application/json");
            },
            error: (_err, _req, res) => {
                const serverRes = res as ServerResponse;
                serverRes.writeHead(502, { "content-type": "application/json" });
                serverRes.end(JSON.stringify({ error: "Upstream controller unavailable" }));
            },
        },
    });

    router.get("/healthz", proxy);

    return router;
};
