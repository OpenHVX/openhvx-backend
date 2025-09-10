// ws/ws-proxy.js
const { createProxyMiddleware } = require('http-proxy-middleware');

function mountWsProxy(app, server, brokerUrl) {
    const target = brokerUrl || process.env.BROKER_URL;
    if (!target) throw new Error('[ws-proxy] Missing controller target');

    console.log('[ws-proxy] proxy target =', target);

    // Browser -> Console Série
    const serialProxy = createProxyMiddleware({
        target,
        changeOrigin: true,
        ws: true,
        logLevel: 'warn',
        // /api/v1/... (Gateway) -> /v1/... (Controller)
        pathRewrite: { '^/api': '' },
    });
    app.use('/api/v1/console/serial/ws', serialProxy);

    // Browser -> Console "net"
    const netProxy = createProxyMiddleware({
        target,
        changeOrigin: true,
        ws: true,
        logLevel: 'warn',
        pathRewrite: { '^/api': '' },
    });
    app.use('/api/v1/console/net/ws', netProxy);

    // Ensure WS upgrades are routed to the right proxy
    server.on('upgrade', (req, socket, head) => {
        const u = req.url || '';
        if (u.startsWith('/api/v1/console/serial/ws')) return serialProxy.upgrade(req, socket, head);
        if (u.startsWith('/api/v1/console/net/ws')) return netProxy.upgrade(req, socket, head);
        socket.destroy();
    });

    [serialProxy, netProxy].forEach(p => p.on?.('error', err =>
        console.error('[ws-proxy]', err?.message || err)
    ));
}

module.exports = { mountWsProxy };
