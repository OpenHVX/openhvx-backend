// src/api-gateway/routes/auth.routes.js
const { createProxyMiddleware } = require('http-proxy-middleware');

module.exports = ({ AUTH_URL }) => {
    const router = require('express').Router();

    // --- middlewares locaux ---------------------------------------------------
    const stripSpoofableHeaders = (_req, _res, next) => {
        delete _req.headers['x-tenant-id'];
        delete _req.headers['x-tenant'];
        delete _req.headers['x-roles'];
        delete _req.headers['x-user-id'];
        next();
    };

    const ensureBearer = (req, res, next) => {
        const auth = req.headers.authorization || '';
        if (!/^Bearer\s+\S+/.test(auth)) {
            return res.status(401).json({ error: 'Missing Bearer token' });
        }
        next();
    };

    const ensureApiKey = (req, res, next) => {
        if (!req.headers['x-api-key']) {
            return res.status(401).json({ error: 'Missing x-api-key' });
        }
        next();
    };

    // Proxy factory pour avoir un rewrite spécifique par endpoint
    const mkProxy = (rewritePathFn) =>
        createProxyMiddleware({
            target: AUTH_URL,
            changeOrigin: true,
            proxyTimeout: 60000,
            timeout: 61000,
            pathRewrite: (_path, _req) => rewritePathFn(_path, _req),

            on: {
                proxyReq: (proxyReq, req) => {
                    // headers de base
                    proxyReq.setHeader('x-request-id', req.id || '');
                    proxyReq.setHeader('accept', 'application/json');

                    // Re-stream body si déjà parsé côté gateway
                    if (
                        req.method !== 'GET' &&
                        req.method !== 'HEAD' &&
                        req.body &&
                        Object.keys(req.body).length
                    ) {
                        const bodyData = JSON.stringify(req.body);
                        proxyReq.setHeader('content-type', 'application/json');
                        proxyReq.setHeader('content-length', Buffer.byteLength(bodyData));
                        proxyReq.write(bodyData);
                    }
                },
                error: (_err, _req, res) => {
                    res.writeHead(502, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Upstream auth service unavailable' }));
                },
            },
        });

    // --- routes explicites (pas de catch-all) ---------------------------------

    // POST /auth/login  -> auth-service /auth/login
    // (pas d’Authorization nécessaire ici ; on nettoie juste les headers spoofables)
    router.post(
        '/login',
        stripSpoofableHeaders,
        // si tu veux, supprime un éventuel Authorization entrant:
        (req, _res, next) => { delete req.headers.authorization; next(); },
        mkProxy(() => '/auth/login')
    );

    // POST /auth/register -> auth-service /auth/register (protégé par x-api-key)
    router.post(
        '/register',
        stripSpoofableHeaders,
        ensureApiKey,
        mkProxy(() => '/auth/register')
    );

    // GET /auth/me -> auth-service /users/me (pass-through Bearer)
    router.get(
        '/me',
        stripSpoofableHeaders,
        ensureBearer,
        mkProxy(() => '/users/me')
    );

    // GET /auth/userinfo -> auth-service /auth/userinfo (pass-through Bearer)
    router.get(
        '/userinfo',
        stripSpoofableHeaders,
        ensureBearer,
        mkProxy(() => '/auth/userinfo')
    );

    // POST /auth/introspect -> auth-service /auth/introspect
    // (utile en debug; garde seulement si tu veux l’exposer)
    router.post(
        '/introspect',
        stripSpoofableHeaders,
        mkProxy(() => '/auth/introspect')
    );

    return router;
};
