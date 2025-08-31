// middlewares/requireTenant.js
module.exports = function requireTenant() {
    return (req, res, next) => {
        // La gateway est la source de vérité → accepte x-tenant-id
        const tenantId =
            req.tenantId ||
            req.headers['x-tenant-id'] ||        // <— header injecté par la gateway
            req.user?.tenantId || req.auth?.tenantId || // (au cas où tu décodes un token en local)
            req.tenant?.tenantId || null;

        if (!tenantId) {
            return res.status(400).json({ error: 'Missing tenant context' });
        }
        req.tenantId = String(tenantId);
        next();
    };
};
