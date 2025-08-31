const { createProxyMiddleware } = require("http-proxy-middleware");

module.exports = ({ CONTROLLER_URL }) => {
    const router = require("express").Router();

    // Toutes les routes de ce router sont montées sous /api/v1 côté Gateway.
    // Ici, req.url vaut "/agents" → on doit préfixer "/api/v1" pour le controller.
    const proxy = createProxyMiddleware({
        target: CONTROLLER_URL,
        changeOrigin: true,
        proxyTimeout: 20000,
        pathRewrite: (path /* '/agents' */, req) => `/api/v1${path}`, // ⬅️ clé du fix
        onProxyReq: (proxyReq, req) => {
            proxyReq.setHeader("x-request-id", req.id || "");
            proxyReq.setHeader("accept", "application/json");
        },
        onError: (_err, _req, res) => {
            res.writeHead(502, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "Upstream controller unavailable" }));
        },
    });

    // publics / sans tenant
    router.get("/healthz", proxy);

    return router;
};
