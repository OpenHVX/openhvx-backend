// middlewares/resolveTenantFromToken.js
// usage: resolveTenantFromToken({ required: true }) pour les routes tenant
module.exports = ({ required = true } = {}) => (req, res, next) => {
    const u = req.user || {};
    // priorité: claim dédié, sinon default/array
    const tid =
        req.tenantId ||
        u.tenantId ||
        u.tid ||
        u.defaultTenant ||
        (Array.isArray(u.tenants) && u.tenants[0]) ||
        null;

    if (required && !tid) {
        return res.status(400).json({ error: 'Missing tenant in token' });
    }

    if (tid) req.tenantId = String(tid);
    next();
};
