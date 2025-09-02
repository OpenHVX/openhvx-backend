
// api-gateway/src/routes/tenant.routes.js
const { createProxyMiddleware } = require('http-proxy-middleware');
const antiSpoof = require('../middlewares/antiSpoof');
const resolveTenantFromToken = require('../middlewares/resolveTenantFromToken');
const applyPolicy = require('../middlewares/applyPolicy');

module.exports = ({ CONTROLLER_URL }) => {
    const router = require('express').Router();

    // --- middlewares locaux ---------------------------------------------------

    // Vérifie qu'au moins un rôle du JWT est dans la whitelist
    const ensureAnyRole = (allowed) => (req, res, next) => {
        const u = req.user || {};
        const roles = Array.isArray(u.roles) ? u.roles
            : Array.isArray(u.scope) ? u.scope
                : typeof u.role === 'string' ? [u.role]
                    : [];
        if (roles.some(r => allowed.includes(r))) return next();
        return res.status(403).json({ error: 'Forbidden: role not allowed' });
    };

    // Exige un tenantId dans le JWT (pas via header)
    const requireTenantInJWT = (req, res, next) => {
        const u = req.user || {};
        const tid = req.tenantId || u.tenantId || u.tid || null;
        if (!tid) return res.status(400).json({ error: 'Missing tenant in token' });
        req.tenantId = tid; // on le réutilise dans on.proxyReq
        next();
    };

    // --- proxy commun (vers le controller) ------------------------------------

    const baseProxy = createProxyMiddleware({
        target: CONTROLLER_URL,
        changeOrigin: true,
        proxyTimeout: 60000,
        timeout: 61000,
        // Le controller attend /api/v1/tenant/*
        pathRewrite: (path /*, req*/) => `/api/v1/tenant${path}`,
        on: {
            proxyReq: (proxyReq, req) => {
                const u = req.user || {};
                const tid = req.tenantId || u.tenantId || '';

                proxyReq.setHeader('x-request-id', req.id || '');
                proxyReq.setHeader('x-user-id', u.sub || '');
                proxyReq.setHeader('x-roles', (u.roles || []).join(','));
                proxyReq.setHeader('x-tenant-id', tid);
                proxyReq.setHeader('accept', 'application/json');

                // Re-stream du body si déjà parsé côté gateway
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
                res.end(JSON.stringify({ error: 'Upstream controller unavailable' }));
            },
        },
    });

    // --- routes explicites (pas de catch-all) ---------------------------------
    router.use(antiSpoof());
    router.use(resolveTenantFromToken({ required: true }));

    router.post('/tasks', requireTenantInJWT, applyPolicy("TenantPolicy.json"), ensureAnyRole(['tenant-user-rw', 'tenant-admin']), baseProxy);
    router.get('/tasks/:taskId', requireTenantInJWT, ensureAnyRole(['tenant-user-r', 'tenant-user-rw', 'tenant-admin']), baseProxy);
    router.get('/resources', requireTenantInJWT, ensureAnyRole(['tenant-user-r', 'tenant-user-rw', 'tenant-admin']), baseProxy);
    router.get('/images', requireTenantInJWT, ensureAnyRole(['tenant-user-r', 'tenant-user-rw', 'tenant-admin']), baseProxy);

    router.get('/metrics/overview', requireTenantInJWT, ensureAnyRole(['tenant-user-r', 'tenant-user-rw', 'tenant-admin']), baseProxy);


    router.get("/images", requireTenantInJWT, ensureAnyRole(['tenant-user-r', 'tenant-user-rw', 'tenant-admin']), baseProxy);
    router.get("/images/:imageId", requireTenantInJWT, ensureAnyRole(['tenant-user-r', 'tenant-user-rw', 'tenant-admin']), baseProxy);
    router.get("/images/:imageId/resolve", requireTenantInJWT, ensureAnyRole(['tenant-user-r', 'tenant-user-rw', 'tenant-admin']), baseProxy);


    // → ajoute ici d’autres endpoints tenant si besoin :
    // router.get('/something', requireTenantInJWT, allowTenantRoles, baseProxy);

    return router;
};


