// @ts-nocheck
// middlewares/requireTenant.js
module.exports = function requireTenant() {
    return (req, res, next) => {
        // Trust the gateway for the authoritative tenant ID
        const tenantId =
            req.tenantId ||
            req.headers['x-tenant-id'] ||        // header injected by the gateway
            req.user?.tenantId || req.auth?.tenantId || // fallback when decoding locally
            req.tenant?.tenantId || null;

        if (!tenantId) {
            return res.status(400).json({ error: 'Missing tenant context' });
        }
        req.tenantId = String(tenantId);
        next();
    };
};
