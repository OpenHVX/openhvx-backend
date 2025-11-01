import type { Application } from "express";
import type { Server } from "http";
import type { Socket } from "net";
import { createProxyMiddleware } from "http-proxy-middleware";

export const mountWsProxy = (app: Application, server: Server, brokerUrl?: string): void => {
    const target = brokerUrl ?? process.env.BROKER_URL;
    if (!target) {
        throw new Error("[ws-proxy] Missing controller target");
    }

    // eslint-disable-next-line no-console
    console.log("[ws-proxy] proxy target =", target);

    const serialProxy = createProxyMiddleware({
        target,
        changeOrigin: true,
        ws: true,
        pathRewrite: { "^/api": "" },
    });

    const netProxy = createProxyMiddleware({
        target,
        changeOrigin: true,
        ws: true,
        pathRewrite: { "^/api": "" },
    });

    app.use("/api/v1/console/serial/ws", serialProxy);
    app.use("/api/v1/console/net/ws", netProxy);

    server.on("upgrade", (req, socket, head) => {
        const url = req.url ?? "";
        const netSocket = socket as Socket;
        if (url.startsWith("/api/v1/console/serial/ws")) {
            serialProxy.upgrade(req, netSocket, head);
            return;
        }
        if (url.startsWith("/api/v1/console/net/ws")) {
            netProxy.upgrade(req, netSocket, head);
            return;
        }
        netSocket.destroy();
    });
};
