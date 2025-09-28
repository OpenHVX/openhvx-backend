// src/service-api-gateway/lib/_utils.js
const { createProxyMiddleware } = require('http-proxy-middleware');

function hostKind(req) {
    const host = (req.headers.host || '').toLowerCase();
    if (host.startsWith('admin-api.')) return 'admin';
    if (host.startsWith('api.')) return 'tenant';
    return 'unknown';
}

const ensureHost = (expected) => (req, res, next) => {
    const kind = hostKind(req);
    if (kind !== expected) return res.status(404).json({ error: 'not found' });
    next();
};

const stripSpoofable = (req, _res, next) => {
    delete req.headers['x-tenant-id'];
    delete req.headers['x-tenant'];
    delete req.headers['x-roles'];
    delete req.headers['x-user-id'];
    next();
};

const ensureBearer = (req, res, next) => {
    const a = req.headers.authorization || '';
    if (!/^Bearer\s+\S+/.test(a)) return res.status(401).json({ error: 'Missing Bearer token' });
    next();
};

const ensureApiKey = (req, res, next) => {
    if (!req.headers['x-api-key']) return res.status(401).json({ error: 'Missing x-api-key' });
    next();
};

const mkProxy = (AUTH_URL, rewritePathFn) =>
    createProxyMiddleware({
        target: AUTH_URL,
        changeOrigin: true,
        proxyTimeout: 60_000,
        timeout: 61_000,

        // ⚠️ Par défaut, http-proxy-middleware n'attache pas la query.
        // On recompose le path cible ET on y rattache la query originale.
        pathRewrite: (origPath, req) => {
            const upstreamPath = typeof rewritePathFn === 'function'
                ? rewritePathFn(origPath, req)
                : (rewritePathFn || origPath);

            // Récupère la query EXACTE telle qu'elle est arrivée (sans la re-sérialiser)
            const orig = req.originalUrl || ''; // ex: "/api/v1/admin/auth/register?mode=reset"
            const qIdx = orig.indexOf('?');
            const search = qIdx >= 0 ? orig.slice(qIdx) : ''; // ex: "?mode=reset"

            return upstreamPath + search; // ex: "/auth/admin/register?mode=reset"
        },

        on: {
            proxyReq: (proxyReq, req) => {
                proxyReq.setHeader('x-request-id', req.id || '');
                proxyReq.setHeader('accept', 'application/json');

                // Re-stream du JSON si body déjà parsé par express.json()
                if (req.method !== 'GET' && req.method !== 'HEAD' && req.body && Object.keys(req.body).length) {
                    const body = JSON.stringify(req.body);
                    proxyReq.setHeader('content-type', 'application/json');
                    proxyReq.setHeader('content-length', Buffer.byteLength(body));
                    proxyReq.write(body);
                }

                // (Optionnel) petit log de debug pour voir la cible finale
                if (process.env.GW_DEBUG === 'true') {
                    try { console.info('[gw] →', proxyReq.method, proxyReq.path); } catch { }
                }
            },

            error: (_err, _req, res) => {
                res.writeHead(502, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: 'Upstream auth service unavailable' }));
            },
        },
    });

module.exports = {
    hostKind,
    ensureHost,
    stripSpoofable,
    ensureBearer,
    ensureApiKey,
    mkProxy,
};
